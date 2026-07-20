---
id: TASK-081
title: Cover the wont-do save path through the changed-on-disk overwrite guard
status: done
created: 2026-07-19T21:33:22Z
updated: 2026-07-19T22:06:58Z
review-of: TASK-074
activities: [{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T22:01:20Z","finishedAt":"2026-07-19T22:04:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T22:04:00Z","finishedAt":"2026-07-19T22:06:58Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T22:06:58Z","finishedAt":"2026-07-19T22:06:58Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-074 (Finding 2, Low). TASK-074's Edge
Cases list explicitly requires the "Won't do" save to flow through `onSave`'s existing
two-click changed-on-disk overwrite guard (`renderer/renderer.js` ~6242-6258)
unchanged. No unit or e2e test exercises this: every TASK-074 test drives the
`saveViaModal` mirror (`test/wont-do.e2e.test.js`) or source-scans `doWrite` directly,
bypassing `onSave` entirely. The write-failure scenario is covered, but the
changed-on-disk / two-click-to-overwrite path for a won't-do save is not asserted
anywhere. This is a test-only gap — no product-code change is expected.

## Acceptance Criteria
- [ ] A test drives a "Won't do" save through the `onSave` overwrite-guard path:
  when the file changed on disk since it was opened, the first save is blocked/warns
  and the second save (confirm) proceeds, writing `status: done` +
  `resolution: wont-do`.
- [ ] The test asserts the guard is not bypassed by the won't-do mapping (i.e. the
  two-click semantics apply to the won't-do save exactly as to a normal save).
- [ ] No product/implementation code is changed — this is a test-only ticket. If the
  `onSave` guard is genuinely un-exercisable in the browser-only harness, add the
  tightest feasible source-scan tying the won't-do save to the shared `onSave` guard
  and document why a behavioral test is impractical.
- [ ] `node --test` green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Won't-do save respects the changed-on-disk overwrite guard

  Scenario: A won't-do save on a changed-on-disk ticket needs two clicks
    Given a ticket open in the modal whose file changed on disk afterwards
    When the user selects "Won't do" and saves once
    Then the save is blocked and the modal warns the file changed on disk
    When the user saves a second time to confirm
    Then the file is overwritten with status "done" and resolution "wont-do"

  Scenario: The guard is shared, not bypassed (edge)
    Given the won't-do save path
    Then it flows through the same onSave overwrite guard as a normal save
```

## Impact If Not Fixed
A named edge case in TASK-074 has no test. The risk is low today because `onSave` is
shared and unmodified, but a future refactor of `onSave` could regress the won't-do
overwrite behavior — a won't-do save could clobber a concurrent agent write or lose
the two-click confirmation — with all tests still green and nothing to catch it.

## Edge Cases & Failure Paths
- If the harness cannot realistically simulate a changed-on-disk race for a browser
  script, document the limitation and pin the shared-guard wiring with a source-scan
  instead (matching the repo's browser-only testing convention).
- Do not weaken or duplicate the existing write-failure coverage; this adds the
  changed-on-disk/two-click path specifically.

## Relevant Files & Context
- `renderer/renderer.js` — `onSave` overwrite guard ~6242-6258; `doWrite` ~6211-6219.
- Test files: `test/wont-do.e2e.test.js`, `test/wont-do.test.js` (extend these).
- Origin: tech-lead review of TASK-074, Finding 2 (Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
