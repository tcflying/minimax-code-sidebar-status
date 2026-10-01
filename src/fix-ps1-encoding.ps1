# 为含中文的 .ps1 补 UTF-8 BOM 并统一为 CRLF。
# 字节级处理：显式按 UTF-8(无BOM) 读入、CRLF 写回、UTF-8(有BOM) 落盘。
# 不走 Get-Content|Set-Content —— PS 5.1 那条管道会再写一次 BOM，且会改内容。
[CmdletBinding()]
param(
    # 默认 = 本脚本所在的 src 目录（从自身位置派生）。
    # 旧默认值写死 'G:\mmx-project\fix mmx\mmx-status'，那是已废弃的裸目录副本，
    # 裸跑会把编码修到那份假副本上去，真正的 git 仓库反而没被处理。
    # 参数覆盖仍保留：要修别处就显式 -Dir 传进去。
    [string]$Dir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$dir = $Dir

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$utf8Bom   = [System.Text.UTF8Encoding]::new($true)

# -Recurse：18 个 .ps1 目前都在 src\ 顶层所以不用也能跑，但以后新增子目录
# （如 lib\）就会漏掉。编码不合规的脚本在 PS 5.1 下是直接解析崩溃的，漏一个就
# 是一条线上事故，所以这里递归扫。
Get-ChildItem -LiteralPath $dir -File -Filter *.ps1 -Recurse | Sort-Object FullName | ForEach-Object {
    $path = $_.FullName
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hadBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)

    $text = [System.IO.File]::ReadAllText($path, $utf8NoBom)
    $crlfBefore = ([regex]::Matches($text, "`r`n")).Count
    $lfBefore   = ([regex]::Matches($text, "`n")).Count

    # 先全部归一化到 LF，再统一转 CRLF —— 幂等，重复跑不会叠加
    $text = $text -replace "`r`n", "`n"
    $text = $text -replace "`n", "`r`n"

    $crlfAfter = ([regex]::Matches($text, "`r`n")).Count
    $lfAfter   = ([regex]::Matches($text, "`n")).Count

    [System.IO.File]::WriteAllText($path, $text, $utf8Bom)

    $newBytes = [System.IO.File]::ReadAllBytes($path)
    $nowBom = ($newBytes[0] -eq 239 -and $newBytes[1] -eq 187 -and $newBytes[2] -eq 191)

    '{0,-32} BOM {1}->{2}  CRLF {3}->{4}  bareLF {5}->{6}' -f `
        $_.Name, $(if($hadBom){'有'}else{'无'}), $(if($nowBom){'有'}else{'无'}), `
        $crlfBefore, $crlfAfter, ($lfBefore-$crlfBefore), ($lfAfter-$crlfAfter)
}
