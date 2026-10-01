// ============================================================================
// ！！破坏性脚本，务必先读完这段！！
//
// 它会对目标实例发 Page.reload —— 清空该窗口的全部注入并把整个窗口刷新。
// 如果你正在那个窗口里对话，正在输入的内容会丢，进行中的会话会被打断。
//
// 护栏（两道，防止误点）：
//   1. 端口必须显式传。没有 --port 直接退出，不猜默认值。
//   2. 必须同时传 --force-reload 才真的 reload；否则只做只读探查就退出。
//
// 正确用法（务必在沙箱或空闲实例上跑，不要对着正在用的窗口跑）：
//   node tests/verify-reorder.mjs --port 9355 --force-reload
// ============================================================================
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : NaN;
const forceReload = argv.includes('--force-reload');

if (!Number.isFinite(port) || port <= 0) {
  console.error('必须显式指定端口，例如：\n  node tests/verify-reorder.mjs --port 9355 --force-reload');
  process.exit(2);
}
if (!forceReload) {
  console.log(`端口 ${port} —— 只读探查，不执行 reload。`);
  console.log('这个脚本会 Page.reload 目标窗口（清空注入 + 刷新窗口）。');
  console.log('确认目标实例空闲后，加上 --force-reload 才会真正执行。');
}
const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) { console.error('no archon target'); process.exit(1); }
const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

// 1) 记录 reload 前：探针的 inline style 确实在
const before = await s.evaluate(`(() => {
  const rows = document.querySelectorAll('[data-session-id]');
  const first = rows[0];
  let n = first;
  while (n) {
    if (n.className && n.className.toString().includes('space-y-px') && n.children.length > 3) {
      return { inlineDisplay: n.style.display || '(none)', inlineOrderCount: Array.from(n.children).filter(c => c.style.order).length };
    }
    n = n.parentElement;
  }
  return { inlineDisplay: '(list not found)', inlineOrderCount: 0 };
})()`);
console.log('reload 前（探针残留）:', JSON.stringify(before));

// 2) 强制重载，清空一切
if (!forceReload) {
  console.log('\n未加 --force-reload，到此为止，不 reload。');
  console.log('reload 前状态:', JSON.stringify(before));
  process.exit(0);
}
console.log('Page.reload ...');
await s.send('Page.enable').catch(() => {});
await s.send('Page.reload', { ignoreCache: false });
console.log('已重载，等待 daemon 自愈注入 ...');

let ok = false, snap = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const s2 = await CdpSession.connect(page.webSocketDebuggerUrl);
    await s2.send('Runtime.enable').catch(() => {});
    const res = await s2.evaluate(`(() => {
      if (!window.__mmxStatus) return { ready: false };
      const listEl = document.querySelector('[data-mmx-list]');
      if (!listEl) return { ready: true, marked: false, dots: document.querySelectorAll('[data-mmx-dot]').length };
      const items = Array.from(listEl.children).map((w, i) => {
        const row = w.querySelector('[data-session-id]');
        const running = row && !!row.querySelector('[data-mmx-dot][data-mmx-bucket="running"]');
        const b = w.getBoundingClientRect();
        return { i, running, top: Math.round(b.top), h: Math.round(b.height), cls: (w.className||'').toString().slice(0,40) };
      }).filter(x => x.h > 0);
      const run = items.filter(x => x.running);
      const non = items.filter(x => !x.running);
      return {
        ready: true, marked: true,
        display: getComputedStyle(listEl).display,
        markedCount: document.querySelectorAll('[data-mmx-list]').length,
        dots: document.querySelectorAll('[data-mmx-dot]').length,
        orderOfRunning: run.map(x => getComputedStyle(listEl.children[x.i]).order),
        runningTops: run.map(x => x.top),
        firstNonRunningTop: non.length ? Math.min(...non.map(x => x.top)) : null,
        itemCount: items.length,
        heightsUniform: new Set(items.map(x => x.h)).size <= 2
      };
    })()`);
    if (res.ready && res.marked && res.dots > 0) { snap = res; ok = true; break; }
  } catch (e) { /* 页面还在重载 */ }
}

if (!ok) { console.log(JSON.stringify({ error: 'daemon 未能自愈注入或未打标记' }, null, 2)); process.exit(1); }

console.log('\n=== 正式实现实测 ===');
console.log(JSON.stringify(snap, null, 2));
if (!snap.runningTops.length) {
  console.log('\n本次没有 running 行在屏上，无法验证排序。等待中再试一次…');
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s3 = await CdpSession.connect(page.webSocketDebuggerUrl);
    await s3.send('Runtime.enable').catch(() => {});
    const res = await s3.evaluate(`(() => {
      const listEl = document.querySelector('[data-mmx-list]');
      if (!listEl) return null;
      const items = Array.from(listEl.children).map((w, i) => {
        const row = w.querySelector('[data-session-id]');
        const running = row && !!row.querySelector('[data-mmx-dot][data-mmx-bucket="running"]');
        const b = w.getBoundingClientRect();
        return { i, running, top: Math.round(b.top), h: Math.round(b.height) };
      }).filter(x => x.h > 0);
      const run = items.filter(x => x.running), non = items.filter(x => !x.running);
      return { display: getComputedStyle(listEl).display, dots: document.querySelectorAll('[data-mmx-dot]').length,
               itemCount: items.length, runningTops: run.map(x=>x.top),
               firstNonRunningTop: non.length ? Math.min(...non.map(x=>x.top)) : null,
               heightsUniform: new Set(items.map(x=>x.h)).size <= 2,
               orderOfRunning: run.map(x => getComputedStyle(listEl.children[x.i]).order) };
    })()`);
    if (res && res.runningTops.length) { snap = Object.assign(snap, res); ok = true; break; }
  }
}

console.log('\n=== 最终 ===');
console.log(JSON.stringify(snap, null, 2));
const pass = snap.display === 'flex' && snap.runningTops.length > 0 &&
             snap.runningTops[0] < snap.firstNonRunningTop;
console.log(pass ? '\nPASS running 行已排到非 running 行之前' : '\nFAIL 未排到前面');
process.exit(pass ? 0 : 1);
