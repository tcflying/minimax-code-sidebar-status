# MiniMax Code 更新后侧边栏注入失效：根因、诊断与恢复

> 记录时间：2026-09-30
> 适用环境：Windows / MiniMax Code 3.1.0（Electron 42.8.0）/ Node v24.13.1
> 关联项目：`minimax-code-sidebar-status`

---

## 一句话结论

MiniMax Code 更新后应用改用**无参数方式启动**，不再开放 CDP 调试端口，
注入器接不上，侧边栏样式全部回到应用默认。**补丁代码本身没有损坏。**

---

## 1. 症状

应用更新后，左侧栏出现以下全部现象：

- 会话选中行**底色消失**
- 选中行左侧**蓝色标记条消失**
- 侧边栏**无法禁止展开**（点击箭头仍会展开）

这些不是"样式参数不对"，而是**整段注入没有发生**。

---

## 2. 根因

注入方案依赖应用启动时开放的 CDP（Chrome DevTools Protocol）端口。
应用更新会整体替换 `app.asar`（本次 426 MB，2026-09-29 22:25），
而**从图标 / 开始菜单 / 官方自启打开时不会带 `--remote-debugging-port` 参数**。

结果：

```
应用在跑        appUp = true
CDP 端口        实际分配 = none      ← 通道不存在
注入器          接不上，无事可做
界面            维持应用默认外观
```

**关键判断：这是启动通道问题，不是代码问题。**
不要一看到样式失效就去改注入脚本——先确认端口通不通。

---

## 3. 决定性证据：watchdog 日志

`src/logs/watchdog.log` 连续 736 次记录同一个状态：

```
APP_UP_NO_CDP  appUp=true  pid=55992  cdpOk=false
端口分配  文件路径=MiniMax:OK(9331)  实际分配=none
```

状态名的含义（`watchdog.mjs`）：

| 状态 | 含义 | watchdog 行为 |
|---|---|---|
| `APP_ABSENT` | 应用未运行 | 按设计**不做任何动作**，绝不自动启动应用 |
| `APP_UP_NO_CDP` | 应用在跑但无 CDP 端口 | **只记录，不动应用**（需显式 `--fix-app`） |
| `APP_UP_CDP_OK` | 应用在跑且 CDP 正常 | 拉起 / 保持 daemon |

恢复后日志变成：

```
APP_UP_CDP_OK  appUp=true  pid=62044  port=9331  src=DevToolsActivePort  cdpOk=true
```

**判据：看 `cdpOk`，不要看 `appUp`。**
应用活着不等于通道可用，这是本次最容易误判的地方。

---

## 4. 排查过程中的两个陷阱

### 陷阱一：端口号记错导致误判

我最初记录的是 `9351`，实际配置全程使用 **`9331`**，
且是通过 `DevToolsActivePort` 文件**动态发现**的。

结果：只查 9351 → "没有监听" → 错误结论"端口没开"。
实际 9331 也没有分配，但**原因不同、排查方向不同**。

**正确做法：优先读 `DevToolsActivePort` 文件，或扫描主进程命令行里的
`--remote-debugging-port`，不要硬编码记忆中的端口号。**
子进程（`--type=renderer` 等）不带该参数，扫描时要排除。

### 陷阱二：daemon 堆积是历史遗留，不是持续故障

现场看到 **114 个 `daemon.mjs` 进程**，日志已达 **4.13 MB** 且在持续刷屏。
但按创建时间分桶后：

| 时间段 | 数量 |
|---|---|
| < 10 分钟 | 0 |
| 10–60 分钟 | 0 |
| 1–6 小时 | 2 |
| 6–24 小时 | 112 |

**最近 1 小时新增 0 个。** 说明当前 watchdog 已处于正确的"只记录不动手"模式，
堆积发生在更早、且当时端口是通的、但 `findDaemonPids` 匹配失败的历史时期。

**结论：不需要改代码，只需要清理残留。**
不要因为"进程数异常"就去重写自愈逻辑——先看时间分布。

---

## 5. 恢复操作

### 5.1 前置认知：这一步会杀掉当前会话

执行环境本身就在 MiniMax Code 里。
结束应用进程 = 结束自己所在的宿主进程，**当轮对话会随之中断**。

因此采用**延迟脚本**：写好脚本 → 排程后台 → 说完话 → 自动执行。
避免"命令发出 → 进程被杀 → 拿不到任何结果"。

### 5.2 第一步：清理残留（安全，不碰应用）

```powershell
# 只杀 sidebar-status 的 daemon，保留 watchdog，不碰 MiniMax Code
$daemons = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'sidebar-status\\src\\daemon\.mjs' })
foreach ($p in $daemons) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
```

本次结果：`before 114 → after 0`，watchdog 存活，MiniMax 进程 11 个未受影响。

### 5.3 第二步：轮转日志（不删除）

`watchdog.log` 4.13 MB 几乎全是同一条告警重复。**改名备份，不删除**：

```powershell
Move-Item $log "$log.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
New-Item -ItemType File -Path $log -Force
```

### 5.4 第三步：带 CDP 参数重启

**先查出你自己机器上的真实路径，不要照抄任何硬编码路径**——
安装位置因机器而异（默认每用户安装在 `%LOCALAPPDATA%\Programs\`，也可以装到其他盘）：

```powershell
# 从正在运行的进程反查 exe 绝对路径 —— 这一定是你这台机器上真实在跑的那个
(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
  Select-Object -First 1).ExecutablePath
