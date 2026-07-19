'use strict';

// ===========================================================================
// TASK-033 — UNIT tests for "escape heading-like lines in create-from-board
// ticket descriptions".
//
// The fix: openNewTaskModal's onCreate composes the ## Description body from
// `neutralizeBugText(bodyArea.value.trim())` (renderer.js ~6446) instead of the
// raw `bodyArea.value.trim()`. `neutralizeBugText` is the browser-side mirror of
// the canonical, requireable shared helper `escapeLeadingHeadingRun` in
// lib/markdown-escape.js. Both create-from-board paths (toolbar "New ticket" and
// the post-processing lane Add) flow through openNewTaskModal, so both are
// covered by one change.
//
// renderer/renderer.js is a browser script and cannot be require()'d, so these
// tests follow the repo convention (test/task-028-post-processing.e2e.test.js,
// test/markdown-escape*.test.js):
//   1. Behavioral coverage drives the REAL requireable helper
//      (escapeLeadingHeadingRun) through a verbatim copy of the renderer's
//      serialize/parse + body composition, proving the round-trip result.
//   2. Drift guards SOURCE-SCAN renderer.js to prove the real create path calls
//      neutralizeBugText, and that the renderer mirror is byte-identical to the
//      shared helper — so the fix cannot silently regress or drift.
//
// NO DATABASE, NETWORK, OR REAL DISK WRITE. The lib helper is pure; renderer.js
// is read as text only. All DB access is mocked away by construction (there is
// none).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');
const { neutralizeBugText } = require('../lib/ticket-bug-reports');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const mdEscapeSrc = fs.readFileSync(path.join(REPO, 'lib', 'markdown-escape.js'), 'utf8');

// ---------------------------------------------------------------------------
// Verbatim copies of the renderer's whole-file serializer/parser (renderer.js
// ~5285 / ~5159 — browser script, not requireable). Used to drive real
// serialize→parse round-trips of a composed ticket.
// ---------------------------------------------------------------------------
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}
function parseTicketFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { closeIdx = i; break; }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fm[key] = line.slice(idx + 1).trim();
  }
  return { fm, body: lines.slice(closeIdx + 1).join('\n') };
}

