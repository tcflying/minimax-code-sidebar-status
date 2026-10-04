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

> **📌 2026-10-04 状态速记（读上面那张表之前先读这一段）**
>
> 1. **上面「running 行自动置顶」这一行只对**各项目分组下的**普通会话列表**成立。
>    **置顶区（pinned）的顺序本项目一律不碰**——宿主 `pinned-items-order` 数组是唯一真相源。
>    所以**「所有已置顶的会话会被自动排到最前面」是错的读法**：置顶区里哪怕正在跑，
>    也不会被自动搬到置顶区最前，也不会被自动插进普通列表。
>    源码坐标见 15.5「置顶区不再由本项目排序」与 12「已知边界」。
> 2. **「已置顶很靠下的会话对话后不自动到顶」是当前磁盘源码的显式排除所致**
>    （2026-10-03 的既定裁定，形态见 15.5 末尾）。**对用户这次的新预期而言，
>    它是一个尚未覆盖的产品缺口**：需求存在、实现没有，且本轮未获授权去补。
>    要把某个已置顶会话真的顶到最前，请用 15.8 的「到最顶」或 15.10 的红色悬停锁顶——
>    **这两个都不是「普通会话列表的自动提升」入口**；红锁另有**已授权、有界**的后台维持。
>    **本轮未取证**用户点的是哪个界面路径。逐条见 15.16。
> 3. **本轮（2026-10-04）只更新了文档**：登记了新症状、状态点语义勘误，以及一批
>    **尚未修复**的缺陷。**代码未修、未部署、GUI 未测**。逐条见 15.16。
> 4. **2026-10-05 修复批次已落地（离线全绿，未部署、未在真实宿主生效）**，详见 15.16.8。

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
活 error  >  running  >  paused  >  waiting  >  陈旧 error  >  done / idle
```

（"活 error"指 `status` 本身是 `error/failed`；"陈旧 error"指 status 已回 `idle`、
只是 `error_message`/`terminal_outcome` 还留着上次失败的痕迹——见下方实测案例。）

只有**当前不是更高级信号**的会话才会被 waiting 接走。这条守卫是**实测加上去的**：

| 做法 | 实测后果 |
|---|---|
| ❌ 无条件 overlay | 根会话 `mvs_743fa8` 自身 `status='started'` 且有 2 个活着的子 agent，**用户自己那一行整个工作期间一直是黄的** |
| ✅ 加优先级守卫 | 自己 turn 还在跑就是 `running`（绿），只有**已经把控制权交还**的会话才转黄 |

根会话干活时**几乎总是**有子 agent，所以不设守卫的话 `waiting` 会变成一个常亮颜色，
绿色 `running` 也就失去了意义。上游三个桶一个都不许被盖，理由各不相同：

| 桶 | 为什么不能被 waiting 盖掉 |
|---|---|
| 活 `error` | **正在发生的失败不能被一个更平静的颜色盖掉**——红是最高优先级 |
| `running` | turn 还在执行，它**根本没在等任何东西** |
| `paused` | 中断态是**等用户处理**的，涂成"在等子任务"等于**把待办抹掉** |
| done / idle | 无信息可遮蔽，**允许**被 waiting 接走（这才轮到黄出场） |

**陈旧 error 必须让位于黄（2026-10-03 真机案例，`mvs_1feaae52`「MMX Code 远程web版」）**：
会话 `status='idle'`、`terminal_outcome='completed'`，但 `error_message` 里躺着早前一次
BYOK 429 限流失败的残留文本；与此同时它的 **Agent Team 两个子代理正在跑**
（`local_runtime_background_tasks` 两条 `subagent/running`）。
`bucketFor` 经 `hasErrorMessage` 判成 error，旧行优先级 `error > waiting` 把黄压死——
用户盯着聊天区"等待 Agent Team 返回结果..."、侧边栏却一个黄都没有（红点也不显眼）。
结论：`error_message`/`terminal_outcome` 是**历史**，活着的子任务是**现在**，现在赢。
只有 `status` 字段本身处于 `error/failed` 才算"活错误"、才继续压黄。

> ⚠️ "不要求父会话是 `started`"和"`started` 被忽略"**是两句话**。
> 前者说的是 waiting **不排斥**非 started 的会话；后者说的是 started **优先**。
> 把两者混为一谈，正是上面那个"用户自己那行一直黄着"的 bug 的成因。
>
> 优先级顺序写在 `status-db.mjs` 的注释里，并由 `test-waiting-bucket.mjs` 逐条断言：
> `error 优先于 waiting（红不被黄盖掉）`、
> `paused 优先于 waiting（橙色中断态是待用户处理，不该被盖）`、
> `running 优先于 waiting`、
> `陈旧 error_message（status=idle）+ 活子 agent -> waiting 接管`、
> `status=error 的活错误 + 活子 agent -> 仍 error（红不被盖）`、
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

### 8.5 置顶区「更多」展开记忆（截断恢复，2026-10-03）

用户报：**置顶区本来展开二十几条，点一下云端标签再点回本地，所有
session 自动收缩成 6 条，下面一个「更多」**。真机取证还原机制：

- 宿主的置顶列表默认截断为 **6 行 + 「更多」按钮**（截断态下隐藏行被
  **卸载**而非遮蔽：DOM 里只有 6 行；展开态下**容器内根本没有按钮**，
  也没有任何收起控件）。
- 每次 本地↔云端 视图切换，宿主**重挂载**本地列表，展开态被重置回
  默认截断——用户点过的「更多」白点，每次切换后都要重新点。

修复（`page-script.mjs` 的 pinned-more 块）：

1. **记忆**：capture 阶段监听 document 点击，只认 `isTrusted` 的真实
   点击（我们自己的合成恢复点击 `isTrusted=false`，天然不会反馈进记忆）。
   点「更多」记 `want=true`、点「收起」记 `want=false`，落在
   `localStorage['mmxStatusPinnedMore']`——**重注入和应用重启后依然生效**。
2. **恢复**：每个 apply tick，`want=true` 且置顶容器内出现展开向截断
   按钮且可见（`getClientRects` 非空）时，替用户点开一次。自限：展开后
   容器内无按钮，下一轮自然扑空。
3. **可观测**：恢复计数进 tick stats（`pinnedMoreRestored`），
   `window.__mmxStatus.pinnedMore()` 暴露 `{want, restored, button}`。

**范围纪律（一次真机翻车的教训）**：首版给按钮搜索加了
`sec.parentElement` 兜底，结果置顶区**展开**时兜底抓到了父容器里
**项目组自己的「更多」按钮**（结构完全同构：`DIV.space-y-px →
DIV.grid`），在 DOM 抖动期间以 ~2 次/秒空点了 150+ 次（稳态实测
`restored` 3 秒涨 6）。终版严格限定 `sec.querySelectorAll`——容器外
的东西永远不点、不记。回归锁 8 条锁住：reorder 后挂钩 / isTrusted
守卫 / 只点展开向 / 不可见不点 / localStorage 恒键 / 严格范围 /
捕获+dispose / api 视图。

真机验证：种 `want=true` 后重注入（当下截断态）首 tick 恢复、展开稳态
5 秒零增长；云端→本地完整复现自动回展开（每轮重挂恢复 2 次均为真实
截断→点开），daemon 日志可见 `pinnedMoreRestored`。

**与本工具其他"折叠"的关系**：8.1–8.4 的守卫压的是**行内 caret**
（子任务预览）；本节恢复的是**列表级截断**（「更多」）。两者正交：
行内永不自动展开，列表级尊重用户选择。

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
node .\src\test-cloud-bucket.mjs             127 项 · 不需要 CDP
node .\src\test-reorder-pinned.mjs            50 项 · 不需要 CDP
node .\src\test-topmost-menu.mjs             603 项 · 不需要 CDP
node .\src\test-pinned-lifecycle.mjs          73 项 · 不需要 CDP
node .\src\test-topmost-diag.mjs              144 项 · 不需要 CDP
node .\src\run-mutations.mjs                  43 个变异全红才算过 · 不需要 CDP
node .\src\watchdog-selftest.mjs              83 项 · 不需要 CDP
node .\src\test-autofix-gates.mjs             32 项 · 不需要 CDP
node .\src\test-reorder-defaults.mjs          40 项 · 不需要 CDP
node .\src\test-waiting-bucket.mjs            52 项 · 不需要 CDP
pwsh -NoProfile -File .\src\test-process-filters.ps1   28 项 · 需要应用在跑（但**不需要 CDP**）
node .\src\e2e.mjs --port 9331               19 项 · 需要已开 CDP 的实例
pwsh -NoProfile -File .\src\test-launcher.ps1        20 项 · 自建一次性实例
```

> 新增的三个套件**先切片出厂代码再在假 DOM / 假 fiber 上跑**，
> 所以它们断言的是行为而不是源码里的字符串。
> 这一点是被教训逼出来的：旧的 127 条源码正则断言只在源码里**找字符串**，
> 所以"搬移循环被清空""dispose 不再删点"这类改动**照样全绿**——
> 模式还在，实现已经没了。正则断言证明不了实现还能跑。
>
> 三个套件都支持 `MMX_MUTATE=<id>`，把某处**故意改回旧写法**后必须变红：
>
> ```
> node .\src\run-mutations.mjs        # 一次跑完 43 个变异并打印矩阵
> MMX_MUTATE=d1 node .\src\test-reorder-pinned.mjs     # 期望 FAILED
> MMX_MUTATE=m1 node .\src\test-topmost-menu.mjs       # 期望 FAILED
> MMX_MUTATE=s5 node .\src\test-pinned-lifecycle.mjs   # 期望 FAILED
> ```

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
| `test-reorder-pinned` | **置顶区排序三缺陷的行为锁**（切片 `findListRoots`/`sameOrder`/`countMoves`/`applyReorder` 出厂代码）：置顶区**零 insertBefore**、项目子列表照旧、变更检测**零搬移**与**复位后能修**、**同下标不同会话**也会搬、预算**整轮不动**且 `planned` 如实上报（见 15.5） |
| `test-topmost-menu` | **「到最顶」全套**：精确选择器（7 参依赖 / 三参 / `.pinSession`+`.getSessionInfo` / local 源 / 非只读）/ 同形诱饵被拒 / 多候选 fail closed / alternate fiber / 菜单**归属到被右键的那一个** / 复制子菜单与空菜单不注入 / 反复开合只有一项 / **显式 `(id, true, 0)` 且落库也带 0** / 已在首位 no-op / 行已卸载拒绝调用 / 并发只放行一次 / 合成点击不触发（见 15.8） |
| `test-pinned-lifecycle` | 汇总条**位置**（不只是父节点）/ 截断按钮**不会点到**标题为「更多」的会话行与行内子列表的同名按钮 / `展开其余 N 项` 文案 / **展开记忆的逃生控件**（不改宿主 DOM）/ 展开守卫 40px 阈值 / **dispose 摘掉全部监听与节点** / dispose 后 rAF 不再跑 apply（见 15.8） |
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
| 桌面端源不开源，升级后锚点可能变 | 状态点锚点只有 `data-session-id` 一个。「到最顶」依赖宿主 `handlePinSession` 钩子的**精确签名**（7 参依赖 + 三参 + `.pinSession`/`.getSessionInfo` 源码标记）；宿主一改就退化成**禁用菜单项 + `api.topmost().reason`**，不会误动作 |
| 「到最顶」的**完整应用重启后**持久性 | **未测**：本轮不重启宿主（会打断用户活任务）。已用「只读导出 `pinned-items-order` → 重新注入 → 视图重挂 → 再导出比对」代替，**不得**据此声称重启后仍保持 |
| 「到最顶」在**云端视图** | **fail closed**：菜单项禁用并写明 `cloud-not-provable`。云端 id 是纯数字（实测 `447993841729699`），本机 `pinned-items-order` 里只有本地 `mvs_` 会话，没有证据证明同语义 |
| 活跃置顶会话"沉底"的用户报告 | **未复现**。已修的是三个**静态可证**的排序缺陷（置顶区双写、下标派生的缓存键、预算中途放弃），**它们不构成该报告的已证实根因**。见 15.5 末尾 |
| 覆盖范围：置顶区 + 各项目分组区 | 状态点/汇总条/展开守卫**两者都覆盖**。**排序只覆盖各项目分组**——置顶区的顺序由宿主的 `pinned-items-order` 数组唯一决定，2026-10-03 起本项目**不再在其中搬 DOM**（见 15.5）；要把置顶会话挪到最前请用 15.8 的「到最顶」 |
| 套在另一个容器里的分组列表要多几轮才排到位 | **实测 2 轮搬移 + 第 3 轮确认**（`test-reorder-pinned.mjs` D2.5），即最多 2 个 daemon 周期的滞后。中间态都是**正确的前移**、不是乱序，且因为**不缓存**所以不会卡住。详见 15.5「嵌套容器需要多轮才收敛」 |
| 「到最顶」的**键盘可达性** | **Tab 可达**（项带 `tabindex="0"`），Enter/Space 可激活（Space 会 `preventDefault`，否则侧边栏跟着滚）。**但方向键不参与**——宿主 rc-menu 的漫游 tabindex 只认它自己渲染的项，追加的 `li` 不在其中，`ArrowDown` 会跨过它。要接管就得全局拦截键盘，代价更大，**故不做**。**不得表述为"完整支持键盘导航"**，见 15.8 |
| 「到最顶」的**右键重试窗口** | 仍是 `0/8/16ms` 共 3 次，**本轮有意未放宽**。是否放宽由**主对话真机 20 次右键的命中率**决定，不靠推断 |
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
| `REORDER_MAX_MOVES` | 32 | 单次搬多少节点。匹配到 100 个容器但只有 3 个有 running，就只搬 3 个节点 |

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
> 需要的搬移数超限时，**整轮一个节点都不动**并上报
> `aborted:'move-budget-exhausted'` + `planned:N`，
> 表现为一两行没排上去，而不是整个侧边栏被拖死。
> **把"少排几行"当成可接受的降级，把"卡死页面"当成不可接受。**

#### 预算必须**前置预检**（2026-10-03 修正）

旧实现把预算检查放在**搬移循环内部**，超限就 `return`，
留下一轮**搬了一半的乱序**（2026-10-02 实测：18 选中，搬了 16 个就
`aborted='move-budget-exhausted'` 退出，顺序是乱的）。
> 那组数字是**当时 ceiling 还是 16** 的一次现场记录——18 个要搬，只搬了 16 个
> 就被循环里的检查打断。**它现在不是活的上限**：ceiling 早已是 32，
> 18 次搬移根本不触发任何东西。保留它是因为它正是"中途退出"这个缺陷的证据。
现在改成：先用 `countMoves()` 在**子节点数组的副本**上把
「从后往前 `insertBefore`」这套动作**完整模拟一遍**，数出本轮真正需要的搬移数，
**超限则整轮不动**。

```js
// 真实 DOM 一个字节都没碰，得到的却是这一轮确切的 insertBefore 次数
if (planned > REORDER_MAX_MOVES) {
  return { moved: 0, planned: planned, aborted: 'move-budget-exhausted', ... };
}
```

不模拟就没法"前置"，而不能前置就一定会中途留下乱序——
这正是 `planned` 这个字段存在的理由：超限是可诊断的，不是静默的。

#### 变更检测：**不再有缓存键**（2026-10-03 修正）

旧实现有一个 `lastReorderKey`，键值由**被选中的行在 `root.children` 里的下标**拼成
（`indexOf.call(root.children, w)`），和上一轮的键比对。两个后果都是确定的：

| 缺陷 | 机制 | 现场症状 |
|---|---|---|
| 搬过之后必然再搬一轮 | 一次真实搬移必然改变下标 → 键必然与上一轮不同 | 每轮重排都**多产生一轮无净变化的搬移** |
| 宿主复位看不见 | 宿主把列表重渲染回它自己的顺序后，下标又变回原值 → 键**又相等了** | 复位**永远不被修复**，列表一直错下去 |
| 同下标不同会话看不见 | 键里没有会话身份 | 该搬的没搬 |

现在**没有键、没有任何跨轮状态**。每轮对每个容器做一次纯比较：

```js
var ideal = selected.concat(rest);      // 理想顺序 = [running…][waiting…][其余原相对序]
if (sameOrder(kids, ideal)) { alreadyOk++; continue; }   // 已经对 → 零 insertBefore
```

「已经对」= **零 `insertBefore`**（不是"搬了但结果一样"），
「被外部重置」= 下一轮比较不等 → 当场修回来。
没有可以变陈旧的状态，也就没有"复位看不见"这一类 bug。

#### 置顶区不再由本项目排序（2026-10-03）

置顶区的顺序**只有一个真相源**：宿主的 `pinned-items-order` 数组。
渲染代码（asar `@316732355` / `@316733013`）把该数组的前 6 项
`slice(0,6)` 之后按数组序渲染成行。**我们以前在同一个容器里用 `insertBefore` 排同一个顺序**，
两套控制权指向一个事实。

现在 `findListRoots()` 明确排除置顶区，判据取自本安装宿主的真实锚点：

| 锚点 | 说明 |
|---|---|
| `data-pinned-section` | 真实 DOM 属性，置顶区容器（装着置顶列表的那个 section） |
| `data-sidebar-drop-id` | 真实属性，但本安装只取 `pinned-drop-zone` / `pinned:` 前缀的值；`recent-sessions` / `projects` / `agents` **不在排除范围** |
| `pinned-drop-zone` | 本安装是 dnd-kit 的 **JS 侧 id**，DOM 上只有 ref；仍然检查，以防别的构建真的渲染成属性 |

