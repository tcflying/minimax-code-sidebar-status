<#
  生成一个红色 "M" 的多尺寸 .ico（GDI+ 绘制，零外部依赖）。
  尺寸覆盖 16/24/32/48/64/128/256，Windows 会按需缩放。
  视觉：深红圆角底 + 白色 M，带一点高光，避免小尺寸下糊成一团。
#>
[CmdletBinding()]
param(
  [string]$OutPath = (Join-Path $PSScriptRoot 'mmx-fix.ico'),
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing

function New-MBitmap([int]$s) {
  # 用 Format32bppArgb 保证 alpha 正确，图标边缘不出现黑边
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)
  return @($bmp, $g)
}

function Draw-Mark([System.Drawing.Graphics]$g, [int]$s) {
  $pad = [Math]::Max(1.0, $s * 0.06)
  $r   = $s * 0.22          # 圆角半径
  $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($s - 2 * $pad), ($s - 2 * $pad))

  # 底：深红渐变（顶部稍亮，底部更深）
  $top = [System.Drawing.Color]::FromArgb(255, 220, 38, 38)
  $bot = [System.Drawing.Color]::FromArgb(255, 168, 18, 18)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $top, $bot, 90.0)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath($brush, $path)
  $path.Dispose(); $brush.Dispose()

  # 字：M。字号随尺寸缩放，垂直微调让视觉居中
  $fs  = $s * 0.62
  $fam = New-Object System.Drawing.Font('Arial Black', $fs, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment     = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $tr = $s * 0.04
  $g.DrawString('M', $fam, $white, (New-Object System.Drawing.RectangleF(0, $tr, $s, $s)), $fmt)
  $white.Dispose(); $fmt.Dispose(); $fam.Dispose()
}

# ---- 先把每个尺寸画成独立 PNG，再打包成 ICO ----
$pngs = @()
foreach ($s in $Sizes) {
  $bmpG = New-MBitmap $s
  $bmp = $bmpG[0]; $g = $bmpG[1]
  Draw-Mark $g $s
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose(); $bmp.Dispose()
  $pngs += ,@{ Size = $s; Bytes = $bytes }
  Write-Host ("  已绘制 " + $s + "x" + $s + " (" + $bytes.Length + " bytes)")
}

# ---- 手写 ICO 容器：header + 16 字节目录项 + PNG 数据 ----
# 目录项里的宽高是单字节，256 必须写成 0。
$fs = [System.IO.File]::Create($OutPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([UInt16]0)                 # reserved
  $bw.Write([UInt16]1)                 # type = icon
  $bw.Write([UInt16]$pngs.Count)

  $offset = 6 + 16 * $pngs.Count
  foreach ($p in $pngs) {
    $w = if ($p.Size -ge 256) { [byte]0 } else { [byte]$p.Size }
    $h = if ($p.Size -ge 256) { [byte]0 } else { [byte]$p.Size }
    $bw.Write($w)                      # width
    $bw.Write($h)                      # height
    $bw.Write([byte]0)                 # colors in palette (0 = truecolor)
    $bw.Write([byte]0)                 # reserved
    $bw.Write([UInt16]1)               # color planes
    $bw.Write([UInt16]32)              # bits per pixel
    $bw.Write([UInt32]$p.Bytes.Length) # size
    $bw.Write([UInt32]$offset)         # offset
    $offset += $p.Bytes.Length
  }
  foreach ($p in $pngs) { $bw.Write($p.Bytes) }
} finally {
  $bw.Dispose(); $fs.Dispose()
}

Write-Host ("已写出 ICO: " + $OutPath + " (" + (Get-Item $OutPath).Length + " bytes)")
