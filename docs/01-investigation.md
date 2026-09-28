# 01 · 完整调查记录

> 这份文档记录"怎么找到答案"的完整过程，包括两次走错的弯路。
> 方法论价值高于结论本身。

## 调查起点

需求三条：

1. 侧边栏会话看不到运行状态，想用颜色区分（绿/黄/红）
2. 想知道侧边栏什么情况下会自动展开
3. （后期追加）任何时候都不要自动展开

约束：**不能改 MiniMax Code 本体**。

---

## 第一轮：官方文档 + 官方仓 issue（不够）

### 查了哪些

- `https://agent.minimaxi.com/docs/llms.txt` → 索引 → 逐页读
  `code/agents/plugins.md` / `code/desktop/panels.md` / `code/workflows/tasks.md`
  / `code/automation/remote-control.md` / `cli/integrations.md`
- GitHub `MiniMax-AI/minimax-code` issue 区

### 查到什么

| 检索词 | 结果 |
|---|---|
| `sidebar` | 3 条（#292 定时任务运行模式 / #105 微信二维码 / #29 日常小建议） |
| `auto expand` / `auto-expand` | **NO_HITS** |
| `status indicator` / `running status` | 2 条，都是 TUI 自动滚动 |
| `session status` / `task indicator` / `child session` | **NO_HITS** |
| `subagent` | 15 条，全是并发调度 / 后台执行 / 黑板插件 |

**结论**：上游没人提过这个需求，也没人做。

### 查漏了什么（关键失误）

**只搜了官方仓的 issue 区，没做 `gh search repos` 全局仓库搜索。**

这一条直接导致我在第二轮给出了一个**错误的否定结论**。

---

## 第二轮：反编译 app.asar（关键突破）

### 解包索引

`app.asar` 头部 JSON 索引，531,928,215 字节 / 46,859 个文件。解法见 README §2.1。

### 字符串扫描

| 搜索词 | 命中 | 我的解读 |
|---|---|---|
| `autoExpand` / `expandOnStart` / `expandOnStart` | **0** | "自动展开功能不存在" |
| `sidebarStatus` / `statusDot` / `runningDot` | **0** | "没有状态点" |
| `data-session-id` | 2 | ✅ 侧边栏会话行锚点 |
| `statusConditions` | 1 | ✅ 数据层三态 |
| `local-plugin-hooks.md` | 1 | ✅ 官方 hook 能力边界 |
| `hasRunningChild` | 多 | ⚠️ 后来发现是真相所在 |
| `local-plugin-hooks.md` 所在目录 | — | 包内自带官方文档 |

### 我在这里犯的第一个方法论错误

看到 `autoExpand` / `expandOnStart` 全 0 命中，我直接下了结论
"自动展开这个行为在代码里根本不存在"。

**这是错的推理**。字符串扫描只能证明"没有这个字面量"，
不能证明"没有这个行为"——行为完全可能用别的名字实现。

**正确纪律**：命中 0 只能作为线索，**要下结论必须打开对应源文件逐行读上下文**。
本项目里 `statusDot` 命中 0 次，但状态点功能是我自己做出来的。

### 读源码后拿到的真东西

**数据层** `service/session-system/projects/sidebar/predicate.ts`：

```ts
const statusConditions: Record<string, SQL> = {
  working: eq(s.status, 'started'),
  done: isDone,
  unread: membership(s.sessionId, q.unreadIds),
};
```

**渲染层** `out/_next/static/chunks/app/(pages)/(mavis)/archon/page-*.js`：

```js
P("statuses", t("sidebar.filter_status"), M(["working","done","unread"]))
// 持久化在 localStorage['mavis.sidebarFilters.' + source]
```

**已存在的状态环**（Agent 行，不是会话行）：

```js
function ed(e) {
  let {agent:t, displayName:n, hasUnread:r=!1, hasError:i=!1} = e,
      s = i ? "outline-icon_status_error" : r ? "outline-bg_interaction_accent_focus_blue" : null;
  ...
}
```

**已存在的三色点**（定时任务行，不是会话行）：

```js
G = {
  idle:    "bg-bg_default_tertiary",
  running: "bg-bg_interaction_accent_focus_blue animate-pulse",
  skipped: "bg-bg_interaction_warning_default",
}
```

**官方 hook 能力边界**（包内 `plugin-creator/references/local-plugin-hooks.md`）：

