/**
 * dsh-hunk client half.
 *
 * Registers one tab in DSH's OWN right Sidebar: 「Hunk 评审」(guide order 40,
 * one page per kind). No third-party sidebar plugin is involved — the native
 * registry is the same public two-stage path the product's own tabs use:
 *
 * 1. the tab TYPE (`ctx.sidebarRightTabs.register`) — identity, priority, chip
 *    title, and the guide entry that offers it on the new-tab page;
 * 2. the tab BODY (a keyed `sidebar.right.pane.tab` slot under the type's `id`).
 *
 * The body itself lives in ./HunkReviewTab.tsx, and everything it reads comes
 * from this plugin's own host route plus the client session list, so no Harness
 * Client package is imported and no Harness Client service is required beyond
 * the two the seats are declared on.
 */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { HunkReviewTab } from './HunkReviewTab'
import { registerDictionaries, textNow } from './i18n'

/**
 * Services this client plugin waits for.
 *
 * `sidebarRightTabs` is the tab-type registry and `slots` carries the body seat.
 * Waiting on the registry here (rather than inside a slot declaration) is
 * deliberate: the native seat declares `sidebar.right.pane.tab` BEFORE it
 * provides `sidebarRightTabs`, so a declaration-triggered registration can read
 * the service as missing and — because the declaration never collapses —
 * register nothing, permanently.
 */
export const inject = ['sidebarRightTabs', 'slots']

/** The tab type's implementation id, and the key its body registers under. */
export const HUNK_TAB_ID = 'dsh-hunk:review'

/** The tab kind that id opens (`openTab(HUNK_TAB_KIND)` names this type). */
export const HUNK_TAB_KIND = 'dsh-hunk:review'

/** Position of the guide entry that offers this tab on the new-tab page. */
export const HUNK_TAB_ORDER = 40

/** The body seat, keyed by the type's `id`. */
export const HUNK_BODY_SLOT = 'sidebar.right.pane.tab'

/** Structural face of `ctx.sidebarRightTabs` (see the note on `inject`). */
interface TabRegistryLike {
  register(definition: {
    id: string
    kind: string
    priority: 'extension' | 'builtin' | 'fallback'
    title: (address: string) => string
    guide?: readonly {
      id: string
      order: number
      title: () => string
      description?: () => string
      icon?: (props: { size?: number; className?: string }) => unknown
    }[]
  }): () => void
}

/** Structural face of `ctx.slots`, limited to what this plugin registers. */
interface SlotRegistryLike {
  inject(ownerKey: string, callback: () => () => void): () => void
  register(
    options: { name: string; key: string; inject?: (sessionId: string) => Record<string, unknown> },
    component: unknown,
  ): () => void
}

/**
 * A small diff glyph in `currentColor`, so it follows the skin like every other
 * sidebar icon (no literal colors, no icon data shipped). A component, not an
 * element: the guide seat renders it with its own `size`.
 * @param props - the seat's icon props.
 * @returns the glyph.
 */
export function HunkTabIcon({ size = 14, className }: { size?: number; className?: string }): ReactNode {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      'aria-hidden': true,
      ...(className === undefined ? {} : { className }),
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
 * @param ctx - the client cordis context (registry and slots are ready).
 */
export function apply(ctx: Context): void {
  ctx.effect(() => registerDictionaries(ctx), 'dsh-hunk: dictionaries')

  const registry = ctx.get('sidebarRightTabs') as TabRegistryLike | undefined
  if (registry === undefined) {
    // A cordis swallow would leave the sidebar without the tab and without a
    // symptom; say so once, where a reader will look.
    console.error('[dsh-hunk] sidebarRightTabs is missing: the tab type cannot be registered')
    return
  }
  ctx.effect(
    () => registry.register({
      id: HUNK_TAB_ID,
      kind: HUNK_TAB_KIND,
      // A tab from outside the product outranks the built-in viewers, which is
      // what lets this kind sit beside them instead of losing to a fallback.
      priority: 'extension',
      title: () => textNow(ctx, 'tab.title'),
      guide: [{
        id: HUNK_TAB_ID,
        order: HUNK_TAB_ORDER,
        title: () => textNow(ctx, 'tab.title'),
        description: () => textNow(ctx, 'tab.description'),
        icon: HunkTabIcon,
      }],
    }),
    'dsh-hunk: tab type',
  )

  const slots = ctx.get('slots') as SlotRegistryLike | undefined
  if (slots === undefined) {
    console.error('[dsh-hunk] slots is missing: the tab body cannot be registered')
    return
  }
  // Declaration-triggered: the seat that owns `sidebar.right.pane.tab` declares
  // it when it mounts, which may be after this plugin activates.
  ctx.effect(
    () => slots.inject(HUNK_BODY_SLOT, () => slots.register({
      name: HUNK_BODY_SLOT,
      key: HUNK_TAB_ID,
      inject: (sessionId: string) => ({ ctx, sessionId }),
    }, HunkReviewTab)),
    'dsh-hunk: tab body',
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
