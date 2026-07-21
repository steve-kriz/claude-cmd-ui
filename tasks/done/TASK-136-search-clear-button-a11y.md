---
id: TASK-136
title: Make the Tasks search clear (×) button accessible
status: done
created: 2026-07-21T09:01:45.000Z
updated: 2026-07-21T10:45:04.000Z
review-of: TASK-132
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T09:49:30.000Z","finishedAt":"2026-07-21T09:51:30.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T10:37:00.000Z","finishedAt":"2026-07-21T10:38:13.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T10:38:13.000Z","finishedAt":"2026-07-21T10:43:18.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T10:43:18.000Z","finishedAt":"2026-07-21T10:44:30.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T10:44:30.000Z","finishedAt":"2026-07-21T10:45:04.000Z"}]
---

## Description

Tech-lead review of TASK-132 found the Tasks search clear (×) button is
keyboard-unreachable and unlabeled: `renderer/index.html:667` —
`<button class="tasksSearchClear tasks-search-clear hidden" title="Clear search (Esc)" tabindex="-1">×</button>`.
It has `tabindex="-1"` (removed from tab order) and no `aria-label`, so its
accessible name is the bare `×` glyph (screen readers announce
"times/multiplication sign"). The mirrored Files-find close button
(`renderer/index.html:298`, `.filesFindClose`) carries no `tabindex` attribute at
all and is therefore naturally tab-reachable. The codebase has otherwise been
deliberate about accessibility (TASK-082/083 added `aria-label`/`role="img"` for
color-only card-type strips, see `renderer/renderer.js:~9230-9247`), so this is a
small regression against that bar.

Recommended fix: add `aria-label="Clear search"` to the button AND remove
`tabindex="-1"` so it joins the natural tab order, mirroring the Files-find close
button. When the input is empty the button already has the `hidden` class and
`.tasks-search-clear.hidden { display: none; }` (`renderer/styles.css:~2570`)
removes it from the tab order automatically, so making it focusable adds a tab stop
only while there is text to clear. Keep the existing `title="Clear search (Esc)"`
tooltip; do not rename any class (`tasksSearchClear` is the JS lookup hook at
`renderer/renderer.js:~525`).

## Impact If Not Fixed

Low. Keyboard-only and screen-reader users cannot Tab to or clearly identify the
clear control; they must know to press Escape. Functionality is not lost (Escape and
mouse click both work), so the harm is a minor accessibility shortfall, not a broken
feature.

## Acceptance Criteria
- [ ] The clear button in `renderer/index.html` (currently line 667) has
  `aria-label="Clear search"`, so its accessible name is "Clear search" rather than
  the `×` glyph.
- [ ] `tabindex="-1"` is removed from the button so it joins the natural tab order,
  mirroring the Files-find close button at `renderer/index.html:298` (which has no
  `tabindex`). No focus-management JS changes are required: the `hidden` class
  (`display: none`) already keeps it out of the tab order while the search box is
  empty.
- [ ] Activating the focused button with the keyboard (Enter/Space fires `click`)
  clears the search and returns focus to the search input, via the existing click
  handler (`renderer/renderer.js:~583-588`) — no handler changes.
- [ ] Existing behavior is unchanged: click-to-clear works, the button stays hidden
  until the input has text (`updateTasksSearchClear`), Escape in the input still
  clears, and the `title="Clear search (Esc)"` tooltip is kept. No class is renamed
  (`tasksSearchClear` / `tasks-search-clear` / `hidden` are load-bearing hooks).
- [ ] A test asserts the shipped markup: the `tasksSearchClear` button element in
  `renderer/index.html` contains `aria-label="Clear search"` and does NOT contain
  `tabindex="-1"`. Follow the existing static-markup-assertion pattern (tests that
  read `renderer/index.html` source, e.g. `test/task-091-team-tab-scaffold.e2e.test.js`),
  or extend `test/task-132-board-search.e2e.test.js`.
- [ ] All existing TASK-132 tests still pass unmodified in behavior (the harness
  sets `tasksSearch`/`tasksSearchClear` up from the tab object, so the markup change
  must not break `clearTasksSearch`/`onTasksSearchInput` flows).

## Cucumber Tests

