---
id: TASK-112
title: TASK-091 review: scaffold test-hardening + cosmetic empty-state
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:19:32.505Z
review-of: TASK-091
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:56:00Z","finishedAt":"2026-07-21T03:13:57Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:58:00Z","finishedAt":"2026-07-21T03:16:23Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:00:00Z","finishedAt":"2026-07-21T03:19:32Z"}]
---

## Description
Review follow-ups for TASK-091 (Team sub-tab scaffold). Test-hardening only, plus one documented cosmetic decision. Severity from review: **minor**. This is a review follow-up of TASK-091.

**F1 — harden the drift-guard slice end.** Three sites extract the real `initTeamTab` body from `renderer/renderer.js` by slicing from `indexOf('function initTeamTab(tab)')` to `rendererSrc.indexOf('\nfunction ', fnStart + 1)`: `test/task-091-team-tab-scaffold.test.js` (~173-174) and `test/task-091-team-tab-scaffold.e2e.test.js` (~312-313 and ~335-336). `initTeamTab` is followed by comments + top-level `const WF_*` declarations before the next plain `function wfIsFallback`, so the slice already over-extends; worse, if the next top-level decl becomes `async function` (this file has many) or initTeamTab moves to end-of-file, `indexOf` returns -1 and `slice(fnStart, -1)` expands to nearly the whole file, so positive assertions match foreign code and the guard no-ops. Replace with a shared-per-file helper that (a) asserts the header index is found, (b) asserts an end boundary is found (never slices with -1), (c) bounds tightly — recommended anchor the function's own column-0 closing brace `indexOf('\n}', fnStart)` (alternative: min of next `\nfunction `/`\nasync function `). A rename/move must fail loudly, and the slice must still cover initTeamTab's full body.

**F2 — remove dead `vEnd` + magic windows.** `e2e ~134-137` computes an unused `vEnd` (tautological ternary; looks up `.teamBoardBody` with a dot that never appears in HTML). Two panel slices use a magic `vStart + 1800` window (~142 and ~275). Delete the `vEnd` block; replace both windows with a slice bounded at `htmlSrc.indexOf('</template>', vStart)` (the workspace-template close; the Team panel is the last tab-view in it), asserting the anchor is found.

**F3 — cosmetic "(open a folder)" x4: document, no product change.** `initTeamTab`'s no-folder branch sets the literal on status + all three bodies (vs initTasksTab's single status). Keep it (static HTML already ships the literal in all three bodies; blanking would show bare frames; the per-body write clears stale content on folder→no-folder). Add a brief comment in the no-folder branch marking the per-section empty state as deliberate. No assertions change for F3.

Scope guard: changes the two task-091 test files + one comment in `renderer/renderer.js` only. No behavior of initTeamTab/index.html/styles.css changes.

## Acceptance Criteria
- [ ] All three drift-guard slice sites obtain the initTeamTab body via a helper that asserts header index != -1 AND end-boundary index != -1 before slicing — `slice(start, -1)`/whole-file expansion is impossible by construction.
- [ ] The slice end is anchored structurally (recommended column-0 `\n}`; alternative min of next `\nfunction `/`\nasync function `), so renaming/moving a FOLLOWING function cannot widen the slice.
- [ ] The extracted slice still contains initTeamTab's entire body — every existing guard assertion (folder guard, four "(open a folder)" literals, status blank, three `refreshTeam*(tab)` delegations, three not-blanked negatives, no `addEventListener`) passes unchanged in meaning; with the `\n}` anchor the slice no longer includes the trailing `WF_*` constants.
- [ ] A failure-path check proves the hardened guard still guards: applying its assertions to a doctored source where initTeamTab's `refreshTeamBoard(tab)` call is removed (or the no-folder literal changed) is detected.
- [ ] The dead `vEnd` computation (incl. the `.teamBoardBody` lookup) is deleted.
- [ ] Both magic `vStart + 1800` windows are replaced with a slice bounded at `htmlSrc.indexOf('</template>', vStart)`, asserted found.
- [ ] Against the bounded panel slice all existing panel assertions still pass: `.view-toolbar` + "Team" title, three section hooks + headings, three "(open a folder)" bodies, exactly five header buttons (Agents Add/Refresh, Workflow Refresh, Board Save/Refresh), no inline `<input>`/`<select>`.
- [ ] F3: initTeamTab runtime behavior unchanged; a brief comment in the no-folder branch records that the per-section empty state is deliberate.
- [ ] `node --test test/task-091-team-tab-scaffold.test.js test/task-091-team-tab-scaffold.e2e.test.js` passes; full suite shows only the 2 known-baseline failures.
- [ ] No changes to renderer/index.html, renderer/styles.css, or any behavior in renderer/renderer.js.

