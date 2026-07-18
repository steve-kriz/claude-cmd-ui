'use strict';

// Unit + file/frontmatter + source-scan + cucumber-style tests for TASK-010: the
// dedicated orchestration subagents (business-analyst / coder / tester) and the
// graceful fallback to `general-purpose` when a named agent is missing.
//
// Four layers are under test:
//
//   1. lib/orchestrate-agents.js — the Electron-free, pure agent-type helpers
//      (AGENT_TYPES, AGENT_NAMES, FALLBACK_AGENT, resolveAgentType, isFallback).
//      The module touches no disk/DB/network/Electron, so it is exercised
//      directly with plain `node --test`.
//
//   2. The real agent definition files — assets/agents/{ba,coder,tester}.md
//      (bundled, canonical) and their byte-identical project copies
//      .claude/agents/{ba,coder,tester}.md — parsed for valid Claude Code
//      frontmatter (name/description/tools) with per-role tool scoping.
//
//   3. Both SKILL.md copies (.claude + assets) — asserted to dispatch each phase
//      to its dedicated agent, to keep the documented general-purpose fallback,
//      and to stay byte-identical (drift guard). main.js's tasks:installSkill is
//      source-scanned to prove it propagates assets/agents/* into the project.
//
//   4. Gherkin e2e scenarios from tasks/TASK-010, driven over a FRESH temp
//      project dir (os.tmpdir + node:fs, cleaned up after) for the install
//      propagation, and over the pure lib/ticket-queue.js helpers for the
//      still-concurrent build behaviour.
//
// NO DATABASE, REAL DB CONNECTION, OR NETWORK CALL IS MADE. The only real disk
// access is (a) reading the app's own agent/skill/main source as fixtures and
// (b) copying into a throwaway os.tmpdir directory that is removed on teardown —
// exactly the documented tasks:installSkill file copy, with no Electron/IPC in
// the loop.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FALLBACK_AGENT,
  AGENT_TYPES,
  AGENT_NAMES,
  resolveAgentType,
  isFallback,
} = require('../lib/orchestrate-agents');

// The still-in-force concurrency/claim helpers, reused to prove parallel builds
// obey the bound and one-agent-per-ticket rule after TASK-010.
const {
  selectNextBatch,
  claimTicket,
  activeCount,
  DEFAULT_CONCURRENCY,
} = require('../lib/ticket-queue');

const ROOT = path.join(__dirname, '..');
const ASSETS_AGENTS = path.join(ROOT, 'assets', 'agents');
const PROJECT_AGENTS = path.join(ROOT, '.claude', 'agents');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const MAIN = path.join(ROOT, 'main.js');

const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];

// Expected name + tool scoping per role file (the ticket's canonical contract).
const EXPECTED = {
  'ba.md': {
    name: 'orchestrate-ba',
    hasTools: ['Read', 'Grep', 'Glob'],
    forbidTools: ['Edit', 'Write', 'Bash'],
  },
  'coder.md': {
    name: 'orchestrate-coder',
    hasTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    forbidTools: [],
  },
  'tester.md': {
    name: 'orchestrate-tester',
    hasTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
    forbidTools: [],
  },
  // TASK-018: the fourth role — the read-only tech-lead / reviewer. Same tool
  // scoping as the BA (Read/Grep/Glob only, no Edit/Write/Bash).
  'tech-lead.md': {
    name: 'orchestrate-tech-lead',
    hasTools: ['Read', 'Grep', 'Glob'],
    forbidTools: ['Edit', 'Write', 'Bash'],
  },
};

// --- Minimal flat-YAML frontmatter parser (no deps) ------------------------
// Handles the two shapes these agent files use: inline `key: value` scalars and
// a folded block scalar (`description: >-` followed by indented lines). Returns
// { fm, body } or null when there is no valid frontmatter block.
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
      // Folded/literal block scalar: gather following more-indented lines.
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

