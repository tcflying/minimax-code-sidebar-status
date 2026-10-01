// mmx-status :: debug-guard.mjs
// The guard is ON yet the group still expanded. Find out which half is broken:
//   (a) enforceNoAutoExpand is never invoked, or
//   (b) it is invoked but fails to collapse.
import { connectRenderer } from './lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from './lib/status-db.mjs';
import { buildBootstrapExpression } from './lib/page-script.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9331);
const ME = 'mvs_743fa844a372415fadfb9dd9bc57140d';
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
  return {
    found: true, hasCaret: !!c,
    expanded: c ? !cls.includes('-rotate-90') : false,
    h: Math.round(el.getBoundingClientRect().height),
    apiInstalled: !!window.__mmxStatus,
    hasGuardFn: !!(window.__mmxStatus && window.__mmxStatus.enforceNoAutoExpand),
    collapseCfg: window.__mmxStatus ? window.__mmxStatus.cfg.collapseOnStart : null,
    caretTag: c ? c.tagName : null,
    caretParentTag: c && c.parentElement ? c.parentElement.tagName : null,
    caretClosestBtn: !!(c && c.closest('button,[role="button"]')),
    hasClickFn: !!(c && c.closest('button,[role="button"]') && typeof c.closest('button,[role="button"]').click === 'function'),
  };
})()`;

// Count how many times the guard actually runs, by wrapping it.
const WRAP = `(() => {
  const a = window.__mmxStatus;
  if (!a) return { ok: false };
  if (a.__wrapped) return { ok: true, already: true, calls: a.__calls };
  const orig = a.enforceNoAutoExpand;
  a.__calls = 0; a.__results = [];
  a.enforceNoAutoExpand = function () {
    a.__calls++;
    const r = orig.apply(this, arguments);
    if (a.__results.length < 12) a.__results.push(r);
    return r;
  };
  a.__wrapped = true;
  return { ok: true, wrapped: true };
})()`;

async function realClick(x, y) {
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type: t, x, y, button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

const boot = await session.evaluateWithRetry(
  buildBootstrapExpression({ status: db.snapshot(), collapseOnStart: true })
);
console.log('bootstrap:', JSON.stringify(boot.collapse));
await sleep(800);
console.log('READ after bootstrap:', JSON.stringify(await session.evaluateWithRetry(READ)));

console.log('\nWRAP:', JSON.stringify(await session.evaluateWithRetry(WRAP)));

const s0 = await session.evaluateWithRetry(READ);
if (s0.found) {
  const box = await session.evaluateWithRetry(`(() => {
    const sec = document.querySelector('[data-pinned-section]');
    const el = [...sec.querySelectorAll('[data-session-id]')].find((e) => e.getAttribute('data-session-id') === ${JSON.stringify(ME)});
    const c = el.querySelector('[class*="transition-transform"]');
    const cr = c.getBoundingClientRect();
    return { x: Math.round(cr.x + cr.width + 60), y: Math.round(cr.y + cr.height / 2) };
  })()`);
  console.log('\n真实点击标题 @', box.x, box.y);
  await realClick(box.x, box.y);
  await sleep(2500);

  console.log('READ after click:', JSON.stringify(await session.evaluateWithRetry(READ)));
  const stats = await session.evaluateWithRetry(
    '({ calls: window.__mmxStatus.__calls, results: window.__mmxStatus.__results })'
  );
  console.log('守卫被调用次数:', stats.calls);
  console.log('前几次返回:', JSON.stringify(stats.results));

  const manual = await session.evaluateWithRetry('window.__mmxStatus.enforceNoAutoExpand()');
  console.log('手动再调一次:', JSON.stringify(manual));
  await sleep(1200);
  console.log('READ after manual:', JSON.stringify(await session.evaluateWithRetry(READ)));
}

session.close();
db.close();
