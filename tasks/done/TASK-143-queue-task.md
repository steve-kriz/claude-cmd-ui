---
id: TASK-143
title: queue task
status: done
created: 2026-07-26T04:53:36.911Z
updated: 2026-07-26T07:02:34.319Z
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-07-26T05:03:02.997Z","finishedAt":"2026-07-26T05:06:29.927Z","durationMs":206930},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-26T06:36:27.841Z","finishedAt":"2026-07-26T06:38:37.222Z","durationMs":129381},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-26T06:40:21.773Z","finishedAt":"2026-07-26T06:54:20.765Z","durationMs":838992},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-26T06:55:10.765Z","finishedAt":"2026-07-26T06:57:59.693Z","durationMs":168928},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-26T06:58:46.761Z","finishedAt":"2026-07-26T07:01:13.442Z","durationMs":146681}]
---

## Description

Today the "Build" button always routes the `/orchestrate build` command through the
in-app **prompt queue**, even when the Claude Code (cmd) pane is idle with no task
running. Clicking Build calls `toggleAutoBuild(tab)`, whose start branch calls
`queueBuild(tab)`, which **pushes** the command onto `tab.promptQueue`, repaints the
queue (so it appears in the queue list/badge), and only then — if
`tab.status === 'finished'` — kicks `tryDispatchNextPrompt`, which shifts it back off
after a delay. When the session has never run (initial `tab.status === 'idle'`), the
queue path does not auto-dispatch at all, so the command just sits in the queue.

The user wants: **when there is no running task, the Build command should go straight
to the Claude Code command prompt (the cmd PTY) instead of via the queue** — written
directly to the terminal, never appearing in the prompt queue. When a task **is**
running (Claude busy, or paused/waiting on a confirmation menu), the command must keep
going through the queue exactly as today, so it is dispatched only once Claude next
goes idle.

**"No running task" is defined for this ticket (confirmed with the user — see
Clarifications) as ALL of:** the cmd pane has a live PTY (`tab.cmd.id` truthy),
`tab.status` is `'idle'` **or** `'finished'` (i.e. NOT `'busy'` and NOT `'waiting'`),
`tab.queueFiring` is false, `tab.promptQueue` is **empty**, and
`isAwaitingTuiSelection(tab)` is false. A brand-new, never-run session sitting at the
initial `'idle'` status counts as "no running task" and gets a direct send (accepted
risk: this may write to a very-freshly-spawned PTY; mitigated by the live-PTY
`tab.cmd.id` guard and the same two-write submit the queue path uses). In every other
case — including whenever the queue already holds prompts — the command is **enqueued**
exactly as today, so already-queued prompts always run first.

The direct-send path must **preserve every safety property** the queue path guarantees
today (the TASK-135 restart-race contract): it must not write to a
non-existent/dying PTY session, must not type into a TUI while Claude is paused on a
selection/confirmation menu, and must use the same two-write submit (command text,
then a separate `\r`). It must not break the drift-guard tests that pin the queue path.

## Acceptance Criteria

- [ ] Clicking Build when there is no running task (live PTY, `tab.status` is `'idle'`
      or `'finished'`, `!tab.queueFiring`, empty `tab.promptQueue`, not awaiting a TUI
      selection) writes the build command **directly** to that tab's PTY via
      `window.api.pty.write(tab.cmd.id, …)` and **does not** push it onto
      `tab.promptQueue`.
- [ ] A brand-new session at the initial `tab.status === 'idle'` (never run) is treated
      as "no running task": clicking Build direct-sends (provided the other conditions
      hold), it does not merely sit in the queue.
- [ ] The directly-sent command never appears in the queue list or the queue count/tab
      badge (queue length stays 0 for that action).
- [ ] The directly-sent command is the full concurrency-carrying command from
      `buildCommandFor(tab)` (i.e. `/orchestrate build --concurrency <N>`), identical to
      what the queue path would have sent.
