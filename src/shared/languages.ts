/**
 * Filename → grammar id, and the token-colour fallbacks.
 *
 * Pure data, shared by both halves: the browser highlighter needs the map, and
 * the host bundle re-exports it so tests can pin it without pulling shiki into
 * the node half. Shaped after the host's own shared table
 * (`@deepseek-ai/dsh-util-code-language`), restricted to the grammars this
 * plugin bundles — an extension outside the map renders as plain text, exactly
 * as it did before highlighting existed.
 */

/** One token of one rendered line. */
export interface HighlightToken {
  text: string
  /** A CSS colour expression (`var(--shiki-…, var(--dsw-alias-…))`). */
  color?: string
  /** shiki's font-style bitfield: 1 italic, 2 bold, 4 underline. */
  fontStyle?: number
}

/** One rendered line, split into tokens. */
export type HighlightedLine = readonly HighlightToken[]

/**
 * Fallback colours per css variable, as DSH alias-token expressions.
 *
 * The mixes mirror the host diff's own token palette (`diff.module.css`), so a
 * deployment whose theme (or skin) does not define `--shiki-token-*` still lands
 * on the hues the host uses for code inside a diff, instead of inheriting one
 * flat colour and losing the highlighting entirely.
 */
export const TOKEN_FALLBACKS: Record<string, string> = {
  foreground: 'var(--dsw-alias-label-primary)',
  background: 'transparent',
  'token-comment': 'var(--dsw-alias-label-tertiary)',
  'token-keyword': 'color-mix(in oklab, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-state-error-primary))',
  'token-string': 'color-mix(in oklab, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-state-business-primary))',
  'token-string-expression': 'color-mix(in oklab, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-state-business-primary))',
  'token-constant': 'var(--dsw-alias-state-warn-primary)',
  'token-function': 'color-mix(in oklab, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-state-error-primary))',
  'token-parameter': 'var(--dsw-alias-state-business-primary)',
  'token-punctuation': 'var(--dsw-alias-label-secondary)',
  'token-link': 'var(--dsw-alias-accent)',
  'token-inserted': 'var(--dsw-alias-state-success-primary)',
  'token-deleted': 'var(--dsw-alias-state-error-primary)',
  'token-changed': 'var(--dsw-alias-state-business-primary)',
}

/** Filename extension → grammar id (lowercase, no dot). */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  // shiki ships JSX as part of its `tsx` bundle (a separate `jsx` bundle would
  // cost another ~190 kB for the same tokenizer), and tsx handles JSX fine.
  jsx: 'tsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  ps1: 'powershell',
  psm1: 'powershell',
  lua: 'lua',
  kt: 'kotlin',
  kts: 'kotlin',
  mk: 'make',
  dockerfile: 'dockerfile',
}

/** Whole-name matches, where the "extension" is the file itself. */
export const LANGUAGE_FILENAMES: Record<string, string> = {
  makefile: 'make',
  dockerfile: 'dockerfile',
}

/**
 * The grammar for one path, or undefined when nothing claims it.
 * @param path - repo-relative path (`src/a.ts`, `Makefile`, `a.constructor`).
 * @returns the grammar id, or undefined for plain text.
 */
export function languageForPath(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const named = LANGUAGE_FILENAMES[base]
  if (named !== undefined) return named
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return undefined
  // Map lookup, so `a.constructor` misses instead of resolving an inherited member.
  return Object.prototype.hasOwnProperty.call(LANGUAGE_EXTENSIONS, base.slice(dot + 1))
    ? LANGUAGE_EXTENSIONS[base.slice(dot + 1)]
    : undefined
}
