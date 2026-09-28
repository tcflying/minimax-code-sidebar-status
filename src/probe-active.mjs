// mmx-status :: implement + verify 选中行底色
// 1) 真实点击一个会话行，造出选中态
// 2) 确认应用给选中行挂的类（源码判定是 bg-bg_grouped_tertiary_elevated）
// 3) 注入 CSS 覆盖
// 4) 验证 computed background 真的变了
import { connectRenderer } from './lib/cdp.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9352);
const { session } = await connectRenderer(port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function realClick(x, y) {
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type: t, x, y, button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

// ---- 1) 造出选中态 ----
const box = await session.evaluateWithRetry(`(() => {
  const rows = [...document.querySelectorAll('[data-session-id]')];
  // 找一个还没展开、可见的行
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    if (r.y > 80 && r.bottom < innerHeight - 80 && r.height <= 40) {
      el.scrollIntoView({ block: 'center' });
      return { id: el.getAttribute('data-session-id'), ok: true };
    }
  }
  return { ok: false };
})()`);
console.log('目标行:', JSON.stringify(box));
await sleep(500);

const pos = await session.evaluateWithRetry(`(() => {
  const el = [...document.querySelectorAll('[data-session-id]')]
    .find(e => e.getAttribute('data-session-id') === ${JSON.stringify(box.id)});
  el.scrollIntoView({ block: 'center' });
  return true;
})()`);
await sleep(600);
const p = await session.evaluateWithRetry(`(() => {
  const el = [...document.querySelectorAll('[data-session-id]')]
    .find(e => e.getAttribute('data-session-id') === ${JSON.stringify(box.id)});
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), h: Math.round(r.height), vh: innerHeight };
})()`);
console.log('点击坐标:', JSON.stringify(p));
if (p.y <= 0 || p.y >= p.vh) { console.log('坐标越界，放弃'); process.exit(1); }
await realClick(p.x, p.y);
await sleep(2500);

// ---- 2) 找出选中行到底挂了什么类 ----
const FIND = `(() => {
  const cands = ['bg-bg_grouped_tertiary_elevated','bg-bg_interaction_tertiary_hover',
                 'bg-bg_grouped_secondary','bg-bg_grouped_tertiary','bg-bg_selected_tertiary',
                 'bg-bg_emphasis_tertiary','bg-bg_interaction_accent_focus_highlight'];
  const found = {};
  for (const c of cands) found[c] = document.querySelectorAll('.' + c).length;
  // 扫描所有会话行子元素，找非状态色的背景
  const hits = [];
  for (const el of document.querySelectorAll('[data-session-id]')) {
    for (const c of el.querySelectorAll('*')) {
      const bg = getComputedStyle(c).backgroundColor;
      if (bg === 'rgba(0, 0, 0, 0)') continue;
      if (/rgb\((4, 181, 75|247, 54, 70|245, 104, 17|0, 148, 252|245, 245, 245)\)/.test(bg)) continue;
      hits.push({
        rowId: el.getAttribute('data-session-id'),
        bg,
        tag: c.tagName,
        cls: String(c.className || '').slice(0, 120),
        text: String(el.textContent || '').trim().slice(0, 24),
      });
    }
  }
  return { found, hits: hits.slice(0, 8), hitCount: hits.length };
})()`;
const f1 = await session.evaluateWithRetry(FIND);
console.log('\n--- 候选类命中数 ---');
for (const [k, v] of Object.entries(f1.found)) console.log('  %-46s %d', k, v);
console.log('--- 非状态色背景的元素 %d 个 ---', f1.hitCount);
for (const h of f1.hits) console.log('  bg=%-24s row=%s  <%s> "%s"\n     cls=%s', h.bg, h.rowId, h.tag, h.text, h.cls);

session.close();
