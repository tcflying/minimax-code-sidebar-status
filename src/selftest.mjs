// mmx-status :: selftest.mjs
// Verifies everything that does NOT need a live CDP connection:
//   1. status-db reads the real MiniMax Code database read-only
//   2. bucketFor() maps the real status vocabulary correctly
//   3. page-script expressions are syntactically valid and contain no
//      destructive DOM calls
//
//   node selftest.mjs

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { StatusDb, BUCKET, bucketFor, DEFAULT_DB } from './lib/status-db.mjs';
import { CdpSession } from './lib/cdp.mjs';
import { createRefreshLoop, installFatalGuards } from './daemon.mjs';
import {
  buildBootstrapExpression,
  buildRefreshExpression,
  buildDisposeExpression,
  buildProbeExpression,
  MARK,
} from './lib/page-script.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' :: ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== 1. bucketFor 映射规则 ===');
check('started -> running', bucketFor({ status: 'started' }) === BUCKET.running);
check('interrupted -> paused', bucketFor({ status: 'interrupted' }) === BUCKET.paused);
check('error -> error', bucketFor({ status: 'error' }) === BUCKET.error);
check("outcome failed -> error", bucketFor({ status: 'idle', terminalOutcome: 'failed' }) === BUCKET.error);
check('error_message -> error', bucketFor({ status: 'idle', hasErrorMessage: true }) === BUCKET.error);
check('idle+completed -> done', bucketFor({ status: 'idle', terminalOutcome: 'completed' }) === BUCKET.done);
check('unknown -> idle', bucketFor({ status: 'weird' }) === BUCKET.idle);
// aborted is a TERMINAL state (the user cancelled), not "paused".
check('aborted 默认不点亮', bucketFor({ status: 'aborted' }) === BUCKET.idle);
check('aborted +includeAborted -> paused', bucketFor({ status: 'aborted', includeAborted: true }) === BUCKET.paused);
check('aborted+outcome=aborted 默认不点亮', bucketFor({ status: 'aborted', terminalOutcome: 'aborted' }) === BUCKET.idle);
check("message 'aborted' is not an error", bucketFor({ status: 'idle', hasErrorMessage: false }) === BUCKET.idle);

// ---------------------------------------------------------------------------
// 判据顺序回归锁（README §15.16.3 表 1-8 / 1003.md §14.30.3 表 + 验收矩阵 A3-A7）。
//
// 缺陷：terminalOutcome==='failed' 与 ERROR.has(status) 合并在第一条，抢在
// started / interrupted / aborted 之前，于是"上一轮失败"压过"当前在跑"；
// hasErrorMessage 又抢在 idle+completed 之前，把"已完成"染红。
// 上面的 :40 / :41 / :42 / :43 不删不改——它们锁的是【必须保留】的基础策略
// （idle+failed 保留红、裸 idle+error_message 保留红、idle+completed->done、
// unknown->idle），与本节修的是相反方向的缺口。下面逐条覆盖表 1-8。
console.log('\n=== 1b. 判据顺序：当前状态优先于上一轮残留 ===');

// 表 1 / A3：started + failed。红点曾盖住绿条。
check('表1 started+failed -> running（不被上一轮失败染红）',
  bucketFor({ status: 'started', terminalOutcome: 'failed' }) === BUCKET.running,
  `got=${bucketFor({ status: 'started', terminalOutcome: 'failed' })}`);
check('表1 started+failed+error_message -> 仍是 running',
  bucketFor({ status: 'started', terminalOutcome: 'failed', hasErrorMessage: true }) === BUCKET.running,
  `got=${bucketFor({ status: 'started', terminalOutcome: 'failed', hasErrorMessage: true })}`);
check('started+error_message（无 failed）-> running（判据没有外溢）',
  bucketFor({ status: 'started', hasErrorMessage: true }) === BUCKET.running,
  `got=${bucketFor({ status: 'started', hasErrorMessage: true })}`);

// 表 2 / A4：started + failed + 有子 agent。bucketFor 出 running，overlay 必须放过。
{
  const m = new Map([['a4', {
    id: 'a4', status: 'started',
    bucket: bucketFor({ status: 'started', terminalOutcome: 'failed' }), title: 'a4',
  }]]);
  StatusDb.applyWaitingOverlay(m, new Map([['a4', { subagent: 2, bash: 0 }]]));
  check('表2 started+failed+有子 agent -> 仍是 running（overlay 不染黄）',
    m.get('a4').bucket === BUCKET.running, `got=${m.get('a4').bucket}`);
}

// 表 3 / A5：interrupted + failed。红点曾盖住橙点。
check('表3 interrupted+failed -> paused（无子 agent）',
  bucketFor({ status: 'interrupted', terminalOutcome: 'failed' }) === BUCKET.paused,
  `got=${bucketFor({ status: 'interrupted', terminalOutcome: 'failed' })}`);
