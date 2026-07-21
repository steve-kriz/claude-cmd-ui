'use strict';

// Folder-per-status layout logic for the Tasks board (TASK-008). Pure and
// Electron-free so it can be unit-tested with `node --test`, mirroring
// lib/ticket-lanes.js, lib/ticket-queue.js, lib/ticket-questions.js, etc. The
// renderer (a browser script that cannot require Node modules) duplicates the
// tiny predicates it needs, matching how TASK-003/005/006/007 handled the browser
// side.
//
// Each valid status (LANE_STATUSES plus failed-testing — see VALID_STATUSES in
// lib/ticket-lanes.js) owns a subfolder under tasks/ named exactly for the
// status (tasks/todo, tasks/post-processing, tasks/failed-testing, …).
// The folder a ticket .md file lives in should reflect its frontmatter status, but
// frontmatter status is the single source of truth: when the two disagree the file
// is reconciled (moved) to the folder matching its status. Out-of-enum ("unknown")
// statuses own no folder — those tickets are left where they are and never filed
// into a status subfolder, so bad data is never hidden by a silent relocation.

const { isKnownStatus, isKnownStatusFor } = require('./ticket-lanes');

// Subfolder name (relative to tasks/) a ticket with this status belongs in, or
// null when the status is not a canonical enum value (unknown tickets are left in
// place, never filed into a status subfolder).
function folderForStatus(status) {
  return isKnownStatus(status) ? status : null;
}

// True when the folder a file currently sits in (relative to tasks/, '' = top
// level) already matches the folder its frontmatter status calls for. Always
// false for unknown statuses (they own no folder).
function folderMatchesStatus(folder, status) {
  const target = folderForStatus(status);
  return target != null && (folder || '') === target;
}

// Decide whether a file needs relocating and to where, given the folder it sits in
// (relative to tasks/, '' = top level) and its frontmatter status. Returns
// { needsMove, targetFolder }; targetFolder is null for unknown statuses (leave the
// file where it is).
function reconcileFolder(currentFolder, status) {
  const target = folderForStatus(status);
  if (target == null) return { needsMove: false, targetFolder: null };
  return { needsMove: (currentFolder || '') !== target, targetFolder: target };
}

// Dedupe discovered ticket descriptors by frontmatter id so a ticket that (e.g.
// mid legacy-migration, or after a collided move) exists in two folders appears
// exactly once. Prefers the copy whose folder already matches its frontmatter
// status; otherwise keeps the first seen. Each entry is { id, status, folder, ... }
// and the original object is returned unchanged.
//
// Config-aware (TASK-099) but backwards compatible: the folder-match test is
// evaluated with the entry's own `columns` (when present) via
// folderMatchesStatusWith, so a USER-status ticket (e.g. status "ux-review"
// declared by that board's columns) prefers its folder-matching copy exactly
// like a system-status one. Entries WITHOUT a `columns` field degrade to the
// fixed system-only behaviour (folderMatchesStatusWith with no columns is
// byte-identical to folderMatchesStatus), so all existing callers/tests are
// unchanged.
function dedupeByFolder(entries) {
  const byId = new Map();
  for (const e of entries || []) {
    const id = e && e.id;
    if (id == null) continue;
    if (!byId.has(id)) { byId.set(id, e); continue; }
    const cur = byId.get(id);
    if (folderMatchesStatusWith(e.folder, e.status, e.columns) &&
        !folderMatchesStatusWith(cur.folder, cur.status, cur.columns)) {
      byId.set(id, e);
    }
  }
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// Config-aware variants (TASK-099)
//
// The four functions above encode the FIXED folder layout and stay
// byte-compatible forever (test/ticket-folders.test.js depends on them). The
// `*With` variants below layer the dynamic-status engine on top WITHOUT
// changing any of that: they take the same `columns` array that
// lib/ticket-lanes.js's config-aware helpers use (the normalised `columns` from
// lib/team-config.js: each `{ status, label, ..., system }`) and treat every
// user column as owning its own tasks/<slug>/ folder, exactly like a system
// status.
//
// Migration policy (per the design): slugs are IMMUTABLE, so a rename is
// label-only and never moves files; a removed column is config-only — its
// files stay put and route to `unknown` (never relocated, never hidden). These
// helpers only decide folder ownership/target; the on-demand mkdir + relocate
// happens in the caller (renderer). Every function tolerates null/[]/malformed
// `columns` and NEVER throws: junk input yields the fixed system-only
// behaviour. A slug that collides with a system status always resolves as the
// SYSTEM status (isKnownStatusFor in lib/ticket-lanes.js guarantees this).
//
// PATH-TRAVERSAL HARDENING (TASK-109): these helpers return `status` verbatim as
// a tasks/<slug>/ folder name, so an un-normalised / tampered columns entry with
// a slug like "../../evil" would otherwise become a traversal target. Defence is
// enforced upstream, once, in lib/ticket-lanes.js userStatusSetFor, which now
// admits a user slug only when it is filesystem-safe (isFsSafeSlug: string,
// 1..30, /^[a-z0-9-]+$/). Because folderForStatusWith gates on isKnownStatusFor,
// an unsafe slug is never "known" here → folderForStatusWith returns null,
// folderMatchesStatusWith is false, and reconcileFolderWith yields
// { needsMove:false, targetFolder:null } (the file is left in place, never
// relocated outside tasks/). No logic in THIS file changes.

// Subfolder name (relative to tasks/) a ticket with this status belongs in,
// given `columns`, or null when the status is neither a system/valid status nor
// a user column slug (unknown tickets are left in place). With null/junk
// `columns` this is exactly folderForStatus.
function folderForStatusWith(status, columns) {
  return isKnownStatusFor(status, columns) ? status : null;
}

// True when the folder a file currently sits in (relative to tasks/, '' = top
// level) matches the folder its status calls for under `columns`. Always false
// for statuses that own no folder. With null/junk `columns` this is exactly
// folderMatchesStatus.
function folderMatchesStatusWith(folder, status, columns) {
  const target = folderForStatusWith(status, columns);
  return target != null && (folder || '') === target;
}

// Decide whether a file needs relocating and to where, given the folder it sits
// in (relative to tasks/, '' = top level), its status, and `columns`. Returns
// { needsMove, targetFolder }; targetFolder is null for statuses owning no
// folder (leave the file where it is — this is also how a REMOVED user column
// degrades: once its slug is gone from `columns` the status is unknown, so its
// files are never relocated). With null/junk `columns` this is exactly
// reconcileFolder.
function reconcileFolderWith(currentFolder, status, columns) {
  const target = folderForStatusWith(status, columns);
  if (target == null) return { needsMove: false, targetFolder: null };
  return { needsMove: (currentFolder || '') !== target, targetFolder: target };
}

module.exports = {
  folderForStatus,
  folderMatchesStatus,
  reconcileFolder,
  dedupeByFolder,
  folderForStatusWith,
  folderMatchesStatusWith,
  reconcileFolderWith,
};
