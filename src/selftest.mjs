// mmx-status :: selftest.mjs
// Verifies everything that does NOT need a live CDP connection:
//   1. status-db reads the real MiniMax Code database read-only
//   2. bucketFor() maps the real status vocabulary correctly
//   3. page-script expressions are syntactically valid and contain no
//      destructive DOM calls
//
//   node selftest.mjs

import fs from 'node:fs';
import { StatusDb, BUCKET, bucketFor, DEFAULT_DB } from './lib/status-db.mjs';
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

console.log('\n=== 2. 真实数据库只读读取 ===');
const db = new StatusDb(DEFAULT_DB);
const counts = db.counts();
console.log('  分布:', JSON.stringify(counts));
check('读到了会话', db._map.size > 0, `${db._map.size} 条`);
check('存在 running 会话', counts.running > 0, `running=${counts.running}`);
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

console.log(`\n=== E2E 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
