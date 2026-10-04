// mmx-status :: test-topmost-menu.mjs
//
  // Behaviour tests for the "pin to top" (到最顶) session-menu item, driving the
  // REAL code sliced out of lib/page-script.mjs against a fake DOM and a fake
  // React fiber tree shaped like the host's.
//
  // THE FACTS BEING TESTED COME FROM app.asar, not from a design document. Read
  // out of the archive on 2026-10-03 (raw asar byte offsets):
//
  //  @316963124 / @317072055
  //      onPinSession: (e,t) => void u.handlePinSession(e,t)
  //      The prop every row component receives is a TWO argument wrapper, so
  //      (id, true, 0) silently loses the 0 and the host appends to the end of
  //      the pinned order. The props path must never be called; the test asserts
  //      the spy on that prop is never touched.
//
  //  @317043972 / @317045053
  //      handlePinSession: useCallback(async (e, l, c) => {
  //        if (isReadOnlySessionById(e, t)) return;
  //        ...
  //        const p = es.xs(order, {type:"session", id:e}, l, c);   // c = insert index
  //        p !== order && setPinnedItemsOrder(p);
  //        await PinService.pinSession(e, l, l ? c : void 0, t);
  //      }), deps: [isReadOnlySessionById, order, conversationSource,
  //                 pinnedProjectSessionPages, mergePayloads, removePayload,
  //                 setPinnedItemsOrder]            -- 7 entries
//
  //  The fake host below reproduces exactly that, including the pure helper it
  //  calls: an undefined index appends, 0 goes to the front, and the item is
  //  filtered out before being re-inserted. So the tests can assert the EFFECT
  //  (where the id ends up in the order array, and what the persistence call was
  //  handed) rather than that some function was invoked.
//
  // Every mutation below re-introduces one specific mistake and MUST turn this
  // file red. Run with MMX_MUTATE=<id>.
//
  //   m1  the call drops the index: cap.fn(id, true)
  //       -> "5.1 到最顶：id 落到 order[0]" fails
  //   m2  the popup is no longer bound to the right-clicked row's menu fiber
  //       -> "4.2 别的行的菜单不被注入" fails
  //   m3  clearTopmostItems() does nothing
  //       -> "4.5 反复开合菜单只有一项" fails
  //   m4  the click no longer re-checks that the row is still the same row
  //       -> "6.2 行已卸载时拒绝调用" fails
  //   m5  the hook selector stops requiring the .getSessionInfo marker
  //       -> "2.5 同形诱饵不会被误认" fails
  //   m6  the isTrusted guard is dropped
  //       -> "6.1 合成点击不触发置顶" fails
  //   m7  rowMenuFiber goes back to walking .return only (the pre-review bug):
  //       the row's own DESCENDANT dropdown, which is where the menu prop lives,
  //       is never reached, so nothing is injected anywhere
  //       -> 3.1 / 4.x / 8.x all fail
  //   m8  currentFiberOf stops proving which half is mounted
  //       -> "1.8 expando 指向陈旧半边时" fails
  //   m9  the item loses tabindex and its keydown handler
  //       -> "8.1 菜单项可被 Tab 聚焦" fails
  //   m10 the host menu is never closed after the click
  //       -> "8.4 点击后调用宿主的关闭回调" fails
  //   m11 the raw machine reason code is rendered into the menu
  //       -> "9.3 未知码不会原样返回" fails
  //   m12 menu ownership is weakened from "nearest owner" back to "anywhere
  //       under this dropdown", which also accepts the hover "..." menu nested
  //       inside the contextMenu dropdown
  //       -> "7.4 悬浮的 ... 菜单不是归属菜单" fails
  //   m13  Space stops calling preventDefault
  //       -> "10.1 Space 调用了 preventDefault" and "10.3 Spacebar" fail
  //   m14  the GENERATION COMPARISON is removed from the retry attempt. The
  //       clearTimeout cancellation is deliberately LEFT IN PLACE, which is the
  //       whole point: it makes m14 a test of the second gate in isolation. To
  //       reach it, 11.1 pulls one callback out of the harness queue by hand so
  //       the shipped clearTimeout has no id to cancel, starts the successor
  //       chain, and only then fires the old one. 11.2, which relies on
  //       clearTimeout and nothing else, stays GREEN under m14 -- that is what
  //       proves 11.1 is measuring the generation rather than the cancellation.
  //       -> "11.1 旧链回调不往已过期的菜单里注入" fails
  //   m15  the popup visibility gate is removed, so a closing/cached overlay of
  //       the same owner is accepted
  //       -> "12.1 不可见的浮层里没有注入" fails
  //   m16  dispose no longer invalidates the generation (clearTimeout untouched)
  //       -> "11.4 dispose 使代次前进" fails
  //   m17  the popup loop record goes back to ONE record per popupForMenu call
  //       instead of one per candidate, so candidate N overwrites candidate N-1
  //       -> "13.6 / 18.* / 19.*" fail; it is the defect class the previous
  //          revision of this probe actually had
  //   m18  the candidate table stops being bounded at 4
  //       -> "16.2 / 16.7" fail
  //   m19  walking to null is reported as 'budget', so the two ways a walk ends
  //       become indistinguishable
  //       -> "14.4" fails
  //   m20  the alternate pairing stops being strictly bidirectional (AND -> OR)
  //       -> "15.2 / 15.3" fail
  //   m21  the found exit drops the ulExpando entry guard, so a candidate whose
  //       entry write failed still gets a fabricated owner end
  //       -> "18.four-gates/nmo-found" fails
  //   m22  the hidden exit reports visible=null instead of the false it evaluated
//   m23  the shared gate's null result is ignored and cap.fn runs anyway (r3's
//       original defect, reintroduced) -> "22.1 闸不可用时【一次宿主写都没有】" fails
//   m24  the refusal leaves busy set -> "22.1 busy【不残留】" fails
//   m25  the refusal still counts the call -> "22.1 calls 不增" fails
//   m26  the refusal no longer closes the host's menu -> "22.1 菜单照样关闭" fails
//       -> "13.10" fails

//
  //   node test-topmost-menu.mjs
  //   MMX_MUTATE=<id> node test-topmost-menu.mjs       # expected: FAILED
  //   run-mutations.mjs re-runs all of them and prints the table.

import fs from 'node:fs';
import { makeDom, attachFiber, hookChain, fiber } from './testlib/fake-dom.mjs';

const MUT = process.env.MMX_MUTATE || '';
let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

  // Non-throwing item lookup. A mutation that stops injection entirely must
  // surface as ordinary FAILs on the assertions below it, not as a TypeError
  // that aborts the run before the remaining behaviour is ever exercised. The
  // stub keeps the rest of each test running so the evidence names every broken
  // behaviour instead of only the first one.
const MISSING_ITEM = {
  isConnected: true,
  textContent: '',
  className: '',
  getAttribute: () => null,
  setAttribute: () => {},
  dispatch: () => {},
  focus: () => {},
};
function topLi(ul) {
  const li = ul && ul.querySelector('li[data-mmx-topmost]');
  if (li) return li;
  check('注入前提：li[data-mmx-topmost] 已注入菜单', false, '未注入');
  return MISSING_ITEM;
}
function clickTop(ul, extra) {
  const li = topLi(ul);
  li.dispatch('click', Object.assign({ isTrusted: true }, extra || {}));
  return li;
}

const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}
let BLOCK = sliceBlock("  var TOPMOST_LABEL = '到最顶';", '  var handler = function () { scheduleApply(); };');
  // The slice exactly as shipped, captured BEFORE the mutation chain edits it.
  // The instrumentation below is a test-only overlay: it must be anchored on the
  // shipped text, not on whatever a mutation left behind.
const PRISTINE_BLOCK = BLOCK;

  // The dispose teardown also invalidates the generation, and that line is part
  // of finding 2, so it is sliced out of the shipped source too rather than
  // retyped here. Anchored on the clearTimeout loop, which is unique.
const DISPOSE_ANCHOR = '      for (var tt = 0; tt < topmostTimers.length; tt++)';
const DISPOSE_END = '      clearTopmostItems();';
{
  const a = pageSrc.indexOf(DISPOSE_ANCHOR);
  if (a < 0) throw new Error('cannot locate the dispose teardown in page-script.mjs');
  const b = pageSrc.indexOf(DISPOSE_END, a);
  if (b < 0) throw new Error('cannot locate the end of the dispose teardown');
  BLOCK += '\n  var disposeTopmost = function () {\n' + pageSrc.slice(a, b + DISPOSE_END.length) + '\n  };\n';
}

if (MUT === 'm1') {
  const from = 'ret = cap.fn(sessionId, true, 0);';
  if (!BLOCK.includes(from)) throw new Error('mutation m1 anchor not found');
  BLOCK = BLOCK.replace(from, 'ret = cap.fn(sessionId, true);');
} else if (MUT === 'm2') {
  const from = "if (nearestMenuOwner(fiberOf(ul), __rec, menuFiber) !== menuFiber) { topmostDiagPopupFork(__tr, __rec, 'owner-mismatch', false, true, null); continue; }";
  if (!BLOCK.includes(from)) throw new Error('mutation m2 anchor not found');
  BLOCK = BLOCK.replace(from, '// ownership check removed by mutation m2');
} else if (MUT === 'm3') {
  const from = `  function clearTopmostItems() {
    var items = document.querySelectorAll('li[' + TOPMOST_ATTR + ']');
    for (var i = 0; i < items.length; i++) items[i].remove();
    topmostNode = null;
    topmostState.injected = 0;
  }`;
  if (!BLOCK.includes(from)) throw new Error('mutation m3 anchor not found');
  BLOCK = BLOCK.replace(from, '  function clearTopmostItems() { /* mutation m3: leak */ }');
} else if (MUT === 'm4') {
  const from = `if (!rowEl || !rowEl.isConnected || rowEl.getAttribute('data-session-id') !== sessionId) {
      topmostState.blocked++;
      topmostReason('row-gone');
      return;
    }`;
  if (!BLOCK.includes(from)) throw new Error('mutation m4 anchor not found');
  BLOCK = BLOCK.replace(from, '    // row identity check removed by mutation m4');
} else if (MUT === 'm5') {
  const from = "return src.indexOf('.pinSession') >= 0 && src.indexOf('.getSessionInfo') >= 0;";
  if (!BLOCK.includes(from)) throw new Error('mutation m5 anchor not found');
  BLOCK = BLOCK.replace(from, 'return src.indexOf(".pinSession") >= 0 || src.length > 0;');
} else if (MUT === 'm7') {
  // The pre-review bug: walk .return only, so the row's own DESCENDANT dropdown
  // (which is where the menu prop actually lives) is never found and the item
  // is injected nowhere.
  const from = [
    '  function rowMenuFiber(rowEl) {',
    '    if (!rowEl) return null;',
    "    var anchor = rowEl.querySelector ? rowEl.querySelector('[data-shortcut-session-target]') : null;",
    '    if (anchor) {',
    '      var f = fiberOf(anchor);',
    '      for (var a = 0; f && a < TOPMOST_MAX_ANCESTORS; a++) {',
    '        var p = f.memoizedProps;',
    '        if (p && isArray(p.menu) && p.menu.length) return f;',
    '        f = f.return;',
    '      }',
    '      // The anchor existed but nothing above it owns a menu: this row has no',
    '      // right-click menu at all, which is a legitimate host state.',
    '      return null;',
    '    }',
  ].join('\n');
  const to = [
    '  function rowMenuFiber(rowEl) {',
    '    if (!rowEl) return null;',
    '    {',
    '      var f = fiberOf(rowEl);',
    '      for (var a = 0; f && a < TOPMOST_MAX_ANCESTORS; a++) {',
    '        var p = f.memoizedProps;',
    '        if (p && isArray(p.menu) && p.menu.length) return f;',
    '        f = f.return;',
    '      }',
    '      return null;',
    '    }',
  ].join('\n');
  if (!BLOCK.includes(from)) throw new Error('mutation m7 anchor not found');
  BLOCK = BLOCK.replace(from, to);
} else if (MUT === 'm8') {
  // The pre-review behaviour: believe whatever half the expando hands back.
  const from8 = '    var top = chainTop(f0);';
  if (!BLOCK.includes(from8)) throw new Error('mutation m8 anchor not found');
  BLOCK = BLOCK.replace(from8, "    return { fiber: f0, reason: '' }; // mutation m8: no tree proof\n    var top = chainTop(f0);");
} else if (MUT === 'm9') {
  // Keyboard reachability removed.
  const from9 = "      li.setAttribute('tabindex', '0');";
  if (!BLOCK.includes(from9)) throw new Error('mutation m9 anchor A not found');
  BLOCK = BLOCK.replace(from9, '');
  const from9b = "      li.addEventListener('keydown', function (ev) {";
  if (!BLOCK.includes(from9b)) throw new Error('mutation m9 anchor B not found');
  BLOCK = BLOCK.replace(from9b, "      if (false) li.addEventListener('keydown', function (ev) {");
} else if (MUT === 'm10') {
  // The host's own close path is no longer used.
  const fromA = '    topmostState.lastClose = closeHostMenu(menuFiber);';
  if (!BLOCK.includes(fromA)) throw new Error('mutation m10 anchor not found');
  BLOCK = BLOCK.replace(fromA, "    topmostState.lastClose = 'skipped';");
} else if (MUT === 'm11') {
  // The disabled item shows the internal code again.
  const fromB = "label.textContent = cap.available ? TOPMOST_LABEL : (TOPMOST_LABEL + '（' + topmostReasonText(cap.reason) + '）');";
  if (!BLOCK.includes(fromB)) throw new Error('mutation m11 anchor not found');
  BLOCK = BLOCK.replace(fromB, "label.textContent = cap.available ? TOPMOST_LABEL : (TOPMOST_LABEL + '(' + cap.reason + ')');");
} else if (MUT === 'm12') {
  // nearest-owner binding weakened back to "anywhere under this dropdown",
  // which also accepts the hover "..." menu nested inside it.
  const fromC = "if (nearestMenuOwner(fiberOf(ul), __rec, menuFiber) !== menuFiber) { topmostDiagPopupFork(__tr, __rec, 'owner-mismatch', false, true, null); continue; }";
  if (!BLOCK.includes(fromC)) throw new Error('mutation m12 anchor not found');
  BLOCK = BLOCK.replace(fromC, 'if (!fiberUnder(fiberOf(ul), menuFiber)) continue;');
  BLOCK = 'function fiberUnder(f, target) { for (var i = 0; f && i < 40; i++) { if (f === target) return true; f = f.return; } return false; }\n' + BLOCK;
} else if (MUT === 'm13') {
  // Space stops calling preventDefault. The sidebar list is the nearest
  // scrollable ancestor of a focused menu item, so Space's own default action
  // scrolls it and a keyboard user gets the sidebar scrolling under them.
  const from = 'if (isSpace && ev.preventDefault) { try { ev.preventDefault(); } catch (e) {} }';
  if (!BLOCK.includes(from)) throw new Error('mutation m13 anchor not found');
  BLOCK = BLOCK.replace(from, '// Space preventDefault removed by mutation m13');
} else if (MUT === 'm14') {
  // The generation COMPARISON is gone. Cancelling the pending timers is left
  // in place, so this is only observable through a callback the event loop has
  // already dequeued -- which is why the retry test below dequeues one by hand
  // and fires it after the successor chain has started. A test that only let
  // the queue drain would pass here and prove nothing.
  const from = '      if (gen !== topmostGeneration) return;          // superseded chain';
  if (!BLOCK.includes(from)) throw new Error('mutation m14 anchor not found');
  BLOCK = BLOCK.replace(from, '      // generation comparison removed by mutation m14');
} else if (MUT === 'm15') {
  // The popup visibility gate is gone, so a cached/closing overlay of the same
  // owner is accepted and the item lands where nobody can see it while
  // topmostState.injected reports 1.
  const from = "      if (!elementIsVisible(ul)) { topmostReason('popup-hidden'); topmostDiagPopupFork(__tr, __rec, 'hidden', false, true, false); continue; }";
  if (!BLOCK.includes(from)) throw new Error('mutation m15 anchor not found');
  BLOCK = BLOCK.replace(from, '      // visibility gate removed by mutation m15');
} else if (MUT === 'm16') {
  // dispose no longer invalidates the generation. The clearTimeout loop above
  // it is untouched, so again only a dequeued callback can see the difference.
  const from = '      topmostGeneration++;';
  if (!BLOCK.includes(from)) throw new Error('mutation m16 anchor not found');
  BLOCK = BLOCK.replace(from, '      // generation not invalidated on dispose (mutation m16)');
} else if (MUT === 'm17') {
  // The defect class the previous revision of this probe actually had: ONE
  // record per trace instead of one per candidate. Every candidate then writes
  // onto the SAME object, so candidate N overwrites candidate N-1.
  const fromA = "      tr.scanned++;\n      return {\n        i: i, outcome: 'unknown',";
  const toA = "      tr.scanned++;\n      if (tr.__rec) { tr.__rec.i = i; return tr.__rec; }\n      tr.__rec = {\n        i: i, outcome: 'unknown',";
  const fromB = "        ownerIsAlternateOfMenuFiber: null,\n      };\n    } catch (e) { return null; }";
  const toB = "        ownerIsAlternateOfMenuFiber: null,\n      };\n      return tr.__rec;\n    } catch (e) { return null; }";
  for (const a of [fromA, fromB]) {
    if (BLOCK.split(a).length - 1 !== 1) throw new Error('mutation m17 anchor not unique: ' + a.slice(0, 50));
  }
  BLOCK = BLOCK.replace(fromA, toA).replace(fromB, toB);
} else if (MUT === 'm18') {
  // The truncation stops truncating: every rejected candidate enters the table,
  // so "the diagnostic is bounded at four" stops being true.
  const from = 'if (tr.candidates.length < TOPMOST_DIAG_POPUP_MAX_CANDIDATES) tr.candidates.push(rec);';
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m18 anchor not unique');
  BLOCK = BLOCK.replace(from, 'if (tr.candidates.length < 64) tr.candidates.push(rec);');
} else if (MUT === 'm19') {
  // Walking to null is reported as budget, so the two ways a walk can end stop
  // being distinguishable -- which is one of the things this trace exists for.
  const from = "? 'no-fiber' : (fiber ? 'budget' : 'chain-ended');";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m19 anchor not unique');
  BLOCK = BLOCK.replace(from, "? 'no-fiber' : 'budget';");
} else if (MUT === 'm20') {
  // Strictly bidirectional becomes either-direction, so a ONE-SIDED link would
  // be reported as a pairing and the boolean would stop meaning "both".
  const from = "                  && fiber.alternate === want\n                  && want.alternate === fiber);";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m20 anchor not unique');
  BLOCK = BLOCK.replace(from, "                  || want.alternate === fiber);");
} else if (MUT === 'm21') {
  // The entry guard is dropped from the found exit, so a candidate whose entry
  // write failed still gets a fabricated owner end.
  const from = "            if (rec.ulExpando !== null) {\n              rec.ownerFound = true;";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m21 anchor not unique');
  BLOCK = BLOCK.replace(from, "            if (true) {\n              rec.ownerFound = true;");
} else if (MUT === 'm22') {
  // The hidden exit reports "not evaluated" instead of the value it evaluated:
  // exactly the null-means-never-ran contract being destroyed.
  const from = "topmostDiagPopupFork(__tr, __rec, 'hidden', false, true, false);";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m22 anchor not unique');
  BLOCK = BLOCK.replace(from, "topmostDiagPopupFork(__tr, __rec, 'hidden', false, true, null);");
} else if (MUT === 'm23') {
  // r4 REVERSE of the defect two reviews found: put the gate result back where
  // r3 had it. The null ticket is ignored, cap.fn runs anyway, and 22.1 must go
  // red. This is the mutation that proves the r4 test would have caught the
  // original bug -- an assertion that cannot be turned red proves nothing.
  // r4 REVERSE of the defect two reviews found: DELETE the whole refusal, so
  // the null ticket is ignored and cap.fn runs anyway -- r3's exact shape.
  // 22.1 must go red, which is the only proof the new test would have caught
  // the original bug. An assertion that cannot be turned red proves nothing.
  const from = "    var ticket = hostCallTake();\n    if (!ticket) {\n      topmostState.busy = false;\n      topmostState.ticket = null;\n      topmostState.blocked++;\n      topmostReason('gate-unavailable');\n      closeHostMenu(menuFiber);\n      return;\n    }";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m23 anchor not unique');
  BLOCK = BLOCK.replace(from, "    var ticket = hostCallTake();   // mutation m23: refusal removed");
} else if (MUT === 'm24') {
  // The refusal exists, but it leaves busy set. 22.1's "busy does not linger"
  // is the only thing that notices, so this proves that assertion has teeth.
  // The refusal happens, but busy is set BEFORE the take and never cleared --
  // which is what r3 actually did. 22.1's "busy does not linger" is the only
  // assertion that notices, so this proves it has teeth: without it a refusal
  // would leave the item looking permanently in flight.
  const from = "    var ticket = hostCallTake();\n    if (!ticket) {\n      topmostState.busy = false;\n      topmostState.ticket = null;\n      topmostState.blocked++;\n      topmostReason('gate-unavailable');";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m24 anchor not unique');
  BLOCK = BLOCK.replace(from, "    topmostState.busy = true;\n    var ticket = hostCallTake();\n    if (!ticket) {\n      topmostState.ticket = null;\n      topmostState.blocked++;\n      topmostReason('gate-unavailable');");
} else if (MUT === 'm25') {
  // The refusal counts the call anyway. 22.1's "calls does not grow" is what
  // notices -- without it a refusal would be indistinguishable from a success
  // in every counter the user can see.
  const from = "      topmostState.ticket = null;\n      topmostState.blocked++;\n      topmostReason('gate-unavailable');";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m25 anchor not unique');
  BLOCK = BLOCK.replace(from, "      topmostState.ticket = null;\n      topmostState.blocked++;\n      topmostState.calls++;\n      topmostReason('gate-unavailable');");
} else if (MUT === 'm26') {
  // r5: the refusal still refuses -- gate-unavailable, zero host writes, no
  // crash -- it just stops closing the menu. The user's gesture happened; a
  // popup left hanging open after they used it is the confusing outcome, and
  // the product deliberately closes it on this path too.
  //
  // This mutation exists because 22.1's closing assertion used to read
  //   p.api.state.lastClose !== null && p.api.state.lastClose !== undefined
  // which is TRUE for the initial '' and stays true when the refusal branch
  // never assigns lastClose at all -- so deleting closeHostMenu there could
  // not turn it red. The assertion is now on the host's own controlled
  // onOpenChange(false) call, and this mutation is what proves it has teeth.
  const from = "      topmostReason('gate-unavailable');\n      closeHostMenu(menuFiber);\n      return;";
  if (BLOCK.split(from).length - 1 !== 1) throw new Error('mutation m26 anchor not unique');
  BLOCK = BLOCK.replace(from, "      topmostReason('gate-unavailable');\n      return;   // mutation m26: the refusal no longer closes the menu");
} else if (MUT === 'm6') {
  const from = "if (!ev || !ev.isTrusted) { topmostState.blocked++; topmostReason('untrusted-click'); return; }";
  if (!BLOCK.includes(from)) throw new Error('mutation m6 anchor not found');
  BLOCK = BLOCK.replace(from, '    // isTrusted guard removed by mutation m6');
} else if (MUT) {
  throw new Error('unknown MMX_MUTATE=' + MUT);
}

  // ---------------------------------------------------------------------------
  // Test-only fault injection into the SHIPPED popup side channel.
