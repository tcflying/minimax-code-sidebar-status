# 06 · 测试体系与假 PASS 陷阱

## 三套测试

```
node selftest.mjs                              41 项 · 不需要 CDP
node e2e.mjs --port 9351                       18 项 · 需要已开 CDP 的实例
pwsh -NoProfile -File test-launcher.ps1        20 项 · 自建一次性实例
```

### `selftest.mjs` —— 静态 + 数据层

| 分组 | 内容 |
|---|---|
| 桶映射 | 9 条，含 `aborted` 默认不点亮 / `--show-aborted` 才点亮 |
| 真实数据库 | 只读读取、总数守恒、running 行确实是 `started`、refresh 幂等 |
| 注入表达式 | 语法合法（`new Function`）、无破坏性 DOM 调用、锚点存在、dispose 回归 |
| 模板卫生 | 反引号计数、游离反引号、backtick 包裹的注释 |

不需要任何外部依赖，纯 `node selftest.mjs` 即可跑。

### `e2e.mjs` —— 真实渲染进程闭环

对着**真的** `app://./archon` 渲染进程：

1. 等侧边栏渲染完成（最多 60 秒）
2. 注入 → 断言有 dots、API 已安装、样式已注入
3. 刷新 → 从页面取**实际渲染的** id 删掉 → 断言恰好少 1、`removed === 1`
4. 停止 → 断言归零 / API 已卸载 / 样式已移除 / 内联 position 已还原
5. **等 10 秒断言仍为 0**（rAF 复活回归）
6. 二次注入 → 断言幂等 → 再归零

第 5 步是整个项目最重要的一条断言，对应 `05-bugs.md` §1。

### `test-launcher.ps1` —— 入口

**自建一次性实例**（独立 `user-data-dir` + 独立端口 9355），
**全程不碰用户主实例**：

| 分支 | 断言 |
|---|---|
| `-DryRun` | 打印 exe / CDP 参数 / daemon 命令，且什么都没启动 |
| 冷启动 | CDP 已开但渲染进程未加载时，daemon 自己等到 target |
| 停止 | 没装任何东西时 stop 也安全退出 |

末尾断言主实例进程数 ≥ 1，防止测试误杀用户窗口。

> 修 bug 时它抓到一个真问题：`stop-mmx-status.ps1` **不看端口**，
> 会杀掉所有 `daemon.mjs`，测试用 9355 跑时误杀了 9351 的守护。
> 已改成只杀本端口，并提示"另有 N 个守护进程服务其它端口，未触碰"。

---

## 假 PASS 陷阱（本项目踩过三次）

### 陷阱一：点击坐标是 (x, 0)

**现象**：用 CDP `Input.dispatchMouseEvent` 派发真实点击，报告"点标题不展开，PASS"。

**真相**：
```
真实点击标题 @ 60 0        ← y = 0
```
没 `scrollIntoView`，元素没布局，点击落在视口外的空气里，**什么都没发生**。
"没发生"被当成了"被守卫挡住了"。

**修正**：
```js
el.scrollIntoView({ block: 'center' });
await sleep(600);
const r = el.getBoundingClientRect();
if (r.y <= 0 || r.bottom >= innerHeight) {   // 坐标非法就跳过
  console.log('坐标仍在视口外，跳过');
  return null;
}
await realClick(x, y);
```

**判据**：
> 任何点击类验证必须三步：**① 滚进视口 ② 断言坐标合法 ③ 判定"没变化"时先确认动作真的发出去了。**
>
> "点了没反应"和"点了没效果"是两回事。

### 陷阱二：只测内层不测入口

`daemon.mjs` 全绿，但用户唯一要用的 `start-mmx-status.ps1` 一跑就炸
（`Write-NoNewline` 这个 cmdlet 不存在）。

**判据**：
> 只测内层不测入口，等于用内层的绿担保用户的体验。
> 入口必须单独测，且要覆盖失败路径。

### 陷阱三：静态扫描当下结论

扫 asar 得到 `autoExpand` / `expandOnStart` / `sidebarStatus` / `statusDot` **全 0 命中**，
我据此说"自动展开功能不存在"。

**真相**：这些字面量确实不存在，但**行为存在**——它用别的名字实现
（`expandedSessionIds` + `hasRunningChild`）。

**判据**：
> 静态扫描只能**定位候选**，不能**下结论**。
> 命中 0 尤其危险——只能说明"没这个字面量"，不能说明"没这个行为"。
> 要下结论必须打开对应源文件逐行读上下文。

---

## 反向对照：证明"是我的改动在起作用"

正向测试（"点了没展开"）不足以证明因果。必须做**只变一个变量的反向对照**。

本项目的正确做法（`verify-guard-causal3.mjs`）：

```
[守卫关闭] +300ms=EXPANDED(h120) +900ms=EXPANDED(h120) +2000ms=EXPANDED(h120) => 展开
[守卫开启] +300ms=collapsed(h30)  +900ms=collapsed(h30)  +2000ms=collapsed(h30)  => 折叠
```

同一处真实点击、同一目标会话、只变守卫开关 ⇒ **守卫确实是起作用的那个**。

**判据**：
> 任何"我加的守卫有效 / 我加的检测有效"类结论，
> 必须有一组**只变这一个变量**的对照，否则你分不清是守卫的功劳还是巧合。

---

## 测试代码本身要能失败

几个让测试"真的会红"的设计：

```js
// 表达式语法检查
new Function('return (' + expression + ');');

// 破坏性 DOM 调用黑名单
const DESTRUCTIVE = [/\.removeChild\(/, /\.innerHTML\s*=/, /\.outerHTML\s*=/,
                     /document\.write/, /eval\(/];

// 模板反引号计数
check('PAGE_FN 模板内反引号恰为 2 个', tickCount === 2);

// dispose 顺序
check('dispose 先置 disposed 再清理',
      boot.indexOf('disposed = true;') < boot.indexOf('dots[i].remove()'));
```

另外 `selftest.mjs` 会 **import 所有模块**，
所以一个多余的反引号 / 一个 `#` 注释会立刻变成 SyntaxError 暴露出来，
不需要另写 lint。

---

## 变异验证

改完关键逻辑后，**先手动把修复改坏，确认测试会红，再改回来**。

本项目在 `dispose` 加 disposed 守卫后做过一次：
把 `disposed = true;` 挪到删除之后 → e2e 第 5 步立刻红。

这比"测试全绿"更有说服力——它证明测试真的在测那件事。
