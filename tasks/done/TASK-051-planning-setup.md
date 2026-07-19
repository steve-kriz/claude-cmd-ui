---
id: TASK-051
title: planning setup
status: done
created: 2026-07-19T06:04:41.141Z
updated: 2026-07-19T08:00:00Z
order: 2
---

## Description
The orchestrate **Phase 1 — Plan / Define (business-analyst / "planning") phase**
must dispatch its subagent on a specific model: use **Fable 5**
(`claude-fable-5`) when it is available, and otherwise fall back to **Opus 4.8**
(`claude-opus-4-8`). Today nothing in the orchestrate skill or the
`orchestrate-ba` agent definition says which model the planning phase runs on, so
the choice is left to whatever default the environment picks.

This is a **workflow-configuration / documentation change only** — it changes the
instructions that drive how the planning phase is dispatched. It does **not**
change any product runtime code (`main.js`, `renderer/`, `lib/`, `preload.js`).

The directive must be added to the orchestrate skill instructions in the Phase 1
dispatch text, and — because Claude Code agent definitions can declare a
preferred `model:` in frontmatter — the preferred model (`claude-fable-5`) should
also be recorded on the `orchestrate-ba` agent definition. Because a single
frontmatter `model:` value cannot express the "else Opus 4.8" fallback, the
fallback rule lives in the SKILL.md prose (the orchestrator reads that text when
it launches the Task-tool subagent).

Both files exist as **paired copies** — `.claude/` (project) and `assets/`
(bundled/canonical) — that a drift-guard test requires to be **byte-for-byte
identical**. Every edit below MUST be mirrored across both copies of the affected
file or the drift guard fails.

## Acceptance Criteria
- [ ] `.claude/skills/orchestrate/SKILL.md` states, in the Phase 1 / planning
      dispatch instructions, that the planning (business-analyst) subagent is
      dispatched on **Fable 5 (`claude-fable-5`) when available, otherwise Opus
      4.8 (`claude-opus-4-8`)**, including the explicit "else / otherwise"
      fallback wording.
- [ ] The exact model id strings `claude-fable-5` and `claude-opus-4-8` both
      appear in `.claude/skills/orchestrate/SKILL.md`.
- [ ] `assets/skills/orchestrate/SKILL.md` contains the identical directive, and
      the two SKILL.md copies remain **byte-for-byte identical** (drift guard
      still passes).
- [ ] `.claude/agents/ba.md` frontmatter declares the preferred model
      `model: claude-fable-5` (a new frontmatter key, added without removing or
      altering `name`, `description`, or `tools`, and keeping `name:
      orchestrate-ba`).
- [ ] `assets/agents/ba.md` contains the identical frontmatter change, and the
      two `ba.md` copies remain **byte-for-byte identical**.
- [ ] The `orchestrate-ba` frontmatter still parses under the repo's existing
      frontmatter parser: `name`, `description`, and `tools` are unchanged, and
      the BA tool scoping stays `Read, Grep, Glob` (no `Edit`/`Write`/`Bash`).
- [ ] The directive is scoped to the **planning / Phase 1** dispatch only — the
      coder (Phase 2), tester (Phase 3), and tech-lead (Phase 4) dispatch
      instructions are NOT given a `claude-fable-5`/`claude-opus-4-8` model
      directive, and the coder/tester/tech-lead agent defs get no `model:` key.
- [ ] A test/guard asserts: (a) both SKILL.md copies contain the Fable→Opus
      directive with both model ids and the fallback wording; (b) both SKILL.md
      copies stay byte-identical; (c) both `ba.md` copies carry `model:
      claude-fable-5` and stay byte-identical. These follow the style of
      `test/orchestrate-agents.test.js` (LF-normalized reads, `assert.match` /
      `includes`, `Buffer.equals` for byte-identity).
- [ ] No product runtime source file is modified (`main.js`, `preload.js`,
      `lib/**`, `renderer/**` untouched by this ticket).
- [ ] The full suite passes under `node --test` (existing drift/dispatch guards
      in `test/orchestrate-agents.test.js` and `test/orchestrate-tech-lead.test.js`
      still pass).

## Cucumber Tests
```gherkin
Feature: Planning phase runs on Fable 5 with an Opus 4.8 fallback

  Background:
    Given the orchestrate skill files at ".claude/skills/orchestrate/SKILL.md"
      and "assets/skills/orchestrate/SKILL.md"
    And the business-analyst agent defs at ".claude/agents/ba.md"
      and "assets/agents/ba.md"

  Scenario: SKILL Phase 1 directive names Fable 5 as preferred
    When I read the Phase 1 / planning dispatch section of either SKILL.md copy
    Then it instructs dispatching the planning subagent on "claude-fable-5" when available

  Scenario: SKILL Phase 1 directive names Opus 4.8 as the fallback
    When I read the Phase 1 / planning dispatch section of either SKILL.md copy
    Then it states that otherwise the planning subagent uses "claude-opus-4-8"
    And it uses explicit fallback wording such as "otherwise" or "else"

  Scenario: Both SKILL.md copies stay in sync after the change
    When I read both SKILL.md copies as bytes
    Then they are byte-for-byte identical

  Scenario: The BA agent declares the preferred model
    When I parse the frontmatter of either ba.md copy
    Then the "model" key equals "claude-fable-5"
    And the "name" key is still "orchestrate-ba"
    And the "tools" key is still "Read, Grep, Glob"

  Scenario: Both ba.md copies stay in sync after the change
    When I read both ba.md copies as bytes
    Then they are byte-for-byte identical

  Scenario: Only the planning phase gets the model directive
    When I read the Phase 2, Phase 3, and Phase 4 dispatch sections of SKILL.md
    Then none of them names "claude-fable-5" or "claude-opus-4-8"
    And the coder, tester, and tech-lead agent defs have no "model" key

  Scenario: Failure — the assets SKILL copy drifts from the project copy
    Given only ".claude/skills/orchestrate/SKILL.md" received the directive
    And "assets/skills/orchestrate/SKILL.md" was left unchanged
    When the drift guard compares the two copies byte-for-byte
    Then the guard fails and reports the two SKILL.md copies are not identical

  Scenario: Failure — the Fable/Opus directive is missing from SKILL.md
    Given neither SKILL.md copy mentions "claude-fable-5" or "claude-opus-4-8"
    When the directive-presence guard runs
    Then it fails because the planning model directive is absent

  Scenario: Failure — the model id is misspelled
    Given a SKILL.md copy says "claude-fabel-5" instead of "claude-fable-5"
    When the directive-presence guard checks for the exact model id string
    Then it fails because "claude-fable-5" is not present
```