// Split a `tools:` frontmatter value ("Read, Grep, Glob") into a token list.
function parseTools(val) {
  return String(val || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const skillProjectSrc = readFileLF(PROJECT_SKILL);
const mainSrc = readFileLF(MAIN);

// ===========================================================================
// PART 1 — Unit tests: lib/orchestrate-agents.js pure helpers
// ===========================================================================

test('AGENT_TYPES maps each role to its orchestrate-* name', () => {
  assert.equal(AGENT_TYPES.ba, 'orchestrate-ba');
  assert.equal(AGENT_TYPES.coder, 'orchestrate-coder');
  assert.equal(AGENT_TYPES.tester, 'orchestrate-tester');
  // TASK-018: the fourth role, the tech-lead / reviewer.
  assert.equal(AGENT_TYPES.techLead, 'orchestrate-tech-lead');
});

test('AGENT_NAMES contains exactly the four orchestrate-* names (plan->build->test->review order)', () => {
  assert.deepEqual(AGENT_NAMES, [
    'orchestrate-ba',
    'orchestrate-coder',
    'orchestrate-tester',
    'orchestrate-tech-lead',
  ]);
  for (const n of ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tester', 'orchestrate-tech-lead']) {
    assert.ok(AGENT_NAMES.includes(n), `${n} present in AGENT_NAMES`);
  }
  // The reviewer is appended after the tester (build->test->review ordering).
  assert.equal(AGENT_NAMES.indexOf('orchestrate-tech-lead'), AGENT_NAMES.indexOf('orchestrate-tester') + 1);
});

test('AGENT_TYPES / AGENT_NAMES are frozen (constants, not mutable state)', () => {
  assert.ok(Object.isFrozen(AGENT_TYPES));
  assert.ok(Object.isFrozen(AGENT_NAMES));
});

test('FALLBACK_AGENT is general-purpose', () => {
  assert.equal(FALLBACK_AGENT, 'general-purpose');
});

// --- resolveAgentType ------------------------------------------------------

test('resolveAgentType: a present name resolves to itself (availableAgents as Array)', () => {
  const available = [...AGENT_NAMES];
  for (const n of AGENT_NAMES) {
    assert.equal(resolveAgentType(n, available), n, `${n} present -> itself`);
  }
});

test('resolveAgentType: a present name resolves to itself (availableAgents as Set)', () => {
  const available = new Set(AGENT_NAMES);
  for (const n of AGENT_NAMES) {
    assert.equal(resolveAgentType(n, available), n, `${n} present in Set -> itself`);
  }
});

test('resolveAgentType: a missing name falls back to general-purpose (Array and Set)', () => {
  assert.equal(resolveAgentType('orchestrate-coder', ['orchestrate-ba']), FALLBACK_AGENT,
    'coder missing from the array -> fallback');
  assert.equal(resolveAgentType('orchestrate-tester', new Set(['orchestrate-ba'])), FALLBACK_AGENT,
    'tester missing from the set -> fallback');
  // No agents available at all.
  assert.equal(resolveAgentType('orchestrate-ba', []), FALLBACK_AGENT);
  assert.equal(resolveAgentType('orchestrate-ba', new Set()), FALLBACK_AGENT);
});

test('resolveAgentType: empty / null / junk name -> fallback (never throws)', () => {
  const available = ['orchestrate-ba'];
  for (const bad of ['', null, undefined, 42, {}, [], NaN]) {
    assert.equal(resolveAgentType(bad, available), FALLBACK_AGENT,
      `${JSON.stringify(bad)} -> fallback`);
  }
});

test('resolveAgentType: junk availableAgents (null/undefined/non-collection) -> fallback', () => {
  for (const bad of [null, undefined, 'orchestrate-ba', 42, {}]) {
    assert.equal(resolveAgentType('orchestrate-ba', bad), FALLBACK_AGENT,
      `availableAgents=${JSON.stringify(bad)} treated as none available`);
  }
});

test('resolveAgentType: general-purpose is returned as-is when it is available', () => {
  assert.equal(resolveAgentType('general-purpose', ['general-purpose']), 'general-purpose');
});

// --- isFallback ------------------------------------------------------------

test('isFallback: true when the dedicated agent is missing', () => {
  assert.equal(isFallback('orchestrate-coder', ['orchestrate-ba']), true);
  assert.equal(isFallback('orchestrate-tester', new Set()), true);
  assert.equal(isFallback('orchestrate-ba', null), true);
});

test('isFallback: false when the dedicated agent is present', () => {
  const available = [...AGENT_NAMES];
  for (const n of AGENT_NAMES) assert.equal(isFallback(n, available), false, `${n} present -> not fallback`);
});

test('isFallback: general-purpose itself is not counted as a fallback', () => {
  // Asking to resolve general-purpose (present or not) is not "the dedicated
  // agent was missing" — isFallback guards against that self-report.
  assert.equal(isFallback('general-purpose', ['general-purpose']), false);
  assert.equal(isFallback('general-purpose', []), false);
});

// ===========================================================================
// PART 2 — File / frontmatter guards: the real agent definition files
// ===========================================================================

test('all six agent files exist (bundled assets/ + project .claude/)', () => {
  for (const f of AGENT_FILES) {
    assert.ok(fs.existsSync(path.join(ASSETS_AGENTS, f)), `assets/agents/${f} exists`);
    assert.ok(fs.existsSync(path.join(PROJECT_AGENTS, f)), `.claude/agents/${f} exists`);
  }
});

for (const dirLabel of ['assets/agents', '.claude/agents']) {
  const dir = dirLabel === 'assets/agents' ? ASSETS_AGENTS : PROJECT_AGENTS;
  for (const f of AGENT_FILES) {
    test(`${dirLabel}/${f} has valid frontmatter (name, description, tools) with the expected name`, () => {
      const parsed = parseAgentFrontmatter(readFileLF(path.join(dir, f)));
      assert.ok(parsed, `${dirLabel}/${f} has a frontmatter block`);
      const { fm } = parsed;
      assert.ok(typeof fm.name === 'string' && fm.name.length, 'name present');
      assert.ok(typeof fm.description === 'string' && fm.description.length, 'description present');
      assert.ok(typeof fm.tools === 'string' && fm.tools.length, 'tools present');
      assert.equal(fm.name, EXPECTED[f].name, `name is ${EXPECTED[f].name}`);
    });

    test(`${dirLabel}/${f} tool scoping matches its role`, () => {
      const { fm } = parseAgentFrontmatter(readFileLF(path.join(dir, f)));
      const tools = parseTools(fm.tools);
      for (const t of EXPECTED[f].hasTools) {
        assert.ok(tools.includes(t), `${EXPECTED[f].name} has ${t}`);
      }
      for (const t of EXPECTED[f].forbidTools) {
        assert.ok(!tools.includes(t), `${EXPECTED[f].name} must NOT have ${t}`);
      }
    });
  }
}

test('BA is read-only: no Edit/Write/Bash; coder and tester both carry Bash', () => {
  const ba = parseTools(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'ba.md'))).fm.tools);
  const coder = parseTools(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'coder.md'))).fm.tools);
  const tester = parseTools(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'tester.md'))).fm.tools);
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(!ba.includes(t), `BA lacks ${t}`);
  assert.ok(coder.includes('Edit') && coder.includes('Write') && coder.includes('Bash'), 'coder has edit/write/bash');
  assert.ok(tester.includes('Write') && tester.includes('Edit') && tester.includes('Bash'), 'tester has write/edit/bash');
});