排除计数随 `apply()` 统计一起上报（`reorder.pinnedSkipped`），
所以"置顶区到底有没有被识别到"在 daemon 日志里是**可查的**，不是靠信任。

**`pinnedZoneOf` 一路走到文档根，不设固定层数。**
层数上限是个猜测：浅一层，置顶区里的行就认不出来了，
而这个失败方向是最糟的那个——**我们会重新开始搬置顶列表**。
DOM 遍历本来就终止于文档，所以代码里那个 `d >= 64` 只是兜底，
不是机制；真的撞上它按"**可能**是置顶"处理，同样不搬。
> ⚠️ 早先的写法是 `d < 12` 的定深循环。缺陷在**保护的位置**上：
> "深度用尽就当置顶"那条 `return` 写在**循环体内部**，
> 一旦循环本身被限深，那条 `return` 根本执行不到，函数直接落到末尾的
> `return null`——也就是"**不是置顶**"。于是**隔着 15 层的真置顶区被当成
> 普通列表搬了**。变异 `MMX_MUTATE=d4` 就是把它改回 12 层，
> 会让 `test-reorder-pinned.mjs` 的 D1.6 变红（`pinnedSkipped=0`、置顶列表被搬）。

**各项目分组的子列表行为逐字节不变**：`--no-reorder` 语义不变，
`REORDER_MAX_ROOTS/MAX_MOVES` 不变。

#### 嵌套容器需要多轮才收敛（2026-10-03 实测）

容器之间是独立的，但**一个套在另一个里面的容器**不是同一轮能收尾的：
子树里有行的列表**自己也是候选根**，而搬动它会改变外层下一轮读到的子节点。
实测（`test-reorder-pinned.mjs` 的 D2.5）：

| 轮次 | 外层 | 内层 | 说明 |
|---|---|---|---|
| 1 | `o3, o1, [内层], o2` | `i2, i1, i3, i4` | 内层在自己内部搬好了；外层此刻还把内层当**普通包裹**读（首行 i1 没点） |
| 2 | `o3, [内层], o1, o2` | 同上 | 第 1 轮把 running 的 i2 放到了内层头部，外层于是改把**内层本身**当成 running 包裹提到队首 |
| 3 | 同上 | 同上 | 两个根都等于各自理想值 → `alreadyOk`，`moved=0` |

即**最多 2 个 daemon 周期的滞后，永远不会卡住**。
真正要紧的不是轮数而是**中间态**：每一轮中间态都是一次**正确的前移**，
不是乱序——因为搬移循环是从后往前，且每个理想序列都从该根**自己当时的活子节点**推出。
**也只有"不缓存"才可能收敛**：一个在搬移前算好的键，
会在下一轮认定"它刚改过的这个列表没问题"。

> 📌 **归因纪律**：以上三个缺陷是**静态可证**的代码缺陷，已修并有变异证明。
> 用户报告的"活跃置顶会话偶发沉底"**真机路径尚未复现**，
> **不要把这两件事合并叙述成"沉底已修复"**。想把置顶会话挪到最前，
> 走 15.8 的「到最顶」——它改的是数组本身，不是 DOM。

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
4. **置顶护栏 `REORDER_MAX_ROOTS=128` / `REORDER_MAX_MOVES=32` 一个字都没改，也不许改。**
   （MOVES 是 `16 -> 32` 改过来的，**那次改动在加 waiting 桶时就已经做完**，
   早于本轮；本轮只是把文档里的 16 改回来。）
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
（127 项，含倒序重放 8 条回归锁）。

---

### 15.8 会话右键「到最顶」（2026-10-03）

用户诉求：**把某个会话置顶，并放到置顶区最前**；已置顶/未置顶都要能用，
**不需要先给这个会话发消息**。

#### 走的是宿主自己的语义，不是我们发明的

`pinned-items-order` 是宿主持久化的**有序数组**，宿主已经把整条链路接好了：

```
handlePinSession(sessionId, pinned, insertIndex)        ← asar @317043972
  ├─ if (isReadOnlySessionById(id, src)) return;        ← 静默拒绝
  ├─ next = updatePinnedRefs(order, {session,id}, pinned, insertIndex)
  │         先把自己 filter 掉，再按 clamp 后的下标插回去
  │         insertIndex 缺省 = 追加到末尾；insertIndex = 0 = 插到最前
  ├─ setPinnedItemsOrder(next)                          ← 乐观更新
  └─ await pinSession(id, pinned, insertIndex)          ← 落库（asar @317045053）
       失败 → 宿主自己回滚数组 + error toast
```

所以「到最顶」= 以 `insertIndex: 0` 调这一条。**对已置顶项天然幂等**
（先摘出再插到 0），对未置顶项是「置顶 + 首位」一步完成。

#### ⚠️ 两参 props 回调**绝对不能**拿来用

侧边栏行组件收到的 prop 是**两参 wrapper**：

```js
// asar @316963124 / @317072055
onPinSession: (e, t) => void u.handlePinSession(e, t)
```

调 `onPinSession(id, true, 0)` 的第三个实参**会被静默丢弃**，
宿主随即把会话**追加到置顶区末尾**——正好是「到最顶」的反面，
而且**没有任何报错**。因此本项目**从不调用 props 上的任何 pin 回调**。

真正的三参 `useCallback` 在侧边栏容器 fiber 的 `memoizedState` 钩子链里。
选择器是**精确匹配**，不是"找一个同名函数"：

| 判据 | 排除掉谁 |
|---|---|
| `memoizedState` 形如 `[fn, deps]` 且 `deps.length === 7` | 非 `useCallback` 节点、6 参的 sidebar hover 回调 |
| `fn.length === 3` | 两参的 `onToggleSession` 之类 |
| `fn.toString()` 同时含 `.pinSession` 与 `.getSessionInfo` | `handlePinAgent`（8 参依赖、只调 `pinAgent`）、同形的悬停回调 |
| `deps[2] === 'local'` | 云端视图那一份（云端先 fail closed） |
| `deps[0](id, src)` 为假 | 只读会话（宿主会**静默 return**，调了等于没调） |

`deps[1]` 就是宿主当前的置顶顺序数组，「已经在首位」是**读它**判出来的，
不是记在本项目里的缓存——宿主失败时会把自己的数组回滚，本地缓存会跟它永久分歧。

#### 能力不足一律 fail closed

拿不到、拿到多个、只读、云端——**四种情况都注入一个禁用菜单项并把原因写在脸上**
（例：`到最顶（no-handle-pin-session）`），**没有兜底路径**：
不回退去调 props 回调、不找动作注册表、不走后端 fetch、不碰 token/端口。
更**没有**"只在渲染层把它排到最前"的假置顶：那种做法宿主数组没变、
重启即失效、别的视图看不到，还会让人误以为置顶成功。

#### 只在用户真的点了的时候才动手

- 只监听 `contextmenu`（捕获阶段，**不** `preventDefault`、**不** `stopPropagation`），
  不碰普通 `click`/`input`/`keydown`。
- 菜单项是**追加**在宿主菜单末尾的一个 `li.ant-dropdown-menu-item`，
  沿用宿主自己的 `matrix-menu-item` 结构，**原有条目与分隔线一个不动**。
- 菜单归属用 **fiber 身份**判定：从被右键的行向上找到带 `menu` 数组的那个
  dropdown fiber，再要求弹层的 fiber 链**能走回同一个 fiber**。
  只看 class 是不够的——`mavis-sidebar-session-menu` 也被侧边栏筛选菜单用着；
  复制子菜单（`mavis-sidebar-copy-popup`）也必须排除。
- **只往用户看得见的弹层里注入**。`rc-trigger` 关闭时会先把浮层留在 DOM 上跑完
  关闭动画，之后 antd 还可能把它缓存住：节点、条目、fiber 全都还在，
  `getClientRects()` 却已经是空的。往那儿注入 = 造一个用户永远看不到的菜单项，
  而 `injected` 还报 1。看不见就跳过并**继续往后找**同 owner 的可见弹层。
  `reapTopmost()` 同理：item 还 connected 但所在浮层已不可见时，计数归零，
  **不把隐藏项冒称成用户能看见的东西**。
- **一次右键一条链，两道独立的闸门**。捕获阶段必然早于宿主打开浮层，
  所以菜单是随后才出现的，只能靠有界重试去找它。链会跑飞的情形有两种，
  应对它们的顺序也是确定的——**先取消，后代次**：
  - 一次新的右键顶替了旧链。
    - **第一道：取消仍在队列里的定时器。** 已入队但尚未执行的 timer
      **是可以**被 `clearTimeout` 取消的，所以这一道正常生效时通常就够了。
      （**不**要把它说成"取消不掉"。）
    - **第二道：`topmostGeneration` 纵深防御。** 每次开新链 +1，
      每个 attempt **第一件事**就是比对本链代次与当前代次，对不上立刻返回。
      它**不依赖**取消是否登记、id 是否还在 `topmostTimers` 里、
      以及取消是否赶在回调执行前生效——所以第一道出 bug 时它还站着。
      `dispose()` 同样让代次失效。
  - 宿主把**同一个 DOM 节点**换成了别的会话。链在开链时**快照**当时的
    `data-session-id`，attempt 每次复核；对不上报 `row-retargeted`。
    只查 `isConnected` 是不够的——侧边栏不会因为换会话就卸载那个节点。
- 点击时**重新解析**能力（重渲染后闭包里的数组是旧的），并复查：
  菜单项还在不在、行还在不在、行的 `data-session-id` 是不是当初那个、
  有没有别的调用在飞。**行已卸载就不许去置顶接管它位置的那个会话。**
- 全局 busy：宿主是从它闭包里的数组出发做乐观更新的，两次并发调用会让第二次
  用第一次的旧快照落库。
- 宿主回调**自己 catch、自己回滚、自己弹 toast**。它返回的 Promise 兑现
  **不等于成功**，所以本项目**不额外宣告成功、不额外弹提示**。

#### 键盘：**Tab 可达，方向键不参与**（已知限制，不要写成"完整支持键盘导航"）

| 键 | 行为 | 说明 |
|---|---|---|
| `Tab` | **可达** | 项带 `tabindex="0"`；弹层是开着的真实 DOM，Tab 能落到它上面 |
| `Enter` | 激活 | Enter 没有默认行为，**不**调 `preventDefault` |
| `Space` / `Spacebar` | 激活，**并调 `preventDefault()`** | 空格在聚焦元素上的默认行为是滚动最近的可滚动祖先——侧边栏列表正好就是。**不挡，侧边栏会跟着滚** |
| `Escape` | **完全不碰** | 关菜单是宿主 rc-menu 的事 |
| `ArrowUp` / `ArrowDown` | **不参与宿主的菜单漫游** | 见下 |

> ⚠️ **方向键是已知限制，不是"已支持"**。宿主 rc-menu 用**漫游 tabindex**
> 加自己的键盘处理，驱动的是**它自己渲染的**那些项；追加进去的 `li` 不在
> 那份名单里，所以 `ArrowDown` 会**跨过**「到最顶」。
> 也就是说：**键盘可用（按一次 Tab 能到），但不与宿主其余项等效。**
> 要自己接管方向键就得**全局拦截键盘事件**，那比"多按一次 Tab"坏得多，
> 所以**不做**。任何文档或汇报都**不得**把这一项表述为
> "菜单项完整支持键盘导航"或"方向键与原生一致"。

监听器只有**一个**，挂在这个 `li` 上，**没有**任何全局键盘拦截，也**不**
`stopPropagation`；合成派发的按键（`isTrusted === false`）什么都触发不了，
连计数都不加。

> ⚠️ **重试窗口本轮有意不动**：仍是 `0ms / 8ms / 16ms` 共 3 次尝试。
> 要不要放宽由**主对话真机 20 次右键的命中率**决定，不由这里的推断决定。

#### 运维可观测（纯只读）

```js
window.__mmxStatus.topmost()          // 不用点任何东西
// { available, reason, id, source, alreadyTop, orderLength, orderFirst,
//   injected, busy, clicks, calls, noops, blocked, lastReason, lastSessionId }
```

`reason` 取值：`ok` / `already-top` / `no-handle-pin-session` /
`ambiguous-handle-pin-session` / `readonly-session` / `cloud-not-provable` /
`source-not-local:<src>` / `no-session-row`。
这个纯读结果随每轮 `refresh()` 一起回给 daemon，进 `tick N:` 日志行——
**运维不用点菜单就能判断"是没实现"还是"实现了但宿主不暴露"**。

#### 附带修掉的三个置顶区生命周期缺陷

| 缺陷 | 原因 | 现在 |
|---|---|---|
| 汇总条被永久留在置顶区末尾 | `ensureSummary` 只校验"父节点是 section"，header 单独重挂的帧会把追加过的节点留在末尾，而父节点判据依然成立 | 位置也是正确性的一部分：必须是 `section.children[1]`，每轮复核 |
| 标题叫「更多」的置顶会话被误点 | `pinnedTruncButton` 只按 `textContent` 全等匹配 | 结构 + 文案双判据：排除任何 `[data-session-id]` 子树内的按钮、要求父容器确实持有行、文案只认 asar 里那几种（含 `展开其余 N 项`） |
| 展开记忆变成单向棘轮 | 宿主展开后**不渲染任何收起控件**（按钮只在 `ec && !eo` 时存在，且容器里只有 `el(!0)` 这一个 setter 调用点），用户回不去 | 在置顶区注入一个可见的「收起置顶」控件：只清**本工具**那一个 localStorage 键，并**明说**当前已展开的列表要等宿主重挂才收起。**不隐藏任何真实会话行** |

#### 回归与变异证明

| 文件 | 断言数 | 覆盖 |
|---|---|---|
| `src/test-reorder-pinned.mjs` | 50 | 置顶区排除（含 15 层深的真置顶区）、变更检测、嵌套根多轮收敛、预算原子性（切片出厂代码 + 假 DOM） |
| `src/test-topmost-menu.mjs` | 603 | 能力解析、真实行内 Dropdown 拓扑、当前半边 fiber、菜单归属、键盘（Space preventDefault / Enter 不挡 / 方向键不接管）、关菜单、可见浮层、代次失效、session 快照复核、显式三参、竞态与 fail closed；13-21 节为弹层实录：四道门各自只在真实出口记、owner 四态与 39/40 真边界、严格双向 alternate 配对不参与放行、截断只截诊断、递归严格形状（键/类型/无别名）+ 十个反例、按序位在助手自己的 try 内真注入（8 场景 × 7 注入点，产品返回值/理由序列/逐元素求值序列全部不变）、跨候选污染不可见、读数边界（切片出厂代码 + 假 fiber 树） |
| `src/test-pinned-lifecycle.mjs` | 73 | 汇总条位置、截断按钮作用域、展开记忆与 restore 共用一个分类器、展开逃生、展开守卫、dispose（含代次失效与诊断拆除）、debounce |
| `src/test-topmost-diag.mjs` | 144 | 最小主证探针：nomenu / nopopup 记在工厂自己的 return 点、connected / retarget / append、三次上限与 0/8/16 窗口、earlyStop 链级记录、快照行断开即清（不被 reap 早退挡住）、dispose 清理、selection 置顶优先、expando 计数与 anchor 形状、root 出厂 40 与 extended 256 分开、出厂契约未被动；W11b 改成逐层**精确键**白名单、W14 改成对弹层侧信道的实话断言；W16 接线（信封/槽/stage 归属/三戳校验/预算/Start-Reap-Dispose）、W17 拷贝白名单与十五个反例、W18 collector 逐层新建不回流（切片出厂代码 + 假 fiber，见 15.9） |

**43 个变异全部被证伪**（`node .\src\run-mutations.mjs` 一次跑完并打印矩阵；
每个都让对应断言变红）：

