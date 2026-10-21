<#
.SYNOPSIS
  set-mmx-taskbar-icon.ps1 的最小自检（无测试框架，assert 风格）。

.DESCRIPTION
  覆盖：
    1. 解析 / dot-source / 原生声明可加载。
    2. 身份门禁反向用例：进程不在、EXE 不符、命令行拿不到（身份不明）、
       辅助子进程（--type= / --eval / --run-as-node / host-runner.js）、
       0 个主窗口、多个主窗口、背景 host 窗口、tool 窗口、隐藏窗口、
       owner 非 0、窗口属于别的进程。
    3. 写前复核反向用例：PID 复用、EXE 变了、进程号变了、主窗口被换、
       类名变了；以及「同进程还有背景窗口」不该被误判。
    4. 默认 probe 零写调用。
    5. 写路径反向用例（全部用假原生适配器，绝不对真实窗口发 WM_SETICON）：
       图标文件缺失、LoadImage 失败、旧图标读不出来（一个 Set 都不能发）、
       WM_SETICON 超时但读回证明生效、读回不一致（回滚 + 释放）、
       读回未知（不释放、继续持有）。
    6. 恢复路径：仍引用我们 -> 恢复原值；不再引用 -> 只释放不恢复；
       读回未知 -> 保留（Retain）。
    7. 互斥：同目标 PID + 创建时间重复启动 -> already-running。
    8. 目标存活判定：真进程存活 / 创建时间不符（防 PID 复用）/ 进程退出。
    9. 端到端：拿本测试进程当目标（假状态 + 假原生），跑一次 apply + stop，
       断言「applied -> 恢复原值 -> 释放 -> stopped」。
    10. launcher 接线静态检查：-NoTaskbarIcon 与 -NoTrayIcon 独立、
       定义与调用都在 DryRun / CDP 失败退出之后、daemon 起来之后才调用、
       -NoDaemon 分支也调用、隐藏启动（UseShellExecute=false +
       CreateNoWindow=true）、用 CDP 监听 PID 而不是自己启动官方程序。
    11. fail-closed：桩缺失的原生调用必须抛错（绝不回退真实 API）；真实原生回路
        只对「本进程自建 + 原生 owner 读回证明归本进程」的 fixture 窗口。
    12. 生命周期回归：R1（进程查询异常 != 目标已退出）、R2（SetIcon 抛异常 ->
        RestoreKnown=false，Stop 不写回没证明过的值）、R3（-Windows @() 不被
        默认值吞掉）、keeper 在目标进程结束后自己退出。
    13. 生产入口：PS5.1 / PS7 真正 -File 跑默认 probe（不是 dot-source）。

  绝不碰真实 MiniMax 窗口：所有写路径都走假原生适配器。

.EXAMPLE
  powershell -NoProfile -File .\test-taskbar-icon.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$SrcDir = $PSScriptRoot
$Root = Split-Path -Parent $SrcDir
$HelperPath = Join-Path $SrcDir 'set-mmx-taskbar-icon.ps1'
$LauncherPath = Join-Path $SrcDir 'launch-mmx-status.ps1'
$TestIconPath = Join-Path $Root 'assets\mmx-red-circle.ico'
$TestStateDir = Join-Path $Root 'logs\taskbar-icon-tests'

$script:pass = 0
$script:fail = 0
$script:failures = New-Object System.Collections.ArrayList

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
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$null, [ref]$parseErrors)
Assert-True -Name 'helper 可被 PS 解析（无语法错误）' -Ok ($parseErrors.Count -eq 0) ("errors=" + $parseErrors.Count)

$parseErrors2 = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($LauncherPath, [ref]$null, [ref]$parseErrors2)
Assert-True -Name 'launcher 可被 PS 解析（无语法错误）' -Ok ($parseErrors2.Count -eq 0) ("errors=" + $parseErrors2.Count)

$prevEap = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  . $HelperPath
} finally {
  $ErrorActionPreference = $prevEap
}
Assert-True -Name 'helper 可 dot-source 且不跑 main' -Ok ([bool](Get-Command Invoke-MmxTaskbarIconTask -ErrorAction SilentlyContinue)) $HelperPath

Add-MmxTaskbarNative | Out-Null
Assert-True -Name '原生声明可加载' -Ok ([bool]('MmxTaskbarNative' -as [type])) ''

Assert-True -Name 'ICO 资源存在' -Ok (Test-Path -LiteralPath $TestIconPath -PathType Leaf) $TestIconPath

# ---------------------------------------------------------------------------
# 1. 假状态 / 假窗口
# ---------------------------------------------------------------------------
$FakeExe = 'D:\MiniMax\MiniMax Code\MiniMax Code.exe'

function New-FakeWindow {
  param(
    # 故意用一个不可能是真实窗口的句柄：GetWindowThreadProcessId 对它返回 0，
    # keeper 的「窗口是否还活着」判定就会走「读不到 -> 当作还在」的保守分支。
    [long]$Handle = 2147483647,
    [string]$ClassName = 'Chrome_WidgetWin_1',
    [string]$Title = 'MiniMax Code',
    [int]$ProcessId = 4242,
    [bool]$Visible = $true,
    [long]$Owner = 0,
    [long]$ExStyle = 0x200100
  )
  return @{ Handle = [IntPtr]$Handle; ClassName = $ClassName; Title = $Title; ProcessId = $ProcessId; Visible = $Visible; Owner = $Owner; ExStyle = $ExStyle }
}

function New-FakeState {
  param(
    [int]$ProcessId = 4242,
    [string]$ExePath = 'D:\MiniMax\MiniMax Code\MiniMax Code.exe',
    [string]$CommandLine = '"D:\MiniMax\MiniMax Code\MiniMax Code.exe" --remote-debugging-port=9331',
    [long]$CreationTicks = 638000000000000000,
    $Windows = $null,
    [switch]$ProcessMissing
  )
  if ($ProcessMissing) {
    return @{ Process = @{ Ok = $false; Reason = 'process-not-found'; ProcessId = $ProcessId; ExePath = $null; CommandLine = $null; CreationTicks = 0; CreatedUtc = $null }; Windows = @() }
  }
  if (-not $PSBoundParameters.ContainsKey('Windows')) { $Windows = @(New-FakeWindow -ProcessId $ProcessId) }
  return @{
    Process = @{
      Ok = $true; Reason = 'ok'; ProcessId = $ProcessId
      ExePath = $ExePath; CommandLine = $CommandLine
      CreationTicks = $CreationTicks
      CreatedUtc = (New-Object DateTime($CreationTicks, [System.DateTimeKind]::Utc)).ToString('o')
    }
    Windows = $Windows
  }
}