```gherkin
Feature: Accessible Tasks search clear button
  The Tasks toolbar search input has a clear (x) button that must expose a
  meaningful accessible name and be reachable by keyboard, without changing
  its existing click / Escape / visibility behavior.

  Background:
    Given the Tasks tab is open with a board of tickets
    And the toolbar search input ".tasksSearch" is present
    And the clear button ".tasksSearchClear" is present

  Scenario: Screen reader announces "Clear search", not the x glyph
    When the accessibility name of the clear button is computed
    Then the button has the attribute aria-label "Clear search"
    And its accessible name is "Clear search"
    And it is not announced as "times" or the bare "×" character

  Scenario: Clear button joins the tab order while text is present
    Given the user has typed "login" into the search input
    Then the clear button is visible (the "hidden" class is absent)
    And the clear button has no tabindex="-1" attribute
    And pressing Tab from the search input moves focus to the clear button

  Scenario: Keyboard activation clears the search and restores focus
    Given the user has typed "login" into the search input
    And focus is on the clear button
    When the user presses Enter (activating the button's click handler)
    Then the search input value becomes empty
    And the board re-renders unfiltered
    And focus returns to the search input
    And the clear button gains the "hidden" class

  Scenario: Escape in the input still clears the search (regression guard)
    Given the user has typed "TASK-002" into the search input
    When the user presses Escape while focused in the search input
    Then the search input value becomes empty
    And the board re-renders unfiltered
    And the clear button gains the "hidden" class

  Scenario: Mouse click still clears the search (regression guard)
    Given the user has typed "crash" into the search input
    When the user clicks the clear button
    Then the search query state and input value become empty
    And the board shows all tickets again

  Scenario: Edge — hidden clear button is not a tab stop on an empty search
    Given the search input is empty
    Then the clear button has the "hidden" class
    And ".tasks-search-clear.hidden" is display: none in styles.css
    And Tabbing from the search input skips the clear button entirely

  Scenario: Edge — aria-label is a fixed literal, present even while hidden
    Given the search input is empty and the clear button is hidden
    Then the button still carries aria-label "Clear search" in the static markup
    And the label never interpolates ticket or query text
```

## Edge Cases and Failure Modes

- **Hidden state must stay out of the tab order.** Making the button focusable is
  only safe because `.tasks-search-clear.hidden { display: none; }` removes hidden
  elements from tabbing. Do not switch the hide mechanism to `visibility`/`opacity`,
  which would leave an invisible tab stop.
- **Escape while the button itself is focused does nothing** — the Escape handler
  lives on the input, not the button. This is acceptable (Enter/Space on the button
  clears); do not add a new keydown handler unless trivial, and if added it must not
  break the existing input-Escape path.
- **Class names are load-bearing.** `tasksSearchClear` is the `ws.querySelector`
  hook and the test harness builds mock elements from these classes; renaming any of
  `tasksSearchClear` / `tasks-search-clear` / `hidden` breaks wiring and tests.
- **Do not change the handlers.** `clearTasksSearch` is also invoked from the
  create-ticket, bug-ticket, and Plan flows; this ticket is markup-only, and any JS
  change risks those paths.
- **Focus-return on activation.** The click handler already refocuses the input;
  keyboard activation of a native `<button>` fires `click`, so no extra code is
  needed — a test should confirm focus lands back on the input rather than being
  dropped on a now-hidden button.
- **Fixed-literal label only.** Mirror the TASK-082/083 convention: the aria-label
  is a constant string set in markup, never interpolated from user/ticket text (no
  injection surface).
- **Files-find button is the reference, not a target.** `.filesFindClose`
  (`renderer/index.html:298`) is cited as the tab-reachable pattern to mirror;
  changing it is OUT of scope for this ticket.

## Relevant Files and Context

- `renderer/index.html:667` — the button to change:
  `<button class="tasksSearchClear tasks-search-clear hidden" title="Clear search (Esc)" tabindex="-1">×</button>`.
  Add `aria-label="Clear search"` and drop `tabindex="-1"`; keep classes, `title`,
  and the `×` text content.
- `renderer/index.html:298` — the pattern to mirror:
  `<button class="filesFindClose small-btn" title="Close (Esc)">×</button>` (no
  `tabindex`, naturally focusable). Read-only reference.
- `renderer/renderer.js:~525` — element lookup `tasksSearchClear`.
- `renderer/renderer.js:~575-588` — input `input`/Escape handlers and the clear
  button's `click` handler (clears then refocuses the input). No changes needed.
- `renderer/renderer.js:~6792-6810` — `updateTasksSearchClear`, `onTasksSearchInput`,
  `clearTasksSearch`. No changes needed.
- `renderer/styles.css:~2556-2570` — `.tasks-search-clear` styles and
  `.tasks-search-clear.hidden { display: none; }`. No changes needed.
- `renderer/renderer.js:~9230-9247` — TASK-082/083 a11y convention (`aria-label` +
  fixed literal) to follow in spirit.
- `test/task-132-board-search.e2e.test.js` / `test/task-132-board-search.test.js` —
  existing search tests that must keep passing; a natural home for the new assertion,
  or add a static-markup assertion following `test/task-091-team-tab-scaffold.e2e.test.js`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
