'use strict';

// ===========================================================================
// TASK-051 — e2e cucumber-style (Given/When/Then) scenarios
//
// Feature: cost-optimised model routing for the orchestrate swarm — default
// `claude-sonnet-5`, with the premium `claude-opus-4-8` tier reserved for the
// business analyst (Phase 1) and the tech lead / reviewer (Phase 4).
//
// These are scenario-style `node --test` cases (no `cucumber` npm package) that
// read the REAL instruction files (.claude + assets copies of SKILL.md and the
// four agent defs) as fixtures — this is a workflow-config/instruction change, so
// there is NO DB, network, or Electron in the loop and nothing to mock. The
// FAILURE/edge scenarios mutate copies IN MEMORY only and never touch the real
// files on disk.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_AGENTS = path.join(ROOT, 'assets', 'agents');
const PROJECT_AGENTS = path.join(ROOT, '.claude', 'agents');

const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-4-8';
const HAIKU = 'claude-haiku-4-5'; // the cheap tier (tester)

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

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
// territory — no literal model id may appear there.
function phase234Slice(src) {
  const idx = src.indexOf('## Phase 2 — Build');
  assert.ok(idx !== -1, 'SKILL.md has a "## Phase 2 — Build" heading');
  return src.slice(idx);
}

// ===========================================================================
// Scenario: SKILL Model-routing names claude-sonnet-5 as the swarm default
// ===========================================================================
test('Scenario: SKILL Model-routing names claude-sonnet-5 (default) for the coder', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    assert.ok(src.includes(SONNET), `${label}/SKILL.md names ${SONNET}`);
    assert.match(src, /Default model: `claude-sonnet-5`/,
      `${label}/SKILL.md states the swarm default is claude-sonnet-5`);
    assert.match(src, /The \*\*coder\*\* \(Phase 2\) runs on this\s+default tier/,
      `${label}/SKILL.md dispatches the coder on the default tier`);
  }
});

// ===========================================================================
// Scenario: SKILL Model-routing puts the tester on the cheap claude-haiku-4-5 tier
// ===========================================================================
test('Scenario: SKILL Model-routing routes the tester (Phase 3) to the cheap claude-haiku-4-5 tier', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    assert.ok(src.includes(HAIKU), `${label}/SKILL.md names ${HAIKU}`);
    assert.match(src, /Cheap tier `claude-haiku-4-5` for the tester \(Phase 3\)/,
      `${label}/SKILL.md routes the tester to the cheap claude-haiku-4-5 tier`);
    assert.match(src, /falls back to `claude-sonnet-5` only if `claude-haiku-4-5` is unavailable/,
      `${label}/SKILL.md degrades the tester to the default when the cheap tier is unavailable`);
  }
});

// ===========================================================================
// Scenario: SKILL Model-routing reserves claude-opus-4-8 for planning + review
// ===========================================================================
test('Scenario: SKILL Model-routing reserves claude-opus-4-8 for the BA (plan) + tech-lead (review) only', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    assert.ok(src.includes(OPUS), `${label}/SKILL.md names ${OPUS}`);
    assert.match(src, /Premium tier `claude-opus-4-8` for planning and review only/,
      `${label}/SKILL.md reserves claude-opus-4-8 for planning + review`);
    assert.match(src, /BA falls back to\s+the default `claude-sonnet-5` only if `claude-opus-4-8` is unavailable/,
      `${label}/SKILL.md degrades the BA to the default when the premium tier is unavailable`);
    // And the retired Fable-5 planning pin is gone.
    assert.ok(!src.includes('claude-fable-5'), `${label}/SKILL.md no longer names the retired claude-fable-5`);
  }
});

// ===========================================================================
// Scenario: Both SKILL.md copies byte-identical
// ===========================================================================
test('Scenario: Both SKILL.md copies are byte-identical', () => {
  const bundled = fs.readFileSync(ASSETS_SKILL);
  const project = fs.readFileSync(PROJECT_SKILL);
  assert.ok(bundled.equals(project),
    'assets/skills/orchestrate/SKILL.md === .claude/skills/orchestrate/SKILL.md (byte-for-byte)');
});

// ===========================================================================
// Scenario: The four agent defs declare their routed model
// ===========================================================================
const AGENT_MODEL = {
  'ba.md': { name: 'orchestrate-ba', model: OPUS, tools: ['Read', 'Grep', 'Glob'] },
  'tech-lead.md': { name: 'orchestrate-tech-lead', model: OPUS, tools: ['Read', 'Grep', 'Glob'] },
  'coder.md': { name: 'orchestrate-coder', model: SONNET, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
  'tester.md': { name: 'orchestrate-tester', model: HAIKU, tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] },
};

