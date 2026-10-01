<#
.SYNOPSIS
  安装 mmx-status 快捷方式改写 + 看门狗开机自启。

.DESCRIPTION
  做三件事：
    1. 备份并改写开始菜单 / 桌面的 MiniMax Code.lnk，使其指向
       powershell.exe -NoProfile -WindowStyle Hidden -File launch-mmx-status.ps1
    2. 新增 HKCU\...\Run 项（名字 mmxStatusWatchdog）启动 watchdog.mjs
    3. 打印「改了什么 / 备份在哪 / 怎么还原」

  绝不触碰官方自启项 HKCU\...\Run\com.minimax.agent.cn。

.EXAMPLE
  pwsh -NoProfile -File .\install-launcher.ps1 -DryRun
#>
[CmdletBinding()]
param(
  # 只打印将要做的改动，不落盘。
  [switch]$DryRun,
  # 跳过开机自启，只改快捷方式。
  [switch]$NoAutostart,
  # 开机自启时带上 --fix-app（会结束正在运行的无 CDP 实例并重启）。
  [switch]$FixApp,
  # 不改快捷方式，只装开机自启。
  [switch]$OnlyAutostart
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $Root 'launch-mmx-status.ps1'
$Watchdog = Join-Path $Root 'watchdog.mjs'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'mmxStatusWatchdog'

if (-not (Test-Path -LiteralPath $Launcher)) { throw "缺少 $Launcher" }
if (-not (Test-Path -LiteralPath $Watchdog)) { throw "缺少 $Watchdog" }

$stateDir = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
$StateFile = Join-Path $stateDir 'install-state.json'

function Get-ShortcutTargets {
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
    $sc.Description = 'MiniMax Code (mmx-status launcher)'
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

# ---- 2. 快捷方式 ----
if (-not $OnlyAutostart) {
  foreach ($lnk in (Get-ShortcutTargets)) {
    $bak = "$lnk.bak"
    if (Test-Path -LiteralPath $lnk) {
      if (Test-Path -LiteralPath $bak) {
        Write-Host "[跳过备份] 已存在 $bak（保留最早的原始备份）" -ForegroundColor Yellow
      } else {
        if ($DryRun) {
          Write-Host "[dry-run] 备份 $lnk -> $bak" -ForegroundColor Yellow
        } else {
          Copy-Item -LiteralPath $lnk -Destination $bak -Force
          Write-Host "已备份: $bak" -ForegroundColor Green
          $backups.Add($bak)
        }
      }
    } else {
      Write-Host "[跳过] $lnk 不存在（不会凭空创建图标）" -ForegroundColor DarkGray
      continue
    }
    $icon = ''
    if ($official) { $icon = 'C:\Program Files\MiniMax Code\MiniMax Code.exe,0' }
    if ($DryRun) {
      Write-Host "[dry-run] 改写 $lnk" -ForegroundColor Yellow
      Write-Host "           Target = $psExe"
      Write-Host "           Args   = $launcherArgs"
    } else {
      New-Shortcut -Path $lnk -Target $psExe -Arguments $launcherArgs -IconLocation $icon
      Write-Host "已改写: $lnk" -ForegroundColor Green
    }
    $changes.Add("快捷方式 $lnk -> powershell -WindowStyle Hidden -File `"$Launcher`"")
  }
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
if ($backups.Count -eq 0) { Write-Host '（无）' } else { $backups | ForEach-Object { Write-Host "  - $_" } }
Write-Host '=== 怎么还原 ===' -ForegroundColor Cyan
Write-Host '  pwsh -NoProfile -File ".\uninstall-launcher.ps1"'
Write-Host '  （uninstall 会把 .lnk 从 .lnk.bak 原样复制回去，并删除 Run 项 mmxStatusWatchdog）'
if ($DryRun) { Write-Host '（本次为 -DryRun，未做任何实际改动）' -ForegroundColor Yellow }
exit 0
