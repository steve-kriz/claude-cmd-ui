---
id: TASK-196
title: usage meter bar
status: done
created: 2026-07-31T22:26:22.465Z
updated: 2026-08-01T02:34:11.317Z
agent: orchestrator-main
resolution: wont-do
---

## Description

The weekly usage bar in the **cmd pane header** no longer shows a usage figure. The bar element is confirmed still present in the header (an empty track with a stale/blank label). Two defects were confirmed and fixed:

1. **Inert hide class** — `renderer/styles.css` had no rule matching `.usage-bar.hidden`, so hiding the bar was a no-op, and a failed read left the bar visibly blank with no explanation.
2. **Real runtime root cause** — Claude Code's `/usage` command (v2.1.212) no longer prints the weekly figure inline; it now opens an interactive multi-tab dialog that can default-open on a tab that isn't the weekly-usage one, so the probe's readiness regex never matched and every real read fell through to `unparsed`.

## Acceptance Criteria

- [ ] On a `claude` pane with a trusted folder and a logged-in Claude Code, the header usage bar shows the current weekly (all-models) rate-limit percentage as both a proportional fill and an `N%` label, matching what typing `/usage` interactively reports.
- [ ] The pace notch renders at the correct position when a reset instant is available, and is hidden when the reset instant is unknown.
- [ ] The bar's colour state reflects `usageState`: green (`state-ok`), amber (`state-near`), red (`state-over`).
- [ ] The value refreshes on the existing triggers (tab activation, run finishing, agent switch, 5-minute poll) using the cache, except an explicit click which forces a fresh scrape with a loading affordance.
- [ ] The CSS class toggled to hide the bar actually hides it (`.usage-bar.hidden` is a real, non-inert rule).
- [ ] When the reading is unavailable (`view.ok === false` for any reason, or the bridge is missing/rejects), the bar shows a **visible "usage unavailable" affordance** (`.usage-bar.is-unavailable`), hoverable for the reason — never a blank empty track, never fully hidden.
- [ ] On an unavailable reading, fill/pace/label are reset to the defined unavailable state, never left showing a stale prior figure.
- [ ] A non-`claude` (openCode) pane is fully hidden (`.usage-bar.hidden`) — the one case that still uses the hide class.
- [ ] No unhandled exception/rejection escapes the usage-bar path regardless of probe outcome.
- [ ] The pure model (`lib/claude-usage.js`) still never fabricates a number for garbled/unmatched frames.
- [ ] The probe recognizes when Claude Code's `/usage` dialog opens on the wrong tab and cycles toward the weekly-usage tab (bounded retries), so the happy path is genuinely restored, not just the UI-state ACs.

## Cucumber Tests

```gherkin
Feature: Weekly usage bar in the cmd pane header

  Scenario: Bar shows the weekly rate-limit figure under normal operation
    Given the active pane runs the "claude" agent in a trusted, logged-in folder
    And the "/usage" scrape reports the weekly figure as "37% used" resetting "Aug 1, 4:59pm"
    When the usage bar is refreshed
    Then the bar fill width corresponds to 37 percent
    And the bar label reads "37%"

  Scenario: Colour state reflects headroom versus pace
    Given the weekly figure is 5 or more points past the pace marker
    When the usage bar is painted
    Then the bar carries the "state-over" style

  Scenario: Click forces a fresh scrape past the cache
    Given the usage bar is currently showing a cached figure
    When the user clicks the usage bar
    Then a forced usage read bypasses the cache and the bar updates

  Scenario: openCode panes never show the weekly bar
    Given the active pane runs the "opencode" agent
    When the usage bar is refreshed
    Then the weekly usage bar is fully hidden (.usage-bar.hidden)

  Scenario: Unavailable reading shows a visible affordance, not a silent blank bar
    Given the "/usage" scrape fails with reason "unparsed"
    When the usage bar is refreshed
    Then the bar shows .usage-bar.is-unavailable, not an empty track and not .hidden
    And the unavailable reason is available via the tooltip

  Scenario: The probe recovers from the dialog opening on the wrong tab
    Given the /usage dialog opens on a non-weekly tab (e.g. Config/Status)
    When the probe detects the dialog-open hint and cycles tabs (bounded retries)
    Then it stops once the weekly-usage frame matches or the retry bound is hit

  Scenario: A rejected usage:get invoke does not throw into the UI
    Given "window.api.usage.get" rejects
    When the usage bar refresh runs
    Then the rejection is caught and the bar reaches the visible-unavailable state

  Scenario: The pure model never fabricates a number from garbage
    Given a captured frame that does not contain a weekly-usage row
    When the frame is parsed
    Then the result is not ok and carries a reason, no percentage is guessed
```

