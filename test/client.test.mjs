/**
 * Client-bundle test: load the built browser bundle exactly the way the DSH
 * client module system does, materialize it, and drive its `apply()`.
 *
 * What this proves: the bundle registers under the package name, its factory
 * materializes with only the baseline module-table entries (`react`,
 * `react/jsx-runtime`), and `apply` registers the tab TYPE (id, kind,
 * `extension` priority, guide entry) plus its BODY seat — on DSH's own right
 * Sidebar services, with no third-party sidebar plugin involved — and the
 * locale path.
 *
 * What it cannot prove: how the tab looks in the browser. No renderer runs
 * here, so visual verification stays a manual step (open the tab and refresh).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
// The row layout the highlighter aligns against lives in the host bundle.
import { toSplitRows } from '../lib/index.js'

/** The react surface the bundle requests (nothing is rendered here). */
function reactStub() {
  const noop = () => {}
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'createElement') {
        return (type, props, ...children) => ({ type, props, children })
      }
      if (prop === 'Fragment') return Symbol.for('react.fragment')
      if (prop === '__esModule') return true
      return noop
    },
  })
}

/** The `react/jsx-runtime` surface (JSX never runs here, but the import must resolve). */
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: Symbol.for('react.fragment'),
  __esModule: true,
}

/** The two module-table entries the shell owns and this bundle requests. */
function requireStub(specifier) {
  if (specifier === 'react') return reactStub()
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected module-table request: ${specifier}`)
}

/** A locale service stub recording what the plugin registers. */
function localeStub(active) {
  const registered = []
  const dictionaries = {}
  return {
    registered,
    dictionaries,
    register(ns, locale, dict) {
      registered.push({ ns, locale, keys: Object.keys(dict).length })
      dictionaries[locale] = dict
      return () => {}
    },
    getSnapshot: () => ({ active, locales: [], revision: 0 }),
    subscribe: () => () => {},
  }
}

/**
 * A ctx-shaped object standing in for DSH's own right-Sidebar services.
 *
 * The plugin talks to them through `ctx.get` with structural types, so the stub
 * only has to be faithful about the two calls it makes: the tab-type registry
 * and the keyed body seat.
 */
function fakeCtx(locale) {
  const tabs = []
  const bodies = []
  const slotInjections = []
  const slots = {
    register(options, component) {
      bodies.push({ options, component })
      return () => {}
    },
    inject(ownerKey, callback) {
      slotInjections.push(ownerKey)
      const disposer = callback()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  const services = {
    locale,
    slots,
    sidebarRightTabs: {
      register(definition) {
        tabs.push(definition)
        return () => {}
      },
    },
  }
  return {
    tabs,
    bodies,
    slotInjections,
    ctx: {
      get(name) {
        return services[name]
      },
      effect(callback) {
        const disposer = callback()
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
    },
  }
}

/** Materialized once: the module system materializes a bundle factory a single time. */
let cachedPlugin

/** Load the bundle the way the module system does, and materialize its factory. */
async function loadPlugin() {
  if (cachedPlugin !== undefined) return cachedPlugin
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  try {
    await import('../lib/client.js')
  } finally {
    delete globalThis.window
  }
  assert.equal(registrations.length, 1)
  const registration = registrations[0]
  assert.equal(registration.id, 'dsh-hunk')
  assert.equal(typeof registration.factory, 'function')
  cachedPlugin = registration.factory(requireStub)
  return cachedPlugin
}

test('the bundle registers under the package name and exposes a cordis plugin', async () => {
  const plugin = await loadPlugin()
  assert.equal(typeof plugin.apply, 'function')
  // The tab-type registry and the slot registry: DSH's own right Sidebar, with
  // no third-party sidebar plugin in the dependency list.
  assert.deepEqual(plugin.inject, ['sidebarRightTabs', 'slots'])
})

test('apply registers the review tab type, its guide entry, and its body seat', async () => {
  const plugin = await loadPlugin()
  const locale = localeStub('en')
  const { ctx, tabs, bodies, slotInjections } = fakeCtx(locale)
  plugin.apply(ctx)

  // The dictionaries are registered for both shipped languages.
  assert.deepEqual(
    locale.registered.map(entry => `${entry.ns}:${entry.locale}`).sort(),
    ['dshHunk:en', 'dshHunk:zh'],
  )

  // Stage one: the tab TYPE.
  assert.equal(tabs.length, 1)
  const tab = tabs[0]
  assert.equal(tab.id, 'dsh-hunk:review')
  assert.equal(tab.kind, 'dsh-hunk:review')
  assert.equal(tab.priority, 'extension')
  assert.equal(tab.title('/any/address'), 'Hunk review')

  // It is offered on the new-tab page, in the requested order, with live copy.
  assert.equal(tab.guide.length, 1)
  const entry = tab.guide[0]
  assert.equal(entry.id, 'dsh-hunk:review')
  assert.equal(entry.order, 40)
  assert.equal(entry.title(), 'Hunk review')
  assert.equal(entry.description(), 'Live Hunk session for this repo: files, hunks and notes')
  // The guide renders the glyph itself, so the entry carries a COMPONENT (the
  // native seat calls it with its own size) — an element here would break it.
  assert.equal(typeof entry.icon, 'function')
  const glyph = entry.icon({ size: 16 })
  assert.equal(glyph.props.stroke, 'currentColor')
  assert.equal(glyph.props.viewBox, '0 0 16 16')
  assert.equal(glyph.props.width, 16)
  assert.equal(entry.icon({}).props.width, 14)

  // Stage two: the BODY, under the type's id, inside the seat the sidebar declares.
  assert.deepEqual(slotInjections, ['sidebar.right.pane.tab'])
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].options.name, 'sidebar.right.pane.tab')
  assert.equal(bodies[0].options.key, 'dsh-hunk:review')
  assert.equal(typeof bodies[0].component, 'function')
  // The body registration injects the context and the session it renders for.
  assert.deepEqual(Object.keys(bodies[0].options.inject('session-1')).sort(), ['ctx', 'sessionId'])
  assert.equal(bodies[0].options.inject('session-1').sessionId, 'session-1')
  assert.equal(bodies[0].options.inject('session-1').ctx, ctx)
})

test('the tab title follows the active locale', async () => {
  const plugin = await loadPlugin()
  const { ctx, tabs } = fakeCtx(localeStub('zh'))
  plugin.apply(ctx)
  assert.equal(tabs[0].title(''), 'Hunk 评审')
  assert.equal(tabs[0].guide[0].title(), 'Hunk 评审')
})

test('apply still works without a locale service', async () => {
  const plugin = await loadPlugin()
  const { ctx, tabs } = fakeCtx(undefined)
  plugin.apply(ctx)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'dsh-hunk:review')
})

test('a missing sidebar service is reported instead of failing silently', async () => {
  const plugin = await loadPlugin()
  // No registry: the plugin must say so (a cordis swallow would leave the
  // sidebar without a tab and without a symptom).
  const errors = []
  const original = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    plugin.apply({ get: () => undefined, effect: () => () => {} })
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /sidebarRightTabs is missing/)
})

/*
 * The highlighter. These run against the built bundle — shiki is inlined there,
 * so materializing it in node exercises exactly the code the browser gets.
 */

test('every language the path map claims is actually bundled', async () => {
  const plugin = await loadPlugin()
  const loaded = plugin.loadedLanguages()
  assert.ok(loaded.includes('typescript'), 'typescript grammar missing')
  assert.ok(loaded.length > 20, `expected a broad grammar set, got ${loaded.length}`)
  // The map is the contract: an id it names but the bundle lacks would silently
  // render that file as plain text after promising a grammar.
  const wanted = [...new Set(Object.values(plugin.LANGUAGE_EXTENSIONS))]
  assert.deepEqual(wanted.filter(id => !loaded.includes(id)), [])
  // .tsx/.jsx come from shiki's separate `tsx` bundle — easy to forget, and this
  // repo's own files are .tsx.
  assert.ok(loaded.includes('tsx'))
  assert.equal(plugin.languageForPath('a.jsx'), 'tsx')
})

test('highlightBlock colours tokens through css variables with alias fallbacks', async () => {
  const plugin = await loadPlugin()
  const code = 'const answer: number = 42 // the meaning\nfunction f() { return "x" }'
  const lines = plugin.highlightBlock(code, 'typescript')
  assert.equal(lines.length, 2)
  // Tokenizing must not lose or reorder text.
  assert.equal(lines.map(line => line.map(token => token.text).join('')).join('\n'), code)

  const colors = lines.flat().map(token => token.color ?? '')
  // Theme variables first, DSH alias tokens as the fallback in the same value:
  // a deployment without --shiki-* still gets coloured code.
  assert.ok(colors.some(color => color.includes('var(--shiki-token-keyword')), 'no keyword colour')
  assert.ok(colors.some(color => color.includes('--dsw-alias-')), 'no alias fallback in the colour')
  assert.equal(colors.filter(color => color.includes('--shiki-token-comment')).length, 1)
  for (const token of lines.flat()) {
    assert.equal(typeof token.text, 'string')
    assert.ok(token.fontStyle === undefined || typeof token.fontStyle === 'number')
  }
})

test('tokenizeSides aligns tokens to the split rows it was given', async () => {
  const plugin = await loadPlugin()
  // context, a replacement, a pure addition, a pure deletion, a marker.
  const rows = toSplitRows({
    header: '@@ -1,3 +1,3 @@',
    lines: [' const keep = 1', '-const a = 1', '+const a = 2', '+const b = 3', ' const tail = 4', '-gone'],
    text: '',
  })
  const tokens = plugin.tokenizeSides(rows, 'typescript')
  assert.equal(tokens.left.length, rows.length)
  assert.equal(tokens.right.length, rows.length)
  for (const [index, row] of rows.entries()) {
    assert.equal(tokens.left[index] === undefined, row.left === undefined, `left row ${index}`)
    assert.equal(tokens.right[index] === undefined, row.right === undefined, `right row ${index}`)
    // An aligned line must reproduce that cell's text exactly.
    for (const [side, cell] of [['left', row.left], ['right', row.right]]) {
      const line = tokens[side][index]
      if (line === undefined || cell === undefined) continue
      assert.equal(line.map(token => token.text).join(''), cell.text)
    }
  }
  // Each side is tokenized as its own block: out of the alignment the two sides
  // still carry their own content.
  assert.equal(tokens.right[1].map(token => token.text).join(''), 'const a = 2')
  assert.equal(tokens.left[1].map(token => token.text).join(''), 'const a = 1')
})

test('an unknown grammar yields no tokens, so the rows stay plain text', async () => {
  const plugin = await loadPlugin()
  plugin.clearHighlightCache()
  assert.deepEqual(plugin.highlightBlock('hello', 'no-such-language'), [])
  assert.equal(plugin.tokenizeSides([{ kind: 'context', left: { no: 1, text: 'x' }, right: { no: 1, text: 'x' } }], 'no-such-language'), undefined)
  // A successful call is cached (same array identity on the second call).
  plugin.clearHighlightCache()
  const first = plugin.highlightBlock('const x = 1', 'typescript')
  assert.ok(first.length > 0)
  assert.equal(plugin.highlightBlock('const x = 1', 'typescript'), first)
})

/*
 * "hunk is not installed": the guide's data, and the one action that resolves it
 * from inside the tab. The session channel is stubbed, so these run in node.
 */

test('the install routes are the ones Hunk documents, per platform', async () => {
  const plugin = await loadPlugin()
  for (const platform of ['win32', 'darwin', 'linux']) {
    const routes = plugin.installRoutes(platform)
    assert.ok(routes.length > 0, `${platform} offers no route`)
    for (const route of routes) {
      assert.ok(route.id !== '' && route.label !== '', 'a route needs an id and a label')
      assert.ok(route.command.includes('hunk') || route.command.includes('hunkdiff'), route.command)
      // No placeholder ever reaches a code block the reader may paste.
      assert.ok(!route.command.includes('{') && !route.command.includes('<'))
    }
  }
  const windows = plugin.installRoutes('win32').map(route => route.command)
  assert.ok(windows.some(command => command.includes('npm i -g hunkdiff')))
  const linux = plugin.installRoutes('linux').map(route => route.command)
  assert.ok(linux.some(command => command.includes('hunk.dev/install.sh')))
})

test('asking the agent goes through the session channel, queued, with an echo', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const abandoned = []
  const session = {
    beginSubmission(input) {
      calls.push({ kind: 'begin', input })
      return { requestId: 'req-1', abandon: () => { abandoned.push('req-1') } }
    },
    async prompt(content, mode, signal, requestId) {
      calls.push({ kind: 'prompt', content, mode, signal, requestId })
      return { ok: true, value: { accepted: true } }
    },
  }
  const ctx = { get: name => (name === 'sessions' ? { binding: id => (id === 's-1' ? { session } : undefined) } : undefined) }

  const outcome = await plugin.askAgentToInstall(ctx, 's-1', 'please install hunk')
  assert.deepEqual(outcome, { ok: true })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].input, { mode: 'queue', text: 'please install hunk', attachments: [] })
  // Queue, never steer: asking for a favour must not interrupt a running turn.
  assert.equal(calls[1].mode, 'queue')
  assert.deepEqual(calls[1].content, [{ type: 'text', text: 'please install hunk' }])
  // The echo identity is carried into the prompt, so the chat shows the message
  // once instead of twice.
  assert.equal(calls[1].requestId, 'req-1')
  assert.deepEqual(abandoned, [])
})

test('a session that refuses the prompt retires the echo, and a missing channel is reported', async () => {
  const plugin = await loadPlugin()
  const abandoned = []
  const refusing = {
    beginSubmission: () => ({ requestId: 'req-9', abandon: () => { abandoned.push('req-9') } }),
    async prompt() { return { ok: false, error: { message: 'queue is full' } } },
  }
  const bound = { get: () => ({ binding: () => ({ session: refusing }) }) }
  const refused = await plugin.askAgentToInstall(bound, 's-1', 'text')
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'rejected')
  assert.equal(refused.message, 'queue is full')
  assert.deepEqual(abandoned, ['req-9'])

  // No service, and a session the conversation view has not retained: both are
  // reported rather than silently doing nothing.
  assert.equal((await plugin.askAgentToInstall({ get: () => undefined }, 's-1', 'text')).reason, 'no-sessions-service')
  const unretained = { get: () => ({ binding: () => undefined }) }
  assert.equal((await plugin.askAgentToInstall(unretained, 's-1', 'text')).reason, 'session-not-retained')
})

test('the install request is a dictionary entry with both placeholders filled', async () => {
  const plugin = await loadPlugin()
  const locale = localeStub('zh')
  const { ctx } = fakeCtx(locale)
  plugin.apply(ctx)
  const dictionaries = Object.fromEntries(locale.registered.map(entry => [entry.locale, entry.keys]))
  // Both shipped languages carry it (the Record<HunkKey, string> type enforces
  // parity; this pins that the key actually exists and is the large one).
  assert.equal(dictionaries.zh, dictionaries.en)
  const zhAsk = locale.dictionaries.zh['install.ask']
  assert.match(zhAsk, /\{cwd\}/)
  assert.match(zhAsk, /\{detail\}/)
  assert.match(zhAsk, /hunk --version/)
  assert.match(zhAsk, /DSH_HUNK_BIN/)
  assert.match(zhAsk, /dsh web/)
})
