// mmx-status :: lib/status-db.mjs
// Read-only accessor for MiniMax Code's local session database.
// Uses node:sqlite (Node >= 22.5) opened in read-only mode so the running
// desktop client is never blocked or mutated.

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const DEFAULT_DB = path.join(os.homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');

/**
 * Status vocabulary, mapped to the three colours the user asked for.
 *
 * There is no `paused` value in the schema, so the bucket is built from the
 * real vocabulary, cross-checked against the live database:
 *
 *   started      (4)      -> running   a turn is executing right now
 *   interrupted  (112)    -> paused    runtime restarted mid-turn, turn never finished
 *   aborted      (168)    -> (none)    the user cancelled it: a TERMINAL state, not paused
 *   error        (62)     -> error
 *   idle         (1179)   -> (none)    finished or never started
 *
 * `aborted` is deliberately NOT yellow by default: showing 168 cancelled
 * sessions as "paused" buries the 112 that genuinely need attention. Pass
 * includeAborted=true to light them up as well.
 */
export const BUCKET = {
  running: 'running', // started
  // The session itself is not executing a turn, but a sub agent it OWNS still
  // is. Measured on the live database (2026-10-02):
  //   - a running sub agent row has parent_session_id = <parent> AND
  //     status='started' AND archived=0; once it finishes it turns into
  //     idle / aborted / interrupted, so the predicate self-expires.
  //   - local_runtime_background_tasks holds owner_session_id + status +
  //     ended_at_ms, and kind is either 'bash' or 'subagent'. Every row with
  //     status='running' had ended_at_ms IS NULL, and every terminal row had
  //     it non-NULL, so the two conditions are equivalent and we keep both.
  //
  // The kind='subagent' filter is load-bearing, not an optimisation. Measured
  // on the live data: with the filter omitted, 3 of the 5 started sessions were
  // marked waiting when all they had was a background SHELL command running --
  // a 75% false-positive rate. bash outnumbers subagent 7631 to 377, so
  // "something of mine is running" is almost always a shell, not a sub agent.
  // The user asked for the sub agent case, not the "I left a build running"
  // case.
  //
  // Measured, and the reason this stays a plain ended_at_ms test with no TTL:
  // a running subagent row has NO heartbeat. 24 s of sampling left its
  // updated_at_ms byte-identical while bash rows kept advancing. So
  // updated_at_ms must never be used to expire a task, and a TTL here would
  // kill long but perfectly legitimate waits. An orphan row left by a crashed
  // host would show yellow forever; that is the safer failure direction.
  //
  // Deliberately NOT gated on the parent being 'started': the case the user
  // actually asked for is the turn having ENDED and the sub agent still going,
  // where the parent reads as 'idle' and the work is invisible.
  waiting: 'waiting',
  paused: 'paused', // interrupted
  error: 'error', // error | failed
  done: 'done', // idle + completed
  idle: 'idle', // everything else, no dot
};

const RUNNING = new Set(['started']);
const INTERRUPTED = new Set(['interrupted']);
const ABORTED = new Set(['aborted']);
const ERROR = new Set(['error', 'failed']);

export function bucketFor({ status, terminalOutcome, hasErrorMessage, includeAborted = false }) {
  if (ERROR.has(status) || terminalOutcome === 'failed') return BUCKET.error;
  if (RUNNING.has(status)) return BUCKET.running;
  if (INTERRUPTED.has(status)) return BUCKET.paused;
  if (ABORTED.has(status)) return includeAborted ? BUCKET.paused : BUCKET.idle;
  if (hasErrorMessage) return BUCKET.error;
  if (status === 'idle' && terminalOutcome === 'completed') return BUCKET.done;
  return BUCKET.idle;
}

export class StatusDb {
  constructor(dbPath = DEFAULT_DB, { includeAborted = false } = {}) {
    this.path = dbPath;
    this.includeAborted = includeAborted;
    if (!fs.existsSync(dbPath)) {
      throw new Error('找不到数据库: ' + dbPath);
    }
    // readOnly: true -> opens with SQLITE_OPEN_READONLY, safe while the app runs.
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this._stmtSessions = this.db.prepare(`
      SELECT s.session_id        AS id,
             s.status            AS status,
             s.title             AS title,
             s.error_message     AS err,
             a.terminal_outcome  AS outcome
        FROM local_runtime_sessions s
        LEFT JOIN local_runtime_session_agent_state a
               ON a.session_id = s.session_id
       WHERE s.archived = 0
    `);
    // ---- waiting overlay: two indexed, owner-scoped lookups -------------
    // refresh() runs every 2.5s against the user's LIVE database, so both
    // statements must be narrow. Measured on the real file: together they cost
    // 2.8 ms, and the relevant indexes already ship with the app --
    // idx_local_runtime_sessions_parent_recency_v3,
    // idx_local_runtime_background_tasks_owner_status_delivery. So we never
    // scan, and we never need to add an index to a database we open readOnly.
    this._stmtChildRunning = this.db.prepare(`
      SELECT DISTINCT parent_session_id AS p
        FROM local_runtime_sessions
       WHERE parent_session_id IS NOT NULL
         AND parent_session_id != ''
         AND status = 'started'
         AND archived = 0
    `);
    this._stmtBgRunning = this.db.prepare(`
      SELECT owner_session_id AS o, kind, COUNT(*) AS n
        FROM local_runtime_background_tasks
       WHERE status = 'running'
         AND ended_at_ms IS NULL
         AND kind = 'subagent'
       GROUP BY owner_session_id, kind
    `);
    this._map = new Map();
    /** id -> { subagent, bash } for every session that owns live work. */
    this.waitingDetail = new Map();
    this.refresh();
  }

  /**
   * Sessions that own something still running, keyed by id.
   *
   * The detail shape keeps a `bash` slot even though the SQL now filters to
   * kind='subagent' and therefore never fills it. Two reasons: the shape stays
   * stable for the UI and the tests, and if the user later decides a long
   * background shell SHOULD also count, it is a one-word change to the query
   * rather than a refactor of every consumer.
   *
   * Kept separate from bucketFor() on purpose: bucketFor is a pure function
   * over a single row (and is unit-tested as one), while this needs two extra
   * queries. The overlay is applied afterwards in refresh(), which is what
   * makes `waiting` win over `running`.
   */
  collectWaiting() {
    const detail = new Map();
    const bump = (id, kind) => {
      if (!id) return;
      let d = detail.get(id);
      if (!d) { d = { subagent: 0, bash: 0 }; detail.set(id, d); }
      if (kind === 'subagent') d.subagent += 1; else d.bash += 1;
    };
    for (const r of this._stmtChildRunning.all()) bump(r.p, 'subagent');
    for (const r of this._stmtBgRunning.all()) bump(r.o, r.kind);
    return detail;
  }

  /**
   * Pure predicate, exported for tests: given a waiting-detail record, is this
   * session considered to be waiting on something?
   *
   * The parent session's own status is intentionally NOT an input. A turn that
   * has already returned to idle while its sub agent keeps working is exactly
   * the situation this bucket exists to make visible.
   */
  static isWaiting(detail) {
    if (!detail) return false;
    return detail.subagent > 0 || detail.bash > 0;
  }

  /**
   * Overlay the waiting bucket onto an already-mapped session set. Pure and
   * exported so the rule can be tested without a database, without a live app,
   * and without depending on what happens to be running on the machine.
   *
   * `waiting` deliberately wins over `running`: a session that is dispatching a
   * sub agent is `started` AND owns live work, and "it is waiting on something"
   * is the more useful of the two facts to show.
   *
   * Note what is NOT a condition here: the session's own status. The case this
   * bucket exists for is a turn that has already returned to `idle` while its
   * sub agent keeps working, which is invisible without it.
   */
  static applyWaitingOverlay(map, detail) {
    for (const [id, d] of detail) {
      if (!StatusDb.isWaiting(d)) continue;
      const cur = map.get(id);
      // Unknown id = archived, or not in the unarchived set. Painting it would
      // be a phantom row that can never be acted on.
      if (!cur) continue;
      cur.bucket = BUCKET.waiting;
      cur.waiting = d;
    }
    return map;
  }

  refresh() {
    const next = new Map();
    for (const row of this._stmtSessions.all()) {
      const hasErrorMessage = !!(row.err && String(row.err).trim() && String(row.err) !== 'aborted');
      const bucket = bucketFor({
        status: row.status,
        terminalOutcome: row.outcome,
        hasErrorMessage,
        includeAborted: this.includeAborted,
      });
      next.set(row.id, {
        id: row.id,
        status: row.status,
        outcome: row.outcome,
        title: row.title,
        bucket,
      });
    }

    const detail = this.collectWaiting();
    this.waitingDetail = detail;
    StatusDb.applyWaitingOverlay(next, detail);

    this._map = next;
    return this._map;
  }

  /** Serialisable snapshot handed to the page. */
  snapshot() {
    const out = {};
    for (const [id, v] of this._map) {
      if (v.bucket !== BUCKET.idle) out[id] = v.bucket;
    }
    return out;
  }

  counts() {
    // Keys are derived from BUCKET, not hand-listed. A hard-coded literal was
    // how a newly added bucket used to produce `waiting: NaN` here and poison
    // daemon.mjs's startup/one-shot logs and the selftest's "buckets sum to
    // total" assertion. Deriving the shape makes the next bucket free.
    const c = {};
    for (const b of Object.values(BUCKET)) c[b] = 0;
    for (const v of this._map.values()) c[v.bucket] += 1;
    return c;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
