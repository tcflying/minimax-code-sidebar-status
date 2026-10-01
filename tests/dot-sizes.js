(() => {
  const out = { buckets: {}, runningBar: null, runningRowBg: null, neighbourBgs: [] };
  const dots = Array.from(document.querySelectorAll('[data-mmx-dot]'));
  const byBucket = {};
  for (const d of dots) {
    const b = d.getAttribute('data-mmx-bucket') || '(none)';
    (byBucket[b] = byBucket[b] || []).push(d);
  }
  for (const [b, list] of Object.entries(byBucket)) {
    const first = list[0];
    const cs = getComputedStyle(first);
    out.buckets[b] = {
      count: list.length,
      width: cs.width,
      height: cs.height,
      borderRadius: cs.borderRadius,
      background: cs.backgroundColor,
    };
  }
  // running 行：量左侧竖条 + 整行底色
  const runRow = document.querySelector('[data-mmx-dot][data-mmx-bucket="running"]');
  if (runRow) {
    const row = runRow.closest('[data-session-id]');
    out.runningRowBg = row ? getComputedStyle(row).backgroundColor : null;
    if (row && row.parentElement && row.parentElement.children.length > 2) {
      const sibs = Array.from(row.parentElement.children);
      const i = sibs.indexOf(row);
      for (let k = 1; k <= 3; k++) {
        const s = sibs[i + k];
        if (!s) break;
        const sr = s.querySelector('[data-session-id]') || s;
        out.neighbourBgs.push(getComputedStyle(sr).backgroundColor);
      }
    }
  }
  return out;
})()
