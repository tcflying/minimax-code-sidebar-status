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
    this._map = new Map();
    this.refresh();
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
    const c = { running: 0, paused: 0, error: 0, done: 0, idle: 0 };
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
