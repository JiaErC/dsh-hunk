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
import { test } from 'node:test'
import {
  HUNK_ERROR,
  HUNK_PATCH_COMMAND,
  HunkRouteError,
  clearPatchCache,
  collectHunkPatches,
  collectHunkState,
  groupNotes,
  hunkLineNumbers,
  hunkOfNote,
  isLoopbackHostname,
  isTrustedRequest,
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
  assert.ok(paths.length > 0)
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
