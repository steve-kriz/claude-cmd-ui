---
id: TASK-179
title: Prototype-poisoning assertion in normalize unit test is vacuous
status: done
created: 2026-07-27T02:18:02.000Z
updated: 2026-07-27T03:09:46.000Z
review-of: TASK-168
resolution: wont-do
---

## Description
Tech-lead review of TASK-168 found that in
`test/task-157-stats-per-project.test.js`, the test
`'Unit: normalizeProjectTelemetryConfig strips unsafe keys (__proto__,
constructor, prototype)'` ends with an assertion that is always true for a
plain JS object:
`assert.ok(!('__proto__' in result) || result.__proto__ === undefined ||
result.__proto__ === Object.prototype, ...)`.

Since `result` is a plain object, `result.__proto__ === Object.prototype` is
true unconditionally, regardless of whether the unsafe-key filter
(`tasksIsUnsafeKey`) inside `tasksNormalizeProjectTelemetryConfig` actually
stripped `constructor`/`prototype` as OWN ENUMERABLE properties. Only the
test's `result.safeKey === 'ok'` assertion carries real weight.

A separate test (the `serialize` test) DOES properly assert `constructor`
stripping, so the security behavior is not entirely untested — but only via
the serialize path, and only for the `constructor` key, not `prototype`, and
not at the normalize level directly.

## Impact If Not Fixed
A future regression that removes the prototype-poisoning guard specifically
from `tasksNormalizeProjectTelemetryConfig` (while leaving the separate
`serialize`-level guard intact, or that breaks handling of `prototype`/
`__proto__` specifically rather than `constructor`) could ship with a green
suite, weakening a defense-in-depth control on config parsed from an
untrusted on-disk file (`tasks/telemetry-config.json`).

## Acceptance Criteria
- [ ] Rewrite the normalize-level unsafe-key test to assert something that
      would actually FAIL if the filter were removed — e.g. assert that
      `Object.prototype.hasOwnProperty.call(result, '__proto__')` is `false`,
      or that `Object.keys(result)` does not include `'__proto__'`/
      `'constructor'`/`'prototype'` as own enumerable keys, rather than
      checking `result.__proto__`'s VALUE (which is always the real
      prototype chain regardless of what was filtered).
- [ ] Cover all three unsafe keys (`__proto__`, `constructor`, `prototype`)
      at the normalize level specifically, not just via the downstream
      serialize test.
- [ ] Confirm the rewritten assertion would actually fail if
      `tasksIsUnsafeKey`'s filter were removed from
      `tasksNormalizeProjectTelemetryConfig` (reason through it, or verify by
      temporarily removing the filter during development and confirming the
      test catches it — do not leave the filter removed in final code).
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: Prototype-poisoning guard is genuinely verified at the normalize level

  Scenario: Unsafe keys are absent as own enumerable properties after normalize
    Given a raw config object containing __proto__, constructor, and prototype
      keys alongside a safe key
    When tasksNormalizeProjectTelemetryConfig parses it
    Then none of __proto__/constructor/prototype appear as own enumerable
      properties of the result
    And the safe key is preserved
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\test\task-157-stats-per-project.test.js` — the
  vacuous assertion (~lines 166-181) to rewrite.
- `C:\projects\claude-cmd-ui2\renderer\renderer.js` — `tasksIsUnsafeKey`,
  `tasksNormalizeProjectTelemetryConfig`.

## Additional Context
_(user-owned — leave blank)_
