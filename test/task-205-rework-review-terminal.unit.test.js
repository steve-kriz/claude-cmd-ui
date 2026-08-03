'use strict';

// ===========================================================================
// TASK-205 — UNIT tests for SKILL.md's rework/fix-loop, review reject-and-
// rework verdicts, follow-ups, and the terminal `done` transition under the
// column-driven model.
//
// Unit-level coverage of the pure decision helpers this behaviour is built on
// (mirroring test/task-204-column-dispatch.unit.test.js's own pattern), plus
// narrow, single-fact assertions pinning specific required phrases/structure
// in the document itself (SKILL.md is an instruction document with no
// executable "rework loop" to call — the document's own prose is the testable
// surface for anything not backed by a real lib function).
//
// NO DATABASE, NO REAL DB CONNECTION, NO NETWORK. Every input here is either a
// real pure lib function call (no disk I/O) or an in-memory fixture; the only
// real disk reads are the two shipped SKILL.md files themselves (read-only).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AGENT_TYPES } = require('../lib/orchestrate-agents');
const { CLAIMABLE_STATUSES } = require('../lib/ticket-queue');
const { LANE_STATUSES, VALID_STATUSES, laneForStatus, FAILED_STATUS } = require('../lib/ticket-lanes');

const ROOT = path.join(__dirname, '..');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
const skillProjectSrc = readFileLF(PROJECT_SKILL);
const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const SKILL_COPIES = [['.claude', skillProjectSrc], ['assets', skillAssetsSrc]];

// ---------------------------------------------------------------------------
// Local pure decision helpers — same models as
// test/task-205-rework-review-terminal.e2e.test.js, unit-tested directly here.
// ---------------------------------------------------------------------------

function makeColumn(status, agent, { system = true, instructions = 'do the work' } = {}) {
  return { status, label: status, description: '', agent, instructions, system };
}

function findPrecedingBuildColumn(columns, fromIdx) {
  for (let i = fromIdx - 1; i >= 0; i--) {
    if (columns[i].status === 'in-progress' || columns[i].buildColumn) return columns[i];
  }
  return null;
}

function testingFixLoopOutcome(attemptNumber, cap = 3) {
  if (attemptNumber < cap) return { action: 'dispatch-and-retry', park: false };
  return { action: 'park-and-ask', park: true };
}

function rejectReworkOutcome(cycleNumber, cap = 3) {
  return testingFixLoopOutcome(cycleNumber, cap);
}

function parseReworkTargetOverride(instructions) {
  const m = /rework-target:\s*([a-z0-9-]+)/i.exec(instructions || '');
  return m ? m[1] : null;
}

function resolveReworkTarget(reviewColumn, columns) {
  const idx = columns.findIndex((c) => c.status === reviewColumn.status);
  const overrideSlug = parseReworkTargetOverride(reviewColumn.instructions);
  if (overrideSlug) {
    const target = columns.find((c) => c.status === overrideSlug);
    if (target) return { column: target, misconfigured: false };
    return { column: findPrecedingBuildColumn(columns, idx), misconfigured: true };
  }
  return { column: findPrecedingBuildColumn(columns, idx), misconfigured: false };
}

function resolveReviewVerdict(finding) {
  if (finding.rejectVerdict) return 'reject-and-rework';
  if (finding.severity === 'critical' || finding.severity === 'high-security') return 'follow-up';
  return 'none';
}

function nextTaskIds(existingIds, count = 1) {
  let max = 0;
  for (const entry of existingIds || []) {
    const m = /TASK-0*(\d+)/i.exec(String(entry));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const ids = [];
  for (let k = 1; k <= count; k++) ids.push(`TASK-${String(max + k).padStart(3, '0')}`);
  return ids;
}

// ===========================================================================
// Testing fix loop — cap mechanics
// ===========================================================================

test('unit: testingFixLoopOutcome dispatches-and-retries for attempts 1 and 2, parks on attempt 3', () => {
  assert.equal(testingFixLoopOutcome(1).action, 'dispatch-and-retry');
  assert.equal(testingFixLoopOutcome(2).action, 'dispatch-and-retry');
  assert.equal(testingFixLoopOutcome(3).action, 'park-and-ask');
  assert.equal(testingFixLoopOutcome(3).park, true);
});

test('unit: testingFixLoopOutcome never proposes a 4th dispatch — a park stays parked', () => {
  for (const n of [3, 4, 5, 100]) {
    assert.equal(testingFixLoopOutcome(n).action, 'park-and-ask');
  }
});

test('unit: rejectReworkOutcome mirrors testingFixLoopOutcome exactly (same cap, same shape)', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.deepEqual(rejectReworkOutcome(n), testingFixLoopOutcome(n));
  }
});

