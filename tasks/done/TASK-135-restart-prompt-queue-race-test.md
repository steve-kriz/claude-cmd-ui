---
id: TASK-135
title: Test that a queued /orchestrate command dispatches into the new session after skill-registration restart
status: done
created: 2026-07-21T09:01:45.000Z
updated: 2026-07-21T10:36:32.000Z
review-of: TASK-131
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T09:49:30.000Z","finishedAt":"2026-07-21T09:53:30.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T10:24:26.000Z","finishedAt":"2026-07-21T10:24:26.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T10:24:26.000Z","finishedAt":"2026-07-21T10:33:00.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T10:33:00.000Z","finishedAt":"2026-07-21T10:36:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T10:36:00.000Z","finishedAt":"2026-07-21T10:36:32.000Z"}]
---

## Description

Tech-lead review of TASK-131 found a test-coverage gap for the "Restart races the
prompt queue" edge case. TASK-131's cucumber scenario asserts that after the user
clicks Restart, a subsequently queued `/orchestrate build` is typed into the NEW
session — not the dying/half-started one. The shipped e2e test ("Restart
relaunches") only proves `tab.cmd.id` changed to a new value; it never enqueues a
command nor exercises the dispatch-ordering gate (`tryDispatchNextPrompt` / the
`tab.status === 'finished'` prompt-ready gate), so the guarantee is only indirectly
implied.

The real ordering mechanism this ticket must pin down (pre-existing code TASK-131
depends on but does not modify):

- The Restart button in `promptSkillRegistration` (renderer/renderer.js:~9697)
  awaits `launchCmdAgent(tab)` (~:1126), which kills the old PTY (setting
  `tab.cmd.id = null` mid-kill) and respawns via `spawnTerm` (~:1239), assigning a
  brand-new session id. `launchCmdAgent` does NOT touch `tab.status`, so the status
  can remain stale-`finished` until the new session's first output flips it to
  `busy` via `onCmdData` → `setTabStatus` (~:1344, ~:1298).
- `setTabStatus(tab, 'finished')` (~:1303-1306) is the only idle-driven dispatch
  trigger: on a transition INTO `finished` it calls `tryDispatchNextPrompt(tab)`.
- `tryDispatchNextPrompt` (~:5246) guards on `tab.queueFiring`, a non-empty
  `tab.promptQueue`, and a truthy `tab.cmd.id`; then after `QUEUE_SEND_DELAY_MS`
  (300ms) RE-CHECKS `tab.status !== 'finished'` and aborts (releasing `queueFiring`)
  if the tab went busy — the gate that stops a stale-`finished` enqueue from firing
  into a half-started session. On dispatch it `shift()`s exactly one prompt and
  writes it to the CURRENT `tab.cmd.id`, with the `\r` submit following after
  `QUEUE_ENTER_DELAY_MS` (180ms) guarded by `tab.cmd && tab.cmd.id`.
- Every enqueue site uses `if (tab.status === 'finished') tryDispatchNextPrompt(tab)`
  (~:5205, ~:10054, ~:10759).

This ticket adds the missing regression test that drives the REAL
`tryDispatchNextPrompt` (and the real `setTabStatus` finished-transition trigger)
headless — extracted by the brace-matching convention already used in
`test/task-131-skill-registration.e2e.test.js` — proving a queued `/orchestrate
build` after a skill-registration Restart is delivered exactly once, to the new
session id, and only once the new session reaches `finished`. No production code
change is expected; `renderer/renderer.js` must not change.

## Impact If Not Fixed

Low. The behavior currently works via existing gating, but a future change to
`tryDispatchNextPrompt` or the autolaunch/prompt-ready flow could let a queued build
command be typed into a torn-down or half-started session with no failing test to
catch it — sending `/orchestrate build`/`plan` into the wrong session and producing
a confusing no-op or lost command for the user.

## Acceptance Criteria

- [ ] A test exists (extending `test/task-131-skill-registration.e2e.test.js` or a
  new file `test/task-135-restart-queue-race.e2e.test.js`) that extracts and runs the
  REAL `tryDispatchNextPrompt` and the REAL `setTabStatus` from
  `renderer/renderer.js` (brace-matching `extractFn` convention, injected stubs for
  collaborators) — the dispatch gate itself must not be stubbed or re-implemented.
- [ ] Happy path: given a tab whose skill-registration Restart succeeded (real
  `promptSkillRegistration` Restart click, `launchCmdAgent` stub that clears then
  swaps `tab.cmd.id` to a new id, mirroring the real kill-and-respawn), a queued
  `/orchestrate build` is NOT written to any PTY while the new session's status is
  `busy`; once the test drives `setTabStatus(tab, 'finished')` for the new session
  and the `QUEUE_SEND_DELAY_MS`/`QUEUE_ENTER_DELAY_MS` timers elapse, the command is
  written to the NEW session id followed by a separate `\r` write.
- [ ] Race path: a build enqueued during the stale-`finished` window (after Restart,
  before the new session's first output) starts the dispatcher, but when the status
  flips to `busy` within the 300ms re-check window the dispatch ABORTS —
  `tab.queueFiring` is released, the command stays in `tab.promptQueue`, and nothing
  was written — then dispatches normally on the new session's `finished` transition.
- [ ] Exactly-once and wrong-session assertions: the `window.api.pty.write` recording
  stub is keyed by session id and the test asserts (a) ZERO writes ever target the
  pre-restart session id, (b) the `/orchestrate build` payload is written exactly
  once across the whole scenario (no duplicate dispatch from the `queueFiring`
  re-entrancy path), and (c) `tab.promptQueue` is empty afterwards.
- [ ] Mid-kill no-op: with `tab.cmd.id === null` (the window inside `launchCmdAgent`
  between kill and respawn), calling `tryDispatchNextPrompt` returns without writing
  and without setting `tab.queueFiring`.
- [ ] The test uses scenario-style `node --test` cases (Given/When/Then comments, no
  cucumber npm package), handles the real 300ms/180ms timers deterministically
  (node:test mock timers or awaited real delays), and stubs ALL side-effecting
  collaborators (no real PTY/Electron/network).
- [ ] No production code changes: `renderer/renderer.js` (and all other non-test
  files) are untouched.
- [ ] All existing tests stay green; only the 2 known baseline failures remain.

## Cucumber Tests

```gherkin
Feature: Queued /orchestrate build dispatches only into the new session after a skill-registration restart
  The prompt queue's idle gate (tab.status === 'finished' + tryDispatchNextPrompt)
  must guarantee that a build command queued around a skill-registration Restart is
  typed exactly once, into the NEW Claude session, never the dying/old one.

  Background:
    Given a claude tab with a live cmd PTY whose session id is "session-old"
    And the orchestrate skill was just installed and the restart notice is showing
    And window.api.pty.write is a recording stub keyed by session id

  Scenario: Build queued after restart waits for the new session to become prompt-ready
    Given the user clicked Restart and launchCmdAgent respawned the session as "session-new"
    And the new session's first output has set the tab status to "busy"
    When "/orchestrate build" is enqueued through the guarded enqueue path
    Then no PTY write occurs while the tab status is not "finished"
    When the new session goes idle and setTabStatus transitions the tab to "finished"
    And the queue send and enter delays elapse
    Then "/orchestrate build" is written to "session-new" exactly once
    And a separate "\r" submit write follows to "session-new"
    And the prompt queue is empty

  Scenario: Restart races the prompt queue — stale-finished enqueue aborts and re-fires once
    Given the user clicked Restart and tab.cmd.id now reads "session-new"
    But the tab status is still stale "finished" because the new session has produced no output yet
    When "/orchestrate build" is enqueued and the dispatcher starts firing
    And the new session's first output flips the tab status to "busy" before the 300ms re-check
    Then the dispatch aborts without writing to any session
    And tab.queueFiring is released and "/orchestrate build" remains in the queue
    When the new session later transitions to "finished"
    Then "/orchestrate build" is dispatched exactly once, to "session-new"

  Scenario (failure): The command is never delivered to the pre-restart session
    Given the full restart-then-queue-then-dispatch flow has completed
    Then the recording stub shows zero writes addressed to "session-old"
    And exactly one "/orchestrate build" write in total across the scenario

  Scenario (edge): Dispatch during the kill window is a safe no-op
    Given the old session was killed and tab.cmd.id is null (respawn not finished)
    And "/orchestrate build" is in the prompt queue
    When tryDispatchNextPrompt runs
    Then it returns without writing to any PTY
    And tab.queueFiring is not set, so a later "finished" transition can still dispatch
```

## Edge Cases and Failure Modes

- **Stale-`finished` window**: `launchCmdAgent` never resets `tab.status`, so between
  the Restart click and the new session's first output the status can still read
  `finished` from the old session. An enqueue in that window starts the dispatcher;
  the 300ms `tab.status !== 'finished'` re-check inside the `setTimeout` is what saves
  it. This is the core race.
- **Old-session delivery**: zero writes may target the pre-restart id. The write uses
  `tab.cmd.id` read at fire time, so the stub must key writes by the id passed to
  `pty.write`, not by tab identity.
- **Mid-kill null id**: `if (!tab.cmd.id) return;` before `queueFiring` is set —
  verify no lockout is left behind.
- **Exactly-once**: `tab.queueFiring` re-entrancy guard plus the single
  `promptQueue.shift()` — assert no duplicate dispatch.
- **`\r` follow-up guard**: the Enter write is guarded by `tab.cmd && tab.cmd.id`;
  the happy-path assertion should see exactly one text write and one `\r` write, both
  to the new id.
- **`isAwaitingTuiSelection` headless**: the real function returns `false` when
  `tab.cmd.term` is null/lacks a buffer, so extracting the real one is safe headless —
  do not stub it to `true`, or every dispatch will hold.
- **Timer determinism**: `QUEUE_SEND_DELAY_MS = 300` and `QUEUE_ENTER_DELAY_MS = 180`
  are real timeouts in the extracted code. Use `node:test` mock timers or short
  awaited real delays; the race scenario requires controlling the ordering explicitly.
- **`setTabStatus` transition-only trigger**: dispatch fires only on a transition INTO
  `finished` (`prev !== 'finished'`); calling it again with `finished` must not
  double-dispatch.
- **Test-only failure mode**: if extraction of `tryDispatchNextPrompt` / `setTabStatus`
  fails (function renamed), the `extractFn` assertion must fail loudly.

## Relevant Files and Context

- `test/task-131-skill-registration.e2e.test.js` — the file to extend (or mirror in a
  new `test/task-135-restart-queue-race.e2e.test.js`). Reuse: `extractFn`
  brace-matching (handles `async`), `new Function('window','document','console','deps', body)`
  headless loading, the mock DOM, `fire`/`flush`, `makeHarness` (its `launchCmdAgent`
  stub swaps `tab.cmd.id` — extend it to record the old id and set `tab.cmd.id = null`
  before assigning the new one), `makeClaudeTab` (add `promptQueue: []`,
  `queueFiring: false`, `idleTimer: null`, `els.queueToggleBtn`/`els.tabBtn` mock
  elements with `classList`).
- `renderer/renderer.js` — subject under test. Key locations: `:39-41` timing
  constants (inject/prepend); `:1126` `launchCmdAgent` (stub, reproduce null-then-new-id);
  `:1298` `setTabStatus` (extract REAL; inject its collaborators except
  `tryDispatchNextPrompt`); `:5246` `tryDispatchNextPrompt` (extract REAL; inject
  `isAwaitingTuiSelection` real, `renderQueue`/`logPromptEntry` no-ops,
  `window.api.pty.write` recording stub); `:5205`/`:10054`/`:10759` guarded enqueue
  pattern (extract `queueBuild` or push + mirror the guard, add a task-030-style
  source drift-guard regex); `:9697` `promptSkillRegistration` (reuse from TASK-131
  test); `:1315`/`:1344` how the new session reaches `finished` (represent "new
  session output" by calling extracted `setTabStatus(tab,'busy')` then
  `setTabStatus(tab,'finished')`).
- `test/task-030-plan-button.e2e.test.js` — precedent for drift-guarding the
  guarded-enqueue source line by regex.
- `test/window-attention.e2e.test.js` — precedent for a `setTabStatus` mirror; this
  test must go further and extract the real one.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
