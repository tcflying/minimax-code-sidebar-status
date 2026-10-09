// mmx-status :: test-new-pin-adversarial.mjs
//
// ADVERSARIAL counterexamples for one user-visible requirement:
//   「非置顶的会话点了置顶之后落在所有置顶的最后面」——出厂必须把它挪到置顶区最顶。
//
// WHAT THIS FILE IS NOT
//   It is not a state machine of my own. Every assertion below drives the code
//   sliced out of lib/page-script.mjs -- topmostCapability / topmostAutoTopTick /
//   pinnedPromoteTick / hostCallTake -- against the same fake DOM the shipped
//   suite uses, and reads the HOST's own pinned-order array afterwards. The
//   verdict is the resulting ORDER (what the user would see), never "the spy saw
//   three arguments". A call that never lands is a FAIL here even though the
//   spy counted it.
//
//   No CDP, no GUI, no process launch, no temp dir, no DB, no network. The only
//   file read is the production source; nothing in src/ is written.
//
//   Expected value = the requirement's literal index 0 (and, where the two
//   shipped definitions disagree, BOTH numbers are printed: the module's own
//   cap.alreadyTop and the corrector's counter).
//
//   node test-new-pin-adversarial.mjs      # exit 1 when any counterexample holds
//
// Sections A..N are listed in the run output. LIMIT rows are FACTS the shipped
// code exhibits, not verdicts -- they exist where the requirement itself does not
// say which of two pinned members should win, and pretending otherwise would be
// me inventing an ordering policy.

import fs from 'node:fs';
import { makeDom, attachFiber, hookChain, fiber } from './testlib/fake-dom.mjs';

const GATE = '__mmxStatusHostGateV1';

const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}
// The very same slice the shipped suite uses for its menu/auto-top sections, so
// the code under test here is byte-identical to the code that ships.
const BLOCK = sliceBlock("  var TOPMOST_LABEL = '到最顶';", '  var handler = function () { scheduleApply(); };');

