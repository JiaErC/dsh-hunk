/**
 * Host-half tests.
 *
 * Two layers:
 * - recorded payloads (the exact JSON shapes the Hunk CLI prints) exercise the
 *   parsing, matching, note-grouping and fence rules;
 * - one live case runs the real `hunk` CLI in this repository, so a Hunk
 *   upgrade that changes its JSON is caught here rather than in the browser.
 *
 * Run `npm test` (it rebuilds lib/ first, and the tests import the built host
 * bundle — the same artifact the profile loads).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_HUNK_CLI_OPTIONS,
  HUNK_ERROR,
  HUNK_PATCH_COMMAND,
  HunkRouteError,
  LANGUAGE_EXTENSIONS,
  TOKEN_FALLBACKS,
  buildWatchCommand,
  clearPatchCache,
  clearWatchRegistry,
  collectHunkPatches,
  collectHunkState,
  fileNotes,
  groupNotes,
  hunkLineNumbers,
  hunkOfNote,
  isLoopbackHostname,
  isTrustedRequest,
  isHunkProcess,
  languageForPath,
  psSingleQuote,
  startHunkWatch,
  locationKey,
  matchSession,
  notesForDisplay,
  parseJson,
  parsePatchesPayload,
  patchLineKind,
  pickPatchHunk,
  placeNotes,
  readReview,
  readSessions,
  resolveRequestCwd,
  runHunkCli,
  splitPatchHunks,
  toSplitRows,
} from '../lib/index.js'

/** `hunk session list --json`, trimmed to the fields the tab shows. */
const LIST_PAYLOAD = {
  sessions: [
    {
      sessionId: '11111111-1111-1111-1111-111111111111',
      pid: 4242,
      cwd: 'E:\\repo',
      repoRoot: 'E:/repo',
      launchedAt: '2026-09-27T19:33:11.468Z',
      inputKind: 'vcs',
      title: 'repo working tree',
      sourceLabel: 'E:/repo',
      experimentalFeatures: [],
      fileCount: 2,
      files: [],
      snapshot: {
        updatedAt: '2026-09-27T19:33:11.505Z',
        state: {
          selectedFileId: 'src/a.ts',
          selectedFilePath: 'src/a.ts',
          selectedHunkIndex: 1,
          showAgentNotes: false,
          liveCommentCount: 1,
          liveComments: [],
          reviewNoteCount: 3,
          reviewNotes: [],
        },
      },
    },
    {
      sessionId: '22222222-2222-2222-2222-222222222222',
      pid: 4343,
      cwd: 'E:\\other',
      repoRoot: 'E:/other',
      inputKind: 'vcs',
      title: 'other working tree',
      fileCount: 0,
      files: [],
      snapshot: { updatedAt: '2026-09-27T19:40:00.000Z', state: { selectedHunkIndex: 0 } },
    },
  ],
}

/** `hunk session review --json --include-notes`, trimmed to the same fields. */
const REVIEW_PAYLOAD = {
  review: {
    sessionId: '11111111-1111-1111-1111-111111111111',
    title: 'repo working tree',
    sourceLabel: 'E:/repo',
    cwd: 'E:\\repo',
    repoRoot: 'E:/repo',
    inputKind: 'vcs',
    experimentalFeatures: [],
    selectedFile: { path: 'src/a.ts' },
    selectedHunk: { index: 1, newRange: [11, 12] },
    showAgentNotes: false,
    liveCommentCount: 1,
    reviewNoteCount: 3,
    reviewNotes: [
      {
        noteId: 'agent:1',
        source: 'agent',
        filePath: 'src/a.ts',
        hunkIndex: 0,
        newRange: [3, 3],
        body: 'Tighten this.',
        author: 'hunk-review',
        createdAt: '2026-09-27T19:35:00.000Z',
      },
      {
        noteId: 'user:2',
        source: 'user',
        filePath: 'src/a.ts',
        oldRange: [10, 10],
        newRange: [11, 11],
        body: 'Why the extra hop?',
        createdAt: '2026-09-27T19:36:00.000Z',
      },
      { noteId: 'user:3', source: 'user', filePath: 'src/a.ts', body: 'File-level remark.' },
      { noteId: 'ai:4', source: 'ai', filePath: 'src/b.ts', hunkIndex: 0, body: 'Another file.' },
    ],
    files: [
      {
        id: 'src/a.ts',
        path: 'src/a.ts',
        additions: 4,
        deletions: 1,
        hunkCount: 2,
        hunks: [
          { index: 0, header: '@@ -1,2 +1,3 @@', oldRange: [1, 2], newRange: [1, 3] },
          { index: 1, header: '@@ -10,1 +11,2 @@', oldRange: [10, 10], newRange: [11, 12] },
        ],
      },
      {
        id: 'src/b.ts',
        path: 'src/b.ts',
        previousPath: 'src/old-b.ts',
        additions: 1,
        deletions: 0,
        hunkCount: 1,
        hunks: [{ index: 0, header: '@@ -0,0 +1,1 @@', newRange: [1, 1] }],
      },
    ],
  },
}