test('each bundled agent file is byte-identical to its project copy', () => {
  for (const f of AGENT_FILES) {
    const bundled = fs.readFileSync(path.join(ASSETS_AGENTS, f));
    const project = fs.readFileSync(path.join(PROJECT_AGENTS, f));
    assert.ok(bundled.equals(project), `assets/agents/${f} === .claude/agents/${f} (byte-for-byte)`);
  }
});

test('the three parsed names are exactly the AGENT_NAMES from the lib', () => {
  const names = AGENT_FILES
    .map((f) => parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, f))).fm.name)
    .sort();
  assert.deepEqual(names, [...AGENT_NAMES].sort());
});

// ===========================================================================
// PART 3 — SKILL dispatch + drift guards
// ===========================================================================

test('both SKILL.md copies reference all three orchestrate-* agent type names', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    for (const n of AGENT_NAMES) {
      assert.ok(src.includes(n), `${label}/SKILL.md references ${n}`);
    }
  }
});

test('the SKILL dispatches each phase to its dedicated agent (BA->plan, coder->build, tester->test)', () => {
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    // Phase 1 plan -> orchestrate-ba, Phase 2 build -> orchestrate-coder,
    // Phase 3 test -> orchestrate-tester (ordered appearance in the doc).
    const baIdx = src.indexOf('orchestrate-ba');
    const coderIdx = src.indexOf('orchestrate-coder');
    const testerIdx = src.indexOf('orchestrate-tester');
    assert.ok(baIdx !== -1 && coderIdx !== -1 && testerIdx !== -1, 'all three named');
    // The dispatch instructions name each agent in the Task-tool launch lines.
    assert.match(src, /Task tool,\s*`orchestrate-ba`/);
    assert.match(src, /Task tool,\s*`orchestrate-coder`/);
    assert.match(src, /Task tool,\s*`orchestrate-tester`/);
  }
});

