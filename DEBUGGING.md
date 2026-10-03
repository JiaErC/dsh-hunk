# dsh-hunk 调试手册

配套脚本：[`build-and-install.ps1`](./build-and-install.ps1)（构建 + 安装到 DSH profile）。

```powershell
pwsh -File .\build-and-install.ps1              # 类型检查 → 构建 → 测试 → 装进 profile → 验证
pwsh -File .\build-and-install.ps1 -Watch       # 再进监听：src\ 一变就重建（client 半会自动热替换）
pwsh -File .\build-and-install.ps1 -SkipTests -SkipTypecheck   # 只想快速出包
```

> 用 `pwsh`（PowerShell 7）跑。Windows PowerShell 5.1 读 UTF-8 无 BOM 的中文会乱码；真要 5.1，把脚本另存为「UTF-8 with BOM」。

---

## 1. 先记住这张表：改哪一层，怎么生效

| 改了什么 | 最快的验证手段 | 生效方式 |
|---|---|---|
| `src/shared/*`（纯逻辑：wire / notes / patch） | `node --test`、`node scripts/preview.mjs` | 立即（跑一次就行） |
| `src/host/*`（跑 hunk CLI、拼 payload） | `node scripts/preview.mjs <cwd> --json --patches` | **改 host 半要重启 `dsh web`**（可选热重载见 §4） |
| `src/client/*`（tab 视图、样式、i18n） | 浏览器里看；HMR 自动换 | **约 1 秒自动热替换**，不用刷新 |
| profile 的 `cordis.patch.yml` / preset / 依赖行 | `dsh --profile web --dump-config` | **存盘即生效**（profile 配置是热重载的），不用重启 |
| `package.json` 里的包版本 | — | 需要重启（包安装不在 HMR 队列里） |

---

## 2. 不用浏览器的那一层（日常首选）

```powershell
npm run typecheck                  # tsc --noEmit
node --test                        # test/{host,route,client}.test.mjs（含真实 hunk CLI 活体用例）
node scripts/preview.mjs           # 打印 tab 会渲染的那份 JSON（跑真实 host 半 + 假 webserver + 真 hunk CLI）
node scripts/preview.mjs --json    # 看原始 payload
node scripts/preview.mjs --patches # 再跑一次「展开 hunk」才用的 patch 读，逐个校验 hunk 能否切出 patch
node scripts/preview.mjs E:\some\repo --patches
```

`preview.mjs` 是这个工程最值钱的调试器：它把 `apply(ctx)` 挂到假 webserver 上，直接调用真实路由处理器，**不需要 DSH、不需要浏览器、不需要重启**。所以尽量把 host 逻辑写成 `src/host/hunk-cli.ts` 里的纯函数——那一层的循环是秒级的。

想验证**已经加载进 `dsh web` 的那份 host 半**是不是最新的，直接打它的路由：

```powershell
$cwd = 'E:\AI_mcp_projects\dsh-hunk'
Invoke-WebRequest -Headers @{ Host = '127.0.0.1:3080' } `
  "http://127.0.0.1:3080/dsh-hunk/state?cwd=$([uri]::EscapeDataString($cwd))" | Select-Object -Expand Content
```

（Windows PowerShell 5.1 上加 `-UseBasicParsing`；pwsh 7 不需要。）

读响应：

- `{"ok":true, ...}` → 路由活着，看 `sessions` / `matched` / `review`。
- **返回 HTML**（前端兜底页面，200）→ 路由**没挂上**：host 半还没被加载，重启 `dsh web`。
- `403` → 信任围栏（`Host` 头不是回环地址，或带了 `sec-fetch-site: cross-site` / 不匹配的 `Origin`）。用 `curl`/`Invoke-WebRequest` 时只带 `Host` 头就通过。
- `{"ok":false,"error":{"code":...}}` → 业务错误，`error.code` 就是 `src/shared/wire.ts` 里的枚举。

---

## 3. 浏览器那一层（client 半）

**它是自动的**：`@deepseek-ai/dsh-client-hmr` 以 500 ms 轮询每个插件入口产物，用 `mtime/ctime/size` 派生 revision；`lib/client.js` 一变就通过 SSE 发 `rebuilt`，打开的页面**会替换整个插件**（不刷新页面，但插件内的 React 状态会丢、打开中的 tab 状态按 store 恢复）。

- 没自动换：`Ctrl+Shift+R` 硬刷新（一定生效）。
- 想确认换了：DevTools → Network 里找 `/plugins/dsh-hunk/client.js?rev=...`，`rev` 变了就是新的。
- 插件加载/激活失败：**设置 → 插件** 里会显示导入错误，能直接重试（不用等下次构建）。
- 右侧栏"新建标签页"列表里没有「Hunk 评审」：client 半 `export const inject =
  ['sidebarRightTabs', 'slots']`——两个服务都在 DSH 自带右侧栏里，缺任何一个插件都会被
  Cordis 停住（控制台另有一条 `[dsh-hunk] … is missing` 的说明）。另外 guide 条目是
  **tab 类型注册**的产物：类型注册失败（id 撞车、guide 条目 id 重复）时它不会出现，
  看「设置 → 插件」的报错。

---

## 4. host 半：为什么默认要重启，以及怎么免重启

`lib/index.js` 是 host 插件模块，在 `dsh web` 启动时被 import 并挂载；**它的热重载默认是关的**（DSH 的 `hmr` 行默认 `root: []`，只保留 profile 配置监听——所以改 `cordis.patch.yml` 不用重启，改插件源码要）。

**默认路径**：改完 host 半，重启 `dsh web`。重启后它的 stdout 会打：

```
[dsh-hunk] mounted /dsh-hunk/state (hunk bin: hunk)
```

看到这行就说明新版 host 半挂上了。（重启会中断当前会话，所以 host 半的改动建议攒一批。）

**可选的免重启（实验性，未在本机验证）**：在 profile 的 `cordis.patch.yml` 里打开模块监听：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["E:/AI_mcp_projects/dsh-hunk/lib"]
```