# ---------------------------------------------------------------------------
# 2. 门禁反向用例
# ---------------------------------------------------------------------------
$g = Test-MmxTaskbarTarget -State (New-FakeState) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-True -Name '门禁 正例通过' -Ok ([bool]$g.Ok) ("reason=" + $g.Reason)

$g = Test-MmxTaskbarTarget -State (New-FakeState -ProcessMissing) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 进程不存在' -Expected 'process-not-found' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState -ExePath 'D:\Other\Other.exe') -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 EXE 路径不符' -Expected 'executable-path-mismatch' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState -ExePath 'd:\minimax\minimax code\minimax code.exe') -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-True -Name '门禁 EXE 路径大小写不敏感' -Ok ([bool]$g.Ok) ("reason=" + $g.Reason)

$g = Test-MmxTaskbarTarget -State (New-FakeState -CommandLine '') -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 命令行为空（身份不明）' -Expected 'commandline-unavailable' -Actual $g.Reason

foreach ($pattern in @('--type=renderer', '--input-type=module --eval', '--run-as-node', '--inspect-brk', 'runtime host-runner.js')) {
  $g = Test-MmxTaskbarTarget -State (New-FakeState -CommandLine ('"' + $FakeExe + '" ' + $pattern)) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
  Assert-Equal -Name ('门禁 辅助子进程 ' + $pattern) -Expected 'helper-process' -Actual $g.Reason
}

# 背景 host 窗口：class 一样、标题不同 -> 必须被排除（不算主窗口）
$bg = New-FakeWindow -Handle 27397060 -Title 'Mavis Browser Background Render Host 1' -ExStyle 0x8280020
$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @($bg, (New-FakeWindow))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-True -Name '门禁 背景 host 窗口被排除' -Ok ([bool]$g.Ok) ("reason=" + $g.Reason)

# tool 窗口 / 隐藏窗口 / owner 非 0 -> 都不算主窗口
$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @((New-FakeWindow -ExStyle 0x80))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 tool 窗口被排除' -Expected 'no-main-window' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @((New-FakeWindow -Visible $false))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 隐藏窗口被排除' -Expected 'no-main-window' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @((New-FakeWindow -Owner 12345))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 owner 非 0 的窗口被排除' -Expected 'no-main-window' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @((New-FakeWindow -ClassName 'SomeOtherClass'))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 类名不符' -Expected 'no-main-window' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @((New-FakeWindow -Title 'MiniMax Code - 别的文档'))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 标题不完全相等' -Expected 'no-main-window' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @((New-FakeWindow), (New-FakeWindow -Handle 2147483646))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 多个主窗口' -Expected 'multiple-main-windows' -Actual $g.Reason

# R3 回归：显式传空窗口数组不能被默认值吞掉。
$emptyWindowsState = New-FakeState -Windows @()
Assert-Equal -Name 'R3 New-FakeState -Windows @() 窗口数为 0' -Expected 0 -Actual @($emptyWindowsState.Windows).Count

$g = Test-MmxTaskbarTarget -State (New-FakeState -Windows @((New-FakeWindow -ProcessId 9999))) -ExpectedExecutable $FakeExe -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 主窗口属于别的进程' -Expected 'main-window-foreign-pid' -Actual $g.Reason

$g = Test-MmxTaskbarTarget -State (New-FakeState) -ExpectedExecutable '' -ExpectedClass 'Chrome_WidgetWin_1' -ExpectedTitle 'MiniMax Code'
Assert-Equal -Name '门禁 期望路径为空' -Expected 'invalid-expected-executable' -Actual $g.Reason

# ---------------------------------------------------------------------------
# 3. 写前复核反向用例
# ---------------------------------------------------------------------------
$base = New-FakeState
$c = Compare-MmxTaskbarState -Baseline $base -Current (New-FakeState)
Assert-True -Name '复核 正例通过' -Ok ([bool]$c.Ok) ("reason=" + $c.Reason)

$c = Compare-MmxTaskbarState -Baseline $base -Current (New-FakeState -CreationTicks 999)
Assert-Equal -Name '复核 PID 复用（创建时间变了）' -Expected 'stale-creation-time' -Actual $c.Reason

$c = Compare-MmxTaskbarState -Baseline $base -Current (New-FakeState -ExePath 'D:\Other\Other.exe')
Assert-Equal -Name '复核 EXE 变了' -Expected 'stale-executable' -Actual $c.Reason

$c = Compare-MmxTaskbarState -Baseline $base -Current (New-FakeState -Windows @((New-FakeWindow -Handle 111)))
Assert-Equal -Name '复核 主窗口被换' -Expected 'stale-main-window' -Actual $c.Reason

$otherPid = New-FakeState
$otherPid.Process.ProcessId = 5555
$c = Compare-MmxTaskbarState -Baseline $base -Current $otherPid
Assert-Equal -Name '复核 进程号变了' -Expected 'stale-process-id' -Actual $c.Reason

# 同进程里还有背景 host 窗口 -> 不是「主窗口被换」，必须放行
$withBg = New-FakeState -Windows @((New-FakeWindow), (New-FakeWindow -Handle 27397060 -Title 'Mavis Browser Background Render Host 1' -ExStyle 0x8280020))
$c = Compare-MmxTaskbarState -Baseline $base -Current $withBg
Assert-True -Name '复核 同进程多个窗口不误判' -Ok ([bool]$c.Ok) ("reason=" + $c.Reason)

