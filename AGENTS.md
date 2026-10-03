# dsh-hunk 仓库规则（AGENTS）

> 本文只含**项目全局开发规则**（面向贡献者与 agent）。
> 功能说明与挂载步骤见 [README](README.md)；发布历史见 [CHANGELOG](CHANGELOG.md)；
> 调试办法见 [DEBUGGING](DEBUGGING.md)。
>
> 参照 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的仓库纪律
> （AGENTS.md / CHANGELOG / tag 发版），按本项目「单人 + Gitee 远端 + 用 link 挂载」
> 的规模做了裁剪。

---

## 1. 仓库硬约束

- **禁止修改 DSH 源码**：对官方安装（`C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）
  零写入。
- **挂载只走 profile 的 `cordis.patch.yml`**（`D:\.dsh\profiles\web\cordis.patch.yml` +
  `package.json` 的 `link:` 依赖）；本包不改 profile 之外的任何部署文件。
- **零运行时依赖**：`dependencies` 必须保持为空。host 半只用 `node:`；client 半只用
  宿主 module table 里的 react（`external: ['react', 'react/jsx-runtime']`）。
  shiki 是 devDependency、被打进 `lib/client.js`。
- **插件不得 require 宿主的 client 包**（`@deepseek-ai/dsh-client-*`）：客户端能力要么
  自己打包，要么走**宿主自带的服务**（`ctx.get(...)` + 结构性类型，例如
  `sidebarRightTabs` / `slots` / `sessions` / `locale`）。`import type {}` 被擦除，不受此限。
- **不依赖第三方侧栏插件**：tab 走 DSH 原生的两段式注册——tab 类型
  `ctx.sidebarRightTabs.register(...)`，body 席位 `sidebar.right.pane.tab`（键是类型 id）。
  `inject` 里等的是 `sidebarRightTabs` / `slots`，不是 `betterSidebar`；装不装
  better-sidebar 都不影响本 tab。
- **皮肤契约**：视觉值只消费 `--dsw-alias-*` / `--dsw-font-*` 令牌，不写死颜色；
  图标用 `currentColor`。灰阶只能用半透明叠色令牌——浅色主题里
  `--dsw-alias-bg-layer-1/2/3` 解析成同一个颜色（`neutral-bluish-00`），
  用它们做「浅灰」等于什么都没画。
- **皮肤层令牌必须带兜底**：宿主主题包**并不定义**全部别名令牌（0.1.7-rc.2 定义 395 个、
  0.2.0-rc.2 定义 404 个；`--dsw-alias-hairline` / `-accent` / `-accent-soft` / `-danger`、
  `--dsw-font-mono` 两版都没有）。自定义属性未定义会让**整条声明在计算值阶段失效**，
  边框/底色会静默退回初始值——不报错、只是长得不对。所以每个这类名字都要写成
  `var(--dsw-alias-accent, var(--dsw-alias-state-business-primary))`，由
  `test/theme-tokens.test.mjs` 守住「用到的令牌要么宿主有定义，要么写了兜底」。
- **构建包装器不得缩进 bundle body**：esbuild 的 minifier 把含换行的字符串打印成
  跨行模板字面量，缩进会被插进字符串值（`'\n'` → `'\n\t\t'`，症状是 shiki 返回的行
  莫名多出制表符）。`build.mjs` 的 `registerBundle` 因此把 body 原样插在零缩进处。
- **生效路径要分清**：改 host 半（`src/index.ts` / `src/host/**`）→ 必须重启 `dsh web`；
  改 client 半（`src/client/**`）→ 浏览器硬刷新即可（不用重启宿主）。

## 2. 分支模型

- `master` 是主干，远端 `origin` = `git@gitee.com:JiaErC/dsh-hunk.git`。
  （上游参考项目用 `main`；本项目沿用既有 `master`，不为了对齐而改远端分支名。）
- 改动开在类型前缀分支上，完成后 `--no-ff` 合并回 `master`，让主干留下合并记录：
  `feat/*`（功能）、`fix/*`（修复）、`docs/*`（纯文档）、`chore/release-X.Y.Z`（发版）、
  `test/*`、`perf/*`、`refactor/*`。
- 纯文档改动（README / AGENTS / CHANGELOG / DEBUGGING）可以直接落在 `master` 上；
  其余一律走分支。

```bash
git switch -c feat/某个功能
# … 改代码、跑 npm run typecheck && npm test、提交 …
git switch master
git merge --no-ff feat/某个功能 -m "Merge branch 'feat/某个功能' into master"
```

## 3. 提交规范

Conventional Commits + **中文正文**（与上游参考项目一致，scope 用模块名）：

```
feat(review): hunk 行浅灰圆角面 + 展开/悬停加深一档
fix(host): isTimeout 把任何失败都判成超时（signal 是 null 不是 undefined）
docs(readme): 界面小节补灰阶选型与折叠模型
chore(release): v0.2.0 —— 评审面板完整化
test(patch): 逐 hunk 断言可切出正文
```

- 类型：`feat` / `fix` / `docs` / `chore` / `test` / `perf` / `refactor`。
- 一个提交一件事；正文写**证据**（实测数字、测试条数、真实症状），别只写「优化」。
- 发版提交固定为 `chore(release): vX.Y.Z —— 一句话摘要`。

## 4. 版本与发版

**版本源**：`package.json#version`。tag 必须与它一致，不一致视为发版失败。

发版步骤（本项目**不发布到 npm**——`private: true`，用 `link:` 挂载，所以「发版」=
版本号 + CHANGELOG + tag）：

1. 确认工作区干净、`npm run typecheck` 与 `npm test` 全绿。
2. 在 `CHANGELOG.md` 顶部新增 `### vX.Y.Z`：一句 `>` 摘要 + 分类条目
   （✨ 功能 / 🐛 修复 / 🧰 工具 / 🧪 验证 / 🌐 基线）+ 实测证据。**最新在上。**
3. bump `package.json#version`，提交为 `chore(release): vX.Y.Z —— 摘要`（在
   `chore/release-X.Y.Z` 分支上）。
4. 合并回 `master`（`--no-ff`），在合并提交上打**轻量 tag**：

```bash
git tag v0.2.0                    # 打在合并提交上
git tag v0.1.0 61f698a            # 追认历史版本：打在当时的提交上
git push origin master --follow-tags   # 推送由维护者决定
```

5. 版本语义：`0.x` 阶段 **minor 用于功能性批次**（0.1 → 0.2 → 0.3），
   patch 用于同类修复；预发布用 `-rc.N` / `-alpha.N`（tag 与 version 都带后缀）。

## 5. DSH 版本适配

- **当前基线（v0.3.0 起）**：DSH **0.2.0-rc.2** + cordis **4.0.4**。
  （v0.3.0 及以前 tab 走 better-sidebar 0.24.1；现在只用 DSH 自带右侧栏，
  better-sidebar 不再出现在 peer/devDep 里。上一档 DSH 基线 0.1.7-rc.2 对应 v0.2.0 及以前。）
- **为什么不声明 `@deepseek-ai/dsh` peer**：宿主启动预检的原话是
  *Check every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer against the runtime*
  （`dsh-app-boot`）。我们的 peer 只有 `@deepseek-ai/cordis`，
  **不在预检范围内**——好处是永远不会被静默禁用，代价是**换 DSH 版本时没有任何自动门禁**，
  必须人工复核下面的清单；另外 semver 的 caret **跨不过 minor**
  （`^0.1.7-rc.2` 对 `0.2.0-rc.2` 判定为 false），哪天真要声明 peer 就必须同批抬下限。
- **为什么等注册表而不是等席位声明**：原生席位先 `declare` `sidebar.right.pane.tab`、
  之后才 `provide` `sidebarRightTabs`，所以**声明触发**的注册回调会读到 `undefined`
  且再也不会重来（better-sidebar 在真机上踩过：回调拿到两个服务都是 undefined，
  注册静默丢失）。本插件因此让 `export const inject = ['sidebarRightTabs','slots']`
  在插件层等注册表，而 body 席位用 `ctx.slots.inject(...)` 等声明。
- **换版本时的人工复核清单**（逐条给出结论，别只看「能开」）：

| 契约点 | 怎么验 | 0.2.0-rc.2（原生注册）实测结论 |
|---|---|---|
| `ctx.webServer.register` | 读 `dsh-host-webserver` 的 `WebRoute` / `WebRouteKind` | 形状未变（`kind: 'exact'\|'prefix'`、`path`、`handler`，返回 disposer） |
| 客户端 module table | 读 `dsh-client-modules` 的解析器；`dsh.client` 字段 | `window.__ModuleLoader__.load({id, factory})` 未变；`platform`（必填 string）、`inject`、`immediately` 仍被接受 |
| 客户端产物怎么取 | 见下「产物 URL」 | **combo URL**：`/plugins/??<id>/client.js&rev=<sha1-12>`；实测本插件 200 |
| `ctx.sidebarRightTabs.register` | 读 `dsh-client-ui-sidebar-right` 的 `lib/types/client/tab-registry.d.ts` | 需要 `id`/`kind`/`priority`/`title(address)`；`guide[]` 需要唯一的 `id`、`order`、thunked `title`，`icon` 是**组件**（`({size}) => …`，不是元素） |
| `sidebar.right.pane.tab` 席位 | 读同包的 `lib/types/client/contract/slots.d.ts` | `{name, key: 类型 id, inject: (sessionId) => props}`；body 拿到的是现成的 **`useTabInfo`** 钩子（不是 `hooks.tabInfo`），其 `tab.visible` 就是可见性 |
| 会话 cwd | `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd` | 仍在（`sessions` 是客户端服务；用 `ctx.get` + 结构性类型读，不 require 包） |
| `ctx.locale`（字典注册） | 读 `dsh-client-locale` 的 `provide("locale")` 与 `register(ns, locale, dict)` | 未变（我们按结构类型调用，不硬依赖包） |
| 主题令牌 | `npm test` 里的 `theme-tokens.test.mjs` | 见 §1「皮肤层令牌必须带兜底」 |

- **产物 URL 变了要知道**：0.2.0 起插件客户端产物不再按 `/plugins/<id>/client.js`
  单独提供，而是 **combo** 形式
  `/plugins/??<id>/client.js&rev=<sha1-12>`，`rev` 由该文件 `mtimeMs/ctimeMs/size`
  经 `framedHash("plugin-artifact", …)` 得出（`HASH_REVISION_LENGTH = 12`）。
  这是**宿主自己拼的**，我们不需要改代码；但手工排查「tab 没出来」时别再拿朴素路径去试
  （一定 404，会误判成插件没加载）。
- **本 profile 的 401 与我们的路由无关**：这个 web profile 里 `/`、`/api/*` 被
  `dsh-remote-web-ui` 那道远程访问门挡在 401（响应里**没有** `WWW-Authenticate`），
  而经 `webServer.register` 注册的插件路由**不在门内**。也就是说
  `/dsh-hunk/state` 的唯一守卫是**我们自己的围栏**（loopback Host，或 `trustedHosts`
  命中且带同源标记）。因此：放宽 `trustedHosts` 等于把这条只读接口交给远端，改之前先想清楚。
- **换版本的动作顺序**：改 `package.json` 的 peer + devDep → 删 `node_modules` 与
  `package-lock.json` 干净重装（原地 `npm i` 会 ERESOLVE：旧线 peer 与新线 peer 混图）→
  `npm run typecheck`（对着新类型）→ `npm test` → 按 §4 发版，把结论写进 CHANGELOG 的
  「🌐 基线」与「🧪 验证」。

## 6. 文档同步纪律

- 行为或界面变化 → 同步 README 的「界面」/「它是怎么工作的」小节。
- 踩到的坑（宿主行为、主题令牌、构建陷阱）→ 写进 README 或本文，别只留在提交信息里。
- 新增文案键 → zh 与 en 必须逐键对齐（`Record<HunkKey, string>` 会强制）。
- 新增语法（shiki 语言）→ 同时更新 `src/shared/languages.ts` 的扩展名表与
  `src/client/highlight.ts` 的 import 列表；`test/client.test.mjs` 会校验
  「映射里声明的每种语言都真的被打包」。
