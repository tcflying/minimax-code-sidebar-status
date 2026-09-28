// One-shot end-to-end probe: does the CDP injection actually exist in the live page?
// Read-only: it never mutates the app. Run: node check-inject.mjs [port]
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';

const port = Number(process.argv[2] || 9331);

const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) {
  console.log(JSON.stringify({ ok: false, reason: 'no archon target', targets: targets.map((t) => t.url) }, null, 2));
  process.exit(1);
}

const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

const probe = await s.evaluate(`(() => {
  const dots = Array.from(document.querySelectorAll('[data-mmx-dot]'));
  const byBucket = {};
  for (const d of dots) {
    const b = d.getAttribute('data-mmx-bucket') || '(none)';
    byBucket[b] = (byBucket[b] || 0) + 1;
  }

  // Dot must be attached to a real session row, not floating in a detached tree.
  const attached = dots.filter((d) => {
    const row = d.closest('[data-session-id]');
    return !!row;
  }).length;

  // Chevron carries -rotate-90 when collapsed; without it the group is EXPANDED.
  const chevrons = Array.from(document.querySelectorAll('[data-session-id] *'))
    .filter((e) => typeof e.className === 'string' && e.className.includes('transition-transform'));
  const expanded = chevrons.filter((c) => !c.className.includes('-rotate-90')).length;
  const collapsed = chevrons.length - expanded;

  // Selected row: bare (non hover:) tertiary class.
  const selectedBtn = document.querySelector(
    'button.bg-bg_interaction_tertiary_hover'
  );
  const selStyle = selectedBtn ? getComputedStyle(selectedBtn) : null;

  const rows = document.querySelectorAll('[data-session-id]').length;
  const pinned = document.querySelectorAll('[data-pinned-section] [data-session-id]').length;

  // Row heights: 30 = collapsed single line.
  const heights = {};
  for (const r of Array.from(document.querySelectorAll('[data-session-id]')).slice(0, 400)) {
    const h = Math.round(r.getBoundingClientRect().height);
    heights[h] = (heights[h] || 0) + 1;
  }

  return {
    url: location.href,
    globalFlag: typeof window.__mmxStatus,
    styleInjected: !!document.getElementById('mmx-status-style'),
    totalRows: rows,
    pinnedRows: pinned,
    dotTotal: dots.length,
    dotByBucket: byBucket,
    dotsAttachedToSessionRow: attached,
    dotsDetached: dots.length - attached,
    chevrons: chevrons.length,
    expandedGroups: expanded,
    collapsedGroups: collapsed,
    selectedRowFound: !!selectedBtn,
    selectedBg: selStyle ? selStyle.backgroundColor : null,
    selectedBoxShadow: selStyle ? selStyle.boxShadow : null,
    selectedBorderLeft: selStyle ? selStyle.borderLeftWidth + ' ' + selStyle.borderLeftColor : null,
    rowHeightHistogram: heights,
  };
})()`);

console.log(JSON.stringify(probe, null, 2));
s.close();
