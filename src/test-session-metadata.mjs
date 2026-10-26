// mmx-status :: test-session-metadata.mjs
//
// Offline tests for the DB metadata channel in lib/status-db.mjs.
//
// The metadata channel exists so a BRAND NEW conversation can be recognised
// even while it is still idle -- the bucket snapshot deliberately hides idle
// rows, so the status snapshot alone cannot tell "new" from "old".
//
// Pure in-memory only: no database file, no host, no process control. The
// production query is exercised against node:sqlite(':memory:') so the REAL
// SQL runs without touching the user's live database.
//
//   node test-session-metadata.mjs
//
// What is NOT proven here: that a metadata row is a ROOT session. The DB layer
// reports columns and nothing else; every classification belongs to the
// detector.

import * as statusDb from './lib/status-db.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const { StatusDb, BUCKET } = statusDb;

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

const T0 = 1700000000000;

/** The production module source, for the source-level locks at the end. */
const SRC = fs.readFileSync(new URL('./lib/status-db.mjs', import.meta.url), 'utf8');

/** One row shaped exactly like node:sqlite hands it back. */
function srow(over = {}) {
  return {
    id: 'mvs_row01',
    status: 'idle',
    title: '标题',
    err: null,
    outcome: null,
    createdAtMs: T0,
    parentSessionId: null,
    sessionKind: 'conversation',
    visibility: 'visible',
    archived: 0,
    ...over,
  };
}

/**
 * A StatusDb instance with stubbed statements: no database, no files.
 * collectWaiting is stubbed too, so the waiting overlay can be driven
 * without a live host.
 */
