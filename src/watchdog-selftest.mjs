// mmx-status :: watchdog-selftest.mjs
// Zero-dependency self test for watchdog.mjs. Touches nothing real:
//   - the DevToolsActivePort tests use a temp dir
//   - the process-scan test uses a fake CIM payload plus a live query
//   - the single-instance test uses a temp lock file
//   - the app is NEVER touched (no --fix-app, no process is ended)
//
//   node watchdog-selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseDevToolsActivePort,
  extractPortFromCommandLine,
  parseProcessList,
  isMainProcessCommandLine,
  pickMainProcess,
  classifyState,
  backoffDelayMs,
  userDataDirCandidates,
  discoverPortFromFile,
  listProcesses,
  acquireLock,
  releaseLock,
  readLock,
  isCdpOk,
} from './watchdog.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name + (detail ? ' :: ' + detail : ''));
  } else {
    fail++;
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-wd-selftest-'));
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && e.code === 'EPERM';
  }
}

function writePortFile(name, content) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'DevToolsActivePort');
  fs.writeFileSync(p, content);
  return { dir, file: p };
}

// ------------------------------------------------------------ 1
section('1. DevToolsActivePort 解析');
{
  const lf = '9331\n/devtools/browser/062166ac-9e96-4b70-9c2d-cba95dae3141\n';
  const r1 = parseDevToolsActivePort(lf);
  check('LF 两行 -> 9331', r1.ok && r1.port === 9331, JSON.stringify({ reason: r1.reason, port: r1.port }));
  check('LF 第二行保留', r1.secondLine === '/devtools/browser/062166ac-9e96-4b70-9c2d-cba95dae3141', r1.secondLine);

  const crlf = '9331\r\n/devtools/browser/062166ac-9e96-4b70-9c2d-cba95dae3141\r\n';
  const r2 = parseDevToolsActivePort(crlf);
  check('CRLF 两行 -> 9331（只取第一行并 trim \\r）', r2.ok && r2.port === 9331, 'crlf=' + r2.crlf);
  check('CRLF 时 first 不含 \\r', !/[\r\n]/.test(r2.first || ''), JSON.stringify(r2.first));
  check('CRLF 第二行被 trim', r2.secondLine === '/devtools/browser/062166ac-9e96-4b70-9c2d-cba95dae3141', r2.secondLine);

  const onlyLine = '9331';
  const r3 = parseDevToolsActivePort(onlyLine);
  check('只有一行、无换行 -> 仍然接受', r3.ok && r3.port === 9331, 'hadNewline=' + r3.hadNewline);

  const crOnly = '9331\r\n/devtools/browser/x';
  const r4 = parseDevToolsActivePort(crOnly);
  check('CRLF + 无结尾换行 -> 接受', r4.ok && r4.port === 9331, JSON.stringify(r4.first));

  const bom = '\uFEFF9331\n/devtools/browser/x';
  const r5 = parseDevToolsActivePort(bom);
  check('UTF-8 BOM -> 接受', r5.ok && r5.port === 9331, JSON.stringify(r5.first));

  const ws = '   \r\n  \r\n';
  const r6 = parseDevToolsActivePort(ws);
  check('全空白 -> EMPTY', !r6.ok && r6.reason === 'EMPTY', r6.reason);

  const empty = '';
  const r7 = parseDevToolsActivePort(empty);
  check('空文件 -> EMPTY', !r7.ok && r7.reason === 'EMPTY', r7.reason);

  const nullish = parseDevToolsActivePort(null);
  check('null（文件不存在）-> MISSING', !nullish.ok && nullish.reason === 'MISSING', nullish.reason);

  const missingDir = discoverPortFromFile({ dirs: [path.join(TMP, 'does-not-exist')] });
  check(
    '目录不存在 -> MISSING 且不崩',
    missingDir.port === null &&
      missingDir.report.length === 1 &&
      missingDir.report[0].reason === 'MISSING',
    JSON.stringify(missingDir.report.map((r) => r.reason))
  );

  const trailing = '9331extra\n/devtools/browser/x';
  const r8 = parseDevToolsActivePort(trailing);
  check('端口后带垃圾 -> NOT_A_NUMBER', !r8.ok && r8.reason === 'NOT_A_NUMBER', r8.reason + ' first=' + r8.first);

  const oor = '99999\n/devtools/browser/x';
  const r9 = parseDevToolsActivePort(oor);
  check('99999 越界 -> OUT_OF_RANGE', !r9.ok && r9.reason === 'OUT_OF_RANGE', r9.reason);

  const bin = '\u0000\u0001garbage';
  const r10 = parseDevToolsActivePort(bin);
  check('二进制垃圾 -> NOT_A_NUMBER', !r10.ok && r10.reason === 'NOT_A_NUMBER', r10.reason);
}

