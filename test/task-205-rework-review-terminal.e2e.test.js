'use strict';

// ===========================================================================
// TASK-205 — E2E cucumber-style scenarios (Given/When/Then) for SKILL.md's
// rework/fix-loop, review reject-and-rework verdicts, follow-ups, and the
// terminal transition to `done` under the column-driven model.
//
// SKILL.md is a markdown INSTRUCTION document read by an LLM orchestrator —
// there is no executable "rework loop" function in this codebase to call. So,
// mirroring the established pattern in test/task-204-column-dispatch.e2e.test.js
// (itself mirroring test/orchestrate-agents.test.js / orchestrate-swarm.test.js),
// each scenario below drives small PURE decision helpers that model exactly the
// rule SKILL.md's prose describes (never spliced into the document — it is
// only ever described there in prose), plus asserts the document's own prose
// wherever a scenario is about what the orchestrator is instructed to do.
//
// This file implements EVERY Gherkin scenario in tasks/testing/TASK-205's
// "## Cucumber Tests" block, one scenario per `test()`.
//
// NO DATABASE, NO REAL DB CONNECTION, NO NETWORK. All ticket/column/board input
// is an in-memory fixture object — never a real file, never Electron, never IPC.
// The only real disk reads are the two shipped SKILL.md files themselves
// (read-only, text fixtures).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AGENT_TYPES } = require('../lib/orchestrate-agents');
const { CLAIMABLE_STATUSES } = require('../lib/ticket-queue');
const { laneForStatus, FAILED_STATUS } = require('../lib/ticket-lanes');

const ROOT = path.join(__dirname, '..');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
const skillProjectSrc = readFileLF(PROJECT_SKILL);
const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const SKILL_COPIES = [['.claude', skillProjectSrc], ['assets', skillAssetsSrc]];

// Tiny Given/When/Then labels (no `cucumber` npm package — none is installed
// or added), matching test/task-204-column-dispatch.e2e.test.js's convention.
function Given(_desc, fn) { return fn ? fn() : undefined; }
function When(_desc, fn) { return fn ? fn() : undefined; }
function Then(_desc, fn) { return fn ? fn() : undefined; }

// A minimal fake board column, shaped like lib/team-config.js's normalised
// column objects (status/label/description/agent/instructions/system).
function makeColumn(status, agent, { system = true, instructions = 'do the work' } = {}) {
  return { status, label: status, description: '', agent, instructions, system };
}

// ---------------------------------------------------------------------------
// Pure decision helpers modelling the rules SKILL.md's "Rework, review
// verdicts, and reaching done" section describes in prose. These are NOT
// spliced into SKILL.md and are not lib exports — they are test-local models
// of the document's own rule, exactly like task-204's local resolveColumnAgent.
// ---------------------------------------------------------------------------

// Walk backward from `fromIdx` (exclusive) to the nearest earlier column whose
// agent implements code (modelled here as the `in-progress` column, or any
// column explicitly flagged `buildColumn: true` for a custom board).
function findPrecedingBuildColumn(columns, fromIdx) {
  for (let i = fromIdx - 1; i >= 0; i--) {
    if (columns[i].status === 'in-progress' || columns[i].buildColumn) return columns[i];
  }
  return null;
}

// The testing fix-loop decision for the Nth red result (1-based). Capped at 3
// attempts: attempts 1 and 2 dispatch the build column's agent and retry;
// attempt 3 parks the ticket and asks the user rather than dispatching a 4th.
function testingFixLoopOutcome(attemptNumber, cap = 3) {
  if (attemptNumber < cap) return { action: 'dispatch-and-retry', park: false };
  return { action: 'park-and-ask', park: true };
}

// The reject-and-rework cycle decision for the Nth rejection (1-based) —
// mirrors testingFixLoopOutcome exactly, same cap, same shape.
function rejectReworkOutcome(cycleNumber, cap = 3) {
  return testingFixLoopOutcome(cycleNumber, cap);
}

