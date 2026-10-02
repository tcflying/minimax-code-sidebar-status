// mmx-status :: watchdog.mjs
// Restart self-healing: keeps the CDP injection daemon alive whenever
// MiniMax Code happens to be running with a CDP port, and never touches the
// app unless --fix-app is passed explicitly.
//
//   node watchdog.mjs [--port <n>] [--interval 5000] [--fix-app] [--once]
//                    [--log <path>] [--lock <path>] [--user-data-dir <path>]
//                    [--app-process-name <name>] [--no-heal] [--stop-daemon-on-exit]
//                    [--no-reorder]
//
// Two independent port discovery paths, either one is enough:
//   A) <user-data-dir>\DevToolsActivePort written by Electron itself
//   B) process command line scan (CIM, main process only, no --type= child)
//
// Safety rules baked in:
//   - never starts MiniMax Code (APP_ABSENT => do nothing)
//   - never kills MiniMax Code unless --fix-app is given
//   - single instance via lock file + PID liveness probe
//
// Zero dependencies: node builtins only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG = path.join(HERE, 'logs', 'watchdog.log');
const DEFAULT_LOCK = path.join(HERE, 'logs', 'watchdog.lock');
const DEFAULT_DAEMON = path.join(HERE, 'daemon.mjs');
const DAEMON_PIDFILE = path.join(HERE, 'logs', 'watchdog-daemon.pid');
const DEFAULT_APP_PROCESS = 'MiniMax Code.exe';
const DEFAULT_INTERVAL = 5000;
const DAEMON_INTERVAL = 2500;
const CDP_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------- args

export function parseArgs(argv) {
  const out = {
    port: null,
    interval: DEFAULT_INTERVAL,
    fixApp: false,
    once: false,
    log: DEFAULT_LOG,
    lock: DEFAULT_LOCK,
    userDataDir: null,
    appProcessName: DEFAULT_APP_PROCESS,
    heal: true,
    stopDaemonOnExit: false,
    daemon: DEFAULT_DAEMON,
    // Escape hatch, forwarded to daemon.mjs as --no-reorder. The reordering
    // guard normally defaults ON (daemon.mjs reorder:true), but the reflow
    // loop incident in lib/page-script.mjs means a runaway re-layout can still
    // lock up the renderer. Without this passthrough the boot-time autostart
    // path (HKCU\...\Run\mmxStatusWatchdog) has no way to turn it off.
    reorder: true,
    // Auto-repair must not fire on the FIRST no-CDP observation: the app is
    // often still cold-starting, and killing a booting app to "repair" it turns
    // a 2-second wait into a kill/restart cycle. Require N consecutive misses.
    fixAppAfter: 6,
    // Never auto-repair an app that has been up for less than this. Same reason.
    minUptimeMs: 45000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--log') out.log = argv[++i];
    else if (a === '--lock') out.lock = argv[++i];
    else if (a === '--user-data-dir') out.userDataDir = argv[++i];
    else if (a === '--app-process-name') out.appProcessName = argv[++i];
    else if (a === '--daemon') out.daemon = argv[++i];
    else if (a === '--fix-app') out.fixApp = true;
    else if (a === '--fix-app-after') out.fixAppAfter = Number(argv[++i]);
    else if (a === '--min-uptime-ms') out.minUptimeMs = Number(argv[++i]);
    else if (a === '--once') out.once = true;
    else if (a === '--no-heal') out.heal = false;
    else if (a === '--no-reorder') out.reorder = false;
    else if (a === '--reorder') out.reorder = true;
    else if (a === '--stop-daemon-on-exit') out.stopDaemonOnExit = true;
  }
  if (!Number.isInteger(out.port) || out.port <= 0) out.port = null;
  if (!Number.isFinite(out.interval) || out.interval <= 0) out.interval = DEFAULT_INTERVAL;
  if (!Number.isFinite(out.fixAppAfter) || out.fixAppAfter < 1) out.fixAppAfter = 1;
  if (!Number.isFinite(out.minUptimeMs) || out.minUptimeMs < 0) out.minUptimeMs = 0;
  return out;
}

// ------------------------------------------------------- pure helpers

