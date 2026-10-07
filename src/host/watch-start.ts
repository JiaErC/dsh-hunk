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
 * How long a freshly opened window is trusted to still be registering.
 *
 * A cold window needs 8–9 s on the development machine, so this is deliberately
 * generous. Inside it, a live pid with no session yet means "starting up";
 * outside it, the same pair means the window is up but useless — it lost its
 * registration when the daemon was replaced, which is the one failure a reader
 * cannot see in `hunk session list` (the window is simply absent from it).
 */
const STARTUP_GRACE_MS = 30_000

/**
 * How long a cwd waits before a *replacement* window may be opened.
 *
 * The report that started this: a window that had lost its registration kept the
 * plugin from opening a working one, so the review was unreachable for good.
 * Replacing is the fix, but replacing on every refresh would fill the screen with
 * consoles, so replacements are rate-limited per cwd.
 */
const REPLACE_COOLDOWN_MS = 5 * 60_000

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
  /** When this window replaced an earlier, unregistered one. */
  replacedAt?: number
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
  /** Process identity; defaults to resolving the pid's image name (pid reuse guard). */
  isOurWindow?: (pid: number) => Promise<boolean>
  /**
   * Skip the "wait your turn" rules (cooldown, a window we think is still good).
   *
   * Set by the tab's explicit button: the user asking for a window is a decision
   * this plugin should not argue with. The safety rules (git, platform, the
   * autostart switch, an existing live session) still apply.
   */
  force?: boolean
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

/**
 * Whether the process behind a pid is still the Hunk window we opened.
 *
 * Windows reuses pids, and a reused pid looks exactly like a window that is
 * still running — the bug behind "有一个 Hunk 窗口在跑" shown next to "没有 live
 * 会话", with no way out. So the pid is resolved to an image name before it is
 * trusted.
 * @param pid - the pid recorded at launch time.
 * @returns true only when that pid is a Hunk process.
 */
export async function isHunkProcess(pid: number): Promise<boolean> {
  if (!pidAlive(pid)) return false
  return await new Promise<boolean>((resolveResult) => {
    let out = ''
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    try {
      const child = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.on('error', () => finish(false))
      child.on('close', () => {
        // `"hunk.exe","4242",...` on a hit, an INFO line on a miss.
        const name = /^"([^"]+)"/.exec(out.trim())?.[1]
        finish(name !== undefined && name.toLowerCase().startsWith('hunk'))
      })
      child.on('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
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
  extra: { sessionId?: string; pid?: number; replaced?: boolean; detail?: string } = {},
): HunkWatchPayload {
  return {
    ok: true,
    action,
    cwd,
    command,
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    ...(extra.pid === undefined ? {} : { pid: extra.pid }),
    ...(extra.replaced === undefined ? {} : { replaced: extra.replaced }),
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
  const isOurWindow = options.isOurWindow ?? isHunkProcess
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
  let replacing = false
  if (previous !== undefined && options.force !== true) {
    const age = now() - previous.startedAt
    // A pid that is alive but is not a Hunk process is a reused pid: the window
    // we opened is gone, whatever now answers to its number.
    const stillOurs = isAlive(previous.pid) && await isOurWindow(previous.pid)
    if (stillOurs && age <= STARTUP_GRACE_MS) {
      // Inside the grace period this is simply a window that is still starting.
      return answer('already-started', cwd, command, {
        pid: previous.pid,
        detail: `opened ${Math.round(age / 1000)} s ago and has not registered yet`,
      })
    }
    if (stillOurs) {
      // Up, older than any startup, and `session list` does not know it: it lost
      // its registration (a replaced daemon is the usual cause) and will never
      // answer a review again. Replace it — rate-limited.
      const sinceReplacement = previous.replacedAt === undefined ? undefined : now() - previous.replacedAt
      if (sinceReplacement !== undefined && sinceReplacement < REPLACE_COOLDOWN_MS) {
        return answer('stale', cwd, command, {
          pid: previous.pid,
          detail: `the window from ${Math.round(age / 1000)} s ago is not registered; a replacement was opened ${Math.round(sinceReplacement / 1000)} s ago`,
        })
      }
      replacing = true
    } else if (age < COOLDOWN_MS) {
      // It exited (or its pid was reused): respect a manual close for a while.
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

  const prior = launched.get(cwd)
  launchCount += 1
  launched.set(cwd, {
    pid: result.pid,
    startedAt: now(),
    // Remember when this cwd last got a replacement, so replacements stay
    // rate-limited across several window generations.
    ...(replacing ? { replacedAt: now() } : prior?.replacedAt === undefined ? {} : { replacedAt: prior.replacedAt }),
  })
  return answer(replacing ? 'stale' : 'started', cwd, command, {
    pid: result.pid,
    ...(replacing
      ? { replaced: true, detail: 'the earlier window had lost its registration; this one is fresh' }
      : {}),
  })
}
