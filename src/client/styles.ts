/**
 * Inline styles for the tab body.
 *
 * Inline (not a CSS module) on purpose: this bundle ships no stylesheet, so
 * there is nothing to inject or clean up on unload. Every color and font comes
 * from a DSH theme token, so the tab follows the active skin, light/dark
 * switching, and any future token rename (a missing token degrades the
 * appearance, never the rendering).
 */
import type { CSSProperties } from 'react'

/** Theme tokens this view consumes. */
export const token = {
  /** Panel surface — the same token every DSH sidebar page paints on. */
  surface: 'var(--dsw-alias-bg-layer-1)',
  /** Raised blocks inside the panel (cards, header strips). */
  raised: 'var(--dsw-alias-bg-layer-2)',
  /** Sunken blocks (command lines, hunk headers). */
  sunken: 'var(--dsw-alias-bg-base)',
  border: 'var(--dsw-alias-border-l2)',
  /**
   * Skin-layer names, each with a host-defined fallback.
   *
   * `--dsw-alias-hairline` / `-accent` / `-accent-soft` / `-danger` and
   * `--dsw-font-mono` are **not defined by the DSH theme package** — not in
   * 0.1.7-rc.2 (395 tokens) and not in 0.2.0-rc.2 (404 tokens); better-sidebar
   * itself uses them, so they are a skin-layer set that exists only when a skin
   * supplies it. An unset custom property makes the whole declaration *invalid at
   * computed-value time*: the border or background silently falls back to its
   * initial value instead of the intended colour. Each one therefore carries a
   * fallback from the alias family this build really defines — and
   * `test/theme-tokens.test.mjs` re-checks that on every later upgrade.
   */
  hairline: 'var(--dsw-alias-hairline, var(--dsw-alias-border-l1))',
  text: 'var(--dsw-alias-label-primary)',
  textSecondary: 'var(--dsw-alias-label-secondary)',
  textTertiary: 'var(--dsw-alias-label-tertiary)',
  accent: 'var(--dsw-alias-accent, var(--dsw-alias-state-business-primary))',
  accentSoft: 'var(--dsw-alias-accent-soft, var(--dsw-alias-state-business-tertiary))',
  danger: 'var(--dsw-alias-danger, var(--dsw-alias-state-error-primary))',
  success: 'var(--dsw-alias-state-success-primary)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  /**
   * The surface ladder, in one place.
   *
   * `bg-layer-2`/`-3` are the *same colour* as `bg-layer-1` in the light theme
   * (all three resolve to `neutral-bluish-00`; only a skin with explicit layer
   * values makes them differ), so a grey surface has to be a translucent wash:
   * `#2631480f` over a light panel, `#ffffff14` over a dark one. Three steps of
   * that wash are what this view's hierarchy is built from.
   */
  tint: 'var(--dsw-alias-interactive-bg-hover)',
  /** One step stronger: an open hunk row, and the hover state of any row. */
  tintStrong: 'var(--dsw-alias-interactive-bg-active)',
  /** Two steps stronger: the file row, so a group header reads above its hunks. */
  tintHeader: 'var(--dsw-alias-interactive-bg-hover-accent)',
  /** Code font: the skin's mono first, then the host's own code-block family. */
  mono: 'var(--dsw-font-mono, var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace))',
} as const

const fontFamily = 'inherit'

