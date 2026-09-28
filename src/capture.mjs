// mmx-status :: capture.mjs
// Screenshots the MiniMax Code renderer over CDP so the injected status dots
// can be verified visually, and reports the live DOM state of the dots.
//
//   node capture.mjs --port 9352 --out shot.png [--clip 0,0,420,1400]

import fs from 'node:fs';
import path from 'node:path';
import { connectRenderer } from './lib/cdp.mjs';

function parseArgs(argv) {
  const out = { port: 9351, out: 'shot.png', clip: '', zoom: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--clip') out.clip = argv[++i];
    else if (a === '--zoom') out.zoom = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const { session, target } = await connectRenderer(args.port);
console.log('target:', target.url, '|', target.title);

// Live state of the injected dots.
const state = await session.evaluate(`(function(){
  var dots = document.querySelectorAll('[data-mmx-dot]');
  var byBucket = {};
  var detail = [];
  for (var i = 0; i < dots.length; i++) {
    var d = dots[i];
    var b = d.getAttribute('data-mmx-bucket') || 'none';
    byBucket[b] = (byBucket[b] || 0) + 1;
    if (detail.length < 8) {
      var cs = getComputedStyle(d);
      var row = d.closest('[data-session-id]');
      detail.push({
        bucket: b,
        text: String((row && row.textContent) || '').trim().slice(0, 40),
        bg: cs.backgroundColor,
        w: cs.width, h: cs.height, pos: cs.position,
      });
    }
  }
  var style = document.getElementById('mmx-status-style');
  return {
    installed: !!window.__mmxStatus,
    dotCount: dots.length,
    byBucket: byBucket,
    styleInjected: !!style,
    viewport: { w: innerWidth, h: innerHeight },
    detail: detail,
  };
})()`);

console.log('\n=== 注入状态 ===');
console.log(JSON.stringify(state, null, 2));

// Screenshot the sidebar strip where the dots live.
let clip;
if (args.clip) {
  const [x, y, width, height] = args.clip.split(',').map(Number);
  clip = { x, y, width, height, scale: args.zoom };
} else {
  clip = { x: 0, y: 0, width: Math.min(440, state.viewport.w), height: state.viewport.h, scale: args.zoom };
}

const shot = await session.send('Page.captureScreenshot', {
  format: 'png',
  clip,
  captureBeyondViewport: false,
});
const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
console.log('\n截图已保存:', outPath, fs.statSync(outPath).size, 'bytes');

session.close();
