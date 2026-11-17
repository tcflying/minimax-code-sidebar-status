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
#
# 2026-11-17 事故与本文件的改动：
#   1) 冷启动那组的 exe 写死 'G:\MiniMax\MiniMax Code\MiniMax Code.exe'
#      （本机没有 G 盘）→ 永远等不到 CDP → 整个测试挂住。现在改成和 launcher
#      同一套解析（MINIMAX_CODE_EXECUTABLE 优先），拿不到就 SKIP 并写明原因。
#   2) 新增 E 组回归断言：锁死「杀进程取 Id 而不是 ProcessId」「旧实例没死透
#      就 fail fast（不启动新实例、退出码 6）」「relaunch 的 exe 探测」。

[CmdletBinding()]
param(
  # 冷启动组（B 组）会真的启动一个 MiniMax Code 实例（--user-data-dir 隔离）。
  # 默认跳过：它会弹窗、占资源。要真跑冷启动就显式加 -AllowColdStart。
  [switch]$AllowColdStart
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $Root 'start-mmx-status.ps1'
$launchStatus = Join-Path $Root 'launch-mmx-status.ps1'
$relaunch = Join-Path $Root 'relaunch-cdp-delayed.ps1'
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
$script:skip = 0

function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) {
    $script:pass++; Write-Host ('  PASS  ' + $name + $(if ($detail) { '  ::  ' + $detail }))
  } else {
    $script:fail++; Write-Host ('  FAIL  ' + $name + $(if ($detail) { '  ::  ' + $detail }))
  }
}

function Skip([string]$name, [string]$reason) {
  $script:skip++; Write-Host ('  SKIP  ' + $name + $(if ($reason) { '  ::  ' + $reason }))
}

# 从脚本文件里取出某个函数的定义文本（测真实现，不复制一份逻辑）。
function Get-PSFunctionText {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) { return $null }
  $fn = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true))
  if ($fn.Count -eq 0) { return $null }
  return $fn[0].Extent.Text
}

# 把被测脚本里的某个函数原样搬进本会话来调用。
# 只返回 scriptblock，不在这里定义：Invoke-Expression 定义出来的函数活在本函数
# 的作用域里，出了函数就没了。调用方用 `. $fn` 点源进来，函数才会落在调用方
# 所在的脚本作用域。
function Import-PSFunction {
  param([string]$Path, [string]$Name)
  $text = Get-PSFunctionText -Path $Path -Name $Name
  if (-not $text) { return $null }
  return [scriptblock]::Create($text)
}

# 搬进来的 launch-mmx-status.ps1 函数会调 Write-Log；测试会话里给它一个
# 只打印的替身（不往仓库的 logs 目录里写东西）。
function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  Write-Host ("    [launcher] $Message")
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
# exe 解析必须和 launcher 同一套（MINIMAX_CODE_EXECUTABLE 优先）。2026-11-17
# 之前这里写死 'G:\MiniMax\MiniMax Code\MiniMax Code.exe'（本机没有 G 盘）
# → 冷启动那段永远等不到 CDP → 整个测试挂住。
$exe = $null
$exeFn = Import-PSFunction -Path $launcher -Name 'Get-MiniMaxExecutable'
if ($exeFn) {
  . $exeFn
  $exe = Get-MiniMaxExecutable
}
$started = $false
if (-not $exe) {
  Skip 'B0 exe 解析' '找不到 MiniMax Code.exe（MINIMAX_CODE_EXECUTABLE 没设，也没有常见安装路径），冷启动组跳过。'
} elseif (-not $AllowColdStart) {
  Skip 'B0 冷启动组' '冷启动组会真的启动一个 MiniMax Code 实例，默认不跑；要跑请加 -AllowColdStart。'
} else {
  New-Item -ItemType Directory -Force -Path $udd | Out-Null
  Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1', "--user-data-dir=$udd") | Out-Null
  $started = $true

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
}

if ($started) {
  Start-Sleep -Seconds 2
  Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like ('*' + $udd + '*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}

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

# ----------------------------------------------- E. regression: 2026-11-17
Write-Host ''
Write-Host '=== E. regression: 2026-11-17 launcher incident ==='

# --- E1 静态断言：杀进程用的 id 属性必须是 Get-Process 真实暴露的那个 ---
$killText = Get-PSFunctionText -Path $launchStatus -Name 'Stop-ProcessById'
Check 'E1 杀进程函数存在' ($null -ne $killText) ''
if ($killText) {
  # 断言只看代码行：注释里必须保留「Id vs ProcessId」的提醒。
  $killCode = (($killText -split "`n") | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  Check 'E1a 杀进程读的是 Get-Process 的 Id' ($killCode -match '\$Proc\.Id\b') ''
  Check 'E1b 没有混用 CIM 的 ProcessId' ($killCode -notmatch 'ProcessId') ''
  Check 'E1c 注释写明了 Id 与 ProcessId 的区别' ($killText -match 'ProcessId') ''
}
$cmdText = Get-PSFunctionText -Path $launchStatus -Name 'Get-PortFromProcessCommandLine'
Check 'E1d CIM 那处仍然用 ProcessId' (($null -ne $cmdText) -and ($cmdText -match '\.ProcessId')) ''
$selfProc = Get-Process -Id $PID
Check 'E1e Get-Process 真的只给 Id' (($selfProc.PSObject.Properties['Id'] -ne $null) -and ($selfProc.PSObject.Properties['ProcessId'] -eq $null)) ''

# --- E2 功能断言：真起一个 fixture 进程，用修复后的取值逻辑把它真杀掉 ---
$fixture = $null
try {
  $hostExe = (Get-Process -Id $PID).Path
  $fixture = Start-Process -FilePath $hostExe -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 300' -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 800
  $fixtureProc = Get-Process -Id $fixture.Id
  $killFn = Import-PSFunction -Path $launchStatus -Name 'Stop-ProcessById'
  Check 'E2 杀进程函数可调用' ($null -ne $killFn) ''
  if ($killFn) {
    . $killFn
    [void](Stop-ProcessById -Proc $fixtureProc)
  }
  $gone = $false
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Process -Id $fixture.Id -ErrorAction SilentlyContinue)) { $gone = $true; break }
    Start-Sleep -Milliseconds 100
  }
  Check 'E2 fixture 进程真被杀掉' $gone ('pid=' + $fixture.Id)
} finally {
  if ($fixture) { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue }
}

