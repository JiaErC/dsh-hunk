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
  自己打包，要么走 `ctx.betterSidebar` 的方法调用。`import type {}` 被擦除，不受此限。
- **皮肤契约**：视觉值只消费 `--dsw-alias-*` / `--dsw-font-*` 令牌，不写死颜色；
  图标用 `currentColor`。灰阶只能用半透明叠色令牌——浅色主题里
  `--dsw-alias-bg-layer-1/2/3` 解析成同一个颜色（`neutral-bluish-00`），
  用它们做「浅灰」等于什么都没画。
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

- 当前基线与实测环境：**DSH 0.1.7-rc.2** + **better-sidebar 0.21.1**（见 CHANGELOG）。
- 本插件**不声明** `@deepseek-ai/dsh` peer（宿主启动预检只检查 `@deepseek-ai/dsh*`
  范围的 peer，声明了反而可能因范围不匹配被整行静默禁用）。因此 DSH 换版本时
  **没有自动门禁**，必须人工复核这三件事，并写进 CHANGELOG 的「🌐 基线」条目：
  1. `ctx.webServer.register` 的 `{ kind, path, handler }` 形状；
  2. 客户端 module table 的基线 external（`react` / `react/jsx-runtime`）；
  3. `ctx.betterSidebar.registerTab` 的 TabDescriptor 字段（`id / title / description /
     icon / order / single / component`）。
- 注意 semver 的 caret **跨不过 minor**（`^0.1.7-rc.1` 对 `0.2.0-rc.1` 判定为 false）。
  这条是上游用真机踩出来的：一旦声明 DSH peer，换 minor 时必须同批抬下限。

## 6. 文档同步纪律

- 行为或界面变化 → 同步 README 的「界面」/「它是怎么工作的」小节。
- 踩到的坑（宿主行为、主题令牌、构建陷阱）→ 写进 README 或本文，别只留在提交信息里。
- 新增文案键 → zh 与 en 必须逐键对齐（`Record<HunkKey, string>` 会强制）。
- 新增语法（shiki 语言）→ 同时更新 `src/shared/languages.ts` 的扩展名表与
  `src/client/highlight.ts` 的 import 列表；`test/client.test.mjs` 会校验
  「映射里声明的每种语言都真的被打包」。
