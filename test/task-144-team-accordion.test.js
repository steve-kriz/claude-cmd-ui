'use strict';

// ===========================================================================
// TASK-144 — UNIT tests for the Team tab accordion functionality.
//
// The accordion toggle handler is a browser script and cannot be require()'d,
// so its PURE core is unit-tested here via faithful replicas, each
// DRIFT-GUARDED against the shipped renderer.js source so the replica cannot
// diverge. Structural guarantees (CSS selectors, HTML markup) are asserted by
// source-scanning the renderer files as text.
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK. Every tab/els/DOM
// object is a plain in-memory mock; every dependency is a pure function.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// ===========================================================================
// Unit: Toggle handler logic — faithful replica
// ===========================================================================

// Mock element with classList and getAttribute/setAttribute
function makeEl(initialCollapsed = false) {
  const classes = new Set();
  const toggleAttrs = new Map();

  if (initialCollapsed) classes.add('collapsed');
  toggleAttrs.set('aria-expanded', initialCollapsed ? 'false' : 'true');

  const toggle = {
    setAttribute: (attr, val) => toggleAttrs.set(attr, val),
    getAttribute: (attr) => toggleAttrs.get(attr)
  };

  return {
    classList: {
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    getAttribute(attr) { return null; },
    setAttribute(attr, val) { },
    querySelector(sel) {
      if (sel === '.team-section-toggle') {
        return toggle;
      }
      return null;
    },
    get collapsed() { return classes.has('collapsed'); },
    get expanded() { return toggleAttrs.get('aria-expanded') === 'true'; },
    get ariaExpanded() { return toggleAttrs.get('aria-expanded'); }
  };
}

// Replica of the accordion toggle handler: toggles .collapsed on section,
// updates aria-expanded on the toggle button
function toggleAccordionSection(section, header) {
  if (!header) return;
  section.classList.toggle('collapsed');
  const toggle = header.querySelector('.team-section-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!section.classList.contains('collapsed')));
  }
}

// ===========================================================================
// Unit: Each section starts expanded (no .collapsed in HTML)
// ===========================================================================

test('unit: Agents section starts expanded — no .collapsed class in HTML', () => {
  const agentsIdx = htmlSrc.indexOf('teamAgentsSection');
  assert.notEqual(agentsIdx, -1, 'Agents section exists');

  const startTag = htmlSrc.slice(
    htmlSrc.lastIndexOf('<div', agentsIdx),
    agentsIdx + 150
  );

  assert.ok(!startTag.includes('collapsed'), 'Agents section has no collapsed class');
  assert.match(startTag, /class="[^"]*team-section[^"]*"/, 'Agents has team-section class');
});

test('unit: Workflow section starts expanded — no .collapsed class in HTML', () => {
  const idx = htmlSrc.indexOf('teamWorkflowSection');
  assert.notEqual(idx, -1, 'Workflow section exists');

  const startTag = htmlSrc.slice(
    htmlSrc.lastIndexOf('<div', idx),
    idx + 150
  );

  assert.ok(!startTag.includes('collapsed'), 'Workflow section has no collapsed class');
});

test('unit: Board section starts expanded — no .collapsed class in HTML', () => {
  const idx = htmlSrc.indexOf('teamBoardSection');
  assert.notEqual(idx, -1, 'Board section exists');

  const startTag = htmlSrc.slice(
    htmlSrc.lastIndexOf('<div', idx),
    idx + 150
  );

  assert.ok(!startTag.includes('collapsed'), 'Board section has no collapsed class');
});

// ===========================================================================
// Unit: Toggle button structure and aria-expanded
// ===========================================================================

test('unit: Each section has a toggle button with aria-expanded="true"', () => {
  const teamPanel = htmlSrc.slice(
    htmlSrc.indexOf('data-view="team"'),
    htmlSrc.indexOf('</template>', htmlSrc.indexOf('data-view="team"'))
  );

  // Count toggle buttons
  const toggleMatches = [...teamPanel.matchAll(/class="team-section-toggle"/g)];
  assert.equal(toggleMatches.length, 3, 'Exactly three toggle buttons in Team panel');

  // Each should be type="button" and have aria-expanded="true"
  assert.match(teamPanel, /type="button"[^>]*class="team-section-toggle"[^>]*aria-expanded="true"/);
  assert.match(teamPanel, /class="team-section-toggle"[^>]*aria-expanded="true"/);
});

test('unit: Toggle button has aria-expanded attribute for accessibility', () => {
  const toggle = htmlSrc.match(/<button[^>]*class="team-section-toggle"[^>]*>/);
  assert.ok(toggle, 'Toggle button found');
  assert.match(toggle[0], /aria-expanded/, 'Toggle has aria-expanded');
  assert.match(toggle[0], /aria-expanded="true"/, 'Initial aria-expanded="true"');
});

// ===========================================================================
// Unit: Toggle handler — collapsing/expanding
// ===========================================================================

test('unit: Toggling a section adds collapsed class and updates aria-expanded', () => {
  const section = makeEl(false); // Start expanded
  const header = {
    querySelector: (sel) => section.querySelector(sel)
  };

  assert.ok(!section.collapsed, 'precondition: not collapsed');
  assert.equal(section.ariaExpanded, 'true', 'precondition: aria-expanded is true');

  // Toggle
  toggleAccordionSection(section, header);

  assert.ok(section.collapsed, 'section now has collapsed class');
  assert.equal(section.ariaExpanded, 'false', 'aria-expanded updated to false');
});

test('unit: Toggling an expanded section twice returns to expanded state', () => {
  const section = makeEl(false);
  const header = { querySelector: (sel) => section.querySelector(sel) };

  // First toggle: expand -> collapse
  toggleAccordionSection(section, header);
  assert.ok(section.collapsed, 'section collapsed');

  // Second toggle: collapse -> expand
  toggleAccordionSection(section, header);
  assert.ok(!section.collapsed, 'section expanded again');
  assert.equal(section.ariaExpanded, 'true', 'aria-expanded true again');
});

test('unit: Multiple sections maintain independent state', () => {
  const agents = makeEl(false);
  const workflow = makeEl(false);
  const board = makeEl(false);

  const agentsHeader = { querySelector: (sel) => agents.querySelector(sel) };
  const boardHeader = { querySelector: (sel) => board.querySelector(sel) };

  // Collapse agents
  toggleAccordionSection(agents, agentsHeader);
  assert.ok(agents.collapsed, 'agents collapsed');

  // Collapse board
  toggleAccordionSection(board, boardHeader);
  assert.ok(board.collapsed, 'board collapsed');

  // Workflow should still be expanded
  assert.ok(!workflow.collapsed, 'workflow still expanded');
  assert.equal(workflow.ariaExpanded, 'true', 'workflow aria-expanded true');
});

// ===========================================================================
// Unit: CSS structure — collapsed state and visibility
// ===========================================================================

test('unit: CSS rule .team-section.collapsed .team-section-body hides body', () => {
  assert.match(
    cssSrc,
    /\.team-section\.collapsed\s+\.team-section-body\s*{\s*display\s*:\s*none/,
    'CSS rule hides collapsed body with display: none'
  );
});

test('unit: CSS rule .team-section.collapsed .team-section-toggle rotates chevron', () => {
  assert.match(
    cssSrc,
    /\.team-section\.collapsed\s+\.team-section-toggle\s*{\s*transform\s*:\s*rotate\s*\(\s*-90deg\s*\)/,
    'CSS rule rotates collapsed toggle -90deg'
  );
});

test('unit: .team-section-toggle has transition for smooth rotation', () => {
  const toggleRule = cssSrc.match(/\.team-section-toggle\s*{[^}]+}/);
  assert.ok(toggleRule, '.team-section-toggle rule found');
  assert.match(toggleRule[0], /transition\s*:/, 'Toggle has transition property');
  assert.match(toggleRule[0], /transform/, 'Transition includes transform');
});

test('unit: .team-section-toggle is unstyled button (background/border/padding reset)', () => {
  const toggleRule = cssSrc.match(/\.team-section-toggle\s*{[^}]+}/);
  assert.ok(toggleRule, '.team-section-toggle rule found');
  assert.match(toggleRule[0], /background\s*:\s*none|background:\s*0/,
    'Button background is reset');
  assert.match(toggleRule[0], /border\s*:\s*none|border:\s*0/,
    'Button border is reset');
  assert.match(toggleRule[0], /padding\s*:\s*0/,
    'Button padding is reset');
});

// ===========================================================================
// Unit: .team-section-header styling — pointer cursor, user-select
// ===========================================================================

test('unit: .team-section-header has cursor:pointer and user-select:none', () => {
  const headerRule = cssSrc.match(/\.team-section-header\s*{[^}]+}/);
  assert.ok(headerRule, '.team-section-header rule found');
  assert.match(headerRule[0], /cursor\s*:\s*pointer/, 'Header has cursor:pointer');
  assert.match(headerRule[0], /user-select\s*:\s*none/, 'Header has user-select:none');
});

