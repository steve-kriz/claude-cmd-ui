'use strict';

// Lane/status logic for the Tasks board (TASK-006). Pure and Electron-free so it
// can be unit-tested with `node --test`, mirroring lib/ticket-history.js,
// lib/ticket-accounting.js, lib/ticket-queue.js and lib/ticket-questions.js. The
// renderer (a browser script that cannot require Node modules) duplicates the
// tiny constants/predicates it needs, matching how TASK-003/005 handled the
// browser side.
//
// The board flow, left-to-right (TASK-028):
//   todo → defining → in-progress → testing → post-processing → done
// - todo:            freshly created tickets awaiting work (where new tickets
//                    are first created).
// - defining:        the business-analyst agent is defining the task (writing
//                    acceptance criteria and Gherkin).
// - in-progress:     a coder agent is implementing the ticket.
// - testing:         tests are being created/checked.
// - post-processing: holds post-processing tickets (kind: post-processing) —
//                    "final events" the user wants run against every normal task
//                    after tests pass but before it is marked done. These are
//                    NOT built/tested/claimed by the swarm.
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
const LANE_STATUSES = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];

// The full set of valid, persistable statuses: every lane status PLUS
// `failed-testing`, which remains a real status (claimable by the fix loop, owns
// its own tasks/failed-testing/ folder) even though it has no dedicated lane.
const VALID_STATUSES = [...LANE_STATUSES, 'failed-testing'];

// Statuses that mean an agent is actively working the ticket right now (the BA
// while defining, the coder while in-progress, the tester while testing). Cards
// in one of these states show the blue "being worked on" dot; idle states
// (todo / done / failed-testing / post-processing) show no active dot.
const ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];

// The status whose tests have failed — its card shows a red "failed" marker
// (folded into the Testing lane).
const FAILED_STATUS = 'failed-testing';

// The post-processing status/lane and the matching ticket `kind` (TASK-028).
const POST_PROCESSING_STATUS = 'post-processing';
const POST_PROCESSING_KIND = 'post-processing';

// Where out-of-enum tickets are routed on the board (a dedicated lane / clearly
// marked card) instead of being silently dumped into `todo`.
const UNKNOWN_STATUS = 'unknown';

// True when `status` is one of the valid, persistable enum values (every lane
// status plus failed-testing). Both failed-testing and post-processing are
// "known" here, so neither is ever routed to the unknown lane or filed nowhere.
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

// True when `fm` is a post-processing ticket (kind: post-processing). These are
// excluded from the build swarm entirely (never claimed/built/tested).
function isPostProcessingTicket(fm) {
  const src = fm && fm.fm ? fm.fm : fm;
  return !!src && src.kind === POST_PROCESSING_KIND;
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

module.exports = {
  LANE_STATUSES,
  VALID_STATUSES,
  ACTIVE_STATUSES,
  FAILED_STATUS,
  POST_PROCESSING_STATUS,
  POST_PROCESSING_KIND,
  UNKNOWN_STATUS,
  isKnownStatus,
  isActiveStatus,
  isFailedStatus,
  isPostProcessingTicket,
  laneForStatus,
};
