---
id: TASK-151
title: Team accordion toggle buttons need an accessible name per section
status: done
created: 2026-07-26T07:32:44.323Z
updated: 2026-07-26T21:53:22.716Z
review-of: TASK-144
resolution: wont-do
---

## Description

The three Team accordion toggle buttons (`renderer/index.html` ~714, 723, 731) contain only
the bare chevron glyph `▾`. The section label ("Agents" / "Workflow" / "Board") is a sibling
`.team-section-title` span not associated with the button, and there is no `aria-label` /
`aria-labelledby`. `aria-expanded` is present and correct (the TASK-144 AC is met), but the
control has no accessible NAME, so a screen-reader user tabbing to a toggle hears only the
glyph / "button, collapsed" with no indication of which section it controls.

Give each toggle an accessible name identifying its section and hide the decorative glyph.

## Impact If Not Fixed
Screen-reader and other assistive-technology users cannot distinguish the three otherwise
identical toggle buttons, making the accordion effectively unusable non-visually — users may
collapse or expand the wrong section. Low severity (does not affect sighted/keyboard-visual
users or violate a stated TASK-144 AC).

## Acceptance Criteria
- [ ] Each `.team-section-toggle` button carries an accessible name identifying its section —
      either an `aria-label` (e.g. "Toggle Agents section") or `aria-labelledby` referencing
      that section's `.team-section-title` (add an `id` to the titles if using labelledby).
- [ ] The decorative chevron glyph is marked `aria-hidden="true"` so it is not announced.
- [ ] `aria-expanded` behaviour from TASK-144 is unchanged (still "true"/"false" reflecting
      state, updated on toggle).
- [ ] No behavioural/visual regression: the accordion still toggles by mouse and keyboard,
      chevron still rotates, and the three-section layout is unchanged.
- [ ] A test asserts each toggle has a non-empty accessible name (source-scan for the
      per-section `aria-label`/`aria-labelledby`) and that the glyph is `aria-hidden`.
- [ ] No `.claude/` or `assets/` file changed; confined to `renderer/index.html` (and
      `renderer/renderer.js` only if `aria-expanded` wiring needs it) plus the test.
- [ ] Full suite green under `node --test` beyond the 3 known baseline failures.

## Cucumber Tests
```gherkin
Feature: Team accordion toggles have accessible names

  Scenario: Each toggle names its section
    Given the three .team-section-toggle buttons
    Then each has a non-empty accessible name identifying Agents, Workflow, or Board
    And the chevron glyph is aria-hidden

  Scenario: aria-expanded unchanged
    Given a toggle button
    When its section collapses and expands
    Then aria-expanded flips false/true as before

  Scenario (edge): keyboard + visual behaviour preserved
    Given a keyboard user focuses a toggle and activates it
    Then the section collapses and the chevron rotates, with no visual regression
```

## Relevant Files & Context
- `renderer/index.html` ~714, 723, 731 — add `aria-label` (or `aria-labelledby` + title
  `id`s) to each `.team-section-toggle`; mark the `▾` glyph `aria-hidden="true"`. Follow the
  Archived-expander a11y pattern already in the codebase.
- `renderer/renderer.js` — the toggle handler (~612-623) if aria wiring needs a touch (the
  static markup should suffice).
- `test/task-144-team-accordion.e2e.test.js` / `.test.js` — add the accessible-name / glyph
  assertions.
- Runner `node --test`; `cucumber` not installed; mock all I/O.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