# ---------------------------------------------------------------------------
# 4. 假原生适配器
# ---------------------------------------------------------------------------
function New-FakeNative {
  # 注意：PowerShell 的 scriptblock 不是闭包（变量是晚绑定的，从调用点往上找），
  # 所以假实现只能靠 $script: 作用域拿到状态和开关。
  param(
    [IntPtr]$BigHandle = [IntPtr]7001,
    [IntPtr]$SmallHandle = [IntPtr]7002,
    [switch]$LoadFails,
    [switch]$OldUnreadable,
    [switch]$SetTimesOut,
    [switch]$ReadbackUnknown,
    [switch]$ReadbackMismatch,
    [long]$PreReadHandle = 0,
    [long]$SetOld = -1,
    # 假窗口的「归属进程 / 类名」（身份复核用）。
    [int]$OwnerPid = 4242,
    [string]$OwnerClass = 'Chrome_WidgetWin_1',
    # >0 时：那个进程一没，GetIcon 就报「窗口不再引用我们的句柄」。
    [int]$LivenessPid = 0,
    # 模拟读回抛错：第 From..To 次 GetIcon 调用直接抛异常（回归用）。
    [int]$ThrowGetIconFrom = 0,
    [int]$ThrowGetIconTo = 0
  )
  $script:fakeState = @{ Handles = @{}; Sets = New-Object System.Collections.ArrayList; Destroys = New-Object System.Collections.ArrayList; Loads = 0; GetIconCalls = 0 }
  $script:fakeOpts = @{
    Big = $BigHandle; Small = $SmallHandle
    LoadFails = [bool]$LoadFails; OldUnreadable = [bool]$OldUnreadable
    SetTimesOut = [bool]$SetTimesOut; ReadbackUnknown = [bool]$ReadbackUnknown
    ReadbackMismatch = [bool]$ReadbackMismatch
    PreReadHandle = $PreReadHandle; SetOld = $SetOld
    OwnerPid = $OwnerPid; OwnerClass = $OwnerClass; LivenessPid = $LivenessPid
    ThrowGetIconFrom = $ThrowGetIconFrom; ThrowGetIconTo = $ThrowGetIconTo
  }
  $map = @{}
  $map['IconSizes'] = { param($w) return @{ Dpi = 96; Big = 32; Small = 16 } }
  $map['LoadIcon'] = {
    param($path, $size)
    $script:fakeState.Loads++
    if ($script:fakeOpts.LoadFails) { return [IntPtr]::Zero }
    if ([int]$size -ge 32) { return $script:fakeOpts.Big }
    return $script:fakeOpts.Small
  }
  $map['GetIcon'] = {
    param($w, $t)
    $script:fakeState.GetIconCalls++
    # 模拟读回失败（回归用）：指定区间内直接抛异常。
    if ($script:fakeOpts.ThrowGetIconFrom -gt 0 -and
      $script:fakeState.GetIconCalls -ge $script:fakeOpts.ThrowGetIconFrom -and
      $script:fakeState.GetIconCalls -le $script:fakeOpts.ThrowGetIconTo) {
      throw 'simulated GetIcon readback failure'
    }
    # 目标进程没了 -> 窗口不再引用我们的句柄（模拟真实「窗口跟着目标一起没了」）
    if ($script:fakeOpts.LivenessPid -gt 0) {
      $lp = $null
      # 用模块限定名：避免被测试里的 Get-Process 影子函数影响。
      try { $lp = Microsoft.PowerShell.Management\Get-Process -Id $script:fakeOpts.LivenessPid -ErrorAction Stop } catch { $lp = $null }
      if (-not $lp) { return @{ Delivered = $true; Handle = [IntPtr]9999 } }
    }
    if ($script:fakeOpts.OldUnreadable -and $script:fakeState.GetIconCalls -le 2) { return @{ Delivered = $false; Handle = [IntPtr]::Zero } }
    if ($script:fakeOpts.PreReadHandle -ne 0 -and $script:fakeState.GetIconCalls -le 2) { return @{ Delivered = $true; Handle = [IntPtr]$script:fakeOpts.PreReadHandle } }
    if ($script:fakeOpts.ReadbackUnknown -and $script:fakeState.GetIconCalls -gt 2) { return @{ Delivered = $false; Handle = [IntPtr]::Zero } }
    if ($script:fakeOpts.ReadbackMismatch -and $script:fakeState.GetIconCalls -gt 2) { return @{ Delivered = $true; Handle = [IntPtr]9999 } }
    if ($script:fakeState.Handles.ContainsKey([int]$t)) { return @{ Delivered = $true; Handle = $script:fakeState.Handles[[int]$t] } }
    return @{ Delivered = $true; Handle = [IntPtr]::Zero }
  }
  $map['SetIcon'] = {
    param($w, $t, $h)
    [void]$script:fakeState.Sets.Add(@{ Type = [int]$t; Handle = $h })
    # 超时只是没收到回执：消息可能已经送达（真机上就是这种情况），
    # 所以照样把句柄记下来，让读回能证明「其实生效了」。
    $old = [IntPtr]::Zero
    if ($script:fakeState.Handles.ContainsKey([int]$t)) { $old = $script:fakeState.Handles[[int]$t] }
    if ($script:fakeOpts.SetOld -ge 0) { $old = [IntPtr]$script:fakeOpts.SetOld }
    $script:fakeState.Handles[[int]$t] = $h
    if ($script:fakeOpts.SetTimesOut) { return @{ Delivered = $false; Old = [IntPtr]::Zero } }
    return @{ Delivered = $true; Old = $old }
  }
  $map['DestroyIcon'] = { param($h) [void]$script:fakeState.Destroys.Add($h); return $true }
  $map['IsWindow'] = { param($w) return $true }
  $map['WindowOwner'] = { param($w) return [int]$script:fakeOpts.OwnerPid }
  $map['WindowClass'] = { param($w) return [string]$script:fakeOpts.OwnerClass }
  return $map
}

$fakeWindow = [IntPtr]2147483647
# 护栏（硬）：假句柄绝不能是真实窗口。
# 2026-10-22 事故：假句柄曾经用了真实主窗的 1180848，而互斥用例又是在
# 「原生适配器被清空」的状态下调用的 -> 真 WM_SETICON 打到了用户正在用的
# MiniMax 窗口上。现在假句柄固定成一个不可能是窗口的值，并在这里断言。
$fakeIsReal = [bool][MmxTaskbarNative]::IsWindow($fakeWindow)
Assert-True -Name '假句柄不是真实窗口（防误写）' -Ok (-not $fakeIsReal) ("hwnd=" + [long]$fakeWindow)
$sizes = @{ Dpi = 96; Big = 32; Small = 16 }

# fail-closed：桩没打到的原生调用直接抛错，绝不回退真实 API。
Set-MmxTaskbarNativeStrict -Enabled $true | Out-Null

# 回归：桩缺失时必须失败。2026-10-22 事故根因 = 桩被清空后静默回退真实 API，
# 真 WM_SETICON 打到了用户正在用的 MiniMax 主窗。
$script:MmxTaskbarNativeOverride = @{ 'GetIcon' = { param($w, $t) return @{ Delivered = $true; Handle = [IntPtr]::Zero } } }
$strictThrew = $false
try { Invoke-MmxTaskbarNative -Name 'SetIcon' -NativeArgs @($fakeWindow, 1, [IntPtr]1) | Out-Null } catch { $strictThrew = $true }
Assert-True -Name 'strict 桩缺失 -> 抛错，不回退真实 API' -Ok $strictThrew ''
$script:MmxTaskbarNativeOverride = New-FakeNative

# --- 图标文件缺失 ---
$script:MmxTaskbarNativeOverride = New-FakeNative
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath (Join-Path $Root 'assets\no-such-icon.ico') -Sizes $sizes -Hold $hold
Assert-Equal -Name '写 图标文件缺失' -Expected 'icon-file-missing' -Actual $set.Reason
Assert-True -Name '写 图标文件缺失时没发 SetIcon' -Ok ($script:MmxTaskbarNativeWriteCount -eq 0) ("writes=" + $script:MmxTaskbarNativeWriteCount)

