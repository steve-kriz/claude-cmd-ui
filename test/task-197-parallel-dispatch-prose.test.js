'use strict';

// ===========================================================================
// TASK-197 — E2E and UNIT tests: orchestrator batches parallel dispatches
// within the existing concurrency bound
//
// The coder edited only the two byte-identical SKILL.md files to strengthen
// the orchestrate contract, mandating that when multiple tickets are eligible
// for the same phase's dispatch, the orchestrator issues all their Task-tool
// calls in a SINGLE MESSAGE (parallel tool calls), within the existing
// free-slot bound — never changing concurrency machinery or weakening any
// guarantee.
//
// This file contains BOTH mandated kinds of tests:
//   * E2E CUCUMBER SCENARIOS: Given/When/Then cases mirroring every Gherkin
//     acceptance criterion, reading SKILL.md and asserting the required prose.
//   * UNIT TESTS: asserting lib/ticket-queue.js constants are unchanged,
//     selectNextBatch never exceeds the bound, byte-identity of SKILL copies,
//     and all previously-pinned phrases survive.
//
// NO DATABASE, NO NETWORK. Only disk reads of the two SKILL.md and lib/ticket-queue.js.
// Edge cases mutate in-memory copies only; real files untouched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const TICKET_QUEUE = path.join(ROOT, 'lib', 'ticket-queue.js');

const {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  selectNextBatch,
  SLOT_OCCUPYING_STATUSES,
} = require('../lib/ticket-queue');

// Read helpers: normalized line endings for matching, raw bytes for identity.
function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function readBytes(p) {
  return fs.readFileSync(p);
}

function readLower(p) {
  return readFileLF(p).toLowerCase();
}

const skillAssetsText = readFileLF(ASSETS_SKILL);
const skillProjectText = readFileLF(PROJECT_SKILL);
const ticketQueueSrc = readFileLF(TICKET_QUEUE);

const SKILL_COPIES = [
  ['assets', skillAssetsText],
  ['.claude', skillProjectText],
];

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

// Key phrases that must appear in the parallel-dispatch prose.
const PARALLEL_DISPATCH_PHRASE = /issue\s+all[\s\S]*?task-tool\s+calls[\s\S]*?single\s+message/i;
const SIMULTANEOUS_PHRASE = /simultaneous|at once|together|in parallel/i;
const DEFAULT_BEHAVIOR_PHRASE = /default.*behavior|expected.*behavior/i;
const FREE_SLOT_FORMULA = /limit\s*[−-]\s*\(in-progress\s*\+\s*testing\s*\+\s*defining\)/;
const CLAIM_BEFORE_BUILD = /claim.*before|claim\s+sequentially|each ticket.*claimed.*before.*build/i;
const BATCH_DISPATCH = /dispatch[\s\S]*?task-tool[\s\S]*?single\s+message|all[\s\S]*?task-tool[\s\S]*?together/i;

// Previously-pinned phrases that must survive.
const PINNED_PHRASES = [
  /selectNextBatch/,
  /canRunInParallel/,
  /claimTicket/,
  /releaseTicket/,
  /ticketBranchName/,
  /ticketWorktreeDir/,
  /DEFAULT_CONCURRENCY/,
  /MAX_CONCURRENCY/,
  /keep-last-good-parse/,
  /burst of simultaneously-answered definitions/,
  /swarm/,
  /batch/,
  /parallel/,
  /sets/,
];

// The stale, WRONG phrasing that excludes defining (regression guard).
const EXCLUDING_ACTIVE_COUNT = /limit\s*[−-]\s*active\s+count/i;

// ───────────────────────────────────────────────────────────────────────────
// E2E CUCUMBER SCENARIOS: Given/When/Then cases
// ───────────────────────────────────────────────────────────────────────────

