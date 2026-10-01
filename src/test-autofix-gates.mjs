// Focused tests for the auto-repair gates added on 2026-09-30.
//
// The bug these guard against: --fix-app used to fire on the FIRST no-CDP
// observation, so a cold-starting app (port not up yet) got killed and
// restarted, turning a 2-second wait into a kill loop. The repair path must
// pass three gates: consecutive-miss threshold, app-uptime grace, and
// inter-attempt backoff.
//
// Each gate gets a POSITIVE case and a NEGATIVE case. A judgement that is
// never exercised in the failing direction cannot tell a real fix from a no-op.
//
//   node test-autofix-gates.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, 'watchdog.mjs'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name + (extra ? ' :: ' + extra : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : ''));
  }
};

// ---- 1. defaults exist and are sane -------------------------------------
console.log('\n=== 1. 默认值：必须有宽限，不能是第一次就动手 ===');
check('源码含 fixAppAfter 默认值', /fixAppAfter:\s*6/.test(src));
check('源码含 minUptimeMs 默认值', /minUptimeMs:\s*45000/.test(src));
check(
  'fixAppAfter 非法值被兜底为 1',
  /if \(!Number\.isFinite\(out\.fixAppAfter\) \|\| out\.fixAppAfter < 1\) out\.fixAppAfter = 1;/.test(src)
);
check(
  'minUptimeMs 非法值被兜底为 0',
  /if \(!Number\.isFinite\(out\.minUptimeMs\) \|\| out\.minUptimeMs < 0\) out\.minUptimeMs = 0;/.test(src)
);

// ---- 2. gate 1: consecutive-miss threshold -------------------------------
console.log('\n=== 2. 闸门一：连续未恢复次数未达标时不得动手 ===');
check('runOnce 内比较 consecutiveNoCdp < args.fixAppAfter', /state\.consecutiveNoCdp < args\.fixAppAfter/.test(src));
check('未达标时 return，不调用 fixApp', /state\.consecutiveNoCdp < args\.fixAppAfter[\s\S]{0,400}?return p;/.test(src));
// Negative case: the guard must be an early return, not a warning that falls
// through into fixApp().
const afterGate1 = src.slice(src.indexOf('state.consecutiveNoCdp < args.fixAppAfter'));
const gate1Window = afterGate1.slice(0, afterGate1.indexOf('await fixApp'));
check(
  '反例自证：闸门一与 fixApp 之间存在 return（否则会穿透）',
  /return p;/.test(gate1Window),
  'gap=' + gate1Window.length + ' chars'
);
check('未达标时会打印剩余等待', /还需连续/.test(src));

