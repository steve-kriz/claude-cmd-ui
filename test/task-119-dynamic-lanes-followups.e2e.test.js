'use strict';

// ===========================================================================
// TASK-119 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: TASK-101 review follow-ups on the dynamic Tasks board.
//   F2 — the configured-agent lane badge must NOT flash a spurious "unknown agent"
//        warning when the agent set is UNKNOWN (null: .claude/agents/ absent,
//        unreadable, or not-yet-loaded); it warns (`.missing`) ONLY when the set is
//        a CONFIRMED enumeration (a Set — even an empty one) that lacks the agent.
//   F3 — deleting tasks/team-config.json mid-session must REVERT the board to the
//        six default lanes on the next poll (a CONFIRMED not-found), while a
//        transient present-but-unreadable read error must KEEP the last-good config.
//
// Each scenario drives the REAL shipped renderer functions
//   pollTasksOnce(tab, force)  — reads team-config.json + probes fs.exists to
//                                distinguish delete/absent from transient error
//   buildTasksLaneEl / renderTasksBoard — build lanes + badges
// via test/helpers/task-101-lane-harness.js, which brace-extracts the real
// renderer/renderer.js declarations and runs them against a minimal in-memory mock
// DOM + a stubbed window.api.fs whose `exists` STUB is what these follow-ups turn
// on.
//
// EVERY database / filesystem / Electron call is MOCKED — window.api.fs (including
// fs.exists) is an in-memory stub, the DOM is a plain object tree; NO real DB /
// disk / network is touched. The board is driven end to end as the app drives it.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/task-101-lane-harness');

const {
  loadLaneModule, makeWindow, makeDocument, makeTab,
  laneStatuses, findByClass, findAllByClass,
} = H;

const CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

const SYSTEM_ORDER = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];
const DEFAULT_LANES = [...SYSTEM_ORDER, 'unknown'];

// The lane element for a data-status, or undefined.
function lane(tab, status) {
  return findAllByClass(tab.els.tasksBoard, 'tasks-lane').find((el) => el.dataset.status === status);
}
// The agent badge inside a lane, or null.
function badge(tab, status) {
  const ln = lane(tab, status);
  return ln ? findByClass(ln, 'tasks-lane-agent') : null;
}

// Standard folder layout used by the poll.
const FOLDER = 'C:\\proj';
const TASKS_DIR = FOLDER + '\\tasks';
const CFG_PATH = TASKS_DIR + '\\team-config.json';
const AGENTS_DIR = FOLDER + '\\.claude\\agents';

// ===========================================================================
// F2 — agent-badge tri-state (no false "unknown agent" warning)
// ===========================================================================

// ---------------------------------------------------------------------------
// Scenario: a configured agent badge is NEUTRAL when the agent set is unknown
//   Given team-config.json declares a ux-review lane assigned agent "reviewer"
//     And the .claude/agents/ directory does NOT exist (confirmed absent)
//   When the board polls
//   Then the agent set is left UNKNOWN (null)
//     And the reviewer badge renders WITHOUT the .missing warning (neutral)
// ---------------------------------------------------------------------------
test('Scenario (F2): a configured badge is NEUTRAL when the agents dir is absent (agentNames unknown → not .missing)', async () => {
  // Given a valid config naming an agent, and NO .claude/agents/ directory. The
  // exists stub returns { ok:true, exists:false } for the absent agents dir (it is
  // in neither `files` nor `dirs`), so the poll leaves the agent set UNKNOWN (null).
  const goodCfg = JSON.stringify({ columns: [{ status: 'ux-review', label: 'UX', agent: 'reviewer' }] });
  const { window } = makeWindow({
    files: { [CFG_PATH]: goodCfg },
    dirs: { [TASKS_DIR]: [] }, // tickets scan succeeds (empty); agents dir absent
  });
  const mod = loadLaneModule(window, makeDocument(), console);
  const tab = makeTab({ folder: FOLDER });

  // When the board polls
  await assert.doesNotReject(() => mod.pollTasksOnce(tab, true));

  // Then the agent set stays UNKNOWN (the absent dir is not a confirmed empty Set)
  assert.equal(tab.tasks.agentNames, null,
    'a confirmed-absent .claude/agents/ leaves the agent set UNKNOWN (null), not an empty Set');
  // And the ux-review lane rendered with the reviewer badge...
  const b = badge(tab, 'ux-review');
  assert.ok(b, 'the ux-review lane rendered its configured agent badge');
  assert.equal(b.textContent, 'reviewer');
  // ... which is NEUTRAL — NOT the spurious .missing warning (this is the F2 bug fix).
  assert.ok(!b.classList.contains('missing'),
    'an UNKNOWN agent set must NOT falsely warn a correctly-configured agent badge');
});