let pass = 0;
let fail = 0;
let limit = 0;
function v(name, ok, seq) {
  if (ok) {
    pass++;
    console.log(`  PASS    ${name}  :: ${seq}`);
  } else {
    fail++;
    console.log(`  FAIL    ${name}  :: ${seq}`);
  }
}
function limitRow(name, seq) {
  limit++;
  console.log(`  LIMIT   ${name}  :: ${seq}`);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const ref = (id) => ({ type: 'session', id });
const proj = (id) => ({ type: 'project', id });
const cloneOrder = (o) => o.map((r) => ({ ...r }));
// RAW = the host's own order array, unfiltered, as THIS MODEL holds it. How the
// real sidebar renders a mixed (non-session + session) order is not established
// here, so nothing in this file may be read as a claim about on-screen layout.
// The corrector filters to session rows before it compares, so both views are
// printed everywhere they can differ.
const rawIds = (h) => h.order.map((r) => `${r.type}:${r.id}`).join(',');
const sessIds = (h) => h.order.filter((r) => r.type === 'session').map((r) => r.id).join(',');

function makeTimers() {
  const q = [];
  let id = 0;
  return {
    setTimeout(fn) { const t = { id: ++id, fn }; q.push(t); return t.id; },
    clearTimeout(tid) { const i = q.findIndex((t) => t.id === tid); if (i >= 0) q.splice(i, 1); },
    run() { const batch = q.splice(0, q.length); for (const t of batch) t.fn(); },
    size() { return q.length; },
  };
}

// A REUSED FIXTURE, shaped after the app.asar call site: order -> (await
// getSessionInfo) -> readOnly refusal -> setPinnedItemsOrder -> pinSession. It is
// NOT the real host executing: no real React, no real IPC, no real backend. It
// reproduces the dependency shape and the ordering the shipped selector needs,
// so what these cases prove is the shipped CODE's behaviour against that shape.
// h.fn is NOT async so it can throw SYNCHRONOUSLY (one counterexample needs
// that); every other failure mode is a rejected promise.
function makeHost(opts = {}) {
  const h = {
    order: cloneOrder(opts.order || [ref('mvs_a'), ref('mvs_b')]),
    source: opts.source || 'local',
    calls: [],
    persists: [],
    probes: [],
    rollbacks: 0,
    readOnly: new Set(opts.readOnly || []),
    noop: !!opts.noop,                 // resolves, but never moves the order
    throwLeft: opts.throwFirst || 0,    // synchronous throw, first N calls
    rejectLeft: opts.rejectFirst || 0,  // rejected promise, first N calls
    commitMode: opts.commitMode || 'micro',   // 'micro' | 'timer'
    timers: makeTimers(),
  };
  // What the backend really received, counted from THIS scene's first call, so a
  // record left by an earlier scene can never be read as this one's evidence.
  h.persistBase = PinService.calls.length;
  h.persists = () => PinService.calls.slice(h.persistBase);
  h.deps = [
    (id, src) => { h.probes.push(`${id}@${src}`); return h.readOnly.has(id); },
    h.order,
    h.source,
    {},
    () => {},
    () => {},
    (next) => { scheduleCommit(h, next); },        // setPinnedItemsOrder
  ];
  h.fn = function (e, l, c) {
    h.calls.push([e, l, c]);
    if (h.throwLeft > 0) { h.throwLeft--; h.rollbacks++; throw new Error('host-sync-throw'); }
    return (async () => {
      const info = await SessionInfo.getSessionInfo(e, undefined, h.source);
      // The host's own first statement: readonly is a SILENT return.
      if (h.deps[0](e, h.source)) return;
      if (h.rejectLeft > 0) { h.rejectLeft--; h.rollbacks++; throw new Error('host-reject'); }
      if (h.noop) { PinService.pinSession(e, l, l ? c : undefined, h.source); return; }
      const next = updatePinnedRefs(h.deps[1], { type: 'session', id: e }, l, c);
      h.deps[6](next);
      await PinService.pinSession(e, l, l ? c : undefined, h.source);
      void info;
    })();
  };
  // arity-3 decoy the selector has to reject (no pinSession/getSessionInfo text).
  h.decoy = function (a, b, c2) { return [a, b, c2].length; };
  h.decoyDeps = [() => {}, h.order, h.source, {}, () => {}, () => {}, () => {}];
  return h;
}
const SessionInfo = { getSessionInfo: async (id) => ({ id }) };const PinService = {
  calls: [],
  async pinSession(sessionId, pinned, insertIndex) {
    PinService.calls.push([sessionId, pinned, insertIndex]);
  },
};
function clampInsertIndex(index, max) {
  if (index === undefined || !Number.isFinite(index)) return max;
  return Math.max(0, Math.min(max, Math.trunc(index)));
}
function updatePinnedRefs(refs, item, pinned, insertIndex) {
  const withoutItem = refs.filter((r) => r.type !== item.type || r.id !== item.id);
  if (!pinned) return withoutItem;
  const index = clampInsertIndex(insertIndex, withoutItem.length);
  return [...withoutItem.slice(0, index), item, ...withoutItem.slice(index)];
}
// The host commits and React re-renders into a NEW closure: h.deps[1] is the
// closure's captured order, so it is the only honest way to make a later
// capability read see the committed order.
function commitOrder(h, next) {
  h.order = next.map((r) => ({ ...r }));
  h.deps[1] = h.order;
  h.commits = (h.commits || 0) + 1;
}
function scheduleCommit(h, next) {
  if (h.commitMode === 'timer') { h.timers.setTimeout(() => commitOrder(h, next)); return; }
  Promise.resolve().then(() => Promise.resolve()).then(() => commitOrder(h, next));
}
// Native user actions, i.e. what the HOST does without any of our code.
const nativePin = (h, id) => commitOrder(h, h.deps[1].concat([ref(id)]));
const nativeUnpin = (h, id) => commitOrder(h, h.deps[1].filter((r) => !(r.type === 'session' && r.id === id)));

function makePage(opts = {}) {
  const dom = makeDom();
  const win = { setTimeout: () => 0, clearTimeout: () => {} };
  win.MutationObserver = dom.observers.MutationObserver;
  if (opts.foreignTicket) win[GATE] = { ticket: opts.foreignTicket };
  if (opts.freeze) Object.freeze(win);
  const factory = new Function(
    'window',
    'document',
    'var disposed = false;\n' + BLOCK +
    '\nreturn {' +
    '  cap: function (row) { return topmostCapability(row); },' +
    // autoTick takes an OPTIONAL capability, exactly like the shipped
    // topmostAutoTopTick: passed one, it is used verbatim; omitted, the function
    // resolves one itself. That is what lets Q drive BOTH segments off ONE
    // proven snapshot, the way apply() does.
    '  autoTick: function (c) { return c ? topmostAutoTopTick(c) : topmostAutoTopTick(); },' +
    '  sharedCap: function () { return topmostAutoTopCapability(); },' +
    '  promoteTick: function (c, s) { return pinnedPromoteTick(c, s); },' +
    '  autoState: autoTopState, promoteState: promoteState, lockView: topmostLockView,' +
    '  gateBusy: hostCallBusy, gate: function () { return hostGateState(); },' +
    '  autoKey: TOPMOST_AUTOTOP_KEY, autoMax: TOPMOST_AUTOTOP_MAX,' +
    '  promoteKey: TOPMOST_PROMOTE_KEY, promoteMax: TOPMOST_PROMOTE_MAX,' +
    '  setDisposed: function (x) { disposed = x; } };'
  );
  const api = factory(win, dom.document);
  return { dom, window: win, api };
}
// A sidebar row built the way the host builds it: div[data-session-id] whose
// fiber chain reaches a container hook carrying the real 3-arg/7-dep
// handlePinSession. Only the capability walk is needed here, so the menu half of
// the shipped fixture is left out.
function attachWitness(page, host, id) {
  const rowEl = page.dom.el('div', { 'data-session-id': id });
  const btn = page.dom.el('button', { type: 'button', 'data-shortcut-session-target': id });
  rowEl.appendChild(btn);
  page.dom.root.appendChild(rowEl);
  const fiberRoot = { current: null };
  const rootF = fiber({ tag: 3, name: 'HostRoot', props: null, hooks: null, parent: null });
  rootF.stateNode = fiberRoot;
  const container = fiber({
    name: 'SidebarContainer', props: {},
    hooks: hookChain([[() => {}, [1, 2]], [host.decoy, host.decoyDeps], [host.fn, host.deps], [() => {}, []]]),
    parent: rootF,
  });
  const rowComponent = fiber({ name: 'SessionRow', props: { session: { id } }, hooks: null, parent: container });
  const rowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, hooks: null, parent: rowComponent });
  fiberRoot.current = rootF;
  attachFiber(rowEl, rowDiv);
  attachFiber(btn, fiber({ tag: 5, name: 'button', props: {}, hooks: null, parent: rowComponent }));
  return {
    rowEl,
    cap: () => page.api.cap(rowEl),
    detach: () => rowEl.remove(),
  };
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
// The noop branch has to skip setPinnedItemsOrder ENTIRELY: a host that accepts
// the call and then drops the move is the case, and a commit here would hide it.

