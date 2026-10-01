# 一键修复：杀掉所有没带 CDP 参数启动的 MiniMax Code，再用 mmx-fix 正确入口冷启动。
#
# 背景：主上用官方 MiniMax Code.lnk 启动（无 CDP 参数），daemon 接不上，
# 侧边栏完全没状态点。本脚本把进程树换成带 --remote-debugging-port 的实例。
#
# ===========================================================================
# ⚠️ 杀伤面警告：它会关闭**所有** MiniMax Code 实例
# ===========================================================================
# 本脚本的筛选判据是「**没有** --user-data-dir 的根进程」——它杀的是全部
# 无 CDP 实例，**包括你的沙箱实例**（沙箱是独立 user-data-dir 启动的，但它
# 同样不带 CDP 主实例那种命令行形态时就会被误判）。所有正在进行的会话都会
# 中断。数据存在 SQLite，重启后可从侧边栏点回，但那一轮正在跑的东西没了。
#
# 只想纠正主实例、不要碰沙箱：别用本脚本，用桌面红 M（mmx-fix.lnk）。
# ===========================================================================
#
#   pwsh -NoProfile -File .\fix-coldstart.ps1 -DelaySec 40
[CmdletBinding()]
param(
    [int]$DelaySec = 40,
    [int]$WaitAppSec = 180
)

$ErrorActionPreference = 'Continue'
# 路径从脚本自身位置派生，绝不写死绝对路径：写死的旧目录
# 'G:\mmx-project\fix mmx\mmx-status' 仍然存在于磁盘上，写死会让脚本
# 静默地往那份已废弃副本里写日志、跑验收，而不是真正的 git 真源。
$Root    = $PSScriptRoot
$Lnk     = Join-Path $env:USERPROFILE 'Desktop\mmx-fix.lnk'
$OutFile = Join-Path $Root 'logs\fix-coldstart-result.txt'
$portFile = Join-Path $env:APPDATA 'MiniMax\DevToolsActivePort'

New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null

$script:log = New-Object System.Collections.Generic.List[string]
function L([string]$m) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m)
    $script:log.Add($line) | Out-Null
    Write-Host $line
}
function Flush() {
    [System.IO.File]::WriteAllLines($OutFile, $script:log, [System.Text.UTF8Encoding]::new($false))
}
function Get-AppProcs {
    @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'")
}
function Get-Roots {
    @(Get-AppProcs | Where-Object {
        $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*--input-type=*'
    })
}
function HasCdp($p) { $p.CommandLine -match 'remote-debugging-port=\d+' }

# 沙箱判据**只看路径，不看端口**。这是 2026-10-02 踩过的坑：先按端口判沙箱，
# 结果沙箱换了个端口（9355 -> 别的）就漏判，又被当主实例杀掉了。
# 任何带独立 --user-data-dir 的实例都是沙箱或测试实例，一律不碰。
function Is-Sandbox($p) {
    if ($p.CommandLine -match '--user-data-dir') { return $true }
    # 本机沙箱目录标识（open-sandbox-instance.ps1 用的那个）
    if ($p.CommandLine -like '*mmx-sandbox*') { return $true }
    return $false
}
# 要杀的 = 根进程 且 非沙箱。沙箱原样放过。
function Get-KillTargets {
    @(Get-Roots | Where-Object { -not (Is-Sandbox $_) })
}

L "=== 一键修复：换成带 CDP 的启动 ==="
L "⚠ 警告：本次会关闭所有非沙箱的 MiniMax Code 实例，正在进行的会话会中断。"
L "延迟 $DelaySec 秒"
L "mmx-fix.lnk 存在 = $(Test-Path -LiteralPath $Lnk)"
$before = Get-Roots
L "修复前根进程："
foreach ($p in $before) { L "  PID $($p.ProcessId) 起于 $((Get-Process -Id $p.ProcessId).StartTime)  $(if (HasCdp $p) {'[带CDP]'} else {'[无CDP]'})" }
if (Test-Path -LiteralPath $portFile) {
    L "端口文件 mtime = $((Get-Item -LiteralPath $portFile).LastWriteTime)（陈旧残留，不代表端口在监听）"
}
$beforeMtime = if (Test-Path -LiteralPath $portFile) { (Get-Item -LiteralPath $portFile).LastWriteTimeUtc } else { [datetime]::MinValue }
Flush

