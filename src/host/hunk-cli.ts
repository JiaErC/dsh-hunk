/**
 * Host-side bridge to the Hunk CLI.
 *
 * One state read = the two commands the tab is defined by, both spawned with
 * the session cwd as their child-process cwd:
 *
 *   hunk session list --json                          (all live windows)
 *   hunk session review --repo . --json --include-notes   (this repo's window)
 *
 * `--repo .` is why the cwd matters, and `--include-notes` is what brings the
 * review notes back in the same payload. Everything here is pure apart from
 * the spawn itself, so the parsing and matching rules are unit-testable
 * against real CLI output (see `test/host.test.mjs`).
 */
import { execFile, type ExecFileException } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  HUNK_ERROR,
  HUNK_LIST_COMMAND,
  HUNK_REVIEW_COMMAND,
  type HunkErrorCode,
  type HunkLineRange,
  type HunkPatchesPayload,
  type HunkReviewFile,
  type HunkReviewHunk,
  type HunkReviewNote,
  type HunkReviewPayload,
  type HunkSessionSummary,
  type HunkStatePayload,
} from '../shared/wire'

/** Tunables the host plugin owns (no config surface in v1). */
export interface HunkCliOptions {
  /** Executable to run; `hunk` resolves through PATH (hunk.exe on Windows). */
  bin: string
  /** Per-command budget; a hung CLI must not hold the route open. */
  timeoutMs: number
}

export const DEFAULT_HUNK_CLI_OPTIONS: HunkCliOptions = { bin: 'hunk', timeoutMs: 15_000 }

/** stdout cap: a big review structure is still only structure, but stay bounded. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** A route-level failure carrying the HTTP status the handler should answer with. */
export class HunkRouteError extends Error {
  readonly code: HunkErrorCode
  readonly status: number

  constructor(code: HunkErrorCode, message: string, status: number) {
    super(message)
    this.name = 'HunkRouteError'
    this.code = code
    this.status = status
  }
}

/** One finished CLI invocation. */
export interface HunkCliRun {
  /** Exit status 0 and stdout present. */
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** Spawn-level failure (ENOENT and friends), not a non-zero exit. */
  spawnError: string | null
}

/**
 * Whether an execFile failure was its timeout rather than the child exiting.
 *
 * `killed` is set only by the timeout kill; `signal` is `null` (not undefined)
 * for an ordinary non-zero exit, so it must be tested for null, not undefined —
 * otherwise every failure reads as a timeout and "no session" turns into a 504.
 */
function isTimeout(error: ExecFileException): boolean {
  return error.killed === true || error.signal != null
}

/**
 * Run one `hunk ...` invocation in `cwd`.
 * @param args - argv tail (the subcommand and its flags).
 * @param cwd - child-process working directory; `--repo .` resolves against it.
 * @param options - executable and timeout.
 * @returns the finished run; never rejects (failures land in the result).
 */
export function runHunkCli(
  args: readonly string[],
  cwd: string,
  options: HunkCliOptions,
): Promise<HunkCliRun> {
  return new Promise((settle) => {
    execFile(
      options.bin,
      [...args],
      { cwd, timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const failure = error as ExecFileException | null
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (failure === null) {
          settle({ ok: true, stdout: out, stderr: err, code: 0, timedOut: false, spawnError: null })
          return
        }
        // A non-zero exit surfaces as `code: <number>`; a spawn failure as an
        // errno string (`ENOENT`), which is the case that means "hunk is not
        // installed" rather than "no session".
        const spawnError = typeof failure.code === 'string' ? failure.code : null
        settle({
          ok: false,
          stdout: out,
          stderr: err,
          code: typeof failure.code === 'number' ? failure.code : null,
          timedOut: isTimeout(failure),
          spawnError,
        })
      },
    )
  })
}

