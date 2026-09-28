/**
 * Route test: drive the real host handler through a fake webserver.
 *
 * `apply()` is a plain function over a ctx-shaped object, so the whole host
 * half — fence, cwd validation, both CLI runs, JSON envelope, status codes —
 * can be exercised without booting DSH. The only external dependency is the
 * `hunk` CLI itself, which the live case needs and skips without.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HUNK_ERROR, HUNK_STATE_PATH, apply } from '../lib/index.js'

/** A response object shaped like the parts of ServerResponse the handler uses. */
function mockResponse() {
  return {
    status: 0,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk)
    },
  }
}

/** A ctx-shaped object that captures the one route registration. */
function registrationOf() {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(callback) {
      const disposer = callback()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    get() {
      return undefined
    },
  }
  return { ctx, routes }
}

/** One request against the captured route. */
async function request(route, { method = 'GET', url = HUNK_STATE_PATH, headers = { host: '127.0.0.1:3080' } } = {}) {
  const res = mockResponse()
  await route.handler({ method, url, headers }, res)
  return { ...res, json: res.body === undefined ? undefined : JSON.parse(res.body) }
}

test('apply mounts exactly one exact-path route', () => {
  const { ctx, routes } = registrationOf()
  const originalLog = console.log
  console.log = () => {}
  try {
    apply(ctx)
  } finally {
    console.log = originalLog
  }
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, HUNK_STATE_PATH)
  assert.equal(typeof routes[0].handler, 'function')
})

test('the route fences non-local Host headers, methods and missing cwd', async () => {
  const { ctx, routes } = registrationOf()
  const originalLog = console.log
  console.log = () => {}
  try {
    apply(ctx)
  } finally {
    console.log = originalLog
  }
  const route = routes[0]

  const forbidden = await request(route, { headers: { host: 'evil.example.com' } })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.json.error.code, HUNK_ERROR.forbidden)

  const wrongMethod = await request(route, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.error.code, HUNK_ERROR.methodNotAllowed)

  const noCwd = await request(route, { url: HUNK_STATE_PATH })
  assert.equal(noCwd.status, 400)
  assert.equal(noCwd.json.error.code, HUNK_ERROR.missingCwd)

  const badCwd = await request(route, { url: `${HUNK_STATE_PATH}?cwd=E%3A%2Fno%2Fsuch%2Fdir` })
  assert.equal(badCwd.status, 400)
  assert.equal(badCwd.json.error.code, HUNK_ERROR.badCwd)
})

test('the route answers the state payload for this repository', async () => {
  const { ctx, routes } = registrationOf()
  const originalLog = console.log
  console.log = () => {}
  try {
    apply(ctx)
  } finally {
    console.log = originalLog
  }
  const route = routes[0]
  const url = `${HUNK_STATE_PATH}?cwd=${encodeURIComponent(process.cwd())}`
  const response = await request(route, { url })

  if (response.status === 503) {
    // No Hunk installation here: the route must say exactly that.
    assert.equal(response.json.error.code, HUNK_ERROR.cliMissing)
    assert.match(response.json.error.message, /hunkdiff/)
    return
  }

  assert.equal(response.status, 200)
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['Cache-Control'], 'no-store')
  const body = response.json
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.sessions))
  assert.ok(body.review === null || typeof body.review.sessionId === 'string')
  assert.ok(Array.isArray(body.otherRepos))

  const head = await request(route, { method: 'HEAD', url })
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)
  assert.ok(Number(head.headers['Content-Length']) > 0)
})
