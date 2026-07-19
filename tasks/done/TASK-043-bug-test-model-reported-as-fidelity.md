---
id: TASK-043
title: align bug-create test models with the real 'Reported as <id>' fold composition
status: done
created: 2026-07-19T00:23:05Z
updated: 2026-07-19T02:15:00Z
---

## Description
Follow-up from the TASK-039 tech-lead review (nit — test fidelity; really a TASK-037 coverage gap). The bug-create test models fold STEP 1 with a bug text that only partially mirrors the real code. The REAL code (`renderer/renderer.js` ~6714, from TASK-037) folds `{ bug: 'Reported as ' + id + '\n' + bugDesc }` — the bidirectional "Reported as <NEW_ID>" prefix PLUS the description. This ticket aligns the models and ensures a drift guard ties the composition to the real renderer source.

## Acceptance Criteria
- [x] The bug-create STEP-1 fold in the test models composes the bug text the SAME way real `onCreateBug` does: `'Reported as ' + <newId> + '\n' + <bugDesc>`.
- [x] A drift guard ties the `'Reported as ' + id + '\n' + bugDesc` composition to the real renderer source (present in task-031 e2e+unit and task-037 e2e).
- [x] The existing TASK-031 / TASK-039 assertions (fold count, STEP-2 partial state, retry-no-duplicate) continue to pass unchanged.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Bug-create test models mirror the real fold composition

  Scenario: The model folds the Reported-as prefix plus the description
    Given the bug-create test model performs STEP 1
    Then the folded bug text equals "Reported as <newId>\n<bugDesc>"

  Scenario: Drift is caught (edge)
    Given the real onCreateBug drops the "Reported as " + id prefix
    Then a drift-guard test fails
```

## Relevant Files and Context
- `test/task-031-bug-reporting.e2e.test.js` — `simulateCreateBug` STEP-1 fold + drift guard.
- `test/task-031-bug-reporting.test.js` — unit session model fold + drift guard.
- `test/task-037-bug-link.e2e.test.js` — existing drift guard on the same composition.
- `renderer/renderer.js` (~6714) — the real fold composition (source of truth).

## Edge and Failure Cases
- Model composition must match real code exactly (prefix + newline + desc).
- Do not break the count-based STEP-2/retry assertions.
- Prefer referencing the existing TASK-037 drift guard over duplicating it.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)

## Orchestration Notes
- Test: full suite green (1005 pass, 0 fail). Both model folds already composed `'Reported as ' + newId + '\n' + bugDesc`; drift guards already existed (task-031 e2e:560/unit:483, task-037 e2e:276) and were confirmed rather than duplicated. Added a new e2e scenario + unit test proving the two-line composition (the id line is load-bearing). All DB/IO mocked.
- Tech-lead review: CLEAN, all four AC verified; guards read real renderer source (non-tautological) and would fail if the `Reported as <id>` prefix were dropped. Production `id` is internally-generated `TASK-<n>` and the whole bug text passes through `escapeLeadingHeadingRun` (per-line) — no injection vector. No follow-ups.
- Post-processing (TASK-035 security review): satisfied — reviewer's security dimension covered both the test code and the production composition, found clean.
