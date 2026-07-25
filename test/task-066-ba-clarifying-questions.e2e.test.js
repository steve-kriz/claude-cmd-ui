'use strict';

// ===========================================================================
// TASK-066 — E2E cucumber-style scenarios (Given/When/Then)
//
// Implements the ticket's Gherkin feature:
//   "Orchestrate planning gathers context and blocks on unanswered
//    clarifying questions"
//
// These are node --test cases written in Given/When/Then form. No cucumber npm
// package is used. No DB / network / Electron — pure instruction-file reads plus
// IN-MEMORY mutation for the edge/failure scenarios (the real files on disk are
// never touched). Prose checks normalise whitespace so line-wrapping in the
// source markdown is irrelevant; byte-identity scenarios use raw bytes.
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

const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-4-8';

// --- helpers ---------------------------------------------------------------

// Whitespace-collapsed read, for substring/prose assertions across wraps.
function readNorm(p) {
  return fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ');
}
function normStr(s) {
  return s.replace(/\s+/g, ' ');
}
// LF-normalised read, for regex assertions that pin exact sentences.
function readLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
// Minimal flat-YAML frontmatter parser (mirrors task-051's helper).
function parseAgentFrontmatter(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  const fm = {};
  let i = 1;
  while (i < closeIdx) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) { i++; continue; }
    const key = m[1];
    let val = m[2];
    if (val === '>-' || val === '>' || val === '|' || val === '|-') {
      const parts = [];
      i++;
      while (i < closeIdx && (lines[i].trim() === '' || /^\s+\S/.test(lines[i]))) {
        parts.push(lines[i].trim());
        i++;
      }
      fm[key] = parts.join(' ').trim();
      continue;
    }
    fm[key] = val.trim();
    i++;
  }
  return { fm };
}
function parseTools(val) {
  return String(val || '').split(',').map((t) => t.trim()).filter(Boolean);
}

// ===========================================================================
// Scenario: ba.md instructs the BA to raise questions instead of guessing
// ===========================================================================
test('E2E Scenario: ba.md instructs the BA to raise questions instead of guessing', () => {
  // Given the file .claude/agents/ba.md and its assets/agents/ba.md copy
  const baFiles = { assets: ASSETS_BA, project: PROJECT_BA };

  for (const [label, file] of Object.entries(baFiles)) {
    // When I read each file
    const text = readNorm(file);
    const { fm } = parseAgentFrontmatter(readLF(file));

    // Then each contains the clarifying-questions requirement
    for (const sub of [
      '## Clarifying questions',
      'Do **not** silently guess',
      '**enumerate every open question**',
      '**name the affected ticket id(s)**',
      'You still **never write files**',
      'the orchestrator puts them to the user',
    ]) {
      assert.ok(text.includes(normStr(sub)), `${label} ba.md missing clarifying-questions wording: ${sub}`);
    }

    // And each keeps name orchestrate-ba, tools Read, Grep, Glob and the premium
    // planning model claude-opus-4-8
    assert.equal(fm.name, 'orchestrate-ba', `${label} ba.md name unchanged`);
    assert.deepEqual(parseTools(fm.tools), ['Read', 'Grep', 'Glob'], `${label} ba.md tools unchanged`);
    assert.equal(fm.model, OPUS, `${label} ba.md pins the premium planning tier`);
  }
});

// ===========================================================================
// Scenario: SKILL.md Phase 1 requires questions to be asked and answered
//           before planning completes
// ===========================================================================
test('E2E Scenario: SKILL.md Phase 1 requires questions asked and answered before planning completes', () => {
  // Given both copies of the orchestrate SKILL.md
  for (const file of [ASSETS_SKILL, PROJECT_SKILL]) {
    // When I read the Phase 1 — Plan / Define section
    const text = readNorm(file);

    // Then it requires the BA to return clarifying questions for anything unclear
    assert.ok(text.includes(normStr('returns any clarifying questions it raised')), 'BA returns clarifying questions');
    assert.ok(text.includes(normStr('each naming the affected ticket id(s)')), 'questions name affected ticket ids');

    // And it requires the orchestrator to ask the user each question
    // (AskUserQuestion when available, else the ticket question/answer frontmatter mechanism)
    assert.ok(text.includes(normStr('use the **AskUserQuestion** tool when available')), 'AskUserQuestion channel');
    assert.ok(text.includes(normStr("affected ticket's `question` frontmatter field")), 'ticket question fallback');
    assert.ok(text.includes(normStr('`lib/ticket-questions.js`')), 'names the TASK-005 mechanism');
    assert.ok(text.includes(normStr("turns that ticket's board dot **yellow**")), 'yellow waiting dot');

    // And it states planning does not complete until every question has a non-empty answer
    assert.ok(text.includes(normStr('Planning is **not** complete')), 'planning-not-complete rule');
    assert.ok(text.includes(normStr('do **not** issue the Phase-1 STOP')), 'no STOP until answered');
    assert.ok(text.includes(normStr('no** ticket leaves `defining`')), 'no ticket leaves defining');
    assert.ok(
      text.includes(normStr('until **every** raised question has a non-empty answer')),
      'non-empty answer gate',
    );
  }
});

// ===========================================================================
// Scenario: Answers never land in the user-owned section
// ===========================================================================
test('E2E Scenario: answers are recorded in the ticket body and never in ## Additional Context', () => {
  // Given both copies of SKILL.md
  for (const file of [ASSETS_SKILL, PROJECT_SKILL]) {
    const text = readNorm(file);

    // Then each states answers are recorded in the ticket body and never in "## Additional Context"
    assert.ok(text.includes(normStr('Record each answer in the ticket **body**')), 'answers in ticket body');
    assert.ok(text.includes(normStr('`## Clarifications` section of Q/A pairs')), 'Clarifications section');
    assert.ok(
      text.includes(normStr('**never** write an answer into the user-owned `## Additional Context`')),
      'never into Additional Context',
    );
  }
});

