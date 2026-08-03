'use strict';

// Unit tests for TASK-016: finer-grained assertions over the strengthened BA
// instruction files. Where the e2e file mirrors the ticket's Gherkin scenarios
// end-to-end, these unit cases pin down each individual required phrase/rule so a
// regression that weakens one specific requirement fails a narrow, named test.
//
//   Files under test:
//     .claude/agents/ba.md
//     .claude/skills/orchestrate/SKILL.md   (Phase 1)
//
// NO NETWORK, NO DATABASE (N/A — this project has no DB). The only I/O is reading
// these markdown files from disk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const BA_PATH = path.join(REPO_ROOT, '.claude', 'agents', 'ba.md');
const SKILL_PATH = path.join(
  REPO_ROOT,
  '.claude',
  'skills',
  'orchestrate',
  'SKILL.md',
);

const BA = fs.readFileSync(BA_PATH, 'utf8');
const SKILL = fs.readFileSync(SKILL_PATH, 'utf8');

function has(text, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return re.test(text);
}

test('UNIT: both instruction files exist and are non-trivial', () => {
  assert.ok(fs.existsSync(BA_PATH), 'ba.md must exist');
  assert.ok(fs.existsSync(SKILL_PATH), 'SKILL.md must exist');
  assert.ok(BA.trim().length > 200, 'ba.md must have real content');
  assert.ok(SKILL.trim().length > 200, 'SKILL.md must have real content');
});

test('UNIT: ba.md mandates thorough codebase analysis (read + search)', () => {
  assert.ok(has(BA, /\bthorough(ly)?\b/), 'ba.md must say "thorough"');
  assert.ok(has(BA, /\banaly[sz](e|is)\b/), 'ba.md must mention analysis');
  assert.ok(has(BA, /\bread\b/), 'ba.md must require reading');
  assert.ok(has(BA, /\bsearch/), 'ba.md must require searching');
  assert.ok(
    has(BA, /codebase|code base|relevant files|existing (code|structure|conventions|files)/i),
    'ba.md must scope the analysis to the relevant codebase/files',
  );
});

test('UNIT: ba.md requires capturing all information a coder needs in the ticket', () => {
  assert.ok(
    has(BA, /all[^.\n]*information[^.\n]*coder[^.\n]*need|information a coder needs/i),
    'ba.md must require capturing all the information a coder needs',
  );
  assert.ok(
    has(BA, /in(side)? the ticket|ticket body|inside the ticket/i),
    'ba.md must require the information to live inside the ticket',
  );
});

test('UNIT: ba.md ticket must contain precise description', () => {
  assert.ok(
    has(BA, /precise[^.\n]*description|description[^.\n]*precise/i),
    'ba.md must require a precise description',
  );
});

test('UNIT: ba.md ticket must contain complete acceptance criteria', () => {
  assert.ok(
    has(BA, /complete[^.\n]*acceptance criteria|acceptance criteria[^.\n]*complete/i),
    'ba.md must require complete acceptance criteria',
  );
});

test('UNIT: ba.md requires Gherkin for every acceptance criterion', () => {
  assert.ok(has(BA, /gherkin/i), 'ba.md must mention Gherkin');
  assert.ok(
    has(BA, /every[^.\n]*(criteri|acceptance)|covering[^.\n]*every|for every criterion/i),
    'ba.md must require Gherkin covering every criterion',
  );
});

test('UNIT: ba.md requires explicit edge and failure cases', () => {
  assert.ok(
    has(BA, /edge[^.\n]*failure|failure[^.\n]*edge|edge (cases?|and failure)|failure (cases?|paths?)/i),
    'ba.md must require explicit edge and failure cases',
  );
  assert.ok(
    has(BA, /explicit|explicitly/i),
    'ba.md must require these to be listed explicitly',
  );
});

test('UNIT: ba.md requires the relevant files and context to be recorded', () => {
  assert.ok(
    has(BA, /relevant files( and context)?|files and context|relevant[^.\n]*(files|context)/i),
    'ba.md must require recording the relevant files and context',
  );
});

test('UNIT: ba.md keeps the at-least-one-failure/edge Gherkin mandate', () => {
  assert.ok(
    has(BA, /at least one[^.\n]*(failure|edge)[^.\n]*scenario|one (failure|edge)[^.\n]*scenario per ticket/i),
    'ba.md must require at least one failure/edge scenario per ticket',
  );
});

test('UNIT: ba.md enforces "captured before build/Phase 2" ordering', () => {
  assert.ok(
    has(BA, /before[^.\n]*(any )?build|before[^.\n]*phase 2|before any build begins/i),
    'ba.md must require capture before any build begins',
  );
});

// TASK-204: SKILL.md no longer has a "Phase 1" section or restates the BA's
// thoroughness/capture-before-build mandate — that role-specific detail now
// lives exclusively in .claude/agents/ba.md (see the ba.md-focused tests
// above, all of which still pass). SKILL.md's generic loop only needs to
// describe that a `defining` column exists, dispatches orchestrate-ba, and
// gates on the definition-skip check.
test('UNIT: SKILL.md documents the `defining` column dispatching orchestrate-ba with the definition gate', () => {
  assert.ok(has(SKILL, /`defining`.*orchestrate-ba/is), 'SKILL.md must dispatch the defining column to orchestrate-ba');
  assert.ok(has(SKILL, /isTicketDefined/), 'SKILL.md must reference the isTicketDefined definition-skip gate');
  assert.ok(
    has(SKILL, /ticket returns to[\s\S]{0,20}todo[\s\S]{0,80}never straight into[\s\S]{0,20}in-progress/i),
    'SKILL.md must require a defined ticket to return to todo before it is claimed/built',
  );
});

test('UNIT: ba.md preserves no-code / no-source-edit hard rule', () => {
  assert.ok(
    has(BA, /never (write|writes)[^.\n]*code|not write[^.\n]*code/i),
    'ba.md must forbid writing implementation code',
  );
  assert.ok(
    has(BA, /(never|not|no)[^.\n]*(edit|create)[^.\n]*(source )?files?/i),
    'ba.md must forbid editing or creating source files',
  );
});

test('UNIT: ba.md preserves user-owned Additional Context rule', () => {
  assert.ok(has(BA, /additional context/i), 'ba.md must reference Additional Context');
  assert.ok(has(BA, /user[- ]owned|belongs to the user|for the user/i), 'must be user-owned');
  assert.ok(has(BA, /empty/i), 'must stay empty');
  assert.ok(
    has(BA, /never (overwrite|delete|edit)|not (overwrite|delete|edit)/i),
    'ba.md must forbid overwriting Additional Context',
  );
});

test('UNIT: SKILL.md preserves user-owned Additional Context rule', () => {
  assert.ok(has(SKILL, /additional context/i), 'SKILL.md must reference Additional Context');
  assert.ok(
    has(SKILL, /user[- ]owned|belongs to the user|for the user/i),
    'SKILL.md must state Additional Context is user-owned',
  );
  assert.ok(
    has(SKILL, /never (overwrite|delete|edit)|not (overwrite|delete|edit)/i),
    'SKILL.md must forbid overwriting Additional Context',
  );
});
