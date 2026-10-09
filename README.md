# dsh-hunk

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) Web UI **自带右侧栏**
增加一个 **「Hunk 评审」tab**（guide order 40，单实例）：把当前会话仓库里 live
[Hunk](https://github.com/) 会话的**文件 / hunk / 注释**列出来，带刷新按钮。

**v1 只读**：只读 Hunk 会话，不写评论、不导航、不改动 Hunk 或 DSH 源码；
挂载走 profile 的 `cordis.patch.yml`（本插件自带一份）。

**不依赖任何第三方侧栏插件**：注册用的是 DSH 自己的原生 tab 注册表
（`ctx.sidebarRightTabs` + `sidebar.right.pane.tab` 席位），和产品自带 tab 走同一条
两段式注册路径。装不装 `dsh-better-sidebar` 都不影响这个 tab。

---

## 它是怎么工作的

```
浏览器（client half）                       宿主（host half）
────────────────────────────                ────────────────────────────────
① ctx.sidebarRightTabs.register({           GET /dsh-hunk/state?cwd=<会话 cwd>
     id/kind: 'dsh-hunk:review',               ├─ 1. hunk session list --json
     priority: 'extension',                    └─ 2. hunk session review --repo . \
     guide: [{ order: 40, … }] })                   --json --include-notes
② ctx.slots.register(                          （两条都以该 cwd 为子进程 cwd）
     'sidebar.right.pane.tab',                     │
     key: 'dsh-hunk:review')                        ▼
        ▼  HunkReviewTab                     JSON（见 src/shared/wire.ts）
   取会话 cwd：sessions.list 快照（live）
   ③ fetch /dsh-hunk/state?cwd=…
   ④ 按文件渲染 hunk + 注释，刷新按钮重跑一遍
```

- **tab 注册（原生，两段式）**：`src/client/index.tsx` 先用
  `ctx.sidebarRightTabs.register(...)` 注册 tab **类型**（id/kind、`priority:
  'extension'`、chip 标题、以及让它在"新建标签页"列表里出现的 guide 条目），再把
  **body** 注册到 `sidebar.right.pane.tab` 这个 keyed 席位下、键就是那个类型 id。
  组件在 `src/client/HunkReviewTab.tsx`，它收到的 props 是
  `{ ctx, sessionId, useTabInfo }`：框架给的 per-tab 读取钩子 + 我们在 body 注册时
  注入的上下文。
- **cwd 从客户端会话列表 live 读**（`src/client/session-cwd.ts`）：`sessions.list`
  快照的 `byId[sessionId].cwd`，用 `useSyncExternalStore` 订阅，所以会话刚加载完
  cwd 出现时页面会自己跟上，不需要重开或重试。
- **三条路由**：`/dsh-hunk/state`（只读，GET）、`/dsh-hunk/watch`（开窗，POST）、
  `/dsh-hunk/reload`（切换窗口读什么，POST）。
  - 默认（结构读）：先 `hunk session list --json`，**只有匹配到本仓库的窗口时才**再跑
    `hunk session review --repo . --json --include-notes`。顺序是被一个真实截图纠正的：
    选择器匹配不到任何东西时，这条 review 命令会以
    `hunk: protocol-validation-failed` 失败（三种仓库实测一字不差——有提交的、没提交的、
    报障那个），那只是这个 hunk 版本表达「没有匹配的 live 会话」的方式，把它当正文显示等于
    让读者以为坏了；而且没有窗口时本来也无从 review，那一次 hunk 启动纯属白跑。
    合成一个 JSON envelope（`ok / cwd / sessions / matched / otherRepos / review / reviewError`）。
  - `?patches=1`（变动读，按需）：同一条命令加 `--include-patch`，返回
    `patches: { 文件路径 → 原始 unified diff 文本 }`。只有展开 hunk 或点复制时才请求，
    主机侧 5 秒 TTL + 同键合并，避免每次刷新都重建整份 patch；没有 live 会话时
    先用廉价的 `session list` 判掉，不去跑那条昂贵的命令。
  - `POST /dsh-hunk/watch`（开窗，见下节）：`{ cwd }` 进去，`{ action, pid, command }`
    出来。**只有开窗与切换是 POST**——GET 会被预取和重试反复打到，一个会拉进程的 GET 是陷阱。
  - `POST /dsh-hunk/reload`（切换读取目标，见下节）：`{ cwd, target }` 进去，`target` 只能是
    `working-tree` 或 `last-commit` 两个**枚举值之一**（不接受调用方给的任意 revision——这个值
    会进 argv）；换掉的是用户窗口正在看的内容，所以只有点了按钮才会发生。
- **没有 live 会话时**：路由照样 200，`matched: null`，页面显示
  「先在终端运行 `cd <cwd> && hunk diff --watch`」并列出其它仓库的 live 窗口；
  Windows 上还会先自动开一个（下一节）。
- **两个「半」互相不认识**：它们只共享 `src/shared/` 里的纯类型与纯函数，因此
  client bundle 不需要任何 DSH 包（react 来自宿主的 module table）。

## 这个面板只能显示"你的窗口在读什么"

tab 读的是 `hunk session review`，也就是**那个 live 窗口当前持有的那份 review**。所以
「0 个文件」有两种完全不同的原因：工作区确实没有改动，或者窗口读的不是你想看的东西——
而 AI 每轮结束都会提交，于是**每轮之后工作区都是干净的，想看的东西在提交里**。

界面上的做法是把它说清楚，并给出两个按钮：

```
这个 Hunk 窗口正在读：[dsh-hunk working tree]      [让窗口读工作区] [让窗口读最近一次提交]
```

- 按钮走 `hunk session reload --repo . -- diff` / `-- show HEAD`（实测：切换后
  `hunk session review` 立刻返回那次提交的文件），切完 tab 自己重读一次。
- 这是本插件唯一会**改动用户窗口内容**的操作，所以绝不自动发生：只有你点按钮才会切。
- 查看更早的历史仍然是窗口自己的事（在窗口里用 `hunk log` / `hunk show <ref>`），tab 会跟着变。

## 没装 hunk 时

这台机器上没有 hunk 的时候，页面**不是**一个报错框，而是一份安装引导
（`src/client/install.ts` + `InstallGuide`）：装什么、怎么装（按系统给出 hunk 官方 README 里
的那几条路线：`npm i -g hunkdiff` 需要 Node 22+、Windows 也可用 mise、macOS/Linux 还有 brew
与 `curl -fsSL https://hunk.dev/install.sh | sh`）、怎么让宿主找得到它（`DSH_HUNK_BIN` 指向
可执行文件的绝对路径）、怎么验证（`hunk --version`）、以及**装完必须重启 `dsh web`**
（宿主只在启动时读一次 PATH 与 `DSH_HUNK_BIN`）。

引导里有两个动作：

- **让 DSH 帮我装 hunk**：把一段现成的请求**注入当前会话**，让本会话的 agent 去装。走的是
  DSH 自己的会话通道——`ctx.sessions.binding(sessionId).session.prompt([{type:'text',…}],
  'queue')`，也就是聊天输入框发消息用的那条路（先用 `beginSubmission` 登记本地回显，聊天里
  立刻能看到这条消息；prompt 失败则 `abandon()` 收回回显）。**queue 而不是 steer**：这是
  "请顺手做" 而不是 "打断你手上的活"。文本是词典里的一条固定文案（中文/英文各一份，跟随界面
  语言），只有 cwd 与宿主的诊断行是变量——不接受任何自由输入。
- **复制提示词**：万一会话通道在这个页面拿不到（`binding()` 返回空），把它复制到剪贴板，
  你自己粘到对话框里发。

宿主侧的识别是现成的：`hunk` 起不来（spawn 层失败，`ENOENT` 之类）时 `/dsh-hunk/state`
返回 503 + `hunk-cli-missing`，tab 就把上面这份引导渲染出来，而不是通用错误框。

## 自动打开 Hunk 窗口

Git 仓库里没有本仓库的 live 会话时，tab 会**自动开一个 Hunk 窗口**，省掉"先自己去终端敲
一条命令"这一步。判定与动作都在宿主（`src/host/watch-start.ts`）：

1. 目录在 Git 工作树里吗（`git rev-parse --show-toplevel`）——不是就什么都不做；
2. 已经有本仓库的 live 会话吗（`hunk session list --json` + 路径匹配，**子目录也算**）——有就不开；
3. 之前开的那个还活着吗——**pid 必须仍是一个 hunk 进程**：Windows 会复用 pid，只探"存活"
   会把别人的进程当成自己的窗口（真实症状就是「有个窗口在跑」和「没有 live 会话」同时出现）；
4. 活着、且开出来不到 30 秒——那是**还在注册**，等它；
5. 活着、已超过 30 秒、`session list` 里仍然没有它——**它掉注册了**（daemon 中途被换掉就会
   这样：窗口还在，daemon 永远不再认它）：**另开一个**把它替掉，同一目录 5 分钟内最多替一次；
6. 死了（或 pid 已被复用）——10 分钟内不再开（你关窗口是决定，不是故障，
   跟你的关闭动作打架最讨厌）；
7. 都没问题才开，并记下 pid。一个宿主进程最多开 8 个，防呆。

「打开 Hunk 窗口」按钮只在需要你动手时出现（冷却中 / 掉注册 / 失败 / 等到超时），而且
**按钮不受冷却限制**——你明确要开，宿主就不跟你争；git、平台、已存在的会话这些判定照旧。

**为什么是"新控制台窗口"而不是后台子进程**：`hunk diff --watch` 明确拒绝没有交互终端的
运行，实测原话是

```
hunk: `--watch` requires an interactive output terminal.
Remove `--watch` when redirecting or piping Hunk's output.
```

而且此时**不会**注册任何会话——后台 detach 起一个 `--watch` 是白起。hunk 1.4.2 也没有
无终端的替代入口（`hunk session` 只能查看/控制已存在的会话，`hunk diff` 没有
`--serve`/`--browser`）。所以宿主在 Windows 上走
`powershell Start-Process -PassThru`：它既给子进程一个真终端（新控制台窗口，你能看见、
AI 写的注释也显示在那里），又能把 pid 报回来给第 3 步用。（`cmd /c start` 从无控制台的父
进程里起是静默失败，实测无进程、无日志、无会话，所以没用它。）

- **代价与预期**：窗口冷启动到注册需要几秒（本机实测 8–9 秒，hunk 要顺手拉起自己的
  daemon），期间 tab 每 3 秒重读一次、最多等 30 秒，文案从「已为你打开…等待注册」变成
  「开了但没注册上，看一眼那个窗口」。
- **关掉自动开窗**：宿主上设 `DSH_HUNK_AUTOSTART=0`，tab 就不再自动开（只是告诉你没会话，
  以及那条命令）；手动「打开 Hunk 窗口」按钮也会一起停用。
- **只在这台机器上、只在这个目录里**：路由有自己的信任围栏（回环 Host 或
  `trustedHosts` + 同源标记），argv 写死为 `diff --watch`，**目录只来自请求里的 cwd**
  且必须是存在的绝对目录。这条路由是唯一有副作用的接口，放宽 `trustedHosts` 前先想清楚。
- **非 Windows**：没有可用的新控制台启动方式，返回 `unsupported` 并把命令交给你手动跑——
  不猜、不模拟终端。

## 界面

- **顶部会话条**（`dsh-hunk working tree` 那块）是唯一显示汇总的地方：文件数、
  注释总数、当前焦点、产生这份数据的命令。
- **文件行**：路径、`+N −M`、hunk 数。收起时 hunk 行与变动内容收起，但**这个文件的
  评审注释仍然列在它下面**——注释是你看这份 review 的目的，不该被折叠弄丢；没有
  注释的文件收起后就只剩这一行。
- **hunk 行**：`#序号 + @@ 段头 + 旧/新行范围`；点行展开看这段的**文件变动**，
  展开区顶部写明这条 hunk 的**位置**（文件路径 + 行范围）。hunk 只管自己的代码：
  收起它只是把代码收起来，它的注释仍然列在 hunk 行下方（不会被折叠藏掉）。
  hunk 行右上的**复制图标**把这一整段 hunk（`@@` 头 + 正文）复制成可直接粘贴的
  patch 片段；没展开也能点，会先按需拉一次 patch 文本。
- **变动是并排两列**：左列是删除的旧行（`-` 前缀、红字红底）、右列是新增行
  （`+` 前缀、绿字绿底），同一处替换按行配对（删 3 行加 1 行就是 1 行配对 +
  2 行左侧留空）；上下文行两侧镜像、各自带行号，`\ No newline at end of file`
  这类标记整行跨列。配色沿用宿主的 diff 令牌（8% 底色）。
- **只有代码画框**：屏幕上唯一的圆角边框属于 diff 正文，文件条目本身不画框，
  注释不会被框进去——一眼就能分出「这是代码」和「这是评审」。
- **代码高亮和宿主同一个引擎**：用 shiki 的同步 core + JS 正则引擎
  （`createHighlighterCoreSync` / `createJavaScriptRegexEngine`），主题用
  `createCssVariablesTheme`，token 颜色交给 `--shiki-*` 变量——和宿主
  `ui-primitives` 完全一致。差别只有一处：我们给这些变量配了 **DSH alias 令牌
  兜底**（`var(--shiki-token-keyword, color-mix(…))`），所以皮肤没定义 `--shiki-*`
  时也是有颜色的代码，而不是整片同色。语言按扩展名判定（ts/tsx/js/jsx/json/sh/
  py/go/rust/java/c/yaml/toml/ini/md/css/html/xml/sql/diff/ps1/lua/kt/make/
  Dockerfile），未命中的文件按纯文本渲染（和加高亮之前一样）。两侧各自作为一整块
  tokenize（块注释、多行字符串才认得对），再按行贴回并排的两列。
- **注释贴在代码上**：展开某个 hunk 时，它的注释直接插在 diff 里、落在被评论的
  那几行下面（跨行锚点落在范围的最后一行；旧/新锚点同时存在时以新侧为准）。
  hunk 收起时注释回到 hunk 行下方——和展开前一样。锚点不在本段 diff 里的注释
  也留在下方，不会因为折叠状态而消失。
- **两级的职责分清楚**：文件行 = 这份文件的**变动内容**看不看（收起时代码与 hunk 行
  收起，注释留下），hunk 行 = 这段代码看不看（收起只收代码，注释留着）。
- **灰阶靠半透明叠色，不靠 `bg-layer-*`**：浅色主题里 `--dsw-alias-bg-layer-1/2/3`
  是同一个颜色（都解析成 `neutral-bluish-00`，只有皮肤显式覆盖才会不同），所以用
  `interactive-bg-hover / -active / -hover-accent` 搭三级灰阶：hunk 行最浅、展开中或
  悬停时加深一档、文件行最深的那个圆角矩形（组头压在它的 hunk 之上）。浅深主题自动跟随。



## 版本与发版

当前版本 **v0.3.0**（`package.json#version` 是版本源，tag 与它必须一致）。
本项目 `private: true`、用 `link:` 挂载，**不发布到 npm**，所以一次「发版」= 版本号 +
[CHANGELOG](CHANGELOG.md) 条目 + 轻量 tag：

```bash
git tag                 # v0.1.0（追认）、v0.2.0、v0.3.0
git describe --tags     # v0.3.0
```

**兼容基线**：本版实测于 **DSH 0.2.0-rc.2**（cordis 4.0.4；搭档的 better-sidebar
0.24.1 只作为「同一台机器上装了它」的参考，**不是依赖**）；上一档基线 DSH 0.1.7-rc.2
对应 v0.2.0 及以前（那时 tab 走的是 better-sidebar）。本插件不声明
`@deepseek-ai/dsh` peer，理由与「换版本时逐条复核什么」见 AGENTS §5。

- 分支模型、提交规范（Conventional Commits + 中文正文）、发版四步 →
  **[AGENTS.md](AGENTS.md)**。
- 完整发布历史（含每版的实测证据）→ **[CHANGELOG.md](CHANGELOG.md)**。
- 本地调试与安装脚本 → **[DEBUGGING.md](DEBUGGING.md)**。

## 目录

| 路径 | 作用 |
|---|---|
| `src/index.ts` | host 半：插件入口 + `/dsh-hunk/state` 路由 |
| `src/host/hunk-cli.ts` | 跑 `hunk` CLI、解析 JSON、匹配 cwd、合成 payload |
| `src/host/trust-fence.ts` | 浏览器信任围栏（同 `/api` 的规则：Host + 同源标记） |
| `src/shared/wire.ts` | 两端共享的线上类型与错误码 |
| `src/shared/notes.ts` | 注释→hunk 归位（按 `hunkIndex`，退回行范围重叠） |
| `src/shared/patch.ts` | unified diff 文本 → 单条 hunk 切片、行号解析、行类型判定 |
| `src/client/index.tsx` | client 半：把 tab 类型与 body 注册进 DSH 自带右侧栏 |
| `src/client/HunkReviewTab.tsx` | tab 视图（会话条 + 文件/hunk/注释 + 刷新/复制） |
| `src/client/session-cwd.ts` | 会话 cwd 的原生来源（`sessions.list` 快照 + 订阅） |
| `src/client/api.ts` | 浏览器侧请求（结构读 + 按需 patch 读） |
| `src/client/i18n.ts` | zh/en 词典，跟随 `ctx.locale` |
| `src/client/styles.ts` | 全部走 `--dsw-alias-*` / `--dsw-font-mono` 主题令牌 |
| `src/client/highlight.ts` | shiki 高亮器（同步 core + JS 引擎 + css-variables 主题）与按行贴回 |
| `src/shared/languages.ts` | 扩展名 → 语法映射、`--shiki-*` 的 alias 令牌兜底 |
| `build.mjs` | esbuild：host 出 ESM，client 出 `__ModuleLoader__.load` 包装（body 原样插入，见下） |
| `test/*.test.mjs` | 记录型 payload 单测 + 真实 CLI 活体测试 + 假 webserver 路由测试 + client bundle 测试 |
| `scripts/preview.mjs` | 不开浏览器，直接打印 tab 会渲染的那份 JSON |
| `LICENSE` | MIT 许可证全文（版权行 `Copyright (c) 2026 JiaErC`） |

## 构建

```powershell
npm install
npm run typecheck     # tsc --noEmit
npm test              # 先构建，再跑 22 个用例（含真实 hunk CLI 活体用例）
npm run preview       # 打印当前目录的 payload；npm run preview -- --json 看原文
```

产物：`lib/index.js`（host，~28 KB）、`lib/client.js`（浏览器，压缩后 ~1.3 MB，
大部分是内联的 shiki 语法）、`lib/types/**`。

> ⚠️ 包装 client bundle 时**不要**为了好看去缩进它的内容：esbuild 的 minifier 会把
> 含换行的字符串打印成跨行模板字面量，缩进会被插进字符串值里——整个 bundle 里的
> `'\n'` 会变成 `'\n\t\t'`（症状是 shiki 返回的行莫名多出制表符）。`build.mjs`
> 因此把 bundle body 原样插在零缩进处。

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
   - client 半：浏览器硬刷新（Ctrl+Shift+R）即可；tab 在 DSH 右侧栏"新建标签页"引导页
     的列表里（新增条目 `/页面`），点它开一个「Hunk 评审」页；
   - host 半：`dsh web` 需要重启才会挂上 `/dsh-hunk/state`（重启 web 会中断当前会话）。

> 不需要安装 `dsh-better-sidebar`：注册走的是 DSH 自带的右侧栏注册表。

> 也可以走 `plugin_manager` 的 `install_bundle`（把本包目录作为 target），
> 由它代替第 1–3 步；本 preset 里该工具被禁用，所以上面给的是手工路径。

## 使用上的前提

- 终端里**可以**先有 live Hunk 窗口：`cd <仓库> && hunk diff --watch`
  （看某个提交：`hunk show <ref>`）；本 tab 读的就是这个窗口。**Windows 上也可以什么都不做**：
  Git 仓库里没有本仓库的 live 会话时，tab 会自己开一个（见「自动打开 Hunk 窗口」）。
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
- 语法高亮是**按需的**：只有展开 hunk 时才对那一块 tokenize（每块结果进 LRU 缓存），
  折叠着的 hunk 一分钱不花。语言表写死在这份代码里（`src/shared/languages.ts` +
  `highlight.ts` 的 import 列表）；要加一门语言就加一行 import 和几条扩展名——
  代价是 client bundle 会跟着变大（每门语言几十到几百 KB），这也是没把 shiki 的
  全部语言塞进来的原因。
- 视图只验证到「host 路由返回真实数据 + client bundle 注册出正确的 tab 描述符」；
  浏览器里的观感需要人工确认（本仓库的自动化测试跑不出真实渲染）。
- `lib/` 是构建产物（已 gitignore），挂载前需要 `npm run build`；改动 host 半后
  `dsh web` 必须重启才会加载新的 `lib/index.js`。

## 许可证

**MIT**，全文见 [LICENSE](LICENSE)，版权行 `Copyright (c) 2026 JiaErC`；
`package.json#license` 声明的是同一个 SPDX 标识符（`MIT`）——两处必须一致。

> 本项目**不发布到 npm**（`private: true`，靠 `link:` 挂载到 profile），所以
> `package.json#files` 里没列 `LICENSE` 也不影响分发：npm 打包时始终会自动带上
> 许可证文件。以 fork / 复制方式再分发时，请按 MIT 要求保留版权声明与许可全文。
