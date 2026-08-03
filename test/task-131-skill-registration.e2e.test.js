'use strict';

// ===========================================================================
// TASK-131 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: installing the orchestrate skill from either of the two remaining UI
// surfaces (Tasks banner, Agents hint) copies the files AND then offers an
// inline "Restart the Claude session to register the skill" notice with a
// Restart button. The app NEVER auto-relaunches; the restart is user-initiated
// and reuses the existing launchCmdAgent kill-and-respawn path.
//
// TASK-203: the Workflow panel (and its install surface,
// buildWorkflowInstallHint) was removed entirely — installing the skill is
// still available via the Tasks banner and the Agents hint, so those two
// surfaces' scenarios are kept as-is; the Workflow-surface scenario/blocks are
// removed below (there is nothing left to test — the function no longer exists).
//
// The subject under test is the REAL renderer code (renderer/renderer.js, a
// browser script with no module.exports): the shared helper
// promptSkillRegistration plus the two install-surface functions
// installOrchestrateSkill / buildAgentsInstallHint are EXTRACTED headless by
// brace-matching the source (the convention of
// test/task-105-workflow-panel.e2e.test.js and test/task-095-add-agent.e2e.test.js)
// and driven with an INJECTED window + a minimal in-memory mock document.
//
// ALL side-effecting collaborators are STUBBED — window.api.tasks.installSkill
// (the install IPC), and the heavy renderer dependencies launchCmdAgent (the
// PTY kill-and-respawn / session relaunch), refreshTeamAgents and
// pollTasksOnce are injected as recording stubs. NO real DB / Electron /
// network / PTY spawn / session relaunch ever happens; every scenario asserts
// launchCmdAgent is invoked ONLY when the Restart button is clicked.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Extract a named function declaration by brace-matching (task-095 style). --
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

// Load the REAL install surfaces + shared registration helper headless. The
// heavy collaborators (session relaunch, panel refreshes, tasks poll) are
// injected via `deps` so we exercise the SHIPPED promptSkillRegistration and
// the SHIPPED install click handlers without spawning anything real.
function loadSurfaces(window, document, console, deps) {
  const body = [
    'const launchCmdAgent = deps.launchCmdAgent;',
    'const refreshTeamAgents = deps.refreshTeamAgents;',
    'const pollTasksOnce = deps.pollTasksOnce;',
    extractFn(rendererSrc, 'promptSkillRegistration'),
    extractFn(rendererSrc, 'installOrchestrateSkill'),
    extractFn(rendererSrc, 'buildAgentsInstallHint'),
    'return { promptSkillRegistration, installOrchestrateSkill,'
      + ' buildAgentsInstallHint };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'deps', body)(window, document, console, deps);
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM: querySelector('.class'), remove(), insertBefore,
// appendChild, textContent + innerHTML setters, classList.
// ---------------------------------------------------------------------------
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
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  let html = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children,
    _listeners: {},
    disabled: false, value: '', title: '', type: '', id: '',
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
    insertBefore(nw, ref) {
      const i = children.indexOf(ref);
      if (i < 0) children.push(nw); else children.splice(i, 0, nw);
      nw.parentNode = el;
      return nw;
    },
    remove() {
      const p = el.parentNode;
      if (p && p.children) {
        const i = p.children.indexOf(el);
        if (i >= 0) p.children.splice(i, 1);
      }
      el.parentNode = null;
    },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    querySelector(sel) {
      if (sel[0] !== '.') throw new Error('mock querySelector only supports .class: ' + sel);
      return findByClass(el, sel.slice(1));
    },
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
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); text = ''; children.length = 0; },
  });
  return el;
}
function makeDocument() {
  return {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => {
      let v = String(t);
      return { _isText: true, get textContent() { return v; }, set textContent(x) { v = String(x); } };
    },
  };
}
async function fire(el, type) {
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn({ preventDefault() {}, stopPropagation() {} });
}
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Harness: stubbed window.api.tasks.installSkill (the ONLY install IPC) + the
// injected deps (session relaunch + panel refreshes + tasks poll). launchCmdAgent
// simulates the kill-and-respawn: it swaps tab.cmd.id to a NEW session id so a
// test can prove the session was actually relaunched (a subsequently queued
// /orchestrate command would be typed into that NEW session).
// ---------------------------------------------------------------------------
function makeHarness(opts) {
  const o = opts || {};
  const calls = {
    installSkill: [], launchCmdAgent: [],
    refreshTeamAgents: [], pollTasksOnce: [],
  };
  const document = makeDocument();
  const console = { error() { calls.consoleError = (calls.consoleError || 0) + 1; }, warn() {}, log() {} };
  const window = {
    api: {
      tasks: {
        async installSkill(projectPath) {
          calls.installSkill.push(projectPath);
          if (o.installOk === false) {
            return { ok: false, error: o.installError || 'install boom' };
          }
          return { ok: true };
        },
      },
    },
  };
  let seq = 0;
  const deps = {
    async launchCmdAgent(tab) {
      calls.launchCmdAgent.push(tab);
      if (o.relaunchThrows) throw new Error('PTY spawn boom');
      // kill-and-respawn: a brand new session id (the OLD one is gone).
      if (tab.cmd) tab.cmd.id = 'new-session-' + (++seq);
    },
    async refreshTeamAgents(tab) { calls.refreshTeamAgents.push(tab); },
    pollTasksOnce(tab, flag) { calls.pollTasksOnce.push({ tab, flag }); },
  };
  return { window, document, console, deps, calls };
}