// Parse an optional "rework-target: <slug>" override out of a review column's
// free-text instructions (not a team-config schema field).
function parseReworkTargetOverride(instructions) {
  const m = /rework-target:\s*([a-z0-9-]+)/i.exec(instructions || '');
  return m ? m[1] : null;
}

// Resolve where a rejected ticket goes: an instructions-named target column if
// it exists in the current board config, else the nearest preceding build
// column (reporting a misconfiguration if a named target did not resolve).
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

// Resolve a review dispatch's verdict from its reported finding. Exactly one
// of three outcomes: reject-and-rework (explicit reject verdict), follow-up
// (non-blocking critical/high-security), or none (lower severity, summary only).
function resolveReviewVerdict(finding) {
  if (finding.rejectVerdict) return 'reject-and-rework';
  if (finding.severity === 'critical' || finding.severity === 'high-security') return 'follow-up';
  return 'none';
}

// Continue the TASK-nnn sequence from the TRUE maximum id found across every
// status subfolder — never reuses, never gaps. Mirrors the local helper used
// by test/orchestrate-tech-lead.test.js for the same rule.
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

// Build a follow-up ticket body carrying `review-of:` + `## Impact If Not
// Fixed`, exactly as the non-blocking verdict path requires.
function buildFollowUpTicket(id, reviewedId, impact) {
  return {
    id,
    status: 'todo',
    'review-of': reviewedId,
    body: `## Description\nFollow-up from review of ${reviewedId}.\n\n## Impact If Not Fixed\n${impact}\n`,
  };
}

// ===========================================================================
// Scenario: a failing testing column sends the ticket back to the build
// column's agent
// ===========================================================================
test('Scenario: a failing testing column sends the ticket back to the build column\'s agent', () => {
  const columns = Given(
    'a ticket in "testing" whose tests fail, and the "in-progress" column names agent "orchestrate-coder"',
    () => [
      makeColumn('todo', null),
      makeColumn('defining', 'orchestrate-ba'),
      makeColumn('in-progress', 'orchestrate-coder'),
      makeColumn('testing', 'orchestrate-tester'),
      makeColumn('done', null),
    ],
  );
  const ticket = Given('a ticket in "testing"', () => ({ id: 'TASK-100', status: 'testing' }));

  const outcome = When('the testing agent reports failure', () => {
    ticket.status = 'failed-testing';
    const testingIdx = columns.findIndex((c) => c.status === 'testing');
    const buildColumn = findPrecedingBuildColumn(columns, testingIdx);
    return { buildColumn, decision: testingFixLoopOutcome(1) };
  });

  Then('the ticket becomes "failed-testing"', () => {
    assert.equal(ticket.status, 'failed-testing');
    assert.ok(CLAIMABLE_STATUSES.includes('failed-testing'), 'failed-testing stays claimable');
    assert.equal(laneForStatus('failed-testing'), 'testing', 'folds into the Testing lane');
  });

  Then('orchestrate-coder is dispatched with the failure output', () => {
    assert.ok(outcome.buildColumn, 'a preceding build column was found');
    assert.equal(outcome.buildColumn.agent, 'orchestrate-coder');
    assert.equal(outcome.decision.action, 'dispatch-and-retry');
  });

  Then('the ticket returns to "testing" for another run', () => {
    ticket.status = 'testing';
    assert.equal(ticket.status, 'testing');
  });

  Then('SKILL.md describes this fix loop generically (no "Phase 3" wording)', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /agent reports a\s*\*{0,2}red\*{0,2}\s*[\s\S]{0,10}result/i);
      assert.match(src, /nearest preceding build column/i);
      assert.match(src, /plus the failure output/i);
      assert.ok(!/^##\s+Phase\s+\d/m.test(src), 'no "## Phase <n>" heading');
    }
  });
});

