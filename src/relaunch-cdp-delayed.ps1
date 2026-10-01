<#
  延迟带参重启 MiniMax Code。
  为什么必须延迟：执行环境本身就在 MiniMax Code 里，杀进程 = 杀自己所在的宿主。
  所以「排程 → 说完话 → 自动执行」，避免命令发出后拿不到任何结果。

  用法（延迟 20 秒）：
    pwsh -NoProfile -File .\relaunch-cdp-delayed.ps1 -DelaySec 20
#>
[CmdletBinding()]
param(
  [int]$DelaySec = 20,
  [int]$Port = 9331,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir ("relaunch-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
}

Say "延迟 ${DelaySec}s 后开始。日志: $Log"

# ---- 0. 探测 exe：优先 G 盘（本机真实路径），再回落 ----
$exe = $null
foreach ($c in @(
    'G:\MiniMax\MiniMax Code\MiniMax Code.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\MiniMax Code\MiniMax Code.exe'),
    'C:\Program Files\MiniMax Code\MiniMax Code.exe')) {
  if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { $exe = $c; break }
}
if (-not $exe) { Say "FATAL 找不到 MiniMax Code.exe"; exit 1 }
Say "exe = $exe"

# ---- 1. 先记录重启前的现场，供事后核对 ----
$before = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
             Where-Object { $_.CommandLine -match 'daemon\.mjs' })
Say ("重启前 daemon 数 = " + $before.Count)

# ---- 2. 清掉连向死端口的僵尸 daemon（不碰应用、不碰 watchdog）----
foreach ($p in $before) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Say ("已清理 daemon，剩余 = " +
     (@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'daemon\.mjs' }).Count))

# ---- 3. 结束应用主进程（子进程随父进程走）----
$mains = @(Get-CimInstance Win32_Process |
           Where-Object { $_.Name -eq 'MiniMax Code.exe' -and $_.CommandLine -notmatch '--type=|--input-type=' })
foreach ($m in $mains) {
  Say "结束主进程 pid=$($m.ProcessId)"
  Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue
}
for ($i = 0; $i -lt 100; $i++) {
  $left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'MiniMax Code.exe' })
  if ($left.Count -eq 0) { break }
  Start-Sleep -Milliseconds 100
}
$left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'MiniMax Code.exe' })
Say ("应用进程剩余 = " + $left.Count)
if ($NoRestart) { Say "-NoRestart：到此为止，不重启。"; exit 0 }

# ---- 4. 带 CDP 参数重启 ----
# --remote-debugging-address=127.0.0.1 必须保留：不限制绑定地址时，
# 调试端口可能对局域网开放，等于把应用控制权暴露出去。
$cdpArgs = @("--remote-debugging-port=$Port", '--remote-debugging-address=127.0.0.1')
Say "以 CDP 参数启动: $($cdpArgs -join ' ')"
Start-Process -FilePath $exe -ArgumentList $cdpArgs

# ---- 5. 不以「端口在监听」收尾，必须拿到 HTTP 200 才算真通 ----
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { Say "FAIL CDP 端口 $Port 未就绪（120 次重试耗尽）"; exit 3 }

try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
  Say "PASS CDP 就绪: $($v.Browser) | $($v['User-Agent'])"
} catch { Say "PASS 端口 200，但读 /json/version 失败: $($_.Exception.Message)" }

# ---- 6. 拉起 daemon ----
$daemonLog = Join-Path $LogDir ("daemon-{0}-{1}.log" -f $Port, (Get-Date -Format 'HHmmss'))
$daemonErr = Join-Path $LogDir ("daemon-{0}-{1}.err" -f $Port, (Get-Date -Format 'HHmmss'))
$nodeExe = (Get-Command node).Source
$daemonArgs = '"' + (Join-Path $Root 'daemon.mjs') + '" --port ' + $Port + ' --interval 2500'
$p = Start-Process -FilePath $nodeExe -ArgumentList $daemonArgs -WindowStyle Hidden `
     -RedirectStandardOutput $daemonLog -RedirectStandardError $daemonErr -PassThru
Say "daemon 已拉起 pid=$($p.Id) 日志=$daemonLog"
Say "完成。watchdog 会在下一轮检测到 APP_UP_CDP_OK 并接管。"
exit 0
