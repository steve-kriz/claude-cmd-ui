'use strict';

// ===========================================================================
// TASK-051 — unit tests: cost-optimised model routing for the orchestrate swarm.
//
// The swarm defaults every agent to `claude-sonnet-5` and routes only the two
// hard-reasoning phases — the business analyst (Phase 1) and the tech lead /
// reviewer (Phase 4) — to the premium `claude-opus-4-8` tier. Fine-grained
// assertions over the real instruction files (SKILL.md + the four agent defs, in
// both the assets/ canonical and .claude/ project copies): directive presence,
// exact model ids, byte-identity via Buffer.equals, per-agent frontmatter model
// keys with unchanged name/tools, the "all ids live before Phase 2" scope, and
// the per-agent pins. No DB / network / Electron — pure file reads. The edge
// cases are simulated with IN-MEMORY mutation only.
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

const SONNET = 'claude-sonnet-5'; // the swarm default (coder)
const OPUS = 'claude-opus-4-8';   // the premium tier (BA + tech-lead)
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

// --- SKILL.md: exact model ids present in both copies ----------------------

test('unit: both SKILL.md copies contain the exact id claude-sonnet-5 (the swarm default)', () => {
  assert.ok(skillAssetsSrc.includes(SONNET), 'assets copy names claude-sonnet-5');
  assert.ok(skillProjectSrc.includes(SONNET), '.claude copy names claude-sonnet-5');
});

test('unit: both SKILL.md copies contain the exact id claude-opus-4-8 (the premium tier)', () => {
  assert.ok(skillAssetsSrc.includes(OPUS), 'assets copy names claude-opus-4-8');
  assert.ok(skillProjectSrc.includes(OPUS), '.claude copy names claude-opus-4-8');
});

test('unit: both SKILL.md copies contain the exact id claude-haiku-4-5 (the cheap tester tier)', () => {
  assert.ok(skillAssetsSrc.includes(HAIKU), 'assets copy names claude-haiku-4-5');
  assert.ok(skillProjectSrc.includes(HAIKU), '.claude copy names claude-haiku-4-5');
});

test('unit: SKILL Model-routing routes the tester to the cheap claude-haiku-4-5 tier', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(
      src,
      /Cheap tier `claude-haiku-4-5` for the tester \(Phase 3\)/,
      'cheap tier is claude-haiku-4-5 for the tester only',
    );
    assert.match(
      src,
      /falls back to `claude-sonnet-5` only if `claude-haiku-4-5` is unavailable/,
      'tester falls back to the default claude-sonnet-5',
    );
  }
});

test('unit: neither copy contains a common typo of the model ids, nor the retired claude-fable-5 pin', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.ok(!src.includes('claude-sonet-5'), 'no claude-sonet-5 typo');
    assert.ok(!src.includes('claude-opus-4.8'), 'no dotted claude-opus-4.8 variant');
    // The BA/planning model was retired from Fable 5 to Opus 4.8; no stale pin.
    assert.ok(!src.includes('claude-fable-5'), 'no retired claude-fable-5 planning pin');
  }
});

// --- SKILL.md: explicit default + premium-tier routing wording -------------

test('unit: SKILL Model-routing names claude-sonnet-5 as the default model', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(
      src,
      /Default model: `claude-sonnet-5`/,
      'states the swarm default is claude-sonnet-5',
    );
  }
});

test('unit: SKILL Model-routing reserves claude-opus-4-8 for planning + review only', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(
      src,
      /Premium tier `claude-opus-4-8` for planning and review only/,
      'premium tier is claude-opus-4-8 for BA + tech-lead only',
    );
    // The BA degrades to the default when the premium tier is unavailable.
    assert.match(
      src,
      /BA falls back to\s+the default `claude-sonnet-5` only if `claude-opus-4-8` is unavailable/,
      'BA falls back to the default claude-sonnet-5',
    );
  }
});

test('unit: SKILL Model-routing lives in the Agent-dispatch section (a "### Model routing" heading)', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(src, /### Model routing/, 'has a Model routing subsection');
  }
});

// --- SKILL.md: byte-identity -----------------------------------------------

test('unit: the two SKILL.md copies are byte-identical (Buffer.equals)', () => {
  const a = fs.readFileSync(ASSETS_SKILL);
  const b = fs.readFileSync(PROJECT_SKILL);
  assert.ok(a.equals(b), 'SKILL.md copies byte-for-byte identical');
});

// --- SKILL.md: all model ids live before the Phase 2 heading ----------------

test('unit: model ids appear only before the "## Phase 2 — Build" heading', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(phase2Idx !== -1, 'Phase 2 heading present');
    // Every id mention precedes Phase 2 (the routing directive is stated once).
    assert.ok(src.indexOf(SONNET) !== -1 && src.lastIndexOf(SONNET) < phase2Idx,
      'all claude-sonnet-5 mentions precede Phase 2');
    assert.ok(src.indexOf(OPUS) !== -1 && src.lastIndexOf(OPUS) < phase2Idx,
      'all claude-opus-4-8 mentions precede Phase 2');
    assert.ok(src.indexOf(HAIKU) !== -1 && src.lastIndexOf(HAIKU) < phase2Idx,
      'all claude-haiku-4-5 mentions precede Phase 2');
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
      assert.ok(!text.includes(SONNET), `${label} does not name ${SONNET}`);
      assert.ok(!text.includes(OPUS), `${label} does not name ${OPUS}`);
      assert.ok(!text.includes(HAIKU), `${label} does not name ${HAIKU}`);
    }
  }
});