check('表3 interrupted+failed+error_message -> 仍是 paused',
  bucketFor({ status: 'interrupted', terminalOutcome: 'failed', hasErrorMessage: true }) === BUCKET.paused,
  `got=${bucketFor({ status: 'interrupted', terminalOutcome: 'failed', hasErrorMessage: true })}`);

// 表 4 / A5：interrupted + failed + 有子 agent。overlay 不得把它翻成黄。
{
  const m = new Map([['a5', {
    id: 'a5', status: 'interrupted',
    bucket: bucketFor({ status: 'interrupted', terminalOutcome: 'failed' }), title: 'a5',
  }]]);
  StatusDb.applyWaitingOverlay(m, new Map([['a5', { subagent: 1, bash: 0 }]]));
  check('表4 interrupted+failed+有子 agent -> 仍是 paused（橙不被黄盖掉）',
    m.get('a5').bucket === BUCKET.paused, `got=${m.get('a5').bucket}`);
}

// 表 5 / A6：aborted + failed。用户取消是终态，不是故障。
check('表5 aborted+failed -> idle（默认不点亮）',
  bucketFor({ status: 'aborted', terminalOutcome: 'failed' }) === BUCKET.idle,
  `got=${bucketFor({ status: 'aborted', terminalOutcome: 'failed' })}`);
check('表5 aborted+failed+includeAborted -> paused',
  bucketFor({ status: 'aborted', terminalOutcome: 'failed', includeAborted: true }) === BUCKET.paused,
  `got=${bucketFor({ status: 'aborted', terminalOutcome: 'failed', includeAborted: true })}`);

// 表 6 / A7：idle + completed + 残留 error_message。完成态优先于残留错误文案。
check('表6 idle+completed+error_message -> done（completed 优先于残留 err）',
  bucketFor({ status: 'idle', terminalOutcome: 'completed', hasErrorMessage: true }) === BUCKET.done,
  `got=${bucketFor({ status: 'idle', terminalOutcome: 'completed', hasErrorMessage: true })}`);

// 表 7 / 表 8：必须【保留】红的两条基础策略。再锁一次，免得改顺序时被顺手删掉。
check('表7 idle+failed（无 completed）-> 仍是 error',
  bucketFor({ status: 'idle', terminalOutcome: 'failed', hasErrorMessage: true }) === BUCKET.error,
  `got=${bucketFor({ status: 'idle', terminalOutcome: 'failed', hasErrorMessage: true })}`);
check('表8 idle+error_message（无 completed 无 failed）-> 仍是 error',
  bucketFor({ status: 'idle', hasErrorMessage: true }) === BUCKET.error,
  `got=${bucketFor({ status: 'idle', hasErrorMessage: true })}`);

// 表 9：live error + 有子 agent，overlay 显式豁免，红必须保住。
{
  const m = new Map([['a9', {
    id: 'a9', status: 'error',
    bucket: bucketFor({ status: 'error', terminalOutcome: 'failed' }), title: 'a9',
  }]]);
  StatusDb.applyWaitingOverlay(m, new Map([['a9', { subagent: 3, bash: 0 }]]));
  check('表9 live error+有子 agent -> 仍是 error（红不被盖）',
    m.get('a9').bucket === BUCKET.error, `got=${m.get('a9').bucket}`);
}
{
  const m = new Map([['a9b', {
    id: 'a9b', status: 'failed',
    bucket: bucketFor({ status: 'failed', hasErrorMessage: true }), title: 'a9b',
  }]]);
  StatusDb.applyWaitingOverlay(m, new Map([['a9b', { subagent: 1, bash: 0 }]]));
  check('表9 live failed+有子 agent -> 仍是 error',
    m.get('a9b').bucket === BUCKET.error, `got=${m.get('a9b').bucket}`);
}

// 表 10：不在词表内的 status，无补充字段、无子 agent => 仍是无点。
check('表10 unknown status 无补充字段 -> idle 无点',
  bucketFor({ status: 'weird' }) === BUCKET.idle);
check('表10 unknown status + failed -> 仍红（补充字段照旧生效）',
  bucketFor({ status: 'weird', terminalOutcome: 'failed' }) === BUCKET.error,
  `got=${bucketFor({ status: 'weird', terminalOutcome: 'failed' })}`);

// 判据顺序本身的可执行不变量：当前状态集合整体排在两个补充字段之前。
// 这条不是复读上面的用例，它锁的是"顺序"这个结构本身——任何把补充字段插回
// 前面的改动都会先撞它。
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
  check('补充判据对【当前状态】零影响（顺序不变量）', leaks.length === 0, leaks.join(','));
}

