---
id: TASK-066
title: BA Planner
status: done
created: 2026-07-19T09:04:40.212Z
updated: 2026-07-20T00:30:00Z
---

## Description
Hey orchistrating planning, use the BA agent, but ensure it gathers as much context as possible. If anything is unclear than ask the question, make sure all questions are answered before completing planning

This is a **change to the orchestrate SKILL/PROCESS instruction files, not to app code**. Today, "Phase 1 — Plan / Define" in `.claude/skills/orchestrate/SKILL.md` and the BA persona in `.claude/agents/ba.md` require thorough context gathering, but neither requires the BA to **surface clarifying questions** when the request is ambiguous, nor blocks planning completion on those questions being **answered**. The BA is therefore free to guess.

Required instruction edits:
1. **`.claude/agents/ba.md`** — add a "Clarifying questions" section: while analyzing, the BA must enumerate anything genuinely unclear/ambiguous in the request (never silently guess); it must report those questions back to the orchestrator (with the affected ticket id(s)) alongside the defined tickets; it still never writes files itself.
2. **`.claude/skills/orchestrate/SKILL.md`, Phase 1** — extend the Plan/Define phase:
   - The BA gathers as much context as possible (strengthen existing wording) AND returns any clarifying questions it raised.
   - The **orchestrator** must put every question to the **user** — via the AskUserQuestion tool when available, otherwise by writing the question onto the affected ticket's `question` frontmatter field (the existing TASK-005 mechanism in `lib/ticket-questions.js`, which turns the board dot yellow) and waiting for the `answer` field.
   - **Planning is not complete until every raised question has a non-empty answer**: the Phase-1 STOP message ("Tickets created. Review and enrich them…") must not be issued, and no ticket may leave `defining`/land ready for build, while any question is unanswered.
   - Answers are folded into the affected ticket's body (e.g. a `## Clarifications` section of Q/A pairs) so the coder sees the decision — **never** written into the user-owned `## Additional Context`.
3. **Sync the bundled copies byte-for-byte**: `assets/skills/orchestrate/SKILL.md` and `assets/agents/ba.md` must be updated identically to their `.claude/` counterparts. Drift guards fail otherwise: `test/orchestrate-agents.test.js:354` ("the two SKILL.md copies are byte-identical"), `:294` ("each bundled agent file is byte-identical to its project copy"), `:519` ("Project and bundled skills stay in sync"), and `test/task-051-planning-model.test.js:122/:188` (Buffer.equals on SKILL.md and ba.md).
4. **New wording tests** (e.g. `test/task-066-ba-clarifying-questions.test.js`, modeled on `test/task-051-planning-model.test.js`): assert both SKILL.md copies and both ba.md copies contain the clarifying-questions requirement, the answered-before-completion rule, and the Additional-Context prohibition; plus a byte-identity assertion for each pair and an in-memory edge case (mutated copy detected as drift; wording-removed copy fails the presence check).

CONSTRAINT — do not break existing assertions on these same files: `test/task-051-planning-model.test.js` pins exact Phase-1 sentences (`Dispatch this planning subagent on \`claude-fable-5\` when\s+available, otherwise fall back to \`claude-opus-4-8\``, `dispatched on \`claude-fable-5\` when available,\s+otherwise \`claude-opus-4-8\``, "applies to Phase 1 planning only", model ids only before "## Phase 2 — Build"), ba.md frontmatter (`name: orchestrate-ba`, `tools: Read, Grep, Glob`, `model: claude-fable-5`); `test/orchestrate-agents.test.js` pins agent names/tool scoping and the general-purpose fallback wording; `test/orchestrate-tech-lead.test.js` and `test/orchestrate-swarm.test.js` pin Phase 2-4 phrases. Additions must not introduce either model id after the "## Phase 2 — Build" heading.

## Acceptance Criteria
- [ ] `.claude/agents/ba.md` contains a clarifying-questions requirement: the BA must enumerate unclear/ambiguous points instead of guessing and report the questions (with affected ticket ids) back to the orchestrator; frontmatter (`name`, `description`, `tools: Read, Grep, Glob`, `model: claude-fable-5`) is unchanged.
- [ ] `.claude/skills/orchestrate/SKILL.md` Phase 1 requires the BA to gather maximal context AND return clarifying questions for anything unclear.
- [ ] `.claude/skills/orchestrate/SKILL.md` Phase 1 requires the orchestrator to ask the user every raised question (AskUserQuestion when available, otherwise the ticket `question`/`answer` frontmatter mechanism from TASK-005 / `lib/ticket-questions.js`).
- [ ] `.claude/skills/orchestrate/SKILL.md` Phase 1 states planning is not complete — the STOP message is not issued and tickets do not leave defining — until every question has a non-empty answer.
- [ ] SKILL.md states answers are captured in the ticket body (e.g. a `## Clarifications` section) and never written into `## Additional Context`.
- [ ] `assets/skills/orchestrate/SKILL.md` is byte-identical to `.claude/skills/orchestrate/SKILL.md`, and `assets/agents/ba.md` is byte-identical to `.claude/agents/ba.md`.
- [ ] A new `node --test` file asserts the new wording is present in all four files (both copies of both files) and includes at least one in-memory failure/edge case (single-byte drift detected; wording removed fails the presence check) without touching the real files.
- [ ] The entire existing suite stays green — specifically `test/orchestrate-agents.test.js`, `test/task-051-planning-model.test.js`, `test/orchestrate-tech-lead.test.js`, `test/orchestrate-swarm.test.js` — proving the pinned Phase-1 model sentences, agent frontmatter, fallback wording, and Phase-1-only model scoping were not disturbed.
- [ ] No app source files (`renderer/`, `lib/`, `main.js`) are modified by this ticket.

