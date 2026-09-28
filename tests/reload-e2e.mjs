// The test that was missing from the whole project: does the injection SURVIVE
// a renderer reload and come back on its own?
//
// Every previous check was "start daemon -> assert injected". That passes even
// though a renderer reload silently wipes the overlay forever, because the
// daemon never re-bootstraps. This script forces the reload.
//
//   node reload-e2e.mjs [port] [waitMs]
//
// Deliberately two-phase across SEPARATE CDP connections: the reload kills the
// renderer, so the post-reload assertion must come from a fresh connection or
// it would be answered by a dying page.

import { listTargets, CdpSession } from '../src/lib/cdp.mjs';

const port = Number(process.argv[2] || 9331);
const waitMs = Number(process.argv[3] || 30000);

const pickPage = async () => {
  const targets = await listTargets(port);
  return targets.find(
    (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
  );
};

const readState = async (label) => {
  const page = await pickPage();
  if (!page) return { label, error: 'archon target gone' };
  const s = await CdpSession.connect(page.webSocketDebuggerUrl);
  await s.send('Runtime.enable').catch(() => {});
  const r = await s.evaluate(`(() => {
    const dots = Array.from(document.querySelectorAll('[data-mmx-dot]'));
    const byBucket = {};
    for (const d of dots) {
      const b = d.getAttribute('data-mmx-bucket') || '(none)';
      byBucket[b] = (byBucket[b] || 0) + 1;
    }
    const strict = document.querySelector(
      '[data-session-id] button.bg-bg_interaction_tertiary_hover' +
      ':not([class*="hover:bg-bg_interaction_tertiary_hover"])'
    );
    return {
      styleInjected: !!document.getElementById('mmx-status-style'),
      globalFlag: typeof window.__mmxStatus,
      dotTotal: dots.length,
      dotByBucket: byBucket,
      selectedBg: strict ? getComputedStyle(strict).backgroundColor : null,
      // null once the document has been replaced by the reload.
      probeMark: typeof window.__probeMark === 'undefined' ? null : window.__probeMark,
    };
  })()`);
  s.close();
  return { label, ...r };
};

const before = await readState('before-reload');
console.log(JSON.stringify(before));
if (!before.styleInjected) {
  console.error('前置条件失败：注入本来就不在，无法测重载恢复。先跑 rebootstrap。');
  process.exit(2);
}

// PROOF that the reload actually replaces the document. Without this marker the
// test can pass while the old document is still alive, which makes a "recovered"
// verdict meaningless. The marker must be GONE afterwards.
const page0 = await pickPage();
const marker = await (async () => {
  const s = await CdpSession.connect(page0.webSocketDebuggerUrl);
  await s.send('Runtime.enable').catch(() => {});
  const r = await s.evaluate(
    `(() => { window.__probeMark = 'MARK-' + Math.random().toString(36).slice(2); return window.__probeMark; })()`
  );
  s.close();
  return r;
})();
console.log('>>> reload 前页面标记 =', marker);

// Force the renderer to reload.
const page = await pickPage();
const killer = await CdpSession.connect(page.webSocketDebuggerUrl);
await killer.send('Page.enable').catch(() => {});
console.log('>>> 发送 Page.reload');
killer.send('Page.reload', { ignoreCache: false }).catch(() => {});
setTimeout(() => killer.close(), 1500);

// Poll from a FRESH connection each time; the first few will fail while the
// renderer is down, which is expected and must not be read as "not recovered".
const deadline = Date.now() + waitMs;
let last = null;
let recovered = false;
let markerGone = false;
let sawNotInstalled = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    last = await readState('poll');
  } catch (e) {
    last = { label: 'poll', error: e.message };
    continue;
  }
  if (last.probeMark === null || last.probeMark === undefined) markerGone = true;
  if (last.styleInjected === false || last.reason === 'not-installed') sawNotInstalled = true;
  if (last.styleInjected && last.dotTotal > 0) {
    recovered = true;
    break;
  }
}

console.log(JSON.stringify(last));
console.log('---- 判据自证 ----');
console.log('  reload 确实换了文档(标记已消失):', markerGone);
console.log('  中途确实出现过 not-installed   :', sawNotInstalled);
console.log('---- 结论 ----');
if (recovered && markerGone) {
  console.log(
    `PASS 页面重载后注入自恢复：styleInjected=${last.styleInjected} dotTotal=${last.dotTotal} ` +
      `buckets=${JSON.stringify(last.dotByBucket)} selectedBg=${last.selectedBg}`
  );
  process.exit(0);
}
if (recovered && !markerGone) {
  console.error(
    'FAIL 结论无效：看到了注入，但页面标记仍在，说明 reload 根本没发生，这次 PASS 是假的'
  );
  process.exit(1);
}
console.log(
  `FAIL 等待 ${waitMs}ms 后注入仍未恢复：styleInjected=${last?.styleInjected} ` +
    `dotTotal=${last?.dotTotal} —— daemon 没有重新 bootstrap`
);
process.exit(1);
