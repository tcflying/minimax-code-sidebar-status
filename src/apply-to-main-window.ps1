[CmdletBinding()]
param(
  [int]$DelaySeconds = 25,
  # 默认端口与生产端口一致（9331）。旧默认 9351 会连错实例。
  [int]$Port = 9331,
  [int]$Interval = 2500,
  [switch]$NoDaemon
)

# 把状态点挂到主上"当前正在用的"MiniMax Code 窗口。
#
# 这会结束当前 MiniMax Code 进程树（含本会话所在的 agent host），所以本脚本
# 必须以**独立后台进程**运行，且先睡一会儿，让发起它的那一轮对话能正常收尾。
# 会话本身存在 SQLite 里，重启后从侧边栏点回去即可恢复。

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('apply-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

function Say([string]$m) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m)
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

Say "延迟 $DelaySeconds 秒后开始（留给当前对话收尾）..."
Start-Sleep -Seconds $DelaySeconds

$exe = 'G:\MiniMax\MiniMax Code\MiniMax Code.exe'
if (-not (Test-Path -LiteralPath $exe)) { $exe = (Join-Path $env:LOCALAPPDATA 'Programs\MiniMax Code\MiniMax Code.exe') }
if (-not (Test-Path -LiteralPath $exe)) { Say 'FATAL: 找不到 MiniMax Code.exe'; exit 1 }
Say "exe = $exe"

# 1) 结束所有 MiniMax Code 进程（主进程 + 渲染/GPU/工具子进程）
$procs = @(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue)
Say "结束 $($procs.Count) 个 MiniMax Code 进程"
$procs | Stop-Process -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 100; $i++) {
  if (@(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue).Count -eq 0) { break }
  Start-Sleep -Milliseconds 100
}
$left = @(Get-Process -Name 'MiniMax Code' -ErrorAction SilentlyContinue).Count
Say "剩余进程: $left"
if ($left -gt 0) { Say 'FATAL: 未能完全退出，放弃（不半途重启）'; exit 2 }

# 2) 带 CDP 参数重新启动
$cdpArgs = @("--remote-debugging-port=$Port", '--remote-debugging-address=127.0.0.1')
Say "启动: --remote-debugging-port=$Port"
Start-Process -FilePath $exe -ArgumentList $cdpArgs | Out-Null

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ready = $true; break } } catch {}
}
if (-not $ready) { Say "FATAL: CDP 端口 $Port 120 秒内未就绪"; exit 3 }
Say 'CDP 已就绪'

# 3) 等待渲染进程真正就绪（/json/version 200 不等于页面加载完）
$rendererReady = $false
for ($i = 0; $i -lt 180; $i++) {
  Start-Sleep -Seconds 1
  try {
    $list = (Invoke-WebRequest "http://127.0.0.1:$Port/json/list" -TimeoutSec 3 -UseBasicParsing).Content | ConvertFrom-Json
    if (@($list | Where-Object { $_.url -like 'app://./archon*' }).Count -gt 0) { $rendererReady = $true; break }
  } catch {}
}
if (-not $rendererReady) { Say 'FATAL: 渲染进程 180 秒内未就绪'; exit 4 }
Say '渲染进程 app://./archon 就绪'

# 4) 起常驻守护
if (-not $NoDaemon) {
  $daemonLog = Join-Path $logDir 'daemon.log'
  $daemonErr = Join-Path $logDir 'daemon.err'
  # The workspace path contains a space ("fix mmx"). Start-Process joins
  # -ArgumentList elements with spaces, so the script path MUST carry its own
  # quotes or node receives "G:\mmx-project\fix" and dies with MODULE_NOT_FOUND.
  $daemonScript = '"' + (Join-Path $Root 'daemon.mjs') + '"'
  Say "启动常驻守护，日志: $daemonLog"
  Start-Process -FilePath 'node' `
    -ArgumentList @($daemonScript, '--port', $Port, '--interval', $Interval) `
    -WindowStyle Hidden -RedirectStandardOutput $daemonLog -RedirectStandardError $daemonErr
  Start-Sleep -Seconds 12
  $alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*daemon.mjs*' })
  Say "守护进程数: $($alive.Count)"
  $tail = if (Test-Path -LiteralPath $daemonLog) { (Get-Content -LiteralPath $daemonLog -Tail 4) -join ' | ' } else { '(no log)' }
  Say "日志尾部: $tail"
  $errTail = if ((Test-Path -LiteralPath $daemonErr) -and (Get-Item -LiteralPath $daemonErr).Length -gt 0) {
    (Get-Content -LiteralPath $daemonErr -Tail 3) -join ' | '
  } else { '(no err)' }
  Say "错误尾部: $errTail"
  if ($alive.Count -eq 0) { Say 'FATAL: 守护进程未能存活'; exit 5 }
}

Say 'DONE：状态点已挂到主窗口'
exit 0