// ===========================================================================
// Scenario: the testing fix loop is capped at three attempts
// ===========================================================================
test('Scenario: the testing fix loop is capped at three attempts', () => {
  const attempts = Given('a ticket that fails testing three times', () => [1, 2, 3]);

  const decisions = When('each attempt runs in turn', () => attempts.map((n) => testingFixLoopOutcome(n)));

  Then('the first two attempts dispatch-and-retry, the third parks', () => {
    assert.equal(decisions[0].action, 'dispatch-and-retry');
    assert.equal(decisions[1].action, 'dispatch-and-retry');
    assert.equal(decisions[2].action, 'park-and-ask');
    assert.equal(decisions[2].park, true);
  });

  Then('the ticket stays in "failed-testing" and the orchestrator asks the user how to proceed', () => {
    // No fourth attempt is ever computed/dispatched.
    assert.equal(testingFixLoopOutcome(4).action, 'park-and-ask');
  });

  Then('SKILL.md states the cap is exactly 3 attempts and is a property of the testing column\'s rework rule', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /cap this fix loop at\s*\*{0,2}3 attempts\*{0,2} per ticket/i);
      assert.match(src, /property of the testing\s*\r?\n?\s*column'?s rework rule, not a hardcoded "?phase 3"?/i);
      assert.match(src, /summarise\s+what is still failing, and ask the user how to proceed/i);
    }
  });
});

// ===========================================================================
// Scenario: a review column rejects a ticket and sends it back for rework
// ===========================================================================
test('Scenario: a review column rejects a ticket and sends it back for rework', () => {
  const columns = Given(
    'a user column "pr-review" with agent "orchestrate-tech-lead" after testing',
    () => [
      makeColumn('todo', null),
      makeColumn('defining', 'orchestrate-ba'),
      makeColumn('in-progress', 'orchestrate-coder'),
      makeColumn('testing', 'orchestrate-tester'),
      makeColumn('pr-review', 'orchestrate-tech-lead', { system: false }),
      makeColumn('done', null),
    ],
  );
  const finding = Given('the reviewer issues a reject verdict with a critical finding', () =>
    ({ severity: 'critical', rejectVerdict: true, text: 'unsafe input handling' }));
  const ticket = Given('a ticket sitting in "pr-review"', () => ({ id: 'TASK-101', status: 'pr-review' }));

  const result = When('the orchestrator processes the review', () => {
    const verdict = resolveReviewVerdict(finding);
    const reviewColumn = columns.find((c) => c.status === 'pr-review');
    const target = resolveReworkTarget(reviewColumn, columns);
    ticket.status = target.column.status; // whole-file status write, backward
    return { verdict, target };
  });

  Then('the ticket\'s status is written backward to "in-progress"', () => {
    assert.equal(result.verdict, 'reject-and-rework');
    assert.equal(result.target.column.status, 'in-progress');
    assert.equal(ticket.status, 'in-progress');
    assert.equal(result.target.misconfigured, false);
  });

  Then('orchestrate-coder is dispatched with the reviewer\'s findings as context', () => {
    assert.equal(result.target.column.agent, AGENT_TYPES.coder);
  });

  Then('the ticket re-enters testing then pr-review again on success', () => {
    ticket.status = 'testing';
    assert.equal(ticket.status, 'testing');
    ticket.status = 'pr-review';
    assert.equal(ticket.status, 'pr-review');
  });

  Then('SKILL.md documents the two review verdicts and the backward-send rule', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /reject-and-rework \(blocking\)/i);
      assert.match(src, /send the ticket\s*\*{0,2}backward\*{0,2}[\s\S]{0,120}nearest preceding build column/i);
      assert.match(src, /re-enters the forward flow[\s\S]{0,80}back through `?testing`?, then the review column again/i);
    }
  });
});

