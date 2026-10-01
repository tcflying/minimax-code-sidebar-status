// 验证汇总条前缀竖条的渲染值：尺寸 / 渐变 / 发光 / 闪烁动画。
// 判据：必须同时给出 animationName 与 animationTimingFunction，
// 因为 step-end 与 ease-in-out 视觉差别很大，只报 animationName 不够。
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';

const port = Number(process.argv[2] || 9331);
const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) { console.error('no archon target'); process.exit(1); }

const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

const r = await s.evaluate(`(() => {
  const bar = document.getElementById('mmx-running-summary');
  if (!bar) return { exists: false };
  const pip = bar.querySelector('i');
  if (!pip) return { exists: true, pipMissing: true };
  const cs = getComputedStyle(pip);
  const bs = getComputedStyle(bar);
  return {
    exists: true,
    pip: {
      width: cs.width,
      height: cs.height,
      borderRadius: cs.borderRadius,
      background: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor,
      boxShadow: cs.boxShadow,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationTimingFunction: cs.animationTimingFunction,
      animationIterationCount: cs.animationIterationCount,
    },
    bar: {
      bg: bs.backgroundColor,
      boxShadow: bs.boxShadow,
      height: bs.height,
      color: bs.color,
    },
    keyframesPresent: (() => {
      for (const sh of document.styleSheets) {
        let rules; try { rules = sh.cssRules } catch { continue }
        for (const rule of rules) {
          if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === '__mmxBlink') {
            return { found: true, cssText: rule.cssText };
          }
        }
      }
      return { found: false };
    })(),
  };
})()`);
console.log(JSON.stringify(r, null, 2));
process.exit(0);
