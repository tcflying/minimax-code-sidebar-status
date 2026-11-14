// mmx-status :: test-new-main-fullpage.mjs
//
// FULL-PAGE behaviour test for the new-conversation channel.
//
// WHY THIS FILE EXISTS
//   test-new-main-page.mjs runs the new-main block NEXT TO the lock block. That
//   cannot see the conflicts that only exist when all FOUR channels share one
//   pass and one shared gate:
//
//     锁顶维持 (topLockTick) -> 自动到顶 (topmostAutoTopTick)
//       -> 活动会话上浮 (pinnedPromoteTick) -> 新对话 (newMainTick)
//
//   So this file boots the WHOLE page with the real buildBootstrapExpression
//   and drives the real apply() (api.refresh(status, pkg)). Nothing here is
//   sliced out of the shipped source: the production file is the one under
//   test.
//
// THE FAKE HOST
//   Shaped like the one in app.asar: handlePinSession(sessionId, pinned,
//   insertIndex).
//     - a pinned item is filtered out of the order and re-inserted at
//       insertIndex (0 = the very front); the other pinned items shift down;
//     - an unpinned item is "pin + front" in one step;
//     - the order array is replaced OPTIMISTICALLY and rolled back to the
//       previous array when the host refuses the write.
//
// THE LOCK
//   The lock intent is preset through localStorage ('mmxStatusTopLockV1'),
//   exactly like a previous session left it, so the REAL lock machine starts
//   on its own: real budget, real shared gate, real confirm.
//
//   The rule under test (user, 2026-11-15): a new conversation goes ABOVE the
//   locked one and becomes the first item. The lock gives way and STAYS locked.
//
// WHAT IS NOT PROVEN HERE
//   - The real renderer (CDP) is never touched.
//   - The daemon side (which sessions are candidates at all) is not exercised:
//     this file only proves what the PAGE does with the package it is handed.
//
//   node src/test-new-main-fullpage.mjs

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

// ---------------------------------------------------------------------------
// The fake host, shaped like the one in app.asar.
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

/**
 * opts.order      the pinned order the host starts with
 * opts.readOnly   ids the host refuses to touch
 * opts.fail       the host refuses every write: the optimistic update is rolled
 *                 back to the array that was there before, so the order never
 *                 changes -- this is the "write does not land" case.
 * opts.rejectIds  ids whose write REJECTS (async). The real host write is
 *                 async: a refusal arrives as a promise rejection, which a
 *                 try/catch around the call cannot see.
 */
