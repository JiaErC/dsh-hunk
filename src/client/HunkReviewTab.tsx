/**
 * The「Hunk 评审」tab body.
 *
 * Read-only view over one live Hunk session: the session strip (which carries
 * the totals), then every reviewed file with its hunks and the notes anchored
 * to them. A hunk unfolds into its diff lines — the patch text is read on
 * demand, the first time a hunk is expanded or copied.
 *
 * The refresh button re-runs the host route (which re-runs the Hunk CLI);
 * nothing here writes to the review.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  HunkReloadTarget,
  HunkReviewFile,
  HunkReviewHunk,
  HunkReviewNote,
  HunkReviewPayload,
  HunkSessionSummary,
  HunkStatePayload,
  HunkWatchAction,
} from '../shared/wire'
import { fileNotes, groupNotes, pathKey } from '../shared/notes'
import { languageForPath, type HighlightToken, type HighlightedLine } from '../shared/languages'
import { tokenizeSides, type SideTokens } from './highlight'
import {
  notesForDisplay,
  pickPatchHunk,
  placeNotes,
  toSplitRows,
  type PatchHunk,
  type SplitCell,
  type SplitRow,
} from '../shared/patch'
import { HunkClientError, fetchHunkPatches, fetchHunkState, isAbort, messageOf, requestHunkReload, requestHunkWatch } from './api'
import { askAgentToInstall, installRoutes, platformHint } from './install'
import { useSessionCwd } from './session-cwd'
import { useTranslate, type Translate } from './i18n'
import { styles, token } from './styles'

/** The diff-text read: idle until the first hunk is expanded or copied. */
interface PatchState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** File path → raw unified diff text. */
  map: Record<string, string>
  /** Files the review listed without patch text. */
  missing: readonly string[]
  /** Wire code of the failure, when the status is `error`. */
  code?: string
  /** Why the read failed, when it did. */
  message?: string
}

const IDLE_PATCHES: PatchState = { status: 'idle', map: {}, missing: [] }

/** The code that means "this host build has no patch read", not "the read failed". */
const UNSUPPORTED = 'patch-read-unsupported'

