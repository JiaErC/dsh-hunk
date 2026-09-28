/**
 * Unified-diff text helpers behind the "expand a hunk to see its changes" view.
 *
 * Hunk reports a file's raw unified diff text only when the review is read with
 * `--include-patch`; the structural read (hunks, ranges, notes) stays cheap.
 * These helpers are pure so the tab can slice one hunk out of that text and the
 * tests can pin the edge cases (no preamble, CRLF, `\ No newline`, missing
 * patch) without a browser.
 */
import type { HunkLineRange, HunkReviewHunk, HunkReviewNote } from './wire'

/** What one diff body line is, from its leading sign. */
export type PatchLineKind = 'add' | 'del' | 'meta' | 'context'

/** One hunk sliced out of a file's unified diff text. */
export interface PatchHunk {
  /** The `@@ -a,b +c,d @@` section header (trailing function hint included). */
  header: string
  /** Body lines verbatim, each keeping its leading `+` / `-` / space sign. */
  lines: string[]
  /** The hunk as copyable patch text: header, body, trailing newline. */
  text: string
}

/** Classify one body line. */
export function patchLineKind(line: string): PatchLineKind {
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  // "\ No newline at end of file" — a marker, not a change.
  if (line.startsWith('\\')) return 'meta'
  return 'context'
}

/** Whether a line opens a hunk section. */
function isHunkHeader(line: string): boolean {
  return line.startsWith('@@ ')
}

/**
 * Slice every hunk out of one file's unified diff text.
 * @param patch - raw unified diff text (a `diff --git` preamble is optional).
 * @returns the hunks in file order; an unparsable text yields none.
 */
export function splitPatchHunks(patch: string): PatchHunk[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const hunks: PatchHunk[] = []
  let headerIndex = -1
  const flush = (endExclusive: number): void => {
    if (headerIndex < 0) return
    const header = lines[headerIndex] ?? ''
    const body = lines.slice(headerIndex + 1, endExclusive)
    // A trailing empty element is the final newline, not a context line.
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    hunks.push({ header, lines: body, text: `${[header, ...body].join('\n')}\n` })
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!isHunkHeader(lines[index] ?? '')) continue
    flush(index)
    headerIndex = index
  }
  flush(lines.length)
  return hunks
}

/**
 * Pick the patch hunk that belongs to one review hunk.
 *
 * The review's `hunks[].header` is the same `@@ … @@` line the patch carries, so
 * the header is the reliable key; the index is the fallback for a review whose
 * headers were normalized.
 * @param patch - the file's raw diff text, when the patch read succeeded.
 * @param hunk - the review hunk to match.
 * @returns the matching patch hunk, or undefined when there is no patch text.
 */
export function pickPatchHunk(
  patch: string | undefined,
  hunk: Pick<HunkReviewHunk, 'index' | 'header'>,
): PatchHunk | undefined {
  if (patch === undefined || patch === '') return undefined
  const hunks = splitPatchHunks(patch)
  if (hunks.length === 0) return undefined
  const byHeader = hunks.find(candidate => candidate.header === hunk.header)
  if (byHeader !== undefined) return byHeader
  return hunks[hunk.index]
}

/** The `@@`-header line's starting line numbers, when they parse. */
export function hunkLineNumbers(header: string): { old: number; line: number } | undefined {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header)
  if (match === null) return undefined
  const oldStart = Number(match[1])
  const newStart = Number(match[2])
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return undefined
  return { old: oldStart, line: newStart }
}

/** What the tab needs from one patch read, whatever shape the host answered with. */
export interface PatchesReadResult {
  /** File path → raw unified diff text. */
  patches: Record<string, string>
  /** Files the review listed without patch text. */
  missing: string[]
  /** Why the map is empty, when it is. */
  error: { code: string; message: string } | null
}

/** One cell of a side-by-side row: a line number and the line without its sign. */
export interface SplitCell {
  no: number
  text: string
}

/**
 * One row of the side-by-side view.
 *
 * `context` carries both sides (the same line, numbered twice); `change`
 * carries whichever sides exist — a pure deletion has only `left`, a pure
 * addition only `right`; `meta` is a marker such as `\ No newline at end of
 * file`, which belongs to neither side and spans the row.
 */
export interface SplitRow {
  kind: 'context' | 'change' | 'meta'
  left?: SplitCell
  right?: SplitCell
  /** Full-width text for a `meta` row. */
  text?: string
}

/**
 * Turn one hunk into side-by-side rows.
 *
 * Unified diff text states a replacement as its deletions followed by its
 * additions, so the two runs are paired position by position: row *i* shows the
 * i-th deleted line on the left and the i-th added line on the right, and the
 * longer run's tail keeps one side empty.
 * @param patch - the hunk to lay out.
 * @returns the rows in file order.
 */