- [ ] The direct send uses the **two-write submit**: the command text first, then a
      **separate** `\r` write after `QUEUE_ENTER_DELAY_MS`, matching
      `tryDispatchNextPrompt`, and the trailing `\r` write is guarded by
      `if (tab.cmd && tab.cmd.id)`.
- [ ] On a direct send the tab transitions to `busy` (via `setTabStatus`), the prompt is
      recorded once via `logPromptEntry(tab, …, cmd)` (same logging the queue dispatch
      does), and any pending idle timer is cleared.
- [ ] Clicking Build while a task **is** running (`tab.status` is `'busy'` or
      `'waiting'`) enqueues the command onto `tab.promptQueue` (it appears in the queue)
      and does **not** write to the PTY immediately; it is dispatched only when the tab
      next transitions to `finished`.
- [ ] Clicking Build while Claude is paused on a TUI selection/confirmation menu
      (`isAwaitingTuiSelection(tab)` true) does **not** write directly; the command is
      enqueued and held until the menu is resolved and the tab goes idle.
- [ ] Clicking Build while `tab.promptQueue` already contains prompts enqueues the build
      command **behind** them (preserves queue order) and does **not** write directly to
      the PTY — already-queued prompts run first.
- [ ] Clicking Build while there is no live PTY session (`tab.cmd.id` null/falsy, e.g.
      mid kill-and-respawn) does **not** write to any PTY and does not throw; the command
      is enqueued so it dispatches once the session is ready and idle.
- [ ] The auto-build continuation loop (`maybeContinueBuild`) and auto-build-on-create
      (`autoQueueBuildOnCreate`) still go through `queueBuild` / the prompt queue
      unchanged (only the manual Build-button first-run gets the direct-send treatment).
- [ ] `queueBuild` still pushes `buildCommandFor(tab)` and keeps the
      `if (tab.status === 'finished') tryDispatchNextPrompt(tab)` gate, and the codebase
      still has at least 3 occurrences of that idle-gate line, so
      `test/task-135-restart-queue-race.e2e.test.js` drift guards still pass.
- [ ] Exactly one build command reaches the PTY per Build click (no duplicate: it must
      not be both direct-written and left in the queue to fire again).
- [ ] The Stop branch of `toggleAutoBuild` (clicking Build when auto-build is already on)
      is unchanged — direct-send only applies to the start branch — and all existing
      start-branch guards (`!tab.folder`, `!t.skillInstalled`, pending-count 0) still
      short-circuit before any send.
- [ ] No `.claude/` or `assets/` instruction files are changed by this ticket (renderer
      logic only); `renderer/renderer.js` stays consistent with any asset copy.

## Cucumber Tests

