/**
 * Opening the review window the tab needs.
 *
 * WHY A CONSOLE WINDOW, AND NOT A DETACHED CHILD
 *
 * `hunk diff --watch` refuses to run without an interactive output terminal —
 * verbatim, measured on hunk 1.4.2:
 *
 *     hunk: `--watch` requires an interactive output terminal.
 *     Remove `--watch` when redirecting or piping Hunk's output.
 *
 * with no session registered, so spawning it with `stdio: 'ignore'` (or piping
 * it) does not produce a review. A child has to be given a REAL console. On
 * Windows that means launching through a new console, which is what
 * `Start-Process` does; `cmd /c start` silently did nothing when spawned from a
 * console-less parent (measured: no process, no log, no session). The console is
 * visible to the user, which is a feature here: it is the review itself, and it
 * is where the notes this plugin writes show up.
 *
 * hunk has no headless substitute in this build: `hunk session` can only
 * inspect/control a session that some review command already created, and
 * `hunk diff` offers no `--serve`/`--browser` mode.
 *
 * The window takes a few seconds to register with the daemon (measured 8–9 s
 * cold on this machine, mostly hunk's own startup), so callers should expect
 * `started` and then keep re-reading the state route.
 */
import { spawn } from 'node:child_process'
import { resolveRequestCwd } from './hunk-cli'
import { runHunkCli, readSessions, parseJson, matchSession, DEFAULT_HUNK_CLI_OPTIONS, type HunkCliOptions } from './hunk-cli'
import {
  HUNK_WATCH_COMMAND,
  type HunkSessionSummary,
  type HunkWatchAction,
  type HunkWatchPayload,
} from '../shared/wire'

/** How long a launched window is given to answer before the child is abandoned. */
const LAUNCH_TIMEOUT_MS = 15_000

/**
 * How long a cwd is left alone after a window this plugin opened has exited.
 *
 * The user closing the window is a decision, not a fault: reopening it on the
 * next refresh would be a fight. After the cooldown a fresh attempt is allowed,
 * so a crashed window still heals by itself.
 */
const COOLDOWN_MS = 10 * 60_000

/** Hard ceiling on windows one host process opens, so a loop cannot fill the screen. */
const MAX_LAUNCHES = 8

/** One window this plugin opened. */
interface LaunchedWindow {
  pid: number
  startedAt: number
}

/** The plugin's memory of the windows it opened, per cwd key. */
const launched = new Map<string, LaunchedWindow>()
let launchCount = 0

/** Forget what was launched (tests; also a manual reset hook). */
export function clearWatchRegistry(): void {
  launched.clear()
  launchCount = 0
}

/** One launch instruction, assembled before anything is spawned. */
export interface LaunchPlan {
  /** The cwd the review window should open in. */
  cwd: string
  /** The Hunk executable. */
  bin: string
  /** Fixed argv — never built from request data. */
  args: readonly string[]
}

/** The outcome of one launch attempt. */
export type LaunchResult = { pid: number } | { failed: string }

/** Everything {@link startHunkWatch} needs, all injectable so tests spawn nothing. */
export interface WatchStartOptions {
  /** The Hunk executable; defaults to `hunk`. */
  bin?: string
  /** Per-command budget for the CLI probes; defaults to the plugin's. */
  timeoutMs?: number
  /** Whether automatic opening is allowed (`DSH_HUNK_AUTOSTART=0` turns it off). */
  autostart?: boolean
  /** Platform to plan for; defaults to this process's. */
  platform?: NodeJS.Platform
  /** Launcher; defaults to the Windows console launcher. */
  launch?: (plan: LaunchPlan) => Promise<LaunchResult>
  /** Live-window probe; defaults to `hunk session list --json`. */
  listSessions?: (cwd: string) => Promise<HunkSessionSummary[]>
  /** Git probe; defaults to `git rev-parse --show-toplevel`. */
  isRepo?: (cwd: string) => Promise<boolean>
  /** Process liveness; defaults to a `process.kill(pid, 0)` probe. */
  isAlive?: (pid: number) => boolean
  /** Clock, so a cooldown test needs no waiting. */
  now?: () => number
}

/** The command line a human can paste, with the cwd as its own step. */
export function buildWatchCommand(cwd: string, bin = 'hunk'): string {
  // The wire constant spells the command with `hunk`; a deployment that points
  // `DSH_HUNK_BIN` elsewhere gets its own binary in the copy the user pastes.
  const invocation = HUNK_WATCH_COMMAND.startsWith('hunk ')
    ? `${bin} ${HUNK_WATCH_COMMAND.slice('hunk '.length)}`
    : HUNK_WATCH_COMMAND
  return `cd "${cwd}" && ${invocation}`
}

/**
 * Quote one value for a single-quoted PowerShell literal.
 * @param value - raw text (a path, an argument).
 * @returns the literal's inner text, with `'` doubled.
 */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Launch one review window in a new console (Windows).
 *
 * `Start-Process -PassThru` is the mechanism that both hands the child a console
 * and reports its pid; the pid is what lets a later call see the window is still
 * there. PowerShell is present on every Windows, and the arguments are quoted as
 * PowerShell literals, never interpolated into a shell command line.
 * @param plan - the executable, argv, and cwd.
 * @param timeoutMs - how long to wait for the pid.
 * @returns the child pid, or why it could not be obtained.
 */
