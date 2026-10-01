# MiniMax Code 侧边栏会话状态点 —— 完整实现教程

> 给 MiniMax Code 桌面端侧边栏的每个会话加一个状态小圆点：
> 🟢 正在跑 / 🟡 被中断需处理 / 🔴 出错。
>
> **不修改 `app.asar` 一个字节**，不改 Agent Runtime、权限和业务逻辑，可一键完全还原。
> 附赠「永不自动展开」守卫、重启自愈链路、顶部「N 个运行中」汇总条。

实测环境：MiniMax Code 3.0.74 / Electron 42.8.0 / Chromium 148 / Windows 11 (26200) / Node 24.18.0

---

## 0. 结论速览

| 需求 | 官方能力能做到吗 | 本方案 |
|---|---|---|
| 会话行加状态点 | ❌ 无任何 UI 扩展点 | ✅ CDP 注入，已实测 |
| running 一眼可见 | ❌ 无 | ✅ 四重信号：发光竖条 + 整行淡绿底 + 绿标题 + 呼吸动画 |
| 一眼看到"有几个在跑" | ❌ 无 | ✅ 顶部「N 个运行中」汇总条 |
| running 行自动置顶 | — | ❌ **实测走不通**（`order` 失效 / DOM 被单层 div 包裹），见 15.4 |
| 侧边栏按状态筛选 | ⚠️ 内置筛选器**不覆盖置顶区** | ✅ 两个区域都覆盖 |
| 选中行底色加深 | ⚠️ 应用默认 `rgba(10,10,10,0.04)`，很淡 | ✅ 覆盖为 10% + 蓝色左条，可调 |
| 会话永不自动展开 | ❌ 应用强制行为，无设置 | ✅ 持续无条件折叠守卫 |
| 重启后还能用 | ❌ 官方更新器会覆盖快捷方式 | ✅ 改名 `mmx-fix` + 四层自愈链路，见 14 |
| 不改本体 | — | ✅ 零字节改动 |

---

## 1. 问题是怎么被定义的

原始诉求有两条：

1. 侧边栏 session 看不到"是不是在跑"——希望能用颜色区分（绿=跑 / 黄=暂停 / 红=错误）。
2. 想知道侧边栏在什么情况下会自动展开。

第一轮调查的结论是"插件做不到"，但那轮**漏了全局仓库搜索**；补搜后发现了走 CDP 的第三方项目，
才真正打开局面。第三版需求又追加了一条硬约束：**任何时候都不要自动展开**。

---

## 2. 调查方法论：反编译 `app.asar`

MiniMax Code 桌面端不开源，官网文档也查不到这些细节。唯一可靠的信源是应用包本身。

### 2.1 解包 asar 索引

`app.asar` 头部是一个 JSON 索引，记录每个文件的 size/offset/integrity。整包 531,928,215 字节、46,859 个文件。

```python
import json
data = open(r"G:\MiniMax\MiniMax Code\resources\app.asar", "rb").read()
header_size = int.from_bytes(data[12:16], "little")
hdr = json.loads(data[16:16 + header_size].decode("utf-8", "replace"))
base = 16 + header_size          # 文件内容起点

files = {}
def walk(node, prefix):
    for name, meta in node.get("files", {}).items():
        p = prefix + "/" + name if prefix else name
        if "files" in meta:
            walk(meta, p)
        else:
            files[p] = (meta.get("size", 0), int(meta.get("offset", "0")))
walk(hdr, "")

def read(path):
    size, off = files[path]
    return data[base + off: base + off + size]
```

### 2.2 字符串命中只能定位候选，不能下结论

第一轮扫出来 `autoExpand` / `expandOnStart` / `sidebarStatus` / `statusDot` **全部 0 命中**，
我据此下了"自动展开功能不存在"的结论。

**这是错的。** 字符串扫描只能证明"没有这个字面量"，不能证明"没有这个行为"——
行为可能是用完全不同的名字实现的。正确做法是：**命中之后必须打开对应源文件逐行读上下文再确认**。

反例就在这个项目里：`statusDot` 命中 0 次，但状态点功能我是**自己做出来的**；
而 `hasRunningChild` 一次命中就暴露了应用的核心规则。

### 2.3 真正有用的三个命中

| 搜索词 | 命中位置 | 揭示的事实 |
|---|---|---|
| `data-session-id` | `archon/page-*.js` | 侧边栏会话行的稳定锚点 |
| `statusConditions` | `session-system/projects/sidebar/predicate.ts` | 数据层已有 working/done/unread 三态 |
| `local-plugin-hooks.md` | 包内 `assets/skills/plugin-creator/references/` | 官方 hook 事件全集与能力边界 |

---

## 3. 为什么官方插件做不到（有证据）

官方插件能力只有四类，见官网 <https://agent.minimaxi.com/docs/code/agents/plugins.md>：

| 能力 | 接入方式 | 能否影响 UI |
|---|---|---|
| Skill | `skills/<name>/SKILL.md` | ❌ 纯 prompt 文本 |
| MCP | `*.mcp.json` | ❌ 外部工具 |
| Hook | `hooks/hooks.json` | ❌ 见下 |
| App / Connector | OAuth 代管 | ❌ |

Hook 的能力边界在包内自带文档里写得很死
（`node_modules/@mavis/local-runtime/assets/skills/plugin-creator/references/local-plugin-hooks.md`）：

- handler **只能是 `type: "command"`**，即同步跑一个脚本
- 事件全集：`SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PreToolUse` /
  `PermissionRequest` / `PostToolUse` / `SubagentStart` / `SubagentStop` / `Stop` /
  `PreCompact` / `PostCompact`
- 文档原文：*"Desktop sidebar switching alone does not start or end a Hook session."*

