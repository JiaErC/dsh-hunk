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
import { HUNK_ERROR, HUNK_PATCH_PARAM, HUNK_STATE_PATH, type HunkErrorPayload } from './shared/wire'

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
  const cli: HunkCliOptions = {
    bin: configuredBin !== undefined && configuredBin !== '' ? configuredBin : DEFAULT_HUNK_CLI_OPTIONS.bin,
    timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_HUNK_CLI_OPTIONS.timeoutMs,
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: HUNK_STATE_PATH,
      handler: (req, res) => handleState(req, res, { trustedHosts: () => trustedHostsOf(ctx), cli }),
    }),
    `dsh-hunk: ${HUNK_STATE_PATH}`,
  )
  console.log(`[dsh-hunk] mounted ${HUNK_STATE_PATH} (hunk bin: ${cli.bin})`)
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
export { groupNotes, hunkOfNote, overlaps, pathKey } from './shared/notes'
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
  HUNK_REVIEW_COMMAND,
  HUNK_STATE_PATH,
} from './shared/wire'
export type {
  HunkErrorCode,
  HunkErrorPayload,
  HunkLineRange,
  HunkPatchesPayload,
  HunkReviewFile,
  HunkReviewHunk,
  HunkReviewNote,
  HunkReviewPayload,
  HunkRouteResponse,
  HunkSessionSummary,
  HunkStatePayload,
} from './shared/wire'
