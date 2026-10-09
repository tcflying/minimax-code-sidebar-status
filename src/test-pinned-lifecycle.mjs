// mmx-status :: test-pinned-lifecycle.mjs
//
// Behaviour tests for the pinned-section housekeeping and the teardown path,
// running the REAL code sliced out of lib/page-script.mjs against a fake DOM.
//
// These cover defects that a source-pattern check cannot see. The previous
// suite's regexes survived a mutation that changed the expand guard's height
// threshold from 40 to 0 and one that emptied the dispose teardown, because
// the pattern still matched the surrounding text. Every assertion here has to
// be executed for the suite to pass.
//
// Sections:
//   1. summary bar position  -- a header-only remount used to strand the bar at
//      the end of the section for good, because only the parent was checked
//   2. truncation button     -- a session titled 更多 must not be mistaken for
//      the list's own truncation control
//   3. expansion escape hatch -- the memory must not be a one-way ratchet, and
//      it must not fake a collapse by hiding real rows
//   4. restore / memory      -- only a real click updates the memory
//   5. auto-expand guard     -- same-frame folding, with the 40px threshold
//   6. debounce              -- a queued rAF must not run after dispose
//   7. dispose               -- nothing of ours may survive teardown
//
// Mutations (each MUST turn this file red):
//   s1  ensureSummary accepts a bar in the right parent at the wrong position
//   s2  pinnedTruncButton drops the "not inside a session row" guard
//   s3  pinnedTruncButton drops the "parent holds rows" guard
//   s4  the escape control appears even while the list is still collapsed
//   s5  the expand guard's height threshold becomes 0
//   s6  dispose stops removing the contextmenu listener
//   s7  the click memory goes back to raw text equality, so it stops matching
//       the restore's classifier in both directions
//       -> "3.9 「展开其余 23 项」" and "3.10 会话行自己的「更多」" fail
//   s8  A12: the dot claim goes back to a descendant search, so a row adopts or
//       deletes a nested row's dot -> every "8.8a" and "8.8b" fails
//   s9  A12: applyReorder claims a session row from anywhere under the wrapper,
//       so a nested running session hoists its whole parent -> "8.8c" fails
//   s10 unknownIds goes back to being a dead field (always 0)
//       -> "8.9" fails
//   s11 the dot takes its pointer events back, so the title it already carries
//       can never reach a mouse -> "8.7" fails
//   s12 apply() stops asking whether the signal is stale
//       -> "8.10" and "8.10c" fail
//   s13 A13 daemon side: the timestamp is published AFTER a.refresh() instead of
//       before it -> "8.10d" fails
//   s14 A13: the bootstrap timestamp's "> 0" guard goes away, so the shipped
//       default of 0 is read as a real refresh time
//       -> "8.10e" fails
//
//   node test-pinned-lifecycle.mjs
//   MMX_MUTATE=<id> node test-pinned-lifecycle.mjs   # expected: FAILED

import fs from 'node:fs';
import { makeDom } from './testlib/fake-dom.mjs';

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

let pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
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

const SUMMARY_BLOCK = sliceBlock('  function ensureSummary() {', '  // Hoist running rows.');
// The pinned-section housekeeping lives in two runs: the preference + button
// lookup + escape control, and (after the menu block) the restore itself and
// the click listener. Both are exercised, so both are sliced.
const PINNED_A = sliceBlock("  var PINNED_MORE_KEY = 'mmxStatusPinnedMore';", "  var TOPMOST_LABEL = '到最顶';");
const PINNED_B = sliceBlock('  function restorePinnedMore(stats) {', '  var handler = function () { scheduleApply(); };');
const PINNED_BLOCK = PINNED_A + PINNED_B;
const CARET_BLOCK = sliceBlock('  function caretOf(el) {', '  // Pinned-section truncation memory');
const DEBOUNCE_BLOCK = sliceBlock('  // ---------- debounce ----------', '  var expandGuardObserver = new MutationObserver(');
const DISPOSE_BLOCK = sliceBlock('    dispose: function () {', '  window[GLOBAL] = api;');

let summarySrc = SUMMARY_BLOCK;
let pinnedSrc = PINNED_BLOCK;
let caretSrc = CARET_BLOCK;
let disposeSrc = DISPOSE_BLOCK;

