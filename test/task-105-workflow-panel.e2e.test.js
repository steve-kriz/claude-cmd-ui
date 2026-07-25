'use strict';

// ===========================================================================
// TASK-105 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: the Team tab Workflow panel — a READ-ONLY pipeline view of the
// project's orchestrate skill. The subject under test is the REAL renderer code
// (renderer/renderer.js, a browser script with no module.exports):
// refreshTeamWorkflow, buildWorkflowView, buildWorkflowPhase,
// buildWorkflowInstallHint and the wf* parse mirror are
// EXTRACTED headless by brace-matching the source (the convention of
// test/task-094-agents-panel.e2e.test.js) and driven with an INJECTED `window`
// + a minimal in-memory mock `document`.
//
// ALL filesystem/Electron access goes through a STUBBED `window.api.fs`
// (exists / readFile / findByExt / writeFile) and `window.api.tasks.installSkill`.
// NO real DB / Electron / network — the real .claude/skills/orchestrate/SKILL.md
// and .claude/agents/*.md are used READ-ONLY as fixtures served through the stub.
// Every scenario asserts that fs.writeFile is NEVER called (Q3: no write path).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const SKILL_SRC = fs.readFileSync(
  path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md'), 'utf8');

// The four bundled agent files, read-only, exactly as `tasks:installSkill`
// copies them into a project's .claude/agents/ (main.js ~693: assets/agents/*.md
// -> .claude/agents/*.md, keeping their filenames — ba.md, coder.md, tester.md,
// tech-lead.md). Their `name:` frontmatter is orchestrate-ba/coder/tester/tech-lead.
const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];
const AGENT_CONTENT = Object.fromEntries(AGENT_FILES.map((f) =>
  [f, fs.readFileSync(path.join(REPO, 'assets', 'agents', f), 'utf8')]));

// --- Extract a named function declaration by brace-matching (task-094 style). --
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

// Load the REAL Workflow-panel render path headless, injecting window/document/
// console. This exercises the shipped functions — not a replica.
function loadWorkflow(window, document, console) {
  const body = [
    extractConst(rendererSrc, 'WF_FALLBACK_AGENT'),
    extractConst(rendererSrc, 'WF_AGENT_TYPES'),
    extractConst(rendererSrc, 'WF_AGENT_NAMES'),
    extractConst(rendererSrc, 'WF_PHASE_SPECS'),
    extractConst(rendererSrc, 'WF_PLAN_MODEL_PRIMARY'),
    extractConst(rendererSrc, 'WF_PLAN_MODEL_FALLBACK'),
    // TASK-106 — the render path now also parses each agent file (name/model) and
    // mounts a per-phase model editor + a concurrency-default control. Extract the
    // agent-file parser, its constants, the model-editor + concurrency-control
    // builders and their render-time helpers/constants. Save-handler-only
    // collaborators (serializeAgentModel / sanitizeAgentModelField / writeWithMirror
    // / tasksSerializeTeamConfig / buildWorkingConfigFromRaw) are NOT needed here —
    // these read-only scenarios never click Save — so they stay free (uncalled).
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
    extractConst(rendererSrc, 'WF_MODEL_SUGGESTIONS'),
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    'let wfModelDatalistSeq = 0;',
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'resolveAgentBlockScalar'),
    extractFn(rendererSrc, 'parseAgentFileRenderer'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'wfIsFallback'),
    extractFn(rendererSrc, 'wfHeadingName'),
    extractFn(rendererSrc, 'wfPhaseNumberOf'),
    extractFn(rendererSrc, 'wfAgentIn'),
    extractFn(rendererSrc, 'wfModelDirectiveIn'),
    extractFn(rendererSrc, 'wfSectionsOf'),
    extractFn(rendererSrc, 'wfAgentFromDispatch'),
    extractFn(rendererSrc, 'wfParseWorkflow'),
    extractFn(rendererSrc, 'buildWorkflowModelEditor'),
    extractFn(rendererSrc, 'buildWorkflowConcurrencyControl'),
    extractFn(rendererSrc, 'buildWorkflowPhase'),
    extractFn(rendererSrc, 'buildWorkflowView'),
    extractFn(rendererSrc, 'buildWorkflowInstallHint'),
    extractFn(rendererSrc, 'refreshTeamWorkflow'),
    'return { refreshTeamWorkflow, tasksJoin };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)(window, document, console);
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM (task-094 style). textContent set clears children;
// className backed by the class set classList mutates.
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children,
    _listeners: {},
    disabled: false, value: '', title: '', type: '', id: '', spellcheck: false,
    parentNode: null, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, on) { const w = on === undefined ? !classes.has(c) : !!on; if (w) classes.add(c); else classes.delete(c); return w; },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { children.push(c); c.parentNode = el; return c; },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    focus() {},
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return children.length ? children.map((c) => c.textContent).join('') : text; },
    set(v) { text = String(v); children.length = 0; },
  });
  return el;
}
function makeDocument() {
  return {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ _isText: true, textContent: String(t) }),
  };
}
function findByClass(root, cls) {
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) return c;
    const deep = findByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
