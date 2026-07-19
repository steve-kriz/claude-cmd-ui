'use strict';

// Canonical, Electron-free pure form of the Tasks board's inline
// running-count / agent-label logic (TASK-021). renderer/renderer.js's
// renderTasksBoard computes these two derived, frontmatter-only values inline
// (the "N running" status-line fragment and the per-card agent label), but that
// file is a browser script and cannot be `require`d under `node --test`. So —
// exactly as lib/ticket-queue.js hosts `activeCount` and lib/ticket-folders.js
// hosts its path helpers while the renderer mirrors them browser-side — this
// module hosts the canonical logic and the renderer duplicates it inline. Keep
// semantics IDENTICAL to the renderer: changing one without the other is a bug.
//
// NOTE (intentional divergence): the board's active set INCLUDES `defining`
// (the BA phase), so it is `['defining','in-progress','testing']` — NOT the same
// as lib/ticket-queue.js's ACTIVE_STATUSES (`['in-progress','testing']`, the
// claim/concurrency set). The running count paints the board's blue-dot set, so
// it uses the broader board set. Everything here is pure: derived only from the
// persisted `status` / `agent` frontmatter fields, no disk/git/network.

// The board's active set — mirrors renderer.js's TASKS_ACTIVE_STATUSES (~5112).
const TASKS_ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];

// Accept either a { fm } wrapper or a bare frontmatter object, matching how
// lib/ticket-queue.js's helpers (activeCount, selectNextBatch) tolerate both.
function fmOf(t) {
  return t && t.fm ? t.fm : t;
}

// Count of tickets an agent is actively working right now, i.e. whose persisted
// `status` is in the board's active set. Mirrors renderer.js's inline reduce
// (~5728). A ticket that merely carries an `agent` field but sits in a
// non-active status (todo/done/failed-testing/unknown) does NOT count — the
// count matches the visible blue dots, not the claim field. Tolerates { fm }
// wrappers and bare fm; a non-array input yields 0.
function countRunning(tickets, activeStatuses) {
  const active = Array.isArray(activeStatuses) ? activeStatuses : TASKS_ACTIVE_STATUSES;
  if (!Array.isArray(tickets)) return 0;
  let n = 0;
  for (const t of tickets) {
    const fm = fmOf(t);
    if (fm && active.includes(fm.status)) n++;
  }
  return n;
}

// The per-card agent label: the trimmed non-empty `agent` string, or '' when it
// is absent / empty / whitespace-only. Mirrors the renderer's guard
// (ticketFieldNonEmpty(tk.fm.agent) then String(tk.fm.agent).trim(), ~5699).
function agentLabel(fm) {
  const src = fmOf(fm);
  if (!src || src.agent == null) return '';
  const s = String(src.agent).trim();
  return s === '' ? '' : s;
}

// The status-line fragment builder: ` · ${count} running` when count > 0, else
// '' (the fragment is omitted entirely, never rendered as "0 running").
// Mirrors renderer.js's `runningFrag` (~5730).
function runningFragment(count) {
  return count > 0 ? ` · ${count} running` : '';
}

module.exports = {
  TASKS_ACTIVE_STATUSES,
  countRunning,
  agentLabel,
  runningFragment,
};
