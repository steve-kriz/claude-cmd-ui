'use strict';

// UNIT + E2E-cucumber tests for TASK-018: "add a fourth orchestrate role — the
// tech-lead / reviewer — that reviews each ticket AFTER it passes testing and
// BEFORE the orchestrator marks it done".
//
// Like TASK-014 (test/orchestrate-testing-step.test.js), this is primarily an
// INSTRUCTION/DEFINITION ticket: the coder added a new agent definition
// (.claude/agents/tech-lead.md == assets/agents/tech-lead.md), documented a
// "Phase 4 — Tech-lead review" step in both SKILL.md copies, and registered the
// agent in lib/orchestrate-agents.js. The testable contract is therefore:
//   * the new definition file exists, is correctly scoped, and is byte-identical
//     across the .claude/ and assets/ copies (drift guard);
//   * both SKILL.md copies document the testing -> tech-lead review -> done step,
//     the Task-tool dispatch + general-purpose fallback, the follow-up todo
//     ticket rule, and stay byte-identical;
//   * the six-status enum is UNCHANGED (no review lane) in SKILL.md,
//     lib/ticket-lanes.js and lib/ticket-folders.js;
//   * lib/orchestrate-agents.js registers orchestrate-tech-lead (frozen,
//     resolveAgentType/isFallback correct);
//   * follow-up ids continue from the true max TASK-nnn (a small pure helper).
//
// NO DATABASE, NO REAL DB CONNECTION, NO NETWORK. The only real I/O is reading
// the app's own instruction/source files from disk as fixtures — exactly the
// contract under test.
//
// This file deliberately carries BOTH kinds of tests the workflow mandates:
//   * UNIT TESTS   -> test('UNIT: ...') cases: focused assertions on the agent
//                     library, the max-id helper, and per-file phrase checks.
//   * E2E CUCUMBER SCENARIOS -> test('E2E cucumber: ...') suites: Given/When/Then
//                     cases that mirror the ticket's Gherkin acceptance scenarios.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FALLBACK_AGENT,
  AGENT_TYPES,
  AGENT_NAMES,
  resolveAgentType,
  isFallback,
} = require('../lib/orchestrate-agents');

const { LANE_STATUSES } = require('../lib/ticket-lanes');

const ROOT = path.join(__dirname, '..');
const PROJECT_AGENT = path.join(ROOT, '.claude', 'agents', 'tech-lead.md');
const ASSETS_AGENT = path.join(ROOT, 'assets', 'agents', 'tech-lead.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const LANES = path.join(ROOT, 'lib', 'ticket-lanes.js');
const FOLDERS = path.join(ROOT, 'lib', 'ticket-folders.js');

const readLower = (p) => fs.readFileSync(p, 'utf8').toLowerCase();
const readRaw = (p) => fs.readFileSync(p);

// The canonical six-lane enum — no review lane may ever be added. (TASK-028
// replaced the failed-testing lane with post-processing; failed-testing remains
// a valid status without its own lane.)
const SIX_STATUSES = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];

// --- Minimal flat-YAML frontmatter parser (matches the shape the agent files
// use: inline scalars + a `>-` folded description block). ---------------------
function parseFrontmatter(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close === -1) return null;
  const fm = {};
  let i = 1;
  while (i < close) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) { i++; continue; }
    const key = m[1];
    const val = m[2];
    if (['>-', '>', '|', '|-'].includes(val)) {
      const parts = [];
      i++;
      while (i < close && (lines[i].trim() === '' || /^\s+\S/.test(lines[i]))) {
        parts.push(lines[i].trim());
        i++;
      }
      fm[key] = parts.join(' ').trim();
      continue;
    }
    fm[key] = val.trim();
    i++;
  }
  return { fm, body: lines.slice(close + 1).join('\n') };
}

const parseTools = (v) => String(v || '').split(',').map((t) => t.trim()).filter(Boolean);

// --- Pure follow-up id sequencing helper -----------------------------------
// Given a list of ticket ids/filenames spanning all status subfolders, return
// the next `count` TASK-nnn ids continuing from the TRUE maximum, zero-padded to
// the widest existing width (min 3). Never reuses or gaps the sequence.
function nextTaskIds(existing, count = 1) {
  let max = 0;
  let width = 3;
  for (const entry of existing || []) {
    const m = /TASK-0*(\d+)/i.exec(String(entry));
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
    const digits = /TASK-(\d+)/i.exec(String(entry));
    if (digits) width = Math.max(width, digits[1].length);
  }
  const ids = [];
  for (let k = 1; k <= count; k++) {
    ids.push(`TASK-${String(max + k).padStart(width, '0')}`);
  }
  return ids;
}

