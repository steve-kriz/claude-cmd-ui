'use strict';

// ===========================================================================
// TASK-194 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required.
//
// Feature: preview content matches saved content exactly
//
// Tests that for a doubly-fenced AI response, the preview body and the
// actually-saved section body are byte-identical. This verifies the fix for
// the double-fence strip divergence described in TASK-185 review.
//
// The tests use the REAL renderer code (renderer/renderer.js):
// validateRegeneratedPhaseSection (preview path) and wfReplacePhaseBody (save path).
//
// ALL filesystem access via STUBBED window.api.fs (operates on temp files only).
// NO real Electron / DB / network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Extract helpers (same pattern as task-185) ---
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

// Load the renderer functions for testing
function loadFenceFunctions() {
  const body = [
    // Constants
    extractConst(rendererSrc, 'WF_AGENT_TYPES'),
    extractConst(rendererSrc, 'WF_PHASE_SPECS'),
    extractConst(rendererSrc, 'WF_PHASE_KEYS'),
    // WF helpers (phase section parsing and manipulation)
    extractFn(rendererSrc, 'wfSpecForKey'),
    extractFn(rendererSrc, 'wfDetectEol'),
    extractFn(rendererSrc, 'wfHeadingName'),
    extractFn(rendererSrc, 'wfPhaseNumberOf'),
    extractFn(rendererSrc, 'wfSectionsOf'),
    extractFn(rendererSrc, 'wfFindPhaseSection'),
    extractFn(rendererSrc, 'stripOneCodeFence'),
    extractFn(rendererSrc, 'wfReplacePhaseBody'),
    extractFn(rendererSrc, 'validateRegeneratedPhaseSection'),
    'return { stripOneCodeFence, wfReplacePhaseBody, validateRegeneratedPhaseSection };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'localStorage', body)(
    {}, {}, console, {});
}

const { stripOneCodeFence, wfReplacePhaseBody, validateRegeneratedPhaseSection } = loadFenceFunctions();

// Minimal SKILL.md fixture for testing
const SKILL_MD_FIXTURE = `# Orchestrate Workflow Skill

## Phase 1 — Plan / Define

Plan phase content here.

## Phase 2 — Build

Build phase content here.

## Phase 3 — Test

Test phase content.

## Phase 4 — Review

Review phase content.
`;

// Helper to extract a phase body from saved SKILL.md
function extractPhaseBody(skillMd, phaseKey) {
  const phaseMap = { plan: 1, build: 2, test: 3, review: 4 };
  const phaseNum = phaseMap[phaseKey];
  const lines = skillMd.split('\n');
  const start = lines.findIndex(l => l.includes(`## Phase ${phaseNum}`));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## Phase/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

// ===========================================================================
// SCENARIO 1: doubly-fenced AI response previews and saves identically
// ===========================================================================
test('SCENARIO: doubly-fenced AI response previews and saves identically', () => {
  // GIVEN an AI response that is still fully wrapped in a code fence after one strip
  const aiResponse = '```\n```\nNew plan phase content\nWith multiple lines\n```\n```';

  // WHEN it is validated for preview...
  const previewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'plan');
  assert.equal(previewResult.ok, true, 'validation succeeds');
  const previewBody = previewResult.body;

  // ...and later saved via wfReplacePhaseBody
  const saveResult = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'plan', previewBody);
  assert.equal(saveResult.ok, true, 'save succeeds');

  // THEN the previewed body and the saved section body are byte-identical
  const savedBody = extractPhaseBody(saveResult.content, 'plan');
  assert.equal(savedBody, previewBody, 'preview and saved bodies are byte-identical');
  assert.equal(previewBody, 'New plan phase content\nWith multiple lines', 'both show the normalized content');
});

// ===========================================================================
// SCENARIO 2: singly-fenced response (no regression)
// ===========================================================================
test('SCENARIO: singly-fenced AI response is unaffected by the fix', () => {
  // GIVEN an AI response wrapped in a single code fence
  const aiResponse = '```\nNew build phase content\n```';

  // WHEN it is validated for preview...
  const previewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'build');
  assert.equal(previewResult.ok, true);
  const previewBody = previewResult.body;

  // ...and later saved
  const saveResult = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'build', previewBody);
  assert.equal(saveResult.ok, true);

  // THEN they are byte-identical (and not affected by the normalization loop)
  const savedBody = extractPhaseBody(saveResult.content, 'build');
  assert.equal(savedBody, previewBody);
  assert.equal(previewBody, 'New build phase content');
});

