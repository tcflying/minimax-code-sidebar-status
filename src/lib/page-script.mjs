// mmx-status :: lib/page-script.mjs
// Builds the JavaScript that is evaluated inside the MiniMax Code renderer.
//
// The page-side code is intentionally self-contained and idempotent:
//  - every node it creates is tagged with data-mmx-dot so it can be found and
//    removed later (full reversibility, no app.asar change);
//  - a MutationObserver re-applies the dots whenever React re-renders the
//    sidebar, because React will happily blow away unknown children;
//  - it never deletes or rewrites a node the app owns.

export const MARK = 'data-mmx-dot';
export const STYLE_ID = 'mmx-status-style';
export const GLOBAL = '__mmxStatus';

const PAGE_FN = String.raw`
function __mmxStatusMain(cfg) {
  var MARK = cfg.mark;
  var GLOBAL = cfg.global;
  var previous = window[GLOBAL];
  if (previous && typeof previous.dispose === 'function') previous.dispose();

  // The app://./archon target exists as soon as the renderer process is up, but
  // the document may still have no body. Observing null throws a TypeError and
  // kills the whole bootstrap, so wait for a real mount point first.
  function mountPoint(timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.body) return document.body;
      if (document.documentElement) return document.documentElement;
      sleepSync(50);
    }
    return null;
  }
  // Busy-wait helper: the page-side code must stay synchronous because
  // Runtime.evaluate is invoked without awaiting a promise in some paths.
  function sleepSync(ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }

  var mount = mountPoint(15000);
  if (!mount) return { ok: false, reason: 'no-document-body' };

  // ---------- styles ----------
  var style = document.getElementById(cfg.styleId);
  if (!style) {
    style = document.createElement('style');
    style.id = cfg.styleId;
    style.textContent = [
      '[' + MARK + ']{',
      '  position:absolute;',
      '  left:' + cfg.offsetX + 'px;',
      '  top:50%;',
      '  transform:translateY(-50%);',
      '  width:6px;height:6px;border-radius:9999px;',
      '  pointer-events:none;',
      '  box-shadow:0 0 0 2px var(--bg-bg_grouped_tertiary, transparent);',
      '}',
      '[' + MARK + '][data-mmx-bucket="running"]{ background:var(--green_400,#22c55e); }',
      '[' + MARK + '][data-mmx-bucket="running"]::after{',
      '  content:"";position:absolute;inset:-3px;border-radius:9999px;',
      '  background:inherit;opacity:.35;',
      '  animation:__mmxPulse 1.4s ease-in-out infinite;',
      '}',
      '@keyframes __mmxPulse{0%,100%{transform:scale(.7);opacity:.45}50%{transform:scale(1.25);opacity:.08}}',
      '[' + MARK + '][data-mmx-bucket="paused"]{ background:var(--orange_400,#f59e0b); }',
      '[' + MARK + '][data-mmx-bucket="error"]{ background:var(--red_400,#ef4444); }',
      '[' + MARK + '][data-mmx-bucket="done"]{ background:var(--gray_400,#9ca3af); }'
    ].join('\n');
    (document.head || mount).appendChild(style);
  }

  // ---------- helpers ----------
  // Rows whose INLINE position this script changed. Only these are restored,
  // so we never clobber a value the host application set itself.
  var touched = new Set();

  function bucketsOf(row) {
    // A row may carry more than one session node (pinned + grouped copies).
    return row.getAttribute('data-session-id');
  }

  function ensureDot(row) {
    var dot = row.querySelector('[' + MARK + ']');
    if (dot) return dot;
    dot = document.createElement('span');
    dot.setAttribute(MARK, '1');
    row.appendChild(dot);
    return dot;
  }

  function apply() {
    if (disposed) return { rows: 0, painted: 0, matched: 0, removed: 0, skipped: 'disposed' };
    var map = cfg.status || {};
    var scope = cfg.scope ? document.querySelectorAll(cfg.scope) : null;
    var rows = document.querySelectorAll('[data-session-id]');
    var stats = { rows: 0, painted: 0, matched: 0, removed: 0, unknownIds: 0 };

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = bucketsOf(row);
      if (!id) continue;
      if (scope && !row.matches(cfg.scope)) continue;
      stats.rows++;

      var bucket = map[id];
      // The "done" bucket is opt-in: hundreds of grey dots drown the three
      // states that actually matter (green running / yellow paused / red error).
      if (bucket === 'done' && !cfg.showDone) bucket = undefined;
      var existing = row.querySelector('[' + MARK + ']');
      if (!bucket) {
        if (existing) { existing.remove(); stats.removed++; }
        continue;
      }
      stats.matched++;
      if (getComputedStyle(row).position === 'static') {
        row.style.position = 'relative';
        // Remember the rows whose INLINE position WE changed, so dispose()
        // can restore exactly those and never touch the host's own value.
        touched.add(row);
      }
      var dot = ensureDot(row);
      if (dot.getAttribute('data-mmx-bucket') !== bucket) {
        dot.setAttribute('data-mmx-bucket', bucket);
        stats.painted++;
      }
    }

    // The sidebar is virtualised, so rows are constantly created and destroyed.
    // Drop detached rows from the bookkeeping Set, otherwise a long-running
    // daemon would pin every row it ever touched in memory.
    if (touched.size > 64) {
      var live = [];
      touched.forEach(function (r) { if (r.isConnected) live.push(r); });
      touched.clear();
      for (var t2 = 0; t2 < live.length; t2++) touched.add(live[t2]);
      stats.pruned = live.length;
    }
    return stats;
  }

  // ---------- debounce ----------
  // The disposed flag is checked by BOTH apply() and scheduleApply(). Without
  // it, a requestAnimationFrame that the MutationObserver already queued before
  // dispose() fires AFTER the cleanup and repaints every dot, leaving a frozen
  // set of orphans behind (observed live: dispose reported removed:80 while 80
  // dots were still in the DOM).
  var disposed = false;
  var rafId = 0;
  var pending = false;
  function scheduleApply() {
    if (disposed || pending) return;
    pending = true;
    rafId = requestAnimationFrame(function () {
      pending = false;
      rafId = 0;
      if (disposed) return;
      try {
        apply();
        // The guard runs alongside the paint pass so an app-driven expansion is
        // reverted on the very same frame React produced it.
        try { api.enforceNoAutoExpand(); } catch (e) { /* never break the host app */ }
      } catch (e) { /* never break the host app */ }
    });
  }

  var observer = new MutationObserver(scheduleApply);
  observer.observe(mount, {
    childList: true,
    subtree: true,
    characterData: false,
  });

  // ---------------------------------------------------------------------
  // "Never expand, at all" guard.
  //
  // Verified against the real app: MiniMax Code expands a pinned session when
  //   (a) it gains a running child, with no user action, and
  //   (b) the user clicks the row / the title / the caret.
  // The user has stated repeatedly that NO expansion is ever wanted, so there
  // is no exemption for "the user asked for it": every expansion is reverted.
  // Escape hatch: start the daemon with --no-collapse.
  // ---------------------------------------------------------------------
  function caretOf(el) {
    return el.querySelector('[class*="transition-transform"]');
  }
  function isExpanded(el) {
    var c = caretOf(el);
    if (!c) return false;
    return String(c.getAttribute('class') || '').indexOf('-rotate-90') < 0;
  }
  function clickCaret(el) {
    var c = caretOf(el);
    if (!c) return false;
    var btn = c.closest('button,[role="button"]') || c.parentElement;
    if (!btn || typeof btn.click !== 'function') return false;
    btn.click();
    return true;
  }

  function enforceNoAutoExpand() {
    if (!cfg.collapseOnStart) return { collapsed: 0, skipped: 'disabled' };
    var sec = document.querySelector('[data-pinned-section]');
    if (!sec) return { collapsed: 0, reason: 'no-pinned-section' };
    var rows = sec.querySelectorAll('[data-session-id]');
    var collapsed = 0;
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i];
      if (!caretOf(el)) continue;
      if (!isExpanded(el)) continue;
      if (el.getBoundingClientRect().height <= 40) continue; // already collapsed
      if (clickCaret(el)) collapsed++;
    }
    return { collapsed: collapsed };
  }

  var handler = function () { scheduleApply(); };
  window.addEventListener('mavis:status-refresh', handler);
  var timer = window.setInterval(scheduleApply, cfg.intervalMs || 3000);

  var api = {
    cfg: cfg,
    mount: mount,
    apply: apply,
    enforceNoAutoExpand: enforceNoAutoExpand,
    refresh: function (nextStatus) { cfg.status = nextStatus || {}; apply(); return enforceNoAutoExpand(); },
    dispose: function () {
      disposed = true;
      try { observer.disconnect(); } catch (e) {}
      window.removeEventListener('mavis:status-refresh', handler);
      window.clearInterval(timer);
      if (rafId) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
      pending = false;
      var dots = document.querySelectorAll('[' + MARK + ']');
      for (var i = 0; i < dots.length; i++) dots[i].remove();
      var st = document.getElementById(cfg.styleId);
      if (st) st.remove();
      var restored = 0;
      touched.forEach(function (row) {
        if (row && row.isConnected) { row.style.position = ''; restored++; }
      });
      touched.clear();
      delete window[GLOBAL];
      return { removed: dots.length, restored: restored, disposed: true };
    },
  };

  window[GLOBAL] = api;
  var initial = apply();
  var collapseResult = enforceNoAutoExpand();
  return { ok: true, initial: initial, collapse: collapseResult };
}
`;

