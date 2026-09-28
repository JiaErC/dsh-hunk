/**
 * Unified-diff text helpers behind the "expand a hunk to see its changes" view.
 *
 * Hunk reports a file's raw unified diff text only when the review is read with
 * `--include-patch`; the structural read (hunks, ranges, notes) stays cheap.
 * These helpers are pure so the tab can slice one hunk out of that text and the
 * tests can pin the edge cases (no preamble, CRLF, `\ No newline`, missing
 * patch) without a browser.
 */
import type { HunkReviewHunk } from './wire'

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
