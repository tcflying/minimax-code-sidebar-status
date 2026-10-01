# mmx-status :: test-launcher.ps1
# Exercises start-mmx-status.ps1 end to end against a DISPOSABLE MiniMax Code
# instance. Never touches the user's main instance: we only ever point the
# launcher at a port that a throwaway instance already owns, and every check is
# an ASCII token so the assertions cannot be corrupted by console codepage.
#
#   pwsh -NoProfile -File test-launcher.ps1
#
# ⚠️ 这个脚本会真的起一个 MiniMax Code 实例（第 B 组）并按 --user-data-dir
#    结束它。运行前请先关掉你正在用的沙箱窗口，或直接跳过本脚本。
#
# 端口护栏（2026-10-02 修）：旧默认 9355 与用户正在运行的沙箱实例端口完全相同，
# 而本脚本第 B 组会起真实例、第 D 组会按 user-data-dir 杀进程 —— 用户照着跑
# 会直接撞上自己的沙箱。换成 9455，并在下面加了一道显式护栏：目标端口上
# 已经有 CDP 在监听就直接退出，绝不碰那个进程。
# 选 9455 的理由：远离生产 9331 与沙箱 9355，落在 Chromium/Electron
# 调试常用高位段（9xxx）内，且与本机其它已知端口无冲突。

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $Root 'start-mmx-status.ps1'
$port = 9455
$udd = Join-Path $env:TEMP 'mmx-launcher-test2'

# ---- 显式护栏：目标端口已有 CDP 在监听就退出，绝不碰那个进程 ----
$portBusy = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing
  $portBusy = ($r.StatusCode -eq 200)
} catch { $portBusy = $false }
if ($portBusy) {
  Write-Host "端口 $port 上已经有 CDP 在监听 —— 那不是本脚本起的实例。" -ForegroundColor Red
  Write-Host '本脚本会按 --user-data-dir 结束进程，绝不能误伤别人的实例。已退出。' -ForegroundColor Red
  exit 2
}
Write-Host "护栏通过：端口 $port 上没有 CDP。"

$script:pass = 0
$script:fail = 0

function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) {
    $script:pass++; Write-Host ('  PASS  ' + $name + $(if ($detail) { '  ::  ' + $detail }))
  } else {
    $script:fail++; Write-Host ('  FAIL  ' + $name + $(if ($detail) { '  ::  ' + $detail }))
  }
}
# ASCII-only token search: immune to the GBK console codepage mangling Chinese.
function HasAscii([string]$hay, [string]$tok) { return ($hay.IndexOf($tok, [StringComparison]::OrdinalIgnoreCase) -ge 0) }

$mainBefore = @(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue).Count
Write-Host ('main-instance processes before: ' + $mainBefore)

# ------------------------------------------------------------------ DryRun
Write-Host ''
Write-Host '=== A. -DryRun prints the plan and changes nothing ==='
$out = (& $launcher -DryRun -Port $port *>&1 | Out-String)
$rc = $LASTEXITCODE
Write-Host $out
Check 'A1 exit 0' ($rc -eq 0) ''
Check 'A2 resolves the exe' (HasAscii $out 'MiniMax Code.exe') ''
Check 'A3 shows the CDP port flag' (HasAscii $out ("--remote-debugging-port=$Port")) ''
Check 'A4 shows loopback binding' (HasAscii $out '--remote-debugging-address=127.0.0.1') ''
Check 'A5 shows the daemon command' (HasAscii $out 'daemon.mjs') ''
Check 'A6 no bad cmdlet' (-not (HasAscii $out 'Write-NoNewline')) ''
Check 'A7 did not start anything' ((@(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue).Count) -eq $mainBefore) ''

# ------------------------------------------------------------------ cold start
Write-Host ''
Write-Host '=== B. cold start: CDP up but renderer not yet loaded ==='
New-Item -ItemType Directory -Force -Path $udd | Out-Null
$exe = 'G:\MiniMax\MiniMax Code\MiniMax Code.exe'
Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1', "--user-data-dir=$udd") | Out-Null

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { if ((Invoke-WebRequest "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ready = $true; break } } catch {}
}
Check 'B1 throwaway instance exposes CDP' $ready ''

if ($ready) {
  # The daemon must wait for app://./archon on its own; we deliberately do not
  # wait for it here. This is the path that used to fail with
  # "renderer target not found".
  $o = (& $launcher -Port $port -Once *>&1 | Out-String)
  Write-Host $o
  Check 'B2 skips the restart prompt' (HasAscii $o 'CDP') ''
  Check 'B3 daemon announces renderer wait' (HasAscii $o 'app://./archon') ''
  Check 'B4 reached the renderer target' (-not (HasAscii $o 'not found')) ''
  Check 'B5 connected to the CDP browser' (HasAscii $o 'Chrome/') ''
  Check 'B6 read the live session database' (HasAscii $o 'runtime-state.sqlite') ''
  Check 'B7 injection reported ok' (HasAscii $o '"ok":true') ''
  Check 'B8 one-shot run finished and restored' (HasAscii $o 'rows') ''
  Check 'B9 no unhandled node error' (-not (HasAscii $o 'SyntaxError')) ''
}

Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like ('*' + $udd + '*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# ------------------------------------------------------------------ stop path
Write-Host ''
Write-Host '=== C. stop-mmx-status.ps1 is safe with nothing installed ==='
$s = (& (Join-Path $Root 'stop-mmx-status.ps1') -Port $port *>&1 | Out-String)
Write-Host $s
Check 'C1 stop exits cleanly' ($LASTEXITCODE -eq 0) ''
Check 'C2 stop did not throw' (-not (HasAscii $s 'Exception')) ''

$mainAfter = @(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue).Count
Write-Host ''
Write-Host ('main-instance processes after: ' + $mainAfter)
Check 'D1 user main instance untouched' ($mainAfter -ge 1) ("after=" + $mainAfter)
Check 'D2 no leftover mmx-status daemon' ((@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*mmx-status*' }).Count) -eq 0) ''

Write-Host ''
Write-Host ('=== RESULT: ' + $script:pass + ' passed, ' + $script:fail + ' failed ===')
if ($script:fail -eq 0) { exit 0 } else { exit 1 }
