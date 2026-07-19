---
id: TASK-049
title: release the keep-awake wake-lock when the renderer is gone/unresponsive
status: done
created: 2026-07-19T02:29:00Z
updated: 2026-07-19T03:50:00Z
---

## Description
Follow-up from the TASK-036 tech-lead review (LOW — robustness/resource). Keep-awake activity
is only re-reported from the renderer (`renderTasksBoard` and `closeTab`). If the renderer
process crashes, hangs, or is reloaded while the last reported active count was > 0, `main.js`
retains that count and keeps the `powerSaveBlocker` held with no further updates. Release is
still guaranteed on `will-quit` / `window-all-closed` / window `closed`, so it is
app-lifetime-bounded (not a permanent leak), but it is an unnecessary battery-drain window with
a stale wake-lock. There is no `webContents` `render-process-gone` / `unresponsive` handler or
heartbeat/timeout that resets the count to 0.

## Acceptance Criteria
- [ ] When the renderer process is gone (`webContents` `render-process-gone`) or the window
      reloads, the keep-awake count is reset to 0 and the wake-lock is released (until the
      renderer re-reports a positive count).
- [ ] Optionally, an `unresponsive` signal is handled the same way (or a heartbeat/timeout
      resets the count if no activity report arrives within a bounded interval) — pick the
      lightest reliable approach and document it.
- [ ] The existing single-blocker / shutdown-release / try-catch invariants are preserved.
- [ ] No wake-lock is held after a renderer-gone event with no live renderer reporting.
- [ ] Tests cover: renderer-gone while count>0 -> blocker stopped; renderer re-reports>0 -> blocker restarts.
- [ ] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Keep-awake does not leak while the renderer is gone

  Scenario: Renderer crash releases the wake-lock
    Given a wake-lock is held for active tasks
    When the renderer process is gone (render-process-gone)
    Then the keep-awake count resets to 0 and the wake-lock is stopped

  Scenario: Recovery re-engages on next report (edge)
    Given the wake-lock was released after a renderer-gone event
    When the (reloaded) renderer reports a positive active count
    Then the wake-lock is started again
```

## Relevant Files and Context
- `main.js` — the wake-lock manager (`updateKeepAwake`/`startKeepAwake`/`stopKeepAwake`), IPC `tasks:activity`, and the existing shutdown hooks (`closed`/`window-all-closed`/`will-quit`); add a `webContents.on('render-process-gone', ...)` (and/or `unresponsive`) reset.
- `renderer/renderer.js` — `reportTasksActivity()` (only re-reports on board render / closeTab).
- `test/task-036-keep-awake.*.test.js` — extend the manager replica + drift guards for the new reset path.

## Edge and Failure Cases
- Renderer-gone with count 0 -> already released, no-op.
- Rapid reload -> no double-start; single blocker maintained.
- powerSaveBlocker throwing during the reset -> wrapped in try/catch, no crash.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
