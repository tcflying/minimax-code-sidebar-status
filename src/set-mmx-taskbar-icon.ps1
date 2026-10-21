<#
.SYNOPSIS
  MiniMax Code 主窗口「任务栏按钮」图标换红圆（默认只读探测；只有 -Apply 才写）。

.DESCRIPTION
  机制依据（微软原文，不猜）：
    - WM_SETICON（0x0080）给窗口挂 ICON_BIG(1) / ICON_SMALL(0)。
      https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-seticon
      原文：返回值是「上一个图标句柄」，窗口本来没图标时就是 NULL ——
      所以返回 0 不是失败标志，不能拿返回值当成功证据。
    - WM_GETICON（0x007F）读回窗口当前图标句柄，这才是「已生效」的证据。
      https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-geticon
      原文：没显式设过图标的窗口会走窗口类图标，此时 WM_GETICON 返回 0。
      （实测 MiniMax 主窗 ICON_SMALL/BIG/SMALL2 全 0，类图标有值。）
    - LoadImageW：文件图标不能带 LR_SHARED，且非共享资源随创建进程退出被系统销毁。
      https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-loadimagew
      原文：「Do not use LR_SHARED for … images that are loaded from a file.」
      「The system automatically deletes these resources when the process that
      created them terminates.」
      -> 所以 HICON 必须由一个常驻进程一直持有到目标进程结束，不能设完就退出。

  身份门禁（fail closed，任何一条不成立就只读不写）：
    - EXE 规范完整路径必须与目标一致；
    - 命令行拿不到 = 身份不明 -> 拒写；
    - 同 EXE 的辅助子进程（--type= / --eval / --input-type= / --run-as-node /
      --inspect / host-runner.js 之类的 node runtime）-> 拒写；
    - 主窗口必须是「全系统唯一」满足下列全部条件的顶级窗口：
      class 精确 == Chrome_WidgetWin_1、title 精确 == 'MiniMax Code'、
      owner == 0、visible == true、非 WS_EX_TOOLWINDOW(0x80)。
      （同进程里那个 offscreen 的 'Mavis Browser Background Render Host 1'
      背景窗因此被排除；也不用 Get-Process.MainWindowHandle —— 它会误选
      无标题的临时 tool 窗口；也不用矩形排除 —— 最小化/多屏都不成立。）

  写一次就够：不轮询重设，官方自己换回原图时不跟它抢。
  退出行为：
    - 目标进程退出 / 主窗口销毁或被替换 -> 释放 HICON，keeper 退出（fail closed）；
    - 收到停止指令 -> 先在「窗口仍引用我们的 handle」时恢复原值，再释放；
    - 读回/恢复超时 -> 证明不了窗口是否还引用我们的 HICON，就不销毁也不退出，
      继续持有到目标真的消失，并如实报 failure/retaining。

  安全边界：
    - 默认不带 -Apply 时只读：枚举窗口 + 读图标句柄，一个写 API 都不调；
    - 不写 AppUserModel.ID / Relaunch* 属性，不碰窗口类图标，不动注册表、
      快捷方式、官方 exe/asar/资源；不新建任务栏按钮，不造新分组；
    - 不读写别的进程内存，不注入模块，不动 CDP 页面；
    - 不销毁读到的旧官方 HICON（不是我们的资源）。

  退出码：脚本内没有 exit，退出码恒为 0。成功与否看返回对象的 ok/status 字段。

.EXAMPLE
  只探测（不写任何东西）：
    powershell -NoProfile -File .\set-mmx-taskbar-icon.ps1 -TargetProcessId 1234 -ExpectedExecutable "D:\MiniMax\MiniMax Code\MiniMax Code.exe"

.EXAMPLE
  真正换图并一直持有（父会话审查后才允许对真实应用执行）：
    powershell -NoProfile -WindowStyle Hidden -File .\set-mmx-taskbar-icon.ps1 -TargetProcessId 1234 -ExpectedExecutable "D:\MiniMax\MiniMax Code\MiniMax Code.exe" -Apply
#>
[CmdletBinding()]
param(
  # 目标主进程 PID（正整数）。刻意不写 Mandatory：本文件会被测试 dot-source。
  [int]$TargetProcessId = 0,
  # 目标 EXE 的精确完整路径（必须与进程实际 EXE 规范路径完全一致）。
  [string]$ExpectedExecutable = '',
  # 待写入的 ICO（复用托盘那一份红圆，不新增图标资产）。
  # 默认值留空：PS 5.1 用 -File 跑脚本时，param 绑定阶段 $PSScriptRoot 还是空的，
  # 在默认值里 Split-Path 会直接把脚本打死。正文里再解析（那时 $PSScriptRoot 已有值）。
  [string]$IconPath = '',
  # 主窗口类名 / 标题（默认值 = 实测 MiniMax Code 主窗；测试用 fixture 覆盖）。
  [string]$MainWindowClass = 'Chrome_WidgetWin_1',
  [string]$MainWindowTitle = 'MiniMax Code',
  # 显式开关：真正下发 WM_SETICON 并一直持有 HICON 到目标进程结束。
  [switch]$Apply,
  # 显式开关：请求已在跑的 keeper 恢复原图并退出。
  [switch]$Stop,
  # 等目标出现（主窗口可能晚于进程起来）。上限 30 秒，默认 0。
  [int]$WaitSeconds = 0,
  # keeper 状态/结果目录（JSON + 日志）。默认 <repo>\logs\taskbar-icon。
  [string]$StateDir = '',
  # 单次运行的唯一标记（launcher 传入，避免互相覆盖状态文件）。
  [string]$RunToken = '',
  # 测试注入用：替换「取状态」的实现（假快照，不碰真实窗口）。
  [scriptblock]$StateProvider
)

# ---------------------------------------------------------------------------
# 原生层
# ---------------------------------------------------------------------------
$script:MmxTaskbarNativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MmxTaskbarNative
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int iIndex);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadImageW(IntPtr hInst, string name, uint type, int cx, int cy, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetSystemMetricsForDpi(int index, uint dpi);
}
'@

# 原生写调用计数（自检用来证明 probe 路径一个写调用都没有）
$script:MmxTaskbarNativeWriteCount = 0

# 测试注入用：name -> scriptblock。命中就走假实现（不碰真实窗口）。
$script:MmxTaskbarNativeOverride = @{}

# fail-closed 开关（测试用）：打开后，任何「没有假实现打桩」的原生调用直接抛错，
# 绝不静默回退到真实 API。2026-10-22 事故的根因就是：桩被清空 -> 回退真实 API
# -> 真 WM_SETICON 打到了用户正在用的 MiniMax 主窗。
$script:MmxTaskbarNativeStrict = $false

function Set-MmxTaskbarNativeStrict {
  param([bool]$Enabled = $true)
  $script:MmxTaskbarNativeStrict = $Enabled
  return $script:MmxTaskbarNativeStrict
}

