---
id: TASK-202
title: Board panel — per-column instructions editor + relocate concurrency & context-optimisation controls
status: done
created: 2026-08-03T09:30:00.000Z
updated: 2026-08-03T13:10:00.000Z
---

## Description
Update the Team tab **Board** panel in `renderer/renderer.js` to match the new
schema from TASK-201 and to become the single home for the two global skill
settings.

1. **Per-column `instructions` editor.** Add a multi-line editor (a `<textarea>`)
   to each column row that edits `col.instructions`, marking the working model
   dirty on input. Rendered via `.value` / `textContent` only (never `innerHTML`)
   so tampered config can never inject markup.
2. **Keep the renderer mirror in lockstep with `lib/team-config.js`.** The
   renderer is a browser script that cannot `require` Node modules, so it inlines
   a mirror of the schema. Add `instructions` to `tasksBuildColumn`,
   `tasksSerializeTeamConfig`, `refreshTeamBoard`'s column map, and the add-column
   form's seed object; **remove the per-column `phase` `<select>`** and the
   `phase` field from build/serialize/refresh/add-form.
3. **Relocate the two global controls into the Board panel.** Render the existing
   `buildWorkflowConcurrencyControl` (Build concurrency default) and
   `buildWorkflowContextOptimizationControl` (Context optimisation) from
   `renderTeamBoard`, seeded from the Board panel's loaded `skill` and persisted
   through the same `tasks/team-config.json` write path (re-read-fresh,
   keep-last-good, whole-file write). These two controls read/write
   `skill.concurrencyDefault` / `skill.contextOptimization` unchanged.
4. **Update the Board help text** to describe the new model: each column names an
   agent and free-text instructions that the orchestrator dispatches for tickets
   in that column; system columns cannot be removed or re-slugged. Remove every
   mention of phases.

**Out of scope:** deleting the Workflow panel itself and the phase-link
auto-enable helpers (TASK-203) — this ticket adds the relocated controls to the
Board panel and stops rendering `phase` per column, but leaves the Workflow panel
standing until TASK-203 removes it. The two control-builder functions
(`buildWorkflowConcurrencyControl` / `buildWorkflowContextOptimizationControl`)
are **reused**, not duplicated.

## Acceptance Criteria
- [ ] Each column row in `buildTeamColumnRow` renders an "Instructions" `<textarea>` bound to `col.instructions`, calling `markTeamBoardDirty(tab)` on `input`, without a full re-render (focus preserved), matching the existing label/description field pattern.
- [ ] The instructions value is written/read via `.value` only; no `innerHTML` is used for any column field.
- [ ] The per-column Phase `<select>` (and its `col.phase` wiring) is removed from `buildTeamColumnRow`.
- [ ] `tasksBuildColumn` returns an `instructions` field (string, `''` when absent) and no longer returns/reads `phase`.
- [ ] `tasksSerializeTeamConfig` emits `status,label,description,agent,instructions,system` per column (no `phase`) and still normalises `skill.concurrencyDefault` + `skill.contextOptimization`.
- [ ] `refreshTeamBoard`'s column map includes `instructions` and drops `phase`; `buildTeamAddColumnForm`'s inserted column seeds `instructions:''` and no `phase`.
- [ ] `renderTeamBoard` appends the Build-concurrency-default control and the Context-optimisation control (reusing the existing builder functions) inside the Board panel body, below the columns/add-form.
- [ ] Saving the concurrency or context-optimisation control persists only its field into `tasks/team-config.json` (re-reading fresh first, keep-last-good on read failure), without dropping the Board's columns or `instructions`.
- [ ] The Board help text no longer mentions phases and describes agent + instructions driving orchestration.
- [ ] A config produced by this panel's Save round-trips through `lib/team-config.js` `normalizeConfig` unchanged (renderer serialize ≡ lib serialize for the same model).
- [ ] Loading an old `tasks/team-config.json` that still contains `phase`/`skill.phases` renders without error (those fields are ignored/dropped on the next Save).

