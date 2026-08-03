'use strict';

// ===========================================================================
// TASK-086 — e2e cucumber-style scenarios (Given/When/Then) for the SKILL
// free-slot prose matching the slot-occupancy code.
//
// These implement the ticket's Gherkin. They are scenario-style node --test
// cases (no `cucumber` npm package). Source-scan style over the real
// instruction files + lib/ticket-queue.js. NO DATABASE / DB CONNECTION /
// NETWORK / ELECTRON — pure file reads; the negative/edge scenario mutates an
// in-memory copy only.
//
// Feature: The SKILL free-slot prose matches the slot-occupancy code
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SLOT_OCCUPYING_STATUSES } = require('../lib/ticket-queue');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const skillProjectSrc = readFileLF(PROJECT_SKILL);

// U+2212 minus, tolerant whitespace (group may wrap across a newline), dash
// accepts minus sign or ASCII hyphen.
const FREE_SLOT_FORMULA =
  /limit\s*[−-]\s*\(in-progress\s*\+\s*testing\s*\+\s*defining\)/;
const OCCUPANCY_INCLUDES_DEFINING =
  /slot-occupancy\s+count[^.]*includes\s+`defining`/;
const EXCLUDING_ACTIVE_COUNT = /limit\s*[−-]\s*active\s+count/i;

// ---------------------------------------------------------------------------
// Scenario: Free-slot math names defining
// ---------------------------------------------------------------------------
test('Scenario: Free-slot math names defining (includes defining in the occupancy count)', () => {
  // Given both copies of the orchestrate SKILL
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    // Then the free-slot description includes defining in the occupancy count
    assert.match(src, FREE_SLOT_FORMULA,
      `${label}: free-slot formula = limit − (in-progress + testing + defining)`);
    assert.match(src, OCCUPANCY_INCLUDES_DEFINING,
      `${label}: describes the slot-occupancy count as including defining`);
    // And it no longer says "limit − active count" in a way that excludes defining
    assert.ok(!EXCLUDING_ACTIVE_COUNT.test(src),
      `${label}: no stale "limit − active count" free-slot phrasing`);
  }
  // And the two copies are byte-identical
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'the two SKILL copies are byte-identical');
});

// ---------------------------------------------------------------------------
// Scenario: Corrected prose is consistent with lib/ticket-queue.js
// ---------------------------------------------------------------------------
test('Scenario: The corrected prose matches SLOT_OCCUPYING_STATUSES in lib/ticket-queue.js', () => {
  // Given the authoritative slot-occupancy statuses from the code
  assert.deepEqual([...SLOT_OCCUPYING_STATUSES].sort(),
    ['defining', 'in-progress', 'testing'],
    'code counts defining, in-progress, testing against the bound');
  // Then both SKILL copies name each of those statuses in the free-slot prose
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    for (const s of SLOT_OCCUPYING_STATUSES) {
      assert.ok(src.includes(s), `${label}: SKILL references slot status ${s}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Scenario: Phase-1-only model invariant preserved (edge) — TASK-051
// ---------------------------------------------------------------------------
test('Scenario: model-id-confinement invariant preserved (no model id outside "## Model routing")', () => {
  // Given the orchestrate SKILL (TASK-204: model ids now live only inside the
  // "## Model routing" section, replacing the old "## Phase 2 — Build" anchor)
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    const routingIdx = src.indexOf('## Model routing');
    assert.ok(routingIdx !== -1, `${label}: Model routing heading present`);
    const nextHeadingIdx = src.indexOf('\n## ', routingIdx + 1);
    assert.ok(nextHeadingIdx !== -1, `${label}: a heading follows Model routing`);
    // Then no model id appears outside the Model routing section
    const outsideRouting = src.slice(0, routingIdx) + src.slice(nextHeadingIdx);
    assert.ok(!outsideRouting.includes(FABLE), `${label}: no ${FABLE} outside Model routing`);
    assert.ok(!outsideRouting.includes(OPUS), `${label}: no ${OPUS} outside Model routing`);
  }
});

// ---------------------------------------------------------------------------
// Scenario (failure/edge): a regression to the stale excluding formula is caught
// ---------------------------------------------------------------------------
test('Scenario: Edge — reintroducing the stale "limit − active count" formula fails the guard', () => {
  // Given a copy of the SKILL whose free-slot formula was reverted to exclude defining
  const regressed = skillProjectSrc.replace(FREE_SLOT_FORMULA, 'limit − active count');
  // (guard against a no-op replace)
  assert.notEqual(regressed, skillProjectSrc, 'the simulated regression changed the source');
  // When we apply the corrected-prose checks to the regressed copy
  // Then the excluding-phrasing guard fires and the defining-inclusive formula is gone
  assert.ok(EXCLUDING_ACTIVE_COUNT.test(regressed), 'excluding phrasing is detected');
  // And the real shipped copy passes both checks (defining-inclusive, no excluding phrasing)
  assert.match(skillProjectSrc, FREE_SLOT_FORMULA);
  assert.ok(!EXCLUDING_ACTIVE_COUNT.test(skillProjectSrc));
});
