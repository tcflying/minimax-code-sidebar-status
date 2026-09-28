# 05 · 三个真 Bug 复盘

三个都是**真实测试逼出来的**，不是代码审查发现的。
每一个都有一句可复用的判据。

---

## Bug 1 · `dispose()` 报成功，但点自己长回来了

### 现象

```
[mmx-status] 页面还原结果: {"ok":true,"removed":80}
```

5 秒后 `capture.mjs` 仍数到 **80 个点**，且 15 秒内数量纹丝不动。

同时：
- `window.__mmxStatus` 已 `delete`（`installed: false`）
- `<style id="mmx-status-style">` 已移除（`styleInjected: false`）
- 强制删除后归零且**不再复活**

### 定位：先区分"惰性残留"和"仍在重绘"

写了个探针，间隔 3 秒 / 6 秒 / 6 秒数三次：

```
T0:   dotCount=80  api=false  style=false
+3s:  dotCount=80  api=false  style=false
+6s:  dotCount=80  api=false  style=false
+6s:  dotCount=80  api=false  style=false
forced removal: {"removed":80,"left":0}
after forced +5s: dotCount=0
```

**数量纹丝不动 + 强制删除后归零不再来** ⇒ 是**惰性残留**，不是还在重绘。

### 真凶

```
MutationObserver 回调
        ↓
scheduleApply()  →  requestAnimationFrame(...)     ← 已排队
        ↓
dispose() 跑完：disconnect / clearInterval / 删 80 个 / 报 removed:80
        ↓
那个【已排队】的 rAF 才触发 → apply() → 又把 80 个点画回去
        ↓
interval 已清、observer 已断，没人再刷 → 冻结在 80
```

### 修法三件套

```js
var disposed = false;
var rafId = 0;

function apply() {
  if (disposed) return { skipped: 'disposed' };        // ①
  ...
}
function scheduleApply() {
  if (disposed || pending) return;                      // ①
  rafId = requestAnimationFrame(function () {
    pending = false; rafId = 0;
    if (disposed) return;                               // ①
    ...
  });
}
dispose: function () {
  disposed = true;                                      // ② 必须最先
  observer.disconnect();
  clearInterval(timer);
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }// ③
  ...
}
```

### selftest 回归断言

```js
check('apply() 有 disposed 早退守卫', /function apply\(\)\s*\{\s*if \(disposed\)/.test(boot));
check('scheduleApply() 有 disposed 早退守卫', /function scheduleApply\(\)\s*\{\s*if \(disposed/.test(boot));
check('dispose 先置 disposed 再清理', boot.indexOf('disposed = true;') < boot.indexOf('dots[i].remove()'));
check('dispose 取消未决的 requestAnimationFrame', boot.includes('cancelAnimationFrame(rafId)'));
```

### 通用判据

> **凡是"清理函数返回成功但现场没变干净"，第一嫌疑不是清理逻辑写错，
> 而是清理之后还有谁在跑。**
>
> 先写一个"隔 N 秒再数一遍"的探针区分两种情况：
> - 数量不变 + 强制删除后不再回来 ⇒ **惰性残留**，清理没删到
> - 数量在涨 ⇒ **仍在重绘**，清理后还有活着的循环

---

## Bug 2 · 冷启动三连空窗

一次冷启动连撞三堵墙，全部是时序问题。

### 墙 1：target 还没出现

```
[mmx-status] CDP 已连接: Chrome/148.0.7778.280
[mmx-status] [mmx-status] 致命错误: 未找到 MiniMax Code 的渲染进程 target。实际 target 列表：
  [page] app://./archon                     ← 其实它就在列表里！
  [page] file:///G:/.../react-screenshots/.../electron.html
```

`/json/version` 在**浏览器进程**起来就返回 200，
但 `app://./archon` 页面 target 要等**渲染进程加载完**才出现。
两者之间通常有 5~30 秒。

修法：`waitForRenderer()` 轮询 90 秒，超时才报错并把 target 列表打出来。

### 墙 2：`document.body` 还是 null

```
TypeError: Failed to execute 'observe' on 'MutationObserver':
           parameter 1 is not of type 'Node'.
    at __mmxStatusMain (<anonymous>:127:12)
```

target 出现了但 DOM 还没建完，`document.body` 是 `null`，
`observer.observe(null)` 直接抛异常，**整个 bootstrap 挂掉**。

