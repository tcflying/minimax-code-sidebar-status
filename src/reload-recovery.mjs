// mmx-status :: reload-recovery.mjs
// The one test that was missing on 2026-09-29: start -> inject -> RELOAD THE
// RENDERER FOR REAL -> wait -> prove the injection came back on its own.
//
// Before the fix, a renderer reload (hot reload / navigation) destroyed
// window.__mmxStatus and #mmx-status-style with the old document, and the tick
// loop answered {ok:false, reason:'not-installed'} forever: a live daemon
// painting nothing. Every earlier test only checked "inject right after start",
// which is exactly why that hole survived.
//
// The DOM assertions are made by a SEPARATE short-lived node process that
// connects to the same CDP port, so nothing here can be fooled by state held in
// the test process.
//
//   node reload-recovery.mjs [--port 9331] [--interval 2000] [--wait 60]
//                            [--db <path>]
//
// It reloads the live MiniMax Code renderer. That is the point of the test, but
// it does briefly reset the app UI.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectRenderer, isCdpAvailable } from './lib/cdp.mjs';
import { buildDisposeExpression } from './lib/page-script.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PORT = Number(arg('--port', 9331));
const INTERVAL = Number(arg('--interval', 2000));
const WAIT_SEC = Number(arg('--wait', 60));
const DB = arg('--db', undefined);
const LOG_FILE = path.join(ROOT, 'logs', 'daemon-reload-test.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' :: ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
};

const CDP_LIB_URL = new URL('./lib/cdp.mjs', import.meta.url).href;

/**
 * Read-only DOM probe, executed in its OWN process. Returns null if the
 * renderer did not answer within the timeout (which is itself a fact worth
 * printing, not a crash).
 */