// ===========================================================================
// SCENARIO 3: unfenced response (no regression)
// ===========================================================================
test('SCENARIO: unfenced AI response is unaffected by the fix', () => {
  // GIVEN an AI response with no fence
  const aiResponse = 'New test phase content\nWith no fence wrapping';

  // WHEN it is validated for preview...
  const previewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'test');
  assert.equal(previewResult.ok, true);
  const previewBody = previewResult.body;

  // ...and later saved
  const saveResult = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'test', previewBody);
  assert.equal(saveResult.ok, true);

  // THEN they are byte-identical
  const savedBody = extractPhaseBody(saveResult.content, 'test');
  assert.equal(savedBody, previewBody);
  assert.equal(previewBody, aiResponse);
});

// ===========================================================================
// SCENARIO 4: triply-fenced response (edge case)
// ===========================================================================
test('SCENARIO: triply-fenced AI response is fully normalized', () => {
  // GIVEN an AI response wrapped in triple code fences (edge case)
  const aiResponse = '```\n```\n```\nNew review phase\n```\n```\n```';

  // WHEN it is validated for preview...
  const previewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'review');
  assert.equal(previewResult.ok, true);
  const previewBody = previewResult.body;

  // ...and later saved
  const saveResult = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'review', previewBody);
  assert.equal(saveResult.ok, true);

  // THEN they are byte-identical
  const savedBody = extractPhaseBody(saveResult.content, 'review');
  assert.equal(savedBody, previewBody);
  assert.equal(previewBody, 'New review phase');
});

// ===========================================================================
// SCENARIO 5 (regression/edge): empty after stripping is rejected
// ===========================================================================
test('SCENARIO: empty proposal after stripping is rejected (edge case)', () => {
  // GIVEN an AI response that is empty after all fences are stripped
  const aiResponse = '```\n```';

  // WHEN it is validated for preview
  const previewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'plan');

  // THEN it is rejected with an appropriate error
  assert.equal(previewResult.ok, false);
  assert.equal(previewResult.error, 'The proposal is empty.');
});

// ===========================================================================
// SCENARIO 6 (regression test): verify loop-until-stable is critical
// ===========================================================================
test('SCENARIO (regression): removing the loop-until-stable would reintroduce divergence', () => {
  // GIVEN the same doubly-fenced proposal from Scenario 1
  const aiResponse = '```\n```\nContent here\n```\n```';

  // WHEN we simulate what the OLD (buggy) code would have done
  // (single strip only):
  const onceSt = stripOneCodeFence(aiResponse);
  assert.equal(onceSt, '```\nContent here\n```', 'single strip leaves inner fence');

  // The preview would show this:
  const oldPreviewBody = onceSt;

  // But on save, wfReplacePhaseBody would strip again
  const twiceSt = stripOneCodeFence(oldPreviewBody);
  assert.equal(twiceSt, 'Content here', 'double strip in wfReplacePhaseBody removes all');

  // Extract what would be saved with the old code
  const oldSaveResult = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'plan', oldPreviewBody);
  const oldSavedBody = extractPhaseBody(oldSaveResult.content, 'plan');

  // They would NOT match:
  assert.notEqual(oldPreviewBody, oldSavedBody,
    'without loop, preview and save would diverge: preview shows ``` inner fence, save removes it');

  // Now verify that WITH the fix, they DO match
  const newPreviewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'plan');
  const newPreviewBody = newPreviewResult.body;
  const newSaveResult = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'plan', newPreviewBody);
  const newSavedBody = extractPhaseBody(newSaveResult.content, 'plan');

  assert.equal(newPreviewBody, newSavedBody, 'with loop, they match');
  assert.equal(newPreviewBody, 'Content here', 'both show the correct content');
});

// ===========================================================================
// SCENARIO 7: loop stops at stability (not infinite)
// ===========================================================================
test('SCENARIO: fence-stripping loop terminates on stability (edge/safety)', () => {
  // GIVEN an unfenced proposal that should not loop indefinitely
  const aiResponse = 'Just plain content\nWith no fence';

  // WHEN it is validated (which uses a loop)
  const previewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'build');

  // THEN it completes without looping indefinitely (implicit: test doesn't hang)
  assert.equal(previewResult.ok, true);
  assert.equal(previewResult.body, aiResponse, 'unfenced content passes through unchanged');
});