// DevToolsActivePort is two lines: the port, then /devtools/browser/<uuid>.
// On Windows the separator is very often CRLF, and a truncated file can hold
// only the first line with no trailing newline. Only the first line matters,
// and it must be trimmed of any trailing \r.
export function parseDevToolsActivePort(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, port: null, reason: 'MISSING' };
  }
  let text = String(raw);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
  if (text.trim() === '') {
    return { ok: false, port: null, reason: 'EMPTY' };
  }
  const nl = text.indexOf('\n');
  const hadNewline = nl >= 0;
  const firstRaw = hadNewline ? text.slice(0, nl) : text;
  const first = firstRaw.trim();
  const crlf = firstRaw.endsWith('\r');
  if (first === '') return { ok: false, port: null, reason: 'EMPTY', hadNewline, crlf };
  if (!/^[0-9]{1,5}$/.test(first)) {
    return { ok: false, port: null, reason: 'NOT_A_NUMBER', first, hadNewline, crlf };
  }
  const port = Number(first);
  if (port < 1 || port > 65535) {
    return { ok: false, port: null, reason: 'OUT_OF_RANGE', first, hadNewline, crlf };
  }
  const rest = hadNewline ? text.slice(nl + 1).trim() : '';
  return {
    ok: true,
    port,
    reason: 'OK',
    first,
    secondLine: rest,
    hadNewline,
    crlf,
  };
}

const CDP_PORT_RE = /--remote-debugging-port[= ](\d{1,5})/i;

// A command line is only usable if it really carries the CDP flag; anything
// else returns null (this is the negative control for the discovery test).
export function extractPortFromCommandLine(commandLine) {
  if (!commandLine) return null;
  const m = CDP_PORT_RE.exec(String(commandLine));
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export function parseProcessList(json) {
  if (json === null || json === undefined) return [];
  const text = String(json).trim();
  if (text === '') return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (Array.isArray(data)) return data.filter((p) => p && typeof p === 'object');
  if (data && typeof data === 'object') return [data];
  return [];
}

// Electron spawns many "MiniMax Code.exe --type=renderer/gpu/..." children.
// Only the main process owns the command line flags.
export function isMainProcessCommandLine(commandLine) {
  if (!commandLine) return false;
  return !/--type=/i.test(String(commandLine));
}

export function pickMainProcess(list) {
  const arr = Array.isArray(list) ? list : [];
  for (const p of arr) {
    if (p && isMainProcessCommandLine(p.CommandLine)) {
      return { pid: p.ProcessId, commandLine: String(p.CommandLine || '') };
    }
  }
  return null;
}

// The only state machine. Everything else is plumbing around this.
export function classifyState(input) {
  const appUp = Boolean(input && input.appUp);
  const cdpOk = Boolean(input && input.cdpOk);
  if (!appUp) return 'APP_ABSENT';
  if (cdpOk) return 'APP_UP_CDP_OK';
  return 'APP_UP_NO_CDP';
}

export function backoffDelayMs(failures) {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(120000, 2000 * Math.pow(2, n - 1));
}

export function userDataDirCandidates(explicit, env = process.env) {
  const out = [];
  const add = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  if (explicit) add(explicit);
  if (env.APPDATA) {
    add(path.join(env.APPDATA, 'MiniMax'));
    add(path.join(env.APPDATA, 'MiniMax Code'));
  }
  if (env.LOCALAPPDATA) {
    add(path.join(env.LOCALAPPDATA, 'MiniMax'));
    add(path.join(env.LOCALAPPDATA, 'Programs', 'MiniMax Code'));
    add(path.join(env.LOCALAPPDATA, 'Programs', 'MiniMax Inside Code'));
  }
  add('G:\\MiniMax\\MiniMax Code');
  return out;
}

// --------------------------------------------------------- discovery

function readPortFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = parseDevToolsActivePort(raw);
    return { ...parsed, filePath };
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return { ok: false, port: null, reason: 'MISSING', filePath };
    }
    return { ok: false, port: null, reason: 'UNREADABLE', filePath, error: e.message };
  }
}

