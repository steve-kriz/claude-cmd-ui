'use strict';

// Unit tests for TASK-194 — fence-strip normalization fix
// Tests the loop-until-stable fence stripping in validateRegeneratedPhaseSection
// (renderer/renderer.js lines 7961-7965).
//
// The module is pure (no disk/network/Electron), and we extract the functions
// from renderer.js using the same pattern as task-185.

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

// ---------------------------------------------------------------------------
// stripOneCodeFence — single fence removal
// ---------------------------------------------------------------------------

test('stripOneCodeFence: removes one surrounding fence', () => {
  const fenced = '```\nContent here\n```';
  const result = stripOneCodeFence(fenced);
  assert.equal(result, 'Content here');
});

test('stripOneCodeFence: removes fence with language tag', () => {
  const fenced = '```markdown\nContent\n```';
  const result = stripOneCodeFence(fenced);
  assert.equal(result, 'Content');
});

test('stripOneCodeFence: leaves unfenced text unchanged', () => {
  const text = 'Just some content\nwith no fence';
  assert.equal(stripOneCodeFence(text), text);
});

test('stripOneCodeFence: leaves empty string unchanged', () => {
  assert.equal(stripOneCodeFence(''), '');
});

test('stripOneCodeFence: non-string input yields empty string', () => {
  assert.equal(stripOneCodeFence(null), '');
  assert.equal(stripOneCodeFence(undefined), '');
  assert.equal(stripOneCodeFence(42), '');
});

// ---------------------------------------------------------------------------
// Loop-until-stable logic (via validateRegeneratedPhaseSection)
// ---------------------------------------------------------------------------

test('stripOneCodeFence: can be looped until stable on singly-fenced input', () => {
  const singleFenced = '```\nContent\n```';
  let result = singleFenced;
  const results = [];
  for (let i = 0; i < 5; i++) {
    result = stripOneCodeFence(result);
    results.push(result);
  }
  // First iteration removes the fence, remaining iterations are no-ops
  assert.equal(results[0], 'Content');
  assert.equal(results[1], 'Content');
  assert.equal(results[2], 'Content');
});

test('stripOneCodeFence: can be looped until stable on doubly-fenced input', () => {
  const doubleFenced = '```\n```\nContent\n```\n```';
  let result = doubleFenced;
  const results = [];
  for (let i = 0; i < 5; i++) {
    result = stripOneCodeFence(result);
    results.push(result);
  }
  // First iteration removes outer fence: ```\nContent\n```
  // Second iteration removes inner fence: Content
  // Remaining iterations are no-ops
  assert.equal(results[0], '```\nContent\n```');
  assert.equal(results[1], 'Content');
  assert.equal(results[2], 'Content');
  assert.equal(results[3], 'Content');
});

test('stripOneCodeFence: looping detects stability (no fence case)', () => {
  const unfenced = 'Just content\nNo fence at all';
  let result = unfenced;
  let iterations = 0;
  for (let i = 0; i < 10; i++) {
    const next = stripOneCodeFence(result);
    if (next === result) {
      iterations = i;
      break;
    }
    result = next;
  }
  assert.equal(iterations, 0, 'stability reached on first iteration for unfenced text');
  assert.equal(result, unfenced);
});

// ---------------------------------------------------------------------------
// validateRegeneratedPhaseSection — normalizes until stable
// ---------------------------------------------------------------------------

test('validateRegeneratedPhaseSection: singly-fenced response is normalized once', () => {
  const proposal = '```\nNew content for plan\n```';
  const result = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'plan');
  assert.equal(result.ok, true);
  assert.equal(result.body, 'New content for plan');
});

test('validateRegeneratedPhaseSection: doubly-fenced response is normalized fully', () => {
  const proposal = '```\n```\nNew content for build\n```\n```';
  const result = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'build');
  assert.equal(result.ok, true);
  assert.equal(result.body, 'New content for build', 'doubly-fenced content is fully unwrapped');
});

test('validateRegeneratedPhaseSection: unfenced response stays as-is', () => {
  const proposal = 'New content for test\nWith no fence';
  const result = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'test');
  assert.equal(result.ok, true);
  assert.equal(result.body, proposal);
});

test('validateRegeneratedPhaseSection: empty after stripping is rejected', () => {
  const proposal = '```\n```';
  const result = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'plan');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'The proposal is empty.');
});

