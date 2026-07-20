---
id: TASK-076
title: harden TASK-072 create-ticket test fidelity
status: done
created: 2026-07-19T12:01:59Z
updated: 2026-07-19T21:36:56Z
activities: [{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T21:15:53Z","finishedAt":"2026-07-19T21:24:31Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T21:24:31Z","finishedAt":"2026-07-19T21:33:22Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T21:33:22Z","finishedAt":"2026-07-19T21:36:56Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-072 (slack create ticket). The feature
itself is correct and shipped; these are two **Low-severity test-fidelity gaps**
the reviewer identified — no product-code change is required, only stronger tests.

1. **`decodeSlackText` interaction is unverified.** In the real renderer,
   `handleIncomingSlackMessage` (`renderer/renderer.js:8468`) runs `decodeSlackText`
   on the incoming reply *before* it reaches `handleCreateTicketReply` /
   `parseCreateTicketReply`. The TASK-072 e2e harness `receive()`
   (`test/slack-create-ticket.e2e.test.js:257-272`) does NOT apply `decodeSlackText`,
   and no unit test feeds decoded auto-link text into the parser. So the documented
   "parser must tolerate decoded auto-linked text" edge (e.g. a title/description
   containing `<http://x|x>` → `x`, or `<@U1>` → `@U1`) has no coverage.
2. **Wiring mirrors in the e2e harness have no drift guard.** The pure core
   (`parseCreateTicketReply` + the registry entry) has byte-identical source-scan
   drift guards (`test/slack-create-ticket.test.js:175-187`), but the hand-copied
   "verbatim mirrors" of the wiring functions (`handleCreateTicketReply`,
   `postCreateTicketReply`, the `create-ticket` handler, and the
   `handleIncomingSlackMessage` pending-check) at
   `test/slack-create-ticket.e2e.test.js:151-272` have no guard tying them to
   `renderer/renderer.js`. If the renderer wiring drifts, the e2e stays green while
   real behavior breaks. This matches the existing `slack-*.e2e` pattern (a known
   limitation, not a TASK-072 regression) but is worth closing for this flow.

## Acceptance Criteria
- [ ] A test drives realistic Slack-encoded text (e.g. `<http://example.com|example.com>`,
  `<@U123>`) through `decodeSlackText` and then into the create-ticket parse/flow,
  asserting the parser tolerates the decoded output and produces the expected
  title/description (covering the documented edge).
- [ ] A `fnBody`-style (or equivalent source-scan) drift guard ties the e2e
  harness's copied wiring functions (`handleCreateTicketReply`, `postCreateTicketReply`,
  the `create-ticket` handler body, and the `handleIncomingSlackMessage` pending-check
  region) to their real definitions in `renderer/renderer.js`, so wiring drift fails
  the test rather than passing silently. If a full byte-identical guard is
  impractical for a browser-only region, add the tightest feasible source-scan
  assertion and document why.
- [ ] No product/implementation code is changed — this is a test-only ticket.
- [ ] `node --test` green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Create-ticket test fidelity is hardened

  Scenario: Decoded auto-linked text flows through the parser
    Given a Slack reply "title: See <http://example.com|example.com>, description: ping <@U123>"
    When it is decoded by decodeSlackText and passed into the create-ticket flow
    Then the parsed title and description reflect the decoded (unwrapped) text
    And the parser does not throw

  Scenario: Wiring drift is caught (failure/edge)
    Given the e2e harness holds copied mirrors of the renderer wiring functions
    When a wiring function in renderer/renderer.js diverges from its harness copy
    Then the drift-guard test fails instead of the e2e passing silently
```

## Edge Cases & Failure Paths
- Decoded text that still contains commas/newlines must still parse per the
  first-label-wins rules.
- The drift guard must tolerate benign whitespace/comment differences only if it
  cannot be byte-identical; prefer byte-identical where feasible.

## Relevant Files & Context
- READ `renderer/renderer.js` — `decodeSlackText` (~8468), `handleIncomingSlackMessage`
  pending-check (~8479-8482), `handleCreateTicketReply` (~8548-8605),
  `postCreateTicketReply` (~8532-8538), `create-ticket` handler (~8445-8449).
- READ / EDIT tests: `test/slack-create-ticket.test.js`,
  `test/slack-create-ticket.e2e.test.js`. Follow the `fnBody` drift-guard pattern in
  `test/slack-defang.test.js:33-39` and the source-scan style in
  `test/slack-redaction.test.js`.
- Origin: tech-lead review of TASK-072 (findings 1 and 2, both Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
