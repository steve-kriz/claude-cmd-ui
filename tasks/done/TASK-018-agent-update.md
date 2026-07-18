---
id: TASK-018
title: agent update
status: done
created: 2026-07-18T10:26:18.841Z
updated: 2026-07-18T11:28:42.209Z
finishedAt: 2026-07-18T11:28:42.209Z
order: 3
---

## Description
Add a fourth orchestrate role — a **tech lead / reviewer** — that thoroughly reviews each ticket **after it passes testing (Phase 3) and before the orchestrator marks it `done`**. The reviewer inspects the ticket AND the implementation code, verifies the tests actually exercise/cover the implemented code, and verifies security concerns are addressed. Any problems it finds become **new follow-up fix tickets** (`status: todo`) continuing the `TASK-nnn` sequence, rather than silently failing or blocking the reviewed ticket.

This is primarily an instruction/definition change (a new agent definition + documentation of the review step in the orchestrate SKILL), mirrored across the repo's canonical `assets/` copies, plus a small wiring change to register the new agent in `lib/orchestrate-agents.js`. **No new status enum value is introduced**: the review is a flow step (`testing → tech-lead review → done`), not a new board lane.

Why: today a ticket goes straight to `done` once tests are green. Nothing checks that the tests meaningfully cover the code or that security concerns were handled, and nothing captures follow-up work discovered during review. A dedicated reviewer role closes that gap and feeds discovered issues back into the board as actionable tickets.

Design decisions (assumptions — user may veto via `## Additional Context`):
1. **No new status enum value.** The review is a step between Phase 3 passing and the orchestrator setting `done`.
2. **The reviewer is read-only** (`tools: Read, Grep, Glob`), like the BA. It reviews and reports; the orchestrator (which owns all ticket status/frontmatter and file writes) creates the follow-up `todo` tickets. The reviewer never edits the reviewed ticket's status/frontmatter.
3. **The reviewed ticket still reaches `done`** (its own criteria/tests passed); newly-found issues become separate follow-up fix tickets (`status: todo`).
4. **Agent filename** follows the existing short convention: `tech-lead.md`, frontmatter `name: orchestrate-tech-lead`.
5. **Registered in `lib/orchestrate-agents.js`** (`AGENT_TYPES.techLead` + `AGENT_NAMES`) so fallback resolution treats it as first-class; this requires the tester to update the hard-coded expectations in `test/orchestrate-agents.test.js`.

## Acceptance Criteria
- [ ] A new reviewer agent definition file exists at `.claude/agents/tech-lead.md` **and** at `assets/agents/tech-lead.md`.
- [ ] The two copies of the agent file are **byte-for-byte identical**.
- [ ] The agent file has valid flat-YAML frontmatter with `name: orchestrate-tech-lead`, a non-empty `description`, and a non-empty `tools` line.
- [ ] The agent's `tools` are read/search only — includes `Read`, `Grep`, `Glob` and does **NOT** include `Edit`, `Write`, or `Bash`.
- [ ] The persona body states the review runs **after a ticket passes testing** and **before it is marked `done`**.
- [ ] The persona instructs a **thorough** review of **both** the ticket **and** the implementation code.
- [ ] The persona instructs verifying that the **tests actually cover the implemented code** (not just that tests exist/pass).
- [ ] The persona instructs verifying that **security concerns are addressed**.
- [ ] The persona states issues found are turned into **new follow-up fix tickets** with `status: todo` (one per issue), continuing the `TASK-nnn` sequence, and that the reviewer **never edits the reviewed ticket's status/frontmatter**.
- [ ] Both SKILL.md copies (`.claude/skills/orchestrate/SKILL.md` and `assets/skills/orchestrate/SKILL.md`) document a **tech-lead review step** positioned **after Phase 3 testing passes and before the ticket is set to `done`** (an explicit `testing → tech-lead review → done` ordering).
- [ ] Both SKILL.md copies document dispatching the review to the `orchestrate-tech-lead` agent via the **Task tool**, with the same "fall back to `general-purpose` and report it" wording used by the other phases.
- [ ] Both SKILL.md copies document that when the review finds issues, **follow-up fix tickets are created with `status: todo`, continuing the max `TASK-nnn` sequence**, and that the review step does **not** change the reviewed ticket's status/frontmatter.
- [ ] The **six-status enum is unchanged** (`todo, defining, in-progress, testing, failed-testing, done`) — no new status value anywhere (SKILL.md, `lib/ticket-lanes.js`, `lib/ticket-folders.js`).
- [ ] The two SKILL.md copies remain **byte-for-byte identical** (drift guard).
- [ ] `lib/orchestrate-agents.js` registers the new agent: `AGENT_TYPES` gains `techLead: 'orchestrate-tech-lead'` and `AGENT_NAMES` includes `'orchestrate-tech-lead'` (ordered plan → build → test → review); both remain frozen, and `resolveAgentType`/`isFallback` return correct results for the new name.
- [ ] `tasks:installSkill` still requires no change: because it `readdir`-loops `assets/agents/*`, the new `tech-lead.md` propagates automatically (verify; do not hand-list files in `main.js`).
- [ ] The full `node --test` suite passes green, including updated guards in `test/orchestrate-agents.test.js` covering the fourth agent's existence, frontmatter, tool scoping, and byte-identity (test updates are the tester's deliverable).

