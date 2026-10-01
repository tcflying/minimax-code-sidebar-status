<#
.SYNOPSIS
  卸载 mmx-status 快捷方式改写 + 开机自启，把一切还原。

.DESCRIPTION
    1. 把 .lnk 从同名 .lnk.bak 原样复制回去（没有 .bak 就删除我们建的 .lnk）
    2. 删除 Run 项 mmxStatusWatchdog（绝不碰 com.minimax.agent.cn）
    3. 打印还原结果

.EXAMPLE
  pwsh -NoProfile -File .\uninstall-launcher.ps1 -DryRun
#>
[CmdletBinding()]
param(
  # 只打印将要做的改动，不落盘。
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'mmxStatusWatchdog'
$StateFile = Join-Path $Root 'logs\install-state.json'

function Get-ShortcutTargets {
  $paths = @()
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MiniMax Code.lnk'
  $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MiniMax Code.lnk'
  foreach ($p in @($startMenu, $desktop)) { if ($p) { $paths += $p } }
  return $paths
}

Write-Host '=== mmx-status 卸载器 ===' -ForegroundColor Cyan

$restored = New-Object System.Collections.Generic.List[string]
$removed = New-Object System.Collections.Generic.List[string]

# ---- 1. 官方 Run 项只读确认 ----
$official = Get-ItemProperty -LiteralPath $RunKey -Name 'com.minimax.agent.cn' -ErrorAction SilentlyContinue
if ($official) {
  Write-Host "[保持不动] 官方自启项 com.minimax.agent.cn = $($official.'com.minimax.agent.cn')" -ForegroundColor DarkGray
}

# ---- 2. 还原快捷方式 ----
foreach ($lnk in (Get-ShortcutTargets)) {
  $bak = "$lnk.bak"
  if (Test-Path -LiteralPath $bak) {
    if ($DryRun) {
      Write-Host "[dry-run] 还原 $bak -> $lnk" -ForegroundColor Yellow
    } else {
      Copy-Item -LiteralPath $bak -Destination $lnk -Force
      Write-Host "已还原: $lnk（来自 $bak）" -ForegroundColor Green
    }
    $restored.Add($lnk)
  } elseif (Test-Path -LiteralPath $lnk) {
    # 没有备份说明这个 .lnk 要么是官方的，要么是我们建的（无备份=我们没备份过）。
    # 保守起见只提示，不删，避免毁掉官方图标。
    Write-Host "[跳过] $lnk 没有对应 .bak，保留原文件（不删除官方图标）。" -ForegroundColor Yellow
  }
}

# ---- 3. 删除自启项 ----
$existing = Get-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue
if ($existing) {
  if ($DryRun) {
    Write-Host "[dry-run] 删除 $RunKey\$RunName = $($existing.$RunName)" -ForegroundColor Yellow
  } else {
    Remove-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue
    Write-Host "已删除开机自启项: $RunName" -ForegroundColor Green
  }
  $removed.Add("Run\$RunName")
} else {
  Write-Host "[跳过] 没有找到自启项 $RunName。" -ForegroundColor DarkGray
}

# ---- 4. 状态文件 ----
if (Test-Path -LiteralPath $StateFile) {
  if ($DryRun) {
    Write-Host "[dry-run] 删除状态文件 $StateFile" -ForegroundColor Yellow
  } else {
    Remove-Item -LiteralPath $StateFile -Force
    Write-Host "已删除状态文件: $StateFile" -ForegroundColor Green
  }
}

Write-Host ''
Write-Host '=== 还原了什么 ===' -ForegroundColor Cyan
if ($restored.Count -eq 0) { Write-Host '（无快捷方式改动）' } else { $restored | ForEach-Object { Write-Host "  - $_ <- .lnk.bak" } }
Write-Host '=== 删除了什么 ===' -ForegroundColor Cyan
if ($removed.Count -eq 0) { Write-Host '（无自启项）' } else { $removed | ForEach-Object { Write-Host "  - $_" } }
Write-Host '=== 备份文件 ===' -ForegroundColor Cyan
foreach ($lnk in (Get-ShortcutTargets)) {
  $bak = "$lnk.bak"
  if (Test-Path -LiteralPath $bak) { Write-Host "  - $bak（保留未删，可自行删除）" -ForegroundColor DarkGray }
}
Write-Host ''
Write-Host '注意：进程层面的东西需要手动处理 ——' -ForegroundColor Yellow
Write-Host '  1) 关掉正在运行的 watchdog：Get-CimInstance Win32_Process -Filter "Name=''node.exe''" |'
Write-Host '     Where-Object { $_.CommandLine -like ''*watchdog.mjs*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId }'
Write-Host '  2) daemon 由 Ctrl+C / stop-mmx-status.ps1 处理'
if ($DryRun) { Write-Host '（本次为 -DryRun，未做任何实际改动）' -ForegroundColor Yellow }
exit 0
