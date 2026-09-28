# 04 · 永不自动展开守卫

## 需求原文

> 「我是任何时候，左侧 session 都不要自动展开啊」
>
> 「我点在 session 的标题上也会展开啊！我都不要展开！！！！」

**最终口径：任何展开都不允许，一例不留。**

---

## 一、这是应用的行为，不是工具造成的

### 证据 1：受控对照实验

```
记录展开状态 → 移除全部注入 → 再读展开状态
```

结果：**展开状态逐字节一致**。本工具不参与展开。

### 证据 2：源码

渲染层 `out/_next/static/chunks/app/(pages)/(mavis)/archon/page-*.js`：

```js
// 展开状态来自一个 state map，默认折叠
expanded: s[t.id] ?? !1

// 箭头旋转由展开态决定
className: `text-icon_default_primary transition-transform ${a ? "" : "-rotate-90"}`

// 应用自己还带强制折叠逻辑 —— 说明展开折叠都归它管
td = !1 === eJ || eV || !tc;
useEffect(() => { td && tr(!1) }, [td]);
```

### 证据 3：真实点击实测（CDP 派发真实鼠标事件）

| 触发方式 | 是否展开 |
|---|---|
| 应用自动（会话有运行中子代理时） | **会** |
| 点行主体 | **会** |
| 点标题 | **会** |
| 点箭头 | **会** |

> **更正**：早期版本我写过"点行主体不会展开"的结论，那是基于坐标错误的测试（见 §4），
> 结论是错的，向用户更正过。

---

## 二、展开规则的判定信号

箭头元素带 `transition-transform` 类，`-rotate-90` 表示折叠：

```js
function caretOf(el) {
  return el.querySelector('[class*="transition-transform"]');
}
function isExpanded(el) {
  var c = caretOf(el);
  if (!c) return false;
  return String(c.getAttribute('class') || '').indexOf('-rotate-90') < 0;
}
```

实测行高也能佐证：折叠 = 30px，展开 3 行 = 90px，展开 5 行 = 152px。

---

## 三、实现

```js
function clickCaret(el) {
  var c = caretOf(el);
  if (!c) return false;
  var btn = c.closest('button,[role="button"]') || c.parentElement;
  if (!btn || typeof btn.click !== 'function') return false;
  btn.click();
  return true;
}

function enforceNoAutoExpand() {
  if (!cfg.collapseOnStart) return { collapsed: 0, skipped: 'disabled' };
  var sec = document.querySelector('[data-pinned-section]');
  if (!sec) return { collapsed: 0, reason: 'no-pinned-section' };
  var rows = sec.querySelectorAll('[data-session-id]');
  var collapsed = 0;
  for (var i = 0; i < rows.length; i++) {
    var el = rows[i];
    if (!caretOf(el)) continue;
    if (!isExpanded(el)) continue;
    if (el.getBoundingClientRect().height <= 40) continue;   // 已折叠
    if (clickCaret(el)) collapsed++;
  }
  return { collapsed: collapsed };
}
```

### 与上色同批执行

这是"看不出闪烁"的关键——两个动作在**同一帧内**完成：

```js
rafId = requestAnimationFrame(function () {
  pending = false; rafId = 0;
  if (disposed) return;
  try {
    apply();                        // ① 上色
    api.enforceNoAutoExpand();       // ② 顺带压回任何展开
  } catch (e) { /* 绝不弄坏宿主应用 */ }
});
```

### 三层触发

| 触发 | 时机 |
|---|---|
| `MutationObserver` | React 改了 DOM（含展开） |
| 页面内 `setInterval`（3 秒） | 兜底 |
| 守护进程轮询（2.5 秒） | 数据库状态变化时重绘并顺带压回 |

### 没有例外

早期版本有个 `userExpanded` 集合：用户主动点箭头展开的会话**永久不压回**，
怕"和用户抢控制权"。

实测证明这不成立——**连用户主动点标题都会被应用展开**，
所以"用户主动的"这个豁免没有意义。现在**无条件压回**。

想恢复应用原本行为：`--no-collapse`。

---

## 四、测试陷阱：假 PASS

这一节是本文档最有价值的部分。

### 现象

用 CDP `Input.dispatchMouseEvent` 派发真实点击做验证，第一版直接报 PASS：

```
=== 真实点击【标题】@94,317 ===
  +400ms: expanded=false h=30   <-- 已折叠
PASS：真实点击标题和箭头之后，置顶区没有任何展开项。
```

### 真相

第二次做因果对照（只变守卫开关）时：

```
[守卫开启] +300ms=EXPANDED(h120) +900ms=EXPANDED(h120) +2000ms=EXPANDED(h120) => 展开
```

**守卫开着也展开。** 说明第一次的 PASS 是假的。

用 `debug-guard.mjs` 打印点击坐标：

```
真实点击标题 @ 60 0        ← y = 0
```

**元素没有 `scrollIntoView`，`getBoundingClientRect()` 返回 y=0，
点击落在视口外的空气里，什么都没发生，于是"不展开"。**

### 修正

```js
el.scrollIntoView({ block: 'center' });   // ① 先滚进视口
await sleep(600);
const r = el.getBoundingClientRect();      // ② 再取坐标
// ③ 断言坐标合法，否则跳过而不是假装通过
if (box.titleY <= 0 || box.titleY >= box.vh) {
  console.log('坐标仍在视口外，跳过');
  return null;
}
await realClick(box.titleX, box.titleY);
```

### 修正后的因果对照（决定性证据）

```
[守卫关闭] +300ms=EXPANDED(h120) +900ms=EXPANDED(h120) +2000ms=EXPANDED(h120) => 展开
[守卫开启] +300ms=collapsed(h30)  +900ms=collapsed(h30)  +2000ms=collapsed(h30)  => 折叠
```

**同一处真实点击，只变守卫开关，结论可信。**

### 通用纪律

> **任何点击类验证必须三步**：
> ① 滚进视口 ② 断言坐标合法 ③ 判定"没变化"时先确认动作真的发出去了。
>
> "点了没反应"和"点了没效果"是两回事。
> 我连续两次栽在这个坑里，第一次还据此向用户报了 PASS。

---

## 五、调试工具

### `debug-guard.mjs` —— 分清"没被调用"和"调用了没压住"

```js
// 包一层计数器
const orig = a.enforceNoAutoExpand;
a.__calls = 0;
a.enforceNoAutoExpand = function () {
  a.__calls++;
  return orig.apply(this, arguments);
};
```

打印：守卫被调用几次、每次返回什么、手动再调一次会怎样。
一眼能分清是哪一半坏了。

### `diagnose-expand-owner.mjs` —— 归因

打印 localStorage 里所有侧边栏相关键 + 每一行的箭头 class 与行高：

```
{"id":"mvs_374168...","expanded":true,"height":90}
{"id":"mvs_e2a56e...","expanded":false,"height":30}
```

由此发现的 `mavis:sidebar:collapsedProjectGroups:v1` 键说明应用确实持久化了
**项目分组**的折叠状态——但**置顶会话的子代理树没有对应的持久化键**，
所以每次加载都会重新推导。

### `diagnose-collapse-stick.mjs` —— 手动折叠能不能粘住

```
点击结果: {"ok":true}
  +800ms:  expanded=false height=30  <-- 保持折叠
  +3000ms: expanded=false height=30  <-- 保持折叠
  +6000ms: expanded=false height=30  <-- 保持折叠
```

**手动折叠是能粘住的**（即使子代理还在跑）。这条本身也说明应用不是"死顶着要展开"，
所以持续压回不会和用户产生不可调和的对抗。
