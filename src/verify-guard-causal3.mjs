// mmx-status :: verify-guard-causal3.mjs
// Fixed version: the row must be scrolled into view before we read its
// bounding box, otherwise the click coordinates are (x, 0) and hit nothing --
// which is what made the two previous runs meaningless.
import { connectRenderer } from './lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from './lib/status-db.mjs';
import { buildBootstrapExpression, buildDisposeExpression } from './lib/page-script.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9351);
const ME = process.argv.includes('--session')
  ? process.argv[process.argv.indexOf('--session') + 1]
  : 'mvs_743fa844a372415fadfb9dd9bc57140d';
const { session } = await connectRenderer(port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new StatusDb(DEFAULT_DB);

const READ = `(() => {
  const sec = document.querySelector('[data-pinned-section]');
  if (!sec) return { found: false };
  const el = [...sec.querySelectorAll('[data-session-id]')].find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(ME)});
  if (!el) return { found: false };
  const c = el.querySelector('[class*="transition-transform"]');
  const cls = c ? String(c.getAttribute('class') || '') : '';
  const r = el.getBoundingClientRect();
  return {
    found: true, expanded: c ? !cls.includes('-rotate-90') : false,
    h: Math.round(r.height), y: Math.round(r.y),
    inViewport: r.y > 0 && r.bottom < innerHeight,
  };
})()`;

// Scroll the row into view, then return FRESH coordinates.
const SCROLL_AND_BOX = `(() => {
  const sec = document.querySelector('[data-pinned-section]');
  const el = [...sec.querySelectorAll('[data-session-id]')].find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(ME)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  return true;
})()`;

async function realClick(x, y) {
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type: t, x, y, button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

async function trial(label, guardOn) {
  await session.evaluateWithRetry(buildDisposeExpression());
  await session.evaluateWithRetry(buildBootstrapExpression({ status: db.snapshot(), collapseOnStart: guardOn }));
  await sleep(1000);
  await session.evaluateWithRetry(SCROLL_AND_BOX);
  await sleep(600);

  const box = await session.evaluateWithRetry(`(() => {
    const sec = document.querySelector('[data-pinned-section]');
    const el = [...sec.querySelectorAll('[data-session-id]')].find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(ME)});
    const c = el.querySelector('[class*="transition-transform"]');
    const cr = c.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      caretX: Math.round(cr.x + cr.width / 2), caretY: Math.round(cr.y + cr.height / 2),
      titleX: Math.round(cr.x + cr.width + 60), titleY: Math.round(r.y + r.height / 2),
      rowY: Math.round(r.y), vh: innerHeight,
    };
  })()`);
  const s0 = await session.evaluateWithRetry(READ);
  console.log(`\n  [${label}] 点击前 expanded=${s0.expanded} h=${s0.h} 坐标标题=(${box.titleX},${box.titleY}) 视口高=${box.vh}`);
  if (box.titleY <= 0 || box.titleY >= box.vh) {
    console.log(`  [${label}] !! 坐标仍在视口外，跳过`);
    return null;
  }

  await realClick(box.titleX, box.titleY);
  const marks = [];
  for (const w of [300, 900, 2000]) {
    await sleep(w);
    const s = await session.evaluateWithRetry(READ);
    marks.push(`+${w}ms=${s.expanded ? 'EXPANDED' : 'collapsed'}(h${s.h})`);
  }
  const fin = await session.evaluateWithRetry(READ);
  console.log(`  [${label}] ${marks.join(' ')} => ${fin.expanded ? '展开' : '折叠'}`);
  return fin.expanded;
}

console.log('=== 目标会话:', ME);
console.log('=== 守卫关闭 vs 开启，同一处真实点击标题 ===');
const off = await trial('守卫关闭', false);
await sleep(1500);
const on = await trial('守卫开启', true);

console.log('\n=== 结论 ===');
if (off === true && on === false) console.log('PASS：守卫确实是起作用的那个。');
else if (off === false && on === false) console.log('INCONCLUSIVE：这个点击点本身不触发展开。');
else console.log(`UNEXPECTED off=${off} on=${on}`);
session.close();
db.close();
