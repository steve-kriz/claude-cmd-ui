---
id: TASK-034
title: add behavioral (non-source-scan) test for post-processing create/lane flow
status: done
created: 2026-07-18T21:57:07.000Z
updated: 2026-07-18T22:48:28Z
---

## Description
Follow-up from the TASK-028 tech-lead review (minor / test-quality, optional). The TASK-028 e2e file (`test/task-028-post-processing.e2e.test.js`) proves lane routing against a hand-copied `placeCard` that duplicates `renderTasksBoard`'s routing (`renderer/renderer.js` ~5624-5629) verbatim, with no assertion tying the copy to the real source. The Add-button click, folder routing, `mkdir`, actual file write, and modal fill/save are all only source-scanned as text (`assert.match` on the renderer source). If the real `renderTasksBoard` / `openNewTaskModal` diverged from the copied logic, the behavioral scenarios would still pass. This matches the repo's established "renderer isn't requireable, no jsdom" convention, so it is not a defect — but the create-from-board and fill/save behavior would benefit from either a real DOM-level assertion or a guard that the copied routing matches the source region it claims to mirror.

## Acceptance Criteria
- [x] Add a test that reduces the source-scan/real-code gap for the post-processing flow, via EITHER:
  - (a) a lightweight assertion that the routing logic copied into the e2e test matches the corresponding region of `renderer/renderer.js` (e.g. extract-and-compare the routing snippet so the copy cannot silently drift from source), OR
  - (b) a jsdom-backed behavioral test (only if a jsdom dev-dependency is acceptable to the maintainer — do NOT add heavyweight deps without confirmation; prefer option (a) otherwise) that drives the Add button → file-write path and the detail-modal fill/save against the actual DOM.
- [x] The chosen approach covers: post-processing lane routing, the Add-button create path (writes `status: post-processing` + `kind: post-processing` into `tasks/post-processing/`), and the detail-modal fill not silently relabelling a `failed-testing` ticket to `todo`.
- [x] The test fails if the real renderer routing/create logic diverges from what the test asserts (i.e. it is not a tautology against a private copy).
- [x] No production/runtime dependency added; any new dependency is dev-only and confirmed acceptable, otherwise use option (a).
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Post-processing behavioral coverage is tied to real source

  Scenario: The routing assertion tracks the real renderer source
    Given the e2e routing logic used to assert lane placement
    Then it is verified against the actual renderTasksBoard routing region in renderer.js
    And the test fails if that source region changes incompatibly

  Scenario: The Add-button create path is exercised beyond a text scan
    When the post-processing Add flow is driven
    Then a file with status "post-processing" and kind "post-processing" under tasks/post-processing/ is asserted from the real code path (or the source-tracking guard)

  Scenario: Failure/edge — divergence is caught
    Given the real routing is changed to route failed-testing somewhere other than testing
    Then the behavioral/guard test fails
```

## Relevant Files and Context
- `test/task-028-post-processing.e2e.test.js` — the existing e2e file with the copied `placeCard` (~84-95) and the source-scan assertions.
- `renderer/renderer.js` — `renderTasksBoard` routing (~5624-5629), `openNewTaskModal` (~6389+), detail-modal fill (~5797-5809). Not requireable.
- Repo convention: renderer behavior is verified by scanning source text (see `test/ticket-lanes.test.js`, `test/ticket-folders.test.js`). Option (a) should follow/extend that convention with a drift-catching comparison.

## Edge and Failure Cases
- Renderer routing changed so `failed-testing` no longer folds into `testing` → test must fail.
- Add-path status/kind/folder changed → test must fail.
- Detail-modal fill reverting to a `todo` fallback for out-of-list statuses → test must fail.

## Implementation Notes
- Option (a) chosen (no jsdom / no new dependency). `test/task-028-post-processing.e2e.test.js` gained 3 source-tracking drift guards (~368-558): Guard 1 extracts the real `renderTasksBoard` routing region and normalizes both it and the copied `placeCard` to a canonical token form, pinning `failed-testing → testing` and each canonical status → its own lane; Guard 2 asserts the real Add path composes `status`/`kind: post-processing` and files via `ticketFolderForStatus` into `tasks/post-processing/`; Guard 3 asserts the detail-modal fill preserves an out-of-list status and never re-defaults the select to `todo` (with an explicit negative guard).
- `test/task-034-routing-drift-guard.test.js` (new unit file): pure predicates `routingFoldsFailedIntoTesting`, `addPathComposesPostProcessing`, `fillPreservesOutOfListStatus` over renderer source text, each asserted true against the REAL `renderer/renderer.js` and false against string-mutated copies for every ticket divergence. A `mutate()` helper asserts the `from` substring exists in real source before replacing, so a rotted marker fails loudly rather than faking a "divergence caught" pass — proving the guards are non-tautological.
- Full suite green: 842 pass / 0 fail. Tech-lead review clean (one nit: Guard 1's pinned canonical form would trip on an innocent `laneKey` rename/brace reformat — an accepted tight-guard trade-off). Security review (post-processing TASK-035): clean — no `eval`/`Function`/exec, constant in-repo read paths only, zero writes, no dependency/lockfile change; the extracted source is inert text, purely additive coverage.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