// Path A. Returns the first usable DevToolsActivePort, plus the full
// per-candidate report so the caller can log why a candidate was rejected.
export function discoverPortFromFile(opts = {}) {
  const dirs = opts.dirs || userDataDirCandidates(opts.userDataDir);
  const report = [];
  for (const dir of dirs) {
    const filePath = path.join(dir, 'DevToolsActivePort');
    const res = readPortFile(filePath);
    report.push(res);
    if (res.ok) return { port: res.port, source: 'DevToolsActivePort', filePath, report };
  }
  return { port: null, source: null, report };
}

function psQuery(processName) {
  const safe = String(processName).replace(/'/g, "''");
  return (
    "Get-CimInstance Win32_Process -Filter \"Name='" + safe + "'\" " +
    '| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  );
}

// Inherit the current environment as-is (ProcessStartInfo default). Rebuilding
// Machine/User variables by hand once made cmd unable to find chcp and
// reproduced a fake outage, so nothing here touches env.
export async function listProcesses(processName, execImpl = execFileAsync) {
  const script = psQuery(processName);
  const { stdout } = await execImpl('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000,
  });
  return parseProcessList(stdout);
}

// Path B.
export async function discoverPortFromProcess(opts = {}) {
  const name = opts.appProcessName || DEFAULT_APP_PROCESS;
  const execImpl = opts.execImpl || execFileAsync;
  let list;
  try {
    list = await listProcesses(name, execImpl);
  } catch (e) {
    return { port: null, source: null, error: e.message, list: [] };
  }
  const main = pickMainProcess(list);
  if (!main) return { port: null, source: null, mainPid: null, list };
  const port = extractPortFromCommandLine(main.commandLine);
  return {
    port,
    source: port ? 'process-command-line' : null,
    mainPid: main.pid,
    commandLine: main.commandLine,
    list,
  };
}

export async function isCdpOk(port, timeoutMs = CDP_TIMEOUT_MS) {
  if (!port) return false;
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body && body.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ probe

export async function probeOnce(args) {
  const appName = args.appProcessName;
  let appUp = false;
  let appPid = null;
  let cmdRes = { port: null, source: null, list: [] };
  try {
    cmdRes = await discoverPortFromProcess({ appProcessName: appName });
    appUp = Array.isArray(cmdRes.list) && cmdRes.list.length > 0;
    appPid = cmdRes.mainPid || null;
  } catch (e) {
    appUp = false;
  }

  const fileRes = discoverPortFromFile({ userDataDir: args.userDataDir });

  let port = null;
  let source = null;
  let filePortDead = false;
  if (args.port) {
    port = args.port;
    source = 'cli';
  } else if (fileRes.port) {
    // The file is written by Electron at startup, so a port sitting in it is
    // only a claim, not a fact: if the instance that wrote it has since died,
    // the file keeps naming a port nobody listens on. Latching onto it forever
    // is what produced the 500+ consecutive reconnect failures against 9331 on
    // 2026-10-02 while the live instance was on 9333 the whole time. So the
    // file port now has to answer before it wins, exactly as the launcher's
    // Resolve-TargetPort already did.
    if (await isCdpOk(fileRes.port)) {
      port = fileRes.port;
      source = 'DevToolsActivePort';
    } else {
      filePortDead = true;
    }
  }
  if (port === null && cmdRes.port) {
    port = cmdRes.port;
    source = 'process-command-line';
  }
  // Last resort: the file port is dead AND the command line gave us nothing.
  // Report it anyway so the APP_UP_NO_CDP branch can name a concrete port for
  // --fix-app. Same value the pre-fallback code would have used.
  if (port === null && fileRes.port) {
    port = fileRes.port;
    source = 'DevToolsActivePort';
  }

  const cdpOk = await isCdpOk(port);
  const state = classifyState({ appUp: appUp || Boolean(port), cdpOk });

  return {
    state,
    appUp,
    appPid,
    port,
    source,
    cdpOk,
    filePortDead,
    fileReport: fileRes.report,
    filePort: fileRes.port,
    cmdPort: cmdRes.port || null,
    cmdLine: cmdRes.commandLine || null,
    cmdError: cmdRes.error || null,
  };
}

// ------------------------------------------------------------ daemon

export async function findDaemonPids(port, execImpl = execFileAsync) {
  let list;
  try {
    list = await listProcesses('node.exe', execImpl);
  } catch {
    return [];
  }
  const out = [];
  for (const p of list) {
    const cmd = String((p && p.CommandLine) || '');
    if (!/daemon\.mjs/i.test(cmd)) continue;
    if (process.pid && p.ProcessId === process.pid) continue;
    if (port && !new RegExp('--port\\s+' + port + '(\\s|$)').test(cmd)) continue;
    out.push(p.ProcessId);
  }
  return out;
}

function writeDaemonPid(pid, port) {
  try {
    fs.mkdirSync(path.dirname(DAEMON_PIDFILE), { recursive: true });
    fs.writeFileSync(
      DAEMON_PIDFILE,
      JSON.stringify({ pid, port, at: new Date().toISOString(), by: process.pid }) + '\n',
      'utf8'
    );
  } catch {
    /* pid file is best effort only */
  }
}

export function removeDaemonPidFile() {
  try {
    fs.unlinkSync(DAEMON_PIDFILE);
  } catch {
    /* already gone */
  }
}

// Returns the spawned pid, or null when the spawn failed.
export function spawnDaemon(args, port) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(HERE, 'logs', 'watchdog-daemon-' + stamp + '.log');
  const errPath = path.join(HERE, 'logs', 'watchdog-daemon-' + stamp + '.err');
  // Default is to pass NO reorder flag at all, so daemon.mjs uses its own
  // default (reorder:true). Only an explicit --no-reorder appends the flag.
  // Ordering: this is the exact array that gets spawned, nothing re-derived.
  const daemonArgs = [args.daemon, '--port', String(port), '--interval', String(DAEMON_INTERVAL)];
  if (args.reorder === false) daemonArgs.push('--no-reorder');
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const out = fs.openSync(outPath, 'a');
    const err = fs.openSync(errPath, 'a');
    const child = spawn(process.execPath, daemonArgs, { detached: true, stdio: ['ignore', out, err] });
    child.unref();
    if (typeof child.pid === 'number') {
      writeDaemonPid(child.pid, port);
      return { pid: child.pid, outPath, errPath };
    }
    return { pid: null, outPath, errPath, error: 'spawn returned no pid' };
  } catch (e) {
    return { pid: null, error: e.message };
  }
}

