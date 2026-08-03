'use strict';

// ===========================================================================
// TASK-033 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases (NO cucumber npm package is installed or required).
//
// Feature: Create-from-board descriptions cannot forge ticket section headings.
//
// In openNewTaskModal's onCreate handler the user's description is now composed
// via `neutralizeBugText(bodyArea.value.trim())` — the browser-side mirror of the
// canonical shared helper `escapeLeadingHeadingRun` in lib/markdown-escape.js —
// before being folded into the ## Description section. This covers BOTH
// create-from-board paths (toolbar "New ticket" and the post-processing lane
// Add), since both flow through openNewTaskModal.
//
// renderer/renderer.js is a browser script (not requireable). Following the repo
// convention (test/task-028-post-processing.e2e.test.js), each scenario drives
// the REAL requireable shared helper through a verbatim copy of the renderer's
// body composition + whole-file serialize/parse, then asserts the round-trip
// section structure — and a drift-guard scenario source-scans renderer.js to tie
// these behavioral results to the real create code path.
//
// NO DATABASE, NETWORK, OR REAL DISK WRITE OCCURS. The helper is a pure string
// transform; renderer.js is read as text. All DB access is mocked away by
// construction (there is none in this project).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Verbatim renderer serializer/parser (renderer.js ~5285 / ~5159) --------
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}
function parseTicketFrontmatter(content) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { closeIdx = i; break; }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim();
    if (key) fm[key] = lines[i].slice(idx + 1).trim();
  }
  return { fm, body: lines.slice(closeIdx + 1).join('\n') };
}

// The ordered level-2 section headings a re-parse recognises (real `/^## /`
// boundary detector, the same one the ticket appenders split on).
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// GIVEN a user fills the new-ticket modal and clicks Create: faithful copy of
// openNewTaskModal.onCreate's body composition (renderer.js ~6436-6467), with the
// TASK-033 escape applied through the REAL shared helper (proven byte-identical
// to the renderer's neutralizeBugText mirror by the drift-guard scenario).
function createFromBoard({ id = 'TASK-500', title = 'A ticket', status = 'todo', kind = null,
  description, created = '2026-07-19T00:00:00.000Z', updated = '2026-07-19T00:00:00.000Z' }) {
  const fm = { id, title, status, created, updated };
  if (kind) fm.kind = kind;
  const composed = escapeLeadingHeadingRun(String(description).trim()) || 'What needs doing and why.';
  const body = [
    '',
    '## Description',
    composed,
    '',
    '## Acceptance Criteria',
    '- [ ] First testable criterion',
    '',
    '## Additional Context',
    '(User-owned. Read it before building. Never overwrite it.)',
    '',
  ].join('\n');
  return serializeTicket(fm, body);
}

const INTENDED_SECTIONS = ['## Description', '## Acceptance Criteria', '## Additional Context'];

