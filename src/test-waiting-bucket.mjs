// mmx-status :: test-waiting-bucket.mjs
//
// Regression tests for the `waiting` bucket: a session that owns live work
// (a running sub agent session, or a running background task) even when its
// own turn has already finished.
//
// Everything here is hermetic. The overlay rule is exercised on synthetic Maps,
// and the page-side rule is exercised on the real bootstrap expression, so the
// suite does not need a CDP connection and does not depend on what happens to
// be running on this machine at the time it runs.

import { StatusDb, BUCKET, bucketFor, DEFAULT_DB } from './lib/status-db.mjs';
import { buildBootstrapExpression } from './lib/page-script.mjs';
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

// ---------------------------------------------------------------------------
console.log('\n=== 1. isWaiting 纯判定 ===');
check('null 不是 waiting', StatusDb.isWaiting(null) === false);
check('undefined 不是 waiting', StatusDb.isWaiting(undefined) === false);
check('{subagent:0,bash:0} 不是 waiting', StatusDb.isWaiting({ subagent: 0, bash: 0 }) === false);
check('有子 agent 即 waiting', StatusDb.isWaiting({ subagent: 1, bash: 0 }) === true);
check('有后台命令即 waiting', StatusDb.isWaiting({ subagent: 0, bash: 1 }) === true);
check('两者都有也是 waiting', StatusDb.isWaiting({ subagent: 3, bash: 2 }) === true);

// ---------------------------------------------------------------------------
console.log('\n=== 2. overlay 规则（合成数据，不依赖真实库状态）===');
const row = (id, status) => ({ id, status, bucket: bucketFor({ status }), title: id });
const D = (subagent, bash) => ({ subagent, bash });

