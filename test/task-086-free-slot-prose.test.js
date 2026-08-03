'use strict';

// ===========================================================================
// TASK-086 — unit tests: SKILL free-slot prose matches the slot-occupancy code
//
// Follow-up to the tech-lead review of TASK-079 (Finding 1). TASK-079 Part C
// made a `defining` ticket count against the concurrency bound (free slots =
// `limit − (in-progress + testing + defining)`, via `slotOccupancyCount` in
// lib/ticket-queue.js). Three places in the orchestrate instruction contract
// previously described the free-slot math as `limit − active count` (excluding
// `defining`). This suite pins the corrected prose in BOTH SKILL copies, its
// consistency with lib/ticket-queue.js, byte-identity of the two copies, the
// TASK-051 Phase-1-only model invariant, and a regression guard against the
// stale excluding phrasing.
//
// Source-scan style (mirrors test/orchestrate-agents.test.js /
// test/task-051-planning-model.test.js). No DB / network / Electron — pure file
// reads; the edge cases mutate an in-memory copy only.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SLOT_OCCUPYING_STATUSES } = require('../lib/ticket-queue');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const TICKET_QUEUE = path.join(ROOT, 'lib', 'ticket-queue.js');

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const skillProjectSrc = readFileLF(PROJECT_SKILL);
const ticketQueueSrc = readFileLF(TICKET_QUEUE);

const SKILL_COPIES = [
  ['assets', skillAssetsSrc],
  ['.claude', skillProjectSrc],
];

// The corrected free-slot formula. The shipped prose uses a U+2212 MINUS SIGN
// (−), and the `(in-progress + testing + defining)` group can wrap across a
// line break, so the whitespace between tokens is matched flexibly and the dash
// accepts either the minus sign or an ASCII hyphen.
const FREE_SLOT_FORMULA =
  /limit\s*[−-]\s*\(in-progress\s*\+\s*testing\s*\+\s*defining\)/;

// The explanatory clause that the group is the slot-occupancy count INCLUDING
// defining (wording used at all three occurrences).
const OCCUPANCY_INCLUDES_DEFINING =
  /slot-occupancy\s+count[^.]*includes\s+`defining`/;

// The stale, WRONG phrasing that excludes defining. Its reintroduction must fail.
const EXCLUDING_ACTIVE_COUNT = /limit\s*[−-]\s*active\s+count/i;

// --- corrected free-slot wording present in BOTH copies --------------------

for (const [label, src] of SKILL_COPIES) {
  test(`unit: ${label}/SKILL.md states free slots = limit − (in-progress + testing + defining)`, () => {
    assert.match(src, FREE_SLOT_FORMULA,
      `${label} copy names the defining-inclusive free-slot formula`);
  });

  test(`unit: ${label}/SKILL.md describes the slot-occupancy count as including defining`, () => {
    assert.match(src, OCCUPANCY_INCLUDES_DEFINING,
      `${label} copy explains the occupancy count includes defining`);
  });

  test(`unit: ${label}/SKILL.md carries the free-slot formula (TASK-204: stated once, cross-referenced)`, () => {
    // TASK-204 consolidated the prose so the formula is stated ONCE,
    // canonically, in "Concurrency, claims, and isolation", with every other
    // section cross-referencing it instead of restating it verbatim.
    const matches = src.match(new RegExp(FREE_SLOT_FORMULA.source, 'g')) || [];
    assert.ok(matches.length >= 1,
      `${label} copy has >= 1 defining-inclusive free-slot formula (found ${matches.length})`);
  });

  test(`unit: ${label}/SKILL.md no longer says "limit − active count" (excluding defining)`, () => {
    assert.ok(!EXCLUDING_ACTIVE_COUNT.test(src),
      `${label} copy must not describe free slots as limit − active count`);
  });
}

// --- consistency with lib/ticket-queue.js ----------------------------------

test('unit: SLOT_OCCUPYING_STATUSES includes defining, in-progress, testing', () => {
  assert.ok(Array.isArray(SLOT_OCCUPYING_STATUSES));
  for (const s of ['defining', 'in-progress', 'testing']) {
    assert.ok(SLOT_OCCUPYING_STATUSES.includes(s),
      `SLOT_OCCUPYING_STATUSES includes ${s}`);
  }
});

