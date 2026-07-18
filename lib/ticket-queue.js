'use strict';

// Electron-free helpers for bounded-concurrency, claim-safe, per-ticket-isolated
// builds (TASK-004). Before this ticket the orchestration contract mandated
// "exactly one ticket in flight". That single-flight rule existed to keep ticket
// files and git working-tree state consistent. This module lets the orchestrator
// (an LLM following .claude/skills/orchestrate/SKILL.md — never a subagent) run
// more than one build at once WITHOUT those consistency guarantees breaking:
//
//   - a bounded concurrency limit caps how many agents run at once (extras wait),
//   - an atomic per-ticket "claim" ensures no two agents pick up the same ticket,
//   - per-ticket git isolation (a branch/worktree derived from the ticket id)
//     keeps parallel builds from clobbering each other's working tree.
//
// Like lib/ticket-history.js and lib/ticket-accounting.js this file deliberately
// requires nothing from Electron so it can be unit-tested with plain
// `node --test`. Every function is pure: it computes a decision or a NEW
// frontmatter object and never touches disk, git, or the network. Atomicity in
// practice comes from the board contract's whole-file writes: a claim is written
// as a single serializeTicket() write of the whole ticket, so a concurrent poll
// never sees a half-claimed file (the board's keep-last-good-parse absorbs it).
//
// Claim model
// -----------
// The claim lives in the ticket's own flat frontmatter as an `agent` field (the
// claiming agent's id) alongside `status`. serializeTicket keeps `id, title,
// status, created, updated` leading and preserves any extra key, so `agent`
// round-trips without disturbing the known ordering or the user-owned
// `## Additional Context`. Claiming is a compare-and-set against the FRESHLY
// read frontmatter: a ticket is claimable only when it is in a claimable status
// (`todo` / `failed-testing`) and not already claimed by a different, still-
// active agent. Because each build only ever writes its OWN ticket file, one
// build can never overwrite another ticket's file or the board's shared state.

// Statuses that mean an agent is actively working the ticket right now. Kept in
// lockstep with renderer/renderer.js's TASKS_ACTIVE_STATUSES (~5018) — the board
// derives its "being worked on" dot from the same set, so multiple tickets in
// these states render as concurrently-worked cards.
const ACTIVE_STATUSES = ['in-progress', 'testing'];

// Statuses a queued/idle ticket can be picked up from. `todo` is fresh work;
// `failed-testing` is a ticket handed back for another fix attempt.
const CLAIMABLE_STATUSES = ['todo', 'failed-testing'];

// How many agents may build at once by default, and the hard ceiling we clamp
// any caller-supplied limit to. The default is deliberately small: builds share
// one repo, so isolation (branch/worktree per ticket) plus a modest bound keeps
// git contention low while still parallelising the common case.
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

const LEADING_KEYS = ['id', 'title', 'status', 'created', 'updated'];

function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

