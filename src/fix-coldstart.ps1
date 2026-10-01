# 一键修复：杀掉所有没带 CDP 参数启动的 MiniMax Code，再用 mmx-fix 正确入口冷启动。
#
# 背景：主上用官方 MiniMax Code.lnk 启动（无 CDP 参数），daemon 接不上，
# 侧边栏完全没状态点。本脚本把进程树换成带 --remote-debugging-port 的实例。
#
#   pwsh -NoProfile -File .\fix-coldstart.ps1 -DelaySec 40
[CmdletBinding()]
param(
    [int]$DelaySec = 40,
    [int]$WaitAppSec = 180
)

$ErrorActionPreference = 'Continue'
$Root    = 'G:\mmx-project\fix mmx\mmx-status'
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

L "=== 一键修复：换成带 CDP 的启动 ==="
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

# ---- 1. 杀光，再按名字补刀 ----
L "taskkill 整棵树 ..."
& taskkill.exe /T /F /IM 'MiniMax Code.exe' 2>&1 | Out-Null
Start-Sleep -Seconds 4
& taskkill.exe /T /F /IM 'MiniMax Code.exe' 2>&1 | Out-Null
Start-Sleep -Seconds 3
$left = Get-AppProcs
L "杀后剩余 = $($left.Count) $(($left.ProcessId) -join ',')"
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