// ------------------------------------------------------------ 2
section('2. 判据自证：确定不该命中的反例（防止判据恒真）');
{
  // Without this, "port discovery succeeded" could be vacuously true.
  const garbage = writePortFile('garbage', 'this is not a port\n/devtools/browser/whatever\n');
  const res = discoverPortFromFile({ dirs: [garbage.dir] });
  check(
    '垃圾 DevToolsActivePort 必须判失败',
    res.port === null && res.source === null,
    'port=' + res.port + ' source=' + res.source + ' reason=' + res.report[0].reason
  );

  const negCmd = extractPortFromCommandLine('"C:\\MiniMax Code.exe" --enable-features=X');
  check('无 --remote-debugging-port 的命令行 -> null', negCmd === null, String(negCmd));

  const negCmd2 = extractPortFromCommandLine('"MiniMax Code.exe" --remote-debugging-port=');
  check('空端口值 -> null', negCmd2 === null, String(negCmd2));

  const negCmd3 = extractPortFromCommandLine('"MiniMax Code.exe" --remote-debugging-port=abc');
  check('非数字端口 -> null', negCmd3 === null, String(negCmd3));

  const negState = classifyState({ appUp: false, cdpOk: true });
  check('应用没跑就算 cdpOk 也不许是 CDP_OK', negState === 'APP_ABSENT', negState);

  const negState2 = classifyState({ appUp: true, cdpOk: true, port: null });
  check('appUp+cdpOk 但没有端口 -> 仍是 CDP_OK（cdpOk 蕴含端口）', negState2 === 'APP_UP_CDP_OK', negState2);

  const dead = await isCdpOk(1);
  check('不可用端口 1 -> cdpOk=false', dead === false, String(dead));
}

// ------------------------------------------------------------ 3
section('3. 端口发现路径 A：DevToolsActivePort 文件');
{
  const good = writePortFile('good', '9331\r\n/devtools/browser/062166ac-9e96-4b70-9c2d-cba95dae3141\r\n');
  const goodEmpty = writePortFile('good-empty', '');
  const res = discoverPortFromFile({ dirs: [goodEmpty.dir, good.dir] });
  check('坏候选在前好候选在后 -> 采纳好的', res.port === 9331, 'source=' + res.source);
  check('source 标记为 DevToolsActivePort', res.source === 'DevToolsActivePort', res.source);
  check('报告覆盖所有候选', res.report.length === 2, JSON.stringify(res.report.map((r) => r.reason)));
  check(
    '坏候选原因被记录（可写进日志）',
    res.report[0].reason === 'EMPTY' && res.report[1].reason === 'OK',
    JSON.stringify(res.report.map((r) => r.reason))
  );

  const single = writePortFile('single', '9412');
  const res2 = discoverPortFromFile({ dirs: [single.dir] });
  check('单行无换行文件 -> 采纳', res2.port === 9412, String(res2.port));

  const cand = userDataDirCandidates(null, {
    APPDATA: 'C:\\Users\\t\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local',
  });
  check(
    '候选目录含 %APPDATA%\\MiniMax 第一优先',
    cand[0] === 'C:\\Users\\t\\AppData\\Roaming\\MiniMax',
    cand.slice(0, 3).join(' | ')
  );
  check(
    '候选目录含 LOCALAPPDATA\\Programs 旁与 G:\\MiniMax',
    cand.includes('C:\\Users\\t\\AppData\\Local\\Programs\\MiniMax Code') &&
      cand.includes('G:\\MiniMax\\MiniMax Code'),
    cand.length + ' candidates'
  );

  const cands2 = userDataDirCandidates('D:\\custom\\udd', { APPDATA: 'C:\\R', LOCALAPPDATA: 'C:\\L' });
  check('显式 --user-data-dir 排第一', cands2[0] === 'D:\\custom\\udd', cands2[0]);
  check('候选目录去重', new Set(cands2).size === cands2.length, cands2.join(' | '));
}

