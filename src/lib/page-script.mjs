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

  // 状态点的静态中文语义（README §15.16.4 / 1003.md §14.30.4）。
  //
  // 颜色之外必须再给一句人能读的话，否则一个色盲用户、一个只看读屏的用户，
  // 或者任何一个把 CSS 关掉的调试者，看到的只是六根不同长度的小竖条。
  //
  // 这三行字【必须是】静态的，不许去拼错误原文或子任务明细：
  // snapshot() 只输出 { id: bucket }，status-db.mjs 侧的错误详情与 waiting 明细
  // 根本没有出库（1003.md §14.30.4 的三条禁语就是为这件事写的）。所以这里
  // 一律只描述"这个颜色代表哪一类状态"，一句话，不声称任何页面上拿不到的数。
  var DOT_SEMANTIC = {
    running: '正在运行',
    waiting: '有子代理在运行',
    paused: '本轮已中断或已取消',
    error: '上一轮失败或存在错误',
    done: '上一轮已完成'
  };
  var DOT_SEMANTIC_FALLBACK = '状态未标明';

  // bucket 在 apply() 里是拿到之后才 setAttribute('data-mmx-bucket') 的，
  // 所以语义标签必须由调用方一并带进来，不能在 ensureDot 内部去读属性 ——
  // 那一刻属性还没写，标签会永远停在兜底文案上。
  function ensureDot(row, bucket) {
    var dot = row.querySelector('[' + MARK + ']');
    if (!dot) {
      dot = document.createElement('span');
      dot.setAttribute(MARK, '1');
      // role="img" 让这个纯装饰的 <span> 对读屏是一个可命名的对象，
      // 否则它只是一段没有语义的颜色。
      dot.setAttribute('role', 'img');
      row.appendChild(dot);
    }
    // 同一个 dot 会被复用去显示新状态（宿主重渲染只删子节点，dot 本身常常留着），
    // 所以标签跟 data-mmx-bucket 一起改，并且只在真的不同的时候写 ——
    // 无条件的 setAttribute 会让每一轮 apply 都往自己的子树上写一次。
    var label = DOT_SEMANTIC[bucket] || DOT_SEMANTIC_FALLBACK;
    if (dot.getAttribute('aria-label') !== label) {
      dot.setAttribute('aria-label', label);
      dot.setAttribute('title', label);
    }
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
    // Right parent is not enough. The section's children are remounted
    // independently by React, and a frame that remounts only the header leaves
    // anything we appended at the END of the section -- under the pinned list,
    // where it then stays, because parentElement === sec still held and the old
    // check returned early. So the position is part of what "already correct"
    // means: the bar has to be the second child, right behind the header.
    if (bar && bar.parentElement === sec && sec.children[1] === bar) return bar;
    if (bar) bar.remove();
    // The header is the first child (a 30px flex row) and the pinned list is
    // what follows it; the bar belongs between them.
    bar = document.createElement('div');
    bar.id = SUMMARY_ID;
    // 颜色图例（A10）。汇总条本来就有计数文字，所以这里【不是】"补一段文字"，
    // 而是给整条汇总一个可触达的静态说明：只写 title / aria-label / role，
    // 不加任何子节点、不改计数文案、不动插入位置，所以 bar.children 的分段数
    // 仍然是 3（pip + running + waiting），置顶列表也不会被挤。
    //
    // role="group" 不是装饰：一个没有 role 的裸 <div> 上的 aria-label 多数读屏
    // 直接忽略，写上去等于没写。group 只影响可及性树，不参与布局。
    bar.setAttribute('role', 'group');
    bar.setAttribute('title', '状态点图例：绿=正在运行，黄=有子代理在运行，'
      + '橙=本轮已中断或已取消，红=上一轮失败或存在错误，灰=上一轮已完成（需开启）。'
      + '数字按会话计，同一个会话在置顶区和列表里各出现一行也只计一次。');
    bar.setAttribute('aria-label', '会话状态汇总。状态点图例：绿色正在运行，'
      + '黄色有子代理在运行，橙色本轮已中断或已取消，红色上一轮失败或存在错误，'
      + '灰色上一轮已完成。数字按会话去重，同一个会话出现两行也只计一次。');
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
    // children[1] is the slot right after the header; null means 'append', which
    // on a header-only section is the same index anyway.
    sec.insertBefore(bar, sec.children[1] || null);
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
  // The budget is now checked BEFORE anything moves, against the exact number
  // of insertBefore calls the pass would need (countMoves below simulates the
  // back-to-front loop on a COPY of the child list). Over the ceiling means the
  // whole pass does nothing and says so, instead of the old behaviour of
  // checking inside the loop: that one returned mid-pass and left the list
  // genuinely scrambled. Measured 2026-10-02 at 18 selected rows: moved=16,
  // aborted='move-budget-exhausted', order wrong. Those numbers are a record of
  // that ONE capture under the OLD ceiling of 16 -- 18 needed, 16 had been done
  // when the loop bailed. They are not a live bound: the ceiling has been 32
  // since, and a 18-move pass trips nothing. Nothing partial, nothing
  // half-reordered, and planned= reports what the pass would have needed so a
  // ceiling trip is diagnosable from the daemon log.
  var REORDER_MAX_MOVES = 32;

  // ---- pinned section is not ours to reorder (D1) ----
  // The pinned list is rendered from the host's own ordered array and from
  // nothing else. Read out of app.asar on 2026-10-03 (raw asar offsets):
  //   @316732355  es = r.map(e => 'pinned:' + e.type + ':' + e.id)
  //   @316732900  ec = r.length > 6; ed = ec && !eo ? r.slice(0,6) : r
  //   @316733013  return jsx('div', {'data-pinned-section': true, children:[
  //                <section header>, <div ref={dropzone}>{rows...}{moreBtn}</div>]})
  // The rows come from r.slice(0,6), i.e. straight from the pinned order, and
  // that order is the persisted 'pinned-items-order' preference. Moving those
  // rows ourselves is a second writer for one order: two writers on one truth
  // is a conflict whether or not it happens to be visible on any given frame.
  //
  // So the pinned list is excluded from findListRoots/applyReorder entirely,
  // and per-project sub-lists keep hoisting exactly as before. The user's way
  // to move a pinned session is the "pin to top" menu item, which writes the
  // array itself.
  //
  // Three anchors, because "the pinned zone" is spelled differently depending
  // on where you look, and a missed one would put us back in the conflict:
  //   1. data-pinned-section  -- a real DOM attribute, on the section wrapper
  //      that contains the pinned list. Primary, and the one that holds today.
  //   2. data-sidebar-drop-id -- real, but on this build it only carries
  //      'recent-sessions' / 'projects' / 'agents' / 'project:<key>'
  //      (@316890043, @316978913). Checked for pinned values only, so the
  //      recent-sessions list keeps hoisting.
  //   3. the dnd-kit droppable id 'pinned-drop-zone' (@316721968) is JS-only on
  //      this build -- the element gets a ref, not the attribute. Checked
  //      anyway, so a build that does render it is excluded too.
  function pinnedZoneOf(node) {
    // Walks to the document root rather than to a fixed depth. A fixed depth
    // is a guess: it only has to be one wrapper too shallow for a row inside
    // the pinned section to stop being recognised as pinned, and the failure
    // mode of that is the worst one available -- we would start reordering the
    // pinned list again. A DOM walk terminates at the document, so the bound
    // here is a backstop rather than the mechanism, and running into it is
    // treated as "maybe pinned" (see below) instead of "not pinned".
    var n = node;
    for (var d = 0; n; d++) {
      // Ran out of depth before reaching the document root. We cannot prove
      // this is not the pinned list, so it is treated as pinned and left
      // alone. A missed hoist is visible and harmless; an unpinned-looking
      // pinned list that we reorder is the conflict this exclusion exists to
      // prevent. Walking all the way to the root is NOT this case: that is the
      // normal end of the loop and returns null below.
      if (d >= 64) return node;
      if (n.hasAttribute && (n.hasAttribute('data-pinned-section') ||
          n.hasAttribute('data-pinned-drop-zone'))) return n;
      var v = n.getAttribute ? n.getAttribute('data-sidebar-drop-id') : null;
      if (v && (v === 'pinned-drop-zone' || v.indexOf('pinned:') === 0)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function findListRoots() {
    var rows = document.querySelectorAll('[data-session-id]');
    var roots = [];
    var pinnedSeen = [];
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
          // Tolerance, not equality: a list may hold one non-row child (the
          // pinned list's own 'more' button measured kids=7 / withRow=6, a
          // project sub-list's 'more' button is the same shape). Strict
          // equality silently skipped the pinned list and left only the
          // per-project sub-lists matching, which is exactly the shape of the
          // bug this tolerance was added for.
          if (withRow >= kids - 1) {
            // Identified as a list, but the pinned one is the host's to order.
            if (pinnedZoneOf(n)) {
              if (pinnedSeen.indexOf(n) < 0) pinnedSeen.push(n);
            } else if (roots.indexOf(n) < 0) {
              roots.push(n);
            }
            break;
          }
        }
        n = n.parentElement;
      }
    }
    return { roots: roots, pinnedSkipped: pinnedSeen.length };
  }

  // True when the live child list already IS the order the pass would produce.
  // This is the whole of change detection now (D2).
  //
  // The old key was built from Array.prototype.indexOf.call(root.children, w),
  // i.e. from the wrapper's own child INDEX, and it was compared against a
  // cached value from the previous pass. Two deterministic failures follow:
  // a real move changes those indexes, so the key could never match again and
  // every pass after a move did a second, pointless pass; and once the host
  // re-rendered the list back to its own order, the key still matched, so the
  // reset was never noticed and the list stayed wrong. Comparing the live
  // children against the ideal sequence instead has neither problem: equal
  // means zero insertBefore, different means fix it now, and there is no state
  // to go stale between passes.
  //
  // CONVERGENCE. Roots are independent and each is planned against the DOM as
  // of the planning loop, so one pass normally finishes every root at once. A
  // root NESTED inside another is the exception: a list whose subtree holds
  // rows is itself a candidate, and hoisting inside it changes what the outer
  // pass reads on the next tick. Measured on the nested fixture in
  // test-reorder-pinned.mjs (D2.5): two passes that move, the third confirms
  // with moved=0. So the worst case is two daemon intervals of lag and never
  // a stuck state -- and that is only possible because nothing is cached: a
  // key computed before a move would decide on the next tick that the list it
  // had just changed was fine. Every intermediate state is a correct partial
  // hoist rather than a scramble, since the move loop is back-to-front and each
  // ideal is derived from that root's own live children.
  function sameOrder(kids, ideal) {
    if (kids.length !== ideal.length) return false;
    for (var i = 0; i < kids.length; i++) if (kids[i] !== ideal[i]) return false;
    return true;
  }

  // Exact number of insertBefore calls the back-to-front loop needs, computed
  // on a private copy of the child list. Nothing in the live DOM is touched,
  // which is what lets the budget reject a pass before it starts.
  function countMoves(kids, selected) {
    var sim = Array.prototype.slice.call(kids);
    var n = 0;
    for (var i = selected.length - 1; i >= 0; i--) {
      if (sim[0] === selected[i]) continue;
      var at = sim.indexOf(selected[i]);
      // Not a child any more (host re-rendered between the two loops): refuse
      // to guess a number, and let the ceiling stop the pass.
      if (at < 0) return REORDER_MAX_MOVES + 1;
      sim.splice(at, 1);
      sim.unshift(selected[i]);
      n++;
    }
    return n;
  }

  function applyReorder() {
    if (!cfg.reorder) return { moved: 0, roots: 0, skipped: 'disabled' };
    var found = findListRoots();
    var roots = found.roots;
    if (roots.length > REORDER_MAX_ROOTS) {
      return { moved: 0, roots: roots.length, pinnedSkipped: found.pinnedSkipped, aborted: 'too-many-roots' };
    }

    var plans = [];
    var planned = 0;
    var alreadyOk = 0;
    for (var r = 0; r < roots.length; r++) {
      var root = roots[r];
      var kids = root.children;
      // Running rows first, then waiting rows; each group keeps its own
      // original relative order, because the move loop below runs
      // back-to-front. Concatenating the two groups in that order is what
      // produces [all running][all waiting] at the head in a single pass.
      var runW = [];
      var waitW = [];
      var rest = [];
      for (var k = 0; k < kids.length; k++) {
        var w = kids[k];
        var row = w.querySelector && w.querySelector('[data-session-id]');
        if (!row) { rest.push(w); continue; }
        if (row.querySelector('[' + MARK + '][data-mmx-bucket="running"]')) {
          runW.push(w);
        } else if (row.querySelector('[' + MARK + '][data-mmx-bucket="waiting"]')) {
          waitW.push(w);
        } else {
          rest.push(w);
        }
      }
      var selected = runW.concat(waitW);
      if (!selected.length) continue;
      // The ideal order is exactly what the move loop produces: every selected
      // wrapper at the head in [running..., waiting...] order, everything else
      // -- row or not, including a 'more' button -- behind them in its own
      // original relative order.
      var ideal = selected.concat(rest);
      if (sameOrder(kids, ideal)) { alreadyOk++; continue; }
      planned += countMoves(kids, selected);
      plans.push({ root: root, wrappers: selected });
    }

    // All-or-nothing budget (D3): over the ceiling, this pass moves nothing.
    if (planned > REORDER_MAX_MOVES) {
      return {
        moved: 0, roots: roots.length, runningLists: plans.length, alreadyOk: alreadyOk,
        planned: planned, pinnedSkipped: found.pinnedSkipped, aborted: 'move-budget-exhausted',
      };
    }

    var moved = 0;
    for (var p = 0; p < plans.length; p++) {
      var root = plans[p].root;
      var ws = plans[p].wrappers;
      // Back to front, so the original relative order of several running rows
      // is preserved once they are all at the head.
      for (var i = ws.length - 1; i >= 0; i--) {
        var w = ws[i];
        if (root.firstElementChild === w) continue;
        root.insertBefore(w, root.firstElementChild);
        moved++;
      }
    }
    return {
      moved: moved, roots: roots.length, runningLists: plans.length, alreadyOk: alreadyOk,
      planned: planned, pinnedSkipped: found.pinnedSkipped, unchanged: moved === 0,
    };
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
    // A11: the SAME session id can sit on two rows at once -- a pinned copy and
    // a grouped copy of one session (bucketsOf()'s own comment says a row may
    // carry more than one session node, and the reverse -- one session on more
    // than one row -- is what the pinned section produces). Each of those rows
    // must keep its own dot: a dot is painted per row, so a row the user can
    // actually see must not be left bare. The SUMMARY is a different question --
    // it answers "how many sessions are running", not "how many rows are" -- so
    // it counts each id once.
    //
    // stats.rows deliberately stays a ROW count. It is the "how much did this
    // pass touch" number, and collapsing it would hide the duplication instead
    // of reporting it.
    var seenForSummary = new Set();

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = bucketsOf(row);
      if (!id) continue;
      // 红色悬停锁顶按钮：必须在"没有状态桶就 continue"【之前】挂。
      // 放在后面的话，普通会话（无 running / waiting / error 桶，也就是绝大多数
      // 会话）永远拿不到按钮，而用户要锁的恰恰就是它们。
      topLockRow(row, id);
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
      var dot = ensureDot(row, bucket);
      if (dot.getAttribute('data-mmx-bucket') !== bucket) {
        dot.setAttribute('data-mmx-bucket', bucket);
        stats.painted++;
      }
      // Cloud running is counted into the SAME running total as local
      // running, because it is the same visual signal (green bar, green row
      // tint). Splitting them into two segments in the summary bar would
      // show the user two numbers for one state.
      //
      // A11: counted once per SESSION, not once per row. The pinned section
      // renders a copy of a session that is also in a per-project list, so the
      // same id is on two rows; tallying rows made the bar say "2 个运行中"
      // for one conversation, and made it jump every time the host happened to
      // have both copies mounted. The dots above stay per row -- a row the user
      // can see must be painted -- and stats.rows stays a row count for the
      // same reason. This gate is deliberately NOT keyed on fromCloud: a cloud
      // running row is the same green bar and must land in the same number.
      if (!seenForSummary.has(id)) {
        seenForSummary.add(id);
        if (bucket === 'running') stats.runningOnScreen++;
        if (bucket === 'waiting') stats.waitingOnScreen++;
      }
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
    // The escape hatch for that memory, and the counter for a menu item whose
    // popup the host has since unmounted. Both are pure bookkeeping.
    ensurePinnedCollapse();
    reapTopmost();
    // 红色悬停锁顶的后台维持。串在【已有的】这一趟里：本模块不新增任何
    // observer / interval / rAF。串行、有预算、不与任何一次宿主写并发。
    topLockTick();
    // 新出现的置顶项自动补到最顶。同样串在这一趟里，同样不新增任何调度。
    // 排在 topLockTick 之后：锁的维持先说话，本段在锁顶意图在场时让位。
    //
    // 一趟只解析一次能力，两段共用【同一份】已证明的 order。它们必须看到同一张
    // 快照：各自再解析一次不仅多爬一遍 fiber（每行都要沿 .return 走最多 256 层），
    // 还可能在同一趟里读到两个已经不同的 order，于是"新成员"和"开始对话"判据
    // 各自建立在不同的一份顺序上。map 是本函数开头已经算好的那份，本段不重查。
    var sharedTopmostCap = topmostAutoTopCapability();
    topmostAutoTopTick(sharedTopmostCap);
    // 已置顶的会话开始对话后浮到置顶区最顶部。三段的让位链在这里定死：
    //   锁顶维持 > 新成员补到最顶 > 活动会话上浮
    // 三者共用同一把 hostCallTake，谁在这一趟先拿到闸谁写，另两个本趟放弃，
    // 不排队、不补写。排序就是语句顺序，不另设一个仲裁器。
    pinnedPromoteTick(sharedTopmostCap, map);

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
  // The literals the host can actually put on that button, read out of the
  // app.asar locale bundles on 2026-10-03:
  //   sidebar.more          -> "更多" / "More"      <- rendered by the pinned
  //   section on this build (asar@316733300, the button's only child is
  //   <span>{t('sidebar.more')}</span>)
  //   sidebar.pinned_show_more -> "展开其余 {{count}} 项" / "Show {{count}} more"
  //   sidebar.pinned_show_less -> "收起" / "Show less"
  // The last two keys are present in the locale bundles but referenced nowhere
  // in this build's code, so the first form is what a user sees today and the
  // other two are matched as well -- by their exact rendered shape (a count is
  // part of the string), never by a loose "contains".
  var PINNED_MORE_EXPAND = ['更多', 'More'];
  var PINNED_MORE_COLLAPSE = ['收起', 'Show less'];
  var PINNED_MORE_EXPAND_COUNT = [/^展开其余\s*\d+\s*项$/, /^Show\s+\d+\s+more$/];
  var PINNED_LESS_ID = 'mmx-pinned-collapse';
  var pinnedMoreState = { want: null, restored: 0, escapes: 0 };
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
  //
  // Text alone is not enough either, and this is a real defect, not a
  // hypothetical: a pinned session whose TITLE is 更多 renders a button whose
  // textContent is exactly 更多 inside that very section, so the old loop
  // matched the session's own button and clicked it. Two structural rules from
  // the host's own markup (asar@316733013) close that:
  //   - the truncation button is a DIRECT child of the pinned list container,
  //     the same container that holds the rows;
  //   - a session row is never a child of that container, it is a sibling of
  //     the button, so any button inside a [data-session-id] subtree is out.
  // One classifier, used by BOTH the restore path and the click-memory path.
  // They used to disagree: the restore looked buttons up structurally while the
  // memory compared raw text, so a trusted click on 「展开其余 23 项」 (which the
  // restore does act on) never wrote the memory, and a click on a session row
  // whose title happens to be 「更多」 could. Anything the restore is willing to
  // click, the memory must recognise, and vice versa.
  //
  // Returns 'expand' | 'collapse' | null.
  function classifyPinnedButton(b) {
    if (!b) return null;
    // A session row's own controls are never the list's control, whatever they
    // are called. This is the row titled 「更多」 case.
    if (b.closest && b.closest('[data-session-id]')) return null;
    var p = b.parentElement;
    if (!p || !p.children) return null;
    // The truncation control is a direct child of the container that also holds
    // the rows (asar@316733013), which no button inside a row or inside the
    // section header can be.
    var rowsHere = 0;
    for (var c = 0; c < p.children.length; c++) {
      var k = p.children[c];
      if ((k.hasAttribute && (k.hasAttribute('data-session-id') || k.hasAttribute('data-pinned-item-id'))) ||
          (k.querySelector && k.querySelector('[data-session-id]'))) rowsHere++;
    }
    if (!rowsHere) return null;
    var t = (b.textContent || '').trim();
    if (PINNED_MORE_EXPAND.indexOf(t) >= 0) return 'expand';
    for (var e = 0; e < PINNED_MORE_EXPAND_COUNT.length; e++) {
      if (PINNED_MORE_EXPAND_COUNT[e].test(t)) return 'expand';
    }
    if (PINNED_MORE_COLLAPSE.indexOf(t) >= 0) return 'collapse';
    return null;
  }

  function pinnedTruncButton() {
    var sec = document.querySelector('[data-pinned-section]');
    if (!sec) return null;
    var btns = sec.querySelectorAll('button,[role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var kind = classifyPinnedButton(btns[i]);
      if (kind) return { btn: btns[i], kind: kind };
    }
    return null;
  }

  // ---- escape hatch for the expansion memory ----
  // The memory is what stops every 本地<->云端 view switch from folding the
  // pinned list back to 6 rows, but it is a one-way switch: the host renders
  // the truncation button only while it is collapsed (asar@316733400, the
  // button is behind ec && !eo) and the section's only setter call is el(!0)
  // (@316733350). There is no collapse control while expanded, no el(false) call
  // site, and a useState setter is not reachable from a fiber, so the host
  // offers no way back and the user would be stuck with our ratchet.
  //
  // What is offered here is the honest half of it: a small control that clears
  // THIS TOOL's memory (one localStorage key) and says plainly that the list
  // currently on screen is the host's to fold, which happens on the next list
  // remount. It never hides or collapses a single host row: faking a collapse
  // by hiding real session rows would be a lie about the data.
  function ensurePinnedCollapse() {
    var sec = document.querySelector('[data-pinned-section]');
    if (!sec) return null;
    var existing = document.getElementById(PINNED_LESS_ID);
    var wanted = pinnedMoreState.want === true && !pinnedTruncButton();
    if (!wanted) { if (existing) existing.remove(); return null; }
    if (existing && existing.parentElement === sec) return existing;
    if (existing) existing.remove();
    var btn = document.createElement('button');
    btn.id = PINNED_LESS_ID;
    btn.type = 'button';
    btn.setAttribute('data-mmx-pinned-collapse', '1');
    btn.setAttribute('aria-label', '收起置顶列表');
    btn.textContent = '收起置顶';
    btn.title = '停止 mmx-status 记住展开状态；当前已展开的列表由宿主在下一次重挂（切换本地/云端）时自行收起。';
    btn.style.cssText = 'display:flex;align-items:center;height:23px;margin:0 0 3px 6px;padding:0 9px;' +
      'border:0;border-radius:7px;background:rgba(10,10,10,0.04);color:var(--text_default_secondary,' +
      'rgba(10,10,10,0.55));font-size:11px;font-weight:600;cursor:pointer;';
    btn.addEventListener('click', onPinnedCollapseClick);
    // Right behind the summary bar, i.e. in front of the pinned list and not
    // inside it.
    var bar = document.getElementById(SUMMARY_ID);
    var anchor = (bar && bar.parentElement === sec && sec.children[1] === bar) ? sec.children[2] : sec.children[1];
    sec.insertBefore(btn, anchor || null);
    return btn;
  }

  function onPinnedCollapseClick(ev) {
    if (!ev || !ev.isTrusted) return;
    var b = ev.target && ev.target.closest ? ev.target.closest('#' + PINNED_LESS_ID) : null;
    if (!b) return;
    rememberPinnedMore(false);
    pinnedMoreState.escapes++;
    b.remove();
  }

  // ---------------------------------------------------------------------
  // "Pin to top" (到最顶) on a session row's context menu.
  //
  // What the host actually provides, read out of app.asar on 2026-10-03. Raw
  // asar byte offsets, so they can be re-checked without guessing:
  //
  //  @316963124 / @317072055
  //      onPinSession: (e,t) => void u.handlePinSession(e,t)
  //      That is the prop every row component receives, and it is a TWO
  //      argument wrapper. Calling it as (id, true, 0) silently drops the 0,
  //      and the host then appends the session to the END of the pinned order.
  //      So the props path cannot express "to the top" and is NEVER called from
  //      here -- not as a fallback, not as a second try.
  //
  //  @317043972
  //      {handlePinSession: rW, ...} = function (e) { ... return {
  //        handlePinSession: useCallback(async (e, l, c) => { ... }) } }({...})
  //  @317045053
  //      ... let p = (0,es.xs)(n,{type:"session",id:e}, l, c); p !== n && s(p,t);
  //      ... await eU.f.pinSession(e, l, l ? c : void 0, t);
  //      deps: [i, n, t, r, a, o, s]     (7 entries)
  //      This is the real three argument entry point. c is the insert index: it
  //      is applied optimistically (es.xs filters the item out of the order and
  //      re-inserts it at the clamped index) AND persisted
  //      (pinSession(id, pinned, index)). An undefined index appends; 0 goes to
  //      the very front. The host's own drag to reorder calls exactly this with
  //      an index it computed itself: @316954070  u.handlePinSession(p,!0,e).
  //
  //  It lives in the sidebar container's hook chain, not in any prop, so it is
  //  read from ancestor fibers' memoizedState. The selector is deliberately
  //  exact -- [fn, deps] with 7 deps, fn.length === 3, and a source mentioning
  //  both .pinSession and .getSessionInfo. A sibling sidebar callback is also
  //  arity 3 but has 6 deps and no getSessionInfo, so it cannot match, and
  //  handlePinAgent (same arity, same .pinSession-shaped call) is rejected by
  //  both the dep count and the getSessionInfo marker.
  //
  //  FAIL CLOSED, always. No reachable hook, more than one match, a read-only
  //  session or a cloud session all mean the item is injected DISABLED with the
  //  reason written on it. There is no other route: no props callback, no
  //  action registry, no backend fetch, no token, and above all no "presentation
  //  only" pin. Reordering rows ourselves would be exactly that last thing, and
  //  it is not authorised.
  // ---------------------------------------------------------------------
  var TOPMOST_LABEL = '到最顶';
  var TOPMOST_ATTR = 'data-mmx-topmost';
  // 「永久置顶到最顶」· 同一个右键菜单里的第二个入口，也是持续锁顶机器在菜单
  // 侧的唯一入口。刻意【不】复用红色悬停按钮那条 onTopLockActivate：那条路径
  // 要求传入的节点就是那颗按钮本身（它校验 btn.getAttribute(TOPLOCK_ID_ATTR)），
  // 而菜单项挂在会话行右侧的浮层里，宿主从来没有给那一行挂过按钮——行内适配器
  // 认不出 strip/title 时（见锁模块的 TOPLOCK_SITES 与 anchorRefused 计数），
  // 这一项就是用户唯一能拿到的入口。
  //
  // 但状态机仍然只有【一套】：意图只有 localStorage[mmxStatusTopLockV1] 一处、
  // 预算只有 topLockRuntime 一处、写宿主只有 topLockCall 那一个三参调用、闸
  // 只有 hostCallTake 一个。下面两条入口共用 topLockArmIntent，不各写一份。
  var TOPLOCKMENU_LABEL = '永久置顶到最顶';
  var TOPLOCKMENU_ATTR = 'data-mmx-toplock-menu';
  // 禁用理由是这一项自己的话术，与「到最顶」那句区分开：同一台机器上"不能置
  // 顶"和"不能锁顶"对用户是两件事，说同一句话会让用户以为点错了地方。机器码
  // 仍然只留在 api.topLock().reason 里。
  //
  // 这一份文案住在到最顶 这一块里，是因为菜单项是它渲染的：两个模块在离线套件
  // 里是各自切出来编译的，跨块调用会让其中一个切片编不过。
  var TOPLOCKMENU_REASON_TEXT = {
    'no-handle-pin-session': '当前宿主版本不支持锁顶',
    'ambiguous-handle-pin-session': '宿主置顶回调不唯一，已停用',
    'unproven-fiber-tree': '无法确认宿主当前渲染树，已停用',
    'no-fiber-root': '无法确认宿主当前渲染树，已停用',
    'readonly-session': '该会话只读，无法锁顶',
    'readonly-probe-threw': '只读判定失败，已停用',
    'cloud-not-provable': '云端会话暂不支持锁顶',
    'no-session-row': '未找到会话行',
    'cap-mismatch': '会话身份与解析结果不一致，已停用',
  };
  function topLockMenuReasonText(reason) {
    var r = String(reason || '');
    if (TOPLOCKMENU_REASON_TEXT[r]) return TOPLOCKMENU_REASON_TEXT[r];
    if (r.indexOf('source-not-local:') === 0) return '非本地视图，暂不支持锁顶';
    return '当前宿主版本不支持锁顶';
  }
  // Both walks are bounded. The fiber walk is NOT a handful of hops: measured
  // 2026-10-05 on this host, walking up from a session row to the HostRoot
  // takes 176~186 levels, so the previous cap of 40 could never reach the root
  // and every read failed with no-fiber-root. 256 leaves headroom over the
  // measured worst case and is still finite if the host ever re-shapes. The
  // hook chain is a few hundred entries per level, hence 1500.
  var TOPMOST_MAX_ANCESTORS = 256;
  var TOPMOST_MAX_HOOKS = 1500;
  // The row's menu dropdown lives inside the row, so finding it takes a walk
  // DOWN the row's own subtree. Both bounds are far above the real shape (a row
  // subtree is tens of fibers) and still finite.
  var TOPMOST_MAX_MENU_DEPTH = 12;
  var TOPMOST_MAX_MENU_NODES = 400;
  var topmostState = {
    injected: 0, clicks: 0, calls: 0, noops: 0, blocked: 0, busy: false,
    lastReason: '', lastSessionId: '', lastSource: '', lastClose: '',
    ticket: null,
    // The second menu item's own count, so an operator can tell "the entry was
    // never injected" from "it was injected and the click did nothing". The
    // counter is about OUR node; the lock's own state is in api.topLock().
    lockInjected: 0,
  };
  var topmostNode = null;
  var topmostTimers = [];
  // Bumped whenever a right click starts a new chain, and once more on dispose.
  // Every attempt compares its own snapshot against this before doing anything
  // else, which is what makes a superseded chain inert -- see onContextMenu.
  var topmostGeneration = 0;
  // ---- 探测窗口（2026-10-05 真机零注入的修复）--------------------------
  // 真机上什么都没注进去，根因不是 class 改名、不是 owner 判定、也不是 fiber
  // 预算，而是【探测窗口只有 ~16ms】：3 次尝试、固定 8ms 一步，而宿主是【首次
  // 右击才懒挂】这一行的 portal，挂载晚于那 16ms。事后反证过 sameOwner:true，
  // 所以归属门是对的，一个字都不许放松。
  //
  // 窗口靠两件互相独立的事一起撑开，任何一件单独失效另一件都还在：
  //   1) 事件：观察器。弹层挂载本身就是一次 DOM 变更，观察器在【同一个微任务】
  //      里就能把项放进去，所以用户看不见"菜单先出来、我们的项后补"的中间态。
  //   2) 时间：重试表。逐级拉长而不是固定 8ms，累计 ~836ms。宿主没有
  //      MutationObserver（或者观察器被别的代码换掉）时，这条路自己就能用。
  //
  // 两道上限都是硬的，任何一条先到就收工：重试表跑完（TOPMOST_RETRY_DELAYS
  // 用尽）、nudge 次数用尽（TOPMOST_MAX_NUDGES）、或者钟过了
  // TOPMOST_WATCH_DEADLINE。见 stopTopmostWatch。
  var TOPMOST_RETRY_DELAYS = [0, 16, 50, 120, 250, 400];
  var TOPMOST_WATCH_DEADLINE = 2000;
  // nudge 不消耗重试预算（它就是那一拍该做的事），所以观察器必须有【自己的】
  // 上限：一个不停重绘的页面，否则能在时限内把探测叫醒无穷多次。
  var TOPMOST_MAX_NUDGES = 24;
  // 全局只有【一个】观察器。永远不是数组：不是列表就意味着不会有第二个漏在
  // 外面，任何一次新的右击都必须先拆掉上一个。
  var topmostWatch = null;
  // ONE inflight gate shared by BOTH host-writing entry points: the 「到最顶」
  // menu item and the 红色悬停锁顶 button. The reason it has to be one gate and
  // not two is in the host itself: handlePinSession optimistically rebuilds the
  // pinned order from the array its closure captured, then persists it. Two
  // overlapping calls therefore make the second one persist an order derived
  // from the first one's pre-update snapshot, and the list silently loses a
  // position. Both entries take this gate; neither has a private busy flag.
  // topmostState.busy stays where it is because api.topmost().busy is a public
  // read-only field and several offline assertions read it directly.
  // The inflight gate lives on OUR window, not on this closure.
  //
  // A per-bootstrap local var was a real defect: previous.dispose() tears down the
  // old instance's nodes and listeners, but the call it already put in flight is
  // still out there. A fresh instance then starts with held=false and can put a
  // SECOND call in flight while the first is unresolved -- and the host's
  // handlePinSession persists an order built from its closure's pre-update
  // snapshot, so the two overwrite each other.
  //
  // Handoff rules, all of them load-bearing:
  //   - the ticket is OPAQUE and unique; nothing outside this module can forge
  //     or guess it;
  //   - a settle may ONLY clear its OWN ticket, never force-clear whatever is
  //     in flight now;
  //   - dispose() stops maintenance but never forgets an in-flight call.
  var TOPLOCK_GATE_KEY = '__mmxStatusHostGateV1';
  var TOPLOCK_RUNTIME_KEY = '__mmxStatusTopLockRuntimeV1';
  // Presentation state lives on its OWN slot, deliberately separate from the
  // maintenance runtime. A window that cannot persist the runtime must fail
  // closed for BACKGROUND MAINTENANCE; it must not also take the stylesheet
  // down with it, because a lost reserve rule is a layout problem, not a
  // correctness one, and it would make a presentational failure look like the
  // gate had failed.
  var TOPLOCK_CSS_KEY = '__mmxStatusTopLockCssV1';
  // The gate is ONE object living on OUR window, so two bootstrap instances
  // (a daemon refresh is exactly that) cannot both believe the host is idle.
  //
  // A ticket is a per-call OBJECT IDENTITY, not a string. The r2 version minted
  // 'mmx-toplock-<seq>', which was guessable from the window alone -- anyone
  // holding the previous ticket's value could free the gate. Identity cannot
  // be derived from anything: only the object that took the gate can release
  // it, and only by reference equality.
  //
  // SCOPE, stated honestly: this is IDENTITY ISOLATION BETWEEN OUR OWN INSTANCES,
  // not a security or authentication boundary. Anything that can execute script
  // in this window can also overwrite window[TOPLOCK_GATE_KEY] wholesale. We do
  // not model hostile same-origin code and we make no claim about it.
  function newGate() { return { ticket: null }; }
  // Returns the SHARED gate object, or null when it cannot be proven shared.
  //
  // r2 assigned and then RETURNED the local object even when the assignment
  // silently failed (non-writable slot) or threw (frozen window). Every caller
  // then worked on a private throwaway object: two takes both minted ticket 1,
  // busy() read false, and the gate failed OPEN. Here the assignment is only
  // accepted if the window really reads back the very same object, so an
  // unpersistable slot yields null -- and a null gate means NO host write.
  function hostGateState() {
    var g = window[TOPLOCK_GATE_KEY];
    if (g && typeof g === 'object') return g;
    var fresh = newGate();
    try {
      window[TOPLOCK_GATE_KEY] = fresh;
    } catch (e) {
      return null;                      // frozen / exotic window: fail closed
    }
    // Proof of sharing. If the slot did not take, or something else is sitting
    // there, we do NOT get a private gate -- we get no gate.
    if (window[TOPLOCK_GATE_KEY] !== fresh) return null;
    return fresh;
  }
  function hostCallBusy() {
    var g = hostGateState();
    return !!(g && g.ticket);
  }
  // Returns this call's ticket object, or null when the gate is unavailable or
  // somebody else already holds it. Null must mean ZERO host writes, so every
  // caller has to treat it as a refusal, not as "try again".
  function hostCallTake() {
    var g = hostGateState();
    if (!g) return null;
    if (g.ticket) return null;
    var ticket = {};
    g.ticket = ticket;
    // The ticket has to be VISIBLE on the shared object, or the write it
    // authorises would be unserialisable to the rest of the module.
    if (g.ticket !== ticket) { g.ticket = null; return null; }
    return ticket;
  }
  // Releases only its OWN ticket, by identity. A late settle from a superseded
  // call can therefore never free the gate a newer call is holding. An
  // unavailable gate is a no-op, never a throw: this runs from a Promise
  // callback where throwing would surface as an unhandled rejection.
  function hostCallRelease(ticket) {
    if (!ticket) return;
    var g = hostGateState();
    if (!g) return;
    if (g.ticket === ticket) g.ticket = null;
  }
  // The maintenance budget and the "do not auto-retry this target" marks have to
  // survive a re-injection too. Otherwise every daemon refresh hands the user a
  // fresh 3 attempts and the "no automatic retry" promise is a lie.
  //
  // Same fail-closed rule as the gate: a runtime that cannot be persisted must
  // NOT be handed back as a private throwaway, because a throwaway budget is
  // refilled from scratch on every re-injection -- which is precisely the lie
  // this runtime exists to prevent. Null means "no background maintenance".
  function topLockRuntime() {
    var r = window[TOPLOCK_RUNTIME_KEY];
    if (r && typeof r === 'object') return r;
    var fresh = { owner: '', budget: 0, reason: '' };
    try {
      window[TOPLOCK_RUNTIME_KEY] = fresh;
    } catch (e) {
      return null;                      // fail closed
    }
    if (window[TOPLOCK_RUNTIME_KEY] !== fresh) return null;
    return fresh;
  }
  // The keyed CSS rule registry. A PRIVATE fallback is acceptable here and is
  // used deliberately: the registry only decides what text the sheet should
  // contain, and losing it costs a rebuild of a presentation detail, never a
  // host write and never a correctness decision. That is the whole reason it
  // may fall back where hostGateState/topLockRuntime must refuse.
  //
  // The r3 shape was a three-way no-op of the form
  //   return window[KEY] === fresh ? fresh : fresh;
  // which pretended to check the window and could never return anything but
  // the local object. It said "we verified" while verifying nothing -- and it
  // hid a real bug: the local object was rebuilt on EVERY call, so with an
  // unwritable slot each call received a brand new empty rule set, the rules
  // the layout key had just written went into a throwaway, and the stylesheet
  // came out EMPTY. Silently, on exactly the window that could not persist
  // anything.
  //
  // r4: the private fallback is cached in a module-local, so within one
  // instance every call sees the same registry and the sheet really does get
  // its rules. The "did the window keep it" question is answered once, by the
  // existence check above, and its answer only decides whether a SECOND
  // instance shares the cache. The gate and the runtime keep refusing instead:
  // their state decides whether we write to the host at all, which is not a
  // presentation detail.
  var topLockCssPrivateReg = null;
  function topLockCssRegistry() {
    var c = window[TOPLOCK_CSS_KEY];
    if (c && typeof c === 'object' && c.rules && typeof c.rules === 'object') return c;
    if (!topLockCssPrivateReg) topLockCssPrivateReg = { rules: {} };
    try { window[TOPLOCK_CSS_KEY] = topLockCssPrivateReg; } catch (e) { /* private by design */ }
    return topLockCssPrivateReg;
  }
  // Cross-entry coupling between the two entry points, held HERE so that this
  // whole 到最顶 block stays self-contained (the offline suites slice it out on
  // its own and must keep compiling). The lock module writes the current intent
  // into it; nothing here writes back.
  var topmostLockView = { id: '', phase: 'idle' };
  // While a lock intent exists, 「到最顶」 is disabled for every OTHER row. The
  // reason is not tidiness: the pinned order is a single ordered list, so two
  // competing intents would overwrite each other and neither could ever prove
  // its own outcome. The red button still replaces the target -- that is what
  // replacing means -- it is only this second entry point that steps aside.
  function topLockBlocksTopmost(cap, id) {
    var locked = topmostLockView.id;
    if (!locked) return cap;
    if (locked === id) return cap;
    return { available: false, reason: 'toplock-other', id: id };
  }

  // ---------------------------------------------------------------------
  // 新出现的置顶项自动补到最顶
  //
  // 用户 2026-10-05 反馈：新建会话点宿主自己的「置顶」后，它落在置顶区【最底
  // 部】。原因在宿主那一侧：行组件收到的那条两参 props 包装把第三参丢了（见本
  // 块开头那段从 asar 读出来的事实），backend 于是 clampInsertIndex(undefined,
  // max) 追加到末尾。本段只做一件事：当【已经证明】的 pinned 顺序发生变化、
  // 且这次新出现的那一项不在下标 0 时，给它补一次 handlePinSession(id,true,0)。
  //
  // 判据是【成员】而不是【下标】，这是本段最重要的一条决定。
  //   下标变了有两种来源，而它们必须被区别对待：
  //     1. 用户自己把 B 拖到最顶：此时 A 的下标确实从 0 变成了 1。这是一次真
  //        实操作，我们非但不该纠正，还必须让开；
  //     2. 我们自己写的「到最顶」：原首位被顶下去，下标同样变了。若照"被顶下
  //        去就补一次"处理，下一拍就会把刚到最顶的那一项顶回去，等于自己撤销
  //        用户刚点的菜单。
  //   只有"上一份可信顺序里没有、这一份里有"的成员才是宿主新放进来的那种。
  //   所以 24.8 与 24.8b 断言的是【什么都不做】，而不是"也补一次"。
  //
  // 三条硬边界，任何一条不成立就一次宿主写都不发生：
  //   1. 顺序必须来自 topmostCapability —— 也就是 looksLikeHandlePin 认出的那
  //      唯一一个七依赖 / arity 3 / 字符串判据的宿主 hook，且 source 是 local。
  //      拿不到就是拿不到：记 unproven，【保留上一份基线】，不猜、不写。
  //   2. 目标 id 自己要过宿主的只读探针 cap.probe。见证行的只读结论不能借给
  //      别的 id（这正是 r3 的 w7/w8 两条缺陷的教训）。
  //   3. 走 hostCallTake 那个共享闸，与「到最顶」菜单项、红色锁顶按钮同一条。
  // 预算独立于 TOPLOCK_MAX_MAINT，而且像 topLockRuntime 一样住在 window 上：
  // 一次重新注入不能顺手把用户的三次补写变成又三次。
  // 稳定两趟才认这次顺序：宿主自己还在往 order 里灌数据时（冷启动的头几帧）
  // 一份只出现过一帧的顺序不能当"上一次顺序"，否则首次加载就会把刚出现的第二
  // 项顶到最顶。首趟永远没有基线，所以首趟永远不写。
  var TOPMOST_AUTOTOP_KEY = '__mmxStatusAutoTopV1';
  var TOPMOST_AUTOTOP_MAX = 3;
  // 见证行最多看这么多个：混合视图里第一行可能是云端（能力不可证），而每一行
  // 都要爬一次 fiber 链，所以取一个有界的前缀，绝不扫全表。
  var TOPMOST_AUTOTOP_WITNESS_MAX = 4;
  var autoTopState = {
    passes: 0, settleMiss: 0, changes: 0, calls: 0, blocked: 0, refused: 0,
    unproven: 0, deferred: 0, exhausted: 0, noCandidate: 0, alreadyTop: 0,
    noBaseline: 0, confirmed: 0, failed: 0, awaiting: 0, absorbed: 0,
    budget: TOPMOST_AUTOTOP_MAX, owner: '', lastId: '', lastReason: '',
  };
  // 上一次【已证明】顺序里的会话 id，和【上一趟观察到的】顺序。两者都只是
  // "上一次看到什么"的记忆，任何持久化槽都不写它。
  var autoTopIds = [];
  var autoTopSeen = [];
  // 待纠正的那一次变化：{ ids, id, tried }。
  // 基线【不再】在尝试时推进，而是在下一趟【确认】之后才推进。被共享闸挡住、宿主
  // 抛异常、宿主 reject、宿主 resolve 了但 order 没动——这四种一律把这份待办留
  // 到下一趟，于是"新出现的那一项停在最底部"这一次变化不会被吃掉。tried 记的是
  // 有没有真的叫过 cap.fn：没叫过（闸被别人占着）不算一次失败，也不扣预算。
  var autoTopPending = null;
  // 预算按【确认失败】扣，不是按【尝试】扣：一次成功落位不花钱，被闸挡住 / 抛
  // 异常 / reject / resolve 了但 order 没动才花一次。返回是否真的扣掉了。
  function topmostCharge(rt, id, st) {
    if (!rt) return false;
    if (rt.owner !== id) return false;
    if (!(rt.budget > 0)) return false;
    rt.budget = rt.budget - 1;
    st.budget = rt.budget;
    return true;
  }
  // 「这一份比基线【更小】」：每个成员都还在，且真的少了人。用户取消置顶就是这样
  // 发生的，而我们不纠正移除，所以要把它认成一份稳定的新成员集。
  function topmostShrankTo(ids, prev) {
    if (ids.length >= prev.length) return false;
    for (var i = 0; i < ids.length; i++) if (prev.indexOf(ids[i]) < 0) return false;
    return true;
  }
  // 与 topLockRuntime 同一套纪律：存不下的窗口 = 拒绝，绝不是给一份用完即弃的
  // 预算（那正是 r3 的 w3 缺陷）。
  function autoTopRuntime() {
    var r = window[TOPMOST_AUTOTOP_KEY];
    if (r && typeof r === 'object') return r;
    var fresh = { owner: '', budget: 0, reason: '' };
    try {
      window[TOPMOST_AUTOTOP_KEY] = fresh;
    } catch (e) {
      return null;
    }
    if (window[TOPMOST_AUTOTOP_KEY] !== fresh) return null;
    return fresh;
  }
  // 本地 id 的形状。与锁模块的 topLockValidId 同一条判据，抄一份而不是跨块
  // 调用，原因同上（两块在离线套件里各自切出来编译）。认不出就不是本地 id。
  function topmostAutoTopId(id) {
    if (typeof id !== 'string' || !id) return false;
    if (/^[0-9]+$/.test(id)) return false;
    return /^mvs_[A-Za-z0-9]+$/.test(id);
  }
  function topmostSameIds(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // 一份【已证明】的本地视图，或 null。见证行取有界的前几行：置顶区的行在
  // DOM 里本来就在最前，所以第一行通常就是它。每一份都走同一条
  // topmostCapability，所以 fiber 树、唯一 hook、local 源、只读探针这一整套
  // 证明一步都不会少。
  function topmostAutoTopCapability() {
    var rows = document.querySelectorAll('[data-session-id]');
    var n = rows.length < TOPMOST_AUTOTOP_WITNESS_MAX ? rows.length : TOPMOST_AUTOTOP_WITNESS_MAX;
    for (var i = 0; i < n; i++) {
      var cap = topmostCapability(rows[i]);
      if (!cap.available || !cap.order || !cap.order.length) continue;
      if (typeof cap.fn !== 'function' || typeof cap.probe !== 'function') continue;
      return cap;
    }
    return null;
  }
  // capIn 由 apply() 那一趟解析好传进来，让 24 段与下面那段共用同一份已证明的
  // order。传空就自己解析一次：离线套件是直接调本函数的，那边没有 apply()。
  function topmostAutoTopTick(capIn) {
    if (disposed) return;
    autoTopState.passes++;
    var cap = capIn || topmostAutoTopCapability();
    if (!cap) { autoTopState.unproven++; autoTopState.lastReason = 'view-unstable'; return; }
    var ids = [];
    for (var i = 0; i < cap.order.length; i++) {
      var it = cap.order[i];
      if (it && it.type === 'session' && it.id != null) ids.push(String(it.id));
    }
    // 空数组证明不了任何东西：它既可能是"还没加载"，也可能是"用户刚取消全部
    // 置顶"。不写，并且不动基线。
    if (!ids.length) { autoTopState.unproven++; autoTopState.lastReason = 'view-unstable'; return; }
    // 稳定两趟才认。变化中的那一趟只更新"上一趟观察到的"。
    if (!topmostSameIds(ids, autoTopSeen)) {
      autoTopSeen = ids.slice();
      autoTopState.settleMiss++;
      // 这一趟不是"什么都没看见"，而是"看见了一份【比成员基线更小】的稳定视图"：
      // 用户取消置顶就是这样发生的，而我们不纠正移除，所以要把它认成新的成员基线。
      // 不认的话，"取消一次、再点一次置顶"会回到与基线【逐字节相同】的顺序，那一
      // 项就再也不会被认成新成员，对抗测试 R 段正是这一条。纯拖拽（成员集合不变）
      // 走不到这里，所以这条绝不撤销用户的拖拽。
      if (!autoTopPending && autoTopIds.length && topmostShrankTo(ids, autoTopIds)) {
        autoTopIds = ids.slice();
        autoTopState.absorbed++;
      }
      return;
    }
    var prev = autoTopIds;
    // 先确认上一次待纠正的那一次变化。只有确认了（目标真落到下标 0，或那一份形态
    // 已经消失）基线才推进；确认失败则扣一次预算并把待办留到下一趟。被闸挡、抛异
    // 常、reject、resolve 了但 order 没动，四种都落在下面这三条里。
    if (autoTopPending) {
      if (ids.indexOf(autoTopPending.id) === 0) {
        autoTopIds = ids.slice();
        autoTopPending = null;
        autoTopState.confirmed++;
        autoTopState.lastReason = 'landed';
        prev = autoTopIds;
      } else if (hostCallBusy()) {
        // 宿主那次调用还在飞：这一趟【不下结论】，不扣预算，也不再写一次。
        autoTopState.awaiting++;
        autoTopState.lastReason = 'awaiting-host';
        return;
      } else if (topmostSameIds(ids, autoTopPending.ids)) {
        // 形态还在、目标没到下标 0 = 确认失败。待办留着，下面按"这次变化还在"走。
        if (autoTopPending.tried && topmostCharge(autoTopRuntime(), autoTopPending.id, autoTopState)) {
          autoTopState.failed++;
        }
        autoTopState.lastReason = 'confirm-failed';
      } else {
        // 形态没了（被别人的纠正改写，或用户自己动了）：这一次没落位，扣一次预算，
        // 待办作废，基线认下这份新观察。
        if (autoTopPending.tried && topmostCharge(autoTopRuntime(), autoTopPending.id, autoTopState)) {
          autoTopState.failed++;
        }
        autoTopPending = null;
        autoTopIds = ids.slice();
        prev = autoTopIds;
        autoTopState.lastReason = 'confirm-failed-shape';
      }
    }
    // 首趟与基线趟只记录，不写：没有"上一份可信顺序"就没有"新成员"。
    if (!prev.length) {
      autoTopIds = ids.slice();
      autoTopState.noBaseline++;
      autoTopState.lastReason = 'baseline-armed';
      return;
    }
    if (topmostSameIds(prev, ids)) return;              // 顺序没变：一次调用都不考虑
    autoTopState.changes++;
    // 锁顶意图在场时让位：那是用户按过按钮授权的一次意图，它的代次与维持预算都
    // 归它，我们在这里插一脚只会和它对拉。
    // 让位只【推迟】这一次补写，绝不把它取消：这里既不推进基线、也不建待办，于是
    // 让位期间到达的新成员留在基线之外，锁一释放仍会被认成新成员并补到 0（这条是
    // D1 修过的形状，抄同一条，不各自发明）。这一分支里【不得】出现任何宿主写，
    // deferred 也仍然每趟 +1。
    if (topmostLockView.id) {
      autoTopState.deferred++;
      autoTopState.lastReason = 'toplock-other';
      return;
    }
    // 候选 = 这次【新出现】的成员，按下标从小到大逐个试。被探针拒绝的那一个（只读
    // / 非本地 id）不吃掉整批：跳过它，同批里下一个可写的继续。一次变化仍然【一趟最
    // 多一次】宿主写——找到第一个可写的就 break，绝不在同一趟里写第二次。
    var pick = -1;
    var refusalReason = '';
    for (var j = 0; j < ids.length; j++) {
      if (prev.indexOf(ids[j]) >= 0) continue;
      var one = ids[j];
      if (!topmostAutoTopId(one)) { refusalReason = 'not-local-id'; continue; }
      var ro;
      try { ro = !!cap.probe(one, cap.source); } catch (e) { ro = true; }
      if (ro) { refusalReason = 'readonly-session'; continue; }
      pick = j;
      break;
    }
    // 这一批里一个可写的都没有：没有任何东西需要纠正，认下这份观察（否则每趟都要
    // 重探一次同一个只读目标）。成员没变就一个候选也没有，那是用户自己的拖拽，
    // 绝不撤销。
    if (pick < 0) {
      autoTopState.noCandidate++;
      if (refusalReason) { autoTopState.refused++; autoTopState.lastReason = refusalReason; }
      else autoTopState.lastReason = 'no-new-member';
      autoTopIds = ids.slice();
      return;
    }
    if (pick === 0) {
      autoTopState.alreadyTop++;
      autoTopState.lastReason = 'already-top';
      autoTopIds = ids.slice();
      return;
    }
    var id = ids[pick];
    autoTopState.lastId = id;
    var rt = autoTopRuntime();
    if (!rt) { autoTopState.blocked++; autoTopState.lastReason = 'runtime-unavailable'; return; }
    // 换一个目标 = 新的预算；同一个目标用完就停（w4 那条"只有可信手势才补满"
    // 的纪律在这里的形状是：只有【新出现的另一项】才补满）。
    if (rt.owner !== id) { rt.owner = id; rt.budget = TOPMOST_AUTOTOP_MAX; rt.reason = ''; }
    autoTopState.owner = rt.owner;
    autoTopState.budget = rt.budget;
    if (rt.budget < 1) {
      autoTopState.budget = 0;
      autoTopState.exhausted++;
      autoTopState.lastReason = 'budget-exhausted';
      return;
    }
    var ticket = hostCallTake();
    // 闸被别人占着：一次宿主写都不发生，但这一次变化【留在待办里】，闸一释放就补。
    if (!ticket) {
      autoTopState.blocked++;
      autoTopState.lastReason = 'gate-unavailable';
      autoTopPending = { ids: ids.slice(), id: id, tried: false };
      return;
    }
    // 待办【在调用之前】就记上：同步抛异常、reject、resolve 之后 order 没动，这三
    // 种都要被下一趟认出来，而不是在这一趟就把这次变化吃掉。
    autoTopPending = { ids: ids.slice(), id: id, tried: true };
    autoTopState.calls++;
    autoTopState.lastReason = 'calling';
    var ret;
    try {
      // EXACTLY three arguments, and it is the SAME single write the other two
      // entries use. No index means "append", which is the bug being corrected.
      ret = cap.fn(id, true, 0);
    } catch (e) {
      hostCallRelease(ticket);
      autoTopState.blocked++;
      autoTopState.lastReason = 'call-threw';
      return;
    }
    // A resolved promise means "the host finished handling it", never "it
    // worked": 这里【不】推进基线、也【不】扣预算，落位与否留给下一趟确认。闸由它
    // 自己的结算释放，而且只释放它自己那一张票。
    Promise.resolve(ret).then(function () {
      hostCallRelease(ticket);
      autoTopState.lastReason = 'host-returned';
    }, function () {
      hostCallRelease(ticket);
      autoTopState.blocked++;
      autoTopState.lastReason = 'host-rejected';
    });
  }

  // ---------------------------------------------------------------------
  // 已置顶的会话开始对话后，自动浮到置顶区最顶部（R1）
  //
  // 用户 2026-10-05 报的头一条：会话【已经置顶】、而且【正在对话】，它仍停在置顶
  // 区原来的位置，想看它得自己往下翻或者把它拖上去。上面那段（24）管的是"刚点
  // 置顶的那一项落在最底部"，判据是【成员变了没有】；本段管的是"本来就在置顶区
  // 里的某一项开始跑起来"，判据是【状态变了没有】。两件事不同源，所以判据必须
  // 不同：24 段看见任何一个新成员就动一次，本段看见一个旧成员从 idle 变成
  // running 才动一次。
  //
  // 状态从哪来，为什么不是 DOM 行：
  //   置顶区折叠起来时第 7 名起根本不在 DOM 里（F1 已证），所以"页面里有几行"
  //   根本不是"顺序有几位"。拿 DOM 行当真相，等于把一份被截断的视图当成完整
  //   顺序——折叠一次就够把第 7 位以下的会话永久漏掉。这里【一行 DOM 都不查】：
  //   成员与下标来自宿主自己的 order，状态来自 apply() 这一趟已经算好的那份 map。
  //   那份 map 是 daemon 的 db.snapshot() 导出的，只含 bucket !== idle 的 id
  //   （status-db.mjs 的 snapshot() 明确过滤掉 idle），所以 map[id] === 'running'
  //   就是"此刻在跑"，map 里查不到就是 idle。本函数【不新开任何查询】：另查一次
  //   SQLite 就是多一个与真实轮询不同步的旁路，而且那条旁路没有第二个轮询节拍。
  //
  // 触发判据只有一种，就这一拍动一次手：
  //   上一趟记的 running 是 false、这一趟 map[id] === 'running'、且它在本趟
  //   order 里下标 > 0。
  //     持续 running   : 不再动。一次对话被反复顶到最顶就是这条路走歪了。
  //     running -> idle: 【不回位】。用户没有要求回位，而且回位就得记住原位，等于
  //                      给每个置顶项多挂一份状态；不记反而更少写、更少错。
  //     下标变化       : 永不动作。那是用户自己的拖拽，不是状态变化。判据是状态
  //                      不是位置——这一条与 24 段"判据是成员不是下标"是同一个
  //                      教训的两面，别把两段的判据抄串。
  //
  // 已知限制，如实记在这里（不是缺陷，是轮询的性质）：
  //   本段只在 daemon 的轮询节拍上跑，节拍是 2500ms（daemon.mjs 的 intervalMs
  //   默认 2500）。一个在 2.5s 之内就起完的短对话，可能整段落在两次采样之间，
  //   一次都没有被观察到，于是这一次不上浮。这不是漏判，是"没看见"；要看见它
  //   就得提高轮询频率，那会把 SQLite 的读放大到用户能感知的程度，不划算。
  //
  // 有界，四道：
  //   1. 预算按【会话】分，每会话 3 次，住 window 上（存不下就 fail closed，绝不
  //      给一份用完即弃的预算）。扣的是【确认失败】——被闸挡住 / 抛异常 / reject /
  //      resolve 了但 order 没动——不是每次尝试；真落位的那一次不花钱。
  //   2. 一次状态变化最多一次写：这一趟找到第一个可写的目标就 break，绝不写第二
  //      次；而这一趟没写成（闸被占、抛异常、reject）时升沿【不消费】，待办留到
  //      闸空闲的下一趟补，与 24 段的让位形状同一条。
  //   3. order 不可证明时暂停，而且【不动基线】。
  //   4. 目标自己过 cap.probe，绝不借见证行的只读结论；云端数字 id 直接拒绝。
  var TOPMOST_PROMOTE_KEY = '__mmxStatusPinnedPromoteV1';
  var TOPMOST_PROMOTE_MAX = 3;
  var promoteState = {
    passes: 0, settleMiss: 0, changes: 0, noChange: 0, calls: 0, blocked: 0,
    refused: 0, unproven: 0, deferred: 0, exhausted: 0, alreadyTop: 0,
    noBaseline: 0, confirmed: 0, failed: 0, awaiting: 0,
    budget: TOPMOST_PROMOTE_MAX, lastId: '', lastReason: '',
  };
  // 上一趟的状态基线，按 id 存 { id, running }。
  // 刻意【按 id】而不是按下标：让位期间用户可能拖过顺序，按下标记的基线会在那
  // 一刻整体错位，之后每一次比较都在比错的东西。按 id 记的基线只是顺序旧一点，
  // 而本段的判据问的是"这一趟谁从 false 变成了 true"，按 id 记这件事仍然是真的。
  var promotePrev = [];
  // 上一趟【观察到的】顺序，只用来做"连续两趟相同"的防抖。变化中的那一趟只更新
  // 它，不碰 promotePrev。
  var promoteSeen = [];
  // 待上浮的那一条升沿：{ ids, id, tried }。基线【不】在判据之前推进，只有下一趟
  // 确认了（真的浮到了下标 0，或那一份顺序形态已经被别的纠正改写）才推进。被共享
  // 闸占着的那一趟不算消费掉这次升沿——闸一空闲就补，对抗测试 P.2 / Q.3 就是这
  // 一条。tried 记有没有真的叫过 cap.fn：没叫过不扣预算。
  var promotePending = null;
  // 与 autoTopRuntime / topLockRuntime 同一套纪律：槽存不下 = 拒绝，绝不是给一份
  // 用完即弃的预算（那正是 r3 的 w3 缺陷）。
  function promoteRuntime() {
    var r = window[TOPMOST_PROMOTE_KEY];
    if (r && typeof r === 'object') return r;
    var fresh = { owner: '', budget: 0, reason: '' };
    try {
      window[TOPMOST_PROMOTE_KEY] = fresh;
    } catch (e) {
      return null;
    }
    if (window[TOPMOST_PROMOTE_KEY] !== fresh) return null;
    return fresh;
  }
  // status 是 apply() 那一趟算好的那份状态 map（daemon 的 snapshot 过滤掉 idle），
  // 原样传进来，本段不重查。capIn 同理，见上面 apply() 里的注释。
  function pinnedPromoteTick(capIn, status) {
    if (disposed) return;
    promoteState.passes++;
    var cap = capIn || topmostAutoTopCapability();
    // 证明不了就什么都不做，而且【不动基线】：这样视图恢复之后，让位/不可证明
    // 期间开始对话的那一项仍然会被认出来。
    if (!cap) {
      promoteState.unproven++;
      promoteState.lastReason = 'view-unstable';
      return;
    }
    var ids = [];
    for (var i = 0; i < cap.order.length; i++) {
      var it = cap.order[i];
      if (it && it.type === 'session' && it.id != null) ids.push(String(it.id));
    }
    // 空数组证明不了任何东西：它既可能是"还没加载"，也可能是"用户刚取消全部
    // 置顶"。不写，并且不动基线。
    if (!ids.length) {
      promoteState.unproven++;
      promoteState.lastReason = 'view-unstable';
      return;
    }
    var st = status || {};
    var next = [];
    for (var n = 0; n < ids.length; n++) {
      next.push({ id: ids[n], running: st[ids[n]] === 'running' });
    }
    // 连续两趟 order 一致（成员与顺序都同）才允许动作。宿主冷启动的头几帧还在往
    // order 里灌数据，一份只出现过一帧的顺序不能当"上一次看到什么"。
    if (!topmostSameIds(ids, promoteSeen)) {
      promoteSeen = ids.slice();
      promoteState.settleMiss++;
      return;
    }
    var prev = promotePrev;
    // 首趟与基线趟只记录，不写：没有"上一趟的状态"就没有"状态变了"。
    if (!prev.length) {
      promoteSeen = ids.slice();
      promotePrev = next;
      promoteState.noBaseline++;
      promoteState.lastReason = 'baseline-armed';
      return;
    }
    // 锁顶意图在场时让位，而且【不推进状态基线】：让位期间开始对话的那一项要留在
    // 基线之外，锁一释放仍会被认成"刚刚开始对话"并被浮上去。这正是 D1
    // （24.10b/24.10c）修过的形状，抄同一条，不各自发明。
    // 本分支里不得出现任何宿主写，deferred 仍然每趟 +1。
    if (topmostLockView.id) {
      promoteState.deferred++;
      promoteState.lastReason = 'toplock-other';
      return;
    }
    // 基线【不】在判据之前推进。升沿留在 promotePending 里，直到下一趟确认它：真的
    // 浮到了下标 0（成功，不扣预算），或者那一份顺序形态已经被别的纠正改写（这一
    // 次没落位，扣一次预算，基线认下新观察）。确认失败时基线原地不动，于是这一条
    // 升沿在闸空闲的下一趟仍会被认出来并再浮一次。
    if (promotePending) {
      if (ids.indexOf(promotePending.id) === 0) {
        promotePrev = next;
        promotePending = null;
        promoteState.confirmed++;
        promoteState.lastReason = 'landed';
        return;
      }
      if (hostCallBusy()) {
        promoteState.awaiting++;
        promoteState.lastReason = 'awaiting-host';
        return;
      }
      if (promotePending.tried && topmostCharge(promoteRuntime(), promotePending.id, promoteState)) {
        promoteState.failed++;
      }
      if (topmostSameIds(ids, promotePending.ids)) {
        // 形态还在：这次升沿没落位，扣一次预算，待办留到下一趟。
        promoteState.lastReason = 'confirm-failed';
      } else {
        promoteState.lastReason = 'confirm-failed-shape';
        promotePending = null;
        promotePrev = next;
        return;
      }
    }
    // Object.create(null)：这份查找表只认"自家键"。用 {} 的话，一个恰好叫
    // constructor 的 id 会读到原型上的函数而不是 undefined，那会把一个从没进过
    // 置顶区的会话误认成"上一趟就在跑"。
    var wasById = Object.create(null);
    for (var q = 0; q < prev.length; q++) wasById[prev[q].id] = prev[q].running;
    var cand = -1;
    for (var c = 0; c < next.length; c++) {
      var was = wasById[next[c].id];
      // 认不出（这一趟之前不在置顶区里）就不管：新成员归 24 段管，两段绝不在同
      // 一项上对拉。用户取消置顶又重新置顶的那一项也走这一条——它对 24 段来说
      // 就是新成员，于是自然落到 24 段，本段不需要为它单开一条特殊路径。
      if (was === undefined) continue;
      if (was) continue;                       // 上一趟就在跑：没有状态变化
      if (!next[c].running) continue;          // 这一趟也还没跑
      cand = c;
      break;                                    // 一次最多一项：下标最小的那一个
    }
    // 这一次没有状态变化（持续 running、会话结束、纯拖拽）：基线认下，这一条升沿
    // 到此为止。会话结束【不回位】，也是靠这里只更新 running 布尔、不记任何位置。
    if (cand < 0) { promoteState.noChange++; promotePrev = next; return; }
    promoteState.changes++;
    // 判据要求下标 > 0。已经在最顶的那一项什么也不做，也不消耗预算。
    if (cand === 0) {
      promoteState.alreadyTop++;
      promotePrev = next;
      promoteState.lastReason = 'already-top';
      return;
    }
    var id = next[cand].id;
    promoteState.lastId = id;
    if (!topmostAutoTopId(id)) {
      promoteState.refused++;
      promotePrev = next;
      promoteState.lastReason = 'not-local-id';
      return;
    }
    // 目标自己过宿主的只读探针。见证行的结论不能借给别的 id（r3 的 w7/w8）。
    var readOnly;
    try { readOnly = !!cap.probe(id, cap.source); } catch (e) { readOnly = true; }
    if (readOnly) {
      promoteState.refused++;
      promotePrev = next;
      promoteState.lastReason = 'readonly-session';
      return;
    }
    var rt = promoteRuntime();
    if (!rt) {
      promoteState.blocked++;
      promoteState.lastReason = 'runtime-unavailable';
      return;
    }
    // 换一个会话 = 新的预算；同一个会话用完就停。
    if (rt.owner !== id) { rt.owner = id; rt.budget = TOPMOST_PROMOTE_MAX; rt.reason = ''; }
    if (rt.budget < 1) {
      promoteState.budget = 0;
      promoteState.exhausted++;
      promoteState.lastReason = 'budget-exhausted';
      return;
    }
    // 与「到最顶」菜单项、红色锁顶按钮、自动到顶同一把闸。谁先拿到谁写，
    // 这一趟另一个放弃（null 意味着零宿主写，不排队）。但【放弃不等于消费】：升沿
    // 留在待办里，闸一空闲的下一趟补上，形状与 24 段让位时留待办同一条。
    var ticket = hostCallTake();
    if (!ticket) {
      promoteState.blocked++;
      promoteState.lastReason = 'gate-unavailable';
      promotePending = { ids: ids.slice(), id: id, tried: false };
      return;
    }
    promoteState.budget = rt.budget;
    promoteState.calls++;
    promoteState.lastReason = 'calling';
    promotePending = { ids: ids.slice(), id: id, tried: true };
    var ret;
    try {
      // EXACTLY three arguments, and it is the SAME single write the other three
      // entries use. No index means "append", which is the bug being corrected.
      ret = cap.fn(id, true, 0);
    } catch (e) {
      hostCallRelease(ticket);
      promoteState.blocked++;
      promoteState.lastReason = 'call-threw';
      return;
    }
    // A resolved promise means "the host finished handling it", never "it
    // worked": 这里【不】推进基线、也【不】扣预算，落位与否留给下一趟确认。闸由
    // 它自己的结算释放，而且只释放它自己那一张票。
    Promise.resolve(ret).then(function () {
      hostCallRelease(ticket);
      promoteState.lastReason = 'host-returned';
    }, function () {
      hostCallRelease(ticket);
      promoteState.blocked++;
      promoteState.lastReason = 'host-rejected';
    });
  }

  // -------------------------------------------------------------------------
  // 到最顶 · 最小主证诊断（只读，不改任何出厂行为，不部署）
  // -------------------------------------------------------------------------
  // 目的只有一个：把"菜单项没出现"分成 nomenu（出厂 rowMenuFiber 没找到菜单
  // fiber）与 nopopup（找到了，但 popupForMenu 没拿到弹层），并说明快照行本身
  // 有没有 react expando、它的 root 离出厂 40 步的上限有多远。
  //
  // 刻意的边界：
  //   1. 不镜像 rowMenuFiber 的子树 DFS、不扫描弹层、不做 current 半证明。
  //      nomenu / nopopup 是在【出厂自己的 return 点】上记的，所以不存在
  //      "诊断自己那份 DFS 算出来的结论"冒充出厂结论的风险。这一条是上一版
  //      探针翻车的地方：那份 DFS 复刻得比出厂宽松，会把出厂的 null 读成
  //      found，进而把真正的 nomenu 报成"菜单找到了"。
  //   2. 不新增任何 topmostReason 写点，不改任何 return、条件或原有函数的调用
  //      次数；重试仍是 0 / 8 / 16，诊断不加重试也不延长窗口。
  //   3. 一次右击最多 3 条 attempt，与出厂的 tries 上限一致。
  //   4. 不含 id、标题、回调源码、token，也不调用任何宿主函数。
  //   5. 【弹层实录是侧信道，不是镜像】。它在出厂 popupForMenu 本来就会走到的
  //      四个出口上各记一笔、在 nearestMenuOwner 本来就会走到的两个出口上各
  //      记一笔 owner 状态：不新增循环、不新增 owner walk、不多求值一次
  //      DOM / fiber / 可见性，也不参与任何判定。它记的是出厂那一次循环里
  //      已经发生过的事，不是诊断自己重算一遍——所以它能说"停在哪道门"，
  //      不能说"为什么停"，也不能说产品返回了什么。
  var TOPMOST_DIAG_MAX_ATTEMPTS = 3;
  var TOPMOST_DIAG_MAX_EARLY = 4;
  var TOPMOST_DIAG_ROOT_SHIPPED = TOPMOST_MAX_ANCESTORS;   // 256，与出厂同一个值
  // The diagnostic's own read-only cap. It MUST stay strictly above the shipped
  // one, or the over-shipped-cap verdict below can never fire and the whole
  // point of reporting the two caps separately is lost.
  var TOPMOST_DIAG_ROOT_EXTENDED = 512;
  var topmostDiag = {
    row: null, chain: 0, gen: 0, capped: false, attempts: [], earlyStop: [],
    popup: null,
  };

  // -------------------------------------------------------------------------
  // 弹层门禁实录（只读，不改任何出厂行为，不部署）
  // -------------------------------------------------------------------------
  // 目的只有一个：把"菜单 fiber 找到了、弹层没拿到"这一次循环的真实分叉逐条
  // 记下来——每个候选停在哪道门、owner 上溯实际走了多远。它只回答"哪道门"，
  // 不回答"为什么"，所以它不新增任何门、不改任何条件、不多求值一次 DOM。
  //
  // 传输只有一个槽 topmostDiag.popup，不走返回值、不走参数：
  //   Open   每次 popupForMenu 先自 guard 清槽，再开一份新 trace 并发布信封
  //   Take   Record 立刻取走信封并清槽，逐个核对归属戳
  //   Copy   只出白名单里的 primitive，非法就整份拒成 null
  // 三个归属戳（chain / gen / attempt）只活在信封里，不进 trace、不进 payload。
  // 归属对不上整份作废：迟到的 trace 绝不能被算到另一次 attempt 头上。
  var TOPMOST_DIAG_POPUP_MAX_CANDIDATES = 4;
  var TOPMOST_DIAG_POPUP_OUTCOMES =
    ['copy', 'no-items', 'owner-mismatch', 'hidden', 'accepted'];
  var TOPMOST_DIAG_POPUP_OWNER_ENDS =
    ['found', 'budget', 'chain-ended', 'no-fiber'];

  function topmostDiagPopupOpen(loopTotal) {
    // 自 guard 无条件清旧槽，且在构造之前：不论后面哪一步抛错，上一次的分叉
    // 都不会被这一次的调用读成当前值。
    try { topmostDiag.popup = null; } catch (e) {}
    try {
      var trace = {
        identityOnly: true, loopTotal: loopTotal, scanned: 0, returned: null,
        forkCopy: 0, forkNoItems: 0, forkOwner: 0, forkHidden: 0,
        accepted: 0, dropped: 0, noRecord: 0, candidates: [],
      };
      topmostDiag.popup = {
        chain: topmostDiag.chain,
        gen: topmostDiag.gen,
        attempt: topmostDiag.attempts.length + 1,
        trace: trace,
      };
      return trace;
    } catch (e) {
      try { topmostDiag.popup = null; } catch (e2) {}
      return null;
    }
  }

  // 每个候选一份全新 record。六个 owner 字段的初值就是 null，含义是"这道门
  // 还没跑到"，不是"跑出来是空"。不写回 trace，所以没有需要清空的暂存，
  // 也没有哪个候选能读到上一个候选的 owner 值。
  function topmostDiagPopupCandidate(tr, i) {
    try {
      if (!tr) return null;
      tr.scanned++;
      return {
        i: i, outcome: 'unknown',
        copy: null, hasItems: null, visible: null,
        ulExpando: null, ownerFound: null, ownerEnd: null,
        hops: null, ownerCap: null,
        ownerIsAlternateOfMenuFiber: null,
      };
    } catch (e) { return null; }
  }

  // 调用点要直接写的字段走这里：copy / hasItems 这两道门本来就没有分叉出口，
  // 它们只在候选真的越过那道门时才是"跑过"。
  function topmostDiagPopupMark(rec, key, value) {
    try { if (rec) rec[key] = value; } catch (e) {}
  }

  // tr 与 rec 都是显式形参：不读槽、不留游标，所以候选 record 只能从循环体自己
  // 的局部变量到达。rec 缺失时丢掉本候选明细并计入 noRecord，不复用也不伪造
  // 任何旧候选；记下来的分叉数只按 kind 累计，与截断无关。
  function topmostDiagPopupFork(tr, rec, kind, copy, hasItems, visible) {
    try {
      if (!tr) return;
      if (kind === 'copy') tr.forkCopy++;
      else if (kind === 'no-items') tr.forkNoItems++;
      else if (kind === 'owner-mismatch') tr.forkOwner++;
      else if (kind === 'hidden') tr.forkHidden++;
      else if (kind === 'accepted') { tr.accepted++; tr.returned = rec ? rec.i : null; }
      if (!rec) { tr.noRecord++; return; }
      rec.outcome = kind;
      if (copy !== null && rec.copy === null) rec.copy = copy;
      if (hasItems !== null && rec.hasItems === null) rec.hasItems = hasItems;
      if (visible !== null && rec.visible === null) rec.visible = visible;
      // 截断只发生在诊断：第 5 个及以后的候选照常参与出厂判定，只是不入表。
      if (tr.candidates.length < TOPMOST_DIAG_POPUP_MAX_CANDIDATES) tr.candidates.push(rec);
      else tr.dropped++;
    } catch (e) {}
  }

  function topmostDiagPopupNum(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }
  function topmostDiagPopupBool(v) {
    return v === true || v === false;
  }
  // 可空字段的读：读抛、非法、缺失一律降成 null。那是"没有这一项"，
  // 不是"这一项是空"，更不是把空当成 0 或 unknown 报上去。
  function topmostDiagPopupNumField(obj, key) {
    var v;
    try { v = obj[key]; } catch (e) { return null; }
    return topmostDiagPopupNum(v) ? v : null;
  }
  function topmostDiagPopupBoolField(obj, key) {
    var v;
    try { v = obj[key]; } catch (e) { return null; }
    return topmostDiagPopupBool(v) ? v : null;
  }
  function topmostDiagPopupEndField(obj, key) {
    var v, i;
    try { v = obj[key]; } catch (e) { return null; }
    for (i = 0; i < TOPMOST_DIAG_POPUP_OWNER_ENDS.length; i++) {
      if (TOPMOST_DIAG_POPUP_OWNER_ENDS[i] === v) return v;
    }
    return null;
  }

  // 逐字段白名单拷贝：没有 Object.assign、没有展开、没有 JSON 克隆，所以
  // 输入对象与它的 getter 一个都不会被带进 payload，输出里也不会出现别名。
  // 不可空字段非法、或读它就抛（冒泡到最外层），整份 trace 拒成 null——
  // 宁可这次没有读数，也不要拿 0 / unknown 冒充一次真实分叉。
  function topmostDiagPopupCopy(trace) {
    try {
      if (!trace || typeof trace !== 'object') return null;
      var list = trace.candidates;
      if (!isArray(list)) return null;
      if (trace.identityOnly !== true) return null;
      if (!topmostDiagPopupNum(trace.loopTotal)) return null;
      if (!topmostDiagPopupNum(trace.scanned)) return null;
      if (!topmostDiagPopupNum(trace.forkCopy)) return null;
      if (!topmostDiagPopupNum(trace.forkNoItems)) return null;
      if (!topmostDiagPopupNum(trace.forkOwner)) return null;
      if (!topmostDiagPopupNum(trace.forkHidden)) return null;
      if (!topmostDiagPopupNum(trace.accepted)) return null;
      if (!topmostDiagPopupNum(trace.dropped)) return null;
      if (!topmostDiagPopupNum(trace.noRecord)) return null;
      var out = {
        identityOnly: true,
        loopTotal: trace.loopTotal,
        scanned: trace.scanned,
        forkCopy: trace.forkCopy,
        forkNoItems: trace.forkNoItems,
        forkOwner: trace.forkOwner,
        forkHidden: trace.forkHidden,
        accepted: trace.accepted,
        dropped: trace.dropped,
        noRecord: trace.noRecord,
        returned: topmostDiagPopupNumField(trace, 'returned'),
        candidates: [],
      };
      for (var i = 0; i < list.length; i++) {
        var rec = list[i];
        if (!rec || typeof rec !== 'object') return null;
        var ri = rec.i, ro = rec.outcome;
        if (!topmostDiagPopupNum(ri)) return null;
        var ok = false;
        for (var k = 0; k < TOPMOST_DIAG_POPUP_OUTCOMES.length; k++) {
          if (TOPMOST_DIAG_POPUP_OUTCOMES[k] === ro) { ok = true; break; }
        }
        if (!ok) return null;
        out.candidates.push({
          i: ri,
          outcome: ro,
          copy: topmostDiagPopupBoolField(rec, 'copy'),
          hasItems: topmostDiagPopupBoolField(rec, 'hasItems'),
          visible: topmostDiagPopupBoolField(rec, 'visible'),
          ulExpando: topmostDiagPopupBoolField(rec, 'ulExpando'),
          ownerFound: topmostDiagPopupBoolField(rec, 'ownerFound'),
          ownerEnd: topmostDiagPopupEndField(rec, 'ownerEnd'),
          hops: topmostDiagPopupNumField(rec, 'hops'),
          ownerCap: topmostDiagPopupNumField(rec, 'ownerCap'),
          ownerIsAlternateOfMenuFiber:
            topmostDiagPopupBoolField(rec, 'ownerIsAlternateOfMenuFiber'),
        });
      }
      return out;
    } catch (e) { return null; }
  }

  // 先把信封抓在手里，再立刻清槽：之后无论下面哪一步抛错，槽里都不会留下
  // 一个可能被下一次 attempt 读到的陈旧信封。
  function topmostDiagPopupTake() {
    var env = null;
    try { env = topmostDiag.popup; } catch (e) { env = null; }
    try { topmostDiag.popup = null; } catch (e) {}
    if (!env || typeof env !== 'object') return null;
    try {
      var chain = env.chain, gen = env.gen, attempt = env.attempt, trace = env.trace;
      if (chain !== topmostDiag.chain) return null;
      if (gen !== topmostDiag.gen) return null;
      if (attempt !== topmostDiag.attempts.length + 1) return null;
      return topmostDiagPopupCopy(trace);
    } catch (e) { return null; }
  }

  // collector 的逐层新建：每条 attempt 都是新对象，它的 popup 又是一份新的深
  // 拷贝（拷贝自己再建一遍 candidates）。它不读 topmostDiag.popup 那个槽，
  // 也不额外扫一次 DOM 或 fiber。
  function topmostDiagAttemptsCopy() {
    var src = topmostDiag.attempts;
    var n = src.length < TOPMOST_DIAG_MAX_ATTEMPTS ? src.length : TOPMOST_DIAG_MAX_ATTEMPTS;
    var out = [], i;
    if (!(n > 0)) n = 0;
    for (i = 0; i < n; i++) {
      var a = src[i];
      if (!a || typeof a !== 'object') { out.push(a); continue; }
      out.push({
        try: a.try, stage: a.stage, chain: a.chain, gen: a.gen,
        popup: topmostDiagPopupCopy(a.popup),
      });
    }
    return out;
  }

  // 每条记录都包在 try/catch 里：诊断一旦抛错，绝不能改变出厂行为。
  //
  // 取数与记账是两个独立的 try：取数炸了（信封陈旧、归属不符、字段非法、
  // getter 抛），popup 降成 null，而这一条 attempt 仍然照记——出厂的 stage 是
  // 主证，不能被诊断自己的故障吃掉。哪个 stage 能带 popup 也是产品事实：
  // 只有 nopopup 与 append 是在 popupForMenu 之后记的。
  function topmostDiagRecord(stage) {
    var popup = null;
    try {
      var taken = topmostDiagPopupTake();   // 每个 stage 都取，顺带清残留槽
      if (stage === 'nopopup' || stage === 'append') popup = taken;
    } catch (e) { popup = null; }
    try {
      if (topmostDiag.attempts.length >= TOPMOST_DIAG_MAX_ATTEMPTS) return;
      topmostDiag.attempts.push({
        try: topmostDiag.attempts.length + 1,
        stage: String(stage || 'unknown'),
        chain: topmostDiag.chain,
        gen: topmostDiag.gen,
        popup: popup,
      });
    } catch (e) {}
  }

  // 重试预算耗尽。它【不是】第 4 条 attempt：把最后一次的真实原因覆盖成
  // 'cap'，恰好会毁掉这个探针存在的理由（nomenu 与 nopopup 的区分），所以
  // 这里只置一个布尔，由读取侧和 attempts 一起读。
  function topmostDiagCapped() { try { topmostDiag.capped = true; } catch (e) {} }

  // 链被掐断：dispose，或被下一次右击接管。它记在【链】上而不是伪造一个
  // try —— 被掐断的那次 attempt 根本没有到达任何门禁。
  function topmostDiagEarlyStop(chain, reason) {
    try {
      if (topmostDiag.earlyStop.length >= TOPMOST_DIAG_MAX_EARLY) return;
      topmostDiag.earlyStop.push({ chain: chain, reason: String(reason || 'unknown') });
    } catch (e) {}
  }

  function topmostDiagStart(row, gen) {
    try {
      topmostDiag.chain = topmostDiag.chain + 1;
      topmostDiag.gen = gen;
      topmostDiag.row = row;
      topmostDiag.capped = false;
      topmostDiag.attempts = [];
      // 新链开槽就清：上一条链的 popupForMenu 分叉不归这一条链。
      topmostDiag.popup = null;
      // earlyStop 跨链保留：它是上一条链被掐断的唯一证据，清掉就查不到了。
    } catch (e) {}
  }

  // 快照行断开即清。必须排在 reapTopmost 的 early return 之前，见调用处。
  function topmostDiagReap() {
    try {
      if (topmostDiag.row && !topmostDiag.row.isConnected) {
        topmostDiag.row = null;
        topmostDiag.attempts = [];
        topmostDiag.capped = false;
        topmostDiag.popup = null;
      }
    } catch (e) {}
  }

  function topmostDiagDispose() {
    try {
      topmostDiagEarlyStop(topmostDiag.chain, 'disposed');
      topmostDiag.row = null;
      topmostDiag.attempts = [];
      topmostDiag.capped = false;
      topmostDiag.popup = null;
    } catch (e) {}
  }

  function topmostDiagNow() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
        return performance.now();
      }
    } catch (e) {}
    return Date.now();
  }

  // ---- 以下三个只读助手是本诊断的全部 DOM / fiber 读取面 ------------------
  // expando：只数键并记族名，不取 fiber、不返回任何对象。
  function topmostDiagExpando(row) {
    var n = 0, family = 'none', keys, i;
    try { keys = Object.keys(row); } catch (e) { return { count: 0, family: 'unreadable' }; }
    for (i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0) { n++; if (family === 'none') family = 'fiber'; }
      else if (keys[i].indexOf('__reactInternalInstance$') === 0) { n++; if (family === 'none') family = 'internal'; }
    }
    return { count: n, family: n ? family : 'none' };
  }

  // anchor：只数个数 + 两个布尔。出厂 rowMenuFiber 取 querySelector 的第一条，
  // 所以 firstSelf / nearestRow 描述的正是出厂实际走的那一条 anchor。
  function topmostDiagAnchor(row) {
    var out = { count: 0, firstSelf: false, nearestRow: false };
    try {
      if (!row || !row.querySelectorAll) return out;
      var rid = row.getAttribute ? row.getAttribute('data-session-id') : null;
      var as = row.querySelectorAll('[data-shortcut-session-target]');
      out.count = as.length;
      var first = as.length ? as[0] : null;
      if (first) {
        out.firstSelf = first.getAttribute('data-shortcut-session-target') === rid;
        out.nearestRow = !!(first.closest && first.closest('[data-session-id]') === row);
      }
    } catch (e) { out.error = 'anchor-threw'; }
    return out;
  }

  // root：只沿 .return 上溯数深度。零基——出厂 for (a = 0; f && a < 40; a++)
  // 看的是 depth 0..39，所以 root 落在 depth >= 40 时出厂就解析不出来。
  function topmostDiagRootDepth(f0, cap) {
    var d = 0, f = f0;
    while (f && d < cap) {
      if (f.stateNode && f.stateNode.current && typeof f.stateNode.current === 'object') {
        return { d: d, hit: true, exhausted: false };
      }
      f = f.return; d++;
    }
    return { d: d, hit: false, exhausted: !!f };
  }

  function topmostDiagRoot(row) {
    var out = {
      shipped: { cap: TOPMOST_DIAG_ROOT_SHIPPED, depth: -1, hit: false, exhausted: false },
      extended: { cap: TOPMOST_DIAG_ROOT_EXTENDED, depth: -1, hit: false, exhausted: false },
      failureKind: 'no-expando',
    };
    try {
      if (!topmostDiagExpando(row).count) return out;
      var fiber = fiberOf(row);
      if (!fiber) { out.failureKind = 'no-fiber'; return out; }
      var sh = topmostDiagRootDepth(fiber, out.shipped.cap);
      var xt = topmostDiagRootDepth(fiber, out.extended.cap);
      out.shipped.depth = sh.d; out.shipped.hit = sh.hit; out.shipped.exhausted = sh.exhausted;
      out.extended.depth = xt.d; out.extended.hit = xt.hit; out.extended.exhausted = xt.exhausted;
      out.failureKind = sh.hit ? 'ok' : (xt.hit ? 'over-shipped-cap' : (xt.exhausted ? 'root-budget-ended' : 'root-not-found'));
    } catch (e) { out.failureKind = 'threw'; }
    return out;
  }

  // selection：与 api.topmost() 的默认取行顺序一致（置顶优先），只出枚举。
  function topmostDiagSelection() {
    try {
      var sec = document.querySelector('[data-pinned-section]');
      if (sec && sec.querySelector('[data-session-id]')) return 'pinned-first';
      if (document.querySelector('[data-session-id]')) return 'document-first';
    } catch (e) {}
    return 'none';
  }

  function topmostReason(reason) {
    topmostState.lastReason = String(reason || '');
  }

  function fiberOf(node) {
    if (!node) return null;
    var keys;
    try { keys = Object.keys(node); } catch (e) { return null; }
    for (var i = 0; i < keys.length; i++) {
      // __reactProps$ holds props, not a fiber. Only the fiber keys are walked.
      if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
        var f = node[keys[i]];
        if (f && typeof f === 'object') return f;
      }
    }
    return null;
  }

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  // The one place that decides "is this the host's handlePinSession?". Kept
  // separate and pure so it can be asserted directly against a fake hook chain.
  function looksLikeHandlePin(hook) {
    if (!hook) return false;
    var ms = hook.memoizedState;
    if (!isArray(ms) || ms.length !== 2) return false;
    var fn = ms[0];
    var deps = ms[1];
    if (typeof fn !== 'function' || fn.length !== 3) return false;
    if (!isArray(deps) || deps.length !== 7) return false;
    if (typeof deps[0] !== 'function') return false;                             // isReadOnlySessionById
    if (!isArray(deps[1])) return false;                                        // currentPinnedItemsOrder
    if (typeof deps[2] !== 'string') return false;                              // conversationSource
    if (!deps[3] || typeof deps[3] !== 'object') return false;                  // pinnedProjectSessionPages
    if (typeof deps[4] !== 'function') return false;                            // mergePinnedItemPayloads
    if (typeof deps[5] !== 'function') return false;                            // removePinnedItemPayload
    if (typeof deps[6] !== 'function') return false;                            // setPinnedItemsOrder
    var src = '';
    try { src = Function.prototype.toString.call(fn); } catch (e) { return false; }
    return src.indexOf('.pinSession') >= 0 && src.indexOf('.getSessionInfo') >= 0;
  }

  function findHandlePins(fiber) {
    var found = [];
    for (var a = 0; fiber && a < TOPMOST_MAX_ANCESTORS; a++) {
      var hook = fiber.memoizedState;
      for (var h = 0; hook && h < TOPMOST_MAX_HOOKS; h++) {
        if (looksLikeHandlePin(hook)) found.push(hook.memoizedState);
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    return found;
  }

  // ---- which half of the double buffered tree are we looking at? ----
  // React only writes __reactFiber$<random> onto a DOM node ONCE, when the node
  // is created. A component that has re-rendered since then has TWO fibers --
  // the current one and its alternate -- and the expando keeps pointing at
  // whichever one existed at mount. Each half carries its OWN hook list, so the
  // stale half's handlePinSession closes over the order array of an older
  // render. Reading it produced two real bugs:
  //   - stale says B is first while live says A is  =>  a real "to top" on B is
  //     short-circuited into a no-op and B never moves;
  //   - stale says B is not first while live says it is  =>  a redundant
  //     pinSession, and the stale closure then setOrder()s an order array built
  //     from the old snapshot, overwriting whatever changed since.
  //
  // So the half is resolved, not guessed. The chain of .return links inside one
  // tree is self-consistent and ends at that tree's own HostRoot fiber, while
  // both halves share ONE FiberRootNode: root.stateNode.current is by
  // definition the current HostRoot. So:
  //   chain top === current            -> the expando gave us the current half
  //   chain top === current.alternate  -> the expando gave us the stale half,
  //                                        and fiber.alternate is its 1:1 pair
  //   anything else / no root reachable-> we cannot prove it, and a capability
  //                                        we cannot prove is not used.
  function currentHostRoot(fiber) {
    var f = fiber;
    for (var a = 0; f && a < TOPMOST_MAX_ANCESTORS; a++) {
      if (f.stateNode && f.stateNode.current && typeof f.stateNode.current === 'object') {
        return f.stateNode.current;
      }
      f = f.return;
    }
    return null;
  }

  function chainTop(fiber) {
    var f = fiber;
    for (var a = 0; f && f.return && a < TOPMOST_MAX_ANCESTORS; a++) f = f.return;
    return f;
  }

  // Returns { fiber: <current half>, reason: '' } or { fiber: null, reason }.
  function currentFiberOf(node) {
    var f0 = fiberOf(node);
    if (!f0) return { fiber: null, reason: 'no-fiber-root' };
    var current = currentHostRoot(f0);
    if (!current) return { fiber: null, reason: 'no-fiber-root' };
    var top = chainTop(f0);
    if (top === current) return { fiber: f0, reason: '' };
    if (current.alternate && top === current.alternate) {
      var pair = f0.alternate;
      // The pair is only accepted once it is itself proven to be in the current
      // tree. A one-sided assumption here is what caused the stale reads.
      if (pair && chainTop(pair) === current) return { fiber: pair, reason: '' };
    }
    return { fiber: null, reason: 'unproven-fiber-tree' };
  }

  // READ ONLY. Nothing here pins, un-pins, clicks or writes; it only reports
  // whether the capability exists and what the host's own order array says.
  // api.topmost() is the same function, so the daemon log and a probe see
  // exactly what the menu item decided.
  function topmostCapability(rowEl) {
    var id = rowEl && rowEl.getAttribute ? rowEl.getAttribute('data-session-id') : null;
    if (!id) return { available: false, reason: 'no-session-row' };
    // Cloud first, and never guessed at: cloud rows carry bare-numeric ids
    // (measured 2026-10-02, 447993841729699) and the pinned order on this
    // machine has only ever held local mvs_ ids, so a cloud "to top" is
    // refused instead of attempted.
    if (/^[0-9]+$/.test(id)) return { available: false, reason: 'cloud-not-provable', id: id };
    var cur = currentFiberOf(rowEl);
    if (!cur.fiber) return { available: false, reason: cur.reason, id: id };
    // Only the current half is searched. The stale half is never merged in and
    // never preferred: it is not "a second opinion", it is an old snapshot.
    var hits = findHandlePins(cur.fiber);
    if (!hits.length) return { available: false, reason: 'no-handle-pin-session', id: id };
    if (hits.length > 1) {
      return { available: false, reason: 'ambiguous-handle-pin-session', id: id, matches: hits.length };
    }
    var entry = hits[0];
    var fn = entry[0];
    var deps = entry[1];
    var order = deps[1];
    var source = deps[2];
    if (source !== 'local') return { available: false, reason: 'source-not-local:' + source, id: id };
    var readOnly = false;
    // The host's own first statement: if (isReadOnlySessionById(e, t)) return;
    // -- it returns silently, so calling it would look like it worked.
    try { readOnly = !!deps[0](id, source); } catch (e) {
      return { available: false, reason: 'readonly-probe-threw', id: id };
    }
    if (readOnly) return { available: false, reason: 'readonly-session', id: id };
    var first = order.length ? order[0] : null;
    // Already at the top? Judged from the host's OWN current order array (the
    // one it loaded from the persisted preference and would persist back), not
    // from anything cached here, because the host rolls its array back on
    // failure and a private cache would happily disagree with it forever.
    var alreadyTop = !!(first && first.type === 'session' && String(first.id) === id);
    return {
      available: true, reason: alreadyTop ? 'already-top' : 'ok', id: id, source: source,
      alreadyTop: alreadyTop, orderLength: order.length,
      orderFirst: first ? (first.type + ':' + first.id) : '', fn: fn,
      // The host's OWN current order array, the very object the host would
      // persist back. It is returned, not copied and not reinterpreted, and it
      // is only reachable on the branch where the fiber tree, the hook shape,
      // the source and the read-only probe have ALL already been proven -- an
      // unproven row never gets here. The 红色悬停锁顶 button needs it because
      // the host's order is the ONLY truth about where a session really sits;
      // the DOM never is. api.topmost() still does NOT expose it.
      order: order,
      // The host's own read-only predicate, only ever reached on the fully
      // proven branch above. api.topmost() does NOT expose it; it exists so the
      // lock's witness path can ask about a target that is not on screen.
      probe: deps[0],
    };
  }

  // The Dropdown that owns THIS row's menu is a DESCENDANT of the row element,
  // not an ancestor. Read out of the archive on 2026-10-03:
  //
  //  @316711900  return jsxs("div", {"data-session-id": n.id, children: [
  //  @316711700      jsx(B.L, { menu: tv, placement:"bottomLeft",
  //                    trigger:["contextMenu"], open: eY, onOpenChange: tf, ...
  //                    children: jsxs("div", { className:"group relative rounded-lg", ...
  //                      children: [ <button data-shortcut-session-target={n.id}> ...,
  //                                 <div className:"absolute right-1 ...">
  //                                   jsx(B.L, { menu: tv, ... })   <- the hover "..." one
  //  and the ROW COMPONENT's own props (@316702376) are
  //      { session, onActivateSession, ..., onPinSession, onDeleteSession }
  //      -- there is no menu prop in them at all.
  //
  // Walking .return (ancestors) from the row therefore never finds it, and the
  // earlier version of this function did exactly that, so the item was injected
  // into nothing. Two ways in, both anchored on something real:
  //
  //  1. The row's own title button carries data-shortcut-session-target, and it
  //     is rendered INSIDE the contextMenu dropdown's children, so walking up
  //     from it lands on that dropdown and not on the hover "..." dropdown,
  //     which is a sibling.
  //  2. If that button is missing (a build that renders the row differently, or
  //     a row whose menu array is empty), a bounded depth-first walk of the
  //     row's own subtree looks for a dropdown that declares
  //     trigger:["contextMenu"]. Uniqueness is required: two candidates mean we
  //     cannot tell which popup belongs to this row, so nothing is injected.
  function rowMenuFiber(rowEl) {
    if (!rowEl) return null;
    var anchor = rowEl.querySelector ? rowEl.querySelector('[data-shortcut-session-target]') : null;
    if (anchor) {
      var f = fiberOf(anchor);
      for (var a = 0; f && a < TOPMOST_MAX_ANCESTORS; a++) {
        var p = f.memoizedProps;
        if (p && isArray(p.menu) && p.menu.length) return f;
        f = f.return;
      }
      // The anchor existed but nothing above it owns a menu: this row has no
      // right-click menu at all, which is a legitimate host state.
      return null;
    }
    var root = currentFiberOf(rowEl).fiber;
    if (!root) return null;
    var found = null;
    var budget = TOPMOST_MAX_MENU_NODES;
    var stack = [{ fiber: root, depth: 0 }];
    while (stack.length && budget > 0) {
      var item = stack.pop();
      var fb = item.fiber;
      budget--;
      var pr = fb.memoizedProps;
      if (pr && isArray(pr.menu) && pr.menu.length && isContextMenuTrigger(pr.trigger)) {
        if (found) return null;                       // ambiguous -> fail closed
        found = fb;
      }
      if (item.depth >= TOPMOST_MAX_MENU_DEPTH) continue;
      var child = fb.child;
      for (var c = 0; child && c < 16; c++) {
        stack.push({ fiber: child, depth: item.depth + 1 });
        child = child.sibling;
      }
    }
    return found;
  }

  function isContextMenuTrigger(trigger) {
    if (!trigger) return false;
    var list = isArray(trigger) ? trigger : [trigger];
    for (var i = 0; i < list.length; i++) if (String(list[i]) === 'contextMenu') return true;
    return false;
  }

  // The NEAREST ancestor of the popup that owns a menu array. "Nearest" is the
  // whole point: the row's hover "..." dropdown and the contextMenu dropdown are
  // nested inside each other, so a plain "is this popup anywhere under the
  // contextMenu dropdown" test also accepts the hover menu's popup -- and the
  // copy submenu's popup is a further case of the same mistake. The popup that
  // opened for THIS right click is the one whose closest menu owner is the
  // dropdown we bound to the row.
  //
  // rec 与 want 是【可选的诊断侧信道】，只读不判。rec 是【本候选】的 record
  // （不是每次调用共用的暂存），want 是这一次调用要绑定的 menuFiber。
  // 返回类型、循环、返回值集合与调用次数一字未改。
  function nearestMenuOwner(fiber, rec, want) {
    // ulExpando 只在入口写一次，取的就是手里这个 fiber 的有无比：false 是
    // "没有 fiber 可走"，true 是"有"。两个出口都不再改它，所以它不可能
    // 带着上一个候选的值到这里。
    if (rec) { try { rec.ulExpando = !!fiber; } catch (e) {} }
    for (var i = 0; fiber && i < TOPMOST_MAX_ANCESTORS; i++) {
      var p = fiber.memoizedProps;
      if (p && isArray(p.menu) && p.menu.length) {
        if (rec) {
          try {
            // 与未命中出口同一个守卫：入口没记上就不报出口，字段留 null，
            // 绝不伪造一次 found。
            if (rec.ulExpando !== null) {
              rec.ownerFound = true;
              rec.ownerEnd = 'found';
              rec.hops = i;
              rec.ownerCap = TOPMOST_MAX_ANCESTORS;
              // 严格双向：两个方向、非空、互不相同才算配对。单向一律 false。
              // 这是身份旁证，不参与任何放行，也不据此声称哪一半是当前树。
              rec.ownerIsAlternateOfMenuFiber =
                !!(fiber && want && fiber !== want
                  && fiber.alternate === want
                  && want.alternate === fiber);
            }
          } catch (e) {}
        }
        return fiber;
      }
      fiber = fiber.return;
    }
    if (rec) {
      try {
        if (rec.ulExpando !== null) {
          rec.ownerFound = false;
          // 三态判定式逐字就是这一句：走到 null 一律 chain-ended，
          // 绝不写成 budget。
          rec.ownerEnd = (rec.ulExpando === false)
            ? 'no-fiber' : (fiber ? 'budget' : 'chain-ended');
          rec.hops = i;
          rec.ownerCap = TOPMOST_MAX_ANCESTORS;
          rec.ownerIsAlternateOfMenuFiber = null;
        }
      } catch (e) {}
    }
    return null;
  }

  // Can the user actually see this element? getClientRects() is empty for a
  // display:none subtree, which is what a closing rc-trigger overlay and every
  // antd-cached overlay node are. A missing API is treated as NOT visible:
  // the failure direction that matters here is claiming an item is on screen
  // when it is not, because api.topmost().injected is what the daemon log and
  // the operator read.
  function elementIsVisible(el) {
    if (!el) return false;
    if (typeof el.getClientRects !== 'function') return false;
    try { return el.getClientRects().length > 0; } catch (e) { return false; }
  }

  function popupForMenu(menuFiber) {
    var pops = document.querySelectorAll('.ant-dropdown-menu');
    // 一次调用一次实录。开槽/发信封都在 Open 里面，这一行只是把同一份 trace
    // 取回循环体用——没有第二次 querySelectorAll，没有额外的任何求值。
    var __tr = topmostDiagPopupOpen(pops.length);
    for (var i = 0; i < pops.length; i++) {
      var ul = pops[i];
      var __rec = topmostDiagPopupCandidate(__tr, i);
      // The copy submenu is a real menu with the same markup; its popup carries
      // this class (asar@316709202) and it belongs to the parent item.
      if (ul.closest && ul.closest('.mavis-sidebar-copy-popup')) { topmostDiagPopupFork(__tr, __rec, 'copy', true, null, null); continue; }
      // Only ever a menu the host actually rendered items into.
      if (!ul.querySelector('.matrix-menu-item')) { topmostDiagPopupFork(__tr, __rec, 'no-items', false, false, null); continue; }
      // copy / hasItems 这两道门没有分叉出口，可它们跑过了就是跑过了，
      // 在这里如实标上；owner-mismatch 那一种在下面统一收口。
      topmostDiagPopupMark(__rec, 'copy', false); topmostDiagPopupMark(__rec, 'hasItems', true);
      // Exact binding, through the popup's own React parent chain: portals keep
      // it, so the owner of THIS popup has to be the dropdown of THIS row.
      if (nearestMenuOwner(fiberOf(ul), __rec, menuFiber) !== menuFiber) { topmostDiagPopupFork(__tr, __rec, 'owner-mismatch', false, true, null); continue; }
      // Same owner, but not on screen. rc-trigger keeps a closed overlay
      // mounted while its close motion runs and antd caches the node after
      // that, so an item injected here is an item the user will never look at
      // while topmostState.injected reports 1. Skip it and keep looking, so the
      // bounded retry can still find the visible popup of the same owner.
      if (!elementIsVisible(ul)) { topmostReason('popup-hidden'); topmostDiagPopupFork(__tr, __rec, 'hidden', false, true, false); continue; }
      topmostDiagPopupFork(__tr, __rec, 'accepted', false, true, true);
      return ul;
    }
    return null;
  }

  function buildTopmostItem(cap, rowEl, sessionId) {
    var li = document.createElement('li');
    li.className = 'ant-dropdown-menu-item' + (cap.available ? '' : ' opacity-40 cursor-not-allowed');
    li.setAttribute('role', 'menuitem');
    li.setAttribute(TOPMOST_ATTR, cap.available ? '1' : '0');
    if (!cap.available) li.setAttribute('aria-disabled', 'true');
    var inner = document.createElement('div');
    inner.className = 'matrix-menu-item px-2 py-1 flex items-center';
    var box = document.createElement('div');
    box.className = 'relative flex w-full min-w-0 items-center';
    var label = document.createElement('div');
    label.className = 'desktop-text-ui-body flex min-w-0 flex-1 items-center';
    // Appended, never replacing: the host's own items and its dividers stay
    // exactly where they are and stay clickable.
    //
    // The disabled state shows a Chinese reason, never the internal code: the
    // code stays in api.topmost().reason for the daemon log, where an operator
    // reads it, and a user only ever sees prose.
    label.textContent = cap.available ? TOPMOST_LABEL : (TOPMOST_LABEL + '（' + topmostReasonText(cap.reason) + '）');
    box.appendChild(label);
    inner.appendChild(box);
    li.appendChild(inner);
    if (cap.available) {
      // Keyboard reachable. rc-menu drives its own items with roving tabindex
      // and its own key handling, and it only knows about items it rendered,
      // so an appended li is invisible to ArrowDown and ArrowUp. Tab does reach
      // it (the popup is real DOM in an open overlay), so it carries a tabindex
      // and activates on Enter/Space -- the two keys a menu item is expected to
      // answer to. That is Tab reachability, NOT arrow parity with the host's
      // own items: see README 15.8.
      //
      // KNOWN LIMITATION, deliberately not "fixed": the host's rc-menu keeps
      // the roving tabindex and the arrow handling for the items it rendered.
      // An appended li is simply not in that set, so ArrowDown steps over
      // 到最顶 instead of landing on it. Substituting our own arrow handling
      // would mean intercepting keys globally, which is a far worse trade than
      // a keyboard user pressing Tab once.
      li.setAttribute('tabindex', '0');
      li.addEventListener('click', function (ev) { onTopmostActivate(ev, li, rowEl, sessionId); });
      // Exactly one listener, on this node. Nothing is captured, nothing is
      // global, and no key other than Enter/Space is touched -- so Escape still
      // belongs to the host and still closes its menu.
      li.addEventListener('keydown', function (ev) {
        if (!ev) return;
        var k = ev.key;
        var isSpace = (k === ' ' || k === 'Spacebar');
        if (k !== 'Enter' && !isSpace) return;
        // Only a real key press may act. A synthetic dispatch must not be able
        // to pin anything either, and it has no default action to suppress, so
        // the guard comes before everything.
        if (!ev.isTrusted) return;
        // Space's own default action on a focused element is to scroll the
        // nearest scrollable ancestor -- which is exactly the sidebar list, so
        // a keyboard user who activates the item would also scroll the
        // sidebar. Enter has no such default, so it is left alone.
        //
        // preventDefault, never stopPropagation: the host must keep seeing its
        // own key events.
        if (isSpace && ev.preventDefault) { try { ev.preventDefault(); } catch (e) {} }
        onTopmostActivate(ev, li, rowEl, sessionId);
      });
    }
    return li;
  }

  // User-facing wording for the fail-closed reasons. api.topmost().reason keeps
  // the machine code; this map is only ever rendered into the menu item.
  var TOPMOST_REASON_TEXT = {
    'no-handle-pin-session': '当前宿主版本不支持置顶排序',
    'ambiguous-handle-pin-session': '宿主置顶回调不唯一，已停用',
    'unproven-fiber-tree': '无法确认宿主当前渲染树，已停用',
    'no-fiber-root': '无法确认宿主当前渲染树，已停用',
    'readonly-session': '该会话只读，无法置顶',
    'readonly-probe-threw': '只读判定失败，已停用',
    'cloud-not-provable': '云端会话暂不支持置顶排序',
    'no-session-row': '未找到会话行',
    'no-menu-fiber': '该行没有可用的右键菜单',
    'busy': '上一次操作还没结束',
    'toplock-other': '已有会话被锁顶，请先解除',
    'untrusted-click': '只响应真实点击',
    'row-gone': '会话行已变化',
    'menu-gone': '菜单已关闭',
    'call-threw': '调用宿主失败',
    // r4: the shared gate said no. This is NOT "busy" -- busy means somebody
    // else is mid-call and the user can simply try again in a moment; here the
    // gate itself could not be taken (unusable slot, or another instance), so
    // the wording has to say "we did not write anything" rather than "wait".
    'gate-unavailable': '置顶闸不可用，本次未对宿主做任何写入',
  };
  function topmostReasonText(reason) {
    var r = String(reason || '');
    if (TOPMOST_REASON_TEXT[r]) return TOPMOST_REASON_TEXT[r];
    if (r.indexOf('source-not-local:') === 0) return '非本地视图，暂不支持置顶排序';
    // Unknown code: still a Chinese sentence, never the raw identifier.
    return '当前宿主版本不支持置顶排序';
  }

  // Closing the host's own dropdown. The Dropdown is a CONTROLLED component:
  // its open state lives in the row component, and the prop the host handed it
  // (onOpenChange) is exactly what rc-dropdown calls when a menu item is
  // activated. Calling it with false is therefore the host's own close path,
  // not a synthetic click on one of its items -- deliberately, because
  // dispatching a click on a host menu item would RUN that item (pin, delete,
  // archive). If the prop is missing or throws, the menu simply stays open and
  // that is reported; nothing about the DOM is faked or hidden.
  function closeHostMenu(menuFiber) {
    if (!menuFiber || !menuFiber.memoizedProps) return 'menu-close-unavailable';
    var cb = menuFiber.memoizedProps.onOpenChange;
    if (typeof cb !== 'function') return 'menu-close-unavailable';
    try {
      cb(false);
      return 'menu-closed';
    } catch (e) {
      return 'menu-close-threw';
    }
  }

  function onTopmostActivate(ev, li, rowEl, sessionId) {
    topmostState.clicks++;
    // Only a real user gesture may act. Diagnostics and probes never call this.
    if (!ev || !ev.isTrusted) { topmostState.blocked++; topmostReason('untrusted-click'); return; }
    // One call at a time, across BOTH entry points: see hostGate above.
    if (topmostState.busy || hostCallBusy()) { topmostState.blocked++; topmostReason('busy'); return; }
    if (!li.isConnected) { topmostState.blocked++; topmostReason('menu-gone'); return; }
    // The row must still be the same row. A right click on a row the host has
    // since unmounted (view switch, virtualised scroll) must never end up
    // pinning whatever session took its place.
    if (!rowEl || !rowEl.isConnected || rowEl.getAttribute('data-session-id') !== sessionId) {
      topmostState.blocked++;
      topmostReason('row-gone');
      return;
    }
    // Re-resolved on every activation: the previous call's closure captured the
    // order array of that render, and a re-render means a new one.
    var cap = topLockBlocksTopmost(topmostCapability(rowEl), sessionId);
    if (!cap.available) { topmostState.blocked++; topmostReason(cap.reason); return; }
    // The menu this item lives in, resolved the same way, purely so the host's
    // own close path can be used afterwards.
    var menuFiber = rowMenuFiber(rowEl);
    if (cap.alreadyTop) {
      topmostState.noops++;
      topmostReason('already-top');
      closeHostMenu(menuFiber);
      return;
    }
    // r4: the shared gate is the ONLY thing standing between two injected
    // instances and a concurrent host write, and hostCallTake fails closed --
    // it returns null both when the window slot is unusable and when another
    // instance legitimately holds the ticket. r3 shipped
    //   topmostState.ticket = hostCallTake();  ... ret = cap.fn(...)
    // which ignored that null and called the host anyway, so every fail-closed
    // path in the gate was decorative on this route. A null ticket means NO
    // call: busy must not be left set, calls must not be counted, and cap.fn
    // must not run. The user's exit is unaffected: nothing was in flight, and
    // clicking again after the other instance settles is the whole recovery.
    var ticket = hostCallTake();
    if (!ticket) {
      topmostState.busy = false;
      topmostState.ticket = null;
      topmostState.blocked++;
      topmostReason('gate-unavailable');
      closeHostMenu(menuFiber);
      return;
    }
    topmostState.busy = true;
    topmostState.ticket = ticket;
    topmostState.calls++;
    topmostState.lastSessionId = sessionId;
    topmostState.lastSource = cap.source;
    topmostReason('calling');
    var ret;
    try {
      // EXACTLY three arguments. A missing or defaulted index makes the host
      // append to the end of the pinned order, which is the opposite of what
      // this item promises.
      ret = cap.fn(sessionId, true, 0);
    } catch (e) {
      topmostState.busy = false;
      hostCallRelease(topmostState.ticket);
      topmostState.ticket = null;
      topmostState.blocked++;
      topmostReason('call-threw');
      closeHostMenu(menuFiber);
      return;
    }
    // Closed either way: the gesture happened, and leaving a menu hanging open
    // after the user used it is the confusing outcome. The host owns the
    // outcome and the toast; this says nothing about whether it worked.
    topmostState.lastClose = closeHostMenu(menuFiber);
    // The callback catches its own failures, rolls its own array back and
    // toasts on its own. A resolved promise here means "the host finished
    // handling it", NOT "it worked", so nothing is reported as a success.
    Promise.resolve(ret).then(function () {
      topmostState.busy = false;
      hostCallRelease(topmostState.ticket);
      topmostState.ticket = null;
      topmostReason('host-returned');
    }, function () {
      topmostState.busy = false;
      hostCallRelease(topmostState.ticket);
      topmostState.ticket = null;
      topmostReason('host-rejected');
    });
  }

  function buildTopLockMenuItem(cap, rowEl, sessionId) {
    var li = document.createElement('li');
    li.className = 'ant-dropdown-menu-item' + (cap.available ? '' : ' opacity-40 cursor-not-allowed');
    li.setAttribute('role', 'menuitem');
    li.setAttribute(TOPLOCKMENU_ATTR, cap.available ? '1' : '0');
    if (!cap.available) li.setAttribute('aria-disabled', 'true');
    var inner = document.createElement('div');
    inner.className = 'matrix-menu-item px-2 py-1 flex items-center';
    var box = document.createElement('div');
    box.className = 'relative flex w-full min-w-0 items-center';
    var label = document.createElement('div');
    label.className = 'desktop-text-ui-body flex min-w-0 flex-1 items-center';
    label.textContent = cap.available
      ? TOPLOCKMENU_LABEL
      : (TOPLOCKMENU_LABEL + '（' + topLockMenuReasonText(cap.reason) + '）');
    box.appendChild(label);
    inner.appendChild(box);
    li.appendChild(inner);
    if (cap.available) {
      // Keyboard reachable, exactly as 到最顶 is: tabindex plus Enter/Space,
      // with the same isTrusted guard. The known ArrowDown limitation belongs to
      // rc-menu's roving tabindex and applies to this item identically; see the
      // long comment in buildTopmostItem rather than restating it here.
      li.setAttribute('tabindex', '0');
      li.addEventListener('click', function (ev) { onTopLockMenuActivate(ev, li, rowEl, sessionId); });
      li.addEventListener('keydown', function (ev) {
        if (!ev) return;
        var k = ev.key;
        var isSpace = (k === ' ' || k === 'Spacebar');
        if (k !== 'Enter' && !isSpace) return;
        if (!ev.isTrusted) return;
        // preventDefault, never stopPropagation: Space's own default action
        // scrolls the nearest scrollable ancestor, which is the sidebar.
        if (isSpace && ev.preventDefault) { try { ev.preventDefault(); } catch (e) {} }
        onTopLockMenuActivate(ev, li, rowEl, sessionId);
      });
    }
    return li;
  }

  // The menu's own entry into the lock machine. NOT onTopLockActivate: that one
  // requires the node it is handed to BE the red button, and a menu item never
  // is one -- a row whose hover cluster we cannot identify never gets a button,
  // and the menu is then the only way in. The two entries share the gate, the
  // store, the budget, the generation and the single host write, and they differ
  // in exactly three things: the event, the node, and the isTrusted wording.
  function onTopLockMenuActivate(ev, li, rowEl, sessionId) {
    topLockState.clicks++;
    // Only a real user gesture. Written as an explicit !== true so this is not a
    // second copy of the red button's guard text (the offline mutation harness
    // pins that one to exactly one site).
    if (!ev || ev.isTrusted !== true) { topLockState.blocked++; topLockReason('untrusted-click'); return; }
    if (disposed) return;
    // No preventDefault and no stopPropagation here, exactly as in
    // onTopmostActivate: a click inside the host's open overlay does not
    // activate the row and does not re-open the host's own menu, so there is
    // nothing of ours to suppress and nothing of the host's to intercept. The
    // host keeps closing its own dropdown through its own onOpenChange.
    if (!li || !li.isConnected) { topLockState.blocked++; topLockReason('menu-gone'); return; }
    // The row must still be the same row: a right click on a row the host has
    // since recycled must never end up locking whatever session took its place.
    if (!rowEl || !rowEl.isConnected || rowEl.getAttribute('data-session-id') !== sessionId) {
      topLockState.blocked++;
      topLockReason('row-gone');
      return;
    }
    // Releasing the current target takes precedence over capability and over the
    // gate, exactly as it does on the red button: it is the user's way out and
    // it is a purely local write.
    var isTarget = !!topLockState.intentId && sessionId === topLockState.intentId;
    if (isTarget) {
      topLockReleaseTarget();
      return;
    }
    return topLockArmIntent(rowEl, sessionId);
  }

  // One implementation for both entries, from the capability re-resolution to
  // the single host write, lives in the lock block next to onTopLockActivate --
  // see topLockArmIntent there. Two copies of it would eventually disagree about
  // the one question that matters ("may we still write the host after a failed
  // store?"), and they would disagree in the dangerous direction.

  function clearTopLockMenuItem() {
    var items = document.querySelectorAll('li[' + TOPLOCKMENU_ATTR + ']');
    for (var i = 0; i < items.length; i++) items[i].remove();
  }

  // Injected at the SAME point as 到最顶 and immediately after it, so the two
  // entries are one pair in one menu. Appended, never replacing: the host's own
  // items and its dividers stay exactly where they are and stay clickable.
  // Uniqueness is per attribute, so re-injecting a chain that is retried finds
  // what is already there instead of stacking a second copy.
  function ensureTopLockMenuItem(ul, rowEl, sessionId) {
    if (!ul) return null;
    var existing = ul.querySelector('li[' + TOPLOCKMENU_ATTR + ']');
    if (existing) return existing;
    var li = buildTopLockMenuItem(topmostCapability(rowEl), rowEl, sessionId);
    ul.appendChild(li);
    topmostState.lockInjected = 1;
    return li;
  }

  function clearTopmostItems() {
    var items = document.querySelectorAll('li[' + TOPMOST_ATTR + ']');
    for (var i = 0; i < items.length; i++) items[i].remove();
    topmostNode = null;
    topmostState.injected = 0;
  }

  function tryInjectTopmost(row, sessionId) {
    var menuFiber = rowMenuFiber(row);
    if (!menuFiber) {
      topmostDiagRecord('nomenu');
      topmostReason('no-menu-fiber');
      return false;
    }
    var ul = popupForMenu(menuFiber);
    if (!ul) {
      topmostDiagRecord('nopopup');
      return false;
    }
    var id = sessionId || row.getAttribute('data-session-id');
    var cap = topLockBlocksTopmost(topmostCapability(row), id);
    topmostReason(cap.reason);
    var existing = ul.querySelector('li[' + TOPMOST_ATTR + ']');
    if (existing) {
      topmostNode = existing;
      topmostState.injected = 1;
      // The pair is one unit: a chain that is retried must end up with BOTH
      // entries, and never with two copies of either.
      ensureTopLockMenuItem(ul, row, id);
      topmostDiagRecord('append');
      return true;
    }
    var li = buildTopmostItem(cap, row, id);
    ul.appendChild(li);
    topmostNode = li;
    topmostState.injected = 1;
    // Immediately after 到最顶, from the same injection point. The lock entry is
    // NOT gated on the lock's mutual exclusion: replacing the current lock target
    // is exactly what that item is for.
    ensureTopLockMenuItem(ul, row, id);
    topmostDiagRecord('append');
    return true;
  }

  function dropTopmostTimer(id) {
    var i = topmostTimers.indexOf(id);
    if (i >= 0) topmostTimers.splice(i, 1);
  }

  // Capture phase, observation only: no preventDefault, no stopPropagation, no
  // interception of the host's own right click handling. The host opens the
  // menu from the same event, so the popup does not exist yet while we are
  // still in the capture phase; the bounded watch below is what finds it, and
  // every attempt re-checks the row, so a view switch in between fails closed
  // instead of injecting into somebody else's menu.
  //
  // RETARGETING. Two things can change under a chain that is already running:
  // the user right clicks a different row, and the host reuses one DOM node
  // for a different session.
  //
  // Two independent defences, and the honest order is: cancellation first,
  // generation second.
  //
  //   1. Cancelling the pending timers. A timer that is still QUEUED and has
  //      not run is cancellable by clearTimeout, so when this works it is
  //      normally enough on its own.
  //   2. The generation counter, as defence in depth. It does not depend on the
  //      cancellation having been registered, on the id still being in
  //      topmostTimers, or on it having taken effect before the callback ran.
  //      It is bumped the moment a new chain starts and compared first thing
  //      in every attempt, so a chain that is already running when its
  //      successor arrives does nothing at all, however it was scheduled.
  //
  // This is deliberately NOT a claim that a queued timer is un-cancellable --
  // it is not. It is a second, independent gate so that a bug in (1) cannot
  // turn into an item injected into a menu the user has already moved on from.
  function onContextMenu(ev) {
    if (disposed) return;
    // Any previous item goes first, whatever happened to its menu. Both entries:
    // the lock item carries its own attribute, so it needs its own sweep.
    clearTopmostItems();
    clearTopLockMenuItem();
    if (!ev || !ev.isTrusted) return;
    var t = ev.target;
    var row = t && t.closest ? t.closest('[data-session-id]') : null;
    if (!row) return;
    // 上一条链还有排队 timer 就被接管 = 它被掐断了。这是"被掐断"的唯一真实
    // 证据，必须记在 topmostDiagStart 清空 attempts 之前。observation only.
    var hadPending = topmostTimers.length > 0;
    // 上一条 watch 先拆，再谈新链。顺序是刻意的：观察器是挂在 document 上的
    // 【长驻监听】，比一个排队 timer 危险得多，所以它必须排在"取消排队"这一步
    // 之前被处理掉，而不是依赖后面那个 clearTimeout 循环（那个循环只认
    // topmostTimers 里的 id，认不了一个观察器）。
    stopTopmostWatch(topmostWatch);
    for (var ct = 0; ct < topmostTimers.length; ct++) {
      try { window.clearTimeout(topmostTimers[ct]); } catch (e) {}
    }
    topmostTimers.length = 0;
    if (hadPending) topmostDiagEarlyStop(topmostDiag.chain, 'superseded');
    var gen = ++topmostGeneration;
    // Snapshot the identity NOW rather than re-reading it inside the attempt:
    // a row element that is still connected can already be showing a
    // different session, and re-reading would silently retarget the chain at
    // whatever the host put there in the meantime.
    var sessionId = row.getAttribute('data-session-id');
    topmostDiagStart(row, gen);
    startTopmostWatch(row, sessionId, gen);
  }

  // 唯一的一个收工点。观察器、click 监听、排队 timer、模块槽位都在这里清，
  // 所以"这个功能不会留下常驻观察器"这句话是关于【一个函数】的陈述，而不是
  // 关于散在六个出口上的一句承诺。幂等：已经停过的 watch 再停一次什么都不做。
  //
  // 六个调用点，全部在这里收口：注入成功、重试预算用尽、nudge 预算用尽、过了
  // 总时限、行没了或换了身份，以及被新的右击 / 关闭 / dispose 接管。
  //
  // 它【不】动 topmostGeneration。代次是"让一条还在跑的链自己失效"的令牌，
  // 只由真正的接管事件推进（新的右击、菜单关闭、dispose），不由一次正常收工
  // 推进。把两件事混在一起会让"代次这道门还在不在"这个问题再也测不出来。
  function stopTopmostWatch(w) {
    if (!w || w.stopped) return;
    w.stopped = true;
    if (w.obs) {
      var ob = w.obs;
      w.obs = null;                      // clear BEFORE disconnect: a callback
      try { ob.disconnect(); } catch (e) {}   // that re-enters finds nothing
    }
    if (w.onDismiss) {
      try { document.removeEventListener('click', w.onDismiss, true); } catch (e) {}
      w.onDismiss = null;
    }
    if (w.timer) {
      var tid = w.timer;
      w.timer = 0;
      dropTopmostTimer(tid);
      try { window.clearTimeout(tid); } catch (e) {}
    }
    if (topmostWatch === w) topmostWatch = null;
  }

  // 菜单被关掉了。宿主在下一次 click 时收掉自己的弹层，所以那一发 click 就是
  // "这个菜单不会再出现了"的证据 —— 这时候继续挂着观察器只剩内存和开销。
  // 捕获阶段、观察性质：不 preventDefault、不 stopPropagation。
  //
  // 代次在这里也要推进：一条已经被关掉的链，任何还在路上的回调都必须立刻
  // 无效，而这一条与"被新的右击接管"是同一类事件。
  function onTopmostMenuDismissed() {
    if (!topmostWatch) return;
    topmostGeneration++;
    stopTopmostWatch(topmostWatch);
  }

  // 这一次右击的整个探测窗口。两条互相独立的路，各自有界，共用同一个 attempt
  // 和同一套身份/代次门禁：
  //
  //   路 1 · 事件：观察器挂在 document 上，弹层挂载的那个微任务就重试一次。
  //          它【不】消耗重试预算（否则 React 自己挂菜单的那一批变更会把预算
  //          一次烧光），因此有独立的 nudge 上限和总时限。
  //   路 2 · 时间：TOPMOST_RETRY_DELAYS 逐级拉长的重试表。观察器不存在时
  //          （老宿主、被换掉的全局）这条路自己就能把菜单找到。
  //
  // 归属判定一条都没有放松：两条路都只调 tryInjectTopmost，而 tryInjectTopmost
  // 只调 popupForMenu，popupForMenu 里那个 nearestMenuOwner(...) !== menuFiber
  // 一字未改。观察器收到的是"文档变了"这一个事实，它不携带任何归属信息。
  //
  // attempt 里【没有】w.stopped 这一道：定时器回调能被取消，能取消它的就是
  // stopTopmostWatch；那条"已经出队、clearTimeout 够不着"的回调靠的是代次。
  // 两道门各管一段，混在一起就等于把其中一道变成没人测的装饰。
  function startTopmostWatch(row, sessionId, gen) {
    var w = { gen: gen, obs: null, timer: 0, tries: 0, nudges: 0, stopped: false, onDismiss: null, startedAt: Date.now() };
    topmostWatch = w;
    var arm = function (delay) {
      var id = window.setTimeout(function () {
        w.timer = 0;
        dropTopmostTimer(id);
        attempt(false);
      }, delay);
      w.timer = id;
      topmostTimers.push(id);
    };
    var attempt = function (fromNudge) {
      if (disposed) { stopTopmostWatch(w); return; }
      if (gen !== topmostGeneration) { stopTopmostWatch(w); return; }   // superseded chain
      // 总时限。走到这一行说明"这一拍还在跑"，所以它既能救 observer 也能救
      // 定时器链；两条路都在下面同一处出口。
      //
      // 这里【不】写 topmostReason：截止时间到期的含义是"不再往下看了"，而不是
      // "没找到菜单"这个已经由上一次 attempt 如实记下的事实。理由词表一个字都
      // 不动（见 test-topmost-diag 的 W15b），掐断的原因走 earlyStop 那条链级
      // 侧信道，运维看得见是哪一道上限先到。
      if (Date.now() - w.startedAt > TOPMOST_WATCH_DEADLINE) {
        topmostDiagEarlyStop(topmostDiag.chain, 'deadline');
        stopTopmostWatch(w);
        return;
      }
      if (fromNudge) w.nudges++; else w.tries++;
      if (w.nudges > TOPMOST_MAX_NUDGES) { stopTopmostWatch(w); return; }
      // Every attempt re-checks the row. A view switch, a recycled node or an
      // unmount between the right click and the popup all fail closed here
      // instead of injecting into somebody else's menu.
      if (!row.isConnected) {
        topmostDiagRecord('connected'); topmostReason('row-gone'); stopTopmostWatch(w); return;
      }
      if (row.getAttribute('data-session-id') !== sessionId) {
        topmostDiagRecord('retarget'); topmostReason('row-retargeted'); stopTopmostWatch(w); return;  // same node, new session
      }
      if (tryInjectTopmost(row, sessionId)) { stopTopmostWatch(w); return; }
      // The schedule is spent: report the same reason the old 3-try chain
      // reported, so the diagnostic vocabulary does not change with the budget.
      if (w.tries >= TOPMOST_RETRY_DELAYS.length) { topmostDiagCapped(); topmostReason('menu-not-found'); stopTopmostWatch(w); return; }
      // A nudge does NOT re-arm the schedule: the schedule is already running,
      // and re-arming it on every DOM change is how a repainting page would
      // keep this alive forever.
      if (fromNudge) return;
      arm(TOPMOST_RETRY_DELAYS[w.tries]);
    };
    // The observer is an accelerator, never the only path: if the host has no
    // MutationObserver, or the global was replaced, the schedule above is still
    // there on its own. Read off the window object rather than off a bare
    // global, so the page is not silently dependent on an embedding context
    // that may not have it.
    var MO = window.MutationObserver;
    if (typeof MO === 'function') {
      try {
        w.obs = new MO(function () { if (!w.stopped) attempt(true); });
        var target = document.body || document.documentElement;
        if (target) w.obs.observe(target, { childList: true, subtree: true });
        else w.obs = null;
      } catch (e) { w.obs = null; }
    }
    // The dismissal listener's lifetime is the watch's lifetime, and not one
    // beat longer: registered here, removed in stopTopmostWatch. A listener left
    // on the document forever is the same leak as an observer left attached.
    w.onDismiss = onTopmostMenuDismissed;
    try { document.addEventListener('click', w.onDismiss, true); } catch (e) { w.onDismiss = null; }
    arm(TOPMOST_RETRY_DELAYS[0]);
  }

  // The host unmounts the popup on close, which takes our item with it; this
  // only keeps the reported count honest between menus. A HIDDEN item counts
  // as gone: the node can stay connected inside a closing or cached overlay
  // and reported 1 would be a claim the user can see nothing of.
  function reapTopmost() {
    // 诊断快照先清，且必须排在下面的 early return 之前：那一退是关于菜单项
    // 可不可见的，与"快照行还在不在"无关，让它挡住清理会让快照永远挂着。
    topmostDiagReap();
    if (!topmostNode) return;
    if (topmostNode.isConnected && elementIsVisible(topmostNode)) return;
    topmostNode = null;
    topmostState.injected = 0;
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
    // Same classifier the restore uses, so the memory and the restore can never
    // disagree about which button this is. Identity is then checked against the
    // button the restore itself would have picked, which closes the last gap:
    // a session row titled 「更多」 classifies as null above, and a control that
    // merely LOOKS like ours in some other corner of the section is not it.
    var kind = classifyPinnedButton(b);
    if (!kind) return;
    var f = pinnedTruncButton();
    if (!f || f.btn !== b) return;
    rememberPinnedMore(kind === 'expand');
  }

  var handler = function () { scheduleApply(); };
  window.addEventListener('mavis:status-refresh', handler);
  // Capture phase: must observe the user's real click before any host handler
  // can stopPropagation it away. Only isTrusted clicks update the memory.
  document.addEventListener('click', onPinnedMoreClick, true);
  // Observation only -- nothing is prevented, stopped or replaced here.
  document.addEventListener('contextmenu', onContextMenu, true);
  // NOTE: the menu watch's own click listener is NOT registered here. It is
  // registered by startTopmostWatch and removed by stopTopmostWatch, so its
  // lifetime is exactly the watch's lifetime. A document-level listener owned
  // by the module would outlive every watch by the lifetime of the page.

  // ---------------------------------------------------------------------
  // 红色悬停锁顶 · 单会话持续锁顶（2026-10-03 离线实现，本轮未部署）
  // ---------------------------------------------------------------------
  // 授权范围只有两件事：自有 localStorage 里存【一个】会话 id 的锁意图，
  // 以及在宿主可信 order 上做【有界】的后台维持。写宿主仍然只有唯一那一个
  // 三参回调 handlePinSession(id, true, 0)：没有 props 路径、没有 togglePin、
  // 没有备用接口，也绝不 insertBefore 宿主自己的置顶 DOM。
  //
  // 三条必须分开的真相，本文件任何一处都不允许把它们混为一谈：
  //   1. 锁意图   —— localStorage['mmxStatusTopLockV1'] = {version,source,id}
  //   2. 宿主位置 —— 唯一真相是宿主自己那份 pinned order；DOM 从来不是证据
  //   3. Promise  —— 只表示"宿主处理完了"，绝不表示"它成功了"
  //
  // ---- 宿主行内适配器 -------------------------------------------------
  // 2026-10-03 从 app.asar 精确核实（原始 asar 字节偏移 + in-file 偏移）：
  // 六处渲染点、两个 query 消费者，共 8 个 data-session-id。本功能【只支持
  // 有证据的那一处】：
  //
  //   site 3 · tf normal  asar@316713062 / in-file 34690
  //     · 唯一带 data-shortcut-session-target 的一行（asar@316713585）
  //     · 悬停绝对条 asar@316712166 / in-file 33795
  //       class="absolute right-1 top-1/2 -translate-y-1/2 z-[1]"
  //     · 条内的 children 会被 e4(sessionId, children) 在 rename / hint 时
  //       整个替换，所以按钮必须靠自己的属性与代次重新长出来，而不是记住位置
  //     · 条内原本只有：eo（cron 计划任务会话 td span，或 IM 会话 tu span，
  //       不是 pin）、!M&&!ed&&ev（6px 未读点 span，不是两个按钮）、
  //       tw（hidden group-hover:block 里的 B.L/menu，button 带
  //       data-pinned-no-drag 与 data-sidebar-keep-open，w-8 h-8）
  //     · 标题 class asar@316713466 / in-file 35095：
  //       min-w-0 flex-1 transition-all + 三选一的 mr-* 组合，hover 时另有
  //       group-hover:mr-[60px] / group-focus-within:mr-[60px]
  //
  // 明确【不支持】，且不去改造它：
  //   site 1 · project  915.a83017ebab649880.js@313469383，另一套行壳
  //             (rounded-xl p-3 gap-6) + 自带 onMouseEnter/Leave + 独立列表，
  //             本项目显式不支持改造这个独立列表
  //   site 2/4 · rename asar@316706896 / @316822001，行内是 input，没有悬停条
  //   site 5 · i$ pinned asar@316823451，悬停条 right-0.5 + unpin/menu，无 anchor
  //   site 6 · iK recent asar@316838035，悬停条 right-0.5 z-[1] flex w-[60px]，
  //             pin/unpin(g.eL/qQ)，无 anchor
  //   archived   asar@316714271 h30 w60 换掉 pin+archive，不支持注入
  //
  // 5/6 之所以也不支持：标题（也就是要扩 reserve 的那个元素）在没有 anchor 的
  // 两处无法唯一识别。"唯一识别 strip 与 title，认不出就拒绝"是本适配器的
  // 硬规则，不是一个可以绕过的小限制。
  // 宿主行内适配器，2026-10-03 从 app.asar 精确核实。
  // 关键坐标（原始 asar 字节偏移 + in-file 偏移）：
  //   bundle  archon page-18311da465f33e85.js（start 316678371）
  //
  //   site 3 · tf normal   owner@316713062 / in-file 34690
  //     唯一带 data-shortcut-session-target 的一行（@316713585）；
  //     eo 的判选在 @316704521 / in-file 26150（不是 316704647）；
  //     悬停条 @316712166 / in-file 33795
  //       class="absolute right-1 top-1/2 -translate-y-1/2 z-[1]"
  //     条内原本只有 eo（cron 计划任务会话 td span 或 IM 会话 tu span）、
  //     !M&&!ed&&ev（6px 未读点 span）、tw（hidden group-hover:block 里的
  //     B.L/menu button，带 data-pinned-no-drag 与 data-sidebar-keep-open）。
  //     标题 @316713466 / in-file 35095，reserve 为三选一 + hover 变体。
  //
  //   site 5 · i$ pinned   owner@316823448
  //     group relative rounded-lg > main button.mavis-sidebar-item（h-8）
  //     > 唯一标题 div：min-w-0 flex-1 transition-all +
  //       q?'mr-[60px]':F?'mr-8 group-hover:mr-[60px] group-focus-within:mr-[60px]'
  //       :'mr-2 group-hover:mr-[60px] group-focus-within:mr-[60px]'
  //     【没有】data-shortcut-session-target。
  //     悬停条 @316825186：absolute right-0.5 top-1/2 -translate-y-1/2 z-[1]
  //     条内可选 badge span + actions div（q?'flex':'hidden group-hover:flex
  //     group-focus-within:flex' + ' h-[30px] items-center'）
  //     actions 里两个 button：unpin @316825648 与 B.L 包的 more @316826070，
  //     都是 type=button + data-pinned-no-drag，30x30。
  //     条本身【没有宽度】，靠内容撑到 60px。
  //
  //   site 6 · iK recent   owner@316838030（同 group / main button，但 h-[30px]）
  //     标题 reserve 同 site 5（ea?'mr-[60px]':ex? ... :'mr-2 ...'）
  //     悬停条 @316839699：absolute right-0.5 top-1/2 z-[1] flex w-[60px]
  //       -translate-y-1/2 justify-end  ← 定宽 60px
  //     actions div 多一个 justify-end；pin/unpin @316840272 在 !archived 时
  //     才存在，more 约 @316841000 由 B.L 包；两者同为 30x30。
  //
  // 明确【不支持】，不去改造：
  //   site 1 · project  915.a83017ebab649880.js@313469383（另一套行壳
  //             rounded-xl p-3 gap-6 + 自带 hover + 独立列表）
  //   site 2/4 · rename asar@316706896 / @316822001（行内是 input，没有悬停条）
  //   archived  只有 more、没有 pin/unpin 的那一种（上面的按钮数判据会拒绝）
  //
  // 硬规则：strip、mount 容器、标题三者都必须【唯一】命中。命中 0 个或 >1 个
  // 一律不挂按钮。"猜一个容器往里塞"正是这一节要防的事。
  var TOPLOCK_ATTR = 'data-mmx-toplock';
  var TOPLOCK_ID_ATTR = 'data-mmx-toplock-id';
  var TOPLOCK_KEY = 'mmxStatusTopLockV1';
  var TOPLOCK_VERSION = 1;
  // Order matters: irecent's token set is a strict SUPERSET of ipinned's, so it
  // has to be tried first or every recent row is claimed by the looser i$ shape
  // and the fixed-width strip never gets its rule.
  var TOPLOCK_SITES = [
    {
      name: 'irecent', px: 30, stripWidth: 60, titleBy: 'title-class',
      strip: ['absolute', 'right-0.5', 'top-1/2', 'z-[1]', 'flex', 'w-[60px]',
        '-translate-y-1/2', 'justify-end'],
      // The actions class is (ea?'flex':'hidden group-hover:flex
      // group-focus-within:flex') + ' h-[30px] items-center justify-end'. Only
      // the constant tokens are used: the hover tokens disappear entirely in
      // the always-visible branch, and keying on them would reject a normal row.
      mount: ['h-[30px]', 'items-center', 'justify-end'],
      // Fixed-width strip, and archived rows carry only "more" -- one native
      // button. Counting native buttons is structural and language independent.
      minNativeButtons: 2,
    },
    {
      name: 'ipinned', px: 30, stripWidth: 0, titleBy: 'title-class',
      strip: ['absolute', 'right-0.5', 'top-1/2', '-translate-y-1/2', 'z-[1]'],
      mount: ['h-[30px]', 'items-center'],
    },
    {
      // site 7 · mhd 置顶行. 600 行真机取证，形态处处不同：条是 right-1（不是
      // right-0.5），60px 那一格是【悬停才出现】的 group-hover:flex（不是
      // block），两个原生按钮是那一格的【兄弟】、住在条里。
      //
      // 这一条必须排在 tf-normal 之前，理由是结构而不是偏好：两者的条共享
      // 同样那五个 token，所以谁先命中谁说了算，而命中条之后是不回落的
      // fail-closed。mhd 行若先落到 tf-normal 那一条，它会在自己那条
      // group-hover:block 的 mount 上失败并整行拒掉——也就是报出来的症状。
      // 反过来，tf-normal 行的条不带下面这两个 token，这条查不到条，会
      // continue 到 tf-normal，两种行互不干扰。
      //
      // flex items-center 是取证时条上真实存在的 token，登记它们只是为了把
      // 这一条和 tf-normal 分开；少了它们，两条会抢同一组行。
      // px 36 而不是 30：宿主给的那一格是 w-[60px]，36 装得下，30 只是把一格
      // 填了一半，隔着 24px 空白看着像"小了一号"。
      // 宽度装得下，【高度装不下】：那一格是 h-[30px]，按钮是 36，于是它按
      // align-items:center 居中之后上下各溢出 3px。这是出厂事实，不是待修的
      // 缺陷——它之所以无害，是因为格、条、以及我们给格写的那条规则三处都没有
      // overflow-hidden：任何一处加上就会把图钉上下切掉，"按钮大一点"就变成
      // "图标缺一截"。34.6b 把这三处连同这个 3px 一起钉住，所以下一次改
      // 尺寸是一次有意识的决定，而不是一次顺手。
      // stripWidth 0（不是 60）：我们的按钮【住在那一格里】，不是条里第三个
      // 按钮。格本身已经算在条的内容里（60 + 两个 30 = 120），再给条写死
      // 60 + px 只会把宿主那两个 flex 兄弟压扁（它们默认可 shrink，我们的
      // 按钮 flex:none 不缩）——越大的按钮反而让整条右半边更小。条保持内容
      // 自适应，reserve 见 TOPLOCK_CELL_WIDTH。
      name: 'mhd-pinned', px: 36, stripWidth: 0, titleBy: 'title-class',
      strip: ['absolute', 'right-1', 'top-1/2', '-translate-y-1/2', 'z-[1]',
        'flex', 'items-center'],
      mount: ['h-[30px]', 'w-[60px]', 'items-center', 'group-hover:flex',
        'group-focus-within:flex'],
      // NO minNativeButtons on purpose: the host's own two buttons are the
      // mount's siblings inside the strip, so counting them under the mount is
      // a permanent 0 and the row could never match.
    },
    {
      name: 'tf-normal', px: 32, stripWidth: 0, titleBy: 'anchor',
      strip: ['absolute', 'right-1', 'top-1/2', '-translate-y-1/2', 'z-[1]'],
      mount: ['group-hover:block', 'group-focus-within:block'],
    },
  ];
  var TOPLOCK_PROJECT_SHELL = ['rounded-xl', 'p-3', 'gap-6'];
  // 我们的按钮【住在宿主自己定尺寸的那一格】里的 site（按 site 名索引）。
  //
  // 两种落位，承重数字完全不同，绝不能共用一个公式：
  //   兄弟位（irecent / ipinned）：按钮和宿主自己的按钮并排，所以它【自己占
  //     一份宽度】——标题让出 宿主原值 + px，条从 stripWidth 涨到
  //     stripWidth + px。
  //   格里（mhd-pinned）：按钮进的是宿主预留的 w-[60px] 悬停格，格已经算在
  //     条的内容里，宿主标题也已经为它留了 60px。这时候再加一次 px 就是把
  //     标题按【不存在的第二个按钮】再缩一次。所以这里 reserve 取 max(宿主
  //     原值, 格宽) = 格宽本身，条一条 width 规则都不写。
  //
  // 键是 site 名（site 表里没有这个字段，是刻意的：layout key 的算法是既有
  // 契约，不能动），值是宿主那一格的宽度；site 表里 px 必须 <= 这个值。
  var TOPLOCK_CELL_WIDTH = { 'mhd-pinned': 60 };
  // 图标跟着按钮走，按钮多大图标就多大：30px 按钮配 16px 图标（0.53），
  // 36px 就配 20px（0.55）。SVG 有 viewBox，放大不糊。
  var TOPLOCK_GLYPH_RATIO = 0.55;
  var TOPLOCK_TITLE_MARGIN = {
    'mr-2': 8, 'mr-8': 32, 'mr-10': 40, 'mr-[60px]': 60,
  };
  var TOPLOCK_TITLE_HOVER = {
    'group-hover:mr-[60px]': 60, 'group-focus-within:mr-[60px]': 60,
    'group-hover:mr-8': 32, 'group-focus-within:mr-8': 32,
  };
  var TOPLOCK_TITLE_SHAPE = ['min-w-0', 'flex-1', 'transition-all'];
  var TOPLOCK_RESERVE_ATTR = 'data-mmx-toplock-reserve';
  var TOPLOCK_MOUNT_ATTR = 'data-mmx-toplock-mount';
  var TOPLOCK_STRIP_ATTR = 'data-mmx-toplock-strip';
  var TOPLOCK_STYLE_ATTR = 'data-mmx-toplock-style';
  // 后台维持是【有界】的，而且有界不只是一帧一次。每一次真正写宿主都从这
  // 3 次预算里扣一次；扣光就 phase=paused / reason=budget-exhausted，并且
  // 在真人重新点一次可信点击之前【不再自动写】。没有预算就意味着用户或宿主
  // 在跟我们反复抢同一个位置时可以无限对拉 —— 那正是 toast 风暴的成因。
  var TOPLOCK_MAX_MAINT = 3;
  // 宿主返回之后，给"确认"留一趟趟【只读】的窗口。React 的 setState -> 重渲染
  // 不是同步的，宿主实测可以在第 4 趟甚至更晚才把新 order 落到 fiber 上；先前
  // 的 2 趟窗口会把一次成功的提交判成失败，再也不重试，那是误杀。这些趟次
  // 只读不写，所以窗口放大不会变成风暴。
  var TOPLOCK_CONFIRM_TRIES = 12;
  // 可见标签【恒定不变】，pressed 态一律交给 aria-pressed。按 W3C ARIA APG
  // 的 toggle button 语义：aria-pressed 的 true/false 成立的前提就是标签在
  // 两种状态下读起来一样；标签跟着状态变，就不该再用 aria-pressed，两者混搭
  // 会让辅助技术读出"既切换又改名"的四不像。所以：
  //   可见标签     永远同一句；
  //   aria-pressed 表达"是不是已经锁到最顶"；
  //   title / aria-label 承载这一次的具体说明（再点解除 / 阻塞原因 / 暂停原因）。
  // 机器码只留在 api.topLock().reason 里。
  var TOPLOCK_TEXT = '锁顶到最顶';
  var TOPLOCK_REASON_TEXT = {
    'idle': '尚未锁顶任何会话',
    'no-handle-pin-session': '当前宿主版本不支持置顶排序',
    'ambiguous-handle-pin-session': '宿主置顶回调不唯一，已停用',
    'unproven-fiber-tree': '无法确认宿主当前渲染树，已停用',
    'no-fiber-root': '无法确认宿主当前渲染树，已停用',
    'readonly-session': '该会话只读，无法锁顶',
    'readonly-probe-threw': '只读判定失败，已停用',
    'cloud-not-provable': '云端会话暂不支持锁顶',
    'no-session-row': '未找到会话行',
    'cap-mismatch': '会话身份与解析结果不一致，已停用',
    'busy': '上一次操作还没结束',
    'untrusted-click': '只响应真实点击',
    'row-gone': '会话行已变化',
    'button-gone': '按钮已失效',
    'already-first': '该会话已在最顶，无需重复写入',
    'runtime-unavailable': '后台维持状态无法保存，已停用（解除后可重试）',
    'pending-call': '正在等待宿主完成',
    'host-threw': '调用宿主失败',
    'host-rejected': '宿主拒绝了这次置顶',
    'unconfirmed-return': '宿主已返回但无法证明生效，自动维持已停用',
    'confirmed': '已确认位于最顶',
    'locked': '已锁顶，等待后台确认',
    'storage-write-failed': '无法保存锁意图，未对宿主做任何写入',
    'store-init-failed': '无法读取锁意图存储，已停用',
    'corrupt-storage': '锁意图存储已损坏，已忽略',
    'target-not-found': '目标会话当前不在列表中，维持已暂停',
    'view-unstable': '当前视图无法给出可信顺序，维持已暂停',
    'order-missing-id': '可信顺序里没有目标，但该顺序不足以证明删除，维持已暂停',
    'budget-exhausted': '后台维持已用尽次数，请重新点击以锁顶',
    'released': '已解除锁顶',
    'anchor-unproven': '宿主行内位置尚未确认，未挂载按钮',
    'paused': '已暂停',
  };
  var topLockGeneration = 0;
  var topLockState = {
    phase: 'idle', reason: 'idle',
    intentId: '', intentSource: '',
    confirmedId: '', confirmedAtTop: false,
    injected: 0, clicks: 0, calls: 0, noops: 0, blocked: 0,
    releases: 0, cleared: 0, maintCalls: 0, maintBudget: TOPLOCK_MAX_MAINT, maintBlocked: 0,
    // The order array identity the in-flight call was issued against. A resolve
    // is not a commit: confirmation additionally requires a DIFFERENT array,
    // because the host replaces the array on a real commit and reuses the one we
    // read while the update is still in flight.
    pendingOrderRef: null, pendingOrderOwner: '',
    // 接缝计数：能唯一识别 strip 与 title 的行数，和因此拒绝挂按钮的行数。
    // 一行"按钮没出现"必须能被这两者之一解释。
    anchorOk: 0, anchorRefused: 0,
    storageWrites: 0, storageFailures: 0, corrupt: 0,
    generation: 0, busy: false, passes: 0, confirmTries: 0,
    // 存储在首次解析时就读不到（例如隐私模式 / 配额禁用）。这不是一个可以
    // 每趟 apply 重写一遍的瞬时理由：它是这台浏览器上持久的事实，记下来，
    // 在【第一次成功的写入】之前保持不变，免得被 idle 之类覆盖掉。
    storageBroken: false,
    // A WRITE that failed is a different failure from a READ that failed, and
    // it has to survive the next pass: without this, topLockTick's idle branch
    // rewrote the reason to 'idle' one frame after the click and the user was
    // told nothing at all. Cleared only by a successful write.
    storageWriteFailed: false,
  };
  // 能力缓存：每个会话 id 只在第一次看见它时解析一次宿主 fiber 链，之后靠
  // 失效事件（一次点击、一次到最顶调用、dispose、每 N 趟）重算，而不是每帧对
  // 每一行都爬一遍 fiber。容量有上限，行为与 touched 的 64 条剪枝一致。
  var TOPLOCK_CAP_CACHE_MAX = 64;
  var TOPLOCK_CAP_PASSES = 30;
  var topLockCaps = new Map();

  function topLockReasonText(reason) {
    var r = String(reason || '');
    if (TOPLOCK_REASON_TEXT[r]) return TOPLOCK_REASON_TEXT[r];
    if (r.indexOf('source-not-local:') === 0) return '非本地视图，暂不支持锁顶';
    return '当前宿主版本不支持锁顶';
  }

  // Every failure funnels through here. The one thing it must always do is
  // clear the confirmed flag: a paused row whose button still renders solid red
  // is telling the user "it is at the top" when we have just admitted we cannot
  // prove that.
  function topLockPause(reason) {
    topLockState.confirmedAtTop = false;
    topLockState.confirmedId = '';
    topLockState.busy = false;
    topLockReason(reason, 'paused');
    return false;
  }

  // Budget and the "do not auto-retry this target" mark live on OUR window, so
  // a re-injection cannot hand the user a fresh allowance.
  //
  // BOUNDED BY CONSTRUCTION, not by housekeeping. r2 kept a blocked map keyed
  // by every id that had ever been paused: it grew without limit, and it was
  // never cleared, so a trusted release + re-lock still read the stale mark on
  // the next pass and the user could not get maintenance back. r3 keeps ONE
  // owner and ONE reason. "Paused for the current target" is the entire
  // meaning, and it survives re-injection because it lives on the window.
  //
  // A null runtime (an unpersistable window slot) means every one of these is
  // a refusal, never a silent private fallback. A throwaway budget would be
  // refilled from scratch on every re-injection, which is the exact lie this
  // runtime exists to prevent.
  function topLockBudgetReset(id) {
    var r = topLockRuntime();
    if (!r) return false;
    if (r.owner !== id) { r.owner = id; r.budget = TOPLOCK_MAX_MAINT; r.reason = ''; }
    return true;
  }
  function topLockBlockRetry(id, reason) {
    var r = topLockRuntime();
    if (!r) return false;
    r.owner = id;
    r.reason = String(reason || '');
    return true;
  }
  // Only the CURRENT owner's mark counts. A mark left behind by a different id
  // is not a reason to pause this one -- that was the "pause forever" bug.
  function topLockRetryBlocked(id) {
    var r = topLockRuntime();
    if (!r) return null;
    if (r.owner !== id) return null;
    return r.reason || null;
  }
  function topLockSpendBudget() {
    var r = topLockRuntime();
    if (!r) return 0;
    if (r.owner !== topLockState.intentId) { r.owner = topLockState.intentId; r.budget = TOPLOCK_MAX_MAINT; r.reason = ''; }
    if (r.budget > 0) r.budget--;
    topLockState.maintBudget = r.budget;
    return r.budget;
  }

  function topLockReason(reason, phase) {
    topLockState.reason = String(reason || '');
    if (phase) topLockState.phase = String(phase || '');
    // ONE write point for the cross-entry view, so 「到最顶」 can never see a
    // stale intent: every place that moves the intent or the phase ends here.
    topmostLockView.id = topLockState.intentId;
    topmostLockView.phase = topLockState.phase;
  }

  // 会话 id 的形状校验。与 topmostCapability 里的云端判据保持同一条线：裸数字
  // 一律视为云端 id（实测 2026-10-02，447993841729699），本地 id 一律以 mvs_
  // 开头。这里不猜任何一种新形状：认不出就不是本地 id，锁就不成立。
  function topLockValidId(id) {
    if (typeof id !== 'string') return false;
    if (!id) return false;
    if (/^[0-9]+$/.test(id)) return false;
    return /^mvs_[A-Za-z0-9]+$/.test(id);
  }

  // ---- 存储：只写 {version, source, id}，没有排序表、没有标题、没有正文 ----
  function topLockStoreSet(id) {
    var payload = { version: TOPLOCK_VERSION, source: 'local', id: id };
    try {
      window.localStorage.setItem(TOPLOCK_KEY, JSON.stringify(payload));
      topLockState.storageWrites++;
      topLockState.storageBroken = false;
      // r4: a SUCCESSFUL storage operation is what clears the write-failure
      // latch, and there are exactly TWO such places: this one (setItem
      // succeeded) and topLockStoreClear below (removeItem succeeded). r3
      // cleared storageBroken here but not storageWriteFailed, so once a write
      // had failed the tick kept pausing with 'storage-write-failed' forever --
      // including after the user clicked again and the click DID land in
      // storage. That made a recovered browser look permanently broken and
      // stopped the host from ever being pushed down again.
      //
      // What is NOT allowed to clear it: load(), any repaint, any pass of
      // topLockTick, and the two failure branches. The latch is therefore
      // cleared on success and set on failure, and by nothing else.
      topLockState.storageWriteFailed = false;
      return true;
    } catch (e) {
      topLockState.storageFailures++;
      topLockState.storageWriteFailed = true;
      return false;
    }
  }
  function topLockStoreClear() {
    try {
      window.localStorage.removeItem(TOPLOCK_KEY);
      topLockState.storageWrites++;
      topLockState.storageBroken = false;
      topLockState.storageWriteFailed = false;
      return true;
    } catch (e) {
      topLockState.storageFailures++;
      topLockState.storageWriteFailed = true;
      return false;
    }
  }
  // 只读一次解析。存储坏掉时【不猜】：坏掉的意图被忽略并计数，绝不退化成
  // "锁住上一行"或者"把任意一行当锁顶目标"。
  function topLockLoad() {
    var raw;
    try {
      raw = window.localStorage.getItem(TOPLOCK_KEY);
    } catch (e) {
      topLockState.storageBroken = true;
      topLockReason('store-init-failed', 'paused');
      return false;
    }
    if (raw === null || raw === undefined) {
      topLockReason('idle', 'idle');
      return true;
    }
    var parsed = null;
    try { parsed = JSON.parse(String(raw)); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || isArray(parsed)) {
      topLockState.corrupt++;
      topLockReason('corrupt-storage', 'idle');
      return true;
    }
    if (parsed.version !== TOPLOCK_VERSION
      || parsed.source !== 'local'
      || !topLockValidId(parsed.id)) {
      topLockState.corrupt++;
      topLockReason('corrupt-storage', 'idle');
      return true;
    }
    // 首次载入：【只记下意图】。不自动挪位置、不复活会话、不凭空造行。
    // 位置要等后面拿到可信 order 再说。
    topLockState.intentId = parsed.id;
    topLockState.intentSource = 'local';
    // Adopt whatever the PREVIOUS instance left behind. A fresh load must not
    // reset the budget or forget that this target already failed: doing that on
    // every daemon refresh is exactly the "unlimited automatic retry" the
    // promise forbids.
    var rt = topLockRuntime();
    if (!rt) {
      // No persistable runtime: we can still SHOW the intent, but we must not
      // background-maintain it -- a throwaway budget would be handed back in
      // full on every re-injection, which is the promise this runtime exists to
      // keep.
      topLockGeneration++;
      topLockState.generation = topLockGeneration;
      topLockState.maintBudget = 0;
      topLockReason('runtime-unavailable', 'paused');
      return true;
    }
    // ADOPT, never re-arm. A load is not a user gesture, so it must not refill
    // the budget or clear the no-retry mark -- that is what made r2 hand the
    // user three fresh attempts on every daemon refresh.
    if (rt.owner !== parsed.id) { rt.owner = parsed.id; rt.budget = TOPLOCK_MAX_MAINT; }
    topLockState.maintBudget = rt.budget;
    topLockGeneration++;
    topLockState.generation = topLockGeneration;
    var blocked = rt.owner === parsed.id ? (rt.reason || null) : null;
    if (blocked) topLockPause(blocked);
    else topLockReason('locked', 'locked');
    return true;
  }

  function topLockHasAll(className, tokens) {
    var list = String(className || '').split(/\s+/);
    for (var i = 0; i < tokens.length; i++) if (list.indexOf(tokens[i]) < 0) return false;
    return true;
  }

  // Unique hit of one shape. 0 or more than 1 both return null: that is the
  // fail-closed rule, not a stylistic choice.
  function topLockUniqueByShape(scope, tokens, tag) {
    if (!scope || !scope.querySelectorAll) return null;
    var nodes = scope.querySelectorAll(tag || 'div');
    var found = null;
    for (var i = 0; i < nodes.length; i++) {
      if (!topLockHasAll(nodes[i].getAttribute('class'), tokens)) continue;
      if (found) return null;
      found = nodes[i];
    }
    return found;
  }

  // Every element we are about to write into must belong to THIS row. A strip,
  // a mount or a title that resolves to a different session is somebody else's.
  function topLockOwnedBy(el, rowEl) {
    if (!el || !el.closest) return false;
    var owner = el.closest('[data-session-id]');
    return !!owner && owner === rowEl;
  }

  // Native buttons that really belong to this row and are not ours. Counting
  // "every button under the mount" would count our own, and would count another
  // row's buttons when a row is nested (the project shell nests rows).
  function topLockNativeButtons(mount, rowEl) {
    var all = mount.querySelectorAll('button');
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute(TOPLOCK_ATTR)) continue;
      if (!topLockOwnedBy(all[i], rowEl)) continue;
      n++;
    }
    return n;
  }

  // The title, and the reserve it already carries.
  //
  // Two corrections over the previous version:
  //  1. For the tf-normal site the data-shortcut-session-target element is the
  //     row's MAIN BUTTON; the mr-* tokens live on the title div INSIDE it.
  //     Measuring the button itself was measuring the wrong element.
  //  2. Exactly one resting margin token and at most one hover / one focus
  //     token. "Last one wins" is how a row whose margin we cannot read ends up
  //     silently carrying somebody else's reserve.
  function topLockReserveOf(rowEl, site) {
    var scope = rowEl;
    var host = null;
    if (site.titleBy === 'anchor') {
      host = rowEl.querySelector('[data-shortcut-session-target]');
      if (!host || !topLockOwnedBy(host, rowEl)) return null;
      scope = host;
    }
    var titleEl = topLockUniqueByShape(scope, TOPLOCK_TITLE_SHAPE, 'div');
    if (!titleEl || !topLockOwnedBy(titleEl, rowEl)) return null;
    var list = String(titleEl.getAttribute('class') || '').split(/\s+/);
    var rest = null;
    var hover = null;
    var focus = null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (TOPLOCK_TITLE_MARGIN[t] !== undefined) {
        if (rest !== null) return null;               // two candidates -> refuse
        rest = TOPLOCK_TITLE_MARGIN[t];
        continue;
      }
      if (TOPLOCK_TITLE_HOVER[t] === undefined) continue;
      if (t.indexOf('focus-within') >= 0) {
        if (focus !== null) return null;
        focus = TOPLOCK_TITLE_HOVER[t];
      } else {
        if (hover !== null) return null;
        hover = TOPLOCK_TITLE_HOVER[t];
      }
    }
    if (rest === null) return null;
    return { titleEl: titleEl, rest: rest, hover: hover, focus: focus };
  }

  // Strip / mount / title, resolved once, all proved to belong to this row.
  function topLockResolveRow(rowEl) {
    if (!rowEl || !rowEl.querySelectorAll) return null;
    if (topLockHasAll(rowEl.getAttribute('class'), TOPLOCK_PROJECT_SHELL)) return null;
    var parent = rowEl.parentElement;
    if (parent && topLockHasAll(parent.getAttribute('class'), TOPLOCK_PROJECT_SHELL)) return null;
    for (var si = 0; si < TOPLOCK_SITES.length; si++) {
      var site = TOPLOCK_SITES[si];
      var strip = topLockUniqueByShape(rowEl, site.strip, 'div');
      if (!strip) continue;
      if (!topLockOwnedBy(strip, rowEl)) return null;
      // The strip has now pinned down which row shell this is. From here on any
      // failure is a REFUSAL, never "try a looser shape next": irecent is a
      // superset of ipinned, so a fall-through would let an archived irecent row
      // be claimed by the ipinned shape, which does not count native buttons.
      var mount = topLockUniqueByShape(strip, site.mount, 'div');
      if (!mount || !topLockOwnedBy(mount, rowEl)) return null;
      var res = topLockReserveOf(rowEl, site);
      if (!res) return null;
      if (site.minNativeButtons
        && topLockNativeButtons(mount, rowEl) < site.minNativeButtons) return null;
      // Is our own button going to be laid out in a row? tf-normal's mount is
      // display:block, so a bare sibling would stack UNDER the host's own menu
      // button instead of sitting beside it.
      var alwaysVisible = !topLockHasAll(mount.getAttribute('class'),
        ['group-hover:flex']) && !topLockHasAll(mount.getAttribute('class'),
        ['group-hover:block']);
      return {
        site: site, strip: strip, mount: mount,
        title: res.titleEl, rest: res.rest, hover: res.hover, focus: res.focus,
        alwaysVisible: alwaysVisible,
      };
    }
    return null;
  }

  // ---- our own stylesheet -------------------------------------------------
  //
  // One node, rebuilt from a registry that lives on OUR window, and written
  // only when the text actually changes. The previous version appended a rule
  // per row per apply pass with a GENERIC selector, which was wrong twice over:
  // the sheet grew without bound, and because every row matched the same
  // selector with equal specificity, the last row's margin silently won for all
  // of them.
  //
  // Now every rule is keyed by the exact layout it was computed for, carried in
  // the marker's own VALUE, so two rows with different reserves cannot collide
  // and two rows with the same reserve share one rule.
  var TOPLOCK_BASE_CSS =
    '.mmx-toplock-btn{appearance:none;-webkit-appearance:none;display:inline-flex;'
    + 'align-items:center;justify-content:center;box-sizing:border-box;flex:none;'
    + 'background:transparent;border:0;padding:0;margin:0;cursor:pointer;'
    + 'pointer-events:auto;color:var(--red_400,#ef4449)!important}'
    + '.mmx-toplock-btn.is-blocked{color:var(--gray_400,#9ca3af)!important;cursor:not-allowed}'
    + '.mmx-toplock-btn:focus-visible{outline:2px solid var(--red_400,#ef4449);outline-offset:1px}'
    + '.mmx-toplock-glyph{width:16px;height:16px;display:block;pointer-events:none;'
    + 'flex:none;color:inherit}'
    + '.mmx-toplock-glyph path{fill:none;stroke:currentColor;stroke-width:1.5;'
    + 'stroke-linecap:round;stroke-linejoin:round}'
    + '.mmx-toplock-glyph.is-solid path{fill:currentColor;stroke:none}';

  function topLockStyleNode() {
    var style = document.querySelector('[' + TOPLOCK_STYLE_ATTR + ']');
    if (style) return style;
    style = document.createElement('style');
    style.setAttribute(TOPLOCK_STYLE_ATTR, '1');
    var head = document.head || document.body;
    if (!head) return null;
    head.appendChild(style);
    return style;
  }

  // Emit the layout rules for ONE key, once, ever. Returns the key so the
  // caller can stamp it onto the title / strip / mount.
  function topLockEnsureLayoutKey(place) {
    var key = 'm' + place.rest
      + 'h' + (place.hover === null || place.hover === undefined ? 'x' : place.hover)
      + 'f' + (place.focus === null || place.focus === undefined ? 'x' : place.focus)
      + 'p' + place.site.px
      + 'a' + (place.alwaysVisible ? 1 : 0)
      + 'w' + place.site.stripWidth;
    var r = topLockCssRegistry();
    if (!r.rules[key]) {
      var q = '[' + TOPLOCK_RESERVE_ATTR + '="' + key + '"]';
      var sq = '[' + TOPLOCK_STRIP_ATTR + '="' + key + '"]';
      var mq = '[' + TOPLOCK_MOUNT_ATTR + '="' + key + '"]';
      var rule = TOPLOCK_BASE_CSS;
      var px = place.site.px;
      // 0 = 我们的按钮是宿主按钮的【兄弟】，自己占一份宽度；非 0 = 它住在
      // 宿主定尺寸的那一格里，格已经算在条里、也已经被标题预留了。
      var cell = TOPLOCK_CELL_WIDTH[place.site.name] || 0;
      // 标题该让出多少：兄弟位是 宿主原值 + px；格里是 max(宿主原值, 格宽)
      // ——格宽就是宿主自己为这一格留的量，绝不能比它少，也绝不能再多加一个
      // px（那一格里并没有第二个按钮）。
      var need = function (hostValue) {
        return cell ? Math.max(hostValue, cell) : hostValue + px;
      };
      // AT REST the host's own value stands: our button is inside a container
      // that is display:none until hover, so it occupies no room and must not
      // shrink the title for nothing. Only the always-visible actions branch
      // needs room at rest.
      if (place.alwaysVisible) {
        rule += q + '{margin-right:' + need(place.rest) + 'px}';
        if (place.site.stripWidth && !cell) {
          rule += sq + '{width:' + (place.site.stripWidth + px) + 'px}';
        }
      }
      if (place.hover !== null && place.hover !== undefined) {
        rule += '.group:hover ' + q + '{margin-right:' + need(place.hover) + 'px}';
      }
      if (place.focus !== null && place.focus !== undefined) {
        rule += '.group:focus-within ' + q + '{margin-right:' + need(place.focus) + 'px}';
      }
      if (!place.alwaysVisible && place.site.stripWidth && !cell) {
        rule += '.group:hover ' + sq + '{width:' + (place.site.stripWidth + px) + 'px}';
        rule += '.group:focus-within ' + sq + '{width:' + (place.site.stripWidth + px) + 'px}';
      }
      // tf-normal's mount is display:block; our sibling would stack under the
      // host's own menu button. Laying the mount out as a row is a layout-only
      // change on OUR marked element and leaves both buttons intact.
      //
      // 格里位（mhd）多两件事，都只写在我们自己那一条规则上，宿主的 class 一
      // 个字都不动：按钮在格子里【居中】（贴着格子左边会和右侧的 12px 空白
      // 看着没对齐，而格宽正是标题让出的宽度，居中才配得上那个数），以及图
      // 标跟着按钮放大（按钮从 30 到 36，图标还停在 16 就像"同一个图标换了个
      // 稍大的盒子"）。选择器是 mount 的后代，按钮就在 mount 里。
      rule += mq + '{display:flex;align-items:center'
        + (cell ? ';justify-content:center' : '') + '}';
      if (cell) {
        var gpx = Math.round(px * TOPLOCK_GLYPH_RATIO);
        rule += mq + ' .mmx-toplock-glyph{width:' + gpx + 'px;height:' + gpx + 'px}';
      }
      r.rules[key] = rule;
      topLockWriteCss();
    }
    return key;
  }

  function topLockWriteCss() {
    var style = topLockStyleNode();
    if (!style) return;
    var text = '';
    var r = topLockCssRegistry();
    for (var k in r.rules) {
      if (!Object.prototype.hasOwnProperty.call(r.rules, k)) continue;
      text += r.rules[k];
    }
    // The whole point: no write unless the text really is different.
    if (String(style.textContent || '') === text) return;
    style.textContent = text;
  }

  function topLockSetAttr(el, name, value) {
    if (!el) return false;
    var cur = el.getAttribute(name);
    if (cur === value) return false;
    el.setAttribute(name, value);
    return true;
  }

  // Stamp / refresh our own marks. The host's class and inline style are never
  // written, and a mark is only re-stamped when its key actually changed --
  // that is what keeps a runtime class change visible without rewriting the
  // stylesheet on every pass.
  function topLockApplyReserve(place) {
    var key = topLockEnsureLayoutKey(place);
    var wrote = false;
    wrote = topLockSetAttr(place.title, TOPLOCK_RESERVE_ATTR, key) || wrote;
    wrote = topLockSetAttr(place.mount, TOPLOCK_MOUNT_ATTR, key) || wrote;
    if (place.site.stripWidth) {
      wrote = topLockSetAttr(place.strip, TOPLOCK_STRIP_ATTR, key) || wrote;
    }
    topLockWriteCss();
    return wrote;
  }

  // Take every trace of ours out of ONE row. Scoped to that row on purpose: a
  // row going unknown must not strip its neighbour.
  function topLockStripRow(rowEl) {
    if (!rowEl || !rowEl.querySelectorAll) return 0;
    var n = 0;
    var btns = rowEl.querySelectorAll('[' + TOPLOCK_ATTR + ']');
    for (var i = 0; i < btns.length; i++) { try { btns[i].remove(); n++; } catch (e) {} }
    var res = rowEl.querySelectorAll('[' + TOPLOCK_RESERVE_ATTR + ']');
    for (var r = 0; r < res.length; r++) { try { res[r].removeAttribute(TOPLOCK_RESERVE_ATTR); } catch (e) {} }
    var str = rowEl.querySelectorAll('[' + TOPLOCK_STRIP_ATTR + ']');
    for (var w = 0; w < str.length; w++) { try { str[w].removeAttribute(TOPLOCK_STRIP_ATTR); } catch (e) {} }
    var mnt = rowEl.querySelectorAll('[' + TOPLOCK_MOUNT_ATTR + ']');
    for (var m = 0; m < mnt.length; m++) { try { mnt[m].removeAttribute(TOPLOCK_MOUNT_ATTR); } catch (e) {} }
    return n;
  }

  // ---- 能力缓存（懒解析 + 失效，不做每帧全量爬 fiber） ----
  function topLockInvalidateCaps() { topLockCaps.clear(); }
  function topLockCapOf(rowEl, id) {
    var hit = topLockCaps.get(id);
    if (hit && topLockState.passes - hit.at < TOPLOCK_CAP_PASSES) return hit;
    var cap = topmostCapability(rowEl);
    var rec = {
      available: cap.available === true, reason: cap.reason || '',
      at: topLockState.passes, orderLength: -1, hasOrder: false,
    };
    if (rec.available && cap.order && isArray(cap.order)) {
      rec.orderLength = cap.order.length;
      rec.hasOrder = true;
    }
    topLockCaps.set(id, rec);
    if (topLockCaps.size > TOPLOCK_CAP_CACHE_MAX) {
      var drop = [];
      topLockCaps.forEach(function (v, k) { drop.push(k); });
      for (var d = 0; d < drop.length - TOPLOCK_CAP_CACHE_MAX; d++) topLockCaps.delete(drop[d]);
    }
    return rec;
  }

  // ---- 按钮规格：轮廓红 / 实心红 / 文案 / 无障碍，全部从同一处派生 ----
  //
  // 未锁 = 轮廓红且 aria-pressed=false；只有真正被【新鲜的宿主 order】确认在
  // 首位的那一个才是实心红。pending / paused / 能力不足各有自己的中文文案，
  // 互不混用，绝不把机器码写进界面。
  //
  // 关于"禁用"：这里【不使用原生 disabled 属性】，也不用 aria-disabled 之外
  // 的任何拦截。原因有二，都是硬的：
  //   1. 原生 disabled 的按钮"不能被按下也不能被聚焦"（MDN button 参考），
  //      一旦用它，当前锁的解除入口会在能力中途失效时【连 Tab 都到不了】。
  //   2. aria-pressed 才描述"按下态"，aria-disabled 只描述"禁用态"；两者分开
  //      写，屏幕阅读器才不会把"已锁顶"读成"不可用"。
  // 真正的拦截在 click 处理里做，所以能力不足的按钮仍可被聚焦、可读出原因、
  // 并且在【它就是当前锁目标】时依然是唯一的解除入口。
  function topLockButtonSpec(id, capRec, phase, reason) {
    var isTarget = !!topLockState.intentId && id === topLockState.intentId;
    var pressed = isTarget && topLockState.confirmedAtTop
      && topLockState.confirmedId === id;
    var blocked = !capRec.available && !isTarget;
    var desc, ariaDisabled = null;
    if (pressed) {
      desc = '已在最顶（再点一次解除）';
    } else if (isTarget && (phase === 'paused' || phase === 'awaiting')) {
      // 一个手势一个含义：点当前目标【永远】是解除，哪怕它正暂停着。暂停后的
      // 重试路径因此是"解除 -> 再点一次锁顶"，两步各自清楚，不猜。
      desc = '维持已暂停：' + topLockReasonText(reason) + '（点按解除）';
    } else if (isTarget && phase === 'pending') {
      desc = topLockReasonText('pending-call');
    } else if (blocked) {
      desc = '当前不可用：' + topLockReasonText(capRec.reason);
      ariaDisabled = 'true';
    } else {
      desc = '把该会话置顶到置顶区最顶';
    }
    return {
      // The accessible name NEVER changes, whatever the state. Per the ARIA APG
      // toggle-button pattern, aria-pressed is only meaningful while the name
      // stays put; the state goes into the DESCRIPTION instead.
      ariaLabel: TOPLOCK_TEXT,
      title: desc,
      ariaDescription: desc,
      ariaDisabled: ariaDisabled,
      pressed: pressed, actionable: !blocked, isTarget: isTarget,
    };
  }

  // The glyph is real SVG built through the namespace API -- createElementNS plus
  // setAttribute on a <path>. No innerHTML anywhere in this module: one stray
  // interpolation would be both an injection surface and a parser mismatch
  // between us and the host.
  //
  // Outline when not locked, solid when the host's fresh order has actually
  // confirmed the row at index 0. Nothing else gets the solid form.
  var TOPLOCK_SVG_NS = 'http://www.w3.org/2000/svg';
  function topLockBuildGlyph() {
    var svg = document.createElementNS(TOPLOCK_SVG_NS, 'svg');
    svg.setAttribute('class', 'mmx-toplock-glyph');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(TOPLOCK_SVG_NS, 'path');
    // An upward pin: a shaft with a head, and a bar underneath to sit on.
    path.setAttribute('d', 'M8 1.6l3 3.2h-2v4.1h2.6v1.5H4.4V8.9H7V4.8H5z');
    svg.appendChild(path);
    return svg;
  }

  function topLockBuildButton(id, spec, px) {
    var btn = document.createElement('button');
    // type=button：默认的 submit 在有 form owner 时会提交表单，这里显式钉死。
    btn.setAttribute('type', 'button');
    // 宿主自己的悬停按钮就带这两个属性（asar@316712166 内的 B.L button）：
    // data-pinned-no-drag 让拖拽排序跳过它，data-sidebar-keep-open 让点击
    // 不折叠侧栏。少任何一个，我们这个"第三方"按钮在宿主眼里就是个异常。
    btn.setAttribute('data-pinned-no-drag', 'true');
    btn.setAttribute('data-sidebar-keep-open', 'true');
    btn.setAttribute('data-mmx-toplock-px', String(px));
    btn.setAttribute(TOPLOCK_ATTR, '1');
    btn.setAttribute(TOPLOCK_ID_ATTR, id);
    // The glyph is appended ONCE and then never rebuilt. Rebuilding it every
    // pass would be a childList mutation inside the observed subtree, and the
    // observer would schedule another pass -- a loop that never converges.
    btn.__glyph = topLockBuildGlyph();
    btn.appendChild(btn.__glyph);
    btn.addEventListener('click', function (ev) { onTopLockActivate(ev, btn, id); });
    // pointerdown is where the host's drag gesture starts. Stopping it there
    // keeps a drag from swallowing the press. preventDefault is deliberately
    // NOT called: it would suppress the focus the button needs for keyboard use.
    btn.addEventListener('pointerdown', function (ev) {
      if (ev && ev.stopPropagation) { try { ev.stopPropagation(); } catch (e) {} }
    });
    return btn;
  }

  // Every write below is a no-op unless the value really changed. This is the
  // difference between "we repaint when something happens" and "we repaint
  // forever": the observer sees zero mutations on a steady-state pass.
  function topLockApplySpec(btn, spec) {
    if (!btn) return 0;
    var wrote = 0;
    // Tailwind arbitrary values need a UNIT: h-[30] is not a height, h-[30px] is.
    var px = btn.getAttribute('data-mmx-toplock-px') || '32';
    var cls = 'mmx-toplock-btn flex items-center justify-center h-[' + px + 'px] w-[' + px + 'px]'
      + (spec.pressed ? ' is-locked' : ' is-idle')
      + (spec.actionable ? '' : ' is-blocked');
    if (btn.className !== cls) { btn.className = cls; wrote++; }
    wrote += topLockSetAttr(btn, 'aria-label', spec.ariaLabel) ? 1 : 0;
    wrote += topLockSetAttr(btn, 'title', spec.title) ? 1 : 0;
    wrote += topLockSetAttr(btn, 'aria-description', spec.ariaDescription) ? 1 : 0;
    wrote += topLockSetAttr(btn, 'aria-pressed', spec.pressed ? 'true' : 'false') ? 1 : 0;
    if (spec.ariaDisabled) {
      wrote += topLockSetAttr(btn, 'aria-disabled', spec.ariaDisabled) ? 1 : 0;
    } else if (btn.getAttribute('aria-disabled') !== null) {
      btn.removeAttribute('aria-disabled'); wrote++;
    }
    var glyph = btn.__glyph;
    if (glyph) {
      var gcls = 'mmx-toplock-glyph' + (spec.pressed ? ' is-solid' : '');
      if (glyph.getAttribute('class') !== gcls) { glyph.setAttribute('class', gcls); wrote++; }
    }
    return wrote;
  }

  // 只读按钮的规范来源：锁意图 + 缓存的能力判定。不在这里爬 fiber，所以每趟
  // apply 扫过几百行也只是一次 Map 查表。
  function topLockSpecFor(id) {
    var capRec = topLockCaps.get(id);
    if (!capRec) capRec = { available: false, reason: 'no-session-row', at: -1 };
    return topLockButtonSpec(id, capRec, topLockState.phase, topLockState.reason);
  }

  // 每趟 apply 对每一行走一次。幂等：同一个 id 复用同一个节点并原地更新；
  // 虚拟化把节点换给别的会话时，旧按钮按自己记下的 id 被清掉而不是跟着走。
  function topLockRow(rowEl, id) {
    var place = topLockResolveRow(rowEl);
    if (!place) {
      // The row turned into something we have not proven (a rename input, the
      // project shell, an archived variant). Anything WE left in it goes now --
      // scoped to this row, so a neighbour keeps its own button and reserve.
      topLockStripRow(rowEl);
      topLockState.anchorRefused++;
      return;
    }
    var anchor = place.mount;
    topLockApplyReserve(place);
    topLockState.anchorOk++;
    // 首次看见这个 id 时解析一次宿主能力，之后靠缓存。每一行每次 apply 都调用
    // 这里，但只有缓存未命中时才真的爬 fiber。
    topLockCapOf(rowEl, id);
    var existing = anchor.querySelector('[' + TOPLOCK_ATTR + ']');
    if (existing && existing.getAttribute(TOPLOCK_ID_ATTR) !== id) {
      try { existing.remove(); } catch (e) {}
      existing = null;
    }
    var spec = topLockSpecFor(id);
    if (existing) { topLockApplySpec(existing, spec); topLockState.injected++; return; }
    var btn = topLockBuildButton(id, spec, place.site.px);
    topLockApplySpec(btn, spec);
    anchor.appendChild(btn);          // 只加不换
    topLockState.injected++;
  }

  // 清掉挂在已消失行 / 已改主语行上的按钮。虚拟化下这是常态，不是异常。
  // topLockState.injected 是纯派生计数：节点一被摘掉，下一趟就重算；dispose()
  // 之后整个实例连同 api 一起消失，所以那里要保证的是"节点一个不剩"，而不是
  // 把这个计数清零（INV-11 要求的是前者）。
  function topLockPrune() {
    var nodes = document.querySelectorAll('[' + TOPLOCK_ATTR + ']');
    var live = 0;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var row = n.closest ? n.closest('[data-session-id]') : null;
      var ok = row && row.isConnected
        && row.getAttribute('data-session-id') === n.getAttribute(TOPLOCK_ID_ATTR);
      if (ok) { live++; continue; }
      try { n.remove(); } catch (e) {}
    }
    topLockState.injected = live;
    // 虚拟化把行抽走之后，它头上那颗 reserve 标记也必须跟着摘，否则一个已经
    // 不存在的行会永远占着标题的右边距。
    var marks = document.querySelectorAll('[' + TOPLOCK_RESERVE_ATTR + ']');
    for (var m = 0; m < marks.length; m++) {
      var holder = marks[m].closest ? marks[m].closest('[data-session-id]') : null;
      if (holder && holder.isConnected) continue;
      try { marks[m].removeAttribute(TOPLOCK_RESERVE_ATTR); } catch (e) {}
    }
    var strips = document.querySelectorAll('[' + TOPLOCK_STRIP_ATTR + ']');
    for (var w = 0; w < strips.length; w++) {
      var sHolder = strips[w].closest ? strips[w].closest('[data-session-id]') : null;
      if (sHolder && sHolder.isConnected) continue;
      try { strips[w].removeAttribute(TOPLOCK_STRIP_ATTR); } catch (e) {}
    }
    var mounts = document.querySelectorAll('[' + TOPLOCK_MOUNT_ATTR + ']');
    for (var mo = 0; mo < mounts.length; mo++) {
      var mHolder = mounts[mo].closest ? mounts[mo].closest('[data-session-id]') : null;
      if (mHolder && mHolder.isConnected) continue;
      try { mounts[mo].removeAttribute(TOPLOCK_MOUNT_ATTR); } catch (e) {}
    }
  }

  // 找到锁意图对应的那一行，并且证明它就是那一行。
  function topLockIntentRow() {
    var id = topLockState.intentId;
    if (!id) return null;
    var row = null;
    try { row = document.querySelector('[data-session-id="' + id + '"]'); } catch (e) { row = null; }
    if (!row) return null;
    if (!row.isConnected) return null;
    if (row.getAttribute('data-session-id') !== id) return null;
    return row;
  }

  // 从宿主自己那份 order 里读"现在谁在最顶"。只有 topmostCapability 在
  // fiber 树、hook 形状、source 与只读探针【全部证明通过】之后才会带上
  // order，所以拿到它就等于拿到了宿主当前渲染树的证明。
  function topLockHostView(rowEl) {
    var cap = topmostCapability(rowEl);
    if (!cap.available || !cap.order || !isArray(cap.order)) return null;
    // probe is the host OWN isReadOnlySessionById, taken from the same
    // unique seven-dep hook the capability gate just proved. Handing it out is
    // not a new host API and it does not relax "current and unique": the
    // witness path below calls it with the TARGET id, which is the whole point
    // (see topLockTrustedWitness).
    return { id: cap.id, source: cap.source, order: cap.order, fn: cap.fn, probe: cap.probe };
  }

  // 可信地判定"目标在宿主 order 里还在不在"。
  //   order 拿不到          -> view-unstable（视图切换/过滤/虚拟化），不清锁
  //   order 为空            -> order-missing-id，空数组证明不了任何删除，不清锁
  //   order 非空且不含目标  -> 这是正面证据：宿主自己加载好的列表里没有它
  //   order 非空且含目标    -> 目标还在，继续维持
  // 绝不用"连续两趟都没看见"来推断删除：那是猜，不是证据。
  // 'present'  the target ref is in the host's own current order.
  // 'empty'    a proven order that carries no refs at all.
  // 'absent'   a non-empty proven order that does not list the target.
  // 'unknown'  no proven order could be obtained at all.
  //
  // 'absent' is NOT proof that the host finished loading and NOT proof that the
  // session was unpinned -- a mid-load snapshot looks identical. So it never
  // clears a lock and never triggers a background write; see topLockTick.
  function topLockPresence(view) {
    if (!view || !view.order) return 'unknown';
    if (!view.order.length) return 'empty';
    for (var i = 0; i < view.order.length; i++) {
      var it = view.order[i];
      if (it && it.type === 'session' && String(it.id) === topLockState.intentId) return 'present';
    }
    return 'absent';
  }

  // Confirmation needs THREE independent things, not one:
  //   1. the row really is at index 0 in a PROVEN local order;
  //   2. the order is not the very array the in-flight call was issued against
  //      -- the host replaces the array on a real commit, so a same-identity
  //      array coming back means we are still staring at the pre-update
  //      snapshot;
  //   3. no unconfirmed call is outstanding for this target.
  // A resolve on its own proves nothing, which is the whole reason this
  // function exists.
  // The best proven view we can get, whether or not the intent row is on
  // screen. "Proven" means it came out of topmostCapability, so the fiber tree,
  // the unique seven-dep hook, the local source and the read-only probe have all
  // already been established.
  // The target's row is not on screen (virtualised, filtered, or a different
  // view). We may still read a trusted order and the trusted hook FROM ANOTHER
  // connected local row -- but that row is NOT the target, so its own
  // capability says nothing about whether the TARGET can be written.
  //
  // r2 borrowed the witness's writability wholesale: it probed
  // isReadOnlySessionById(witnessId) and then wrote intentId. A read-only
  // target therefore inherited a writable witness's verdict. r3 asks the host
  // about the TARGET id, through the SAME single proven hook, and refuses the
  // whole path if the answer is read-only or cannot be obtained.
  function topLockTrustedWitness() {
    var sec = document.querySelector('[data-pinned-section]');
    var row = (sec && sec.querySelector('[data-session-id]'))
      || document.querySelector('[data-session-id]');
    if (!row) return null;
    var view = topLockHostView(row);
    if (!view) return null;
    // The intent row itself: the capability already answered for this id.
    if (view.id === topLockState.intentId) return view;
    if (typeof view.probe !== 'function') {
      view.targetReason = 'view-unstable';
      return view;
    }
    var writable;
    try {
      writable = !view.probe(topLockState.intentId, view.source);
    } catch (e) {
      writable = false;
      view.targetReason = 'readonly-probe-threw';
      return view;
    }
    if (!writable) { view.targetReason = 'readonly-session'; return view; }
    return view;
  }

  // ONE reason for every unproven presence case. The point of collapsing them is
  // that none of them may be read as a claim that the host had finished loading:
  // an empty order and a non-empty order that merely lacks the ref are the same
  // situation as far as we are concerned, because we cannot tell a mid-load
  // snapshot from a finished one.
  function topLockPauseReasonFor(presence) {
    return presence === 'unknown' ? 'view-unstable' : 'order-missing-id';
  }

  function topLockConfirm(view) {
    if (topLockState.pendingOrderOwner === topLockState.intentId
      && topLockState.pendingOrderRef
      && view && view.order === topLockState.pendingOrderRef) {
      topLockState.confirmedAtTop = false;
      topLockState.confirmedId = '';
      return false;
    }
    var first = view && view.order && view.order.length ? view.order[0] : null;
    var atTop = !!(first && first.type === 'session'
      && String(first.id) === topLockState.intentId
      && view.source === 'local');
    if (atTop) {
      topLockState.confirmedId = topLockState.intentId;
      topLockState.confirmedAtTop = true;
      topLockState.pendingOrderRef = null;
      topLockState.pendingOrderOwner = '';
      topLockReason('confirmed', 'confirmed');
      return true;
    }
    topLockState.confirmedAtTop = false;
    topLockState.confirmedId = '';
    return false;
  }

  function topLockFinish(gen, ticket, failed) {
    topLockState.busy = false;
    // Only ever releases ITS OWN ticket. A superseded call settling late must
    // not free the gate a newer call is holding.
    hostCallRelease(ticket);
    // 老代次的回执绝不允许污染新意图的状态：只释放闸，其余什么都不改。
    if (gen !== topLockGeneration) return;
    topLockState.confirmTries = 0;
    if (failed) {
      topLockBlockRetry(topLockState.intentId, 'host-rejected');
      topLockPause('host-rejected');
      return;
    }
    // 'awaiting' 不是 'paused'：这一趟只是还没有拿到证据。下一趟 topLockTick
    // 会用【新鲜的】order 去证明；证不出来（宿主回滚了 / 静默拒绝了）才会转成
    // paused 并永久停掉自动重试。
    topLockReason('unconfirmed-return', 'awaiting');
    topLockInvalidateCaps();
  }

  // 唯一的写宿主调用点。id、fn、顺序全部来自调用前【这一次】的重新解析。
  function topLockCall(gen, rowEl, id, fn, orderRef) {
    var ticket = hostCallTake();
    if (!ticket) { topLockState.blocked++; return false; }
    topLockState.busy = true;
    topLockState.ticket = ticket;
    // What the call was issued against. A resolve is not a commit: the same
    // array coming back means we are still looking at the pre-update snapshot.
    topLockState.pendingOrderRef = orderRef || null;
    topLockState.pendingOrderOwner = id;
    topLockState.calls++;
    topLockState.maintCalls++;
    var ret;
    try {
      ret = fn(id, true, 0);        // 三参，绝不省略 0（F10）
    } catch (e) {
      topLockState.busy = false;
      topLockState.ticket = null;
      hostCallRelease(ticket);
      topLockState.blocked++;
      if (gen === topLockGeneration) {
        topLockBlockRetry(id, 'host-threw');
        topLockPause('host-threw');
      }
      return false;
    }
    Promise.resolve(ret).then(function () {
      topLockFinish(gen, ticket, false);
    }, function () {
      topLockFinish(gen, ticket, true);
    });
    return true;
  }

  // 用户点击当前锁目标 = 解除。解除【不调用宿主】：不 unpin、不恢复旧位置。
  // 解除只有一次本地写入，所以它不可能与实际状态分裂：写成功则意图在存储和
  // 内存里同时消失，写失败则两者都保持原样并给出可见原因。
  // 记下"用户要锁哪一行"，并重置代次与预算。不调用宿主。
  function topLockPendingIntent(sessionId) {
    if (!topLockStoreSet(sessionId)) {
      topLockReason('storage-write-failed', 'paused');
      return false;
    }
    topLockGeneration++;
    topLockState.generation = topLockGeneration;
    topLockState.intentId = sessionId;
    topLockState.intentSource = 'local';
    topLockState.confirmedId = '';
    topLockState.confirmedAtTop = false;
    // 新的意图 = 新的预算。旧代次欠下的维持次数不跟着过来。
    topLockState.maintBudget = TOPLOCK_MAX_MAINT;
    return true;
  }

  // Releasing is a LOCAL operation and never calls the host. That is what makes
  // "intent and reality cannot split" achievable here: either the one local
  // write succeeds and both sides drop the lock, or it fails and BOTH keep it.
  //
  // It is deliberately NOT gated on the inflight gate. A release is the user's
  // way out; making them wait for a call they cannot cancel would be worse than
  // letting the call finish into an empty intent. What we do NOT do is pretend
  // the call was undone: the generation bump below makes its late settle inert,
  // and the ticket it holds is released only by its own settle.
  function topLockRelease() {
    topLockState.releases++;
    if (!topLockStoreClear()) {
      return topLockPause('storage-write-failed');
    }
    topLockState.intentId = '';
    topLockState.intentSource = '';
    topLockState.confirmedId = '';
    topLockState.confirmedAtTop = false;
    topLockState.pendingOrderRef = null;
    topLockState.pendingOrderOwner = '';
    var rt = topLockRuntime();
    if (rt) { rt.owner = ''; rt.budget = TOPLOCK_MAX_MAINT; rt.reason = ''; }
    topLockState.maintBudget = TOPLOCK_MAX_MAINT;
    topLockGeneration++;
    topLockState.generation = topLockGeneration;
    topLockReason('released', 'released');
    return true;
  }

  function onTopLockActivate(ev, btn, sessionId) {
    topLockState.clicks++;
    // 只有真人手势算数。合成事件（我们自己的恢复点击、探针、诊断）一律拒绝。
    if (!ev || !ev.isTrusted) { topLockState.blocked++; topLockReason('untrusted-click'); return; }
    if (disposed) return;
    // 这两行是【我们自己节点上的】处理：点红按钮不该激活整行、也不该弹开
    // 宿主自己的菜单。宿主自己的 pin / unpin / 拖拽 / 其它菜单一个都没碰。
    if (ev.preventDefault) { try { ev.preventDefault(); } catch (e) {} }
    if (ev.stopPropagation) { try { ev.stopPropagation(); } catch (e) {} }
    if (!btn || !btn.isConnected) { topLockState.blocked++; topLockReason('button-gone'); return; }
    if (sessionId !== btn.getAttribute(TOPLOCK_ID_ATTR)) {
      topLockState.blocked++; topLockReason('row-gone'); return;
    }
    var isTarget = !!topLockState.intentId && sessionId === topLockState.intentId;

    // 虚拟化把节点换给别人之后，这颗按钮必须自己认出来。绝不按任意行去调宿主，
    // 也绝不按一个认不出的行去解除。
    var rowEl = btn.closest ? btn.closest('[data-session-id]') : null;
    if (!rowEl || !rowEl.isConnected || rowEl.getAttribute('data-session-id') !== sessionId) {
      topLockState.blocked++; topLockReason('row-gone'); return;
    }
    // 解除优先于能力、也优先于忙。
    //
    // 之前这里写着 isTarget && !hostCallBusy()，于是"在途时点当前目标"会掉进
    // 下面的 busy 分支，把【同一条】意图重新落盘还顺手补满预算——toggle 看起来
    // 什么都没发生。解除是纯本地操作，闸没有什么可保护的：用户的出路不能取决
    // 于一个他取消不了的调用。我们【不】假装那个调用被撤销：topLockRelease 里
    // 的代次前进会让它的迟到回执变成惰性，而它持有的 ticket 只由它自己释放。
    if (isTarget) {
      topLockInvalidateCaps();
      topLockRelease();
      return;
    }
    return topLockArmIntent(rowEl, sessionId);
  }

  // The red button inlines these two calls where they are; the right-click menu
  // entry calls this. One sequence, one pair of functions, no second copy of any
  // state.
  function topLockReleaseTarget() {
    topLockInvalidateCaps();
    topLockRelease();
  }

  // ONE implementation of "re-resolve, then arm the intent, then trigger one
  // maintenance pass", shared by BOTH entries: the red hover button
  // (onTopLockActivate) and the right-click menu item
  // (onTopLockMenuActivate, in the 到最顶 block).
  //
  // Deliberately one copy. Two copies would eventually disagree about the only
  // question that matters here -- "may we still write the host after the store
  // failed?" -- and they would disagree in the dangerous direction. The two
  // entries differ in exactly three things: the event, their own node, and the
  // isTrusted guard. Everything from the capability downwards is this function.
  function topLockArmIntent(rowEl, sessionId) {
    // 每次点击都重新解析：从不缓存 fiber、fn 或 order 引用（INV-21c）。
    var cap = topmostCapability(rowEl);
    if (!cap.available) {
      topLockState.blocked++;
      topLockReason(cap.reason);
      topLockInvalidateCaps();
      topLockCaps.set(sessionId, { available: false, reason: cap.reason || '', at: topLockState.passes });
      return;
    }
    if (cap.id !== sessionId || cap.source !== 'local') {
      topLockState.blocked++; topLockReason('cap-mismatch'); return;
    }
    // 忙的时候，意图照常更新——那只是一次本地写，永远安全——但绝不并发写
    // 宿主。在途的那一次调用不会被假装撤销：它照样会跑完，只是它的回执已经
    // 属于旧代次，不会再改变任何别的意图的状态。
    if (hostCallBusy()) {
      topLockState.blocked++;
      // The local intent may change while the gate is held -- one localStorage
      // write, always safe. A STORAGE FAILURE must keep its own reason:
      // overwriting it with 'busy'/'locked' would report a lock that was never
      // stored, and would hand a paused row a fresh budget.
      if (!topLockPendingIntent(sessionId)) return;
      topLockReason('busy', 'locked');
      return;
    }
    if (cap.alreadyTop) {
      // 首位不写。已经是最顶的时候再调一次 pinSession 就是多余的宿主写入。
      topLockState.noops++;
      if (!topLockStoreSet(sessionId)) {
        topLockState.blocked++;
        return topLockPause('storage-write-failed');
      }
      topLockState.intentId = sessionId;
      topLockState.intentSource = 'local';
      topLockState.confirmedId = sessionId;
      topLockState.confirmedAtTop = true;
      topLockBudgetReset(sessionId);
      topLockGeneration++;
      topLockState.generation = topLockGeneration;
      topLockReason('confirmed', 'confirmed');
      return;
    }
    // 先存意图，存成功才允许调用宿主。存失败就【一次宿主写都不发生】。
    if (!topLockStoreSet(sessionId)) {
      topLockState.blocked++;
      return topLockPause('storage-write-failed');
    }
    var gen = ++topLockGeneration;
    topLockState.generation = gen;
    topLockState.intentId = sessionId;
    topLockState.intentSource = 'local';
    topLockState.confirmedId = '';
    topLockState.confirmedAtTop = false;
    topLockBudgetReset(sessionId);
    topLockReason('pending-call', 'pending');
    // A first, user-initiated PIN is allowed exactly one trusted call even
    // though the target is not in the pinned order yet -- that absence is the
    // entire point of pinning. The presence gate below guards BACKGROUND work.
    //
    // cap.order rides along on purpose: a Promise resolving is not a commit,
    // and the only proof of a commit is that the array the host's closure reads
    // is a DIFFERENT object from the one this call was issued against. Handing
    // over null here would let a user click be confirmed against the very
    // snapshot that predates it -- which is how a host that quietly ignored the
    // call would still end up showing a solid red arrow.
    return topLockCall(gen, rowEl, sessionId, cap.fn, cap.order);
  }

  // 每趟 apply 末尾跑一次的维持入口。串行、有界、串在已有的 observer / 心跳
  // 上——本模块【不新增任何轮询、interval 或 rAF】。
  function topLockTick() {
    if (disposed) return;
    topLockState.passes++;
    topLockPrune();
    // 存储根本读不到时，理由必须一直是 store-init-failed，不能被下面任何
    // 一趟 idle 覆盖掉。
    if (topLockState.storageBroken) return;
    // The last storage WRITE failed and nothing has succeeded since. Saying
    // 'idle' here would be a lie: the user's click did happen, we just could
    // not record it, and until a write succeeds that is the reason on screen.
    if (topLockState.storageWriteFailed) {
      topLockState.maintBlocked++;
      return topLockPause('storage-write-failed');
    }
    if (!topLockState.intentId) { topLockReason('idle', 'idle'); return; }
    // 维持绝不与用户点击或到最顶并发。忙时的其它锁意图可以安全地更新意图，
    // 但不会并发写宿主。
    if (hostCallBusy()) { topLockState.maintBlocked++; return; }

    var rowEl = topLockIntentRow();
    // The proven view comes from the intent row when it is on screen, otherwise
    // from a witness row. Either way it has to be PROVEN -- proven fiber tree,
    // proven unique hook, proven local source, proven not read-only.
    var view = rowEl ? topLockHostView(rowEl) : topLockTrustedWitness();
    var presence = topLockPresence(view);

    // ---------------------------------------------------------------------
    // THE PRESENCE GATE. Every BACKGROUND write has to pass through here.
    //
    // The previous version only asked this question when the row was missing,
    // so a session the host had just UNPINNED -- row still on screen, its ref
    // no longer in the pinned order -- got silently pinned again by the next
    // tick. Worse, the no-row branch borrowed an arbitrary witness row and
    // treated "its non-empty order does not mention the target" as proof of
    // deletion, which threw the lock away during any view switch.
    //
    // A non-empty order missing the ref is NOT proof that the host finished
    // loading, and it is NOT proof of deletion: a mid-load snapshot looks
    // identical. So neither clearing nor re-pinning may be derived from it. The
    // lock is kept, the reason is the same for every unproven case, and only the
    // user can end it.
    // ---------------------------------------------------------------------
    // The witness path's own verdict on the TARGET, when it is not our row.
    if (view && view.targetReason) {
      topLockState.maintBlocked++;
      return topLockPause(view.targetReason);
    }
    if (presence !== 'present') {
      topLockState.maintBlocked++;
      return topLockPause(topLockPauseReasonFor(presence));
    }
    topLockCaps.set(topLockState.intentId, {
      available: true, reason: 'ok', at: topLockState.passes,
      orderLength: view.order.length, hasOrder: true,
    });
    if (topLockConfirm(view)) { topLockState.confirmTries = 0; return; }   // 已在首位：一次调用都不做

    if (topLockState.phase === 'awaiting') {
      topLockState.confirmTries++;
      // 只读的确认窗口：不写宿主。窗口内绝不重发。
      if (topLockState.confirmTries <= TOPLOCK_CONFIRM_TRIES) return;
      topLockState.blocked++;
      topLockBlockRetry(topLockState.intentId, 'unconfirmed-return');
      return topLockPause('unconfirmed-return');
    }
    if (topLockState.phase === 'paused') return;   // 暂停中：等真人重新点一次
    var blocked = topLockRetryBlocked(topLockState.intentId);
    if (blocked) return topLockPause(blocked);
    // A runtime that cannot be persisted is a REFUSAL to maintain, not an
    // invitation to try again: a private budget would be a fresh 3 every pass,
    // which is the exact promise-breaker this runtime exists to prevent.
    var rt = topLockRuntime();
    if (!rt) { topLockState.maintBlocked++; return topLockPause('runtime-unavailable'); }
    if (rt.budget <= 0) {
      // 预算耗尽 = 显式暂停。宿主/用户在跟我们反复抢同一个位置时，这条是
      // 唯一的刹车：没有它就是永久 storm。
      topLockState.maintBlocked++;
      topLockBlockRetry(topLockState.intentId, 'budget-exhausted');
      return topLockPause('budget-exhausted');
    }
    topLockSpendBudget();
    topLockReason('pending-call', 'pending');
    return topLockCall(topLockGeneration, rowEl, topLockState.intentId, view.fn, view.order);
  }
  topLockLoad();

  var timer = window.setInterval(scheduleApply, cfg.intervalMs || 3000);

  var api = {
    cfg: cfg,
    mount: mount,
    apply: apply,
    enforceNoAutoExpand: enforceNoAutoExpand,
    // Read-only view of the pinned-truncation memory, for probes and the
    // daemon log: what the user asked for, how many restores fired so far,
    // which truncation button (if any) is currently in the DOM, and how many
    // times the user has used the collapse escape hatch.
    pinnedMore: function () {
      var f = pinnedTruncButton();
      return {
        want: pinnedMoreState.want, restored: pinnedMoreState.restored, escapes: pinnedMoreState.escapes,
        button: f ? f.kind : null,
      };
    },
    // Read-only view of the cloud accumulator, so the daemon log can tell
    // "cloud unsupported" apart from "cloud connected but nothing running".
    // evicted is the cumulative count of entries the 64-session ceiling threw
    // away; a non-zero value means some running cloud session may be missing
    // its dot, which is a different problem from a missing event bus.
    cloudState: function () {
      return { subscribed: !!unsubCloud, tracked: cloudState.size, evicted: cloudEvicted, entries: Array.from(cloudState) };
    },
    // READ ONLY capability probe for the "pin to top" menu item. It resolves
    // the host's own handlePinSession hook the same way the menu item does and
    // reports what it found, so an operator can tell "not implemented here"
    // apart from "implemented, but this host does not expose it" without
    // clicking anything. Pass a session id to probe that row; with no argument
    // the first pinned row is used, else the first row on screen.
    //
    // available=false carries the reason: no-handle-pin-session,
    // ambiguous-handle-pin-session, readonly-session, cloud-not-provable,
    // source-not-local:<source>, no-session-row. None of them is ever worked
    // around -- there is no second route.
    topmost: function (sessionId) {
      var row = null;
      if (sessionId) {
        try { row = document.querySelector('[data-session-id="' + String(sessionId) + '"]'); } catch (e) { row = null; }
      }
      if (!row) {
        var sec = document.querySelector('[data-pinned-section]');
        row = (sec && sec.querySelector('[data-session-id]')) || document.querySelector('[data-session-id]');
      }
      var cap = row ? topmostCapability(row) : { available: false, reason: 'no-session-row' };
      return {
        available: cap.available === true,
        reason: cap.reason || '',
        // Same reason, written for a person. The code above stays the machine
        // readable one; this is what the menu item renders.
        reasonText: topmostReasonText(cap.reason || 'no-session-row'),
        id: cap.id || '',
        source: cap.source || '',
        alreadyTop: cap.alreadyTop === true,
        matches: cap.matches || 0,
        orderLength: typeof cap.orderLength === 'number' ? cap.orderLength : -1,
        orderFirst: cap.orderFirst || '',
        injected: topmostState.injected,
        // The second menu item's presence, so "it never appeared" is a number
        // the operator can read rather than something to infer.
        lockInjected: topmostState.lockInjected,
        busy: topmostState.busy,
        clicks: topmostState.clicks,
        calls: topmostState.calls,
        noops: topmostState.noops,
        blocked: topmostState.blocked,
        lastReason: topmostState.lastReason,
        lastClose: topmostState.lastClose,
        lastSessionId: topmostState.lastSessionId,
        // The auto-top corrector's whole budget, in one plain object: it is a
        // machine code and counter only -- no fiber, no DOM node, no function,
        // no session title, no conversation content. unproven is the one that
        // matters in the field: a rising count means the pinned order could not
        // be proven, so nothing was written and the last proven baseline was
        // kept.
        autoTop: {
          passes: autoTopState.passes,
          settleMiss: autoTopState.settleMiss,
          changes: autoTopState.changes,
          calls: autoTopState.calls,
          blocked: autoTopState.blocked,
          refused: autoTopState.refused,
          unproven: autoTopState.unproven,
          deferred: autoTopState.deferred,
          exhausted: autoTopState.exhausted,
          noCandidate: autoTopState.noCandidate,
          alreadyTop: autoTopState.alreadyTop,
          noBaseline: autoTopState.noBaseline,
          budget: autoTopState.budget,
          budgetMax: TOPMOST_AUTOTOP_MAX,
          owner: autoTopState.owner,
          lastId: autoTopState.lastId,
          lastReason: autoTopState.lastReason,
        },
        // The active-session corrector, same shape and same discipline. Its
        // trigger is a STATE change (idle -> running) on a member that is
        // already pinned, NOT a position change, so a plain drag by the user
        // moves no counter except a passing noChange.
        //
        // 'running' is the ONLY bucket that reads as "started a turn". The map
        // arrives with every idle already filtered out, so waiting / paused /
        // error / done are all "present but not running" and none of them
        // promotes -- the comparison is equality, not presence.
        //
        // changes counts EVERY pass where an idle -> running transition was
        // found, at any index: the counter is bumped before the index-0 case
        // is peeled off, so it already contains the already-top transitions.
        // alreadyTop is that index-0 subset (nothing to do, no budget spent),
        // and what is left after it is the set of moves attempted -- calls for
        // the ones that reached the host, refused / blocked / exhausted for the
        // ones that did not. Same contract as autoTop above, whose counters are
        // stepped in the same order: machine code and counters only, no id
        // list, no fiber, no DOM node, no conversation content.
        pinnedPromote: {
          passes: promoteState.passes,
          settleMiss: promoteState.settleMiss,
          changes: promoteState.changes,
          noChange: promoteState.noChange,
          calls: promoteState.calls,
          blocked: promoteState.blocked,
          refused: promoteState.refused,
          unproven: promoteState.unproven,
          deferred: promoteState.deferred,
          exhausted: promoteState.exhausted,
          alreadyTop: promoteState.alreadyTop,
          noBaseline: promoteState.noBaseline,
          budget: promoteState.budget,
          budgetMax: TOPMOST_PROMOTE_MAX,
          lastId: promoteState.lastId,
          lastReason: promoteState.lastReason,
        },
      };
    },
    // READ ONLY snapshot of the minimal 到最顶 diagnostic. Its whole job is to
    // say WHICH gate the real attempts reached -- nomenu / nopopup / connected /
    // retarget / append -- plus what the last right-clicked row looks like from
    // the outside (expando count, anchor shape, root hops). It deliberately
    // carries NO owner resolution of its own, NO DFS mirror and NO popup scan:
    // those were the parts that could disagree with the shipped code, and a
    // diagnostic that can disagree with the thing it diagnoses is worse than no
    // diagnostic.
    //
    // The one exception is the per-attempt popup field, and it is not a
    // re-derivation:
    // it is the loop record the SHIPPED popupForMenu produced during that very
    // attempt, replayed through the same whitelist copy. The collector re-copies
    // it layer by layer so nothing in the payload aliases live state, and it
    // never reads the topmostDiag.popup slot or scans anything again.
    //
    // Its own try/catch: a throw here must never take stats or topmost with it.
    topmostDiag: function () {
      var t0 = topmostDiagNow();
      var out;
      try {
        var row = topmostDiag.row;
        out = {
          available: true,
          schema: 'topmost-diag/1',
          // Always unknown, and that is the honest value: this probe does not
          // observe the popup tree, so it cannot claim to be contemporaneous
          // with any attempt. A later DOM state must never be read back as the
          // reason an earlier attempt failed. What the per-attempt popup field
          // DOES carry is the loop that actually ran during that attempt, which
          // is why it is attached to the attempt and not to this snapshot.
          phase: 'unknown',
          chain: topmostDiag.chain,
          gen: topmostDiag.gen,
          capped: topmostDiag.capped === true,
          attempts: topmostDiagAttemptsCopy(),
          earlyStop: topmostDiag.earlyStop.slice(0, TOPMOST_DIAG_MAX_EARLY),
          row: { present: !!row, connected: row ? !!row.isConnected : false },
          selection: topmostDiagSelection(),
          expando: row ? topmostDiagExpando(row) : { count: 0, family: 'no-row' },
          anchor: row ? topmostDiagAnchor(row) : { count: 0, firstSelf: false, nearestRow: false },
          root: row ? topmostDiagRoot(row) : null,
        };
      } catch (e) {
        out = { available: false, schema: 'topmost-diag/1', error: 'collector-threw' };
      }
      // Overhead is observable, not assumed: "cheap" is a claim, this is a number.
      try { out.durationMs = topmostDiagNow() - t0; } catch (e) { out.durationMs = -1; }
      return out;
    },
    // READ ONLY snapshot of the 红色悬停锁顶 state machine, for the daemon log
    // and for probes. Its whole job is to answer three questions: what the user
    // asked for (intent), where the host's own order actually says it sits
    // (confirmed), and why the machine is not doing anything else (phase +
    // reason). It carries NO fiber, NO DOM node, NO function, NO session title
    // and NO conversation content -- only the intent's own session id, which is
    // the one id this feature is allowed to remember.
    //
    // Its own try/catch: a throw here must never take anything else with it.
    topLock: function () {
      var out;
      try {
        out = {
          available: true,
          schema: 'top-lock/1',
          phase: topLockState.phase,
          reason: topLockState.reason,
          reasonText: topLockReasonText(topLockState.reason),
          intent: topLockState.intentId
            ? { id: topLockState.intentId, source: topLockState.intentSource }
            : null,
          // The position the host's OWN fresh order confirms. Empty string means
          // "not proven right now" -- never "it is at the bottom".
          confirmedId: topLockState.confirmedId,
          confirmedAtTop: topLockState.confirmedAtTop === true,
          generation: topLockState.generation,
          busy: topLockState.busy === true,
          injected: topLockState.injected,
          clicks: topLockState.clicks,
          calls: topLockState.calls,
          noops: topLockState.noops,
          blocked: topLockState.blocked,
          releases: topLockState.releases,
          cleared: topLockState.cleared,
          maintCalls: topLockState.maintCalls,
          maintBudget: topLockState.maintBudget,
          maintBudgetMax: TOPLOCK_MAX_MAINT,
          maintBlocked: topLockState.maintBlocked,
          storageWrites: topLockState.storageWrites,
          storageFailures: topLockState.storageFailures,
          corrupt: topLockState.corrupt,
          // The seam is now wired against the shapes read out of app.asar, and
          // it still fails closed: a row whose strip or title cannot be
          // UNIQUELY identified gets no button, which anchorRefused counts.
          anchorOk: topLockState.anchorOk,
          anchorRefused: topLockState.anchorRefused,
        };
      } catch (e) {
        out = { available: false, schema: 'top-lock/1', error: 'collector-threw' };
      }
      return out;
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
      try { document.removeEventListener('contextmenu', onContextMenu, true); } catch (e) {}
      for (var tt = 0; tt < topmostTimers.length; tt++) window.clearTimeout(topmostTimers[tt]);
      // Straight after the timer loop, and for the same reason as in
      // onContextMenu: a MutationObserver attached to the document outlives
      // every queued timer, and the loop above cannot reach it. This also
      // unhooks the watch's own click listener, which lives and dies with the
      // watch, and cancels the one timer the loop may not have owned.
      stopTopmostWatch(topmostWatch);
      topmostTimers.length = 0;
      // Second line of defence for the same reason, and for the same reason it
      // is not redundant: the clearTimeout loop above is the one that depends
      // on the id still being in the list, and this one does not depend on it
      // working at all.
      topmostGeneration++;
      clearTopmostItems();
      // The lock's own menu item: our node, in the HOST's overlay, so it has to
      // come out with us or it would outlive the instance inside a cached popup.
      // The selector is written as a literal for the same reason the lock
      // buttons below are: this teardown is sliced on its own by the suites.
      var topLockMenuItems = document.querySelectorAll('[data-mmx-toplock-menu]');
      for (var tm = 0; tm < topLockMenuItems.length; tm++) topLockMenuItems[tm].remove();
      topmostDiagDispose();
      window.clearInterval(timer);
      if (rafId) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
      pending = false;
      var dots = document.querySelectorAll('[' + MARK + ']');
      for (var i = 0; i < dots.length; i++) dots[i].remove();
      // 红色悬停锁顶按钮：只摘【我们自己挂的节点】，选择器字面量写死在这里，
      // 不用常量，是为了让这段 teardown 单独拿出来也能编译（离线套件按块切片）。
      // 我们的监听器全部绑在按钮节点自己身上，节点被摘掉监听器随之消失，
      // 所以这里不需要任何额外的事件解绑。
      var lockBtns = document.querySelectorAll('[data-mmx-toplock]');
      for (var lb = 0; lb < lockBtns.length; lb++) lockBtns[lb].remove();
      // 自有 scoped CSS 与 reserve 标记也是"我们挂上去的"，dispose 必须一起摘，
      // 否则重新注入会叠加出第二份 margin。选择器写死成字面量，同上。
      var lockTitles = document.querySelectorAll('[data-mmx-toplock-reserve]');
      for (var lt = 0; lt < lockTitles.length; lt++) lockTitles[lt].removeAttribute('data-mmx-toplock-reserve');
      var lockStrips = document.querySelectorAll('[data-mmx-toplock-strip]');
      for (var ls = 0; ls < lockStrips.length; ls++) lockStrips[ls].removeAttribute('data-mmx-toplock-strip');
      var lockMounts = document.querySelectorAll('[data-mmx-toplock-mount]');
      for (var lm = 0; lm < lockMounts.length; lm++) lockMounts[lm].removeAttribute('data-mmx-toplock-mount');
      var lockStyle = document.querySelector('[data-mmx-toplock-style]');
      if (lockStyle) lockStyle.remove();
      var summary = document.getElementById(SUMMARY_ID);
      if (summary) summary.remove();
      var less = document.getElementById(PINNED_LESS_ID);
      if (less) less.remove();
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
  // topmost is a pure READ of the page: it resolves the host's own pin hook and
  // reports what it found, it never pins anything. It rides along with the
  // periodic refresh so the daemon log carries the capability and its reason
  // without anybody having to click a menu.
  return `(function(){var a=window.${GLOBAL};if(!a)return {ok:false,reason:'not-installed'};return {ok:true,stats:a.refresh(${JSON.stringify(statusMap)}),topmost:a.topmost(),topmostDiag:(function(){try{return a.topmostDiag();}catch(e){return {available:false,error:'collector-threw'};}})()};})()`;
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