# 辅助子进程命令行特征：主进程没有这些，renderer/gpu/eval/node runtime 有。
$script:MmxTaskbarHelperPatterns = @(
  '--type=',
  '--eval',
  '--input-type=',
  '--run-as-node',
  '--inspect-brk',
  '--inspect',
  'host-runner.js'
)

# WS_EX_TOOLWINDOW
$script:MmxTaskbarWsExToolWindow = 0x80

# 编译临时目录：Add-Type 会往 Path.GetTempPath()（%TEMP%，PS 5.1 下通常在 C 盘）
# 扔临时文件。编译期间只把本进程 TEMP/TMP 指到项目 logs 下的 D 盘子目录，
# 编译完立刻恢复（不动系统 / 用户级设置）。
if ($PSScriptRoot) { $script:MmxTaskbarProjectRoot = Split-Path -Parent $PSScriptRoot }
else { $script:MmxTaskbarProjectRoot = (Get-Location).Path }
$script:MmxTaskbarCompileTemp = Join-Path $script:MmxTaskbarProjectRoot 'logs\taskbar-compile-tmp'

# 默认 ICO 在正文里解析（param 阶段 $PSScriptRoot 不可用，见上面的说明）。
if (-not $IconPath) { $IconPath = (Join-Path $script:MmxTaskbarProjectRoot 'assets\mmx-red-circle.ico') }

function Invoke-MmxTaskbarWithCompileTemp {
  param([scriptblock]$Block)
  $oldTemp = $env:TEMP
  $oldTmp = $env:TMP
  $dir = $script:MmxTaskbarCompileTemp
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

function Add-MmxTaskbarNative {
  if ('MmxTaskbarNative' -as [type]) { return $true }
  try {
    Invoke-MmxTaskbarWithCompileTemp { Add-Type -TypeDefinition $script:MmxTaskbarNativeSource -ErrorAction Stop } | Out-Null
    return $true
  } catch {
    throw ("加载原生声明失败：" + $_.Exception.Message)
  }
}

# ---------------------------------------------------------------------------
# 原生调用统一入口（测试从这里注入假实现）
# ---------------------------------------------------------------------------
function Invoke-MmxTaskbarNative {
  # 统一出口：GetIcon / SetIcon 返回 @{Delivered;Handle} / @{Delivered;Old}，
  # Delivered=false 表示消息超时（读不到 / 不知道有没有生效）。
  param([string]$Name, [object[]]$NativeArgs = @())
  if ($script:MmxTaskbarNativeOverride.ContainsKey($Name)) {
    return (& $script:MmxTaskbarNativeOverride[$Name] @NativeArgs)
  }
  if ($script:MmxTaskbarNativeStrict) {
    # fail-closed：桩没打到的调用直接失败，绝不回退真实 API。
    # 2026-10-22 事故根因：桩被清空 -> 静默回退 -> 真 WM_SETICON 打到真窗口。
    throw ("原生调用没有假实现，fail-closed 拒绝回退真实 API：" + $Name)
  }
  switch ($Name) {
    'GetIcon' {
      $res = [IntPtr]::Zero
      $ok = [MmxTaskbarNative]::SendMessageTimeoutW($NativeArgs[0], 0x007F, [IntPtr][int]$NativeArgs[1], [IntPtr]::Zero, 2, 1000, [ref]$res)
      return @{ Delivered = [bool]$ok; Handle = $res }
    }
    'WindowOwner' {
      $owner = [uint32]0
      [void][MmxTaskbarNative]::GetWindowThreadProcessId($NativeArgs[0], [ref]$owner)
      return [int]$owner
    }
    'WindowClass' {
      $cls = New-Object System.Text.StringBuilder 256
      [void][MmxTaskbarNative]::GetClassNameW($NativeArgs[0], $cls, 256)
      return [string]$cls.ToString()
    }
    'SetIcon' {
      $script:MmxTaskbarNativeWriteCount = $script:MmxTaskbarNativeWriteCount + 1
      $res = [IntPtr]::Zero
      $ok = [MmxTaskbarNative]::SendMessageTimeoutW($NativeArgs[0], 0x0080, [IntPtr][int]$NativeArgs[1], [IntPtr]$NativeArgs[2], 2, 3000, [ref]$res)
      return @{ Delivered = [bool]$ok; Old = $res }
    }
    'LoadIcon' {
      $script:MmxTaskbarNativeWriteCount = $script:MmxTaskbarNativeWriteCount + 1
      # IMAGE_ICON(1) + LR_LOADFROMFILE(0x10)。不加 LR_SHARED（文件图标不允许）。
      return [MmxTaskbarNative]::LoadImageW([IntPtr]::Zero, [string]$NativeArgs[0], 1, [int]$NativeArgs[1], [int]$NativeArgs[1], 16)
    }
    'DestroyIcon' {
      $script:MmxTaskbarNativeWriteCount = $script:MmxTaskbarNativeWriteCount + 1
      return [bool][MmxTaskbarNative]::DestroyIcon($NativeArgs[0])
    }
    'IsWindow' {
      return [bool][MmxTaskbarNative]::IsWindow($NativeArgs[0])
    }
    'IconSizes' {
      $dpi = [uint32][MmxTaskbarNative]::GetDpiForWindow($NativeArgs[0])
      if ($dpi -eq 0) { $dpi = 96 }
      $big = [MmxTaskbarNative]::GetSystemMetricsForDpi(11, $dpi)   # SM_CXICON
      $small = [MmxTaskbarNative]::GetSystemMetricsForDpi(49, $dpi) # SM_CXSMICON
      if ($big -le 0) { $big = 32 }
      if ($small -le 0) { $small = 16 }
      return @{ Dpi = $dpi; Big = [int]$big; Small = [int]$small }
    }
    default { throw ("未知的原生调用：" + $Name) }
  }
}

# ---------------------------------------------------------------------------
# 状态快照（只读）
# ---------------------------------------------------------------------------
function Get-MmxTaskbarProcessState {
  # 只读：进程快照（EXE 规范路径 / 命令行 / 创建时间基线）。
  param([int]$ProcessId, [scriptblock]$CommandLineProvider)
  $res = @{ Ok = $false; Reason = $null; ProcessId = $ProcessId; ExePath = $null; CommandLine = $null; CreationTicks = 0; CreatedUtc = $null }
  if ($ProcessId -le 0) { $res.Reason = 'invalid-target-pid'; return $res }

  $proc = $null
  try { $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue } catch { $proc = $null }
  if (-not $proc) { $res.Reason = 'process-not-found'; return $res }

  $exe = $null
  try { if ($proc.MainModule) { $exe = $proc.MainModule.FileName } } catch { $exe = $null }

  $cmd = $null
  try {
    if (-not $CommandLineProvider) {
      $CommandLineProvider = { param($id) Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f $id) -ErrorAction Stop }
    }
    $cim = & $CommandLineProvider $ProcessId
    if ($cim) {
      if (-not $exe) { $exe = $cim.ExecutablePath }
      $cmd = [string]$cim.CommandLine
    }
  } catch { }

  if (-not $exe) { $res.Reason = 'executable-path-unavailable'; return $res }
  try { $exe = [System.IO.Path]::GetFullPath($exe) } catch { }
  $res.ExePath = $exe
  $res.CommandLine = $cmd

  # 命令行拿不到 = 身份不明（分不出主进程 / 辅助子进程）-> fail closed。
  if ([string]::IsNullOrWhiteSpace($cmd)) { $res.Reason = 'commandline-unavailable'; return $res }

  # 进程创建时间基线：写前复检 + keeper 存活判定都用它挡 PID 复用。
  try { $res.CreationTicks = $proc.StartTime.ToUniversalTime().Ticks } catch { }
  if ($res.CreationTicks -le 0) { $res.Reason = 'creation-time-unavailable'; return $res }
  $res.CreatedUtc = (New-Object DateTime($res.CreationTicks, [System.DateTimeKind]::Utc)).ToString('o')
  $res.Ok = $true
  $res.Reason = 'ok'
  return $res
}

