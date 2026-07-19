'use strict';

// ===========================================================================
// TASK-030 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: A "Plan" button on the Tasks toolbar opens a modal; on submit it
// enqueues an `/orchestrate plan <text>` prompt onto tab.promptQueue (it does
// NOT write ticket files). The button is gated on folder + skillInstalled, and
// a plan prompt must NOT be a build command.
//
// NO DATABASE, DISK WRITE, OR NETWORK CALL IS MADE. The browser files
// (renderer/renderer.js, index.html, styles.css) cannot be require()'d, so —
// matching the repo convention in test/task-028-post-processing.e2e.test.js —
// their wiring is proven by SOURCE-SCANNING those files as text. The submit's
// core composition logic is ALSO exercised behaviourally via a small pure
// replica (`planEnqueue`) driven through the Gherkin scenarios, with a
// drift-guard tying the replica to the real source so it cannot silently
// diverge. The prompt queue is a plain in-memory array; all agent/DB/disk
// access is mocked away by construction.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// ---------------------------------------------------------------------------
// PURE BEHAVIOURAL REPLICA of openPlanModal's onSubmit core (renderer.js
// ~6541-6556). Browser script — not requireable — so the enqueue/error/dispatch
// decision is replicated here as a pure function and DRIFT-GUARDED against the
// real source below (see "DRIFT GUARD" scenarios). `dispatchWhenFinished`
// mirrors `if (tab.status === 'finished') tryDispatchNextPrompt(tab);`.
// ---------------------------------------------------------------------------
const PLAN_ERROR = 'Describe what you want built.';
function planEnqueue(queue, rawText, status) {
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text) {
    // Empty/whitespace: inline error, NOTHING enqueued, submit re-armed, modal open.
    return { pushed: false, prompt: null, dispatched: false, error: PLAN_ERROR, modalOpen: true };
  }
  const prompt = '/orchestrate plan ' + text;
  queue.push(prompt);
  const dispatched = status === 'finished';
  return { pushed: true, prompt, dispatched, error: '', modalOpen: false };
}

// Replica of renderer.js isBuildCommand (~6031) + BUILD_COMMAND (~5965), so the
// "plan is NOT a build command" assertion is exercised against the real rule.
const BUILD_COMMAND = '/orchestrate build';
function isBuildCommand(p) {
  return typeof p === 'string' && (p === BUILD_COMMAND || p.startsWith(BUILD_COMMAND + ' '));
}

// Slice the Tasks .view-toolbar region so button ordering is asserted locally
// (not against some other toolbar). The Tasks view begins at data-view="tasks".
function tasksToolbar() {
  const viewIdx = htmlSrc.indexOf('data-view="tasks"');
  assert.ok(viewIdx !== -1, 'the Tasks tab-view exists');
  const tbStart = htmlSrc.indexOf('view-toolbar', viewIdx);
  assert.ok(tbStart !== -1, 'the Tasks view-toolbar exists');
  const tbEnd = htmlSrc.indexOf('</div>', tbStart);
  return htmlSrc.slice(tbStart, tbEnd);
}

// ===========================================================================
// Scenario: Plan button sits left of New ticket
//   AC: .tasksPlanBtn exists in the Tasks toolbar, immediately before .tasksNewBtn,
//   with small-btn styling.
// ===========================================================================
test('Scenario: the Tasks toolbar shows a Plan button immediately before the New ticket button', () => {
  // Given the Tasks toolbar markup
  const toolbar = tasksToolbar();
  // Then a Plan button exists
  const planIdx = toolbar.indexOf('tasksPlanBtn');
  const newIdx = toolbar.indexOf('tasksNewBtn');
  assert.ok(planIdx !== -1, '.tasksPlanBtn exists in the Tasks toolbar');
  assert.ok(newIdx !== -1, '.tasksNewBtn exists in the Tasks toolbar');
  // And it sits immediately before (to the left of) New ticket
  assert.ok(planIdx < newIdx, 'Plan button appears before the New ticket button');
  // And it uses the shared small-btn styling and carries the visible label "Plan"
  const planBtn = htmlSrc.slice(htmlSrc.indexOf('<button', htmlSrc.indexOf('tasksPlanBtn') - 40),
    htmlSrc.indexOf('</button>', htmlSrc.indexOf('tasksPlanBtn')) + 9);
  assert.match(planBtn, /class="tasksPlanBtn small-btn"/, 'Plan button uses small-btn styling');
  assert.match(planBtn, />Plan<\/button>/, 'Plan button is labelled "Plan"');
  // And in the shipped markup it starts disabled (gated until folder+skill)
  assert.match(planBtn, /disabled/, 'Plan button ships disabled (gated)');
});

