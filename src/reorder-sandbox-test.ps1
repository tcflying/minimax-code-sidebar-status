# 沙箱 reorder 实验：带熔断的受控验证。
# 判据（缺一不可）：
#   1. daemon 报告的 roots 必须 <= REORDER_MAX_ROOTS(128)，超过说明容器识别又错了。
#      （旧注释写的是 3，与 lib/page-script.mjs:263 的 128 直接矛盾，已按真实值更正。）
#   2. 沙箱 renderer 的 CPU 增量必须很小（不能进入重排死循环）
#   3. 上一条熔断一旦触发就杀沙箱 daemon，绝不硬撑
# 失败任一条就 kill daemon 并上报，绝不硬撑。
[CmdletBinding()]
param(
    # 从脚本自身位置派生；旧默认值写死的 'G:\mmx-project\fix mmx\mmx-status'
    # 是已废弃裸副本，跑它等于验收错代码。参数覆盖保留。
    [string]$Dir = $PSScriptRoot,
    [int]$SandboxPort = 9355,
    # 判据 1 的上限。与 src/lib/page-script.mjs:263 的 REORDER_MAX_ROOTS 保持一致；
    # 那边改了这里要跟着改，所以下面有断言提示。
    [int]$MaxRoots = 128
)

$ErrorActionPreference = 'Continue'
$dir = $Dir
$SandboxTag = 'mmx-sandbox-main'
$node = 'C:\Program Files\nodejs\node.exe'

# 判据 1 的上限必须与真源一致，不一致就是判据本身失效（跑出来的 PASS 毫无意义）。
$pageScript = Join-Path $dir 'lib\page-script.mjs'
if (Test-Path -LiteralPath $pageScript) {
    $src = [System.IO.File]::ReadAllText($pageScript, [System.Text.UTF8Encoding]::new($false))
    $m = [regex]::Match($src, 'REORDER_MAX_ROOTS\s*=\s*(\d+)')
    if ($m.Success) {
        $real = [int]$m.Groups[1].Value
        if ($real -ne $MaxRoots) {
            Write-Host "!! 判据失效：本脚本 -MaxRoots=$MaxRoots，但 lib/page-script.mjs 里是 $real" -ForegroundColor Red
            Write-Host "   两者必须一致，否则 roots 判据形同虚设。已按真源值 $real 继续。" -ForegroundColor Yellow
            $MaxRoots = $real
        } else {
            Write-Host "roots 上限与真源一致 = $MaxRoots"
        }
    } else {
        Write-Host '!! 在 page-script.mjs 里找不到 REORDER_MAX_ROOTS，判据 1 无法执行。' -ForegroundColor Red
        exit 2
    }
} else {
    Write-Host "!! 找不到 $pageScript，判据 1 无法执行。" -ForegroundColor Red
    exit 2
}

function Get-SandboxRenderers {
    @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
      Where-Object { $_.CommandLine -like "*$SandboxTag*" -and $_.CommandLine -like '*--type=renderer*' } |
      ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
}
function Get-CpuTotal {
    $t = 0; Get-SandboxRenderers | ForEach-Object { $t += $_.CPU }; return $t
}
function Get-OnlySandboxDaemons {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like "*--port $SandboxPort*" -and $_.CommandLine -like '*daemon.mjs*' })
}
# 从 daemon 日志里解析「注入结果:」那一行的 JSON，取出 reorder.roots。
# 旧版脚本声称判据 1 是 roots 上限，却从头到尾只采 CPU，从没读过 roots 值 ——
# 三条判据里有一条根本没实现。这里补上真的读取。
function Get-ReorderRoots {
    $maxSeen = -1
    $aborted = @()
    $p = $LogPath
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { return @{ ok = $false; max = -1; aborted = @('NO_LOG') } }
    $lines = @(Get-Content -LiteralPath $p -ErrorAction SilentlyContinue |
               Select-String -Pattern '注入结果:' | Select-Object -Last 20)
    foreach ($l in $lines) {
        $idx = $l.Line.IndexOf('注入结果:')
        if ($idx -lt 0) { continue }
        $json = $l.Line.Substring($idx + '注入结果:'.Length).Trim()
        if (-not $json) { continue }
        try {
            $o = $json | ConvertFrom-Json -ErrorAction Stop
        } catch { continue }
        if ($null -eq $o) { continue }
        $r = $o.reorder
        if ($null -eq $r) { continue }
        if ($null -ne $r.roots) {
            $v = [int]$r.roots
            if ($v -gt $maxSeen) { $maxSeen = $v }
        }
        if ($r.aborted) { $aborted += [string]$r.aborted }
    }
    return @{ ok = ($maxSeen -ge 0); max = $maxSeen; aborted = $aborted }
}