test('readSessions flattens the live snapshot onto each window', () => {
  const sessions = readSessions(LIST_PAYLOAD)
  assert.equal(sessions.length, 2)
  const [first, second] = sessions
  assert.equal(first.sessionId, '11111111-1111-1111-1111-111111111111')
  assert.equal(first.repoRoot, 'E:/repo')
  assert.equal(first.selectedFilePath, 'src/a.ts')
  assert.equal(first.selectedHunkIndex, 1)
  assert.equal(first.reviewNoteCount, 3)
  assert.equal(second.selectedFilePath, undefined)
  assert.equal(second.reviewNoteCount, undefined)
})

test('readSessions tolerates an empty or unknown payload', () => {
  assert.deepEqual(readSessions({ sessions: [] }), [])
  assert.deepEqual(readSessions({}), [])
  assert.deepEqual(readSessions(undefined), [])
})

test('readReview reads files, hunks and notes from the wrapped result', () => {
  const review = readReview(REVIEW_PAYLOAD)
  assert.ok(review)
  assert.equal(review.files.length, 2)
  assert.equal(review.files[1].previousPath, 'src/old-b.ts')
  assert.deepEqual(review.files[0].hunks[1].oldRange, [10, 10])
  assert.equal(review.files[0].hunks[1].header, '@@ -10,1 +11,2 @@')
  assert.equal(review.reviewNotes.length, 4)
  assert.equal(review.selectedFilePath, 'src/a.ts')
  assert.equal(review.selectedHunkIndex, 1)
})

test('readReview accepts an unwrapped review and rejects foreign payloads', () => {
  assert.ok(readReview(REVIEW_PAYLOAD.review))
  assert.equal(readReview({}), undefined)
  assert.equal(readReview(undefined), undefined)
})

test('matchSession compares Windows/POSIX spellings and case', () => {
  const sessions = readSessions(LIST_PAYLOAD)
  assert.equal(matchSession(sessions, 'E:\\repo')?.sessionId, sessions[0].sessionId)
  assert.equal(matchSession(sessions, 'E:/repo')?.sessionId, sessions[0].sessionId)
  assert.equal(matchSession(sessions, 'e:/REPO/')?.sessionId, sessions[0].sessionId)
  assert.equal(matchSession(sessions, 'E:/other')?.sessionId, sessions[1].sessionId)
  assert.equal(matchSession(sessions, 'E:/nope'), undefined)
  assert.equal(locationKey('E:\\repo\\'), locationKey('E:/repo'))
})

test('notes group onto their hunk, by index and by range', () => {
  const review = readReview(REVIEW_PAYLOAD)
  const fileA = review.files[0]
  const fileB = review.files[1]

  assert.equal(hunkOfNote(fileA, review.reviewNotes[0]).index, 0)
  // No hunkIndex, but oldRange [10,10] is inside hunk 1's oldRange [10,10].
  assert.equal(hunkOfNote(fileA, review.reviewNotes[1]).index, 1)
  // No anchor at all.
  assert.equal(hunkOfNote(fileA, review.reviewNotes[2]), undefined)

  const grouped = groupNotes(fileA, review.reviewNotes)
  assert.deepEqual(grouped.byHunk.get(0).map(note => note.noteId), ['agent:1'])
  assert.deepEqual(grouped.byHunk.get(1).map(note => note.noteId), ['user:2'])
  assert.deepEqual(grouped.loose.map(note => note.noteId), ['user:3'])
  // Notes of other files never leak into this file's buckets.
  assert.equal(groupNotes(fileB, review.reviewNotes).loose.length, 0)
  assert.deepEqual(groupNotes(fileB, review.reviewNotes).byHunk.get(0).map(note => note.noteId), ['ai:4'])
})

test('parseJson survives a leading warning line', () => {
  assert.deepEqual(parseJson('{"sessions":[]}'), { sessions: [] })
  assert.deepEqual(parseJson('warning: something\n{"sessions":[]}\n'), { sessions: [] })
  assert.equal(parseJson('not json at all'), undefined)
  assert.equal(parseJson(''), undefined)
})

test('resolveRequestCwd refuses a missing or non-directory cwd', async () => {
  await assert.rejects(
    () => resolveRequestCwd(''),
    (error) => error instanceof HunkRouteError && error.code === HUNK_ERROR.missingCwd && error.status === 400,
  )
  await assert.rejects(
    () => resolveRequestCwd('E:/definitely/not/here/at/all'),
    (error) => error instanceof HunkRouteError && error.code === HUNK_ERROR.badCwd,
  )
  const cwd = await resolveRequestCwd(process.cwd())
  assert.equal(locationKey(cwd), locationKey(process.cwd()))
})

test('the fence admits this machine only', () => {
  const allowed = { headers: { host: '127.0.0.1:3080' } }
  assert.equal(isTrustedRequest(allowed, []), true)
  assert.equal(isTrustedRequest({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } }, []), true)
  // The port is already bound by the Host header, so a differing port on the
  // same hostname stays trusted (Edge serializes loopback origins that way).
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1' } }, []), true)
  // Rebinding: the Host is not ours.
  assert.equal(isTrustedRequest({ headers: { host: 'evil.example.com' } }, []), false)
  // Cross-site browser markers and a mismatched Origin are refused.
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }, []), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'https://evil.example.com' } }, []), false)
  assert.equal(isTrustedRequest({ headers: {} }, []), false)
  // A deployment-trusted LAN authority passes only when declared.
  assert.equal(isTrustedRequest({ headers: { host: '192.168.1.5:3080' } }, []), false)
  assert.equal(isTrustedRequest({ headers: { host: '192.168.1.5:3080' } }, ['192.168.1.5:3080']), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.0.0.1.evil.com'), false)
})