`root` 是模块监听目录，路径按 Node ESM 的 `realpathSync()` 表示比对（本项目是 `link:` 进来的，realpath 就是工程目录）。生效的话，每次 `npm run build` 重写 `lib/index.js` 后 Cordis 会重新挂载这个插件（等于免重启的 host 热重载）。
**不生效就老实重启**，别为这件事卡住——这条我没有在本机验证过（本会话的 pwsh 起不来）。

---

## 5. 常见症状 → 原因

| 症状 | 排查 |
|---|---|
| 右侧栏"新建标签页"里没有「Hunk 评审」 | `lib/client.js` 没构建；或 tab 类型注册被拒（id / guide 条目 id 撞车）；看「设置 → 插件」的报错与浏览器控制台 |
| 开了页面但一直「加载中」 | 会话 cwd 还没进 `sessions.list`（列表填好后会自动出现，无需重开）；真拿不到时 2 s 后会提示，点重试只是重新等一轮 |
| tab 里写「没有检测到 live Hunk 会话」 | 终端没有 `hunk diff --watch`；或 **daemon 中途重启过**（先开的窗口掉注册：`hunk.exe` 还在，但 `hunk session list` 空）→ 在窗口里 Ctrl+C 后重新 `hunk diff --watch` |
| 路由 404 / 返回 HTML | host 半没加载 → 重启 `dsh web` |
| 路由 403 | 信任围栏：`Host` 不是回环 / 带了跨站标记 |
| 展开 hunk 第一次很慢 | `?patches=1` 要给每个文件重建一份 patch；host 侧有 5 s TTL + 同键合并，刷新会丢缓存 |
| 宿主里 `hunk: command not found` | 宿主进程 PATH 没有 hunk → 设 `DSH_HUNK_BIN`（如 `C:\Users\me\AppData\Local\Programs\hunk\hunk.exe`）；慢机器设 `DSH_HUNK_TIMEOUT_MS` |
| Hunk 窗口里看不到 agent 注释 | Hunk 默认 `showAgentNotes=false`：窗口里按 `a`、或用 `hunk diff --watch --agent-notes`、或在 hunk 配置里设 `agent_notes = true` |

---

## 6. 装 / 卸 / 回滚

安装（脚本会自动做幂等的部分）：

```powershell
# profile 的 package.json：  "dsh-hunk": "link:E:/AI_mcp_projects/dsh-hunk"
# profile 的 cordis.patch.yml： - insert: / - id: dsh-hunk / name: dsh-hunk
cd D:\.dsh\profiles\web ; pnpm install
```

卸载：删掉 `cordis.patch.yml` 里的 `dsh-hunk` 段 + `package.json` 的依赖 → `pnpm install` → 重启 `dsh web`。脚本改这两个文件前都会留 `.bak`。

---

## 7. 两个已知的坑（省你时间）

1. **`npm run watch` 目前不是真的 watch**。`package.json` 里是 `node build.mjs --watch`，但 `build.mjs` 没有处理 `--watch`（没有用 esbuild 的 context/watch API），跑完就退出。要么用 `build-and-install.ps1 -Watch`（轮询 `src\`），要么给 `build.mjs` 补上 `esbuild.context(...).watch()`。
2. **`lib/` 是构建产物（已 gitignore）**：新克隆下来必须先构建，`dsh web` 启动时找不到 `lib/client.js` 会明确报「缺 bundle」。
