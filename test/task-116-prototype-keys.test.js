'use strict';

// ===========================================================================
// TASK-116 — unit tests for lib/team-config.js prototype/reserved-key hardening
//
// Review follow-up of TASK-097. Exercises the guard behaviors (F1 skill/top-
// level round-trip loops, F2 orderColumn hasOwnProperty + dangerous-key skip,
// serializeConfig strip loop) directly via require(). The module is a PURE lib:
// no disk/DB/network/Electron, so there is no real I/O here.
//
// CRITICAL: every malicious input is built via JSON.parse('...') (or
// Object.defineProperty), NEVER an object literal — a `{__proto__: x}` literal
// sets the object's prototype and defines no OWN key, testing nothing.
// JSON.parse defines "__proto__" as an OWN key, which is the real hazard.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');
const { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } = require('../lib/ticket-queue.js');

const { normalizeConfig, serializeConfig, SYSTEM_SLUGS } = teamConfig;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── F1: own top-level __proto__ ──────────────────────────────────────────────
test('normalizeConfig: own top-level __proto__ object value does not reassign the config prototype', () => {
  const cfg = normalizeConfig('{"__proto__":{"polluted":true},"version":1,"columns":[],"skill":{}}');
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  assert.ok(!hasOwn(cfg, 'polluted'));
  assert.equal(cfg.polluted, undefined, 'no inherited polluted');
  assert.equal(({}).polluted, undefined, 'global Object.prototype untouched');
});

test('normalizeConfig: own top-level __proto__ pushes an "ignored unsafe top-level key" warning', () => {
  const cfg = normalizeConfig('{"__proto__":{"polluted":true},"version":1,"columns":[],"skill":{}}');
  assert.ok(cfg.warnings.some((w) => /ignored unsafe top-level key "__proto__"/.test(w)));
});

test('normalizeConfig: primitive top-level __proto__ is skipped, not swallowed silently as a mutation', () => {
  const cfg = normalizeConfig('{"__proto__":"evil","version":1,"columns":[],"skill":{}}');
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  assert.ok(!hasOwn(cfg, '__proto__'));
  assert.ok(cfg.warnings.some((w) => /unsafe top-level key/.test(w)));
});

// ── F1: __proto__ inside skill ───────────────────────────────────────────────
test('normalizeConfig: own __proto__ inside skill keeps skill prototype and clamps concurrency', () => {
  const raw = JSON.parse('{"version":1,"columns":[],"skill":{"concurrencyDefault":999,"__proto__":{"polluted":true}}}');
  const cfg = normalizeConfig(raw);
  assert.equal(Object.getPrototypeOf(cfg.skill), Object.prototype);
  assert.ok(!hasOwn(cfg.skill, 'polluted'));
  assert.equal(cfg.skill.concurrencyDefault, MAX_CONCURRENCY);
  assert.ok(cfg.warnings.some((w) => /ignored unsafe skill key "__proto__"/.test(w)));
});

test('normalizeConfig: unknown safe skill fields still round-trip alongside the guard', () => {
  const raw = JSON.parse('{"version":1,"columns":[],"skill":{"concurrencyDefault":3,"__proto__":{"p":1},"extra":"keep"}}');
  const cfg = normalizeConfig(raw);
  assert.equal(cfg.skill.extra, 'keep', 'safe unknown skill field preserved');
  assert.ok(!hasOwn(cfg.skill, 'polluted'));
});

// ── F2: __proto__ inside a column ────────────────────────────────────────────
test('normalizeConfig: own __proto__ inside a user column keeps the column prototype (silent, no warning)', () => {
  const raw = JSON.parse(
    '{"version":1,"columns":['
    + '{"status":"ux-review","label":"UX","description":"d","agent":"bot","system":false,"__proto__":{"polluted":true}}'
    + '],"skill":{}}',
  );
  const cfg = normalizeConfig(raw);
  const ux = cfg.columns.find((c) => c.status === 'ux-review');
  assert.ok(ux);
  assert.equal(Object.getPrototypeOf(ux), Object.prototype);
  assert.ok(!hasOwn(ux, 'polluted'));
  assert.equal(ux.polluted, undefined);
  // Canonical fields intact.
  assert.equal(ux.label, 'UX');
  assert.equal(ux.description, 'd');
  assert.equal(ux.agent, 'bot');
  assert.equal(ux.system, false);
});

test('normalizeConfig: own __proto__ inside a SYSTEM column keeps its prototype and repairs canonically', () => {
  const raw = JSON.parse(
    '{"version":1,"columns":['
    + '{"status":"todo","label":"Custom To Do","system":true,"__proto__":{"polluted":true}}'
    + '],"skill":{}}',
  );
  const cfg = normalizeConfig(raw);
  const todo = cfg.columns.find((c) => c.status === 'todo');
  assert.equal(Object.getPrototypeOf(todo), Object.prototype);
  assert.ok(!hasOwn(todo, 'polluted'));
  assert.equal(todo.system, true);
  assert.equal(todo.label, 'Custom To Do', 'user label preserved');
});

// ── constructor / prototype own-keys ─────────────────────────────────────────
test('normalizeConfig: own constructor/prototype keys (top-level) do not throw or reassign', () => {
  const raw = JSON.parse('{"version":1,"constructor":{"polluted":true},"prototype":{"polluted":true},"columns":[],"skill":{}}');
  let cfg;
  assert.doesNotThrow(() => { cfg = normalizeConfig(raw); });
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  assert.equal(cfg.constructor, Object, 'constructor still Object');
  assert.ok(!hasOwn(cfg, 'prototype'), 'own prototype key skipped');
  assert.ok(cfg.warnings.some((w) => /unsafe top-level key "constructor"/.test(w)));
  assert.ok(cfg.warnings.some((w) => /unsafe top-level key "prototype"/.test(w)));
});

