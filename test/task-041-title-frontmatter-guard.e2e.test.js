'use strict';

// ===========================================================================
// TASK-041 — E2E (cucumber-style, node --test) scenarios:
//   Feature: Ticket titles cannot inject frontmatter
//
// These are Given/When/Then scenario tests (no `cucumber` npm dep). They drive
// the SAME serialize→parse round-trip the renderer uses, through VERBATIM copies
// of renderer/renderer.js (a browser script, not requireable) WITH the TASK-041
// frontmatterValueLine guard. A SOURCE-SCAN drift guard ties the copies to the
// real serializer so the scenarios cannot silently pass against a stale copy.
//
// NO DATABASE. NO DISK. NO NETWORK. Deterministic (fixed timestamps).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- verbatim renderer copies (guard + serializer + parser) ----------------
function frontmatterValueLine(v) {
  return String(v).replace(/[\r\n]+/g, ' ');
}
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${frontmatterValueLine(fm[k])}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}
function parseTicketFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fm[key] = line.slice(idx + 1).trim();
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return { fm, body };
}

// Tiny Given/When/Then harness (readability only — plain assertions underneath).
function scenario(name, steps) {
  test(name, () => {
    const ctx = {};
    for (const step of steps) step(ctx);
  });
}
const Given = (fn) => (ctx) => fn(ctx);
const When = (fn) => (ctx) => fn(ctx);
const Then = (fn) => (ctx) => fn(ctx);

const TS = '2026-07-19T10:00:00.000Z';
const INTENDED_KEYS = ['id', 'title', 'status', 'created', 'updated'];
function ticketWithTitle(title) {
  return { id: 'TASK-070', title, status: 'todo', created: TS, updated: TS };
}

// ===========================================================================
// Scenario: A newline-laden title is neutralised (edge)  [AC #1 / #3]
// ===========================================================================
scenario('E2E Scenario: a newline-laden title is neutralised', [
  Given((ctx) => { ctx.fm = ticketWithTitle('pwn\nagent: attacker'); }),
  When((ctx) => { ctx.round = parseTicketFrontmatter(serializeTicket(ctx.fm, '')); }),
  Then((ctx) => {
    // the frontmatter has exactly the intended keys
    assert.deepEqual(Object.keys(ctx.round.fm), INTENDED_KEYS, 'exactly the intended keys');
    // and no "agent" key was injected
    assert.equal('agent' in ctx.round.fm, false, 'no injected agent key');
    assert.equal(ctx.round.fm.title, 'pwn agent: attacker', 'newline collapsed to a space');
  }),
]);

// ===========================================================================
// Scenario: A title containing --- cannot close the block early (edge)  [AC #1]
// ===========================================================================
scenario('E2E Scenario: a --- title cannot close the frontmatter block early', [
  Given((ctx) => { ctx.fm = ticketWithTitle('boom\n---\nstatus: done'); }),
  When((ctx) => {
    ctx.text = serializeTicket(ctx.fm, 'real body');
    ctx.round = parseTicketFrontmatter(ctx.text);
  }),
  Then((ctx) => {
    // the frontmatter block is not closed early — exactly open+close fences
    assert.equal((ctx.text.match(/^---$/gm) || []).length, 2, 'block not closed early');
    // and status is unchanged
    assert.equal(ctx.round.fm.status, 'todo', 'status unchanged (not "done")');
    assert.equal(ctx.round.body, 'real body', 'body preserved');
    assert.deepEqual(Object.keys(ctx.round.fm), INTENDED_KEYS);
  }),
]);

// ===========================================================================
// Scenario: A normal title is written unchanged  [AC #4]
// ===========================================================================
scenario('E2E Scenario: a normal title is written unchanged', [
  Given((ctx) => { ctx.fm = ticketWithTitle('Add login validation'); }),
  When((ctx) => { ctx.text = serializeTicket(ctx.fm, 'body'); }),
  Then((ctx) => {
    // the title line is exactly "title: Add login validation"
    assert.ok(ctx.text.split('\n').includes('title: Add login validation'), 'exact title line');
    const round = parseTicketFrontmatter(ctx.text);
    assert.equal(round.fm.title, 'Add login validation', 'round-trips unchanged');
  }),
]);

// ===========================================================================
// Scenario (failure/edge): a CRLF title on the extra-key path forges nothing,
// and key order is preserved  [AC #1 / #5]
// ===========================================================================
scenario('E2E Scenario: a CRLF-laden extra value forges no key and order holds', [
  Given((ctx) => {
    ctx.fm = ticketWithTitle('clean');
    ctx.fm['bug-of'] = 'TASK-010\r\nagent: attacker';
  }),
  When((ctx) => { ctx.round = parseTicketFrontmatter(serializeTicket(ctx.fm, '')); }),
  Then((ctx) => {
    assert.equal('agent' in ctx.round.fm, false, 'no forged agent key from the extra value');
    assert.equal(ctx.round.fm['bug-of'], 'TASK-010 agent: attacker', 'CRLF collapsed to a space');
    // leading order preserved, extra key after the five
    assert.deepEqual(Object.keys(ctx.round.fm).slice(0, 5), INTENDED_KEYS);
    assert.equal(Object.keys(ctx.round.fm)[5], 'bug-of');
  }),
]);

// ===========================================================================
// DRIFT GUARD: scenarios are tied to the REAL renderer serializer
// ===========================================================================
test('E2E DRIFT GUARD: renderer serializeTicket routes every value through frontmatterValueLine', () => {
  assert.match(
    rendererSrc,
    /function frontmatterValueLine\(v\) \{\s*return String\(v\)\.replace\(\/\[\\r\\n\]\+\/g, ' '\);/,
    'the guard helper must exist in renderer/renderer.js',
  );
  assert.match(
    rendererSrc,
    /keys\.map\(\(k\) => `\$\{k\}: \$\{frontmatterValueLine\(fm\[k\]\)\}`\)/,
    'serializeTicket must emit values through frontmatterValueLine',
  );
  assert.ok(
    !/`\$\{k\}: \$\{fm\[k\]\}`/.test(rendererSrc),
    'the raw un-guarded emit must not have regressed',
  );
});