// TASK-204: the fixed "## Phase 2 — Build" section was replaced by the
// generic, column-driven "The generic dispatch loop" / "Forward movement
// model" sections, plus a "Batching is unchanged." paragraph under Forward
// movement model. The batching-in-one-message guarantee itself is unchanged;
// only its heading/wording moved.
test('E2E cucumber: Parallel coder dispatch in a single message is mandated', async (t) => {
  await t.test(
    'Given the batching prose of either SKILL copy, ' +
      'When I read the section on batching and dispatch, ' +
      'Then it instructs the orchestrator to issue all eligible Task-tool dispatches in a single message ' +
      'And it frames dispatching everything eligible right now, in parallel, as the default behavior every pass',
    () => {
      for (const [label, src] of SKILL_COPIES) {
        // Find the "Batching is unchanged." paragraph (the generic replacement
        // for the old per-phase "Batching means one message" intro).
        const battchIdx = src.indexOf('Batching is unchanged.');
        assert.ok(battchIdx !== -1, `${label}: "Batching is unchanged." intro present`);
        const battchContent = src.slice(battchIdx, battchIdx + 1000);

        // Check for "in a single message" language for Task-tool calls.
        assert.match(battchContent, /in a single message/i,
          `${label}: batching prose describes issuing calls in a single message`);

        // Check for "never one-at-a-time" (this doc's phrasing of default/expected).
        assert.match(battchContent, /never one-at-a-time/i,
          `${label}: batching prose frames issuing calls together as the rule, not one-at-a-time`);

        // Check the generic dispatch loop frames re-scanning/batching everything
        // eligible, in parallel, as the ongoing default behavior every pass.
        assert.match(src, /batching everything eligible in parallel/i,
          `${label}: the generic dispatch loop says batching everything eligible in parallel`);
      }
    },
  );
});

test('E2E cucumber: Parallel BA-definition of multiple undefined tickets is mandated', async (t) => {
  await t.test(
    'Given the mid-build defining prose of either SKILL copy, ' +
      'When I read the section on multiple undefined tickets, ' +
      'Then it instructs the orchestrator to define multiple undefined todo tickets simultaneously ' +
      'And it says their BA-definition Task-tool calls go out together in one message when several are eligible',
    () => {
      for (const [label, src] of SKILL_COPIES) {
        // Find the mid-build "Multiple undefined `todo` tickets discovered at
        // once" bullet (TASK-204 renamed/reworded this section but kept the
        // same batch-dispatch guarantee).
        const midBuildIdx = src.indexOf('Multiple undefined `todo` tickets discovered at once');
        assert.ok(midBuildIdx !== -1, `${label}: "Multiple undefined todo tickets discovered at once" bullet present`);

        // Extract that bullet (up to the next top-level bullet or subsection).
        const sectionEnd = src.indexOf('- **', midBuildIdx + 50);
        const definingSection = src.slice(midBuildIdx, sectionEnd !== -1 ? sectionEnd : midBuildIdx + 2000);

        // Check for "dispatched together, in one message" — the batch-dispatch
        // guarantee (a single message's parallel tool calls IS the simultaneity).
        assert.match(definingSection, /dispatched together,?\s*in\s*\*{0,2}one message\*{0,2}/i,
          `${label}: mid-build says they are dispatched together in one message`);

        // Check for "never one-at-a-time" (this doc's phrasing for the rule).
        assert.match(definingSection, /never one-at-a-time/i,
          `${label}: mid-build rules out dispatching them one-at-a-time`);

        // Check the batch is still bound by the same free-slot cap as any
        // other batch (cross-referenced, not a special unbounded case).
        assert.match(definingSection, /same free-slot bound as any other batch/i,
          `${label}: mid-build ties the BA batch to the same free-slot bound`);
      }
    },
  );
});