test('normalizeConfig: own constructor/prototype keys on a column do not throw or reassign', () => {
  const raw = JSON.parse(
    '{"version":1,"columns":['
    + '{"status":"lane-a","label":"A","system":false,"constructor":{"x":1},"prototype":{"y":2}}'
    + '],"skill":{}}',
  );
  let cfg;
  assert.doesNotThrow(() => { cfg = normalizeConfig(raw); });
  const laneA = cfg.columns.find((c) => c.status === 'lane-a');
  assert.equal(Object.getPrototypeOf(laneA), Object.prototype);
  assert.equal(laneA.constructor, Object);
  assert.ok(!hasOwn(laneA, 'prototype'), 'column own prototype key skipped');
});

// ── F2: Object-member-named field round-trips as OWN property ─────────────────
test('orderColumn (via normalizeConfig): a column field named toString round-trips as an own property', () => {
  const raw = JSON.parse(
    '{"version":1,"columns":['
    + '{"status":"lane-x","label":"X","system":false,"toString":"keep me","hasOwnProperty":1,"valueOf":"v"}'
    + '],"skill":{}}',
  );
  const cfg = normalizeConfig(raw);
  const col = cfg.columns.find((c) => c.status === 'lane-x');
  assert.ok(hasOwn(col, 'toString'));
  assert.equal(col.toString, 'keep me');
  assert.ok(hasOwn(col, 'hasOwnProperty'));
  assert.equal(col.hasOwnProperty, 1);
  assert.ok(hasOwn(col, 'valueOf'));
  assert.equal(col.valueOf, 'v');
});

test('Object-member-named column field survives normalizeConfig→serializeConfig→JSON.parse', () => {
  const raw = JSON.parse(
    '{"version":1,"columns":['
    + '{"status":"lane-x","label":"X","system":false,"toString":"keep me"}'
    + '],"skill":{}}',
  );
  const out = serializeConfig(raw);
  const parsed = JSON.parse(out);
  const col = parsed.columns.find((c) => c.status === 'lane-x');
  assert.ok(hasOwn(col, 'toString'));
  assert.equal(col.toString, 'keep me');
});

// ── serializeConfig strip loop ───────────────────────────────────────────────
test('serializeConfig: malicious input → valid JSON with none of the three dangerous keys', () => {
  const raw = '{"version":1,"__proto__":{"polluted":true},"constructor":{"p":1},"prototype":{"q":2},'
    + '"columns":[{"status":"lane-z","label":"Z","system":false,"__proto__":{"p":1}}],'
    + '"skill":{"concurrencyDefault":3,"__proto__":{"p":1}}}';
  let out;
  assert.doesNotThrow(() => { out = serializeConfig(raw); });
  const parsed = JSON.parse(out);
  assert.ok(!hasOwn(parsed, '__proto__'));
  assert.ok(!hasOwn(parsed, 'constructor'));
  assert.ok(!hasOwn(parsed, 'prototype'));
  assert.ok(!hasOwn(parsed.skill, '__proto__'));
  for (const c of parsed.columns) {
    assert.ok(!hasOwn(c, '__proto__'));
    assert.ok(!hasOwn(c, 'constructor'));
    assert.ok(!hasOwn(c, 'prototype'));
  }
  assert.ok(!/"__proto__"|"constructor"|"prototype"/.test(out), 'no dangerous key names in the JSON text');
});

test('serializeConfig: idempotent on malicious input', () => {
  const raw = '{"version":1,"__proto__":{"polluted":true},"columns":[],"skill":{"concurrencyDefault":3,"__proto__":{}}}';
  const once = serializeConfig(raw);
  const twice = serializeConfig(JSON.parse(once));
  assert.equal(once, twice);
  assert.ok(once.endsWith('\n'));
});

// ── global Object.prototype never mutated ─────────────────────────────────────
test('global Object.prototype is never mutated by any prototype-key handling', () => {
  normalizeConfig('{"__proto__":{"polluted":true},"columns":[],"skill":{}}');
  normalizeConfig(JSON.parse('{"columns":[{"status":"lx","label":"L","system":false,"__proto__":{"polluted":true}}],"skill":{}}'));
  serializeConfig('{"__proto__":{"polluted":true},"columns":[],"skill":{}}');
  assert.equal(({}).polluted, undefined);
  assert.ok(!hasOwn(Object.prototype, 'polluted'));
});

// ── never-throws contract preserved ──────────────────────────────────────────
test('normalizeConfig/serializeConfig never throw on junk (contract preserved)', () => {
  for (const junk of [null, undefined, 42, 'not json', [], true, NaN, '{bad']) {
    let cfg;
    assert.doesNotThrow(() => { cfg = normalizeConfig(junk); });
    assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
    assert.deepEqual(cfg.columns.map((c) => c.status), SYSTEM_SLUGS.slice());
    assert.equal(cfg.skill.concurrencyDefault, DEFAULT_CONCURRENCY);
    assert.doesNotThrow(() => serializeConfig(junk));
  }
});

// ── defineProperty-built input (alternate construction path) ─────────────────
test('normalizeConfig: __proto__ own key added via Object.defineProperty is also neutralized', () => {
  const src = { version: 1, columns: [], skill: {} };
  Object.defineProperty(src, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const cfg = normalizeConfig(src);
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  assert.ok(!hasOwn(cfg, 'polluted'));
  assert.equal(({}).polluted, undefined);
});
