/**
 * Wire contract shared by both halves of dsh-hunk.
 *
 * The host route reads the live Hunk review session through the `hunk` CLI and
 * answers with the shapes below; the browser tab renders them. Both halves are
 * bundled separately (node vs browser), so this module must stay free of
 * `node:` imports and of any runtime dependency.
 *
 * Field names mirror the Hunk session CLI's own JSON (`hunk session list
 * --json`, `hunk session review --json --include-notes`) so the payloads can be
 * read side by side with the CLI output. Every field the host forwards is
 * optional-tolerant: a newer or older Hunk build that drops one field must not
 * break the page.
 */

/** Browser-facing route carrying one review snapshot. */
export const HUNK_STATE_PATH = '/dsh-hunk/state'

/**
 * Query parameter that switches the route from the structural read to the
 * patch read (`1` / `true`). Anything else keeps the structural read.
 */
export const HUNK_PATCH_PARAM = 'patches'

/** The list command, spelled once so the UI can show the user what ran. */
export const HUNK_LIST_COMMAND = 'hunk session list --json'

/**
 * The review command. Always run with the session cwd as the child process
 * cwd, which is what makes `--repo .` select that session.
 */
export const HUNK_REVIEW_COMMAND = 'hunk session review --repo . --json --include-notes'

/** Inclusive `[start, end]` line range on one side of the diff. */
export type HunkLineRange = [number, number]

/** One live Hunk window, as returned by `hunk session list --json`. */
export interface HunkSessionSummary {
  sessionId: string
  pid?: number
  /** Process cwd the window was launched in. */
  cwd?: string
  /** Repository root the window's selector resolves `.` to. */
  repoRoot?: string
  launchedAt?: string
  inputKind?: string
  title?: string
  sourceLabel?: string
  fileCount?: number
  /** Focus read from the window's live snapshot. */
  selectedFilePath?: string
  selectedHunkIndex?: number
  liveCommentCount?: number
  reviewNoteCount?: number
}

/** One hunk inside a reviewed file. */
export interface HunkReviewHunk {
  /** 0-based index in the file (the CLI's own numbering; `hunkNumber` is +1). */
  index: number
  header: string
  oldRange?: HunkLineRange
  newRange?: HunkLineRange
}

/** One reviewed file with its hunk structure. */
export interface HunkReviewFile {
  id: string
  path: string
  /** Set for a rename/copy; the pre-image path. */
  previousPath?: string
  additions: number
  deletions: number
  hunkCount: number
  hunks: HunkReviewHunk[]
  /**
   * Raw unified diff text for this file. Only the patch read
   * (`?patches=1`, which asks the CLI for `--include-patch`) carries it; the
   * structural tree read never does, so it stays undefined there.
   */
  patch?: string
}

/** One note attached to the review (`--include-notes`). */
export interface HunkReviewNote {
  noteId: string
  parentId?: string
  /** `user` = typed in the TUI, `agent` / `ai` = written by a tool. */
  source: string
  filePath: string
  hunkIndex?: number
  oldRange?: HunkLineRange
  newRange?: HunkLineRange
  body: string
  title?: string
  author?: string
  createdAt?: string
  updatedAt?: string
  editable?: boolean
}

/** The review object of `hunk session review --json`. */
export interface HunkReviewPayload {
  sessionId: string
  title: string
  sourceLabel: string
  cwd?: string
  repoRoot?: string
  inputKind?: string
  experimentalFeatures?: string[]
  /** The window's current focus. */
  selectedFilePath?: string
  selectedHunkIndex?: number
  showAgentNotes?: boolean
  liveCommentCount?: number
  reviewNoteCount?: number
  reviewNotes: HunkReviewNote[]
  files: HunkReviewFile[]
}

/** A successful state read. */
export interface HunkStatePayload {
  ok: true
  /** The cwd both commands ran in (absolute, resolved by the host). */
  cwd: string
  fetchedAt: string
  /** The commands that produced this payload, for display. */
  commands: { list: string; review: string }
  /** Every live Hunk window on this machine, newest first. */
  sessions: HunkSessionSummary[]
  /** The window whose cwd/repoRoot matches `cwd`; null when there is none. */
  matched: HunkSessionSummary | null
  /** Distinct repo roots of live windows that are NOT this cwd. */
  otherRepos: string[]
  /** The review, present only when a window matched and answered. */
  review: HunkReviewPayload | null
  /** Why the review is absent, when it is. */
  reviewError: { code: string; message: string } | null
  /**
   * Capabilities this host build offers. Absent from a host that predates them,
   * which is how the browser tells "this build cannot do that yet" from "that
   * call failed" — the two need different copy.
   */
  capabilities?: { patches?: boolean }
}

/**
 * A successful patch read (`?patches=1`).
 *
 * The tree view never needs diff text, so the diff is a second, on-demand read:
 * it makes the host run the review command once more with `--include-patch` and
 * hand back one string per file.
 */
export interface HunkPatchesPayload {
  ok: true
  cwd: string
  fetchedAt: string
  /** File path → that file's raw unified diff text. */
  patches: Record<string, string>
  /** Files the review listed without any patch text. */
  missing: string[]
  /** Why the map is empty, when it is. */
  error: { code: string; message: string } | null
}

/** A failed state read. */
export interface HunkErrorPayload {
  ok: false
  error: { code: string; message: string }
}

export type HunkRouteResponse = HunkStatePayload | HunkPatchesPayload | HunkErrorPayload

/** Error codes this route emits (the browser switches copy on them). */
export const HUNK_ERROR = {
  methodNotAllowed: 'method-not-allowed',
  forbidden: 'forbidden',
  badCwd: 'bad-cwd',
  missingCwd: 'missing-cwd',
  cliMissing: 'hunk-cli-missing',
  cliTimeout: 'hunk-cli-timeout',
  badJson: 'hunk-bad-json',
  listFailed: 'hunk-list-failed',
  reviewFailed: 'hunk-review-failed',
  noSession: 'no-live-session',
  internal: 'internal',
} as const

export type HunkErrorCode = (typeof HUNK_ERROR)[keyof typeof HUNK_ERROR]
