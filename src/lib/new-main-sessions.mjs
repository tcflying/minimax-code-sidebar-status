// mmx-status :: lib/new-main-sessions.mjs
//
// Offline detection of NEW main-session CANDIDATES.
//
// Why this exists: the user wants a brand new conversation to reach the very
// top of the lock list. That needs a way to notice "this session row was
// created after the sidebar started" that does NOT depend on the host's own
// pin/lock policy.
//
// What a candidate is NOT: proof of a root session. The rule below is a
// STATIC predicate over metadata columns:
//
//     created after the run boundary, no parent, kind = conversation,
//     visibility = visible, not archived
//
// It reads nothing from the host and it does not claim which session is root.
// A visible parentless fork is shown by the host as an independent
// conversation, so it counts as a new conversation here -- root is not
// required. Rows that carry a parent, or whose kind is not 'conversation', are
// excluded by the predicate itself; that is a rule, not a measurement.
//
// Visibility has to be explicit. Only the literal string 'visible' is
// eligible: an explicit 'hidden' or 'unknown' row is rejected on its own (it
// is counted, the read continues), and a missing visibility column makes the
// whole read untrustworthy, so the read is refused.
//
// The same rule holds for every metadata column: a MISSING column (undefined)
// refuses the whole read, a NULL is a value the detector cannot use, so that
// row is rejected and counted while the read continues. The DB layer passes
// NULL through untouched on purpose, so this module must not assume the
// database has no NULLs.
//
// Inputs are metadata columns only: id, created_at_ms, parent_session_id,
// session_kind, archived, visibility. Titles and bodies are NOT inputs.
//
// The read-only capability probe (cap.probe) is a WRITE-permission probe, not
// a root/main classifier, so nothing here consumes it as a parent signal.
//
// State: ONE bounded ledger for the ids that reached the candidate state
// (candidate / confirmed / expired / tombstone). Every other row is ignored
// and counted, never tracked: a rejected row spends no ledger quota and is
// judged again from scratch on the next read, so if it satisfies the predicate
// at some later read it enters the ledger at that moment. The host writes
// parent and kind in ONE atomic INSERT, so a sub agent row is never seen with
// a half-written parent -- that is the only host fact this module leans on.
// A flood of sub agent rows or old rows therefore cannot crowd out a real new
// conversation.
//
// Pure module: no imports, no I/O, no timers. Every state transition is a
// function of the observe() arguments.

const ID_RE = /^mvs_[A-Za-z0-9]+$/;

/** Upper bound on ledger entries. Bounded state, entries are NEVER evicted. */
export const DEFAULT_MAX_TRACKED = 256;

/** Deadline for the SECOND agreeing read of a candidate. */
export const DEFAULT_CANDIDATE_TTL_MS = 15 * 60 * 1000;

const STATE = {
  CANDIDATE: 'candidate', // seen once, waiting for a second agreeing read
  CONFIRMED: 'confirmed', // reported once, never again
  EXPIRED: 'expired', // the deadline for the second read passed
  TOMBSTONE: 'tombstone', // metadata changed after it became a candidate
};

/**
 * Which metadata field differs, or null. Used both for the duplicate-id check
 * inside one read and for the tombstone check of a tracked candidate.
 */
function metaDiff(a, b) {
  if (a.createdAtMs !== b.createdAtMs) return 'created-changed';
  if (a.parentKey !== b.parentKey) return 'parent-changed';
  if (a.sessionKind !== b.sessionKind) return 'kind-changed';
  if (a.visibility !== b.visibility) return 'visibility-changed';
  if (a.archived !== b.archived) return 'archived';
  return null;
}