/** Trim one line of CLI diagnostics for the wire. */
function brief(text: string, limit = 400): string {
  const line = text
    .split(/\r?\n/)
    .map(part => part.trim())
    .filter(part => part !== '')
    .join(' ')
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** Parse JSON, or undefined when the text is not JSON (PowerShell noise, warnings, …). */
export function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // A CLI that printed a leading warning still has one JSON object in there.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function lineRange(value: unknown): HunkLineRange | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const [start, end] = value
  return typeof start === 'number' && typeof end === 'number' ? [start, end] : undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Fold both spellings Hunk uses for the focus into the flat session shape. */
function readSession(value: unknown): HunkSessionSummary | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const sessionId = text(raw.sessionId)
  if (sessionId === undefined) return undefined
  const snapshot = record(raw.snapshot)
  const state = snapshot === undefined ? undefined : record(snapshot.state)
  return {
    sessionId,
    pid: count(raw.pid),
    cwd: text(raw.cwd),
    repoRoot: text(raw.repoRoot),
    launchedAt: text(raw.launchedAt),
    inputKind: text(raw.inputKind),
    title: text(raw.title),
    sourceLabel: text(raw.sourceLabel),
    fileCount: count(raw.fileCount),
    selectedFilePath: state === undefined ? undefined : text(state.selectedFilePath),
    selectedHunkIndex: state === undefined ? undefined : count(state.selectedHunkIndex),
    liveCommentCount: state === undefined ? undefined : count(state.liveCommentCount),
    reviewNoteCount: state === undefined ? undefined : count(state.reviewNoteCount),
  }
}

/**
 * Read `hunk session list --json`.
 * @param payload - parsed stdout.
 * @returns the live windows; an unreadable payload reads as none.
 */
export function readSessions(payload: unknown): HunkSessionSummary[] {
  const root = record(payload)
  if (root === undefined) return []
  const rows = array(root.sessions).length > 0 ? array(root.sessions) : array(root)
  return rows.map(readSession).filter((row): row is HunkSessionSummary => row !== undefined)
}

function readHunk(value: unknown): HunkReviewHunk | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const index = count(raw.index)
  if (index === undefined) return undefined
  return {
    index,
    header: text(raw.header) ?? '',
    oldRange: lineRange(raw.oldRange),
    newRange: lineRange(raw.newRange),
  }
}

function readFile(value: unknown): HunkReviewFile | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const path = text(raw.path)
  if (path === undefined) return undefined
  const hunks = array(raw.hunks).map(readHunk).filter((hunk): hunk is HunkReviewHunk => hunk !== undefined)
  return {
    id: text(raw.id) ?? path,
    path,
    previousPath: text(raw.previousPath),
    additions: count(raw.additions) ?? 0,
    deletions: count(raw.deletions) ?? 0,
    hunkCount: count(raw.hunkCount) ?? hunks.length,
    hunks,
    // Present only in a `--include-patch` read; the tree read omits it.
    patch: typeof raw.patch === 'string' ? raw.patch : undefined,
  }
}

function readNote(value: unknown): HunkReviewNote | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const filePath = text(raw.filePath)
  if (filePath === undefined) return undefined
  const body = text(raw.body) ?? ''
  return {
    noteId: text(raw.noteId) ?? `${filePath}:${text(raw.createdAt) ?? ''}`,
    parentId: text(raw.parentId),
    source: text(raw.source) ?? 'user',
    filePath,
    hunkIndex: count(raw.hunkIndex),
    oldRange: lineRange(raw.oldRange),
    newRange: lineRange(raw.newRange),
    body,
    title: text(raw.title),
    author: text(raw.author),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
    editable: typeof raw.editable === 'boolean' ? raw.editable : undefined,
  }
}

/**
 * Read `hunk session review --json [--include-notes]`.
 * @param payload - parsed stdout.
 * @returns the review, or undefined when the payload carries no review object.
 */
