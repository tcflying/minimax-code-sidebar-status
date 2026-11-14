// mmx-status :: test-new-main-page.mjs
//
// Offline behaviour tests for the PAGE side of "a brand new conversation goes to
// the very top of the pinned list" -- the block that consumes the newMainSessions
// package the daemon delivers.
//
// WHAT IS UNDER TEST
//   The real code, sliced out of lib/page-script.mjs:
//     - the new-main block (package -> write -> receipt),
//     - the real topmostCapability() (so the capability really is PROVED against
//       a fake React fiber tree, not handed to the code as a ready-made object),
//     - the real shared gate (hostCallTake/hostCallRelease).
//   The fake host is shaped like the one in app.asar: handlePinSession is a
//   three-argument callback over seven deps, and it rebuilds the pinned order
//   with the same pure helper the host uses (an undefined index appends, 0 goes
//   to the front, the item is filtered out before being re-inserted).
//
// EVERY ASSERTION IS ABOUT THE HOST'S FINAL ORDER, not about "a function was
// called N times". A call count cannot tell a real reorder from a call that went
// nowhere; the order can.
//
// THE LOCK, AND THE YIELD
//   The lock is NOT simulated any more. This file slices the WHOLE lock module
//   out of lib/page-script.mjs -- the same range test-top-lock.mjs compiles on
//   its own -- and runs the real topLockTick() against the real new-main block.
//   So "the lock yields to the new conversation" is proven by the real machine:
//   the real budget, the real shared gate, the real confirm.
//
//   The rule under test (user, 2026-11-15): a new conversation goes ABOVE the
//   locked one and becomes the first item. The lock gives way and STAYS locked;
//   while that new conversation is still on top it never grabs raw[0] back.
//
// WHAT IS NOT PROVEN HERE
//   - The real renderer (CDP) is never touched. The capability proof still has
//     to be confirmed on the real host.
//   - The daemon side (which sessions are candidates at all) is not exercised
//     here: this file only proves what the PAGE does with the package it is
//     handed.
//
//   node test-new-main-page.mjs

import fs from 'node:fs';
import { makeDom, attachFiber, hookChain, fiber } from './testlib/fake-dom.mjs';
import { buildBootstrapExpression } from './lib/page-script.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');

function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}
function sliceLine(re) {
  const m = pageSrc.match(re);
  if (!m) throw new Error(`cannot slice page-script.mjs: ${re}`);
  return m[0];
}

