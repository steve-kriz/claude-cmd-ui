'use strict';

// Keep-awake decision (TASK-036). While at least one orchestrate ticket is
// actively being worked, the app holds an OS wake-lock (main.js drives Electron's
// powerSaveBlocker) so the machine does not sleep mid-build. This module is the
// PURE, Electron-free decision half — like lib/ticket-queue.js and
// lib/ticket-lanes.js it requires nothing from Electron so it can be unit-tested
// with plain `node --test`. It never touches disk, the OS, or the blocker; it
// only answers "given the current active work, should the wake-lock be held?".
//
// The keep-awake status set is exactly the board's ACTIVE_STATUSES (defining /
// in-progress / testing — an agent is literally working the card). TASK-206
// removed the post-processing lane/status this set used to also include; it is
// derived from lib/ticket-lanes so it stays in lockstep with the canonical
// status enum rather than hardcoding strings.

const { ACTIVE_STATUSES } = require('./ticket-lanes');

// Statuses that mean real work is running and the OS must not sleep.
const KEEP_AWAKE_STATUSES = [...ACTIVE_STATUSES];

// True when a single ticket status means the machine must stay awake.
function isKeepAwakeStatus(status) {
  return KEEP_AWAKE_STATUSES.includes(status);
}

// Count tickets whose status keeps the machine awake. Accepts the board's
// fm-unwrap idiom: entries may be `{ fm }` wrappers or bare fm objects. Non-array
// / junk input counts as 0.
function keepAwakeCount(tickets) {
  if (!Array.isArray(tickets)) return 0;
  let n = 0;
  for (const t of tickets) {
    const fm = t && t.fm ? t.fm : t;
    if (fm && isKeepAwakeStatus(fm.status)) n++;
  }
  return n;
}

// The pure decision: should the OS wake-lock be held right now? Accepts either a
// ready-made active count (number — the renderer aggregates its boards and sends
// one number) OR a list of tickets. Any positive count of keep-awake tickets →
// true; nothing active (0, empty, null, NaN, junk) → false. Never throws.
function shouldKeepAwake(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0;
  return keepAwakeCount(input) > 0;
}

module.exports = {
  KEEP_AWAKE_STATUSES,
  isKeepAwakeStatus,
  keepAwakeCount,
  shouldKeepAwake,
};
