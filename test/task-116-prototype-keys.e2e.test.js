'use strict';

// ===========================================================================
// TASK-116 — e2e cucumber-style (Given/When/Then) scenarios
//
// Feature: team-config normalizeConfig safe against prototype/reserved key
// names (review follow-up of TASK-097, lib/team-config.js).
//
// These are scenario-style `node --test` cases (no `cucumber` npm package is
// installed or used) that implement EVERY Gherkin scenario in the ticket. The
// module under test is a PURE lib — it never touches disk/DB/network/Electron,
// so there is no real DB/FS I/O here and nothing to connect to; every scenario
// drives the real exports via require().
//
// CRITICAL test-construction rule (from the ticket): every malicious input is
// built via JSON.parse('...') (or Object.defineProperty), NEVER an object
// literal — a `{__proto__: x}` literal sets the object's prototype and defines
// no OWN key, so it would test nothing. JSON.parse defines "__proto__" as an
// OWN enumerable key, which is exactly the hazard under test.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');
const { DEFAULT_CONCURRENCY } = require('../lib/ticket-queue.js');

const { normalizeConfig, serializeConfig, SYSTEM_SLUGS } = teamConfig;

// A snapshot guard used by several scenarios: prove the GLOBAL Object.prototype
// was never polluted by any of the calls in this file.
function assertGlobalPrototypeClean() {
  assert.equal(({}).polluted, undefined, 'global Object.prototype has no "polluted"');
  assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
    'global Object.prototype owns no "polluted" key');
}

// ---------------------------------------------------------------------------
// Scenario: Malicious __proto__ in on-disk JSON doesn't reassign the config
// prototype (attack)
//   Given a team-config JSON string with an own top-level "__proto__" =
//     {"polluted":true}
//   When normalizeConfig is called with that string
//   Then it doesn't throw; the returned config's prototype is Object.prototype;
//     no "polluted" own/inherited; global Object.prototype gains no "polluted"
// ---------------------------------------------------------------------------
test('Scenario: Malicious own top-level __proto__ in JSON does not reassign the config prototype (attack)', () => {
  // Given a JSON STRING with an own top-level "__proto__" object value. Built
  // via a literal string so JSON.parse (inside normalizeConfig) defines it as
  // an OWN key, reproducing the real on-disk attack.
  const raw = '{"__proto__":{"polluted":true},"version":1,"columns":[],"skill":{"concurrencyDefault":3}}';

  // When normalizeConfig is called with that string
  let cfg;
  assert.doesNotThrow(() => { cfg = normalizeConfig(raw); },
    'normalizeConfig must never throw on a malicious __proto__ string');

  // Then the returned config's prototype is Object.prototype (unchanged)
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype,
    'returned config prototype stays Object.prototype');

  // And there is no "polluted" — neither own nor inherited
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg, 'polluted'), 'no own "polluted"');
  assert.equal(cfg.polluted, undefined, 'no inherited "polluted"');

  // And a warning records the ignored unsafe top-level key
  assert.ok(cfg.warnings.some((w) => /unsafe top-level key/.test(w) && /__proto__/.test(w)),
    'a warning reports the ignored unsafe top-level __proto__ key');

  // And the canonical config is still complete (six system columns, clamped skill)
  assert.deepEqual(cfg.columns.map((c) => c.status), SYSTEM_SLUGS.slice());
  assert.equal(cfg.skill.concurrencyDefault, 3);

  // And the GLOBAL Object.prototype was never touched
  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: __proto__ inside skill doesn't reassign skill's prototype
//   Given a parsed config whose skill has an own "__proto__" object value
//   When normalizeConfig runs
//   Then cfg.skill prototype is Object.prototype, concurrencyDefault is a
//     clamped number, and warnings mentions the ignored unsafe key
// ---------------------------------------------------------------------------
test('Scenario: own __proto__ inside skill does not reassign the skill prototype', () => {
  // Given a PARSED config whose skill carries an own "__proto__" object value.
  const raw = JSON.parse(
    '{"version":1,"columns":[],"skill":{"concurrencyDefault":999,"__proto__":{"polluted":true}}}',
  );

  // When normalizeConfig runs
  let cfg;
  assert.doesNotThrow(() => { cfg = normalizeConfig(raw); });

  // Then cfg.skill prototype is Object.prototype (unchanged)
  assert.equal(Object.getPrototypeOf(cfg.skill), Object.prototype,
    'skill prototype stays Object.prototype');
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill, 'polluted'), 'skill has no own "polluted"');
  assert.equal(cfg.skill.polluted, undefined, 'skill has no inherited "polluted"');

  // And concurrencyDefault is a clamped number (999 → MAX)
  assert.equal(typeof cfg.skill.concurrencyDefault, 'number');
  assert.equal(cfg.skill.concurrencyDefault, teamConfig.MAX_CONCURRENCY);

  // And warnings mentions the ignored unsafe skill key
  assert.ok(cfg.warnings.some((w) => /unsafe skill key/.test(w) && /__proto__/.test(w)),
    'a warning reports the ignored unsafe skill __proto__ key');

  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: __proto__ inside a column is neutralized
