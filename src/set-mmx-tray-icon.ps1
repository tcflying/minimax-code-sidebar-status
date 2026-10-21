<#
.SYNOPSIS
  MiniMax Code 托盘图标换图工具（默认只读探测；只有 -Apply 才写）。

.DESCRIPTION
  官方机制依据（不猜 CLI、不猜图标 ID）：
    - electron/shell/browser/ui/win/notify_icon_host.cc
        托盘图标的宿主是隐藏顶级窗口，类名 Electron_NotifyIconHostWindow，
        归属 Electron 主进程；图标 ID 从 BaseIconID 起递增（非 GUID 样式）。
    - electron/shell/browser/ui/win/notify_icon.cc::GetBounds
        用 Shell_NotifyIconGetRect(hWnd + uID) 读图标屏幕矩形。
    - electron/shell/browser/ui/win/notify_icon.cc::SetImage
        换图只发 NIF_ICON(0x2) + NIM_MODIFY(0x1)，不动 tooltip / 回调 / 菜单。
    - WinAPI: Shell_NotifyIconW / Shell_NotifyIconGetRect
        https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shell_notifyiconw
        https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shell_notifyicongetrect

  安全边界（硬约束）：
    - 默认不带 -Apply 时只读：枚举窗口 + 读图标矩形，绝不调任何写 API。
    - -Apply 只发一次 NIM_MODIFY（NIM_ADD / NIM_DELETE 之外一个字节都不碰），
      把本进程 LoadImageW 出来的 HICON 交给 shell，用完 DestroyIcon。
    - 不改官方 app.asar / exe / 资源 / 注册表 / 快捷方式；不新建托盘项；
      不 NIM_ADD / NIM_DELETE；不读写别的进程内存；不改别的应用。
    - 没有「恢复原图」开关：官方重建托盘 / 冷启动会自己装回原图，
      不提供会触发 Electron DELETE+ADD 的回滚入口（少一个误操作面）。
    - 图标 ID 不假定是 2：在 2..32 实测 GetRect，只有「恰好一个」S_OK 且矩形
      非空才认；0 个 / 多个 / GUID 样式无法证明 -> 一律拒绝（fail closed）。
    - 身份不明（拿不到命令行 / 判定不出是不是主进程）-> 一律拒绝写。
    - 写之前二次核对：PID 的进程创建时间、EXE 规范全路径、host 窗口归属、
      IsWindow、图标 ID、矩形，全部与基线一致才动手（防 stale / PID 复用）。

  结构体尺寸（Win64，依据 Windows Kits 10.0.26100.0\um\shellapi.h:1042-1071，
  1177-1182）：
    NOTIFYICONIDENTIFIER = 40  (cbSize0 hWnd8 uID16 guidItem20)
    NOTIFYICONDATAW     = 976  (cbSize0 hWnd8 uID16 uFlags20 cbMsg24 hIcon32
                               szTip40[128W] dwState296 dwStateMask300
                               szInfo304[256W] uTimeout816 szInfoTitle820[64W]
                               dwInfoFlags948 guidItem952 hBalloonIcon968)
  说明：ByValTStr 的字符宽度由 StructLayout.CharSet 决定（Unicode 下 2 字节/字符），
  C# 结构体本身能表达原生布局；这里手工按上表拼字节，是想把 Win64 的字段偏移
  显式钉死（不依赖 CLR 的自动布局/padding），不是 CLR 的限制。

  退出码：脚本内没有 exit，退出码恒为 0。成功与否看返回对象的 ok / applied 字段，
  调用方必须自己检查结果，不能拿退出码当成功标志（这样 & 调用不会杀掉调用方）。

.EXAMPLE
  只探测（不写任何东西）：
    powershell -NoProfile -File .\set-mmx-tray-icon.ps1 -TargetProcessId 1234 -ExpectedExecutable "D:\MiniMax\MiniMax Code\MiniMax Code.exe"

.EXAMPLE
  真正换图（父会话审查后才允许执行）：
    powershell -NoProfile -File .\set-mmx-tray-icon.ps1 -TargetProcessId 1234 -ExpectedExecutable "D:\MiniMax\MiniMax Code\MiniMax Code.exe" -Apply

.EXAMPLE
  被别的脚本 & 调用（脚本内没有 exit，不会杀掉调用方）：
    $r = & .\set-mmx-tray-icon.ps1 -TargetProcessId $pid -ExpectedExecutable $exe -Apply
    if ($r.ok -and $r.applied) { ... }
