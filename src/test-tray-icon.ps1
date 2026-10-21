<#
.SYNOPSIS
  set-mmx-tray-icon.ps1 的最小自检（无测试框架，assert 风格）。

.DESCRIPTION
  覆盖：
    1. 原生结构尺寸/偏移（用「字节数组」C# 结构体量真实原生布局：
       ByValTStr 的字符宽度由 StructLayout.CharSet 决定，Unicode 下就是
       2 字节/字符；这里用 byte[] 固定长度直接量字节偏移）。
    2. 资源存在性 + ICO 头合法。
    3. 目标门禁反向用例：0/2 候选、错 PID、错路径、辅助子进程、API 失败、
       命令行拿不到（身份不明）等。
    4. 写前复检反向用例：PID 复用、EXE 变了、进程号变了、host 类名/归属变了、
       窗口被换、矩形变了等。
    5. probe 路径一次写 API 都不调；-Apply 但门禁不过时也不调；
       写调用失败时计数不能报 0。
    6. 真实进程只读 probe：写调用数 = 0，GetRect 恰好命中一个有效图标 ID。
    7. launcher 接线静态检查：-NoTrayIcon 跳过、调用点在 DryRun/CDP 失败退出之后、
       换图逻辑封成函数、daemon 起来后才调用、失败只 WARN。
    8. 编译临时目录重定向：Add-Type 期间 TEMP/TMP 指向项目 logs（不落 C 盘），
       结束后进程环境恢复原样。

  绝不真 Apply，也绝不调用整个 launcher。唯一会调 Shell_NotifyIconW 的负例
  （Shell_NotifyIconW 返回 FALSE）用假 host 句柄，且调用前先实测该句柄
  IsWindow=false、对应图标 ID 的 GetRect 非 S_OK；任一条不成立就跳过这项
  负例并明确报告，绝不凭假设去打真 app 的托盘项。

.EXAMPLE
  powershell -NoProfile -File .\test-tray-icon.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$SrcDir = $PSScriptRoot
$Root = Split-Path -Parent $SrcDir
$HelperPath = Join-Path $SrcDir 'set-mmx-tray-icon.ps1'
$LauncherPath = Join-Path $SrcDir 'launch-mmx-status.ps1'
$IconPath = Join-Path $Root 'assets\mmx-red-circle.ico'
$PreviewPath = Join-Path $Root 'assets\mmx-red-circle-preview.png'

$script:pass = 0
$script:fail = 0
$script:failures = New-Object System.Collections.ArrayList
$script:skips = New-Object System.Collections.ArrayList

function Assert-True {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    if ($Ok) {
        $script:pass++
        Write-Host ("PASS  " + $Name + $(if ($Detail) { "  |  " + $Detail } else { '' }))
    } else {
        $script:fail++
        [void]$script:failures.Add($Name + '  ' + $Detail)
        Write-Host ("FAIL  " + $Name + "  |  " + $Detail)
    }
}

function Assert-Equal {
    param([string]$Name, $Expected, $Actual)
    $ok = ($null -eq $Expected -and $null -eq $Actual)
    if (-not $ok) { $ok = ([string]$Expected -eq [string]$Actual) }
    Assert-True -Name $Name -Ok $ok -Detail ("expected=" + $Expected + " actual=" + $Actual)
}

# ---------------------------------------------------------------------------
# 0. 载入被测脚本（dot-source，只取函数，不跑 main）
# ---------------------------------------------------------------------------
$prevEap = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    . $HelperPath
} finally {
    $ErrorActionPreference = $prevEap
}

Assert-True -Name 'helper 可 dot-source 且不跑 main' -Ok ([bool](Get-Command Invoke-MmxTrayIconTask -ErrorAction SilentlyContinue)) -Detail $HelperPath

# ---------------------------------------------------------------------------
# 1. 原生结构尺寸 / 偏移
# ---------------------------------------------------------------------------
Assert-True -Name '架构是 Win64' -Ok ([IntPtr]::Size -eq 8) ("IntPtr.Size=" + [IntPtr]::Size)

$probeSource = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct MmxTrayIdentProbe
{
    public int cbSize;
    public IntPtr hWnd;
    public uint uID;
    public Guid guidItem;
}

[StructLayout(LayoutKind.Sequential)]
public struct MmxTrayDataProbe
{
    public int cbSize;
    public IntPtr hWnd;
    public uint uID;
    public uint uFlags;
    public uint uCallbackMessage;
    public IntPtr hIcon;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)] public byte[] szTip;         // WCHAR[128]
    public uint dwState;
    public uint dwStateMask;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 512)] public byte[] szInfo;        // WCHAR[256]
    public uint uTimeoutOrVersion;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)] public byte[] szInfoTitle;   // WCHAR[64]
    public uint dwInfoFlags;
    public Guid guidItem;
    public IntPtr hBalloonIcon;
}
'@
try {
    # 同样走编译临时目录重定向：PS 5.1 的 Add-Type 不往 C 盘临时目录扔东西
    Invoke-MmxTrayWithCompileTemp { Add-Type -TypeDefinition $probeSource -ErrorAction Stop } | Out-Null
    $probeOk = $true
} catch {
    $probeOk = $false
    Write-Host ("FAIL  布局探针编译失败  |  " + $_.Exception.Message)
    $script:fail++
    [void]$script:failures.Add('布局探针编译失败')
}