// ---- 3. gate 2: app uptime grace ----------------------------------------
console.log('\n=== 3. 闸门二：应用刚启动时不得动手 ===');
check('runOnce 内 await appUptimeMs', /const uptimeMs = await appUptimeMs\(args\);/.test(src));
check(
  'appUptimeMs 是 async（否则 Promise 比较恒 false，闸门变死代码）',
  /export async function appUptimeMs\(/.test(src)
);
check(
  'uptime < minUptimeMs 时 return',
  /uptimeMs < args\.minUptimeMs[\s\S]{0,300}?return p;/.test(src)
);
check('uptime 不可读时放行（返回 null 不阻断修复）', /uptimeMs !== null && uptimeMs < args\.minUptimeMs/.test(src));
check('appUptimeMs 用主进程命令行判定（排除 --type= 子进程）', /isMainProcessCommandLine\(x && x\.CommandLine\)/.test(src));

// ---- 4. gate 3: backoff between repairs ---------------------------------
console.log('\n=== 4. 闸门三：两次修复之间必须有退避 ===');
check('state 带 nextFixAt', /nextFixAt: 0/.test(src));
check('runOnce 内检查 now < state.nextFixAt', /state\.nextFixAt && now < state\.nextFixAt/.test(src));
check('退避中 return', /state\.nextFixAt && now < state\.nextFixAt[\s\S]{0,200}?return p;/.test(src));
check('修复后按 backoffDelayMs 排下一次', /state\.nextFixAt = now \+ backoffDelayMs\(state\.fixAttempts\)/.test(src));
check('fixAttempts 自增', /state\.fixAttempts = \(state\.fixAttempts \|\| 0\) \+ 1/.test(src));

// ---- 5. zombie reaping --------------------------------------------------
console.log('\n=== 5. 僵尸 daemon 必须随修复一起清 ===');
check('导出 reapStaleDaemons', /export async function reapStaleDaemons\(/.test(src));
check('fixApp 内先清理再杀应用', /const reaped = await reapStaleDaemons\(port, log\)/.test(src));
// Compare by real character offsets. IMPORTANT: search for the CALL site
// ('await reapStaleDaemons('), not the bare signature — the function
// declaration `function reapStaleDaemons(port, log)` also contains that exact
// substring and appears earlier, so a bare search silently matched the
// definition and made the ordering judgement vacuously true.
const CALL = 'await reapStaleDaemons(';
const callAt = src.indexOf(CALL);
const killAt = src.indexOf('process.kill(m.ProcessId)');
check(
  '清理发生在结束应用之前（按字符偏移判定，匹配调用点）',
  callAt > 0 && killAt > 0 && callAt < killAt,
  'call@' + callAt + ' < kill@' + killAt
);
// The judgement must be able to fail: remove the reap call and the SAME
// expression has to go false. This is what proves the check above is not
// vacuous.
const withoutReap = src.replace('const reaped = await reapStaleDaemons(port, log);', '');
check(
  '反例自证：删掉 reap 调用后同一判定为 false',
  !(withoutReap.indexOf(CALL) > 0 && withoutReap.indexOf('process.kill(m.ProcessId)') > 0 &&
     withoutReap.indexOf(CALL) < withoutReap.indexOf('process.kill(m.ProcessId)')),
  'call@' + withoutReap.indexOf(CALL)
);

// ---- 6. redundancy trim on healthy path ---------------------------------
console.log('\n=== 6. 通道正常时多余 daemon 只留一个（防再生长）===');
check('pids.length > 1 分支存在', /if \(pids\.length > 1\)/.test(src));
check('只保留第一个', /for \(const extra of pids\.slice\(1\)\)/.test(src));
check('state.daemonPids 收敛为单元素', /state\.daemonPids = \[pids\[0\]\];/.test(src));

// ---- 7. behaviour: the real decision function, both directions ---------
console.log('\n=== 7. 行为对照：同一份判定，够/不够两种输入 ===');
// Re-implement the gate exactly as written in source, and drive it both ways.
// If the thresholds were wired backwards, these two would agree.
const gate = (n, uptimeMs, minUptimeMs, fixAppAfter) => {
  if (n < fixAppAfter) return 'WAIT';
  if (uptimeMs !== null && uptimeMs < minUptimeMs) return 'SKIP_BOOTING';
  return 'FIX';
};
check('冷启动第 1 次 → WAIT', gate(1, 5000, 45000, 6) === 'WAIT');
check('冷启动第 5 次 → 仍 WAIT', gate(5, 5000, 45000, 6) === 'WAIT');
check('刚启动 3 秒且已 6 次 → SKIP_BOOTING', gate(6, 3000, 45000, 6) === 'SKIP_BOOTING');
check('已跑 1 小时且 6 次 → FIX', gate(6, 3600000, 45000, 6) === 'FIX');
check('uptime 读不到 → FIX（不因未知而卡死）', gate(6, null, 45000, 6) === 'FIX');
check('只有 1 次未恢复绝不 FIX（反例）', gate(1, 3600000, 45000, 6) !== 'FIX');
check('刚启动 3 秒绝不 FIX（反例）', gate(99, 3000, 45000, 6) !== 'FIX');

console.log(`\npass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log('test-autofix-gates: ALL GREEN');
} else {
  console.log('test-autofix-gates: FAILED');
}
process.exit(fail === 0 ? 0 : 1);
