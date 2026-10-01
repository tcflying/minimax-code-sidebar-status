# 共享：陈旧 daemon 清理 + 端口参数形态判定。供 launch-mmx-status.ps1 /
# start-mmx-status.ps1 / stop-mmx-status.ps1 dot-source。
#
# 为什么抽出来：2026-10-02 之前这套清理只写在 launch-mmx-status.ps1 里，
# start-mmx-status.ps1 完全没做。daemon 是独立的 node 进程，不在 Electron
# 进程树里，「把应用全部关掉再重开」根本杀不掉它；而它在启动时只读一次
# lib/page-script.mjs 就常驻内存：现场 PID 44328 起于 1:31:43、应用起于 2:32:47，
# 那个 daemon 比应用早 61 分钟，一直忠实地跑着 1:31 的旧代码 —— 现象就是
# 「改了代码没反应」。同一端口跑两个 daemon 还会同时连同一个 CDP 互相打架。
#
# 端口形态判定也在这里：--port 的「空格写法」和「等号写法」两种都必须认。
# 旧写法 `--port\s+` 只认空格，等号写法会被静默漏杀，而 stop 脚本还会照常
# 打印「没有端口 X 的守护进程。」—— 最坏情况是 stop 声称成功、实际没停。
# 三个脚本共用同一个判定，避免再出现第四份正则。
#
#   . (Join-Path $PSScriptRoot 'lib-stale-daemon.ps1') -Root $Root
#
# 安全边界（不可放宽）：
#   只认「node.exe + 命令行含 daemon.mjs + --port 就是本次端口」这一种进程。
#   绝不能用 Get-Process -Name node（全局同名，会误伤别的 node），更不能碰任何
#   MiniMax Code / Electron 进程 —— 用户的主实例正在用。
<#
.SYNOPSIS
  陈旧 daemon 检测与清理，以及 --port 参数形态判定（共享实现）。
.PARAMETER Root
  仓库 src 目录，用于拼 cleanup.mjs 路径。
.PARAMETER Log
  日志回调，签名 ($Message, $Level)，Level 取 INFO/WARN/ERROR。不传则 Write-Host。
.PARAMETER DisposeTimeoutSec
  cleanup.mjs 等待封顶秒数，默认 8。
#>
[CmdletBinding()]
param(
  [string]$Root,
  [scriptblock]$Log,
  [int]$DisposeTimeoutSec = 8
)

$ErrorActionPreference = 'Continue'

if (-not $Log) { $Log = { param($m, $l) Write-Host $m } }

function Write-DaemonLog {
  param([string]$Message, [string]$Level = 'INFO')
  try { & $Log $Message $Level } catch { Write-Host $Message }
}

# --port 9331 / --port=9331 两种写法都算命中；--port 93310 之类的不算。
function Test-DaemonPortArg {
  param([string]$CommandLine, [int]$Port)
  $cmd = [string]$CommandLine
  if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
  if ($Port -le 0) { return $false }
  return [bool]($cmd -match ('--port[=\s]' + $Port + '(\s|$|")'))
}

function Test-IsStaleDaemonProcess {
  param($Proc, [int]$Port)
  # 第一道：进程名必须是 node。Electron 的可执行名是 'MiniMax Code.exe'。
  $name = [string]$Proc.Name
  if ($name -and $name -notmatch '^node(\.exe)?$') { return $false }
  # 第二道：命令行必须点名 daemon.mjs。这一道不能省：同端口跑着的 e2e.mjs、
  # 测试脚本、watchdog.mjs 全是 node.exe，只靠「进程名 + 端口」会把它们一起杀掉。
  $cmd = [string]$Proc.CommandLine
  if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
  if ($cmd -notmatch 'daemon\.mjs') { return $false }
  # 第三道：端口必须就是本次这个（空格/等号两种写法都认）。
  # 注意 --port 前面是两个连字符，应用的 --remote-debugging-port=9331 里
  # 不存在 "--port" 这个子串，所以这条不会误伤 Electron。
  if (-not (Test-DaemonPortArg -CommandLine $cmd -Port $Port)) { return $false }
  return $true
}

function Get-StaleDaemonProcess {
  param([int]$Port)
  if ($Port -le 0) { return @() }
  # 用 CIM 过滤出 node.exe 之后自己看 CommandLine —— 不用 Get-Process -Name node。
  $all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
  return @($all | Where-Object { Test-IsStaleDaemonProcess -Proc $_ -Port $Port })
}

function Stop-StaleDaemon {
  param([int]$Port)
  $stale = @(Get-StaleDaemonProcess -Port $Port)
  if ($stale.Count -eq 0) { return }
  Write-DaemonLog "发现 $($stale.Count) 个占用端口 $Port 的旧 daemon，先结束它，免得它继续用旧代码快照服务。" 'WARN'
  foreach ($p in $stale) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Write-DaemonLog "已结束旧 daemon pid=$($p.ProcessId)"
    } catch {
      Write-DaemonLog "结束旧 daemon pid=$($p.ProcessId) 失败：$($_.Exception.Message)" 'WARN'
    }
  }
  # 等它真的消失，最多 5s。
  for ($i = 0; $i -lt 50; $i++) {
    if (@(Get-StaleDaemonProcess -Port $Port).Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  }
  Write-DaemonLog "旧 daemon 5s 内没完全退出，仍继续启动新 daemon（端口 $Port 可能冲突）。" 'WARN'
}

function Invoke-LegacyDispose {
  param([string]$NodeExe, [int]$Port)
  # 旧 daemon 是被 Stop-Process -Force 干掉的（Windows 上等于 TerminateProcess，
  # 走不到它自己的 SIGTERM 还原分支），所以它注入的节点还留在页面上。这里用
  # 现成的 cleanup.mjs 还原一次 —— 它只删本工具自己注入的节点，不碰应用。
  # 等 DisposeTimeoutSec 封顶：cleanup.mjs 内部 CDP 超时最长 30s，不能让启动器被它拖住。
  # 失败也不致命：新 daemon 的 bootstrap 会再调一次上一个实例的 dispose
  # （lib/page-script.mjs 顶部 previous.dispose()），双保险。
  try {
    $cp = Start-Process -FilePath $NodeExe -ArgumentList "`"$Root\cleanup.mjs`" --port $Port" `
      -WindowStyle Hidden -PassThru
    Wait-Process -Id $cp.Id -Timeout $DisposeTimeoutSec -ErrorAction SilentlyContinue
    if (-not $cp.HasExited) {
      try { Stop-Process -Id $cp.Id -Force -ErrorAction SilentlyContinue } catch { }
      Write-DaemonLog "cleanup.mjs $DisposeTimeoutSec s 没返回，已放弃并杀掉它（新 daemon 会重新注入）。" 'WARN'
    } else {
      # exit != 0 表示 cleanup.mjs 自己失败了。绝不能打「已还原」这种误导性成功
      # 日志 —— 旧代码只看 $cp.HasExited，失败和成功都会打成功（2026-10-02 实测）。
      if ($cp.ExitCode -eq 0) {
        Write-DaemonLog "已用 cleanup.mjs 还原旧 daemon 留下的注入（exit=0）。"
      } else {
        Write-DaemonLog "cleanup.mjs 返回 exit=$($cp.ExitCode)，旧注入可能没还原干净（不影响启动，新 daemon 会重新注入）。" 'WARN'
      }
    }
  } catch {
    Write-DaemonLog "调用 cleanup.mjs 失败（不影响启动，新 daemon 会重新注入）：$($_.Exception.Message)" 'WARN'
  }
}