// ===========================================================================
// Scenario: Bundled and project copies stay in sync (drift guard)
// ===========================================================================
test('E2E Scenario: bundled and project copies are byte-for-byte identical', () => {
  // Given assets/.claude SKILL.md and assets/.claude ba.md
  // When I compare each pair's raw bytes
  // Then each pair is byte-for-byte identical
  assert.ok(
    fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'SKILL.md copies byte-for-byte identical',
  );
  assert.ok(
    fs.readFileSync(ASSETS_BA).equals(fs.readFileSync(PROJECT_BA)),
    'ba.md copies byte-for-byte identical',
  );
});

// ===========================================================================
// Scenario: A drifted copy is caught (edge/failure, in-memory only)
// ===========================================================================
test('E2E Scenario (edge): a one-byte-flipped in-memory copy is caught; real files stay identical', () => {
  // Given an in-memory copy of assets SKILL.md with one byte flipped
  const original = fs.readFileSync(ASSETS_SKILL);
  const flipped = Buffer.from(original);
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;

  // When I compare it against the project copy
  // Then the comparison fails
  assert.ok(!flipped.equals(fs.readFileSync(PROJECT_SKILL)), 'flipped byte detected as drift');

  // And the real files on disk remain identical
  assert.ok(
    fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real SKILL.md copies untouched and still identical',
  );
});

// ===========================================================================
// Scenario: Removing the new wording is caught (edge/failure, in-memory only)
// ===========================================================================
test('E2E Scenario (edge): removing the clarifying-questions sentence fails the presence check', () => {
  // Given an in-memory copy of SKILL.md with the clarifying-questions sentence removed
  const inMemory = readNorm(ASSETS_SKILL);
  const stripped = inMemory.replace(
    normStr('returns any clarifying questions it raised'),
    'does whatever it likes',
  );
  // And an in-memory ba.md with the section heading removed
  const baStripped = readNorm(ASSETS_BA).replace(normStr('## Clarifying questions'), '## Removed');

  // When the presence check runs
  // Then it fails
  assert.ok(!stripped.includes(normStr('returns any clarifying questions it raised')), 'stripped SKILL fails presence check');
  assert.ok(!baStripped.includes(normStr('## Clarifying questions')), 'stripped ba fails presence check');

  // And the real files still carry the wording (untouched)
  assert.ok(readNorm(ASSETS_SKILL).includes(normStr('returns any clarifying questions it raised')));
  assert.ok(readNorm(ASSETS_BA).includes(normStr('## Clarifying questions')));
});

// ===========================================================================
// Scenario: The Model-routing directive survives the edit
// ===========================================================================
test('E2E Scenario: the Model-routing directive survives the edit', () => {
  // Given both copies of SKILL.md after the change
  for (const file of [ASSETS_SKILL, PROJECT_SKILL]) {
    const src = readLF(file);

    // Then the routing directive names the default and premium tiers
    assert.match(src, /Default model: `claude-sonnet-5`/,
      'swarm default is claude-sonnet-5');
    assert.match(src, /Premium tier `claude-opus-4-8` for planning and review only/,
      'premium tier reserved for planning + review');
    // And the planning-phase launch step dispatches the BA on the premium tier.
    assert.match(src, /dispatched on the premium tier \(see \*\*Model\s+routing\*\* above\)/,
      'Phase-1 launch step dispatches on the premium tier');

    // And neither model id appears after the "## Phase 2 — Build" heading
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(phase2Idx !== -1, 'Phase 2 heading present');
    assert.ok(src.lastIndexOf(SONNET) < phase2Idx, 'no claude-sonnet-5 after Phase 2 heading');
    assert.ok(src.lastIndexOf(OPUS) < phase2Idx, 'no claude-opus-4-8 after Phase 2 heading');
  }
});

// ===========================================================================
// Scenario (behavioural): a raised question blocks planning until a NON-EMPTY
// answer lands — exercised through the real TASK-005 ticket-questions helper,
// which is the fallback ask-the-user channel SKILL.md names. All in-memory
// frontmatter mutation; no DB / no ticket files are written.
// ===========================================================================
test('E2E Scenario: a raised question keeps its ticket waiting until the user answers non-empty', () => {
  // Given the orchestrator wrote a BA clarifying question onto the affected ticket
  const { askQuestion, answerQuestion, isWaitingForAnswer } =
    require(path.join(ROOT, 'lib', 'ticket-questions.js'));

  let fm = { id: 'TASK-100', title: 'x', status: 'defining' };
  fm = askQuestion(fm, 'Which storage backend should this use?', { at: '2026-07-19T00:00:00Z' });

  // When no answer exists yet
  // Then the ticket is waiting (board dot yellow) and planning is not complete
  assert.ok(isWaitingForAnswer(fm), 'ticket waits while the question is unanswered');

  // When the user answers with only whitespace
  // Then the empty answer does NOT satisfy the gate (mirrors the non-empty rule)
  const stillWaiting = answerQuestion(fm, '   ', { at: '2026-07-19T00:01:00Z' });
  assert.ok(isWaitingForAnswer(stillWaiting), 'whitespace-only answer does not clear the gate');

  // When the user answers non-empty
  // Then the gate opens and planning may proceed
  const answered = answerQuestion(fm, 'Use the existing ticket store', { at: '2026-07-19T00:02:00Z' });
  assert.ok(!isWaitingForAnswer(answered), 'non-empty answer clears the waiting state');
  assert.equal(answered.answer, 'Use the existing ticket store');
});
