// mmx-status :: e2e.mjs — 真实端到端闭环验证
// 1) 注入 -> 断言有 dots  2) 停止 -> 断言 dots 归零且不再复活
// 全程对着真实 MiniMax Code 渲染进程与真实 session 数据库。
import { connectRenderer, isCdpAvailable } from './lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from './lib/status-db.mjs';
import {
  buildBootstrapExpression,
  buildRefreshExpression,
  buildDisposeExpression,
  buildProbeExpression,
} from './lib/page-script.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9352);
const db = new StatusDb(DEFAULT_DB);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};
const state = (s) => s.evaluate(`(() => ({
  dots: document.querySelectorAll('[data-mmx-dot]').length,
  api: !!window.__mmxStatus,
  style: !!document.getElementById('mmx-status-style'),
  relativeRows: [...document.querySelectorAll('[data-session-id]')].filter(r => r.style.position === 'relative').length,
}))()`);

if (!(await isCdpAvailable(port))) { console.error(`CDP ${port} 未就绪`); process.exit(2); }
const { session } = await connectRenderer(port);

console.log('\n=== 0. 环境 ===');
// A freshly launched app takes a while to fetch and render the sidebar. Running
// against a still-empty list would make every later assertion meaningless.
let probe = null;
const deadline = Date.now() + 60000;
do {
  probe = await session.evaluateWithRetry(buildProbeExpression());
  if (probe.totalRows > 0) break;
  process.stdout.write(`\r  等待侧边栏渲染... 当前 ${probe.totalRows} 行`);
  await sleep(1500);
} while (Date.now() < deadline);
process.stdout.write('\n');
console.log(`  target=${probe.url} 会话行=${probe.totalRows} 置顶行=${probe.pinnedRows}`);
console.log(`  数据库分布=${JSON.stringify(db.counts())}`);
if (probe.totalRows === 0) {
  console.log('  警告：侧边栏仍为空，跳过需要行数据的断言（空会话也能验证还原路径）');
}

console.log('\n=== 1. 注入 ===');
const boot = await session.evaluateWithRetry(buildBootstrapExpression({ status: db.snapshot() }));
const s1 = await state(session);
console.log(`  bootstrap=${JSON.stringify(boot.initial)}`);
check('bootstrap 返回 ok', boot.ok === true);
check('注入 API 已安装', s1.api === true);
check('样式已注入', s1.style === true);
if (probe.totalRows > 0) {
  check('有会话行被发现并上色', s1.dots > 0, `dots=${s1.dots}`);
  check('painted 不超过 DB 非 idle 规模',
    boot.initial.painted > 0 &&
      boot.initial.painted <= db.counts().running + db.counts().paused + db.counts().error + 5,
    `painted=${boot.initial.painted}`);
} else {
  console.log('  (跳过上色断言：侧边栏为空)');
}

console.log('\n=== 2. 刷新（模拟状态变化）===');
const before = s1.dots;
// Pick a row that ACTUALLY carries a dot. The old selector ("a row in the DOM
// whose id exists in the DB snapshot") can land on a virtualised row that was
// never painted, so deleting its status removed nothing and the assertion
// failed for the wrong reason.
const paintedId = await session.evaluateWithRetry(
  `(() => { const d = document.querySelector('[data-session-id] [data-mmx-dot]');` +
    ` return d ? d.closest('[data-session-id]').getAttribute('data-session-id') : null; })()`
);
if (paintedId) {
  const mutated = { ...db.snapshot() };
  delete mutated[paintedId];
  const r2 = await session.evaluateWithRetry(buildRefreshExpression(mutated));
  const s2 = await state(session);
  check('挑中的行确实带点（判据自证）', before > 0, `paintedId=${paintedId} before=${before}`);
  check('refresh 后该会话的点被移除', s2.dots === before - 1, `${before} -> ${s2.dots} (${JSON.stringify(r2.stats)})`);
  check('remove 计数与预期一致', r2.stats.removed === 1, JSON.stringify(r2.stats));
  check('其余点仍在', s2.dots > 0, `${s2.dots}`);
} else {
  console.log(`  (跳过刷新断言：页面上一个点都没有)`);
}

console.log('\n=== 3. 停止还原（关键回归：rAF 不得复活）===');
const disp = await session.evaluateWithRetry(buildDisposeExpression());
const s3 = await state(session);
check('dispose 报告成功', disp.ok === true, JSON.stringify(disp));
check('dispose 立即归零', s3.dots === 0, `dots=${s3.dots}`);
check('API 已卸载', s3.api === false);
check('样式已移除', s3.style === false);
check('行内联 position 已还原', s3.relativeRows === 0, `relative=${s3.relativeRows}`);

console.log('\n=== 4. 等待 10 秒确认不复活 ===');
for (const w of [4000, 6000]) {
  await sleep(w);
  const s = await state(session);
  check(`+${w}ms 仍为 0`, s.dots === 0, `dots=${s.dots}`);
}

console.log('\n=== 5. 二次注入幂等 ===');
const again = await session.evaluateWithRetry(buildBootstrapExpression({ status: db.snapshot() }));
const s5 = await state(session);
check('可重新注入', again.ok === true, `dots=${s5.dots}`);
if (probe.totalRows > 0) check('重注入后有点', s5.dots > 0, `dots=${s5.dots}`);
await session.evaluateWithRetry(buildDisposeExpression());
const s6 = await state(session);
check('再次还原归零', s6.dots === 0, `dots=${s6.dots}`);

console.log(`\n=== E2E 结果: ${pass} passed, ${fail} failed ===`);
session.close();
db.close();
process.exit(fail === 0 ? 0 : 1);