test('unit: lib/ticket-queue.js source defines SLOT_OCCUPYING_STATUSES with defining and slotOccupancyCount', () => {
  assert.match(ticketQueueSrc, /SLOT_OCCUPYING_STATUSES\s*=\s*\[[^\]]*'defining'[^\]]*\]/,
    'the source array literal includes defining');
  assert.match(ticketQueueSrc, /function\s+slotOccupancyCount/,
    'slotOccupancyCount is the authoritative slot-count helper');
});

test('unit: SKILL prose is consistent with the code — every SLOT_OCCUPYING_STATUS is named in the free-slot math', () => {
  for (const [label, src] of SKILL_COPIES) {
    // The corrected occurrence lists exactly the three slot-occupying statuses.
    for (const s of SLOT_OCCUPYING_STATUSES) {
      assert.ok(src.includes(s), `${label} copy references slot status ${s}`);
    }
    // and it references slotOccupancyCount's helpers by name so the prose is
    // anchored to the authoritative behaviour.
    assert.ok(/selectNextBatch/.test(src) && /canRunInParallel/.test(src),
      `${label} copy references selectNextBatch / canRunInParallel`);
  }
});

// --- byte-identity drift guard (mirror of orchestrate-agents.test.js) ------

test('unit: the two SKILL.md copies are byte-identical (Buffer.equals)', () => {
  const a = fs.readFileSync(ASSETS_SKILL);
  const b = fs.readFileSync(PROJECT_SKILL);
  assert.ok(a.equals(b),
    'assets/skills/orchestrate/SKILL.md === .claude/skills/orchestrate/SKILL.md (byte-for-byte)');
});

// --- TASK-051 invariant: no model id at/after "## Phase 2 — Build" ---------

test('unit: no model id appears outside the "## Model routing" section', () => {
  // TASK-204: model ids now live ONLY inside "## Model routing".
  for (const [label, src] of SKILL_COPIES) {
    const routingIdx = src.indexOf('## Model routing');
    assert.ok(routingIdx !== -1, `${label}: Model routing heading present`);
    const nextHeadingIdx = src.indexOf('\n## ', routingIdx + 1);
    assert.ok(nextHeadingIdx !== -1, `${label}: a heading follows Model routing`);
    const outsideRouting = src.slice(0, routingIdx) + src.slice(nextHeadingIdx);
    assert.ok(!outsideRouting.includes(FABLE), `${label}: no ${FABLE} outside Model routing`);
    assert.ok(!outsideRouting.includes(OPUS), `${label}: no ${OPUS} outside Model routing`);
  }
});

// --- FAILURE / edge assertions (in-memory only; real files untouched) ------

test('unit (edge): a regression reintroducing "limit − active count" is caught', () => {
  // Simulate a coder reverting the fix in the free-slot occurrence.
  const regressed = skillAssetsSrc.replace(FREE_SLOT_FORMULA, 'limit − active count');
  assert.notEqual(regressed, skillAssetsSrc, 'the replacement actually changed the source');
  assert.ok(EXCLUDING_ACTIVE_COUNT.test(regressed),
    'the excluding phrasing guard fires on the regressed copy');
  // Real file remains correct.
  assert.ok(!EXCLUDING_ACTIVE_COUNT.test(skillAssetsSrc),
    'the real assets copy is free of the excluding phrasing');
});

test('unit (edge): dropping "defining" from the formula fails the corrected-wording guard', () => {
  const stripped = skillAssetsSrc.replace(
    new RegExp(FREE_SLOT_FORMULA.source, 'g'),
    'limit − (in-progress + testing)',
  );
  assert.ok(!FREE_SLOT_FORMULA.test(stripped),
    'a formula missing defining no longer matches the corrected-wording guard');
  // Real file still names defining in the formula.
  assert.match(skillAssetsSrc, FREE_SLOT_FORMULA);
});

test('unit (edge): Buffer.equals detects a single-byte SKILL.md drift (in-memory)', () => {
  const original = fs.readFileSync(ASSETS_SKILL);
  const mutated = Buffer.from(original);
  mutated[0] = mutated[0] ^ 0xff;
  assert.ok(!mutated.equals(fs.readFileSync(PROJECT_SKILL)), 'drift detected');
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real copies untouched and still identical');
});
