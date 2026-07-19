'use strict';

// ===========================================================================
// TASK-051 — e2e cucumber-style (Given/When/Then) scenarios
//
// Feature: Planning phase runs on Fable 5 with an Opus 4.8 fallback.
//
// These are scenario-style `node --test` cases (no `cucumber` npm package) that
// implement the ticket's Gherkin. They read the REAL instruction files
// (.claude + assets copies of SKILL.md and ba.md) as fixtures — this is a
// workflow-config/instruction change, so there is NO DB, network, or Electron
// in the loop and nothing to mock. The two FAILURE/edge scenarios mutate copies
// IN MEMORY only and never touch the real files on disk.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_BA = path.join(ROOT, 'assets', 'agents', 'ba.md');
const PROJECT_BA = path.join(ROOT, '.claude', 'agents', 'ba.md');
const ASSETS_AGENTS = path.join(ROOT, 'assets', 'agents');
const PROJECT_AGENTS = path.join(ROOT, '.claude', 'agents');

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

// Minimal flat-YAML frontmatter parser (same shape used in
// test/orchestrate-agents.test.js) — handles inline scalars and folded blocks.
function parseAgentFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  const fm = {};
  let i = 1;
  while (i < closeIdx) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    let val = m[2];
    if (val === '>-' || val === '>' || val === '|' || val === '|-') {
      const parts = [];
      i++;
      while (i < closeIdx && (lines[i].trim() === '' || /^\s+\S/.test(lines[i]))) {
        parts.push(lines[i].trim());
        i++;
      }
      fm[key] = parts.join(' ').trim();
      continue;
    }
    fm[key] = val.trim();
    i++;
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return { fm, body };
}

function parseTools(val) {
  return String(val || '').split(',').map((t) => t.trim()).filter(Boolean);
}

const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const skillProjectSrc = readFileLF(PROJECT_SKILL);

// Everything at/after the "## Phase 2 — Build" heading is the Phase 2/3/4
// territory — the model directive must NOT appear there.
function phase234Slice(src) {
  const idx = src.indexOf('## Phase 2 — Build');
  assert.ok(idx !== -1, 'SKILL.md has a "## Phase 2 — Build" heading');
  return src.slice(idx);
}

// ===========================================================================
// Scenario: SKILL Phase 1 directive names Fable 5 as preferred
// ===========================================================================
test('Scenario: SKILL Phase 1 directive names Fable 5 (claude-fable-5) as the preferred planning model', () => {
  // Given both copies of the orchestrate SKILL.md
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    // Then the Phase-1 dispatch instructs dispatching the planning subagent on
    // claude-fable-5 when available.
    assert.ok(src.includes(FABLE), `${label}/SKILL.md names ${FABLE}`);
    assert.match(src, /Dispatch this planning subagent on `claude-fable-5` when\s+available/,
      `${label}/SKILL.md Phase-1 bullet prefers claude-fable-5 "when available"`);
    // And the Phase-1 launch step repeats it ("dispatched on ... when available").
    assert.match(src, /dispatched on `claude-fable-5` when available/,
      `${label}/SKILL.md Phase-1 launch step dispatches on claude-fable-5 when available`);
  }
});

// ===========================================================================
// Scenario: SKILL Phase 1 directive names Opus 4.8 as fallback
// ===========================================================================
test('Scenario: SKILL Phase 1 directive names Opus 4.8 (claude-opus-4-8) as the fallback with explicit otherwise/else wording', () => {
  // Given both copies of the SKILL.md
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    // Then it states that otherwise/else it falls back to claude-opus-4-8.
    assert.ok(src.includes(OPUS), `${label}/SKILL.md names ${OPUS}`);
    // Explicit "otherwise" wording next to the fallback model id (both mentions).
    assert.match(src, /otherwise fall back to `claude-opus-4-8`/,
      `${label}/SKILL.md Phase-1 bullet says "otherwise fall back to claude-opus-4-8"`);
    assert.match(src, /otherwise `claude-opus-4-8`/,
      `${label}/SKILL.md Phase-1 launch step says "otherwise claude-opus-4-8"`);
    // And the directive is scoped to Phase 1 planning only (stated inline).
    assert.match(src, /This model directive\s+applies to Phase 1 planning only/,
      `${label}/SKILL.md scopes the model directive to Phase 1 planning only`);
  }
});

// ===========================================================================
// Scenario: Both SKILL.md copies byte-identical
// ===========================================================================
test('Scenario: Both SKILL.md copies are byte-identical', () => {
  // Given the bundled (assets) and project (.claude) SKILL.md copies
  const bundled = fs.readFileSync(ASSETS_SKILL);
  const project = fs.readFileSync(PROJECT_SKILL);
  // Then they are byte-for-byte identical (drift guard).
  assert.ok(bundled.equals(project),
    'assets/skills/orchestrate/SKILL.md === .claude/skills/orchestrate/SKILL.md (byte-for-byte)');
});