//
  // Nothing here is in production: page-script.mjs carries no tick hook and no arm
  // point (asserted in section 16). The instrumented build is produced by applying
  // exact textual replacements to the slice above, and every replacement is
  // anchored on real shipped text AND required to match exactly once -- a delta
  // that silently did not apply would leave every assertion below passing for the
  // wrong reason, so a mismatch throws the whole build away instead.
//
  // Each tick sits INSIDE the helper's own try, which is where a real throw would
  // land: wrapping the call site in a try instead would test something the product
  // never does.
  // ---------------------------------------------------------------------------
const PRELUDE = [
  '  var __hits = {};',
  '  var __armMap = {};',
  '  var __reasons = [];',
  '  function __tick(name) {',
  '    __hits[name] = (__hits[name] || 0) + 1;',
  '    var nth = __armMap[name];',
  '    if (nth !== undefined && nth === __hits[name]) throw new Error("diag-boom:" + name + "#" + nth);',
  '  }',
  '',
].join('\n');

const TICK_ANCHORS = [
  ['    try {\n      var trace = {', '    try {\n      __tick("open");\n      var trace = {'],
  ['  function topmostDiagPopupCandidate(tr, i) {\n    try {\n      if (!tr) return null;',
    '  function topmostDiagPopupCandidate(tr, i) {\n    try {\n      __tick("candidate");\n      if (!tr) return null;'],
  ['  function topmostDiagPopupMark(rec, key, value) {\n    try { if (rec) rec[key] = value; } catch (e) {}',
    '  function topmostDiagPopupMark(rec, key, value) {\n    try { __tick("mark"); if (rec) rec[key] = value; } catch (e) {}'],
  ['  function topmostDiagPopupFork(tr, rec, kind, copy, hasItems, visible) {\n    try {\n      if (!tr) return;',
    '  function topmostDiagPopupFork(tr, rec, kind, copy, hasItems, visible) {\n    try {\n      __tick("fork");\n      if (!tr) return;'],
  ['    if (rec) { try { rec.ulExpando = !!fiber; } catch (e) {} }',
    '    if (rec) { try { __tick("nmo-entry"); rec.ulExpando = !!fiber; } catch (e) {} }'],
  ['            if (rec.ulExpando !== null) {\n              rec.ownerFound = true;',
    '            if (rec.ulExpando !== null) {\n              __tick("nmo-found");\n              rec.ownerFound = true;'],
  ['        if (rec.ulExpando !== null) {\n          rec.ownerFound = false;',
    '        if (rec.ulExpando !== null) {\n          __tick("nmo-miss");\n          rec.ownerFound = false;'],
];

  // The reason sequence has to be COMPARED, not just the final lastReason: a
  // diagnostic that wrote one extra topmostReason, or reordered two, would leave
  // lastReason looking normal on a scenario that ends the same way.
const REASON_ANCHOR = [
  '  function topmostReason(reason) {\n    topmostState.lastReason = String(reason || \'\');\n  }',
  '  function topmostReason(reason) {\n    __reasons.push(String(reason || \'\'));\n    topmostState.lastReason = String(reason || \'\');\n  }',
];

  // The shipped slice must contain every injection point EXACTLY once. That is
  // checked against PRISTINE_BLOCK, so a typo in an anchor fails loudly here
  // instead of silently skipping the instrumentation and turning every assertion
  // below into a false green.
const DELTAS = TICK_ANCHORS.concat([REASON_ANCHOR]);
const ANCHOR_HEALTH = DELTAS.map(([from]) => PRISTINE_BLOCK.split(from).length - 1);
if (ANCHOR_HEALTH.some((n) => n !== 1)) {
  throw new Error('instrumentation anchor missing or ambiguous in the shipped slice: '
    + ANCHOR_HEALTH.join(',') + ' over ' + DELTAS.map(([, to]) => to.slice(0, 40)).join(' | '));
}

function instrumentedBlock(src) {
  let out = typeof src === 'string' ? src : BLOCK;
  for (let k = 0; k < DELTAS.length; k++) {
    const from = DELTAS[k][0], to = DELTAS[k][1];
    const n = out.split(from).length - 1;
    // Zero matches is legitimate under a mutation that deleted that exact line;
    // it is NOT legitimate on the shipped slice, which is what ANCHOR_HEALTH
    // already proved. More than one match is always ambiguous, so it throws.
    if (n > 1) {
      throw new Error('instrumentation anchor matched ' + n + ' times: '
        + JSON.stringify(from.slice(0, 80)));
    }
    if (n === 1) out = out.replace(from, to);
  }
  return out;
}

  // ---------------------------------------------------------------------------
  // Fake host: the pinned-order store plus the real three-argument pin entry
  // point, with the same dependency layout the real one has.
  // ---------------------------------------------------------------------------
function clampInsertIndex(index, max) {
  if (index === undefined || !Number.isFinite(index)) return max;
  return Math.max(0, Math.min(max, Math.trunc(index)));
}
function updatePinnedRefs(refs, item, pinned, insertIndex) {
  const withoutItem = refs.filter((r) => r.type !== item.type || r.id !== item.id);
  if (!pinned) return withoutItem;
  const index = clampInsertIndex(insertIndex, withoutItem.length);
  return [...withoutItem.slice(0, index), item, ...withoutItem.slice(index)];
}
const ref = (id) => ({ type: 'session', id });

function makeHost(opts = {}) {
  const h = {
    order: (opts.order || [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')]).map((r) => ({ ...r })),
    source: opts.source || 'local',
    calls: [],
    persists: [],
    readOnlyProbes: [],
    rollbacks: 0,
    rejected: false,
  };
  PinService.calls = h.persists = [];
  h.deps = [
    // isReadOnlySessionById(sessionId, conversationSource)
    (id, src) => {
      h.readOnlyProbes.push([id, src]);
      return !!(opts.readOnly || []).includes(id);
    },
    h.order,
    h.source,
    {},                                        // pinnedProjectSessionPages
    () => {},                                  // mergePinnedItemPayloads
    () => {},                                  // removePinnedItemPayload
    (next) => { h.order = next; },             // setPinnedItemsOrder
  ];
  // The shape below is the one in the archive, including the two property
  // accesses the selector looks for. Writing it out (instead of a stub) is the
  // point: a stub would not carry the markers and the test would prove nothing
  // about the real selector.
  h.fn = async function (e, l, c) {
    h.calls.push([e, l, c]);
    if (h.deps[0](e, h.source)) return;                 // silent refusal
    const session = await SessionInfo.getSessionInfo(e, undefined, h.source);
    const next = updatePinnedRefs(h.order, { type: 'session', id: e }, l, c);
    if (next !== h.order) h.deps[6](next);
    if (opts.fail) {
      h.deps[6](h.order.slice());
      h.rollbacks++;
      return;
    }
    if (opts.hang) return new Promise(() => {});
    await PinService.pinSession(e, l, l ? c : undefined, h.source);
    void session;
  };

  // A same-shaped decoy: arity 3, but six deps and no getSessionInfo. This is
  // the sidebar hover/activation callback shape the selector has to reject.
  h.decoy = function (a, b, c2) { return [a, b, c2].length; };
  h.decoyDeps = [() => {}, h.order, h.source, {}, () => {}, () => {}];
  return h;
}
const SessionInfo = { getSessionInfo: async (id) => ({ id }) };
  // asar@317045053: await eU.f.pinSession(e,l,l?c:void 0,t)
const PinService = {
  calls: [],
  async pinSession(sessionId, pinned, insertIndex) {
    PinService.calls.push([sessionId, pinned, insertIndex]);
  },
};
  // A second, "hover" container higher in the tree: arity 3, seven deps, calls
  // .pinSession, but never mentions getSessionInfo.
function makeHoverDecoy(order) {
  const fn = function (a, b, c) { return PinShim.pinSession(a, b, c); };
  const deps = [() => {}, order, 'local', {}, () => {}, () => {}, () => {}];
  return { fn, deps };
}
const PinShim = { pinSession: async () => {} };

  // ---------------------------------------------------------------------------
  // A timer queue that can also simulate the case the generation check is for.
//
  // WHAT THIS IS NOT: it is not a claim that a queued HTML timer is
  // un-cancellable. It is not -- clearTimeout reaches a timer that is still
  // queued and has not run, and the production code relies on that first.
  // take() is the HARNESS pulling one callback out of its own queue so the
  // shipped clearTimeout has no id left to cancel, which is how a test isolates
  // the second, independent gate from the first one. It says nothing about
  // browser timer semantics, and the assertions built on it must not be read as
  // such a claim.
//
  // run() is "the event loop fires the next batch": it takes the callbacks out of
  // the queue and then calls them, exactly like the real thing.
  // ---------------------------------------------------------------------------
function makeTimers() {
  const q = [];
  let id = 0;
  return {
    setTimeout(fn) {
      const t = { id: ++id, fn };
      q.push(t);
      return t.id;
    },
    clearTimeout(tid) {
      const i = q.findIndex((t) => t.id === tid);
      if (i >= 0) q.splice(i, 1);
    },
    run() {
      const batch = q.splice(0, q.length);
      for (const t of batch) t.fn();
    },
    // Dequeue one pending callback and return a handle that fires it later.
    // This is the harness removing it, so the shipped clearTimeout has no id
    // left to reach. Returns null when nothing with that id is queued, i.e. it
    // has already been dequeued or cancelled.
    take(tid) {
      const i = q.findIndex((t) => t.id === tid);
      if (i < 0) return null;
      const [t] = q.splice(i, 1);
      return { id: t.id, fire: () => t.fn() };
    },
    ids() {
      return q.map((t) => t.id);
    },
    size() {
      return q.length;
    },
  };
}

function makePage(src, winOpts) {
  const dom = makeDom();
  const timers = makeTimers();
  const window = { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  // r4: the shared gate lives on this very object, so a test has to be able to
  // make the slot unwritable -- or occupied by another instance's ticket --
  // BEFORE the shipped code runs. That is the only way to drive the REAL
  // hostCallTake into its null branch from the REAL menu entry; testing the
  // fragment on its own would prove nothing about what onTopmostActivate then
  // does with that null, which is precisely the r3 defect.
  if (winOpts && winOpts.foreignTicket) window.__mmxStatusHostGateV1 = { ticket: winOpts.foreignTicket };
  if (winOpts && winOpts.freeze) Object.freeze(window);
  const factory = new Function(
    'window',
    'document',
    'var disposed = false;\n' +
      (typeof src === 'string' ? src : BLOCK) +
      PRELUDE +
      '\nreturn { topmostCapability, looksLikeHandlePin, findHandlePins, rowMenuFiber,' +
      ' popupForMenu, tryInjectTopmost, onContextMenu, onTopmostActivate, closeHostMenu, currentFiberOf, topmostReasonText, clearTopmostItems,' +
      ' reapTopmost, state: topmostState, node: function () { return topmostNode; },' +
      ' disposeTopmost: disposeTopmost,' +
      ' generation: function () { return topmostGeneration; },' +
      ' pendingTimers: function () { return topmostTimers.length; },' +
      // Read-only handles onto the diagnostic side channel, so section 13+ can
      // assert the RAW loop record the shipped popupForMenu wrote, instead of
      // re-deriving it. None of them writes: the traces in this file are
      // produced by driving the shipped popupForMenu itself.
      ' diag: function () { return topmostDiag; },' +
      ' popupCopy: topmostDiagPopupCopy,' +
      ' tick: function () { return __hits; },' +
      ' reasons: function () { return __reasons.slice(); },' +
      ' arm: function (m) { __armMap = m; },' +
      ' setDisposed: function (v) { disposed = v; }, label: TOPMOST_LABEL, attr: TOPMOST_ATTR };'
  );
  const api = factory(window, dom.document);
  return { dom, timers, window, api };
}

/**
 * A row built the way the host actually builds it, not the way it is convenient
 * to build. Read out of app.asar on 2026-10-03 (raw asar byte offsets):
 *
 *  @316711900  return jsxs("div", {"data-session-id": n.id, children: [
 *  @316711700      jsx(B.L, { menu: tv, placement:"bottomLeft", compact:true,
 *                    trigger:["contextMenu"], open: eY, onOpenChange: tf, ...
 *                    children: jsxs("div", { className:"group relative rounded-lg", ...
 *                      children: [
 *                        <button type="button" data-shortcut-session-target={n.id}> ...
 *                        <div className="absolute right-1 top-1/2 ...">
 *                          jsx(B.L, { menu: tv, ... })      <- the hover "..." menu
 *                      ] }) })])
 *  @316702376  the row COMPONENT's own props are { session, onActivateSession,
 *              ..., onPinSession, onDeleteSession } -- no menu prop anywhere.
 *
 * Two facts the first version of the fixture got wrong, and both were caught by
 * review rather than by a green suite:
 *  1. the fiber carrying the menu prop is a DESCENDANT of div[data-session-id],
 *     an ancestor, so the ancestor walk found nothing and the item was dead;
 *  2. the expando __reactFiber$ is written once at mount, so after any
 *     re-render it may hand back the STALE half, whose hook list closes over an
 *     older order array.
 *
 * So this fixture builds BOTH halves, with different callbacks and different
 * order arrays, and points the expando at the stale one -- the dangerous case.
 */
function makeRow(page, id, host, opts = {}) {
  const rowEl = page.dom.el('div', { 'data-session-id': id });
  const shortcut = page.dom.el('button', { type: 'button', 'data-shortcut-session-target': id });
  rowEl.appendChild(shortcut);
  page.dom.root.appendChild(rowEl);

  // The half the page can actually see. A HostRoot fiber (tag 3) owns the
  // FiberRootNode, and root.current IS the current HostRoot by definition.
  const fiberRoot = { current: null };
  const currentRoot = fiber({ tag: 3, name: 'HostRoot', props: null, hooks: null, parent: null });
  currentRoot.stateNode = fiberRoot;
  const staleRoot = fiber({ tag: 3, name: 'HostRoot', props: null, hooks: null, parent: null });
  staleRoot.stateNode = fiberRoot;
  currentRoot.alternate = staleRoot;
  staleRoot.alternate = currentRoot;

  const stale = opts.staleHost || host;
  const decoyHooks = [[() => {}, [1, 2]], [host.decoy, host.decoyDeps]];
  const containerHooks = () => decoyHooks.concat([[host.fn, host.deps], [() => {}, []]]);

  const container = fiber({
    name: 'SidebarContainer', props: {}, hooks: hookChain(containerHooks()),
    parent: currentRoot,
  });
  const rowComponent = fiber({
    name: 'SessionRow',
    props: {
      session: { id },
      // The two-argument wrapper the host hands down. Calling it would drop the
      // index; the fixture counts every call so a test can prove we never do.
      onPinSession: (a, b) => { opts.propsCalls = (opts.propsCalls || 0) + 1; return [a, b]; },
    },
    hooks: null,
    parent: container,
  });
  const rowDiv = fiber({
    tag: 5, name: 'div', props: { 'data-session-id': id }, hooks: null, parent: rowComponent,
  });
  // The contextMenu dropdown: a CHILD of the row div, and the ancestor of the
  // shortcut button.
  const dropdown = fiber({
    name: 'Dropdown',
    props: {
      menu: [{ key: 'rename' }, { key: 'pin' }, { type: 'divider' }, { key: 'delete' }],
      open: false,
      onOpenChange: opts.onOpenChange || function (open) { opts.openChanges = (opts.openChanges || []).concat(open); },
      trigger: ['contextMenu'],
      placement: 'bottomLeft',
    },
    hooks: null,
    parent: rowDiv,
  });
  const group = fiber({ tag: 5, name: 'div', props: { className: 'group relative rounded-lg' }, hooks: null, parent: dropdown });
  const btnFiber = fiber({ tag: 5, name: 'button', props: { type: 'button', 'data-shortcut-session-target': id }, hooks: null, parent: group });
  const wrap = fiber({ tag: 5, name: 'div', props: { className: 'absolute right-1' }, hooks: null, parent: group });
  // The hover "..." dropdown: same menu array, no trigger. A DFS that only
  // looked for "a menu prop" would find two and have to give up.
  const hoverDropdown = fiber({
    name: 'Dropdown',
    props: { menu: [{ key: 'rename' }, { key: 'pin' }], open: false, onOpenChange() {}, placement: 'bottomLeft' },
    hooks: null,
    parent: wrap,
  });
  attachFiber(shortcut, btnFiber);
  rowDiv.child = dropdown;
  dropdown.child = group;
  group.child = btnFiber;
  btnFiber.sibling = wrap;
  wrap.child = hoverDropdown;

  // The stale half: same shape, DIFFERENT callback and DIFFERENT order array.
  // fiber.alternate is React's 1:1 pairing, so the current node of any stale
  // node is reachable -- and each half's .return chain ends at its own root.
  const staleContainer = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain(decoyHooks.concat([[stale.fn, stale.deps], [() => {}, []]])), parent: staleRoot });
  const staleRowComponent = fiber({ name: 'SessionRow', props: { session: { id } }, hooks: null, parent: staleContainer });
  const staleRowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, hooks: null, parent: staleRowComponent });
  fiberRoot.current = currentRoot;
  for (const [a, b] of [[currentRoot, staleRoot], [container, staleContainer],
    [rowComponent, staleRowComponent], [rowDiv, staleRowDiv]]) {
    a.alternate = b;
    b.alternate = a;
  }
  if (opts.stale) {
    // What React actually leaves on the node after a re-render: the mount-time
    // half, which by then is the stale one.
    attachFiber(rowEl, staleRowDiv);
  } else {
    attachFiber(rowEl, rowDiv);
  }
  return {
    rowEl, dropdown, hoverDropdown, container, rowComponent, rowDiv, shortcut,
    staleContainer, staleRowDiv, fiberRoot,
  };
}

