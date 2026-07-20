---
id: TASK-078
title: Window and tab attention when Claude is waiting for input
status: done
created: 2026-07-19T20:57:02.829Z
updated: 2026-07-19T23:44:36Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-19T22:20:46Z","finishedAt":"2026-07-19T22:34:12Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T23:28:54Z","finishedAt":"2026-07-19T23:32:50Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T23:32:50Z","finishedAt":"2026-07-19T23:37:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T23:37:00Z","finishedAt":"2026-07-19T23:42:21Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T23:42:21Z","finishedAt":"2026-07-19T23:44:36Z"}]
---

## Description
When Claude (the pty session in a tab) pauses on a confirmation/selection menu and
needs the user's input — or finishes and is idle awaiting the next prompt, or a board
ticket is waiting for an answer — the only cue today is a static in-app tab color. If
the window is backgrounded or on another monitor the user misses it and the run stalls.

Make the "needs attention" state impossible to miss, at two levels:

1. **Tab pulse (in-app):** the yellow waiting tab pulses (CSS animation on
   `.ws-tab.status-waiting`, reusing the `task-card-dot-pulse-waiting` convention in
   `renderer/styles.css` ~2726-2755). `busy`/`idle` tabs do not pulse.
2. **Window attention (OS-level):** while an attention condition holds **and the window
   is not focused**, request OS attention via Electron `BrowserWindow.flashFrame(true)`
   (Windows taskbar flash / macOS dock bounce). Clear it (`flashFrame(false)`) as soon
   as the window gains focus or no attention condition remains.

**Attention conditions (per user decision — all three count):** the OS flash fires when
ANY of these is true (and the window is unfocused):
- a tab is in the `waiting` status (Claude paused on a TUI confirmation/menu),
- a tab is in the `finished` status (idle, awaiting the next prompt),
- a board ticket is waiting for an answer (`question` set with no `answer` —
  `isTicketWaitingForAnswer`, `renderer/renderer.js` ~5221-5223 /
  `lib/ticket-questions.js`).

Architecture (follow the TASK-036 keep-awake pattern exactly):
- New Electron-free pure module `lib/window-attention.js` exporting
  `shouldRequestAttention({ attentionCount, windowFocused })` → boolean (true iff
  `attentionCount > 0 && windowFocused === false`; tolerant of junk/missing inputs,
  never throws). Unit-testable with plain `node --test`.
- `preload.js`: expose `window.api.attention.report(attentionCount)` as a
  fire-and-forget `ipcRenderer.send('window:attention', count)` (mirror of
  `tasks.reportActivity`, `preload.js` ~59-64).
- `main.js`: `ipcMain.on('window:attention', …)` computes the verdict with the lib
  helper (using `mainWindow.isFocused()`), then calls `mainWindow.flashFrame(verdict)`
  guarded by `mainWindow && !mainWindow.isDestroyed()` and try/catch, deduped so a
  repeated identical verdict is a no-op (mirror the keep-awake guards ~208-230). Also:
  `mainWindow.on('focus', …)` always calls `flashFrame(false)`, and
  `render-process-gone` / `unresponsive` clear the flash (mirror ~135-142).
- `renderer/renderer.js`: a single aggregator `reportWindowAttention()` (mirror of
  `reportTasksActivity` ~6074-6085) computes `attentionCount` = (count of tabs whose
  `status` is `waiting` or `finished`) + (count of board tickets with
  `isTicketWaitingForAnswer`) across ALL tabs/tickets, and reports it. Call it from
  `setTabStatus` (the single status choke point ~1136), from `closeTab` (~791), from the
  `pty:exit` handler (~9061), from the tasks board poll where ticket
  question/answer state is known, and from DOM `window` `focus`/`blur` listeners so
  focus changes re-evaluate immediately.

**Out of scope (per user decision):** native OS `Notification` toasts and a new in-app
notification-bar component. The tab pulse + OS taskbar flash cover the intent.

## Acceptance Criteria
- [ ] A tab whose status is `waiting` pulses visibly (CSS animation on the tab and/or
  its dot); `busy`, `idle`, and `finished` tabs do not pulse.
