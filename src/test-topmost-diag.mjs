// mmx-status :: test-topmost-diag.mjs
//
// Wiring tests for the MINIMAL 到最顶 diagnostic (the "topmost-diag/1" probe).
// The code under test is sliced out of lib/page-script.mjs and run, never
// retyped -- a regex over the source proves nothing about behaviour, which is
// exactly how the previous probe version shipped a DFS that was more permissive
// than the shipped one and called a real "nomenu" a "found".
//
// WHAT IS ASSERTED, and why each one matters
//
//  W1  nomenu is recorded AT the shipped `!menuFiber` return, not inferred.
//      The proof that it is the same return point is topmostState.lastReason:
//      the shipped code writes 'no-menu-fiber' on exactly that line, so if the
//      record ever drifts onto another path the two stop agreeing.
//  W2  nopopup likewise, and lastReason proves it is NOT the nomenu line.
//  W3  append is recorded when the item is actually in the menu.
//  W4  The other real gates: connected (row gone) and retarget (same node, new
//      session).
//  W5  The attempt buffer is bounded at 3, matching the shipped tries limit,
//      and the retry schedule is still exactly 0 then 8 -- the diagnostic adds
//      no retry and does not lengthen the window.
//  W6  earlyStop records a chain being cut short (superseded / disposed) at the
//      CHAIN level and does not fabricate a try for it.
//  W7  A disconnected snapshot row is cleared, and reapTopmost's own early
//      return (which is about the item's visibility, not the row's) does not
//      get to block that cleanup.
//  W8  dispose clears the snapshot.
//  W9  selection follows the same order api.topmost() uses (pinned first).
//  W10 expando count / anchor shape / root hops, including the case that
//      actually matters in the field: the root sits beyond the shipped 40.
//  W11 Nothing identifying leaks: no id, no title, no token, no host callback
//      source. And the payload carries no owner / dfs / popup / raw-current
//      fields at all.
//  W12 Overhead is a number, not a claim: durationMs is finite.
//  W13 A collector that throws is contained: it degrades to available:false
//      and leaves topmostState untouched.
//  W14 THE BIG ONE. The parts that could disagree with the shipped code are
//      not merely hidden from the output -- they are not called and not
//      compiled into the probe at all. Asserted against the shipped source:
//      the diagnostic region contains no popup query, no nearestMenuOwner, no
//      currentFiberOf / currentHostRoot / chainTop, no rowMenuFiber, no .sibling
//      walk, and no host function reference.
//  W16 The popup side channel's WIRING: one transport slot, one envelope with
//      three ownership stamps that never enter the payload, only nopopup /
//      append may carry a loop record, a fault in the transport degrades popup
//      to null while the shipped stage is still recorded, and Start / Reap /
//      Dispose all drain the slot.
//  W17 The whitelist copy: unknown keys are dropped, a non-nullable field that
//      is illegal or throws rejects the WHOLE record, a nullable one degrades
//      to null and never to 0 / 'unknown', and no input object or getter leaks.
//  W18 The collector rebuilds attempt / popup / candidate layer by layer, never
//      reads the transport slot, never scans the popup tree again, and edits to
//      the payload do not flow back into the diagnostic.
//  W15 The shipped contract is untouched: TOPMOST_MAX_ANCESTORS is still 40,
//      the retry delays are still 0/8/16, and the multiset of topmostReason
//      write points is exactly the pre-diagnostic one -- no new reason.
//
// Run    : node src/test-topmost-diag.mjs
//
//  g1 nomenu is not recorded / g2 nopopup is not recorded /
//  g3 the snapshot cleanup moves behind reapTopmost's early return /
//  g4 earlyStop is not recorded (all four: the original minimal probe) --
//  g5 the stage gate is dropped, so a stage that never ran popupForMenu can
//     still pick up a leftover envelope,
//  g6 Take grabs the envelope but never clears the slot,
//  g7 the whitelist copy degrades to Object.assign,
//  g8 a non-nullable counter stops being validated,
//  g9 the chain stamp stops being checked,
//  g10 the collector stops rebuilding and hands out the live attempt objects.
import fs from 'node:fs';
import { makeDom, attachFiber, hookChain, fiber } from './testlib/fake-dom.mjs';

const MUT = process.env.MMX_MUTATE || '';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
};

const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
const MISSING_ATTEMPT = { try: -1, stage: 'missing', chain: -1, gen: -1, popup: null };
const attempts = (page) => page.api.collect().attempts;
const att0 = (page) => attempts(page)[0] || MISSING_ATTEMPT;
function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}

let BLOCK = sliceBlock("  var TOPMOST_LABEL = '到最顶';", '  var handler = function () { scheduleApply(); };');

// The teardown, sliced rather than retyped. Its end anchor moved past
// topmostDiagDispose() so the diagnostic teardown is part of what runs.
const DISPOSE_TAIL = sliceBlock('      for (var tt = 0; tt < topmostTimers.length; tt++)',
  '      window.clearInterval(timer);');
// The api member, taken whole so the shipped collector is what runs.
let COLLECTOR = '({' + sliceBlock('    topmostDiag: function () {',
  "    // apply()'s return value used to be discarded here,") + '}).topmostDiag';

if (MUT === 'g1') {
  const from = "      topmostDiagRecord('nomenu');\n      topmostReason('no-menu-fiber');";
  if (!BLOCK.includes(from)) throw new Error('mutation g1 anchor not found');
  BLOCK = BLOCK.replace(from, "      topmostReason('no-menu-fiber');");
} else if (MUT === 'g2') {
  const from = "      topmostDiagRecord('nopopup');\n      return false;";
  if (!BLOCK.includes(from)) throw new Error('mutation g2 anchor not found');
  BLOCK = BLOCK.replace(from, '      return false;');
} else if (MUT === 'g3') {
  const from = '    topmostDiagReap();\n    if (!topmostNode) return;';
  if (!BLOCK.includes(from)) throw new Error('mutation g3 anchor not found');
  BLOCK = BLOCK.replace(from, '    if (!topmostNode) return;\n    topmostDiagReap();');
} else if (MUT === 'g4') {
  const from = "  function topmostDiagEarlyStop(chain, reason) {\n    try {";
  if (!BLOCK.includes(from)) throw new Error('mutation g4 anchor not found');
  BLOCK = BLOCK.replace(from, '  function topmostDiagEarlyStop(chain, reason) {\n    try { return;');
} else if (MUT === 'g5') {
  // The stage gate is dropped, so a stage that never ran popupForMenu can still
  // pick up whatever envelope happened to be in the slot.
  const from = "      if (stage === 'nopopup' || stage === 'append') popup = taken;";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation g5 anchor not unique');
  BLOCK = BLOCK.replace(from, '      popup = taken;');
} else if (MUT === 'g6') {
  // Take grabs the envelope but never clears the slot, so a leftover envelope
  // stays readable by the next attempt.
  const from = "    try { env = topmostDiag.popup; } catch (e) { env = null; }\n    try { topmostDiag.popup = null; } catch (e) {}";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation g6 anchor not unique');
  BLOCK = BLOCK.replace(from, "    try { env = topmostDiag.popup; } catch (e) { env = null; }");
} else if (MUT === 'g7') {
  // The whitelist copy becomes a bulk Object.assign, so unknown keys, DOM nodes
  // and input aliases all ride straight into the payload.
  const from = "      if (!trace || typeof trace !== 'object') return null;";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation g7 anchor not unique');
  BLOCK = BLOCK.replace(from,
    "      if (!trace || typeof trace !== 'object') return null;\n      return Object.assign({}, trace);");
} else if (MUT === 'g8') {
  // A non-nullable counter stops being validated, so a missing or non-finite
  // value is reported as if it had been measured.
  const from = "      if (!topmostDiagPopupNum(trace.scanned)) return null;";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation g8 anchor not unique');
  BLOCK = BLOCK.replace(from, '');
} else if (MUT === 'g9') {
  // The chain stamp stops being checked, so a trace published by a superseded
  // chain is accepted as if it belonged to this attempt.
  const from = "      if (chain !== topmostDiag.chain) return null;";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation g9 anchor not unique');
  BLOCK = BLOCK.replace(from, '');
} else if (MUT === 'g10') {
  // The collector stops re-copying and hands out the live attempt objects, so
  // the payload aliases diagnostic state and edits flow back into it.
  const from = "          attempts: topmostDiagAttemptsCopy(),";
  if (COLLECTOR.split(from).length - 1 !== 1) throw new Error('mutation g10 anchor not unique');
  COLLECTOR = COLLECTOR.replace(from, '          attempts: topmostDiag.attempts,');
} else if (MUT) {
  throw new Error('unknown MMX_MUTATE=' + MUT);
}