function makeHost(opts = {}) {
  const h = {
    order: (opts.order || []).map((r) => ({ ...r })),
    source: opts.source || 'local',
    calls: [],
    persists: [],
    rollbacks: 0,
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
    // The host refuses THIS one: the promise rejects, the order never changes.
    if ((opts.rejectIds || []).includes(e)) throw new Error('host refused: ' + e);
    if (h.deps[0](e, h.source)) return;                // silent refusal
    await SessionInfo.getSessionInfo(e, undefined, h.source);
    const prev = h.order;
    const next = updatePinnedRefs(prev, { type: 'session', id: e }, l, c);
    h.deps[6](next);                                   // optimistic update
    if (opts.fail) {                                   // ... and the rollback
      h.deps[6](prev);
      h.rollbacks++;
      return;
    }
    await PinService.pinSession(e, l, l ? c : undefined, h.source);
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
function makeRow(dom, id, host) {
  const rowEl = dom.el('div', { 'data-session-id': id });
  dom.root.appendChild(rowEl);

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
// The harness: the REAL page, booted and driven.
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

/**
 * Boot the whole page.
 *   opts.lockId  preset the lock intent in localStorage (the real lock
 *                 machine picks it up on boot, exactly like a stored intent)
 *   opts.status  the status map the page paints from
 */
function bootPage(host, rowIds, opts = {}) {
  const dom = makeDom();
  dom.document.addEventListener = () => {};
  dom.document.removeEventListener = () => {};
  const win = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: makeStorage(opts.lockId
      ? { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: opts.lockId }) }
      : {}),
  };
  class FakeMO {
    constructor(fn) { this.fn = fn; }
    observe() {}
    disconnect() {}
  }
  // The rows must exist BEFORE the bootstrap: the factory runs apply() once.
  for (const id of rowIds) makeRow(dom, id, host);
  const expr = buildBootstrapExpression({ status: opts.status || {}, newMainSessions: null });
  const factory = new Function(
    'window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
    'getComputedStyle', 'localStorage', 'CSS',
    'return ' + expr + ';'
  );
  const result = factory(
    win, dom.document, FakeMO, win.requestAnimationFrame, win.cancelAnimationFrame,
    () => ({ position: 'relative' }), win.localStorage, { escape: (x) => String(x) }
  );
  return { dom, window: win, api: win.__mmxStatus, result };
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

/** One pass of the REAL apply(), then let the host's writes land. */
async function drive(page, p, status) {
  const stats = page.api.refresh(status || {}, p);
  await settle();
  return stats;
}

const lockOf = (page) => page.api.topLock();
const callsFor = (host, id) => host.calls.filter((c) => c[0] === id);

// ===========================================================================
console.log('\n=== 1. 宿主追加新对话 + 锁在 raw[0]：新对话排到最顶，锁让位 ===');
// The user rule: a new conversation goes ABOVE the locked one and becomes the
// first item. The lock gives way and STAYS locked.
{
  const host = makeHost({ order: [ref('mvs_lock')] });
  const page = bootPage(host, ['mvs_lock', 'mvs_new'], { lockId: 'mvs_lock' });
  check('1.0 前置：整页装载成功，锁意图从 localStorage 读回来了',
    !!(page.api && page.api.refresh) && lockOf(page).intent && lockOf(page).intent.id === 'mvs_lock',
    JSON.stringify(lockOf(page).intent));

  // 宿主自己追加了新对话（它在置顶区里，只是位置不对）。
  host.order = [ref('mvs_lock'), ref('mvs_new')];
  const s1 = await drive(page, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('1.1 新对话被写到 raw[0]（三参，第三参是 0）',
    callsFor(host, 'mvs_new').length === 1 && callsFor(host, 'mvs_new')[0][1] === true
    && callsFor(host, 'mvs_new')[0][2] === 0,
    JSON.stringify(host.calls));
  check('1.2 宿主自己的 order：新对话到了最顶，锁顺次下移',
    orderIds(host).join(',') === 'mvs_new,mvs_lock', orderIds(host).join(','));
  check('1.3 写还没生效：这一趟没有回执（resolve 不算生效）',
    s1.newMainSessions && s1.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s1.newMainSessions));

  // ---- 第二趟：锁让位 ----
  const s2 = await drive(page, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  const lock = lockOf(page);
  check('1.4 让位那一趟：锁一次宿主写都不发（不抢回 raw[0]）',
    callsFor(host, 'mvs_lock').length === 0, JSON.stringify(host.calls));
  check('1.5 让位那一趟：维持预算一格都没扣',
    lock.maintBudget === lock.maintBudgetMax && lock.maintCalls === 0,
    'budget=' + lock.maintBudget + '/' + lock.maintBudgetMax + ' maintCalls=' + lock.maintCalls);
  check('1.6 让位的理由是 yielded-to-new-main',
    lock.reason === 'yielded-to-new-main', lock.reason);
  check('1.7 让位时锁仍然成立（红箭头继续亮着）',
    lock.confirmedAtTop === true && lock.confirmedId === 'mvs_lock',
    'atTop=' + lock.confirmedAtTop + ' id=' + lock.confirmedId);
  check('1.8 让位对象被记下来了（我们自己放到 raw[0] 的那个 id）',
    lock.yieldedTo === 'mvs_new', lock.yieldedTo);
  // 让位是【持续】的，不是只让一趟。
  await drive(page, pkg({ seq: 3, candidates: [{ id: 'mvs_new' }] }));
  check('1.9 让位是持续的：再走一趟还是零宿主写',
    callsFor(host, 'mvs_lock').length === 0, JSON.stringify(host.calls));
  check('1.10 读到 order[0] 就是它：这才回执',
    s2.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(s2.newMainSessions.acknowledged));
  check('1.11 回执之后不再写',
    callsFor(host, 'mvs_new').length === 1, JSON.stringify(host.calls));
}

// ===========================================================================
console.log('\n=== 2. 宿主自己把新对话放到 raw[0]：不假回执，先建立归属 ===');
// The host put the candidate at raw[0] on its own. The page never wrote it, so
// the yield predicate does not hold and the lock is free to take raw[0] back.
// The old receipt rule ("order[0] is it" -> acked) told the daemon "applied"
// while the candidate was really second: the daemon dropped it from pending and
// never sent it again.
{
  const host = makeHost({ order: [ref('mvs_lock')] });
  const page = bootPage(host, ['mvs_lock', 'mvs_new'], { lockId: 'mvs_lock' });
  // 宿主自己把新对话顶到了最顶。
  host.order = [ref('mvs_new'), ref('mvs_lock')];

  const s1 = await drive(page, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('2.1 宿主自己放的候选：这一趟【不】回执（我们还没写过它）',
    s1.newMainSessions && s1.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s1.newMainSessions));

  // 归属建立：页面写它一次（幂等），把"这是我们放的"这个事实立起来。
  await drive(page, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('2.2 页面写它一次建立归属（三参，落点 0）',
    callsFor(host, 'mvs_new').length === 1 && callsFor(host, 'mvs_new')[0][2] === 0,
    JSON.stringify(host.calls));
  check('2.3 终态：新对话稳在 raw[0]',
    orderIds(host).join(',') === 'mvs_new,mvs_lock', orderIds(host).join(','));

  const s3 = await drive(page, pkg({ seq: 3, candidates: [{ id: 'mvs_new' }] }));
  const lock = lockOf(page);
  check('2.4 归属建立之后锁让位（raw[0] 是我们自己放上去的那个）',
    lock.reason === 'yielded-to-new-main' && lock.yieldedTo === 'mvs_new',
    lock.reason + '/' + lock.yieldedTo);
  check('2.5 让位之后锁不再抢回 raw[0]',
    callsFor(host, 'mvs_lock').length === 1,   // 只有最开始那一次抢回
    JSON.stringify(host.calls));
  check('2.6 回执成立（我们放上去的、而且真的读到它在 raw[0]）',
    s3.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(s3.newMainSessions.acknowledged));
}

// ===========================================================================
console.log('\n=== 3. 宿主写不落位：写次数被预算卡住，停手原因可观察 ===');
{
  // 这个宿主每一次写都回滚：顺序永远不动，新对话永远落不到 raw[0]。
  const host = makeHost({ order: [ref('mvs_old'), ref('mvs_new')], fail: true });
  const page = bootPage(host, ['mvs_old', 'mvs_new']);
  let last = null;
  for (let i = 1; i <= 6; i++) {
    last = await drive(page, pkg({ seq: i, candidates: [{ id: 'mvs_new' }] }));
  }
  check('3.1 写不落位：写次数被预算卡住（上限 3 次，不是每趟一次没完没了）',
    callsFor(host, 'mvs_new').length === 3, 'calls=' + JSON.stringify(host.calls));
  check('3.2 顺序确实没动过（新对话还在第二位）',
    orderIds(host).join(',') === 'mvs_old,mvs_new', orderIds(host).join(','));
  check('3.3 没有回执（它确实没落在 raw[0]）',
    last.newMainSessions.acknowledged.length === 0,
    JSON.stringify(last.newMainSessions));
  check('3.4 停手的原因写进了 deferred（一眼看得懂）',
    last.newMainSessions.deferred === 'write-budget-exhausted',
    String(last.newMainSessions.deferred));
}

// ===========================================================================
console.log('\n=== 4. 多个候选：收敛、不乒乓、写次数有界 ===');
{
  const host = makeHost({ order: [ref('mvs_x'), ref('mvs_a'), ref('mvs_b')] });
  const page = bootPage(host, ['mvs_x', 'mvs_a', 'mvs_b']);
  // a 比 b 老（包内按创建时间升序）。
  const cands = [{ id: 'mvs_a', createdAtMs: 10 }, { id: 'mvs_b', createdAtMs: 20 }];
  let last = null;
  for (let i = 1; i <= 6; i++) {
    last = await drive(page, pkg({ seq: i, candidates: cands }));
  }
  check('4.1 终态：最新的那个在 raw[0]，被挤下去的老的在它下面',
    orderIds(host).join(',') === 'mvs_b,mvs_a,mvs_x', orderIds(host).join(','));
  check('4.2 两个候选都被回执',
    last.newMainSessions.acknowledged.slice().sort().join(',') === 'mvs_a,mvs_b',
    JSON.stringify(last.newMainSessions.acknowledged));
  check('4.3 不乒乓：写次数有界（每个候选只写一次）',
    callsFor(host, 'mvs_a').length === 1 && callsFor(host, 'mvs_b').length === 1,
    JSON.stringify(host.calls));
  check('4.4 别的通道没有插一脚（整页只有新对话通道写了这几个 id）',
    host.calls.every((c) => c[0] === 'mvs_a' || c[0] === 'mvs_b'),
    JSON.stringify(host.calls));
}

// ===========================================================================
console.log('\n=== 5. 用户拖走 / 别人手动置顶：锁按原语义抢回 raw[0] ===');
{
  const host = makeHost({ order: [ref('mvs_lock')] });
  const page = bootPage(host, ['mvs_lock', 'mvs_new'], { lockId: 'mvs_lock' });
  host.order = [ref('mvs_lock'), ref('mvs_new')];
  await drive(page, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  await drive(page, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  check('5.0 前置：新对话在 raw[0]，锁在第二位，锁在让位',
    orderIds(host).join(',') === 'mvs_new,mvs_lock' && lockOf(page).reason === 'yielded-to-new-main',
    orderIds(host).join(',') + ' / ' + lockOf(page).reason);

  // 用户把新对话拖走了：raw[0] 不再是我们自己放上去的那个。
  host.order = [ref('mvs_other'), ref('mvs_lock'), ref('mvs_new')];
  await drive(page, pkg({ seq: 3, candidates: [{ id: 'mvs_new' }] }));
  check('5.1 新对话被拖走：锁抢回 raw[0]（发一次三参写）',
    callsFor(host, 'mvs_lock').length === 1 && callsFor(host, 'mvs_lock')[0][2] === 0,
    JSON.stringify(host.calls));
  check('5.2 抢回之后宿主自己的 order：锁回到最顶',
    orderIds(host).join(',') === 'mvs_lock,mvs_other,mvs_new', orderIds(host).join(','));
  check('5.3 让位结束：理由不再是 yielded-to-new-main',
    lockOf(page).reason !== 'yielded-to-new-main', lockOf(page).reason);
  check('5.4 回执过的候选不再被写（用户的拖拽说了算）',
    callsFor(host, 'mvs_new').length === 1, JSON.stringify(host.calls));

  // 别人手动置顶了另一个会话：同一件事，同一条老行为。
  const host2 = makeHost({ order: [ref('mvs_lock')] });
  const page2 = bootPage(host2, ['mvs_lock', 'mvs_new'], { lockId: 'mvs_lock' });
  host2.order = [ref('mvs_lock'), ref('mvs_new')];
  await drive(page2, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  await drive(page2, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  host2.order = [ref('mvs_manual'), ref('mvs_new'), ref('mvs_lock')];
  await drive(page2, pkg({ seq: 3, candidates: [{ id: 'mvs_new' }] }));
  check('5.5 别人手动置顶的会话在 raw[0]：锁抢回 raw[0]',
    callsFor(host2, 'mvs_lock').length === 1, JSON.stringify(host2.calls));
  check('5.6 抢回之后宿主自己的 order：锁回到最顶',
    orderIds(host2).join(',') === 'mvs_lock,mvs_manual,mvs_new', orderIds(host2).join(','));
}

// ===========================================================================
console.log('\n=== 6. 后面那个新对话的写没落位：让位记录不能被顶掉（P1） ===');
// X 已经落位在 raw[0] 并且已经回执。随后 Y 到达，但 Y 的宿主写【没落位】
// （异步 reject：宿主写是异步的，try/catch 抓不到）。旧口径只认"最后一次写
// 的那个 id"，于是 Y 把 X 的让位记录顶掉，锁下一趟抢回 raw[0]，X 永久掉到
// 第二位——X 已经被回执过，daemon 不会再送回来，这一掉就是永久的。
{
  const host = makeHost({ order: [ref('mvs_lock'), ref('mvs_x')], rejectIds: ['mvs_y'] });
  const page = bootPage(host, ['mvs_lock', 'mvs_x', 'mvs_y'], { lockId: 'mvs_lock' });

  // 第一趟：X 被写到 raw[0]。
  await drive(page, pkg({ seq: 1, candidates: [{ id: 'mvs_x' }] }));
  // 第二趟：真的读到 X 在 raw[0] → 回执；锁让位。
  const s2 = await drive(page, pkg({ seq: 2, candidates: [{ id: 'mvs_x' }] }));
  check('6.1 前置：X 落位在 raw[0] 且已回执，锁在第二位',
    orderIds(host).join(',') === 'mvs_x,mvs_lock'
    && s2.newMainSessions.acknowledged.join(',') === 'mvs_x',
    orderIds(host).join(',') + ' / ' + JSON.stringify(s2.newMainSessions.acknowledged));

  // 宿主自己把 Y 放进置顶区（它在 raw[1]），Y 比 X 新。
  host.order = [ref('mvs_x'), ref('mvs_y'), ref('mvs_lock')];
  // 这一趟：Y 的写发起了，但被宿主拒绝（reject），没落位。
  const s3 = await drive(page, pkg({ seq: 3, candidates: [{ id: 'mvs_x' }, { id: 'mvs_y' }] }));
  check('6.2 Y 的写确实发起过（被拒的那一次也在案）',
    callsFor(host, 'mvs_y').length === 1, JSON.stringify(host.calls));
  check('6.3 Y 没落位：raw[0] 仍然是 X',
    orderIds(host).join(',') === 'mvs_x,mvs_y,mvs_lock', orderIds(host).join(','));

  // 再走两趟：每一趟锁都在看 raw[0]。没落位的那次写不能顶掉让位记录。
  await drive(page, pkg({ seq: 4, candidates: [{ id: 'mvs_x' }, { id: 'mvs_y' }] }));
  const s5 = await drive(page, pkg({ seq: 5, candidates: [{ id: 'mvs_x' }, { id: 'mvs_y' }] }));
  const lock = lockOf(page);
  check('6.4 锁零写：一次都没抢回 raw[0]',
    callsFor(host, 'mvs_lock').length === 0, JSON.stringify(host.calls));
  check('6.5 锁的维持预算一格未扣',
    lock.maintBudget === lock.maintBudgetMax && lock.maintCalls === 0,
    'budget=' + lock.maintBudget + '/' + lock.maintBudgetMax + ' maintCalls=' + lock.maintCalls);
  check('6.6 X 仍在 raw[0]（没被锁顶挤到第二位）',
    orderIds(host)[0] === 'mvs_x', orderIds(host).join(','));
  check('6.7 让位对象仍是 X（不是没落位的 Y）',
    lock.yieldedTo === 'mvs_x' && lock.reason === 'yielded-to-new-main',
    lock.yieldedTo + '/' + lock.reason);
  check('6.8 X 的回执仍然成立',
    s5.newMainSessions.acknowledged.join(',') === 'mvs_x',
    JSON.stringify(s5.newMainSessions.acknowledged));
}

console.log(fail === 0 ? '\ntest-new-main-fullpage: ALL GREEN' : '\ntest-new-main-fullpage: ' + fail + ' FAILED');
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
