# 02 · CDP 注入：原理与实现细节

## 为什么 Electron 天然可注入

Electron = Chromium + Node。Chromium 启动时若带 `--remote-debugging-port`，
会在该端口开一个 HTTP 服务，暴露页面 target 列表，并允许 WebSocket 接入执行 CDP 指令。

MiniMax Code 的渲染进程加载的是 `app://./archon` 这个自定义 scheme，
但它仍然是普通页面，CDP 对它一视同仁。

## 握手三步

```js
// 1. HTTP：列 target
const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await res.json();

// 2. 选渲染进程
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url)
);
if (!page) throw new Error('未找到 app://./archon 渲染进程 target');

// 3. WebSocket：执行 JS
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression: '1+1', returnByValue: true },
}));
```

Node 24 里 `WebSocket` 与 `fetch` 都是全局对象，**零依赖**。

## 注入载荷的形状

页面侧代码用 `String.raw` 模板承载，末尾以 IIFE 形式求值：

```js
export function buildBootstrapExpression(cfg) {
  const full = { mark: MARK, styleId: STYLE_ID, global: GLOBAL, offsetX: 4,
                 intervalMs: 3000, showDone: false, collapseOnStart: true,
                 status: {}, ...cfg };
  return `(${PAGE_FN})(${JSON.stringify(full)})`;
}
```

`PAGE_FN` 是一个 `function __mmxStatusMain(cfg) {...}`，
在页面里调用后返回 `{ ok: true, initial: {...}, collapse: {...} }`。

## 状态怎么带进去

`Runtime.evaluate` 的 `returnByValue: true` 只回传 JSON 值，
所以数据库快照在**守护进程侧**查好，作为 `cfg.status` 一次性传进去。
页面侧只负责读这个对象和上色，不碰网络和文件系统。

刷新时走单独一条轻量表达式：

```js
(function () {
  var a = window.__mmxStatus;
  if (!a) return { ok: false, reason: 'not-installed' };
  return { ok: true, stats: a.refresh(<新的 status JSON>) };
})()
```

## 页面侧脚本的三条铁律

1. **幂等**：每个自建节点打 `data-mmx-dot` 标记，重复 bootstrap 不产生副作用。
2. **可逆**：`dispose()` 删干净所有注入节点 + 还原自己改过的内联样式。
3. **不碰宿主**：`selftest` 用正则硬查 `removeChild` / `innerHTML=` / `outerHTML=` / `document.write` / `eval(`。

## React 的对抗

侧边栏由 React 渲染，任何 re-render 都可能清掉未知子节点。
`MutationObserver` 挂在挂载点上，`childList + subtree` 全覆盖，
每次变更后 `requestAnimationFrame` 去抖重绘。

**去抖是必须的**：一轮渲染可能触发几十次 mutation，
不去抖就会几十次重绘 + 几十次 `getComputedStyle`（强制 reflow）。

## 位置与布局

圆点用绝对定位，避免撑开行的 flex 布局：

```css
[data-mmx-dot]{
  position:absolute; left:<offsetX>px; top:50%;
  transform:translateY(-50%);
  width:6px; height:6px; border-radius:9999px;
  pointer-events:none;
}
```

如果行的 `position` 是 `static`，先改 `relative`，
**并把这个行记进 `touched` 集合**——`dispose()` 时只还原这批，
绝不覆盖应用自己设的内联值。

## 颜色用应用自己的设计令牌

不用硬编码 RGB，直接引用 CSS 变量：

```css
[data-mmx-bucket="running"]{ background: var(--green_400, #22c55e); }
[data-mmx-bucket="paused"] { background: var(--orange_400, #f59e0b); }
[data-mmx-bucket="error"]  { background: var(--red_400,   #ef4444); }
[data-mmx-bucket="done"]   { background: var(--gray_400,  #9ca3af); }
```

实测渲染出的计算值：`rgb(4,181,75)` / `rgb(247,54,70)` / `rgb(148,148,148)`——
与应用原生状态环完全一致，**自动跟随明暗主题**。

## 呼吸动画

绿色（running）带一圈脉冲，静止时不喧宾夺主：

```css
[data-mmx-bucket="running"]::after{
  content:""; position:absolute; inset:-3px; border-radius:9999px;
  background:inherit; opacity:.35;
  animation:__mmxPulse 1.4s ease-in-out infinite;
}
@keyframes __mmxPulse{
  0%,100%{ transform:scale(.7);  opacity:.45 }
  50%    { transform:scale(1.25); opacity:.08 }
}
```

## 虚拟滚动的配合

侧边栏列表是虚拟化的，DOM 里只有当前渲染的行。
本机实测：数据库 1527 个会话，DOM 里只有 450 行，滚到位的行里 77 个被上色。
`MutationObserver` 保证滚动到哪补到哪。

`touched` 集合会因此增长，所以加了剪枝：超过 64 条就丢弃已脱离文档的行。

## 还原路径

```js
dispose: function () {
  disposed = true;                                  // 必须在删除之前
  observer.disconnect();
  clearInterval(timer);
  if (rafId) cancelAnimationFrame(rafId);
  var dots = document.querySelectorAll('[data-mmx-dot]');
  for (var i = 0; i < dots.length; i++) dots[i].remove();
  var st = document.getElementById(cfg.styleId);
  if (st) st.remove();
  touched.forEach(function (row) {
    if (row && row.isConnected) { row.style.position = ''; }
  });
  touched.clear();
  delete window[GLOBAL];
  return { removed: dots.length, restored: restored };
}
```

`disposed` 置位必须在删除之前——否则一个已排队的 `requestAnimationFrame`
会在删除完成后触发 `apply()` 把点全画回来（详见 `05-bugs.md` §1）。

## 安全边界

- CDP 只绑 `127.0.0.1`，不开外部端口。
- 数据库 `readOnly: true`（`SQLITE_OPEN_READONLY`），与运行中的客户端零冲突。
- 注入节点全部带 `data-mmx-dot`，一键可清。
- 不读 API Key / 聊天正文 / 账号凭据。
- 不改 `app.asar`、不改 Agent Runtime、不改权限模型。
