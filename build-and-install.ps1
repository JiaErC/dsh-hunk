#Requires -Version 5.1
<#
.SYNOPSIS
  构建 dsh-hunk 并安装（link）到 DSH profile —— 本地开发循环的一键入口。

.DESCRIPTION
  一次跑完：
    1. 依赖      node_modules 不存在时 npm install
    2. typecheck tsc --noEmit
    3. build     npm run build（esbuild 出 lib/index.js + lib/client.js，tsc 出 lib/types/）
    4. tests     node --test（含真实 hunk CLI 用例；没有 hunk 或没有 live 会话时可能失败，可 -SkipTests）
    5. 安装      确保 profile 的 package.json 有 dsh-hunk 的 link 依赖、cordis.patch.yml 有挂载行；
                 只在「刚改过 profile 配置」或「link 还没落位」时才跑 pnpm install
    6. 验证      dsh --profile <p> --dump-config 里能看到挂载行；若 dsh web 在跑，再打一次 /dsh-hunk/state 冒烟

  生效方式（本脚本不替你重启 dsh web，那会中断当前会话）：
    - client 半 lib/client.js：dsh-client-hmr 每 500ms 轮询产物，构建完约 1 秒内自动热替换进打开的页面；
      没换成就 Ctrl+Shift+R。
    - host 半 lib/index.js：默认要重启 dsh web；想免重启见 DEBUGGING.md「host 半热重载（可选）」。

.PARAMETER Profile
  DSH profile 名，默认 web。

.PARAMETER DshHome
  DSH 主目录（含 profiles\）。默认探测：-DshHome → $env:DSH_HOME → 用户 ~\.dsh → 各盘符 \.dsh。
  本机是 D:\.dsh，能自动找到。

.PARAMETER Port
  dsh web 端口，冒烟探测用，默认 3080。

.PARAMETER SkipInstall
  跳过 npm install。

.PARAMETER SkipTypecheck
  跳过 tsc --noEmit。

.PARAMETER SkipTests
  跳过 node --test。

.PARAMETER NoVerify
  跳过第 6 步验证。

.PARAMETER Watch
  构建完成后进入监听：src\ 下有改动就重新构建（不重跑测试/安装）。Ctrl+C 退出。

.EXAMPLE
  pwsh -File .\build-and-install.ps1
.EXAMPLE
  pwsh -File .\build-and-install.ps1 -Watch
.EXAMPLE
  pwsh -File .\build-and-install.ps1 -SkipTests -SkipTypecheck
.EXAMPLE
  pwsh -File .\build-and-install.ps1 -DshHome 'D:\.dsh' -Profile web
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshHome,
  [int]$Port = 3080,
  [switch]$SkipInstall,
  [switch]$SkipTypecheck,
  [switch]$SkipTests,
  [switch]$NoVerify,
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$pkgName = 'dsh-hunk'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Head([string]$Text) { Write-Host ''; Write-Host "=== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  ..   $Text" }
function Write-Note([string]$Text) { Write-Host "  [!!] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [xx] $Text" -ForegroundColor Red; exit 1 }