// A claude tab with a live cmd PTY and the DOM els the Tasks-banner path touches.
function makeClaudeTab(document, folder) {
  const tasksView = document.createElement('div'); // persistent Tasks view container
  const tasksSkillBanner = document.createElement('div');
  tasksSkillBanner.className = 'tasksSkillBanner install-banner';
  const bannerText = document.createElement('div');
  bannerText.className = 'install-banner-text';
  tasksSkillBanner.appendChild(bannerText);
  const tasksBoard = document.createElement('div');
  tasksBoard.className = 'tasksBoard';
  tasksView.appendChild(tasksSkillBanner);
  tasksView.appendChild(tasksBoard);

  return {
    folder: folder || 'C:\\proj',
    agent: 'claude',
    cmd: { id: 'session-1', term: null },
    status: 'finished',
    tasks: { skillInstalled: false },
    els: {
      tasksSkillBanner,
      tasksInstallSkillBtn: (() => { const b = document.createElement('button'); b.textContent = 'Install orchestration skill'; return b; })(),
      tasksBuildBtn: (() => { const b = document.createElement('button'); b.disabled = true; return b; })(),
      teamAgentsBody: document.createElement('div'),
      _tasksView: tasksView,
      _tasksBoard: tasksBoard,
    },
  };
}

function notice(surfaceEl) { return findByClass(surfaceEl, 'skill-restart-notice'); }

// ===========================================================================
// Scenario: Installing from the Tasks banner offers a restart to register the skill
// ===========================================================================
test('Scenario: installing from the Tasks banner offers a restart notice, enables Build, and does NOT relaunch until Restart is clicked', async () => {
  // Given a project tab with the claude session running and the skill NOT installed.
  const { window, document, console, deps, calls } = makeHarness();
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  assert.equal(tab.tasks.skillInstalled, false, 'precondition: skill not installed');

  // When the user clicks "Install orchestration skill" on the Tasks banner and the
  // install IPC returns ok.
  await installOrchestrateSkill(tab);
  await flush();

  // Then the install IPC ran for the open folder (the file copy happened).
  assert.deepEqual(calls.installSkill, ['C:\\proj'], 'install IPC drove the file copy for the open folder');

  // And an inline notice offers to restart the Claude session to register the skill.
  const n = notice(tab.els._tasksView);
  assert.ok(n, 'a restart notice is shown on the Tasks surface');
  assert.match(n.textContent, /Restart the Claude session to register the skill/, 'notice explains the registration step');
  const restartBtn = findByClass(n, 'skillRestartBtn');
  assert.ok(restartBtn, 'the notice has a Restart button');
  assert.equal(restartBtn.textContent, 'Restart', 'the button reads Restart');

  // And the notice sits ABOVE the board (the board is a scroll-area).
  assert.ok(tab.els._tasksView.children.indexOf(n) < tab.els._tasksView.children.indexOf(tab.els._tasksBoard),
    'the notice is inserted above the tasksBoard');

  // And existing success behavior is preserved: banner hidden, skillInstalled true,
  // Build enabled, and pollTasksOnce ran.
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled flips true');
  assert.ok(tab.els.tasksSkillBanner.classList.contains('hidden'), 'the Tasks banner is hidden');
  assert.equal(tab.els.tasksBuildBtn.disabled, false, 'the Build button is enabled');
  assert.equal(calls.pollTasksOnce.length, 1, 'pollTasksOnce runs for the Tasks-banner path');

  // And NO relaunch happens until the user clicks Restart (the app never auto-relaunches).
  assert.equal(calls.launchCmdAgent.length, 0, 'the app never auto-relaunches on install');
});

