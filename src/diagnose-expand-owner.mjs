// mmx-status :: diagnose-expand-owner.mjs
// The sidebar auto-expands pinned sessions that have running subagents. This
// finds out WHO owns that state: persisted app state, or computed per render.
import { connectRenderer } from './lib/cdp.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9331);
const { session } = await connectRenderer(port);

const LS = `(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (/mavis|sidebar|pin|expand|collapse|session/i.test(k)) {
      out[k] = String(localStorage.getItem(k)).slice(0, 300);
    }
  }
  return out;
})()`;

const PINNED = `(() => {
  const sec = document.querySelector('[data-pinned-section]');
  if (!sec) return { found: false };
  const items = [...sec.querySelectorAll('[data-session-id]')];
  // A session is a group when it has a disclosure toggle. The caret is the
  // only button rendered before the title on group rows.
  return {
    found: true,
    count: items.length,
    items: items.slice(0, 12).map((el) => {
      const btn = el.querySelector('button,[role="button"]');
      const caret = btn ? btn.querySelector('svg') : null;
      return {
        id: el.getAttribute('data-session-id'),
        text: String(el.textContent || '').trim().slice(0, 36),
        hasToggle: !!btn,
        caretClass: caret ? String(caret.getAttribute('class') || '') : null,
        ariaExpanded:
          el.getAttribute('aria-expanded') ||
          (btn ? btn.getAttribute('aria-expanded') : null),
        // child rows that only exist when expanded
        childCount: el.querySelectorAll('[data-session-id]').length,
        inlineHeight: el.getBoundingClientRect().height,
      };
    }),
  };
})()`;

const ls = await session.evaluate(LS);
console.log('=== localStorage 里与侧边栏相关的键 ===');
const keys = Object.keys(ls);
if (!keys.length) console.log('  (无)');
for (const k of keys) console.log('  ' + k + ' = ' + ls[k]);

const pinned = await session.evaluate(PINNED);
console.log('\n=== 置顶区结构 ===');
console.log('  found=' + pinned.found + ' count=' + pinned.count);
for (const it of pinned.items || []) console.log('  ' + JSON.stringify(it));

session.close();
