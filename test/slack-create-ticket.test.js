'use strict';

// Unit tests for TASK-072: create a ticket from a Slack anchor-thread reply.
//
// Two layers (mirroring the other slack-*.test.js files):
//
//   1. parseCreateTicketReply(text) — the PURE parser exported from
//      lib/slack-commands.js — is exercised directly against every locked-in
//      rule and edge case: case-insensitive `title:`/`description:` labels in
//      either order, comma/newline-preceded field boundaries, first-label-wins
//      (an inner `description:` that is NOT a boundary stays inside the title),
//      multiline/comma-tolerant descriptions, required non-empty title,
//      missing/empty description → default, and non-string/junk → { ok:false }
//      without ever throwing.
//
//   2. Registry + drift guards — the `create-ticket` entry is present in the lib
//      DEFAULT_COMMANDS, and the renderer mirror is byte-identical for BOTH the
//      `parseCreateTicketReply` function body and the `create-ticket` registry
//      entry (renderer.js is a browser script, so we source-scan it — the same
//      fnBody/source-extraction approach as test/slack-defang.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_COMMANDS, parseCreateTicketReply } = require('../lib/slack-commands');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const LIB = path.join(__dirname, '..', 'lib', 'slack-commands.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');
const libSrc = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

// Extract a whole function INCLUDING its closing brace (up to the first
// column-0 `\n}`), so a browser-only helper's source can be compared against a
// local verbatim mirror's `.toString()` (which includes the closing brace).
function fnFull(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}');
  assert.ok(end !== -1, `${decl} body closes`);
  return from.slice(0, end + 2);
}