// ------------------------------------------------------------ 4
section('4. 端口发现路径 B：进程命令行');
{
  // Fake CIM payload, exactly the shape ConvertTo-Json -Compress emits.
  const fakeJson = JSON.stringify([
    { ProcessId: 111, CommandLine: '"C:\\x\\MiniMax Code.exe" --type=renderer --remote-debugging-port=9999' },
    { ProcessId: 222, CommandLine: '"C:\\x\\MiniMax Code.exe" --remote-debugging-port=9331' },
  ]);
  const list = parseProcessList(fakeJson);
  check('解析 CIM JSON 数组', list.length === 2, list.length + ' procs');
  check('解析空输出 -> []', parseProcessList('').length === 0);
  check('解析 null -> []', parseProcessList(null).length === 0);
  check('解析损坏 JSON -> []', parseProcessList('{not json').length === 0);

  const main = pickMainProcess(list);
  check('主进程 = 不含 --type= 的那条', main && main.pid === 222, JSON.stringify(main));
  check('主进程命令行抽出 9331', extractPortFromCommandLine(main.commandLine) === 9331);
  check(
    '只有子进程时 pickMainProcess=null',
    pickMainProcess([{ ProcessId: 1, CommandLine: '"a.exe" --type=gpu-process' }]) === null
  );
  check('空命令行不算主进程', isMainProcessCommandLine('') === false);
  check('--TYPE= 大写也算子进程', isMainProcessCommandLine('"a.exe" --TYPE=renderer') === false);

  const single = parseProcessList('{"ProcessId":9,"CommandLine":"\\"a.exe\\" --remote-debugging-port=1234"}');
  check('单对象 JSON（非数组）也能解析', single.length === 1, single.length + '');

  // Live path: real pwsh query against a process that certainly exists.
  // Uses the current node process name so it never touches MiniMax Code.
  const live = await listProcesses('node.exe');
  check('实时 CIM 查询 node.exe 成功', live.length > 0, live.length + ' node procs');
  const real = pickMainProcess(live);
  check('实时结果可走主进程判定', real !== null || live.length === 0, real ? 'pid=' + real.pid : 'all children');
  const livePort = real ? extractPortFromCommandLine(real.commandLine) : null;
  check(
    '实时进程抽端口（多半为 null，这正是负例）',
    livePort === null || (livePort >= 1 && livePort <= 65535),
    'port=' + livePort
  );
}

// ------------------------------------------------------------ 5
section('5. 状态判定（表驱动）');
{
  const rows = [
    { in: { appUp: false, cdpOk: false }, want: 'APP_ABSENT' },
    { in: { appUp: false, cdpOk: true }, want: 'APP_ABSENT' },
    { in: { appUp: true, cdpOk: false }, want: 'APP_UP_NO_CDP' },
    { in: { appUp: true, cdpOk: true }, want: 'APP_UP_CDP_OK' },
    { in: { appUp: 0, cdpOk: 0 }, want: 'APP_ABSENT' },
    { in: { appUp: 'yes', cdpOk: 'yes' }, want: 'APP_UP_CDP_OK' },
    { in: { appUp: 1, cdpOk: 0 }, want: 'APP_UP_NO_CDP' },
    { in: {}, want: 'APP_ABSENT' },
    { in: null, want: 'APP_ABSENT' },
  ];
  for (const row of rows) {
    const got = classifyState(row.in);
    check(
      'classify ' + JSON.stringify(row.in) + ' -> ' + row.want,
      got === row.want,
      got
    );
  }
  const states = new Set(rows.map((r) => classifyState(r.in)));
  check('三种状态都出现过', states.size === 3, [...states].join(','));

  check('退避 1 次 = 2s', backoffDelayMs(1) === 2000, backoffDelayMs(1) + '');
  check('退避 3 次 = 8s', backoffDelayMs(3) === 8000, backoffDelayMs(3) + '');
  check('退避封顶 120s', backoffDelayMs(30) === 120000, backoffDelayMs(30) + '');
  check('退避 0 次按 1 次处理', backoffDelayMs(0) === 2000, backoffDelayMs(0) + '');
}

