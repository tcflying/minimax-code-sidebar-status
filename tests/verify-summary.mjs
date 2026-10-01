// Verify the running summary bar: does it exist, is it in the RIGHT place,
// does the number match the rows actually painted as running, and does it hide
// itself when nothing is running.
//
//   node verify-summary.mjs [port]
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 截图输出到仓库内 logs/shots（.gitignore 已忽略 logs/），不写死任何绝对路径。
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'shots');

const port = Number(process.argv[2] || 9331);
const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) { console.error('no archon target'); process.exit(1); }

const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

const r = await s.evaluate(`(() => {
  const bar = document.getElementById('mmx-running-summary');
  const sec = document.querySelector('[data-pinned-section]');
  const paintedRunning = document.querySelectorAll('[data-mmx-dot][data-mmx-bucket="running"]').length;

  if (!bar) {
    return { exists: false, paintedRunning, reason: 'bar not found' };
  }
  const b = bar.querySelector('b');
  const shown = b ? Number(b.textContent) : null;
  const cs = getComputedStyle(bar);
  const br = bar.getBoundingClientRect();

  // Placement: must sit between the header row and the grid list container.
  const kids = Array.from(sec.children);
  const idx = kids.indexOf(bar);
  const prev = kids[idx - 1];
  const next = kids[idx + 1];

  return {
    exists: true,
    text: (bar.textContent || '').trim(),
    shown,
    paintedRunning,
    // The judgement must be able to FAIL: a bar showing a stale number is
    // worse than no bar.
    countMatches: shown === paintedRunning,
    display: cs.display,
    emptyFlag: bar.getAttribute('data-mmx-empty'),
    height: Math.round(br.height),
    width: Math.round(br.width),
    bg: cs.backgroundColor,
    // Is it really below the "置顶" header and above the animated list?
    indexInSection: idx,
    prevIsHeader: !!prev && (prev.textContent || '').trim().slice(0, 2) === '置顶',
    nextIsListGrid: !!next && /grid/.test(getComputedStyle(next).display),
    visible: cs.display !== 'none' && br.height > 0,
  };
})()`);

console.log('=== 汇总条实测 ===');
console.log(JSON.stringify(r, null, 2));
console.log(r.countMatches ? '\nPASS 数字与实际 running 行数一致' : '\nFAIL 数字与实际不符');

// screenshot
try {
  const m = await s.send('Page.getLayoutMetrics');
  const css = m.cssContentSize || m.contentSize;
  const w = Math.min(560, Math.max(360, Math.round(css.width * 0.34)));
  const shot = await s.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: w, height: Math.min(900, Math.round(css.height)), scale: 1 },
  });
  const p = path.join(outDir, 'sidebar-summary-bar.png');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
  console.log('截图: ' + p);
} catch (e) {
  console.log('截图失败: ' + e.message);
}
s.close();
