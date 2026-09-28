// mmx-status :: cleanup.mjs
// Removes every node and style this tool injected, without needing the daemon
// to be running. Safe to call when nothing is installed.
//
//   node cleanup.mjs --port 9351

import { connectRenderer, isCdpAvailable } from './lib/cdp.mjs';
import { buildDisposeExpression } from './lib/page-script.mjs';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 9351;
})();

if (!(await isCdpAvailable(port))) {
  console.log(`CDP 端口 ${port} 未就绪，跳过页面还原。`);
  process.exit(0);
}

try {
  const { session } = await connectRenderer(port);
  const r = await session.evaluate(buildDisposeExpression());
  console.log('页面还原结果:', JSON.stringify(r));
  session.close();
  process.exit(r && r.ok ? 0 : 1);
} catch (e) {
  console.log('页面还原失败:', e.message);
  process.exit(0);
}