/** The host's menu popup, rendered in a portal but parented to the Dropdown. */
function openMenu(page, dropdown, opts = {}) {
  const ul = page.dom.el('ul', { class: 'ant-dropdown-menu' });
  const items = page.dom.el('li', { class: 'ant-dropdown-menu-item' }, [
    page.dom.el('div', { class: 'matrix-menu-item' }, [page.dom.el('div', {}, ['重命名'])]),
  ]);
  items.addEventListener('click', () => { opts.hostClicks = (opts.hostClicks || 0) + 1; });
  ul.appendChild(items);
  const list = fiber({ name: 'MenuList', props: {}, hooks: null, parent: dropdown });
  const ulFiber = fiber({ tag: 5, name: 'ul', props: {}, hooks: null, parent: list });
  attachFiber(ul, ulFiber);
  if (opts.submenu) {
    const popup = page.dom.el('div', { class: 'ant-dropdown mavis-dropdown-root-sub-menu mavis-sidebar-copy-popup' });
    popup.appendChild(ul);
    page.dom.root.appendChild(popup);
  } else {
    page.dom.root.appendChild(ul);
  }
  return { ul, hostItem: items };
}

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

console.log(`\n=== 0. 出厂代码切片（MMX_MUTATE=${MUT || 'none'}）===`);
{
  const p = makePage();
  check('切到的是出厂实现', typeof p.api.topmostCapability === 'function' && typeof p.api.onContextMenu === 'function');
  let ok = true;
  try { new Function('window', 'document', 'var disposed=false;\n' + BLOCK); } catch (e) { ok = false; }
  check('切片语法合法', ok, `${BLOCK.length} chars`);
  check('不引入任何自造通道（无 fetch / XHR / token / 端口）',
    !/\bfetch\s*\(|XMLHttpRequest|accessToken|access_token|127\.0\.0\.1|localhost/.test(BLOCK));
  check('代码里没有出现 props 上的两参 wrapper 调用',
    !/memoizedProps\.onPinSession\s*\(/.test(BLOCK) && !/onPinSession\s*\(/.test(BLOCK));
}

  // ---------------------------------------------------------------------------
console.log('\n=== 1. 能力解析：只认那一个三参宿主 hook ===');
{
  const p = makePage();
  const host = makeHost();
  const { rowEl } = makeRow(p, 'mvs_abc', host);
  const cap = p.api.topmostCapability(rowEl);
  check('1.1 本地行可用', cap.available === true, `reason=${cap.reason}`);
  check('1.1 order 长度与首项如实读出', cap.orderLength === 3 && cap.orderFirst === 'session:mvs_a',
    `len=${cap.orderLength} first=${cap.orderFirst}`);
  check('1.1 读出的是宿主数组，不是本项目缓存', cap.orderFirst === 'session:' + host.order[0].id);
  check('1.1 只读探测调用了宿主的 isReadOnlySessionById(id, source)',
    JSON.stringify(host.readOnlyProbes[0]) === JSON.stringify(['mvs_abc', 'local']),
    JSON.stringify(host.readOnlyProbes));
  check('1.1 探测期间没有发生任何置顶调用', host.calls.length === 0 && host.persists.length === 0);
}
{
  const p = makePage();
  const host = makeHost();
  const { rowEl } = makeRow(p, 'mvs_a', host);
  const cap = p.api.topmostCapability(rowEl);
  check('1.2 已在首位时短路（不重复落库）', cap.alreadyTop === true && cap.reason === 'already-top',
    `reason=${cap.reason}`);
}
{
  const p = makePage();
  const host = makeHost();
  const { rowEl } = makeRow(p, '447993841729699', host);
  const cap = p.api.topmostCapability(rowEl);
  check('1.3 云端 id（纯数字）fail closed', cap.available === false && cap.reason === 'cloud-not-provable',
    `reason=${cap.reason}`);
}
{
  const p = makePage();
  const host = makeHost({ readOnly: ['mvs_ro'] });
  const { rowEl } = makeRow(p, 'mvs_ro', host);
  const cap = p.api.topmostCapability(rowEl);
  check('1.4 只读会话 fail closed（宿主会静默 return）',
    cap.available === false && cap.reason === 'readonly-session', `reason=${cap.reason}`);
}
{
  const p = makePage();
  const host = makeHost({ source: 'cloud' });
  const { rowEl } = makeRow(p, 'mvs_x', host);
  const cap = p.api.topmostCapability(rowEl);
  check('1.5 非 local 源的 hook 被拒绝', cap.available === false && cap.reason === 'source-not-local:cloud',
    `reason=${cap.reason}`);
}
{
  const p = makePage();
  const rowEl = p.dom.el('div', { 'data-session-id': 'mvs_none' });
  p.dom.root.appendChild(rowEl);
  const cap = p.api.topmostCapability(rowEl);
  check('1.6 没有 fiber 时 fail closed', cap.available === false && cap.reason === 'no-fiber-root',
    `reason=${cap.reason}`);
}
{
  // Two matching hooks in the tree: refuse rather than pick one.
  const p = makePage();
  const host = makeHost();
  const { rowEl, container } = makeRow(p, 'mvs_amb', host);
  const second = makeHost();
  const chain = hookChain([[host.fn, host.deps]]);
  chain.next = hookChain([[second.fn, second.deps]]);
  container.memoizedState = chain;
  const cap = p.api.topmostCapability(rowEl);
  check('1.7 多个候选时 fail closed', cap.available === false && cap.reason === 'ambiguous-handle-pin-session',
    `reason=${cap.reason} matches=${cap.matches}`);
  check('1.7 报告里带上了候选数', cap.matches === 2, `matches=${cap.matches}`);
}
{
  // The expando points at the STALE half, exactly as it does after a re-render.
  // The two halves carry different callbacks AND different order arrays, so
  // reading the wrong one is observable in both directions.
  const p = makePage();
  const live = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const staleHost = makeHost({ order: [ref('mvs_b'), ref('mvs_a'), ref('mvs_c')] });
  const { rowEl } = makeRow(p, 'mvs_b', live, { stale: true, staleHost });
  const cap = p.api.topmostCapability(rowEl);
  check('1.8 expando 指向陈旧半边时仍然解析成功', cap.available === true, `reason=${cap.reason}`);
  check('1.8 用的是当前半边的顺序数组（stale 说 B 在首位，live 说不是）',
    cap.orderFirst === 'session:mvs_a' && cap.alreadyTop === false,
    `first=${cap.orderFirst} alreadyTop=${cap.alreadyTop}`);
  check('1.8 前置条件：两半边的数组确实不同',
    JSON.stringify(live.order) !== JSON.stringify(staleHost.order));
  check('1.8 前置条件：陈旧半边自称 B 在首位',
    staleHost.order[0].id === 'mvs_b' && live.order[0].id !== 'mvs_b');
}
{
  // The reverse direction: live says B IS first, stale says it is not. Reading
  // the stale half would have written a redundant pinSession and then setOrder'd
  // an order array built from the old snapshot.
  const p = makePage();
  const live = makeHost({ order: [ref('mvs_b'), ref('mvs_a'), ref('mvs_c')] });
  const staleHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_b', live, { stale: true, staleHost });
  const cap = p.api.topmostCapability(rowEl);
  check('1.9 反向：当前半边说已在首位时判定为 no-op', cap.alreadyTop === true,
    `alreadyTop=${cap.alreadyTop}`);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  clickTop(ul);
  await flush();
  check('1.9 因此不产生任何落库（不会被陈旧半边骗去重复写）',
    live.calls.length === 0 && staleHost.calls.length === 0 && p.api.state.noops === 1,
    `live=${live.calls.length} stale=${staleHost.calls.length} noops=${p.api.state.noops}`);
}
{
  // A fiber tree we cannot place in a root is not a capability we can prove.
  const p = makePage();
  const host = makeHost();
  const rowEl = p.dom.el('div', { 'data-session-id': 'mvs_orphan' });
  p.dom.root.appendChild(rowEl);
  const orphan = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain([[host.fn, host.deps]]), parent: null });
  const orphanRow = fiber({ tag: 5, name: 'div', props: { 'data-session-id': 'mvs_orphan' }, hooks: null, parent: orphan });
  attachFiber(rowEl, orphanRow);
  const cap = p.api.topmostCapability(rowEl);
  check('1.10 无法定位 HostRoot 时 fail closed', cap.available === false && cap.reason === 'no-fiber-root',
    `reason=${cap.reason}`);
  check('1.10 而不是盲信 expando 给的那一半', !cap.orderFirst && !cap.alreadyTop);
}
{
  // A tree whose halves cannot be told apart is refused rather than guessed at.
  const p = makePage();
  const host = makeHost();
  const { rowEl } = makeRow(p, 'mvs_unproven', host);
  // Break the proof: the chain now ends at a fiber that is neither half of
  // this root (a detached tree, or a build whose root cannot be identified).
  const container = rowEl[Object.keys(rowEl).find(function (k) { return k.indexOf('__reactFiber') === 0; })].return.return;
  container.return = fiber({ tag: 3, name: 'UnknownRoot', props: null, hooks: null, parent: null });
  const cap = p.api.topmostCapability(rowEl);
  check('1.11 两半无法区分时 fail closed', cap.available === false, `reason=${cap.reason}`);
}
{
  // Same shape, different function: must not be mistaken for the pin hook.
  const p = makePage();
  const host = makeHost();
  const { rowEl } = makeRow(p, 'mvs_dec', host, { hoverAbove: true });
  const cap = p.api.topmostCapability(rowEl);
  check('2.5 同形诱饵（deps6 / 无 getSessionInfo）不会被误认', cap.available === true,
    `reason=${cap.reason}`);
  const wrong = p.api.looksLikeHandlePin({ memoizedState: [makeHoverDecoy(host.order).fn, makeHoverDecoy(host.order).deps] });
  check('2.5 诱饵本身被选择器拒绝', wrong === false);
  const arity2 = { memoizedState: [function (a, b) { return a; }, host.deps] };
  check('2.5 两参回调被拒绝', p.api.looksLikeHandlePin(arity2) === false);
  const sixDeps = { memoizedState: [function (a, b, c) { return a + b + c; }, host.deps.slice(0, 6)] };
  check('2.5 六参依赖的回调被拒绝', p.api.looksLikeHandlePin(sixDeps) === false);
  const noDeps = { memoizedState: [host.fn] };
  check('2.5 不是 [fn,deps] 形状的 hook 被拒绝', p.api.looksLikeHandlePin(noDeps) === false);
}

  // ---------------------------------------------------------------------------
console.log('\n=== 2. 菜单注入：绑定到本次右键的那一个菜单 ===');
{
  const p = makePage();
  const host = makeHost();
  const { rowEl, dropdown } = makeRow(p, 'mvs_menu', host);
  const { ul, hostItem } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const items = ul.querySelectorAll('li[data-mmx-topmost]');
  check('3.1 注入了一项', items.length === 1, `items=${items.length}`);
  check('3.1 追加在宿主原有项之后（不替换）',
    ul.children[ul.children.length - 1] === items[0], `children=${ul.children.length}`);
  check('3.1 宿主原菜单项仍在且仍可点', ul.children[0] === hostItem);
  hostItem.dispatch('click', { isTrusted: true });
  check('3.1 宿主原项的监听没有被摘掉', (p.dom.root.querySelector('.ant-dropdown-menu-item').listenerCount('click')) === 1);
  check('3.1 标签就是 到最顶', items[0] && items[0].textContent === '到最顶', items[0] && items[0].textContent);
  check('3.1 菜单项挂在 ant-dropdown-menu-item 上（沿用宿主样式）',
    !!items[0] && items[0].className.indexOf('ant-dropdown-menu-item') >= 0 &&
    !!items[0].querySelector('.matrix-menu-item'));
  check('3.1 注入计数可见', p.api.state.injected === 1);
}
{
  // Another row's menu is open; ours must not be injected into it.
  const p = makePage();
  const host = makeHost();
  const mine = makeRow(p, 'mvs_mine', host);
  const other = makeRow(p, 'mvs_other', host);
  const otherMenu = openMenu(p, other.dropdown);
  p.api.onContextMenu({ target: mine.rowEl, isTrusted: true });
  for (let i = 0; i < 4; i++) p.timers.run();
  check('4.2 别的行的菜单不被注入', otherMenu.ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `items=${otherMenu.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('4.2 找不到归属菜单时如实上报', p.api.state.lastReason === 'menu-not-found',
    `reason=${p.api.state.lastReason}`);
  check('4.2 重试次数有界（不无限轮询）', p.api.pendingTimers() === 0, `pending=${p.api.pendingTimers()}`);
}
{
  // The copy submenu is a real menu with the same markup.
  const p = makePage();
  const host = makeHost();
  const { rowEl, dropdown } = makeRow(p, 'mvs_copy', host);
  const sub = openMenu(p, dropdown, { submenu: true });
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  for (let i = 0; i < 4; i++) p.timers.run();
  check('4.3 复制子菜单不被注入', sub.ul.querySelectorAll('li[data-mmx-topmost]').length === 0);
}
{
  // A popup with no host items is not a menu we should touch.
  const p = makePage();
  const host = makeHost();
  const { rowEl, dropdown } = makeRow(p, 'mvs_empty', host);
  const ul = p.dom.el('ul', { class: 'ant-dropdown-menu' });
  const list = fiber({ name: 'MenuList', props: {}, hooks: null, parent: dropdown });
  attachFiber(ul, fiber({ tag: 5, name: 'ul', props: {}, hooks: null, parent: list }));
  p.dom.root.appendChild(ul);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  for (let i = 0; i < 4; i++) p.timers.run();
  check('4.4 空菜单不被注入', ul.querySelectorAll('li[data-mmx-topmost]').length === 0);
}
{
  // Repeat open/switch: never more than one item, never a pile up.
  const p = makePage();
  const host = makeHost();
  const { rowEl, dropdown } = makeRow(p, 'mvs_rep', host);
  const { ul } = openMenu(p, dropdown);
  for (let i = 0; i < 20; i++) {
    p.api.onContextMenu({ target: rowEl, isTrusted: true });
    p.timers.run();
  }
  check('4.5 反复开合菜单只有一项', ul.querySelectorAll('li[data-mmx-topmost]').length === 1,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('4.5 计数始终为 1', p.api.state.injected === 1);
  p.api.clearTopmostItems();
  check('4.5 清理后菜单里没有残留', ul.querySelectorAll('li[data-mmx-topmost]').length === 0);
  check('4.5 清理后计数归零', p.api.state.injected === 0);
}
{
  // The host unmounts the popup on close: the item goes with it and the
  // reported count has to come back down on its own.
  const p = makePage();
  const host = makeHost();
  const { rowEl, dropdown } = makeRow(p, 'mvs_close', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  check('4.6 关闭前计数为 1', p.api.state.injected === 1);
  ul.remove();
  p.api.reapTopmost();
  check('4.6 菜单被宿主卸载后计数自动归零', p.api.state.injected === 0);
}
{
  // Fail closed: no capability means a visibly disabled item, not a live one.
  const p = makePage();
  const { rowEl, dropdown } = makeRow(p, 'mvs_fail', { fn: () => {}, deps: [] });
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  check('4.7 能力不足时注入的是禁用项', !!item && item.getAttribute('aria-disabled') === 'true',
    item ? item.getAttribute('aria-disabled') : '(no item)');
  check('4.7 禁用项带中文原因（不是内部错误码）',
    /当前宿主版本不支持置顶排序/.test(item.textContent) && !/no-handle-pin-session/.test(item.textContent),
    item.textContent);
  check('4.7 机器码仍保留在只读 API 里（运维可查）',
    /no-handle-pin-session|no-fiber-root|ambiguous/.test(p.api.state.lastReason),
    p.api.state.lastReason);
  item.dispatch('click', { isTrusted: true });
  check('4.7 禁用项点了没有任何调用', p.api.state.calls === 0 && p.api.state.clicks === 0,
    `calls=${p.api.state.calls} clicks=${p.api.state.clicks}`);
}

  // ---------------------------------------------------------------------------
console.log('\n=== 3. 点击：真实语义是 (id, true, 0) ===');
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c'), ref('mvs_d')] });
  const { rowEl, dropdown, container } = makeRow(p, 'mvs_d', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  item.dispatch('click', { isTrusted: true });
  await flush();
  check('5.1 传给宿主的正是三个实参 (id, true, 0)',
    JSON.stringify(host.calls[0]) === JSON.stringify(['mvs_d', true, 0]), JSON.stringify(host.calls[0]));
  check('5.1 落库调用同样带 0（不是 undefined）',
    JSON.stringify(host.persists[0]) === JSON.stringify(['mvs_d', true, 0]), JSON.stringify(host.persists[0]));
  check('5.1 到最顶：id 落到 order[0]', host.order[0].id === 'mvs_d', JSON.stringify(host.order));
  check('5.1 同一 id 在数组里只出现一次', host.order.filter((r) => r.id === 'mvs_d').length === 1);
  check('5.1 其余项相对序不变',
    JSON.stringify(host.order.slice(1).map((r) => r.id)) === JSON.stringify(['mvs_a', 'mvs_b', 'mvs_c']),
    JSON.stringify(host.order.map((r) => r.id)));
  check('5.1 本项目没有改写宿主的数组对象（由宿主自己 set）', p.api.state.calls === 1);
  check('5.1 没有任何 props 两参 wrapper 被调用', (rowEl.__propsCalls || 0) === 0);
  void container;
}
{
  // Already on top: no second call, no second write, no second toast.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_a', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  clickTop(ul);
  await flush();
  check('5.2 已在首位：no-op，不落库', host.calls.length === 0 && p.api.state.noops === 1,
    `calls=${host.calls.length} noops=${p.api.state.noops}`);
  check('5.2 数组未被动过', JSON.stringify(host.order.map((r) => r.id)) === JSON.stringify(['mvs_a', 'mvs_b']));
}
{
  // The host rolls its own array back on failure. We report nothing as success.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')], fail: true });
  const { rowEl, dropdown } = makeRow(p, 'mvs_b', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  clickTop(ul);
  await flush();
  check('5.3 失败由宿主自己回滚，本项目不宣告成功',
    host.rollbacks === 1 && /host-returned|host-rejected|calling/.test(p.api.state.lastReason),
    `rollbacks=${host.rollbacks} reason=${p.api.state.lastReason}`);
  check('5.3 不会把 promise 兑现当成成功上报', !/success/i.test(p.api.state.lastReason),
    `reason=${p.api.state.lastReason}`);
  check('5.3 busy 一定被释放', p.api.state.busy === false);
}

  // ---------------------------------------------------------------------------
console.log('\n=== 4. 竞态与生命周期防护 ===');
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  item.dispatch('click', { isTrusted: true });   // in flight
  item.dispatch('click', { isTrusted: true });   // second click while busy
  // Sampled before the in-flight promise settles: afterwards the first call's
  // own bookkeeping would legitimately have overwritten it.
  const reasonWhileBusy = p.api.state.lastReason;
  await flush();
  check('6.3 并发点击只放行一次', host.calls.length === 1, `calls=${host.calls.length}`);
  check('6.3 第二次被记为 blocked', p.api.state.blocked === 1, `blocked=${p.api.state.blocked}`);
  check('6.3 第二次的原因可读', reasonWhileBusy === 'busy', `reason=${reasonWhileBusy}`);
  check('6.3 busy 在宿主回调兑现后释放', p.api.state.busy === false);
}
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  // A synthetic click is a probe, not the user. Only isTrusted acts.
  item.dispatch('click', { isTrusted: false });
  await flush();
  check('6.1 合成点击不触发置顶', host.calls.length === 0 && p.api.state.blocked === 1,
    `calls=${host.calls.length}`);
  check('6.1 合成点击的原因可读', p.api.state.lastReason === 'untrusted-click', p.api.state.lastReason);
  p.api.onContextMenu({ target: rowEl, isTrusted: false });
  p.timers.run();
  check('6.1 合成的右键也不注入', ul.querySelectorAll('li[data-mmx-topmost]').length === 0);
}
{
  // Row unmounted between the menu opening and the click (view switch,
  // virtualised scroll): must never end up pinning whatever took its place.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const mine = makeRow(p, 'mvs_c', host);
  const { ul } = openMenu(p, mine.dropdown);
  p.api.onContextMenu({ target: mine.rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  mine.rowEl.remove();
  const replacement = makeRow(p, 'mvs_c2', host);   // another session takes the slot
  void replacement;
  item.dispatch('click', { isTrusted: true });
  await flush();
  check('6.2 行已卸载时拒绝调用', host.calls.length === 0, `calls=${host.calls.length}`);
  check('6.2 不会去置顶别的会话', host.persists.length === 0);
  check('6.2 原因可读', p.api.state.lastReason === 'row-gone', p.api.state.lastReason);
}
{
  // The popup itself is gone (the user clicked away) before our click.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  ul.remove();
  item.dispatch('click', { isTrusted: true });
  await flush();
  check('6.4 菜单已卸载时拒绝调用', host.calls.length === 0 && p.api.state.lastReason === 'menu-gone',
    `calls=${host.calls.length} reason=${p.api.state.lastReason}`);
}
{
  // Re-render between two clicks: the second must resolve the NEW hook, not the
  // one captured when the menu opened.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown, container } = makeRow(p, 'mvs_c', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  // The host re-renders: a brand new closure over a brand new order array.
  const host2 = makeHost({ order: host.order.map((r) => ({ ...r })) });
  const fresh = hookChain([[host2.fn, host2.deps]]);
  const dd = container.memoizedState;
  void dd;
  container.memoizedState = fresh;
  item.dispatch('click', { isTrusted: true });
  await flush();
  check('6.5 每次点击都重新解析（不缓存旧闭包）', host.calls.length === 0 && host2.calls.length === 1,
    `old=${host.calls.length} new=${host2.calls.length}`);
  check('6.5 新闭包拿到的正是新数组', host2.order[0].id === 'mvs_c', JSON.stringify(host2.order));
}
{
  // After dispose() the page must be inert: no late injection, no late call.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
  const { ul } = openMenu(p, dropdown);
  p.api.setDisposed(true);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  check('6.6 dispose 后不再注入', ul.querySelectorAll('li[data-mmx-topmost]').length === 0);
  p.api.clearTopmostItems();
  check('6.6 dispose 路径可清空已注入项', p.api.state.injected === 0);
}
{
  // Bounded retries: the timers array must not grow without limit.
  const p = makePage();
  const host = makeHost();
  const { rowEl } = makeRow(p, 'mvs_nomenu', host);
  for (let i = 0; i < 50; i++) {
    p.api.onContextMenu({ target: rowEl, isTrusted: true });
    p.timers.run();
  }
  // The retry chain is bounded, so at most one open window's worth of timers
  // can ever be outstanding -- it does not grow with the number of clicks.
  check('6.7 反复右键不积压定时器（重试有界）', p.api.pendingTimers() <= 2,
    `pending=${p.api.pendingTimers()}`);
  for (let i = 0; i < 4; i++) p.timers.run();
  check('6.7 重试链跑完后定时器清零', p.api.pendingTimers() === 0, `pending=${p.api.pendingTimers()}`);
  check('6.7 反复右键不产生注入', p.api.state.injected === 0);
}


  // ---------------------------------------------------------------------------
  // Section 7 came out of review, not out of a bug report: the first version of
  // this suite passed with a fiber tree shaped the way it was convenient to
  // shape, and the real host's tree is the other way round.
  // ---------------------------------------------------------------------------
console.log('\n=== 7. 真实拓扑：菜单 dropdown 是行的【子】孙，不是祖先 ===');
{
  const p = makePage();
  const host = makeHost();
  const { rowEl, dropdown, hoverDropdown, rowComponent } = makeRow(p, 'mvs_topo', host);
  check('7.1 前置条件：行组件自己的 props 里没有 menu（宿主就是这样）',
    !rowComponent.memoizedProps.menu, JSON.stringify(Object.keys(rowComponent.memoizedProps)));
  check('7.1 前置条件：hover 菜单也带 menu 但没有 trigger',
    Array.isArray(hoverDropdown.memoizedProps.menu) && !hoverDropdown.memoizedProps.trigger);
  const found = p.api.rowMenuFiber(rowEl);
  check('7.1 找到的是 contextMenu 那个 dropdown', found === dropdown,
    found ? (found === hoverDropdown ? 'WRONG: hover 菜单' : 'ok') : '(none)');
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  check('7.2 真实拓扑下菜单项注入成功', ul.querySelectorAll('li[data-mmx-topmost]').length === 1,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length} reason=${p.api.state.lastReason}`);
}
{
  // Two contextMenu dropdowns inside one row: we cannot tell which popup the
  // user is looking at, so nothing is injected.
  const p = makePage();
  const host = makeHost();
  const { rowEl, dropdown } = makeRow(p, 'mvs_two', host);
  // Remove the anchor so rowMenuFiber has to fall back to its subtree walk, which
  // is the path where two candidates have to be told apart.
  const anchorKey = Object.keys(rowEl).find(function (k) { return k.indexOf('__reactFiber') === 0; });
  void anchorKey;
  rowEl.querySelector('[data-shortcut-session-target]').remove();
  const twin = fiber({
    name: 'Dropdown',
    props: { menu: [{ key: 'rename' }], trigger: ['contextMenu'], open: false, onOpenChange() {} },
    hooks: null,
    parent: dropdown.return,
  });
  dropdown.sibling = twin;
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  for (let i = 0; i < 4; i++) p.timers.run();
  check('7.3 同一行出现两个右键菜单时 fail closed', ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length}`);
}
{
  // The hover "..." menu must never be treated as the row's right-click menu,
  // and its popup must never receive the item.
  const p = makePage();
  const host = makeHost();
  const { rowEl, hoverDropdown } = makeRow(p, 'mvs_hover', host);
  const { ul } = openMenu(p, hoverDropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  for (let i = 0; i < 4; i++) p.timers.run();
  check('7.4 hover「…」菜单不被注入', ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length}`);
}
{
  // The popup is bound by fiber identity, so another row's open menu is not a
  // candidate even when it is the only menu on screen.
  const p = makePage();
  const host = makeHost();
  const mine = makeRow(p, 'mvs_mine2', host);
  const other = makeRow(p, 'mvs_other2', host);
  const otherMenu = openMenu(p, other.dropdown);
  p.api.onContextMenu({ target: mine.rowEl, isTrusted: true });
  for (let i = 0; i < 4; i++) p.timers.run();
  check('7.5 别的行的菜单不被注入（fiber 身份绑定）',
    otherMenu.ul.querySelectorAll('li[data-mmx-topmost]').length === 0);
}

  // ---------------------------------------------------------------------------