// Parse a ticket's persisted `order`/`priority` frontmatter field (TASK-007) into
// a finite number, or null when it is absent/blank/non-numeric. The user-defined
// `todo` order is stored per ticket as this numeric field so a chosen order sticks
// across board polls and app restarts. `order` is the canonical key; `priority` is
// accepted as an alias so either spelling round-trips.
function ticketOrderValue(fm) {
  const src = fm && fm.fm ? fm.fm : fm;
  if (!src) return null;
  const raw = src.order != null ? src.order : src.priority;
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Numeric-aware id comparison (TASK-005 -> TASK-010 ordering, not lexical).
function compareTicketId(a, b) {
  const ida = String((a && a.fm ? a.fm : a || {}).id || '');
  const idb = String((b && b.fm ? b.fm : b || {}).id || '');
  return ida.localeCompare(idb, undefined, { numeric: true });
}

// Stable, deterministic comparator for pick-next / todo ordering (TASK-007).
// Prefers the persisted `order` field, then falls back to numeric `id` order so
// tickets without an explicit order never jump between polls:
//   - both carry an order  -> lower order first (tie broken by id),
//   - only one carries one -> the ordered ticket sorts first,
//   - neither carries one  -> numeric id order (the pre-TASK-007 behaviour).
function compareTicketOrder(a, b) {
  const oa = ticketOrderValue(a);
  const ob = ticketOrderValue(b);
  if (oa !== null && ob !== null) {
    if (oa !== ob) return oa - ob;
    return compareTicketId(a, b);
  }
  if (oa !== null) return -1;
  if (ob !== null) return 1;
  return compareTicketId(a, b);
}

function isClaimable(status) {
  return CLAIMABLE_STATUSES.includes(status);
}

// Clamp a caller-supplied concurrency to a sane integer in [1, MAX_CONCURRENCY],
// falling back to DEFAULT_CONCURRENCY when the input is missing or junk. Never
// returns 0 (that would stall the queue) or a huge number (that would thrash the
// shared repo).
function resolveConcurrency(input) {
  if (input == null || input === '') return DEFAULT_CONCURRENCY;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return floored;
}

// Return a shallow copy of `fm` with keys ordered: LEADING_KEYS (those present,
// in that order) first, then every other key in insertion order — matching
// serializeTicket / lib/ticket-accounting.js's orderFm so the on-disk layout
// stays stable.
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

// True when `fm` is currently claimed by `agentId`.
function isClaimedBy(fm, agentId) {
  const owner = fm && fm.agent != null ? String(fm.agent).trim() : '';
  return owner !== '' && owner === String(agentId).trim();
}

// True when `fm` is claimed by SOME agent (any non-empty `agent` field).
function isClaimed(fm) {
  return !!(fm && fm.agent != null && String(fm.agent).trim() !== '');
}

// The count of tickets an agent is actively working right now, from a list of
// ticket frontmatter objects. This is the number that must stay under the
// concurrency bound before another ticket may be claimed.
function activeCount(tickets) {
  if (!Array.isArray(tickets)) return 0;
  let n = 0;
  for (const t of tickets) {
    const fm = t && t.fm ? t.fm : t;
    if (fm && isActive(fm.status)) n++;
  }
  return n;
}

// Compare-and-set claim of a single ticket for `agentId`. PURE: returns
// { ok, fm, reason } and never writes — the caller performs the whole-file
// serializeTicket write when ok is true. Grants the claim (setting
// `status: in-progress`, `agent: agentId`, bumping `updated`, preserving
// `created`) only when:
//   - the ticket is in a claimable status (todo / failed-testing), AND
//   - it is not already claimed by a DIFFERENT agent that is still active.
// A ticket already claimed by THIS agent is treated as a safe re-entry (ok).
// This is what guarantees "at most one agent per ticket": two agents reading the
// same todo ticket both compute ok, but whoever writes first stamps `agent`; the
// loser re-reads the fresh file (now agent=other, status=in-progress) and
// claimTicket returns ok:false, reason 'claimed'.
function claimTicket(fm, agentId, opts) {
  const o = opts || {};
  const id = agentId == null ? '' : String(agentId).trim();
  if (!id) return { ok: false, fm: orderFm(fm), reason: 'no-agent-id' };
  const src = fm && typeof fm === 'object' ? fm : {};
  const status = src.status;

  if (isClaimed(src) && !isClaimedBy(src, id)) {
    // Someone else owns it. Only steal if their claim is stale AND they are no
    // longer active (e.g. crashed mid-build leaving a dangling active status is
    // NOT stealable here — dangling claims are released explicitly).
    return { ok: false, fm: orderFm(src), reason: 'claimed' };
  }
  if (!isClaimedBy(src, id) && !isClaimable(status)) {
    // Not ours and not in a pickup-able lane (already in-progress/testing/done).
    return { ok: false, fm: orderFm(src), reason: 'not-claimable' };
  }

  const out = orderFm(src);
  out.status = 'in-progress';
  out.agent = id;
  const now = o.at instanceof Date ? o.at.toISOString()
    : (typeof o.at === 'string' && o.at.trim() ? o.at.trim() : new Date().toISOString());
  out.updated = now;
  if (out.created == null || String(out.created).trim() === '') out.created = now;
  return { ok: true, fm: out, reason: 'claimed' };
}

// Release a ticket's claim by removing the `agent` field. Returns a new fm with
// `updated` bumped. Used when a build reaches a terminal state (done /
// failed-testing) or to clear a dangling claim so the ticket can be re-picked.
function releaseTicket(fm, opts) {
  const o = opts || {};
  const out = orderFm(fm);
  delete out.agent;
  out.updated = o.at instanceof Date ? o.at.toISOString()
    : (typeof o.at === 'string' && o.at.trim() ? o.at.trim() : new Date().toISOString());
  return out;
}

// Decide which tickets to dispatch next without exceeding the concurrency bound.
// PURE: returns an array of the claimable tickets (oldest `id` first) that fit in
// the remaining slots — it does NOT claim them; the caller then claimTicket()s
// each in turn, re-reading before each write. Inputs:
//   tickets  array of { file?, fm } (or bare fm) — the current board snapshot.
//   opts.limit    concurrency bound (resolved via resolveConcurrency).
//   opts.agentId  optional; a ticket already claimed by this agent still counts
//                 as claimable re-entry but never double-counts a slot.
// Tickets already claimed by a DIFFERENT agent, or in a non-claimable status,
// are skipped. The number returned is max(0, limit - activeCount).
function selectNextBatch(tickets, opts) {
  const o = opts || {};
  const limit = resolveConcurrency(o.limit);
  const list = Array.isArray(tickets) ? tickets : [];
  const running = activeCount(list);
  let slots = limit - running;
  if (slots <= 0) return [];

  const claimable = list.filter((t) => {
    const fm = t && t.fm ? t.fm : t;
    if (!fm) return false;
    if (isClaimedBy(fm, o.agentId)) return isClaimable(fm.status) || isActive(fm.status);
    if (isClaimed(fm)) return false;                 // owned by someone else
    return isClaimable(fm.status);
  });

  // Honour the user-defined `todo` order (TASK-007): sort by the persisted
  // `order` field, falling back to numeric `id` for tickets without one. This
  // stays backward compatible — with no `order` fields anywhere it is exactly the
  // old oldest-`id`-first behaviour — so the top-of-lane ticket runs next.
  claimable.sort(compareTicketOrder);

  return claimable.slice(0, slots);
}

// ── Per-ticket git isolation ────────────────────────────────────────────────
// Concrete, deterministic names so each concurrent build works on its own branch
// / worktree instead of the shared working tree. Deriving both from the ticket
// id guarantees two builds never collide and a build always maps back to exactly
// one ticket. These are pure string builders; the orchestrator runs the actual
// `git worktree add` / branch commands.

// Normalise a ticket id into a git-ref-safe slug (lowercase alnum + dashes).
function idSlug(id) {
  const s = String(id == null ? '' : id)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'ticket';
}

// Isolation branch name for a ticket, e.g. TASK-004 -> "orchestrate/task-004".
function ticketBranchName(id) {
  return `orchestrate/${idSlug(id)}`;
}

// Isolation worktree directory for a ticket under a base dir. Uses forward
// slashes; callers on Windows can pass the result to git, which accepts them.
function ticketWorktreeDir(baseDir, id) {
  const base = String(baseDir == null ? '.worktrees' : baseDir).replace(/[\\/]+$/, '');
  return `${base}/${idSlug(id)}`;
}

module.exports = {
  ACTIVE_STATUSES,
  CLAIMABLE_STATUSES,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  isActive,
  isClaimable,
  isClaimed,
  isClaimedBy,
  resolveConcurrency,
  orderFm,
  ticketOrderValue,
  compareTicketId,
  compareTicketOrder,
  activeCount,
  claimTicket,
  releaseTicket,
  selectNextBatch,
  idSlug,
  ticketBranchName,
  ticketWorktreeDir,
};
