<#
.SYNOPSIS
  安装 mmx-fix.lnk 桌面入口 + 看门狗开机自启。

.DESCRIPTION
  做两件事：
    1. 新建（或覆盖）桌面上的 mmx-fix.lnk，指向
       powershell.exe -NoProfile -WindowStyle Hidden -File launch-mmx-status.ps1
    2. 新增 HKCU\...\Run 项（名字 mmxStatusWatchdog）启动 watchdog.mjs
    3. 打印「改了什么 / 备份在哪 / 怎么还原」

  ══ 为什么不碰官方那两个 .lnk（2026-10-02 修正）══
  旧版这个脚本改写的正是「开始菜单 / 桌面的 MiniMax Code.lnk」——按官方名字。
  这与 README 第 14 章的处方**完全相反**：官方更新器是按名字回写这两个 .lnk 的
  （实测 2026-09-30 22:25 桌面、2026-10-01 02:56 开始菜单被改回无参数直连），
  所以按官方名字改写 = 每次官方更新注入就断一次。治本办法是**不要用官方名字**：
  唯一命名一个 mmx-fix.lnk，官方 lnk 保持原样、一个字节都不动。

  旧版还有个更隐蔽的问题：全文件**没有任何创建 mmx-fix.lnk 的代码**，
  而 fix-coldstart.ps1 / restart-cold.ps1 / restart-e2e.ps1 全都在**消费**
  桌面上的 mmx-fix.lnk（Start-Process 那个路径）。也就是说旧版装完，红 M
  根本不存在，本工具的冷启动链是断的。

  绝不触碰官方自启项 HKCU\...\Run\com.minimax.agent.cn。

.EXAMPLE
  pwsh -NoProfile -File .\install-launcher.ps1 -DryRun