test('no phase dispatches a generic general-purpose AS the phase agent, but the fallback wording remains', () => {
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    // The phase agent is never `general-purpose` — it is always named in a
    // "Task tool, `general-purpose`" launch line. Assert that pattern is absent.
    assert.ok(!/Task tool,\s*`general-purpose`/.test(src),
      `${label}/SKILL.md never dispatches a phase to Task tool general-purpose`);
    // The documented graceful fallback sentence still exists (general-purpose may
    // legitimately appear there).
    assert.match(src, /fall back to\s*[`]?general-purpose[`]?/i,
      `${label}/SKILL.md keeps the graceful general-purpose fallback wording`);
    // The three phases each carry the "fall back to general-purpose and report"
    // instruction next to their dedicated agent name.
    assert.match(src, /`orchestrate-ba`;\s*fall back to[\s\S]*?`general-purpose`/);
    assert.match(src, /`orchestrate-coder`;\s*fall back to[\s\S]*?`general-purpose`/);
    assert.match(src, /`orchestrate-tester`;\s*fall back to[\s\S]*?`general-purpose`/);
  }
});

test('the two SKILL.md copies are byte-identical (drift guard)', () => {
  const bundled = fs.readFileSync(ASSETS_SKILL);
  const project = fs.readFileSync(PROJECT_SKILL);
  assert.ok(bundled.equals(project), 'assets/skills/orchestrate/SKILL.md === .claude/skills/orchestrate/SKILL.md');
});

test('tasks:installSkill (main.js) copies assets/agents/* into <project>/.claude/agents/', () => {
  // Source-scan guard: the handler resolves the bundled agents dir, the project
  // agents dir, mkdirs it, and readdir/readFile/writeFile-loops the agent files.
  const start = mainSrc.indexOf("ipcMain.handle('tasks:installSkill'");
  assert.ok(start !== -1, 'tasks:installSkill handler present');
  const body = mainSrc.slice(start, mainSrc.indexOf('\n});', start));
  assert.match(body, /path\.join\(__dirname,\s*'assets',\s*'agents'\)/);
  assert.match(body, /path\.join\(projectPath,\s*'\.claude',\s*'agents'\)/);
  assert.match(body, /fsp\.mkdir\(agentsDestDir,\s*\{\s*recursive:\s*true\s*\}\)/);
  assert.match(body, /for\s*\(const name of await fsp\.readdir\(agentsSrcDir\)\)/);
  // And it still copies the skill + creates tasks/.
  assert.match(body, /path\.join\(projectPath,\s*'\.claude',\s*'skills',\s*'orchestrate'\)/);
  assert.match(body, /fsp\.mkdir\(path\.join\(projectPath,\s*'tasks'\)/);
});

// ===========================================================================
// PART 4 — installSkill propagation against a FRESH temp project dir
//
// Replicates tasks:installSkill's DOCUMENTED file-copy behaviour (main.js ~526)
// with node:fs into an os.tmpdir() throwaway directory — no Electron, no IPC, no
// DB. Asserts the fresh project ends up with the skill AND all three agent defs,
// and that the copies are byte-identical to the bundled sources.
// ===========================================================================

// The exact copy the IPC handler performs, factored out so the test drives the
// real documented behaviour rather than a paraphrase.
function installSkillInto(projectPath) {
  const skillSrcDir = path.join(ROOT, 'assets', 'skills', 'orchestrate');
  const skillDestDir = path.join(projectPath, '.claude', 'skills', 'orchestrate');
  fs.mkdirSync(skillDestDir, { recursive: true });
  for (const name of fs.readdirSync(skillSrcDir)) {
    fs.writeFileSync(path.join(skillDestDir, name), fs.readFileSync(path.join(skillSrcDir, name)));
  }
  const agentsSrcDir = path.join(ROOT, 'assets', 'agents');
  const agentsDestDir = path.join(projectPath, '.claude', 'agents');
  fs.mkdirSync(agentsDestDir, { recursive: true });
  for (const name of fs.readdirSync(agentsSrcDir)) {
    fs.writeFileSync(path.join(agentsDestDir, name), fs.readFileSync(path.join(agentsSrcDir, name)));
  }
  fs.mkdirSync(path.join(projectPath, 'tasks'), { recursive: true });
  return { ok: true };
}

function withTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-install-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('installSkill propagation: a fresh project gets the skill AND all three agent defs', () => {
  withTempProject((proj) => {
    // Given a brand-new project with no .claude/ yet.
    assert.ok(!fs.existsSync(path.join(proj, '.claude')), 'no .claude before install');
    // When the skill is installed (documented copy behaviour).
    const r = installSkillInto(proj);
    assert.equal(r.ok, true);
    // Then the skill lands in .claude/skills/orchestrate/SKILL.md ...
    const installedSkill = path.join(proj, '.claude', 'skills', 'orchestrate', 'SKILL.md');
    assert.ok(fs.existsSync(installedSkill), 'SKILL.md installed');
    // ... and all three agent defs land in .claude/agents/ ...
    for (const f of AGENT_FILES) {
      const p = path.join(proj, '.claude', 'agents', f);
      assert.ok(fs.existsSync(p), `.claude/agents/${f} installed into the fresh project`);
    }
    // ... and the tasks/ folder is created.
    assert.ok(fs.existsSync(path.join(proj, 'tasks')), 'tasks/ created');
  });
});

test('installSkill propagation: installed files are byte-identical to the bundled sources', () => {
  withTempProject((proj) => {
    installSkillInto(proj);
    // Agents byte-for-byte.
    for (const f of AGENT_FILES) {
      const installed = fs.readFileSync(path.join(proj, '.claude', 'agents', f));
      const bundled = fs.readFileSync(path.join(ASSETS_AGENTS, f));
      assert.ok(installed.equals(bundled), `installed ${f} === bundled ${f}`);
    }
    // Skill byte-for-byte.
    const installedSkill = fs.readFileSync(path.join(proj, '.claude', 'skills', 'orchestrate', 'SKILL.md'));
    const bundledSkill = fs.readFileSync(ASSETS_SKILL);
    assert.ok(installedSkill.equals(bundledSkill), 'installed SKILL.md === bundled SKILL.md');
  });
});

test('installSkill propagation: the installed agent defs parse to the three orchestrate-* names', () => {
  withTempProject((proj) => {
    installSkillInto(proj);
    const names = AGENT_FILES
      .map((f) => parseAgentFrontmatter(readFileLF(path.join(proj, '.claude', 'agents', f))).fm.name)
      .sort();
    assert.deepEqual(names, [...AGENT_NAMES].sort(), 'a fresh project can dispatch to all three agents');
  });
});

// ===========================================================================
// PART 5 — Feature: dedicated orchestration subagents (Gherkin scenarios)
//
// tasks/TASK-010. Driven over the real lib helpers + the FRESH temp-project
// install above. NO DB / network / Electron.
// ===========================================================================

test('Scenario: The three agent definitions exist with valid frontmatter', () => {
  // Given the orchestrate workflow needs BA / coder / tester agents
  // Then each agent file exists with name/description/tools frontmatter.
  for (const f of AGENT_FILES) {
    const parsed = parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, f)));
    assert.ok(parsed && parsed.fm.name && parsed.fm.description && parsed.fm.tools,
      `${f} is a valid agent definition`);
    assert.equal(parsed.fm.name, EXPECTED[f].name);
  }
});