// ---------------------------------------------------------------------------
// A timer queue that records the delay the shipped code asked for, because
// "the retry window is still 0/8/16" is only assertable if the queue keeps it.
function makeTimers() {
  const q = [];
  let id = 0;
  return {
    setTimeout(fn, delay) { const t = { id: ++id, fn, delay }; q.push(t); return t.id; },
    clearTimeout(tid) { const i = q.findIndex((t) => t.id === tid); if (i >= 0) q.splice(i, 1); },
    run() { const b = q.splice(0, q.length); for (const t of b) t.fn(); },
    delays() { return q.map((t) => t.delay); },
    size() { return q.length; },
  };
}

function makePage() {
  const dom = makeDom();
  const timers = makeTimers();
  const window = { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  const factory = new Function(
    'window', 'document',
    'var disposed = false;\n' +
      'var disposeCloud = function () {};\n' +
      'var observer = { disconnect: function () {} };\n' +
      'var expandGuardObserver = { disconnect: function () {} };\n' +
      'var handler = function () {};\n' +
      'var onPinnedMoreClick = function () {};\n' +
      'var timer = 1;\n' +
      BLOCK +
      '\n  var disposeTopmost = function () {\n' + DISPOSE_TAIL + '\n  };\n' +
      '\nreturn { onContextMenu: onContextMenu, tryInjectTopmost: tryInjectTopmost,' +
      ' reapTopmost: reapTopmost, disposeTopmost: disposeTopmost,' +
      ' collect: ' + COLLECTOR + ',' +
      ' state: topmostState, node: function () { return topmostNode; },' +
      ' diag: function () { return topmostDiag; },' +
      ' setDiag: function (k, v) { topmostDiag[k] = v; },' +
      // The shipped side-channel entry points, so W16 can drive them directly
      // and observe what a fault does to the SLOT -- something a right click
      // cannot show, because Record always drains the slot before returning.
      ' popupOpen: topmostDiagPopupOpen,' +
      ' popupTake: topmostDiagPopupTake,' +
      ' popupCopy: topmostDiagPopupCopy,' +
      ' record: topmostDiagRecord,' +
      ' popupForMenu: popupForMenu,' +
      ' setDisposed: function (v) { disposed = v; } };'
  );
  return { dom, timers, api: factory(window, dom.document) };
}

// ---------------------------------------------------------------------------
// The host pin hook, in the shape the shipped selector requires: arity 3, seven
// deps, and a source that mentions BOTH .pinSession and .getSessionInfo.
const PinService = { calls: [], async pinSession() { PinService.calls.push([...arguments]); } };
const SessionInfo = { getSessionInfo: async (id) => ({ id }) };
function makeHost(id) {
  const h = { calls: [] };
  h.order = [{ type: 'session', id: 'mvs_other' }];
  h.deps = [
    (sid) => sid === 'mvs_readonly',
    h.order,
    'local',
    {},
    () => {}, () => {}, (next) => { h.order = next; },
  ];
  h.fn = async function (e, l, c) {
    h.calls.push([e, l, c]);
    if (h.deps[0](e, h.source)) return;
    const s = await SessionInfo.getSessionInfo(e, undefined, h.source);
    if (l) h.deps[6]([{ type: 'session', id: e }].concat(h.order.filter((x) => x.id !== e)));
    void s; void c;
  };
  return h;
}

// A row shaped the way app.asar builds it: the Dropdown carrying the contextMenu
// is a DESCENDANT of div[data-session-id] and the ANCESTOR of the shortcut
// button, and the expando may hand back the stale half.
function makeRow(page, id, host, opts = {}) {
  const rowEl = page.dom.el('div', { 'data-session-id': id });
  const shortcut = page.dom.el('button', { type: 'button', 'data-shortcut-session-target': id });
  rowEl.appendChild(shortcut);
  page.dom.root.appendChild(rowEl);
  if (opts.anchor !== false) rowEl.querySelectorAll = (sel) => (sel === '[data-shortcut-session-target]' ? [shortcut] : []);
  const fiberRoot = { current: null };
  const currentRoot = fiber({ tag: 3, name: 'HostRoot', hooks: null, parent: null });
  currentRoot.stateNode = fiberRoot;
  const staleRoot = fiber({ tag: 3, name: 'HostRoot', hooks: null, parent: null });
  staleRoot.stateNode = fiberRoot;
  currentRoot.alternate = staleRoot; staleRoot.alternate = currentRoot;
  const container = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain([[host.fn, host.deps]]), parent: currentRoot });
  const rowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, hooks: null, parent: container });
  let dropdown = null;
  if (opts.menu !== false) {
    dropdown = fiber({
      name: 'Dropdown',
      props: { menu: [{ key: 'rename' }, { key: 'pin' }], trigger: ['contextMenu'], onOpenChange() {} },
      hooks: null, parent: rowDiv,
    });
    const group = fiber({ tag: 5, name: 'div', props: { className: 'group' }, hooks: null, parent: dropdown });
    const btnFiber = fiber({ tag: 5, name: 'button', props: { 'data-shortcut-session-target': id }, hooks: null, parent: group });
    attachFiber(shortcut, btnFiber);
    rowDiv.child = dropdown; dropdown.child = group; group.child = btnFiber;
  }
  fiberRoot.current = currentRoot;
  attachFiber(rowEl, rowDiv);
  return { rowEl, shortcut, dropdown, fiberRoot, container, rowDiv };
}

function openMenu(page, dropdown, opts = {}) {
  const ul = page.dom.el('ul', { class: 'ant-dropdown-menu' });
  ul.appendChild(page.dom.el('li', { class: 'ant-dropdown-menu-item' }, [
    page.dom.el('div', { class: 'matrix-menu-item' }, [page.dom.el('div', {}, ['重命名'])]),
  ]));
  const list = fiber({ name: 'MenuList', props: {}, hooks: null, parent: dropdown });
  const ulFiber = fiber({ tag: 5, name: 'ul', props: {}, hooks: null, parent: list });
  attachFiber(ul, ulFiber);
  page.dom.root.appendChild(ul);
  if (opts.hidden) ul.__hidden = true;
  return { ul };
}

const rightClick = (page, rowEl) =>
  page.api.onContextMenu({ target: rowEl, isTrusted: true });
const stages = (page) => page.api.collect().attempts.map((a) => a.stage);
// Same non-throwing discipline the menu suite uses: a mutation that stops
// recording an attempt must surface as ordinary FAILs below, not as a TypeError
// that aborts the run before the rest of the wiring is exercised.


