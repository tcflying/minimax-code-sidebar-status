# 关闭沙箱实例。只关它自己那棵进程树（靠独立 user-data-dir + 端口识别），
# 绝不碰主上正在使用的实例。
#
#   pwsh -NoProfile -File .\close-sandbox-instance.ps1 -Port 9355
[CmdletBinding()]
param(
    [int]$Port = 9355,
    [string]$Label = 'sandbox'
)

$ErrorActionPreference = 'Continue'
$sandboxRoot = Join-Path $env:TEMP "mmx-sandbox-$Label"
# Count ONLY the user's own instance: a process is "main" iff it does NOT carry
# the sandbox user-data-dir. Counting every MiniMax Code process would include
# the sandbox, so closing the sandbox would look like the main instance died.
# (Measured 2026-10-02: "before" read 16 because the 7 sandbox processes were
# counted too, then the healthy shutdown read 9 and the script cried wolf.)
function Get-MainCount {
    @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
      Where-Object { $_.CommandLine -notlike "*$sandboxRoot*" }).Count
}
$mainBefore = Get-MainCount
Write-Host "关闭前主实例进程数 = $mainBefore （已排除沙箱）"

# 只杀命令行里带沙箱 user-data-dir 的进程。
# 刻意【不】用端口作为判据：端口是可以被主实例复用的数字，哪天主实例也
# 起了 9355，这条规则就会误杀主上正在用的窗口。沙箱独有的是目录路径，
# 主实例的命令行里永远不会出现 $env:TEMP\mmx-sandbox-*。
$victims = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
  Where-Object { $_.CommandLine -like "*$sandboxRoot*" })

if ($victims.Count -eq 0) {
    Write-Host "没找到沙箱进程（可能已经退出）"
} else {
    $roots = $victims | Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*--input-type=*' }
    $targets = if ($roots.Count -gt 0) { $roots } else { $victims }
    foreach ($p in $targets) {
        Write-Host "  kill PID $($p.ProcessId)"
        & taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 3
}

$left = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
  Where-Object { $_.CommandLine -like "*$sandboxRoot*" })
Write-Host "沙箱残留 = $($left.Count)"

$mainAfter = Get-MainCount
Write-Host "关闭后主实例进程数 = $mainAfter"
if ($mainAfter -ge $mainBefore) {
    Write-Host "OK 主实例未被影响" -ForegroundColor Green
} else {
    Write-Host "!! 主实例进程数真的下降了（$mainBefore -> $mainAfter），需要检查" -ForegroundColor Red
}

Write-Host ""
Write-Host "沙箱目录仍保留在 $sandboxRoot（内含登录态，下次可复用；要彻底删请手动删除）"
exit 0
