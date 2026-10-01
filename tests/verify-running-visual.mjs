// Verify the NEW running-state styling is actually applied in the live page,
// then screenshot the sidebar so the result is judged by pixels, not by prose.
//
//   node verify-running-visual.mjs [port]
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 9331);
// 截图输出到仓库内 logs/shots（.gitignore 已忽略 logs/），不写死任何绝对路径。
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'shots');

const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) {
  console.error('no archon target');
  process.exit(1);
}
const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

// ---- 1. Measure the running row against its neighbours ------------------
const measured = await s.evaluate(`(() => {
  const bar = document.querySelector('[data-mmx-dot][data-mmx-bucket="running"]');
  if (!bar) return { error: 'no running row on screen' };
  const row = bar.closest('[data-session-id]');
  const cs = getComputedStyle(bar);
  const rowCs = getComputedStyle(row);
  const btn = row.querySelector('button');
  const btnCs = btn ? getComputedStyle(btn) : null;
  // The button itself carries text-text_default_primary, which pins its colour.
  // The element that actually paints the title is a span inside it
  // (shimmer-text__content). Measuring the button reported the untouched colour
  // and looked like a broken rule; measure the real holder.
  const holder =
    row.querySelector('span.shimmer-text__content') ||
    row.querySelector('button span') ||
    btn;
  const holderCs = holder ? getComputedStyle(holder) : null;
  const rb = row.getBoundingClientRect();

  // Neighbours: the nearest non-running rows, for contrast comparison.
  const others = Array.from(document.querySelectorAll('[data-session-id]'))
    .filter((r) => r !== row)
    .slice(0, 6)
    .map((r) => ({
      id: (r.getAttribute('data-session-id') || '').slice(0, 12),
      bg: getComputedStyle(r).backgroundColor,
    }));

  return {
    runningId: (row.getAttribute('data-session-id') || '').slice(0, 16),
    title: (row.textContent || '').trim().slice(0, 40),
    barSize: cs.width + ' x ' + cs.height,
    barBg: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor,
    barShadow: cs.boxShadow,
    barAnimation: cs.animationName + ' ' + cs.animationDuration,
    rowBg: rowCs.backgroundColor,
    rowHeight: Math.round(rb.height),
    titleColor: holderCs ? holderCs.color : null,
    buttonColor: btnCs ? btnCs.color : null,
    // The judgement must be able to distinguish "tinted" from "untouched":
    // an untouched title is the app's near-black, a tinted one is #15803d.
    titleTinted: holderCs ? holderCs.color === 'rgb(21, 128, 61)' : false,
    neighbourBgs: others.map((o) => o.bg),
    // Does the tint actually differ from its neighbours? A green that equals
    // the page background is not a signal.
    tintDiffers: others.every((o) => o.bg !== rowCs.backgroundColor),
  };
})()`);

console.log('=== 1. running 行的实测样式 ===');
console.log(JSON.stringify(measured, null, 2));

// ---- 2. Screenshot the sidebar region -----------------------------------
try {
  const metrics = await s.send('Page.getLayoutMetrics');
  const css = metrics.cssContentSize || metrics.contentSize;
  const w = Math.min(560, Math.max(360, Math.round(css.width * 0.34)));
  const h = Math.min(900, Math.round(css.height));
  const shot = await s.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
  });
  fs.mkdirSync(outDir, { recursive: true });
  const p = outDir + '/sidebar-running-style.png';
  fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
  console.log('\n=== 2. 截图 ===');
  console.log('  ' + p + '  (' + fs.statSync(p).size + ' bytes, ' + w + 'x' + h + ')');
} catch (e) {
  console.log('\n截图失败: ' + e.message);
}
s.close();