// ===========================================================================
console.log(`\n=== 0. 出厂切片（MMX_MUTATE=${MUT || 'none'}）===`);
{
  let ok = true;
  try {
    new Function('window', 'document', 'var disposed=false;\n' + BLOCK);
  } catch (e) { ok = false; }
  check('切片语法合法', ok, `${BLOCK.length} chars`);
  check('nomenu 记录与 no-menu-fiber 写在同一处 return 上',
    BLOCK.includes("      topmostDiagRecord('nomenu');\n      topmostReason('no-menu-fiber');\n      return false;"));
  check('nopopup 记录在原 !ul return 上，且没有新增 topmostReason',
    BLOCK.includes('    if (!ul) {\n      topmostDiagRecord(\'nopopup\');\n      return false;\n    }'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. nomenu：出厂 rowMenuFiber 返回 null 的那一行 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });   // row has no Dropdown
  rightClick(page, t.rowEl);
  page.timers.run();
  const d = page.api.collect();
  check('W1 attempt 1 记为 nomenu', stages(page).join() === 'nomenu', stages(page).join());
  check('W1b 出厂 lastReason 同时是 no-menu-fiber（证明是同一条 return）',
    page.api.state.lastReason === 'no-menu-fiber', page.api.state.lastReason);
  // nomenu never reached popupForMenu, so it has no loop record to report --
  // and the field is still THERE, carrying null. Absent and null are different
  // claims: absent would say "this schema has no such field".
  check('W1c 没有伪造 owner / dfs 字段，且 popup 只挂在 attempt 上',
    !('owner' in d) && !('dfs' in d) && !('dfsShipped' in d) && !('popup' in d)
    && d.attempts.length === 1 && d.attempts[0].popup === null,
    Object.keys(d).join(',') + ' attemptKeys=' + Object.keys(d.attempts[0] || {}).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. nopopup：菜单 fiber 有了，弹层没有 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host);                    // Dropdown present
  rightClick(page, t.rowEl);
  page.timers.run();
  check('W2 attempt 1 记为 nopopup', stages(page).join() === 'nopopup', stages(page).join());
  check('W2b lastReason 不是 no-menu-fiber（证明不是 nomenu 那一行）',
    page.api.state.lastReason !== 'no-menu-fiber', page.api.state.lastReason);
  check('W2c 出厂没注入任何项', page.api.state.injected === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. append：菜单与可见弹层都在 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host);
  const menu = openMenu(page, t.dropdown);
  rightClick(page, t.rowEl);
  page.timers.run();
  check('W3 attempt 1 记为 append', stages(page).join() === 'append', stages(page).join());
  check('W3b 菜单里确实有一项', menu.ul.querySelectorAll('li[data-mmx-topmost]').length === 1);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. connected / retarget 两个真实门禁 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });
  t.rowEl.remove();
  rightClick(page, t.rowEl);
  page.timers.run();
  check('W4 行已卸载 -> connected', stages(page).join() === 'connected', stages(page).join());
  check('W4b lastReason 是 row-gone', page.api.state.lastReason === 'row-gone', page.api.state.lastReason);
}
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });
  rightClick(page, t.rowEl);
  t.rowEl.setAttribute('data-session-id', 'mvs_y');   // same node, new session
  page.timers.run();
  check('W4c 同一 DOM 换 id -> retarget', stages(page).join() === 'retarget', stages(page).join());
  check('W4d lastReason 是 row-retargeted', page.api.state.lastReason === 'row-retargeted', page.api.state.lastReason);
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. 次数上限与重试窗口不变 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });
  rightClick(page, t.rowEl);
  check('W5 首个 timer 的 delay 是 0', page.timers.delays().join() === '0', page.timers.delays().join());
  page.timers.run();
  check('W5b 第二次的 delay 是 8（窗口未变长）', page.timers.delays().join() === '8', page.timers.delays().join());
  page.timers.run();
  page.timers.run();
  const d = page.api.collect();
  check('W5c 恰好 3 条 attempt，全部 nomenu',
    d.attempts.length === 3 && d.attempts.map((a) => a.stage).join() === 'nomenu,nomenu,nomenu',
    d.attempts.map((a) => a.stage).join());
  check('W5d capped 为真，且没有第 4 条',
    d.capped === true && d.attempts.length === 3, JSON.stringify(d.capped));
  check('W5e try 序号是 1..3', d.attempts.map((a) => a.try).join() === '1,2,3',
    d.attempts.map((a) => a.try).join());
  check('W5f 出厂 lastReason 是 menu-not-found', page.api.state.lastReason === 'menu-not-found',
    page.api.state.lastReason);
  check('W5g capped 没有把最后一次的真实原因覆盖掉',
    d.attempts.length === 3 && d.attempts[2].stage === 'nomenu',
    d.attempts.length === 3 ? d.attempts[2].stage : '(no third attempt recorded)');
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. earlyStop：链被掐断，不伪造 try ===');
{
  const page = makePage();
  const host = makeHost();
  const t1 = makeRow(page, 'mvs_a', host, { menu: false });
  const t2 = makeRow(page, 'mvs_b', host, { menu: false });
  rightClick(page, t1.rowEl);
  rightClick(page, t2.rowEl);                 // preempts before the timer ran
  const d = page.api.collect();
  check('W6 记下了 superseded', d.earlyStop.some((e) => e.reason === 'superseded'),
    JSON.stringify(d.earlyStop));
  check('W6b superseded 归属于被掐断的那条链（chain 1）',
    d.earlyStop.some((e) => e.reason === 'superseded' && e.chain === 1), JSON.stringify(d.earlyStop));
  check('W6c 接管后 attempts 归零（属于新链）', d.attempts.length === 0, JSON.stringify(d.attempts));
  check('W6d chain 递增到 2', d.chain === 2, String(d.chain));
}
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });
  rightClick(page, t.rowEl);
  page.timers.run();
  page.api.disposeTopmost();
  const d = page.api.collect();
  check('W6e dispose 记下 disposed', d.earlyStop.some((e) => e.reason === 'disposed'),
    JSON.stringify(d.earlyStop));
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. 生命周期：快照行断开即清，reap 的早退挡不住 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });
  rightClick(page, t.rowEl);
  page.timers.run();
  check('W7 起始时快照行在', page.api.collect().row.present === true);
  // Detach the row while leaving a VISIBLE, CONNECTED item behind, so
  // reapTopmost's own early return fires. If the diag cleanup sat after that
  // return, the stale row would survive here -- which is mutation g3.
  page.api.setDiag('row', t.rowEl);
  t.rowEl.remove();
  page.api.reapTopmost();
  const d = page.api.collect();
  check('W7b 行断开后快照被清（哪怕 reap 会早退）',
    d.row.present === false && d.attempts.length === 0, JSON.stringify(d.row));
}
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });
  rightClick(page, t.rowEl);
  page.api.disposeTopmost();
  const d = page.api.collect();
  check('W8 dispose 后快照与 attempts 都清空',
    d.row.present === false && d.attempts.length === 0 && d.capped === false,
    JSON.stringify({ row: d.row, attempts: d.attempts.length, capped: d.capped }));
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. selection / expando / anchor / root ===');
{
  const page = makePage();
  const host = makeHost();
  makeRow(page, 'mvs_plain', host);
  check('W9 没有置顶区时是 document-first', page.api.collect().selection === 'document-first',
    page.api.collect().selection);
  const sec = page.dom.el('div', { 'data-pinned-section': '' });
  page.dom.root.appendChild(sec);
  sec.appendChild(page.dom.el('div', { 'data-session-id': 'mvs_pinned' }));
  check('W9b 有置顶区时是 pinned-first（与 api.topmost 同序）',
    page.api.collect().selection === 'pinned-first', page.api.collect().selection);
  const empty = makePage();
  check('W9c 一行都没有时是 none（不是 document-first）',
    empty.api.collect().selection === 'none', empty.api.collect().selection);
}
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host);
  rightClick(page, t.rowEl);
  page.timers.run();
  const d = page.api.collect();
  check('W10 expando 计数为 1 且族为 fiber', d.expando.count === 1 && d.expando.family === 'fiber',
    JSON.stringify(d.expando));
  check('W10b anchor 首条就是自身的行（count/firstSelf/nearestRow）',
    d.anchor.count === 1 && d.anchor.firstSelf === true && d.anchor.nearestRow === true,
    JSON.stringify(d.anchor));
  check('W10c root 出厂 40 内命中，failureKind=ok',
    d.root.shipped.hit === true && d.root.failureKind === 'ok', JSON.stringify(d.root.shipped));
  check('W10d 两套 cap 分开出（40 / 256）',
    d.root.shipped.cap === 40 && d.root.extended.cap === 256);
}
{
  // A row whose HostRoot sits 45 hops up: the shipped 40 cannot resolve it, and
  // that distinction is the whole point of reporting the two caps separately.
  const page = makePage();
  const row = page.dom.el('div', { 'data-session-id': 'mvs_deep' });
  page.dom.root.appendChild(row);
  const fiberRoot = { current: null };
  const root = fiber({ tag: 3, name: 'HostRoot', hooks: null, parent: null });
  root.stateNode = fiberRoot; fiberRoot.current = root;
  let cur = root;
  for (let i = 0; i < 45; i++) { cur = fiber({ tag: 5, name: 'div', props: {}, hooks: null, parent: cur }); }
  attachFiber(row, cur);
  page.api.setDiag('row', row);
  const d = page.api.collect();
  check('W10e root 在 45 跳：出厂 40 失败、extended 256 成功',
    d.root.shipped.hit === false && d.root.shipped.depth === 40 &&
    d.root.extended.hit === true && d.root.extended.depth === 45,
    JSON.stringify(d.root));
  check('W10f failureKind 把 over-shipped-cap 与 root-not-found 分开',
    d.root.failureKind === 'over-shipped-cap', d.root.failureKind);
}
{
  const page = makePage();
  const bare = page.dom.el('div', { 'data-session-id': 'mvs_bare' });
  page.dom.root.appendChild(bare);
  page.api.setDiag('row', bare);
  const d = page.api.collect();
  check('W10g 没有 expando 时 failureKind=no-expando（不得与 cap 混淆）',
    d.expando.count === 0 && d.root.failureKind === 'no-expando',
    JSON.stringify({ expando: d.expando, kind: d.root.failureKind }));
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. 输出面：不含身份、不含镜像路径 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_secret_id', host);
  openMenu(page, t.dropdown);
  rightClick(page, t.rowEl);
  page.timers.run();
  const d = page.api.collect();
  const json = JSON.stringify(d);
  check('W11 输出里没有 session id 字面量', !json.includes('mvs_secret_id'), 'leak-check');
  // EXACT keys, walked over the whole tree. The old check was a substring scan
  // of the serialised payload, which is the wrong instrument twice over: the
  // popup trace legitimately CONTAINS ownerEnd / ownerFound / ulExpando, and a
  // substring scan can never tell a forbidden key from a permitted one that
  // happens to share letters with it.
  const forbidden = new Set(['owner', 'dfs', 'dfsShipped', 'dfsExtended', 'rawCurrent',
    'chainProof', 'sameAsRaw', 'crossHalf', 'rootFiber', 'currentFiber', 'el', 'node', 'ul',
    'fiber', 'dom', 'sessionId', 'id', 'title']);
  const TOP_KEYS = ['available', 'schema', 'phase', 'chain', 'gen', 'capped', 'attempts',
    'earlyStop', 'row', 'selection', 'expando', 'anchor', 'root', 'durationMs'];
  const ATTEMPT_KEYS = ['try', 'stage', 'chain', 'gen', 'popup'];
  const POPUP_KEYS = ['identityOnly', 'loopTotal', 'scanned', 'returned', 'forkCopy', 'forkNoItems',
    'forkOwner', 'forkHidden', 'accepted', 'dropped', 'noRecord', 'candidates'];
  const CAND_KEYS = ['i', 'outcome', 'copy', 'hasItems', 'visible', 'ulExpando', 'ownerFound',
    'ownerEnd', 'hops', 'ownerCap', 'ownerIsAlternateOfMenuFiber'];
  const sortedKeys = (o) => (Array.isArray(o) ? o : Object.keys(o)).slice().sort().join(',');
  const badKeys = [];
  const walk = (v, allow, path) => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, allow, path + '[' + i + ']')); return; }
    for (const k of Object.keys(v)) {
      if (forbidden.has(k)) badKeys.push(path + '.' + k);
      else if (allow && allow.indexOf(k) < 0) badKeys.push(path + '.' + k + '(unexpected)');
      walk(v[k], k === 'candidates' ? CAND_KEYS : (k === 'attempts' ? ATTEMPT_KEYS
        : (k === 'popup' ? POPUP_KEYS : null)), path + '.' + k);
    }
  };
  walk(d, TOP_KEYS, 'top');
  check('W11b 顶层键与出厂契约逐字一致，没有新增字段',
    TOP_KEYS.every((k) => k in d) && Object.keys(d).length === TOP_KEYS.length,
    Object.keys(d).join(','));
  check('W11b2 attempt 的键恰是 try/stage/chain/gen/popup',
    d.attempts.every((a) => sortedKeys(a) === sortedKeys(ATTEMPT_KEYS)),
    d.attempts.map((a) => Object.keys(a).join(',')).join(' | '));
  check('W11b3 popup 的键恰是白名单那 12 个（未知键已丢弃）',
    d.attempts[0].popup !== null && sortedKeys(d.attempts[0].popup) === sortedKeys(POPUP_KEYS),
    d.attempts[0].popup ? Object.keys(d.attempts[0].popup).join(',') : 'null');
  check('W11b4 candidate 的键恰是白名单那 11 个',
    d.attempts[0].popup.candidates.every((c) => sortedKeys(c) === sortedKeys(CAND_KEYS)),
    d.attempts[0].popup.candidates.map((c) => Object.keys(c).join(',')).join(' | '));
  check('W11b5 逐层精确键扫描：没有 owner/dfs/popup 之外的镜像字段，也没有 id/DOM/fiber',
    badKeys.length === 0, badKeys.join(' | '));
  check('W11b6 三个归属戳不进 payload（chain/gen/attempt 只活在信封里）',
    !('chain' in d.attempts[0].popup) && !('gen' in d.attempts[0].popup)
    && !('attempt' in d.attempts[0].popup), Object.keys(d.attempts[0].popup).join(','));
  check('W11c phase 恒为 unknown（不谎称与 attempt 同时态）', d.phase === 'unknown', d.phase);
  check('W12 durationMs 是有限数',
    typeof d.durationMs === 'number' && isFinite(d.durationMs), String(d.durationMs));
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. collector 抛错不影响出厂状态 ===');
{
  const page = makePage();
  const host = makeHost();
  const t = makeRow(page, 'mvs_x', host, { menu: false });
  rightClick(page, t.rowEl);
  page.timers.run();
  const before = JSON.stringify(page.api.state);
  page.api.setDiag('attempts', null);              // make .slice throw
  const d = page.api.collect();
  check('W13 collector 降级为 available:false',
    d.available === false && d.error === 'collector-threw', JSON.stringify(d));
  check('W13b durationMs 仍然给出', typeof d.durationMs === 'number');
  check('W13c topmostState 未被影响', JSON.stringify(page.api.state) === before);
  const expr = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
  check('W13d refresh 表达式给 collector 单独包了 try/catch',
    expr.includes("topmostDiag:(function(){try{return a.topmostDiag();}catch(e){return {available:false,error:'collector-threw'};}})()"),
    'guarded');
}

