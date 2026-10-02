# MiniMax Code 侧边栏会话状态点 —— 完整实现教程

> 给 MiniMax Code 桌面端侧边栏的每个会话加一个状态小圆点：
> 🟢 正在跑 / 🟠 被中断需处理 / 🟡 在等子 agent / 🔴 出错。
>
> **不修改 `app.asar` 一个字节**，不改 Agent Runtime、权限和业务逻辑，可一键完全还原。
> 附赠「永不自动展开」守卫、重启自愈链路、顶部「N 个运行中 · M 个在等子任务」汇总条。

实测环境：MiniMax Code 3.0.74 / Electron 42.8.0 / Chromium 148 / Windows 11 (26200) / Node 24.18.0

---

## 0. 结论速览

| 需求 | 官方能力能做到吗 | 本方案 |
|---|---|---|
| 会话行加状态点 | ❌ 无任何 UI 扩展点 | ✅ CDP 注入，已实测 |
| running 一眼可见 | ❌ 无 | ✅ 四重信号：发光竖条 + 整行淡绿底 + 绿标题 + 呼吸动画 |
| 一眼看到"有几个在跑" | ❌ 无 | ✅ 顶部「N 个运行中」汇总条 |
| 等子 agent 的会话也看得见 | ❌ 无 | ✅ 新增 `waiting` 黄色桶，本行同样置顶（见 15.6） |
| **云端会话也有状态点** | ❌ 云端行 id 不在本地库，永无状态 | ✅ 订阅宿主事件总线累积状态，**倒序重放防复活**（见 15.7） |
| running 行自动置顶 | ❌ 无 | ✅ **搬 DOM 排序，不改宿主样式**（默认开启，`--no-reorder` 可关，见 15.5） |
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

`app.asar` 头部是一个 JSON 索引，记录每个文件的 size/offset/integrity。

> **尺寸口径（两处数字不是同一个东西，别混）**
>
> | 数字 | 含义 | 观测时点 |
> |---|---|---|
> | 531,928,215 字节（≈507 MiB） | 调查期解包时该版本的整包大小，46,859 个文件 | 2026-09-28 前后（见 2.1 的 python 脚本读的就是这个文件） |
> | 426,404,876 字节（≈406.7 MiB） | **当前** `G:\MiniMax\MiniMax Code\resources\app.asar` 实测大小，`LastWriteTime = 2026-09-29 22:25:34` | 2026-10-02 复核 |
>
> 两者不是同一个东西：官方更新器在 2026-09-29 22:25 换过一次包（见 14.1 第 4 条时间线），
> 换的是**新版本的 app.asar**，不是"整包变了"。所以 14.1 里那个 426 MB 的说法指的就是
> 今天这个文件本身，而 2.1 的 531,928,215 指的是调查当时那个版本。
> 写文档时凡提到尺寸，必须带时点和口径，否则就是新的"文档与代码不符"。

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

### 5.2 真实分布（2026-10-02 实测，本机 1712 个会话）

用 `node:sqlite` 以 **`readOnly: true`** 打开 `runtime-state.sqlite` 现场统计（见 5.5）：

```
status:  idle 1342 / aborted 173 / interrupted 122 / error 71 / started 4
outcome: completed 861 / aborted 154 / NULL 111 / failed 57
child:   parent_session_id 非空 517 条（子代理）；另有 archived<>0 共 205 条
```

`local_runtime_background_tasks` 的 `kind × status` 分布：

| kind | succeeded | failed | canceled | lost | **running** | 合计 |
|---|---|---|---|---|---|---|
| `bash` | 7026 | 636 | 59 | 31 | **5** | 7757 |
| `subagent` | 338 | 13 | 17 | 16 | **2** | 386 |

> 这是**活库快照**，`bash` 那一列随时间持续增长（复测时已到 7763）；
> 终态几列基本不再变。真正有意义的是最后两列——
> **同一时刻正在跑的是 5 个 shell + 2 个子 agent，量级差 2.5 倍，全表累计量级差 20 倍。**
> 这个比例就是 5.3 里 `kind='subagent'` 过滤必须存在的全部理由。

### 5.3 关键设计判断

**`aborted` 不算"暂停"。** 173 个 `aborted` 是用户主动取消的，属**终态**；
把它们标橙会淹掉 122 个真正需要关注的 `interrupted`（运行时重启导致 turn 未完成）。

| 桶 | 判定 | 颜色 |
|---|---|---|
| running | `status = 'started'` | 🟢 绿（带呼吸动画） |
| waiting | 有子会话或子 agent 后台任务在跑（**判据不要求**父会话自己是 `started`，见 5.4） | 🟡 黄（带慢呼吸动画） |
| paused | `status = 'interrupted'` | 🟠 橙点 |
| error | `status = 'error'` 或 `outcome = 'failed'` | 🔴 红 |
| done | `status='idle'` 且 `outcome='completed'` | 无点（默认） |
| idle | 其余（含 aborted） | 无点 |

> ⚠️ **颜色重新分配过，别照着旧文档认。** `paused` 原来是 🟡 黄，
> 现在让给了 `waiting`，`paused` 改成 🟠 橙。两套语义必须分开：
> 看到**橙点**想到 paused（这行需要我处理），看到**黄底**想到 waiting（这行在等我）。
> 同一份文档里两个都叫黄会直接导致误读。橙色沿用应用自己的
> `var(--orange_400,#f59e0b)`，黄色见 15.6。

`--show-done` / `--show-aborted` 两个开关可以放宽。

### 5.4 waiting 为什么必须查第二张表

`local_runtime_sessions` 只能覆盖"**子会话已经建起来之后**"。判据 A 是
"存在一行 `parent_session_id = X` 且 `status='started'`"，可子 agent 在被写成
独立会话行之前，`local_runtime_background_tasks` 里**已经**有一行在跑了——
这中间有个时间窗，只查子会话表会漏掉。判据 B 补的就是这个窗。

#### 三条判据

```sql
-- A：存在正在跑的子会话
SELECT 1 FROM local_runtime_sessions
 WHERE parent_session_id = X AND status = 'started' AND archived = 0

-- B：存在正在跑的子 agent 后台任务
SELECT 1 FROM local_runtime_background_tasks
 WHERE owner_session_id = X AND status = 'running'
   AND ended_at_ms IS NULL AND kind = 'subagent'
```

A 或 B 任一成立即判 `waiting`。

#### 但判据命中 ≠ 一定染黄：还有一道优先级

判据只是"这个会话名下有活"。真正决定**画不画黄**的是 overlay 的优先级：

```
error  >  running  >  paused  >  waiting  >  done / idle
```

只有**当前不是更高级信号**的会话才会被 waiting 接走。这条守卫是**实测加上去的**：

| 做法 | 实测后果 |
|---|---|
| ❌ 无条件 overlay | 根会话 `mvs_743fa8` 自身 `status='started'` 且有 2 个活着的子 agent，**用户自己那一行整个工作期间一直是黄的** |
| ✅ 加优先级守卫 | 自己 turn 还在跑就是 `running`（绿），只有**已经把控制权交还**的会话才转黄 |

根会话干活时**几乎总是**有子 agent，所以不设守卫的话 `waiting` 会变成一个常亮颜色，
绿色 `running` 也就失去了意义。上游三个桶一个都不许被盖，理由各不相同：

| 桶 | 为什么不能被 waiting 盖掉 |
|---|---|
| `error` | **失败不能被一个更平静的颜色盖掉**——红是最高优先级 |
| `running` | turn 还在执行，它**根本没在等任何东西** |
| `paused` | 中断态是**等用户处理**的，涂成"在等子任务"等于**把待办抹掉** |
| `done` / `idle` | 无信息可遮蔽，**允许**被 waiting 接走（这才轮到黄出场） |

> ⚠️ "不要求父会话是 `started`"和"`started` 被忽略"**是两句话**。
> 前者说的是 waiting **不排斥**非 started 的会话；后者说的是 started **优先**。
> 把两者混为一谈，正是上面那个"用户自己那行一直黄着"的 bug 的成因。
>
> 优先级顺序写在 `status-db.mjs` 的注释里，并由 `test-waiting-bucket.mjs` 逐条断言：
> `error 优先于 waiting（红不被黄盖掉）`、
> `paused 优先于 waiting（橙色中断态是待用户处理，不该被盖）`、
> `running 优先于 waiting`、
> `done 可被 waiting 接走（最低优先级，无信息可遮蔽）`。
> 改这个顺序等于改产品语义，**先看测试**。

#### 判据里绝不要求父会话自己是 `started`

这是**最容易写错的一条**。实测抓到两个自身 `status='idle'` 的会话被判为 waiting：
它们的 turn 已经结束、回到空闲态，但子 agent 还在跑——**而这正是用户提这个需求的场景**。
如果按直觉加上 `AND status='started'`，这类会话会**全部漏判**，
功能等于只覆盖了用户根本不需要的那一半。

#### `kind='subagent'` 是必须项，不是性能优化

独立审查 agent 实测：去掉这个过滤，5 个 started 会话里有 4 个被判为 waiting，
其中 **3 个是纯误判**——它们只是留了个后台 shell 命令在跑，并没有子 agent。
本机复测（5.2 那张表）同样是 **4 个候选里 3 个是 bash**。
`bash` 与 `subagent` 全表累计 7631 : 377（约 20 倍），
不过滤等于"**任何长时间 shell 都会把一行染黄**"，误报率 75%。
（本机复测的绝对数字会随"此刻谁在跑"浮动，但**比例稳定落在 75%~80% 区间**。）

#### 不加 TTL，因为子 agent 没有心跳

实测 `kind='subagent'` 的 running 行**没有心跳**：连续 24 秒采样，
它的 `updated_at_ms` 纹丝不动，而同表 `bash` 行持续跳动。由此三条推论：

| 推论 | 原因 |
|---|---|
| **绝不能用 `updated_at_ms` 判断任务是否还新鲜** | 它不更新，拿它当心跳会把活着的任务判死 |
| **不能加 TTL 兜底** | 会误杀"主 agent 合法地等一个子 agent 十几分钟" |
| **孤儿 running 行会永远显示黄色** | 宿主崩溃留下的行不会自愈——但这是**更安全的失败方向**：宁可多显示，不可漏显示 |

