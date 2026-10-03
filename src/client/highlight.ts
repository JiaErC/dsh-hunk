/**
 * Syntax highlighting for the diff, on the same engine the host's own code
 * surfaces use.
 *
 * The host's `@deepseek-ai/dsh-client-ui-primitives` builds a *synchronous*
 * shiki core over the JavaScript regex engine and a css-variables theme, so
 * token colours arrive as `var(--shiki-*)` and the theme layer owns them. This
 * module does the same thing — same engine options, same theme factory — with
 * one addition: `variableDefaults` bound to DSH alias tokens (see
 * `@shared/languages`). A deployment whose theme, or skin, does not define
 * `--shiki-token-*` then still gets code that reads as code.
 *
 * Grammars are bundled rather than borrowed: a plugin must not require a
 * Harness Client package, and the client module table has no shiki entry to
 * require. The set is deliberately explicit — every grammar costs tens to
 * hundreds of kilobytes in this bundle.
 */
import {
  createCssVariablesTheme,
  createHighlighterCoreSync,
  type HighlighterCore,
  type ThemedToken,
} from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
// Grammars. shiki ships one grammar per bundle: `typescript` (aliases ts/cts/mts)
// and `tsx` (tsx/jsx). Both are needed — type arguments in a `.ts` file are
// valid code that the tsx grammar reads as JSX, so plain TypeScript files must
// not be handed to it.
import langTypescript from '@shikijs/langs/typescript'
import langTsx from '@shikijs/langs/tsx'
import langJson from '@shikijs/langs/json'
import langShell from '@shikijs/langs/shellscript'
import langPython from '@shikijs/langs/python'
import langGo from '@shikijs/langs/go'
import langRust from '@shikijs/langs/rust'
import langJava from '@shikijs/langs/java'
import langC from '@shikijs/langs/c'
import langYaml from '@shikijs/langs/yaml'
import langToml from '@shikijs/langs/toml'
import langIni from '@shikijs/langs/ini'
import langMarkdown from '@shikijs/langs/markdown'
import langCss from '@shikijs/langs/css'
import langHtml from '@shikijs/langs/html'
import langXml from '@shikijs/langs/xml'
import langSql from '@shikijs/langs/sql'
import langDiff from '@shikijs/langs/diff'
import langPowerShell from '@shikijs/langs/powershell'
import langLua from '@shikijs/langs/lua'
import langKotlin from '@shikijs/langs/kotlin'
import langMake from '@shikijs/langs/make'
import langDockerfile from '@shikijs/langs/dockerfile'
import { TOKEN_FALLBACKS, type HighlightToken, type HighlightedLine } from '../shared/languages'
import type { SplitRow } from '../shared/patch'

/** The theme name the highlighter is created with (and asked for by name). */
export const HIGHLIGHT_THEME = 'css-variables'

/** Every bundled grammar, in the order shiki receives them. */
const LANGS = [
  langTypescript,
  langTsx,
  langJson,
  langShell,
  langPython,
  langGo,
  langRust,
  langJava,
  langC,
  langYaml,
  langToml,
  langIni,
  langMarkdown,
  langCss,
  langHtml,
  langXml,
  langSql,
  langDiff,
  langPowerShell,
  langLua,
  langKotlin,
  langMake,
  langDockerfile,
]

let singleton: HighlighterCore | undefined
/** Reported once, so a broken highlighter cannot flood the console. */
let failureReported = false

/** Build the one highlighter (synchronously — the JS engine needs no wasm). */
function highlighter(): HighlighterCore | undefined {
  if (singleton !== undefined) return singleton
  try {
    const theme = createCssVariablesTheme({
      name: HIGHLIGHT_THEME,
      variablePrefix: '--shiki-',
      variableDefaults: TOKEN_FALLBACKS,
      fontStyle: true,
    })
    singleton = createHighlighterCoreSync({
      themes: [theme],
      langs: LANGS,
      engine: createJavaScriptRegexEngine({
        forgiving: true,
        regexConstructor: pattern =>
          defaultJavaScriptRegexConstructor(pattern, { lazyCompileLength: Number.POSITIVE_INFINITY }),
      }),
    })
    return singleton
  } catch (error) {
    if (!failureReported) {
      failureReported = true
      console.error('[dsh-hunk] syntax highlighter unavailable, diffs render as plain text:', error)
    }
    return undefined
  }
}

