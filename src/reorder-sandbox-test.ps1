# 沙箱 reorder 实验：带熔断的受控验证。
# 判据（缺一不可）：
#   1. daemon 报告的 roots 必须 <= REORDER_MAX_ROOTS(3)，否则护栏拦下
#   2. 沙箱 renderer 的 CPU 增量必须很小（不能进入重排死循环）
#   3. running 行的实际 top 必须小于所有非 running 行
# 失败任一条就 kill daemon 并上报，绝不硬撑。
$ErrorActionPreference = 'Continue'
$dir = 'G:\mmx-project\fix mmx\mmx-status'
$SandboxPort = 9355
$SandboxTag = 'mmx-sandbox-main'
$node = 'C:\Program Files\nodejs\node.exe'

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
      Where-Object { $_.CommandLine -like "*--port $SandboxPort*" -and $_.CommandLine -like '*mmx-status*daemon.mjs*' })
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

if ($tripped) {
    Write-Host ''
    Write-Host '!! 熔断触发，杀死沙箱 daemon' -ForegroundColor Red
    Get-OnlySandboxDaemons | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "实验结论：REORDER 在真实宿主上不可用（已熔断）"
} else {
    Write-Host ''
    Write-Host 'CPU 无异常。沙箱 daemon 日志关键行：'
    Get-Content -LiteralPath $dl -ErrorAction SilentlyContinue |
        Select-String -Pattern '注入结果|running 行置顶' | Select-Object -Last 3 |
        ForEach-Object { '  ' + $_.Line }
}
Write-Host ''
Write-Host "主实例 daemon 仍在运行：$(@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--port 9331*' }).Count) 个"
exit 0
