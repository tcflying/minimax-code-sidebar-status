<#
.SYNOPSIS
  mmx-status 无窗口启动器（给快捷方式 / 开机自启用）。

.DESCRIPTION
  供 .lnk 或 wscript 静默调用，做三件事后立刻退出，不常驻：
    1. 找到 MiniMax Code.exe（真实安装路径优先：G:\MiniMax\MiniMax Code\）
    2. 自动发现 CDP 端口（DevToolsActivePort 文件 + 进程命令行双路）
    3. 若应用在跑但端口不通，则非交互地结束并带 CDP 参数重启

  与 start-mmx-status.ps1 的区别：本脚本没有 Read-Host，完全非交互，
  且自己拉起 daemon 后立即返回，控制台窗口不会留在桌面上。

.EXAMPLE
  powershell.exe -NoProfile -WindowStyle Hidden -File .\launch-mmx-status.ps1
#>
[CmdletBinding()]
param(
  # 省略则自动发现 CDP 端口。
  [int]$Port = 0,
  [int]$Interval = 2500,
  # 只探测不改动任何东西。
  [switch]$DryRun,
  # 检测到无 CDP 的实例时也不结束进程（只记录日志并直接返回）。
  [switch]$NoRestart,
  # 连 daemon 也不拉起。
  [switch]$NoDaemon,
  # 逃生舱：关掉「running 行自动置顶」。默认是开的，所以平时不需要传；
  # 只有置顶导致侧边栏重排异常时才用这个把它关掉。
  [switch]$NoReorder
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogPath = Join-Path $LogDir "launch-$Stamp.log"

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] [{1}] launch-mmx-status: {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  try {
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch { }
  Write-Host $line
}

function Get-MiniMaxExecutable {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:MINIMAX_CODE_EXECUTABLE) { $candidates.Add($env:MINIMAX_CODE_EXECUTABLE) }
  # 当前真实安装路径排第一。
  $candidates.Add('G:\MiniMax\MiniMax Code\MiniMax Code.exe')
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\MiniMax Code\MiniMax Code.exe'))
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\MiniMax Inside Code\MiniMax Inside Code.exe'))
  $candidates.Add('C:\Program Files\MiniMax Code\MiniMax Code.exe')
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c }
  }
  return $null
}

function Get-UserDataDirCandidates {
  $list = New-Object System.Collections.Generic.List[string]
  if ($env:APPDATA) {
    $list.Add((Join-Path $env:APPDATA 'MiniMax'))
    $list.Add((Join-Path $env:APPDATA 'MiniMax Code'))
  }
  if ($env:LOCALAPPDATA) {
    $list.Add((Join-Path $env:LOCALAPPDATA 'MiniMax'))
    $list.Add((Join-Path $env:LOCALAPPDATA 'Programs\MiniMax Code'))
  }
  $list.Add('G:\MiniMax\MiniMax Code')
  return $list
}

function Get-PortFromDevToolsFile {
  foreach ($dir in (Get-UserDataDirCandidates)) {
    $f = Join-Path $dir 'DevToolsActivePort'
    try {
      if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
      $raw = [System.IO.File]::ReadAllText($f)
      if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-Log "DevToolsActivePort 内容为空：$f" 'WARN'; continue
      }
      # 只取第一行并 Trim（Windows 上常见 \r\n）
      $first = ($raw -split "`n")[0].Trim()
      if ($first -notmatch '^[0-9]{1,5}$') {
        Write-Log "DevToolsActivePort 第一行不是端口：'$first'（$f）" 'WARN'; continue
      }
      $p = [int]$first
      if ($p -ge 1 -and $p -le 65535) {
        Write-Log "端口来源 A DevToolsActivePort：$p（$f）" 'INFO'
        return $p
      }
      Write-Log "DevToolsActivePort 端口越界：$p（$f）" 'WARN'
    } catch {
      Write-Log "读取 DevToolsActivePort 失败：$($_.Exception.Message)" 'WARN'
    }
  }
  return 0
}

