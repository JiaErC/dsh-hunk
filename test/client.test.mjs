/**
 * Client-bundle test: load the built browser bundle exactly the way the DSH
 * client module system does, materialize it, and drive its `apply()`.
 *
 * What this proves: the bundle registers under the package name, its factory
 * materializes with only the baseline module-table entries (`react`,
 * `react/jsx-runtime`), and `apply` registers one better-sidebar tab with the
 * requested id, order and single-instance policy — plus the locale path.
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
  return {
    registered,
    register(ns, locale, dict) {
      registered.push({ ns, locale, keys: Object.keys(dict).length })
      return () => {}
    },
    getSnapshot: () => ({ active, locales: [], revision: 0 }),
    subscribe: () => () => {},
  }
}

/** A ctx-shaped object capturing the registered tab descriptor. */
function fakeCtx(locale) {
  const tabs = []
  return {
    tabs,
    ctx: {
      betterSidebar: {
        registerTab(descriptor) {
          tabs.push(descriptor)
          return () => {}
        },
      },
      get(name) {
        return name === 'locale' ? locale : undefined
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
  assert.deepEqual(plugin.inject, ['betterSidebar'])
})

test('apply registers the review tab at the requested id, order and policy', async () => {
  const plugin = await loadPlugin()
  const locale = localeStub('en')
  const { ctx, tabs } = fakeCtx(locale)
  plugin.apply(ctx)

  // The dictionaries are registered for both shipped languages.
  assert.deepEqual(
    locale.registered.map(entry => `${entry.ns}:${entry.locale}`).sort(),
    ['dshHunk:en', 'dshHunk:zh'],
  )

  assert.equal(tabs.length, 1)
  const tab = tabs[0]
  assert.equal(tab.id, 'dsh-hunk:review')
  assert.equal(tab.order, 40)
  assert.equal(tab.single, true)
  assert.equal(typeof tab.component, 'function')
  assert.equal(typeof tab.title(), 'string')
  assert.equal(tab.title(), 'Hunk review')
  assert.equal(tab.description(), 'Live Hunk session for this repo: files, hunks and notes')

  // The icon must inherit the skin rather than carry color literals.
  assert.equal(tab.icon.props.stroke, 'currentColor')
  assert.equal(tab.icon.props.viewBox, '0 0 16 16')
})

test('the tab title follows the active locale', async () => {
  const plugin = await loadPlugin()
  const { ctx, tabs } = fakeCtx(localeStub('zh'))
  plugin.apply(ctx)
  assert.equal(tabs[0].title(), 'Hunk 评审')
})

test('apply still works without a locale service', async () => {
  const plugin = await loadPlugin()
  const { ctx, tabs } = fakeCtx(undefined)
  plugin.apply(ctx)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'dsh-hunk:review')
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