// ===========================================================================
// Scenario: Clicking Restart relaunches the session so the skill is registered
// ===========================================================================
test('Scenario: clicking Restart relaunches the Claude session via the kill-and-respawn path (new session) and removes the notice', async () => {
  // Given the post-install restart notice is showing on a claude tab.
  const { window, document, console, deps, calls } = makeHarness();
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  await installOrchestrateSkill(tab);
  await flush();
  const oldSessionId = tab.cmd.id;
  const n = notice(tab.els._tasksView);
  const restartBtn = findByClass(n, 'skillRestartBtn');
  assert.ok(restartBtn, 'precondition: the restart notice is showing');

  // When the user clicks "Restart".
  await fire(restartBtn, 'click');
  await flush();

  // Then the Claude session is relaunched via the kill-and-respawn path — exactly once.
  assert.equal(calls.launchCmdAgent.length, 1, 'Restart relaunches via launchCmdAgent exactly once');
  assert.equal(calls.launchCmdAgent[0], tab, 'the installing tab is relaunched');

  // And it is genuinely a NEW session (the old one was killed and respawned), so a
  // subsequently queued "/orchestrate build" would be typed into the NEW session.
  assert.notEqual(tab.cmd.id, oldSessionId, 'a new session id replaced the old one (kill-and-respawn)');

  // And the notice is removed once the restart succeeds; skillInstalled stays true.
  assert.equal(notice(tab.els._tasksView), null, 'the notice is removed after a successful restart');
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled remains true after restart');
});

// TASK-203: the Workflow panel (and its install surface, buildWorkflowInstallHint)
// was removed entirely — there is nothing left to test on that surface. Installing
// the skill is still available via the Tasks banner and the Agents hint, covered
// by the surrounding scenarios.

// ===========================================================================
// Scenario: Installing from the Agents panel uses the same registration step
// ===========================================================================
test('Scenario: installing from the Agents panel re-reads the roster then shows the SAME shared restart notice', async () => {
  // Given the Agents panel shows the install hint and the tab's agent is claude.
  const { window, document, console, deps, calls } = makeHarness();
  const { buildAgentsInstallHint } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  const banner = buildAgentsInstallHint(tab);
  const installBtn = findByClass(banner, 'teamAgentsInstallBtn');
  assert.ok(installBtn, 'the Agents panel shows an Install button');

  // When the user installs the skill from the Agents panel.
  await fire(installBtn, 'click');
  await flush();

  // Then the install IPC ran, the roster re-read, and the SAME helper showed the notice.
  assert.deepEqual(calls.installSkill, ['C:\\proj'], 'install IPC ran for the folder');
  assert.equal(calls.refreshTeamAgents.length, 1, 'the Agents panel re-reads the agent roster');
  const n = notice(tab.els.teamAgentsBody);
  assert.ok(n, 'the shared restart notice appears on the Agents body');
  assert.ok(findByClass(n, 'skillRestartBtn'), 'the notice carries the shared Restart button');
  assert.equal(calls.launchCmdAgent.length, 0, 'no auto-relaunch from the Agents surface');
});

// ===========================================================================
// Scenario: App never auto-kills an in-flight response (edge)
// ===========================================================================
test('Scenario (edge): with the claude session mid-response, a successful install shows the notice but performs NO automatic relaunch', async () => {
  // Given the claude session is mid-response (status running, live PTY).
  const { window, document, console, deps, calls } = makeHarness();
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  tab.status = 'running'; // mid-response

  // When the user installs the skill successfully.
  await installOrchestrateSkill(tab);
  await flush();

  // Then no relaunch is performed automatically (the in-flight response is not killed).
  assert.equal(calls.launchCmdAgent.length, 0, 'no automatic relaunch mid-response');

  // And the restart notice is shown for the user to trigger when ready.
  assert.ok(notice(tab.els._tasksView), 'the restart notice is shown for the user to trigger');

  // And skillInstalled is true and the Build button gating is unchanged (enabled).
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled is true');
  assert.equal(tab.els.tasksBuildBtn.disabled, false, 'the Build button gating is unchanged');
});

