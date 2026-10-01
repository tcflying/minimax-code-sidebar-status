# 端到端重启验收：启动 mmx-fix.lnk，等应用起来，自动跑验证并写结果。
#
# 本脚本刻意不依赖任何 agent 会话 —— 它由独立的 PowerShell 进程执行，
# 即使启动它的会话因应用重启而消失，它依然会跑完并落盘结果。
#
#   pwsh -NoProfile -File .\restart-e2e.ps1 -DelaySec 60
[CmdletBinding()]
param(
    [int]$DelaySec = 60,
    [int]$WaitAppSec = 180
)

$ErrorActionPreference = 'Continue'
# 从脚本自身位置派生，理由同 restart-cold.ps1：写死的旧目录仍在磁盘上，
# 写死会让结果文件落进已废弃的裸副本而不是 git 真源。
$Root    = $PSScriptRoot
$Lnk     = Join-Path $env:USERPROFILE 'Desktop\mmx-fix.lnk'
$OutFile = Join-Path $Root 'logs\restart-e2e-result.txt'
$ShotDir = Join-Path $Root 'shots'

New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null

$script:log = New-Object System.Collections.Generic.List[string]
function L([string]$m) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m)
    $script:log.Add($line) | Out-Null
    Write-Host $line
}
function Flush() {
    # UTF-8 无 BOM：结果文件要被后续工具读，避免中文乱码
    [System.IO.File]::WriteAllLines($OutFile, $script:log, [System.Text.UTF8Encoding]::new($false))
}

L "=== 端到端重启验收 ==="
L "延迟 $DelaySec 秒后启动 $Lnk"
L "快捷方式存在 = $(Test-Path -LiteralPath $Lnk)"
Flush

# ---- 重启前的对照快照 ----
$before = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" | Measure-Object).Count
$portFile = Join-Path $env:APPDATA 'MiniMax\DevToolsActivePort'
$beforePort = if (Test-Path -LiteralPath $portFile) { (Get-Content -LiteralPath $portFile -TotalCount 1).Trim() } else { '(无)' }
L "重启前：MiniMax Code 进程数 = $before ; DevToolsActivePort = $beforePort"
Flush

Start-Sleep -Seconds $DelaySec

# ---- 走 mmx-fix 快捷方式（真实入口，不绕过）----
L "启动 mmx-fix.lnk ..."
Start-Process -FilePath $Lnk
L "已触发，等待应用起来 ..."

# ---- 轮询等 CDP 端口就绪（端口绝不写死）----
$port = $null
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $WaitAppSec) {
    Start-Sleep -Seconds 3
    if (Test-Path -LiteralPath $portFile) {
        try {
            $p = (Get-Content -LiteralPath $portFile -TotalCount 1).Trim()
            if ($p -and $p -ne $beforePort) {
                $v = Invoke-RestMethod -Uri "http://127.0.0.1:$p/json/version" -TimeoutSec 3
                if ($v.webSocketDebuggerUrl) { $port = $p; break }
            }
        } catch { }
    }
}

if (-not $port) {
    L "!! 失败：$WaitAppSec 秒内没有等到新的 CDP 端口（重启可能没成功）"
    Flush
    exit 1
}
L "CDP 就绪：端口 $port（原 $beforePort）"
Flush

# 给 daemon 几轮 tick 的时间
Start-Sleep -Seconds 12

# ---- daemon 是否被快捷方式自动拉起 ----
$daemons = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*mmx-status*daemon.mjs*' })
L "daemon 进程数 = $($daemons.Count)"
foreach ($d in $daemons) { L "  PID $($d.ProcessId) 起于 $((Get-Process -Id $d.ProcessId).StartTime)" }
Flush

# ---- 跑验证 ----
$probe = Join-Path (Split-Path -Parent $Root) 'tests'   # 验收探针已随仓库进 tests/，不再依赖项目外目录
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
$png = Join-Path $ShotDir 'restart-e2e-summary.png'
if (Test-Path -LiteralPath $png) {
    L "截图: $png ($((Get-Item -LiteralPath $png).Length) 字节, $((Get-Item -LiteralPath $png).LastWriteTime))"
} else {
    L "截图缺失：$png"
}
Flush

$after = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" | Measure-Object).Count
L "重启后：MiniMax Code 进程数 = $after"
L "=== 验收脚本结束，结果见 $OutFile ==="
Flush
exit 0
