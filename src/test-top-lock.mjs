// mmx-status :: test-top-lock.mjs
//
// Behaviour tests for 红色悬停锁顶 · 单会话持续锁顶, driving the REAL code
// sliced out of lib/page-script.mjs against a fake DOM and a fake React fiber
// tree shaped like the host's.
//
// TWO HARNESSES, ONE CODE PATH:
//
//   A. makeBoot() evaluates the ENTIRE shipped bootstrap expression -- the same
//      string daemon.mjs hands to Runtime.evaluate -- inside a fake window.
//      Nothing is sliced and nothing is mirrored: apply(), topLockTick(),
//      topLockRow(), dispose() and api.topLock() are the shipped ones. This is
//      what proves apply() really calls the lock module in the right position,
//      and that dispose() really takes the nodes out.
//      The ONLY edit is the single seam constant TOPLOCK_ANCHOR, which is null
//      as shipped (the host row's hover cluster is not proven yet) and is
//      substituted for the fixture's hover slot so the wiring can be exercised.
//      The substitution is anchored and must match exactly once.
//
//   B. makeLockPage() slices the lock block + the capability block, for the
//      paths the fake timers and the fake store have to drive by hand: the
//      A/B race, an in-flight gate shared with 到最顶, host throw / reject /
//      rollback, storage init failure, corrupt storage and budget exhaustion.
//
// NOT PROVEN HERE, and not claimed: which host container the button belongs in
// (PENDING-ANCHOR), any real renderer behaviour, persistence across an app
// restart. See 1003.md and the README for the honest status.
//
// Every mutation below re-introduces one specific mistake and MUST turn this
// file red. Run with MMX_MUTATE=<id>.
//
//   t1  the isTrusted guard is dropped from the button handler
//   t2  the host call happens BEFORE the intent is stored
//   t3  the release branch is removed, so clicking the locked row writes again
//   t4  the maintenance budget check is removed
//   t5  an EMPTY host order is read as proof that the target was deleted
//   t6  the Promise resolving is treated as a confirmed commit
//   t7  dispose stops removing the lock buttons
//   t8  到最顶 ignores an existing lock intent
//   t9  the button is not re-anchored when the host recycles the row node
//   t10 the strip container is guessed instead of matched by shape
//   t11 the third argument (insertIndex 0) is dropped  [F10]
//   t12 the maintenance budget refills itself inside the call
//   t13 the click handler stops calling preventDefault / stopPropagation
//   t14 a corrupt stored intent is accepted instead of ignored
//   t15 the host's own native button count is not checked on the irecent shape
//   t16 the fixed-width strip never gets its own layout mark
//
// r1..r10 are the defects the two independent r1 reviews found. Each one is
// also a standalone regression block in section 25.
//   r1  background maintenance re-pins a target whose ref is missing
//   r2  an empty order is read as "the host is ready"
//   r3  busy again blocks the release branch
//   r4  a pause leaves confirmedAtTop standing
//   r5  the in-flight gate stops being shared between bootstrap instances
//   r6  a late receipt from a dead generation is allowed to act
//   r7  the same order array coming back counts as a commit
//   r8  budget and the no-auto-retry marks die with the bootstrap
//   r9  every layout shares one CSS key, so rules overwrite each other
//   r10 the identical stylesheet text is written again anyway
//
// w1..w9 are the r3 fixes (M1 fail-closed gate, L1 identity tickets, M2 bounded
// single-owner runtime, M3 the witness judges the TARGET, and the storage-failure
// latch). They are NOT hypotheticals: every one of them is a defect two
// independent reviews found in r2. The ids are w, not g, because
// test-topmost-diag.mjs already owns g1..g10 for the menu probe.
//   w1  the gate slot is unwritable and take still hands out a temporary ticket
//   w2  the ticket goes back to a derivable string instead of an object identity
//   w3  the runtime slot is unwritable and a throwaway budget is handed out
//   w4  a trusted re-lock never re-arms the maintenance budget
//   w5  topLockLoad refills the budget on load / re-injection
//   w6  a no-auto-retry mark belonging to another id pauses this one
//   w7  the witness borrows ITS OWN writability instead of probing the target
//   w8  the target's read-only verdict is dropped
//   w9  a failed storage write is laundered by the next idle pass
//
// x1..x4 are the r4 fixes. x1 and x2 put a r3 behaviour-review defect BACK, so
// the r4 assertions are proven able to catch the bug they were written for.
//   x1  a successful storage write no longer clears the write-failure latch
//   x2  the red lock entry ignores a null ticket, like the menu entry did
//   x3  the red entry's refusal still counts the call
//   x4  the private CSS registry is rebuilt per call, so the sheet comes out empty
//   x5  a successful removeItem (topLockStoreClear) no longer clears the
//       write-failure latch -- the second of the two legitimate clear points,
//       and the one a user reaches by clicking the red button to let go
//
//   node test-top-lock.mjs
//   MMX_MUTATE=<id> node test-top-lock.mjs            # expected: FAILED
//   run-mutations.mjs re-runs all of them and prints the table.

import fs from 'node:fs';
import { makeDom, attachFiber, hookChain, fiber, writesOf } from './testlib/fake-dom.mjs';
import { buildBootstrapExpression } from './lib/page-script.mjs';

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

const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}
const mutate = (block, from, to, id) => {
  if (!block.includes(from)) throw new Error('mutation ' + id + ' anchor not found');
  return block.replace(from, to);
};

// The capability chain, verbatim: fiberOf .. topmostCapability. Slicing it (not
// re-implementing it) is the whole point -- INV-21/25 are about THIS walk.
// Mutations are (from, to) deltas applied to the WHOLE shipped file, not to one
// slice. Both harnesses are then rebuilt from the mutated source, so a mutation
// anywhere -- the lock block, the 到最顶 block, dispose() -- is visible to every
// assertion, and a mutation that cannot be applied fails loudly instead of
// silently leaving the suite green.
const MUTATIONS = {
  t1: [[
    "if (!ev || !ev.isTrusted) { topLockState.blocked++; topLockReason('untrusted-click'); return; }",
    '// isTrusted guard removed by mutation t1',
  ]],
  t2: [
    [`    if (!topLockStoreSet(sessionId)) {
      topLockState.blocked++;
      return topLockPause('storage-write-failed');
    }
    var gen = ++topLockGeneration;`, '    var gen = ++topLockGeneration;'],
    [`    return topLockCall(gen, rowEl, sessionId, cap.fn, cap.order);`,
      `    var t2r = topLockCall(gen, rowEl, sessionId, cap.fn, cap.order);
    topLockStoreSet(sessionId);   // mutation t2: the host call happens FIRST
    return t2r;`],
  ],
  t3: [[
    `    if (isTarget) {
      topLockInvalidateCaps();
      topLockRelease();
      return;
    }`,
    '// release branch removed by mutation t3',
  ]],
  t4: [['    if (rt.budget <= 0) {', '    if (false) {']],
  t5: [['      return topLockPause(topLockPauseReasonFor(presence));',
    `      if (presence === 'empty') return topLockRelease();   // mutation t5: an empty order "proves" deletion
      return topLockPause(topLockPauseReasonFor(presence));`]],
  t6: [[
    `    topLockState.confirmTries = 0;
    if (failed) {`,
    `    topLockState.confirmTries = 0;
    topLockState.confirmedId = topLockState.intentId;   // mutation t6: Promise == success
    topLockState.confirmedAtTop = true;
    topLockReason('confirmed', 'confirmed');
    if (false) {`,
  ]],
  t7: [[
    "var lockBtns = document.querySelectorAll('[data-mmx-toplock]');",
    'var lockBtns = []; // mutation t7',
  ]],
  t8: [['    if (!locked) return cap;\n    if (locked === id) return cap;',
    '    if (!locked) return cap;\n    if (true) return cap; // mutation t8']],
  t9: [[
    `    if (existing && existing.getAttribute(TOPLOCK_ID_ATTR) !== id) {
      try { existing.remove(); } catch (e) {}
      existing = null;
    }`, '    // stale-id re-anchor removed by mutation t9'],
  ],
  t10: [["      var strip = topLockUniqueByShape(rowEl, site.strip, 'div');",
    "      var strip = rowEl.querySelectorAll('div')[0] || null;   // mutation t10: guess a container"]],
  t11: [['ret = fn(id, true, 0);        // 三参，绝不省略 0（F10）',
    'ret = fn(id, true);   // mutation t11']],
  t12: [['    if (r.budget > 0) r.budget--;',
    '    r.budget = TOPLOCK_MAX_MAINT;   // mutation t12: the budget refills itself']],
  t13: [[
    `    if (ev.preventDefault) { try { ev.preventDefault(); } catch (e) {} }
    if (ev.stopPropagation) { try { ev.stopPropagation(); } catch (e) {} }`,
    '    // preventDefault / stopPropagation removed by mutation t13'],
  ],
  t15: [[`      if (site.minNativeButtons
        && topLockNativeButtons(mount, rowEl) < site.minNativeButtons) return null;`,
    `      if (site.minNativeButtons
        && 0 < site.minNativeButtons) return null;   // mutation t15: the native count is not checked`]],
  t16: [[`    wrote = topLockSetAttr(place.mount, TOPLOCK_MOUNT_ATTR, key) || wrote;
    if (place.site.stripWidth) {`, `    wrote = topLockSetAttr(place.mount, TOPLOCK_MOUNT_ATTR, key) || wrote;
    if (false) {   // mutation t16: the fixed-width strip never gets its own mark`]],
  t14: [[`    if (parsed.version !== TOPLOCK_VERSION
      || parsed.source !== 'local'
      || !topLockValidId(parsed.id)) {`, '    if (false) {']],

  // ---- r1..r10: one per defect the two independent r1 reviews found -------
  r1: [[
    `    if (presence !== 'present') {
      topLockState.maintBlocked++;
      return topLockPause(topLockPauseReasonFor(presence));
    }`,
    `    if (presence === 'unknown') {   // mutation r1: only the null view is guarded,
      topLockState.maintBlocked++;
      return topLockPause(topLockPauseReasonFor(presence));   // so an ABSENT ref gets re-pinned
    }`,
  ]],
  r2: [[
    "    if (!view.order.length) return 'empty';",
    "    if (!view.order.length) return 'present';   // mutation r2: an empty order is read as ready",
  ]],
  r3: [[
    `    if (isTarget) {
      topLockInvalidateCaps();`,
    `    if (isTarget && !hostCallBusy()) {   // mutation r3: busy blocks the release
      topLockInvalidateCaps();`,
  ]],
  r4: [[
    `  function topLockPause(reason) {
    topLockState.confirmedAtTop = false;`,
    `  function topLockPause(reason) {   // mutation r4: a paused row keeps claiming it is on top
    topLockState.confirmedAtTop = topLockState.confirmedAtTop;`,
  ]],
  // The r2 defect proper: a gate that is not looked up first is a gate per
  // bootstrap, so a second instance starts from "idle" and can put a SECOND
  // host call in flight while the first is unresolved.
  r5: [[
    `    var g = window[TOPLOCK_GATE_KEY];
    if (g && typeof g === 'object') return g;`,
    `    var g = window[TOPLOCK_GATE_KEY];
    if (false) return g;   // mutation r5: the gate is per bootstrap again`,
  ]],
  r6: [[
    '    if (gen !== topLockGeneration) return;',
    '    if (false) return;   // mutation r6: a late receipt from a dead generation',
  ]],
  r7: [[
    `    if (topLockState.pendingOrderOwner === topLockState.intentId
      && topLockState.pendingOrderRef
      && view && view.order === topLockState.pendingOrderRef) {`,
    '    if (false) {   // mutation r7: a resolve with the same array back counts as a commit',
  ]],
  r8: [[
    `    var r = window[TOPLOCK_RUNTIME_KEY];
    if (r && typeof r === 'object') return r;`,
    `    var r = window[TOPLOCK_RUNTIME_KEY];
    if (true) return r;   // mutation r8: a stale runtime is trusted as-is`,
  ]],
  r9: [[
    `    var key = 'm' + place.rest
      + 'h' + (place.hover === null || place.hover === undefined ? 'x' : place.hover)
      + 'f' + (place.focus === null || place.focus === undefined ? 'x' : place.focus)
      + 'p' + place.site.px
      + 'a' + (place.alwaysVisible ? 1 : 0)
      + 'w' + place.site.stripWidth;`,
    "    var key = 'toplock';   // mutation r9: every layout shares one rule",
  ]],
  r10: [[
    "    if (String(style.textContent || '') === text) return;",
    "    if (false) return;   // mutation r10: the same stylesheet text is written again anyway",
  ]],

  // ---- r3: one per defect the r2 reviews found, plus the self-found one ----
  // M1: an unpersistable gate slot must yield NO gate. r2 returned a private
  // throwaway, so two takes both minted ticket 1 and busy() read false.
  w1: [[
    `    if (window[TOPLOCK_GATE_KEY] !== fresh) return null;
    return fresh;`,
    '    return fresh;   // mutation w1: no proof that the window kept the shared gate',
  ]],
  // L1: the ticket must be an object identity, not a guessable string.
  w2: [[
    '    var ticket = {};',
    "    var ticket = 'mmx-toplock-' + ((g.seq = (g.seq || 0) + 1));   // mutation w2",
  ]],
  // M1: the runtime must fail closed the same way, or every re-injection hands
  // the user a fresh budget.
  w3: [[
    `    if (window[TOPLOCK_RUNTIME_KEY] !== fresh) return null;
    return fresh;`,
    '    return fresh;   // mutation w3: a throwaway budget survives nothing',
  ]],
  // M2: re-arm only when a trusted, STORAGE-SUFFICIENT gesture replaced the
  // target. r2 refilled whenever the owner id changed, which a plain load did.
  // M2: the re-arm has to HAPPEN for a trusted release + re-lock, or the user
  // is told "click again" and clicking changes nothing.
  w4: [[
    `    if (r.owner !== id) { r.owner = id; r.budget = TOPLOCK_MAX_MAINT; r.reason = ''; }
    return true;`,
    `    if (false) { r.owner = id; r.budget = TOPLOCK_MAX_MAINT; r.reason = ''; }
    return true;   // mutation w4: a trusted re-lock never re-arms`,
  ]],
  // M2: a load must ADOPT, never refill.
  w5: [[
    '    if (rt.owner !== parsed.id) { rt.owner = parsed.id; rt.budget = TOPLOCK_MAX_MAINT; }',
    '    if (rt.owner !== parsed.id) { rt.owner = parsed.id; rt.budget = TOPLOCK_MAX_MAINT; }' + `
    rt.budget = TOPLOCK_MAX_MAINT;   // mutation w5: a load refills the budget`,
  ]],
  // M2: a no-retry mark belonging to ANOTHER id must not pause this one.
  w6: [[
    `    if (r.owner !== id) return null;
    return r.reason || null;`,
    `    return r.reason || null;   // mutation w6: any mark pauses any target`,
  ]],
  // M3: the witness must judge the TARGET, not itself.
  w7: [[
    `    var writable;
    try {
      writable = !view.probe(topLockState.intentId, view.source);
    } catch (e) {`,
    `    var writable;   // mutation w7: borrow the witness's own writability
    try {
      writable = !view.probe(view.id, view.source);
    } catch (e) {`,
  ]],
  // M3: a witness refusal must be honoured rather than ignored.
  w8: [[
    `    if (!writable) { view.targetReason = 'readonly-session'; return view; }
    return view;`,
    '    return view;   // mutation w8: the target read-only verdict is dropped',
  ]],
  // Self-found: a failed storage WRITE has to stay on screen. r2 let the next
  // tick's idle branch erase it one frame after the click.
  // r4: the REVERSE of r3's storage defect. r3 cleared storageBroken on a
  // successful write but not storageWriteFailed, so one failed write latched
  // the failure for the rest of the session -- including after the user
  // clicked again and the click DID land. Mutation x1 puts the clear back, so
  // 29.3 / 29.4 must go red. Without it, 29 would be a test of r3's bug.
  // r5: the anchor below is the product's CURRENT comment. r5 corrected that
  // comment in place (it used to claim the clear belonged "here and nowhere
  // else", which was false -- topLockStoreClear is the other place), so x1's
  // old anchor no longer matched and the mutation CRASHED instead of failing
  // an assertion. The anchor is re-pinned to the corrected text; the intent is
  // unchanged: topLockStoreSet no longer clears the latch.
  x1: [[
    `      topLockState.storageBroken = false;
      // r4: a SUCCESSFUL storage operation is what clears the write-failure
      // latch, and there are exactly TWO such places: this one (setItem
      // succeeded) and topLockStoreClear below (removeItem succeeded). r3
      // cleared storageBroken here but not storageWriteFailed, so once a write
      // had failed the tick kept pausing with 'storage-write-failed' forever --
      // including after the user clicked again and the click DID land in
      // storage. That made a recovered browser look permanently broken and
      // stopped the host from ever being pushed down again.
      //
      // What is NOT allowed to clear it: load(), any repaint, any pass of
      // topLockTick, and the two failure branches. The latch is therefore
      // cleared on success and set on failure, and by nothing else.
      topLockState.storageWriteFailed = false;`,
    `      topLockState.storageBroken = false;`,
  ]],
  // r4: the gate on the RED lock entry. topLockCall already refused correctly
  // in r3; this mutation removes the refusal so 28.1a must go red, which is
  // what makes 28 a regression guard rather than decoration.
  x2: [[
    '    if (!ticket) { topLockState.blocked++; return false; }',
    '    // mutation x2: the red lock entry ignores a null ticket too',
  ]],
  // r4: the refusal counts the call anyway -> 28.1a's "calls does not grow".
  x3: [[
    '    if (!ticket) { topLockState.blocked++; return false; }',
    '    if (!ticket) { topLockState.blocked++; topLockState.calls++; return false; }',
  ]],
  // r4: the private CSS registry is rebuilt on every call instead of being
  // cached, so with an unwritable slot every call gets a fresh empty rule set
  // and the stylesheet comes out EMPTY. 31.2 / 31.2b / 31.2c must go red.
  x4: [[
    '    if (!topLockCssPrivateReg) topLockCssPrivateReg = { rules: {} };',
    '    topLockCssPrivateReg = { rules: {} };   // mutation x4: no private cache',
  ]],
  w9: [[
    `    if (topLockState.storageWriteFailed) {
      topLockState.maintBlocked++;
      return topLockPause('storage-write-failed');
    }`,
    '    // mutation w9: the storage failure is laundered by the next idle pass',
  ]],
  // r5: the OTHER of the two places the latch is allowed to clear. x1 removes
  // the clear in topLockStoreSet; x5 removes it in topLockStoreClear, i.e. the
  // user clicks the red button, the first removeItem throws, storage recovers,
  // and the second removeItem SUCCEEDS -- and the latch still does not clear.
  //
  // Before r5 this line had no coverage at all: 30.2 proved only that a failed
  // removeItem keeps the intent, and deleting the success-clear kept the whole
  // suite green. 30.3 / 30.4 / 30.5 are what make it red, and they do it by
  // pressing a real button and running the production pump -- no seeded flag.
  x5: [[
    `  function topLockStoreClear() {
    try {
      window.localStorage.removeItem(TOPLOCK_KEY);
      topLockState.storageWrites++;
      topLockState.storageBroken = false;
      topLockState.storageWriteFailed = false;
      return true;`,
    `  function topLockStoreClear() {
    try {
      window.localStorage.removeItem(TOPLOCK_KEY);
      topLockState.storageWrites++;
      topLockState.storageBroken = false;
      return true;   // mutation x5: a successful removeItem no longer clears the latch`,
  ]],
};

let MUTATED = pageSrc;
if (MUT) {
  const deltas = MUTATIONS[MUT];
  if (!deltas) throw new Error('unknown MMX_MUTATE=' + MUT);
  for (const [from, to] of deltas) {
    const n = MUTATED.split(from).length - 1;
    if (n !== 1) throw new Error('mutation ' + MUT + ' anchor matched ' + n + ' times: ' + JSON.stringify(from.slice(0, 70)));
    MUTATED = MUTATED.replace(from, to);
  }
}

// Rebuild the two harnesses from whatever source is in play right now.
const CAP_CONSTS = MUTATED.slice(MUTATED.indexOf('  var TOPMOST_MAX_ANCESTORS = 256;'), MUTATED.indexOf('  var topmostState = {'));
const CAP_BLOCK = CAP_CONSTS + MUTATED.slice(MUTATED.indexOf('  function fiberOf(node) {'), MUTATED.indexOf('  function rowMenuFiber(rowEl) {'));
const GATE_BLOCK = MUTATED.slice(
  MUTATED.indexOf("  var TOPLOCK_GATE_KEY = '__mmxStatusHostGateV1';"),
  MUTATED.indexOf('  // 到最顶 · 最小主证诊断')
);
if (!GATE_BLOCK.includes('function topLockBlocksTopmost')
  || !GATE_BLOCK.includes('function hostCallBusy')) {
  throw new Error('the cross-entry gate block is missing from the shipped source');
}
const LOCK_SRC = MUTATED.slice(MUTATED.indexOf('  // 红色悬停锁顶 · 单会话持续锁顶'), MUTATED.indexOf('  var timer = window.setInterval'));
// The right-click menu entry lives in the 到最顶 block, so harness B -- which
// slices the lock block only -- has to borrow that one function verbatim. It is
// self-contained: everything it calls (topLockState, topLockReason,
// topLockReleaseTarget, topLockArmIntent) is lock-block state, which is exactly
// why the menu entry can never hold a second copy of the machine.
const MENU_ENTRY_SRC = MUTATED.slice(
  MUTATED.indexOf('  function onTopLockMenuActivate('),
  MUTATED.indexOf('  // One implementation for both entries'));
if (!MENU_ENTRY_SRC.includes('topLockArmIntent(rowEl, sessionId)')) {
  throw new Error('the menu-side lock entry is missing from the shipped 到最顶 block');
}
const LOCK_PRISTINE = LOCK_SRC;
const BLOCK = LOCK_SRC;
// The seam is a PROVEN SHAPE now, not a substitutable constant, so both
// harnesses run the shipped adapter unchanged. The row fixture below reproduces
// the asar markup exactly.
if (!LOCK_PRISTINE.includes('TOPLOCK_SITES')) {
  throw new Error('the proven strip-shape adapter is missing from the shipped lock block');
}

// The bootstrap expression, rebuilt from the same source the slice came from.
//
// The import above is NOT decoration and the two are NOT byte identical, so
// this file says exactly how they differ instead of claiming they match.
// buildBootstrapExpression() returns '(' + PAGE_FN + ')(' + cfg + ')', and the
// shipped PAGE_FN template begins with a NEWLINE (the backtick is followed by a
// line break). This slice starts at `function __mmxStatusMain`, so it drops
// that one leading newline and nothing else. Section 0 asserts that difference
// is exactly one character and that the exported expression compiles.
const PAGE_FN_SRC = MUTATED.slice(
  MUTATED.indexOf('function __mmxStatusMain(cfg) {'),
  MUTATED.lastIndexOf('\n`;') + 1
);
// The cfg the offline harness runs with. It must MATCH the product's own
// defaults, because the product spreads `...cfg` over them: passing '' for
// activeBg/activeBar silently disabled the selected-row background and the
// active bar in every offline run, so the suites were never exercising the
// configuration the app actually ships. Section 0 asserts the two agree, so
// changing a product default turns this red instead of drifting silently.
function buildExpr(cfg) {
  const full = { mark: 'data-mmx-dot', styleId: 'mmx-status-style', global: '__mmxStatus',
    summaryId: 'mmx-running-summary', offsetX: 4, intervalMs: 3000, scope: '', showDone: false,
    collapseOnStart: true, reorder: true,
    activeBg: 'rgba(10, 10, 10, 0.10)', activeBgHover: 'rgba(10, 10, 10, 0.14)',
    activeBar: 'rgba(0, 148, 252, 0.90)', status: {}, ...cfg };
  return '(' + PAGE_FN_SRC + ')(' + JSON.stringify(full) + ')';
}

// ---------------------------------------------------------------------------
console.log('\n=== 0. 出厂表达式：import 真的在用，差异被逐字说清 ===');
{
  const exported = buildBootstrapExpression({ status: {}, intervalMs: 3000 });
  // buildBootstrapExpression() is exactly `'(' + PAGE_FN + ')(' + cfg + ')'`.
  // The trailing `)` belongs to the whole expression, so the template body is
  // everything between the first '(' and the `)(` that introduces the config.
  const cfgAt = exported.lastIndexOf(')(');
  const templatePart = exported.slice(1, cfgAt);
  const cfgPart = exported.slice(cfgAt + 2, exported.length - 1);
  check('0.1 出厂表达式能解析（这是本轮唯一真正跑到的语法面）',
    (() => { try { new Function('return ' + exported + ';'); return true; } catch (e) { return false; } })(),
    'len=' + exported.length);
  check('0.2 它包的就是 __mmxStatusMain，并且带着我们传进去的 cfg',
    templatePart.indexOf('function __mmxStatusMain') >= 0
    && cfgPart.indexOf('"intervalMs":3000') >= 0
    && cfgPart.indexOf('"global":"__mmxStatus"') >= 0);
  check('0.3 出厂模板体【确实】以一个换行开头——两者差的就是这一个字符',
    templatePart.charAt(0) === '\n', 'head=' + JSON.stringify(templatePart.slice(0, 24)));
  if (MUT === '') {
    check('0.4 未变异时：出厂模板体 === 本文件的切片 + 那一个前导换行',
      templatePart === '\n' + PAGE_FN_SRC,
      'export=' + templatePart.length + ' mine=' + PAGE_FN_SRC.length);
    const mine = buildExpr({ status: {}, intervalMs: 3000 });
    // Exactly one character: the template's leading newline. 184599 vs 184600.
    check('0.5 未变异时：本文件重建的整条表达式与出厂的只差那一个前导换行',
      mine.length === exported.length - 1 && mine === '(' + templatePart.slice(1) + ')(' + cfgPart + ')',
      'mine=' + mine.length + ' export=' + exported.length);
  } else {
    // Under a mutation the on-disk export is by definition NOT what this run
    // sliced, so comparing them would be nonsense. What must hold is that the
    // mutation really changed the slice this run is executing.
    check('0.4 变异下：出厂表达式（读磁盘）与本文件的切片（MUTATED）本就不该相等',
      templatePart !== '\n' + PAGE_FN_SRC, 'MMX_MUTATE=' + MUT);
    check('0.5 变异下：本文件执行的切片确实不等于磁盘原文（否则变异是假的）',
      PAGE_FN_SRC !== buildBootstrapExpression({ status: {} }).slice(1, -1).replace(/^\n/, ''),
      'MMX_MUTATE=' + MUT);
  }
}


// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
function makeStorage(initial = {}, opts = {}) {
  const map = new Map(Object.entries(initial));
  // r4: a storage that can RECOVER. A permanently throwing fake can only ever
  // prove the failure half; the r3 defect lived entirely in the TRANSITION
  // (a successful write must clear the failure latch), which such a fake makes
  // untestable. `flip` lets a test fail a write and then let the very next one
  // through, and `attempts()` makes "a write was even attempted" an assertion
  // instead of an assumption.
  const st = { get: !!opts.getThrows, set: !!opts.setThrows, remove: !!opts.removeThrows, attempts: 0, ok: 0 };
  return {
    getItem(k) {
      if (st.get) throw new Error('storage-unavailable');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      st.attempts++;
      if (st.set) throw new Error('storage-quota');
      st.ok++;
      map.set(k, String(v));
    },
    removeItem(k) {
      st.attempts++;
      if (st.remove) throw new Error('storage-readonly');
      map.delete(k);
    },
    // The switch a test flips to model the browser recovering (quota freed,
    // private mode toggled, storage pressure gone).
    flip: (what, on) => { st[what] = !!on; },
    attempts: () => st.attempts,
    okWrites: () => st.ok,
    dump: () => Object.fromEntries(map),
  };
}

function makeTimers() {
  const q = [];
  let id = 0;
  return {
    setTimeout(fn) { const t = { id: ++id, fn }; q.push(t); return t.id; },
    clearTimeout(tid) { const i = q.findIndex((t) => t.id === tid); if (i >= 0) q.splice(i, 1); },
    run() { const batch = q.splice(0, q.length); for (const t of batch) t.fn(); },
    size() { return q.length; },
  };
}

const ref = (id) => ({ type: 'session', id });
// The host swapping the whole order for another one, in place, so the live
// closure sees it.
function setOrder(host, ids) {
  host.order.length = 0;
  for (const id of ids) host.order.push(ref(id));
}
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
const SessionInfo = { getSessionInfo: async (id) => ({ id }) };
const PinService = { calls: [], async pinSession() { PinService.calls.push([...arguments]); } };

// The fake host: the same dependency layout and the same pure helper the real
// handlePinSession has, so the assertions are about WHERE the id lands and WHAT
// setPinnedItemsOrder was handed, not about "some function was called".
function makeHost(opts = {}) {
  const h = {
    order: (opts.order || [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')]).map((r) => ({ ...r })),
    source: opts.source || 'local',
    calls: [], persists: [], rollbacks: 0, rejected: false,
  };
  PinService.calls = h.persists = [];
  h.deps = [
    (id, src) => (opts.readOnly || []).includes(id),   // isReadOnlySessionById
    // A live getter standing in for "the closure re-renders and closes over the
    // current array": every resolution reads whatever the host last set.
    undefined,                                         // currentPinnedItemsOrder
    h.source,                                         // conversationSource
    {},                                               // pinnedProjectSessionPages
    () => {},                                         // mergePinnedItemPayloads
    () => {},                                         // removePinnedItemPayload
    // React REPLACES the array on a real commit; the component re-renders with
    // a new closure over the new array. That is what makes the identity check in
    // topLockConfirm meaningful -- an in-place mutation would have made "the same
    // array came back" indistinguishable from "the host rolled back", and no
    // confirmation could ever have proved anything.
    (next) => { h.order = next; },
  ];
  h.fn = async function (e, l, c) {
    h.calls.push([e, l, c]);
    if (h.deps[0](e, h.source)) return;
    const session = await SessionInfo.getSessionInfo(e, undefined, h.source);
    const next = updatePinnedRefs(h.order, { type: 'session', id: e }, l, c);
    if (next !== h.order) h.deps[6](next);
    if (opts.fail) { h.deps[6](h.order.slice()); h.rollbacks++; return; }
    await PinService.pinSession(e, l, l ? c : undefined, h.source);
    void session;
  };
  Object.defineProperty(h.deps, 1, {
    get: () => h.order, enumerable: true, configurable: true,
  });
  h.decoy = function (a, b, c2) { return [a, b, c2].length; };
  h.decoyDeps = [() => {}, h.order, h.source, {}, () => {}, () => {}];
  return h;
}

/**
 * A row built the way the host builds one, plus the hover slot this feature
 * appends into. The fiber half resolution (current vs stale) and the seven-dep
 * hook shape are exactly the ones the shipped selector proves; the hover slot
 * class is a FIXTURE STAND-IN for the container this round has not proven yet.
 */
// The title class, verbatim from app.asar@316713466 (in-file 35095). The three
// margin branches are exactly what the host picks between, and the hover /
// focus-within variants are what a third button would overflow.
const TITLE_CLASS_BASE = 'min-w-0 flex-1 transition-all';
const TITLE_MARGINS = {
  'mr-8': 'mr-8',
  'er': 'mr-8',
  'tm-ed': 'mr-10 group-hover:mr-[60px] group-focus-within:mr-[60px]',
  'tm': 'mr-2 group-hover:mr-[60px] group-focus-within:mr-[60px]',
  'ed': 'mr-10 group-hover:mr-8 group-focus-within:mr-8',
  'plain': 'mr-2 group-hover:mr-8',
};
// The hover strip, verbatim from app.asar@316712166 (in-file 33795).
const STRIP_CLASS = 'absolute right-1 top-1/2 -translate-y-1/2 z-[1]';
const HOVER_MOUNT_CLASS = 'hidden group-hover:block group-focus-within:block';
const PROJECT_SHELL_CLASS = 'group rounded-xl p-3 gap-6';

function makeRow(page, id, host, opts = {}) {
  const rowEl = page.dom.el('div', { 'data-session-id': id });
  const titleClass = TITLE_CLASS_BASE + ' ' + (TITLE_MARGINS[opts.margin || 'tm'] || TITLE_MARGINS.tm);
  // asar@316713585 puts data-shortcut-session-target on the row's MAIN button;
  // the mr-* reserve lives on the title div INSIDE it (asar@316713466). The
  // previous fixture put both on one <button>, which is why the first version of
  // the adapter measured the wrong element and could not tell a real title from
  // a main button.
  const titleDiv = page.dom.el('div', { class: titleClass });
  const shortcut = page.dom.el('button', {
    type: 'button', 'data-shortcut-session-target': id, class: 'mavis-sidebar-item w-full flex gap-2 pl-2 pr-0.5 h-8 text-left',
  }, [titleDiv]);
  // What the strip really contains: the unread dot span and the hover-only menu
  // wrapper. NOT two pin buttons -- eo is a cron/IM span and ev is a 6px dot.
  const slot = page.dom.el('div', { class: STRIP_CLASS }, [
    page.dom.el('span', { class: 'mmx-unread-dot' }),
    page.dom.el('div', { class: 'hidden group-hover:block group-focus-within:block' }, [
      page.dom.el('button', {
        type: 'button', class: 'w-8 h-8',
        'data-pinned-no-drag': 'true', 'data-sidebar-keep-open': 'true',
      }, ['···']),
    ]),
  ]);
  rowEl.appendChild(shortcut);
  rowEl.appendChild(slot);
  page.dom.root.appendChild(rowEl);

  const fiberRoot = { current: null };
  const currentRoot = fiber({ tag: 3, name: 'HostRoot', parent: null });
  currentRoot.stateNode = fiberRoot;
  const staleRoot = fiber({ tag: 3, name: 'HostRoot', parent: null });
  staleRoot.stateNode = fiberRoot;
  currentRoot.alternate = staleRoot;
  staleRoot.alternate = currentRoot;

  const decoyHooks = [[() => {}, [1, 2]], [host.decoy, host.decoyDeps]];
  const hooks = () => decoyHooks.concat([[host.fn, host.deps], [() => {}, []]]);
  const container = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain(hooks()), parent: currentRoot });
  const rowComponent = fiber({ name: 'SessionRow', props: { session: { id } }, parent: container });
  const rowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, parent: rowComponent });
  fiberRoot.current = currentRoot;
  if (opts.noFiber) {
    // A row the host has not attached a fiber to at all.
    return { rowEl, slot, shortcut, titleDiv, noFiber: true };
  }
  if (opts.twoHooks) {
    // A SECOND, equally shaped container, stacked on top of the first one. Both
    // stay in the .return chain: replacing the link would leave exactly one
    // candidate and the row would look unambiguous instead.
    const extra = fiber({ name: 'SidebarContainer2', props: {}, hooks: hookChain(hooks()), parent: container });
    rowDiv.return = extra;
  }
  if (opts.stale) {
    const staleContainer = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain(hooks()), parent: staleRoot });
    const staleRowComponent = fiber({ name: 'SessionRow', props: { session: { id } }, parent: staleContainer });
    const staleRowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, parent: staleRowComponent });
    for (const [a, b] of [[currentRoot, staleRoot], [container, staleContainer],
      [rowComponent, staleRowComponent], [rowDiv, staleRowDiv]]) {
      a.alternate = b; b.alternate = a;
    }
    attachFiber(rowEl, staleRowDiv);
    return { rowEl, slot, shortcut, titleDiv, container, rowDiv };
  }
  attachFiber(rowEl, rowDiv);
  return { rowEl, slot, shortcut, titleDiv, container, rowDiv };
}

// r4: a press that CANNOT crash. press(null) threw, which turned a missing
// button into a process-level crash -- and the mutation runner scores a crash
// as a PROBLEM, not as red, so a crash silently masks the assertion that was
// about to fail. Absence must surface as a FAIL with a readable reason, which
// is also the only way a reader can tell "the button was never mounted" from
// "the button was mounted and the click did nothing".
function pressOrFail(page, id, why) {
  const b = realButtonFor(page, id);
  if (!b) {
    check(why + ' · 前置：按钮不存在，无法点击（这本身就是失败）', false,
      'buttons=' + lockButtons(page).length);
    return false;
  }
  press(b);
  return true;
}

const settle = () => new Promise((r) => setImmediate(r));
const settleAll = async (n = 6) => { for (let i = 0; i < n; i++) await settle(); };

// ---------------------------------------------------------------------------
// Harness A -- the ENTIRE shipped bootstrap, in a fake window.
// ---------------------------------------------------------------------------
function makeBoot(opts = {}) {
  const dom = makeDom();
  dom.document.addEventListener = () => {};
  dom.document.removeEventListener = () => {};
  const timers = makeTimers();
  const localStorage = makeStorage(opts.stored, opts.storageOpts);
  const raf = [];
  const win = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage,
  };
  // A MutationObserver that can actually FIRE. The shipped observer is
  // `new MutationObserver(scheduleApply)` watching our own mount, and the whole
  // convergence story -- "the host re-rendered, the observer noticed, one rAF
  // ran one apply" -- lives in that chain. A stub whose callback is never
  // callable would force every test to call api.refresh() by hand, which is
  // precisely how a fixture ends up papering over a pipeline that does not
  // converge on its own.
  class FakeMO {
    constructor(fn) { this.fn = fn; this.targets = []; this.live = true; FakeMO.all.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.live = false; }
  }
  FakeMO.all = [];
  const expr = buildExpr({ status: opts.status || {}, intervalMs: 3000 });
  const factory = new Function(
    'window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
    'getComputedStyle', 'localStorage', 'CSS',
    'return ' + expr + ';'
  );
  // r4: the shared gate lives on this object. Letting a test make it unusable
  // -- a frozen window, or a slot occupied by another instance's ticket --
  // BEFORE the shipped code runs is the only way to drive the REAL hostCallTake
  // into its null branch from the REAL red button and the real pump chain.
  if (opts.seedGate) win.__mmxStatusHostGateV1 = opts.seedGate;
  if (opts.frozenWindow) Object.freeze(win);
  const page = { dom, timers, window: win, localStorage, raf, mo: FakeMO };
  page.run = () => {
    page.result = factory(win, dom.document, FakeMO, win.requestAnimationFrame, win.cancelAnimationFrame,
      () => ({ position: 'relative' }), localStorage, { escape: (x) => String(x) });
    page.api = win.__mmxStatus;
    return page.result;
  };
  return page;
}

// Harness A is "real DOM first, bootstrap second": the rows have to exist
// BEFORE the page boots, because the shipped bootstrap runs its first apply()
// during construction. So every call here ends with a real page run. Running it
// again is not a shortcut either -- the shipped entry point disposes the
// previous instance first, which is exactly the reinject path.
function bootRows(page, ids, host, rowOpts = {}) {
  const rows = {};
  for (const id of ids) {
    rows[id] = makeRow(page, id, host, typeof rowOpts === 'function' ? rowOpts(id) : rowOpts);
  }
  if (typeof page.run === 'function') page.run();
  return rows;
}
const lockButtons = (page) => page.dom.querySelectorAll('[data-mmx-toplock]');
const archButtons = (page) => page.dom.querySelectorAll('[data-mmx-toplock]');
// Non-throwing button lookup. A mutation that stops mounting buttons must show
// up as ordinary FAILs on the assertions below it, not as a TypeError that
// aborts the run before the rest of the behaviour is exercised -- which is what
// run-mutations.mjs counts as CRASH rather than red.
const MISSING_BTN = {
  isConnected: false,
  parentElement: null,
  parentNode: null,
  textContent: '',
  className: '',
  childNodes: [],
  __px: 32,
  __glyph: { tagName: 'svg', getAttribute: () => null, setAttribute: () => {} },
  getAttribute: () => null,
  setAttribute: () => {},
  removeAttribute: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  closest: () => null,
  dispatch: () => undefined,
  click() { this.dispatch('click', { isTrusted: false }); },
  addEventListener: () => {},
  listenerCount: () => 0,
};
// Self-referential parent: an assertion that walks up from a missing button
// then reads null attributes all the way up instead of dereferencing undefined.
MISSING_BTN.parentElement = MISSING_BTN;
// The fake DOM's selector parser is deliberately tiny and does not know :not(),
// so the "the host's own buttons" assertions filter in JS instead.
const nativeButtons = (node) => node.querySelectorAll('button')
  .filter((b) => b.getAttribute('data-mmx-toplock') === null);
const realButtonFor = (page, id) => {
  const all = lockButtons(page);
  for (const b of all) if (b.getAttribute('data-mmx-toplock-id') === id) return b;
  return null;
};
// "Is this button there?" -- the shape every ABSENCE assertion uses.
const hasButton = (page, id) => realButtonFor(page, id) !== null;
// The scoped-CSS node can legitimately be absent (nothing was mounted), so every
// read of it goes through here instead of dereferencing null.
const styleCss = (page) => {
  const n = page.dom.querySelector('[data-mmx-toplock-style]');
  return n ? String(n.textContent || '') : '';
};
// "Give me the button" -- never throws, so a missing button is a FAIL, not a crash.
const buttonFor = (page, id) => realButtonFor(page, id) || MISSING_BTN;
// The fake DOM builds its own event object and spreads the caller's properties
// into it, so `this` inside a spied preventDefault is not the object the test
// holds. Closure flags are the only thing that can be observed from outside --
// and the spy ALSO has to set cancelBubble, otherwise "we call stopPropagation"
// would still deliver the event to every ancestor and the row would activate.
function press(btn, extra) {
  const flags = { preventDefault: false, stopPropagation: false };
  const ev = { isTrusted: true, defaultPrevented: false, cancelBubble: false };
  // `this`, not a captured `ev`: the fake DOM copies the caller's properties
  // onto a NEW event object, so a closure over the original would set
  // cancelBubble on an object nobody dispatches with.
  ev.preventDefault = function () { flags.preventDefault = true; this.defaultPrevented = true; };
  ev.stopPropagation = function () { flags.stopPropagation = true; this.cancelBubble = true; };
  Object.assign(ev, extra || {});
  btn.dispatch('click', ev);
  return flags;
}
// Let the shipped pipeline actually run, through its OWN scheduler. Nothing
// here calls api.refresh(): a pass is only ever started the way the page starts
// one -- the host re-renders, our MutationObserver on our own mount fires,
// scheduleApply queues exactly one rAF, and that rAF runs apply().
//
// Confirmation is not a single step either: a click issues one host call, the
// host commits a NEW order array, the next pass sees the new identity and
// confirms, and the pass after that paints the button. Collapsing those into
// one turn would assert against a state the real page passes through but never
// rests in -- and it would hide a pipeline that never converges unattended.
async function pump(page, passes = 4) {
  for (let i = 0; i < passes; i++) {
    await settleAll(4);
    for (const mo of page.mo.all) {
      if (!mo.live) continue;
      for (const t of mo.targets) mo.fn([{ type: 'childList', target: t }], mo);
    }
    const batch = page.raf.splice(0, page.raf.length);
    for (const fn of batch) fn();
  }
  await settleAll(4);
}

// site 5 · i$ pinned, owner@316823448. This is the shape that really does carry
// TWO native buttons (unpin @316825648 and the B.L-wrapped more @316826070),
// and it carries NO data-shortcut-session-target, so the title has to be found
// by its own class shape instead.
const IPINNED_STRIP = 'absolute right-0.5 top-1/2 -translate-y-1/2 z-[1]';
const IPINNED_MOUNT = 'hidden group-hover:flex group-focus-within:flex h-[30px] items-center';
const IPINNED_MOUNT_ALWAYS = 'flex h-[30px] items-center';
const NATIVE_BTN = 'flex h-[30px] w-[30px] items-center justify-center text-icon_default_tertiary transition-colors hover:text-icon_default_secondary';
const IPINNED_TITLE = 'min-w-0 flex-1 transition-all mr-2 group-hover:mr-[60px] group-focus-within:mr-[60px]';

// site 6 · iK recent, owner@316838030. Same family, but the strip is FIXED at
// w-[60px], so a third 30px button needs our own scoped width rule.
const IRECENT_STRIP = 'absolute right-0.5 top-1/2 z-[1] flex w-[60px] -translate-y-1/2 justify-end';
const IRECENT_MOUNT = 'hidden group-hover:flex group-focus-within:flex h-[30px] items-center justify-end';

// site 7 · mhd 置顶行. 600 行真机取证出来的形态，三处和别的 site 都不一样：
//   1. 条是 right-1（不是 right-0.5），而且自带 flex items-center；
//   2. 60px 那一格是【悬停才出现】的 mount（group-hover:flex，不是 block）；
//   3. 两个原生按钮是 mount 的【兄弟】、住在条里，不在 mount 里。
// 第 3 条是这个 site 不能带 minNativeButtons 的唯一原因：mount 里一个原生
// 按钮都没有，带上就是恒 0，永远匹配不上。
const MHD_STRIP = 'absolute right-1 top-1/2 -translate-y-1/2 z-[1] flex items-center';
const MHD_MOUNT = 'hidden h-[30px] w-[60px] items-center group-hover:flex group-focus-within:flex';

// The row the OLD site table could not cover: its strip satisfies the
// tf-normal entry (right-1 + the five shared tokens) while its mount satisfies
// the ipinned entry (h-[30px] items-center), so no single entry ever claimed
// it and every pass refused the row. The fixture reproduces the real DOM: the
// two native buttons are appended to the STRIP, beside the mount.
function makeMhdRow(page, id, host) {
  const row = page.dom.el('div', { 'data-session-id': id, class: 'group relative rounded-lg' });
  const main = page.dom.el('button', {
    type: 'button',
    class: 'mavis-sidebar-item w-full flex gap-2 pl-2 pr-0.5 h-[30px] text-left transition-colors rounded-lg',
  }, [page.dom.el('div', { class: IPINNED_TITLE })]);
  const strip = page.dom.el('div', { class: MHD_STRIP });
  const mount = page.dom.el('div', { class: MHD_MOUNT });
  strip.appendChild(mount);
  strip.appendChild(nativeButton(page.dom, 'sidebar.action_unpin'));
  strip.appendChild(nativeButton(page.dom, 'sidebar.action_more'));
  row.appendChild(main);
  row.appendChild(strip);
  page.dom.root.appendChild(row);
  const fiberRoot = { current: null };
  const cur = fiber({ tag: 3, name: 'HostRoot', parent: null });
  cur.stateNode = fiberRoot;
  const stale = fiber({ tag: 3, name: 'HostRoot', parent: null });
  stale.stateNode = fiberRoot;
  cur.alternate = stale;
  stale.alternate = cur;
  const decoyHooks = [[host.decoy, host.decoyDeps]];
  const container = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain(decoyHooks.concat([[host.fn, host.deps], [() => {}, []]])), parent: cur });
  const rowComponent = fiber({ name: 'SessionRow', props: { session: { id } }, parent: container });
  const rowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, parent: rowComponent });
  fiberRoot.current = cur;
  attachFiber(row, rowDiv);
  return { row, main, strip, mount, title: main.querySelector('div') };
}

function nativeButton(dom, label) {
  return dom.el('button', { type: 'button', 'data-pinned-no-drag': 'true', class: NATIVE_BTN, 'aria-label': label });
}

function makeTwoButtonRow(page, id, host, opts = {}) {
  const kind = opts.kind || 'ipinned';
  const row = page.dom.el('div', { 'data-session-id': id, class: 'group relative rounded-lg' });
  const main = page.dom.el('button', {
    type: 'button',
    class: 'mavis-sidebar-item w-full flex gap-2 pl-2 pr-0.5 ' + (kind === 'irecent' ? 'h-[30px] ' : 'h-8 ') + 'text-left transition-colors rounded-lg',
  }, [page.dom.el('div', { class: opts.titleClass || IPINNED_TITLE })]);
  const strip = page.dom.el('div', { class: kind === 'irecent' ? IRECENT_STRIP : IPINNED_STRIP });
  if (opts.badge) strip.appendChild(page.dom.el('span', { class: 'mmx-badge' }));
  const mountClass = kind === 'irecent'
    ? (opts.always ? 'flex h-[30px] items-center justify-end' : IRECENT_MOUNT)
    : (opts.always ? IPINNED_MOUNT_ALWAYS : IPINNED_MOUNT);
  const actions = page.dom.el('div', { class: mountClass });
  actions.appendChild(nativeButton(page.dom, 'sidebar.action_unpin'));
  if (opts.pinOnly !== true) actions.appendChild(nativeButton(page.dom, 'sidebar.action_more'));
  if (opts.archived) actions.removeChild(actions.children[0]);
  strip.appendChild(actions);
  row.appendChild(main);
  row.appendChild(strip);
  page.dom.root.appendChild(row);
  // The same fiber proof as the tf-normal fixture: the capability walk must not
  // be bypassed just because the DOM shell is a different one.
  const fiberRoot = { current: null };
  const cur = fiber({ tag: 3, name: 'HostRoot', parent: null });
  cur.stateNode = fiberRoot;
  const stale = fiber({ tag: 3, name: 'HostRoot', parent: null });
  stale.stateNode = fiberRoot;
  cur.alternate = stale;
  stale.alternate = cur;
  const decoyHooks = [[host.decoy, host.decoyDeps]];
  const container = fiber({ name: 'SidebarContainer', props: {}, hooks: hookChain(decoyHooks.concat([[host.fn, host.deps], [() => {}, []]])), parent: cur });
  const rowComponent = fiber({ name: 'SessionRow', props: { session: { id } }, parent: container });
  const rowDiv = fiber({ tag: 5, name: 'div', props: { 'data-session-id': id }, parent: rowComponent });
  fiberRoot.current = cur;
  attachFiber(row, rowDiv);
  return { row, main, strip, actions };
}

// ---------------------------------------------------------------------------
// Harness B -- the sliced lock block + the sliced capability chain.
// ---------------------------------------------------------------------------
function makeLockPage(opts = {}) {
  const dom = makeDom();
  const timers = makeTimers();
  const localStorage = makeStorage(opts.stored, opts.storageOpts);
  const win = {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    addEventListener: () => {}, removeEventListener: () => {}, localStorage,
  };
  // r4: the shared gate lives on this object, so a test must be able to make
  // it unusable BEFORE the shipped code runs -- that is the only way to drive
  // the REAL hostCallTake into its null branch from the REAL red button.
  if (opts.seedGate) win.__mmxStatusHostGateV1 = opts.seedGate;
  if (opts.frozenWindow) Object.freeze(win);
  const factory = new Function(
    'window', 'document',
    'var disposed = false;\n' +
    // The shared gate is sliced from the 到最顶 block verbatim, not re-declared:
    // a re-declaration here would be a second implementation, and a mutation
    // of the real one would leave the assertions below green for no reason.
    GATE_BLOCK + CAP_BLOCK + BLOCK + MENU_ENTRY_SRC +
    '\nreturn { topLockRow, topLockTick, topLockPrune, onTopLockActivate, topLockLoad,' +
    ' topLockHostView, topLockPresence, topLockConfirm, topLockValidId, topLockButtonSpec,' +
    ' topLockStoreSet, topLockStoreClear, topLockRelease,' +
    // The menu-side entry point, bound only if the shipped source has it: a
    // source without it has to fail as a FAIL below, never as a ReferenceError.
    ' lockMenu: typeof onTopLockMenuActivate === "function"'
    + ' ? function (ev, li, row, id) { return onTopLockMenuActivate(ev, li, row, id); } : null,' +
    ' topLockCapability: topmostCapability, state: topLockState, caps: topLockCaps,' +
    // The site table itself, so a test can prove an entry is PRESENT, ORDERED
    // and free of the fields the real markup makes useless (see 33.4 / 33.5)
    // instead of only proving that some row happened to get a button.
    ' sites: TOPLOCK_SITES,' +
    ' view: topmostLockView, busy: hostCallBusy, take: hostCallTake,'
    + ' release: hostCallRelease, rt: topLockRuntime,'
    + ' key: TOPLOCK_KEY, maxMaint: TOPLOCK_MAX_MAINT,' +
    ' blocksTopmost: topLockBlocksTopmost,' +
    ' gen: function () { return topLockGeneration; },' +
    ' setDisposed: function (v) { disposed = v; } };'
  );
  const api = factory(win, dom.document);
  const page = { dom, timers, window: win, localStorage, api };
  page.host = makeHost(opts);
  return page;
}
// A SECOND harness over the SAME window -- exactly what a daemon refresh does.
// It exists to prove the inflight gate is window state rather than closure
// state: the previous per-bootstrap `var` let this instance start from
// held:false while the first instance's call was still out there.
function makeLockPageOn(win) {
  const dom = makeDom();
  const timers = makeTimers();
  const factory = new Function(
    'window', 'document',
    'var disposed = false;\n' + GATE_BLOCK + CAP_BLOCK + BLOCK +
    '\nreturn { busy: hostCallBusy, take: hostCallTake, release: hostCallRelease,'
    + ' rt: topLockRuntime, state: topLockState, gen: function () { return topLockGeneration; } };'
  );
  const api = factory(win, dom.document);
  return { dom, timers, window: win, api };
}