test('Scenario: The agents\' tools match their roles', () => {
  // Given the three role definitions
  // Then the BA cannot edit/write/run, while the coder and tester can.
  const ba = parseTools(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'ba.md'))).fm.tools);
  const coder = parseTools(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'coder.md'))).fm.tools);
  const tester = parseTools(parseAgentFrontmatter(readFileLF(path.join(ASSETS_AGENTS, 'tester.md'))).fm.tools);
  assert.deepEqual(ba, ['Read', 'Grep', 'Glob'], 'BA is read/search only');
  for (const t of ['Edit', 'Write', 'Bash']) {
    assert.ok(coder.includes(t), `coder can ${t}`);
    assert.ok(tester.includes(t), `tester can ${t}`);
  }
});

test('Scenario: The skill dispatches each phase to its agent', () => {
  // Given the orchestrate skill
  // Then Phase 1 -> orchestrate-ba, Phase 2 -> orchestrate-coder, Phase 3 -> orchestrate-tester.
  for (const src of [skillAssetsSrc, skillProjectSrc]) {
    assert.match(src, /Phase 1[\s\S]*?orchestrate-ba/);
    assert.match(src, /Phase 2[\s\S]*?orchestrate-coder/);
    assert.match(src, /Phase 3[\s\S]*?orchestrate-tester/);
  }
});

test('Scenario: The change is present in the bundled (canonical) source', () => {
  // Given the app ships the canonical definitions under assets/
  // Then the bundled skill and all three bundled agent files carry the change.
  assert.ok(fs.existsSync(ASSETS_SKILL), 'bundled skill present');
  for (const n of AGENT_NAMES) assert.ok(skillAssetsSrc.includes(n), `bundled skill names ${n}`);
  for (const f of AGENT_FILES) assert.ok(fs.existsSync(path.join(ASSETS_AGENTS, f)), `bundled ${f} present`);
});