test('toSplitRows pairs deletions with additions and numbers both sides', () => {
  // context, a 2-for-2 replacement, a pure addition, a pure deletion, a marker.
  const patch = {
    header: '@@ -10,4 +10,4 @@',
    lines: [
      ' const keep = 1',
      '-const a = 1',
      '-const b = 2',
      '+const a = 10',
      '+const b = 20',
      '+const c = 30',
      ' const tail = 4',
      '-gone',
    ],
    text: '',
  }
  const rows = toSplitRows(patch)

  // context first: same text on both sides, numbered from the header.
  assert.equal(rows[0].kind, 'context')
  assert.deepEqual(rows[0].left, { no: 10, text: 'const keep = 1' })
  assert.deepEqual(rows[0].right, { no: 10, text: 'const keep = 1' })

  // the replacement: deletion left, addition right, paired row by row.
  assert.deepEqual(rows[1], {
    kind: 'change',
    left: { no: 11, text: 'const a = 1' },
    right: { no: 11, text: 'const a = 10' },
  })
  assert.deepEqual(rows[2], {
    kind: 'change',
    left: { no: 12, text: 'const b = 2' },
    right: { no: 12, text: 'const b = 20' },
  })
  // the longer run's tail keeps one side empty — here an addition-only row.
  assert.deepEqual(rows[3], { kind: 'change', right: { no: 13, text: 'const c = 30' } })

  // context, then a deletion-only row.
  assert.equal(rows[4].kind, 'context')
  assert.deepEqual(rows[4].right, { no: 14, text: 'const tail = 4' })
  assert.deepEqual(rows[5], { kind: 'change', left: { no: 14, text: 'gone' } })
  assert.equal(rows.length, 6)
})

test('notesForDisplay keeps every note visible while the code is hidden', () => {
  const first = { noteId: 'a', source: 'agent', filePath: 'a.ts', body: 'a' }
  const second = { noteId: 'b', source: 'user', filePath: 'a.ts', body: 'b' }
  const notes = [first, second]
  const placed = { byRow: new Map([[1, [first]]]), unplaced: [second] }

  // File collapsed / hunk collapsed: nothing hangs under code, nothing is lost.
  const hidden = notesForDisplay({ codeShown: false, placed, notes })
  assert.equal(hidden.inline.size, 0)
  assert.deepEqual(hidden.below.map(note => note.noteId), ['a', 'b'])

  // Code on screen: the placeable note rides inline, the rest stays below.
  const shown = notesForDisplay({ codeShown: true, placed, notes })
  assert.deepEqual([...shown.inline.keys()], [1])
  assert.deepEqual(shown.below.map(note => note.noteId), ['b'])

  // Code on screen but no rows yet (patch still loading): still all visible.
  const loading = notesForDisplay({ codeShown: true, placed: undefined, notes })
  assert.equal(loading.inline.size, 0)
  assert.deepEqual(loading.below.map(note => note.noteId), ['a', 'b'])
})

test('toSplitRows keeps the no-newline marker full width and survives no header', () => {
  const patch = {
    header: '@@ -1 +1 @@',
    lines: ['-a', '+b', '\\ No newline at end of file'],
    text: '',
  }
  const rows = toSplitRows(patch)
  assert.deepEqual(rows[0], { kind: 'change', left: { no: 1, text: 'a' }, right: { no: 1, text: 'b' } })
  assert.deepEqual(rows[1], { kind: 'meta', text: '\\ No newline at end of file' })

  // No parsable header: numbering starts at 1 rather than throwing.
  const unnumbered = toSplitRows({ header: '@@ rewritten @@', lines: ['+x'], text: '' })
  assert.deepEqual(unnumbered, [{ kind: 'change', right: { no: 1, text: 'x' } }])
})

test('placeNotes hangs a note under the last line of the range it reviews', () => {
  const rows = toSplitRows({
    header: '@@ -10,3 +10,3 @@',
    lines: [' keep', '-old one', '+new one', ' tail'],
    text: '',
  })
  // rows: 0 context(old10/new10), 1 change(old11/new11), 2 context(old12/new12)
  const note = (id, range) => ({ noteId: id, source: 'agent', filePath: 'a.ts', body: id, ...range })

  const newSide = placeNotes(rows, [note('n1', { newRange: [11, 11] })])
  assert.deepEqual([...newSide.byRow.keys()], [1])
  assert.deepEqual(newSide.unplaced, [])

  // An old-side anchor lands on the deletion row.
  const oldSide = placeNotes(rows, [note('n2', { oldRange: [11, 11] })])
  assert.deepEqual([...oldSide.byRow.keys()], [1])

  // A range hangs under its LAST line, and both sides of a note prefer new.
  const range = placeNotes(rows, [note('n3', { oldRange: [10, 12], newRange: [10, 12] })])
  assert.deepEqual([...range.byRow.keys()], [2])

  // Two notes on one line share a bucket; an anchor outside the rows is kept.
  const mixed = placeNotes(rows, [
    note('n4', { newRange: [12, 12] }),
    note('n5', { newRange: [12, 12] }),
    note('n6', { newRange: [99, 99] }),
    note('n7', {}),
  ])
  assert.deepEqual(mixed.byRow.get(2).map(item => item.noteId), ['n4', 'n5'])
  assert.deepEqual(mixed.unplaced.map(item => item.noteId), ['n6', 'n7'])
})