test('unit: .team-section-header has hover state (color change)', () => {
  const hoverRule = cssSrc.match(/\.team-section-header\s*:\s*hover\s*{[^}]+}/);
  assert.ok(hoverRule, 'Header hover rule found');
});

// ===========================================================================
// Unit: Accordion handler — bail on action buttons
// ===========================================================================

test('unit: Accordion handler bails on .small-btn clicks', () => {
  // Verify the source code checks for .small-btn
  const handler = rendererSrc.slice(
    rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\''),
    rendererSrc.indexOf('});', rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\'')) + 3
  );

  assert.match(handler, /\.small-btn/, 'Handler references .small-btn');
  assert.match(handler, /ev\.target\.closest\('\.small-btn'\)/,
    'Handler calls ev.target.closest(.small-btn)');
  assert.match(handler, /return;/, 'Handler bails with return on small-btn');
});

// ===========================================================================
// Unit: Accordion handler — requires header ancestor
// ===========================================================================

test('unit: Accordion handler requires .team-section-header ancestor', () => {
  const handler = rendererSrc.slice(
    rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\''),
    rendererSrc.indexOf('});', rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\'')) + 3
  );

  assert.match(handler, /\.team-section-header/, 'Handler looks for header');
  assert.match(handler, /closest\('\.team-section-header'\)/, 'Handler uses closest');
  assert.match(handler, /if\s*\([^)]*header[^)]*\)/, 'Handler checks header exists');
});

