# Changelog

> 本文档收录 dsh-hunk 的完整发布历史，最新版本概览见 [README](README.md)。
>
> 版本号即 `package.json#version`；每次发版在同一提交上打轻量 tag `vX.Y.Z`
> （预发布用 `-rc.N` / `-alpha.N`）。约定与流程见 [AGENTS.md](AGENTS.md)。

### v0.2.0

> 📝 **首个功能完整的版本**：从「能看到评审」走到「像一份正经的评审面板」——
> 变动可以按需读取并以并排双列展示、代码有语法高亮、注释贴在被评论的代码行下面、
> 折叠的语义被定死（收起只收变动内容，评审不丢），并修掉三处只在真机上才暴露的坑。

- ✨ **变动读取与并排双列**：同一条路由的第二次读（`?patches=1`）按需拉 patch
  （5 秒 TTL + 同 cwd 合并 + 无会话时先用廉价的 `session list` 判掉），
  hunk 展开后是左删右增的并排视图：按位配对、两侧各自行号、`-` / `+` 前缀、
  宿主 diff 的 8% 底色；hunk 行右上的复制图标把整段 hunk 复制成可粘贴的 patch 片段。
- ✨ **语法高亮（与宿主同引擎）**：`createHighlighterCoreSync` + JS 正则引擎 +
  `createCssVariablesTheme`，与宿主 `ui-primitives` 一致；额外给 `--shiki-*` 配上
  DSH alias 令牌兜底，皮肤没有这些变量时也不会退化成一片同色。22 个语法按扩展名
  认领（含 ts / tsx 两条线），只在展开 hunk 时按整块 tokenize（块注释、多行字符串
  才认得对），结果进 LRU 缓存。
- ✨ **注释的落点**：展开 hunk 时注释内联在被评论的代码行下方（跨行锚点取范围末行）；
  hunk 收起时回落到 hunk 行下方；**文件收起只收变动内容，这个文件的评审留在文件行下方**
  （`fileNotes()` 定义阅读顺序：按 hunk 再文件级）。
- ✨ **视觉层级**：三级灰阶——文件行（组头）最深、hunk 行最浅、展开中或悬停加深一档；
  全部用半透明叠色令牌，因为浅色主题里 `--dsw-alias-bg-layer-1/2/3` 是同一个颜色。
  评审注释块加了一圈边框，让 AI 写下的 note 更醒目。
- ✨ **空态与诊断**：没有 live 会话时给出可复制的 `cd <cwd> && hunk diff --watch`；
  窗口「在跑但没注册到 daemon」这个高频误判有专门提示（`hunk session list` 报
  `No active Hunk sessions` 时）。
- 🐛 **修复（三处真机坑）**：
  - 构建包装器为了好看缩进 client bundle，而 esbuild 的 minifier 把含换行的字符串
    打印成跨行模板字面量 → 缩进被插进字符串值，整包的 `'\n'` 变成 `'\n\t\t'`
    （症状是高亮行莫名多出制表符）。改为 body 原样插入零缩进处。
  - `isTimeout` 用 `error.signal !== undefined` 判断超时，而普通非零退出的 `signal`
    是 `null` → 任何失败都被判成超时（「没有会话」变成 504）。改判 `!= null`。
  - 宿主旧构建对 `?patches=1` 返回结构 payload，前端直接读 `payload.error.message`
    崩成 `Cannot read properties of undefined`。改为**能力协商**
    （`capabilities.patches`）+ **形状守卫**（`parsePatchesPayload`），并给出
    「重启 dsh web」这种可执行的提示。
  - `.jsx` 需要 shiki 的 `tsx` 语法（`jsx` 不单独注册），而 `.ts` 必须留给
    `typescript`（tsx 会把 `foo<T>(x)` 读成 JSX）。
- 🧰 **工具**：`scripts/preview.mjs`（不开浏览器打印 tab 会渲染的 payload，
  `--patches` 逐文件逐 hunk 校验能否切出正文）、`DEBUGGING.md` 与
  `build-and-install.ps1`（本地调试与安装脚本）。
- 🧪 **验证**：`npm test` 34 个用例（含 3 条跑真实 `hunk` CLI 的活体用例，无 live
  会话时自动跳过）；`tsc --noEmit` 干净。开发期用 `node scripts/preview.mjs --patches`
  对着真实会话核对过「每个 hunk 都能切出正文」。

### v0.1.0

> 🎉 **首个可用版本**（tag 为追认：打在 `61f698a`，即插件第一次在 DSH 右侧栏里
> 显示出评审内容的那次提交）。此前的 `d6b80e7` 只是脚手架（`hello-plugin` 桩）。

- ✨ host 半只注册一条只读路由 `/dsh-hunk/state`：在会话 cwd 下并发跑
  `hunk session list --json` 与 `hunk session review --repo . --json --include-notes`，
  带浏览器信任围栏（Host + 同源标记）与 cwd 校验，把 JSON 回给浏览器。
- ✨ client 半用 `ctx.betterSidebar.registerTab` 注册 order 40 的「Hunk 评审」tab：
  按文件列出 hunk 与注释、带刷新按钮；没有 live 会话时提示先在终端跑
  `hunk diff --watch`；注释→hunk 的归位（`hunkIndex` 优先，退回行范围重叠）。
- 🧰 工程：**零运行时依赖**（host 半只用 `node:`，client 半只用宿主的 react）、
  `build.mjs`（esbuild：host 出 ESM，client 出 `window.__ModuleLoader__.load` 包装）、
  `tsc --noEmit` 类型检查、三份测试（记录型 payload / 假 webserver 路由 / client
  bundle 形状）、profile 挂载只走 `cordis.patch.yml`。
- 🌐 **DSH 基线**：0.1.x 与 0.2.x 都在 DSH **0.1.7-rc.2** + better-sidebar **0.21.1**
  上实测通过。
