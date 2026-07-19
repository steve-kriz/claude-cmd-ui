'use strict';

// ===========================================================================
// TASK-051 — unit tests: planning phase runs on Fable 5 with an Opus 4.8 fallback
//
// Fine-grained assertions over the real instruction files (SKILL.md + ba.md, in
// both the assets/ canonical and .claude/ project copies): directive presence,
// exact model ids, byte-identity via Buffer.equals, ba.md frontmatter model key
// with unchanged name/tools, Phase-1-only scope, and no model key on the other
// agent defs. No DB / network / Electron — pure file reads. The two edge cases
// are simulated with IN-MEMORY mutation only.
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

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

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

// --- SKILL.md: exact model ids present in both copies ----------------------

test('unit: both SKILL.md copies contain the exact id claude-fable-5', () => {
  assert.ok(skillAssetsSrc.includes(FABLE), 'assets copy names claude-fable-5');
  assert.ok(skillProjectSrc.includes(FABLE), '.claude copy names claude-fable-5');
});

test('unit: both SKILL.md copies contain the exact id claude-opus-4-8', () => {
  assert.ok(skillAssetsSrc.includes(OPUS), 'assets copy names claude-opus-4-8');
  assert.ok(skillProjectSrc.includes(OPUS), '.claude copy names claude-opus-4-8');
});

test('unit: neither copy contains a common typo of the model ids', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.ok(!src.includes('claude-fabel-5'), 'no claude-fabel-5 typo');
    assert.ok(!src.includes('claude-opus-4.8'), 'no dotted claude-opus-4.8 variant');
  }
});

// --- SKILL.md: explicit preferred + fallback wording -----------------------

test('unit: SKILL Phase-1 dispatch bullet has explicit "when available ... otherwise fall back" wording', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(
      src,
      /Dispatch this planning subagent on `claude-fable-5` when\s+available, otherwise fall back to `claude-opus-4-8`/,
      'preferred-then-fallback sentence with both exact ids',
    );
  }
});

test('unit: SKILL Phase-1 launch step repeats "dispatched on ... when available, otherwise ..."', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(
      src,
      /dispatched on `claude-fable-5` when available,\s+otherwise `claude-opus-4-8`/,
      'launch-step sentence with both exact ids and otherwise wording',
    );
  }
});

test('unit: the directive is explicitly scoped to Phase 1 planning only', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(src, /applies to Phase 1 planning only/);
  }
});

// --- SKILL.md: byte-identity -----------------------------------------------

test('unit: the two SKILL.md copies are byte-identical (Buffer.equals)', () => {
  const a = fs.readFileSync(ASSETS_SKILL);
  const b = fs.readFileSync(PROJECT_SKILL);
  assert.ok(a.equals(b), 'SKILL.md copies byte-for-byte identical');
});

// --- SKILL.md: Phase-1-only scope ------------------------------------------

test('unit: model ids appear only before the "## Phase 2 — Build" heading', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(phase2Idx !== -1, 'Phase 2 heading present');
    // First and last occurrences both precede Phase 2.
    assert.ok(src.indexOf(FABLE) !== -1 && src.lastIndexOf(FABLE) < phase2Idx,
      'all claude-fable-5 mentions precede Phase 2');
    assert.ok(src.indexOf(OPUS) !== -1 && src.lastIndexOf(OPUS) < phase2Idx,
      'all claude-opus-4-8 mentions precede Phase 2');
  }
});

test('unit: Phase 2, 3 and 4 sections each contain neither model id', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    const p2 = src.indexOf('## Phase 2 — Build');
    const p3 = src.indexOf('## Phase 3 — Test');
    const p4 = src.indexOf('## Phase 4 — Tech-lead review');
    assert.ok(p2 !== -1 && p3 !== -1 && p4 !== -1, 'all phase headings present');
    const sections = {
      'Phase 2': src.slice(p2, p3),
      'Phase 3': src.slice(p3, p4),
      'Phase 4': src.slice(p4),
    };
    for (const [label, text] of Object.entries(sections)) {
      assert.ok(!text.includes(FABLE), `${label} does not name ${FABLE}`);
      assert.ok(!text.includes(OPUS), `${label} does not name ${OPUS}`);
    }
  }
});

