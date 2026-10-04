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
// 行工厂以前只传 status，从来不传 terminalOutcome —— 这正是覆盖漏洞
// （README §15.16.3 / 1003.md §14.30.3「测试覆盖的漏洞」一节登记的那一条）。
// 现在第三个参数透传给 bucketFor，覆盖表 1-6 的 outcome 组合；
// 只传 status 的旧调用点行为完全不变（extra 默认为空对象）。
const row = (id, status, extra = {}) => ({ id, status, bucket: bucketFor({ status, ...extra }), title: id });
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
  // STALE error vs waiting -- the 2026-10-03 live case (session mvs_1feaae52
  // "MMX Code 远程web版"): status='idle', terminal_outcome='completed', but a
  // leftover error_message ("BYOK provider ... 429") from an earlier failed
  // turn, while TWO Agent Team sub agents were actively running. bucketFor
  // painted it error via hasErrorMessage and the overlay skipped it, so the
  // user saw red instead of yellow while the chat pane said "等待 Agent Team
  // 返回结果...". Rule: only the LIVE status field keeps red safe; an
  // error_message / terminal_outcome on an idle session is history, and a
  // running child is the present.
  const staleMsg = { id: 's1', status: 'idle', bucket: BUCKET.error, title: 's1' };
  const staleOutcome = { id: 's2', status: 'idle', bucket: BUCKET.error, title: 's2' };
  const liveErr = { id: 's3', status: 'error', bucket: BUCKET.error, title: 's3' };
  const m = new Map([['s1', staleMsg], ['s2', staleOutcome], ['s3', liveErr]]);
  StatusDb.applyWaitingOverlay(m, new Map([['s1', D(2, 0)], ['s2', D(1, 0)], ['s3', D(1, 0)]]));
  check('陈旧 error_message（status=idle）+ 活子 agent -> waiting 接管',
    m.get('s1').bucket === BUCKET.waiting, `got=${m.get('s1').bucket}`);
  check('陈旧 terminal_outcome=failed（status=idle）+ 活子 agent -> waiting 接管',
    m.get('s2').bucket === BUCKET.waiting, `got=${m.get('s2').bucket}`);
  check('status=error 的活错误 + 活子 agent -> 仍 error（红不被盖）',
    m.get('s3').bucket === BUCKET.error, `got=${m.get('s3').bucket}`);
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
// 表 1-8：判据顺序（README §15.16.3 / 1003.md §14.30.3，验收矩阵 A3-A7）。
// 这一节全部用【真实的 overlay】跑，而不是只测纯函数：表 2 / 表 4 的期望
// 绿/橙只有 overlay 真的放过 running / paused 才成立。
console.log('\n=== 3b. 判据顺序：当前状态优先于上一轮残留（A3-A7）===');
const FAILED = { terminalOutcome: 'failed' };
const FAILED_ERR = { terminalOutcome: 'failed', hasErrorMessage: true };

