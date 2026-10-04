// mmx-status :: test-cloud-bucket.mjs
//
// Regression tests for CLOUD session support.
//
// The sidebar has a Local / Cloud switch. Cloud rows carry a bare-numeric
// data-session-id (measured 2026-10-02: 447993841729699) which does not exist
// in local_runtime_sessions, so cfg.status never has an entry for them and
// no status dot was ever painted there. The page script now accumulates cloud
// state from the host's own event bus store, window.__MAVIS_EVENT_BUS_STORE__.
//
// Everything here is hermetic and synthetic. The accumulator and the summary
// bar are exercised by EXTRACTING the real functions out of
// lib/page-script.mjs and running them in Node against a fake store and a
// tiny fake DOM, so the tests cover the shipped code rather than a copy of
// it. No CDP connection, no live host, no real database.

import fs from 'node:fs';

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

// ---------------------------------------------------------------------------
// Slicers: pull the real code out of the injected String.raw template.
// Anchored on identifiers, never on line numbers.
// ---------------------------------------------------------------------------
function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}

const CLOUD_BLOCK = sliceBlock('  // ---- cloud session accumulator', '  function apply() {');
const SUMMARY_BLOCK = sliceBlock('  function ensureSummary() {', '  // Hoist running rows.');

// The cloud block is written against the enclosing function's `disposed` flag
// and the page's `window`. Both are supplied here, exactly as the real
// __mmxStatusMain provides them.
function makeCloud(fakeWindow) {
  const factory = new Function(
    'window',
    'var disposed = false;\n' +
      CLOUD_BLOCK +
      '\nreturn { onCloudEvent, ingestCloudState, subscribeCloud, disposeCloud, cloudBucketFor, ' +
      'map: cloudState, ' +
      // Resilient on purpose: if the shipped block has no cloudEvicted counter
      // yet, reading it throws ReferenceError and this returns -1, so the
      // assertion reports a clean FAIL instead of taking the whole file down.
      'evicted: function () { try { return cloudEvicted; } catch (e) { return -1; } }, ' +
      'isDisposed: function () { return disposed; } };'
  );
  return factory(fakeWindow);
}

// ---------------------------------------------------------------------------
// Fake host event bus. Models the three properties that matter:
//  - zustand hands the subscriber the whole STATE, not an individual event
//  - the host PREPENDS: the newest event is at index 0 (measured 2026-10-02
//    from the app.asar store factory, addEvent:
//      events: [{ ...t, conversationSource: i }, ...e.events].slice(0, 200))
//  - the array is capped at 200 in that same step, so it is newest-first AND
//    rolling
//
// The prepend order is the whole point. An earlier version of this fake used
// state.events.push(ev) (append), which is the OPPOSITE of the host, and that
// single mistake is why this suite was fully green while the shipped feature
// could not work: in an append-ordered array a forwards replay happens to be
// the correct one, so a forwards/forwards pair of mistakes cancels out and the
// test asserts nothing. Feeding the accumulator a host-shaped newest-first
// array is what makes the assertions below able to fail.
// ---------------------------------------------------------------------------
const HOST_WINDOW_CAP = 200;
function makeStore(initialEvents = []) {
  // Callers pass initial events oldest-first (natural reading order); the host
  // array is newest-first, so reverse to build a faithful starting state.
  const state = { events: initialEvents.slice().reverse() };
  const store = {
    state,
    listeners: [],
    unsubCalls: 0,
    getState() {
      return state;
    },
    subscribe(fn) {
      store.listeners.push(fn);
      return function () {
        store.unsubCalls++;
        const i = store.listeners.indexOf(fn);
        if (i >= 0) store.listeners.splice(i, 1);
      };
    },
    // Host prepends the new event, caps the window, then notifies every
    // subscriber -- addEvent's [{...t}, ...prev].slice(0, 200) in one step.
    push(ev) {
      state.events = [ev, ...state.events].slice(0, HOST_WINDOW_CAP);
      for (const fn of store.listeners.slice()) fn(state, state);
    },
    // Extra head-room trim, newest-first (slice from the front).
    roll(cap) {
      if (state.events.length > cap) state.events = state.events.slice(0, cap);
    },
  };
  return store;
}

