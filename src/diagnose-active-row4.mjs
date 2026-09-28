// mmx-status :: diagnose-active-row4.mjs
// 选中行没有 aria/data 标准标记。从源码已知的类名
// (bg-bg_grouped_tertiary_elevated / bg-bg_interaction_tertiary_hover) 反查，
// 统计每个 row 的 class 里出现了哪些"高亮类"。
import { connectRenderer } from './lib/cdp.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9352);
const { session } = await connectRenderer(port);

const P = `(() => {
  const rows = [...document.querySelectorAll('[data-session-id]')];
  const clsCount = new Map();
  for (const el of rows) {
    for (const c of el.classList) clsCount.set(c, (clsCount.get(c) || 0) + 1);
  }
  // 找带"高亮"语义类的行
  const hl = rows.filter((el) => {
    const c = el.className || '';
    return /tertiary_elevated|interaction_tertiary_hover|tertiary_hover|accent|selected|active/i.test(c);
  });
  return {
    total: rows.length,
    // 所有出现过的 class（按频次）
    classes: [...clsCount.entries()].sort((a,b) => b[1]-a[1]).slice(0, 25),
    highlightedCount: hl.length,
    highlighted: hl.slice(0, 6).map((el) => {
      const cs = getComputedStyle(el);
      return {
        id: el.getAttribute('data-session-id'),
        text: String(el.textContent || '').trim().slice(0, 30),
        className: String(el.className || ''),
        bg: cs.backgroundColor,
        h: Math.round(el.getBoundingClientRect().height),
      };
    }),
    // 反过来：页面里所有用了这些类名的元素
    sampleEls: ['bg-bg_grouped_tertiary_elevated','bg-bg_interaction_tertiary_hover'].map((cls) => {
      const els = document.querySelectorAll('.' + cls);
      let sample = null;
      if (els.length) {
        const e = els[0];
        const cs = getComputedStyle(e);
        sample = { tag: e.tagName, bg: cs.backgroundColor,
                   hasSessionId: !!e.closest('[data-session-id]'),
                   closestRowId: (e.closest('[data-session-id]')||{}).getAttribute
                     ? e.closest('[data-session-id]').getAttribute('data-session-id') : null,
                   text: String(e.textContent||'').trim().slice(0,26) };
      }
      return { cls, count: els.length, sample };
    }),
  };
})()`;

const r = await session.evaluateWithRetry(P);
console.log('行总数', r.total, ' 带高亮类的行', r.highlightedCount);
console.log('\n--- 行上出现过的 class Top25 ---');
for (const [c, n] of r.classes) console.log('  x%-4d %s', n, c);
console.log('\n--- 高亮行 ---');
for (const h of r.highlighted) {
  console.log('  bg=%-24s h=%-4d "%s"', h.bg, h.h, h.text);
  console.log('     class=%s', h.className.slice(0, 200));
}
console.log('\n--- 用这两个类名在全页搜 ---');
for (const s of r.sampleEls) {
  console.log('  .%s  命中 %d 个', s.cls, s.count);
  if (s.sample) console.log('     样例: <%s> bg=%s 属于会话行=%s rowId=%s "%s"',
    s.sample.tag, s.sample.bg, s.sample.hasSessionId, s.sample.closestRowId, s.sample.text);
}

session.close();
