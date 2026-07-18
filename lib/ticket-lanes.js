'use strict';

// Lane/status logic for the Tasks board (TASK-006). Pure and Electron-free so it
// can be unit-tested with `node --test`, mirroring lib/ticket-history.js,
// lib/ticket-accounting.js, lib/ticket-queue.js and lib/ticket-questions.js. The
// renderer (a browser script that cannot require Node modules) duplicates the
// tiny constants/predicates it needs, matching how TASK-003/005 handled the
// browser side.
//
// The board flow, left-to-right:
//   todo → defining → in-progress → testing → failed-testing → done
// - todo:           freshly created tickets awaiting work (where new tickets
//                   are first created).
// - defining:       the business-analyst agent is defining the task (writing
//                   acceptance criteria and Gherkin).
// - in-progress:    a coder agent is implementing the ticket.
// - testing:        tests are being created/checked.
// - failed-testing: the ticket's tests failed — its card shows a red "failed"
//                   marker and the flow goes on to fix it.
// - done:           complete.

// The ordered, canonical status enum. Board lanes render in this exact
// left-to-right order.
const LANE_STATUSES = ['todo', 'defining', 'in-progress', 'testing', 'failed-testing', 'done'];

// Statuses that mean an agent is actively working the ticket right now (the BA
// while defining, the coder while in-progress, the tester while testing). Cards
// in one of these states show the blue "being worked on" dot; idle states
// (todo / done / failed-testing) show no active dot.
const ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];

// The status whose tests have failed — its card shows a red "failed" marker.
const FAILED_STATUS = 'failed-testing';

// Where out-of-enum tickets are routed on the board (a dedicated lane / clearly
// marked card) instead of being silently dumped into `todo`.
const UNKNOWN_STATUS = 'unknown';

// True when `status` is one of the six canonical enum values.
function isKnownStatus(status) {
  return LANE_STATUSES.includes(status);
}

// True when an agent is actively working a ticket in this status.
function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

// True when the ticket's tests have failed (drives the red "failed" marker).
function isFailedStatus(status) {
  return status === FAILED_STATUS;
}

// Resolve the board lane a ticket status belongs to: the status itself when it
// is a known enum value, else the dedicated UNKNOWN_STATUS lane. Never returns
// `todo` for an unrecognized status — that would silently hide bad data.
function laneForStatus(status) {
  return isKnownStatus(status) ? status : UNKNOWN_STATUS;
}

module.exports = {
  LANE_STATUSES,
  ACTIVE_STATUSES,
  FAILED_STATUS,
  UNKNOWN_STATUS,
  isKnownStatus,
  isActiveStatus,
  isFailedStatus,
  laneForStatus,
};
