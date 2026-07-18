'use strict';

// Cucumber-style e2e scenarios for TASK-016: strengthen the BA instruction files
// so the business analyst thoroughly analyzes and FULLY captures each ticket
// before any build begins.
//
// This is an INSTRUCTION/DOCUMENTATION ticket: the deliverable is strengthened
// instruction files rather than product code, so the testable contract is that
// those files now contain the required statements/rules. There is no runtime
// behaviour to exercise; the only I/O is reading files from disk.
//
//   Files under test:
//     .claude/agents/ba.md
//     .claude/skills/orchestrate/SKILL.md   (Phase 1)
//
// These scenarios are written in Given/When/Then form as `node --test` cases
// (NO `cucumber` npm package is installed or added) and mirror, one-for-one, the
// ticket's Gherkin acceptance scenarios — including the edge/failure scenarios.
//
// NO NETWORK, NO DATABASE (N/A — there is no DB in this project). The only I/O is
// reading these markdown files from disk, which is the whole point of the
// contract; by construction no DB connection is ever opened.

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

function readFile(p) {
  assert.ok(fs.existsSync(p), `expected instruction file to exist on disk: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

// Robust, case-insensitive "does this text contain a match for pattern" helper.
function matches(text, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return re.test(text);
}

// Assert that ALL of the given patterns match somewhere in `text`.
function assertAll(text, patterns, label) {
  const missing = patterns.filter((p) => !matches(text, p));
  assert.deepEqual(
    missing.map(String),
    [],
    `${label}: expected the file to express: ${missing.map(String).join(' | ')}`,
  );
}

test('TASK-016 e2e: BA thoroughly analyzes and fully captures each ticket before build', async (t) => {
  await t.test(
    'Scenario: BA agent requires thorough codebase analysis — ' +
      'Given ".claude/agents/ba.md", When I read it, Then it requires the BA to ' +
      'read and search the relevant codebase before a ticket is defined',
    () => {
      const ba = readFile(BA_PATH);

      // Requires reading/searching the codebase.
      assert.ok(
        matches(ba, /\b(read|search)(ing|es)?\b/) &&
          matches(ba, /\b(codebase|code base|relevant files|existing (code|files|structure))\b/),
        'ba.md must require the BA to read and search the relevant codebase',
      );
      // "thorough" analysis concept.
      assert.ok(
        matches(ba, /\bthorough(ly)?\b/) && matches(ba, /\banaly[sz]e|analysis\b/),
        'ba.md must require a thorough analysis',
      );
      // Before a ticket is defined / up front.
      assert.ok(
        matches(ba, /before\b[^.]*\b(ticket|defined|build)|before (a )?ticket is defined|up front|before any build/i),
        'ba.md must require the analysis to happen before a ticket is defined',
      );
    },
  );

  await t.test(
    'Scenario: Ticket captures all information a coder needs — ' +
      'Given ".claude/agents/ba.md", Then it requires each ticket to contain a ' +
      'precise description, complete acceptance criteria, Gherkin for every ' +
      'criterion, explicit edge and failure cases, and the relevant files and context',
    () => {
      const ba = readFile(BA_PATH);

      // "all the information a coder needs" capture requirement.
      assert.ok(
        matches(ba, /all[^.]*information[^.]*coder[^.]*need|information a coder needs/i),
        'ba.md must require capturing all the information a coder needs',
      );

      assertAll(
        ba,
        [
          /precise[^.\n]*description|description[^.\n]*precise/i, // precise description
          /complete[^.\n]*acceptance criteria|acceptance criteria[^.\n]*complete/i, // complete acceptance criteria
          /gherkin/i, // Gherkin
          /every[^.\n]*(criteri|acceptance)|for every criterion|covering[^.\n]*every/i, // for every criterion
          /edge[^.\n]*failure|failure[^.\n]*edge|edge (cases?|and failure)|failure (cases?|paths?)/i, // explicit edge and failure cases
          /relevant files( and context)?|files and context|relevant .*(files|context)/i, // relevant files and context
        ],
        'ba.md ticket-contents requirement',
      );
    },
  );

  await t.test(
    'Scenario: Gherkin still requires an edge or failure scenario — ' +
      'Given ".claude/agents/ba.md", Then it still requires at least one failure ' +
      'or edge scenario per ticket',
    () => {
      const ba = readFile(BA_PATH);
      assert.ok(
        matches(
          ba,
          /at least one[^.\n]*(failure|edge)[^.\n]*scenario|one (failure|edge)[^.\n]*scenario per ticket/i,
        ),
        'ba.md must require at least one failure/edge scenario per ticket',
      );
    },
  );

  await t.test(
    'Scenario: Analysis must be captured before the build phase — ' +
      'Given ".claude/agents/ba.md" and ".claude/skills/orchestrate/SKILL.md", ' +
      'Then they state the full analysis must be captured in the ticket before ' +
      'any build begins',
    () => {
      const ba = readFile(BA_PATH);
      const skill = readFile(SKILL_PATH);

      for (const [name, text] of [
        ['ba.md', ba],
        ['SKILL.md', skill],
      ]) {
        assert.ok(
          matches(text, /captured?[^.\n]*(in|inside)[^.\n]*ticket|inside the ticket|in the ticket/i),
          `${name} must state the analysis is captured inside the ticket`,
        );
        assert.ok(
          matches(
            text,
            /before[^.\n]*(any )?build|before[^.\n]*phase 2|before any build begins|before the build/i,
          ),
          `${name} must state this happens before any build begins`,
        );
      }
    },
  );

  await t.test(
    'Scenario (edge): BA still may not write code — ' +
      'Given ".claude/agents/ba.md", Then it still forbids the BA from writing ' +
      'implementation code or editing or creating source files',
    () => {
      const ba = readFile(BA_PATH);
      assert.ok(
        matches(ba, /never (write|writes)[^.\n]*(implementation )?code|not write[^.\n]*code|no(t)? .*implementation code/i),
        'ba.md must forbid writing implementation code',
      );
      assert.ok(
        matches(ba, /(never|not|no)[^.\n]*(edit|create)[^.\n]*(source )?files?|edit or create source files/i),
        'ba.md must forbid editing or creating source files',
      );
    },
  );

  await t.test(
    'Scenario (edge): Additional Context stays user-owned — ' +
      'Given ".claude/agents/ba.md" and ".claude/skills/orchestrate/SKILL.md", ' +
      'Then they still require the "Additional Context" section to stay empty and ' +
      'user-owned and never be overwritten',
    () => {
      const ba = readFile(BA_PATH);
      const skill = readFile(SKILL_PATH);

      for (const [name, text] of [
        ['ba.md', ba],
        ['SKILL.md', skill],
      ]) {
        assert.ok(
          matches(text, /additional context/i),
          `${name} must reference the "Additional Context" section`,
        );
        assert.ok(
          matches(text, /user[- ]owned|belongs to the user|for the user/i),
          `${name} must state Additional Context is user-owned`,
        );
        assert.ok(
          matches(text, /empty/i),
          `${name} must state Additional Context is left empty`,
        );
        assert.ok(
          matches(text, /never (overwrite|edit|delete)|not (overwrite|edit|delete)|never .*overwrit/i),
          `${name} must state Additional Context is never overwritten`,
        );
      }
    },
  );
});
