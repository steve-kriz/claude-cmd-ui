---
id: TASK-192
title: TASK-185 review — stale-guard scenario for AI phase regeneration is a vacuous placeholder
status: done
created: 2026-07-27T18:00:00Z
updated: 2026-07-27T21:05:00Z
agent: orchestrator-main
review-of: TASK-185
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T20:50:00Z","finishedAt":"2026-07-27T21:00:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T21:00:00Z","finishedAt":"2026-07-27T21:04:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T21:00:00Z","finishedAt":"2026-07-27T21:04:00Z"}]
---

## Description
The TASK-185 tech-lead review found that the stale-guard scenario in
`test/task-185-workflow-phase-regen.e2e.test.js` (~lines 579-601) never clicks the regenerate
button, never swaps `tab.els.teamWorkflowBody`, and never sets `wrap.isConnected = false`. It
asserts only `card.isConnected`, which is trivially true from the mock DOM default. None of the
actual stale-guard logic in `renderer/renderer.js` (~line 8887 for the regenerate response,
~line 8975 for the post-save refresh) is exercised.

## Acceptance Criteria
- [x] A real scenario: start a regenerate request, then before its (mocked, delayed) response
      resolves, simulate the user switching tabs/folders (change `tab.folder` or replace
      `tab.els.teamWorkflowBody` with a new node, matching how the actual stale-guard check is
      implemented) or tearing down the card (`wrap.isConnected = false`), then let the response
      resolve.
- [x] Assert the stale response is discarded: no preview renders into the (now stale) card, no
      error/success message appears in the stale card, and no write occurs.
- [x] A second scenario covering the Save-side stale-guard (~line 8975): start a Save, invalidate
      staleness before the write's async completion resolves, and assert `refreshTeamWorkflow`
      is NOT called against a torn-down/switched panel.
- [x] A regression check: temporarily disabling the stale-guard condition must make the
      corrected test(s) fail (verify locally, then revert).

## Cucumber Tests
```gherkin
Feature: stale-guard discards late AI-regeneration responses
  Scenario: response arrives after the panel is torn down
    Given a regenerate request is in flight
    When the phase card's containing panel is torn down before the response resolves
    Then the response is discarded and nothing renders or writes into it

  Scenario: response arrives after a folder/tab switch
    Given a regenerate request is in flight
    When the active folder/tab changes before the response resolves
    Then the response is discarded

  Scenario: Save's post-write refresh is stale-guarded
    Given a Save is in flight
    When the panel becomes stale before the write completes
    Then refreshTeamWorkflow is not invoked against the stale panel

  Scenario: regression is caught (failure/edge)
    Given the stale-guard check were disabled
    When the corrected tests run
    Then they fail
```

## Edge & Failure Cases
- Use the project's real stale-guard mechanism (whatever `renderer.js` actually checks —
  `tab.els.teamWorkflowBody` identity and/or `wrap.isConnected`) rather than inventing a new one.

## Relevant Files & Context
- `test/task-185-workflow-phase-regen.e2e.test.js` (~lines 579-601, the vacuous scenario to replace).
- `renderer/renderer.js` — the regenerate-response stale-guard (~line 8887) and the save-refresh stale-guard (~line 8975) in `buildWorkflowPhaseRegenerator`.

## Impact If Not Fixed
A regression could let a stale AI proposal render into — or Save over — the wrong project's
SKILL.md after the user navigates away, corrupting an unrelated file, with CI staying green.

## Build notes
- Coder: replaced the vacuous placeholder with 3 real scenarios (regenerate-response discard after tab switch, after card teardown, and Save's refreshTeamWorkflow skip after mid-save staleness) exercising both real stale-guards. Performed and reverted two genuine regression checks (disabled each guard in turn, confirmed 2 then 1 failure with concrete output, reverted both, confirmed 14/14 green).
- Test-only ticket. Orchestrator independently re-verified: no leftover debug markers, 14/14 on target file, full suite 3726 pass / 3 pre-existing baseline failures / 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed both guards intact and the new scenarios genuinely exercise staleness (not stubs); documentation pass found no stale doc references (docs describe behavior, not test names).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