test('fileNotes lists a file’s notes hunk by hunk, then the unanchored ones', () => {
  const review = readReview(REVIEW_PAYLOAD)
  const fileA = review.files[0]
  const grouped = groupNotes(fileA, review.reviewNotes)
  // agent:1 → hunk 0, user:2 → hunk 1 (by range), user:3 → loose.
  assert.deepEqual(fileNotes(fileA, grouped).map(note => note.noteId), ['agent:1', 'user:2', 'user:3'])
  // A file with no notes yields an empty list — the collapsed branch then draws
  // nothing extra under the file row.
  assert.deepEqual(fileNotes(review.files[1], groupNotes(review.files[1], [])), [])
})

test('parsePatchesPayload refuses a structural payload and normalizes a patch one', () => {
  // What a host build without the patch read answers this URL with.
  const structural = {
    ok: true,
    cwd: 'E:/repo',
    sessions: [],
    matched: null,
    otherRepos: [],
    review: null,
    reviewError: null,
  }
  assert.equal(parsePatchesPayload(structural), undefined)
  assert.equal(parsePatchesPayload(undefined), undefined)
  assert.equal(parsePatchesPayload('nope'), undefined)
  assert.equal(parsePatchesPayload({ patches: ['not', 'a', 'map'] }), undefined)

  // The real shape, including its soft-failure form.
  assert.deepEqual(parsePatchesPayload({ patches: { 'a.ts': '@@ -1 +1 @@\n-x\n+y\n' } }), {
    patches: { 'a.ts': '@@ -1 +1 @@\n-x\n+y\n' },
    missing: [],
    error: null,
  })
  assert.deepEqual(parsePatchesPayload({ patches: {}, missing: ['bin.png'], error: null }), {
    patches: {},
    missing: ['bin.png'],
    error: null,
  })
  assert.deepEqual(parsePatchesPayload({ patches: {}, error: { code: 'no-live-session', message: 'none' } }), {
    patches: {},
    missing: [],
    error: { code: 'no-live-session', message: 'none' },
  })
  // Gunk is dropped, never thrown: a newer host may add fields this build ignores.
  assert.deepEqual(parsePatchesPayload({ patches: { 'a.ts': 42, 'b.ts': 'text' }, missing: [1, 'c.ts'] }), {
    patches: { 'b.ts': 'text' },
    missing: ['c.ts'],
    error: null,
  })
})

/*
 * The watch route's decision logic. Every launch is injected: these tests prove
 * WHAT is decided and what would be spawned, without spawning anything — a test
 * suite that opens console windows is a test suite nobody runs twice.
 */

/** The seams a watch test needs, with the happy path as the default. */
function watchOptions({ pid = 4242, ...overrides } = {}) {
  const launches = []
  return {
    launches,
    options: {
      autostart: true,
      platform: 'win32',
      isRepo: async () => true,
      listSessions: async () => [],
      isAlive: () => false,
      // Injected, because the real probe resolves the pid's image name through
      // `tasklist`: a test that reached it would be asking about this machine's
      // process table.
      isOurWindow: async () => true,
      now: () => 1_000_000,
      launch: async (plan) => {
        launches.push(plan)
        return { pid }
      },
      ...overrides,
    },
  }
}

test('the watch command is the command a human can paste', () => {
  assert.equal(buildWatchCommand('E:\\repo'), 'cd "E:\\repo" && hunk diff --watch')
  // A deployment with its own binary gets its own binary in the copy.
  assert.equal(buildWatchCommand('E:\\repo', 'C:\\tools\\hunk.exe'), 'cd "E:\\repo" && C:\\tools\\hunk.exe diff --watch')
  // PowerShell literals: a quote is doubled, never escaped into a new command.
  assert.equal(psSingleQuote("E:\\it's here"), "'E:\\it''s here'")
})

test('a repository with no live window gets one, once', async () => {
  clearWatchRegistry()
  const { options, launches } = watchOptions()
  const first = await startHunkWatch(process.cwd(), options)
  assert.equal(first.ok, true)
  assert.equal(first.action, 'started')
  assert.equal(first.pid, 4242)
  assert.match(first.command, /hunk diff --watch/)
  assert.deepEqual(launches, [{ cwd: process.cwd(), bin: 'hunk', args: ['diff', '--watch'] }])

  // A second call seconds later must not open a second window: the window is
  // still inside its startup grace, so it is simply not registered YET.
  const alive = watchOptions({ isAlive: () => true, now: () => 1_010_000 })
  const second = await startHunkWatch(process.cwd(), alive.options)
  assert.equal(second.action, 'already-started')
  assert.equal(second.pid, 4242)
  assert.deepEqual(alive.launches, [])
})

