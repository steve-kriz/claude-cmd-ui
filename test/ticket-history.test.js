'use strict';

// Unit tests for lib/ticket-history.js — the Electron-free helper the
// orchestrator uses to fold each coder/tester prompt+response into a ticket's
// `## History` section (TASK-002). The module is a pure function of a single
// markdown string and touches no disk/network, so it is exercised directly with
// plain `node --test`. No files are written by these tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendHistoryEntry,
  formatHistoryEntry,
  HISTORY_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-history');

// A representative ticket body with several user/system sections plus a
// user-owned `## Additional Context` at the tail. Used to prove verbatim
// preservation of everything the helper is not supposed to touch.
const SAMPLE = [
  '---',
  'id: TASK-100',
  'title: Sample',
  'status: in-progress',
  '---',
  '',
  '## Description',
  'Do the thing. Keep it discrete.',
  '',
  '## Acceptance Criteria',
  '- [ ] one',
  '- [ ] two',
  '',
  '## Additional Context',
  '(User-owned. Read it before building. Never overwrite it.)',
  'A user note with **markdown** and a trailing space.   ',
].join('\n');

// Pull the body of a named `## ` section out of a markdown string (everything
// from the heading up to but excluding the next `## ` heading or EOF). Lets us
// assert a section is byte-for-byte unchanged.
function sectionSlice(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('exports the expected heading constants', () => {
  assert.equal(HISTORY_HEADING, '## History');
  assert.equal(ADDITIONAL_CONTEXT_HEADING, '## Additional Context');
});

// ---------------------------------------------------------------------------
// formatHistoryEntry
// ---------------------------------------------------------------------------

test('formatHistoryEntry renders a role-labelled, timestamped entry with prompt+response blocks', () => {
  const lines = formatHistoryEntry({
    role: 'coder',
    prompt: 'do X',
    response: 'did X',
    timestamp: '2026-07-18T00:00:00.000Z',
  });
  assert.ok(Array.isArray(lines), 'returns an array of lines');
  assert.equal(lines[0], '### 2026-07-18T00:00:00.000Z — coder');
  const joined = lines.join('\n');
  assert.match(joined, /\*\*Prompt:\*\*/);
  assert.match(joined, /\*\*Response:\*\*/);
  assert.match(joined, /do X/);
  assert.match(joined, /did X/);
});

test('formatHistoryEntry defaults role to "agent" and timestamp to a valid ISO string', () => {
  const lines = formatHistoryEntry({ prompt: 'p', response: 'r' });
  // ### <ISO-8601> — agent
  assert.match(lines[0], /^### \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z — agent$/);
  // Parseable, non-NaN timestamp.
  const ts = lines[0].slice('### '.length).split(' — ')[0];
  assert.ok(!Number.isNaN(Date.parse(ts)), 'default timestamp parses as a date');
});

test('formatHistoryEntry tolerates a call with no arguments (all defaults, empty bodies)', () => {
  const lines = formatHistoryEntry();
  assert.match(lines[0], / — agent$/);
  assert.match(lines.join('\n'), /\*\*Prompt:\*\*/);
  assert.match(lines.join('\n'), /\*\*Response:\*\*/);
});

// ---------------------------------------------------------------------------
// appendHistoryEntry — content, labelling, timestamping
// ---------------------------------------------------------------------------

test('appended entry contains both the prompt and the response text', () => {
  const out = appendHistoryEntry(SAMPLE, {
    role: 'coder',
    prompt: 'PROMPT-TEXT-abc',
    response: 'RESPONSE-TEXT-xyz',
    timestamp: '2026-07-18T01:00:00.000Z',
  });
  assert.match(out, /PROMPT-TEXT-abc/);
  assert.match(out, /RESPONSE-TEXT-xyz/);
});

test('appended entry is timestamped and labelled with the role (tester)', () => {
  const out = appendHistoryEntry(SAMPLE, {
    role: 'tester',
    prompt: 'p',
    response: 'r',
    timestamp: '2026-07-18T02:30:00.000Z',
  });
  assert.match(out, /### 2026-07-18T02:30:00\.000Z — tester/);
});

test('role defaults to "agent" when omitted', () => {
  const out = appendHistoryEntry(SAMPLE, {
    prompt: 'p',
    response: 'r',
    timestamp: '2026-07-18T02:30:00.000Z',
  });
  assert.match(out, /### 2026-07-18T02:30:00\.000Z — agent/);
});

// ---------------------------------------------------------------------------
// appendHistoryEntry — chronological ordering (the key acceptance scenario)
// ---------------------------------------------------------------------------

test('two entries are appended in chronological order (second after first)', () => {
  const first = appendHistoryEntry(SAMPLE, {
    role: 'coder',
    prompt: 'first prompt',
    response: 'first response',
    timestamp: '2026-07-18T01:00:00.000Z',
  });
  const second = appendHistoryEntry(first, {
    role: 'tester',
    prompt: 'second prompt',
    response: 'second response',
    timestamp: '2026-07-18T02:00:00.000Z',
  });

  const firstIdx = second.indexOf('### 2026-07-18T01:00:00.000Z — coder');
  const secondIdx = second.indexOf('### 2026-07-18T02:00:00.000Z — tester');
  assert.ok(firstIdx !== -1, 'first entry retained');
  assert.ok(secondIdx !== -1, 'second entry present');
  assert.ok(firstIdx < secondIdx, 'the later entry is appended AFTER the earlier one');
});

test('appending twice keeps a single `## History` section (### headings are not section boundaries)', () => {
  let out = appendHistoryEntry(SAMPLE, { role: 'coder', prompt: 'a', response: 'b', timestamp: '2026-07-18T01:00:00.000Z' });
  out = appendHistoryEntry(out, { role: 'tester', prompt: 'c', response: 'd', timestamp: '2026-07-18T02:00:00.000Z' });
  const historyHeadings = out.split('\n').filter((l) => l.trim() === HISTORY_HEADING).length;
  assert.equal(historyHeadings, 1, 'exactly one `## History` heading after two appends');
});

// ---------------------------------------------------------------------------
// appendHistoryEntry — section creation & placement
// ---------------------------------------------------------------------------

test('creates `## History` BEFORE `## Additional Context` when absent', () => {
  const out = appendHistoryEntry(SAMPLE, { role: 'coder', prompt: 'p', response: 'r', timestamp: '2026-07-18T01:00:00.000Z' });
  const histIdx = out.indexOf(HISTORY_HEADING);
  const acIdx = out.indexOf(ADDITIONAL_CONTEXT_HEADING);
  assert.ok(histIdx !== -1, '`## History` created');
  assert.ok(acIdx !== -1, '`## Additional Context` retained');
  assert.ok(histIdx < acIdx, '`## History` sits before the user-owned `## Additional Context`');
});

test('appends `## History` at the end when there is no `## Additional Context`', () => {
  const noAC = ['## Description', 'hello', ''].join('\n');
  const out = appendHistoryEntry(noAC, { role: 'coder', prompt: 'p', response: 'r', timestamp: '2026-07-18T01:00:00.000Z' });
  assert.match(out, /## History/);
  assert.ok(out.indexOf('## Description') < out.indexOf(HISTORY_HEADING), 'History appended after existing content');
});

// ---------------------------------------------------------------------------
// appendHistoryEntry — whole-file / verbatim preservation
// ---------------------------------------------------------------------------

test('the user-owned `## Additional Context` section is byte-for-byte unchanged', () => {
  const before = sectionSlice(SAMPLE, ADDITIONAL_CONTEXT_HEADING);
  const out = appendHistoryEntry(SAMPLE, { role: 'coder', prompt: 'p', response: 'r', timestamp: '2026-07-18T01:00:00.000Z' });
  const after = sectionSlice(out, ADDITIONAL_CONTEXT_HEADING);
  assert.equal(after, before, 'Additional Context content is identical after append');
  // Explicitly assert the trailing-space line survived intact (byte-for-byte).
  assert.match(out, /A user note with \*\*markdown\*\* and a trailing space\.   /);
});

test('other sections (Description, Acceptance Criteria, frontmatter) are preserved verbatim', () => {
  const out = appendHistoryEntry(SAMPLE, { role: 'coder', prompt: 'p', response: 'r', timestamp: '2026-07-18T01:00:00.000Z' });
  assert.equal(sectionSlice(out, '## Description'), sectionSlice(SAMPLE, '## Description'));
  assert.equal(sectionSlice(out, '## Acceptance Criteria'), sectionSlice(SAMPLE, '## Acceptance Criteria'));
  // Frontmatter (the preamble before the first `## `) is untouched.
  assert.match(out, /^---\nid: TASK-100\ntitle: Sample\nstatus: in-progress\n---/);
});

// ---------------------------------------------------------------------------
// appendHistoryEntry — purity (single string in, new string out, no side effects)
// ---------------------------------------------------------------------------

test('is a pure function of a single markdown string: input is not mutated, output is a new string', () => {
  const input = SAMPLE;
  const snapshot = String(SAMPLE);
  const out = appendHistoryEntry(input, { role: 'coder', prompt: 'p', response: 'r', timestamp: '2026-07-18T01:00:00.000Z' });
  assert.equal(input, snapshot, 'the input markdown string is unchanged (no other ticket file is touched)');
  assert.notEqual(out, input, 'a new markdown string is returned');
  assert.equal(typeof out, 'string');
});

test('non-string input is handled by treating the body as empty', () => {
  const out = appendHistoryEntry(undefined, { role: 'coder', prompt: 'p', response: 'r', timestamp: '2026-07-18T01:00:00.000Z' });
  assert.equal(typeof out, 'string');
  assert.match(out, /## History/);
  assert.match(out, /### 2026-07-18T01:00:00\.000Z — coder/);
});
