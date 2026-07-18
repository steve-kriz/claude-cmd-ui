'use strict';

// Electron-free helpers for recording per-ticket build accounting (TASK-003):
// how long a ticket took to build and how much that build cost. The orchestrator
// (never a subagent) calls these pure functions to stamp `startedAt` /
// `finishedAt` (ISO-8601) plus optional `tokens` / `costUsd` onto a ticket's flat
// frontmatter object, then hands the result to serializeTicket for a whole-file
// write. The board's serializer keeps `id, title, status, created, updated` as the
// leading keys and preserves any other keys, so these accounting fields round-trip
// without disturbing the known ordering or the user-owned `## Additional Context`.
//
// Like lib/env-store.js and lib/ticket-history.js this file deliberately requires
// nothing from Electron so it can be unit-tested with plain `node --test`.
//
// Contract:
//   - recordBuildStart sets `startedAt` only if not already present (the first
//     transition into active work wins; re-entry does not reset the clock).
//   - recordBuildEnd always sets `finishedAt`, and sets `tokens` / `costUsd` ONLY
//     when a finite number >= 0 is supplied. Missing or invalid cost/token data
//     never writes a fabricated, NaN, or empty value — the field is simply absent.
//   - Both return a NEW frontmatter object (inputs are not mutated) whose keys are
//     ordered id, title, status, created, updated first, then everything else.

// Fixed leading keys the board parser/serializer expect up front, in this order.
const LEADING_KEYS = ['id', 'title', 'status', 'created', 'updated'];

// True for values we are willing to persist as a cost/token figure: a finite
// number (or a numeric string) that is zero or positive. Guards against NaN,
// Infinity, negative, null, undefined, '' and other junk so we never write a
// fabricated or malformed accounting value.
function isValidAmount(v) {
  if (v == null || v === '') return false;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0;
}

// Normalise a timestamp input to an ISO-8601 string. Accepts a Date, an ISO
// string, or ms-since-epoch; falls back to "now" when nothing valid is given.
function toIso(at) {
  if (at instanceof Date && !Number.isNaN(at.getTime())) return at.toISOString();
  if (typeof at === 'string' && at.trim()) {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return at.trim();
  }
  if (typeof at === 'number' && Number.isFinite(at)) {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

// Return a shallow copy of `fm` with keys ordered: LEADING_KEYS (those present,
// in that order) first, then every other key in its existing insertion order.
// Object key order is insertion order in JS, so this keeps the on-disk layout
// stable and matches serializeTicket's own ordering.
function orderFm(fm) {
  const src = fm && typeof fm === 'object' ? fm : {};
  const out = {};
  for (const k of LEADING_KEYS) {
    if (src[k] != null) out[k] = src[k];
  }
  for (const k of Object.keys(src)) {
    if (!(k in out)) out[k] = src[k];
  }
  return out;
}

// Record the moment work started on a ticket. Sets `startedAt` (ISO-8601) only
// when it is not already present, so the first transition into active work wins
// and later re-entries leave the original start time intact. Returns a new fm.
//
//   recordBuildStart(fm, { at }) -> fm'
function recordBuildStart(fm, opts) {
  const out = orderFm(fm);
  const at = opts && opts.at;
  if (out.startedAt == null || String(out.startedAt).trim() === '') {
    out.startedAt = toIso(at);
  }
  return out;
}

// Record the moment a build reached a terminal state (done, or left in
// failed-testing). Always sets `finishedAt` (ISO-8601). Sets `tokens` and/or
// `costUsd` ONLY when a valid finite non-negative amount is supplied; when the
// data is unavailable the field is left untouched (never fabricated). Returns a
// new fm.
//
//   recordBuildEnd(fm, { at, tokens, costUsd }) -> fm'
function recordBuildEnd(fm, opts) {
  const out = orderFm(fm);
  const o = opts || {};
  out.finishedAt = toIso(o.at);
  if (isValidAmount(o.tokens)) out.tokens = Number(o.tokens);
  if (isValidAmount(o.costUsd)) out.costUsd = Number(o.costUsd);
  return out;
}

// Format the wall-clock gap between two ISO-8601 timestamps as a compact,
// human-readable string (e.g. "2m 34s", "1h 05m", "12s"). When `finishedAt` is
// omitted the elapsed time up to `now` is used (a still-running build). Returns
// null when the start is missing/invalid or the end precedes the start.
function formatDuration(startedAt, finishedAt, now) {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  let end;
  if (finishedAt) {
    end = new Date(finishedAt).getTime();
    if (Number.isNaN(end)) return null;
  } else {
    end = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
  }
  let ms = end - start;
  if (ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

module.exports = {
  recordBuildStart,
  recordBuildEnd,
  formatDuration,
  isValidAmount,
  orderFm,
  toIso,
  LEADING_KEYS,
};