test('a window that lost its registration is replaced instead of blocking the review', async () => {
  clearWatchRegistry()
  let clock = 1_000_000
  const first = watchOptions({ now: () => clock })
  assert.equal((await startHunkWatch(process.cwd(), first.options)).action, 'started')

  // The reported bug: the daemon was replaced, so the window we opened is up but
  // absent from `session list`. The pid is alive and is a Hunk process — and the
  // plugin used to answer "already-started" forever, leaving no way to review.
  clock += 60_000
  const stale = watchOptions({
    pid: 7777,
    now: () => clock,
    isAlive: () => true,
    listSessions: async () => [],
  })
  const replaced = await startHunkWatch(process.cwd(), stale.options)
  assert.equal(replaced.action, 'stale')
  assert.equal(replaced.replaced, true)
  assert.equal(replaced.pid, 7777)
  assert.equal(stale.launches.length, 1)

  // Racing refreshes must not open a console each: a replacement is rate-limited.
  clock += 60_000
  const racing = watchOptions({
    pid: 8888,
    now: () => clock,
    isAlive: () => true,
    listSessions: async () => [],
  })
  const held = await startHunkWatch(process.cwd(), racing.options)
  assert.equal(held.action, 'stale')
  assert.equal(held.replaced, undefined)
  assert.equal(held.pid, 7777)
  assert.deepEqual(racing.launches, [])
})

test('an explicit click skips the cooldowns the automatic attempt respects', async () => {
  clearWatchRegistry()
  let clock = 1_000_000
  const first = watchOptions({ now: () => clock })
  assert.equal((await startHunkWatch(process.cwd(), first.options)).action, 'started')

  // Inside the cooldown an automatic attempt is refused…
  clock += 60_000
  const closed = watchOptions({ now: () => clock, isAlive: () => false })
  assert.equal((await startHunkWatch(process.cwd(), closed.options)).action, 'cooldown')

  // …and the button still opens a window, because the user asked.
  const forced = watchOptions({ pid: 9999, now: () => clock, isAlive: () => false, force: true })
  const answer = await startHunkWatch(process.cwd(), forced.options)
  assert.equal(answer.action, 'started')
  assert.equal(answer.pid, 9999)
  assert.equal(forced.launches.length, 1)
})

test('a reused pid is not mistaken for the window we opened', async () => {
  clearWatchRegistry()
  let clock = 1_000_000
  const first = watchOptions({ now: () => clock })
  assert.equal((await startHunkWatch(process.cwd(), first.options)).action, 'started')

  // Alive, indistinguishable from our window by pid alone — but it is not Hunk.
  clock += 60_000
  const reused = watchOptions({
    pid: 5150,
    now: () => clock,
    isAlive: () => true,
    isOurWindow: async () => false,
  })
  const answer = await startHunkWatch(process.cwd(), reused.options)
  // Inside the "a window exited recently" cooldown, a reused pid does not get a
  // second window opened behind the user's back.
  assert.equal(answer.action, 'cooldown')
  assert.deepEqual(reused.launches, [])

  clock += 11 * 60_000
  const later = watchOptions({
    pid: 5150,
    now: () => clock,
    isAlive: () => true,
    isOurWindow: async () => false,
  })
  assert.equal((await startHunkWatch(process.cwd(), later.options)).action, 'started')
  assert.equal(later.launches.length, 1)
})

test('a live session, a non-repository, a disabled switch and another platform each skip the launch', async () => {
  clearWatchRegistry()
  const live = watchOptions({
    listSessions: async () => [{ sessionId: 's-1', cwd: process.cwd() }],
  })
  const liveAnswer = await startHunkWatch(process.cwd(), live.options)
  assert.equal(liveAnswer.action, 'already-live')
  assert.equal(liveAnswer.sessionId, 's-1')
  assert.deepEqual(live.launches, [])

  clearWatchRegistry()
  const notRepo = watchOptions({ isRepo: async () => false })
  assert.equal((await startHunkWatch(process.cwd(), notRepo.options)).action, 'not-a-repo')
  assert.deepEqual(notRepo.launches, [])

  clearWatchRegistry()
  const disabled = watchOptions({ autostart: false })
  const disabledAnswer = await startHunkWatch(process.cwd(), disabled.options)
  assert.equal(disabledAnswer.action, 'disabled')
  assert.equal(disabledAnswer.detail, 'DSH_HUNK_AUTOSTART=0')
  assert.deepEqual(disabled.launches, [])

  clearWatchRegistry()
  const alien = watchOptions({ platform: 'linux' })
  const alienAnswer = await startHunkWatch(process.cwd(), alien.options)
  assert.equal(alienAnswer.action, 'unsupported')
  assert.match(alienAnswer.detail, /linux/)
  assert.deepEqual(alien.launches, [])
})

