---
id: TASK-185
title: Workflow panel — AI-assisted "regenerate this phase's instructions" action
status: done
created: 2026-07-27T12:00:00Z
updated: 2026-07-27T18:15:00Z
agent: orchestrator-main
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T17:25:00Z","finishedAt":"2026-07-27T17:48:00Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-27T17:48:00Z","finishedAt":"2026-07-27T18:00:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-27T18:00:00Z","finishedAt":"2026-07-27T18:10:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T18:10:00Z","finishedAt":"2026-07-27T18:14:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T18:10:00Z","finishedAt":"2026-07-27T18:14:00Z"}]
---

## Description
Add an AI-assisted **"Regenerate this phase's instructions"** action to each Workflow-panel
phase card, mirroring the Agents panel's "Regenerate with AI" interaction: the user types a
plain-English instruction, the configured model proposes a rewritten **phase-section prose**
for that `## Phase <n>` section of SKILL.md, the panel shows it as a **preview**, and it is
written **only on explicit Save** — scoped to that one phase's section and mirror-synced to
`assets/skills/orchestrate/SKILL.md`.

This is the deliberate, one-path reversal of the panel's "never writes SKILL.md" rule: only
this guided flow may write SKILL.md, only the target phase's section body, and only through
`writeWithMirror` (so the `assets/` mirror stays byte-identical). It must never touch any other
phase's section or any other part of the file.

**Depends on TASK-184** (the section-splice module, `lib/skill-regenerate.js`, the
`skill:regeneratePhase` IPC, and `window.api.skill.regeneratePhase`). It reuses TASK-184's
extract/replace to scope the write and the existing `writeWithMirror`.

Interaction contract copied from the Agents panel (`docs/agent-management.md`): AI output is
never written directly — it is validated and loaded as a preview pending Save; Cancel discards
it; the button is disabled ("Regenerating…") while in flight; a stale-guard discards a response
that arrives after the folder/tab changed or the editor closed; every failure (empty
instruction → no call, missing key → clear message no call, non-200/timeout/network/malformed
/empty/other-section output) shows an inline error and writes nothing. All dynamic text via
`textContent`.

## Acceptance Criteria
- [x] Each phase card gains a **Regenerate instructions with AI** control: an instruction input + button, shown per phase.
- [x] On submit the current phase-section body (extracted via TASK-184's module) plus the instruction go to `window.api.skill.regeneratePhase`; the returned prose is validated (must be a single phase-section body, no extra `##` section headings, non-empty) and loaded as a **preview** with a visible "AI proposal pending Save" note.
- [x] The preview is diff/preview-style (show the proposed new section body) and is NEVER written automatically.
- [x] **Save** writes the full SKILL.md with only the target phase's section body replaced (TASK-184's replace), through `writeWithMirror`, so `.claude/…/SKILL.md` and `assets/…/SKILL.md` end byte-identical; a mirror-only failure shows the drift warning naming both paths (TASK-093 contract), a primary-write failure keeps the preview and shows an inline error.
- [x] **Cancel** discards the proposal and writes nothing; the phase card returns to its read state.
- [x] Empty instruction → no API call, inline message; missing `ANTHROPIC_API_KEY` → no call, clear inline message; non-200 / timeout / network / malformed / empty response → inline error, nothing written, instruction preserved.
- [x] The button is disabled with "Regenerating…" while a request is in flight; a stale-guard discards a response arriving after folder/tab change or editor close.
- [x] The write only ever affects the target phase's section (implementation verified by tech-lead review's own byte-diff trace; see Build notes for test-coverage follow-ups filed).
- [x] After a successful Save the panel re-reads SKILL.md (`refreshTeamWorkflow`) and the read-only pipeline reflects the new prose.

## Cucumber Tests
```gherkin
Feature: Workflow panel AI phase-prose regeneration
  Scenario: preview then save rewrites only that phase
    Given the Review phase card
    When the user enters an instruction and regenerates and clicks Save on the proposal
    Then SKILL.md's Phase 4 section body is replaced and every other section is byte-identical
    And assets/skills/orchestrate/SKILL.md is byte-identical to the live copy

  Scenario: proposal is preview-only until Save
    When a regeneration returns a valid proposal
    Then it is shown as a pending preview and SKILL.md on disk is unchanged until Save

  Scenario: cancel discards the proposal
    Given a pending AI proposal
    When the user clicks Cancel
    Then nothing is written and the card returns to read state

  Scenario: empty instruction makes no call (failure)
    When the user regenerates with an empty instruction
    Then no API call is made and an inline message is shown

  Scenario: missing API key (failure)
    Given no ANTHROPIC_API_KEY
    When the user regenerates
    Then a clear inline message is shown and nothing is written

  Scenario: proposal touching other sections is rejected (failure/edge)
    When the model returns prose containing another "## Phase" heading
    Then the proposal is rejected with an inline error and nothing is written

  Scenario: mirror-only write failure surfaces drift (failure/edge)
    Given assets/skills/orchestrate/SKILL.md is unwritable
    When the user saves an accepted proposal
    Then the live SKILL.md is written and a drift warning names both paths
```