# --- LoadImage 失败 ---
$fake = New-FakeNative -LoadFails
$script:MmxTaskbarNativeOverride = $fake
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold
Assert-Equal -Name '写 LoadImage 失败' -Expected 'icon-load-failed' -Actual $set.Reason
Assert-True -Name '写 LoadImage 失败时没发 SetIcon' -Ok ($script:fakeState.Sets.Count -eq 0) ("sets=" + $script:fakeState.Sets.Count)

# --- 旧图标读不出来 -> 一个 Set 都不能发 ---
$fake = New-FakeNative -OldUnreadable
$script:MmxTaskbarNativeOverride = $fake
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold
Assert-Equal -Name '写 旧图标读不出来时失败' -Expected 'old-icon-unreadable' -Actual $set.Reason
Assert-True -Name '写 旧图标读不出来时零 SetIcon / 零 LoadIcon' -Ok (($script:fakeState.Sets.Count -eq 0) -and ($script:fakeState.Loads -eq 0)) ("sets=" + $script:fakeState.Sets.Count + " loads=" + $script:fakeState.Loads)

# --- 正常：读回证明生效 ---
$fake = New-FakeNative
$script:MmxTaskbarNativeOverride = $fake
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold
Assert-True -Name '写 正常路径 applied' -Ok ([bool]$set.Applied) ("reason=" + $set.Reason)
Assert-Equal -Name '写 正常路径 SetIcon 两次' -Expected 2 -Actual $script:fakeState.Sets.Count
Assert-True -Name '写 正常路径不释放 HICON（要一直持有）' -Ok ($script:fakeState.Destroys.Count -eq 0) ("destroys=" + $script:fakeState.Destroys.Count)

# --- WM_SETICON 超时，但读回证明生效 -> 仍然算 applied ---
$fake = New-FakeNative -SetTimesOut
$script:MmxTaskbarNativeOverride = $fake
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold
Assert-True -Name '写 SetIcon 超时但读回证明生效 -> applied' -Ok ([bool]$set.Applied) ("reason=" + $set.Reason)

# --- 读回不一致 -> 回滚 + 释放 ---
$fake = New-FakeNative -ReadbackMismatch
$script:MmxTaskbarNativeOverride = $fake
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold
Assert-True -Name '写 读回不一致 -> 不是 applied' -Ok (-not $set.Applied) ("reason=" + $set.Reason)
Assert-Equal -Name '写 读回不一致 -> 原因' -Expected 'icon-readback-mismatch' -Actual $set.Reason
Assert-True -Name '写 读回不一致 -> 不保留（窗口已不引用）' -Ok (-not $set.Retain) ("retain=" + $set.Retain)
Assert-Equal -Name '写 读回不一致 -> 两个 HICON 都释放' -Expected 2 -Actual $script:fakeState.Destroys.Count

# --- 读回未知 -> 不释放、继续持有 ---
$fake = New-FakeNative -ReadbackUnknown
$script:MmxTaskbarNativeOverride = $fake
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold
Assert-True -Name '写 读回未知 -> 保留持有' -Ok ([bool]$set.Retain) ("reason=" + $set.Reason)
Assert-Equal -Name '写 读回未知 -> 原因' -Expected 'icon-readback-unknown' -Actual $set.Reason
Assert-True -Name '写 读回未知 -> 不销毁 HICON' -Ok ($script:fakeState.Destroys.Count -eq 0) ("destroys=" + $script:fakeState.Destroys.Count)

# --- 恢复路径 ---
$fake = New-FakeNative
$script:MmxTaskbarNativeOverride = $fake
$hold = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero }
$set = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold
$rest = Restore-MmxTaskbarIcon -Window $fakeWindow -BigHandle $hold.BigHandle -SmallHandle $hold.SmallHandle -OrigBig $hold.OrigBig -OrigSmall $hold.OrigSmall
Assert-True -Name '恢复 仍引用我们 -> 恢复原值' -Ok ([bool]$rest.Restored) ("reason=" + $rest.Reason)
Assert-True -Name '恢复 不需要保留' -Ok (-not $rest.Retain) ("reason=" + $rest.Reason)

$fake = New-FakeNative -ReadbackUnknown
$script:MmxTaskbarNativeOverride = $fake
$rest = Restore-MmxTaskbarIcon -Window $fakeWindow -BigHandle ([IntPtr]7001) -SmallHandle ([IntPtr]7002) -OrigBig ([IntPtr]0) -OrigSmall ([IntPtr]0)
Assert-True -Name '恢复 读回未知 -> 保留（不销毁）' -Ok ([bool]$rest.Retain) ("reason=" + $rest.Reason)
Assert-True -Name '恢复 读回未知 -> 没发 SetIcon' -Ok ($script:fakeState.Sets.Count -eq 0) ("sets=" + $script:fakeState.Sets.Count)

# 不知道原值（WM_SETICON 没送达）-> 不能自称恢复得回去，只能继续持有
$fake = New-FakeNative
$script:MmxTaskbarNativeOverride = $fake
$rest = Restore-MmxTaskbarIcon -Window $fakeWindow -BigHandle ([IntPtr]7001) -SmallHandle ([IntPtr]7002) -OrigBig ([IntPtr]0) -OrigSmall ([IntPtr]0) -RestoreKnown $false
Assert-True -Name '恢复 不知道原值 -> 保留' -Ok ([bool]$rest.Retain) ("reason=" + $rest.Reason)
Assert-Equal -Name '恢复 不知道原值 -> 原因' -Expected 'restore-value-unknown' -Actual $rest.Reason
Assert-True -Name '恢复 不知道原值 -> 没发 SetIcon' -Ok ($script:fakeState.Sets.Count -eq 0) ("sets=" + $script:fakeState.Sets.Count)

# 恢复值取 WM_SETICON 返回的 Old（不是更早的预读快照）：
# 预读到 111，应用在预读和下发之间换成 222，WM_SETICON 返回的 Old 才是 222。
$fake = New-FakeNative -PreReadHandle 111 -SetOld 222
$script:MmxTaskbarNativeOverride = $fake
$hold2 = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero; RestoreKnown = $true }
$set2 = Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $hold2
Assert-Equal -Name '写 恢复值用 WM_SETICON 返回的 Old' -Expected 222 -Actual ([long]$hold2.OrigBig)
Assert-True -Name '写 恢复值已知' -Ok ([bool]$hold2.RestoreKnown) ''

