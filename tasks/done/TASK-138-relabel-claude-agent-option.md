---
id: TASK-138
title: Relabel the "cmd · claude" agent option on macOS/Linux
status: done
created: 2026-07-21T09:54:54.000Z
updated: 2026-07-21T11:02:16.000Z
review-of: TASK-133
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T09:56:00.000Z","finishedAt":"2026-07-21T09:59:30.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T10:55:00.000Z","finishedAt":"2026-07-21T10:56:40.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T10:56:40.000Z","finishedAt":"2026-07-21T10:59:40.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T10:59:40.000Z","finishedAt":"2026-07-21T11:02:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T11:02:00.000Z","finishedAt":"2026-07-21T11:02:16.000Z"}]
---

## Description

Tech-lead review of TASK-133 found the agent `<select>` has two sibling options
formatted `<shell> · <agent>`. On non-win32, TASK-133 relabels only the opencode
option (`git bash · openCode` → `shell · openCode`, renderer.js:842-844) but leaves
the claude option as `cmd · claude`. On macOS/Linux the "cmd" pane is the user's
login shell, not `cmd.exe`, so `cmd · claude` still names a Windows shell — exactly
the class of copy TASK-133 set out to eliminate — and it sits right next to the
correctly relabeled `shell · openCode`, making the dropdown internally inconsistent.
TASK-133's AC group C enumerated only the opencode option (index.html:161) and missed
the sibling claude option (index.html:160).

Fix: inside the same `if (!isWin())` relabel block in `renderer/renderer.js` (:838,
the block anchored by the comment `Platform-truthful pane copy (TASK-133)` at :833;
the opencode option is relabeled at :842-844), also relabel the claude option using
the same null-guarded pattern (e.g.
`const claudeOption = tab.els.agentSelect && tab.els.agentSelect.querySelector('option[value="claude"]'); if (claudeOption) claudeOption.textContent = 'shell · claude';`).
Keep win32 byte-identical. The fix MUST land inside that exact block: the e2e test
extracts the real block from source by brace-matching anchored on that comment, so
code placed elsewhere would not be exercised by the harness.

## Impact If Not Fixed

Low-to-medium. A mac/Linux user opening the agent dropdown sees `cmd · claude`,
naming a shell that does not exist on their platform, adjacent to the correctly
relabeled openCode option; the copy-truth goal of TASK-133 is only partially met and
reads as an oversight.

## Acceptance Criteria
- [ ] On non-win32 (`window.api.platform` via `getPlatform()`, renderer.js:17-22),
  the agent-select option `[value="claude"]` is relabeled from `cmd · claude` to
  `shell · claude` (matching the `shell · openCode` relabel), done inside the same
  `if (!isWin())` block in `renderer/renderer.js` (:838-869, the block with the
  `Platform-truthful pane copy (TASK-133)` comment) that already relabels the opencode
  option at :842-844 — not in the separate empty-state block at :12597.
- [ ] The relabel follows the existing null-guarded pattern (guard on
  `tab.els.agentSelect` and on the queried option), so a missing option cannot throw.
- [ ] On win32 (and on a stale preload where `getPlatform()` falls back to `'win32'`),
  the claude option renders byte-identical to today (`cmd · claude`);
  `renderer/index.html` is not edited.
- [ ] No DOM class or option `value` is changed (only the visible text).
- [ ] Tests extend the TASK-133 e2e relabel harness
  (test/task-133-linux-mac-compat.e2e.test.js): register a claude option mock
  (`textContent: 'cmd · claude'`) under `'option[value="claude"]'` on the mock
  `agentSelect` in `setupRendererHarness` (:101-133), and assert: platform "darwin" →
  claude option text is `shell · claude`; platform "win32" → it stays `cmd · claude`;
  stale-preload fallback → Windows label kept, no throw.
- [ ] All existing tests stay green; only the 2 known baseline failures remain.

## Cucumber Tests

```gherkin
Feature: The claude agent option is platform-truthful on macOS/Linux

  Scenario: claude option relabeled on macOS
    Given a renderer harness with platform "darwin"
    When a workspace tab is created and the agent dropdown is relabeled
    Then the option with value "claude" reads "shell · claude"
    And the option with value "opencode" reads "shell · openCode"

  Scenario: claude option unchanged on Windows (regression)
    Given a renderer harness with platform "win32"
    When a workspace tab is created
    Then the option with value "claude" reads "cmd · claude"
    And no option value or DOM class has changed

  Scenario (edge): stale preload falls back to Windows label
    Given window.api has no platform property
    When the renderer computes its platform and relabels
    Then the claude option keeps "cmd · claude" and no error is thrown

  Scenario (edge): claude option missing from the select
    Given a workspace tab whose agent select has no option with value "claude"
    When the non-win32 relabel block runs
    Then no error is thrown and the other relabels still apply
```

## Edge Cases and Failure Modes
- **Win32 byte-identical**: the relabel must be strictly guarded by `!isWin()`;
  `renderer/index.html` stays untouched so win32 shows `cmd · claude`.
- **Stale preload**: `getPlatform()` returns `'win32'` (renderer.js:17-19) → no
  relabel, no throw.
- **Missing option / select**: follow the existing null-guard pattern
  (renderer.js:842-844) — if `agentSelect` or the queried option is absent, skip
  silently rather than throw (the test's mock DOM returns `null` for unregistered
  selectors, so an unguarded `.textContent =` would crash the harness).
- **Selector accuracy**: target `option[value="claude"]` specifically; do not
  accidentally rewrite the opencode option or change any option `value`.
- **Block placement**: the e2e test brace-extracts the block anchored at the
  `Platform-truthful pane copy (TASK-133)` comment (renderer.js:833) — a relabel added
  outside that block (e.g. near the empty-state block at :12597) would pass manual
  inspection but be invisible to the test harness.
- **Consistency**: after the fix both sibling options use the `shell · <agent>` form
  on mac/Linux (`shell · claude` / `shell · openCode`).

## Relevant Files and Context
- `renderer/index.html:160` — `<option value="claude">cmd · claude</option>` (the
  option to relabel); `:161` — `<option value="opencode">git bash · openCode</option>`,
  already handled by TASK-133. Do not edit this file.
- `renderer/renderer.js:833-869` — the `Platform-truthful pane copy (TASK-133)` comment
  (:833-837) and its `if (!isWin())` block (:838); the opencode option relabel at
  :842-844 is the pattern to mirror. Add the claude relabel here.
- `renderer/renderer.js:17-22` — `getPlatform()` (win32 fallback for stale preload)
  and `isWin()`.
- `renderer/renderer.js:12597` — the OTHER `if (!isWin())` (empty-state copy) — not
  the target block.
- `test/task-133-linux-mac-compat.e2e.test.js` — the relabel-test pattern to extend:
  `extractBraceBlock` (:54-64) pulls the real block from source keyed on the :833
  comment (:68-70); `setupRendererHarness` (:101-133) builds the mock DOM — its
  `agentSelect` (:105-106) currently registers only `'option[value="opencode"]'`, so
  add a claude option mock and return it; assertions go in the "darwin" scenario
  (:253-271), the win32 regression scenario (:273-287), and the stale-preload edge
  (:289-307).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