// ===========================================================================
// Scenario: OpenCode pane is a no-op (edge)
// ===========================================================================
test('Scenario (edge): on an opencode tab a successful install shows NO restart notice and raises no error', async () => {
  // Given the tab's agent is opencode.
  const { window, document, console, deps, calls } = makeHarness();
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  tab.agent = 'opencode';

  // When the user installs the skill successfully — no throw.
  await assert.doesNotReject(() => installOrchestrateSkill(tab), 'opencode install does not throw');
  await flush();

  // Then no restart notice is shown and no error was logged in the helper path.
  assert.equal(notice(tab.els._tasksView), null, 'no restart notice for the opencode pane');

  // And the install success behavior is otherwise unchanged.
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled still flips true');
  assert.equal(tab.els.tasksBuildBtn.disabled, false, 'the Build button still enables');
  assert.equal(calls.launchCmdAgent.length, 0, 'no relaunch for opencode');
});

// ===========================================================================
// Scenario (edge): dead / no PTY is a no-op
// ===========================================================================
test('Scenario (edge): a claude tab with no live cmd PTY is a safe no-op (no notice, no relaunch)', async () => {
  // Given a claude tab whose cmd PTY is dead (cmd.id null).
  const { window, document, console, deps, calls } = makeHarness();
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  tab.cmd.id = null;

  // When the user installs the skill successfully.
  await installOrchestrateSkill(tab);
  await flush();

  // Then no notice, no error, no relaunch — success behavior otherwise unchanged.
  assert.equal(notice(tab.els._tasksView), null, 'no restart notice when no PTY is alive');
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled still flips true');
  assert.equal(calls.launchCmdAgent.length, 0, 'no relaunch when no PTY is alive');
});

// ===========================================================================
// Scenario: Only the installing tab is affected (documented limitation)
// ===========================================================================
test('Scenario (edge): only the installing tab shows the notice — a second tab on the same folder is untouched', async () => {
  // Given two claude tabs open on the SAME folder, both with live sessions.
  const { window, document, console, deps } = makeHarness();
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tabA = makeClaudeTab(document, 'C:\\proj');
  const tabB = makeClaudeTab(document, 'C:\\proj');

  // When the user installs from tab A only.
  await installOrchestrateSkill(tabA);
  await flush();

  // Then only tab A shows the notice; tab B (same folder) is unaffected.
  assert.ok(notice(tabA.els._tasksView), 'the installing tab shows the notice');
  assert.equal(notice(tabB.els._tasksView), null, 'the other tab on the same folder is untouched');
});

// ===========================================================================
// Scenario: Install IPC fails (failure)
// ===========================================================================
test('Scenario (failure): tasks:installSkill returning ok:false shows the inline error, no notice, and does NOT flip skillInstalled', async () => {
  // Given tasks:installSkill returns ok:false with an error message.
  const { window, document, console, deps, calls } = makeHarness({ installOk: false, installError: 'disk full' });
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');

  // When the user clicks install on the Tasks surface.
  await installOrchestrateSkill(tab);
  await flush();

  // Then the surface shows the inline install-failed message with that error.
  assert.match(tab.els.tasksSkillBanner.querySelector('.install-banner-text').textContent, /Install failed/i, 'inline install-failed message shown');
  assert.match(tab.els.tasksSkillBanner.querySelector('.install-banner-text').textContent, /disk full/, 'the error message is surfaced');

  // And no restart notice is shown and skillInstalled is not set true.
  assert.equal(notice(tab.els._tasksView), null, 'no restart notice on install failure');
  assert.equal(tab.tasks.skillInstalled, false, 'skillInstalled is NOT flipped on failure');
  assert.equal(calls.launchCmdAgent.length, 0, 'no relaunch on install failure');
  assert.ok(!tab.els.tasksSkillBanner.classList.contains('hidden'), 'the banner stays visible for a retry');
});