| 组 | 变异 | 重新引入的缺陷 |
|---|---|---|
| 排序 | `d1` | 不再排除置顶区 |
| | `d2` | 变更检测回退到"下标派生"的缓存键 |
| | `d3` | 预算检查挪回搬移循环内（中途放弃 → 乱序） |
| | `d4` | `pinnedZoneOf` 回到定深 12 层循环（15 层之上的真置顶区被搬） |
| 菜单 | `m1` | 调用少传第三参（下标变 `undefined` → 追加到末尾） |
| | `m2` | 不校验菜单归属这一行的 portal |
| | `m3` | `clearTopmostItems()` 不做事（旧项泄漏） |
| | `m4` | 点击时不复查行身份（卸载后误钉别的会话） |
| | `m5` | 放松钩子选择器（6 参诱饵被误认） |
| | `m6` | 去掉 `isTrusted` 守卫 |
| | `m7` | `rowMenuFiber` 回到只走上溯（真实拓扑下**根本找不到菜单**） |
| | `m8` | 不再证明当前挂载的是哪一半 fiber（陈旧半边） |
| | `m9` | 菜单项失去 `tabindex` 与 keydown（键盘不可达） |
| | `m10` | 点击后不调用宿主的关菜单回调 |
| | `m11` | 菜单里显示内部错误码而不是中文 |
| | `m12` | 归属判定从"最近菜单拥有者"弱化为"在该 Dropdown 之下"（命中 hover 菜单） |
| | `m13` | 空格键不再 `preventDefault`（侧边栏跟着滚） |
| | `m14` | 去掉重试里的**代次比对**（`clearTimeout` 故意保留） |
| | `m15` | 去掉弹层可见性闸门（注入到正在关闭/已缓存的浮层） |
| | `m16` | `dispose` 不再让代次失效（`clearTimeout` 保留） |
| | `m17` | 弹层实录退回**每次调用共用一个 record**（候选之间互相覆写） |
| | `m18` | 截断上限从 4 变成 64（诊断不再有界） |
| | `m19` | 上溯走到 null 也报 `budget`（两种"停"分不开） |
| | `m20` | alternate 配对从严格双向 AND 变成单向 OR |
| | `m21` | 命中出口去掉 `ulExpando` 入口守卫（入口没记上仍伪造出口状态） |
| | `m22` | hidden 出口把 `visible` 报成 `null`（"跑过"与"没跑到"混为一谈） |
| 生命周期 | `s1` | 汇总条只校验父节点、不校验位置 |
| | `s2` | 去掉"不在会话行内"的守卫 |
| | `s3` | 去掉"父节点持有行"的守卫 |
| | `s4` | 折叠态也出现「收起置顶」 |
| | `s5` | 展开守卫的高度阈值变成 0 |
| | `s6` | dispose 不摘 contextmenu 监听 |
| | `s7` | 点击记忆回退成裸文本比较（与 restore 的分类器不一致） |
| 诊断 | `g1` | `nomenu` 不记（真实卡点丢失，探针只能靠猜） |
| | `g2` | `nopopup` 不记（分不出"没菜单"与"没弹层"） |
| | `g3` | 快照清理挪到 `reapTopmost` 的 early return 之后（reap 早退时快照永远挂着） |
| | `g4` | `earlyStop` 不记（链被掐断的事实丢失） |
| | `g5` | 去掉 stage 归属门（`nomenu` 之类也能挂上残留信封） |
| | `g6` | `Take` 取走信封却不清槽（残留跨到下一次 attempt） |
| | `g7` | 白名单拷贝退化成 `Object.assign`（未知键 / DOM / 输入别名一起进 payload） |
| | `g8` | 不校验不可空计数（缺失或非有限值被当成量出来的数） |
| | `g9` | 不校验 chain 戳（被接管那条链的 trace 被当成本次的） |
| | `g10` | collector 不再逐层重建（payload 与诊断内部别名，改输出会回流） |

断言的是**出厂代码跑出来的行为**，不是源码里的字符串。
> 跑红的判据是**断言失败**。一个变异如果让套件**崩溃**而不是失败，
> `run-mutations.mjs` 会把它算成问题（`CRASH`），因为崩溃说明后面的行为
> 根本没被执行到。

#### 未测（明确登记）

- **完整应用重启后的持久性未测**：本轮不重启宿主（会打断用户活任务）。
  改用「只读导出 `pinned-items-order` → 重新注入 → 视图重挂 → 再导出比对」证明，
  **不得**用这个结果代替重启验证。
- **云端会话置顶到顶未交付**：`cloud-not-provable`，按 fail closed 处理。
- **「沉底」的用户报告路径未复现**：见 15.5 末尾的归因纪律。

---

### 15.9 `topmostDiag` 最小主证探针（2026-10-03，**不是修复**）

> **这一节不修任何东西。** 真机上的症状（右键菜单里没有「到最顶」，
> `api.topmost().reason` 报 `no-fiber-root`）到本节为止**仍未定位、未修复、
> 未在真机验证**。这一节只把"到底卡在哪一步"变成可读的事实。

#### 为什么需要它

现场只有一句 `no-fiber-root`，它同时对应至少两种完全不同的成因，
所以**不能**拿它当结论用。这个探针的唯一任务是回答一个问题：

> 右键之后，工厂代码**自己**走到了哪一步、在哪一步返回了 `false`？

#### 它怎么做到不撒谎

关键在于**不在诊断里复刻工厂逻辑**。上一版探针（已冻结废弃）复刻了一份
`rowMenuFiber` 的子树 DFS，结果那份复刻比工厂**更宽松**：工厂的兄弟链
只能从 `fb.child` 起走，复刻版却独立走 `it.f.sibling`，于是工厂返回 `null`
的地方复刻版报 `found`——把真正的 `nomenu` 读成"菜单找到了"。

所以本探针**不做**这些事（`test-topmost-diag.mjs` W14 逐项断言它们连编译
都没进探针；查之前先剥注释，否则那段解释用的注释本身会被当成罪证）：

- 不镜像 `rowMenuFiber` 的 DFS
- 不做 `currentFiberOf` / `currentHostRoot` / `chainTop` 的半边证明
- 不输出 dfs / raw-vs-current 任何一个字段

**关于"弹层"这一条，2026-10-03 有一处必须改口的更正。** 本节早先写的是
"不扫弹层、不输出 popup"。现在 `nopopup` / `append` 这两条 attempt 上**确实**
带一个 `popup` 字段，所以那句话已经不准了。改口后的准确说法是：

- 探针**不扫弹层**。它自己不调用 `querySelectorAll('.ant-dropdown-menu')`、
  不调用 `fiberOf`、不读 `memoizedProps`、不求值可见性、不做任何 `.return`
  上溯（`test-topmost-diag.mjs` W14e 对弹层实录那一整段源码逐个禁掉这些名字）。
- `popup` 里装的是**出厂 `popupForMenu` 那一次循环自己的实录**，不是诊断重新
  算一遍的结果。它挂在四个真实出口与 `nearestMenuOwner` 的两个真实出口上，
  一个新循环、一次新 DOM 求值、一次新 owner walk 都没有加。
- 所以它能回答"这一次停在了哪道门"，**不能**回答"为什么停"，也**不能**回答
  "产品返回了什么"（见下面「读数边界」）。


它只在**工厂自己的 return 点**上记一行字：

| stage | 记在工厂的哪一行 | 出厂 `lastReason` 同时是 |
|---|---|---|
| `nomenu` | `tryInjectTopmost` 的 `!menuFiber` | `no-menu-fiber` |
| `nopopup` | `tryInjectTopmost` 的 `!ul` | （无，这行本就不写 reason） |
| `append` | 注入成功 / 认领已有项 | `ok` 或 `already-top` |
| `connected` | `attempt` 的 `!row.isConnected` | `row-gone` |
| `retarget` | `attempt` 的 sessionId 变了 | `row-retargeted` |

一次右击最多 3 条 `attempts`（与工厂的 `tries` 上限一致），另有：

- `capped`：`tries >= 3` 的布尔。**它不覆盖最后一次的真实 stage**——
  把最后一次写成 `'cap'` 恰好会毁掉 `nomenu` / `nopopup` 的区分，那是这个
  探针存在的理由。
- `earlyStop`：`{chain, reason}`，记在**链**上而不是伪造一个 try。
  `superseded` = 上一次右击还有排队 timer 就被接管；`disposed` = 被拆。
- `root.failureKind`：`ok` / `no-expando` / `no-fiber` / `over-shipped-cap` /
  `root-budget-ended` / `root-not-found` / `threw`。出厂看的是 depth 0..39，
  所以 root 落在 **depth ≥ 40** 时出厂解析不出来——这条和"root 根本不存在"
  是两回事，必须分开读。
- `selection`：`pinned-first` / `document-first` / `none`，与 `api.topmost()`
  的默认取行顺序一致，**只出枚举，不出 id**。
- `phase`：恒为 `unknown`。这个探针**不观察弹层树的当前状态**，所以它没有
  资格声称自己与某一次 attempt 同时态；晚到的 DOM 状态不得被读回当成那次
  失败的原因。它带的 `popup` 不违反这一点：那是那一次 attempt **当时跑过**的
  循环，而不是采集时刻的 DOM。
- `durationMs`：开销是**量出来的**，不是声称"可忽略"。

#### `attempt.popup`：那一次 `popupForMenu` 循环的实录

只有 `nopopup` 与 `append` 这两个 stage 会带它——因为只有这两个 stage 是
`popupForMenu` 之后才记的。`nomenu` / `connected` / `retarget` 一律是 `null`，
并且**顺带把槽里任何残留信封清掉**。

```
attempt.popup = {
  identityOnly:true, loopTotal, scanned, returned,
  forkCopy, forkNoItems, forkOwner, forkHidden,
  accepted, dropped, noRecord, candidates[ <=4 ]
}
candidate = {
  i, outcome, copy, hasItems, visible,
  ulExpando, ownerFound, ownerEnd, hops, ownerCap,
  ownerIsAlternateOfMenuFiber
}
```

`outcome ∈ copy | no-items | owner-mismatch | hidden | accepted`，
`ownerEnd ∈ found | budget | chain-ended | no-fiber`。

| 字段 | 只能证明这一件事 |
|---|---|
| `loopTotal` / `scanned` | `querySelectorAll` 找到了几个候选、循环开出了几条记录。**不等**：故障时可以少记（见「读数边界」）。 |
| `forkCopy/NoItems/Owner/Hidden`、`accepted` | 四个真实出口各自被走到几次。**不受"只留 4 条"限制**——第 5 个候选照常参与出厂判定，只是不入表，`dropped` 记 1。 |
| `returned` | 被接受那条候选的**下标**；没有任何一次 accepted 时是 `null`。 |
| `candidates` | 前 4 个候选的明细，按扫描顺序。**第 5 个及以后的明细没有**（只留计数）。 |
| `candidate.i` / `outcome` | 不可空，非法就**整份拒成 null**（宁可没有读数，也不要拿 0 / unknown 冒充一次真实分叉）。 |
| `copy` / `hasItems` / `visible` | `null` = **这道门还没跑到**，不是"跑出来是空"。`owner-mismatch` 的候选 `visible` 必然是 `null`：它在 owner 门就 `continue` 了，可见性门从未对它求值。 |
| `ulExpando` | `null` = 门没跑到；`false` = 入口就没有 fiber；`true` = 有。**只在入口写一次**。 |
| `ownerEnd` | 四态互斥。`found` = 走到了 menu fiber；`budget` = `i` 撞到 40 且 fiber 仍非空；`chain-ended` = fiber 先变 null；`no-fiber` = 入口就没 fiber。**走到 null 一律 chain-ended，绝不写 budget。** |
| `hops` / `ownerCap` | 上溯实际走了几步 / 出厂那个 40。44 跳的链也只会记 40——上溯没有为诊断多走一步。 |
| `ownerIsAlternateOfMenuFiber` | 严格**双向** AND 的身份旁证：单向成立是 `false`，同一对象是 `false`。**它不参与任何放行**（配对为真照样 `owner-mismatch`，配对为假照样 accept），也**不据此声称哪一半是当前树**。 |

#### 读数边界（这几条比字段表更重要）

- **`accepted=0` / `returned=null` 不证明产品返回了 `null`。** 出厂可能返回了
  某个 `ul` 而诊断没记上：比如构造候选 record 的助手在第一句就抛了，`fork`
  照常计数、`returned` 留 `null`，而产品把项注入得干干净净
  （`test-topmost-menu.mjs` 20.1-20.2 就是这个场景）。
- **反过来，诊断助手首句抛错也不改产品行为**：它全在助手自己的 `try` 里。
- **计数只是"已记的读数"**：故障可以少记、可以缺失，但**不会造出结果**。
- **不要用 `总分叉 == scanned + kept` 之类的合计式在任意故障情形下推产品成败**，
  只在无故障的正常路径上成立。
- **产品主证仍然是 stage**：一条 `nopopup` / `append` 才是"出厂自己走到了哪里"。

#### 传输契约（为什么它不会被算到别的 attempt 头上）

`popup` 走一个模块内槽 `topmostDiag.popup`，不走返回值也不走参数：

1. `Open` 先**无条件自 guard 清旧槽**，再造一份新 trace，并发布
   `{chain, gen, attempt, trace}` 信封。三个归属戳**只活在信封里**，不进
   trace、不进 payload。成功时信封里的 trace 就是调用点拿到的那一份。
2. `Take` 先把信封抓在手里，**立刻清槽**，然后在 `try` 内读三个戳与 trace。
3. `Copy` 逐字段白名单重建（**没有** `Object.assign`、没有展开、没有 JSON 克隆），
   每个候选都新建，所以输出里没有别名，也不会泄漏输入对象或它的 getter。
4. 三个戳里任何一个对不上当前链 / 代次 / 该是第几次 attempt，**整份拒成 null**。
5. `Record` 的取数与记账是两个独立的 `try`：取数炸了 `popup` 降成 `null`，
   而这一条 attempt **仍然照记**——出厂的 stage 是主证，不能被诊断自己的故障吃掉。
6. 开新链（`Start`）、快照行真实断开（`Reap` 的断开分支）、`Dispose` 都清槽。
7. collector 每次 `collect()` 都**逐层重建** attempt / popup / candidate，
   **不读那个槽、不额外扫一次**（改输出不会回流到诊断内部）。

归属戳存在的理由很具体：一条迟到的 trace 被算到另一次 attempt 头上，
比没有这条 trace 更糟——它看起来像个测量结果。

#### 没有动的东西（`test-topmost-diag.mjs` W15 逐项锁死）

`TOPMOST_MAX_ANCESTORS = 40`、重试窗口 `0 / 8 / 16`、`topmostReason` 的写点
多重集（14 处，逐字比对）、所有 `return` / 条件 / 原有函数的调用次数。
弹层实录**没有**新增任何循环、任何 DOM 求值、任何 owner walk、任何可见性
求值：`popupForMenu` 里的 `querySelectorAll` 仍然只有一次，每个候选到达哪道
门就只被问一次（`test-topmost-menu.mjs` 18.* 用逐元素调用序列对照未注入参照）。
`nearestMenuOwner` 的循环头与 `fiber = fiber.return` 的出现次数一字未改。

`record` 全程包在 `try/catch` 里，抛错也不会影响工厂行为；collector 自己也有
`try/catch`，并且在 refresh 表达式里单独包了一层——它抛错只降级成
`{available:false,error:'collector-threw'}`，不会带走 `stats` 或 `topmost`。
`schema` 仍是 `topmost-diag/1`，`refresh` 的出厂顺序（先 `apply()` 再
`enforceNoAutoExpand()`）与 dispose 的监听摘除顺序未动。

#### 怎么读

正常 refresh 的返回里多了一个字段，和 `topmost` 平级：

```
topmostDiag: { available, schema:'topmost-diag/1', phase:'unknown',
               chain, gen, capped, attempts:[…], earlyStop:[…],
               row:{present,connected}, selection, expando, anchor,
               root:{shipped,extended,failureKind}, durationMs }

attempt:  { try, stage, chain, gen, popup }
// popup 只在 nopopup / append 上是对象，其余 stage 是 null；形状见上节。
```

> 下面是**每个字段自身能证明的那件事**，不是成因结论。

1. `attempts` 出现 `nomenu` ⇒ **那一次 attempt** 在 `!menuFiber` 就返回了，
   与弹层无关。这**不等于**周期读到的 `lastReason` 仍是 `no-menu-fiber`：
   后续 attempt 会把它改写成 `menu-not-found`，所以 `lastReason` 只能在
   单次 attempt 内用来验证同源，不能跨 attempt 读。
2. 出现 `nopopup` ⇒ **那一次**菜单 fiber 找到了、弹层没拿到。这与 `nomenu`
   方向相反：`nopopup` 已经证明菜单 fiber 是找到了的。
3. `capped` 只说明 3 次 attempt 用完了，本身不携带原因。只有当三条 attempt
   的 stage **都是 `nomenu`** 时才可以说"这三次工厂始终没找到菜单 fiber"；
   出现 `nopopup` 就必须改写成"菜单 fiber 找到了，弹层没拿到"。
4. `failureKind === 'over-shipped-cap'` ⇒ **在被观察的那一行上**，按出厂 40
   步没命中 root、按 256 步命中了。它不说明当次 `nomenu`／菜单项缺失就是它
   造成的，**也不构成"把 40 改大就能修"的依据**。
5. `failureKind === 'no-expando'` ⇒ **在被观察的那一行上**没有 react expando。
   `rowMenuFiber` 的 anchor 分支是先取 `[data-shortcut-session-target]` 再从
   anchor 的 fiber 上溯，**不经过行元素自己的 expando**，所以这一条推不出
   "工厂怎么走都到不了菜单"。
6. `row` / `anchor` / `root` 是**采集时刻**对快照行的观察，`attempts` 是
   **链上真实发生过**的记录；`phase` 恒为 `unknown`，两者没有已证明的时序
   关系，不要用采集时刻的 `root` 去反推某次 attempt 的失败原因。
7. 拿到真机读数**之前**，不对成因下任何结论，也不改工厂逻辑。
8. `attempt.popup` **只说明那一次循环停在哪道门**，不说明为什么停。特别地：
   `forkOwner` 大不等于"归属判断错了"，`forkNoItems` 大也不等于"宿主没渲染
   项"——它们只说明候选停在了那道门**之前**。哪一道是缺项成因，要靠真机读数
   加宿主侧事实判断，本节不主张。

#### 未测（明确登记）

- **整个探针（含弹层实录）未在真机跑过。** 本轮不部署、不重启宿主，因此
  **没有一条真机读数**。上面的 schema 是设计，不是观测。
- **真机症状未定位、未修复。** 拿到第一条真机 `attempts` 之前，
  不许对成因下任何结论，也不许改工厂逻辑。
- 探针每轮 refresh 多跑两次 `querySelectorAll` 和两条 `.return` 上溯；
  `durationMs` 是为此加的观测点，**实际开销未在真机测过**。
- **弹层实录的真机开销未测。** 它不加新的 DOM 求值与新的上溯（这一点有
  逐元素调用序列对照），但多出来的是**每候选两次字段写**与**每出口一次
  计数**；这部分在真机上的耗时没有量过，而 `durationMs` 只覆盖 collector，
  不覆盖 attempt 当时那一段。
