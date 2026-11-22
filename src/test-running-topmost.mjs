// mmx-status :: test-running-topmost.mjs
//
// 活动会话上浮（正在跑的会话跳到置顶区最顶）—— 用户 2026-11-23 确认的口径。
//
// WHAT THIS FILE IS
//   用户诉求原话：「最新会话不会自动置顶」。主会话用只读证据排除了另外两种读法
//   之后，用户在问卷里明确选了：**正在跑的会话要跳到最顶**。
//
//   这份文件的对手是那条通道（pinnedPromoteTick，仓库注释里写的「已置顶的会话
//   开始对话后浮到置顶区最顶部」）——它就是用户要的功能，而它当时**一次宿主写
//   都不发**：真机日志共 2544 条 tick 行（tick 号 10…26010，19050 是其中一趟的
//   tick 号、不是趟数），pinnedPromote.calls 恒 0、deferred 涨（4400 那趟页面
//   重注入归零一次），lastReason 是 toplock-other 2542 条 + view-unstable 2 条。
//
//   根因：topmostLockSlot() 在「锁存在、但它自己已经不在 raw[0]」时返回
//   blocked='lock-not-at-top'，而 pinnedPromoteTick() 在**候选扫描之前**就
//   return 了。那一支的含义是「锁已经让位」（可证的事实），不是「证不出来」。
//
// TWO HARNESSES, ONE CODE PATH
//
//   A. makePage()  装载**整页**（真的 buildBootstrapExpression）：真的锁机器、
//      真的新对话通道、真的上浮通道、真的共享闸。这一份证明的是「锁让位」这件
//      事在**四通道合流**里成立：活动会话上浮写到 raw[0] 之后，锁必须让位而不是
//      把 raw[0] 抢回去。
//
//   B. makePromotePage() 把「到最顶」那一块**真的**从 page-script.mjs 里切出来
//      编译执行（跟 test-new-pin-adversarial.mjs 同一个切片），用来单独打四种
//      blocked、预算、升沿、already-top 这些整页里不好摆的场景。
//
//   两份都断言**宿主 order 的最终顺序**（用户看得见的东西），不是"间谍看到几个
//   参数"。
//
// WHAT IS NOT PROVEN HERE
//   - 真机 GUI 没跑（本轮只改代码，验收由主会话做）。
//   - 真实渲染器（CDP）没碰。
//
//   node src/test-running-topmost.mjs

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

// ===========================================================================
// 假宿主：复刻 app.asar 里 handlePinSession(sessionId, pinned, insertIndex)
// ===========================================================================
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
const orderIds = (cap) => cap.order.filter((r) => r.type === 'session').map((r) => String(r.id)).join(',');

// 一份手写的 cap：切出来的那一段只认 cap.order / cap.source / cap.fn / cap.probe。
function makeCap(order, opts = {}) {
  const cap = {
    order: (order || []).map((r) => ({ ...r })),
    source: opts.source || 'local',
    calls: [],
    probes: [],
  };
  cap.probe = (id, source) => {
    cap.probes.push(`${id}@${source}`);
    return (opts.readOnly || []).includes(id);
  };
  cap.fn = (id, pinned, insertIndex) => {
    cap.calls.push([id, pinned, insertIndex]);
    if (opts.noLand) return Promise.resolve();          // 宿主接下了，但顺序不动
    const next = updatePinnedRefs(cap.order, { type: 'session', id }, pinned, insertIndex);
    cap.order = next;
    return Promise.resolve();
  };
  return cap;
}

// ===========================================================================
// 切片 B：真的「到最顶」那一块
// ===========================================================================
const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}
// 跟 test-new-pin-adversarial.mjs 同一个切片：写点、闸、落点判据、状态基线全在里面。
const BLOCK = sliceBlock("  var TOPMOST_LABEL = '到最顶';", '  var handler = function () { scheduleApply(); };');
if (!BLOCK.includes('function pinnedPromoteTick(')
  || !BLOCK.includes('function topmostLockSlot(')
  || !BLOCK.includes('function promoteLanded(')) {
  throw new Error('the promote block is missing from the shipped source');
}

