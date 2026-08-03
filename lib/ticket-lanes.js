'use strict';

// Lane/status logic for the Tasks board (TASK-006). Pure and Electron-free so it
// can be unit-tested with `node --test`, mirroring lib/ticket-history.js,
// lib/ticket-accounting.js, lib/ticket-queue.js and lib/ticket-questions.js. The
// renderer (a browser script that cannot require Node modules) duplicates the
// tiny constants/predicates it needs, matching how TASK-003/005 handled the
// browser side.
//
// The board flow, left-to-right (TASK-206, removing the post-processing lane
// TASK-028 added):
//   todo → defining → in-progress → testing → done
// - todo:            freshly created tickets awaiting work (where new tickets
//                    are first created).
// - defining:        the business-analyst agent is defining the task (writing
//                    acceptance criteria and Gherkin).
// - in-progress:     a coder agent is implementing the ticket.
// - testing:         tests are being created/checked.
// - done:            complete.
//
// `failed-testing` is still a valid, claimable status (the orchestrate fix loop
// hands a ticket back to it for another attempt), but it no longer has its own
// board lane: its cards fold into the Testing lane and keep their red "failed"
// marker. Only the dedicated lane was removed — the status and its
// tasks/failed-testing/ folder are preserved.

// The ordered, canonical LANE enum. Board lanes render in this exact
// left-to-right order. `failed-testing` is deliberately NOT here — it is a valid
// status without its own lane (see VALID_STATUSES).
const LANE_STATUSES = ['todo', 'defining', 'in-progress', 'testing', 'done'];

// The full set of valid, persistable statuses: every lane status PLUS
// `failed-testing`, which remains a real status (claimable by the fix loop, owns
// its own tasks/failed-testing/ folder) even though it has no dedicated lane.
const VALID_STATUSES = [...LANE_STATUSES, 'failed-testing'];

// Statuses that mean an agent is actively working the ticket right now (the BA
// while defining, the coder while in-progress, the tester while testing). Cards
// in one of these states show the blue "being worked on" dot; idle states
// (todo / done / failed-testing) show no active dot.
const ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];

// The status whose tests have failed — its card shows a red "failed" marker
// (folded into the Testing lane).
const FAILED_STATUS = 'failed-testing';

// Where out-of-enum tickets are routed on the board (a dedicated lane / clearly
// marked card) instead of being silently dumped into `todo`.
const UNKNOWN_STATUS = 'unknown';

// True when `status` is one of the valid, persistable enum values (every lane
// status plus failed-testing). failed-testing is "known" here even though it
// has no dedicated lane, so it is never routed to the unknown lane or filed
// nowhere.
function isKnownStatus(status) {
  return VALID_STATUSES.includes(status);
}

// True when an agent is actively working a ticket in this status.
function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

// True when the ticket's tests have failed (drives the red "failed" marker).
function isFailedStatus(status) {
  return status === FAILED_STATUS;
}

// Resolve the board lane a ticket status belongs to. `failed-testing` has no
// dedicated lane, so it folds into `testing` (keeping its red marker there);
// every other lane status maps to its own lane; any out-of-enum status maps to
// the dedicated UNKNOWN_STATUS lane. Never returns `todo` for an unrecognized
// status — that would silently hide bad data, and it must never dump failed
// cards into `todo`.
function laneForStatus(status) {
  if (status === FAILED_STATUS) return 'testing';
  return LANE_STATUSES.includes(status) ? status : UNKNOWN_STATUS;
}

// ---------------------------------------------------------------------------
// Config-aware variants (TASK-098)
//
// The functions above encode the FIXED board and stay byte-compatible forever
// (dozens of tests + the SKILL.md contract depend on them). The `*For` variants
// below layer the dynamic-status engine on top WITHOUT changing any of that:
// they take a `columns` array (the normalised `columns` from lib/team-config.js:
// each `{ status, label, ..., system }`) and treat every user column
// (`system !== true`) as an extra lane whose status is its own slug.
//
// These are deliberately self-contained (they do NOT require lib/team-config.js
// — that module already requires THIS one, so importing it back would be a
// cycle). Every function tolerates null/[]/malformed `columns` and NEVER throws:
// junk input simply yields the fixed system-only behaviour. When a column's slug
// collides with a system/valid status (impossible after team-config normalises,
// but guarded here anyway) the resolver always prefers the SYSTEM meaning — such
// a slug is never treated as a user status.
//
// LOCKSTEP RULE (TASK-109): a user column slug must also be filesystem-safe
// (isFsSafeSlug below) before it may own a tasks/<slug>/ folder or a lane. This
// is defence-in-depth at the lib/filesystem boundary against an un-normalised /
// tampered team-config.json slug (e.g. "../../evil") reaching folderForStatusWith
// as a path-traversal string. The rule is byte-equivalent to team-config's
// isValidUserSlug (SLUG_RE `/^[a-z0-9-]+$/`, MAX_SLUG_LENGTH 30) and to renderer
// isSafeTasksSlug — but is redefined locally here to avoid the require cycle.
// KEEP ALL THREE IN LOCKSTEP: lib/team-config.js isValidUserSlug,
// renderer/renderer.js isSafeTasksSlug, and lib/ticket-lanes.js isFsSafeSlug.

// Coerce any input into an array of plain column objects. Non-arrays and
// non-object entries are dropped, so the callers below degrade gracefully.
function toColumnArray(columns) {
  if (!Array.isArray(columns)) return [];
  return columns.filter((c) => !!c && typeof c === 'object' && !Array.isArray(c));
}

// The trimmed `status` slug of a column, or '' when it has none.
function columnSlug(col) {
  return typeof col.status === 'string' ? col.status.trim() : '';
}