function Get-PortFromProcessCommandLine {
  try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
      $cmd = [string]$p.CommandLine
      if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
      if ($cmd -match '--type=') { continue }   # 子进程（renderer/gpu/...）没有端口参数
      if ($cmd -match '--remote-debugging-port[= ](\d{1,5})') {
        $p2 = [int]$Matches[1]
        Write-Log "端口来源 B 进程命令行：$p2（pid=$($p.ProcessId)）" 'INFO'
        return $p2
      }
    }
  } catch {
    Write-Log "枚举进程失败：$($_.Exception.Message)" 'WARN'
  }
  return 0
}

function Test-CdpPort {
  param([int]$P)
  if ($P -le 0) { return $false }
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -ne 200) { return $false }
    return ($r.Content -match 'webSocketDebuggerUrl')
  } catch { return $false }
}

function Resolve-TargetPort {
  param([int]$Requested)
  if ($Requested -gt 0) {
    if (Test-CdpPort $Requested) {
      Write-Log "使用指定端口 $Requested（CDP 可用）" 'INFO'
      return $Requested
    }
    Write-Log "指定端口 $Requested 不可用，回落到自动发现" 'WARN'
  }
  $a = Get-PortFromDevToolsFile
  if ($a -gt 0 -and (Test-CdpPort $a)) { return $a }
  if ($a -gt 0) { Write-Log "文件发现的端口 $a 不响应，继续找进程命令行" 'WARN' }
  $b = Get-PortFromProcessCommandLine
  if ($b -gt 0 -and (Test-CdpPort $b)) { return $b }
  return 0
}

