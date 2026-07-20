'use strict';

// E2E cucumber-style scenarios for TASK-070 (per-activity cost/accounting log
// stored in the ticket MD, surfaced in the modal). These are Given/When/Then
// `node --test` cases (no `cucumber` npm package — none is installed) that
// implement the ticket's Gherkin, covering every acceptance criterion plus
// failure/edge paths.
//
// The feature is pure (lib/ticket-cost.js) + a browser-side renderer mirror +
// SKILL.md orchestrator instruction. There are NO database calls anywhere in
// this feature, so the "mock ALL DB calls" rule is honored trivially — nothing
// touches a DB, disk, or the network here.
//
// renderer/renderer.js is a BROWSER script (references `document`, no
// module.exports) and cannot be require()d, so the renderer-side scenarios are
// verified by source-scan (in the style of test/tasks-working-indicator.test.js).
// The board serializer/parser are copied VERBATIM from renderer.js (identical to
// the copies in test/ticket-runs.test.js) for the round-trip scenario.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendActivity,
  parseActivities,
  totalActivities,
  ACTIVITIES_KEY,
} = require('../lib/ticket-cost');

// ---------------------------------------------------------------------------
// Real serializer/parser, copied verbatim from renderer/renderer.js. renderer.js
// is a browser script and cannot be required, so the round-trip contract is
// exercised against these faithful copies (identical to test/ticket-runs.test.js).
// ---------------------------------------------------------------------------
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

function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const SKILL_CLAUDE = path.join(__dirname, '..', '.claude', 'skills', 'orchestrate', 'SKILL.md');
const SKILL_ASSETS = path.join(__dirname, '..', 'assets', 'skills', 'orchestrate', 'SKILL.md');

const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const indexHtml = fs.readFileSync(INDEX_HTML, 'utf8');

// ===========================================================================
// Scenario: The orchestrator records a BA activity on a ticket
// ===========================================================================
test('Scenario: appendActivity records a BA activity', () => {
  // Given a ticket frontmatter with no activities field
  const fm = { id: 'TASK-070', title: 'ticket cost', status: 'defining' };
  const snapshot = JSON.stringify(fm);

  // When appendActivity is called with a BA activity, model and timings/tokens
  const out = appendActivity(fm, {
    activity: 'ba',
    model: 'claude-fable-5',
    startedAt: '2026-07-19T10:00:00Z',
    finishedAt: '2026-07-19T10:04:30Z',
    tokensIn: 12000,
    tokensOut: 3500,
  });

  // Then the returned frontmatter has an activities field holding a one-line
  // JSON array of one entry
  const raw = out[ACTIVITIES_KEY];
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.includes('\n') && !raw.includes('\r'), 'one physical line');
  const entries = parseActivities(out);
  assert.equal(entries.length, 1, 'exactly one entry');
  assert.equal(entries[0].activity, 'ba');
  assert.equal(entries[0].model, 'claude-fable-5');

  // And the entry's durationMs is 270000
  assert.equal(entries[0].durationMs, 270000);

  // And the original frontmatter object is not mutated
  assert.equal(JSON.stringify(fm), snapshot, 'input untouched');
  assert.ok(!(ACTIVITIES_KEY in fm), 'original fm gained no activities field');
});

// ===========================================================================
// Scenario: Each phase appends its own entry in order
// ===========================================================================
test('Scenario: each phase appends its own entry in chronological order', () => {
  // Given a ticket whose activities already hold a "ba" entry
  let fm = appendActivity({ id: 'T', title: 't', status: 'defining' }, { activity: 'ba' });

  // When code, test and review entries are appended in turn
  fm = appendActivity(fm, { activity: 'code' });
  fm = appendActivity(fm, { activity: 'test' });
  fm = appendActivity(fm, { activity: 'review' });

  // Then parseActivities returns four entries in chronological append order
  assert.deepEqual(
    parseActivities(fm).map((e) => e.activity),
    ['ba', 'code', 'test', 'review'],
  );
});

// ===========================================================================
// Scenario: Totals sum only what was actually recorded
// ===========================================================================
test('Scenario: totalActivities sums only what was recorded', () => {
  // Given activities where only two of three entries carry tokens and only one
  // carries costUsd
  const activities = [
    { activity: 'ba', tokensIn: 12000, tokensOut: 3500, costUsd: 0.42 },
    { activity: 'code', tokensIn: 20000, tokensOut: 8000 },
    { activity: 'test' },
  ];

  // When totalActivities runs
  const t = totalActivities(activities);

  // Then tokensIn/tokensOut totals cover exactly the two carrying entries
  assert.equal(t.tokensIn, 32000);
  assert.equal(t.tokensOut, 11500);
  // And the costUsd total equals the single recorded cost
  assert.equal(t.costUsd, 0.42);
  // And no total is NaN
  for (const v of Object.values(t)) assert.ok(!Number.isNaN(v), 'no NaN total');
});