test('Scenario: BA + tech-lead frontmatter declare model claude-opus-4-8; coder declares claude-sonnet-5; tester declares claude-haiku-4-5', () => {
  for (const [label, dir] of [['assets', ASSETS_AGENTS], ['.claude', PROJECT_AGENTS]]) {
    for (const [file, exp] of Object.entries(AGENT_MODEL)) {
      const parsed = parseAgentFrontmatter(readFileLF(path.join(dir, file)));
      assert.ok(parsed, `${label}/agents/${file} has a frontmatter block`);
      const { fm } = parsed;
      assert.equal(fm.model, exp.model, `${label}/${file} model is ${exp.model}`);
      assert.equal(fm.name, exp.name, `${label}/${file} name unchanged`);
      assert.deepEqual(parseTools(fm.tools), exp.tools, `${label}/${file} tools unchanged`);
      assert.ok(typeof fm.description === 'string' && fm.description.length > 0,
        `${label}/${file} description unchanged`);
    }
  }
});

// ===========================================================================
// Scenario: Every agent def copy is byte-identical
// ===========================================================================
test('Scenario: Every agent def copy is byte-identical', () => {
  for (const f of Object.keys(AGENT_MODEL)) {
    const bundled = fs.readFileSync(path.join(ASSETS_AGENTS, f));
    const project = fs.readFileSync(path.join(PROJECT_AGENTS, f));
    assert.ok(bundled.equals(project), `assets/agents/${f} === .claude/agents/${f} (byte-for-byte)`);
  }
});

// ===========================================================================
// Scenario: All model ids live before Phase 2 — nothing restates one after
// ===========================================================================
test('Scenario: The routing directive lives before Phase 2 — Phase 2/3/4 name no model id', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    const tail = phase234Slice(src);
    assert.ok(!tail.includes(SONNET), `${label}/SKILL.md Phase 2/3/4 must NOT name ${SONNET}`);
    assert.ok(!tail.includes(OPUS), `${label}/SKILL.md Phase 2/3/4 must NOT name ${OPUS}`);
    assert.ok(!tail.includes(HAIKU), `${label}/SKILL.md Phase 2/3/4 must NOT name ${HAIKU}`);
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(src.lastIndexOf(SONNET) < phase2Idx, `${label}/SKILL.md: every ${SONNET} mention is before Phase 2`);
    assert.ok(src.lastIndexOf(OPUS) < phase2Idx, `${label}/SKILL.md: every ${OPUS} mention is before Phase 2`);
    assert.ok(src.lastIndexOf(HAIKU) < phase2Idx, `${label}/SKILL.md: every ${HAIKU} mention is before Phase 2`);
  }
});

// ===========================================================================
// Scenario: The distilled-returns cost lever is stated
// ===========================================================================
test('Scenario: SKILL states distilled returns — the orchestrator never inherits a sub-agent\'s raw context', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    assert.match(src, /Distilled returns/, `${label}/SKILL.md has a Distilled returns rule`);
    assert.match(src, /compact, distilled summary/i, `${label}/SKILL.md asks each sub-agent for a distilled summary`);
    assert.match(src, /never inherit(s|ing)? a sub-agent's raw context/i,
      `${label}/SKILL.md: orchestrator never inherits raw sub-agent context`);
  }
});

// ===========================================================================
// Scenario (FAILURE/edge): assets SKILL copy drifts -> byte-identity guard fails
// Simulated IN MEMORY — the real files are never edited.
// ===========================================================================
test('Scenario (FAILURE/edge): a drifted SKILL.md copy fails the byte-identity guard (in-memory)', () => {
  const bundled = fs.readFileSync(ASSETS_SKILL);
  const project = fs.readFileSync(PROJECT_SKILL);
  assert.ok(bundled.equals(project), 'precondition: the real copies are identical');
  const drifted = Buffer.from(bundled);
  drifted[drifted.length - 1] = drifted[drifted.length - 1] ^ 0x01;
  assert.ok(!drifted.equals(project), 'a one-byte drift is detected by Buffer.equals');
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real SKILL.md copies remain byte-identical after the in-memory mutation');
});

// ===========================================================================
// Scenario (FAILURE/edge): a missing / misspelled model id fails the presence guard
// Simulated IN MEMORY — the real files are never edited.
// ===========================================================================
test('Scenario (FAILURE/edge): a misspelled model id ("claude-sonet-5") fails the presence guard (in-memory)', () => {
  assert.ok(skillAssetsSrc.includes(SONNET), 'precondition: real text contains claude-sonnet-5');
  const typo = skillAssetsSrc.replace(/claude-sonnet-5/g, 'claude-sonet-5');
  assert.ok(!typo.includes(SONNET),
    'the presence guard rejects text where claude-sonnet-5 is misspelled');
  const removed = skillAssetsSrc.split('\n').filter((l) => !l.includes(OPUS)).join('\n');
  assert.ok(!removed.includes(OPUS),
    'the presence guard fails when the claude-opus-4-8 premium tier is missing');
  assert.ok(readFileLF(ASSETS_SKILL).includes(SONNET),
    'real assets/SKILL.md still contains claude-sonnet-5 after the in-memory mutation');
});