### 5.5 只读打开很重要

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

（rAF 这条路径在一处场景下仍慢一帧——本地↔云端视图切换，见 8.4 的第二只 observer。）

### 8.3 因果对照（决定性证据）

同一处真实鼠标点击，**只变守卫开关**：

```
[守卫关闭] +300ms=EXPANDED(h120) +900ms=EXPANDED(h120) +2000ms=EXPANDED(h120) => 展开
[守卫开启] +300ms=collapsed(h30)  +900ms=collapsed(h30)  +2000ms=collapsed(h30)  => 折叠
```

### 8.4 视图切换的展开闪烁归零（attribute observer，2026-10-02）

用户报：**切到云端再切回本地，置顶区"最下面多出来一片、又折叠回去"**。逐帧测量还原了全程：

- 宿主切回本地时把置顶行连同**已展开的 caret** 一起 commit，展开布局
  （392px）画出 **2 帧**后才被 rAF 守卫折回 270px——那 2 帧就是用户看到的闪烁。
- rAF 路径物理上慢一帧：`MutationObserver(childList) → rAF` 只能在宿主
  commit 的**下一帧**响应。

三版修法里两版被真机数据否决，教训值得留下：

| 方案 | 真机结果 | 判决 |
|---|---|---|
| 按行记 350/600ms 再折抑制窗 | 宿主两波展开 dt=348/823ms，窗口没盖住或让第二波拖到 1551ms | ❌ 净伤害 |
| 行数变动后 1.2s 静默再收尾（"风暴门门"） | 对抗 2→1，但展开态持续 2 秒（展开帧 2→99+） | ❌ 更差 |
| **attribute observer 同帧折叠** | 三轮展开帧全部归零 | ✅ |

终版原理：展开标记是 caret 图标 `-rotate-90` **class 的移除**——是 attribute
变化，原来的 childList observer 根本看不见。新增一只只盯
`attributes: ['class']` 的 `MutationObserver`，它的回调是**微任务、在本帧
paint 之前执行**，回调内同步 `clickCaret` 折叠——展开布局从未到达屏幕。

语义全部真机复验不回退：「更多」列表展开不被压（35 行稳定 2.9s+）；
手动点箭头仍被压回（策略不变，只是从下一帧升级为同帧）；组级「置顶」
折叠开关不在守卫目标选择器内。回归锁在 `test-cloud-bucket.mjs` 第 9 节
（4 条：observer 存在 / 只认 transition-transform / dispose 断开 / 时间窗
方案不得回潮）。

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

只测内层 `daemon.mjs` 就宣称完成，结果启动器 `start-mmx-status.ps1`
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

### 9.5 测试全绿，功能却是坏的：WMI 过滤器 + Electron 单实例锁

**这是本项目最隐蔽的一个 bug，而且所有测试都是绿的。**

用户报的现象只有一句：**「双击快捷方式没反应」**。

`launch-mmx-status.ps1` 的逻辑本来是对的——应用在跑但没 CDP 就杀掉重开。
但它从来没数对过进程：

```powershell
$name = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)   # 'MiniMax Code'
return @(Get-CimInstance Win32_Process -Filter "Name='$name'")    # 永远 0 条
```

**`Win32_Process.Name` 是带扩展名的**（`'MiniMax Code.exe'`），
而 `Get-Process -Name` 匹配的是**不带扩展名的映像名**。同一个字符串，两种 API 语义不同：

| 写法 | 实测返回 |
|---|---|
| `Get-CimInstance -Filter "Name='MiniMax Code'"` | **0** ← bug |
| `Get-Process -Name 'MiniMax Code'` | **10** |
| `Get-CimInstance -Filter "Name='MiniMax Code.exe'"` | **10** |

于是 `$runningCount` 恒为 0 → 脚本永远认为"应用没跑" →
**跳过了"杀掉无 CDP 实例"这一步** → 直接启动第二个实例。

**放大器是 Electron 的单实例锁**：第二个实例带着 `--remote-debugging-port=9331`
起来的一瞬间就被判定为"重复启动"，参数丢弃、秒退，旧的无参数实例继续活着。
CDP 参数从头到尾没生效过。

**判别式证据（不靠猜）**：日志里出现了「以 --remote-debugging-port=9331 启动」，
却**缺少**它上一行本该有的「检测到 N 个进程在跑且无 CDP」。
这两行必须成对出现，少了上面那行 = 过滤器失效。

**为什么测试没抓到**：`test-launcher.ps1` 自建的是**一次性独立实例**，
那一刻 `$runningCount` 真的是 0，坏写法和好写法结果**碰巧相同**。
测试场景和故障场景不是同一个，这个盲区靠"正例 + 反例"才补得上。

`test-process-filters.ps1`（**19 项**）锁死这个形态：
A1 坏写法恒为 0 / A2·A3 两种好写法都 >0 / A4 两者数量一致 /
B1 两种好写法的 PID 集合完全相同 / C1·C2 源码里不再有坏过滤器。
D0-D11 这 12 条测的是另一件事——`Test-IsStaleDaemonProcess` 的筛选逻辑
（哪些进程允许被杀、哪些绝对不许碰），见第 11 章覆盖表。

**同族排查**：全项目 grep `GetFileNameWithoutExtension` + `Get-CimInstance -Filter "Name="`，
只有这一处中招——`start-mmx-status.ps1` 做同样的事却用了 `Get-Process`，所以是好的。
**同一个项目里两份做同一件事的脚本，一对一错，最能说明"别靠直觉抄自己"**。

### 9.6 两份代码副本：测试全绿，用户却一点没变

**这是本项目危害最大的一个坑，README 此前完全没有覆盖。**
它的可怕之处在于：所有客观指标都是绿的，而用户看到的产品一点没变。

#### 现象

修复全部打进 git 副本后，**5 个测试套件全绿**、沙箱端到端 PASS、git 也推了，
**运行时一行都没生效**。用户现象只有一句：「还是不会置顶」。

#### 根因：同一套代码存在两份副本，用户加载的是没被改的那份

机器上当时同时存在两个目录，内容几乎一样、**只有一份是 git 仓库**：

| 副本 | 性质 | 桌面快捷方式当时指向 |
|---|---|---|
| `G:\mmx-project\fix mmx\mmx-status\` | 裸目录，**无 `.git`** | ✅ 就是它 |
| `G:\mmx-project\fix mmx\mmx-status-github\` | git 仓库（真源） | ❌ 没指向它 |

修复全部打进第二份，第一份原封不动。**红 M 加载的是裸目录那份**，
于是"测试通过"和"用户看到"之间隔着一次**指向哪份代码**的选择。

#### 证据

最硬的一条证据不是日志、不是点数，而是**两份 `page-script.mjs` 的默认值本身就不同**：

```
mmx-status\lib\page-script.mjs:556          reorder: false   ← 裸副本（旧）
mmx-status-github\src\lib\page-script.mjs:568  reorder: true    ← git 仓库（新）
```

裸副本连新增的 `test-reorder-defaults.mjs` 都没有。两个文件长度也不同
（26152 vs 26892 字节），是**两个不同版本**，不是同一份的两条路径。

而快捷方式改写前的原始配置被备份了下来（`logs\mmx-fix-lnk-backup.json`），
它自己就记录了旧指向，是不需要推断的物证：

```json
{
  "TargetPath": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "Arguments": "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"G:\\mmx-project\\fix mmx\\mmx-status\\launch-mmx-status.ps1\"",
  "WorkingDirectory": "G:\\mmx-project\\fix mmx\\mmx-status"
}
```

#### 判别要点（比数点数、看样式、看日志都可靠）

**直接读页面上的配置对象**：`window.__mmxStatus.cfg.reorder`。
主实例读到 `false`、沙箱读到 `true`，**同屏对照一步定位**——同一份代码不可能有两种默认值。

**"状态点 88 个、汇总条都在"恰恰是旧版也能画出来的假象**，
所以数点数、看样式、看日志这三样**都会给出假 PASS**，必须读 `cfg` 里的真实开关值。

#### 修复：让 git 仓库成为唯一真源

桌面 `mmx-fix.lnk` 已改指 git 仓库，并且**工作目录也一起改对**（相对路径依赖它）：

```
Target : powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden
         -File "G:\mmx-project\fix mmx\mmx-status-github\src\launch-mmx-status.ps1"
WDir   : G:\mmx-project\fix mmx\mmx-status-github\src
```

原配置备份在 `logs\mmx-fix-lnk-backup.json`（**注意是仓库根目录的 `logs\`，
不是 `src\logs\`**——`install-launcher.ps1` 才会写 `src\logs\`，红 M 是手工建的）。

#### 9.6.1 附带坑：四条启动链，改一条不够

**只改桌面快捷方式是不够的。** 这台机器上有**四条**能拉起 daemon 的路径，
历史上**全部指向旧裸目录**，只改一条必然被其余三条拖回旧版本：

| 启动链 | 作用 | 改代码后必须同步 |
|---|---|---|
| 桌面 `mmx-fix.lnk` | 日常入口 | ✅ 已指向 git 仓库 |
| `src\start-mmx-status.ps1` | 终端启动器 | 跟着仓库走，天然一致 |
| `src\watchdog.mjs` | 常驻看门狗，检测不到 daemon 就自动拉起 | ⚠️ 见下 |
| 手动 `node daemon.mjs` | 手工 | 手工输入，用绝对路径才不会错 |

**真实事故**：只改了快捷方式，**watchdog 仍在自动拉起旧目录的 daemon，
并把手动起的新版杀掉**（顺 `ParentProcessId` 查出来的）。

**治本**：所有链路的路径都由**同一个 git 仓库根**派生，不允许任何一条写死绝对路径到旧目录。
排查这类"改了没生效"时，**先把四条链路的实际命令行全部列出来**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'mmx' } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

**开机自启是第五条，容易被漏掉**（2026-10-02 实测仍是旧路径）：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\mmxStatusWatchdog
  = "node.exe" "G:\mmx-project\fix mmx\mmx-status\watchdog.mjs" --log "...\mmx-status\logs\watchdog.log"
```