test('Scenario: Installing into a fresh project propagates the agents', () => {
  withTempProject((proj) => {
    // When the orchestrate skill is installed into a fresh project
    installSkillInto(proj);
    // Then that project has the three dedicated agents available to dispatch.
    for (const f of AGENT_FILES) {
      assert.ok(fs.existsSync(path.join(proj, '.claude', 'agents', f)), `${f} propagated`);
    }
    assert.ok(fs.existsSync(path.join(proj, '.claude', 'skills', 'orchestrate', 'SKILL.md')), 'skill propagated');
  });
});

test('Scenario: Project and bundled skills stay in sync', () => {
  // Given both copies of the skill and each agent file
  // Then they are byte-identical (no drift between canonical and project copy).
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)), 'skills in sync');
  for (const f of AGENT_FILES) {
    assert.ok(fs.readFileSync(path.join(ASSETS_AGENTS, f)).equals(fs.readFileSync(path.join(PROJECT_AGENTS, f))),
      `${f} in sync`);
  }
});

test('Scenario: Parallel builds still obey the concurrency rules', () => {
  // Given a board with more todo tickets than the concurrency bound (3), each
  // dispatched to the orchestrate-coder agent.
  const board = [
    { file: 'TASK-1.md', fm: { id: 'TASK-1', status: 'todo' } },
    { file: 'TASK-2.md', fm: { id: 'TASK-2', status: 'todo' } },
    { file: 'TASK-3.md', fm: { id: 'TASK-3', status: 'todo' } },
    { file: 'TASK-4.md', fm: { id: 'TASK-4', status: 'todo' } },
    { file: 'TASK-5.md', fm: { id: 'TASK-5', status: 'todo' } },
  ];
  // When the orchestrator selects the next batch (default bound = 3).
  const batch = selectNextBatch(board, { limit: DEFAULT_CONCURRENCY });
  // Then at most 3 are dispatched at once.
  assert.equal(batch.length, 3, 'never exceeds the concurrency bound of 3');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-1', 'TASK-2', 'TASK-3'], 'oldest-first within the bound');

  // And each claimed ticket ends up owned by exactly one agent (one-agent-per-ticket).
  const claimed = batch.map((t, i) => {
    const r = claimTicket(t.fm, `coder-${i + 1}`);
    assert.equal(r.ok, true, `${t.fm.id} claimed`);
    return r.fm;
  });
  for (const fm of claimed) {
    assert.equal(fm.status, 'in-progress');
    assert.ok(fm.agent && fm.agent.startsWith('coder-'), 'exactly one agent owns the ticket');
  }
  // And the three active builds fill the bound: no free slot remains.
  assert.equal(activeCount(claimed), 3);
  assert.deepEqual(selectNextBatch(claimed.map((fm, i) => ({ file: `X${i}.md`, fm })), { limit: DEFAULT_CONCURRENCY }),
    [], 'with 3 active, no further ticket is dispatched until a slot frees');
});

test('Scenario: Two agents cannot claim the same ticket', () => {
  // Given one todo ticket
  const fm = { id: 'TASK-9', status: 'todo', created: '2026-07-18T00:00:00.000Z' };
  // When agent A claims it first
  const a = claimTicket(fm, 'coder-A');
  assert.equal(a.ok, true);
  // Then agent B, re-reading the now-claimed file, is refused (one-agent-per-ticket).
  const b = claimTicket(a.fm, 'coder-B');
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'claimed');
  assert.equal(a.fm.agent, 'coder-A', 'the ticket stays owned by the first claimant');
});

test('Scenario: Edge — a missing agent falls back to general-purpose', () => {
  // Given a project whose .claude/agents/ is missing the coder definition
  const available = ['orchestrate-ba', 'orchestrate-tester']; // coder absent
  // When the build phase resolves its agent type
  const resolved = resolveAgentType(AGENT_TYPES.coder, available);
  // Then it falls back to general-purpose and the fallback is reported.
  assert.equal(resolved, 'general-purpose');
  assert.equal(isFallback(AGENT_TYPES.coder, available), true);
  // But when all three are present, no phase falls back.
  const all = [...AGENT_NAMES];
  for (const n of AGENT_NAMES) {
    assert.equal(resolveAgentType(n, all), n);
    assert.equal(isFallback(n, all), false);
  }
});