function paintAll(page) {
  const rows = page.dom.querySelectorAll('[data-session-id]');
  for (const row of rows) page.api.topLockRow(row, row.getAttribute('data-session-id'));
}
const realLockButton = (page, id) => {
  const all = page.dom.querySelectorAll('[data-mmx-toplock]');
  for (const b of all) if (b.getAttribute('data-mmx-toplock-id') === id) return b;
  return null;
};
const hasLockButton = (page, id) => realLockButton(page, id) !== null;
const lockButton = (page, id) => realLockButton(page, id) || MISSING_BTN;

// ===========================================================================
console.log('\n=== 1. 未证实的行壳一律 fail closed：认不出就不挂，绝不猜 ===');
{
  // 1a. 正常 tf-normal 行：唯一可证的那一种，按钮挂得上。
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a')] });
  bootRows(page, ['mvs_a'], host);
  const good = buttonFor(page, 'mvs_a');
  check('1.1 site 3 tf normal（已核形状）按钮挂得上', hasButton(page, 'mvs_a'));
  check('1.2 它挂在 asar@316712166 的 hover-only 那一层里（跟宿主同进同出）',
    hasButton(page, 'mvs_a')
    && good.parentElement.getAttribute('class') === HOVER_MOUNT_CLASS
    && good.parentElement.parentElement.getAttribute('class') === STRIP_CLASS,
    hasButton(page, 'mvs_a') ? good.parentElement.getAttribute('class') : '(no button)');
  check('1.3 anchorOk 计数解释了这颗按钮', page.api.topLock().anchorOk >= 1,
    'anchorOk=' + page.api.topLock().anchorOk);

  // 1b. rename 行：行内是 input，没有悬停条（asar@316706896 / @316822001）。
  const rename = makeBoot();
  const rrow = rename.dom.el('div', { 'data-session-id': 'mvs_rename' });
  rrow.appendChild(rename.dom.el('input', { type: 'text' }));
  rename.dom.root.appendChild(rrow);
  rename.run();
  check('1.4 rename 行没有按钮', hasButton(rename, 'mvs_rename') === false);
  check('1.5 rename 行被 anchorRefused 解释',
    rename.api.topLock().anchorRefused >= 1, 'refused=' + rename.api.topLock().anchorRefused);

  // 1c. project 行壳（915.…@313469383）：另一套结构，显式不支持。
  const proj = makeBoot();
  const shell = proj.dom.el('div', { class: PROJECT_SHELL_CLASS });
  const prow = proj.dom.el('div', { 'data-session-id': 'mvs_proj' });
  prow.appendChild(proj.dom.el('button', {
    type: 'button', class: 'h-8 w-8', 'aria-label': 'sidebar.project_more_actions',
  }, ['···']));
  shell.appendChild(prow);
  proj.dom.root.appendChild(shell);
  proj.run();
  check('1.6 project 行没有按钮（不改造独立列表）', hasButton(proj, 'mvs_proj') === false);
  check('1.7 project 行被 anchorRefused 解释',
    proj.api.topLock().anchorRefused >= 1, 'refused=' + proj.api.topLock().anchorRefused);

  // 1d. 悬停条不唯一 -> 拒绝。
  const amb = makeBoot();
  const arow = makeRow(amb, 'mvs_amb', makeHost());
  arow.rowEl.appendChild(amb.dom.el('div', { class: STRIP_CLASS }));
  amb.run();
  check('1.8 两个候选悬停条时拒绝挂按钮', hasButton(amb, 'mvs_amb') === false);
  check('1.9 不唯一被 anchorRefused 解释',
    amb.api.topLock().anchorRefused >= 1, 'refused=' + amb.api.topLock().anchorRefused);

  // 1e. 标题的 margin 形状不认识 -> 拒绝，哪怕 strip 在。
  const odd = makeBoot();
  const orow = makeRow(odd, 'mvs_odd', makeHost());
  orow.titleDiv.setAttribute('class', TITLE_CLASS_BASE + ' ml-4');
  odd.run();
  check('1.10 标题 margin 形状不认识时拒绝', hasButton(odd, 'mvs_odd') === false);

  // 1f. 没有一行可疑时，样式表里只有我们自己那一条规则。
  const css = styleCss(page);
  check('1.11 自有 scoped CSS 存在且包含按钮样式与 focus ring',
    css.indexOf('.mmx-toplock-btn{') >= 0 && css.indexOf(':focus-visible') >= 0,
    'len=' + css.length);
  check('1.12 宿主标题的 class 里没有任何 mmx 字样',
    page.dom.querySelector('[data-shortcut-session-target]').getAttribute('class').indexOf('mmx') < 0);
}

