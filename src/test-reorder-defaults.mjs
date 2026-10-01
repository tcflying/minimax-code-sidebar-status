// Regression test for the 2026-10-02 bug: "running rows are not hoisted to the
// top of the sidebar" after starting via the red-M shortcut.
//
// Two independent root causes, both asserted here:
//
//   A. The default was OFF and the launcher never passed a reorder flag at all,
//      so every daemon started from the shortcut ran with reorder:false.
//      parseArgs() defaulted to false and only --reorder/--no-reorder moved it.
//   B. A stale daemon kept running the OLD page-script snapshot: daemon.mjs reads
//      lib/page-script.mjs once at startup and stays resident, and the daemon is
//      a standalone node process that is NOT in the Electron process tree -- so
//      "quit the app and reopen it" never kills it. Fixed by having the launcher
//      kill the stale daemon on the same port before starting a new one.
//
// Nothing here touches a live CDP endpoint or a real process: the launcher is
// only ever read as text, and the kill-filter is asserted in PowerShell
// (test-process-filters.ps1) against fabricated process records.
//
//   node test-reorder-defaults.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './daemon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const daemon = read('daemon.mjs');
const launch = read('launch-mmx-status.ps1');
const start = read('start-mmx-status.ps1');
// 共享的陈旧-daemon 清理模块（launch / start / stop 三处 dot-source 它）
let shared = '';
try {
  shared = read('lib-stale-daemon.ps1');
} catch {
  shared = '';
}
const pageScript = read(path.join('lib', 'page-script.mjs'));

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

// ---- 1. parseArgs: reorder is ON unless explicitly turned off ---------------
console.log('\n=== 1. daemon 参数解析：默认必须是开 ===');
check('parseArgs 可被导入（已 export，测试不需要起 daemon）', typeof parseArgs === 'function');
check('无参数 -> reorder=true', parseArgs([]).reorder === true, 'got=' + parseArgs([]).reorder);
check(
  '只给无关参数 -> 仍是 true',
  parseArgs(['--port', '9331', '--interval', '2500']).reorder === true,
  'got=' + parseArgs(['--port', '9331']).reorder
);
check('--no-reorder -> false（逃生舱仍可用）', parseArgs(['--no-reorder']).reorder === false);
check('--reorder -> true（显式开启仍然被接受）', parseArgs(['--reorder']).reorder === true);
check(
  '--no-reorder 出现在任意位置都生效',
  parseArgs(['--port', '9331', '--no-reorder', '--interval', '2500']).reorder === false
);
check(
  'reorder 开关不影响其它参数',
  parseArgs(['--no-reorder', '--port', '9400']).port === 9400 &&
    parseArgs(['--no-reorder']).interval === 2500
);
check(
  '源码里默认值字面量是 reorder: true（防止有人只改测试）',
  /^\s*reorder: true,$/m.test(daemon)
);

// ---- 2. daemon 把这个值透传给页面 ------------------------------------------
console.log('\n=== 2. daemon 把 reorder 透传给页面脚本 ===');
check('bootstrapConfig 传 reorder: args.reorder', /reorder:\s*args\.reorder,/.test(daemon));
check(
  'page-script 的 ...cfg 展开在默认值之后，所以 daemon 的值一定覆盖页面默认值',
  // 只断言「展开顺序」，不写死布尔字面量：默认值 2026-10-02 从 false 翻成了 true，
  // 写死会让这个断言在无关的默认值变更时假失败。
  /reorder:\s*(?:true|false),[\s\S]*\.\.\.cfg,/.test(pageScript)
);
check(
  '启动日志文案已改成「默认开启」',
  /args\.reorder \? '开（默认开启/.test(daemon)
);
// 只看 reorder 那一行：'done 点显示' 那行本来就带「关（默认，只有绿/黄/红）」，
// 跟 reorder 无关，不能拿它当证据。
const reorderLogLine = daemon.split('\n').find((l) => l.includes('running 行置顶:')) || '';
check('存在 running 行置顶 的启动日志行', !!reorderLogLine, reorderLogLine.trim());
check(
  'reorder 日志行不再出现与新默认值矛盾的「关（默认」',
  !!reorderLogLine && !reorderLogLine.includes('关（默认')
);