#>
[CmdletBinding()]
param(
  # 目标主进程 PID（正整数）。刻意不写 Mandatory：本文件会被测试 dot-source，
  # Mandatory 会让 dot-source 变成交互式参数提示，把测试卡死。
  [int]$TargetProcessId = 0,
  # 目标 EXE 的精确完整路径（必须与进程实际 EXE 规范路径完全一致）。
  [string]$ExpectedExecutable = '',
  # 待写入的 ICO。
  [string]$IconPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\mmx-red-circle.ico'),
  # 显式开关：真正下发 NIM_MODIFY。
  [switch]$Apply,
  # 等待目标出现（托盘窗口/图标 ID 可能晚于进程起来）。上限 30 秒，默认 0。
  # launcher 冷启动时传 8（有界等待，超时只是不换图，不影响启动）。
  [int]$WaitSeconds = 0
)

# ---------------------------------------------------------------------------
# 原生层
# ---------------------------------------------------------------------------
$script:MmxTrayNativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MmxTrayNative
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int Shell_NotifyIconGetRect(IntPtr idpid, out RECT prc);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Shell_NotifyIconW(uint dwMessage, IntPtr lpData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadImageW(IntPtr hinst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
'@

# 写 API 调用计数（自检用来证明 probe 路径一个写调用都没有）
$script:MmxTrayNativeWriteCount = 0

# Electron 托盘宿主窗口类名（官方 notify_icon_host.cc）
$script:MmxTrayHostClass = 'Electron_NotifyIconHostWindow'

# 图标 ID 候选区间：只在这里实测，不假定具体值
$script:MmxTrayCandidateIds = @(2..32)

# Win64 原生布局（依据 Windows Kits 10.0.26100.0\um\shellapi.h）
$script:MmxTrayLayout = @{
    IdentifierSize = 40
    Identifier     = @{ cbSize = 0; hWnd = 8; uID = 16; guidItem = 20 }
    DataSize       = 976
    Data           = @{
        cbSize = 0; hWnd = 8; uID = 16; uFlags = 20; uCallbackMessage = 24; hIcon = 32
        szTip = 40; dwState = 296; dwStateMask = 300; szInfo = 304
        uTimeoutOrVersion = 816; szInfoTitle = 820; dwInfoFlags = 948
        guidItem = 952; hBalloonIcon = 968
    }
}

# 辅助子进程命令行特征：主进程没有这些，renderer/gpu/eval/node 辅助进程有。
$script:MmxTrayHelperPatterns = @(
    '--type=',
    '--eval',
    '--input-type=',
    '--run-as-node',
    '--inspect-brk',
    '--inspect'
)

# 编译临时目录：Add-Type（C# CodeDom / Roslyn）会把临时文件写到
# Path.GetTempPath()，也就是 %TEMP%（PS 5.1 下通常是 C 盘）。
# 编译期间把本进程的 TEMP/TMP 指向项目 logs 下的 D 盘子目录，
# 编译完立刻恢复（只动本进程环境变量，不碰系统 / 用户级设置）。
if ($PSScriptRoot) { $script:MmxTrayProjectRoot = Split-Path -Parent $PSScriptRoot }
else { $script:MmxTrayProjectRoot = (Get-Location).Path }
$script:MmxTrayCompileTemp = Join-Path $script:MmxTrayProjectRoot 'logs\tray-compile-tmp'

function Invoke-MmxTrayWithCompileTemp {
    param([scriptblock]$Block)
    $oldTemp = $env:TEMP
    $oldTmp = $env:TMP
    $dir = $script:MmxTrayCompileTemp
    try {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null
        }
        $env:TEMP = $dir
        $env:TMP = $dir
        & $Block
    } finally {
        if ($null -eq $oldTemp) { [System.Environment]::SetEnvironmentVariable('TEMP', $null, 'Process') }
        else { $env:TEMP = $oldTemp }
        if ($null -eq $oldTmp) { [System.Environment]::SetEnvironmentVariable('TMP', $null, 'Process') }
        else { $env:TMP = $oldTmp }
    }
}

function Add-MmxTrayNative {
    if ('MmxTrayNative' -as [type]) { return $true }
    try {
        Invoke-MmxTrayWithCompileTemp { Add-Type -TypeDefinition $script:MmxTrayNativeSource -ErrorAction Stop } | Out-Null
        return $true
    } catch {
        throw ("加载原生声明失败：" + $_.Exception.Message)
    }
}

function Clear-MmxTrayBuffer {
    # 把原生缓冲区清零。Marshal.Copy(byte[], int, IntPtr, int) 这个 4 参重载
    # 在 PS 5.1 / PS 7 都存在，直接把等长零数组拷过去最省事。
    param([IntPtr]$Buffer, [int]$Size)
    $zeros = New-Object byte[] $Size
    [System.Runtime.InteropServices.Marshal]::Copy($zeros, 0, $Buffer, $Size)
}

function New-MmxTrayIdentifierBuffer {
    # 40 字节 NOTIFYICONIDENTIFIER：cbSize / hWnd / uID / guidItem(全 0)
    param([IntPtr]$Window, [int]$IconId)
    $size = [int]$script:MmxTrayLayout.IdentifierSize
    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    Clear-MmxTrayBuffer -Buffer $buf -Size $size
    $o = $script:MmxTrayLayout.Identifier
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, $o.cbSize, $size)
    [System.Runtime.InteropServices.Marshal]::WriteInt64($buf, $o.hWnd, $Window.ToInt64())
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, $o.uID, $IconId)
    return $buf
}

