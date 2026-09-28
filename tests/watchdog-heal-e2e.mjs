// End-to-end test of the real failure the user hit: the daemon process dies,
// and nobody brings the overlay back.
//
// This is the scenario that produced "not-installed" forever on 2026-09-28:
// daemon.mjs died at tick 4590 from an unhandled rejection.
//
//   node watchdog-heal-e2e.mjs [port]
//
// Two sub-scenarios, because they leave the page in different states:
//   A. kill daemon only        -> overlay nodes are LEFT BEHIND (a hard kill
//                                 never runs the SIGINT dispose handler)
//   B. dispose + kill daemon   -> page is clean, overlay fully gone
// In both cases the watchdog must notice and bring a working daemon back.

import { listTargets, CdpSession } from '../src/lib/cdp.mjs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const port = Number(process.argv[2] || 9331);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mmx-status');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ps = (script) =>
  execSync(
    `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

const daemonPids = () =>
  ps(
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'daemon\\.mjs.*--port\\s+' + ${port} + '($|\\s)' } | ForEach-Object { $_.ProcessId }) -join ','`
  )
    .split(',')
    .filter(Boolean)
    .map(Number);

const pickPage = async () => {
  const t = await listTargets(port);
  return t.find((x) => x.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(x.url || ''));
};

// Read the page from a FRESH connection every time.
const readState = async () => {
  const page = await pickPage();
  if (!page) return { error: 'archon target gone' };
  const s = await CdpSession.connect(page.webSocketDebuggerUrl);
  await s.send('Runtime.enable').catch(() => {});
  const r = await s.evaluate(`(() => {
    const dots = document.querySelectorAll('[data-mmx-dot]').length;
    const strict = document.querySelector(
      '[data-session-id] button.bg-bg_interaction_tertiary_hover' +
      ':not([class*="hover:bg-bg_interaction_tertiary_hover"])'
    );
    return {
      styleInjected: !!document.getElementById('mmx-status-style'),
      globalFlag: typeof window.__mmxStatus,
      dotTotal: dots,
      selectedBg: strict ? getComputedStyle(strict).backgroundColor : null,
    };
  })()`);
  s.close();
  return r;
};

const disposeAll = async () => {
  const page = await pickPage();
  if (!page) return;
  const s = await CdpSession.connect(page.webSocketDebuggerUrl);
  await s.send('Runtime.enable').catch(() => {});
  await s
    .evaluate(`(() => {
      document.querySelectorAll('[data-mmx-dot]').forEach((n) => n.remove());
      const st = document.getElementById('mmx-status-style');
      if (st) st.remove();
      try { delete window.__mmxStatus; } catch (e) {}
      return true;
    })()`)
    .catch((e) => ({ ok: false, e: e.message }));
  s.close();
};

const runScenario = async (label, doDispose) => {
  console.log(`\n########## 场景 ${label} ##########`);

  const before = await readState();
  console.log('  注入状态(前):', JSON.stringify(before));
  if (!before.styleInjected) {
    console.log('  跳过：前置条件不满足（当前就没注入）。先跑 rebootstrap。');
    return 'SKIP';
  }

  const old = daemonPids();
  console.log('  当前 daemon pid:', JSON.stringify(old));
  if (!old.length) {
    console.log('  跳过：没有 daemon 进程。');
    return 'SKIP';
  }

  // Kill FIRST, then dispose. The other order leaves a 2s window in which the
  // still-running daemon refreshes and repaints the dots, so the "clean page"
  // precondition is silently false (observed: styleInjected=false while
  // dotTotal was still 74).
  for (const p of old) ps(`Stop-Process -Id ${p} -Force -ErrorAction SilentlyContinue`);
  await sleep(2000);

  if (doDispose) {
    await disposeAll();
    console.log('  已在守护停止后手动 dispose（模拟干净页面）');
  }

  const afterKill = await readState();
  const gone = daemonPids();
  console.log('  kill 后 daemon pid:', JSON.stringify(gone));
  console.log('  kill 后注入状态:', JSON.stringify(afterKill));

  // Hand over to the watchdog and let it do the healing.
  // The watchdog writes each line TWICE by design: once to stdout (for an
  // interactive console) and once to --log (for the file). Redirecting stdout
  // into the SAME file made every line appear twice - that was this harness's
  // bug, not the watchdog's. Keep them in separate files.
  const wdLog = path.join(ROOT, 'logs', `heal-test-${label}.log`);
  const wdStdout = path.join(ROOT, 'logs', `heal-test-${label}.stdout.log`);
  const out = fs.openSync(wdStdout, 'a');
  const wd = spawn(
    process.execPath,
    [path.join(ROOT, 'watchdog.mjs'), '--interval', '3000', '--log', wdLog],
    { detached: true, stdio: ['ignore', out, out] }
  );
  wd.unref();
  console.log('  watchdog 已启动 pid=' + wd.pid + ' 日志=' + wdLog);

  const deadline = Date.now() + 60000;
  let healed = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const pids = daemonPids();
    if (pids.length && !pids.some((p) => old.includes(p))) {
      const st = await readState();
      if (st.styleInjected && st.dotTotal > 0) {
        healed = st;
        break;
      }
    }
  }

  ps(`Stop-Process -Id ${wd.pid} -Force -ErrorAction SilentlyContinue`);

  const tail = fs
    .readFileSync(wdLog, 'utf8')
    .split('\n')
    .slice(-12)
    .join('\n');
  console.log('  watchdog 日志尾部:\n' + tail.split('\n').map((l) => '    ' + l).join('\n'));

  if (healed) {
    console.log(
      `  PASS 自愈成功: dotTotal=${healed.dotTotal} selectedBg=${healed.selectedBg} daemonPids=${JSON.stringify(daemonPids())}`
    );
    return 'PASS';
  }
  console.log('  FAIL 60s 内未自愈');
  return 'FAIL';
};

const a = await runScenario('A 仅杀守护', false);
const b = await runScenario('B 先还原再杀守护', true);
console.log('\n==== 汇总 ====');
console.log('A(仅杀守护):', a);
console.log('B(还原后杀守护):', b);
process.exit(a === 'FAIL' || b === 'FAIL' ? 1 : 0);
