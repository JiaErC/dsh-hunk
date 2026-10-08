/**
 * dsh-hunk host half.
 *
 * Mounts one read-only route on the DSH webserver that reads the live Hunk
 * review session for a session cwd and hands the JSON to the browser tab
 * registered by this plugin's client half.
 *
 * Design notes:
 * - The route runs the `hunk` CLI the user already has; nothing is written to
 *   the Hunk session (v1 is read-only by construction, not by convention).
 * - The cwd comes from the browser (the tab resolves it from the session
 *   scope) and is validated as an existing absolute directory before it is
 *   used as a child-process cwd. It is never interpolated into a command
 *   line: the argv is fixed.
 * - The route owns its own browser-trust fence, like every DSH webserver
 *   route (see ./host/trust-fence.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_HUNK_CLI_OPTIONS,
  HunkRouteError,
  collectHunkPatches,
  collectHunkState,
  type HunkCliOptions,
} from './host/hunk-cli'
import { isTrustedRequest } from './host/trust-fence'
import { reloadReviewInput, isReloadTarget } from './host/reload'
import { startHunkWatch, type WatchStartOptions } from './host/watch-start'
import {
  HUNK_ERROR,
  HUNK_PATCH_PARAM,
  HUNK_RELOAD_PATH,
  HUNK_STATE_PATH,
  HUNK_WATCH_PATH,
  type HunkErrorPayload,
} from './shared/wire'

/** The host service this plugin needs before it can mount anything. */
export const inject = ['webServer']

/** The webserver face this plugin uses (structural — the plugin declares no DSH package dependency). */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The web runtime face used for the fence's trusted authorities, when the deployment has it. */
interface WebRuntimeLike {
  trustedHosts?: readonly string[]
}

/** Extra host context faces this plugin reads. */
interface HostContext {
  webServer: WebServerLike
}

/** Non-loopback authorities this deployment serves (absent service = loopback only). */
function trustedHostsOf(ctx: Context): readonly string[] {
  const runtime = ctx.get('webRuntime') as WebRuntimeLike | undefined
  const hosts = runtime?.trustedHosts
  return Array.isArray(hosts) ? hosts : []
}

/** Write one JSON response (`HEAD` keeps the headers and drops the body). */
function sendJson(res: ServerResponse, status: number, body: unknown, method: string): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(method === 'HEAD' ? undefined : payload)
}

/** The failure envelope for one route-level error. */
function errorBody(code: HunkErrorPayload['error']['code'], message: string): HunkErrorPayload {
  return { ok: false, error: { code, message } }
}

/** What one route registration closes over. */
interface RouteDeps {
  /** Non-loopback authorities this deployment serves; read per request. */
  trustedHosts: () => readonly string[]
  /** Executable and timeout for the Hunk CLI. */
  cli: HunkCliOptions
  /** Automatic window opening, and its seams (see ./host/watch-start.ts). */
  watch: WatchStartOptions
}

/** Largest watch request body accepted, so a stray client cannot park memory here. */
const MAX_WATCH_BODY_BYTES = 4096

/** Read a small JSON request body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_WATCH_BODY_BYTES) {
        rejectBody(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        rejectBody(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', rejectBody)
  })
}

/**
 * Handle one watch call: fence, read the cwd, open a window unless it is already
 * there.
 *
 * POST only. This is the one route that starts something, and a GET that spawns
 * processes would be fired by every prefetcher and retry in the path.
 */
async function handleWatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'POST') {
    sendJson(res, 405, errorBody(HUNK_ERROR.methodNotAllowed, `${method} is not allowed on ${HUNK_WATCH_PATH}`), method)
    return
  }
  if (!isTrustedRequest(req, deps.trustedHosts())) {
    sendJson(res, 403, errorBody(HUNK_ERROR.forbidden, 'this route only answers same-origin requests to this host'), method)
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorBody(HUNK_ERROR.missingCwd, `unusable request body: ${error instanceof Error ? error.message : String(error)}`), method)
    return
  }
  const cwd = typeof body === 'object' && body !== null ? (body as { cwd?: unknown }).cwd : undefined
  // An explicit click may skip the cooldowns: the user asking for a window is a
  // decision the host should not argue with (the safety rules still apply).
  const force = typeof body === 'object' && body !== null && (body as { force?: unknown }).force === true

  try {
    sendJson(res, 200, await startHunkWatch(
      typeof cwd === 'string' ? cwd : null,
      force ? { ...deps.watch, force: true } : deps.watch,
    ), method)
  } catch (error) {
    if (error instanceof HunkRouteError) {
      sendJson(res, error.status, errorBody(error.code, error.message), method)
      return
    }
    console.error('[dsh-hunk] watch route failed:', error)
    sendJson(
      res,
      500,
      errorBody(HUNK_ERROR.internal, error instanceof Error ? error.message : String(error)),
      method,
    )
  }
}

