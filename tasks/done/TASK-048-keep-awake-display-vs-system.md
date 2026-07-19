---
id: TASK-048
title: confirm keep-awake intent — prevent-display-sleep (screen stays on) vs prevent-app-suspension
status: done
created: 2026-07-19T02:28:00Z
updated: 2026-07-19T02:40:00Z
---

## Description
Follow-up from the TASK-036 tech-lead review (product/BA ambiguity). TASK-036 shipped
`powerSaveBlocker.start('prevent-app-suspension')`, which keeps the SYSTEM awake but allows the
DISPLAY to power off / lock. The user's request ("keep the laptop on … like moving the mouse")
implies the SCREEN should stay on.

DECISION (confirmed by the user, 2026-07-19): keep the SCREEN on while tasks run — use
`prevent-display-sleep` (display + system stay awake).

## Acceptance Criteria
- [x] Intended power behavior confirmed with the user: `prevent-display-sleep` (screen stays on).
- [x] `main.js` `startKeepAwake` calls `powerSaveBlocker.start('prevent-display-sleep')` (changed from `'prevent-app-suspension'`).
- [x] The keep-awake tests updated: the drift guard asserting the blocker-type literal now asserts `'prevent-display-sleep'`; comments/gherkin updated. No other keep-awake invariant changed.
- [x] The single-blocker / release-on-shutdown / try-catch / IPC behavior is unchanged apart from the blocker-type string.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Keep-awake matches the user's intended power behavior

  Scenario: The chosen blocker type is applied
    Given a task becomes active
    Then powerSaveBlocker.start is called with 'prevent-display-sleep'

  Scenario: Tests and drift guard match the chosen type (edge)
    Then the keep-awake drift guard asserts the 'prevent-display-sleep' literal against real main.js
```

## Relevant Files and Context
- `main.js:193` — `startKeepAwake` → `powerSaveBlocker.start('prevent-display-sleep')`.
- `test/task-036-keep-awake.e2e.test.js` — drift guard + replica assert `prevent-display-sleep`.

## Edge and Failure Cases
- Single-blocker / shutdown-release / try-catch invariants intact regardless of type.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)

## Orchestration Notes
- Build: single functional change at main.js:193 (`prevent-app-suspension` → `prevent-display-sleep`); rationale comment updated (still names the old type only as a contrast). Tests updated: replica start-call + drift guard assert `prevent-display-sleep`; no invariant weakened. Full suite 1065/1065.
- Test: both kinds green (32/32 keep-awake, full suite 1065). Drift guard pins `powerSaveBlocker.start('prevent-display-sleep')` against REAL main.js source with teeth (reverting the literal fails the guard). No `prevent-app-suspension` code-path literal or test assertion remains.
- Tech-lead review: clean — sole functional change confirmed, all invariants byte-identical, no security regression. Informational only: prevent-display-sleep keeps the screen on (no display-timeout lock) while tasks are active — bounded to active work, released at idle/shutdown; this is the user's explicit choice.
- Post-processing (TASK-035 security review): satisfied via the tech-lead security dimension (bounded exposure, IPC count-only, no injection).