# Run an external command in a directory and return its exit code.
# Out-Host keeps child output off this function's return value.
function Invoke-External {
  param([string]$Exe, [string[]]$Arguments, [string]$WorkDir)
  Push-Location $WorkDir
  try {
    & $Exe @Arguments | Out-Host
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  return $code
}

# Find the DSH home whose profiles\<name> exists.
function Resolve-DshHome {
  param([string]$Explicit, [string]$ProfileName)
  $probe = @()
  if ($Explicit) { $probe += $Explicit }
  if ($env:DSH_HOME) { $probe += $env:DSH_HOME }
  if ($env:USERPROFILE) { $probe += (Join-Path $env:USERPROFILE '.dsh') }
  foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    if ($drive.Root) { $probe += (Join-Path $drive.Root '.dsh') }
  }
  foreach ($candidate in $probe) {
    if (-not $candidate) { continue }
    if (Test-Path (Join-Path $candidate "profiles\$ProfileName\package.json")) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

Write-Host "dsh-hunk · build & install" -ForegroundColor Cyan
Write-Host "  project : $root"
Write-Host "  profile : $Profile"
Write-Host "  powershell: $($PSVersionTable.PSVersion)"

# ── 0. 前置检查 ──────────────────────────────────────────────────────────────
Write-Head '0/6 前置检查'
foreach ($exe in @('node', 'npm')) {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Fail "找不到 $exe —— 先装 Node.js 20+" }
}
Write-Ok ("node " + (& node -v))
if (Get-Command hunk -ErrorAction SilentlyContinue) {
  $hunkVersion = (& hunk --version 2>$null | Select-Object -First 1)
  Write-Ok "hunk CLI: $hunkVersion"
} else {
  Write-Note 'PATH 上找不到 hunk —— 插件照常挂载，但 tab 只会显示「没有检测到 live Hunk 会话」。装在别处时给宿主设 DSH_HUNK_BIN。'
}

# ── 1. 依赖 ─────────────────────────────────────────────────────────────────
Write-Head '1/6 依赖'
if ($SkipInstall) {
  Write-Info '跳过（-SkipInstall）'
} elseif (Test-Path (Join-Path $root 'node_modules')) {
  Write-Info 'node_modules 已存在；要强制重装就先删掉它再跑'
} else {
  Write-Info 'npm install …'
  if ((Invoke-External 'npm' @('install') $root) -ne 0) { Fail 'npm install 失败' }
  Write-Ok 'deps installed'
}

# ── 2. 类型检查 ──────────────────────────────────────────────────────────────
Write-Head '2/6 typecheck'
if ($SkipTypecheck) {
  Write-Info '跳过（-SkipTypecheck）'
} elseif ((Invoke-External 'npm' @('run', 'typecheck', '--silent') $root) -ne 0) {
  Fail 'tsc --noEmit 有错 —— 先修类型（想先看构建结果：-SkipTypecheck）'
} else {
  Write-Ok 'types clean'
}

# ── 3. 构建 ─────────────────────────────────────────────────────────────────
Write-Head '3/6 build'
if ((Invoke-External 'npm' @('run', 'build', '--silent') $root) -ne 0) { Fail 'npm run build 失败' }
foreach ($artifact in @('lib\index.js', 'lib\client.js', 'lib\types\index.d.ts')) {
  if (-not (Test-Path (Join-Path $root $artifact))) { Fail "构建产物缺失：$artifact" }
}
foreach ($artifact in @('lib\index.js', 'lib\client.js')) {
  $item = Get-Item (Join-Path $root $artifact)
  Write-Ok ("{0}  {1:HH:mm:ss}  {2:N1} kB" -f $artifact, $item.LastWriteTime, ($item.Length / 1KB))
}

# ── 4. 测试 ─────────────────────────────────────────────────────────────────
Write-Head '4/6 tests'
if ($SkipTests) {
  Write-Info '跳过（-SkipTests）'
} elseif ((Invoke-External 'node' @('--test') $root) -ne 0) {
  Fail 'node --test 失败 —— 修好再装（含真实 hunk CLI 用例，没有 hunk 时用 -SkipTests）'
} else {
  Write-Ok 'tests passed'
}

# ── 5. 安装到 profile ───────────────────────────────────────────────────────
Write-Head '5/6 安装到 DSH profile'
$dshHome = Resolve-DshHome -Explicit $DshHome -ProfileName $Profile
if (-not $dshHome) {
  Fail "找不到含 profiles\$Profile 的 DSH 主目录 —— 用 -DshHome '<路径>' 指定（本机应为 D:\.dsh）"
}
$profileDir = Join-Path $dshHome "profiles\$Profile"
Write-Ok "profile: $profileDir"
$profileChanged = $false

# 5a. package.json 里补 link 依赖（已存在则不动）
$pkgJsonPath = Join-Path $profileDir 'package.json'
$pkgText = [System.IO.File]::ReadAllText($pkgJsonPath)
if ($pkgText -match ('(?m)^\s*"' + [regex]::Escape($pkgName) + '"\s*:')) {
  Write-Ok "package.json 已有 $pkgName 依赖"
} else {
  $linkTarget = 'link:' + ($root -replace '\\', '/')
  $line = '    "' + $pkgName + '": "' + $linkTarget + '",'
  $newText = ([regex]'("dependencies"\s*:\s*\{)').Replace($pkgText, "`$1`r`n$line", 1)
  if ($newText -eq $pkgText) { Fail 'profile 的 package.json 里没有 dependencies 段，无法自动插入依赖' }
  [System.IO.File]::WriteAllText("$pkgJsonPath.bak", $pkgText, $utf8NoBom)
  [System.IO.File]::WriteAllText($pkgJsonPath, $newText, $utf8NoBom)
  Write-Ok "已写入依赖 $pkgName = $linkTarget（备份 package.json.bak）"
  $profileChanged = $true
}

# 5b. cordis.patch.yml 里补挂载行（已存在则不动）
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path $patchPath)) { Fail "profile 里没有 cordis.patch.yml：$patchPath" }
$patchText = [System.IO.File]::ReadAllText($patchPath)
if ($patchText -match ('(?m)^\s*name:\s*[''"]?' + [regex]::Escape($pkgName) + '[''"]?\s*$')) {
  Write-Ok 'cordis.patch.yml 已有挂载行'
} else {
  $block = "`r`n# $pkgName 挂载行（由 build-and-install.ps1 追加；删掉本段并从 dependencies 去掉 $pkgName 即可卸载）`r`n- insert:`r`n    - id: $pkgName`r`n      name: $pkgName`r`n"
  [System.IO.File]::WriteAllText("$patchPath.bak", $patchText, $utf8NoBom)
  [System.IO.File]::AppendAllText($patchPath, $block, $utf8NoBom)
  Write-Ok '已追加挂载行（备份 cordis.patch.yml.bak）'
  $profileChanged = $true
}