**`SubagentStart` 确实存在**，所以插件能感知子代理起停——但它只能拿到 stdin 的 JSON、
写 `PLUGIN_DATA` 文件，**没有任何出口能往 Electron 渲染进程里塞一个组件**。

GitHub 官方仓 `MiniMax-AI/minimax-code` 的 issue 区也印证了这点：
`auto expand` / `status indicator` / `running status` / `session status` / `task indicator`
/ `child session` 全部 **NO_HITS**。上游没人提过这个需求。

---

## 4. 可行路径：CDP（Chrome DevTools Protocol）

### 4.1 为什么这条路通

MiniMax Code 是 Electron/Chromium 应用。启动时加：

```
--remote-debugging-port=9351 --remote-debugging-address=127.0.0.1
```

即可从 `http://127.0.0.1:9351/json/list` 拿到渲染进程 target，url 匹配 `app://./archon`，
再用 WebSocket 发 `Runtime.evaluate` 往页面里执行任意 JS。

**先确认没有屏蔽。** 扫 asar：`remote-debugging-port` 0 命中、`remote-debugging-address` 0 命中、
`remoteDebuggingPort` 0 命中，且没有 `commandLine.removeSwitch('remote-debugging-port')`
——所以直接传参就能开。实测启动后 0ms 就绪。

### 4.2 为什么这比改 app.asar 好

| | 改 app.asar | CDP 注入 |
|---|---|---|
| 官方更新后 | **全部失效**，要重新解包、重新注入 | 不受影响 |
| 可逆性 | 需要备份原包 | 删掉注入节点即完全还原 |
| 权限/业务逻辑 | 可能误伤 | 完全不碰 |
| 崩溃风险 | 改错一个字节客户端起不来 | 最坏情况是注入不生效 |

### 4.3 注入链路全貌

```
~/.minimax/v2/sqlite/runtime-state.sqlite
        │  node:sqlite, readOnly: true
        ▼
   StatusDb  ──►  { sessionId: bucket }
        │
        │  CDP WebSocket → Runtime.evaluate
        ▼
  app://./archon 渲染进程
        │  MutationObserver + setInterval
        ▼
  [data-session-id] 行内 appendChild <span data-mmx-dot>
```

---

## 5. 数据层：状态语义（全部实测）

### 5.1 表结构

`local_runtime_sessions`：

| 列 | 说明 |
|---|---|
| `session_id` | 主键，**就是侧边栏 `data-session-id` 的值** |
| `status` | 会话状态 |
| `error_message` / `error_code` | 错误详情 |
| `archived` | 归档标记 |
| `parent_session_id` | 父会话；子代理有值 |

`local_runtime_session_agent_state`：`terminal_outcome` ∈ `completed` / `aborted` / `failed` / `NULL`

`local_runtime_turn_ingress`：`status` ∈ `completed` / `failed` / `aborted` / `accepted`
（注意表名带 `local_runtime_` 前缀，代码里 import 的别名会骗人）

### 5.2 真实分布（本机 1527 个会话）

```
status:  idle 1181 / aborted 168 / interrupted 112 / error 64 / started 2
outcome: completed 673 / aborted 149 / NULL / failed 48
child:   parent_session_id 非空 404 条（子代理）
```

### 5.3 关键设计判断

**`aborted` 不算"暂停"。** 168 个 `aborted` 是用户主动取消的，属**终态**；
把它们标黄会淹掉 112 个真正需要关注的 `interrupted`（运行时重启导致 turn 未完成）。

| 桶 | 判定 | 颜色 |
|---|---|---|
| running | `status = 'started'` | 🟢 绿（带呼吸动画） |
| paused | `status = 'interrupted'` | 🟡 黄 |
| error | `status = 'error'` 或 `outcome = 'failed'` | 🔴 红 |
| done | `status='idle'` 且 `outcome='completed'` | 无点（默认） |
| idle | 其余（含 aborted） | 无点 |

`--show-done` / `--show-aborted` 两个开关可以放宽。

### 5.4 只读打开很重要

客户端正在运行时用普通模式打开会被 `SQLITE_BUSY` 锁住（这也是上游 issue #282 报告的 bug）。
`node:sqlite` 的 `readOnly: true` 走 `SQLITE_OPEN_READONLY`，实测与运行中的客户端零冲突。

---

## 6. 实现：注入器架构

### 6.1 零第三方依赖

Node 24 自带 `node:sqlite`（`DatabaseSync`）、全局 `WebSocket`、全局 `fetch`。
`npm ls` 里不需要装任何东西。

### 6.2 页面侧脚本的三条铁律

这段 JS 通过 `Runtime.evaluate` 送进页面，必须：

1. **幂等** —— 每个自己创建的节点都打 `data-mmx-dot` 标记，重复执行不产生副作用。
2. **可逆** —— `dispose()` 能删干净所有注入节点，并还原自己改过的内联样式。
3. **不碰宿主节点** —— 绝不调用 `removeChild` / `innerHTML=` / `outerHTML=`（selftest 会检查）。

### 6.3 React 会打掉注入的节点

侧边栏是 React 渲染的，任何 re-render 都可能把未知子节点清掉。
解法是 `MutationObserver` 挂在 `document.body` 上（`childList` + `subtree`），
每次变更后用 `requestAnimationFrame` 去抖重绘。

### 6.4 布局不抖

圆点用 `position: absolute` 定位。如果行的 `position` 是 `static`，先改成 `relative`，
**并把这个行记进 `touched` 集合**；`dispose()` 时只还原 `touched` 里那些，
绝不覆盖应用自己设的 inline `position`（详见 7.3）。

---

## 7. 三个真 Bug（都是真实测试逼出来的）

### 7.1 `dispose()` 报成功，但点自己长回来了

