/**
 * Skin-contract guard: every `--dsw-*` token this plugin consumes must either be
 * defined by the installed DSH build, or be consumed with an explicit fallback.
 *
 * Why this exists: an unset custom property makes the whole declaration invalid
 * at computed-value time, so a renamed or never-defined token does not throw —
 * the border/background/font silently falls back to an initial value and the UI
 * just looks a bit wrong. That is exactly the kind of drift an upgrade causes and
 * a typecheck cannot see (found for real: `--dsw-alias-hairline` / `-accent` /
 * `-accent-soft` / `-danger` / `--dsw-font-mono` are not in the DSH theme package
 * in either the 0.1.7 or the 0.2.0 line).
 *
 * The host install is located from `DSH_PACKAGE_ROOT` or the default global npm
 * prefix; without one the test skips (same pattern as the live CLI tests).
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Where the DSH install could be, most specific first. */
function hostRoot() {
  const candidates = [
    process.env.DSH_PACKAGE_ROOT,
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  return candidates.find(candidate => existsSync(candidate))
}

/** Every `--dsw-*` name in the plugin's own sources. */
function consumed() {
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) files.push(path)
    }
  }
  walk(join(repoRoot, 'src'))
  const names = new Set()
  for (const file of files) {
    // A token name ends in an alphanumeric and is not followed by `*`, so a doc
    // comment mentioning the family (`--dsw-alias-*`) is not mistaken for one.
    for (const match of readFileSync(file, 'utf8').matchAll(/--dsw-[a-z0-9-]*[a-z0-9](?![\w*-])/g)) names.add(match[0])
  }
  return names
}

/** Tokens this build actually defines (a definition is a name followed by `:`). */
function definedByHost(root) {
  const defined = new Set()
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Bundler/source dirs are build inputs, not what the browser loads.
        if (['node_modules', 'src', 'coverage', 'tests'].includes(entry.name)) continue
        walk(path)
        continue
      }
      if (!/\.(js|mjs|cjs|css)$/.test(entry.name)) continue
      if (statSync(path).size > 8_000_000) continue
      let text
      try { text = readFileSync(path, 'utf8') } catch { continue }
      for (const match of text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) defined.add(match[1])
    }
  }
  walk(root)
  return defined
}

const root = hostRoot()

test('every consumed theme token is defined by the host or carries a fallback', { skip: root === undefined ? 'no DSH install found (set DSH_PACKAGE_ROOT to check)' : false }, (t) => {
  const defined = definedByHost(root)
  assert.ok(defined.size > 100, `expected a full token set from ${root}, got ${defined.size}`)

  const unresolved = []
  for (const name of consumed()) {
    if (defined.has(name)) continue
    // Not defined here: it must be written as `var(--token, …)` so the browser
    // has something real to use when no skin supplies the name.
    const withFallback = new RegExp(`var\\(\\s*${name}\\s*,`)
    let used = false
    for (const file of ['src/client/styles.ts', 'src/client/HunkReviewTab.tsx', 'src/client/index.tsx', 'src/shared/languages.ts']) {
      if (withFallback.test(readFileSync(join(repoRoot, file), 'utf8'))) { used = true; break }
    }
    if (!used) unresolved.push(name)
  }

  t.diagnostic(`host defines ${defined.size} --dsw-* tokens; ${consumed().size} consumed by this plugin`)
  assert.deepEqual(unresolved, [], `these tokens are neither defined by the host nor consumed with a fallback: ${unresolved.join(', ')}`)
})
