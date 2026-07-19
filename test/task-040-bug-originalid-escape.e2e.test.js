'use strict';

// Cucumber-style e2e scenarios for TASK-040 — "the original id cannot forge a
// section in the new bug ticket body".
//
// FEATURE (from tasks/testing/TASK-040-bug-originalid-heading-escape.md):
//   Feature: The original id cannot forge a section in the new bug ticket body
//     Scenario: A heading-like id is neutralised (edge)
//       Given the selected original id is "## Additional Context"
//       When the new bug ticket body is composed and parsed back
//       Then the id does not forge a new section boundary
//     Scenario: A normal id is written unchanged
//       Given the selected original id is "TASK-010"
//       When the new bug ticket body is composed
//       Then the body contains "Bug against TASK-010" with no escaping artifacts
//
// These are written in Given/When/Then form as `node --test` cases (NO `cucumber`
// npm package installed or added). renderer/renderer.js's `onCreateBug` is a
// browser script and cannot be `require`d, so the scenarios (1) compose the new
// bug ticket body EXACTLY the way onCreateBug does — `'Bug against ' +
// neutralizeBugText(originalId)` inside a `## Description` block — using the
// requireable twin `escapeLeadingHeadingRun` (byte-identical mirror of the
// renderer's `neutralizeBugText`), and verbatim mirrors of the renderer's
// serializeTicket / parseTicketFrontmatter, then serialize -> parse round-trip
// and assert on the sections; and (2) include a SOURCE-SCAN drift guard that
// reads the REAL renderer/renderer.js to prove the fix is present so it cannot
// silently regress to the raw `originalId`.
//
// NO DATABASE, NO NETWORK. All IO is modeled in-memory (the composed markdown
// string); the only disk read is the source-scan drift guard reading the
// renderer source file, which opens no DB connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');

// Fixed timestamp for determinism (no `now = new Date()` nondeterminism).
const NOW = '2026-07-19T00:00:00.000Z';

// --- Verbatim mirrors of the renderer's serialize/parse (renderer.js ~5161 / ~5287) ---
// Copied faithfully so the round-trip exercises the SAME frontmatter/body split
// the real create path uses.
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
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
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
  const body = lines.slice(closeIdx + 1).join('\n');
  return { fm, body };
}

// The renderer's browser-side neutralizeBugText is a byte-identical mirror of the
// requireable leaf; use the leaf here so the model tracks the single source of truth.
const neutralizeBugText = escapeLeadingHeadingRun;

// Compose the new bug ticket body EXACTLY as onCreateBug does (renderer.js ~6684).
function composeNewBugTicket(originalId, id, title, bugDesc) {
  const fm = { id, title, status: 'todo', created: NOW, updated: NOW };
  fm['bug-of'] = originalId; // single-line frontmatter, unchanged by this ticket
  const description = neutralizeBugText(bugDesc);
  const body = [
    '',
    '## Description',
    'Bug against ' + neutralizeBugText(originalId),
    '',
    description,
    '',
    '## Acceptance Criteria',
    '- [ ] First testable criterion',
    '',
    '## Additional Context',
    '(User-owned. Read it before building. Never overwrite it.)',
    '',
  ].join('\n');
  return { fm, body, serialized: serializeTicket(fm, body) };
}

