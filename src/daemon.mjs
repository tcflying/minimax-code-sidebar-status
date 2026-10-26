// mmx-status :: daemon.mjs
// Watches MiniMax Code over CDP and paints a status dot on every sidebar
// session row. Read-only against the app: no app.asar change, no IPC, and the
// injected nodes are fully removable with a single call.
//
//   node daemon.mjs [--port 9331] [--db <path>] [--interval 2500] [--once] [--no-reorder]
//
// Ctrl+C removes every injected node before exiting.

import { CdpSession, isCdpAvailable, version, listTargets } from './lib/cdp.mjs';
import { StatusDb, DEFAULT_DB } from './lib/status-db.mjs';
import { createNewMainSessionDetector } from './lib/new-main-sessions.mjs';
import { pathToFileURL } from 'node:url';
import {
  buildBootstrapExpression,
  buildRefreshExpression,
  buildDisposeExpression,
  buildProbeExpression,
} from './lib/page-script.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tunables. These are deliberately NOT new command line flags: the CLI surface
// is frozen (the user depends on every existing name and its semantics), so the
// retry policy stays internal.
// ---------------------------------------------------------------------------
const FAILURE_THRESHOLD = 3; // consecutive refresh failures before reconnecting
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Give-up ceiling. A daemon whose target port has NO listener behind it (the
// app was closed, or restarted on a different port) can never succeed, yet the
// old loop retried forever: the 2026-10-02 incident left one spinning at
// 30s backoff for 500+ consecutive failures over hours. 240 attempts at the
// 30s ceiling is two hours of patience -- enough to ride out an app restart,
// short enough to not survive as a zombie. Nothing else reaps a daemon whose
// port went away: Stop-StaleDaemon only kills daemons on the port a NEW
// launcher run targets, so a daemon on a DIFFERENT dead port is on its own.
const RECONNECT_MAX_ATTEMPTS = 240;
const REBOOT_BASE_MS = 1500; // renderer reload -> not-installed -> re-bootstrap
const REBOOT_MAX_MS = 30000;

const ARCHON_URL_RE = /^app:\/\/\.\/archon(?:[/#?]|$)/i;

// Exported (not just module-private) so test-reorder-defaults.mjs can assert the
// flag semantics without starting a daemon or touching a live CDP endpoint.
export function parseArgs(argv) {
  const out = {
    // 默认端口与生产端口一致（9331）。旧默认 9351 与
    // launch-mmx-status.ps1:281 的兜底 9331 不一致：裸跑 daemon 会去连
    // 一个根本没在监听的端口，症状表现为「改了代码没反应」。
    port: 9331,
    db: DEFAULT_DB,
    interval: 2500,
    once: false,
    offsetX: 4,
    showDone: false,
    showAborted: false,
    collapse: true,
    // Running rows hoist to the top of their list BY DEFAULT. This is the
    // feature the user asked for; hiding it behind an opt-in flag meant the
    // launcher (which passes no reorder flag at all) always ran with it off,
    // so "running rows are not hoisted" was reported as a bug on 2026-10-02.
    // --no-reorder stays as the escape hatch for the reflow-loop incident
    // documented in lib/page-script.mjs.
    reorder: true,
    activeBg: null,
    activeBgHover: null,
    activeBar: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--offsetX') out.offsetX = Number(argv[++i]);
    else if (a === '--once') out.once = true;
    else if (a === '--show-done') out.showDone = true;
    else if (a === '--show-aborted') out.showAborted = true;
    else if (a === '--no-collapse') out.collapse = false;
    else if (a === '--no-reorder') out.reorder = false;
    else if (a === '--reorder') out.reorder = true;
    else if (a === '--active-bg') out.activeBg = argv[++i];
    else if (a === '--active-bg-hover') out.activeBgHover = argv[++i];
    else if (a === '--active-bar') out.activeBar = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = (...m) => console.log(`[mmx-status ${new Date().toISOString().slice(11, 19)}]`, ...m);

/**
 * Re-open a CDP session on the app://./archon renderer.
 *
 * A hot reload / app update swaps webSocketDebuggerUrl, so the old session is
 * permanently dead and every request on it fails. The target list is the only
 * authority on where the renderer lives now.
 */
export async function reconnectSession(port, { log: logFn = () => {}, list = listTargets } = {}) {
  const targets = await list(port);
  const page = targets.find((t) => t.type === 'page' && ARCHON_URL_RE.test(t.url || ''));
  if (!page) {
    throw new Error(
      '重连失败：/json/list 里没有 app://./archon 页面 target，实际=' +
        (targets.length ? targets.map((t) => `[${t.type}] ${t.url}`).join(' ') : '(空)')
    );
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  await session.send('Runtime.enable').catch(() => {});
  return { session, target: page };
}

/**
 * Last line of defence against a process-killing async failure.
 *
 * Decision: log, count, and KEEP RUNNING - never exit here.
 *
 * Reason: this daemon's only job is painting dots on someone else's sidebar.
 * Every internal promise now carries an unconditional handler, so a hit on
 * these hooks is by definition an unknown/unexpected failure, not a known
 * recoverable state. Exiting would remove the dots from a perfectly healthy app
 * and, because the renderer keeps running after a reload, would leave the user
 * with a silent zombie daemon (the exact failure reported on 2026-09-29).
 * Staying alive degrades to "dots temporarily stop updating", which is
 * recoverable; exiting does not. The window in which the user can see the
 * failure is worth more than a clean exit.
 */
export function installFatalGuards({ log: logFn = () => {}, onFatal = () => {} } = {}) {
  const counters = { unhandledRejection: 0, uncaughtException: 0 };
  const describe = (r) =>
    r instanceof Error ? `${r.message}` : typeof r === 'string' ? r : safeJson(r);
  process.on('unhandledRejection', (reason) => {
    counters.unhandledRejection++;
    logFn('未处理的 Promise 拒绝（已兜底，进程继续运行）:', describe(reason));
    try {
      onFatal('unhandledRejection', reason);
    } catch (e) {
      logFn('兜底处理自身失败:', describe(e));
    }
  });
  process.on('uncaughtException', (err) => {
    counters.uncaughtException++;
    logFn('未捕获异常（已兜底，进程继续运行）:', describe(err));
    try {
      onFatal('uncaughtException', err);
    } catch (e) {
      logFn('兜底处理自身失败:', describe(e));
    }
  });
  return counters;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// New-main-session delivery feed.
//
// lib/new-main-sessions.mjs judges "this row is a brand new local visible main
// conversation". This is the DELIVERY half of that: it keeps the confirmed
// ids in a bounded pending list, re-validates them against every successful
// metadata read, and hands the page one small fixed-shape payload.
//
// The ORDERING state comes from the arguments alone: the rows, the observed
// time and the fixed boundary. The DIAGNOSTICS are not pure -- they read the
// clock (rate limiting) and write the log. The clock is never an input to an
// ordering decision.
// ---------------------------------------------------------------------------

// Upper bound of the pending list. Same number as the detector's ledger limit.
// Pending ids are never evicted FIFO: when the list is full a NEW event is
// dropped (fail closed) instead of pushing an older, still undelivered event
// out of the list.
const NEW_MAIN_MAX_PENDING = 256;

/**
 * A metadata row is trustworthy only when every column the delivery predicate
 * needs is present and usable. A NULL kind / visibility / archived /
 * createdAtMs is not "the row says no" -- it is "the row cannot be read".
 */
function isTrustedMetadataRow(row) {
  return (
    !!row &&
    typeof row.id === 'string' &&
    row.id !== '' &&
    Number.isSafeInteger(row.createdAtMs) &&
    (row.parentSessionId === null || typeof row.parentSessionId === 'string') &&
    typeof row.sessionKind === 'string' &&
    row.sessionKind !== '' &&
    typeof row.visibility === 'string' &&
    row.visibility !== '' &&
    typeof row.archived === 'number' &&
    Number.isFinite(row.archived)
  );
}

/**
 * Two rows with the same id are the SAME row when every metadata column
 * agrees. parent null and parent '' mean the same thing to the detector (both
 * are "no parent"), so they are not a contradiction either.
 */
function sameMetadata(a, b) {
  if (!a || !b) return false;
  if (a.createdAtMs !== b.createdAtMs) return false;
  if ((a.parentSessionId || '') !== (b.parentSessionId || '')) return false;
  if (a.sessionKind !== b.sessionKind) return false;
  if (a.visibility !== b.visibility) return false;
  if (a.archived !== b.archived) return false;
  return true;
}

/**
 * One pass over the rows of a read: the FIRST row per id (duplicate rows with
 * the same metadata are the same row) and the ids whose rows contradict
 * themselves.
 *
 * A contradiction is scoped to that ONE id. It must not decide anything about
 * the other rows of the same read: one unreadable row says nothing about the
 * new conversation next to it.
 */
function indexMetadataRows(rows) {
  const unique = new Map();
  const conflicts = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    const prev = unique.get(row.id);
    if (prev === undefined) {
      unique.set(row.id, row);
      continue;
    }
    if (!sameMetadata(prev, row)) conflicts.add(row.id);
  }
  return { unique, conflicts };
}

/**
 * createNewMainFeed({ startedAtMs, maxTracked, candidateTtlMs, log })
 *
 * startedAtMs is the run boundary. It is fixed here, taken once with
 * Date.now() before the first database read, and it never advances: it is NOT
 * derived from the rows (a MAX(created_at_ms) would inherit whatever the
 * database already had) and it does NOT move when candidates are delivered.
 *
 * The payload is fixed-shape on purpose:
 *
 *     { startedAtMs, sequence, available, observedAtMs, candidates: [{ id, createdAtMs }] }
 *
 * sequence advances only on a SUCCESSFUL observation, so two payloads built
 * from the same observation carry the same sequence, and a response never
 * creates or advances one. available=false means "this payload carries no
 * fresh observation" -- then candidates is always empty, and an old metadata
 * read is never passed off as a fresh one.
 *
 * observedAtMs is the moment of the last SUCCESSFUL read. It is what lets the
 * page bound its own 3s apply timer: the page keeps a packet it can no longer
 * trust, so it needs the age of the newest good packet. On available=false it
 * is NOT advanced -- an unreadable database must not look like a fresh read.
 */
export function createNewMainFeed({
  startedAtMs,
  maxTracked = NEW_MAIN_MAX_PENDING,
  candidateTtlMs,
  log: logFn = () => {},
} = {}) {
  if (!Number.isSafeInteger(startedAtMs)) {
    throw new TypeError('startedAtMs must be a safe integer');
  }
  const detector = createNewMainSessionDetector({ startedAtMs, maxTracked, candidateTtlMs });
  /** id -> { id, createdAtMs }. Confirmed, not yet acknowledged by the page. */
  const pending = new Map();
  let sequence = 0;
  /** The moment of the last SUCCESSFUL observation. 0 = never had one. */
  let lastObservedAtMs = 0;
  let lastPayload = {
    startedAtMs,
    sequence: 0,
    available: false,
    observedAtMs: 0,
    candidates: [],
  };
  let diagCount = 0;
  let lastDiagAt = 0;

  /**
   * Bounded, rate-limited diagnostics: the first few, then at most 1/min.
   *
   * The logger is called inside its own try/catch: a broken log function must
   * never turn a metadata problem into a failed delivery (or into a failed
   * refresh).
   */
  function diag(reason) {
    diagCount++;
    const now = Date.now();
    if (diagCount <= 3 || now - lastDiagAt >= 60000) {
      lastDiagAt = now;
      try {
        logFn('新会话通道诊断:', reason);
      } catch {
        /* a bad logger is not a delivery failure */
      }
    }
  }

  function copyPayload(p) {
    return {
      startedAtMs: p.startedAtMs,
      sequence: p.sequence,
      available: p.available,
      observedAtMs: p.observedAtMs,
      candidates: p.candidates.map((c) => ({ id: c.id, createdAtMs: c.createdAtMs })),
    };
  }

  /**
   * The payload for "no fresh observation". The last successful read time is
   * KEPT, not refreshed: the page needs the age of the newest good packet, and
   * a failed read must never look like a new one.
   */
  function unavailablePayload() {
    return {
      startedAtMs,
      sequence,
      available: false,
      observedAtMs: lastObservedAtMs,
      candidates: [],
    };
  }

  /** Ascending creation time; same millisecond falls back to the id. */
  function sortedCandidates() {
    return [...pending.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => ({ id: c.id, createdAtMs: c.createdAtMs }));
  }

  /**
   * Re-check every pending id against the rows of a SUCCESSFUL metadata read.
   *
   * Every outcome is scoped to ONE id. A single bad row must not decide
   * anything about the new conversations next to it, and it must not stop the
   * channel: the next clean read carries on.
   *
   *  - the row is gone -> withdraw. The sessions query filters archived = 0, so
   *    an archived session simply stops appearing: it must NOT be re-pinned
   *    after it was archived.
   *  - the row says it no longer qualifies (parent / kind / visibility /
   *    archived / out of the creation window) -> withdraw.
   *  - the row contradicts itself (same id, different metadata) -> withdraw
   *    that id. The detector tombstones it too, so it is never reported again.
   *  - the row cannot be read (NULL fields) or its creation time changed ->
   *    withdraw that id as well; the detector confirmed it only once, so it is
   *    not re-sent either.
   */
  function revalidate(unique, conflicts, observedAtMs) {
    for (const p of [...pending.values()]) {
      if (conflicts.has(p.id)) {
        pending.delete(p.id);
        continue;
      }
      const row = unique.get(p.id);
      if (!row) {
        pending.delete(p.id);
        continue;
      }
      if (!isTrustedMetadataRow(row)) {
        pending.delete(p.id);
        continue;
      }
      if (row.createdAtMs !== p.createdAtMs) {
        pending.delete(p.id);
        continue;
      }
      if (row.createdAtMs < startedAtMs || row.createdAtMs > observedAtMs) {
        pending.delete(p.id);
        continue;
      }
      if (row.parentSessionId !== null && row.parentSessionId !== '') {
        pending.delete(p.id);
        continue;
      }
      if (row.sessionKind !== 'conversation') {
        pending.delete(p.id);
        continue;
      }
      if (row.visibility !== 'visible') {
        pending.delete(p.id);
        continue;
      }
      if (row.archived !== 0) {
        pending.delete(p.id);
      }
    }
  }

  /**
   * Feed one SUCCESSFUL metadata read into the feed.
   *
   * Never throws: a broken read only makes the new channel unavailable for
   * THIS round, and the next clean read brings it back. The caller must not
   * call this at all when the database read failed -- an unobserved read must
   * not look like progress.
   */
  function observeMetadata(rows, { observedAtMs } = {}) {
    if (!Array.isArray(rows)) return unavailable('metadata-not-an-array');
    if (!Number.isSafeInteger(observedAtMs)) return unavailable('bad-observed-at');
    const { unique, conflicts } = indexMetadataRows(rows);
    let result;
    try {
      result = detector.observe(rows, { observedAtMs });
    } catch (e) {
      // The whole read is unusable (a missing column, a clock that went
      // backwards): this round is unavailable, the next clean read recovers.
      diag('本轮新通道不可用: ' + (e && e.message ? e.message : String(e)));
      lastPayload = unavailablePayload();
      return copyPayload(lastPayload);
    }
    // The ledger is bounded and fails closed: past the limit a new candidate
    // is DROPPED, not queued. That has to be visible, not silent.
    if (result.overflow && result.overflow.droppedNow > 0) {
      diag(
        '新会话额度耗尽，丢弃候选 ' + result.overflow.droppedNow + ' 个（上限 ' + result.overflow.limit + '）'
      );
    }
    for (const c of result.confirmedCandidates) {
      if (pending.size >= maxTracked) {
        diag('pending 已满，丢弃新事件: ' + c.id);
        continue;
      }
      if (!pending.has(c.id)) pending.set(c.id, { id: c.id, createdAtMs: c.createdAtMs });
    }
    revalidate(unique, conflicts, observedAtMs);
    sequence += 1;
    lastObservedAtMs = observedAtMs;
    lastPayload = {
      startedAtMs,
      sequence,
      available: true,
      observedAtMs: lastObservedAtMs,
      candidates: sortedCandidates(),
    };
    return copyPayload(lastPayload);
  }

  /**
   * Mark the new channel unavailable for now (the metadata read itself
   * failed). The pending list is KEPT: the next successful read re-sends it.
   */
  function unavailable(reason) {
    diag('本轮新通道不可用: ' + reason);
    lastPayload = unavailablePayload();
    return copyPayload(lastPayload);
  }

  /** A copy of the payload built from the last successful observation. */
  function payload() {
    return copyPayload(lastPayload);
  }

  /**
   * Drop acknowledged ids from the pending list. Only ids that are still
   * pending are dropped -- an unknown id changes nothing.
   */
  function acknowledge(ids) {
    if (!Array.isArray(ids)) return 0;
    let dropped = 0;
    for (const id of ids) {
      if (typeof id === 'string' && pending.delete(id)) dropped++;
    }
    return dropped;
  }

  /** Read-only diagnostics. The detector's own counters ride along. */
  function snapshot() {
    return {
      startedAtMs,
      sequence,
      available: lastPayload.available,
      observedAtMs: lastPayload.observedAtMs,
      pending: sortedCandidates(),
      detector: detector.snapshot(),
    };
  }

  return { startedAtMs, observeMetadata, unavailable, payload, acknowledge, snapshot };
}

/**
 * Read the metadata channel and feed it. Never throws: a metadata failure
 * only makes the NEW channel unavailable, the colour path goes on.
 */
function observeNewMain(feed, db, observedAtMs = Date.now()) {
  if (!feed) return undefined;
  try {
    const rows = typeof db.sessionMetadata === 'function' ? db.sessionMetadata() : null;
    if (!Array.isArray(rows)) return feed.unavailable('metadata-unavailable');
    return feed.observeMetadata(rows, { observedAtMs });
  } catch (e) {
    return feed.unavailable('metadata-read-failed:' + (e && e.message ? e.message : String(e)));
  }
}

/** The ids a request actually carried. */
function sentNewMainIds(payload) {
  if (!payload || !Array.isArray(payload.candidates)) return [];
  return payload.candidates.map((c) => c.id);
}

/**
 * Apply a page receipt.
 *
 * Only ids that THIS request really carried and that are still pending are
 * removed. A receipt from another run, an unknown id, or a late answer to an
 * older request removes nothing -- and a promise that resolved, or an ok:true
 * answer, is NOT a receipt: the page has to say which ids it applied.
 */
function applyNewMainReceipt(feed, receipt, sentIds) {
  if (!feed || !receipt || typeof receipt !== 'object') return;
  if (receipt.startedAtMs !== feed.startedAtMs) return;
  const ack = Array.isArray(receipt.acknowledged) ? receipt.acknowledged : [];
  const sent = new Set(sentIds);
  feed.acknowledge(ack.filter((id) => sent.has(id)));
}

/**
 * The tick loop, extracted so it can be exercised by selftest.mjs with a fake
 * session (a real one needs a live renderer).
 *
 * Two failure classes are handled separately and must not be confused:
 *
 *  1. TRANSPORT is dead (Runtime.evaluate timed out, WebSocket closed).
 *     -> reconnectSession(): re-list targets, rebuild CdpSession.
 *  2. TRANSPORT is fine but the injection is gone, i.e. the renderer document
 *     was replaced (hot reload / navigation) and window.__mmxStatus plus
 *     #mmx-status-style died with the old document. refresh() then answers
 *     {ok:false, reason:'not-installed'} forever.
 *     -> re-bootstrap with the startup options.
 *
 * Both are backed off, because bootstrap is far heavier than refresh: the page
 * side busy-waits up to 15s for document.body, so hammering it every tick
 * would freeze the host application.
 */
export function createRefreshLoop({
  getSession,
  setSession,
  db,
  bootstrapConfig,
  // The new-main-session feed is OPTIONAL: an old offline fake db without a
  // metadata channel keeps working exactly as before, with no payload at all.
  feed = null,
  log: logFn = () => {},
  intervalMs = 2500,
  failureThreshold = FAILURE_THRESHOLD,
  reconnectBaseMs = RECONNECT_BASE_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  reconnectMaxAttempts = RECONNECT_MAX_ATTEMPTS,
  // Invoked (with the final log line) when consecutive failed reconnects hit
  // reconnectMaxAttempts. Default exits the process; selftest injects a spy so
  // the ceiling itself stays testable without taking the test runner down.
  onGiveUp = null,
  rebootBaseMs = REBOOT_BASE_MS,
  rebootMaxMs = REBOOT_MAX_MS,
  reconnect = () => Promise.reject(new Error('createRefreshLoop 未注入 reconnect')),
  logEvery = 10,
  // Tests drive tick() by hand; the daemon relies on the real interval.
  autoStart = true,
} = {}) {
  const state = {
    ticks: 0,
    consecutiveFailures: 0, // transport failures
    notInstalled: 0, // consecutive refreshes that reported not-installed
    reconnectAttempts: 0,
    reconnectFails: 0, // consecutive FAILED reconnects; reset on any success
    reconnects: 0, // successful reconnects
    reboots: 0, // successful re-bootstraps
    reconnecting: false,
    rebooting: false,
    reconnectBackoffMs: reconnectBaseMs,
    rebootBackoffMs: rebootBaseMs,
    lastError: null,
    stopped: false,
  };
  let timer = null;
  /**
   * tickNo -> the ids that request really carried. A receipt may only
   * acknowledge the ids of ITS OWN request, so this has to be kept per
   * request. Bounded: the oldest entry is dropped once the map is full, and a
   * receipt that arrives more than a hundred ticks late simply acks nothing.
   */
  const sentByTick = new Map();

  /** Reinstall the payload after the renderer document was replaced. */
  async function runReboot() {
    try {
      while (!state.stopped && state.notInstalled > 0) {
        const waitMs = state.rebootBackoffMs;
        logFn(`注入已丢失（not-installed），${waitMs}ms 后重新注入 ...`);
        await sleep(waitMs);
        if (state.stopped) return;
        try {
          db.refresh();
          const session = getSession();
          const newMain = observeNewMain(feed, db);
          const boot = await session.evaluateWithRetry(
            // sentAt: A13 的起点。这一次【重新注入】本身就是最新的一次服务器刷新，
            // 所以时间戳取现在，而不是复用最初那次注入的时间。
            buildBootstrapExpression({
              status: db.snapshot(),
              sentAt: Date.now(),
              ...bootstrapConfig,
              // 重新注入也是一次投递：页面被换掉了，之前没送达的新会话要再送一遍。
              newMainSessions: newMain,
            })
          );
          if (!boot || boot.ok === true) {
            state.reboots++;
            state.notInstalled = 0;
            state.rebootBackoffMs = rebootBaseMs;
            logFn('重新注入成功:', safeJson(boot && boot.initial));
            applyNewMainReceipt(
              feed,
              boot && boot.initial && boot.initial.newMainSessions,
              sentNewMainIds(newMain)
            );
            return;
          }
          // e.g. {ok:false, reason:'no-document-body'}: keep backing off.
          logFn('重新注入未成功:', safeJson(boot), '（继续退避重试）');
          state.rebootBackoffMs = Math.min(state.rebootBackoffMs * 2, rebootMaxMs);
        } catch (e) {
          logFn('重新注入抛错:', e && e.message, '（继续退避重试）');
          state.rebootBackoffMs = Math.min(state.rebootBackoffMs * 2, rebootMaxMs);
        }
      }
    } finally {
      state.rebooting = false;
    }
  }

  function scheduleReboot() {
    if (state.rebooting || state.stopped) return;
    state.rebooting = true;
    // This chain must not be bare either: the catch only logs.
    void runReboot().catch((e) => {
      state.rebooting = false;
      logFn('重新注入流程异常:', e && e.message);
    });
  }

  /** Rebuild the CDP session when the transport itself is dead. */
  async function runReconnect() {
    try {
      while (!state.stopped && state.consecutiveFailures >= failureThreshold) {
        const waitMs = state.reconnectBackoffMs;
        logFn(
          `连续刷新失败 ${state.consecutiveFailures} 次，${waitMs}ms 后重连 ` +
            `127.0.0.1:${args.port} ...`
        );
        await sleep(waitMs);
        if (state.stopped) return;
        state.reconnectAttempts++;
        try {
          const old = getSession();
          const next = await reconnect();
          if (old && typeof old.close === 'function') {
            try {
              old.close();
            } catch {
              /* old socket already gone */
            }
          }
          setSession(next.session);
          state.reconnects++;
          state.reconnectBackoffMs = reconnectBaseMs;
          state.consecutiveFailures = 0;
          state.reconnectFails = 0;
          logFn('重连成功:', (next.target && next.target.url) || '(unknown target)');
          return;
        } catch (e) {
          state.reconnectFails++;
          if (state.reconnectFails >= reconnectMaxAttempts) {
            // Give up on a port that has had no listener for two hours of
            // backed-off attempts. Spinning forever here is how the 2026-10-02
            // zombie happened: nothing else reaps a daemon whose port went
            // away, so this exit is the daemon's own responsibility.
            const final =
              `连续 ${state.reconnectFails} 次重连 127.0.0.1:${args.port} 失败，` +
              `该端口已无实例监听，daemon 放弃并退出（避免僵尸空转）。` +
              `下次启动 MiniMax Code 时由 launch-mmx-status.ps1 拉起新 daemon。`;
            logFn(final);
            state.stopped = true;
            if (timer) clearInterval(timer);
            const giveUp =
              onGiveUp ||
              ((reason) => {
                console.error(reason);
                process.exit(1);
              });
            giveUp(final);
            return;
          }
          logFn(
            '重连失败:',
            e && e.message,
            `（下一轮退避 ${Math.min(state.reconnectBackoffMs * 2, reconnectMaxMs)}ms）`
          );
          state.reconnectBackoffMs = Math.min(state.reconnectBackoffMs * 2, reconnectMaxMs);
        }
      }
    } finally {
      state.reconnecting = false;
    }
  }

  function scheduleReconnect() {
    if (state.reconnecting || state.stopped) return;
    state.reconnecting = true;
    void runReconnect().catch((e) => {
      state.reconnecting = false;
      logFn('重连流程异常:', e && e.message);
    });
  }

  function noteFailure(kind, e) {
    state.lastError = (e && e.message) || String(e);
    state.consecutiveFailures++;
    // Rate-limit the log: one line per failure would drown the log file during
    // a long outage.
    if (state.consecutiveFailures === 1 || state.consecutiveFailures % 10 === 0) {
      logFn(`${kind}: ${state.lastError}（连续 ${state.consecutiveFailures} 次）`);
    }
    if (state.consecutiveFailures >= failureThreshold) scheduleReconnect();
  }

  function onTickOk(res, tickNo) {
    // The ids THIS request carried. A receipt may only acknowledge those.
    const sentIds = sentByTick.get(tickNo) || [];
    sentByTick.delete(tickNo);
    // A not-installed answer PROVES the transport is alive (the request round
    // tripped and the page script replied), so the transport failure counter is
    // reset - this is class 2, not class 1.
    state.consecutiveFailures = 0;
    state.reconnectBackoffMs = reconnectBaseMs;
    if (res && res.ok === false && res.reason === 'not-installed') {
      state.notInstalled++;
      state.lastError = 'not-installed';
      logFn(
        `注入已消失（tick ${tickNo}，连续第 ${state.notInstalled} 次）：` +
          '渲染进程文档被替换，需要重新注入'
      );
      scheduleReboot();
      return;
    }
    // Only a real receipt removes anything. A resolved promise or an ok:true
    // answer is NOT an acknowledgement.
    applyNewMainReceipt(feed, res && res.stats && res.stats.newMainSessions, sentIds);
    // Report the tick that PRODUCED this answer, not the current counter: when
    // the renderer stalls, many requests settle in the same second and using the
    // live counter printed "tick 20" dozens of times.
    if (tickNo % logEvery === 0) logFn(`tick ${tickNo}:`, safeJson(res));
  }

  function onTickErr(e) {
    noteFailure('刷新失败', e);
  }

  function tick() {
    if (state.stopped) return;
    const tickNo = ++state.ticks;
    try {
      db.refresh();
    } catch (e) {
      // Synchronous failure (sqlite locked): same channel. Nothing is observed
      // here: a failed read must not look like progress.
      noteFailure('tick 异常', e);
      return;
    }
    // The new-session channel is fed ONLY from a successful read, and it never
    // blocks the colour path: a broken metadata read just makes this round's
    // new payload unavailable, the dots keep flowing.
    const newMain = observeNewMain(feed, db);
    let expression;
    try {
      expression = buildRefreshExpression(db.snapshot(), newMain);
    } catch (e) {
      // Synchronous failure (snapshot() threw): same channel.
      noteFailure('tick 异常', e);
      return;
    }
    const sentIds = sentNewMainIds(newMain);
    sentByTick.set(tickNo, sentIds);
    if (sentByTick.size > 128) sentByTick.delete(sentByTick.keys().next().value);
    let p;
    try {
      p = getSession().evaluateWithRetry(expression);
    } catch (e) {
      noteFailure('刷新调用同步抛出', e);
      return;
    }
    if (!p || typeof p.then !== 'function') {
      noteFailure('刷新返回值形状异常', new Error('evaluateWithRetry 没有返回 Promise'));
      return;
    }
    // Unconditional handler. try/catch cannot see an async rejection, and on
    // Node 24 an unhandled one throws and kills the process (the 2026-09-28
    // crash: `CDP 超时(30000ms): Runtime.evaluate` after 4590 ticks). There is
    // no branch here that can leave the promise bare.
    Promise.resolve(p)
      .then((res) => onTickOk(res, tickNo), onTickErr)
      .catch((e) => {
        logFn('刷新处理链异常:', e && e.message);
      });
  }

  function stop() {
    state.stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Deliberately NOT unref'd: the interval is what keeps the daemon alive, and
  // an unref'd timer would let the process exit silently when nothing else
  // happens to hold the loop open.
  if (autoStart) timer = setInterval(tick, intervalMs);
  return { state, tick, stop };
}

async function waitForCdp(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpAvailable(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForRenderer(port, timeoutMs = 90000) {
  // CDP answers /json/version as soon as the browser process is up, but the
  // app://./archon page target appears only once the renderer has actually
  // loaded. Failing at that moment is the single most common way this tool
  // breaks on a cold start, so wait for the target instead.
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = await listTargets(port);
      const page = lastTargets.find(
        (t) => t.type === 'page' && /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || '')
      );
      if (page) return page;
    } catch {
      /* browser not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(
    `${timeoutMs / 1000}s 内未出现 app://./archon 渲染进程。当前 target：\n` +
      (lastTargets.length
        ? lastTargets.map((t) => `  [${t.type}] ${t.url}`).join('\n')
        : '  （无）')
  );
  return null;
}

async function main() {
  log(`等待 CDP 127.0.0.1:${args.port} ...`);
  if (!(await waitForCdp(args.port))) {
    console.error(
      `CDP 端口 ${args.port} 无响应。请先用 start-mmx-status.ps1 带 CDP 参数启动 MiniMax Code。`
    );
    process.exit(2);
  }

  const v = await version(args.port).catch(() => ({}));
  log('CDP 已连接:', v.Browser || '(unknown)', '|', (v['User-Agent'] || '').slice(-60));

  // The run boundary for "a brand new conversation". Taken ONCE, with
  // Date.now(), BEFORE the first database read: it is not a MAX(created_at_ms)
  // (that would inherit whatever the database already had) and it never
  // advances afterwards. The whole feed (initial bootstrap, every tick, every
  // re-bootstrap) uses this one instance and this one boundary.
  const startedAtMs = Date.now();
  const feed = createNewMainFeed({ startedAtMs, log });

  const db = new StatusDb(args.db, { includeAborted: args.showAborted });
  // StatusDb's constructor already did one SUCCESSFUL read, so this is the
  // seeding read: it judges nothing and only establishes the baseline.
  observeNewMain(feed, db);
  log('数据库:', args.db);
  log('状态分布:', JSON.stringify(db.counts()));

  log('等待渲染进程 app://./archon 就绪...');
  const target = await waitForRenderer(args.port);
  if (!target) {
    db.close();
    process.exit(3);
  }
  let session = await CdpSession.connect(target.webSocketDebuggerUrl);
  await session.send('Runtime.enable').catch(() => {});
  log('渲染进程 target:', target.url, '|', target.title);

  // Probe the REAL DOM before painting anything.
  const probe = await session.evaluateWithRetry(buildProbeExpression());
  log(
    `真实 DOM 探针: url=${probe.url} 总会话行=${probe.totalRows} 置顶行=${probe.pinnedRows} 有置顶区=${probe.hasPinnedSection}`
  );
  if (probe.sample && probe.sample.length) {
    for (const s of probe.sample) {
      log(`   行样本 id=${s.id} tag=${s.tag} inPinned=${s.inPinned} text="${s.text}"`);
      log(`       class="${s.className}"`);
    }
  }

  // The exact startup options. Reused verbatim by the re-bootstrap path so a
  // reinjection after a renderer reload is indistinguishable from a cold start
  // (same dot offset, same done/aborted switches, same collapse behaviour, same
  // selected-row colours).
  const bootstrapConfig = {
    offsetX: args.offsetX,
    showDone: args.showDone,
    collapseOnStart: args.collapse,
    reorder: args.reorder,
    ...(args.activeBg ? { activeBg: args.activeBg } : {}),
    ...(args.activeBgHover ? { activeBgHover: args.activeBgHover } : {}),
    ...(args.activeBar ? { activeBar: args.activeBar } : {}),
  };
  // The initial bootstrap reuses the SEEDING packet. There is no new database
  // read between the seeding read and this bootstrap, so observing again here
  // would invent a successful read that never happened (and would push the
  // detector's second read forward for no reason).
  const newMain = feed.payload();
  const boot = await session.evaluateWithRetry(
    // sentAt: A13 的起点 —— 页面用它初始化 lastRefreshAt，之后每趟 refresh 由
    // buildRefreshExpression 把新的时间戳写进 api.__sentAt。
    buildBootstrapExpression({
      status: db.snapshot(),
      sentAt: Date.now(),
      ...bootstrapConfig,
      // The first delivery attempt: the page answers with a receipt in
      // initial.newMainSessions, and only the ids it really applied are
      // dropped from the pending list.
      newMainSessions: newMain,
    })
  );
  log('注入结果:', JSON.stringify(boot));
  if (boot && boot.ok === false) {
    console.error('[mmx-status] 注入失败:', boot.reason);
    session.close();
    db.close();
    process.exit(4);
  }
  applyNewMainReceipt(
    feed,
    boot && boot.initial && boot.initial.newMainSessions,
    sentNewMainIds(newMain)
  );
  if (args.activeBg) log('选中行底色:', args.activeBg); else log('选中行底色: rgba(10,10,10,0.10) + 蓝色左条（默认）');
  log('done 点显示:', args.showDone ? '开' : '关（默认，只有绿/黄/红）');
  log('启动时折叠展开组:', args.collapse ? '开（主上要求：任何时候不自动展开）' : '关');
  log('running 行置顶:', args.reorder ? '开（默认开启；已知副作用见 page-script 注释，--no-reorder 可关）' : '关（--no-reorder 显式关闭）');
  if (boot && boot.collapse) log('折叠结果:', JSON.stringify(boot.collapse));

  if (args.once) {
    const counts = db.counts();
    log(`一次性模式结束。running=${counts.running} waiting=${counts.waiting} paused=${counts.paused} error=${counts.error} done=${counts.done}`);
    await session.evaluate(buildDisposeExpression());
    session.close();
    db.close();
    return;
  }

  log(`守护中，每 ${args.interval}ms 刷新一次。Ctrl+C 还原。`);
  const getSession = () => session;
  const setSession = (s) => {
    session = s;
  };
  const loop = createRefreshLoop({
    getSession,
    setSession,
    db,
    bootstrapConfig,
    feed,
    log,
    intervalMs: args.interval,
    reconnect: () => reconnectSession(args.port, { log }),
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，正在移除注入的节点...`);
    loop.stop();
    try {
      const r = await session.evaluateWithRetry(buildDisposeExpression());
      log('已还原:', JSON.stringify(r));
    } catch (e) {
      log('还原失败（应用可能已关闭）:', e.message);
    }
    session.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return loop;
}

// Entry point. Guarded so selftest.mjs can import createRefreshLoop() and
// installFatalGuards() from this module without starting a daemon.
const invokedDirectly =
  !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  installFatalGuards({
    log,
    // Best effort only: never dispose here. Disposing needs the very session
    // that may be the thing that just failed, and pulling the dots out of a
    // healthy app is worse than stale dots. The tick loop's own reconnect path
    // already repairs a dead session.
    onFatal: () => {},
  });
  main().catch((e) => {
    console.error('[mmx-status] 致命错误:', e.message);
    process.exit(1);
  });
}
