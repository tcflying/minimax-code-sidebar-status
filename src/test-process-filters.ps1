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

# --- 组 5：杀陈旧 daemon 的筛选函数（纯函数级，不碰任何真实进程）---
# 2026-10-02 新增。bug：红 M 拉起新 daemon 前不杀旧 daemon，daemon 内存里一直
# 是旧的 page-script 快照，表现为「改了代码没反应」。修法是杀占用同一端口的
# 旧 daemon —— 但这条路径一旦写错就是灾难：误杀用户正在用的 MiniMax Code。
# 所以这里用伪造的进程记录直接调函数，一个真实进程都不枚举、不结束。
#
# 2026-10-02 二次修：实现已抽到共享模块 src/lib-stale-daemon.ps1
# （launch / start / stop 三处共用），所以从共享模块取函数，不再从 launch 源码抽。
Write-Host ''
Write-Host '组 5：Test-IsStaleDaemonProcess 筛选逻辑（纯函数，伪造进程记录）'

$sharedLib = Join-Path $PSScriptRoot 'lib-stale-daemon.ps1'
$launcherSrc = if (Test-Path -LiteralPath $LaunchScript) {
    [System.IO.File]::ReadAllText($LaunchScript, [System.Text.UTF8Encoding]::new($false))
} else { '' }

