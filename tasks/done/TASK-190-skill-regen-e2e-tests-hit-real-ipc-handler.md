---
id: TASK-190
title: TASK-184 review — e2e regen tests hit copies of the IPC handler/lib, not the real code
status: done
created: 2026-07-27T17:15:00Z
updated: 2026-07-27T20:20:00Z
agent: orchestrator-main
review-of: TASK-184
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T20:00:00Z","finishedAt":"2026-07-27T20:12:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T20:12:00Z","finishedAt":"2026-07-27T20:18:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T20:12:00Z","finishedAt":"2026-07-27T20:18:00Z"}]
---

## Description
The TASK-184 security post-processing review found that `test/task-184-skill-regen.e2e.test.js`
does not exercise the real production code for the two most security-relevant guarantees at the
IPC layer — "the API key never returned over IPC" and "content/instruction are clamped before
the billed network call":

- It hand-copies the IPC handler as a local `createIpcHandler` (~lines 66-91) and re-implements
  the lib as `createMockSkillRegenerate` (~lines 94-129), instead of importing the real handler
  registered in `main.js` (`ipcMain.handle('skill:regeneratePhase', ...)`) and the real
  `lib/skill-regenerate.js`.
- The two clamp tests (~lines 273-301 and ~303-329) only assert `assert.ok('ok' in result)` —
  they capture the forwarded args but never actually assert the content/instruction were
  truncated to 20000/4000 chars.

The pure-logic unit tests (`test/task-184-skill-section.unit.test.js`,
`test/task-184-skill-regenerate.unit.test.js`) DO cover the real `lib/skill-section.js` and
`lib/skill-regenerate.js` correctly — this gap is specifically in the e2e IPC-wiring coverage.

## Acceptance Criteria
- [x] `test/task-184-skill-regen.e2e.test.js`'s IPC-handler scenarios import and exercise the
      real `main.js` handler registration (e.g. by extracting/requiring the actual handler
      function the way other IPC-handler tests in this repo do, or by requiring `main.js`'s
      testable IPC-registration surface if one exists) rather than a local
      `createIpcHandler`/`createMockSkillRegenerate` reimplementation.
- [x] A real assertion exists that content longer than 20000 chars is truncated to 20000 before
      being passed to `regeneratePhaseSection`/`httpRequest`, and instruction longer than 4000
      chars is truncated to 4000 — asserting the actual truncated value, not just that a result
      object has an `ok` key.
- [x] The "key never leaves main" scenario asserts against the real handler's returned object
      (not the mock's), confirming no property or nested value contains the API key.
- [x] A regression check: temporarily removing the clamp (or the key-omission) in the real
      `main.js` handler must make the corrected test(s) fail locally (verify, then revert —
      don't leave the change in place).
- [x] The existing unit-test coverage for `lib/skill-section.js`/`lib/skill-regenerate.js` is
      left as-is (it already covers the real modules) — this ticket only fixes the e2e/IPC gap.

## Cucumber Tests
```gherkin
Feature: e2e tests exercise the real skill:regeneratePhase IPC handler
  Scenario: clamp is genuinely asserted against the real handler
    Given content longer than 20000 characters
    When the real skill:regeneratePhase handler processes it
    Then the value passed downstream is truncated to exactly 20000 characters

  Scenario: instruction clamp is genuinely asserted
    Given an instruction longer than 4000 characters
    When the real handler processes it
    Then the value passed downstream is truncated to exactly 4000 characters

  Scenario: key-omission is asserted against the real handler
    When the real handler's result is inspected
    Then no property or nested value contains the API key

  Scenario: regression is caught (failure/edge)
    Given the real handler's clamp were removed
    When the corrected test runs
    Then it fails (proving it actually exercises production code)
```

## Edge & Failure Cases
- Don't change `main.js`'s handler behavior — this is a test-only fix.
- Keep mocking the actual network call (inject a fake `httpRequest` into the real
  `regeneratePhaseSection`) — only the *handler wiring and clamp* need to be real, not a live
  API call.

## Relevant Files & Context
- `test/task-184-skill-regen.e2e.test.js` (~lines 66-129, ~273-329) — the local reimplementations
  and vacuous clamp assertions to replace.
- `main.js` — the real `skill:regeneratePhase` handler (~lines 2129-2167).
- `lib/skill-regenerate.js` — `regeneratePhaseSection`, injectable `httpRequest`.
- `test/task-184-skill-section.unit.test.js`, `test/task-184-skill-regenerate.unit.test.js` —
  the existing, correct unit coverage of the real lib modules (unaffected by this ticket).

## Impact If Not Fixed
A future edit to the real `skill:regeneratePhase` handler could reintroduce unbounded billed
input or start leaking the API key over IPC and still pass CI, because the "e2e" tests never
touch the production handler — only the pure lib logic is protected today, not the IPC wiring
and its clamp/key behavior.

## Build notes
- Coder: added `extractHandlerFn`/`extractConst`/`loadSkillRegenerateHandler` (following the established `test/task-127-exclusive-create.e2e.test.js`/`test/task-130-agent-regenerate.test.js` extraction pattern) to run the REAL main.js handler; added `realSkillRegenerateWithHttp` wrapping the real `lib/skill-regenerate.js` with only `httpRequest` mocked; rewrote clamp assertions to check exact truncated values. Performed a genuine regression check (temporarily removed the clamp in main.js, confirmed exactly the 2 clamp tests went red with concrete before/after values, reverted, confirmed 12/12 green).
- Test-only ticket. Orchestrator independently re-verified: main.js diff is the accumulated session work (not a leftover), full suite 3724 pass, 3 pre-existing baseline failures, 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed main.js's clamp/key-omission logic intact, the `new Function()` extraction reads only trusted local source, and the new assertions genuinely exercise the real handler path; documentation pass found no stale doc references.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
