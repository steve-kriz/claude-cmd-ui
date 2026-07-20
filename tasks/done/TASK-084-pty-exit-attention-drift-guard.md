---
id: TASK-084
title: Anchor the pty:exit window-attention drift guard to its real call site
status: done
created: 2026-07-19T23:42:21Z
updated: 2026-07-20T00:28:40Z
review-of: TASK-078
activities: [{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:22:37Z","finishedAt":"2026-07-20T00:26:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T00:26:00Z","finishedAt":"2026-07-20T00:28:40Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T00:28:40Z","finishedAt":"2026-07-20T00:28:40Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-078 (Finding 1, Low, test-only). The drift
guard that pins the `pty:exit` re-report of `reportWindowAttention()` uses a loose regex
`/reportWindowAttention\(\);\s*\n\s*\}\);/` which matches ANY `reportWindowAttention();`
immediately followed by `});` — it is not tied to the `onExit`/`pty:exit` handler
(`renderer/renderer.js` ~9105). If the real pty-exit re-report were deleted while any
other `reportWindowAttention();\n});` shape existed elsewhere, the guard would still pass.

Tighten the guard so it genuinely pins the pty-exit re-report call site (e.g. anchor the
match to the `onExit`/`pty:exit` handler region, or assert the call appears within that
handler's body specifically).

## Acceptance Criteria
- [ ] The drift guard for the pty-exit re-report asserts that `reportWindowAttention()` is
  invoked specifically within the `pty:exit` / pty `onExit` handler in
  `renderer/renderer.js`, not merely somewhere followed by `});`.
- [ ] Deleting the pty-exit re-report call in `renderer/renderer.js` (and no other change)
  causes this guard to FAIL (verify by reasoning about the regex/anchor, or a temporary
  local check — do not commit the deletion).
- [ ] No product/implementation code is changed — this is a test-only ticket.
- [ ] `node --test` green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: The pty-exit attention drift guard is anchored to its call site

  Scenario: The guard is tied to the pty:exit handler
    Given the window-attention e2e drift-guard test
    Then it asserts reportWindowAttention() is called inside the pty exit handler
    And not merely anywhere followed by "});"

  Scenario: Removing the pty-exit re-report fails the guard (failure)
    Given the real pty-exit reportWindowAttention() call is removed
    When the drift-guard test runs
    Then it fails
```

## Impact If Not Fixed
A future refactor could silently drop the pty-exit re-report, leaving the taskbar flashing
after the last waiting/finished pty exits, with the test suite still green and no signal to
the developer.

## Edge Cases & Failure Paths
- The anchor must tolerate benign whitespace/formatting but still fail on deletion or on
  moving the call out of the pty-exit handler.
- Do not weaken the other call-site guards (setTabStatus, closeTab, board poll, focus/blur)
  when tightening this one.

## Relevant Files & Context
- `test/window-attention.e2e.test.js` ~591 (the "reportWindowAttention is called from every
  required site" drift guard).
- `renderer/renderer.js` ~9105 (the real `pty:exit`/`onExit` re-report call site).
- Origin: tech-lead review of TASK-078, Finding 1 (Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