- **真机上的 `ownerEnd` 分布未知。** 桌面侧边栏的容器 fiber 深度、
  `p.menu` 出现的位置、弹层 fiber 的挂载点都没在真机上量过，所以 39/40
  这条边界在真机上究竟落在哪一侧，**本节没有任何数据支持**。
- **`alternate` 配对在真机上的取值未知。** 假 fiber 上它可以取到 `true`，
  真机上是否会出现严格双向配对**未观测**。它本来就不参与任何放行，所以即使
  恒为 `false` 也不改变产品行为。

### 15.10 红色悬停锁顶：单会话持续锁顶（2026-10-03，**离线实现，未部署**）

#### 结论先写清楚

这一节记录的是**一次离线实现及其证据**，不是一次交付，更不是一次真机验收。

| 项 | 状态 |
|---|---|
| 代码落盘 | ✅ `src/lib/page-script.mjs` |
| 离线行为套件 | ✅ `src/test-top-lock.mjs`，234 断言 / 0 FAIL |
| 变异证明 | ✅ 16 条变异全部正常红、0 崩溃（并入 `run-mutations.mjs`，旧 43 条原样保留） |
| **受控部署** | ❌ **未做**。daemon 是静态 import，重启 daemon 才能加载，而这仍是用户独有批准项 |
| **真机悬停 / 点击** | ❌ **未做**。官方 Computer Use 的公开方法**不提供 hover**，主会话至今没有真正悬停过任何一行 |
| 冷启动持久性、应用重启后的表现 | ❌ **未测** |
| `pinned-items-order` 基线 29 vs 27 的裁决 | ❌ **仍阻塞**（见 §14.23，本节不碰它） |

#### 它做什么

- 侧栏每一行多一颗**红按钮**，点一次把这个会话顶到置顶区最顶，并且**持续保持**在最顶：
  别人用原生 `pin` / `unpin` / 拖拽把它挪下去，后台会把它顶回来。
- **同时只有一个锁**。点别行的红按钮 = 直接替换；再点当前那颗 = 解除。
- 解除**只清本地意图**，不 unpin、不恢复旧位置——宿主原来的顺序原样保留。

#### 三条必须分开的真相

代码里这三样东西在命名、注释、断言上都是分开的，任何一处都不允许合并：

1. **锁意图** —— `localStorage['mmxStatusTopLockV1']`，内容**只有** `{version, source, id}`。
   没有排序表，没有标题，没有正文。
2. **宿主位置** —— 唯一真相是宿主自己那份 pinned order，**DOM 从来不是证据**。
3. **Promise resolve** —— 只表示"宿主处理完了"，**绝不表示它成功了**。
   确认只认**调用之后重新解析出来的新鲜 order**。

#### 授权与 fail closed

- 写宿主仍然只有唯一那一个三参回调 `handlePinSession(id, true, 0)`（§4.1 T1）。
  没有 props 路径、没有 `togglePin`、没有备用接口，**绝不 `insertBefore` 宿主置顶 DOM**。
- **先存意图，存成功才允许调用宿主**；存储失败时**一次宿主写都不发生**，且原因对用户可见。
- 云端 / 只读 / 无 fiber / 回调不唯一 → 显式禁用并给出中文原因。
- 能力不足时**没有第二句台词**：不存在"降级可用"，不存在呈现层假置顶（T2）。

#### 容器适配：只认已核的形状，认不出就不挂

2026-10-03 从 `app.asar` 精确核实（关键坐标见 `page-script.mjs` 里的注释块）：

| render site | 支持？ | 依据 |
|---|---|---|
| **3 · tf normal** | ✅ | 唯一带 `data-shortcut-session-target` 的行；悬停条 `absolute right-1 top-1/2 -translate-y-1/2 z-[1]` |
| **5 · i$ pinned** | ✅ | 真正两个原生按钮（`unpin` + `B.L` 包的 `more`）；无 anchor，标题按自身 class 形状认 |
| **6 · iK recent** | ✅ | 同上，`pin/unpin` + `more`；悬停条**定宽** `w-[60px]` |
| 1 · project | ❌ | 另一套行壳 + 独立列表，**本项目显式不支持改造它** |
| 2/4 · rename | ❌ | 行内是 input，没有悬停条 |
| archived（只有 `more`） | ❌ | `actions` 里只有一个原生按钮，按按钮数判据拒绝 |

**硬规则：`strip`、`mount 容器`、`标题` 三者都必须唯一命中**，命中 0 个或多于 1 个一律不挂按钮
（`api.topLock().anchorRefused` 会计数，所以"按钮没出现"永远能被解释）。
上一轮"条命中之后还能顺着 `continue` 退到更宽松的形状"是个真 bug，已修——
它会让 archived 的 iK 行先被按钮数挡下、再被不检查按钮数的 i$ 行认领。

#### 第三颗按钮的右边距：自有 scoped CSS，不改宿主 class

追加一颗 30px 按钮会超出宿主给标题预留的空间。做法是**只读**宿主标题 class 里的
`mr-2` / `mr-8` / `mr-10` / `mr-[60px]` 与 `group-hover:` / `group-focus-within:` 变体，
把"原值 + 我们这一颗的宽度"写成**我们自己的一条规则**，挂在**我们自己的 marker 属性**上：

- 标题：`[data-mmx-toplock-reserve]{margin-right: 38px}` + hover/focus-within 变体；
- 定宽条（site 6）：`[data-mmx-toplock-strip]{width: 90px}`。

宿主的 class 与 inline style **一个字都没动**，`app.asar` 没动，`dispose()` 会把 marker、
按钮与样式节点全部摘掉。这是自有展示层调整，**不是排序**，因此不落在 T2 里。

#### 键盘与无障碍

- 原生 `<button type="button">`，**只挂一个 `click` 监听**，不挂 `keydown`。
  Enter / Space 的激活完全交给原生按钮，因此不存在"键处理 + click 处理"双触发的问题，
  也不会拦截宿主的按键。**注意**：本项目没有在 Electron 里实测过键序，
  这里断言的是"我们自己没有第二条入口"，不是"浏览器一定按某顺序派发"。
- **不使用原生 `disabled`**：原生 disabled 的按钮不能被聚焦，一旦能力中途失效，
  当前锁的解除入口会连 Tab 都到不了。禁用态用 `aria-disabled="true"` + 视觉 + 业务拒绝。
- **可见标签恒定**（`锁顶到最顶`），pressed 态一律交给 `aria-pressed`。
  按 W3C ARIA APG 的 toggle button 语义，`aria-pressed` 成立的前提就是标签两种状态下读起来一样；
  状态说明（再点解除 / 阻塞原因 / 暂停原因）放在 `title` 与 `aria-label` 上。
- 全程不调用 `focus()`，重挂原节点不会抢走宿主的焦点。

#### 后台维持：串行、有界、预算耗尽即显式暂停

- 挂在**已有的** `apply()` 上：**不新增任何 observer / interval / rAF**。
- 每一次真正写宿主都从 `TOPLOCK_MAX_MAINT = 3` 的预算里扣一次；扣光就
  `phase=paused / reason=budget-exhausted`，在真人重新点一次之前**不再自动写**。
  没有预算就意味着与外部反复对拉可以无限进行，那正是 toast 风暴的成因。
- 宿主返回后另有 `TOPLOCK_CONFIRM_TRIES = 2` 趟**只读**确认窗口（React 重渲染不是同步的）。
  窗口用完仍拿不到证据 = 回滚 / 静默拒绝 → **永久停用自动重试**。
- 忙时其它锁意图可以安全更新（那只是一次本地写），但**绝不并发写宿主**；
  在途调用的回执属于旧代次，不会改变新意图的状态。

#### 目标消失：可证明才清锁

| 观察到 | 处置 |
|---|---|
| 目标行不在 DOM，且拿不到任何可信 order | `paused: view-unstable`，**保留**意图 |
| 拿到的可信 order 是**空的** | `paused: order-missing-id`，**保留**意图 |
| 拿到可信 / 本地 / **非空** order，里面确实没有目标 | `cleared-gone`，**清锁**，且不 repin、不复活会话 |
| order 非空、目标在里面但不在首位 | 有界维持（有预算） |

**绝不用"连续两趟都没看见"来推断删除**——那是猜，不是证据。

#### 与「到最顶」的关系

两者共用**同一个跨入口 inflight 闸**（`hostGate`）。锁存在时，「到最顶」对**其它行**禁用并中文提示先解除；
红按钮仍然可以替换目标。宿主自己的 pin / unpin / 拖拽 / 菜单一条都没被拦截。

#### 只读诊断

`api.topLock()` 返回意图、相位、原因、**宿主确认的当前位置**与一批计数器。
它**不含** fiber、DOM、函数、会话标题或正文；唯一暴露的 id 就是这个功能被允许记住的那一个。

#### 未测与已知边界

- ❌ 真实 GUI 悬停、点击、视觉核对 —— **全部未做**。官方 SDK 无 hover，这是硬阻塞，不是疏漏。
- ❌ 受控加载最终版（需重启 daemon，用户独有批准项）。
- ❌ 应用重启后的持久性、冷启动路径。
- ⚠️ `cleared-gone` 的"可信非空 order"判据来自**两个宿主事实**（渲染出的行 + 宿主自己的 order），
  但"加载中途那一瞬的 order 也可能非空"这个残余窗口**没有被观测**，按 fail-safe 方向处理。
- ⚠️ 云端视图、项目分组子列表、搜索过滤下的行为**未实现也未宣称**；本项目不对这些场景假装"永远第一"。
- ❌ 真机开销（本按钮每趟 apply 对每行走一次 Map 查表，能力判定是懒解析 + 30 趟 TTL 缓存，未在真机量过）。


### 15.11 锁顶 r2：两轮 review 的 BLOCK 修正（2026-10-04，**离线，未部署**）

> 本节**只追加，不改写** §15.10。凡是 §15.10 里与本节冲突的段落，以本节为准；
> 冲突点在本节末尾逐条点名，便于对照。

#### 结论先写清楚

| 项 | 状态 |
|---|---|
| 代码落盘 | ✅ `src/lib/page-script.mjs`（r1 `0cf4659…` → r2 `62df497…`） |
| 离线行为套件 | ✅ `src/test-top-lock.mjs`，**293 断言 / 0 FAIL** |
| 变异证明 | ✅ **69/69 全红、0 崩溃**（旧 43 + `t1…t16` + `r1…r10`），并入 `run-mutations.mjs`，旧 43 条原样保留 |
| 全量套件 | ✅ 11 个套件 0 FAIL |
| **离线浏览器夹具** | ✅ 已产出，**未在浏览器里打开过**（见下） |
| **受控部署** | ❌ **未做**。daemon 静态 import，仍需用户独有批准项 |
| **真机悬停 / 点击 / 键盘** | ❌ **未做**。官方 Computer Use 不提供 hover，本会话亦未开浏览器 |

**r1（`0cf4659…`）被两轮独立只读 review 判 BLOCK，本节不复活它。**
r2 是"离线绿"，**不是"通过"**：真实 GUI 验收门从未为这个功能打开过。

#### 两轮 review 到底指出了什么

判据、逐条修正和"怎么把它改回去证明修得真"都在
`_diag-toplock/2026-10-04_0530-r2-offline-toplock/baseline.md` 与
`counterexamples/red-then-green.txt`。摘要：

- **A 红色按钮从来没红过**：图标是文本节点，CSS 里没有能选中它的颜色规则。
  r2 换成出厂一次创建的 SVG，描边=空闲 / 实心=已确认，语义红 token，focus ring，30/32px 带单位。
- **B reserve CSS 无界**：每趟追加一条规则，不同 margin 的两行互相覆盖，量错了元素。
  r2 改成按 (rest, hover, focus, px, alwaysVisible, stripWidth) 生成的有限 key，静息态保留宿主原值，
  行变未知形状时把自己的 marker 摘干净。
- **C 后台拿"缺失"当证据**：目标被宿主 unpin 后下一趟又被顶回去；
  借用 witness 的非空 order 缺目标被当成"已删除"而清锁（视图切换时必现）。
  r2 统一：**任何后台写之前先证明 ref 在可信 order 里；证明不了就暂停、保留意图**。
- **D 用户的退路取决于一个他取消不了的调用**：`isTarget && !hostCallBusy()` 让在途时点当前行
  变成"重新落盘"，toggle 看起来什么都没发生。r2 解除优先于能力、优先于忙，且靠行自身 closest-id 证明。
- **E 闸和预算是每次 bootstrap 一份**：第二次注入能并发写宿主；每次刷新补满 3 次预算。
  r2 闸和运行时搬上 `window`，用不透明 ticket；预算与"不再自动重试"跨注入存活。
- **F 每趟重建图标 / 标签 / 样式表**：r2 只在值真的不同时才写，样式表按 key 缓存。

#### 顺带修掉的"假绿"（不是 review 提的，是重锚变异时发现的）

- **21b 拿同一个节点当两个状态断言**：它先把 `mvs_a` 的按钮当 idle 读，锁完又把 `mvs_a`
  当 locked 读。现改为读两行不同的按钮。
- **21b 的 pending 不是产品不收敛，是 fixture 驱动缺失**：旧写法手调 `api.refresh()`，
  把"点击 → 一次宿主调用 → 宿主换新数组 → 下一趟确认 → 再下一趟上色"压进同一拍。
  现在 `pump()` 只走出厂那条 `MutationObserver(childList) → scheduleApply → rAF → apply`，
  fixture 里没有任何一处直接调 `refresh()`。判据就是它——如果生产真的不收敛，pump 不会让它绿。
  反向也钉死了：25.6b（原地改写同一个数组**不算** commit）、25.6c（先确认后暂停，
  `confirmedAtTop` 必须清），防止"多刷几拍把 pending 洗成 confirmed"。
- **7.x 只 spy 不冒泡**：假 DOM 现在按 `cancelBubble` 断冒泡，7.4–7.7 挂**真的**行/strip/body
  监听器，并带一条对照组证明冒泡本身有效（宿主自己的按钮照常冒泡）。
- **五条变异锚在已经不存在的代码上**（t2/t3/t4/t5/t12），抛 `anchor matched 0 times`，
  被 runner 记成 CRASH 而非红。已重锚。
- **四条变异是绿的**（t12/r4/r7/r9），等于什么都没测。已重定向到活代码，
  r7/r4 另配了真反例（25.6b / 25.6c）。
- **一次产品 bug**：用户点击传的是 `null` 而不是它发出时对着的那份 order，
  于是身份校验对"唯一由用户触发的那条路径"从不生效。已改为传 `cap.order`。
- `check(..., true)` 全部清空；`buttonFor()` 不再用真值 `MISSING_BTN` 冒充"按钮存在"，
  存在性断言改走 `realButtonFor()`。

#### 离线浏览器夹具（`.../browser/`）

    cd _diag-toplock/2026-10-04_0530-r2-offline-toplock/browser
    node serve.mjs          # http://127.0.0.1:8792/ ，自打印 pid，Ctrl-C 停

`page-script.js` 是**由 `src/lib/page-script.mjs` 生成**的出厂 bootstrap，不是抄的；
`fixture.js` 只桩掉四样东西：React fiber、宿主 pin 回调、pinned order、会话清单。
事件派发与 `isTrusted`、焦点与 Tab/Enter/Space、`:hover` / `:focus-within`、
`getComputedStyle`、**真的** MutationObserver / rAF / localStorage / Promise 全部是真的。
服务端在本轮起停过一次并做过 HTTP 冒烟（`/ 200`、`/tw-stub.css 200`、`/fixture.js 200`、
`/page-script.js 200`、`/nope 404`），**但没有在浏览器里打开过**。

#### 本节取代 §15.10 的以下说法

1. §15.10「目标消失：可证明才清锁」表中
   **"拿到可信 / 本地 / 非空 order，里面确实没有目标 → `cleared-gone`，清锁"** —— **已取消**。
   非空 order 缺目标**不是**"宿主加载完了"的证据（加载中途的快照长得一模一样），
   现在与空 order 走同一条路：`paused: order-missing-id`，**保留**意图，既不 repin 也不清锁。
2. §15.10 的 `cleared-gone` 措辞与"可证明才清锁"标题整体作废；
   解除只剩**用户点一次**这一条路。
3. §15.10「后台维持」里"在途时其它锁意图可以安全更新"补一句：
   **解除意图除外**——在途时点当前行是解除，不受闸限制（它不写宿主）。
4. §15.10「键盘与无障碍」中"Enter / Space 的激活完全交给原生按钮"这句**只覆盖设计**，
   离线没有验证：假 DOM 不会把按键合成 click，**真实 Enter/Space 未测**。
5. §15.10 的 `TOPLOCK_CONFIRM_TRIES = 2` 已改为 **12**（review 的迟到 commit 反例）。

#### 未测与已知边界（不要越读）

- ❌ **真实 Enter / Space**。4.x 只断言"我们没挂 keydown、只挂一个 click"，别当成键盘已验。
- ❌ **真实 hover 视觉**（红、focus ring、30/32px、横向排列）。夹具刚产出，**未开浏览器**。
- ❌ **真实 MMX GUI**。未启动、未探测、未重载；部署门仍关。
- ❌ 真实 `setPinnedItemsOrder` 提交语义、真实 fiber 树、真实 hook 闭包、真实会话 id、
  云端 / 只读分支。夹具只是近似，且已如实标注。
- ❌ 应用重启后的持久性、冷启动路径。
- ⚠️ §14.23 的 **DB 基线 29 vs 27 裁决仍阻塞**，本节不碰、不归因、不覆写。
- ⚠️ 三套变异体系（rv13 的 16 / §14.23 的 43 / 本轮的 69）**不可相加、不可互相替代**。