// ===========================================================================
// UNIT TESTS
// ===========================================================================

test('UNIT: tech-lead.md exists in BOTH .claude/agents and assets/agents', () => {
  assert.ok(fs.existsSync(PROJECT_AGENT), `expected ${PROJECT_AGENT} to exist`);
  assert.ok(fs.existsSync(ASSETS_AGENT), `expected ${ASSETS_AGENT} to exist`);
});

test('UNIT: the two tech-lead.md copies are byte-for-byte identical', () => {
  assert.ok(readRaw(PROJECT_AGENT).equals(readRaw(ASSETS_AGENT)),
    '.claude/agents/tech-lead.md must equal assets/agents/tech-lead.md byte-for-byte');
});

test('UNIT: tech-lead frontmatter — name orchestrate-tech-lead, non-empty description, scoped tools', () => {
  const parsed = parseFrontmatter(fs.readFileSync(ASSETS_AGENT, 'utf8'));
  assert.ok(parsed, 'has a frontmatter block');
  const { fm } = parsed;
  assert.equal(fm.name, 'orchestrate-tech-lead');
  assert.ok(typeof fm.description === 'string' && fm.description.length > 0, 'description non-empty');
  const tools = parseTools(fm.tools);
  for (const t of ['Read', 'Grep', 'Glob']) assert.ok(tools.includes(t), `tools include ${t}`);
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(!tools.includes(t), `tools must NOT include ${t}`);
});

test('UNIT: lib/orchestrate-agents registers the reviewer after the tester, frozen', () => {
  assert.equal(AGENT_TYPES.techLead, 'orchestrate-tech-lead');
  assert.ok(AGENT_NAMES.includes('orchestrate-tech-lead'), 'AGENT_NAMES includes the reviewer');
  assert.equal(
    AGENT_NAMES.indexOf('orchestrate-tech-lead'),
    AGENT_NAMES.indexOf('orchestrate-tester') + 1,
    'reviewer is ordered immediately after the tester',
  );
  assert.ok(Object.isFrozen(AGENT_TYPES), 'AGENT_TYPES frozen');
  assert.ok(Object.isFrozen(AGENT_NAMES), 'AGENT_NAMES frozen');
});

test('UNIT: resolveAgentType/isFallback for the reviewer — present vs missing', () => {
  // Present -> itself, not a fallback.
  assert.equal(resolveAgentType('orchestrate-tech-lead', ['orchestrate-tech-lead']), 'orchestrate-tech-lead');
  assert.equal(isFallback('orchestrate-tech-lead', ['orchestrate-tech-lead']), false);
  assert.equal(resolveAgentType('orchestrate-tech-lead', new Set(AGENT_NAMES)), 'orchestrate-tech-lead');
  // Missing -> general-purpose fallback, reported as a fallback.
  const withoutIt = AGENT_NAMES.filter((n) => n !== 'orchestrate-tech-lead');
  assert.equal(resolveAgentType('orchestrate-tech-lead', withoutIt), FALLBACK_AGENT);
  assert.equal(resolveAgentType('orchestrate-tech-lead', withoutIt), 'general-purpose');
  assert.equal(isFallback('orchestrate-tech-lead', withoutIt), true);
});

test('UNIT: the six-status enum is unchanged (lib/ticket-lanes.js LANE_STATUSES)', () => {
  assert.deepEqual(LANE_STATUSES, SIX_STATUSES, 'no new status value added to the enum');
});

test('UNIT: no review lane leaks into ticket-lanes.js / ticket-folders.js source', () => {
  for (const [label, p] of [['ticket-lanes.js', LANES], ['ticket-folders.js', FOLDERS]]) {
    const src = readLower(p);
    // A new status would show up as a quoted 'review'/'reviewing'/'tech-lead' lane.
    for (const bad of ["'review'", '"review"', "'reviewing'", "'tech-lead'", "'tech-lead-review'"]) {
      assert.ok(!src.includes(bad), `${label} must not introduce a ${bad} status`);
    }
  }
});