function Get-MiniMaxProcesses {
  param([string]$ExePath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
  # Get-Process, NOT Get-CimInstance -Filter "Name='...'".
  # Win32_Process.Name carries the extension ('MiniMax Code.exe'), so a
  # filter built from the extension-less name matches 0 rows and $runningCount
  # stays 0 forever -- the launcher then believes the app is closed, skips the
  # "kill the no-CDP instance" branch, and the second Electron instance is
  # swallowed by the single-instance lock. The CDP flag never takes effect.
  # Get-Process matches on the extension-less image name, which is what we
  # already have. Verified 2026-10-02: filter form -> 0 rows, Get-Process -> 9.
  return @(Get-Process -Name $name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# 陈旧 daemon 清理（2026-10-02 实测事故）
#
# 实现已抽到共享模块 src/lib-stale-daemon.ps1，由本脚本与 start-mmx-status.ps1
# 共用 —— 事故背景与安全边界全部写在那里，这里不重复一份，改一处即可生效。
#
# 这里同时注入 Write-Log，让共享模块的日志走本脚本的带时间戳日志文件。
# ---------------------------------------------------------------------------
. (Join-Path $Root 'lib-stale-daemon.ps1') -Root $Root -Log {
  param($Message, $Level)
  Write-Log $Message $Level
}

# --------------------------------------------------------------- main

Write-Log '启动。'

$exe = Get-MiniMaxExecutable
if (-not $exe) {
  Write-Log '未找到 MiniMax Code.exe。请设置 MINIMAX_CODE_EXECUTABLE。' 'ERROR'
  exit 1
}
Write-Log "MiniMax Code: $exe"

$port = Resolve-TargetPort -Requested $Port
$cdpUp = Test-CdpPort $port

$procs = Get-MiniMaxProcesses -ExePath $exe
$runningCount = $procs.Count

if ($runningCount -gt 0 -and -not $cdpUp) {
  if ($NoRestart) {
    Write-Log "检测到 $runningCount 个进程在跑但无 CDP，-NoRestart：只记录不处理。" 'WARN'
    exit 4
  }
  # 非交互：直接结束并重启，不做 Read-Host 确认。
  Write-Log "检测到 $runningCount 个进程在跑且无 CDP，结束它们并带 CDP 参数重启（当前会话会被中断）。" 'WARN'
  foreach ($p in $procs) {
    # 枚举到的进程可能在我们拿列表和动手之间恰好退出（Electron 父进程死后
    # 子进程还在陆续退出），$p.ProcessId 属性读取为 $null。Stop-Process -Id $null
    # 抛参数绑定错误（2026-10-02 冷启动实测：结束 pid= 失败：无法将参数绑定
    # 到参数"Id"）。跳过即可：它已经死了，无需我们动手。
    if (-not $p -or -not $p.ProcessId) {
      Write-Log "跳过一个枚举瞬间消失的进程（已自行退出，无需结束）。" 'WARN'
      continue
    }
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    catch { Write-Log "结束 pid=$($p.ProcessId) 失败：$($_.Exception.Message)" 'WARN' }
  }
  $name = [System.IO.Path]::GetFileNameWithoutExtension($exe)
  for ($i = 0; $i -lt 80; $i++) {
    if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  }
  $cdpUp = $false
}

if (-not $cdpUp) {
  if ($port -le 0) { $port = 9331 }
  Write-Log "以 --remote-debugging-port=$port 启动: $exe"
  $cdpArgs = @("--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1')
  if ($DryRun) {
    Write-Log "[dry-run] `"$exe`" $($cdpArgs -join ' ')"
  } else {
    Start-Process -FilePath $exe -ArgumentList $cdpArgs
    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-CdpPort $port) { $cdpUp = $true; break }
    }
  }
}

# daemon 启动参数。默认「不传」任何 reorder 开关，让 daemon 用它自己的默认值
# （running 行置顶 = 开）。只有显式 -NoReorder 才追加 --no-reorder。
# 顺序很重要：dry-run 分支要打印的就是这一行真实值，两处不能各写一份。
# 路径含空格（项目在 "G:\mmx-project\fix mmx\..."），必须手工套双引号，否则
# Start-Process 会把命令行从第一个空格处截断，node 静默起不来。
$daemonArgs = "`"$Root\daemon.mjs`" --port $port --interval $Interval"
if ($NoReorder) { $daemonArgs += ' --no-reorder' }

if ($DryRun) {
  Write-Log "[dry-run] node $daemonArgs"
  Write-Log "[dry-run] 结束。日志：$LogPath"
  exit 0
}

if (-not $cdpUp) {
  Write-Log "CDP 端口 $port 未就绪，启动 daemon 无意义，放弃。" 'ERROR'
  Write-Log '手工验证: curl.exe http://127.0.0.1:<port>/json/version'
  exit 3
}

if ($NoDaemon) {
  Write-Log "CDP 就绪（$port），-NoDaemon：不拉起 daemon。结束。"
  exit 0
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  Write-Log '找不到 node.exe，daemon 未启动。' 'ERROR'
  exit 5
}

# 拉新 daemon 之前先干掉占用同一端口的旧 daemon（见 Stop-StaleDaemon 注释）。
Stop-StaleDaemon -Port $port
Invoke-LegacyDispose -NodeExe $nodeExe -Port $port

# detached 启动 daemon，本脚本立即退出，不留控制台窗口。
$daemonLog = Join-Path $LogDir "daemon-$port-$Stamp.log"
$daemonErr = Join-Path $LogDir "daemon-$port-$Stamp.err"
Write-Log "拉起 daemon：node $daemonArgs（日志 $daemonLog）"
# Start-Process 使用 ShellExecute=false 时默认继承当前进程环境；
# 这里刻意不手工拼 Machine/User 环境变量（踩过 chcp 找不到的坑）。
$p = Start-Process -FilePath $nodeExe -ArgumentList $daemonArgs -WindowStyle Hidden `
  -RedirectStandardOutput $daemonLog -RedirectStandardError $daemonErr -PassThru
Write-Log "daemon pid=$($p.Id)，启动器退出。"
exit 0
