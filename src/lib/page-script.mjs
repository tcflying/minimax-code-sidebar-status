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
export const SUMMARY_ID = 'mmx-running-summary';

const PAGE_FN = String.raw`
function __mmxStatusMain(cfg) {
  var MARK = cfg.mark;
  var GLOBAL = cfg.global;
  var SUMMARY_ID = cfg.summaryId;
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
      // ---- base dot (paused / error / done) -------------------------------
      // Small and quiet on purpose. Measured on the real sidebar: 66 paused +
      // 21 error against 1 running. When every state is the same shape, the
      // one row the user actually cares about is outvoted by 87 grey peers.
      '[' + MARK + ']{',
      '  position:absolute;',
      '  left:' + cfg.offsetX + 'px;',
      '  top:50%;',
      '  transform:translateY(-50%);',
      '  width:6px;height:6px;border-radius:9999px;',
      '  pointer-events:none;',
      '}',
      '[' + MARK + '][data-mmx-bucket="paused"]{ background:var(--orange_400,#f59e0b); }',
      '[' + MARK + '][data-mmx-bucket="error"]{ background:var(--red_400,#ef4444); width:8px;height:8px; }',
      '[' + MARK + '][data-mmx-bucket="done"]{ background:var(--gray_400,#9ca3af); }',

      // ---- RUNNING: a different SHAPE, not just a different colour --------
      // A full-height glowing bar on the row's left edge. Shape difference is
      // what makes it separable in a 500-row list; colour alone is not, because
      // the neighbouring rows are already full of saturated yellow stars.
      '[' + MARK + '][data-mmx-bucket="running"]{',
      '  width:4px;height:calc(100% - 6px);',
      '  top:3px;transform:none;',
      '  border-radius:9999px;',
      '  background:linear-gradient(180deg,#4ade80,#16a34a);',
      '  box-shadow:0 0 6px 1px rgba(34,197,94,.75);',
      '  animation:__mmxBar 1.6s ease-in-out infinite;',
      // The selected-row rule paints its own 3px inset blue bar on the button.
      // When the selected row is ALSO running, that blue covers the green bar
      // and hides the one signal the user most needs. Lift the green above it.
      '  z-index:3;',
      '}',
      '[' + MARK + '][data-mmx-bucket="running"]::after{',
      '  content:"";position:absolute;inset:-2px -1px;border-radius:9999px;',
      '  background:inherit;opacity:.30;',
      '  animation:__mmxBar 1.6s ease-in-out infinite;',
      '}',
      '@keyframes __mmxBar{0%,100%{opacity:.55}50%{opacity:1}}',

      // ---- RUNNING row: tinted background + tinted title ------------------
      // Second, independent signal: it survives when the bar is scrolled to the
      // edge, and it is readable when the sidebar is collapsed to titles only.
      // Only :has() targets the row itself. A sibling selector such as
      // [MARK][running] ~ * would tint every later sibling in the same
      // container and light up unrelated rows.
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="running"]){',
      '  background-color:rgba(34,197,94,.10);',
      '}',
      // The row is a wrapper; the tappable element is a BUTTON nested inside
      // .mavis-dropdown, i.e. a DESCENDANT, not a direct child. A
      // "> ... button" or a shallow match leaves the title colour untouched,
      // which is exactly what the live measurement showed before this fix.
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="running"]) button,' +
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="running"]) button *{',
      '  color:#15803d;',
      '}',
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="running"]) button:hover{',
      '  background-color:rgba(34,197,94,.16);',
      '}',

      // ---- WAITING: the turn is over, but something it owns is still going -
      // Same bar geometry as running, so the eye reads it as the same kind of
      // important; different hue, so it is never confused with the paused
      // bucket. (NB: no backticks anywhere in this comment -- this block lives
      // inside a String.raw template, and one stray backtick ends it. That is
      // not a style preference, it is a syntax error.)
      //
      // The hue choice is forced: the paused bucket is var(--orange_400,
      // #f59e0b), an amber. A naive yellow (#facc15 / #eab308) sits right next
      // to it. So the gradient runs yellow-300 -> yellow-500 while the row tint
      // and the glow use the yellow-500 hue (rgb(234,179,8)) at the SAME
      // 10%/16% alpha as running green, keeping the two equally weighted.
      //
      // Theme awareness: the title colour goes through var(--yellow_700,...)
      // the same way the other dots go through var(--orange_400,...), so it
      // follows the app's own palette instead of hardcoding for one theme. The
      // tints are semi-transparent, so they composite on both backgrounds.
      '[' + MARK + '][data-mmx-bucket="waiting"]{',
      '  width:4px;height:calc(100% - 6px);',
      '  top:3px;transform:none;',
      '  border-radius:9999px;',
      '  background:linear-gradient(180deg,#fde047,#eab308);',
      '  box-shadow:0 0 6px 1px rgba(234,179,8,.70);',
      // Slower than running on purpose: this row is not doing anything itself,
      // it is only holding a placeholder while a child works. It should read
      // as a steady beacon, not as urgent as a row that is actively working.
      '  animation:__mmxBar 2.2s ease-in-out infinite;',
      '  z-index:3;',
      '}',
      '[' + MARK + '][data-mmx-bucket="waiting"]::after{',
      '  content:"";position:absolute;inset:-2px -1px;border-radius:9999px;',
      '  background:inherit;opacity:.30;',
      '  animation:__mmxBar 2.2s ease-in-out infinite;',
      '}',
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="waiting"]){',
      '  background-color:rgba(234,179,8,.10);',
      '}',
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="waiting"]) button,' +
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="waiting"]) button *{',
      '  color:var(--yellow_700,#a16207);',
      '}',
      '[data-session-id]:has(> [' + MARK + '][data-mmx-bucket="waiting"]) button:hover{',
      '  background-color:rgba(234,179,8,.16);',
      '}',

      // ---- running summary bar (count, without reordering anything) -------
      // Reordering the sidebar was evaluated and REJECTED: the list container
      // is display:block (not flex/grid) and every row is wrapped in its own
      // single-child div, so the CSS order property cannot reach it, and moving
      // nodes fights React over a virtualised, grid-animated tree. A count gives
      // the same "how much is running" answer without touching list order.
      '#' + SUMMARY_ID + '{',
      '  display:flex;align-items:center;gap:7px;',
      '  height:23px;margin:0 0 3px 6px;padding:0 9px;',
      '  border-radius:7px;',
      '  background:rgba(34,197,94,.16);',
      '  box-shadow:inset 0 0 0 1px rgba(34,197,94,.45);',
      '  color:#15803d;font-size:11px;font-weight:600;',
      '  pointer-events:none;white-space:nowrap;',
      '}',
      '#' + SUMMARY_ID + '[data-mmx-empty="1"]{ display:none; }',
      // A blinking vertical bar reads as "live" far faster than a dot that
      // just pulses in size: step-end gives a hard on/off edge the eye locks
      // onto, while a smooth fade just looks like a slow pulse that blends
      // into the row noise.
      '#' + SUMMARY_ID + ' i{',
      '  width:3px;height:13px;border-radius:2px;flex:none;',
      '  background:linear-gradient(#4ade80,#16a34a);',
      '  box-shadow:0 0 5px rgba(34,197,94,.7);',
      '  animation:__mmxBlink 1.2s step-end infinite;',
      '}',
      '@keyframes __mmxBlink{ 0%,55%{opacity:1} 56%,100%{opacity:.2} }',
      '#' + SUMMARY_ID + ' b{ font-weight:700; }',
      // The waiting counter is a second segment in the same bar. It is tinted
      // with the same yellow as the row itself so the number, the row and the
      // bar all read as one signal. It keeps the bar's own font metrics and
      // only changes colour, so nothing shifts when the counts change.
      '#' + SUMMARY_ID + ' [data-mmx-wait]{',
      '  display:inline-flex;align-items:center;gap:4px;',
      '  margin-left:9px;padding-left:9px;',
      '  border-left:1px solid rgba(234,179,8,.45);',
      '  color:var(--yellow_700,#a16207);',
      '}',

      // ---- selected (active) session row background override ----
      // The app marks the selected row by putting a BARE class
      // bg-bg_interaction_tertiary_hover on the row's button element, while
      // unselected rows only carry the hover: variant of the same class name
      // (whose class string contains that substring, hence the :not() guard).
      // Verified live: selected => rgba(10,10,10,0.04) on a bare class.
      '[data-session-id] button.bg-bg_interaction_tertiary_hover'
        + ':not([class*="hover:bg-bg_interaction_tertiary_hover"]){',
      '  background-color: var(--mmx-active-bg) !important;',
      '  box-shadow: inset 3px 0 0 0 var(--mmx-active-bar, transparent);',
      '}',
      '[data-session-id] button.bg-bg_interaction_tertiary_hover'
        + ':not([class*="hover:bg-bg_interaction_tertiary_hover"]):hover{',
      '  background-color: var(--mmx-active-bg-hover) !important;',
      '}',
      ':root{',
      '  --mmx-active-bg: ' + cfg.activeBg + ';',
      '  --mmx-active-bg-hover: ' + cfg.activeBgHover + ';',
      '  --mmx-active-bar: ' + cfg.activeBar + ';',
      '}',
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

  // ---------------------------------------------------------------------
  // Running summary bar.
  //
  // Inserted directly after the pinned section's HEADER row, never inside the
  // grid/collapse container: that container is a display:grid whose height is
  // driven by transition-[grid-template-rows,opacity], so a child added there
  // corrupts the collapse animation.
  //
  // Rows can be re-rendered at any time, so the node is re-found by id on
  // every pass instead of being cached.
  // ---------------------------------------------------------------------
  function ensureSummary() {
    var sec = document.querySelector('[data-pinned-section]');
    if (!sec) return null;
    var bar = document.getElementById(SUMMARY_ID);
    if (bar && bar.parentElement === sec) return bar;
    if (bar) bar.remove();
    // Header is the first child (30px flex row); the list is the grid that
    // follows. Insert between them.
    var header = sec.firstElementChild;
    bar = document.createElement('div');
    bar.id = SUMMARY_ID;
    // No innerHTML: the selftest bans destructive DOM writes, and assigning
    // innerHTML to a node inside a React-owned tree is exactly the kind of
    // thing that gets silently reverted on the next render.
    var pip = document.createElement('i');
    var label = document.createElement('span');
    var num = document.createElement('b');
    num.textContent = '0';
    label.appendChild(num);
    label.appendChild(document.createTextNode(' 个运行中'));
    // Second segment for the waiting bucket. Built once and reused, never
    // innerHTML (the selftest bans destructive DOM writes).
    var wait = document.createElement('span');
    wait.setAttribute('data-mmx-wait', '1');
    var waitNum = document.createElement('b');
    waitNum.textContent = '0';
    wait.appendChild(waitNum);
    wait.appendChild(document.createTextNode(' 个在等子任务'));
    wait.style.display = 'none';
    bar.appendChild(pip);
    bar.appendChild(label);
    bar.appendChild(wait);
    if (header && header.nextSibling) {
      sec.insertBefore(bar, header.nextSibling);
    } else {
      sec.appendChild(bar);
    }
    return bar;
  }

  function updateSummary(runningOnScreen, waitingOnScreen) {
    var bar = ensureSummary();
    if (!bar) return;
    // Count only what the user can actually see right now, not the database
    // total: a running session scrolled out of the virtualised list is not
    // something they can act on by looking.
    //
    // runningOnScreen ALREADY includes cloud rows. apply() increments it for
    // every running bucket regardless of which source produced it, because a
    // cloud running row is painted with the exact same green bar and green
    // tint as a local one. So the bar keeps its two segments: the "running"
    // number is local + cloud, and the empty predicate below therefore hides
    // the bar only when local AND cloud are both zero. Passing a third
    // argument here and summing it separately was rejected: it would show the
    // user two numbers for one state.
    var n = runningOnScreen || 0;
    var w = waitingOnScreen || 0;
    var b = bar.querySelector('b');
    if (b && b.textContent !== String(n)) b.textContent = String(n);
    // Only touch the waiting segment when its value actually changed, and keep
    // it out of the layout entirely when zero so a single running session does
    // not drag a stray "0 个在等子任务" along the sidebar.
    var seg = bar.querySelector('[data-mmx-wait]');
    if (seg) {
      var wb = seg.querySelector('b');
      if (wb && wb.textContent !== String(w)) wb.textContent = String(w);
      var want = w === 0 ? 'none' : '';
      if (seg.style.display !== want) seg.style.display = want;
    }
    bar.setAttribute('data-mmx-empty', n === 0 && w === 0 ? '1' : '0');
  }

  // ---------------------------------------------------------------------
  // Hoist running rows.
  //
  // Requirement (measured from the user): it is enough to move a row once,
  // when it STARTS running. Not to keep re-sorting every pass. So this is
  // event-shaped, not state-shaped: we hash which wrappers currently hold a
  // running row, and do nothing at all while that hash is unchanged.
  //
  // Two safety properties, both learned the hard way on 2026-10-02:
  //  1. We move nodes with insertBefore. An earlier version instead forced
  //     display:flex onto the container and used CSS order. That is far more
  //     invasive -- it relayouts the host's whole subtree -- and a loose
  //     container test marked 87 elements instead of 1, which pinned a core
  //     in a reflow loop and froze the page. No host layout is touched now.
  //  2. A hard ceiling on how many containers we will act on. If the
  //     container test ever goes wrong again, we refuse to touch anything
  //     instead of wrecking the page.
  // ---------------------------------------------------------------------
  // Two independent ceilings, because they guard different things:
  //  - ROOTS guards "did I misidentify the structure?" The sidebar really
  //    does contain many per-project sub-lists: measured 72 of them, all
  //    class "space-y-px", all outside the viewport. So a small root ceiling
  //    is not a safety feature, it is just wrong.
  //  - MOVES guards "am I about to churn the DOM?" That is the real risk, and
  //    it scales with how many nodes we relocate in one pass, not with how
  //    many lists exist.
  var REORDER_MAX_ROOTS = 128;
  // 16 -> 32. Adding the waiting bucket widened the selected set from
  // "running only" to "running + waiting", so the same ceiling is now reached
  // by roughly twice as many sessions.
  //
  // Known and accepted: the budget is enforced *during* the move loop, so
  // exhausting it returns mid-pass and leaves the list partially reordered --
  // measured at 18 selected rows: moved=16, aborted='move-budget-exhausted',
  // and the resulting order is scrambled rather than merely incomplete. It
  // cannot corrupt data and the aborted field reports it honestly, but the
  // order is wrong until the next pass succeeds.
  //
  // Not fixed here on purpose. An all-or-nothing pre-check (simulate the
  // back-to-front insertBefore sequence before mutating anything) is the real
  // fix, but it means rewriting the move loop itself -- the most fragile code
  // in this file, and the one place where a mistake visibly wrecks the user's
  // sidebar. The ceiling only trips at 33+ simultaneously active sessions
  // (measured peak on this machine: 5), so the risk is documented rather than
  // paid for. Revisit if a burst that large ever shows up in the logs.
  var REORDER_MAX_MOVES = 32;
  // Sentinel, NOT ''. The key is empty when nothing is running, so seeding
  // this with '' made "nothing running" and "never looked yet" the same
  // value, and the very first transition (idle -> first session starts)
  // was swallowed as "unchanged". Verified in the sandbox: a row flipped to
  // running, apply() ran, and the hoister reported unchanged:true and moved
  // nothing.
  var lastReorderKey = '__mmx_uninitialised__';

  function findListRoots() {
    var rows = document.querySelectorAll('[data-session-id]');
    var roots = [];
    for (var i = 0; i < rows.length; i++) {
      var n = rows[i].parentElement;
      for (var d = 0; n && d < 6; d++) {
        var kids = n.children.length;
        if (kids > 3) {
          var withRow = 0;
          for (var k = 0; k < kids; k++) {
            var c = n.children[k];
            if (c.hasAttribute && c.hasAttribute('data-session-id')) withRow++;
            else if (c.querySelector && c.querySelector('[data-session-id]')) withRow++;
          }
          // Tolerance, not equality. The pinned section's list measured
          // kids=7 / withRow=6: one extra direct child is the collapse
          // control, not a row. A strict "every child is a row" test silently
          // skipped the ONE list the user actually cares about, and the
          // reordered containers were only the per-project sub-lists.
          //
          // Allowing one non-row child is safe precisely because the move
          // budget below caps how many nodes we ever relocate, and because
          // we only ever touch containers that actually contain a running
          // row -- 100 matched containers with 3 running rows still means
          // 3 node moves, not a layout-wide change.
          if (withRow >= kids - 1) { if (roots.indexOf(n) < 0) roots.push(n); break; }
        }
        n = n.parentElement;
      }
    }
    return roots;
  }

  function applyReorder() {
    if (!cfg.reorder) return { moved: 0, roots: 0, skipped: 'disabled' };
    var roots = findListRoots();
    if (roots.length > REORDER_MAX_ROOTS) {
      return { moved: 0, roots: roots.length, aborted: 'too-many-roots' };
    }

    var key = '';
    var plans = [];
    for (var r = 0; r < roots.length; r++) {
      var root = roots[r];
      // Running rows first, then waiting rows; each group keeps its own
      // original relative order, because the move loop below runs
      // back-to-front. Concatenating the two groups in that order is what
      // produces [all running][all waiting] at the head in a single pass.
      var runW = [];
      var waitW = [];
      for (var k = 0; k < root.children.length; k++) {
        var w = root.children[k];
        var row = w.querySelector && w.querySelector('[data-session-id]');
        if (!row) continue;
        if (row.querySelector('[' + MARK + '][data-mmx-bucket="running"]')) {
          runW.push(w);
        } else if (row.querySelector('[' + MARK + '][data-mmx-bucket="waiting"]')) {
          waitW.push(w);
        }
      }
      var wrappers = runW.concat(waitW);
      if (!wrappers.length) continue;
      key += r + ':' + Array.prototype.map.call(wrappers, function (w) {
        return Array.prototype.indexOf.call(root.children, w);
      }).join(',') + ';';
      plans.push({ root: root, wrappers: wrappers });
    }

    // Nothing started or stopped since last pass -- do not touch the DOM.
    if (key === lastReorderKey) return { moved: 0, roots: roots.length, unchanged: true };
    lastReorderKey = key;

    var moved = 0;
    for (var p = 0; p < plans.length; p++) {
      var root = plans[p].root;
      var ws = plans[p].wrappers;
      // Back to front, so the original relative order of several running rows
      // is preserved once they are all at the head.
      for (var i = ws.length - 1; i >= 0; i--) {
        if (moved >= REORDER_MAX_MOVES) {
          return { moved: moved, roots: roots.length, runningLists: plans.length, aborted: 'move-budget-exhausted' };
        }
        var w = ws[i];
        if (root.firstElementChild === w) continue;
        root.insertBefore(w, root.firstElementChild);
        moved++;
      }
    }
    return { moved: moved, roots: roots.length, runningLists: plans.length };
  }

  // ---- cloud session accumulator -----------------------------------------
  // The sidebar has a Local / Cloud switch. In the CLOUD view the
  // data-session-id values are bare digits (measured 2026-10-02:
  // 447993841729699) and do not exist in local_runtime_sessions, so
  // cfg.status has no entry for them and no dot was ever painted there.
  //
  // Source of truth is the host's own event bus store,
  // window.__MAVIS_EVENT_BUS_STORE__ (zustand; getState() exposes events,
  // unreadCount, panelOpen, connections, connected, reconnectGeneration).
  //
  // CRITICAL: getState().events is a ROLLING window capped at 200 entries
  // (measured: 200 = 11 cloud + 189 local). Reading that array once at
  // mount is useless, because a cloud session that started minutes ago is
  // already evicted and we would never learn about it. So we SUBSCRIBE and
  // accumulate into a Map we own. The Map only holds ids we still believe
  // are active, which is why losing old window entries cannot lose state.
  //
  // Degradation is silent and total: an older host build or a sandboxed
  // renderer simply has no store, and then this whole section contributes
  // nothing while the local path keeps working untouched.
  var CLOUD_STORE = '__MAVIS_EVENT_BUS_STORE__';
  // Leak guard, same spirit as the reorder ceilings below. The Map only grows
  // on session.start and only shrinks on finish/abort, so a dropped terminal
  // event would leave one entry behind forever. Cap it and drop the oldest
  // insertions first; 64 is far above the concurrent cloud sessions the user
  // can plausibly have open.
  //
  // Above 64 CONCURRENT cloud sessions that ceiling really does drop a live
  // session, which then stops getting a dot until its next event. That is an
  // honest consequence of the cap, so every drop is counted rather than
  // swallowed: a silent drop would only ever surface as "some row lost its
  // dot", which is unsearchable. Read cloudEvicted through api.cloudState()
  // and apply()'s stats.
  var CLOUD_MAX_TRACKED = 64;
  var cloudEvicted = 0;
  var cloudState = new Map();
  var unsubCloud = null;

  // Cloud has exactly four states (source enum Idle:0 Started:1 Error:2
  // Abort:3) and no paused and no waiting-on-a-child concept, so it maps
  // onto buckets the local side ALREADY has. It deliberately introduces no
  // new bucket:
  //   session.start        -> running (green bar, same shape as local)
  //   session.error        -> error   (red)
  //   session.finish/abort -> removed from the Map, i.e. NO dot. Local does
  //     the same for aborted: it only paints paused under includeAborted
  //     (--show-aborted), which the daemon does not set by default. A dotted
  //     finished cloud row would be a state the local path cannot produce.
  //   anything else        -> ignored (created / title_updated /
  //     pinned_updated carry no status meaning)
  function cloudBucketFor(type) {
    if (type === 'session.start') return 'running';
    if (type === 'session.error') return 'error';
    if (type === 'session.finish' || type === 'session.abort') return null;
    return undefined;
  }

  function onCloudEvent(e) {
    if (disposed) return;
    try {
      if (!e || e.conversationSource !== 'cloud') return;
      var raw = e.payload && e.payload.sessionId;
      if (raw === null || raw === undefined) return;
      var id = String(raw);
      // Digits only. This doubles as the local/cloud key-space guard, so a
      // local id could never be mistaken for a cloud one here.
      if (!/^[0-9]+$/.test(id)) return;
      var b = cloudBucketFor(e.type);
      if (b === undefined) return;
      if (b === null) {
        cloudState.delete(id);
        return;
      }
      cloudState.set(id, b);
      while (cloudState.size > CLOUD_MAX_TRACKED) {
        cloudState.delete(cloudState.keys().next().value);
        cloudEvicted++;
      }
    } catch (err) { /* never break the host app */ }
  }

  // Tolerates both shapes: an array of events, or a whole store state whose
  // .events holds them.
  //
  // The second form is the one that actually fires. zustand subscribe() calls
  // its listener with (state, prevState), NOT with an individual event, so
  // subscribing onCloudEvent directly would hand it the state object, fail the
  // conversationSource test, and accumulate nothing at all. This is the entry
  // point that must be passed to subscribe().
  function ingestCloudState(state) {
    if (!state) return 0;
    var list = null;
    if (Object.prototype.toString.call(state) === '[object Array]') list = state;
    else if (state.events) list = state.events;
    if (!list || typeof list.length !== 'number') return 0;
    // OLDEST FIRST -- the replay has to run BACKWARDS on purpose.
    //
    // The host store PREPENDS. Measured 2026-10-02 from the store factory
    // inside the real app.asar, addEvent is:
    //   events: [{ ...t, conversationSource: s }, ...prev.events].slice(0, 200)
    // so index 0 is the NEWEST event and the tail is the oldest.
    //
    // Replaying that array forwards applies the OLDEST event LAST. For one
    // session that means its session.start (old, sitting in the tail) runs
    // after its own session.finish (new, at the head) and writes the row back
    // as running. Real symptom: a cloud session that has already finished
    // keeps a green running bar and stays counted in the summary bar's
    // "运行中" total until roughly 198 later local events push the stale
    // start out of the 200-entry window. Same shape for start -> error: the
    // stale start downgrades a red row back to green.
    //
    // Reverse order makes the accumulator replay in real chronological order,
    // so last-writer-wins is the host's actual newest event.
    for (var i = list.length - 1; i >= 0; i--) onCloudEvent(list[i]);
    return list.length;
  }

  function subscribeCloud() {
    try {
      var store = window[CLOUD_STORE];
      if (!store || typeof store.subscribe !== 'function') {
        return { subscribed: false, tracked: 0, reason: 'no-event-bus-store' };
      }
      // Replay the window that is still alive at mount so a bootstrap right
      // after a page reload does not report "nothing running" for one pass.
      // This is a bonus, not the mechanism: the subscription below is what
      // makes the Map survive the window rolling.
      if (typeof store.getState === 'function') ingestCloudState(store.getState());
      // ingestCloudState, NOT onCloudEvent: see the note above. The listener
      // receives the whole store state.
      unsubCloud = store.subscribe(ingestCloudState);
      return { subscribed: true, tracked: cloudState.size, reason: '' };
    } catch (err) {
      return { subscribed: false, tracked: cloudState.size, reason: 'subscribe-threw' };
    }
  }

  function disposeCloud() {
    disposed = true;
    if (unsubCloud) {
      try { unsubCloud(); } catch (e) {}
      unsubCloud = null;
    }
    cloudState.clear();
  }

  function apply() {
    if (disposed) return { rows: 0, painted: 0, matched: 0, removed: 0, skipped: 'disposed' };
    var map = cfg.status || {};
    var scope = cfg.scope ? document.querySelectorAll(cfg.scope) : null;
    var rows = document.querySelectorAll('[data-session-id]');
    var stats = { rows: 0, painted: 0, matched: 0, removed: 0, unknownIds: 0, runningOnScreen: 0, waitingOnScreen: 0, cloudOnScreen: 0, cloudTracked: cloudState.size, cloudEvicted: cloudEvicted, reorder: null };

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = bucketsOf(row);
      if (!id) continue;
      if (scope && !row.matches(cfg.scope)) continue;
      stats.rows++;

      var bucket = map[id];
      // The two key spaces do not overlap in practice, so the lookup order is
      // not load-bearing. What actually keeps them apart is two things, and
      // neither of them is this page script:
      //   1. cfg.status comes out of local_runtime_sessions, which only ever
      //      holds local sessions. Every id read from it has been observed to
      //      start with mvs_ (e.g. mvs_6ef1e2238f1247148f52a2b8fa149633), but
      //      that is an observation about the data, NOT a query guarantee:
      //      the main statement in status-db.mjs filters on
      //      WHERE s.archived = 0 only and has no
      //      WHERE session_id LIKE 'mvs_%' clause.
      //   2. A cloud id only enters the Map through the /^[0-9]+$/ test in
      //      onCloudEvent, and every cloud id measured is a bare digit
      //      (447993841729699). A local id therefore cannot be mistaken for a
      //      cloud one no matter what the table grows.
      // Local still stays authoritative on the lookup order, because
      // cfg.status is the source that is continuously re-polled while the
      // cloud Map is a fallback.
      var fromCloud = false;
      if (!bucket) {
        var cb = cloudState.get(id);
        if (cb) { bucket = cb; fromCloud = true; }
      }
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
      // Cloud running is counted into the SAME running total as local
      // running, because it is the same visual signal (green bar, green row
      // tint). Splitting them into two segments in the summary bar would
      // show the user two numbers for one state.
      if (bucket === 'running') stats.runningOnScreen++;
      if (bucket === 'waiting') stats.waitingOnScreen++;
      if (fromCloud) stats.cloudOnScreen++;
    }

    updateSummary(stats.runningOnScreen, stats.waitingOnScreen);
    // Must run AFTER the dots are painted: the hoister keys off the bucket
    // attribute the loop above just set.
    stats.reorder = applyReorder();
    // List-level truncation restore ("更多"). Runs after reorder so the click
    // lands on the button in its final position; self-limiting -- once the
    // host expands, the button disappears and the next tick finds nothing.
    restorePinnedMore(stats);

    // The sidebar is virtualised, so rows are constantly created and destroyed.
    // Drop detached rows from the bookkeeping Set, otherwise a long-running
    // daemon would pin every row it ever touched in memory.
    if (touched.size > 64) {
      var live = [];
      touched.forEach(function (r) { if (r.isConnected) live.push(r); });
      // pruned = how many rows were DROPPED from the bookkeeping Set, i.e.
      // rows the virtualising sidebar had already detached. It is NOT
      // live.length, which is how many SURVIVED -- that number reads like
      // "94 DOM nodes were deleted" in the daemon log, when it is closer to
      // "94 of 600 are still around". This sweep only ever touches our own
      // Set, never the host's DOM, and the count makes that checkable.
      // Snapshot the size BEFORE clear(), or the delta is always 0.
      stats.pruned = touched.size - live.length;
      touched.clear();
      for (var t2 = 0; t2 < live.length; t2++) touched.add(live[t2]);
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

  // Same-frame expansion guard. The rAF path above is one frame too late for a
  // specific case the user sees: on a 本地<->云端 view switch the host re-addmits
  // the pinned rows with the caret ALREADY expanded, so the expanded layout
  // paints for 1-2 frames before our rAF folds it (measured 2026-10-02:
  // scrollHeight 392 visible for exactly 2 frames, then back to 270 -- the
  // "多出来又折叠" flicker). MutationObserver callbacks, unlike rAF, run as a
  // MICROTASK before the browser paints that frame, so folding from inside the
  // observer callback -- synchronously, not via scheduleApply -- reverts the
  // expansion before it ever reaches the screen.
  //
  // Why a SECOND observer instead of folding inside scheduleApply: the rAF
  // indirection is exactly what costs the frame. And why attribute:true on the
  // whole subtree: the caret's expansion marker is a class change
  // ('-rotate-90' removed), i.e. an ATTRIBUTE mutation, not childList -- the
  // observer above never even fires for it.
  var expandGuardObserver = new MutationObserver(function (muts) {
    if (disposed) return;
    if (!cfg.collapseOnStart) return;
    // Only class mutations on caret-ish nodes can mean expansion.
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
      var t = m.target;
      if (!t || !t.getAttribute || String(t.getAttribute('class') || '').indexOf('transition-transform') < 0) continue;
      // A caret's class just changed and it is expanded now: fold it back
      // synchronously, before this frame paints. The row's own caret click is
      // the same button the rAF guard uses, so semantics are identical.
      var row = t.closest ? t.closest('[data-session-id]') : null;
      if (!row) continue;
      if (!isExpanded(row)) continue;
      if (row.getBoundingClientRect().height <= 40) continue; // already collapsed
      clickCaret(row);
      break; // one per callback; the next mutation (if any) re-enters
    }
  });
  expandGuardObserver.observe(mount, {
    childList: false,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  var observer = new MutationObserver(scheduleApply);
  observer.observe(mount, {
    childList: true,
    subtree: true,
    characterData: false,
  });

  // Subscribe to the host event bus BEFORE the first apply() below, so the
  // very first paint already sees the cloud sessions that are running. A
  // missing store is not an error: subscribeCloud reports it and returns.
  var cloudSub = subscribeCloud();

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

  // ---------------------------------------------------------------------
  // Pinned-section truncation memory ("更多" sticky expand).
  //
  // Host behaviour, measured on the live app (2026-10-03): the pinned list
  // truncates to ~6 rows plus a "更多" button, and every 本地<->云端 view
  // switch REMOUNTS the local list, resetting the expansion the user chose.
  // When expanded the host renders NO collapse control at all (the button
  // disappears from the DOM), so after a switch the user must re-click 更多
  // every single time -- the exact "所有 session 自动收缩起来了" report.
  //
  // Fix: remember the user's REAL click (isTrusted only -- the synthetic
  // restore click below has isTrusted=false and cannot feed back), persist it
  // in localStorage so it survives daemon re-injection and app restarts, and
  // after any remount puts the truncation button back, click it once on their
  // behalf. Orthogonal to the row-caret guard above: that one folds INLINE
  // subtask previews; this one restores the LIST-LEVEL truncation.
  // ---------------------------------------------------------------------
  var PINNED_MORE_KEY = 'mmxStatusPinnedMore';
  var PINNED_MORE_EXPAND = ['更多', 'More'];
  var PINNED_MORE_COLLAPSE = ['收起', 'Show less'];
  var pinnedMoreState = { want: null, restored: 0 };
  try {
    var storedWant = localStorage.getItem(PINNED_MORE_KEY);
    pinnedMoreState.want = storedWant === '1' ? true : (storedWant === '0' ? false : null);
  } catch (e) { /* storage unavailable -> memory-only mode */ }

  function rememberPinnedMore(want) {
    pinnedMoreState.want = want;
    try { localStorage.setItem(PINNED_MORE_KEY, want ? '1' : '0'); } catch (e) {}
  }

  // The truncation button lives INSIDE [data-pinned-section] and ONLY there.
  // Measured on the live app (2026-10-03): truncated state = 6 rows in the DOM
  // (hidden rows are UNMOUNTED, not clipped) + a visible 更多 button inside
  // the section; expanded state = the section holds NO such button at all.
  // A parent-wrapper fallback was tried and caused a click loop: the wrapper
  // also contains the project groups' OWN 更多 buttons (identical markup,
  // DIV.space-y-px -> DIV.grid), so with the section expanded the fallback
  // found a foreign button and clicked it ~2x/s for as long as the DOM
  // churned. Scope is therefore strictly sec.querySelectorAll -- anything
  // outside the section is never ours to click or remember.
  function pinnedTruncButton() {
    var sec = document.querySelector('[data-pinned-section]');
    if (!sec) return null;
    var btns = sec.querySelectorAll('button,[role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (PINNED_MORE_EXPAND.indexOf(t) >= 0) return { btn: btns[i], kind: 'expand' };
      if (PINNED_MORE_COLLAPSE.indexOf(t) >= 0) return { btn: btns[i], kind: 'collapse' };
    }
    return null;
  }

  function restorePinnedMore(stats) {
    if (pinnedMoreState.want === null) {
      // Lazy re-read while undecided: lets a seeded key take effect without a
      // re-injection. Once the user has actually clicked, want is decided and
      // the stored value is never consulted again.
      try {
        var lazy = localStorage.getItem(PINNED_MORE_KEY);
        pinnedMoreState.want = lazy === '1' ? true : (lazy === '0' ? false : null);
      } catch (e) {}
    }
    if (pinnedMoreState.want !== true) return;
    var f = pinnedTruncButton();
    if (!f || f.kind !== 'expand') return;
    if (!f.btn.getClientRects().length) return; // hidden leftover, never click
    f.btn.click(); // synthetic -> isTrusted=false -> cannot re-enter the memory
    pinnedMoreState.restored++;
    if (stats) stats.pinnedMoreRestored = pinnedMoreState.restored;
  }

  function onPinnedMoreClick(ev) {
    if (!ev || !ev.isTrusted) return; // our own restore click is synthetic
    var t = ev.target;
    var b = t && t.closest ? t.closest('button,[role="button"]') : null;
    if (!b) return;
    var sec = document.querySelector('[data-pinned-section]');
    if (!sec) return;
    // Strict containment, same lesson as pinnedTruncButton: the section's
    // parent wrapper holds the project groups' own 更多/收起 buttons, and a
    // loose scope would memorise a click that was never about the pinned list.
    if (!(sec === b || sec.contains(b))) return;
    var txt = (b.textContent || '').trim();
    if (PINNED_MORE_EXPAND.indexOf(txt) >= 0) rememberPinnedMore(true);
    else if (PINNED_MORE_COLLAPSE.indexOf(txt) >= 0) rememberPinnedMore(false);
  }

  var handler = function () { scheduleApply(); };
  window.addEventListener('mavis:status-refresh', handler);
  // Capture phase: must observe the user's real click before any host handler
  // can stopPropagation it away. Only isTrusted clicks update the memory.
  document.addEventListener('click', onPinnedMoreClick, true);
  var timer = window.setInterval(scheduleApply, cfg.intervalMs || 3000);

  var api = {
    cfg: cfg,
    mount: mount,
    apply: apply,
    enforceNoAutoExpand: enforceNoAutoExpand,
    // Read-only view of the pinned-truncation memory, for probes and the
    // daemon log: what the user asked for, how many restores fired so far,
    // and which truncation button (if any) is currently in the DOM.
    pinnedMore: function () {
      var f = pinnedTruncButton();
      return { want: pinnedMoreState.want, restored: pinnedMoreState.restored, button: f ? f.kind : null };
    },
    // Read-only view of the cloud accumulator, so the daemon log can tell
    // "cloud unsupported" apart from "cloud connected but nothing running".
    // evicted is the cumulative count of entries the 64-session ceiling threw
    // away; a non-zero value means some running cloud session may be missing
    // its dot, which is a different problem from a missing event bus.
    cloudState: function () {
      return { subscribed: !!unsubCloud, tracked: cloudState.size, evicted: cloudEvicted, entries: Array.from(cloudState) };
    },
    // apply()'s return value used to be discarded here, so the paint statistics
    // (rows / painted / removed / unknownIds) were unobservable and a stale-dot
    // regression could not be asserted by any test. Return the paint stats and
    // carry the collapse result inside them.
    refresh: function (nextStatus) {
      cfg.status = nextStatus || {};
      var painted = apply();
      var collapse = enforceNoAutoExpand();
      painted.collapse = collapse;
      return painted;
    },
    dispose: function () {
      disposed = true;
      // Unsubscribe from the host event bus first, so a late notify() cannot
      // repopulate the Map we are about to clear. A dangling listener would
      // keep this whole closure (and the Map) alive for the page's lifetime.
      disposeCloud();
      try { observer.disconnect(); } catch (e) {}
      try { expandGuardObserver.disconnect(); } catch (e) {}
      window.removeEventListener('mavis:status-refresh', handler);
      try { document.removeEventListener('click', onPinnedMoreClick, true); } catch (e) {}
      window.clearInterval(timer);
      if (rafId) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
      pending = false;
      var dots = document.querySelectorAll('[' + MARK + ']');
      for (var i = 0; i < dots.length; i++) dots[i].remove();
      var summary = document.getElementById(SUMMARY_ID);
      if (summary) summary.remove();
      var st = document.getElementById(cfg.styleId);
      if (st) st.remove();
      var restored = 0;
      touched.forEach(function (row) {
        if (row && row.isConnected) { row.style.position = ''; restored++; }
      });
      touched.clear();
      lastReorderKey = '__mmx_uninitialised__';
      delete window[GLOBAL];
      return { removed: dots.length, restored: restored, disposed: true };
    },
  };

  window[GLOBAL] = api;
  var initial = apply();
  var collapseResult = enforceNoAutoExpand();
  return { ok: true, initial: initial, collapse: collapseResult, cloud: cloudSub };
}
`;