function parseRow(row, index) {
  if (!row || typeof row !== 'object') {
    throw new TypeError(`observe(): row ${index} is not an object`);
  }
  const { id, createdAtMs, parentSessionId, sessionKind, archived, visibility } = row;
  // A MISSING column (undefined) means the query did not select it, so the
  // whole read is untrustworthy and is refused. A NULL is a database value the
  // detector cannot use: that row is rejected and counted, and the read
  // continues. The DB layer passes NULL through untouched on purpose.
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`observe(): row ${index} has no usable id`);
  }
  if (createdAtMs === undefined) {
    throw new TypeError(`observe(): row ${index} (${id}) has no createdAtMs column`);
  }
  if (createdAtMs !== null && !Number.isSafeInteger(createdAtMs)) {
    throw new TypeError(`observe(): row ${index} (${id}) has an invalid createdAtMs`);
  }
  if (parentSessionId === undefined) {
    // undefined means the column was not selected. An unknown parent is not
    // "no parent", so it is refused instead of guessed.
    throw new TypeError(`observe(): row ${index} (${id}) has no parentSessionId column`);
  }
  if (parentSessionId !== null && typeof parentSessionId !== 'string') {
    throw new TypeError(`observe(): row ${index} (${id}) has an invalid parentSessionId`);
  }
  if (sessionKind === undefined) {
    throw new TypeError(`observe(): row ${index} (${id}) has no sessionKind column`);
  }
  if (sessionKind !== null && typeof sessionKind !== 'string') {
    throw new TypeError(`observe(): row ${index} (${id}) has an invalid sessionKind`);
  }
  if (archived === undefined) {
    throw new TypeError(`observe(): row ${index} (${id}) has no archived column`);
  }
  if (archived !== null && (typeof archived !== 'number' || !Number.isFinite(archived))) {
    throw new TypeError(`observe(): row ${index} (${id}) has an invalid archived flag`);
  }
  if (visibility === undefined) {
    throw new TypeError(`observe(): row ${index} (${id}) has no visibility column`);
  }
  return {
    id,
    createdAtMs: Number.isSafeInteger(createdAtMs) ? createdAtMs : null,
    parentKey: parentSessionId === null ? '' : parentSessionId,
    sessionKind,
    archived,
    // Only the literal 'visible' is eligible. A NULL visibility means "not
    // known to be visible".
    visibility: typeof visibility === 'string' ? visibility : 'unknown',
  };
}

/**
 * createNewMainSessionDetector({ startedAtMs, maxTracked, candidateTtlMs })
 *
 * startedAtMs is the run boundary, taken by the caller with Date.now() BEFORE
 * the sidebar starts. It is fixed: it is NOT derived from the rows (MAX of
 * created_at_ms would inherit whatever the DB already had), and it does NOT
 * advance when candidates are delivered.
 */