if ($probeOk) {
    $identSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][MmxTrayIdentProbe])
    $dataSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][MmxTrayDataProbe])
    Assert-Equal -Name 'NOTIFYICONIDENTIFIER 尺寸 = 40' -Expected 40 -Actual $identSize
    Assert-Equal -Name 'NOTIFYICONDATAW 尺寸 = 976' -Expected 976 -Actual $dataSize

    $identOffsets = @{ cbSize = 0; hWnd = 8; uID = 16; guidItem = 20 }
    foreach ($f in $identOffsets.Keys) {
        $actual = [System.Runtime.InteropServices.Marshal]::OffsetOf([type][MmxTrayIdentProbe], $f)
        Assert-Equal -Name ("IDENT 偏移 " + $f) -Expected $identOffsets[$f] -Actual $actual
    }

    $dataOffsets = @{
        cbSize = 0; hWnd = 8; uID = 16; uFlags = 20; uCallbackMessage = 24; hIcon = 32
        szTip = 40; dwState = 296; dwStateMask = 300; szInfo = 304
        uTimeoutOrVersion = 816; szInfoTitle = 820; dwInfoFlags = 948
        guidItem = 952; hBalloonIcon = 968
    }
    foreach ($f in $dataOffsets.Keys) {
        $actual = [System.Runtime.InteropServices.Marshal]::OffsetOf([type][MmxTrayDataProbe], $f)
        Assert-Equal -Name ("DATA 偏移 " + $f) -Expected $dataOffsets[$f] -Actual $actual
    }

    # helper 手工拼的偏移必须与原生结构体一致（否则 NIM_MODIFY 会写错字段）
    $helperLayout = $script:MmxTrayLayout
    Assert-Equal -Name 'helper IDENT 尺寸 = 40' -Expected 40 -Actual $helperLayout.IdentifierSize
    Assert-Equal -Name 'helper DATA 尺寸 = 976' -Expected 976 -Actual $helperLayout.DataSize
    foreach ($f in $dataOffsets.Keys) {
        Assert-Equal -Name ("helper DATA 偏移 " + $f) -Expected $dataOffsets[$f] -Actual $helperLayout.Data[$f]
    }
    foreach ($f in $identOffsets.Keys) {
        Assert-Equal -Name ("helper IDENT 偏移 " + $f) -Expected $identOffsets[$f] -Actual $helperLayout.Identifier[$f]
    }
}

# ---------------------------------------------------------------------------
# 2. 资源 + ICO 头
# ---------------------------------------------------------------------------
Assert-True -Name 'ICO 资源存在' -Ok (Test-Path -LiteralPath $IconPath -PathType Leaf) $IconPath
Assert-True -Name '预览 PNG 存在' -Ok (Test-Path -LiteralPath $PreviewPath -PathType Leaf) $PreviewPath

if (Test-Path -LiteralPath $IconPath -PathType Leaf) {
    $icoBytes = [System.IO.File]::ReadAllBytes($IconPath)
    $reserved = [BitConverter]::ToUInt16($icoBytes, 0)
    $type = [BitConverter]::ToUInt16($icoBytes, 2)
    $count = [BitConverter]::ToUInt16($icoBytes, 4)
    Assert-Equal -Name 'ICO reserved = 0' -Expected 0 -Actual $reserved
    Assert-Equal -Name 'ICO type = 1 (icon)' -Expected 1 -Actual $type
    Assert-True -Name 'ICO 帧数 > 0' -Ok ($count -gt 0) ("count=" + $count)
    Assert-True -Name 'ICO 非空' -Ok ($icoBytes.Length -gt 0) ("bytes=" + $icoBytes.Length)
}