function Get-MmxTaskbarWindows {
  # 只读：一次 EnumWindows 全扫，收集所有顶级窗口的 class/title/可见性/owner/exStyle。
  $found = New-Object System.Collections.ArrayList
  $callback = [MmxTaskbarNative+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $owner = [uint32]0
    [void][MmxTaskbarNative]::GetWindowThreadProcessId($hWnd, [ref]$owner)
    $cls = New-Object System.Text.StringBuilder 256
    [void][MmxTaskbarNative]::GetClassNameW($hWnd, $cls, 256)
    $txt = New-Object System.Text.StringBuilder 512
    [void][MmxTaskbarNative]::GetWindowTextW($hWnd, $txt, 512)
    [void]$found.Add(@{
      Handle    = $hWnd
      ClassName = $cls.ToString()
      Title     = $txt.ToString()
      ProcessId = [int]$owner
      Visible   = [MmxTaskbarNative]::IsWindowVisible($hWnd)
      Owner     = [long][MmxTaskbarNative]::GetWindow($hWnd, 4)   # GW_OWNER
      ExStyle   = [long][MmxTaskbarNative]::GetWindowLongPtr($hWnd, -20).ToInt64()  # GWL_EXSTYLE
    })
    return $true
  }
  [void][MmxTaskbarNative]::EnumWindows($callback, [IntPtr]::Zero)
  return $found.ToArray()
}

function Get-MmxTaskbarState {
  # 只读快照：进程 + 窗口列表。
  param([int]$ProcessId, [scriptblock]$CommandLineProvider)
  $state = @{ Process = $null; Windows = @() }
  $state.Process = Get-MmxTaskbarProcessState -ProcessId $ProcessId -CommandLineProvider $CommandLineProvider
  if (-not $state.Process.Ok) { return $state }
  $state.Windows = @(Get-MmxTaskbarWindows)
  return $state
}