// --- ba.md frontmatter ------------------------------------------------------

for (const [label, dir] of [['assets', ASSETS_AGENTS], ['.claude', PROJECT_AGENTS]]) {
  test(`unit: ${label}/agents/ba.md declares model: claude-fable-5`, () => {
    const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, 'ba.md')));
    assert.equal(fm.model, FABLE);
  });

  test(`unit: ${label}/agents/ba.md keeps name orchestrate-ba and tools Read, Grep, Glob unchanged`, () => {
    const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, 'ba.md')));
    assert.equal(fm.name, 'orchestrate-ba');
    assert.deepEqual(parseTools(fm.tools), ['Read', 'Grep', 'Glob']);
    assert.ok(typeof fm.description === 'string' && fm.description.length > 0, 'description still present');
    for (const forbidden of ['Edit', 'Write', 'Bash']) {
      assert.ok(!parseTools(fm.tools).includes(forbidden), `ba.md has no ${forbidden}`);
    }
  });
}

test('unit: ba.md frontmatter still parses cleanly (valid frontmatter block)', () => {
  for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
    const parsed = parseAgentFrontmatter(readFileLF(path.join(dir, 'ba.md')));
    assert.ok(parsed && parsed.fm, 'ba.md parses to a frontmatter object');
  }
});

// --- ba.md byte-identity ----------------------------------------------------

test('unit: the two ba.md copies are byte-identical (Buffer.equals)', () => {
  const a = fs.readFileSync(path.join(ASSETS_AGENTS, 'ba.md'));
  const b = fs.readFileSync(path.join(PROJECT_AGENTS, 'ba.md'));
  assert.ok(a.equals(b), 'ba.md copies byte-for-byte identical');
});

// --- other agent defs carry NO model key -----------------------------------

for (const f of ['coder.md', 'tester.md', 'tech-lead.md']) {
  test(`unit: ${f} declares no model key (in both copies)`, () => {
    for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
      const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, f)));
      assert.equal(fm.model, undefined, `${f} has no model key`);
    }
  });
}

// --- FAILURE/edge (in-memory only) -----------------------------------------

test('unit (edge): Buffer.equals detects a single-byte SKILL.md drift (in-memory, real files untouched)', () => {
  const original = fs.readFileSync(ASSETS_SKILL);
  const mutated = Buffer.from(original);
  mutated[0] = mutated[0] ^ 0xff;
  assert.ok(!mutated.equals(fs.readFileSync(PROJECT_SKILL)), 'drift detected');
  // Real files remain identical.
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real copies untouched and still identical');
});

test('unit (edge): the presence guard rejects a missing/misspelled model id (in-memory)', () => {
  // Misspelled.
  const typo = skillAssetsSrc.replace(new RegExp(FABLE, 'g'), 'claude-fabel-5');
  assert.ok(!typo.includes(FABLE), 'misspelled id fails presence check');
  // Missing entirely.
  const removed = skillAssetsSrc.split('\n').filter((l) => !l.includes(OPUS)).join('\n');
  assert.ok(!removed.includes(OPUS), 'removed fallback id fails presence check');
  // ba.md model key misspelled in memory -> frontmatter model !== expected.
  const baTypo = readFileLF(path.join(ASSETS_AGENTS, 'ba.md')).replace(FABLE, 'claude-fabel-5');
  const { fm } = parseAgentFrontmatter(baTypo);
  assert.notEqual(fm.model, FABLE, 'a misspelled ba.md model key is caught');
  // Real file untouched.
  assert.equal(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'ba.md'))).fm.model, FABLE);
});