/**
 * Handle one reload call: fence, read the cwd and the target, steer the window.
 *
 * POST only, and only ever reached because someone clicked: it replaces what
 * their Hunk window is showing.
 */
async function handleReload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'POST') {
    sendJson(res, 405, errorBody(HUNK_ERROR.methodNotAllowed, `${method} is not allowed on ${HUNK_RELOAD_PATH}`), method)
    return
  }
  if (!isTrustedRequest(req, deps.trustedHosts())) {
    sendJson(res, 403, errorBody(HUNK_ERROR.forbidden, 'this route only answers same-origin requests to this host'), method)
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorBody(HUNK_ERROR.missingCwd, `unusable request body: ${error instanceof Error ? error.message : String(error)}`), method)
    return
  }
  const record = typeof body === 'object' && body !== null ? body as { cwd?: unknown; target?: unknown } : {}
  if (!isReloadTarget(record.target)) {
    // The target reaches argv, so an unknown one is refused rather than forwarded.
    sendJson(res, 400, errorBody(HUNK_ERROR.badCwd, 'target must be "working-tree" or "last-commit"'), method)
    return
  }

  try {
    sendJson(res, 200, await reloadReviewInput(
      typeof record.cwd === 'string' ? record.cwd : null,
      record.target,
      deps.cli,
    ), method)
  } catch (error) {
    if (error instanceof HunkRouteError) {
      sendJson(res, error.status, errorBody(error.code, error.message), method)
      return
    }
    console.error('[dsh-hunk] reload route failed:', error)
    sendJson(
      res,
      500,
      errorBody(HUNK_ERROR.internal, error instanceof Error ? error.message : String(error)),
      method,
    )
  }
}

/**
 * Handle one read: fence, parse the query, run the Hunk commands, answer.
 *
 * Two reads share this path: the structural state (default) and the on-demand
 * patch map (`?patches=1`), which is what lets a hunk expand into its diff text
 * without paying for every patch on every refresh.
 */
async function handleState(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, errorBody(HUNK_ERROR.methodNotAllowed, `${method} is not allowed on ${HUNK_STATE_PATH}`), method)
    return
  }
  if (!isTrustedRequest(req, deps.trustedHosts())) {
    sendJson(res, 403, errorBody(HUNK_ERROR.forbidden, 'this route only answers same-origin requests to this host'), method)
    return
  }

  let params: URLSearchParams
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    sendJson(res, 400, errorBody(HUNK_ERROR.missingCwd, 'unparsable request URL'), method)
    return
  }
  const cwd = params.get('cwd')
  const wantsPatches = params.get(HUNK_PATCH_PARAM)
  const patches = wantsPatches === '1' || wantsPatches === 'true'

  try {
    const payload = patches
      ? await collectHunkPatches(cwd, deps.cli)
      : await collectHunkState(cwd, deps.cli)
    sendJson(res, 200, payload, method)
  } catch (error) {
    if (error instanceof HunkRouteError) {
      sendJson(res, error.status, errorBody(error.code, error.message), method)
      return
    }
    console.error('[dsh-hunk] state route failed:', error)
    sendJson(
      res,
      500,
      errorBody(HUNK_ERROR.internal, error instanceof Error ? error.message : String(error)),
      method,
    )
  }
}

/**
 * Host plugin body.
 * @param ctx - the host cordis context (its `webServer` service is ready).
 */