//   Given a parsed config where a user column has an own "__proto__" object
//     value
//   When normalizeConfig runs
//   Then the returned column's prototype is Object.prototype and its canonical
//     fields are intact
//
// Note (per ticket): the column path has NO warnings channel, so this scenario
// asserts on the prototype/canonical fields, NOT on warnings.
// ---------------------------------------------------------------------------
test('Scenario: own __proto__ inside a user column is neutralized (silent, no warning)', () => {
  // Given a PARSED config where a user column has an own "__proto__" object value.
  const raw = JSON.parse(
    '{"version":1,"columns":['
    + '{"status":"todo","label":"To Do","system":true},'
    + '{"status":"ux-review","label":"UX Review","description":"peer","agent":"bot","system":false,"__proto__":{"polluted":true}}'
    + '],"skill":{"concurrencyDefault":3}}',
  );

  // When normalizeConfig runs
  let cfg;
  assert.doesNotThrow(() => { cfg = normalizeConfig(raw); });

  const ux = cfg.columns.find((c) => c.status === 'ux-review');
  assert.ok(ux, 'the user column survives');

  // Then the returned column's prototype is Object.prototype (unchanged)
  assert.equal(Object.getPrototypeOf(ux), Object.prototype, 'column prototype stays Object.prototype');
  assert.ok(!Object.prototype.hasOwnProperty.call(ux, 'polluted'), 'column has no own "polluted"');
  assert.equal(ux.polluted, undefined, 'column has no inherited "polluted"');

  // And its canonical fields are intact
  assert.equal(ux.label, 'UX Review');
  assert.equal(ux.description, 'peer');
  assert.equal(ux.agent, 'bot');
  assert.equal(ux.system, false);

  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: constructor/prototype own-keys never crash normalize
//   Given a parsed config with own "constructor" and "prototype" keys at top
//     level and on a column
//   When normalizeConfig runs
//   Then it doesn't throw and no returned object's prototype changed
// ---------------------------------------------------------------------------
test('Scenario: own constructor/prototype keys (top-level + column) never crash normalize', () => {
  // Given a PARSED config with own "constructor"/"prototype" keys at top level
  // and on a user column.
  const raw = JSON.parse(
    '{"version":1,"constructor":{"polluted":true},"prototype":{"polluted":true},'
    + '"columns":['
    + '{"status":"todo","label":"To Do","system":true},'
    + '{"status":"lane-a","label":"A","system":false,"constructor":{"x":1},"prototype":{"y":2}}'
    + '],"skill":{"concurrencyDefault":3}}',
  );

  // When normalizeConfig runs
  let cfg;
  assert.doesNotThrow(() => { cfg = normalizeConfig(raw); });

  // Then no returned object's prototype changed
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype, 'top-level prototype unchanged');
  assert.equal(cfg.constructor, Object, 'cfg.constructor is still Object (not reassigned)');

  const laneA = cfg.columns.find((c) => c.status === 'lane-a');
  assert.ok(laneA, 'the user column survives');
  assert.equal(Object.getPrototypeOf(laneA), Object.prototype, 'column prototype unchanged');
  assert.equal(laneA.constructor, Object, 'column constructor still Object');

  // And the dangerous own keys were skipped, not round-tripped.
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg, 'prototype'), 'top-level own "prototype" skipped');
  assert.ok(!Object.prototype.hasOwnProperty.call(laneA, 'prototype'), 'column own "prototype" skipped');

  // And warnings note the top-level unsafe keys (top-level path has a channel).
  assert.ok(cfg.warnings.some((w) => /unsafe top-level key/.test(w) && /constructor/.test(w)));
  assert.ok(cfg.warnings.some((w) => /unsafe top-level key/.test(w) && /prototype/.test(w)));

  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: A column field named like an Object member round-trips
//   Given a config whose user column has an unknown field toString="keep me"
//   When normalizeConfig → serializeConfig → JSON.parse
//   Then the column's own toString equals "keep me" at every step
//
// This proves the F2 fix (orderColumn uses hasOwnProperty, not `in`): a field
// named like an Object.prototype member survives as an OWN property.
// ---------------------------------------------------------------------------
test('Scenario: a column field named like an Object member (toString) round-trips as an own property', () => {
  // Given a PARSED config whose user column carries own toString/hasOwnProperty/
  // valueOf fields (all names of Object.prototype members).
  const raw = JSON.parse(
    '{"version":1,"columns":['
    + '{"status":"todo","label":"To Do","system":true},'
    + '{"status":"lane-x","label":"X","system":false,"toString":"keep me","hasOwnProperty":1,"valueOf":"x"}'
    + '],"skill":{"concurrencyDefault":3}}',
  );

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);
  const col = cfg.columns.find((c) => c.status === 'lane-x');
  assert.ok(col, 'the user column survives');

  // Then the column's OWN toString equals "keep me" after normalize
  assert.ok(Object.prototype.hasOwnProperty.call(col, 'toString'), 'toString is an OWN key after normalize');
  assert.equal(col.toString, 'keep me');
  assert.ok(Object.prototype.hasOwnProperty.call(col, 'hasOwnProperty'), 'hasOwnProperty is an OWN key');
  assert.equal(col.hasOwnProperty, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(col, 'valueOf'), 'valueOf is an OWN key');
  assert.equal(col.valueOf, 'x');

  // When serializeConfig → JSON.parse
  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);
  const pcol = parsed.columns.find((c) => c.status === 'lane-x');
  assert.ok(pcol, 'the user column survives serialization');

  // Then the column's own toString still equals "keep me" after the round-trip
  assert.ok(Object.prototype.hasOwnProperty.call(pcol, 'toString'), 'toString is an OWN key after round-trip');
  assert.equal(pcol.toString, 'keep me', 'toString survives normalize→serialize→parse as "keep me"');
  assert.equal(pcol.hasOwnProperty, 1, 'hasOwnProperty value survives the round-trip');
  assert.equal(pcol.valueOf, 'x', 'valueOf value survives the round-trip');
});

