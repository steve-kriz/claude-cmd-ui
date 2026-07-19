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

const { isKnownStatus } = require('./ticket-lanes');

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
function dedupeByFolder(entries) {
  const byId = new Map();
  for (const e of entries || []) {
    const id = e && e.id;
    if (id == null) continue;
    if (!byId.has(id)) { byId.set(id, e); continue; }
    const cur = byId.get(id);
    if (folderMatchesStatus(e.folder, e.status) && !folderMatchesStatus(cur.folder, cur.status)) {
      byId.set(id, e);
    }
  }
  return Array.from(byId.values());
}

module.exports = {
  folderForStatus,
  folderMatchesStatus,
  reconcileFolder,
  dedupeByFolder,
};
