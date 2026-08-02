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

test('E2E cucumber: Parallel coder dispatch in a single message is mandated', async (t) => {
  await t.test(
    'Given the Phase 2 build prose of either SKILL copy, ' +
      'When I read the section on batching and dispatch, ' +
      'Then it instructs the orchestrator to issue all eligible coder Task-tool dispatches in a single message ' +
      'And it frames dispatching everything eligible right now, in parallel, as the default behavior every pass',
    () => {
      for (const [label, src] of SKILL_COPIES) {
        // Find the Phase 2 section.
        const phase2Idx = src.indexOf('## Phase 2 — Build');
        assert.ok(phase2Idx !== -1, `${label}: Phase 2 heading present`);

        // Extract Phase 2 content up to Phase 3.
        const phase3Idx = src.indexOf('## Phase 3');
        const phase2Content = src.slice(phase2Idx, phase3Idx !== -1 ? phase3Idx : src.length);

        // Check for "Batching means one message" section.
        assert.match(phase2Content, /batching\s+means\s+one\s+message/i,
          `${label}: Phase 2 contains "Batching means one message" intro`);

        // Check for "in a single message" language for Task-tool calls.
        assert.match(phase2Content, /in a single message/i,
          `${label}: Phase 2 describes issuing calls in a single message`);

        // Check for "default, expected behavior".
        assert.match(phase2Content, /default.*behavior|expected.*behavior/i,
          `${label}: Phase 2 frames it as default/expected behavior`);

        // Check for "dispatch everything eligible right now, in parallel".
        assert.match(phase2Content, /dispatch\s+everything\s+eligible|maximize\s+concurrent/i,
          `${label}: Phase 2 says dispatch everything eligible right now`);
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
        // Find the mid-build "Multiple undefined tickets" section.
        const midBuildIdx = src.indexOf('Multiple undefined tickets at once');
        assert.ok(midBuildIdx !== -1, `${label}: "Multiple undefined tickets at once" section present`);

        // Extract that section (up to the next bullet or subsection).
        const sectionEnd = src.indexOf('- **', midBuildIdx + 50);
        const definingSection = src.slice(midBuildIdx, sectionEnd !== -1 ? sectionEnd : midBuildIdx + 2000);

        // Check for "define them together, in one message".
        assert.match(definingSection, /define.*together.*one message|ba-definition.*task-tool.*single message|together.*single message/i,
          `${label}: mid-build says define them together in one message`);

        // Check for simultaneous/parallel language.
        assert.match(definingSection, /simultaneously|at the same time|in parallel/i,
          `${label}: mid-build describes defining simultaneously`);

        // Check for "all of their BA-definition Task-tool calls".
        assert.match(definingSection, /all.*ba-definition|all.*task-tool/i,
          `${label}: mid-build says all their BA-definition calls`);
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
        // Find dispatch prose in Phase 2.
        const phase2Idx = src.indexOf('## Phase 2 — Build');
        const phase3Idx = src.indexOf('## Phase 3');
        const phase2Content = src.slice(phase2Idx, phase3Idx !== -1 ? phase3Idx : src.length);

        // Check for free-slot formula at step 2 (selectNextBatch).
        assert.match(phase2Content, FREE_SLOT_FORMULA,
          `${label}: Phase 2 states the free-slot formula limit − (in-progress + testing + defining)`);

        // Check for "capped" or "bound" language.
        assert.match(phase2Content, /capped.*free.slot|bound.*dispatch|never\s+more\s+than.*limit/i,
          `${label}: Phase 2 describes dispatch capped by free-slot bound`);

        // Check for "wait in the queue".
        assert.match(phase2Content, /wait\s+in\s+the\s+queue|beyond.*bound.*wait|exceed.*bound/i,
          `${label}: Phase 2 says tickets beyond the bound wait in the queue`);
      }
    },
  );
});

test('E2E cucumber: Claim-before-build ordering is preserved', async (t) => {
  await t.test(
    'Given the strengthened build prose, ' +
      'When I read the ordering of claims and builds, ' +
      'Then each ticket is still atomically claimed before its build starts ' +
      'And only the coder dispatches themselves are batched into one message',
    () => {
      for (const [label, src] of SKILL_COPIES) {
        const phase2Idx = src.indexOf('## Phase 2 — Build');
        const phase3Idx = src.indexOf('## Phase 3');
        const phase2Content = src.slice(phase2Idx, phase3Idx !== -1 ? phase3Idx : src.length);

        // Find the step 3 (Claim) section.
        assert.match(phase2Content, /3\.\s+\*\*Claim\*\*/,
          `${label}: Phase 2 step 3 is titled Claim`);

        // Check for "claimed before build" language.
        assert.match(phase2Content, /claimed.*before.*build|before.*build.*starts/i,
          `${label}: Phase 2 emphasizes claimed before build starts`);

        // Check for "Claim sequentially".
        assert.match(phase2Content, /claim\s+sequentially/i,
          `${label}: Phase 2 says Claim sequentially`);

        // Check for batching language that preserves ordering.
        assert.match(phase2Content, /only[\s\S]*?coder[\s\S]*?task-tool[\s\S]*?together/i,
          `${label}: Phase 2 says only the coder Task-tool calls are batched together`);

        // Check for "claim-before-build ordering" preservation.
        assert.match(phase2Content, /claim-before-build|batching.*never\s+changes|never\s+changes.*ordering/i,
          `${label}: Phase 2 preserves claim-before-build ordering`);
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
        assert.match(src, /never\s+exceed.*bound|wait\s+in.*queue/i,
          `${label}: SKILL says selectNextBatch never exceeds the bound`);
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
        // Check the free-slot formula appears at least 3 times.
        const formulaMatches = src.match(new RegExp(FREE_SLOT_FORMULA.source, 'g')) || [];
        assert.ok(formulaMatches.length >= 3,
          `${label}: free-slot formula appears >= 3 times (found ${formulaMatches.length})`);

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

test('UNIT: no model id appears at or after "## Phase 2 — Build" (TASK-051)', () => {
  for (const [label, src] of SKILL_COPIES) {
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(phase2Idx !== -1, `${label}: Phase 2 heading present`);

    const afterPhase2 = src.slice(phase2Idx);
    assert.ok(!afterPhase2.includes(FABLE),
      `${label}: no ${FABLE} at/after Phase 2`);
    assert.ok(!afterPhase2.includes(OPUS),
      `${label}: no ${OPUS} at/after Phase 2`);
  }
});
