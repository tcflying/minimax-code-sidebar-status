// Independent re-check of the selected-row background.
// Uses EXACTLY the selector the injected stylesheet uses. The previous probe
// used only the middle segment of that selector, matched a different element,
// and produced a false negative.
import { listTargets, CdpSession } from '../src/lib/cdp.mjs';

const port = Number(process.argv[2] || 9331);
const targets = await listTargets(port);
const page = targets.find(
  (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
);
if (!page) {
  console.error('no archon target');
  process.exit(1);
}
const s = await CdpSession.connect(page.webSocketDebuggerUrl);
await s.send('Runtime.enable').catch(() => {});

const out = await s.evaluate(`(() => {
  const sel =
    '[data-session-id] button.bg-bg_interaction_tertiary_hover' +
    ':not([class*="hover:bg-bg_interaction_tertiary_hover"])';
  const selHover =
    '[data-session-id] button.bg-bg_interaction_tertiary_hover' +
    '[class*="hover:bg-bg_interaction_tertiary_hover"]';

  const strict = document.querySelectorAll(sel);
  const first = strict[0];
  const cs = first ? getComputedStyle(first) : null;
  const root = getComputedStyle(document.documentElement);

  // Is the injected stylesheet actually present and is the var defined?
  const styleEl = document.getElementById('mmx-status-style');
  const cssText = styleEl ? styleEl.textContent : '';
  const rulePresent = cssText.includes('--mmx-active-bg');
  const ruleMatchesSelector = cssText.includes(':not([class*="hover:bg-bg_interaction_tertiary_hover"])');

  return {
    styleInjected: !!styleEl,
    cssRulePresent: rulePresent,
    cssRuleHasStrictSelector: ruleMatchesSelector,
    varActiveBg: root.getPropertyValue('--mmx-active-bg').trim(),
    varActiveBar: root.getPropertyValue('--mmx-active-bar').trim(),
    strictMatchCount: strict.length,
    hoverOnlyMatchCount: document.querySelectorAll(selHover).length,
    strictBg: cs ? cs.backgroundColor : null,
    strictBoxShadow: cs ? cs.boxShadow : null,
    strictBorderLeft: cs ? cs.borderLeftWidth + ' ' + cs.borderLeftColor : null,
    strictSessionId: first ? first.closest('[data-session-id]')?.getAttribute('data-session-id') : null,
    // Prove the probe can tell the two states apart at all: a known-bad probe
    // that drops the :not() guard must return MORE elements, proving the guard
    // is what discriminates the selected row.
    naiveMatchCount: document.querySelectorAll(
      'button.bg-bg_interaction_tertiary_hover'
    ).length,
  };
})()`);

console.log(JSON.stringify(out, null, 2));
s.close();
