# 回归测试：进程过滤器 API 陷阱。
#
# 背景（2026-10-02 实测）：launch-mmx-status.ps1 的 Get-MiniMaxProcesses
# 曾用 Get-CimInstance -Filter "Name='<去掉扩展名的名字>'" 来数应用进程。
# Win32_Process.Name 带扩展名，所以该过滤器恒返回 0 条 —— $runningCount
# 永远是 0，脚本永远认为"应用没在跑"，于是跳过"杀掉无 CDP 实例"这一步，
# 改去启动第二个实例；Electron 单实例锁把第二个实例秒退，旧的无参数实例
# 继续活着，CDP 参数从头到尾没生效。表现就是"双击快捷方式没反应"。
#
# 本测试锁死这个形态：坏写法必须恒为 0，好写法必须 > 0，且两者指向同一批进程。
#
#   pwsh -NoProfile -File .\test-process-filters.ps1
[CmdletBinding()]
param(
    [string]$Exe = 'G:\MiniMax\MiniMax Code\MiniMax Code.exe',
    [string]$LaunchScript = (Join-Path $PSScriptRoot 'launch-mmx-status.ps1')
)

$ErrorActionPreference = 'Continue'
$script:pass = 0
$script:fail = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { $script:pass++; Write-Host "  PASS  $name  $detail" }
    else { $script:fail++; Write-Host "  FAIL  $name  $detail" -ForegroundColor Red }
}

$name = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
Write-Host "目标进程名 = '$name'"
Write-Host ''

# --- 组 1：三种写法的实测对照 ---
Write-Host '组 1：过滤器 API 实测'

$badWmi = @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue).Count
$goodGet = @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count
$goodWmi = @(Get-CimInstance Win32_Process -Filter "Name='$name.exe'" -ErrorAction SilentlyContinue).Count

Write-Host "    Get-CimInstance -Filter \"Name='$name'\"       -> $badWmi  (坏写法)"
Write-Host "    Get-Process -Name '$name'                   -> $goodGet  (好写法)"
Write-Host "    Get-CimInstance -Filter \"Name='$name.exe'\"   -> $goodWmi  (好写法)"
Write-Host ''

Check 'A1 坏写法(WMI+无扩展名)恒为 0' ($badWmi -eq 0) "got=$badWmi"
Check 'A2 Get-Process 能数到进程' ($goodGet -gt 0) "got=$goodGet"
Check 'A3 WMI+带扩展名也能数到' ($goodWmi -gt 0) "got=$goodWmi"
Check 'A4 两种好写法数量一致' ($goodGet -eq $goodWmi) "get=$goodGet wmi=$goodWmi"

if ($goodGet -eq 0) {
    Write-Host ''
    Write-Host '  !! 应用当前没在运行：好写法返回 0 属正常，A2/A3/A4 无法判定。' -ForegroundColor Yellow
    Write-Host '     本组已通过的 A1 仍能锁死 bug 形态。' -ForegroundColor Yellow
}

# --- 组 2：Get-Process 拿到的进程确实就是那些应用进程 ---
Write-Host ''
Write-Host '组 2：两种好写法的进程集合是否同一批'
$setA = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
$setB = @(Get-CimInstance Win32_Process -Filter "Name='$name.exe'" -ErrorAction SilentlyContinue |
          Select-Object -ExpandProperty ProcessId | Sort-Object)
Check 'B1 PID 集合完全相同' (($setA -join ',') -eq ($setB -join ',')) `
    ("get=[$($setA -join ',')] wmi=[$($setB -join ',')]")

# --- 组 3：启动器源码里不能再有坏写法 ---
Write-Host ''
Write-Host '组 3：launcher 源码静态检查'
if (Test-Path -LiteralPath $LaunchScript) {
    $src = [System.IO.File]::ReadAllText($LaunchScript, [System.Text.UTF8Encoding]::new($false))
    $hasGetProc = $src -match 'Get-Process\s+-Name\s+\$name'
    $hasBadFilter = $src -match 'Get-CimInstance\s+Win32_Process\s+-Filter\s+"Name=''\$name''"'
    Check 'C1 Get-MiniMaxProcesses 用 Get-Process' $hasGetProc ''
    Check 'C2 源码里不再有 WMI+无扩展名 的坏过滤器' (-not $hasBadFilter) ''
} else {
    Check 'C0 找到 launcher 源码' $false $LaunchScript
}

# --- 组 4：Electron 单实例锁陷阱本身无法脚本化，这里只留结论备忘 ---
Write-Host ''
Write-Host '组 4：场景备忘（无法自动断言）'
Write-Host '    若上述过滤器失效，症状是：日志出现"以 --remote-debugging-port 启动"，'
Write-Host '    但 CDP 端口仍不响应，且旧进程仍在 —— 因为第二个实例被单实例锁吞掉。'
Write-Host '    判别式证据：日志里【缺少】"检测到 N 个进程在跑且无 CDP"那一行。'

Write-Host ''
Write-Host ("pass={0} fail={1}" -f $script:pass, $script:fail)
if ($script:fail -eq 0) { Write-Host 'test-process-filters: ALL GREEN' }
else { Write-Host 'test-process-filters: FAILED' -ForegroundColor Red; exit 1 }
exit 0
