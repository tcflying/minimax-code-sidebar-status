// One-shot re-bootstrap: re-inject the sidebar overlay right now, without
// touching daemon.mjs and without disposing afterwards. This is a stopgap for
// a renderer reload having wiped window.__mmxStatus; the daemon's
// re-bootstrap path is the permanent fix.
//   node rebootstrap.mjs [port]
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from '../src/lib/status-db.mjs';
import { buildBootstrapExpression } from '../src/lib/page-script.mjs';

const port = Number(process.argv[2] || 9331);
const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) {
  console.error('未找到 app://./archon 渲染进程');
  process.exit(1);
}

const db = new StatusDb(DEFAULT_DB, { includeAborted: false });
const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

const boot = await s.evaluateWithRetry(
  buildBootstrapExpression({
    status: db.snapshot(),
    offsetX: 4,
    showDone: false,
    collapseOnStart: true,
  })
);
console.log('bootstrap:', JSON.stringify(boot));

// Independent confirmation from the same session: the DOM must actually carry
// the markers. A boot result of ok:true alone is not evidence.
const check = await s.evaluate(`(() => {
  const dots = document.querySelectorAll('[data-mmx-dot]').length;
  const btn = document.querySelector('button.bg-bg_interaction_tertiary_hover');
  return {
    styleInjected: !!document.getElementById('mmx-status-style'),
    globalFlag: typeof window.__mmxStatus,
    dotTotal: dots,
    selectedBg: btn ? getComputedStyle(btn).backgroundColor : null,
  };
})()`);
console.log('verify:', JSON.stringify(check));

db.close();
s.close();