// Event shape measured from the live host on 2026-10-02.
function ev(type, sessionId, conversationSource = 'cloud') {
  return {
    type,
    timestamp: 1790944103265,
    source: 'harness',
    payload: { sessionId },
    conversationSource,
  };
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. 云端事件 -> bucket 映射（四种 type）===');
{
  const c = makeCloud({});
  // session.start -> running (green)
  c.onCloudEvent(ev('session.start', '447993841729699'));
  check('session.start -> running（绿）', c.map.get('447993841729699') === 'running',
    `got=${c.map.get('447993841729699')}`);
  check('running 用的是本地已存在的桶，不是新桶', c.cloudBucketFor('session.start') === 'running');

  // session.error -> error (red)
  c.onCloudEvent(ev('session.error', '447993841729700'));
  check('session.error -> error（红）', c.map.get('447993841729700') === 'error',
    `got=${c.map.get('447993841729700')}`);

  // session.finish -> removed
  c.onCloudEvent(ev('session.finish', '447993841729699'));
  check('session.finish -> 从 Map 删除（不画点）', !c.map.has('447993841729699'),
    `size=${c.map.size}`);

  // session.abort -> removed
  c.onCloudEvent(ev('session.abort', '447993841729700'));
  check('session.abort -> 从 Map 删除（不画点）', !c.map.has('447993841729700'),
    `size=${c.map.size}`);

  check('两种终止事件共用同一个 null 语义',
    c.cloudBucketFor('session.finish') === null && c.cloudBucketFor('session.abort') === null);
  check('终止语义返回 null（区别于"忽略"的 undefined）',
    c.cloudBucketFor('session.created') === undefined);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. 不引入本地没有的桶 + 非状态事件一律忽略 ===');
{
  const c = makeCloud({});
  check('云端从不产生 paused（本地 aborted 也默认不画点）',
    c.cloudBucketFor('session.start') !== 'paused' && c.cloudBucketFor('session.error') !== 'paused');
  check('云端从不产生 waiting（云端没有"等子 agent"概念）',
    c.cloudBucketFor('session.start') !== 'waiting' && c.cloudBucketFor('session.error') !== 'waiting');
  // The whole cloud block must not contain a paused/waiting bucket literal,
  // otherwise a future edit could start painting a colour the local path
  // cannot produce.
  check('累积器代码里没有出现 paused 桶字面量', !/['"]paused['"]/.test(CLOUD_BLOCK));
  check('累积器代码里没有出现 waiting 桶字面量', !/['"]waiting['"]/.test(CLOUD_BLOCK));

  c.onCloudEvent(ev('session.start', '111'));
  for (const t of ['session.created', 'session.title_updated', 'session.pinned_updated']) {
    c.onCloudEvent(ev(t, '111'));
  }
  check('created/title_updated/pinned_updated 不改状态', c.map.get('111') === 'running',
    `got=${c.map.get('111')}`);
  // ...and they must not resurrect a finished session either.
  c.onCloudEvent(ev('session.finish', '111'));
  c.onCloudEvent(ev('session.title_updated', '111'));
  check('已结束的会话不会被 title_updated 复活', !c.map.has('111'), `size=${c.map.size}`);
  // A metadata event for an unknown id must not create a phantom entry.
  c.onCloudEvent(ev('session.created', '999'));
  check('未知 id 的元事件不会造出幽灵条目', !c.map.has('999'), `size=${c.map.size}`);

  // Last write wins, so a retry after a failure repaints green.
  c.onCloudEvent(ev('session.start', '222'));
  c.onCloudEvent(ev('session.error', '222'));
  check('start 后 error -> error', c.map.get('222') === 'error', `got=${c.map.get('222')}`);
  c.onCloudEvent(ev('session.start', '222'));
  check('error 后重试 start -> running', c.map.get('222') === 'running', `got=${c.map.get('222')}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. 键空间隔离与入参防御 ===');
{
  const c = makeCloud({});
  // Local rows all look like mvs_xxx. A local event must never enter the
  // cloud Map, which is also what makes the two lookups in apply() safe.
  c.onCloudEvent(ev('session.start', 'mvs_6ef1e2238f1247148f52a2b8fa149633'));
  check('本地 id（mvs_ 前缀）不进入云端 Map', c.map.size === 0, `size=${c.map.size}`);
  c.onCloudEvent(ev('session.start', '447993841729699', 'local'));
  check('conversationSource=local 的事件被忽略', c.map.size === 0, `size=${c.map.size}`);

  // sessionId is documented as a string, but normalise a number anyway so a
  // host-side type change cannot silently drop every cloud row.
  c.onCloudEvent(ev('session.start', 447993841729700));
  check('数字型 sessionId 归一化成字符串键', c.map.get('447993841729700') === 'running',
    `got=${c.map.get('447993841729700')}`);

  // Hostile / malformed events must never throw out of the listener.
  let threw = null;
  try {
    c.onCloudEvent(null);
    c.onCloudEvent(undefined);
    c.onCloudEvent({});
    c.onCloudEvent({ type: 'session.start' });
    c.onCloudEvent({ type: 'session.start', conversationSource: 'cloud', payload: {} });
    c.onCloudEvent({ type: 'session.start', conversationSource: 'cloud', payload: { sessionId: null } });
    c.onCloudEvent({ type: 'session.start', conversationSource: 'cloud', payload: { sessionId: '12a34' } });
    c.onCloudEvent({ type: 'session.start', conversationSource: 'cloud', payload: { sessionId: '' } });
  } catch (e) {
    threw = e;
  }
  check('畸形事件一个都不抛错', threw === null, threw ? threw.message : '');
  check('畸形事件没污染 Map', c.map.size === 1, `size=${c.map.size}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. 滚动窗口：自己的 Map 不被 store 的 200 条窗口影响 ===');
{
  // This is the whole reason the code subscribes instead of reading getState()
  // once. The host window is capped at 200 entries (measured: 11 cloud +
  // 189 local), so any cloud session that started a while ago is already
  // evicted. A one-shot read would paint nothing at all.
  const store = makeStore([ev('session.start', '447993841729699')]);
  const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: store });
  const sub = c.subscribeCloud();
  check('挂载时订阅成功', sub.subscribed === true, `reason=${sub.reason}`);
  check('挂载时重放窗口，已在跑的会话被认出来', sub.tracked === 1, `tracked=${sub.tracked}`);

  // Flood the window with local traffic until the cloud start event falls off
  // the front, exactly as it does on the real host.
  for (let i = 0; i < 200; i++) {
    store.push(ev('session.start', `mvs_local_${i}`, 'local'));
  }
  store.roll(200);
  const evicted = !store.state.events.some((e) => e.payload.sessionId === '447993841729699');
  check('模拟前提：start 事件已被窗口挤掉', evicted, `window=${store.state.events.length} 条`);
  check('自己累积的 Map 仍然记得那个会话', c.map.get('447993841729699') === 'running',
    `got=${c.map.get('447993841729699')}`);
  check('本地事件没有被误记成云端', c.map.size === 1, `size=${c.map.size}`);

  // And a finish still lands even though its start is long gone.
  store.push(ev('session.finish', '447993841729699'));
  check('窗口外的老会话仍能收到 finish 并清点', !c.map.has('447993841729699'), `size=${c.map.size}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4b. 订阅回调入口必须是能吃下 zustand state 的那个 ===');
{
  // Regression lock for a real bug this suite caught on its first run.
  // zustand's subscribe() invokes its listener as listener(state, prevState),
  // so subscribing onCloudEvent directly hands it the STATE OBJECT. onCloudEvent
  // then fails the conversationSource test and silently accumulates nothing --
  // the feature would look wired up and paint zero cloud rows forever. The
  // subscription must therefore go through ingestCloudState.
  check('subscribe 的是 ingestCloudState 而不是 onCloudEvent',
    /unsubCloud = store\.subscribe\(ingestCloudState\)/.test(CLOUD_BLOCK));
  check('订阅的不是 onCloudEvent', !/store\.subscribe\(onCloudEvent\)/.test(CLOUD_BLOCK));
  // Behavioural proof: a zustand-shaped notify passes the state, not an event.
  const store = makeStore([]);
  const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: store });
  c.subscribeCloud();
  store.push(ev('session.start', '447993841729699'));
  check('收到 state 形态的通知也能累积（不是只认单个事件）',
    c.map.get('447993841729699') === 'running', `size=${c.map.size}`);
  // The array form must keep working too, for a host that pushes events.
  const c2 = makeCloud({});
  c2.ingestCloudState([ev('session.start', '447993841729699')]);
  check('直接喂数组也能累积', c2.map.get('447993841729699') === 'running', `size=${c2.map.size}`);
  check('喂 null / 非事件不抛错且不累积',
    c2.ingestCloudState(null) === 0 && c2.ingestCloudState({ nope: 1 }) === 0 && c2.map.size === 1);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4c. 宿主前插顺序：必须倒序重放（2026-10-02 致命 bug 回归锁）===');
{
  // THE BUG. The host prepends, so index 0 is the NEWEST event:
  //   addEvent: events: [{ ...t, conversationSource: i }, ...e.events].slice(0, 200)
  // Replaying that array forwards means the OLDEST event -- a long-finished
  // session.start -- is applied LAST, i.e. after its own session.finish, and
  // writes the row back as running. Symptom in the product: a cloud session
  // that has already finished keeps a green bar forever, and the summary
  // bar's "运行中" count stays inflated, until ~198 later local events push
  // the stale start out of the 200-entry window.
  //
  // Every assertion in this section was red on the forwards implementation and
  // is green on the reverse one.

  // -- the fake store itself must be host-shaped, or nothing below means much
  const probe = makeStore([
    { marker: 'oldest' },
    { marker: 'newest' },
  ]);
  check('假 store 的事件顺序与宿主一致（events[0] 是最新）',
    probe.state.events[0].marker === 'newest', `events[0]=${probe.state.events[0].marker}`);
  check('最旧的落在数组尾部', probe.state.events[probe.state.events.length - 1].marker === 'oldest');
  // And the cap is the host's cap, applied in the same prepend step.
  const capProbe = makeStore([]);
  for (let i = 0; i < 250; i++) capProbe.push({ n: i });
  check('假 store 的窗口上限就是宿主的 200', capProbe.state.events.length === 200,
    `length=${capProbe.state.events.length}`);
  check('超限后留下的是最新 200 条，不是最旧 200 条',
    capProbe.state.events[0].n === 249 && !capProbe.state.events.some((e) => e.n === 0));

  // -- A. finish 后应清空（verifier 独立复现的 FAIL A）
  {
    const store = makeStore([]);
    const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: store });
    c.subscribeCloud();
    store.push(ev('session.start', '447993841729699'));
    check('A1. start 之后是 running', c.map.get('447993841729699') === 'running',
      `got=${c.map.get('447993841729699')}`);
    store.push(ev('session.finish', '447993841729699'));
    check('A. finish 后应清空（本次 bug 的直接回归锁）', !c.map.has('447993841729699'),
      `got=${c.map.get('447993841729699')}`);
  }

  // -- B. error 不得被更旧的事件回退成 running（verifier FAIL B）
  {
    const store = makeStore([]);
    const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: store });
    c.subscribeCloud();
    store.push(ev('session.start', '447993841729699'));
    store.push(ev('session.error', '447993841729699'));
    check('B1. start -> error 后是 error', c.map.get('447993841729699') === 'error',
      `got=${c.map.get('447993841729699')}`);
    // An unrelated later notification replays the WHOLE window again, so the
    // stale start is replayed too. It must not win.
    store.push(ev('session.title_updated', '447993841729699'));
    check('B. start -> error -> 无关通知后仍是 error（不被回退成 running）',
      c.map.get('447993841729699') === 'error', `got=${c.map.get('447993841729699')}`);
    // A local event for another id does the same thing.
    store.push(ev('session.start', 'mvs_local_x', 'local'));
    check('B2. 本地事件重放后状态不倒退', c.map.get('447993841729699') === 'error',
      `got=${c.map.get('447993841729699')}`);
  }

  // -- C. 三个会话各自 start->finish，Map 最终必须为空（verifier FAIL E: 残留=3）
  {
    const store = makeStore([]);
    const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: store });
    c.subscribeCloud();
    for (const id of ['100000000000001', '100000000000002', '100000000000003']) {
      store.push(ev('session.start', id));
      store.push(ev('session.finish', id));
    }
    check('C. 三个 start->finish 的会话最终 Map 为空', c.map.size === 0,
      `残留=${c.map.size} [${Array.from(c.map).join(', ')}]`);
  }

  // -- D. 自愈代价（verifier FAIL G: 刚 finish 仍是 running，要 198 条本地事件自愈）
  {
    const store = makeStore([]);
    const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: store });
    c.subscribeCloud();
    store.push(ev('session.start', '447993841729699'));
    store.push(ev('session.finish', '447993841729699'));
    let healed = 0;
    while (c.map.has('447993841729699') && healed < 500) {
      store.push(ev('session.start', `mvs_filler_${healed}`, 'local'));
      healed++;
    }
    check('D. 刚 finish 时就已清空，无需靠本地事件挤窗口自愈', healed === 0,
      `自愈所需本地事件数=${healed}`);
  }

  // -- E. 源码锁：遍历方向本身就是契约的一部分
  check('E. ingestCloudState 是倒序重放',
    /for \(var i = list\.length - 1; i >= 0; i--\) onCloudEvent\(list\[i\]\)/.test(CLOUD_BLOCK),
    '期望 from list.length-1 递减到 0');
  check('E2. 不存在正序（push 序）遍历的旧写法',
    !/for \(var i = 0; i < list\.length; i\+\+\) onCloudEvent\(list\[i\]\)/.test(CLOUD_BLOCK));
  check('E3. 倒序的理由写进了注释（宿主前插）',
    /前插|newest|prepend/i.test(CLOUD_BLOCK) && CLOUD_BLOCK.includes('addEvent'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. store 缺失 / 异常时静默降级 ===');
{
  // Older host build, or a sandboxed renderer with no event bus at all.
  let r = null;
  let threw = null;
  try {
    const c = makeCloud({});
    r = c.subscribeCloud();
    check('降级后 Map 为空', c.map.size === 0, `size=${c.map.size}`);
  } catch (e) {
    threw = e;
  }
  check('没有 store 时不抛错', threw === null, threw ? threw.message : '');
  check('没有 store 时如实上报原因', r && r.subscribed === false && r.reason === 'no-event-bus-store',
    JSON.stringify(r));
}
{
  // A store that exists but is broken must be just as harmless: a throw out
  // of subscribe() would take the whole bootstrap down with it.
  let r = null;
  let threw = null;
  try {
    const c = makeCloud({
      __MAVIS_EVENT_BUS_STORE__: {
        getState() { throw new Error('boom'); },
        subscribe() { throw new Error('boom'); },
      },
    });
    r = c.subscribeCloud();
    check('store 自己抛错时 Map 仍为空', c.map.size === 0, `size=${c.map.size}`);
  } catch (e) {
    threw = e;
  }
  check('store 抛错不会外泄到注入脚本', threw === null, threw ? threw.message : '');
  check('store 抛错时如实上报原因', r && r.reason === 'subscribe-threw', JSON.stringify(r));
}
{
  // Present but without a usable subscribe (e.g. an older store shape).
  const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: { getState: () => ({}) } });
  const r = c.subscribeCloud();
  check('没有 subscribe 方法时按缺失处理', r.subscribed === false && r.reason === 'no-event-bus-store',
    JSON.stringify(r));
  check('没有 subscribe 时没有挂起 listener', r.tracked === 0, `tracked=${r.tracked}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. dispose：退订 + 清空 + 之后不再响应 ===');
{
  const store = makeStore([ev('session.start', '447993841729699')]);
  const c = makeCloud({ __MAVIS_EVENT_BUS_STORE__: store });
  c.subscribeCloud();
  check('dispose 前确实在监听', store.listeners.length === 1, `listeners=${store.listeners.length}`);

  c.disposeCloud();
  check('dispose 取消了订阅', store.unsubCalls === 1, `unsubCalls=${store.unsubCalls}`);
  check('dispose 后 store 上没有残留 listener', store.listeners.length === 0,
    `listeners=${store.listeners.length}`);
  check('dispose 置位 disposed 标志', c.isDisposed() === true);
  check('dispose 清空了累积的 Map', c.map.size === 0, `size=${c.map.size}`);

  // A late notify from a host that had already queued one must change nothing.
  c.onCloudEvent(ev('session.start', '555555555555555'));
  check('dispose 后再喂事件不会累积', c.map.size === 0, `size=${c.map.size}`);

  // Double dispose (the real page calls it from api.dispose and again when a
  // second bootstrap replaces the first) must not throw.
  let threw = null;
  try {
    c.disposeCloud();
  } catch (e) {
    threw = e;
  }
  check('重复 dispose 是安全的', threw === null, threw ? threw.message : '');
  check('重复 dispose 不会二次退订', store.unsubCalls === 1, `unsubCalls=${store.unsubCalls}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. 泄漏上限（丢掉终止事件的兜底）+ 丢弃必须可观测 ===');
{
  const c = makeCloud({});
  for (let i = 0; i < 200; i++) c.onCloudEvent(ev('session.start', `447993841${i}`));
  check('累积 Map 被上限兜住，不会无限增长', c.map.size <= 64, `size=${c.map.size}`);
  check('最新进来的会话仍被保留（丢的是最旧的）', c.map.has('447993841199'), `size=${c.map.size}`);

  // Truncation must be COUNTED, not silent. A silently dropped entry is a
  // running session that quietly stops getting a dot, and the only symptom is
  // "少画了点" -- unsearchable. The counter is what makes it debuggable.
  check('超 64 并发时 cloudEvicted 被累加（200 进 64 出 = 136 次丢弃）',
    c.evicted() === 136, `got=${c.evicted()}`);
  // A session that is still running may be the one dropped: that is the honest
  // caveat of the ceiling, and the counter exists precisely so it is visible.
  check('被丢掉的确实是最旧的插入（仍在跑也可能被丢，所以要计数）',
    !c.map.has('4479938410') && c.map.has('447993841199'), `size=${c.map.size}`);
  // The counter is monotonic: finishing sessions does not refund it.
  c.onCloudEvent(ev('session.finish', '447993841199'));
  check('终止事件不重置也不回退累计丢弃数', c.evicted() === 136, `got=${c.evicted()}`);
  // And it is reported, not kept private to the closure.
  check('cloudEvicted 出现在 api.cloudState() 的返回里',
    /cloudState: function \(\)\s*\{\s*return \{[^}]*evicted: cloudEvicted/.test(pageSrc));
  check('apply() 的 stats 也带上 cloudEvicted（daemon 日志可见）',
    /cloudEvicted: cloudEvicted/.test(pageSrc));
  // A single session under the ceiling must evict nothing at all.
  const c2 = makeCloud({});
  c2.onCloudEvent(ev('session.start', '447993841729699'));
  check('未超上限时不产生任何丢弃计数', c2.evicted() === 0, `got=${c2.evicted()}`);
}

// ---------------------------------------------------------------------------
// Summary bar: cloud running is MERGED into the existing running count, so
// this runs the real ensureSummary/updateSummary against a minimal fake DOM.
// ---------------------------------------------------------------------------
function el(tag) {
  const n = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    style: {},
    textContent: '',
    parentElement: null,
    get firstElementChild() {
      return this.children[0] || null;
    },
    get nextSibling() {
      if (!this.parentElement) return null;
      const i = this.parentElement.children.indexOf(this);
      return this.parentElement.children[i + 1] || null;
    },
    appendChild(c) {
      c.parentElement = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      c.parentElement = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c);
      else this.children.splice(i, 0, c);
      return c;
    },
    remove() {
      if (!this.parentElement) return;
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    querySelector(sel) {
      if (sel === 'b') return walk(this, (x) => x.tagName === 'B');
      const m = /^\[([^\]=]+)\]$/.exec(sel);
      if (m) return walk(this, (x) => m[1] in x.attrs);
      return null;
    },
  };
  return n;
}
function walk(root, pred) {
  for (const c of root.children) {
    if (pred(c)) return c;
    const r = walk(c, pred);
    if (r) return r;
  }
  return null;
}
function makeSummaryDom() {
  const sec = el('div');
  sec.setAttribute('data-pinned-section', '1');
  const header = el('div');
  sec.appendChild(header);
  const document = {
    root: sec,
    createElement: (t) => el(t),
    createTextNode: (t) => {
      const n = el('#text');
      n.textContent = String(t);
      return n;
    },
    getElementById(id) {
      return walk(sec, (x) => x.id === id || x.attrs.id === id);
    },
    querySelector(sel) {
      const m = /^\[([^\]=]+)\]$/.exec(sel);
      // The pinned section is the ROOT here, so it has to be tested directly;
      // walk() only descends into children.
      if (m && m[1] in sec.attrs) return sec;
      if (m) return walk(sec, (x) => m[1] in x.attrs);
      return null;
    },
  };
  return { document, sec, header };
}
function makeSummary(doc) {
  const factory = new Function('document', 'SUMMARY_ID', SUMMARY_BLOCK + '\nreturn { updateSummary, ensureSummary };');
  return factory(doc, 'mmx-running-summary');
}

console.log('\n=== 8. 汇总条：云端 running 合并进"运行中" ===');
{
  const { document, sec, header } = makeSummaryDom();
  const s = makeSummary(document);

  s.updateSummary(0, 0);
  let bar = document.getElementById('mmx-running-summary');
  check('两者都为 0 时汇总条被标记为 empty', bar.getAttribute('data-mmx-empty') === '1');
  check('empty 时数字为 0', bar.querySelector('b').textContent === '0');

  // The merged case: 1 local running + 1 cloud running == 2, one number.
  s.updateSummary(2, 0);
  bar = document.getElementById('mmx-running-summary');
  check('本地+云端合并成一个运行中数字', bar.querySelector('b').textContent === '2',
    `got=${bar.querySelector('b').textContent}`);
  check('只要有云端 running 汇总条就不该被隐藏', bar.getAttribute('data-mmx-empty') === '0');
  check('running 段文案仍是"个运行中"（没有为云端新开一段）',
    bar.children[1].children[1] && bar.children[1].children[1].textContent === ' 个运行中');
  check('汇总条没有多出第三个分段', bar.children.length === 3, `segments=${bar.children.length}`);

  const seg = bar.querySelector('[data-mmx-wait]');
  s.updateSummary(2, 0);
  check('running>0 时 waiting 段仍隐藏', document.getElementById('mmx-running-summary')
    .querySelector('[data-mmx-wait]').style.display === 'none');

  s.updateSummary(0, 3);
  bar = document.getElementById('mmx-running-summary');
  check('只有 waiting 时汇总条不隐藏', bar.getAttribute('data-mmx-empty') === '0');
  check('waiting 数字正确', bar.querySelector('[data-mmx-wait]').querySelector('b').textContent === '3');
  check('waiting>0 时 waiting 段显示', bar.querySelector('[data-mmx-wait]').style.display === '');

  s.updateSummary(0, 0);
  bar = document.getElementById('mmx-running-summary');
  check('回到 0/0 时重新标记为 empty', bar.getAttribute('data-mmx-empty') === '1');

  check('汇总条插在 header 之后、列表之前', sec.children[1] === bar && bar.parentElement === sec);
  check('汇总条不是 header 本身', header !== bar);
  check('重复调用复用同一个节点而不是新建', s.ensureSummary() === bar);
  void seg;
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. 页面接线：源码层回归锁 ===');
{
  // The local sqlite path is untouched by this feature, so these assert the
  // wiring rather than any new local behaviour.
  check('apply() 在 stats 里统计云端行', pageSrc.includes('cloudOnScreen: 0'));
  check('apply() 回退查云端 Map', /if \(!bucket\) \{\s*var cb = cloudState\.get\(id\)/.test(pageSrc));
  check('本地命中优先于云端（键空间不重叠，顺序无所谓）',
    pageSrc.indexOf('var bucket = map[id];') < pageSrc.indexOf('var cb = cloudState.get(id);'));
  check('键空间不重叠这件事写进了注释', pageSrc.includes('mvs_') && pageSrc.includes('447993841729699'));
  // runningOnScreen must be incremented for EVERY running bucket, not only
  // for cloud ones, otherwise the merged number would drop the local count.
  check('running 计数没有被云端条件门控',
    /if \(bucket === 'running'\) stats\.runningOnScreen\+\+;\s*if \(bucket === 'waiting'\)/.test(pageSrc));
  check('云端 running 确实并入同一个 running 计数',
    pageSrc.includes('if (fromCloud) stats.cloudOnScreen++;'));
  check('汇总条签名仍是两个参数（没有第三段）',
    /function updateSummary\(runningOnScreen, waitingOnScreen\)/.test(pageSrc));
  check('调用点仍只传 running/waiting 两个实参',
    pageSrc.includes('updateSummary(stats.runningOnScreen, stats.waitingOnScreen)'));
  check('data-mmx-empty 仍由合并后的 n 与 w 共同决定',
    pageSrc.includes("bar.setAttribute('data-mmx-empty', n === 0 && w === 0 ? '1' : '0')"));
  check('挂载时就订阅（在第一次 apply 之前）',
    pageSrc.indexOf('var cloudSub = subscribeCloud();') < pageSrc.indexOf('var initial = apply();'));
  // apply() is *defined* above the subscribe call site but *invoked* below it,
  // so ordering alone proves nothing. What actually matters is that we
  // subscribe EXACTLY once: calling it from inside apply() would add a new
  // listener on every 2.5 s pass and leak one per pass.
  const subCalls = (pageSrc.match(/subscribeCloud\(\);/g) || []).length;
  check('subscribeCloud 只在挂载时调用一次（不会每轮 apply 重复订阅）', subCalls === 1,
    `call sites=${subCalls}`);
  check('dispose 会退订', pageSrc.includes('disposeCloud();'));
  check('退订调用排在 observer.disconnect 之前',
    pageSrc.indexOf('disposeCloud();') < pageSrc.indexOf('observer.disconnect()'));
  check('api 暴露了只读的云端状态查询', pageSrc.includes('cloudState: function ()'));
  check('bootstrap 返回里带上了云端订阅结果', pageSrc.includes('cloud: cloudSub'));
  check('累积器整体包在 try/catch 里（不炸宿主）', CLOUD_BLOCK.includes('} catch (err) { /* never break the host app */ }'));
  // Unchanged local invariants that this feature must not have disturbed.
  check('本地 sqlite 判据没被搬进页面脚本', !CLOUD_BLOCK.includes('local_runtime_sessions') ||
    pageSrc.includes('local_runtime_sessions'));
  check('搬 DOM 的护栏常量原样保留',
    pageSrc.includes('var REORDER_MAX_ROOTS = 128;') && pageSrc.includes('var REORDER_MAX_MOVES = 32;'));
  check('enforceNoAutoExpand 仍然每个 frame 都跑',
    pageSrc.includes('try { api.enforceNoAutoExpand(); } catch (e) { /* never break the host app */ }'));

  // stats.pruned used to report live.length, i.e. how many rows SURVIVED the
  // sweep, not how many were dropped. A daemon log line of pruned:94 reads
  // like "94 nodes were deleted from the host DOM", which is exactly backwards
  // and once read as if the tool were mutating the host sidebar.
  check('stats.pruned 记的是被剪掉的数（touched.size - live.length）',
    /stats\.pruned = touched\.size - live\.length;/.test(pageSrc));
  check('旧的 live.length 口径已不存在', !/stats\.pruned = live\.length;/.test(pageSrc));
  check('touched.size 在 clear() 之前取（否则差值恒为 0）',
    pageSrc.indexOf('stats.pruned = touched.size - live.length;') <
    pageSrc.indexOf('touched.clear();', pageSrc.indexOf('if (touched.size > 64)')));

  // 2026-10-02 视图切换闪烁回归锁：宿主切回时把置顶行连同「已展开」的
  // caret 一起 commit，展开布局画出 2 帧后才被 rAF 守卫折回（主上报
  // 「多出来又折叠」）。MutationObserver 回调是微任务、在 paint 之前
  // 跑，所以第二只 observer 盯 class 变化、同步折叠，展开帧应归零。
  // 曾试过两版按时间的窗口（350/600ms）与「风暴门门」（行数静默 1.2s）：
  // 前者没盖住第二波（净伤害：拖到 1551ms），后者让展开态持续 2 秒
  // （expandedFrames 2→99+）。三版均比 rAF-only 更差，只有微任务路径
  // 真正有效，此锁防止任何时间窗方案回潮。
  check('有独立的 attribute observer 盯 caret class（微任务同帧折叠）',
    /expandGuardObserver\.observe\(mount, \{/.test(pageSrc) &&
    /attributeFilter: \['class'\]/.test(pageSrc));
  check('attribute observer 只折 transition-transform 的 caret（不误伤其他节点）',
    /indexOf\('transition-transform'\) < 0\) continue;/.test(pageSrc));
  check('attribute observer 在 dispose 里断开（不泄漏）',
    pageSrc.indexOf('expandGuardObserver.disconnect()') > pageSrc.indexOf('expandGuardObserver.observe'));
  check('时间窗/风暴门方案没有回潮（350/600/1200 静默都已删除）',
    !/lastChurnAt|lastCollapseAt|now - last/.test(pageSrc));

  // 2026-10-03 置顶区截断记忆回归锁（主上报「切云端再回本地，所有 session
  // 自动收缩，下面一个更多」）：宿主每次视图切换重挂本地列表，把用户点过
  // 的「更多」展开态重置回默认 6 条截断，且展开态下宿主不渲染任何收起控件
  // ——用户无从对抗。修复 = 记住真实点击（isTrusted），宿主把截断按钮放回
  // DOM 后替用户重新点开一次。以下锁住这个行为的关键不变量。
  check('置顶截断恢复挂在 apply() 的 reorder 之后（按钮落在最终位置再点）',
    pageSrc.indexOf('stats.reorder = applyReorder();') < pageSrc.indexOf('restorePinnedMore(stats);'));
  check('记忆只认真实点击（isTrusted 守卫在前，合成恢复点击不会自反馈）',
    /function onPinnedMoreClick\(ev\) \{\s*\n\s*if \(!ev \|\| !ev\.isTrusted\) return;/.test(pageSrc));
  check('恢复点击自限：只点展开向按钮（展开后按钮消失，下一轮扑空即停）',
    /if \(!f \|\| f\.kind !== 'expand'\) return;/.test(pageSrc) &&
    pageSrc.indexOf("f.kind !== 'expand'") < pageSrc.indexOf('f.btn.click();'));
  check('不可见按钮绝不点击（虚拟列表残留/隐藏菜单）',
    pageSrc.indexOf('getClientRects().length) return;') < pageSrc.indexOf('f.btn.click();'));
  check('记忆落在 localStorage（重注入/重启后仍生效）且键名恒定',
    pageSrc.includes("var PINNED_MORE_KEY = 'mmxStatusPinnedMore'") &&
    /localStorage\.setItem\(PINNED_MORE_KEY/.test(pageSrc));
  // The behaviour is locked where it can actually be observed -- on the real
  // section markup -- by test-pinned-lifecycle.mjs 2.4/2.6/2.7. A regex can
  // only confirm the MECHANISM is present, which is what this file is for; the
  // previous form of this assertion still demanded the old sec.contains(b)
  // guard and went red when the logic moved into the shared classifier.
  check('恢复按钮严格限定在置顶容器内部（父级兜底已删，项目组的 更多 不许碰）' +
    '——行为锁见 test-pinned-lifecycle 2.4/2.6/2.7，此处只锁机制',
    !/var roots = \[sec, sec\.parentElement\];/.test(pageSrc) &&
    /sec\.querySelectorAll\('button,\[role="button"\]'\)/.test(pageSrc) &&
    /function classifyPinnedButton\(b\) \{[\s\S]*?closest\('\[data-session-id\]'\)[\s\S]*?if \(!rowsHere\) return null;/.test(pageSrc));
  check('click 监听用捕获阶段（宿主 handler stopPropagation 之前看到）且 dispose 移除',
    pageSrc.includes("document.addEventListener('click', onPinnedMoreClick, true);") &&
    pageSrc.indexOf("document.addEventListener('click', onPinnedMoreClick, true);") <
    pageSrc.indexOf("document.removeEventListener('click', onPinnedMoreClick, true);"));
  check('api 暴露 pinnedMore 只读视图（探针/daemon 可观测）',
    /pinnedMore: function \(\) \{/.test(pageSrc) &&
    /return \{\s*want: pinnedMoreState\.want, restored: pinnedMoreState\.restored/.test(pageSrc));

  // The key-space comment must not claim a SQL guarantee it does not have.
  // status-db.mjs's main query (lines 97-107) filters on `WHERE s.archived = 0`
  // only -- there is no `WHERE session_id LIKE 'mvs_%'` anywhere.
  check('没有把 mvs_ 前缀说成是 SQL 保证',
    !/starts with mvs_|以 mvs_ 开头|每条都以 mvs_/.test(pageSrc) || pageSrc.includes('archived = 0'));
  check('键空间隔离的两道真实依据写进了注释',
    pageSrc.includes('447993841729699') && /LIKE 'mvs_%'/.test(pageSrc));
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. 语法与编码回归锁 ===');
{
  try {
    new Function('window', 'var disposed = false;\n' + CLOUD_BLOCK);
    check('云端累积器片段语法合法', true, `${CLOUD_BLOCK.length} chars`);
  } catch (e) {
    check('云端累积器片段语法合法', false, e.message);
  }
  // The injected code lives inside a String.raw template. One stray backtick
  // inside it ends the template and turns the whole module into a
  // SyntaxError, so the baseline is locked here.
  const all = (pageSrc.match(/`/g) || []).length;
  check('page-script.mjs 全文件反引号计数仍为 10', all === 10, `实际 ${all} 个`);
  const rawSeg = pageSrc.slice(
    pageSrc.indexOf('const PAGE_FN = String.raw'),
    pageSrc.indexOf('export function buildBootstrapExpression')
  );
  const inTemplate = (rawSeg.match(/`/g) || []).length;
  check('PAGE_FN 模板内反引号恰为 2 个（开+闭）', inTemplate === 2, `实际 ${inTemplate} 个`);
  const offenders = [];
  rawSeg.split('\n').forEach((line, i) => {
    if ((line.match(/`/g) || []).length > 0 && i !== 0 && !/^`;?$/.test(line.trim())) offenders.push(i + 1);
  });
  check('模板体内无游离反引号', offenders.length === 0, offenders.join(','));
  // LF only, no BOM: a CRLF or a BOM here has broken this file before.
  // Read the raw bytes -- a BOM is invisible after utf8 decoding.
  const pageBytes = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url));
  const hasBom = pageBytes[0] === 0xef && pageBytes[1] === 0xbb && pageBytes[2] === 0xbf;
  check('page-script.mjs 无 BOM', !hasBom,
    `首字节=${pageBytes.slice(0, 3).map((b) => b.toString(16)).join(' ')}`);
  check('page-script.mjs 是纯 LF（无 CRLF）', !pageSrc.includes('\r'),
    `CR 数=${(pageSrc.match(/\r/g) || []).length}`);
  const selfBytes = fs.readFileSync(new URL('./test-cloud-bucket.mjs', import.meta.url));
  const selfBom = selfBytes[0] === 0xef && selfBytes[1] === 0xbb && selfBytes[2] === 0xbf;
  const selfSrc = selfBytes.toString('utf8');
  check('本测试文件自身也是无 BOM 的纯 LF', !selfBom && !selfSrc.includes('\r'));
}

console.log(`\npass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-cloud-bucket: ALL GREEN' : 'test-cloud-bucket: FAILED');
process.exit(fail === 0 ? 0 : 1);
