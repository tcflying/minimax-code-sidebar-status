// mmx-status :: daemon.mjs
// Watches MiniMax Code over CDP and paints a status dot on every sidebar
// session row. Read-only against the app: no app.asar change, no IPC, and the
// injected nodes are fully removable with a single call.
//
//   node daemon.mjs [--port 9331] [--db <path>] [--interval 2500] [--once] [--no-reorder]
//
// Ctrl+C removes every injected node before exiting.

import { CdpSession, isCdpAvailable, version, listTargets } from './lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from './lib/status-db.mjs';
import { pathToFileURL } from 'node:url';
import {
  buildBootstrapExpression,
  buildRefreshExpression,
  buildDisposeExpression,
  buildProbeExpression,
} from './lib/page-script.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tunables. These are deliberately NOT new command line flags: the CLI surface
// is frozen (the user depends on every existing name and its semantics), so the
// retry policy stays internal.
// ---------------------------------------------------------------------------
const FAILURE_THRESHOLD = 3; // consecutive refresh failures before reconnecting
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REBOOT_BASE_MS = 1500; // renderer reload -> not-installed -> re-bootstrap
const REBOOT_MAX_MS = 30000;

const ARCHON_URL_RE = /^app:\/\/\.\/archon(?:[/#?]|$)/i;

// Exported (not just module-private) so test-reorder-defaults.mjs can assert the
// flag semantics without starting a daemon or touching a live CDP endpoint.
export function parseArgs(argv) {
  const out = {
    // 默认端口与生产端口一致（9331）。旧默认 9351 与
    // launch-mmx-status.ps1:281 的兜底 9331 不一致：裸跑 daemon 会去连
    // 一个根本没在监听的端口，症状表现为「改了代码没反应」。
    port: 9331,
    db: DEFAULT_DB,
    interval: 2500,
    once: false,
    offsetX: 4,
    showDone: false,
    showAborted: false,
    collapse: true,
    // Running rows hoist to the top of their list BY DEFAULT. This is the
    // feature the user asked for; hiding it behind an opt-in flag meant the
    // launcher (which passes no reorder flag at all) always ran with it off,
    // so "running rows are not hoisted" was reported as a bug on 2026-10-02.
    // --no-reorder stays as the escape hatch for the reflow-loop incident
    // documented in lib/page-script.mjs.
    reorder: true,
    activeBg: null,
    activeBgHover: null,
    activeBar: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--offsetX') out.offsetX = Number(argv[++i]);
    else if (a === '--once') out.once = true;
    else if (a === '--show-done') out.showDone = true;
    else if (a === '--show-aborted') out.showAborted = true;
    else if (a === '--no-collapse') out.collapse = false;
    else if (a === '--no-reorder') out.reorder = false;
    else if (a === '--reorder') out.reorder = true;
    else if (a === '--active-bg') out.activeBg = argv[++i];
    else if (a === '--active-bg-hover') out.activeBgHover = argv[++i];
    else if (a === '--active-bar') out.activeBar = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = (...m) => console.log(`[mmx-status ${new Date().toISOString().slice(11, 19)}]`, ...m);

/**
 * Re-open a CDP session on the app://./archon renderer.
 *
 * A hot reload / app update swaps webSocketDebuggerUrl, so the old session is
 * permanently dead and every request on it fails. The target list is the only
 * authority on where the renderer lives now.
 */
export async function reconnectSession(port, { log: logFn = () => {}, list = listTargets } = {}) {
  const targets = await list(port);
  const page = targets.find((t) => t.type === 'page' && ARCHON_URL_RE.test(t.url || ''));
  if (!page) {
    throw new Error(
      '重连失败：/json/list 里没有 app://./archon 页面 target，实际=' +
        (targets.length ? targets.map((t) => `[${t.type}] ${t.url}`).join(' ') : '(空)')
    );
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  await session.send('Runtime.enable').catch(() => {});
  return { session, target: page };
}

/**
 * Last line of defence against a process-killing async failure.
 *
 * Decision: log, count, and KEEP RUNNING - never exit here.
 *
 * Reason: this daemon's only job is painting dots on someone else's sidebar.
 * Every internal promise now carries an unconditional handler, so a hit on
 * these hooks is by definition an unknown/unexpected failure, not a known
 * recoverable state. Exiting would remove the dots from a perfectly healthy app
 * and, because the renderer keeps running after a reload, would leave the user
 * with a silent zombie daemon (the exact failure reported on 2026-09-29).
 * Staying alive degrades to "dots temporarily stop updating", which is
 * recoverable; exiting does not. The window in which the user can see the
 * failure is worth more than a clean exit.
 */
export function installFatalGuards({ log: logFn = () => {}, onFatal = () => {} } = {}) {
  const counters = { unhandledRejection: 0, uncaughtException: 0 };
  const describe = (r) =>
    r instanceof Error ? `${r.message}` : typeof r === 'string' ? r : safeJson(r);
  process.on('unhandledRejection', (reason) => {
    counters.unhandledRejection++;
    logFn('未处理的 Promise 拒绝（已兜底，进程继续运行）:', describe(reason));
    try {
      onFatal('unhandledRejection', reason);
    } catch (e) {
      logFn('兜底处理自身失败:', describe(e));
    }
  });
  process.on('uncaughtException', (err) => {
    counters.uncaughtException++;
    logFn('未捕获异常（已兜底，进程继续运行）:', describe(err));
    try {
      onFatal('uncaughtException', err);
    } catch (e) {
      logFn('兜底处理自身失败:', describe(e));
    }
  });
  return counters;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * The tick loop, extracted so it can be exercised by selftest.mjs with a fake
 * session (a real one needs a live renderer).
 *
 * Two failure classes are handled separately and must not be confused:
 *
 *  1. TRANSPORT is dead (Runtime.evaluate timed out, WebSocket closed).
 *     -> reconnectSession(): re-list targets, rebuild CdpSession.
 *  2. TRANSPORT is fine but the injection is gone, i.e. the renderer document
 *     was replaced (hot reload / navigation) and window.__mmxStatus plus
 *     #mmx-status-style died with the old document. refresh() then answers
 *     {ok:false, reason:'not-installed'} forever.
 *     -> re-bootstrap with the startup options.
 *
 * Both are backed off, because bootstrap is far heavier than refresh: the page
 * side busy-waits up to 15s for document.body, so hammering it every tick
 * would freeze the host application.
 */
export function createRefreshLoop({
  getSession,
  setSession,
  db,
  bootstrapConfig,
  log: logFn = () => {},
  intervalMs = 2500,
  failureThreshold = FAILURE_THRESHOLD,
  reconnectBaseMs = RECONNECT_BASE_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  rebootBaseMs = REBOOT_BASE_MS,
  rebootMaxMs = REBOOT_MAX_MS,
  reconnect = () => Promise.reject(new Error('createRefreshLoop 未注入 reconnect')),
  logEvery = 10,
  // Tests drive tick() by hand; the daemon relies on the real interval.
  autoStart = true,
} = {}) {
  const state = {
    ticks: 0,
    consecutiveFailures: 0, // transport failures
    notInstalled: 0, // consecutive refreshes that reported not-installed
    reconnectAttempts: 0,
    reconnects: 0, // successful reconnects
    reboots: 0, // successful re-bootstraps
    reconnecting: false,
    rebooting: false,
    reconnectBackoffMs: reconnectBaseMs,
    rebootBackoffMs: rebootBaseMs,
    lastError: null,
    stopped: false,
  };
  let timer = null;

  /** Reinstall the payload after the renderer document was replaced. */
  async function runReboot() {
    try {
      while (!state.stopped && state.notInstalled > 0) {
        const waitMs = state.rebootBackoffMs;
        logFn(`注入已丢失（not-installed），${waitMs}ms 后重新注入 ...`);
        await sleep(waitMs);
        if (state.stopped) return;
        try {
          db.refresh();
          const session = getSession();
          const boot = await session.evaluateWithRetry(
            buildBootstrapExpression({ status: db.snapshot(), ...bootstrapConfig })
          );
          if (!boot || boot.ok === true) {
            state.reboots++;
            state.notInstalled = 0;
            state.rebootBackoffMs = rebootBaseMs;
            logFn('重新注入成功:', safeJson(boot && boot.initial));
            return;
          }
          // e.g. {ok:false, reason:'no-document-body'}: keep backing off.
          logFn('重新注入未成功:', safeJson(boot), '（继续退避重试）');
          state.rebootBackoffMs = Math.min(state.rebootBackoffMs * 2, rebootMaxMs);
        } catch (e) {
          logFn('重新注入抛错:', e && e.message, '（继续退避重试）');
          state.rebootBackoffMs = Math.min(state.rebootBackoffMs * 2, rebootMaxMs);
        }
      }
    } finally {
      state.rebooting = false;
    }
  }

  function scheduleReboot() {
    if (state.rebooting || state.stopped) return;
    state.rebooting = true;
    // This chain must not be bare either: the catch only logs.
    void runReboot().catch((e) => {
      state.rebooting = false;
      logFn('重新注入流程异常:', e && e.message);
    });
  }

  /** Rebuild the CDP session when the transport itself is dead. */
  async function runReconnect() {
    try {
      while (!state.stopped && state.consecutiveFailures >= failureThreshold) {
        const waitMs = state.reconnectBackoffMs;
        logFn(
          `连续刷新失败 ${state.consecutiveFailures} 次，${waitMs}ms 后重连 ` +
            `127.0.0.1:${args.port} ...`
        );
        await sleep(waitMs);
        if (state.stopped) return;
        state.reconnectAttempts++;
        try {
          const old = getSession();
          const next = await reconnect();
          if (old && typeof old.close === 'function') {
            try {
              old.close();
            } catch {
              /* old socket already gone */
            }
          }
          setSession(next.session);
          state.reconnects++;
          state.reconnectBackoffMs = reconnectBaseMs;
          state.consecutiveFailures = 0;
          logFn('重连成功:', (next.target && next.target.url) || '(unknown target)');
          return;
        } catch (e) {
          logFn(
            '重连失败:',
            e && e.message,
            `（下一轮退避 ${Math.min(state.reconnectBackoffMs * 2, reconnectMaxMs)}ms）`
          );
          state.reconnectBackoffMs = Math.min(state.reconnectBackoffMs * 2, reconnectMaxMs);
        }
      }
    } finally {
      state.reconnecting = false;
    }
  }

  function scheduleReconnect() {
    if (state.reconnecting || state.stopped) return;
    state.reconnecting = true;
    void runReconnect().catch((e) => {
      state.reconnecting = false;
      logFn('重连流程异常:', e && e.message);
    });
  }

  function noteFailure(kind, e) {
    state.lastError = (e && e.message) || String(e);
    state.consecutiveFailures++;
    // Rate-limit the log: one line per failure would drown the log file during
    // a long outage.
    if (state.consecutiveFailures === 1 || state.consecutiveFailures % 10 === 0) {
      logFn(`${kind}: ${state.lastError}（连续 ${state.consecutiveFailures} 次）`);
    }
    if (state.consecutiveFailures >= failureThreshold) scheduleReconnect();
  }

  function onTickOk(res, tickNo) {
    // A not-installed answer PROVES the transport is alive (the request round
    // tripped and the page script replied), so the transport failure counter is
    // reset - this is class 2, not class 1.
    state.consecutiveFailures = 0;
    state.reconnectBackoffMs = reconnectBaseMs;
    if (res && res.ok === false && res.reason === 'not-installed') {
      state.notInstalled++;
      state.lastError = 'not-installed';
      logFn(
        `注入已消失（tick ${tickNo}，连续第 ${state.notInstalled} 次）：` +
          '渲染进程文档被替换，需要重新注入'
      );
      scheduleReboot();
      return;
    }
    // Report the tick that PRODUCED this answer, not the current counter: when
    // the renderer stalls, many requests settle in the same second and using the
    // live counter printed "tick 20" dozens of times.
    if (tickNo % logEvery === 0) logFn(`tick ${tickNo}:`, safeJson(res));
  }

  function onTickErr(e) {
    noteFailure('刷新失败', e);
  }

  function tick() {
    if (state.stopped) return;
    const tickNo = ++state.ticks;
    let expression;
    try {
      db.refresh();
      expression = buildRefreshExpression(db.snapshot());
    } catch (e) {
      // Synchronous failure (sqlite locked, snapshot() threw): same channel.
      noteFailure('tick 异常', e);
      return;
    }
    let p;
    try {
      p = getSession().evaluateWithRetry(expression);
    } catch (e) {
      noteFailure('刷新调用同步抛出', e);
      return;
    }
    if (!p || typeof p.then !== 'function') {
      noteFailure('刷新返回值形状异常', new Error('evaluateWithRetry 没有返回 Promise'));
      return;
    }
    // Unconditional handler. try/catch cannot see an async rejection, and on
    // Node 24 an unhandled one throws and kills the process (the 2026-09-28
    // crash: `CDP 超时(30000ms): Runtime.evaluate` after 4590 ticks). There is
    // no branch here that can leave the promise bare.
    Promise.resolve(p)
      .then((res) => onTickOk(res, tickNo), onTickErr)
      .catch((e) => {
        logFn('刷新处理链异常:', e && e.message);
      });
  }

  function stop() {
    state.stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Deliberately NOT unref'd: the interval is what keeps the daemon alive, and
  // an unref'd timer would let the process exit silently when nothing else
  // happens to hold the loop open.
  if (autoStart) timer = setInterval(tick, intervalMs);
  return { state, tick, stop };
}

async function waitForCdp(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpAvailable(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForRenderer(port, timeoutMs = 90000) {
  // CDP answers /json/version as soon as the browser process is up, but the
  // app://./archon page target appears only once the renderer has actually
  // loaded. Failing at that moment is the single most common way this tool
  // breaks on a cold start, so wait for the target instead.
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = await listTargets(port);
      const page = lastTargets.find(
        (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
      );
      if (page) return page;
    } catch {
      /* browser not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(
    `${timeoutMs / 1000}s 内未出现 app://./archon 渲染进程。当前 target：\n` +
      (lastTargets.length
        ? lastTargets.map((t) => `  [${t.type}] ${t.url}`).join('\n')
        : '  （无）')
  );
  return null;
}

async function main() {
  log(`等待 CDP 127.0.0.1:${args.port} ...`);
  if (!(await waitForCdp(args.port))) {
    console.error(
      `CDP 端口 ${args.port} 无响应。请先用 start-mmx-status.ps1 带 CDP 参数启动 MiniMax Code。`
    );
    process.exit(2);
  }

  const v = await version(args.port).catch(() => ({}));
  log('CDP 已连接:', v.Browser || '(unknown)', '|', (v['User-Agent'] || '').slice(-60));

  const db = new StatusDb(args.db, { includeAborted: args.showAborted });
  log('数据库:', args.db);
  log('状态分布:', JSON.stringify(db.counts()));

  log('等待渲染进程 app://./archon 就绪...');
  const target = await waitForRenderer(args.port);
  if (!target) {
    db.close();
    process.exit(3);
  }
  let session = await CdpSession.connect(target.webSocketDebuggerUrl);
  await session.send('Runtime.enable').catch(() => {});
  log('渲染进程 target:', target.url, '|', target.title);

  // Probe the REAL DOM before painting anything.
  const probe = await session.evaluateWithRetry(buildProbeExpression());
  log(
    `真实 DOM 探针: url=${probe.url} 总会话行=${probe.totalRows} 置顶行=${probe.pinnedRows} 有置顶区=${probe.hasPinnedSection}`
  );
  if (probe.sample && probe.sample.length) {
    for (const s of probe.sample) {
      log(`   行样本 id=${s.id} tag=${s.tag} inPinned=${s.inPinned} text="${s.text}"`);
      log(`       class="${s.className}"`);
    }
  }

  // The exact startup options. Reused verbatim by the re-bootstrap path so a
  // reinjection after a renderer reload is indistinguishable from a cold start
  // (same dot offset, same done/aborted switches, same collapse behaviour, same
  // selected-row colours).
  const bootstrapConfig = {
    offsetX: args.offsetX,
    showDone: args.showDone,
    collapseOnStart: args.collapse,
    reorder: args.reorder,
    ...(args.activeBg ? { activeBg: args.activeBg } : {}),
    ...(args.activeBgHover ? { activeBgHover: args.activeBgHover } : {}),
    ...(args.activeBar ? { activeBar: args.activeBar } : {}),
  };
  const boot = await session.evaluateWithRetry(
    buildBootstrapExpression({ status: db.snapshot(), ...bootstrapConfig })
  );
  log('注入结果:', JSON.stringify(boot));
  if (boot && boot.ok === false) {
    console.error('[mmx-status] 注入失败:', boot.reason);
    session.close();
    db.close();
    process.exit(4);
  }
  if (args.activeBg) log('选中行底色:', args.activeBg); else log('选中行底色: rgba(10,10,10,0.10) + 蓝色左条（默认）');
  log('done 点显示:', args.showDone ? '开' : '关（默认，只有绿/黄/红）');
  log('启动时折叠展开组:', args.collapse ? '开（主上要求：任何时候不自动展开）' : '关');
  log('running 行置顶:', args.reorder ? '开（默认开启；已知副作用见 page-script 注释，--no-reorder 可关）' : '关（--no-reorder 显式关闭）');
  if (boot && boot.collapse) log('折叠结果:', JSON.stringify(boot.collapse));

  if (args.once) {
    const counts = db.counts();
    log(`一次性模式结束。running=${counts.running} waiting=${counts.waiting} paused=${counts.paused} error=${counts.error} done=${counts.done}`);
    await session.evaluate(buildDisposeExpression());
    session.close();
    db.close();
    return;
  }

  log(`守护中，每 ${args.interval}ms 刷新一次。Ctrl+C 还原。`);
  const getSession = () => session;
  const setSession = (s) => {
    session = s;
  };
  const loop = createRefreshLoop({
    getSession,
    setSession,
    db,
    bootstrapConfig,
    log,
    intervalMs: args.interval,
    reconnect: () => reconnectSession(args.port, { log }),
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，正在移除注入的节点...`);
    loop.stop();
    try {
      const r = await session.evaluateWithRetry(buildDisposeExpression());
      log('已还原:', JSON.stringify(r));
    } catch (e) {
      log('还原失败（应用可能已关闭）:', e.message);
    }
    session.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return loop;
}

// Entry point. Guarded so selftest.mjs can import createRefreshLoop() and
// installFatalGuards() from this module without starting a daemon.
const invokedDirectly =
  !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  installFatalGuards({
    log,
    // Best effort only: never dispose here. Disposing needs the very session
    // that may be the thing that just failed, and pulling the dots out of a
    // healthy app is worse than stale dots. The tick loop's own reconnect path
    // already repairs a dead session.
    onFatal: () => {},
  });
  main().catch((e) => {
    console.error('[mmx-status] 致命错误:', e.message);
    process.exit(1);
  });
}
