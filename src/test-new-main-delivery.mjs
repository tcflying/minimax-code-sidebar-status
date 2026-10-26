// mmx-status :: test-new-main-delivery.mjs
//
// Offline tests for the daemon-side DELIVERY of brand new main conversations.
//
// What is under test:
//   - createNewMainFeed() in daemon.mjs: the bounded pending list, the
//     re-validation against every successful metadata read, the fixed-shape
//     payload, and the acknowledgement rules.
//   - createRefreshLoop() in daemon.mjs: it feeds the channel only from a
//     successful read, it never lets a broken new channel kill the colour
//     path, and it only trusts a receipt for the ids that request carried.
//   - buildRefreshExpression() in lib/page-script.mjs: the payload rides along
//     as the second argument of a.refresh(), and the old one-argument call is
//     unchanged.
//
// Nothing here touches a real database, a real renderer or a real process:
// the db is a fake and the session is a fake that records the expressions.
//
//   node test-new-main-delivery.mjs
//
// What is NOT proven here: that the page applies the payload and puts the
// candidates on top of the lock list. The page side is a separate change; this
// file only proves that the daemon hands it the right thing and honours the
// receipt it gets back.

import fs from 'node:fs';
import { createNewMainFeed, createRefreshLoop } from './daemon.mjs';
import { buildRefreshExpression } from './lib/page-script.mjs';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The fixed run boundary used by every case. */
const T0 = 1700000000000;

/** One metadata row, shaped exactly like status-db.mjs reports it. */
function row(over = {}) {
  return {
    id: 'mvs_row00001',
    createdAtMs: T0 + 1000,
    parentSessionId: null,
    sessionKind: 'conversation',
    visibility: 'visible',
    archived: 0,
    ...over,
  };
}

/** A db fake with the three methods the daemon uses. */
function fakeDb({ rows = [], failRefresh = false, failMetadata = false } = {}) {
  return {
    refresh() {
      if (failRefresh) throw new Error('sqlite: database is locked');
    },
    snapshot: () => ({ mvs_run00001: 'running' }),
    sessionMetadata() {
      if (failMetadata) throw new Error('metadata read failed');
      return rows.map((r) => ({ ...r }));
    },
  };
}

/** A session fake that records every expression it was asked to evaluate. */
function fakeSession({ respond } = {}) {
  const sent = [];
  return {
    sent,
    evaluateWithRetry(expr) {
      sent.push(expr);
      return Promise.resolve(respond ? respond(expr) : { ok: true, stats: { rows: 0 } });
    },
    close() {},
  };
}

/** The arguments of the a.refresh(...) call inside a refresh expression. */
function refreshArgs(expr) {
  const marker = 'a.refresh(';
  const start = expr.indexOf(marker) + marker.length;
  const end = expr.indexOf('),topmost:', start);
  if (start < marker.length || end < 0) return null;
  const raw = expr.slice(start, end);
  const args = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '{' || ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === '}' || ch === ']') {
      depth--;
      cur += ch;
      if (depth === 0) {
        args.push(JSON.parse(cur));
        cur = '';
      }
    } else if (depth > 0) {
      cur += ch;
    }
  }
  return args;
}

/** The cfg object of a bootstrap expression. */
function bootstrapCfg(expr) {
  const i = expr.lastIndexOf('({"mark":');
  if (i < 0) return null;
  return JSON.parse(expr.slice(i + 1, expr.length - 1));
}

