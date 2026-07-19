---
id: TASK-024
title: Fix bug modal listener accumulation
status: done
created: 2026-07-18T22:13:00.000Z
updated: 2026-07-19T01:00:00.000Z
---

## Description
Follow-up from the TASK-020 tech-lead review (severity: LOW, robustness; low confidence).
In `openBugReportModal(tab, file)` (~renderer/renderer.js:6402-6446), the `submit`/`cancel`
listeners are added on every open, and `cleanup()` (which removes them) only runs for the current
invocation's submit/cancel. If the modal is re-opened before being dismissed, the prior
invocation's `onSubmit` closure — bound to the EARLIER `file` — remains attached and could fire
against a stale ticket (a double-submit-against-stale-file risk). The sibling create-ticket modal
shows the same pattern. Likelihood is low because the modal overlay normally covers the board, but
it is a latent bug.

## Acceptance Criteria
- [ ] Re-opening the bug modal does not leave stale `submit`/`cancel` listeners bound to a previous `file`; only the current invocation's handlers are active.
- [ ] Implemented via a robust pattern: attach with `{ once: true }`, and/or remove any existing listeners / reset the button nodes at the top of `openBugReportModal`.
- [ ] A submit only ever writes/moves the ticket named by the most recent open of the modal.
- [ ] Existing submit/cancel/empty-input behavior is otherwise unchanged.
- [ ] (Optional, note only) Assess whether the sibling create-ticket modal warrants the same fix; if trivial, apply the same pattern, otherwise leave a code comment.

## Cucumber Tests
```gherkin
Feature: Bug modal does not act on a stale ticket

  Scenario: Re-opening the modal rebinds to the new ticket
    Given the bug modal was opened for ticket A but not dismissed
    When the bug modal is opened again for ticket B
    And the user submits a bug description
    Then only ticket B receives the bug entry and the move to todo
    And ticket A is not modified

  Scenario: A single submit fires once (edge)
    Given the bug modal is open for a ticket
    When the user clicks Submit
    Then the submit handler runs exactly once and the listeners are removed afterward
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