function makePromotePage() {
  const dom = makeDom();
  const win = { setTimeout: () => 0, clearTimeout: () => {} };
  win.MutationObserver = dom.observers.MutationObserver;
  const factory = new Function(
    'window', 'document',
    'var disposed = false;\n' + BLOCK +
    '\nreturn {' +
    '  promoteTick: function (c, s) { return pinnedPromoteTick(c, s); },' +
    '  promoteState: promoteState,' +
    '  lockView: topmostLockView,' +
    '  lockSlot: function (c) { return topmostLockSlot(c); },' +
    '  hoisted: function () { return promoteHoistedIds.slice(); },' +
    '  runtime: function () { return promoteRuntime(); },' +
    '  max: TOPMOST_PROMOTE_MAX };'
  );
  const api = factory(win, dom.document);
  return { dom, window: win, api };
}
const ptick = async (p, cap, status) => { p.api.promoteTick(cap, status || {}); await flush(); };
// 两趟把基线架起来：第一趟是防抖（settleMiss），第二趟记下第一份可信的
// (id, running) 集合。两趟都是只读的。
const arm = async (p, cap) => { await ptick(p, cap, {}); await ptick(p, cap, {}); };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// ===========================================================================
// 整页 A：真的 buildBootstrapExpression
// ===========================================================================
const SessionInfo = { getSessionInfo: async (id) => ({ id }) };
const PinService = { calls: [], async pinSession() { PinService.calls.push([...arguments]); } };

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

// 一行会话：div[data-session-id]，fiber 链走到带七依赖 handlePinSession 的容器。
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
 * 装载整页。
 *   opts.lockId  用 localStorage 预置锁意图（跟上一次会话留下的意图一模一样），
 *                于是真的锁机器自己起来：真的预算、真的共享闸、真的确认。
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
const T0 = 1700000000000;
const hostOrder = (host) => host.order.map((r) => String(r.id)).join(',');
const callsFor = (host, id) => host.calls.filter((c) => c[0] === id);

/** 一份新对话包，形状跟 daemon 送的一模一样。 */
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

/** 一趟真的 apply()，然后让宿主的写落下来。 */
async function drive(page, p, status) {
  const stats = page.api.refresh(status || {}, p);
  await settle();
  return stats;
}