# R2 回归：SetIcon 抛异常 -> RestoreKnown 必须变 false，
# Stop 绝不能把「没证明过的预读快照」当原值写回去。
$script:MmxTaskbarNativeOverride = New-FakeNative
$script:MmxTaskbarNativeOverride['SetIcon'] = { param($w, $t, $h) throw 'simulated WM_SETICON send failure' }
$holdR2 = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero; RestoreKnown = $true; SetAttempted = $false }
$r2Threw = $false
try { Invoke-MmxTaskbarSetIcon -Window $fakeWindow -IconPath $TestIconPath -Sizes $sizes -Hold $holdR2 | Out-Null } catch { $r2Threw = $true }
Assert-True -Name 'R2 SetIcon 抛异常会冒泡' -Ok $r2Threw ''
Assert-True -Name 'R2 抛异常后 RestoreKnown=false' -Ok (-not [bool]$holdR2.RestoreKnown) ("restoreKnown=" + $holdR2.RestoreKnown)
$script:MmxTaskbarNativeOverride = New-FakeNative
$restR2 = Restore-MmxTaskbarIcon -Window $fakeWindow -BigHandle $holdR2.BigHandle -SmallHandle $holdR2.SmallHandle -OrigBig $holdR2.OrigBig -OrigSmall $holdR2.OrigSmall -RestoreKnown ([bool]$holdR2.RestoreKnown)
Assert-Equal -Name 'R2 不知道原值 -> 不恢复' -Expected 'restore-value-unknown' -Actual $restR2.Reason
Assert-True -Name 'R2 不知道原值 -> 一个 SetIcon 都不发' -Ok ($script:fakeState.Sets.Count -eq 0) ("sets=" + $script:fakeState.Sets.Count)

# 复位成完整假适配器（strict 模式下不能留空：留空 = 抛错 = 测试自己挂掉）。
$script:MmxTaskbarNativeOverride = New-FakeNative

# ---------------------------------------------------------------------------
# 5. 默认 probe：零写调用
# ---------------------------------------------------------------------------
$script:MmxTaskbarNativeWriteCount = 0
# 变量名不能叫 $fakeState：脚本级赋值会覆盖假适配器的 $script:fakeState（同名同作用域）。
$probeFakeState = New-FakeState
$probe = Invoke-MmxTaskbarIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe `
  -StateProvider { param($id) $probeFakeState } -StateDir $TestStateDir
Assert-Equal -Name 'probe 状态' -Expected 'probe' -Actual $probe.status
Assert-True -Name 'probe ok' -Ok ([bool]$probe.ok) ("reason=" + $probe.reason)
Assert-Equal -Name 'probe 零写调用' -Expected 0 -Actual $script:MmxTaskbarNativeWriteCount
# 真 API 分支才累加 MmxTaskbarNativeWriteCount，所以还要看假适配器自己的计数。
Assert-Equal -Name 'probe 假适配器零写（Set/Load/Destroy 全 0）' -Expected 0 -Actual ($script:fakeState.Sets.Count + $script:fakeState.Loads + $script:fakeState.Destroys.Count)
Assert-True -Name 'probe 没设置图标' -Ok (-not $probe.applied) ''

# 门禁不过时也不能写（有一个窗口，但不是主窗口 -> 门禁必须拒绝）
$script:MmxTaskbarNativeWriteCount = 0
$badState = New-FakeState -Windows @((New-FakeWindow -Title '别的窗口'))
$probe2 = Invoke-MmxTaskbarIconTask -TargetProcessId 4242 -ExpectedExecutable $FakeExe -StateProvider { param($id) $badState } -StateDir $TestStateDir
Assert-Equal -Name '门禁不过 -> failure' -Expected 'failure' -Actual $probe2.status
Assert-Equal -Name '门禁不过 -> 原因' -Expected 'no-main-window' -Actual $probe2.reason
Assert-Equal -Name '门禁不过 -> 零写调用' -Expected 0 -Actual $script:MmxTaskbarNativeWriteCount

# 复位假适配器状态（上面的 probe 用过状态对象，这里重新生成一份干净的）。
$script:MmxTaskbarNativeOverride = New-FakeNative

# ---------------------------------------------------------------------------
# 6. 互斥：同目标重复启动 -> already-running
# ---------------------------------------------------------------------------
$self = Get-Process -Id $PID
$selfExe = $self.MainModule.FileName
$selfTicks = $self.StartTime.ToUniversalTime().Ticks
$selfState = New-FakeState -ProcessId $PID -ExePath $selfExe -CreationTicks $selfTicks `
  -Windows @((New-FakeWindow -ProcessId $PID)) `
  -CommandLine ('"' + $selfExe + '" -File test-taskbar-icon.ps1')
$mutexName = 'Local\MmxTaskbarIcon-{0}-{1}' -f $PID, $selfTicks
# 互斥体是内核对象：同一线程再取会成功（递归），所以必须让「另一个进程」占着它，
# 才能证明第二个 keeper 进程会被挡住。
$holderCmd = '$m = New-Object System.Threading.Mutex($false,''' + $mutexName + '''); $null = $m.WaitOne(0); Start-Sleep -Seconds 30'
$holder = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList ('-NoProfile -Command "' + $holderCmd + '"') -WindowStyle Hidden -PassThru
$heldByOther = $false
for ($i = 0; $i -lt 50; $i++) {
  $probe = New-Object System.Threading.Mutex($false, $mutexName)
  $got = $false
  try { $got = $probe.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  if ($got) { try { $probe.ReleaseMutex() } catch { } } else { $heldByOther = $true }
  $probe.Dispose()
  if ($heldByOther) { break }
  Start-Sleep -Milliseconds 100
}
Assert-True -Name '互斥 另一个进程占住了互斥体' -Ok $heldByOther $mutexName
$r = Invoke-MmxTaskbarIconTask -TargetProcessId $PID -ExpectedExecutable $selfExe -StateProvider { param($id) $selfState } -Apply -StateDir $TestStateDir
Assert-Equal -Name '互斥 重复启动 -> already-running' -Expected 'already-running' -Actual $r.status
Assert-True -Name '互斥 already-running 不算已换图' -Ok (-not $r.applied) ''
try { $holder | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }

# ---------------------------------------------------------------------------
# 7. 端到端：拿本测试进程当目标，跑一次 apply + stop
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $TestStateDir)) { New-Item -ItemType Directory -Path $TestStateDir -Force | Out-Null }
$token = 'e2e-' + [guid]::NewGuid().ToString('N')
$statePath = Join-Path $TestStateDir ("keeper-{0}-{1}.json" -f $PID, $token)
Set-Content -LiteralPath ($statePath + '.stop') -Value 'stop' -Encoding ascii

$fake = New-FakeNative -OwnerPid $PID
$script:MmxTaskbarNativeOverride = $fake
$e2e = Invoke-MmxTaskbarIconTask -TargetProcessId $PID -ExpectedExecutable $selfExe `
  -StateProvider { param($id) $selfState } -Apply -StateDir $TestStateDir -RunToken $token
Assert-True -Name '端到端 applied（读回证明生效）' -Ok ([bool]$e2e.applied) ("reason=" + $e2e.reason)
Assert-Equal -Name '端到端 收到停止指令后退出' -Expected 'stopped' -Actual $e2e.status
Assert-True -Name '端到端 释放了两个 HICON' -Ok ($script:fakeState.Destroys.Count -eq 2) ("destroys=" + $script:fakeState.Destroys.Count)
Assert-True -Name '端到端 结果文件已落盘' -Ok (Test-Path -LiteralPath $statePath) $statePath
$script:MmxTaskbarNativeOverride = New-FakeNative