export function buildBootstrapExpression(cfg) {
  const full = {
    mark: MARK,
    styleId: STYLE_ID,
    global: GLOBAL,
    offsetX: 4,
    intervalMs: 3000,
    scope: '',
    showDone: false,
    collapseOnStart: true,
    status: {},
    ...cfg,
  };
  return `(${PAGE_FN})(${JSON.stringify(full)})`;
}

export function buildRefreshExpression(statusMap) {
  return `(function(){var a=window.${GLOBAL};if(!a)return {ok:false,reason:'not-installed'};return {ok:true,stats:a.refresh(${JSON.stringify(statusMap)})};})()`;
}

export function buildDisposeExpression() {
  return `(function(){var a=window.${GLOBAL};if(!a)return {ok:true,removed:0,reason:'not-installed'};return {ok:true,removed:a.dispose().removed};})()`;
}

/** Read-only probe: tells us what the real DOM actually looks like. */
export function buildProbeExpression() {
  return `(function(){
    var rows = document.querySelectorAll('[data-session-id]');
    var sample = [];
    for (var i = 0; i < Math.min(rows.length, 5); i++) {
      var r = rows[i];
      sample.push({
        id: r.getAttribute('data-session-id'),
        tag: r.tagName,
        className: String(r.getAttribute('class') || '').slice(0, 160),
        text: String(r.textContent || '').trim().slice(0, 60),
        inPinned: !!r.closest('[data-pinned-section]'),
        parentClass: String((r.parentElement && r.parentElement.getAttribute('class')) || '').slice(0, 120),
      });
    }
    var pinned = document.querySelectorAll('[data-pinned-section] [data-session-id]').length;
    return {
      url: location.href,
      title: document.title,
      totalRows: rows.length,
      pinnedRows: pinned,
      hasPinnedSection: !!document.querySelector('[data-pinned-section]'),
      sample: sample,
    };
  })()`;
}