// Verbatim mirror of decodeSlackText (renderer/renderer.js ~8667). In the real
// renderer, handleIncomingSlackMessage runs THIS on the incoming reply BEFORE it
// reaches parseCreateTicketReply, so the parser only ever sees UNWRAPPED text.
// We mirror it here (kept byte-identical to renderer.js by the guard below) and
// feed its output into the parser to prove the documented "parser tolerates
// decoded auto-linked text" edge (TASK-076).
function decodeSlackText(t) {
  return String(t)
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<@([^>]+)>/g, '@$1')
    .replace(/<#[^|>]+\|([^>]+)>/g, '#$1')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// Extract the `create-ticket` registry entry block (from its `name:` line up to
// and including the closing `],` of its patterns) so lib + renderer can be
// compared byte-for-byte regardless of surrounding formatting.
function createTicketEntryBlock(src) {
  // Anchor on the registry entry (trailing comma) so a comment mention like
  // `{ name: 'create-ticket' }` in renderer.js is not matched instead.
  const i = src.indexOf("name: 'create-ticket',");
  assert.ok(i !== -1, "create-ticket entry present");
  const from = src.slice(i);
  const end = from.indexOf('],');
  assert.ok(end !== -1, 'patterns array closes');
  return from.slice(0, end + 2);
}

// ===========================================================================
// PART 1 — parseCreateTicketReply: happy shapes
// ===========================================================================

test('parse: title + description, in order', () => {
  const r = parseCreateTicketReply('title: Fix login flow, description: The login button does nothing on mobile');
  assert.deepEqual(r, { ok: true, title: 'Fix login flow', description: 'The login button does nothing on mobile' });
});

test('parse: labels in EITHER order (description first)', () => {
  const r = parseCreateTicketReply('description: The button does nothing, title: Fix login flow');
  assert.deepEqual(r, { ok: true, title: 'Fix login flow', description: 'The button does nothing' });
});

test('parse: labels are case-insensitive', () => {
  const r = parseCreateTicketReply('TITLE: Fix it, DESCRIPTION: because reasons');
  assert.deepEqual(r, { ok: true, title: 'Fix it', description: 'because reasons' });
  const mixed = parseCreateTicketReply('Title: A, Description: B');
  assert.deepEqual(mixed, { ok: true, title: 'A', description: 'B' });
});

test('parse: a description containing commas is preserved whole', () => {
  const r = parseCreateTicketReply('title: T, description: a, b, and c');
  assert.deepEqual(r, { ok: true, title: 'T', description: 'a, b, and c' });
});

test('parse: a multiline description keeps its newlines', () => {
  const r = parseCreateTicketReply('title: Multi, description: line one\nline two\nline three');
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Multi');
  assert.equal(r.description, 'line one\nline two\nline three');
});

test('parse: newline (not just comma) separates fields', () => {
  const r = parseCreateTicketReply('title: Fix it\ndescription: some detail');
  assert.deepEqual(r, { ok: true, title: 'Fix it', description: 'some detail' });
});

// ===========================================================================
// PART 2 — first-label-wins & boundary rules
// ===========================================================================

test('parse: first-label-wins — inner mid-sentence "description:" stays in the title', () => {
  // The second `description:` is preceded by a space (not a comma/newline), so it
  // is NOT a field boundary — it stays literal text inside the title, and the
  // missing real description falls back to the default.
  const r = parseCreateTicketReply('title: Add a description: field to the form');
  assert.deepEqual(r, { ok: true, title: 'Add a description: field to the form', description: 'What needs doing and why.' });
});

test('parse: first boundary-occurrence of a repeated label wins', () => {
  const r = parseCreateTicketReply('title: first, title: second');
  assert.equal(r.ok, true);
  assert.equal(r.title, 'first');
});

test('parse: a mid-sentence label is literal unless comma/newline-preceded', () => {
  // No leading `title:`/`description:` boundary at all → no fields → not ok.
  const r = parseCreateTicketReply('please create a title: something ticket');
  assert.equal(r.ok, false);
});

// ===========================================================================
// PART 3 — title required; description defaulting
// ===========================================================================

test('parse: missing description falls back to the default', () => {
  const r = parseCreateTicketReply('title: Only a title here');
  assert.deepEqual(r, { ok: true, title: 'Only a title here', description: 'What needs doing and why.' });
});

test('parse: empty/whitespace-only description falls back to the default', () => {
  const r = parseCreateTicketReply('title: Has title, description:    ');
  assert.deepEqual(r, { ok: true, title: 'Has title', description: 'What needs doing and why.' });
});

test('parse: missing title → { ok:false } (never a blank ticket)', () => {
  const r = parseCreateTicketReply('description: a description without a title');
  assert.equal(r.ok, false);
});

test('parse: whitespace-only title → { ok:false }', () => {
  const r = parseCreateTicketReply('title:    , description: something');
  assert.equal(r.ok, false);
});

// ===========================================================================
// PART 4 — non-string / junk → { ok:false }; never throws
// ===========================================================================

test('parse: non-string / null / junk inputs → { ok:false } and never throw', () => {
  for (const bad of [null, undefined, 42, {}, [], true, NaN, Symbol('x')]) {
    let r;
    assert.doesNotThrow(() => { r = parseCreateTicketReply(bad); });
    assert.equal(r.ok, false, `input ${String(bad)} rejected`);
  }
});

test('parse: junk string with no labels → { ok:false }', () => {
  assert.equal(parseCreateTicketReply('just some random text').ok, false);
  assert.equal(parseCreateTicketReply('').ok, false);
  assert.equal(parseCreateTicketReply('   \n  ').ok, false);
});

// ===========================================================================
// PART 5 — registry entry present in DEFAULT_COMMANDS
// ===========================================================================

test('DEFAULT_COMMANDS carries the create-ticket entry with all patterns', () => {
  const entry = DEFAULT_COMMANDS.find((c) => c.name === 'create-ticket');
  assert.ok(entry, 'create-ticket entry present');
  assert.equal(entry.description, 'Create a new ticket on the tasks board');
  assert.deepEqual(entry.patterns, ['create ticket', 'create a ticket', 'new ticket', 'add ticket']);
});

// ===========================================================================
// PART 6 — byte-identical mirror drift guards (lib ↔ renderer)
// ===========================================================================

test('renderer mirror of parseCreateTicketReply is byte-identical + carries the sync note', () => {
  const libFn = fnBody(libSrc, 'function parseCreateTicketReply(text)');
  const rendererFn = fnBody(rendererSrc, 'function parseCreateTicketReply(text)');
  assert.equal(rendererFn, libFn, 'renderer parseCreateTicketReply must match lib verbatim');
  const idx = rendererSrc.indexOf('function parseCreateTicketReply(text)');
  const preamble = rendererSrc.slice(idx - 600, idx);
  assert.match(preamble, /Mirrors parseCreateTicketReply in lib\/slack-commands\.js; keep in sync/);
});

test('renderer mirror of the create-ticket registry entry is byte-identical to lib', () => {
  assert.equal(createTicketEntryBlock(rendererSrc), createTicketEntryBlock(libSrc),
    'the create-ticket registry entry must match between renderer and lib');
});

// ===========================================================================
// PART 7 — TASK-076: decodeSlackText → parser interaction
//
// The renderer decodes Slack auto-links/mentions (<http://x|x>, <@U1>, <#C1|c>,
// &amp; …) BEFORE parseCreateTicketReply ever sees the text. These tests drive
// realistic Slack-encoded replies through the byte-identical decode mirror and
// then into the REAL lib parser, asserting the parser tolerates the decoded
// (unwrapped) output, produces the expected title/description, and never throws
// — including decoded text that still carries commas/newlines.
// ===========================================================================

test('decode mirror is byte-identical to renderer.js decodeSlackText (drift guard)', () => {
  const rendererFn = fnFull(rendererSrc, 'function decodeSlackText(t)');
  const localFn = decodeSlackText.toString().replace(/\r\n/g, '\n');
  assert.equal(localFn, rendererFn,
    'the local decodeSlackText mirror must match renderer.js verbatim');
});

test('decode+parse: an auto-linked title/description is unwrapped, then parses cleanly', () => {
  const raw = 'title: See <http://example.com|example.com>, description: ping <@U123>';
  const decoded = decodeSlackText(raw);
  assert.equal(decoded, 'title: See example.com, description: ping @U123',
    'link is unwrapped to its label and <@U123> becomes @U123');
  let r;
  assert.doesNotThrow(() => { r = parseCreateTicketReply(decoded); });
  assert.deepEqual(r, { ok: true, title: 'See example.com', description: 'ping @U123' });
});

test('decode+parse: a bare <http://…> link (no label) is unwrapped before parsing', () => {
  const decoded = decodeSlackText('title: Visit <https://example.com/docs>');
  assert.equal(decoded, 'title: Visit https://example.com/docs');
  assert.deepEqual(parseCreateTicketReply(decoded),
    { ok: true, title: 'Visit https://example.com/docs', description: 'What needs doing and why.' });
});

test('decode+parse: a decoded description keeps commas per first-label-wins rules', () => {
  const raw = 'title: Docs, description: see <http://a.com|a.com>, <http://b.com|b.com> and &amp; more';
  const decoded = decodeSlackText(raw);
  assert.equal(decoded, 'title: Docs, description: see a.com, b.com and & more');
  let r;
  assert.doesNotThrow(() => { r = parseCreateTicketReply(decoded); });
  // The comma inside the description is NOT a field boundary (no title:/description:
  // follows it), so the whole decoded description survives intact.
  assert.deepEqual(r, { ok: true, title: 'Docs', description: 'see a.com, b.com and & more' });
});

test('decode+parse: a decoded multiline description keeps its newlines and parses', () => {
  const raw = 'title: Multi, description: line one\nsee <http://x|x>\nline three';
  const decoded = decodeSlackText(raw);
  const r = parseCreateTicketReply(decoded);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Multi');
  assert.equal(r.description, 'line one\nsee x\nline three');
});

test('decode+parse: a labelled channel mention in the title is unwrapped and never throws', () => {
  // The leading `<X|Y>` rule unwraps any labelled token to its label, so a
  // channel mention `<#C0FMT|general>` collapses to its label `general`.
  const decoded = decodeSlackText('title: Post to <#C0FMT|general>');
  assert.equal(decoded, 'title: Post to general');
  let r;
  assert.doesNotThrow(() => { r = parseCreateTicketReply(decoded); });
  assert.deepEqual(r, { ok: true, title: 'Post to general', description: 'What needs doing and why.' });
});
