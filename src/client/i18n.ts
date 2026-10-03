/**
 * DSH 文案：本插件在 DSH Web UI 里显示的所有可见文本。
 *
 * 语言选择走 DSH 的 locale 服务（`ctx.locale` 的快照 active 值），词典在这里；
 * locale 服务缺席时退回浏览器语言 + 这两份词典。zh 是键集基准，en 与它逐键对齐
 * （类型注解 `Record<HunkKey, string>` 保证漏一个键就编译不过）。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** 本插件在 DSH locale 注册表里的命名空间。 */
export const LOCALE_NS = 'dshHunk'

/** 中文词典（键集基准）。 */
export const zh = {
  'tab.title': 'Hunk 评审',
  'tab.description': '当前会话仓库的 live Hunk 会话：文件、hunk 与注释',
  'view.title': 'Hunk 评审',
  'action.refresh': '刷新',
  'action.refreshing': '刷新中…',
  'action.retry': '重试',
  'action.copy': '复制',
  'action.copied': '已复制',
  'loading': '正在读取 hunk 会话…',
  'updated.at': '更新于 {time}',
  'cwd.missing': '拿不到这个会话的 cwd，无法定位仓库',
  'error.title': '读取失败',
  'empty.title': '没有检测到本仓库的 live Hunk 会话',
  'empty.lead': '先在终端运行：',
  'empty.tip': '想看某个提交就换成 hunk show <ref>；开好后点「刷新」。',
  'empty.unregistered': '如果终端里其实开着 hunk diff --watch，那它没注册到 daemon（`hunk session list` 会报 No active Hunk sessions）——在窗口里 Ctrl+C 后重开一次即可。',
  'empty.others': '其它仓库的 live 窗口：',
  'empty.files': '这份 review 里没有文件（工作区当前没有改动）。',
  'summary.files': '{n} 个文件',
  'summary.notes': '{n} 条注释',
  'summary.hunks': '{n} 个 hunk',
  'summary.focus': '焦点',
  'summary.noFocus': '无焦点',
  'summary.commands': '数据来自',
  'note.user': '用户',
  'note.agent': 'agent',
  'note.ai': 'ai',
  'note.fileLevel': '文件级',
  'note.fileReview': '本文件的评审',
  'note.empty': '这份 review 还没有注释。',
  'lines.old': '旧 {n}',
  'lines.new': '新 {n}',
  'hunk.changes': '文件变动',
  'hunk.location': '位置',
  'hunk.expand': '展开这个 hunk 的变动',
  'hunk.collapse': '收起',
  'hunk.copy': '复制这个 hunk',
  'hunk.copied': '已复制',
  'hunk.patchLoading': '正在读取变动…',
  'hunk.patchFailed': '读取变动失败：{message}',
  'hunk.patchMissing': '这份 review 没有该文件的 patch 文本',
  'hunk.patchUnsupported': '宿主的 dsh-hunk 还没加载「变动读取」（需要重启 dsh web），重启后即可展开与复制',
  'hunk.copyUnsupported': '宿主未加载变动读取，暂时无法复制',
} as const

/** 本插件的文案键。 */
export type HunkKey = keyof typeof zh