# --- E3 fail fast：旧实例没死透 → 不启动新实例 + 独立退出码 ---
# 用桩验证：Get-Process / Stop-Process / Start-Process / Invoke-WebRequest /
# Start-Sleep 全换成假的，MiniMax Code / daemon / keeper 一个都不碰。
$wrapper = Join-Path $env:TEMP ('mmx-failfast-' + [guid]::NewGuid().ToString('N') + '.ps1')
$marker = Join-Path $env:TEMP ('mmx-failfast-' + [guid]::NewGuid().ToString('N') + '.marker')
$stub = @'
param([string]$Launcher, [string]$Marker)
# 桩进程 id 直接写死在下面对象里：PowerShell 是动态作用域，函数被别的脚本
# 调用时 $script: 指的是调用方的脚本作用域，取不到这里的值。
function Get-Process { [CmdletBinding()] param([string]$Name, [int]$Id)
  if ($Id -gt 0) { return @([pscustomobject]@{ Id = $Id; ProcessName = 'mmx-stub' }) }
  return @([pscustomobject]@{ Id = 1001; ProcessName = 'mmx-stub' },
           [pscustomobject]@{ Id = 1002; ProcessName = 'mmx-stub' },
           [pscustomobject]@{ Id = 1003; ProcessName = 'mmx-stub' }) }
function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) }
function Start-Process { [CmdletBinding()] param([string]$FilePath, $ArgumentList, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
  Set-Content -LiteralPath $Marker -Value ('started: ' + $FilePath) }
function Invoke-WebRequest { [CmdletBinding()] param($Uri, $TimeoutSec, [switch]$UseBasicParsing) throw 'stub: no CDP' }
function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds, [int]$Seconds) }
& $Launcher -Port 9477
exit $LASTEXITCODE
'@

[System.IO.File]::WriteAllText($wrapper, $stub, (New-Object System.Text.UTF8Encoding($false)))
$childOut = (& (Get-Process -Id $PID).Path -NoProfile -File $wrapper -Launcher $launchStatus -Marker $marker 2>&1 | Out-String)
$childRc = $LASTEXITCODE
Check 'E3 旧实例没死透时退出码是 6' ($childRc -eq 6) ('rc=' + $childRc)
Check 'E3 没有启动新实例' (-not (Test-Path -LiteralPath $marker)) ''
Check 'E3 日志写明还剩哪些 pid' (($childOut -match '1001') -and ($childOut -match '1002') -and ($childOut -match '1003')) ''
Remove-Item -LiteralPath $wrapper -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue

# --- E4 relaunch-cdp-delayed.ps1 的 exe 探测必须能在本机解析出真实路径 ---
$relaunchText = Get-PSFunctionText -Path $relaunch -Name 'Get-MiniMaxExecutable'
Check 'E4 relaunch 有 exe 探测函数' ($null -ne $relaunchText) ''
if ($relaunchText) {
  Check 'E4a 候选里有 MINIMAX_CODE_EXECUTABLE' ($relaunchText -match 'MINIMAX_CODE_EXECUTABLE') ''
}
$relaunchFn = Import-PSFunction -Path $relaunch -Name 'Get-MiniMaxExecutable'
if ($relaunchFn) {
  . $relaunchFn
  $relaunchExe = Get-MiniMaxExecutable
  Check 'E4b 解析出真实路径' ([bool]$relaunchExe -and (Test-Path -LiteralPath $relaunchExe -PathType Leaf)) ('exe=' + $relaunchExe)
  Check 'E4c 就是环境变量里那个' ($relaunchExe -eq $env:MINIMAX_CODE_EXECUTABLE) ''
} else {
  Check 'E4b 解析出真实路径' $false '函数搬不过来'
}

Write-Host ''
Write-Host ('=== RESULT: ' + $script:pass + ' passed, ' + $script:fail + ' failed, ' + $script:skip + ' skipped ===')
if ($script:fail -eq 0) { exit 0 } else { exit 1 }