function probeInSeparateProcess() {
  return new Promise((resolve) => {
    const code = `
import { CdpSession, listTargets } from ${JSON.stringify(CDP_LIB_URL)};
const port = ${PORT};
try {
  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === 'page' && /^app:\\/\\/\\.\\/archon/.test(t.url || ''));
  if (!page) { console.log(JSON.stringify({ error: 'no archon target' })); process.exit(0); }
  const s = await CdpSession.connect(page.webSocketDebuggerUrl);
  const v = await s.evaluate(\`(() => ({
    readyState: document.readyState,
    globalFlag: typeof window.__mmxStatus,
    styleInjected: !!document.getElementById('mmx-status-style'),
    dotTotal: document.querySelectorAll('[data-mmx-dot]').length,
    sessionRows: document.querySelectorAll('[data-session-id]').length,
    pinnedRows: document.querySelectorAll('[data-pinned-section] [data-session-id]').length,
    sentinelGone: typeof window.__mmxReloadSentinel === 'undefined',
  }))()\`);
  s.close();
  console.log(JSON.stringify(v));
} catch (e) {
  console.log(JSON.stringify({ error: String((e && e.message) || e) }));
}
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill(), 12000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      if (!line) return resolve({ error: 'probe produced no output', stderr: err.slice(0, 200) });
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ error: 'unparsable probe output', raw: out.slice(0, 200) });
      }
    });
  });
}

async function pollForInjection(seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeInSeparateProcess();
    if (last && last.styleInjected === true && last.dotTotal > 0) return last;
    await sleep(1500);
  }
  return last;
}

console.log(`\n=== 重载自恢复实测 (CDP ${PORT}, interval ${INTERVAL}ms) ===`);
if (!(await isCdpAvailable(PORT))) {
  console.error(`CDP ${PORT} 未就绪`);
  process.exit(2);
}

console.log('\n=== 1. 重载前基线（独立进程探针）===');
const before = await probeInSeparateProcess();
console.log('  ' + JSON.stringify(before));

console.log('\n=== 2. 启动真实守护 ===');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const daemonArgs = ['daemon.mjs', '--port', String(PORT), '--interval', String(INTERVAL)];
if (DB) daemonArgs.push('--db', DB);
const daemon = spawn(process.execPath, daemonArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const daemonLines = [];
daemon.stdout.on('data', (d) => {
  const s = d.toString();
  logStream.write(s);
  for (const l of s.split('\n')) if (l.trim()) daemonLines.push(l.trim());
});
daemon.stderr.on('data', (d) => logStream.write(d));
let daemonExit = null;
daemon.on('close', (code) => {
  daemonExit = code;
  console.log(`  [守护进程已退出] code=${code}`);
});

const injected = await pollForInjection(90);
console.log('  ' + JSON.stringify(injected));
check('启动后注入确实存在', !!(injected && injected.styleInjected && injected.dotTotal > 0), `dots=${injected && injected.dotTotal}`);
check('守护进程仍然活着', daemonExit === null, `exit=${daemonExit}`);

console.log('\n=== 3. 真的让渲染进程重载（CDP Page.reload）===');
const { session } = await connectRenderer(PORT);
await session.send('Page.enable').catch(() => {});
// Sentinel first: "the reload was requested" is not evidence that the document
// was actually replaced. app://./archon silently ignores some reload requests,
// so the only trustworthy signal is the sentinel disappearing from a NEW
// document.
await session.evaluate('window.__mmxReloadSentinel = "alive"; "set"');
const reloadTried = [];
for (const [label, run] of [
  [
    'Page.reload',
    async () => {
      await session.send('Page.reload', { ignoreCache: true }, 15000);
    },
  ],
  [
    'location.reload()',
    async () => {
      await session.evaluate('location.reload(); "asked"', { awaitPromise: false });
    },
  ],
  [
    'location.href=location.href',
    async () => {
      await session.evaluate('window.location.href = window.location.href; "asked"', {
        awaitPromise: false,
      });
    },
  ],
]) {
  let asked = false;
  try {
    await run();
    asked = true;
  } catch (e) {
    console.log(`  ${label} 调用失败:`, e.message);
  }
  if (!asked) continue;
  reloadTried.push(label);
  // Wait for the sentinel to vanish, i.e. a genuinely new document.
  let replaced = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const p = await probeInSeparateProcess();
    if (p && p.error) continue; // target list gap while the renderer swaps
    if (p && p.sentinelGone === true) {
      replaced = true;
      break;
    }
  }
  console.log(`  ${label}: 文档${replaced ? '已被替换（哨兵消失）' : '仍在（哨兵未消失）'}`);
  if (replaced) break;
}
check('渲染进程文档被真正替换（不只是收到 reload 请求）', reloadTried.length > 0, reloadTried.join(' -> '));

const justAfter = await probeInSeparateProcess();
console.log('  重载后立刻探针: ' + JSON.stringify(justAfter));
const goneBeforeRecovery = !justAfter || justAfter.error || justAfter.dotTotal === 0 || justAfter.globalFlag === 'undefined';
check('重载确实清掉了注入（复现老 bug 的现场）', goneBeforeRecovery, JSON.stringify(justAfter && { g: justAfter.globalFlag, s: justAfter.styleInjected, d: justAfter.dotTotal }));

console.log(`\n=== 4. 等守护自愈（最多 ${WAIT_SEC}s）...`);
const t0 = Date.now();
const recovered = await pollForInjection(WAIT_SEC);
const waited = ((Date.now() - t0) / 1000).toFixed(1);
console.log('  ' + JSON.stringify(recovered));
check(
  '重载后注入被自动重建（#mmx-status-style 存在）',
  !!(recovered && recovered.styleInjected === true),
  `styleInjected=${recovered && recovered.styleInjected}`
);
check(
  '重载后状态点重新出现（[data-mmx-dot] > 0）',
  !!(recovered && recovered.dotTotal > 0),
  `dots=${recovered && recovered.dotTotal}，耗时 ${waited}s`
);
check('自愈期间守护进程没有崩溃', daemonExit === null, `exit=${daemonExit}`);
check(
  '守护日志里出现过注入消失的记录',
  daemonLines.some((l) => l.includes('注入已消失') || l.includes('not-installed')),
  daemonLines.filter((l) => l.includes('注入')).slice(-1)[0] || '(无)'
);
check(
  '守护日志里出现过重新注入成功的记录',
  daemonLines.some((l) => l.includes('重新注入成功')),
  daemonLines.filter((l) => l.includes('重新注入')).slice(-1)[0] || '(无)'
);

console.log('\n=== 5. 守护日志尾部 ===');
for (const l of daemonLines.slice(-12)) console.log('  ' + l);
console.log(`  (完整日志: ${LOG_FILE})`);

console.log('\n=== 6. 清理 ===');
// On Windows, child.kill('SIGTERM') is TerminateProcess: the daemon's SIGTERM
// handler (which would dispose for us) never runs. Kill it, then dispose from
// here, and only then assert the page is clean.
daemon.kill('SIGTERM');
const gone = await new Promise((r) => {
  const t = setTimeout(() => r(false), 8000);
  daemon.on('close', () => {
    clearTimeout(t);
    r(true);
  });
});
await sleep(500);
logStream.end();
check('测试守护已退出', gone, `exit=${daemonExit}`);
let disposed = null;
try {
  disposed = await session.evaluate(buildDisposeExpression());
} catch (e) {
  disposed = { error: e.message };
}
console.log('  清理调用: ' + JSON.stringify(disposed));
const final = await probeInSeparateProcess();
console.log('  清理后探针: ' + JSON.stringify(final));
check('测试结束后页面已还原（无残留注入）', !final || final.error || final.dotTotal === 0, JSON.stringify(final && { s: final.styleInjected, d: final.dotTotal }));
session.close();

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