/** Tokenized blocks, so re-expanding a hunk does not re-tokenize it. */
const cache = new Map<string, HighlightedLine[]>()
const CACHE_LIMIT = 64

/** Convert one shiki token into the shape the view renders. */
function toToken(token: ThemedToken): HighlightToken {
  const fontStyle = typeof token.fontStyle === 'number' && token.fontStyle > 0 ? token.fontStyle : undefined
  return {
    text: token.content,
    ...(typeof token.color === 'string' && token.color !== '' ? { color: token.color } : {}),
    ...(fontStyle === undefined ? {} : { fontStyle }),
  }
}

/**
 * Highlight one block of code, one entry per line.
 *
 * Whole blocks, not single lines: a block comment, a template literal or a
 * multi-line string only tokenizes correctly with the lines around it.
 * @param code - the block's text (lines joined by `\n`).
 * @param lang - a grammar id (see `languageForPath` in `@shared/languages`).
 * @returns one token list per line; empty when the grammar is unknown or the
 *   highlighter failed, in which case the caller renders plain text.
 */
export function highlightBlock(code: string, lang: string): HighlightedLine[] {
  if (code === '') return []
  const key = `${lang}\u0000${code}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const instance = highlighter()
  if (instance === undefined) return []
  let lines: HighlightedLine[]
  try {
    lines = instance.codeToTokens(code, { lang, theme: HIGHLIGHT_THEME }).tokens.map(line => line.map(toToken))
  } catch (error) {
    if (!failureReported) {
      failureReported = true
      console.error(`[dsh-hunk] could not highlight "${lang}", falling back to plain text:`, error)
    }
    return []
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done !== true) cache.delete(oldest.value)
  }
  cache.set(key, lines)
  return lines
}

/** Drop the token cache (tests; also the hook for a future explicit reset). */
export function clearHighlightCache(): void {
  cache.clear()
}

/** The languages this build can actually highlight (tests keep the map honest). */
export function loadedLanguages(): string[] {
  const instance = highlighter()
  return instance === undefined ? [] : [...instance.getLoadedLanguages()].sort()
}

/** Per-row syntax tokens for both sides of one hunk. */
export interface SideTokens {
  left: readonly (HighlightedLine | undefined)[]
  right: readonly (HighlightedLine | undefined)[]
}

/**
 * Tokenize both sides of a hunk, aligned to the split rows.
 *
 * Each side is tokenized as ONE block — the side's own lines in file order,
 * which is exactly the old (or new) file's content for that region — because a
 * block comment or a multi-line string only tokenizes correctly with its
 * neighbours. The result is then handed back row by row; a row missing that
 * side gets no tokens.
 * @param rows - the hunk's side-by-side rows.
 * @param lang - the grammar for the file.
 * @returns both sides' tokens, or undefined when nothing could be highlighted
 *   (unknown grammar or a failed highlighter), so the caller renders plain text.
 */
export function tokenizeSides(rows: readonly SplitRow[], lang: string): SideTokens | undefined {
  const leftText: string[] = []
  const rightText: string[] = []
  for (const row of rows) {
    if (row.left !== undefined) leftText.push(row.left.text)
    if (row.right !== undefined) rightText.push(row.right.text)
  }
  const leftBlock = highlightBlock(leftText.join('\n'), lang)
  const rightBlock = highlightBlock(rightText.join('\n'), lang)
  if (leftBlock.length === 0 && rightBlock.length === 0) return undefined

  const left: (HighlightedLine | undefined)[] = []
  const right: (HighlightedLine | undefined)[] = []
  let leftIndex = 0
  let rightIndex = 0
  for (const row of rows) {
    left.push(row.left === undefined ? undefined : leftBlock[leftIndex++])
    right.push(row.right === undefined ? undefined : rightBlock[rightIndex++])
  }
  return { left, right }
}
