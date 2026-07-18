'use strict';

// Electron-free helpers for the Tasks board's "parallel build" dropdown
// (TASK-019). The Tasks toolbar lets the user pick how many build agents the
// orchestrator may run at once; that choice is persisted per-folder in the
// renderer's localStorage and carried into the build as a `--concurrency <N>`
// argument on the `/orchestrate build` command.
//
// Like lib/ticket-queue.js this module deliberately requires nothing from
// Electron or the DOM so it can be unit-tested with plain `node --test`. Every
// function here is pure: it derives options, parses/clamps a stored value, or
// builds a command string, and never touches disk, localStorage, or the network.
//
// resolveConcurrency (from lib/ticket-queue.js) is the SINGLE authority for the
// clamp/floor/default rules ([1, MAX_CONCURRENCY], floored, defaulting to
// DEFAULT_CONCURRENCY). This module delegates to it rather than re-implementing
// the bounds, so raising MAX_CONCURRENCY there is the only edit needed to widen
// the option list. The renderer (a browser script, not requireable) inlines the
// same clamp logic and must be kept in lockstep with this file — mirroring the
// ACTIVE_STATUSES / TASKS_ACTIVE_STATUSES convention used elsewhere.

const {
  resolveConcurrency,
  MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} = require('./ticket-queue');

// The ascending list of selectable concurrency values, [1 .. MAX_CONCURRENCY].
// Derived from MAX_CONCURRENCY so the ceiling never drifts from the queue's own
// clamp bound — the rendered <option> list is built directly from this.
function concurrencyOptions() {
  const out = [];
  for (let i = 1; i <= MAX_CONCURRENCY; i++) out.push(i);
  return out;
}

// Parse a value read out of localStorage into a resolved concurrency. The stored
// value may be a bare number string ("5"), a JSON-encoded number, blank, junk,
// or a corrupt/unparseable string. We try JSON.parse first (values written via
// JSON.stringify round-trip cleanly), fall back to the raw string, and let
// resolveConcurrency perform all clamping/flooring/defaulting. Never throws:
// anything it cannot make sense of collapses to DEFAULT_CONCURRENCY.
function readStoredConcurrency(raw) {
  if (raw == null) return resolveConcurrency(raw);
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return resolveConcurrency('');
    try {
      value = JSON.parse(trimmed);
    } catch (_) {
      value = trimmed;
    }
  }
  return resolveConcurrency(value);
}

// Build the queued build command carrying the chosen concurrency, e.g.
// buildConcurrencyCommand('/orchestrate build', 5) -> '/orchestrate build --concurrency 5'.
// The value is passed through resolveConcurrency so the command always carries a
// sane, in-range integer even if a stale/bad value reaches this call site.
function buildConcurrencyCommand(base, value) {
  return `${base} --concurrency ${resolveConcurrency(value)}`;
}

// The per-folder localStorage key for a folder's stored concurrency, mirroring
// the renderer's slackStorageKey pattern. Returns null when no folder is open so
// callers skip persistence (and fall back to the default) rather than writing to
// a bogus key.
function storageKey(folder) {
  return folder ? `tasks:concurrency:${folder}` : null;
}

module.exports = {
  concurrencyOptions,
  readStoredConcurrency,
  buildConcurrencyCommand,
  storageKey,
};
