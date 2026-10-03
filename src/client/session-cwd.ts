/**
 * Where the tab's cwd comes from, natively.
 *
 * The host route takes an absolute cwd as its only input, and the client session
 * list is the authority for it: the same `sessions.list` snapshot every panel
 * reads. Nothing here reaches for a Harness Client package — the service is read
 * through `ctx.get` and typed structurally, exactly like the locale service.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** One session row as far as this plugin cares. */
interface SessionSummaryLike {
  readonly cwd?: string
}

/**
 * The client sessions service's list face.
 *
 * Structural on purpose: `@deepseek-ai/dsh-client-ui-session` owns the real
 * types, and a plugin must not require a Harness Client package.
 */
interface SessionsLike {
  readonly list: {
    subscribe(listener: () => void): () => void
    getSnapshot(): { readonly byId: Readonly<Record<string, SessionSummaryLike | undefined>> }
  }
}

/** The client sessions service, when the deployment has one. */
function sessionsOf(ctx: Context): SessionsLike | undefined {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  return sessions !== undefined && typeof sessions.list?.subscribe === 'function' ? sessions : undefined
}

/**
 * Read one session's working directory, live.
 *
 * Live, not captured: the summary list fills in as the shell loads the session,
 * so a tab body that mounts early sees the cwd appear without a reload.
 * @param ctx - client context.
 * @param sessionId - the session this tab belongs to.
 * @returns the absolute cwd, or undefined while the list has none for it.
 */
export function useSessionCwd(ctx: Context, sessionId: string): string | undefined {
  const sessions = sessionsOf(ctx)
  return useSyncExternalStore(
    useMemo(
      () => (sessions === undefined ? () => () => {} : (listener: () => void) => sessions.list.subscribe(listener)),
      [sessions],
    ),
    () => sessions?.list.getSnapshot().byId[sessionId]?.cwd,
  )
}
