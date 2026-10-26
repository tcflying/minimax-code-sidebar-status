// mmx-status :: test-new-main-sessions.mjs
//
// Offline tests for lib/new-main-sessions.mjs -- the NEW main-session
// CANDIDATE detector.
//
// Pure in-memory only: no database, no temp files, no host, no process
// control. Every row is a hand-written metadata fixture.
//
//   node test-new-main-sessions.mjs
//
// What is NOT proven here: that a candidate is a ROOT session. The predicate
// is a static rule over metadata columns, so this file only ever proves the
// RULE, never the host's root classification.

import { createNewMainSessionDetector } from './lib/new-main-sessions.mjs';

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

const T0 = 1700000000000; // startedAtMs

/** One metadata row. Only the metadata columns exist as inputs. */
function row(over = {}) {
  return {
    id: 'mvs_abc123',
    createdAtMs: T0 + 10,
    parentSessionId: null,
    sessionKind: 'conversation',
    archived: 0,
    visibility: 'visible',
    ...over,
  };
}

const ids = (list) => list.map((c) => c.id);

// ---------------------------------------------------------------------------
console.log('\n=== 1. 旧会话 / 归档边界 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  const r1 = d.observe([row({ id: 'mvs_old01', createdAtMs: T0 - 1000 })], { observedAtMs: T0 + 10 });
  check('1.1 启用前创建且未归档 -> 不入选', r1.confirmedCandidates.length === 0);
  const r2 = d.observe([row({ id: 'mvs_old01', createdAtMs: T0 - 1000 })], { observedAtMs: T0 + 20 });
  check('1.2 旧会话第二次读仍不入选', r2.confirmedCandidates.length === 0);
  check('1.3 旧会话不进账本（不占上限）', d.snapshot().tracked === 0);
  // The first read only seeds, so it counts the row as 'baseline'; the second
  // read judges it and counts it as 'before-cutoff'.
  check('1.4 旧会话只进拒绝计数',
    r1.rejected['baseline'] === 1 && r2.rejected['before-cutoff'] === 1, JSON.stringify(r2.rejected));
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([row({ id: 'mvs_arc01', createdAtMs: T0 - 500, archived: 1 })], { observedAtMs: T0 + 5 });
  const r = d.observe([row({ id: 'mvs_arc01', createdAtMs: T0 - 500, archived: 0 })], { observedAtMs: T0 + 15 });
  check('1.5 启用前已归档、之后取消归档 -> 仍不入选', r.confirmedCandidates.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. 第一次 observe 只播种，不动作 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  const r1 = d.observe([row({ id: 'mvs_base1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  check('2.1 第一次 observe 无候选', r1.confirmedCandidates.length === 0);
  check('2.2 第一次 observe 完成播种', d.snapshot().seeded === true);
  check('2.3 第一次 observe 只计数不建账本', r1.rejected['baseline'] === 1 && d.snapshot().tracked === 0);
  const r2 = d.observe([row({ id: 'mvs_base1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 20 });
  check('2.4 第二次读还不确认', r2.confirmedCandidates.length === 0);
  // Rule change: the baseline set is NOT kept, so a session created inside the
  // startup window is reported late instead of being missed. Documented.
  check('2.5 基线会话在后续读里转为候选（启动窗口晚报）',
    ids(d.snapshot().candidates).includes('mvs_base1'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. 非法输入整体拒绝，不推进任何状态 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([row({ id: 'mvs_ok01', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const before = JSON.stringify(d.snapshot());
  let threw = 0;
  const cases = [
    () => d.observe('not-an-array', { observedAtMs: T0 + 20 }),
    () => d.observe([row({ id: 'mvs_x', createdAtMs: T0 + 20 })], { observedAtMs: NaN }),
    () => d.observe([row({ id: 'mvs_x', createdAtMs: undefined })], { observedAtMs: T0 + 20 }),
    () => d.observe([row({ id: 'mvs_x', createdAtMs: T0 + 20, parentSessionId: undefined })], { observedAtMs: T0 + 20 }),
    () => d.observe([row({ id: 'mvs_x', createdAtMs: T0 + 20, sessionKind: undefined })], { observedAtMs: T0 + 20 }),
    () => d.observe([row({ id: 'mvs_x', createdAtMs: T0 + 20, archived: undefined })], { observedAtMs: T0 + 20 }),
    () => d.observe([row({ id: 'mvs_x', createdAtMs: T0 + 20, visibility: undefined })], { observedAtMs: T0 + 20 }),
    () => d.observe([row({ id: undefined, createdAtMs: T0 + 20 })], { observedAtMs: T0 + 20 }),
  ];
  for (const c of cases) {
    try { c(); } catch { threw++; }
  }
  check('3.1 缺字段/非数组/无效时间全部抛错', threw === cases.length, `threw=${threw}/${cases.length}`);
  check('3.2 非法输入后 snapshot 完全不变', JSON.stringify(d.snapshot()) === before);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. 主会话：parent NULL 与 parent \'\' 都能入选 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_nullp', createdAtMs: T0 + 10, parentSessionId: null })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_nullp', createdAtMs: T0 + 10, parentSessionId: null })], { observedAtMs: T0 + 20 });
  check('4.1 parent=NULL 被确认', r.confirmedCandidates.length === 1 && r.confirmedCandidates[0].id === 'mvs_nullp');
  check('4.2 候选只含 id/createdAtMs',
    Object.keys(r.confirmedCandidates[0]).sort().join(',') === 'createdAtMs,id');

  const d2 = createNewMainSessionDetector({ startedAtMs: T0 });
  d2.observe([], { observedAtMs: T0 + 1 });
  d2.observe([row({ id: 'mvs_emptyp', createdAtMs: T0 + 10, parentSessionId: '' })], { observedAtMs: T0 + 10 });
  const r2 = d2.observe([row({ id: 'mvs_emptyp', createdAtMs: T0 + 10, parentSessionId: '' })], { observedAtMs: T0 + 20 });
  check("4.3 parent='' 被确认", r2.confirmedCandidates.length === 1 && r2.confirmedCandidates[0].id === 'mvs_emptyp');
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. 子代理（parent / kind 不变时）不转成候选 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const r1 = d.observe(
    [row({ id: 'mvs_child1', createdAtMs: T0 + 10, parentSessionId: 'mvs_parent1' })],
    { observedAtMs: T0 + 10 });
  check('5.1 kind=conversation 但 parent 非空 -> 只计数拒绝',
    r1.rejected['has-parent'] === 1 && d.snapshot().tracked === 0);
  const r2 = d.observe(
    [row({ id: 'mvs_child1', createdAtMs: T0 + 10, parentSessionId: 'mvs_parent1' })],
    { observedAtMs: T0 + 20 });
  check('5.2 parent 不变时该行不成为候选', r2.confirmedCandidates.length === 0);
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const r1 = d.observe([row({ id: 'mvs_task1', createdAtMs: T0 + 10, sessionKind: 'task' })], { observedAtMs: T0 + 10 });
  check('5.3 kind=task -> 只计数拒绝',
    r1.rejected['kind-not-conversation'] === 1 && d.snapshot().tracked === 0);
  const r2 = d.observe([row({ id: 'mvs_task1', createdAtMs: T0 + 10, sessionKind: 'task' })], { observedAtMs: T0 + 20 });
  check('5.4 kind 不变时该行不成为候选', r2.confirmedCandidates.length === 0);
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_late1', createdAtMs: T0 + 10, parentSessionId: '' })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_late1', createdAtMs: T0 + 10, parentSessionId: 'mvs_parent1' })], { observedAtMs: T0 + 20 });
  check('5.5 parent 后补 -> 候选转 tombstone',
    r.confirmedCandidates.length === 0
    && d.snapshot().tombstones.some((t) => t.id === 'mvs_late1' && t.reason === 'parent-changed'));
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_chg1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_chg1', createdAtMs: T0 + 999 })], { observedAtMs: T0 + 20 });
  check('5.6 created 变化 -> 候选转 tombstone',
    r.confirmedCandidates.length === 0
    && d.snapshot().tombstones.some((t) => t.id === 'mvs_chg1' && t.reason === 'created-changed'));
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_ar2', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_ar2', createdAtMs: T0 + 10, archived: 1 })], { observedAtMs: T0 + 20 });
  check('5.7 候选被归档 -> tombstone 且不重发',
    r.confirmedCandidates.length === 0
    && d.snapshot().tombstones.some((t) => t.id === 'mvs_ar2' && t.reason === 'archived'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. 时间边界 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const r = d.observe([row({ id: 'mvs_fut01', createdAtMs: T0 + 5000 })], { observedAtMs: T0 + 10 });
  check('6.1 创建时间在未来 -> 延后处理，不入选不建账本',
    r.confirmedCandidates.length === 0 && d.snapshot().tracked === 0 && r.deferred['created-in-future'] === 1);
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_t0', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_t0', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  check('6.2 observedAtMs 未前进 -> 不确认', r.confirmedCandidates.length === 0);
  const r2 = d.observe([row({ id: 'mvs_t0', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 11 });
  check('6.3 observedAtMs 前进后确认', r2.confirmedCandidates.length === 1);
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 100 });
  const before = JSON.stringify(d.snapshot());
  let threw = 0;
  try { d.observe([row({ id: 'mvs_rev1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 50 }); } catch { threw++; }
  check('6.4 observedAtMs 倒退 -> 整读拒绝', threw === 1);
  check('6.5 倒退的整读不推进任何状态', JSON.stringify(d.snapshot()) === before);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. 重复读 / 同 id 重挂只确认一次 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_dup1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_dup1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 20 });
  check('7.1 第二次读确认', r.confirmedCandidates.length === 1 && r.confirmedCandidates[0].id === 'mvs_dup1');
  const r2 = d.observe([row({ id: 'mvs_dup1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 30 });
  check('7.2 同 id 再读不重复确认', r2.confirmedCandidates.length === 0);
  check('7.3 snapshot 只留一条已确认', d.snapshot().confirmed.length === 1);
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. DB 失败时上层不调用 observe ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  let calls = 0;
  const readRows = () => {
    calls++;
    throw new Error('db down');
  };
  let out = null;
  try { out = readRows(); } catch { out = null; }
  if (out) d.observe(out, { observedAtMs: T0 + 10 });
  check('8.1 DB 失败后 observe 未被调用，状态未推进',
    calls === 1 && d.snapshot().observeCount === 0 && d.snapshot().tracked === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. 多批次 / 同毫秒 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_b1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const r = d.observe(
    [row({ id: 'mvs_b1', createdAtMs: T0 + 10 }), row({ id: 'mvs_b2', createdAtMs: T0 + 20 })],
    { observedAtMs: T0 + 20 });
  check('9.1 先创建的批次先确认', r.confirmedCandidates.length === 1 && r.confirmedCandidates[0].id === 'mvs_b1');
  const r2 = d.observe(
    [row({ id: 'mvs_b1', createdAtMs: T0 + 10 }), row({ id: 'mvs_b2', createdAtMs: T0 + 20 })],
    { observedAtMs: T0 + 30 });
  check('9.2 后创建的批次不被吞', r2.confirmedCandidates.length === 1 && r2.confirmedCandidates[0].id === 'mvs_b2');
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const same = [row({ id: 'mvs_z1', createdAtMs: T0 + 10 }), row({ id: 'mvs_a1', createdAtMs: T0 + 10 })];
  d.observe(same, { observedAtMs: T0 + 10 });
  const r = d.observe(same, { observedAtMs: T0 + 20 });
  check('9.3 同毫秒两个会话都被确认', r.confirmedCandidates.length === 2);
  check('9.4 同毫秒按 id 稳定排序',
    r.confirmedCandidates[0].id === 'mvs_a1' && r.confirmedCandidates[1].id === 'mvs_z1');
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. 同批重复 id 冲突 -> fail closed ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const r = d.observe(
    [row({ id: 'mvs_cf1', createdAtMs: T0 + 10, parentSessionId: '' }),
      row({ id: 'mvs_cf1', createdAtMs: T0 + 10, parentSessionId: 'mvs_parent1' })],
    { observedAtMs: T0 + 10 });
  check('10.1 同批冲突 -> 本读不确认并计数',
    r.confirmedCandidates.length === 0 && r.rejected['duplicate-conflict'] === 1);
  const r2 = d.observe([row({ id: 'mvs_cf1', createdAtMs: T0 + 10, parentSessionId: '' })], { observedAtMs: T0 + 20 });
  check('10.2 冲突 id 在后续干净读里最多成为候选（本读不确认）',
    r2.confirmedCandidates.length === 0 && ids(d.snapshot().candidates).includes('mvs_cf1'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 11. 账本上限耗尽 -> 停止收新候选，不重放旧的 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0, maxTracked: 2 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_lim1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_lim1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 20 });
  check('11.1 上限内正常确认', r.confirmedCandidates.length === 1 && r.confirmedCandidates[0].id === 'mvs_lim1');
  d.observe([row({ id: 'mvs_lim2', createdAtMs: T0 + 30 })], { observedAtMs: T0 + 30 });
  const r2 = d.observe(
    [row({ id: 'mvs_lim3', createdAtMs: T0 + 40 }), row({ id: 'mvs_lim2', createdAtMs: T0 + 30 })],
    { observedAtMs: T0 + 40 });
  check('11.2 超出上限的 id 不入选但已有候选照常确认',
    !ids(r2.confirmedCandidates).includes('mvs_lim3')
    && ids(r2.confirmedCandidates).includes('mvs_lim2'));
  check('11.3 溢出被报告', r2.overflow.dropped > 0, `dropped=${r2.overflow.dropped}`);
  const r3 = d.observe(
    [row({ id: 'mvs_lim1', createdAtMs: T0 + 10 }), row({ id: 'mvs_lim2', createdAtMs: T0 + 30 })],
    { observedAtMs: T0 + 50 });
  check('11.4 已确认的 id 不被重放', r3.confirmedCandidates.length === 0);
  const seen = new Set();
  for (const rr of [r, r2, r3]) for (const c of rr.confirmedCandidates) seen.add(c.id);
  check('11.5 被上限拒绝的 id 永不出现在确认里', !seen.has('mvs_lim3'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 12. 候选超时期限（第二次读） ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0, candidateTtlMs: 1000 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_exp1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
  const r = d.observe([], { observedAtMs: T0 + 1011 });
  check('12.1 候选超时 -> 过期诊断且不确认',
    r.expired.some((x) => x.id === 'mvs_exp1' && x.reason === 'ttl-expired')
    && r.confirmedCandidates.length === 0);
  const r2 = d.observe([row({ id: 'mvs_exp1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 1012 });
  check('12.2 过期后重新出现也不会被确认', r2.confirmedCandidates.length === 0);
}
{
  // The gap case: the candidate is still there when the deadline passes, so a
  // read AFTER firstSeen+TTL must NOT confirm it.
  const d = createNewMainSessionDetector({ startedAtMs: 1000, candidateTtlMs: 1000 });
  d.observe([], { observedAtMs: 1000 });
  const cand = row({ id: 'mvs_gap1', createdAtMs: 1001 });
  d.observe([cand], { observedAtMs: 1001 });
  const r = d.observe([cand], { observedAtMs: 1001 + 1001 });
  check('12.3 期限后同一读出现 -> 过期，不确认',
    r.confirmedCandidates.length === 0 && r.expired.some((x) => x.id === 'mvs_gap1'),
    JSON.stringify(r.expired));
  const r2 = d.observe([cand], { observedAtMs: 1001 + 1002 });
  check('12.4 过期后不再重发', r2.confirmedCandidates.length === 0);
  const shape = (x) => Object.keys(x).sort().join(',');
  check('12.5 observe/snapshot 的 expired 字段一致',
    r.expired.length === 1 && shape(r.expired[0]) === shape(d.snapshot().expired[0])
    && shape(r.expired[0]) === 'createdAtMs,id,reason',
    `${shape(r.expired[0] || {})} vs ${shape(d.snapshot().expired[0] || {})}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 13. 洪水：子代理 + 旧数字 id 撑不起账本 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0, maxTracked: 4 });
  const history = [];
  for (let i = 0; i < 1200; i++) {
    history.push(row({ id: String(100000 + i), createdAtMs: T0 - 5000 - i, sessionKind: 'task' }));
  }
  const subs = [];
  for (let i = 0; i < 300; i++) {
    subs.push(row({
      id: `mvs_sub${String(i).padStart(4, '0')}`,
      createdAtMs: T0 + 100 + i,
      parentSessionId: 'mvs_parent1',
      sessionKind: 'task',
    }));
  }
  const real = row({ id: 'mvs_real01', createdAtMs: T0 + 500, parentSessionId: null, sessionKind: 'conversation' });

  d.observe(history, { observedAtMs: T0 + 1 });
  d.observe([...history, ...subs, real], { observedAtMs: T0 + 600 });
  const r = d.observe([...history, ...subs, real], { observedAtMs: T0 + 700 });
  check('13.1 洪水后真实新会话仍被输出', r.confirmedCandidates.length === 1 && r.confirmedCandidates[0].id === 'mvs_real01');
  check('13.2 洪水没有占满账本', d.snapshot().tracked === 1, `tracked=${d.snapshot().tracked}`);
  // The age check runs BEFORE the id format check, so old rows never spend a
  // slot on 'id-format'.
  check('13.3 旧数字 id 按创建时间先判，只进 before-cutoff',
    d.snapshot().rejected['before-cutoff'] >= 1200 && !d.snapshot().rejected['id-format'],
    JSON.stringify(d.snapshot().rejected));
  check('13.4 子代理只进计数', d.snapshot().rejected['has-parent'] >= 300);
}

// ---------------------------------------------------------------------------
console.log('\n=== 14. visibility：hidden / unknown 不可入选 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const r = d.observe(
    [row({ id: 'mvs_fork1', createdAtMs: T0 + 10, visibility: 'hidden' }),
      row({ id: 'mvs_unk01', createdAtMs: T0 + 10, visibility: 'unknown' }),
      row({ id: 'mvs_nullv', createdAtMs: T0 + 10, visibility: null })],
    { observedAtMs: T0 + 10 });
  check('14.1 hidden fork 零输出', r.confirmedCandidates.length === 0);
  check('14.2 hidden 只进计数', r.rejected['visibility-hidden'] === 1);
  check('14.3 unknown/null 只进计数',
    r.rejected['visibility-unknown'] === 2, JSON.stringify(r.rejected));
  check('14.4 hidden/unknown 不占账本', d.snapshot().tracked === 0);
}
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const before = JSON.stringify(d.snapshot());
  let threw = 0;
  try {
    d.observe([row({ id: 'mvs_vis1', createdAtMs: T0 + 10, visibility: undefined })], { observedAtMs: T0 + 10 });
  } catch { threw++; }
  check('14.5 visibility 缺失 -> 整读拒绝', threw === 1);
  check('14.6 visibility 缺失的整读不推进任何状态', JSON.stringify(d.snapshot()) === before);
}
{
  // A visible parentless fork shows up as an independent conversation, so it
  // counts as a new conversation here. Root is not required.
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  d.observe([row({ id: 'mvs_fork2', createdAtMs: T0 + 10, parentSessionId: null, visibility: 'visible' })], { observedAtMs: T0 + 10 });
  const r = d.observe([row({ id: 'mvs_fork2', createdAtMs: T0 + 10, parentSessionId: null, visibility: 'visible' })], { observedAtMs: T0 + 20 });
  check('14.7 visible 的无父 fork 算新对话', r.confirmedCandidates.length === 1 && r.confirmedCandidates[0].id === 'mvs_fork2');
}

// ---------------------------------------------------------------------------
console.log('\n=== 15. 候选 metadata 改变 -> 永久 tombstone ===');
{
  const cases = [
    ['archived', row({ id: 'mvs_tb1', createdAtMs: T0 + 10, archived: 1 })],
    ['parent-changed', row({ id: 'mvs_tb1', createdAtMs: T0 + 10, parentSessionId: 'mvs_parent1' })],
    ['kind-changed', row({ id: 'mvs_tb1', createdAtMs: T0 + 10, sessionKind: 'task' })],
    ['created-changed', row({ id: 'mvs_tb1', createdAtMs: T0 + 999 })],
    ['visibility-changed', row({ id: 'mvs_tb1', createdAtMs: T0 + 10, visibility: 'hidden' })],
  ];
  for (const [reason, changed] of cases) {
    const d = createNewMainSessionDetector({ startedAtMs: T0 });
    d.observe([], { observedAtMs: T0 + 1 });
    d.observe([row({ id: 'mvs_tb1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 10 });
    const r = d.observe([changed], { observedAtMs: T0 + 20 });
    const tomb = d.snapshot().tombstones.find((t) => t.id === 'mvs_tb1');
    check(`15.${cases.findIndex((c) => c[0] === reason) + 1} ${reason} -> tombstone`,
      r.confirmedCandidates.length === 0 && tomb && tomb.reason === reason,
      `tomb=${tomb ? tomb.reason : 'none'}`);
    const r2 = d.observe([row({ id: 'mvs_tb1', createdAtMs: T0 + 10 })], { observedAtMs: T0 + 30 });
    check(`15.${cases.findIndex((c) => c[0] === reason) + 1}b ${reason} -> 回到原值也不重发`,
      r2.confirmedCandidates.length === 0);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 16. kind branch 是合法会话类型，不当坏行 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const r = d.observe([row({ id: 'mvs_br01', createdAtMs: T0 + 10, sessionKind: 'branch' })], { observedAtMs: T0 + 10 });
  check('16.1 kind=branch 不抛错', true);
  check('16.2 kind=branch 只进计数不进账本',
    r.rejected['kind-not-conversation'] === 1 && d.snapshot().tracked === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 17. DB 层的 NULL：行级拒绝，整读继续 ===');
{
  const d = createNewMainSessionDetector({ startedAtMs: T0 });
  d.observe([], { observedAtMs: T0 + 1 });
  const r = d.observe(
    [row({ id: 'mvs_nc01', createdAtMs: null }),
      row({ id: 'mvs_nk01', createdAtMs: T0 + 10, sessionKind: null }),
      row({ id: 'mvs_na01', createdAtMs: T0 + 10, archived: null }),
      row({ id: 'mvs_np01', createdAtMs: T0 + 10, parentSessionId: null })],
    { observedAtMs: T0 + 10 });
  check('17.1 NULL 字段不抛错，整读继续', true);
  check('17.2 createdAtMs=NULL -> 行级拒绝',
    r.rejected['created-unknown'] === 1 && d.snapshot().tracked === 1);
  check('17.3 sessionKind=NULL -> 行级拒绝', r.rejected['kind-unknown'] === 1);
  check('17.4 archived=NULL -> 行级拒绝', r.rejected['archived-unknown'] === 1);
  check('17.5 parentSessionId=NULL -> 仍算无父，入候选',
    ids(d.snapshot().candidates).includes('mvs_np01'));
  const r2 = d.observe(
    [row({ id: 'mvs_nc01', createdAtMs: null }),
      row({ id: 'mvs_nk01', createdAtMs: T0 + 10, sessionKind: null }),
      row({ id: 'mvs_na01', createdAtMs: T0 + 10, archived: null }),
      row({ id: 'mvs_np01', createdAtMs: T0 + 10, parentSessionId: null })],
    { observedAtMs: T0 + 20 });
  check('17.6 NULL 行永不入选，NULL 父的行照常确认',
    !ids(r2.confirmedCandidates).includes('mvs_nc01')
    && !ids(r2.confirmedCandidates).includes('mvs_nk01')
    && !ids(r2.confirmedCandidates).includes('mvs_na01')
    && ids(r2.confirmedCandidates).includes('mvs_np01'));
}

console.log(`\npass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-new-main-sessions: ALL GREEN' : 'test-new-main-sessions: FAILED');
process.exit(fail === 0 ? 0 : 1);
