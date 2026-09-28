// mmx-status :: diagnose-expand.mjs
// Is the sidebar's group expansion caused by our injection, or by the app?
// Controlled test: record expansion state -> strip every dot we added ->
// re-read expansion state. If it does not move, the app owns the state.
import { connectRenderer } from './lib/cdp.mjs';
import { buildDisposeExpression } from './lib/page-script.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9351);
const { session } = await connectRenderer(port);

const EXPAND_PROBE = `(() => {
  const rows = [...document.querySelectorAll('[data-session-id]')];
  const groups = new Map();
  for (const r of rows) {
    // a row is a group header when it carries an expand control
    const caret = r.querySelector('svg, [class*="rotate"], [class*="chevron"]');
    const expandedAttr =
      r.getAttribute('aria-expanded') ||
      (r.firstElementChild && r.firstElementChild.getAttribute
        ? r.firstElementChild.getAttribute('aria-expanded') : null);
    const key = expandedAttr === null && !caret ? null : (r.getAttribute('data-session-id') || '?');
    if (key) groups.set(key, {
      id: r.getAttribute('data-session-id'),
      text: String(r.textContent || '').trim().slice(0, 40),
      ariaExpanded: expandedAttr,
      hasCaret: !!caret,
    });
  }
  return {
    totalRows: rows.length,
    dots: document.querySelectorAll('[data-mmx-dot]').length,
    rowsWithRelativeInline: [...document.querySelectorAll('[data-session-id]')]
      .filter((r) => r.style.position === 'relative').length,
    groups: [...groups.values()],
  };
})()`;

const a = await session.evaluate(EXPAND_PROBE);
console.log('=== 有注入时 ===');
console.log('  会话行:', a.totalRows, ' 状态点:', a.dots, ' 被我加 position 的行:', a.rowsWithRelativeInline);
for (const g of a.groups) console.log('   group', JSON.stringify(g));

console.log('\n=== 移除所有注入 ===');
const d = await session.evaluate(buildDisposeExpression());
console.log(' ', JSON.stringify(d));

const b = await session.evaluate(EXPAND_PROBE);
console.log('\n=== 移除后 ===');
console.log('  会话行:', b.totalRows, ' 状态点:', b.dots, ' 被我加 position 的行:', b.rowsWithRelativeInline);
for (const g of b.groups) console.log('   group', JSON.stringify(g));

const same = JSON.stringify(a.groups) === JSON.stringify(b.groups);
console.log('\n=== 结论 ===');
console.log(same
  ? '展开状态完全未变 => 展开是 MiniMax Code 自己的 React 状态，本工具未参与。'
  : '展开状态发生变化 => 本工具确实影响了展开，需要排查。');

session.close();
process.exit(same ? 0 : 1);