test('unit: failed-testing stays claimable and folds into the testing lane', () => {
  assert.ok(CLAIMABLE_STATUSES.includes(FAILED_STATUS));
  assert.equal(laneForStatus(FAILED_STATUS), 'testing');
  assert.ok(!LANE_STATUSES.includes(FAILED_STATUS), 'failed-testing has no dedicated lane');
  assert.ok(VALID_STATUSES.includes(FAILED_STATUS), 'failed-testing remains a valid status');
});

// ===========================================================================
// Nearest preceding build column — forward/backward walk mechanics
// ===========================================================================

test('unit: findPrecedingBuildColumn finds the in-progress column walking backward from testing', () => {
  const columns = [
    makeColumn('todo', null),
    makeColumn('defining', 'orchestrate-ba'),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('done', null),
  ];
  const idx = columns.findIndex((c) => c.status === 'testing');
  const build = findPrecedingBuildColumn(columns, idx);
  assert.equal(build.status, 'in-progress');
  assert.equal(build.agent, AGENT_TYPES.coder);
});

test('unit: findPrecedingBuildColumn walks past a review column to the build column behind it', () => {
  const columns = [
    makeColumn('todo', null),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('pr-review', 'orchestrate-tech-lead', { system: false }),
    makeColumn('done', null),
  ];
  const idx = columns.findIndex((c) => c.status === 'pr-review');
  const build = findPrecedingBuildColumn(columns, idx);
  assert.equal(build.status, 'in-progress');
});

test('unit (edge): findPrecedingBuildColumn returns null when no build column precedes it', () => {
  const columns = [makeColumn('todo', null), makeColumn('testing', 'orchestrate-tester'), makeColumn('done', null)];
  const idx = columns.findIndex((c) => c.status === 'testing');
  assert.equal(findPrecedingBuildColumn(columns, idx), null);
});

// ===========================================================================
// Rework-target override parsing / resolution
// ===========================================================================

test('unit: parseReworkTargetOverride extracts a "rework-target: <slug>" free-text directive', () => {
  assert.equal(parseReworkTargetOverride('reject verdict; rework-target: in-progress'), 'in-progress');
  assert.equal(parseReworkTargetOverride('Rework-Target:   custom-fix  '), 'custom-fix');
  assert.equal(parseReworkTargetOverride('no override here'), null);
  assert.equal(parseReworkTargetOverride(''), null);
  assert.equal(parseReworkTargetOverride(null), null);
  assert.equal(parseReworkTargetOverride(undefined), null);
});

test('unit: resolveReworkTarget uses the nearest preceding build column when no override is named', () => {
  const columns = [
    makeColumn('todo', null),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('pr-review', 'orchestrate-tech-lead', { system: false, instructions: 'review it' }),
    makeColumn('done', null),
  ];
  const review = columns.find((c) => c.status === 'pr-review');
  const result = resolveReworkTarget(review, columns);
  assert.equal(result.column.status, 'in-progress');
  assert.equal(result.misconfigured, false);
});

test('unit: resolveReworkTarget honours an instructions-named override column when it exists', () => {
  const columns = [
    makeColumn('todo', null),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('custom-fix', 'orchestrate-coder', { system: false, buildColumn: true }),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('pr-review', 'orchestrate-tech-lead', { system: false, instructions: 'rework-target: custom-fix' }),
    makeColumn('done', null),
  ];
  const review = columns.find((c) => c.status === 'pr-review');
  const result = resolveReworkTarget(review, columns);
  assert.equal(result.column.status, 'custom-fix');
  assert.equal(result.misconfigured, false);
});

test('unit (edge): resolveReworkTarget falls back to the nearest preceding build column and reports a misconfiguration when the named target does not exist', () => {
  const columns = [
    makeColumn('todo', null),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('pr-review', 'orchestrate-tech-lead', { system: false, instructions: 'rework-target: does-not-exist' }),
    makeColumn('done', null),
  ];
  const review = columns.find((c) => c.status === 'pr-review');
  const result = resolveReworkTarget(review, columns);
  assert.equal(result.column.status, 'in-progress');
  assert.equal(result.misconfigured, true);
});

// ===========================================================================
// Review verdict resolution — exactly one of three outcomes
// ===========================================================================

test('unit: resolveReviewVerdict returns reject-and-rework whenever the explicit reject verdict is set, regardless of severity', () => {
  assert.equal(resolveReviewVerdict({ severity: 'critical', rejectVerdict: true }), 'reject-and-rework');
  assert.equal(resolveReviewVerdict({ severity: 'medium', rejectVerdict: true }), 'reject-and-rework');
  assert.equal(resolveReviewVerdict({ severity: 'nit', rejectVerdict: true }), 'reject-and-rework');
});

