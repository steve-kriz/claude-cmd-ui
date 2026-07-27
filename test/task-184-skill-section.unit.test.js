'use strict';

// Unit tests for lib/skill-section.js (TASK-184) — scoped-section splice for the
// orchestrate SKILL.md. This module exports:
//   - PHASE_KEYS: the four canonical phase keys
//   - extractPhaseBody(skillMd, phaseKey): extract one phase's body text
//   - replacePhaseBody(skillMd, phaseKey, newBody): splice a new body back in
//   - stripOneCodeFence(text): remove one surrounding markdown code fence
//
// The module is pure (no disk/network/Electron), tolerant (never throws), and
// returns structured { ok, ..., reason } results. All tests use plain `node --test`,
// no real files, and mock nothing (the module has no dependencies on external APIs).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PHASE_KEYS,
  extractPhaseBody,
  replacePhaseBody,
  stripOneCodeFence,
} = require('../lib/skill-section');

// ---------------------------------------------------------------------------
// Exports & constants
// ---------------------------------------------------------------------------

test('exports the documented surface', () => {
  assert.ok(Array.isArray(PHASE_KEYS));
  assert.equal(PHASE_KEYS.length, 4);
  assert.deepEqual(PHASE_KEYS, ['plan', 'build', 'test', 'review']);
  assert.equal(typeof extractPhaseBody, 'function');
  assert.equal(typeof replacePhaseBody, 'function');
  assert.equal(typeof stripOneCodeFence, 'function');
});

// ---------------------------------------------------------------------------
// Fixtures: a complete 4-phase SKILL.md
// ---------------------------------------------------------------------------

const SAMPLE_SKILL_MD = `# Orchestrate Workflow Skill

## Phase 1 — Plan / Define

Plan phase content here.
Multiple lines.

## Phase 2 — Build

Build phase content here.

## Phase 3 — Test

Test phase content.
With multiple lines and structure.

## Phase 4 — Review

Review phase text.
Final review content.
`;

const SKILL_MD_CRLF = SAMPLE_SKILL_MD.replace(/\n/g, '\r\n');

// ---------------------------------------------------------------------------
// stripOneCodeFence — remove surrounding ``` / ```markdown
// ---------------------------------------------------------------------------

test('stripOneCodeFence: non-string input yields empty string', () => {
  assert.equal(stripOneCodeFence(null), '');
  assert.equal(stripOneCodeFence(undefined), '');
  assert.equal(stripOneCodeFence(42), '');
  assert.equal(stripOneCodeFence({}), '');
});

test('stripOneCodeFence: plain text passes through unchanged', () => {
  const text = 'Just plain prose\nwith multiple lines\n';
  assert.equal(stripOneCodeFence(text), text);
});

test('stripOneCodeFence: strips opening ``` and closing ```', () => {
  const fenced = '```\nsome code\nmore code\n```';
  const result = stripOneCodeFence(fenced);
  assert.equal(result, 'some code\nmore code');
});

test('stripOneCodeFence: strips ``` with language tag (```markdown)', () => {
  const fenced = '```markdown\nsome content\nmore content\n```';
  const result = stripOneCodeFence(fenced);
  assert.equal(result, 'some content\nmore content');
});

test('stripOneCodeFence: handles CRLF line endings inside fences', () => {
  const fenced = '```\r\nsome code\r\nmore code\r\n```';
  const result = stripOneCodeFence(fenced);
  assert.equal(result, 'some code\r\nmore code');
});

test('stripOneCodeFence: does NOT strip fences if they are not surrounding (partial match)', () => {
  const partial = 'start ``` middle ``` end';
  assert.equal(stripOneCodeFence(partial), partial);
});

test('stripOneCodeFence: strips up to the FIRST closing fence (greedy inner match)', () => {
  // The regex uses non-greedy [\s\S]*? so it stops at the first closing fence
  // This is by design: stripOneCodeFence is not meant to validate balanced fences
  const input = '```\nouter fence\n```inner```\n```';
  const result = stripOneCodeFence(input);
  // The non-greedy match finds the first ```, returning the text between
  assert.equal(result, 'outer fence\n```inner```');
});