⚠️ 这条**注册表项还指着已废弃的裸目录**。它不影响当前使用（watchdog 进程当前没在跑），
但**下次开机就会从旧目录拉起一个旧版 watchdog**。它由 `install-launcher.ps1` 写入，
`uninstall-launcher.ps1` 或手工删掉这个 Run 项即可清除。

#### 9.6.2 watchdog 有 kill / 重启能力，启用前必须确认用户没在用

`watchdog.mjs` **带结束进程和重启应用的能力**，源码里写得很直白：

```js
// watchdog.mjs:701
log.warn('  重启 ' + exe + ' --remote-debugging-port=' + port);
```

即：配 `--fix-app` 时，它会**结束正在运行的 MiniMax Code 实例并带 CDP 参数重启**。
14.3 的三道闸门（连续 6 次失败 / 启动满 45 秒 / 退避）是为了压住误杀，
但**闸门只是降低概率，不是消除风险**——正在编辑的会话仍然可能被打断
（历史上真触发过 12 次修复，打断过正在进行的编辑）。

**本机当前状态：watchdog 停用**（`node watchdog.mjs` 进程当前不在运行），
理由就是**用户当时正在使用主实例**，启用有杀掉用户窗口的风险。

启用前必须确认：

1. 用户当前**没有正在进行的会话**（先问，别自己判断）
2. 只在**独立沙箱实例**（第 16 章）上验证 `watchdog-heal-e2e.mjs`
3. **绝对不要**在用户正在用的实例上开 `--fix-app`

---

## 10. 完整使用手册

### 10.1 环境要求

- Node **22.5+**（需要 `node:sqlite`；本机 24.18.0）
- MiniMax Code 桌面端
- 零第三方依赖
- `.ps1` 脚本为 **UTF-8 with BOM + CRLF**，Windows PowerShell 5.1 与 pwsh 7 均可直接运行

### 10.2 首次使用

**日常入口是桌面上那个自绘的红色 M 图标 `mmx-fix.lnk`**，不是任何 `.ps1` 脚本。
先把仓库拉下来，跑安装器，它会创建红 M 并装好开机自启：

```powershell
git clone https://github.com/tcflying/minimax-code-sidebar-status.git
cd minimax-code-sidebar-status
pwsh -NoProfile -File .\src\install-launcher.ps1 -DryRun   # 先看要改什么
pwsh -NoProfile -File .\src\install-launcher.ps1           # 真跑
```

安装器只做两件事：**创建 `mmx-fix.lnk`**（指向 `wscript.exe` + 
`src\launch-mmx-status.vbs`，无控制台、点开零黑窗，见 14.8）和**写入
`HKCU\...\Run\mmxStatusWatchdog`** 开机自启（写后回读校验）。
官方桌面/开始菜单的 `MiniMax Code.lnk` 一个字节都不动（原因见 14.1/14.2）。

装完可以验证红 M 的指向（`Arguments` 里必须是**本仓库**的 `.vbs`，
旧副本路径 = 全盘失效）：

```powershell
$sh = New-Object -ComObject WScript.Shell
$sh.CreateShortcut("$env:USERPROFILE\Desktop\mmx-fix.lnk") |
  Select-Object TargetPath, Arguments, WorkingDirectory
# 期望：TargetPath = ...\wscript.exe
#       Arguments  = "...\minimax-code-sidebar-status\src\launch-mmx-status.vbs"
```

图标用仓库自带的 `assets\mmx-fix.ico`（安装器自动选）；要重画跑
`.\src\make-mmx-icon.ps1`。

装好之后**日常就双击红 M**，不再碰任何脚本。

> ⚠️ 红 M 第一次运行时，若应用在跑但没带 CDP 参数，它会**结束当前 MiniMax Code 进程树**
> 再用 CDP 参数重启。进行中的会话存在 SQLite 里，重启后从侧边栏点回去即可恢复。
> **动手前先确认没有正在进行的会话。**

### 10.3 日常使用：只点红 M

用户视角的全部操作就是下面这 5 条：

1. **想用就点桌面红 M 图标**（`mmx-fix.lnk`）——这是**唯一**日常入口
2. **关闭应用就正常点窗口右上角的 X**，**不要**用红 M 关
3. **下次仍然点红 M**（不要改用开始菜单或官方的 `MiniMax Code.lnk`）
4. **红 M 只能启动 / 纠正，不能关闭应用**——它没有"关掉"这个语义
5. **官方桌面和开始菜单的 `MiniMax Code.lnk` 保持无参数原样，不要动**
   （官方更新器会按名字覆盖它们；红 M 名字不冲突，所以更新器碰不到，见 14.1 第 4 条根因）

**为什么不点 X 之外的方式**：红 M 负责的是"确保应用是带 CDP 参数起来的"，
关应用的语义仍然归应用自己的窗口按钮。用红 M 去管生命周期，就会和 9.6.1 的
watchdog 一样，出现"另一条链把它又拉起来"的多入口问题。

#### `start-mmx-status.ps1`：终端用户 / 排查用，**不是日常入口**

`start-mmx-status.ps1` 是**前台交互式**脚本——它有 `Read-Host`（第 69-73 行），
只能在终端里敲着跑，**双击快捷方式是跑不起来的**（详见它自己的第 12 行注释：
unattended/scripted use 必须加 `-Force`）。保留它是为了排查和脚本化：

```powershell
.\start-mmx-status.ps1          # 交互式，检测到未开 CDP 会问你要不要重启
.\start-mmx-status.ps1 -Force   # 无人值守，直接重启不询问
.\start-mmx-status.ps1 -DryRun  # 只打印将要执行什么，不真跑
.\stop-mmx-status.ps1           # 清注入 + 停守护（**不关应用**）
```

`Read-Host` 读控制台，无法用管道喂输入，所以脚本化必须加 `-Force`。

**要静默无窗口地启动，用 `launch-mmx-status.ps1`**（没有 `Read-Host`，做完美活立刻退出，
控制台窗口不会留在桌面上）——红 M 调的就是它。

### 10.4 全部命令行参数

`daemon.mjs`（13 个）：

```
node daemon.mjs
  --port <n>        CDP 端口（默认 9331）
  --db <path>       数据库路径（默认 ~/.minimax/v2/sqlite/runtime-state.sqlite）
  --interval <ms>   轮询间隔（默认 2500）
  --once            跑一次就还原
  --offsetX <px>    圆点左右位置（默认 4）
  --show-done       给"已完成"也打灰点（默认关，233 个灰点噪音太大）
  --show-aborted    把"主动取消"也算暂停（默认关）
  --no-collapse     关闭"永不展开"守卫
  --reorder         开启"running 行置顶"（默认已开，写出来只为兼容旧脚本；见 15.5 事故史）
  --no-reorder      显式关闭（逃生舱，平时不需要传）
  --active-bg <css>       选中行底色（默认 rgba(10,10,10,0.10)）
  --active-bg-hover <css> 选中行 hover 底色（默认 rgba(10,10,10,0.14)）
  --active-bar <css>      选中行左侧色条（默认 rgba(0,148,252,0.90)，传 transparent 关掉）
```

> 默认端口是 **9331**，与 `launch-mmx-status.ps1:281` 的兜底一致。
> 2026-10-02 之前这些默认值是 9351，裸跑 stop/daemon 会连上一个根本没在监听的
> 端口——症状是"改了代码没反应"、或 stop 声称成功实际没停。

`watchdog.mjs`（13 个，全部核对自 `src/watchdog.mjs` 的 `parseArgs`）：

```
node watchdog.mjs
  --port <n>              目标 CDP 端口。不传 = 自动发现
                          （① <user-data-dir>\DevToolsActivePort  ② 扫进程命令行）
  --interval <ms>         巡检间隔（默认 5000）
  --fix-app               允许在「应用在跑但没 CDP」时结束它并重启（默认只告警）
  --fix-app-after <n>     连续几次没 CDP 才允许 --fix-app 动手（默认 6）
                          ——应用冷启动时正常会有一段时间没 CDP，
                            不设这道闸会把 2 秒等待变成 kill/restart 循环
  --min-uptime-ms <ms>    应用启动不足这么久就不动它（默认 45000，同上）
  --user-data-dir <path>  限定只看这个 profile 的实例（沙箱测试用）
  --app-process-name <s>  应用进程名（默认 MiniMax Code.exe）
  --daemon <path>         被守护的 daemon 脚本（默认同目录 daemon.mjs）
  --no-heal                只监控，不拉起 daemon
  --no-reorder             透传给 daemon 的逃生舱（见下）
  --reorder                显式开启置顶（默认已开，写出来只为兼容）
  --once                  巡检一次就退出
  --log <path>            日志（默认 logs\watchdog.log）
  --lock <path>           单实例锁文件（默认 logs\watchdog.lock）
  --stop-daemon-on-exit   自己退出时把 daemon 一起带走
```

> `--no-reorder`（2026-10-02 新增）是**开机自启路径的逃生舱**：置顶默认开是好事，
> 但 15.5 那个重排死循环真要复发时，`Run\mmxStatusWatchdog` 这条链原先没有任何
> 办法把它关掉——自启是在 `Read-Host` 都不存在的后台上下文里跑的。
> 现在 `spawnDaemon` 会把 `--no-reorder` 透传给 `daemon.mjs`。

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
| `node capture.mjs --port 9331 --out shot.png` | 截侧边栏 + 打印注入统计 |
| `node verify-guard-causal3.mjs --port 9331` | 守卫因果对照（只变开关） |
| `node verify-never-expand.mjs --port 9331` | 真实点击标题/箭头后检查是否展开 |
| `node diagnose-expand-owner.mjs --port 9331` | 展开状态归因 + localStorage 键 |
| `node diagnose-collapse-stick.mjs --port 9331` | 手动折叠能不能粘住 |
| `node debug-guard.mjs --port 9331` | 守卫是被调用了还是调用了没压住 |
| `node diagnose-dots.mjs --port 9331` | 区分"惰性残留"和"仍在重绘" |

---

## 11. 测试体系

