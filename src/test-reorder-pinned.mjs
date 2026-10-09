// mmx-status :: test-reorder-pinned.mjs
//
// Behaviour tests for the sidebar hoister, driving the REAL code sliced out of
// lib/page-script.mjs (findListRoots / sameOrder / countMoves / applyReorder)
// against a fake DOM. Nothing here connects to CDP, to the host, or to a
// database.
//
// Why behaviour and not source regex: an earlier suite of 127 source-pattern
// checks proved nothing, because a source check passes whenever the pattern is
// still present -- not when the code around it still works. Two of its own
// deliberate mutations (an emptied move loop, a dispose() that no longer
// removed dots) left it fully green. So every assertion here drives the shipped
// functions and can only pass if they really run.
//
// The four defects under test, and the mutation proofs for each. Run a
// mutation with MMX_MUTATE=<id>; each one is a deliberate re-introduction of the
// OLD logic and MUST turn this file red:
//
//   d1  findListRoots stops excluding the pinned list
//       -> "1.1/D1 pinned section is never reordered" fails
//   d2  change detection goes back to a cached key built from the selected
//       wrappers' own child indexes
//       -> "2.2/D2b a host re-render is repaired again" and
//          "2.1/D2a a second pass inserts nothing" fail
//   d3  the move budget is enforced inside the move loop again
//       -> "3.1/D3 an over-budget pass moves nothing at all" fails
//   d4  pinnedZoneOf's walk-to-the-root goes back to a fixed depth ceiling. The
//       depth-exhausted guard lives inside the loop, so bounding the loop skips
//       it and a real pinned section 15 levels up reads as "not pinned"
//       -> "1.6/D1.6 15 层之上的真置顶区" fails, and the pinned list is reordered
//
//   node test-reorder-pinned.mjs
//   MMX_MUTATE=<id> node test-reorder-pinned.mjs      # expected: FAILED

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

const pageSrc = fs.readFileSync(new URL('./lib/page-script.mjs', import.meta.url), 'utf8');
function sliceBlock(startAnchor, endAnchor) {
  const a = pageSrc.indexOf(startAnchor);
  const b = pageSrc.indexOf(endAnchor);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`cannot slice page-script.mjs between "${startAnchor}" and "${endAnchor}"`);
  }
  return pageSrc.slice(a, b);
}

let BLOCK = sliceBlock(
  '  // Two independent ceilings, because they guard different things:',
  '  // ---- cloud session accumulator'
);

// ---- mutations: each one restores a piece of the previous implementation ----
if (MUT === 'd1') {
  const from = `if (pinnedZoneOf(n)) {
              if (pinnedSeen.indexOf(n) < 0) pinnedSeen.push(n);
            } else if (roots.indexOf(n) < 0) {
              roots.push(n);
            }`;
  const to = `if (roots.indexOf(n) < 0) {
              roots.push(n);
            }`;
  if (!BLOCK.includes(from)) throw new Error('mutation d1 anchor not found');
  BLOCK = BLOCK.replace(from, to);
} else if (MUT === 'd2') {
  // The pre-2026-10-03 change detection: a key derived from the selected
  // wrappers' own child indexes, compared against the previous pass's key.
  const from = 'if (sameOrder(kids, ideal)) { alreadyOk++; continue; }';
  const to = 'if (mmxKeyOf(kids, selected) === mmxLastKey) { alreadyOk++; continue; }';
  if (!BLOCK.includes(from)) throw new Error('mutation d2 anchor A not found');
  BLOCK = BLOCK.replace(from, to);
  const from2 = 'planned += countMoves(kids, selected);';
  const to2 = 'mmxLastKey = mmxKeyOf(kids, selected); planned += countMoves(kids, selected);';
  if (!BLOCK.includes(from2)) throw new Error('mutation d2 anchor B not found');
  BLOCK = BLOCK.replace(from2, to2);
  BLOCK =
    'var mmxLastKey = "";\n' +
    'function mmxKeyOf(kids, sel) {\n' +
    '  return Array.prototype.map.call(sel, function (w) {\n' +
    '    return Array.prototype.indexOf.call(kids, w);\n' +
    '  }).join(",");\n' +
    '}\n' +
    BLOCK;
} else if (MUT === 'd3') {
  const from = `if (planned > REORDER_MAX_MOVES) {
      return {
        moved: 0, roots: roots.length, runningLists: plans.length, alreadyOk: alreadyOk,
        planned: planned, pinnedSkipped: found.pinnedSkipped, aborted: 'move-budget-exhausted',
      };
    }`;
  if (!BLOCK.includes(from)) throw new Error('mutation d3 anchor A not found');
  BLOCK = BLOCK.replace(from, '');
  const from2 = `if (root.firstElementChild === w) continue;`;
  const to2 = `if (moved >= REORDER_MAX_MOVES) {
          return { moved: moved, roots: roots.length, aborted: 'move-budget-exhausted' };
        }
        if (root.firstElementChild === w) continue;`;
  if (!BLOCK.includes(from2)) throw new Error('mutation d3 anchor B not found');
  BLOCK = BLOCK.replace(from2, to2);
} else if (MUT === 'd4') {
  // The pre-2026-10-03 walk: a guessed depth ceiling instead of a walk to the
  // document root. Too shallow means the section is never found, and the only
  // answer the function can then give is "assume pinned" -- so every ordinary
  // sub-list nested deeper than the ceiling silently stops being hoisted.
  const from = 'for (var d = 0; n; d++) {';
  const to = 'for (var d = 0; n && d < 12; d++) {';
  if (!BLOCK.includes(from)) throw new Error('mutation d4 anchor not found');
  BLOCK = BLOCK.replace(from, to);
} else if (MUT) {
  throw new Error('unknown MMX_MUTATE=' + MUT);
}