async function launchInNewConsole(plan: LaunchPlan, timeoutMs: number): Promise<LaunchResult> {
  const script = [
    `$p = Start-Process -FilePath ${psSingleQuote(plan.bin)}`,
    `-ArgumentList ${plan.args.map(psSingleQuote).join(',')}`,
    `-WorkingDirectory ${psSingleQuote(plan.cwd)}`,
    '-PassThru; $p.Id',
  ].join(' ')
  return await new Promise<LaunchResult>((resolveResult) => {
    let out = ''
    let settled = false
    const finish = (result: LaunchResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }
    const timer = setTimeout(() => {
      finish({ failed: `the launcher did not report a pid within ${timeoutMs} ms` })
    }, timeoutMs)
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        // The launcher itself stays invisible; the window it opens is Hunk's.
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      finish({ failed: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', (error) => { finish({ failed: error.message }) })
    child.on('close', (code) => {
      const pid = Number.parseInt(out.trim(), 10)
      if (Number.isInteger(pid) && pid > 0) finish({ pid })
      else finish({ failed: `the launcher exited with code ${String(code)} and no pid` })
    })
  })
}

/** Whether a process with this pid exists. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Ask git whether this directory is inside a work tree. */
async function gitWorkTree(cwd: string): Promise<boolean> {
  return await new Promise<boolean>((resolveResult) => {
    let out = ''
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    try {
      const child = spawn('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.on('error', () => { finish(false) })
      child.on('close', () => { finish(out.trim() !== '') })
    } catch {
      finish(false)
    }
  })
}

/** Read the live windows the normal way: through the Hunk CLI. */
async function liveSessions(cwd: string, options: HunkCliOptions): Promise<HunkSessionSummary[]> {
  const run = await runHunkCli(['session', 'list', '--json'], cwd, options)
  if (!run.ok) return []
  return readSessions(parseJson(run.stdout))
}

/** A payload with the fields every outcome shares. */
function answer(
  action: HunkWatchAction,
  cwd: string,
  command: string,
  extra: { sessionId?: string; pid?: number; detail?: string } = {},
): HunkWatchPayload {
  return {
    ok: true,
    action,
    cwd,
    command,
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    ...(extra.pid === undefined ? {} : { pid: extra.pid }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
  }
}

/**
 * Open a Hunk review window for one cwd, unless it is unnecessary or unwise.
 *
 * Order matters: the cheapest and least surprising checks come first, so a tab
 * that asks repeatedly costs a `session list` and nothing else, and a window is
 * opened exactly once per repository until it goes away.
 * @param cwdInput - raw cwd from the request (absolute path).
 * @param options - seams and configuration; see {@link WatchStartOptions}.
 * @returns what happened, as copy the tab can render.
 * @throws {HunkRouteError} when the cwd is missing, malformed, or not a directory.
 */
export async function startHunkWatch(
  cwdInput: string | null | undefined,
  options: WatchStartOptions = {},
): Promise<HunkWatchPayload> {
  const cwd = await resolveRequestCwd(cwdInput)
  const cli: HunkCliOptions = {
    bin: options.bin ?? DEFAULT_HUNK_CLI_OPTIONS.bin,
    timeoutMs: options.timeoutMs ?? DEFAULT_HUNK_CLI_OPTIONS.timeoutMs,
  }
  const command = buildWatchCommand(cwd, cli.bin)
  const platform = options.platform ?? process.platform
  const now = options.now ?? (() => Date.now())
  const isAlive = options.isAlive ?? pidAlive
  const isRepo = options.isRepo ?? gitWorkTree
  const listSessions = options.listSessions ?? ((dir: string) => liveSessions(dir, cli))

  if (options.autostart === false) {
    return answer('disabled', cwd, command, { detail: 'DSH_HUNK_AUTOSTART=0' })
  }
  if (platform !== 'win32') {
    // Every other platform needs a terminal emulator we cannot assume; say so and
    // hand over the command instead of guessing.
    return answer('unsupported', cwd, command, { detail: `no console launcher for ${platform}` })
  }
  if (!await isRepo(cwd)) {
    return answer('not-a-repo', cwd, command)
  }

  // A window the user already has is the best answer: nothing to start.
  const matched = matchSession(await listSessions(cwd), cwd)
  if (matched !== undefined) {
    return answer('already-live', cwd, command, { sessionId: matched.sessionId })
  }

  const previous = launched.get(cwd)
  if (previous !== undefined) {
    if (isAlive(previous.pid)) return answer('already-started', cwd, command, { pid: previous.pid })
    const age = now() - previous.startedAt
    if (age < COOLDOWN_MS) {
      return answer('cooldown', cwd, command, {
        pid: previous.pid,
        detail: `the window opened ${Math.round(age / 1000)} s ago has exited; not reopening yet`,
      })
    }
  }

  if (launchCount >= MAX_LAUNCHES) {
    return answer('failed', cwd, command, { detail: `this host process already opened ${MAX_LAUNCHES} windows` })
  }

  const plan: LaunchPlan = { cwd, bin: cli.bin, args: ['diff', '--watch'] }
  const launch = options.launch ?? ((p: LaunchPlan) => launchInNewConsole(p, options.timeoutMs ?? LAUNCH_TIMEOUT_MS))
  let result: LaunchResult
  try {
    result = await launch(plan)
  } catch (error) {
    result = { failed: error instanceof Error ? error.message : String(error) }
  }
  if ('failed' in result) {
    console.error('[dsh-hunk] could not open a Hunk window:', result.failed)
    return answer('failed', cwd, command, { detail: result.failed })
  }

  launchCount += 1
  launched.set(cwd, { pid: result.pid, startedAt: now() })
  return answer('started', cwd, command, { pid: result.pid })
}