// ---------------------------------------------------------------------------
// Scenario: serializeConfig emits clean idempotent JSON for malicious input
//   Given a config string with own __proto__/constructor/prototype keys
//   When serializeConfig runs
//   Then output is valid JSON ending in newline, the parse contains none of
//     those keys, and re-serializing yields the identical string
// ---------------------------------------------------------------------------
test('Scenario: serializeConfig emits clean, idempotent JSON for malicious input', () => {
  // Given a config STRING with own __proto__/constructor/prototype keys at
  // top level, in skill, and on a column.
  const raw = '{"version":1,"__proto__":{"polluted":true},"constructor":{"polluted":true},'
    + '"prototype":{"polluted":true},'
    + '"columns":['
    + '{"status":"todo","label":"To Do","system":true},'
    + '{"status":"lane-z","label":"Z","system":false,"__proto__":{"polluted":true},"constructor":{"p":1}}'
    + '],"skill":{"concurrencyDefault":3,"__proto__":{"polluted":true}}}';

  // When serializeConfig runs
  let out;
  assert.doesNotThrow(() => { out = serializeConfig(raw); });

  // Then the output is valid JSON ending in a newline
  assert.ok(out.endsWith('\n'), 'serialized output ends with a newline');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'serialized output is valid JSON');

  // And the parse contains NONE of the three dangerous keys, anywhere.
  const jsonHasKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  assert.ok(!jsonHasKey(parsed, '__proto__'), 'top-level has no own __proto__');
  assert.ok(!jsonHasKey(parsed, 'constructor'), 'top-level has no own constructor');
  assert.ok(!jsonHasKey(parsed, 'prototype'), 'top-level has no own prototype');
  assert.ok(!jsonHasKey(parsed.skill, '__proto__'), 'skill has no own __proto__');
  for (const c of parsed.columns) {
    assert.ok(!jsonHasKey(c, '__proto__'), 'column has no own __proto__');
    assert.ok(!jsonHasKey(c, 'constructor'), 'column has no own constructor');
    assert.ok(!jsonHasKey(c, 'prototype'), 'column has no own prototype');
  }
  // The raw JSON text also carries none of the escaped forms.
  assert.ok(!/"__proto__"/.test(out), 'serialized text has no "__proto__" key');
  assert.ok(!/"constructor"/.test(out), 'serialized text has no "constructor" key');
  assert.ok(!/"prototype"/.test(out), 'serialized text has no "prototype" key');

  // And re-serializing yields the identical string (idempotent)
  const again = serializeConfig(parsed);
  assert.equal(again, out, 'serializeConfig is idempotent on malicious input');

  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: Junk input still never throws (regression)
//   Given null/42/"not json"/[]
//   When normalizeConfig and serializeConfig run
//   Then no throw and every result is a complete valid config
// ---------------------------------------------------------------------------
test('Scenario: junk input still never throws and yields a complete config (regression)', () => {
  const defaultSlugs = SYSTEM_SLUGS.slice();

  for (const junk of [null, 42, 'not json', [], undefined, true, '{bad json']) {
    // When normalizeConfig runs
    let cfg;
    assert.doesNotThrow(() => { cfg = normalizeConfig(junk); },
      `normalizeConfig(${JSON.stringify(junk)}) never throws`);

    // Then the result is a complete valid config with a clean prototype
    assert.equal(Object.getPrototypeOf(cfg), Object.prototype, 'config prototype is Object.prototype');
    assert.deepEqual(cfg.columns.map((c) => c.status), defaultSlugs,
      `junk ${JSON.stringify(junk)} → six system columns`);
    assert.equal(cfg.skill.concurrencyDefault, DEFAULT_CONCURRENCY);
    assert.ok(Array.isArray(cfg.warnings));

    // When serializeConfig runs
    let out;
    assert.doesNotThrow(() => { out = serializeConfig(junk); },
      `serializeConfig(${JSON.stringify(junk)}) never throws`);
    assert.ok(out.endsWith('\n'), 'serialized junk still ends in a newline');
    assert.doesNotThrow(() => JSON.parse(out), 'serialized junk is valid JSON');
  }

  assertGlobalPrototypeClean();
});