// ===========================================================================
// Scenario: Project path outside approved roots is refused (failure)
// ===========================================================================
test('Scenario (failure): an OUTSIDE_ROOT_ERROR confinement rejection shows the error, writes no notice, and does not flip state — on every surface', async () => {
  const OUTSIDE = 'Path is outside the approved project root';
  // Tasks surface.
  {
    const { window, document, console, deps, calls } = makeHarness({ installOk: false, installError: OUTSIDE });
    const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
    const tab = makeClaudeTab(document, 'C:\\evil');
    await installOrchestrateSkill(tab);
    await flush();
    assert.match(tab.els.tasksSkillBanner.querySelector('.install-banner-text').textContent, /outside the approved project root/, 'Tasks surface surfaces the confinement error');
    assert.equal(notice(tab.els._tasksView), null, 'Tasks: no notice on OUTSIDE_ROOT_ERROR');
    assert.equal(tab.tasks.skillInstalled, false, 'Tasks: no state flip on OUTSIDE_ROOT_ERROR');
    assert.equal(calls.launchCmdAgent.length, 0, 'Tasks: no relaunch');
  }
  // TASK-203: the Workflow surface (buildWorkflowInstallHint) was removed
  // entirely — only the Tasks and Agents surfaces remain to check.
  // Agents surface.
  {
    const { window, document, console, deps, calls } = makeHarness({ installOk: false, installError: OUTSIDE });
    const { buildAgentsInstallHint } = loadSurfaces(window, document, console, deps);
    const tab = makeClaudeTab(document, 'C:\\evil');
    const banner = buildAgentsInstallHint(tab);
    await fire(findByClass(banner, 'teamAgentsInstallBtn'), 'click');
    await flush();
    assert.match(findByClass(banner, 'install-banner-text').textContent, /outside the approved project root/, 'Agents surface surfaces the confinement error');
    assert.equal(notice(tab.els.teamAgentsBody), null, 'Agents: no notice on OUTSIDE_ROOT_ERROR');
    assert.equal(calls.refreshTeamAgents.length, 0, 'Agents: no re-read on failure');
    assert.equal(calls.launchCmdAgent.length, 0, 'Agents: no relaunch');
  }
});

// ===========================================================================
// Scenario: Relaunch triggered by Restart fails (failure)
// ===========================================================================
test('Scenario (failure): when launchCmdAgent throws on Restart, the error is logged, a manual-restart notice shows, and skillInstalled stays true', async () => {
  // Given the restart notice is showing and the PTY kill/spawn will throw.
  const { window, document, console, deps, calls } = makeHarness({ relaunchThrows: true });
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  await installOrchestrateSkill(tab);
  await flush();
  const n = notice(tab.els._tasksView);
  const restartBtn = findByClass(n, 'skillRestartBtn');
  assert.ok(restartBtn, 'precondition: the restart notice is showing');

  // When the user clicks "Restart" and the relaunch throws.
  await fire(restartBtn, 'click');
  await flush();

  // Then launchCmdAgent was attempted and the error was logged.
  assert.equal(calls.launchCmdAgent.length, 1, 'the relaunch was attempted once');
  assert.ok(calls.consoleError >= 1, 'the relaunch error was logged');

  // And the notice stays and tells the user to restart Claude manually.
  const still = notice(tab.els._tasksView);
  assert.ok(still, 'the notice remains after a failed relaunch');
  assert.match(still.textContent, /manually/i, 'the notice tells the user to restart Claude manually');
  // The button is re-enabled for another try.
  assert.equal(findByClass(still, 'skillRestartBtn').disabled, false, 'the Restart button is re-enabled after failure');

  // And skillInstalled remains true because the files are validly on disk.
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled stays true after a relaunch failure');
});

// ===========================================================================
// Scenario (edge): reinstalling over an existing skill does NOT stack duplicate notices
// ===========================================================================
test('Scenario (edge): reinstalling with the same button does not stack duplicate restart notices', async () => {
  // Given a claude tab where the skill was just installed (notice showing).
  const { window, document, console, deps } = makeHarness();
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, 'C:\\proj');
  await installOrchestrateSkill(tab);
  await flush();
  assert.equal(findAll(tab.els._tasksView, 'skill-restart-notice').length, 1, 'one notice after the first install');

  // When the user clicks Install again (reinstall over the existing skill).
  // installOrchestrateSkill re-hides the banner; simulate the button being usable again.
  tab.els.tasksSkillBanner.classList.remove('hidden');
  await installOrchestrateSkill(tab);
  await flush();

  // Then there is still exactly ONE notice — the prior one was dropped, not stacked.
  assert.equal(findAll(tab.els._tasksView, 'skill-restart-notice').length, 1, 'still exactly one notice after reinstall (no duplicate stacking)');
});