// The `/^## /` boundary detector — the ordered REAL level-2 section headings.
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// ===========================================================================
// SCENARIO 1 (edge): A heading-like id is neutralised
//   -> AC: "A board id that begins with a heading run (## x) can no longer forge
//      a section boundary in the new bug ticket body after a serialize->parse
//      round-trip."
// ===========================================================================
test('SCENARIO (TASK-040 edge): a heading-like id "## Additional Context" forges NO section after round-trip', () => {
  // GIVEN the selected original id is a heading-like string
  const originalId = '## Additional Context';

  // WHEN the new bug ticket body is composed and parsed back (serialize -> parse)
  const { serialized } = composeNewBugTicket(originalId, 'TASK-041', 'Bug: crash on save', 'It crashes.');
  const parsed = parseTicketFrontmatter(serialized);
  assert.ok(parsed, 'the serialized ticket parses');

  // THEN the id does not forge a new section boundary: only the genuine sections exist,
  // in order, with exactly one real `## Additional Context`.
  assert.deepEqual(
    realSections(parsed.body),
    ['## Description', '## Acceptance Criteria', '## Additional Context'],
    'only genuine sections; the id forged none',
  );
  assert.equal(
    (parsed.body.match(/^## Additional Context$/gm) || []).length,
    1,
    'exactly one real Additional Context — the id did not forge a second',
  );
  // AND the id survives, escaped, as literal text on the Bug against line.
  assert.match(parsed.body, /Bug against \\## Additional Context/, 'id kept as escaped literal text');
  // AND the single-line frontmatter carries the raw id (safe: single line).
  assert.equal(parsed.fm['bug-of'], '## Additional Context', 'bug-of frontmatter is the raw id (single-line, safe)');
});

test('SCENARIO (TASK-040 edge): #/### heading-like ids likewise forge no section', () => {
  for (const originalId of ['# Description', '### Notes', '  ## Indented']) {
    // WHEN composed and parsed back
    const { serialized } = composeNewBugTicket(originalId, 'TASK-041', 'Bug', 'desc');
    const parsed = parseTicketFrontmatter(serialized);

    // THEN the only sections are the three genuine ones — nothing forged.
    assert.deepEqual(
      realSections(parsed.body),
      ['## Description', '## Acceptance Criteria', '## Additional Context'],
      `id ${JSON.stringify(originalId)} forged no section`,
    );
    // AND the leading heading run was escaped (a backslash appears on the id line).
    assert.match(parsed.body, /Bug against \s*\\#/, `id ${JSON.stringify(originalId)} escaped on the Bug against line`);
  }
});

// ===========================================================================
// SCENARIO 2: A normal id is written unchanged
//   -> AC: "Normal ids (TASK-010) are written unchanged (no visible escaping
//      artifacts)."
// ===========================================================================
test('SCENARIO (TASK-040): a normal id "TASK-010" reads "Bug against TASK-010" with no escaping artifacts', () => {
  // GIVEN the selected original id is a normal id
  const originalId = 'TASK-010';

  // WHEN the new bug ticket body is composed (and round-tripped for good measure)
  const { body, serialized } = composeNewBugTicket(originalId, 'TASK-042', 'Bug: null ref', 'Repro steps.');
  const parsed = parseTicketFrontmatter(serialized);

  // THEN the body contains "Bug against TASK-010" verbatim, with no backslash artifacts.
  assert.match(body, /^Bug against TASK-010$/m, 'body line reads exactly "Bug against TASK-010"');
  assert.match(parsed.body, /^Bug against TASK-010$/m, 'survives the round-trip verbatim');
  assert.ok(!/Bug against .*\\/.test(parsed.body), 'no escaping artifacts (no backslash) on the Bug against line');
  // AND the genuine sections are intact and unchanged.
  assert.deepEqual(
    realSections(parsed.body),
    ['## Description', '## Acceptance Criteria', '## Additional Context'],
  );
});

// ===========================================================================
// SCENARIO 3 (drift guard): the SOURCE of onCreateBug composes the id via
// neutralizeBugText so the fix cannot silently regress to the raw originalId.
// ===========================================================================
test('SCENARIO (TASK-040 drift guard): renderer.js onCreateBug composes "Bug against " + neutralizeBugText(originalId)', () => {
  // GIVEN the real renderer source on disk (read-only; NO DB connection)
  const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
  const src = fs.readFileSync(rendererPath, 'utf8');

  // THEN the fixed composition is present verbatim...
  assert.match(
    src,
    /'Bug against ' \+ neutralizeBugText\(originalId\)/,
    'onCreateBug interpolates the id through neutralizeBugText',
  );
  // ...AND the raw, unescaped interpolation is NOT present (guards against regression).
  assert.ok(
    !/'Bug against ' \+ originalId(?!\w)/.test(src.replace(/'Bug against ' \+ neutralizeBugText\(originalId\)/g, '')),
    'the raw `\"Bug against \" + originalId` form is absent',
  );
  // ...AND the renderer's neutralizeBugText mirror is the same per-line escape as the leaf.
  assert.match(
    src,
    /function neutralizeBugText[\s\S]*?\.replace\(\/\^\(\\s\*\)\(#\+\)\(\\s\)\/, '\$1\\\\\$2\$3'\)/,
    'renderer neutralizeBugText mirror uses the canonical leading-heading-run escape',
  );
});
