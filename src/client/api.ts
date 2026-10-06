/**
 * Browser-side data access for the Hunk review tab.
 *
 * One route, read two ways: the structural state (what the review contains) and,
 * on demand, the raw diff text per file. The cwd that route needs comes from
 * `./session-cwd`, straight off the client session list.
 */
import {
  HUNK_PATCH_PARAM,
  HUNK_STATE_PATH,
  HUNK_WATCH_PATH,
  type HunkRouteResponse,
  type HunkStatePayload,
  type HunkWatchPayload,
} from '../shared/wire'
import { parsePatchesPayload, type PatchesReadResult } from '../shared/patch'

/** One failed read, carrying the wire code so the view can explain itself. */
export class HunkClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HunkClientError'
    this.code = code
  }
}

/** Whether a rejection is our own abort rather than a real failure. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Message of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetch one JSON read from the host route.
 * @param url - route URL including its query.
 * @param signal - aborts the request.
 * @returns the success payload (both reads share the `ok: true` discriminant).
 * @throws {HunkClientError} on a transport failure or a route error envelope.
 */
async function requestRoute<T extends HunkRouteResponse>(
  url: string,
  signal?: AbortSignal,
  payload?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal,
    })
  } catch (error) {
    if (isAbort(error)) throw error
    throw new HunkClientError('network', messageOf(error))
  }
  let body: HunkRouteResponse | undefined
  try {
    body = await response.json() as HunkRouteResponse
  } catch {
    throw new HunkClientError('bad-response', `HTTP ${response.status}`)
  }
  if (body !== undefined && body.ok === false) throw new HunkClientError(body.error.code, body.error.message)
  if (!response.ok || body === undefined || body.ok !== true) {
    throw new HunkClientError('bad-response', `HTTP ${response.status}`)
  }
  return body as T
}

/**
 * Read one review snapshot from the host route (the structural read).
 * @param cwd - absolute session working directory (the CLI's own cwd).
 * @param signal - aborts the request.
 * @returns the state payload.
 * @throws {HunkClientError} on a transport failure or a route error envelope.
 */
export async function fetchHunkState(cwd: string, signal?: AbortSignal): Promise<HunkStatePayload> {
  return requestRoute<HunkStatePayload>(`${HUNK_STATE_PATH}?cwd=${encodeURIComponent(cwd)}`, signal)
}

/**
 * Read every file's raw diff text (the on-demand patch read).
 *
 * Called the first time a hunk is expanded or copied, then cached by the caller:
 * expanding a hunk is what needs diff text, and the host has to reconstruct one
 * patch per file to answer.
 * @param cwd - absolute session working directory.
 * @param signal - aborts the request.
 * @returns the path → patch map plus the files that shipped none.
 * @throws {HunkClientError} on a transport failure, a route error envelope, or
 *   a host build that answers this URL with something other than patch text
 *   (code `patch-read-unsupported`).
 */
export async function fetchHunkPatches(cwd: string, signal?: AbortSignal): Promise<PatchesReadResult> {
  const url = `${HUNK_STATE_PATH}?cwd=${encodeURIComponent(cwd)}&${HUNK_PATCH_PARAM}=1`
  const body = await requestRoute<HunkRouteResponse>(url, signal)
  const read = parsePatchesPayload(body)
  if (read === undefined) {
    // The host answered the structural payload: it predates the patch read.
    throw new HunkClientError('patch-read-unsupported', 'this host build does not answer the patch read')
  }
  return read
}

/**
 * Ask the host to open a Hunk review window for this cwd.
 *
 * A POST: this is the one call that starts something. The host decides whether a
 * window is needed at all (a live one, a git checkout, the switches), so the
 * answer is an action to render, not a boolean.
 * @param cwd - absolute session working directory.
 * @param signal - aborts the request.
 * @returns what the host did, or refused to do.
 * @throws {HunkClientError} on a transport failure, a route error envelope, or a
 *   host build that predates this route (code `watch-unsupported`).
 */
export async function requestHunkWatch(cwd: string, signal?: AbortSignal): Promise<HunkWatchPayload> {
  const body = await requestRoute<HunkRouteResponse>(HUNK_WATCH_PATH, signal, { cwd })
  if (!isWatchPayload(body)) {
    throw new HunkClientError('watch-unsupported', 'this host build does not answer the watch route')
  }
  return body
}

/** Whether a route answer is the watch payload rather than one of the reads. */
function isWatchPayload(body: HunkRouteResponse): body is HunkWatchPayload {
  const action = (body as { action?: unknown }).action
  return body.ok === true && typeof action === 'string' && typeof (body as { cwd?: unknown }).cwd === 'string'
}
