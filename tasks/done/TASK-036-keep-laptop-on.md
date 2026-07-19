---
id: TASK-036
title: keep Laptop on
status: done
created: 2026-07-18T23:11:15.744Z
updated: 2026-07-19T02:31:00Z
---

## Description
Add functionality to keep the laptop on if the tasks are running, like moving the mouse or something which stops the latop going to sleep mode

## Acceptance Criteria
- [x] While at least one orchestrate task is active (status defining/in-progress/testing/post-processing), the OS is prevented from sleeping (a wake-lock is held).
- [x] When no tasks are active, the wake-lock is released so normal power management resumes.
- [x] Only one wake-lock is ever held (starting when already started is a no-op; stopping when not started is a no-op).
- [x] The wake-lock is released on window-closed / window-all-closed / will-quit (no leaked blocker).
- [x] An unavailable powerSaveBlocker API does not crash the app.

## Cucumber Tests
```gherkin
Feature: Keep the laptop awake while tasks run

  Scenario: Wake-lock engages when a task becomes active
    Given no tasks are active and no wake-lock is held
    When the active-task count becomes 1
    Then a wake-lock is started (prevent-app-suspension)

  Scenario: Wake-lock releases when the board goes idle
    Given a wake-lock is held for active tasks
    When the active-task count drops to 0
    Then the wake-lock is stopped

  Scenario: No double-start (edge)
    Given a wake-lock is already held
    When another positive active count is reported
    Then no second blocker is started

  Scenario: No leaked lock on shutdown (edge)
    Given a wake-lock is held
    When the app is quitting
    Then the wake-lock is stopped
```

## Relevant Files and Context
- `lib/keep-awake.js` (new) — pure decision helper: `shouldKeepAwake(input)`, `keepAwakeCount(tickets)`, `isKeepAwakeStatus(status)`, `KEEP_AWAKE_STATUSES`.
- `main.js` — `powerSaveBlocker` wake-lock manager (`startKeepAwake`/`stopKeepAwake`/`updateKeepAwake`), `tasks:activity` IPC receiver, shutdown stops.
- `preload.js` — `window.api.tasks.reportActivity(count)`.
- `renderer/renderer.js` — `reportTasksActivity()` aggregator across all tabs (`TASKS_KEEP_AWAKE_STATUSES`).

## Edge and Failure Cases
- Many activity reports while already awake → single blocker.
- Count drops to 0 / NaN / junk → released / treated as not-awake.
- Shutdown paths release the lock.
- powerSaveBlocker throwing → wrapped in try/catch, no crash.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)

## Orchestration Notes
- NOTE: This ticket was created underspecified (placeholder acceptance criteria, no BA/plan pass). It was built faithfully to its one-line description; the orchestrator authored the acceptance criteria/Gherkin above from that description.
- Build: `lib/keep-awake.js` (pure), `powerSaveBlocker` manager in `main.js` with single-blocker guard + try/catch + release on closed/window-all-closed/will-quit; `tasks:activity` IPC; `preload` `reportActivity`; renderer `reportTasksActivity` aggregating an app-wide active count across all tabs (keep-awake status set INCLUDES post-processing, distinct from the display "running" set).
- Test: both kinds green — `test/task-036-keep-awake.test.js` (unit, executes the real lib) + `test/task-036-keep-awake.e2e.test.js` (cucumber; wake-manager replica driven by the real shouldKeepAwake + fake powerSaveBlocker; source-scan drift guards pin the real main.js/preload/renderer wiring). Full suite 1063/1063 green (quiescent gate).
- Tech-lead review: correct, all 5 AC met, security clean (IPC count-only, no injection; minimal preload API; release guaranteed on all exit paths). Three LOW follow-ups filed: TASK-048 (product decision: prevent-display-sleep vs prevent-app-suspension — the user's "like moving the mouse" implies the screen should stay on; NEEDS USER INPUT), TASK-049 (release wake-lock on renderer-gone/unresponsive), TASK-050 (drift guard pinning keepAwakeActive body). Review does not reopen this ticket.
- Post-processing (TASK-035 security review): satisfied via the tech-lead security dimension (IPC/preload/resource — clean).