// ---------------------------------------------------------------------------
// Scenario: a configured agent badge is NEUTRAL before the first poll loads agents
//   Given a rendered board whose agent set has never been loaded (null)
//   Then the configured badge is neutral (not-yet-loaded is not confirmed-absent)
// ---------------------------------------------------------------------------
test('Scenario (F2): a configured badge is NEUTRAL when the agent set is not-yet-loaded (render before poll)', () => {
  // Given a board rendered from config before any poll populated the agent set.
  const config = { columns: [{ status: 'ux-review', label: 'UX', agent: 'reviewer' }] };
  const { window } = makeWindow();
  const mod = loadLaneModule(window, makeDocument(), console);
  const tab = makeTab({ folder: FOLDER, config, agentNames: null });

  // When the board renders (no poll yet → agentNames still null)
  mod.renderTasksBoard(tab);

  // Then the badge is neutral (not-yet-loaded must not warn).
  const b = badge(tab, 'ux-review');
  assert.ok(b && !b.classList.contains('missing'),
    'not-yet-loaded (null) is UNKNOWN, not confirmed-absent → neutral badge');
});

// ---------------------------------------------------------------------------
// Scenario: a configured agent badge warns (.missing) ONLY when a confirmed set lacks it
//   Given team-config.json declares a "ghost" lane and a "ba" lane
//     And .claude/agents/ exists and contains only ba.md and coder.md
//   When the board polls
//   Then the agent set is a CONFIRMED Set {ba, coder}
//     And the ghost badge is .missing (confirmed-and-absent)
//     And the ba badge is neutral (confirmed-present)
// ---------------------------------------------------------------------------
test('Scenario (F2): .missing appears ONLY for a confirmed Set that lacks the agent; a present agent stays neutral', async () => {
  // Given a config with a ghost lane and a ba lane, and a present agents dir that
  // enumerates ba.md + coder.md (the exists stub reports the dir present because it
  // is in `dirs`; findByExt then returns its files).
  const goodCfg = JSON.stringify({
    columns: [
      { status: 'ghost-lane', label: 'Ghost', agent: 'ghost' },
      { status: 'ba-lane', label: 'BA', agent: 'ba' },
    ],
  });
  const { window } = makeWindow({
    files: { [CFG_PATH]: goodCfg },
    dirs: {
      [TASKS_DIR]: [],
      [AGENTS_DIR]: [AGENTS_DIR + '\\ba.md', AGENTS_DIR + '\\coder.md'],
    },
  });
  const mod = loadLaneModule(window, makeDocument(), console);
  const tab = makeTab({ folder: FOLDER });

  // When the board polls
  await assert.doesNotReject(() => mod.pollTasksOnce(tab, true));

  // Then the agent set is a CONFIRMED Set enumerated from the dir.
  assert.ok(tab.tasks.agentNames instanceof Set, 'a present dir yields a CONFIRMED Set');
  assert.deepEqual([...tab.tasks.agentNames].sort(), ['ba', 'coder']);
  // And the ghost badge carries the .missing warning (confirmed absent).
  const ghost = badge(tab, 'ghost-lane');
  assert.ok(ghost && ghost.classList.contains('missing'),
    'an agent absent from a CONFIRMED set is warned .missing');
  // And the ba badge is neutral (confirmed present).
  const ba = badge(tab, 'ba-lane');
  assert.ok(ba && !ba.classList.contains('missing'), 'an agent present in the set is neutral');
  // And the CSS still paints .missing red.
  assert.match(CSS, /\.tasks-lane-agent\.missing\s*\{[^}]*#f14c4c/i);
});

// ---------------------------------------------------------------------------
// Scenario (edge): a confirmed-EMPTY agents dir warns a configured agent
//   Given .claude/agents/ exists but is empty
//   When the board polls
//   Then the agent set is a confirmed empty Set → the configured badge is .missing
// ---------------------------------------------------------------------------
test('Scenario (F2 edge): a confirmed-EMPTY agents dir (empty Set) warns the configured agent .missing', async () => {
  // Given a present-but-empty .claude/agents/ (dir present, findByExt returns []).
  const goodCfg = JSON.stringify({ columns: [{ status: 'ux-review', label: 'UX', agent: 'reviewer' }] });
  const { window } = makeWindow({
    files: { [CFG_PATH]: goodCfg },
    dirs: { [TASKS_DIR]: [], [AGENTS_DIR]: [] },
  });
  const mod = loadLaneModule(window, makeDocument(), console);
  const tab = makeTab({ folder: FOLDER });

  // When the board polls
  await mod.pollTasksOnce(tab, true);

  // Then the agent set is a CONFIRMED empty Set (not null)...
  assert.ok(tab.tasks.agentNames instanceof Set && tab.tasks.agentNames.size === 0,
    'a present-but-empty agents dir is a CONFIRMED empty enumeration');
  // ... so the configured reviewer badge IS warned .missing (genuinely absent).
  const b = badge(tab, 'ux-review');
  assert.ok(b && b.classList.contains('missing'),
    'a confirmed empty Set means the configured agent is genuinely missing → warn');
});

// ===========================================================================
// F3 — config-delete reverts to defaults; transient read error keeps last-good
// ===========================================================================

// ---------------------------------------------------------------------------
// Scenario: a valid config renders its lanes, a transient read error keeps them,
//           and a confirmed delete reverts to the six default lanes
//   Given team-config.json declares a ux-review lane and the board polled it
//   When a later poll cannot read the config but it is CONFIRMED present
//     Then the last-good config is kept (ux-review lane survives)
//   When a later poll cannot read the config and it is CONFIRMED absent (deleted)
//     Then the board reverts to the six default lanes (ux-review lane gone)
// ---------------------------------------------------------------------------
test('Scenario (F3): valid config renders its lanes; transient read error keeps last-good; a confirmed delete reverts to defaults', async () => {
  // Given a valid team-config.json with a ux-review user lane.
  const goodCfg = JSON.stringify({ columns: [{ status: 'ux-review', label: 'UX Review' }] });
  const { window, files, existsMap } = makeWindow({
    files: { [CFG_PATH]: goodCfg },
    dirs: { [TASKS_DIR]: [] },
  });
  const mod = loadLaneModule(window, makeDocument(), console);
  const tab = makeTab({ folder: FOLDER });

  // When the board polls, the valid config is adopted and its ux-review lane renders.
  await mod.pollTasksOnce(tab, true);
  assert.deepEqual(tab.tasks.config, { columns: [{ status: 'ux-review', label: 'UX Review' }] },
    'the valid config is adopted');
  // The config declares ONLY the ux-review user column (no preceding system column),
  // so it anchors to the FRONT of the board, ahead of todo.
  assert.deepEqual(laneStatuses(tab),
    ['ux-review', 'todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done', 'unknown'],
    'the ux-review lane renders from the good config (anchored to the front)');

  // When a later poll cannot READ the config, but exists confirms it is STILL PRESENT
  // (a transient present-but-unreadable error: mid-rewrite / permission blip).
  files.delete(CFG_PATH); // readFile now fails ({ ok:false })
  existsMap.set(CFG_PATH, { ok: true, exists: true, isFile: true }); // but exists says present
  await assert.doesNotReject(() => mod.pollTasksOnce(tab, true));
  // Then the last-good config is KEPT — the board does not flicker to defaults.
  assert.deepEqual(tab.tasks.config, { columns: [{ status: 'ux-review', label: 'UX Review' }] },
    'a transient present-but-unreadable read keeps the last-good config');
  assert.ok(lane(tab, 'ux-review'), 'the ux-review lane survives a transient read error');

  // When a later poll cannot read the config AND exists confirms it is GONE (deleted).
  existsMap.set(CFG_PATH, { ok: true, exists: false }); // confirmed not-found
  await assert.doesNotReject(() => mod.pollTasksOnce(tab, true));
  // Then the board REVERTS to the six default lanes (F3 fix).
  assert.equal(tab.tasks.config, null,
    'a CONFIRMED delete reverts config to null (the six default lanes)');
  assert.deepEqual(laneStatuses(tab), DEFAULT_LANES,
    'deleting team-config.json returns the board to the six default lanes');
  assert.ok(!lane(tab, 'ux-review'), 'the removed ux-review lane is gone after the confirmed delete');
});

// ---------------------------------------------------------------------------
// Scenario (edge): an out-of-root / failed existence probe keeps last-good
//   Given a good config was adopted
//   When a later poll cannot read the config and the exists probe itself FAILS
//        (ok:false — e.g. an out-of-root path)
//   Then the last-good config is kept (only a CONFIRMED not-found reverts)
// ---------------------------------------------------------------------------
test('Scenario (F3 edge): a failed/out-of-root existence probe (ok:false) keeps last-good, does NOT revert', async () => {
  const goodCfg = JSON.stringify({ columns: [{ status: 'ux-review', label: 'UX Review' }] });
  const { window, files, existsMap } = makeWindow({
    files: { [CFG_PATH]: goodCfg },
    dirs: { [TASKS_DIR]: [] },
  });
  const mod = loadLaneModule(window, makeDocument(), console);
  const tab = makeTab({ folder: FOLDER });
  await mod.pollTasksOnce(tab, true);
  assert.ok(lane(tab, 'ux-review'), 'the ux-review lane rendered from the good config');

  // When the read fails and the exists probe ALSO fails (ok:false — cannot confirm).
  files.delete(CFG_PATH);
  existsMap.set(CFG_PATH, { ok: false, error: 'EACCES' });
  await assert.doesNotReject(() => mod.pollTasksOnce(tab, true));

  // Then the last-good config is kept — an inconclusive probe never reverts to defaults.
  assert.deepEqual(tab.tasks.config, { columns: [{ status: 'ux-review', label: 'UX Review' }] },
    'an inconclusive (ok:false) existence probe keeps the last-good config');
  assert.ok(lane(tab, 'ux-review'), 'the ux-review lane survives an inconclusive probe');
});