// The REAL section-boundary detector the ticket parser/appenders use (`/^## /`).
// The ordered list of level-2 section headings a re-parse would recognise.
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// Faithful reproduction of openNewTaskModal.onCreate's body composition
// (renderer.js ~6436-6467), with the TASK-033 escape applied via the REAL shared
// helper (byte-identical to the renderer mirror per the drift guard below).
function composeCreatedTicket({ id, title, status, kind, descriptionInput, created, updated }) {
  const fm = { id, title, status, created, updated };
  if (kind) fm.kind = kind;
  const description = escapeLeadingHeadingRun(String(descriptionInput).trim()) || 'What needs doing and why.';
  const body = [
    '',
    '## Description',
    description,
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

const NOW = '2026-07-19T00:00:00.000Z';
const INTENDED_SECTIONS = ['## Description', '## Acceptance Criteria', '## Additional Context'];

// ===========================================================================
// Group A — behavioral: the escape neutralises heading-forging descriptions
// ===========================================================================

test('unit: a `## Additional Context` description line does not forge a second section after round-trip', () => {
  const file = composeCreatedTicket({
    id: 'TASK-901', title: 'x', status: 'todo',
    descriptionInput: '## Additional Context\nmalicious', created: NOW, updated: NOW,
  });
  const round = parseTicketFrontmatter(file);
  // Exactly the three intended sections — no forged/duplicated heading.
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
  // Exactly ONE Additional Context section (the placeholder), not two.
  assert.equal((round.body.match(/^## Additional Context$/gm) || []).length, 1);
  // The user's line survives inside ## Description as escaped literal content.
  assert.match(round.body, /^\\## Additional Context$/m);
  assert.match(round.body, /^malicious$/m);
});

test('unit: each of the reserved heading-run examples is neutralised, not promoted', () => {
  for (const supplied of ['## Additional Context', '## Acceptance Criteria', '## Cucumber Tests']) {
    const round = parseTicketFrontmatter(composeCreatedTicket({
      id: 'TASK-902', title: 't', status: 'todo',
      descriptionInput: supplied, created: NOW, updated: NOW,
    }));
    // Still exactly the intended sections regardless of what the user typed.
    assert.deepEqual(realSections(round.body), INTENDED_SECTIONS,
      `"${supplied}" must not forge a section`);
    // The supplied heading run is present but escaped (starts with backslash).
    const escaped = '\\' + supplied;
    assert.ok(round.body.split('\n').includes(escaped),
      `"${supplied}" preserved as escaped literal "${escaped}"`);
  }
});

test('unit: a heading-like line in the MIDDLE of a multi-line description is neutralised; siblings intact', () => {
  const round = parseTicketFrontmatter(composeCreatedTicket({
    id: 'TASK-903', title: 't', status: 'todo',
    descriptionInput: 'first line\n## Acceptance Criteria\nlast line', created: NOW, updated: NOW,
  }));
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
  assert.match(round.body, /^first line$/m);
  assert.match(round.body, /^\\## Acceptance Criteria$/m);
  assert.match(round.body, /^last line$/m);
});

// ===========================================================================
// Group B — behavioral: ordinary descriptions are untouched (no artifacts)
// ===========================================================================

test('unit: a normal description with no leading hashes round-trips byte-for-byte (no backslash artifacts)', () => {
  const text = 'Implement the widget and add a test.';
  const round = parseTicketFrontmatter(composeCreatedTicket({
    id: 'TASK-904', title: 't', status: 'todo',
    descriptionInput: text, created: NOW, updated: NOW,
  }));
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
  assert.match(round.body, /^Implement the widget and add a test\.$/m);
  // No escaping artifact anywhere in the Description content.
  assert.ok(!round.body.includes('\\#'), 'no backslash-hash artifact for ordinary prose');
});

test('unit: an inline `##` (not at line start) is left untouched', () => {
  const round = parseTicketFrontmatter(composeCreatedTicket({
    id: 'TASK-905', title: 't', status: 'todo',
    descriptionInput: 'see ## note for details', created: NOW, updated: NOW,
  }));
  assert.match(round.body, /^see ## note for details$/m);
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
});

test('unit: an empty description falls back to the placeholder and still writes a valid body', () => {
  const round = parseTicketFrontmatter(composeCreatedTicket({
    id: 'TASK-906', title: 't', status: 'todo',
    descriptionInput: '', created: NOW, updated: NOW,
  }));
  assert.match(round.body, /^What needs doing and why\.$/m);
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
});

// ===========================================================================
// Group C — serialize contract preserved (leading key order, placeholder,
// created preserved / updated bumped, kind survives for post-processing)
// ===========================================================================

test('unit: serialize contract — leading key order, placeholder, created/updated', () => {
  const created = '2026-07-01T00:00:00.000Z';
  const updated = '2026-07-19T09:30:00.000Z';
  const round = parseTicketFrontmatter(composeCreatedTicket({
    id: 'TASK-907', title: 'Ship it', status: 'todo',
    descriptionInput: '## Description hijack attempt', created, updated,
  }));
  assert.deepEqual(Object.keys(round.fm).slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.equal(round.fm.created, created, 'created preserved verbatim');
  assert.equal(round.fm.updated, updated, 'updated is the bumped value');
  assert.match(round.body, /^## Additional Context$/m);
  assert.match(round.body, /\(User-owned\. Read it before building\. Never overwrite it\.\)/);
});

test('unit: post-processing create keeps kind after the leading keys and still neutralises', () => {
  const round = parseTicketFrontmatter(composeCreatedTicket({
    id: 'TASK-908', title: 'Regen docs', status: 'post-processing', kind: 'post-processing',
    descriptionInput: '## Step 1\nrun lint', created: NOW, updated: NOW,
  }));
  assert.deepEqual(Object.keys(round.fm).slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.equal(round.fm.kind, 'post-processing', 'kind survives after the leading keys');
  assert.deepEqual(realSections(round.body), INTENDED_SECTIONS);
  assert.match(round.body, /^\\## Step 1$/m);
});

// ===========================================================================
// Group D — DRIFT GUARDS (source-scan): tie the behavior to the real code path
// ===========================================================================

test('drift guard: openNewTaskModal composes the description via neutralizeBugText(bodyArea.value.trim())', () => {
  // The exact composition line from onCreate — must route through the helper.
  assert.match(
    rendererSrc,
    /const\s+description\s*=\s*neutralizeBugText\(bodyArea\.value\.trim\(\)\)\s*\|\|\s*'What needs doing and why\.'/,
    'create path escapes the description body via neutralizeBugText',
  );
  // The raw (unescaped) pre-fix form must be gone so the fix cannot regress.
  assert.ok(
    !/const\s+description\s*=\s*bodyArea\.value\.trim\(\)\s*\|\|/.test(rendererSrc),
    'the un-escaped `bodyArea.value.trim()` composition must not reappear',
  );
});

test('drift guard: renderer neutralizeBugText transform is byte-identical to escapeLeadingHeadingRun', () => {
  // Extract the core `.replace(/regex/, 'replacement')` from both sources and
  // require them to match character-for-character, so the browser mirror can
  // never drift from the canonical shared helper.
  const rx = /\.map\(\(line\)\s*=>\s*line\.replace\((\/[^/]+\/[a-z]*),\s*('[^']*')\)\)/;
  const rMatch = rendererSrc.match(rx);
  const libMatch = mdEscapeSrc.match(rx);
  assert.ok(rMatch, 'renderer neutralizeBugText .replace(...) found');
  assert.ok(libMatch, 'lib escapeLeadingHeadingRun .replace(...) found');
  assert.equal(rMatch[1], libMatch[1], 'regex literal is byte-identical across renderer and lib');
  assert.equal(rMatch[2], libMatch[2], 'replacement string is byte-identical across renderer and lib');
  // Concretely: both are the literal source /^(\s*)(#+)(\s)/ with the literal
  // source replacement '$1\\$2$3' (a backslash-backslash in the source text).
  assert.equal(rMatch[1], '/^(\\s*)(#+)(\\s)/');
  assert.equal(rMatch[2], "'$1\\\\$2$3'");
});

test('drift guard: the renderer neutralizeBugText nullish/coercion prologue mirrors the shared helper', () => {
  // Both collapse null/undefined to '' and stringify non-strings before splitting.
  assert.match(rendererSrc, /function neutralizeBugText\(text\)\s*\{\s*const s = text == null \? '' : String\(text\);/);
  assert.match(mdEscapeSrc, /const s = text == null \? '' : String\(text\);/);
});

// ===========================================================================
// Group E — the shared helper is the real one (reused, not re-implemented)
// ===========================================================================

test('unit: neutralizeBugText re-export IS the shared escapeLeadingHeadingRun (single source of truth)', () => {
  assert.strictEqual(neutralizeBugText, escapeLeadingHeadingRun,
    'the create path reuses the shared helper — no bespoke escaping');
});