> 本节**不构成**「功能已交付」「已部署」「验收通过」或「问题已解决」。



---

### 15.12 锁顶 r3：**r2 判 NOT PASS**，三 MEDIUM + 一 LOW 修正（2026-10-04，**离线，未部署**）

> 本节**只追加，不改写** §15.10 / §15.11。冲突点在本节末尾逐条点名。
> 证据：`_diag-toplock/r3-2026-10-04_0700-offline-toplock/`。

#### 结论先写清楚

| 项 | 状态 |
|---|---|
| **r2（`62df497…`）判决** | ❌ **NOT PASS**。两份独立只读复审合计 **三 MEDIUM + 一 LOW**，本节全部修掉 |
| 代码落盘 | ✅ `src/lib/page-script.mjs`（r2 `62df497…` → r3 `84ba6be1…`） |
| 离线行为套件 | ✅ `src/test-top-lock.mjs`，**345 断言 / 0 FAIL**（r2 为 293） |
| 变异证明 | ✅ **78/78 全红、0 崩溃**（旧 69 全部保留锚点与测试意图 + 新增 `w1…w9`） |
| 全量套件 | ✅ 11 个套件 0 FAIL |
| 结构门 | ✅ 新增 `src/structural-gates.mjs`（模板 / String.raw / 8 导出 / 三 builder / diff check）全绿 |
| **离线浏览器夹具** | ⏳ r2 v1 / v2 两版都**未在浏览器里打开过**；r3 版另目录另端口单独冻结 |
| **受控部署** | ❌ **未做**。daemon 静态 import，部署门仍关 |
| **真机 / 浏览器** | ❌ **未做**。像素、键盘、点击、收敛一律**未通过未测** |

**r3 仍然是"离线绿"，不是"通过"。** 真实 GUI 验收门从未为这个功能打开过。

#### 三 MEDIUM + 一 LOW，逐条改了什么

**M1（MEDIUM）共享闸在槽不可写时静默放行。** 旧 `hostGateState()` 在 `window[key] = fresh`
抛异常或被 `Object.freeze(window)` 拒绝时，**照样把那个临时对象返回出去**并铸造票，
于是两个注入实例各自以为自己拿到了闸 → 并发写宿主。r3 改为 fail closed：
写完必须 `window[key] === fresh` 回读证明**同一个共享对象**真的进了 window，读回不一致
（或写入抛错）一律返回 `null`；`take` 再验一次 `g.ticket === ticket` 才发票；
`busy` / `release` 在拿不到运行时时不抛错、也不假装可写。**没有拿随机字符串去糊这个洞。**
样式表另立 `__mmxStatusTopLockCssV1` 私有回退，使 fail closed 不会把 CSS 一起带走。

**M2（MEDIUM）后台预算与"不自动重试"在重注入时被偷偷补满。** r2 的 `topLockLoad()`
在 `owner !== id` 时**重新补满 3 次预算**，而 load / 重新注入**不是**用户手势；
单目标运行时还留着一张按 history id 无界增长的 `blocked` 表。r3：

- 运行时改成**单目标有界**：`{ owner, budget, reason }`。"不再自动重试"只属于当前 owner，
  不是一张历史表。
- **只有**"存储写入成功的、可信的、真实用户重新锁顶"才允许重新武装预算；
  load / 重新注入 / 观察确认**一律只认领（adopt），不补满**。
- 存储写失败**不清 blocked、不补预算**（r2 会清）。
- 存下来的意图**不会**被自动清掉。
- 拿不到运行时（槽不可写）时直接 `paused: runtime-unavailable`，不做任何维持。
- 死代码删掉：`topLockDropIntent` 整个函数删除；只读不可达的 `calls` / `ticket` 字段删除；
  公开诊断字段**未动**。

**M3（MEDIUM）无 DOM 判据拿"witness 自己可写"当成"目标可写"。** r2 的见证行用自己的
`view.id` 探可写性，却拿它去给 `intentId` 背书——判的是 A，行的是 B。r3 让见证行
**独立探测目标**：在唯一且当前的 7-deps hook 上用 `deps[0](intentId, source)` 判目标，
`source` 为本地值且 `order` 里含目标；`readOnly === true` / 抛异常 / 无法证明
→ **零宿主写、显式暂停、保留意图**。见证行自己的可写性**不被借用**；
current / unique-hook 要求**未放宽**，也没有发明新的宿主 API。

**L1（LOW）票是 `mmx-toplock-<seq>`，"opaque / unguessable"的说法不成立。** r3 把票换成
**每次调用一个的对象身份**（window 上的共享引用），迟到的回执只释放**自己那一张**；
没有票 = 零宿主写，「到最顶」菜单路径同样。**这是实例之间的身份隔离，不是安全或认证边界**——
同源改写 window 槽在范围内之外，本轮**不设计安全框架**。

#### 顺带修掉的第 4 处产品问题（自查发现，未被要求，**可被否决**）

存储**写**失败后，下一趟 `idle` 会把"没落盘"洗成"成功"（r2 的 `storageWriteFailed`
只在同一趟内有效）。r3 让失败**跨趟保持**，直到某次写入真的成功。
若主会话认为超出本轮范围，可整条回退，回退后 `w9` 变异失去覆盖。

#### 测试有效性：修掉的"假绿"

- **21.4** `buttonFor(...) !== null` 恒真 —— `buttonFor()` 的哨兵 `MISSING_BTN` 就是真值。
  改走 `hasButton()` / `realButtonFor()`，并**全量审计**在场性断言，确认 `MISSING_BTN` 不再能顶包。
- **5.2** 幂等性断言比的是两个**回退对象**，恒等 —— 改为比对真按钮。
- **18.x / 25.5** 原来手写 `api.state` / 运行时预算 / owner 再读回来。r3 全部改成
  **真点击 + 真宿主变更 + 出厂 pump 链**（`MO(childList) → scheduleApply → rAF → apply`），
  fixture 里没有任何一处调 `api.refresh()`。仍然存在的**单元状态输入**已如实命名为单元测试，
  行为连线另有独立小节，不混为一谈。
- **25.7.4** 两条规则的 `||` 应为 `&&`，并分别证明两个 key 都在。
- **`buildBootstrapExpression` 的 import 此前没有任何断言**。新增第 0 节：证明该导出可解析、
  含 `__mmxStatusMain` 与 cfg、**出厂模板正文以且仅以一个 `\n` 开头**，本地切片与它的差别
  **就是那一个换行**——这是**可解释的事实差异，不是字节相同**，本节不这么宣称。
- 删掉"见上一节已断言"这类假注释。

#### 变异与新覆盖

新增 `w1…w9`（9 条，全部红）分别对应：M1 槽不可写 / M1 票身份 / M1 runtime fail-closed /
M2 可信重锁不补预算 / M2 load 补预算 / M2 不自动重试的 owner 归属 / M3 借见证行可写性 /
M3 丢弃目标只读判定 / 存储写失败被洗掉。
**变异 id 特意从 `g` 改成 `w`**，因为 `test-topmost-diag.mjs` 早就占用了 `g1…g10`（菜单诊断），
同名会让复审者对着两份不同的变异。

r3 要求的**行为连线**已被 18.6 / 25.5 覆盖：存储写失败的暂停 → 重新注入**仍暂停且零宿主写** →
真实解除 / 重锁被确认 → 宿主再压下来 → **正好一次**维持。

#### 证据目录

    _diag-toplock/r3-2026-10-04_0700-offline-toplock/
      pre-SHA256.txt / freeze.md
      browser-channel-boundary.md        官方 IAB 超时 + 零到达反证 + r3 读数口径
      v2-readback-corrections.md         v1 事实更正、.w-[32px] 缺口
      v2-selfexcitation-check.mjs / .txt 18 条断言：v2 不会自己激励自己
      suites/all-suites.txt              11 套件完整原始输出
      suites/structural-gates.txt        结构门
      suites/test-top-lock-clean.txt
      mutations/mutation-matrix.txt      78/78
      counterexamples/red-then-green.txt 12 组 red → green 原始输出

#### 本节更正的历史说法

1. §15.11「r2 闸和运行时搬上 `window`，用**不透明 ticket**」—— **"不透明"从来不是安全承诺**，
   旧票是可枚举的 `mmx-toplock-<seq>`。r3 换成对象身份票，注释已改成
   "**实例之间的身份隔离，不是安全或认证边界**"。**历史证据目录不改写。**
2. §15.11 的 `mutations` 记 **69** → r3 为 **78**（+9）。两数**不可相加**。
3. §15.11 的断言数 **293** → r3 为 **345**。
4. 上一轮 r2 证据里写的"**每行都拒绝挂按钮**"（v1 tf 形状）是**错的**：
   **v1 的 tf 行能挂 B / C，只是没挂上按钮**。以
   `r3-.../v2-readback-corrections.md` 为准。

#### 未测与已知边界（不要越读）

- ❌ **真实 Enter / Space**。4.x 只断言"没挂 keydown、只挂一个原生 click"。
- ❌ **真实 hover 视觉**（红、focus ring、30/32px、横向排列）。r2 v1 / v2 夹具**都没开过浏览器**。
- ❌ **浏览器事件到达**：主会话 IAB 通道对 8792 / 8793 均超时，事后读回是
  **产品侧点击 0、夹具侧 `bub.red` / `bub.key` 全 0**。这只能说明**事件根本没到页面层**，
  **不得**解释成"产品拒绝了任何东西"。像素 / 键盘 / 点击 / 收敛一律 **未通过未测**。
- ❌ 真实 `setPinnedItemsOrder` 提交语义、真实 fiber 树与 hook 闭包、真实会话 id、云端 / 只读分支。
- ❌ 应用重启后的持久性与冷启动。
- ⚠️ `scheduleApply` 的 `pending` 闩锁在**掉帧**后不会自行恢复（r2 review FINDING 3）。
  本轮**未修**（超出 r3 范围），如实登记。
- ⚠️ §14.23 的 **DB 基线 29 vs 27 裁决仍阻塞**，本节不碰、不归因、不覆写。
- ⚠️ 四套变异体系（rv13 的 16 / §14.23 的 43 / r2 的 69 / r3 的 78）**不可相加、不可互相替代**。

> 本节**不构成**「功能已交付」「已部署」「验收通过」或「问题已解决」。
---

### 15.13 锁顶 r4：**r3 判 NOT PASS**，两处产品缺陷 + 一处局部 LOW 修正（2026-10-04，**离线，未部署**）

> 本节**只追加，不改写** §15.10 / §15.11 / §15.12。证据：
> `_diag-toplock/r4-2026-10-04_1000-offline-toplock/`。
> 同目录下 `snapshot-r3/` 保存了 r3 冻结时的**完整前字节**（不只是 SHA），可以直接 diff。

#### 结论先写清楚

| 项 | 状态 |
|---|---|
| **r3（`84ba6be1…`）判决** | ❌ **NOT PASS**。两份独立复审合计 **两处产品缺陷** + **一处局部 LOW** |
| 代码落盘 | ✅ `src/lib/page-script.mjs`（r3 `84ba6be1…` → r4 见 `freeze.md`） |
| 离线行为套件 | ✅ `src/test-top-lock.mjs` **414 断言 / 0 FAIL**（r3 为 345）；`test-topmost-menu.mjs` **621 / 0**（r3 为 603）；`test-topmost-diag.mjs` **146 / 0** |
| 变异证明 | ✅ **85/85 全红、0 崩溃**（r3 的 78 条**全部保留**锚点与测试意图 + 新增 `m23…m25` / `x1…x4`） |
| 全量套件 | ✅ 11 个套件 **0 FAIL、0 非零退出** |
| 结构门 | ✅ **两个 CWD 都可跑**（r3 只在 `CWD=src` 时成立，见下） |
| **浏览器** | ⚠️ 主会话**已实际打开** r3 夹具：snapshot / screenshot **成功**，像素上**看到固定面板遮住三行右端**。**交互仍未通过**（详见 §未测） |
| **受控部署** | ❌ **未做**，门仍关 |
| **真机 GUI** | ❌ **未做** |

**r4 仍然是"离线绿"，不是"通过"。**

#### r3 的两处产品缺陷（复审发现的，r3 的测试没能抓到）

**缺陷 1（到最顶菜单入口绕过了闸）。** r3 的 `onTopmostActivate` 写的是

    topmostState.busy = true;
    topmostState.ticket = hostCallTake();     // 闸拒绝时返回 null
    topmostState.calls++;
    ret = cap.fn(sessionId, true, 0);         // 照样调用

r3 的共享闸会 **fail closed**（槽不可写时返回 `null`），但这条路径**把 `null` 丢掉了**，
于是 r3 闸的每一条 fail-closed 分支在这条入口上**都是装饰**。
顺带还有两个后果：`busy` 在取票**之前**就被置真，闸拒绝之后**不释放**；`calls++` 也照加，
用户看得见的计数器会把一次拒绝显示成一次成功。

r4：先取票，**`null` 即拒绝** —— 不调用 `cap.fn`、`busy` 不残留、`ticket` 不残留、
`calls` 不增、`blocked++`、原因 `gate-unavailable`（界面上是中文：
"置顶闸不可用，本次未对宿主做任何写入"，**不与 `busy` 混用**：
`busy` 是"别人正在写，稍等"，`gate-unavailable` 是"闸本身不可用，等也没用"），
菜单照常关闭（手势发生过，别把菜单吊在半空）。

**缺陷 2（存储写失败闩永不清除）。** `topLockStoreSet` 成功路径只清了 `storageBroken`，
**没清 `storageWriteFailed`**。于是**一次**写失败之后，`topLockTick` 之后每一趟都
`paused: storage-write-failed` —— **包括用户再次点击、并且这次点击真的落盘之后**。
表现是"存储已经恢复、意图也在、按钮还是不可用"。

r4：**只有 `setItem` 成功**才清 `storageWriteFailed`；失败分支照旧置位；
`load()` 与任何重画**都不碰**它（`w9` 的方向保留：失败不能被下一趟 `idle` 洗掉）。
清除点**只有一处**，这是刻意的单点。

#### 局部 LOW：CSS 注册表的死三元

r3 的 `topLockCssRegistry` 结尾是

    return window[KEY] === fresh ? fresh : fresh;

一个**三路同值的假检查**：它声称验了 window，实际永远只能返回局部对象。
把它改成"诚实的私有回退"的过程中，**新写的断言立刻查出它掩盖的真 bug**：
私有对象**每次调用都重建**，于是槽不可写时每趟都拿到一份**全新的空规则集**，
刚写进去的规则进了临时对象，**样式表是空的** —— 而且恰好发生在"什么都存不住"的那种 window 上。

r4：私有回退缓存在模块局部 `topLockCssPrivateReg`，同一实例内每次调用看到同一个注册表，
样式表真的拿到规则。共享闸与运行时**仍然拒绝**（它们的状态决定要不要写宿主，不是展示细节）。

#### 测试有效性

- 新增 **菜单 §22**：闸槽不可写（`Object.freeze` 的 window）→ 零宿主写 / order 未变 /
  `calls` 不增 / `busy` 不残留 / 原因可读 / 中文文案 / 按钮仍可见；
  **在途对照**（别人的票是**对象身份**）→ 在 `busy` 门上被拦（与 `gate-unavailable` 区分开）、
  零宿主写、不抢票、**释放后同一个手势可恢复**；**可写对照** → 照旧成功、闸对象真的在 window 上。
- 新增 **锁顶 §28**：红按钮入口同样三态（槽不可写 / 整窗冻结 / 他人在途 / 可写对照）。
- 新增 **§29 存储恢复全链**：坏存储 + 真人点击 → 暂停、**零宿主写**、什么都没存；
  连续重画洗不掉；**存储恢复后真人再点**（**此刻没有意图可解除**，所以恢复路径只能是"再点一次锁顶"）
  → 真的落盘、**正好一次**三参宿主写（`index=0`）、新顺序确认；
  **再连续 20 趟出厂 pump 仍是 confirmed**，原因不再是 `storage-write-failed`；
  宿主再压下去仍能顶回。
- 新增 **§30**：已锁目标行消失 / `removeItem` 失败 → 旧意图必须留下，存储一个字节不动。
- 新增 **§31**：闸 / 运行时 / CSS **三个槽都不可写**时，样式表节点**仍真实挂进文档**、
  规则**非空且含出厂基础规则与 reserve 规则**、花括号成对、无 `NaN/undefined/Infinity`、
  长度有界、重画后**一个字节不变**，同时宿主仍零写。
- `press()` 改用 `pressOrFail()`：原来 `press(null)` 会**抛异常**，而 runner 把崩溃记成
  **PROBLEM 而不是红**，等于用崩溃盖住了本该红的断言。按钮不存在现在是一条可读的 FAIL。
- `test-top-lock.mjs` 头部补上 `w1…w9` 与 `x1…x4` 的**真实清单**（不是"已测"注释）。

#### 本轮还修掉的三处"证据本身"的毛病

1. **结构门只在 `CWD=src` 时成立。** r3 写的是 `readFileSync('./lib/page-script.mjs')`，
   从仓库根跑 `node mmx-status-github/src/structural-gates.mjs` 直接 **ENOENT 崩掉** ——
   结构门最容易被这样"根本没跑"的方式静默跳过。现在按 `import.meta.url` 取模块目录，
   并在第一行打印实际读到的路径与 CWD。**两个 CWD 都实测 ALL GREEN。**
2. **`selftest.mjs` 的真实通过数是 116。** §15.12 / §14.26 的表格里记的是 `0`，
   那是**当时抓取方式错了**（只读了 `pass=` 行），不是它没跑。**本节更正为 116 passed。**
