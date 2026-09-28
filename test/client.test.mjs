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