Write-Host "=== 沙箱 reorder 受控实验 ==="
$cpu0 = Get-CpuTotal
$cpuBase = if($cpu0 -gt 0){ $cpu0 } else { 0 }
Write-Host "沙箱 renderer CPU 基线 = $([math]::Round($cpuBase,1))s"
Write-Host "主实例 daemon（9331）不受本次实验影响：$(@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--port 9331*' }).Count) 个"

# 只杀连沙箱端口的 daemon，绝不碰主实例的
Get-OnlySandboxDaemons | ForEach-Object { Write-Host "  清理旧沙箱 daemon PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Host ''
Write-Host "启动沙箱专用 daemon（--port $SandboxPort --reorder）..."
$dl = Join-Path $dir 'logs\sandbox-daemon.log'
$de = Join-Path $dir 'logs\sandbox-daemon.err.log'
$LogPath = $dl
$proc = Start-Process -FilePath $node -ArgumentList @(
    "`"$dir\daemon.mjs`"", '--port', "$SandboxPort", '--interval', '2500', '--reorder'
) -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $dl -RedirectStandardError $de -PassThru
Write-Host "  沙箱 daemon PID = $($proc.Id)"

# 观察 40 秒，每 8 秒采一次 CPU
Write-Host ''
Write-Host '时间   沙箱renderer CPU增量   判定'
$tripped = $false
for ($i = 1; $i -le 5; $i++) {
    Start-Sleep -Seconds 8
    $now = Get-CpuTotal
    $delta = [math]::Round($now - $cpuBase, 1)
    $verdict = if ($delta -gt 40) { '!! 超阈值，判定为重排死循环' } else { 'ok' }
    Write-Host ("  {0,2}s   {1,6}s                {2}" -f ($i*8), $delta, $verdict)
    if ($delta -gt 40) { $tripped = $true; break }
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $p) { Write-Host '  沙箱 daemon 已退出'; break }
}

$fail = $false

# ---- 判据 1：roots 上限（真的读，判超就失败）----
Write-Host ''
$rootsInfo = Get-ReorderRoots
if (-not $rootsInfo.ok) {
    Write-Host "!! 判据 1 无法判定：日志里没解析到 reorder.roots" -ForegroundColor Red
    $fail = $true
} else {
    Write-Host "判据 1：观测到最大 roots = $($rootsInfo.max)，上限 = $MaxRoots"
    if ($rootsInfo.max -gt $MaxRoots) {
        Write-Host "!! roots 超上限，容器识别可能又错了（护栏本该拦下）" -ForegroundColor Red
        $fail = $true
    } else {
        Write-Host "  ok：未超上限"
    }
    if ($rootsInfo.aborted.Count -gt 0) {
        Write-Host "  注意：reorder.aborted = $($rootsInfo.aborted -join ',')（护栏曾触发）" -ForegroundColor Yellow
    }
}

if ($tripped) {
    $fail = $true
    Write-Host ''
    Write-Host '!! 熔断触发，杀死沙箱 daemon' -ForegroundColor Red
    Get-OnlySandboxDaemons | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "实验结论：REORDER 在真实宿主上不可用（已熔断）" -ForegroundColor Red
} else {
    Write-Host ''
    Write-Host 'CPU 无异常。沙箱 daemon 日志关键行：'
    Get-Content -LiteralPath $dl -ErrorAction SilentlyContinue |
        Select-String -Pattern '注入结果|running 行置顶' | Select-Object -Last 3 |
        ForEach-Object { '  ' + $_.Line }
}
Write-Host ''
Write-Host "主实例 daemon 仍在运行：$(@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--port 9331*' }).Count) 个"
if ($fail) { Write-Host '=== 实验判定：FAIL ===' -ForegroundColor Red; exit 1 }
Write-Host '=== 实验判定：PASS ===' -ForegroundColor Green
exit 0