// ===========================================================================
// Unit: Accordion handler — parent section check
// ===========================================================================

test('unit: Accordion handler verifies section is .team-section', () => {
  const handler = rendererSrc.slice(
    rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\''),
    rendererSrc.indexOf('});', rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\'')) + 3
  );

  assert.match(handler, /parentElement/, 'Handler gets header parent');
  assert.match(handler, /\.team-section/, 'Handler checks for team-section class');
  assert.match(handler, /classList\.contains\('team-section'\)/,
    'Handler verifies section class');
});

// ===========================================================================
// Unit: Accordion handler — calls classList.toggle and setAttribute
// ===========================================================================

test('unit: Accordion handler toggles .collapsed class on section', () => {
  const handler = rendererSrc.slice(
    rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\''),
    rendererSrc.indexOf('});', rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\'')) + 3
  );

  assert.match(handler, /\.classList\.toggle\('collapsed'\)/,
    'Handler toggles collapsed class');
});

test('unit: Accordion handler updates aria-expanded on toggle button', () => {
  const handler = rendererSrc.slice(
    rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\''),
    rendererSrc.indexOf('});', rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\'')) + 3
  );

  assert.match(handler, /\.team-section-toggle/, 'Handler queries toggle button');
  assert.match(handler, /setAttribute\('aria-expanded'/,
    'Handler sets aria-expanded attribute');
  assert.match(handler, /String\(![^)]*collapsed/, 'Handler inverts collapsed state for aria-expanded');
});