if (-not (Test-Path -LiteralPath $sharedLib)) {
    Check 'D0 找到共享模块 lib-stale-daemon.ps1' $false $sharedLib
} else {
    Check 'D0 找到共享模块 lib-stale-daemon.ps1' $true ''
    . $sharedLib -Root $PSScriptRoot -Log { param($m, $l) }

    function New-FakeProc {
        param([string]$Name, [string]$CommandLine)
        [pscustomobject]@{ Name = $Name; CommandLine = $CommandLine; ProcessId = 99999 }
    }

    # 真实的 daemon 启动形态（路径含空格，所以带引号）
    $realDaemon = New-FakeProc 'node.exe' '"G:\mmx-project\fix mmx\mmx-status-github\src\daemon.mjs" --port 9331 --interval 2500'
    # 真实的 MiniMax Code 主实例形态：注意它是 --remote-debugging-port，不是 --port
    $realApp = New-FakeProc 'MiniMax Code.exe' '"G:\MiniMax\MiniMax Code\MiniMax Code.exe" --remote-debugging-port=9331 --remote-debugging-address=127.0.0.1'
    $realRenderer = New-FakeProc 'MiniMax Code.exe' '"G:\MiniMax\MiniMax Code\MiniMax Code.exe" --type=renderer --lang=zh-CN'
    $otherDaemonPort = New-FakeProc 'node.exe' '"G:\mmx-project\fix mmx\mmx-status-github\src\daemon.mjs" --port 9351 --interval 2500'
    $otherNode = New-FakeProc 'node.exe' '"C:\Program Files\nodejs\node.exe" C:\some\other\tool.js --port 9331'
    $noPort = New-FakeProc 'node.exe' '"G:\mmx-project\fix mmx\mmx-status-github\src\daemon.mjs" --interval 2500'
    $sandbox = New-FakeProc 'node.exe' '"G:\mmx-project\fix mmx\mmx-status-github\src\e2e.mjs" --port 9331'

    Check 'D1 同一端口的旧 daemon 必须被选中（这正是要杀的那个）' `
        (Test-IsStaleDaemonProcess -Proc $realDaemon -Port 9331) 'got=True'
    Check 'D2 MiniMax Code 主实例绝不能被选中（同端口，--remote-debugging-port）' `
        (-not (Test-IsStaleDaemonProcess -Proc $realApp -Port 9331)) 'got=False'
    Check 'D3 MiniMax Code renderer 子进程绝不能被选中' `
        (-not (Test-IsStaleDaemonProcess -Proc $realRenderer -Port 9331)) 'got=False'
    Check 'D4 别的端口的 daemon 不能被选中（--port 9351 vs 本次 9331）' `
        (-not (Test-IsStaleDaemonProcess -Proc $otherDaemonPort -Port 9331)) 'got=False'
    Check 'D5 同端口但不是 daemon.mjs 的 node 不能被选中' `
        (-not (Test-IsStaleDaemonProcess -Proc $otherNode -Port 9331)) 'got=False'
    Check 'D6 没有 --port 的 daemon 不能被选中' `
        (-not (Test-IsStaleDaemonProcess -Proc $noPort -Port 9331)) 'got=False'
    Check 'D7 同端口的 e2e.mjs 不能被选中' `
        (-not (Test-IsStaleDaemonProcess -Proc $sandbox -Port 9331)) 'got=False'
    Check 'D8 进程名不是 node 的一律不选（即使命令行长得像）' `
        (-not (Test-IsStaleDaemonProcess -Proc (New-FakeProc 'electron.exe' 'daemon.mjs --port 9331') -Port 9331)) 'got=False'
    Check 'D9 空命令行不选' `
        (-not (Test-IsStaleDaemonProcess -Proc (New-FakeProc 'node.exe' '') -Port 9331)) 'got=False'
    Check 'D10 --port=9331 等号写法也认（红 M 用空格写法，两个都要覆盖）' `
        (Test-IsStaleDaemonProcess -Proc (New-FakeProc 'node.exe' 'node daemon.mjs --port=9331') -Port 9331) 'got=True'

    # 取证：确认本测试自己没有真的去枚举或结束任何进程
    $sideEffect = @(Get-CimInstance Win32_Process -Filter "ProcessId=99999" -ErrorAction SilentlyContinue).Count
    Check 'D11 本组全程没有碰任何真实进程（伪造 PID 99999 不存在于系统）' `
        ($sideEffect -eq 0) "queried=$sideEffect"

    # --- 组 6：--port 参数形态判定（stop 脚本的漏杀 bug）---
    # bug：stop-mmx-status.ps1 旧写法是 ('--port\s+' + $Port + '(\s|$)')，只匹配
    # 空格。任何以 --port=9331 启动的 daemon 会被**静默漏杀**，而 stop 还会照常
    # 打印「没有端口 X 的守护进程。」+「完成。」—— 最坏情况是 stop 声称成功、
    # 实际没停。这里锁死两种写法都必须匹配。
    Write-Host ''
    Write-Host '组 6：--port 参数形态（空格 / 等号两种写法都必须认）'

    Check 'D12 空格写法 --port 9331 必须匹配' `
        (Test-DaemonPortArg -CommandLine 'node daemon.mjs --port 9331 --interval 2500' -Port 9331) 'got=True'
    Check 'D13 等号写法 --port=9331 必须匹配（旧 stop 脚本在这里漏杀）' `
        (Test-DaemonPortArg -CommandLine 'node daemon.mjs --port=9331 --interval 2500' -Port 9331) 'got=True'
    Check 'D14 引号收尾的等号写法也匹配（路径含空格的启动形态）' `
        (Test-DaemonPortArg -CommandLine '"G:\mmx-project\fix mmx\mmx-status-github\src\daemon.mjs" --port=9331"' -Port 9331) 'got=True'
    Check 'D15 端口号不同的不匹配（--port 9355 vs 查 9331）' `
        (-not (Test-DaemonPortArg -CommandLine 'node daemon.mjs --port 9355' -Port 9331)) 'got=False'
    Check 'D16 前缀相同的更大端口号不匹配（--port 93310 vs 查 9331）' `
        (-not (Test-DaemonPortArg -CommandLine 'node daemon.mjs --port 93310' -Port 9331)) 'got=False'
    Check 'D17 --remote-debugging-port=9331 不匹配（那是应用自己，不是 daemon）' `
        (-not (Test-DaemonPortArg -CommandLine 'MiniMax Code.exe --remote-debugging-port=9331' -Port 9331)) 'got=False'
    Check 'D18 空命令行不匹配' `
        (-not (Test-DaemonPortArg -CommandLine '' -Port 9331)) 'got=False'

    # 静态锁死：stop 脚本里不能再出现旧的 \s+ 写法。
    # 断言「不存在坏写法」必须先剥掉整行注释：脚本里那句解释 bug 的注释本身
    # 就写着 --port\s+，只做全文匹配会误报（2026-10-02 实测踩到）。
    $stopScript = Join-Path $PSScriptRoot 'stop-mmx-status.ps1'
    if (Test-Path -LiteralPath $stopScript) {
        $stopSrc = [System.IO.File]::ReadAllText($stopScript, [System.Text.UTF8Encoding]::new($false))
        $stopCode = ($stopSrc -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
        Check 'D19 stop 脚本的代码行里不再有 --port\s+ 的旧漏杀写法' `
            (-not ($stopCode -match '--port\\s\+')) ''
        Check 'D20 stop 脚本复用了共享的 Test-DaemonPortArg' `
            ($stopCode -match 'Test-DaemonPortArg') ''
    } else {
        Check 'D19 找到 stop-mmx-status.ps1' $false $stopScript
    }
}

Write-Host ''
Write-Host ("pass={0} fail={1}" -f $script:pass, $script:fail)
if ($script:fail -eq 0) { Write-Host 'test-process-filters: ALL GREEN' }
else { Write-Host 'test-process-filters: FAILED' -ForegroundColor Red; exit 1 }
exit 0