function Test-MmxTaskbarHelperProcess {
  # 主进程 vs 辅助子进程：不能只看 EXE 名，renderer/gpu/eval/node runtime 都是同一个 EXE。
  param([string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  foreach ($pat in $script:MmxTaskbarHelperPatterns) {
    if ($CommandLine -match [regex]::Escape($pat)) { return $true }
  }
  return $false
}

function Get-MmxTaskbarMainWindows {
  # 主窗口过滤：class / title / 可见 / owner==0 / 非 tool 窗口。
  # 单独抽出来，门禁和写前复核必须用同一套条件（否则复核会把
  # 「同进程里还有背景 host 窗口」误当成主窗口被换掉）。
  param($Windows, [string]$ExpectedClass, [string]$ExpectedTitle)
  $out = @()
  foreach ($w in @($Windows)) {
    if ([string]$w.ClassName -ne $ExpectedClass) { continue }
    if ([string]$w.Title -ne $ExpectedTitle) { continue }
    if (-not $w.Visible) { continue }
    if ([long]$w.Owner -ne 0) { continue }
    if (([long]$w.ExStyle -band $script:MmxTaskbarWsExToolWindow) -ne 0) { continue }
    $out += $w
  }
  return $out
}

function Test-MmxTaskbarTarget {
  # 纯门禁（无副作用）：所有条件满足才 Ok。
  param($State, [string]$ExpectedExecutable, [string]$ExpectedClass, [string]$ExpectedTitle)
  $d = @{ Ok = $false; Reason = $null; Window = $null }

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
  if (Test-MmxTaskbarHelperProcess -CommandLine $proc.CommandLine) { $d.Reason = 'helper-process'; return $d }

  # 4) 主窗口：全系统唯一
  $wins = @(Get-MmxTaskbarMainWindows -Windows $State.Windows -ExpectedClass $ExpectedClass -ExpectedTitle $ExpectedTitle)
  if ($wins.Count -eq 0) { $d.Reason = 'no-main-window'; return $d }
  if ($wins.Count -gt 1) { $d.Reason = 'multiple-main-windows'; return $d }
  $win = $wins[0]
  if ([int]$win.ProcessId -ne [int]$proc.ProcessId) { $d.Reason = 'main-window-foreign-pid'; return $d }

  $d.Ok = $true
  $d.Reason = 'ok'
  $d.Window = $win
  return $d
}

function Compare-MmxTaskbarState {
  # 纯门禁（无副作用）：写前二次核对，防 stale / PID 复用 / 窗口被换。
  # 用和门禁同一套主窗口过滤条件，只比对「那一个」主窗口 ——
  # 不能拿全窗口列表的个数当判据（同进程里还有背景 host 窗口是常态）。
  param($Baseline, $Current, [int]$ExpectedProcessId = 0, [string]$ExpectedClass = 'Chrome_WidgetWin_1', [string]$ExpectedTitle = 'MiniMax Code')
  $d = @{ Ok = $false; Reason = $null }
  if (-not $Current -or -not $Current.Process -or -not $Current.Process.Ok) { $d.Reason = 'stale-process-gone'; return $d }
  if (-not $Baseline -or -not $Baseline.Process) { $d.Reason = 'stale-baseline-missing'; return $d }

  if ([long]$Current.Process.CreationTicks -ne [long]$Baseline.Process.CreationTicks) { $d.Reason = 'stale-creation-time'; return $d }
  if (-not [string]::Equals([string]$Current.Process.ExePath, [string]$Baseline.Process.ExePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    $d.Reason = 'stale-executable'; return $d
  }
  if ([int]$Current.Process.ProcessId -ne [int]$Baseline.Process.ProcessId) { $d.Reason = 'stale-process-id'; return $d }
  if ($ExpectedProcessId -gt 0 -and [int]$Current.Process.ProcessId -ne $ExpectedProcessId) { $d.Reason = 'stale-process-id'; return $d }
  if ([string]::IsNullOrWhiteSpace([string]$Current.Process.CommandLine)) { $d.Reason = 'commandline-unavailable'; return $d }

  $bw = @(Get-MmxTaskbarMainWindows -Windows $Baseline.Windows -ExpectedClass $ExpectedClass -ExpectedTitle $ExpectedTitle)
  $cw = @(Get-MmxTaskbarMainWindows -Windows $Current.Windows -ExpectedClass $ExpectedClass -ExpectedTitle $ExpectedTitle)
  if ($bw.Count -ne 1) { $d.Reason = 'stale-baseline-missing'; return $d }
  if ($cw.Count -ne 1) { $d.Reason = 'stale-main-window-count'; return $d }
  if ([long]$cw[0].Handle -ne [long]$bw[0].Handle) { $d.Reason = 'stale-main-window'; return $d }
  if ([string]$cw[0].ClassName -ne [string]$bw[0].ClassName) { $d.Reason = 'stale-main-window-class'; return $d }
  if ([int]$cw[0].ProcessId -ne [int]$Current.Process.ProcessId) { $d.Reason = 'stale-main-window-pid'; return $d }

  $d.Ok = $true
  $d.Reason = 'ok'
  return $d
}

# ---------------------------------------------------------------------------
# 写图标
# ---------------------------------------------------------------------------
function Invoke-MmxTaskbarSetIcon {
  # 设一次 + 读回。返回里 Handle 是我们的 HICON（要一直持有）。
  # $Hold 是调用方传进来的把手：函数把 BigHandle/SmallHandle/OrigBig/OrigSmall
  # 写进去 —— 万一函数中途抛异常，调用方仍然知道要持有哪些 HICON。
  param([IntPtr]$Window, [string]$IconPath, $Sizes, $Hold)
  $r = @{
    Ok = $false; Applied = $false; Retain = $false; Reason = $null
    BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero
    OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero
    BigDelivered = $false; SmallDelivered = $false
  }

  $iconFull = $null
  try { $iconFull = [System.IO.Path]::GetFullPath($IconPath) } catch { }
  if (-not $iconFull -or -not (Test-Path -LiteralPath $iconFull -PathType Leaf)) {
    $r.Reason = 'icon-file-missing'; return $r
  }
  $r.IconPath = $iconFull

  # 先读旧值（只读）。旧 HICON 不是我们的资源，绝不销毁。
  # 读不出来（超时）= 不知道原值长什么样 -> 干脆别写：连恢复都无从谈起，
  # 写完再猜更危险。这一步失败时一个写调用都不该发生。
  $ob = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 1)
  $os = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 0)
  if (-not $ob.Delivered -or -not $os.Delivered) {
    $r.Reason = 'old-icon-unreadable'; return $r
  }
  $r.OrigBig = $ob.Handle
  $r.OrigSmall = $os.Handle

  $hBig = Invoke-MmxTaskbarNative -Name 'LoadIcon' -NativeArgs @($iconFull, [int]$Sizes.Big)
  if ($hBig -eq [IntPtr]::Zero) { $r.Reason = 'icon-load-failed'; return $r }
  $r.BigHandle = $hBig
  if ($Hold) { $Hold.BigHandle = $hBig; $Hold.OrigBig = $r.OrigBig }
  $hSmall = Invoke-MmxTaskbarNative -Name 'LoadIcon' -NativeArgs @($iconFull, [int]$Sizes.Small)
  if ($hSmall -eq [IntPtr]::Zero) {
    # 没交给窗口过，销毁是安全的。
    [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hBig))
    $r.BigHandle = [IntPtr]::Zero
    if ($Hold) { $Hold.BigHandle = [IntPtr]::Zero }
    $r.Reason = 'icon-load-failed'; return $r
  }
  $r.SmallHandle = $hSmall
  if ($Hold) { $Hold.SmallHandle = $hSmall; $Hold.OrigSmall = $r.OrigSmall }

  # 只发一次，不轮询重设。返回值是旧图标句柄（0 也合法），不拿它当成功证据。
  # 发送前先把 RestoreKnown 置 false：SetIcon 抛异常时绝不能拿预读快照当「原值」去恢复
  # （2026-10-22 review R2：抛异常后 RestoreKnown 还是 true，Stop 会把没证明过的值写回去）。
  $restoreKnown = $false
  if ($Hold) { $Hold.RestoreKnown = $false; $Hold.SetAttempted = $true }
  $sb = Invoke-MmxTaskbarNative -Name 'SetIcon' -NativeArgs @($Window, 1, $hBig)
  $ss = Invoke-MmxTaskbarNative -Name 'SetIcon' -NativeArgs @($Window, 0, $hSmall)
  $r.BigDelivered = [bool]$sb.Delivered
  $r.SmallDelivered = [bool]$ss.Delivered

  # WM_SETICON 返回的 Old 才是「这一次真正替换掉的图标」——比预读快照准：
  # 预读和应用自己更新图标之间可能插了官方的一次替换。
  # 消息没送达（超时）就拿不到真正的 Old，这时不能自称「可以安全恢复」。
  $restoreKnown = $true
  if ($sb.Delivered) { $r.OrigBig = $sb.Old } else { $restoreKnown = $false }
  if ($ss.Delivered) { $r.OrigSmall = $ss.Old } else { $restoreKnown = $false }
  $r.RestoreKnown = $restoreKnown
  if ($Hold) {
    $Hold.RestoreKnown = $restoreKnown
    $Hold.OrigBig = $r.OrigBig
    $Hold.OrigSmall = $r.OrigSmall
  }

  # 读回才是「已生效」的证据。
  $rb = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 1)
  $rs = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 0)
  $bigOk = ($rb.Delivered -and $rb.Handle -eq $hBig)
  $smallOk = ($rs.Delivered -and $rs.Handle -eq $hSmall)

  if ($bigOk -and $smallOk) {
    $r.Ok = $true
    $r.Applied = $true
    $r.Reason = 'ok'
    return $r
  }

  # 没全部生效：保守恢复 —— 只在窗口仍引用我们的 handle、且知道原值时才恢复。
  if ($bigOk -and $restoreKnown) { [void](Invoke-MmxTaskbarNative -Name 'SetIcon' -NativeArgs @($Window, 1, $r.OrigBig)) }
  if ($smallOk -and $restoreKnown) { [void](Invoke-MmxTaskbarNative -Name 'SetIcon' -NativeArgs @($Window, 0, $r.OrigSmall)) }

  # 再读回确认窗口不再引用我们的 HICON；读不到（超时）就证明不了 -> 只能继续持有。
  $vb = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 1)
  $vs = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 0)
  if (-not $vb.Delivered -or -not $vs.Delivered) {
    $r.Retain = $true
    $r.Reason = 'icon-readback-unknown'
    return $r
  }
  $stillBig = ($vb.Handle -eq $hBig)
  $stillSmall = ($vs.Handle -eq $hSmall)
  if ($stillBig -or $stillSmall) {
    $r.Retain = $true
    $r.Reason = if ($restoreKnown) { 'icon-readback-mismatch' } else { 'restore-value-unknown' }
    return $r
  }
  [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hBig))
  [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hSmall))
  $r.BigHandle = [IntPtr]::Zero
  $r.SmallHandle = [IntPtr]::Zero
  if ($Hold) { $Hold.BigHandle = [IntPtr]::Zero; $Hold.SmallHandle = [IntPtr]::Zero }
  $r.Reason = 'icon-readback-mismatch'
  return $r
}

