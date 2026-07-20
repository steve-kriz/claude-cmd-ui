---
id: TASK-082
title: Add a text alternative (title/aria-label) to the card type bar for accessibility
status: done
created: 2026-07-19T21:51:41Z
updated: 2026-07-19T22:12:21Z
review-of: TASK-075
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T22:07:08Z","finishedAt":"2026-07-19T22:08:08Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T22:08:08Z","finishedAt":"2026-07-19T22:10:30Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T22:10:30Z","finishedAt":"2026-07-19T22:12:21Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T22:12:21Z","finishedAt":"2026-07-19T22:12:21Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-075 (Finding F1, Low). The
`.task-card-type` bar added by TASK-075 encodes ticket type (bug / review / normal)
**purely through color** (red `#f14c4c` / yellow `#e5c100` / green `#6a9955`). Unlike
the sibling status dot — which sets a `title` attribute ("Waiting for your answer" /
"Tests failed" / "Being worked on", `renderer/renderer.js` ~5947) — the type bar sets
no `title`, `aria-label`, or any text alternative (`renderer/renderer.js` ~5927-5930).

Add a text alternative to the type bar so its meaning is available without relying on
color, mirroring the existing dot's tooltip convention.

## Acceptance Criteria
- [ ] The `.task-card-type` element carries a `title` attribute (and/or `aria-label`)
  describing the type: "Bug" for `bug-of`, "Review" (or "PR review") for `review-of`,
  and "Normal" for the default — matching the same precedence as the color
  (bug wins over review).
- [ ] The text alternative is derived from the same frontmatter predicates
  (`isBugTicket`/`isReviewTicket`) as the color — never inferred from title text — so
  color and label never disagree.
- [ ] The label follows the existing dot's tooltip pattern/style in `renderTasksBoard`
  and does not introduce any untrusted text into the DOM via innerHTML (set via
  `title`/`textContent`/attribute, not innerHTML).
- [ ] No visual regression: the bar still renders in every lane (incl. Archived
  expander and unknown-status) and does not overlap the status dot.
- [ ] Tests: unit + e2e (`node --test`) assert the correct label for bug / review /
  normal and the bug-wins precedence, plus that the label matches the color class.
  Green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Card type bar has a text alternative for accessibility

  Scenario: Bug card exposes a "Bug" label
    Given a ticket whose frontmatter has non-empty bug-of
    When the board renders its card
    Then the type bar's title/aria-label is "Bug"

  Scenario: Review card exposes a "Review" label
    Given a ticket whose frontmatter has non-empty review-of
    When the board renders its card
    Then the type bar's title/aria-label is "Review"

  Scenario: Normal card exposes a "Normal" label (edge)
    Given a ticket with no bug-of and no review-of
    When the board renders its card
    Then the type bar's title/aria-label is "Normal"

  Scenario: Both markers → "Bug" label (edge, precedence)
    Given a ticket with non-empty bug-of and non-empty review-of
    When the board renders its card
    Then the type bar's title/aria-label is "Bug" and the bar is red
```

## Impact If Not Fixed
The primary benefit of the type bar — distinguishing high-signal bug and review cards
at a glance — is unavailable to color-blind users (red/green deficiency is the most
common), and there is no hover tooltip or screen-reader text to fall back on. The
feature silently excludes those users from the signal it was built to provide.

## Edge Cases & Failure Paths
- Both markers present → label must be "Bug" (consistent with red-wins color
  precedence).
- Malformed/absent frontmatter → "Normal" label, no throw.
- The label text is a fixed literal per type — never interpolated from ticket
  title/description (no injection surface).

## Relevant Files & Context
- `renderer/renderer.js` — type bar construction in `renderTasksBoard` ~5927-5930;
  the status dot's `title` convention ~5947; `isBugTicket`/`isReviewTicket` ~5246-5251.
- `renderer/styles.css` — `.task-card-type` rules ~2645-2652 (no change likely needed).
- Test patterns: `test/task-075-type-bar.test.js`, `test/task-075-type-bar.e2e.test.js`.
- Origin: tech-lead review of TASK-075, Finding F1 (Low, accessibility).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
