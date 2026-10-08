/**
 * Telling the live review window what to read.
 *
 * A Hunk window holds exactly one review input. `hunk session review` — the read
 * this plugin's tab is built on — answers with whatever that input holds, which
 * is why a "0 files" tab can mean two very different things: the working tree is
 * genuinely clean, or the window is reading something else. The second case is
 * the common one for agent work, because an agent commits what it did: after a
 * round the tree is clean and the interesting diff is the commit.
 *
 * `hunk session reload` is the one command that changes what the window shows
 * (measured: `-- show HEAD` switches the publication to that commit's diff, and
 * the very next `session review` reports the commit's files). It is a WRITE to
 * the user's session — it replaces what they are looking at — so this plugin
 * only ever runs it because someone clicked a button that says so.
 *
 * The input is an enum, never a revision string from the caller: these values
 * become argv.
 */
import { runHunkCli, readSessions, parseJson, matchSession, resolveRequestCwd, DEFAULT_HUNK_CLI_OPTIONS, type HunkCliOptions } from './hunk-cli'
import {
  HUNK_RELOAD_COMMANDS,
  type HunkReloadPayload,
  type HunkReloadTarget,
} from '../shared/wire'

/** The argv for one target, spelled next to the command text it mirrors. */
export function reloadArgvFor(target: HunkReloadTarget): string[] {
  return target === 'last-commit'
    ? ['session', 'reload', '--repo', '.', '--json', '--', 'show', 'HEAD']
    : ['session', 'reload', '--repo', '.', '--json', '--', 'diff']
}

/** Whether a value from the wire is one of the two targets. */
export function isReloadTarget(value: unknown): value is HunkReloadTarget {
  return value === 'working-tree' || value === 'last-commit'
}

/** Options for {@link reloadReviewInput}; all injectable so tests spawn nothing. */
export interface ReloadOptions {
  /** The Hunk executable; defaults to `hunk`. */
  bin?: string
  /** Per-command budget; defaults to the plugin's. */
  timeoutMs?: number
  /** Session probe; defaults to `hunk session list --json`. */
  listSessions?: (cwd: string) => Promise<ReturnType<typeof readSessions>>
  /** The CLI runner; defaults to the real one. */
  run?: typeof runHunkCli
}

/** Read the window's identity out of the reload answer, tolerantly. */
function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const result = (payload as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return undefined
  const sessionId = (result as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

/** Read the window's new title out of the reload answer, tolerantly. */
function titleOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const result = (payload as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return undefined
  const title = (result as { title?: unknown }).title
  return typeof title === 'string' && title !== '' ? title : undefined
}

/**
 * Ask the window for one cwd to read a different input.
 * @param cwdInput - raw cwd from the request (absolute path).
 * @param target - which input to read; validated by the caller's schema.
 * @param options - seams and configuration.
 * @returns what happened, as copy the tab can render.
 * @throws {HunkRouteError} when the cwd is missing, malformed, or not a directory.
 */
export async function reloadReviewInput(
  cwdInput: string | null | undefined,
  target: HunkReloadTarget,
  options: ReloadOptions = {},
): Promise<HunkReloadPayload> {
  const cwd = await resolveRequestCwd(cwdInput)
  const cli: HunkCliOptions = {
    bin: options.bin ?? DEFAULT_HUNK_CLI_OPTIONS.bin,
    timeoutMs: options.timeoutMs ?? DEFAULT_HUNK_CLI_OPTIONS.timeoutMs,
  }
  const command = HUNK_RELOAD_COMMANDS[target]
  const run = options.run ?? runHunkCli
  const listSessions = options.listSessions ?? (async (dir: string) => {
    const listed = await runHunkCli(['session', 'list', '--json'], dir, cli)
    return listed.ok ? readSessions(parseJson(listed.stdout)) : []
  })

  // Nothing to steer: the tab's empty state (and the watch route) own that story.
  const matched = matchSession(await listSessions(cwd), cwd)
  if (matched === undefined) {
    return { ok: true, action: 'no-live-session', cwd, target, command }
  }

  const result = await run(reloadArgvFor(target), cwd, cli)
  if (!result.ok) {
    const detail = result.timedOut
      ? `hunk did not answer within ${cli.timeoutMs} ms`
      : (result.stderr.trim() !== '' ? result.stderr.trim() : `hunk exited with code ${String(result.code ?? '?')}`)
    console.error('[dsh-hunk] could not switch the review input:', detail)
    return { ok: true, action: 'failed', cwd, target, sessionId: matched.sessionId, command, detail }
  }

  const parsed = parseJson(result.stdout)
  const sessionId = sessionIdOf(parsed) ?? matched.sessionId
  const title = titleOf(parsed)
  return {
    ok: true,
    action: 'reloaded',
    cwd,
    target,
    sessionId,
    command,
    ...(title === undefined ? {} : { title }),
  }
}