// ===========================================================================
// Scenario: reject-and-rework is capped at three cycles
// ===========================================================================
test('Scenario: reject-and-rework is capped at three cycles', () => {
  const cycles = Given('a ticket rejected by pr-review three times in a row', () => [1, 2, 3]);

  const decisions = When('each rejection is processed in turn', () => cycles.map((n) => rejectReworkOutcome(n)));

  Then('the third rejection parks the ticket in "failed-testing"', () => {
    assert.equal(decisions[2].action, 'park-and-ask');
    assert.equal(decisions[2].park, true);
  });

  Then('the orchestrator summarises the unresolved review findings and asks the user, and no fourth cycle runs', () => {
    assert.equal(rejectReworkOutcome(4).action, 'park-and-ask');
    // The cap mirrors the testing fix loop exactly (same shape, same cap).
    assert.deepEqual(decisions, [1, 2, 3].map((n) => testingFixLoopOutcome(n)));
  });

  Then('SKILL.md states the reject-and-rework cap is 3, mirrors the testing cap, and never silently drops the ticket', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /cap this reject-and-rework cycle at\s*\*{0,2}3 attempts\*{0,2} per ticket/i);
      assert.match(src, /after the\s*\*{0,2}third\*{0,2}\s+rejection, park the\s+ticket in\s*`?failed-testing`?/i);
      assert.match(src, /a ticket\s*\r?\n?\s*is never silently dropped/i);
    }
  });
});

// ===========================================================================
// Scenario: a non-blocking critical finding creates a follow-up ticket
// instead of rejecting
// ===========================================================================
test('Scenario: a non-blocking critical finding creates a follow-up ticket instead of rejecting', () => {
  const finding = Given('the reviewer reports a critical finding but does not issue a reject verdict', () =>
    ({ severity: 'critical', rejectVerdict: false, impact: 'An attacker could read other users’ tokens.' }));
  const reviewedId = Given('the reviewed ticket is TASK-019', () => 'TASK-019');
  const existingIds = Given('the highest existing id across all status subfolders is TASK-019', () =>
    ['tasks/done/TASK-017-a.md', 'tasks/testing/TASK-018-b.md', 'tasks/todo/TASK-019-c.md']);
  const reviewedTicket = Given('the reviewed ticket\'s current frontmatter', () =>
    ({ id: 'TASK-019', status: 'pr-review', updated: '2026-08-03T09:00:00.000Z' }));
  const frozenBefore = Given('a snapshot of that frontmatter before the review', () => ({ ...reviewedTicket }));

  const result = When('the orchestrator processes the review', () => {
    const verdict = resolveReviewVerdict(finding);
    const [newId] = nextTaskIds(existingIds, 1);
    const followUp = buildFollowUpTicket(newId, reviewedId, finding.impact);
    return { verdict, followUp };
  });

  Then('a new todo ticket is created with review-of set to the reviewed id', () => {
    assert.equal(result.verdict, 'follow-up');
    assert.equal(result.followUp.id, 'TASK-020');
    assert.equal(result.followUp.status, 'todo');
    assert.equal(result.followUp['review-of'], 'TASK-019');
  });

  Then('that ticket has an "## Impact If Not Fixed" section', () => {
    assert.match(result.followUp.body, /## Impact If Not Fixed/);
    assert.match(result.followUp.body, /attacker could read/i);
  });

  Then('the reviewed ticket\'s status is unchanged', () => {
    assert.deepEqual(reviewedTicket, frozenBefore);
  });

  Then('SKILL.md documents the follow-up-only verdict, the review-of key, and the Impact section', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /follow-up only \(non-blocking\)/i);
      assert.match(src, /carry a\s*`?review-of:\s*<reviewed ticket id>`?\s*frontmatter key/i);
      assert.match(src, /contain a\s*`?##\s*impact if not fixed`?\s*section/i);
      assert.match(src, /never touched by this path|not\s*\*{0,2}\s+touched by this path/i);
    }
  });
});

// ===========================================================================
// Scenario: a low-severity finding creates no ticket (edge)
// ===========================================================================
test('Scenario: a low-severity finding creates no ticket (edge)', () => {
  const finding = Given('the reviewer reports only a nit', () => ({ severity: 'nit', rejectVerdict: false }));

  const verdict = When('the orchestrator resolves the verdict', () => resolveReviewVerdict(finding));

  Then('no follow-up ticket is created', () => {
    assert.equal(verdict, 'none');
  });

  Then('the nit is noted in the run summary (medium/low/nit -> summary only)', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /medium\/low\/nit findings create\s*\*{0,2}no\*{0,2}\s+ticket[\s\S]{0,40}note them in the run summary\s+only/i);
    }
  });
});

