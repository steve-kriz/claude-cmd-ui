'use strict';

// Electron-free helper for recording a per-ACTIVITY cost/accounting log on a
// ticket (TASK-070). Where lib/ticket-accounting.js stamps the SINGLE latest
// build's `startedAt` / `finishedAt` / `tokens` / `costUsd` onto flat frontmatter,
// and lib/ticket-runs.js keeps a per-run log, this module keeps a finer-grained
// LOG broken down by the ACTIVITY that produced the work: `ba`, `code`, `test`,
// `review`, plus any future activity string. Each time the
// orchestrator (never a subagent) dispatches a phase, it calls appendActivity to
// push one { activity, model, startedAt, finishedAt, durationMs, tokensIn,
// tokensOut, cacheReadTokens, cacheCreationTokens, costUsd } entry, so a ticket
// accumulates a complete cost view over its lifetime. cacheReadTokens /
// cacheCreationTokens (TASK-142) capture prompt-cache hits sourced from the
// app's OTEL telemetry correlation (lib/telemetry.js#usageForWindow); like the
// other numeric fields they are omitted rather than fabricated when no
// telemetry was available for the activity's window.
//
// Storage: the activity log lives in a single flat frontmatter field, `activities`,
// holding a JSON-encoded array on ONE line — the exact pattern proven by `runs`.
// The board's parseTicketFrontmatter takes everything after the first `:` on a
// line as an opaque string value, and serializeTicket writes it back verbatim, so
// a one-line JSON array round-trips untouched through whole-file writes and board
// polls without any nested-YAML the flat parser could not read. The single-field
// accounting (startedAt / finishedAt / tokens / costUsd) and the `runs` log are
// left intact for backward compatibility — this is additive.
//
// Like lib/ticket-accounting.js and lib/ticket-runs.js this file deliberately
// requires nothing from Electron so it can be unit-tested with plain `node --test`.
// It reuses ticket-accounting's orderFm / toIso / isValidAmount so key ordering and
// value-validity rules stay identical across the accounting helpers.
//
// Contract:
//   - appendActivity requires a non-empty `activity` string; an entry without one
//     is rejected (the fm is returned unchanged apart from key ordering) rather
//     than half-written.
//   - `model` is recorded when a non-empty string is supplied; `startedAt` /
//     `finishedAt` are normalised to ISO-8601 via toIso when present.
//   - `durationMs` is computed from the startedAt/finishedAt pair when both are
//     valid and the end does not precede the start, unless supplied explicitly;
//     otherwise it is omitted (never fabricated).
//   - `tokensIn` / `tokensOut` / `cacheReadTokens` / `cacheCreationTokens` /
//     `costUsd` are written ONLY when they pass isValidAmount (a finite number
//     >= 0); missing / NaN / negative / '' values leave the field absent. Note
//     isValidAmount(0) is true — 0 is a valid recorded amount and is distinct
//     from "absent".
//   - Existing `activities` entries are preserved in order; the new entry is
//     appended last (chronological). A malformed/absent field is treated as empty.
//   - Returns a NEW frontmatter object (input is not mutated) with keys ordered
//     id, title, status, created, updated first, then everything else.

const { orderFm, toIso, isValidAmount } = require('./ticket-accounting');

// Flat frontmatter field the activity log is stored under, as a one-line JSON array.
const ACTIVITIES_KEY = 'activities';

// The activity types the orchestrator's phases map onto. The list is OPEN-ENDED:
// unknown activity strings ("whatever other activity is being done") are stored and
// displayed as-is; these known values only aid display ordering/labels.
const KNOWN_ACTIVITIES = ['ba', 'code', 'test', 'review'];

// Milliseconds of wall-clock work between two ISO-8601 stamps. Returns null when
// either stamp is missing/invalid or the end precedes the start, so a bad or
// reversed pair contributes no fabricated duration (mirrors computeMinutes in
// lib/ticket-runs.js).
function computeDurationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const ms = end - start;
  if (ms < 0) return null;
  return ms;
}