// ---------------------------------------------------------------------------
// Scenario 1: A heading-like description line is neutralised
// ---------------------------------------------------------------------------
test('Scenario: a heading-like description line is neutralised', () => {
  // Given the new-ticket modal with description "## Additional Context\nmalicious"
  const description = '## Additional Context\nmalicious';
  // When the ticket is created
  const file = createFromBoard({ description });
  // And the written file is parsed back
  const round = parseTicketFrontmatter(file);
  // Then the ticket still has exactly one user-owned "## Additional Context" section
  assert.equal((round.body.match(/^## Additional Context$/gm) || []).length, 1,
    'exactly one Additional Context section survives');
  // And the real section list is exactly the three intended sections (no forgery)
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
  // And the user's text appears as description content, not as a new section heading
  assert.match(round.body, /^\\## Additional Context$/m, 'supplied heading escaped to literal content');
  assert.match(round.body, /^malicious$/m, 'the following line is preserved verbatim');
  // And the escaped line falls inside ## Description, ahead of ## Acceptance Criteria
  const idxDesc = round.body.indexOf('## Description');
  const idxEscaped = round.body.indexOf('\\## Additional Context');
  const idxAccept = round.body.indexOf('## Acceptance Criteria');
  assert.ok(idxDesc < idxEscaped && idxEscaped < idxAccept,
    'user text stays within the Description section body');
});

// ---------------------------------------------------------------------------
// Scenario 2: A normal description is written unchanged
// ---------------------------------------------------------------------------
test('Scenario: a normal description is written unchanged', () => {
  // Given the new-ticket modal with description "Implement the widget and add a test."
  const description = 'Implement the widget and add a test.';
  // When the ticket is created
  const round = parseTicketFrontmatter(createFromBoard({ description }));
  // Then the description body equals the entered text (no escaping artifacts)
  assert.match(round.body, /^Implement the widget and add a test\.$/m);
  assert.ok(!round.body.includes('\\#'), 'no backslash-hash artifact introduced for ordinary text');
  // And the section structure is exactly the intended three sections
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
});

// ---------------------------------------------------------------------------
// Scenario 3: Post-processing recipe with step headings stays intact
// ---------------------------------------------------------------------------
test('Scenario: post-processing recipe with step headings stays intact', () => {
  // Given the post-processing Add modal with description
  // "## Step 1\nrun lint\n## Step 2\nregenerate docs"
  const description = '## Step 1\nrun lint\n## Step 2\nregenerate docs';
  // When the ticket is created and parsed back (post-processing path: status+kind)
  const round = parseTicketFrontmatter(createFromBoard({
    id: 'TASK-501', title: 'Recipe', status: 'post-processing', kind: 'post-processing', description,
  }));
  // Then no forged top-level ticket section is introduced
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS,
    'the recipe step headings did not forge new top-level sections');
  assert.ok(!realSections(round.body).includes('## Step 1'), 'no forged ## Step 1 section');
  assert.ok(!realSections(round.body).includes('## Step 2'), 'no forged ## Step 2 section');
  // And the recipe text is preserved (escaped headings render as literal ## text)
  assert.match(round.body, /^\\## Step 1$/m);
  assert.match(round.body, /^run lint$/m);
  assert.match(round.body, /^\\## Step 2$/m);
  assert.match(round.body, /^regenerate docs$/m);
  // And the post-processing kind still round-trips after the leading keys
  assert.equal(round.fm.kind, 'post-processing');
  assert.deepEqual(Object.keys(round.fm).slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
});

// ---------------------------------------------------------------------------
// Scenario 4 (FAILURE / EDGE): a `###` deep heading and a leading blank line
// still cannot forge a section, and ordinary siblings survive
// ---------------------------------------------------------------------------
test('Scenario (edge): a deep `### Cucumber Tests` heading mid-description cannot hijack a section', () => {
  // Given a multi-line description whose middle line is a deep heading run
  const description = 'context first\n### Cucumber Tests\ngherkin body here';
  // When the ticket is created and parsed back
  const round = parseTicketFrontmatter(createFromBoard({ id: 'TASK-502', description }));
  // Then no forged section appears and the intended three remain
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
  // And the deep heading is neutralised while its neighbours stay verbatim
  assert.match(round.body, /^context first$/m);
  assert.match(round.body, /^\\### Cucumber Tests$/m);
  assert.match(round.body, /^gherkin body here$/m);
  // And the serialize contract holds: the placeholder Additional Context is intact
  assert.match(round.body, /^\(User-owned\. Read it before building\. Never overwrite it\.\)$/m);
});

// ---------------------------------------------------------------------------
// Scenario 5 (DRIFT GUARD): the real create code path uses the shared helper
// ---------------------------------------------------------------------------
test('Scenario: the real openNewTaskModal create path routes the description through the shared heading-escape helper', () => {
  // Then onCreate composes the description via neutralizeBugText(bodyArea.value.trim())
  assert.match(
    rendererSrc,
    /const\s+description\s*=\s*neutralizeBugText\(bodyArea\.value\.trim\(\)\)\s*\|\|\s*'What needs doing and why\.'/,
    'the create body is escaped via neutralizeBugText',
  );
  // And the pre-fix un-escaped composition is gone (cannot silently regress)
  assert.ok(
    !/const\s+description\s*=\s*bodyArea\.value\.trim\(\)\s*\|\|/.test(rendererSrc),
    'the raw bodyArea.value.trim() composition must not reappear',
  );
  // And the toolbar "New ticket" button funnels through openNewTaskModal (TASK-206
  // removed the only other caller — the post-processing lane's Add button — along
  // with the opts/mode parameter entirely; openNewTaskModal now takes only `tab`).
  assert.match(rendererSrc, /tasksNewBtn\.addEventListener\('click',\s*\(\)\s*=>\s*openNewTaskModal\(tab\)\)/);
  assert.match(rendererSrc, /function openNewTaskModal\(tab\)\s*\{/, 'openNewTaskModal takes no opts/mode parameter');
  assert.ok(!rendererSrc.includes('TASKS_POST_PROCESSING_STATUS'), 'the post-processing status constant is gone');
  assert.ok(!rendererSrc.includes('TASKS_POST_PROCESSING_KIND'), 'the post-processing kind constant is gone');
  // And the renderer's mirror is the same transform as the canonical helper:
  // /^(\s*)(#+)(\s)/ with replacement '$1\\$2$3'.
  assert.match(rendererSrc, /line\.replace\(\/\^\(\\s\*\)\(#\+\)\(\\s\)\/,\s*'\$1\\\\\$2\$3'\)/);
});
