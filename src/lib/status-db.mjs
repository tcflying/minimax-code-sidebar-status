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
  // Deliberately NOT gated on REQUIRING the parent to be 'started': the case the
  // user actually asked for is the turn having ENDED and the sub agent still
  // going, where the parent reads as 'idle' and the work is invisible. Two such
  // sessions were measured on the live data; requiring 'started' would drop
  // exactly the rows this bucket was added to expose.
  //
  // It IS gated on the parent NOT BEING 'started' -- see applyWaitingOverlay.
  // "Not required to be started" is not the same claim as "started is ignored",
  // and reading it as the latter is what made the root session paint yellow
  // while it was actively working.
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

/**
 * Precedence: the CURRENT status decides first; the leftover fields only fill
 * in after it has said nothing.
 *
 * This order is load-bearing and it was wrong once (README §15.16.3 /
 * 1003.md §14.30.3). It used to open with
 *     if (ERROR.has(status) || terminalOutcome === 'failed') return error;
 * which merged a LIVE status with a SUPPLEMENTARY field into ONE branch, and
 * that branch ran ahead of started / interrupted / aborted. The measured
 * consequence: a session reading status='started' right now, carrying a
 * terminal_outcome='failed' left over from its previous turn, painted RED;
 * interrupted went red instead of orange; aborted went red instead of showing
 * nothing at all. A user watching a green row flip to red had no way to tell
 * "this just failed" from "it failed last time and is working now" -- and the
 * second one is what was actually true.
 *
 * The current status is therefore read FIRST and in full:
 *
 *   1. error | failed              live failure; nothing overrides it
 *   2. started                     running
 *   3. interrupted                 paused
 *   4. aborted                     terminal cancel; includeAborted lights paused
 *   5. idle + completed            done  -- deliberately ABOVE the two leftover
 *                                           fields, so a leftover error_message
 *                                           on a finished session stops being red
 *   6. terminal_outcome='failed'   error (kept: idle + failed is still red)
 *   7. error_message               error (kept: a bare idle + error_message is
 *                                           still red)
 *   8. otherwise                   idle  (no dot)
 *
 * Steps 1-4 are mutually exclusive -- the four Sets do not overlap -- so their
 * relative order carries no behaviour. What carries behaviour is that all four
 * sit ABOVE 5-7. Steps 6 and 7 are preserved on purpose: they are the existing
 * base policy for a session whose own status says nothing, not a defect
 * (README §15.16.3 rows 7 and 8, locked by selftest).
 *
 * The waiting overlay is deliberately untouched. It keys off the CORRECT bucket
 * produced here, and keeps protecting running / paused / LIVE error -- which is
 * exactly what it should protect now that the buckets it sees are the right ones.
 */
export function bucketFor({ status, terminalOutcome, hasErrorMessage, includeAborted = false }) {
  if (ERROR.has(status)) return BUCKET.error;
  if (RUNNING.has(status)) return BUCKET.running;
  if (INTERRUPTED.has(status)) return BUCKET.paused;
  if (ABORTED.has(status)) return includeAborted ? BUCKET.paused : BUCKET.idle;
  if (status === 'idle' && terminalOutcome === 'completed') return BUCKET.done;
  if (terminalOutcome === 'failed') return BUCKET.error;
  if (hasErrorMessage) return BUCKET.error;
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
   * lets it reconsider rows that bucketFor() already mapped.
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
   * The overlay only applies to a session that is NOT already showing a
   * higher-urgency signal. Precedence, strongest first:
   *
   *     live error  >  running  >  paused  >  waiting  >  stale error  >  done / idle
   *
   * `waiting` is a statement about a turn that has already handed control back
   * -- "nothing is happening here right now, but something I own is". None of
   * the three above it say that, so none of them may be repainted:
   *
   *   - `running`  the turn is executing; it is not waiting on anything.
   *   - `error`    a LIVE failure (status is 'error'/'failed' right now) must
   *                not be buried under a calmer colour.
   *   - `paused`   an interrupted turn is a state the user has to act on;
   *                overwriting it with "waiting" erases the call to action.
   *
   * A STALE error is different, and waiting outranks it. Measured on the live
   * database (2026-10-03): session mvs_1feaae52 ("MMX Code 远程web版") read
   * status='idle', terminal_outcome='completed', but carried a leftover
   * error_message ("BYOK provider ... upstream error: 429") from an earlier
   * failed turn, while TWO Agent Team sub agents it owned were actively
   * running (local_runtime_background_tasks rows subagent/running). bucketFor
   * painted it error via hasErrorMessage, this overlay then skipped it, and
   * the user stared at a red dot -- no yellow -- while the chat pane said
   * "等待 Agent Team 返回结果...". An error_message on an idle session is
   * history; a running child is the present, so the present wins. The same
   * staleness argument covers terminal_outcome='failed': it describes the
   * last COMPLETED run, and a new turn with live children has already moved
   * past it. Only the session's own live status ('error'/'failed') keeps the
   * red dot safe from this overlay.
   *
   * The running guard was added after measuring the live database (2026-10-02):
   * the root session `mvs_743fa8` read status='started' with 2 live sub agents,
   * so an unguarded overlay painted the user's OWN row yellow for the entire
   * time the agent was working. The root session almost always has sub agents
   * while it works, so that made "waiting" effectively a constant colour and
   * cost the green `running` state any meaning.
   *
   * Note what is NOT a condition here: the parent is NOT required to be
   * `started`. The case this bucket exists for is a turn that has already
   * returned to `idle` while its sub agent keeps working, and two such sessions
   * were measured on the live data. Requiring `started` would drop exactly the
   * rows the bucket was added to expose. "Not required to be started" and
   * "started is ignored" are different claims, and conflating them is what
   * produced the bug above.
   */
  static applyWaitingOverlay(map, detail) {
    for (const [id, d] of detail) {
      if (!StatusDb.isWaiting(d)) continue;
      const cur = map.get(id);
      // Unknown id = archived, or not in the unarchived set. Painting it would
      // be a phantom row that can never be acted on.
      if (!cur) continue;
      // Already saying something more urgent than "waiting" -- leave it alone.
      // For error, urgency is decided by the LIVE status field only: an
      // error_message / terminal_outcome on a non-error session is a stale
      // leftover that waiting must overwrite (see the block comment above).
      if (cur.bucket === BUCKET.running || cur.bucket === BUCKET.paused) continue;
      if (cur.bucket === BUCKET.error && ERROR.has(cur.status)) continue;
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
