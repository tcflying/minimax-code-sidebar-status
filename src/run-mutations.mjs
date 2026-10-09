// mmx-status :: run-mutations.mjs
//
// Runs every behaviour suite once clean, then re-runs it once per registered
// mutation with MMX_MUTATE set, and prints the red/green table.
//
// Why this exists: "624 assertions green" is not evidence that the assertions
// can fail. Each mutation below is a deliberate re-introduction of a defect
// that this project actually had -- a pinned zone that is reordered, a cached
// key that hides a host re-render, a budget enforced mid-loop, an ancestor-only
// menu lookup, a fiber half that is no longer mounted, a memory path that
// disagrees with the restore. A mutation that stays GREEN means the suite
// would not have caught that bug coming back, so it is a hole in the tests and
// is reported as a failure of this script, not of the suite.
//
// A mutation that CRASHES is equally not a red. An uncaught TypeError aborts
// the run before most assertions execute, so it proves less than a clean FAIL
// and can hide the very behaviour the mutation was aimed at -- which is how a
// suite can look "red" while proving nothing. `red` below therefore requires a
// parsed pass/fail summary with fail > 0; a crash is printed as CRASH/BAD and
// counted as a problem.
//
//   node run-mutations.mjs                # everything
//   node run-mutations.mjs m7 s7          # only the suites owning these ids
//
// Exit code 0 only when every suite is green AND every mutation is red.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Mutations are declared next to the code they break, in the header comment of
// each suite and in its MMX_MUTATE chain. The ids are listed here because this
// script is the only place that asserts "every one of them is red".
const SUITES = [
  { file: 'test-reorder-pinned.mjs', label: '置顶区排序', muts: ['d1', 'd2', 'd3', 'd4'] },
  { file: 'test-topmost-menu.mjs', label: '到最顶菜单', muts: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25', 'm26', 'm27', 'm28', 'm29'] },
  { file: 'test-pinned-lifecycle.mjs', label: '置顶记忆与 dispose', muts: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12', 's13', 's14'] },
  { file: 'test-topmost-diag.mjs', label: '到最顶最小诊断', muts: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10'] },
  { file: 'test-top-lock.mjs', label: '红色悬停锁顶', muts: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12', 't13', 't14', 't15', 't16', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'x1', 'x2', 'x3', 'x4', 'x5'] },
];

const only = process.argv.slice(2);

function run(file, mut) {
  const env = { ...process.env };
  if (mut) env.MMX_MUTATE = mut; else delete env.MMX_MUTATE;
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/pass=(\d+)\s+fail=(\d+)/);
  const counts = m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
  const crashed = !counts;
  const firstFail = (out.match(/^ {2}FAIL {2}(.*)$/m) || [])[1] || '';
  const err = crashed ? (out.match(/^\w*Error:.*$/m) || [])[0] || out.trim().split('\n').slice(-1)[0] : '';
  return { counts, crashed, firstFail, err, code: r.status };
}

let problems = 0;
const rows = [];

for (const suite of SUITES) {
  if (only.length && !only.some((id) => suite.muts.includes(id))) continue;

  const base = run(suite.file, null);
  if (base.crashed || !base.counts || base.counts.fail !== 0) {
    problems++;
    rows.push([suite.file, '(baseline)', 'CRASHED/RED', base.err || 'baseline is not green', 'BAD']);
    console.error(`!! ${suite.file} baseline is not green: ${base.err}`);
    continue;
  }
  rows.push([suite.file, '(baseline)', `${base.counts.pass} pass`, 'clean', 'ok']);

  for (const mut of suite.muts) {
    const r = run(suite.file, mut);
    const red = !r.crashed && r.counts && r.counts.fail > 0;
    if (!red) problems++;
    const note = red
      ? `${r.counts.fail} fail: ${r.firstFail.slice(0, 58)}`
      : (r.crashed ? `CRASH: ${r.err}` : 'STAYED GREEN - the suite cannot see this bug');
    rows.push([suite.file, mut, r.crashed ? 'CRASH' : `${r.counts ? r.counts.fail + ' fail' : '?'}`,
      note, red ? 'red' : 'BAD']);
  }
}

const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length), 8));
const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
console.log('\n' + line(['suite', 'mut', 'result', 'first failing assertion', '']));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));

const total = rows.length;
const red = rows.filter((r) => r[4] === 'red').length;
const greenBase = rows.filter((r) => r[1] === '(baseline)').length;
console.log(`\n${greenBase} suites green, ${red}/${total - greenBase} mutations red, ${problems} problem(s)`);
if (problems) {
  console.log('A mutation that stayed green (or crashed instead of failing an assertion)');
  console.log('is a hole in the tests. Fix the test, not the mutation.');
}
process.exit(problems ? 1 : 0);