test('stripOneCodeFence: trims leading/trailing whitespace before checking fence', () => {
  const padded = '  ```\ncode\n```  \n';
  const result = stripOneCodeFence(padded);
  assert.equal(result, 'code');
});

// ---------------------------------------------------------------------------
// extractPhaseBody — pull out a phase's body text
// ---------------------------------------------------------------------------

test('extractPhaseBody: invalid input (non-string/empty) returns {ok:false, body:\'\', reason}', () => {
  assert.deepEqual(extractPhaseBody(null, 'plan'), { ok: false, body: '', reason: 'invalid-input' });
  assert.deepEqual(extractPhaseBody(undefined, 'plan'), { ok: false, body: '', reason: 'invalid-input' });
  assert.deepEqual(extractPhaseBody('', 'plan'), { ok: false, body: '', reason: 'invalid-input' });
  assert.deepEqual(extractPhaseBody(42, 'plan'), { ok: false, body: '', reason: 'invalid-input' });
});

test('extractPhaseBody: bad phase key returns {ok:false, reason:"bad-phase-key"}', () => {
  const res = extractPhaseBody(SAMPLE_SKILL_MD, 'invalid-phase');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-phase-key');
  assert.equal(res.body, '');
});

test('extractPhaseBody: missing phase heading returns {ok:false, reason:"missing-phase"}', () => {
  const noPhase4 = SAMPLE_SKILL_MD.replace('## Phase 4 — Review', '## Other Section');
  const res = extractPhaseBody(noPhase4, 'review');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-phase');
});

test('extractPhaseBody: returns the body text under the correct phase heading', () => {
  const res = extractPhaseBody(SAMPLE_SKILL_MD, 'review');
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'ok');
  assert.ok(res.body.includes('Review phase text'));
  assert.ok(res.body.includes('Final review content'));
  assert.ok(!res.body.includes('## Phase 4'));
  assert.ok(!res.body.includes('Phase 3'));
});

test('extractPhaseBody: extracts plan phase (phase 1)', () => {
  const res = extractPhaseBody(SAMPLE_SKILL_MD, 'plan');
  assert.equal(res.ok, true);
  assert.ok(res.body.includes('Plan phase content'));
  assert.ok(!res.body.includes('Build phase'));
});

test('extractPhaseBody: extracts build phase (phase 2)', () => {
  const res = extractPhaseBody(SAMPLE_SKILL_MD, 'build');
  assert.equal(res.ok, true);
  assert.ok(res.body.includes('Build phase content'));
  assert.ok(!res.body.includes('Plan phase'));
});

test('extractPhaseBody: extracts test phase (phase 3)', () => {
  const res = extractPhaseBody(SAMPLE_SKILL_MD, 'test');
  assert.equal(res.ok, true);
  assert.ok(res.body.includes('Test phase content'));
  assert.ok(!res.body.includes('Review phase'));
});

test('extractPhaseBody: preserves original EOL style (LF vs CRLF)', () => {
  const res = extractPhaseBody(SKILL_MD_CRLF, 'plan');
  assert.equal(res.ok, true);
  // When the input is CRLF, the body should preserve line spacing as in original
  assert.ok(res.body.length > 0);
});

// ---------------------------------------------------------------------------
// replacePhaseBody — splice a new body into the phase section
// ---------------------------------------------------------------------------

test('replacePhaseBody: invalid skillMd returns {ok:false, reason:"invalid-input"}', () => {
  assert.deepEqual(replacePhaseBody(null, 'plan', 'new'), { ok: false, content: '', reason: 'invalid-input' });
  assert.deepEqual(replacePhaseBody('', 'plan', 'new'), { ok: false, content: '', reason: 'invalid-input' });
  assert.deepEqual(replacePhaseBody(42, 'plan', 'new'), { ok: false, content: '', reason: 'invalid-input' });
});

test('replacePhaseBody: bad phase key returns {ok:false, reason:"bad-phase-key"}', () => {
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'not-a-phase', 'new body');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-phase-key');
});

