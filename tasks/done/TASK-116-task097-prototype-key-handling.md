---
id: TASK-116
title: TASK-097 review: sanitize prototype keys + hasOwnProperty in team-config normalize
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:06:43.809Z
review-of: TASK-097
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:50:00Z","finishedAt":"2026-07-21T02:58:04Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:52:00Z","finishedAt":"2026-07-21T03:03:05Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T02:54:00Z","finishedAt":"2026-07-21T03:06:43Z"}]
---

## Description
Review follow-ups for TASK-097 (`lib/team-config.js`), severity **minor**, security-hardening. This is a review follow-up of TASK-097.

- **F1 — prototype-key handling in the round-trip loops.** `normalizeConfig` round-trips unknown fields via plain assignment in the skill loop (~326-328, `skill[k]=rawSkill[k]`) and top-level loop (~331-335, `out[k]=src[k]`). `JSON.parse` (which normalizeConfig accepts as a string) defines `"__proto__"` as an OWN key; plain assignment triggers the `Object.prototype.__proto__` setter → reassigns the returned object's prototype (object value) or silently swallows the key (primitive). Fix: in every unknown-key round-trip loop, SKIP `__proto__`/`constructor`/`prototype` (push a warning where a warnings channel exists), or copy via null-prototype/`defineProperty` so no setter fires. Returned config prototype must stay `Object.prototype`; global `Object.prototype` never touched.
- **F2 — `orderColumn` uses `in`.** ~96-106: `k in src` (100) and `!(k in out)` (103) walk the prototype chain, silently dropping a column field named `toString`/`hasOwnProperty`/`valueOf`/`constructor`/etc. Fix: use `Object.prototype.hasOwnProperty.call`. **Land F1+F2 together:** today the buggy `in` check accidentally shields `orderColumn`'s `out[k]=src[k]` (104) from `__proto__`; switching to hasOwnProperty alone would open per-column prototype reassignment, so `orderColumn`'s second loop must ALSO skip the three dangerous keys.
- **F3 — missing tests.** No test feeds `__proto__`/`constructor`/`prototype`/Object-member names into normalizeConfig/serializeConfig. Add unit + scenario tests. Build inputs via `JSON.parse('...')` or `Object.defineProperty` (a `{__proto__:x}` literal sets the prototype and would test nothing).
- Optional defense-in-depth: apply the same guard to `serializeConfig`'s strip loop (~388-391).
- Renderer mirror (NOTED, out of scope): `tasksSerializeTeamConfig`'s `w.extra` loop (renderer.js ~5432-5437) has the same hazard — do NOT fix here; note it for a follow-up.

## Acceptance Criteria
- [ ] `normalizeConfig(JSON.parse('{"__proto__":{"polluted":true}, ...}'))` (own top-level `__proto__`) → returned config prototype is `Object.prototype`, no inherited `polluted`, does not throw.
- [ ] Same holds for an own `__proto__` inside `skill` (cfg.skill prototype unchanged) and inside a column (returned column prototype unchanged).
- [ ] Own `constructor`/`prototype` keys (top-level, skill, column) → no throw, no prototype change, keys skipped.
- [ ] Global `Object.prototype` never mutated (`({}).polluted === undefined` after the calls).
- [ ] When a dangerous key is skipped at top level or in `skill`, a warning is pushed to `cfg.warnings` (the column path may skip silently — no warnings channel there).
- [ ] `orderColumn` uses `Object.prototype.hasOwnProperty.call` (100 and 103): a column with a legit unknown field named like an Object member (`toString:"keep me"`, `hasOwnProperty:1`, `valueOf:"x"`) round-trips as an OWN property through normalizeConfig and serializeConfig→JSON.parse.
- [ ] `serializeConfig` on malicious input → no throw, valid JSON whose parse contains none of `__proto__`/`constructor`/`prototype`, and idempotent.
- [ ] Never-throws contract preserved for all existing junk inputs.
- [ ] New F3 tests feed those keys (via JSON.parse/defineProperty) covering top-level, skill, and column paths.
- [ ] All existing task-097 tests pass UNMODIFIED.
- [ ] The renderer `tasksSerializeTeamConfig` `w.extra` gap is noted (comment/notes) as a follow-up; `renderer/renderer.js` NOT changed.

