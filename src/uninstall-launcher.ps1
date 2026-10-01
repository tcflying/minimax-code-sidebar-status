<#
.SYNOPSIS
  卸载 mmx-status 桌面入口 + 开机自启，把一切还原。

.DESCRIPTION
    1. 删除桌面上的 mmx-fix.lnk（本工具唯一创建的东西）
    2. 删除 Run 项 mmxStatusWatchdog（绝不碰 com.minimax.agent.cn）
    3. 打印还原结果

  官方那两个 MiniMax Code.lnk（桌面 / 开始菜单）**不在处理范围内**：
  2026-10-02 之前的 install-launcher.ps1 会改写它们，现在那个行为已删除，
  所以官方 lnk 从未被本工具动过，卸载时也无从"还原"。
  如果你机器上还留着历史版本改写出的 .lnk.bak，那是被删掉行为之前的遗留，
  可自行删除。

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
$FixLnkName = 'mmx-fix.lnk'

function Get-FixShortcut {
  return (Join-Path ([Environment]::GetFolderPath('Desktop')) $FixLnkName)
}
# 官方 lnk：只读列出并确认「没动过」，绝不写。
function Get-OfficialShortcuts {
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

# ---- 2. 删除本工具创建的 mmx-fix.lnk；官方 lnk 一个字节都不动 ----
foreach ($o in (Get-OfficialShortcuts)) {
  if (Test-Path -LiteralPath $o) {
    Write-Host "[保持不动] 官方快捷方式 $o（本工具从未改写它，无需还原）" -ForegroundColor DarkGray
  }
}
$fixLnk = Get-FixShortcut
if (Test-Path -LiteralPath $fixLnk) {
  if ($DryRun) {
    Write-Host "[dry-run] 删除 $fixLnk" -ForegroundColor Yellow
  } else {
    Remove-Item -LiteralPath $fixLnk -Force
    Write-Host "已删除: $fixLnk" -ForegroundColor Green
  }
  $removed.Add($fixLnk)
} else {
  Write-Host "[跳过] $fixLnk 不存在。" -ForegroundColor DarkGray
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
Write-Host '  （官方 .lnk 本工具从未改写，无需还原）'
Write-Host '=== 删除了什么 ===' -ForegroundColor Cyan
if ($removed.Count -eq 0) { Write-Host '（无）' } else { $removed | ForEach-Object { Write-Host "  - $_" } }
Write-Host '=== 历史遗留的备份文件 ===' -ForegroundColor Cyan
$legacy = @()
foreach ($o in (Get-OfficialShortcuts)) { if (Test-Path -LiteralPath "$o.bak") { $legacy += "$o.bak" } }
if ($legacy.Count -eq 0) { Write-Host '  （无）' }
else {
  Write-Host '  以下是旧版 install-launcher.ps1 改写官方 .lnk 时留下的备份，可自行删除：' -ForegroundColor DarkGray
  $legacy | ForEach-Object { Write-Host "  - $_" -ForegroundColor DarkGray }
}
Write-Host ''
Write-Host '注意：进程层面的东西需要手动处理 ——' -ForegroundColor Yellow
Write-Host '  1) 关掉正在运行的 watchdog：Get-CimInstance Win32_Process -Filter "Name=''node.exe''" |'
Write-Host '     Where-Object { $_.CommandLine -like ''*watchdog.mjs*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId }'
Write-Host '  2) daemon 由 Ctrl+C / stop-mmx-status.ps1 处理'
if ($DryRun) { Write-Host '（本次为 -DryRun，未做任何实际改动）' -ForegroundColor Yellow }
exit 0