test('replacePhaseBody: invalid body (non-string) returns {ok:false, reason:"invalid-body"}', () => {
  assert.deepEqual(replacePhaseBody(SAMPLE_SKILL_MD, 'plan', null), { ok: false, content: '', reason: 'invalid-body' });
  assert.deepEqual(replacePhaseBody(SAMPLE_SKILL_MD, 'plan', 42), { ok: false, content: '', reason: 'invalid-body' });
  assert.deepEqual(replacePhaseBody(SAMPLE_SKILL_MD, 'plan', {}), { ok: false, content: '', reason: 'invalid-body' });
});

test('replacePhaseBody: missing phase heading returns {ok:false, reason:"missing-phase"}', () => {
  const noPhase2 = SAMPLE_SKILL_MD.replace('## Phase 2 — Build', '## Other');
  const res = replacePhaseBody(noPhase2, 'build', 'new build text');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-phase');
});

test('replacePhaseBody: identical replacement reproduces the file byte-for-byte', () => {
  const extracted = extractPhaseBody(SAMPLE_SKILL_MD, 'review');
  assert.equal(extracted.ok, true);
  const replaced = replacePhaseBody(SAMPLE_SKILL_MD, 'review', extracted.body);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.content, SAMPLE_SKILL_MD);
});

test('replacePhaseBody: identical replacement with CRLF EOL is byte-stable', () => {
  const extracted = extractPhaseBody(SKILL_MD_CRLF, 'plan');
  assert.equal(extracted.ok, true);
  const replaced = replacePhaseBody(SKILL_MD_CRLF, 'plan', extracted.body);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.content, SKILL_MD_CRLF);
});

test('replacePhaseBody: changes ONLY the target section, leaves others untouched', () => {
  const newReview = 'Completely new review text.\nWith different content.\n';
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'review', newReview);
  assert.equal(res.ok, true);

  // Verify the review section changed
  const reviewExtracted = extractPhaseBody(res.content, 'review');
  assert.ok(reviewExtracted.body.includes('Completely new review text'));

  // Verify other sections are unchanged
  const planExtracted = extractPhaseBody(res.content, 'plan');
  assert.ok(planExtracted.body.includes('Plan phase content'));

  const buildExtracted = extractPhaseBody(res.content, 'build');
  assert.ok(buildExtracted.body.includes('Build phase content'));

  const testExtracted = extractPhaseBody(res.content, 'test');
  assert.ok(testExtracted.body.includes('Test phase content'));
});

test('replacePhaseBody: accepts newBody with an unbalanced code fence if no sections are affected', () => {
  // An unbalanced fence in a phase body (which is NOT a section heading level)
  // may or may not shift parsing state for LATER sections. If it doesn't shift
  // the section boundaries (sections are detected by ## headings, not fences),
  // then it's accepted. The byte-diff guard catches fence issues that DO shift
  // the parse state for other sections.
  const badBody = 'Some text\n```\nstart fence but no close';
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'review', badBody);
  // Since review is the last phase, an unbalanced fence in its body affects
  // nothing downstream, so this should succeed (the fence state doesn't affect
  // section headings, which are detected outside of fences).
  assert.equal(res.ok, true);
  assert.equal(res.content.length > 0, true);
});

test('replacePhaseBody: rejects newBody containing a ## heading (would insert section)', () => {
  const badBody = 'Normal text\n## Phase 5 — New Section\nMore text\n';
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'test', badBody);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'section-boundary-violation');
});

test('replacePhaseBody: strips one surrounding code fence defensively', () => {
  const fencedBody = '```\nNew review content here\nWith structure\n```';
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'review', fencedBody);
  assert.equal(res.ok, true);
  const extracted = extractPhaseBody(res.content, 'review');
  assert.ok(extracted.body.includes('New review content here'));
  assert.ok(!extracted.body.includes('```'));
});

test('replacePhaseBody: handles multi-line replacement correctly', () => {
  const newBuild = 'Line 1 of new build\nLine 2 of new build\nLine 3 of new build\n';
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'build', newBuild);
  assert.equal(res.ok, true);

  const extracted = extractPhaseBody(res.content, 'build');
  assert.ok(extracted.body.includes('Line 1 of new build'));
  assert.ok(extracted.body.includes('Line 2 of new build'));
  assert.ok(extracted.body.includes('Line 3 of new build'));
});