**现象**：`dispose()` 断开 observer、`clearInterval`、逐个 `remove()` 掉 80 个点，
如实返回 `removed: 80`；5 秒后 `capture.mjs` 仍数到 **80 个点**，数量纹丝不动，
但 `window.__mmxStatus` 已 `delete`、`<style>` 已移除。

**定位**：写了个探针区分"惰性残留"和"仍在重绘"——数三次数量都不变，说明**不是还在重绘**，
是删完就冻结在那儿了。真正的机制是：

```
MutationObserver 回调 → scheduleApply() 排了一个 requestAnimationFrame
                                                        ↓
dispose() 跑完，删掉 80 个，报 removed: 80
                                                        ↓
那个【已排队】的 rAF 才触发 apply() → 又把 80 个点画回去
                                                        ↓
之后 interval 已被清空、observer 已断开，没人再刷 → 冻结在 80
```

**修法三件套**：

```js
var disposed = false;
var rafId = 0;

function apply() {
  if (disposed) return { skipped: 'disposed' };      // ①
  ...
}
function scheduleApply() {
  if (disposed || pending) return;                    // ①
  rafId = requestAnimationFrame(function () {
    if (disposed) return;                             // ①
    ...
  });
}
dispose: function () {
  disposed = true;                                    // ② 必须在删除之前
  observer.disconnect();
  clearInterval(timer);
  if (rafId) cancelAnimationFrame(rafId);             // ③
  ...
}
```

**通用判据**：凡是"清理函数返回成功但现场没变干净"，第一嫌疑不是清理逻辑写错，
而是**清理之后还有谁在跑**。先写一个"隔 N 秒再数一遍"的探针区分两种情况。

### 7.2 冷启动竞态：两个连续的空窗

目标一出现就注入，会连撞两堵墙：

**墙 1：target 还没出现。** `/json/version` 在浏览器进程起来就返回 200，
但 `app://./archon` 页面 target 要等渲染进程加载完。守护现在会等（90 秒预算）而不是报错退出。

**墙 2：`document.body` 还是 `null`。** target 出现了但 DOM 还没建，
`MutationObserver.observe(null)` 抛 `TypeError: parameter 1 is not of type 'Node'`，
整个 bootstrap 挂掉。注入脚本现在会先自旋等待可用的挂载点（15 秒预算）。

**墙 3（顺带）：** 新实例正在拉上千个会话时主线程很忙，单次 `Runtime.evaluate` 可能超时。
所有页面求值都走 `evaluateWithRetry`（3 次重试、间隔 1.5 秒），CDP 超时从 15 秒提到 30 秒。

### 7.3 dispose 误清宿主的内联样式

第一版 dispose 是 `document.querySelectorAll('[data-session-id]')` 全扫一遍，
凡是 `style.position === 'relative'` 就清空。问题是**应用自己也可能设内联 `position: relative`**，
那样会误删宿主的值。改成只还原 `touched` 集合里那些由本工具改动过的行。

另外长跑守护时 `touched` 会随虚拟滚动无限增长，加了剪枝：超过 64 条就丢弃已脱离文档的行。

---

## 8. 「永不自动展开」守卫

### 8.1 应用的真实行为

三条独立证据：

1. **源码**：`expanded: expandedSessionIds[id] ?? !1`（默认折叠），
   箭头靠 `` `${a ? "" : "-rotate-90"}` `` 旋转；同处还有应用自己的
   `useEffect(() => { td && tr(!1) }, [td])` 强制折叠逻辑 —— 展开折叠都归它管。
2. **受控对照实验**：记录展开状态 → 移除全部注入 → 再读。
   **展开状态逐字节一致**，证明本工具不参与展开。
3. **真实点击实测**：应用自动展开、点行主体、点标题、点箭头 —— **四种方式都会展开**。

> 顺带更正一个我自己犯过的错：早期版本我写了个"点行主体不会展开"的结论，
> 那是基于坐标错误的测试（见 9.1），结论是错的。

### 8.2 实现

```js
function enforceNoAutoExpand() {
  if (!cfg.collapseOnStart) return { collapsed: 0, skipped: 'disabled' };
  var sec = document.querySelector('[data-pinned-section]');
  if (!sec) return { collapsed: 0 };
  var rows = sec.querySelectorAll('[data-session-id]');
  var collapsed = 0;
  for (var i = 0; i < rows.length; i++) {
    var el = rows[i];
    if (!caretOf(el)) continue;
    if (!isExpanded(el)) continue;
    if (el.getBoundingClientRect().height <= 40) continue;
    if (clickCaret(el)) collapsed++;   // 点箭头压回去
  }
  return { collapsed: collapsed };
}
```

与上色同批执行（同一帧内），所以视觉上几乎看不到展开过程：

```js
requestAnimationFrame(function () {
  apply();                        // 上色
  api.enforceNoAutoExpand();       // 顺带压回任何展开
});
```

**不设任何例外**——包括"用户主动点箭头"也压回去。想要应用原本行为用 `--no-collapse`。

### 8.3 因果对照（决定性证据）

同一处真实鼠标点击，**只变守卫开关**：

```
[守卫关闭] +300ms=EXPANDED(h120) +900ms=EXPANDED(h120) +2000ms=EXPANDED(h120) => 展开
[守卫开启] +300ms=collapsed(h30)  +900ms=collapsed(h30)  +2000ms=collapsed(h30)  => 折叠
```

---

## 9. 踩过的坑（方法论价值大于代码价值）

### 9.1 假 PASS：坐标是 (x, 0)

用 CDP `Input.dispatchMouseEvent` 派发真实点击做验证时，如果没有先
`scrollIntoView({block:'center'})` 再取 `getBoundingClientRect()`，
元素未布局，**y 恒为 0**，点击打在视口外的空气里 → 什么都没发生 → 误判为"守卫有效"。

**我连续两次栽在这个坑里**，第一次还据此向用户报"PASS"。