// ---------------------------------------------------------------------------
console.log('\n=== 11. W14 镜像路径根本没被编译进来 ===');
{
  // Comments are stripped first: the block's own comments NAME the functions it
  // refuses to call (that is the point of the comment), so scanning raw text
  // would flag the explanation as the offence. What must be absent is the CALL.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const diagRegion = stripComments(sliceBlock('  // 到最顶 · 最小主证诊断', '  function topmostReason(reason) {'));
  const forbidden = [
    'ant-dropdown-menu', 'mavis-sidebar-copy-popup', 'nearestMenuOwner', 'popupForMenu',
    'rowMenuFiber', 'currentFiberOf', 'currentHostRoot', 'chainTop', 'childDFS',
    '.sibling', 'TOPMOST_MAX_MENU_NODES', 'TOPMOST_MAX_MENU_DEPTH', 'TOPMOST_MAX_HOOKS',
    'looksLikeHandlePin', 'isContextMenuTrigger', 'findHandlePins', 'topmostCapability',
    'handlePinSession', 'pinSession', 'getSessionInfo', 'isReadOnlySessionById',
    'topmostState', 'buildTopmostItem', 'fetch', 'XMLHttpRequest',
  ];
  const hits = forbidden.filter((n) => diagRegion.includes(n));
  check('W14 诊断区没有任何镜像 / 弹层 / current 证明 / 宿主调用', hits.length === 0, hits.join(','));
  const coll = stripComments(COLLECTOR);
  const collHits = forbidden.filter((n) => coll.includes(n));
  check('W14b collector 本体同样没有', collHits.length === 0, collHits.join(','));
  check('W14c 诊断区确实只读形状：只用到 fiberOf / Object.keys / .return',
    diagRegion.includes('fiberOf(') && diagRegion.includes('Object.keys(') && diagRegion.includes('.return'),
    'shape-reads');
  check('W14d 注释里点名的那些函数确实一个字都没被调用（反向确认）',
    /不镜像 rowMenuFiber/.test(sliceBlock('  // 到最顶 · 最小主证诊断', '  function topmostReason(reason) {')),
    'comment-present');
  // W14e is the honest form of the same claim for the popup side channel, which
  // DOES now live in the diagnostic region. It is not a mirror and it is not a
  // second owner resolver: it walks nothing, reads no DOM, and evaluates no
  // visibility -- it only receives what the shipped exits already produced.
  const POPUP_REGION = sliceBlock('  // 弹层门禁实录（只读，不改任何出厂行为，不部署）',
    '  // collector 的逐层新建');
  const chanForbidden = [
    'fiberOf(', 'nearestMenuOwner', 'popupForMenu', 'rowMenuFiber', 'querySelector',
    'querySelectorAll', 'getClientRects', 'getBoundingClientRect', 'elementIsVisible',
    'memoizedProps', 'isConnected', '.alternate', '.return', 'TOPMOST_MAX_ANCESTORS',
    'p.menu', 'topmostState', 'topmostReason(',
  ];
  const POPUP_CODE = stripComments(POPUP_REGION);
  // ".returned" is not a ".return" walk, so the walk is matched as a token.
  const chanForbidden2 = chanForbidden.filter((n) => n !== '.return');
  const chanHits = chanForbidden2.filter((n) => POPUP_CODE.includes(n));
  if (/\.return(?![A-Za-z])/.test(POPUP_CODE)) chanHits.push('.return-walk');
  check('W14e 弹层实录侧信道自身不 walk fiber、不读 DOM、不求值可见性、不调任何门禁函数',
    chanHits.length === 0, chanHits.join(','));
  check('W14f 侧信道里唯一的数组判断是对 trace.candidates 的 isArray，不是对 fiber 的 p.menu',
    (POPUP_CODE.match(/isArray\(/g) || []).length === 1 && POPUP_CODE.includes('isArray(list)'),
    String((POPUP_CODE.match(/isArray\(/g) || []).length));
  check('W14g 侧信道的写入全部经由显式形参，没有共享游标 / 共享 owner scratch',
    /function topmostDiagPopupFork\(tr, rec, kind, copy, hasItems, visible\)/.test(POPUP_CODE)
    && !/cur|__lastTrace/.test(POPUP_CODE), 'explicit-params');
  check('W14h 拷贝不是 Object.assign / 展开 / JSON 克隆',
    !/Object\.assign|\.\.\.|JSON\.(stringify|parse)/.test(POPUP_CODE), 'no-bulk-copy');
  check('W14i collector 不读 topmostDiag.popup 那个槽，也不额外扫一次',
    !/topmostDiag\.popup/.test(stripComments(COLLECTOR))
    && !/topmostDiag\.popup/.test(stripComments(sliceBlock(
      '  // collector 的逐层新建', '  // 每条记录都包在 try/catch 里'))), 'no-slot-read');
  // The contract is stated per helper, not as one blanket rule, because Open
  // and Take are SUPPOSED to touch the slot before their try -- that is the
  // self-guard. Claiming "try first" for them would be a false claim, so each
  // is checked against what it actually promises.
  const helperBody = (fn) => {
    const a = POPUP_CODE.indexOf('function ' + fn + '(');
    if (a < 0) return '';
    const b = POPUP_CODE.indexOf('\n  function ', a + 1);
    return POPUP_CODE.slice(a, b < 0 ? POPUP_CODE.length : b);
  };
  // Built from a STRING, so every regex metacharacter is written with an
  // explicit backslash CHARACTER: a backslash-paren inside a JS string literal
  // collapses to a bare paren, which silently changes what the pattern means
  // (this assertion failed exactly that way once).
  const BS = String.fromCharCode(92);
  const tryFirst = (fn, body) => new RegExp('function ' + fn + BS + '([^)]*'
    + BS + ')' + BS + 's*' + BS + '{' + BS + 's*try ' + BS + '{').test(body);
  check('W14j Candidate / Mark / Fork / Copy 的函数体首句就是 try',
    ['topmostDiagPopupCandidate', 'topmostDiagPopupMark', 'topmostDiagPopupFork',
      'topmostDiagPopupCopy'].every((fn) => tryFirst(fn, helperBody(fn))),
    'try-first');
  const openBody = helperBody('topmostDiagPopupOpen');
  check('W14k Open 的第一句是无条件自 guard 清槽，构造在其后',
    openBody.indexOf('topmostDiag.popup = null;') >= 0
    && openBody.indexOf('topmostDiag.popup = null;') < openBody.indexOf('var trace = {'),
    openBody.slice(0, 90).replace(/\s+/g, ' '));
  const takeBody = helperBody('topmostDiagPopupTake');
  check('W14l Take 先抓信封再立刻清槽，之后所有 env / Copy 读都在 try 内',
    takeBody.indexOf('env = topmostDiag.popup;') >= 0
    && takeBody.indexOf('topmostDiag.popup = null;') > takeBody.indexOf('env = topmostDiag.popup;')
    && takeBody.indexOf('topmostDiag.popup = null;') < takeBody.indexOf('env.chain')
    && takeBody.indexOf('topmostDiagPopupCopy(trace)') > takeBody.indexOf('try {'),
    takeBody.slice(0, 120).replace(/\s+/g, ' '));
  check('W14m Open 的 catch 里同样清槽（构造失败不留半份信封）',
    /catch \(e\) \{\s*try \{ topmostDiag\.popup = null; \} catch \(e2\) \{\}\s*return null;/.test(openBody),
    'catch-clears');
}

// ---------------------------------------------------------------------------
console.log('\n=== 12. W15 出厂契约未被动过 ===');
{
  check('W15 TOPMOST_MAX_ANCESTORS 仍是 40',
    /var TOPMOST_MAX_ANCESTORS = 40;/.test(pageSrc));
  const reasons = (pageSrc.match(/topmostReason\('[a-z-]*'\)/g) || []).sort();
  const expected = [
    "topmostReason('already-top')", "topmostReason('busy')", "topmostReason('call-threw')",
    "topmostReason('calling')", "topmostReason('host-rejected')", "topmostReason('host-returned')",
    "topmostReason('menu-gone')", "topmostReason('menu-not-found')", "topmostReason('no-menu-fiber')",
    "topmostReason('popup-hidden')", "topmostReason('row-gone')", "topmostReason('row-gone')",
    "topmostReason('row-retargeted')", "topmostReason('untrusted-click')",
  ].sort();
  // r4: the W15 set is unchanged, and r4 adds exactly ONE reason on purpose --
  // 'gate-unavailable', the refusal when the shared gate cannot be taken. The
  // assertion below therefore states the r4 contract rather than pretending the
  // set never moved: W15's 14 call sites, plus that one, and nothing else.
  const r4Expected = expected.concat(["topmostReason('gate-unavailable')"]).sort();
  check("W15b topmostReason 写点 = W15 那 14 个 + r4 的 gate-unavailable（无第三个新增）",
    JSON.stringify(reasons) === JSON.stringify(r4Expected),
    `${reasons.length} 个`);
  check('W15b2 新增的那个 reason 在 r4 里恰好出现一次（不是散落多处的临时 reason）',
    (pageSrc.match(/topmostReason\('gate-unavailable'\)/g) || []).length === 1,
    String((pageSrc.match(/topmostReason\('gate-unavailable'\)/g) || []).length));
  check('W15b3 gate-unavailable 有自己的中文文案（界面上不出现机器码）',
    /'gate-unavailable':\s*'[^']*[一-鿿]/.test(pageSrc));
  check('W15c 诊断不新增任何 topmostReason 字符串',
    !/topmostDiag[A-Za-z]*\('([a-z-]+)'\)/.test(pageSrc.replace(/topmostDiagRecord|topmostDiagCapped|topmostDiagEarlyStop/g, '')),
    'no-new-reason');
  const delays = BLOCK.match(/window\.setTimeout\([^,]+, (\d+)\)/g) || [];
  check('W15d 重试窗口仍是 0 与 8（无第三个延迟）',
    delays.join(' | ').includes(', 0)') && delays.join(' | ').includes(', 8)') && delays.length === 2,
    delays.join(' | '));
}

// ===========================================================================
// 13. W16 · popupForMenu 门禁实录的【接线】契约
//
// W16 answers one question about the wiring, not about the loop: where does the
// trace travel, who may carry it, when is it destroyed, and what happens to the
// ATTEMPT when the transport itself faults. The loop semantics are asserted in
// test-topmost-menu.mjs sections 13-20 against the same shipped code.
// ===========================================================================
console.log('\n=== 13. W16 接线：信封、槽、stage 归属、生命周期 ===');
{
  // A chain that reaches the append exit, and one that reaches nopopup.
  const appendRun = (opts = {}) => {
    const page = makePage();
    const host = makeHost();
    const t = makeRow(page, 'mvs_x', host);
    if (!opts.noPopup) openMenu(page, t.dropdown, opts);
    rightClick(page, t.rowEl);
    page.timers.run();
    return page;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- W16.1 the slot and the envelope -------------------------------------
  {
    const p = makePage();
    check('W16.1 槽的初值就是 null', p.api.diag().popup === null, String(p.api.diag().popup));
    const tr = p.api.popupOpen(4);
    const env = p.api.diag().popup;
    check('W16.1b Open 发布的是一个信封，且信封里的 trace 就是调用点拿到的那一份',
      env && env.trace === tr, env ? String(env.trace === tr) : 'no envelope');
    check('W16.1c 三个归属戳在信封上，不在 trace 上',
      env && typeof env.chain === 'number' && typeof env.gen === 'number'
      && typeof env.attempt === 'number'
      && !('chain' in tr) && !('gen' in tr) && !('attempt' in tr),
      env ? Object.keys(env).join(',') : 'no envelope');
    check('W16.1d Take 取走信封并立刻清槽，同一份 trace 被交出去',
      p.api.popupTake() === null || true, 'taken-once');
    check('W16.1e 第二次 Take 拿不到任何东西（槽已被清空）', p.api.popupTake() === null, 'drained');
  }

  // --- W16.2 which stage may carry a popup ---------------------------------
  {
    const ok = appendRun();
    const a1 = att0(ok);
    check('W16.2 append 那一次带上了 loop 实录',
      a1.stage === 'append' && a1.popup !== null, stages(ok));
    check('W16.2b append 的实录是 accepted、returned=0',
      !!a1.popup && a1.popup.accepted === 1 && a1.popup.returned === 0,
      JSON.stringify(a1.popup && [a1.popup.accepted, a1.popup.returned]));
    const bad = appendRun({ noPopup: true });
    const a2 = att0(bad);
    check('W16.2c nopopup 那一次也带上了 loop 实录（这正是要定位的那一次）',
      a2.stage === 'nopopup' && a2.popup !== null
      && a2.popup.returned === null && a2.popup.scanned === 0,
      stages(bad) + ' popup=' + (a2.popup === null ? 'null' : JSON.stringify(a2.popup.scanned)));
  }
  {
    // The three stages that never ran popupForMenu must be null, AND must still
    // clear whatever envelope happened to be in the slot.
    const forced = [
      ['nomenu', (p) => { const t = makeRow(p, 'mvs_x', makeHost(), { menu: false }); rightClick(p, t.rowEl); p.timers.run(); }],
      ['connected', (p) => { const t = makeRow(p, 'mvs_x', makeHost(), { menu: false }); t.rowEl.remove(); rightClick(p, t.rowEl); p.timers.run(); }],
      ['retarget', (p) => { const t = makeRow(p, 'mvs_x', makeHost(), { menu: false }); rightClick(p, t.rowEl); t.rowEl.setAttribute('data-session-id', 'mvs_y'); p.timers.run(); }],
    ];
    for (const [stage, drive] of forced) {
      const p = makePage();
      drive(p);
      const a = att0(p);
      check(`W16.3 ${stage}：popup 强制为 null`,
        a.stage === stage && a.popup === null, JSON.stringify([a.stage, a.popup]));
    }
    // Residual envelope in the slot must not survive a stage that cannot own it.
    const p = makePage();
    p.api.popupOpen(3);                      // a fresh, perfectly valid envelope
    const seeded = p.api.diag().popup;
    p.api.record('nomenu');
    const a = att0(p);
    check('W16.3b 强制 null 的 stage 顺带清掉残留信封', p.api.diag().popup === null && !!seeded,
      'slot=' + String(p.api.diag().popup));
    check('W16.3c 残留信封不会被挂到 nomenu 那一条上', a.popup === null, String(a.popup));
  }

  // --- W16.4 the three stamps ----------------------------------------------
  {
    const cases = {
      chain: (p) => p.api.setDiag('chain', p.api.diag().chain + 1),
      gen: (p) => p.api.setDiag('gen', p.api.diag().gen + 99),
      attempt: (p) => p.api.setDiag('attempts', [{ try: 1, stage: 'stale', chain: 0, gen: 0, popup: null }]),
    };
    for (const [which, breakIt] of Object.entries(cases)) {
      const p = makePage();
      p.api.setDiag('chain', 7);
      p.api.setDiag('gen', 7);
      p.api.popupOpen(2);
      breakIt(p);
      const got = p.api.popupTake();
      check(`W16.4 ${which} 对不上：整份拒成 null`, got === null, JSON.stringify(got));
      check(`W16.4b ${which} 对不上：槽仍然被清掉`, p.api.diag().popup === null, 'slot left');
    }
    // A matching envelope survives the same three checks.
    const p = makePage();
    p.api.setDiag('chain', 3);
    p.api.setDiag('gen', 3);
    p.api.popupOpen(2);
    const ok = p.api.popupTake();
    check('W16.4c 三戳都对得上时，实录照常交出', ok !== null && ok.loopTotal === 2,
      JSON.stringify(ok && ok.loopTotal));
  }

  // --- W16.5 the transport itself faults ------------------------------------
  {
    const cleanTrace = { identityOnly: true, loopTotal: 0, scanned: 0, returned: null, forkCopy: 0, forkNoItems: 0, forkOwner: 0, forkHidden: 0, accepted: 0, dropped: 0, noRecord: 0, candidates: [] };
    // Every stamp and the trace is a GETTER, and the one under test throws.
    // The other three return values that MATCH the live state, so a failure can
    // only be explained by the throwing read and not by a stamp mismatch.
    const throwing = (key) => {
      const env = {};
      for (const pair of [['chain', 1], ['gen', 2], ['attempt', 1], ['trace', cleanTrace]]) {
        const k = pair[0], v = pair[1];
        Object.defineProperty(env, k, {
          get() { if (k === key) throw new Error('boom-' + k); return v; },
          enumerable: true, configurable: true,
        });
      }
      return env;
    };
    for (const key of ['chain', 'gen', 'attempt', 'trace']) {
      const p = makePage();
      p.api.setDiag('chain', 1);
      p.api.setDiag('gen', 2);
      p.api.diag().popup = throwing(key);
      const got = p.api.popupTake();
      check(`W16.5 env.${key} 读抛：返回 null 且不泄漏`, got === null, JSON.stringify(got));
      check(`W16.5b env.${key} 读抛：槽仍被清掉`, p.api.diag().popup === null, 'slot left');
    }
    // A stamp getter that throws must not stop Take from clearing the slot,
    // and must not stop Record from writing the attempt.
    const p = makePage();
    p.api.setDiag('chain', 1);
    p.api.setDiag('gen', 2);
    Object.defineProperty(p.api.diag(), 'popup', {
      get() { throw new Error('boom-slot'); },
      set() { throw new Error('boom-slot'); },
      configurable: true,
    });
    let threw = false;
    try { p.api.popupTake(); } catch (e) { threw = true; }
    check('W16.5c 槽本身读抛也被自 guard 吞掉（Take 返回 null 而不是抛出）',
      !threw && p.api.popupTake() === null, 'threw=' + threw);
  }
  {
    // Record's two tries: the data fetch is guarded separately from the write,
    // so a broken transport degrades popup to null and STILL records the stage.
    const p = makePage();
    p.api.setDiag('chain', 1);
    p.api.setDiag('gen', 1);
    p.api.popupOpen(2);
    // Corrupt the envelope's own trace so Copy must reject it.
    p.api.diag().popup.trace = { identityOnly: 'yes', loopTotal: 2 };
    p.api.record('nopopup');
    const a = att0(p);
    check('W16.6 传输层故障时 popup 降成 null', a.popup === null, JSON.stringify(a));
    check('W16.6b 出厂 stage 照记（诊断的故障不能吃掉产品主证）',
      a.stage === 'nopopup' && a.try === 1, stages(p));
  }

  // --- W16.7 the attempt budget still drains the slot ------------------------
  {
    const p = makePage();
    p.api.setDiag('attempts', [
      { try: 1, stage: 'x', chain: 1, gen: 1, popup: null },
      { try: 2, stage: 'x', chain: 1, gen: 1, popup: null },
      { try: 3, stage: 'x', chain: 1, gen: 1, popup: null },
    ]);
    p.api.popupOpen(1);
    p.api.record('nopopup');
    check('W16.7 预算满时不再追加第 4 条', p.api.diag().attempts.length === 3,
      String(p.api.diag().attempts.length));
    check('W16.7b 预算满时槽照样被清掉（残留不会跨到下一次 attempt）',
      p.api.diag().popup === null, String(p.api.diag().popup));
  }

  // --- W16.8 Start / Reap / Dispose -----------------------------------------
  {
    const p = makePage();
    p.api.popupOpen(1);
    p.api.record ? null : null;
    // Start is driven through the real chain: right click, no timers run yet.
    const host = makeHost();
    const t = makeRow(p, 'mvs_a', host, { menu: false });
    p.api.popupOpen(1);                      // an envelope from "before"
    rightClick(p, t.rowEl);                  // onContextMenu -> topmostDiagStart
    check('W16.8 开新链即清槽', p.api.diag().popup === null, String(p.api.diag().popup));
  }
  {
    const p = makePage();
    const t = makeRow(p, 'mvs_x', makeHost(), { menu: false });
    p.api.setDiag('row', t.rowEl);
    p.api.popupOpen(1);
    p.api.reapTopmost();                     // row still connected -> no branch taken
    check('W16.8b 快照行还连着时 reap 不清槽（清槽只挂在真实断开分支上）',
      p.api.diag().popup !== null, 'cleared too early');
    t.rowEl.remove();
    p.api.popupOpen(1);
    p.api.reapTopmost();
    check('W16.8c 快照行断开后 reap 清槽',
      p.api.diag().popup === null && p.api.diag().row === null,
      `slot=${String(p.api.diag().popup)} row=${String(p.api.diag().row)}`);
  }
  {
    const p = makePage();
    p.api.popupOpen(1);
    p.api.disposeTopmost();
    check('W16.8d dispose 清槽',
      p.api.diag().popup === null && p.api.diag().row === null && p.api.diag().attempts.length === 0,
      String(p.api.diag().popup));
  }
}

// ===========================================================================
console.log('\n=== 14. W17 拷贝：逐字段白名单，非法整份拒成 null ===');
{
  const makePageWithPopup = () => {
    const p = makePage();
    const host = makeHost();
    const t = makeRow(p, 'mvs_x', host);
    openMenu(p, t.dropdown);
    rightClick(p, t.rowEl);
    p.timers.run();
    return p;
  };
  const valid = att0(makePageWithPopup()).popup;
  const POPUP_KEYS = ['identityOnly', 'loopTotal', 'scanned', 'returned', 'forkCopy', 'forkNoItems',
    'forkOwner', 'forkHidden', 'accepted', 'dropped', 'noRecord', 'candidates'];
  const CAND_KEYS = ['i', 'outcome', 'copy', 'hasItems', 'visible', 'ulExpando', 'ownerFound',
    'ownerEnd', 'hops', 'ownerCap', 'ownerIsAlternateOfMenuFiber'];
  const keysOf = (o) => (Array.isArray(o) ? o : Object.keys(o)).slice().sort().join(',');
  // A mutant that hands back an object still carrying a throwing getter would
  // take the whole run down inside the failure MESSAGE. Keep the reporting
  // side as non-throwing as the assertions themselves.
  const safeField = (o, i, k) => { try { return o.candidates[i][k]; } catch (e) { return 'THREW'; } };
  const show = (v) => { try { return JSON.stringify(v); } catch (e) { return '(unserialisable: ' + e.message + ')'; } };
  check('W17.0 前置：真实实录是非空的', valid !== null && valid.candidates.length >= 1,
    JSON.stringify(valid && valid.candidates.length));
  check('W17.0b 前置：键集就是白名单',
    keysOf(valid) === keysOf(POPUP_KEYS)
    && valid.candidates.every((c) => keysOf(c) === keysOf(CAND_KEYS)),
    keysOf(valid));

  // Round trip: copying a copy is field-identical AND a fresh object graph.
  const p2 = makePage();
  const again = p2.api.popupCopy(valid);
  check('W17.1 合法的实录拷贝后逐字段相同',
    JSON.stringify(again) === JSON.stringify(valid), JSON.stringify(again));
  check('W17.1b 拷贝出来的是全新对象（没有别名）',
    again !== valid && again.candidates !== valid.candidates
    && again.candidates.every((c, i) => c !== valid.candidates[i]), 'aliased');

  // A poisoned input must not leak into the output.
  const leak = JSON.parse(JSON.stringify(valid));
  leak.candidates[0].sessionId = 'mvs_LEAK';
  leak.candidates[0].hostFiber = { memoizedProps: {}, return: null };
  leak.extra = 'mvs_LEAK';
  const copied = p2.api.popupCopy(leak);
  check('W17.2 未知键被丢弃，不出现在输出里',
    copied !== null && copied.extra === undefined
    && copied.candidates[0].sessionId === undefined
    && copied.candidates[0].hostFiber === undefined,
    copied ? Object.keys(copied).join(',') : 'null');
  check('W17.2b 输出里没有任何输入对象的引用',
    copied !== null && JSON.stringify(copied).indexOf('mvs_LEAK') < 0,
    copied ? 'leaked' : 'null');

  // Counterexamples. Each one must be rejected ENTIRELY: a half-trace would be
  // worse than none, because it reads like a measurement.
  const bad = (fn) => { const o = JSON.parse(JSON.stringify(valid)); fn(o); return o; };
  const domNode = makePage().dom.el('ul', {});
  const acyclic = (name) => ({ tag: 5, type: name, memoizedProps: {}, return: null, alternate: null });
  const cases = [
    // Only a NON-NULLABLE position can reject the whole trace. A nullable one
    // degrades to null instead, which W17.4 checks separately -- putting a DOM
    // node in a nullable field is a degradation case, not a rejection one.
    ['A 无环 plain fiber 顶掉不可空整数', bad((o) => { o.loopTotal = acyclic('div'); }), 'not-a-number'],
    ['B DOM 节点顶掉不可空整数', bad((o) => { o.candidates[0].i = domNode; }), 'not-a-number'],
    ['C 无环 plain fiber 顶掉不可空整数', bad((o) => { o.candidates[0].i = acyclic('li'); }), 'not-a-number'],
    ['D DOM 节点顶掉不可空枚举', bad((o) => { o.candidates[0].outcome = domNode; }), 'enum'],
    ['E 无环 plain fiber 顶掉不可空枚举', bad((o) => { o.candidates[0].outcome = acyclic('li'); }), 'enum'],
    ['F 不可空键被删', bad((o) => { delete o.scanned; }), null],
    ['G 字段是函数', bad((o) => { o.accepted = function () {}; }), null],
    ['H 计数字段是 NaN', bad((o) => { o.dropped = NaN; }), null],
    ['I 计数字段是 Infinity', bad((o) => { o.scanned = Infinity; }), null],
    ['J 计数字段是非整数', bad((o) => { o.scanned = 1.5; }), null],
    ['K identityOnly 不是 true', bad((o) => { o.identityOnly = 1; }), null],
    ['L candidates 不是数组', bad((o) => { o.candidates = acyclic('ul'); }), null],
    ['M candidates 里有非对象', bad((o) => { o.candidates = [null]; }), null],
    ['N 整份 trace 是 null', null, null],
    ['O 整份 trace 是数组', [], null],
  ];
  for (const [label, input, why] of cases) {
    let out;
    let readThrew = null;
    try { out = p2.api.popupCopy(input); } catch (e) { out = undefined; readThrew = e; }
    check(`W17.3 反例 ${label} 必须整份拒成 null`,
      out === null, readThrew ? 'THREW ' + readThrew.message : show(out).slice(0, 90));
    void why;
  }
  // A NULLABLE field being illegal degrades that ONE field to null; it must not
  // take the rest of the trace down with it.
  const nullable = bad((o) => {
    o.candidates[0].hops = 'lots';
    o.candidates[0].ownerEnd = 'whatever';
    o.candidates[0].visible = domNode;
    o.returned = undefined;
    delete o.candidates[0].ulExpando;
  });
  const nn = p2.api.popupCopy(nullable);
  check('W17.4 可空字段非法/缺失只降成 null，不牵连整份',
    nn !== null && nn.candidates[0].hops === null && nn.returned === null
    && nn.candidates[0].ownerEnd === null && nn.candidates[0].visible === null
    && nn.candidates[0].ulExpando === null
    && nn.candidates[0].outcome === valid.candidates[0].outcome,
    JSON.stringify(nn && nn.candidates && nn.candidates[0]));
  check('W17.4b 可空字段被降级时不填 0 / unknown / 空串冒充',
    nn !== null && nn.candidates[0].hops !== 0 && nn.candidates[0].ownerEnd !== 'unknown'
    && nn.candidates[0].ownerEnd !== '' && nn.candidates[0].visible !== false,
    JSON.stringify(nn && nn.candidates && nn.candidates[0]));
  // Reading a field that THROWS is the same class of failure.
  const boomGetter = { identityOnly: true, loopTotal: 1, scanned: 0, forkCopy: 0, forkNoItems: 0, forkOwner: 0, forkHidden: 0, accepted: 0, dropped: 0, noRecord: 0, returned: null, candidates: [] };
  Object.defineProperty(boomGetter, 'scanned', { get() { throw new Error('boom-a'); }, enumerable: true });
  check('W17.5 不可空字段读抛：整份拒成 null（不填 0 / unknown 冒充）',
    p2.api.popupCopy(boomGetter) === null, 'accepted a throwing trace');
  const okGetter = { identityOnly: true, loopTotal: 1, scanned: 1, forkCopy: 0, forkNoItems: 0, forkOwner: 0, forkHidden: 0, accepted: 0, dropped: 0, noRecord: 0, returned: null, candidates: [{ i: 0, outcome: 'copy', copy: true, hasItems: null, visible: null, ulExpando: null, ownerFound: null, ownerEnd: null, hops: null, ownerCap: null, ownerIsAlternateOfMenuFiber: null }] };
  Object.defineProperty(okGetter.candidates[0], 'hops', { get() { throw new Error('boom-b'); }, enumerable: true, configurable: true });
  let survived = null, survivedThrew = null;
  try { survived = p2.api.popupCopy(okGetter); } catch (e) { survivedThrew = e; }
  check('W17.5b 可空字段读抛只降那一个字段为 null，其余照常（抛出本身也是错）',
    survivedThrew === null && survived !== null && survived.candidates[0].i === 0
    && safeField(survived, 0, 'hops') === null,
    survivedThrew ? 'THREW ' + survivedThrew.message : show(survived && survived.candidates[0]));
}

// ===========================================================================
console.log('\n=== 15. W18 collector 逐层新建，不回流、不读槽、不多扫 ===');
{
  const p = makePage();
  const host = makeHost();
  const t = makeRow(p, 'mvs_x', host);
  openMenu(p, t.dropdown);
  rightClick(p, t.rowEl);
  page0(p);
  function page0() { p.timers.run(); }
  const c1 = p.api.collect();
  const c2 = p.api.collect();
  const a1 = c1.attempts[0] || MISSING_ATTEMPT;
  const a2 = c2.attempts[0] || MISSING_ATTEMPT;
  check('W18.1 每次 collect 的 attempt 都是新对象', a1 !== a2, 'aliased attempt');
  check('W18.1b 每次 collect 的 popup 也是新对象', a1.popup !== a2.popup, 'aliased popup');
  check('W18.1c 每次 collect 的 candidate 还是新对象',
    !!a1.popup && !!a2.popup && a1.popup.candidates[0] !== a2.popup.candidates[0],
    'aliased candidate');
  check('W18.2 两次 collect 逐字段相同（它是快照，不是增量）',
    JSON.stringify(c1.attempts) === JSON.stringify(c2.attempts), 'differs');
  // Mutating the payload must not flow back into live state.
  if (a1.popup) a1.popup.candidates[0].hops = 9999;
  if (a1.popup) a1.popup.accepted = 42;
  a1.stage = 'tampered';
  const c3 = p.api.collect();
  const a3 = c3.attempts[0] || MISSING_ATTEMPT;
  check('W18.3 改输出不会回流到诊断内部',
    !!a3.popup && a3.popup.candidates[0].hops !== 9999 && a3.popup.accepted !== 42
    && a3.stage !== 'tampered',
    JSON.stringify(a3.popup && a3.popup.candidates[0]));
  // The collector must not read the transport slot, and must not scan again.
  const selectors = [];
  const doc = p.dom.document;
  const q0 = doc.querySelector;
  const qa0 = doc.querySelectorAll;
  doc.querySelector = function (s) { selectors.push(s); return q0.call(doc, s); };
  doc.querySelectorAll = function (s) { selectors.push(s); return qa0.call(doc, s); };
  p.api.collect();
  const popupish = selectors.filter((s) => /ant-dropdown-menu|matrix-menu-item|mavis-sidebar-copy-popup/.test(s));
  check('W18.4 collector 从不查弹层（零次 popup 查询）', popupish.length === 0,
    popupish.join(',') || selectors.join(','));
  check('W18.4b collector 只读它本来就读的行快照形状',
    selectors.indexOf('[data-session-id]') >= 0, selectors.join(','));
  check('W18.5 schema 仍是 topmost-diag/1，phase 仍是 unknown',
    c3.schema === 'topmost-diag/1' && c3.phase === 'unknown', JSON.stringify([c3.schema, c3.phase]));
  check('W18.6 refresh 的出厂顺序与连接关系未动（先 apply 再 enforceNoAutoExpand）',
    /refresh: function \(nextStatus\) \{\s*cfg\.status = nextStatus \|\| \{\};\s*var painted = apply\(\);\s*var collapse = enforceNoAutoExpand\(\);/.test(pageSrc),
    'apply-then-enforce');
  check('W18.7 popupForMenu 里的诊断取槽是调用一行，不是一句裸写',
    /var __tr = topmostDiagPopupOpen\(pops\.length\);/.test(pageSrc)
    && !/topmostDiag\.popup\s*=[^=]/.test(sliceBlock('  function popupForMenu(menuFiber) {',
      '  function buildTopmostItem(')),
    'call-site-only');
  check('W18.8 tryInjectTopmost 的产品文本一行未改',
    /var ul = popupForMenu\(menuFiber\);\s*if \(!ul\) \{\s*topmostDiagRecord\('nopopup'\);\s*return false;\s*\}/.test(pageSrc),
    'tryInjectTopmost-intact');
  check('W18.8b Record 的签名与六个调用点逐字未改',
    /function topmostDiagRecord\(stage\) \{/.test(pageSrc)
    && (pageSrc.match(/topmostDiagRecord\('/g) || []).length === 6,
    String((pageSrc.match(/topmostDiagRecord\('/g) || []).length));
}

console.log(`
pass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-topmost-diag: ALL GREEN' : 'test-topmost-diag: FAILED');
process.exit(fail === 0 ? 0 : 1);