function New-MmxTrayDataBuffer {
    # 976 字节 NOTIFYICONDATAW。只写 cbSize/hWnd/uID/uFlags(NIF_ICON)/hIcon，
    # 其余全 0：uFlags 只有 NIF_ICON，shell 就不会动 tooltip / 回调 / 菜单 / 状态。
    param([IntPtr]$Window, [int]$IconId, [IntPtr]$Icon)
    $size = [int]$script:MmxTrayLayout.DataSize
    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    Clear-MmxTrayBuffer -Buffer $buf -Size $size
    $o = $script:MmxTrayLayout.Data
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, $o.cbSize, $size)
    [System.Runtime.InteropServices.Marshal]::WriteInt64($buf, $o.hWnd, $Window.ToInt64())
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, $o.uID, $IconId)
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, $o.uFlags, 2)   # NIF_ICON
    [System.Runtime.InteropServices.Marshal]::WriteInt64($buf, $o.hIcon, $Icon.ToInt64())
    return $buf
}

function Get-MmxTrayProcessState {
    # 只读：进程快照（EXE 规范路径 / 命令行 / 创建时间基线）。
    # CommandLineProvider 只给测试注入用，默认走 CIM。
    param([int]$ProcessId, [scriptblock]$CommandLineProvider)
    $res = @{
        Ok = $false; Reason = $null; ProcessId = $ProcessId
        ExePath = $null; CommandLine = $null; CreationTicks = 0; CreatedUtc = $null
    }
    if ($ProcessId -le 0) { $res.Reason = 'invalid-target-pid'; return $res }

    $proc = $null
    try { $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue } catch { $proc = $null }
    if (-not $proc) { $res.Reason = 'process-not-found'; return $res }

    $exe = $null
    try { if ($proc.MainModule) { $exe = $proc.MainModule.FileName } } catch { $exe = $null }

    $cmd = $null
    $created = $null
    try {
        if (-not $CommandLineProvider) {
            $CommandLineProvider = { param($id) Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f $id) -ErrorAction Stop }
        }
        $cim = & $CommandLineProvider $ProcessId
        if ($cim) {
            if (-not $exe) { $exe = $cim.ExecutablePath }
            $cmd = [string]$cim.CommandLine
            if ($cim.CreationDate) {
                # PS 5.1 的 CIM 给 DMTF 字符串，PS 7 给 DateTime，两种都认。
                if ($cim.CreationDate -is [datetime]) { $created = [datetime]$cim.CreationDate }
                else { $created = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$cim.CreationDate) }
            }
        }
    } catch { }

    if (-not $exe) { $res.Reason = 'executable-path-unavailable'; return $res }
    try { $exe = [System.IO.Path]::GetFullPath($exe) } catch { }
    $res.ExePath = $exe
    $res.CommandLine = $cmd

    # 命令行拿不到 = 身份不明（分不出主进程 / 辅助子进程）-> fail closed。
    if ([string]::IsNullOrWhiteSpace($cmd)) { $res.Reason = 'commandline-unavailable'; return $res }

    # 进程创建时间基线：写前复检用它挡 PID 复用。
    try { $res.CreationTicks = $proc.StartTime.ToUniversalTime().Ticks } catch { }
    if ($res.CreationTicks -le 0 -and $created) { $res.CreationTicks = $created.ToUniversalTime().Ticks }
    if ($res.CreationTicks -le 0) { $res.Reason = 'creation-time-unavailable'; return $res }
    $res.CreatedUtc = (New-Object DateTime($res.CreationTicks, [System.DateTimeKind]::Utc)).ToString('o')
    $res.Ok = $true
    $res.Reason = 'ok'
    return $res
}