#>
[CmdletBinding()]
param(
  # 只打印将要做的改动，不落盘。
  [switch]$DryRun,
  # 跳过开机自启，只建快捷方式。
  [switch]$NoAutostart,
  # 开机自启时带上 --fix-app（会结束正在运行的无 CDP 实例并重启）。
  [switch]$FixApp,
  # 不建快捷方式，只装开机自启。
  [switch]$OnlyAutostart
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $Root 'launch-mmx-status.ps1'
$Watchdog = Join-Path $Root 'watchdog.mjs'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'mmxStatusWatchdog'
# 唯一入口的名字。刻意不叫 MiniMax Code.lnk —— 官方更新器按名字回写，
# 撞上名字就等于每次更新断一次注入。
$FixLnkName = 'mmx-fix.lnk'

if (-not (Test-Path -LiteralPath $Launcher)) { throw "缺少 $Launcher" }
if (-not (Test-Path -LiteralPath $Watchdog)) { throw "缺少 $Watchdog" }

$stateDir = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
$StateFile = Join-Path $stateDir 'install-state.json'

# 本脚本要建的**只有**这一个快捷方式。
function Get-ShortcutTarget {
  return (Join-Path ([Environment]::GetFolderPath('Desktop')) $FixLnkName)
}
# 官方那两个：只读列出、明确报告「不动」，绝不写。
function Get-OfficialShortcuts {
  $paths = @()
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MiniMax Code.lnk'
  $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MiniMax Code.lnk'
  foreach ($p in @($startMenu, $desktop)) { if ($p) { $paths += $p } }
  return $paths
}

function New-Shortcut {
  param([string]$Path, [string]$Target, [string]$Arguments, [string]$IconLocation)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $shell = New-Object -ComObject WScript.Shell
  try {
    $sc = $shell.CreateShortcut($Path)
    $sc.TargetPath = $Target
    $sc.Arguments = $Arguments
    $sc.WorkingDirectory = $Root
    $sc.IconLocation = $IconLocation
    $sc.Description = 'MiniMax Code (mmx-status 启动入口，红 M)'
    # 7 = minimized. -WindowStyle Hidden in the arguments only hides the
    # console AFTER powershell.exe has created it, so a WindowStyle of 1
    # (normal) still flashes a black cmd window on every launch (user-visible
    # 2026-10-02). 7 makes the window START minimized: no flash, no focus steal.
    # Not 7-to-Invisible (no such value exists); this is the closest Windows
    # .lnk semantics allow.
    $sc.WindowStyle = 7
    $sc.Save()
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcherArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Launcher + '"'
$changes = New-Object System.Collections.Generic.List[string]
$backups = New-Object System.Collections.Generic.List[string]

Write-Host '=== mmx-status 安装器 ===' -ForegroundColor Cyan
Write-Host "Root: $Root"
Write-Host "日志目录: $stateDir"

# ---- 1. 官方 Run 项只读确认（绝不修改） ----
$official = (Get-ItemProperty -LiteralPath $RunKey -Name 'com.minimax.agent.cn' -ErrorAction SilentlyContinue)
if ($official) {
  Write-Host "[保持不动] 官方自启项 com.minimax.agent.cn = $($official.'com.minimax.agent.cn')" -ForegroundColor DarkGray
} else {
  Write-Host '[提示] 未发现官方自启项 com.minimax.agent.cn（正常，不做任何修改）。' -ForegroundColor DarkGray
}

# ---- 2. 只建 mmx-fix.lnk；官方 lnk 一个字节都不动 ----
if (-not $OnlyAutostart) {
  # 官方 lnk 只读报告：明确告诉用户本脚本不会碰它们。
  foreach ($o in (Get-OfficialShortcuts)) {
    if (Test-Path -LiteralPath $o) {
      Write-Host "[保持不动] 官方快捷方式 $o（官方更新器按名字回写它，改它等于每次更新断一次注入）" -ForegroundColor DarkGray
    }
  }

  $lnk = Get-ShortcutTarget
  # 自绘红色 M 图标：优先用仓库里的 assets/mmx-fix.ico，没有就退回官方 exe 的图标 0 号。
  $iconRepo = Join-Path (Split-Path -Parent $Root) 'assets\mmx-fix.ico'
  $icon = ''
  if (Test-Path -LiteralPath $iconRepo) { $icon = "$iconRepo,0" }
  else { $icon = 'C:\Program Files\MiniMax Code\MiniMax Code.exe,0' }

  if ($DryRun) {
    Write-Host "[dry-run] 创建/覆盖 $lnk" -ForegroundColor Yellow
    Write-Host "           Target = $psExe"
    Write-Host "           Args   = $launcherArgs"
    Write-Host "           Icon   = $icon"
  } else {
    New-Shortcut -Path $lnk -Target $psExe -Arguments $launcherArgs -IconLocation $icon
    Write-Host "已创建: $lnk" -ForegroundColor Green
  }
  $changes.Add("快捷方式 $lnk -> powershell -WindowStyle Hidden -File `"$Launcher`"")
}

# ---- 3. 开机自启 ----
$existing = Get-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue
# The autostart value MUST name the script file. A value that only points at
# node.exe starts and exits immediately: it looks installed, but nothing ever
# runs. This shipped as a silent failure once, so the script token is now
# pinned by a guard and the registry value is read back after writing.
$watchdogScript = Join-Path $Root 'watchdog.mjs'
if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) {
  throw "watchdog script not found: $watchdogScript"
}
$wdCommand = '"{0}" "{1}" --log "{2}"' -f (Get-Command node).Source, $watchdogScript, (Join-Path $stateDir 'watchdog.log')
if ($FixApp) { $wdCommand += ' --fix-app' }
# Pin the judgement on the semantic token, not on quoting style, so a
# refactor cannot silently turn the autostart entry back into a no-op.
if ($wdCommand -notmatch '(?i)watchdog\.mjs') {
  throw "refusing to write an autostart command without the script name: $wdCommand"
}

if ($NoAutostart) {
  Write-Host '[跳过] -NoAutostart：不新增开机自启项。' -ForegroundColor DarkGray
} else {
  if ($existing -and $existing.$RunName -eq $wdCommand) {
    Write-Host "[保持] 开机自启项 $RunName 已经是目标命令。" -ForegroundColor DarkGray
  } elseif ($DryRun) {
    Write-Host "[dry-run] 新增 $RunKey\$RunName" -ForegroundColor Yellow
    Write-Host "           值 = $wdCommand"
  } else {
    # New-Item has NO -LiteralPath parameter (that is Set-ItemProperty's); using
    # it aborted the whole install halfway and silently skipped the autostart
    # entry. The HKCU Run key normally already exists, so only create it when
    # it is genuinely missing.
    if (-not (Test-Path -LiteralPath $RunKey)) {
      New-Item -Path $RunKey -Force | Out-Null
    }
    Set-ItemProperty -LiteralPath $RunKey -Name $RunName -Value $wdCommand
    # Read it back. "Set-ItemProperty returned without error" is not proof the
    # value landed, and a value that landed but names no script is still a
    # no-op at logon.
    $readBack = (Get-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue).$RunName
    if ($readBack -ne $wdCommand -or $readBack -notmatch '(?i)watchdog\.mjs') {
      throw "autostart read-back mismatch: wrote [$wdCommand] got [$readBack]"
    }
    Write-Host "已新增开机自启项: $RunName" -ForegroundColor Green
    $changes.Add("Run\$RunName = $wdCommand")
  }
}

# ---- 4. 状态文件 ----
$state = [pscustomobject]@{
  installedAt = (Get-Date).ToString('s')
  root = $Root
  launcher = $Launcher
  watchdog = $Watchdog
  runKey = $RunKey
  runName = $RunName
  backups = @($backups)
  changes = @($changes)
}
if ($DryRun) {
  Write-Host '[dry-run] 不写 logs/install-state.json。' -ForegroundColor Yellow
} else {
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
  Write-Host "已写状态文件: $StateFile" -ForegroundColor Green
}

Write-Host ''
Write-Host '=== 改了什么 ===' -ForegroundColor Cyan
if ($changes.Count -eq 0) { Write-Host '（无）' } else { $changes | ForEach-Object { Write-Host "  - $_" } }
Write-Host '=== 备份在哪 ===' -ForegroundColor Cyan
if ($backups.Count -eq 0) {
  Write-Host '  （无。本脚本不改任何官方 .lnk，所以没有需要还原的官方快捷方式。）'
} else { $backups | ForEach-Object { Write-Host "  - $_" } }
Write-Host '=== 怎么还原 ===' -ForegroundColor Cyan
Write-Host '  pwsh -NoProfile -File ".\uninstall-launcher.ps1"'
Write-Host '  （uninstall 会删除 mmx-fix.lnk 并删除 Run 项 mmxStatusWatchdog；官方 .lnk 从未被改动，无需还原）'
if ($DryRun) { Write-Host '（本次为 -DryRun，未做任何实际改动）' -ForegroundColor Yellow }
exit 0