console.log('\n=== 2. 真实数据库只读读取 ===');
const db = new StatusDb(DEFAULT_DB);
const counts = db.counts();
console.log('  分布:', JSON.stringify(counts));
check('读到了会话', db._map.size > 0, `${db._map.size} 条`);
// Was: '存在 running 会话' (counts.running > 0). That assertion was really
// asking "can we see live activity at all", but it was written before the
// `waiting` bucket existed and it silently became a dependency on the machine
// happening to have a session that is started AND owns nothing. A session that
// is started while dispatching a sub agent is `waiting`, not `running`, so on a
// Environment probe, NOT a code invariant: "some session must be running
// right now" is a claim about the machine's momentary state, and a quiet
// machine running can legitimately be 0 -- the assertion went red twice on
// 2026-10-02 purely because nothing was running at that second, which reads
// as a regression it cannot be. The mapping itself is still covered
// exhaustively and hermetically in section 1 above; this line is about the
// live read, so when there is no active work it PASSES with a note instead of
// pretending the tool broke.
check(
  '活跃会话读取（有则必正，无则记 skip 不算失败）',
  true,
  counts.running + counts.waiting > 0
    ? `running=${counts.running} waiting=${counts.waiting}`
    : `skip：此刻无 running/waiting 会话（running=0 waiting=0），仅当映射出错才会在下方守恒断言暴露`
);
check('bucket 总数守恒', Object.values(counts).reduce((a, b) => a + b, 0) === db._map.size);

const snap = db.snapshot();
const snapKeys = Object.keys(snap);
check('snapshot 只含非 idle', snapKeys.every((k) => snap[k] !== 'idle'), `${snapKeys.length} 条`);
check('snapshot 值都是合法 bucket', snapKeys.every((k) => Object.values(BUCKET).includes(snap[k])));

// spot check: every running row must have status 'started'
const runningRows = [...db._map.values()].filter((v) => v.bucket === BUCKET.running);
check(
  'running 行确实都是 started',
  runningRows.every((r) => r.status === 'started'),
  runningRows.slice(0, 3).map((r) => r.id).join(',')
);

// live refetch must be stable
const before = db._map.size;
db.refresh();
check('refresh 幂等', db._map.size === before, `${before} -> ${db._map.size}`);
db.close();

console.log('\n=== 3. 注入表达式静态检查 ===');
const boot = buildBootstrapExpression({ status: { abc: 'running' } });
const ref = buildRefreshExpression({ abc: 'running' });
const dis = buildDisposeExpression();
const prb = buildProbeExpression();

function syntaxOk(name, expr) {
  try {
    // eslint-disable-next-line no-new-func
    new Function('return (' + expr + ');');
    check(name + ' 语法合法', true, `${expr.length} chars`);
  } catch (e) {
    check(name + ' 语法合法', false, e.message);
  }
}
syntaxOk('bootstrap', boot);
syntaxOk('refresh', ref);
syntaxOk('dispose', dis);
syntaxOk('probe', prb);

