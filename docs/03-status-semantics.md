# 03 · 状态语义与真实数据

## 数据来源

`~/.minimax/v2/sqlite/runtime-state.sqlite`（本机约 1.2 GB）

打开方式（只读，关键）：

```js
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(dbPath, { readOnly: true });
```

`readOnly: true` 走 `SQLITE_OPEN_READONLY`。
用普通模式打开会被运行中的客户端锁住——这也是上游 issue #282 报告的
`SQLITE_BUSY` 问题的同一类根因。

## 表结构

### `local_runtime_sessions`

| 列 | 类型 | 说明 |
|---|---|---|
| `session_id` | text PK | **就是侧边栏 `data-session-id` 的值** |
| `status` | text | `idle` / `started` / `error` / `aborted` / `interrupted` |
| `error_message` | text | 错误详情；注意 `aborted` 会话这里也写 `"aborted"`，**不是错误** |
| `error_code` | int | |
| `archived` | int | 归档标记，查询要带 `archived = 0` |
| `parent_session_id` | text | 父会话；**子代理在这里挂树** |
| `title` / `workspace_dir` / `project_id` | | |

### `local_runtime_session_agent_state`

`terminal_outcome` ∈ `completed` / `aborted` / `failed` / `NULL`

### `local_runtime_turn_ingress`

`status` ∈ `completed` / `failed` / `aborted` / `accepted`

> **表名陷阱**：代码里 `import { turnIngress } from '.../schema/turn.js'` 的变量名是
> `turnIngress`，但真实表名是 `local_runtime_turn_ingress`。
> 我按变量名去查 `turn_ingress` 一次返回 `False`，差点得出"这张表不存在"的错误结论。

## 实测分布（本机 1527 个会话）

```
sessions.status:
  idle         1181
  aborted       168
  interrupted   112
  error          64
  started         2

terminal_outcome:
  completed     673
  aborted       149
  failed         48
  NULL          ~600

子代理（parent_session_id 非空）: 404 条
  conversation 112 / task 292
```

## 桶映射：为什么 `aborted` 不算"暂停"

需求说"黄色暂停"。但 schema 里**没有 `paused` 这个值**。
最接近的两个候选是 `interrupted` 和 `aborted`，语义完全不同：

| 值 | 含义 | 该不该标黄 |
|---|---|---|
| `interrupted` | 运行时重启导致 turn 未完成，**需要人介入** | ✅ 该 |
| `aborted` | 用户主动取消，**终态** | ❌ 不该 |

168 个 `aborted` 如果标黄，会把 112 个真正需要关注的 `interrupted` 淹掉。
所以默认只有 `interrupted` 标黄，`aborted` 用 `--show-aborted` 开关按需打开。

## 最终映射表

```js
const RUNNING     = new Set(['started']);
const INTERRUPTED = new Set(['interrupted']);
const ABORTED     = new Set(['aborted']);
const ERROR       = new Set(['error', 'failed']);

export function bucketFor({ status, terminalOutcome, hasErrorMessage, includeAborted = false }) {
  if (ERROR.has(status) || terminalOutcome === 'failed') return BUCKET.error;
  if (RUNNING.has(status)) return BUCKET.running;
  if (INTERRUPTED.has(status)) return BUCKET.paused;
  if (ABORTED.has(status)) return includeAborted ? BUCKET.paused : BUCKET.idle;
  if (hasErrorMessage) return BUCKET.error;
  if (status === 'idle' && terminalOutcome === 'completed') return BUCKET.done;
  return BUCKET.idle;
}
```

判定顺序有讲究：**error 优先于 running**。
一个会话即使 `status='started'`，只要 `outcome='failed'` 也应标红——
"正在跑但上一次已经失败"比"正在跑"更值得注意。

## `error_message` 的坑

221 条会话的 `error_message` 非空，但其中 **`aborted` 会话把它写成字符串 `"aborted"`**。
如果直接把"非空 error_message"当错误，168 个主动取消的会话会全变红。

所以要先按 `status` 分类，再看 `error_message`：

```js
const hasErrorMessage =
  !!(row.err && String(row.err).trim() && String(row.err) !== 'aborted');
```

## `done` 默认不显示

按上面的映射，`done`（idle + completed）本机有 643 条。
全打灰点会让侧边栏变成一片噪点，淹没真正重要的绿/黄/红。
默认关，`--show-done` 打开。

## snapshot 的形状

只含非 idle 的条目，减少传输量：

```js
snapshot() {
  const out = {};
  for (const [id, v] of this._map) {
    if (v.bucket !== BUCKET.idle) out[id] = v.bucket;
  }
  return out;
}
```

本机 1527 个会话里，snapshot 只带 814 条。

## selftest 里的守恒断言

```js
check('bucket 总数守恒',
  Object.values(counts).reduce((a,b) => a+b, 0) === db._map.size);
check('running 行确实都是 started',
  runningRows.every(r => r.status === 'started'));
check('refresh 幂等', db._map.size === before);
```

第一条能抓住"某个 status 值被漏掉或重复计入"的映射 bug。