**纪律**：任何点击类验证，必须①滚进视口 ②断言 `0 < y < innerHeight` ③再点。
脚本里已经内置这道断言，点不到就打印"坐标仍在视口外，跳过"而不是假装通过。

### 9.2 反引号截断模板字符串

注入脚本用 `String.raw` 模板字符串承载页面侧代码。我在注释里写了
`` // `disposed` is checked by... `` —— **反引号直接终止模板**，整个模块 SyntaxError。

**这个错我犯了三次。** 现在 selftest 里有硬检查：

```js
const tickCount = (rawSeg.match(/`/g) || []).length;
check('PAGE_FN 模板内反引号恰为 2 个（开+闭）', tickCount === 2, `实际 ${tickCount} 个`);
```

同族：`node e2e.mjs` 首行写 `# 注释`（只有 `#!` 是 shebang）也是 SyntaxError。

### 9.3 `Write-Host -NoNewline` 写成 `Write-NoNewline`

只测内层 `daemon.mjs` 就宣称完成，结果主上唯一要用的入口 `start-mmx-status.ps1`
第一次跑就炸。补测后连抓三个真 bug（详见 7.1、以及下面这条）：

`Start-Process -ArgumentList` 把数组元素**用空格拼成一条命令行**，
工作区路径 `G:\mmx-project\fix mmx\` 含空格被从 `G:\mmx-project\fix` 处切断：

```
Error: Cannot find module 'G:\mmx-project\fix'
```

**修法**：`-File` 的值手工包一层引号 —— `'"' + $path + '"'`。

**纪律：只测内层不测入口，等于用内层的绿担保用户的体验。**

### 9.4 UTF-8 无 BOM 的 `.ps1` 在 PowerShell 5.1 下直接解析崩溃

**这是本项目唯一一个会让用户「照 README 跑就炸」的坑**，而且它伪装成语法错误。

`launch-mmx-status.ps1` 里有中文，存成 **UTF-8 无 BOM + LF**。
用 pwsh 7.6.6 解析：**0 errors**。用 Windows PowerShell 5.1 解析：**6 errors**：

```
line  16: Missing expression after ','.
line 100: The Try statement is missing its Catch or Finally block.
line 106: Unexpected token '}' in expression or statement.
line 210: The string is missing the terminator: '.
line 209: Missing closing '}' in statement block or type definition.
line 158: Missing closing '}' in statement block or type definition.
```

`line 210` 那行原文是 `Write-Log "CDP 端口 $port 未就绪，启动 daemon 无意义，放弃。" 'ERROR'`
—— 引号明明配对，却报 `string is missing the terminator`。
**报错行号是假象**，真正的原因在文件开头：

| PS 版本 | 无 BOM 的读取方式 | 中文 `端口` 的解码 |
|---|---|---|
| pwsh 7 | 始终按 UTF-8 | 正确 |
| PS 5.1 | 无 BOM 时按系统 ANSI 代码页（本机 GBK） | **错位** |

GBK 解码产生的非法字节被解析器当成语法符号，于是从文件开头一路报错下来。
`line 16` 是 `#>`（注释块结尾）被点炸，就是最早出错的位置。

**判别实验**（三组对照，因果一目了然）：

| 文件 | 含中文 | BOM | PS 5.1 解析 |
|---|---|---|---|
| `launch-mmx-status.ps1` | 是 | 无 | **FAIL 6** |
| `uninstall-launcher.ps1` | 是 | 无 | **FAIL 6** |
| `start-mmx-status.ps1` | 是 | 无 | **FAIL 2** |
| `make-mmx-icon.ps1` | 是 | **有** | **OK** |
| `relaunch-cdp-delayed.ps1` | 是 | **有** | **OK** |
| `test-launcher.ps1` | 否（纯 ASCII） | 无 | **OK** |

含中文 + 无 BOM → 全挂；含中文 + 有 BOM → 全过；纯 ASCII + 无 BOM → 照过。
**变量只有 BOM 一个**，因果闭合。

修法是给全部 `.ps1` 补 UTF-8 BOM 并统一 CRLF：

```powershell
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$utf8Bom   = [System.Text.UTF8Encoding]::new($true)
$text = [System.IO.File]::ReadAllText($path, $utf8NoBom)
$text = $text -replace "`r`n","`n" -replace "`n","`r`n"   # 幂等，重复跑不叠加
[System.IO.File]::WriteAllText($path, $text, $utf8Bom)
```

**不要用 `Get-Content | Set-Content`**：PS 5.1 的那条管道会再写一次 BOM，
而且会改内容。字节级 `ReadAllText` / `WriteAllText` 才可控。

**怎么证明"只改了编码、没改内容"**：把修好的文件去 BOM、CRLF 转回 LF，
与修复前的旧副本逐字节比对。本项目 7 个文件全部 `YES`——
BOM 和行尾变了，**内容一个字节没动**。

> ⚠️ 本项目的 `.ps1` 全部以 **UTF-8 with BOM + CRLF** 提供。
> 如果你 fork 后用编辑器另存，务必确认这两项——症状就是"在 pwsh 里好好的，双击却报错"。

---

## 10. 完整使用手册

### 10.1 环境要求

- Node **22.5+**（需要 `node:sqlite`；本机 24.18.0）
- MiniMax Code 桌面端
- 零第三方依赖
- `.ps1` 脚本为 **UTF-8 with BOM + CRLF**，Windows PowerShell 5.1 与 pwsh 7 均可直接运行

### 10.2 首次使用

```powershell
git clone https://github.com/tcflying/minimax-code-sidebar-status.git
cd minimax-code-sidebar-status\src

# 看看会执行什么，不真跑
.\start-mmx-status.ps1 -DryRun

# 正式启动（会提示重启 MiniMax Code）
.\start-mmx-status.ps1
```