所有脚本都在 `src\` 下，**在仓库根目录执行**，命令要带 `.\src\` 前缀（漏了会
`MODULE_NOT_FOUND`，因为根目录没有这些 `.mjs`）：

```
node .\src\selftest.mjs                      116 项 · 不需要 CDP
node .\src\test-cloud-bucket.mjs             119 项 · 不需要 CDP
node .\src\watchdog-selftest.mjs              83 项 · 不需要 CDP
node .\src\test-autofix-gates.mjs             32 项 · 不需要 CDP
node .\src\test-reorder-defaults.mjs          40 项 · 不需要 CDP
node .\src\test-waiting-bucket.mjs            49 项 · 不需要 CDP
pwsh -NoProfile -File .\src\test-process-filters.ps1   28 项 · 需要应用在跑（但**不需要 CDP**）
node .\src\e2e.mjs --port 9331               19 项 · 需要已开 CDP 的实例
pwsh -NoProfile -File .\src\test-launcher.ps1        20 项 · 自建一次性实例
```

> 上面 7 个**不需要 CDP** 的套件可以随时跑。唯一的环境前提是
> `test-process-filters.ps1`——它的 A2/A3/A4/B1 断言要数**真实**进程，
> 所以**应用得开着**（但不需要 CDP 端口）。
> 最后两个会**连真实实例**
> （`e2e.mjs` 连已开 CDP 的端口、`test-launcher.ps1` 自建实例），
> **在用户正在使用主实例时不要执行**——见 16 章「绝不拿用户正在用的实例做实验」。

| 套件 | 覆盖 |
|---|---|
| `selftest` | 桶映射规则（含 waiting overlay 优先级，见 5.4）/ 真实库只读 / 注入表达式语法 / **无破坏性 DOM 调用** / dispose 回归 / 反引号守卫 / **daemon 僵尸上限**（6b：240 次重连失败必须自退）/ 环境 probe 改 skip 语义 |
| `test-cloud-bucket` | **云端会话状态点全套**：bucket 映射 / 键空间隔离（mvs_ vs 纯数字）/ 前插窗口重放（2026-10-02 倒序重放回归锁 8 条）/ 滚动窗口不受 store 200 条影响 / 泄漏上限计数 / 8.4 的 attribute observer 回归锁 4 条 / 模板串反引号计数=10 守卫 |
| `watchdog-selftest` | 双路端口发现（含陈旧 DevToolsActivePort 探活回退）/ 单实例锁 / 僵尸回收 / 退避节奏 / **启动器握手**（fresh/stale/缺失/损坏/带 BOM 共 8 条） |
| `test-autofix-gates` | `--fix-app` 三道闸门，**每道都配正例 + 反例** |
| `test-reorder-defaults` | reorder 默认值为 **true** / `--no-reorder` 逃生舱 / 启动器参数构造（dry-run 打印的和真跑的是同一个数组）/ **杀旧 daemon 的筛选**（含"启动器源码里没有任何针对 MiniMax Code / Electron 的 taskkill 或按名批量杀"这条静态断言） |
| `test-waiting-bucket` | 6 组：`isWaiting` 纯判定 / overlay 规则（**全用合成数据**，不依赖真实库状态，因此任何机器上结果都一样）/ `bucketFor` 没被污染 / 真实库只读时 overlay 接得上 / **`kind='subagent'` 过滤是回归锁**（直接断言 SQL 文本含 `kind = 'subagent'`、断言**没有**用 `updated_at_ms`、断言**没有** TTL）/ 页面侧样式与置顶（含「waiting 未复用 orange」） |
| `test-process-filters` | WMI 与 Get-Process 的过滤器语义差异（详见 9.5）；**另加** `Test-IsStaleDaemonProcess` 筛选逻辑 **D0-D11 共 12 条**：同端口旧 daemon 要选、**Electron 主实例和 renderer 子进程绝不能选**、不同端口不选、非 daemon 的 node 不选、同端口的 `e2e.mjs` 不选、进程名不是 `node` 的一律不选、空命令行不选、`--port=9331` 等号写法也认 |
| `e2e` | 真实渲染进程闭环：注入 → 刷新精确删 1 → 归零 → **10 秒不复活** → 重注入幂等 |
| `test-launcher` | 启动器 DryRun / 冷启动 / 停止三分支，**全程不碰主实例** |

> 💡 **`selftest` 里有一条断言被改写过，值得单独记一笔。**
> 它原来叫「存在 running 会话」，断言 `counts.running > 0`。
> 这条断言**写的其实是"能不能看见任何活跃状态"**，
> 但在 `waiting` 桶出现之前它字面上就是在赌**这台机器此刻正好有会话在跑**——
> 空闲机器上会假失败，而且失败信息会指向错误的方向。
> 现在改成「存在活跃会话（running 或 waiting）」，断言 `running + waiting > 0`。
> **教训：断言要断言你想问的问题，不要断言某个瞬时状态碰巧为真。**

> ⚠️ `selftest` 有一个隐藏依赖：**仓库里每个 `.ps1` 都必须是 UTF-8 BOM + CRLF**。
> 漏掉一个，它就会在"脚本语法检查"那组用 PS 5.1 解析时报
> `MODULE_NOT_FOUND` 之类的怪错，而不是告诉你哪个文件有问题。
> 一次性修好：`pwsh -NoProfile -File .\src\fix-ps1-encoding.ps1 -Dir .\src`

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
| 覆盖范围：置顶区 + 各项目分组区 | 二者都由应用自己的列表渲染、都带 `data-session-id`，**都已覆盖**。置顶区实测 `kids=7 / withRow=6`（第 7 个是折叠控件不是会话行），所以判据用容差 `withRow >= kids-1` 而非 `===`——用 `===` 会静默漏掉置顶区 |
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
2026-09-29 22:25   app.asar 被官方更新器替换（426,404,876 字节 ≈406.7 MiB）
2026-09-30 20:56   桌面 MiniMax Code.lnk 被改回无参数直连
2026-10-01 02:56   开始菜单 MiniMax Code.lnk 被改回无参数直连
```

官方更新器**按快捷方式名字**找 `.lnk` 并覆盖。你手工改好，三天后它自己改回去，
而你会以为是前三条的修复不work。

**治本办法：不要用官方名字。** 唯一命名一个 `mmx-fix.lnk`，
官方更新器不认识这个名字，就永远碰不到它。

| 入口 | 指向 | 用途 |
|---|---|---|
| `mmx-fix.lnk`（红色 M 图标） | `wscript.exe` + `launch-mmx-status.vbs` | ✅ **唯一正确入口**，官方更新不会覆盖，零黑窗（见 14.8） |
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

- **快捷方式改写**：新建 `mmx-fix.lnk` 指向 `wscript.exe` +
  `launch-mmx-status.vbs`（2026-10-03 起从直接指 ps1 升级，原因见 14.8：
  powershell.exe 会先建控制台再隐藏，红 M 每次点开都闪黑窗），配自绘红色 M
  图标。**不改官方那两个 `.lnk`**
  —— `install-launcher.ps1` 现在**只创建 `mmx-fix.lnk`**，
  官方桌面/开始菜单的 `MiniMax Code.lnk` 保持原样、一个字节都不动
  （见下方"为什么必须改这个脚本"）
- **端口自动发现**：绝不写死。优先读 Electron 自己写的
  `%APPDATA%\<App>\DevToolsActivePort`（内容形如 `9331\n/devtools/browser/<uuid>`，
  取第一行要 `trim`，Windows 上常见 CRLF），再用进程命令行兜底
- **默认不碰任何进程**：`APP_UP_NO_CDP` 时只告警不动进程
- **不碰官方自启项**：`com.minimax.agent.cn` 只读打印，从不改写

#### 为什么 `install-launcher.ps1` 必须只建 `mmx-fix.lnk`

这一节单独写出来，因为**旧版 `install-launcher.ps1` 的行为与 14.1 的处方完全相反**：

| | 旧版（错） | 现在 |
|---|---|---|
| 改谁 | 按官方名字改写桌面 + 开始菜单的 `MiniMax Code.lnk` | **只创建** `mmx-fix.lnk` |
| 结果 | 官方更新器按名字回写 → 每次更新注入断一次 | 名字不冲突，更新器永远碰不到 |
| 建 `mmx-fix.lnk` 吗 | **完全没有这段代码** | 有 |

第二行是最隐蔽的坑：全仓 grep 确认 `mmx-fix.lnk` 只在 `fix-coldstart.ps1` /
`restart-cold.ps1` / `restart-e2e.ps1` 里被**消费**（`Start-Process` 那个路径），
**从不创建**。也就是说旧版装完之后红 M 根本不存在，本工具的冷启动链是断的——
而用户照着 README 跑安装，得到的正是 14.1 声称要避免的那个故障。

`uninstall-launcher.ps1` 同步改成"删除 `mmx-fix.lnk` + 删 Run 项"，
官方 `.lnk` 从未被本工具动过，卸载时也无需"还原"。
历史版本遗留的 `MiniMax Code.lnk.bak` 脚本会列出来提示，可自行删除。

#### install-launcher.ps1 写的自启项

注册表自启项 `Run\mmxStatusWatchdog` 的值现在由
`$Root`（脚本自身位置）拼出 `$Root\watchdog.mjs` 与 `$Root\logs\watchdog.log`，
所以**装在哪份代码里就指向哪份**，不会再指向已废弃的旧副本
（2026-10-02 复核：旧写法会写出指向 `G:\mmx-project\fix mmx\mmx-status\watchdog.mjs`，
而那份目录没有 git、`daemon.mjs` 的 reorder 默认还是 `false` 的旧版）。
**本项目只改脚本里的写入逻辑，不动已有注册表值**——需要刷新时用户自己重跑一次
`install-launcher.ps1`（它会覆盖写同一项）。

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

> ⚠️ **danger：watchdog 有 kill / 重启应用的能力，启用前先确认用户没有正在进行的会话。**
> `watchdog.mjs:701` 会「结束 PID 并带 `--remote-debugging-port` 重启」——
> 三道闸门只是**降低误杀概率，不是消除风险**（历史上真触发过 12 次修复，打断过正在进行的编辑）。
> **本机当前 watchdog 是停用的**，理由正是用户当时正在使用主实例。
> 完整判据与启用前检查清单见 **9.6.2**。

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