function Restore-MmxTaskbarIcon {
  # 优雅退出：只在窗口仍引用我们的 handle 时恢复原值；证明不了就不恢复也不销毁。
  # RestoreKnown=false = 没拿到「被替换掉的原图标」真值（WM_SETICON 没送达），
  # 这时不能自称恢复得回去，只能继续持有。
  param([IntPtr]$Window, [IntPtr]$BigHandle, [IntPtr]$SmallHandle, [IntPtr]$OrigBig, [IntPtr]$OrigSmall, [bool]$RestoreKnown = $true)
  $out = @{ Retain = $false; Restored = $false; Reason = 'ok' }

  if (-not $RestoreKnown) {
    $out.Retain = $true
    $out.Reason = 'restore-value-unknown'
    return $out
  }

  $rb = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 1)
  if (-not $rb.Delivered) { $out.Retain = $true; $out.Reason = 'readback-timeout'; return $out }
  if ($rb.Handle -eq $BigHandle) {
    [void](Invoke-MmxTaskbarNative -Name 'SetIcon' -NativeArgs @($Window, 1, $OrigBig))
    $out.Restored = $true
  }
  $rs = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 0)
  if (-not $rs.Delivered) { $out.Retain = $true; $out.Reason = 'readback-timeout'; return $out }
  if ($rs.Handle -eq $SmallHandle) {
    [void](Invoke-MmxTaskbarNative -Name 'SetIcon' -NativeArgs @($Window, 0, $OrigSmall))
    $out.Restored = $true
  }

  # 确认窗口不再引用我们的 HICON 才允许销毁。
  $vb = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 1)
  $vs = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 0)
  if (-not $vb.Delivered -or -not $vs.Delivered) {
    # 读不回来 = 证明不了窗口还挂不挂我们的图标 -> 不能销毁，只能继续持有。
    $out.Retain = $true
    $out.Reason = 'readback-timeout'
    return $out
  }
  $stillBig = ($vb.Handle -eq $BigHandle)
  $stillSmall = ($vs.Handle -eq $SmallHandle)
  if ($stillBig -or $stillSmall) {
    $out.Retain = $true
    $out.Reason = 'window-still-references-our-icon'
    return $out
  }
  return $out
}

function Remove-MmxTaskbarHeldIcons {
  # 只有「能证明窗口不再引用我们的 HICON」才允许销毁：
  #   - 窗口句柄已经不是窗口（窗口没了），或
  #   - 读回显示窗口已经不挂我们的句柄。
  # 读不回来 / 还挂着我们的句柄 -> 不销毁，继续持有（进程不退出）。
  # 教训：窗口「归属进程变了」不等于窗口没了 —— 那时窗口可能还活着，
  # 销毁 HICON 会让窗口挂一个野句柄（图标变花/消失）。
  param([IntPtr]$Window, [IntPtr]$BigHandle, [IntPtr]$SmallHandle)
  $out = @{ Retain = $false; Destroyed = $false; Reason = 'ok' }

  $isWindow = $false
  try { $isWindow = [bool](Invoke-MmxTaskbarNative -Name 'IsWindow' -NativeArgs @($Window)) }
  catch { $out.Retain = $true; $out.Reason = 'iswindow-unknown'; return $out }
  if (-not $isWindow) {
    if ($BigHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($BigHandle)) }
    if ($SmallHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($SmallHandle)) }
    $out.Destroyed = $true
    return $out
  }

  $rb = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 1)
  $rs = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($Window, 0)
  if (-not $rb.Delivered -or -not $rs.Delivered) {
    $out.Retain = $true
    $out.Reason = 'readback-unknown'
    return $out
  }
  if ($rb.Handle -eq $BigHandle -or $rs.Handle -eq $SmallHandle) {
    $out.Retain = $true
    $out.Reason = 'window-still-references-our-icon'
    return $out
  }
  if ($BigHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($BigHandle)) }
  if ($SmallHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($SmallHandle)) }
  $out.Destroyed = $true
  return $out
}

function Get-MmxTaskbarProcessProbe {
  # 查进程：把「查询失败」和「进程真的没了」分开。
  # 2026-10-22 review R1：以前 Get-Process 抛异常也返回 false（当作目标已退出），
  # keeper 就会在活着的应用上销毁 HICON -> 窗口挂野句柄（就是那起事故的形状）。
  param([int]$ProcessId)
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
  } catch {
    $errId = [string]$_.FullyQualifiedErrorId
    if ($errId -like 'NoProcessFoundForGivenId*') {
      return @{ Known = $true; Exists = $false; Ticks = 0 }
    }
    # 其它错误（权限 / 瞬时故障）= 未知 -> 当作还在，继续持有。
    return @{ Known = $false; Exists = $true; Ticks = 0 }
  }
  $ticks = 0
  try { $ticks = $p.StartTime.ToUniversalTime().Ticks } catch { }
  return @{ Known = $true; Exists = $true; Ticks = $ticks }
}

function Test-MmxTaskbarTargetAlive {
  # 目标还在吗（顺带挡 PID 复用：创建时间必须一致）。
  # 查询失败 = 未知 -> 当「还在」：宁可一直持有，也不能因为读失败就放手让图标失效。
  param([int]$ProcessId, [long]$BaselineTicks)
  $probe = Get-MmxTaskbarProcessProbe -ProcessId $ProcessId
  if (-not $probe.Known) { return $true }
  if (-not $probe.Exists) { return $false }
  if ($probe.Ticks -le 0) { return $true }
  return ($probe.Ticks -eq $BaselineTicks)
}