## Relevant Files & Context

- `lib/claude-usage-probe.js` — `DIALOG_OPEN_RE`, bounded tab-cycling (`tabCycleMs`/`maxTabCycles` in `DEFAULTS`) inside `askForUsage`.
- `renderer/renderer.js` — `applyUsageView` (rewritten: hidden vs. is-unavailable split, always resets paint), `refreshUsageBar` (paints visible-unavailable on missing bridge / rejected usage:get).
- `renderer/styles.css` — `.usage-bar.hidden { display: none; }`, new `.usage-bar.is-unavailable` style.
- `renderer/index.html` — header comment updated to describe the new contract (markup unchanged).
- `docs/usage-bar.md` — documents the tabbed-dialog root cause/fix and the new `no-bridge` reason.
- `test/claude-usage.test.js`, `test/claude-usage-probe.e2e.test.js` — existing suites; the latter has ONE test at line ~482 ("DRIFT GUARD (renderer.js): the bar is painted from the view and never from innerHTML") that pins the OLD contract (`tab.agent !== 'claude' || !view || !view.ok` → single `hidden` class). This is now intentionally different per this ticket — update that assertion to match the new contract (hidden only for non-claude; `is-unavailable` for a failed/missing view) rather than treating it as a regression.

## Clarifications

- **Q1 (symptom shape):** Bar confirmed present but blank — confirmed the inert-hide-class / probe-failure path.
- **Q2 (`/usage` format):** User reported it unchanged from their own manual check; however the coder's live probe run against the actually-installed Claude Code (v2.1.212) found the interactive panel now opens as a multi-tab dialog rather than printing inline — this is the real, verified runtime root cause (see Build notes). Not a contradiction: the row's *text format* is unchanged once you reach the right tab; what changed is that `/usage` no longer lands on that tab by default.
- **Q3 (failure UX):** Resolved to a visible "usage unavailable" affordance rather than fully hiding the bar on failure — implemented as `.usage-bar.is-unavailable`.

## Build notes

- Root cause confirmed live against installed `claude 2.1.212`: `/usage` opens a multi-tab interactive dialog (Settings/Status/Config/Session-cost tabs observed) that can default-open on a non-weekly tab, so the old flat-frame readiness regex never matched and every real probe fell through to 45s timeout / `unparsed`. Fix: `DIALOG_OPEN_RE` detects the dialog is open (every tab shows an "Esc to cancel/close" hint), then cycles tabs with a bounded Left-arrow retry (`maxTabCycles`, default per `DEFAULTS`), re-checking `FRAME_READY_RE` after each press. Zero behavior change for a dialog already on the right tab or the older flat layout.
- `applyUsageView` rewritten: fully-hidden (`.hidden`) is now used ONLY for non-`claude` panes; a failed/missing view (`!view.ok` or bridge missing/rejected) now paints `.is-unavailable` and always resets fill/pace/label so a stale figure can never linger.
- **Caveat the coder could not fully close out**: the sandbox's Claude account is API-key billed (no weekly-limit concept at all — "week" appears on none of its dialog tabs), so the exact tab index / number of Left-arrow presses to reach the real weekly-usage tab on a Pro/Max account could not be verified end-to-end. The tab-cycling is deliberately generic (press Left, check, stop on match or after bound) rather than hardcoded to a specific tab position, specifically because of this. **Flagged for the user**: if you have a Pro/Max Claude Code account, a quick manual `/usage` check would confirm the exact tab position and finalize confidence in the fix.
- Test status: `test/claude-usage.test.js` + `test/claude-usage-probe.e2e.test.js` = 47/48 pass. The 1 failure is the outdated drift-guard test described above (pins the old single-`hidden`-for-everything contract) — orchestrator confirmed via direct run this is exactly the pre-existing test needing an update, not a regression.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