3. **"pump 自己不调 refresh" 与"reinject 明确用了 `api.refresh()` + `page.run()`"并不矛盾。**
   正确说法：`pump()` 只驱动生产链，**从不调 `api.refresh()`**；
   而 reinject 那条测试**故意**调 `api.refresh()` 并 `page.run()`，
   因为它要的就是"重新求值一次 GENERATED 文件"这个真实路径。
   **不要说成"整个夹具一次 refresh 都没有"** —— 那会把 reinject 的接线一起否掉。

#### 浏览器事实（按主会话实测更正，不沿用旧句）

- **writer 从未在浏览器里打开过 r3 夹具** —— 这只说明**我**没开。
- **主会话已实际打开**：8792 / 8793 的 IAB 通道 **goto / domSnapshot / screenshot 均超时**；
  事后读回是**产品侧点击 0、夹具侧冒泡计数全 0**。独立仪表复审进一步确认
  `document` 捕获阶段 `bub.red = 0`，即**事件确实没到 document**，
  **但"为什么没到"仍未证实** —— **禁止写成"平台已坏"或"产品拒绝了"**。
- **8794（r3 夹具）本轮 snapshot / screenshot 成功**：`dom_cua.get_visible_dom`
  **看到三颗 32/30/30 的红按钮**；像素上**固定面板遮住三行右端**，
  覆盖了三颗图标，导致 hover 视觉无法验收；
  `domSnapshot` 报 Internal error；对未被遮挡的合成对照的点击仍 **timeout 30000**。
  **所以：像素可见 ≠ 交互通过。** 交互这一项**仍未通过**。

#### 历史事实更正（不改写旧证据）

- **"从未有人打开过浏览器"** —— 错。准确说法：**writer 没开过；主会话开过**，
  且 8794 上拿到了 snapshot 与截图，**但视觉被面板遮挡、交互未通过**。
- **"v1 的 tf 行能挂 B/C"** —— 句式有歧义。准确说法：
  **v1 的 tf 行能挂出红按钮**（挂得上），**挂不上的是 B（ipinned）与 C（irecent）**。
- **`strip marker = 1` 是产品正确行为**，不是漏挂：只有 `irecent` 的 `stripWidth` 非 0，
  产品只对有固定宽度的 strip 打标（`topLockApplyReserve`）。**不要"改成 3"。**
- **`Math.round(getComputedStyle(b).width)` 恒为 `NaN`** —— 因为 `Math.round("32px")`
  就是 `NaN`（`Number("32px")` 不是数）。**与 `display:none` 无关，**
  任何按钮都会这样。必须改用 `getBoundingClientRect()` 的数值，
  并在**没有布局盒时明写"无布局盒"**，不伪造值。

#### 未测与已知边界（不要越读）

- ❌ **真实 hover 视觉**（红、focus ring、30/32px、横向排列）。主会话的截图上
  **这三项被固定面板挡住**，因此**仍未通过未测**。
- ❌ **真实 Enter / Space**、**真实点击 / 收敛**。8794 的点击仍 timeout，
  原因**未证实**，不得归因给产品。
- ❌ 真实 `setPinnedItemsOrder` 提交语义、真实 fiber 树与 hook 闭包、真实会话 id、
  云端 / 只读分支。❌ 应用重启后的持久性与冷启动。❌ 受控部署。
- ⚠️ `scheduleApply` 的 `pending` 闩锁**掉帧后不会自行恢复**（r2 review FINDING 3），
  **仍未修**（范围外）。r4 的仪表侧会**按 handle 记账取消**，
  但**不改产品调度**。
- ⚠️ §14.23 的 **DB 基线 29 vs 27 裁决仍阻塞**，本节不碰、不归因、不覆写。
- ⚠️ 五套变异体系（rv13 的 16 / §14.23 的 43 / r2 的 69 / r3 的 78 / r4 的 85）
  **不可相加、不可互相替代**。r3 的 78 条**全部保留**。

> 本节**不构成**「功能已交付」「已部署」「验收通过」或「问题已解决」。

### 15.14 锁顶 r5：两条**测试**补强 + 三处**证据本身**的勘误（2026-10-04，**离线，未部署**）

> 本节**只追加**，不改写 §15.12 / §15.13 的任何一行。
> 证据：`_diag-toplock/r5-2026-10-04_1100-offline-toplock/`。
> **本节不构成**「验收通过」「已部署」或「GUI 已验证」。

#### 结论先写清楚

| 项 | 状态 |
|---|---|
| **本轮改了什么** | **三个测试文件**（`test-topmost-menu.mjs` / `test-top-lock.mjs` / `run-mutations.mjs`）里的**断言**与**变异登记**；产品 `page-script.mjs` **只改注释，一个字节的逻辑都没动** |
| 离线行为套件 | ✅ 11 套件 **0 FAIL、0 非零退出**（合计 **1770** 断言；r4 为 1754） |
| 变异证明 | ✅ **87/87 全红、0 崩溃**（r4 的 85 条**全部保留**锚点与意图 + 新增 `m26` / `x5`） |
| 结构门 | ✅ **两个 CWD 实测 ALL GREEN**（见勘误 3） |
| **浏览器 / 真机 GUI** | ❌ **未测**。本轮 writer **没有开过任何浏览器**；受控加载授权与 §14.23 的 **29 vs 27 基线裁决**仍未解除，**部署门仍关** |

#### r5 补强的两条测试（都是**断言空洞**，不是产品缺陷）

**补强 1 — 菜单 §22.1「菜单照样关闭」原本是恒真断言。**
旧断言是

    p.api.state.lastClose !== null && p.api.state.lastClose !== undefined

`lastClose` 的初值是 `''`，而**闸拒绝分支根本不赋值 `lastClose`**（它只调
`closeHostMenu(menuFiber)` 并丢弃返回值）。所以无论菜单关没关，这个表达式都是真 ——
把拒绝分支里的 `closeHostMenu` 整行删掉，**全绿依旧**。
r5 改为断言**宿主自己的受控契约**：受控 Dropdown 的 `onOpenChange` 被调用
**恰好一次**、实参是 `false`，并且宿主的受控 `open` 状态**真的从 true 变成 false**
（夹具把这个回调建模成「宿主应用新状态再渲染」，与 React 受控组件一致）。
新增变异 **`m26` 专门只删拒绝分支的 `closeHostMenu`** ——
实测 `pass=621 fail=2`、**exit 1、stderr 空**，即正常 FAIL 而**不是崩溃**。
`onOpenChange calls=[]` 这一行本身就证明旧断言是瞎的。

**补强 2 — 存储 `topLockStoreClear` 成功清闩**此前**零覆盖**。
闩 `storageWriteFailed` 只有**两个**合法清除点（成功 `setItem` / 成功 `removeItem`），
r4 只测了第一个。§30.2 只证明了「`removeItem` 失败 → 意图必须留下」，
**没有测恢复的那一半**：把 `topLockStoreClear` 里那行清除删掉，**全绿依旧**。
r5 新增 **§30.3 / §30.4 / §30.5**（全部经由**出厂 bootstrap + 真按钮 + 生产 pump**，
**不手种任何 flag / budget**）：

    removeItem 失败（真失败）→ 恢复 remove → 重画**不能**把闩洗掉
    → 模拟可信用户解除（真按红按钮）→ 存储与意图**真正**清除
    → 20 趟出厂 pump 不再错误暂停在 storage-write-failed → 再次锁顶可 confirmed

新增变异 **`x5` 只删 `topLockStoreClear` 里那行清除** ——
实测 `pass=426 fail=2`、**exit 1、stderr 空**，红在
`30.3 恢复后真人解除：不再是 storage-write-failed 暂停` 与 `30.4`，
即**正是这条新链**在看。

**顺带修掉一处已被 r5 打断的变异锚点。** r5 改了 `page-script.mjs` 的注释（勘误 1），
而变异 `x1` 的锚点**含那段旧注释**，于是 `x1` 从「红」变成
`Error: mutation x1 anchor matched 0 times`（**崩溃**）。
x1 的锚点已重新钉到更正后的注释，意图不变（`topLockStoreSet` 不再清闩），实测仍红。

#### 本轮勘误（三处**证据本身**的毛病，**只登记，不回改旧正文**）

**勘误 1 — 存储闩是**两**个清除点，旧注释说成一处。**
`page-script.mjs` 里 `topLockStoreSet` 的注释原文写着清除「belongs here and
nowhere else」——**这句是错的**：`topLockStoreClear` 成功时同样清 `storageWriteFailed`
（`removeItem` 成功也是一次成功的存储操作）。r5 **只改这段注释**，写明两个清点，
并写明**不允许**清除它的位置（`load()` / 任何重画 / `topLockTick` / 两个失败分支）。
**产品逻辑一个字节都没改**；x1 / x5 两条变异合起来证明**两处都还在**。

**勘误 2 — r4 `freeze.md:38` 把 **r2 的 topLock 哈希串进了 r3 的 menu/diag** 对应值。**
该句原文形如「它们的 r4 SHA 如上表第 3、4 行；r3 的对应值分别是 `1eb9cce8…`
（顶层 lock 套件）……」——`1eb9cce8…` 是 **r2 的 `src/test-top-lock.mjs`**，
**与 menu / diag 毫无关系**。正确事实是：**r3 的 `post-SHA256.txt` 根本没有
`test-topmost-menu.mjs` 与 `test-topmost-diag.mjs` 这两行**（当时漏存），
所以**它们的 r3 对应值不存在**，不是「等于 r2 的 topLock 哈希」。
r4 的实际值是 menu `d8e6e288…`、diag `e4bc554e…`。

