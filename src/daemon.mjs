// mmx-status :: daemon.mjs
// Watches MiniMax Code over CDP and paints a status dot on every sidebar
// session row. Read-only against the app: no app.asar change, no IPC, and the
// injected nodes are fully removable with a single call.
//
//   node daemon.mjs [--port 9351] [--db <path>] [--interval 2500] [--once]
//
// Ctrl+C removes every injected node before exiting.

import { CdpSession, isCdpAvailable, version, listTargets } from './lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from './lib/status-db.mjs';
import {
  buildBootstrapExpression,
  buildRefreshExpression,
  buildDisposeExpression,
  buildProbeExpression,
} from './lib/page-script.mjs';

function parseArgs(argv) {
  const out = {
    port: 9351,
    db: DEFAULT_DB,
    interval: 2500,
    once: false,
    offsetX: 4,
    showDone: false,
    showAborted: false,
    collapse: true,
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
    else if (a === '--active-bg') out.activeBg = argv[++i];
    else if (a === '--active-bg-hover') out.activeBgHover = argv[++i];
    else if (a === '--active-bar') out.activeBar = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = (...m) => console.log(`[mmx-status ${new Date().toISOString().slice(11, 19)}]`, ...m);

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
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
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

  const boot = await session.evaluateWithRetry(
    buildBootstrapExpression({
      status: db.snapshot(),
      offsetX: args.offsetX,
      showDone: args.showDone,
      collapseOnStart: args.collapse,
      ...(args.activeBg ? { activeBg: args.activeBg } : {}),
      ...(args.activeBgHover ? { activeBgHover: args.activeBgHover } : {}),
      ...(args.activeBar ? { activeBar: args.activeBar } : {}),
    })
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
  if (boot && boot.collapse) log('折叠结果:', JSON.stringify(boot.collapse));

  if (args.once) {
    const counts = db.counts();
    log(`一次性模式结束。running=${counts.running} paused=${counts.paused} error=${counts.error} done=${counts.done}`);
    await session.evaluate(buildDisposeExpression());
    session.close();
    db.close();
    return;
  }

  log(`守护中，每 ${args.interval}ms 刷新一次。Ctrl+C 还原。`);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    try {
      db.refresh();
      const r = session.evaluateWithRetry(buildRefreshExpression(db.snapshot()));
      if (ticks % 10 === 0) {
        r.then((res) => log(`tick ${ticks}:`, JSON.stringify(res)))
          .catch((e) => log('刷新失败:', e.message));
      }
    } catch (e) {
      log('tick 异常:', e.message);
    }
  }, args.interval);

  const shutdown = async (sig) => {
    log(`收到 ${sig}，正在移除注入的节点...`);
    clearInterval(timer);
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
}

main().catch((e) => {
  console.error('[mmx-status] 致命错误:', e.message);
  process.exit(1);
});
