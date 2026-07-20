'use strict';

// ===========================================================================
// TASK-079 — UNIT tests for the REAL lib/ticket-definition.js pure predicate.
//
// isTicketDefined(body) is Electron-free and TOTALLY tolerant of junk: a body is
// "defined" iff it carries BOTH
//   (a) a `## Acceptance Criteria` section with >=1 checkbox that is NOT the exact
//       placeholder `- [ ] First testable criterion`, AND
//   (b) a `## Cucumber Tests` section holding a non-empty ```gherkin fenced block.
// Any null/non-string/malformed body returns false and never throws.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK, NO IPC. The module is pure
// and is exercised directly via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isTicketDefined, PLACEHOLDER_CRITERION } = require('../lib/ticket-definition');

// The EXACT skeleton body the New-ticket modal / bug-create / Slack create paths
// stamp (renderer.js onCreateNormal ~7081): a Description, the placeholder
// criterion, and NO `## Cucumber Tests` section.
const NEW_TICKET_SKELETON = [
  '',
  '## Description',
  'What needs doing and why.',
  '',
  '## Acceptance Criteria',
  '- [ ] First testable criterion',
  '',
  '## Additional Context',
  '(User-owned. Read it before building. Never overwrite it.)',
  '',
].join('\n');

// A fully BA-defined body: two real AC checkboxes + a non-empty gherkin fence.
const DEFINED_BODY = [
  '',
  '## Description',
  'Real description of the work.',
  '',
  '## Acceptance Criteria',
  '- [ ] The widget renders green when idle',
  '- [x] The widget renders red on failure',
  '',
  '## Cucumber Tests',
  '```gherkin',
  'Feature: Widget colour',
  '  Scenario: Idle widget is green',
  '    Given an idle widget',
  '    When it renders',
  '    Then it is green',
  '```',
  '',
  '## Additional Context',
  '(User-owned.)',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Exports contract
// ---------------------------------------------------------------------------
test('module exports isTicketDefined (fn) and PLACEHOLDER_CRITERION (const)', () => {
  assert.equal(typeof isTicketDefined, 'function');
  assert.equal(PLACEHOLDER_CRITERION, '- [ ] First testable criterion');
});

// ---------------------------------------------------------------------------
// AC: false for the New-ticket skeleton template
// ---------------------------------------------------------------------------
test('the New-ticket skeleton template (placeholder-only AC + no Cucumber section) -> false', () => {
  assert.equal(isTicketDefined(NEW_TICKET_SKELETON), false);
});

// ---------------------------------------------------------------------------
// AC: true for a real AC checkbox + non-empty gherkin fence
// ---------------------------------------------------------------------------
test('a real AC checkbox + a non-empty gherkin fence -> true', () => {
  assert.equal(isTicketDefined(DEFINED_BODY), true);
});

test('a single real AC checkbox (unchecked) + non-empty gherkin -> true', () => {
  const body = [
    '## Acceptance Criteria',
    '- [ ] A genuine, non-placeholder criterion',
    '',
    '## Cucumber Tests',
    '```gherkin',
    'Feature: X',
    '  Scenario: Y',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(body), true);
});

// ---------------------------------------------------------------------------
// AC: false — missing AC section
// ---------------------------------------------------------------------------
test('missing `## Acceptance Criteria` section -> false (even with a good gherkin block)', () => {
  const body = [
    '## Description',
    'Some work.',
    '',
    '## Cucumber Tests',
    '```gherkin',
    'Feature: X',
    '  Scenario: Y',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(body), false);
});

// ---------------------------------------------------------------------------
// AC: false — placeholder-only AC (even with a real gherkin block)
// ---------------------------------------------------------------------------
test('placeholder-only AC (only `- [ ] First testable criterion`) + real gherkin -> false', () => {
  const body = [
    '## Acceptance Criteria',
    '- [ ] First testable criterion',
    '',
    '## Cucumber Tests',
    '```gherkin',
    'Feature: X',
    '  Scenario: Y',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(body), false);
});

test('placeholder AC with surrounding whitespace still counts as placeholder-only -> false', () => {
  const body = [
    '## Acceptance Criteria',
    '   - [ ] First testable criterion   ',
    '',
    '## Cucumber Tests',
    '```gherkin',
    'Feature: X',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(body), false);
});

// ---------------------------------------------------------------------------
// AC: false — missing Cucumber Tests section (even with real AC)
// ---------------------------------------------------------------------------
test('real AC but missing `## Cucumber Tests` section -> false', () => {
  const body = [
    '## Acceptance Criteria',
    '- [ ] A genuine criterion',
    '',
    '## Additional Context',
    'stuff',
  ].join('\n');
  assert.equal(isTicketDefined(body), false);
});

// ---------------------------------------------------------------------------
// AC: false — empty gherkin fence
// ---------------------------------------------------------------------------
test('real AC + an EMPTY gherkin fence -> false', () => {
  const body = [
    '## Acceptance Criteria',
    '- [ ] A genuine criterion',
    '',
    '## Cucumber Tests',
    '```gherkin',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(body), false);
});

test('real AC + a whitespace-only gherkin fence -> false', () => {
  const body = [
    '## Acceptance Criteria',
    '- [ ] A genuine criterion',
    '',
    '## Cucumber Tests',
    '```gherkin',
    '   ',
    '',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(body), false);
});

test('real AC + a Cucumber section whose fence is NOT gherkin -> false', () => {
  const body = [
    '## Acceptance Criteria',
    '- [ ] A genuine criterion',
    '',
    '## Cucumber Tests',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(body), false);
});

// ---------------------------------------------------------------------------
// AC: both halves required
// ---------------------------------------------------------------------------
test('placeholder AC + real gherkin (or vice versa) -> false: both halves required', () => {
  const acOnly = [
    '## Acceptance Criteria',
    '- [ ] A genuine criterion',
    '',
  ].join('\n');
  const gherkinOnly = [
    '## Cucumber Tests',
    '```gherkin',
    'Feature: X',
    '```',
  ].join('\n');
  assert.equal(isTicketDefined(acOnly), false, 'real AC alone -> false');
  assert.equal(isTicketDefined(gherkinOnly), false, 'real gherkin alone -> false');
});

// ---------------------------------------------------------------------------
// AC: junk input -> false, never throws
// ---------------------------------------------------------------------------
test('null / undefined / number / empty string / object -> false, never throws', () => {
  for (const junk of [null, undefined, 42, 0, NaN, '', '   ', {}, [], true, false, () => {}]) {
    let out;
    assert.doesNotThrow(() => { out = isTicketDefined(junk); }, `${String(junk)} does not throw`);
    assert.equal(out, false, `${JSON.stringify(junk)} -> false`);
  }
});

test('a body that is entirely gibberish text -> false (never throws)', () => {
  assert.equal(isTicketDefined('lorem ipsum ### not a real ticket ``` weird'), false);
});