```gherkin
Feature: Build sends /orchestrate straight to the terminal when no task is running

  Background:
    Given a claude tab with a live cmd PTY session "session-1"
    And the orchestrate skill is installed
    And the prompt queue is empty
    And Claude is not paused on a TUI selection menu

  Scenario: Build with a finished run writes directly to the PTY
    Given the tab status is "finished"
    When the user clicks Build
    Then "/orchestrate build --concurrency <N>" is written directly to "session-1"
    And a separate "\r" submit is written to "session-1" after the enter delay
    And the prompt queue remains empty (nothing was ever pushed)
    And the queue count badge shows 0
    And the tab status becomes "busy"
    And exactly one build command was written in total

  Scenario: Build on a brand-new idle session also writes directly
    Given the tab status is the initial "idle" and the session has never run
    When the user clicks Build
    Then "/orchestrate build --concurrency <N>" is written directly to "session-1"
    And the prompt queue remains empty
    And the tab status becomes "busy"

  Scenario: Direct send carries the folder's chosen concurrency
    Given the resolved concurrency for the folder is 5
    And the tab status is "finished"
    When the user clicks Build
    Then the payload written directly to the PTY is "/orchestrate build --concurrency 5"

  Scenario: Build while a task is running goes through the queue
    Given the tab status is "busy"
    When the user clicks Build
    Then nothing is written to the PTY
    And the build command is pushed onto the prompt queue
    And the queue count badge shows 1
    When the tab later transitions to "finished"
    Then the build command is dispatched to the PTY exactly once
    And the prompt queue is empty afterwards

  Scenario (edge): Build while Claude is paused on a confirmation menu is held in the queue
    Given the tab status is "finished"
    But Claude is paused on a TUI selection menu
    When the user clicks Build
    Then nothing is written to the PTY
    And the build command is held in the prompt queue
    When the menu is resolved and the tab goes idle again
    Then the build command is dispatched to the PTY exactly once

  Scenario (edge): Build does not jump ahead of already-queued prompts
    Given the tab status is "finished"
    And the prompt queue already contains one earlier prompt
    When the user clicks Build
    Then the build command is appended behind the earlier prompt in the queue
    And nothing is written directly to the PTY for the build command
    And queue order is preserved

  Scenario (failure): Build with no live PTY session writes nothing and does not throw
    Given the cmd session id is null (mid kill-and-respawn)
    And the tab status is "finished"
    When the user clicks Build
    Then no PTY write occurs and no error is thrown
    And the build command is enqueued
    When the session is respawned and the tab transitions to "finished"
    Then the build command is dispatched to the new session exactly once

  Scenario (regression): the auto-build loop still uses the prompt queue
    Given auto-build is on and a build run has just finished with todo work remaining
    When maybeContinueBuild re-triggers a build
    Then the build command is enqueued via queueBuild (the prompt queue), not direct-written
```

## Edge & Failure Cases

- **No live PTY (`tab.cmd.id` null/undefined):** occurs during kill-and-respawn
  (TASK-135). Must not call `window.api.pty.write` with a null id and must not throw;
  fall back to enqueue so the guarded dispatcher delivers it on the next idle.
- **Awaiting TUI selection:** `isAwaitingTuiSelection(tab)` true means a run is
  effectively active and waiting for the user — never direct-write (would accept the
  highlighted menu option). Enqueue and let the existing idle gate hold it.
