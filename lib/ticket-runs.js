'use strict';

// Electron-free helper for recording a per-run accounting entry on a ticket
// (TASK-012). Where lib/ticket-accounting.js stamps the SINGLE latest build's
// `startedAt` / `finishedAt` / `costUsd` onto flat frontmatter, this module keeps
// a durable LOG: every time a ticket is built/processed the orchestrator (never a
// subagent) calls appendRun to push one { startedAt, finishedAt, minutes, costUsd,
// at } entry onto the ticket's run history. Re-running a ticket appends a NEW entry
// rather than overwriting, so a ticket accumulates multiple runs over its lifetime.
//
// Storage: the run log lives in a single flat frontmatter field, `runs`, holding a
// JSON-encoded array on ONE line. The board's parseTicketFrontmatter takes
// everything after the first `:` on a line as an opaque string value, and
// serializeTicket writes `runs: <that string>` back verbatim, so a one-line JSON
// array round-trips untouched through whole-file writes and board polls without any
// nested-YAML the flat parser could not read. The single-field accounting
// (startedAt / finishedAt / costUsd / tokens) from lib/ticket-accounting.js is left
// intact for backward compatibility — this is additive.
//
// Like lib/ticket-accounting.js and lib/ticket-history.js this file deliberately
// requires nothing from Electron so it can be unit-tested with plain `node --test`.
// It reuses ticket-accounting's orderFm / toIso / isValidAmount so key ordering and
// value-validity rules stay identical across the accounting helpers.
//
// Contract:
//   - appendRun always records a run with a normalised ISO-8601 `at` (the moment
//     the run is logged) plus the run's `startedAt` / `finishedAt`.
//   - `minutes` is computed from startedAt/finishedAt when both are valid and the
//     end does not precede the start; otherwise it is omitted (never fabricated).
//   - `costUsd` is written ONLY when a finite number >= 0 is supplied (same guard
//     as ticket-accounting.isValidAmount); missing/invalid cost leaves the field
//     absent rather than writing NaN / 0 / '' / junk.
//   - Existing `runs` entries are preserved in order; the new entry is appended
//     last (chronological). A malformed/absent `runs` field is treated as empty.
//   - Returns a NEW frontmatter object (input is not mutated) with keys ordered
//     id, title, status, created, updated first, then everything else.

const { orderFm, toIso, isValidAmount } = require('./ticket-accounting');

// Flat frontmatter field the run log is stored under, as a one-line JSON array.
const RUNS_KEY = 'runs';

// Minutes of wall-clock work between two ISO-8601 stamps, rounded to two decimals.
// Returns null when either stamp is missing/invalid or the end precedes the start,
// so a bad pair contributes no fabricated duration.
function computeMinutes(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const ms = end - start;
  if (ms < 0) return null;
  return Math.round((ms / 60000) * 100) / 100;
}

// Parse the run log off a frontmatter object into an array of entry objects.
// Tolerant: an absent field, a non-string field, invalid JSON, or a non-array
// payload all yield an empty array so a hand-edited or corrupt ticket never throws.
function parseRuns(fm) {
  const raw = fm && typeof fm === 'object' ? fm[RUNS_KEY] : null;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((e) => e && typeof e === 'object');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object') : [];
  } catch (_) {
    return [];
  }
}

// Serialize a run-entry array to the one-line JSON string stored in frontmatter.
// JSON.stringify emits no newlines, so the value stays on a single line and
// round-trips through the flat parser/serializer.
function serializeRuns(runs) {
  return JSON.stringify(Array.isArray(runs) ? runs : []);
}

// Append one run entry to a ticket's run log and return a new frontmatter object.
// Pure: does not touch disk and does not mutate its input.
//
//   appendRun(fm, { startedAt, finishedAt, minutes, costUsd, at }) -> fm'
//
// - `startedAt` / `finishedAt` ISO-8601 (or Date / epoch-ms) bounds of the run.
// - `minutes`   optional explicit duration; when omitted it is computed from the
//               start/end pair (absent if that pair is missing/invalid).
// - `costUsd`   the run's cost; recorded only when a finite number >= 0.
// - `at`        when the run was logged; defaults to finishedAt, else now.
function appendRun(fm, opts) {
  const out = orderFm(fm);
  const o = opts || {};

  const entry = { at: toIso(o.at != null ? o.at : o.finishedAt) };
  if (o.startedAt != null && String(o.startedAt).trim() !== '') {
    entry.startedAt = toIso(o.startedAt);
  }
  if (o.finishedAt != null && String(o.finishedAt).trim() !== '') {
    entry.finishedAt = toIso(o.finishedAt);
  }

  const minutes = isValidAmount(o.minutes)
    ? Number(o.minutes)
    : computeMinutes(entry.startedAt, entry.finishedAt);
  if (minutes != null && isValidAmount(minutes)) entry.minutes = Number(minutes);

  if (isValidAmount(o.costUsd)) entry.costUsd = Number(o.costUsd);

  const runs = parseRuns(out);
  runs.push(entry);
  out[RUNS_KEY] = serializeRuns(runs);
  return out;
}

module.exports = {
  appendRun,
  parseRuns,
  serializeRuns,
  computeMinutes,
  RUNS_KEY,
};