test('UNIT: max-id helper continues from the true maximum (synthetic list)', () => {
  const list = [
    'tasks/done/TASK-017-swarm.md',
    'tasks/testing/TASK-018-agent-update.md',
    'tasks/todo/TASK-019-something.md',
    'tasks/todo/TASK-005-old.md',
  ];
  // Current max is TASK-019 -> two follow-ups are TASK-020 and TASK-021.
  assert.deepEqual(nextTaskIds(list, 2), ['TASK-020', 'TASK-021']);
  assert.deepEqual(nextTaskIds(list, 1), ['TASK-020']);
  // Empty / no-match lists start the sequence sanely and never throw.
  assert.deepEqual(nextTaskIds([], 1), ['TASK-001']);
  assert.deepEqual(nextTaskIds(['not-a-ticket.md'], 1), ['TASK-001']);
});

// ===========================================================================
// E2E CUCUMBER-STYLE SCENARIOS (mirror the ticket's Gherkin)
// ===========================================================================

test('E2E cucumber: the tech-lead agent definition exists in both locations', async (t) => {
  await t.test(
    'When I look for the reviewer definition, ' +
    'Then tech-lead.md exists in .claude/agents AND in assets/agents',
    () => {
      assert.ok(fs.existsSync(PROJECT_AGENT), '.claude/agents/tech-lead.md exists');
      assert.ok(fs.existsSync(ASSETS_AGENT), 'assets/agents/tech-lead.md exists');
    },
  );
});

test('E2E cucumber: the two tech-lead copies are byte-identical (drift guard)', async (t) => {
  await t.test(
    'Given .claude/agents/tech-lead.md and assets/agents/tech-lead.md, ' +
    'When I compare their raw bytes, Then they are byte-for-byte identical',
    () => {
      assert.ok(readRaw(PROJECT_AGENT).equals(readRaw(ASSETS_AGENT)),
        'copies must be identical — an edit to one without the other must fail this guard');
    },
  );
});

test('E2E cucumber: the tech-lead agent has valid, correctly scoped frontmatter', async (t) => {
  await t.test(
    'Given assets/agents/tech-lead.md, When I parse its frontmatter, ' +
    'Then name is orchestrate-tech-lead, description non-empty, tools = Read/Grep/Glob and not Edit/Write/Bash',
    () => {
      const { fm } = parseFrontmatter(fs.readFileSync(ASSETS_AGENT, 'utf8'));
      assert.equal(fm.name, 'orchestrate-tech-lead');
      assert.ok(fm.description && fm.description.length > 0);
      const tools = parseTools(fm.tools);
      assert.ok(tools.includes('Read') && tools.includes('Grep') && tools.includes('Glob'));
      assert.ok(!tools.includes('Edit') && !tools.includes('Write') && !tools.includes('Bash'));
    },
  );
});

test('E2E cucumber: the persona describes a thorough post-testing review', async (t) => {
  await t.test(
    'Given the tech-lead persona body, Then it runs after testing and before done, ' +
    'reviews both ticket and code, and verifies tests-cover-code and security',
    () => {
      const md = readLower(PROJECT_AGENT);
      // Review runs after a ticket passes testing and before it is done.
      assert.match(md, /passed?\s+testing|passes\s+testing/, 'review runs after testing passes');
      assert.match(md, /before it is marked `?done`?|before it is\s+\*\*marked `done`\*\*|and\s+\*\*about to be marked `done`\*\*|marked `done`/,
        'review runs before the ticket is marked done');
      assert.match(md, /testing\s*→\s*tech-lead review\s*→\s*done/, 'documents testing -> tech-lead review -> done ordering');
      // Reviews both the ticket AND the implementation code.
      assert.match(md, /both\*?\*?\s+the ticket\s+\*?\*?and\*?\*?\s+the implementation code/,
        'reviews both the ticket and the implementation code');
      // Verifies tests actually cover the code (not just that they pass).
      assert.match(md, /tests actually cover the implemented code/, 'verifies tests cover the code');
      // Verifies security concerns are addressed.
      assert.match(md, /security concerns are addressed/, 'verifies security concerns');
    },
  );
});

test('E2E cucumber: the persona routes discovered issues to new follow-up tickets', async (t) => {
  await t.test(
    'Given the tech-lead persona body, Then findings become new status:todo follow-up tickets ' +
    'continuing the TASK-nnn sequence, and the reviewer never edits the reviewed ticket status/frontmatter',
    () => {
      const md = readLower(PROJECT_AGENT);
      assert.match(md, /follow-up fix ticket/, 'findings become follow-up fix tickets');
      assert.match(md, /status:\s*todo/, 'follow-up tickets are status: todo');
      assert.match(md, /continue.{0,20}the `task-nnn` sequence|continues? the `?task-nnn`? sequence/,
        'new ids continue the TASK-nnn sequence');
      assert.match(md, /never edit(s)? the reviewed ticket'?s status\s*(or|\/)\s*frontmatter/,
        'reviewer never edits the reviewed ticket status/frontmatter');
    },
  );
});

