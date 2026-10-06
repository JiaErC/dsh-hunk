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
import { HUNK_ERROR, HUNK_STATE_PATH, HUNK_WATCH_PATH, apply } from '../lib/index.js'

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

/**
 * A request object shaped like the parts of IncomingMessage the handlers use.
 *
 * The watch route reads a body, and a real one arrives as stream events, so the
 * mock emits `data`/`end` on a microtask — after the handler has subscribed, and
 * without a socket.
 */
function mockRequest({ method, url, headers, body }) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers,
    on(event, handler) {
      const handlers = listeners.get(event) ?? []
      handlers.push(handler)
      listeners.set(event, handlers)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const handler of listeners.get('data') ?? []) handler(Buffer.from(body))
    }
    for (const handler of listeners.get('end') ?? []) handler()
  })
  return req
}

/** A ctx-shaped object that captures every route registration. */
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

/** Apply the plugin with the console kept quiet. */
function mount() {
  const { ctx, routes } = registrationOf()
  const originalLog = console.log
  console.log = () => {}
  try {
    apply(ctx)
  } finally {
    console.log = originalLog
  }
  return routes
}

/** One request against one captured route. */
async function request(route, { method = 'GET', url = route.path, headers = { host: '127.0.0.1:3080' }, body } = {}) {
  const res = mockResponse()
  await route.handler(mockRequest({ method, url, headers, body }), res)
  return { ...res, json: res.body === undefined ? undefined : JSON.parse(res.body) }
}

/** The captured route for one path. */
function routeFor(routes, path) {
  const route = routes.find(candidate => candidate.path === path)
  assert.ok(route !== undefined, `no route registered for ${path}`)
  return route
}

test('apply mounts one exact-path route per endpoint', () => {
  const routes = mount()
  assert.equal(routes.length, 2)
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
  assert.deepEqual(routes.map(route => route.path).sort(), [HUNK_STATE_PATH, HUNK_WATCH_PATH])
})

test('the route fences non-local Host headers, methods and missing cwd', async () => {
  const route = routeFor(mount(), HUNK_STATE_PATH)

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

test('the state route answers the state payload for this repository', async () => {
  const route = routeFor(mount(), HUNK_STATE_PATH)
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

test('the patch read answers the same route under ?patches=1', async () => {
  const route = routeFor(mount(), HUNK_STATE_PATH)
  const cwd = encodeURIComponent(process.cwd())
  const response = await request(route, { url: `${HUNK_STATE_PATH}?cwd=${cwd}&patches=1` })

  if (response.status === 503) {
    assert.equal(response.json.error.code, HUNK_ERROR.cliMissing)
    return
  }
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(typeof response.json.patches, 'object')
  assert.ok(Array.isArray(response.json.missing))

  // Two shapes share one path: the structural read (no `patches` field) is
  // still what the default read answers.
  const structural = await request(route, { url: `${HUNK_STATE_PATH}?cwd=${cwd}` })
  assert.equal(structural.status, 200)
  assert.equal(structural.json.patches, undefined)
  assert.ok(Array.isArray(structural.json.sessions))
  // The browser tells "this build cannot" from "that read failed" through this.
  assert.equal(structural.json.capabilities?.patches, true)
})

test('the watch route is POST-only, fenced, and validates its body', async () => {
  const route = routeFor(mount(), HUNK_WATCH_PATH)
  const cwd = process.cwd()

  // A GET here would be fired by prefetchers and retries; it must not start anything.
  const asGet = await request(route, { method: 'GET' })
  assert.equal(asGet.status, 405)
  assert.equal(asGet.json.error.code, HUNK_ERROR.methodNotAllowed)

  const forbidden = await request(route, {
    method: 'POST',
    headers: { host: 'evil.example.com' },
    body: JSON.stringify({ cwd }),
  })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.json.error.code, HUNK_ERROR.forbidden)

  const garbage = await request(route, { method: 'POST', body: 'not json' })
  assert.equal(garbage.status, 400)
  assert.equal(garbage.json.error.code, HUNK_ERROR.missingCwd)

  const noCwd = await request(route, { method: 'POST', body: JSON.stringify({}) })
  assert.equal(noCwd.status, 400)
  assert.equal(noCwd.json.error.code, HUNK_ERROR.missingCwd)

  const badCwd = await request(route, {
    method: 'POST',
    body: JSON.stringify({ cwd: 'E:/no/such/dir' }),
  })
  assert.equal(badCwd.status, 400)
  assert.equal(badCwd.json.error.code, HUNK_ERROR.badCwd)
})

test('the watch route answers with an action instead of spawning when disabled', async () => {
  const previous = process.env.DSH_HUNK_AUTOSTART
  process.env.DSH_HUNK_AUTOSTART = '0'
  try {
    const route = routeFor(mount(), HUNK_WATCH_PATH)
    const response = await request(route, { method: 'POST', body: JSON.stringify({ cwd: process.cwd() }) })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    // Disabled is a normal answer, not an error: the tab renders it as copy and
    // shows the command the user can run instead. Nothing was spawned.
    assert.equal(response.json.action, 'disabled')
    assert.equal(response.json.cwd, process.cwd())
    assert.match(response.json.command, /hunk diff --watch/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HUNK_AUTOSTART
    else process.env.DSH_HUNK_AUTOSTART = previous
  }
})