/** 英文词典（与 zh 逐键对齐）。 */
export const en: Record<HunkKey, string> = {
  'tab.title': 'Hunk review',
  'tab.description': 'Live Hunk session for this repo: files, hunks and notes',
  'view.title': 'Hunk review',
  'action.refresh': 'Refresh',
  'action.refreshing': 'Refreshing…',
  'action.retry': 'Retry',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'loading': 'Reading Hunk sessions…',
  'updated.at': 'Updated {time}',
  'cwd.missing': 'This session exposes no cwd, so its repository cannot be located',
  'error.title': 'Failed to load',
  'empty.title': 'No live Hunk session for this repository',
  'empty.lead': 'Start one in a terminal first:',
  'empty.tip': 'Use hunk show <ref> to review a commit instead; then hit Refresh.',
  'empty.unregistered': 'If a hunk diff --watch is already running in a terminal, it is not registered with the daemon (`hunk session list` would say "No active Hunk sessions") — press Ctrl+C there and start it again.',
  'empty.others': 'Live windows in other repositories:',
  'empty.files': 'This review has no files (the working tree is clean).',
  'summary.files': '{n} files',
  'summary.notes': '{n} notes',
  'summary.hunks': '{n} hunks',
  'summary.focus': 'Focus',
  'summary.noFocus': 'no focus',
  'summary.commands': 'Source',
  'note.user': 'user',
  'note.agent': 'agent',
  'note.ai': 'ai',
  'note.fileLevel': 'file level',
  'note.fileReview': 'Review on this file',
  'note.empty': 'This review has no notes yet.',
  'lines.old': 'old {n}',
  'lines.new': 'new {n}',
  'hunk.changes': 'Changes',
  'hunk.location': 'Location',
  'hunk.expand': 'Show this hunk’s changes',
  'hunk.collapse': 'Collapse',
  'hunk.copy': 'Copy this hunk',
  'hunk.copied': 'Copied',
  'hunk.patchLoading': 'Loading changes…',
  'hunk.patchFailed': 'Could not load changes: {message}',
  'hunk.patchMissing': 'This review carries no patch text for the file',
  'hunk.patchUnsupported': 'This host has not loaded the patch read yet (restart dsh web), then hunks unfold and copy',
  'hunk.copyUnsupported': 'The host has not loaded the patch read, so this hunk cannot be copied yet',
}

/**
 * The locale service faces this plugin reads. Structural on purpose: DSH's
 * locale plugin is part of the shell (never absent in the Web profile), but
 * this plugin must not hard-depend on a package it does not ship.
 */
interface LocaleRuntimeLike {
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

/** Render `{name}` placeholders in one dictionary entry. */
function fill(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole)
}

/** Dictionary lookup for one active locale id. */
export function dictionaryFor(active: string): Record<HunkKey, string> {
  return active.toLowerCase().startsWith('zh') ? zh : en
}

/** The browser's language, used only when the locale service is absent. */
function browserLanguage(): string {
  return typeof navigator === 'undefined' ? 'en' : navigator.language || 'en'
}

/**
 * Register this plugin's dictionaries into the shared DSH locale registry.
 * Idempotent per activation: the returned disposer unregisters them.
 * @param ctx - client context.
 * @returns the disposer (a no-op when the deployment has no locale service).
 */
export function registerDictionaries(ctx: Context): () => void {
  const locale = ctx.get('locale') as LocaleRuntimeLike | undefined
  if (locale === undefined) return () => {}
  try {
    const offZh = locale.register(LOCALE_NS, 'zh', { ...zh })
    const offEn = locale.register(LOCALE_NS, 'en', { ...en })
    return () => { offZh(); offEn() }
  } catch (error) {
    // A namespace collision must not take the tab down: the built-in
    // dictionaries below still resolve every key.
    console.error('[dsh-hunk] locale registration failed:', error)
    return () => {}
  }
}

/** One translate function over this plugin's keys. */
export type Translate = (key: HunkKey, params?: Record<string, unknown>) => string

/**
 * Read `t` for the tab body, re-rendering when the user switches language.
 * @param ctx - client context.
 * @returns the namespace-bound translate function.
 */
export function useTranslate(ctx: Context): Translate {
  const locale = ctx.get('locale') as LocaleRuntimeLike | undefined
  const subscribe = useMemo(
    () => (locale === undefined
      ? () => () => {}
      : (listener: () => void) => locale.subscribe(listener)),
    [locale],
  )
  const active = useSyncExternalStore(
    subscribe,
    () => locale?.getSnapshot().active ?? browserLanguage(),
  )
  return useCallback<Translate>((key, params) => fill(dictionaryFor(active)[key] ?? en[key] ?? key, params), [active])
}

/**
 * Translate outside React — for the tab descriptor's `title` / `description`,
 * which better-sidebar evaluates on every tab-bar render (so the language
 * switch is picked up without a React hook of our own).
 * @param ctx - client context.
 * @param key - dictionary key.
 * @param params - `{name}` placeholders.
 * @returns the text for the active locale.
 */
export function textNow(ctx: Context, key: HunkKey, params?: Record<string, unknown>): string {
  const locale = ctx.get('locale') as LocaleRuntimeLike | undefined
  const active = locale?.getSnapshot().active ?? browserLanguage()
  return fill(dictionaryFor(active)[key] ?? en[key] ?? key, params)
}