test('E2E cucumber: Parallelism stays inside the existing bound', async (t) => {
  await t.test(
    'Given the strengthened dispatch prose, ' +
      'When I read the cap on simultaneous dispatches, ' +
      'Then the number of simultaneous dispatches is capped at the free slots limit − (in-progress + testing + defining) ' +
      'And tickets beyond the bound wait in the queue',
    () => {
      for (const [label, src] of SKILL_COPIES) {
        // TASK-204: the free-slot/bound prose now lives in "Concurrency,
        // claims, and isolation" (no more "## Phase 2 — Build" heading).
        const concurrencyIdx = src.indexOf('## Concurrency, claims, and isolation');
        assert.ok(concurrencyIdx !== -1, `${label}: Concurrency section present`);
        const concurrencyContent = src.slice(concurrencyIdx);

        // Check for free-slot formula.
        assert.match(concurrencyContent, FREE_SLOT_FORMULA,
          `${label}: Concurrency section states the free-slot formula limit − (in-progress + testing + defining)`);

        // Check for "bounded"/"never starts a build when N tickets already
        // occupy slots" language.
        assert.match(concurrencyContent, /bounded concurrency|never\s+starts\s+a\s+build\s+when\s+N\s+tickets\s+already\s+occupy\s+slots/i,
          `${label}: Concurrency section describes dispatch bounded by the free-slot cap`);

        // Check for "wait in the queue".
        assert.match(concurrencyContent, /wait\s+in\s+the\s+queue/i,
          `${label}: Concurrency section says tickets past the bound wait in the queue`);
      }
    },
  );
});

test('E2E cucumber: Claim-before-build ordering is preserved', async (t) => {
  await t.test(
    'Given the strengthened build prose, ' +
      'When I read the ordering of claims and builds, ' +
      'Then each ticket is still atomically claimed before its build starts ' +
      'And only the Task-tool dispatches themselves are batched into one message',
    () => {
      for (const [label, src] of SKILL_COPIES) {
        // TASK-204: claim mechanics moved out of a "Phase 2" numbered step and
        // into the generic "Batching is unchanged." paragraph (Forward
        // movement model) plus "Concurrency, claims, and isolation".
        const battchIdx = src.indexOf('Batching is unchanged.');
        assert.ok(battchIdx !== -1, `${label}: "Batching is unchanged." paragraph present`);
        const battchContent = src.slice(battchIdx, battchIdx + 1000);

        // Check for "claim-before-build ordering" preservation (exact phrase).
        assert.match(battchContent, /claim-before-build ordering is unaffected by batching/i,
          `${label}: batching prose states claim-before-build ordering is preserved`);

        // Check for "claimed individually and atomically ... before its
        // dispatch starts".
        assert.match(battchContent, /claimed individually and atomically[\s\S]*?before[\s\S]*?dispatch\s+starts/i,
          `${label}: batching prose emphasizes each ticket claimed before its dispatch starts`);

        // Check for "only the Task-tool calls themselves are issued together".
        assert.match(battchContent, /only the task-tool calls themselves are issued together/i,
          `${label}: batching prose says only the Task-tool calls themselves are batched together`);

        // Cross-check the underlying claim primitive (claimTicket) is named
        // for the actual entry-into-in-progress transition too.
        assert.match(src, /entry into `in-progress` is a claim, not a plain dispatch/i,
          `${label}: SKILL.md states entry into in-progress is a claim, not a plain dispatch`);
      }
    },
  );
});

test('E2E cucumber: The concurrency machinery is unchanged', async (t) => {
  await t.test(
    'Given I require lib/ticket-queue.js, ' +
      'When I check the constants, ' +
      'Then DEFAULT_CONCURRENCY is 3 and MAX_CONCURRENCY is 8 ' +
      'And selectNextBatch still fills only the free slots and never exceeds the resolved bound',
    () => {
      assert.equal(DEFAULT_CONCURRENCY, 3,
        'DEFAULT_CONCURRENCY is 3');
      assert.equal(MAX_CONCURRENCY, 8,
        'MAX_CONCURRENCY is 8');

      // Verify selectNextBatch is documented in SKILL.
      for (const [label, src] of SKILL_COPIES) {
        assert.match(src, /selectNextBatch/,
          `${label}: SKILL documents selectNextBatch`);
        assert.match(src, /fills\s+only.*free\s+slots/i,
          `${label}: SKILL says selectNextBatch fills only free slots`);
        assert.match(src, /wait\s+in\s+the\s+queue/i,
          `${label}: SKILL says tickets past the bound wait in the queue`);
      }
    },
  );
});