// 表 1 / A3：started + failed，无子 agent。红曾盖住绿。
{
  const r = row('t1', 'started', FAILED);
  check('表1 started+failed 无子 agent -> running', r.bucket === BUCKET.running, `got=${r.bucket}`);
  const r2 = row('t1b', 'started', FAILED_ERR);
  check('表1 started+failed+error_message -> running', r2.bucket === BUCKET.running, `got=${r2.bucket}`);
}
// 表 2 / A4：started + failed，有子 agent。黄曾盖住绿。
{
  const m = new Map([['t2', row('t2', 'started', FAILED)]]);
  StatusDb.applyWaitingOverlay(m, new Map([['t2', D(2, 0)]]));
  check('表2 started+failed 有子 agent -> 仍是 running', m.get('t2').bucket === BUCKET.running,
    `got=${m.get('t2').bucket}`);
  check('表2 没有被挂上 waiting 明细', m.get('t2').waiting === undefined,
    JSON.stringify(m.get('t2').waiting));
}
// 表 3 / A5（上半）：interrupted + failed，无子 agent。红曾盖住橙。
{
  const r = row('t3', 'interrupted', FAILED);
  check('表3 interrupted+failed 无子 agent -> paused', r.bucket === BUCKET.paused, `got=${r.bucket}`);
}
// 表 4 / A5（下半）：interrupted + failed，有子 agent。黄曾盖住橙。
{
  const m = new Map([['t4', row('t4', 'interrupted', FAILED)]]);
  StatusDb.applyWaitingOverlay(m, new Map([['t4', D(1, 0)]]));
  check('表4 interrupted+failed 有子 agent -> 仍是 paused', m.get('t4').bucket === BUCKET.paused,
    `got=${m.get('t4').bucket}`);
}
// 表 5 / A6：aborted + failed。取消是终态，不是故障。
{
  const r = row('t5', 'aborted', FAILED);
  check('表5 aborted+failed 默认 -> idle（不点亮）', r.bucket === BUCKET.idle, `got=${r.bucket}`);
  const r2 = row('t5b', 'aborted', { ...FAILED, includeAborted: true });
  check('表5 aborted+failed includeAborted -> paused', r2.bucket === BUCKET.paused, `got=${r2.bucket}`);
  const r3 = row('t5c', 'aborted', FAILED_ERR);
  check('表5 aborted+failed+error_message 默认仍不点亮', r3.bucket === BUCKET.idle, `got=${r3.bucket}`);
}
// 表 6 / A7：idle + completed + 残留 error_message。完成态优先。
{
  const r = row('t6', 'idle', { terminalOutcome: 'completed', hasErrorMessage: true });
  check('表6 idle+completed+error_message -> done', r.bucket === BUCKET.done, `got=${r.bucket}`);
  const r2 = row('t6b', 'idle', { terminalOutcome: 'completed' });
  check('表6 idle+completed（无 err）-> done', r2.bucket === BUCKET.done, `got=${r2.bucket}`);
  // 同一条 idle+completed+残留 err 的会话：bucketFor 现在给 done（最低优先级），
  // 所以有活子 agent 时 overlay 会把它接成 waiting。这不是新行为，是 done 一直
  // 就是最低优先级（见上面表里 d 的断言）；这里锁的是它【不再】被染成 error 后
  // 还会保持 error。
  const m = new Map([['t6', row('t6', 'idle', { terminalOutcome: 'completed', hasErrorMessage: true })]]);
  StatusDb.applyWaitingOverlay(m, new Map([['t6', D(1, 0)]]));
  check('表6 idle+completed+err 有子 agent -> 不再是 error', m.get('t6').bucket !== BUCKET.error,
    `got=${m.get('t6').bucket}`);
}
// 表 7 / 表 8：必须保留红的两条基础策略。
{
  check('表7 idle+failed 保留 error',
    row('t7', 'idle', FAILED).bucket === BUCKET.error,
    `got=${row('t7', 'idle', FAILED).bucket}`);
  check('表8 裸 idle+error_message 保留 error',
    row('t8', 'idle', { hasErrorMessage: true }).bucket === BUCKET.error,
    `got=${row('t8', 'idle', { hasErrorMessage: true }).bucket}`);
}
// 表 9：live error / failed + 有子 agent，overlay 显式豁免。
{
  const m = new Map([
    ['t9a', row('t9a', 'error', FAILED_ERR)],
    ['t9b', row('t9b', 'failed', FAILED_ERR)],
  ]);
  StatusDb.applyWaitingOverlay(m, new Map([['t9a', D(1, 0)], ['t9b', D(1, 0)]]));
  check('表9 live error+子 agent -> 仍是 error', m.get('t9a').bucket === BUCKET.error,
    `got=${m.get('t9a').bucket}`);
  check('表9 live failed+子 agent -> 仍是 error', m.get('t9b').bucket === BUCKET.error,
    `got=${m.get('t9b').bucket}`);
}
// 表 10：不在词表内的 status。无补充字段 => 无点；有补充字段 => 照旧红。
{
  check('表10 unknown 无补充字段 -> idle 无点',
    bucketFor({ status: 'weird' }) === BUCKET.idle);
  check('表10 unknown + failed -> 仍红', bucketFor({ status: 'weird', terminalOutcome: 'failed' }) === BUCKET.error,
    `got=${bucketFor({ status: 'weird', terminalOutcome: 'failed' })}`);
  check('表10 unknown + error_message -> 仍红',
    bucketFor({ status: 'weird', hasErrorMessage: true }) === BUCKET.error);
}
// 顺序不变量：补充判据对【当前状态】零影响。任一把补充字段插回前面的改动先撞它。
{
  const supplementary = [{ terminalOutcome: 'failed' }, { hasErrorMessage: true },
    { terminalOutcome: 'failed', hasErrorMessage: true }];
  const currentStates = ['started', 'interrupted', 'aborted', 'error', 'failed'];
  const leaks = [];
  for (const st of currentStates) {
    const base = bucketFor({ status: st });
    for (const extra of supplementary) {
      const after = bucketFor({ status: st, ...extra });
      if (after !== base) leaks.push(`${st}+${JSON.stringify(extra)}=${after} vs bare=${base}`);
    }
  }
  check('补充判据对当前状态零影响（顺序不变量）', leaks.length === 0, leaks.join(','));
}

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
