'use strict';

// ===========================================================================
// TASK-030 — UNIT tests for the Plan-button command composition + gating logic.
//
// The Plan button's submit handler (renderer.js openPlanModal.onSubmit) is a
// browser script and cannot be require()'d, so its PURE core — trim, compose
// "/orchestrate plan <text>", enqueue exactly once, and dispatch only when
// idle — is unit-tested here via faithful replicas. The `isBuildCommand`
// exact-match rule is replicated verbatim from renderer.js (~6031) so we can
// assert a plan prompt is never treated as a build command.
//
// NO DATABASE, DISK, OR NETWORK. The queue is a plain array; every dependency
// is a pure function.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Units under test (pure replicas of the shipped renderer logic) ──────────

const PLAN_ERROR = 'Describe what you want built.';

// Replica of openPlanModal.onSubmit's core (renderer.js ~6541-6556): trims the
// textarea, rejects empty/whitespace with an inline error and NO enqueue, else
// pushes exactly one "/orchestrate plan " + text and reports whether an idle
// terminal would dispatch it.
function planEnqueue(queue, rawText, status) {
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text) {
    return { pushed: false, prompt: null, dispatched: false, error: PLAN_ERROR, modalOpen: true };
  }
  const prompt = '/orchestrate plan ' + text;
  queue.push(prompt);
  return { pushed: true, prompt, dispatched: status === 'finished', error: '', modalOpen: false };
}

// Verbatim replica of renderer.js BUILD_COMMAND (~5965) + isBuildCommand (~6031).
const BUILD_COMMAND = '/orchestrate build';
function isBuildCommand(p) {
  return typeof p === 'string' && (p === BUILD_COMMAND || p.startsWith(BUILD_COMMAND + ' '));
}

// Replica of updatePlanBtn's gate (renderer.js ~6119): usable only when a folder
// is open AND the orchestration skill is installed.
function planEnabled(folder, skillInstalled) {
  return !!(folder && skillInstalled);
}

// ── planEnqueue: valid text ─────────────────────────────────────────────────

test('planEnqueue: valid text pushes exactly one "/orchestrate plan <text>"', () => {
  const queue = [];
  const r = planEnqueue(queue, 'add a bulk export button', 'finished');
  assert.equal(queue.length, 1);
  assert.equal(queue[0], '/orchestrate plan add a bulk export button');
  assert.equal(r.prompt, '/orchestrate plan add a bulk export button');
  assert.equal(r.pushed, true);
});

test('planEnqueue: trims surrounding whitespace but keeps interior text intact', () => {
  const queue = [];
  const r = planEnqueue(queue, '   add a toggle   ', 'finished');
  assert.equal(queue[0], '/orchestrate plan add a toggle');
  assert.equal(r.pushed, true);
});

test('planEnqueue: multi-line bullet text stays a SINGLE string (no newline split, no truncation)', () => {
  const queue = [];
  const bullets = [
    '- add a dark mode toggle',
    '- persist the choice per user',
    '- default to system preference',
  ].join('\n');
  planEnqueue(queue, bullets, 'finished');
  // Exactly one queue entry — the newlines did NOT split it into multiple prompts.
  assert.equal(queue.length, 1);
  assert.equal(queue[0], '/orchestrate plan ' + bullets);
  // Every bullet survives verbatim.
  assert.ok(queue[0].includes('- add a dark mode toggle'));
  assert.ok(queue[0].includes('- persist the choice per user'));
  assert.ok(queue[0].includes('- default to system preference'));
  // And the newlines are preserved inside the single string.
  assert.equal((queue[0].match(/\n/g) || []).length, 2);
});

test('planEnqueue: very long text is passed verbatim with no truncation', () => {
  const queue = [];
  const long = 'x'.repeat(5000);
  planEnqueue(queue, long, 'finished');
  assert.equal(queue[0], '/orchestrate plan ' + long);
  assert.equal(queue[0].length, '/orchestrate plan '.length + 5000);
});

// ── planEnqueue: empty / whitespace rejection ───────────────────────────────

for (const [label, text] of [['empty string', ''], ['spaces', '   '], ['newlines+tabs', '\n\t  \n'], ['null', null], ['undefined', undefined]]) {
  test(`planEnqueue: ${label} pushes nothing and returns the inline error`, () => {
    const queue = [];
    const r = planEnqueue(queue, text, 'finished');
    assert.equal(queue.length, 0, 'nothing enqueued');
    assert.equal(r.pushed, false);
    assert.equal(r.error, PLAN_ERROR);
    assert.equal(r.modalOpen, true, 'modal stays open on rejection');
    assert.equal(r.dispatched, false);
  });
}

// ── planEnqueue: dispatch only when idle ────────────────────────────────────

test('planEnqueue: dispatch fires only when the terminal is finished (idle)', () => {
  assert.equal(planEnqueue([], 'go', 'finished').dispatched, true);
});

test('planEnqueue: dispatch is withheld while the terminal is busy, but the prompt is still queued', () => {
  const queue = [];
  const r = planEnqueue(queue, 'go', 'running');
  assert.equal(r.dispatched, false);
  assert.equal(queue.length, 1, 'prompt is queued even when dispatch is withheld');
});

test('planEnqueue: dispatch is withheld for any non-finished status', () => {
  for (const s of ['running', 'starting', 'idle', 'error', undefined, null, '']) {
    assert.equal(planEnqueue([], 'go', s).dispatched, false, `status "${s}" must not dispatch`);
  }
});

// ── plan prompt vs build command ────────────────────────────────────────────

test('isBuildCommand: matches bare and argumented build commands', () => {
  assert.equal(isBuildCommand('/orchestrate build'), true);
  assert.equal(isBuildCommand('/orchestrate build '), true);
  assert.equal(isBuildCommand('/orchestrate build --concurrency 4'), true);
});

test('isBuildCommand: a plan prompt is NEVER matched as a build command', () => {
  const queue = [];
  planEnqueue(queue, 'add a dark mode toggle', 'finished');
  assert.equal(isBuildCommand(queue[0]), false);
  assert.equal(isBuildCommand('/orchestrate plan'), false);
  assert.equal(isBuildCommand('/orchestrate plan build a thing'), false,
    'even a plan whose text mentions "build" is not a build command');
});

test('isBuildCommand: rejects non-strings and unrelated prompts', () => {
  assert.equal(isBuildCommand(null), false);
  assert.equal(isBuildCommand(undefined), false);
  assert.equal(isBuildCommand(42), false);
  // '/orchestrate buildup' starts with 'build' but not 'build ' — must NOT match.
  assert.equal(isBuildCommand('/orchestrate buildup'), false);
});

// ── plan button gating ──────────────────────────────────────────────────────

test('planEnabled: enabled only with an open folder AND the skill installed', () => {
  assert.equal(planEnabled('/proj', true), true);
  assert.equal(planEnabled(null, true), false, 'no folder -> disabled');
  assert.equal(planEnabled('/proj', false), false, 'skill not installed -> disabled');
  assert.equal(planEnabled(null, false), false);
  assert.equal(planEnabled('', true), false, 'empty folder -> disabled');
});