test('a window that exited is not reopened inside the cooldown, and a failure is reported', async () => {
  clearWatchRegistry()
  let clock = 1_000_000
  const first = watchOptions({ now: () => clock })
  assert.equal((await startHunkWatch(process.cwd(), first.options)).action, 'started')

  // The user closed it a minute later: respect that instead of reopening.
  clock += 60_000
  const closed = watchOptions({ now: () => clock, isAlive: () => false })
  const cooldown = await startHunkWatch(process.cwd(), closed.options)
  assert.equal(cooldown.action, 'cooldown')
  assert.equal(cooldown.pid, 4242)
  assert.deepEqual(closed.launches, [])

  // Past the cooldown, a crashed window heals by itself.
  clock += 11 * 60_000
  const later = watchOptions({ now: () => clock, isAlive: () => false })
  assert.equal((await startHunkWatch(process.cwd(), later.options)).action, 'started')
  assert.equal(later.launches.length, 1)

  // A launcher that cannot report a pid is a failure with the reason attached.
  clearWatchRegistry()
  const broken = watchOptions({ launch: async () => ({ failed: 'no pid' }) })
  const failed = await startHunkWatch(process.cwd(), broken.options)
  assert.equal(failed.action, 'failed')
  assert.equal(failed.detail, 'no pid')
  assert.match(failed.command, /hunk diff --watch/)
})

test('the watch decision still validates the cwd', async () => {
  await assert.rejects(
    () => startHunkWatch(null, watchOptions().options),
    (error) => error instanceof HunkRouteError && error.code === HUNK_ERROR.missingCwd,
  )
  await assert.rejects(
    () => startHunkWatch(process.cwd() + '/no/such/dir', watchOptions().options),
    (error) => error instanceof HunkRouteError && error.code === HUNK_ERROR.badCwd,
  )
})

/** Whether a pid is still running (`kill 0` is the portable probe). */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The end-to-end lane for the feature that starts something.
 *
 * Opt-in (`DSH_HUNK_TEST_WATCH=1`) because it opens a real console window and
 * waits for hunk's own startup: it needs the installed CLI, a Git repository,
 * and about ten seconds. Everything else about the watch path is unit-tested
 * with injected seams; this is the lane that proves the seams match reality.
 */
test('live: the real launcher opens a window that registers', {
  skip: process.platform !== 'win32'
    ? 'the console launcher is Windows-only'
    : (process.env.DSH_HUNK_TEST_WATCH === '1' ? false : 'set DSH_HUNK_TEST_WATCH=1 to spawn a real window'),
}, async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-hunk-watch-'))
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'watch@example.com'])
  git(['config', 'user.name', 'watch'])
  await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  // Something to review, so the window has a changeset to show.
  await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf8')

  clearWatchRegistry()
  let pid
  t.after(async () => {
    // Close only the window we opened. The session daemon is shared — a real
    // Hunk window of the user's may be attached to it — so it is left alone (it
    // retires itself when idle).
    if (pid !== undefined) {
      try { process.kill(pid) } catch { /* already gone */ }
      for (let attempt = 0; attempt < 20 && processAlive(pid); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    // A window that just closed may still hold its cwd for a moment.
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch {
      // A leftover temp directory is not a test failure.
    }
  })

  const started = await startHunkWatch(repo, { autostart: true, timeoutMs: 30_000 })
  if (started.action === 'failed' && /hunk|ENOENT/i.test(started.detail ?? '')) {
    t.skip(`no usable Hunk CLI here: ${started.detail}`)
    return
  }
  assert.equal(started.action, 'started', `unexpected action: ${JSON.stringify(started)}`)
  pid = started.pid
  assert.ok(Number.isInteger(pid) && pid > 0, 'the launcher must report the window pid')

  // The window registers with the daemon a few seconds after it opens (hunk
  // starts its own daemon on the way), so poll rather than assume.
  let matched
  for (let attempt = 0; attempt < 20 && matched === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const listed = await runHunkCli(['session', 'list', '--json'], repo, { ...DEFAULT_HUNK_CLI_OPTIONS, timeoutMs: 30_000 })
    matched = matchSession(readSessions(parseJson(listed.stdout)), repo)
  }
  assert.ok(matched !== undefined, 'the window we opened never registered a session')
  assert.equal(matched.cwd !== undefined || matched.repoRoot !== undefined, true)

  // And the session is reviewable, which is the whole point of opening it.
  const review = await runHunkCli(
    ['session', 'review', '--repo', '.', '--json', '--include-notes'],
    repo,
    { ...DEFAULT_HUNK_CLI_OPTIONS, timeoutMs: 30_000 },
  )
  assert.equal(review.ok, true)
  assert.ok(readReview(parseJson(review.stdout)) !== undefined)
})

test('no window for the repository means no review read, and no error either', async (t) => {
  // Reported from a real session: with no live window, the review command was
  // still run and its failure — `hunk: protocol-validation-failed`, which is how
  // this Hunk build spells "your selector matched nothing" — was printed in the
  // tab as if something had gone wrong.
  const repo = await mkdtemp(join(tmpdir(), 'dsh-hunk-nowindow-'))
  t.after(() => { rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'no-window@example.com'])
  git(['config', 'user.name', 'no-window'])
  await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf8')

  let state
  try {
    state = await collectHunkState(repo, { bin: 'hunk', timeoutMs: 20_000 })
  } catch (error) {
    if (error instanceof HunkRouteError && error.code === HUNK_ERROR.cliMissing) {
      t.skip('no Hunk CLI here')
      return
    }
    throw error
  }

  assert.equal(state.matched, null)
  assert.equal(state.review, null)
  // The point of the fix: no hunk-internal string reaches the tab.
  assert.equal(state.reviewError, null)
  assert.ok(state.sessions.every(session => locationKey(session.cwd ?? '') !== locationKey(repo)))
})