function Test-MmxTrayHelperProcess {
    # 主进程 vs 辅助子进程：不能只看 EXE 名，renderer/gpu/eval 都是同一个 EXE。
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    foreach ($pat in $script:MmxTrayHelperPatterns) {
        if ($CommandLine -match [regex]::Escape($pat)) { return $true }
    }
    return $false
}

function Get-MmxTrayHostWindows {
    # 只读：EnumWindows + GetWindowThreadProcessId + GetClassName，
    # 只留下属于目标 PID 且类名精确等于 Electron_NotifyIconHostWindow 的窗口。
    param([int]$ProcessId)
    $found = New-Object System.Collections.ArrayList
    $callback = [MmxTrayNative+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        $owner = [uint32]0
        [void][MmxTrayNative]::GetWindowThreadProcessId($hWnd, [ref]$owner)
        if ($owner -eq [uint32]$ProcessId) {
            $sb = New-Object System.Text.StringBuilder 256
            [void][MmxTrayNative]::GetClassNameW($hWnd, $sb, 256)
            $className = $sb.ToString()
            if ($className -eq $script:MmxTrayHostClass) {
                [void]$found.Add(@{
                    Handle    = $hWnd
                    ClassName = $className
                    ProcessId = [int]$owner
                    IsWindow  = [MmxTrayNative]::IsWindow($hWnd)
                })
            }
        }
        return $true
    }
    [void][MmxTrayNative]::EnumWindows($callback, [IntPtr]::Zero)
    return $found.ToArray()
}

function Get-MmxTrayIconCandidates {
    # 只读：在 2..32 区间逐个用 Shell_NotifyIconGetRect 实测，收集 S_OK 且矩形非空。
    param([IntPtr]$Window)
    $out = New-Object System.Collections.ArrayList
    foreach ($id in $script:MmxTrayCandidateIds) {
        $buf = New-MmxTrayIdentifierBuffer -Window $Window -IconId $id
        try {
            $rect = New-Object MmxTrayNative+RECT
            $hr = [MmxTrayNative]::Shell_NotifyIconGetRect($buf, [ref]$rect)
            $w = $rect.Right - $rect.Left
            $h = $rect.Bottom - $rect.Top
            [void]$out.Add(@{
                Id = $id; HResult = $hr
                Left = $rect.Left; Top = $rect.Top; Right = $rect.Right; Bottom = $rect.Bottom
                Width = $w; Height = $h
                Valid = ($hr -eq 0 -and $w -gt 0 -and $h -gt 0)
            })
        } finally {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
        }
    }
    return $out.ToArray()
}

function Get-MmxTrayState {
    # 只读快照：进程 + host 窗口 + 图标候选。
    param([int]$ProcessId)
    $state = @{ Process = $null; HostWindows = @(); IconCandidates = @() }
    $state.Process = Get-MmxTrayProcessState -ProcessId $ProcessId
    if (-not $state.Process.Ok) { return $state }
    $wins = @(Get-MmxTrayHostWindows -ProcessId $ProcessId)
    $state.HostWindows = $wins
    if ($wins.Count -eq 1) {
        $state.IconCandidates = @(Get-MmxTrayIconCandidates -Window $wins[0].Handle)
    }
    return $state
}