/** Render one inclusive line range. */
function rangeLabel(range: [number, number] | undefined, t: Translate, side: 'old' | 'new'): string | undefined {
  if (range === undefined) return undefined
  const label = range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`
  return t(side === 'old' ? 'lines.old' : 'lines.new', { n: label })
}

/** Both ranges of one hunk, joined for display. */
function hunkRanges(hunk: HunkReviewHunk, t: Translate): string {
  return [rangeLabel(hunk.oldRange, t, 'old'), rangeLabel(hunk.newRange, t, 'new')]
    .filter((part): part is string => part !== undefined)
    .join(' · ')
}

/** Local wall-clock time for one ISO stamp, or the raw text when unparsable. */
function formatTime(stamp: string | undefined): string | undefined {
  if (stamp === undefined) return undefined
  const parsed = new Date(stamp)
  if (Number.isNaN(parsed.getTime())) return stamp
  return parsed.toLocaleTimeString()
}

/** A button that keeps its own hover state (the tab body stays untouched). */
function Button(props: {
  label: string
  title?: string
  disabled?: boolean
  onClick: () => void
}): ReactNode {
  const [hover, setHover] = useState(false)
  const style: CSSProperties = {
    ...styles.button,
    ...(hover && props.disabled !== true ? { background: token.hover } : {}),
    ...(props.disabled === true ? styles.buttonBusy : {}),
  }
  return (
    <button
      type="button"
      style={style}
      title={props.title ?? props.label}
      disabled={props.disabled === true}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

/** A square icon button (hover tint, optional done tint). */
function IconButton(props: {
  label: string
  done?: boolean
  onClick: () => void
  children: ReactNode
}): ReactNode {
  const [hover, setHover] = useState(false)
  const style: CSSProperties = {
    ...styles.iconButton,
    ...(hover ? styles.iconButtonHover : {}),
    ...(props.done === true ? styles.iconButtonDone : {}),
  }
  return (
    <button
      type="button"
      style={style}
      title={props.label}
      aria-label={props.label}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/** Two stacked sheets, in `currentColor`. */
function CopyIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
  )
}

/** The confirmation glyph the copy button flips to. */
function CheckIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  )
}

/** A command line with a copy affordance. */
function CommandLine({ t, text }: { t: Translate; text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      } catch (error) {
        console.error('[dsh-hunk] clipboard write failed:', error)
      }
    })()
  }, [text])
  return (
    <div style={styles.codeRow as CSSProperties}>
      <code style={styles.codeRowCode as CSSProperties}>{text}</code>
      <Button label={copied ? t('action.copied') : t('action.copy')} onClick={copy} />
    </div>
  )
}

/** One note: source badge, anchor, and body. */
function NoteView({ t, note }: { t: Translate; note: HunkReviewNote }): ReactNode {
  const source = note.source === 'user'
    ? t('note.user')
    : note.source === 'agent'
      ? t('note.agent')
      : t('note.ai')
  const anchor = [
    rangeLabel(note.oldRange, t, 'old'),
    rangeLabel(note.newRange, t, 'new'),
  ].filter((part): part is string => part !== undefined).join(' · ')
  const created = formatTime(note.createdAt)
  return (
    <article style={styles.note as CSSProperties}>
      <div style={styles.noteMeta as CSSProperties}>
        <span style={styles.badge as CSSProperties}>{source}</span>
        {note.author !== undefined && <span>{note.author}</span>}
        {note.title !== undefined && <span style={styles.noteTitle as CSSProperties}>{note.title}</span>}
        {anchor !== '' && <span>{anchor}</span>}
        {created !== undefined && <span>{created}</span>}
      </div>
      {note.body !== '' && <div style={styles.noteBody as CSSProperties}>{note.body}</div>}
    </article>
  )
}

/** One side of a split row: line number, `-`/`+` sign, and the line itself. */
function SplitSide(props: {
  cell: SplitCell | undefined
  sign: string
  hue?: CSSProperties
  /** Syntax tokens for this line, when a grammar claimed the file. */
  tokens?: HighlightedLine
}): ReactNode {
  const { cell, sign, hue, tokens } = props
  return (
    <span style={{ ...styles.splitSide, ...(hue ?? {}) } as CSSProperties}>
      <span style={styles.splitNo as CSSProperties}>{cell === undefined ? '' : cell.no}</span>
      <span style={styles.splitSign as CSSProperties}>{cell === undefined ? '' : sign}</span>
      <span style={styles.splitText as CSSProperties}>
        {tokens === undefined || tokens.length === 0
          ? cell?.text ?? ''
          : tokens.map((token, index) => (
              <span key={index} style={tokenStyle(token)}>{token.text}</span>
            ))}
      </span>
    </span>
  )
}

/** The inline style for one syntax token (colour, plus italics/bold/underline). */
function tokenStyle(token: HighlightToken): CSSProperties | undefined {
  const style: CSSProperties = {}
  if (token.color !== undefined) style.color = token.color
  if (token.fontStyle !== undefined) {
    if ((token.fontStyle & 1) !== 0) style.fontStyle = 'italic'
    if ((token.fontStyle & 2) !== 0) style.fontWeight = 600
    if ((token.fontStyle & 4) !== 0) style.textDecoration = 'underline'
  }
  return Object.keys(style).length === 0 ? undefined : style
}

/**
 * The side-by-side body of one hunk: deletions on the left, additions on the
 * right, context on both — with the hunk's notes drawn directly under the rows
 * they review. Each side's text is syntax-highlighted when a grammar claimed
 * the file; the sign keeps the add/remove hue either way.
 */
function HunkDiff(props: {
  rows: readonly SplitRow[]
  /** Absent when no grammar claimed the file: the rows render as plain text. */
  tokens?: SideTokens
  notesByRow: Map<number, HunkReviewNote[]>
  t: Translate
}): ReactNode {
  const { rows, tokens, notesByRow, t } = props
  return (
    <div style={styles.diffBody as CSSProperties}>
      {rows.map((row, index) => (
        <Fragment key={index}>
          {row.kind === 'meta'
            ? <div style={styles.splitMeta as CSSProperties}>{row.text ?? ''}</div>
            : (
                <div style={styles.splitRow as CSSProperties}>
                  <SplitSide
                    cell={row.left}
                    sign={row.kind === 'change' ? '-' : ' '}
                    tokens={tokens?.left[index]}
                    hue={row.kind === 'change' && row.left !== undefined ? { ...styles.diffDel, ...styles.diffDelText } as CSSProperties : undefined}
                  />
                  <span style={styles.splitDivider as CSSProperties} />
                  <SplitSide
                    cell={row.right}
                    sign={row.kind === 'change' ? '+' : ' '}
                    tokens={tokens?.right[index]}
                    hue={row.kind === 'change' && row.right !== undefined ? { ...styles.diffAdd, ...styles.diffAddText } as CSSProperties : undefined}
                  />
                </div>
              )}
          {(notesByRow.get(index) ?? []).map(note => (
            <div key={note.noteId} style={styles.noteInline as CSSProperties}>
              <NoteView t={t} note={note} />
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * One hunk: a collapsible row (index, section header, ranges, copy) over its
 * code. The row and its notes are always on screen — only the code follows the
 * disclosure, so collapsing a hunk never takes a note away.
 */
function HunkView(props: {
  t: Translate
  filePath: string
  hunk: HunkReviewHunk
  notes: readonly HunkReviewNote[]
  focused: boolean
  patchState: PatchState
  patchCapable: boolean
  ensurePatch: () => Promise<Record<string, string>>
}): ReactNode {
  const { t, filePath, hunk, notes, focused, patchState, patchCapable, ensurePatch } = props
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  /** Hover state for the change row (its own, so the tab body does not re-render). */
  const [rowHover, setRowHover] = useState(false)
  const ranges = hunkRanges(hunk, t)
  const patch = useMemo(
    () => pickPatchHunk(patchState.map[filePath], hunk),
    [patchState.map, filePath, hunk],
  )
  const rows = useMemo(() => (patch === undefined ? undefined : toSplitRows(patch)), [patch])
  const placed = useMemo(
    () => (rows === undefined ? undefined : placeNotes(rows, notes)),
    [rows, notes],
  )
  // Highlighting is per file (grammar from the extension) and per block, so a
  // hunk that is shown again — or a second hunk of the same file — reuses the
  // tokenizer's cache instead of re-tokenizing.
  const language = useMemo(() => languageForPath(filePath), [filePath])
  const tokens = useMemo(
    () => (rows === undefined || language === undefined ? undefined : tokenizeSides(rows, language)),
    [rows, language],
  )
  // The hunk's disclosure owns its code, and nothing else: while the code is
  // hidden every note drops below the hunk row, so collapsing never costs a
  // reader their comments.
  const codeShown = open
  const { inline, below } = notesForDisplay({ codeShown, placed, notes })
  const notice = !patchCapable || patchState.code === UNSUPPORTED
    // "This build cannot" is a different fact from "that read failed", and only
    // the first one tells the user to restart the host.
    ? t('hunk.patchUnsupported')
    : patchState.status === 'error'
      ? t('hunk.patchFailed', { message: patchState.message ?? patchState.code ?? '' })
      : patchState.status === 'ready' && patchState.missing.includes(filePath)
        ? t('hunk.patchMissing')
        : t('hunk.patchLoading')

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && patchCapable) void ensurePatch()
  }
  const copy = (): void => {
    if (!patchCapable) return
    void (async () => {
      const map = await ensurePatch()
      const text = pickPatchHunk(map[filePath], hunk)?.text
      if (text === undefined) return
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      } catch (error) {
        console.error('[dsh-hunk] clipboard write failed:', error)
      }
    })()
  }

  return (
    <div style={styles.hunk as CSSProperties}>
      <div style={styles.hunkHead as CSSProperties}>
        <button
          type="button"
          style={{
            ...styles.hunkRow,
            ...(codeShown || rowHover ? styles.hunkRowActive : {}),
          } as CSSProperties}
          title={codeShown ? t('hunk.collapse') : t('hunk.expand')}
          aria-expanded={codeShown}
          onMouseEnter={() => { setRowHover(true) }}
          onMouseLeave={() => { setRowHover(false) }}
          onClick={toggle}
        >
          <span style={styles.caret as CSSProperties}>{codeShown ? '▼' : '▶'}</span>
          <span style={styles.hunkIndex as CSSProperties}>#{hunk.index + 1}</span>
          <code style={styles.hunkHeader as CSSProperties}>{hunk.header}</code>
          {ranges !== '' && <span style={styles.muted as CSSProperties}>{ranges}</span>}
          {focused && <span style={styles.badgeFocus as CSSProperties}>{t('summary.focus')}</span>}
        </button>
        <IconButton
          label={!patchCapable ? t('hunk.copyUnsupported') : copied ? t('hunk.copied') : t('hunk.copy')}
          done={copied}
          onClick={copy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </div>
      {codeShown && (
        <div style={styles.hunkBody as CSSProperties}>
          <div style={styles.locationRow as CSSProperties}>
            <span>{t('hunk.location')}</span>
            <span style={styles.locationPath as CSSProperties}>{`${filePath}${ranges === '' ? '' : ` · ${ranges}`}`}</span>
            <span>{t('hunk.changes')}</span>
          </div>
          {rows === undefined
            ? <div style={styles.diffNotice as CSSProperties}>{notice}</div>
            : <HunkDiff rows={rows} tokens={tokens} notesByRow={inline} t={t} />}
        </div>
      )}
      {below.map(note => <NoteView key={note.noteId} t={t} note={note} />)}
    </div>
  )
}

/**
 * What the live window is reading, and the two ways to change it.
 *
 * The tab mirrors whatever input the window holds, so "0 files" can mean "the
 * tree is clean" or "the window is reading an older thing" — and an agent that
 * commits its work leaves the first case behind every round. `hunk session
 * reload` is the command that switches inputs; it replaces what the reader is
 * looking at, so it runs only from these clicks.
 */
function ReviewTargetBar(props: {
  t: Translate
  /** The window's own title, when it reported one. */
  title: string | undefined
  target: HunkReloadTarget | null
  busy: boolean
  onPick: (target: HunkReloadTarget) => void
}): ReactNode {
  const { t, title, target, busy, onPick } = props
  return (
    <div style={styles.targetBar as CSSProperties}>
      <span style={styles.muted as CSSProperties}>{t('target.lead')}</span>
      <span style={styles.targetTitle as CSSProperties}>{title ?? t('target.unknown')}</span>
      <span style={styles.spacer as CSSProperties} />
      <Button
        label={busy && target === 'working-tree' ? t('target.switching') : t('target.workingTree')}
        disabled={busy}
        onClick={() => { onPick('working-tree') }}
      />
      <Button
        label={busy && target === 'last-commit' ? t('target.switching') : t('target.lastCommit')}
        disabled={busy}
        onClick={() => { onPick('last-commit') }}
      />
    </div>
  )
}

/** One reviewed file: collapsible header plus its hunks and notes. */
function FileCard(props: {
  t: Translate
  file: HunkReviewFile
  notes: readonly HunkReviewNote[]
  focusedPath: string | undefined
  focusedHunk: number | undefined
  patchState: PatchState
  patchCapable: boolean
  ensurePatch: () => Promise<Record<string, string>>
}): ReactNode {
  const { t, file, notes, focusedPath, focusedHunk, patchState, patchCapable, ensurePatch } = props
  const [open, setOpen] = useState(true)
  const grouped = useMemo(() => groupNotes(file, notes), [file, notes])
  // Collapsed, this file's review is what stays: the code goes away, the notes
  // do not. `fileNotes` is the reading order for that list.
  const review = useMemo(() => fileNotes(file, grouped), [file, grouped])
  const isFocused = focusedPath !== undefined && pathKey(focusedPath) === pathKey(file.path)
  return (
    <section style={styles.card as CSSProperties}>
      <button
        type="button"
        style={styles.cardHeader as CSSProperties}
        onClick={() => { setOpen(value => !value) }}
        title={file.path}
      >
        <span style={styles.caret as CSSProperties}>{open ? '▼' : '▶'}</span>
        <span style={styles.filePath as CSSProperties}>{file.path}</span>
        {file.previousPath !== undefined && (
          <span style={styles.previousPath as CSSProperties}>{`← ${file.previousPath}`}</span>
        )}
        <span style={styles.counts as CSSProperties}>
          <span style={styles.additions as CSSProperties}>{`+${file.additions}`}</span>
          <span style={styles.deletions as CSSProperties}>{`−${file.deletions}`}</span>
        </span>
        <span style={styles.badge as CSSProperties}>{t('summary.hunks', { n: file.hunks.length })}</span>
        {isFocused && <span style={styles.badgeFocus as CSSProperties}>{t('summary.focus')}</span>}
      </button>
      {/*
        Expanded: the hunks, their rows and their code (each hunk's own
        disclosure controls the code alone).

        Collapsed: the code goes away — that is what collapsing means — but the
        review written about this file stays, listed under its row. Losing the
        comments on collapse would be the worst outcome for a reviewer, which is
        why the collapsed branch is notes-only rather than nothing.
      */}
      {open
        ? (
            <div>
              {file.hunks.map((hunk) => (
                <HunkView
                  key={hunk.index}
                  t={t}
                  filePath={file.path}
                  hunk={hunk}
                  notes={grouped.byHunk.get(hunk.index) ?? []}
                  focused={isFocused && focusedHunk === hunk.index}
                  patchState={patchState}
                  patchCapable={patchCapable}
                  ensurePatch={ensurePatch}
                />
              ))}
              {grouped.loose.length > 0 && (
                <div style={styles.hunk as CSSProperties}>
                  <div style={styles.hunkHead as CSSProperties}>
                    <span style={styles.badge as CSSProperties}>{t('note.fileLevel')}</span>
                  </div>
                  {grouped.loose.map(note => <NoteView key={note.noteId} t={t} note={note} />)}
                </div>
              )}
            </div>
          )
        : review.length > 0 && (
            <div style={styles.collapsedReview as CSSProperties}>
              <div style={styles.collapsedReviewTitle as CSSProperties}>{t('note.fileReview')}</div>
              {review.map(note => <NoteView key={note.noteId} t={t} note={note} />)}
            </div>
          )}
    </section>
  )
}

/** The session strip above the file list — the one place totals are shown. */
function SessionStrip(props: {
  t: Translate
  data: HunkStatePayload
  review: HunkReviewPayload
  session: HunkSessionSummary | undefined
}): ReactNode {
  const { t, data, review, session } = props
  const focusPath = session?.selectedFilePath ?? review.selectedFilePath
  const focusHunk = session?.selectedHunkIndex ?? review.selectedHunkIndex
  const focus = focusPath === undefined
    ? t('summary.noFocus')
    : `${focusPath}${focusHunk === undefined ? '' : ` #${focusHunk + 1}`}`
  return (
    <div style={styles.strip as CSSProperties}>
      <div style={styles.stripTitle as CSSProperties}>{session?.title ?? review.title}</div>
      <div style={styles.stripMeta as CSSProperties}>
        <span>{session?.sourceLabel ?? review.sourceLabel}</span>
        <span>·</span>
        <span>{t('summary.files', { n: review.files.length })}</span>
        <span>·</span>
        <span>{t('summary.notes', { n: review.reviewNotes.length })}</span>
        <span>·</span>
        <span>{`${t('summary.focus')}: ${focus}`}</span>
      </div>
      <div style={styles.stripMeta as CSSProperties}>
        <span>{t('summary.commands')}</span>
        <code>{data.commands.review}</code>
      </div>
    </div>
  )
}

/** What the tab says about the window it tried to open. */
function watchCopy(t: Translate, watch: WatchNotice): string {
  switch (watch.action) {
    case 'started':
      return watch.gaveUp ? t('watch.slow') : t('watch.opening')
    case 'stale':
      // Two different situations share this action: a fresh window was opened in
      // place of one that had lost its registration, or the replacement cooldown
      // held that back — and only the second one needs the reader to act.
      if (watch.replaced !== true) return t('watch.stale')
      return watch.gaveUp ? t('watch.slow') : t('watch.replaced')
    case 'already-started':
      return watch.gaveUp ? t('watch.stale') : t('watch.registering')
    case 'already-live':
      return t('watch.opened')
    case 'cooldown':
      return t('watch.cooldown')
    case 'disabled':
      return t('watch.disabled')
    case 'not-a-repo':
      return t('watch.notRepo')
    case 'unsupported':
      return t('watch.unsupported')
    case 'failed':
      return t('watch.failed')
    default:
      return t('watch.opening')
  }
}

/** Whether the notice is waiting for a window that is still on its way up. */
function watchWaiting(watch: WatchNotice): boolean {
  if (watch.gaveUp === true) return false
  if (watch.action === 'started' || watch.action === 'already-started') return true
  return watch.action === 'stale' && watch.replaced === true
}

/** Whether the reader has something to do about it. */
function watchActionable(watch: WatchNotice): boolean {
  if (watch.gaveUp === true) return true
  if (watch.action === 'failed' || watch.action === 'unsupported' || watch.action === 'cooldown') return true
  return watch.action === 'stale' && watch.replaced !== true
}

/**
 * The window-opening notice.
 *
 * Only shown while it has something to say: a window is being opened, or the
 * host declined/failed and the user can act. `already-live`/`already-started`
 * are deliberately quiet — a window that exists is not news on every refresh.
 */
function WatchNoticeView(props: {
  t: Translate
  watch: WatchNotice
  onOpen: () => void
}): ReactNode {
  const { t, watch, onOpen } = props
  if (watch.status === 'idle') return null
  const actionable = watchActionable(watch)
  const waiting = watchWaiting(watch)
  return (
    <div style={(actionable ? styles.watchLoud : styles.watch) as CSSProperties}>
      <div>{watchCopy(t, watch)}</div>
      {watch.pid !== undefined && waiting && (
        <div style={styles.muted as CSSProperties}>{t('watch.pid', { pid: watch.pid })}</div>
      )}
      {watch.detail !== undefined && <div style={styles.muted as CSSProperties}>{watch.detail}</div>}
      {watch.command !== undefined && !waiting && (
        <CommandLine t={t} text={watch.command} />
      )}
      {actionable && (
        <div style={{ marginTop: 8 }}>
          <Button label={t('watch.open')} onClick={onOpen} />
        </div>
      )}
    </div>
  )
}

/** The "no live session" state: exactly what to run, in which directory. */
function EmptyState({ t, data }: { t: Translate; data: HunkStatePayload }): ReactNode {
  return (
    <div style={styles.empty as CSSProperties}>
      <div style={styles.emptyTitle as CSSProperties}>{t('empty.title')}</div>
      <div>{t('empty.lead')}</div>
      <CommandLine t={t} text={`cd ${data.cwd} && hunk diff --watch`} />
      <div style={{ ...styles.muted, marginTop: 6 } as CSSProperties}>{t('empty.tip')}</div>
      {data.sessions.length === 0 && (
        // The common false alarm: a window is open but never registered with the
        // daemon, so "no live session" here does not mean "nothing is running".
        <div style={{ ...styles.muted, marginTop: 6 } as CSSProperties}>{t('empty.unregistered')}</div>
      )}
      {data.otherRepos.length > 0 && (
        <>
          <div style={{ ...styles.secondary, marginTop: 8 } as CSSProperties}>{t('empty.others')}</div>
          <ul style={styles.list as CSSProperties}>
            {data.otherRepos.map(repo => <li key={repo}>{repo}</li>)}
          </ul>
        </>
      )}
      {data.reviewError !== null && (
        <div style={{ ...styles.muted, marginTop: 8 } as CSSProperties}>
          {`${data.reviewError.code}: ${data.reviewError.message}`}
        </div>
      )}
    </div>
  )
}

/** A route-level failure. */
function FailureBlock(props: {
  t: Translate
  failure: { code: string; message: string }
  onRetry: () => void
}): ReactNode {
  const { t, failure, onRetry } = props
  return (
    <div style={styles.failure as CSSProperties}>
      <div style={styles.failureTitle as CSSProperties}>{`${t('error.title')} (${failure.code})`}</div>
      <div style={styles.failureMessage as CSSProperties}>{failure.message}</div>
      <div style={{ marginTop: 8 }}>
        <Button label={t('action.retry')} onClick={onRetry} />
      </div>
    </div>
  )
}

/**
 * What to show when Hunk itself is missing.
 *
 * Not a failure block: nothing is broken, the plugin simply has no Hunk to talk
 * to. So it explains what Hunk is, lists the install routes Hunk documents, says
 * how to point the plugin at a non-PATH install, and offers the one action that
 * actually resolves it here — asking the agent in this session to install it.
 */
function InstallGuide(props: {
  t: Translate
  /** The host's own diagnostic line, so the reader sees the real complaint. */
  detail: string
  /** The canned request, so it can also be copied when the channel is closed. */
  askText: string
  /** `null` until the button has been used. */
  asked: 'sent' | 'failed' | null
  asking: boolean
  onAsk: () => void
}): ReactNode {
  const { t, detail, askText, asked, asking, onAsk } = props
  const [copied, setCopied] = useState(false)
  const routes = installRoutes(platformHint())
  const copyPrompt = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(askText)
        setCopied(true)
      } catch (error) {
        console.error('[dsh-hunk] clipboard write failed:', error)
      }
    })()
  }
  return (
    <div style={styles.install as CSSProperties}>
      <div style={styles.installTitle as CSSProperties}>{t('install.title')}</div>
      <div style={styles.installLine as CSSProperties}>{t('install.lead')}</div>
      <div style={styles.installLine as CSSProperties}>{t('install.why')}</div>
      {detail !== '' && <div style={styles.failureMessage as CSSProperties}>{detail}</div>}

      <div style={styles.installStep as CSSProperties}>{t('install.stepInstall')}</div>
      {routes.map(route => (
        <div key={route.id} style={styles.installRoute as CSSProperties}>
          <span style={styles.installRouteLabel as CSSProperties}>{route.label}</span>
          <CommandLine t={t} text={route.command} />
        </div>
      ))}

      <div style={styles.installStep as CSSProperties}>{t('install.stepPath')}</div>
      <div style={styles.installLine as CSSProperties}>{t('install.pathHint')}</div>
      <CommandLine t={t} text="DSH_HUNK_BIN=C:\\path\\to\\hunk.exe" />

      <div style={styles.installStep as CSSProperties}>{t('install.stepVerify')}</div>
      <CommandLine t={t} text="hunk --version" />
      <div style={styles.installLine as CSSProperties}>{t('install.restart')}</div>

      <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
        <Button
          label={asking ? t('install.asking') : t('install.askAction')}
          disabled={asking}
          onClick={onAsk}
        />
        <Button label={copied ? t('action.copied') : t('install.copyAction')} onClick={copyPrompt} />
      </div>
      {asked === 'sent' && <div style={styles.installLine as CSSProperties}>{t('install.sent')}</div>}
      {asked === 'failed' && <div style={styles.failureMessage as CSSProperties}>{t('install.askFailed')}</div>}
    </div>
  )
}

/** How long a missing cwd is waited on before it is reported as a failure. */
const CWD_GRACE_MS = 2000

/** How often the tab re-reads while a freshly opened window registers. */
const WATCH_POLL_MS = 3000

/**
 * How many polls a fresh window gets before the tab stops waiting.
 *
 * A cold window needed 8–9 s on the development machine (hunk starts its own
 * daemon), so ten polls is generous without leaving a timer running forever.
 */
const WATCH_POLL_TRIES = 10

/** The state of this tab's window-opening attempt. */
interface WatchNotice {
  status: 'idle' | 'waiting' | 'settled'
  /** The host's verdict; absent for a transport failure. */
  action?: HunkWatchAction
  /** The command to paste when the host could not open a window itself. */
  command?: string
  /** One line from the host (why it refused, or why it failed). */
  detail?: string
  /** The process the host started, on the way to a live session. */
  pid?: number
  /** True when the host opened a fresh window because an earlier one was stale. */
  replaced?: boolean
  /** True once the polling budget ran out with no session in sight. */
  gaveUp?: boolean
}

const IDLE_WATCH: WatchNotice = { status: 'idle' }

/**
 * The tab body's props: the framework's per-tab reader plus what this plugin
 * injects through the body registration (`ctx`, `sessionId`). Typed
 * structurally — the real types live in a Harness Client package this plugin
 * must not require.
 */
export interface HunkTabProps {
  /** Client context (locale lives here). */
  readonly ctx: Context
  /** The session this tab belongs to. */
  readonly sessionId: string
  /** Live tab record: visibility, navigation, actions. */
  readonly useTabInfo: () => { readonly tab: { readonly visible: boolean } }
}

/**
 * The tab body.
 * @param props - the native tab body props (see {@link HunkTabProps}).
 * @returns the rendered view.
 */
export function HunkReviewTab({ ctx, sessionId, useTabInfo }: HunkTabProps): ReactNode {
  const t = useTranslate(ctx)
  const visible = useTabInfo().tab.visible
  // Live from the client session list, so it needs no resolution step and no
  // HTTP fallback: the only input the host route cannot guess.
  const cwd = useSessionCwd(ctx, sessionId)
  const [data, setData] = useState<HunkStatePayload | null>(null)
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [patchState, setPatchState] = useState<PatchState>(IDLE_PATCHES)
  /** True once the session list has had its grace period and still has no cwd. */
  const [cwdTimedOut, setCwdTimedOut] = useState(false)
  /** This tab's window-opening attempt (idle until a read finds no window). */
  const [watch, setWatch] = useState<WatchNotice>(IDLE_WATCH)
  /** The cwd whose automatic attempt has already been made. */
  const watchAttempted = useRef<string | null>(null)
  /** The input switch in flight, if any (a reload replaces what the window shows). */
  const [switching, setSwitching] = useState<HunkReloadTarget | null>(null)
  /** Whether this tab has asked the agent to install Hunk, and how that went. */
  const [installAsk, setInstallAsk] = useState<'sent' | 'failed' | null>(null)
  const [installAsking, setInstallAsking] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const runRef = useRef(0)
  /** The in-flight or settled patch read, tagged with the cwd it belongs to. */
  const patchRef = useRef<{ cwd: string; promise: Promise<Record<string, string>> } | null>(null)

  // A missing cwd is waited on, not failed: the summary list fills in as the
  // session loads, and the subscription above re-renders when it does. Only a
  // list that stays empty is worth telling the user about.
  useEffect(() => {
    if (cwd !== undefined) {
      setCwdTimedOut(false)
      return
    }
    const timer = setTimeout(() => { setCwdTimedOut(true) }, CWD_GRACE_MS)
    return () => { clearTimeout(timer) }
  }, [cwd])
  const cwdFailed = cwd === undefined && cwdTimedOut

  /**
   * Read the diff text once per cwd, on demand: expanding a hunk or copying one
   * is what needs it. Every later caller shares the same promise.
   */
  const ensurePatch = useCallback((): Promise<Record<string, string>> => {
    const current = patchRef.current
    if (current !== null && current.cwd === cwd) return current.promise
    if (cwd === undefined) return Promise.resolve({})
    setPatchState({ status: 'loading', map: {}, missing: [] })
    const promise = fetchHunkPatches(cwd)
      .then((read) => {
        setPatchState({
          status: read.error === null ? 'ready' : 'error',
          map: read.patches,
          missing: read.missing,
          ...(read.error === null ? {} : { code: read.error.code, message: read.error.message }),
        })
        return read.patches
      })
      .catch((error: unknown) => {
        // Drop the memo so the next expansion can try again.
        patchRef.current = null
        if (!isAbort(error)) {
          setPatchState({
            status: 'error',
            map: {},
            missing: [],
            ...(error instanceof HunkClientError ? { code: error.code } : {}),
            message: messageOf(error),
          })
        }
        return {}
      })
    patchRef.current = { cwd, promise }
    return promise
  }, [cwd])

  const refresh = useCallback(() => {
    if (cwd === undefined) return
    // The review is about to be re-read, so the diff text it was sliced from is
    // stale too: forget it and let the next expansion fetch again.
    patchRef.current = null
    setPatchState(IDLE_PATCHES)
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const run = runRef.current + 1
    runRef.current = run
    setBusy(true)
    void fetchHunkState(cwd, controller.signal)
      .then((next) => {
        if (runRef.current !== run) return
        setData(next)
        setFailure(null)
      })
      .catch((error: unknown) => {
        if (runRef.current !== run || isAbort(error)) return
        setFailure({
          code: error instanceof HunkClientError ? error.code : 'unknown',
          message: messageOf(error),
        })
      })
      .finally(() => {
        if (runRef.current === run) setBusy(false)
      })
  }, [cwd])

  // Read on every appearance: `visible` is false while the panel is collapsed
  // or another tab is active, and a review is worth re-reading when the user
  // comes back to it.
  useEffect(() => {
    if (!visible || cwd === undefined) return
    refresh()
  }, [visible, cwd, refresh])

  // Abort whatever is in flight when the tab body unmounts.
  useEffect(() => () => { requestRef.current?.abort() }, [])

  /**
   * Ask the host to open a review window.
   *
   * `force` is for the explicit button: the automatic attempt respects the
   * host's cooldowns, a click does not (the user asking is a decision).
   */
  const openWatchWindow = useCallback(async (target: string, force = false) => {
    setWatch({ status: 'waiting' })
    try {
      const result = await requestHunkWatch(target, force ? { force: true } : {})
      const notice: WatchNotice = {
        status: 'waiting',
        action: result.action,
        command: result.command,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        ...(result.pid === undefined ? {} : { pid: result.pid }),
        ...(result.replaced === undefined ? {} : { replaced: result.replaced }),
      }
      // Poll only while a window is genuinely on its way up; every other verdict
      // is final and the copy says what to do about it.
      setWatch(watchWaiting(notice) ? notice : { ...notice, status: 'settled' })
    } catch (error) {
      setWatch({
        status: 'settled',
        action: 'failed',
        command: `cd "${target}" && hunk diff --watch`,
        detail: messageOf(error),
      })
    }
  }, [])

  // No live window for this repository: open one, automatically, the first time
  // this cwd answers that way. The host is the one that decides whether opening
  // is appropriate (git checkout, autostart switch, an existing window, a
  // window it opened before), so this stays a single unconditional call.
  useEffect(() => {
    if (data === null || cwd === undefined) return
    if (data.matched !== null) {
      // A window exists: whatever we did before is settled and no longer news.
      setWatch(current => (current.status === 'idle' ? current : IDLE_WATCH))
      return
    }
    if (watchAttempted.current === cwd) return
    watchAttempted.current = cwd
    void openWatchWindow(cwd)
  }, [data, cwd, openWatchWindow])

  // While a fresh window registers (seconds, not milliseconds), re-read instead
  // of leaving the user on "no live session" for a started window.
  useEffect(() => {
    if (watch.status !== 'waiting' || !visible) return
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      refresh()
      if (tries >= WATCH_POLL_TRIES) {
        setWatch(current => (current.status === 'waiting' ? { ...current, status: 'settled', gaveUp: true } : current))
      }
    }, WATCH_POLL_MS)
    return () => { clearInterval(timer) }
  }, [watch.status, visible, refresh])

  /**
   * Switch what the live window reads.
   *
   * The only write this tab performs, and only because a button was clicked: it
   * replaces the diff the reader's Hunk window is showing.
   */
  const switchTarget = useCallback(async (target: HunkReloadTarget) => {
    if (cwd === undefined || switching !== null) return
    setSwitching(target)
    try {
      const result = await requestHunkReload(cwd, target)
      if (result.action === 'reloaded') {
        // The window's publication changed underneath us: read it again.
        refresh()
      } else {
        setFailure({
          code: result.action,
          message: result.detail ?? t('target.noSession'),
        })
      }
    } catch (error) {
      setFailure({
        code: error instanceof HunkClientError ? error.code : 'unknown',
        message: messageOf(error),
      })
    } finally {
      setSwitching(null)
    }
  }, [cwd, switching, refresh, t])

  /**
   * Ask the agent in THIS session to install Hunk.
   *
   * The prompt goes through the session API — the same channel the composer uses
   * — queued, never steering, so a running turn is not interrupted. The text is
   * canned (a dictionary entry) with the cwd and the host's diagnostic filled in.
   */
  /**
   * The canned request, built once per render so the inject button and the
   * clipboard button send exactly the same words.
   */
  const installRequest = useMemo(
    () => t('install.ask', { cwd: cwd ?? '', detail: failure?.message ?? '' }),
    [t, cwd, failure],
  )

  /**
   * Ask the agent in THIS session to install Hunk.
   *
   * The prompt goes through the session API — the same channel the composer uses
   * — queued, never steering, so a running turn is not interrupted. The text is
   * canned (a dictionary entry) with the cwd and the host's diagnostic filled in.
   */
  const askForInstall = useCallback(() => {
    if (installAsking) return
    setInstallAsking(true)
    setInstallAsk(null)
    void (async () => {
      try {
        const outcome = await askAgentToInstall(ctx, sessionId, installRequest)
        setInstallAsk(outcome.ok ? 'sent' : 'failed')
        if (!outcome.ok) console.error('[dsh-hunk] could not ask the agent to install Hunk:', outcome.reason, outcome.message ?? '')
      } catch (error) {
        console.error('[dsh-hunk] asking the agent to install Hunk failed:', error)
        setInstallAsk('failed')
      } finally {
        setInstallAsking(false)
      }
    })()
  }, [installAsking, ctx, sessionId, installRequest])

  /** One retry action for both failure kinds: wait for cwd again, or re-read. */
  const retry = useCallback(() => {
    if (cwd === undefined) {
      // Nothing to ask: the list is the authority, so start the grace period over.
      setCwdTimedOut(false)
      return
    }
    refresh()
  }, [cwd, refresh])

  const review = data?.review ?? null
  const fetchedAt = formatTime(data?.fetchedAt)
  // Capability negotiation, not shape guessing: a host build without the patch
  // read says so in the state payload, so the tab can explain itself instead of
  // firing a request that cannot be answered and reporting the wreckage.
  const patchCapable = data?.capabilities?.patches === true
  return (
    <div style={styles.root as CSSProperties} data-dsh-hunk-tab="">
      <div style={styles.header as CSSProperties}>
        <span style={styles.headerTitle as CSSProperties}>{t('view.title')}</span>
        <span style={styles.spacer as CSSProperties} />
        {fetchedAt !== undefined && (
          <span style={styles.muted as CSSProperties}>{t('updated.at', { time: fetchedAt })}</span>
        )}
        <Button
          label={busy ? t('action.refreshing') : t('action.refresh')}
          disabled={busy || cwd === undefined}
          onClick={retry}
        />
      </div>
      <div style={styles.body as CSSProperties}>
        {cwdFailed && <FailureBlock t={t} failure={{ code: 'cwd', message: t('cwd.missing') }} onRetry={retry} />}
        {!cwdFailed && failure !== null && (
          failure.code === 'hunk-cli-missing'
            // Nothing is broken: Hunk itself is absent, which is a thing to
            // explain and to offer help with, not an error to retry.
            ? (
                <InstallGuide
                  t={t}
                  detail={failure.message}
                  askText={installRequest}
                  asked={installAsk}
                  asking={installAsking}
                  onAsk={askForInstall}
                />
              )
            : <FailureBlock t={t} failure={failure} onRetry={retry} />
        )}
        {!cwdFailed && failure === null && data === null && (
          <p style={styles.muted as CSSProperties}>{t('loading')}</p>
        )}
        {/*
          The report of the window this tab tried to open, above the state it
          explains: "no live session" and "a window is starting" are the same
          screen, and the second one is the one that is about to change.
        */}
        {!cwdFailed && data !== null && data.matched === null && (
          <WatchNoticeView
            t={t}
            watch={watch}
            onOpen={() => { if (cwd !== undefined) void openWatchWindow(cwd, true) }}
          />
        )}
        {!cwdFailed && data !== null && review === null && <EmptyState t={t} data={data} />}
        {!cwdFailed && data !== null && review !== null && (
          <>
            <SessionStrip t={t} data={data} review={review} session={data.matched ?? undefined} />
            <ReviewTargetBar
              t={t}
              title={review.title}
              target={switching}
              busy={switching !== null}
              onPick={(next) => { void switchTarget(next) }}
            />
            {review.files.length === 0 && (
              <p style={styles.muted as CSSProperties}>{t('empty.files')}</p>
            )}
            {review.files.map(file => (
              <FileCard
                key={file.id}
                t={t}
                file={file}
                notes={review.reviewNotes}
                focusedPath={review.selectedFilePath}
                focusedHunk={review.selectedHunkIndex}
                patchState={patchState}
                patchCapable={patchCapable}
                ensurePatch={ensurePatch}
              />
            ))}
            {review.files.length > 0 && review.reviewNotes.length === 0 && (
              <p style={styles.muted as CSSProperties}>{t('note.empty')}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
