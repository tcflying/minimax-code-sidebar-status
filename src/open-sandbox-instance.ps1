# 开一个一次性独立实例，专门用来做破坏性测试。
# 关键：独立 --user-data-dir（绕开 Electron 单实例锁）+ 独立 CDP 端口。
#       全程不碰主上正在使用的那个实例。
#
#   pwsh -NoProfile -File .\open-sandbox-instance.ps1 [-Port 9355] [-Profile main]
#
# -Profile main  = 复制主实例的 user-data-dir（带登录态，慢）
# -Profile blank = 全新目录（快，但可能没登录态）
[CmdletBinding()]
param(
    [int]$Port = 9355,
    [string]$Profile = 'main',
    [string]$Label = 'sandbox'
)

$ErrorActionPreference = 'Continue'
$exe  = 'G:\MiniMax\MiniMax Code\MiniMax Code.exe'
$mainUdd = Join-Path $env:APPDATA 'MiniMax'
$sandboxRoot = Join-Path $env:TEMP "mmx-sandbox-$Label"
$udd = if ($Profile -eq 'main') { $sandboxRoot } else { Join-Path $sandboxRoot 'blank' }

$mainBefore = @(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue).Count
Write-Host "主实例进程数（开沙箱前）= $mainBefore"
Write-Host "沙箱 user-data-dir = $udd"
Write-Host "沙箱端口 = $Port"
Write-Host ''

# NOTE: deliberately no taskkill anywhere in this file. The sandbox is a
# separate process tree owned by its own --user-data-dir, so it is cleaned up
# by user-data-dir, never by killing processes. Killing "all MiniMax Code"
# here would take out the user's main instance, which is exactly the mistake
# this sandbox exists to prevent.
if (Test-Path -LiteralPath $sandboxRoot) {
    Write-Host "沙箱目录已存在：$sandboxRoot"
    Write-Host "  若上次沙箱进程还活着，请先跑 close-sandbox-instance.ps1；本脚本不主动杀任何进程。"
    Write-Host "  继续将复用该目录（含上次的登录态）。"
} else {
    New-Item -ItemType Directory -Force -Path $sandboxRoot | Out-Null
}

if ($Profile -eq 'main') {
    Write-Host '复制主实例 user-data-dir（保留登录态，耗时较久）...'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # robocopy 比 Copy-Item 快且能跳过占用中的锁文件
    & robocopy.exe $mainUdd $udd /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD 'Cache' 'Code Cache' 'GPUCache' 2>&1 | Out-Null
    Write-Host ("  robocopy 结束，耗时 {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    $sz = (Get-ChildItem -LiteralPath $udd -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum)
    Write-Host ("  沙箱大小 = {0:N1} MB / {1} 文件" -f ($sz.Sum / 1MB), $sz.Count)
} else {
    New-Item -ItemType Directory -Force -Path $udd | Out-Null
    Write-Host '使用全新空目录（无登录态）'
}

Write-Host ''
Write-Host "启动沙箱实例 ..."
Start-Process -FilePath $exe -ArgumentList @(
    "--remote-debugging-port=$Port",
    '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=$udd"
) | Out-Null

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    try {
        $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
        if ($v.webSocketDebuggerUrl) { $ok = $true; break }
    } catch { }
}
if (-not $ok) {
    Write-Host '!! 沙箱实例 CDP 没起来' -ForegroundColor Red
    exit 1
}
Write-Host "沙箱 CDP 就绪：$($v.Browser)"

Start-Sleep -Seconds 10
$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
Write-Host ''
Write-Host '沙箱实例的页面目标：'
foreach ($t in $targets) { if ($t.type -eq 'page') { Write-Host "  $($t.url)" } }

$mainAfter = @(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue).Count
Write-Host ''
Write-Host "主实例进程数（开沙箱后）= $mainAfter  （应 >= $mainBefore，说明主实例未被替换）"
Write-Host ''
Write-Host "沙箱端口 $Port ；用完请运行 close-sandbox-instance.ps1 -Port $Port"
exit 0