console.log('\n=== 8. 键盘可达 + 菜单关闭 ===');
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const opts = {};
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host, opts);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  check('8.1 菜单项可被 Tab 聚焦（带 tabindex）', item.getAttribute('tabindex') === '0',
    `tabindex=${item.getAttribute('tabindex')}`);
  check('8.1 语义角色是 menuitem', item.getAttribute('role') === 'menuitem');
  // Enter and Space are what a menu item answers to.
  item.dispatch('keydown', { isTrusted: true, key: 'Enter' });
  await flush();
  check('8.2 Enter 能激活', host.calls.length === 1, `calls=${host.calls.length}`);
  check('8.2 激活走的仍是三参 (id, true, 0)',
    JSON.stringify(host.calls[0]) === JSON.stringify(['mvs_c', true, 0]), JSON.stringify(host.calls[0]));
}
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  item.dispatch('keydown', { isTrusted: true, key: 'a' });
  item.dispatch('keydown', { isTrusted: true, key: 'ArrowDown' });
  await flush();
  check('8.3 其它按键不触发', host.calls.length === 0, `calls=${host.calls.length}`);
  // A synthetic keydown must not be able to pin anything either.
  item.dispatch('keydown', { isTrusted: false, key: 'Enter' });
  await flush();
  check('8.3 合成按键不触发', host.calls.length === 0 && p.api.state.blocked >= 0,
    `calls=${host.calls.length}`);
  item.dispatch('keydown', { isTrusted: true, key: ' ' });
  await flush();
  check('8.3 空格能激活', host.calls.length === 1, `calls=${host.calls.length}`);
}
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const opts = {};
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host, opts);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  clickTop(ul);
  await flush();
  check('8.4 点击后调用宿主的关闭回调（onOpenChange(false)）',
    JSON.stringify(opts.openChanges) === JSON.stringify([false]), JSON.stringify(opts.openChanges));
  check('8.4 不点宿主的任何菜单项（避免误跑 pin/delete/archive）',
    (opts.propsCalls || 0) === 0, `propsCalls=${opts.propsCalls}`);
  check('8.4 关闭方式被记录下来', p.api.state.lastClose === 'menu-closed', p.api.state.lastClose);
}
{
  // A dropdown without a usable onOpenChange: the menu is left open and that is
  // reported, rather than faked with a synthetic click or hidden by us.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
  dropdown.memoizedProps.onOpenChange = undefined;
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  clickTop(ul);
  await flush();
  check('8.5 没有关闭回调时如实上报', p.api.state.lastClose === 'menu-close-unavailable',
    p.api.state.lastClose);
  check('8.5 置顶动作本身照常发生', host.calls.length === 1, `calls=${host.calls.length}`);
  check('8.5 宿主菜单节点没有被我们动过', ul.isConnected);
}
{
  // Closing the host's own items is not our business: the host closes them
  // itself when one of ITS items is activated.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const opts = {};
  const { rowEl, dropdown } = makeRow(p, 'mvs_c', host, opts);
  const { ul, hostItem } = openMenu(p, dropdown);
  hostItem.dispatch('click', { isTrusted: true });
  check('8.6 宿主自己的项仍可点且不经过我们',
    (opts.propsCalls || 0) === 0 && (opts.openChanges || []).length === 0,
    `propsCalls=${opts.propsCalls} openChanges=${JSON.stringify(opts.openChanges)}`);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  check('8.6 宿主项与我们的项并存', ul.children.length === 2, `children=${ul.children.length}`);
}

  // ---------------------------------------------------------------------------
console.log('\n=== 9. 禁用项只说中文话 ===');
{
  const p = makePage();
  const cases = [
    ['no-handle-pin-session', '当前宿主版本不支持置顶排序'],
    ['ambiguous-handle-pin-session', '宿主置顶回调不唯一，已停用'],
    ['readonly-session', '该会话只读，无法置顶'],
    ['cloud-not-provable', '云端会话暂不支持置顶排序'],
    ['no-fiber-root', '无法确认宿主当前渲染树，已停用'],
    ['unproven-fiber-tree', '无法确认宿主当前渲染树，已停用'],
  ];
  for (const [code, text] of cases) {
    check(`9.1 ${code} -> 中文`, p.api.topmostReasonText(code) === text, p.api.topmostReasonText(code));
  }
  check('9.2 source-not-local:cloud -> 中文',
    p.api.topmostReasonText('source-not-local:cloud') === '非本地视图，暂不支持置顶排序',
    p.api.topmostReasonText('source-not-local:cloud'));
  check('9.3 未知码也回落到通用中文（不把内部码露给用户）',
    p.api.topmostReasonText('some-internal-code-9000') === '当前宿主版本不支持置顶排序',
    p.api.topmostReasonText('some-internal-code-9000'));
  check('9.3 未知码不会原样返回', p.api.topmostReasonText('weird') !== 'weird');
}

  // ---------------------------------------------------------------------------