> ⚠️ 首次会结束当前 MiniMax Code 进程树后用 CDP 参数重启。进行中的会话存在
> SQLite 里，重启后从侧边栏点回去即可恢复。

### 10.3 日常使用

以后每次都从启动器开：

```powershell
.\start-mmx-status.ps1          # 交互式，检测到未开 CDP 会问你要不要重启
.\start-mmx-status.ps1 -Force   # 无人值守，直接重启不询问
.\stop-mmx-status.ps1           # 一键完全还原，停止守护
```

`Read-Host` 读控制台，无法用管道喂输入，所以脚本化必须加 `-Force`。

### 10.4 全部命令行参数

```
node daemon.mjs
  --port <n>        CDP 端口（默认 9351）
  --db <path>       数据库路径（默认 ~/.minimax/v2/sqlite/runtime-state.sqlite）
  --interval <ms>   轮询间隔（默认 2500）
  --once            跑一次就还原
  --offsetX <px>    圆点左右位置（默认 4）
  --show-done       给"已完成"也打灰点（默认关，233 个灰点噪音太大）
  --show-aborted    把"主动取消"也算暂停（默认关）
  --no-collapse     关闭"永不展开"守卫
  --active-bg <css>       选中行底色（默认 rgba(10,10,10,0.10)）
  --active-bg-hover <css> 选中行 hover 底色（默认 rgba(10,10,10,0.14)）
  --active-bar <css>      选中行左侧色条（默认 rgba(0,148,252,0.90)，传 transparent 关掉）
```

### 选中行底色

应用自己的选中底色是 `rgba(10,10,10,0.04)`——只有 4% 不透明度，在高 DPI 屏上几乎看不出来。
本工具把它加深到 **10%** 并加一条 **3px 蓝色左边条**。

**怎么找到的**：`[data-session-id]` 行本身既没有 class 也没有背景，
`aria-current` / `data-active` 都不在它上面。最终在源码里挖到判据——
行组件 `ti` 的 `U = activePage === null && activeSessionId === session.id`，
选中时给该行的 `<button>` 加**裸类** `bg-bg_interaction_tertiary_hover`，
未选中行只带 `hover:` 变体。因为 class 选择器按整 token 匹配，
`button.bg-bg_interaction_tertiary_hover` 天然只命中选中行。

覆盖规则：

```css
[data-session-id] button.bg-bg_interaction_tertiary_hover
  :not([class*="hover:bg-bg_interaction_tertiary_hover"]) {
  background-color: var(--mmx-active-bg) !important;
  box-shadow: inset 3px 0 0 0 var(--mmx-active-bar);
}
```

实测：覆盖前 `rgba(10,10,10,0.04)` → 覆盖后 `rgba(10,10,10,0.1)`，
`boxShadow` 出现 `rgba(0,148,252,0.9) 3px 0px 0px 0px inset`，
未选中行不受影响（`verify-active-bg.mjs` 自动断言这一点）。

换成别的颜色：

```powershell
# 更深
node daemon.mjs --active-bg 'rgba(10,10,10,0.16)'
# 淡蓝底 + 不要色条
node daemon.mjs --active-bg 'rgba(0,148,252,0.10)' --active-bar 'transparent'
# 深色主题（跟随应用时把 alpha 调低）
node daemon.mjs --active-bg 'rgba(255,255,255,0.10)'
```

### 10.5 排查工具

| 脚本 | 用途 |
|---|---|
| `node capture.mjs --port 9351 --out shot.png` | 截侧边栏 + 打印注入统计 |
| `node verify-guard-causal3.mjs --port 9351` | 守卫因果对照（只变开关） |
| `node verify-never-expand.mjs --port 9351` | 真实点击标题/箭头后检查是否展开 |
| `node diagnose-expand-owner.mjs --port 9351` | 展开状态归因 + localStorage 键 |
| `node diagnose-collapse-stick.mjs --port 9351` | 手动折叠能不能粘住 |
| `node debug-guard.mjs --port 9351` | 守卫是被调用了还是调用了没压住 |
| `node diagnose-dots.mjs --port 9351` | 区分"惰性残留"和"仍在重绘" |

---

## 11. 测试体系

```
node selftest.mjs                              110 项 · 不需要 CDP
node watchdog-selftest.mjs                     74 项 · 不需要 CDP
node test-autofix-gates.mjs                    32 项 · 不需要 CDP
node e2e.mjs --port 9351                       19 项 · 需要已开 CDP 的实例
pwsh -NoProfile -File test-launcher.ps1        20 项 · 自建一次性实例
```

| 套件 | 覆盖 |
|---|---|
| `selftest` | 桶映射规则 / 真实库只读 / 注入表达式语法 / **无破坏性 DOM 调用** / dispose 回归 / 反引号守卫 |
| `watchdog-selftest` | 双路端口发现 / 单实例锁 / 僵尸回收 / 退避节奏 |
| `test-autofix-gates` | `--fix-app` 三道闸门，**每道都配正例 + 反例** |
| `e2e` | 真实渲染进程闭环：注入 → 刷新精确删 1 → 归零 → **10 秒不复活** → 重注入幂等 |
| `test-launcher` | 启动器 DryRun / 冷启动 / 停止三分支，**全程不碰主实例** |

`test-launcher.ps1` 会自建一次性实例（独立 `user-data-dir` + 独立端口），
测试前后主实例进程数必须一致。

### ⚠️ e2e 有一个环境陷阱：先确认没有 daemon 在跑

`e2e` 的「还原后 10 秒不复活」断言，在**守护进程同时在跑**时必然失败：

```
FAIL  +4000ms 仍为 0 :: dots=88
```

