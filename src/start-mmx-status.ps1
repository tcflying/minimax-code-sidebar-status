[CmdletBinding()]
param(
  [switch]$DryRun,
  [int]$Port = 9351,
  [int]$Interval = 2500,
  [switch]$Once,
  [switch]$NoRestart,
  # 逃生舱：关掉「running 行自动置顶」（daemon 默认开）。
  # 与 launch-mmx-status.ps1 的同名开关语义一致。
  [switch]$NoReorder,
  # Skip the interactive confirmation before restarting a running MiniMax Code.
  # Required for unattended/scripted use, because Read-Host reads the console
  # and cannot be fed through a pipeline.
  [switch]$Force
)

# ASCII-only .cmd rules do not apply here; this is a .ps1 so UTF-8 with BOM is fine.
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-MiniMaxExecutable {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:MINIMAX_CODE_EXECUTABLE) { $candidates.Add($env:MINIMAX_CODE_EXECUTABLE) }
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\MiniMax Code\MiniMax Code.exe'))
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\MiniMax Inside Code\MiniMax Inside Code.exe'))
  $candidates.Add('G:\MiniMax\MiniMax Code\MiniMax Code.exe')
  $candidates.Add('C:\Program Files\MiniMax Code\MiniMax Code.exe')
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c } }
  return $null
}

$exe = Get-MiniMaxExecutable
if (-not $exe) {
  Write-Host '未找到 MiniMax Code.exe。请设置 MINIMAX_CODE_EXECUTABLE。' -ForegroundColor Red
  exit 1
}
Write-Host "MiniMax Code: $exe"

$procName = [System.IO.Path]::GetFileNameWithoutExtension($exe)
$cdpArgs = @("--remote-debugging-port=$Port", '--remote-debugging-address=127.0.0.1')

# daemon 参数默认不传 reorder 开关，用 daemon 自己的默认值（置顶=开）；
# 只有 -NoReorder 才追加 --no-reorder。与 launch-mmx-status.ps1 保持一致。
$daemonArgList = @("$Root\daemon.mjs", '--port', $Port, '--interval', $Interval)
if ($Once) { $daemonArgList += '--once' }
if ($NoReorder) { $daemonArgList += '--no-reorder' }

if ($DryRun) {
  Write-Host "[dry-run] `"$exe`" $($cdpArgs -join ' ')"
  Write-Host "[dry-run] node $($daemonArgList -join ' ')"
  exit 0
}

# Is CDP already up (app already started with the flags)?
$cdpUp = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing
  $cdpUp = ($r.StatusCode -eq 200)
} catch { }

$running = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)

if ($running.Count -gt 0 -and -not $cdpUp -and -not $NoRestart) {
  if (-not $Force -and -not $DryRun) {
    Write-Host "检测到 $($running.Count) 个 MiniMax Code 进程正在运行且未开启 CDP。" -ForegroundColor Yellow
    Write-Host '必须退出后用 CDP 参数重启，注入才能生效。' -ForegroundColor Yellow
    Write-Host -NoNewline '继续？将结束这些进程并重启 [y/N] '
    $answer = Read-Host
    if ($answer -notmatch '^(?i)y(es)?$') { Write-Host '已取消。'; exit 0 }
  } elseif ($Force) {
    Write-Host "-Force：直接结束 $($running.Count) 个进程并重启。" -ForegroundColor Yellow
  }
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 60; $i++) {
    if (@(Get-Process -Name $procName -ErrorAction SilentlyContinue).Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  }
}

if (-not $cdpUp) {
  Write-Host "以 CDP 参数启动: --remote-debugging-port=$Port" -ForegroundColor Cyan
  Start-Process -FilePath $exe -ArgumentList $cdpArgs
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $cdpUp = $true; break }
    } catch { }
  }
  if (-not $cdpUp) {
    Write-Host "CDP 端口 $Port 未就绪。" -ForegroundColor Red
    Write-Host "手工验证: curl.exe http://127.0.0.1:$Port/json/version"
    exit 3
  }
}

Write-Host 'CDP 已就绪，启动注入守护。' -ForegroundColor Green
& node @daemonArgList
exit $LASTEXITCODE