## Cucumber Tests
```gherkin
Feature: team-config normalizeConfig safe against prototype/reserved key names
  Scenario: Malicious __proto__ in on-disk JSON doesn't reassign the config prototype (attack)
    Given a team-config JSON string with an own top-level "__proto__" = {"polluted":true}
    When normalizeConfig is called with that string
    Then it doesn't throw; the returned config's prototype is Object.prototype; no "polluted" own/inherited; global Object.prototype gains no "polluted"
  Scenario: __proto__ inside skill doesn't reassign skill's prototype
    Given a parsed config whose skill has an own "__proto__" object value
    When normalizeConfig runs
    Then cfg.skill prototype is Object.prototype, concurrencyDefault is a clamped number, and warnings mentions the ignored unsafe key
  Scenario: __proto__ inside a column is neutralized
    Given a parsed config where a user column has an own "__proto__" object value
    When normalizeConfig runs
    Then the returned column's prototype is Object.prototype and its canonical fields are intact
  Scenario: constructor/prototype own-keys never crash normalize
    Given a parsed config with own "constructor" and "prototype" keys at top level and on a column
    When normalizeConfig runs
    Then it doesn't throw and no returned object's prototype changed
  Scenario: A column field named like an Object member round-trips
    Given a config whose user column has an unknown field toString="keep me"
    When normalizeConfig → serializeConfig → JSON.parse
    Then the column's own toString equals "keep me" at every step
  Scenario: serializeConfig emits clean idempotent JSON for malicious input
    Given a config string with own __proto__/constructor/prototype keys
    When serializeConfig runs
    Then output is valid JSON ending in newline, the parse contains none of those keys, and re-serializing yields the identical string
  Scenario: Junk input still never throws (regression)
    Given null/42/"not json"/[]
    When normalizeConfig and serializeConfig run
    Then no throw and every result is a complete valid config
```

## Edge Cases & Failure Paths
- `__proto__` object value → prototype reassignment today; must become a no-op skip. `__proto__` primitive → silently swallowed today; handle via the same skip. Fix-ordering trap: converting orderColumn to hasOwnProperty WITHOUT the dangerous-key skip re-opens per-column prototype reassignment — land F1+F2 together. Test-construction trap: `{__proto__:{}}` literal sets prototype (no own key) — use JSON.parse/defineProperty. normalizeConfig's outer try/catch can mask a pollution bug as "regenerated" — assert on prototypes/keys not just non-throw. Always call `Object.prototype.hasOwnProperty.call` (never `src.hasOwnProperty`) so a column named `hasOwnProperty` can't break the guard. Deep nested values copied by reference — no deep sanitize required. `warnings` input key already stripped — keep.

## Relevant Files & Context
- `lib/team-config.js` — only source change: `orderColumn` 96-106 (F2 + dangerous-key skip in the second loop); skill loop 326-328 (F1); top-level loop 331-335 (F1); `serializeConfig` strip loop 388-391 (optional); `repairSystemColumn` 162 / `buildUserColumn` 175 spread rawCol (spread keeps `__proto__` as own key without firing the setter → orderColumn is the single choke point). Module contract: pure, never throws, repairs reported via warnings (lowercase style).
- `test/task-097-team-config.test.js` / `.e2e.test.js` — must pass unmodified; new tests as `test/task-116-prototype-keys.{test,e2e.test}.js` (or clearly-labelled TASK-116 sections). Build malicious inputs via JSON.parse/defineProperty.
- `renderer/renderer.js` — mirror, NOT changed: `normalizeTasksColumns` (5313-5348) safe; `tasksSerializeTeamConfig` `w.extra` loop (5432-5437) shares the hazard — note for follow-up.
- 2 known-baseline failures unrelated.

## Impact If Not Fixed
A malformed/malicious team-config.json can hand downstream consumers config objects with an unexpected prototype and silently discard legitimately-persisted fields, and a future schema adding a column field with a common Object member name would lose it on every normalize.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