function Get-MmxTaskbarWindowIdentity {
  # 严格身份：能不能证明「这个句柄还是那个进程的那个类」。
  # 证明不了 = Known=$false -> 任何写/恢复都必须拒绝（句柄可能已被系统回收给别人）。
  param([IntPtr]$Window)
  $id = @{ Known = $false; Exists = $false; ProcessId = 0; ClassName = '' }
  try { if (-not (Invoke-MmxTaskbarNative -Name 'IsWindow' -NativeArgs @($Window))) { return $id } } catch { return $id }
  $id.Exists = $true
  $owner = 0
  try { $owner = [int](Invoke-MmxTaskbarNative -Name 'WindowOwner' -NativeArgs @($Window)) } catch { return $id }
  if ($owner -le 0) { return $id }
  $name = ''
  try { $name = [string](Invoke-MmxTaskbarNative -Name 'WindowClass' -NativeArgs @($Window)) } catch { return $id }
  if ([string]::IsNullOrEmpty($name)) { return $id }
  $id.Known = $true
  $id.ProcessId = $owner
  $id.ClassName = $name
  return $id
}

function Test-MmxTaskbarWindowAlive {
  # 主窗口还在吗（被销毁 / 被换成别的窗口 -> fail closed）。
  # 读不到归属/类名 = 未知 -> 当「还在」（继续持有），不当成已销毁。
  param([IntPtr]$Window, [int]$ProcessId, [string]$ExpectedClass)
  try {
    if (-not (Invoke-MmxTaskbarNative -Name 'IsWindow' -NativeArgs @($Window))) { return $false }
  } catch { return $true }
  $owner = 0
  try { $owner = [int](Invoke-MmxTaskbarNative -Name 'WindowOwner' -NativeArgs @($Window)) } catch { return $true }
  if ($owner -le 0) { return $true }
  if ($owner -ne $ProcessId) { return $false }
  $name = ''
  try { $name = [string](Invoke-MmxTaskbarNative -Name 'WindowClass' -NativeArgs @($Window)) } catch { return $true }
  if ([string]::IsNullOrEmpty($name)) { return $true }
  if ($name -ne $ExpectedClass) { return $false }
  return $true
}

# ---------------------------------------------------------------------------
# keeper 状态文件（结果 JSON + 日志）
# ---------------------------------------------------------------------------
function Get-MmxTaskbarStateDir {
  if ($StateDir) { return $StateDir }
  return (Join-Path $script:MmxTaskbarProjectRoot 'logs\taskbar-icon')
}

function Write-MmxTaskbarStateFile {
  # 原子写：先写 .tmp 再改名（读者只会看到完整 JSON）。
  param([string]$Path, $Data)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null
  }
  $tmp = $Path + '.tmp'
  try {
    $json = $Data | ConvertTo-Json -Depth 5
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8 -ErrorAction Stop
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
  } catch {
    try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
  }
}