test('a session launched in a subdirectory still matches its repository', () => {
  const sessions = [{ sessionId: 's-1', cwd: 'E:\\repo', repoRoot: 'E:/repo' }]
  assert.equal(matchSession(sessions, 'E:\\repo')?.sessionId, 's-1')
  assert.equal(matchSession(sessions, 'E:\\repo\\src\\deep')?.sessionId, 's-1')
  // Case and separators are the platform's business; a sibling directory is not
  // inside the repository and must not match.
  assert.equal(matchSession(sessions, 'E:\\repo-other'), undefined)
  assert.equal(matchSession(sessions, 'E:\\elsewhere'), undefined)
})

test('the pid identity probe separates a Hunk window from a reused pid', async (t) => {
  // The real probe, against this machine's process table: our own node process is
  // not Hunk, and any running Hunk process is.
  assert.equal(await isHunkProcess(process.pid), false)
  assert.equal(await isHunkProcess(2 ** 30), false, 'a pid that cannot exist')

  const listed = spawnSync('tasklist', ['/FI', 'IMAGENAME eq hunk.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  const pid = /^"[^"]+","(\d+)"/.exec(listed.stdout.trim())?.[1]
  if (pid === undefined) {
    t.skip('no Hunk process is running on this machine right now')
    return
  }
  assert.equal(await isHunkProcess(Number(pid)), true)
})

test('languageForPath maps the bundled grammars and refuses everything else', () => {
  assert.equal(languageForPath('src/a.ts'), 'typescript')
  assert.equal(languageForPath('src/a.tsx'), 'tsx')
  // shiki ships JSX inside the `tsx` bundle, so .jsx is claimed by the same grammar.
  assert.equal(languageForPath('a/b/c.jsx'), 'tsx')
  assert.equal(languageForPath('Dockerfile'), 'dockerfile')
  assert.equal(languageForPath('scripts/Makefile'), 'make')
  assert.equal(languageForPath('a.MD'), 'markdown')
  assert.equal(languageForPath('a.b.json'), 'json')
  // No extension, a dotfile, an unknown suffix, and a prototype key: plain text.
  assert.equal(languageForPath('README'), undefined)
  assert.equal(languageForPath('.gitignore'), undefined)
  assert.equal(languageForPath('a.txt'), undefined)
  assert.equal(languageForPath('a.constructor'), undefined)
  assert.equal(languageForPath('a.'), undefined)
  // The map is broad; the client test checks every id it names against the
  // grammars the browser bundle actually loads.
  assert.ok(Object.keys(LANGUAGE_EXTENSIONS).length > 30)
  assert.ok(TOKEN_FALLBACKS['token-keyword'].includes('--dsw-alias-'))
})

test('live: the state read advertises the patch capability', async (t) => {
  let state
  try {
    state = await collectHunkState(process.cwd(), { bin: 'hunk', timeoutMs: 20_000 })
  } catch (error) {
    if (error instanceof HunkRouteError && error.code === HUNK_ERROR.cliMissing) {
      t.skip('hunk CLI is not installed in this environment')
      return
    }
    throw error
  }
  // The browser keys its "restart dsh web" copy off exactly this.
  assert.equal(state.capabilities?.patches, true)
})

test('live: the real hunk CLI answers for this repository', async (t) => {
  let state
  try {
    state = await collectHunkState(process.cwd(), { bin: 'hunk', timeoutMs: 20_000 })
  } catch (error) {
    if (error instanceof HunkRouteError && error.code === HUNK_ERROR.cliMissing) {
      t.skip('hunk CLI is not installed in this environment')
      return
    }
    throw error
  }
  assert.equal(state.ok, true)
  assert.equal(locationKey(state.cwd), locationKey(process.cwd()))
  assert.ok(Array.isArray(state.sessions))
  assert.deepEqual(state.commands, {
    list: 'hunk session list --json',
    review: 'hunk session review --repo . --json --include-notes',
  })
  if (state.matched === null) {
    // Normal when no Hunk window is open on this repo: the tab shows the hint.
    assert.ok(state.review === null)
    assert.ok(state.reviewError !== null)
    return
  }
  assert.equal(typeof state.matched.sessionId, 'string')
  if (state.review !== null) {
    assert.equal(state.review.sessionId, state.matched.sessionId)
    assert.ok(Array.isArray(state.review.files))
    for (const file of state.review.files) {
      assert.equal(typeof file.path, 'string')
      assert.ok(Array.isArray(file.hunks))
      // The structural read never ships diff text; that is the patch read's job.
      assert.equal(file.patch, undefined)
    }
  } else {
    assert.ok(state.reviewError !== null)
  }
})

test('patch text slices per hunk, keeps signs, and is copyable', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    ' export { a }',
    '@@ -20,2 +21,1 @@ tail',
    ' keep',
    '-gone',
    '\\ No newline at end of file',
    '',
  ].join('\n')

  const hunks = splitPatchHunks(patch)
  assert.equal(hunks.length, 2)
  assert.equal(hunks[0].header, '@@ -1,3 +1,4 @@')
  assert.deepEqual(hunks[0].lines, [' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4', ' export { a }'])
  assert.equal(hunks[1].header, '@@ -20,2 +21,1 @@ tail')
  assert.deepEqual(hunks[1].lines, [' keep', '-gone', '\\ No newline at end of file'])
  // The copy text is a valid standalone patch fragment.
  assert.ok(hunks[0].text.startsWith('@@ -1,3 +1,4 @@\n'))
  assert.ok(hunks[0].text.endsWith(' export { a }\n'))

  assert.deepEqual(hunkLineNumbers(hunks[0].header), { old: 1, line: 1 })
  assert.deepEqual(hunkLineNumbers(hunks[1].header), { old: 20, line: 21 })
  assert.equal(hunkLineNumbers('not a header'), undefined)

  assert.equal(patchLineKind('+added'), 'add')
  assert.equal(patchLineKind('-removed'), 'del')
  assert.equal(patchLineKind(' context'), 'context')
  assert.equal(patchLineKind('\\ No newline at end of file'), 'meta')
})

