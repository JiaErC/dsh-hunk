# dsh-hunk

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) Web UI 的
[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 增加一个
**「Hunk 评审」侧栏 tab**（order 40，单实例）：把当前会话仓库里 live
[Hunk](https://github.com/) 会话的**文件 / hunk / 注释**列出来，带刷新按钮。

**v1 只读**：只读 Hunk 会话，不写评论、不导航、不改动 Hunk 或 DSH 源码；
挂载走 profile 的 `cordis.patch.yml`（本插件自带一份）。

---

## 它是怎么工作的

```
浏览器（client half）                       宿主（host half）
────────────────────────────                ────────────────────────────────
ctx.betterSidebar.registerTab(              GET /dsh-hunk/state?cwd=<会话 cwd>
  id: 'dsh-hunk:review', order: 40)           ├─ 1. hunk session list --json
        │                                     └─ 2. hunk session review --repo . \
        ▼  HunkReviewTab                            --json --include-notes
  ① 取会话 cwd：scope.cwd                         （两条都以该 cwd 为子进程 cwd）
     退路 POST /sidebar/api/session.cwd              │
  ② fetch /dsh-hunk/state?cwd=…                      ▼
  ③ 按文件渲染 hunk + 注释，刷新按钮重跑一遍      JSON（见 src/shared/wire.ts）
```

- **tab 注册**：`src/client/index.tsx` 用 `ctx.betterSidebar.registerTab(...)`
  注册 `dsh-hunk:review`；组件在 `src/client/HunkReviewTab.tsx`。
- **一条路由，两次读**：`src/index.ts` 只注册 `/dsh-hunk/state`。
  - 默认（结构读）：`hunk session list --json` + `hunk session review --repo . --json
    --include-notes` 并发跑，合成一个 JSON envelope（`ok / cwd / sessions / matched /
    otherRepos / review / reviewError`）。
  - `?patches=1`（变动读，按需）：同一条命令加 `--include-patch`，返回
    `patches: { 文件路径 → 原始 unified diff 文本 }`。只有展开 hunk 或点复制时才请求，
    主机侧 5 秒 TTL + 同键合并，避免每次刷新都重建整份 patch；没有 live 会话时
    先用廉价的 `session list` 判掉，不去跑那条昂贵的命令。
- **没有 live 会话时**：路由照样 200，`matched: null`，页面显示
  「先在终端运行 `cd <cwd> && hunk diff --watch`」并列出其它仓库的 live 窗口。
- **两个「半」互相不认识**：它们只共享 `src/shared/` 里的纯类型与纯函数，因此
  client bundle 不需要任何 DSH 包（react 来自宿主的 module table）。

## 界面

- **顶部会话条**（`dsh-hunk working tree` 那块）是唯一显示汇总的地方：文件数、
  注释总数、当前焦点、产生这份数据的命令。
- **文件行**：路径、`+N −M`、hunk 数；点击折叠/展开这个文件。
- **hunk 行**：`#序号 + @@ 段头 + 旧/新行范围`；点行展开看这段的**文件变动**
  （带行号的 diff 正文，配色沿用宿主的 diff 令牌：增绿、删红、8% 底色），
  展开区顶部写明这条 hunk 的**位置**（文件路径 + 行范围）。
  hunk 行右上的**复制图标**把这一整段 hunk（`@@` 头 + 正文）复制成可直接粘贴的
  patch 片段；没展开也能点，会先按需拉一次 patch 文本。
- 注释挂在对应 hunk 下方；锚点失效的注释归到文件的「文件级」分组，不会消失。


## 目录

| 路径 | 作用 |
|---|---|
| `src/index.ts` | host 半：插件入口 + `/dsh-hunk/state` 路由 |
| `src/host/hunk-cli.ts` | 跑 `hunk` CLI、解析 JSON、匹配 cwd、合成 payload |
| `src/host/trust-fence.ts` | 浏览器信任围栏（同 `/api` 的规则：Host + 同源标记） |
| `src/shared/wire.ts` | 两端共享的线上类型与错误码 |
| `src/shared/notes.ts` | 注释→hunk 归位（按 `hunkIndex`，退回行范围重叠） |
| `src/shared/patch.ts` | unified diff 文本 → 单条 hunk 切片、行号解析、行类型判定 |
| `src/client/index.tsx` | client 半：注册 tab |
| `src/client/HunkReviewTab.tsx` | tab 视图（会话条 + 文件/hunk/注释 + 刷新/复制） |
| `src/client/api.ts` | 浏览器侧请求（cwd 解析 + 结构读 + 按需 patch 读） |
| `src/client/i18n.ts` | zh/en 词典，跟随 `ctx.locale` |
| `src/client/styles.ts` | 全部走 `--dsw-alias-*` / `--dsw-font-mono` 主题令牌 |
| `build.mjs` | esbuild：host 出 ESM，client 出 `__ModuleLoader__.load` 包装 |
| `test/*.test.mjs` | 记录型 payload 单测 + 真实 CLI 活体测试 + 假 webserver 路由测试 + client bundle 测试 |
| `scripts/preview.mjs` | 不开浏览器，直接打印 tab 会渲染的那份 JSON |

## 构建

```powershell
npm install
npm run typecheck     # tsc --noEmit
npm test              # 先构建，再跑 22 个用例（含真实 hunk CLI 活体用例）
npm run preview       # 打印当前目录的 payload；npm run preview -- --json 看原文
```

产物：`lib/index.js`（host）、`lib/client.js`（浏览器）、`lib/types/**`。

## 挂载到 profile

本插件零运行时依赖（host 半只用 `node:`，client 半只用宿主的 react），
所以挂载只需要「link 进 profile + patch 一行 + 重装/重启」。

1. **link 进 profile**：编辑 `$env:DSH_PROFILE_DIR\package.json`（当前部署是
   `D:\.dsh\profiles\web\package.json`），在 `dependencies` 加：

   ```json
   "dsh-hunk": "link:E:\\AI_mcp_projects\\dsh-hunk"
   ```

2. **插入 Loader 行**：在同一个 profile 的 `cordis.patch.yml` 追加（文件末尾）：

   ```yaml
   - insert:
       - id: dsh-hunk
         name: dsh-hunk
   ```

   （这三行就是本包 `cordis.patch.yml` 的内容；把本包列进 profile 的
   `dsh.profile.bundles` 也能达到同样效果。）

3. **装依赖**：在 profile 目录跑 `pnpm install`。

4. **生效**：
   - client 半：浏览器硬刷新（Ctrl+Shift+R）即可看到 `+` 菜单里的「Hunk 评审」；
   - host 半：`dsh web` 需要重启才会挂上 `/dsh-hunk/state`（重启 web 会中断当前会话）。

> 也可以走 `plugin_manager` 的 `install_bundle`（把本包目录作为 target），
> 由它代替第 1–3 步；本 preset 里该工具被禁用，所以上面给的是手工路径。

## 使用上的前提

- 终端里先有 live Hunk 窗口：`cd <仓库> && hunk diff --watch`
  （看某个提交：`hunk show <ref>`）；本 tab 读的就是这个窗口。
- **窗口必须还注册在 daemon 上**：`hunk session list` 要能列出它。daemon 中途重启过
  （`hunk daemon serve` 换过进程）时，先开的窗口会失去注册——症状是 `hunk.exe` 进程还在，
  但 `hunk session list` 报 `No active Hunk sessions`、tab 显示「没有检测到 live Hunk 会话」。
  在窗口里 Ctrl+C 再用 `hunk diff --watch` 重开一次即可重新注册。
- `hunk` 要在宿主进程的 PATH 上。装在别处时设 `DSH_HUNK_BIN`（例如
  `C:\Users\me\AppData\Local\Programs\hunk\hunk.exe`），或用
  `DSH_HUNK_TIMEOUT_MS` 调整每命令的超时（默认 15000 ms）。

## 安全边界

- **围栏**：`/dsh-hunk/state` 自己判断 `Host` 头（回环地址，或部署声明的
  `webRuntime.trustedHosts`），并要求浏览器标记同源；`sec-fetch-site: cross-site`
  与不匹配的 `Origin` 一律 403。这是 DNS-rebinding / 跨站防御，不是鉴权。
- **cwd 校验**：请求里的 `cwd` 必须是存在的绝对目录，否则 400；它只被当作子进程
  工作目录，**不会**被拼进命令行——argv 是固定的。
- **只读**：路由只跑 `session list` / `session review`，不碰 `comment *`、
  `navigate`、`reload`。

## 已知限制（v1）

- 只读：不能在 tab 里写/删注释、不能把 Hunk 窗口跳转到某个文件或 hunk。
- 刷新是手动的（打开 tab / 切回 tab 时会自动读一次，没有轮询）；刷新会丢弃已缓存的
  patch 文本，下次展开 hunk 时重新拉。
- 变动读要给每个文件重建一份 patch，所以第一次展开 hunk 有一次可感知的等待；
  之后同一 cwd 的展开与复制都走缓存。
- 视图只验证到「host 路由返回真实数据 + client bundle 注册出正确的 tab 描述符」；
  浏览器里的观感需要人工确认（本仓库的自动化测试跑不出真实渲染）。
- `lib/` 是构建产物（已 gitignore），挂载前需要 `npm run build`；改动 host 半后
  `dsh web` 必须重启才会加载新的 `lib/index.js`。
