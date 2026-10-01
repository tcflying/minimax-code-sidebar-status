# 真正的冷启动验收：先杀应用（模拟主上关机/官方更新后重开），再用 mmx-fix 拉起。
#
# v2 修正了 v1 的判据 bug：v1 写死要求"新端口号 != 旧端口号"，
# 但 launch-mmx-status.ps1 在应用已带 CDP 运行时会正确地跳过重启，
# 端口号自然不变 —— 于是 v1 永远等不到，误报"重启可能没成功"。
# 正确判据是 DevToolsActivePort 文件的 mtime 变化（应用每次启动都重写它），
# 端口号本身可以是同一个。
#
#   pwsh -NoProfile -File .\restart-cold.ps1 -DelaySec 60
[CmdletBinding()]
param(
    [int]$DelaySec = 60,
    [int]$WaitAppSec = 240
)

$ErrorActionPreference = 'Continue'
$Root    = 'G:\mmx-project\fix mmx\mmx-status'
$Lnk     = Join-Path $env:USERPROFILE 'Desktop\mmx-fix.lnk'
$OutFile = Join-Path $Root 'logs\restart-cold-result.txt'
$ShotDir = Join-Path $Root 'shots'
$portFile = Join-Path $env:APPDATA 'MiniMax\DevToolsActivePort'

New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null

$script:log = New-Object System.Collections.Generic.List[string]
function L([string]$m) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m)
    $script:log.Add($line) | Out-Null
    Write-Host $line
}
function Flush() {
    [System.IO.File]::WriteAllLines($OutFile, $script:log, [System.Text.UTF8Encoding]::new($false))
}

L "=== 冷启动验收（真杀应用）==="
L "延迟 $DelaySec 秒后开始"
L "快捷方式存在 = $(Test-Path -LiteralPath $Lnk)"

$beforeRoot = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
    Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*--input-type=*' })
$beforePort = if (Test-Path -LiteralPath $portFile) { (Get-Content -LiteralPath $portFile -TotalCount 1).Trim() } else { '(无)' }
$beforeMtime = if (Test-Path -LiteralPath $portFile) { (Get-Item -LiteralPath $portFile).LastWriteTimeUtc } else { [datetime]::MinValue }
L "冷启动前：根进程 $($beforeRoot.ProcessId -join ',') ; 端口 $beforePort ; mtime $beforeMtime"
L "⚠ 本脚本会杀掉 MiniMax Code，启动它的会话将中断（数据在 SQLite，可从侧边栏点回）"
Flush

Start-Sleep -Seconds $DelaySec

# ---- 1. 杀掉整棵进程树 ----
L "taskkill /T /F 所有 MiniMax Code ..."
foreach ($p in $beforeRoot) {
    & taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null
    L "  taskkill PID $($p.ProcessId)"
}
Start-Sleep -Seconds 5
$still = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" | Measure-Object).Count
L "杀后剩余 MiniMax Code 进程 = $still"
if ($still -gt 0) {
    & taskkill.exe /T /F /IM 'MiniMax Code.exe' 2>&1 | Out-Null
    Start-Sleep -Seconds 4
    L "二次全杀后剩余 = $(@(Get-CimInstance Win32_Process -Filter \"Name='MiniMax Code.exe'\" | Measure-Object).Count)"
}
Flush

# ---- 2. 走 mmx-fix 快捷方式冷启动 ----
L "启动 mmx-fix.lnk（冷启动入口）..."
Start-Process -FilePath $Lnk
L "已触发"

# ---- 3. 轮询：判据 = 端口文件 mtime 变化 + HTTP 200（端口号允许相同）----
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
    L "!! 失败：$WaitAppSec 秒内端口文件 mtime 未更新且 /json/version 不通"
    L "   冷启动前 mtime = $beforeMtime ; 现在 = $((Get-Item -LiteralPath $portFile -ErrorAction SilentlyContinue).LastWriteTimeUtc)"
    Flush
    exit 1
}
L "✅ 冷启动 CDP 就绪：端口 $port（原 $beforePort，mtime 已更新）"
Flush

Start-Sleep -Seconds 15

# ---- 4. daemon 是否被自动拉起 ----
$daemons = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*mmx-status*daemon.mjs*' })
L "daemon 进程数 = $($daemons.Count)"
foreach ($d in $daemons) { L "  PID $($d.ProcessId) 起于 $((Get-Process -Id $d.ProcessId).StartTime)" }
Flush

# ---- 5. 验证（关键：改过的样式必须活过冷启动）----
$probe = 'G:\mmx-project\fix mmx\_probe4'
foreach ($s in @('verify-summary.mjs','verify-dot-sizes.mjs','verify-pip.mjs')) {
    $f = Join-Path $probe $s
    if (-not (Test-Path -LiteralPath $f)) { L "跳过 $s（不存在）"; continue }
    L "----- $s -----"
    Push-Location $probe
    $o = & node $f $port 2>&1 | Out-String
    Pop-Location
    foreach ($line in ($o -split "`r?`n")) {
        if ($line.Trim()) { L ("    " + $line.Trim()) }
    }
    Flush
}

L "----- 截图 -----"
$png = Join-Path $ShotDir 'restart-cold-summary.png'
if (Test-Path -LiteralPath $png) {
    L "截图: $png ($((Get-Item -LiteralPath $png).Length) 字节, $((Get-Item -LiteralPath $png).LastWriteTime))"
} else { L "截图缺失：$png" }
Flush

$after = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" | Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*--input-type=*' })
L "冷启动后：根进程 $($after.ProcessId -join ',')  起于 $((Get-Process -Id $after.ProcessId).StartTime)"
L "=== 验收脚本结束，结果见 $OutFile ==="
Flush
exit 0