function stubDb({ rows = [], waiting = new Map(), failAll = false, failWaiting = false } = {}) {
  const db = Object.create(StatusDb.prototype);
  db.path = ':memory:';
  db.includeAborted = false;
  db.db = null;
  db._map = new Map();
  db._metadata = [];
  db.waitingDetail = new Map();
  db._stmtSessions = {
    all() {
      if (failAll) throw new Error('sqlite: database is locked');
      return rows;
    },
  };
  db._stmtChildRunning = { all: () => [] };
  db._stmtBgRunning = { all: () => [] };
  db.collectWaiting = () => {
    if (failWaiting) throw new Error('sqlite: waiting query failed');
    return waiting;
  };
  return db;
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. idle 会话进 metadata，但原 snapshot 仍然不显示 ===');
{
  const db = stubDb({ rows: [srow({ id: 'mvs_idle1', status: 'idle' })] });
  db.refresh();
  const meta = db.sessionMetadata();
  check('1.1 idle 会话出现在 metadata', meta.length === 1 && meta[0].id === 'mvs_idle1');
  check('1.2 idle 会话不出现在 snapshot', !('mvs_idle1' in db.snapshot()));
  check('1.3 snapshot 仍为空', Object.keys(db.snapshot()).length === 0);
  check('1.4 metadata 覆盖 idle 行（这正是新通道的意义）',
    db.sessionMetadata().some((m) => m.id === 'mvs_idle1'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. 既有 bucket / snapshot 输出完全不变 ===');
{
  const rows = [
    srow({ id: 'mvs_run1', status: 'started' }),
    srow({ id: 'mvs_pau1', status: 'interrupted' }),
    srow({ id: 'mvs_err1', status: 'error' }),
    srow({ id: 'mvs_err2', status: 'idle', outcome: 'failed' }),
    srow({ id: 'mvs_done1', status: 'idle', outcome: 'completed' }),
    srow({ id: 'mvs_wait1', status: 'idle' }),
    srow({ id: 'mvs_idle1', status: 'idle' }),
  ];
  const waiting = new Map([['mvs_wait1', { subagent: 1, bash: 0 }]]);
  const db = stubDb({ rows, waiting });
  db.refresh();
  const snap = db.snapshot();
  check('2.1 started -> running', snap['mvs_run1'] === BUCKET.running, `got=${snap['mvs_run1']}`);
  check('2.2 interrupted -> paused', snap['mvs_pau1'] === BUCKET.paused, `got=${snap['mvs_pau1']}`);
  check('2.3 error -> error', snap['mvs_err1'] === BUCKET.error, `got=${snap['mvs_err1']}`);
  check('2.4 idle+failed -> error', snap['mvs_err2'] === BUCKET.error, `got=${snap['mvs_err2']}`);
  check('2.5 idle+completed -> done', snap['mvs_done1'] === BUCKET.done, `got=${snap['mvs_done1']}`);
  check('2.6 idle+活子 agent -> waiting', snap['mvs_wait1'] === BUCKET.waiting, `got=${snap['mvs_wait1']}`);
  check('2.7 纯 idle 仍不点亮', !('mvs_idle1' in snap));
  check('2.8 metadata 覆盖全部行', db.sessionMetadata().length === rows.length);
  check('2.9 counts 守恒',
    Object.values(db.counts()).reduce((a, b) => a + b, 0) === db._map.size);
  check('2.10 waitingDetail 语义不变', db.waitingDetail.get('mvs_wait1').subagent === 1);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. parent 的 SQL NULL 与空串完整保留 ===');
{
  const db = stubDb({
    rows: [
      srow({ id: 'mvs_nullp', parentSessionId: null }),
      srow({ id: 'mvs_emptyp', parentSessionId: '' }),
      srow({ id: 'mvs_childp', parentSessionId: 'mvs_parent1' }),
    ],
  });
  db.refresh();
  const byId = new Map(db.sessionMetadata().map((m) => [m.id, m]));
  check('3.1 SQL NULL 原样保留为 null', byId.get('mvs_nullp').parentSessionId === null);
  check('3.2 空串原样保留为 \'\'', byId.get('mvs_emptyp').parentSessionId === '');
  check('3.3 空串不被折叠成 null', byId.get('mvs_emptyp').parentSessionId !== null);
  check('3.4 父 id 原样保留', byId.get('mvs_childp').parentSessionId === 'mvs_parent1');
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. kind / visibility / archived 不被误转换 ===');
{
  const db = stubDb({
    rows: [
      srow({ id: 'mvs_kind1', sessionKind: 'task' }),
      srow({ id: 'mvs_kind2', sessionKind: 'conversation' }),
      srow({ id: 'mvs_vis1', visibility: 'hidden' }),
      srow({ id: 'mvs_vis2', visibility: 'visible' }),
      srow({ id: 'mvs_arch1', archived: 1 }),
    ],
  });
  db.refresh();
  const byId = new Map(db.sessionMetadata().map((m) => [m.id, m]));
  check('4.1 kind=task 原样', byId.get('mvs_kind1').sessionKind === 'task');
  check('4.2 kind=conversation 原样', byId.get('mvs_kind2').sessionKind === 'conversation');
  check('4.3 visibility=hidden 原样', byId.get('mvs_vis1').visibility === 'hidden');
  check('4.4 visibility=visible 原样', byId.get('mvs_vis2').visibility === 'visible');
  check('4.5 archived=1 原样', byId.get('mvs_arch1').archived === 1);
  check('4.6 DB 层不做 root 判定（kind=task 仍在 metadata 里）', byId.has('mvs_kind1'));
  check('4.7 createdAtMs 原样', byId.get('mvs_kind1').createdAtMs === T0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. metadata 不带标题 / 正文 / error ===');
{
  const db = stubDb({
    rows: [srow({ id: 'mvs_p1', title: '机密标题', err: 'boom', outcome: 'completed' })],
  });
  db.refresh();
  const m = db.sessionMetadata()[0];
  const keys = Object.keys(m).sort().join(',');
  check('5.1 metadata 字段集合固定',
    keys === 'archived,createdAtMs,id,parentSessionId,sessionKind,visibility', keys);
  check('5.2 无 title', !('title' in m));
  check('5.3 无 err / error', !('err' in m) && !('error' in m) && !('error_message' in m));
  check('5.4 无 outcome', !('outcome' in m));
  check('5.5 序列化后不含标题与错误正文',
    !JSON.stringify(m).includes('机密标题') && !JSON.stringify(m).includes('boom'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. 调用方改返回值不会改到内部状态 ===');
{
  const db = stubDb({ rows: [srow({ id: 'mvs_mut1' })] });
  db.refresh();
  const first = db.sessionMetadata();
  first.push({ id: 'mvs_injected' });
  first[0].id = 'mvs_changed';
  first[0].createdAtMs = 1;
  const second = db.sessionMetadata();
  check('6.1 外部改数组不影响内部', second.length === 1);
  check('6.2 外部改对象不影响内部',
    second[0].id === 'mvs_mut1' && second[0].createdAtMs === T0,
    JSON.stringify(second[0]));
  check('6.3 每次返回新数组', second !== first);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. 读取失败时全状态不前进（map 与 metadata 一起）===');
{
  const db = stubDb({ rows: [srow({ id: 'mvs_ok1', status: 'started' })] });
  db.refresh();
  const snapBefore = JSON.stringify(db.snapshot());
  const metaBefore = JSON.stringify(db.sessionMetadata());
  const mapBefore = db._map;
  const detailBefore = db.waitingDetail;
  // 引用（identity）也要锁住。只比 JSON 内容的话，「先把 _metadata 提交了再
  // 抛错」这种变异内容一模一样，比不出来——失败那趟的 rows 与基线同内容，
  // 所以内容相等是必然的，只有对象没被换掉才是真正的证据。
  const metaRefBefore = db._metadata;

  db._stmtSessions = { all() { throw new Error('sqlite: database is locked'); } };
  let threw = 0;
  try { db.refresh(); } catch { threw++; }
  check('7.1 all() 抛错向上冒泡', threw === 1);
  check('7.2 all() 抛错后 map 不前进',
    db._map === mapBefore && JSON.stringify(db.snapshot()) === snapBefore);
  check('7.3 all() 抛错后 metadata 不前进',
    JSON.stringify(db.sessionMetadata()) === metaBefore);
  check('7.4 all() 抛错后 metadata 对象没被换掉（identity 不变）',
    db._metadata === metaRefBefore);

  db._stmtSessions = { all: () => [srow({ id: 'mvs_ok1', status: 'started' })] };
  db.collectWaiting = () => { throw new Error('sqlite: waiting query failed'); };
  threw = 0;
  try { db.refresh(); } catch { threw++; }
  check('7.5 collectWaiting 抛错向上冒泡', threw === 1);
  check('7.6 collectWaiting 抛错后 map 不前进',
    db._map === mapBefore && JSON.stringify(db.snapshot()) === snapBefore);
  check('7.7 collectWaiting 抛错后 metadata 不前进',
    JSON.stringify(db.sessionMetadata()) === metaBefore);
  check('7.8 collectWaiting 抛错后 metadata 对象没被换掉（identity 不变）',
    db._metadata === metaRefBefore);
  check('7.9 collectWaiting 抛错后 waitingDetail 不前进', db.waitingDetail === detailBefore);
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. 成功读到空结果 -> 空输出 ===');
{
  const db = stubDb({ rows: [] });
  db.refresh();
  check('8.1 metadata 为空数组',
    Array.isArray(db.sessionMetadata()) && db.sessionMetadata().length === 0);
  check('8.2 snapshot 为空', Object.keys(db.snapshot()).length === 0);
  check('8.3 map 为空', db._map.size === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. 同 id 多行保留（冲突留给 detector 判定）===');
{
  const db = stubDb({
    rows: [
      srow({ id: 'mvs_dup1', parentSessionId: null }),
      srow({ id: 'mvs_dup1', parentSessionId: 'mvs_parent1' }),
    ],
  });
  db.refresh();
  const meta = db.sessionMetadata();
  check('9.1 同 id 两行都保留', meta.length === 2 && meta.every((m) => m.id === 'mvs_dup1'));
  check('9.2 两行 metadata 不同（冲突可观察）',
    meta[0].parentSessionId !== meta[1].parentSessionId);
  check('9.3 map 仍按 id 覆盖（既有行为不变）', db._map.size === 1);
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. 真实 SQL：node:sqlite(\':memory:\')，不碰真实库 ===');
{
  check('10.0 SESSIONS_SQL 已导出', typeof statusDb.SESSIONS_SQL === 'string');
  if (typeof statusDb.SESSIONS_SQL === 'string') {
    const mem = new DatabaseSync(':memory:');
    mem.exec(`
      CREATE TABLE local_runtime_sessions (
        session_id        TEXT PRIMARY KEY,
        status            TEXT,
        title             TEXT,
        error_message     TEXT,
        created_at_ms     INTEGER,
        parent_session_id TEXT,
        session_kind      TEXT,
        visibility        TEXT,
        archived          INTEGER
      );
      CREATE TABLE local_runtime_session_agent_state (
        session_id       TEXT,
        terminal_outcome TEXT
      );
    `);
    const ins = mem.prepare(`
      INSERT INTO local_runtime_sessions
        (session_id, status, title, error_message, created_at_ms,
         parent_session_id, session_kind, visibility, archived)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    ins.run('mvs_nullp', 'idle', 'T1', null, T0, null, 'conversation', 'visible', 0);
    ins.run('mvs_emptyp', 'idle', 'T2', null, T0 + 1, '', 'conversation', 'visible', 0);
    ins.run('mvs_task1', 'started', 'T3', null, T0 + 2, null, 'task', 'visible', 0);
    ins.run('mvs_hidden1', 'idle', 'T4', null, T0 + 3, null, 'conversation', 'hidden', 0);
    ins.run('mvs_arch1', 'idle', 'T5', null, T0 + 4, null, 'conversation', 'visible', 1);
    mem.prepare(
      'INSERT INTO local_runtime_session_agent_state (session_id, terminal_outcome) VALUES (?,?)'
    ).run('mvs_nullp', 'completed');

    const stmt = mem.prepare(statusDb.SESSIONS_SQL);
    const rows = stmt.all();
    check('10.1 归档行仍被 WHERE 过滤', !rows.some((r) => r.id === 'mvs_arch1'));
    check('10.2 行数 = 未归档行数', rows.length === 4, `len=${rows.length}`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    check('10.3 created_at_ms -> createdAtMs', byId.get('mvs_nullp').createdAtMs === T0);
    check('10.4 parent NULL 仍是 null', byId.get('mvs_nullp').parentSessionId === null);
    check('10.5 parent 空串仍是空串', byId.get('mvs_emptyp').parentSessionId === '');
    check('10.6 session_kind -> sessionKind', byId.get('mvs_task1').sessionKind === 'task');
    check('10.7 visibility -> visibility', byId.get('mvs_hidden1').visibility === 'hidden');
    check('10.8 archived -> archived', byId.get('mvs_nullp').archived === 0);
    check('10.9 epoch ms 是安全整数', Number.isSafeInteger(byId.get('mvs_emptyp').createdAtMs));

    // 真实查询结果直接喂进 refresh：metadata 与 snapshot 都要对得上
    const db = stubDb();
    db._stmtSessions = stmt;
    db.refresh();
    const meta = db.sessionMetadata();
    check('10.10 refresh 后 metadata 行数一致', meta.length === rows.length, `len=${meta.length}`);
    check('10.11 idle+completed -> done', db.snapshot()['mvs_nullp'] === BUCKET.done);
    check('10.12 started -> running', db.snapshot()['mvs_task1'] === BUCKET.running);
    check('10.13 hidden 行仍进 metadata（分类交给 detector）',
      meta.some((m) => m.id === 'mvs_hidden1'));
    check('10.14 真实行的 parent null / 空串都进了 metadata',
      meta.find((m) => m.id === 'mvs_nullp').parentSessionId === null
      && meta.find((m) => m.id === 'mvs_emptyp').parentSessionId === '');

    // 归档恢复：archived 1 -> 0 之后，这一行重新进入通道。
    // WHERE archived = 0 只反映【当前】状态，不是历史过滤：恢复之后它又在了。
    // 创建时间不因恢复而改变，是不是「旧会话」由 caller 的 created cutoff 决定。
    mem.prepare('UPDATE local_runtime_sessions SET archived = 0 WHERE session_id = ?')
      .run('mvs_arch1');
    const rows2 = stmt.all();
    check('10.15 恢复归档后该行重新出现在查询结果里',
      rows2.length === 5 && rows2.some((r) => r.id === 'mvs_arch1'),
      `len=${rows2.length}`);
    const db2 = stubDb();
    db2._stmtSessions = stmt;
    db2.refresh();
    const meta2 = db2.sessionMetadata();
    const restored = meta2.find((m) => m.id === 'mvs_arch1');
    check('10.16 恢复行重新进入 metadata', !!restored);
    check('10.17 恢复行 createdAtMs 原样不变', !!restored && restored.createdAtMs === T0 + 4);
    check('10.18 恢复行 archived 字段为 0', !!restored && restored.archived === 0);
    mem.close();
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 11. constructor 初始化 metadata ===');
{
  // 没有可读的数据库文件就没法构造真实实例（:memory: 不能只读打开），
  // 所以这里只锁住「构造函数在 refresh 之前把 metadata 备好」这条约定。
  const ctor = SRC.slice(SRC.indexOf('constructor('), SRC.indexOf('collectWaiting()'));
  check('11.1 constructor 里初始化 _metadata', /this\._metadata\s*=\s*\[\]/.test(ctor));
  check('11.2 初始化早于 refresh()',
    ctor.indexOf('this._metadata = []') !== -1
    && ctor.indexOf('this._metadata = []') < ctor.indexOf('this.refresh()'));
}

// ---------------------------------------------------------------------------
console.log('\n=== 12. 归档按当前态过滤：过滤只在 SQL 里 ===');
{
  // 12a 查询层面：仍是同一条 SELECT、仍只过滤 archived = 0，没有为了「拿到
  // 全历史」去加第二个查询或全表扫描。
  const sql = statusDb.SESSIONS_SQL;
  check('12.1 查询仍限定 archived = 0', /WHERE\s+s\.archived\s*=\s*0/.test(sql));
  check('12.2 仍只有一条 SELECT，没有新增查询',
    (sql.match(/SELECT/gi) || []).length === 1, `selects=${(sql.match(/SELECT/gi) || []).length}`);
  check('12.3 没有为了取归档行去放宽过滤',
    !/archived\s*!=\s*0|archived\s*>\s*0|archived\s*=\s*1/i.test(sql));
  check('12.4 没有新增全表扫描（只有一条 FROM）',
    (sql.match(/\bFROM\b/gi) || []).length === 1,
    `from=${(sql.match(/\bFROM\b/gi) || []).length}`);
}
{
  // 12b 值层面：DB 字段坏了也原样保留 NULL，不在这里猜、不在这里修。
  // 上层（detector）自己决定怎么 fail-closed。
  const db = stubDb({
    rows: [
      srow({
        id: 'mvs_null1',
        parentSessionId: null,
        visibility: null,
        sessionKind: null,
        createdAtMs: null,
      }),
      srow({
        id: 'mvs_null2',
        parentSessionId: '',
        visibility: '',
        sessionKind: 'conversation',
        createdAtMs: T0,
      }),
    ],
  });
  db.refresh();
  const byId = new Map(db.sessionMetadata().map((m) => [m.id, m]));
  check('12.5 parent NULL 仍是 null', byId.get('mvs_null1').parentSessionId === null);
  check('12.6 visibility NULL 仍是 null', byId.get('mvs_null1').visibility === null);
  check('12.7 sessionKind NULL 仍是 null', byId.get('mvs_null1').sessionKind === null);
  check('12.8 createdAtMs NULL 仍是 null', byId.get('mvs_null1').createdAtMs === null);
  check('12.9 空串不被转成 null',
    byId.get('mvs_null2').parentSessionId === '' && byId.get('mvs_null2').visibility === '');
}
{
  // 12c 行为层：metadata 层自己【不】按 archived 过滤。在不在通道里，完全
  // 由查询的当前态过滤决定——真实 SQL 已经证过两端：archived=1 时不在
  // （10.1），恢复成 0 之后又回来（10.15-10.18）。
  const db = stubDb({ rows: [srow({ id: 'mvs_arch2', archived: 1 })] });
  db.refresh();
  check('12.10 metadata 层不自行过滤 archived（过滤只在 SQL 里）',
    db.sessionMetadata().some((m) => m.id === 'mvs_arch2'));
}

console.log(`\npass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-session-metadata: ALL GREEN' : 'test-session-metadata: FAILED');
process.exit(fail === 0 ? 0 : 1);