test('unit: resolveReviewVerdict returns follow-up for a non-blocking critical/high-security finding', () => {
  assert.equal(resolveReviewVerdict({ severity: 'critical', rejectVerdict: false }), 'follow-up');
  assert.equal(resolveReviewVerdict({ severity: 'high-security', rejectVerdict: false }), 'follow-up');
});

test('unit (edge): resolveReviewVerdict returns none for medium/low/nit findings with no reject verdict', () => {
  for (const severity of ['medium', 'low', 'nit']) {
    assert.equal(resolveReviewVerdict({ severity, rejectVerdict: false }), 'none');
  }
});

test('unit: severity alone never triggers reject-and-rework — only the explicit reject verdict does', () => {
  // A critical finding WITHOUT a reject verdict is follow-up, not reject.
  assert.notEqual(resolveReviewVerdict({ severity: 'critical', rejectVerdict: false }), 'reject-and-rework');
});

// ===========================================================================
// Follow-up ticket id sequencing — true max, never reuse/gap
// ===========================================================================

test('unit: nextTaskIds continues from the true maximum id across all status subfolders', () => {
  const existing = [
    'tasks/done/TASK-017-a.md',
    'tasks/testing/TASK-018-b.md',
    'tasks/todo/TASK-019-c.md',
    'tasks/failed-testing/TASK-005-old.md',
  ];
  assert.deepEqual(nextTaskIds(existing, 1), ['TASK-020']);
  assert.deepEqual(nextTaskIds(existing, 2), ['TASK-020', 'TASK-021']);
});

test('unit (edge): nextTaskIds starts sanely from an empty/no-match list and never throws', () => {
  assert.deepEqual(nextTaskIds([], 1), ['TASK-001']);
  assert.deepEqual(nextTaskIds(['not-a-ticket.md'], 1), ['TASK-001']);
  assert.deepEqual(nextTaskIds(undefined, 1), ['TASK-001']);
});

// ===========================================================================
// SKILL.md — narrow, single-fact document-content assertions
// ===========================================================================

test('unit: SKILL.md has a dedicated "Rework, review verdicts, and reaching done" section', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /^##\s+Rework, review verdicts, and reaching done\s*$/m,
      `${label}/SKILL.md has the rework/review/done section heading`);
  }
});

test('unit: the testing fix loop names the 3-attempt cap and its ownership by the testing column\'s rework rule', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /cap this fix loop at\s*\*{0,2}3 attempts\*{0,2} per ticket/i,
      `${label}: 3-attempt cap named`);
    assert.match(src, /not a hardcoded\s*\r?\n?\s*"?phase 3"?/i, `${label}: not framed as "Phase 3"`);
    assert.match(src, /SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS\.testing/,
      `${label}: cross-references the testing column's default instructions`);
  }
});

test('unit: reject-and-rework is documented with the exact same 3-cycle cap, tracked the same way as the testing cap', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /cap this reject-and-rework cycle at\s*\*{0,2}3 attempts\*{0,2} per ticket/i,
      `${label}: reject-and-rework cap named`);
    assert.match(src, /mirroring[\s\S]{0,20}the testing fix-loop cap exactly/i,
      `${label}: explicitly mirrors the testing cap`);
    assert.match(src, /a per-ticket\s*\r?\n?\s*attempt count read from the ticket'?s own\s*`?runs`?\/`?activities`?\s+history/i,
      `${label}: attempt count sourced from runs/activities history, no new field invented`);
  }
});

test('unit: a review column\'s two verdicts are named and mutually exclusive in the document\'s framing', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /\*{0,2}\(a\)\*{0,2}\s*Reject-and-rework \(blocking\)/i, `${label}: verdict (a) named`);
    assert.match(src, /\*{0,2}\(b\)\*{0,2}\s*Follow-up only \(non-blocking\)/i, `${label}: verdict (b) named`);
    assert.match(src, /resolves to\s*\*{0,2}exactly one\*{0,2}\s+of\s*\r?\n?\s*two\s*\r?\n?\s*verdicts\s*—\s*never both, never neither/i,
      `${label}: exactly-one-of-two framing stated`);
  }
});

test('unit: the follow-up path names review-of + Impact If Not Fixed and states the reviewed ticket is untouched', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /`?review-of:\s*<reviewed ticket id>`?/i, `${label}: review-of key documented`);
    assert.match(src, /##\s*Impact If Not Fixed/i, `${label}: Impact If Not Fixed section documented`);
    assert.match(src, /true\s*\*{0,2}maximum\*{0,2}\s+id found across all status subfolders/i,
      `${label}: true-maximum id rule documented`);
    assert.match(src, /never\s+reusing an existing id and never\s*\r?\n?\s*skipping\s*\r?\n?\s*ahead of the real maximum/i,
      `${label}: never reuse/skip the id sequence`);
  }
});