这不是产品回归。`daemon.mjs --interval 2500` 每 2.5 秒会把点重新画回来，
测试刚归零它就补上了。跑 e2e 前先确认没有 `daemon.mjs` 进程：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*mmx-status*daemon*' }
```

**判据纪律**：环境冲突和真回归长得一模一样（都是「assertion failed」），
必须先做上面这步**消歧**再下结论，不能直接把失败当成 bug 去改产品代码。

### 反过来的坑：改完 page-script 必须重启 daemon

`daemon.mjs` 在**启动时读一次** `lib/page-script.mjs` 之后常驻内存。
改了注入脚本不重启守护，它会忠实地把**旧版样式**一遍遍重画回来：

| 观察到的现象 | 真实原因 |
|---|---|
| 状态点数量正常（88 个） | 旧版逻辑也在画点 |
| 但汇总条 `exists: false` | 旧版 page-script 根本不知道汇总条 |
| running 行退回 6×6 圆点、底色全透明 | 旧版样式 |

**看到"数量对但样式是旧的"，第一反应应该是"守护没重启"，而不是"注入没生效"。**

---

## 12. 已知边界

| 事项 | 状态 |
|---|---|
| 侧边栏虚拟滚动，只有当前渲染的行能上色 | 滚动时 observer 自动补 |
| 状态点是纯装饰，不改变任何业务行为 | 设计如此 |
| 展开守卫会与应用争 React 状态 | 同帧执行，视觉上无感；`--no-collapse` 可关 |
| 桌面端源不开源，升级后锚点可能变 | 锚点只有 `data-session-id` 一个，稳定性较好 |
| 只覆盖**置顶区** | 项目分组区由应用自己的列表渲染，同样带 `data-session-id`，也已覆盖 |
| macOS 未实测 | 启动参数与 Windows 略有差异（`-na <app> --args`） |

---

## 13. 安全边界

- CDP **仅绑定 127.0.0.1**，不开外部端口。
- 数据库以 `readOnly: true` 打开，**只读不改**，与运行中的客户端零冲突。
- 注入的每个节点都带 `data-mmx-dot` 标记，`dispose()` 全部移除并还原自有内联样式。
- 不读、不写、不记录任何 API Key、聊天正文、账号凭据。
- 不改 `app.asar`，不改 Agent Runtime，不改权限模型。

---

## 14. 重启后自愈链路（本轮新增）

"重启 MiniMax Code 后侧边栏又全恢复了" —— 这不是一个 bug，是**四层独立根因同时存在**。
只修任何一层都不会好。

### 14.1 四层根因

| # | 根因 | 现象 | 证据 |
|---|---|---|---|
| 1 | 启动入口不带 CDP 参数 | 从开始菜单 / 桌面图标启动，注入器永远接不上 | `.lnk` 的 `Arguments` 为空 |
| 2 | 守护进程被异步 reject 打死 | 跑了几小时后整个 Node 进程消失 | `Error: CDP 超时(30000ms): Runtime.evaluate` |
| 3 | 页面重载后永不重连 | 界面闪一下点全没了，守护还活着但空转 | 日志连续 `{"ok":false,"reason":"not-installed"}` |
| 4 | **官方更新器按名字覆盖快捷方式** | 手工改好的 `.lnk` 过几天自己变回无参数直连 | 见下 |

第 2 条的机制最容易重犯，值得单说：

```js
// ❌ try/catch 对异步 reject 完全无效
setInterval(() => {
  try {
    const p = session.evaluateWithRetry(expr);
    if (i % 10 === 0) p.catch(noop);   // 只有 1/10 的分支挂了 catch
  } catch {}
}, 2500);
// 其余 9/10 的 tick 是裸奔 promise → unhandledRejection
// → Node 24 默认 --unhandled-rejections=throw → 整个进程死
```

第 3 条最隐蔽：刷新返回 `not-installed`（`window.__mmxStatus` 随新文档消失），
守护只把它当一次普通失败记一行，**从不重新 bootstrap**。实测
`tick 30: ok:true` → `tick 40/50: not-installed`，进程活着但注入永不再回。

第 4 条最阴险，因为它让前三条的修复**看起来是失效的**。
时间线（实测）：

```
2026-09-29 22:25   app.asar 被官方更新器替换（426 MB）
2026-09-30 20:56   桌面 MiniMax Code.lnk 被改回无参数直连
2026-10-01 02:56   开始菜单 MiniMax Code.lnk 被改回无参数直连
```

官方更新器**按快捷方式名字**找 `.lnk` 并覆盖。你手工改好，三天后它自己改回去，
而你会以为是前三条的修复不work。

**治本办法：不要用官方名字。** 唯一命名一个 `mmx-fix.lnk`，
官方更新器不认识这个名字，就永远碰不到它。

| 入口 | 指向 | 用途 |
|---|---|---|
| `mmx-fix.lnk`（红色 M 图标） | `launch-mmx-status.ps1` | ✅ **唯一正确入口**，官方更新不会覆盖 |
| `MiniMax Code.lnk` | 应用 exe，无参数 | 官方直连（保持原样，不动） |
| 开始菜单 `MiniMax Code.lnk` | 应用 exe，无参数 | 官方直连（保持原样，不动） |

### 14.2 解法

```
开机自启 ──► watchdog.mjs 常驻
                 ├─ 探测应用是否在跑
                 ├─ 发现 CDP 端口（DevToolsActivePort 文件 + 命令行，双路互证）
                 └─ 守护没了？──► 拉起 daemon.mjs
                                       └─ 注入掉了？──► 重新 bootstrap
