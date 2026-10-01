// mmx-status :: cleanup.mjs
// Removes every node and style this tool injected, without needing the daemon
// to be running. Safe to call when nothing is installed.
//
//   node cleanup.mjs --port 9331

import { connectRenderer, isCdpAvailable } from './lib/cdp.mjs';
import { buildDisposeExpression } from './lib/page-script.mjs';

// 默认端口与生产端口一致（9331）。旧默认 9351 与 launch-mmx-status.ps1 的兜底
// 不一致：裸跑会去连一个根本没在监听的端口，恒定「跳过还原」并返回 0，
// 看上去成功，实际什么都没还原。
const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 9331;
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
  // 失败必须返回非 0。旧代码这里 exit(0)，导致 launch-mmx-status.ps1 打出
  // 「已用 cleanup.mjs 还原（exit=0）」这种误导性成功日志 —— 失败也报成功。
  console.error('页面还原失败:', e.message);
  process.exit(1);
}