## Cucumber Tests
```gherkin
Feature: TASK-091 drift-guard and panel-slice hardening
  Scenario: The drift-guard slice is bounded by initTeamTab's own end
    Given the shipped renderer/renderer.js source
    When the hardened helper extracts the initTeamTab body
    Then the slice starts at "function initTeamTab(tab)" and ends at its closing brace
    And the slice does not contain "WF_FALLBACK_AGENT" or "function wfIsFallback"
    And every existing drift-guard assertion passes against the slice
  Scenario: A missing end anchor fails loudly instead of expanding (edge)
    Given a doctored source with no top-level boundary after "function initTeamTab(tab)"
    When the hardened helper is applied
    Then it throws an assertion error and never returns a slice to end-of-source
  Scenario: A renamed initTeamTab fails loudly (edge)
    Given a doctored source where "function initTeamTab(tab)" is renamed
    When the hardened helper is applied
    Then it throws at the header lookup
  Scenario: The drift guard still catches a real regression (failure)
    Given a doctored source where initTeamTab no longer calls refreshTeamBoard(tab)
    When the drift-guard assertions run against the helper's slice
    Then the "board body delegated to refreshTeamBoard" assertion fails
  Scenario: The Team panel slice is structurally bounded
    Given the workspace template in renderer/index.html
    When the panel is sliced from data-view="team" to the template close
    Then the slice has the "Team" toolbar, three section hooks+headings, three "(open a folder)" bodies, exactly five header buttons, no input/select
    And no dead vEnd or fixed +1800 window remains in the test
  Scenario: No-folder empty state unchanged and documented (F3)
    Given a workspace with no folder open
    When the Team tab is activated
    Then status and all three section bodies show "(open a folder)"
    And initTeamTab's no-folder branch carries a comment marking it deliberate
```

## Edge Cases & Failure Paths
- Next decl becomes `async function` — hardened anchor must not widen. initTeamTab moved to end / no following function — assert and fail loudly. Renamed header — fail with clear message. `\n}` anchor valid while file keeps 2-space indent and initTeamTab has no column-0 `}` (regression meta-check is the safety net). CRLF: `\n}` matches within `\r\n}`. New tab-view added after Team panel → `</template>` bound includes it and "exactly five buttons" fails loudly (acceptable — visible failure, not silent). `</template>` missing → anchor assert fires. F3 behavior unchanged. Do not weaken any guard while hardening.

## Relevant Files & Context
- `test/task-091-team-tab-scaffold.test.js` — DRIFT GUARD ~172-207, fragile slice ~173-174; stale `~5692` header comment.
- `test/task-091-team-tab-scaffold.e2e.test.js` — dead `vEnd` ~134-137; magic windows ~142 and ~275; fragile slices ~312-313 and ~335-336.
- `renderer/renderer.js` — `initTeamTab` (~6567-6582; no-folder ~6568-6574; with-folder delegation ~6575-6581; column-0 `}` ~6582); trailing `WF_*` consts; `initTasksTab` (~6547-6560, the single-status pattern F3 compares).
- `renderer/index.html` — Team panel (~697-727, last tab-view); static "(open a folder)" ~709/716/724; five header buttons; `</template>` ~732 (recommended slice anchor).
- Tests self-contained `node --test` source-scan style; duplicating the small slice helper per file matches convention. 2 known-baseline failures unrelated.

## Impact If Not Fixed
A future edit near initTeamTab or a rename can quietly turn the drift guard into a no-op, so a real regression in the Team scaffold could pass green; the cosmetic redundancy makes the empty Team tab look less polished than the Tasks tab it mirrors.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