## Cucumber Tests
```gherkin
Feature: Orchestrate planning gathers context and blocks on unanswered clarifying questions

  Scenario: ba.md instructs the BA to raise questions instead of guessing
    Given the file .claude/agents/ba.md and its assets/agents/ba.md copy
    When I read each file
    Then each contains the clarifying-questions requirement
    And each keeps name orchestrate-ba, tools Read, Grep, Glob and model claude-fable-5

  Scenario: SKILL.md Phase 1 requires questions to be asked and answered before planning completes
    Given both copies of the orchestrate SKILL.md
    When I read the Phase 1 — Plan / Define section
    Then it requires the BA to return clarifying questions for anything unclear
    And it requires the orchestrator to ask the user each question
    And it states planning does not complete until every question has a non-empty answer

  Scenario: Answers never land in the user-owned section
    Given both copies of SKILL.md
    Then each states answers are recorded in the ticket body and never in "## Additional Context"

  Scenario: Bundled and project copies stay in sync (drift guard)
    Given assets/skills/orchestrate/SKILL.md and .claude/skills/orchestrate/SKILL.md
    And assets/agents/ba.md and .claude/agents/ba.md
    When I compare each pair's raw bytes
    Then each pair is byte-for-byte identical

  Scenario: A drifted copy is caught (edge/failure, in-memory only)
    Given an in-memory copy of assets SKILL.md with one byte flipped
    When I compare it against the project copy
    Then the comparison fails
    And the real files on disk remain identical

  Scenario: Removing the new wording is caught (edge/failure, in-memory only)
    Given an in-memory copy of SKILL.md with the clarifying-questions sentence removed
    When the presence check runs
    Then it fails

  Scenario: Existing Phase-1 model directives survive the edit
    Given both copies of SKILL.md after the change
    Then the exact sentence dispatching planning on claude-fable-5 with the claude-opus-4-8 fallback is unchanged
    And neither model id appears after the "## Phase 2 — Build" heading
```

## Edge Cases & Failure Paths
- Byte-identity is asserted with `Buffer.equals` — line endings matter. The repo files use LF; the coder must not let a Windows editor rewrite either copy to CRLF or update one copy and not the other.
- Every pinned regex in `test/task-051-planning-model.test.js` (including line-wrap-sensitive `\s+` patterns) must still match — insert new prose as new sentences/bullets, do not reflow the existing model-directive sentences.
- Do not add `claude-fable-5`/`claude-opus-4-8` mentions in or after Phase 2/3/4 sections (task-051 scoping tests) and avoid the typo forms `claude-fabel-5` / `claude-opus-4.8`.
- ba.md frontmatter must keep parsing with the tests' minimal flat-YAML parser — add prose to the body only, never new frontmatter keys.
- The AskUserQuestion tool may be unavailable in a given run — SKILL.md must name the on-ticket `question`/`answer` fallback so planning can still block-and-wait.
- An unanswered question must not deadlock silently: the instruction should have the orchestrator surface which ticket(s) are waiting (the board already shows the yellow waiting dot via `isTicketWaitingForAnswer`).
- The user answering with an empty string does not count as answered (mirrors `isWaitingForAnswer`'s non-empty rule in `lib/ticket-questions.js`).
- MEMORY note (`assets-drift-guard`): editing `.claude/` instruction files without syncing `assets/` fails tests — this is the exact trap this ticket must avoid.

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md` — Phase 1 section (lines ~134-181: BA thoroughness, step list, STOP message) — primary edit target.
- `.claude/agents/ba.md` — BA persona (frontmatter lines 1-10 must stay untouched; body sections "Thorough analysis", "What each ticket must contain", "Hard rules") — add the clarifying-questions section.
- `assets/skills/orchestrate/SKILL.md`, `assets/agents/ba.md` — canonical bundled copies; must be updated byte-identically.
- `test/orchestrate-agents.test.js` — drift guards (lines 294, 354, 519), agent tool-scoping table (`EXPECTED`, line 68), fallback-wording assertions, `parseAgentFrontmatter` helper worth copying for the new test.
- `test/task-051-planning-model.test.js` — the closest template for the new test file: reads all four files, regex presence checks, Buffer.equals byte-identity, in-memory mutation edge cases; also the source of the pinned sentences that must not break.
- `test/orchestrate-tech-lead.test.js`, `test/orchestrate-swarm.test.js` — other SKILL.md wording pins to keep green.
- `lib/ticket-questions.js` + renderer mirror `isTicketWaitingForAnswer` (renderer/renderer.js:5203) — the existing TASK-005 question/answer mechanism the skill text should reference as the fallback ask-the-user channel.
- New test file: `test/task-066-ba-clarifying-questions.test.js` (runner: `node --test`; no DB/network/Electron — pure file reads plus in-memory mutation).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