export function buildBootstrapExpression(cfg) {
  const full = {
    mark: MARK,
    styleId: STYLE_ID,
    global: GLOBAL,
    summaryId: SUMMARY_ID,
    offsetX: 4,
    intervalMs: 3000,
    scope: '',
    showDone: false,
    collapseOnStart: true,
    // Hoist running rows to the top of their list. Rows are relocated with
    // insertBefore and the host's styles are never touched, so React never
    // loses a child.
    //
    // DEFAULT ON since 2026-10-02. This is the behaviour the user asked for,
    // and burying it behind an opt-in flag meant the launcher (which passes no
    // reorder flag at all) always ran with it off, so "running rows are not
    // hoisted" got reported as a bug. daemon.mjs owns the real switch;
    // --no-reorder is the escape hatch.
    //
    // This page-side literal is only a fallback for the case where no cfg
    // arrives. ...cfg is spread AFTER these defaults and the daemon always
    // sends an explicit boolean, so the daemon's value is what actually runs.
    //
    // Why the escape hatch still has to exist: turning the host's list
    // container into display:flex is not a local change. Measured 2026-10-02,
    // an early loose version of the container test marked 87 elements (not 1),
    // and forcing 87 nested boxes into flex column drove the renderer into a
    // reflow loop -- the page pinned a core at ~56% and stopped answering
    // Runtime.evaluate entirely. That incident is why the REORDER_MAX_ROOTS
    // gate in the page function must not be raised. The shipped code never
    // sets display:flex; it only moves nodes.
    reorder: true,
    // Selected-row background. The app default is rgba(10,10,10,0.04) which is
    // very faint; these are the deepened / recoloured alternatives.
    activeBg: 'rgba(10, 10, 10, 0.10)',
    activeBgHover: 'rgba(10, 10, 10, 0.14)',
    activeBar: 'rgba(0, 148, 252, 0.90)',
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
