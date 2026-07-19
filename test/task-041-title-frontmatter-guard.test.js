'use strict';

// ===========================================================================
// TASK-041 — UNIT tests: guard ticket frontmatter VALUES against newline /
// `---` injection before serialization.
//
// serializeTicket now runs every frontmatter VALUE through a tiny pure guard
// frontmatterValueLine(v) = String(v).replace(/[\r\n]+/g, ' ') so a title (or
// any value) carrying \n/\r/\r\n is collapsed to a single physical line and can
// no longer forge extra `key: value` frontmatter lines or a premature `---`
// close. Normal single-line values are byte-unchanged.
//
// serializeTicket / parseTicketFrontmatter live ONLY in renderer/renderer.js
// (a browser script that cannot be require()'d), so they are copied VERBATIM
// below WITH the new guard, and a SOURCE-SCAN drift guard ties the copies back
// to the real source (asserts the guard is present at the emit point).
//
// NO DATABASE. NO DISK. NO NETWORK. Every helper is pure/in-memory.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// VERBATIM copies of the renderer's whole-file guard/serializer/parser (browser
// script — not requireable). The drift guards at the bottom tie these to source.
// ---------------------------------------------------------------------------
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

const TS = '2026-07-19T10:00:00.000Z';
function baseFm(overrides) {
  return Object.assign(
    { id: 'TASK-060', title: 'x', status: 'todo', created: TS, updated: TS },
    overrides || {},
  );
}

// ===========================================================================
// UNIT: newline-laden title cannot inject a frontmatter key
// ===========================================================================
test('UNIT: a newline+"agent: attacker" title injects NO extra key and collapses to one line', () => {
  const fm = baseFm({ title: 'pwn\nagent: attacker' });
  const round = parseTicketFrontmatter(serializeTicket(fm, ''));
  assert.ok(round, 're-parses');
  // Exactly the intended keys — no injected `agent`.
  assert.deepEqual(Object.keys(round.fm), ['id', 'title', 'status', 'created', 'updated']);
  assert.equal('agent' in round.fm, false, 'no forged agent key');
  // Newline collapsed to a single space.
  assert.equal(round.fm.title, 'pwn agent: attacker');
  assert.equal(round.fm.status, 'todo');
});

// ===========================================================================
// UNIT: a title containing --- cannot close the frontmatter block early
// ===========================================================================
test('UNIT: a "boom\\n---\\nstatus: done" title cannot close the block early; status unchanged; body intact', () => {
  const fm = baseFm({ title: 'boom\n---\nstatus: done' });
  const text = serializeTicket(fm, 'real body');
  const round = parseTicketFrontmatter(text);
  assert.ok(round, 're-parses');
  // The block closed only at the REAL trailing --- — status stays the intended value.
  assert.equal(round.fm.status, 'todo', 'status not overwritten to done');
  assert.equal(round.body, 'real body', 'body preserved verbatim');
  // The embedded --- was collapsed into the title line, not emitted as its own line.
  assert.equal(round.fm.title, 'boom --- status: done');
  // There are exactly TWO `---` fences in the whole document (open + close).
  assert.equal((text.match(/^---$/gm) || []).length, 2, 'no premature --- fence injected');
  assert.deepEqual(Object.keys(round.fm), ['id', 'title', 'status', 'created', 'updated']);
});

// ===========================================================================
// UNIT: normal single-line title is byte-unchanged
// ===========================================================================
test('UNIT: a normal title emits the exact line "title: Add login validation" and round-trips unchanged', () => {
  const fm = baseFm({ title: 'Add login validation' });
  const text = serializeTicket(fm, 'body');
  assert.ok(text.split('\n').includes('title: Add login validation'), 'exact title line present');
  const round = parseTicketFrontmatter(text);
  assert.equal(round.fm.title, 'Add login validation', 'unchanged after round-trip');
  assert.equal(round.body, 'body');
});

// ===========================================================================
// UNIT: \r, \r\n and multiple-newline variants all collapse
// ===========================================================================
test('UNIT: \\r, \\r\\n and runs of newlines each collapse to a SINGLE space', () => {
  assert.equal(frontmatterValueLine('a\rb'), 'a b', 'CR collapses');
  assert.equal(frontmatterValueLine('a\r\nb'), 'a b', 'CRLF collapses to one space');
  assert.equal(frontmatterValueLine('a\n\n\nb'), 'a b', 'run of LF collapses to one space (regex +)');
  assert.equal(frontmatterValueLine('a\r\n\r\nb'), 'a b', 'run of CRLF collapses to one space');
  assert.equal(frontmatterValueLine('no newlines'), 'no newlines', 'clean value byte-unchanged');
  // Through the full serialize→parse round-trip with a CRLF title.
  const round = parseTicketFrontmatter(serializeTicket(baseFm({ title: 'x\r\ninjected: y' }), ''));
  assert.equal('injected' in round.fm, false, 'no forged key via CRLF');
  assert.equal(round.fm.title, 'x injected: y');
});

// ===========================================================================
// UNIT: the guard applies to EVERY value, not just title (extra key)
// ===========================================================================
test('UNIT: an EXTRA key value with an embedded newline forges no key either', () => {
  const fm = baseFm({ 'bug-of': 'TASK-010\nagent: x' });
  const round = parseTicketFrontmatter(serializeTicket(fm, ''));
  assert.equal('agent' in round.fm, false, 'no forged agent key from an extra value');
  assert.equal(round.fm['bug-of'], 'TASK-010 agent: x', 'extra value newline collapsed');
});

// ===========================================================================
// UNIT: key ORDER preserved (leading five, then extras)
// ===========================================================================
test('UNIT: leading key order (id,title,status,created,updated) then extras is preserved', () => {
  const fm = baseFm({ title: 'clean', agent: 'swarm', 'bug-of': 'TASK-010' });
  const round = parseTicketFrontmatter(serializeTicket(fm, ''));
  assert.deepEqual(Object.keys(round.fm).slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.equal(Object.keys(round.fm)[5], 'agent');
  assert.equal(Object.keys(round.fm)[6], 'bug-of');
});

// ===========================================================================
// DRIFT GUARD: the real renderer serializer runs values through the guard
// ===========================================================================
test('DRIFT GUARD: renderer serializeTicket emits values via the newline guard (not raw ${fm[k]})', () => {
  // The guard helper exists in source.
  assert.match(
    rendererSrc,
    /function frontmatterValueLine\(v\) \{\s*return String\(v\)\.replace\(\/\[\\r\\n\]\+\/g, ' '\);/,
    'frontmatterValueLine must exist and collapse CR/LF runs to a space',
  );
  // The emit point uses the guard, not a raw interpolation.
  assert.match(
    rendererSrc,
    /const fmLines = keys\.map\(\(k\) => `\$\{k\}: \$\{frontmatterValueLine\(fm\[k\]\)\}`\);/,
    'serializeTicket must emit `${k}: ${frontmatterValueLine(fm[k])}` (guarded), not raw ${fm[k]}',
  );
  // Belt-and-braces: the raw un-guarded emit must NOT be present.
  assert.ok(
    !/`\$\{k\}: \$\{fm\[k\]\}`/.test(rendererSrc),
    'the raw un-guarded `${k}: ${fm[k]}` emit must not have regressed back',
  );
  // Leading key order the copy relies on.
  assert.match(
    rendererSrc,
    /const order = \['id', 'title', 'status', 'created', 'updated'\];/,
    'leading key order must match the verbatim copy',
  );
});
