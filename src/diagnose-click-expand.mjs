// mmx-status :: diagnose-click-expand.mjs
// Which affordance causes the expansion?
//   A) clicking the row body (to open the session)
//   B) clicking the disclosure caret
// The user requires "never auto-expand", so we must know whether (A) alone
// already expands. If it does, a one-shot startup collapse is not enough.
import { connectRenderer } from './lib/cdp.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9351);
const { session } = await connectRenderer(port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROWS = `(() => {
  const sec = document.querySelector('[data-pinned-section]');
  if (!sec) return [];
  return [...sec.querySelectorAll('[data-session-id]')].map((el) => {
    const caret = el.querySelector('[class*="transition-transform"]');
    const cls = caret ? String(caret.getAttribute('class') || '') : '';
    return {
      id: el.getAttribute('data-session-id'),
      text: String(el.textContent || '').trim().slice(0, 28),
      expanded: caret ? !cls.includes('-rotate-90') : false,
      h: Math.round(el.getBoundingClientRect().height),
      hasCaret: !!caret,
    };
  });
})()`;

const rows = await session.evaluate(ROWS);
const collapsedWithCaret = rows.filter((r) => r.hasCaret && !r.expanded);
console.log('置顶项:', rows.length, ' 已折叠且有箭头:', collapsedWithCaret.length);
if (!collapsedWithCaret.length) {
  console.log('没有可测试的目标（全部展开或无箭头）。');
  process.exit(0);
}

const target = collapsedWithCaret[0];
console.log('\n目标（当前折叠）:', target.text, 'h=' + target.h);

// ---- A) click the row BODY, avoiding the caret ----
console.log('\n=== A. 点击行主体（避开箭头）===');
const a = await session.evaluate(`(() => {
  const sec = document.querySelector('[data-pinned-section]');
  const el = [...sec.querySelectorAll('[data-session-id]')]
    .find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(target.id)});
  if (!el) return { ok: false };
  const caret = el.querySelector('[class*="transition-transform"]');
  // pick a child that is NOT the caret and not an action button
  const inner = el.firstElementChild;
  const target2 = inner || el;
  target2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return { ok: true };
})()`);
console.log('  点击:', JSON.stringify(a));
for (const w of [500, 1500, 3000]) {
  await sleep(w);
  const r = await session.evaluate(ROWS);
  const now = r.find((x) => x.id === target.id);
  console.log(`  +${w}ms: expanded=${now.expanded} h=${now.h}` + (now.expanded ? '  <-- 点行就展开了' : ''));
}

let r2 = await session.evaluate(ROWS);
let cur = r2.find((x) => x.id === target.id);
let note = cur.expanded ? 'A 会触发展开' : 'A 不触发展开';

if (cur.expanded) {
  // restore to collapsed for test B
  await session.evaluate(`(() => {
    const sec = document.querySelector('[data-pinned-section]');
    const el = [...sec.querySelectorAll('[data-session-id]')]
      .find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(target.id)});
    const c = el.querySelector('[class*="transition-transform"]');
    (c.closest('button,[role="button"]') || c.parentElement).click();
  })()`);
  await sleep(1200);
}

// ---- B) click the CARET explicitly ----
console.log('\n=== B. 显式点击箭头 ===');
const b = await session.evaluate(`(() => {
  const sec = document.querySelector('[data-pinned-section]');
  const el = [...sec.querySelectorAll('[data-session-id]')]
    .find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(target.id)});
  const c = el.querySelector('[class*="transition-transform"]');
  if (!c) return { ok: false };
  (c.closest('button,[role="button"]') || c.parentElement).click();
  return { ok: true };
})()`);
console.log('  点击:', JSON.stringify(b));
for (const w of [500, 2000]) {
  await sleep(w);
  const r = await session.evaluate(ROWS);
  const now = r.find((x) => x.id === target.id);
  console.log(`  +${w}ms: expanded=${now.expanded} h=${now.h}`);
}

console.log('\n=== 结论 ===');
console.log(note + '；B 是用户主动展开，语义上应予保留。');
session.close();
