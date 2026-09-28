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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
import type {
  HunkReviewFile,
  HunkReviewHunk,
  HunkReviewNote,
  HunkReviewPayload,
  HunkSessionSummary,
  HunkStatePayload,
} from '../shared/wire'
import { groupNotes, pathKey } from '../shared/notes'
import { hunkLineNumbers, patchLineKind, pickPatchHunk, type PatchHunk } from '../shared/patch'
import { HunkClientError, fetchHunkPatches, fetchHunkState, isAbort, messageOf, resolveSessionCwd } from './api'
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

/** The diff lines of one hunk, coloured like the host's diff view. */
function HunkDiff(props: {
  t: Translate
  filePath: string
  hunk: HunkReviewHunk
  patch: PatchHunk | undefined
  patchState: PatchState
  patchCapable: boolean
}): ReactNode {
  const { t, filePath, hunk, patch, patchState, patchCapable } = props
  if (patch === undefined) {
    // Order matters: "this build cannot" is a different fact from "that read
    // failed", and only the first one tells the user to restart the host.
    const notice = !patchCapable || patchState.code === UNSUPPORTED
      ? t('hunk.patchUnsupported')
      : patchState.status === 'error'
        ? t('hunk.patchFailed', { message: patchState.message ?? patchState.code ?? '' })
        : patchState.status === 'ready' && patchState.missing.includes(filePath)
          ? t('hunk.patchMissing')
          : t('hunk.patchLoading')
    return <div style={styles.diffNotice as CSSProperties}>{notice}</div>
  }
  const start = hunkLineNumbers(patch.header)
  let oldNo = start?.old ?? 0
  let newNo = start?.line ?? 0
  return (
    <div style={styles.diffBody as CSSProperties}>
      {patch.lines.map((line, index) => {
        const kind = patchLineKind(line)
        const showsOld = kind === 'context' || kind === 'del'
        const showsNew = kind === 'context' || kind === 'add'
        const oldLabel = showsOld ? String(oldNo) : ''
        const newLabel = showsNew ? String(newNo) : ''
        if (kind === 'context') {
          oldNo += 1
          newNo += 1
        } else if (kind === 'del') oldNo += 1
        else if (kind === 'add') newNo += 1
        const hue = kind === 'add'
          ? styles.diffAddText
          : kind === 'del'
            ? styles.diffDelText
            : kind === 'meta'
              ? styles.diffMetaText
              : undefined
        const tint = kind === 'add' ? styles.diffAdd : kind === 'del' ? styles.diffDel : undefined
        return (
          <div key={index} style={{ ...styles.diffRow, ...(tint ?? {}) } as CSSProperties}>
            <span style={styles.diffNo as CSSProperties}>{oldLabel}</span>
            <span style={styles.diffNo as CSSProperties}>{newLabel}</span>
            <span style={{ ...styles.diffSign, ...(hue ?? {}) } as CSSProperties}>
              {kind === 'meta' ? '' : line.slice(0, 1)}
            </span>
            <span style={{ ...styles.diffText, ...(hue ?? {}) } as CSSProperties}>
              {kind === 'meta' ? line : line.slice(1)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * One hunk: a collapsible row (index, section header, ranges, copy) over its
 * diff lines. Notes anchored to the hunk stay visible whether it is open.
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
  const ranges = hunkRanges(hunk, t)
  const patch = useMemo(
    () => pickPatchHunk(patchState.map[filePath], hunk),
    [patchState.map, filePath, hunk],
  )

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
          style={styles.hunkRow as CSSProperties}
          title={open ? t('hunk.collapse') : t('hunk.expand')}
          aria-expanded={open}
          onClick={toggle}
        >
          <span style={styles.caret as CSSProperties}>{open ? '▼' : '▶'}</span>
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
      {open && (
        <div style={styles.hunkBody as CSSProperties}>
          <div style={styles.locationRow as CSSProperties}>
            <span>{t('hunk.location')}</span>
            <span style={styles.locationPath as CSSProperties}>{`${filePath}${ranges === '' ? '' : ` · ${ranges}`}`}</span>
            <span>{t('hunk.changes')}</span>
          </div>
          <HunkDiff
            t={t}
            filePath={filePath}
            hunk={hunk}
            patch={patch}
            patchState={patchState}
            patchCapable={patchCapable}
          />
        </div>
      )}
      {notes.map(note => <NoteView key={note.noteId} t={t} note={note} />)}
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
      {open && (
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

/** The "no live session" state: exactly what to run, in which directory. */
function EmptyState({ t, data }: { t: Translate; data: HunkStatePayload }): ReactNode {
  return (
    <div style={styles.empty as CSSProperties}>
      <div style={styles.emptyTitle as CSSProperties}>{t('empty.title')}</div>
      <div>{t('empty.lead')}</div>
      <CommandLine t={t} text={`cd ${data.cwd} && hunk diff --watch`} />
      <div style={{ ...styles.muted, marginTop: 6 } as CSSProperties}>{t('empty.tip')}</div>
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
 * The tab body.
 * @param props - better-sidebar's tab component props.
 * @returns the rendered view.
 */
export function HunkReviewTab({ ctx, scope, visible }: TabComponentProps): ReactNode {
  const t = useTranslate(ctx)
  const [cwd, setCwd] = useState<string | undefined>(
    scope.cwd !== undefined && scope.cwd !== '' ? scope.cwd : undefined,
  )
  const [cwdFailed, setCwdFailed] = useState(false)
  const [data, setData] = useState<HunkStatePayload | null>(null)
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [patchState, setPatchState] = useState<PatchState>(IDLE_PATCHES)
  /** Bumped by the retry button so a failed cwd resolution runs again. */
  const [cwdAttempt, setCwdAttempt] = useState(0)
  const requestRef = useRef<AbortController | null>(null)
  const runRef = useRef(0)
  /** The in-flight or settled patch read, tagged with the cwd it belongs to. */
  const patchRef = useRef<{ cwd: string; promise: Promise<Record<string, string>> } | null>(null)

  // The session cwd is the one input the host cannot guess: prefer the scope,
  // otherwise ask the sidebar route that owns the authoritative answer.
  useEffect(() => {
    if (scope.cwd !== undefined && scope.cwd !== '') {
      setCwd(scope.cwd)
      setCwdFailed(false)
      return
    }
    const controller = new AbortController()
    let live = true
    void resolveSessionCwd(scope, controller.signal)
      .then((resolved) => {
        if (!live) return
        if (resolved === undefined) setCwdFailed(true)
        else {
          setCwd(resolved)
          setCwdFailed(false)
        }
      })
      .catch((error: unknown) => {
        if (!live || isAbort(error)) return
        setCwdFailed(true)
      })
    return () => {
      live = false
      controller.abort()
    }
  }, [scope.sessionId, scope.cwd, cwdAttempt])

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

  /** One retry action for both failure kinds: re-resolve cwd, then re-read. */
  const retry = useCallback(() => {
    if (cwd === undefined) {
      setCwdFailed(false)
      setCwdAttempt(attempt => attempt + 1)
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
          <FailureBlock t={t} failure={failure} onRetry={retry} />
        )}
        {!cwdFailed && failure === null && data === null && (
          <p style={styles.muted as CSSProperties}>{t('loading')}</p>
        )}
        {!cwdFailed && data !== null && review === null && <EmptyState t={t} data={data} />}
        {!cwdFailed && data !== null && review !== null && (
          <>
            <SessionStrip t={t} data={data} review={review} session={data.matched ?? undefined} />
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
