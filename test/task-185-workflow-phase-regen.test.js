'use strict';

// ===========================================================================
// TASK-185 — UNIT tests for the workflow panel's AI-assisted phase-prose
// regeneration. Tests the pure renderer helpers extracted from renderer.js:
// wfExtractPhaseBody, wfReplacePhaseBody, validateRegeneratedPhaseSection,
// WF_PHASE_KEYS, and their dependents (wfDetectEol, wfSpecForKey,
// wfFindPhaseSection).
//
// The SKILL.md fixtures are read READ-ONLY; no actual files are modified.
// NO IPC / network / Electron.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const SKILL_SRC = fs.readFileSync(
  path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md'), 'utf8');

// --- Extract a named function declaration by brace-matching. ---
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

// Load the pure helpers headless.
function load() {
  const body = [
    // WF_AGENT_TYPES is a dependency of WF_PHASE_SPECS (referenced in its values)
    extractConst(rendererSrc, 'WF_AGENT_TYPES'),
    // WF_PHASE_SPECS is defined in renderer.js and must be extracted.
    // It's used by WF_PHASE_KEYS and wfSpecForKey.
    extractConst(rendererSrc, 'WF_PHASE_SPECS'),
    extractConst(rendererSrc, 'WF_PHASE_KEYS'),
    extractFn(rendererSrc, 'wfSpecForKey'),
    extractFn(rendererSrc, 'wfDetectEol'),
    extractFn(rendererSrc, 'wfHeadingName'),
    extractFn(rendererSrc, 'wfPhaseNumberOf'),
    extractFn(rendererSrc, 'wfSectionsOf'),
    extractFn(rendererSrc, 'wfFindPhaseSection'),
    extractFn(rendererSrc, 'wfExtractPhaseBody'),
    extractFn(rendererSrc, 'stripOneCodeFence'),
    extractFn(rendererSrc, 'wfReplacePhaseBody'),
    extractFn(rendererSrc, 'validateRegeneratedPhaseSection'),
    'return { WF_PHASE_KEYS, wfExtractPhaseBody, wfReplacePhaseBody,',
    '  validateRegeneratedPhaseSection, wfDetectEol };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const helpers = load();

// Simple synthetic SKILL.md for testing
const SIMPLE_SKILL = `
## Phase 1 — Plan
Plan phase instructions.

## Phase 2 — Build
Build phase instructions.

## Phase 3 — Test
Test phase instructions.

## Phase 4 — Review
Review phase instructions.
`;

// ===========================================================================
// UNIT TESTS: wfExtractPhaseBody
// ===========================================================================

test('wfExtractPhaseBody: extracts review phase (Phase 4) body', () => {
  const result = helpers.wfExtractPhaseBody(SIMPLE_SKILL, 'review');
  assert.equal(result.ok, true, 'extraction succeeds');
  assert.ok(result.body && result.body.length > 0, 'body is non-empty');
});

test('wfExtractPhaseBody: extracts build phase (Phase 2) body', () => {
  const result = helpers.wfExtractPhaseBody(SIMPLE_SKILL, 'build');
  assert.equal(result.ok, true, 'extraction succeeds');
  assert.ok(result.body && result.body.length > 0, 'body is non-empty');
});

test('wfExtractPhaseBody: rejects bad phase key', () => {
  const result = helpers.wfExtractPhaseBody(SIMPLE_SKILL, 'nonexistent-phase');
  assert.equal(result.ok, false, 'extraction fails');
  assert.equal(result.reason, 'bad-phase-key', 'reason is bad-phase-key');
});

test('wfExtractPhaseBody: rejects non-string input', () => {
  const result = helpers.wfExtractPhaseBody(null, 'review');
  assert.equal(result.ok, false, 'extraction fails');
  assert.equal(result.reason, 'invalid-input', 'reason is invalid-input');
});

test('wfExtractPhaseBody: rejects empty string input', () => {
  const result = helpers.wfExtractPhaseBody('', 'review');
  assert.equal(result.ok, false, 'extraction fails');
  assert.equal(result.reason, 'invalid-input', 'reason is invalid-input');
});

test('wfExtractPhaseBody: rejects missing phase in text', () => {
  const broken = 'No phase sections at all';
  const result = helpers.wfExtractPhaseBody(broken, 'review');
  assert.equal(result.ok, false, 'extraction fails');
  assert.equal(result.reason, 'missing-phase', 'reason is missing-phase');
});

// ===========================================================================
// UNIT TESTS: wfReplacePhaseBody
// ===========================================================================

test('wfReplacePhaseBody: replaces review phase only, preserves others byte-identical', () => {
  const newBody = 'New review instructions here.\nWith multiple lines.';
  const result = helpers.wfReplacePhaseBody(SIMPLE_SKILL,'review', newBody);

  assert.equal(result.ok, true, 'replacement succeeds');
  assert.ok(result.content.length > 0, 'result is non-empty');

  // Verify the new body is present
  assert.ok(result.content.includes(newBody), 'new body is in the result');

  // Extract the other phases and verify they are byte-identical
  const oldBuild = helpers.wfExtractPhaseBody(SIMPLE_SKILL,'build');
  const oldTest = helpers.wfExtractPhaseBody(SIMPLE_SKILL,'test');
  const oldPlan = helpers.wfExtractPhaseBody(SIMPLE_SKILL,'plan');

  const newBuild = helpers.wfExtractPhaseBody(result.content, 'build');
  const newTest = helpers.wfExtractPhaseBody(result.content, 'test');
  const newPlan = helpers.wfExtractPhaseBody(result.content, 'plan');

  assert.equal(oldBuild.body, newBuild.body, 'build phase unchanged');
  assert.equal(oldTest.body, newTest.body, 'test phase unchanged');
  assert.equal(oldPlan.body, newPlan.body, 'plan phase unchanged');
});

test('wfReplacePhaseBody: rejects proposal with extra heading (boundary violation)', () => {
  // A proposal that contains another ## heading violates the section boundary
  const badBody = 'Some instructions.\n\n## Extra Phase\nShould not be here';
  const result = helpers.wfReplacePhaseBody(SIMPLE_SKILL,'review', badBody);

  assert.equal(result.ok, false, 'replacement fails');
  assert.equal(result.reason, 'section-boundary-violation',
    'reason is section-boundary-violation');
});

test('wfReplacePhaseBody: rejects bad phase key', () => {
  const result = helpers.wfReplacePhaseBody(SIMPLE_SKILL,'nonexistent', 'new body');
  assert.equal(result.ok, false, 'replacement fails');
  assert.equal(result.reason, 'bad-phase-key', 'reason is bad-phase-key');
});

test('wfReplacePhaseBody: rejects non-string new body', () => {
  const result = helpers.wfReplacePhaseBody(SIMPLE_SKILL,'review', null);
  assert.equal(result.ok, false, 'replacement fails');
  assert.equal(result.reason, 'invalid-body', 'reason is invalid-body');
});

test('wfReplacePhaseBody: rejects empty input', () => {
  const result = helpers.wfReplacePhaseBody('', 'review', 'new body');
  assert.equal(result.ok, false, 'replacement fails');
  assert.equal(result.reason, 'invalid-input', 'reason is invalid-input');
});

// ===========================================================================
// UNIT TESTS: validateRegeneratedPhaseSection
// ===========================================================================

test('validateRegeneratedPhaseSection: accepts valid plain-text proposal', () => {
  const proposal = 'New instructions for the review phase.\nPlain text, no heading.';
  const result = helpers.validateRegeneratedPhaseSection(proposal, SIMPLE_SKILL,'review');

  assert.equal(result.ok, true, 'validation succeeds');
  assert.equal(result.body, proposal, 'body is the plain-text proposal');
});

test('validateRegeneratedPhaseSection: accepts proposal wrapped in code fence', () => {
  const proposal = '```\nNew instructions here\n```';
  const result = helpers.validateRegeneratedPhaseSection(proposal, SIMPLE_SKILL,'review');

  assert.equal(result.ok, true, 'validation succeeds');
  // stripOneCodeFence should unwrap it
  assert.equal(result.body, 'New instructions here', 'code fence is stripped');
});

test('validateRegeneratedPhaseSection: rejects empty/whitespace-only proposal', () => {
  const result = helpers.validateRegeneratedPhaseSection('   \n  \n  ', SKILL_SRC, 'review');
  assert.equal(result.ok, false, 'validation fails');
  assert.ok(result.error.includes('empty'), 'error mentions empty');
});

test('validateRegeneratedPhaseSection: rejects proposal with extra heading', () => {
  const badProposal = 'Instructions here.\n\n## Another Section\nShould not be here.';
  const result = helpers.validateRegeneratedPhaseSection(badProposal, SKILL_SRC, 'review');

  assert.equal(result.ok, false, 'validation fails');
  assert.ok(result.error.includes('changed more than'),
    'error mentions changing more than one section');
});

test('validateRegeneratedPhaseSection: rejects for broken snapshot', () => {
  const brokenSnapshot = 'This is not valid SKILL.md format.';
  const proposal = 'Some proposal';
  const result = helpers.validateRegeneratedPhaseSection(proposal, brokenSnapshot, 'review');

  assert.equal(result.ok, false, 'validation fails');
  assert.ok(result.error, 'error is present');
});

// ===========================================================================
// UNIT TESTS: wfDetectEol
// ===========================================================================

test('wfDetectEol: detects CRLF line endings', () => {
  const text = 'line 1\r\nline 2\r\nline 3';
  const eol = helpers.wfDetectEol(text);
  assert.equal(eol, '\r\n', 'detects CRLF');
});

test('wfDetectEol: detects LF line endings', () => {
  const text = 'line 1\nline 2\nline 3';
  const eol = helpers.wfDetectEol(text);
  assert.equal(eol, '\n', 'detects LF');
});

test('wfDetectEol: defaults to LF when no CRLF present', () => {
  const text = 'no line endings here';
  const eol = helpers.wfDetectEol(text);
  assert.equal(eol, '\n', 'defaults to LF');
});

// ===========================================================================
// UNIT TESTS: WF_PHASE_KEYS
// ===========================================================================

test('WF_PHASE_KEYS: contains exactly four phase keys', () => {
  assert.equal(helpers.WF_PHASE_KEYS.length, 4, 'four phases defined');
});

test('WF_PHASE_KEYS: includes plan, build, test, review', () => {
  const keys = new Set(helpers.WF_PHASE_KEYS);
  assert.ok(keys.has('plan'), 'includes plan');
  assert.ok(keys.has('build'), 'includes build');
  assert.ok(keys.has('test'), 'includes test');
  assert.ok(keys.has('review'), 'includes review');
});

// ===========================================================================
// UNIT TESTS: Round-trip coherence
// ===========================================================================

test('Round-trip: extract + replace + re-extract yields the same body', () => {
  const phaseKey = 'test';
  const extracted = helpers.wfExtractPhaseBody(SIMPLE_SKILL,phaseKey);
  assert.equal(extracted.ok, true, 'initial extraction succeeds');
  const originalBody = extracted.body;

  const newBody = 'Modified test phase instructions.';
  const replaced = helpers.wfReplacePhaseBody(SIMPLE_SKILL,phaseKey, newBody);
  assert.equal(replaced.ok, true, 'replacement succeeds');

  const reExtracted = helpers.wfExtractPhaseBody(replaced.content, phaseKey);
  assert.equal(reExtracted.ok, true, 're-extraction succeeds');
  assert.equal(reExtracted.body, newBody, 'new body matches');
});

test('Round-trip: validate -> replace on same snapshot always succeeds', () => {
  const phaseKey = 'build';
  const proposal = 'New build phase instructions.';

  const validated = helpers.validateRegeneratedPhaseSection(proposal, SIMPLE_SKILL,phaseKey);
  assert.equal(validated.ok, true, 'validation succeeds');

  // Since validateRegeneratedPhaseSection uses wfReplacePhaseBody internally,
  // using the validated.body should always succeed on the same snapshot.
  const replaced = helpers.wfReplacePhaseBody(SIMPLE_SKILL,phaseKey, validated.body);
  assert.equal(replaced.ok, true, 'replacement on validated proposal succeeds');
});

// ===========================================================================
// UNIT TESTS: TASK-194 — doubly-fenced AI response (preview == saved bytes)
// ===========================================================================

test('TASK-194: doubly-fenced AI response — preview body matches what Save writes byte-identically', () => {
  // This test verifies that for a doubly-fenced AI response (a response that
  // is wrapped in a code fence but whose CONTENT is also wrapped in a code
  // fence), the validated preview body and the eventually-saved section body
  // are BYTE-IDENTICAL.
  //
  // Scenario: The AI model sometimes wraps its response in a code fence
  // (thinking it is being helpful, or due to prompt leakage). If the response
  // is ITSELF the fence-wrapped content:
  //   ```
  //   ```
  //   Proposed instructions
  //   ```
  //   ```
  //
  // The old code (single strip) would leave the inner fence, causing a
  // divergence: preview shows ````\nProposed instructions\n````, but Save
  // strips one more level and writes just "Proposed instructions".
  //
  // The fix (TASK-194) loops stripOneCodeFence until stable, ensuring preview
  // and Save are byte-identical.

  const phaseKey = 'test';

  // Doubly-fenced proposal: the response wraps a single-fenced content
  // Format: ```\n```\nInner content\n```\n```
  const doubleFencedProposal = '```\n```\nNew test instructions.\n```\n```';

  // Step 1: Validate the doubly-fenced proposal
  const validated = helpers.validateRegeneratedPhaseSection(doubleFencedProposal, SIMPLE_SKILL, phaseKey);
  assert.equal(validated.ok, true, 'validation succeeds for doubly-fenced proposal');
  const previewBody = validated.body;
  assert.equal(previewBody, 'New test instructions.', 'preview body is fully normalized (both fences stripped)');

  // Step 2: Pass the validated.body (the preview body) to wfReplacePhaseBody
  // This simulates what the Save handler does internally — it takes the
  // validated.body and passes it to wfReplacePhaseBody.
  const saved = helpers.wfReplacePhaseBody(SIMPLE_SKILL, phaseKey, previewBody);
  assert.equal(saved.ok, true, 'Save with preview body succeeds');

  // Step 3: Extract what was actually saved
  const extractedAfterSave = helpers.wfExtractPhaseBody(saved.content, phaseKey);
  assert.equal(extractedAfterSave.ok, true, 're-extraction after save succeeds');
  const savedBody = extractedAfterSave.body;

  // Step 4: Byte-identical check
  assert.equal(previewBody, savedBody, 'TASK-194: preview and saved body are byte-identical for doubly-fenced response');
});

test('TASK-194: triply-fenced AI response (edge case)', () => {
  // Edge case: response wrapped FOUR times (double wrapping of double wrapping)
  // Format: ```\n```\n```\nInner\n```\n```\n```
  const phaseKey = 'review';
  const triplyFencedProposal = '```\n```\n```\nNew review instructions.\n```\n```\n```';

  const validated = helpers.validateRegeneratedPhaseSection(triplyFencedProposal, SIMPLE_SKILL, phaseKey);
  assert.equal(validated.ok, true, 'validation succeeds for triply-fenced proposal');
  const previewBody = validated.body;

  // After full normalization (loop), should be the plain instructions
  assert.equal(previewBody, 'New review instructions.', 'triply-fenced response fully normalizes');

  // Save with that body
  const saved = helpers.wfReplacePhaseBody(SIMPLE_SKILL, phaseKey, previewBody);
  assert.equal(saved.ok, true, 'Save with triply-normalized body succeeds');

  const extracted = helpers.wfExtractPhaseBody(saved.content, phaseKey);
  assert.equal(extracted.body, previewBody, 'triply-fenced: preview and saved are byte-identical');
});

test('TASK-194: single-fenced response (regression check — should still work)', () => {
  // Ensure we didn't break the normal (single-fence) case
  const phaseKey = 'plan';
  const singleFencedProposal = '```\nNew plan instructions.\n```';

  const validated = helpers.validateRegeneratedPhaseSection(singleFencedProposal, SIMPLE_SKILL, phaseKey);
  assert.equal(validated.ok, true, 'validation succeeds for single-fenced proposal');
  const previewBody = validated.body;
  assert.equal(previewBody, 'New plan instructions.', 'single fence is stripped as before');

  const saved = helpers.wfReplacePhaseBody(SIMPLE_SKILL, phaseKey, previewBody);
  assert.equal(saved.ok, true, 'Save succeeds');

  const extracted = helpers.wfExtractPhaseBody(saved.content, phaseKey);
  assert.equal(extracted.body, previewBody, 'single-fenced: preview and saved are identical');
});

test('TASK-194: unfenced response (regression check — should still work)', () => {
  // Ensure we didn't break the no-fence case
  const phaseKey = 'build';
  const unfencedProposal = 'New build instructions.';

  const validated = helpers.validateRegeneratedPhaseSection(unfencedProposal, SIMPLE_SKILL, phaseKey);
  assert.equal(validated.ok, true, 'validation succeeds for unfenced proposal');
  const previewBody = validated.body;
  assert.equal(previewBody, unfencedProposal, 'unfenced proposal unchanged');

  const saved = helpers.wfReplacePhaseBody(SIMPLE_SKILL, phaseKey, previewBody);
  assert.equal(saved.ok, true, 'Save succeeds');

  const extracted = helpers.wfExtractPhaseBody(saved.content, phaseKey);
  assert.equal(extracted.body, previewBody, 'unfenced: preview and saved are identical');
});