const MARK = 'data-mmx-dot';

// ---------------------------------------------------------------------------
// Fake sidebar pieces. Shapes taken from the host, not invented:
//  - a row is div[data-session-id] and the hoister's direct child is that row's
//    wrapper (asar@316820593: the pinned wrapper carries data-pinned-item-id
//    and contains the row, so a wrapper holds exactly one child);
//  - the pinned list is a child of div[data-pinned-section] and holds the rows
//    plus its own 'more' button (asar@316733013);
//  - a list is only considered when it has more than three children and at
//    most one non-row child.
// ---------------------------------------------------------------------------
function makePage() {
  const dom = makeDom();
  function row(id, bucket) {
    const r = dom.el('div', { 'data-session-id': id });
    if (bucket) r.appendChild(dom.el('span', { [MARK]: '1', 'data-mmx-bucket': bucket }));
    return r;
  }
  function wrap(r) {
    return dom.el('div', { 'data-pinned-item-id': 'pinned:session:' + r.getAttribute('data-session-id') }, [r]);
  }
  function list(rows, extra = [], attrs = {}) {
    return dom.el('div', Object.assign({ class: 'space-y-px' }, attrs), rows.map(wrap).concat(extra));
  }
  function countInserts(node) {
    let n = 0;
    const orig = node.insertBefore.bind(node);
    node.insertBefore = function (a, b) {
      n++;
      return orig(a, b);
    };
    return () => n;
  }
  const factory = new Function(
    'document',
    'cfg',
    'MARK',
    BLOCK + '\nreturn { applyReorder, findListRoots, sameOrder, countMoves, pinnedZoneOf,' +
      ' maxMoves: REORDER_MAX_MOVES, maxRoots: REORDER_MAX_ROOTS };'
  );
  const api = factory(dom.document, { reorder: true }, MARK);
  return { dom, row, wrap, list, countInserts, api };
}
const labels = (listNode) => listNode.children.map((c) => {
  const r = c.querySelector ? c.querySelector('[data-session-id]') : null;
  return r ? r.getAttribute('data-session-id') : (c.getAttribute('data-session-id') || '#' + c.tagName);
});

