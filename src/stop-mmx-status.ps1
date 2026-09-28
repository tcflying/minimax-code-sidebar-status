[CmdletBinding()]
param(
  [int]$Port = 9351
)

# Removes every injected node and style from the running MiniMax Code
# renderer, then stops the daemon. The application itself is left running and
# app.asar is never touched.

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) { Write-Host '找不到 node.exe。' -ForegroundColor Red; exit 1 }

# 1) Clean the page FIRST, while the daemon (if any) is still alive and the
#    CDP session is still open -- disposing from the page side is the most
#    reliable path, because it does not depend on the daemon cooperating.
Write-Host '还原页面注入...'
& $node (Join-Path $Root 'cleanup.mjs') --port $Port 2>&1 | ForEach-Object { Write-Host "  $_" }

# 2) Then stop the daemon FOR THIS PORT ONLY. Killing every daemon.mjs would
#    take down an unrelated instance that happens to be serving another port.
$all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'daemon\.mjs' })
$daemons = @($all | Where-Object { $_.CommandLine -match ("--port\s+" + $Port + '(\s|$)') })
$others = $all.Count - $daemons.Count

if ($daemons.Count -gt 0) {
  Write-Host "停止端口 $Port 的 $($daemons.Count) 个守护进程..."
  $daemons | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "  stopped pid $($_.ProcessId)"
  }
} else {
  Write-Host "没有端口 $Port 的守护进程。"
}
if ($others -gt 0) { Write-Host "（另有 $others 个守护进程服务其它端口，未触碰）" }

Write-Host '完成。MiniMax Code 本身未做任何修改，重启即彻底还原。' -ForegroundColor Green
exit 0