# ---------------------------------------------------------------------------
# 3. 缓冲区字节布局：真造一次缓冲区，验证写进去的字节
#    （假状态门禁不会碰这里，缓冲区构造必须单独测）
# ---------------------------------------------------------------------------
$identBuf = New-MmxTrayIdentifierBuffer -Window ([IntPtr]1000001) -IconId 3
try {
    Assert-Equal -Name 'IDENT 缓冲区 cbSize = 40' -Expected 40 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt32($identBuf, 0))
    Assert-Equal -Name 'IDENT 缓冲区 hWnd' -Expected 1000001 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt64($identBuf, 8))
    Assert-Equal -Name 'IDENT 缓冲区 uID' -Expected 3 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt32($identBuf, 16))
    Assert-Equal -Name 'IDENT 缓冲区 guidItem 全 0' -Expected 0 `
        -Actual (([System.Runtime.InteropServices.Marshal]::ReadInt64($identBuf, 20)) + ([System.Runtime.InteropServices.Marshal]::ReadInt64($identBuf, 28)))
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($identBuf)
}

$dataBuf = New-MmxTrayDataBuffer -Window ([IntPtr]1000001) -IconId 3 -Icon ([IntPtr]1234)
try {
    Assert-Equal -Name 'DATA 缓冲区 cbSize = 976' -Expected 976 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt32($dataBuf, 0))
    Assert-Equal -Name 'DATA 缓冲区 hWnd' -Expected 1000001 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt64($dataBuf, 8))
    Assert-Equal -Name 'DATA 缓冲区 uID' -Expected 3 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt32($dataBuf, 16))
    Assert-Equal -Name 'DATA 缓冲区 uFlags = NIF_ICON(2)' -Expected 2 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt32($dataBuf, 20))
    Assert-Equal -Name 'DATA 缓冲区 uCallbackMessage 保持 0' -Expected 0 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt32($dataBuf, 24))
    Assert-Equal -Name 'DATA 缓冲区 hIcon' -Expected 1234 -Actual ([System.Runtime.InteropServices.Marshal]::ReadInt64($dataBuf, 32))
    $tipZero = $true
    for ($i = 40; $i -lt 296; $i += 8) {
        if ([System.Runtime.InteropServices.Marshal]::ReadInt64($dataBuf, $i) -ne 0) { $tipZero = $false }
    }
    Assert-True -Name 'DATA 缓冲区 szTip 区全 0（NIF_ICON 不动 tooltip）' -Ok $tipZero ''
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($dataBuf)
}

# 原生 P/Invoke 连线冒烟：对不存在的图标查矩形，必须返回非 S_OK（只读，不写）
Add-MmxTrayNative | Out-Null
$probeBuf = New-MmxTrayIdentifierBuffer -Window ([IntPtr]0) -IconId 3
try {
    $probeRect = New-Object MmxTrayNative+RECT
    $hr = [MmxTrayNative]::Shell_NotifyIconGetRect($probeBuf, [ref]$probeRect)
    Assert-True -Name 'Shell_NotifyIconGetRect 对假图标返回非 S_OK' -Ok ($hr -ne 0) ("hresult=" + $hr)
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($probeBuf)
}

# ---------------------------------------------------------------------------
# 4. 假状态（注入用；不含任何真实进程/窗口）
# ---------------------------------------------------------------------------
$FakeExe = 'D:\MiniMax\MiniMax Code\MiniMax Code.exe'

function New-FakeState {
    param(
        [int]$ProcessId = 4242,
        [string]$ExePath = 'D:\MiniMax\MiniMax Code\MiniMax Code.exe',
        [string]$CommandLine = '"D:\MiniMax\MiniMax Code\MiniMax Code.exe" --remote-debugging-port=9331',
        [long]$CreationTicks = 638000000000000000,
        [int]$HostCount = 1,
        [int[]]$ValidIds = @(3),
        [int[]]$InvalidIds = @(2),
        # 假 host 句柄：故意用 1000001（不是任何真实 host 的句柄），
        # 万一哪天有人拿假状态去 -Apply，也碰不到真 app 的托盘项。
        [long]$Handle = 1000001,
        [int]$HostProcessId = -1,
        [bool]$HostIsWindow = $true,
        [switch]$ProcessMissing
    )
    if ($ProcessMissing) {
        return @{ Process = @{ Ok = $false; Reason = 'process-not-found'; ProcessId = $ProcessId; ExePath = $null; CommandLine = $null; CreationTicks = 0; CreatedUtc = $null }
                 HostWindows = @(); IconCandidates = @() }
    }
    $owner = if ($HostProcessId -lt 0) { $ProcessId } else { $HostProcessId }
    $wins = @()
    for ($i = 0; $i -lt $HostCount; $i++) {
        $wins += @{ Handle = [IntPtr]($Handle + $i); ClassName = 'Electron_NotifyIconHostWindow'; ProcessId = $owner; IsWindow = $HostIsWindow }
    }
    $cands = @()
    foreach ($id in $InvalidIds) {
        $cands += @{ Id = $id; HResult = -2147024809; Left = 0; Top = 0; Right = 0; Bottom = 0; Width = 0; Height = 0; Valid = $false }
    }
    foreach ($id in $ValidIds) {
        $cands += @{ Id = $id; HResult = 0; Left = 2629; Top = 1778; Right = 2671; Bottom = 1849; Width = 42; Height = 71; Valid = $true }
    }
    return @{
        Process = @{
            Ok = $true; Reason = 'ok'; ProcessId = $ProcessId
            ExePath = $ExePath; CommandLine = $CommandLine
            CreationTicks = $CreationTicks
            CreatedUtc = (New-Object DateTime($CreationTicks, [System.DateTimeKind]::Utc)).ToString('o')
        }
        HostWindows = $wins
        IconCandidates = $cands
    }
}

# ---------------------------------------------------------------------------
# 5. 目标门禁反向用例
# ---------------------------------------------------------------------------
$g = Test-MmxTrayTarget -State (New-FakeState) -ExpectedExecutable $FakeExe
Assert-True -Name '门禁 正例通过' -Ok ([bool]$g.Ok) ("reason=" + $g.Reason + " id=" + $g.IconId)
Assert-Equal -Name '门禁 正例图标 ID' -Expected 3 -Actual $g.IconId

$g = Test-MmxTrayTarget -State (New-FakeState -ProcessMissing) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 进程不存在' -Expected 'process-not-found' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -ExePath 'D:\Other\Other.exe') -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 EXE 路径不符' -Expected 'executable-path-mismatch' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -ExePath 'd:\minimax\minimax code\minimax code.exe') -ExpectedExecutable $FakeExe
Assert-True -Name '门禁 EXE 路径大小写不敏感' -Ok ([bool]$g.Ok) ("reason=" + $g.Reason)

foreach ($pattern in @('--type=renderer', '--input-type=module --eval', '--run-as-node', '--inspect-brk')) {
    $g = Test-MmxTrayTarget -State (New-FakeState -CommandLine ('"' + $FakeExe + '" ' + $pattern)) -ExpectedExecutable $FakeExe
    Assert-Equal -Name ('门禁 辅助子进程 ' + $pattern) -Expected 'helper-process' -Actual $g.Reason
}

$g = Test-MmxTrayTarget -State (New-FakeState -HostCount 0) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 0 个 host 窗口' -Expected 'no-host-window' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -HostCount 2) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 2 个 host 窗口' -Expected 'multiple-host-windows' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -HostProcessId 9999) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 host 属于别的 PID' -Expected 'host-window-foreign-pid' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -HostIsWindow $false) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 host 窗口已失效' -Expected 'host-window-gone' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -ValidIds @() -InvalidIds @()) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 0 个图标候选' -Expected 'no-icon-id' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -ValidIds @() -InvalidIds @(2, 4)) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 GetRect 全部失败' -Expected 'rect-api-failed' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState -ValidIds @(3, 5) -InvalidIds @(2)) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 多个图标 ID' -Expected 'multiple-icon-ids' -Actual $g.Reason

$g = Test-MmxTrayTarget -State (New-FakeState) -ExpectedExecutable ''
Assert-Equal -Name '门禁 期望路径为空' -Expected 'invalid-expected-executable' -Actual $g.Reason

# 身份不明（拿不到命令行）-> 必须拒绝，不能把空命令行当主进程
$g = Test-MmxTrayTarget -State (New-FakeState -CommandLine '') -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 命令行为空（身份不明）' -Expected 'commandline-unavailable' -Actual $g.Reason
Assert-True -Name '门禁 命令行为空时 not ok' -Ok (-not $g.Ok) ("reason=" + $g.Reason)

$g = Test-MmxTrayTarget -State (New-FakeState -CommandLine $null) -ExpectedExecutable $FakeExe
Assert-Equal -Name '门禁 命令行为 null（身份不明）' -Expected 'commandline-unavailable' -Actual $g.Reason

# CIM 取不到命令行 -> Get-MmxTrayProcessState 必须明确失败（fail closed）
$noCim = { param($id) $null }
$ps = Get-MmxTrayProcessState -ProcessId $PID -CommandLineProvider $noCim
Assert-True -Name '进程状态：CIM 无数据时 Ok = false' -Ok (-not $ps.Ok) ("reason=" + $ps.Reason)
Assert-Equal -Name '进程状态：CIM 无数据的原因' -Expected 'commandline-unavailable' -Actual $ps.Reason

$throwCim = { param($id) throw 'cim-unavailable' }
$ps2 = Get-MmxTrayProcessState -ProcessId $PID -CommandLineProvider $throwCim
Assert-True -Name '进程状态：CIM 抛异常时 Ok = false' -Ok (-not $ps2.Ok) ("reason=" + $ps2.Reason)
Assert-Equal -Name '进程状态：CIM 抛异常的原因' -Expected 'commandline-unavailable' -Actual $ps2.Reason

# ---------------------------------------------------------------------------
# 6. 写前复检反向用例
# ---------------------------------------------------------------------------
$base = New-FakeState
$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState)
Assert-True -Name '复检 正例通过' -Ok ([bool]$c.Ok) ("reason=" + $c.Reason)

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState -CreationTicks 999)
Assert-Equal -Name '复检 PID 复用（创建时间变了）' -Expected 'stale-creation-time' -Actual $c.Reason

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState -ExePath 'D:\Other\Other.exe')
Assert-Equal -Name '复检 EXE 变了' -Expected 'stale-executable' -Actual $c.Reason

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState -Handle 111)
Assert-Equal -Name '复检 host 窗口被换' -Expected 'stale-host-window' -Actual $c.Reason

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState -HostIsWindow $false)
Assert-Equal -Name '复检 host 窗口已消失' -Expected 'stale-host-window-gone' -Actual $c.Reason

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState -ValidIds @(5) -InvalidIds @(2))
Assert-Equal -Name '复检 图标 ID 变了' -Expected 'stale-icon-id' -Actual $c.Reason

$shifted = New-FakeState
$shifted.IconCandidates[1].Right = 2700
$c = Compare-MmxTrayState -Baseline $base -Current $shifted
Assert-Equal -Name '复检 矩形变了' -Expected 'stale-rect' -Actual $c.Reason

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState -ProcessMissing)
Assert-Equal -Name '复检 进程没了' -Expected 'stale-process-gone' -Actual $c.Reason

# 进程号 / 类名 / 归属 / 身份 的复检
$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState) -ExpectedProcessId 4242
Assert-True -Name '复检 期望进程号一致时通过' -Ok ([bool]$c.Ok) ("reason=" + $c.Reason)

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState) -ExpectedProcessId 9999
Assert-Equal -Name '复检 期望进程号变了' -Expected 'stale-process-id' -Actual $c.Reason

$otherPid = New-FakeState
$otherPid.Process.ProcessId = 5555
$c = Compare-MmxTrayState -Baseline $base -Current $otherPid
Assert-Equal -Name '复检 进程号变了' -Expected 'stale-process-id' -Actual $c.Reason

$c = Compare-MmxTrayState -Baseline $base -Current (New-FakeState -CommandLine '')
Assert-Equal -Name '复检 当前命令行拿不到' -Expected 'commandline-unavailable' -Actual $c.Reason

$blankBase = New-FakeState
$blankBase.Process.CommandLine = ''
$c = Compare-MmxTrayState -Baseline $blankBase -Current (New-FakeState)
Assert-Equal -Name '复检 基线命令行拿不到' -Expected 'commandline-unavailable' -Actual $c.Reason

$badClass = New-FakeState
$badClass.HostWindows[0].ClassName = 'SomeOtherWindow'
$c = Compare-MmxTrayState -Baseline $base -Current $badClass
Assert-Equal -Name '复检 host 类名不对' -Expected 'stale-host-class' -Actual $c.Reason

$badHostPid = New-FakeState
$badHostPid.HostWindows[0].ProcessId = 9999
$c = Compare-MmxTrayState -Baseline $base -Current $badHostPid
Assert-Equal -Name '复检 host 归属进程不对' -Expected 'stale-host-pid' -Actual $c.Reason

$noValidBase = New-FakeState
$noValidBase.IconCandidates[1].Valid = $false
$c = Compare-MmxTrayState -Baseline $noValidBase -Current (New-FakeState)
Assert-Equal -Name '复检 基线没有有效图标 ID' -Expected 'stale-baseline-icon-id' -Actual $c.Reason

# ---------------------------------------------------------------------------
# 7. probe 绝不写；-Apply 门禁不过也绝不写
# ---------------------------------------------------------------------------
$script:fakeCalls = 0
$probeProvider = {
    param($id)
    $script:fakeCalls++
    return (New-FakeState)
}
$before = $script:MmxTrayNativeWriteCount
$r = Invoke-MmxTrayIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe -IconPath $IconPath -StateProvider $probeProvider
$after = $script:MmxTrayNativeWriteCount
Assert-True -Name 'probe 成功返回结构化结果' -Ok ([bool]$r.ok) ("reason=" + $r.reason)
Assert-True -Name 'probe 不 applied' -Ok (-not $r.applied) ("applied=" + $r.applied)
Assert-Equal -Name 'probe 写 API 调用数增量 = 0' -Expected 0 -Actual ($after - $before)
Assert-Equal -Name 'probe mode' -Expected 'probe' -Actual $r.mode
Assert-Equal -Name 'probe 上报 host 句柄' -Expected 1000001 -Actual $r.hostWindow
Assert-Equal -Name 'probe 上报图标 ID' -Expected 3 -Actual $r.iconId

$script:fakeCalls = 0
$staleProvider = {
    param($id)
    $script:fakeCalls++
    if ($script:fakeCalls -eq 1) { return (New-FakeState -CreationTicks 111) }
    return (New-FakeState -CreationTicks 222)
}
$before = $script:MmxTrayNativeWriteCount
$r2 = Invoke-MmxTrayIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe -IconPath $IconPath -Apply -StateProvider $staleProvider
$after = $script:MmxTrayNativeWriteCount
Assert-Equal -Name '-Apply 门禁不过时写 API 调用数增量 = 0' -Expected 0 -Actual ($after - $before)
Assert-True -Name '-Apply 门禁不过时 not applied' -Ok (-not $r2.applied) ("reason=" + $r2.reason)
Assert-Equal -Name '-Apply 门禁不过 reason' -Expected 'stale-creation-time' -Actual $r2.reason

# 参数门禁
$r3 = Invoke-MmxTrayIconTask -TargetProcessId 0 -ExpectedExecutable $FakeExe -StateProvider $probeProvider
Assert-Equal -Name '参数门禁 PID 必须为正' -Expected 'invalid-target-pid' -Actual $r3.reason
$r4 = Invoke-MmxTrayIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe -WaitSeconds 99 -StateProvider $probeProvider
Assert-Equal -Name '参数门禁 WaitSeconds 上限 30' -Expected 'invalid-wait-seconds' -Actual $r4.reason

# ---------------------------------------------------------------------------
# 7b. 写调用失败时计数不能报 0（HICON/buffer 照常清理，ok/applied 必须是 false）
#     LoadImageW 失败用例根本走不到 Shell_NotifyIconW（没有窗口写发生）；
#     Shell_NotifyIconW 失败用例见下面：假 host 句柄，调用前先实测
#     IsWindow=false + 所用 id 的 GetRect 非 S_OK，不靠句柄对齐之类的假设。
# ---------------------------------------------------------------------------
$missingIcon = Join-Path $Root 'logs\tray-review-fix\no-such-icon.ico'
$before = $script:MmxTrayNativeWriteCount
$rMissing = Invoke-MmxTrayIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe -IconPath $missingIcon -Apply -StateProvider $probeProvider
$after = $script:MmxTrayNativeWriteCount
Assert-Equal -Name '-Apply 图标文件不存在时写调用数增量 = 0' -Expected 0 -Actual ($after - $before)
Assert-Equal -Name '-Apply 图标文件不存在的 reason' -Expected 'icon-file-missing' -Actual $rMissing.reason
Assert-True -Name '-Apply 图标文件不存在时 not applied' -Ok (-not $rMissing.applied) ("reason=" + $rMissing.reason)

# LoadImageW 零返回：文件在，但不是合法 ICO
$tmpDir = Join-Path $Root 'logs\tray-review-fix'
if (-not (Test-Path -LiteralPath $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null }
$badIcon = Join-Path $tmpDir 'not-an-icon.ico'
Set-Content -LiteralPath $badIcon -Value 'this is not an ico' -Encoding ascii
try {
    $before = $script:MmxTrayNativeWriteCount
    $rBad = Invoke-MmxTrayIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe -IconPath $badIcon -Apply -StateProvider $probeProvider
    $after = $script:MmxTrayNativeWriteCount
    Assert-Equal -Name 'LoadImageW 失败时写调用数增量 = 1' -Expected 1 -Actual ($after - $before)
    Assert-Equal -Name 'LoadImageW 失败的 reason' -Expected 'icon-load-failed' -Actual $rBad.reason
    Assert-True -Name 'LoadImageW 失败时 ok = false' -Ok (-not $rBad.ok) ("ok=" + $rBad.ok)
    Assert-True -Name 'LoadImageW 失败时 not applied' -Ok (-not $rBad.applied) ("applied=" + $rBad.applied)
} finally {
    Remove-Item -LiteralPath $badIcon -Force -ErrorAction SilentlyContinue
}

# Shell_NotifyIconW 返回 FALSE：假 host 句柄，shell 找不到对应的托盘项。
# 安全前提靠实测，不靠假设：真实 host 句柄 2949962 就是 2 mod 4，「没按 4 字节
# 对齐所以不可能是真窗口」这种推断是错的。这里直接测两件事：
#   (1) 该句柄当前 IsWindow = false（不是任何真实窗口）；
#   (2) 它名下、这次要用到的图标 ID，Shell_NotifyIconGetRect 返回非 S_OK
#       （shell 认得它就意味着这次 NIM_MODIFY 会打到真 app 的托盘项）。
# 两条缺一不可：不成立就跳过这项负例并明确报告，绝不凭假设去打真托盘。
$bogusHandle = [IntPtr]0x0BADF00D
$bogusState = New-FakeState
$bogusIconId = [int](@($bogusState.IconCandidates | Where-Object { $_.Valid })[0].Id)
$bogusIsWindow = [MmxTrayNative]::IsWindow($bogusHandle)
$bogusRectHr = 0
$bogusIdentBuf = New-MmxTrayIdentifierBuffer -Window $bogusHandle -IconId $bogusIconId
try {
    $bogusRect = New-Object MmxTrayNative+RECT
    $bogusRectHr = [MmxTrayNative]::Shell_NotifyIconGetRect($bogusIdentBuf, [ref]$bogusRect)
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($bogusIdentBuf)
}
$bogusSafe = ((-not $bogusIsWindow) -and ($bogusRectHr -ne 0))
if ($bogusSafe) {
    # 两项前提是实测通过的，先显式记下来，再跑这项 native 负例
    Assert-True -Name 'bogus 句柄 IsWindow = false（实测）' -Ok (-not $bogusIsWindow) ("handle=" + $bogusHandle)
    Assert-True -Name 'bogus 句柄所用 id 的 GetRect 非 S_OK（实测）' -Ok ($bogusRectHr -ne 0) ("iconId=" + $bogusIconId + " hresult=" + $bogusRectHr)
    $bogusProvider = {
        param($id)
        $s = New-FakeState
        $s.HostWindows[0].Handle = $bogusHandle
        return $s
    }
    $before = $script:MmxTrayNativeWriteCount
    $rBogus = Invoke-MmxTrayIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe -IconPath $IconPath -Apply -StateProvider $bogusProvider
    $after = $script:MmxTrayNativeWriteCount
    Assert-Equal -Name 'Shell_NotifyIconW 失败时写调用数增量 = 2' -Expected 2 -Actual ($after - $before)
    Assert-Equal -Name 'Shell_NotifyIconW 失败的 reason' -Expected 'shell-notifyicon-failed' -Actual $rBogus.reason
    Assert-True -Name 'Shell_NotifyIconW 失败时 ok = false' -Ok (-not $rBogus.ok) ("ok=" + $rBogus.ok)
    Assert-True -Name 'Shell_NotifyIconW 失败时 not applied' -Ok (-not $rBogus.applied) ("applied=" + $rBogus.applied)
} else {
    # 前提不成立 -> 绝不打这次 Shell_NotifyIconW，跳过并明确报告
    $skipMsg = 'Shell_NotifyIconW 失败用例被跳过：bogus 句柄不安全 isWindow=' + $bogusIsWindow + ' getRectHResult=' + $bogusRectHr
    [void]$script:skips.Add($skipMsg)
    Write-Host ('SKIP  ' + $skipMsg)
}

# ---------------------------------------------------------------------------
# 7c. 真实进程只读 probe：不写任何东西，且 GetRect 必须唯一命中
# ---------------------------------------------------------------------------
function Get-RealMmxTrayTarget {
    # 重新获取 CDP listener PID（不硬编码任何 PID）
    $port = 0
    $exe = $null
    $cim = @(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" -ErrorAction SilentlyContinue)
    foreach ($p in $cim) {
        $cmd = [string]$p.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
        if ($cmd -match '--type=') { continue }
        if ($cmd -match '--remote-debugging-port[= ](\d{1,5})') {
            $port = [int]$Matches[1]
            $exe = [string]$p.ExecutablePath
            break
        }
    }
    if ($port -le 0 -or -not $exe) { return $null }
    $owners = @()
    try {
        $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { $_.OwningProcess } | Where-Object { $_ } | Select-Object -Unique)
    } catch { return $null }
    if ($owners.Count -ne 1) { return $null }
    return @{ ProcessId = [int]$owners[0]; Port = $port; ExePath = $exe }
}

$real = Get-RealMmxTrayTarget
if ($real) {
    $before = $script:MmxTrayNativeWriteCount
    $rp = Invoke-MmxTrayIconTask -TargetProcessId $real.ProcessId -ExpectedExecutable $real.ExePath -IconPath $IconPath
    $after = $script:MmxTrayNativeWriteCount
    Assert-True -Name '真实 probe 成功' -Ok ([bool]$rp.ok) ("reason=" + $rp.reason + " pid=" + $real.ProcessId)
    Assert-Equal -Name '真实 probe 写 API 调用数增量 = 0' -Expected 0 -Actual ($after - $before)
    Assert-True -Name '真实 probe 未 applied' -Ok (-not $rp.applied) ("applied=" + $rp.applied)
    Assert-True -Name '真实 probe 图标 ID 落在 2..32' -Ok ($rp.iconId -ge 2 -and $rp.iconId -le 32) ("id=" + $rp.iconId)
    # 独立复核：GetRect 候选里有效 ID 恰好 1 个，且与 probe 报告一致
    $realState = Get-MmxTrayState -ProcessId $real.ProcessId
    $realValid = @($realState.IconCandidates | Where-Object { $_.Valid })
    Assert-Equal -Name '真实 GetRect 恰好 1 个有效图标 ID' -Expected 1 -Actual $realValid.Count
    if ($realValid.Count -eq 1) {
        Assert-Equal -Name '真实 GetRect 有效 ID 与 probe 报告一致' -Expected ([int]$rp.iconId) -Actual ([int]$realValid[0].Id)
    }
} else {
    $realSkipMsg = '真实 probe：MiniMax Code 没在跑 / CDP 端口不唯一，跳过。'
    [void]$script:skips.Add($realSkipMsg)
    Write-Host ('SKIP  ' + $realSkipMsg)
}

# ---------------------------------------------------------------------------
# 7d. 编译临时目录：Add-Type 期间 TEMP/TMP 指向项目 logs（不落 C 盘），
#     结束后进程环境恢复原样
# ---------------------------------------------------------------------------
$origTemp = $env:TEMP
$origTmp = $env:TMP
Invoke-MmxTrayWithCompileTemp { $script:seenTemp = $env:TEMP } | Out-Null
Assert-True -Name '编译期间 TEMP 指向项目 logs（D 盘）' -Ok ($script:seenTemp -eq $script:MmxTrayCompileTemp) ("temp=" + $script:seenTemp)
Assert-Equal -Name '编译结束后 TEMP 恢复' -Expected $origTemp -Actual $env:TEMP
Assert-Equal -Name '编译结束后 TMP 恢复' -Expected $origTmp -Actual $env:TMP
Assert-True -Name '编译临时目录在项目 logs 下' -Ok ($script:MmxTrayCompileTemp -like (Join-Path $Root 'logs*')) $script:MmxTrayCompileTemp

# ---------------------------------------------------------------------------
# 8. helper 源码静态检查：不能有 exit（会杀掉 & 调用方）
# ---------------------------------------------------------------------------
$helperLines = [System.IO.File]::ReadAllLines($HelperPath)
$exitLines = @()
for ($i = 0; $i -lt $helperLines.Length; $i++) {
    if ($helperLines[$i] -match '(?i)(^|[;\|\s])exit\s') { $exitLines += ($i + 1) }
}
Assert-Equal -Name 'helper 内没有 exit 语句' -Expected 0 -Actual $exitLines.Count
Assert-True -Name 'helper 默认路径指向 assets\mmx-red-circle.ico' `
    -Ok ((Get-Content -LiteralPath $HelperPath -Raw) -match 'assets\\mmx-red-circle\.ico') $IconPath