```

- **快捷方式改写**：新建 `mmx-fix.lnk` 指向 `launch-mmx-status.ps1`
  （`-WindowStyle Hidden` 无窗口），配自绘红色 M 图标。**不改官方那两个 `.lnk`**
- **端口自动发现**：绝不写死。优先读 Electron 自己写的
  `%APPDATA%\<App>\DevToolsActivePort`（内容形如 `9331\n/devtools/browser/<uuid>`，
  取第一行要 `trim`，Windows 上常见 CRLF），再用进程命令行兜底
- **默认不碰任何进程**：`APP_UP_NO_CDP` 时只告警不动进程
- **不碰官方自启项**：`com.minimax.agent.cn` 只读打印，从不改写

### 14.3 `--fix-app` 的三道闸门

自动修复应用（杀掉没带 CDP 参数启动的实例并重启）**必须显式加 `--fix-app` 才启用**。
但光加个开关就动手是危险的——冷启动中的应用会先经历一段"还没开 CDP"的正常窗口，
`APP_UP_NO_CDP` 在这窗口里是**真实现象**，不是故障。

原实现第一次遇到就动手，实测触发了 12 次修复，**打断过正在进行的编辑**。
现在加三道闸门，三道全过才动进程：

| 闸门 | 参数 | 含义 | 不加会怎样 |
|---|---|---|---|
| 连续未恢复次数 | `fixAppAfter: 6` | 连续 6 次探测失败（约 30 秒）才动手 | 冷启动一个瞬时失败就杀进程 |
| 启动时长 | `minUptimeMs: 45000` | 应用启动不足 45 秒一律视为冷启动 | 刚双击就杀 |
| 退避 | `nextFixAt` | 每次修复后按 `backoffDelayMs` 推迟下次尝试 | 修完立刻又判失败，来回杀 |

动手前还会先 `reapStaleDaemons()` 清掉僵尸守护，避免"多个旧 daemon 一起报状态"污染判断。
通道正常时多余 daemon 只留一个。

```powershell
# 每天用：纯观察，绝不打断
node watchdog.mjs --port 9331

# 只有确认自己需要自动修复时才加
node watchdog.mjs --port 9331 --fix-app
```

**本项目默认关闭 `--fix-app`**，日常靠 `mmx-fix` 图标启动即可。

### 14.4 端口写死是隐患

实测同一个应用在不同时期跑过 **9351 / 9352 / 9331** 三个端口。
任何把端口写进配置的做法都会在某次重启后失效。

### 14.5 安装与还原

```powershell
# 先干跑，确认不动任何东西
pwsh -NoProfile -File .\src\install-launcher.ps1 -DryRun
pwsh -NoProfile -File .\src\install-launcher.ps1

# 还原
pwsh -NoProfile -File .\src\uninstall-launcher.ps1
```

`uninstall` 把 `.lnk` 从 `.lnk.bak` 原样拷回，并删掉自己加的 `Run\mmxStatusWatchdog`。
没有 `.bak` 的图标只跳过不删（保守，避免毁掉官方图标）。

### 14.6 怎么验证"重启后真的能恢复"

```powershell
node .\tests\reload-e2e.mjs 9331 45000        # 强制 Page.reload，验证自恢复
node .\tests\watchdog-heal-e2e.mjs 9331        # 杀掉守护，验证 watchdog 自愈
```

`reload-e2e.mjs` 里有一条**判据自证**值得单独说：reload 前往页面写一个
`window.__probeMark` 标记，reload 后必须确认标记已消失；否则判定"reload 根本没发生"、
这次 PASS 是假的。没有这条，一个还没被换掉的旧文档就能骗出满分。

---

## 15. 视觉增强：让 running 真的看得见（本轮新增）

### 15.1 问题：6px 圆点被噪音淹没

初版给三种状态打同样大小的 6px 圆点。本机实测分布：

```
running  1 个
paused   66 个
error    21 个
```

**1 个 running 夹在 87 个同级噪音里**，颜色再准也扫不出来。
"加亮一点"是无效的——问题不是对比度，是**形状和面积没区分**。

### 15.2 解法：running 用形状而非颜色区分

四种信号叠在一起，任意两种失效都还能读出来：

| 通道 | 实现 | 实测值 |
|---|---|---|
| 形状 | 左侧 **4px × 24px 竖条**，不是 6px 圆点 | `4px x 24px` |
| 发光 | `box-shadow: 0 0 6px 1px rgba(34,197,94,.75)` | `rgba(34, 197, 94, 0.75) 0px 0px 6px 1px` |
| 呼吸 | `__mmxBar 1.6s` 动画 | `__mmxBar 1.6s` |
| 整行底色 | `rgba(34,197,94,0.10)`，邻居全为 `rgba(0,0,0,0)` | `rgba(34, 197, 94, 0.1)` |
| 标题色 | `#15803d`（落在 `span.shimmer-text__content` 上，**不是** button 本身） | `rgb(21, 128, 61)` |

error 圆点 6px → 8px；paused 保持 6px；done 不显示。
**验证时必须打印邻居行的底色**——只看自己那行是 `rgba(34,197,94,0.1)` 说明不了问题，
证明"没影响到别人"要看 6 个邻居全是 `rgba(0,0,0,0)`。

### 15.3 顶部「N 个运行中」汇总条

需求原话是"把在跑的自动移到置顶最上面"。**实测这条路走不通**，见 15.4。
改做汇总条：在置顶区标题行正下方插一条胶囊，回答同一个问题——**有几个在跑**。

```
置顶
┌──────────────────────────────────┐
│ ▎ 2 个运行中                      │  ← #mmx-running-summary
└──────────────────────────────────┘
  ○ 对比多个 codex 集成 ChatGPT 的项目
  ...
```

**插入位置是算出来的，不是猜的**。置顶区 `[data-pinned-section]` 的子节点结构实测为：

```
index 0  标题行（30px flex）
index 1  ← 汇总条插这里
index 2  折叠动画容器（grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity]）
```

**必须避开 index 2**——那是应用的折叠动画容器，往里插节点会直接搞坏展开动画。

**前缀是闪烁竖条，不是圆点。** `step-end`（实测序列化为 `steps(1)`）给的是硬开关边缘，
眼睛会锁上去；平滑淡入淡出只会变成又一次慢脉冲，重新混进列表噪音里。