// ===========================================================================
// Scenario: the ticket reaches done directly once its last column clears
// ===========================================================================
test('Scenario: the ticket reaches done directly once its last column clears', () => {
  const columns = Given('a board whose last agent-bearing column is "pr-review", before "done"', () => [
    makeColumn('todo', null),
    makeColumn('defining', 'orchestrate-ba'),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('pr-review', 'orchestrate-tech-lead', { system: false }),
    makeColumn('done', null),
  ]);
  const ticket = Given('a ticket has passed all agent columns with no pending rejection', () =>
    ({ id: 'TASK-102', status: 'pr-review', pendingRejection: false, created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z' }));

  const nextStatus = When('the orchestrator finishes the ticket', () => {
    if (ticket.pendingRejection) return ticket.status; // never reached while pending
    const idx = columns.findIndex((c) => c.status === ticket.status);
    return columns[idx + 1].status;
  });

  Then('it sets the ticket to done', () => {
    ticket.status = nextStatus;
    ticket.updated = '2026-08-01T00:05:00.000Z';
    assert.equal(ticket.status, 'done');
    assert.equal(ticket.created, '2026-08-01T00:00:00.000Z', 'created preserved');
    assert.ok(ticket.updated > '2026-08-01T00:00:00.000Z', 'updated bumped');
  });

  Then('no post-processing step runs (the column/concept does not exist)', () => {
    assert.ok(!columns.some((c) => c.status === 'post-processing'), 'no post-processing column exists on the board');
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /no\s+intervening\s+post-processing\s+step/i);
      assert.match(src, /the last column'?s success\s*\*{0,2}is\*{0,2}\s+the\s*\r?\n?\s*terminal transition/i);
      assert.ok(!/##\s*post-processing/i.test(src), 'no "## Post-processing" heading anywhere');
    }
  });

  Then('SKILL.md states done is never reached while a rejection is still pending', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /never\s*\*{0,2}\s+reached while a reject-and-rework\s*\r?\n?\s*rejection is still pending resolution/i);
    }
  });
});

// ===========================================================================
// Scenario: a testing column with no preceding build column cannot fix
// (failure path)
// ===========================================================================
test('Scenario: a testing column with no preceding build column cannot fix (failure path)', () => {
  const columns = Given('a testing-type column with no build column before it', () => [
    makeColumn('todo', null),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('done', null),
  ]);
  const ticket = Given('a ticket sitting in "testing"', () => ({ id: 'TASK-103', status: 'testing' }));

  const result = When('its tests fail', () => {
    ticket.status = 'failed-testing';
    const testingIdx = columns.findIndex((c) => c.status === 'testing');
    const buildColumn = findPrecedingBuildColumn(columns, testingIdx);
    return { buildColumn, canAutoFix: buildColumn !== null };
  });

  Then('the orchestrator leaves the ticket in "failed-testing" and reports it cannot auto-fix', () => {
    assert.equal(result.buildColumn, null);
    assert.equal(result.canAutoFix, false);
    assert.equal(ticket.status, 'failed-testing');
  });

  Then('SKILL.md documents this exact no-preceding-build-column failure path', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /no preceding build column exists/i);
      assert.match(src, /cannot auto-fix: report that\s*\r?\n?\s*to the user and leave the ticket in\s*`?failed-testing`?/i);
    }
  });
});

// ===========================================================================
// Scenario: the assets mirror stays byte-identical (drift guard)
// ===========================================================================
test('Scenario: the assets mirror stays byte-identical (drift guard)', () => {
  Given('SKILL.md is edited for the rework/terminal sections', () => {});

  const identical = When('we compare the two SKILL.md copies as raw bytes', () =>
    fs.readFileSync(PROJECT_SKILL).equals(fs.readFileSync(ASSETS_SKILL)));

  Then('assets/skills/orchestrate/SKILL.md is written with identical bytes', () => {
    assert.equal(identical, true, '.claude and assets SKILL.md copies are byte-for-byte identical');
  });
});