// --- SKILL.md: distilled-returns cost lever --------------------------------

test('unit: SKILL states the distilled-returns rule (orchestrator never inherits raw sub-agent context)', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(src, /Distilled returns/, 'has a Distilled returns subsection');
    assert.match(src, /never inherit(s|ing)? a sub-agent's raw context/i,
      'states the orchestrator never inherits raw sub-agent context');
  }
});

// --- agent frontmatter: per-role model pins --------------------------------

const AGENT_MODEL = {
  'ba.md': { name: 'orchestrate-ba', model: OPUS, tools: ['Read', 'Grep', 'Glob'] },
  'tech-lead.md': { name: 'orchestrate-tech-lead', model: OPUS, tools: ['Read', 'Grep', 'Glob'] },
  'coder.md': { name: 'orchestrate-coder', model: SONNET, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
  'tester.md': { name: 'orchestrate-tester', model: HAIKU, tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] },
};

for (const [label, dir] of [['assets', ASSETS_AGENTS], ['.claude', PROJECT_AGENTS]]) {
  for (const [file, exp] of Object.entries(AGENT_MODEL)) {
    test(`unit: ${label}/agents/${file} declares model: ${exp.model}`, () => {
      const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, file)));
      assert.equal(fm.model, exp.model);
    });

    test(`unit: ${label}/agents/${file} keeps name ${exp.name} and its tools unchanged`, () => {
      const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, file)));
      assert.equal(fm.name, exp.name);
      assert.deepEqual(parseTools(fm.tools), exp.tools);
      assert.ok(typeof fm.description === 'string' && fm.description.length > 0, 'description still present');
    });
  }
}

test('unit: the BA and tech-lead are pinned to the premium tier; the coder to the default; the tester to the cheap tier', () => {
  for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
    assert.equal(parseAgentFrontmatter(readFileLF(path.join(dir, 'ba.md'))).fm.model, OPUS);
    assert.equal(parseAgentFrontmatter(readFileLF(path.join(dir, 'tech-lead.md'))).fm.model, OPUS);
    assert.equal(parseAgentFrontmatter(readFileLF(path.join(dir, 'coder.md'))).fm.model, SONNET);
    assert.equal(parseAgentFrontmatter(readFileLF(path.join(dir, 'tester.md'))).fm.model, HAIKU);
  }
});

test('unit: every agent def now carries a model key (no agent is left on the ambient default)', () => {
  for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
    for (const f of Object.keys(AGENT_MODEL)) {
      const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, f)));
      assert.ok(fm.model === OPUS || fm.model === SONNET || fm.model === HAIKU, `${f} pins a known tier`);
    }
  }
});

// --- agent frontmatter: still parses + byte-identical -----------------------

test('unit: each agent def frontmatter still parses cleanly (valid frontmatter block)', () => {
  for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
    for (const f of Object.keys(AGENT_MODEL)) {
      const parsed = parseAgentFrontmatter(readFileLF(path.join(dir, f)));
      assert.ok(parsed && parsed.fm, `${f} parses to a frontmatter object`);
    }
  }
});

test('unit: each agent def copy is byte-identical (Buffer.equals)', () => {
  for (const f of Object.keys(AGENT_MODEL)) {
    const a = fs.readFileSync(path.join(ASSETS_AGENTS, f));
    const b = fs.readFileSync(path.join(PROJECT_AGENTS, f));
    assert.ok(a.equals(b), `${f} copies byte-for-byte identical`);
  }
});

// --- FAILURE/edge (in-memory only) -----------------------------------------

test('unit (edge): Buffer.equals detects a single-byte SKILL.md drift (in-memory, real files untouched)', () => {
  const original = fs.readFileSync(ASSETS_SKILL);
  const mutated = Buffer.from(original);
  mutated[0] = mutated[0] ^ 0xff;
  assert.ok(!mutated.equals(fs.readFileSync(PROJECT_SKILL)), 'drift detected');
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real copies untouched and still identical');
});

test('unit (edge): the presence guard rejects a missing/misspelled model id (in-memory)', () => {
  // Misspelled default.
  const typo = skillAssetsSrc.replace(new RegExp(SONNET, 'g'), 'claude-sonet-5');
  assert.ok(!typo.includes(SONNET), 'misspelled default fails presence check');
  // Premium tier removed entirely.
  const removed = skillAssetsSrc.split('\n').filter((l) => !l.includes(OPUS)).join('\n');
  assert.ok(!removed.includes(OPUS), 'removed premium id fails presence check');
  // ba.md model key misspelled in memory -> frontmatter model !== expected.
  const baTypo = readFileLF(path.join(ASSETS_AGENTS, 'ba.md')).replace(OPUS, 'claude-opus-4.8');
  const { fm } = parseAgentFrontmatter(baTypo);
  assert.notEqual(fm.model, OPUS, 'a misspelled ba.md model key is caught');
  // Real file untouched.
  assert.equal(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'ba.md'))).fm.model, OPUS);
});
