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
  HunkRouteError,
  collectHunkState,
  groupNotes,
  hunkOfNote,
  isLoopbackHostname,
  isTrustedRequest,
  locationKey,
  matchSession,
  parseJson,
  readReview,
  readSessions,
  resolveRequestCwd,
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
    }
  } else {
    assert.ok(state.reviewError !== null)
  }
})