console.log(`\n=== 0. 出厂代码切片（MMX_MUTATE=${MUT || 'none'}）===`);
{
  const p = makePage();
  check('切到的是出厂实现而不是副本', typeof p.api.applyReorder === 'function' && typeof p.api.findListRoots === 'function');
  check('预算常量仍是 128 / 32', p.api.maxRoots === 128 && p.api.maxMoves === 32,
    `roots=${p.api.maxRoots} moves=${p.api.maxMoves}`);
  let ok = true;
  try { new Function('document', 'cfg', 'MARK', BLOCK); } catch (e) { ok = false; }
  check('切片语法合法', ok, `${BLOCK.length} chars`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. D1 置顶区顺序不由本项目决定（唯一真相源是宿主数组）===');
{
  const p = makePage();
  // Host shape (asar@316733013): section > [header, list[6 rows + more button]]
  const sec = p.dom.el('div', { 'data-pinned-section': 'true' });
  const header = p.dom.el('div', { class: 'h-[30px]' }, ['置顶']);
  const pinned = p.list(
    [p.row('p1'), p.row('p2', 'running'), p.row('p3'), p.row('p4'), p.row('p5', 'running'), p.row('p6')],
    [p.dom.el('button', { type: 'button' }, ['更多'])]
  );
  sec.appendChild(header);
  sec.appendChild(pinned);
  p.dom.root.appendChild(sec);
  const pinnedInserts = p.countInserts(pinned);
  const before = labels(pinned);

  // A per-project sub-list next to it, which we DO still hoist.
  const proj = p.list([p.row('g1'), p.row('g2'), p.row('g3', 'running'), p.row('g4'), p.row('g5')]);
  p.dom.root.appendChild(p.dom.el('div', { 'data-testid': 'sidebar-session-group' }, [proj]));

  const r = p.api.applyReorder();

  check('D1.1 置顶列表一次 insertBefore 都没有发生', pinnedInserts() === 0, `inserts=${pinnedInserts()}`);
  check('D1.1 置顶列表顺序逐项未变', JSON.stringify(labels(pinned)) === JSON.stringify(before),
    labels(pinned).join(','));
  check('D1.1 置顶列表被识别出来并排除（计数可见）', r.pinnedSkipped === 1, `pinnedSkipped=${r.pinnedSkipped}`);
  check('D1.2 项目子列表照旧被搬（running 提到首位）',
    JSON.stringify(labels(proj)) === JSON.stringify(['g3', 'g1', 'g2', 'g4', 'g5']),
    labels(proj).join(','));
  check('D1.2 置顶区不再算进 roots', r.roots === 1, `roots=${r.roots}`);
  check('D1.2 搬移计数只来自项目子列表', r.moved === 1, `moved=${r.moved}`);
}
{
  // A build that renders the dnd-kit zone id as a DOM attribute must be
  // excluded too, and the recent-sessions zone must NOT be.
  const p = makePage();
  const a = p.list([p.row('a1'), p.row('a2', 'running'), p.row('a3'), p.row('a4')],
    [], { 'data-sidebar-drop-id': 'pinned-drop-zone' });
  const b = p.list([p.row('b1'), p.row('b2', 'running'), p.row('b3'), p.row('b4')],
    [], { 'data-sidebar-drop-id': 'recent-sessions' });
  p.dom.root.appendChild(a);
  p.dom.root.appendChild(b);
  const aInserts = p.countInserts(a);
  const r = p.api.applyReorder();
  check('D1.3 data-sidebar-drop-id=pinned-drop-zone 的列表被排除', aInserts() === 0,
    `inserts=${aInserts()} pinnedSkipped=${r.pinnedSkipped}`);
  check('D1.3 recent-sessions 列表不在排除范围内（仍会被搬）',
    JSON.stringify(labels(b)) === JSON.stringify(['b2', 'b1', 'b3', 'b4']), labels(b).join(','));
}
{
  // pinned-drop-zone is a JS-only id in this build, and pinnedZoneOf has to
  // find the pinned list through the section wrapper several levels up.
  const p = makePage();
  const sec = p.dom.el('div', { 'data-pinned-section': 'true' });
  const mid = p.dom.el('div', { class: 'relative min-h-[4px] space-y-px' });
  const pinned = p.list([p.row('q1'), p.row('q2', 'running'), p.row('q3'), p.row('q4')]);
  mid.appendChild(pinned);
  sec.appendChild(mid);
  p.dom.root.appendChild(sec);
  const n = p.countInserts(pinned);
  p.api.applyReorder();
  check('D1.4 隔着两层祖先也能认出置顶容器', n() === 0, `inserts=${n()}`);
}
{
  // The other half of the same rule: a depth ceiling must not turn ordinary
  // deeply nested sub-lists into pinned ones. The guard that treats
  // depth-exhaustion as "assume pinned" sits INSIDE the loop, so a variant
  // that bounds the loop itself (the pre-2026-10-03 shape) skips the guard and
  // falls through to "not pinned" -- which for a real section 15 levels up is
  // the one answer that must never come out: it reorders the pinned zone.
  // D1.5 covers the plain side, D1.6 the pinned side; d4 fails D1.6.
  const p = makePage();
  const plainList = p.list([p.row('n1'), p.row('n2'), p.row('n3', 'running'), p.row('n4')]);
  let deep = plainList;
  for (let i = 0; i < 15; i++) deep = p.dom.el('div', { class: 'px-1' }, [deep]);
  p.dom.root.appendChild(deep);
  const r = p.api.applyReorder();
  check('D1.5 15 层深的普通子列表仍被识别为普通列表（没有被误判成置顶）',
    r.pinnedSkipped === 0 && r.roots === 1, `pinnedSkipped=${r.pinnedSkipped} roots=${r.roots}`);
  check('D1.5 15 层深的普通子列表照旧被搬', labels(plainList)[0] === 'n3', labels(plainList).join(','));
}
{
  // A REAL section 15 levels up must still be recognised as pinned, and its
  // 15-deep neighbour with no section above it must still be hoisted. The
  // pinnedSkipped count is exact, so "both got skipped" cannot pass.
  const p = makePage();
  const pinnedList = p.list([p.row('p1'), p.row('p2', 'running'), p.row('p3'), p.row('p4')]);
  const plainList = p.list([p.row('t1'), p.row('t2'), p.row('t3', 'running'), p.row('t4')]);
  let pinCursor = pinnedList;
  for (let i = 0; i < 15; i++) pinCursor = p.dom.el('div', { class: 'px-1' }, [pinCursor]);
  let plainCursor = plainList;
  for (let i = 0; i < 15; i++) plainCursor = p.dom.el('div', { class: 'px-1' }, [plainCursor]);
  const sec = p.dom.el('div', { 'data-pinned-section': 'true' }, [pinCursor]);
  let cursor = sec;
  for (let i = 0; i < 15; i++) cursor = p.dom.el('div', { class: 'px-1' }, [cursor]);
  p.dom.root.appendChild(cursor);
  p.dom.root.appendChild(plainCursor);

  const pinInserts = p.countInserts(pinnedList);
  const before = labels(pinnedList);
  const r = p.api.applyReorder();
  check('D1.6 15 层之上的真置顶区被认出，且只有它被认出',
    r.pinnedSkipped === 1, `pinnedSkipped=${r.pinnedSkipped}`);
  check('D1.6 15 层之上的置顶列表一次 insertBefore 都没有', pinInserts() === 0, `inserts=${pinInserts()}`);
  check('D1.6 15 层之上的置顶列表顺序逐项未变',
    JSON.stringify(labels(pinnedList)) === JSON.stringify(before), labels(pinnedList).join(','));
  check('D1.6 同深度的普通列表仍被搬', labels(plainList)[0] === 't3', labels(plainList).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. D2 变更检测按真实顺序判定（无缓存键）===');
{
  const p = makePage();
  const rows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id, i) =>
    p.row(id, i === 3 ? 'running' : i === 5 ? 'waiting' : null));
  const list = p.list(rows);
  p.dom.root.appendChild(list);
  const inserts = p.countInserts(list);

  const first = p.api.applyReorder();
  check('D2.1 第一轮把 running 与 waiting 提到队首并保持各自相对序',
    JSON.stringify(labels(list)) === JSON.stringify(['r4', 'r6', 'r1', 'r2', 'r3', 'r5']),
    labels(list).join(','));
  const insertsAfterFirst = inserts();

  const second = p.api.applyReorder();
  check('D2.1 顺序已正确时第二轮零 insertBefore', inserts() === insertsAfterFirst,
    `inserts ${insertsAfterFirst} -> ${inserts()}`);
  check('D2.1 第二轮 moved=0 且报告 alreadyOk', second.moved === 0 && second.alreadyOk === 1,
    `moved=${second.moved} alreadyOk=${second.alreadyOk}`);
  check('D2.1 第一轮确实动过（否则上面的对比没有意义）', first.moved > 0, `moved=${first.moved}`);
}
{
  // The bug this replaces: after a host re-render put the list back, the cached
  // key still matched and the reset was never repaired.
  const p = makePage();
  const original = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
  const rows = original.map((id, i) => p.row(id, i === 4 ? 'running' : null));
  const list = p.list(rows);
  p.dom.root.appendChild(list);
  p.api.applyReorder();
  check('D2.2 前置条件：第一轮已把行搬走',
    labels(list)[0] === 'r5', labels(list).join(','));

  // The host re-renders the list into its own order again.
  const kids = list.children.slice();
  const byLabel = {};
  for (const k of kids) byLabel[labels(k)[0]] = k;
  for (const k of kids) list.removeChild(k);
  for (const id of original) list.appendChild(byLabel[id]);
  check('D2.2 前置条件：模拟复位后顺序确实被打回',
    JSON.stringify(labels(list)) === JSON.stringify(original), labels(list).join(','));

  const r = p.api.applyReorder();
  check('D2.2 复位后的下一轮会重新修正', labels(list)[0] === 'r5',
    `${labels(list).join(',')} (moved=${r.moved})`);
}
{
  // Same child index, different session: the old key could not see it.
  const p = makePage();
  const list = p.list([p.row('A'), p.row('B'), p.row('C'), p.row('D', 'running')]);
  p.dom.root.appendChild(list);
  p.api.applyReorder();
  check('D2.3 前置条件：D 已到首位', labels(list)[0] === 'D', labels(list).join(','));
  // C now sits at index 3 -- the same index D used to occupy when it was the
  // selected wrapper -- and the running dot moved from D to C. Nothing else
  // changed, so the old index-derived key sees the identical string "3".
  const rowsNow = list.children.map((c) => c.querySelector('[data-session-id]'));
  for (const row of rowsNow) {
    const dot = row.querySelector('[' + MARK + ']');
    if (dot) dot.remove();
  }
  rowsNow[3].appendChild(p.dom.el('span', { [MARK]: '1', 'data-mmx-bucket': 'running' }));
  check('D2.3 前置条件：running 换成了 C，且 C 仍在下标 3', labels(list)[3] === 'C',
    labels(list).join(','));
  p.api.applyReorder();
  check('D2.3 同下标不同会话仍会触发搬移', labels(list)[0] === 'C', labels(list).join(','));
}
{
  // Non-row children (a 'more' button, a collapse control) keep their relative
  // order and end up behind the hoisted rows -- unchanged behaviour. One
  // non-row child is the documented tolerance; two is not a list at all.
  const p = makePage();
  const b1 = p.dom.el('button', { type: 'button' }, ['更多']);
  const list = p.dom.el('div', { class: 'space-y-px' },
    [b1, p.wrap(p.row('x1', 'running')), p.wrap(p.row('x2', 'waiting')), p.wrap(p.row('x3'))]);
  p.dom.root.appendChild(list);
  p.api.applyReorder();
  check('D2.4 非行子节点被压到队尾且相对序不变',
    JSON.stringify(labels(list)) === JSON.stringify(['x1', 'x2', '#BUTTON', 'x3']),
    labels(list).join(','));
}
{
  // A root nested inside another root.
  //
  // A12 (2026-10-09) changed what the outer root is allowed to CLAIM. It used
  // to ask w.querySelector('[data-session-id]') and
  // w.querySelector('[data-mmx-dot][data-mmx-bucket="running"]'), both of which
  // answer from the whole SUBTREE. On this fixture that let the outer root reach
  // three levels down, into the inner LIST's own wrapper, and answer "this
  // wrapper is running" because a row belonging to a different list was running.
  // Worse, the answer CHANGED underneath it: only after the inner list had
  // hoisted its own i2 to its head did the outer start seeing the inner list as
  // a running wrapper. That cascade is what this test used to measure -- pass 1
  // moved two nodes, pass 2 moved one more, pass 3 merely confirmed -- and it is
  // exactly the 跨行认领 defect: the outer moved a child for a state that was
  // never its own, and only got it right by luck of the inner list's final order.
  //
  // The shipped query is now the direct-child form (':scope > ...'). The inner
  // list has no session row among its DIRECT children -- its children are
  // wrappers -- so the outer root no longer claims it at all and treats it the
  // way it already treated a 'more' button: a non-row child that keeps its
  // relative position. Each root then converges inside a SINGLE pass, because
  // nothing one root does can change what another root reads.
  //
  // What still matters, and what is asserted below: every intermediate state is
  // a correct partial hoist rather than a scramble (each root's ideal is derived
  // from its own live children and the move loop runs back-to-front), the
  // convergence is real rather than assumed, and nothing can lock a wrong state
  // in the way a cached key would.
  const p = makePage();
  const inner = p.list([p.row('i1'), p.row('i2', 'running'), p.row('i3'), p.row('i4')]);
  const outer = p.dom.el('div', { class: 'space-y-px' },
    [p.wrap(p.row('o1')), inner, p.wrap(p.row('o2')), p.wrap(p.row('o3', 'running'))]);
  p.dom.root.appendChild(outer);
  const outerLabels = () => outer.children.map((c) => (c === inner ? 'INNER' : labels(c)[0]));
  const passes = [];
  for (let i = 0; i < 4; i++) {
    const r = p.api.applyReorder();
    passes.push({ moved: r.moved, alreadyOk: r.alreadyOk });
    // Every intermediate state must be a permutation of the same four children
    // and must never put a non-running row ahead of every running one.
    check(`D2.5 第 ${i + 1} 轮后外层仍是同一组子节点`,
      outerLabels().sort().join(',') === 'INNER,o1,o2,o3', outerLabels().join(','));
  }
  // One moving pass (inner hoists i2, outer hoists o3), then both roots report
  // alreadyOk forever after: the outer never re-decides anything from the
  // inner's contents.
  check('D2.5 直接子认领后单趟收敛（第 2 轮起 moved=0、两个根都已就位）',
    JSON.stringify(passes) === JSON.stringify([
      { moved: 2, alreadyOk: 0 }, { moved: 0, alreadyOk: 2 }, { moved: 0, alreadyOk: 2 }, { moved: 0, alreadyOk: 2 },
    ]), JSON.stringify(passes));
  check('D2.5 收敛后内外层都正确，嵌套列表留在原位（不因内层在跑而被外层顶上去）',
    labels(inner)[0] === 'i2' && outerLabels().join(',') === 'o3,o1,INNER,o2',
    `outer=${outerLabels().join(',')} inner=${labels(inner).join(',')}`);
  check('D2.5 第 2 轮起 moved=0：已收敛，且不会再动',
    passes[1].moved === 0 && passes[2].moved === 0 && passes[3].moved === 0,
    JSON.stringify(passes.slice(1)));
  // The claim itself, not just its consequence: the nested list is NOT hoisted
  // by the outer root even once its own head row is running. Without this the
  // assertions above would still pass on a build that had quietly gone back to
  // claiming the inner list, just at a different tick count.
  {
    const q = makePage();
    const nested = q.list([q.row('n1'), q.row('n2', 'running'), q.row('n3'), q.row('n4')]);
    const host = q.dom.el('div', { class: 'space-y-px' },
      [q.wrap(q.row('h1')), nested, q.wrap(q.row('h2')), q.wrap(q.row('h3'))]);
    q.dom.root.appendChild(host);
    const r = q.api.applyReorder();
    const heads = host.children.map((c) => (c === nested ? 'INNER' : labels(c)[0])).join(',');
    check('D2.5b 外层根不认领嵌套列表的"跑"（它的直接子里没有会话行）：外层顺序原封不动',
      heads === 'h1,INNER,h2,h3', heads);
    // moved=1 是【内层列表自己】把 n2 提到自己的头上，不是外层搬了谁。只有
    // runningLists=1 才说得出这一点：两个根都规划过就应该是 2。
    check('D2.5b 那一次搬移来自内层列表自己，外层没有规划任何搬移',
      r.moved === 1 && r.runningLists === 1 && labels(nested)[0] === 'n2',
      `${JSON.stringify(r)} innerHead=${labels(nested)[0]}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. D3 移动预算原子化（超限整轮不动）===');
{
  const p = makePage();
  // 35 selected rows sitting behind 5 plain ones: hoisting them all needs 35
  // moves, which is over the ceiling of 32.
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(p.row('plain' + i));
  for (let i = 0; i < 35; i++) rows.push(p.row('hot' + i, i % 2 ? 'running' : 'waiting'));
  const list = p.list(rows);
  p.dom.root.appendChild(list);
  const before = labels(list);
  const inserts = p.countInserts(list);

  const r = p.api.applyReorder();
  check('D3.1 超预算时 aborted 如实上报', r.aborted === 'move-budget-exhausted', `aborted=${r.aborted}`);
  check('D3.1 超预算时 moved=0', r.moved === 0, `moved=${r.moved}`);
  check('D3.1 超预算时一个节点都没搬（不中途留下乱序）', inserts() === 0, `inserts=${inserts()}`);
  check('D3.1 超预算时顺序逐项未变', JSON.stringify(labels(list)) === JSON.stringify(before),
    labels(list).slice(0, 6).join(',') + '...');
  check('D3.1 planned 如实上报本轮所需搬移数', r.planned === 35, `planned=${r.planned}`);
  check('D3.1 超限轮不提交任何状态（下一轮还能重试）', p.api.applyReorder().aborted === 'move-budget-exhausted');
}
{
  // Just under the ceiling the pass must still happen, otherwise the ceiling
  // would be a silent off switch.
  const p = makePage();
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(p.row('plain' + i));
  for (let i = 0; i < 20; i++) rows.push(p.row('hot' + i, 'running'));
  const list = p.list(rows);
  p.dom.root.appendChild(list);
  const r = p.api.applyReorder();
  check('D3.2 未超预算的轮次照常完成', r.moved === 20 && !r.aborted, `moved=${r.moved} aborted=${r.aborted}`);
  check('D3.2 结果正确', labels(list)[0] === 'hot0' && labels(list)[19] === 'hot19',
    labels(list).slice(0, 3).join(','));
}
{
  // A second pass right after a successful one must be free.
  const p = makePage();
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(p.row('hot' + i, 'running'));
  const list = p.list(rows);
  p.dom.root.appendChild(list);
  p.api.applyReorder();
  const again = p.api.applyReorder();
  check('D3.3 预算用尽后仍不产生无净变化搬移', again.moved === 0 && again.alreadyOk === 1,
    `moved=${again.moved} alreadyOk=${again.alreadyOk}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. 既有护栏未被削弱 ===');
{
  const p = makePage();
  const list = p.list([p.row('z1'), p.row('z2', 'running'), p.row('z3'), p.row('z4')]);
  p.dom.root.appendChild(list);
  const off = new Function('document', 'cfg', 'MARK', BLOCK + '\nreturn applyReorder;')(p.dom.document, { reorder: false }, MARK);
  check('reorder=false 时整段跳过', off().skipped === 'disabled', JSON.stringify(off()));
  check('reorder=false 时不搬任何节点', labels(list)[0] === 'z1', labels(list).join(','));
}
{
  const p = makePage();
  for (let i = 0; i < 129; i++) {
    p.dom.root.appendChild(p.list([p.row('t' + i + 'a'), p.row('t' + i + 'b'), p.row('t' + i + 'c', 'running'), p.row('t' + i + 'd')]));
  }
  const r = p.api.applyReorder();
  check('容器数超上限时整轮不动并上报', r.aborted === 'too-many-roots' && r.moved === 0,
    `aborted=${r.aborted} roots=${r.roots}`);
}
{
  const p = makePage();
  const list = p.list([p.row('n1'), p.row('n2'), p.row('n3'), p.row('n4')]);
  p.dom.root.appendChild(list);
  const r = p.api.applyReorder();
  check('没有 running/waiting 时不产生计划', r.moved === 0 && r.runningLists === 0, JSON.stringify(r));
  check('没有 running/waiting 时 unchanged 为真（daemon 日志可读）', r.unchanged === true);
}

console.log(`\npass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log('test-reorder-pinned: ALL GREEN');
} else {
  console.log('test-reorder-pinned: FAILED');
}
process.exit(fail === 0 ? 0 : 1);