// ===========================================================================
// Scenario: A #planModal exists cloned from the modal pattern
//   AC: #planModal follows .task-modal.hidden -> card -> head/body/error/actions
//   with .plan-body textarea, .plan-error, .plan-cancel, .plan-submit (labelled Plan).
// ===========================================================================
test('Scenario: a #planModal exists with the modal sub-parts (.plan-body/.plan-error/.plan-cancel/.plan-submit)', () => {
  // Given the #planModal markup
  const mStart = htmlSrc.indexOf('id="planModal"');
  assert.ok(mStart !== -1, '#planModal exists');
  const modal = htmlSrc.slice(mStart, htmlSrc.indexOf('</template>', mStart)); // bounded to before templates
  // Then it is a hidden task-modal following the shared structure
  assert.match(htmlSrc.slice(mStart - 40, mStart + 40), /class="task-modal hidden"/, 'planModal is a hidden task-modal');
  assert.match(modal, /class="task-modal-card"/);
  assert.match(modal, /class="task-modal-head"/);
  // And it has a multi-line textarea body, error slot, and the two action buttons
  assert.match(modal, /<textarea class="task-modal-body plan-body"/, 'plan-body textarea present');
  assert.match(modal, /class="task-modal-error plan-error"/, 'plan-error slot present');
  assert.match(modal, /class="plan-cancel small-btn"[^>]*>Cancel<\/button>/, 'Cancel button present');
  assert.match(modal, /class="plan-submit small-btn primary-btn"[^>]*>Plan<\/button>/, 'primary submit labelled "Plan"');
  // And the textarea placeholder invites a bullet list of required functionality
  assert.match(modal, /placeholder="Describe what you want built/i, 'textarea placeholder invites describing the feature');
  // And the CSS covers .plan-desc (appended to the .bugreport-desc rule)
  assert.match(cssSrc, /\.bugreport-desc,\s*\.plan-desc\s*\{/, '.plan-desc shares the bugreport-desc rule');
});

// ===========================================================================
// Scenario: els + click wiring
//   AC: tasksPlanBtn registered in els; click wired to openPlanModal alongside
//   tasksNewBtn.
// ===========================================================================
test('Scenario: renderer registers tasksPlanBtn and wires its click to openPlanModal', () => {
  // Then the per-tab els map registers tasksPlanBtn from .tasksPlanBtn
  assert.match(rendererSrc, /tasksPlanBtn:\s*ws\.querySelector\('\.tasksPlanBtn'\)/,
    'els.tasksPlanBtn is registered');
  // And it is registered directly above tasksNewBtn (same block)
  const planEls = rendererSrc.indexOf("tasksPlanBtn: ws.querySelector('.tasksPlanBtn')");
  const newEls = rendererSrc.indexOf("tasksNewBtn: ws.querySelector('.tasksNewBtn')");
  assert.ok(planEls !== -1 && newEls !== -1 && planEls < newEls,
    'tasksPlanBtn registered directly above tasksNewBtn');
  // And a click listener opens the plan modal, in the same wiring block as tasksNewBtn
  assert.match(rendererSrc,
    /tab\.els\.tasksPlanBtn\.addEventListener\('click',\s*\(\)\s*=>\s*openPlanModal\(tab\)\);/,
    'tasksPlanBtn click opens openPlanModal');
  assert.match(rendererSrc,
    /tab\.els\.tasksNewBtn\.addEventListener\('click',\s*\(\)\s*=>\s*openNewTaskModal\(tab\)\);/,
    'wired alongside the existing tasksNewBtn click');
});

// ===========================================================================
// Scenario: Opening the plan modal clears + focuses (mirrors openNewTaskModal)
//   AC: opening clears textarea and prior error, removes hidden, focuses textarea.
// ===========================================================================
test('Scenario: opening the plan modal clears the textarea + error, unhides, and focuses (source-scan)', () => {
  // Given openPlanModal in the real source
  const open = rendererSrc.slice(rendererSrc.indexOf('function openPlanModal(tab)'),
    rendererSrc.indexOf('// ── Bug reports'));
  // Then it guards on an open folder and resolves #planModal by id
  assert.match(open, /if \(!tab\.folder\) return;/, 'guards on an open folder');
  assert.match(open, /document\.getElementById\('planModal'\)/, 'resolves #planModal by id');
  // And it clears the body + error, re-enables submit, unhides, and focuses the textarea
  assert.match(open, /bodyArea\.value\s*=\s*''/, 'clears the textarea');
  assert.match(open, /errEl\.textContent\s*=\s*''/, 'clears any prior error');
  assert.match(open, /submitBtn\.disabled\s*=\s*false/, 're-enables submit on open');
  assert.match(open, /modal\.classList\.remove\('hidden'\)/, 'removes hidden');
  assert.match(open, /bodyArea\.focus\(\)/, 'focuses the textarea');
  // And listeners are bound with bindActionOnce (no stale listener on re-open)
  assert.match(open, /bindActionOnce\(submitBtn,\s*'click',\s*onSubmit\)/, 'submit bound via bindActionOnce');
  assert.match(open, /bindActionOnce\(cancelBtn,\s*'click',\s*onCancel\)/, 'cancel bound via bindActionOnce');
});

// ===========================================================================
// Scenario: Submitting a bullet-list feature request dispatches an orchestrate
// plan command (BEHAVIOURAL — executes the composition logic).
//   AC: non-empty text enqueues "/orchestrate plan " + trimmed text, renderQueue,
//   dispatch only when finished, modal closes, no ticket file written.
// ===========================================================================
test('Scenario: submitting a bullet list pushes one /orchestrate plan prompt and dispatches when idle', () => {
  // Given an idle terminal and a bullet-list description
  const queue = [];
  const bullets = ['- add a dark mode toggle', '- persist the choice per user', '- default to system preference'].join('\n');
  // When the user submits (terminal idle -> status 'finished')
  const r = planEnqueue(queue, bullets, 'finished');
  // Then exactly one prompt is pushed, beginning with "/orchestrate plan"
  assert.equal(queue.length, 1, 'exactly one prompt enqueued');
  assert.ok(r.pushed);
  assert.match(queue[0], /^\/orchestrate plan /, 'prompt begins with /orchestrate plan');
  // And it contains all three bullet lines, verbatim, as a SINGLE string (no newline split)
  assert.equal(queue[0], '/orchestrate plan ' + bullets, 'text passed verbatim as one prompt');
  assert.ok(queue[0].includes('- add a dark mode toggle'));
  assert.ok(queue[0].includes('- persist the choice per user'));
  assert.ok(queue[0].includes('- default to system preference'));
  // And the queue is dispatched because the terminal is idle
  assert.equal(r.dispatched, true, 'dispatch fires when status === finished');
  // And the modal closes
  assert.equal(r.modalOpen, false, 'modal closes after a successful enqueue');
  // And the plan prompt is NOT a build command (writes no ticket file itself)
  assert.equal(isBuildCommand(queue[0]), false, 'a plan prompt is not a build command');
});

// ===========================================================================
// Scenario: queued but not dispatched when the terminal is not idle
//   Edge: prompt is still queued; dispatch only fires when finished.
// ===========================================================================
test('Scenario: submitting while the terminal is busy queues the prompt but does not dispatch', () => {
  // Given the terminal is NOT idle (status !== 'finished')
  const queue = [];
  const r = planEnqueue(queue, '- build a settings page', 'running');
  // Then the prompt is still queued (nothing lost)
  assert.equal(queue.length, 1);
  assert.equal(queue[0], '/orchestrate plan - build a settings page');
  // But dispatch does NOT fire while busy
  assert.equal(r.dispatched, false, 'dispatch withheld until the terminal is idle');
  assert.equal(r.modalOpen, false, 'modal still closes on a valid submit');
});

// ===========================================================================
// Scenario: Cancel discards the request
//   AC: cancel closes the modal; nothing enqueued.
// ===========================================================================
test('Scenario: clicking Cancel closes the modal and enqueues nothing', () => {
  // Given text was entered but Cancel is chosen (onCancel just calls cleanup)
  const queue = [];
  // When cancel fires, no planEnqueue call happens -> queue untouched
  // (source-scan proves onCancel only cleans up and never pushes)
  const open = rendererSrc.slice(rendererSrc.indexOf('function openPlanModal(tab)'),
    rendererSrc.indexOf('// ── Bug reports'));
  assert.match(open, /const onCancel = \(\)\s*=>\s*cleanup\(\);/, 'cancel only cleans up');
  const cleanup = open.slice(open.indexOf('const cleanup = () =>'), open.indexOf('const armSubmit'));
  assert.match(cleanup, /modal\.classList\.add\('hidden'\)/, 'cleanup hides the modal');
  assert.ok(!/promptQueue\.push/.test(cleanup) && !/promptQueue\.push/.test('' + open.match(/onCancel[\s\S]*?cleanup\(\);/)),
    'cancel path never pushes onto the queue');
  // Then nothing was enqueued
  assert.equal(queue.length, 0, 'queue stays empty after Cancel');
});

// ===========================================================================
// Scenario Outline: Empty input is rejected (edge/failure)
//   Examples: '', '   ', '\n\t  \n'
//   AC: inline error, modal stays open, submit re-armed, nothing enqueued.
// ===========================================================================
for (const [label, text] of [['empty string', ''], ['spaces only', '   '], ['newlines+tabs', '\n\t  \n']]) {
  test(`Scenario Outline (edge): empty/whitespace input "${label}" is rejected with an inline error and no enqueue`, () => {
    // Given the plan modal is open and the textarea holds whitespace-only text
    const queue = [];
    // When the user clicks the Plan submit button
    const r = planEnqueue(queue, text, 'finished');
    // Then nothing is pushed onto the prompt queue
    assert.equal(queue.length, 0, 'no prompt enqueued for whitespace-only input');
    assert.equal(r.pushed, false);
    // And an inline error is shown
    assert.equal(r.error, PLAN_ERROR, 'inline error message shown');
    // And the modal stays open (submit re-armed for a retry)
    assert.equal(r.modalOpen, true, 'modal stays open on rejection');
    // And no dispatch happened
    assert.equal(r.dispatched, false);
  });
}

// ===========================================================================
// Scenario: Plan is unavailable without the skill (failure gating)
//   AC: Plan button disabled with no folder OR when skill not installed;
//   refreshed on the same board updates as Build.
// ===========================================================================
test('Scenario: the Plan button is disabled without an open folder or installed skill, and refreshed with Build', () => {
  // Given updatePlanBtn in the real source
  const upd = rendererSrc.slice(rendererSrc.indexOf('function updatePlanBtn(tab)'),
    rendererSrc.indexOf('function toggleAutoBuild(tab)'));
  // Then it gates disabled on folder AND skillInstalled
  assert.match(upd, /const installed = !!\(tab\.folder && tab\.tasks\.skillInstalled\)/,
    'gated on folder + skillInstalled');
  assert.match(upd, /btn\.disabled = !installed/, 'disabled unless both are true');
  // Behaviourally replicate the gate for the Gherkin matrix
  const gate = (folder, skillInstalled) => !!(folder && skillInstalled);
  assert.equal(gate(null, true), false, 'no folder -> disabled');
  assert.equal(gate('/proj', false), false, 'skill not installed -> disabled');
  assert.equal(gate('/proj', true), true, 'folder + skill -> enabled');
  // And updatePlanBtn is called at the SAME sites updateBuildBtn is refreshed
  const buildSites = [...rendererSrc.matchAll(/updateBuildBtn\(tab\);/g)].length;
  const planSites = [...rendererSrc.matchAll(/updatePlanBtn\(tab\);/g)].length;
  assert.ok(planSites >= 4, 'updatePlanBtn refreshed at >= 4 board-update sites');
  // Each of the 4 board-refresh sites that call updateBuildBtn is immediately followed by updatePlanBtn
  const paired = [...rendererSrc.matchAll(/updateBuildBtn\(tab\);\n\s*updatePlanBtn\(tab\);/g)].length;
  assert.ok(paired >= 4, `updatePlanBtn paired after updateBuildBtn at >= 4 sites (found ${paired}, build sites ${buildSites})`);
});

// ===========================================================================
// Scenario: Re-opening the modal does not double-dispatch (edge)
//   AC: open -> close -> open, submit once -> exactly one prompt enqueued.
// ===========================================================================
test('Scenario (edge): re-opening the modal then submitting once enqueues exactly one prompt', () => {
  // Given the modal was opened, closed (cancel), then opened again — the queue is shared
  const queue = [];
  // First open: user cancels (no enqueue)
  // (cancel pushes nothing — proven above)
  // Second open: user submits a valid description exactly once
  const r = planEnqueue(queue, 'a bulk export button', 'finished');
  // Then exactly one "/orchestrate plan" prompt is enqueued (no stale-listener double push)
  const planPrompts = queue.filter((p) => p.startsWith('/orchestrate plan'));
  assert.equal(planPrompts.length, 1, 'exactly one plan prompt enqueued');
  assert.equal(r.pushed, true);
  // And bindActionOnce guarantees the listener self-detaches (source-scan)
  assert.match(rendererSrc, /const armSubmit = \(\)\s*=>\s*\{\s*disposeSubmit = bindActionOnce\(submitBtn, 'click', onSubmit\); \};/,
    'submit is re-armed via bindActionOnce each fire (single-shot)');
});

// ===========================================================================
// DRIFT GUARD: tie the pure planEnqueue replica to the real openPlanModal so the
// behavioural scenarios above cannot silently diverge from shipped code.
// Catches: composition string / dispatch guard / empty-branch changes.
// ===========================================================================
test('DRIFT GUARD: openPlanModal composes "/orchestrate plan ", guards dispatch on finished, and skips push on empty', () => {
  const open = rendererSrc.slice(rendererSrc.indexOf('function openPlanModal(tab)'),
    rendererSrc.indexOf('// ── Bug reports'));
  // The real submit composes the SAME command prefix the replica uses.
  assert.match(open, /tab\.promptQueue\.push\('\/orchestrate plan ' \+ text\)/,
    'real submit pushes "/orchestrate plan " + text');
  assert.equal(planEnqueue([], 'x', 'finished').prompt, '/orchestrate plan x',
    'replica prompt prefix matches "/orchestrate plan "');
  // The real submit repaints the queue and dispatches ONLY when finished.
  assert.match(open, /renderQueue\(tab\);/, 'real submit repaints the queue');
  assert.match(open, /if \(tab\.status === 'finished'\) tryDispatchNextPrompt\(tab\);/,
    'real submit dispatches only when tab.status === finished');
  // The real submit trims and, on empty, sets the inline error and returns WITHOUT pushing.
  assert.match(open, /const text = bodyArea\.value\.trim\(\);/, 'real submit trims the textarea');
  const emptyBranch = open.slice(open.indexOf('if (!text) {'), open.indexOf('tab.promptQueue.push'));
  assert.match(emptyBranch, /errEl\.textContent\s*=\s*'Describe what you want built\.'/,
    'empty branch sets the inline error');
  assert.match(emptyBranch, /armSubmit\(\);/, 'empty branch re-arms submit');
  assert.match(emptyBranch, /return;/, 'empty branch returns before any push');
  assert.ok(!/promptQueue\.push/.test(emptyBranch), 'empty branch never pushes onto the queue');
  // And the replica's error text matches the shipped literal.
  assert.equal(PLAN_ERROR, 'Describe what you want built.');
});

// ===========================================================================
// DRIFT GUARD: the real isBuildCommand rule matches the replica, and a plan
// prompt is never a build command.
// ===========================================================================
test('DRIFT GUARD: isBuildCommand exact-match rule mirrors the source and rejects plan prompts', () => {
  assert.match(rendererSrc, /const BUILD_COMMAND = '\/orchestrate build';/, 'BUILD_COMMAND constant matches');
  assert.match(rendererSrc,
    /function isBuildCommand\(p\) \{\s*return typeof p === 'string' && \(p === BUILD_COMMAND \|\| p\.startsWith\(BUILD_COMMAND \+ ' '\)\);/,
    'isBuildCommand uses the exact bare/argumented match rule');
  // Behaviour: build commands match; a plan prompt never does.
  assert.equal(isBuildCommand('/orchestrate build'), true);
  assert.equal(isBuildCommand('/orchestrate build --concurrency 4'), true);
  assert.equal(isBuildCommand('/orchestrate plan add a dark mode toggle'), false,
    'a plan prompt is not a build command');
  assert.equal(isBuildCommand('/orchestrate plan'), false);
});