事件全集 12 个，handler **只能 `type: "command"`**，
文档原文 *"Desktop sidebar switching alone does not start or end a Hook session."*

### 结论

会话行没有状态点 → 需要注入；
插件四类能力（Skill / MCP / Hook / Connector）**零 UI 扩展点** → 插件路线不通。

---

## 第三轮：补做全局搜索（自我更正）

用户质疑"网络上搜索过了吗以及 gh 别人开发的"。**这个质疑是对的**，我第一轮确实没做。

### `gh search repos` 结果（关键发现）

```
sqing33/minimax-code-skin   "非官方 MiniMax Code 桌面端可逆视觉工具"
```

**这个项目走的就是 CDP 路线**：
- `--remote-debugging-port=9351 --remote-debugging-address=127.0.0.1`
- 找 url 匹配 `app://./archon` 的 page target
- WebSocket + `Runtime.evaluate` 注入
- README 自称 *"不修改 MiniMax Code 的 app.asar、Agent Runtime、权限或业务逻辑"*

### 但它不能直接抄

拿真 asar 复核它的选择器：

| 它依赖的选择器 | 真实 asar 命中 |
|---|---|
| `data-agent-type` | **0** |
| `data-agent-kind` | **0** |
| `data-session-type` | **0** |
| `data-tooltip-content` | **0** |
| `role="treeitem"` | **0** |
| `data-conversation-id` | **0** |
| `sidebar-project-filter-trigger` | ✅ 命中 |
| `sidebar-session-group-menu` | ✅ 命中 |
| `plus-menu-project-item` | ✅ 命中 |
| `project-selector-clear` | ✅ 命中 |
| `mavis-sidebar-filter-popup` | ✅ 命中 |

它的**排除列表**选择器全部命中真 DOM（说明作者真研究过包），
但 **subagent 识别的 key 全部 0 命中**，
且 `tests/fixtures/minimax-code-dom.ts` 里的
`class="session-item subagent-session" data-agent-type="subagent"` 是**编造的**。
README 也自承 *"当前版本尚未连接真实 MiniMax Code 做最终 UI 注入验收"*。

**结论**：路线可借鉴，代码不能抄。本项目改走 `data-session-id` + SQLite 直查。

### 同时查清了"置顶区为什么过滤不了"

渲染层 `page-*.js`：

```js
{"data-pinned-section": !0, children: ... t("sidebar.section_pinned") ...}
```

置顶是**独立 section**，由父组件传入独立 pinned 数组渲染，
**不走** `sidebarPredicate(q)` 的 `q.statuses`。
筛选菜单里另有 `filter_group_by`（`view_mode_projects` / `view_mode_recents`）也只作用于下方列表区。

**结论：内置状态筛选器结构性不覆盖置顶区，没有设置能改。**

---

## 第四轮：确认 CDP 可行

先确认客户端没有屏蔽：

| 搜索词 | asar 命中 |
|---|---|
| `remote-debugging-port` | 0 |
| `remote-debugging-address` | 0 |
| `remoteDebuggingPort` | 0 |
| `debuggerPort` | 0 |
| `commandLine.removeSwitch(...)` 涉及 remote | 0 |

只有 `gpu-guard.js` 里有无关的 `appendSwitch('disable-gpu')`。

**实测启动**（第二个实例，独立 `user-data-dir`）：

```json
{ "Browser": "Chrome/148.0.7778.280",
  "User-Agent": "... MiniMax/3.0.74 Chrome/148.0.7778.280 Electron/42.8.0 ..." }
```

`/json/list` 里有 `page  app://./archon`。**CDP 握手 0ms 完成。**

---

## 调查方法论总结

1. **官方文档查不到的东西，要去应用包里挖。** Electron 应用的 `app.asar` 是最权威的信源。
2. **字符串命中只能定位候选，不能下结论。** 命中 0 尤其危险——要打开源文件确认。
3. **只搜 issue 区不够，要做全局仓库搜索。** 我因此漏掉了唯一可行的第三方先例。
4. **第三方代码要逐个选择器复核。** 区分"研究过真包"和"照 fixture 写"两类，
   既不要整仓信任也不要整仓否定。
5. **不存在的功能先查"扩展能力边界"，而不是急着否定。**
   本项目里插件四类能力的边界写在包内自带文档里，是决定性证据。