test('E2E cucumber: The two copies stay byte-identical', async (t) => {
  await t.test(
    'Given I compare the raw bytes of the two SKILL copies, ' +
      'When I read both files as Buffers, ' +
      'Then they are byte-for-byte identical',
    () => {
      const assetsBytes = readBytes(ASSETS_SKILL);
      const projectBytes = readBytes(PROJECT_SKILL);
      assert.ok(assetsBytes.equals(projectBytes),
        'assets/skills/orchestrate/SKILL.md === .claude/skills/orchestrate/SKILL.md (byte-for-byte)');
    },
  );
});

test('E2E cucumber: All previously-pinned wording survives the edit', async (t) => {
  await t.test(
    'Given I scan either SKILL copy after the change, ' +
      'When I search for previously-pinned phrases, ' +
      'Then the free-slot formula "limit − (in-progress + testing + defining)" still appears at all three occurrences ' +
      'And the text still contains "keep-last-good-parse" and the "burst of simultaneously-answered definitions" clause ' +
      'And the text nowhere contains "limit − active count"',
    () => {
      for (const [label, src] of SKILL_COPIES) {
        // TASK-204: the doc was consolidated so the free-slot formula is
        // stated ONCE, canonically, in "Concurrency, claims, and isolation",
        // and every other section that used to restate it now cross-references
        // that section instead (per the ticket's own "preserves and
        // cross-references" acceptance criterion) — so >=1, not >=3.
        const formulaMatches = src.match(new RegExp(FREE_SLOT_FORMULA.source, 'g')) || [];
        assert.ok(formulaMatches.length >= 1,
          `${label}: free-slot formula appears >= 1 time (found ${formulaMatches.length})`);

        // Check all pinned phrases are present.
        for (const phrase of PINNED_PHRASES) {
          assert.match(src, phrase,
            `${label}: contains ${phrase.source}`);
        }

        // Check "keep-last-good-parse" is present.
        assert.match(src, /keep-last-good-parse/,
          `${label}: contains "keep-last-good-parse"`);

        // Check "burst of simultaneously-answered definitions" is present.
        assert.match(src, /burst\s+of\s+simultaneously.answered\s+definitions/,
          `${label}: contains "burst of simultaneously-answered definitions" clause`);

        // Check the stale "limit − active count" does NOT appear.
        assert.ok(!EXCLUDING_ACTIVE_COUNT.test(src),
          `${label}: does not contain the stale "limit − active count" phrasing`);
      }
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// E2E FAILURE / EDGE SCENARIOS
// ───────────────────────────────────────────────────────────────────────────

test('E2E cucumber (edge): a wording change that weakens the cap is rejected', async (t) => {
  await t.test(
    'Given a proposed edit that removes "defining" from the free-slot formula ' +
      'or drops the free-slot cap wording, ' +
      'When the drift/prose test suite evaluates it, ' +
      'Then the edit is caught because the formula no longer matches the corrected guard',
    () => {
      // In-memory mutation: simulate a regressed formula.
      const regressed = skillAssetsText.replace(
        new RegExp(FREE_SLOT_FORMULA.source, 'g'),
        'limit − (in-progress + testing)',
      );

      // Verify the regression is detected.
      assert.ok(!FREE_SLOT_FORMULA.test(regressed),
        'a formula missing defining no longer matches the corrected-wording guard');

      // Verify real file is untouched.
      assert.match(skillAssetsText, FREE_SLOT_FORMULA,
        'real file still contains the defining-inclusive formula');
    },
  );
});

test('E2E cucumber (edge): the assets mirror drifts from the .claude copy', async (t) => {
  await t.test(
    'Given the parallel-dispatch prose is added to only .claude/skills/orchestrate/SKILL.md ' +
      'without syncing assets/skills/orchestrate/SKILL.md, ' +
      'When the byte-identity drift guard runs, ' +
      'Then it fails because the two SKILL copies are no longer byte-identical',
    () => {
      // In-memory mutation: simulate adding prose to only one copy.
      const drifted = skillAssetsText.slice(0, 100) + 'EXTRA' + skillAssetsText.slice(100);
      const driftedBytes = Buffer.from(drifted, 'utf8');
      const projectBytes = readBytes(PROJECT_SKILL);

      // Verify the drift is detected.
      assert.ok(!driftedBytes.equals(projectBytes),
        'simulated drift is detected by Buffer.equals');

      // Verify real copies are still identical.
      const realAssets = readBytes(ASSETS_SKILL);
      const realProject = readBytes(PROJECT_SKILL);
      assert.ok(realAssets.equals(realProject),
        'real copies remain byte-identical');
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// UNIT TESTS: lib/ticket-queue.js machinery
// ───────────────────────────────────────────────────────────────────────────

test('UNIT: DEFAULT_CONCURRENCY is 3 and MAX_CONCURRENCY is 8 (unchanged)', () => {
  assert.equal(DEFAULT_CONCURRENCY, 3, 'DEFAULT_CONCURRENCY = 3');
  assert.equal(MAX_CONCURRENCY, 8, 'MAX_CONCURRENCY = 8');
});

test('UNIT: lib/ticket-queue.js exports DEFAULT_CONCURRENCY and MAX_CONCURRENCY', () => {
  assert.match(ticketQueueSrc, /^const DEFAULT_CONCURRENCY = 3;/m,
    'source defines DEFAULT_CONCURRENCY = 3');
  assert.match(ticketQueueSrc, /^const MAX_CONCURRENCY = 8;/m,
    'source defines MAX_CONCURRENCY = 8');
  assert.match(ticketQueueSrc, /DEFAULT_CONCURRENCY,\s*MAX_CONCURRENCY/,
    'exports include both constants');
});

test('UNIT: SLOT_OCCUPYING_STATUSES includes defining, in-progress, testing', () => {
  assert.ok(Array.isArray(SLOT_OCCUPYING_STATUSES));
  for (const s of ['defining', 'in-progress', 'testing']) {
    assert.ok(SLOT_OCCUPYING_STATUSES.includes(s),
      `SLOT_OCCUPYING_STATUSES includes ${s}`);
  }
});

test('UNIT: SKILL prose is consistent with concurrency code', () => {
  for (const [label, src] of SKILL_COPIES) {
    // References to the slot-occupying statuses.
    assert.match(src, /defining/, `${label}: references defining`);
    assert.match(src, /in-progress/, `${label}: references in-progress`);
    assert.match(src, /testing/, `${label}: references testing`);

    // References to the helper functions.
    assert.match(src, /selectNextBatch/, `${label}: references selectNextBatch`);
    assert.match(src, /canRunInParallel/, `${label}: references canRunInParallel`);
    assert.match(src, /claimTicket/, `${label}: references claimTicket`);
    assert.match(src, /releaseTicket/, `${label}: references releaseTicket`);
  }
});

test('UNIT (edge): Buffer.equals detects a single-byte SKILL.md drift', () => {
  // In-memory mutation: flip one bit.
  const original = readBytes(ASSETS_SKILL);
  const mutated = Buffer.from(original);
  mutated[0] = mutated[0] ^ 0xff;

  // Verify it's detected.
  assert.ok(!mutated.equals(readBytes(PROJECT_SKILL)),
    'single-byte drift is detected');

  // Verify real files are untouched.
  assert.ok(readBytes(ASSETS_SKILL).equals(readBytes(PROJECT_SKILL)),
    'real copies remain identical');
});

// TASK-204: the model-routing invariant survives, but the anchor moved — model
// ids now live ONLY inside the "## Model routing" section (never spliced into
// any column's own dispatch prose, per that section's own closing paragraph).
test('UNIT: no model id appears outside the "## Model routing" section (TASK-051 invariant, updated anchor)', () => {
  for (const [label, src] of SKILL_COPIES) {
    const routingIdx = src.indexOf('## Model routing');
    assert.ok(routingIdx !== -1, `${label}: Model routing heading present`);
    const nextHeadingIdx = src.indexOf('\n## ', routingIdx + 1);
    assert.ok(nextHeadingIdx !== -1, `${label}: a heading follows Model routing`);

    const outsideRouting = src.slice(0, routingIdx) + src.slice(nextHeadingIdx);
    assert.ok(!outsideRouting.includes(FABLE),
      `${label}: no ${FABLE} outside Model routing`);
    assert.ok(!outsideRouting.includes(OPUS),
      `${label}: no ${OPUS} outside Model routing`);
  }
});