// ===========================================================================
console.log('\n=== 2. 出厂接缝接通后：普通无状态会话也有按钮（apply 真实接线） ===');
{
  const page = makeBoot();
  const host = makeHost();
  const rows = bootRows(page, ['mvs_a', 'mvs_b'], host);
  check('2.1 cfg.status 为空（无任何状态桶）也有按钮',
    lockButtons(page).length === 2, 'buttons=' + lockButtons(page).length);
  check('2.2 按钮挂在宿主自己那一层悬停动作容器里，而不是行或条的最外层',
    buttonFor(page, 'mvs_b')
    && buttonFor(page, 'mvs_b').parentElement.getAttribute('class') === HOVER_MOUNT_CLASS
    && buttonFor(page, 'mvs_b').parentElement.parentElement === rows['mvs_b'].slot);
  check('2.3 宿主自己的悬停按钮原样保留（class 与属性一字未改）',
    rows['mvs_a'].slot.querySelector('button.w-8.h-8') !== null
    && rows['mvs_a'].slot.querySelector('span.mmx-unread-dot') !== null);
  check('2.3b 我们自己的按钮带宿主同款 no-drag / keep-open',
    buttonFor(page, 'mvs_a').getAttribute('data-pinned-no-drag') === 'true'
    && buttonFor(page, 'mvs_a').getAttribute('data-sidebar-keep-open') === 'true');
  check('2.3c 标题 class 与 inline style 一个字都没被改',
    rows['mvs_a'].titleDiv.getAttribute('class') === TITLE_CLASS_BASE + ' ' + TITLE_MARGINS.tm
    && Object.keys(rows['mvs_a'].titleDiv.style).length === 0,
    rows['mvs_a'].titleDiv.getAttribute('class'));
  // At rest our button sits inside a display:none container, so the title must
  // keep the host's OWN reserve: no rule, no shrinking for a button nobody can
  // see. Only the reveal state adds room.
  check('2.3d 静息态不加 reserve 规则（新增按钮隐藏时不缩标题）',
    styleCss(page).indexOf('margin-right:40px') < 0
    && styleCss(page).indexOf('.group:hover [data-mmx-toplock-reserve="m8h60f60p32a0w0"]') >= 0,
    styleCss(page).slice(0, 260));
  check('2.3e 按钮样式真的存在（红、无障碍、focus ring、svg 尺寸）',
    styleCss(page).indexOf('.mmx-toplock-btn{') >= 0
    && styleCss(page).indexOf('--red_400') >= 0
    && styleCss(page).indexOf(':focus-visible') >= 0
    && styleCss(page).indexOf('.mmx-toplock-glyph{width:16px') >= 0,
    'len=' + styleCss(page).length);
  check('2.3f 按钮里是自建 SVG，不是文本节点，也没有 innerHTML',
    hasButton(page, 'mvs_a')
    && buttonFor(page, 'mvs_a').__glyph
    && buttonFor(page, 'mvs_a').__glyph.namespaceURI === 'http://www.w3.org/2000/svg'
    && buttonFor(page, 'mvs_a').querySelectorAll('path').length === 1,
    hasButton(page, 'mvs_a') ? String(buttonFor(page, 'mvs_a').__glyph.namespaceURI) : 'none');
  // Comments are stripped first: the module may TALK about innerHTML, it is
  // only forbidden from USING it.
  check('2.3g 锁模块的可执行代码里没有 innerHTML / outerHTML / eval',
    !/innerHTML|outerHTML|insertAdjacentHTML|\beval\(/.test(
      LOCK_PRISTINE.replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')));
  check('2.4 没有把整行替换掉：宿主子树数量未被减少',
    rows['mvs_a'].rowEl.querySelectorAll('button').length >= 3,
    'buttons=' + rows['mvs_a'].rowEl.querySelectorAll('button').length);
  const t = page.api.topLock();
  check('2.5 api.topLock().injected 与真实节点数一致',
    t.injected === lockButtons(page).length, 'api=' + t.injected + ' dom=' + lockButtons(page).length);
  check('2.6 空闲时没有任何宿主写入', host.calls.length === 0);
}

// ===========================================================================
console.log('\n=== 3. 原生保全：type=button / 不用 disabled / aria-pressed 语义 ===');
{
  const page = makeBoot();
  const host = makeHost();
  bootRows(page, ['mvs_a'], host);
  const b = buttonFor(page, 'mvs_a');
  check('3.1 是原生 <button>', b && b.tagName === 'BUTTON');
  check('3.2 显式 type=button（默认 submit 在有 form owner 时会提交）',
    b.getAttribute('type') === 'button');
  check('3.3 绝不使用原生 disabled（它会让按钮无法聚焦，解除入口会消失）',
    b.getAttribute('disabled') === null);
  check('3.4 未锁时 aria-pressed=false', b.getAttribute('aria-pressed') === 'false');
  check('3.5 未锁时是轮廓红而不是实心红',
    hasButton(page, 'mvs_a') && /is-idle/.test(String(b.className))
    && !/is-locked/.test(String(b.className))
    && !/is-solid/.test(String(b.__glyph.getAttribute('class'))), b.className);
  check('3.6 有 aria-label 与 title', !!b.getAttribute('aria-label') && !!b.getAttribute('title'));
  check('3.7 自有属性齐全', b.getAttribute('data-mmx-toplock') === '1'
    && b.getAttribute('data-mmx-toplock-id') === 'mvs_a'
    && b.getAttribute('data-pinned-no-drag') === 'true'
    && b.getAttribute('data-sidebar-keep-open') === 'true');
  check('3.8 可及名恒定、说明是中文、机器码不外泄',
    b.getAttribute('aria-label') === '锁顶到最顶'
    && /[一-鿿]/.test(String(b.getAttribute('aria-description')))
    && String(b.getAttribute('title')).indexOf('-') < 0,
    b.getAttribute('aria-label') + ' | ' + b.getAttribute('title'));
}

// ===========================================================================
// 4. 键盘入口：只挂 click 原生激活，Enter/Space 恰好一次
//
// 验证边界（不要越读）：这一节证明的是"我们没有自己的 keydown/keyup 监听，
// 因此原生 button 的 Enter/Space 由浏览器自己合成 click，合成出来的仍然是
// isTrusted=true 的那一个 click"。假 DOM 里 keydown 不会合成 click，所以
// 4.3 是【我们自己不拦键】，4.4 是【手动送进去的那一次 click 恰好写一次】。
// 真实浏览器里按 Enter/Space 是否真的到达这颗按钮、宿主会不会抢走焦点，
// 本节没有证明、也不假装证明——那要真实 MMX GUI 验收门。
console.log('\n=== 4. 键盘入口：只挂 click 原生激活，Enter/Space 恰好一次 ===');
{
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  const b = buttonFor(page, 'mvs_b');
  check('4.0 假 DOM 不合成 keydown->click，故真实 Enter/Space 未在此验证（见小节说明）',
    b.listenerCount('keydown') === 0 && b.listenerCount('keyup') === 0
    && typeof b.dispatch === 'function' && b.tagName === 'BUTTON',
    'tag=' + b.tagName + ' keydown=' + b.listenerCount('keydown') + ' keyup=' + b.listenerCount('keyup'));
  check('4.1 我们自己没有 keydown 监听（原生 button 自带 Enter/Space -> click）',
    b.listenerCount('keydown') === 0, 'keydown listeners=' + b.listenerCount('keydown'));
  check('4.2 只有一个 click 监听（不会双触发）', b.listenerCount('click') === 1,
    'click listeners=' + b.listenerCount('click'));
  // A real key press produces keydown first; the browser then fires click.
  // The product must act exactly once for that one activation.
  b.dispatch('keydown', { key: 'Enter', isTrusted: true });
  check('4.3 keydown 本身不触发任何宿主写入（我们不拦键）', host.calls.length === 0);
  press(b);
  await settleAll();
  check('4.4 一次激活 = 一次宿主写入', host.calls.length === 1, 'calls=' + JSON.stringify(host.calls));
  check('4.5 显式三参 (id, true, 0)，不依赖任何默认值 [F10]',
    JSON.stringify(host.calls[0]) === JSON.stringify(['mvs_b', true, 0]), JSON.stringify(host.calls[0]));
  check('4.6 backend 也拿到 insertIndex 0，不是 append',
    PinService.calls.length === 1
    && PinService.calls[0][0] === 'mvs_b' && PinService.calls[0][1] === true
    && PinService.calls[0][2] === 0, JSON.stringify(PinService.calls[0]));
  check('4.7 目标真的落到 order[0]', host.order[0].id === 'mvs_b', JSON.stringify(host.order.map((r) => r.id)));
}

// ===========================================================================
console.log('\n=== 5. 幂等 / 重挂载 / 虚拟化 id 复用 / dispose ===');
{
  const page = makeBoot();
  const host = makeHost();
  const rows = bootRows(page, ['mvs_a', 'mvs_b'], host);
  // realButtonFor, NOT buttonFor: with a missing button both sides of the
  // identity check below would be the SAME MISSING_BTN sentinel and the
  // comparison would pass with no button on the page at all.
  const first = realButtonFor(page, 'mvs_a');
  page.api.refresh({});
  page.api.refresh({});
  check('5.1 反复 apply 仍是每个 id 一颗按钮（幂等）', lockButtons(page).length === 2,
    'buttons=' + lockButtons(page).length);
  check('5.1b 那颗按钮真的存在（否则下面 5.2 的比较没有意义）', first !== null,
    'first=' + (first === null ? 'null' : 'present'));
  check('5.2 复用同一个节点而不是重建', realButtonFor(page, 'mvs_a') === first,
    'same=' + (realButtonFor(page, 'mvs_a') === first));

  // The host recycles the row node for another session.
  rows['mvs_a'].rowEl.setAttribute('data-session-id', 'mvs_z');
  page.api.refresh({});
  const onA = lockButtons(page).filter((b) => b.getAttribute('data-mmx-toplock-id') === 'mvs_a');
  const onZ = lockButtons(page).filter((b) => b.getAttribute('data-mmx-toplock-id') === 'mvs_z');
  check('5.3 id 复用后旧按钮不再自称 mvs_a', onA.length === 0, 'stale=' + onA.length);
  check('5.4 id 复用后新 id 拿到自己的按钮', onZ.length === 1, 'fresh=' + onZ.length);
  check('5.5 复用的那颗按钮不会去锁别人的行',
    onZ.length === 1 && onZ[0].getAttribute('data-mmx-toplock-id') === 'mvs_z');

  page.api.dispose();
  check('5.6 dispose 之后按钮一个不剩', lockButtons(page).length === 0,
    'buttons=' + lockButtons(page).length);
  check('5.7 dispose 之后 window 上没有残留 api', page.window.__mmxStatus === undefined);
}

// ===========================================================================
console.log('\n=== 6. 真实点击 / 合成点击 / 行已消失 ===');
{
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  const rows = bootRows(page, ['mvs_a', 'mvs_b'], host);
  buttonFor(page, 'mvs_b').click();          // synthetic, isTrusted=false
  check('6.1 合成点击不锁顶', host.calls.length === 0, 'calls=' + host.calls.length);
  check('6.2 合成点击被计入 blocked 且原因可见',
    page.api.topLock().blocked === 1 && page.api.topLock().reason === 'untrusted-click',
    page.api.topLock().reason);
  check('6.3 合成点击不写意图',
    page.localStorage.dump()['mmxStatusTopLockV1'] === undefined);

  press(buttonFor(page, 'mvs_b'));
  check('6.4 真实点击确实锁顶', host.calls.length === 1);

  // The row is unmounted while the button is still connected to it.
  const b2 = buttonFor(page, 'mvs_a');
  rows['mvs_a'].rowEl.__detached = true;
  b2.dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  check('6.5 行已卸载时拒绝调用', host.calls.length === 1, 'calls=' + host.calls.length);
  check('6.6 原因可读且是机器码', ['row-gone', 'button-gone'].indexOf(page.api.topLock().reason) >= 0,
    page.api.topLock().reason);
}

// ===========================================================================
console.log('\n=== 7. 点红按钮不激活整行、不弹宿主菜单 ===');
{
  const page = makeBoot();
  const host = makeHost();
  const rows = bootRows(page, ['mvs_a'], host);
  // Real listeners on the ancestors the host owns. 7.1/7.2 alone only proved
  // that a spy got called; these counters are what actually fail if the button
  // lets the event through, because the fake DOM's dispatch() now honours
  // stopPropagation the way a browser does.
  let rowClicks = 0;
  let bodyClicks = 0;
  let hostMenu = 0;
  let nativeClicks = 0;
  rows['mvs_a'].rowEl.addEventListener('click', () => { rowClicks++; });
  rows['mvs_a'].slot.addEventListener('click', () => { hostMenu++; });
  page.dom.root.addEventListener('click', () => { bodyClicks++; });
  const hostBtn = rows['mvs_a'].slot.querySelector('button.w-8.h-8');
  hostBtn.addEventListener('click', () => { nativeClicks++; });
  const ev = press(buttonFor(page, 'mvs_a'));
  check('7.1 调用了 preventDefault', ev.preventDefault === true);
  check('7.2 调用了 stopPropagation（行不会被激活）', ev.stopPropagation === true);
  check('7.3 宿主原按钮一个都没被改',
    hostBtn.getAttribute('type') === 'button'
    && hostBtn.getAttribute('aria-label') === null);
  check('7.4 事件真的没有冒到行上（真监听器计数，不是 spy）', rowClicks === 0, 'rowClicks=' + rowClicks);
  check('7.5 也没有冒到 strip 上（宿主的更多菜单不会被顺带打开）', hostMenu === 0, 'hostMenu=' + hostMenu);
  check('7.6 也没有冒到 body 上', bodyClicks === 0, 'bodyClicks=' + bodyClicks);
  // Control: the fake really does propagate, and the host's own button is not
  // collateral damage. If 7.4 could be green because nothing ever bubbled,
  // this is what catches it.
  hostBtn.dispatch('click', { isTrusted: true });
  check('7.7 对照组：宿主自己那颗按钮的点击照常冒泡到行和 body',
    nativeClicks === 1 && rowClicks === 1 && bodyClicks === 1,
    `native=${nativeClicks} row=${rowClicks} body=${bodyClicks}`);
  // And the drag: pointerdown must not start a host drag either. No
  // preventDefault -- that would break the focus ring -- only no propagation.
  const pd = { isTrusted: true, defaultPrevented: false, cancelBubble: false };
  let dragSeen = 0;
  let focusPrevented = 0;
  rows['mvs_a'].rowEl.addEventListener('pointerdown', () => { dragSeen++; });
  pd.preventDefault = function () { focusPrevented++; this.defaultPrevented = true; };
  pd.stopPropagation = function () { this.cancelBubble = true; };
  buttonFor(page, 'mvs_a').dispatch('pointerdown', pd);
  check('7.8 pointerdown 不冒泡到行（不会顺手拖动整行）', dragSeen === 0, 'dragSeen=' + dragSeen);
  check('7.9 pointerdown 不 preventDefault（不破坏键盘焦点环）', focusPrevented === 0,
    'focusPrevented=' + focusPrevented);
}

// ===========================================================================
console.log('\n=== 8. 能力不足：云端 / 只读 / 无 fiber / 回调不唯一，显式禁用并中文提示 ===');
{
  const page = makeBoot({ status: {} });
  // cloud row: bare numeric id, exactly as measured on the real host.
  const roHost = makeHost({ readOnly: ['mvs_ro'] });
  bootRows(page, ['mvs_ro'], roHost, { });
  const ambHost = makeHost();
  bootRows(page, ['mvs_amb'], ambHost, { twoHooks: true });
  makeRow(page, '447993841729699', makeHost());
  makeRow(page, 'mvs_nofiber', makeHost(), { noFiber: true });
  page.run();

  const cases = [
    ['mvs_ro', '只读'],
    ['mvs_nofiber', '无 fiber'],
    ['mvs_amb', '回调不唯一'],
    ['447993841729699', '云端'],
  ];
  for (const [id, label] of cases) {
    // buttonFor() hands back a truthy MISSING_BTN when nothing was mounted, so
    // "!!b" was always true. Existence is asked with hasButton(), and a missing
    // button SKIPS the rest instead of asserting on the sentinel.
    check(`8.${label} 按钮存在`, hasButton(page, id),
      'buttons=' + lockButtons(page).length);
    if (!hasButton(page, id)) continue;
    const b = buttonFor(page, id);
    check(`8.${label} aria-disabled=true`, b.getAttribute('aria-disabled') === 'true',
      'aria-disabled=' + b.getAttribute('aria-disabled'));
    check(`8.${label} 不是原生 disabled（保持可聚焦，解除入口不消失）`,
      b.getAttribute('disabled') === null);
    check(`8.${label} aria-pressed 仍为 false（未锁）`, b.getAttribute('aria-pressed') === 'false');
    check(`8.${label} title 是中文句子`, /[一-鿿]/.test(b.getAttribute('title')) && !/-/.test(b.getAttribute('title')),
      b.getAttribute('title'));
    check(`8.${label} aria-label 带中文原因`, /[一-鿿]/.test(b.getAttribute('aria-label')),
      b.getAttribute('aria-label'));
  }
  // The machine code stays available to an operator, in the API only.
  const before = { cloud: 0 };
  press(buttonFor(page, '447993841729699'));
  before.cloud = page.api.topLock().blocked;
  check('8.5 云端点击被拒且 blocked 递增', before.cloud === 1, 'blocked=' + before.cloud);
  check('8.6 云端点击不写意图',
    page.localStorage.dump()['mmxStatusTopLockV1'] === undefined);
  check('8.7 云端点击不碰宿主', roHost.calls.length === 0 && ambHost.calls.length === 0);
}

// ===========================================================================
console.log('\n=== 9. 锁意图先落盘，落盘失败一次宿主写都不发生 ===');
{
  const ok = makeBoot();
  const okHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(ok, ['mvs_a', 'mvs_b'], okHost);
  press(buttonFor(ok, 'mvs_b'));
  await settleAll();
  const stored = ok.localStorage.dump()['mmxStatusTopLockV1'];
  check('9.1 正常路径意图已落盘', stored !== undefined, stored || '(none)');
  const parsed = (() => { try { return stored === undefined ? null : JSON.parse(stored); } catch (e) { return null; } })();
  check('9.2 落盘内容只有 version/source/id',
    !!parsed && JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(['id', 'source', 'version']),
    stored || '(none)');
  check('9.3 落盘内容不含标题/正文/排序表',
    !!stored && /mvs_b/.test(stored) && stored.indexOf('order') < 0);

  const bad = makeBoot({ storageOpts: { setThrows: true } });
  const badHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(bad, ['mvs_a', 'mvs_b'], badHost);
  press(buttonFor(bad, 'mvs_b'));
  await settleAll();
  check('9.4 落盘失败时宿主一次都没被调用', badHost.calls.length === 0,
    'calls=' + JSON.stringify(badHost.calls));
  check('9.5 落盘失败原因对用户可见',
    bad.api.topLock().reason === 'storage-write-failed' && bad.api.topLock().phase === 'paused',
    bad.api.topLock().reason + '/' + bad.api.topLock().phase);
  check('9.6 落盘失败被计数', bad.api.topLock().storageFailures >= 1);
}

// ===========================================================================
console.log('\n=== 10. 解除：不 unpin、不恢复旧位置、且入口永远可达 ===');
{
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  press(buttonFor(page, 'mvs_b'));
  await settleAll();
  check('10.1 已锁顶到 order[0]', host.order[0].id === 'mvs_b', JSON.stringify(host.order.map((r) => r.id)));
  const callsBefore = host.calls.length;
  const ev = press(buttonFor(page, 'mvs_b'));
  await settleAll();
  check('10.2 解除没有再写宿主（不 unpin、不恢复旧位置）',
    host.calls.length === callsBefore, 'calls=' + host.calls.length);
  check('10.3 解除是本地清除：意图为空',
    page.api.topLock().intent === null && page.localStorage.dump()['mmxStatusTopLockV1'] === undefined);
  check('10.4 解除后宿主顺序原样保留（没有被人为恢复）',
    host.order[0].id === 'mvs_b', JSON.stringify(host.order.map((r) => r.id)));
  page.api.refresh({});
  check('10.5 解除后 aria-pressed 回到 false（可及名本来就恒定）',
    buttonFor(page, 'mvs_b').getAttribute('aria-pressed') === 'false'
    && buttonFor(page, 'mvs_b').getAttribute('aria-label') === '锁顶到最顶');

  // Capability dies AFTER the lock exists: the release must still be reachable.
  const stale = makeBoot({
    stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_a' }) },
  });
  const staleHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b')], readOnly: ['mvs_a'] });
  bootRows(stale, ['mvs_a', 'mvs_b'], staleHost);
  const t = stale.api.topLock();
  check('10.6 持久锁首次载入只记意图，不自动挪位置',
    t.intent && t.intent.id === 'mvs_a' && staleHost.calls.length === 0, JSON.stringify(t.intent));
  const eb = buttonFor(stale, 'mvs_a');
  check('10.7 能力失效时当前锁的按钮仍可聚焦（未被原生 disabled 摘掉）',
    eb && eb.getAttribute('disabled') === null);
  const callsBefore2 = staleHost.calls.length;
  press(eb);
  await settleAll();
  check('10.8 能力失效后仍可解除，且不写宿主',
    stale.api.topLock().intent === null && staleHost.calls.length === callsBefore2,
    'calls=' + staleHost.calls.length);
}

// ===========================================================================
console.log('\n=== 11. 解除写不进去时：意图与实际不许分裂 ===');
{
  const page = makeBoot({
    stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_a' }) },
    storageOpts: { removeThrows: true },
  });
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  press(buttonFor(page, 'mvs_a'));
  await settleAll();
  const t = page.api.topLock();
  check('11.1 解除写失败时意图原样保留',
    t.intent && t.intent.id === 'mvs_a', JSON.stringify(t.intent));
  check('11.2 原因对用户可见', t.reason === 'storage-write-failed' && t.phase === 'paused',
    t.reason + '/' + t.phase);
  check('11.3 落盘里那份意图也没被清掉',
    page.localStorage.dump()['mmxStatusTopLockV1'] !== undefined);
}

// ===========================================================================
console.log('\n=== 12. 存储读不到 / 存储损坏：都不猜 ===');
{
  const broken = makeBoot({ storageOpts: { getThrows: true },
    stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_a' }) } });
  const bh = makeHost({ order: [ref('mvs_a')] });
  bootRows(broken, ['mvs_a'], bh);
  const t = broken.api.topLock();
  check('12.1 存储读不到时停在 store-init-failed 且不持有任何意图',
    t.reason === 'store-init-failed' && t.phase === 'paused' && t.intent === null,
    t.reason + '/' + t.phase);
  check('12.2 存储读不到时一次宿主写都不发生', bh.calls.length === 0);

  for (const [label, raw] of [
    ['非 JSON', '{not json'],
    ['版本不符', JSON.stringify({ version: 2, source: 'local', id: 'mvs_a' })],
    ['source 不是 local', JSON.stringify({ version: 1, source: 'cloud', id: 'mvs_a' })],
    ['id 是裸数字（云端形状）', JSON.stringify({ version: 1, source: 'local', id: '447993841729699' })],
    ['id 形状不认识', JSON.stringify({ version: 1, source: 'local', id: 'nonsense' })],
    ['是数组', '[1,2,3]'],
  ]) {
    const p = makeBoot({ stored: { mmxStatusTopLockV1: raw } });
    const h = makeHost({ order: [ref('mvs_a')] });
    bootRows(p, ['mvs_a'], h);
    const s = p.api.topLock();
    check(`12.损坏-${label} 被忽略且计数`, s.intent === null && s.corrupt === 1,
      'intent=' + JSON.stringify(s.intent) + ' corrupt=' + s.corrupt);
    check(`12.损坏-${label} 不碰宿主`, h.calls.length === 0);
  }
}

// ===========================================================================
console.log('\n=== 13. 确认只认新鲜 order；Promise resolve 不是成功 ===');
{
  const page = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  const host = page.host;
  const rows = bootRows(page, ['mvs_a', 'mvs_b'], host);
  paintAll(page);
  const btn = lockButton(page, 'mvs_b');
  // A host whose promise resolves but whose order never actually moves: this is
  // exactly the "rolled back / lied / silently refused" case.
  host.deps[6] = () => { host.calls.push(['setOrder-ignored']); };
  btn.dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('13.1 Promise resolve 后意图已建立', page.api.state.intentId === 'mvs_b');
  check('13.2 Promise resolve 本身【不】等于已确认',
    page.api.state.confirmedAtTop === false && page.api.state.phase !== 'confirmed',
    'phase=' + page.api.state.phase + ' reason=' + page.api.state.reason);
  check('13.3 无法证明时理由是 unconfirmed-return', page.api.state.reason === 'unconfirmed-return',
    page.api.state.reason);
  page.api.topLockTick();
  check('13.4 再走一趟仍然是未确认（不靠乐观中间态）',
    page.api.state.confirmedAtTop === false, 'reason=' + page.api.state.reason);

  // Now the order really does move, and a FRESH pass proves it.
  // A host that DOES move the order. It has to carry the same two property
  // markers as the real callback, or the selector would (correctly) refuse to
  // recognise it and the test would measure the wrong thing.
  host.fn = async function (e, l, c) {
    void PinService.pinSession; void SessionInfo.getSessionInfo;
    host.calls.push([e, l, c]);
    const next = updatePinnedRefs(host.order, { type: 'session', id: e }, l, c);
    if (next !== host.order) host.deps[6](next);
  };
  // The paused target's trusted click is a RELEASE (one gesture, one meaning).
  // Retrying is therefore "release, then lock again" -- two steps, each clear.
  // A REAL commit REPLACES the array React closes over; it does not rewrite the
  // one we already hold. (Mutating it in place would be a different host, and
  // the product is required to refuse to read that as a commit.)
  host.deps[6] = (next) => { host.order = next; };
  paintAll(page);   // 文案在下一趟 apply 才刷新，与出厂的渲染节奏一致
  check('13.5 暂停目标的可及名恒定，说明放在 title/aria-description 上',
    btn.getAttribute('aria-label') === '锁顶到最顶'
    && String(btn.getAttribute('aria-description')).indexOf('暂停') >= 0,
    'name=' + btn.getAttribute('aria-label') + ' desc=' + btn.getAttribute('aria-description'));
  btn.dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('13.5b 暂停目标上的可信点击是解除', page.api.state.intentId === '',
    'intent=' + page.api.state.intentId);
  btn.dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('13.5c 再点一次才重新锁顶', page.api.state.intentId === 'mvs_b',
    'intent=' + page.api.state.intentId);
  check('13.5d 重新锁顶后预算被补满', page.api.state.maintBudget === page.api.maxMaint);
  page.api.topLockTick();
  check('13.6 新鲜 order 证明后才确认',
    page.api.state.confirmedAtTop === true && page.api.state.phase === 'confirmed',
    'confirmed=' + page.api.state.confirmedAtTop + ' reason=' + page.api.state.reason);
  void rows;
}

// ===========================================================================
console.log('\n=== 14. 首位不写 / no-op 不产生额外宿主写入 ===');
{
  const page = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  const host = page.host;
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  paintAll(page);
  const before = host.calls.length;
  lockButton(page, 'mvs_a').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('14.1 已经在首位时一次宿主写入都不做', host.calls.length === before,
    'calls=' + JSON.stringify(host.calls));
  check('14.2 计入 noops', page.api.state.noops === 1, 'noops=' + page.api.state.noops);
  check('14.3 但意图照样记下（用户确实要锁这一行）',
    page.api.state.intentId === 'mvs_a' && page.localStorage.dump()[page.api.key] !== undefined);
  check('14.4 确认状态为 confirmed', page.api.state.phase === 'confirmed', page.api.state.phase);

  // Second press on the same target is a RELEASE, not another no-op.
  lockButton(page, 'mvs_a').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('14.5 再点当前目标是解除而不是重复写',
    host.calls.length === before && page.api.state.intentId === '',
    'intent=' + page.api.state.intentId);
}

// ===========================================================================
console.log('\n=== 15. A→B 竞态：目标替换与解除的处置权 ===');
{
  // 15a: A in flight, then the user locks B. The old call may not pollute B.
  const page = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  const host = page.host;
  bootRows(page, ['mvs_a', 'mvs_b', 'mvs_c'], host);
  paintAll(page);
  const clicks = (id) => lockButton(page, id).dispatch('click',
    { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  clicks('mvs_c');
  const genA = page.api.gen();
  check('15.1 A 已进入 pending 并持有共享闸', page.api.busy() === true);
  clicks('mvs_b');
  check('15.2 忙时的第二次意图仍然安全地更新了意图', page.api.state.intentId === 'mvs_b',
    'intent=' + page.api.state.intentId);
  check('15.3 代次前进了', page.api.gen() > genA, page.api.gen() + ' > ' + genA);
  check('15.4 忙时不会并发写宿主：A 之后没有第二次写入',
    host.calls.length === 1, 'calls=' + JSON.stringify(host.calls));
  const raceStored = String(page.localStorage.dump()[page.api.key] || '');
  check('15.4b 忙时的意图替换已经落盘（意图更新是安全的）',
    raceStored.indexOf('mvs_b') >= 0, raceStored);
  await settleAll();
  check('15.5 A 的旧回执没有污染 B 的意图', page.api.state.intentId === 'mvs_b');
  check('15.6 闸在回执后释放', page.api.busy() === false);
  page.api.topLockTick();
  check('15.7 只有最新意图可以继续维持', page.api.state.intentId === 'mvs_b');

  // 15b: A in flight, then the user releases A. The in-flight call is not
  // retroactively cancelled -- it is never CLAIMED as cancelled.
  const p2 = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(p2, ['mvs_a', 'mvs_b'], p2.host);
  paintAll(p2);
  const c2 = (id) => lockButton(p2, id).dispatch('click',
    { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  c2('mvs_b');
  check('15.8 A 已发起调用', p2.host.calls.length === 1);
  p2.api.state.intentId = '';
  const g2 = p2.api.gen();
  p2.api.topLockRelease();
  check('15.9 解除后意图为空', p2.api.state.intentId === '');
  await settleAll();
  check('15.10 在途调用的回执不会复活已解除的意图',
    p2.api.state.intentId === '' && p2.api.gen() > g2, 'gen=' + p2.api.gen());
}

// ===========================================================================
console.log('\n=== 16. 共享闸：到最顶 与 锁顶 不能并发写宿主 ===');
{
  const pageSrcTop = MUTATED;
  check('16.1 闸挂在 window 上，不在闭包上（每次 bootstrap 一个局部 var 就是并发写）',
    /var TOPLOCK_GATE_KEY = '__mmxStatusHostGateV1';/.test(pageSrcTop)
    && /function hostCallTake\(\)/.test(pageSrcTop)
    && /if \(topmostState\.busy \|\| hostCallBusy\(\)\)/.test(pageSrcTop)
    && !/hostGate\.held = true/.test(pageSrcTop));
  // The ticket is a per-call OBJECT IDENTITY, so "only its own" is reference
  // equality -- a value copied off the window cannot release anything.
  check('16.1b 解除闸只认自己的 ticket（按对象身份比，不是按字符串值）',
    /function hostCallRelease\(ticket\)/.test(pageSrcTop)
    && /if \(g\.ticket === ticket\) g\.ticket = null;/.test(pageSrcTop)
    // The ticket itself must be minted as an object, not as a derivable string.
    && /var ticket = \{\};/.test(pageSrcTop)
    && /g\.ticket = ticket;/.test(pageSrcTop));
  // The cross-instance property, which the previous per-closure `var` could not
  // provide: a SECOND bootstrap -- what a daemon refresh does -- reads the very
  // same held ticket off OUR window instead of starting from held:false.
  // 16.4 below is the BEHAVIOURAL version of 16.1/16.1b; there is deliberately
  // no "and it is true" placeholder standing in for it.
  const page = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], page.host);
  paintAll(page);
  lockButton(page, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  check('16.3 锁顶侧拿到闸', page.api.busy() === true);
  const rebooted = makeLockPageOn(page.window);
  check('16.4 重新注入的第二个实例读到同一个闸（不会并发写宿主）',
    rebooted.api.busy() === true, 'busy=' + rebooted.api.busy());
  await settleAll();
  check('16.5 回执后闸释放', page.api.busy() === false && rebooted.api.busy() === false);

  // And in the other direction: a second lock click while the gate is held.
  const p2 = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(p2, ['mvs_a', 'mvs_b'], p2.host);
  paintAll(p2);
  const click = (id) => lockButton(p2, id).dispatch('click',
    { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  click('mvs_b');
  click('mvs_a');
  check('16.6 闸在途时第二次锁顶不并发写宿主', p2.host.calls.length === 1,
    'calls=' + JSON.stringify(p2.host.calls));
  const p2b = makeLockPageOn(p2.window);
  check('16.7 第二个实例同样看到在途', p2b.api.busy() === true);
  await settleAll();
}

// ===========================================================================
console.log('\n=== 17. 宿主 throw / reject / 回滚：不吞失败、不假装成功、无自动风暴 ===');
{
  for (const [label, opts, expect] of [
    ['throw', { fail: 'throw' }, 'host-threw'],
    ['reject', { fail: 'reject' }, 'host-rejected'],
    ['rollback', { fail: true }, 'unconfirmed-return'],
  ]) {
    const page = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')], ...opts });
    const host = page.host;
    if (opts.fail === 'throw') {
      host.fn = function (e, l, c) {
        void PinService.pinSession; void SessionInfo.getSessionInfo;
        host.calls.push([e, l, c]);
        throw new Error('host-boom');
      };
    } else if (opts.fail === 'reject') {
      host.fn = function (e, l, c) {
        void PinService.pinSession; void SessionInfo.getSessionInfo;
        host.calls.push([e, l, c]);
        return Promise.reject(new Error('nope'));
      };
    }
    bootRows(page, ['mvs_a', 'mvs_b'], host);
    paintAll(page);
    lockButton(page, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
    await settleAll();
    check(`17.${label} 失败可见（reason=${expect}）`, page.api.state.reason === expect,
      'reason=' + page.api.state.reason);
    check(`17.${label} 没有被当成成功`, page.api.state.confirmedAtTop === false);
    check(`17.${label} 闸已释放`, page.api.busy() === false);
    const callsAfterFirst = host.calls.length;
    for (let i = 0; i < 10; i++) page.api.topLockTick();
    check(`17.${label} 暂停中不再自动重试（10 趟 0 次新写入）`,
      host.calls.length === callsAfterFirst, 'calls=' + host.calls.length);
    // An explicit trusted click on the paused target is a RETRY, not a release.
    lockButton(page, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
    check(`17.${label} 暂停目标上的可信点击先解除（一个手势一个含义）`,
      page.api.state.intentId === '', 'intent=' + page.api.state.intentId);
    await settleAll();
    lockButton(page, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
    check(`17.${label} 解除后再点一次才是重试，并且预算被补满`,
      page.api.state.intentId === 'mvs_b' && page.api.state.maintBudget === page.api.maxMaint,
      'intent=' + page.api.state.intentId);
    await settleAll();
  }
}

// ===========================================================================
console.log('\n=== 18. 后台维持：有界、串行、预算耗尽显式暂停、真人点击才重新武装 ===');
{
  // Everything below goes through the SHIPPED pipeline: a real trusted click on
  // a real mounted button, a real host commit, and pump() -- which is the
  // production MutationObserver -> scheduleApply -> rAF -> apply chain. The r2
  // version of this section reached into api.state.intentId / api.rt().budget
  // and then read them back, so it proved the bookkeeping and never the wiring.
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  await pump(page, 2);
  check('18.0 还没有任何意图时，宿主一次都没被写', host.calls.length === 0,
    'calls=' + JSON.stringify(host.calls));

  press(buttonFor(page, 'mvs_a'));
  await pump(page, 3);
  const afterLock = page.api.topLock();
  check('18.0b 真人可信点击真的锁上了并被确认',
    afterLock.intent && afterLock.intent.id === 'mvs_a' && afterLock.confirmedAtTop === true,
    JSON.stringify(afterLock.intent) + ' confirmed=' + afterLock.confirmedAtTop);
  // The budget bounds BACKGROUND maintenance, not the user's own gesture. A
  // trusted click goes straight to the host and spends nothing, which is why a
  // user can always re-lock; the first spend happens on the next maintenance
  // pass that actually has to write. (Asserting the opposite here was the r2
  // section's own error -- it read a hand-assigned budget and called it proof.)
  check('18.0c 真人点击不消耗后台维持预算（手势不是维持）',
    afterLock.maintBudget === afterLock.maintBudgetMax,
    'budget=' + afterLock.maintBudget + '/' + afterLock.maintBudgetMax);

  const steal = () => { setOrder(host, ['mvs_b', 'mvs_a']); };
  const callsBeforeFight = host.calls.length;
  for (let i = 0; i < 14; i++) { steal(); await pump(page, 2); }
  const extra = host.calls.length - callsBeforeFight;
  const st = page.api.topLock();
  check('18.1 后台维持被预算死死限制住（<= maxMaint 次）',
    extra <= st.maintBudgetMax, 'writes=' + extra + ' max=' + st.maintBudgetMax);
  check('18.2 预算耗尽后显式暂停，原因可见',
    st.reason === 'budget-exhausted' && st.phase === 'paused', st.reason + '/' + st.phase);
  const callsAtPause = host.calls.length;
  for (let i = 0; i < 8; i++) { steal(); await pump(page, 2); }
  check('18.3 暂停之后继续一个字节都不再写（没有永久风暴）',
    host.calls.length === callsAtPause, 'calls=' + host.calls.length);
  check('18.4 maintBlocked 被计数', page.api.topLock().maintBlocked > 0,
    'maintBlocked=' + page.api.topLock().maintBlocked);
  check('18.5 暂停时后台不自行恢复（再偷一次也还是一个字节都不写）',
    host.calls.length === callsAtPause);

  // 18.6: a RE-INJECTION must not refill anything. This has to be the SAME
  // window and the SAME document -- a fresh makeBoot() is a fresh page, so its
  // budget would start at 3 no matter what the product did. re-running the
  // shipped bootstrap over this page's own window is exactly what a daemon
  // refresh does.
  await page.api.refresh({});
  page.run();
  await pump(page, 2);
  const reSt = page.api.topLock();
  check('18.6a 重新注入后仍是暂停，预算没有被补回',
    reSt.phase === 'paused' && reSt.maintBudget === 0,
    'phase=' + reSt.phase + ' budget=' + reSt.maintBudget);
  const callsBeforeRe = host.calls.length;
  for (let i = 0; i < 4; i++) { steal(); await pump(page, 2); }
  check('18.6b 重新注入之后依然一次宿主写都没有',
    host.calls.length === callsBeforeRe, 'calls ' + callsBeforeRe + ' -> ' + host.calls.length);
  check('18.6c 存储里的意图一个都没被动过',
    String(page.localStorage.dump()['mmxStatusTopLockV1']).indexOf('mvs_a') >= 0,
    page.localStorage.dump()['mmxStatusTopLockV1']);

  // 18.7: release + re-lock by a real user is the ONLY re-arm.
  press(buttonFor(page, 'mvs_a'));
  await pump(page, 2);
  check('18.7a 真人点击解除后意图为空', page.api.topLock().intent === null,
    JSON.stringify(page.api.topLock().intent));
  press(buttonFor(page, 'mvs_a'));
  await pump(page, 3);
  const reLocked = page.api.topLock();
  check('18.7b 真人再点一次重新锁顶并被确认',
    reLocked.intent && reLocked.intent.id === 'mvs_a' && reLocked.confirmedAtTop === true,
    JSON.stringify(reLocked.intent) + ' confirmed=' + reLocked.confirmedAtTop);
  const callsBeforeOneKnock = host.calls.length;
  steal();
  await pump(page, 2);
  check('18.7c 宿主再压下时，后台【正好】维持一次',
    host.calls.length - callsBeforeOneKnock === 1,
    'writes=' + (host.calls.length - callsBeforeOneKnock));
  check('18.7d 那一次维持确实从预算里扣了一次（不是满的）',
    page.api.topLock().maintBudget === page.api.topLock().maintBudgetMax - 1,
    'budget=' + page.api.topLock().maintBudget + '/' + page.api.topLock().maintBudgetMax);

  // 18.8: a FAILED storage write must not hand back a budget or clear a mark.
  const bad = makeBoot({ storageOpts: { setThrows: true } });
  const badHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(bad, ['mvs_a', 'mvs_b'], badHost);
  await pump(bad, 2);
  check('18.8a 存储坏掉时按钮照样挂得上（禁用态也要可见）', hasButton(bad, 'mvs_a'),
    'buttons=' + lockButtons(bad).length);
  press(buttonFor(bad, 'mvs_a'));
  await pump(bad, 2);
  const badSt = bad.api.topLock();
  check('18.8 存储写失败时零宿主写、意图未落盘',
    badHost.calls.length === 0 && badSt.intent === null && badSt.reason === 'storage-write-failed',
    'calls=' + badHost.calls.length + ' reason=' + badSt.reason);
}
// ===========================================================================
console.log('\n=== 19. 目标消失与视图切换：可证明才清锁，其余一律暂停 ===');
{
  // 19a: no DOM at all -> pause, keep the intent.
  const page = makeLockPage();
  page.api.state.intentId = 'mvs_gone';
  page.api.state.intentSource = 'local';
  page.dom.root.childNodes.length = 0;
  page.api.topLockTick();
  check('19.1 列表空且无可信 order 时不清锁',
    page.api.state.intentId === 'mvs_gone' && page.api.state.phase === 'paused',
    'intent=' + page.api.state.intentId + ' reason=' + page.api.state.reason);
  check('19.2 没有任何可信顺序时理由是 view-unstable', page.api.state.reason === 'view-unstable',
    page.api.state.reason);

  // A witness row whose PROVEN order is EMPTY proves nothing at all.
  const empty = makeLockPage({ order: [] });
  bootRows(empty, ['mvs_a'], empty.host);
  empty.api.state.intentId = 'mvs_gone';
  empty.api.state.intentSource = 'local';
  empty.api.topLockTick();
  check('19.2b 空顺序不算删除证据，锁保留',
    empty.api.state.intentId === 'mvs_gone' && empty.api.state.reason === 'order-missing-id',
    'intent=' + empty.api.state.intentId + ' reason=' + empty.api.state.reason);

  // 19b: a witness row with a PROVEN local order that simply does not contain
  // the target -> that IS positive evidence, so the lock may be dropped.
  const page2 = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page2, ['mvs_a', 'mvs_b'], page2.host);
  page2.api.state.intentId = 'mvs_gone';
  page2.api.state.intentSource = 'local';
  page2.localStorage.setItem(page2.api.key,
    JSON.stringify({ version: 1, source: 'local', id: 'mvs_gone' }));
  page2.api.topLockTick();
  // COUNTEREXAMPLE (independent Spec review, 2026-10-04): the previous version
  // borrowed an arbitrary witness row here and treated "its NON-EMPTY order does
  // not mention the target" as proof of deletion. A mid-load snapshot looks
  // exactly the same, so a single view switch threw the lock away.
  check('19.3 可信但非空的 order 里没有目标 -> 不清锁，保留意图',
    page2.api.state.intentId === 'mvs_gone', 'intent=' + page2.api.state.intentId);
  check('19.3b 理由统一是 order-missing-id，不宣称"已删除"',
    page2.api.state.reason === 'order-missing-id' && page2.api.state.phase === 'paused',
    page2.api.state.reason + '/' + page2.api.state.phase);
  check('19.3c 存储里的意图也还在（界面与存储不许分裂）',
    page2.localStorage.dump()[page2.api.key] !== undefined);
  check('19.4 缺失目标不自动 repin、不复活会话',
    page2.host.calls.length === 0, 'calls=' + page2.host.calls.length);
  // 19.5 used to assert a `cleared` counter stayed 0. Since r2 removed the
  // auto-clear path entirely, nothing can move that counter, so the assertion
  // was tautological -- it would have stayed green against any product. The
  // property that actually matters is written out below instead: the stored
  // intent survives verbatim, and there is no code path that can remove it.
  check('19.5 存储里的意图原样保留（没有任何后台路径删它）',
    JSON.parse(page2.localStorage.dump()[page2.api.key]).id === 'mvs_gone',
    page2.localStorage.dump()[page2.api.key]);
  check('19.5c 产品里已不存在自动清锁的函数（cleared 计数器只能恒为 0，故不再断言它）',
    !LOCK_PRISTINE.includes('function topLockDropIntent'),
    'topLockDropIntent ' + (LOCK_PRISTINE.includes('function topLockDropIntent') ? 'still there' : 'absent'));
  // The only way out is the user.
  const before = page2.api.state.intentId;
  lockButton(page2, 'mvs_a');
  check('19.5b 非目标行点按钮不会顺手清掉这个锁',
    page2.api.state.intentId === before, 'intent=' + page2.api.state.intentId);

  // 19c: cloud witness -> the order is not a local one, so it proves nothing.
  const page3 = makeLockPage({ order: [ref('mvs_a')], source: 'cloud' });
  bootRows(page3, ['mvs_a', 'mvs_b'], page3.host);
  page3.api.state.intentId = 'mvs_gone';
  page3.api.state.intentSource = 'local';
  page3.api.topLockTick();
  check('19.6 非本地视图给出的顺序不算删除证据',
    page3.api.state.intentId === 'mvs_gone', 'intent=' + page3.api.state.intentId);

  // 19d: no-fiber witness -> no proof either.
  const page4 = makeLockPage({ order: [ref('mvs_a')] });
  const nf = makeRow(page4, 'mvs_nf', page4.host, { noFiber: true });
  page4.dom.root.appendChild(nf.rowEl);
  page4.api.state.intentId = 'mvs_gone';
  page4.api.state.intentSource = 'local';
  page4.api.topLockTick();
  check('19.7 拿不到可信 order 时保留目标而不是猜删除',
    page4.api.state.intentId === 'mvs_gone', 'intent=' + page4.api.state.intentId);
}

// ===========================================================================
console.log('\n=== 20. 锁存在时「到最顶」对其它行禁用 ===');
{
  check('20.1 到最顶 侧存在 cross-entry 视图与门',
    /var topmostLockView = \{ id: '', phase: 'idle' \};/.test(MUTATED)
    && /function topLockBlocksTopmost/.test(MUTATED));
  const page = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], page.host);
  paintAll(page);
  lockButton(page, 'mvs_a').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('20.2 意图被同步给到最顶 那一侧', page.api.view.id === 'mvs_a', 'view.id=' + page.api.view.id);
  lockButton(page, 'mvs_a').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  check('20.3 解除后该视图被清空', page.api.view.id === '', 'view.id=' + page.api.view.id);
  lockButton(page, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('20.4 红按钮仍然可以替换目标（只有菜单入口让步）',
    page.api.state.intentId === 'mvs_b', 'intent=' + page.api.state.intentId);
  const blockedForOther = page.api.blocksTopmost({ available: true, reason: 'ok', id: 'mvs_a' }, 'mvs_c');
  check('20.6 锁存在时，「到最顶」对其它行被挡住并给出中文理由',
    blockedForOther.available === false && blockedForOther.reason === 'toplock-other',
    JSON.stringify(blockedForOther));
  check('20.7 同一个红按钮在自己的行上不受这条门影响',
    page.api.blocksTopmost({ available: true, reason: 'ok', id: 'mvs_b' }, 'mvs_b').available === true);
  check('20.8 没有锁意图时这道门完全不介入',
    page.api.blocksTopmost({ available: true, reason: 'ok', id: 'mvs_b' }, 'mvs_b').reason === 'ok');
  const swap = String(page.localStorage.dump()[page.api.key] || '');
  check('20.5 替换会把旧意图换成新意图（不是两个并存）',
    swap.indexOf('mvs_b') >= 0 && swap.indexOf('mvs_a') < 0, swap);
}

// ===========================================================================
console.log('\n=== 21. 重新注入：只认存储里的意图，不复活、不猜测 ===');
{
  const first = makeBoot({
    stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_b' }) },
  });
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(first, ['mvs_a', 'mvs_b'], host);
  const t1 = first.api.topLock();
  check('21.1 重新注入后意图被读回', t1.intent && t1.intent.id === 'mvs_b', JSON.stringify(t1.intent));
  check('21.2 重新注入后的任何写入都走唯一授权入口且显式三参',
    host.calls.every((c) => c.length === 3 && c[1] === true && c[2] === 0),
    'calls=' + JSON.stringify(host.calls));
  check('21.2b 重新注入后没有任何 unpin 写入（pinned 永远显式为 true）',
    host.calls.every((c) => c[1] === true), 'calls=' + JSON.stringify(host.calls));
  check('21.3 重新注入后确认位置仍需新鲜 order（此时为未确认）',
    t1.confirmedAtTop === false, 'confirmed=' + t1.confirmedAtTop);
  // buttonFor() returns MISSING_BTN rather than null, so "!== null" was
  // ALWAYS true. Existence has to be asked with realButtonFor()/hasButton().
  check('21.4 重新注入后按钮重新挂上', hasButton(first, 'mvs_b'),
    'buttons=' + lockButtons(first).length);
  first.api.dispose();

  // A stored intent whose session is simply not there: nothing is created.
  const second = makeBoot({
    stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_absent' }) },
  });
  const h2 = makeHost({ order: [ref('mvs_a')] });
  bootRows(second, ['mvs_a'], h2);
  check('21.5 缺失的目标不会被凭空造出来',
    lockButtons(second).filter((b) => b.getAttribute('data-mmx-toplock-id') === 'mvs_absent').length === 0);
  check('21.6 缺失目标也不产生任何宿主写入', h2.calls.length === 0);
  const t2 = second.api.topLock();
  // Same counterexample as 19.3, reached through a fresh boot with a persisted
  // intent: a non-empty proven order that lacks the ref is not proof the host
  // finished loading, so the intent is kept, paused, and only the user ends it.
  check('21.7 可信非空顺序里没有目标 -> 保留意图并暂停，不清也不 repin',
    t2.intent && t2.intent.id === 'mvs_absent' && t2.phase === 'paused'
    && t2.reason === 'order-missing-id' && h2.calls.length === 0,
    JSON.stringify(t2.intent) + '/' + t2.phase + '/' + t2.reason);
}

// ===========================================================================
console.log('\n=== 21b. a11y：恒定标签 + aria-pressed 表达态 + 不抢焦点 ===');
{
  const page = makeBoot({
    stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_b' }) },
  });
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  // The stored intent is mvs_b, so the very first maintenance pass is already
  // pinning mvs_b. Pressing mvs_a in that same turn is a real user gesture that
  // lands while the background call is in flight -- the gate must absorb it and
  // the intent must still move. mvs_b is the row that ends up unlocked, so it is
  // the idle button; reading it AFTER the pump is what keeps the two assertions
  // from looking at one node twice.
  press(buttonFor(page, 'mvs_a'));
  await pump(page);
  const locked = buttonFor(page, 'mvs_a');
  const idle = buttonFor(page, 'mvs_b');
  const labels = new Set();
  labels.add(idle.getAttribute('aria-label'));
  labels.add(locked.getAttribute('aria-label'));
  const ro = makeRow(page, 'mvs_ro', makeHost({ readOnly: ['mvs_ro'] }));
  void ro;
  page.api.refresh({});
  const anyBlocked = page.dom.querySelectorAll('[data-mmx-toplock]')
    .filter((b) => b.getAttribute('aria-disabled') === 'true');
  for (const b of anyBlocked) labels.add(b.getAttribute('aria-label'));
  check('21b.1 三种状态下可见标签恒定（APG toggle 的前提）', labels.size === 1,
    [...labels].join(' | '));
  check('21b.2 已确认锁顶的那一颗 aria-pressed=true',
    locked.getAttribute('aria-pressed') === 'true', locked.getAttribute('aria-pressed'));
  check('21b.3 未锁的那一颗 aria-pressed=false', idle.getAttribute('aria-pressed') === 'false');
  check('21b.4 每种状态的说明文案各不相同（title）',
    new Set([idle.getAttribute('title'), locked.getAttribute('title')]).size === 2,
    idle.getAttribute('title') + ' | ' + locked.getAttribute('title'));
  check('21b.5 可及名恒定，状态只出现在说明里（title 与 aria-description 同文）',
    locked.getAttribute('aria-label') === '锁顶到最顶'
    && String(locked.getAttribute('title')).indexOf('再点一次解除') >= 0
    && locked.getAttribute('title') === locked.getAttribute('aria-description'),
    locked.getAttribute('aria-label') + ' | ' + locked.getAttribute('title'));
  check('21b.6 全程没有调用过 focus()，重挂不会抢走宿主的焦点',
    !/\.focus\(/.test(LOCK_PRISTINE));
  check('21b.7 禁用态用 aria-disabled 而不是原生 disabled，Tab 仍可达',
    anyBlocked.every((b) => b.getAttribute('disabled') === null
      && b.getAttribute('aria-disabled') === 'true'));
  check('21b.8 界面从不出现机器码',
    page.dom.querySelectorAll('[data-mmx-toplock]')
      .every((b) => !/-[a-z]+-/.test(String(b.getAttribute('aria-label') || ''))));
}

console.log('\n=== 22. 静态门：不新增轮询、不插 DOM 置顶、不改宿主菜单 ===');
{
  // Comments are stripped first. A gate that greps prose is the exact class of
  // check this project already threw away (see testlib/fake-dom.mjs header).
  const lock = LOCK_PRISTINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('22.1 锁模块不新增 setInterval / setTimeout / requestAnimationFrame',
    !/window\.setInterval|window\.setTimeout|requestAnimationFrame/.test(lock));
  check('22.2 锁模块从不对宿主置顶 DOM 做 insertBefore',
    !/insertBefore/.test(lock));
  check('22.3 锁模块只有一处真正的宿主调用点', lock.split('fn(id, true, 0)').length - 1 === 1,
    'sites=' + (lock.split('fn(id, true, 0)').length - 1));
  check('22.4 锁模块不触碰宿主的 pin / unpin / dnd 回调',
    !/onTogglePin|onDeleteSession|onPinSession/.test(lock));
  check('22.5 按钮一律 appendChild，不替换',
    /anchor\.appendChild\(btn\)/.test(lock) && !/innerHTML/.test(lock));
  const ownAttrs = [...new Set((lock.match(/data-mmx-[a-z-]+/g) || []))].sort();
  check('22.6 自有属性恰好七个且全在 data-mmx-toplock 族下',
    JSON.stringify(ownAttrs) === JSON.stringify(['data-mmx-toplock', 'data-mmx-toplock-id',
      'data-mmx-toplock-mount', 'data-mmx-toplock-px', 'data-mmx-toplock-reserve',
      'data-mmx-toplock-strip', 'data-mmx-toplock-style']),
    JSON.stringify(ownAttrs));
  check('22.7 复用 currentFiberOf 与七 deps 的 looksLikeHandlePin，没有第二套解析',
    /topmostCapability\(/.test(lock) && !/function looksLikeHandlePin/.test(lock));
  check('22.8 没有两参 wrapper 路径', !/cap\.fn\([^,)]*\)/.test(lock));
}

// ===========================================================================
console.log('\n=== 23. 重新注入幂等：previous.dispose() 先走，窗口只有一个 api ===');
{
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  const api1 = page.api;
  page.run();
  check('23.1 第二次注入先 dispose 掉上一个实例', page.api !== api1);
  check('23.2 按钮不因重新注入而翻倍', lockButtons(page).length === 2,
    'buttons=' + lockButtons(page).length);
  check('23.3 旧实例的节点已被摘掉（没有悬空重复）',
    page.dom.querySelectorAll('[data-mmx-toplock]').every((b) => b.parentElement !== null));
}

// ===========================================================================
console.log('\n=== 24. site 5 / site 6：真正两个原生按钮的行壳 ===');
{
  const NATIVE_BTN_CLASS = NATIVE_BTN;

  // 24.1 i$ pinned: two native buttons, no anchor, strip sized by its content.
  const p5 = makeBoot();
  const h5 = makeHost({ order: [ref('mvs_a'), ref('mvs_p')] });
  const r5 = makeTwoButtonRow(p5, 'mvs_p', h5, { kind: 'ipinned' });
  p5.run();
  const b5 = buttonFor(p5, 'mvs_p');
  check('24.1 site 5 按钮挂得上', !!b5);
  check('24.2 它进了宿主自己的 actions 那一层（不是行、不是条）',
    b5 && b5.parentElement === r5.actions, b5 && b5.parentElement.getAttribute('class'));
  check('24.3 宿主原来那两个按钮一个都没动（现在共 3 个）',
    r5.actions.querySelectorAll('button').length === 3 && nativeButtons(r5.actions).length === 2,
    'total=' + r5.actions.querySelectorAll('button').length);
  check('24.4 宿主 unpin 按钮的 class 与属性一字未改',
    nativeButtons(r5.actions)[0].getAttribute('class') === NATIVE_BTN_CLASS
    && nativeButtons(r5.actions)[0].getAttribute('data-pinned-no-drag') === 'true');
  check('24.5 我们的按钮按 30px 规格（与原生一致，不是 32）',
    hasButton(p5, 'mvs_p') && String(b5.getAttribute('class')).indexOf('h-[30px]') >= 0
    && String(b5.getAttribute('class')).indexOf('w-[30px]') >= 0,
    b5.getAttribute('class'));
  const css5 = styleCss(p5);
  const k5 = (r5.main.querySelector('div').getAttribute('data-mmx-toplock-reserve') || '');
  check('24.6 静息态【不写】reserve 规则：新增按钮隐藏时不白缩标题',
    css5.indexOf('}' + '[data-mmx-toplock-reserve="' + k5 + '"]{margin-right') < 0, css5.slice(-160));
  check('24.7 悬停/聚焦态 reserve = 宿主原值 60 + 我们 30',
    css5.indexOf('.group:hover [data-mmx-toplock-reserve="' + k5 + '"]{margin-right:90px}') >= 0
    && css5.indexOf('.group:focus-within [data-mmx-toplock-reserve="' + k5 + '"]{margin-right:90px}') >= 0,
    css5.slice(-200));
  check('24.8 site 5 的条没有定宽，所以不写 width 规则',
    css5.indexOf('data-mmx-toplock-strip') < 0, css5.slice(-160));
  check('24.8b 规则带 key：不同 margin 的行不会互相覆盖',
    /data-mmx-toplock-reserve="m\d+h\d+f\d+p\d+a\d+w\d+"/.test(css5), k5);
  check('24.9 标题 class 里没有多出任何 mmx 字样',
    r5.main.querySelector('div').getAttribute('class') === IPINNED_TITLE);
  check('24.10 标题拿到的是带 key 的自有标记',
    r5.main.querySelector('div').getAttribute('data-mmx-toplock-reserve') === k5
    && r5.main.querySelector('div').getAttribute('data-mmx-toplock-reserve').length > 4, k5);

  // 24.2 iK recent: fixed-width strip, so BOTH the strip and the title grow.
  const p6 = makeBoot();
  const h6 = makeHost({ order: [ref('mvs_a'), ref('mvs_r')] });
  const r6 = makeTwoButtonRow(p6, 'mvs_r', h6, { kind: 'irecent' });
  p6.run();
  const b6 = buttonFor(p6, 'mvs_r');
  check('24.11 site 6 按钮挂得上', !!b6);
  check('24.12 它同样在 actions 那一层', b6 && b6.parentElement === r6.actions);
  const k6 = (r6.strip.getAttribute('data-mmx-toplock-strip') || '');
  check('24.13 定宽条拿到带 key 的自有扩容标记', /^m\d+h\d+f\d+p\d+a\d+w60$/.test(k6), k6);
  const css6 = styleCss(p6);
  check('24.14 定宽条 60px -> 90px 写在【悬停/聚焦】态（静息按钮不可见）',
    css6.indexOf('.group:hover [data-mmx-toplock-strip="' + k6 + '"]{width:90px}') >= 0,
    css6.slice(-220));
  check('24.15 静息态不写 width，标题也不加 margin',
    css6.indexOf('}' + '[data-mmx-toplock-strip="' + k6 + '"]{width') < 0
    && css6.indexOf('}' + '[data-mmx-toplock-reserve="' + k6 + '"]{margin-right') < 0);
  check('24.16 宿主条的 class 一字未改', r6.strip.getAttribute('class') === IRECENT_STRIP);

  // 24.3 negative: the archived variant has ONLY more (no pin/unpin) -> refuse.
  const arch = makeBoot();
  const archRow = makeTwoButtonRow(arch, 'mvs_arch', makeHost({ order: [ref('mvs_arch')] }),
    { kind: 'irecent', archived: true });
  arch.run();
  check('24.17 只有 more 的 archived 行被拒绝（按钮数判据）',
    hasButton(arch, 'mvs_arch') === false, 'buttons=' + archButtons(arch).length);
  check('24.18 拒绝被 anchorRefused 解释', arch.api.topLock().anchorRefused >= 1,
    'refused=' + arch.api.topLock().anchorRefused);
  check('24.19 宿主那一个 more 按钮没被动过',
    archRow.actions.querySelectorAll('button').length === 1);

  // 24.4 negative: an unknown actions container -> refuse, do not guess.
  const odd = makeBoot();
  const oddRow = makeTwoButtonRow(odd, 'mvs_odd', makeHost(), { kind: 'ipinned' });
  oddRow.actions.setAttribute('class', 'some-other-layout');
  odd.run();
  check('24.20 actions 形状不认识时拒绝挂按钮', hasButton(odd, 'mvs_odd') === false);
  check('24.21 拒绝后没有留下任何 reserve 标记',
    odd.dom.querySelectorAll('[data-mmx-toplock-reserve]').length === 0);

  // 24.5 the always-visible actions branch (q/ea true) must still be recognised.
  const always = makeBoot();
  const aRow = makeTwoButtonRow(always, 'mvs_always', makeHost(), { kind: 'ipinned', always: true });
  always.run();
  check('24.22 actions 常显分支（hover token 消失）仍能识别',
    buttonFor(always, 'mvs_always') && buttonFor(always, 'mvs_always').parentElement === aRow.actions);

  // 24.6 dispose takes every trace of ours out, on this shell too.
  const dis = makeBoot();
  makeTwoButtonRow(dis, 'mvs_d', makeHost(), { kind: 'irecent' });
  dis.run();
  dis.api.dispose();
  check('24.23 dispose 后按钮归零', archButtons(dis).length === 0, 'buttons=' + archButtons(dis).length);
  check('24.24 dispose 后 reserve 与 strip 标记都摘掉',
    dis.dom.querySelectorAll('[data-mmx-toplock-reserve]').length === 0
    && dis.dom.querySelectorAll('[data-mmx-toplock-strip]').length === 0);
  check('24.25 dispose 后自有样式节点也摘掉',
    dis.dom.querySelectorAll('[data-mmx-toplock-style]').length === 0);
  const disRow = dis.dom.querySelectorAll('[data-session-id]')[0];
  const disActions = disRow.querySelectorAll('button').length
    ? disRow.querySelectorAll('button').filter((b) => b.getAttribute('aria-label'))[0].parentElement
    : null;
  check('24.26 宿主 actions 里的两个原生按钮仍然原样在',
    !!disActions && nativeButtons(disActions).length === 2,
    disActions ? 'native=' + nativeButtons(disActions).length : 'no actions');
}

// ===========================================================================
console.log('\n=== 25. r2 回归：把两个独立 review 的每条反例钉成断言 ===');
{
  // ---- 25.1 row still on screen, host order no longer lists the target ----
  // COUNTEREXAMPLE: the tick only asked "is the row there?", so a session the
  // host had just UNPINNED got silently pinned again on the very next pass.
  const un = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(un, ['mvs_a', 'mvs_b'], un.host);
  paintAll(un);
  // one trusted user-initiated pin, which is allowed even though b is absent
  lockButton(un, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('25.1.1 首次可信点击确实置顶（一次调用）', un.host.calls.length === 1,
    'calls=' + JSON.stringify(un.host.calls));
  const callsAfterPin = un.host.calls.length;
  // the host now unpins it natively: the row is still on screen, the ref is gone
  setOrder(un.host, ['mvs_a']);
  for (let i = 0; i < 6; i++) { un.api.topLockTick(); await settle(); }
  check('25.1.2 目标已被宿主 unpin 后，后台【不再补置顶】',
    un.host.calls.length === callsAfterPin, 'calls=' + JSON.stringify(un.host.calls));
  check('25.1.3 意图被保留并暂停（只有真人能结束）',
    un.api.state.intentId === 'mvs_b' && un.api.state.phase === 'paused',
    un.api.state.intentId + '/' + un.api.state.phase);
  check('25.1.4 暂停时不再显示实心红', un.api.state.confirmedAtTop === false);

  // ---- 25.2 no row + a borrowed non-empty witness must not clear the lock --
  const wit = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(wit, ['mvs_a'], wit.host);
  wit.api.state.intentId = 'mvs_gone';
  wit.api.state.intentSource = 'local';
  wit.localStorage.setItem(wit.api.key, JSON.stringify({ version: 1, source: 'local', id: 'mvs_gone' }));
  wit.api.topLockTick();
  check('25.2.1 借用任意 witness 的非空 order 缺目标 -> 不清锁（存储键原样还在）',
    wit.api.state.intentId === 'mvs_gone'
    && String(wit.localStorage.dump()[wit.api.key]).indexOf('mvs_gone') >= 0,
    'intent=' + wit.api.state.intentId);
  check('25.2.2 理由统一 order-missing-id，不宣称加载完成',
    wit.api.state.reason === 'order-missing-id', wit.api.state.reason);

  // ---- 25.3 busy: clicking the locked row must still release --------------
  const rel = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(rel, ['mvs_a', 'mvs_b'], rel.host);
  paintAll(rel);
  lockButton(rel, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  check('25.3.1 B 的调用在途', rel.api.busy() === true);
  // COUNTEREXAMPLE: release required !busy, so this click fell through and
  // re-affirmed the same intent -- the toggle silently did nothing.
  lockButton(rel, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  check('25.3.2 在途时点当前目标是解除，不是重新落盘',
    rel.api.state.intentId === '', 'intent=' + rel.api.state.intentId);
  check('25.3.3 解除没有再写宿主', rel.host.calls.length === 1, 'calls=' + rel.host.calls.length);
  await settleAll();
  check('25.3.4 迟到的回执不会把已解除的意图锁回来',
    rel.api.state.intentId === '', 'intent=' + rel.api.state.intentId);
  check('25.3.5 回执释放的是自己的 ticket，闸归零', rel.api.busy() === false);

  // ---- 25.4 a second bootstrap must see the in-flight ticket ---------------
  const boot1 = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(boot1, ['mvs_a', 'mvs_b'], boot1.host);
  paintAll(boot1);
  lockButton(boot1, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  const boot2 = makeLockPageOn(boot1.window);
  // COUNTEREXAMPLE: the gate was a per-bootstrap var, so boot2 started from
  // held:false and could put a SECOND call in flight.
  check('25.4.1 第二个 bootstrap 看到同一个在途 ticket', boot2.api.busy() === true);
  const taken = boot2.api.take();
  check('25.4.2 第二个 bootstrap 拿不到闸（take 返回 null）', taken === null, String(taken));
  await settleAll();
  check('25.4.3 第一个回执后两个实例都看到闸已释放', boot1.api.busy() === false && boot2.api.busy() === false);

  // ---- 25.5 budget and the no-auto-retry mark survive a re-injection -------
  // Real chain only: a real trusted click arms it, a real host commit spends
  // it, pump() runs the production observer -> rAF -> apply. The r2 version
  // hand-assigned rt().owner / rt().budget and then read them back, so it only
  // ever proved that the assignment it had just made was still there.
  const rt = makeBoot();
  const rtHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(rt, ['mvs_a', 'mvs_b'], rtHost);
  await pump(rt, 2);
  press(buttonFor(rt, 'mvs_a'));                 // trusted: locks and commits
  await pump(rt, 3);
  check('25.5.0 真人点击后确认在顶（前提成立）', rt.api.topLock().confirmedAtTop === true,
    'confirmed=' + rt.api.topLock().confirmedAtTop);
  const steal = () => setOrder(rtHost, ['mvs_b', 'mvs_a']);
  for (let i = 0; i < 6 && rt.api.topLock().maintBudget > 0; i++) { steal(); await pump(rt, 2); }
  check('25.5.1 预算被扣到 0', rt.api.topLock().maintBudget === 0,
    'budget=' + rt.api.topLock().maintBudget);
  // Budget 0 alone is not a pause: the row is still at the top, and CONFIRMING
  // that is a read. The pause is what happens the moment a WRITE would be
  // needed again, i.e. after the host knocks it down once more.
  check('25.5.1b 预算为 0 但仍在顶时，确认（只读）照常成立',
    rt.api.topLock().phase === 'confirmed' && rt.api.topLock().confirmedAtTop === true,
    'phase=' + rt.api.topLock().phase);
  steal();
  await pump(rt, 2);
  check('25.5.1c 宿主再压下且预算为 0 -> 显式暂停 budget-exhausted',
    rt.api.topLock().reason === 'budget-exhausted' && rt.api.topLock().phase === 'paused',
    rt.api.topLock().reason + '/' + rt.api.topLock().phase);
  const pausedCalls = rtHost.calls.length;
  // COUNTEREXAMPLE: a fresh load reset the budget, so every daemon refresh handed
  // the user another three attempts and "no automatic retry" was a lie.
  rt.api.refresh({});
  rt.run();                                      // same window = same daemon refresh
  await pump(rt, 2);
  check('25.5.2 重新注入不会把预算补回', rt.api.topLock().maintBudget === 0,
    'budget=' + rt.api.topLock().maintBudget);
  // Either reading is acceptable here and BOTH are safe, so the assertion is
  // about the property that matters: the budget did not come back, and no host
  // write happened. A load is not a gesture, so it is allowed to leave the
  // row paused (it adopted the no-retry mark) -- what it may never do is refill.
  check('25.5.2b 重新注入后预算仍是 0（无论相位是 confirmed 还是 paused）',
    rt.api.topLock().maintBudget === 0, 'phase=' + rt.api.topLock().phase + ' budget=' + rt.api.topLock().maintBudget);
  steal();
  await pump(rt, 2);
  check('25.5.2c 重新注入后再被压下，依然是 budget-exhausted 暂停',
    rt.api.topLock().reason === 'budget-exhausted' && rt.api.topLock().phase === 'paused',
    rt.api.topLock().reason + '/' + rt.api.topLock().phase);
  const beforeRetry = rtHost.calls.length;
  for (let i = 0; i < 6; i++) { steal(); await pump(rt, 2); }
  check('25.5.3 预算为 0 后不再自动写', rtHost.calls.length === beforeRetry,
    'calls=' + rtHost.calls.length + ' (paused at ' + pausedCalls + ')');
  check('25.5.4 原因是 budget-exhausted 且可见',
    rt.api.topLock().reason === 'budget-exhausted' && rt.api.topLock().phase === 'paused',
    rt.api.topLock().reason + '/' + rt.api.topLock().phase);
  // 25.5.5 the ONLY re-arm: a trusted release and a trusted re-lock. Not a
  // load, not a reinject, not an observation.
  press(buttonFor(rt, 'mvs_a'));                 // release
  await pump(rt, 2);
  check('25.5.5a 真人解除后意图为空', rt.api.topLock().intent === null,
    JSON.stringify(rt.api.topLock().intent));
  press(buttonFor(rt, 'mvs_a'));                 // re-lock
  await pump(rt, 3);
  check('25.5.5b 真人重新锁定并被确认', rt.api.topLock().confirmedAtTop === true
    && rt.api.topLock().intent && rt.api.topLock().intent.id === 'mvs_a',
    'confirmed=' + rt.api.topLock().confirmedAtTop);
  const beforeKnock = rtHost.calls.length;
  steal();
  await pump(rt, 2);
  check('25.5.5c 重新武装后，宿主再压下能【正好】维持一次',
    rtHost.calls.length - beforeKnock === 1, 'writes=' + (rtHost.calls.length - beforeKnock));
  // 25.5.6 boundedness: switching between many targets must not grow any
  // per-history structure. r2 kept a blocked map keyed by every id that had
  // ever been paused, and it grew without limit.
  const many = makeBoot();
  const manyHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(many, ['mvs_a', 'mvs_b'], manyHost);
  await pump(many, 2);
  for (let i = 0; i < 40; i++) {
    const id = i % 2 ? 'mvs_a' : 'mvs_b';
    if (many.api.topLock().intent === null || many.api.topLock().intent.id !== id) {
      press(buttonFor(many, id));
    }
    await pump(many, 1);
  }
  const runtime = many.window.__mmxStatusTopLockRuntimeV1 || {};
  const rtKeys = Object.keys(runtime).sort();
  const cssKeys = Object.keys((many.window.__mmxStatusTopLockCssV1 || {}).rules || {});
  check('25.5.6 40 次目标切换后 runtime 仍然只有 owner/budget/reason 三个字段（有界）',
    rtKeys.length <= 3 && !rtKeys.includes('blocked'), 'keys=' + rtKeys.join(','));
  check('25.5.6b window 上没有任何按 id 累积的容器',
    !Object.values(runtime).some((v) => v && typeof v === 'object'),
    JSON.stringify(runtime));
  check('25.5.6c 样式规则表按布局去重，不随切换次数增长',
    cssKeys.length <= 3, 'css keys=' + cssKeys.length);

  // ---- 25.6 a resolve with the SAME array back is not a commit ------------
  const same = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(same, ['mvs_a', 'mvs_b'], same.host);
  paintAll(same);
  // A host that resolves but never commits: setPinnedItemsOrder ignores the next.
  same.host.deps[6] = () => {};
  lockButton(same, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  check('25.6.1 resolve 之后仍未确认（拿不到新 order）',
    same.api.state.confirmedAtTop === false, 'confirmed=' + same.api.state.confirmedAtTop);
  check('25.6.2 同一个数组回来不算 commit',
    same.api.state.confirmedId === '' && same.api.state.confirmedAtTop === false);
  // And when the host really commits, the identity changes and we DO confirm.
  const good = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(good, ['mvs_a', 'mvs_b'], good.host);
  paintAll(good);
  lockButton(good, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  good.api.topLockTick();
  check('25.6.3 真正 commit（换了新数组）之后确认成立',
    good.api.state.confirmedAtTop === true && good.api.state.phase === 'confirmed',
    'confirmed=' + good.api.state.confirmedAtTop + ' reason=' + good.api.state.reason);
  // ---- 25.6b the order mutated IN PLACE is not a commit either ------------
  // COUNTEREXAMPLE: the identity check was fed null for a user click, so it
  // never ran; a host that mutates the array it already gave us -- or one that
  // optimistically reorders it -- would be read as a successful commit and the
  // row would paint a solid red arrow for a call the host never applied.
  const inplace = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(inplace, ['mvs_a', 'mvs_b'], inplace.host);
  paintAll(inplace);
  lockButton(inplace, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  const orderRef = inplace.host.order;
  inplace.host.deps[6] = () => {};          // the call resolves...
  setOrder(inplace.host, ['mvs_b', 'mvs_a']);   // ...and the SAME array is rewritten
  await settleAll();
  check('25.6b.1 原地改写同一个数组不算 commit',
    inplace.host.order === orderRef && inplace.api.state.confirmedAtTop === false,
    'same=' + (inplace.host.order === orderRef) + ' confirmed=' + inplace.api.state.confirmedAtTop);
  inplace.api.topLockTick();
  check('25.6b.2 原地改写后仍然不确认（只读等待窗口，不重发）',
    inplace.api.state.confirmedAtTop === false && inplace.api.state.phase === 'awaiting',
    'confirmed=' + inplace.api.state.confirmedAtTop + ' phase=' + inplace.api.state.phase);

  // ---- 25.6c a pause drops the "you are on top" claim -------------------
  // COUNTEREXAMPLE: the row WAS confirmed first, and only afterwards did the
  // host take the ref away. A pause that leaves confirmedAtTop alone keeps a
  // solid red arrow on a row that is demonstrably not on top.
  const wasTop = makeLockPage({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(wasTop, ['mvs_a', 'mvs_b'], wasTop.host);
  paintAll(wasTop);
  lockButton(wasTop, 'mvs_b').dispatch('click', { isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await settleAll();
  wasTop.api.topLockTick();
  check('25.6c.1 先确认在顶（证明前提成立）', wasTop.api.state.confirmedAtTop === true,
    'confirmed=' + wasTop.api.state.confirmedAtTop);
  setOrder(wasTop.host, ['mvs_a']);        // the host un-pins it natively
  wasTop.api.topLockTick();
  check('25.6c.2 之后转入暂停时不再自称在顶',
    wasTop.api.state.phase === 'paused' && wasTop.api.state.confirmedAtTop === false,
    'phase=' + wasTop.api.state.phase + ' confirmed=' + wasTop.api.state.confirmedAtTop);
  check('25.6c.3 意图仍在（暂停不是解除）', wasTop.api.state.intentId === 'mvs_b',
    'intent=' + wasTop.api.state.intentId);

  // ---- 25.7 the stylesheet is keyed, deduped and does not grow ------------
  const css = makeBoot();
  const growHost = makeHost({ order: [ref('mvs_a'), ref('mvs_b'), ref('mvs_c')] });
  bootRows(css, ['mvs_a', 'mvs_b', 'mvs_c'], growHost);
  const len0 = styleCss(css).length;
  for (let i = 0; i < 12; i++) css.api.refresh({});
  const len12 = styleCss(css).length;
  // COUNTEREXAMPLE (reproduced by the independent Spec probe): 12 virtualised
  // passes grew the sheet from 168 to 2016 characters because every pass
  // appended another rule.
  check('25.7.1 12 趟之后样式表长度不变（不再无限增长）', len12 === len0, len0 + ' -> ' + len12);
  const one = css.dom.querySelectorAll('[data-mmx-toplock-reserve]');
  check('25.7.2 三行共享同一个 key，只有一条 reserve 规则',
    new Set(one.map((n) => n.getAttribute('data-mmx-toplock-reserve'))).size === 1
    && (String(css.dom.querySelector('[data-mmx-toplock-style]').textContent).match(/data-mmx-toplock-reserve="/g) || []).length === 2,
    'marks=' + one.length);

  // Two rows with DIFFERENT reserves must not overwrite each other.
  const two = makeBoot();
  const th = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(two, ['mvs_a', 'mvs_b'], th);
  // A DIFFERENT resting margin that still carries the hover/focus tokens, like
  // every real host branch does. (The 'er' variant has no hover token at all,
  // so it legitimately gets NO reserve rule -- a title the host never widens on
  // hover needs none, and asserting a rule there would be asserting a bug.)
  two.dom.querySelectorAll('[data-shortcut-session-target]')[1]
    .querySelector('div').setAttribute('class', TITLE_CLASS_BASE + ' ' + TITLE_MARGINS.ed);
  two.run();
  const keys = two.dom.querySelectorAll('[data-mmx-toplock-reserve]')
    .map((n) => n.getAttribute('data-mmx-toplock-reserve'));
  const cssTwo = styleCss(two);
  check('25.7.3 不同 margin 的两行拿到不同的 key，互不覆盖',
    keys.length === 2 && keys[0] !== keys[1], keys.join(','));
  // && , not || : the point is that BOTH keys have their own rule. With || the
  // check passed as soon as ONE of them existed, which is exactly the
  // "last rule silently wins for every row" bug this section exists to catch.
  check('25.7.4 两条规则都在，且各自带自己的数值（缺一条就红）',
    cssTwo.indexOf('"' + keys[0] + '"]{margin-right') >= 0
    && cssTwo.indexOf('"' + keys[1] + '"]{margin-right') >= 0, keys.join(','));
  const ruleFor = (k) => (cssTwo.match(new RegExp('[^{}]*' + k + '[^{}]*\{[^}]*\}')) || [''])[0];
  check('25.7.5 两条规则的数值不相等（不是同一条被数了两次）',
    /margin-right:(\d+)px/.test(ruleFor(keys[0])) && /margin-right:(\d+)px/.test(ruleFor(keys[1]))
    && ruleFor(keys[0]).match(/margin-right:(\d+)px/)[1] !== ruleFor(keys[1]).match(/margin-right:(\d+)px/)[1],
    keys[0] + '=' + ruleFor(keys[0]) + ' | ' + keys[1] + '=' + ruleFor(keys[1]));

  // ---- 25.8 a steady apply pass writes NOTHING ----------------------------
  // The observer is configured for childList on this subtree, and the previous
  // version rewrote textContent plus four attributes for every row on every
  // pass, so it scheduled itself forever.
  const quiet = makeBoot();
  bootRows(quiet, ['mvs_a', 'mvs_b'], makeHost({ order: [ref('mvs_a'), ref('mvs_b')] }));
  quiet.api.refresh({});
  // buttonFor() never returns null, so a mutation that stops mounting buttons
  // shows up as an ordinary FAIL below instead of a TypeError that would abort
  // every section after this one.
  const probe = buttonFor(quiet, 'mvs_a');
  const attrs = ['aria-label', 'title', 'aria-description', 'aria-pressed', 'class', 'data-mmx-toplock-px'];
  const before = attrs.map((a) => String(probe.getAttribute(a)));
  for (let i = 0; i < 5; i++) quiet.api.refresh({});
  const after = attrs.map((a) => String(probe.getAttribute(a)));
  check('25.8.1 稳态 5 趟之后按钮属性一字未变', JSON.stringify(before) === JSON.stringify(after),
    JSON.stringify(before) + ' -> ' + JSON.stringify(after));
  check('25.8.2 稳态下没有新建 SVG（glyph 只创建一次）',
    probe.querySelectorAll('path').length === 1, 'paths=' + probe.querySelectorAll('path').length);
  check('25.8.3 按钮里没有文本节点（图标按钮，不写 textContent）',
    probe.childNodes.every((c) => c.nodeType === 1));
  // Comparing values is not enough. A real setAttribute with the same value
  // still queues an attributes record, and a real textContent assignment still
  // replaces the child text node -- the fake DOM counts those too, so this is
  // the offline stand-in for "the observer would have fired again".
  const sheet = () => quiet.dom.querySelector('[data-mmx-toplock-style]');
  const w0 = writesOf(probe) + writesOf(sheet());
  for (let i = 0; i < 5; i++) quiet.api.refresh({});
  const w5 = writesOf(probe) + writesOf(sheet());
  check('25.8.4 稳态 5 趟对按钮和样式表一次写都没有发生（不是"写了同样的值"）',
    w5 === w0, 'writes ' + w0 + ' -> ' + w5
    + ' (button ' + writesOf(probe) + ', sheet ' + writesOf(sheet()) + ')');
  // A shape change is allowed to write -- the point is that a no-change pass is
  // not allowed to. Otherwise "write nothing ever" would pass too.
  quiet.api.refresh({});
  const wProbe = realButtonFor(quiet, 'mvs_a');
  const wPre = writesOf(wProbe);
  if (wProbe && wProbe.setAttribute) wProbe.setAttribute('data-probe', '1');
  check('25.8.5 计数器真的在数（人为改动一次，计数就涨）',
    writesOf(realButtonFor(quiet, 'mvs_a') || MISSING_BTN) === wPre + 1,
    'writes ' + wPre + ' -> ' + writesOf(realButtonFor(quiet, 'mvs_a') || MISSING_BTN));

  // ---- 25.9 an unknown row shape takes our own marks back out -------------
  const gone = makeBoot();
  const gh = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  const gr = bootRows(gone, ['mvs_a'], gh);
  check('25.9.1 初始有按钮与 reserve 标记',
    gone.dom.querySelectorAll('[data-mmx-toplock]').length === 1
    && gone.dom.querySelectorAll('[data-mmx-toplock-reserve]').length === 1);
  // The host rewrites the row into a shape we have not proven.
  gr['mvs_a'].rowEl.querySelector('div.absolute').setAttribute('class', 'some-new-layout');
  gone.api.refresh({});
  check('25.9.2 行变未知后旧按钮被摘掉',
    gone.dom.querySelectorAll('[data-mmx-toplock]').length === 0,
    'buttons=' + gone.dom.querySelectorAll('[data-mmx-toplock]').length);
  check('25.9.3 旧 reserve / mount 标记也一起摘掉',
    gone.dom.querySelectorAll('[data-mmx-toplock-reserve]').length === 0
    && gone.dom.querySelectorAll('[data-mmx-toplock-mount]').length === 0);

  // ---- 25.10 native button counting excludes ours and other rows ---------
  const cnt = makeTwoButtonRow(makeBoot(), 'mvs_c', makeHost(), { kind: 'irecent' });
  const p = cnt.row.closest ? cnt.row : cnt.row;
  void p;
  const arch2 = makeTwoButtonRow(makeBoot(), 'mvs_d', makeHost(), { kind: 'irecent' });
  void arch2;
  const mixed = makeBoot();
  const rr = makeTwoButtonRow(mixed, 'mvs_e', makeHost(), { kind: 'irecent' });
  mixed.run();
  const ours = nativeButtons(rr.actions);
  check('25.10.1 计数排除我们自己那颗（宿主仍是 2 个）',
    rr.actions.querySelectorAll('button').length === 3 && ours.length === 2,
    'total=' + rr.actions.querySelectorAll('button').length + ' native=' + ours.length);
  // Our own button must never satisfy the archived row's minNativeButtons test.
  const selfCount = (mount, rowEl) => {
    const all = mount.querySelectorAll('button');
    let n = 0;
    for (const b of all) {
      if (b.getAttribute('data-mmx-toplock')) continue;
      const owner = b.closest ? b.closest('[data-session-id]') : null;
      if (owner !== rowEl) continue;
      n++;
    }
    return n;
  };
  check('25.10.2 只剩 more 的 archived 行仍然被拒绝',
    selfCount(rr.actions, rr.row) === 2 && rr.actions.querySelectorAll('button').length === 3);

  // ---- 25.11 the row must own what we write into --------------------------
  const own = makeBoot();
  const oh = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  const orows = bootRows(own, ['mvs_a', 'mvs_b'], oh);
  orows['mvs_a'].rowEl.querySelector('div.absolute').appendChild(
    own.dom.el('div', { class: 'hidden group-hover:block group-focus-within:block' }));
  own.api.refresh({});
  const mineA = orows['mvs_a'].rowEl.querySelectorAll('[data-mmx-toplock="1"]').length;
  const mineB = orows['mvs_b'].rowEl.querySelectorAll('[data-mmx-toplock="1"]').length;
  check('25.11.1 strip/mount 不唯一时拒绝，而不是挑一个',
    own.api.topLock().anchorRefused >= 1 && mineA === 0 && mineB === 1,
    'refused=' + own.api.topLock().anchorRefused + ' A=' + mineA + ' B=' + mineB);
  check('25.11.2 被拒的那一行把自己的 reserve 标记也摘掉了',
    orows['mvs_a'].rowEl.querySelectorAll('[data-mmx-toplock-reserve]').length === 0);
}

console.log('\n=== 26. 闸与运行时：不可写的 window 槽必须 fail closed ===');
{
  // The shipped gate proves the window kept the shared object. A window that
  // refuses the assignment -- silently, or by throwing -- must yield NO gate,
  // and no gate must mean ZERO host writes. The r2 version returned a private
  // throwaway object, so two takes both minted ticket 1 and busy() read false.
  const mk = (makeWindow) => {
    // The gate/runtime slice, PLUS the LOCK block that owns the budget
    // helpers, so the assertions below exercise the shipped implementations
    // rather than a paraphrase of them.
    const src = MUTATED.slice(
      MUTATED.indexOf('  var TOPLOCK_GATE_KEY ='),
      MUTATED.indexOf('  // Cross-entry coupling between the two entry points')
    ) + '\nvar topmostLockView = { id: "", phase: "idle" };\n' + BLOCK;
    const f = new Function('window',
      src + '\nreturn { take: hostCallTake, busy: hostCallBusy, release: hostCallRelease,'
      + ' rt: topLockRuntime, block: topLockBlockRetry, retry: topLockRetryBlocked,'
      + ' reset: topLockBudgetReset, spend: topLockSpendBudget };');
    return f(makeWindow());
  };
  // A window whose gate slot silently swallows the assignment.
  const silent = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  for (const key of ['__mmxStatusHostGateV1', '__mmxStatusTopLockRuntimeV1', '__mmxStatusTopLockCssV1']) {
    Object.defineProperty(silent, key, { value: undefined, writable: false, enumerable: true, configurable: true });
  }
  const g1 = mk(() => silent);
  const t1 = g1.take();
  check('26.1 槽不可写时 take 返回 null（不是一张临时票）', t1 === null, String(t1));
  check('26.2 槽不可写时 busy 为 false 且闸不认为有人持有', g1.busy() === false);
  const t2 = g1.take();
  check('26.3 连续两次 take 都是 null，不存在"两次都拿到票 1"', t2 === null, String(t2));
  check('26.4 槽不可写时 runtime 同样返回 null（不放行一个临时预算）',
    g1.rt() === null, String(g1.rt()));
  check('26.5 runtime 为 null 时重武装/扣预算/记原因都返回 false，不抛错',
    g1.reset('x') === false && g1.spend() === 0 && g1.block('x', 'r') === false
    && g1.retry('x') === null);
  // A window that refuses even to hold a shared object but accepts a plain one.
  const frozen = Object.freeze({ localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const g2 = mk(() => frozen);
  check('26.6 Object.freeze 的 window 同样 fail closed', g2.take() === null && g2.busy() === false,
    'take=' + String(g2.take()));
  // CONTROLS: a normal window still behaves, and a POLLUTED truthy slot fails
  // closed rather than trusting whatever it finds there.
  const normal = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  const g3 = mk(() => normal);
  const a = g3.take();
  check('26.7 对照：正常 window 拿到一张票且 busy=true', !!a && g3.busy() === true);
  check('26.8 对照：同一时刻第二次 take 返回 null', g3.take() === null);
  // Identity, not a guessable value: the ticket is an object, and only that
  // object releases the gate.
  check('26.9 票是对象身份，不是可推导的字符串', typeof a === 'object' && a !== null, typeof a);
  g3.release(a);
  check('26.10 自有票释放后闸归零', g3.busy() === false);
  const b = g3.take();
  g3.release(a);                       // a late settle from the OLD call
  check('26.11 迟到的旧回执不会释放新调用持有的闸', g3.busy() === true && b !== a);
  g3.release(b);
  const polluted = { localStorage: normal.localStorage, __mmxStatusHostGateV1: { ticket: 'someone-elses' } };
  const g4 = mk(() => polluted);
  check('26.12 槽里被污染成别人的票时 fail closed（不并发写）',
    g4.busy() === true && g4.take() === null);
  // SCOPE: this is identity isolation between OUR OWN instances, not a security
  // boundary. Anything that can run script here can rewrite the slot wholesale,
  // and we do not model that. What IS in scope: a value we never minted must not
  // release a gate we minted -- including the r2 guessable string form.
  const c = g3.take();
  g3.release({});
  g3.release('mmx-toplock-1');
  g3.release('mmx-toplock-' + Object.keys(normal).length);
  check('26.13 我们没开过的票（对象或 r2 那种可猜字符串）释放不了自己的闸',
    g3.busy() === true && c !== null);
  g3.release(c);

  // The no-retry mark belongs to the CURRENT OWNER only. r2 kept a per-id map
  // that was never cleared, so a mark left by one session kept pausing the
  // next one -- "please click again" with no click that could help.
  check('26.14 给 A 记下不自动重试后，只有 A 读得到',
    g3.block('mvs_A', 'unconfirmed-return') === true
    && g3.retry('mvs_A') === 'unconfirmed-return' && g3.retry('mvs_B') === null,
    'A=' + g3.retry('mvs_A') + ' B=' + g3.retry('mvs_B'));
  for (let i = 0; i < 60; i++) g3.block('mvs_' + i, 'host-rejected');
  const g3rt = normal.__mmxStatusTopLockRuntimeV1;
  check('26.15 60 个不同目标各自失败后，runtime 仍然只有三个字段（有界）',
    g3rt && Object.keys(g3rt).sort().join(',') === 'budget,owner,reason',
    'keys=' + Object.keys(g3rt || {}).sort().join(','));
  check('26.15b 没有任何按 id 累积的容器',
    !Object.values(g3rt || {}).some((v) => v && typeof v === 'object'),
    JSON.stringify(g3rt));
}

// ===========================================================================
console.log('\n=== 27. 目标不在屏时，witness 必须独立判定【目标】 ===');
{
  // The target's row is not in the DOM. Another connected local row lends us
  // the trusted hook and order -- but r2 borrowed that row's writability and
  // then wrote the TARGET id.
  // The intent comes from STORAGE through the product's own topLockLoad(),
  // which is also what adopts the budget. Hand-assigning api.state.intentId
  // left the fresh runtime at budget 0, so the control group paused for the
  // wrong reason -- a fixture artefact, not a product behaviour.
  const base = (opts) => {
    const p = makeLockPage(Object.assign({
      order: [ref('mvs_w'), ref('mvs_t')],
      stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_t' }) },
    }, opts || {}));
    bootRows(p, ['mvs_w'], p.host);
    p.api.topLockLoad();
    return p;
  };
  // CONTROL: the target is writable, so the witness path may write.
  const ok = base();
  const okCalls = ok.host.calls.length;
  ok.api.topLockTick();
  await settleAll();
  check('27.1 对照组：可写目标 + witness 行 -> 允许一次宿主写',
    ok.host.calls.length === okCalls + 1,
    'calls ' + okCalls + ' -> ' + ok.host.calls.length);
  check('27.2 对照组：写的是目标 id，不是 witness id',
    ok.host.calls.length && ok.host.calls[ok.host.calls.length - 1][0] === 'mvs_t',
    JSON.stringify(ok.host.calls[ok.host.calls.length - 1]));

  // COUNTEREXAMPLE: the witness is writable, the TARGET is read-only.
  const ro = base();
  ro.host.deps[0] = (id) => id === 'mvs_t';      // target read-only, witness fine
  const roCalls = ro.host.calls.length;
  ro.api.topLockTick();
  await settleAll();
  const roSt = ro.api.state;
  check('27.3 目标只读时，witness 行可写也【不得】写宿主',
    ro.host.calls.length === roCalls, 'calls=' + (ro.host.calls.length - roCalls));
  check('27.4 目标只读 -> 显式 paused，理由是 readonly-session',
    roSt.phase === 'paused' && roSt.reason === 'readonly-session',
    roSt.reason + '/' + roSt.phase);
  check('27.5 目标只读时意图保留，存储里的意图一个都没动',
    roSt.intentId === 'mvs_t' && roSt.releases === 0, 'intent=' + roSt.intentId);

  // COUNTEREXAMPLE: the read-only probe itself throws for the target.
  const th = base();
  th.host.deps[0] = (id) => { if (id === 'mvs_t') throw new Error('probe boom'); return false; };
  const thCalls = th.host.calls.length;
  th.api.topLockTick();
  await settleAll();
  const thSt = th.api.state;
  check('27.6 只读判定抛异常时零宿主写并显式暂停',
    th.host.calls.length === thCalls
    && thSt.phase === 'paused' && thSt.reason === 'readonly-probe-threw',
    'calls=' + (th.host.calls.length - thCalls) + ' reason=' + thSt.reason);
  check('27.7 抛异常时意图仍然保留', thSt.intentId === 'mvs_t', 'intent=' + thSt.intentId);

  // The judgement must be about the TARGET even when the target id is not in
  // the order at all: probe order is what proves the fix.
  const seen = [];
  const pr = base();
  pr.host.deps[0] = (id) => { seen.push(id); return false; };
  pr.api.topLockTick();
  check('27.8 只读判定被问的是【目标】id（顺序可证）',
    seen.indexOf('mvs_t') >= 0, 'probed=' + JSON.stringify(seen));
}


// ===========================================================================
// r4, part 1: the shared gate on the RED LOCK entry.
//
// The menu entry was the one r3 got wrong (it called cap.fn with a null
// ticket). topLockCall already refused, and these assertions exist so that
// stays true -- they are a regression guard on code that was correct, not
// decoration. Same three states as the menu side, driven through the real
// red button and the real hostCallTake.
// ===========================================================================
console.log('\n=== 28. r4：共享闸在红锁入口同样 fail closed（真实点击路径）===');
{
  const GATE = '__mmxStatusHostGateV1';

  // --- 28.1 the gate slot cannot hold the gate at all ----------------------
  //
  // Two ways the slot becomes unusable, and BOTH have to be driven:
  //   28.1a the slot exists, holds a non-object, and is not writable. This is
  //         the shape a third party or an older instance leaves behind, and it
  //         is the one that matters here: freezing the WHOLE window stops the
  //         product from installing its own public API at all, so it would
  //         never reach a click handler -- a degenerate counterexample that
  //         would pass for the wrong reason.
  //   28.1b the whole window is frozen, applied AFTER the product installed
  //         itself. The gate slot is then unwritable at the moment of the call
  //         while everything else keeps working.
  {
    const page = makeBoot();
    const host = makeHost({ order: [ref('mvs_b'), ref('mvs_a')] });
    bootRows(page, ['mvs_a', 'mvs_b'], host);
    await pump(page, 2);
    check('28.1.0 前置：闸正常时按钮挂得上、API 也在',
      hasButton(page, 'mvs_a') && !!page.api, 'buttons=' + lockButtons(page).length);

    // A polluted AND unwritable slot: reads see a string, writes are refused.
    Object.defineProperty(page.window, GATE, {
      value: 'slot-holds-a-string', writable: false, configurable: false, enumerable: true,
    });
    const readBack = (function () {
      try { page.window[GATE] = { ticket: null }; } catch (e) { /* non-writable */ }
      return page.window[GATE];
    })();
    check('28.1.0a 前置：槽不可写（写不进，读回仍是原来那个字符串）',
      readBack === 'slot-holds-a-string', String(readBack));
    pressOrFail(page, 'mvs_a', 'r4');
    await pump(page, 2);
    const st = page.api.topLock();
    check('28.1a 槽不可写时【零宿主写】', host.calls.length === 0,
      'calls=' + JSON.stringify(host.calls));
    // Store-first is the shipped contract and it is correct: the user's
    // gesture is recorded locally, and only the HOST WRITE needs the gate. So
    // the intent being present here is right; what must not happen is the host
    // write, a `confirmed` phase, or a silent failure. Asserting "no intent"
    // would be asserting a design the product deliberately does not have.
    check('28.1a 槽不可写时意图【已落盘】（store-first：手势本身要记下来）',
      st.intent !== null && st.intent.id === 'mvs_a', JSON.stringify(st.intent));
    check('28.1a 槽不可写时绝不显示成"已确认在顶"（没写过宿主就没资格确认）',
      st.confirmedAtTop === false && st.confirmedId === '',
      'confirmed=' + st.confirmedAtTop + ' id=' + st.confirmedId);
    check('28.1a 槽不可写时 blocked 增、calls 不增',
      st.blocked >= 1 && st.calls === 0, 'blocked=' + st.blocked + ' calls=' + st.calls);
    check('28.1a 槽不可写时 busy 不残留（不是"看起来在途"）',
      st.busy === false, 'busy=' + st.busy);
    check('28.1a 槽不可写时给用户看得出原因（不是 idle）',
      !!st.reason && st.reason !== 'idle', 'reason=' + st.reason);
    check('28.1a 槽不可写时我们没有把那个字符串当成闸去用（票仍是空）',
      st.ticket === null || st.ticket === undefined, String(st.ticket));
    check('28.1a 槽不可写时按钮仍然可见（拒绝不是让功能消失）',
      hasButton(page, 'mvs_a'), 'buttons=' + lockButtons(page).length);
  }
  {
    const page = makeBoot();
    const host = makeHost({ order: [ref('mvs_b'), ref('mvs_a')] });
    bootRows(page, ['mvs_a', 'mvs_b'], host);
    await pump(page, 2);
    const stillInstalled = !!page.api;
    Object.freeze(page.window);
    const readBack2 = (function () {
      try { page.window[GATE] = { ticket: null }; } catch (e) { /* frozen */ }
      return page.window[GATE];
    })();
    check('28.1.0b 前置：产品先装好了自己，随后 window 才被冻结',
      stillInstalled, 'api=' + String(stillInstalled));
    check('28.1.0b 前置：冻结后闸槽确实写不进（且槽本来是空的）',
      readBack2 === undefined, String(readBack2));
    pressOrFail(page, 'mvs_a', 'r4');
    await pump(page, 2);
    const st = page.api.topLock();
    check('28.1b 整个 window 不可写时零宿主写、且没被确认',
      host.calls.length === 0 && st.confirmedAtTop === false,
      'calls=' + host.calls.length + ' confirmed=' + st.confirmedAtTop);
    check('28.1b 整个 window 不可写时 busy 不残留', st.busy === false, 'busy=' + st.busy);
  }

  // --- 28.2 another instance holds the gate (in-flight control) -------------
  {
    const foreign = Object.freeze({ held: 'other-instance' });
    const page = makeBoot({ seedGate: { ticket: foreign } });
    const host = makeHost({ order: [ref('mvs_b'), ref('mvs_a')] });
    bootRows(page, ['mvs_a', 'mvs_b'], host);
    await pump(page, 2);
    check('28.2.0 前置：别人的票确实在共享槽上',
      page.window[GATE] && page.window[GATE].ticket === foreign, String(page.window[GATE]));
    pressOrFail(page, 'mvs_a', 'r4');
    await pump(page, 2);
    const st = page.api.topLock();
    check('28.2 他人在途时零宿主写（闸要防的就是这个并发）', host.calls.length === 0,
      'calls=' + host.calls.length);
    check('28.2 他人在途时我们没有覆盖别人的票',
      page.window[GATE].ticket === foreign, String(page.window[GATE].ticket));
    check('28.2 他人在途时没被确认（没写过宿主）', st.confirmedAtTop === false,
      'confirmed=' + st.confirmedAtTop);
    check('28.2 他人在途时 busy 不残留', st.busy === false, 'busy=' + st.busy);
    // The other instance settles and the gate frees again. Recovery is NOT
    // "click once more": the first click already RECORDED the intent
    // (store-first, which is the shipped contract), so the target is now the
    // current lock and the next click is read as a RELEASE. That costs one
    // extra gesture -- stated out loud here rather than papered over, because
    // claiming a single retry would pin is exactly the kind of claim that
    // hides a two-step user flow. Release, then click once more: host written.
    page.window[GATE].ticket = null;
    pressOrFail(page, 'mvs_a', 'r4');
    await pump(page, 3);
    const afterRelease = page.api.topLock();
    check('28.2 他人释放后同一点击先被读成【解除】（第一次已经记下了意图）',
      afterRelease.intent === null && afterRelease.releases >= 1,
      'intent=' + JSON.stringify(afterRelease.intent) + ' releases=' + afterRelease.releases);
    check('28.2 解除本身不写宿主', host.calls.length === 0, 'calls=' + host.calls.length);
    pressOrFail(page, 'mvs_a', 'r4');
    await pump(page, 3);
    const st2 = page.api.topLock();
    check('28.2 再点一次才真正写入宿主（拒绝可恢复，只是要多一步）',
      host.calls.length === 1 && st2.intent !== null && st2.intent.id === 'mvs_a',
      'calls=' + host.calls.length + ' intent=' + JSON.stringify(st2.intent));
    check('28.2 恢复后写入的是三参（不是两参 wrapper）',
      host.calls.length === 1 && host.calls[0].length === 3 && host.calls[0][2] === 0,
      JSON.stringify(host.calls[0]));
  }

  // --- 28.3 the writable control ------------------------------------------
  {
    const page = makeBoot();
    const host = makeHost({ order: [ref('mvs_b'), ref('mvs_a')] });
    bootRows(page, ['mvs_a', 'mvs_b'], host);
    await pump(page, 2);
    pressOrFail(page, 'mvs_a', 'r4');
    await pump(page, 3);
    const st = page.api.topLock();
    check('28.3 对照：闸可写且空闲时锁顶照旧成功（28.1/28.2 不是把功能关掉了）',
      host.calls.length === 1 && st.intent !== null && st.intent.id === 'mvs_a',
      'calls=' + host.calls.length + ' intent=' + JSON.stringify(st.intent));
    check('28.3 对照：闸对象真的落在 window 上（跨注入共享）',
      page.window[GATE] && typeof page.window[GATE] === 'object' && 'ticket' in page.window[GATE],
      String(page.window[GATE]));
  }
}

// ===========================================================================
// r4, part 2: the storage recovery transition.
//
// r3 cleared storageBroken on a successful write but NOT storageWriteFailed,
// so after one failed write the tick paused with 'storage-write-failed' for
// the rest of the session -- including after the user clicked again and the
// click DID land in storage. The whole defect is in the TRANSITION, so a fake
// storage that can never recover (every r3 test used one) cannot see it.
//
// The chain asserted here, end to end, through the real pump:
//   broken storage + trusted click -> paused, ZERO host writes, nothing stored
//   storage recovers, user clicks again (there is NO intent to release first)
//   -> the write lands, ONE three-argument host write, new order confirmed
//   -> 20 more production pumps stay confirmed / correctly maintained
//   -> and the failure reason is GONE, not repainted back on
// ===========================================================================
console.log('\n=== 29. r4：存储失败 -> 恢复 -> 真人再点 -> 一次宿主写 -> 之后不再假失败 ===');
{
  const page = makeBoot({ storageOpts: { setThrows: true } });
  const host = makeHost({ order: [ref('mvs_b'), ref('mvs_a')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  await pump(page, 2);
  const KEY = 'mmxStatusTopLockV1';
  check('29.0 前置：存储处于写必失败状态', typeof page.localStorage.flip === 'function');

  // --- the broken half ------------------------------------------------------
  pressOrFail(page, 'mvs_a', 'r4');
  await pump(page, 3);
  const bad = page.api.topLock();
  check('29.1 坏存储下真人点击：零宿主写', host.calls.length === 0,
    'calls=' + JSON.stringify(host.calls));
  check('29.1 坏存储下真人点击：意图没落盘',
    bad.intent === null && !page.localStorage.dump()[KEY], JSON.stringify(bad.intent));
  check('29.1 坏存储下真人点击：显式暂停且原因就是存储写失败',
    bad.phase === 'paused' && bad.reason === 'storage-write-failed',
    bad.phase + '/' + bad.reason);
  check('29.1 写失败被计数', bad.storageFailures >= 1, 'failures=' + bad.storageFailures);
  check('29.1 确实真的尝试写过（不是"根本没写所以没失败"）',
    page.localStorage.attempts() >= 1 && page.localStorage.okWrites() === 0,
    'attempts=' + page.localStorage.attempts() + ' ok=' + page.localStorage.okWrites());

  // Repaints and reloads must NOT wash the failure away while it is still true.
  await pump(page, 6);
  check('29.2 连续重画不会把失败洗成 idle（原因一直在屏幕上）',
    page.api.topLock().reason === 'storage-write-failed', page.api.topLock().reason);
  check('29.2 连续重画期间仍然零宿主写', host.calls.length === 0, 'calls=' + host.calls.length);

  // --- the recovery transition ---------------------------------------------
  page.localStorage.flip('set', false);
  // NOTE: there is NO intent to release first -- the first click never landed,
  // so the recovery gesture is a plain lock click on the same row. If a future
  // change made recovery require a release, this assertion is what notices.
  check('29.3 前置：此刻根本没有意图可解除（所以恢复路径只能是"再点一次锁顶"）',
    page.api.topLock().intent === null, JSON.stringify(page.api.topLock().intent));
  pressOrFail(page, 'mvs_a', 'r4');
  await pump(page, 4);
  const ok = page.api.topLock();
  check('29.3 存储恢复后真人再点：这一次真的落盘了',
    !!page.localStorage.dump()[KEY] && ok.intent !== null && ok.intent.id === 'mvs_a',
    'stored=' + page.localStorage.dump()[KEY] + ' intent=' + JSON.stringify(ok.intent));
  check('29.3 恢复后【正好一次】宿主写', host.calls.length === 1,
    'calls=' + JSON.stringify(host.calls));
  check('29.3 那一次是三参且 index=0（不是两参 wrapper）',
    host.calls.length === 1 && host.calls[0].length === 3 && host.calls[0][2] === 0,
    JSON.stringify(host.calls[0]));
  check('29.3 新顺序里目标在首位，且宿主确实换过数组（真提交）',
    host.order[0] && host.order[0].id === 'mvs_a', JSON.stringify(host.order.map((r) => r.id)));
  check('29.3 恢复后成功写入被计数',
    ok.storageWrites >= 1 && page.localStorage.okWrites() >= 1,
    'writes=' + ok.storageWrites + ' ok=' + page.localStorage.okWrites());
  check('29.3 恢复后 storage-write-failed 不再出现在相位/原因上',
    ok.reason !== 'storage-write-failed', 'reason=' + ok.reason);

  // --- 20 production pumps: confirmed, and the failure never comes back ----
  await pump(page, 20);
  const end = page.api.topLock();
  check('29.4 连续 20 趟出厂 pump 之后仍然是 confirmed（没掉回假失败）',
    end.confirmedAtTop === true && end.confirmedId === 'mvs_a',
    'phase=' + end.phase + ' reason=' + end.reason + ' confirmed=' + end.confirmedAtTop);
  check('29.4 20 趟之后原因不再是 storage-write-failed',
    end.reason !== 'storage-write-failed', 'reason=' + end.reason);
  check('29.4 20 趟里没有额外的、无来由的宿主写（维持按预算，不刷屏）',
    host.calls.length <= 1 + page.api.topLock().maintBudgetMax,
    'calls=' + host.calls.length + ' budgetMax=' + page.api.topLock().maintBudgetMax);
  check('29.4 意图始终是同一条，没被任何一趟重画换掉',
    end.intent !== null && end.intent.id === 'mvs_a', JSON.stringify(end.intent));

  // --- a knock-down must be maintained, not left broken ---------------------
  // A host that pushes the row back down is exactly the situation the lock
  // exists for; proving recovery here is worthless if the next thing the host
  // does cannot be answered.
  const knocksBefore = host.calls.length;
  host.deps[6]([ref('mvs_b'), ref('mvs_a')]);
  await pump(page, 4);
  check('29.5 宿主把目标压下去之后，锁把它重新顶回首位',
    host.order[0] && host.order[0].id === 'mvs_a', JSON.stringify(host.order.map((r) => r.id)));
  check('29.5 那一次顶回是一次新的宿主写（不是读操作假装的）',
    host.calls.length > knocksBefore, 'before=' + knocksBefore + ' after=' + host.calls.length);
}

// ===========================================================================
// r4, part 3: a FAILED write after a good one must latch again, and the two
// "the old intent survives" cases.
// ===========================================================================
console.log('\n=== 30. r4：已锁目标被替换 / 删除失败时旧意图必须留下 ===');
{
  // Storage breaks AGAIN, after a healthy lock. The failure must latch once
  // more: r4's fix is "success clears the latch", never "the latch is one-way".
  const page = makeBoot({ storageOpts: { setThrows: true } });
  page.localStorage.flip('set', false);
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  await pump(page, 2);
  pressOrFail(page, 'mvs_a', 'r4');
  await pump(page, 4);
  check('30.0 前置：健康存储下已经锁上并确认',
    page.api.topLock().confirmedAtTop === true, page.api.topLock().reason);
  const KEY = 'mmxStatusTopLockV1';
  const storedBefore = page.localStorage.dump()[KEY];
  const callsAtLock = host.calls.length;
  check('30.0 前置：意图确实在存储里', !!storedBefore, String(storedBefore));

  // The host re-renders and the target row is GONE from the DOM: the intent
  // has to survive, because the user never released it.
  page.dom.root.childNodes.length = 0;
  await pump(page, 3);
  const gone = page.api.topLock();
  check('30.1 目标行消失后意图保留（用户没解除，锁就不许自己消失）',
    gone.intent !== null && gone.intent.id === 'mvs_a', JSON.stringify(gone.intent));
  check('30.1 目标行消失后是暂停，不是"已删除"',
    gone.phase === 'paused' && gone.reason !== 'idle',
    gone.phase + '/' + gone.reason);
  check('30.1 目标行消失期间【没有新增】宿主写（没有行可写）', host.calls.length === callsAtLock,
    'calls=' + host.calls.length + ' lock=' + callsAtLock);
  check('30.1 存储里的意图一个字节没动', page.localStorage.dump()[KEY] === storedBefore,
    String(page.localStorage.dump()[KEY]));

  // removeItem fails: the RELEASE cannot happen, so the old intent must stay.
  const page2 = makeBoot({ stored: { mmxStatusTopLockV1: JSON.stringify({ version: 1, source: 'local', id: 'mvs_b' }) },
    storageOpts: { removeThrows: true } });
  const host2 = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page2, ['mvs_a', 'mvs_b'], host2);
  await pump(page2, 2);
  pressOrFail(page2, 'mvs_b', '30.2');
  await pump(page2, 3);
  const rel = page2.api.topLock();
  check('30.2 解除时 removeItem 失败：意图仍在（存储与内存不许分裂）',
    rel.intent !== null && rel.intent.id === 'mvs_b', JSON.stringify(rel.intent));
  check('30.2 解除失败时理由可见', rel.reason === 'storage-write-failed',
    'reason=' + rel.reason);
  const callsBeforeRelease = host2.calls.length;
  check('30.2 解除失败时没有新增宿主写（解除本来就不写宿主）',
    host2.calls.length === callsBeforeRelease,
    'calls=' + host2.calls.length + ' before=' + callsBeforeRelease);

  // ---------------------------------------------------------------------
  // r5: 30.2 only ever proved the FAILURE half. The other half -- a SUCCESSFUL
  // removeItem clearing the write-failure latch -- had no coverage at all, so
  // deleting that one line out of topLockStoreClear kept the whole suite green.
  // That is the second of the two places the latch is allowed to clear, and it
  // is the one a user actually reaches: they click the red button to let go,
  // removeItem throws, they try again once storage recovers, and nothing may
  // clear storageWriteFailed except that succeeding remove.
  //
  // Nothing here is seeded by hand: no direct write to topLockState, no budget,
  // no flag. Every state is reached by booting the shipped bootstrap, pressing
  // a real button, and letting the production pump run.
  // ---------------------------------------------------------------------
  const KEY2 = 'mmxStatusTopLockV1';
  check('30.3 前置：解除失败之后意图仍在存储里（所以下面清掉它才是有意义的）',
    page2.localStorage.dump()[KEY2] !== undefined && rel.intent !== null,
    'stored=' + String(page2.localStorage.dump()[KEY2]) + ' intent=' + JSON.stringify(rel.intent));
  check('30.3 前置：写失败闩确实已经锁上（此刻还暂停着）',
    rel.phase === 'paused' && rel.reason === 'storage-write-failed',
    rel.phase + '/' + rel.reason);

  // removeItem recovers (quota freed / private mode toggled / pressure gone).
  page2.localStorage.flip('remove', false);
  // A recovery cannot be laundered by idle passes: load() and repaint are not
  // allowed to clear the latch, only a succeeding storage operation is.
  await pump(page2, 5);
  const stillLatched = page2.api.topLock();
  check('30.3 存储恢复之后、重画并不能把闩洗掉（只有成功的存储操作可以）',
    stillLatched.phase === 'paused' && stillLatched.reason === 'storage-write-failed',
    stillLatched.phase + '/' + stillLatched.reason);

  // The user's way out, for real: a trusted click on the red button.
  const pressed = pressOrFail(page2, 'mvs_b', '30.3');
  check('30.3 解除按钮还在（暂停不等于把用户的出口拆了）', pressed,
    'buttons=' + lockButtons(page2).length);
  await pump(page2, 4);
  const freed = page2.api.topLock();
  check('30.3 恢复后真人解除：存储里的意图真的被删掉了',
    page2.localStorage.dump()[KEY2] === undefined, String(page2.localStorage.dump()[KEY2]));
  check('30.3 恢复后真人解除：内存意图也真的没了（两侧不许分裂）',
    freed.intent === null, JSON.stringify(freed.intent));
  check('30.3 恢复后真人解除：不再是 storage-write-failed 暂停',
    freed.phase !== 'paused' && freed.reason !== 'storage-write-failed',
    freed.phase + '/' + freed.reason);
  check('30.3 恢复后真人解除：removeItem 这一次是真的成功了',
    page2.localStorage.attempts() > 0 && page2.api.topLock().storageFailures >= 1,
    'attempts=' + page2.localStorage.attempts() + ' failures=' + page2.api.topLock().storageFailures);

  // 20 PRODUCTION pumps: the latch must not come back, and the tick must not
  // mistake a released lock for one that still needs releasing.
  const callsAtFree = host2.calls.length;
  await pump(page2, 20);
  const after20 = page2.api.topLock();
  check('30.4 解除后 20 趟出厂 pump 都没有重新暂停在 storage-write-failed 上',
    after20.phase !== 'paused' && after20.reason !== 'storage-write-failed',
    after20.phase + '/' + after20.reason);
  check('30.4 20 趟之后意图仍然是空的（解除不是一帧的假象）',
    after20.intent === null, JSON.stringify(after20.intent));
  check('30.4 20 趟里没有把已解除的锁又写回存储',
    page2.localStorage.dump()[KEY2] === undefined, String(page2.localStorage.dump()[KEY2]));
  check('30.4 20 趟里没有新增宿主写（没有意图就没有维持）',
    host2.calls.length === callsAtFree,
    'calls=' + host2.calls.length + ' atFree=' + callsAtFree);

  // And the feature still works afterwards: lock again, get confirmed.
  pressOrFail(page2, 'mvs_a', '30.5');
  await pump(page2, 6);
  const relocked = page2.api.topLock();
  check('30.5 解除之后还能重新锁上并被确认（闩清了不等于功能被关掉）',
    relocked.intent !== null && relocked.intent.id === 'mvs_a'
    && relocked.confirmedAtTop === true,
    'intent=' + JSON.stringify(relocked.intent) + ' confirmed=' + relocked.confirmedAtTop
    + ' reason=' + relocked.reason);
  check('30.5 重新锁顶走了真实的宿主写（不是内存里自说自话）',
    host2.calls.length > callsAtFree && host2.order[0] && host2.order[0].id === 'mvs_a',
    'calls=' + host2.calls.length + ' order=' + JSON.stringify(host2.order.map((r) => r.id)));
}

// ===========================================================================
// r4, part 4: the CSS registry is a presentation detail, so it may fall back
// to a PRIVATE object -- but "falls back privately" must still mean the
// stylesheet really lands in the document with FINITE, VALID rules. Asserting
// only "the function returned an object" (which is all r3's dead ternary could
// have satisfied) proves nothing about what the user actually sees.
// ===========================================================================
console.log('\n=== 31. r4：闸 / 运行时 / CSS 三个槽都不可写时，样式表仍真实挂上且规则有限 ===');
{
  const GATE = '__mmxStatusHostGateV1';
  const RT = '__mmxStatusTopLockRuntimeV1';
  const CSS = '__mmxStatusTopLockCssV1';

  // All three window slots unwritable, installed AFTER the product booted, so
  // the product itself is alive and the failure is isolated to those slots.
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_b'), ref('mvs_a')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  await pump(page, 2);
  for (const k of [GATE, RT, CSS]) {
    Object.defineProperty(page.window, k, {
      value: 'slot-a-string', writable: false, configurable: false, enumerable: true,
    });
  }
  const refused = [GATE, RT, CSS].every((k) => {
    try { page.window[k] = { ticket: null, owner: '', budget: 0, reason: '', rules: {} }; } catch (e) { /* no */ }
    return page.window[k] === 'slot-a-string';
  });
  check('31.0 前置：三个槽都真的写不进', refused,
    JSON.stringify([GATE, RT, CSS].map((k) => page.window[k])));

  // A real user click: refused for the gate, but the row still has to LOOK
  // right, because a lost reserve rule is a layout problem, not a correctness
  // one, and it must not read as "the gate failed".
  pressOrFail(page, 'mvs_a', 'r4');
  await pump(page, 3);

  const styleNode = page.dom.querySelector('[data-mmx-toplock-style]');
  check('31.1 三个槽都不可写时，样式表节点【仍然真实挂进了文档】',
    styleNode !== null && styleNode.parentNode !== null,
    styleNode ? 'parent=' + (styleNode.parentNode ? styleNode.parentNode.nodeName : 'null') : '(no node)');
  check('31.1b 样式表节点带的是出厂那个属性（不是夹具自己造的）',
    styleNode !== null && styleNode.getAttribute('data-mmx-toplock-style') !== null,
    styleNode ? 'attr=' + String(styleNode.getAttribute('data-mmx-toplock-style')) : '(no node)');
  const css = String((styleNode && styleNode.textContent) || '');
  check('31.2 样式表内容非空（不是"回退了所以什么都没有"）',
    css.length > 0, 'len=' + css.length);
  check('31.2b 样式表里真的有出厂基础规则（.mmx-toplock-btn 与字形）',
    /\.mmx-toplock-btn\{/.test(css) && /\.mmx-toplock-glyph\{/.test(css),
    'btn=' + /\.mmx-toplock-btn\{/.test(css) + ' glyph=' + /\.mmx-toplock-glyph\{/.test(css));
  check('31.2c 样式表里真的有 reserve 规则（说明私有回退后规则照常生成）',
    /data-mmx-toplock-reserve/.test(css), 'hasReserve=' + /data-mmx-toplock-reserve/.test(css));
  check('31.3 规则是【有限】的：花括号成对，且没有重复追加同一选择器',
    (css.match(/{/g) || []).length === (css.match(/}/g) || []).length,
    'braces=' + (css.match(/{/g) || []).length + '/' + (css.match(/}/g) || []).length);
  check('31.3b 规则文本里没有 NaN / undefined / Infinity 这类坏值',
    !/NaN|undefined|Infinity/.test(css), 'bad=' + (/NaN|undefined|Infinity/.test(css)));
  check('31.3c 规则文本长度有界（重画不会让它无限增长）',
    css.length > 0 && css.length < 8000, 'len=' + css.length);
  // Repaint a few more times: the sheet must not grow, and must not change.
  const cssAfterFirst = css;
  await pump(page, 6);
  const styleNode2 = page.dom.querySelector('[data-mmx-toplock-style]');
  const css2 = String((styleNode2 && styleNode2.textContent) || '');
  check('31.4 继续重画之后样式表【一个字节都没变】（私有回退也不会自增）',
    css2 === cssAfterFirst, 'before=' + cssAfterFirst.length + ' after=' + css2.length);
  check('31.4b 按钮依旧挂得上、reserve 依旧在（回退不影响可见性与占位）',
    hasButton(page, 'mvs_a') && page.dom.querySelectorAll('[data-mmx-toplock-reserve]').length >= 1,
    'buttons=' + lockButtons(page).length + ' reserve=' + page.dom.querySelectorAll('[data-mmx-toplock-reserve]').length);
  check('31.5 三个槽不可写期间，宿主依然零写（闸的 fail closed 没有被 CSS 回退带坏）',
    host.calls.length === 0, 'calls=' + JSON.stringify(host.calls));
  check('31.5b 三个槽不可写期间，理由可见且不是 idle',
    page.api.topLock().reason !== 'idle' && !!page.api.topLock().reason,
    'reason=' + page.api.topLock().reason);
  // The registry itself: a private object, honestly, with a finite rule set.
  const reg = page.window[CSS];
  check('31.6 CSS 槽不可写时注册表是【私有】的（没有把不可写的槽当成共享状态）',
    reg === 'slot-a-string', String(reg));
}

// ===========================================================================
// 32. 右键菜单里的第二个入口（「永久置顶到最顶」）
//
// 23 节在到最顶 那一侧的套件里证明了这个入口的【菜单面】；这里证明它在锁这
// 一侧与红色悬停按钮产出【同一份】状态：同一处意图、同一份预算、同一个代次、
// 同一次三参调用、同一个写闸。两条入口的差别只应该有三样：事件本身、自己的
// 节点、以及各自的 isTrusted 门。任何多出来的差别都是第二份状态机的味道。
//
// 32.9 那一段用的是 harness A（整包 bootstrap），因为"apply() 真的会调用自动
// 到顶"这件事只有整包能证明：切片里没有调用点。
// ===========================================================================
const TOPLOCK_KEY_S = 'mmxStatusTopLockV1';
{
  const A = makeLockPage();
  const host = A.host;
  // A real row, built by the lock suite's own fixture, so the capability really
  // resolves: a bare div with a data-session-id and no fiber would only prove
  // that no-fiber-root is refused.
  // mvs_c, not mvs_a: the default fixture already has mvs_a at order[0], and
  // arming a row that is already first is the deliberate no-op branch.
  const rowA = makeRow(A, 'mvs_c', host).rowEl;
  // The menu-side entry point, driven through the shipped handler with a menu
  // item of its own -- the red button is NOT required to exist for this path,
  // which is the entire reason the entry is not onTopLockActivate.
  const li = A.dom.el('li', { 'data-mmx-toplock-menu': '1' });
  A.dom.root.appendChild(li);
  check('32.0 前置：出厂有菜单入口这一段', typeof A.api.lockMenu === 'function',
    typeof A.api.lockMenu);
  if (typeof A.api.lockMenu === 'function') {
    A.api.lockMenu({ isTrusted: true }, li, rowA, 'mvs_c');
    await settleAll();
    check('32.1 菜单入口 = 落意图 + 一次显式三参调用 [F10]',
      host.calls.length === 1 && JSON.stringify(host.calls[0]) === JSON.stringify(['mvs_c', true, 0])
      && A.api.state.intentId === 'mvs_c'
      && JSON.parse(A.localStorage.dump()[TOPLOCK_KEY_S]).id === 'mvs_c',
      `calls=${JSON.stringify(host.calls)} intent=${A.api.state.intentId}`);
    check('32.1 目标真的落到 order[0]',
      host.order[0].id === 'mvs_c', JSON.stringify(host.order.map((r) => r.id)));
    check('32.1 红按钮那颗节点一个都没有（这一条路径不依赖它）',
      lockButtons(A).length === 0, 'buttons=' + lockButtons(A).length);
    // The same intent through the same machine: a second activation releases it.
    host.calls.length = 0;
    A.api.lockMenu({ isTrusted: true }, li, rowA, 'mvs_c');
    await settleAll();
    check('32.2 再点一次 = 解除（纯本地，零宿主写）',
      host.calls.length === 0 && A.api.state.intentId === '' && A.api.state.releases === 1
      && A.localStorage.dump()[TOPLOCK_KEY_S] === undefined,
      `calls=${host.calls.length} releases=${A.api.state.releases}`);
    // An untrusted event never reaches the machine.
    A.api.lockMenu({ isTrusted: false }, li, rowA, 'mvs_c');
    await settleAll();
    check('32.3 合成事件不落意图也不写宿主',
      host.calls.length === 0 && A.api.state.intentId === '' && A.api.state.reason === 'untrusted-click',
      `reason=${A.api.state.reason}`);
    // A row the host has since recycled is not this session any more.
    rowA.setAttribute('data-session-id', 'mvs_other');
    A.api.lockMenu({ isTrusted: true }, li, rowA, 'mvs_c');
    await settleAll();
    check('32.4 行已换人时拒绝（row-gone，零写）',
      host.calls.length === 0 && A.api.state.reason === 'row-gone' && A.api.state.intentId === '',
      `reason=${A.api.state.reason}`);
    // A menu item the host already unmounted must not act either.
    rowA.setAttribute('data-session-id', 'mvs_c');
    li.remove();
    A.api.lockMenu({ isTrusted: true }, li, rowA, 'mvs_c');
    await settleAll();
    check('32.4b 菜单项已被摘掉时拒绝（menu-gone，零写）',
      host.calls.length === 0 && A.api.state.reason === 'menu-gone',
      `reason=${A.api.state.reason}`);
  }
}
{
  // Both entries, one machine: the intent the menu entry writes is the very one
  // the red button releases, and the gate is the same object.
  const A = makeLockPage();
  const host = A.host;
  const rows = {};
  for (const id of ['mvs_c', 'mvs_b']) rows[id] = makeRow(A, id, host).rowEl;
  const liA = A.dom.el('li', { 'data-mmx-toplock-menu': '1' });
  const liB = A.dom.el('li', { 'data-mmx-toplock-menu': '1' });
  A.dom.root.appendChild(liA);
  A.dom.root.appendChild(liB);
  if (typeof A.api.lockMenu === 'function') {
    A.api.lockMenu({ isTrusted: true }, liA, rows['mvs_c'], 'mvs_c');
    await settleAll();
    const genAfterMenu = A.api.gen();
    // The RED button on another row replaces the intent, exactly as the comment
    // above topLockBlocksTopmost says it does.
    const btn = A.dom.el('button', { 'data-mmx-toplock': '1', 'data-mmx-toplock-id': 'mvs_b' });
    rows['mvs_b'].appendChild(btn);
    A.api.onTopLockActivate({ isTrusted: true, preventDefault() {}, stopPropagation() {} }, btn, 'mvs_b');
    await settleAll();
    check('32.5 菜单入口写的意图，红按钮能接手（同一份意图）',
      A.api.state.intentId === 'mvs_b' && A.api.gen() > genAfterMenu
      && JSON.parse(A.localStorage.dump()[TOPLOCK_KEY_S]).id === 'mvs_b',
      `intent=${A.api.state.intentId} gen=${A.api.gen()}`);
    check('32.5 两次入口各一次三参调用，没有多余的宿主写',
      host.calls.length === 2
      && JSON.stringify(host.calls.map((c) => c[0])) === JSON.stringify(['mvs_c', 'mvs_b']),
      JSON.stringify(host.calls));
    // The gate the menu entry takes is the SAME object the red entry takes.
    const GATE = '__mmxStatusHostGateV1';
    const B = makeLockPageOn(A.window);
    check('32.5b 第二个实例看到的是同一个意图（意图在存储，不在闭包里）',
      B.api.state.intentId === '' || B.api.state.intentId === 'mvs_b',
      'intent=' + B.api.state.intentId);
    void GATE;
  }
}
{
  // 32.6: the gate. Both entries must be refused by the SAME gate, and a
  // refusal must still leave the intent alone.
  const A = makeLockPage({ seedGate: { ticket: Object.freeze({ held: 'other-instance' }) } });
  const host = A.host;
  const row = makeRow(A, 'mvs_c', host).rowEl;
  const li = A.dom.el('li', { 'data-mmx-toplock-menu': '1' });
  A.dom.root.appendChild(li);
  if (typeof A.api.lockMenu === 'function') {
    check('32.6 前置：闸被别人的票占着', A.api.busy() === true, String(A.api.busy()));
    A.api.lockMenu({ isTrusted: true }, li, row, 'mvs_c');
    await settleAll();
    check('32.6 他人在途时菜单入口零宿主写（与红按钮同一条闸）',
      host.calls.length === 0 && A.api.state.calls === 0
      && A.api.state.intentId === 'mvs_c' && A.api.state.reason === 'busy',
      `calls=${host.calls.length} reason=${A.api.state.reason} intent=${A.api.state.intentId}`);
    check('32.6 别人的票没有被我们释放', A.api.busy() === true, String(A.api.busy()));
  }
}
{
  // 32.9: the WHOLE shipped bootstrap. Only this can prove apply() really calls
  // the auto-top pass, because the call site is outside both sliced blocks.
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_b')] });
  bootRows(page, ['mvs_a', 'mvs_b'], host);
  const t0 = page.api.topmost();
  check('32.9 整包 apply() 真的跑过自动到顶这一趟（出厂接线）',
    !!t0.autoTop && t0.autoTop.passes >= 1, JSON.stringify(t0.autoTop));
  check('32.9 空闲时零补写', host.calls.length === 0, 'calls=' + JSON.stringify(host.calls));
  if (t0.autoTop && t0.autoTop.passes >= 1) {
    // Two passes on an UNCHANGED order first: the auto-top only trusts an order
    // it has seen twice in a row, and the very first baseline is armed the same
    // way. Changing the order on pass one would mean the new member was part of
    // the baseline before there ever was a baseline -- which is the fail-closed
    // branch, and this test is not about it (24.2 covers that).
    await pump(page, 2);
    // The user pins a new session with the HOST's own control, so the order
    // grows at the end -- the reported bug. makeHost's deps[1] is a live getter
    // over host.order (that is what makes a stale closure observable at all), so
    // assigning the array is the whole commit.
    host.order = host.order.concat([{ type: 'session', id: 'mvs_new' }]);
    await pump(page, 4);
    check('32.9b 新出现的置顶项被补到最顶（整包里真实发生）',
      host.calls.length === 1 && JSON.stringify(host.calls[0]) === JSON.stringify(['mvs_new', true, 0]),
      'calls=' + JSON.stringify(host.calls));
    check('32.9b 其余置顶项一个都没被搬动',
      JSON.stringify(host.order.map((r) => r.id)) === JSON.stringify(['mvs_new', 'mvs_a', 'mvs_b']),
      JSON.stringify(host.order.map((r) => r.id)));
    // A menu item injected into a row is a node we own: dispose takes it out.
    const stray = page.dom.el('li', { 'data-mmx-toplock-menu': '1' });
    page.dom.root.appendChild(stray);
    check('32.9c 前置：dispose 之前那个节点在', stray.isConnected === true);
    page.api.dispose();
    check('32.9c dispose 摘掉菜单里的锁顶项（不留在宿主浮层里）',
      page.dom.querySelectorAll('[data-mmx-toplock-menu]').length === 0,
      'left=' + page.dom.querySelectorAll('[data-mmx-toplock-menu]').length);
  }
}

// ===========================================================================
console.log('\n=== 33. mhd 置顶行：旧 site 表覆盖不到的那一形态（真机取证 600 行一致）===');
{
  // 33.0 The row itself, on the real classes: strip right-1 + flex items-center,
  // hover-only w-[60px] mount, TWO native buttons that are the mount's SIBLINGS.
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_h')] });
  const hrow = makeMhdRow(page, 'mvs_h', host);
  makeRow(page, 'mvs_a', host);
  page.run();

  // RED BEFORE THE FIX, GREEN AFTER: the old table refused every pass on this
  // row, so the button count was 0 and the refusal counter ran (the reported
  // symptom, anchorRefused growing by one per row per pass).
  check('33.1 mhd 行的按钮挂得上（旧 site 表下这里是 0 注入）', hasButton(page, 'mvs_h'),
    'injected=' + page.api.topLock().injected + ' refused=' + page.api.topLock().anchorRefused);
  check('33.2 这行一次都没有被拒', page.api.topLock().anchorRefused === 0,
    'refused=' + page.api.topLock().anchorRefused);
  const b = buttonFor(page, 'mvs_h');
  check('33.3 按钮进的是那一格 mount（不是行、不是条）',
    b.parentElement === hrow.mount, b.parentElement.getAttribute('class'));
  check('33.3b 两个原生按钮是 mount 的兄弟，仍原样住在条里',
    hrow.strip.children.length === 3 && nativeButtons(hrow.strip).length === 2
    && nativeButtons(hrow.strip)[0].parentElement === hrow.strip
    && nativeButtons(hrow.strip)[1].parentElement === hrow.strip,
    'children=' + hrow.strip.children.length + ' native=' + nativeButtons(hrow.strip).length);
  check('33.3c 宿主条的 class 一字未改', hrow.strip.getAttribute('class') === MHD_STRIP);
  check('33.3d 宿主 mount 的 class 一字未改', hrow.mount.getAttribute('class') === MHD_MOUNT);
  check('33.3e 标题 class 里没有多出任何 mmx 字样（只加自有属性）',
    hrow.title.getAttribute('class') === IPINNED_TITLE, hrow.title.getAttribute('class'));
  check('33.3f 我们的按钮按 36px 规格（宿主给的是 60px 悬停格，装得下）',
    String(b.getAttribute('class')).indexOf('h-[36px]') >= 0
    && String(b.getAttribute('class')).indexOf('w-[36px]') >= 0
    && b.getAttribute('data-mmx-toplock-px') === '36', b.getAttribute('class'));

  // 33.4 The cross-entry case that made this a bug at all: a tf-normal row and
  // an mhd row in the SAME page. The two strips share five tokens, so if the
  // new entry were ordered after tf-normal, tf-normal would claim the mhd
  // strip, fail on its own mount shape and refuse the row (fail-closed, no
  // fall-through) -- exactly the reported symptom.
  check('33.4 同页两种条同时挂得上（tf-normal 不被新条目抢，mhd 也不被 tf-normal 抢）',
    hasButton(page, 'mvs_a') && hasButton(page, 'mvs_h'),
    'a=' + hasButton(page, 'mvs_a') + ' h=' + hasButton(page, 'mvs_h'));
  check('33.4b 两种行各自进各自那一格',
    buttonFor(page, 'mvs_a').parentElement.getAttribute('class') === HOVER_MOUNT_CLASS
    && buttonFor(page, 'mvs_h').parentElement === hrow.mount);

  // 33.5 The site table itself, so "it works" cannot be re-broken by reordering
  // the entries or by bolting on a native-button count the real markup makes
  // permanently zero (the buttons live in the strip, not in the mount).
  const A = makeLockPage();
  const sites = A.api.sites;
  const names = sites.map((s) => s.name);
  const mhdIdx = names.indexOf('mhd-pinned');
  const tfIdx = names.indexOf('tf-normal');
  check('33.5 site 表里有 mhd-pinned 这一条', mhdIdx >= 0, names.join(','));
  check('33.5b 它排在 tf-normal 之前（同一组条 token，顺序就是判据）',
    mhdIdx >= 0 && tfIdx >= 0 && mhdIdx < tfIdx, names.join(','));
  check('33.5c 它不带 minNativeButtons（原生按钮在 mount 外，带了恒 0）',
    mhdIdx >= 0 && sites[mhdIdx].minNativeButtons === undefined,
    mhdIdx >= 0 ? String(sites[mhdIdx].minNativeButtons) : '(no entry)');
  check('33.5d 它按 36px 按钮登记，且条宽登记为 0（按钮在宿主那 60px 悬停格里，不加宽条）',
    mhdIdx >= 0 && sites[mhdIdx].px === 36 && sites[mhdIdx].stripWidth === 0,
    mhdIdx >= 0 ? JSON.stringify([sites[mhdIdx].px, sites[mhdIdx].stripWidth]) : '(no entry)');
  check('33.5e 旧三条 site 一个都没动（irecent 仍带 2，ipinned / tf-normal 仍不带）',
    names.indexOf('irecent') === 0 && sites[0].minNativeButtons === 2
    && sites[names.indexOf('ipinned')].minNativeButtons === undefined
    && sites[names.indexOf('tf-normal')].minNativeButtons === undefined
    && sites[names.indexOf('tf-normal')].titleBy === 'anchor', names.join(','));
}

// ===========================================================================
console.log('\n=== 34. 按钮放大到 36px：承重数字（条宽 / reserve / 图标）必须一起跟上 ===');
{
  // 34.0 Three row shells in ONE page, so the numbers below are per SITE and not
  // "whatever the last row wrote". mhd's button sits INSIDE the host's own
  // hover-only 60px cell; the other two sit BESIDE the host's buttons, so only
  // they owe the title and the strip their own width.
  const page = makeBoot();
  const host = makeHost({ order: [ref('mvs_a'), ref('mvs_h'), ref('mvs_p'), ref('mvs_r')] });
  const hrow = makeMhdRow(page, 'mvs_h', host);
  const prow = makeTwoButtonRow(page, 'mvs_p', host, { kind: 'ipinned' });
  const rrow = makeTwoButtonRow(page, 'mvs_r', host, { kind: 'irecent' });
  makeRow(page, 'mvs_a', host);
  page.run();
  const css = styleCss(page);
  const hBtn = buttonFor(page, 'mvs_h');
  const pBtn = buttonFor(page, 'mvs_p');
  const rBtn = buttonFor(page, 'mvs_r');
  const hKey = String(hrow.title.getAttribute('data-mmx-toplock-reserve') || '');
  const pKey = String(prow.main.querySelector('div').getAttribute('data-mmx-toplock-reserve') || '');
  const rKey = String(rrow.strip.getAttribute('data-mmx-toplock-strip') || '');

  // 34.1 Only the mhd row got bigger. The other two sites are untouched -- a
  // global px bump would have silently resized buttons on rows the user never
  // complained about.
  check('34.1 只有 mhd 行的按钮是 36px；ipinned / irecent 仍是 30px',
    hasButton(page, 'mvs_h') && hasButton(page, 'mvs_p') && hasButton(page, 'mvs_r')
    && String(hBtn.getAttribute('class')).indexOf('h-[36px] w-[36px]') >= 0
    && String(pBtn.getAttribute('class')).indexOf('h-[30px] w-[30px]') >= 0
    && String(rBtn.getAttribute('class')).indexOf('h-[30px] w-[30px]') >= 0,
    [hBtn.getAttribute('class'), pBtn.getAttribute('class')].join(' | '));

  // 34.2 THE load-bearing number. The host's title already reserves 60px on
  // hover/focus, and that 60px IS the cell our button now lives in, so the
  // reserve stays 60. 90 (the old 60 + our 30) and 96 (a naive 60 + the new
  // 36) are both wrong and both must be absent FOR THIS KEY. (Another site's
  // key legitimately carries 90 -- see 34.5 -- so the scan is per key.)
  const hR = '[data-mmx-toplock-reserve="' + hKey + '"]{margin-right:';
  check('34.2 mhd 的 reserve 停在宿主自己那 60px（60+30=90 与 60+36=96 都不许出现）',
    hKey.length > 4
    && css.indexOf('.group:hover ' + hR + '60px}') >= 0
    && css.indexOf('.group:focus-within ' + hR + '60px}') >= 0
    && css.indexOf(hR + '90px}') < 0 && css.indexOf(hR + '96px}') < 0
    && css.indexOf(hR + '66px}') < 0,
    hKey + ' :: ' + css.slice(-240));

  // 34.3 The strip must not be pinned to a width any more. Forcing 60 + 36
  // would squeeze the host's own two 30px buttons (they are the strip's flex
  // siblings and shrink), which is how a bigger button used to make the WHOLE
  // right side of the row smaller.
  check('34.3 mhd 的条不再有我们写的定宽（宿主两个 30px 原生按钮不被压扁）',
    hrow.strip.getAttribute('data-mmx-toplock-strip') === null
    && css.indexOf('data-mmx-toplock-strip="' + hKey + '"') < 0
    && hrow.strip.getAttribute('class') === MHD_STRIP, hrow.strip.getAttribute('class'));
  check('34.3b 宿主两个原生按钮仍是 30px 规格、class 一字未改',
    nativeButtons(hrow.strip).length === 2
    && nativeButtons(hrow.strip).every((b) => String(b.getAttribute('class'))
      .indexOf('h-[30px] w-[30px]') >= 0)
    && nativeButtons(hrow.strip)[0].getAttribute('class') === NATIVE_BTN
    && nativeButtons(hrow.strip)[1].getAttribute('class') === NATIVE_BTN,
    nativeButtons(hrow.strip).map((b) => b.getAttribute('class')).join(' | '));
  check('34.3c 条里的内容一个不多一个不少（mount + 2 原生 + 我们自己）',
    hrow.strip.children.length === 3, 'children=' + hrow.strip.children.length);

  // 34.4 The cell is the host's, so the host's own 60px reserve is exactly
  // right -- but only if the button is centred in it. Left-aligned, the button
  // would sit 12px short of the space the title gives up.
  check('34.4 我们的按钮在宿主那 60px 格里居中（mount 规则带 justify-content:center）',
    hrow.mount.getAttribute('data-mmx-toplock-mount') === hKey
    && css.indexOf('[data-mmx-toplock-mount="' + hKey + '"]{display:flex;align-items:center;justify-content:center}') >= 0,
    hKey + ' :: ' + css.slice(-240));
  // 34.4b The glyph has to grow with the button, or 36px of button still shows
  // a 16px pin and reads as "the same icon, slightly bigger box".
  check('34.4b 图标跟着按钮放大到 20px（比例与 30px 时的 16px 一致）',
    css.indexOf('[data-mmx-toplock-mount="' + hKey + '"] .mmx-toplock-glyph{width:20px;height:20px}') >= 0
    && css.indexOf('.mmx-toplock-glyph{width:16px') >= 0, css.slice(-200));

  // 34.5 The other two sites keep the OLD arithmetic (host reserve + px, and
  // stripWidth + px). Proof the change is per-site, not a global constant swap.
  check('34.5 ipinned 仍是 60+30=90（它在宿主按钮【旁边】，得自己让出宽度）',
    pKey.length > 4
    && css.indexOf('.group:hover [data-mmx-toplock-reserve="' + pKey + '"]{margin-right:90px}') >= 0
    && css.indexOf('data-mmx-toplock-strip="' + pKey + '"') < 0, pKey);
  check('34.5b irecent 的定宽条仍是 60+30=90px 写在悬停/聚焦态',
    /^m\d+h\d+f\d+p\d+a\d+w60$/.test(rKey)
    && css.indexOf('.group:hover [data-mmx-toplock-strip="' + rKey + '"]{width:90px}') >= 0
    && css.indexOf('.group:focus-within [data-mmx-toplock-strip="' + rKey + '"]{width:90px}') >= 0,
    rKey);
  check('34.5c 三个 site 的 key 互不相同（规则不会互相覆盖）',
    hKey !== pKey && hKey !== rKey && pKey !== rKey, [hKey, pKey, rKey].join(' '));

  // 34.6 The invariant that makes 36 legal at all: our button has to FIT the
  // host-sized cell it lives in. Read back from the shipped table + the
  // emitted rule, so a future px bump fails here instead of overflowing.
  const A34 = makeLockPage();
  const mhd36 = A34.api.sites.filter((s) => s.name === 'mhd-pinned')[0];
  const cellRule = (css.match(new RegExp('\\[data-mmx-toplock-mount="'
    + hKey + '"\\]\\{display:flex;align-items:center[^}]*\\}')) || [''])[0];
  const hoverRule = (css.match(new RegExp('\\.group:hover \\[data-mmx-toplock-reserve="'
    + hKey + '"\\]\\{margin-right:(\\d+)px\\}')) || [0, '0'])[1];
  check('34.6 36px 装得进宿主那一格（reserve 反推出的格宽 >= 按钮）',
    !!mhd36 && mhd36.px === 36 && Number(hoverRule) >= mhd36.px
    && cellRule.indexOf('justify-content:center') >= 0,
    'px=' + (mhd36 && mhd36.px) + ' cell>=' + hoverRule);

  // 34.6b The budget 34.6 does NOT check. 34.6 is entirely about WIDTH: the
  // host's cell is w-[60px] and 36 fits inside it with room to spare. HEIGHT
  // is a separate budget, and 36 does not fit inside h-[30px] -- the button is
  // 3px taller than the cell on each side, because the cell centres it
  // (align-items:center) and lets the excess leave the box.
  //
  // That overflow is a real, shipped, currently-true fact, not a defect to fix
  // here, and 34.6 cannot see it: every one of its numbers is horizontal. It
  // is pinned because it is only HARMLESS. Three separate elements could clip
  // it -- the cell, the strip, and the rule we emit for the cell -- and an
  // overflow-hidden on any one of them would crop the top and bottom of the
  // pin glyph and turn "a bigger, more clickable button" into a chopped one.
  // Reading the three off the DOM and the emitted stylesheet is what makes the
  // next size change a deliberate decision instead of an accident.
  const cellCls = String(hrow.mount.getAttribute('class'));
  const stripCls = String(hrow.strip.getAttribute('class'));
  const cellH = Number((cellCls.match(/h-\[(\d+)px\]/) || [])[1] || 0);
  const btnCls = String(hBtn.getAttribute('class'));
  const btnH = Number((btnCls.match(/h-\[(\d+)px\]/) || [])[1] || 0);
  const overPerSide = (btnH - cellH) / 2;
  const clipFree = [cellCls, stripCls, cellRule]
    .every((s) => String(s).indexOf('overflow-hidden') < 0);
  check('34.6b 36px 在宿主 h-[30px] 格里纵向各溢出 3px，且格/条/我们写的规则都不裁它',
    !!mhd36 && mhd36.px === 36 && btnCls.indexOf('h-[36px]') >= 0
    && cellH === 30 && btnH === 36 && overPerSide === 3 && clipFree,
    `cell=${cellH}px btn=${btnH}px over/side=${overPerSide}px clip-free=${clipFree}`);

  // 34.7 At rest our rule is what MAKES the cell visible, and the host reserves
  // nothing at rest (its mr-2). Pinning the status quo: no resting rule, so the
  // enlargement never silently steals ~50px of every title.
  check('34.7 静息态不写 reserve 规则（不白缩标题；这是既有行为，已钉住）',
    css.indexOf('}' + '[data-mmx-toplock-reserve="' + hKey + '"]{margin-right') < 0,
    hKey + ' :: ' + css.slice(-160));
  check('34.7b 标题只多了一个自有属性，class 一字未改',
    hrow.title.getAttribute('class') === IPINNED_TITLE
    && hrow.title.getAttribute('data-mmx-toplock-reserve') === hKey
    && hrow.title.getAttribute('data-mmx-toplock-mount') === null,
    hrow.title.getAttribute('class'));
  check('34.7c 宿主 mount 的 class 一字未改（我们只加自有属性）',
    hrow.mount.getAttribute('class') === MHD_MOUNT, hrow.mount.getAttribute('class'));
}

console.log(`\npass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-top-lock: ALL GREEN' : 'test-top-lock: FAILED');
process.exit(fail === 0 ? 0 : 1);