# 5c. 只有 profile 配置变了、或 link 还没落位时才需要重装依赖
$linked = Test-Path (Join-Path $profileDir "node_modules\$pkgName\package.json")
if ($profileChanged -or -not $linked) {
  if ($profileChanged) { Write-Info 'profile 配置刚改过，刷新依赖 …' } else { Write-Info 'link 还没落位，安装依赖 …' }
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    $code = Invoke-External 'pnpm' @('install') $profileDir
  } else {
    Write-Note 'PATH 上没有 pnpm，改用 dsh plugin 转发给 pnpm'
    $code = Invoke-External 'dsh' @('plugin', '--profile', $Profile, 'install') $profileDir
  }
  if ($code -ne 0) { Fail 'profile 依赖安装失败 —— 到 profile 目录手动跑一次 pnpm install 看细节' }
  Write-Ok 'profile deps installed'
} else {
  Write-Ok "link 已就位（node_modules\$pkgName → 本项目）：重新构建即生效，无需再 install"
}

# ── 6. 验证 ─────────────────────────────────────────────────────────────────
Write-Head '6/6 验证'
if ($NoVerify) {
  Write-Info '跳过（-NoVerify）'
} else {
  if (Get-Command dsh -ErrorAction SilentlyContinue) {
    $dump = (& dsh --profile $Profile --dump-config 2>&1 | Out-String)
    if ($dump -match [regex]::Escape($pkgName)) {
      Write-Ok "--dump-config 里能看到 $pkgName"
    } else {
      Write-Note "--dump-config 里没有 $pkgName —— 检查 profile 的 cordis.patch.yml（profile 配置本身是热重载的，不需要重启）"
    }
  } else {
    Write-Note 'PATH 上没有 dsh，跳过 --dump-config'
  }

  $probeUrl = "http://127.0.0.1:$Port/dsh-hunk/state?cwd=" + [uri]::EscapeDataString($root)
  try {
    # -UseBasicParsing 只在 Windows PowerShell 5.1 需要（且只在 5.1 存在），按版本带。
    $iwr = @{ Uri = $probeUrl; Headers = @{ Host = "127.0.0.1:$Port" }; TimeoutSec = 20 }
    if ($PSVersionTable.PSVersion.Major -lt 6) { $iwr['UseBasicParsing'] = $true }
    $resp = Invoke-WebRequest @iwr
    # 路由没挂上时，前端静态兜底会把 index.html 当成 200 返回，所以先看 content-type。
    if ($resp.Headers['Content-Type'] -notlike '*application/json*') {
      Write-Note '返回的不是 JSON（前端兜底页面）→ host 半还没被加载：重启 dsh web 才会挂上 /dsh-hunk/state'
    } else {
      $payload = $resp.Content | ConvertFrom-Json
      if ($payload.ok) {
        $matched = if ($null -eq $payload.matched) { 'none' } else { $payload.matched.sessionId }
        Write-Ok ("路由在跑：sessions=" + @($payload.sessions).Count + "  matched=" + $matched)
        if ($null -eq $payload.matched) {
          Write-Note ('没有匹配本工程 cwd 的 live Hunk 窗口 → 另开终端跑：cd ' + $root + ' ; hunk diff --watch')
        }
      } else {
        Write-Note ("路由返回业务错误：" + $payload.error.code + ' —— ' + $payload.error.message)
      }
    }
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 404) {
      Write-Note '路由 404：host 半还没被加载 —— 重启 dsh web 才会挂上 /dsh-hunk/state（见 DEBUGGING.md）'
    } elseif ($status -eq 403) {
      Write-Note '路由 403：信任围栏拒了这次请求（Host 头不是回环地址 / 带了跨站标记）'
    } else {
      Write-Note ("探测失败（dsh web 可能没在 $Port 上跑）：" + $_.Exception.Message)
    }
  }
}

