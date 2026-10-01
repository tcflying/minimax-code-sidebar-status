# 一键重试推送。先测连通性，通了才 push —— 免得对着一个不通的出口反复报错。
#
#   pwsh -NoProfile -File .\src\push-retry.ps1
#
# 背景：2026-10-02 出现过 mihomo 出口对 github 的 TLS 被掐断
#（CONNECT 隧道建立成功、TLS Client hello 发出，5 秒后 alert decode error 562），
# 本机网络正常但 git push 持续失败。换个节点或重启代理即可恢复。
[CmdletBinding()]
param(
    [int]$Attempts = 3,
    [int]$IntervalSec = 10
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Test-GitHub {
    try {
        $r = Invoke-WebRequest -Uri 'https://api.github.com' -TimeoutSec 10 -UseBasicParsing
        return @{ ok = $true; code = $r.StatusCode }
    } catch {
        return @{ ok = $false; err = $_.Exception.Message }
    }
}

Write-Host '=== GitHub 连通性 ==='
$t = Test-GitHub
if ($t.ok) { Write-Host ("  OK  HTTP {0}" -f $t.code) -ForegroundColor Green }
else { Write-Host ("  不可达: {0}" -f $t.err) -ForegroundColor Red }

if (-not $t.ok) {
    Write-Host ''
    Write-Host '出口不通，现在推送只会反复失败。按顺序检查：' -ForegroundColor Yellow
    Write-Host '  1) 代理软件是否在运行（本机 mihomo 监听 7890/7891）'
    Write-Host '  2) 换一个代理节点后再跑本脚本'
    Write-Host '  3) 若只有 GitHub 不通，其它站点正常 -> 是节点对 github 的线路问题'
    Write-Host ''
    Write-Host '当前本地状态（提交不会丢，可随时再推）：'
    git log --oneline -1 | ForEach-Object { '  ' + $_ }
    Write-Host ('  领先远端 ' + (git rev-list --count origin/master..HEAD) + ' 个提交')
    exit 2
}

Write-Host ''
Write-Host '=== 推送 ==='
for ($i = 1; $i -le $Attempts; $i++) {
    Write-Host ("  尝试 {0}/{1} ..." -f $i, $Attempts)
    $out = git push origin master 2>&1
    if ($LASTEXITCODE -eq 0) {
        $out | Select-Object -Last 3 | ForEach-Object { '    ' + $_ }
        Write-Host ''
        Write-Host '推送成功，核对远端：' -ForegroundColor Green
        git fetch origin 2>&1 | Out-Null
        $l = git rev-parse HEAD
        $r = git rev-parse origin/master
        Write-Host ("  本地 {0}" -f $l)
        Write-Host ("  远端 {0}" -f $r)
        Write-Host ("  一致 = {0}" -f ($l -eq $r))
        Write-Host ''
        Write-Host 'https://github.com/tcflying/minimax-code-sidebar-status'
        exit 0
    }
    $out | Select-Object -Last 1 | ForEach-Object { '    ' + $_ }
    if ($i -lt $Attempts) { Start-Sleep -Seconds $IntervalSec }
}

Write-Host ''
Write-Host '推送仍失败。提交安全保存在本地，换节点后重跑本脚本即可。' -ForegroundColor Yellow
git log --oneline -1 | ForEach-Object { '  ' + $_ }
exit 1
