/**
 * Browser-side data access for the Hunk review tab.
 *
 * Two reads: the session cwd (from the tab scope, or from
 * better-sidebar's own `session.cwd` route when the scope does not carry it)
 * and this plugin's state route, which is what actually runs the Hunk CLI.
 */
import {
  HUNK_PATCH_PARAM,
  HUNK_STATE_PATH,
  type HunkRouteResponse,
  type HunkStatePayload,
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
 * Resolve the session working directory.
 *
 * The tab scope carries `cwd` whenever better-sidebar could read it from the
 * client session list; otherwise the sidebar's authoritative route answers.
 * @param scope - the tab's session scope.
 * @param signal - aborts the fallback request.
 * @returns the absolute cwd, or undefined when neither source has one.
 */
export async function resolveSessionCwd(
  scope: { sessionId: string; cwd?: string },
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (typeof scope.cwd === 'string' && scope.cwd !== '') return scope.cwd
  const response = await fetch('/sidebar/api/session.cwd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: scope.sessionId }),
    signal,
  })
  const body = await response.json() as { value?: { cwd?: string } }
  const cwd = body?.value?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
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
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal })
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