`fix-coldstart.ps1` / `restart-cold.ps1` / `restart-e2e.ps1` 在动完进程之后还会再跑一遍
"注入验收"——`verify-summary.mjs`（汇总条数字是否与实际 running 行一致）、
`verify-dot-sizes.mjs`（状态点实测尺寸）+ `verify-pip.mjs`（竖条样式）。

**这些验收探针在仓库内的 `tests\` 下**，脚本用 `$PSScriptRoot` 的父目录派生路径，
所以 clone 下来直接能跑，不依赖仓库以外的任何目录。截图落 `logs\shots\`
（`logs/` 已被 `.gitignore` 忽略）。同属这套探针的 `verify-reorder.mjs` /
`verify-running-visual.mjs` 不接 ps1，可单独 `node .\tests\verify-reorder.mjs 9331` 跑
（前者会 `Page.reload`，属破坏性）。

### 14.7 2026-10-02 事故补丁：两条让自愈链"自己别变成病灶"的护栏

当晚一次编辑半途崩溃留下了带语法错误的 `page-script.mjs`，连环触发了两个
**自愈链自身的缺陷**，修复如下（都有回归测试）：

1. **watchdog 无条件相信 DevToolsActivePort 文件**。文件是 Electron 启动时写的，
   实例退出后**文件不删**（当晚实测：文件写着 9331，活实例在 9333）。
   旧逻辑 `fileRes.port` 有值就直接采用，导致 watchdog 对着死端口
   连续重连 500+ 次。现在文件端口必须先通过 CDP 探活才生效，否则回退到
   进程命令行里的端口（与启动器 `Resolve-TargetPort` 同一套逻辑）；
   两者都没有时才保留文件端口用于 `APP_UP_NO_CDP` 诊断。陈旧文件警告
   **跳变触发**（只在状态变化时打一条，否则每 5s 一条、一天 3 万行）。
2. **daemon 重连无上限**。端口背后的实例退出后，daemon 以 30s 退避无限重试，
   且 `Stop-StaleDaemon` 只清理"新启动器目标端口"上的 daemon，不同端口的
   僵尸没人收尸。现在连续 240 次重连失败（顶格退避约 2 小时，足够熬过
   应用重启）后自行退出并在日志里写明原因；上限行为由 `selftest.mjs`
   第 6b 节锁定（onGiveUp 触发、定时器停止、日志含端口号）。

当晚的另一条教训与自愈链无关，但同样致命：注入脚本包在 `String.raw`
模板串里，**注释里出现一个反引号就会把整个模块变成 SyntaxError**，daemon
死在 import 阶段且日志一个字都不留（`daemon-*.log` 0 字节 = 首先怀疑这里）。
`test-cloud-bucket.mjs` 第 10 节已把"全文件反引号计数 = 10"锁成回归项。

### 14.8 2026-10-03：红 M 黑窗根治（VBS）+ 启动器/watchdog 竞态握手

**黑窗**。用户报"双击红 M 会弹一个常驻黑窗，里面有日志"（附截图）。窗口
记录器抓到真身：标题为 `mmx-fix` 的 powershell 控制台。根因是
`powershell.exe` 的启动顺序——**先把控制台窗口建出来（可见），再执行
`-WindowStyle Hidden` 参数把它藏掉**；`.lnk` 的 WindowStyle=7（最小化）也只是
把"可见"降级成"任务栏里闪"，远程桌面下仍然看得见。

根治：`launch-mmx-status.vbs` + `.lnk` 改指 `wscript.exe`（GUI 子系统，
**根本没有控制台可建**），VBS 里 `Shell.Run ..., 0, False` 从第一条指令起
就是隐藏的。实测点红 M 12 秒内新窗口数 0。`install-launcher.ps1` 同步，
重装不回退。与 2026-10-01 ocx-patch-guard 的修法同款（本机验证过的模式）。

**竞态**（追黑窗时顺藤摸出，2026-10-03 00:48:59 实录）。启动器
`杀旧 daemon → cleanup.mjs（至多 8s）→ 起新 daemon` 的窗口里没有 daemon；
watchdog 5 秒一探，立刻自愈拉起**第二只**；启动器自己的那只反被 watchdog
的 keep-exactly-one 逻辑收割——日志里"daemon pid=41020"之后戛然而止就是它。

修法分三层，全部真机双向验证：

1. **握手**：启动器全程持 `logs/launcher-in-progress.json`（try/finally 保证
   删除）；watchdog 见新鲜握手（60s TTL，防启动器中途崩溃永久卡死自愈）
   本轮不拉起，日志明说"让启动器完成它自己的启动"。
2. **两轮确认**：watchdog 需连续 2 轮探测无 daemon 才自愈——`findDaemonPids`
   是 shell 出去数进程，一次瞬时失败不该触发拉起。
3. **BOM**：PS 5.1 的 `Set-Content -Encoding UTF8` 写 BOM，Node 的
   `JSON.parse` 吃到 `\ufeff` 直接抛错、握手恒判"不存在"（真机让路测试首战
   失败的真凶）。watchdog 读时剥 BOM（防御任意写入方），启动器改写 ascii。

真机验证记录：手持握手杀 daemon → watchdog 明确让路；释放握手 → 第 1/2 次
确认 → 第 2/2 次确认 → 自愈拉起 → 注入恢复（tick 正常）。这同时补上了
watchdog 自愈路径的首次端到端真机验证。

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

#### waiting 行的视觉（15.6 的新桶）

竖条几何与 running **完全相同**（4px × `calc(100% - 6px)`、圆角 9999px），
只有色相和节奏换掉：

| 通道 | running | waiting | 为什么 |
|---|---|---|---|
| 形状 | 4px 竖条 | **4px 竖条（一致）** | 一眼读作"同类重要"，不新增需要学习的形状 |
| 渐变 | `linear-gradient(180deg,#4ade80,#16a34a)` | `linear-gradient(180deg,#fde047,#eab308)` | yellow-300 → yellow-500 |
| 整行底色 | `rgba(34,197,94,0.10)` | **`rgba(234,179,8,.10)`** | **同 alpha**，视觉重量一致 |
| 标题色 | `#15803d`（硬编码） | `var(--yellow_700,#a16207)` | 走主题变量 |
| 呼吸 | `__mmxBar 1.6s` | **`__mmxBar 2.2s`** | 刻意更慢：这行自己没在干活，只是占位 |

⚠️ **黄色是刻意挑的，不是随手拿的。** `paused` 用的是 `var(--orange_400,#f59e0b)`，
那是**琥珀色**，和朴素黄（`#facc15` / `#eab308`）色相几乎重合。两个桶都画黄色竖条
在侧边栏上分不出来。所以 waiting 的渐变和底色**都往 yellow-500 偏**，
和 paused 拉开距离。这一点必须写进文档，否则下一个人会以为作者随便挑了个黄。

> ⚠️ **既有局限（不是本次引入，但既然记录视觉就该记下）：**
> 上表 running 的标题文字色是**硬编码 `#15803d`**（深绿），直接写在 CSS 里，
> 而整个 `src/` **没有任何 `prefers-color-scheme` 主题适配**。
> 后果是**深色主题下这个深绿文字基本读不出来**（浅底深字的设计被反过来用）。
> waiting 的标题色走 `var(--yellow_700,#a16207)` 主题变量，没有这个问题。
> 要修就得给两桶都补主题分支，属于独立的待办，**不要在改 waiting 时顺手改它**——
> 那会同时动到 running 的既有像素。

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

#### 汇总条现在也计入 waiting

条上是**两段**，不是两行：

```
┌──────────────────────────────────────────────┐
│ ▎ 2 个运行中 · 3 个在等子任务                │  ← #mmx-running-summary
└──────────────────────────────────────────────┘
```

- 两段数的是**屏幕上真正画出来的行**（`runningOnScreen` / `waitingOnScreen`），
  和 running 那段一样，滚出虚拟列表的不算。
- **M = 0 时 waiting 整段 `display:none`**，不占位、不显示"0 个在等子任务"——
  只有一个 running 时不该拖着一句废话在侧边栏上晃。
- ⚠️ 与上面那句"没有新增任何 DOM 节点"**不矛盾，但要说清**：running 那段确实一个节点没加；
  waiting 段是在**同一个 `ensureSummary()` 里一次性建好的一个 `<span data-mmx-wait>`**，
  之后只改 `textContent` 和 `display`，**任何时候都不碰 `innerHTML`**
  （`selftest` 本身就禁止破坏性 DOM 写入）。计数没变时连 `textContent` 都不写。

### 15.4 为什么不能让 running 行自动置顶（早期判死，后来推翻）

先试过 CSS `order`，判死。完整证据链：

| 尝试 | 结果 |
|---|---|
| CSS `order` | 排序容器 `DIV.relative.min-h-[4px].space-y-px` 的 `display` 是 **`block`**，不是 flex/grid → `order` 无效 |
| 全页面扫描"直接子级是 session 行"的容器 | `containerCount: 0` —— **一个都没有** |
| `insertBefore` 搬 DOM | 直接吃 `NotFoundError`（行不是置顶区的直接子节点） |

真实结构是：每行都被包在自己的**单层 `div`** 里（实测 509/509 全中）。
**但"order 无效"只证明 CSS 那条路不通，不等于搬 DOM 也不行。** 下面 15.5 是修正后的结论。

`waiting` 行走的是**同一套机制、同一份代码路径**（只是桶名不同），
所以这张判死表对它同样成立——它也不靠 CSS `order`。

---

### 15.5 running 行自动置顶（默认开启，`--no-reorder` 可关）

> ⚠️ **这个功能有一次把宿主页面搞崩的事故史，读完 15.5 再决定要不要把它关掉。**
> 结论是**搬 DOM**，不是改样式。
>
> **注：2026-10-02 起改为默认开启。** 它是明确要求的产品功能，藏在显式开关后面
> 会让红 M 启动器（一个 reorder 参数都不传）永远跑在关闭状态，"running 行没置顶"
> 于是被当成 bug 报了上来。现在只有显式 `--no-reorder` / `-NoReorder` 才会关掉它。
> 下面的事故史原样保留——它正是这个逃生舱存在的理由。

#### 它做什么

某个会话**刚开始运行**时，把它在本列表内的位置移到最前。**只动这一次**——
不是每轮刷新都重排。

```
用户：每个开始后移动一次就好了，后面新开始的会不断移到最上面
实现：只在 running 集合发生变化时搬一次，集合不变就完全不碰 DOM
```

**`waiting` 同样置顶。** 置顶集合是 `running ∪ waiting`，落地顺序固定为：

```
[所有 running 行][所有 waiting 行]     ← 各自保持各自的原相对顺序
```

两组是**分开收集再拼接**的（`runW` / `waitW`），不是混在一起排——
因为后面的搬移循环是**从后往前**执行的，同组倒着搬才会在聚到队首后还原成原顺序。
一次遍历同时完成两组的置顶，不额外增加一轮 DOM 写。

#### 为什么必须搬 DOM 而不是改样式

第一版是这么做的，也是**把页面搞崩的那一版**：

```js
// ❌ 第一版：把宿主容器强制改成 flex column，再用 CSS order
listEl.style.setProperty('display', 'flex', 'important');
listEl.style.setProperty('flex-direction', 'column', 'important');
runningWrapper.style.setProperty('order', '-1', 'important');
```

事故过程（全部有实测数据）：

| 阶段 | 观测值 |
|---|---|
| 容器识别判据太松（"子节点里 >1 个含行"） | 匹配到 **87 个容器**，而不是 1 个 |
| 87 个嵌套盒子被强制 `display:flex !important` | 渲染进程进入无限重排 |
| 10 分钟后 | renderer `CPU=684s` `内存=722MB` |
| `Runtime.evaluate` | 连续 30 秒超时，**JS 线程完全不响应** |
| 能否用 CDP 清理 | **不能**，页面已死，只能重启应用 |

**教训：改宿主的 `display` 不是"局部改动"，它会重排整棵子树。**
把同一个手段用到 87 个元素上，就是一颗炸弹。

#### 现在的做法

```js
// ✅ 修正版：只用 insertBefore 搬节点，宿主样式一个字节都不改
root.insertBefore(wrapper, root.firstElementChild);
```

`insertBefore` 不触发宿主布局重算，只改变节点顺序。这是两种方案的本质区别。

#### 容器识别：容差，不是相等

置顶区那个列表实测是 **`kids=7 / withRow=6`**——第 7 个直接子节点是折叠控件，不是会话行。

```js
if (withRow >= kids - 1) { /* 这才是列表容器 */ }
```

用 `===` 会**静默漏掉用户唯一在意的那个列表**（实测：漏掉置顶区，只匹配到各项目分组下的子列表）。

#### 两道独立的闸门

它们防的不是同一件事，所以不能合并：

| 闸门 | 值 | 防什么 |
|---|---|---|
| `REORDER_MAX_ROOTS` | 128 | 容器识别是否又错了。侧边栏**真的**有很多列表——实测 72~30 个，全是各项目分组 |
| `REORDER_MAX_MOVES` | 16 | 单次搬多少节点。匹配到 100 个容器但只有 3 个有 running，就只搬 3 个节点 |

> 🚫 **新增 `waiting` 桶时，这两行常量一个字节都没有动，也不许动。**
>
> `waiting` 加入后单次需要搬的节点数**变多了**（running 和 waiting 两组都搬），
> 这正是最容易产生"那就调大一点 MOVE 上限"念头的时刻。**不要调。**
>
> 上面那张事故表就是这个决定的理由：容器识别一旦放松，
> **87 个嵌套盒子被强制 `display:flex !important`**，渲染进程进入无限重排，
> `CPU=684s`、`Runtime.evaluate` 连续 30 秒不响应、**页面彻底卡死且无法用 CDP 清理**。
> 护栏不是"跑得慢就调大"的性能参数，是**唯一拦住那次事故的东西**。
>
> 正确做法是让新桶复用现有两个闸门（现在就是这么做的）：
> 需要搬的节点变多，触发的是 `move-budget-exhausted` **提前中止**，
> 表现为一两行没排上去，而不是整个侧边栏被拖死。
> **把"少排几行"当成可接受的降级，把"卡死页面"当成不可接受。**

#### 状态判据必须用哨兵值

```js
// ❌ 初始值用空串是错的
var lastReorderKey = '';
// "没有 running"时算出的 key 也是空串 → 第一次变化被当成没变化 → 永远不动
// ✅ 哨兵值
var lastReorderKey = '__mmx_uninitialised__';
```

这个 bug 在沙箱里被实测抓到：把一行标成 running、`refresh()` 也跑了，
结果 `reorder: { unchanged: true, moved: 0 }`——**因为它根本没看见"变化"**。

#### 沙箱实测数据

```
造 1 个 running：
  reorder: { moved: 1, roots: 30, runningLists: 1 }
  movedFromIndex: 5 → movedToIndex: 0
  topBefore: 447 → topAfter: 318   （第一个非 running 行在 349）
  沙箱 renderer CPU 增量 = 1s

造 3 个 running（验证多行相对顺序）：
  reorder: { moved: 3, runningLists: 1 }
  顺序：[amd 华为…][分析 atlas…][查看 jev-skill…] ← 全在最前，且保持原相对顺序
```

#### 怎么关

```powershell
# 默认开启，什么都不用加
node daemon.mjs --port 9331

# 显式关闭（逃生舱：置顶引起侧边栏异常时才用）
node daemon.mjs --port 9331 --no-reorder

# 启动器同理，平时一个 reorder 参数都不传
pwsh -NoProfile -File .\src\launch-mmx-status.ps1 -Port 9331
pwsh -NoProfile -File .\src\launch-mmx-status.ps1 -Port 9331 -NoReorder
```

`--reorder` 仍然被接受，但已经等价于默认行为——保留它只是为了让旧脚本不报错。

---

### 15.6 waiting：等子 agent 的会话也要看得见

#### 现象

用户提的需求原话是"等子 agent 的会话也要看得见"。具体场景是：
**主 agent 派了子 agent，然后自己的 turn 就结束了**（回答完了，回到空闲），
但子 agent 还在后台跑。这时候侧边栏那一行：

- 不是 `running`（turn 已结束，`status` 已经退回 `idle`）
- 不是 `done`（子 agent 还没回来）
- 不是任何"看得见"的状态

**结果就是彻底消失在一堆灰行里。** 用户不知道有个 agent 还在替自己干活，
只能等它自己结束才知道。

#### 根因

不是"少画了一个点"，是**判据选错了数据源**。
`status='started'` 描述的是**这个会话自己这一轮 turn 在不在跑**，
而用户想知道的是"**这个会话名下还有没有活**"。两者在派子 agent 的场景下**必然分叉**。

所以新开一个 `waiting` 桶，用**两个 owner 维度的查询**去覆盖它（判据见 5.4）：

```
local_runtime_sessions         → 有没有 status='started' 的子会话
local_runtime_background_tasks → 有没有 status='running' 的子 agent 任务
```

两条都按**会话 id** 索引（`idx_local_runtime_sessions_parent_recency_v3`、
`idx_local_runtime_background_tasks_owner_status_delivery`），
`refresh()` 每 2.5 秒跑在**用户的活库**上，全是覆盖索引查，**不扫表、不加索引**
（库是 `readOnly` 打开的，本来也加不了）。

#### 证据

实测抓到**两个自身 `status='idle'` 的会话被判为 waiting**——
它们的 turn 已经结束、回到空闲态，但子 agent 还在跑。
**这正是用户提这个需求的场景。** 判据里加不加父会话的 `status`，
差别就是"功能可用"和"功能没用"。

`kind='subagent'` 过滤的必要性（独立审查 agent 实测）：

| 条件 | 判为 waiting 的 started 会话 | 其中纯误判（只有后台 shell） |
|---|---|---|
| 加 `kind='subagent'`（**已发布**） | 1 | 0 |
| 不加（反例） | 4 | **3** |

无心跳的实测：连续 24 秒采样 `kind='subagent'` 的 running 行，
`updated_at_ms` **纹丝不动**，同表 `bash` 行持续跳动。

#### 判别要点

做这个功能时踩过 / 确认过的四条，每条都是"照直觉写就会错"：

1. **判据里不要写 `status='started'` 这个准入条件。**
   写上就漏掉了用户真正要的那一半场景（turn 已结束、子 agent 还在跑）。
   ⚠️ 但这**不等于**"`started` 被忽略"——`running` 在优先级里**排在 waiting 前面**，
   正在跑的会话保持绿色。**"判据不要求"和"优先级不覆盖"是两件事**，
   只做前一半不做后一半，就会得到"用户自己干活时那行一直黄着"。
2. **`kind='subagent'` 是语义过滤，不是性能优化。**
   `bash` : `subagent` 全表累计 7631 : 377；不过滤的误报率是 75%。
   用户要的是"我在等子 agent"，不是"我留了个 build 在跑"。
3. **不要加 TTL，不要用 `updated_at_ms`。**
   子 agent running 行没有心跳，两个都会误杀长任务。孤儿行永远黄着是可接受的失败方向。
4. **置顶护栏 `REORDER_MAX_ROOTS=128` / `REORDER_MAX_MOVES=16` 一个字都没改，也不许改。**
   新桶让单次搬移节点数变多，这是最容易想"调大一点"的时刻——
   详见 15.5 的两道闸门，新桶复用它们，超预算就提前中止、少排几行。

#### 一个已知边界

`applyWaitingOverlay` 只对**当前查询结果里确实存在**的会话行改桶。
如果判据命中的会话 id 不在 `local_runtime_sessions` 的结果集里
（实测遇到过一次：owner 有一行 running 的 subagent 任务，但该 session 行不在表内），
这一行**不会被画成黄色**——`if (!cur) continue;` 直接跳过。
这是刻意的：画一个侧边栏上根本不存在、也点不进去的行没有意义。
但它意味着"waiting 的行数"可能少于"判据命中的会话数"，排查时别把这当成 bug。

### 15.7 云端会话：Cloud 视图的状态点（2026-10-02）

侧边栏有 本地/云端 分段开关。**云端视图里行的 `data-session-id` 是纯数字**
（实测 2026-10-02：`447993841729699`），不存在于 `local_runtime_sessions`，
所以 `cfg.status` 永远查不到它们——云端行原本**永远没有状态点**。

数据真源是宿主自己的事件总线 store：`window.__MAVIS_EVENT_BUS_STORE__`
（zustand）。但它有两个坑，决定了实现形态：

1. **`getState().events` 是 200 条滚动窗口**（实测 200 = 11 cloud + 189 local）。
   启动时读一遍毫无用处——几分钟前开始的云端会话早已被挤出窗口。所以必须
   **订阅**，累积进自己拥有的 Map；Map 只存仍活跃的 id，丢旧窗口条目不丢状态。
2. **宿主 `addEvent` 是前插**（app.asar 实测：
   `events: [{...t, conversationSource: i}, ...e.events].slice(0, 200)`），
   `events[0]` 是最新。**重放必须倒序**——正序会把已 finish 的会话用更旧的
   `session.start` 复活成 running（绿点永不消失、汇总条虚高，要约 198 条
   本地事件才自愈）。首版测试全绿却线上必错，根因是**假 store 用了 push
   （后插）**，与宿主前插正好相反——测试的 store 必须复刻宿主形状，
   否则断言毫无意义。已在真机验证：已完成会话的 finish 在窗口头部、
   两条旧 start 紧随其后，`tracked=0`。

状态映射刻意**不引入本地没有的桶**：`session.start → running`、
`session.error → error`、`finish/abort → 从 Map 删除`（不画点，与本地
aborted 的默认行为一致）、其余（created/title_updated/pinned_updated）
一律忽略。键空间隔离有两道真实依据：本地 id 全部 `mvs_` 前缀（观测事实，
**不是** SQL 保证——主查询只有 `WHERE s.archived = 0`）；云端 id 必须
过 `/^[0-9]+$/` 才入 Map。64 并发上限的溢出**计数可观测**
（`cloudEvicted`，daemon 日志可见），绝不静默丢。

降级静默且完全：老版本宿主或沙箱渲染进程没有这个 store → 整段功能
不生效，本地路径原样工作。全套回归在 `test-cloud-bucket.mjs`
（119 项，含倒序重放 8 条回归锁）。

---

## 16. 沙箱工作流：绝不拿用户正在用的实例做实验

> 这不是可选项。本项目开发期间**两次把用户的窗口搞没了**：
> 一次是排程的"自动修复"脚本 `taskkill` 了整棵进程树，
> 一次是 15.5 那个 `display:flex` 事故把渲染进程搞进重排死循环。
> **凡是会改变宿主状态的动作，先开独立实例。**

### 16.1 怎么开一个沙箱

```powershell
# 复制主实例的 user-data-dir 保留登录态，用独立端口
pwsh -NoProfile -File .\src\open-sandbox-instance.ps1 -Port 9355 -Profile main
```

两条关键参数：

| 参数 | 为什么是它 |
|---|---|
| `--user-data-dir=<独立目录>` | **Electron 的单实例锁是按 user-data-dir 划分的**。换个目录就能绕开，所以不必、也不该去动用户那个实例 |
| `--remote-debugging-port=9355` | 独立调试端口，两边 CDP 互不干扰 |

`-Profile blank` 用全新空目录，起得最快（几秒），**但没有登录态**：
实测会卡在初始化，renderer CPU 烧到 174s 而**我们什么都没往它上面注入**。
要测真实侧边栏必须用 `-Profile main`。

实测：复制 1202 MB 的 user-data-dir 只需 **2.9 秒**（robocopy，排除
`Cache` / `Code Cache` / `GPUCache`），拿到 481 个可用会话行。

### 16.2 怎么关

```powershell
pwsh -NoProfile -File .\src\close-sandbox-instance.ps1 -Port 9355
```

**判据刻意不用端口。** 端口是可以被复用的普通数字，哪天主实例也起了 9355，
按端口匹配就会误杀用户正在用的窗口。沙箱独有的是 `%TEMP%\mmx-sandbox-*` 这个
**路径**，主实例的命令行里永远不会出现它。

同理，`open-sandbox-instance.ps1` 里**一条 `taskkill` 都没有**——
沙箱靠自己的 user-data-dir 标识清理，不靠杀进程。

### 16.3 一个必须自己踩过的坑：度量要排除沙箱

关沙箱的脚本第一版这样数主实例进程数：

```powershell
$mainBefore = @(Get-Process -Name 'MiniMax Code').Count   # ❌ 把沙箱也算进去了
```

结果：开沙箱后 16，关闭后 9，脚本大喊"**主实例进程数下降了！**"。
实际上 16 里有 7 个是沙箱的，**用户的实例一个没少**。

正确写法是排除沙箱路径：

```powershell
@(Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
  Where-Object { $_.CommandLine -notlike "*$sandboxRoot*" }).Count
```

**这类假警报会让人做出错误的紧急决策**，比没有度量更危险。

### 16.4 带熔断的沙箱实验

改宿主行为时，`reorder-sandbox-test.ps1` 演示了正确的实验姿势：

```
1. 记 CPU 基线（只统计沙箱的 renderer）
2. 启动只连沙箱端口的 daemon（--port 9355）
3. 每 8 秒采一次 CPU
4. 增量 > 40s 立即判定为死循环 → 杀 daemon → 熔断
5. 收尾必须核对「主实例 daemon 仍在运行」
```

第 4 步的阈值是硬的。**实验失败时要有自动刹车，不能靠人肉盯着。**

---

## 17. 目录结构

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
├── tests/                       ← 跨进程真实验证 + 冷启动/重启验收探针
│   ├── reload-e2e.mjs           强制 Page.reload，验证自恢复（含判据自证）
│   ├── watchdog-heal-e2e.mjs    杀守护，验证 watchdog 自愈（两种残留态）
│   ├── check-inject.mjs         独立进程查真实 DOM
│   ├── check-active.mjs         选中行底色独立复核
│   ├── rebootstrap.mjs          一次性重新注入
│   │
│   │  ── 注入验收探针（由 fix-coldstart / restart-cold / restart-e2e 调用）──
│   ├── verify-summary.mjs       汇总条：存在 / 位置 / 数字与实际 running 行一致
│   ├── verify-dot-sizes.mjs     状态点实测渲染尺寸（配 dot-sizes.js）
│   ├── dot-sizes.js             ↑ 上面那个的页面侧表达式，不是模块，不会被 import
│   ├── verify-pip.mjs           汇总条前缀竖条：尺寸 / 渐变 / 发光 / 闪烁
│   ├── verify-reorder.mjs       running 行是否真排到非 running 行之前
│   └── verify-running-visual.mjs running 行实测样式 + 截图（落 logs/shots/）
├── logs/                         ← 运行时日志与安装状态（git 忽略）
│   └── mmx-fix-lnk-backup.json   红 M 原始快捷方式配置备份（见 9.6）
├── assets/
│   └── mmx-fix.ico              自绘红色 M 图标（7 档尺寸，16~256）
└── src/                          ← 25 个 .mjs（22 + lib/ 3）+ 19 个 .ps1
    ├── daemon.mjs               守护主程序（重连 / 重注入 / 致命兜底）
    ├── watchdog.mjs             常驻看门狗（双路端口发现 + 单实例锁 + 三闸门；⚠️ 能 kill/重启应用，见 9.6.2）
    │
    │  ── 测试（7 个不需要 CDP，随时可跑）──
    ├── selftest.mjs             116 项自测（含 daemon 僵尸上限 6b）
    ├── test-cloud-bucket.mjs    119 项：云端状态点全套 + 倒序重放回归锁 + attribute observer 锁（见 15.7 / 8.4）
    ├── watchdog-selftest.mjs    83 项自测（含启动器握手 8 条）
    ├── test-autofix-gates.mjs   --fix-app 三闸门测试（32 项，每闸门正例+反例）
    ├── test-reorder-defaults.mjs reorder 默认值 / 逃生舱 / 启动器参数构造 / 杀旧 daemon 筛选（40 项）
    ├── test-waiting-bucket.mjs  waiting 判据 / overlay 优先级锁 / kind 过滤回归锁 / 页面侧样式与置顶（49 项，见 15.6）
    ├── test-process-filters.ps1 进程过滤器回归（D 组 Test-IsStaleDaemonProcess + 端口参数形态，见 9.5）
    │
    │  ── 启动 / 安装 ──
    ├── launch-mmx-status.vbs    无控制台入口（红 M 的直接目标：wscript 调它，它再隐藏调 ps1，零黑窗，见 14.8）
    ├── launch-mmx-status.ps1    无窗口启动器（VBS 调的就是它，无 Read-Host，做完即退）
    ├── start-mmx-status.ps1     原始前台交互启动器（有 Read-Host，终端/排查用，不是日常入口）
    ├── stop-mmx-status.ps1      清注入 + 停守护（**不关应用**）
    ├── install-launcher.ps1     **只创建 mmx-fix.lnk**（不碰官方 .lnk）+ 加 Run\mmxStatusWatchdog 自启（见 14.2）
    ├── uninstall-launcher.ps1   删 mmx-fix.lnk 并删自启项（官方 .lnk 从未被改动，无需还原）
    ├── lib-stale-daemon.ps1     共享：杀陈旧 daemon + --port 参数形态判定（launch/start/stop 三处 dot-source）
    ├── relaunch-cdp-delayed.ps1 延迟带 CDP 参数重启（排程用：说完话再自动执行）
    ├── fix-coldstart.ps1        一键修复：换成带 CDP 的启动（⚠️ 会关闭所有非沙箱实例，含主实例）
    ├── make-mmx-icon.ps1        GDI+ 生成 mmx-fix.ico
    ├── push-retry.ps1           测连通性后再 push（见 18.2 网络不通时的用法）
    ├── fix-ps1-encoding.ps1     批量补 UTF-8 BOM + 统一 CRLF（见 9.4）
    │
    │  ── 沙箱（第 16 章，绝不拿主实例做实验）──
    ├── open-sandbox-instance.ps1   开独立沙箱实例（独立 user-data-dir + 独立端口）
    ├── close-sandbox-instance.ps1  关沙箱（只认沙箱路径，不认端口）
    ├── reorder-sandbox-test.ps1    带 CPU 熔断的沙箱实验
    ├── apply-to-main-window.ps1    把变更施加到主窗口（破坏性，仅在确认无进行中会话时用）
    │
    │  ── 冷启动 / 重启验收（都会动应用进程，慎用）──
    ├── restart-cold.ps1         真杀应用的冷启动验收
    ├── restart-e2e.ps1          端到端重启验收
    ├── reload-recovery.mjs      重载后自恢复验证
    │
    │  ── 诊断 ──
    ├── diagnose-dots.mjs            状态点排查
    ├── diagnose-expand.mjs          展开行为排查
    ├── diagnose-click-expand.mjs    点击是否触发展开
    ├── diagnose-collapse-stick.mjs  手动折叠能不能粘住
    ├── diagnose-expand-owner.mjs    展开状态到底归谁所有
    ├── diagnose-active-row4.mjs     选中行底色（第 4 版锚点法）
    ├── debug-guard.mjs              展开守卫调试开关
    ├── probe-active.mjs             当前选中行探针
    ├── capture.mjs                  截图 + 状态探针
    ├── cleanup.mjs                  页面侧还原
    │
    │  ── 验证 ──
    ├── verify-guard-causal3.mjs  守卫因果对照（8.3）
    ├── verify-never-expand.mjs   永不展开验证
    ├── verify-active-bg.mjs      选中行底色验证
    ├── e2e.mjs                   19 项端到端（⚠️ 连真实实例，勿在主实例上跑）
    ├── test-launcher.ps1         20 项启动器测试（⚠️ 自建一次性实例）
    │
    └── lib/
        ├── cdp.mjs              零依赖 CDP 客户端
        ├── page-script.mjs      注入脚本（核心：状态点 + running/waiting 竖条 + 汇总条 + 置顶，reorder 默认 true）
        └── status-db.mjs        只读状态读取 + 桶映射
```

> 📌 `src\` 下 25 个 `.mjs` + 19 个 `.ps1` 全部列在此。
> **新增文件时务必同步更新这棵树**——它就是"真源在哪"的唯一书面记录，
> 而 9.6 那个坑正是"改了一份、跑的是另一份"造成的。

---

## 18. 故障排查速查表

| 症状 | 最可能的原因 | 怎么确认 | 怎么修 |
|---|---|---|---|
| **侧边栏一个状态点都没有** | 用官方 `MiniMax Code.lnk` 启动的（没带 CDP 参数） | `Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" \| Where-Object { $_.CommandLine -notlike '*--type=*' }` 看命令行有没有 `--remote-debugging-port` | 关掉，用 **`mmx-fix`**（红 M 图标）重开；或跑 `.\src\fix-coldstart.ps1` ⚠️ **该脚本会关闭所有非沙箱实例，正在进行的会话会中断——只想纠正主实例就别用它，点红 M 即可** |
| 端口文件里有 `9331`，但注入不上 | **陈旧残留**。文件存在 ≠ 端口在监听 | `Invoke-RestMethod http://127.0.0.1:9331/json/version` 必须返回 200 | 同上，重启应用 |
| daemon 跑着但点不变 | daemon 内存里是**旧版 page-script** | 状态点数量正常、但样式是旧的 → 就是没重启 | 杀掉 daemon 重起 |
| **改完代码、测试全绿、git 也推了，用户却一点没变化** | **用户加载的是另一份副本**（详见 9.6） | **读 `window.__mmxStatus.cfg.reorder`：主实例和沙箱同屏对照**。一个 `false` 一个 `true` 就是铁证。数点数/看样式/看日志都会给假 PASS | 把快捷方式和**全部四条启动链**指向同一真源（git 仓库），并核对 `mmx-fix.lnk` 的 `WorkingDirectory` |
| 改了没生效，但 `git log` 明明有提交 | `Run\mmxStatusWatchdog` 开机自启仍指向旧副本，开机后 watchdog 又把旧版拉起来 | `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'` 看 `mmxStatusWatchdog` 的值 | 删掉或改指向 git 仓库下的 `watchdog.mjs`（`uninstall-launcher.ps1` 可清） |
| 现象符合预期，但**应用莫名重启 / 窗口被关掉** | **watchdog 带 `--fix-app` 在自动重启应用**（`watchdog.mjs:701`） | 查有没有 `watchdog.mjs` 进程、命令行里是否带 `--fix-app` | 立刻停掉 watchdog。**本机当前状态是停用的**，原因就是启用它会杀掉用户正在用的实例（见 9.6.2） |
| **想启用 watchdog 自愈，但用户正在用主实例** | `--fix-app` 会结束正在运行的实例并重启 | 先问用户有没有进行中的会话，**不要自己判断** | 确认无会话后，只在**独立沙箱实例**上验证；绝不在主实例上开 |
| 点了红 M 图标没反应 | 应用已带 CDP 在跑，launcher 正确地什么都不做 | 看 `logs\launch-*.log` 最后两行 | 正常，无需处理 |
| 侧边栏 CPU 飙高、界面卡死 | 改宿主布局导致重排死循环（见 15.5） | renderer `CPU` 持续上涨，`Runtime.evaluate` 30s 超时 | 只能重启应用；2026-10-02 起置顶默认开启，`--no-reorder` / `-NoReorder` 就是为这个症状准备的逃生舱 |
| e2e 报「还原后 10 秒不复活」失败 | **daemon 正在运行**，每 2.5s 会把点重新画回来 | `Get-CimInstance ... -like '*mmx-status*daemon*'` | 跑 e2e 前先确认没有 daemon |
| `.ps1` 双击报错、pwsh 里却正常 | UTF-8 无 BOM + 中文，PS 5.1 按 GBK 解码崩溃 | 用 `powershell.exe`（5.1）解析会报错，pwsh 7 不报 | `.\src\fix-ps1-encoding.ps1 -Dir .\src` |

### 18.0 症状 → 章节 速查（2026-10-03 更新）

| 症状 | 去哪 |
|---|---|
| 点红 M 弹黑窗 | 14.8（VBS 根治；若仍出现，检查 .lnk 是否还指 powershell.exe） |
| 侧边栏完全没有状态点 | 14 章自愈链路；`logs\daemon-*.log` 0 字节 = import 阶段死了，先查 page-script 语法（14.7） |
| 置顶的会话切换云端/本地时闪一下又折叠 | 8.4（attribute observer，已归零；若复现抓 `scrollHeight` 逐帧证据） |
| 已完成的云端会话一直绿点不消失 | 15.7 倒序重放（test-cloud-bucket 第 4c 节是回归锁） |
| daemon 越积越多 / 空转不停 | daemon 240 次上限自退 + watchdog 握手（14.7 / 14.8） |
| 双 daemon 打架 | 14.8 竞态握手；`logs\watchdog.log` 里应有"让启动器完成"字样 |

### 18.1 最常用的一条命令

> ⚠️ **这一条会关闭所有非沙箱的 MiniMax Code 实例，正在进行的会话会中断。**
> 只想纠正主实例、不想动任何窗口的话，**点桌面红 M（`mmx-fix.lnk`）就行**。
> 下面这条是最后手段。

```powershell
# 一键把状态恢复到"应用带 CDP + daemon 在跑 + 注入正常"
pwsh -NoProfile -File .\src\fix-coldstart.ps1 -DelaySec 0
```

> ⚠️ **动手前必读：它会关闭所有非沙箱的 MiniMax Code 实例。**
> 2026-10-02 之前这个脚本是两次无条件 `taskkill /T /F /IM 'MiniMax Code.exe'`，
> 杀光**全部**实例——含已带 CDP 的主实例，也含沙箱，而且不区分。
> 现在它按 PID 逐个杀，并**排除沙箱**（判据只看命令行的 `--user-data-dir`
> 路径或 `mmx-sandbox` 标识，**不按端口**：2026-10-02 踩过"沙箱换端口就漏判、
> 又被当主实例杀掉"的坑）。
>
> 即便如此，它仍会关闭**主实例**，所有正在进行的会话都会中断。
> 数据存在 SQLite，重启后可从侧边栏点回，但那一轮正在跑的东西没了。
>
> **只想纠正主实例、不要动任何窗口：别用这个脚本，点桌面红 M（`mmx-fix.lnk`）。**
> `fix-coldstart.ps1` 是最后手段。

它会：杀掉所有没带 CDP 的非沙箱实例 → 用 `mmx-fix` 重开 → 轮询确认端口真通 →
验证注入。**全程会关闭应用**，动手前请确认当前没有正在进行的会话。

### 18.2 推不上去时：先测连通性，别对着死出口反复重试

```powershell
pwsh -NoProfile -File .\src\push-retry.ps1
```

它先测 `api.github.com` 通不通，**通了才 push**，不通就直接告诉你本地领先几个
提交、提交安全存在本地。

2026-10-02 遇到的真实故障长这样（`GIT_CURL_VERBOSE=1` 才看得到）：

```
== Info: Establishing HTTP proxy tunnel to github.com:443
== Info: CONNECT phase completed for HTTP proxy
== Info: TLSv1.3 (OUT), TLS handshake, Client hello (1):
== Info: TLS alert, decode error (562)          ← 5 秒后出口把连接掐了
fatal: TLS connect error: error:0A000126:SSL routines::unexpected eof
```

**判别要点**：本机网络是好的（baidu 直连 200），代理隧道也建成了，
挂在 TLS 握手之后的 5 秒——这是**代理出口对 github 的线路问题**，不是 git 配置、
不是仓库问题、也不是代码问题。换节点或重启代理即可。

---

## 19. 致谢

- 第三方项目 [`sqing33/minimax-code-skin`](https://github.com/sqing33/minimax-code-skin)
  首次证明了 CDP 路线在 MiniMax Code 上可行。**但要注意**：它的 subagent 识别在真机上
  大概率失效——key 的 `data-agent-type` / `data-agent-kind` / `data-session-type` /
  `role="treeitem"` 在真实 asar 里**全部 0 命中**，测试 fixture 是编造的。
  本项目改用 `data-session-id` + SQLite 直查，绕开了识别问题。
- MiniMax Code 官方文档 <https://agent.minimaxi.com/docs/llms.txt>

MIT License.