test('E2E cucumber: both SKILL.md copies place the review between testing and done', async (t) => {
  await t.test(
    'Given both copies of SKILL.md, Then each documents a tech-lead review after testing and before done ' +
    'with the ordering testing -> tech-lead review -> post-processing -> done',
    () => {
      for (const [label, p] of [['.claude', PROJECT_SKILL], ['assets', ASSETS_SKILL]]) {
        const md = readLower(p);
        assert.match(md, /tech-lead review/, `${label}/SKILL.md documents a tech-lead review step`);
        assert.match(md, /testing\s*→\s*tech-lead review\s*→\s*post-processing\s*→\s*done/,
          `${label}/SKILL.md shows the testing -> tech-lead review -> post-processing -> done ordering`);
      }
    },
  );
});

test('E2E cucumber: both SKILL.md copies dispatch to orchestrate-tech-lead with the fallback wording', async (t) => {
  await t.test(
    'Given both copies of SKILL.md, Then each launches orchestrate-tech-lead via the Task tool ' +
    'and keeps the "fall back to general-purpose and report it" wording',
    () => {
      for (const [label, p] of [['.claude', PROJECT_SKILL], ['assets', ASSETS_SKILL]]) {
        const md = readLower(p);
        assert.match(md, /task tool,\s*`orchestrate-tech-lead`/,
          `${label}/SKILL.md dispatches the review to orchestrate-tech-lead via the Task tool`);
        assert.match(md, /`orchestrate-tech-lead`;\s*fall back to[\s\S]{0,40}`general-purpose`[\s\S]{0,40}report it/,
          `${label}/SKILL.md keeps the fall-back-to-general-purpose-and-report-it wording for the review`);
      }
    },
  );
});

test('E2E cucumber: both SKILL.md copies document follow-up ticket creation on findings', async (t) => {
  await t.test(
    'Given both copies of SKILL.md, Then each states follow-up fix tickets are status:todo continuing the max ' +
    'TASK-nnn sequence, and the review step does not change the reviewed ticket status/frontmatter',
    () => {
      for (const [label, p] of [['.claude', PROJECT_SKILL], ['assets', ASSETS_SKILL]]) {
        const md = readLower(p);
        assert.match(md, /follow-up fix ticket/, `${label}/SKILL.md documents follow-up fix tickets`);
        assert.match(md, /status:\s*todo/, `${label}/SKILL.md creates them as status: todo`);
        assert.match(md, /continues? the `?task-nnn`? sequence from the true[\s\S]{0,20}maximum|continues the `?task-nnn`? sequence/,
          `${label}/SKILL.md continues the max TASK-nnn sequence`);
        assert.match(md, /does\s*\*?\*?not\*?\*?\s+change the[\s\S]{0,40}reviewed ticket'?s status\s*(or|\/)\s*frontmatter|not change the reviewed ticket'?s status/,
          `${label}/SKILL.md states the review does not change the reviewed ticket status/frontmatter`);
      }
    },
  );
});

test('E2E cucumber: both SKILL.md copies remain byte-identical (drift guard)', async (t) => {
  await t.test(
    'Given both copies of SKILL.md, When I compare their raw bytes, Then they are byte-for-byte identical',
    () => {
      assert.ok(readRaw(PROJECT_SKILL).equals(readRaw(ASSETS_SKILL)),
        '.claude and assets SKILL.md copies must not drift');
    },
  );
});

test('E2E cucumber: the status enum is unchanged — no review lane anywhere', async (t) => {
  await t.test(
    'Given SKILL.md, lib/ticket-lanes.js and lib/ticket-folders.js, ' +
    'Then the allowed statuses are exactly the six and no review status was introduced',
    () => {
      // The lib enum is exactly the six.
      assert.deepEqual(LANE_STATUSES, SIX_STATUSES);
      // SKILL.md explicitly frames the review as a flow step, not a new status.
      for (const p of [PROJECT_SKILL, ASSETS_SKILL]) {
        const md = readLower(p);
        assert.match(md, /not a new board\s+status|no new value into the six-status enum|not a new board status/,
          'SKILL.md states the review is a flow step, not a new status');
      }
      // No source file smuggles in a review lane value.
      for (const p of [LANES, FOLDERS]) {
        const src = readLower(p);
        for (const bad of ["'review'", '"review"', "'reviewing'", "'tech-lead'"]) {
          assert.ok(!src.includes(bad), `no ${bad} status lane`);
        }
      }
    },
  );
});

