---
id: TASK-175
title: main.js extraction test harness is fragile brace-matching, bypasses module.exports
status: done
created: 2026-07-27T01:15:38.000Z
updated: 2026-07-27T03:09:31.876Z
review-of: TASK-164
resolution: wont-do
---

## Description
Tech-lead review of TASK-164 found that both new main.js handler test files
re-derive the extracted functions' code by string-slicing `main.js` with a
brace-matching `extractFn` helper and `new Function(...)`, rather than
requiring `main.js`'s actual `module.exports` and invoking the real exported
functions directly.

The brace matcher does not account for `{`/`}` characters inside string
literals, regex, or comments within the extracted function body. It works
today only because both factories happen to be brace-clean. A future edit
adding a brace inside a string/comment could silently mis-slice the extracted
source, or a future edit that accidentally drops one of these factories from
`module.exports` would go completely unnoticed (the tests would still "extract"
the function from raw source text, never checking it's actually exported).

This is a recurring pattern across this feature (see also TASK-169's dead
`extractHandlerBlock` and TASK-170's redundant regex assertions) — the
source-extraction technique is useful when `main.js` genuinely can't be
`require()`'d (it requires `electron` at module scope), but this repo has
NOT yet established whether it's possible to mock `require('electron')` and
`require()` main.js's real exports directly (the way TASK-164's OWN preload.js
tests successfully did via `Module._load` interception) — which would be more
robust than brace-matching source text.

## Impact If Not Fixed
Future edits to `createGetUsageHandler`/`createSetProjectConfigHandler` could
produce misleading test passes (if the brace-matcher mis-slices) or confusing
false failures unrelated to actual behavior, eroding trust in this ticket's
own added coverage. A regression that removes a factory from `module.exports`
entirely would go unnoticed since the tests never check the export exists,
only that raw source text can be found and evaluated.

## Acceptance Criteria
- [ ] Investigate whether `main.js` can be `require()`'d directly under
      `node --test` using the SAME `Module._load` interception technique
      TASK-164 already used successfully for `preload.js` (mocking `electron`
      before requiring). If feasible, migrate the `createGetUsageHandler`/
      `createSetProjectConfigHandler` tests to require the real
      `module.exports` instead of brace-matching source text.
- [ ] If requiring `main.js` directly is impractical (e.g. it has broader
      side effects at module scope beyond what a mocked `electron` can
      absorb), at minimum add a test that verifies both functions ARE present
      in `main.js`'s `module.exports` (so a future accidental removal is
      caught), in addition to whatever extraction technique is used for
      invoking them.
- [ ] Document (in a code comment) why the chosen approach was picked, so a
      future ticket doesn't need to re-investigate from scratch.
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: main.js handler extraction is robust and export-aware

  Scenario: Tests verify the functions are actually exported
    Given main.js's module.exports
    When inspected
    Then createGetUsageHandler and createSetProjectConfigHandler are present

  Scenario: Extraction technique survives a harmless source change
    Given a brace character added inside an unrelated string/comment in main.js
      (simulated, not necessarily applied in CI)
    When the test extraction runs
    Then it still correctly isolates the real function body
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\main.js` — `module.exports`,
  `createGetUsageHandler`, `createSetProjectConfigHandler`.
- `C:\projects\claude-cmd-ui2\test\task-164-telemetry-getusage-setprojectconfig.test.js` /
  `.e2e.test.js` — the `extractFn` brace-matcher to potentially replace or
  supplement.
- `C:\projects\claude-cmd-ui2\test\task-164-preload-telemetry-bridge.test.js`
  — the `Module._load` interception technique that successfully required the
  REAL preload.js; investigate whether an equivalent works for main.js.

## Additional Context
_(user-owned — leave blank)_