## Cucumber Tests
```gherkin
Feature: Tech-lead reviewer agent for the orchestrate workflow

  Scenario: The tech-lead agent definition exists in both locations
    When I look for the reviewer definition
    Then a file tech-lead.md exists in .claude/agents
    And a file tech-lead.md exists in assets/agents

  Scenario: The two tech-lead agent copies are byte-identical
    Given .claude/agents/tech-lead.md and assets/agents/tech-lead.md
    When I compare their raw bytes
    Then the two files are byte-for-byte identical

  Scenario: The tech-lead agent has valid, correctly scoped frontmatter
    Given the file assets/agents/tech-lead.md
    When I parse its frontmatter
    Then name is "orchestrate-tech-lead"
    And description is non-empty
    And tools includes Read, Grep and Glob
    And tools does NOT include Edit, Write or Bash

  Scenario: The persona describes a thorough post-testing review
    Given the tech-lead agent persona body
    Then it says the review runs after a ticket passes testing and before it is done
    And it requires reviewing both the ticket and the implementation code
    And it requires verifying that tests actually cover the code
    And it requires verifying that security concerns are addressed

  Scenario: The persona routes discovered issues to new follow-up tickets
    Given the tech-lead agent persona body
    Then the body states a new follow-up fix ticket is created with status todo
    And the body states the new id continues the TASK-nnn sequence
    And the body states the reviewer never edits the reviewed ticket's status or frontmatter

  Scenario: SKILL.md places the review between testing and done
    Given both copies of SKILL.md
    Then each copy documents a tech-lead review step after testing passes and before done
    And each copy shows the ordering testing -> tech-lead review -> done

  Scenario: SKILL.md dispatches the review to the dedicated agent with fallback
    Given both copies of SKILL.md
    Then each copy launches the orchestrate-tech-lead agent via the Task tool
    And each copy keeps the "fall back to general-purpose and report it" wording

  Scenario: SKILL.md documents follow-up ticket creation on review findings
    Given both copies of SKILL.md
    Then each copy states follow-up fix tickets are created with status todo
    And each copy states the new ids continue the max TASK-nnn sequence
    And each copy states the review step does not change the reviewed ticket's status/frontmatter

  Scenario: The status enum is unchanged
    Given SKILL.md, lib/ticket-lanes.js and lib/ticket-folders.js
    Then the allowed statuses are exactly todo, defining, in-progress, testing, failed-testing, done
    And no new status value has been introduced for review

  Scenario: The reviewer is registered in the agent-type library
    Given lib/orchestrate-agents.js
    Then AGENT_TYPES.techLead equals "orchestrate-tech-lead"
    And AGENT_NAMES includes "orchestrate-tech-lead" after the tester
    And both objects remain frozen
    And resolveAgentType("orchestrate-tech-lead", ["orchestrate-tech-lead"]) returns it unchanged

  Scenario: Installing into a fresh project propagates the reviewer
    Given a fresh project with no .claude directory
    When the orchestrate skill is installed (assets/agents/* copied into .claude/agents)
    Then that project has .claude/agents/tech-lead.md byte-identical to assets/agents/tech-lead.md

  Scenario (edge): the two tech-lead copies drift
    Given .claude/agents/tech-lead.md is edited but assets/agents/tech-lead.md is not
    When the drift guard compares the two files
    Then the test fails because the copies are no longer byte-identical

  Scenario (failure): review finds a security issue
    Given a ticket has passed testing
    When the tech-lead review finds an unaddressed security concern
    Then a new fix ticket with status todo is created describing the issue
    And its id continues the sequence (e.g. TASK-020 when the current max is TASK-019)
    And the reviewed ticket's own status/frontmatter is not modified by the reviewer

  Scenario (edge): a missing tech-lead definition falls back to general-purpose
    Given a project whose .claude/agents is missing tech-lead.md
    When the review step resolves its agent type
    Then resolveAgentType("orchestrate-tech-lead", availableWithoutIt) returns "general-purpose"
    And isFallback reports true so the orchestrator can report the missing agent

  Scenario (edge): follow-up id must not reuse or gap the sequence
    Given the highest existing ticket id across all status subfolders is TASK-019
    When the review creates two follow-up fix tickets
    Then their ids are TASK-020 and TASK-021
    And neither reuses an existing id nor skips ahead of the true maximum
```