// ------------------------------------------------------------ 6
section('6. 单实例锁（真跑两个 watchdog 进程）');
{
  const lockPath = path.join(TMP, 'wd.lock');
  const logPath = path.join(TMP, 'wd.log');
  const script = fileURLToPath(new URL('./watchdog.mjs', import.meta.url));

  const runWatchdog = (args, ms) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { cwd: process.cwd() });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d.toString();
      });
      child.stderr.on('data', (d) => {
        out += d.toString();
      });
      const kill = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already dead */
        }
      }, ms);
      child.on('exit', (code) => {
        clearTimeout(kill);
        resolve({ code, out });
      });
    });

  // --no-heal guarantees the test never spawns a real daemon, and never
  // touches MiniMax Code (no --fix-app).
  const base = ['--no-heal', '--lock', lockPath, '--log', logPath, '--interval', '60000'];

  const first = runWatchdog(base, 4000);
  await new Promise((r) => setTimeout(r, 1500));
  const lockOwner = readLock(lockPath);
  check('第一个 watchdog 写入了锁', Boolean(lockOwner) && Number.isInteger(lockOwner.pid), JSON.stringify(lockOwner));
  check(
    '锁里的 pid 是一个活着的进程',
    Boolean(lockOwner) && isAlive(lockOwner.pid),
    'pid=' + (lockOwner && lockOwner.pid)
  );
  check('锁文件在进程存活期间存在', fs.existsSync(lockPath));

  const second = await runWatchdog([...base, '--once'], 6000);
  check('第二个 watchdog 退出码 0', second.code === 0, 'code=' + second.code);
  check(
    '第二个安静退出并说明原因',
    second.out.includes('检测到已运行的 watchdog') && !second.out.includes('获得单实例锁'),
    JSON.stringify(second.out.trim().slice(0, 160))
  );

  await first;

  // In-process lock API (same semantics the CLI uses).
  const lock2 = path.join(TMP, 'wd2.lock');
  const a = acquireLock(lock2);
  check('进程内 acquireLock 成功', a.acquired === true, JSON.stringify(a));
  const b = acquireLock(lock2);
  check('同一进程重复 acquireLock 被拒', b.acquired === false, JSON.stringify(b.holder || b.error));
  check('releaseLock 后可再获取', releaseLock(lock2) === true && acquireLock(lock2).acquired === true);
  releaseLock(lock2);

  const lock3 = path.join(TMP, 'wd3.lock');
  fs.writeFileSync(lock3, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  const stale = acquireLock(lock3);
  check('死 PID 的陈旧锁被接管', stale.acquired === true, JSON.stringify(stale));

  const lock4 = path.join(TMP, 'wd4.lock');
  fs.writeFileSync(lock4, 'not json at all');
  const corrupt = acquireLock(lock4);
  check('损坏的锁被接管', corrupt.acquired === true, JSON.stringify(corrupt));
  releaseLock(lock4);
  releaseLock(lock3);
}

// ------------------------------------------------------------ 7
section('7. 端到端只读探测（--once --no-heal，不动应用）');
{
  const lockPath = path.join(TMP, 'wd5.lock');
  const logPath = path.join(TMP, 'wd5.log');
  const script = fileURLToPath(new URL('./watchdog.mjs', import.meta.url));
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, '--once', '--no-heal', '--lock', lockPath, '--log', logPath],
      { cwd: process.cwd() }
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += 'ERR ' + d.toString();
    });
    child.on('exit', (code) => (code === 0 ? resolve({ stdout: out }) : reject(new Error('exit ' + code + '\n' + out))));
  });
  const validStates = ['APP_ABSENT', 'APP_UP_CDP_OK', 'APP_UP_NO_CDP'];
  const found = validStates.find((s) => stdout.includes(s));
  check('输出里出现一个合法状态', Boolean(found), found || JSON.stringify(stdout.slice(0, 300)));
  check('输出记录了端口发现来源', stdout.includes('端口发现'));
  check('APP_ABSENT 时明说不启动应用', !found || found !== 'APP_ABSENT' || stdout.includes('绝不自动启动应用'));
  check('APP_UP_NO_CDP 时不自动修（无 --fix-app）', !found || found !== 'APP_UP_NO_CDP' || stdout.includes('默认只记录'));
  check('日志文件已写', fs.existsSync(logPath), logPath);
  check('--once 退出后释放锁', !fs.existsSync(lockPath));
  console.log('  ---- 实测输出 ----');
  for (const line of stdout.trim().split(/\r?\n/)) console.log('  | ' + line);
}

// ------------------------------------------------------------ done
console.log('');
console.log('pass=' + pass + ' fail=' + fail);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('watchdog-selftest: ALL GREEN');
