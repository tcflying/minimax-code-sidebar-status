// mmx-status :: diagnose-collapse-stick.mjs
// The app force-expands pinned sessions that have running children. The user's
// requirement is "never auto-expand", so the decisive question is:
// if the user manually collapses, does it stay collapsed?
import { connectRenderer } from './lib/cdp.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9331);
const { session } = await connectRenderer(port);

const STATE = `(() => {
  const sec = document.querySelector('[data-pinned-section]');
  if (!sec) return { found: false, items: [] };
  const items = [...sec.querySelectorAll('[data-session-id]')].map((el) => {
    const caret = el.querySelector('span.text-icon_default_primary.transition-transform, [class*="transition-transform"]');
    const cls = caret ? String(caret.getAttribute('class') || '') : '';
    return {
      id: el.getAttribute('data-session-id'),
      text: String(el.textContent || '').trim().slice(0, 30),
      expanded: caret ? !cls.includes('-rotate-90') : false,
      height: Math.round(el.getBoundingClientRect().height),
    };
  });
  return { found: true, items };
})()`;

const a = await session.evaluate(STATE);
const open = a.items.filter((i) => i.expanded);
console.log('=== 初始状态 ===');
console.log('  置顶项:', a.items.length, ' 展开的:', open.length);
for (const i of open) console.log('   OPEN  h=' + i.height + '  ' + i.text);

if (!open.length) {
  console.log('\n当前没有展开的置顶项，无需测试。');
  process.exit(0);
}

const target = open[0];
console.log('\n=== 对 "' + target.text + '" 做一次手动折叠 ===');

// Click the disclosure toggle exactly as a user would.
const clicked = await session.evaluate(`(() => {
  const sec = document.querySelector('[data-pinned-section]');
  const el = [...sec.querySelectorAll('[data-session-id]')]
    .find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(target.id)});
  if (!el) return { ok: false, reason: 'row not found' };
  const caret = el.querySelector('[class*="transition-transform"]');
  const btn = caret ? (caret.closest('button,[role="button"]') || caret.parentElement) : null;
  if (!btn) return { ok: false, reason: 'no toggle' };
  btn.click();
  return { ok: true };
})()`);
console.log('  点击结果:', JSON.stringify(clicked));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const w of [800, 3000, 6000]) {
  await sleep(w);
  const b = await session.evaluate(STATE);
  const now = b.items.find((i) => i.id === target.id);
  const stillOpen = now && now.expanded;
  console.log(`  +${w}ms: expanded=${stillOpen} height=${now ? now.height : '?'}` +
    (stillOpen ? '  <-- 弹回展开了' : '  <-- 保持折叠'));
}

const c = await session.evaluate(STATE);
const stillOpen = (c.items.find((i) => i.id === target.id) || {}).expanded;
console.log('\n=== 结论 ===');
console.log(stillOpen
  ? '手动折叠会被应用重新展开 => 它是"有运行中子代理就展开"的硬规则，用户无法通过点击关闭。'
  : '手动折叠能保持 => 应用只是首次默认展开，用户点一下即可长期关闭。');

session.close();
process.exit(stillOpen ? 1 : 0);