export function toSplitRows(patch: PatchHunk): SplitRow[] {
  const start = hunkLineNumbers(patch.header)
  let oldNo = start?.old ?? 1
  let newNo = start?.line ?? 1
  const rows: SplitRow[] = []
  let index = 0
  while (index < patch.lines.length) {
    const line = patch.lines[index] ?? ''
    const kind = patchLineKind(line)
    if (kind === 'meta') {
      rows.push({ kind: 'meta', text: line })
      index += 1
      continue
    }
    if (kind === 'context') {
      const text = line.slice(1)
      rows.push({ kind: 'context', left: { no: oldNo, text }, right: { no: newNo, text } })
      oldNo += 1
      newNo += 1
      index += 1
      continue
    }
    const deletions: string[] = []
    while (index < patch.lines.length && patchLineKind(patch.lines[index] ?? '') === 'del') {
      deletions.push((patch.lines[index] ?? '').slice(1))
      index += 1
    }
    const additions: string[] = []
    while (index < patch.lines.length && patchLineKind(patch.lines[index] ?? '') === 'add') {
      additions.push((patch.lines[index] ?? '').slice(1))
      index += 1
    }
    const height = Math.max(deletions.length, additions.length)
    for (let offset = 0; offset < height; offset += 1) {
      const left = offset < deletions.length ? { no: oldNo, text: deletions[offset] ?? '' } : undefined
      if (left !== undefined) oldNo += 1
      const right = offset < additions.length ? { no: newNo, text: additions[offset] ?? '' } : undefined
      if (right !== undefined) newNo += 1
      rows.push({
        kind: 'change',
        ...(left === undefined ? {} : { left }),
        ...(right === undefined ? {} : { right }),
      })
    }
  }
  return rows
}

/** Notes bucketed onto the split row they hang under, plus the ones that could not be placed. */
export interface PlacedNotes {
  /** Row index → the notes drawn directly under that row. */
  byRow: Map<number, HunkReviewNote[]>
  /** Notes whose anchor is not among this hunk's rows (kept visible below the hunk). */
  unplaced: HunkReviewNote[]
}

/** The split row one note hangs under: the last row of the range it anchors to. */
function rowForNote(rows: readonly SplitRow[], note: HunkReviewNote): number | undefined {
  // The new side is where a change lands, so it wins when a note carries both.
  const sides: Array<{ range: HunkLineRange | undefined; lineOf: (row: SplitRow) => number | undefined }> = [
    { range: note.newRange, lineOf: row => row.right?.no },
    { range: note.oldRange, lineOf: row => row.left?.no },
  ]
  for (const { range, lineOf } of sides) {
    if (range === undefined) continue
    const from = range[0]
    const to = range[1]
    let found: number | undefined
    for (let index = 0; index < rows.length; index += 1) {
      const no = lineOf(rows[index] ?? { kind: 'meta' })
      if (no !== undefined && no >= from && no <= to) found = index
    }
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Place a hunk's notes under the code lines they review.
 * @param rows - the hunk's side-by-side rows.
 * @param notes - the notes anchored to this hunk.
 * @returns the per-row buckets plus whatever could not be placed.
 */
export function placeNotes(rows: readonly SplitRow[], notes: readonly HunkReviewNote[]): PlacedNotes {
  const byRow = new Map<number, HunkReviewNote[]>()
  const unplaced: HunkReviewNote[] = []
  for (const note of notes) {
    const row = rowForNote(rows, note)
    if (row === undefined) {
      unplaced.push(note)
      continue
    }
    const bucket = byRow.get(row)
    if (bucket === undefined) byRow.set(row, [note])
    else bucket.push(note)
  }
  return { byRow, unplaced }
}

/**
 * Normalize one patch read's response.
 *
 * A host that predates the patch read answers the same URL with the structural
 * payload, which has neither `patches` nor `error`. That must be a clear,
 * actionable failure — never a crash deep inside the view — so the shape is
 * checked here rather than assumed at the call site.
 * @param raw - the parsed response body.
 * @returns the normalized result, or undefined when this is not a patch payload.
 */
export function parsePatchesPayload(raw: unknown): PatchesReadResult | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const rawPatches = record.patches
  if (typeof rawPatches !== 'object' || rawPatches === null || Array.isArray(rawPatches)) return undefined

  const patches: Record<string, string> = {}
  for (const [path, text] of Object.entries(rawPatches)) {
    if (typeof text === 'string') patches[path] = text
  }
  const missing = Array.isArray(record.missing)
    ? record.missing.filter((value): value is string => typeof value === 'string')
    : []
  const rawError = record.error
  const errorRecord = typeof rawError === 'object' && rawError !== null
    ? rawError as Record<string, unknown>
    : undefined
  const error = errorRecord !== undefined && typeof errorRecord.code === 'string'
    ? {
        code: errorRecord.code,
        message: typeof errorRecord.message === 'string' ? errorRecord.message : '',
      }
    : null
  return { patches, missing, error }
}