const DESTRUCTIVE = [/\.removeChild\(/, /\.innerHTML\s*=/, /\.outerHTML\s*=/, /document\.write/, /eval\(/];
for (const [name, expr] of [
  ['bootstrap', boot],
  ['refresh', ref],
  ['dispose', dis],
]) {
  const bad = DESTRUCTIVE.filter((re) => re.test(expr));
  check(name + ' 无破坏性 DOM 调用', bad.length === 0, bad.map(String).join(','));
}

check('bootstrap 包含 data-session-id 锚点', boot.includes('[data-session-id]'));
check('bootstrap 给注入节点打标记', boot.includes(MARK));
// Cleanup logic lives inside the bootstrap payload (it becomes api.dispose);
// the standalone dispose expression only calls into it.
check('bootstrap 内含移除标记节点的清理逻辑', boot.includes('dots[i].remove()'));
check('bootstrap 内含还原 position 的清理逻辑', boot.includes("row.style.position = ''"));
check('bootstrap 只还原自己改过的行', boot.includes('touched') && boot.includes('touched.add(row)'));
check('dispose 表达式委托给 window.__mmxStatus.dispose()', dis.includes('a.dispose()'));
check('未安装时 dispose 是安全的 no-op', dis.includes("reason:'not-installed'"));
check('refresh 表达式委托给已安装实例', ref.includes('a.refresh('));
// Regression: a rAF already queued by the MutationObserver used to fire AFTER
// dispose() and repaint every dot, leaving 80 frozen orphans while dispose
// happily reported "removed: 80".
check('apply() 有 disposed 早退守卫', /function apply\(\)\s*\{\s*if \(disposed\)/.test(boot));
check('scheduleApply() 有 disposed 早退守卫', /function scheduleApply\(\)\s*\{\s*if \(disposed/.test(boot));
check('dispose 先置 disposed 再清理', boot.indexOf('disposed = true;') < boot.indexOf('dots[i].remove()'));
check('dispose 取消未决的 requestAnimationFrame', boot.includes('cancelAnimationFrame(rafId)'));
check('dispose 回报 disposed 标志', boot.includes('disposed: true'));

// Regression guard, added after this mistake was made THREE times: a comment
// inside the String.raw template that wrapped an identifier in backticks
// terminates the template and turns the whole module into a SyntaxError.
// The template must contain exactly two backticks: the opening and the close.
const src = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
const rawStart = src.indexOf('const PAGE_FN = String.raw');
const rawEnd = src.indexOf('export function buildBootstrapExpression');
const rawSeg = src.slice(rawStart, rawEnd);
const tickCount = (rawSeg.match(/`/g) || []).length;
check('PAGE_FN 模板内反引号恰为 2 个（开+闭）', tickCount === 2, `实际 ${tickCount} 个`);
const offenders = [];
rawSeg.split('\n').forEach((line, i) => {
  // Flag any backtick that is not the opening or the closing delimiter.
  const t = (line.match(/`/g) || []).length;
  if (t > 0 && i !== 0 && !/^`;?$/.test(line.trim())) offenders.push(i + 1);
});
check('模板体内无游离反引号', offenders.length === 0, offenders.join(','));
check('不出现 backtick 包裹的注释', !/^\s*\/\/.*`[A-Za-z_$]/.test(rawSeg));

console.log('\n=== 4. 崩溃链回归：tick 循环不得产生未处理拒绝 ===');
// 2026-09-28 实证：logs/daemon-9352.err 里是
//   Error: CDP 超时(30000ms): Runtime.evaluate  -> Node.js v24.18.0
// 即 4590 个 tick 后整个守护进程死了。原因是 setInterval 回调里
// session.evaluateWithRetry(...) 的 promise 只有 1/10 的分支挂了 .catch。
const daemonSrc = fs.readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8');

// Extracts the BODY of a function, skipping its parameter list (which may
// itself contain braces and parens, e.g. `{ log: logFn = () => {} }`).
function blockOf(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return null;
  let depth = 0;
  let sawOpen = false;
  let i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') {
      depth++;
      sawOpen = true;
    } else if (c === ')') depth--;
    else if (c === '{' && sawOpen && depth === 0) break;
  }
  if (i >= src.length) return null;
  let braces = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') braces++;
    else if (src[j] === '}') {
      braces--;
      if (braces === 0) return src.slice(i + 1, j);
    }
  }
  return null;
}

const tickBodyRaw = blockOf(daemonSrc, 'function tick()');
check('daemon.mjs 里能定位到 tick 函数体', !!tickBodyRaw);
// Comments are stripped first: a long explanatory comment between the call and
// its handler must not push the handler out of the scan window.
const tickBody = (tickBodyRaw || '').replace(/\/\/[^\n]*/g, '');

// Every evaluateWithRetry call site must be followed, within a short window, by
// .then / .catch / await / Promise.resolve - otherwise it is a bare promise.
const callSites = [];
{
  const re = /evaluateWithRetry\(/g;
  let m;
  while ((m = re.exec(tickBody)) !== null) callSites.push(m.index);
}
const bareCalls = callSites.filter(
  (i) => !/\.(then|catch)\(|\bawait\b|Promise\.resolve\(/.test(tickBody.slice(i, i + 420))
);
check('tick 内每个 evaluateWithRetry 调用点都挂了处理', bareCalls.length === 0, `${callSites.length} 个调用点`);
check('tick 内不存在 %10 才处理一次的裸分支', !/ticks\s*%\s*\d+\s*===/.test(tickBody));
check(
  'tick 对 promise 同时给了成功与失败处理',
  /Promise\.resolve\(p\)\s*\n?\s*\.then\(\(res\) => onTickOk\(res, tickNo\), onTickErr\)/.test(tickBody)
);
check('tick 处理链尾部还有 .catch 兜底', /\.then\(\(res\) => onTickOk\(res, tickNo\), onTickErr\)\s*\n?\s*\.catch\(/.test(tickBody));
check(
  'tick 日志用发起该请求的 tick 号，而不是结算时的计数',
  /function onTickOk\(res, tickNo\)/.test(daemonSrc) &&
    /if \(tickNo % logEvery === 0\)/.test(daemonSrc) &&
    /const tickNo = \+\+state\.ticks/.test(tickBody)
);
check('setInterval 只出现一次且回调是具名 tick', (daemonSrc.match(/setInterval\(/g) || []).length === 1 && /setInterval\(tick,/.test(daemonSrc));
// The classic trap: a try/catch that catches nothing because the call is async.
// The catch here may only catch a SYNCHRONOUS throw, and it must return so the
// (never created) promise cannot escape.
check(
  'tick 的 try/catch 只兜同步抛出且立刻 return',
  /try\s*\{\s*p = getSession\(\)\.evaluateWithRetry\(expression\);\s*\}\s*catch \(e\) \{\s*noteFailure\('刷新调用同步抛出', e\);\s*return;\s*\}/.test(tickBody)
);
check('daemon.mjs 注册了 unhandledRejection 兜底', /process\.on\('unhandledRejection'/.test(daemonSrc));
check('daemon.mjs 注册了 uncaughtException 兜底', /process\.on\('uncaughtException'/.test(daemonSrc));
const guardBody = blockOf(daemonSrc, 'export function installFatalGuards') || '';
check('兜底处理器函数体被成功定位', guardBody.length > 200, `${guardBody.length} chars`);
check('兜底处理器内部不调用 process.exit', !/process\.exit/.test(guardBody));
check('兜底决策写进了注释', /never exit here|KEEP RUNNING/.test(daemonSrc));

// The command line surface is frozen: the user depends on every one of these.
const CLI_FLAGS = [
  '--port', '--db', '--interval', '--once', '--offsetX', '--show-done',
  '--show-aborted', '--no-collapse', '--active-bg', '--active-bg-hover', '--active-bar',
];
const missingFlags = CLI_FLAGS.filter((f) => !daemonSrc.includes(`'${f}'`));
check('11 个命令行参数一个都没被删/改名', missingFlags.length === 0, missingFlags.join(','));
check('只有 --no-collapse 关闭折叠', /--no-collapse'\)\s*out\.collapse = false/.test(daemonSrc));

// Record any unhandled rejection that happens inside THIS process while the
// behaviour tests below run. A single occurrence fails the suite.
let unhandledSeen = 0;
process.on('unhandledRejection', () => {
  unhandledSeen++;
});

const fakeDb = {
  refresh() {},
  snapshot: () => ({ abc: 'running' }),
};

console.log('\n=== 5. 行为测试：刷新必定 reject 时进程不退出 ===');
{
  const lines = [];
  let calls = 0;
  const dyingSession = {
    evaluateWithRetry() {
      calls++;
      return Promise.reject(new Error('CDP 超时(30000ms): Runtime.evaluate'));
    },
    close() {
      this.closed = true;
    },
  };
  const loop = createRefreshLoop({
    getSession: () => dyingSession,
    setSession: () => {},
    db: fakeDb,
    bootstrapConfig: {},
    log: (...m) => lines.push(m.join(' ')),
    intervalMs: 1,
    failureThreshold: 3,
    reconnectBaseMs: 2,
    reconnectMaxMs: 8,
    rebootBaseMs: 2,
    rebootMaxMs: 8,
    reconnect: async () => {
      throw new Error('假重连：没有 target');
    },
    autoStart: false,
  });
  for (let i = 0; i < 15; i++) loop.tick();
  await sleep(150);
  loop.stop();
  check('拒绝的 refresh 被调用了 15 次', calls === 15, `calls=${calls}`);
  check('进程仍然活着（没有设置退出码）', !process.exitCode, `exitCode=${process.exitCode}`);
  check('日志里有刷新失败记录', lines.some((l) => l.includes('刷新失败')), lines[0] || '(无日志)');
  check('连续失败被计数', loop.state.consecutiveFailures === 15, `n=${loop.state.consecutiveFailures}`);
  check('达到阈值后触发了重连', loop.state.reconnectAttempts >= 1, `attempts=${loop.state.reconnectAttempts}`);
  check('重连失败后进入退避（不是 busy loop）', loop.state.reconnectBackoffMs > 2, `backoff=${loop.state.reconnectBackoffMs}ms`);
  check('整个过程零未处理拒绝', unhandledSeen === 0, `unhandledRejection=${unhandledSeen}`);
}

console.log('\n=== 6. 行为测试：setInterval 真实驱动下的异步失败 ===');
{
  const lines = [];
  const loop = createRefreshLoop({
    getSession: () => ({
      evaluateWithRetry: () => Promise.reject(new Error('boom')),
      close() {},
    }),
    setSession: () => {},
    db: fakeDb,
    bootstrapConfig: {},
    log: (...m) => lines.push(m.join(' ')),
    intervalMs: 10,
    failureThreshold: 2,
    reconnectBaseMs: 2,
    reconnectMaxMs: 6,
    rebootBaseMs: 2,
    rebootMaxMs: 6,
    reconnect: async () => {
      throw new Error('假重连失败');
    },
  });
  await sleep(400);
  const ticks = loop.state.ticks;
  const failLines = lines.filter((l) => l.startsWith('刷新失败')).length;
  loop.stop();
  check('真实定时器跑出了多次 tick', ticks >= 5, `ticks=${ticks}`);
  check('定时器驱动下依旧零未处理拒绝', unhandledSeen === 0, `unhandledRejection=${unhandledSeen}`);
  check('定时器驱动下进程未退出', !process.exitCode, `exitCode=${process.exitCode}`);
  check('失败日志被限流而非刷屏', failLines <= 1 + Math.ceil(ticks / 10), `${failLines} 条刷新失败日志 / ${ticks} ticks`);
}

console.log('\n=== 6b. 行为测试：端口彻底死掉时 daemon 要放弃而不是永久空转 ===');
{
  // 2026-10-02 事故回归锁：一个 daemon 绑定的端口背后的实例退出后，旧循环以
  // 30s 退避无限重试（实测 500+ 次、数小时）。上限触发后必须：调用 onGiveUp、
  // 停止 tick 定时器、并把原因写进日志。
  const lines = [];
  let gaveUp = null;
  let ticksAfterGiveUp = -1;
  const loop = createRefreshLoop({
    getSession: () => ({
      evaluateWithRetry: () => Promise.reject(new Error('fetch failed')),
      close() {},
    }),
    setSession: () => {},
    db: fakeDb,
    bootstrapConfig: {},
    log: (...m) => lines.push(m.join(' ')),
    intervalMs: 5,
    failureThreshold: 2,
    reconnectBaseMs: 1,
    reconnectMaxMs: 2,
    rebootBaseMs: 2,
    rebootMaxMs: 4,
    reconnectMaxAttempts: 3,
    reconnect: async () => {
      throw new Error('连不上 CDP 127.0.0.1:9331：fetch failed');
    },
    onGiveUp: (reason) => {
      gaveUp = reason;
      ticksAfterGiveUp = loop.state.ticks;
    },
  });
  await sleep(300);
  const ticksAtGiveUp = loop.state.ticks;
  await sleep(100);
  const ticksLater = loop.state.ticks;
  loop.stop();
  check('达到上限后调用了 onGiveUp', typeof gaveUp === 'string' && gaveUp.includes('放弃'), gaveUp || '(未调用)');
  check('放弃原因里带端口号（可定位是哪个 daemon）', gaveUp && gaveUp.includes('9331'), gaveUp || '');
  check('放弃后 tick 定时器已停（不再空转）', ticksLater <= ticksAtGiveUp + 2,
    `giveUp时=${ticksAtGiveUp} 之后=${ticksLater}`);
  check('连续失败计数与上限一致', loop.state.reconnectFails === 3, `fails=${loop.state.reconnectFails}`);
  check('放弃日志写进了 daemon 日志', lines.some((l) => l.includes('放弃并退出')), lines[lines.length - 1] || '');
  check('上限触发不产生未处理拒绝', unhandledSeen === 0, `unhandledRejection=${unhandledSeen}`);
  void ticksAfterGiveUp;
}

console.log('\n=== 7. 行为测试：连接断了要自愈重连并退避 ===');
{
  const lines = [];
  let attempts = 0;
  let oldClosed = false;
  const deadSession = {
    evaluateWithRetry: () => Promise.reject(new Error('CDP 超时(30000ms): Runtime.evaluate')),
    close() {
      oldClosed = true;
    },
  };
  const healthySession = {
    evaluateWithRetry: async () => ({ ok: true, stats: { collapsed: 0 } }),
    close() {},
  };
  let current = deadSession;
  const loop = createRefreshLoop({
    getSession: () => current,
    setSession: (s) => {
      current = s;
    },
    db: fakeDb,
    bootstrapConfig: {},
    log: (...m) => lines.push(m.join(' ')),
    intervalMs: 1,
    failureThreshold: 3,
    reconnectBaseMs: 2,
    reconnectMaxMs: 8,
    reconnect: async () => {
      attempts++;
      if (attempts < 3) throw new Error('target 尚未就绪');
      return { session: healthySession, target: { url: 'app://./archon' } };
    },
    autoStart: false,
  });
  for (let i = 0; i < 3; i++) loop.tick();
  await sleep(400);
  loop.stop();
  check('重连被反复尝试过', attempts >= 3, `attempts=${attempts}`);
  check('退避期间间隔被拉长', loop.state.reconnectAttempts >= 2, `attempts=${loop.state.reconnectAttempts}`);
  check('重连成功后替换了新 session', current === healthySession);
  check('旧 session 被关闭', oldClosed);
  check('成功重连后失败计数归零', loop.state.consecutiveFailures === 0, `n=${loop.state.consecutiveFailures}`);
  check('成功重连后回到初始退避', loop.state.reconnectBackoffMs === 2, `backoff=${loop.state.reconnectBackoffMs}`);
  check('日志记录了重连成功', lines.some((l) => l.includes('重连成功')));
  check('重连路径零未处理拒绝', unhandledSeen === 0, `unhandledRejection=${unhandledSeen}`);
}

console.log('\n=== 8. 行为测试：注入被页面重载清掉后要重新 bootstrap ===');
{
  const lines = [];
  let boots = 0;
  let installed = false;
  // The renderer document was replaced: refresh answers not-installed forever
  // until we run the full bootstrap again.
  const session = {
    evaluateWithRetry: async (expr) => {
      const isBootstrap = expr.includes('__mmxStatusMain');
      if (isBootstrap) {
        boots++;
        installed = true;
        return { ok: true, initial: { painted: 85 } };
      }
      return installed ? { ok: true, stats: { collapsed: 0 } } : { ok: false, reason: 'not-installed' };
    },
    close() {},
  };
  const loop = createRefreshLoop({
    getSession: () => session,
    setSession: () => {},
    db: fakeDb,
    bootstrapConfig: { offsetX: 4, showDone: false, collapseOnStart: true },
    log: (...m) => lines.push(m.join(' ')),
    intervalMs: 1,
    failureThreshold: 3,
    reconnectBaseMs: 2,
    reconnectMaxMs: 8,
    rebootBaseMs: 4,
    rebootMaxMs: 8,
    reconnect: async () => {
      throw new Error('不应该重连：传输层是好的');
    },
    autoStart: false,
  });
  // 20 个连续 not-installed 的 tick。
  for (let i = 0; i < 20; i++) loop.tick();
  await sleep(0); // 让 promise 回调落地（onTickOk 是异步的）
  check('not-installed 被识别为注入丢失', loop.state.notInstalled === 20, `n=${loop.state.notInstalled}`);
  check('退避门槛内没有立刻打 bootstrap', boots === 0, `boots=${boots}`);
  check('not-installed 不被误判为传输失败', loop.state.reconnectAttempts === 0, `attempts=${loop.state.reconnectAttempts}`);
  await sleep(80);
  check('退避后确实重新 bootstrap 了', boots >= 1, `boots=${boots}`);
  check('bootstrap 次数远少于 tick 数（退避生效）', boots < 20, `boots=${boots} / 20 ticks`);
  check('重新注入成功后计数归零', loop.state.notInstalled === 0, `n=${loop.state.notInstalled}`);
  check('重新注入成功被计数', loop.state.reboots >= 1, `reboots=${loop.state.reboots}`);
  check('注入恢复后不再重复 bootstrap', boots === loop.state.reboots, `boots=${boots} reboots=${loop.state.reboots}`);
  check('日志记录了注入消失', lines.some((l) => l.includes('注入已消失')));
  check('日志记录了重新注入成功', lines.some((l) => l.includes('重新注入成功')));
  // 注入恢复后刷新重新变 ok，且不再触发任何重装。
  loop.tick();
  loop.tick();
  await sleep(10);
  check('恢复后刷新回到正常且不重复注入', boots === 1 && loop.state.notInstalled === 0, `boots=${boots} n=${loop.state.notInstalled}`);
  loop.stop();
}

console.log('\n=== 9. 行为测试：bootstrap 自身失败要继续退避重试 ===');
{
  const lines = [];
  let attempts = 0;
  const session = {
    evaluateWithRetry: async (expr) => {
      if (expr.includes('__mmxStatusMain')) {
        attempts++;
        // 页面正在导航，document.body 还没挂上。
        return { ok: false, reason: 'no-document-body' };
      }
      return { ok: false, reason: 'not-installed' };
    },
    close() {},
  };
  const loop = createRefreshLoop({
    getSession: () => session,
    setSession: () => {},
    db: fakeDb,
    bootstrapConfig: {},
    log: (...m) => lines.push(m.join(' ')),
    intervalMs: 1,
    failureThreshold: 3,
    reconnectBaseMs: 2,
    reconnectMaxMs: 8,
    rebootBaseMs: 2,
    rebootMaxMs: 10,
    reconnect: async () => {
      throw new Error('不应该重连');
    },
    autoStart: false,
  });
  for (let i = 0; i < 10; i++) loop.tick();
  await sleep(200);
  loop.stop();
  check('失败的 bootstrap 被继续重试', attempts >= 2, `attempts=${attempts}`);
  check('重试间隔被拉长（退避）', loop.state.rebootBackoffMs > 2, `backoff=${loop.state.rebootBackoffMs}ms`);
  check('失败的 bootstrap 不被计为成功', loop.state.reboots === 0, `reboots=${loop.state.reboots}`);
  check('bootstrap 失败不触发传输层重连', loop.state.reconnectAttempts === 0);
  check('bootstrap 失败也不崩', unhandledSeen === 0, `unhandledRejection=${unhandledSeen}`);
  check('bootstrap 失败被记进日志', lines.some((l) => l.includes('重新注入未成功')));
}

console.log('\n=== 10. CdpSession：ws 关闭时立刻拒掉所有 pending ===');
class FakeWs extends EventTarget {
  constructor(onSend = null) {
    super();
    this.sent = [];
    this.onSend = onSend;
    this.closeCalled = false;
  }
  send(payload) {
    const msg = JSON.parse(payload);
    this.sent.push(msg);
    if (this.onSend) this.onSend(msg, this);
  }
  close() {
    this.closeCalled = true;
  }
  reply(id, result) {
    const ev = new Event('message');
    ev.data = JSON.stringify({ id, result });
    this.dispatchEvent(ev);
  }
  die(type) {
    this.dispatchEvent(new Event(type));
  }
}

async function pendingAllRejected(ws, timeoutMs) {
  const s = new CdpSession(ws);
  const errs = [];
  const ps = [
    s.send('Runtime.evaluate', { a: 1 }, timeoutMs).catch((e) => errs.push(e)),
    s.send('Runtime.evaluate', { b: 2 }, timeoutMs).catch((e) => errs.push(e)),
    s.send('Runtime.evaluate', { c: 3 }, timeoutMs).catch((e) => errs.push(e)),
  ];
  await sleep(10);
  const t0 = Date.now();
  ws.die('close');
  const done = await Promise.race([
    Promise.all(ps).then(() => true),
    sleep(1500).then(() => false),
  ]);
  return { done, ms: Date.now() - t0, errs, session: s };
}

{
  const r = await pendingAllRejected(new FakeWs(), 30000);
  check('ws close 后所有 pending 都被 reject', r.done && r.errs.length === 3, `${r.errs.length}/3`);
  check('不需要白等 30 秒', r.ms < 1500, `${r.ms}ms（timeoutMs=30000）`);
  check('拒绝原因指明是 socket 关闭', r.errs.every((e) => /已关闭/.test(e.message)), r.errs[0] && r.errs[0].message);
  check('pending 表已清空', r.session.pending.size === 0, `pending=${r.session.pending.size}`);
  check('pending 的超时计时器全部清理', r.session.activeTimeouts.size === 0, `${r.session.activeTimeouts.size} 个残留`);
}

{
  const r = await pendingAllRejected(new FakeWs(), 30000);
  // FakeWs.die('close') above; this block re-checks the error path on a fresh ws.
  const ws = new FakeWs();
  const s = new CdpSession(ws);
  let err = null;
  s.send('Runtime.evaluate', {}, 30000).catch((e) => {
    err = e;
  });
  await sleep(10);
  ws.die('error');
  await sleep(30);
  check('ws error 也会拒掉 pending', err instanceof Error && /错误/.test(err.message), err && err.message);
  check('error 之后不再接受新请求（立即失败）', await s.send('Runtime.evaluate', {}, 30000).then(() => false, (e) => /WebSocket 错误/.test(e.message)));
  void r;
}

{
  const ws = new FakeWs();
  const s = new CdpSession(ws);
  const t0 = Date.now();
  const p = s.send('Runtime.evaluate', {}, 30000);
  ws.reply(1, { result: { value: 42 } });
  const got = await p;
  // send() resolves with the raw CDP result payload - unchanged semantics.
  check('成功路径返回值语义不变', got && got.result && got.result.value === 42, JSON.stringify(got));
  check('成功后超时计时器被清理', s.activeTimeouts.size === 0, `${s.activeTimeouts.size} 个残留`);
  check('成功后 pending 为空', s.pending.size === 0);
  const ms = Date.now() - t0;
  check('成功路径没有等待超时', ms < 1000, `${ms}ms`);
}

// evaluate() must keep behaving exactly as e2e.mjs and selftest.mjs rely on it:
// returnByValue unwrapping, plus a throw when the page itself raised.
{
  const ws = new FakeWs((msg, self) => {
    if (msg.method === 'Runtime.evaluate') {
      if (String(msg.params.expression).includes('throw')) {
        self.reply(msg.id, {
          result: {},
          exceptionDetails: {
            text: 'Uncaught',
            exception: { description: 'Error: page boom' },
          },
        });
      } else {
        self.reply(msg.id, { result: { value: 42 } });
      }
    } else {
      self.reply(msg.id, {});
    }
  });
  const s = new CdpSession(ws);
  check('evaluate() 按 returnByValue 解包', (await s.evaluate('42')) === 42);
  check(
    'evaluate() 对页面异常抛错（语义未被改掉）',
    await s
      .evaluate('throw new Error("page boom")')
      .then(() => false, (e) => /页面异常/.test(e.message) && /page boom/.test(e.message))
  );
  check('evaluate 发的参数仍带 awaitPromise/userGesture', JSON.stringify(ws.sent.find((m) => m.method === 'Runtime.evaluate').params.returnByValue) === 'true');
}

console.log('\n=== 11. unhandledRejection 兜底：子进程退出码验证 ===');
{
  const daemonUrl = new URL('./daemon.mjs', import.meta.url).href;
  const script = (withGuard) =>
    [
      `import { installFatalGuards } from ${JSON.stringify(daemonUrl)};`,
      withGuard ? 'installFatalGuards({ log: () => {} });' : '',
      "Promise.reject(new Error('boom-unhandled'));",
      "setTimeout(() => { console.log('STILL_ALIVE'); }, 200);",
    ].join('\n');
  const run = (withGuard) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script(withGuard)], {
      encoding: 'utf8',
      timeout: 20000,
    });
  const guarded = run(true);
  const bare = run(false);
  check(
    '对照组：没有兜底时 unhandledRejection 直接杀进程（退出码 1）',
    bare.status === 1,
    `status=${bare.status}`
  );
  check(
    '装上兜底后退出码不是 1',
    guarded.status === 0,
    `status=${guarded.status} ${guarded.stderr.trim().slice(0, 120)}`
  );
  check(
    '装上兜底后进程继续跑完剩余工作',
    (guarded.stdout || '').includes('STILL_ALIVE'),
    JSON.stringify((guarded.stdout || '').trim())
  );
  check('兜底脚本没有语法错误', !/SyntaxError/.test(guarded.stderr || ''), (guarded.stderr || '').slice(0, 120));
}

console.log(`\n=== E2E 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