/** A receipt like the page will answer with. */
function receipt(startedAtMs, ids) {
  return { startedAtMs, acknowledged: ids };
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. 启动种子：第一次读取只播种，后两次一致才确认 ===');
{
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const base = row({ id: 'mvs_base0001', createdAtMs: T0 - 5000 });
  const fresh = row({ id: 'mvs_fresh001', createdAtMs: T0 + 1000 });

  const p1 = feed.observeMetadata([base], { observedAtMs: T0 + 2000 });
  check('1.1 第一次读取只播种，不交付任何事件', p1.candidates.length === 0);
  check('1.2 第一次读取是一次成功观测', p1.available === true && p1.sequence === 1);

  const p2 = feed.observeMetadata([base, fresh], { observedAtMs: T0 + 2010 });
  check('1.3 第二次读取只登记候选，还不交付', p2.candidates.length === 0);

  const p3 = feed.observeMetadata([base, fresh], { observedAtMs: T0 + 2020 });
  check('1.4 第三次读取才确认并交付', p3.candidates.length === 1);
  check('1.5 交付的是新会话', p3.candidates[0].id === 'mvs_fresh001');
  check('1.6 带上创建时间', p3.candidates[0].createdAtMs === T0 + 1000);
  check('1.7 payload 字段固定',
    Object.keys(p3).sort().join(',') === 'available,candidates,observedAtMs,sequence,startedAtMs',
    Object.keys(p3).sort().join(','));
  check('1.8 candidate 字段固定',
    Object.keys(p3.candidates[0]).sort().join(',') === 'createdAtMs,id');
  check('1.9 startedAtMs 是固定边界', p3.startedAtMs === T0);
  check('1.10 sequence 按成功观测单调增加', p3.sequence === 3, `sequence=${p3.sequence}`);
  check('1.11 同一观测产生的副本一致',
    JSON.stringify(feed.payload()) === JSON.stringify(p3));
  check('1.12 payload 是副本，外部改不到内部', feed.payload() !== feed.payload());
  check('1.13 observedAtMs 是那次成功读的时刻', p3.observedAtMs === T0 + 2020, `observedAtMs=${p3.observedAtMs}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. 子代理 / hidden / task / 旧恢复 一律不交付 ===');
{
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const sub = row({ id: 'mvs_sub00001', parentSessionId: 'mvs_parent01', createdAtMs: T0 + 1000 });
  const task = row({ id: 'mvs_task0001', sessionKind: 'task', createdAtMs: T0 + 1001 });
  const hidden = row({ id: 'mvs_hid00001', visibility: 'hidden', createdAtMs: T0 + 1002 });
  const old = row({ id: 'mvs_old00001', createdAtMs: T0 - 1000 });
  const rows = [sub, task, hidden, old];

  feed.observeMetadata([], { observedAtMs: T0 + 2000 });
  feed.observeMetadata(rows, { observedAtMs: T0 + 2010 });
  const p = feed.observeMetadata(rows, { observedAtMs: T0 + 2020 });
  check('2.1 子代理（有 parent）不交付', !p.candidates.some((c) => c.id === 'mvs_sub00001'));
  check('2.2 task 不交付', !p.candidates.some((c) => c.id === 'mvs_task0001'));
  check('2.3 hidden 不交付', !p.candidates.some((c) => c.id === 'mvs_hid00001'));
  check('2.4 旧恢复（创建早于边界）不交付', !p.candidates.some((c) => c.id === 'mvs_old00001'));
  check('2.5 一个都不交付', p.candidates.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. pending 保留 / 重送 / ack 过滤 ===');
{
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const a = row({ id: 'mvs_aaaa0001', createdAtMs: T0 + 1000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2010 });
  const p = feed.observeMetadata([a], { observedAtMs: T0 + 2020 });
  check('3.1 已确认进入 pending', p.candidates.length === 1);

  const again = feed.observeMetadata([a], { observedAtMs: T0 + 2030 });
  check('3.2 没收到回执前一直重送', again.candidates.length === 1);

  check('3.3 未知 id 的 ack 什么也删不掉',
    feed.acknowledge(['mvs_unknown01']) === 0);
  check('3.4 未知 id 之后仍在 pending',
    feed.observeMetadata([a], { observedAtMs: T0 + 2040 }).candidates.length === 1);

  check('3.5 真正的 ack 删掉 pending', feed.acknowledge(['mvs_aaaa0001']) === 1);
  check('3.6 ack 之后不再交付',
    feed.observeMetadata([a], { observedAtMs: T0 + 2050 }).candidates.length === 0);
  check('3.7 重复 ack 是空操作', feed.acknowledge(['mvs_aaaa0001']) === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. 交付顺序：按创建时间升序，同毫秒按 id ===');
{
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const c = row({ id: 'mvs_ccc00001', createdAtMs: T0 + 50 });
  const a = row({ id: 'mvs_aaa00001', createdAtMs: T0 + 50 });
  const b = row({ id: 'mvs_bbb00001', createdAtMs: T0 + 10 });
  const rows = [c, a, b];
  feed.observeMetadata(rows, { observedAtMs: T0 + 2000 });
  feed.observeMetadata(rows, { observedAtMs: T0 + 2010 });
  const p = feed.observeMetadata(rows, { observedAtMs: T0 + 2020 });
  check('4.1 三个事件都交付', p.candidates.length === 3);
  check('4.2 顺序是创建时间升序、同毫秒按 id',
    p.candidates.map((c) => c.id).join(',') === 'mvs_bbb00001,mvs_aaa00001,mvs_ccc00001',
    p.candidates.map((c) => c.id).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. 归档后撤回，且不会重新 pin ===');
{
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const a = row({ id: 'mvs_arch0001', createdAtMs: T0 + 1000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2010 });
  check('5.1 已确认并交付',
    feed.observeMetadata([a], { observedAtMs: T0 + 2020 }).candidates.length === 1);

  // 归档后这一行不再出现在查询结果里（WHERE archived = 0）。
  const gone = feed.observeMetadata([], { observedAtMs: T0 + 2030 });
  check('5.2 归档后从 pending 撤回', gone.candidates.length === 0);

  // 恢复归档：行回来了，但创建时间还是旧的，不该被重新 pin。
  const back = feed.observeMetadata([a], { observedAtMs: T0 + 2040 });
  check('5.3 恢复后不会重新 pin', back.candidates.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. 同值 duplicate 按同一行；真矛盾只影响那一个 id ===');
{
  // 6a 同值 duplicate：同一个 id 两行、内容一样，就是同一行。
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const a = row({ id: 'mvs_same0001', createdAtMs: T0 + 1000 });
  feed.observeMetadata([a, { ...a }], { observedAtMs: T0 + 2000 });
  feed.observeMetadata([a, { ...a }], { observedAtMs: T0 + 2010 });
  const same = feed.observeMetadata([a, { ...a }], { observedAtMs: T0 + 2020 });
  check('6.1 同值 duplicate 正常确认', same.candidates.length === 1);
  check('6.2 同值 duplicate 不降级通道', same.available === true);

  // parent null 与 parent '' 对 detector 是同一件事（都没有父），不是矛盾。
  const feed2 = createNewMainFeed({ startedAtMs: T0 });
  const b = row({ id: 'mvs_parent01', createdAtMs: T0 + 1000, parentSessionId: null });
  const b2 = row({ id: 'mvs_parent01', createdAtMs: T0 + 1000, parentSessionId: '' });
  feed2.observeMetadata([b, b2], { observedAtMs: T0 + 2000 });
  feed2.observeMetadata([b, b2], { observedAtMs: T0 + 2010 });
  const pnull = feed2.observeMetadata([b, b2], { observedAtMs: T0 + 2020 });
  check('6.3 parent null 与空串按同一行，正常确认', pnull.candidates.length === 1);
  check('6.4 parent null 与空串不降级通道', pnull.available === true);

  // 6b 真矛盾：同一个 id 两行、内容不同。只影响这一个 id。
  const feed3 = createNewMainFeed({ startedAtMs: T0 });
  const c = row({ id: 'mvs_conf0001', createdAtMs: T0 + 1000 });
  const other = row({ id: 'mvs_other001', createdAtMs: T0 + 1001 });
  feed3.observeMetadata([c, other], { observedAtMs: T0 + 2000 });
  feed3.observeMetadata([c, other], { observedAtMs: T0 + 2010 });
  const both = feed3.observeMetadata([c, other], { observedAtMs: T0 + 2020 });
  check('6.5 两个新会话都确认', both.candidates.length === 2);

  const conflicted = feed3.observeMetadata(
    [c, row({ id: 'mvs_conf0001', createdAtMs: T0 + 5000 }), other],
    { observedAtMs: T0 + 2030 }
  );
  check('6.6 矛盾的那个 id 被撤回，不重发',
    !conflicted.candidates.some((x) => x.id === 'mvs_conf0001'),
    conflicted.candidates.map((x) => x.id).join(','));
  check('6.7 旁边那个新会话照常交付',
    conflicted.candidates.some((x) => x.id === 'mvs_other001'));
  check('6.8 通道没有被永久停掉', conflicted.available === true);
  check('6.9 detector 记下了 duplicate-conflict',
    (feed3.snapshot().detector.rejected['duplicate-conflict'] || 0) > 0,
    JSON.stringify(feed3.snapshot().detector.rejected));
}

// ---------------------------------------------------------------------------
console.log('\n=== 6b. pending 行变 NULL：只撤这一个，好候选照发 ===');
{
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const good = row({ id: 'mvs_good0001', createdAtMs: T0 + 1000 });
  const bad = row({ id: 'mvs_bad00001', createdAtMs: T0 + 1001 });
  feed.observeMetadata([good, bad], { observedAtMs: T0 + 2000 });
  feed.observeMetadata([good, bad], { observedAtMs: T0 + 2010 });
  const p = feed.observeMetadata([good, bad], { observedAtMs: T0 + 2020 });
  check('6b.1 两个都在 pending', p.candidates.length === 2);

  // bad 那一行的 kind 变成 NULL：读不了这一行。
  const after = feed.observeMetadata(
    [good, row({ id: 'mvs_bad00001', createdAtMs: T0 + 1001, sessionKind: null })],
    { observedAtMs: T0 + 2030 }
  );
  check('6b.2 读不了的那一行被撤回',
    !after.candidates.some((x) => x.id === 'mvs_bad00001'),
    after.candidates.map((x) => x.id).join(','));
  check('6b.3 其它好候选照发', after.candidates.some((x) => x.id === 'mvs_good0001'));
  check('6b.4 通道没有降级', after.available === true);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. buildRefreshExpression：第二个参数带 payload，老调用不变 ===');
{
  const one = buildRefreshExpression({ abc: 'running' });
  check('7.1 老的一参数调用仍然是 a.refresh(单参数)',
    one.includes('a.refresh({"abc":"running"})'), one.slice(one.indexOf('a.refresh('), one.indexOf('a.refresh(') + 40));
  const args = refreshArgs(one);
  check('7.2 老调用只有一个参数', Array.isArray(args) && args.length === 1);

  const two = buildRefreshExpression(
    { abc: 'running' },
    {
      startedAtMs: T0,
      sequence: 3,
      available: true,
      observedAtMs: T0 + 5,
      candidates: [{ id: 'mvs_x000001', createdAtMs: 1 }],
    }
  );
  const args2 = refreshArgs(two);
  check('7.3 新调用有两个参数', Array.isArray(args2) && args2.length === 2);
  check('7.4 第一个参数还是状态表', args2[0].abc === 'running');
  check('7.5 第二个参数是 payload',
    args2[1].startedAtMs === T0 && args2[1].sequence === 3 && args2[1].available === true &&
    args2[1].observedAtMs === T0 + 5 && args2[1].candidates.length === 1);
  check('7.6 返回结构没变（ok/stats/topmost/topmostDiag 都在）',
    one.includes('ok:true') && one.includes('stats:a.refresh(') && one.includes('topmost:a.topmost()') &&
    one.includes('topmostDiag:'));
  check('7.7 两个版本都语法合法', (() => {
    try {
      new Function('return (' + two + ');');
      return true;
    } catch {
      return false;
    }
  })());
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. createRefreshLoop：投递、回执、迟到回执 ===');
{
  const a = row({ id: 'mvs_aaaa0001', createdAtMs: T0 + 1000 });
  const b = row({ id: 'mvs_bbb00001', createdAtMs: T0 + 2000 });
  const feed = createNewMainFeed({ startedAtMs: T0 });
  // 先把 A 确认掉，B 稍后出现。
  feed.observeMetadata([a], { observedAtMs: T0 + 2000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2010 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2020 });

  let rows = [a];
  const deferred = [];
  const session = {
    sent: [],
    evaluateWithRetry(expr) {
      this.sent.push(expr);
      let resolve;
      const p = new Promise((r) => {
        resolve = r;
      });
      deferred.push({ expr, resolve });
      return p;
    },
    close() {},
  };
  const db = fakeDb({});
  db.sessionMetadata = () => rows.map((r) => ({ ...r }));

  const loop = createRefreshLoop({
    getSession: () => session,
    setSession: () => {},
    db,
    bootstrapConfig: {},
    feed,
    log: () => {},
    autoStart: false,
  });

  const beforeTick = Date.now();
  loop.tick(); // 请求 1：带 A
  await sleep(0);
  const afterTick = Date.now();
  const sent1 = refreshArgs(deferred[0].expr);
  check('8.1 第一次刷新把 payload 送了出去',
    sent1.length === 2 && sent1[1].candidates.length === 1 && sent1[1].candidates[0].id === 'mvs_aaaa0001');
  check('8.2 observedAtMs 是这次成功读的真实时刻',
    sent1[1].observedAtMs >= beforeTick && sent1[1].observedAtMs <= afterTick,
    `observedAtMs=${sent1[1].observedAtMs}`);

  // 回执不认识（另一个 run）→ 不许删。此刻 B 还没确认，pending 里只有 A。
  deferred[0].resolve({ ok: true, stats: { newMainSessions: receipt(T0 + 999, ['mvs_aaaa0001']) } });
  await sleep(0);
  check('8.3 startedAtMs 不一致的回执不生效',
    feed.snapshot().pending.map((c) => c.id).join(',') === 'mvs_aaaa0001',
    feed.snapshot().pending.map((c) => c.id).join(','));

  rows = [a, b];
  loop.tick(); // 请求 2：A 仍是候选状态
  await sleep(0);
  loop.tick(); // 请求 3：A + B
  await sleep(0);
  const sent3 = refreshArgs(deferred[2].expr);
  check('8.4 新事件也进了 payload',
    sent3.length === 2 && sent3[1].candidates.map((c) => c.id).join(',') === 'mvs_aaaa0001,mvs_bbb00001',
    sent3[1].candidates.map((c) => c.id).join(','));

  // 请求 3 先回：只 ack 了 A。
  deferred[2].resolve({ ok: true, stats: { newMainSessions: receipt(T0, ['mvs_aaaa0001']) } });
  await sleep(0);
  check('8.5 回执只删掉它点名的那个',
    feed.snapshot().pending.map((c) => c.id).join(',') === 'mvs_bbb00001',
    feed.snapshot().pending.map((c) => c.id).join(','));

  // 请求 2 迟到：它当初只带过 A（那时 B 还没确认），所以它的回执不能吃掉 B。
  deferred[1].resolve({ ok: true, stats: { newMainSessions: receipt(T0, ['mvs_bbb00001']) } });
  await sleep(0);
  check('8.6 迟到回执不能吃掉后来才出现的新事件',
    feed.snapshot().pending.map((c) => c.id).join(',') === 'mvs_bbb00001',
    feed.snapshot().pending.map((c) => c.id).join(','));

  // 未知 id 的回执不生效。
  loop.tick(); // 请求 4
  await sleep(0);
  deferred[3].resolve({ ok: true, stats: { newMainSessions: receipt(T0, ['mvs_unknown01']) } });
  await sleep(0);
  check('8.7 未知 id 的回执不删任何东西',
    feed.snapshot().pending.map((c) => c.id).join(',') === 'mvs_bbb00001');

  // ok:true 但没有回执 → 也不许删。
  loop.tick(); // 请求 5
  await sleep(0);
  deferred[4].resolve({ ok: true, stats: { rows: 0 } });
  await sleep(0);
  check('8.8 没有回执的 ok:true 不删任何东西',
    feed.snapshot().pending.map((c) => c.id).join(',') === 'mvs_bbb00001');

  loop.stop();
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. metadata 读失败不杀颜色路径，DB 读失败不观测 ===');
{
  const a = row({ id: 'mvs_fail0001', createdAtMs: T0 + 1000 });
  const feed = createNewMainFeed({ startedAtMs: T0 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2010 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2020 });
  const seqBefore = feed.snapshot().sequence;

  // metadata 读失败：颜色路径照走，新通道本轮不可用。
  const session = fakeSession();
  const loop = createRefreshLoop({
    getSession: () => session,
    setSession: () => {},
    db: fakeDb({ failMetadata: true }),
    bootstrapConfig: {},
    feed,
    log: () => {},
    autoStart: false,
  });
  loop.tick();
  await sleep(0);
  check('9.1 metadata 失败后颜色刷新照发', session.sent.length === 1);
  const args = refreshArgs(session.sent[0]);
  check('9.2 颜色状态表照发', args[0].mvs_run00001 === 'running');
  check('9.3 本轮新通道不可用，且没有可写候选',
    args[1].available === false && args[1].candidates.length === 0);
  check('9.4 不可用包不推进 sequence', args[1].sequence === seqBefore);
  check('9.5 不可用包不伪造新的成功时间',
    args[1].observedAtMs === T0 + 2020, `observedAtMs=${args[1].observedAtMs}`);
  check('9.6 pending 没被弄丢', feed.snapshot().pending.length === 1);
  loop.stop();

  // DB 读失败：什么都不观测，也什么都不发。
  const session2 = fakeSession();
  const feed2 = createNewMainFeed({ startedAtMs: T0 });
  const loop2 = createRefreshLoop({
    getSession: () => session2,
    setSession: () => {},
    db: fakeDb({ failRefresh: true }),
    bootstrapConfig: {},
    feed: feed2,
    log: () => {},
    autoStart: false,
  });
  loop2.tick();
  await sleep(0);
  check('9.7 DB 失败不观测', feed2.snapshot().sequence === 0);
  check('9.8 DB 失败连页面都不碰（页面只能靠旧包的 observedAtMs 过期）',
    session2.sent.length === 0);
  loop2.stop();
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. 重新注入也要重送未回执的新会话 ===');
{
  const a = row({ id: 'mvs_reboot01', createdAtMs: T0 + 1000 });
  const feed = createNewMainFeed({ startedAtMs: T0 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2010 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2020 });

  const session = fakeSession({
    respond: (expr) =>
      expr.includes('__mmxStatusMain')
        ? { ok: true, initial: { painted: 0 } }
        : { ok: false, reason: 'not-installed' },
  });
  const loop = createRefreshLoop({
    getSession: () => session,
    setSession: () => {},
    db: fakeDb({ rows: [a] }),
    bootstrapConfig: {},
    feed,
    log: () => {},
    autoStart: false,
    rebootBaseMs: 1,
    rebootMaxMs: 2,
  });
  loop.tick(); // not-installed -> 触发重新注入
  // 退避是真实计时，机器忙的时候 60ms 不一定够：轮询到它发生为止。
  let bootExpr = null;
  for (let i = 0; i < 300 && !bootExpr; i++) {
    await sleep(10);
    bootExpr = session.sent.find((e) => e.includes('__mmxStatusMain'));
  }
  check('10.1 重新注入了', !!bootExpr);
  const cfg = bootExpr ? bootstrapCfg(bootExpr) : null;
  check('10.2 重新注入也带 newMainSessions', !!cfg && !!cfg.newMainSessions);
  check('10.3 重新注入带的是未回执的新会话',
    !!cfg && cfg.newMainSessions.candidates.length === 1 &&
    cfg.newMainSessions.candidates[0].id === 'mvs_reboot01');
  check('10.4 没有回执就还留在 pending', feed.snapshot().pending.length === 1);
  loop.stop();
}

// ---------------------------------------------------------------------------
console.log('\n=== 11. 没有 feed 的老用法完全不受影响 ===');
{
  const session = fakeSession();
  const loop = createRefreshLoop({
    getSession: () => session,
    setSession: () => {},
    db: fakeDb(), // 老 stub：没有 sessionMetadata
    bootstrapConfig: {},
    log: () => {},
    autoStart: false,
  });
  loop.tick();
  await sleep(0);
  const args = refreshArgs(session.sent[0]);
  check('11.1 老 stub 也能刷新', session.sent.length === 1);
  check('11.2 表达式只有一个参数', args.length === 1);
  loop.stop();
}

// ---------------------------------------------------------------------------
console.log('\n=== 12. 初始 bootstrap 不伪新读：沿用播种包 ===');
{
  // 源码级：main() 里 observeNewMain 只出现一次（播种那次），初始注入取的是
  // feed.payload()。播种与注入之间没有新的数据库读，多观测一次就是伪造。
  const daemonSrc = fs.readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8');
  const mainSrc = daemonSrc.slice(daemonSrc.indexOf('async function main()'));
  const observeCalls = (mainSrc.match(/observeNewMain\(feed, db\)/g) || []).length;
  check('12.1 main 里只播种观测一次', observeCalls === 1, `observeNewMain 调用 ${observeCalls} 次`);
  check('12.2 初始注入用的是 feed.payload()',
    /const newMain = feed\.payload\(\);/.test(mainSrc));
  check('12.3 初始注入在取包之后',
    mainSrc.indexOf('const newMain = feed.payload();') <
      mainSrc.indexOf('buildBootstrapExpression'));

  // 行为级：取包不推进观测，播种时刻原样带出去。
  const feed = createNewMainFeed({ startedAtMs: T0 });
  const a = row({ id: 'mvs_seed0001', createdAtMs: T0 + 1000 });
  feed.observeMetadata([a], { observedAtMs: T0 + 2000 });
  const bootPacket = feed.payload();
  check('12.4 播种包的 observedAtMs 就是那次成功读',
    bootPacket.observedAtMs === T0 + 2000, `observedAtMs=${bootPacket.observedAtMs}`);
  check('12.5 取包不推进 sequence', feed.payload().sequence === 1);
  check('12.6 取包不推进观测时刻', feed.payload().observedAtMs === T0 + 2000);
}

// ---------------------------------------------------------------------------
console.log('\n=== 13. 坏日志不阻颜色；额度耗尽有诊断 ===');
{
  // 13a 日志函数自己炸了：metadata 出问题也不能把颜色刷新带走。
  const feed = createNewMainFeed({
    startedAtMs: T0,
    log: () => {
      throw new Error('log boom');
    },
  });
  const session = fakeSession();
  const loop = createRefreshLoop({
    getSession: () => session,
    setSession: () => {},
    db: fakeDb({ failMetadata: true }),
    bootstrapConfig: {},
    feed,
    log: () => {},
    autoStart: false,
  });
  loop.tick();
  await sleep(0);
  check('13.1 坏日志没有把颜色刷新带走', session.sent.length === 1);
  const args = refreshArgs(session.sent[0]);
  check('13.2 颜色状态表照发', args[0].mvs_run00001 === 'running');
  check('13.3 本轮新通道仍标记不可用', args[1].available === false);
  loop.stop();

  // 13b 额度耗尽：detector 的 ledger 是有界 fail-closed，满了要看得见。
  const logs = [];
  const feed2 = createNewMainFeed({
    startedAtMs: T0,
    maxTracked: 2,
    log: (...m) => logs.push(m.join(' ')),
  });
  const rows = [
    row({ id: 'mvs_lim00001', createdAtMs: T0 + 1000 }),
    row({ id: 'mvs_lim00002', createdAtMs: T0 + 1001 }),
    row({ id: 'mvs_lim00003', createdAtMs: T0 + 1002 }),
  ];
  feed2.observeMetadata(rows, { observedAtMs: T0 + 2000 });
  feed2.observeMetadata(rows, { observedAtMs: T0 + 2010 });
  const p = feed2.observeMetadata(rows, { observedAtMs: T0 + 2020 });
  check('13.4 额度外的候选没有交付', p.candidates.length === 2, `candidates=${p.candidates.length}`);
  check('13.5 额度耗尽有诊断',
    logs.some((l) => l.includes('额度')),
    logs.join(' | ').slice(0, 160));
  check('13.6 诊断是限频的，不是每读一条',
    logs.filter((l) => l.includes('额度')).length <= 3,
    `${logs.filter((l) => l.includes('额度')).length} 条`);
  check('13.7 snapshot 保留 overflow 计数',
    typeof feed2.snapshot().detector.overflow.dropped === 'number' &&
    feed2.snapshot().detector.overflow.dropped > 0,
    JSON.stringify(feed2.snapshot().detector.overflow));

  // 13c 额度诊断出现时，回执过滤照旧有效。
  const removed = feed2.acknowledge([p.candidates[0].id]);
  check('13.8 额度诊断不影响回执过滤', removed === 1 && feed2.snapshot().pending.length === 1);
}

console.log(`\npass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-new-main-delivery: ALL GREEN' : 'test-new-main-delivery: FAILED');
process.exit(fail === 0 ? 0 : 1);