// ---- 3. 红 M 启动器：默认不传 reorder 开关 ---------------------------------
console.log('\n=== 3. launch-mmx-status.ps1 的 $daemonArgs 构造 ===');
const baseAssign = launch.match(/^\$daemonArgs = .*$/m);
check('存在 $daemonArgs 基础赋值行', !!baseAssign, baseAssign ? baseAssign[0].trim() : '(没找到)');
check(
  '基础赋值行里没有 reorder 开关（默认交给 daemon 自己的 true）',
  !!baseAssign && !/reorder/i.test(baseAssign[0]),
  baseAssign ? baseAssign[0].trim() : ''
);
check(
  '基础赋值就是 daemon.mjs + --port + --interval',
  !!baseAssign && /daemon\.mjs/.test(baseAssign[0]) && /--port \$port/.test(baseAssign[0]) &&
    /--interval \$Interval/.test(baseAssign[0])
);
check('有 [switch]$NoReorder 参数', /\[switch\]\$NoReorder/.test(launch));
check(
  '只有 -NoReorder 才追加 --no-reorder',
  /if \(\$NoReorder\) \{ \$daemonArgs \+= ' --no-reorder' \}/.test(launch)
);
check(
  '不存在把 --reorder 追加进去的写法（红 M 不需要显式开启）',
  !/\+= ' --reorder'/.test(launch)
);
check(
  '$daemonArgs 全文件只赋值一次（dry-run 与真正启动共用同一个字符串）',
  (launch.match(/^\$daemonArgs = /gm) || []).length === 1,
  'count=' + (launch.match(/^\$daemonArgs = /gm) || []).length
);
check(
  'dry-run 打印的是 $daemonArgs 本身，不是另抄一份硬编码',
  /Write-Log "\[dry-run\] node \$daemonArgs"/.test(launch)
);
check(
  'Start-Process 用 -ArgumentList $daemonArgs',
  /Start-Process -FilePath \$nodeExe -ArgumentList \$daemonArgs/.test(launch)
);

// ---- 4. 杀掉陈旧 daemon 的前置动作（根因 B）------------------------------
// 2026-10-02 二次修：这套实现已抽到共享模块 src/lib-stale-daemon.ps1，
// 由 launch / start / stop 三处 dot-source，不再只写在 launch 里。
// 所以下面这些断言的对象是「共享模块 + 各调用点」，不是 launch 源码本身。
console.log('\n=== 4. 红 M 启动器：先杀同端口的旧 daemon ===');
check(
  '共享模块 lib-stale-daemon.ps1 存在',
  shared.length > 0,
  shared.length > 0 ? '' : 'src/lib-stale-daemon.ps1 读不到'
);
check('定义了 Test-IsStaleDaemonProcess 纯函数', /function Test-IsStaleDaemonProcess \{/.test(shared));
check('定义了 Stop-StaleDaemon', /function Stop-StaleDaemon \{/.test(shared));
check(
  '用 CIM 精确查 node.exe，不是 Get-Process -Name node',
  /Get-CimInstance Win32_Process -Filter "Name='node\.exe'"/.test(shared)
);
// 断言「不存在坏写法」时必须先剥掉整行注释：源码里那句
// 「不用 Get-Process -Name node」本身就是提醒用的注释，不是代码。
const launchCode = launch
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
const sharedCode = shared
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
check(
  '源码里不存在 Get-Process -Name node（那会误伤别的 node 进程）',
  !/Get-Process\s+-Name\s+node\b/.test(launchCode) && !/Get-Process\s+-Name\s+node\b/.test(sharedCode)
);
check('筛选要求命令行含 daemon.mjs', /daemon\\?\.mjs/.test(shared));
check('筛选要求 --port 就是本次端口', /'--port\[=\\s\]' \+ \$Port/.test(shared));
check('Start-Process 之前调用了 Stop-StaleDaemon', /Stop-StaleDaemon -Port \$port/.test(launch));
const stopIdx = launch.indexOf('Stop-StaleDaemon -Port $port');
const startIdx = launch.indexOf('-ArgumentList $daemonArgs');
check(
  'Stop-StaleDaemon 的调用点在 Start-Process 之前（顺序不能反）',
  stopIdx > -1 && startIdx > -1 && stopIdx < startIdx,
  'stop@' + stopIdx + ' start@' + startIdx
);
check(
  '强杀之后会等进程真正消失',
  /for \(\$i = 0; \$i -lt 50; \$i\+\+\)/.test(shared)
);
check(
  '旧 daemon 留下的注入用现成 cleanup.mjs 还原（Invoke-LegacyDispose）',
  /function Invoke-LegacyDispose \{/.test(shared) && /cleanup\.mjs`" --port \$Port/.test(shared)
);
check(
  'start-mmx-status.ps1 也复用同一份实现（不再各写一份）',
  /lib-stale-daemon\.ps1/.test(start) && /Stop-StaleDaemon -Port \$Port/.test(start)
);
check(
  '启动器源码里没有任何针对 MiniMax Code / Electron 的 taskkill 或按名批量杀',
  !/taskkill/i.test(launch)
);

// ---- 5. 旧启动器 start-mmx-status.ps1 与红 M 保持一致 ---------------------
console.log('\n=== 5. start-mmx-status.ps1 一致性 ===');
check('也有 [switch]$NoReorder', /\[switch\]\$NoReorder/.test(start));
check(
  '默认不追加 reorder 开关',
  /if \(\$NoReorder\) \{ \$daemonArgList \+= '--no-reorder' \}/.test(start)
);
check('不存在把 --reorder 追加进去的写法', !/daemonArgList \+= '--reorder'/.test(start));
check('dry-run 打印的是真实的参数数组', /Write-Host "\[dry-run\] node \$\(\$daemonArgList -join ' '\)"/.test(start));
check('实际执行用的是同一个数组', /& node @daemonArgList/.test(start));

console.log(`\npass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log('test-reorder-defaults: ALL GREEN');
} else {
  console.log('test-reorder-defaults: FAILED');
}
process.exit(fail === 0 ? 0 : 1);
