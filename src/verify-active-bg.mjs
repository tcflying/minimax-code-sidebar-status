// mmx-status :: verify-active-bg.mjs
// 验证"选中行底色覆盖"真的生效：
//   1) 读覆盖前的 computed background
//   2) 注入带覆盖的样式
//   3) 读覆盖后的 computed background，逐个对比
import { connectRenderer } from './lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from './lib/status-db.mjs';
import { buildBootstrapExpression, buildDisposeExpression } from './lib/page-script.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9352);
const { session } = await connectRenderer(port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new StatusDb(DEFAULT_DB);

// 选中行 = 它的 button 带"裸"类（类串里不含 "hover:bg-bg_interaction_tertiary_hover"）
const SEL = `(() => {
  const rows = [...document.querySelectorAll('[data-session-id]')];
  const sel = [], other = [];
  for (const el of rows) {
    const btn = el.querySelector('button.bg-bg_interaction_tertiary_hover');
    if (!btn) continue;
    const cls = String(btn.getAttribute('class') || '');
    const isSel = cls.indexOf('hover:bg-bg_interaction_tertiary_hover') < 0;
    const rec = {
      id: el.getAttribute('data-session-id'),
      text: String(el.textContent || '').trim().slice(0, 24),
      bg: getComputedStyle(btn).backgroundColor,
      shadow: getComputedStyle(btn).boxShadow.slice(0, 50),
    };
    (isSel ? sel : other).push(rec);
  }
  return { sel, other: other.slice(0, 3), selCount: sel.length, otherCount: other.length };
})()`;

console.log('=== 1. 覆盖前 ===');
const b1 = await session.evaluateWithRetry(SEL);
console.log('  选中行 %d 个，普通行 %d 个', b1.selCount, b1.otherCount);
for (const s of b1.sel) console.log('   选中 %s  bg=%s  "%s"', s.id, s.bg, s.text);
for (const o of b1.other) console.log('   普通 bg=%-24s "%s"', o.bg, o.text);

console.log('\n=== 2. 注入覆盖样式 ===');
const boot = await session.evaluateWithRetry(
  buildBootstrapExpression({ status: db.snapshot(), collapseOnStart: true })
);
console.log('  ', JSON.stringify(boot.collapse || {}), 'painted=', boot.initial && boot.initial.painted);
await sleep(1200);

console.log('\n=== 3. 覆盖后 ===');
const b2 = await session.evaluateWithRetry(SEL);
console.log('  选中行 %d 个，普通行 %d 个', b2.selCount, b2.otherCount);
for (const s of b2.sel) console.log('   选中 %s  bg=%s  "%s"\n        shadow=%s', s.id, s.bg, s.text, s.shadow);
for (const o of b2.other) console.log('   普通 bg=%-24s "%s"', o.bg, o.text);

console.log('\n=== 4. CSS 变量实际值 ===');
const vars = await session.evaluateWithRetry(
  "(() => { const cs = getComputedStyle(document.documentElement); return { activeBg: cs.getPropertyValue('--mmx-active-bg').trim(), bar: cs.getPropertyValue('--mmx-active-bar').trim() }; })()"
);
console.log('  ', JSON.stringify(vars));

console.log('\n=== 5. 判定 ===');
let pass = 0, fail = 0;
if (b1.selCount > 0) {
  const before = b1.sel[0].bg, after = b2.sel[0].bg;
  if (before !== after) { console.log('  PASS 选中行背景已改变: %s -> %s', before, after); pass++; }
  else { console.log('  FAIL 选中行背景未改变: %s', before); fail++; }
} else {
  console.log('  SKIP 当前没有选中行（需先点一个会话）');
}
const ob = b1.other.length ? b1.other[0].bg : null;
const oa = b2.other.length ? b2.other[0].bg : null;
if (ob && oa) {
  if (ob === oa) { console.log('  PASS 未选中行未被误伤: %s', oa); pass++; }
  else { console.log('  FAIL 未选中行被误改: %s -> %s', ob, oa); fail++; }
}
console.log('\n结果: %d passed, %d failed', pass, fail);
session.close();
db.close();
process.exit(fail === 0 ? 0 : 1);