function Test-MmxTrayTarget {
    # 纯门禁（无副作用）：所有条件满足才 Ok。
    param($State, [string]$ExpectedExecutable)
    $d = @{ Ok = $false; Reason = $null; HostWindow = $null; IconId = 0; Rect = $null }

    if (-not $State -or -not $State.Process) { $d.Reason = 'process-not-found'; return $d }
    $proc = $State.Process
    if (-not $proc.Ok) { $d.Reason = $proc.Reason; return $d }

    # 1) EXE 规范完整路径必须精确一致
    if ([string]::IsNullOrWhiteSpace($ExpectedExecutable)) { $d.Reason = 'invalid-expected-executable'; return $d }
    $expected = $null
    try { $expected = [System.IO.Path]::GetFullPath($ExpectedExecutable) } catch { }
    if (-not $expected) { $d.Reason = 'invalid-expected-executable'; return $d }
    if (-not [string]::Equals([string]$proc.ExePath, [string]$expected, [System.StringComparison]::OrdinalIgnoreCase)) {
        $d.Reason = 'executable-path-mismatch'; return $d
    }

    # 2) 身份不明 -> 拒绝：命令行空就分不出主进程 / 辅助子进程
    if ([string]::IsNullOrWhiteSpace([string]$proc.CommandLine)) { $d.Reason = 'commandline-unavailable'; return $d }

    # 3) 必须是主进程，不能是同 EXE 的辅助子进程
    if (Test-MmxTrayHelperProcess -CommandLine $proc.CommandLine) { $d.Reason = 'helper-process'; return $d }

    # 4) 唯一 host 窗口
    $wins = @($State.HostWindows)
    if ($wins.Count -eq 0) { $d.Reason = 'no-host-window'; return $d }
    if ($wins.Count -gt 1) { $d.Reason = 'multiple-host-windows'; return $d }
    $win = $wins[0]
    if (-not $win.IsWindow) { $d.Reason = 'host-window-gone'; return $d }
    if ([int]$win.ProcessId -ne [int]$proc.ProcessId) { $d.Reason = 'host-window-foreign-pid'; return $d }

    # 5) 图标 ID 必须实测唯一
    $all = @($State.IconCandidates)
    $valid = @($all | Where-Object { $_.Valid })
    if ($valid.Count -eq 0) {
        $d.Reason = if ($all.Count -gt 0) { 'rect-api-failed' } else { 'no-icon-id' }
        return $d
    }
    if ($valid.Count -gt 1) { $d.Reason = 'multiple-icon-ids'; return $d }

    $d.Ok = $true
    $d.Reason = 'ok'
    $d.HostWindow = $win
    $d.IconId = [int]$valid[0].Id
    $d.Rect = $valid[0]
    return $d
}