console.log('\n=== 10. 键盘：Space 要 preventDefault，Enter 不要，其余一律不碰 ===');
{
  // The listener is on this one node. Nothing global is captured, and no key
  // other than Enter/Space reaches the handler -- so Escape still belongs to
  // the host's rc-menu and still closes its menu.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_space', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  if (item !== MISSING_ITEM) {
    let prevented = 0, stopped = 0;
    const press = (key) => item.dispatch('keydown', {
      isTrusted: true, key, target: item,
      preventDefault() { prevented++; },
      stopPropagation() { stopped++; },
    });
    press(' ');
    await flush();
    check('10.1 Space 激活了宿主回调（显式三参）',
      host.calls.length === 1 && host.persists.length === 1 &&
      host.persists[0][0] === 'mvs_space' && host.persists[0][1] === true && host.persists[0][2] === 0,
      `calls=${JSON.stringify(host.calls)} persists=${JSON.stringify(host.persists)}`);
    check('10.1 Space 调用了 preventDefault（否则侧边栏会跟着滚）', prevented === 1, `prevented=${prevented}`);
    check('10.1 没有 stopPropagation（不抢宿主的键盘）', stopped === 0, `stopped=${stopped}`);
  }
}
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_enter', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  if (item !== MISSING_ITEM) {
    let prevented = 0, stopped = 0;
    item.dispatch('keydown', {
      isTrusted: true, key: 'Enter', target: item,
      preventDefault() { prevented++; },
      stopPropagation() { stopped++; },
    });
    await flush();
    check('10.2 Enter 激活了宿主回调', host.calls.length === 1, `calls=${host.calls.length}`);
    check('10.2 Enter 不调用 preventDefault（它没有默认滚动行为）', prevented === 0, `prevented=${prevented}`);
    check('10.2 Enter 也不 stopPropagation', stopped === 0, `stopped=${stopped}`);
  }
}
{
  // Spacebar is the legacy IE/Edge name for the same key; a host build (or an
  // automation tool) that reports it must get the same treatment as ' '.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_spacebar', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  if (item !== MISSING_ITEM) {
    let prevented = 0;
    item.dispatch('keydown', { isTrusted: true, key: 'Spacebar', target: item, preventDefault() { prevented++; } });
    await flush();
    check('10.3 旧键名 Spacebar 与空格同等待遇',
      host.calls.length === 1 && prevented === 1, `calls=${host.calls.length} prevented=${prevented}`);
  }
}
{
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_esc', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  if (item !== MISSING_ITEM) {
    const before = p.api.state.lastReason;
    let prevented = 0, stopped = 0;
    for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Tab', 'a', 'Shift']) {
      item.dispatch('keydown', {
        isTrusted: true, key, target: item,
        preventDefault() { prevented++; },
        stopPropagation() { stopped++; },
      });
    }
    check('10.4 非 Enter/Space 的键一个都不激活', host.calls.length === 0, `calls=${host.calls.length}`);
    check('10.4 非 Enter/Space 的键连理由都不改（没有进到激活逻辑）',
      p.api.state.lastReason === before, `reason=${p.api.state.lastReason}`);
    check('10.4 非 Enter/Space 的键既不 preventDefault 也不 stopPropagation',
      prevented === 0 && stopped === 0, `prevented=${prevented} stopped=${stopped}`);
  }
}
{
  // A dispatched KeyboardEvent is isTrusted=false even when the script builds
  // it to look real, and a synthetic Space has no default action to suppress,
  // so the trusted guard comes first and nothing at all is counted.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_syn', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  if (item !== MISSING_ITEM) {
    const before = { clicks: p.api.state.clicks, blocked: p.api.state.blocked };
    let prevented = 0;
    for (const key of ['Enter', ' ', 'Spacebar']) {
      item.dispatch('keydown', { isTrusted: false, key, target: item, preventDefault() { prevented++; } });
    }
    check('10.5 合成按键一次都没有置顶', host.calls.length === 0 && host.persists.length === 0,
      JSON.stringify(host.persists));
    check('10.5 合成按键连计数都不改变（连 blocked 都不加）',
      p.api.state.clicks === before.clicks && p.api.state.blocked === before.blocked,
      `clicks=${p.api.state.clicks} blocked=${p.api.state.blocked}`);
    check('10.5 合成按键也不 preventDefault', prevented === 0, `prevented=${prevented}`);
  }
}
{
  // KNOWN LIMITATION, recorded so a later change cannot make it worse silently:
  // rc-menu owns the roving tabindex and the arrow handling, and it only knows
  // about the items it rendered. An appended li is not in that set, so
  // ArrowDown/ArrowUp step over 到最顶. Tab does reach it. This is Tab
  // reachability, NOT arrow parity, and README 15.8 says so.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_arrow', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  if (item !== MISSING_ITEM) {
    check('10.6 Tab 可达的前提是 tabindex=0', item.getAttribute('tabindex') === '0',
      `tabindex=${item.getAttribute('tabindex')}`);
    item.dispatch('keydown', { isTrusted: true, key: 'ArrowDown', target: item, preventDefault() {} });
    item.dispatch('keydown', { isTrusted: true, key: 'ArrowUp', target: item, preventDefault() {} });
    check('10.6 方向键不误触发置顶（rc-menu 不认识这个 li）', host.calls.length === 0,
      `calls=${host.calls.length}`);
    check('10.6 方向键不会改变本项的 tabindex（我们不接管漫游）',
      item.getAttribute('tabindex') === '0', `tabindex=${item.getAttribute('tabindex')}`);
  }
}

  // ---------------------------------------------------------------------------