- **Initial `'idle'` status:** a freshly launched session at the initial `'idle'`
  status DOES count as "no running task" and is direct-sent (per the user's answer),
  provided the live-PTY and empty-queue conditions hold.
- **Non-empty prompt queue:** never jump the queue; append the build command so
  ordering is preserved. Direct send happens ONLY when the queue is empty.
- **Double dispatch:** ensure the command is either direct-written OR queued, never both
  (a direct send must not also leave a copy in `tab.promptQueue` that later fires).
- **`queueFiring` mid-dispatch:** if a dispatch is already in flight, do not
  direct-write; enqueue.
- **Concurrency drift:** the direct payload must be computed from `buildCommandFor(tab)`
  at click time (fresh concurrency), never a stale constant.
- **Skill not installed / no folder / pending count 0:** existing `toggleAutoBuild`
  guards must still short-circuit before any send.
- **Stop toggle:** when auto-build is already on, clicking Build is a Stop action;
  direct-send must only apply to the start branch, not the stop branch.

## Relevant Files & Context

- **`renderer/renderer.js`** — the only source file that needs changing:
  - `toggleAutoBuild(tab)` (~line 10275): the Build button handler (wired at line 607,
    `tab.els.tasksBuildBtn` click). Its start branch currently calls `queueBuild(tab)`.
    This is where the "direct-send when no running task, else queue" decision belongs.
    Keep all existing guards (`!tab.folder`, `!t.skillInstalled`, pending-count 0, the
    Stop branch).
  - `queueBuild(tab)` (~lines 10330-10336): **leave intact** — it must keep
    `tab.promptQueue.push(buildCommandFor(tab))` + the
    `if (tab.status === 'finished') tryDispatchNextPrompt(tab)` gate (pinned by the
    drift guard). Use it as the enqueue fallback.
  - `tryDispatchNextPrompt(tab)` (~lines 5250-5296): the reference implementation for the
    safe submit — copy its exact pattern for the direct path: null-id guard
    (`if (!tab.cmd.id) return;`), `isAwaitingTuiSelection` hold, `setTabStatus(tab,'busy')`,
    clear `tab.idleTimer`, `window.api.pty.write(tab.cmd.id, cmd)`,
    `logPromptEntry(tab, …, cmd)`, then a separate `\r` after `QUEUE_ENTER_DELAY_MS`
    guarded by `if (tab.cmd && tab.cmd.id)`.
  - `isAwaitingTuiSelection(tab)` (~lines 5218-5248): headless-safe (returns false when
    `tab.cmd.term` is null) — reuse to gate the direct send.
  - `buildCommandFor(tab)` (~line 10169) and `isBuildCommand(p)` (~line 10175): build the
    concurrency-carrying payload / recognise it.
  - `setTabStatus(tab, status)` (~lines 1302-1317): status choke point;
    `'finished'`-transition fires `tryDispatchNextPrompt`. `tab.status` values are
    `'idle'` (initial, line 229), `'busy'`, `'waiting'` (paused on menu), `'finished'`
    (idle after a run).
  - `logPromptEntry(tab, source, text)` (~line 3359): source labels in use are `'user'`,
    `'queue'`, `'slack'` — pick a consistent label for the direct build send (e.g.
    `'queue'` or a new `'build'`; non-load-bearing).
  - `QUEUE_SEND_DELAY_MS` (300, line 40) and `QUEUE_ENTER_DELAY_MS` (180, line 41):
    timing constants — reuse, do not hard-code.
  - `maybeContinueBuild(tab)` (~line 10304) and `autoQueueBuildOnCreate(tab)`
    (~line 10347): must remain on the `queueBuild`/queue path (no direct send).
- **`preload.js`** (line 18): `window.api.pty.write(id, data)` →
  `ipcRenderer.invoke('pty:write', { id, data })`. The only IPC used for sending to the
  terminal. No change needed.
- **`main.js`** (lines 391-394): `ipcMain.handle('pty:write', …)` writes to the node-pty
  process. No change needed; cited so the tester knows the full write path.
- **`test/task-135-restart-queue-race.e2e.test.js`** — the pattern to follow for the new
  tests: `node --test` scenario-style Given/When/Then, headless extraction of real
  renderer functions via `extractFn` brace-matching, injected `window`/mock `document`,
  a **recording** `window.api.pty.write` stub keyed by session id, no real
  PTY/Electron/network. Its DRIFT GUARD tests (lines 387-419) pin `queueBuild`'s body,
  `setTabStatus`'s finished-transition, `tryDispatchNextPrompt`'s null-id/`\r` contract,
  and require ≥3 idle-gate sites — the new work must keep all of these passing. Model the
  new e2e test file (e.g. `test/task-143-build-direct-send.e2e.test.js`) on this harness.
- Test runner is `node --test`; the `cucumber` npm package is NOT installed and must not
  be added. Mock all I/O. `renderer/renderer.js` is a browser script with no
  `module.exports`, so tests extract functions by brace-matching.

## Clarifications

- **Q (fresh session): should a brand-new, never-run idle session count as "nothing running" and get a direct send?**
  A: Yes — fresh session counts too. `tab.status === 'idle'` (initial) as well as `'finished'` qualifies for direct send (busy/waiting always queue). Accepted risk: direct-writing to a very-fresh PTY; mitigated by the live-PTY `tab.cmd.id` guard.
- **Q (queue order): if prompts are already queued and Claude is idle, jump ahead to the terminal or wait behind them?**
  A: Wait behind queued prompts. Direct send happens ONLY when `tab.promptQueue` is empty; otherwise the build command is appended behind existing prompts and dispatched in order.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