// ------------------------------------------------------------- lock

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function readLock(lockPath) {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

// Atomic create; if a live owner holds it, return { acquired:false } and the
// caller exits quietly. A stale lock (dead PID) is taken over.
export function acquireLock(lockPath, selfPid = process.pid) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: selfPid, at: new Date().toISOString(), host: process.env.COMPUTERNAME || '' }) +
          '\n'
      );
      fs.closeSync(fd);
      return { acquired: true, lockPath };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { acquired: false, error: e.message, lockPath };
      const owner = readLock(lockPath);
      if (owner && pidAlive(owner.pid)) {
        return { acquired: false, holder: owner, lockPath };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* someone else won the race */
      }
    }
  }
  return { acquired: false, lockPath };
}

export function releaseLock(lockPath, selfPid = process.pid) {
  const owner = readLock(lockPath);
  if (owner && owner.pid !== selfPid) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- main

function makeLogger(args) {
  const stream = [];
  const write = (level, msg) => {
    const line =
      '[' + new Date().toISOString() + '] [' + level + '] [watchdog pid=' + process.pid + '] ' + msg;
    stream.push(line);
    console.log(line);
    try {
      fs.mkdirSync(path.dirname(args.log), { recursive: true });
      fs.appendFileSync(args.log, line + '\n', 'utf8');
    } catch {
      /* logging must never kill the watchdog */
    }
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

function describeFileReport(report) {
  if (!Array.isArray(report) || report.length === 0) return '（无候选目录）';
  return report
    .map((r) => path.basename(path.dirname(r.filePath)) + ':' + r.reason + (r.first ? '(' + r.first + ')' : ''))
    .join(' ');
}

async function runOnce(args, log, state) {
  const p = await probeOnce(args);
  state.last = p;
  const tag = p.state + ' appUp=' + p.appUp + ' pid=' + (p.appPid || '-');
  const portTag = 'port=' + (p.port || '-') + ' src=' + (p.source || '-') + ' cdpOk=' + p.cdpOk;
  log.info(tag + ' ' + portTag);
  log.info('  端口发现 文件路径=' + describeFileReport(p.fileReport) + ' 进程命令行=' + (p.cmdPort || 'none'));
  if (p.filePortDead) {
    // Say it out loud: the port in the file is a dead instance's leftover.
    // Which of the two follow-ups actually happened depends on what the
    // process command line had to offer, so the message must not claim a
    // fallback that did not happen. Logged on TRANSITION only: a stale file
    // stays stale for the app's whole lifetime, and this probe runs every
    // interval -- warning every round would write ~34k lines a day saying the
    // same thing.
    if (state.lastFilePortDead !== true) {
      if (p.source === 'process-command-line') {
        log.warn('  DevToolsActivePort 里的端口 ' + p.filePort + ' 不响应（陈旧文件），已改用进程命令行端口 ' + p.port + '。（后续轮次静默沿用，不再重复报）');
      } else {
        log.warn('  DevToolsActivePort 里的端口 ' + p.filePort + ' 不响应（陈旧文件），进程命令行也未给出端口；保留该端口仅用于诊断（APP_UP_NO_CDP）。（后续轮次静默沿用，不再重复报）');
      }
    }
  }
  state.lastFilePortDead = Boolean(p.filePortDead);

  if (p.state === 'APP_ABSENT') {
    state.consecutiveNoCdp = 0;
    log.info('  MiniMax Code 未运行：按设计不做任何动作（绝不自动启动应用）。');
    return p;
  }

  if (p.state === 'APP_UP_NO_CDP') {
    state.consecutiveNoCdp = (state.consecutiveNoCdp || 0) + 1;
    const hint = p.port
      ? 'CDP 端口 ' + p.port + ' 已发现（' + p.source + '）但不响应；可能端口被非 CDP 进程占用，或应用仍在冷启动。'
      : '未发现 CDP 端口：应用是以无参数方式启动的（图标/开始菜单/官方自启），注入器接不上。';
    log.warn('  APP_UP_NO_CDP #' + state.consecutiveNoCdp + '：' + hint);
    if (!args.fixApp) {
      log.warn('    默认只记录，不动应用。需要自动修复请显式加 --fix-app。');
      return p;
    }

    // Gate 1: wait out a cold start. A booting app answers nothing yet; killing
    // it here would restart the boot loop forever.
    if (state.consecutiveNoCdp < args.fixAppAfter) {
      const left = args.fixAppAfter - state.consecutiveNoCdp;
      log.warn(
        '    --fix-app 宽限：还需连续 ' + left + ' 次未恢复（约 ' +
          Math.round((left * args.interval) / 1000) + 's）才动手，避免误杀冷启动中的应用。'
      );
      return p;
    }

    // Gate 2: an app that just started is still booting, not broken.
    const uptimeMs = await appUptimeMs(args);
    if (uptimeMs !== null && uptimeMs < args.minUptimeMs) {
      log.warn(
        '    --fix-app 跳过：应用才启动 ' + Math.round(uptimeMs / 1000) + 's，' +
          '低于 ' + Math.round(args.minUptimeMs / 1000) + 's 启动宽限，按冷启动处理。'
      );
      return p;
    }

    // Gate 3: back off between real repair attempts, so a repair that fails to
    // take cannot turn into a kill/restart loop.
    const now = Date.now();
    if (state.nextFixAt && now < state.nextFixAt) {
      log.warn(
        '    --fix-app 退避中：' + Math.round((state.nextFixAt - now) / 1000) + 's 后再试。'
      );
      return p;
    }

    log.warn(
      '    --fix-app 触发：即将结束 PID ' + (p.appPid || '?') + ' 并带 CDP 参数重启' +
        '（当前会话会被中断）。'
    );
    state.fixAttempts = (state.fixAttempts || 0) + 1;
    state.nextFixAt = now + backoffDelayMs(state.fixAttempts);
    await fixApp(args, log, p);
    return p;
  }

  // APP_UP_CDP_OK
  state.consecutiveNoCdp = 0;
  if (!args.heal) {
    log.info('  --no-heal：跳过 daemon 拉起。');
    return p;
  }
  const pids = await findDaemonPids(p.port);
  if (pids.length > 1) {
    // More than one daemon on the same port means earlier repairs or manual
    // launches left strays. Keep exactly one so the pile cannot grow again.
    log.warn('  发现 ' + pids.length + ' 个 daemon，只保留 ' + pids[0] + '，其余为冗余。');
    for (const extra of pids.slice(1)) {
      try {
        process.kill(extra);
      } catch (e) {
        log.warn('    结束冗余 daemon pid=' + extra + ' 失败: ' + e.message);
      }
    }
    state.daemonPids = [pids[0]];
    return p;
  }
  if (pids.length > 0) {
    if (state.failures > 0) {
      log.info('  daemon 已在运行 pid=' + pids.join(',') + '，失败计数清零。');
      state.failures = 0;
    }
    state.daemonPids = pids;
    return p;
  }
  const now = Date.now();
  if (state.nextAttemptAt && now < state.nextAttemptAt) {
    log.info('  daemon 未运行，退避中：' + Math.round((state.nextAttemptAt - now) / 1000) + 's 后重试。');
    return p;
  }
  const res = spawnDaemon(args, p.port);
  if (res.pid) {
    log.info('  已拉起 daemon pid=' + res.pid + ' 端口=' + p.port + ' 日志=' + res.outPath);
    state.failures = 0;
    state.nextAttemptAt = 0;
    state.daemonPids = [res.pid];
  } else {
    state.failures = (state.failures || 0) + 1;
    state.nextAttemptAt = now + backoffDelayMs(state.failures);
    log.error('  拉起 daemon 失败 #' + state.failures + '：' + (res.error || 'unknown') + '，退避 ' + state.nextAttemptAt + 'ms。');
  }
  return p;
}

// How long the MAIN app process has been up, or null when it cannot be read.
// Only the main process owns the command line flags, so a booting app is
// identified by the main process age, not by the CDP port alone.
// MUST be awaited: process enumeration is async, and a Promise compared against
// a number silently evaluates to false, which would make the uptime gate dead.
export async function appUptimeMs(args = {}, execImpl = execFileAsync) {
  let list;
  try {
    list = await listProcesses(args.appProcessName, execImpl);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const mains = list.filter((x) => isMainProcessCommandLine(x && x.CommandLine));
  if (mains.length === 0) return null;
  let oldest = Infinity;
  for (const m of mains) {
    const started = processStartMs(m);
    if (started !== null && started < oldest) oldest = started;
  }
  if (oldest === Infinity) return null;
  return Math.max(0, Date.now() - oldest);
}

function processStartMs(p) {
  const raw = p && (p.CreationDate || p.StartTime || p.CreationTime);
  if (!raw) return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

// Kill daemons that are still connected to a port the app no longer serves.
// They cannot recover on their own (their CDP socket is dead) and they accumulate
// one per repair cycle, so a repair must clear them first or the pile returns.
export async function reapStaleDaemons(port, log) {
  let pids = [];
  try {
    pids = await findDaemonPids(port);
  } catch {
    return 0;
  }
  if (pids.length === 0) return 0;
  log.warn('  清理僵尸 daemon ' + pids.length + ' 个（它们连的端口已无响应）: ' + pids.join(','));
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch (e) {
      log.warn('    结束 daemon pid=' + pid + ' 失败: ' + e.message);
    }
  }
  return pids.length;
}

async function fixApp(args, log, p) {
  const appName = args.appProcessName;
  let list = [];
  try {
    list = await listProcesses(appName);
  } catch (e) {
    log.error('  修复失败：无法枚举进程 ' + appName + '：' + e.message);
    return;
  }
  const mains = list.filter((x) => isMainProcessCommandLine(x.CommandLine));
  if (mains.length === 0) {
    log.warn('  修复跳过：没有找到主进程。');
    return;
  }
  const port = p.port || p.cmdPort || 9331;
  // Reap first: a repair that leaves the old daemons behind re-creates the pile
  // it was supposed to clear, one per attempt.
  const reaped = await reapStaleDaemons(port, log);
  if (reaped > 0) log.warn('  已清理 ' + reaped + ' 个僵尸 daemon。');
  for (const m of mains) {
    log.warn('  结束 ' + appName + ' pid=' + m.ProcessId);
    try {
      process.kill(m.ProcessId);
    } catch (e) {
      log.error('  结束失败 pid=' + m.ProcessId + '：' + e.message);
    }
  }
  for (let i = 0; i < 60; i++) {
    let alive = false;
    for (const m of mains) {
      if (pidAlive(m.ProcessId)) alive = true;
    }
    if (!alive) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const exe = findAppExecutable(args);
  if (!exe) {
    log.error('  修复中止：找不到 MiniMax Code.exe，请设置 MINIMAX_CODE_EXECUTABLE。');
    return;
  }
  log.warn('  重启 ' + exe + ' --remote-debugging-port=' + port);
  try {
    const child = spawn(
      exe,
      ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
  } catch (e) {
    log.error('  重启失败：' + e.message);
  }
}

export function findAppExecutable(args = {}) {
  const cands = [];
  if (process.env.MINIMAX_CODE_EXECUTABLE) cands.push(process.env.MINIMAX_CODE_EXECUTABLE);
  cands.push('G:\\MiniMax\\MiniMax Code\\MiniMax Code.exe');
  if (process.env.LOCALAPPDATA) {
    cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'MiniMax Code', 'MiniMax Code.exe'));
    cands.push(
      path.join(process.env.LOCALAPPDATA, 'Programs', 'MiniMax Inside Code', 'MiniMax Inside Code.exe')
    );
  }
  cands.push('C:\\Program Files\\MiniMax Code\\MiniMax Code.exe');
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const log = makeLogger(args);

  const lock = acquireLock(args.lock);
  if (!lock.acquired) {
    const holder = lock.holder ? 'pid=' + lock.holder.pid : '（锁损坏或被占用）';
    log.info('检测到已运行的 watchdog ' + holder + '，本实例安静退出。');
    return 0;
  }
  log.info('获得单实例锁 ' + args.lock);

  const state = { failures: 0, nextAttemptAt: 0, consecutiveNoCdp: 0, fixAttempts: 0, nextFixAt: 0 };
  let stopped = false;

  const stop = async (sig) => {
    if (stopped) return;
    stopped = true;
    log.info('收到 ' + sig + '，退出。');
    clearInterval(timer);
    releaseLock(args.lock);
    if (args.stopDaemonOnExit) {
      for (const pid of state.daemonPids || []) {
        try {
          process.kill(pid);
          log.info('  已结束 daemon pid=' + pid);
        } catch (e) {
          log.error('  结束 daemon 失败 pid=' + pid + '：' + e.message);
        }
      }
      removeDaemonPidFile();
    } else {
      log.info('  daemon（若在运行）保持存活，pid 记录在 logs/watchdog-daemon.pid；Ctrl+C 不会结束它（daemon 退出会移除注入节点）。');
    }
    process.exit(0);
  };

  if (args.once) {
    await runOnce(args, log, state);
    releaseLock(args.lock);
    return 0;
  }

  const timer = setInterval(() => {
    runOnce(args, log, state).catch((e) => {
      log.error('tick 异常：' + (e && e.message ? e.message : String(e)));
    });
  }, args.interval);

  process.on('SIGINT', () => {
    stop('SIGINT');
  });
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('uncaughtException', (e) => log.error('uncaughtException：' + e.message));
  process.on('unhandledRejection', (e) =>
    log.error('unhandledRejection：' + (e && e.message ? e.message : String(e)))
  );

  log.info('看门狗启动：interval=' + args.interval + 'ms fixApp=' + args.fixApp + ' heal=' + args.heal);
  await runOnce(args, log, state);
  return new Promise(() => {});
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => {
      if (typeof code === 'number' && code !== 0) process.exit(code);
    },
    (e) => {
      console.error('[watchdog] 致命错误：', e && e.message ? e.message : e);
      process.exit(1);
    }
  );
}