function Add-MmxTaskbarKeeperLog {
  param([string]$Path, [string]$Message)
  try {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch { }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
function Invoke-MmxTaskbarIconTask {
  param(
    [int]$TargetProcessId = 0,
    [string]$ExpectedExecutable = '',
    [string]$IconPath = '',
    [string]$MainWindowClass = 'Chrome_WidgetWin_1',
    [string]$MainWindowTitle = 'MiniMax Code',
    [switch]$Apply,
    [switch]$Stop,
    [int]$WaitSeconds = 0,
    [string]$StateDir = '',
    [string]$RunToken = '',
    [scriptblock]$StateProvider
  )
  $ErrorActionPreference = 'Stop'

  if (-not $IconPath) { $IconPath = (Join-Path $script:MmxTaskbarProjectRoot 'assets\mmx-red-circle.ico') }

  $result = [ordered]@{
    ok                = $false
    mode              = 'probe'
    status            = 'probe'
    applied           = $false
    reason            = $null
    targetProcessId   = $TargetProcessId
    expectedExecutable = $ExpectedExecutable
    actualExecutable  = $null
    commandLine       = $null
    processCreatedUtc = $null
    mainWindow        = $null
    mainWindowClass   = $MainWindowClass
    mainWindowTitle   = $MainWindowTitle
    iconPath          = $IconPath
    iconBigSize       = $null
    iconSmallSize     = $null
    currentBigIcon    = $null
    currentSmallIcon  = $null
    nativeWriteCalls  = $script:MmxTaskbarNativeWriteCount
    keeperPid         = $PID
    statePath         = $null
    logPath           = $null
  }

  if ($TargetProcessId -le 0) { $result.reason = 'invalid-target-pid'; return [pscustomobject]$result }
  if ([string]::IsNullOrWhiteSpace($ExpectedExecutable)) { $result.reason = 'invalid-expected-executable'; return [pscustomobject]$result }
  if ($WaitSeconds -lt 0 -or $WaitSeconds -gt 30) { $result.reason = 'invalid-wait-seconds'; return [pscustomobject]$result }
  if ([IntPtr]::Size -ne 8) { $result.reason = 'unsupported-architecture'; return [pscustomobject]$result }

  try { Add-MmxTaskbarNative | Out-Null } catch {
    $result.reason = 'native-load-failed'
    return [pscustomobject]$result
  }

  $stateDirPath = if ($StateDir) { $StateDir } else { (Join-Path $script:MmxTaskbarProjectRoot 'logs\taskbar-icon') }
  $token = if ($RunToken) { $RunToken } else { [guid]::NewGuid().ToString('N') }
  $statePath = Join-Path $stateDirPath ("keeper-{0}-{1}.json" -f $TargetProcessId, $token)
  $logPath = Join-Path $stateDirPath ("keeper-{0}-{1}.log" -f $TargetProcessId, $token)
  $result.statePath = $statePath
  $result.logPath = $logPath

  # ---- 停止模式：让已在跑的 keeper 恢复原图并退出 ----
  if ($Stop) {
    $result.mode = 'stop'
    $found = @(Get-ChildItem -LiteralPath $stateDirPath -Filter ("keeper-{0}-*.json" -f $TargetProcessId) -ErrorAction SilentlyContinue)
    if ($found.Count -eq 0) {
      $result.status = 'no-keeper'
      $result.reason = 'no-keeper'
      $result.ok = $true
      return [pscustomobject]$result
    }
    $stopped = 0
    foreach ($f in $found) {
      try {
        $st = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $st.keeperPid) { continue }
        $flag = $f.FullName + '.stop'
        Set-Content -LiteralPath $flag -Value 'stop' -Encoding ascii -ErrorAction Stop
        $stopped++
      } catch { }
    }
    # 等 keeper 收尾（恢复 + 释放）退出，最多 10 秒。
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
      $alive = $false
      foreach ($f in $found) {
        try {
          $st = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($st.keeperPid -and (Get-Process -Id $st.keeperPid -ErrorAction SilentlyContinue)) { $alive = $true }
        } catch { }
      }
      if (-not $alive) { break }
      Start-Sleep -Milliseconds 250
    }
    $result.status = 'stop-requested'
    $result.reason = 'stop-requested'
    $result.ok = ($stopped -gt 0)
    if ($stopped -eq 0) { $result.reason = 'no-keeper' }
    return [pscustomobject]$result
  }

  if (-not $StateProvider) {
    $StateProvider = { param($id) Get-MmxTaskbarState -ProcessId $id }
  }

  # ---- 只读快照 + 门禁（可等 WaitSeconds）----
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $state = $null
  $decision = $null
  while ($true) {
    $state = & $StateProvider $TargetProcessId
    $decision = Test-MmxTaskbarTarget -State $state -ExpectedExecutable $ExpectedExecutable -ExpectedClass $MainWindowClass -ExpectedTitle $MainWindowTitle
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
    $result.mode = 'probe'
    $result.status = 'failure'
    $result.reason = $decision.Reason
    $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
    Write-MmxTaskbarStateFile -Path $statePath -Data $result
    return [pscustomobject]$result
  }

  $window = [IntPtr]$decision.Window.Handle
  $result.mainWindow = [long]$window
  $result.mode = if ($Apply) { 'apply' } else { 'probe' }

  if (-not $Apply) {
    # 只读：读一下当前图标句柄就收工，一个写调用都不做。
    $curBig = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($window, 1)
    $curSmall = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($window, 0)
    $result.status = 'probe'
    $result.ok = $true
    $result.reason = 'ok'
    $result.currentBigIcon = if ($curBig.Delivered) { [long]$curBig.Handle } else { $null }
    $result.currentSmallIcon = if ($curSmall.Delivered) { [long]$curSmall.Handle } else { $null }
    $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
    return [pscustomobject]$result
  }

  # ---- 写一次：先复核，再设，再读回 ----
  $state2 = $null
  try {
    $state2 = & $StateProvider $TargetProcessId
  } catch {
    $result.status = 'failure'
    $result.reason = 'precheck-failed'
    $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
    Write-MmxTaskbarStateFile -Path $statePath -Data $result
    return [pscustomobject]$result
  }
  $fresh = Compare-MmxTaskbarState -Baseline $state -Current $state2 -ExpectedProcessId $TargetProcessId -ExpectedClass $MainWindowClass -ExpectedTitle $MainWindowTitle
  if (-not $fresh.Ok) {
    $result.status = 'failure'
    $result.reason = $fresh.Reason
    $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
    Write-MmxTaskbarStateFile -Path $statePath -Data $result
    return [pscustomobject]$result
  }

  # 单实例：互斥体按「目标 PID + 创建时间」命名（防 PID 复用 + 防重复启动多份）。
  $mutexName = 'Local\MmxTaskbarIcon-{0}-{1}' -f $TargetProcessId, $state.Process.CreationTicks
  $mutex = New-Object System.Threading.Mutex($false, $mutexName)
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    $result.status = 'already-running'
    $result.reason = 'already-running'
    $result.ok = $true
    $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
    Write-MmxTaskbarStateFile -Path $statePath -Data $result
    return [pscustomobject]$result
  }

  $result.status = 'starting'
  Write-MmxTaskbarStateFile -Path $statePath -Data $result
  Add-MmxTaskbarKeeperLog -Path $logPath -Message ("keeper pid={0} target={1} hwnd={2} 开始" -f $PID, $TargetProcessId, [long]$window)

  # 我们的 HICON 把手：函数中途抛异常也要知道该持有哪些。
  $hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero; RestoreKnown = $true; SetAttempted = $false }
  $set = $null
  try {
    $sizes = Invoke-MmxTaskbarNative -Name 'IconSizes' -NativeArgs @($window)
    $result.iconBigSize = [int]$sizes.Big
    $result.iconSmallSize = [int]$sizes.Small
    $set = Invoke-MmxTaskbarSetIcon -Window $window -IconPath $IconPath -Sizes $sizes -Hold $hold
  } catch {
    # Set 之后任何异常都不能让进程带着活着的 HICON 直接死掉：
    # 进程一退，图标资源被系统销毁，窗口上就挂了个野指针。
    # 但如果压根没把 HICON 交给过窗口（SetAttempted=false），销毁就是安全的。
    if ($hold.BigHandle -ne [IntPtr]::Zero -or $hold.SmallHandle -ne [IntPtr]::Zero) {
      if (-not [bool]$hold.SetAttempted) {
        if ($hold.BigHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hold.BigHandle)) }
        if ($hold.SmallHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hold.SmallHandle)) }
        $hold.BigHandle = [IntPtr]::Zero
        $hold.SmallHandle = [IntPtr]::Zero
        $set = @{ Applied = $false; Retain = $false; Reason = 'apply-exception' }
      } else {
        # 可能已经送达只是没收到回执 -> 证明不了窗口是否还引用 -> 只能继续持有。
        $set = @{ Applied = $false; Retain = $true; Reason = 'apply-exception' }
      }
    } else {
      $set = @{ Applied = $false; Retain = $false; Reason = 'apply-exception' }
    }
    Add-MmxTaskbarKeeperLog -Path $logPath -Message ("apply 异常：{0}" -f $_.Exception.Message)
  }
  $result.applied = [bool]$set.Applied
  $result.reason = $set.Reason
  $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount

  if ($set.Applied) {
    $result.ok = $true
    $result.status = 'applied'
  } elseif ($set.Retain) {
    # 读回证明不了：不能销毁、也不能退出，继续持有到目标真的消失。
    $result.ok = $false
    $result.status = 'retaining'
  } else {
    $result.ok = $false
    $result.status = 'failure'
  }
  Write-MmxTaskbarStateFile -Path $statePath -Data $result
  Add-MmxTaskbarKeeperLog -Path $logPath -Message ("status={0} reason={1} applied={2}" -f $result.status, $result.reason, $result.applied)

  # 没设上、也没持有价值 -> 直接退出（图标从未挂到窗口上或已恢复）。
  if (-not $set.Applied -and -not $set.Retain) {
    return [pscustomobject]$result
  }

  # ---- 持有：一直活到目标进程结束 / 主窗口没了 / 收到停止指令 ----
  $baselineTicks = [long]$state.Process.CreationTicks
  $stopFlag = $statePath + '.stop'
  while ($true) {
    Start-Sleep -Milliseconds 1000
    try {
      # 先确认目标进程和原窗口都还活着，再谈停止：
      # 目标可能已经退出、句柄也可能被系统回收，这时往那个窗口写就是写野窗口。
      if (-not (Test-MmxTaskbarTargetAlive -ProcessId $TargetProcessId -BaselineTicks $baselineTicks)) {
        # 目标进程没了 -> 窗口通常也没了，但「归属变了」不等于「没了」：
        # 只有能证明窗口不再引用我们的 HICON 才销毁，否则继续持有。
        $rel = Remove-MmxTaskbarHeldIcons -Window $window -BigHandle $hold.BigHandle -SmallHandle $hold.SmallHandle
        if ($rel.Retain) {
          $result.status = 'retaining'
          $result.reason = $rel.Reason
          Write-MmxTaskbarStateFile -Path $statePath -Data $result
          Add-MmxTaskbarKeeperLog -Path $logPath -Message ("目标已退出但无法证明窗口不再引用（{0}），继续持有。" -f $rel.Reason)
          Start-Sleep -Milliseconds 1000
          continue
        }
        $result.status = 'target-exited'
        $result.reason = 'target-exited'
        $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
        Write-MmxTaskbarStateFile -Path $statePath -Data $result
        Add-MmxTaskbarKeeperLog -Path $logPath -Message '目标进程已退出，释放图标并退出。'
        return [pscustomobject]$result
      }

      if (-not (Test-MmxTaskbarWindowAlive -Window $window -ProcessId $TargetProcessId -ExpectedClass $MainWindowClass)) {
        # 主窗口被销毁或被换掉 -> fail closed：不再持有，退出（不追新窗口）。
        $rel = Remove-MmxTaskbarHeldIcons -Window $window -BigHandle $hold.BigHandle -SmallHandle $hold.SmallHandle
        if ($rel.Retain) {
          $result.status = 'retaining'
          $result.reason = $rel.Reason
          Write-MmxTaskbarStateFile -Path $statePath -Data $result
          Add-MmxTaskbarKeeperLog -Path $logPath -Message ("窗口状态异常但无法证明不再引用（{0}），继续持有。" -f $rel.Reason)
          Start-Sleep -Milliseconds 1000
          continue
        }
        $result.status = 'window-gone'
        $result.reason = 'window-gone'
        $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
        Write-MmxTaskbarStateFile -Path $statePath -Data $result
        Add-MmxTaskbarKeeperLog -Path $logPath -Message '主窗口已消失/被替换，释放图标并退出。'
        return [pscustomobject]$result
      }

      if (Test-Path -LiteralPath $stopFlag) {
        # 恢复之前必须先证明「进程身份」：Test-MmxTaskbarTargetAlive 在「查询未知」时
        # 返回 true 只是为了继续持有，不能拿来当「可以往窗口写」的依据。
        # 拿不到 (Known/Exists/Ticks/与基线一致) -> 不写、不释放，继续持有。
        $probe = Get-MmxTaskbarProcessProbe -ProcessId $TargetProcessId
        if (-not $probe.Known -or -not $probe.Exists -or $probe.Ticks -le 0 -or $probe.Ticks -ne $baselineTicks) {
          $result.status = 'retaining'
          $result.reason = 'process-identity-unproven'
          Write-MmxTaskbarStateFile -Path $statePath -Data $result
          Add-MmxTaskbarKeeperLog -Path $logPath -Message '停止请求：进程身份未证明（process-identity-unproven），不恢复不释放，继续持有。'
          continue
        }
        # 窗口身份也必须证明：句柄可能已经被系统回收给别的窗口。
        $ident = Get-MmxTaskbarWindowIdentity -Window $window
        if (-not $ident.Known -or $ident.ProcessId -ne $TargetProcessId -or $ident.ClassName -ne $MainWindowClass) {
          $result.status = 'retaining'
          $result.reason = 'window-identity-unproven'
          Write-MmxTaskbarStateFile -Path $statePath -Data $result
          Add-MmxTaskbarKeeperLog -Path $logPath -Message '停止请求：窗口身份未证明，不恢复不释放，继续持有。'
          continue
        }
        $rest = $null
        try {
          $rest = Restore-MmxTaskbarIcon -Window $window -BigHandle $hold.BigHandle -SmallHandle $hold.SmallHandle -OrigBig $hold.OrigBig -OrigSmall $hold.OrigSmall -RestoreKnown ([bool]$hold.RestoreKnown)
        } catch {
          $rest = @{ Retain = $true; Restored = $false; Reason = 'restore-exception' }
        }
        if ($rest.Retain) {
          # 证明不了窗口是否还引用我们的 HICON -> 不销毁、不退出，继续持有。
          $result.status = 'retaining'
          $result.reason = $rest.Reason
          Write-MmxTaskbarStateFile -Path $statePath -Data $result
          Add-MmxTaskbarKeeperLog -Path $logPath -Message ("停止请求：无法证明窗口不再引用（{0}），继续持有。" -f $rest.Reason)
          continue
        }
        if ($hold.BigHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hold.BigHandle)) }
        if ($hold.SmallHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hold.SmallHandle)) }
        $result.status = 'stopped'
        $result.reason = 'stopped'
        $result.nativeWriteCalls = $script:MmxTaskbarNativeWriteCount
        Write-MmxTaskbarStateFile -Path $statePath -Data $result
        Add-MmxTaskbarKeeperLog -Path $logPath -Message '已恢复原图并退出。'
        return [pscustomobject]$result
      }
    } catch {
      # 持有阶段任何异常都兜住：不能让它逃出任务函数（逃出 = keeper 进程死 =
      # HICON 被系统销毁 = 窗口挂野句柄，正是 2026-10-22 那次事故的形状）。
      # 保守处理：不写窗口、不销毁 HICON、不退出，继续持有；
      # 只有「原 target/窗口确已消失」或「已证实不再引用」才允许结束。
      $result.status = 'retaining'
      $result.reason = 'hold-exception'
      try { Write-MmxTaskbarStateFile -Path $statePath -Data $result } catch { }
      try { Add-MmxTaskbarKeeperLog -Path $logPath -Message ("持有阶段异常（{0}），继续持有：{1}" -f $result.reason, $_.Exception.Message) } catch { }
      Start-Sleep -Milliseconds 1000
      continue
    }
  }
}

# ---------------------------------------------------------------------------
# main（dot-source 时不跑，测试要用里面的函数）
# ---------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
  $out = Invoke-MmxTaskbarIconTask -TargetProcessId $TargetProcessId -ExpectedExecutable $ExpectedExecutable `
    -IconPath $IconPath -MainWindowClass $MainWindowClass -MainWindowTitle $MainWindowTitle `
    -Apply:$Apply -Stop:$Stop -WaitSeconds $WaitSeconds -StateDir $StateDir -RunToken $RunToken -StateProvider $StateProvider
  # 独立命令行运行时把 JSON 打到 stdout；被 & 调用时只把对象交给调用方。
  # -Apply（keeper 常驻）模式不打 stdout：launcher 早就退出了，管道写端没人读。
  # 脚本内没有 exit：退出码恒为 0，成功与否看 $out.ok / $out.status。
  if (-not $Apply -and (Get-PSCallStack).Count -le 1) {
    try { Write-Host ($out | ConvertTo-Json -Depth 5) } catch { }
  }
  $out
}