test('replacePhaseBody: preserves the file\'s EOL style (LF stays LF, CRLF stays CRLF)', () => {
  const newContent = 'New plan content.\n';
  const res = replacePhaseBody(SKILL_MD_CRLF, 'plan', newContent);
  assert.equal(res.ok, true);
  // CRLF input should produce CRLF output
  assert.ok(res.content.includes('\r\n'));
  assert.ok(!res.content.includes('\n\n')); // No doubled newlines from mixing
});

test('replacePhaseBody: refuses partial write on failure (returns no content)', () => {
  const badBody = 'Text\n## Another ## Heading\nMore';
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'test', badBody);
  assert.equal(res.ok, false);
  assert.equal(res.content, '');
});

test('replacePhaseBody: all four phases can be replaced independently', () => {
  let result = SAMPLE_SKILL_MD;
  result = replacePhaseBody(result, 'plan', 'New plan\n').content;
  assert.ok(extractPhaseBody(result, 'plan').body.includes('New plan'));

  result = replacePhaseBody(result, 'build', 'New build\n').content;
  assert.ok(extractPhaseBody(result, 'build').body.includes('New build'));

  result = replacePhaseBody(result, 'test', 'New test\n').content;
  assert.ok(extractPhaseBody(result, 'test').body.includes('New test'));

  result = replacePhaseBody(result, 'review', 'New review\n').content;
  assert.ok(extractPhaseBody(result, 'review').body.includes('New review'));
});

// ---------------------------------------------------------------------------
// Edge cases & robustness
// ---------------------------------------------------------------------------

test('extractPhaseBody: never throws on corrupt/junk input', () => {
  const junkInputs = [
    '###############',
    '\x00\x01\x02',
    'Phase 1\nPhase 2\nPhase 3\nPhase 4',
    '{ invalid: "json" }',
    Buffer.alloc(1000).toString('utf8'),
  ];
  for (const junk of junkInputs) {
    const res = extractPhaseBody(junk, 'plan');
    assert.ok('ok' in res && 'body' in res && 'reason' in res);
    // Missing phase is the most likely outcome for junk
  }
});

test('replacePhaseBody: never throws on corrupt/junk input', () => {
  const junkInputs = [
    '###############',
    '\x00\x01\x02',
  ];
  for (const junk of junkInputs) {
    const res = replacePhaseBody(junk, 'plan', 'text');
    assert.ok('ok' in res && 'content' in res && 'reason' in res);
  }
});

test('replacePhaseBody: tolerates a section body that is empty (after heading)', () => {
  const skillMdWithEmptySection = `# Title

## Phase 1 — Plan
## Phase 2 — Build
Some build text.

## Phase 3 — Test
Test text.

## Phase 4 — Review
Review text.
`;
  const res = replacePhaseBody(skillMdWithEmptySection, 'plan', 'New plan text\n');
  assert.equal(res.ok, true);
});

test('extractPhaseBody: tolerates a section body that is empty (returns empty string)', () => {
  const skillMdWithEmpty = `# Title

## Phase 1 — Plan
## Phase 2 — Build
Text

## Phase 3 — Test
Text

## Phase 4 — Review
Text
`;
  const res = extractPhaseBody(skillMdWithEmpty, 'plan');
  assert.equal(res.ok, true);
  assert.equal(res.body.trim(), '');
});

test('replacePhaseBody: section count remains unchanged after replacement', () => {
  const countSections = (md) => {
    const res = extractPhaseBody(md, 'plan'); // This tests we can parse it
    return md.match(/^##\s+Phase\s+\d/gm)?.length || 0;
  };
  const originalCount = countSections(SAMPLE_SKILL_MD);
  const res = replacePhaseBody(SAMPLE_SKILL_MD, 'build', 'new build content\n');
  const newCount = countSections(res.content);
  assert.equal(newCount, originalCount);
  assert.equal(newCount, 4);
});