// ===========================================================================
// Scenario: BA agent declares preferred model
// ===========================================================================
test('Scenario: BA agent frontmatter declares model claude-fable-5, name orchestrate-ba, tools Read, Grep, Glob', () => {
  // Given both copies of the ba.md agent definition
  for (const [label, p] of [['assets', ASSETS_BA], ['.claude', PROJECT_BA]]) {
    const parsed = parseAgentFrontmatter(readFileLF(p));
    assert.ok(parsed, `${label}/agents/ba.md has a frontmatter block`);
    const { fm } = parsed;
    // Then model == claude-fable-5
    assert.equal(fm.model, FABLE, `${label}/ba.md model is ${FABLE}`);
    // And name stays orchestrate-ba
    assert.equal(fm.name, 'orchestrate-ba', `${label}/ba.md name unchanged`);
    // And tools stay exactly Read, Grep, Glob (read-only; no Edit/Write/Bash)
    assert.deepEqual(parseTools(fm.tools), ['Read', 'Grep', 'Glob'],
      `${label}/ba.md tools unchanged`);
    for (const forbidden of ['Edit', 'Write', 'Bash']) {
      assert.ok(!parseTools(fm.tools).includes(forbidden),
        `${label}/ba.md must NOT have ${forbidden}`);
    }
    // And description is still present/unchanged (non-empty, mentions business analyst).
    assert.match(fm.description, /[Bb]usiness analyst/, `${label}/ba.md description unchanged`);
  }
});

// ===========================================================================
// Scenario: Both ba.md copies byte-identical
// ===========================================================================
test('Scenario: Both ba.md copies are byte-identical', () => {
  const bundled = fs.readFileSync(ASSETS_BA);
  const project = fs.readFileSync(PROJECT_BA);
  assert.ok(bundled.equals(project),
    'assets/agents/ba.md === .claude/agents/ba.md (byte-for-byte)');
});

// ===========================================================================
// Scenario: Only the planning phase gets the directive
// ===========================================================================
test('Scenario: Only Phase 1 gets the model directive — Phase 2/3/4 text does not name the model ids', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    const tail = phase234Slice(src);
    assert.ok(!tail.includes(FABLE),
      `${label}/SKILL.md Phase 2/3/4 must NOT name ${FABLE}`);
    assert.ok(!tail.includes(OPUS),
      `${label}/SKILL.md Phase 2/3/4 must NOT name ${OPUS}`);
    // And the model ids appear ONLY before the Phase 2 heading (Phase 1 scope).
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(src.lastIndexOf(FABLE) < phase2Idx,
      `${label}/SKILL.md: every ${FABLE} mention is in Phase 1 scope`);
    assert.ok(src.lastIndexOf(OPUS) < phase2Idx,
      `${label}/SKILL.md: every ${OPUS} mention is in Phase 1 scope`);
  }
});

test('Scenario: Only Phase 1 gets the directive — coder/tester/tech-lead agent defs have NO model key', () => {
  // Given the non-planning agent definitions in both copies
  for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
    for (const f of ['coder.md', 'tester.md', 'tech-lead.md']) {
      const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, f)));
      // Then they declare no model key (only the BA is pinned to Fable 5).
      assert.equal(fm.model, undefined, `${f} in ${path.basename(dir)} has no model key`);
    }
  }
});

// ===========================================================================
// Scenario (FAILURE/edge): assets SKILL copy drifts -> byte-identity guard fails
// Simulated IN MEMORY — the real files are never edited.
// ===========================================================================
test('Scenario (FAILURE/edge): a drifted SKILL.md copy fails the byte-identity guard (in-memory)', () => {
  // Given the two real SKILL.md copies (currently identical)
  const bundled = fs.readFileSync(ASSETS_SKILL);
  const project = fs.readFileSync(PROJECT_SKILL);
  assert.ok(bundled.equals(project), 'precondition: the real copies are identical');
  // When one copy drifts by a single byte (in memory only)
  const drifted = Buffer.from(bundled); // copy
  drifted[drifted.length - 1] = drifted[drifted.length - 1] ^ 0x01;
  // Then the byte-identity check the guard relies on would fail.
  assert.ok(!drifted.equals(project),
    'a one-byte drift is detected by Buffer.equals');
  // And the real on-disk files are untouched (still identical).
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real SKILL.md copies remain byte-identical after the in-memory mutation');
});

// ===========================================================================
// Scenario (FAILURE/edge): the model id is missing / misspelled -> presence guard fails
// Simulated IN MEMORY — the real files are never edited.
// ===========================================================================
test('Scenario (FAILURE/edge): a misspelled model id ("claude-fabel-5") fails the presence guard (in-memory)', () => {
  // Given the real SKILL.md text (contains the correct id)
  assert.ok(skillAssetsSrc.includes(FABLE), 'precondition: real text contains claude-fable-5');
  // When the id is misspelled in an in-memory copy
  const typo = skillAssetsSrc.replace(/claude-fable-5/g, 'claude-fabel-5');
  // Then the presence guard (looking for the exact id) fails on the mutated text.
  assert.ok(!typo.includes(FABLE),
    'the presence guard rejects text where claude-fable-5 is misspelled as claude-fabel-5');
  // And a copy with the directive removed entirely also fails the guard.
  const removed = skillAssetsSrc.split('\n').filter((l) => !l.includes(FABLE)).join('\n');
  assert.ok(!removed.includes(FABLE),
    'the presence guard fails when the claude-fable-5 directive is missing');
  // And the real file is untouched.
  assert.ok(readFileLF(ASSETS_SKILL).includes(FABLE),
    'real assets/SKILL.md still contains claude-fable-5 after the in-memory mutation');
});