export function readReview(payload: unknown): HunkReviewPayload | undefined {
  const root = record(payload)
  if (root === undefined) return undefined
  // The CLI wraps its result (`{ review: { … } }`); an older/simpler shape may
  // have handed the review straight back, so accept both.
  const inner = record(root.review) ?? (Array.isArray(root.files) ? root : undefined)
  if (inner === undefined) return undefined
  const sessionId = text(inner.sessionId)
  if (sessionId === undefined) return undefined
  const selectedFile = record(inner.selectedFile)
  const selectedHunk = record(inner.selectedHunk)
  return {
    sessionId,
    title: text(inner.title) ?? '',
    sourceLabel: text(inner.sourceLabel) ?? '',
    cwd: text(inner.cwd),
    repoRoot: text(inner.repoRoot),
    inputKind: text(inner.inputKind),
    experimentalFeatures: array(inner.experimentalFeatures).filter((f): f is string => typeof f === 'string'),
    selectedFilePath: selectedFile === undefined ? undefined : text(selectedFile.path),
    selectedHunkIndex: selectedHunk === undefined ? undefined : count(selectedHunk.index),
    showAgentNotes: typeof inner.showAgentNotes === 'boolean' ? inner.showAgentNotes : undefined,
    liveCommentCount: count(inner.liveCommentCount),
    reviewNoteCount: count(inner.reviewNoteCount),
    reviewNotes: array(inner.reviewNotes).map(readNote).filter((note): note is HunkReviewNote => note !== undefined),
    files: array(inner.files).map(readFile).filter((file): file is HunkReviewFile => file !== undefined),
  }
}

/**
 * Canonical comparable form of one filesystem path.
 *
 * Hunk reports `repoRoot` in POSIX spelling (`E:/repo`) while the session cwd
 * arrives Windows-spelled (`E:\repo`), and Windows compares case-insensitively.
 * @param value - a path from the CLI or from the browser.
 * @returns the comparison key.
 */