function findAll(root, cls, out) {
  out = out || [];
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
async function fire(el, type) {
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn({ preventDefault() {}, stopPropagation() {} });
}
// Drain the event loop: the install click handler calls refreshTeamWorkflow
// fire-and-forget (un-awaited), so its async re-read/re-render completes on
// later ticks. A few setTimeout(0) turns let those chained awaits settle.
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Stubbed window.api backed by an in-memory file map. Paths are built with the
// SAME tasksJoin the renderer uses (`\` separator). `skillInstalled` drives
// fs.exists for the SKILL.md path; `agentFiles` is the list of agent filenames
// present in .claude/agents/ (served by findByExt + readFile). Every write is
// recorded so a test can assert NONE happened (Q3). NO real disk/DB/network.
// ---------------------------------------------------------------------------
function makeWindow(opts) {
  const o = opts || {};
  const folder = o.folder || 'C:\\proj';
  const sep = '\\';
  const skillPath = [folder, '.claude', 'skills', 'orchestrate', 'SKILL.md'].join(sep);
  const agentsDir = [folder, '.claude', 'agents'].join(sep);
  const agentFiles = (o.agentFiles || AGENT_FILES).map((f) => agentsDir + sep + f);

  const state = {
    skillInstalled: o.skillInstalled !== false,
    skillContent: 'skillContent' in o ? o.skillContent : SKILL_SRC,
    skillReadResult: o.skillReadResult || null, // override the readFile result entirely
  };
  const calls = { exists: [], readFile: [], findByExt: [], writeFile: [], installSkill: [] };

  const window = {
    api: {
      fs: {
        async exists(p) {
          calls.exists.push(p);
          if (p === skillPath) return { ok: true, exists: !!state.skillInstalled };
          return { ok: true, exists: false };
        },
        async readFile(p) {
          calls.readFile.push(p);
          if (p === skillPath) {
            if (state.skillReadResult) return state.skillReadResult;
            if (typeof state.skillContent !== 'string') return { ok: false, error: 'ENOENT' };
            return { ok: true, content: state.skillContent };
          }
          const base = p.slice(p.lastIndexOf(sep) + 1);
          if (agentFiles.includes(p)) {
            // TASK-123 (F3): let a scenario override a present agent file's read
            // result (unreadable / binary / fence-less) to exercise the inline
            // resolver's skip path. Backward-compatible: with no override the
            // bundled fixture content is served as before.
            if (o.agentReads && Object.prototype.hasOwnProperty.call(o.agentReads, base)) {
              return o.agentReads[base];
            }
            if (AGENT_CONTENT[base]) return { ok: true, content: AGENT_CONTENT[base] };
          }
          return { ok: false, error: 'ENOENT: ' + p };
        },
        async findByExt(root, ext) {
          calls.findByExt.push({ root, ext });
          if (root === agentsDir) return { ok: true, files: agentFiles.slice() };
          return { ok: false, error: 'ENOENT: ' + root };
        },
        async writeFile(absPath, content) {
          calls.writeFile.push({ absPath, content });
          return { ok: true };
        },
      },
      tasks: {
        async installSkill(projectPath) {
          calls.installSkill.push(projectPath);
          // A successful install makes the skill present on the next re-read.
          if (!o.installFails) state.skillInstalled = true;
          return o.installFails ? { ok: false, error: 'install boom' } : { ok: true };
        },
      },
    },
  };
  const noopConsole = { error() {}, warn() {}, log() {} };
  return { window, calls, state, document: makeDocument(), console: noopConsole, folder, skillPath, agentsDir };
}

function makeTab(folder) {
  return { folder, els: { teamWorkflowBody: makeEl('div') } };
}

// TASK-106: both the SKILL.md directive badge AND the per-phase agent-model editor
// badge carry the `team-workflow-model` class. The SKILL.md directive (Phase-1,
// read-only) is the one NOT inside the `.team-workflow-model-editor` wrapper; the
// agent-model editor's current value is the one inside it. Distinguish them so the
// read-only directive assertions stay meaningful under the new contract.
function directiveModel(card) {
  function walk(node, underEditor) {
    for (const c of (node.children || [])) {
      const nowUnder = underEditor
        || (c.classList && c.classList.contains('team-workflow-model-editor'));
      if (!nowUnder && c.classList && c.classList.contains('team-workflow-model')) return c;
      const found = walk(c, nowUnder);
      if (found) return found;
    }
    return null;
  }
  const el = walk(card, false);
  return el ? el.textContent : null;
}
function agentEditorModel(card) {
  const editor = findByClass(card, 'team-workflow-model-editor');
  if (!editor) return null;
  const badge = findByClass(editor, 'team-workflow-model');
  return badge ? badge.textContent : null;
}

// Read the rendered phase cards (in DOM order) into a simple shape for asserting.
function readPhases(body) {
  const view = findByClass(body, 'team-workflow') || body;
  return findAll(view, 'team-workflow-phase').map((card) => ({
    title: findByClass(card, 'team-workflow-phase-title').textContent,
    agent: findByClass(card, 'team-workflow-agent').textContent,
    // The SKILL.md planning-model directive (Phase-1 only, read-only).
    model: directiveModel(card),
    modelFallback: (() => { const m = findByClass(card, 'team-workflow-model-fallback'); return m ? m.textContent : null; })(),
    // The per-phase agent-file model editor (TASK-106): its current value, or null
    // when the editor is unavailable (missing agent file).
    hasModelEditor: !!findByClass(card, 'team-workflow-model-editor'),
    agentModel: agentEditorModel(card),
    hasFallbackWarning: !!findByClass(card, 'team-workflow-fallback'),
    fallbackWarning: (() => { const w = findByClass(card, 'team-workflow-fallback'); return w ? w.textContent : null; })(),
    hasRule: !!findByClass(card, 'team-workflow-rule'),
  }));
}

// ===========================================================================
// Scenario: Rendering the pipeline
//   Given the orchestrate skill is installed
//   Then plan, build, test and review render in order with their agents and models
// ===========================================================================
test('Scenario: with the skill installed, plan/build/test/review render in order with their agents + models', async () => {
  // Given a project where the orchestrate skill is installed (SKILL.md present)
  // and all four dedicated agents are installed exactly as tasks:installSkill
  // lays them down (ba.md/coder.md/tester.md/tech-lead.md).
  const { window, calls, document, console } = makeWindow(); // defaults: installed, all agents
  const { refreshTeamWorkflow } = loadWorkflow(window, document, console);
  const tab = makeTab('C:\\proj');
  const body = tab.els.teamWorkflowBody;

  // When the Workflow panel refreshes (drives the REAL refreshTeamWorkflow, which
  // resolves the installed frontmatter `name:` set INLINE — findByExt + readFile +
  // parseAgentFileRenderer, NOT the board-only readTeamAgentNames — then
  // wfParseWorkflow -> buildWorkflowView).
  await refreshTeamWorkflow(tab);

  // Then the four phases render IN ORDER with their agents and models.
  const phases = readPhases(body);
  assert.equal(phases.length, 4, 'four phase cards render');
  assert.deepEqual(phases.map((p) => p.agent),
    ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tester', 'orchestrate-tech-lead'],
    'phases in plan/build/test/review order with their dedicated agents');
  assert.match(phases[0].title, /Phase 1/, 'first card is Phase 1 (plan)');
  assert.match(phases[1].title, /Phase 2/, 'second card is Phase 2 (build)');
  assert.match(phases[2].title, /Phase 3/, 'third card is Phase 3 (test)');
  assert.match(phases[3].title, /Phase 4/, 'fourth card is Phase 4 (review)');

  // And the plan phase — and only it — shows the model directive opus-4-8 -> sonnet-5.
  assert.equal(phases[0].model, 'claude-opus-4-8', 'plan phase shows the planning model');
  assert.match(phases[0].modelFallback, /claude-sonnet-5/, 'plan phase shows the model fallback');
  for (const p of phases.slice(1)) assert.equal(p.model, null, `${p.title} shows no SKILL.md model directive`);

  // And (TASK-106) every phase now mounts an editable agent-file model editor
  // seeded from that agent's frontmatter. The cost-routing pins every agent:
  // ba.md + tech-lead.md declare claude-opus-4-8; coder.md + tester.md declare the
  // default claude-sonnet-5. None reads as "(default)" anymore.
  assert.ok(phases.every((p) => p.hasModelEditor), 'every phase mounts an agent-model editor');
  const expectedAgentModel = {
    'orchestrate-ba': 'claude-opus-4-8',
    'orchestrate-coder': 'claude-sonnet-5',
    'orchestrate-tester': 'claude-sonnet-5',
    'orchestrate-tech-lead': 'claude-opus-4-8',
  };
  for (const p of phases) {
    assert.equal(p.agentModel, expectedAgentModel[p.agent],
      `${p.agent} agent-model editor shows its pinned model`);
  }

  // And every phase shows the always-on fallback RULE.
  assert.ok(phases.every((p) => p.hasRule), 'every phase shows the fallback rule');

  // And because ALL four dedicated agents ARE installed, NO phase shows the
  // missing-agent fallback WARNING (that warning is reserved for the missing-agent
  // scenario below — a correctly-installed skill must not scream "not defined").
  const warned = phases.filter((p) => p.hasFallbackWarning).map((p) => p.agent);
  assert.deepEqual(warned, [],
    'no phase shows a missing-agent fallback warning when every agent is installed');

  // And no SKILL.md (or any) write ever happened (Q3: read-only panel).
  assert.equal(calls.writeFile.length, 0, 'the panel never writes anything');
});

// ===========================================================================
// Scenario: Missing agent definition (edge)
//   Given .claude/agents/tester.md is deleted
//   Then the test phase shows a falls-back-to-general-purpose warning
// ===========================================================================
test('Scenario (edge): deleting .claude/agents/tester.md makes ONLY the test phase warn about the general-purpose fallback', async () => {
  // Given the skill is installed but tester.md has been deleted from .claude/agents/.
  const { window, calls, document, console } = makeWindow({
    agentFiles: ['ba.md', 'coder.md', 'tech-lead.md'], // tester.md removed
  });
  const { refreshTeamWorkflow } = loadWorkflow(window, document, console);
  const tab = makeTab('C:\\proj');
  const body = tab.els.teamWorkflowBody;

  // When the panel refreshes.
  await refreshTeamWorkflow(tab);

  // Then the TEST phase shows the falls-back-to-general-purpose warning.
  const phases = readPhases(body);
  assert.equal(phases.length, 4, 'all four phases still render');
  const testPhase = phases.find((p) => p.agent === 'orchestrate-tester');
  assert.ok(testPhase.hasFallbackWarning, 'the test phase shows a fallback warning');
  assert.match(testPhase.fallbackWarning, /orchestrate-tester/, 'names the missing agent');
  assert.match(testPhase.fallbackWarning, /general-purpose/, 'names the general-purpose fallback');

  // And (TASK-106) the missing-agent phase has NO model editor (no file to rewrite).
  assert.equal(testPhase.hasModelEditor, false, 'the missing-agent phase mounts no model editor');

  // And the OTHER three phases (whose agents remain installed) do NOT warn and DO
  // mount their agent-model editors.
  for (const p of phases.filter((x) => x.agent !== 'orchestrate-tester')) {
    assert.equal(p.hasFallbackWarning, false, `${p.agent} phase (present) shows no fallback warning`);
    assert.equal(p.hasModelEditor, true, `${p.agent} phase (present) mounts a model editor`);
  }

  // And nothing was written.
  assert.equal(calls.writeFile.length, 0, 'the panel never writes anything');
});

// ===========================================================================
// Scenario: Skill not installed (failure)
//   Given no SKILL.md
//   Then the install banner is shown and nothing crashes
// ===========================================================================
test('Scenario (failure): with no SKILL.md the install banner is shown, nothing crashes, and nothing is written', async () => {
  // Given a project where the orchestrate skill is NOT installed.
  const ctx = makeWindow({ skillInstalled: false });
  const { window, calls, document, console, skillPath } = ctx;
  const { refreshTeamWorkflow } = loadWorkflow(window, document, console);
  const tab = makeTab('C:\\proj');
  const body = tab.els.teamWorkflowBody;

  // When the panel refreshes — it must not throw.
  await assert.doesNotReject(() => refreshTeamWorkflow(tab), 'refresh does not throw when the skill is missing');

  // Then the install banner is shown (banner + install button), not the pipeline.
  const banner = findByClass(body, 'teamWorkflowHint');
  assert.ok(banner, 'an install banner is rendered');
  assert.ok(banner.classList.contains('install-banner'), 'reuses the install-banner styling');
  const installBtn = findByClass(body, 'teamWorkflowInstallBtn');
  assert.ok(installBtn, 'an install button is present');
  assert.match(installBtn.textContent, /Install orchestration skill/, 'button offers to install the skill');
  assert.equal(findByClass(body, 'team-workflow-phase'), null, 'no phase cards rendered without the skill');

  // And SKILL.md was never READ (missing existence short-circuits) and never WRITTEN.
  assert.ok(!calls.readFile.includes(skillPath), 'SKILL.md is not read when it does not exist');
  assert.equal(calls.writeFile.length, 0, 'the panel never writes anything');

  // And clicking Install routes to tasks.installSkill for the open folder, then
  // re-reads and renders the pipeline (AC: install then renders).
  await fire(installBtn, 'click');
  await flush(); // the handler re-reads/renders fire-and-forget
  assert.equal(calls.installSkill.length, 1, 'install button drives tasks.installSkill');
  assert.equal(calls.installSkill[0], 'C:\\proj', 'installs into the open folder');
  const phases = readPhases(body);
  assert.equal(phases.length, 4, 'after install the pipeline renders');
  assert.equal(calls.writeFile.length, 0, 'still no writes after installing + rendering');
});

// ===========================================================================
// Scenario (edge): a modified SKILL.md (Phase 3 heading dropped) renders a
// warning — never a blank panel.
// ===========================================================================
test('Scenario (edge): a modified SKILL.md missing the Phase 3 heading renders a warning and is NOT blank', async () => {
  // Given the skill is installed but its SKILL.md has been customized so the
  // Phase 3 heading no longer parses.
  const modified = SKILL_SRC.replace(
    '## Phase 3 — Test (tester) and the fix loop',
    '## Test (tester) and the fix loop');
  assert.notEqual(modified, SKILL_SRC, 'fixture actually dropped the Phase 3 heading');
  const { window, calls, document, console } = makeWindow({ skillContent: modified });
  const { refreshTeamWorkflow } = loadWorkflow(window, document, console);
  const tab = makeTab('C:\\proj');
  const body = tab.els.teamWorkflowBody;

  // When the panel refreshes.
  await refreshTeamWorkflow(tab);

  // Then a parse warning naming the missing phase renders, and the surviving
  // three phases still render — the panel is never blank.
  const warnings = findAll(body, 'team-workflow-warning');
  assert.ok(warnings.length >= 1, 'a parse warning is rendered');
  assert.match(warnings[0].textContent, /Missing Phase 3 \(test\) heading/, 'warning names the dropped phase');
  const phases = readPhases(body);
  assert.deepEqual(phases.map((p) => p.agent),
    ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tech-lead'],
    'the three surviving phases still render in order');
  assert.ok((body.children || []).length > 0, 'the panel is not blank');
  assert.equal(calls.writeFile.length, 0, 'the panel never writes anything');
});

// ===========================================================================
// Scenario (failure): an installed-but-unreadable SKILL.md (ok:false / binary)
// degrades to a warning, never a blank panel, and never writes.
// ===========================================================================
test('Scenario (failure): an installed-but-unreadable SKILL.md degrades to a warning (never blank), and never writes', async () => {
  for (const bad of [{ ok: false, error: 'EACCES' }, { ok: true, content: '(binary)', binary: true }]) {
    // Given the skill exists but its file cannot be read as text.
    const { window, calls, document, console } = makeWindow({ skillReadResult: bad });
    const { refreshTeamWorkflow } = loadWorkflow(window, document, console);
    const tab = makeTab('C:\\proj');
    const body = tab.els.teamWorkflowBody;

    // When the panel refreshes — it must not throw.
    await assert.doesNotReject(() => refreshTeamWorkflow(tab), 'refresh does not throw on an unreadable SKILL.md');

    // Then a warning is shown (never a blank panel) and no install banner (it IS installed).
    const warnings = findAll(body, 'team-workflow-warning');
    assert.ok(warnings.length >= 1, 'a warning is shown for an unreadable SKILL.md');
    assert.match(warnings[0].textContent, /could not be read/i, 'the warning explains the read failure');
    assert.equal(findByClass(body, 'teamWorkflowInstallBtn'), null, 'no install banner — the skill IS installed');
    assert.ok((body.children || []).length > 0, 'the panel is not blank');
    assert.equal(calls.writeFile.length, 0, 'the panel never writes anything');
  }
});

// ===========================================================================
// Scenario (edge): Refresh RE-READS SKILL.md (no polling) — a later edit is
// reflected only after an explicit refresh.
// ===========================================================================
test('Scenario (edge): refreshing re-reads SKILL.md so a later edit is reflected (no background polling)', async () => {
  const ctx = makeWindow(); // installed, full pipeline
  const { window, calls, state, document, console } = ctx;
  const { refreshTeamWorkflow } = loadWorkflow(window, document, console);
  const tab = makeTab('C:\\proj');
  const body = tab.els.teamWorkflowBody;

  await refreshTeamWorkflow(tab);
  assert.equal(readPhases(body).length, 4, 'first refresh renders four phases');
  const readsAfterFirst = calls.readFile.filter((p) => p.endsWith('SKILL.md')).length;
  assert.equal(readsAfterFirst, 1, 'SKILL.md read exactly once per refresh (no polling loop)');

  // When SKILL.md is edited on disk (Phase 4 heading dropped) and the user
  // refreshes AGAIN, the re-read reflects the new content.
  state.skillContent = SKILL_SRC.replace(
    '## Phase 4 — Tech-lead review (reviewer), post-processing, then done',
    '## Tech-lead review (reviewer), post-processing, then done');
  await refreshTeamWorkflow(tab);
  const phases = readPhases(body);
  assert.deepEqual(phases.map((p) => p.agent),
    ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tester'],
    'the re-read reflects the edited SKILL.md (Phase 4 now missing)');
  const warnings = findAll(body, 'team-workflow-warning');
  assert.ok(warnings.some((w) => /Missing Phase 4 \(review\)/.test(w.textContent)), 'warns about the dropped phase');
  assert.equal(calls.writeFile.length, 0, 'the panel never writes anything');
});

// ===========================================================================
// TASK-123 (F3) — the inline agent-name resolver skip path in refreshTeamWorkflow.
//
// The panel resolves the installed frontmatter `name:` set INLINE (findByExt +
// readFile + parseAgentFileRenderer), keyed by each file's declared `name:`. A
// present-but-MALFORMED agent file — unreadable (readFile ok:false), binary
// (rr.binary true), fence-less / unparseable (parseAgentFileRenderer -> null),
// or parseable-but-nameless (no fm.name) — is SKIPPED: it is NOT added to
// agentNames / agentFiles, so its phase shows the general-purpose fallback
// WARNING and mounts NO model editor — all WITHOUT throwing. The other three
// (well-formed) phases are unaffected. Every scenario is read-only (no writes).
// ===========================================================================

// A syntactically valid frontmatter block that declares NO `name:` key — parses
// fine but yields no name, so the resolver cannot map it to a phase.
const NAMELESS_AGENT = ['---', 'description: a tester with no name key', 'model: claude-opus-4-8', '---', 'body'].join('\n');
// A fence-less file — parseAgentFileRenderer returns null (no opening `---`).
const FENCELESS_AGENT = ['This file has no frontmatter fence at all.', 'orchestrate-tester lives here in prose only.'].join('\n');

const MALFORMED_TESTER_CASES = [
  { label: 'unreadable (readFile ok:false)', read: { ok: false, error: 'EACCES' } },
  { label: 'binary (rr.binary true)', read: { ok: true, binary: true, content: '(binary)' } },
  { label: 'fence-less / unparseable (parse -> null)', read: { ok: true, content: FENCELESS_AGENT } },
  { label: 'parseable but nameless (no fm.name)', read: { ok: true, content: NAMELESS_AGENT } },
];

for (const c of MALFORMED_TESTER_CASES) {
  test(`Scenario (edge): a present-but-malformed tester.md — ${c.label} — is SKIPPED so the test phase warns, without throwing`, async () => {
    // Given the skill is installed and all four agent FILES are present in
    // .claude/agents/, but tester.md is malformed for this case.
    const { window, calls, document, console } = makeWindow({
      agentReads: { 'tester.md': c.read },
    });
    const { refreshTeamWorkflow } = loadWorkflow(window, document, console);
    const tab = makeTab('C:\\proj');
    const body = tab.els.teamWorkflowBody;

    // When the panel refreshes — the inline resolver must SKIP the malformed file
    // without throwing.
    await assert.doesNotReject(() => refreshTeamWorkflow(tab),
      'refresh does not throw on a malformed agent file');

    // Then all four phases still render.
    const phases = readPhases(body);
    assert.equal(phases.length, 4, 'all four phases still render');

    // And the TEST phase — whose tester.md was skipped (not added to the resolved
    // `name:` set) — shows the general-purpose fallback warning and mounts NO editor.
    const testPhase = phases.find((p) => p.agent === 'orchestrate-tester');
    assert.ok(testPhase.hasFallbackWarning, 'the test phase warns: the skipped agent reads as a fallback');
    assert.match(testPhase.fallbackWarning, /orchestrate-tester/, 'names the un-resolved agent');
    assert.match(testPhase.fallbackWarning, /general-purpose/, 'names the general-purpose fallback');
    assert.equal(testPhase.hasModelEditor, false, 'no model editor for the skipped agent (no file mapped)');

    // And the OTHER three phases (well-formed files) resolve normally: no warning,
    // and they DO mount their agent-model editors.
    for (const p of phases.filter((x) => x.agent !== 'orchestrate-tester')) {
      assert.equal(p.hasFallbackWarning, false, `${p.agent} phase (well-formed) shows no fallback warning`);
      assert.equal(p.hasModelEditor, true, `${p.agent} phase (well-formed) mounts a model editor`);
    }

    // And the panel is never blank and never writes.
    assert.ok((body.children || []).length > 0, 'the panel is not blank');
    assert.equal(calls.writeFile.length, 0, 'the panel never writes anything');
  });
}