# ---------------------------------------------------------------------------
# 8. 真实窗口原生回路（真 P/Invoke，不碰真实应用窗口）
#    证明：LoadImageW -> WM_SETICON -> WM_GETICON 读回 -> 恢复原值 这一整条
#    在真窗口上成立（前面的假适配器测不到 P/Invoke 接线本身）。
#    fixture 是本进程自己建的 STATIC 顶级窗口（不可见），用完销毁。
# ---------------------------------------------------------------------------
# 唯一允许走真实原生 API 的小节（对象是本进程自建的 fixture 窗口），
# 所以这里先关掉 fail-closed。
Set-MmxTaskbarNativeStrict -Enabled $false | Out-Null
$script:MmxTaskbarNativeOverride = @{}
$fixtureSource = @'
using System;
using System.Runtime.InteropServices;

public static class MmxTaskbarFixtureNative
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateWindowExW(int exStyle, string className, string windowName, uint style,
        int x, int y, int w, int h, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
$fixtureOk = $true
try {
  Invoke-MmxTaskbarWithCompileTemp { Add-Type -TypeDefinition $fixtureSource -ErrorAction Stop } | Out-Null
} catch {
  $fixtureOk = $false
  Write-Host ("FAIL  fixture 原生声明编译失败  |  " + $_.Exception.Message)
  $script:fail++
  [void]$script:failures.Add('fixture 原生声明编译失败')
}

if ($fixtureOk) {
  # WS_OVERLAPPEDWINDOW = 0x0; 不带 WS_VISIBLE -> 窗口不可见，不上任务栏。
  $fixtureHwnd = [MmxTaskbarFixtureNative]::CreateWindowExW(0, 'STATIC', 'mmx-taskbar-fixture', 0, 0, 0, 100, 100, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
  Assert-True -Name 'fixture 窗口创建成功' -Ok ($fixtureHwnd -ne [IntPtr]::Zero) ("hwnd=" + [long]$fixtureHwnd)
  if ($fixtureHwnd -ne [IntPtr]::Zero) {
    try {
      # 原生 owner 读回：证明这个句柄归本测试进程所有，才允许往它身上发 WM_SETICON。
      $fixtureOwner = [uint32]0
      [void][MmxTaskbarFixtureNative]::GetWindowThreadProcessId($fixtureHwnd, [ref]$fixtureOwner)
      Assert-Equal -Name 'fixture 归属本测试进程（原生 owner 读回）' -Expected $PID -Actual ([int]$fixtureOwner)
      if ([int]$fixtureOwner -ne $PID) { throw 'fixture 归属不是本进程 -> 拒绝写入' }
      $before = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($fixtureHwnd, 1)
      Assert-True -Name 'fixture 初始图标读得到' -Ok ([bool]$before.Delivered) ("delivered=" + $before.Delivered)

      $hold3 = @{ BigHandle = [IntPtr]::Zero; SmallHandle = [IntPtr]::Zero; OrigBig = [IntPtr]::Zero; OrigSmall = [IntPtr]::Zero; RestoreKnown = $true }
      $set3 = Invoke-MmxTaskbarSetIcon -Window $fixtureHwnd -IconPath $TestIconPath -Sizes @{ Big = 32; Small = 16 } -Hold $hold3
      Assert-True -Name '真实窗口 WM_SETICON 生效（读回证明）' -Ok ([bool]$set3.Applied) ("reason=" + $set3.Reason)

      $rb3 = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($fixtureHwnd, 1)
      $rs3 = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($fixtureHwnd, 0)
      Assert-True -Name '真实窗口读回 == 我们的 HICON（ICON_BIG）' -Ok (($rb3.Delivered) -and ($rb3.Handle -eq $hold3.BigHandle)) ("got=" + [long]$rb3.Handle + " ours=" + [long]$hold3.BigHandle)
      Assert-True -Name '真实窗口读回 == 我们的 HICON（ICON_SMALL）' -Ok (($rs3.Delivered) -and ($rs3.Handle -eq $hold3.SmallHandle)) ("got=" + [long]$rs3.Handle + " ours=" + [long]$hold3.SmallHandle)

      $rest3 = Restore-MmxTaskbarIcon -Window $fixtureHwnd -BigHandle $hold3.BigHandle -SmallHandle $hold3.SmallHandle -OrigBig $hold3.OrigBig -OrigSmall $hold3.OrigSmall -RestoreKnown ([bool]$hold3.RestoreKnown)
      Assert-True -Name '真实窗口恢复原值（不再引用我们的 HICON）' -Ok ((-not $rest3.Retain)) ("reason=" + $rest3.Reason)
      $ra3 = Invoke-MmxTaskbarNative -Name 'GetIcon' -NativeArgs @($fixtureHwnd, 1)
      Assert-True -Name '真实窗口恢复后读回不是我们的 HICON' -Ok (($ra3.Delivered) -and ($ra3.Handle -ne $hold3.BigHandle)) ("got=" + [long]$ra3.Handle)
      if ($hold3.BigHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hold3.BigHandle)) }
      if ($hold3.SmallHandle -ne [IntPtr]::Zero) { [void](Invoke-MmxTaskbarNative -Name 'DestroyIcon' -NativeArgs @($hold3.SmallHandle)) }
    } finally {
      [void][MmxTaskbarFixtureNative]::DestroyWindow($fixtureHwnd)
    }
  }
}

