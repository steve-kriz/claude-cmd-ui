'use strict';

// Stale-done ticket archiving for the Tasks board (TASK-065). Pure and
// Electron-free so it can be unit-tested with `node --test`, mirroring
// lib/ticket-lanes.js, lib/ticket-folders.js, lib/ticket-queue.js, etc. The
// renderer (a browser script that cannot require Node modules) duplicates the
// tiny constant/predicate it needs, matching how TASK-003/005/006/007/008
// handled the browser side.
//
// Archiving is DERIVED, never stored: there is NO new status (the enum in
// lib/ticket-lanes.js is fixed) and NO file move/rewrite. A done ticket whose
// last activity is more than ARCHIVE_AFTER_DAYS old is simply folded out of the
// normal Done card list and into a collapsible "Archived (N)" expander. It is a
// pure function of frontmatter timestamps plus the current time, which the
// caller injects — this module NEVER reads the clock itself, so tests can pin a
// fixed `now` and the result is fully deterministic.
//
// The age-driving timestamp is fm.updated, falling back to fm.created when
// updated is missing/invalid. Every failure mode is fail-safe: a missing/invalid
// timestamp, a missing/invalid `now`, or a negative age (a future timestamp)
// yields NOT-archived, so a ticket is shown rather than hidden when in doubt.

// How old a done ticket's last activity must be before it is archived.
const ARCHIVE_AFTER_DAYS = 5;
const ARCHIVE_AFTER_MS = ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

// Coerce a value that may be epoch ms, a numeric string, an ISO-8601 string, or
// a Date into epoch ms, or null when it cannot be parsed (never NaN).
function toEpochMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = new Date(String(v).trim()).getTime();
  return Number.isNaN(t) ? null : t;
}

// Epoch ms of the timestamp that drives a ticket's archive age: fm.updated, else
// fm.created, else null. Tolerates a { fm }-wrapper or a bare fm object. Returns
// null (never NaN) when both are missing/invalid.
function archiveTimestamp(fm) {
  const src = fm && fm.fm ? fm.fm : fm;
  if (!src) return null;
  const updated = toEpochMs(src.updated);
  if (updated != null) return updated;
  return toEpochMs(src.created);
}

// True ONLY when the ticket is done AND its last activity is strictly more than
// ARCHIVE_AFTER_MS old relative to the injected `now` (epoch ms or Date). Every
// other case — non-done status, missing/invalid timestamp, missing/invalid
// `now`, exactly-at-or-under the threshold (strict >), or a future timestamp
// (negative age) — is false, so the ticket stays visible. Never calls the clock.
function isArchived(fm, now) {
  const src = fm && fm.fm ? fm.fm : fm;
  if (!src || src.status !== 'done') return false;
  const nowMs = toEpochMs(now);
  if (nowMs == null) return false;
  const ts = archiveTimestamp(src);
  if (ts == null) return false;
  const age = nowMs - ts;
  if (age < 0) return false;
  return age > ARCHIVE_AFTER_MS;
}

// Split entries into { visible, archived } by isArchived, preserving input order
// and mutating neither the array nor its entries. Entries may be { fm }-wrappers
// OR bare fm objects (the same tolerant unwrap idiom used throughout lib/).
function partitionArchived(entries, now) {
  const visible = [];
  const archived = [];
  for (const e of entries || []) {
    if (isArchived(e, now)) archived.push(e);
    else visible.push(e);
  }
  return { visible, archived };
}

module.exports = {
  ARCHIVE_AFTER_DAYS,
  ARCHIVE_AFTER_MS,
  archiveTimestamp,
  isArchived,
  partitionArchived,
};