实测断言：

```
exists: true, text: "2 个运行中", shown: 2, paintedRunning: 2, countMatches: true
display: flex, height: 23, width: 366, bg: rgba(34, 197, 94, 0.16)
box-shadow: rgba(34, 197, 94, 0.45) 0px 0px 0px 1px inset
indexInSection: 1, prevIsHeader: true, nextIsListGrid: true, visible: true

前缀竖条 <i>：
  3px × 13px  linear-gradient(rgb(74,222,128), rgb(22,163,74))
  box-shadow rgba(34,197,94,0.7) 0 0 5px
  animation __mmxBlink 1.2s  timing-function steps(1)  iteration infinite
```

`countMatches: true` 是关键——**条上写的数字必须等于实际 running 行数**，
不是写死一个数。

**没有新增任何 DOM 节点**：把 `ensureSummary()` 里早就建好的那个 `<i>` 指示点
从「呼吸圆点」改样式成「闪烁竖条」，`#id i { … }` 一条 CSS 规则的事。
建节点逻辑一行没改，所以 React 冲突面为零。无 running 时置
`data-mmx-empty="1"` 自动隐藏。

### 15.4 为什么不能让 running 行自动置顶（实测判死）

试过 CSS `order`，判死。完整证据链：

| 尝试 | 结果 |
|---|---|
| CSS `order` | 排序容器 `DIV.relative.min-h-[4px].space-y-px` 的 `display` 是 **`block`**，不是 flex/grid → `order` 无效 |
| 全页面扫描"直接子级是 session 行"的容器 | `containerCount: 0` —— **一个都没有** |
| `insertBefore` 搬 DOM | 直接吃 `NotFoundError`（行不是置顶区的直接子节点） |

真实结构是：每行都被包在自己的**单层 `div`** 里（实测 29 个单子节点包装器）。
所以剩余方案只有 C1（搬 DOM）和 C2（绝对定位），**两者都要和 React 抢 DOM 所有权**，
伴随折叠动画错乱、虚拟列表测高失准的风险。

**判据纪律**："CSS order 不生效"这种结论不能靠 `getComputedStyle` 推断完事——
必须同时给出"目标容器的 `display` 是什么"和"它有没有满足 order 生效的前提"。
本例两条都指向否定，才算判死。

---

## 16. 目录结构

```
minimax-code-sidebar-status/
├── README.md                    ← 本文档
├── docs/
│   ├── 01-investigation.md      完整调查记录
│   ├── 02-cdp-injection.md      CDP 原理与注入细节
│   ├── 03-status-semantics.md   状态语义与真实数据
│   ├── 04-never-expand.md       永不展开守卫
│   ├── 05-bugs.md               三个真 bug 复盘
│   ├── 06-testing.md            测试体系与假 PASS 陷阱
│   └── update-break-sidebar-injection.md
│                                    官方更新如何打断注入（第四层根因）
├── tests/                       ← 本轮新增：跨进程真实验证
│   ├── reload-e2e.mjs           强制 Page.reload，验证自恢复（含判据自证）
│   ├── watchdog-heal-e2e.mjs    杀守护，验证 watchdog 自愈（两种残留态）
│   ├── check-inject.mjs         独立进程查真实 DOM
│   ├── check-active.mjs         选中行底色独立复核
│   └── rebootstrap.mjs          一次性重新注入
├── assets/
│   └── mmx-fix.ico              自绘红色 M 图标（7 档尺寸，16~256）
└── src/
    ├── daemon.mjs               守护主程序（重连 / 重注入 / 致命兜底）
    ├── watchdog.mjs             常驻看门狗（双路端口发现 + 单实例锁 + 三闸门）
    ├── watchdog-selftest.mjs    74 项自测
    ├── test-autofix-gates.mjs   --fix-app 三闸门测试（32 项，每闸门正例+反例）
    ├── reload-recovery.mjs      重载后自恢复验证
    ├── launch-mmx-status.ps1    无窗口启动器（mmx-fix.lnk 指向它）
    ├── install-launcher.ps1     安装：建 mmx-fix.lnk + 加开机自启
    ├── uninstall-launcher.ps1   还原
    ├── relaunch-cdp-delayed.ps1 延迟带 CDP 参数重启
    ├── make-mmx-icon.ps1        GDI+ 生成 mmx-fix.ico
    ├── start-mmx-status.ps1     原始启动器（带 CDP 参数拉起客户端）
    ├── stop-mmx-status.ps1      还原 + 停守护
    ├── cleanup.mjs              页面侧还原
    ├── capture.mjs              截图 + 状态探针
    ├── selftest.mjs             110 项自测
    ├── e2e.mjs                  19 项端到端
    ├── test-launcher.ps1        20 项启动器测试
    ├── verify-guard-causal3.mjs 守卫因果对照
    └── lib/
        ├── cdp.mjs              零依赖 CDP 客户端
        ├── page-script.mjs      注入脚本（核心：状态点 + running 竖条 + 汇总条）
        └── status-db.mjs        只读状态读取 + 桶映射
```

---

## 17. 致谢

- 第三方项目 [`sqing33/minimax-code-skin`](https://github.com/sqing33/minimax-code-skin)
  首次证明了 CDP 路线在 MiniMax Code 上可行。**但要注意**：它的 subagent 识别在真机上
  大概率失效——key 的 `data-agent-type` / `data-agent-kind` / `data-session-type` /
  `role="treeitem"` 在真实 asar 里**全部 0 命中**，测试 fixture 是编造的。
  本项目改用 `data-session-id` + SQLite 直查，绕开了识别问题。
- MiniMax Code 官方文档 <https://agent.minimaxi.com/docs/llms.txt>

MIT License.
