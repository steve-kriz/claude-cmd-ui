'use strict';

// Unit + source-scan tests for TASK-064: neutralize ("defang") Slack broadcast/
// mention CONTROL SEQUENCES in app-posted command / failure replies before they
// reach Slack chat.postMessage. Slack honors already-encoded control forms
// (<!channel>, <!here>, <@U…>, …) inside message text, so a crafted Slack
// message or ticket title echoed back by a command/error reply could induce a
// channel-wide ping. defangSlackControlSequences(text) breaks the leading `<`
// of a control token into `&lt;` so it renders inertly.
//
// DISTINCT from TASK-063 (redactSecrets): that masks secrets in Claude terminal
// output; this defangs Slack mention/broadcast markup in command/error replies.
//
// Layers (mirroring test/slack-redaction.test.js):
//   1. lib/slack-proxy.js — the pure, Electron-free helper, tested directly.
//   2. renderer/renderer.js — the browser mirror proven byte-identical + sync note.
//   3. Source-scan proving handleSlackCommand defangs BOTH the handler reply AND
//      the "Command failed:" string, and that the composer / Claude-output post
//      paths are NOT defanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { defangSlackControlSequences } = require('../lib/slack-proxy');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const LIB = path.join(__dirname, '..', 'lib', 'slack-proxy.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');
const libSrc = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

// ===========================================================================
// PART 1 — Unit: each control sequence is defanged (rendered inert)
// ===========================================================================

test('defang: <!channel> broadcast is neutralized', () => {
  const out = defangSlackControlSequences('Heads up <!channel> please');
  assert.equal(out, 'Heads up &lt;!channel> please');
  assert.ok(!/<!channel>/.test(out), 'live <!channel> trigger is gone');
});

test('defang: <!here> and <!everyone> broadcasts are neutralized', () => {
  assert.equal(defangSlackControlSequences('ping <!here>'), 'ping &lt;!here>');
  assert.equal(defangSlackControlSequences('ping <!everyone>'), 'ping &lt;!everyone>');
});

test('defang: <!subteam^ID> user-group ping is neutralized', () => {
  const out = defangSlackControlSequences('cc <!subteam^S123|team>');
  assert.equal(out, 'cc &lt;!subteam^S123|team>');
  assert.ok(!/<!subteam/.test(out));
});

test('defang: <@U…> user link is neutralized', () => {
  assert.equal(defangSlackControlSequences('hi <@U012ABC>'), 'hi &lt;@U012ABC>');
  assert.equal(defangSlackControlSequences('hi <@U012ABC|name>'), 'hi &lt;@U012ABC|name>');
});

test('defang: <#C…> channel link is neutralized', () => {
  assert.equal(defangSlackControlSequences('see <#C0FMT>'), 'see &lt;#C0FMT>');
  assert.equal(defangSlackControlSequences('see <#C0FMT|general>'), 'see &lt;#C0FMT|general>');
});