// The capability resolver: the constants it needs, then the functions from
// fiberOf() up to (but not including) rowMenuFiber(). topmostCapability() lives
// inside that range, so what the new-main block receives is a REAL capability
// proof, not a hand-made object.
const CAP_CONSTS = sliceBlock('  var TOPMOST_MAX_ANCESTORS = 256;', '  var topmostState = {');
const CAP_FUNCS = sliceBlock('  function fiberOf(node) {', '  function rowMenuFiber(rowEl) {');
// The shared gate + the lock runtime, verbatim: the new-main block must go
// through the SAME gate as the menu item, the red lock button, auto-top and
// promote, and the lock module needs the same runtime.
const GATE = sliceBlock(
  "  var TOPLOCK_GATE_KEY = '__mmxStatusHostGateV1';",
  '  var topmostLockView = {'
);
// The WHOLE lock module, verbatim: the real topLockTick(), the real
// topLockConfirm(), the real budget. The yield decision has to be exercised
// against the real machine, never against a copy of it. This is the same range
// test-top-lock.mjs compiles on its own.
const LOCK_BLOCK = sliceBlock(
  '  // 红色悬停锁顶 · 单会话持续锁顶',
  '  var timer = window.setInterval'
);
// The freshness constant: the new-main block must reuse the page's existing
// staleness rule, not invent a second one.
const STALE = sliceLine(/^ {2}var STALE_AFTER_MS = \d+;$/m);
// The cross-entry lock view: read-only for the new-main block.
const LOCK_VIEW = sliceLine(/^ {2}var topmostLockView = \{[^\n]*$/m);
// The block under test.
const NEWMAIN = sliceBlock('  // 新对话排最上面（页面侧）', '  var api = {');
if (!NEWMAIN.includes('function newMainTick(')) {
  throw new Error('the new-main block is missing from the shipped source');
}

// ---------------------------------------------------------------------------
// The fake host, shaped like the one in app.asar@317043972.
// ---------------------------------------------------------------------------
const ref = (id) => ({ type: 'session', id });
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
const SessionInfo = { getSessionInfo: async (id) => ({ id }) };
const PinService = { calls: [], async pinSession() { PinService.calls.push([...arguments]); } };

function makeHost(opts = {}) {
  const h = {
    order: (opts.order || []).map((r) => ({ ...r })),
    source: opts.source || 'local',
    calls: [],
    persists: [],
  };
  PinService.calls = h.persists = [];
  h.deps = [
    (id, src) => (opts.readOnly || []).includes(id),   // isReadOnlySessionById
    undefined,                                         // currentPinnedItemsOrder (live getter)
    h.source,                                          // conversationSource
    {},                                                // pinnedProjectSessionPages
    () => {},                                          // mergePinnedItemPayloads
    () => {},                                          // removePinnedItemPayload
    (next) => { h.order = next; },                    // setPinnedItemsOrder
  ];
  h.fn = async function (e, l, c) {
    h.calls.push([e, l, c]);
    // 宿主当场拒绝这一笔（抛异常）：写尝试照样发生，页面不许无限重试。
    if (opts.throws) throw new Error('host refused');
    if (h.deps[0](e, h.source)) return;                 // silent refusal
    const session = await SessionInfo.getSessionInfo(e, undefined, h.source);
    // The 'append' host models the bug this feature exists for: the index is
    // dropped, so the host APPENDS instead of putting the id at the front.
    const index = opts.append ? undefined : c;
    const next = updatePinnedRefs(h.order, { type: 'session', id: e }, l, index);
    if (next !== h.order) h.deps[6](next);
    await PinService.pinSession(e, l, l ? c : undefined, h.source);
    void session;
  };
  Object.defineProperty(h.deps, 1, {
    get: () => h.order, enumerable: true, configurable: true,
  });
  h.decoy = function (a, b, c2) { return [a, b, c2].length; };
  h.decoyDeps = [() => {}, h.order, h.source, {}, () => {}, () => {}];
  return h;
}

// A row with the fiber tree the host really builds: the row div hangs off a
// session component, which hangs off the sidebar container, and THAT container
// is the one carrying the seven-dep handlePinSession hook.
function makeRow(page, id, host) {
  const rowEl = page.dom.el('div', { 'data-session-id': id });
  page.dom.root.appendChild(rowEl);

  const fiberRoot = { current: null };
  const currentRoot = fiber({ tag: 3, name: 'HostRoot', parent: null });
  currentRoot.stateNode = fiberRoot;
  const staleRoot = fiber({ tag: 3, name: 'HostRoot', parent: null });
  staleRoot.stateNode = fiberRoot;
  currentRoot.alternate = staleRoot;
  staleRoot.alternate = currentRoot;

  const decoyHooks = [[() => {}, [1, 2]], [host.decoy, host.decoyDeps]];
  const hooks = () => decoyHooks.concat([[host.fn, host.deps], [() => {}, []]]);
  const container = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain(hooks()), parent: currentRoot });
  const rowComponent = fiber({ name: 'SessionRow', props: { session: { id } }, parent: container });
  const rowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, parent: rowComponent });
  fiberRoot.current = currentRoot;
  attachFiber(rowEl, rowDiv);
  return { rowEl };
}

// ---------------------------------------------------------------------------
// The harness: the sliced code, compiled and driven.
// ---------------------------------------------------------------------------
function makePage() {
  const dom = makeDom();
  const win = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: makeStorage(),
  };
  const factory = new Function(
    'window',
    'document',
    'cfg',
    'var disposed = false;\n' +
      CAP_CONSTS + CAP_FUNCS + GATE + LOCK_VIEW + LOCK_BLOCK + STALE + NEWMAIN +
      '\nreturn {' +
      '  cap: function (rowEl) { return topmostCapability(rowEl); },' +
      '  tick: function (cap, stats) { return newMainTick(cap, stats); },' +
      '  setPkg: function (p) { newMainPkg = p === undefined ? null : p; },' +
      // The real lock machine, so the yield is proven against it.
      '  lockState: topLockState,' +
      '  lockTick: function () { return topLockTick(); },' +
      '  confirm: function (view) { return topLockConfirm(view); },' +
      '  budgetReset: function (id) { return topLockBudgetReset(id); },' +
      '  rt: topLockRuntime,' +
      '  lockView: topmostLockView,' +
      '  state: newMainState };'
  );
  // cfg 就是页面函数自己的那个参数：bootstrap 时 daemon 把包放在
  // cfg.newMainSessions 里，刷新时它走 refresh() 的第二个参数。
  const api = factory(win, dom.document, { newMainSessions: null });
  return { dom, window: win, api };
}

/**
 * The lock intent, armed the way the red button arms it: the intent id, the
 * confirmed flag and a full maintenance budget. Nothing here is a switch that
 * only the test can see -- topLockTick() below runs the real machine.
 */