export function createNewMainSessionDetector({
  startedAtMs,
  maxTracked = DEFAULT_MAX_TRACKED,
  candidateTtlMs = DEFAULT_CANDIDATE_TTL_MS,
} = {}) {
  if (!Number.isSafeInteger(startedAtMs)) {
    throw new TypeError('startedAtMs must be a safe integer');
  }
  if (!Number.isSafeInteger(maxTracked) || maxTracked < 1) {
    throw new TypeError('maxTracked must be a positive safe integer');
  }
  if (!Number.isSafeInteger(candidateTtlMs) || candidateTtlMs < 1) {
    throw new TypeError('candidateTtlMs must be a positive safe integer');
  }

  /** id -> record. Only ids that reached the candidate state land here. */
  const ledger = new Map();
  const rejectedCounts = new Map();
  const deferredCounts = new Map();
  const overflowSamples = [];
  let seeded = false;
  let observeCount = 0;
  let lastSuccessfulAtMs = null;
  let overflowDropped = 0;

  const count = (map, reason) => map.set(reason, (map.get(reason) || 0) + 1);
  const counts = (map) => Object.fromEntries(map);

  /**
   * observe(rows, { observedAtMs }) -> {
   *   confirmedCandidates: [{ id, createdAtMs }],   // reported at most once per id
   *   expired:  [{ id, createdAtMs, reason }],       // expired in THIS read
   *   rejected: { reason: count },                   // cumulative
   *   deferred: { reason: count },                   // cumulative
   *   overflow: { dropped, droppedNow, limit, samples },
   * }
   *
   * A malformed read (not an array, invalid observedAtMs, a row with a missing
   * or unusable field, a clock that went backwards) throws and advances
   * NOTHING. The caller must not call observe() at all when the database read
   * failed.
   */
  function observe(rows, { observedAtMs } = {}) {
    if (!Array.isArray(rows)) {
      throw new TypeError('observe(): rows must be an array');
    }
    if (!Number.isSafeInteger(observedAtMs)) {
      throw new TypeError('observe(): observedAtMs must be a safe integer');
    }
    if (lastSuccessfulAtMs !== null && observedAtMs < lastSuccessfulAtMs) {
      // A clock that walked backwards would let a stale snapshot count as
      // progress. Refuse the whole read instead of advancing anything.
      throw new TypeError('observe(): observedAtMs went backwards');
    }

    // Parse everything BEFORE touching state, so a malformed row cannot leave
    // a half-applied read behind.
    const parsed = rows.map(parseRow);

    // Expire BEFORE the batch is applied. The deadline for the second agreeing
    // read is firstSeenAtMs + TTL; a candidate that is still sitting in the
    // table when that deadline passes must expire even if this read contains
    // it, so the check cannot run after the candidate was updated.
    const expired = [];
    for (const rec of ledger.values()) {
      if (rec.state !== STATE.CANDIDATE) continue;
      if (observedAtMs - rec.firstSeenAtMs > candidateTtlMs) {
        rec.state = STATE.EXPIRED;
        rec.reason = 'ttl-expired';
        expired.push({ id: rec.id, createdAtMs: rec.createdAtMs, reason: rec.reason });
      }
    }

    // The same id twice inside ONE read with different metadata is a
    // contradiction. Fail closed on that id for this read: neither row may be
    // used as evidence, and the later row must not overwrite the earlier one.
    const unique = new Map();
    const conflicts = new Set();
    for (const r of parsed) {
      const prev = unique.get(r.id);
      if (prev === undefined) {
        unique.set(r.id, r);
      } else if (metaDiff(prev, r)) {
        conflicts.add(r.id);
      }
    }

    // Ascending creation time; same millisecond falls back to the id for a
    // stable order. Within one millisecond there is no evidence of which row
    // came first, so no real ordering is invented here.
    const ordered = [...unique.values()].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

    const confirmedCandidates = [];
    let droppedNow = 0;

    for (const r of ordered) {
      const rec = ledger.get(r.id);

      if (conflicts.has(r.id)) {
        count(rejectedCounts, 'duplicate-conflict');
        if (rec && rec.state === STATE.CANDIDATE) {
          rec.state = STATE.TOMBSTONE;
          rec.reason = 'duplicate-conflict';
        }
        continue;
      }

      if (rec) {
        // Already judged (confirmed / expired / tombstone): the id is never
        // judged again, so it can never be reported twice.
        if (rec.state !== STATE.CANDIDATE) continue;
        const diff = metaDiff(rec, r);
        if (diff) {
          rec.state = STATE.TOMBSTONE;
          rec.reason = diff;
          count(rejectedCounts, diff);
          continue;
        }
        // Identical metadata in a later, forward-moving read. The id is in the
        // ledger, so it was seen before: this is the second agreeing read.
        if (observedAtMs > rec.firstSeenAtMs) {
          rec.state = STATE.CONFIRMED;
          confirmedCandidates.push({ id: rec.id, createdAtMs: rec.createdAtMs });
        }
        continue;
      }

      // The first read only seeds: it judges nothing and builds no ledger
      // entry. A session created between startedAtMs and that read may be
      // reported late, when it shows up in a later read -- a documented
      // boundary, not a guarantee.
      if (!seeded) {
        count(rejectedCounts, 'baseline');
        continue;
      }

      // Age first: an old row must not spend a counter slot on its id format,
      // and old rows are irrelevant to a new conversation anyway.
      if (r.createdAtMs === null) {
        count(rejectedCounts, 'created-unknown');
        continue;
      }
      if (r.createdAtMs < startedAtMs) {
        count(rejectedCounts, 'before-cutoff');
        continue;
      }
      if (r.createdAtMs > observedAtMs) {
        // The row claims to be newer than this pass's clock reading. Not
        // judged yet: it may become judgeable once time catches up.
        count(deferredCounts, 'created-in-future');
        continue;
      }
      if (!ID_RE.test(r.id)) {
        count(rejectedCounts, 'id-format');
        continue;
      }
      if (r.parentKey !== '') {
        count(rejectedCounts, 'has-parent');
        continue;
      }
      if (r.sessionKind === null) {
        count(rejectedCounts, 'kind-unknown');
        continue;
      }
      if (r.sessionKind !== 'conversation') {
        // 'task' and 'branch' are real session types, not malformed rows:
        // they are counted and ignored, never treated as bad input.
        count(rejectedCounts, 'kind-not-conversation');
        continue;
      }
      if (r.visibility !== 'visible') {
        count(rejectedCounts, r.visibility === 'hidden' ? 'visibility-hidden' : 'visibility-unknown');
        continue;
      }
      if (r.archived === null) {
        count(rejectedCounts, 'archived-unknown');
        continue;
      }
      if (r.archived !== 0) {
        count(rejectedCounts, 'archived');
        continue;
      }

      // Eligible. At the ledger limit, fail closed: the id is dropped and
      // reported instead of evicting an older entry -- evicting a judged id
      // would let it be judged again later and reported twice.
      if (ledger.size >= maxTracked) {
        overflowDropped++;
        droppedNow++;
        if (overflowSamples.length < 20) overflowSamples.push(r.id);
        continue;
      }
      ledger.set(r.id, {
        id: r.id,
        createdAtMs: r.createdAtMs,
        parentKey: r.parentKey,
        sessionKind: r.sessionKind,
        archived: r.archived,
        visibility: r.visibility,
        state: STATE.CANDIDATE,
        reason: null,
        firstSeenAtMs: observedAtMs,
      });
    }

    seeded = true;
    observeCount += 1;
    lastSuccessfulAtMs = observedAtMs;

    return {
      confirmedCandidates,
      expired,
      rejected: counts(rejectedCounts),
      deferred: counts(deferredCounts),
      overflow: {
        dropped: overflowDropped,
        droppedNow,
        limit: maxTracked,
        samples: overflowSamples.slice(),
      },
    };
  }

  /** Serialisable state summary. Read-only. */
  function snapshot() {
    const confirmed = [];
    const candidates = [];
    const expired = [];
    const tombstones = [];
    for (const rec of ledger.values()) {
      if (rec.state === STATE.CONFIRMED) {
        confirmed.push({ id: rec.id, createdAtMs: rec.createdAtMs });
      } else if (rec.state === STATE.CANDIDATE) {
        candidates.push({ id: rec.id, createdAtMs: rec.createdAtMs });
      } else if (rec.state === STATE.EXPIRED) {
        expired.push({ id: rec.id, createdAtMs: rec.createdAtMs, reason: rec.reason });
      } else if (rec.state === STATE.TOMBSTONE) {
        tombstones.push({ id: rec.id, createdAtMs: rec.createdAtMs, reason: rec.reason });
      }
    }
    return {
      startedAtMs,
      seeded,
      observeCount,
      tracked: ledger.size,
      limit: maxTracked,
      confirmed,
      candidates,
      expired,
      tombstones,
      rejected: counts(rejectedCounts),
      deferred: counts(deferredCounts),
      overflow: {
        dropped: overflowDropped,
        limit: maxTracked,
        samples: overflowSamples.slice(),
      },
    };
  }

  return { observe, snapshot };
}