// One shipped auto-top pass, and the gate state read SYNCHRONOUSLY right after
// it -- that is the only place the ordering "took the ticket, host still in
// flight" is observable. Then the host's own async work is allowed to finish.
async function step(a) {
  a.p.api.autoTick();
  const busyNow = a.p.api.gateBusy();
  await flush();
  return busyNow;
}
const passes = async (a, n) => { for (let i = 0; i < n; i++) await step(a); };
// The same pass, driven through the OTHER shipped corrector (pinnedPromoteTick).
// It takes the capability for itself when none is handed in, exactly like the
// offline suite does.
async function promoStep(a, status) {
  a.p.api.promoteTick(undefined, status || {});
  await flush();
}
const promoPasses = async (a, status, n) => { for (let i = 0; i < n; i++) await promoStep(a, status); };
// ONE apply() pass in the shipped statement order (page-script.mjs:894-900):
// resolve the capability once, hand that SAME snapshot to the auto corrector,
// then to the promote corrector -- with no await anywhere in between, exactly as
// production writes it. That is what makes the first segment hold the shared gate
// while the second one is still deciding.
async function applyPass(a, status) {
  const cap = a.p.api.sharedCap();
  a.p.api.autoTick(cap);
  a.p.api.promoteTick(cap, status || {});
  const busyNow = a.p.api.gateBusy();
  await flush();
  return busyNow;
}
const applyPasses = async (a, status, n) => { for (let i = 0; i < n; i++) await applyPass(a, status); };
// The same pass, with NOTHING flushed: both segments run back to back off one
// resolved capability, and every number is read while the host call is still in
// flight. This is the only way to observe "auto holds the gate, promote has
// already decided" inside one pass -- a pass that awaits first would have the
// gate released again by the time it returned.
function applyPassSync(a, status) {
  const cap = a.p.api.sharedCap();
  a.p.api.autoTick(cap);
  const autoCallsAfterAuto = a.p.api.autoState.calls;
  const gateBusyAfterAuto = a.p.api.gateBusy();
  a.p.api.promoteTick(cap, status || {});
  return {
    autoCallsAfterAuto,
    gateBusyAfterAuto,
    promoteBlocked: a.p.api.promoteState.blocked,
    promoteReason: a.p.api.promoteState.lastReason,
    callsToB: a.host.calls.filter((x) => x[0] === 'mvs_b').length,
    gateBusyBeforeSettle: a.p.api.gateBusy(),
  };
}
// A fresh scenario: shipped slice + fake DOM + real host + one witness row.
function scene(opts = {}) {
  const p = makePage(opts.page);
  const host = makeHost(opts.host);
  const w = attachWitness(p, host, opts.rowId || 'mvs_a');
  return { p, host, w };
}
const seqOf = (a) => `raw[${rawIds(a.host)}] sess[${sessIds(a.host)}]`;