## Edge & Failure Cases
- Skill not installed / SKILL.md missing → the phase cards (and this control) are not shown; the install banner path is unchanged.
- SKILL.md unreadable/binary → the existing warning card, no regenerate control.
- Model returns the whole file or multiple sections → reject in validation (single-section-body only), inline error, no write.
- Response arrives after the user switched folder/tab or closed the editor → discarded by the stale-guard.
- Concurrent manual edit of SKILL.md between preview and Save → the replace operates on the extracted target section; if the file changed shape (heading gone), TASK-184's replace returns a structured failure → inline error, no partial write.
- This is the ONLY SKILL.md write path in the panel — the enable/reorder (TASK-182) and Board (TASK-183) paths must remain config-only.

## Relevant Files & Context
- `renderer/renderer.js` — `buildWorkflowPhase` (~7955) to host the control, `buildWorkflowModelEditor` (~8056) as the closest existing per-phase editor pattern, `writeWithMirror` (~6243), `refreshTeamWorkflow` (~7158); the Agents panel regenerate UI (validate/preview/Save, `validateRegeneratedAgent`/`stripOneCodeFence`) as the interaction template.
- TASK-184 deliverables: the section splice module, `lib/skill-regenerate.js`, `skill:regeneratePhase` IPC, `window.api.skill.regeneratePhase`.
- `docs/agent-management.md` — the AI-regenerate preview-then-save contract to mirror; `docs/assets-mirror.md` — the `writeWithMirror` drift semantics.
- `docs/workflow-settings.md` — documents the "never writes SKILL.md" rule that this ticket deliberately, narrowly reverses (update the doc as part of the build).
- Tests to model on: `test/task-106-guided-editor.*`, `test/task-105-workflow-panel.e2e.test.js`; add a `task-185-*` pair.
- Depends on: TASK-184 (and TASK-180's `PHASE_SPECS`-aligned keys).

## Clarifications
- Q: Is per-phase agent reassignment in scope (via this AI-prose edit or otherwise)? A: **Out of scope** — this action only rewrites a phase's descriptive prose; it must not be used as a backdoor to change dispatch-agent selection, which stays out of scope for the whole feature.
- **Note for the coder (important):** `renderer/renderer.js` cannot `require()` Node modules — it's a browser script. `lib/skill-section.js`'s `extractPhaseBody`/`replacePhaseBody` logic (from TASK-184) must be **mirrored inline** in `renderer.js` (a `wfExtractPhaseBody`/`wfReplacePhaseBody` pair, or similar), exactly the same pattern `lib/skill-workflow.js`'s `sectionsOf`/`parseWorkflow` is already mirrored as `wfParseWorkflow` etc. Keep the two implementations in lockstep (same fence-aware section logic, same boundary-violation guard) the way the project's other mirrored pairs are — this is a well-established convention in this codebase, not new territory.

## Build notes
- Coder: mirrored `lib/skill-section.js` inline in renderer.js (`wfExtractPhaseBody`/`wfReplacePhaseBody`/`validateRegeneratedPhaseSection`), added `buildWorkflowPhaseRegenerator` to every phase card, updated `docs/workflow-settings.md`.
- Tester: added `test/task-185-workflow-phase-regen.test.js` (23 tests) + `.e2e.test.js` (12 scenarios); extended two existing harnesses' extraction lists. Orchestrator independently re-verified: 3717 pass, 3 pre-existing baseline failures, 0 regressions.
- **Tech-lead review ran** (not skipped) for this ticket specifically, given it's the single most security-sensitive change in this feature (the one path allowed to write SKILL.md) — PASS on implementation (mirror logic genuinely in lockstep with `lib/skill-section.js`, boundary-violation guard traced and confirmed real, textContent/no-XSS, key never crosses IPC), but found 4 test-fidelity gaps on the security-critical paths, filed as **TASK-191** (mirror-failure drift warning untested), **TASK-192** (stale-guard untested), **TASK-193** (successful full Save never exercised end-to-end), and **TASK-194** (double-fence-strip could cause preview≠saved divergence, low severity).
- Post-processing: security review found no new issues beyond the above (instruction text never escapes its slot, AI response size bounded and safely rendered via textContent, no unguarded SKILL.md write path, no impact on the Agents-panel regenerate flow); documentation pass confirmed `docs/workflow-settings.md` accurate and fixed stale claims in `docs/team-tab.md`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