# ── 收尾 ────────────────────────────────────────────────────────────────────
Write-Head '完成'
Write-Host '  client 半 lib/client.js ：构建完约 1 秒内自动热替换进已打开的页面（组件状态会重置）；没换成就 Ctrl+Shift+R'
Write-Host '  host   半 lib/index.js  ：默认要重启 dsh web 才加载新代码（会中断当前会话）；免重启方案见 DEBUGGING.md'
Write-Host '  前提                    ：终端里有 live Hunk 窗口 —— cd <仓库> && hunk diff --watch'
Write-Host '  调试入口                ：node scripts/preview.mjs [cwd] [--json] [--patches]'

if (-not $Watch) { exit 0 }

# ── watch 模式：src\ 一变就重建（不重跑测试/安装）─────────────────────────────
Write-Head '监听 src\（Ctrl+C 退出）'
function Get-SourceStamp {
  $files = Get-ChildItem -Path (Join-Path $root 'src') -Recurse -File -ErrorAction SilentlyContinue
  ($files | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$($_.LastWriteTimeUtc.Ticks)|$($_.Length)" }) -join "`n"
}
$stamp = Get-SourceStamp
while ($true) {
  Start-Sleep -Milliseconds 700
  $next = Get-SourceStamp
  if ($next -eq $stamp) { continue }
  $stamp = $next
  Write-Host ''
  Write-Host ("[watch] " + (Get-Date -Format 'HH:mm:ss') + "  src 有改动，重新构建 …") -ForegroundColor Cyan
  if ((Invoke-External 'npm' @('run', 'build', '--silent') $root) -ne 0) {
    Write-Note '构建失败，等下一次改动 …'
    continue
  }
  Write-Ok 'rebuilt lib/（client 半会自动热替换；host 半仍需重启 dsh web）'
}
