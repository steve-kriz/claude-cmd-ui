'use strict';

// ===========================================================================
// TASK-147 — e2e "cucumber" scenarios (Given/When/Then) as plain `node --test`
// cases (no cucumber package), matching the repo convention.
//
// Feature: A new app-global "Stats" sub-tab. The Usage & telemetry section
// (live tokens/cost display + its enable/forward settings) moves OUT of the
// Team → Workflow panel into its own Stats tab. This adds a tab button
// (data-tab="stats") after Team, a hidden tab-view panel (data-view="stats")
// with a .view-toolbar ("Stats") and a .statsBody host, els-map entries, a
// switchSubTab branch routing "stats" -> initStatsTab, and styles. initStatsTab
// (re)mounts buildTelemetryControl into the Stats body; buildWorkflowView no
// longer mounts it.
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK CALL IS MADE. The
// browser files cannot be require()'d, so — as in task-091 — their wiring is
// proven by SOURCE-SCANNING renderer.js / index.html / styles.css as text, plus
// a pure replica of initStatsTab driven over a mock DOM.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// Extract a function's OWN body, anchored on its column-0 closing brace (the
// 2-space-indented body never emits a column-0 `}` until the function ends).
// Both boundaries are asserted found before slicing.
function extractFnBody(src, header) {
  const fnStart = src.indexOf(header);
  assert.notEqual(fnStart, -1, `${header} found in source`);
  const braceEnd = src.indexOf('\n}', fnStart);
  assert.notEqual(braceEnd, -1, `${header} column-0 closing brace found in source`);
  return src.slice(fnStart, braceEnd + 2);
}

// ===========================================================================
// Scenario: The Stats tab exists after Team
// ===========================================================================
test('Scenario: the Stats tab-btn appears after Team and a data-view="stats" panel exists', () => {
  const teamBtn = htmlSrc.indexOf('data-tab="team"');
  const statsBtn = htmlSrc.indexOf('data-tab="stats"');
  assert.ok(statsBtn !== -1, 'a tab-btn with data-tab="stats" exists');
  assert.match(
    htmlSrc.slice(htmlSrc.lastIndexOf('<button', statsBtn), statsBtn + 40),
    /class="tab-btn"\s+data-tab="stats"/,
    'the Stats button uses the shared tab-btn class'
  );
  assert.match(
    htmlSrc.slice(statsBtn, htmlSrc.indexOf('</button>', statsBtn) + 9),
    />Stats<\/button>/,
    'the Stats button is labelled "Stats"'
  );
  assert.ok(teamBtn !== -1 && statsBtn > teamBtn, 'Stats button comes after the Team button');
  assert.ok(htmlSrc.includes('data-view="stats"'), 'a tab-view with data-view="stats" exists');
});

// ===========================================================================
// Scenario: The Stats panel hosts a toolbar + a body container
// ===========================================================================
test('Scenario: the Stats panel has a "Stats" .view-toolbar and a .statsBody host', () => {
  const vStart = htmlSrc.indexOf('data-view="stats"');
  const vClose = htmlSrc.indexOf('</template>', vStart);
  assert.notEqual(vClose, -1, 'the workspace <template> close bounds the Stats panel');
  const panel = htmlSrc.slice(vStart, vClose);
  assert.match(panel, /class="view-toolbar"/, 'the Stats panel has a .view-toolbar');
  assert.match(panel, /Stats<\/span>/, 'the toolbar shows the "Stats" title');
  assert.match(panel, /class="statsBody[^"]*"/, '.statsBody host exists');
});

// ===========================================================================
// Scenario (edge): The Stats panel + button default to hidden/inactive
// ===========================================================================
test('Scenario (edge): the Stats panel ships hidden — no "active" class on panel or button', () => {
  const idx = htmlSrc.indexOf('data-view="stats"');
  const openTag = htmlSrc.slice(htmlSrc.lastIndexOf('<div', idx), idx + 20);
  assert.match(openTag, /class="tab-view"/, 'Stats panel is a tab-view');
  assert.ok(!/tab-view active/.test(openTag), 'Stats panel does not ship with the active class');
  const btnIdx = htmlSrc.indexOf('data-tab="stats"');
  const btnTag = htmlSrc.slice(htmlSrc.lastIndexOf('<button', btnIdx), btnIdx + 20);
  assert.ok(!/tab-btn active/.test(btnTag), 'Stats button does not ship active');
});

