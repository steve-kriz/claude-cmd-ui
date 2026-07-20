---
id: TASK-083
title: Give the card type bar an announceable role so its aria-label is exposed
status: done
created: 2026-07-19T22:12:21Z
updated: 2026-07-19T22:19:48Z
review-of: TASK-082
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T22:14:30Z","finishedAt":"2026-07-19T22:15:22Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T22:15:22Z","finishedAt":"2026-07-19T22:18:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T22:18:00Z","finishedAt":"2026-07-19T22:19:48Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T22:19:48Z","finishedAt":"2026-07-19T22:19:48Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-082 (Finding F1, Low). TASK-082 added a
`title` and `aria-label` ("Bug"/"Review"/"Normal") to the `.task-card-type` bar
(`renderer/renderer.js` ~5938-5939). However the bar is a generic role-less `<div>`
(`renderer/renderer.js` ~5927). Per the ARIA spec, `aria-label` on a role-less generic
element is not guaranteed to be exposed by assistive technology, and `title` on a
non-interactive `<div>` is inconsistently announced. So the screen-reader path — the
explicit goal of TASK-082 — may still be silent, even though the mouse-hover tooltip
already helps color-blind sighted users.

Fix: give the type bar an announceable role so the existing `aria-label` is reliably
exposed — the reliable pattern for a purely-decorative colored strip is
`role="img"` paired with the `aria-label`.

## Acceptance Criteria
- [ ] The `.task-card-type` element sets `role="img"` (or an equivalent reliably
  announceable pattern such as visually-hidden text) so its `aria-label`
  ("Bug"/"Review"/"Normal") is exposed to screen readers.
- [ ] The `aria-label`/`title` values and their bug-wins precedence from TASK-082 are
  unchanged; only the announceability is added.
- [ ] No visual regression: the bar still renders as a thin strip in every lane (incl.
  Archived expander and unknown-status) and does not overlap the status dot; the role
  is non-visual.
- [ ] The role/label is set via attributes (`setAttribute`/property), never innerHTML;
  labels remain fixed literals per type (no ticket-controlled text).
- [ ] Tests: unit + e2e (`node --test`) assert the type bar carries the announceable
  role alongside the correct `aria-label` for bug/review/normal. Green aside from the
  two known pre-existing unrelated failures (`test/task-030-plan-button.e2e.test.js`,
  `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Card type bar is announceable to screen readers

  Scenario: The type bar carries an image role with its label
    Given a bug ticket (non-empty bug-of)
    When the board renders its card
    Then the type bar has role "img" and aria-label "Bug"

  Scenario: Review and normal cards are likewise announceable (edge)
    Given a review ticket and a normal ticket
    When the board renders their cards
    Then each type bar has role "img" with aria-label "Review" and "Normal" respectively

  Scenario: The role is non-visual and does not regress layout (edge)
    Given any ticket card
    When the board renders it
    Then the type bar is still a thin strip and does not overlap the status dot
```

## Impact If Not Fixed
Screen-reader users may continue to receive no ticket-type information despite the
`aria-label` being present, because the announcing element lacks a role — so the
accessibility objective of TASK-082 is only partially achieved (mouse-hover tooltip
works, screen-reader path may stay silent).

## Edge Cases & Failure Paths
- The role must not make the decorative strip focusable or interactive (it is not a
  control); `role="img"` keeps it non-interactive.
- Malformed/absent frontmatter → "Normal" label with the role still applied, no throw.
- Keep the color-class logic (TASK-075) and the label logic (TASK-082) intact — this
  ticket only adds the role.

## Relevant Files & Context
- `renderer/renderer.js` — type bar construction in `renderTasksBoard` ~5927-5940;
  the status dot's convention ~5951-5958 for comparison; `isBugTicket`/`isReviewTicket`
  ~5246-5251.
- Test patterns: `test/task-075-type-bar.test.js`, `test/task-075-type-bar.e2e.test.js`.
- Origin: tech-lead review of TASK-082, Finding F1 (Low, accessibility).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
