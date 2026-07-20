'use strict';

// Unit + drift-guard tests for TASK-071: humanizeSlackOutput(text) — a pure,
// Electron-free readability pass applied to auto-posted Claude terminal output
// BETWEEN cleanTerminalOutput and redactSecrets. Mechanical cleanup only:
//   - collapse consecutive identical lines (TUI redraw dedupe),
//   - drop WHOLE Claude-TUI noise lines (spinner "…ing…" progress lines,
//     standalone "(esc to interrupt)" hints, standalone elapsed/token counters,
//     ⏵/⏵⏵ mode-hint lines) — matched against the TRIMMED line so a mid-line
//     glyph in real content is never stripped,
//   - collapse 2+ blank-line runs to a single blank line, trim outer whitespace,
//   - never throws: non-string / null / undefined / numeric → ''.
//
// Layers (mirroring test/slack-redaction.test.js / test/slack-defang.test.js):
//   1. lib/slack-proxy.js — the pure helper, tested directly (no DOM/Electron).
//   2. renderer/renderer.js — the browser mirror proven byte-identical + sync note.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { humanizeSlackOutput } = require('../lib/slack-proxy');

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
// PART 1 — Unit: consecutive-duplicate collapse (TUI redraw dedupe)
// ===========================================================================

test('humanize: consecutive identical lines collapse to one', () => {
  const input = Array(5).fill('Running tests...').join('\n');
  assert.equal(humanizeSlackOutput(input), 'Running tests...');
});

test('humanize: only CONSECUTIVE duplicates collapse; non-adjacent repeats survive', () => {
  const input = 'A\nA\nB\nA\nA';
  assert.equal(humanizeSlackOutput(input), 'A\nB\nA');
});

test('humanize: intentionally repeated real content is collapsed by design', () => {
  const input = 'log line\nlog line\nlog line';
  assert.equal(humanizeSlackOutput(input), 'log line');
});

// ===========================================================================
// PART 2 — Unit: each noise-line class is dropped as a WHOLE line
// ===========================================================================

test('humanize: spinner "…ing…" progress lines are dropped (… and ... forms)', () => {
  assert.equal(humanizeSlackOutput('✻ Thinking… (esc to interrupt)'), '');
  assert.equal(humanizeSlackOutput('· Compiling...'), '');
  assert.equal(humanizeSlackOutput('✽ Reticulating…'), '');
});

test('humanize: standalone "(esc to interrupt)" hint line is dropped', () => {
  assert.equal(humanizeSlackOutput('(esc to interrupt)'), '');
  assert.equal(humanizeSlackOutput('esc to interrupt'), '');
});

test('humanize: standalone elapsed / token counter lines are dropped', () => {
  assert.equal(humanizeSlackOutput('12s'), '');
  assert.equal(humanizeSlackOutput('↑ 1.2k tokens'), '');
  assert.equal(humanizeSlackOutput('5s · 234 tokens'), '');
});

test('humanize: ⏵ / ⏵⏵ mode-hint lines are dropped', () => {
  assert.equal(humanizeSlackOutput('⏵⏵ accept edits on (shift+tab to cycle)'), '');
  assert.equal(humanizeSlackOutput('⏵ auto-accept edits'), '');
});

test('humanize: spinner/status noise between two real lines is removed, content kept', () => {
  const input = 'Compiling project\n✻ Thinking… (esc to interrupt)\nBuild succeeded';
  assert.equal(humanizeSlackOutput(input), 'Compiling project\nBuild succeeded');
});

// ===========================================================================
// PART 3 — Unit: blank-run collapse + outer trim
// ===========================================================================

test('humanize: runs of 2+ blank lines collapse to a single blank line', () => {
  assert.equal(humanizeSlackOutput('para one\n\n\n\npara two'), 'para one\n\npara two');
});

test('humanize: outer whitespace is trimmed', () => {
  assert.equal(humanizeSlackOutput('\n\n  hello world  \n\n'), 'hello world');
});

test('humanize: tolerates raw \\r\\n line endings', () => {
  assert.equal(humanizeSlackOutput('one\r\none\r\ntwo'), 'one\ntwo');
});

// ===========================================================================
// PART 4 — Unit: no false-positive deletion of real content
// ===========================================================================

test('humanize: ordinary output passes through unchanged', () => {
  const input = 'Build succeeded in 12s\n40 files compiled';
  assert.equal(humanizeSlackOutput(input), input);
});

test('humanize: a mid-line glyph in real content is preserved (only whole noise lines drop)', () => {
  const input = 'The star ✻ marks the spot';
  assert.equal(humanizeSlackOutput(input), input);
});

test('humanize: real lines that merely resemble noise mid-sentence are preserved', () => {
  const samples = [
    'processing',                                  // gerund, no leading glyph
    'press esc to interrupt the running build',    // "esc to interrupt" not standalone
    'we saved 12s by caching the build artifacts', // counter phrase mid-line
    'function add(a, b) { return a + b; }',
    'edited renderer/renderer.js and lib/slack-proxy.js',
  ];
  for (const s of samples) {
    assert.equal(humanizeSlackOutput(s), s, `unchanged: ${s}`);
  }
});

// ===========================================================================
// PART 5 — Unit: null / junk input is safe (never throws, returns '')
// ===========================================================================

test('humanize: empty / null / undefined / non-string → "" and never throws', () => {
  for (const v of ['', null, undefined, 12345, {}, []]) {
    assert.doesNotThrow(() => humanizeSlackOutput(v));
    assert.equal(humanizeSlackOutput(v), '', `"" for ${String(v)}`);
    assert.equal(typeof humanizeSlackOutput(v), 'string', 'always returns a string');
  }
});

test('humanize: a pure-noise buffer humanizes to the empty string', () => {
  const noise = [
    '✻ Thinking… (esc to interrupt)',
    '(esc to interrupt)',
    '↑ 1.2k tokens',
    '⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(humanizeSlackOutput(noise), '');
});

// ===========================================================================
// PART 6 — lib export purity + renderer mirror byte-identity (drift guard)
// ===========================================================================

test('lib/slack-proxy.js exports humanizeSlackOutput and stays pure (no require/import)', () => {
  assert.match(libSrc, /module\.exports\s*=\s*\{[^}]*\bhumanizeSlackOutput\b[^}]*\}/);
  assert.ok(!/\brequire\s*\(/.test(libSrc), 'lib requires nothing');
  assert.ok(!/\bimport\s/.test(libSrc), 'lib imports nothing');
});

test('renderer mirror humanizeSlackOutput is byte-identical to the lib helper + sync note', () => {
  const libFn = fnBody(libSrc, 'function humanizeSlackOutput(text)');
  const rendererFn = fnBody(rendererSrc, 'function humanizeSlackOutput(text)');
  assert.equal(rendererFn, libFn, 'renderer mirror must match lib verbatim');
  const idx = rendererSrc.indexOf('function humanizeSlackOutput(text)');
  const preamble = rendererSrc.slice(idx - 200, idx);
  assert.match(preamble, /Mirrors humanizeSlackOutput in lib\/slack-proxy\.js; keep in sync/);
});