function armLock(page, id) {
  const st = page.api.lockState;
  st.intentId = id;
  st.intentSource = 'local';
  st.confirmedId = id;
  st.confirmedAtTop = true;
  st.phase = 'confirmed';
  st.reason = 'confirmed';
  page.api.budgetReset(id);
  return st;
}

const settle = () => new Promise((r) => setImmediate(r));
const orderIds = (host) => host.order.map((r) => String(r.id));
const T0 = 1700000000000;

/** One delivery of the package, exactly the shape the daemon sends. */
function pkg({ run = T0, seq = 1, available = true, age = 0, candidates = [] } = {}) {
  return {
    startedAtMs: run,
    sequence: seq,
    available,
    observedAtMs: Date.now() - age,
    candidates: candidates.map((c, i) => ({
      id: c.id,
      createdAtMs: c.createdAtMs != null ? c.createdAtMs : i,
    })),
  };
}

/** One pass: the page is handed a package and runs the tick. No settle. */
function drive(page, host, row, p) {
  page.api.setPkg(p);
  // A FRESH capability per pass, exactly like apply() resolves one per pass:
  // the order array the host committed is a NEW array, so the previous
  // capability would still be looking at the old one.
  const cap = page.api.cap(row.rowEl);
  const stats = {};
  page.api.tick(cap, stats);
  return stats;
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. 可用且新鲜：候选被写到 raw[0]，下一趟才回执 ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const row = makeRow(page, 'mvs_old', host);
  const cap0 = page.api.cap(row.rowEl);
  check('1.0 前置：能力是真的证出来的（不是手搓的）',
    cap0.available === true && cap0.source === 'local' && Array.isArray(cap0.order),
    JSON.stringify({ available: cap0.available, source: cap0.source }));

  const s1 = drive(page, host, row, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('1.1 写已经发出去了，但 order 还没动（宿主写是异步的）',
    orderIds(host).join(',') === 'mvs_old,mvs_new', orderIds(host).join(','));
  check('1.2 resolve 不等于生效：这一趟还没有回执',
    s1.newMainSessions && s1.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s1.newMainSessions));
  await settle();

  const s2 = drive(page, host, row, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('1.3 宿主自己的 order：新会话到了最顶',
    orderIds(host).join(',') === 'mvs_new,mvs_old', orderIds(host).join(','));
  check('1.4 回执只点名真的读到在 raw[0] 的那个 id',
    s2.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(s2.newMainSessions.acknowledged));
  check('1.5 回执里的 startedAtMs 是包带来的原值',
    s2.newMainSessions.startedAtMs === T0, String(s2.newMainSessions.startedAtMs));
  check('1.6 落位之后不再重复写',
    host.calls.length === 1, 'calls=' + JSON.stringify(host.calls));
  check('1.7 写的是三参，位置是 0（不是 append）',
    host.calls.length === 1 && host.calls[0][0] === 'mvs_new'
    && host.calls[0][1] === true && host.calls[0][2] === 0,
    JSON.stringify(host.calls));
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. 不可用 / 过期：零写零ack ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const row = makeRow(page, 'mvs_old', host);
  const s = drive(page, host, row, pkg({ available: false, candidates: [{ id: 'mvs_new' }] }));
  check('2.1 不可用：一次宿主写都没有', host.calls.length === 0, 'calls=' + host.calls.length);
  check('2.2 不可用：没有回执',
    s.newMainSessions && s.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s.newMainSessions));
  check('2.3 不可用：原因可观察', s.newMainSessions.deferred === 'unavailable',
    String(s.newMainSessions.deferred));
  await settle();

  const page2 = makePage();
  const host2 = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const row2 = makeRow(page2, 'mvs_old', host2);
  const s2 = drive(page2, host2, row2, pkg({ age: 20000, candidates: [{ id: 'mvs_new' }] }));
  check('2.4 过期（observedAtMs 超过 STALE_AFTER_MS）：一次宿主写都没有',
    host2.calls.length === 0, 'calls=' + host2.calls.length);
  check('2.5 过期：没有回执',
    s2.newMainSessions && s2.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s2.newMainSessions));
  check('2.6 过期：原因可观察', s2.newMainSessions.deferred === 'stale',
    String(s2.newMainSessions.deferred));
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. id 不在 order / 只读：零写零ack ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old')] });
  const row = makeRow(page, 'mvs_old', host);
  const s = drive(page, host, row, pkg({ candidates: [{ id: 'mvs_ghost' }] }));
  check('3.1 id 不在宿主 order 里：一次宿主写都没有',
    host.calls.length === 0, 'calls=' + host.calls.length);
  check('3.2 id 不在宿主 order 里：没有回执',
    s.newMainSessions && s.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s.newMainSessions));
  await settle();

  const page2 = makePage();
  const host2 = makeHost({ order: [ref('mvs_old'), ref('mvs_ro')], readOnly: ['mvs_ro'] });
  const row2 = makeRow(page2, 'mvs_old', host2);
  const s2 = drive(page2, host2, row2, pkg({ candidates: [{ id: 'mvs_ro' }] }));
  check('3.3 只读会话：一次宿主写都没有',
    host2.calls.length === 0, 'calls=' + host2.calls.length);
  check('3.4 只读会话：没有回执',
    s2.newMainSessions && s2.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s2.newMainSessions));
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. 多候选：按升序写，最终最新的那个在 raw[0] ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_x'), ref('mvs_a'), ref('mvs_b')] });
  const row = makeRow(page, 'mvs_x', host);
  // a 比 b 老（createdAtMs 升序）。
  const cands = [{ id: 'mvs_a', createdAtMs: 10 }, { id: 'mvs_b', createdAtMs: 20 }];

  drive(page, host, row, pkg({ seq: 1, candidates: cands }));
  check('4.1 先写的是老的那一个',
    host.calls.length === 1 && host.calls[0][0] === 'mvs_a',
    JSON.stringify(host.calls));
  await settle();
  drive(page, host, row, pkg({ seq: 2, candidates: cands }));
  check('4.2 第二个候选也写了（按包内升序）',
    host.calls.length === 2 && host.calls[1][0] === 'mvs_b',
    JSON.stringify(host.calls));
  await settle();
  const s3 = drive(page, host, row, pkg({ seq: 3, candidates: cands }));

  check('4.3 宿主自己的 order：最新的那个在最顶，老的被挤到第二',
    orderIds(host).join(',') === 'mvs_b,mvs_a,mvs_x', orderIds(host).join(','));
  check('4.4 两个 id 都被回执，同一个 id 只出现一次',
    s3.newMainSessions.acknowledged.slice().sort().join(',') === 'mvs_a,mvs_b',
    JSON.stringify(s3.newMainSessions.acknowledged));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. 没落在 raw[0]：不回执（回执看的是位置，不是那一次调用） ===');
{
  const page = makePage();
  // 这个宿主把下标丢了（就像那两参包装器），于是新会话被【追加】到末尾。
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')], append: true });
  const row = makeRow(page, 'mvs_old', host);
  drive(page, host, row, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  await settle();
  const s2 = drive(page, host, row, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('5.1 宿主确实被写了（daemon 每趟重发，页面每趟重试一次）',
    host.calls.length >= 1, 'calls=' + host.calls.length);
  check('5.2 但它没有落在 raw[0]（被追加到了末尾）',
    orderIds(host).join(',') === 'mvs_old,mvs_new', orderIds(host).join(','));
  check('5.3 没读到它在 raw[0]：不回执',
    s2.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s2.newMainSessions.acknowledged));
}

// ---------------------------------------------------------------------------
// 6. 锁在场：新对话照写 raw[0]，锁让位到它下面
//
// 用户新规则（2026-11-15）：有新对话时，新对话排到原锁顶项上面，成为第一项。
// 这里跑的是【真的】锁机器：真的 topLockTick()、真的维持预算、真的共享闸。
// ---------------------------------------------------------------------------
console.log('\n=== 6. 锁在场：新对话照写 raw[0]，锁让位 ===');
{
  const page = makePage();
  // 置顶区：锁在 raw[0]，新对话在它下面（它已经在置顶区里，只是位置不对）。
  const host = makeHost({ order: [ref('mvs_lock'), ref('mvs_new')] });
  const lockRow = makeRow(page, 'mvs_lock', host);
  makeRow(page, 'mvs_new', host);
  armLock(page, 'mvs_lock');

  const s1 = drive(page, host, lockRow, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('6.1 锁在场：新对话照写 raw[0]（三参，第三参是 0）',
    host.calls.length === 1 && host.calls[0][0] === 'mvs_new'
    && host.calls[0][1] === true && host.calls[0][2] === 0,
    JSON.stringify(host.calls));
  // 断言"写次数 +1"，而不是断言"没有 deferred"：后者分不出"写了"和"压根没写"
  // （一次静默早退也可能什么都不报）。
  check('6.2 锁在场：新对话通道没有早退（这一趟真的写了，不是静默跳过）',
    host.calls.length === 1
    && !(s1.newMainSessions && s1.newMainSessions.deferred),
    'calls=' + host.calls.length + ' deferred=' + String(s1.newMainSessions && s1.newMainSessions.deferred));
  check('6.3 写还没生效：没有回执（resolve 不算生效）',
    s1.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s1.newMainSessions.acknowledged));
  await settle();
  check('6.4 宿主自己的 order：新对话到了最顶，锁顺次下移',
    orderIds(host).join(',') === 'mvs_new,mvs_lock', orderIds(host).join(','));

  // ---- 锁的那一趟：让位，一次宿主写都不发 ----
  const callsBefore = host.calls.length;
  const budgetBefore = page.api.rt().budget;
  page.api.lockTick();
  check('6.5 让位那一趟：锁一次宿主写都不发（不抢回 raw[0]）',
    host.calls.length === callsBefore, 'calls=' + JSON.stringify(host.calls));
  check('6.6 让位那一趟：维持预算一格都没扣',
    page.api.rt().budget === budgetBefore && page.api.lockState.maintBudget === budgetBefore,
    'rt=' + page.api.rt().budget + ' state=' + page.api.lockState.maintBudget);
  check('6.7 让位那一趟：理由是 yielded-to-new-main',
    page.api.lockState.reason === 'yielded-to-new-main', page.api.lockState.reason);
  check('6.8 让位时锁仍然成立（红箭头继续亮着）',
    page.api.lockState.confirmedAtTop === true && page.api.lockState.confirmedId === 'mvs_lock',
    'atTop=' + page.api.lockState.confirmedAtTop + ' id=' + page.api.lockState.confirmedId);
  check('6.9 phase 仍是 confirmed（UI 看起来还是"已锁"）',
    page.api.lockState.phase === 'confirmed', page.api.lockState.phase);
  check('6.10 让位对象被记下来了（我们自己放到 raw[0] 的那个 id）',
    page.api.lockState.yieldedTo === 'mvs_new', page.api.lockState.yieldedTo);

  // 再走一趟：让位是【持续】的，不是只让一趟。
  page.api.lockTick();
  check('6.11 让位是持续的：第二趟还是零宿主写',
    host.calls.length === callsBefore, 'calls=' + JSON.stringify(host.calls));

  // ---- 回执：只有真的读到 order[0] === 那个 id 才算 ----
  const s2 = drive(page, host, lockRow, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('6.12 读到 order[0] 就是它：这才回执',
    s2.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(s2.newMainSessions.acknowledged));
}

// ---------------------------------------------------------------------------
console.log('\n=== 6b. 新对话被挪走：锁按老行为抢回 raw[0] ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_lock'), ref('mvs_new')] });
  const lockRow = makeRow(page, 'mvs_lock', host);
  makeRow(page, 'mvs_new', host);
  armLock(page, 'mvs_lock');

  drive(page, host, lockRow, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  await settle();
  check('6b.1 前置：新对话在 raw[0]，锁在第二位',
    orderIds(host).join(',') === 'mvs_new,mvs_lock', orderIds(host).join(','));

  // 用户把新对话拖走了：raw[0] 不再是我们自己放上去的那个。
  host.order = [ref('mvs_other'), ref('mvs_lock'), ref('mvs_new')];
  const before = host.calls.length;
  page.api.lockTick();
  check('6b.2 新对话被挪走：锁抢回 raw[0]（发一次三参写）',
    host.calls.length === before + 1 && host.calls[before][0] === 'mvs_lock'
    && host.calls[before][1] === true && host.calls[before][2] === 0,
    JSON.stringify(host.calls));
  await settle();
  check('6b.3 抢回之后宿主自己的 order：锁回到最顶',
    orderIds(host).join(',') === 'mvs_lock,mvs_other,mvs_new', orderIds(host).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n=== 6c. 别人手动置顶的会话顶上来：锁按老行为抢回 raw[0] ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_lock'), ref('mvs_new')] });
  const lockRow = makeRow(page, 'mvs_lock', host);
  makeRow(page, 'mvs_new', host);
  armLock(page, 'mvs_lock');

  drive(page, host, lockRow, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  await settle();
  // 别人手动置顶了另一个会话：raw[0] 不是我们放上去的那个。
  host.order = [ref('mvs_manual'), ref('mvs_new'), ref('mvs_lock')];
  const before = host.calls.length;
  page.api.lockTick();
  check('6c.1 别人手动置顶的会话在 raw[0]：锁抢回 raw[0]（发一次三参写）',
    host.calls.length === before + 1 && host.calls[before][0] === 'mvs_lock'
    && host.calls[before][1] === true && host.calls[before][2] === 0,
    JSON.stringify(host.calls));
  await settle();
  check('6c.2 抢回之后宿主自己的 order：锁回到最顶',
    orderIds(host).join(',') === 'mvs_lock,mvs_manual,mvs_new', orderIds(host).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n=== 6d. 没有锁：新对话写 raw[0] 的原行为不变 ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const row = makeRow(page, 'mvs_old', host);
  const s1 = drive(page, host, row, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('6d.1 没有锁：新对话照写 raw[0]',
    host.calls.length === 1 && host.calls[0][0] === 'mvs_new' && host.calls[0][2] === 0,
    JSON.stringify(host.calls));
  await settle();
  check('6d.2 宿主自己的 order：新对话到了最顶',
    orderIds(host).join(',') === 'mvs_new,mvs_old', orderIds(host).join(','));
  const before = host.calls.length;
  page.api.lockTick();
  check('6d.3 没有锁意图：锁那一趟零宿主写',
    host.calls.length === before, 'calls=' + JSON.stringify(host.calls));
  const s2 = drive(page, host, row, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('6d.4 回执照旧：读到 order[0] 才点名它',
    s2.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(s2.newMainSessions.acknowledged));
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. 没有包（老 daemon）：零写零ack ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const row = makeRow(page, 'mvs_old', host);
  const s = drive(page, host, row, undefined);
  check('7.1 没有包：一次宿主写都没有', host.calls.length === 0, 'calls=' + host.calls.length);
  check('7.2 没有包：连回执都没有（没有包就没有回执的形状）',
    s.newMainSessions === undefined, JSON.stringify(s.newMainSessions));
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. startedAtMs 变了：本地记忆按新 run 重置 ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_a'), ref('mvs_b')] });
  const row = makeRow(page, 'mvs_old', host);

  drive(page, host, row, pkg({ run: T0, seq: 1, candidates: [{ id: 'mvs_a' }] }));
  await settle();
  const s2 = drive(page, host, row, pkg({ run: T0, seq: 2, candidates: [{ id: 'mvs_a' }] }));
  check('8.1 第一个 run：a 被回执了', s2.newMainSessions.acknowledged.join(',') === 'mvs_a',
    JSON.stringify(s2.newMainSessions.acknowledged));

  // daemon 重启：新的 run。同一个候选再发一次，这一轮必须从头来。
  const s3 = drive(page, host, row, pkg({ run: T0 + 1, seq: 1, candidates: [{ id: 'mvs_b' }] }));
  check('8.2 run 变了：旧 run 的回执被清掉',
    s3.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s3.newMainSessions.acknowledged));
  check('8.3 run 变了：回执里的 startedAtMs 是新 run 的原值',
    s3.newMainSessions.startedAtMs === T0 + 1, String(s3.newMainSessions.startedAtMs));
  check('8.4 run 变了：新一轮照常写',
    host.calls.length === 2 && host.calls[1][0] === 'mvs_b',
    JSON.stringify(host.calls));
  await settle();
  const s4 = drive(page, host, row, pkg({ run: T0 + 1, seq: 2, candidates: [{ id: 'mvs_b' }] }));
  check('8.5 新 run 里只回执新 run 的 id',
    s4.newMainSessions.acknowledged.join(',') === 'mvs_b',
    JSON.stringify(s4.newMainSessions.acknowledged));
  check('8.6 run 变了：让位那份记忆（我们写过谁）也按新 run 重置，旧 run 的 id 不留',
    page.api.state.placedIds.indexOf('mvs_a') < 0,
    JSON.stringify(page.api.state.placedIds));
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. 共享闸：闸被别人占着时零写 ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const row = makeRow(page, 'mvs_old', host);
  // 别人（别的入口）在途的票：同一把闸。
  page.window.__mmxStatusHostGateV1 = { ticket: Object.freeze({ held: 'other' }) };
  const s = drive(page, host, row, pkg({ candidates: [{ id: 'mvs_new' }] }));
  check('9.1 闸被别人占着：一次宿主写都没有', host.calls.length === 0, 'calls=' + host.calls.length);
  check('9.2 闸被别人占着：不回执',
    s.newMainSessions && s.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s.newMainSessions));
  check('9.3 闸被别人占着：原因可观察',
    s.newMainSessions.deferred === 'gate-unavailable', String(s.newMainSessions.deferred));
}

// ---------------------------------------------------------------------------
// 10. 全页装载：refresh 的第二个参数真的被消费（接线那一段）
//
// 上面九节跑的是切出来的那一块。这一节跑【整条出厂表达式】：页面在假窗口里
// 真的装载起来，daemon 那样调 a.refresh(status, pkg)，包必须真的走完
// refresh -> 包 -> apply() -> 那一趟 -> 宿主写 -> 回执这条线。
// ---------------------------------------------------------------------------
function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

function bootPage(host, rowIds, cfg) {
  const dom = makeDom();
  dom.document.addEventListener = () => {};
  dom.document.removeEventListener = () => {};
  const raf = [];
  const win = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: makeStorage(),
  };
  class FakeMO {
    constructor(fn) { this.fn = fn; }
    observe() {}
    disconnect() {}
  }
  // 行必须先在：出厂的 bootstrap 在构造里就跑第一趟 apply()。
  const rows = {};
  for (const id of rowIds) rows[id] = makeRow({ dom }, id, host);
  const expr = buildBootstrapExpression(Object.assign({ status: {}, newMainSessions: null }, cfg || {}));
  const factory = new Function(
    'window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
    'getComputedStyle', 'localStorage', 'CSS',
    'return ' + expr + ';'
  );
  const result = factory(
    win, dom.document, FakeMO, win.requestAnimationFrame, win.cancelAnimationFrame,
    () => ({ position: 'relative' }), win.localStorage, { escape: (x) => String(x) }
  );
  return { dom, window: win, api: win.__mmxStatus, result, rows };
}

{
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const page = bootPage(host, ['mvs_old', 'mvs_new']);
  check('10.0 前置：整页装载成功', !!(page.api && page.api.refresh),
    JSON.stringify(page.result && page.result.ok));
  const stats = page.api.refresh({}, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('10.1 refresh 的第二个参数被消费：回执里带着那个包',
    stats.newMainSessions && stats.newMainSessions.startedAtMs === T0,
    JSON.stringify(stats.newMainSessions));
  await settle();
  const stats2 = page.api.refresh({}, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('10.2 下一趟读到它在 raw[0]：回执点名它',
    stats2.newMainSessions && stats2.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(stats2.newMainSessions));
  check('10.3 宿主自己的 order：新会话到了最顶',
    orderIds(host).join(',') === 'mvs_new,mvs_old', orderIds(host).join(','));
}

{
  // 注入期：包走 cfg.newMainSessions。
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')] });
  const page = bootPage(host, ['mvs_old', 'mvs_new'], {
    newMainSessions: pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }),
  });
  const initial = page.result && page.result.initial;
  check('10.4 注入期：包走 cfg.newMainSessions，boot.initial 里有回执',
    !!(initial && initial.newMainSessions && initial.newMainSessions.startedAtMs === T0),
    JSON.stringify(initial && initial.newMainSessions));
}

// ---------------------------------------------------------------------------
// 11. F2：宿主自己把候选放到 raw[0] —— 不假回执，先建立归属
//
// 旧口径是"读到 order[0] 就是它"就回执，于是宿主自己放上去的候选也会被回执成
// "已应用"。可那时让位判据不成立（那个 id 不在我们写过的那一组里），锁按原语义把 raw[0] 抢
// 回去，候选停在第二位，而 daemon 已经把它从 pending 里摘掉了——再也不会送回来。
// 新口径：回执只认【我们自己放上去的】候选，而且必须真的读到它在 raw[0]。
// ---------------------------------------------------------------------------
console.log('\n=== 11. 宿主自己把候选放到 raw[0]：不假回执，先建立归属 ===');
{
  const page = makePage();
  // 宿主自己就把新对话放在了 raw[0]（我们一次都没写过它）。
  const host = makeHost({ order: [ref('mvs_new'), ref('mvs_old')] });
  const row = makeRow(page, 'mvs_old', host);
  const s1 = drive(page, host, row, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('11.1 宿主自己放的候选：这一趟【不】回执（我们还没写过它）',
    s1.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s1.newMainSessions));
  check('11.2 但我们写它一次，把"这是我们放的"这个事实建立起来（三参，落点 0）',
    host.calls.length === 1 && host.calls[0][0] === 'mvs_new'
    && host.calls[0][1] === true && host.calls[0][2] === 0,
    JSON.stringify(host.calls));
  await settle();
  const s2 = drive(page, host, row, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('11.3 归属建立之后、又真的读到它在 raw[0]：这才回执',
    s2.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(s2.newMainSessions.acknowledged));
  check('11.4 建立归属那一次写是有界的：回执之后不再写',
    host.calls.length === 1, 'calls=' + JSON.stringify(host.calls));
}

// ---------------------------------------------------------------------------
// 12. F1：写不落位时，写次数被预算卡住（不再是一场没完没了的 storm）
//
// daemon 每 2500ms 重发一次包，页面每趟写一次。宿主写不落位时，没有刹车就是
// 永远写下去。兄弟通道都有刹车（自动到顶 3 次、锁顶维持 3 次），这一段现在
// 也有：每个候选最多写 3 次，预算用完就【显式停手】，理由写进 deferred。
// ---------------------------------------------------------------------------
console.log('\n=== 12. 写不落位：写次数被预算卡住，停手原因可观察 ===');
{
  const page = makePage();
  // 这个宿主把下标丢了：新会话被【追加】到末尾，永远落不到 raw[0]。
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')], append: true });
  const row = makeRow(page, 'mvs_old', host);
  let last = null;
  for (let i = 1; i <= 6; i++) {
    last = drive(page, host, row, pkg({ seq: i, candidates: [{ id: 'mvs_new' }] }));
    await settle();
  }
  check('12.1 写不落位：写次数被预算卡住（上限 3 次，不是每趟一次没完没了）',
    host.calls.length === 3, 'calls=' + host.calls.length);
  check('12.2 预算用完：没有回执（它确实没落在 raw[0]）',
    last.newMainSessions.acknowledged.length === 0,
    JSON.stringify(last.newMainSessions));
  check('12.3 停手的原因写进了 deferred（一眼看得懂）',
    last.newMainSessions.deferred === 'write-budget-exhausted',
    String(last.newMainSessions.deferred));
  // run 变了（daemon 重启）：写预算整张表重置，新一轮从头再来。
  const s = drive(page, host, row, pkg({ run: T0 + 1, seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('12.4 run 变了：写预算重置，又写了一次',
    host.calls.length === 4, 'calls=' + host.calls.length);
  check('12.5 新 run 里仍然没有回执（它还是没落在 raw[0]）',
    s.newMainSessions.acknowledged.length === 0, JSON.stringify(s.newMainSessions));
}

// ---------------------------------------------------------------------------
// 13. 多候选：收敛、不乒乓、写次数有界
//
// 一个包里可能有好几个候选。写回执过的候选永远不再写；没回执但我们写过的那个
// 最多再写一次就收敛（预算兜底）。所以不会出现 A/B 互相顶来顶去。
// ---------------------------------------------------------------------------
console.log('\n=== 13. 多候选：收敛、不乒乓、写次数有界 ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_x'), ref('mvs_a'), ref('mvs_b')] });
  const row = makeRow(page, 'mvs_x', host);
  // a 比 b 老（包内按创建时间升序）。
  const cands = [{ id: 'mvs_a', createdAtMs: 10 }, { id: 'mvs_b', createdAtMs: 20 }];
  let last = null;
  for (let i = 1; i <= 6; i++) {
    last = drive(page, host, row, pkg({ seq: i, candidates: cands }));
    await settle();
  }
  check('13.1 终态：最新的那个在 raw[0]，被挤下去的老的在它下面',
    orderIds(host).join(',') === 'mvs_b,mvs_a,mvs_x', orderIds(host).join(','));
  check('13.2 两个候选都被回执',
    last.newMainSessions.acknowledged.slice().sort().join(',') === 'mvs_a,mvs_b',
    JSON.stringify(last.newMainSessions.acknowledged));
  check('13.3 不乒乓：写次数有界（每个候选只写一次，之后不再写）',
    host.calls.length === 2, 'calls=' + JSON.stringify(host.calls));
  check('13.4 被挤到 raw[1] 的那个 a 之后再没被写过（回执过的永远不再写）',
    host.calls.filter((c) => c[0] === 'mvs_a').length === 1, JSON.stringify(host.calls));
}

// ---------------------------------------------------------------------------
// 14. 宿主每次都拒绝：写尝试照样记账，预算照样卡住
//
// 预算记的是【尝试】，不是【成功】：宿主当场拒绝这一笔也是一次尝试，不记账的
// 话"每次都拒绝"的宿主就是另一场永久 storm。
// ---------------------------------------------------------------------------
console.log('\n=== 14. 宿主每次都拒绝：尝试照样记账，预算照样卡住 ===');
{
  const page = makePage();
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')], throws: true });
  const row = makeRow(page, 'mvs_old', host);
  let last = null;
  for (let i = 1; i <= 6; i++) {
    last = drive(page, host, row, pkg({ seq: i, candidates: [{ id: 'mvs_new' }] }));
    await settle();
  }
  check('14.1 宿主每次都拒绝：写尝试次数被预算卡住（上限 3 次）',
    host.calls.length === 3, 'calls=' + host.calls.length);
  check('14.2 被拒绝的写不算"我们放上去"（没有回执）',
    last.newMainSessions.acknowledged.length === 0,
    JSON.stringify(last.newMainSessions));
  check('14.3 停手的原因可观察',
    last.newMainSessions.deferred === 'write-budget-exhausted',
    String(last.newMainSessions.deferred));
}

console.log(fail === 0 ? '\ntest-new-main-page: ALL GREEN' : '\ntest-new-main-page: ' + fail + ' FAILED');
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
