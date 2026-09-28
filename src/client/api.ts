/**
 * Browser-side data access for the Hunk review tab.
 *
 * Two reads: the session cwd (from the tab scope, or from
 * better-sidebar's own `session.cwd` route when the scope does not carry it)
 * and this plugin's state route, which is what actually runs the Hunk CLI.
 */
import { HUNK_STATE_PATH, type HunkRouteResponse, type HunkStatePayload } from '../shared/wire'

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
 * Read one review snapshot from the host route.
 * @param cwd - absolute session working directory (the CLI's own cwd).
 * @param signal - aborts the request.
 * @returns the state payload.
 * @throws {HunkClientError} on a transport failure or a route error envelope.
 */
export async function fetchHunkState(cwd: string, signal?: AbortSignal): Promise<HunkStatePayload> {
  const url = `${HUNK_STATE_PATH}?cwd=${encodeURIComponent(cwd)}`
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
  return body
}