# ---------------------------------------------------------------------------
# 9. 目标存活判定（真进程 + 防 PID 复用）
# ---------------------------------------------------------------------------
$tmp = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 3' -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 500
$tmpTicks = 0
try { $tmpTicks = (Get-Process -Id $tmp.Id).StartTime.ToUniversalTime().Ticks } catch { }
Assert-True -Name '存活判定 目标在 -> true' -Ok (Test-MmxTaskbarTargetAlive -ProcessId $tmp.Id -BaselineTicks $tmpTicks) ''
Assert-True -Name '存活判定 创建时间不符 -> false（防 PID 复用）' -Ok (-not (Test-MmxTaskbarTargetAlive -ProcessId $tmp.Id -BaselineTicks ($tmpTicks + 1))) ''
try { $tmp | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
Start-Sleep -Milliseconds 500
Assert-True -Name '存活判定 目标退出 -> false' -Ok (-not (Test-MmxTaskbarTargetAlive -ProcessId $tmp.Id -BaselineTicks $tmpTicks)) ''

# R1 回归：Get-Process 查询异常 != 目标已退出。
# 以前查询一抛异常就返回 false（当作目标没了）-> keeper 在活着的应用上销毁 HICON。
$queryFailureAlive = $null
try {
  function Get-Process { param($Id, $ErrorAction) throw 'simulated Get-Process query failure' }
  $queryFailureAlive = Test-MmxTaskbarTargetAlive -ProcessId 48588 -BaselineTicks 1
} finally {
  Remove-Item function:\Get-Process -ErrorAction SilentlyContinue
}
Assert-True -Name 'R1 进程查询异常 -> 判定为存活（不销毁图标）' -Ok ([bool]$queryFailureAlive) ("result=" + $queryFailureAlive)

# ---------------------------------------------------------------------------
# 10. keeper 生命周期：目标进程结束后自己退出（假窗口 + 真子进程当目标）
# ---------------------------------------------------------------------------
$victim = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 6' -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 300
$victimTicks = 0
try { $victimTicks = (Get-Process -Id $victim.Id).StartTime.ToUniversalTime().Ticks } catch { }
$victimState = New-FakeState -ProcessId $victim.Id -ExePath $selfExe -CreationTicks $victimTicks `
  -Windows @((New-FakeWindow -ProcessId $victim.Id)) -CommandLine ('"' + $selfExe + '" -File test-taskbar-icon.ps1')
$script:MmxTaskbarNativeOverride = New-FakeNative -OwnerPid $victim.Id -LivenessPid $victim.Id
$exitToken = 'exit-' + [guid]::NewGuid().ToString('N')
$exitResult = Invoke-MmxTaskbarIconTask -TargetProcessId $victim.Id -ExpectedExecutable $selfExe `
  -StateProvider { param($id) $victimState } -Apply -StateDir $TestStateDir -RunToken $exitToken
Assert-Equal -Name 'keeper 目标结束后退出' -Expected 'target-exited' -Actual $exitResult.status
Assert-True -Name 'keeper 目标结束后释放两个 HICON' -Ok ($script:fakeState.Destroys.Count -eq 2) ("destroys=" + $script:fakeState.Destroys.Count)
$script:MmxTaskbarNativeOverride = New-FakeNative

# ---------------------------------------------------------------------------
# 11. 回归：Stop 必须先证明进程身份；持有阶段异常必须兜住
#     两个回归都带「明确停止条件」：假进程先报未知，几次调用后改报「已退出」，
#     假窗口随之报「不再引用我们的句柄」-> keeper 才能结束，不会无限等。
# ---------------------------------------------------------------------------
$regDir = Join-Path $TestStateDir 'stop-identity'
if (-not (Test-Path -LiteralPath $regDir)) { New-Item -ItemType Directory -Path $regDir -Force | Out-Null }

function Get-Process {
  # 影子函数：前几次「查询失败（未知）」，之后「进程确实不存在」。
  param($Id, $ErrorAction)
  $script:gpCalls++
  if ($script:gpMode -eq 'unknown') {
    if ($script:gpCalls -lt 4) { throw 'simulated Get-Process query failure' }
    $script:gpMode = 'notfound'
  }
  if ($script:gpMode -eq 'notfound') { Microsoft.PowerShell.Management\Get-Process -Id 999999 -ErrorAction Stop }
  Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop
}

# --- 回归 A：Stop 分支在「进程身份未证明」时不许写、不许释放 ---
$script:gpMode = 'unknown'
$script:gpCalls = 0
$victimA = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 2' -WindowStyle Hidden -PassThru
$script:MmxTaskbarNativeOverride = New-FakeNative -OwnerPid $PID -LivenessPid $victimA.Id
$tokenA = 'stop-identity-' + [guid]::NewGuid().ToString('N')
$pathA = Join-Path $regDir ("keeper-{0}-{1}.json" -f $PID, $tokenA)
$logA = Join-Path $regDir ("keeper-{0}-{1}.log" -f $PID, $tokenA)
Set-Content -LiteralPath ($pathA + '.stop') -Value 'stop' -Encoding ascii
$rA = Invoke-MmxTaskbarIconTask -TargetProcessId $PID -ExpectedExecutable $selfExe `
  -StateProvider { param($id) $selfState } -Apply -StateDir $regDir -RunToken $tokenA
Assert-Equal -Name '回归A 进程身份未证明时不发恢复写（只有 apply 的 2 次）' -Expected 2 -Actual $script:fakeState.Sets.Count
$logAText = ''
if (Test-Path -LiteralPath $logA) { $logAText = [string](Get-Content -LiteralPath $logA -Raw) }
Assert-True -Name '回归A 进程身份未证明时进入 retaining（不退出）' -Ok ($logAText -match 'process-identity-unproven') ''
Assert-Equal -Name '回归A 目标确已消失后 keeper 才退出' -Expected 'target-exited' -Actual $rA.status

# --- 回归 B：持有阶段抛异常不逃出任务函数 ---
$script:gpMode = 'unknown'
$script:gpCalls = 0
$victimB = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 2' -WindowStyle Hidden -PassThru
# 第 5、6 次 GetIcon 抛异常（apply 用掉前 4 次），之后恢复正常。
$script:MmxTaskbarNativeOverride = New-FakeNative -OwnerPid $PID -LivenessPid $victimB.Id -ThrowGetIconFrom 5 -ThrowGetIconTo 6
$tokenB = 'outer-catch-' + [guid]::NewGuid().ToString('N')
$pathB = Join-Path $regDir ("keeper-{0}-{1}.json" -f $PID, $tokenB)
$logB = Join-Path $regDir ("keeper-{0}-{1}.log" -f $PID, $tokenB)
$threwB = $false
$rB = $null
try {
  $rB = Invoke-MmxTaskbarIconTask -TargetProcessId $PID -ExpectedExecutable $selfExe `
    -StateProvider { param($id) $selfState } -Apply -StateDir $regDir -RunToken $tokenB
} catch {
  $threwB = $true
}
Assert-True -Name '回归B 持有阶段异常不逃出任务函数' -Ok (-not $threwB) ''
$logBText = ''
if (Test-Path -LiteralPath $logB) { $logBText = [string](Get-Content -LiteralPath $logB -Raw) }
Assert-True -Name '回归B 异常后进入 retaining（继续持有，不销毁）' -Ok ($logBText -match 'hold-exception') ''
Assert-Equal -Name '回归B 异常期间没有额外写' -Expected 2 -Actual $script:fakeState.Sets.Count
Assert-Equal -Name '回归B 目标确已消失后 keeper 才退出' -Expected 'target-exited' -Actual $rB.status

Remove-Item function:\Get-Process -ErrorAction SilentlyContinue
$script:MmxTaskbarNativeOverride = New-FakeNative