## Edge / failure cases the coder must handle
- **Byte-for-byte drift:** any edit to `.claude/agents/tech-lead.md` or either `SKILL.md` must be copied byte-for-byte to its `assets/` counterpart in the same change, or the drift-guard tests fail.
- **No new status:** do not add a status value to the enum in SKILL.md, `lib/ticket-lanes.js`, or `lib/ticket-folders.js`.
- **Reviewer must not mutate status/frontmatter:** the reviewer is read-only; only the orchestrator writes ticket files and status.
- **Follow-up id sequencing:** new fix tickets continue from the true maximum `TASK-nnn` found across the status subfolders (`tasks/*/TASK-*.md`), not just top-level `tasks/*.md` — current max is `TASK-019`, so next is `TASK-020`.
- **Existing hard-coded tests:** `test/orchestrate-agents.test.js` currently asserts exactly three agents (`AGENT_FILES`, `EXPECTED`, `assert.deepEqual(AGENT_NAMES, [...three])`). Registering the fourth agent WILL turn these red until updated — the tester extends them to the four-agent set and adds the new file's byte-identity/frontmatter guards.
- **Fallback wording:** the new review step's dispatch must carry the same "`orchestrate-tech-lead`; fall back to `general-purpose` and report it" phrasing as the other phases.
- **`main.js` must not regress:** the install handler copies the whole `assets/agents/` directory via `readdir`; do not convert it to a hard-coded file list.

## Relevant files and context
New files to create (byte-identical pair; model frontmatter shape and persona style on `.claude/agents/ba.md` and `.claude/agents/tester.md`):
- `.claude/agents/tech-lead.md`
- `assets/agents/tech-lead.md`

Files to edit (keep the two copies byte-identical):
- `.claude/skills/orchestrate/SKILL.md`
- `assets/skills/orchestrate/SKILL.md`
  - Relevant sections: the "Agent dispatch and fallback" block and "Phase 3 — Test (tester) and the fix loop". Add the review step after Phase 3 and before `done`; reuse the existing Task-tool + fallback phrasing.
  - NOTE: TASK-017 just reworked the Phase 2 / concurrency sections of these same files as a "swarm". Do not remove or contradict that swarm text — add the tech-lead review step around Phase 3 without disturbing the concurrency content.

Wiring:
- `lib/orchestrate-agents.js` — `AGENT_TYPES` and `AGENT_NAMES`. Add `techLead: 'orchestrate-tech-lead'` and append the name after the tester; keep both frozen.

Tests (tester's responsibility; understand before building):
- `test/orchestrate-agents.test.js` — hard-coded three-agent expectations to extend: `AGENT_FILES`, the `EXPECTED` map, the `AGENT_NAMES` deep-equal, the byte-identity loop, and the install-propagation cases.
- `test/orchestrate-testing-step.test.js` — precedent for instruction-file doc tests (UNIT + E2E-cucumber `node --test`, reading markdown and asserting phrases). Mirror this style.

Must-not-touch / invariants:
- `lib/ticket-lanes.js` and `lib/ticket-folders.js` — the six-status enum and folder-per-status layout; do not add a status.
- `main.js` `tasks:installSkill` handler — copies whole `assets/agents/`; no change needed.
- Byte-for-byte rule (project memory `assets-drift-guard`): every `.claude/agents/*.md` and `.claude/skills/orchestrate/SKILL.md` edit must be mirrored byte-for-byte into `assets/`, then run `node --test`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