// ---------------------------------------------------------------------------
// A. Control: the shipped happy path, so every counterexample below is read
//    against a baseline that is known to work.
// ---------------------------------------------------------------------------
console.log('\n=== A. 对照组：稳定基线 + 宿主真实追加一次 ===');
{
  const a = scene();
  await passes(a, 2);                       // arm baseline on [a,b]
  nativePin(a.host, 'mvs_c');               // the user's own 置顶: appended to the tail
  await passes(a, 2);
  v('A.1 新置顶项落到 order[0]（需求字面量 0）',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b' && sessIds(a.host) === 'mvs_c,mvs_a,mvs_b',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)}`);
}

// ---------------------------------------------------------------------------
// B/C/D/E. The "the call did not take, so try again" family.
//
//     These four used to FAIL, and the verdict they exposed was a real one: the
//     shipped corrector advanced the baseline at ATTEMPT time and treated a
//     resolved promise as success, so "the call did not take" silently ate the
//     change. The fix is a sticky pending obligation plus a budget charged per
//     CONFIRMED FAILURE -- still bounded, still one host write per pass, still
//     never retried more than TOPMOST_AUTOTOP_MAX times per target.
//
//     That bound is why E is not a PASS on the order: on E's modelled branch the
//     host itself never moves the order, so no corrector can make the requirement
//     true. See E's own comment.
// ---------------------------------------------------------------------------
// B. The gate is busy ONCE, then released. Requirement: the still-misplaced new
//    member must be corrected on a later pass.
// ---------------------------------------------------------------------------
console.log('\n=== B. 共享闸被别人占着一趟，释放后是否重试 ===');
{
  const a = scene({ page: { foreignTicket: Object.freeze({ held: 'other' }) } });
  await passes(a, 2);
  nativePin(a.host, 'mvs_c');
  await passes(a, 2);
  const blockedAt = a.p.api.autoState.blocked;
  a.p.window[GATE].ticket = null;           // the other instance finishes
  await passes(a, 4);
  v('B.1 闸释放后仍在末尾的那一项补到 order[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b',
    `${seqOf(a)} blocked=${blockedAt} calls=${JSON.stringify(a.host.calls)} lastReason=${a.p.api.autoState.lastReason}`);
}

// ---------------------------------------------------------------------------
// C. The host entry throws SYNCHRONOUSLY once, then behaves.
// ---------------------------------------------------------------------------
console.log('\n=== C. 宿主同步抛异常一次，之后是否重试 ===');
{
  const a = scene({ host: { throwFirst: 1 } });
  await passes(a, 2);
  nativePin(a.host, 'mvs_c');
  await passes(a, 2);
  await passes(a, 4);
  v('C.1 抛异常之后补到 order[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} gateBusy=${a.p.api.gateBusy()} lastReason=${a.p.api.autoState.lastReason}`);
}

// ---------------------------------------------------------------------------
// D. The host entry REJECTS once, then behaves.
// ---------------------------------------------------------------------------
console.log('\n=== D. 宿主 Promise.reject 一次，之后是否重试 ===');
{
  const a = scene({ host: { rejectFirst: 1 } });
  await passes(a, 2);
  nativePin(a.host, 'mvs_c');
  await passes(a, 2);
  await passes(a, 4);
  v('D.1 reject 之后补到 order[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} gateBusy=${a.p.api.gateBusy()} lastReason=${a.p.api.autoState.lastReason}`);
}

// ---------------------------------------------------------------------------
// E. CONDITION MODEL, not an observation about the real host. h.noop is injected
//    by this harness: "the host accepted the three-argument call and then did not
//    move the order". Nothing here proves MiniMax Code has such a branch -- it is
//    a state the module's own code comments treat as possible (a rollback, a
//    dropped update).
//
//    WHY E.1 DOES NOT ASSERT THE ORDER. On this modelled branch the requirement
//    cannot be met by ANY corrector: the host never moves the order, and the only
//    host write entry the shipped module is allowed to use is that one
//    three-argument call (a red line, asserted by 24.16/26.13). An earlier version
//    of this row demanded order[0] here, which was unreachable by construction --
//    it could only ever report FAIL, so it proved nothing about the code. What IS
//    in the corrector's control, and what the ruling actually changed, is its own
//    bookkeeping, and that is asserted instead:
//      1. the change is NOT consumed as a success (no baseline advance, no
//         'landed'), so it stays a pending obligation;
//      2. the budget is charged per CONFIRMED FAILURE, not per attempt -- so the
//         first three passes cost one attempt each and the budget reaches 0 only
//         after three confirmed failures;
//      3. the retry is BOUNDED: exactly TOPMOST_AUTOTOP_MAX writes, then the
//         corrector stops writing for good.
//    The unreachable part stays recorded as E.2, still a LIMIT.
// ---------------------------------------------------------------------------
console.log('\n=== E. Promise 已 resolve 但 order 没有变化 ===');
{
  const a = scene({ host: { noop: true } });
  await passes(a, 2);
  nativePin(a.host, 'mvs_c');
  await passes(a, 2);
  await passes(a, 4);
  const rt = a.p.window[a.p.api.autoKey];
  const st = a.p.api.autoState;
  const max = a.p.api.autoMax;
  v('E.1 resolve 了但没落到 order[0]：不算成功、扣的是确认失败、重试有界',
    rawIds(a.host) === 'session:mvs_a,session:mvs_b,session:mvs_c'
    && st.confirmed === 0 && st.failed === max && st.calls === max
    && rt && rt.budget === 0 && rt.owner === 'mvs_c'
    && st.exhausted >= 1 && st.lastReason === 'budget-exhausted',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} confirms=${st.confirmed} confirmedFailures=${st.failed} budget=${rt ? rt.budget : '-'} exhausted=${st.exhausted} lastReason=${st.lastReason}`);
  limitRow('E.2 「resolve 不等于落位」的确切代价',
    `order 一次没动（这一分支上需求不可能被满足：宿主不改顺序，而我们只有那一个写入口）；纠正器做了 ${st.calls} 次补写、扣掉 ${st.failed} 次确认失败预算之后停写，上限 ${max}`);
}

// ---------------------------------------------------------------------------
// F. No baseline at all: empty view -> first real view -> second.
//
//     Read this as a SIGNAL blind spot, not as a hot-path defect: while the view
//     is empty the corrector cannot prove an order, so it writes nothing and,
//     by design, keeps its baseline. F.2 is the part that matters -- the blind
//     window does not eat a change that arrived during it.
// ---------------------------------------------------------------------------
console.log('\n=== F. 空视图 → 首个真实视图 → 第二次变化 ===');
{
  const a = scene({ host: { order: [] } });
  await passes(a, 2);
  const unproven = a.p.api.autoState.unproven;
  const callsOnEmpty = a.host.calls.length;
  commitOrder(a.host, [ref('mvs_a'), ref('mvs_b')]);
  await passes(a, 2);
  // Snapshot BEFORE the next change: "第一个真实视图只武装基线" is a claim about
  // this moment, not about where the list ends up three passes later.
  const rawAfterArm = rawIds(a.host);
  const callsAfterArm = a.host.calls.length;
  nativePin(a.host, 'mvs_c');
  await passes(a, 2);
  v('F.1 空视图零写；第一个真实视图只武装基线、不动顺序',
    callsOnEmpty === 0 && unproven >= 2 && callsAfterArm === 0
    && rawAfterArm === 'session:mvs_a,session:mvs_b',
    `unproven=${unproven} callsOnEmpty=${callsOnEmpty} callsAfterArm=${callsAfterArm} rawAfterArm[${rawAfterArm}]`);
  v('F.2 之后的真实新增仍然补到 order[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)}`);
}

// ---------------------------------------------------------------------------
// G. Two native pins inside ONE poll. Reported as a LIMIT because the requirement
//    does not say which of the two should end up first, and this suite will not
//    invent that policy. The FACT recorded is narrower and does not need it: only
//    the lowest-index new member is ever a candidate, and the other one is
//    absorbed into the baseline with no further turn -- so at most one of a batch
//    of N new members is corrected per poll, and the rest are never reconsidered.
// ---------------------------------------------------------------------------
console.log('\n=== G. 同一次轮询里新增两项 ===');
{
  const a = scene();
  await passes(a, 2);
  nativePin(a.host, 'mvs_c');
  nativePin(a.host, 'mvs_d');               // two pins, one poll
  await passes(a, 2);
  await passes(a, 4);
  const calls = a.host.calls.length;
  limitRow('G.1 一批新增只发生一次写, 规则是"下标最小的新成员"',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} lastId=${a.p.api.autoState.lastId} noCandidate=${a.p.api.autoState.noCandidate}`);
  limitRow('G.2 后到的那一项此后再无任何机会（已被基线吸收）',
    `raw index of mvs_d = ${a.host.order.findIndex((r) => r.id === 'mvs_d')}，${calls} 次调用，d 从未成为候选`);
}

// ---------------------------------------------------------------------------
// H. Native unpin -> native repin. Not a defect probe: the shipped rule treats a
//    re-pinned member as a brand new member, and that has to keep working.
//    H.1 = the member is GONE in two consecutive samples; H.2 = it is gone in none.
// ---------------------------------------------------------------------------
console.log('\n=== H. 原生取消置顶后重新置顶 ===');
{
  const a = scene({ host: { order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_x')] } });
  await passes(a, 2);
  nativeUnpin(a.host, 'mvs_x');
  await passes(a, 2);
  nativePin(a.host, 'mvs_x');
  await passes(a, 2);
  await passes(a, 2);
  v('H.1 重新置顶的那一项补到 order[0]',
    rawIds(a.host) === 'session:mvs_x,session:mvs_a,session:mvs_b',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)}`);
  // Fast control -- reported as a LIMIT, not as a PASS. Between two samples the
  // unpin AND the re-pin happen, so this corrector never observes the member
  // leaving: the two events have no event source here, the only thing sampled is
  // a membership identical to the baseline. Nothing about the USER's requirement
  // is proven by it; it records that the observation is blind at that cadence, and
  // it is the control that makes H.1 (two samples) meaningful.
  const b = scene({ host: { order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_x')] } });
  await passes(b, 2);
  nativeUnpin(b.host, 'mvs_x');
  nativePin(b.host, 'mvs_x');
  await passes(b, 4);
  limitRow('H.2 单采样内的取消再置顶：事件无来源，采样看不见（不是"行为正确"）',
    `${seqOf(b)} calls=${JSON.stringify(b.host.calls)} lastReason=${b.p.api.autoState.lastReason}；unpin/repin 都落在两次采样之间，只有"成员未变"被观察到`);
}

// ---------------------------------------------------------------------------
// I. A lock intent is in place across two new members, then it is released.
// ---------------------------------------------------------------------------
console.log('\n=== I. 锁顶意图在场期间到达的新成员 ===');
{
  const a = scene();
  await passes(a, 2);
  a.p.api.lockView.id = 'mvs_a';
  nativePin(a.host, 'mvs_c');
  nativePin(a.host, 'mvs_d');
  await passes(a, 2);
  const deferred = a.p.api.autoState.deferred;
  // Sampled BEFORE the lock is released. "Zero host writes while the lock intent
  // is in place" has to be read at that moment -- reading only the counters and
  // the final order afterwards cannot tell a deferred pass from a late write.
  const callsWhileLocked = a.host.calls.length;
  const persistsWhileLocked = a.host.persists().length;
  v('I.1 让位期间零宿主写、零后端落盘（释放前采样）',
    callsWhileLocked === 0 && persistsWhileLocked === 0 && deferred >= 1,
    `callsWhileLocked=${callsWhileLocked} persistsWhileLocked=${persistsWhileLocked} deferred=${deferred} ${seqOf(a)}`);
  a.p.api.lockView.id = '';
  await passes(a, 2);
  await passes(a, 2);
  v('I.2 释放后让位期间到达的那一批仍被补到 order[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b,session:mvs_d',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)}`);
  limitRow('I.3 让位期间到达的第二项与 G 同样被吸收',
    `raw index of mvs_d = ${a.host.order.findIndex((r) => r.id === 'mvs_d')}，它同样从未成为候选`);
}

// ---------------------------------------------------------------------------
// J. The first new member is READ-ONLY and the second one is writable.
//
//    The shipped rule is batch-absorbing: the candidate is the lowest-index new
//    member, and a candidate the probe refuses does NOT eat the rest of the batch
//    -- it is skipped and the next writable candidate in the same batch continues,
//    still inside one host write for that pass.
// J is generalised: it is not about "readonly" as such, it is about the FIRST
//    candidate being rejected at all. This instance uses a read-only target
//    because that is the one rejection whose safety (never write a read-only
//    session) is already a settled requirement. h.readOnly is injected here too:
//    whether a member that nativePin just added can be read-only depends on
//    hydration / permission state that flips afterwards, which this harness does
//    not claim to have observed on the real host.
// ---------------------------------------------------------------------------
console.log('\n=== J. 首个被拒候选吃掉整批新增（此处：只读目标）===');
{
  const a = scene({ host: { readOnly: ['mvs_ro'] } });
  await passes(a, 2);
  nativePin(a.host, 'mvs_ro');
  nativePin(a.host, 'mvs_x');
  await passes(a, 2);
  await passes(a, 4);
  // The capability has to be read on the CANDIDATE'S OWN row. Reading the
  // witness row instead would answer a different question -- and the read itself
  // calls the host's probe, so the corrector's own probe log is sliced BEFORE it.
  const probesDuringPasses = a.host.probes.slice();
  const writesToRo = a.host.calls.filter((x) => x[0] === 'mvs_ro').length;
  const persistsToRo = a.host.persists().filter((x) => x[0] === 'mvs_ro').length;
  const capX = attachWitness(a.p, a.host, 'mvs_x').cap();
  v('J.1 只读目标自身零写零落盘（安全拒绝成立）',
    writesToRo === 0 && persistsToRo === 0,
    `calls(ro)=${writesToRo} persists(ro)=${persistsToRo} refused=${a.p.api.autoState.refused} correctorProbes=${JSON.stringify(probesDuringPasses.filter((x) => x.startsWith('mvs_ro') || x.startsWith('mvs_x')))}`);
  v('J.2 首个候选被拒后，同批里可写的新成员仍应补到 order[0]',
    rawIds(a.host) === 'session:mvs_x,session:mvs_a,session:mvs_b,session:mvs_ro',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} cap(x).available=${capX.available} cap(x).alreadyTop=${capX.alreadyTop}`);
}

// ---------------------------------------------------------------------------
// K. CONDITION MODEL, reported as a LIMIT -- NOT as a failure, and NOT as a claim
//     that this state is unreachable. Two things are unproven here and neither is
//     settled by this suite:
//       (a) reachability -- whether the host's own order ever mixes a non-session
//           row ahead of sessions is NOT established here. The fixture can
//           express it; that says nothing about the real sidebar.
//       (b) semantics  -- "置顶区最前" is not unconditionally raw[0] either, so
//           even a proven-mixed order would not settle what the right answer is.
//     What IS established: on this state the two shipped definitions disagree.
//     The corrector filters to session rows, sees index 0 and answers "already
//     top" (zero writes), while topmostCapability judges from the RAW array and
//     answers "not at the top".
// ---------------------------------------------------------------------------
console.log('\n=== K. 条件模型：raw order[0] 是非会话行（可达性未证，语义未定）===');
{
  const a = scene({ host: { order: [proj('proj_p'), ref('mvs_a'), ref('mvs_b')] }, rowId: 'mvs_a' });
  await passes(a, 2);                        // arm baseline: sessions [a,b]
  nativeUnpin(a.host, 'mvs_a');
  nativeUnpin(a.host, 'mvs_b');               // raw is now just [project_p]
  await passes(a, 1);                         // ids == [] -> unproven, baseline kept
  nativePin(a.host, 'mvs_x');                 // raw = [project_p, X]
  await passes(a, 2);
  await passes(a, 4);
  const capX = attachWitness(a.p, a.host, 'mvs_x').cap();   // the CANDIDATE's own capability
  limitRow('K.1 条件模型下的定义分裂（可达性未证 / 终序语义未定，故不作判定）',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} autoState.alreadyTop=${a.p.api.autoState.alreadyTop} lastReason=${a.p.api.autoState.lastReason}；cap(X).alreadyTop=${capX.alreadyTop} cap(X).orderFirst=${capX.orderFirst}`);
}

// ---------------------------------------------------------------------------
// L. The same filtering condition on the OTHER corrector (promote). Reached and
//    rejected under the same two unproven premises as K, so it is a LIMIT too:
//    reachability of a mixed raw order, and whether a running session below a
//    non-session row must float.
// ---------------------------------------------------------------------------
console.log('\n=== L. 条件模型（promote 段）：raw order[0] 是非会话行 ===');
{
  const a = scene({ host: { order: [ref('mvs_a'), proj('proj_p')] }, rowId: 'mvs_a' });
  const status = {};
  await promoPasses(a, status, 2);              // arm: promotePrev = [{mvs_a,false}]
  // The order moves: raw = [project_p, a].
  commitOrder(a.host, [proj('proj_p'), ref('mvs_a')]);
  await promoPasses(a, status, 2);              // member set unchanged -> no action
  const capBefore = a.w.cap();                 // the candidate's own capability
  status.mvs_a = 'running';                    // it starts talking
  await promoPasses(a, status, 3);
  limitRow('L.1 同一条件在 promote 段复现（同样不作判定）',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} promoteState.alreadyTop=${a.p.api.promoteState.alreadyTop} promoteCalls=${a.p.api.promoteState.calls}；cap(a).alreadyTop=${capBefore.alreadyTop} cap(a).orderFirst=${capBefore.orderFirst}`);
}

// ---------------------------------------------------------------------------
// M. No session row in the DOM at all: the capability cannot be proven. This is
//    a different mechanism from the cloud-source case (a real sidebar that has
//    not mounted rows), and the baseline must survive it.
// ---------------------------------------------------------------------------
console.log('\n=== M. 能力不可证明（DOM 里一行会话都没有）→ 恢复 ===');
{
  const a = scene();
  await passes(a, 2);
  a.w.detach();
  nativePin(a.host, 'mvs_c');
  await passes(a, 2);
  const unproven = a.p.api.autoState.unproven;
  // Sampled DURING the blind window, same discipline as I: "nothing was written
  // while unprovable" has to be read at that moment, not inferred afterwards.
  const callsOnBlind = a.host.calls.length;
  const persistsOnBlind = a.host.persists().length;
  v('M.1 观察盲区内零宿主写、零后端落盘（恢复前采样）',
    callsOnBlind === 0 && persistsOnBlind === 0 && unproven >= 2,
    `callsOnBlind=${callsOnBlind} persistsOnBlind=${persistsOnBlind} unproven=${unproven} rows=${a.p.dom.querySelectorAll('[data-session-id]').length}`);
  attachWitness(a.p, a.host, 'mvs_a');
  await passes(a, 2);
  v('M.2 视图恢复后基线没有被吃掉, 那一项补到 order[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)}`);
}

// ---------------------------------------------------------------------------
// N. Ordering of three things that the requirement depends on: the ticket, the
//    promise settle, and React's own re-render. The host commits on the NEXT
//    frame, i.e. after the promise has already resolved.
// ---------------------------------------------------------------------------
console.log('\n=== N. 闸 / promise 结算 / 延迟 re-render 的先后 ===');
{
  const a = scene({ host: { commitMode: 'timer' } });
  await passes(a, 2);
  nativePin(a.host, 'mvs_c');
  let busyAtCall = false;
  let busyAfterSettle = true;
  let writesDuringFlight = -1;
  a.p.api.autoTick();                        // pass 1: only settles the baseline
  await flush();
  a.p.api.autoTick();                        // pass 2: the deciding pass
  busyAtCall = a.p.api.gateBusy();           // ticket held, host still in flight
  writesDuringFlight = a.host.calls.length;
  a.p.api.autoTick();                        // a pass that lands MID-FLIGHT
  await flush();
  busyAfterSettle = a.p.api.gateBusy();
  a.host.timers.run();                       // React finally re-renders
  await flush();
  await passes(a, 3);
  v('N.1 调用返回时闸仍被占着，promise 结算后释放（只验这一段持有关系）',
    busyAtCall === true && busyAfterSettle === false,
    `busyAtCall=${busyAtCall} busyAfterSettle=${busyAfterSettle}`);
  v('N.2 宿主还没重渲染的那一趟不重复写（一次变化最多一次调用）',
    writesDuringFlight === 1 && a.host.calls.length === 1,
    `callsDuring=${writesDuringFlight} finalCalls=${a.host.calls.length} ${seqOf(a)}`);
  v('N.3 延迟 re-render 落地后顺序确实是 order[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b',
    `${seqOf(a)} commits=${a.host.commits}（原生置顶 1 次 + 我们那次延迟落地 1 次）`);
}

// ---------------------------------------------------------------------------
// P. The promote corrector on its OWN, with no auto corrector in the pass. This
//    isolates one question: a session that starts talking while the shared gate
//    is held by somebody else.
//      - control: same scene, gate free -> the session floats (fixture capable)
//      - case:    same scene, foreign ticket held -> the rising edge is NOT
//                 consumed: zero writes, and the pass after the ticket is
//                 released floats it
// ---------------------------------------------------------------------------
console.log('\n=== P. 活动会话上浮：闸被占时升沿不被消费 ===');
{
  // Control first: no ticket in the way. Without this the case below could not
  // tell "lost at the gate" from "the fixture cannot float anything".
  const ctl = scene();
  const idle = {};
  await promoPasses(ctl, idle, 2);
  const live = { mvs_b: 'running' };
  await promoPasses(ctl, live, 3);
  v('P.1 对照：闸空闲时，正在跑的 b 浮到 raw[0]',
    rawIds(ctl.host) === 'session:mvs_b,session:mvs_a',
    `${seqOf(ctl)} calls=${JSON.stringify(ctl.host.calls)} promoteCalls=${ctl.p.api.promoteState.calls}`);

  const a = scene({ page: { foreignTicket: Object.freeze({ held: 'other' }) } });
  await promoPasses(a, idle, 2);
  // The edge lands on a pass where the gate is already held by somebody else.
  await promoPasses(a, { mvs_b: 'running' }, 1);
  const callsWhileHeld = a.host.calls.length;
  const persistsWhileHeld = a.host.persists().length;
  const reasonWhileHeld = a.p.api.promoteState.lastReason;
  a.p.window[GATE].ticket = null;                 // the other holder finishes
  await promoPasses(a, { mvs_b: 'running' }, 4);  // still running, gate now free
  v('P.2 闸释放后仍在跑的那一项仍应浮到 raw[0]',
    rawIds(a.host) === 'session:mvs_b,session:mvs_a',
    `${seqOf(a)} callsWhileHeld=${callsWhileHeld} persistsWhileHeld=${persistsWhileHeld} reasonWhileHeld=${reasonWhileHeld} calls=${JSON.stringify(a.host.calls)} promoteCalls=${a.p.api.promoteState.calls} blocked=${a.p.api.promoteState.blocked}`);
}

// ---------------------------------------------------------------------------
// Q. Both segments inside ONE apply() pass, in the shipped statement order
//    (page-script.mjs:894-900): one resolved capability, auto first, promote
//    second, no await in between. Both segments are armed, the user pins c, and
//    b starts talking in the SAME pass in which the order settles -- so auto is
//    the one holding the gate when promote has to decide.
//
//    Q.3 records why b is NOT floated afterwards, and the reason is NOT "the edge
//    was lost" any more. Promote now keeps that rising edge in a sticky pending
//    obligation exactly like P.2 does, and it does charge one budget unit for it.
//    What discharges it here is the OTHER rule of the same pair: an obligation is
//    settled when the order shape it was taken against no longer exists. Auto has
//    already rewritten [a,b,c] into [c,a,b] by then, so the shape under b's
//    obligation is gone -- one charge, obligation dropped, no write.
//
//    Which of c and b should end up first is still NOT decided by this section;
//    that is why Q.3 stays a LIMIT and not a PASS.
// ---------------------------------------------------------------------------
console.log('\n=== Q. 同一趟里两段共用一份能力（auto 先拿闸）===');
{
  const a = scene();
  const idle = {};
  await applyPasses(a, idle, 2);            // both segments armed on [a,b]
  nativePin(a.host, 'mvs_c');               // the user's own pin -> [a,b,c]
  // FIRST observation pass after the pin: the two segments only settle their Seen
  // arrays here. No gate is taken and no call is made, so a zero-write snapshot
  // taken at THIS point would say nothing -- it must not be read as the safety
  // gate holding. It is here to fix the timing, and Q.1 asserts that it was a
  // no-call pass.
  await applyPass(a, idle);
  const callsAfterFirstObserve = a.host.calls.length;
  const gateBusyAfterFirst = a.p.api.gateBusy();
  // SECOND pass is the deciding one, and b's rising edge rides on it.
  const status = { mvs_b: 'running' };
  const snap = applyPassSync(a, status);    // sampled BEFORE any flush
  await flush();                            // now the host promise is allowed to settle
  const gateBusyAfterSettle = a.p.api.gateBusy();
  await applyPasses(a, status, 4);          // ticket long since released
  v('Q.1 新成员 c 仍被补到 raw[0]',
    rawIds(a.host) === 'session:mvs_c,session:mvs_a,session:mvs_b'
    && callsAfterFirstObserve === 0 && gateBusyAfterFirst === false,
    `${seqOf(a)} 第一观察趟 calls=${callsAfterFirstObserve} gateBusy=${gateBusyAfterFirst}；hostCalls=${JSON.stringify(a.host.calls)}`);
  v('Q.2 决定趟：auto 持闸、promote 零宿主写，结算后闸已释放',
    snap.autoCallsAfterAuto === 1 && snap.gateBusyAfterAuto === true
    && snap.callsToB === 0 && snap.promoteBlocked === 1
    && snap.promoteReason === 'gate-unavailable'
    && snap.gateBusyBeforeSettle === true && gateBusyAfterSettle === false,
    `autoCalls=${snap.autoCallsAfterAuto} gateBusyAfterAuto=${snap.gateBusyAfterAuto} callsToB=${snap.callsToB} promoteBlocked=${snap.promoteBlocked} promoteReason=${snap.promoteReason} gateBusyBeforeSettle=${snap.gateBusyBeforeSettle} gateBusyAfterSettle=${gateBusyAfterSettle}`);
  limitRow('Q.3 票释放之后，b 的升沿没有再被补（只证事件丢失，不判 c 与 b 谁该赢）',
    `${seqOf(a)} promoteCalls=${a.p.api.promoteState.calls} promoteNoChange=${a.p.api.promoteState.noChange} callsToB=${a.host.calls.filter((x) => x[0] === 'mvs_b').length} persists=${JSON.stringify(a.host.persists())}`);
}

// ---------------------------------------------------------------------------
// R. Single-sample unpin -> repin. H.1 is the two-sample control: the member is
//    gone in two consecutive samples and the shipped rule does treat it as new.
//    R removes one of those samples -- the member is gone for exactly one poll
//    and then re-pinned to the tail, which is the user's action sequence, not a
//    state model.
//    Why it used to fail, in the source's own terms: with x gone the ids are
//    [a,b], so that one sample differs from autoTopSeen and only autoTopSeen moved
//    to [a,b] -- the member baseline autoTopIds stayed [a,b,x]. The re-pin restores
//    the exact same order, so once the two seen arrays agreed again the very next
//    pass compared prev === ids and returned at the same-order early exit. x was
//    therefore never a new member again, and no later pass revisited it.
//    What makes it detectable: that one sample IS the observation. The corrector
//    saw a stable order that is a strict SUBSET of its member baseline, i.e. the
//    user unpinned and we do not correct removals -- so that smaller membership is
//    accepted as the new baseline. The re-pin then differs from THAT baseline, and
//    x is a new member again. The rule is deliberately subset-only: a pure reorder
//    (the same member set, different indices) never advances the baseline early,
//    which is what keeps 24.8 "never undo the user's drag" green.
// ---------------------------------------------------------------------------
console.log('\n=== R. 单采样取消置顶后重新置顶 ===');
{
  const a = scene({ host: { order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_x')] } });
  await passes(a, 2);                        // stable [a,b,x]
  nativeUnpin(a.host, 'mvs_x');
  await passes(a, 1);                        // ONE sample with x gone
  nativePin(a.host, 'mvs_x');                // re-pinned to the tail
  await passes(a, 4);
  v('R.1 单采样取消再置顶后，重新置顶的那一项补到 order[0]',
    rawIds(a.host) === 'session:mvs_x,session:mvs_a,session:mvs_b',
    `${seqOf(a)} calls=${JSON.stringify(a.host.calls)} settleMiss=${a.p.api.autoState.settleMiss} noCandidate=${a.p.api.autoState.noCandidate}`);
}

// ---------------------------------------------------------------------------
console.log(`\n=== 汇总：PASS=${pass} FAIL=${fail} LIMIT=${limit} ===`);
console.log('LIMIT = 条件模型 / 出厂事实记录（需求没规定终序语义，或前提未证），不是判定。');
process.exitCode = fail > 0 ? 1 : 0;
