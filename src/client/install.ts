/**
 * What the tab shows when Hunk is not installed — and the one-click way to get
 * the agent to install it.
 *
 * The install routes are the ones Hunk's own README documents; the prompt is
 * injected through DSH's own session API (`ctx.sessions.binding(id).session`),
 * which is the same channel the chat composer uses. Nothing here touches the
 * DOM, and nothing here is free-form: the text is a canned request, and the only
 * variable parts are the cwd and the host's own diagnostic line.
 */
import type { Context } from '@deepseek-ai/cordis'

/** One documented way to install Hunk. */
export interface InstallRoute {
  /** Stable id, so the view can key the row and the tests can name it. */
  readonly id: string
  /** Short label: the package manager or installer. */
  readonly label: string
  /** The exact command line. */
  readonly command: string
}

/**
 * The install routes Hunk documents, ordered per platform.
 * @param platform - `process.platform`-style name from the browser (best effort).
 * @returns the routes to offer, most appropriate first.
 */
export function installRoutes(platform: string): readonly InstallRoute[] {
  const npm = { id: 'npm', label: 'npm', command: 'npm i -g hunkdiff' }
  const mise = { id: 'mise', label: 'mise', command: 'mise use -g hunk' }
  if (platform === 'win32') {
    // Hunk's README calls out mise for Windows; npm needs Node 22+.
    return [npm, mise]
  }
  if (platform === 'darwin') {
    return [npm, { id: 'brew', label: 'Homebrew', command: 'brew install hunk' }, mise]
  }
  return [
    { id: 'script', label: 'install script', command: 'curl -fsSL https://hunk.dev/install.sh | sh' },
    npm,
    { id: 'brew', label: 'Homebrew', command: 'brew install hunk' },
    mise,
  ]
}

/**
 * The platform name to pick install routes with, best effort.
 *
 * `navigator.platform` is deprecated but universally present; the newer hint is
 * preferred when the browser offers it. Getting this wrong only reorders advice.
 * @returns `win32`, `darwin`, or `linux`.
 */
export function platformHint(): string {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & {
    userAgentData?: { platform?: string }
  }
  const raw = `${nav?.userAgentData?.platform ?? nav?.platform ?? ''}`.toLowerCase()
  if (raw.includes('win')) return 'win32'
  if (raw.includes('mac')) return 'darwin'
  return 'linux'
}

/** One text prompt as the session API wants it. */
type PromptPart = { readonly type: 'text'; readonly text: string }

/** The submission echo, when the service offers one. */
interface SubmissionHandleLike {
  readonly requestId: string
  abandon(): void
}

/** The outward session face, as far as this plugin uses it. */
interface SessionFaceLike {
  beginSubmission?(input: {
    readonly mode: 'queue' | 'steer'
    readonly text: string
    readonly attachments: readonly unknown[]
  }): SubmissionHandleLike
  prompt(
    content: readonly PromptPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<{ readonly ok: boolean; readonly error?: { readonly message?: string } }>
}

/** Structural face of the client sessions service (never a Harness Client import). */
interface SessionsLike {
  binding?(id: string): { readonly session?: SessionFaceLike } | undefined
}

/** Why an injection could not be made, or that it was. */
export type AskOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly message?: string }

/**
 * Put one prompt into a session, the way the chat composer does.
 *
 * `queue` and not `steer`: the request is "please do this next", never "stop what
 * you are doing". The submission echo is registered first when the service offers
 * it, so the message shows up in the transcript immediately rather than after a
 * round trip; if the prompt itself fails, the echo is retired so the chat does
 * not keep a message that was never sent.
 * @param ctx - client context carrying the sessions service.
 * @param sessionId - the session to ask.
 * @param text - the prompt text (built by the view, from the dictionaries).
 * @returns whether the session accepted it.
 */
export async function askAgentToInstall(ctx: Context, sessionId: string, text: string): Promise<AskOutcome> {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  if (sessions === undefined || typeof sessions.binding !== 'function') {
    return { ok: false, reason: 'no-sessions-service' }
  }
  const binding = sessions.binding(sessionId)
  const session = binding?.session
  if (session === undefined || typeof session.prompt !== 'function') {
    // The conversation view has not retained this session in this tab's process:
    // nothing to send through, and saying so beats a silent no-op.
    return { ok: false, reason: 'session-not-retained' }
  }

  let echo: SubmissionHandleLike | undefined
  if (typeof session.beginSubmission === 'function') {
    try {
      echo = session.beginSubmission({ mode: 'queue', text, attachments: [] })
    } catch (error) {
      // The echo is a courtesy; the prompt is the request.
      console.error('[dsh-hunk] could not register the submission echo:', error)
    }
  }

  try {
    const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, echo?.requestId)
    if (result.ok) return { ok: true }
    const message = result.error?.message
    echo?.abandon()
    return { ok: false, reason: 'rejected', ...(message === undefined ? {} : { message }) }
  } catch (error) {
    echo?.abandon()
    throw error
  }
}