## Edge and Failure Cases
- **Drift between paired copies.** Editing only the `.claude/` copy (or only the
  `assets/` copy) of SKILL.md or ba.md must fail the byte-identity guard. Both
  copies of any changed file must be updated together.
- **Misspelled model id.** The stub says "fabel"; the correct id is
  `claude-fable-5`. The guard must check for the exact strings `claude-fable-5`
  and `claude-opus-4-8` so a typo is caught.
- **Missing fallback wording.** Stating only Fable, or only Opus, without the
  "otherwise/else" relationship, must not satisfy the directive — both models and
  the fallback relationship are required.
- **Frontmatter regression on ba.md.** Adding `model:` must not drop or reorder
  `name`/`description`/`tools`, must not change `name: orchestrate-ba`, and must
  keep tool scoping `Read, Grep, Glob` so the existing `EXPECTED['ba.md']`
  assertions (name + tool scoping, no Edit/Write/Bash) in
  `test/orchestrate-agents.test.js` keep passing.
- **Scope leakage.** The directive must not attach to Phase 2/3/4 dispatch or to
  the coder/tester/tech-lead agent defs; a test asserts those model ids do not
  appear outside the planning context.
- **CRLF/LF.** The repo tests read files LF-normalized for content matching but
  compare raw bytes for the drift guard. The coder must keep the two copies of
  each file identical at the byte level (same line endings) — not merely
  content-equal after normalization.
- **Product code untouched.** No change to `main.js`, `preload.js`, `lib/**`,
  `renderer/**`; this is instruction/config only.

## Relevant Files and Context
- **Skill instructions (paired, must stay byte-identical):**
  - `.claude/skills/orchestrate/SKILL.md`
  - `assets/skills/orchestrate/SKILL.md`
  - Edit target within these files:
    - "Agent dispatch and fallback" section (lines ~114–130) — where per-phase
      dispatch is described.
    - "Phase 1 — Plan / Define (business analyst)" section (lines ~132–177),
      specifically the launch step (~lines 152–155): "Launch **one** subagent
      (Task tool, `orchestrate-ba`; fall back to `general-purpose` …)". Add the
      "dispatch on `claude-fable-5` when available, otherwise `claude-opus-4-8`"
      directive here (and/or as a sub-bullet in the Agent dispatch section scoped
      to Phase 1).
- **Business-analyst agent definition (paired, must stay byte-identical):**
  - `.claude/agents/ba.md`
  - `assets/agents/ba.md`
  - Current frontmatter (lines 1–9): `name: orchestrate-ba`, folded
    `description: >-`, `tools: Read, Grep, Glob`. Add a `model: claude-fable-5`
    scalar line inside the `---` block. Do NOT touch `coder.md`, `tester.md`, or
    `tech-lead.md`.
- **Model id strings (exact):** `claude-fable-5` (Fable 5), `claude-opus-4-8`
  (Opus 4.8).
- **How a model is specified for an agent:** Claude Code agent frontmatter is a
  flat `key: value` block; a `model:` key sets the agent's preferred model. The
  repo's frontmatter parser (`parseAgentFrontmatter` in
  `test/orchestrate-agents.test.js`, lines ~97–130) reads arbitrary scalar keys,
  so `model:` parses fine. Frontmatter carries only the single preferred model;
  the "else Opus 4.8" fallback must be expressed in SKILL.md prose because the
  orchestrator reads that text when launching the Task-tool subagent.
- **Existing drift-guard / dispatch tests to follow and keep green:**
  - `test/orchestrate-agents.test.js`
    - SKILL byte-identity guard: line ~354 (`the two SKILL.md copies are
      byte-identical (drift guard)`) and Gherkin mirror line ~519.
    - Agent-file byte-identity guard: line ~294 (`each bundled agent file is
      byte-identical to its project copy`).
    - `EXPECTED['ba.md']` contract (name + tool scoping): lines ~68–91.
    - Helpers to reuse: `readFileLF` (~140), `parseAgentFrontmatter` (~97),
      `parseTools` (~133), constants `ASSETS_SKILL`/`PROJECT_SKILL`/
      `ASSETS_AGENTS`/`PROJECT_AGENTS` (~58–63). Part 3 (SKILL dispatch + drift
      guards, ~309–373) is the natural home for the new assertions.
  - `test/orchestrate-tech-lead.test.js` — same pattern for a prior SKILL+agent
    change (byte-identity + SKILL prose match); useful template for a
    directive-presence + drift test.
- **Test runner:** `node --test` (Gherkin scenarios are written as scenario-style
  `node --test` cases in Given/When/Then form; no `cucumber` npm package).
- **Repo rule:** `.claude/` instruction files and their `assets/` copies must be
  kept byte-for-byte in sync or tests fail — mirror every edit.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
