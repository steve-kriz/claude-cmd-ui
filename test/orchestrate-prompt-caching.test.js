'use strict';

// ===========================================================================
// Orchestrate prompt-caching guidance — drift guard.
//
// The swarm is tuned to maximise Anthropic prompt-cache hits: agent system
// prompts are byte-stable (always-cached prefix), and each dispatch is built as a
// fixed preamble with the volatile ticket text appended LAST. These tests assert
// that guidance is present in BOTH copies of SKILL.md and the agent defs, and
// that the two copies stay byte-identical. Pure instruction-file reads — no DB /
// network / Electron. Prose checks normalise whitespace so markdown line-wrapping
// is irrelevant.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_AGENTS = path.join(ROOT, 'assets', 'agents');
const PROJECT_AGENTS = path.join(ROOT, '.claude', 'agents');

// Whitespace-collapsed read so substring/prose checks ignore source line-wrapping.
function readNorm(p) {
  return fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ');
}
function normStr(s) {
  return s.replace(/\s+/g, ' ');
}

const skillCopies = [['assets', ASSETS_SKILL], ['.claude', PROJECT_SKILL]];

// --- SKILL.md: the Prompt caching subsection --------------------------------

test('SKILL.md has a "Prompt caching" subsection in both copies', () => {
  for (const [label, p] of skillCopies) {
    assert.match(fs.readFileSync(p, 'utf8'), /### Prompt caching/,
      `${label}/SKILL.md has a Prompt caching subsection`);
  }
});

test('SKILL.md states the stable-prefix / volatile-suffix caching rule in both copies', () => {
  for (const [label, p] of skillCopies) {
    const text = readNorm(p);
    for (const phrase of [
      'stable content first, volatile content last',
      'always-cached prefix',
      'Build every dispatch prompt as a fixed preamble',
      'at the very end',
      'same wording and order',
      'Keep the volatile tail small',
    ]) {
      assert.ok(text.includes(normStr(phrase)),
        `${label}/SKILL.md caching guidance missing phrase: ${phrase}`);
    }
  }
});

test('SKILL.md ties caching to the byte-stable agent definitions in both copies', () => {
  for (const [label, p] of skillCopies) {
    const text = readNorm(p);
    assert.ok(text.includes(normStr('Never regenerate an agent definition')),
      `${label}/SKILL.md warns against regenerating agent definitions`);
    assert.ok(/keep\s+it byte-stable/i.test(text) || text.includes('byte-stable'),
      `${label}/SKILL.md ties cache reuse to byte-stable agent defs`);
  }
});

// --- SKILL.md: byte-identity ------------------------------------------------

test('both SKILL.md copies are byte-identical after the caching edit', () => {
  const a = fs.readFileSync(ASSETS_SKILL);
  const b = fs.readFileSync(PROJECT_SKILL);
  assert.ok(a.equals(b), 'SKILL.md copies byte-for-byte identical');
});

// --- SKILL.md: caching prose introduces no model id after Phase 2 -----------

test('the caching guidance introduces no model id after the Phase 2 heading', () => {
  for (const [label, p] of skillCopies) {
    const src = fs.readFileSync(p, 'utf8');
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(phase2Idx !== -1, `${label}: Phase 2 heading present`);
    const tail = src.slice(phase2Idx);
    assert.ok(!tail.includes('claude-sonnet-5') && !tail.includes('claude-opus-4-8'),
      `${label}: no model id at/after Phase 2 (caching prose stays before it)`);
  }
});

// --- Agent defs: consumers read only what the ticket names (cache-warm) ------

const CONSUMER_AGENTS = ['coder.md', 'tester.md', 'tech-lead.md'];

test('coder/tester/tech-lead each carry the cache-warm "read only what you need" guidance', () => {
  for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
    for (const f of CONSUMER_AGENTS) {
      const text = readNorm(path.join(dir, f));
      assert.ok(text.includes('cache-warm'),
        `${path.basename(dir)}/${f} mentions keeping context cache-warm`);
      assert.ok(/read \*\*only the specific files/i.test(text) || /only the files the\s*ticket changed/i.test(text)
        || text.includes('only the specific files you need'),
        `${path.basename(dir)}/${f} instructs reading only the needed files`);
    }
  }
});

test('ba.md frames the ticket body as the stable, shared context downstream agents reuse', () => {
  for (const dir of [ASSETS_AGENTS, PROJECT_AGENTS]) {
    const text = readNorm(path.join(dir, 'ba.md'));
    assert.ok(text.includes(normStr('stable, shared context')),
      `${path.basename(dir)}/ba.md frames the ticket as stable shared context`);
    assert.ok(text.includes('cache-warm'),
      `${path.basename(dir)}/ba.md ties front-loading to keeping downstream context cache-warm`);
  }
});

// --- Agent defs: byte-identity ----------------------------------------------

test('every touched agent def copy is byte-identical after the caching edit', () => {
  for (const f of ['ba.md', ...CONSUMER_AGENTS]) {
    const a = fs.readFileSync(path.join(ASSETS_AGENTS, f));
    const b = fs.readFileSync(path.join(PROJECT_AGENTS, f));
    assert.ok(a.equals(b), `${f} copies byte-for-byte identical`);
  }
});
