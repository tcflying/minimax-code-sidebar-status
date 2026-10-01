[CmdletBinding()]
param(
  # 默认端口与生产端口一致（9331）。旧默认是 9351，而 launch-mmx-status.ps1
  # 的兜底就是 9331：裸跑 stop 会去停一个根本不存在的 9351 daemon，
  # 对真正在跑的 9331 毫无作用，还照常打印「完成。」
  [int]$Port = 9331
)

# Removes every injected node and style from the running MiniMax Code
# renderer, then stops the daemon. The application itself is left running and
# app.asar is never touched.

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
# 端口参数形态判定与 launch/start 共用同一份实现，避免出现第四份正则。
. (Join-Path $Root 'lib-stale-daemon.ps1') -Root $Root
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
# 旧写法是 ('--port\s+' + $Port + '(\s|$)')，只匹配空格分隔。
# 任何以 --port=9331 启动的 daemon 会被静默漏杀，而下面还会照常打印
# 「没有端口 X 的守护进程。」+「完成。」—— 最坏情况是 stop 声称成功、
# 实际没停。launch-mmx-status.ps1 用的就是 '--port[=\s]'。
$daemons = @($all | Where-Object { Test-DaemonPortArg -CommandLine $_.CommandLine -Port $Port })
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