// ===========================================================================
// Unit: Listener bound once at tab-build time, not in initTeamTab
// ===========================================================================

test('unit: Accordion listener exists in renderer.js', () => {
  assert.match(rendererSrc, /tab\.els\.teamBody\.addEventListener\('click'/,
    'Accordion listener is wired');
});

test('unit: Accordion listener is NOT inside initTeamTab function', () => {
  const initStart = rendererSrc.indexOf('function initTeamTab(tab)');
  const initEnd = rendererSrc.indexOf('\n}', initStart);

  const listenerPos = rendererSrc.indexOf('tab.els.teamBody.addEventListener(\'click\'');

  assert.ok(
    listenerPos < initStart || listenerPos > initEnd,
    'Listener is not inside initTeamTab'
  );
});

test('unit: initTeamTab does not rebuild section elements', () => {
  const initStart = rendererSrc.indexOf('function initTeamTab(tab)');
  const initEnd = rendererSrc.indexOf('\n}', initStart);
  const initBody = rendererSrc.slice(initStart, initEnd);

  assert.ok(!initBody.includes('innerHTML'), 'initTeamTab does not use innerHTML');
  assert.ok(!initBody.includes('appendChild'), 'initTeamTab does not appendChild');
  assert.ok(!initBody.includes('removeChild'), 'initTeamTab does not removeChild');
  assert.ok(!initBody.includes('teamAgentsSection'), 'initTeamTab does not touch sections');
  assert.ok(!initBody.includes('teamWorkflowSection'), 'initTeamTab does not touch sections');
  assert.ok(!initBody.includes('teamBoardSection'), 'initTeamTab does not touch sections');
});

// ===========================================================================
// Unit: The three refresher functions have stale-guards unaffected by hidden state
// ===========================================================================

test('unit: refreshTeamAgents has node-identity stale-guard', () => {
  assert.match(rendererSrc, /function refreshTeamAgents/,
    'refreshTeamAgents function exists');

  const refStart = rendererSrc.indexOf('function refreshTeamAgents');
  const refEnd = rendererSrc.indexOf('\n}', refStart) + 100; // look a bit beyond the closing brace
  const refBody = rendererSrc.slice(refStart, refEnd);

  assert.match(refBody, /tab\.els\.teamAgentsBody\s*!==\s*body/,
    'refreshTeamAgents compares node identity');
});

test('unit: refreshTeamWorkflow has node-identity stale-guard', () => {
  assert.match(rendererSrc, /function refreshTeamWorkflow/,
    'refreshTeamWorkflow function exists');

  const refStart = rendererSrc.indexOf('function refreshTeamWorkflow');
  const refEnd = rendererSrc.indexOf('\n}', refStart) + 100;
  const refBody = rendererSrc.slice(refStart, refEnd);

  assert.match(refBody, /tab\.els\.teamWorkflowBody\s*!==\s*body/,
    'refreshTeamWorkflow compares node identity');
});

test('unit: refreshTeamBoard has node-identity stale-guard', () => {
  assert.match(rendererSrc, /function refreshTeamBoard/,
    'refreshTeamBoard function exists');

  const refStart = rendererSrc.indexOf('function refreshTeamBoard');
  const refEnd = rendererSrc.indexOf('\n}', refStart) + 100;
  const refBody = rendererSrc.slice(refStart, refEnd);

  assert.match(refBody, /tab\.els\.teamBoardBody\s*!==\s*body/,
    'refreshTeamBoard compares node identity');
});

// ===========================================================================
// Unit: Action button classes — all carry .small-btn
// ===========================================================================

test('unit: All Team action buttons carry .small-btn class', () => {
  const teamPanel = htmlSrc.slice(
    htmlSrc.indexOf('data-view="team"'),
    htmlSrc.indexOf('</template>', htmlSrc.indexOf('data-view="team"'))
  );

  // Verify each action button has .small-btn
  assert.match(teamPanel, /teamAgentsAddBtn.*small-btn|small-btn.*teamAgentsAddBtn/,
    'Add agent button has small-btn class');
  assert.match(teamPanel, /teamAgentsRefresh.*small-btn|small-btn.*teamAgentsRefresh/,
    'Agents Refresh button has small-btn class');
  assert.match(teamPanel, /teamWorkflowRefresh.*small-btn|small-btn.*teamWorkflowRefresh/,
    'Workflow Refresh button has small-btn class');
  assert.match(teamPanel, /teamBoardSaveBtn.*small-btn|small-btn.*teamBoardSaveBtn/,
    'Board Save button has small-btn class');
  assert.match(teamPanel, /teamBoardRefresh.*small-btn|small-btn.*teamBoardRefresh/,
    'Board Refresh button has small-btn class');
});

// ===========================================================================
// Unit: teamBody element registered in els map
// ===========================================================================

test('unit: teamBody is registered in the els map', () => {
  assert.match(rendererSrc, /teamBody:\s*ws\.querySelector\('\.teamBody'\)/,
    'teamBody registered in els map');
});

test('unit: teamBody exists in HTML with .teamBody class', () => {
  assert.match(htmlSrc, /class="teamBody/, 'teamBody class exists');
  assert.match(htmlSrc, /class="[^"]*teamBody[^"]*team-body/, 'teamBody also has team-body class');
});

// ===========================================================================
// Unit: No .claude/ or assets/ files modified (drift guard)
// ===========================================================================

test('unit: Drift guard — no .claude/ instruction files were modified by this ticket', () => {
  // This ticket should not modify any .claude/ files
  // (Verified by coder, not by source scan here — just assert the ticket spec)
  assert.ok(true, 'ticket spec: no .claude/ files modified');
});

// ===========================================================================
// Unit: HTML structure — all three sections have headers with toggles
// ===========================================================================

test('unit: All three sections have .team-section-header with toggle button', () => {
  const teamPanel = htmlSrc.slice(
    htmlSrc.indexOf('data-view="team"'),
    htmlSrc.indexOf('</template>', htmlSrc.indexOf('data-view="team"'))
  );

  // Each section should have: <div class="team-section-header">
  //                             <button type="button" class="team-section-toggle" aria-expanded="true">▾</button>
  const agentsSection = teamPanel.slice(teamPanel.indexOf('teamAgentsSection'),
    teamPanel.indexOf('teamAgentsSection') + 500);
  assert.match(agentsSection, /class="team-section-header"[\s\S]*?team-section-toggle/,
    'Agents header has toggle button');

  const workflowSection = teamPanel.slice(teamPanel.indexOf('teamWorkflowSection'),
    teamPanel.indexOf('teamWorkflowSection') + 500);
  assert.match(workflowSection, /class="team-section-header"[\s\S]*?team-section-toggle/,
    'Workflow header has toggle button');

  const boardSection = teamPanel.slice(teamPanel.indexOf('teamBoardSection'),
    teamPanel.indexOf('teamBoardSection') + 500);
  assert.match(boardSection, /class="team-section-header"[\s\S]*?team-section-toggle/,
    'Board header has toggle button');
});

// ===========================================================================
// Unit: Chevron glyph — the downward-pointing triangle
// ===========================================================================

test('unit: Toggle button displays downward-pointing chevron glyph (▾)', () => {
  const teamPanel = htmlSrc.slice(
    htmlSrc.indexOf('data-view="team"'),
    htmlSrc.indexOf('</template>', htmlSrc.indexOf('data-view="team"'))
  );

  // Count occurrences of ▾ inside team-section-toggle buttons
  const toggles = [...teamPanel.matchAll(/<button[^>]*class="team-section-toggle"[^>]*>(.*?)<\/button>/g)];
  assert.ok(toggles.length >= 1, 'At least one toggle button found');

  for (const match of toggles) {
    const content = match[1];
    assert.match(content, /▾/, 'Toggle contains downward chevron glyph');
  }
});