/** Every style object the tab uses. */
export const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: token.surface,
    color: token.text,
    fontSize: 12.5,
    lineHeight: 1.5,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    padding: '8px 10px',
    borderBottom: `1px solid ${token.hairline}`,
  },
  headerTitle: { fontWeight: 600 },
  spacer: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 10px 18px' },
  muted: { color: token.textTertiary },
  secondary: { color: token.textSecondary },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 9px',
    borderRadius: 6,
    border: `1px solid ${token.border}`,
    background: token.raised,
    color: token.text,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily,
    whiteSpace: 'nowrap',
  },
  buttonBusy: { opacity: 0.6, cursor: 'default' },
  strip: {
    padding: '8px 10px',
    marginBottom: 10,
    border: `1px solid ${token.border}`,
    borderRadius: 8,
    background: token.raised,
  },
  stripTitle: { fontWeight: 600, marginBottom: 2, wordBreak: 'break-word' },
  stripMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    color: token.textTertiary,
    fontSize: 11.5,
  },
  /**
   * One reviewed file. Deliberately unboxed: the only rounded frame on screen
   * belongs to the diff body, so the box reads as "this is the code" instead of
   * enclosing the review's notes along with it.
   */
  card: {
    marginBottom: 8,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '7px 9px',
    border: 'none',
    borderRadius: 6,
    // The group header sits one step above its hunks (see the ladder on
    // `token.tint`): darker grey, same rounding.
    background: token.tintHeader,
    color: token.text,
    cursor: 'pointer',
    fontFamily,
    fontSize: 12.5,
    textAlign: 'left',
  },
  caret: { flexShrink: 0, color: token.textTertiary, fontSize: 10 },
  filePath: { flex: 1, minWidth: 0, fontFamily: token.mono, wordBreak: 'break-all' },
  previousPath: { color: token.textTertiary, fontFamily: token.mono, fontSize: 11.5, wordBreak: 'break-all' },
  counts: { flexShrink: 0, display: 'inline-flex', gap: 5, fontSize: 11.5 },
  additions: { color: token.success },
  deletions: { color: token.danger },
  badge: {
    flexShrink: 0,
    padding: '0 5px',
    borderRadius: 999,
    border: `1px solid ${token.border}`,
    color: token.textSecondary,
    fontSize: 10.5,
    lineHeight: '15px',
  },
  badgeFocus: {
    flexShrink: 0,
    padding: '0 5px',
    borderRadius: 999,
    border: `1px solid ${token.accent}`,
    background: token.accentSoft,
    color: token.text,
    fontSize: 10.5,
    lineHeight: '15px',
  },
  hunk: { padding: '7px 9px', borderTop: `1px solid ${token.hairline}` },
  hunkIndex: { color: token.textTertiary, fontSize: 11, flexShrink: 0 },
  hunkHeader: {
    flex: 1,
    minWidth: 0,
    fontFamily: token.mono,
    fontSize: 11.5,
    color: token.textSecondary,
    background: token.sunken,
    borderRadius: 4,
    padding: '1px 5px',
    wordBreak: 'break-all',
  },
  note: {
    marginTop: 6,
    paddingLeft: 8,
    border: `1px solid ${token.border}`,
    borderLeft: `2px solid ${token.accent}`,
  },
  noteMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    color: token.textTertiary,
    fontSize: 11,
    marginBottom: 2,
  },
  noteTitle: { color: token.textSecondary, fontWeight: 600 },
  noteBody: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  codeRow: { display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 4 },
  codeRowCode: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    padding: '6px 8px',
    border: `1px solid ${token.border}`,
    borderRadius: 6,
    background: token.sunken,
    fontFamily: token.mono,
    fontSize: 11.5,
    wordBreak: 'break-all',
  },
  empty: {
    padding: '10px 12px',
    border: `1px dashed ${token.border}`,
    borderRadius: 8,
    background: token.raised,
  },
  emptyTitle: { fontWeight: 600, marginBottom: 6 },
  list: { margin: '4px 0 0', paddingLeft: 18, color: token.textSecondary, fontFamily: token.mono, fontSize: 11.5 },
  failure: {
    padding: '9px 11px',
    border: `1px solid ${token.danger}`,
    borderRadius: 8,
    marginBottom: 10,
  },
  failureTitle: { fontWeight: 600, marginBottom: 4 },
  failureMessage: { color: token.textSecondary, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },

  /* ── hunk rows: header, copy affordance, and the expanded diff body ────── */

  hunkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '3px 6px',
    border: 'none',
    borderRadius: 6,
    // A change row is a surface, not blank space: the tint reads as light grey
    // on a light panel and as a lift on a dark one (see `token.tint`).
    background: token.tint,
    color: token.text,
    cursor: 'pointer',
    fontFamily,
    fontSize: 12.5,
    textAlign: 'left',
  },
  /** The open hunk's row, and the hover state of any hunk row. */
  hunkRowActive: { background: token.tintStrong },
  hunkHead: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 },
  iconButton: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 20,
    padding: 0,
    border: `1px solid transparent`,
    borderRadius: 5,
    background: 'transparent',
    color: token.textTertiary,
    cursor: 'pointer',
  },
  iconButtonHover: {
    border: `1px solid ${token.border}`,
    background: token.hover,
    color: token.text,
  },
  iconButtonDone: { color: token.success },
  hunkBody: { marginTop: 4 },
  locationRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
    color: token.textTertiary,
    fontSize: 11,
  },
  locationPath: { fontFamily: token.mono, color: token.textSecondary, wordBreak: 'break-all' },
  diffBody: {
    border: `1px solid ${token.border}`,
    borderRadius: 6,
    background: token.sunken,
    padding: '3px 0',
    overflowX: 'auto',
  },
  diffRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    padding: '0 8px',
    fontFamily: token.mono,
    fontSize: 11,
    lineHeight: '17px',
    whiteSpace: 'pre',
  },
  diffNo: {
    flex: '0 0 auto',
    width: 30,
    textAlign: 'right',
    color: token.textTertiary,
    userSelect: 'none',
  },
  diffSign: { flex: '0 0 auto', width: 8, userSelect: 'none' },
  diffText: { flex: '0 0 auto' },
  /** Faint tint under changed lines, mirroring the host diff's 8% mixes. */
  diffAdd: { background: `color-mix(in srgb, ${token.success} 8%, transparent)` },
  diffDel: { background: `color-mix(in srgb, ${token.danger} 8%, transparent)` },
  diffAddText: { color: token.success },
  diffDelText: { color: token.danger },
  diffMetaText: { color: token.textTertiary, fontStyle: 'italic' },
  diffNotice: { padding: '2px 8px', color: token.textTertiary, fontSize: 11 },

  /* ── side-by-side diff rows (left = old, right = new) ──────────────────── */

  splitRow: {
    display: 'flex',
    alignItems: 'stretch',
    fontFamily: token.mono,
    fontSize: 11,
    lineHeight: '17px',
  },
  splitSide: {
    flex: '1 1 50%',
    minWidth: 0,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 5,
    padding: '0 6px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  splitNo: {
    flex: '0 0 auto',
    width: 24,
    textAlign: 'right',
    color: token.textTertiary,
    userSelect: 'none',
  },
  /** The `-` / `+` marker, so each column reads like the TUI's diff rows. */
  splitSign: { flex: '0 0 auto', width: 7, userSelect: 'none' },
  splitText: { flex: '1 1 auto', minWidth: 0 },
  splitDivider: { flex: '0 0 auto', width: 1, background: token.border },
  splitMeta: {
    padding: '0 8px',
    color: token.textTertiary,
    fontStyle: 'italic',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  /** A note drawn inside the diff, directly under the lines it reviews. */
  noteInline: {
    margin: '1px 0 3px',
    paddingLeft: 8,
    borderLeft: `2px solid ${token.accent}`,
    background: token.raised,
  },
  /** A collapsed file's review: the notes stay on screen, the code does not. */
  collapsedReview: {
    padding: '2px 9px 6px',
    borderTop: `1px solid ${token.hairline}`,
  },
  collapsedReviewTitle: {
    color: token.textTertiary,
    fontSize: 11,
    margin: '2px 0 4px',
  },
  /** The window-opening notice: quiet while it is merely reporting progress. */
  watch: {
    marginBottom: 8,
    padding: '7px 9px',
    borderRadius: 6,
    background: token.tint,
    color: token.textSecondary,
    fontSize: 12,
  },
  /** The same notice when the reader has to act (failed / unsupported / cooldown). */
  watchLoud: {
    marginBottom: 8,
    padding: '7px 9px',
    borderRadius: 6,
    background: token.tintStrong,
    color: token.text,
    fontSize: 12,
  },
} satisfies Record<string, CSSProperties>