console.log('\n=== 11. 代次：换目标后旧的重试链必须失效 ===');
{
  // Isolating the second gate. The harness pulls the first attempt's callback
  // out of its own queue first, so the shipped clearTimeout has nothing left
  // to cancel; cancellation therefore cannot be what makes this test pass, and
  // the only thing standing between the superseded chain and an injection is
  // the generation comparison. This is a test-harness device, not a statement
  // that the browser cannot cancel a queued timer -- it can.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const a = makeRow(p, 'mvs_A', host);
  const b = makeRow(p, 'mvs_B', host);
  const menuA = openMenu(p, a.dropdown);
  const menuB = openMenu(p, b.dropdown);

  p.api.onContextMenu({ target: a.rowEl, isTrusted: true });
  const genA = p.api.generation();
  const [tid] = p.timers.ids();
  const dequeued = p.timers.take(tid);
  check('11.1 前置条件：取到一条待跑的回调', !!dequeued, `id=${tid}`);
  check('11.1 前置条件：它已不在队列里，本次 clearTimeout 够不着它',
    !!dequeued && p.timers.ids().indexOf(tid) < 0, JSON.stringify(p.timers.ids()));

  // The user right clicks another row while the first chain's first attempt is
  // already dequeued. Both rows stay connected -- nothing was unmounted.
  p.api.onContextMenu({ target: b.rowEl, isTrusted: true });
  check('11.1 新链使代次前进', p.api.generation() > genA,
    `${genA} -> ${p.api.generation()}`);

  // Now the old, un-cancellable callback finally runs.
  dequeued.fire();
  check('11.1 旧链回调不往已过期的菜单里注入',
    menuA.ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `inA=${menuA.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  p.timers.run();
  check('11.1 旧链之后的重试也一并失效（不会在第二次尝试里复活）',
    menuA.ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `inA=${menuA.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('11.1 只有新目标的菜单拿到了一项',
    menuB.ul.querySelectorAll('li[data-mmx-topmost]').length === 1,
    `inB=${menuB.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('11.1 injected 记账与屏幕上真实项数一致',
    p.api.state.injected === 1, `injected=${p.api.state.injected}`);
}
{
  // The ordinary half: a new right click also cancels what is still pending,
  // so the superseded chain does not even get a second attempt.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const a = makeRow(p, 'mvs_A2', host);
  const b = makeRow(p, 'mvs_B2', host);
  const menuA = openMenu(p, a.dropdown);
  const menuB = openMenu(p, b.dropdown);
  p.api.onContextMenu({ target: a.rowEl, isTrusted: true });
  const [oldTid] = p.timers.ids();
  const before = p.timers.size();
  p.api.onContextMenu({ target: b.rowEl, isTrusted: true });
  const ids = p.timers.ids();
  check('11.2 换目标时未跑的定时器被清掉（旧链那条不在队列里了）',
    ids.indexOf(oldTid) < 0, `before=${before} after=${JSON.stringify(ids)}`);
  check('11.2 只剩新链自己的那一条（不叠加）',
    ids.length === 1 && ids[0] !== oldTid, JSON.stringify(ids));
  for (let i = 0; i < 4; i++) p.timers.run();
  check('11.2 过期链一个项都没注入', menuA.ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `inA=${menuA.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('11.2 当前链正常注入', menuB.ul.querySelectorAll('li[data-mmx-topmost]').length === 1,
    `inB=${menuB.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('11.2 重试窗口仍然有界（不无限轮询）', p.api.pendingTimers() === 0,
    `pending=${p.api.pendingTimers()}`);
}
{
  // One DOM node, a different session: still connected, different identity.
  // Re-reading the attribute inside the attempt would retarget the chain at
  // whatever the host put there in the meantime.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_before', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  const [tid] = p.timers.ids();
  const dequeued = p.timers.take(tid);
  // The host recycles the very same node for another session.
  rowEl.setAttribute('data-session-id', 'mvs_after');
  dequeued.fire();
  check('11.3 同一个 DOM 换成别的会话后不注入',
    ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('11.3 理由如实写明是换了身份', p.api.state.lastReason === 'row-retargeted',
    `reason=${p.api.state.lastReason}`);
  check('11.3 前置条件：节点始终是 connected 的', rowEl.isConnected);
}
{
  // dispose invalidates the generation too, as the second gate. The
  // clearTimeout loop above it is untouched, and the harness has already
  // pulled this callback out of the queue, so what is left to stop the
  // injection is the bump.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_dispose', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  const [tid] = p.timers.ids();
  const dequeued = p.timers.take(tid);
  const genBefore = p.api.generation();
  p.api.disposeTopmost();
  check('11.4 dispose 使代次前进', p.api.generation() > genBefore,
    `${genBefore} -> ${p.api.generation()}`);
  dequeued.fire();
  check('11.4 dispose 之后已取出的回调不会再注入',
    ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('11.4 dispose 之后计数归零', p.api.state.injected === 0, `injected=${p.api.state.injected}`);
}

  // ---------------------------------------------------------------------------
console.log('\n=== 12. 可见性：不得注入到用户看不见的浮层 ===');
{
  // rc-trigger keeps a closed overlay mounted while its close motion runs, and
  // antd caches the node after that: no client rects, but the node, its items
  // and its fibers are all still there, and it is still owned by this row's
  // dropdown. Injecting there produces an item nobody will ever look at while
  // injected reports 1.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_hidden', host);
  const { ul } = openMenu(p, dropdown);
  ul.__hidden = true;
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  for (let i = 0; i < 4; i++) p.timers.run();
  check('12.1 不可见的浮层里没有注入',
    ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('12.1 injected 不谎报为 1', p.api.state.injected === 0, `injected=${p.api.state.injected}`);
  check('12.1 找不到可见浮层时如实上报 menu-not-found',
    p.api.state.lastReason === 'menu-not-found', `reason=${p.api.state.lastReason}`);
  check('12.1 重试窗口仍然有界（不会因为跳过就无限轮询）', p.api.pendingTimers() === 0,
    `pending=${p.api.pendingTimers()}`);
}
{
  // Skipping the hidden one must not end the search: the retry keeps looking
  // and finds the VISIBLE popup of the same owner. Two popups, one owner, the
  // hidden one first in document order -- the case a "first match wins" lookup
  // gets wrong.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_mix', host);
  const hidden = openMenu(p, dropdown);
  hidden.ul.__hidden = true;
  const visible = openMenu(p, dropdown);
  check('12.2 前置条件：两个浮层同一个 owner，隐藏的那个在文档顺序前面',
    hidden.ul !== visible.ul && p.dom.root.children.indexOf(hidden.ul) <
    p.dom.root.children.indexOf(visible.ul));
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  check('12.2 隐藏的那个仍然没有项',
    hidden.ul.querySelectorAll('li[data-mmx-topmost]').length === 0,
    `inHidden=${hidden.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('12.2 可见的同 owner 弹层拿到了那唯一一项',
    visible.ul.querySelectorAll('li[data-mmx-topmost]').length === 1,
    `inVisible=${visible.ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('12.2 injected=1 与屏幕上的真实项数一致', p.api.state.injected === 1,
    `injected=${p.api.state.injected}`);
}
{
  // The bookkeeping must not claim a hidden item is something the user can
  // see. The node stays connected inside the cached overlay; only its
  // visibility is gone.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_reap', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  const item = topLi(ul);
  check('12.3 前置条件：注入后 injected=1', p.api.state.injected === 1, `injected=${p.api.state.injected}`);
  // The overlay goes into its close motion: still connected, no client rects.
  ul.__hidden = true;
  p.api.reapTopmost();
  check('12.3 隐藏后 injected 归零（不冒称用户看得见）', p.api.state.injected === 0,
    `injected=${p.api.state.injected}`);
  check('12.3 reap 并不去动宿主浮层的 DOM', ul.isConnected);
}
{
  // Regression guard: one visible popup, the ordinary path, unchanged.
  const p = makePage();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const { rowEl, dropdown } = makeRow(p, 'mvs_ok', host);
  const { ul } = openMenu(p, dropdown);
  p.api.onContextMenu({ target: rowEl, isTrusted: true });
  p.timers.run();
  check('12.4 可见浮层的正常路径照旧注入一项',
    ul.querySelectorAll('li[data-mmx-topmost]').length === 1,
    `items=${ul.querySelectorAll('li[data-mmx-topmost]').length}`);
  check('12.4 正常路径 injected=1', p.api.state.injected === 1, `injected=${p.api.state.injected}`);
  p.api.reapTopmost();
  check('12.4 还可见时 reap 不清零', p.api.state.injected === 1, `injected=${p.api.state.injected}`);
  ul.remove();
  p.api.reapTopmost();
  check('12.4 浮层被卸载后计数归零', p.api.state.injected === 0, `injected=${p.api.state.injected}`);
}



  // ===========================================================================
  // 13-20. The popup side channel (topmostDiagPopup*): what the shipped
  // popupForMenu records about the loop it actually ran.
//
  // Every fixture below drives the REAL sliced popupForMenu. Nothing re-derives a
  // trace. The only thing the harness adds is bookkeeping that makes the shipped
  // reads OBSERVABLE -- a getter per expando read, per memoizedProps read, per
  // alternate read, and a wrapper per closest / querySelector / getClientRects
  // call -- because "the diagnostic added no extra evaluation" cannot be asserted
  // while the shipped reads are invisible. The wrappers only count and forward.
  // ===========================================================================

  // A fiber whose two reads the side channel is allowed to touch are counted.
  // memoizedProps is read exactly once per nearestMenuOwner iteration, and
  // alternate at most once per owner-mismatch candidate, so the recorded sequence
  // doubles as the proof that the walk was not extended and that the pairing
  // check added no walk of its own.
function tFiber(page, props, parent) {
  const f = fiber({ tag: 5, name: 'div', props, hooks: null, parent });
  page.seq++;
  const id = 'f' + page.seq;
  const mp = f.memoizedProps;
  let alt = f.alternate;
  Object.defineProperty(f, 'memoizedProps', {
    get() { page.calls.push('mp:' + id); return mp; }, enumerable: true, configurable: true,
  });
  Object.defineProperty(f, 'alternate', {
    get() { page.calls.push('alt:' + id); return alt; },
    set(v) { alt = v; },                       // the pairing fixtures link halves by hand
    enumerable: true, configurable: true,
  });
  return f;
}
  // The menu fiber: a non-empty menu array in memoizedProps is the ONLY thing
  // nearestMenuOwner looks for.
function tMenuFiber(page) {
  return tFiber(page, { menu: [{ key: 'rename' }, { key: 'pin' }] }, null);
}
  // depth = how many .return hops separate the popup's own fiber from menuFiber.
  // depth 0 is the host's shape (the popup hangs directly off the dropdown);
  // depth 39 is the last legal iteration; depth 40 is one past the cap.
function tPopupChain(page, menuFiber, depth) {
  let cur = menuFiber;
  for (let i = 0; i < depth; i++) cur = tFiber(page, {}, cur);
  return cur;
}
  // A popup ul, wired to whatever fiber chain the caller hands it.
function tPopup(page, opts = {}) {
  const ul = page.dom.el('ul', { class: 'ant-dropdown-menu' });
  page.seq++;
  const id = 'u' + page.seq;
  if (opts.items !== false) {
    ul.appendChild(page.dom.el('li', { class: 'ant-dropdown-menu-item' }, [
      page.dom.el('div', { class: 'matrix-menu-item' }, [page.dom.el('div', {}, ['重命名'])]),
    ]));
  }
  if (opts.hidden) ul.__hidden = true;
  const c0 = ul.closest;
  ul.closest = function (sel) { page.calls.push('closest:' + id); return c0.call(ul, sel); };
  const q0 = ul.querySelector;
  ul.querySelector = function (sel) { page.calls.push('qS:' + id + ':' + sel); return q0.call(ul, sel); };
  const r0 = ul.getClientRects;
  ul.getClientRects = function () { page.calls.push('eiv:' + id); return r0.call(ul); };
  if (opts.chain !== undefined) {
    Object.defineProperty(ul, '__reactFiber$probe', {
      get() { page.calls.push('fib:' + id); return opts.chain; },
      enumerable: true, configurable: true,
    });
  }
  if (opts.inCopyPopup) {
    const box = page.dom.el('div', { class: 'ant-dropdown mavis-sidebar-copy-popup' });
    box.appendChild(ul);
    page.dom.root.appendChild(box);
  } else {
    page.dom.root.appendChild(ul);
  }
  return ul;
}

function popupPage(src) {
  const page = makePage(src);
  page.calls = [];
  page.seq = 0;
  const doc = page.dom.document;
  const qsa0 = doc.querySelectorAll;
  doc.querySelectorAll = function (sel) {
    page.calls.push('qsa:' + sel);
    return qsa0.call(doc, sel);
  };
  return page;
}
  // The RAW trace the shipped popupForMenu just wrote, read out of the slot it
  // wrote it into. Not a return value, not a re-derivation.
const rawTrace = (page) => {
  const env = page.api.diag().popup;
  return env ? env.trace : null;
};
const outcomes = (tr) => (tr.candidates || []).map((c) => c.outcome).join(',');
  // Non-throwing candidate lookup, same discipline as topLi(): a mutation that
  // changes how many candidates reach the table must surface as ordinary FAILs
  // below, not as a TypeError that aborts the run before the rest is exercised.
const MISSING_CAND = {
  i: -1, outcome: 'missing', copy: null, hasItems: null, visible: null,
  ulExpando: null, ownerFound: null, ownerEnd: null, hops: null, ownerCap: null,
  ownerIsAlternateOfMenuFiber: null,
};
const cand = (tr, i) => (tr && tr.candidates && tr.candidates[i]) || MISSING_CAND;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // A popup whose owner chain tops at somebody ELSE's menu fiber: a genuine
  // owner-mismatch, not a simulated one.
const foreignChain = (page, depth) => tPopupChain(page, tMenuFiber(page), depth === undefined ? 2 : depth);

  // ---------------------------------------------------------------------------
console.log('\n=== 13. 四道门：各自只在真实出口记，null 就是"没跑到" ===');
{
  const page = popupPage();
  const mf = tMenuFiber(page);
  tPopup(page, { inCopyPopup: true, chain: tPopupChain(page, mf, 2) });   // 0 copy
  tPopup(page, { items: false, chain: tPopupChain(page, mf, 2) });         // 1 no-items
  tPopup(page, { chain: foreignChain(page) });                            // 2 owner-mismatch
  tPopup(page, { hidden: true, chain: tPopupChain(page, mf, 2) });        // 3 hidden
  const got = page.api.popupForMenu(mf);
  const tr = rawTrace(page);
  check('13.1 没有任何候选被接受，产品返回 null', got === null, String(got));
  check('13.2 loopTotal 与 qsa 到的候选数一致', tr.loopTotal === 4, String(tr.loopTotal));
  check('13.3 scanned 是每个候选一次，不是每个出口一次', tr.scanned === 4, String(tr.scanned));
  check('13.4 四个出口各记一次',
    tr.forkCopy === 1 && tr.forkNoItems === 1 && tr.forkOwner === 1 && tr.forkHidden === 1,
    JSON.stringify([tr.forkCopy, tr.forkNoItems, tr.forkOwner, tr.forkHidden]));
  check('13.5 accepted 为 0 且 returned 为 null',
    tr.accepted === 0 && tr.returned === null, JSON.stringify([tr.accepted, tr.returned]));
  check('13.6 四条明细按候选顺序落表', outcomes(tr) === 'copy,no-items,owner-mismatch,hidden',
    outcomes(tr));
  check('13.7 copy 候选：copy=true，另两道门是 null',
    cand(tr, 0).copy === true && cand(tr, 0).hasItems === null && cand(tr, 0).visible === null,
    JSON.stringify(cand(tr, 0)));
  check('13.8 no-items 候选：copy/hasItems 都是跑出来的 false，visible 是 null',
    cand(tr, 1).copy === false && cand(tr, 1).hasItems === false && cand(tr, 1).visible === null,
    JSON.stringify(cand(tr, 1)));
  check('13.9 owner-mismatch 候选的 copy/hasItems 记为已跑过',
    cand(tr, 2).copy === false && cand(tr, 2).hasItems === true,
    JSON.stringify(cand(tr, 2)));
  check('13.9b owner-mismatch 候选的 visible 是 null：它在 owner 门就走了，可见性门从未对它求值',
    cand(tr, 2).visible === null, JSON.stringify(cand(tr, 2).visible));
  check('13.10 hidden 候选的 visible 是跑出来的 false，不是 null',
    cand(tr, 3).visible === false && cand(tr, 3).hasItems === true,
    JSON.stringify(cand(tr, 3)));
  check('13.11 owner 六字段在 copy / no-items 两个候选上全是 null（它们没走到 owner 门）',
    cand(tr, 0).ulExpando === null && cand(tr, 0).ownerEnd === null
    && cand(tr, 1).ulExpando === null && cand(tr, 1).hops === null,
    JSON.stringify([cand(tr, 0).ulExpando, cand(tr, 1).ulExpando]));
  check('13.12 identityOnly 常量在表上', tr.identityOnly === true, String(tr.identityOnly));
}
{
  // The ordinary accept, on its own.
  const page = popupPage();
  const mf = tMenuFiber(page);
  const ul = tPopup(page, { chain: tPopupChain(page, mf, 3) });
  const got = page.api.popupForMenu(mf);
  const tr = rawTrace(page);
  check('13.13 产品返回的就是那个 fixture 对象本身', got === ul, String(got && got.tagName));
  check('13.14 accepted=1 且 returned 是被接受候选的真实下标',
    tr.accepted === 1 && tr.returned === 0, JSON.stringify([tr.accepted, tr.returned]));
  check('13.15 accepted 候选三道门全是跑出来的值',
    cand(tr, 0).copy === false && cand(tr, 0).hasItems === true && cand(tr, 0).visible === true,
    JSON.stringify(cand(tr, 0)));
  check('13.16 accepted 之后循环立刻返回，没有再开下一个候选',
    tr.scanned === 1 && tr.forkCopy === 0, JSON.stringify([tr.scanned, tr.forkCopy]));
  check('13.17 accepted 候选的 owner 三态：found / hops=3 / cap=40',
    cand(tr, 0).ownerEnd === 'found' && cand(tr, 0).hops === 3 && cand(tr, 0).ownerCap === 40,
    JSON.stringify(cand(tr, 0)));
  check('13.18 visible 是由 hidden / accepted 两个出口本身写进去的，没有第二次求值',
    page.calls.filter((c) => c.indexOf('eiv:') === 0).length === 1,
    page.calls.filter((c) => c.indexOf('eiv:') === 0).join(','));
}

  // ---------------------------------------------------------------------------
console.log('\n=== 14. owner 四态：39 / 40 是真边界 ===');
{
  // One helper, driven by a chain of an exact length, so the two sides of the
  // cap differ by exactly one hop and BOTH product consequences are visible.
  const at = (build) => {
    const page = popupPage();
    const mf = tMenuFiber(page);
    const ul = build(page, mf);
    const got = page.api.popupForMenu(mf);
    return { page, mf, ul, got, tr: rawTrace(page), c: cand(rawTrace(page), 0) };
  };
  const a = at((page, mf) => tPopup(page, { chain: tPopupChain(page, mf, 39) }));
  check('14.1 恰 39 跳：ownerEnd=found, hops=39, ownerFound=true',
    a.c.ownerEnd === 'found' && a.c.hops === 39 && a.c.ownerFound === true,
    JSON.stringify([a.c.ownerEnd, a.c.hops, a.c.ownerFound]));
  check('14.1b 恰 39 跳：产品 accept 并返回那个 ul 本身',
    a.got === a.ul && a.tr.accepted === 1, JSON.stringify({ got: a.got === a.ul, accepted: a.tr.accepted }));
  check('14.1c found 时 ownerCap 记的是出厂那个 40', a.c.ownerCap === 40, String(a.c.ownerCap));
  check('14.1d 拿到的是 want 自己（同一个对象）时配对为 false',
    a.c.ownerIsAlternateOfMenuFiber === false, String(a.c.ownerIsAlternateOfMenuFiber));

  const b = at((page, mf) => tPopup(page, { chain: tPopupChain(page, mf, 40) }));
  check('14.2 恰 40 跳：ownerEnd=budget（走到 null 才 chain-ended，这里 fiber 仍非空）, hops=40',
    b.c.ownerEnd === 'budget' && b.c.hops === 40, JSON.stringify([b.c.ownerEnd, b.c.hops]));
  check('14.2b 恰 40 跳：产品返回 null 并记 owner-mismatch',
    b.got === null && b.c.outcome === 'owner-mismatch' && b.c.ownerFound === false,
    JSON.stringify([b.got === null, b.c.outcome, b.c.ownerFound]));

  // A chain LONGER than the cap changes nothing about the recorded end: the
  // walk stops at the shipped 40, so hops is 40 -- not 44. Reporting 44 would
  // be claiming the diagnostic walked further than the shipped code does.
  const c44 = at((page, mf) => tPopup(page, { chain: tPopupChain(page, mf, 44) }));
  check('14.3 44 跳的链仍停在出厂上限上：budget 且 hops=40（不是 44）',
    c44.c.ownerEnd === 'budget' && c44.c.hops === 40, JSON.stringify([c44.c.ownerEnd, c44.c.hops]));
  check('14.3b 上溯求值次数恰为 40，没有为了诊断多走一步',
    c44.page.calls.filter((x) => x.indexOf('mp:') === 0).length === 40,
    String(c44.page.calls.filter((x) => x.indexOf('mp:') === 0).length));

  const shortChain = (page) => {
    let top = tFiber(page, {}, null);
    for (let i = 0; i < 2; i++) top = tFiber(page, {}, top);
    return top;
  };
  const d = at((page, mf) => tPopup(page, { chain: shortChain(page) }));
  check('14.4 三跳短链走空是 chain-ended，绝不写成 budget',
    d.c.ownerEnd === 'chain-ended' && d.c.hops === 3, JSON.stringify([d.c.ownerEnd, d.c.hops]));
  check('14.4b 短链候选产品照旧 owner-mismatch', d.got === null, String(d.got));

  const e = at((page) => tPopup(page, { items: true }));   // no fiber at all
  check('14.5 入口就没有 fiber 是 no-fiber，hops=0, ulExpando=false',
    e.c.ownerEnd === 'no-fiber' && e.c.hops === 0 && e.c.ulExpando === false,
    JSON.stringify([e.c.ownerEnd, e.c.hops, e.c.ulExpando]));
  check('14.6 ulExpando 三义：有 fiber 时为 true（null=未跑到 由 19.* 的注入证明）',
    a.c.ulExpando === true && e.c.ulExpando === false && d.c.ulExpando === true,
    JSON.stringify([a.c.ulExpando, e.c.ulExpando, d.c.ulExpando]));
  check('14.7 两种三态之外没有第四种：找不到链上的 menu fiber 就是 chain-ended',
    [a, b, c44, d, e].map((x) => x.c.ownerEnd).join(',') === 'found,budget,budget,chain-ended,no-fiber',
    [a, b, c44, d, e].map((x) => x.c.ownerEnd).join(','));
}

  // ---------------------------------------------------------------------------
console.log('\n=== 15. alternate 配对：严格双向，且不参与放行 ===');
{
  const paired = (setup) => {
    const page = popupPage();
    const mf = tMenuFiber(page);
    const top = tMenuFiber(page);            // a DIFFERENT menu fiber
    setup(top, mf);
    tPopup(page, { chain: top });
    const got = page.api.popupForMenu(mf);
    return { c: cand(rawTrace(page), 0), got, mf };
  };
  const both = paired((top, mf) => { top.alternate = mf; mf.alternate = top; });
  check('15.1 两个方向都成立、非空、互不相同 -> 配对为真',
    both.c.ownerIsAlternateOfMenuFiber === true, String(both.c.ownerIsAlternateOfMenuFiber));
  check('15.1b 配对为真也不放行：产品照旧 owner-mismatch',
    both.got === null && both.c.outcome === 'owner-mismatch', JSON.stringify(both.c.outcome));
  const onlyA = paired((top, mf) => { mf.alternate = top; });
  check('15.2 只有 mf.alternate 指向 owner -> false',
    onlyA.c.ownerIsAlternateOfMenuFiber === false, String(onlyA.c.ownerIsAlternateOfMenuFiber));
  const onlyB = paired((top, mf) => { top.alternate = mf; });
  check('15.3 只有 owner.alternate 指向 mf -> false',
    onlyB.c.ownerIsAlternateOfMenuFiber === false, String(onlyB.c.ownerIsAlternateOfMenuFiber));
  const same = (() => {
    const page = popupPage();
    const mf = tMenuFiber(page);
    const ul = tPopup(page, { chain: mf });      // walk lands on want itself
    const got = page.api.popupForMenu(mf);
    return { c: cand(rawTrace(page), 0), got, ul };
  })();
  check('15.4 同一个对象（不 distinct）配对为 false',
    same.c.ownerIsAlternateOfMenuFiber === false, String(same.c.ownerIsAlternateOfMenuFiber));
  check('15.4b 配对为 false 也不拦：产品照旧 accept', same.got === same.ul, String(same.got));
  const none = paired(() => {});
  check('15.5 对方没有 alternate 时是 false',
    none.c.ownerIsAlternateOfMenuFiber === false, String(none.c.ownerIsAlternateOfMenuFiber));
  check('15.6 配对布尔不参与任何放行：五个场景里配对有真有假，产品结果各自独立',
    [both.got === null, onlyA.got === null, onlyB.got === null, same.got === same.ul, none.got === null]
      .join(',') === 'true,true,true,true,true',
    [both.got === null, onlyA.got === null, onlyB.got === null, same.got === same.ul, none.got === null].join(','));
}

  // ---------------------------------------------------------------------------
console.log('\n=== 16. 截断只截诊断，产品照旧 ===');
{
  const page = popupPage();
  const mf = tMenuFiber(page);
  for (let i = 0; i < 4; i++) tPopup(page, { inCopyPopup: true, chain: tPopupChain(page, mf, 2) });
  const fifth = tPopup(page, { chain: tPopupChain(page, mf, 2) });
  const got = page.api.popupForMenu(mf);
  const tr = rawTrace(page);
  check('16.1 第 5 个候选照常参与产品判定，返回的就是第 5 个 fixture',
    got === fifth, String(got === fifth));
  check('16.2 scanned=5 / kept=4 / dropped=1',
    tr.scanned === 5 && tr.candidates.length === 4 && tr.dropped === 1,
    JSON.stringify([tr.scanned, tr.candidates.length, tr.dropped]));
  check('16.3 returned 记的是被接受候选的真实下标 4', tr.returned === 4, String(tr.returned));
  check('16.4 forkCopy 记 4，不受"只留 4 条"影响', tr.forkCopy === 4, String(tr.forkCopy));
  check('16.5 落表的四条顺序不变（按扫描顺序）', outcomes(tr) === 'copy,copy,copy,copy', outcomes(tr));
  check('16.6 accepted 只有一次', tr.accepted === 1, String(tr.accepted));
}
{
  const page = popupPage();
  const mf = tMenuFiber(page);
  for (let i = 0; i < 6; i++) tPopup(page, { inCopyPopup: true, chain: tPopupChain(page, mf, 2) });
  const got = page.api.popupForMenu(mf);
  const tr = rawTrace(page);
  check('16.7 六个全拒：scanned=6 / kept=4 / dropped=2',
    tr.scanned === 6 && tr.candidates.length === 4 && tr.dropped === 2,
    JSON.stringify([tr.scanned, tr.candidates.length, tr.dropped]));
  check('16.8 分叉计数覆盖所有出口，不受 4 限制', tr.forkCopy === 6, String(tr.forkCopy));
  check('16.9 returned 保持 null（没有任何一次 accepted）',
    tr.returned === null && tr.accepted === 0, JSON.stringify([tr.returned, tr.accepted]));
  check('16.10 产品照旧返回 null', got === null, String(got));
  check('16.11 本例无故障，"总分叉 == kept + dropped"成立（第 19.* 的故障例里它不成立）',
    tr.forkCopy + tr.forkNoItems + tr.forkOwner + tr.forkHidden
      === tr.candidates.length + tr.dropped, String(tr.forkCopy + tr.dropped));
}

  // ---------------------------------------------------------------------------
  // The strict shape check. It replaces "JSON.stringify did not throw", which is
  // NOT a proof: an ACYCLIC plain fiber serialises perfectly happily. What is
  // checked is a recursive key whitelist, a leaf type per key, and an
  // object-identity set, so an alias or an extra layer is caught too.
  // ---------------------------------------------------------------------------
const TRACE_KEYS = ['identityOnly', 'loopTotal', 'scanned', 'returned', 'forkCopy', 'forkNoItems',
  'forkOwner', 'forkHidden', 'accepted', 'dropped', 'noRecord', 'candidates'];
const CAND_KEYS = ['i', 'outcome', 'copy', 'hasItems', 'visible', 'ulExpando', 'ownerFound',
  'ownerEnd', 'hops', 'ownerCap', 'ownerIsAlternateOfMenuFiber'];
const OUTCOMES = ['copy', 'no-items', 'owner-mismatch', 'hidden', 'accepted'];
const ENDS = ['found', 'budget', 'chain-ended', 'no-fiber'];
const SPEC_CAND = {
  i: 'int', outcome: 'enum', copy: 'bool?', hasItems: 'bool?', visible: 'bool?',
  ulExpando: 'bool?', ownerFound: 'bool?', ownerEnd: 'enum?',
  hops: 'int?', ownerCap: 'int?', ownerIsAlternateOfMenuFiber: 'bool?',
};
const ENUM_LIST = { outcome: OUTCOMES, ownerEnd: ENDS };
const SPEC_TRACE = {
  identityOnly: 'bool', loopTotal: 'int', scanned: 'int', returned: 'int?',
  forkCopy: 'int', forkNoItems: 'int', forkOwner: 'int', forkHidden: 'int',
  accepted: 'int', dropped: 'int', noRecord: 'int',
  candidates: { array: true, keys: CAND_KEYS, spec: SPEC_CAND },
};
function strictShape(tr) {
  const bad = [];
  const seen = new Set();
  const walk = (o, keys, spec, path) => {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      bad.push('not-an-object@' + path); return;
    }
    if (seen.has(o)) { bad.push('aliased-object@' + path); return; }
    seen.add(o);
    const ks = Object.keys(o).sort();
    const want = keys.slice().sort();
    for (const k of ks) if (want.indexOf(k) < 0) bad.push('unknown-key@' + path + '.' + k);
    for (const k of want) if (ks.indexOf(k) < 0) bad.push('missing-key@' + path + '.' + k);
    for (const k of want) {
      if (ks.indexOf(k) < 0) continue;
      const v = o[k];
      const s = spec[k];
      if (s.array) {
        if (!Array.isArray(v)) { bad.push('not-an-array@' + path + '.' + k); continue; }
        v.forEach((c, i) => walk(c, s.keys, s.spec, path + '.' + k + '[' + i + ']'));
        continue;
      }
      if (v === null) { if (s.slice(-1) !== '?') bad.push('unexpected-null@' + path + '.' + k); continue; }
      if (v === undefined) { bad.push('undefined@' + path + '.' + k); continue; }
      const base = s.slice(-1) === '?' ? s.slice(0, -1) : s;
      if (typeof v === 'object' || typeof v === 'function') {
        const what = base === 'int' ? 'number' : (base === 'bool' ? 'boolean' : 'string');
        bad.push('not-a-' + what + '(' + (v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v)) + ')@' + path + '.' + k);
        continue;
      }
      if (base === 'bool') { if (typeof v !== 'boolean') bad.push('not-a-boolean(' + typeof v + ')@' + path + '.' + k); continue; }
      if (base === 'int') {
        if (typeof v !== 'number') { bad.push('not-a-number(' + typeof v + ')@' + path + '.' + k); continue; }
        if (!isFinite(v)) { bad.push('non-finite@' + path + '.' + k); continue; }
        if (Math.floor(v) !== v) { bad.push('not-an-integer@' + path + '.' + k); continue; }
        continue;
      }
      if (base === 'enum') {
        if (typeof v !== 'string') { bad.push('not-a-string(' + typeof v + ')@' + path + '.' + k); continue; }
        if ((ENUM_LIST[k] || []).indexOf(v) < 0) bad.push('not-in-enum(' + v + ')@' + path + '.' + k);
      }
    }
  };
  walk(tr, TRACE_KEYS, SPEC_TRACE, 'trace');
  return bad;
}
const plainFiber = (name) => ({
  tag: 5, type: name, memoizedProps: {}, memoizedState: null, return: null, alternate: null,
});

console.log('\n=== 17. 严格形状：零违规，十个反例逐个必须被检出 ===');
{
  const page = popupPage();
  const mf = tMenuFiber(page);
  tPopup(page, { inCopyPopup: true, chain: tPopupChain(page, mf, 2) });
  tPopup(page, { chain: tPopupChain(page, mf, 3) });
  page.api.popupForMenu(mf);
  const tr = rawTrace(page);
  check('17.1 真实 trace 零违规', strictShape(tr).length === 0, strictShape(tr).join(' | '));
  const domNode = page.dom.el('ul', {});
  const base = JSON.parse(JSON.stringify(tr));
  const put = (path, k, v) => {
    const o = JSON.parse(JSON.stringify(base));
    let n = o;
    for (const p of path) n = n[p];
    n[k] = v;
    return o;
  };
  const counter = [
    ['A 无环 plain fiber 挂成未知键', put(['candidates', '0'], 'hostFiber', plainFiber('div')), 'unknown-key'],
    ['B 无环 plain fiber 顶掉整数字段', put([], 'loopTotal', plainFiber('div')), 'not-a-number(object)'],
    ['C DOM 节点顶掉布尔字段', put(['candidates', '0'], 'visible', domNode), 'not-a-boolean(object)'],
    ['D DOM 节点顶掉枚举字段', put(['candidates', '0'], 'ownerEnd', domNode), 'not-a-string(object)'],
    ['E 同一个 record 被两个候选共用',
      (() => { const o = JSON.parse(JSON.stringify(base)); o.candidates = [cand(base, 0), cand(base, 0)]; return o; })(),
      'aliased-object'],
    ['F 字段置 undefined', put(['candidates', '0'], 'hops', undefined), 'undefined'],
    ['G 字段置函数', put([], 'scanned', function noop() {}), 'not-a-number(function)'],
    ['H 计数字段置 NaN', put([], 'accepted', NaN), 'non-finite'],
    ['I 关键键被删',
      (() => { const o = JSON.parse(JSON.stringify(base)); delete cand(o, 0).outcome; return o; })(),
      'missing-key'],
    ['J trace 顶层多一层对象', put([], 'extra', { a: 1 }), 'unknown-key'],
  ];
  for (const [label, bad, why] of counter) {
    const hits = strictShape(bad);
    check(`17.x 反例 ${label} 必须被检出`,
      hits.some((h) => h.indexOf(why) >= 0), hits.join(' | ') || '(no violation)');
  }
  // Why the old JSON proof is retired: it passes, the strict check does not.
  const acyclic = put(['candidates', '0'], 'hostFiber', plainFiber('div'));
  let jsonOk = false;
  try { JSON.stringify(acyclic); jsonOk = true; } catch (e) { jsonOk = false; }
  check('17.2 无环 fiber 的 JSON 仍然成功，所以"能序列化"不构成无引用证明',
    jsonOk && strictShape(acyclic).length === 1, `json=${jsonOk} violations=${strictShape(acyclic).length}`);
  check('17.3 严格检查不是恒绿：十个反例之外，真实 trace 零违规',
    strictShape(base).length === 0 && counter.every(([, bad, why]) => strictShape(bad).length > 0),
    'teeth');
}

  // ---------------------------------------------------------------------------
console.log('\n=== 18. 异常隔离：在助手自己的 try 内按序位真注入 ===');
{
  const INST = instrumentedBlock();
  let ok = true;
  try { new Function('window', 'document', 'var disposed=false;\n' + INST); } catch (e) { ok = false; }
  check('18.0 插桩版仍是合法切片', ok, `${INST.length} chars`);
  check('18.0b 生产里没有 tick / arm 任何挂钩（注入只存在于本测试的文本变换里）',
    !/__tick|__armMap|__hits|__reasons/.test(BLOCK), 'production-hook-free');

  const ALL = ['open', 'candidate', 'mark', 'fork', 'nmo-entry', 'nmo-found', 'nmo-miss'];
  // Reachability is declared, not assumed: a point that a scenario never
  // reaches must report hits 0, otherwise a "green" injection proves nothing.
  const SCENARIOS = {
    'four-gates': {
      reach: ALL.filter((p) => p !== 'nmo-miss'),
      build: (page) => {
        const mf = tMenuFiber(page);
        tPopup(page, { inCopyPopup: true, chain: tPopupChain(page, mf, 2) });
        tPopup(page, { items: false, chain: tPopupChain(page, mf, 2) });
        tPopup(page, { chain: foreignChain(page) });
        tPopup(page, { hidden: true, chain: tPopupChain(page, mf, 2) });
        return mf;
      },
    },
    'accept-39': {
      reach: ALL.filter((p) => p !== 'nmo-miss'),
      build: (page) => {
        const mf = tMenuFiber(page);
        tPopup(page, { chain: tPopupChain(page, mf, 39) });
        return mf;
      },
    },
    'accept-1': {
      reach: ALL.filter((p) => p !== 'nmo-miss'),
      build: (page) => {
        const mf = tMenuFiber(page);
        tPopup(page, { chain: tPopupChain(page, mf, 1) });
        return mf;
      },
    },
    'budget-40': {
      reach: ALL.filter((p) => p !== 'nmo-found'),
      build: (page) => {
        const mf = tMenuFiber(page);
        tPopup(page, { chain: tPopupChain(page, mf, 40) });
        return mf;
      },
    },
    'chain-ended-3': {
      reach: ALL.filter((p) => p !== 'nmo-found'),
      build: (page) => {
        const mf = tMenuFiber(page);
        let top = tFiber(page, {}, null);
        for (let i = 0; i < 2; i++) top = tFiber(page, {}, top);
        tPopup(page, { chain: top });
        return mf;
      },
    },
    // No fiber at all still runs the MISS exit: "there was nothing to walk" is
    // classified there, so nmo-miss is reachable and nmo-found is not.
    'no-fiber': {
      reach: ALL.filter((p) => p !== 'nmo-found'),
      build: (page) => {
        const mf = tMenuFiber(page);
        tPopup(page, { items: true });
        return mf;
      },
    },
    'hidden-then-visible': {
      reach: ALL.filter((p) => p !== 'nmo-miss'),
      build: (page) => {
        const mf = tMenuFiber(page);
        tPopup(page, { hidden: true, chain: tPopupChain(page, mf, 2) });
        tPopup(page, { chain: tPopupChain(page, mf, 2) });
        return mf;
      },
    },
    'six-rejects': {
      reach: ['open', 'candidate', 'fork'],
      build: (page) => {
        const mf = tMenuFiber(page);
        for (let i = 0; i < 6; i++) tPopup(page, { inCopyPopup: true, chain: tPopupChain(page, mf, 2) });
        return mf;
      },
    },
  };
  // One run: arm, drive the loop once, then disarm and drive a SECOND loop on a
  // FRESH set of fixture objects. The first loop is what the fault may damage;
  // the second is what must come back byte-identical to the unarmed reference.
  const run = (arm, build) => {
    const page = popupPage(INST);
    page.api.arm(arm);
    const mf = build(page);
    const got = page.api.popupForMenu(mf);
    const first = rawTrace(page);
    void 0;
    const hits = page.api.tick();
    // PRODUCT reads only. The `alt:` read belongs to the pairing check, which is
    // a diagnostic-only read guarded by ulExpando: when the entry write failed
    // the guard legitimately skips it, so counting it here would demand that a
    // fault made the diagnostic read MORE, not that the product read the same.
    const calls = page.calls.filter((c) => c.indexOf('alt:') !== 0).join(' ');
    const altReads = page.calls.filter((c) => c.indexOf('alt:') === 0).length;
    const reasons = page.api.reasons().join(',');
    const ref = popupPage(INST);
    const mf2 = build(ref);
    const got2 = ref.api.popupForMenu(mf2);
    return {
      hits, first, calls, altReads, reasons,
      gotNull: got === null, gotIsFixture: got !== null,
      after: rawTrace(ref),
      refCalls: ref.calls.filter((c) => c.indexOf('alt:') !== 0).join(' '),
      refReasons: ref.api.reasons().join(','),
      refTrace: rawTrace(ref),
      refGotNull: got2 === null,
      page,
    };
  };
  let armed = 0, unreachable = 0;
  for (const [sname, sc] of Object.entries(SCENARIOS)) {
    const ref = run({}, sc.build);
    for (const point of ALL) {
      const a = run({ [point]: 1 }, sc.build);
      const n = a.hits[point] || 0;
      const label = `18.${sname}/${point}`;
      if (sc.reach.indexOf(point) < 0) {
        unreachable++;
        check(`${label} 该场景本就到不了这个注入点，hits 必须如实为 0`,
          n === 0, JSON.stringify(a.hits));
        continue;
      }
      armed++;
      check(`${label} 注入点真的被走到（hits>0，Traps T1/T7）`, n > 0, JSON.stringify(a.hits));
      check(`${label} 产品返回值不变（同为 null 或同为那个 fixture）`,
        a.gotNull === ref.gotNull, `armed=${a.gotNull} ref=${ref.gotNull}`);
      check(`${label} topmostReason 序列逐字不变`, a.reasons === ref.reasons,
        `armed="${a.reasons}" ref="${ref.reasons}"`);
      check(`${label} 出厂求值序列逐元素不变（qsa/closest/qS/fib/eiv/mp/alt）`,
        a.calls === ref.refCalls, a.calls === ref.refCalls ? a.calls.split(' ').length + ' product reads' : `armed=[${a.calls}] ref=[${ref.refCalls}]`);
      check(`${label} 解除注入后的下一次调用与未注入参照逐字段相同`,
        same(a.after, ref.refTrace) && same(a.after, ref.first),
        same(a.after, ref.refTrace) ? '' : `after=${JSON.stringify(a.after)} ref=${JSON.stringify(ref.refTrace)}`);
      if (point === 'open') {
        check(`${label} Open 首句抛错：整份 trace 不存在，槽里也不留信封`,
          a.first === null && a.page.api.diag().popup === null, `trace=${a.first === null}`);
      } else {
        check(`${label} 注入后的那份 trace 仍过严格形状`,
          strictShape(a.first).length === 0, strictShape(a.first).join(' | '));
      }
      check(`${label} 出厂求值序列确实非空（否则"不变"是空的）`,
        a.refCalls.length > 0, `${a.refCalls.split(' ').length} reads`);
    }
  }
  check('18.z 场景 × 注入点矩阵全部命中', armed > 0 && unreachable > 0,
    `${armed} armed / ${unreachable} unreachable / ${Object.keys(SCENARIOS).length} scenarios`);
}

  // ---------------------------------------------------------------------------
console.log('\n=== 19. 跨候选按序位：第二个候选被故障时第一个不得被污染 ===');
{
  const INST = instrumentedBlock();
  const OWNER_KEYS = ['ulExpando', 'ownerFound', 'ownerEnd', 'hops', 'ownerCap',
    'ownerIsAlternateOfMenuFiber'];
  const go = (arm, build) => {
    const page = popupPage(INST);
    page.api.arm(arm);
    const mf = build(page);
    page.api.popupForMenu(mf);
    return { page, tr: rawTrace(page), hits: page.api.tick() };
  };
  // Two candidates, both of which reach the found exit (so nmo-found can hit
  // twice) and both of which call nmo (so nmo-entry can hit twice).
  const twoFound = (page) => {
    const mf = tMenuFiber(page);
    tPopup(page, { chain: foreignChain(page, 3) });
    tPopup(page, { chain: foreignChain(page, 4) });
    return mf;
  };
  // Two candidates, both of which run out before the cap (so nmo-miss hits twice).
  const twoMiss = (page) => {
    const mf = tMenuFiber(page);
    tPopup(page, { chain: tPopupChain(page, mf, 40) });
    tPopup(page, { chain: tPopupChain(page, mf, 41) });
    return mf;
  };
  const cRefFound = go({}, twoFound).tr;
  const cRefMiss = go({}, twoMiss).tr;
  check('19.0 参照（two-found）：两个候选都记到 owner-mismatch',
    outcomes(cRefFound) === 'owner-mismatch,owner-mismatch' && cRefFound.scanned === 2,
    outcomes(cRefFound));
  check('19.0b 参照（two-found）：第一个 hops=3，第二个 hops=4',
    cand(cRefFound, 0).hops === 3 && cand(cRefFound, 1).hops === 4,
    JSON.stringify([cand(cRefFound, 0).hops, cand(cRefFound, 1).hops]));
  check('19.0c 参照（two-miss）：两个候选都记到 budget',
    cand(cRefMiss, 0).ownerEnd === 'budget' && cand(cRefMiss, 1).ownerEnd === 'budget',
    JSON.stringify([cand(cRefMiss, 0).ownerEnd, cand(cRefMiss, 1).ownerEnd]));

  const entry = go({ 'nmo-entry': 2 }, twoFound);
  check('19.1 nmo-entry#2 真的命中 2 次', entry.hits['nmo-entry'] === 2, JSON.stringify(entry.hits));
  check('19.1b nmo-entry#2：第二个候选的六个 owner 字段全是 null（入口记录没写上）',
    OWNER_KEYS.every((k) => cand(entry.tr, 1)[k] === null), JSON.stringify(cand(entry.tr, 1)));
  check('19.1c nmo-entry#2：第一个候选逐字段与未注入参照相同',
    same(cand(entry.tr, 0), cand(cRefFound, 0)), JSON.stringify(cand(entry.tr, 0)));
  check('19.1d nmo-entry#2：第二个候选与参照确有差异（否则等于没测）',
    !same(cand(entry.tr, 1), cand(cRefFound, 1)), 'identical');
  check('19.1e nmo-entry#2：outcome 仍是 owner-mismatch，没有被改成 copy',
    cand(entry.tr, 1).outcome === 'owner-mismatch', cand(entry.tr, 1).outcome);

  const found = go({ 'nmo-found': 2 }, twoFound);
  check('19.2 nmo-found#2 真的命中 2 次', found.hits['nmo-found'] === 2, JSON.stringify(found.hits));
  check('19.2b nmo-found#2：第二个候选只保留入口写下的 ulExpando=true，出口五字段全 null',
    cand(found.tr, 1).ulExpando === true
    && ['ownerFound', 'ownerEnd', 'hops', 'ownerCap', 'ownerIsAlternateOfMenuFiber']
      .every((k) => cand(found.tr, 1)[k] === null),
    JSON.stringify(cand(found.tr, 1)));
  check('19.2c nmo-found#2：第一个候选逐字段与参照相同',
    same(cand(found.tr, 0), cand(cRefFound, 0)), JSON.stringify(cand(found.tr, 0)));
  check('19.2d nmo-found#2：与参照确有差异', !same(cand(found.tr, 1), cand(cRefFound, 1)), 'identical');
  check('19.2e nmo-found#2：出口字段保持 null 而不是伪造一个 found',
    cand(found.tr, 1).ownerFound === null, String(cand(found.tr, 1).ownerFound));

  const miss = go({ 'nmo-miss': 2 }, twoMiss);
  check('19.3 nmo-miss#2 真的命中 2 次', miss.hits['nmo-miss'] === 2, JSON.stringify(miss.hits));
  check('19.3b nmo-miss#2：第二个候选只保留入口写下的 ulExpando=true，出口五字段全 null',
    cand(miss.tr, 1).ulExpando === true
    && ['ownerFound', 'ownerEnd', 'hops', 'ownerCap', 'ownerIsAlternateOfMenuFiber']
      .every((k) => cand(miss.tr, 1)[k] === null),
    JSON.stringify(cand(miss.tr, 1)));
  check('19.3c nmo-miss#2：第一个候选逐字段与参照相同',
    same(cand(miss.tr, 0), cand(cRefMiss, 0)), JSON.stringify(cand(miss.tr, 0)));
  check('19.3d nmo-miss#2：与参照确有差异', !same(cand(miss.tr, 1), cand(cRefMiss, 1)), 'identical');

  // fork on the SECOND candidate while the THIRD candidate cannot produce a
  // record: the joint fault that a shared per-call scratch used to hide.
  const joint = (page) => {
    const mf = tMenuFiber(page);
    tPopup(page, { chain: foreignChain(page, 3) });
    tPopup(page, { chain: tPopupChain(page, mf, 40) });
    tPopup(page, { chain: foreignChain(page, 4) });
    return mf;
  };
  const jRef = go({}, joint);
  const jArm = go({ fork: 2, candidate: 3 }, joint);
  check('19.4 联合故障真的命中 fork#2 与 candidate#3',
    jArm.hits.fork === 3 && jArm.hits.candidate === 3, JSON.stringify(jArm.hits));
  check('19.4b candidate#3 丢记录如实计入 noRecord=1', jArm.tr.noRecord === 1, String(jArm.tr.noRecord));
  // fork#2 threw BEFORE it counted anything, so its exit is honestly absent --
  // no detail, no fabricated outcome, no inflated counter.
  check('19.4c 分叉计数只算真正记下的出口：抛在计数之前的那个出口不算（3 个出口记到 2）',
    jArm.tr.forkOwner === 2, String(jArm.tr.forkOwner));
  check('19.4d 明细只入表一条：抛错的候选不伪造出口，丢记录的候选没有任何字段泄漏',
    jArm.tr.candidates.length === 1, String(jArm.tr.candidates.length));
  check('19.4e scanned 只记到实际开出的记录数（少记，不是造结果）',
    jArm.tr.scanned === 2 && jRef.tr.scanned === 3, `armed=${jArm.tr.scanned} ref=${jRef.tr.scanned}`);
  check('19.4f 候选 1 逐字段与未注入参照相同（没被后两个候选覆写）',
    same(cand(jArm.tr, 0), cand(jRef.tr, 0)), JSON.stringify(cand(jArm.tr, 0)));
  check('19.4g 候选 1 留着的仍是自己跑出来的值，不是后两个候选的（hops=3 而非 40 或 4）',
    cand(jArm.tr, 0).hops === 3 && cand(jArm.tr, 0).ownerEnd === 'found',
    JSON.stringify(cand(jArm.tr, 0)));
  check('19.4h 参照那一次三条明细全在，所以 armed 少掉的两条确实来自这次故障',
    jRef.tr.candidates.length === 3 && jRef.tr.noRecord === 0,
    JSON.stringify([jRef.tr.candidates.length, jRef.tr.noRecord]));
  check('19.4h 联合故障的 trace 仍过严格形状', strictShape(jArm.tr).length === 0,
    strictShape(jArm.tr).join(' | '));
  check('19.4i 与未注入参照确有差异（否则等于没测）', !same(jArm.tr, jRef.tr), 'identical');
  check('19.5 共享 record 的变异体在同一注入下必被污染（缺陷类别可观测）',
    (() => {
      // The mutant: topmostDiagPopupCandidate returns ONE record per trace.
      const mutant = INST.replace(
        '      tr.scanned++;\n      return {\n        i: i, outcome: \'unknown\',',
        '      tr.scanned++;\n      if (tr.__rec) { tr.__rec.i = i; return tr.__rec; }\n      tr.__rec = {\n        i: i, outcome: \'unknown\',',
      ).replace('        ownerIsAlternateOfMenuFiber: null,\n      };\n    } catch (e) { return null; }',
        '        ownerIsAlternateOfMenuFiber: null,\n      };\n      return tr.__rec;\n    } catch (e) { return null; }');
      if (mutant === INST) return false;
      const page = popupPage(mutant);
      const mf = twoFound(page);
      page.api.popupForMenu(mf);
      const tr = rawTrace(page);
      return cand(tr, 0).i === 1 && cand(tr, 0).hops === 4;
    })(), 'shared-record mutant must be contaminated');
}

  // ---------------------------------------------------------------------------
console.log('\n=== 20. 读数边界：trace 不等于产品返回 ===');
{
  const INST = instrumentedBlock();
  const page = popupPage(INST);
  page.api.arm({ candidate: 1 });
  const mf = tMenuFiber(page);
  const ul = tPopup(page, { chain: tPopupChain(page, mf, 2) });
  const got = page.api.popupForMenu(mf);
  const tr = rawTrace(page);
  check('20.1 诊断助手首句就抛，产品照样返回那个 ul',
    got === ul && tr.accepted === 1, JSON.stringify({ got: got === ul, accepted: tr.accepted }));
  check('20.2 returned 为 null，但这【不】证明产品返回了 null',
    tr.returned === null && got === ul, `returned=${tr.returned} gotIsUl=${got === ul}`);
  check('20.3 noRecord 如实反映这次不足', tr.noRecord === 1, String(tr.noRecord));
  check('20.4 scanned 只记到实际开出的记录数（少记，不造结果）', tr.scanned === 0, String(tr.scanned));
  check('20.5 分叉计数覆盖所有出口，不受"只留 4 条"限制',
    tr.forkCopy + tr.forkNoItems + tr.forkOwner + tr.forkHidden + tr.accepted === 1,
    JSON.stringify([tr.forkCopy, tr.accepted]));
  check('20.6 open 的首句抛错：整份 trace 走不成，产品不受影响',
    (() => {
      const p2 = popupPage(INST);
      p2.api.arm({ open: 1 });
      const mf2 = tMenuFiber(p2);
      const ul2 = tPopup(p2, { chain: tPopupChain(p2, mf2, 2) });
      const g2 = p2.api.popupForMenu(mf2);
      return g2 === ul2 && p2.api.diag().popup === null;
    })(), 'open-throw');
  check('20.7 open 的首句抛错后槽里不留旧信封', (() => {
    const p3 = popupPage(INST);
    const mf3 = tMenuFiber(p3);
    tPopup(p3, { chain: tPopupChain(p3, mf3, 2) });
    p3.api.popupForMenu(mf3);                 // publishes one envelope
    p3.api.arm({ open: 2 });                  // the SECOND Open throws
    p3.api.popupForMenu(mf3);                 // must clear it, then fail
    return p3.api.diag().popup === null;
  })(), 'stale-cleared');
}

  // ---------------------------------------------------------------------------
console.log('\n=== 21. 结构保证：循环、赋值、出口集合、可见性求值次数 ===');
{
  const nmo = BLOCK.slice(BLOCK.indexOf('  function nearestMenuOwner(fiber, rec, want) {'),
    BLOCK.indexOf('  function elementIsVisible(el) {'));
  const pop = BLOCK.slice(BLOCK.indexOf('  function popupForMenu(menuFiber) {'),
    BLOCK.indexOf('  function buildTopmostItem('));
  const countIn = (src, needle) => src.split(needle).length - 1;
  check('21.1 nearestMenuOwner 的循环头与出厂逐字相同，且全文只出现一次',
    countIn(BLOCK, '    for (var i = 0; fiber && i < TOPMOST_MAX_ANCESTORS; i++) {') === 1
    && nmo.indexOf('    for (var i = 0; fiber && i < TOPMOST_MAX_ANCESTORS; i++) {') >= 0,
    String(countIn(BLOCK, 'for (var i = 0; fiber && i < TOPMOST_MAX_ANCESTORS; i++) {')));
  check('21.2 fiber = fiber.return 在函数体里恰好一次（上溯没有为诊断多走一步）',
    countIn(nmo, '      fiber = fiber.return;') === 1, String(countIn(nmo, '      fiber = fiber.return;')));
  check('21.3 返回值集合仍是 fiber 与 null 两个出口',
    countIn(nmo, 'return fiber;') === 1 && countIn(nmo, 'return null;') === 1
    && countIn(nmo, 'return ') === 2, String(countIn(nmo, 'return ')));
  check('21.4 形参只多了两个可选诊断实参，第一个实参与比较式不变',
    nmo.trim().indexOf('function nearestMenuOwner(fiber, rec, want) {') === 0
    && nmo.indexOf('var p = fiber.memoizedProps;') > 0
    && nmo.indexOf('isArray(p.menu) && p.menu.length') > 0, 'signature');
  check('21.5 popupForMenu 里 querySelectorAll 仍然只有一次',
    countIn(pop, "document.querySelectorAll('.ant-dropdown-menu')") === 1,
    String(countIn(pop, "document.querySelectorAll('.ant-dropdown-menu')")));
  check('21.6 elementIsVisible 在整个循环里只被调用一次（visible 不是提前求值的）',
    countIn(pop, 'elementIsVisible(ul)') === 1, String(countIn(pop, 'elementIsVisible(ul)')));
  check('21.7 fiberOf 只在 owner 门那一处被调用一次',
    countIn(pop, 'fiberOf(ul)') === 1, String(countIn(pop, 'fiberOf(ul)')));
  check('21.8 closest 与 querySelector 各只有一处，且仍在原来的门位上',
    countIn(pop, 'ul.closest &&') === 1 && countIn(pop, "ul.querySelector('.matrix-menu-item')") === 1,
    [countIn(pop, 'ul.closest &&'), countIn(pop, "ul.querySelector('.matrix-menu-item')")].join(','));
  // The three positions are compared INSIDE the hidden line: popupForMenu has
  // three `continue; }`, and comparing against the first one would silently
  // compare the hidden fork against the copy fork.
  const hiddenLine = (pop.split('\n').find((l) => l.indexOf("topmostReason('popup-hidden')") >= 0) || '');
  check('21.9 popup-hidden 那一行是单行，顺序为 reason -> 分叉记录 -> continue',
    hiddenLine.trim().indexOf("if (!elementIsVisible(ul)) { topmostReason('popup-hidden');") === 0
    && hiddenLine.indexOf("topmostDiagPopupFork(__tr, __rec, 'hidden'")
      > hiddenLine.indexOf("topmostReason('popup-hidden')")
    && hiddenLine.indexOf('continue; }') > hiddenLine.indexOf("'hidden'")
    && hiddenLine.trim().endsWith('continue; }'),
    hiddenLine.trim());
  check('21.10 没有新增的 topmostReason 写点（分叉记录不写 reason）',
    countIn(pop, 'topmostReason(') === 1, String(countIn(pop, 'topmostReason(')));
  check('21.11 每个候选开一条 record 是在两道门之前，与出厂循环结构一致',
    pop.indexOf('var __rec = topmostDiagPopupCandidate(__tr, i);')
      < pop.indexOf('ul.closest &&'), 'record-before-gates');
  check('21.12 trace 的取用是调用一行，没有在 popupForMenu 里裸写槽',
    /var __tr = topmostDiagPopupOpen\(pops\.length\);/.test(pop)
    && !/topmostDiag\.popup\s*=[^=]/.test(pop), 'no-bare-slot-write');
  check('21.13 没有新增 return / Done / Final（出口集合仍是 ul 与 null）',
    countIn(pop, 'return ') === 2 && !/Done|Final/.test(pop), String(countIn(pop, 'return ')));
}

  // ===========================================================================
  // r4: the shared gate must be able to say NO on this entry too.
//
  // r3 shipped
  //     topmostState.busy = true;
  //     topmostState.ticket = hostCallTake();     // null when the gate refuses
  //     topmostState.calls++;
  //     ret = cap.fn(sessionId, true, 0);         // called ANYWAY
  // so every fail-closed path the r3 gate had was decorative here. Two
  // independent review passes found it by reading, not by running, which is
  // exactly why the counterexamples below drive the REAL onTopmostActivate
  // through the REAL hostCallTake rather than slicing the fragment.
//
  // Three states, all from the real menu click path:
  //   22.1 gate slot unwritable  -> hostCallTake returns null -> must refuse
  //   22.2 gate held by another instance's ticket -> null -> must refuse
  //   22.3 gate free and writable -> the CONTROL: it must still work
  // ===========================================================================
console.log('\n=== 22. r4：共享闸在这个入口也必须能拒绝（真实点击路径）===');
{
  const GATE = '__mmxStatusHostGateV1';

  // --- 22.1 the window slot cannot hold the gate at all ---------------------
  {
    const p = makePage(undefined, { freeze: true });
    const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
    // r5.1: the close is asserted on the HOST's own controlled contract.
    //
    // The Dropdown is controlled: the open state lives in the row component,
    // and onOpenChange(false) is exactly the call rc-dropdown makes when a menu
    // item is activated -- i.e. the host's own close path.
    //
    // WHAT mopts IS, stated narrowly so it is not over-read:
    //   mopts is a STAND-IN for the host's controlled contract, nothing more.
    //   It records the calls the product makes. It does NOT simulate React
    //   re-rendering the row with open=false, and it is NOT a second source of
    //   truth: the single source of state in this test is mopts itself. The
    //   product's own `open` prop on the fiber is deliberately left untouched
    //   and unread, because writing it by hand would be a dead write -- nothing
    //   in the shipped code reads it (checked: page-script.mjs never touches
    //   memoizedProps.open), so seeding it would only look like evidence.
    //
    // r4 asserted `state.lastClose !== null && !== undefined` here, which was
    // vacuous: the field starts at '' and the refusal branch never assigns it,
    // so it stayed true whether or not the menu was closed. Mutation m26
    // removes the refusal's closeHostMenu and MUST turn this red.
    const mopts = { openChanges: [], open: true, onOpenChange(open) { mopts.openChanges.push(open); mopts.open = open; } };
    const { rowEl, dropdown } = makeRow(p, 'mvs_c', host, mopts);
    const { ul } = openMenu(p, dropdown);
    p.api.onContextMenu({ target: rowEl, isTrusted: true });
    p.timers.run();
    const item = topLi(ul);
    // r5.1: the "was open before" precondition is a SELF-CHECK of the fixture's
    // own seeding, sampled immediately before the click, and the same single
    // value is then re-asserted together with the after-state below. Reading
    // mopts.open once into beforeOpen is what makes the two assertions a real
    // TRANSITION rather than two independent end-state readings.
    const beforeOpen = mopts.open;
    check('22.1.0 前置自检：夹具播种的受控 open 在点击前确实是 true',
      beforeOpen === true, `beforeOpen=${beforeOpen}`);
    // Precondition, stated so this test cannot go green for the wrong reason:
    // the frozen window really is unwritable.
    check('22.1.0 前置：被冻结的 window 确实写不进闸槽',
      (function () {
        try { p.window[GATE] = { ticket: null }; } catch (e) { /* frozen */ }
        return p.window[GATE] === undefined;
      })(), String(p.window[GATE]));
    item.dispatch('click', { isTrusted: true });
    await flush();
    check('22.1 闸不可用时【一次宿主写都没有】（cap.fn 不得被调用）',
      host.calls.length === 0, `calls=${JSON.stringify(host.calls)}`);
    check('22.1 闸不可用时 order 一个字节没变',
      JSON.stringify(host.order.map((r) => r.id)) === JSON.stringify(['mvs_a', 'mvs_b', 'mvs_c']),
      JSON.stringify(host.order.map((r) => r.id)));
    check('22.1 calls 不增（没有发出过调用，就不许记账）',
      p.api.state.calls === 0, `calls=${p.api.state.calls}`);
    check('22.1 blocked 增且原因可读',
      p.api.state.blocked === 1 && p.api.state.lastReason === 'gate-unavailable',
      `blocked=${p.api.state.blocked} reason=${p.api.state.lastReason}`);
    check('22.1 busy【不残留】（闸拒绝之后不能看起来像在途）',
      p.api.state.busy === false, `busy=${p.api.state.busy}`);
    check('22.1 ticket 不残留', p.api.state.ticket === null, String(p.api.state.ticket));
    check('22.1 菜单照样关闭（手势发生过，别把菜单吊在半空）',
      mopts.openChanges.length === 1 && mopts.openChanges[0] === false,
      `onOpenChange calls=${JSON.stringify(mopts.openChanges)}`);
    // r5.1: the transition is asserted as ONE thing, from the same single
    // source of state (mopts): seeded open before the click, closed after it.
    // Reading `beforeOpen` before the dispatch and requiring both ends here is
    // what makes this a transition rather than two end-state readings that
    // could each be true for unrelated reasons.
    check('22.1 宿主受控 open 状态真的发生 true -> false 的跃迁（同一份状态）',
      beforeOpen === true && mopts.open === false,
      `beforeOpen=${beforeOpen} afterOpen=${mopts.open}`);
    check('22.1 界面上有中文文案，不出现机器码',
      /未对宿主做任何写入/.test(p.api.topmostReasonText('gate-unavailable')),
      p.api.topmostReasonText('gate-unavailable'));
  }

  // --- 22.2 the in-flight control: gate is held by another instance ---------
  {
    // A real object, because tickets are per-call identities now: a value we
    // cannot forge from the window is exactly the r3 L1 property, and this
    // test must not weaken it to make itself easy.
    const foreign = Object.freeze({ held: 'other-instance' });
    const p = makePage(undefined, { foreignTicket: foreign });
    const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
    const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
    const { ul } = openMenu(p, dropdown);
    p.api.onContextMenu({ target: rowEl, isTrusted: true });
    p.timers.run();
    const item = topLi(ul);
    check('22.2.0 前置：别人的票确实在共享槽上（是个对象身份）',
      p.window[GATE] && p.window[GATE].ticket === foreign, String(p.window[GATE]));
    item.dispatch('click', { isTrusted: true });
    await flush();
    check('22.2 他人在途时【零宿主写】（这正是共享闸要防的并发）',
      host.calls.length === 0, `calls=${host.calls.length}`);
    // This is a DIFFERENT refusal from 22.1 and the distinction matters:
    // a held ticket means "somebody is mid-call, try again in a moment"
    // (busy), while an unwritable slot means "the gate itself is unusable"
    // (gate-unavailable). Collapsing them would tell the user to wait when
    // waiting cannot help.
    check('22.2 他人在途时是在 busy 门上被拦的（早于取票，理由是 busy）',
      p.api.state.blocked === 1 && p.api.state.lastReason === 'busy',
      `blocked=${p.api.state.blocked} reason=${p.api.state.lastReason}`);
    check('22.2 他人在途时 calls 不增、busy 不残留',
      p.api.state.calls === 0 && p.api.state.busy === false,
      `calls=${p.api.state.calls} busy=${p.api.state.busy}`);
    check('22.2 我们没有覆盖别人的票（没有抢锁）',
      p.window[GATE].ticket === foreign, String(p.window[GATE].ticket));
    // The other instance settles: the gate frees, and the SAME user gesture
    // retried must then go through. A refusal has to be recoverable, or it is
    // a dead end.
    p.window[GATE].ticket = null;
    p.api.onContextMenu({ target: rowEl, isTrusted: true });
    p.timers.run();
    topLi(ul).dispatch('click', { isTrusted: true });
    await flush();
    check('22.2 他人释放后，同一个手势再点一次【就能成功】（拒绝不是死路）',
      host.calls.length === 1 && host.calls[0][2] === 0,
      JSON.stringify(host.calls));
    check('22.2 成功那次三参齐全，id 落到 order[0]',
      JSON.stringify(host.order.map((r) => r.id)) === JSON.stringify(['mvs_c', 'mvs_a', 'mvs_b']),
      JSON.stringify(host.order.map((r) => r.id)));
  }

  // --- 22.3 the writable control: nothing above may have broken the normal path
  {
    const p = makePage();
    const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
    const { rowEl, dropdown } = makeRow(p, 'mvs_c', host);
    const { ul } = openMenu(p, dropdown);
    p.api.onContextMenu({ target: rowEl, isTrusted: true });
    p.timers.run();
    topLi(ul).dispatch('click', { isTrusted: true });
    await flush();
    check('22.3 对照：闸可写且空闲时，置顶照旧成功（22.1/22.2 不是把功能关掉了）',
      host.calls.length === 1 && p.api.state.calls === 1
      && p.api.state.blocked === 0 && p.api.state.busy === false,
      `calls=${host.calls.length} stateCalls=${p.api.state.calls} blocked=${p.api.state.blocked}`);
    check('22.3 对照：闸对象真的落在 window 上（共享，不是各用一个）',
      p.window[GATE] && typeof p.window[GATE] === 'object' && 'ticket' in p.window[GATE],
      String(p.window[GATE]));
  }
}

console.log(`
pass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-topmost-menu: ALL GREEN' : 'test-topmost-menu: FAILED');
process.exit(fail === 0 ? 0 : 1);