test('validateRegeneratedPhaseSection: triply-fenced response is fully normalized', () => {
  const proposal = '```\n```\n```\nContent\n```\n```\n```';
  const result = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'review');
  assert.equal(result.ok, true);
  assert.equal(result.body, 'Content', 'triply-fenced content is fully unwrapped');
});

// ---------------------------------------------------------------------------
// Preview/Save convergence: validateRegeneratedPhaseSection output matches
// what wfReplacePhaseBody would strip to
// ---------------------------------------------------------------------------

test('validateRegeneratedPhaseSection and wfReplacePhaseBody agree on singly-fenced input', () => {
  const proposal = '```\nProposal text\n```';
  const validated = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'plan');
  assert.equal(validated.ok, true);

  // wfReplacePhaseBody still calls stripOneCodeFence once, but on already-normalized input
  // (the body from validateRegeneratedPhaseSection)
  const saved = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'plan', validated.body);
  assert.equal(saved.ok, true);

  // Extract the saved body by reading it back out
  const savedContent = saved.content;
  assert.ok(savedContent.includes('Proposal text'), 'proposal is in saved content');
  assert.ok(!savedContent.includes('```'), 'no fence in saved content (only once-fenced proposal would add one)');
});

test('validateRegeneratedPhaseSection and wfReplacePhaseBody agree on doubly-fenced input', () => {
  const proposal = '```\n```\nProposal text\n```\n```';
  const validated = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'build');
  assert.equal(validated.ok, true);
  assert.equal(validated.body, 'Proposal text', 'normalized to unfenced content');

  // wfReplacePhaseBody receives the already-normalized body
  const saved = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'build', validated.body);
  assert.equal(saved.ok, true);

  // The saved content should be identical to what the preview showed
  assert.ok(saved.content.includes('Proposal text'));
  assert.ok(!saved.content.includes('```'), 'no fence added');
});

test('Preview body (from validateRegeneratedPhaseSection) and final saved body are byte-identical', () => {
  // Simulate the user preview path
  const aiResponse = '```\n```\nFinal proposal for test phase\n```\n```';
  const previewResult = validateRegeneratedPhaseSection(aiResponse, SKILL_MD_FIXTURE, 'test');
  assert.equal(previewResult.ok, true);
  const previewBody = previewResult.body;

  // Simulate the save path
  const saveResult = wfReplacePhaseBody(SKILL_MD_FIXTURE, 'test', previewBody);
  assert.equal(saveResult.ok, true);

  // Extract just the test phase body from the saved content
  const savedLines = saveResult.content.split('\n');
  const testPhaseStart = savedLines.findIndex(l => l.includes('Phase 3'));
  const testPhaseEnd = savedLines.findIndex((l, i) => i > testPhaseStart && /^## Phase/.test(l));
  const savedBody = savedLines.slice(testPhaseStart + 1, testPhaseEnd).join('\n').trim();

  // The saved body should match the preview body exactly
  assert.equal(savedBody, previewBody.trim(), 'preview and saved bodies are byte-identical');
});

// ---------------------------------------------------------------------------
// Regression test: verify loop-until-stable is critical
// ---------------------------------------------------------------------------

test('Loop-until-stable is necessary: without it, doubly-fenced would diverge', () => {
  // This test documents WHY the loop is needed.
  // If validateRegeneratedPhaseSection did NOT loop, it would return the
  // singly-stripped result, which would then diverge when wfReplacePhaseBody
  // strips it again.

  const proposal = '```\n```\nContent\n```\n```';

  // What would happen WITHOUT loop (old buggy behavior):
  const onceStripped = stripOneCodeFence(proposal);
  assert.equal(onceStripped, '```\nContent\n```', 'single strip leaves inner fence');

  // Then on save, wfReplacePhaseBody would strip again
  const twiceStripped = stripOneCodeFence(onceStripped);
  assert.equal(twiceStripped, 'Content', 'double strip removes all fences');

  // So the preview would show ````\nContent\n``` but save would write Content
  // This proves the divergence would happen without the loop.

  // WITH the loop (fixed behavior), validateRegeneratedPhaseSection fully normalizes:
  const validated = validateRegeneratedPhaseSection(proposal, SKILL_MD_FIXTURE, 'plan');
  assert.equal(validated.body, 'Content', 'loop normalizes fully');
  assert.equal(validated.body, twiceStripped, 'loop produces same result as double-strip');
});