if (MUT === 's1') {
  summarySrc = mutate(summarySrc,
    'if (bar && bar.parentElement === sec && sec.children[1] === bar) return bar;',
    'if (bar && bar.parentElement === sec) return bar;', 's1');
} else if (MUT === 's2') {
  pinnedSrc = mutate(pinnedSrc,
    "if (b.closest && b.closest('[data-session-id]')) return null;",
    '// session-row guard removed by mutation s2', 's2');
} else if (MUT === 's3') {
  pinnedSrc = mutate(pinnedSrc, 'if (!rowsHere) return null;', '', 's3');
} else if (MUT === 's4') {
  pinnedSrc = mutate(pinnedSrc,
    'var wanted = pinnedMoreState.want === true && !pinnedTruncButton();',
    'var wanted = pinnedMoreState.want === true;', 's4');
} else if (MUT === 's5') {
  caretSrc = caretSrc.replace(/getBoundingClientRect\(\)\.height <= 40/g, 'getBoundingClientRect().height <= 0');
  if (caretSrc === CARET_BLOCK) throw new Error('mutation s5 anchor not found');
} else if (MUT === 's6') {
  disposeSrc = mutate(disposeSrc,
    "try { document.removeEventListener('contextmenu', onContextMenu, true); } catch (e) {}",
    '// contextmenu listener removal removed by mutation s6', 's6');
} else if (MUT === 's7') {
  // The pre-2026-10-03 memory path: raw text equality, no structural check and
  // no count form, so it disagreed with the restore in both directions.
  pinnedSrc = mutate(pinnedSrc,
    `    var kind = classifyPinnedButton(b);
    if (!kind) return;
    var f = pinnedTruncButton();
    if (!f || f.btn !== b) return;
    rememberPinnedMore(kind === 'expand');`,
    `    var t = (b.textContent || '').trim();
    if (t === '更多' || t === 'More') rememberPinnedMore(true);
    else if (t === '收起' || t === 'Show less') rememberPinnedMore(false);`, 's7');
} else if (MUT === 's8') {
  // A12: the dot claim goes back to a descendant search. ensureDot and apply()
  // then adopt (or, when the outer row has no bucket, DELETE) a dot that belongs
  // to a session row NESTED inside this one.
  pageSrc = pageSrc.replace(/querySelector\(':scope > \[' \+ MARK \+ '\]'\)/g,
    "querySelector('[' + MARK + ']')");
  if (!/querySelector\(':scope > /.test(pageSrc)) throw new Error('mutation s8 anchor not found');
} else if (MUT === 's9') {
  // A12, the other half: applyReorder goes back to claiming a session row from
  // anywhere under the wrapper, so a wrapper whose OWN session is idle gets
  // hoisted because a nested session is running.
  const rowAnchor = "w.querySelector(':scope > [data-session-id]')";
  if (pageSrc.split(rowAnchor).length - 1 !== 1) throw new Error('mutation s9 anchor not unique');
  pageSrc = pageSrc.replace(rowAnchor, "w.querySelector('[data-session-id]')")
    .replace(/row\.querySelector\(':scope > \[' \+ MARK \+ '\]\[data-mmx-bucket="/g,
      "row.querySelector('[' + MARK + '][data-mmx-bucket=\"");
} else if (MUT === 's10') {
  // unknownIds goes back to being a dead field: always 0, so a row the module
  // cannot resolve reads as a row with nothing wrong with it.
  pageSrc = mutate(pageSrc, 'else if (map[id] === undefined) stats.unknownIds++;', '', 's10');
} else if (MUT === 's11') {
  // The dot takes its pointer events back. title stays on the node, so the
  // semantic text is still there -- and still unreachable by a mouse.
  pageSrc = mutate(pageSrc, "'  pointer-events:auto;cursor:help;',", "'  pointer-events:none;',", 's11');
} else if (MUT === 's12') {
  // A13: apply() stops asking whether the signal is stale, so a dead daemon
  // leaves a page that looks exactly as healthy as a live one.
  pageSrc = mutate(pageSrc, '    updateStaleNote(Date.now() - lastRefreshAt);', '', 's12');
} else if (MUT === 's13') {
  // A13, daemon side: the server timestamp is published AFTER a.refresh()
  // instead of before it. Subtle because it still compiles and still runs --
  // the page simply never sees the timestamp that belongs to THIS tick, only the
  // one from the previous tick, so the age reported to the user is off by one
  // whole interval and a fresh signal can look like a stale one.
  pageSrc = mutate(pageSrc, 'try{a.__sentAt=Date.now();}catch(e){}', '', 's13')
    .replace('return {ok:true,stats:a.refresh(', 'var __r=a.refresh(')
    .replace('),topmost:a.topmost()', ');a.__sentAt=Date.now();return {ok:true,stats:__r,topmost:a.topmost()');
  if (/try\{a\.__sentAt=Date\.now\(\);\}catch\(e\)\{\}/.test(pageSrc)) throw new Error('mutation s13 did not move the write');
} else if (MUT === 's14') {
  // A13: the '> 0' guard on the bootstrap timestamp goes away, so the shipped
  // default of 0 is accepted as a real refresh time. Every caller that does NOT
  // come from the daemon (debug-guard, verify-*, the offline suites) then starts
  // life believing the last refresh happened in 1970 and shows a permanent,
  // fabricated "signal N seconds out of date".
  pageSrc = mutate(pageSrc,
    "typeof cfg.sentAt === 'number' && isFinite(cfg.sentAt) && cfg.sentAt > 0",
    "typeof cfg.sentAt === 'number' && isFinite(cfg.sentAt)", 's14');
} else if (MUT) {
  throw new Error('unknown MMX_MUTATE=' + MUT);
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

function makePinnedPage(opts = {}) {
  const dom = makeDom();
  const localStorage = makeStorage(opts.stored);
  const factory = new Function(
    'document',
    'localStorage',
    'SUMMARY_ID',
    'MARK',
    pinnedSrc + '\nreturn { pinnedTruncButton, ensurePinnedCollapse, onPinnedCollapseClick,' +
      ' rememberPinnedMore, restorePinnedMore, onPinnedMoreClick, state: pinnedMoreState,' +
      ' key: PINNED_MORE_KEY };'
  );
  const api = factory(dom.document, localStorage, 'mmx-running-summary', 'data-mmx-dot');
  return { dom, localStorage, api };
}

// The host's own markup, per app.asar @316733013:
//   div[data-pinned-section]
//     > header
//     > div.relative.min-h-[4px].space-y-px      <- the droppable list
//         > div[data-pinned-item-id] > div[data-session-id]  (xN)
//         > button (the truncation control, only while collapsed)
function buildSection(dom, { rows = 6, trunc = true, truncText = '更多', sectionTitle = '置顶' } = {}) {
  const sec = dom.el('div', { 'data-pinned-section': 'true' });
  const header = dom.el('div', { class: 'h-[30px] flex' }, [dom.el('span', {}, [sectionTitle])]);
  const list = dom.el('div', { class: 'relative min-h-[4px] space-y-px' });
  const rowNodes = [];
  for (let i = 0; i < rows; i++) {
    const id = 'mvs_p' + i;
    const row = dom.el('div', { 'data-session-id': id });
    const wrap = dom.el('div', { 'data-pinned-item-id': 'pinned:session:' + id }, [row]);
    list.appendChild(wrap);
    rowNodes.push({ row, wrap });
  }
  let truncBtn = null;
  if (trunc) {
    truncBtn = dom.el('button', { type: 'button' }, [dom.el('span', {}, [truncText])]);
    list.appendChild(truncBtn);
  }
  sec.appendChild(header);
  sec.appendChild(list);
  dom.root.appendChild(sec);
  return { sec, header, list, rowNodes, truncBtn };
}

// ---------------------------------------------------------------------------
console.log(`\n=== 0. 出厂代码切片（MMX_MUTATE=${MUT || 'none'}）===`);
{
  let ok = true;
  // The dispose slice is an object-literal property, the others are bare
  // declarations, so each gets the wrapper its own syntax needs.
  const slices = [
    ['summary', summarySrc, '{\n' + summarySrc + '\n}'],
    ['pinned', pinnedSrc, '{\n' + pinnedSrc + '\n}'],
    ['caret', caretSrc, '{\n' + caretSrc + '\n}'],
    ['debounce', DEBOUNCE_BLOCK, '{\n' + DEBOUNCE_BLOCK + '\n}'],
    ['dispose', disposeSrc, 'var api = {' + disposeSrc + ' return api.dispose;'],
  ];
  for (const [, , wrapped] of slices) {
    try { new Function('document', 'localStorage', wrapped); } catch (e) { ok = false; }
  }
  check('五段切片语法合法', ok);
  check('summary 段确实是出厂实现', /function ensureSummary\(\)/.test(summarySrc));
  check('置顶记忆段确实是出厂实现', /function pinnedTruncButton\(\)/.test(pinnedSrc));
  check('dispose 段确实是出厂实现', /dispose: function \(\)/.test(disposeSrc));
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. 汇总条位置：父节点对还不够 ===');
{
  const dom = makeDom();
  const factory = new Function('document', 'SUMMARY_ID', summarySrc + '\nreturn { ensureSummary, updateSummary };');
  const api = factory(dom.document, 'mmx-running-summary');
  const { sec, list } = buildSection(dom);
  api.updateSummary(3, 1);
  let bar = dom.getElementById('mmx-running-summary');
  check('1.1 汇总条建在 header 之后、置顶列表之前',
    sec.children[1] === bar && sec.children[2] === list, `children=${sec.children.length}`);
  // A frame that remounts only the header strands anything appended earlier.
  sec.removeChild(bar);
  sec.appendChild(bar);
  check('1.1 前置条件：模拟把汇总条挪到了 section 末尾', sec.children[sec.children.length - 1] === bar);
  api.updateSummary(3, 1);
  bar = dom.getElementById('mmx-running-summary');
  check('1.2 下一轮把位置修回来（不是只看父节点）', sec.children[1] === bar,
    `index=${sec.children.indexOf(bar)}`);
  check('1.2 复用同一个节点而不是新建', dom.getElementById('mmx-running-summary') === bar);
  check('1.2 置顶列表没有被挪动', sec.children[2] === list);
  check('1.3 没有置顶容器时不建汇总条', (() => {
    const empty = makeDom();
    const api2 = factory(empty.document, 'mmx-running-summary');
    return api2.updateSummary(1, 0) === undefined && empty.getElementById('mmx-running-summary') === null;
  })());
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. 截断按钮：不会点到会话自己的按钮 ===');
{
  const p = makePinnedPage();
  const { list, rowNodes, truncBtn } = buildSection(p.dom);
  // A pinned session literally titled 更多: its own row button has exactly the
  // same textContent as the list's truncation control.
  const titled = p.dom.el('div', { class: 'min-w-0 truncate' }, ['更多']);
  rowNodes[2].row.appendChild(p.dom.el('button', { type: 'button' }, [titled]));
  const found = p.api.pinnedTruncButton();
  check('2.1 找到的是列表自己的截断按钮', found && found.btn === truncBtn,
    found ? found.btn.textContent : '(none)');
  check('2.1 类型判定为 expand', found && found.kind === 'expand');
  check('2.1 标题为「更多」的会话按钮没被当成截断按钮', found && found.btn !== titled);
  void list;
}
{
  const p = makePinnedPage();
  const { truncBtn } = buildSection(p.dom);
  const found = p.api.pinnedTruncButton();
  check('2.2 基础场景仍能找到截断按钮', found && found.btn === truncBtn);
}
{
  // The asar i18n also carries sidebar.pinned_show_more -> 展开其余 {{count}} 项
  // / Show {{count}} more. Matched by its exact rendered shape, not by a loose
  // "contains", and only in the right position.
  const p = makePinnedPage();
  const { truncBtn } = buildSection(p.dom, { truncText: '展开其余 23 项' });
  const found = p.api.pinnedTruncButton();
  check('2.3 计数形态的展开文案可识别', found && found.btn === truncBtn && found.kind === 'expand',
    found ? found.btn.textContent : '(none)');
  const p2 = makePinnedPage();
  buildSection(p2.dom, { truncText: 'Show 23 more' });
  check('2.3 英文计数形态同样可识别', !!p2.api.pinnedTruncButton());
  const p3 = makePinnedPage();
  const { rowNodes } = buildSection(p3.dom, { truncText: '收起' });
  rowNodes[0].row.appendChild(p3.dom.el('div', {}, ['展开其余 5 项']));
  const f3 = p3.api.pinnedTruncButton();
  check('2.3 会话行里的相似文案仍然不算', f3 && f3.kind === 'collapse' && f3.btn.textContent === '收起',
    f3 ? f3.btn.textContent : '(none)');
}
{
  // A control inside the section header sits in a parent that holds no rows.
  const p = makePinnedPage();
  const { sec, header, truncBtn } = buildSection(p.dom);
  const decoy = p.dom.el('button', { type: 'button' }, ['更多']);
  header.appendChild(decoy);
  const found = p.api.pinnedTruncButton();
  check('2.4 header 里的同名按钮不算截断按钮', found && found.btn === truncBtn);
  void sec;
}
{
  // Expanded state: the host renders no control at all.
  const p = makePinnedPage();
  buildSection(p.dom, { rows: 9, trunc: false });
  check('2.5 展开态（无截断按钮）时返回 null', p.api.pinnedTruncButton() === null);
}
{
  // A project group's own 更多 lives outside the pinned section entirely.
  const p = makePinnedPage();
  const { truncBtn } = buildSection(p.dom);
  const group = p.dom.el('div', { 'data-testid': 'sidebar-session-group' });
  const inner = p.dom.el('div', { class: 'space-y-px' });
  inner.appendChild(p.dom.el('div', { 'data-session-id': 'mvs_g1' }));
  inner.appendChild(p.dom.el('div', { 'data-session-id': 'mvs_g2' }));
  inner.appendChild(p.dom.el('div', { 'data-session-id': 'mvs_g3' }));
  const gmore = p.dom.el('button', { 'data-testid': 'sidebar-session-group-more' }, ['更多']);
  inner.appendChild(gmore);
  group.appendChild(inner);
  p.dom.root.appendChild(group);
  const found = p.api.pinnedTruncButton();
  check('2.6 项目组自己的「更多」不会被点到', found && found.btn === truncBtn, found ? found.btn.textContent : '(none)');
}
{
  // The case that separates the two guards: an expanded session row shows an
  // INLINE sub-list of its own, and that sub-list has its own truncation
  // control whose parent does hold rows -- so structure alone would accept it.
  // Only "is this inside a session row" rejects it, and clicking it would fold
  // somebody's sub agent list instead of the pinned list.
  const p = makePinnedPage();
  const { sec, rowNodes, truncBtn } = buildSection(p.dom);
  const row = rowNodes[1].row;
  const sub = p.dom.el('div', { class: 'space-y-px' });
  sub.appendChild(p.dom.el('div', { 'data-session-id': 'mvs_child1' }));
  sub.appendChild(p.dom.el('div', { 'data-session-id': 'mvs_child2' }));
  const subMore = p.dom.el('button', { type: 'button' }, ['更多']);
  sub.appendChild(subMore);
  row.appendChild(sub);
  const found = p.api.pinnedTruncButton();
  check('2.7 会话行内展开出的子列表「更多」不会被点到', found && found.btn === truncBtn,
    found ? (found.btn === subMore ? '子列表按钮' : '置顶区按钮') : '(none)');
  void sec;
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. 展开记忆不是单向棘轮 ===');
{
  const p = makePinnedPage({ stored: { mmxStatusPinnedMore: '1' } });
  const { sec, rowNodes, truncBtn } = buildSection(p.dom, { rows: 9, trunc: false });
  check('3.1 前置条件：记忆为展开', p.api.state.want === true);
  const btn = p.api.ensurePinnedCollapse();
  check('3.1 展开态出现「收起置顶」控件', !!btn, btn ? btn.textContent : '(none)');
  check('3.1 控件放在置顶区里、在列表之前', sec.children[1] === btn,
    `index=${sec.children.indexOf(btn)}`);
  check('3.1 控件不是会话行的一部分（不会被当成状态点）', btn.closest('[data-session-id]') === null);
  check('3.1 控件不隐藏任何宿主行（不造假折叠）',
    rowNodes.length === 9 && rowNodes.every((r) => r.row.isConnected) &&
    sec.children[2].querySelectorAll('[data-session-id]').length === 9,
    `rows=${rowNodes.filter((r) => r.row.isConnected).length}`);
  check('3.1 文案说明这不是即时折叠', /重挂|切换/.test(btn.title), btn.title);
  check('3.2 再次调用复用同一个节点', p.api.ensurePinnedCollapse() === btn);
  // A synthetic click is our own machinery, not the user.
  btn.dispatch('click', { isTrusted: false });
  check('3.2 合成点击不改变记忆', p.api.state.want === true && !!p.dom.document.getElementById('mmx-pinned-collapse'));
  btn.dispatch('click', { isTrusted: true });
  check('3.3 真实点击清掉本工具的记忆', p.api.state.want === false, `want=${p.api.state.want}`);
  check('3.3 记忆落盘也被清掉', p.localStorage.dump().mmxStatusPinnedMore === '0',
    JSON.stringify(p.localStorage.dump()));
  check('3.3 控件自己消失', p.dom.document.getElementById('mmx-pinned-collapse') === null);
  void truncBtn;
}
{
  // While the list is still collapsed there is nothing to escape from, so the
  // control must stay out of the way.
  const p = makePinnedPage({ stored: { mmxStatusPinnedMore: '1' } });
  buildSection(p.dom, { rows: 6, trunc: true });
  check('3.4 折叠态不出现「收起置顶」', p.api.ensurePinnedCollapse() === null);
  const p2 = makePinnedPage();
  buildSection(p2.dom, { rows: 9, trunc: false });
  check('3.4 没有记忆时不出现该控件', p2.api.ensurePinnedCollapse() === null);
}
{
  // Once memory is off and the host remounts, restore must stop clicking.
  const p = makePinnedPage();
  const { truncBtn } = buildSection(p.dom, { rows: 6, trunc: true });
  let clicks = 0;
  truncBtn.addEventListener('click', () => {
    clicks++;
    // The host expands and the control leaves the DOM; that is what makes the
    // restore self-limiting.
    truncBtn.remove();
  });
  p.api.rememberPinnedMore(false);
  const stats = {};
  p.api.restorePinnedMore(stats);
  check('3.5 want=false 时不再代点展开', clicks === 0, `clicks=${clicks}`);
  check('3.5 统计里不出现恢复计数', stats.pinnedMoreRestored === undefined);
  p.api.rememberPinnedMore(true);
  p.api.restorePinnedMore(stats);
  check('3.6 want=true 时恢复一次并计数', clicks === 1 && stats.pinnedMoreRestored === 1,
    `clicks=${clicks} restored=${stats.pinnedMoreRestored}`);
  p.api.restorePinnedMore(stats);
  check('3.6 展开后按钮消失，不会连点', clicks === 1, `clicks=${clicks}`);
}
{
  // Only a real click inside the section updates the memory.
  const p = makePinnedPage();
  const { truncBtn } = buildSection(p.dom, { rows: 6, trunc: true });
  p.api.onPinnedMoreClick({ target: truncBtn, isTrusted: false });
  check('3.7 合成点击不写入记忆', p.api.state.want === null, `want=${p.api.state.want}`);
  p.api.onPinnedMoreClick({ target: truncBtn, isTrusted: true });
  check('3.8 真实点击写入记忆', p.api.state.want === true, `want=${p.api.state.want}`);
  const outside = p.dom.el('button', {}, ['更多']);
  p.dom.el('div', { 'data-testid': 'sidebar-session-group' }, [outside]);
  p.dom.root.appendChild(outside.parentElement);
  p.api.onPinnedMoreClick({ target: outside, isTrusted: true });
  check('3.8 置顶区之外的同名按钮不写入记忆', p.api.state.want === true, `want=${p.api.state.want}`);
}
{
  // The memory and the restore used to be two different classifiers: the
  // restore looked buttons up structurally, the memory compared raw text.
  // They disagreed in both directions -- a trusted click on 「展开其余 23 项」
  // (which the restore does act on) never wrote the memory, and a click on a
  // session row whose own title is 「更多」 did. One classifier, both paths.
  const p = makePinnedPage();
  const { truncBtn } = buildSection(p.dom, { rows: 6, truncText: '展开其余 23 项' });
  const f = p.api.pinnedTruncButton();
  check('3.9 前置条件：计数形态的展开按钮被认作 expand', !!f && f.kind === 'expand',
    f ? f.kind : '(none)');
  p.api.onPinnedMoreClick({ target: truncBtn, isTrusted: true });
  check('3.9 用户真实点击「展开其余 23 项」写入 want=true', p.api.state.want === true,
    `want=${p.api.state.want}`);
  check('3.9 记忆同时落盘', p.localStorage.dump().mmxStatusPinnedMore === '1',
    JSON.stringify(p.localStorage.dump()));
}
{
  const p = makePinnedPage();
  const { rowNodes, truncBtn } = buildSection(p.dom, { rows: 6, trunc: true });
  // A pinned session literally titled 更多: its own row button carries exactly
  // the same text as the list's control, and lives inside the same section.
  const rowBtn = p.dom.el('button', { type: 'button' }, [p.dom.el('span', {}, ['更多'])]);
  rowNodes[2].row.appendChild(rowBtn);
  p.api.onPinnedMoreClick({ target: rowBtn, isTrusted: true });
  check('3.10 会话行自己的「更多」不写入记忆', p.api.state.want === null, `want=${p.api.state.want}`);
  p.api.onPinnedMoreClick({ target: truncBtn, isTrusted: true });
  check('3.10 置顶区自己的「更多」仍然写入', p.api.state.want === true, `want=${p.api.state.want}`);
}
{
  const p = makePinnedPage();
  const { rowNodes, truncBtn } = buildSection(p.dom, { rows: 9, truncText: '收起' });
  const rowBtn = p.dom.el('button', { type: 'button' }, [p.dom.el('span', {}, ['收起'])]);
  rowNodes[1].row.appendChild(rowBtn);
  p.api.onPinnedMoreClick({ target: rowBtn, isTrusted: true });
  check('3.11 会话行自己的「收起」不写入记忆', p.api.state.want === null, `want=${p.api.state.want}`);
  p.api.onPinnedMoreClick({ target: truncBtn, isTrusted: true });
  check('3.11 置顶区自己的「收起」写入 want=false', p.api.state.want === false,
    `want=${p.api.state.want}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. 展开守卫：同帧折叠 + 40px 阈值 ===');
{
  const dom = makeDom();
  const factory = new Function('document', 'cfg', caretSrc + '\nreturn { enforceNoAutoExpand, isExpanded, clickCaret };');
  // The guard only ever looks inside the pinned section, so the rows live in one.
  const sec = dom.el('div', { 'data-pinned-section': 'true' });
  dom.root.appendChild(sec);
  function makeCaretRow(expanded, height) {
    const row = dom.el('div', { 'data-session-id': 'mvs_c' });
    const caret = dom.el('div', { class: 'transition-transform' + (expanded ? '' : ' -rotate-90') });
    // asar: the caret sits INSIDE the row's button, which is what
    // clickCaret()'s closest('button') relies on.
    const btn = dom.el('button', {}, ['caret']);
    btn.appendChild(caret);
    row.appendChild(btn);
    row.getBoundingClientRect = () => ({ top: 0, left: 0, width: 100, height, right: 100, bottom: height });
    let clicks = 0;
    btn.addEventListener('click', () => {
      clicks++;
      // The real caret click folds the row; without this the fake rows would
      // still read as expanded on the next pass and the counts would pile up.
      caret.setAttribute('class', 'transition-transform -rotate-90');
    });
    sec.appendChild(row);
    return { row, clicks: () => clicks };
  }
  const api = factory(dom.document, { collapseOnStart: true });
  let r = makeCaretRow(true, 120);
  const out = api.enforceNoAutoExpand();
  check('4.1 展开的行被点一次折叠', out.collapsed === 1 && r.clicks() === 1, JSON.stringify(out));
  r = makeCaretRow(false, 120);
  const out2 = api.enforceNoAutoExpand();
  check('4.2 已折叠的行不再点', out2.collapsed === 0 && r.clicks() === 0, JSON.stringify(out2));
  r = makeCaretRow(true, 40);
  const out3 = api.enforceNoAutoExpand();
  check('4.3 高度 <= 40 的行视为已折叠，不点', out3.collapsed === 0 && r.clicks() === 0, JSON.stringify(out3));
  r = makeCaretRow(true, 41);
  const out4 = api.enforceNoAutoExpand();
  check('4.3 高度 41 的展开行会被折', out4.collapsed === 1 && r.clicks() === 1, JSON.stringify(out4));
  const off = factory(dom.document, { collapseOnStart: false });
  r = makeCaretRow(true, 200);
  check('4.4 --no-collapse 时整段关闭', off.enforceNoAutoExpand().skipped === 'disabled');
  r = makeCaretRow(true, 200);
  check('4.4 关闭时一次都不点', r.clicks() === 0);
  const noSection = factory({ querySelector: () => null }, { collapseOnStart: true });
  check('4.5 没有置顶容器时如实上报', noSection.enforceNoAutoExpand().reason === 'no-pinned-section');
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. dispose 之后不再动页面 ===');
{
  const dom = makeDom();
  const { sec, list, rowNodes } = buildSection(dom);
  const listeners = new Map();
  const document = {
    ...dom.document,
    addEventListener: (t, fn) => {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t).push(fn);
    },
    removeEventListener: (t, fn) => {
      const l = listeners.get(t) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
  };
  const dots = [];
  for (const { row } of rowNodes) {
    const dot = dom.el('span', { 'data-mmx-dot': '1', 'data-mmx-bucket': 'running' });
    row.appendChild(dot);
    dots.push(dot);
  }
  const summary = dom.el('div', { id: 'mmx-running-summary' });
  sec.appendChild(summary);
  const collapseCtl = dom.el('button', { id: 'mmx-pinned-collapse' }, ['收起置顶']);
  sec.appendChild(collapseCtl);
  const style = dom.el('style', { id: 'mmx-status-style' });
  dom.head.appendChild(style);
  const menuItem = dom.el('li', { 'data-mmx-topmost': '1' });
  dom.root.appendChild(menuItem);
  const clearCalls = [];
  const timers = [11, 12, 13];
  let rafCancelled = 0;
  // The three listeners the real bootstrap registers. They have to be present
  // BEFORE dispose runs, otherwise "they are gone afterwards" proves nothing.
  const registered = {
    'mavis:status-refresh': function onRefresh() {},
    click: function onPinnedMoreClick() {},
    contextmenu: function onContextMenu() {},
  };
  for (const [t, fn] of Object.entries(registered)) {
    document.addEventListener(t, fn);
  }
  check('5.0 前置条件：三个监听都已注册',
    listeners.get('click').length === 1 && listeners.get('contextmenu').length === 1 &&
    listeners.get('mavis:status-refresh').length === 1,
    JSON.stringify([...listeners.keys()]));
  const touched = new Set(rowNodes.slice(0, 2).map((r) => r.row));
  for (const row of touched) row.style.position = 'relative';
  const window = {
    removeEventListener: (t, fn) => { document.removeEventListener(t, fn); },
    clearInterval: () => { clearCalls.push('interval'); },
    clearTimeout: (id) => { clearCalls.push(id); },
  };
  // The teardown bumps topmostGeneration, and that has to be observable. It
  // CANNOT be passed in as a parameter: a parameter is a local binding, so a
  // `topmostGeneration++` inside the nested dispose closure rebinds that local
  // and never reaches the caller's object. Declaring it in the sliced body
  // instead puts the counter in the same closure the teardown writes to, and
  // the getter below reads the value the shipped code actually left behind.
  const factory = new Function(
    'window', 'document', 'disposeCloud', 'observer', 'expandGuardObserver', 'handler',
    'onPinnedMoreClick', 'onContextMenu', 'topmostTimers', 'clearTopmostItems', 'timer',
    'rafId', 'pending', 'MARK', 'SUMMARY_ID', 'PINNED_LESS_ID', 'cfg', 'touched', 'GLOBAL',
    'topmostDiagDispose', 'topmostWatch', 'stopTopmostWatch',
    'var disposed = false;\nvar topmostGeneration = 7;\nvar api = {' + disposeSrc +
    '\nreturn { run: api.dispose, generation: function () { return topmostGeneration; } };'
  );
  const observers = [];
  // The diagnostic teardown is spied, not stubbed into existence: the shipped
  // dispose calls it, and a probe that outlived the teardown would keep a
  // detached row reachable for the rest of the page's life.
  let diagDisposed = 0;
  // The menu watch is a live MutationObserver on the document, so dispose has to
  // take it down too. It is handed in as a SENTINEL plus a spy rather than being
  // sliced: what is under test here is that the shipped teardown CALLS the
  // single teardown entry point and hands it the live watch, not a second copy
  // of the teardown. The sentinel proves the right object travelled.
  const WATCH_SENTINEL = { obs: { tag: 'watch' }, stopped: false };
  const watchStops = [];
  const api = factory(window, document,
    () => { observers.push('cloud'); },
    { disconnect: () => observers.push('observer') },
    { disconnect: () => observers.push('expandGuard') },
    registered['mavis:status-refresh'], registered.click, registered.contextmenu,
    timers.slice(),
    () => { clearCalls.push('topmost-items'); menuItem.remove(); },
    7, 9, true, 'data-mmx-dot', 'mmx-running-summary', 'mmx-pinned-collapse',
    { styleId: 'mmx-status-style' }, touched, '__mmxStatus',
    () => { diagDisposed++; },
    WATCH_SENTINEL,
    (w) => { watchStops.push(w); });
  api.run();
  check('5.1 dispose 收掉了还在飞的菜单 watch（观察器不许活过 dispose）',
    watchStops.length === 1 && watchStops[0] === WATCH_SENTINEL, JSON.stringify(watchStops.length));
  check('5.1 dispose 使 toTopmost 代次失效（已派发的回调也作废）', api.generation() === 8,
    `generation=${api.generation()}`);
  check('5.1 dispose 顺带拆掉到最顶诊断的快照', diagDisposed === 1, `topmostDiagDispose×${diagDisposed}`);
  check('5.1 先置 disposed 再清理', observers[0] === 'cloud');
  check('5.1 退订在两个 observer 之前', JSON.stringify(observers) === '["cloud","observer","expandGuard"]',
    JSON.stringify(observers));
  check('5.1 摘掉 mavis:status-refresh 与两个捕获阶段监听',
    ['mavis:status-refresh', 'click', 'contextmenu'].every((t) => (listeners.get(t) || []).length === 0),
    JSON.stringify([...listeners.entries()].map(([k, v]) => k + ':' + v.length)));
  check('5.1 清掉待决定时器与 interval', clearCalls.includes(11) && clearCalls.includes(13) &&
    clearCalls.includes('interval'), JSON.stringify(clearCalls));
  check('5.1 取消未决 rAF', rafCancelled === 0 && clearCalls.includes('topmost-items'));
  check('5.2 圆点全部摘掉', dots.every((d) => !d.isConnected), `left=${dots.filter((d) => d.isConnected).length}`);
  check('5.2 汇总条摘掉', dom.getElementById('mmx-running-summary') === null);
  check('5.2 收起控件摘掉', dom.getElementById('mmx-pinned-collapse') === null);
  check('5.2 注入的菜单项摘掉', dom.querySelectorAll('li[data-mmx-topmost]').length === 0);
  check('5.2 样式摘掉', dom.getElementById('mmx-status-style') === null);
  check('5.3 只还原自己改过 position 的行',
    rowNodes.slice(0, 2).every((r) => r.row.style.position === '') &&
    rowNodes.slice(2).every((r) => r.row.style.position === undefined),
    JSON.stringify(rowNodes.map((r) => r.row.style.position)));
  void list;
}
{
  // A rAF that was already queued when dispose() fired used to run afterwards
  // and repaint every dot, leaving a frozen set of orphans behind.
  const dom = makeDom();
  const api = makePageForDebounce(dom);
  api.apply();
  api.runFrame();
  check('6.1 dispose 之前 rAF 里的 apply 正常跑', api.applied === 1, `applied=${api.applied}`);
  api.apply();                 // queued, then dispose lands before the frame
  api.dispose();
  api.runFrame();
  check('6.1 dispose 之后排队的 rAF 不再跑 apply', api.applied === 1, `applied=${api.applied}`);
  check('6.1 dispose 之后 enforceNoAutoExpand 也不再被调', api.enforced === 1, `enforced=${api.enforced}`);
  api.apply();
  check('6.2 dispose 之后连排队都不会发生', api.queued() === 0, `queued=${api.queued()}`);
}

function makePageForDebounce(dom) {
  void dom;
  const state = { applied: 0, enforced: 0, frames: [], pending: 0 };
  // DEBOUNCE_BLOCK declares its own disposed / rafId / pending, so the real
  // scheduleApply is driven directly and only the counters are read back.
  const live = new Function(
    'requestAnimationFrame', 'cancelAnimationFrame', 'apply', 'api', 'onFrame',
    'var disposed = false;\n' + DEBOUNCE_BLOCK +
    '\nreturn { scheduleApply, isDisposed: function () { return disposed; },' +
    ' setDisposed: function (v) { disposed = v; }, pendingNow: function () { return pending; } };'
  )(
    (fn) => { state.frames.push(fn); return state.frames.length; },
    () => {},
    () => { state.applied++; },
    { enforceNoAutoExpand: () => { state.enforced++; } },
    () => { state.pending++; }
  );
  return {
    apply: () => live.scheduleApply(),
    runFrame: () => {
      state.pending = 0;
      const batch = state.frames.splice(0, state.frames.length);
      for (const fn of batch) fn();
    },
    dispose: () => live.setDisposed(true),
    state,
    get applied() { return state.applied; },
    get enforced() { return state.enforced; },
    queued: () => state.frames.length,
  };
}

// ---------------------------------------------------------------------------
// 8. 状态点语义与汇总去重（README §15.16.4 / 1003.md §14.30.4，A9 / A10 / A11）。
//
// Why THIS suite: A11 is literally the pinned section's doing -- one session is
// rendered both as a pinned copy and as a grouped copy, so its id sits on two
// rows at once. Section 1 above already owns the summary bar, so the bar's new
// legend and its deduped counters belong next to it.
//
// The blocks above are SLICES. This section boots the WHOLE shipped
// __mmxStatusMain, because both halves of the defect live in apply(), which
// cannot run sliced: it is the only place that paints per row and the only
// caller of ensureDot / ensureSummary / updateSummary.
console.log('\n=== 8. 状态点语义：aria / 图例 / 汇总去重 ===');
{
  const PAGE_FN_SRC = pageSrc.slice(
    pageSrc.indexOf('function __mmxStatusMain(cfg) {'),
    pageSrc.lastIndexOf('\n`;') + 1
  );
  check('8.0 出厂 __mmxStatusMain 切到了', PAGE_FN_SRC.length > 1000, `len=${PAGE_FN_SRC.length}`);

  // The row fixture: ids repeated across a pinned row and an ordinary list row,
  // which is exactly what the pinned section produces. No row is a descendant
  // of the other, so per-row painting and per-session counting cannot be
  // confused for one another here.
  //
  // `clock` is a fake Date for the sections that need to move time (8.10). It is
  // threaded in as a factory PARAMETER rather than patched onto globalThis, so
  // two boots in one process cannot see each other's clock, and a section that
  // passes none still gets the real Date and therefore real time.
  function boot(statusMap, ids, cfgExtra = {}, clock = null) {
    const dom = makeDom();
    dom.document.addEventListener = () => {};
    dom.document.removeEventListener = () => {};
    const sec = dom.el('div', { 'data-pinned-section': 'true' });
    const pinnedList = dom.el('div', { class: 'space-y-px' });
    sec.appendChild(dom.el('div', { class: 'h-[30px] flex' }));
    sec.appendChild(pinnedList);
    dom.root.appendChild(sec);
    const list = dom.el('div', { class: 'space-y-px' });
    dom.root.appendChild(list);
    const rows = {};
    for (const [where, id] of ids) {
      const row = dom.el('div', { 'data-session-id': id });
      row.appendChild(dom.el('button', { type: 'button' }, ['会话']));
      (where === 'pinned' ? pinnedList : list).appendChild(row);
      rows[id + '@' + where] = row;
    }
    class FakeMO { observe() {} disconnect() {} }
    const win = {
      setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {},
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      localStorage: makeStorage({}),
    };
    const cfg = { mark: 'data-mmx-dot', styleId: 'mmx-status-style', global: '__mmxStatus',
      summaryId: 'mmx-running-summary', offsetX: 4, intervalMs: 3000, scope: '', showDone: false,
      collapseOnStart: true, reorder: true,
      activeBg: 'rgba(10, 10, 10, 0.10)', activeBgHover: 'rgba(10, 10, 10, 0.14)',
      activeBar: 'rgba(0, 148, 252, 0.90)', status: statusMap, ...cfgExtra };
    const factory = new Function('window', 'document', 'MutationObserver',
      'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'localStorage', 'CSS', 'Date',
      'return (' + PAGE_FN_SRC + ')(' + JSON.stringify(cfg) + ');');
    const result = factory(win, dom.document, FakeMO, win.requestAnimationFrame,
      win.cancelAnimationFrame, () => ({ position: 'relative' }), win.localStorage,
      { escape: (x) => String(x) }, clock || Date);
    return { dom, rows, api: win.__mmxStatus, result };
  }

  // ---- 8.1 A11: 同 id 两行，汇总按会话计 1，rows 仍按行 ----
  {
    const { rows, result, api } = boot(
      { mvs_dup: 'running', mvs_only: 'waiting' },
      [['pinned', 'mvs_dup'], ['list', 'mvs_dup'], ['list', 'mvs_only']]
    );
    const st = result.initial;
    check('8.1 前置：同 id 确实落在两行上（rows 按行 = 3）', st.rows === 3, `rows=${st.rows}`);
    check('8.1 前置：两行各画各的点（每行都有 dot）',
      !!rows['mvs_dup@pinned'].querySelector('[data-mmx-dot]') &&
      !!rows['mvs_dup@list'].querySelector('[data-mmx-dot]'),
      `pinned=${!!rows['mvs_dup@pinned'].querySelector('[data-mmx-dot]')} ` +
      `list=${!!rows['mvs_dup@list'].querySelector('[data-mmx-dot]')}`);
    check('8.1 汇总 running 按会话去重（两行 -> 1）', st.runningOnScreen === 1, `got=${st.runningOnScreen}`);
    check('8.1 汇总 waiting 按会话去重（单行 -> 1）', st.waitingOnScreen === 1, `got=${st.waitingOnScreen}`);
    const live = api.refresh({ mvs_dup: 'running', mvs_only: 'waiting' });
    check('8.1 下一轮仍然去重（不是一次性的）',
      live.runningOnScreen === 1 && live.waitingOnScreen === 1,
      `run=${live.runningOnScreen} wait=${live.waitingOnScreen}`);
  }
  {
    // The bar must render the DEDUPED numbers, not the row count.
    const { dom } = boot({ mvs_dup: 'running' }, [['pinned', 'mvs_dup'], ['list', 'mvs_dup']]);
    const bar = dom.getElementById('mmx-running-summary');
    check('8.2 前置：汇总条建出来了', !!bar);
    check('8.2 汇总条数字是去重后的 1（不是 2）',
      !!bar && bar.querySelector('b').textContent === '1',
      `got=${bar && bar.querySelector('b').textContent}`);
  }

  // ---- 8.3 A9: dot 的 role / aria-label / title ----
  {
    const buckets = ['running', 'waiting', 'paused', 'error', 'done'];
    const ids = buckets.map((_, i) => 'mvs_b' + i);
    const statusMap = {};
    buckets.forEach((b, i) => { statusMap[ids[i]] = b; });
    // `done` is opt-in in the product (--show-done), and apply() drops it to
    // undefined when the flag is off, so the dot would never exist. Turning it
    // on is what makes the grey dot reachable at all.
    const { rows } = boot(statusMap, ids.map((id) => ['list', id]), { showDone: true });
    const CJK = /[一-鿿]/;
    const labels = [];
    for (let i = 0; i < buckets.length; i++) {
      const dot = rows[ids[i] + '@list'].querySelector('[data-mmx-dot]');
      labels.push(dot ? dot.getAttribute('aria-label') : null);
      check(`8.3 ${buckets[i]} 点存在且带 role="img"`,
        !!dot && dot.getAttribute('role') === 'img', `role=${dot && dot.getAttribute('role')}`);
      check(`8.3 ${buckets[i]} 点有中文 aria-label`,
        !!dot && CJK.test(String(dot.getAttribute('aria-label') || '')),
        `aria-label=${dot && dot.getAttribute('aria-label')}`);
      check(`8.3 ${buckets[i]} 点 title 与 aria-label 一致`,
        !!dot && dot.getAttribute('title') === dot.getAttribute('aria-label'),
        `title=${dot && dot.getAttribute('title')}`);
    }
    check('8.3 五个桶的文案互不相同（不是复制粘贴）',
      new Set(labels).size === buckets.length, JSON.stringify(labels));
    // CJK + 互异 only proves the five labels are Chinese and different, so a
    // meaning swap slips through: writing 有子代理在运行 as 等待审批 keeps both
    // properties true while telling a screen reader the wrong thing. Pin the
    // exact wording DOT_SEMANTIC promises, for the waiting bucket and the one
    // bucket a wrong merge would actually mislabel.
    check('8.3 waiting 点的 aria-label 就是 DOT_SEMANTIC.waiting 的原文',
      labels[1] === '有子代理在运行', `aria-label=${labels[1]}`);
    check('8.3 error 点的 aria-label 就是 DOT_SEMANTIC.error 的原文',
      labels[3] === '上一轮失败或存在错误', `aria-label=${labels[3]}`);
  }
  {
    // A reused dot must follow the bucket it is re-labelled with, or the page
    // shows a green bar described as "上一轮失败".
    const { rows, api } = boot({ mvs_r: 'running' }, [['list', 'mvs_r']]);
    const dot = rows['mvs_r@list'].querySelector('[data-mmx-dot]');
    const first = dot.getAttribute('aria-label');
    api.refresh({ mvs_r: 'error' });
    check('8.4 dot 被复用换桶后 aria-label 跟着改',
      dot.getAttribute('aria-label') !== first && dot.getAttribute('data-mmx-bucket') === 'error',
      `before=${first} after=${dot.getAttribute('aria-label')}`);
  }
  {
    const { rows } = boot({}, [['list', 'mvs_none']]);
    check('8.5 无桶的行仍然没有点（语义没让空行多出一颗）',
      rows['mvs_none@list'].querySelector('[data-mmx-dot]') === null);
  }

  // ---- 8.6 A10: 汇总条的静态图例 ----
  {
    const { dom } = boot({ mvs_dup: 'running' }, [['pinned', 'mvs_dup'], ['list', 'mvs_dup']]);
    const bar = dom.getElementById('mmx-running-summary');
    const CJK = /[一-鿿]/;
    const title = String(bar.getAttribute('title') || '');
    const aria = String(bar.getAttribute('aria-label') || '');
    check('8.6 汇总条有 role="group"（否则 aria-label 会被读屏忽略）',
      bar.getAttribute('role') === 'group', `role=${bar.getAttribute('role')}`);
    check('8.6 汇总条有中文 aria-label', CJK.test(aria), `aria-label=${aria}`);
    check('8.6 汇总条有中文 title', CJK.test(title), `title=${title}`);
    // The legend must not invent anything the page never receives: snapshot()
    // is { id: bucket }, so there is no error text and no subagent count to
    // show (the three forbidden claims in 1003.md §14.30.4).
    check('8.6 图例不声称显示错误原文或子任务个数',
      !/错误原文|个子代理|子任务数|个错误/.test(title + aria), title.slice(0, 70));
    // Attributes only: no new child, no new text, no layout shift.
    check('8.6 图例没有给汇总条加子节点（分段数仍是 3）', bar.children.length === 3,
      `children=${bar.children.length}`);
    // textContent aggregates descendants, so this reads the number AND the
    // label together -- a legend must not be able to eat either one.
    check('8.6 计数文字没被改', bar.children[1].textContent === '1 个运行中',
      `got=${JSON.stringify(bar.children[1].textContent)}`);
  }

  // ---- 8.7 状态点的悬停语义（pointer-events）----
  //
  // ensureDot 早就在 dot 上写了 title（8.3 已钉住），但基础 dot 规则写着
  // pointer-events:none —— 那个属性让元素【收不到指针事件】，浏览器于是既不弹
  // title 也不给 cursor。语义其实一直在那儿，只是永远到不了鼠标。
  {
    const { dom } = boot({ mvs_dup: 'running' }, [['list', 'mvs_dup']]);
    const style = dom.getElementById('mmx-status-style');
    check('8.7 前置：自有样式表挂上了', !!style, 'style=' + !!style);
    const css = String(style ? style.textContent : '');
    // 只取【基础】dot 规则那一段：'[data-mmx-dot]{...}'。后面的
    // [data-mmx-dot][data-mmx-bucket=...] 各自是分桶覆盖，不含 pointer-events，
    // 混进来会让"规则段内不再含 pointer-events:none"这句话测不到点上。
    const base = (css.match(/\[data-mmx-dot\]\{([^}]*)\}/) || [])[1];
    check('8.7 前置：基础 dot 规则切到了', typeof base === 'string', JSON.stringify(base));
    check('8.7 基础 dot 规则收指针事件（title 才可能弹出来）',
      /pointer-events\s*:\s*auto/.test(String(base)), JSON.stringify(base));
    check('8.7 基础 dot 规则不再把指针事件关掉',
      !/pointer-events\s*:\s*none/.test(String(base)), JSON.stringify(base));
    check('8.7 基础 dot 规则给了 cursor:help（鼠标停上去是个可问号）',
      /cursor\s*:\s*help/.test(String(base)), JSON.stringify(base));
    // 风险自查：这一段改动不得顺带改掉别的规则。红锁按钮与宿主的原生按钮各自是
    // 独立元素、各有各的规则，dot 收事件不会经过它们；下面两条把"没被顺带改掉"
    // 钉死，免得有人日后用"全局 pointer-events"去修它。
    const lockCss = (pageSrc.match(/\.mmx-toplock-btn\{[^}]*\}/) || [])[0] || '';
    check('8.7 红锁按钮规则仍是 pointer-events:auto + cursor:pointer（没被顺带改）',
      /pointer-events\s*:\s*auto/.test(lockCss) && /cursor\s*:\s*pointer/.test(lockCss),
      JSON.stringify(lockCss.slice(0, 60)));
    const glyphCss = (pageSrc.match(/\.mmx-toplock-glyph\{[^}]*\}/) || [])[0] || '';
    check('8.7 锁的 SVG 字形仍是 pointer-events:none（事件落在按钮上，不是字形上）',
      /pointer-events\s*:\s*none/.test(glyphCss), JSON.stringify(glyphCss.slice(0, 60)));
    // 汇总条那一条 pointer-events:none 是【刻意】的：它压在置顶区头上，收事件
    // 就意味着挡住用户点置顶区里的任何一行。这里不动它。
    const barCss = (css.match(/#mmx-running-summary\{([^}]*)\}/) || [])[1] || '';
    check('8.7 汇总条仍然 pointer-events:none（不挡住置顶区的点击，这是刻意的）',
      /pointer-events\s*:\s*none/.test(barCss), JSON.stringify(barCss.slice(-60)));
  }

  // ---- 8.8 A12：嵌套会话行不得被外层行认领 ----
  //
  // 症状：会话行里再套一层会话行时（宿主折叠/分组展开时会出现），外层行用
  // row.querySelector('[data-mmx-dot]') 找点 —— 那个查询返回【子树里第一个】，
  // 于是认领了内层行的点：内层的点被摘掉或被刷成外层的桶，外层自己反而没有点；
  // applyReorder 同理，w.querySelector('[data-session-id]') 会把 wrapper 里
  // 嵌套的那一行当成"本行的行"，把不该上浮的 wrapper 顶到列表头上。
  // 修法是直接子查询 ':scope > ...'：w 的直接子才是本行 wrapper 的行，嵌套的
  // session 行不得被外层认领。Chrome 27+ 起 querySelector 支持 :scope。
  {
    // ---- 前置：fake-dom 自己认得 :scope > ----
    // 这一条测的是【测试台】，不是产品：如果 fake-dom 把 :scope > 退化成普通
    // 后代查询，下面每一条断言都会"因为台子错了"而不是"因为产品错了"而变绿。
    {
      const d = makeDom();
      const o = d.el('div', { 'data-session-id': 'mvs_out' });
      const inner = d.el('div', { 'data-session-id': 'mvs_in' });
      const dot = d.el('span', { 'data-mmx-dot': '1' });
      inner.appendChild(dot);
      o.appendChild(d.el('button', { type: 'button' }));
      o.appendChild(inner);
      const w = d.el('div', {});
      w.appendChild(o);
      d.root.appendChild(w);
      check('8.8 前置：fake-dom 的 :scope > 只认直接子（不是子树第一个）',
        o.querySelector(':scope > [data-mmx-dot]') === null
        && inner.querySelector(':scope > [data-mmx-dot]') === dot
        && o.querySelector('[data-mmx-dot]') === dot
        && w.querySelector(':scope > [data-session-id]') === o
        && w.querySelector('[data-session-id]') === o,
        'outer:scope>dot=' + o.querySelector(':scope > [data-mmx-dot]'));
    }

    // ---- 8.8a 夹具：列表里三个普通 wrapper + 一个【内含嵌套行】的 wrapper ----
    // list 的直接子全是 wrapper（这才是 findListRoots 认出来的列表形状）；只有
    // 最后一个 wrapper 的行里还嵌着一行会话行，那一行自己带一颗 running 的点。
    function bootNested(statusMap, cfgExtra = {}) {
      const dom = makeDom();
      dom.document.addEventListener = () => {};
      dom.document.removeEventListener = () => {};
      const sec = dom.el('div', { 'data-pinned-section': 'true' });
      sec.appendChild(dom.el('div', { class: 'h-[30px] flex' }));
      dom.root.appendChild(sec);
      const list = dom.el('div', { class: 'space-y-px' });
      dom.root.appendChild(list);
      const mkRow = (id) => {
        const r = dom.el('div', { 'data-session-id': id });
        r.appendChild(dom.el('button', { type: 'button' }, ['会话']));
        return r;
      };
      const wrappers = [];
      for (const id of ['mvs_a', 'mvs_b', 'mvs_c']) {
        const w2 = dom.el('div', { class: 'group relative' });
        w2.appendChild(mkRow(id));
        list.appendChild(w2);
        wrappers.push(w2);
      }
      // 嵌套的那个：wrapper > 外层行 > 内层行 > dot
      const wN = dom.el('div', { class: 'group relative' });
      const outerRow = mkRow('mvs_out');
      const innerRow = mkRow('mvs_in');
      outerRow.appendChild(innerRow);
      wN.appendChild(outerRow);
      list.appendChild(wN);
      wrappers.push(wN);

      class FakeMO { observe() {} disconnect() {} }
      const win = {
        setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {},
        requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
        localStorage: makeStorage({}),
      };
      const cfg = { mark: 'data-mmx-dot', styleId: 'mmx-status-style', global: '__mmxStatus',
        summaryId: 'mmx-running-summary', offsetX: 4, intervalMs: 3000, scope: '', showDone: false,
        collapseOnStart: true, reorder: true,
        activeBg: 'rgba(10, 10, 10, 0.10)', activeBgHover: 'rgba(10, 10, 10, 0.14)',
        activeBar: 'rgba(0, 148, 252, 0.90)', status: statusMap, ...cfgExtra };
      const factory = new Function('window', 'document', 'MutationObserver',
        'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'localStorage', 'CSS',
        'return (' + PAGE_FN_SRC + ')(' + JSON.stringify(cfg) + ');');
      const result = factory(win, dom.document, FakeMO, win.requestAnimationFrame,
        win.cancelAnimationFrame, () => ({ position: 'relative' }), win.localStorage,
        { escape: (x) => String(x) });
      return { dom, list, wrappers, outerRow, innerRow, api: win.__mmxStatus, result };
    }

    // 8.8a 外层行【没有桶】：它绝不能顺手摘掉内层行的点。
    {
      const n = bootNested({ mvs_in: 'running' });
      const innerDot = n.innerRow.querySelector(':scope > [data-mmx-dot]');
      check('8.8a 前置：内层行确实拿到了自己的 running 点', !!innerDot,
        'innerDot=' + !!innerDot);
      const st = n.api.refresh({ mvs_in: 'running' });
      check('8.8a 无桶的外层行不会摘掉内层行的点（removed=0）',
        st.removed === 0, `removed=${st.removed} rows=${st.rows}`);
      check('8.8a 内层行的点还在，且仍是自己那颗 running',
        n.innerRow.querySelector(':scope > [data-mmx-dot]') === innerDot
        && innerDot.getAttribute('data-mmx-bucket') === 'running',
        `survives=${n.innerRow.querySelector(':scope > [data-mmx-dot]') === innerDot} `
        + `bucket=${innerDot.getAttribute('data-mmx-bucket')}`);
      check('8.8a 外层行仍然没有点（它没有桶）',
        n.outerRow.querySelector(':scope > [data-mmx-dot]') === null);
    }

    // 8.8b 外层行【有桶】：它画自己的点，不认领内层那颗。
    {
      const n = bootNested({ mvs_in: 'running' });
      const innerDot = n.innerRow.querySelector(':scope > [data-mmx-dot]');
      const st = n.api.refresh({ mvs_out: 'paused', mvs_in: 'running' });
      const outerDot = n.outerRow.querySelector(':scope > [data-mmx-dot]');
      check('8.8b 外层行画出自己的点（不是空的）', !!outerDot, 'outerDot=' + !!outerDot);
      check('8.8b 外层的点与内层的点是两个不同节点',
        !!outerDot && outerDot !== innerDot, 'same=' + (outerDot === innerDot));
      check('8.8b 外层的桶是它自己的 paused，内层的仍是 running',
        !!outerDot && outerDot.getAttribute('data-mmx-bucket') === 'paused'
        && innerDot.getAttribute('data-mmx-bucket') === 'running',
        `outer=${outerDot && outerDot.getAttribute('data-mmx-bucket')} `
        + `inner=${innerDot.getAttribute('data-mmx-bucket')}`);
      check('8.8b 一趟只新画一颗点（外层那一次；内层换桶没有发生）',
        st.painted === 1, `painted=${st.painted}`);
    }

    // 8.8c applyReorder：wrapper 里的嵌套行不得被当成"本 wrapper 的行"。
    // 旧查询 w.querySelector('[data-session-id]') 会捡到嵌套的内层行，再往下
    // 问那颗 running 的点，于是把整个 wrapper 顶到列表头——外层会话自己并没有在
    // 跑，动的却是别人的父级。
    //
    // 两行【都有】桶是这里的关键：只要外层行没有桶，apply() 就会先把它误认的那颗
    // 内层点摘掉，等 applyReorder 跑到时已经无点可问，这条断言就会因为"另一处
    // 的缺陷顺手掩盖了它"而变绿——测的就不再是认领，而是认领之后有没有被擦掉。
    {
      const both = { mvs_out: 'paused', mvs_in: 'running' };
      const n = bootNested(both);
      check('8.8c 前置：内层的 running 点确实在树上（这一趟没人摘它）',
        !!n.innerRow.querySelector(':scope > [data-mmx-dot][data-mmx-bucket="running"]'),
        'innerRunning=' + !!n.innerRow.querySelector(':scope > [data-mmx-dot][data-mmx-bucket="running"]'));
      // 判定读 initial：boot() 自己就跑了一趟 apply()，那【就是】这一趟 applyReorder
      // 第一次动手的时刻。读后续 refresh 的话，它只会报 alreadyOk（上一趟已经
      // 动过了，或者根本没动过），测不到"会不会动"。
      check('8.8c 嵌套行不得让它的 wrapper 被上浮（initial moved=0）',
        n.result.initial.reorder && n.result.initial.reorder.moved === 0,
        JSON.stringify(n.result.initial.reorder));
      check('8.8c 列表头一个 wrapper 仍是普通那一个，不是嵌套那一个',
        n.list.children[0] !== n.wrappers[3],
        'head=' + n.list.children.indexOf(n.wrappers[3]));
      // 再刷新一趟：如果第一趟真的动过（缺陷），第二趟就会报 alreadyOk，
      // 顺序也已经错了；两条一起才把"没动过"钉死。
      const st = n.api.refresh(both);
      check('8.8c 后续刷新同样不把它上浮',
        st.reorder && st.reorder.moved === 0 && n.list.children[0] !== n.wrappers[3],
        JSON.stringify(st.reorder) + ' head=' + n.list.children.indexOf(n.wrappers[3]));
    }
  }

  // ---- 8.9 unknownIds：曾经恒为 0 的死字段 ----
  //
  // stats 里一直带着 unknownIds，却从来没有一行代码给它 +1。它本来要回答的
  // 是"这一行挂着的会话 id，本地和云端两处都答不上来"——也就是"这一行我们
  // 什么都不画，而用户看不出为什么"。恒为 0 时，daemon 日志里这个数字永远
  // 干净，一个真的对不上的 id 就这样被统计成"没有异常的行"。
  {
    const { result } = boot({ mvs_a: 'running' }, [['list', 'mvs_a'], ['list', 'mvs_ghost']]);
    check('8.9 认不出的 id 被计一次（现出厂恒为 0）',
      result.initial.unknownIds === 1,
      `unknownIds=${result.initial.unknownIds} rows=${result.initial.rows}`);
  }
  {
    // 反向：认得出的行一个都不许多算——包括同 id 出现在两行上的那种（8.1 的
    // 置顶副本 + 列表副本），重复出现不是"认不出"。
    const { result } = boot({ mvs_a: 'running', mvs_b: 'waiting' },
      [['pinned', 'mvs_a'], ['list', 'mvs_a'], ['list', 'mvs_b']]);
    check('8.9b 全部认得出的行 unknownIds=0', result.initial.unknownIds === 0,
      `unknownIds=${result.initial.unknownIds} rows=${result.initial.rows}`);
  }
  {
    // done 是 opt-in：cfg.status 里【有】这个 id，只是这一趟被 showDone 挡掉
    // 了没画点。这不是"认不出"，用它来冒充 unknown 会让这个计数变成"没画点的
    // 行数"，而那件事 stats.matched / stats.painted 已经说得更准了。
    const { result } = boot({ mvs_a: 'running', mvs_d: 'done' },
      [['list', 'mvs_a'], ['list', 'mvs_d']], { showDone: false });
    check('8.9c 被 showDone 挡掉的 done 不算 unknown（它认得出，只是没画）',
      result.initial.unknownIds === 0 && result.initial.matched === 1,
      `unknownIds=${result.initial.unknownIds} matched=${result.initial.matched}`);
  }

  // ---- 8.10 A13：daemon 掉线时汇总条的过期标注 ----
  //
  // daemon 每 2500ms 调一次 refresh。它死了、或者 evaluateWithRetry 一直失败
  // 时，页面【什么都不会变】：点还是绿的、数字还是对的，只是它们已经过期了。
  // 用户分不出"这一分钟没有会话在跑"和"我已经三分钟没收到信号了"。
  // 这里只【标注】，绝不删点、绝不改色、绝不撤回任何宿主 DOM：过期的点仍然是
  // 宿主最后一次告诉我们的样子，只是旁边多一句"这是 N 秒前的"。刷新一恢复，
  // 后缀自动摘掉。
  {
    let T = 1000000;
    const clock = { now: () => T };
    const st = { mvs_a: 'running' };
    const n = boot(st, [['list', 'mvs_a']], {}, clock);
    const bar = n.dom.getElementById('mmx-running-summary');
    const baseAria = String(bar.getAttribute('aria-label') || '');
    check('8.10 前置：汇总条建出来了', !!bar);
    check('8.10 前置：刚启动时没有过期后缀',
      !/未更新/.test(bar.textContent) && !/数据可能过期/.test(baseAria),
      JSON.stringify(bar.textContent));
    // 出厂默认 sentAt=0 必须被读成"没有"，而不是"1970 年刷新过一次"。
    // 少了这一条，所有不带 daemon 的调用方（debug-guard / verify-* / 离线套件）
    // 一上来就永远挂着一条假的过期提示。
    {
      let T0 = 500000;
      const z = boot({ mvs_a: 'running' }, [['list', 'mvs_a']], { sentAt: 0 },
        { now: () => T0 });
      const zbar = z.dom.getElementById('mmx-running-summary');
      check('8.10e 出厂默认 sentAt=0 不会被读成"1970 年刷新过"（不假装过期）',
        !/未更新/.test(zbar.textContent)
        && !/数据可能过期/.test(String(zbar.getAttribute('aria-label'))),
        JSON.stringify(zbar.textContent));
      const y = boot({ mvs_a: 'running' }, [['list', 'mvs_a']], { sentAt: T0 },
        { now: () => T0 + 20000 });
      const ybar = y.dom.getElementById('mmx-running-summary');
      check('8.10f cfg.sentAt 真的被采信（20s 后那条注入就过期了）',
        /· 信号 20s 未更新/.test(ybar.textContent), JSON.stringify(ybar.textContent));
    }
    // 阈值内：14.9s 仍然不算过期。边界取的是"严格大于"，所以 15s 整也不算。
    T += 14999;
    n.api.apply();
    check('8.10 阈值内（14.9s）不显示', !/未更新/.test(bar.textContent),
      JSON.stringify(bar.textContent));
    T += 1;
    n.api.apply();
    check('8.10 恰好 15s 仍不显示（阈值是严格大于）', !/未更新/.test(bar.textContent),
      JSON.stringify(bar.textContent));
    // 越过阈值。
    T += 1000;
    n.api.apply();
    check('8.10 16s 后出现后缀「· 信号 16s 未更新」',
      /· 信号 16s 未更新/.test(bar.textContent), JSON.stringify(bar.textContent));
    check('8.10 后缀期间 aria-label 追加「数据可能过期」',
      /数据可能过期/.test(String(bar.getAttribute('aria-label'))),
      String(bar.getAttribute('aria-label')));
    check('8.10 后缀是加在文本上的，不是加了一个子节点（分段数仍是 3）',
      bar.children.length === 3, `children=${bar.children.length}`);
    check('8.10 只标注，不动宿主那一份：点还在，桶没变',
      !!n.rows['mvs_a@list'].querySelector(':scope > [data-mmx-dot][data-mmx-bucket="running"]'),
      'dotGone');
    check('8.10 计数文字本身没被后缀吃掉',
      bar.children[1].textContent === '1 个运行中', JSON.stringify(bar.children[1].textContent));
    // 服务器时间路径：daemon 在调 refresh 之前把时间写在 api.__sentAt 上，
    // 页面读一次就清掉。这一条断言的是【写进去就能生效】，不是页面自己
    // 猜的 now()——两者在真机上同钟同刻，但在别的宿主里不保证。
    T += 20000;
    n.api.__sentAt = T;
    n.api.apply();
    check('8.10b 读到 api.__sentAt 后后缀消失（刷新恢复即自动摘除）',
      !/未更新/.test(bar.textContent), JSON.stringify(bar.textContent));
    check('8.10b aria-label 恢复成原始那句（没有残留的过期说明）',
      String(bar.getAttribute('aria-label')) === baseAria,
      String(bar.getAttribute('aria-label')));
    check('8.10b __sentAt 被消费掉了（否则下一趟会拿同一个旧时间戳当新鲜）',
      !n.api.__sentAt, 'sentAt=' + n.api.__sentAt);
    // 消费之后再不刷新，16s 后又该出现——这一趟证明的是"真的在跟着时间走"。
    T += 16000;
    n.api.apply();
    check('8.10c 消费之后不再刷新，16s 后后缀重新出现',
      /· 信号 16s 未更新/.test(bar.textContent), JSON.stringify(bar.textContent));
  }

  // ---- 8.10d daemon 侧的表达式：必须在 refresh 之前写入时间戳 ----
  //
  // 页面上写的那一半只有在 daemon 真的在调 refresh 之前写了时间戳时才有用。
  // 这一段把出厂的 buildRefreshExpression 【切出来编译并执行】一遍，在一个假
  // window 上记录调用顺序，而不是去 grep 那串字符、也不是直接 import 那个函数
  // ——import 进来的是模块作用域里的那份，测试里的任何变异都改不到它，于是这条
  // 断言会永远绿。切出来的那份与 pageScript 同源，s13 变异的就是它。
  {
    const refreshFnSrc = sliceBlock('export function buildRefreshExpression(statusMap) {',
      'export function buildDisposeExpression() {').replace('export function', 'function');
    const refreshFn = new Function('GLOBAL', refreshFnSrc + '\nreturn buildRefreshExpression;')('__mmxStatus');
    const expr = refreshFn({ mvs_a: 'running' });
    const order = [];
    const fakeWindow = { __mmxStatus: null };
    fakeWindow.__mmxStatus = {
      refresh: function (m) {
        order.push(['refresh', JSON.stringify(m), fakeWindow.__mmxStatus.__sentAt]);
        return { rows: 1 };
      },
      topmost: function () { order.push(['topmost']); return {}; },
      topmostDiag: function () { order.push(['diag']); return {}; },
    };
    const ran = new Function('window', 'Date', 'return ' + expr + ';')(fakeWindow, { now: () => 424242 });
    check('8.10d refresh 表达式跑得通并返回 stats',
      ran && ran.ok === true && ran.stats && ran.stats.rows === 1, JSON.stringify(ran));
    check('8.10d daemon 的时间戳在 refresh 【之前】写进了 api 对象',
      order.length > 0 && order[0][0] === 'refresh' && order[0][2] === 424242,
      JSON.stringify(order));
  }
}

console.log(`\npass=${pass} fail=${fail}`);
console.log(fail === 0 ? 'test-pinned-lifecycle: ALL GREEN' : 'test-pinned-lifecycle: FAILED');
process.exit(fail === 0 ? 0 : 1);