修法：注入脚本先自旋等一个可用的挂载点（15 秒预算）：

```js
function mountPoint(timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.body) return document.body;
    if (document.documentElement) return document.documentElement;
    sleepSync(50);
  }
  return null;
}
var mount = mountPoint(15000);
if (!mount) return { ok: false, reason: 'no-document-body' };
```

`mount` 一路传给 `observer.observe(mount, ...)` 和样式挂载点。

### 墙 3：主线程忙导致求值超时

```
Error: CDP 超时: Runtime.evaluate
```

新实例正在拉上千个会话时主线程很忙，单次 `Runtime.evaluate` 可能等很久。

修法：
- CDP 发送超时 15 秒 → **30 秒**
- 新增 `evaluateWithRetry()`：3 次重试、间隔 1.5 秒

```js
async evaluateWithRetry(expression, { attempts = 3, gapMs = 1500 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await this.evaluate(expression); }
    catch (e) { last = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, gapMs)); }
  }
  throw last;
}
```

### 通用判据

> **异步系统的"目标已就绪"和"能力可用"是两件事。**
> CDP 端口开了 ≠ target 有了 ≠ DOM 建好了 ≠ 主线程空了。
> 每一层都要单独探测、单独等待。

---

## Bug 3 · 启动器一跑就炸（而且我漏测了它）

### 现象

```
start-mmx-status.ps1: 
  术语 'Write-NoNewline' 不会被识别为 cmdlet、函数、脚本文件或可执行程序的名称。
```

`Write-NoNewline` 这个 cmdlet **根本不存在**，应为 `Write-Host -NoNewline`。
用户第一次敲这个命令就会报错。

### 为什么漏了

我测试了 `daemon.mjs`、`selftest.mjs`、`e2e.mjs`，
**唯独没测 `start-mmx-status.ps1`**——而那是用户唯一要用的入口。

### 同一批抓到的另外两个

**空格路径被切断**：

```
Error: Cannot find module 'G:\mmx-project\fix'
```

工作区路径 `G:\mmx-project\fix mmx\` 含空格，
`Start-Process -ArgumentList` 把数组元素**用空格拼成一条命令行**，
在 `G:\mmx-project\fix` 处断成两截。

修法：`-File` 的值手工包一层引号 `'"' + $path + '"'`。

**顺手暴露的第二个同类错误**：我修了这个一次性调用，却**没修脚本内部同样的写法**，
结果脚本跑起来守护进程依然起不来（`MODULE_NOT_FOUND` 指向同一个截断）。
**同类错误要一次改干净，不能只改你眼前那处。**

### 通用判据

> **只测内层不测入口，等于用内层的绿担保用户的体验。**
> 入口（CLI / 脚本 / API 表面）必须单独测，且要覆盖失败路径。
>
> 另：`Start-Process` 返回了 PID ≠ 进程真的活着。
> 必须在 5~8 秒后回读它的 `.out` / `.err`，确认有输出、进程仍在。

---

## Bug 4（附）· 反引号截断模板字符串

### 现象

```
file:///.../lib/page-script.mjs:187
  // `userExpanded` is sticky: once the user has explicitly expanded a group we
      ^^^^
SyntaxError: Unexpected identifier 'userExpanded'
```

页面侧代码用 `String.raw` 模板承载，我在注释里写了反引号包裹的标识符，
**反引号直接终止模板字符串**，整个模块语法错误。

### 这个错我犯了三次

### 现在的硬检查

```js
const src = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
const rawSeg = src.slice(src.indexOf('const PAGE_FN = String.raw'),
                         src.indexOf('export function buildBootstrapExpression'));
const tickCount = (rawSeg.match(/`/g) || []).length;
check('PAGE_FN 模板内反引号恰为 2 个（开+闭）', tickCount === 2, `实际 ${tickCount} 个`);
```

### 同族

- `node e2e.mjs` 首行写 `# 注释`（只有 `#!` 是 shebang）也是 SyntaxError
- `node -e` 嵌在 PowerShell 字符串里，`\n` 不会转义成换行而是字面量，
  导致 `SyntaxError: Invalid or unexpected token`

### 通用判据

> **模板字符串体内出现反引号，一律当语法错误处理。**
> 靠 `import` 该模块的测试立刻能暴露，不需要另写 lint。