test('unit: SKILL.md states a review column\'s instructions may override the rework target, defaulting to the nearest preceding build column', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /unless\s*\*{0,2}\s*the review column'?s\s*`?instructions`?\s+name a\s*\r?\n?\s*specific rework-target column/i,
      `${label}: instructions-named override documented`);
    assert.match(src, /if an\s*\r?\n?\s*instructions-named target does not exist[\s\S]{0,80}fall\s*\r?\n?\s*back to the nearest preceding build column and report the\s*\r?\n?\s*misconfiguration/i,
      `${label}: fallback + misconfiguration report documented`);
    assert.match(src, /absent\s*\r?\n?\s*an override, the default target is always the nearest preceding build\s*\r?\n?\s*column/i,
      `${label}: default target documented`);
  }
});

test('unit: SKILL.md states the terminal done transition and its preconditions', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /^###\s+Reaching done \(terminal\)\s*$/m, `${label}: terminal section heading present`);
    assert.match(src, /clears its\s*\*{0,2}last agent-bearing column\*{0,2}[\s\S]{0,40}with\s*\*{0,2}no pending rejection\*{0,2}/i,
      `${label}: preconditions for done stated`);
    assert.match(src, /sets its\s*`?status`?\s+to\s*\r?\n?\s*\*{0,2}`?done`?\*{0,2}\s+directly/i, `${label}: done set directly`);
    assert.match(src, /`?done`?\s+is terminal regardless of any follow-up tickets/i, `${label}: terminal regardless of follow-ups`);
  }
});

test('unit: SKILL.md never reintroduces a post-processing status/lane/kind anywhere', () => {
  for (const [label, src] of SKILL_COPIES) {
    // Every remaining mention of "post-processing" in the document is part of
    // an explicit NEGATIVE statement that the concept is gone/removed —
    // never a positive instruction to dispatch, route, or check one. Collapse
    // whitespace first so a mention that wraps across a markdown line break
    // is not spuriously severed from its "removed"/"no"/"never" context.
    const flat = src.replace(/\s+/g, ' ');
    const mentions = flat.match(/.{0,80}post-processing.{0,160}/gi) || [];
    assert.ok(mentions.length > 0, `${label}: at least one post-processing mention (all negative)`);
    for (const m of mentions) {
      assert.match(m, /\bno\b|removed|drops|never|not being redesigned/i,
        `${label}: every post-processing mention is negative/removal framing: "${m}"`);
    }
    assert.ok(!/##\s*Post-processing/i.test(src), `${label}: no "## Post-processing" heading`);
    const kindMentions = flat.match(/.{0,120}kind:\s*post-processing.{0,40}/gi) || [];
    for (const m of kindMentions) {
      assert.match(m, /\bno\b|removed|drops|never/i,
        `${label}: every "kind: post-processing" mention sits in negative/removal framing: "${m}"`);
    }
  }
});

test('unit: SKILL.md states no status outside the enum is introduced and the backward move reuses existing statuses', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /no status outside the enum/i, `${label}: no-status-outside-enum invariant stated`);
    assert.match(src, /backward rework move reuses existing statuses[\s\S]{0,20}it never invents a new one/i,
      `${label}: backward move reuses existing statuses, never invents one`);
  }
});

test('unit: SKILL.md states every transition in this section is whole-file, preserves created, bumps updated, and appends activities', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /is a\s*\r?\n?\s*whole-file atomic write/i, `${label}: whole-file atomic write stated`);
    assert.match(src, /`?created`?\s+is preserved, `?updated`?\s+is bumped/i, `${label}: created preserved, updated bumped`);
    assert.match(src, /per-activity cost log \(`?activities`?\) is appended per dispatch/i,
      `${label}: activities cost-log append retained`);
  }
});

test('unit: both SKILL.md copies remain byte-identical (drift guard)', () => {
  assert.ok(fs.readFileSync(PROJECT_SKILL).equals(fs.readFileSync(ASSETS_SKILL)));
});

test('unit (edge): SKILL.md has no leftover "## Phase <n>" heading anywhere (full removal confirmed)', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.ok(!/^##\s+Phase\s+\d/m.test(src), `${label}/SKILL.md has no "## Phase <n>" heading`);
    // "the tech-lead phase" legitimately appears ONCE, negated ("Neither is
    // hardcoded to ... 'the tech-lead phase'") — assert the NEGATIVE framing,
    // not that the phrase never appears at all.
    const flat = src.replace(/\s+/g, ' ');
    const mentions = flat.match(/.{0,60}tech-lead phase.{0,10}/gi) || [];
    for (const m of mentions) {
      assert.match(m, /neither is hardcoded to/i, `${label}/SKILL.md: "tech-lead phase" only appears negated: "${m}"`);
    }
    assert.ok(!/skill\.phases/i.test(src), `${label}/SKILL.md never references a "skill.phases" construct`);
  }
});
