// 实测三种状态点的实际渲染尺寸。
// 目的：验证 page-script 里声明的 "error 8px / paused 6px / running 4x24" 是否真的落到 DOM 上。
// 判据：只量自己不够，必须同时证明 running 与其它桶确实不同、且没污染邻居行。
//
//   node verify-dot-sizes.mjs [port]
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';
import fs from 'node:fs';

const port = Number(process.argv[2] || 9331);
const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) { console.error('no archon target'); process.exit(1); }

const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

const expr = fs.readFileSync(new URL('./dot-sizes.js', import.meta.url), 'utf8');
const r = await s.evaluate(expr);
console.log(JSON.stringify(r, null, 2));
process.exit(0);
