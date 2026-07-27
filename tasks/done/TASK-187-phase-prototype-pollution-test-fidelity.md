---
id: TASK-187
title: TASK-180 review — __proto__ prototype-pollution test on skill.phases uses an inert object literal
status: done
created: 2026-07-27T14:00:00Z
updated: 2026-07-27T18:50:00Z
agent: orchestrator-main
review-of: TASK-180
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T18:40:00Z","finishedAt":"2026-07-27T18:47:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T18:47:00Z","finishedAt":"2026-07-27T18:49:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T18:47:00Z","finishedAt":"2026-07-27T18:49:00Z"}]
---

## Description
The TASK-180 tech-lead review found that the prototype-pollution tests for `skill.phases`
build the hazard using a JS object literal:
`phases: { __proto__: {...}, constructor: {...} }`.

In a JS object literal, `__proto__:` sets the object's prototype and is **not** an own
enumerable key, so `normalizePhases`'s `Object.keys(src)` loop (`lib/team-config.js` ~line
340) never iterates over it, and the `isUnsafeKey` warning path (~342-345) is never actually
exercised for `__proto__`. The unit assertion (`test/task-180-team-config-phases.test.js`
~line 172, `/unsafe/`) only passes because of the sibling `constructor` key. Real tampered
config arrives via `JSON.parse` (`normalizeConfig` ~line 362), where a literal `"__proto__"`
string key from disk **is** an own enumerable property — a materially different code path
than the object-literal test constructs.

This affects both:
- `test/task-180-team-config-phases.test.js` ~lines 149-173
- `test/task-180-team-config-phases.e2e.test.js` ~lines 372-403 ("unsafe phase keys are
  dropped")

The current implementation is correct (the review confirmed no actual vulnerability) — this
is purely a test-fidelity gap: if the guard were ever removed or reordered, these two tests
would not catch it for the `__proto__` case.

## Acceptance Criteria
- [x] Replace (or add alongside) the object-literal hazard construction with one built via
      `JSON.parse('{"phases": {"__proto__": {...}, "plan": {...}}}')` (or equivalent —
      `Object.defineProperty`/`Object.assign` from a parsed object — anything that produces
      `__proto__` as a genuine own enumerable key), matching how a tampered
      `tasks/team-config.json` would actually deliver the hazard.
- [x] The test asserts that after normalization, the resulting `skill.phases` object's own
      `Object.getPrototypeOf(...)` is unaffected (still `Object.prototype`) and that no
      polluted property leaked onto `Object.prototype` globally (check a fresh `{}` doesn't
      carry the injected property after normalization).
- [x] A regression check: temporarily removing/reordering the `isUnsafeKey` guard in
      `normalizePhases` must make this specific test fail (verify locally, do not leave the
      change in place).
- [x] The existing `constructor`-key assertion stays (it's valid coverage for that key); this
      ticket adds the missing genuine `__proto__`-as-own-key case, it doesn't remove existing
      coverage.

## Cucumber Tests
```gherkin
Feature: prototype-pollution test fidelity for skill.phases
  Scenario: a JSON-sourced __proto__ phase key is dropped and does not pollute Object.prototype
    Given team-config JSON containing {"phases": {"__proto__": {"enabled": true}, ...}}
    When it is parsed and normalized via normalizeConfig
    Then skill.phases has exactly the four canonical keys
    And Object.prototype gains no new property

  Scenario: guard removal is caught (failure/edge)
    Given the isUnsafeKey guard in normalizePhases were removed
    When the JSON-sourced __proto__ test runs
    Then it fails (proving it actually exercises the guard, unlike the object-literal version)
```

## Edge & Failure Cases
- Must use a real `JSON.parse` (or equivalent producing an own enumerable `__proto__` key),
  not an object literal with `__proto__:` syntax (which sets the prototype instead).
- Verify no global pollution leaks past the single test (check `({}).polluted` is undefined
  after the test, to catch a guard failure that pollutes shared `Object.prototype`).

## Relevant Files & Context
- `lib/team-config.js` — `normalizePhases` (~line 340), `isUnsafeKey`/`UNSAFE_KEYS`.
- `test/task-180-team-config-phases.test.js` (~149-173), `test/task-180-team-config-phases.e2e.test.js` (~372-403).

## Impact If Not Fixed
If the `isUnsafeKey` guard in `normalizePhases` were ever removed or reordered, a tampered
`tasks/team-config.json` containing a genuine `"__proto__"` phase key would not be caught by
these tests, leaving a prototype-pollution regression undetected until it surfaced as a live
security issue.

## Build notes
- Coder: added JSON.parse-based genuine own-key `__proto__` tests to both `test/task-180-team-config-phases.test.js` and `.e2e.test.js`, kept existing `constructor`-key coverage. Verified the regression check by temporarily disabling the `isUnsafeKey` guard locally (confirmed 3 tests went red), then reverting (confirmed 51/51 green).
- Test-only ticket — no production code changed. Orchestrator independently re-ran the full suite: 3721 pass, 3 pre-existing baseline failures, 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed no production change and that the JSON.parse hazard construction is self-contained (never actually pollutes the global prototype, by design); documentation pass found no stale doc references.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