// ===========================================================================
// Scenario: Missing token data is never fabricated (edge/failure)
// ===========================================================================
test('Scenario (edge): missing token data is never fabricated', () => {
  // Given an appendActivity call with tokensIn NaN, tokensOut -5 and costUsd ""
  // When the entry is appended
  const out = appendActivity({ id: 'T' }, {
    activity: 'code',
    tokensIn: NaN,
    tokensOut: -5,
    costUsd: '',
  });

  // Then the stored entry has no tokensIn, tokensOut or costUsd fields
  const e = parseActivities(out)[0];
  assert.equal(e.activity, 'code', 'entry still recorded');
  assert.ok(!('tokensIn' in e), 'NaN tokensIn omitted');
  assert.ok(!('tokensOut' in e), 'negative tokensOut omitted');
  assert.ok(!('costUsd' in e), 'empty-string costUsd omitted');
});

// ===========================================================================
// Scenario: An entry without an activity name is rejected (edge/failure)
// ===========================================================================
test('Scenario (edge): an entry without an activity name is rejected', () => {
  // Given an appendActivity call whose activity is missing or blank, on a ticket
  // that already has one recorded entry
  const seeded = appendActivity({ id: 'T', title: 't', status: 's' }, { activity: 'ba' });
  const before = seeded[ACTIVITIES_KEY];

  // When it runs (blank activity)
  const out = appendActivity(seeded, { activity: '   ', model: 'm', tokensIn: 999 });

  // Then no entry is appended and the activities log is unchanged
  assert.equal(out[ACTIVITIES_KEY], before, 'log byte-identical');
  assert.equal(parseActivities(out).length, 1, 'still just the seeded entry');
});

// ===========================================================================
// Scenario: A corrupt activities field never breaks the board (edge/failure)
// ===========================================================================
test('Scenario (edge): a corrupt activities field never breaks parse', () => {
  // Given a ticket whose activities frontmatter value is "not-json{{{"
  const fm = { id: 'T', title: 't', status: 'todo', [ACTIVITIES_KEY]: 'not-json{{{' };

  // When parseActivities runs (as the board render / modal open would)
  let entries;
  assert.doesNotThrow(() => { entries = parseActivities(fm); }, 'parse never throws');

  // Then parseActivities returns an empty array and no exception is thrown
  assert.deepEqual(entries, []);

  // And a fresh entry can still be appended (the card keeps working)
  const out = appendActivity(fm, { activity: 'code' });
  assert.equal(parseActivities(out).length, 1, 'corrupt prior log dropped, new entry kept');
});

// ===========================================================================
// Scenario: Round-trip through the board serializer
// ===========================================================================
const BODY = [
  '',
  '## Description',
  'per-activity cost log stored in the ticket MD.',
  '',
  '## Additional Context',
  '(User-owned. Never overwrite.)',
  'A note with **markdown** and a trailing space.   ',
].join('\n');

test('Scenario: an activities JSON array round-trips byte-identical through serializeTicket -> parseTicketFrontmatter', () => {
  // Given a frontmatter object carrying an activities JSON array
  let fm = {
    id: 'TASK-070',
    title: 'ticket cost',
    status: 'done',
    created: '2026-07-10',
    updated: '2026-07-19',
  };
  fm = appendActivity(fm, {
    activity: 'ba', model: 'claude-fable-5',
    startedAt: '2026-07-19T10:00:00Z', finishedAt: '2026-07-19T10:04:30Z',
    tokensIn: 12000, tokensOut: 3500,
  });
  fm = appendActivity(fm, {
    activity: 'code', model: 'claude-opus-4-8',
    startedAt: '2026-07-19T11:00:00Z', finishedAt: '2026-07-19T11:20:00Z',
    tokensIn: 20000, tokensOut: 8000, costUsd: 0.42,
  });
  const original = fm[ACTIVITIES_KEY];

  // When it is serialized with serializeTicket and re-parsed with parseTicketFrontmatter
  const fileText = serializeTicket(fm, BODY);
  const activitiesLines = fileText.split('\n').filter((l) => l.startsWith(`${ACTIVITIES_KEY}:`));
  assert.equal(activitiesLines.length, 1, 'activities occupies exactly one line');

  const round = parseTicketFrontmatter(fileText);
  assert.ok(round, 'file parses back');

  // Then the activities value is byte-identical
  assert.equal(round.fm[ACTIVITIES_KEY], original, 'activities value byte-identical after round-trip');
  assert.equal(parseActivities(round.fm).length, 2, 'both entries survive');

  // And id, title, status, created, updated remain the leading keys
  assert.deepEqual(
    Object.keys(round.fm).slice(0, 5),
    ['id', 'title', 'status', 'created', 'updated'],
  );

  // And a ticket WITHOUT the key is completely unaffected
  const plain = { id: 'X', title: 'y', status: 'todo', tokens: '5', costUsd: '0.1' };
  const roundPlain = parseTicketFrontmatter(serializeTicket(plain, BODY));
  assert.ok(!(ACTIVITIES_KEY in roundPlain.fm), 'no activities key fabricated');
  assert.equal(roundPlain.fm.tokens, '5', 'legacy accounting intact');
  assert.equal(roundPlain.body, BODY, 'body preserved verbatim');
});