## Cucumber Tests
```gherkin
Feature: Board panel per-column instructions and relocated global controls

  Scenario: editing a column's instructions marks the board dirty
    Given the Board panel is showing the "in-progress" column
    When the user types "Build carefully" into that column's Instructions box
    Then the working model's "in-progress" instructions is "Build carefully"
    And the board shows unsaved changes

  Scenario: instructions persist on Save and round-trip
    Given the "testing" column instructions is "Run node --test"
    When the user clicks Save
    Then tasks/team-config.json's "testing" column has instructions "Run node --test"
    And re-reading the panel shows that same instructions text

  Scenario: the per-column phase select is gone
    Given the Board panel is rendered for any column
    Then no phase <select> is present in the column row

  Scenario: the concurrency and context-optimisation controls render in the Board panel
    Given the Team tab Board panel is open on a project folder
    Then a "Build concurrency default" control is visible in the Board panel
    And a "Context optimisation" control is visible in the Board panel

  Scenario: saving concurrency does not drop instructions (edge)
    Given the "defining" column has instructions "Define it"
    And the user changes Build concurrency default to 5 and clicks its Save
    When tasks/team-config.json is re-read
    Then concurrencyDefault is 5
    And the "defining" column still has instructions "Define it"

  Scenario: a tampered instructions value renders safely (failure/security path)
    Given a column's instructions on disk is "<img src=x onerror=alert(1)>"
    When the Board panel renders that column
    Then the instructions textarea shows the literal text
    And no markup is injected into the DOM

  Scenario: loading a legacy config with phase fields does not error (edge)
    Given tasks/team-config.json still has phase and skill.phases
    When the Board panel loads
    Then it renders the columns without error
    And a subsequent Save writes a file with no phase or phases keys
```

## Edge & failure cases the coder must handle
- Legacy on-disk config with `phase`/`skill.phases` must load without throwing; the panel simply ignores them and drops them on Save (parity with TASK-201).
- A column with `agent:null` shows "(none)"; a saved agent missing from `.claude/agents/` still shows "(missing)" (existing behaviour at lines 6281–6304 preserved).
- Very long instructions must not break layout (textarea scrolls); newlines preserved on round-trip.
- Save re-read failure must fall back to the render-time snapshot (keep-last-good), never wiping columns/instructions.
- The renderer serialize must stay byte-behaviour-identical to `lib/team-config.js` (lockstep convention documented at lines 5600–5638).

## Relevant files & context
- `C:\projects\claude-cmd-ui2\renderer\renderer.js`:
  - `tasksBuildColumn` (5734+; `phase` handling to remove; add `instructions`).
  - `tasksSerializeTeamConfig` (5933–5972; per-column field map at 5942 has `phase:` — replace with `instructions:`).
  - `refreshTeamBoard` column map (6093) — add `instructions`, drop `phase`.
  - `renderTeamBoard` (6107–6147) and its help text (6121–6126) — append the two controls; rewrite help.
  - `buildTeamColumnRow` fields block (6224–6335) — add the Instructions textarea after Description/Agent; remove the Phase select (6307–6331).
  - `buildTeamAddColumnForm` inserted-column object (6441–6448) — seed `instructions:''`, drop `phase:null`.
  - `buildWorkflowConcurrencyControl` (8813–8909) and `buildWorkflowContextOptimizationControl` (8921–9024) — reuse from `renderTeamBoard`; they already re-read fresh + whole-file write.
  - Mirror constants/labels: `TASKS_SYSTEM_LABELS` (5610), `tasksPrettifyLabel` (5642), `tasksNormalizeContextOptimization` (5681), `resolveTasksConcurrency` (used at 8842).
- `C:\projects\claude-cmd-ui2\lib\team-config.js` — the authoritative schema this mirror must match (TASK-201).
- Renderer tests: `C:\projects\claude-cmd-ui2\test\` (search for board/team-config renderer tests) — expect updates for the removed `phase` UI and added `instructions`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