// Parse the activity log off a frontmatter object into an array of entry objects.
// Tolerant: an absent field, a non-string field, invalid JSON, a non-array payload,
// or non-object array members all yield a clean array (bad members filtered) so a
// hand-edited or corrupt ticket never throws.
function parseActivities(fm) {
  const raw = fm && typeof fm === 'object' ? fm[ACTIVITIES_KEY] : null;
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

// Serialize an activity-entry array to the one-line JSON string stored in
// frontmatter. JSON.stringify emits no newlines, so the value stays on a single
// line and round-trips through the flat parser/serializer.
function serializeActivities(activities) {
  return JSON.stringify(Array.isArray(activities) ? activities : []);
}

// Append one activity entry to a ticket's cost log and return a new frontmatter
// object. Pure: does not touch disk and does not mutate its input.
//
//   appendActivity(fm, { activity, model, startedAt, finishedAt, durationMs,
//                        tokensIn, tokensOut, cacheReadTokens,
//                        cacheCreationTokens, costUsd }) -> fm'
//
// - `activity`   REQUIRED non-empty string; a missing/blank activity rejects the
//                entry (fm returned unchanged apart from key ordering).
// - `model`      the model dispatched for this activity; recorded when a non-empty
//                string.
// - `startedAt` / `finishedAt` ISO-8601 (or Date / epoch-ms) bounds of the work.
// - `durationMs` optional explicit duration; when omitted it is computed from the
//                start/finish pair (absent if that pair is missing/invalid/reversed).
// - `tokensIn` / `tokensOut` / `cacheReadTokens` / `cacheCreationTokens` /
//                `costUsd` recorded only when a finite number >= 0 (isValidAmount);
//                missing/invalid values leave the field absent.
function appendActivity(fm, opts) {
  const out = orderFm(fm);
  const o = opts || {};

  const activity = o.activity != null ? String(o.activity).trim() : '';
  if (activity === '') return out;

  const entry = { activity };

  if (o.model != null && String(o.model).trim() !== '') {
    entry.model = String(o.model).trim();
  }
  if (o.startedAt != null && String(o.startedAt).trim() !== '') {
    entry.startedAt = toIso(o.startedAt);
  }
  if (o.finishedAt != null && String(o.finishedAt).trim() !== '') {
    entry.finishedAt = toIso(o.finishedAt);
  }

  const durationMs = isValidAmount(o.durationMs)
    ? Number(o.durationMs)
    : computeDurationMs(entry.startedAt, entry.finishedAt);
  if (durationMs != null && isValidAmount(durationMs)) entry.durationMs = Number(durationMs);

  if (isValidAmount(o.tokensIn)) entry.tokensIn = Number(o.tokensIn);
  if (isValidAmount(o.tokensOut)) entry.tokensOut = Number(o.tokensOut);
  if (isValidAmount(o.cacheReadTokens)) entry.cacheReadTokens = Number(o.cacheReadTokens);
  if (isValidAmount(o.cacheCreationTokens)) entry.cacheCreationTokens = Number(o.cacheCreationTokens);
  if (isValidAmount(o.costUsd)) entry.costUsd = Number(o.costUsd);

  const activities = parseActivities(out);
  activities.push(entry);
  out[ACTIVITIES_KEY] = serializeActivities(activities);
  return out;
}

// Sum durationMs / tokensIn / tokensOut / cacheReadTokens / cacheCreationTokens /
// costUsd across a parsed activity array, counting only valid present values. A
// total is null when NO entry carried that field, so a missing category is never
// reported as a fabricated 0 and no total is ever NaN.
function totalActivities(activities) {
  const list = Array.isArray(activities) ? activities : [];
  const acc = {
    durationMs: null, tokensIn: null, tokensOut: null,
    cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
  };
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    for (const k of ['durationMs', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd']) {
      if (isValidAmount(e[k])) {
        acc[k] = (acc[k] == null ? 0 : acc[k]) + Number(e[k]);
      }
    }
  }
  return acc;
}

module.exports = {
  appendActivity,
  parseActivities,
  serializeActivities,
  totalActivities,
  computeDurationMs,
  ACTIVITIES_KEY,
  KNOWN_ACTIVITIES,
};