// Max length of a user slug, and the slug character class. Kept byte-equivalent
// to lib/team-config.js MAX_SLUG_LENGTH/SLUG_RE (see the LOCKSTEP RULE note
// above; we cannot require team-config here — it requires this module).
const FS_MAX_SLUG_LENGTH = 30;
const FS_SLUG_RE = /^[a-z0-9-]+$/;

// True iff `slug` is a filesystem-safe user slug: a string of 1..30 chars
// matching `/^[a-z0-9-]+$/`. That character class inherently excludes `.`, `..`,
// `/`, `\` and `:`, so a slug can never encode a path-traversal / absolute path.
// Byte-equivalent to team-config isValidUserSlug and renderer isSafeTasksSlug.
// The typeof guard runs BEFORE any regex test so hostile non-strings (null,
// undefined, numbers, Symbols, objects) return false and NEVER throw.
function isFsSafeSlug(slug) {
  return typeof slug === 'string'
    && slug.length > 0
    && slug.length <= FS_MAX_SLUG_LENGTH
    && FS_SLUG_RE.test(slug);
}

// The task-modal's archive-marker pseudo-status (a column with this slug maps to
// status:done + resolution:wont-do, NOT a real lane). It is a RESERVED slug and
// must never be admitted as a user status. Kept in LOCKSTEP with the other two
// reserved-slug lists: lib/team-config.js RESERVED_SLUGS
// (`new Set([...VALID_STATUSES, 'unknown', '__wont-do__'])`) and
// renderer/renderer.js TASKS_RESERVED_SLUGS. We cannot require team-config here
// (it requires this module — cycle), so the constant is redefined locally.
const WONT_DO_SLUG = '__wont-do__';

// The set of valid USER lane slugs declared by `columns`: a non-empty slug on a
// column that is not `system: true`, is filesystem-safe (isFsSafeSlug — TASK-109
// hardening), and does not collide with a system/valid status, the `unknown`
// routing key, or the `__wont-do__` archive-marker pseudo-status (system/reserved
// meaning always wins). An unsafe slug (e.g. "../../evil") never enters the set,
// so it owns no folder and no lane downstream.
function userStatusSetFor(columns) {
  const set = new Set();
  for (const col of toColumnArray(columns)) {
    if (col.system === true) continue;
    const slug = columnSlug(col);
    if (slug === '') continue;
    if (!isFsSafeSlug(slug)) continue;
    if (VALID_STATUSES.includes(slug) || slug === UNKNOWN_STATUS) continue;
    // Explicit reserved-slug parity with team-config RESERVED_SLUGS / renderer
    // TASKS_RESERVED_SLUGS. `__wont-do__` is already dropped incidentally by
    // isFsSafeSlug (underscores fail FS_SLUG_RE), but this guard documents intent
    // and survives any future relaxation of the slug regex. Do NOT remove.
    if (slug === WONT_DO_SLUG) continue;
    set.add(slug);
  }
  return set;
}

// True when `status` is a user-defined column status in `columns` (never a
// system/valid status — those are always resolved as system statuses).
function isUserStatus(status, columns) {
  return userStatusSetFor(columns).has(status);
}

// True when `status` is a known status for this config: any fixed system/valid
// status (isKnownStatus) OR a user column slug declared in `columns`.
function isKnownStatusFor(status, columns) {
  return isKnownStatus(status) || isUserStatus(status, columns);
}

// Resolve the board lane for `status` given `columns`. Layered on laneForStatus:
// `failed-testing` still folds into `testing`; every system lane status maps to
// its own lane; a user column status gets its OWN lane (its slug); anything else
// routes to UNKNOWN_STATUS — never silently to `todo`.
function laneForStatusFor(status, columns) {
  if (status === FAILED_STATUS) return 'testing';
  if (LANE_STATUSES.includes(status)) return status;
  if (isUserStatus(status, columns)) return status;
  return UNKNOWN_STATUS;
}

// The ordered lane slugs for a board built from `columns`: the five fixed system
// lanes in canonical LANE_STATUSES order, with each user column inserted at the
// position it holds in `columns` (anchored to the last system column that
// precedes it, mirroring lib/team-config.js's own column ordering; a user column
// before any system column sorts ahead of `todo`). For the default config (only
// the system columns) this is exactly LANE_STATUSES, and null/junk `columns`
// degrade to LANE_STATUSES as well. `failed-testing` is never a lane here.
function laneStatusesFor(columns) {
  const cols = toColumnArray(columns);
  const userSlugs = userStatusSetFor(cols);

  // Anchor each user slug to the last system slug seen before it (null = before
  // the first system column). First occurrence of a slug wins.
  const anchored = [];
  const taken = new Set();
  let lastSystem = null;
  for (const col of cols) {
    const slug = columnSlug(col);
    if (LANE_STATUSES.includes(slug)) {
      lastSystem = slug;
      continue;
    }
    if (userSlugs.has(slug) && !taken.has(slug)) {
      taken.add(slug);
      anchored.push({ anchor: lastSystem, slug });
    }
  }

  const out = [];
  const appendAnchored = (anchor) => {
    for (const a of anchored) if (a.anchor === anchor) out.push(a.slug);
  };
  appendAnchored(null);
  for (const slug of LANE_STATUSES) {
    out.push(slug);
    appendAnchored(slug);
  }
  return out;
}

module.exports = {
  LANE_STATUSES,
  VALID_STATUSES,
  ACTIVE_STATUSES,
  FAILED_STATUS,
  UNKNOWN_STATUS,
  isKnownStatus,
  isActiveStatus,
  isFailedStatus,
  laneForStatus,
  laneStatusesFor,
  isKnownStatusFor,
  laneForStatusFor,
  isUserStatus,
  isFsSafeSlug,
};