export function locationKey(value: string): string {
  const unified = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/**
 * Pick the live window that belongs to `cwd`.
 *
 * Equality with the window's cwd or repo root is the common case; containment
 * matters too, because a review started in a subdirectory is still the window
 * for that repository, and `hunk session review --repo .` run from that
 * subdirectory resolves to the same session.
 * @param sessions - live windows.
 * @param cwd - the session cwd both commands ran in.
 * @returns the window whose cwd (or repo root) covers that directory.
 */
export function matchSession(
  sessions: readonly HunkSessionSummary[],
  cwd: string,
): HunkSessionSummary | undefined {
  const wanted = locationKey(cwd)
  return sessions.find((session) => {
    const roots = [session.cwd, session.repoRoot].filter((value): value is string => value !== undefined)
    return roots.some((root) => {
      const key = locationKey(root)
      return key === wanted || wanted.startsWith(`${key}/`)
    })
  })
}

/** Distinct repo roots of the windows that are not the requested one. */
function otherRepoRoots(
  sessions: readonly HunkSessionSummary[],
  matched: HunkSessionSummary | undefined,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const session of sessions) {
    if (matched !== undefined && session.sessionId === matched.sessionId) continue
    const label = session.repoRoot ?? session.cwd
    if (label === undefined) continue
    const key = locationKey(label)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/** Turn one failed CLI run into the route error it deserves. */
function failureOf(run: HunkCliRun, fallback: HunkErrorCode, what: string): HunkRouteError {
  if (run.spawnError !== null || (run.code === null && !run.timedOut)) {
    return new HunkRouteError(
      HUNK_ERROR.cliMissing,
      `cannot run "${HUNK_LIST_COMMAND.split(' ')[0]}" (${run.spawnError ?? 'spawn failed'}). Install Hunk (npm i -g hunkdiff) or point DSH_HUNK_BIN at the executable.`,
      503,
    )
  }
  if (run.timedOut) {
    return new HunkRouteError(HUNK_ERROR.cliTimeout, `${what} did not finish in time`, 504)
  }
  return new HunkRouteError(fallback, `${what} failed: ${brief(run.stderr) || `exit ${String(run.code)}`}`, 502)
}

/**
 * Validate the requested cwd.
 * @param value - raw `cwd` query parameter.
 * @returns the absolute directory to run the CLI in.
 * @throws {HunkRouteError} when it is missing, malformed, or not a directory.
 */
export async function resolveRequestCwd(value: string | null | undefined): Promise<string> {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') {
    throw new HunkRouteError(HUNK_ERROR.missingCwd, 'the request carries no cwd; the tab resolves the session cwd first', 400)
  }
  if (raw.includes('\0')) {
    throw new HunkRouteError(HUNK_ERROR.badCwd, 'cwd contains a NUL byte', 400)
  }
  const cwd = resolve(raw)
  let info
  try {
    info = await stat(cwd)
  } catch {
    throw new HunkRouteError(HUNK_ERROR.badCwd, `cwd does not exist: ${cwd}`, 400)
  }
  if (!info.isDirectory()) {
    throw new HunkRouteError(HUNK_ERROR.badCwd, `cwd is not a directory: ${cwd}`, 400)
  }
  return cwd
}

/**
 * Read one review snapshot for a session cwd.
 *
 * The list read runs FIRST, and the review read only runs when it found a window
 * for this repository. Two reasons, both learned from a real screenshot:
 *
 * - `hunk session review --repo .` answers a selector that matches nothing with
 *   `hunk: protocol-validation-failed` — measured in three different repositories
 *   (with commits, without commits, and the one that reported it), so it is
 *   simply how this build spells "no live session". Showing that string in the
 *   tab tells the reader nothing and looks like a crash.
 * - With no window there is nothing to review, so the second command is a whole
 *   Hunk startup spent to produce that non-answer.
 *
 * @param cwdInput - raw `cwd` query parameter (absolute path).
 * @param options - executable and timeout; defaults to the plugin's.
 * @returns the state payload the tab renders.
 * @throws {HunkRouteError} on a bad cwd or an unusable Hunk installation.
 */
export async function collectHunkState(
  cwdInput: string | null | undefined,
  options: HunkCliOptions = DEFAULT_HUNK_CLI_OPTIONS,
): Promise<HunkStatePayload> {
  const cwd = await resolveRequestCwd(cwdInput)
  const listRun = await runHunkCli(['session', 'list', '--json'], cwd, options)

  // The list read decides whether Hunk is usable at all: a broken CLI or an
  // aborted run is an error, while a plain "no windows" is a normal answer.
  let sessions: HunkSessionSummary[] = []
  if (listRun.ok) {
    const parsed = parseJson(listRun.stdout)
    sessions = readSessions(parsed)
  } else if (listRun.spawnError !== null || listRun.timedOut) {
    throw failureOf(listRun, HUNK_ERROR.listFailed, 'hunk session list')
  }

  const matched = matchSession(sessions, cwd)
  if (matched === undefined) {
    // No window for this repository: the tab says so itself, in its own words.
    return {
      ok: true,
      cwd,
      fetchedAt: new Date().toISOString(),
      commands: { list: HUNK_LIST_COMMAND, review: HUNK_REVIEW_COMMAND },
      sessions,
      matched: null,
      otherRepos: otherRepoRoots(sessions, undefined),
      review: null,
      reviewError: null,
      capabilities: { patches: true },
    }
  }

  const reviewRun = await runHunkCli(['session', 'review', '--repo', '.', '--json', '--include-notes'], cwd, options)
  let review: HunkReviewPayload | null = null
  let reviewError: { code: string; message: string } | null = null
  if (reviewRun.ok) {
    const parsed = parseJson(reviewRun.stdout)
    const read = readReview(parsed)
    if (read === undefined) {
      reviewError = { code: HUNK_ERROR.badJson, message: `hunk session review returned no readable review (${brief(reviewRun.stdout, 200)})` }
    } else {
      review = read
    }
  } else {
    // A window matched but its review could not be read: that IS an error worth
    // showing, because the user has a window and expects to see it.
    const failure = failureOf(reviewRun, HUNK_ERROR.reviewFailed, 'hunk session review')
    reviewError = { code: failure.code, message: failure.message }
  }

  return {
    ok: true,
    cwd,
    fetchedAt: new Date().toISOString(),
    commands: { list: HUNK_LIST_COMMAND, review: HUNK_REVIEW_COMMAND },
    sessions,
    matched: matched ?? null,
    otherRepos: otherRepoRoots(sessions, matched),
    review,
    reviewError,
    // Tells a browser build what this host can answer; the patch read is the
    // first optional capability, and its absence from an older host build is
    // exactly what the tab reports as "restart dsh web".
    capabilities: { patches: true },
  }
}

/** The patch command (the review command plus the one flag that carries diff text). */
export const HUNK_PATCH_COMMAND = `${HUNK_REVIEW_COMMAND} --include-patch`

/** How long one patch read is reused before the CLI is asked again. */
const PATCH_CACHE_TTL_MS = 5_000

interface PatchCacheEntry {
  at: number
  payload: HunkPatchesPayload
}

const patchCache = new Map<string, PatchCacheEntry>()
const patchInFlight = new Map<string, Promise<HunkPatchesPayload>>()

/** Drop the patch cache (tests; also the hook for a future explicit invalidation). */
export function clearPatchCache(): void {
  patchCache.clear()
  patchInFlight.clear()
}

/** One patch read: the review command with `--include-patch`, folded to a path → text map. */
async function readPatches(cwd: string, options: HunkCliOptions): Promise<HunkPatchesPayload> {
  const base = { ok: true as const, cwd, fetchedAt: new Date().toISOString() }
  const empty = (code: HunkErrorCode, message: string): HunkPatchesPayload =>
    ({ ...base, patches: {}, missing: [], error: { code, message } })

  // Ask the cheap question first: patch text can only come from a window that
  // exists, and the patch command reconstructs one patch per file. Without a
  // session there is nothing to fetch, so skip the expensive read entirely.
  const listRun = await runHunkCli(['session', 'list', '--json'], cwd, options)
  if (!listRun.ok && (listRun.spawnError !== null || listRun.timedOut)) {
    throw failureOf(listRun, HUNK_ERROR.listFailed, 'hunk session list')
  }
  const matched = listRun.ok ? matchSession(readSessions(parseJson(listRun.stdout)), cwd) : undefined
  if (matched === undefined) {
    return empty(HUNK_ERROR.noSession, 'no live Hunk session for this repository')
  }

  const run = await runHunkCli(
    ['session', 'review', '--repo', '.', '--json', '--include-notes', '--include-patch'],
    cwd,
    options,
  )
  if (!run.ok) {
    // A broken installation or an aborted run is a route-level error; anything
    // else (the window closed between the two reads, say) stays a soft failure.
    if (run.spawnError !== null || run.timedOut) {
      throw failureOf(run, HUNK_ERROR.reviewFailed, 'hunk session review --include-patch')
    }
    return empty(HUNK_ERROR.noSession, brief(run.stderr) || 'hunk session review --include-patch failed')
  }
  const review = readReview(parseJson(run.stdout))
  if (review === undefined) {
    return empty(
      HUNK_ERROR.badJson,
      `hunk session review --include-patch returned no readable review (${brief(run.stdout, 200)})`,
    )
  }
  const patches: Record<string, string> = {}
  const missing: string[] = []
  for (const file of review.files) {
    if (typeof file.patch === 'string' && file.patch !== '') patches[file.path] = file.patch
    else missing.push(file.path)
  }
  return { ...base, patches, missing, error: null }
}

/**
 * Read every file's raw diff text for one session cwd.
 *
 * On demand, not on every refresh: expanding a hunk is what needs diff text, and
 * the review command reconstructs one patch per file. Concurrent callers share
 * one run, and a short TTL keeps a burst of expansions (or a second tab) from
 * spawning the CLI again.
 * @param cwdInput - raw `cwd` query parameter (absolute path).
 * @param options - executable and timeout; defaults to the plugin's.
 * @returns the path → patch map, plus the files that shipped none.
 * @throws {HunkRouteError} on a bad cwd or an unusable Hunk installation.
 */
export async function collectHunkPatches(
  cwdInput: string | null | undefined,
  options: HunkCliOptions = DEFAULT_HUNK_CLI_OPTIONS,
): Promise<HunkPatchesPayload> {
  const cwd = await resolveRequestCwd(cwdInput)
  const key = locationKey(cwd)
  const cached = patchCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < PATCH_CACHE_TTL_MS) return cached.payload
  const running = patchInFlight.get(key)
  if (running !== undefined) return running

  const task = readPatches(cwd, options)
    .then((payload) => {
      patchCache.set(key, { at: Date.now(), payload })
      return payload
    })
    .finally(() => {
      patchInFlight.delete(key)
    })
  patchInFlight.set(key, task)
  return task
}
