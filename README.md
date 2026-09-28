# MiniMax Code 侧边栏会话状态点 —— 完整实现教程

> 给 MiniMax Code 桌面端侧边栏的每个会话加一个状态小圆点：
> 🟢 正在跑 / 🟡 被中断需处理 / 🔴 出错。
>
> **不修改 `app.asar` 一个字节**，不改 Agent Runtime、权限和业务逻辑，可一键完全还原。
> 附赠「永不自动展开」守卫。

实测环境：MiniMax Code 3.0.74 / Electron 42.8.0 / Chromium 148 / Windows 11 (26200) / Node 24.18.0

---

## 0. 结论速览

| 需求 | 官方能力能做到吗 | 本方案 |
|---|---|---|
| 会话行加状态点 | ❌ 无任何 UI 扩展点 | ✅ CDP 注入，已实测 |
| 侧边栏按状态筛选 | ⚠️ 内置筛选器**不覆盖置顶区** | ✅ 两个区域都覆盖 |
| 选中行底色加深 | ⚠️ 应用默认 `rgba(10,10,10,0.04)`，很淡 | ✅ 覆盖为 10% + 蓝色左条，可调 |
| 会话永不自动展开 | ❌ 应用强制行为，无设置 | ✅ 持续无条件折叠守卫 |
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

## 9. 测试里踩的三个坑（方法论价值大于代码价值）

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

---

## 10. 完整使用手册

### 10.1 环境要求

- Node **22.5+**（需要 `node:sqlite`；本机 24.18.0）
- MiniMax Code 桌面端
- 零第三方依赖

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
node selftest.mjs                              41 项 · 不需要 CDP
node e2e.mjs --port 9351                       18 项 · 需要已开 CDP 的实例
pwsh -NoProfile -File test-launcher.ps1        20 项 · 自建一次性实例
```

| 套件 | 覆盖 |
|---|---|
| `selftest` | 桶映射规则 / 真实库只读 / 注入表达式语法 / **无破坏性 DOM 调用** / dispose 回归 / 反引号守卫 |
| `e2e` | 真实渲染进程闭环：注入 → 刷新精确删 1 → 归零 → **10 秒不复活** → 重注入幂等 |
| `test-launcher` | 启动器 DryRun / 冷启动 / 停止三分支，**全程不碰主实例** |

`test-launcher.ps1` 会自建一次性实例（独立 `user-data-dir` + 独立端口），
测试前后主实例进程数必须一致。

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

## 14. 目录结构

```
minimax-code-sidebar-status/
├── README.md                    ← 本文档
├── docs/
│   ├── 01-investigation.md      完整调查记录
│   ├── 02-cdp-injection.md      CDP 原理与注入细节
│   ├── 03-status-semantics.md   状态语义与真实数据
│   ├── 04-never-expand.md       永不展开守卫
│   ├── 05-bugs.md               三个真 bug 复盘
│   └── 06-testing.md            测试体系与假 PASS 陷阱
└── src/
    ├── daemon.mjs               守护主程序
    ├── start-mmx-status.ps1     启动器（带 CDP 参数拉起客户端）
    ├── stop-mmx-status.ps1      还原 + 停守护
    ├── cleanup.mjs              页面侧还原
    ├── capture.mjs              截图 + 状态探针
    ├── selftest.mjs             41 项自测
    ├── e2e.mjs                  18 项端到端
    ├── test-launcher.ps1        20 项启动器测试
    ├── verify-guard-causal3.mjs 守卫因果对照
    └── lib/
        ├── cdp.mjs              零依赖 CDP 客户端
        ├── page-script.mjs      注入脚本（核心）
        └── status-db.mjs        只读状态读取 + 桶映射
```

---

## 15. 致谢

- 第三方项目 [`sqing33/minimax-code-skin`](https://github.com/sqing33/minimax-code-skin)
  首次证明了 CDP 路线在 MiniMax Code 上可行。**但要注意**：它的 subagent 识别在真机上
  大概率失效——key 的 `data-agent-type` / `data-agent-kind` / `data-session-type` /
  `role="treeitem"` 在真实 asar 里**全部 0 命中**，测试 fixture 是编造的。
  本项目改用 `data-session-id` + SQLite 直查，绕开了识别问题。
- MiniMax Code 官方文档 <https://agent.minimaxi.com/docs/llms.txt>

MIT License.
