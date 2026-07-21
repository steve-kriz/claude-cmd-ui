'use strict';

// ===========================================================================
// TASK-111 — UNIT tests for the shared active+claim refusal predicate
// `tasksActiveClaimRefusal(fm, status, userStatuses)`.
//
// This predicate is the single source of truth for BOTH the attachTasksLaneDrop
// stale-snapshot drop guard AND moveTicketToStatus's fresh on-disk re-check
// (TASK-111). It returns the refusal NOTICE STRING when a move must be refused
// (target is a configured USER status AND fresh fm.status is active AND the
// ticket carries a non-empty claiming agent) or `null` when the move may proceed.
//
// The REAL function is loaded headless out of renderer/renderer.js (a browser
// script, not require()-able) by brace-extracting it and its pure dependencies
// (TASKS_ACTIVE_STATUSES, ticketFieldNonEmpty) and evaluating them in a Function
// sandbox. NO DOM, DB, filesystem, or network is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} in renderer.js`);
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
  assert.ok(m, `const ${name} in renderer.js`);
  return m[0];
}

function loadPredicate() {
  const body = [
    extractConst(rendererSrc, 'TASKS_ACTIVE_STATUSES'),
    extractFn(rendererSrc, 'ticketFieldNonEmpty'),
    extractFn(rendererSrc, 'tasksActiveClaimRefusal'),
    'return { tasksActiveClaimRefusal, TASKS_ACTIVE_STATUSES };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

// The live user-status set the drop guard / move re-check pass in. `ux-review`
// is a configured user lane; the system lanes are deliberately NOT in this set.
const USER = new Set(['ux-review', 'design']);

test('returns the notice string when target is a user lane AND fm is active AND agent is non-empty', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  for (const status of ['defining', 'in-progress', 'testing']) {
    const msg = tasksActiveClaimRefusal(
      { id: 'TASK-9', status, agent: 'orch-42' }, 'ux-review', USER);
    assert.equal(typeof msg, 'string', `active status ${status} refuses`);
    assert.match(msg, /TASK-9/, 'notice names the ticket id');
    assert.match(msg, /orch-42/, 'notice names the claiming agent');
  }
});

test('trims the claiming agent name in the notice (leading/trailing whitespace stripped)', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  const msg = tasksActiveClaimRefusal(
    { id: 'TASK-9', status: 'in-progress', agent: '  orch-42  ' }, 'ux-review', USER);
  assert.match(msg, /by orch-42 /, 'agent is trimmed');
  assert.doesNotMatch(msg, /by {2}orch-42/, 'no untrimmed padding leaks into the notice');
});

test('falls back to "This ticket" when the fresh frontmatter has no id', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  const msg = tasksActiveClaimRefusal(
    { status: 'in-progress', agent: 'orch-42' }, 'ux-review', USER);
  assert.match(msg, /^This ticket /, 'missing id falls back to "This ticket"');
});

test('returns null when the target status is NOT in the user-status set (system lane override)', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  // done / todo / post-processing etc. are system lanes — a manual override is
  // intended, so even a freshly-claimed active ticket is NOT refused.
  for (const sys of ['done', 'todo', 'post-processing', 'in-progress', 'testing']) {
    assert.equal(
      tasksActiveClaimRefusal({ id: 'TASK-9', status: 'in-progress', agent: 'orch-42' }, sys, USER),
      null, `system-lane target "${sys}" is never refused`);
  }
});

test('returns null when the fresh fm.status is NOT active (claimed-but-not-active, e.g. done + lingering agent)', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  for (const status of ['done', 'todo', 'post-processing', 'failed-testing']) {
    assert.equal(
      tasksActiveClaimRefusal({ id: 'TASK-9', status, agent: 'orch-42' }, 'ux-review', USER),
      null, `non-active status "${status}" is not refused even with a claiming agent`);
  }
});

test('returns null when the agent field is empty / missing / whitespace-only (active-but-unclaimed)', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  for (const agent of [undefined, null, '', '   ', '\t', '\n  \n']) {
    assert.equal(
      tasksActiveClaimRefusal({ id: 'TASK-9', status: 'in-progress', agent }, 'ux-review', USER),
      null, `agent ${JSON.stringify(agent)} does not count as a live claim`);
  }
});

test('returns null when fm is null/undefined (no crash on a missing frontmatter)', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  assert.equal(tasksActiveClaimRefusal(null, 'ux-review', USER), null);
  assert.equal(tasksActiveClaimRefusal(undefined, 'ux-review', USER), null);
});

test('returns null when the user-status set is empty (no configured user lanes)', () => {
  const { tasksActiveClaimRefusal } = loadPredicate();
  assert.equal(
    tasksActiveClaimRefusal({ id: 'TASK-9', status: 'in-progress', agent: 'orch-42' }, 'ux-review', new Set()),
    null, 'with no user lanes configured nothing is a user-lane target');
});
