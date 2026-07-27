---
id: TASK-150
title: Team accordion tests must drive the real handler (bail-out and body-click paths)
status: done
created: 2026-07-26T07:32:44.323Z
updated: 2026-07-26T21:53:17.297Z
review-of: TASK-144
resolution: wont-do
---

## Description

`test/task-144-team-accordion.e2e.test.js` claims (header comment ~17-18) to exercise the
extracted delegated accordion handler against a mock DOM, but it never runs it:
`runAccordionHandler` (~150-164) and `makeMockTeamBody` (~130-144) are defined and never
called; the "Collapsing a section" scenario (~223-261) extracts the handler then
hand-re-implements the toggle inline; and the two emphasized FAILURE scenarios — "Action
buttons do not toggle" (~418-436) and "Clicking inside a section body never toggles"
(~441-457) — only `assert.match` regexes against the handler STRING and then assert
`!mock.classList.contains('collapsed')` on a mock that was never passed to any handler
(vacuously true). The unit file's `toggleAccordionSection` replica (task-144-team-accordion.test.js:75-82)
also omits the bail / header-guard logic. So the `.small-btn` bail-out and the body-click
no-toggle paths — the exact edge cases the ticket calls out — have NO behavioral coverage.

Make the behavioral tests actually drive the real extracted handler.

## Impact If Not Fixed
A future edit to the delegated handler can silently reintroduce the "clicking Add agent /
Refresh / Save collapses the section" bug (or make body controls toggle sections) while the
suite stays green, because no test drives the real code path with a `.small-btn` or
body-internal event target. The tests overstate their coverage and give false confidence.

## Acceptance Criteria
- [ ] The e2e tests invoke the REAL extracted delegated accordion handler (via the
      existing `runAccordionHandler`/`makeMockTeamBody` scaffolding, or an equivalent
      extraction) — no scenario asserts against a hand-re-implemented copy or against a
      mock that was never passed to the handler.
- [ ] Behavioral case: a synthetic event whose `target.closest('.small-btn')` returns a
      button (Add agent / Refresh / Save) drives the real handler and asserts the parent
      `.team-section` did NOT gain `.collapsed` and `aria-expanded` did not change.
- [ ] Behavioral case: a synthetic event whose `target.closest('.team-section-header')`
      returns null (a body-internal control click) drives the real handler and asserts no
      section toggled.
- [ ] Behavioral case: a header-space / toggle click (closest returns the header) drives
      the real handler and asserts the section gains `.collapsed` and its
      `.team-section-toggle` `aria-expanded` flips to "false" (and back on a second click).
- [ ] The dead `runAccordionHandler`/`makeMockTeamBody` helpers are either wired up or
      removed (no dead scaffolding left implying coverage that does not exist).
- [ ] Full suite green under `node --test` beyond the 3 known baseline failures; no new
      failures.

## Cucumber Tests
```gherkin
Feature: Team accordion behavioral tests drive the real handler

  Background:
    Given the real delegated accordion handler extracted from renderer.js
    And a mock team DOM with three .team-section blocks

  Scenario: Action-button click does not toggle (real handler)
    Given a click event whose target.closest('.small-btn') is the Add agent button
    When the real handler runs
    Then no .team-section gains 'collapsed'
    And no aria-expanded changes

  Scenario: Body-internal click does not toggle (real handler)
    Given a click whose target.closest('.team-section-header') is null
    When the real handler runs
    Then no section toggles

  Scenario: Header click toggles (real handler)
    Given a click whose target.closest('.team-section-header') is the Agents header
    When the real handler runs
    Then the Agents .team-section gains 'collapsed' and its toggle aria-expanded is 'false'
    And a second click restores it to expanded with aria-expanded 'true'

  Scenario (edge): No dead scaffolding
    Given the e2e test file
    Then runAccordionHandler and makeMockTeamBody are either invoked or removed
```

## Relevant Files & Context
- `test/task-144-team-accordion.e2e.test.js` — wire up `runAccordionHandler`/`makeMockTeamBody`
  (~130-164) and rewrite the vacuous scenarios (~223-261, ~418-457) to drive the real handler.
- `test/task-144-team-accordion.test.js` — if the unit replica is kept, extend it to cover
  the bail / header-guard branches (or fold into the e2e behavioral cases).
- `renderer/renderer.js` — the delegated `click` handler on `tab.els.teamBody` (~612-623).
  Do not change behaviour; test-only ticket.
- Follow the real-handler-extraction pattern in `test/task-091-team-tab-scaffold.e2e.test.js`
  / other renderer e2e tests. Runner `node --test`; `cucumber` not installed; mock all I/O.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