- [ ] The pulse stops as soon as the tab leaves the `waiting` status.
- [ ] New pure module `lib/window-attention.js` exports
  `shouldRequestAttention({ attentionCount, windowFocused })`: returns true iff
  `attentionCount > 0 && windowFocused === false`; returns false (never throws) for
  missing/junk inputs (`null`, `undefined`, negative, `NaN`, strings, objects).
- [ ] `preload.js` exposes a fire-and-forget attention report channel
  (`ipcRenderer.send('window:attention', …)`), following the `tasks.reportActivity`
  shape.
- [ ] The renderer aggregator computes `attentionCount` as the number of tabs in
  `waiting` OR `finished` status PLUS the number of board tickets that are waiting for
  an answer (`isTicketWaitingForAnswer`).
- [ ] `main.js` handles `window:attention`: when `attentionCount > 0` AND the window is
  unfocused, `mainWindow.flashFrame(true)` is called; when `attentionCount === 0`,
  `flashFrame(false)` is called. Every `flashFrame` call is guarded (window may be
  destroyed; API may throw) and deduped (no repeated identical calls).
- [ ] Focusing the window always clears the flash (both the `focus` event in main and
  the renderer's focus listener re-report → verdict false).
- [ ] An attention condition while the window IS focused never triggers the OS flash
  (the in-app cue alone suffices while focused).
- [ ] Multiple concurrent attention conditions produce a single window-attention state;
  the flash clears only when NONE remain (or the window gains focus).
- [ ] Closing a waiting/finished tab, or its pty exiting, re-reports and clears the
  flash if it was the last attention condition.
- [ ] Renderer crash/hang (`render-process-gone` / `unresponsive`) clears any active
  flash in main (no stuck-flashing taskbar).
- [ ] Repeated pty output ticks while an attention condition already holds do not spam
  IPC/`flashFrame` (report on transitions, or main dedupes — the observable
  `flashFrame` call count must not grow per tick).

## Cucumber Tests
```gherkin
Feature: Window and tab attention when Claude is waiting for input

  Scenario: An attention condition while unfocused requests attention
    Given one tab whose status is "waiting"
    And the window is not focused
    When the attention verdict is computed
    Then shouldRequestAttention returns true
    And main calls flashFrame(true) exactly once

  Scenario: Finished (idle) tab also counts as attention
    Given one tab whose status is "finished"
    And the window is not focused
    Then shouldRequestAttention returns true

  Scenario: A board ticket waiting for an answer also counts
    Given no tab is waiting or finished
    And one board ticket has a question and no answer
    And the window is not focused
    Then attentionCount is at least 1 and shouldRequestAttention returns true

  Scenario: An attention condition while focused does not flash
    Given one tab whose status is "waiting"
    And the window is focused
    Then shouldRequestAttention returns false
    And flashFrame(true) is never called

  Scenario: Gaining focus clears the flash
    Given the window is flashing because a tab is waiting
    When the window gains focus
    Then flashFrame(false) is called
    And the tab keeps its waiting pulse until the menu is answered

  Scenario: Last attention condition resolving clears the flash
    Given two tabs are waiting and the window is unfocused and flashing
    When one tab's menu is answered and its status becomes "busy"
    Then the flash remains (one tab still waiting)
    When the second tab leaves "waiting" and no other condition holds
    Then flashFrame(false) is called

  Scenario: Waiting tab pulses on the tab strip
    Given a tab enters the "waiting" status
    Then the tab button carries the status-waiting class
    And the stylesheet defines a pulse animation bound to status-waiting
    And no pulse animation is bound to status-busy

  Scenario: Edge - junk report payloads never throw
    Given the attention channel receives null, "abc", -1, NaN and {}
    When main computes the verdict for each
    Then no exception is raised
    And flashFrame is called with false or not at all

  Scenario: Edge - destroyed window
    Given the main window has been destroyed
    When an attention report arrives
    Then no flashFrame call is attempted and nothing throws

  Scenario: Edge - renderer crash clears attention
    Given the window is flashing
    When the renderer process is gone
    Then the flash is cleared
```

## Edge Cases & Failure Paths
- `flashFrame` unavailable or throwing on some platform: every call wrapped in
  try/catch; failure logged, never crashes (mirror keep-awake guards ~208-230).
- `mainWindow` null or destroyed when a report arrives (shutdown race): guard with
  `mainWindow && !mainWindow.isDestroyed()`.
- Junk IPC payload (renderer bug / non-number): coerce like the `tasks:activity`
  handler (~242-247); verdict false, no throw.
- Repeated identical verdicts: dedupe so the OS is not spammed with `flashFrame(true)`
  per pty data tick.
- Tab closed while waiting/finished (`closeTab` ~791) and pty exit while waiting
  (`pty:exit` ~9061): both must re-report.
- Renderer crash/hang while flashing: `render-process-gone` / `unresponsive` in main
  clear the flash (pattern ~135-142).
- The `.active` tab CSS override (`styles.css` ~109-117) must keep winning for
  background color; the pulse must remain visible (pulse the dot, or scope the pulse to
  `.ws-tab.status-waiting:not(.active)`).
- False-positive waiting detection: `isAwaitingTuiSelection` is heuristic; the attention
  layer must simply follow the status machine, adding no second heuristic of its own.
- Window focused but a different tab is waiting: no OS flash (window focused), but the
  tab pulse must make it visible.
- Board ticket question/answer state changes between polls: the aggregator must
  re-evaluate on the tasks board poll so a newly-answered question drops attentionCount.

## Relevant Files & Context
- `renderer/renderer.js` — `setTabStatus` ~1136-1147 (single choke point);
  `bumpIdleTimer` ~1149-1162; `scheduleWaitingCheck` ~1167-1176; `onCmdData` ~1178-1194;
  `isAwaitingTuiSelection` ~5051-5081; `activateTab` ~767-789 (finished→idle
  clear-on-view precedent); `closeTab` ~791-820; `reportTasksActivity` ~6074-6085 (the
  aggregate+report pattern to mirror); `isTicketWaitingForAnswer` ~5221-5223; tasks
  board poll; pty onData/onExit wiring ~9045-9065.
- `renderer/styles.css` — tab status styles ~83-117; pulse keyframe conventions
  ~2726-2755 (`task-card-dot-pulse`, `task-card-dot-pulse-waiting`).
- `renderer/index.html` — tab template `#workspaceTabTpl` ~693-700; tab strip
  `#workspaceTabs` ~15.
- `preload.js` — `tasks.reportActivity` ~59-64 (fire-and-forget bridge shape to copy).
- `main.js` — `tasks:activity` handler ~242-247; keep-awake guard/dedupe pattern
  ~196-250; `createWindow` + crash handlers ~106-165 (add `focus` listener and
  crash-clear here).
- `lib/keep-awake.js` — the pure-decision-module precedent for `lib/window-attention.js`.
- `lib/ticket-questions.js` — `isTicketWaitingForAnswer` canonical source.
- Conventions: pure lib + renderer inline mirror; `node --test` runner; tests mock all
  side effects (no real Electron window / no real DB).

## Clarifications
- Q (078 mechanisms): how far should attention go?
  A: Tab pulse (in-app) + OS taskbar/dock flash (`flashFrame`) only. No native OS
  notification toast and no new in-app notification-bar component. (This removes the
  conditional TASK-084 split — not created.)
- Q (078 focus rule): should the OS flash fire only when unfocused?
  A: Yes — OS flash only while the window is unfocused; the in-app tab pulse shows
  regardless of focus.
- Q (078 triggers): which states count as "needs attention"?
  A: All three — a tab in `waiting`, a tab in `finished` (idle), AND a board ticket
  waiting for an answer (`question` without `answer`). `attentionCount` sums all three.
- Q (078 clear): when does the flash clear?
  A: On window focus (or when no attention condition remains). The tab pulse stays until
  the waiting tab is answered.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
