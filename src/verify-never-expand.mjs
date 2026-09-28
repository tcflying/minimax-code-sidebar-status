// mmx-status :: verify-never-expand.mjs
// Reproduces the user's exact complaint with a REAL mouse click (CDP
// Input.dispatchMouseEvent, not a synthetic DOM event) on the session TITLE,
// then checks whether the "never expand" guard holds it collapsed.
import { connectRenderer } from './lib/cdp.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9351);
const { session } = await connectRenderer(port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAP = `(() => {
  const sec = document.querySelector('[data-pinned-section]');
  if (!sec) return [];
  return [...sec.querySelectorAll('[data-session-id]')].map((el) => {
    const c = el.querySelector('[class*="transition-transform"]');
    const cls = c ? String(c.getAttribute('class') || '') : '';
    return {
      id: el.getAttribute('data-session-id'),
      text: String(el.textContent || '').trim().slice(0, 26),
      expanded: c ? !cls.includes('-rotate-90') : false,
      h: Math.round(el.getBoundingClientRect().height),
    };
  });
})()`;

const BOX = `(() => {
  const sec = document.querySelector('[data-pinned-section]');
  const el = [...sec.querySelectorAll('[data-session-id]')]
    .find((e) => e.getAttribute('data-session-id') === SID);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const c = el.querySelector('[class*="transition-transform"]');
  const cr = c ? c.getBoundingClientRect() : null;
  return {
    row: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    caret: cr ? { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) } : null,
    // title area: right of the caret, vertically centred
    titleX: cr ? Math.round(cr.x + cr.width + 60) : Math.round(r.x + r.width / 2),
    titleY: Math.round(r.y + r.height / 2),
  };
})()`;

async function realClick(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    });
  }
}

async function snapOf(id) {
  const s = await session.evaluateWithRetry(SNAP);
  return Array.isArray(s) ? (s.find((i) => i.id === id) || null) : null;
}

const before = await session.evaluateWithRetry(SNAP);
console.log('RAW before =', JSON.stringify(before).slice(0, 200));
const open = before.filter((i) => i.expanded);
console.log('当前置顶项:', before.length, ' 展开的:', open.length);
if (open.length) console.log('  !! 已有展开项:', open.map((i) => i.text).join(' / '));

const target = before.find((i) => !i.expanded && i.h <= 40);
if (!target) { console.log('没有可点测试的折叠项'); process.exit(0); }
console.log('\n目标（折叠态）:', target.text, 'h=' + target.h);

const box = await session.evaluateWithRetry(BOX.replace('SID', JSON.stringify(target.id)));
console.log('  坐标:', JSON.stringify(box));

for (const [label, pt] of [['标题', { x: box.titleX, y: box.titleY }], ['箭头', box.caret ? { x: box.caret.x, y: box.caret.y } : null]]) {
  if (!pt) continue;
  console.log(`\n=== 真实点击【${label}】 @${pt.x},${pt.y} ===`);
  await realClick(pt.x, pt.y);
  for (const w of [400, 1200, 2500]) {
    await sleep(w);
    const s = await snapOf(target.id);
    console.log(`  +${w}ms: expanded=${s.expanded} h=${s.h}` + (s.expanded ? '   <-- 展开中（守卫还没压）' : '   <-- 已折叠'));
  }
  const fin = await snapOf(target.id);
  const ga = await session.evaluateWithRetry(SNAP); const globalOpen = Array.isArray(ga) ? ga.filter((i) => i.expanded) : [];
  console.log(`  最终: 该项 expanded=${fin.expanded}；全局展开项=${globalOpen.length}` + (globalOpen.length ? ' -> ' + globalOpen.map((i) => i.text).join(' / ') : ''));
  await sleep(800);
}

console.log('\n=== 结论 ===');
const finalAll = await session.evaluateWithRetry(SNAP);
const anyOpen = Array.isArray(finalAll) ? finalAll.filter((i) => i.expanded) : [];
console.log(anyOpen.length === 0
  ? 'PASS：真实点击标题和箭头之后，置顶区没有任何展开项。'
  : 'FAIL：仍有 ' + anyOpen.length + ' 项处于展开。');

session.close();
process.exit(anyOpen.length === 0 ? 0 : 1);