**勘误 3 — §15.13 第 1 条把 **workspace root** 写成了「仓库根」。**
原文写「从仓库根跑 `node mmx-status-github/src/structural-gates.mjs`」——
这条路径是相对 **workspace 根** `G:\mmx-project\fix mmx\` 的，
**不是**仓库根 `G:\mmx-project\fix mmx\mmx-status-github\`；在仓库根要写
`node src/structural-gates.mjs`。r5 **实跑三个 CWD**，全部 exit 0 / ALL GREEN：

| CWD | 命令 | 结果 |
|---|---|---|
| `…\mmx-status-github\src` | `node structural-gates.mjs` | exit 0，ALL GREEN |
| `…\mmx-status-github`（**真仓库根**） | `node src/structural-gates.mjs` | exit 0，ALL GREEN |
| `G:\mmx-project\fix mmx`（**workspace 根**） | `node mmx-status-github/src/structural-gates.mjs` | exit 0，ALL GREEN |

三处 CWD 打印的都是**同一个**被读文件
`…\mmx-status-github\src\lib\page-script.mjs`——这正是结构门按
`import.meta.url` 取路径的意义（§15.13 第 1 条的修复本身是对的，**只有那句标签写错了**）。

> **本节位置说明**：本节插在 **§16 之前**，**不是**文件末尾。
> 这与 §15.13 插在同一位置，属既有惯例；本轮**未改写** §16 及之后的任何一行。

### 15.15 锁顶 r5.1：F1 断言收口 + 三条口径勘误（2026-10-04，**离线，未部署**）

> 本节**只追加**，不改写 §15.12 / §15.13 / §15.14 的任何一行。
> 证据：`_diag-toplock/r5.1-f1-20261004-final/`（含 `snapshot-r5/`、`suites/`、`counterexamples/`）。
> **产品字节未动**：`src/lib/page-script.mjs` 仍是 `acf12aa7…`，**逻辑零改动**。
> **本节不构成**「验收通过」「已部署」或「GUI 已验证」。

#### 15.15.1 F1 那一段的收口（**只改 test 侧**）

§15.14 写的 F1 补强，r5.1 按复审意见**再收紧三处**，**产品一行未动**：

1. **删掉 `dropdown.memoizedProps.open = true` 那行死写。**
   它写的是一个**产品从不读**的字段（`page-script.mjs` 里没有任何地方读
   `memoizedProps.open`），所以它看起来像证据，其实不是——它只是让前置断言
   必然为真。删掉之后，菜单「点击前是开着的」这件事**只由夹具自己的播种负责**。
2. **前置改成播种自检，并在 `item.dispatch` 之前取一次 `beforeOpen`。**
   点击前记录 `beforeOpen`，点击后**同一条断言同时要求**
   `beforeOpen === true && mopts.open === false`。
   读一次存下来再断言，才使这两端构成一个**跃迁**，而不是两个各自独立、各自可能
   因别的理由为真的终值。
3. **注释改述 `mopts` 的身份**：它是**宿主受控契约的替身**，只负责记录产品
   发出的调用；**不模拟 React 重渲染**，`open=false` 之后宿主如何重渲染
   **本测试不涉及**。**只有 `mopts` 一份状态源**，没有引入第二个。

**两条新反例**（`counterexamples/`，原输出留档）：

| 反例 | 做法 | 结果 |
|---|---|---|
| **CE1** | `onOpenChange` 只 push、不落 `open` | `pass=622 fail=1`、**exit 1**、**正常 FAIL**：**次数断言 PASS**，**状态/跃迁 FAIL** |
| **CE2** | 把宿主的关闭回调整个拿走（`dropdown.memoizedProps.onOpenChange = undefined`，与 §8.5 同一形状） | `pass=621 fail=2`、**exit 1**、**正常 FAIL**：**次数与状态/跃迁都 FAIL** |

CE2 **不能**靠「从 `mopts` 里删掉 `onOpenChange`」来做：`makeRow` 在
`opts.onOpenChange` 为假时会**自己补一个默认记录器**，调用照样被记上，
那样这条反例什么也证明不了（**这一点是实跑才发现的**，第一次写成那样时
CE2 确实「不符合预期」）。所以 CE2 改成在 fiber 上清掉回调，
**`makeRow` / `openMenu` 一律未改**。

#### 15.15.2 三条口径勘误（**只登记，不回改旧件**）

1. **r5 的 `snapshot-r4` 是 22 条，不是 20 条。**
   §15.14 与 r5 `freeze.md` 里写的「清单列出的 20 个文件」**数错了**：
   `snapshot-r4/SHA256SUMS.txt` 实际列出 **22** 条（含 `r4fixture/README.md`
   与 `r4fixture/browser/panel.html`）。**22 条逐字节全部实测匹配**这一结论
   不受影响，错的只是那个计数。r5 原件**不改**，以本条为准。
2. **「85 条锚点全部保留」不准确。**
   准确说法是：**85 条变异的 ID、测试意图与红/绿效果全部保留**，
   但 **`x1` 的锚点文本被重钉过**——因为 r5 改了 `page-script.mjs` 里那段
   含锚点的注释，旧锚点匹配 0 次会让 `x1` 从红变成**崩溃**（`mutation x1
   anchor matched 0 times`），而**崩溃不算红**。重钉后 `x1` 实测仍红
   （`pass=423 fail=5`、exit 1、stderr 0 字节）。**ID 与意图未变，变的是锚点指向的文本。**
3. **受控状态替身 ≠ React 重渲染。**
   §15.14 那句「夹具把这个回调建模成宿主应用新状态再渲染，与 React 受控组件一致」
   **说过头了**：`mopts` 是**替身**，只记录调用，**不模拟重渲染**。

**另两条已证未修的诊断缺口，本批只登记，不动产品**：

- **拒绝路径的 `closeHostMenu` 返回值被丢弃**，导致关闭失败时**没有
  `lastClose` 诊断**。涉及**三个分支**：`already-top` / `gate-unavailable` /
  `call-threw`——它们都调用了 `closeHostMenu` 但**不记录返回值**。
  这意味着「菜单到底关没关成」在拒绝路径上**没有读数**。
  **本批不修**：属既有缺口，改它要动产品，**不在 r5.1 范围**。
- `scheduleApply` 的 `pending` 闩锁**掉帧后不自恢复** —— **仍是范围外**。

#### 15.15.3 全量新鲜重跑（原始输出见 `r5.1-f1-20261004-final/`）

- **11 套件**：**全 exit 0 / 全 0 FAIL / stderr 全 0 字节**，合计 **1770** 断言（与 r5 同）
- **变异矩阵**：`5 suites green, 87/87 mutations red, 0 problem(s)`，exit 0，**0 BAD / 0 CRASH**
- **结构门三个 CWD**（`src` / **真仓库根** / workspace 根）：**全 exit 0 / ALL GREEN**
- **未加任何新的产品变异 ID**；产品源 `acf12aa7…` 全程未动
- **GUI / 真实持久序未测，未部署，部署门不变**

> 本节位置：插在 **§16 之前**，与 §15.13 / §15.14 同一位置，属既有惯例。

### 15.16 2026-10-04 用户新症状的只读诊断：置顶会话不自动到顶 · 状态点语义与一批**未修**缺陷（**只更新文档，代码未修，未部署，GUI 未测**）

> 本节**只追加**，不改写 §15.1–§15.15 的任何一行。
> 配套工作文档（证据坐标、验收矩阵、条件性风险表在那儿，不在这里重复）：
> [1003.md §14.30](../1003.md)。
>
> **本节的状态一律是**：**文档已更新，代码未修，未部署，GUI 未测。**
> 本轮只做两件事：只读源码 + 更新这两份文档。**没跑任何测试**（`selftest.mjs` 与
> `test-waiting-bucket.mjs` 会打开**真实** `runtime-state.sqlite`），
> **没启停任何服务/进程，没做浏览器、CDP、GUI、电脑操作，没碰 asar，没部署**。
> 本节**不授予任何新的 host 写能力**。

#### 15.16.1 新症状，以及为什么「手动设置置顶」不能拿来做对照

**用户 2026-10-04 报的新症状**：**已经置顶、而且位置排得很靠下的会话，在对话之后不会自动到顶。**

**定性（已收窄）**：当前**磁盘源码**把置顶区**显式排除在自动排序之外**——
这是 2026-10-03 既定裁定（15.5「置顶区不再由本项目排序」）在代码里的形态。
**对用户这次的新预期而言，这是一个尚未覆盖的产品缺口**：需求存在、实现没有，
且**本轮未获授权去补**。
**本节不证明**：跨版本历史上它从来不是 bug，也**不证明**用户现场那一次不是 bug
——**本轮既没有取证现场，也没有做跨版本比对**。这里只陈述**当前磁盘源码的行为**。

排除是**一个分叉沿三函数链传播**的结果，**不是三处各自独立的排除**：

| 环节 | 源码 | 做的事 |
|---|---|---|
| 判定 | `src/lib/page-script.mjs:398` `pinnedZoneOf()` | 一路走到文档根；命中 `data-pinned-section` / `data-pinned-drop-zone` / `data-sidebar-drop-id` 为 `pinned-drop-zone` 或 `pinned:` 前缀即判「这是置顶区」；深度用尽时按「**可能是**置顶」处理（宁可漏搬不误搬） |
| **分叉** | `src/lib/page-script.mjs:424` `findListRoots()` | **唯一的分叉点**：`if (pinnedZoneOf(n)) pinnedSeen.push(n); else roots.push(n);`——置顶列表走 `else` 的**反侧**，永远不进 `roots`；排除计数随 `apply()` 上报为 `reorder.pinnedSkipped` |
| 消费 | `src/lib/page-script.mjs:512` `applyReorder()` | 只遍历 `found.roots`，把 `[running][waiting]` 用 `insertBefore` 提到队首 |

> ⚠️ **对照实测的坑（重要）**
> 用户同时提到「**原本没置顶**的会话，对话后**手动设置置顶**是正常的」。
> **这既不等于「工具的『到最顶』」，也不等于「普通会话列表的自动提升」。**
> - **用户点的是哪个界面入口**：**本轮没有截图、没有取证，不认定**。
>   **不能**由「手动置顶正常」推出宿主 pin 曾被以某个参数调用过。
> - **本工具**已核的那条 `handlePinSession(id, true, 0)` 路径是
>   `page-script.mjs:2205` `onTopmostActivate()`（15.8「到最顶」菜单项），
>   授权边界见 1003.md §4.1 的 **T1**。
>   **用户的原生置顶操作没有被取证，不据此推断它调用了同样的宿主参数。**
> - 因此这条对照**只能说明**一件事：「用户手动设置置顶」是**另一个操作**，
>   **不能当作 ordinary activity 自动排序成功的证据**。

**这两个入口都不是「普通会话列表的自动提升」入口**：

- **一次到顶**：`page-script.mjs:2205` `onTopmostActivate()`——15.8 的右键菜单项，
  用户点一次，只做一次。
- **红锁顶**：`page-script.mjs:3503` `topLockCall()`——15.10 的红色悬停锁顶按钮。
  它在**既有单目标授权**范围内做**有界的**后台维持（那是它自己的授权，不是排序授权）。
  说它「不是后台维护」是错的；准确说法是**它维持的是锁顶意图，不是普通列表的活动排序**。
- **宿主原生 pin**：用户直接用宿主的置顶交互时，顺序是宿主 `pinned-items-order` 的事，
  本项目既不代劳也不覆盖。**本轮未取证用户走的是哪条路径。**

**锁顶维持的既有不变量（本节不改，只是复述以免被误读为「放宽」）**：
锁目标**最高优先**；`order` 缺 ref 时走 `topLockPause`（`page-script.mjs:3453`
`topLockPauseReasonFor()` → `view-unstable` / `order-missing-id`），
**保留意图**、暂停重试；**不在后台 repin、不自动 clear**。

**🚫 明确不做（红线）**：
不恢复置顶区的 DOM hoist、不恢复任何私有数组缓存当排序真相、不用 CSS `order` 假排序。
理由见 15.5 的事故史（87 个嵌套盒子被 `display:flex !important` → 渲染进程卡死）
与 15.5「置顶区不再由本项目排序」。

**如果将来要给「普通活动」在置顶区加后台排序**：
那需要**独立契约 + 独立授权 + 独立验收矩阵**。
**本节明确不构成对此的批准**，也不构成任何预备实现。

**「无 DOM ＝ 无点 ≠ 无活动」**：
置顶区折叠时**只渲染 `pinnedItems` 的前 6 项**（1003.md §2 F1，asar `@316733124`
的 `r.slice(0, 6)`），第 7 名起**根本不进 DOM**。
所以一个正在跑的置顶会话完全可能**不在 DOM 里**，因而**没有状态点**——
**这不等于它没有在跑**。
> 这条 F1 结论来自**历史包取证**。**本轮既没有重新读包，也没有开 GUI**，
> **不称「最新现场已见」**。

#### 15.16.2 状态点：什么颜色到底代表什么（含「不等于」清单）

| 你看到的 | bucket | 精确触发条件（源码） | **不等于** |
|---|---|---|---|
| **绿色满高发光竖条** + 整行淡绿底 + 绿标题 | `running` | `status = 'started'`（`bucketFor` 第 80 行） | 不等于「有输出」「快完成了」；`started` 只说明这一轮在执行 |
| **黄色满高竖条** | `waiting` | 父**不在**执行，**但有归属 subagent 在跑的证据**：`local_runtime_sessions` 里 `parent_session_id` 非空且 `status='started'` 且 `archived=0`；或 `local_runtime_background_tasks` 里 `kind='subagent'` 且 `status='running'` 且 `ended_at_ms IS NULL` | **不等于**「在等你点审批」；**不等于**「有个 bash 在跑」——`kind='subagent'` 这个过滤是承重的（见下方注）；**也不等于**父会话 idle 一定是它在等 |
| **橙色小圆点** | `paused` | `status = 'interrupted'`（第 81 行）——运行期被重启打断，这一轮没跑完 | 不等于「用户主动取消」 |
| **（默认什么都不画）** | `idle` | `aborted`（用户取消是**终态**不是暂停），`includeAborted` 才点亮成 `paused`（第 82 行） | 不等于「已完成」 |
| **红色圆点**（比其它点大一档） | `error` | 现状是 `status ∈ {error, failed}` **或** `terminal_outcome='failed'`（第 79 行）**或** 有非空 `error_message`（第 83 行） | **这一格的现状有已知缺陷**，见 15.16.3；不要把它当成「这一轮刚失败」 |
| **灰色小圆点** | `done` | `idle` + `terminal_outcome='completed'`（第 84 行），**且 `--show-done` / `showDone` 打开**（`page-script.mjs` 里 `if (bucket === 'done' && !cfg.showDone) bucket = undefined;`） | 默认不开；**灰点不是「刚完成」的实时信号** |

> **「没有点」不证明任何事。** 它同时可能是：真的 idle / 已完成 / 已取消 /
> `aborted` 未点亮 / 归档了不在未归档集合里 / id 不在库里 / 这一轮没被采样到 /
> 会话行根本没在 DOM 里（见上一小节的 F1）。**这几种要分开说，不要合并成「都完成了」。**

> **关于「75% 假阳性」这个旧数字**：`kind='subagent'` 过滤的必要性是**源码事实**
> （`status-db.mjs:63-64` 只查 `kind='subagent'`，`bash` 根本进不来）。
> 但**源码注释里那两个比例本身自相矛盾**（一处写「3 of the 5」，一处写「75%」，
> 而 3/5 ＝ 60%），且**本轮没有重测**。
> **本节因此不引用任何比例数字**，只保留「过滤是承重的」这个可由源码读出的结论。

**云端会话（Cloud 视图）走的是另一套映射，不要和本地混**（`page-script.mjs:634` `cloudBucketFor()`）：

| 云端事件 | 本工具映射结果 |
|---|---|
| `session.start` | `running`（绿竖条，与本地同形） |
| `session.error` | `error`（红） |
| `session.finish` / `session.abort` | **从 Map 移除 ＝ 不画点** |
| 其它（`created` / `title_updated` / `pinned_updated` …） | 忽略 |

**本工具的云端事件映射未实现 `waiting`、也未实现 `paused`。**
这是对**本工具这四个事件映射**的陈述，**不断言宿主云端是否存在「等子任务」
或「中断」这类概念**——那是另一回事，本轮没有取证。
本工具云端状态来自订阅宿主事件总线并**倒序重放**（15.7），
本地状态来自 SQLite 轮询——**两条链路不要互相外推**。

**几个必须分清的东西**：

- **红色锁图标 ≠ 红色 error 点。** 红锁是 15.10 的**锁顶按钮**（`topLock` 一族属性），
  `error` 点是 `data-mmx-bucket="error"`。两套东西，形状、触发、语义全不同。
- **「工具实现里每个 session 行挂一个 `data-mmx-dot`」≠「真实界面上只会有一个符号」。**
  `ensureDot()`（`page-script.mjs:230`）做的是 `row.querySelector('['+MARK+']')`
  查不到就 `createElement('span')` + `row.appendChild`——**一行一颗**是工具的写法，
  **不能据此断言真实渲染出来的观感**。
- 用户提到的**「第二点」**：**本轮没有看当前截图，因此不认定它是什么**。
  「原生未读符号」「另一颗 dot」「锁按钮」等**只作候选列出，不作结论**。
- **只带 `data-agent-id`、不带 `data-session-id` 的行不在画点集合内**：
  画点入口是 `apply()`（`page-script.mjs:734`），它**只**遍历
  `document.querySelectorAll('[data-session-id]')`。
  **若一行两个属性都带，则不能据此排除它**——**本轮未取证，不下断言**。
  **测试夹具里造的嵌套 `data-session-id` 也不能外推**成「现场真的有嵌套子 agent 行」。

#### 15.16.3 硬缺陷：`bucketFor` 的判据顺序让「上一次失败」压过「当前在跑」

**根因一句话**（`src/lib/status-db.mjs:78-86`）：

```js
export function bucketFor({ status, terminalOutcome, hasErrorMessage, includeAborted = false }) {
  if (ERROR.has(status) || terminalOutcome === 'failed') return BUCKET.error;    // ← 第 79 行，最先判
  if (RUNNING.has(status)) return BUCKET.running;                               // ← 第 80 行
  if (INTERRUPTED.has(status)) return BUCKET.paused;                            // ← 第 81 行
  if (ABORTED.has(status)) return includeAborted ? BUCKET.paused : BUCKET.idle; // ← 第 82 行
  if (hasErrorMessage) return BUCKET.error;                                     // ← 第 83 行
  if (status === 'idle' && terminalOutcome === 'completed') return BUCKET.done; // ← 第 84 行
  return BUCKET.idle;                                                           // ← 第 85 行
}
```

**两个补充字段抢的**不是同一段**顺序，范围必须分开说**：

- **`terminalOutcome === 'failed'`（第 79 行）排在最前**，因此它同时抢在
  `running`（:80）、`interrupted`（:81）、`aborted`（:82）**三条之前**。
- **`hasErrorMessage`（第 83 行）排在这三条之后**，
  它**只抢**它后面的 `idle + completed → done`（:84）。

**这两个字段不是无条件的「上一轮残留」**：
它们是**补充描述**，只有**与当前状态组合出矛盾**的那些场景才构成冲突。
本节只把**组合矛盾**的那些行判成缺口（表 1–6），其余不判。
`applyWaitingOverlay()`（`status-db.mjs:227`）只在 `cur.bucket === error`
**且** `ERROR.has(cur.status)`（**当前**状态真是 error/failed）时才豁免；
所以被补充字段染成 `error` 的会话，**没有子 agent 时保留红点，有子 agent 时会被翻成黄**。

| # | 输入组合 | 当前代码 | 期望 | 证据 | 状态 |
|---|---|---|---|---|---|
| 1 | `started` + `terminal_outcome='failed'`，**无**子 agent | 🔴 红 `error` | 🟢 绿 `running` | :79 早于 :80 | **未修** |
| 2 | `started` + 同上，**有**子 agent | 🟡 黄 `waiting` | 🟢 绿 `running` | :79 早于 :80，且 overlay 的 `ERROR.has` 豁免不成立 | **未修** |
| 3 | `interrupted` + 同上，**无**子 agent | 🔴 红 | 🟠 橙 `paused` | :79 早于 :81 | **未修** |
| 4 | `interrupted` + 同上，**有**子 agent | 🟡 黄 | 🟠 橙 `paused` | 同上 | **未修** |
| 5 | `aborted` + `terminal_outcome='failed'` | 🔴 红 | **取消态本身不是故障**：默认无点（`includeAborted` 才 `paused`） | **:79 早于 :82**（**不是** :83） | **未修** |
| 6 | `idle` + `completed` + 有 `error_message` | 🔴 红 | 完成态（默认无点 / opt-in 灰 `done`） | :83 早于 :84 | **未修** |
| 7 | `idle` + `terminal_outcome='failed'`（无子 agent） | 🔴 红保留 | **保留红** | `status-db.mjs:79`；`src/selftest.mjs:40` 锁定 | ✅ **现状正确，基础策略保留** |
| 8 | 裸 `idle` + `error_message`（无 completed、无子 agent） | 🔴 红保留 | **保留红** | `status-db.mjs:83`；`src/selftest.mjs:41` 锁定 | ✅ **现状正确，基础策略保留** |
| 9 | `error`/`failed`（**live**）+ 有子 agent | 🔴 红 | 🔴 红 | overlay 显式豁免 | ✅ 现状正确 |
| 10 | `status` **不在词表内** | **取决于补充字段与子 agent，不是一律无点** | — | `src/selftest.mjs:43` 只锁了「无补充字段、无子 agent ⇒ idle 无点」 | ⚠️ **不判为缺陷**（见下） |

**第 7 / 8 条**：这两条**是现状正确的基础策略，不是待裁决项、也不是未修缺陷**。
它们的**行为来源是 `status-db.mjs:79` / `:83`**；
`selftest.mjs:40` / `:41` 只是**把这个既有行为锁住**的测试，
**不是缺陷的成因，也不该删**——删掉只会让一个已定的产品决策失去保护。

**第 10 条要说清楚「不猜」的边界**：`unknown` 指的是**不凭空把未知状态判成旧的或新的**。
具体地：
- 未知 `status` **且**没有 `failed` / 没有 `error_message` / 没有子 agent ⇒ 落到 `idle`，**无点**（`:85`）；
- 未知 `status` **但**有 `failed` 或有 `error_message` ⇒ **红**（`:79` / `:83`），
  若此时**存在 subagent**，`applyWaitingOverlay` 还**可能把它翻成黄**。
**本节不把「所有 unknown 一律判红」或「一律判无点」列为修复要求**——那需要新的产品口径，
不在本节范围。

**建议的修复层（尚未实施）**：

- 改 **`bucketFor` 的判据顺序**，让**当前状态优先**：
  `status ∈ {started, interrupted, aborted, error, failed}` 先判，
  `terminalOutcome` / `error_message` 这类**补充**判据降到它们**后面**。
- **只加一行 `continue` 去挡 overlay 不会修好上游的 `bucketFor`**：
  - 表 1 / 3 / 6 这类**当前是红**的行，overlay 里加 `continue` **原样保留红**，问题一点没少；
  - 表 2 / 4 这类**当前是黄**的行，加 `continue` 会把它们**留成错误红**，比现在更差；
  - 更重要的是，**它不可能把任何一行凭 `continue` 变成正确的绿或橙**——
    正确的 `running` / `paused` 必须在**上游**由正确的 `bucketFor` 产生。
- overlay **已经做对的部分要保留**：按**正确的 bucket** 保护
  `running` / `paused` / **live** `error`（上表 9）。

**测试覆盖的漏洞（只登记，本轮未新增任何测试）**：
`src/test-waiting-bucket.mjs` 第 39 行的行工厂是
`row = (id, status) => ({ id, status, bucket: bucketFor({ status }), title: id })`
——**只传 `status`，从不传 `terminalOutcome`**；第 139 行（`started -> running`）
与第 141 行（`interrupted -> paused`）的 `bucketFor` 同样**不带 outcome**。
所以**现有用例没有覆盖上表 1–6 的 outcome 组合**——这是**覆盖漏洞**，不是回归。
将来要补的用例至少要覆盖 1 / 2 / 3 / 4 / 5 / 6 六种组合。
**本轮没有新增测试，也没有跑测试。**

#### 15.16.4 UI 层的语义缺口：颜色之外什么都没给

| 位置 | 现状（源码） | 缺口 |
|---|---|---|
| `ensureDot()` `page-script.mjs:230` | 只 `dot.setAttribute(MARK,'1')` + `row.appendChild(dot)`，**没有 `title`、没有 `aria-label`、没有 `role`** | 鼠标用户**看不出颜色代表什么** |
| 基础 dot 样式 `page-script.mjs:62` | `[data-mmx-dot]{ … pointer-events:none; }` | **不可悬停** → 即使加了 `title` 也弹不出来；`pointer-events:none` 同时意味着**不会挡住**原按钮点击 |
| 汇总条 `ensureSummary()` | **有计数文字**：`N 个运行中` / `N 个在等子任务`（`textContent` 写死） | **不能说「summary 没有文字」**。但**没有完整图例、没有 `title`、没有 `aria`** |
| `StatusDb.snapshot()` `status-db.mjs:274-280` | 只输出 `{ id: bucket }` 的**字符串映射** | **没有错误详情、没有等待明细** → 前端**拿不到「为什么是这个颜色」**，也**拿不到那个数** |
| `collectWaiting()` `status-db.mjs:151-162` | 两条查询**各自每返回一条结果就 `bump(id,'subagent')` 一次**。child 那条是 `SELECT DISTINCT parent_session_id`（`:115-122`），**每个父会话最多一条结果、贡献 1**；background 那条是 `GROUP BY owner_session_id, kind` 且 `kind` 已被固定成 `'subagent'`（`:123-130`），**每个 owner 只产生一条分组结果、贡献 1**——**即使同一 owner 有 5 条 running background 行，也只贡献 1**；`COUNT(*) AS n` **从未被读取** | 只有 `isWaiting`（`:172`）的**「`subagent > 0` 吗」**被真正消费；明细挂在 `cur.waiting` 上，但 `snapshot()` **不带它出库** |

> ⚠️ **由上面两行推出的三条禁语**（本节已逐条自查）：
> 1. 同一个 session id 内部：`subagent` 的值是 **0 / 1 / 2**——
>    **child 那路有结果 ⇒ 1，background 那路有结果 ⇒ 1，两路都命中同一个 id ⇒ 2，两路都没有 ⇒ 0（且不产生 detail）**。
>    它**既不是实体数量，也不是布尔值**；而且**页面根本收不到这个数字**
>    （`snapshot()` 只给 `{id: bucket}`）。
>    **不能声称**「tooltip 会显示 N 个子 agent」——**它现在什么都不显示**。
> 2. **不能声称**会显示 error 原文——`snapshot()` 里没有错误详情可显示。
> 3. **不能说**「已有独立证据证明 `DISTINCT parent` 与 `COUNT n` 指向不同实体」——
>    **没有做过这种验证**。
>    **没有做过这种验证**，两者现在都只贡献一个布尔。

**建议（待实现，本轮未做）**：给每个 bucket 加**静态 `title` / `aria-label`**，
并提供**可触达的说明或图例**（不是只换颜色），同时**不得破坏**原有按钮的事件、
指针行为与布局。**本轮一条都没实现。**

#### 15.16.5 条件性风险与边界（逐条标了「已证 / 未测 / 条件性」）

| # | 风险 | 成立条件 | 当前状态 |
|---|---|---|---|
| 1 | 同一 id 出现在**两处行**时，`stats.rows / runningOnScreen / waitingOnScreen` **按行重复计数** | 置顶区 + 分组区同会话各一行（`bucketsOf` 注释自己就写了「A row may carry more than one session node」） | **条件性**；现场**未测** |
| 2 | `applyReorder` 的 `w.querySelector('[data-session-id]')` 是**后代查询**；`row.querySelector('['+MARK+']')` 同理 | 真实 DOM 出现**嵌套** session 行时，可**跨行认领**并**跨行删点** | **离线合成夹具可复现**；**现场结构未证明** |
| 3 | CSS `… button, … button *{color:…}` 给**所有后代**染色（running 在 `:104-105`、waiting 在 `:149-150`） | 静态范围过宽 | **静态可见**；**实际图标观感未测** |
| 4 | daemon 掉线后页面**继续用上一次的 `cfg.status`**：`buildRefreshExpression()` 只发 `refresh(statusMap)`，**不带时间戳、没有过期指示** | daemon 崩溃/断连 | 代码路径**已证**；现场**未测** |
| 5 | 2.5s 轮询可能**整个漏掉**一段短的 `started→idle` | 会话在 2.5s 内起停 | daemon `interval: 2500`（`daemon.mjs:53/185`）、页面 `intervalMs: 3000`（`page-script.mjs:3774/4028`），两拍不同步；**现场未测** |
| 6 | subagent 行**没有心跳**（`updated_at_ms` 在 24s 采样里字节不变） | 有人想给 `waiting` 加 TTL | **不擅自加 TTL 超时清黄**——会误杀长期合法等待。崩溃留下的孤儿行会**一直黄**，这是**刻意选的**安全失败方向 |
| 7 | `stats.unknownIds` 在 `page-script.mjs:735` 初始化为 `0`，**全文件再无自增** | — | **诊断死字段**，读它**不能**当作「现场有未知 id」的证据 |
| 8 | 非置顶行 `active → done` **不保证回到原序** | 排序只把 running/waiting 提到队首，其余保持**当次**原相对序 | 设计如此；**未测** |
| 9 | `paused` 的恢复：`topLockConfirm()` 在**已证明 order 里目标位于首位**时会恢复 `confirmed` | — | **不能说「永远不自愈」**。但**非首位**的 `paused` **不会后台重发** |
| 10 | 审批发生时**会话的实际 status 未知** | 宿主是否在该时刻把 status 置为某个具体值 | **本轮未取证**。**不能**把「审批时的 status」当成 `waiting` 的根因或证据 |

#### 15.16.6 2026-10-04 只读核对时的运行身份（**历史快照，不是持续实时结论**）

> 来源：**2026-10-04 的一次只读代理核对**。
> **本轮（文档轮）没有重新查进程、没有连 CDP、没有开 GUI。**

| 项 | 只读核对当时的读数 |
|---|---|
| daemon 进程 | `pid 64448`，`CreationDate 00:00:32` |
| 命令行 | `node daemon.mjs --port 9331 --interval 2500` |
| 磁盘 `src/lib/page-script.mjs` mtime | `08:55`，**晚于**上面那个进程的开始时刻 |

**由此能推的和不能推的**：

- ✅ **能推的是模块换字节的机制**：页面脚本是**静态 ESM `import` 注入**的。
  **磁盘字节换成已加载的模块，需要那个进程重新载入模块**才成立。
  **普通页面刷新、或者用旧 daemon 重新注入，都仍然复用原模块，不会升级到新字节。**
  **本轮不批准重启或另起 daemon**，所以这一步**没有发生**。
- ⚠️ **那次核对只能给出「历史链路推断」**：磁盘 mtime 晚于那时的进程开始时刻，
  加上上面的机制，指向「那条链当时没有换到新字节」。
  **这不是 renderer 内的字节直读**，**renderer 里那份注入物的完整身份没有被直接证明**。
- 🚫 **不要**把「当前跑的就是旧版」当成**持续实时事实**来引用——
  那是一条**有明确时点**（2026-10-04 那次核对）的历史推断。
- ❌ 历史 `topmost.available=false` / `reason=no-fiber-root`
  与本轮普通 activity 观察到的 `no-path` 是**正交**的两件事，**不解释**本轮任何根因。

**两个 hash 别混**：

| 值 | 是什么 |
|---|---|
| `acf12aa70f0b7ef16925eee9bc86ab2a32aa73a53f3272ade8fcda3daa4ff72c` | **磁盘 `src/lib/page-script.mjs` 的 SHA256**（= r5.1 产品字节）。本轮 fresh 复核**保持不变** |
| `cfaa1fbaea3605303ac3f13fe6fbfbc295d71f96` | **git blob hash**（`git hash-object`），**不是 SHA256**。两者算法不同，**不可比较、不可互换** |

**附带已报告风险（只登记，本节不修、也不重新追进程）**：

- **陈旧 pidfile**：`watchdog-daemon.pid` 指向已死进程这件事，是在
  **2026-10-03 的 §14.24 阶段**核对并记录的，**不在**上面那份 2026-10-04 快照里。
  按分阶段历史引用即可，见 [1003.md §14.24](../1003.md)；**本节不复述那个 pid 数字**。
- **watchdog 自激风险与上面那条是**不同的时点**的登记**，
  同样**只引用分阶段历史**，本轮**不追进程**。

#### 15.16.7 交付门：本节**不解除**任何一道

- **历史已审事实**（**范围不同，不要混算**）：
  - r5.1 离线：**1770** 断言全绿、**87/87** 变异正常红（§15.15）。
  - r5.2 离线夹具：**66 / 79 / 156 / 19** 四道门全绿，**16** 条变异全部正常 FAIL、**0 crash**。
    独立终审结论 **PASS**，**严格限定为 offline 夹具**；带 **3 LOW + 3 INFO**，它们**不全是**文字问题：
    **LOW-1 / LOW-2 / LOW-3 / INFO-2** 是**口径与覆盖说明**类；
    **INFO-1** 是**测试 helper 的实现限制**（`zeroAll()` 没清 `retiredRootRecords` / `nextRegId`）；
    **INFO-3** 是**断言的证据归属限制**（`return ret;` 未绑定具体方法）。
    报告：[REVIEW.md](../_diag-toplock/rv-r5.2-fixture-20261004-final/REVIEW.md)（**冻件，只读**）。
  - **两组是不同范围**（前者是测试套件，后者是浏览器夹具），
    **都不解决 15.16.3 登记的新缺陷**，**都不等于 GUI 通过**。
    **本节不重开实现轮，也不改 `REVIEW.md` / `freeze.md`。**
- **本次文档更新改变了活 README / 1003 的字节**，
  所以 r5.1 冻结清单
  [`G:\mmx-project\fix mmx\_diag-toplock\r5.1-f1-20261004-final\post-SHA256.txt`](../_diag-toplock/r5.1-f1-20261004-final/post-SHA256.txt)
  里那 **9 项**的**活文档两项**必然不再匹配，
  「全部文档仍 9/9」这句话**从此以后不再成立**。
  **七个源文件仍逐字节匹配，旧清单本身不可改**（它是 r5.1 的历史证据）。
- **当前工具表里没有 `mcp__node_repl__js`**，所以**不能**用 shell 起 websocket /
  Playwright / CDP 去**替代**真实验证——那只会把「未测」伪装成「测了」。
- **真实加载需要专门授权**；`pinned-items-order` 基线 **29 vs 27** 的裁决
  （`1003.md` §14.23，本 README 历节写作「§14.23」即指此处）**仍未解除**，**不采新基线**。
- **不启动** daemon / watchdog，**不改** DB / asar，**不 deploy**。
- **本节不授予任何新的 host 写能力。**

> 本节位置：插在 **§16 之前**，与 §15.13 / §15.14 / §15.15 同一位置，属既有惯例。

#### 15.16.8 2026-10-05 修复批次：已修（离线），**未部署、未生效**

> 本小节**只追加**，不改写 §15.16.1–§15.16.7 的任何一行。
> **§15.16 的标题、§0 第 3 条、§15.16.7 交付门里的「代码未修」，是 2026-10-04 那一轮的历史事实，逐字保留、不追改；
> 自本小节起，当前状态以本小节为准。**
> 配套证据坐标、验收明细、5 个改动文件的 SHA256 在
> [1003.md §14.30.10](../1003.md)。
>
> **本小节不解除任何一道交付门、不授予任何 host 写能力**——§15.16.7 的门逐条仍然成立。

**修了什么（三处，全部离线）**

1. **`bucketFor` 判据顺序**（`src/lib/status-db.mjs:118-127`）——让**当前状态**先判、补充字段后判：
   `live error` → `running` → `paused` → `aborted`（`includeAborted` 才 `paused`）→
   `idle + completed` → `terminalOutcome='failed'` → `error_message` → `idle`。
   据此：§15.16.3 表 **1 / 3 / 5 / 6 四种误红已修**；表 **7 / 8 的基础策略保留红**（**不是**改掉它们）；
   表 **9** 的 overlay 豁免**不变**；表 **10** 的 `unknown` 边界**不变**。
2. **A11 汇总去重**（`page-script.mjs` `apply()` 内新增 `seenForSummary`，`:795` 建集、`:864-868` 判定）：
   `runningOnScreen` / `waitingOnScreen` 按**唯一 session id** 计数；
   `stats.rows` **仍按行**（未动）；**云端不拆分**（不按 `fromCloud` 分流，云端 running 进同一个数）。
3. **UI 语义（A9 / A10 的静态部分）**：
   `ensureDot()`（`:251-270`）加 `role="img"` 与**静态中文** `aria-label` / `title`
   （文案表 `DOT_SEMANTIC` 在 `:239-245`；`waiting` ＝**有子代理在运行**，**不是**「等待审批」）；
   汇总条加 `role="group"` 与**静态** `title` / `aria-label` 图例（`:306-312`），
   **不改 children、不改计数文案、不改插入位置**。
   **CSS 后代染色、排序、overlay、TTL 均未动。**

**测试证据（离线）**

| 套件 | 断言 | 相对本轮改动前 |
|---|---|---|
| `selftest` | **133 / 0 FAIL** | **+17**；原有 12 条断言**一条未动** |
| `test-waiting-bucket` | **72 / 0** | **+26** |
| `test-pinned-lifecycle` | **107 / 0** | **+34**（含 §8 出厂引导） |
| `test-cloud-bucket` | **127 / 0** | 不变（回归） |
| `test-reorder-pinned` | **50 / 0** | 不变（回归） |
| `test-top-lock` | **428 / 0** | 不变（回归） |
| `test-topmost-diag` | **146 / 0** | 不变（回归） |
| `test-topmost-menu` | **623 / 0** | 不变（回归） |
| structural-gates | **全绿** | 不变（回归） |

- **先红后绿（TDD）**：在**旧代码**上先拿到红——`selftest` **123 / 10 FAIL**、
  `test-waiting-bucket` **61 / 11 FAIL**、`test-pinned-lifecycle` **85 / 20 FAIL**。
- **变异**：`run-mutations` **87 / 87 正常红**，与改前基线**逐字节一致**；
  唯一变化是 lifecycle 的**基线断言数 73 → 105**（当时），其后**再加 2 条 → 107**。
- **变异抽验**（人工回退后必须红、且全部**逐字节还原**）：
  **M1** 回退 `bucketFor` 判据顺序 → **11 + 11 红**；**M2** 删去重 → **4 红**；
  **M3** 改 `waiting` 文案 → **1 红**（据此补强断言）；**M4** 删 summary `role` → **2 红**；
  **M5** 新 dot 缺标签 → **7 红**。

**状态声明**

- **代码已修（离线）；未部署；未在真实宿主生效。**
  页面脚本是**静态 ESM `import` 注入**的（机制见 §15.16.6），
  **磁盘新字节要被真实加载，必须由 daemon 进程重新载入模块**——那是**专门授权**，**本轮未批**。
- **GUI 未测**：工具表里仍**没有 `mcp__node_repl__js`**，也没有用 shell / Playwright / CDP 去顶替真实验证。
- `pinned-items-order` 基线 **29 vs 27** 的裁决（1003.md §14.23）**仍未解除**，**不采新基线**。
- **未做 git 写**（无 commit / push / checkout / stash）。
- §15.16 标题与 §0 第 3 条的「代码未修」自本小节起**不再描述当前状态**；
  它们描述的是 2026-10-04 那一轮，**保留是为了不篡改历史，不是现状声明**。

> 本小节位置：插在 **§16 之前**，与 §15.13 / §15.14 / §15.15 / §15.16 同一位置，属既有惯例。
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
    ├── test-cloud-bucket.mjs    127 项：云端状态点全套 + 倒序重放回归锁 + attribute observer 锁 + pinned-more 截断恢复锁（见 15.7 / 8.4 / 8.5）
    ├── watchdog-selftest.mjs    83 项自测（含启动器握手 8 条）
    ├── test-autofix-gates.mjs   --fix-app 三闸门测试（32 项，每闸门正例+反例）
    ├── test-reorder-defaults.mjs reorder 默认值 / 逃生舱 / 启动器参数构造 / 杀旧 daemon 筛选（40 项）
    ├── test-waiting-bucket.mjs  waiting 判据 / overlay 优先级锁（含陈旧 error 让位） / kind 过滤回归锁 / 页面侧样式与置顶（52 项，见 15.6）
    ├── test-reorder-pinned.mjs  50 项：置顶区零搬移（含 15 层深） / 变更检测无缓存键 / 嵌套根多轮收敛 / 预算原子性（切片出厂代码 + 假 DOM，见 15.5）
    ├── test-topmost-menu.mjs   162 项：「到最顶」能力解析 / 真实行内 Dropdown 拓扑 / 当前半边 fiber / 菜单归属 / 键盘（Space preventDefault、Enter 不挡、方向键不接管）/ 关菜单 / 可见浮层 / 代次失效 / session 快照复核 / 显式 (id,true,0) / 竞态与 fail closed（切片出厂代码 + 假 fiber，见 15.8）
    ├── test-pinned-lifecycle.mjs 73 项：汇总条位置 / 截断按钮作用域 / 记忆与 restore 共用一个分类器 / 展开逃生控件 / dispose（含代次失效与诊断拆除）/ debounce（切片出厂代码 + 假 DOM，见 15.8）
    ├── test-topmost-diag.mjs  144 项：最小主证探针 nomenu/nopopup 记在工厂 return 点 / 三次上限与 0-8-16 窗口 / earlyStop 链级 / 快照清理不被 reap 早退挡住 / root 40 与 256 分开 / 镜像路径未编译 / 出厂契约未动（切片出厂代码 + 假 fiber，见 15.9）
    ├── run-mutations.mjs        把上面四个套件的 31 个变异全跑一遍，打印红/绿矩阵；**有变异没变红、或让套件崩溃，就退出码 1**
    ├── testlib/
    │   └── fake-dom.mjs        三个新套件共用的假 DOM（属性选择器 / className / isConnected / textContent 聚合 / 可控定时器 / 假 fiber）
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
| 切云端再回本地，置顶区缩回 6 条 + 「更多」 | 8.5（pinned-more 展开记忆：localStorage 记住真实点击，重挂后自动点开） |
| 子 agent 在跑但行不黄（反而红点） | 15.6（陈旧 error_message 让位于活子代理；`waitingOnScreen` 应 ≥1） |
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