function Compare-MmxTrayState {
    # 纯门禁（无副作用）：写前复检，防止 stale / PID 复用 / 窗口被换掉。
    # ExpectedProcessId > 0 时，额外核对进程号本身（防 PID 复用后仍是同一 exe）。
    param($Baseline, $Current, [int]$ExpectedProcessId = 0)
    $d = @{ Ok = $false; Reason = $null }
    if (-not $Current -or -not $Current.Process -or -not $Current.Process.Ok) { $d.Reason = 'stale-process-gone'; return $d }
    if (-not $Baseline -or -not $Baseline.Process) { $d.Reason = 'stale-baseline-missing'; return $d }

    if ([long]$Current.Process.CreationTicks -ne [long]$Baseline.Process.CreationTicks) { $d.Reason = 'stale-creation-time'; return $d }
    if (-not [string]::Equals([string]$Current.Process.ExePath, [string]$Baseline.Process.ExePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        $d.Reason = 'stale-executable'; return $d
    }

    # 进程号必须还是同一个（PID 复用后 exe / 创建时间都可能被对齐）
    if ([int]$Current.Process.ProcessId -ne [int]$Baseline.Process.ProcessId) { $d.Reason = 'stale-process-id'; return $d }
    if ($ExpectedProcessId -gt 0 -and [int]$Current.Process.ProcessId -ne $ExpectedProcessId) { $d.Reason = 'stale-process-id'; return $d }

    # 身份不明 -> 拒绝写（命令行空 = 分不出主进程 / 辅助子进程）
    if ([string]::IsNullOrWhiteSpace([string]$Current.Process.CommandLine)) { $d.Reason = 'commandline-unavailable'; return $d }
    if ([string]::IsNullOrWhiteSpace([string]$Baseline.Process.CommandLine)) { $d.Reason = 'commandline-unavailable'; return $d }

    $baseWins = @($Baseline.HostWindows)
    $curWins = @($Current.HostWindows)
    if ($curWins.Count -ne 1) { $d.Reason = 'stale-host-window-count'; return $d }
    if ($baseWins.Count -ne 1) { $d.Reason = 'stale-baseline-missing'; return $d }
    if ([long]$curWins[0].Handle -ne [long]$baseWins[0].Handle) { $d.Reason = 'stale-host-window'; return $d }
    if (-not $curWins[0].IsWindow) { $d.Reason = 'stale-host-window-gone'; return $d }
    # host 窗口的类名 / 归属进程也必须与基线、与目标进程一致
    if ([string]$curWins[0].ClassName -ne $script:MmxTrayHostClass) { $d.Reason = 'stale-host-class'; return $d }
    if ([string]$baseWins[0].ClassName -ne $script:MmxTrayHostClass) { $d.Reason = 'stale-host-class'; return $d }
    if ([int]$curWins[0].ProcessId -ne [int]$Current.Process.ProcessId) { $d.Reason = 'stale-host-pid'; return $d }
    if ([int]$baseWins[0].ProcessId -ne [int]$Baseline.Process.ProcessId) { $d.Reason = 'stale-host-pid'; return $d }

    $baseIds = @($Baseline.IconCandidates | Where-Object { $_.Valid })
    $curIds = @($Current.IconCandidates | Where-Object { $_.Valid })
    if ($baseIds.Count -ne 1) { $d.Reason = 'stale-baseline-icon-id'; return $d }
    if ($curIds.Count -ne 1) { $d.Reason = 'stale-icon-id'; return $d }
    if ([int]$curIds[0].Id -ne [int]$baseIds[0].Id) { $d.Reason = 'stale-icon-id'; return $d }
    if ($curIds[0].Left -ne $baseIds[0].Left -or $curIds[0].Top -ne $baseIds[0].Top -or
        $curIds[0].Right -ne $baseIds[0].Right -or $curIds[0].Bottom -ne $baseIds[0].Bottom) {
        $d.Reason = 'stale-rect'; return $d
    }

    $d.Ok = $true
    $d.Reason = 'ok'
    return $d
}

function Invoke-MmxTrayIconTask {
    # 主流程。默认只探测；-Apply / -Restore 才走到写 API。
    param(
        [int]$TargetProcessId = 0,
        [string]$ExpectedExecutable = '',
        [string]$IconPath = '',
        [switch]$Apply,
        [int]$WaitSeconds = 0,
        [scriptblock]$StateProvider
    )
    $ErrorActionPreference = 'Stop'

    $result = [ordered]@{
        ok                 = $false
        mode               = 'probe'
        applied            = $false
        reason             = $null
        targetProcessId    = $TargetProcessId
        expectedExecutable = $ExpectedExecutable
        actualExecutable   = $null
        commandLine        = $null
        processCreatedUtc  = $null
        hostWindow         = $null
        hostClassName      = $null
        iconId             = $null
        iconRect           = $null
        iconPath           = $null
        nativeWriteCalls   = $script:MmxTrayNativeWriteCount
    }

    if ($TargetProcessId -le 0) { $result.reason = 'invalid-target-pid'; return [pscustomobject]$result }
    if ([string]::IsNullOrWhiteSpace($ExpectedExecutable)) { $result.reason = 'invalid-expected-executable'; return [pscustomobject]$result }
    if ($WaitSeconds -lt 0 -or $WaitSeconds -gt 30) { $result.reason = 'invalid-wait-seconds'; return [pscustomobject]$result }
    if ([IntPtr]::Size -ne 8) { $result.reason = 'unsupported-architecture'; return [pscustomobject]$result }

    try { Add-MmxTrayNative | Out-Null } catch {
        $result.reason = 'native-load-failed'
        return [pscustomobject]$result
    }

    if (-not $StateProvider) {
        $StateProvider = { param($id) Get-MmxTrayState -ProcessId $id }
    }

    # 等待目标出现（托盘窗口 / 图标 ID 可能晚于进程起来）
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $state = $null
    $decision = $null
    while ($true) {
        $state = & $StateProvider $TargetProcessId
        $decision = Test-MmxTrayTarget -State $state -ExpectedExecutable $ExpectedExecutable
        if ($decision.Ok) { break }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Milliseconds 250
    }

    if ($state -and $state.Process) {
        $result.actualExecutable = $state.Process.ExePath
        $result.commandLine = $state.Process.CommandLine
        $result.processCreatedUtc = $state.Process.CreatedUtc
    }
    if (-not $decision.Ok) {
        $result.reason = $decision.Reason
        $result.nativeWriteCalls = $script:MmxTrayNativeWriteCount
        return [pscustomobject]$result
    }

    $result.hostWindow = [long]$decision.HostWindow.Handle
    $result.hostClassName = $decision.HostWindow.ClassName
    $result.iconId = [int]$decision.IconId
    $result.iconRect = @{
        left = [int]$decision.Rect.Left; top = [int]$decision.Rect.Top
        right = [int]$decision.Rect.Right; bottom = [int]$decision.Rect.Bottom
        width = [int]$decision.Rect.Width; height = [int]$decision.Rect.Height
    }

    if (-not $Apply) {
        $result.ok = $true
        $result.reason = 'ok'
        $result.nativeWriteCalls = $script:MmxTrayNativeWriteCount
        return [pscustomobject]$result
    }

    # 写之前二次核对：PID 复用 / 窗口被换 / 矩形变了 -> 全部拒绝
    $state2 = & $StateProvider $TargetProcessId
    $fresh = Compare-MmxTrayState -Baseline $state -Current $state2 -ExpectedProcessId $TargetProcessId
    if (-not $fresh.Ok) {
        $result.reason = $fresh.Reason
        $result.nativeWriteCalls = $script:MmxTrayNativeWriteCount
        return [pscustomobject]$result
    }

    if ($Apply) {
        $result.mode = 'apply'
        $iconFull = $null
        try { $iconFull = [System.IO.Path]::GetFullPath($IconPath) } catch { }
        if (-not $iconFull -or -not (Test-Path -LiteralPath $iconFull -PathType Leaf)) {
            $result.reason = 'icon-file-missing'
            $result.nativeWriteCalls = $script:MmxTrayNativeWriteCount
            return [pscustomobject]$result
        }
        $result.iconPath = $iconFull

        $hIcon = [IntPtr]::Zero
        $buf = [IntPtr]::Zero
        $failReason = $null
        try {
            $script:MmxTrayNativeWriteCount = $script:MmxTrayNativeWriteCount + 1
            # IMAGE_ICON(1) + LR_LOADFROMFILE(0x10)
            $hIcon = [MmxTrayNative]::LoadImageW([IntPtr]::Zero, $iconFull, 1, 0, 0, 16)
            if ($hIcon -eq [IntPtr]::Zero) {
                $failReason = 'icon-load-failed'
            } else {
                $buf = New-MmxTrayDataBuffer -Window $decision.HostWindow.Handle -IconId $decision.IconId -Icon $hIcon
                $script:MmxTrayNativeWriteCount = $script:MmxTrayNativeWriteCount + 1
                # NIM_MODIFY(1) + uFlags=NIF_ICON(2)：不 NIM_ADD / NIM_DELETE，不动 tooltip
                if (-not [MmxTrayNative]::Shell_NotifyIconW(1, $buf)) {
                    $failReason = 'shell-notifyicon-failed'
                }
            }
        } finally {
            if ($buf -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
            if ($hIcon -ne [IntPtr]::Zero) { [void][MmxTrayNative]::DestroyIcon($hIcon) }
        }
        # 写调用次数必须如实上报：失败路径也调用过原生 API，不能停在 0。
        $result.nativeWriteCalls = $script:MmxTrayNativeWriteCount
        if ($failReason) {
            $result.reason = $failReason
            $result.ok = $false
            $result.applied = $false
            return [pscustomobject]$result
        }
        $result.applied = $true
        $result.ok = $true
        $result.reason = 'ok'
        return [pscustomobject]$result
    }

    return [pscustomobject]$result
}

# ---------------------------------------------------------------------------
# main（dot-source 时不跑，测试要用里面的函数）
# ---------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
    $out = Invoke-MmxTrayIconTask -TargetProcessId $TargetProcessId -ExpectedExecutable $ExpectedExecutable `
        -IconPath $IconPath -Apply:$Apply -WaitSeconds $WaitSeconds
    # 独立命令行运行时把 JSON 打到 stdout；被 & 调用时只把对象交给调用方。
    # 脚本内没有 exit：退出码恒为 0，成功与否看 $out.ok / $out.applied。
    if ((Get-PSCallStack).Count -le 1) {
        Write-Host ($out | ConvertTo-Json -Depth 6)
    }
    $out
}
