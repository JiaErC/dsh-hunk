/**
 * dsh-hunk client half.
 *
 * Registers one better-sidebar tab: 「Hunk 评审」(order 40, single instance).
 * The tab body itself lives in ./HunkReviewTab.tsx; everything it needs comes
 * from this plugin's own host route, so no DSH client package is imported.
 */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-better-sidebar/client/service'
import { HunkReviewTab } from './HunkReviewTab'
import { registerDictionaries, textNow } from './i18n'

/**
 * Services this client plugin waits for. `betterSidebar` is provided by
 * better-sidebar's client half; Cordis parks this plugin until it exists, so
 * the plugin is a harmless no-op in a profile without better-sidebar.
 */
export const inject = ['betterSidebar']

/** The tab type id (also the `SidebarTab.type` value). */
export const HUNK_TAB_ID = 'dsh-hunk:review'

/** The `+`-menu order the tab was requested at. */
export const HUNK_TAB_ORDER = 40

/**
 * A small diff glyph in `currentColor`, so it follows the skin like every
 * other sidebar icon (no literal colors, no icon data shipped). It is a plain
 * factory rather than a component: the descriptor takes a ReactNode, and a
 * function would be read as a `(size) => ReactNode` factory instead.
 */
function hunkTabIcon(): ReactNode {
  return createElement(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    createElement('path', { key: 'plus', d: 'M2 5h4M4 3v4' }),
    createElement('path', { key: 'minus', d: 'M2 11h4' }),
    createElement('path', { key: 'added', d: 'M8.5 5h5.5' }),
    createElement('path', { key: 'removed', d: 'M8.5 11h5.5' }),
  )
}

/**
 * Client plugin body.
 * @param ctx - the client cordis context (better-sidebar is ready).
 */
export function apply(ctx: Context): void {
  ctx.effect(() => registerDictionaries(ctx), 'dsh-hunk: dictionaries')
  ctx.effect(
    () => ctx.betterSidebar.registerTab({
      id: HUNK_TAB_ID,
      title: () => textNow(ctx, 'tab.title'),
      description: () => textNow(ctx, 'tab.description'),
      icon: hunkTabIcon(),
      order: HUNK_TAB_ORDER,
      single: true,
      component: HunkReviewTab,
    }),
    'dsh-hunk: review tab',
  )
}

/*
 * Test seam: the highlighter is browser code (bundled shiki), so the only way
 * to exercise it is through this bundle — `test/client.test.mjs` materializes
 * it the way the module system does and drives these exports directly.
 */
export {
  HIGHLIGHT_THEME,
  clearHighlightCache,
  highlightBlock,
  loadedLanguages,
  tokenizeSides,
} from './highlight'
export { languageForPath, TOKEN_FALLBACKS, LANGUAGE_EXTENSIONS } from '../shared/languages'
