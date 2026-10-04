// r3 结构门：模板 / String.raw / 8 个导出 / 三个 builder / diff check。
// 任何一条不过就 exit 1，可以像套件一样进 CI。
//
// r4：路径全部走模块自身位置（import.meta.url），不再依赖 process.cwd()。
// r3 写的是 fs.readFileSync('./lib/page-script.mjs')，那只在 CWD 恰好是 src/
// 时成立 —— 于是从仓库根跑 `node mmx-status-github/src/structural-gates.mjs`
// 直接 ENOENT 崩掉。结构门最容易被这样"根本没跑"的方式静默跳过，所以现在
// `node src/structural-gates.mjs` 与 `node structural-gates.mjs` 都成立，
// 并且第一行把实际读到的路径和 CWD 一起打出来，让人一眼看出跑的是哪一份。
//
// 注意：所有"禁止出现 X"的门都先剥注释——锁模块自己的注释里写着
// "绝不 insertBefore 宿主置顶 DOM"，直接 grep 会命中那句禁令本身，
// 这正是那种永远不会红的门。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './lib/page-script.mjs';
import {
  buildBootstrapExpression, buildRefreshExpression,
  buildDisposeExpression, buildProbeExpression,
} from './lib/page-script.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'lib', 'page-script.mjs');
const src = fs.readFileSync(PAGE, 'utf8');
console.log('structural-gates 读的是 ' + PAGE + '   (CWD=' + process.cwd() + ')');
let bad = 0;
const ck = (n, ok, x) => { if (!ok) bad++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (x ? ' :: ' + x : '')); };
const a = src.indexOf('String.raw`');
const b = src.indexOf('`', a + 12);
const inner = src.slice(a + 12, b);
const lock = src.slice(src.indexOf('  // 红色悬停锁顶 · 单会话持续锁顶'), src.indexOf('  var timer = window.setInterval'));
const lockCode = lock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n=== 模板 / String.raw ===');
ck('模板用 String.raw 且能定位', a >= 0 && b > a);
ck('PAGE_FN 内部 0 个反引号', (inner.match(/`/g) || []).length === 0, 'n=' + (inner.match(/`/g) || []).length);
ck('PAGE_FN 内部 0 个 ${}', (inner.match(/\$\{/g) || []).length === 0);
ck('整个文件 10 个反引号', (src.match(/`/g) || []).length === 10, 'n=' + (src.match(/`/g) || []).length);
ck('PAGE_FN 内没有 console / debugger 残留',
  !/debugger/.test(inner) && !/console\.(log|warn|error)\(/.test(inner));

console.log('\n=== 导出与 builder ===');
const exp = Object.keys(M).filter((k) => k !== 'default').sort();
ck('8 个具名导出', exp.length === 8, exp.join(','));
ck('导出名正确',
  exp.join(',') === 'GLOBAL,MARK,STYLE_ID,SUMMARY_ID,buildBootstrapExpression,buildDisposeExpression,buildProbeExpression,buildRefreshExpression');
for (const [name, fn] of [
  ['buildBootstrapExpression', buildBootstrapExpression],
  ['buildRefreshExpression', buildRefreshExpression],
  ['buildDisposeExpression', buildDisposeExpression],
  ['buildProbeExpression', buildProbeExpression],
]) {
  let ok = false, len = 0;
  try { const s2 = fn({}); len = s2.length; new Function('return ' + s2 + ';'); ok = true; } catch (e) { ok = false; }
  ck(name + ' 产出可解析的表达式', ok, 'len=' + len);
}

console.log('\n=== diff check：宿主写点与轮询 ===');
ck('锁模块只有一处真正的宿主写点 fn(id, true, 0)',
  lockCode.split('fn(id, true, 0)').length - 1 === 1,
  'n=' + (lockCode.split('fn(id, true, 0)').length - 1));
ck('锁模块代码里没有 insertBefore（注释已剥离）', !/insertBefore/.test(lockCode));
ck('锁模块不新增任何 interval / rAF 调度', (lockCode.match(/setInterval|requestAnimationFrame/g) || []).length === 0,
  'n=' + (lockCode.match(/setInterval|requestAnimationFrame/g) || []).length);
ck('共享闸与运行时是 window 上的具名槽，不是闭包 var',
  /var TOPLOCK_GATE_KEY = '__mmxStatusHostGateV1';/.test(src)
  && /var TOPLOCK_RUNTIME_KEY = '__mmxStatusTopLockRuntimeV1';/.test(src));

console.log(bad === 0 ? '\nstructural-gates: ALL GREEN' : '\nstructural-gates: ' + bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