# 没有「恢复原图」入口：官方重建托盘 / 冷启动会自己装回原图，
# 不提供会触发 Electron DELETE+ADD 的回滚路径（少一个误操作面）
$helperRaw = Get-Content -LiteralPath $HelperPath -Raw
Assert-True -Name 'helper 没有 -Restore 开关' -Ok ($helperRaw -notmatch '(?m)^\s*\[switch\]\$Restore') ''
Assert-True -Name 'helper 没有 TaskbarCreated 恢复入口' -Ok ($helperRaw -notmatch 'TaskbarCreated') ''
Assert-True -Name 'helper 没有 RegisterWindowMessage / SendMessageTimeout' `
    -Ok (($helperRaw -notmatch 'RegisterWindowMessage') -and ($helperRaw -notmatch 'SendMessageTimeout')) ''

# ---------------------------------------------------------------------------
# 9. launcher 接线静态检查
# ---------------------------------------------------------------------------
Assert-True -Name 'launcher 存在' -Ok (Test-Path -LiteralPath $LauncherPath -PathType Leaf) $LauncherPath
if (Test-Path -LiteralPath $LauncherPath -PathType Leaf) {
    $lLines = [System.IO.File]::ReadAllLines($LauncherPath)
    $callIdx = -1
    for ($i = 0; $i -lt $lLines.Length; $i++) {
        if ($lLines[$i] -match 'set-mmx-tray-icon\.ps1') { $callIdx = $i; break }
    }
    Assert-True -Name 'launcher 调用了 helper' -Ok ($callIdx -ge 0) ("line=" + ($callIdx + 1))

    if ($callIdx -ge 0) {
        # DryRun 的 exit 0：在含 "[dry-run] 结束" 的行之后
        $dryIdx = -1
        for ($i = 0; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match '\[dry-run\] 结束') {
                for ($j = $i; $j -lt [Math]::Min($i + 5, $lLines.Length); $j++) {
                    if ($lLines[$j] -match '^\s*exit\s+0') { $dryIdx = $j; break }
                }
                break
            }
        }
        $cdpIdx = -1
        for ($i = 0; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match '^\s*exit\s+3') { $cdpIdx = $i; break }
        }
        Assert-True -Name 'launcher DryRun 退出点存在' -Ok ($dryIdx -ge 0) ("line=" + ($dryIdx + 1))
        Assert-True -Name 'launcher CDP 失败退出点存在' -Ok ($cdpIdx -ge 0) ("line=" + ($cdpIdx + 1))
        Assert-True -Name 'helper 调用在 DryRun 退出之后' -Ok ($dryIdx -ge 0 -and $callIdx -gt $dryIdx) ("dry=" + ($dryIdx + 1) + " call=" + ($callIdx + 1))
        Assert-True -Name 'helper 调用在 CDP 失败退出之后' -Ok ($cdpIdx -ge 0 -and $callIdx -gt $cdpIdx) ("cdp=" + ($cdpIdx + 1) + " call=" + ($callIdx + 1))

        # -NoTrayIcon 逃生开关 + 守卫
        $guardIdx = -1
        for ($i = 0; $i -lt $callIdx; $i++) {
            if ($lLines[$i] -match 'if\s*\(\s*-not\s+\$NoTrayIcon\s*\)') { $guardIdx = $i }
        }
        Assert-True -Name 'launcher 有 -NoTrayIcon 守卫' -Ok ($guardIdx -ge 0) ("line=" + ($guardIdx + 1))
        $hasSwitch = $false
        for ($i = 0; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match '\$NoTrayIcon') { $hasSwitch = $true; break }
        }
        Assert-True -Name 'launcher 声明了 -NoTrayIcon 开关' -Ok $hasSwitch ''

        # 调用带 -Apply：精确定位真正调用 helper 的那一行
        $invokeIdx = -1
        for ($i = $callIdx; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match '&\s*\$trayHelper') { $invokeIdx = $i; break }
        }
        Assert-True -Name 'launcher 真正调用了 helper' -Ok ($invokeIdx -ge 0) ("line=" + ($invokeIdx + 1))
        $applyLine = ''
        if ($invokeIdx -ge 0) { $applyLine = $lLines[$invokeIdx].Trim() }
        Assert-True -Name 'launcher 调用 helper 时带 -Apply' -Ok ($applyLine -match '-Apply') $applyLine

        # 冷启动有界等待：-WaitSeconds 在 1..30
        $waitValue = 0
        if ($invokeIdx -ge 0 -and $lLines[$invokeIdx] -match '-WaitSeconds\s+(\d+)') { $waitValue = [int]$Matches[1] }
        Assert-True -Name 'launcher 调用 helper 带 -WaitSeconds（1..30 有界等待）' `
            -Ok ($waitValue -ge 1 -and $waitValue -le 30) ("wait=" + $waitValue)

        # 用大括号配平算出守卫块的准确范围（固定偏移会扫到块外的代码）
        $depth = 0
        $endIdx = $guardIdx
        for ($i = $guardIdx; $i -lt $lLines.Length; $i++) {
            $depth += ([regex]::Matches($lLines[$i], '\{')).Count
            $depth -= ([regex]::Matches($lLines[$i], '\}')).Count
            $endIdx = $i
            if ($depth -le 0) { break }
        }
        $block = ''
        for ($i = $guardIdx; $i -le $endIdx; $i++) { $block += $lLines[$i] + "`n" }
        Assert-True -Name 'launcher helper 调用在 -NoTrayIcon 守卫块内' `
            -Ok ($callIdx -ge $guardIdx -and $callIdx -le $endIdx) `
            ("guard=" + ($guardIdx + 1) + " call=" + ($callIdx + 1) + " end=" + ($endIdx + 1))
        Assert-True -Name 'launcher 调用块内没有 exit' -Ok ($block -notmatch '(?m)^\s*exit\s') ''
        Assert-True -Name 'launcher 调用块内没有 Stop-Process' -Ok ($block -notmatch 'Stop-Process') ''

        # try/catch + WARN（catch 常写成 "} catch {"，不能行首锚定）
        $tryIdx = -1
        for ($i = $guardIdx; $i -le $callIdx; $i++) {
            if ($lLines[$i] -match '^\s*try\s*\{') { $tryIdx = $i; break }
        }
        $catchText = ''
        for ($i = $callIdx; $i -le $endIdx; $i++) {
            if ($lLines[$i] -match 'catch\s*\{') {
                for ($j = $i; $j -lt [Math]::Min($i + 6, $lLines.Length); $j++) { $catchText += $lLines[$j] + "`n" }
                break
            }
        }
        Assert-True -Name 'launcher helper 调用有 try/catch' -Ok ([bool]$catchText) ''
        Assert-True -Name 'launcher try 在 helper 调用之前' -Ok ($tryIdx -ge 0 -and $tryIdx -lt $callIdx) ("try=" + ($tryIdx + 1) + " call=" + ($callIdx + 1))
        Assert-True -Name 'launcher 失败只记 WARN' -Ok ($catchText -match 'Write-Log' -and $catchText -match "'WARN'") $catchText.Trim()

        # 换图逻辑封成函数；调用点 = -NoDaemon 分支 + daemon 启动之后
        $fnIdx = -1
        for ($i = 0; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match 'function\s+Invoke-MmxTrayIconSwap') { $fnIdx = $i; break }
        }
        Assert-True -Name 'launcher 换图逻辑封成 Invoke-MmxTrayIconSwap' -Ok ($fnIdx -ge 0) ("line=" + ($fnIdx + 1))

        $swapCalls = @()
        for ($i = 0; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match '^\s*Invoke-MmxTrayIconSwap\s+-CdpPort') { $swapCalls += $i }
        }
        Assert-Equal -Name 'launcher 有 2 个换图调用点' -Expected 2 -Actual $swapCalls.Count

        $noDaemonIdx = -1
        for ($i = 0; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match '^\s*if\s*\(\s*\$NoDaemon\s*\)') { $noDaemonIdx = $i; break }
        }
        Assert-True -Name 'launcher -NoDaemon 分支存在' -Ok ($noDaemonIdx -ge 0) ("line=" + ($noDaemonIdx + 1))
        $inNoDaemon = $false
        foreach ($ci in $swapCalls) {
            if ($noDaemonIdx -ge 0 -and $ci -gt $noDaemonIdx -and $ci -lt ($noDaemonIdx + 8)) { $inNoDaemon = $true }
        }
        Assert-True -Name 'launcher -NoDaemon 分支调用了换图函数' -Ok $inNoDaemon ''

        $daemonIdx = -1
        for ($i = 0; $i -lt $lLines.Length; $i++) {
            if ($lLines[$i] -match 'daemon pid=') { $daemonIdx = $i; break }
        }
        $afterDaemon = $false
        foreach ($ci in $swapCalls) {
            if ($daemonIdx -ge 0 -and $ci -gt $daemonIdx) { $afterDaemon = $true }
        }
        Assert-True -Name 'launcher daemon 启动之后才调用换图函数' -Ok $afterDaemon ("daemon=" + ($daemonIdx + 1))

        $allAfter = ($swapCalls.Count -gt 0)
        foreach ($ci in $swapCalls) {
            if ($ci -le $dryIdx -or $ci -le $cdpIdx) { $allAfter = $false }
        }
        Assert-True -Name 'launcher 换图调用点都在 DryRun / CDP 失败退出之后' -Ok $allAfter ''
    }
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ("PASS: " + $script:pass + "   FAIL: " + $script:fail + "   SKIP: " + $script:skips.Count)
if ($script:skips.Count -gt 0) {
    Write-Host '跳过项：'
    foreach ($s in $script:skips) { Write-Host ('  - ' + $s) }
}
if ($script:fail -gt 0) {
    Write-Host '失败项：'
    foreach ($f in $script:failures) { Write-Host ('  - ' + $f) }
    if ($MyInvocation.InvocationName -ne '.') { exit 1 }
}