test('pickPatchHunk matches by header, falls back to index, and survives no patch', () => {
  const patch = '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,2 @@\n c\n+d\n'
  // Header match wins even when the review's index disagrees.
  assert.equal(pickPatchHunk(patch, { index: 1, header: '@@ -1,1 +1,1 @@' }).lines[0], '-a')
  // Index is the fallback for a normalized header.
  assert.equal(pickPatchHunk(patch, { index: 1, header: '@@ rewritten @@' }).lines[1], '+d')
  assert.equal(pickPatchHunk(undefined, { index: 0, header: '@@ -1 +1 @@' }), undefined)
  assert.equal(pickPatchHunk('', { index: 0, header: '@@ -1 +1 @@' }), undefined)
  assert.equal(pickPatchHunk('no hunks here', { index: 0, header: '@@ -1 +1 @@' }), undefined)
})

test('live: the patch read carries diff text per file, and caches it', async (t) => {
  clearPatchCache()
  let payload
  try {
    payload = await collectHunkPatches(process.cwd(), { bin: 'hunk', timeoutMs: 30_000 })
  } catch (error) {
    if (error instanceof HunkRouteError && error.code === HUNK_ERROR.cliMissing) {
      t.skip('hunk CLI is not installed in this environment')
      return
    }
    if (error instanceof HunkRouteError && error.code === HUNK_ERROR.cliTimeout) {
      t.skip('hunk CLI did not answer in time')
      return
    }
    throw error
  }
  assert.equal(payload.ok, true)
  assert.equal(locationKey(payload.cwd), locationKey(process.cwd()))
  assert.equal(typeof payload.patches, 'object')
  if (payload.error !== null) {
    // No window on this repo right now: an empty map with the reason.
    assert.deepEqual(payload.patches, {})
    return
  }
  const paths = Object.keys(payload.patches)
  if (paths.length === 0) {
    // A registered window whose changeset is empty — hunk registers one even for
    // a clean tree (`fileCount: 0`), and a window opened while the tree was clean
    // keeps that empty publication. There is nothing to assert about patch text,
    // and failing here would only report the developer's working tree.
    t.skip('the live window for this repository reports no files to review')
    return
  }
  for (const path of paths) {
    assert.equal(typeof payload.patches[path], 'string')
    assert.ok(payload.patches[path].length > 0)
  }
  // The command really asked for patch text; the flag is part of the contract.
  assert.ok(HUNK_PATCH_COMMAND.endsWith('--include-patch'))
  // Second call inside the TTL is served from the cache (same object).
  const again = await collectHunkPatches(process.cwd(), { bin: 'hunk', timeoutMs: 30_000 })
  assert.equal(again, payload)
  clearPatchCache()
})

test('live: every hunk of every file has patch text to unfold', async (t) => {
  clearPatchCache()
  let state
  let patches
  try {
    state = await collectHunkState(process.cwd(), { bin: 'hunk', timeoutMs: 20_000 })
    patches = await collectHunkPatches(process.cwd(), { bin: 'hunk', timeoutMs: 30_000 })
  } catch (error) {
    if (error instanceof HunkRouteError
      && (error.code === HUNK_ERROR.cliMissing || error.code === HUNK_ERROR.cliTimeout)) {
      t.skip('hunk CLI unavailable in this environment')
      return
    }
    throw error
  }
  if (state.review === null || patches.error !== null) {
    t.skip('no live Hunk session for this repository right now')
    return
  }
  // Every hunk the tree lists must resolve to a patch hunk, or the diff pane
  // would show "loading" forever. Binary files legitimately have no patch.
  for (const file of state.review.files) {
    if (patches.missing.includes(file.path)) continue
    for (const hunk of file.hunks) {
      assert.notEqual(
        pickPatchHunk(patches.patches[file.path], hunk),
        undefined,
        `${file.path} hunk #${hunk.index + 1} has no patch text`,
      )
    }
  }
  clearPatchCache()
})