test('E2E cucumber: the reviewer is registered in the agent-type library', async (t) => {
  await t.test(
    'Given lib/orchestrate-agents.js, Then AGENT_TYPES.techLead equals orchestrate-tech-lead, ' +
    'AGENT_NAMES includes it after the tester, both frozen, and it resolves to itself when present',
    () => {
      assert.equal(AGENT_TYPES.techLead, 'orchestrate-tech-lead');
      assert.ok(AGENT_NAMES.includes('orchestrate-tech-lead'));
      assert.equal(AGENT_NAMES.indexOf('orchestrate-tech-lead'), AGENT_NAMES.indexOf('orchestrate-tester') + 1);
      assert.ok(Object.isFrozen(AGENT_TYPES) && Object.isFrozen(AGENT_NAMES));
      assert.equal(resolveAgentType('orchestrate-tech-lead', ['orchestrate-tech-lead']), 'orchestrate-tech-lead');
    },
  );
});

test('E2E cucumber (edge): a missing tech-lead definition falls back to general-purpose', async (t) => {
  await t.test(
    'Given a project whose .claude/agents is missing tech-lead.md, ' +
    'When the review step resolves its agent type, ' +
    'Then resolveAgentType returns general-purpose and isFallback is true',
    () => {
      const withoutIt = AGENT_NAMES.filter((n) => n !== 'orchestrate-tech-lead');
      assert.equal(resolveAgentType('orchestrate-tech-lead', withoutIt), 'general-purpose');
      assert.equal(isFallback('orchestrate-tech-lead', withoutIt), true);
    },
  );
});

test('E2E cucumber (failure): review finds a security issue -> new todo ticket, reviewed ticket untouched', async (t) => {
  await t.test(
    'Given a ticket has passed testing, When the review finds an unaddressed security concern, ' +
    'Then a new status:todo fix ticket is created whose id continues the sequence ' +
    '(TASK-020 when the max is TASK-019), and the reviewed ticket status/frontmatter is not modified',
    () => {
      // The board (all status subfolders) — the reviewed ticket TASK-018 is in testing.
      const board = [
        { id: 'TASK-017', status: 'done' },
        { id: 'TASK-018', status: 'testing' }, // the reviewed ticket
        { id: 'TASK-019', status: 'todo' },
      ];
      const reviewedBefore = { ...board.find((t) => t.id === 'TASK-018') };

      // The reviewer is read-only: it produces a finding, it does NOT mutate the board.
      const finding = { kind: 'security', detail: 'unvalidated path input allows traversal' };
      const [newId] = nextTaskIds(board.map((t) => t.id), 1);

      // A new follow-up ticket is created with status: todo, continuing the sequence.
      assert.equal(newId, 'TASK-020', 'follow-up id continues from the true max TASK-019');
      const followUp = { id: newId, status: 'todo', title: finding.detail };
      assert.equal(followUp.status, 'todo');

      // The reviewed ticket's own status/frontmatter is unchanged by the review.
      const reviewedAfter = board.find((t) => t.id === 'TASK-018');
      assert.deepEqual(reviewedAfter, reviewedBefore, 'reviewer never edits the reviewed ticket');
      // And the agent file itself only grants read/search tools — it cannot write.
      const tools = parseTools(parseFrontmatter(fs.readFileSync(ASSETS_AGENT, 'utf8')).fm.tools);
      assert.ok(!tools.includes('Write') && !tools.includes('Edit') && !tools.includes('Bash'),
        'the reviewer has no write/edit/exec tools, so it structurally cannot mutate the ticket');
    },
  );
});

test('E2E cucumber (edge): follow-up ids must not reuse or gap the sequence', async (t) => {
  await t.test(
    'Given the highest existing id across all status subfolders is TASK-019, ' +
    'When the review creates two follow-up fix tickets, ' +
    'Then their ids are TASK-020 and TASK-021, reusing no id and skipping none',
    () => {
      const ids = [
        'tasks/done/TASK-010.md',
        'tasks/failed-testing/TASK-015.md',
        'tasks/in-progress/TASK-019.md',
        'tasks/todo/TASK-003.md',
      ];
      const [a, b] = nextTaskIds(ids, 2);
      assert.equal(a, 'TASK-020');
      assert.equal(b, 'TASK-021');
      assert.ok(!ids.some((x) => x.includes(a)) && !ids.some((x) => x.includes(b)), 'no id reuse');
    },
  );
});