// ===========================================================================
// Scenario: els + switchSubTab routing
// ===========================================================================
test('Scenario: renderer registers Stats els and switchSubTab routes "stats" -> initStatsTab', () => {
  assert.match(rendererSrc, /statsView:\s*ws\.querySelector\('\.tab-view\[data-view="stats"\]'\)/, 'els.statsView registered');
  assert.match(rendererSrc, /statsStatus:\s*ws\.querySelector\('\.statsStatus'\)/, 'els.statsStatus registered');
  assert.match(rendererSrc, /statsBody:\s*ws\.querySelector\('\.statsBody'\)/, 'els.statsBody registered');

  const sw = extractFnBody(rendererSrc, 'function switchSubTab(tab, name)');
  assert.match(sw, /name === 'stats'\)\s*\{\s*\n\s*initStatsTab\(tab\);/, 'switchSubTab routes "stats" -> initStatsTab');
});

// ===========================================================================
// Scenario: telemetry moved OUT of the Workflow panel INTO the Stats tab
// ===========================================================================
test('Scenario: buildWorkflowView no longer mounts telemetry; initStatsTab does', () => {
  const wf = extractFnBody(rendererSrc, 'function buildWorkflowView(tab, model, agentNames, agentFiles, rawConfig)');
  assert.ok(!/buildTelemetryControl\(/.test(wf), 'buildWorkflowView no longer calls buildTelemetryControl');

  const stats = extractFnBody(rendererSrc, 'function initStatsTab(tab)');
  assert.match(stats, /buildTelemetryControl\(tab\)/, 'initStatsTab mounts buildTelemetryControl(tab) with tab argument');
  assert.match(stats, /statsBody/, 'initStatsTab targets the Stats body');
});

// ===========================================================================
// Scenario: initStatsTab behaviour over a mock DOM (pure replica, drift-guarded)
//   - clears the body, then appends exactly one child (the telemetry control)
//   - a missing body is a no-op (never throws)
// ===========================================================================
function makeEl() {
  const children = [];
  let text = '';
  const el = {
    children,
    appendChild(c) { children.push(c); return c; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return children.length ? '' : text; },
    set(v) { text = String(v); children.length = 0; },
  });
  return el;
}

// Replica of initStatsTab — drift-guarded below against the real source.
function initStatsTabReplica(tab, buildTelemetryControl) {
  const body = tab && tab.els ? tab.els.statsBody : null;
  if (!body) return;
  body.textContent = '';
  if (typeof buildTelemetryControl === 'function') body.appendChild(buildTelemetryControl());
}

test('Scenario: initStatsTab clears the body and mounts one telemetry control', () => {
  const body = makeEl();
  body.textContent = 'stale'; // pre-existing content that must be cleared
  let built = 0;
  const control = makeEl();
  initStatsTabReplica({ els: { statsBody: body } }, () => { built++; return control; });
  assert.equal(built, 1, 'the telemetry control is built exactly once');
  assert.equal(body.children.length, 1, 'exactly one child mounted (stale content cleared first)');
  assert.equal(body.children[0], control, 'the mounted child is the telemetry control');
});

test('Scenario (edge): initStatsTab is a no-op when the body is absent and never throws', () => {
  assert.doesNotThrow(() => initStatsTabReplica({ els: {} }, () => makeEl()));
  assert.doesNotThrow(() => initStatsTabReplica(null, () => makeEl()));
});

// Drift-guard: the replica's core statements must appear verbatim in the real
// initStatsTab so the mock-DOM behaviour above cannot silently diverge.
test('Drift-guard: real initStatsTab matches the replica shape', () => {
  const stats = extractFnBody(rendererSrc, 'function initStatsTab(tab)');
  assert.match(stats, /const body = tab && tab\.els \? tab\.els\.statsBody : null;/);
  assert.match(stats, /if \(!body\) return;/);
  assert.match(stats, /body\.textContent = '';/);
  assert.match(stats, /body\.appendChild\(buildTelemetryControl\(tab\)\)/);
});

// ===========================================================================
// Scenario: styles for the Stats body exist
// ===========================================================================
test('Scenario: .stats-body has padded, scrollable column styles', () => {
  assert.match(cssSrc, /\.stats-body\s*\{/, '.stats-body rule exists');
  const rule = cssSrc.slice(cssSrc.indexOf('.stats-body'), cssSrc.indexOf('}', cssSrc.indexOf('.stats-body')) + 1);
  assert.match(rule, /overflow:\s*auto/, '.stats-body scrolls');
  assert.match(rule, /padding:/, '.stats-body is padded');
});