# ---------------------------------------------------------------------------
# 11. 生产入口：PS5.1 / PS7 真正 -File 跑默认 probe（不是 dot-source）
# ---------------------------------------------------------------------------
function Test-MmxCliProbe {
  # 真正 -File 起一个子进程跑默认 probe：输出重定向到临时文件，
  # 退出码用 $LASTEXITCODE（PS 5.1 的 Start-Process -PassThru 拿不到 ExitCode）。
  param([string]$Exe)
  $outFile = Join-Path $TestStateDir ('cli-probe-' + [guid]::NewGuid().ToString('N') + '.out')
  $errFile = $outFile + '.err'
  $code = -1
  $text = ''
  $err = ''
  try {
    $null = & $Exe -NoProfile -File $HelperPath 1> $outFile 2> $errFile
    $code = $LASTEXITCODE
  } catch {
    return [pscustomobject]@{ Ok = $false; Code = -1; Detail = $_.Exception.Message }
  }
  try { $text = [System.IO.File]::ReadAllText($outFile) } catch { }
  try { $err = [System.IO.File]::ReadAllText($errFile) } catch { }
  Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
  $all = ($text + "`n" + $err)
  $detail = $all.Trim()
  if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) }
  return [pscustomobject]@{ Ok = (($code -eq 0) -and ($all -match 'invalid-target-pid')); Code = $code; Detail = $detail }
}

$defaultStateDir = Join-Path $Root 'logs\taskbar-icon'
$filesBefore = @(Get-ChildItem -LiteralPath $defaultStateDir -File -ErrorAction SilentlyContinue).Count
$ps51Exe = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
if ($ps51Exe) {
  $r51 = Test-MmxCliProbe -Exe $ps51Exe
  Assert-True -Name 'CLI PS5.1 -File 默认 probe 正常退出' -Ok ([bool]$r51.Ok) ("code=" + $r51.Code + " out=" + $r51.Detail)
} else {
  Assert-True -Name 'CLI 找到 powershell.exe' -Ok $false 'powershell.exe 不在 PATH'
}
$ps7Exe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if ($ps7Exe) {
  $r7 = Test-MmxCliProbe -Exe $ps7Exe
  Assert-True -Name 'CLI PS7 -File 默认 probe 正常退出' -Ok ([bool]$r7.Ok) ("code=" + $r7.Code + " out=" + $r7.Detail)
} else {
  Assert-True -Name 'CLI 找到 pwsh' -Ok $false 'pwsh 不在 PATH'
}
$filesAfter = @(Get-ChildItem -LiteralPath $defaultStateDir -File -ErrorAction SilentlyContinue).Count
Assert-Equal -Name 'CLI 默认 probe 不产生任何文件' -Expected $filesBefore -Actual $filesAfter

# ---------------------------------------------------------------------------
# 12. launcher 接线静态检查
# ---------------------------------------------------------------------------
$launcher = Get-Content -LiteralPath $LauncherPath -Raw
$dryRunExit = $launcher.IndexOf("if (`$DryRun) {")
$cdpFailExit = $launcher.IndexOf('CDP 端口 $port 未就绪，启动 daemon 无意义，放弃。')
$fnTray = $launcher.IndexOf('function Invoke-MmxTrayIconSwap')
$fnTask = $launcher.IndexOf('function Invoke-MmxTaskbarIconSwap')
$callTask = $launcher.IndexOf('Invoke-MmxTaskbarIconSwap -CdpPort $port -ExePath $exe')

Assert-True -Name 'launcher 有 -NoTaskbarIcon 开关' -Ok ($launcher -match '\[switch\]\$NoTaskbarIcon') ''
Assert-True -Name 'launcher -NoTrayIcon 与 -NoTaskbarIcon 相互独立' -Ok (($launcher -match '\[switch\]\$NoTrayIcon') -and ($launcher -match '\[switch\]\$NoTaskbarIcon')) ''
Assert-True -Name 'launcher 任务栏函数定义在 DryRun 退出之后' -Ok (($fnTask -gt 0) -and ($fnTask -gt $dryRunExit)) ("fn=" + $fnTask + " dry=" + $dryRunExit)
Assert-True -Name 'launcher 任务栏函数定义在 CDP 失败退出之后' -Ok (($fnTask -gt 0) -and ($fnTask -gt $cdpFailExit)) ("fn=" + $fnTask + " cdp=" + $cdpFailExit)
Assert-True -Name 'launcher 任务栏调用点在 DryRun 退出之后' -Ok (($callTask -gt 0) -and ($callTask -gt $dryRunExit)) ("call=" + $callTask)
Assert-True -Name 'launcher DryRun 分支不启动 keeper' -Ok (($dryRunExit -lt $callTask) -and (-not ($launcher.Substring($dryRunExit, [Math]::Min(400, $launcher.Length - $dryRunExit)) -match 'Invoke-MmxTaskbarIconSwap'))) ''
Assert-True -Name 'launcher 用 CDP 监听 PID 找已跑应用' -Ok ($launcher -match 'Get-CdpListenerProcessId -Port \$CdpPort') ''
Assert-True -Name 'launcher 不自己启动官方程序（任务栏路径里没有 Start-Process 官方 exe）' -Ok (-not ($launcher.Substring($fnTask, [Math]::Min(3000, $launcher.Length - $fnTask)) -match 'Start-Process -FilePath \$exe')) ''
Assert-True -Name 'launcher 隐藏启动 keeper（CreateNoWindow）' -Ok ($launcher -match '\$psi\.CreateNoWindow = \$true') ''
Assert-True -Name 'launcher 隐藏启动 keeper（UseShellExecute=false）' -Ok ($launcher -match '\$psi\.UseShellExecute = \$false') ''
Assert-True -Name 'launcher 不继承父进程输出管道（重定向 stdout/stderr）' -Ok (($launcher -match '\$psi\.RedirectStandardOutput = \$true') -and ($launcher -match '\$psi\.RedirectStandardError = \$true')) ''
Assert-True -Name 'launcher 不写「已换红」这种没证据的话' -Ok (-not ($launcher.Substring($fnTask, [Math]::Min(3000, $launcher.Length - $fnTask)) -match '已换成红圆|已换红')) ''
Assert-True -Name 'launcher -NoDaemon 分支也调用任务栏换图' -Ok (($launcher.IndexOf('Invoke-MmxTaskbarIconSwap -CdpPort $port -ExePath $exe')) -gt 0) ''
Assert-Equal -Name 'launcher 任务栏调用点出现次数（NoDaemon 分支 + daemon 之后）' -Expected 2 -Actual ([regex]::Matches($launcher, 'Invoke-MmxTaskbarIconSwap -CdpPort \$port -ExePath \$exe')).Count

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ("PASS={0}  FAIL={1}" -f $script:pass, $script:fail)
if ($script:fail -gt 0) {
  Write-Host '失败项：'
  foreach ($f in $script:failures) { Write-Host ("  - " + $f) }
  exit 1
}
exit 0