// ===========================================================================
console.log('\n=== 1. 整页：锁已经让位时，正在跑的会话跳到 raw[0]（R1 + R2） ===');
// 真机现场：锁顶的会话已经被新对话挤下去（锁让位，phase 仍是 confirmed），
// 正在跑的那个会话卡在可见列表第七行。期望：它被写到 raw[0]，写点仍然是宿主
// 自己的三参函数 cap.fn(id, true, 0)，锁不跟它抢。
{
  const host = makeHost({ order: [ref('mvs_lock'), ref('mvs_new'), ref('mvs_run')] });
  const page = bootPage(host, ['mvs_lock', 'mvs_new', 'mvs_run'], { lockId: 'mvs_lock' });

  // 新对话包到达：新对话被写到 raw[0]，锁顺次下移。
  await drive(page, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  check('1.1 新对话写到 raw[0]（锁顺次下移一位，那是让位不是失败）',
    callsFor(host, 'mvs_new').length === 1 && callsFor(host, 'mvs_new')[0][2] === 0
    && hostOrder(host) === 'mvs_new,mvs_lock,mvs_run',
    `calls=${JSON.stringify(host.calls)} order=${hostOrder(host)}`);

  // 这一趟：锁认这一次让位（raw[0] 是我们自己放上去的新对话），零写零扣预算。
  await drive(page, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  const lock2 = page.api.topLock();
  check('1.2 锁认下让位（yielded-to-new-main），一次宿主写都不发',
    lock2.reason === 'yielded-to-new-main' && lock2.yieldedTo === 'mvs_new'
    && callsFor(host, 'mvs_lock').length === 0,
    `reason=${lock2.reason} yieldedTo=${lock2.yieldedTo} calls=${JSON.stringify(host.calls)}`);

  // 现在那个正在跑的会话开始对话：idle -> running。
  const before = host.calls.length;
  const s3 = await drive(page, pkg({ seq: 3, candidates: [{ id: 'mvs_new' }] }), { mvs_run: 'running' });
  check('1.3 正在跑的会话被写到 raw[0]：三参，第三参是 0（R2）',
    callsFor(host, 'mvs_run').length === 1
    && JSON.stringify(callsFor(host, 'mvs_run')[0]) === JSON.stringify(['mvs_run', true, 0]),
    `calls=${JSON.stringify(host.calls)}`);
  check('1.4 不是 defer：这一趟发了宿主写（真机那一版恒 0）',
    host.calls.length === before + 1,
    `before=${before} after=${host.calls.length}`);
  check('1.5 宿主自己的顺序：运行会话到了最顶，锁在下面',
    hostOrder(host) === 'mvs_run,mvs_new,mvs_lock', hostOrder(host));
  check('1.6 锁没有跟它抢（锁自己零写，维持预算一格未扣）',
    callsFor(host, 'mvs_lock').length === 0
    && page.api.topLock().maintCalls === 0
    && page.api.topLock().maintBudget === page.api.topLock().maintBudgetMax,
    `lockCalls=${callsFor(host, 'mvs_lock').length} maint=${page.api.topLock().maintBudget}/${page.api.topLock().maintBudgetMax}`);

  // 下一趟：锁看 raw[0] 是谁。它认的是【我们自己发起过写的那一组 id】的并集，
  // 活动会话上浮那一组在里面（R3），所以锁让位，不抢回 raw[0]。
  await drive(page, pkg({ seq: 4, candidates: [{ id: 'mvs_new' }] }), { mvs_run: 'running' });
  const lock4 = page.api.topLock();
  check('1.7 让位判据认活动会话那一组：锁让位给运行会话，零写零扣预算',
    lock4.reason === 'yielded-to-new-main' && lock4.yieldedTo === 'mvs_run'
    && callsFor(host, 'mvs_lock').length === 0
    && lock4.maintCalls === 0 && lock4.maintBudget === lock4.maintBudgetMax,
    `reason=${lock4.reason} yieldedTo=${lock4.yieldedTo} maint=${lock4.maintBudget}`);
  check('1.8 锁仍然成立（红箭头继续亮着，让位不是解除）',
    lock4.confirmedAtTop === true && lock4.confirmedId === 'mvs_lock',
    `atTop=${lock4.confirmedAtTop} id=${lock4.confirmedId}`);
  check('1.9 运行会话的位置保住了（没有掉回第二位）',
    hostOrder(host) === 'mvs_run,mvs_new,mvs_lock', hostOrder(host));
  check('1.10 活动会话的登记不进新对话回执（它不是一次新对话交付）',
    s3.newMainSessions && s3.newMainSessions.acknowledged.join(',') === 'mvs_new',
    JSON.stringify(s3.newMainSessions && s3.newMainSessions.acknowledged));
}

// ===========================================================================
console.log('\n=== 2. 整页：升沿只消费一次 + 理由码可观察（R5 + R6） ===');
{
  const host = makeHost({ order: [ref('mvs_lock'), ref('mvs_new'), ref('mvs_run')] });
  const page = bootPage(host, ['mvs_lock', 'mvs_new', 'mvs_run'], { lockId: 'mvs_lock' });
  await drive(page, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  await drive(page, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  await drive(page, pkg({ seq: 3, candidates: [{ id: 'mvs_new' }] }), { mvs_run: 'running' });
  const writes = host.calls.length;
  check('2.1 前置：运行会话已经浮到 raw[0]',
    hostOrder(host) === 'mvs_run,mvs_new,mvs_lock' && callsFor(host, 'mvs_run').length === 1,
    `order=${hostOrder(host)}`);
  await drive(page, pkg({ seq: 4, candidates: [{ id: 'mvs_new' }] }), { mvs_run: 'running' });
  await drive(page, pkg({ seq: 5, candidates: [{ id: 'mvs_new' }] }), { mvs_run: 'running' });
  check('2.2 持续 running 不重复写（升沿只消费一次，不是每趟重排）',
    host.calls.length === writes && callsFor(host, 'mvs_run').length === 1,
    `calls=${JSON.stringify(host.calls)}`);
  check('2.3 理由码是 running-hoisted（daemon 日志里能看出是上浮写的）',
    page.api.topmost().pinnedPromote.lastReason === 'running-hoisted',
    page.api.topmost().pinnedPromote.lastReason);
  check('2.4 上浮那条通道的计数可观察（calls=1、deferred 不再每趟涨）',
    page.api.topmost().pinnedPromote.calls === 1
    && page.api.topmost().pinnedPromote.deferred === 0,
    JSON.stringify(page.api.topmost().pinnedPromote));
}

// ===========================================================================
console.log('\n=== 3. 整页：run 变更清空新对话的记忆，不清空活动会话的（R3） ===');
// daemon 每次应用自动更新都会重启 → run 边界变了 → 新对话那一组记忆清掉（既有
// 设计，§15.18 已知副作用）。活动会话那一组【不清空】：清掉它的话运行会话刚
// 浮上去就被锁抢回 raw[0]，而它的升沿已经消费掉、再也不会上来。
{
  const host = makeHost({ order: [ref('mvs_lock'), ref('mvs_new'), ref('mvs_run')] });
  const page = bootPage(host, ['mvs_lock', 'mvs_new', 'mvs_run'], { lockId: 'mvs_lock' });
  await drive(page, pkg({ seq: 1, candidates: [{ id: 'mvs_new' }] }));
  await drive(page, pkg({ seq: 2, candidates: [{ id: 'mvs_new' }] }));
  await drive(page, pkg({ seq: 3, candidates: [{ id: 'mvs_new' }] }), { mvs_run: 'running' });
  await drive(page, pkg({ seq: 4, candidates: [{ id: 'mvs_new' }] }), { mvs_run: 'running' });

  // run 变了（daemon 重启），包里没有新对话了。
  const s5 = await drive(page, pkg({ run: T0 + 99999, seq: 5, candidates: [] }), { mvs_run: 'running' });
  check('3.1 新对话的记忆随 run 变更清空（回执归零，既有行为不许回归）',
    s5.newMainSessions && s5.newMainSessions.acknowledged.length === 0,
    JSON.stringify(s5.newMainSessions));
  check('3.2 活动会话的登记没被清空：锁仍然让位，运行会话保住 raw[0]',
    page.api.topLock().reason === 'yielded-to-new-main'
    && page.api.topLock().yieldedTo === 'mvs_run'
    && callsFor(host, 'mvs_lock').length === 0
    && hostOrder(host) === 'mvs_run,mvs_new,mvs_lock',
    `reason=${page.api.topLock().reason} order=${hostOrder(host)}`);
}

// ===========================================================================
console.log('\n=== 4. 切片：其余四种 blocked 一次宿主写都不发生（R1 的硬拒绝） ===');
// 'lock-not-at-top' 被放行之后，那四条「证不出来」的仍然一条都不放宽。
{
  // 4.1 view-unstable：order 不是一个真数组（数组样的对象）。这是唯一还能走到
  //     topmostLockSlot 的 view-unstable 那一支的形状：ids 循环照样读得出成员，
  //     而 isArray 说它不是数组。
  {
    const p = makePromotePage();
    const good = makeCap([ref('mvs_other'), ref('mvs_run')]);
    await arm(p, good);
    p.api.lockView.id = 'mvs_lock';
    const weird = makeCap([]);
    weird.order = { length: 2, 0: { type: 'session', id: 'mvs_other' }, 1: { type: 'session', id: 'mvs_run' } };
    weird.source = 'local';
    check('4.1 前置：这一份 order 真的不是数组，但成员读得出来',
      p.api.lockSlot(weird).blocked === 'view-unstable',
      JSON.stringify(p.api.lockSlot(weird)));
    await ptick(p, weird, { mvs_run: 'running' });
    check('4.1 view-unstable：零宿主写，对外报 toplock-other',
      weird.calls.length === 0 && p.api.promoteState.calls === 0
      && p.api.promoteState.deferred >= 1
      && p.api.promoteState.lastReason === 'toplock-other',
      `calls=${JSON.stringify(weird.calls)} reason=${p.api.promoteState.lastReason}`);
    // 这一次升沿没被吃掉：视图恢复之后它照样被浮上去。
    p.api.lockView.id = '';
    await ptick(p, good, { mvs_run: 'running' });
    check('4.1 证不出来的那一趟没有吃掉这次升沿（视图恢复后照样补上）',
      good.calls.length === 1
      && JSON.stringify(good.calls[0]) === JSON.stringify(['mvs_run', true, 0]),
      `calls=${JSON.stringify(good.calls)}`);
  }
  // 4.2 source-not-local：不是本地视图。
  {
    const p = makePromotePage();
    const good = makeCap([ref('mvs_run'), ref('mvs_other')]);
    await arm(p, good);
    p.api.lockView.id = 'mvs_lock';
    const cap = makeCap([ref('mvs_run'), ref('mvs_other')], { source: 'cloud' });
    check('4.2 前置：落点判据说 source-not-local',
      p.api.lockSlot(cap).blocked === 'source-not-local', JSON.stringify(p.api.lockSlot(cap)));
    await ptick(p, cap, { mvs_run: 'running' });
    check('4.2 source-not-local：零宿主写，对外报 toplock-other',
      cap.calls.length === 0 && p.api.promoteState.calls === 0
      && p.api.promoteState.deferred >= 1
      && p.api.promoteState.lastReason === 'toplock-other',
      `calls=${JSON.stringify(cap.calls)} reason=${p.api.promoteState.lastReason}`);
  }
  // 4.3 not-local-id：锁的 id 不是本地 id（裸数字 = 云端 id）。
  {
    const p = makePromotePage();
    const good = makeCap([ref('mvs_run'), ref('mvs_other')]);
    await arm(p, good);
    p.api.lockView.id = '447993841729699';
    const cap = makeCap([ref('mvs_run'), ref('mvs_other')]);
    check('4.3 前置：落点判据说 not-local-id',
      p.api.lockSlot(cap).blocked === 'not-local-id', JSON.stringify(p.api.lockSlot(cap)));
    await ptick(p, cap, { mvs_run: 'running' });
    check('4.3 not-local-id：零宿主写，对外报 toplock-other',
      cap.calls.length === 0 && p.api.promoteState.calls === 0
      && p.api.promoteState.deferred >= 1
      && p.api.promoteState.lastReason === 'toplock-other',
      `calls=${JSON.stringify(cap.calls)} reason=${p.api.promoteState.lastReason}`);
  }
  // 4.4 order-missing-id：锁的 id 不在宿主 order 里。
  {
    const p = makePromotePage();
    const good = makeCap([ref('mvs_run'), ref('mvs_other')]);
    await arm(p, good);
    p.api.lockView.id = 'mvs_lock';
    const cap = makeCap([ref('mvs_run'), ref('mvs_other')]);
    check('4.4 前置：落点判据说 order-missing-id',
      p.api.lockSlot(cap).blocked === 'order-missing-id', JSON.stringify(p.api.lockSlot(cap)));
    await ptick(p, cap, { mvs_run: 'running' });
    check('4.4 order-missing-id：零宿主写，对外报 toplock-other',
      cap.calls.length === 0 && p.api.promoteState.calls === 0
      && p.api.promoteState.deferred >= 1
      && p.api.promoteState.lastReason === 'toplock-other',
      `calls=${JSON.stringify(cap.calls)} reason=${p.api.promoteState.lastReason}`);
  }
}

// ===========================================================================
console.log('\n=== 5. 切片：锁自己永不当候选（R4） ===');
// 让位那一支里 lockSlot.lock 是空字符串，"排除锁自己"那条判据本来会失效。
// 锁自己正在跑的时候也绝不能被写：它必须留在它该在的位置。
{
  const p = makePromotePage();
  p.api.lockView.id = 'mvs_lock';
  const cap = makeCap([ref('mvs_other'), ref('mvs_lock')]);
  await arm(p, cap);
  check('5.0 前置：锁在 order 里但不在 raw[0]（lock-not-at-top）',
    p.api.lockSlot(cap).blocked === 'lock-not-at-top', JSON.stringify(p.api.lockSlot(cap)));
  await ptick(p, cap, { mvs_lock: 'running' });
  check('5.1 锁自己正在跑也不写它（零宿主写）',
    cap.calls.length === 0 && p.api.promoteState.calls === 0,
    `calls=${JSON.stringify(cap.calls)}`);
  check('5.2 锁自己被排除之后，这一趟什么候选都没有（changes=0）',
    p.api.promoteState.changes === 0 && p.api.promoteState.noChange >= 1,
    `changes=${p.api.promoteState.changes} noChange=${p.api.promoteState.noChange}`);
  check('5.3 顺序一个字节没动',
    orderIds(cap) === 'mvs_other,mvs_lock', orderIds(cap));
}

// ===========================================================================
console.log('\n=== 6. 切片：锁不在 raw[0] 时，活动会话被写到 raw[0]（R1 + R2） ===');
{
  const p = makePromotePage();
  p.api.lockView.id = 'mvs_lock';
  const cap = makeCap([ref('mvs_other'), ref('mvs_lock'), ref('mvs_run')]);
  await arm(p, cap);
  await ptick(p, cap, { mvs_run: 'running' });
  check('6.1 不是 defer：这一趟发了宿主写',
    p.api.promoteState.calls === 1 && p.api.promoteState.deferred === 0,
    `calls=${p.api.promoteState.calls} deferred=${p.api.promoteState.deferred}`);
  check('6.2 写点仍是宿主自己的三参函数，第三参是 0（R2）',
    cap.calls.length === 1
    && JSON.stringify(cap.calls[0]) === JSON.stringify(['mvs_run', true, 0]),
    JSON.stringify(cap.calls));
  check('6.3 宿主自己的顺序：运行会话到了 raw[0]，锁顺次下移',
    orderIds(cap) === 'mvs_run,mvs_other,mvs_lock', orderIds(cap));
  check('6.4 理由码是 running-hoisted（R6）',
    p.api.promoteState.lastReason === 'running-hoisted', p.api.promoteState.lastReason);
  check('6.5 上浮通道把自己的 id 登记进让位判据认的那一组（R3）',
    p.api.hoisted().indexOf('mvs_run') >= 0, JSON.stringify(p.api.hoisted()));
  // 下一趟：宿主改了顺序，防抖吃掉一趟；再下一趟才轮到落位确认，基线推进。
  await ptick(p, cap, { mvs_run: 'running' });
  await ptick(p, cap, { mvs_run: 'running' });
  check('6.6 落位被确认（confirmed 计数 +1），仍然零新写',
    p.api.promoteState.confirmed >= 1 && cap.calls.length === 1,
    `confirmed=${p.api.promoteState.confirmed} calls=${JSON.stringify(cap.calls)}`);
  // 再下一趟：升沿已经消费掉，持续 running 不重复写。
  await ptick(p, cap, { mvs_run: 'running' });
  await ptick(p, cap, { mvs_run: 'running' });
  check('6.7 升沿只消费一次：持续 running 不重复写（R5）',
    cap.calls.length === 1 && p.api.promoteState.calls === 1,
    `calls=${JSON.stringify(cap.calls)}`);
}

// ===========================================================================
console.log('\n=== 7. 切片：预算有界 + already-top（R5） ===');
{
  // 7.1 宿主接下写但顺序不动：确认失败扣预算，扣满 3 次显式停手。
  const p = makePromotePage();
  p.api.lockView.id = 'mvs_lock';
  const cap = makeCap([ref('mvs_other'), ref('mvs_lock'), ref('mvs_run')], { noLand: true });
  await arm(p, cap);
  for (let i = 0; i < 8; i++) await ptick(p, cap, { mvs_run: 'running' });
  check('7.1 写次数有界（每个会话最多 3 次，不是每趟一次没完没了）',
    cap.calls.length === p.api.max && cap.calls.length === 3,
    `calls=${cap.calls.length} max=${p.api.max}`);
  check('7.2 预算耗尽后显式停手，理由码是 budget-exhausted',
    p.api.promoteState.exhausted >= 1
    && p.api.promoteState.lastReason === 'budget-exhausted',
    `exhausted=${p.api.promoteState.exhausted} reason=${p.api.promoteState.lastReason}`);
  check('7.3 预算槽归零且归在这一趟的会话名下',
    p.api.runtime() && p.api.runtime().budget === 0 && p.api.runtime().owner === 'mvs_run',
    JSON.stringify(p.api.runtime()));
  // 7.2 已经在 raw[0] 的运行会话：什么都不做，也不消耗预算。
  const q = makePromotePage();
  q.api.lockView.id = 'mvs_lock';
  const cap2 = makeCap([ref('mvs_run'), ref('mvs_lock')]);
  await arm(q, cap2);
  await ptick(q, cap2, { mvs_run: 'running' });
  check('7.4 已经在 raw[0] 的运行会话：零写（already-top）',
    cap2.calls.length === 0 && q.api.promoteState.calls === 0
    && q.api.promoteState.alreadyTop >= 1,
    `calls=${JSON.stringify(cap2.calls)} alreadyTop=${q.api.promoteState.alreadyTop}`);
  check('7.5 already-top 不消耗预算',
    q.api.promoteState.exhausted === 0, `exhausted=${q.api.promoteState.exhausted}`);
}

// ===========================================================================
console.log('\n=== 8. 结构：口径没被顺手改掉 ===');
{
  const proAt = pageSrc.indexOf('  function pinnedPromoteTick(');
  const proEnd = pageSrc.indexOf('\n  }\n', proAt);
  const proBody = pageSrc.slice(proAt, proEnd < 0 ? proAt : proEnd);
  check('8.1 上浮这一段在出厂里',
    proAt >= 0 && proEnd > proAt, `cut=${proAt}`);
  check('8.2 它自己仍然只有那一个三参写点',
    (proBody.match(/\.fn\(/g) || []).length === 1
    && proBody.indexOf('cap.fn(id, true, lockSlot.slot)') >= 0,
    'writes=' + (proBody.match(/\.fn\(/g) || []).length);
  check('8.3 它不碰 DOM 行序（绝不 insertBefore 造视觉）',
    !/insertBefore|appendChild|removeChild/.test(proBody), 'dom-writes');
  check('8.4 让位判断仍然排在第一次扣预算之前',
    proBody.indexOf('lockSlot.blocked') >= 0
    && proBody.indexOf('lockSlot.blocked') < proBody.indexOf('topmostCharge('),
    `lock=${proBody.indexOf('lockSlot.blocked')} charge=${proBody.indexOf('topmostCharge(')}`);
  check('8.5 四个硬拒绝的 blocked 码一个都没被放宽',
    /lockSlot\.blocked !== 'lock-not-at-top'/.test(proBody)
    && /view-unstable|source-not-local|not-local-id|order-missing-id/.test(
      pageSrc.slice(pageSrc.indexOf('  function topmostLockSlot('),
        pageSrc.indexOf('  function topmostAtSlot('))),
    'codes');
  check('8.6 running-hoisted 有自己的中文（不落进"宿主版本不支持"的兜底）',
    /'running-hoisted': '正在运行的会话已置顶到最前'/.test(pageSrc), 'reason-text');
  check('8.7 活动会话那一组不随 run 变更清空（新对话那一组仍然清）',
    /var promoteHoistedIds = \[\];/.test(pageSrc)
    && !/promoteHoistedIds = \[\]/.test(pageSrc.slice(
      pageSrc.indexOf('    if (newMainState.run !== run) {'),
      pageSrc.indexOf('    if (pkg.available !== true) {'))),
    'not-cleared');
  check('8.8 让位判据认两个集合的并集',
    /newMainState\.placedIds\.indexOf\(firstId\) < 0 && hoisted\.indexOf\(firstId\) < 0/.test(pageSrc),
    'union');
}

// ===========================================================================
console.log(`\n=== 汇总：pass=${pass} fail=${fail} ===`);
if (fail) process.exitCode = 1;