```

拿到路径再启动：

```powershell
$exe = '<上面查到的真实路径>'
$args = @('--remote-debugging-port=9331', '--remote-debugging-address=127.0.0.1')
Start-Process -FilePath $exe -ArgumentList $args
```

> ⚠️ 如果 `$exe` 路径里含空格，`Start-Process -ArgumentList` 会把命令行**按空格切开**。
> 含空格时必须手工加引号：`$args = '"' + $exe + '"'`。
> 这是本项目踩过三次的坑，症状是 `Cannot find module 'G:\...\fix'`（路径被从空格处截断）。

**安全提示：`--remote-debugging-address=127.0.0.1` 务必保留。**
不限制绑定地址时，调试端口可能对局域网开放，等于把应用控制权暴露出去。
调试端口必须只监听本机。

---

## 6. 恢复验证（逐项实测，非推测）

| 验证项 | 实测值 | 结论 |
|---|---|---|
| 应用版本 | MiniMax/3.1.0 · Chrome/148.0.7778.280 · Electron/42.8.0 | — |
| 端口 9331 监听 | ✅ pid 62044 | 通 |
| 主进程启动参数 | ✅ `--remote-debugging-port=9331` | 带参启动 |
| 端口就绪耗时 | ✅ 1 秒 | 正常 |
| CDP HTTP 端点 | ✅ `GET /json/version` → **200**，返回 `webSocketDebuggerUrl` | **真通** |
| watchdog 状态 | ✅ `APP_UP_CDP_OK`（持续） | 已恢复 |
| 日志体积 | ✅ 856 字节（此前 4.13 MB） | 刷屏停止 |
| 残留 daemon | ✅ 0 | 干净 |

> **端口在监听 ≠ 通道可用。**
> `Get-NetTCPConnection` 显示 LISTEN 只是第一层；
> 必须再打一次 `GET /json/version` 拿到 200 和 `webSocketDebuggerUrl`，
> 才算真正可注入。本次两者都验了。

---

## 7. 长期建议

### 7.1 更新后必做

1. 查 `watchdog.log` 尾部，看是 `APP_UP_CDP_OK` 还是 `APP_UP_NO_CDP`
2. 查 `app.asar` 的 mtime，确认是否刚被替换
3. 若为 `APP_UP_NO_CDP` → 按第 5 节重启

### 7.2 长期改进（第一、二条已实施）

- ✅ **已实施：快捷方式必须改名，不能叫官方名字。**
  这一条比"建个专用快捷方式"更严格，原因见下面的时间线——
  **官方更新器按名字找 `.lnk` 并覆盖它**：

  ```
  2026-09-29 22:25   app.asar 被替换（426 MB）
  2026-09-30 20:56   桌面 MiniMax Code.lnk 被改回无参数直连
  2026-10-01 02:56   开始菜单 MiniMax Code.lnk 被改回无参数直连
  ```

  手工改好的 `.lnk` 过几天自己变回去，而你会误以为是修复不work。
  唯一解法是**不与官方重名**：建 `mmx-fix.lnk`（配自绘图标），
  官方更新器不认识这个名字，就永远碰不到。官方那两个 `.lnk` 保持原样不动。

- ✅ **已实施：`watchdog.log` 轮转。** 改名备份不删除，本次 5.6 MB 已处理。
- ✅ **已实施：`--fix-app` 三道闸门。** 连续 6 次未恢复 + 启动满 45 秒 + 退避，
  三道全过才动进程。原实现第一次 `APP_UP_NO_CDP` 就动手，实测触发过 12 次修复。
  详见 README 第 14.3 节。
- ⬜ 仍待做：**修 `findDaemonPids` 的历史匹配问题**，从源头消除 daemon 堆积，
  而不是靠定期清理。

### 7.3 监控 daemon 堆积的正确姿势

用**创建时间分桶**判断是历史遗留还是持续泄漏：

```powershell
$now = Get-Date
$daemons | ForEach-Object { [int](($now - $_.CreationDate).TotalMinutes) } |
  Group-Object { [math]::Floor($_ / 60) } | Sort-Object Name |
  ForEach-Object { "bucket ${($_.Name)}h : $($_.Count)" }
```

"最近 1 小时 0 个" = 健康；"每小时稳定新增" = 存在泄漏，需要改代码。

---

## 8. 一句话记忆

> 更新换掉了 `app.asar`，应用不再带调试端口启动，注入通道随之断开。
> **先看 `cdpOk`，别动代码；重启会中断会话，用延迟脚本。**

---

## 附：相关文件

| 路径 | 作用 |
|---|---|
| `src/watchdog.mjs` | 自愈守护；`--fix-app` 才允许结束并重启应用 |
| `src/daemon.mjs` | 实际执行 CDP 注入的常驻进程 |
| `src/launch-mmx-status.ps1` | 启动器；无 CDP 时会结束进程并带参重启 |
| `src/relaunch-cdp-delayed.ps1` | 延迟带参重启（不打断当前会话） |
| `src/lib/cdp.mjs` | CDP 连接封装 |
| `src/lib/page-script.mjs` | 注入到页面的脚本（状态点 / running 竖条 / 汇总条 / 选中底色 / 禁止展开） |
| `src/logs/watchdog.log` | 状态判读第一现场 |
| `src/logs/watchdog.lock` | watchdog 单实例锁 |
| `$env:TEMP\mmx-relaunch-cdp.log` | 本次重启记录（用 `$env:TEMP` 取，别写死用户名路径） |