// ===========================================================================
// Scenario: The modal shows the complete cost view (renderer source-scan)
// ===========================================================================
test('Scenario: the modal fills a cost view — one row per activity plus a totals row', () => {
  // Given the ticket modal markup, Then a .task-modal-cost element exists in index.html
  assert.match(indexHtml, /class="task-modal-cost[ "]/, '.task-modal-cost element present in index.html');

  // And openTaskModal wires it up: reads the element, builds rows and a totals row
  assert.match(rendererSrc, /const\s+costEl\s*=\s*modal\.querySelector\('\.task-modal-cost'\)/);
  assert.match(rendererSrc, /ticketActivityLines\(fmObj\)/, 'per-activity rows sourced from ticketActivityLines');
  assert.match(rendererSrc, /ticketActivityTotalLine\(fmObj\)/, 'totals row sourced from ticketActivityTotalLine');
  assert.match(rendererSrc, /className\s*=\s*'task-modal-cost-row'/, 'one row per activity');
  assert.match(rendererSrc, /className\s*=\s*'task-modal-cost-total'/, 'a totals row');

  // And the renderer mirrors parseActivities / totalActivities semantics
  assert.match(rendererSrc, /function\s+parseTicketActivities\s*\(/, 'renderer parse mirror exists');
  assert.match(rendererSrc, /function\s+totalTicketActivities\s*\(/, 'renderer totals mirror exists');
});

// ===========================================================================
// Scenario: No activity data shows no cost view (renderer source-scan)
// ===========================================================================
test('Scenario: no activity data → the cost section is hidden', () => {
  // The cost element starts hidden in the markup...
  assert.match(indexHtml, /class="task-modal-cost hidden"/, 'cost section starts hidden');
  // ...and openTaskModal toggles `hidden` off only when there are lines.
  assert.match(
    rendererSrc,
    /costEl\.classList\.toggle\('hidden',\s*lines\.length\s*===\s*0\)/,
    'cost section hidden when there are no activity lines',
  );
});

// ===========================================================================
// Scenario: renderer mirror agrees with lib semantics on a tolerant/corrupt value
// (behavioral cross-check by replicating the documented mirror behavior, per the
// ticket: do NOT require renderer.js). We prove the lib side here; the source-scan
// above proves the renderer uses the same-shaped mirror.
// ===========================================================================
test('Scenario: mirror tolerance — a corrupt activities value yields [] on both sides (lib proven, renderer scanned)', () => {
  // lib side is tolerant
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: 'not-json{{{' }), []);
  // renderer mirror uses the same try/catch → [] shape
  assert.match(
    rendererSrc,
    /function\s+parseTicketActivities[\s\S]*?catch\s*\(_\)\s*\{\s*return\s*\[\];/,
    'renderer parse mirror swallows bad JSON and returns []',
  );
});

// ===========================================================================
// Scenario: SKILL.md copies document the recording duty and stay in sync
// ===========================================================================
test('Scenario: both SKILL.md copies document the recording duty and are byte-for-byte identical', () => {
  // Given both copies of the orchestrate SKILL.md
  const claudeBuf = fs.readFileSync(SKILL_CLAUDE);
  const assetsBuf = fs.readFileSync(SKILL_ASSETS);

  // Then the two copies are byte-for-byte identical (drift guard)
  assert.ok(claudeBuf.equals(assetsBuf), '.claude and assets SKILL.md are byte-identical');
  assert.equal(Buffer.compare(claudeBuf, assetsBuf), 0, 'Buffer.compare confirms identity');

  // And each instructs the orchestrator to append a per-activity accounting entry
  const claudeTxt = claudeBuf.toString('utf8');
  const assetsTxt = assetsBuf.toString('utf8');
  for (const [label, txt] of [['.claude', claudeTxt], ['assets', assetsTxt]]) {
    assert.match(txt, /Per-activity cost log/, `${label} documents the per-activity cost log`);
    assert.match(txt, /`activities`/, `${label} names the activities frontmatter field`);
    assert.match(txt, /never fabricate a token or cost figure/, `${label} forbids fabricating token/cost`);
    assert.match(txt, /post-processing/, `${label} covers the post-processing phase`);
  }
});