export function apply(ctx: Context & HostContext): void {
  // `hunk` resolves through PATH; the overrides help a non-PATH install and a
  // deployment whose CLI is slower than the default budget.
  const configuredBin = process.env.DSH_HUNK_BIN?.trim()
  const configuredTimeout = Number(process.env.DSH_HUNK_TIMEOUT_MS)
  const autostartOff = process.env.DSH_HUNK_AUTOSTART?.trim() === '0'
  const cli: HunkCliOptions = {
    bin: configuredBin !== undefined && configuredBin !== '' ? configuredBin : DEFAULT_HUNK_CLI_OPTIONS.bin,
    timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_HUNK_CLI_OPTIONS.timeoutMs,
  }
  const watch: WatchStartOptions = { ...cli, autostart: !autostartOff }

  const routeDeps = { trustedHosts: () => trustedHostsOf(ctx), cli, watch }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: HUNK_STATE_PATH,
      handler: (req, res) => handleState(req, res, routeDeps),
    }),
    `dsh-hunk: ${HUNK_STATE_PATH}`,
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: HUNK_WATCH_PATH,
      handler: (req, res) => handleWatch(req, res, routeDeps),
    }),
    `dsh-hunk: ${HUNK_WATCH_PATH}`,
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: HUNK_RELOAD_PATH,
      handler: (req, res) => handleReload(req, res, routeDeps),
    }),
    `dsh-hunk: ${HUNK_RELOAD_PATH}`,
  )
  console.log(
    `[dsh-hunk] mounted ${HUNK_STATE_PATH}, ${HUNK_WATCH_PATH} and ${HUNK_RELOAD_PATH} `
    + `(hunk bin: ${cli.bin}; automatic window opening: ${autostartOff ? 'off' : 'on'})`,
  )
}

/*
 * Reuse and test surface: the same read the route performs, plus the pure
 * helpers behind it. `test/host.test.mjs` drives these against the real Hunk
 * CLI and against recorded payloads, which is why they are exported from the
 * plugin entry rather than kept private to the route.
 */
export {
  DEFAULT_HUNK_CLI_OPTIONS,
  HUNK_PATCH_COMMAND,
  HunkRouteError,
  clearPatchCache,
  collectHunkPatches,
  collectHunkState,
  locationKey,
  matchSession,
  parseJson,
  readReview,
  readSessions,
  resolveRequestCwd,
  runHunkCli,
} from './host/hunk-cli'
export { isLoopbackHostname, isTrustedRequest } from './host/trust-fence'
export {
  buildWatchCommand,
  clearWatchRegistry,
  isHunkProcess,
  psSingleQuote,
  startHunkWatch,
} from './host/watch-start'
export { isReloadTarget, reloadArgvFor, reloadReviewInput } from './host/reload'
export type { ReloadOptions } from './host/reload'
export type { LaunchPlan, LaunchResult, WatchStartOptions } from './host/watch-start'
export { fileNotes, groupNotes, hunkOfNote, overlaps, pathKey } from './shared/notes'
export {
  LANGUAGE_EXTENSIONS,
  LANGUAGE_FILENAMES,
  TOKEN_FALLBACKS,
  languageForPath,
} from './shared/languages'
export type { HighlightToken, HighlightedLine } from './shared/languages'
export {
  hunkLineNumbers,
  notesForDisplay,
  parsePatchesPayload,
  patchLineKind,
  pickPatchHunk,
  placeNotes,
  splitPatchHunks,
  toSplitRows,
} from './shared/patch'
export type {
  NotePlacement,
  PatchHunk,
  PatchLineKind,
  PatchesReadResult,
  PlacedNotes,
  SplitCell,
  SplitRow,
} from './shared/patch'
export {
  HUNK_ERROR,
  HUNK_LIST_COMMAND,
  HUNK_PATCH_PARAM,
  HUNK_RELOAD_COMMANDS,
  HUNK_RELOAD_PATH,
  HUNK_REVIEW_COMMAND,
  HUNK_STATE_PATH,
  HUNK_WATCH_COMMAND,
  HUNK_WATCH_PATH,
} from './shared/wire'
export type {
  HunkErrorCode,
  HunkErrorPayload,
  HunkLineRange,
  HunkPatchesPayload,
  HunkReloadPayload,
  HunkReloadTarget,
  HunkReviewFile,
  HunkReviewHunk,
  HunkReviewNote,
  HunkReviewPayload,
  HunkRouteResponse,
  HunkSessionSummary,
  HunkStatePayload,
  HunkWatchAction,
  HunkWatchPayload,
} from './shared/wire'
