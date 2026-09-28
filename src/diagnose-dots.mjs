// mmx-status :: diagnose-dots.mjs
// Explains what the [data-mmx-dot] nodes still in the page actually are, so we
// can tell a failed restore from a zombie repainting loop.
import { connectRenderer } from './lib/cdp.mjs';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 9351;
})();

const { session } = await connectRenderer(port);

const probe = `(() => {
  const dots = [...document.querySelectorAll('[data-mmx-dot]')];
  const first = dots[0];
  return {
    dotCount: dots.length,
    apiInstalled: !!window.__mmxStatus,
    stylePresent: !!document.getElementById('mmx-status-style'),
    buckets: dots.reduce((a, d) => { const b = d.getAttribute('data-mmx-bucket')||'none'; a[b]=(a[b]||0)+1; return a; }, {}),
    // A dot created by the current runtime always has a positioned parent row.
    // A leftover/orphan would either have no row or no inline position.
    parentIsSessionRow: first ? !!first.closest('[data-session-id]') : null,
    firstRowInlinePosition: first && first.closest('[data-session-id]')
      ? first.closest('[data-session-id]').style.position : null,
    firstRowComputedPosition: first && first.closest('[data-session-id]')
      ? getComputedStyle(first.closest('[data-session-id]')).position : null,
    dotParentTag: first ? first.parentElement.tagName : null,
  };
})()`;

const a = await session.evaluate(probe);
console.log('T0:', JSON.stringify(a, null, 2));

// Wait, then probe again. If the count climbs back from 0, something is still
// repainting; if it stays, they are inert leftovers.
for (const wait of [3000, 6000, 6000]) {
  await new Promise((r) => setTimeout(r, wait));
  const b = await session.evaluate(probe);
  console.log(`+${wait}ms: dotCount=${b.dotCount} api=${b.apiInstalled} style=${b.stylePresent}`);
  if (b.dotCount !== a.dotCount) {
    console.log('  -> count CHANGED, something is still repainting');
  }
}

// Nuke every dot by hand, bypassing the api, and re-probe.
const forced = await session.evaluate(`(() => {
  const n = document.querySelectorAll('[data-mmx-dot]').length;
  document.querySelectorAll('[data-mmx-dot]').forEach(d => d.remove());
  const st = document.getElementById('mmx-status-style');
  if (st) st.remove();
  document.querySelectorAll('[data-session-id]').forEach(r => { if (r.style.position === 'relative') r.style.position = ''; });
  return { removed: n, left: document.querySelectorAll('[data-mmx-dot]').length };
})()`);
console.log('forced removal:', JSON.stringify(forced));
await new Promise((r) => setTimeout(r, 5000));
const c = await session.evaluate(probe);
console.log('after forced +5s:', JSON.stringify({ dotCount: c.dotCount, api: c.apiInstalled, style: c.stylePresent }));

session.close();