// The headline regression: a session whose turn is OVER but whose sub agent is
// still going must light up. Gating on status==='started' would miss it, and
// that is exactly the situation the user reported.
{
  const m = new Map([
    ['idle-parent', row('idle-parent', 'idle')],
    ['live-parent', row('live-parent', 'started')],
  ]);
  StatusDb.applyWaitingOverlay(m, new Map([['idle-parent', D(1, 0)]]));
  check(
    'turn 已结束(idle) 但有 running 子 agent -> waiting',
    m.get('idle-parent').bucket === BUCKET.waiting,
    `got=${m.get('idle-parent').bucket}`
  );
  check('无关会话不受影响', m.get('live-parent').bucket === BUCKET.running, `got=${m.get('live-parent').bucket}`);
}
{
  // A session that is ACTIVELY running must stay green, even while it owns live
  // sub agents. This assertion used to read the opposite ("waiting 覆盖 running").
  //
  // Why it was wrong, measured on the live database (2026-10-02): the user's own
  // root session read status='started' with 2 live sub agents, so the unguarded
  // overlay painted the user's OWN row yellow for the whole time the agent was
  // working. The root almost always has sub agents while it works, which made
  // "waiting" a constant colour and cost green `running` any meaning.
  const m = new Map([['x', row('x', 'started')]]);
  StatusDb.applyWaitingOverlay(m, new Map([['x', D(2, 0)]]));
  check('父会话自身在跑(有子 agent) -> 仍是 running，不被染黄',
    m.get('x').bucket === BUCKET.running, `got=${m.get('x').bucket}`);
  check('未被染黄时也不挂 waiting 明细', m.get('x').waiting === undefined,
    JSON.stringify(m.get('x').waiting));
}
{
  // Precedence lock: error > running > paused > waiting. None of the three may
  // be repainted -- a failure, a live turn, and an interrupted turn all say
  // something more urgent (and more actionable) than "waiting".
  const m = new Map([
    ['e', row('e', 'error')],
    ['p', row('p', 'interrupted')],
    ['r', row('r', 'started')],
    ['d', { id: 'd', status: 'idle', bucket: BUCKET.done, title: 'd' }],
  ]);
  StatusDb.applyWaitingOverlay(m, new Map([['e', D(1, 0)], ['p', D(1, 0)], ['r', D(1, 0)], ['d', D(1, 0)]]));
  check('error 优先于 waiting（红不被黄盖掉）', m.get('e').bucket === BUCKET.error, `got=${m.get('e').bucket}`);
  check('paused 优先于 waiting（橙色中断态是待用户处理，不该被盖）',
    m.get('p').bucket === BUCKET.paused, `got=${m.get('p').bucket}`);
  check('running 优先于 waiting', m.get('r').bucket === BUCKET.running, `got=${m.get('r').bucket}`);
  check('done 可被 waiting 接走（最低优先级，无信息可遮蔽）',
    m.get('d').bucket === BUCKET.waiting, `got=${m.get('d').bucket}`);
}
{
  // A finished sub agent (detail counts at zero) must NOT light anything up.
  const m = new Map([['x', row('x', 'started')], ['y', row('y', 'idle')]]);
  StatusDb.applyWaitingOverlay(m, new Map([['x', D(0, 0)], ['y', D(0, 0)]]));
  check('子 agent 已跑完 -> 仍是 running', m.get('x').bucket === BUCKET.running, `got=${m.get('x').bucket}`);
  check('子 agent 已跑完 -> idle 仍无点', m.get('y').bucket === BUCKET.idle, `got=${m.get('y').bucket}`);
}
{
  // Archived / unknown ids must not become phantom rows.
  const m = new Map([['known', row('known', 'idle')]]);
  StatusDb.applyWaitingOverlay(m, new Map([['ghost', D(1, 0)], ['known', D(0, 1)]]));
  check('未知 id 不产生幽灵行', !m.has('ghost'));
  check('已知 id 正常判 waiting', m.get('known').bucket === BUCKET.waiting);
}
{
  // The detail is attached for the UI, so assert it survives. The parent is
  // 'idle' on purpose: a 'started' parent is no longer overlaid at all.
  const m = new Map([['x', row('x', 'idle')]]);
  StatusDb.applyWaitingOverlay(m, new Map([['x', D(2, 1)]]));
  check('waiting 明细被挂到行上', JSON.stringify(m.get('x').waiting) === JSON.stringify(D(2, 1)),
    JSON.stringify(m.get('x').waiting));
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. bucketFor 本身没被污染（仍是单行纯函数）===');
check('started -> running', bucketFor({ status: 'started' }) === BUCKET.running);
check('idle -> idle', bucketFor({ status: 'idle' }) === BUCKET.idle);
check('interrupted -> paused', bucketFor({ status: 'interrupted' }) === BUCKET.paused);
check('bucketFor 不知道 waiting（无子信息输入）', bucketFor({ status: 'idle', waiting: true }) === BUCKET.idle);
check('BUCKET 含 waiting', BUCKET.waiting === 'waiting');

// ---------------------------------------------------------------------------
console.log('\n=== 4. 真实库只读：overlay 与查询接得上 ===');
if (fs.existsSync(DEFAULT_DB)) {
  const db = new StatusDb(DEFAULT_DB);
  const c = db.counts();
  console.log('  分布:', JSON.stringify(c));
  check('counts 守恒', Object.values(c).reduce((a, b) => a + b, 0) === db._map.size);
  check('counts 含 waiting 键', 'waiting' in c);
  const snap = db.snapshot();
  check('snapshot 值都是合法 bucket',
    Object.values(snap).every((v) => Object.values(BUCKET).includes(v)));
  const waitingRows = [...db._map.values()].filter((v) => v.bucket === BUCKET.waiting);
  check('每个 waiting 行都带 waiting 明细',
    waitingRows.every((v) => StatusDb.isWaiting(v.waiting)), `${waitingRows.length} 行`);
  check('每个 waiting 行都能在 waitingDetail 里找到',
    waitingRows.every((v) => db.waitingDetail.has(v.id)));
  // Whatever the machine happens to be doing, the invariant must hold.
  check('waiting 行里没有 idle 明细',
    waitingRows.every((v) => v.waiting.subagent > 0 || v.waiting.bash > 0));
  db.close();
} else {
  console.log('  (数据库不存在，跳过真实库断言)');
}

// ---------------------------------------------------------------------------
console.log('\n=== 4b. kind=subagent 过滤是回归锁（防误判 75% 复发）===');
{
  // The single most important guard in this file. An earlier draft queried
  // background_tasks with no kind filter, and on the live database that marked
  // 3 of 5 started sessions as waiting when all they had was a background
  // SHELL command running. bash outnumbers subagent 7631:377, so without this
  // predicate nearly every long-running shell anywhere would paint a row yellow.
  const dbSrc = fs.readFileSync(new URL('./lib/status-db.mjs', import.meta.url), 'utf8');
  const stmt = dbSrc.slice(dbSrc.indexOf('_stmtBgRunning'));
  const block = stmt.slice(0, stmt.indexOf(');'));
  check("bg 查询限定 kind='subagent'", /kind\s*=\s*'subagent'/.test(block), block.replace(/\s+/g, ' ').trim());
  check('bg 查询仍带 status=running', /status\s*=\s*'running'/.test(block));
  check('bg 查询仍带 ended_at_ms IS NULL', /ended_at_ms\s+IS\s+NULL/.test(block));
  // No heartbeat exists on a running subagent row (24 s of sampling left
  // updated_at_ms unchanged), so it must not appear in the predicate at all.
  check('没有用 updated_at_ms 做新鲜度判断', !/updated_at_ms\s*(=|>|<)/.test(block));
  check('没有给子 agent 判据加 TTL（会误杀合法长等待）', !/\bttl\b/i.test(block));

  // counts() keys must come from BUCKET, not a hand-written literal. A literal
  // is what produced waiting: NaN before this was derived.
  check('counts() 从 BUCKET 派生 key', /for\s*\(const\s+b\s+of\s+Object\.values\(BUCKET\)\)\s*c\[b\]\s*=\s*0/.test(dbSrc));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. 页面侧：waiting 必须有样式且会被置顶 ===');
const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
check('CSS 有 waiting 竖条', pageSrc.includes('[data-mmx-bucket="waiting"]{'));
check('CSS 有 waiting 行底色', pageSrc.includes('[data-mmx-bucket="waiting"]){') && /waiting"\]\)\{/.test(pageSrc));
check('CSS 有 waiting 标题色（走主题变量）', pageSrc.includes('var(--yellow_700,#a16207)'));
check('waiting 行底色与 running 同 alpha(0.10)', pageSrc.includes('rgba(234,179,8,.10)'));
check('running 仍是绿底且未被改动', pageSrc.includes('rgba(34,197,94,.10)'));
check('置顶同时认 running 与 waiting',
  pageSrc.includes('data-mmx-bucket="running"]\'') && pageSrc.includes('data-mmx-bucket="waiting"]\''));
check('置顶分组为 running 优先', pageSrc.includes('runW.concat(waitW)'));
check('stats 统计 waiting', pageSrc.includes('waitingOnScreen'));
check('汇总条传入 waiting 数', pageSrc.includes('updateSummary(stats.runningOnScreen, stats.waitingOnScreen)'));
check('汇总条有 waiting 段', pageSrc.includes('data-mmx-wait'));
// Guard: paused and waiting must not be the same hue family by accident.
check('paused 仍用 orange_400', pageSrc.includes('var(--orange_400,#f59e0b)'));
check('waiting 未复用 orange（避免撞色）', !pageSrc.includes('[data-mmx-bucket="waiting"]{ background:var(--orange_400'));

// ---------------------------------------------------------------------------
console.log('\n=== 6. 注入表达式语法合法 ===');
try {
  const expr = buildBootstrapExpression({ status: {}, reorder: true });
  new Function('return ' + expr);
  check('buildBootstrapExpression 可解析', true, `len=${expr.length}`);
} catch (e) {
  check('buildBootstrapExpression 可解析', false, e.message);
}

console.log(`\npass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-waiting-bucket: ALL GREEN' : 'test-waiting-bucket: FAILED');
process.exit(fail === 0 ? 0 : 1);