Start-Sleep -Seconds $DelaySec

# ---- 1. 杀光非沙箱实例，再按名字补刀（补刀也排除沙箱）----
# 旧写法是两次无条件 `taskkill /T /F /IM 'MiniMax Code.exe'`，那会把
# 沙箱、主实例、测试实例一起杀光。现在逐个 PID 杀，沙箱跳过。
$targets = @(Get-KillTargets)
L "待结束的非沙箱根进程 = $($targets.Count) $(($targets.ProcessId) -join ',')"
$spared = @(Get-Roots | Where-Object { Is-Sandbox $_ })
if ($spared.Count -gt 0) {
    L "跳过（沙箱/独立 user-data-dir，不碰）= $($spared.Count) $(($spared.ProcessId) -join ',')"
}
foreach ($p in $targets) {
    & taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null
    L "  taskkill PID $($p.ProcessId)"
}
Start-Sleep -Seconds 4
# 补刀：仍存活且仍非沙箱的根进程，杀掉；沙箱绝不补刀。
foreach ($p in @(Get-KillTargets)) {
    & taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null
    L "  补刀 taskkill PID $($p.ProcessId)"
}
Start-Sleep -Seconds 3
$left = Get-AppProcs
L "杀后剩余 = $($left.Count) $(($left.ProcessId) -join ',')"
$leftSandbox = @(Get-Roots | Where-Object { Is-Sandbox $_ })
L "剩余沙箱实例 = $($leftSandbox.Count)（应当还在）"
Flush

# ---- 2. 正确入口冷启动 ----
L "启动 mmx-fix.lnk ..."
Start-Process -FilePath $Lnk

# ---- 3. 判据 = 端口文件 mtime 更新 + HTTP 200（端口号允许相同）----
$port = $null
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $WaitAppSec) {
    Start-Sleep -Seconds 3
    if (Test-Path -LiteralPath $portFile) {
        try {
            $m = (Get-Item -LiteralPath $portFile).LastWriteTimeUtc
            $p = (Get-Content -LiteralPath $portFile -TotalCount 1).Trim()
            if ($m -gt $beforeMtime) {
                $v = Invoke-RestMethod -Uri "http://127.0.0.1:$p/json/version" -TimeoutSec 3
                if ($v.webSocketDebuggerUrl) { $port = $p; break }
            }
        } catch { }
    }
}
if (-not $port) {
    L "!! 失败：$WaitAppSec 秒内没等到可用 CDP"
    Flush
    exit 1
}
L "CDP 就绪：端口 $port"
Start-Sleep -Seconds 15

# ---- 4. 确认这次真的带上了参数 ----
$after = Get-Roots
L "修复后根进程："
foreach ($p in $after) { L "  PID $($p.ProcessId) 起于 $((Get-Process -Id $p.ProcessId).StartTime)  $(if (HasCdp $p) {'[带CDP] OK'} else {'[无CDP] 仍失败'})" }
$d = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*mmx-status*daemon.mjs*' })
L "daemon 数 = $($d.Count)"
foreach ($x in $d) { L "  PID $($x.ProcessId) 起于 $((Get-Process -Id $x.ProcessId).StartTime)" }
Flush

# ---- 5. 注入验证 ----
$probe = 'G:\mmx-project\fix mmx\_probe4'
foreach ($s in @('verify-summary.mjs','verify-pip.mjs')) {
    $f = Join-Path $probe $s
    if (-not (Test-Path -LiteralPath $f)) { continue }
    L "----- $s -----"
    Push-Location $probe
    $o = & node $f $port 2>&1 | Out-String
    Pop-Location
    foreach ($line in ($o -split "`r?`n")) { if ($line.Trim()) { L ("    " + $line.Trim()) } }
    Flush
}
L "=== 结束，结果见 $OutFile ==="
Flush
exit 0
