'use strict';

// ===========================================================================
// TASK-066 — unit + scenario tests: the BA raises clarifying questions and the
// orchestrator must get every one answered by the USER before planning completes.
//
// These assert the new instruction wording across BOTH copies of the two
// instruction files (assets/ canonical + .claude/ project) and their
// byte-identity via Buffer.equals. No DB / network / Electron — pure file reads.
// The failure/edge cases mutate IN-MEMORY copies only; the real files are never
// touched. Prose checks normalise whitespace so line-wrapping is irrelevant.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_BA = path.join(ROOT, 'assets', 'agents', 'ba.md');
const PROJECT_BA = path.join(ROOT, '.claude', 'agents', 'ba.md');

// Normalise CRLF + collapse whitespace runs, so a substring written across a
// wrapped line still matches. (The byte-identity tests below use raw bytes.)
function norm(p) {
  return fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ');
}
function normStr(s) {
  return s.replace(/\s+/g, ' ');
}

const skillAssets = norm(ASSETS_SKILL);
const skillProject = norm(PROJECT_SKILL);
const baAssets = norm(ASSETS_BA);
const baProject = norm(PROJECT_BA);

// --- SKILL.md: clarifying-questions requirement present in both copies -----

const SKILL_CLARIFY_SUBSTRINGS = [
  'Resolve every clarifying question before you finish',
  'returns any clarifying questions it raised',
  'each naming the affected ticket id(s)',
  'use the **AskUserQuestion** tool when available',
  "affected ticket's `question` frontmatter field",
  '`lib/ticket-questions.js`',
  "turns that ticket's board dot **yellow**",
];

test('unit: both SKILL.md copies carry the clarifying-questions requirement wording', () => {
  for (const src of [skillAssets, skillProject]) {
    for (const sub of SKILL_CLARIFY_SUBSTRINGS) {
      assert.ok(src.includes(normStr(sub)), `SKILL.md missing: ${sub}`);
    }
  }
});

// --- SKILL.md: answered-before-completion rule -----------------------------

test('unit: both SKILL.md copies require every raised question answered before completion', () => {
  for (const src of [skillAssets, skillProject]) {
    assert.ok(src.includes('Planning is **not** complete'), 'planning-not-complete rule');
    assert.ok(src.includes('do **not** issue the Phase-1 STOP'), 'no STOP until answered');
    assert.ok(src.includes('no** ticket leaves `defining`'), 'no ticket leaves defining');
    assert.ok(
      src.includes('until **every** raised question has a non-empty answer'),
      'non-empty answer gate',
    );
  }
});

// --- SKILL.md: answers never in ## Additional Context ----------------------

test('unit: both SKILL.md copies forbid writing answers into ## Additional Context', () => {
  for (const src of [skillAssets, skillProject]) {
    assert.ok(
      src.includes('Record each answer in the ticket **body**'),
      'answers recorded in ticket body',
    );
    assert.ok(src.includes('`## Clarifications` section of Q/A pairs'), 'Clarifications section');
    assert.ok(
      src.includes("**never** write an answer into the user-owned `## Additional Context`"),
      'never into Additional Context',
    );
  }
});

// --- ba.md: clarifying-questions section present in both copies ------------

const BA_CLARIFY_SUBSTRINGS = [
  '## Clarifying questions',
  'Do **not** silently guess',
  '**enumerate every open question**',
  '**name the affected ticket id(s)**',
  'You still **never write files**',
  'the orchestrator puts them to the user',
];

test('unit: both ba.md copies carry the clarifying-questions section', () => {
  for (const src of [baAssets, baProject]) {
    for (const sub of BA_CLARIFY_SUBSTRINGS) {
      assert.ok(src.includes(normStr(sub)), `ba.md missing: ${sub}`);
    }
  }
});

// --- byte-identity (raw bytes, Buffer.equals) ------------------------------

test('unit: the two SKILL.md copies are byte-identical (Buffer.equals)', () => {
  const a = fs.readFileSync(ASSETS_SKILL);
  const b = fs.readFileSync(PROJECT_SKILL);
  assert.ok(a.equals(b), 'SKILL.md copies byte-for-byte identical');
});

test('unit: the two ba.md copies are byte-identical (Buffer.equals)', () => {
  const a = fs.readFileSync(ASSETS_BA);
  const b = fs.readFileSync(PROJECT_BA);
  assert.ok(a.equals(b), 'ba.md copies byte-for-byte identical');
});

// --- scenario: the orchestrator resolves a raised question via ticket-questions

test('scenario: a raised question keeps a ticket waiting until a non-empty answer lands', () => {
  // Given the BA raised a clarifying question that the orchestrator wrote onto
  // the affected ticket's `question` frontmatter field (the TASK-005 mechanism).
  const {
    askQuestion,
    answerQuestion,
    isWaitingForAnswer,
  } = require(path.join(ROOT, 'lib', 'ticket-questions.js'));

  let fm = { id: 'TASK-100', title: 'x', status: 'defining' };
  fm = askQuestion(fm, 'Which storage backend should this use?', { at: '2026-07-19T00:00:00Z' });
  // Then the ticket is waiting (board dot yellow) and planning is not complete.
  assert.equal(fm.question, 'Which storage backend should this use?');
  assert.ok(isWaitingForAnswer(fm), 'ticket waits with a question and no answer');

  // When an empty answer is recorded the ticket keeps waiting (edge case).
  const stillWaiting = answerQuestion(fm, '   ', { at: '2026-07-19T00:01:00Z' });
  assert.ok(isWaitingForAnswer(stillWaiting), 'empty answer does not satisfy the gate');

  // When the user gives a non-empty answer the gate opens.
  const answered = answerQuestion(fm, 'Use the existing ticket store', { at: '2026-07-19T00:02:00Z' });
  assert.ok(!isWaitingForAnswer(answered), 'non-empty answer clears the waiting state');
  assert.equal(answered.answer, 'Use the existing ticket store');
});

// --- FAILURE / edge cases (in-memory only; real files untouched) -----------

test('unit (edge): a single-byte in-memory drift breaks Buffer.equals (real files untouched)', () => {
  const original = fs.readFileSync(ASSETS_SKILL);
  const mutated = Buffer.from(original);
  mutated[0] = mutated[0] ^ 0xff;
  assert.ok(!mutated.equals(fs.readFileSync(PROJECT_SKILL)), 'flipped byte detected');
  // Real files remain identical.
  assert.ok(
    fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real SKILL.md copies untouched and still identical',
  );
});

test('unit (edge): removing the new wording from an in-memory copy fails the presence check', () => {
  // Remove the clarifying-questions requirement from an in-memory SKILL copy.
  const stripped = skillAssets.replace(
    normStr('use the **AskUserQuestion** tool when available'),
    'use a tool',
  );
  assert.ok(
    !stripped.includes('use the **AskUserQuestion** tool when available'),
    'stripped in-memory copy fails the AskUserQuestion presence check',
  );
  // Remove the section heading from an in-memory ba copy.
  const baStripped = baAssets.replace(normStr('## Clarifying questions'), '## Removed');
  assert.ok(!baStripped.includes('## Clarifying questions'), 'stripped ba copy fails presence check');
  // Real files still carry the wording.
  assert.ok(skillAssets.includes('use the **AskUserQuestion** tool when available'));
  assert.ok(baAssets.includes('## Clarifying questions'));
});