test('defang: multiple control sequences in one string are all neutralized', () => {
  const input = 'ticket "Do <!channel>" failed for <@U9> in <#C1>';
  const out = defangSlackControlSequences(input);
  assert.ok(!/<!channel>/.test(out) && !/<@U9>/.test(out) && !/<#C1>/.test(out));
  assert.equal(out, 'ticket "Do &lt;!channel>" failed for &lt;@U9> in &lt;#C1>');
});

// ===========================================================================
// PART 2 — Unit: ordinary text stays readable (no false positives)
// ===========================================================================

test('defang: a lone `<` in prose is untouched', () => {
  assert.equal(defangSlackControlSequences('if a < b then'), 'if a < b then');
  assert.equal(defangSlackControlSequences('x <= y and 3 < 4'), 'x <= y and 3 < 4');
});

test('defang: code-like generics / tags are untouched', () => {
  const samples = [
    'List<int> and Map<String,Object>',
    'const el = <div>hello</div>;', // `<d` is not a control opener
    'edited renderer/renderer.js',
    'Command failed: could not read ticket',
    'All tasks are complete.',
  ];
  for (const s of samples) {
    assert.equal(defangSlackControlSequences(s), s, `unchanged: ${s}`);
  }
});

test('defang: an unterminated `<!` (no closing `>`) is left alone', () => {
  // Conservative: only complete <…> tokens are defanged, so stray prose stays put.
  assert.equal(defangSlackControlSequences('less than <! important note'),
    'less than <! important note');
});

// ===========================================================================
// PART 3 — Unit: empty / null / non-string is safe (never throws)
// ===========================================================================

test('defang: empty / null / undefined / non-string → safe, never throws', () => {
  assert.equal(defangSlackControlSequences(''), '');
  assert.equal(defangSlackControlSequences(null), '');
  assert.equal(defangSlackControlSequences(undefined), '');
  assert.equal(defangSlackControlSequences(12345), '');
  assert.equal(defangSlackControlSequences({}), '');
  assert.equal(defangSlackControlSequences([]), '');
});

// ===========================================================================
// PART 4 — lib export + renderer mirror byte-identity
// ===========================================================================

test('lib/slack-proxy.js exports defangSlackControlSequences and stays pure', () => {
  assert.match(libSrc, /module\.exports\s*=\s*\{[^}]*\bdefangSlackControlSequences\b[^}]*\}/);
  assert.ok(!/\brequire\s*\(/.test(libSrc), 'lib requires nothing');
  assert.ok(!/\bimport\s/.test(libSrc), 'lib imports nothing');
});

test('renderer mirror defangSlackControlSequences is byte-identical + carries the sync note', () => {
  const libFn = fnBody(libSrc, 'function defangSlackControlSequences(text)');
  const rendererFn = fnBody(rendererSrc, 'function defangSlackControlSequences(text)');
  assert.equal(rendererFn, libFn, 'renderer mirror must match lib verbatim');
  const idx = rendererSrc.indexOf('function defangSlackControlSequences(text)');
  const preamble = rendererSrc.slice(idx - 500, idx);
  assert.match(preamble, /Mirrors defangSlackControlSequences in lib\/slack-proxy\.js; keep in sync/);
});

// ===========================================================================
// PART 5 — Source-scan: handleSlackCommand defangs BOTH the reply AND the
// failure text; the composer / Claude-output paths are NOT defanged.
// ===========================================================================

test('handleSlackCommand defangs the handler reply text before posting', () => {
  const body = fnBody(rendererSrc, 'async function handleSlackCommand(tab, matched, msg)');
  // The awaited handler result is wrapped in defang before it is used/posted.
  assert.match(body, /defangSlackControlSequences\(await handler\(tab, msg\)\)/);
  assert.match(body, /postToSlack\(tab,\s*replyText,\s*s\.threadTs\)/);
});

test('handleSlackCommand defangs the "Command failed:" string before posting', () => {
  const body = fnBody(rendererSrc, 'async function handleSlackCommand(tab, matched, msg)');
  assert.match(body, /postToSlack\(tab,\s*defangSlackControlSequences\('Command failed: ' \+ detail\),\s*s\.threadTs\)/);
});

test('both handleSlackCommand post paths are wrapped in defang (no bypass)', () => {
  const body = fnBody(rendererSrc, 'async function handleSlackCommand(tab, matched, msg)');
  const defangUses = [...body.matchAll(/defangSlackControlSequences\(/g)];
  assert.equal(defangUses.length, 2, 'exactly the reply + failure paths are defanged');
});

test('sendSlackComposer (user-composed) is NOT defanged — scope is command/error replies', () => {
  const body = fnBody(rendererSrc, 'function sendSlackComposer(tab)');
  assert.ok(!/defangSlackControlSequences/.test(body), 'user-composed messages posted as typed');
});

test('Claude-output post paths (slackFlushTick / slackOnFinished) are NOT defanged', () => {
  const flush = fnBody(rendererSrc, 'async function slackFlushTick(tab)');
  const finished = fnBody(rendererSrc, 'function slackOnFinished(tab)');
  assert.ok(!/defangSlackControlSequences/.test(flush), 'flush path untouched');
  assert.ok(!/defangSlackControlSequences/.test(finished), 'finished path untouched');
});
