---
id: TASK-115
title: TASK-096 review: harden skill-workflow tests against benign SKILL.md edits
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:07:14.862Z
review-of: TASK-096
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:50:00Z","finishedAt":"2026-07-21T02:59:24Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:52:00Z","finishedAt":"2026-07-21T03:04:04Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T02:54:00Z","finishedAt":"2026-07-21T03:07:14Z"}]
---

## Description
Review follow-ups for TASK-096 (skill-workflow lib). TEST-HARDENING ONLY — `lib/skill-workflow.js` and all production code must NOT change; edits confined to `test/task-096-skill-workflow.test.js` and `.e2e.test.js`.
- **F1** exact line-number brittleness: the unit test asserts the bundled SKILL.md phase headings sit at lines 134/194/337/379 — any benign edit above them breaks it. Drop the four exact-line equalities; strengthen the structural check (already present as `assert.match(lines[p.headingLine-1], /^##\s+Phase\s+\d/)`): for each phase, `headingLine` is an integer >=1, the line at `headingLine-1` matches `^##\s+Phase\s+<n>\b` where `<n>` is that phase's canonical PHASE_SPECS number, and the four headingLines are distinct.
- **F2** silent-no-op fixtures + exact warning prose: missing-phase fixtures build via literal `.replace()` of full heading text; if wording drifts the replace silently no-ops and the failure looks like a parser regression. Assert each replacement actually changed the string (assert.notEqual, or a helper that throws when the pattern isn't found), guarding each replacement individually in the multi-removal fixture. Loosen the unit test's exact warning-prose regexes to substring/shape (name the phase number + label), matching the e2e file's existing style.
- **F3** missing fence-suppression proof: no test puts a `## Phase N`-shaped heading INSIDE a fence. Add a fixture with all four real headings + a ```-fenced block containing a `## Phase 2 — ...`-shaped line; assert 4 phases/no warnings and no phase headingLine equals the fenced line. Also prove the negative: a fixture whose ONLY `## Phase 2` is inside a fence yields a missing-Phase-2 warning.

Severity from review: **minor**. This is a review follow-up of TASK-096.

## Acceptance Criteria
- [ ] `lib/skill-workflow.js` (and renderer.js) byte-unchanged — test-only.
- [ ] The bundled-SKILL headingLine test no longer asserts literal 134/194/337/379; instead asserts per-phase: headingLine int >=1, line at headingLine-1 matches `^##\s+Phase\s+<n>\b` with `<n>` = canonical PHASE_SPECS number, four headingLines distinct.
- [ ] Inline-fixture headingLine assertions (reordered-headings 1/3/5/7) left as-is — only bundled-SKILL exact-line assertions removed.
- [ ] Every missing-phase fixture that mutates the bundled source asserts the mutation changed the content (notEqual / helper that fails loudly), each replacement guarded individually in the multi-removal fixture.
- [ ] Unit-test warning assertions no longer pin the exact sentence — assert by substring/shape (names the phase number e.g. `/Phase 3/` and label e.g. `/test/i`).
- [ ] A new fence-suppression test: fixture with four real `## Phase <n>` headings + a fenced block enclosing a `## Phase 2 — ...`-shaped line → exactly 4 phases, no warnings, build phase headingLine = the real unfenced Phase 2 line, no phase headingLine = the fenced line.
- [ ] Negative direction: a fixture whose only Phase-2 heading is inside a fence → build phase omitted + a missing-Phase-2 warning.
- [ ] All existing TASK-096 test names/scenarios remain present and meaningful; `node --test test/task-096-skill-workflow.test.js test/task-096-skill-workflow.e2e.test.js` reports 0 new failures. No new deps.

## Cucumber Tests
```gherkin
Feature: TASK-096 skill-workflow test hardening
  Scenario: headingLine verified structurally, not by exact line number
    Given the bundled SKILL.md
    When parseWorkflow parses it
    Then each phase's headingLine points at a "## Phase <n>" heading whose n equals its canonical number
    And the four headingLine values are distinct positive integers
    And no test asserts the literal line numbers 134/194/337/379
  Scenario: missing-phase fixture guards against a silent no-op replace
    Given the bundled SKILL.md source
    When the test removes the Phase 3 heading to build its fixture
    Then the test first asserts the fixture differs from the original
    And parseWorkflow returns plan/build/review with one warning matched by substring "Phase 3" and "test"
  Scenario: fenced phase-shaped heading is not counted (edge)
    Given a fixture with four real "## Phase <n>" headings and a fenced block containing "## Phase 2 — Example"
    When parseWorkflow parses it
    Then exactly four phases return with no warnings
    And the build phase headingLine is the real unfenced Phase 2 line
    And no phase headingLine equals the fenced line's number
  Scenario: a phase heading only inside a fence is treated as missing (failure)
    Given a fixture whose only "## Phase 2" heading is inside a fence
    When parseWorkflow parses it
    Then the build phase is omitted and a warning names Phase 2 and "build"
  Scenario: benign prose edit above Phase 1 does not fail the suite (edge)
    Given a copy of SKILL.md with an extra line inserted above the Phase 1 heading
    When parseWorkflow parses the copy
    Then the structural headingLine assertions still pass
```

## Edge Cases & Failure Paths
- Silent `.replace` no-op (wording drift) → explicit fixture failure, not a parser-looking one. Multi-replace partial no-op → guard each replacement. Fenced phase heading counted → new test fails in that world. Fences must be well-formed ``` pairs (sectionsOf closes on matching marker). Warning substring must survive benign rewording but fail if the phase number/label disappears. CRLF: split on `/\r?\n/` when computing fenced line number. First-heading-wins: place the fenced fake deliberately and assert accordingly.

## Relevant Files & Context
- `test/task-096-skill-workflow.test.js` — exact-line assertions ~85-89; unguarded `.replace` fixtures ~156-159 and ~169-172; exact warning regexes ~163/176/177; structural pattern to keep ~91-94; inline-fixture assertions ~199-203 stay.
- `test/task-096-skill-workflow.e2e.test.js` — unguarded `.replace` ~101-105 (add no-op guard); warning assertions ~113-117 already substring-based (style to copy); optionally add the fence scenario here.
- `lib/skill-workflow.js` — READ ONLY: `sectionsOf` fence handling ~102-133 (fence regex ~114), missing-phase warning text ~171, first-heading-wins ~153-158.
- `.claude/skills/orchestrate/SKILL.md` — bundled doc (headings currently 134/194/337/379); do not edit.
- NOTE (out of scope): the same brittle warning-prose pattern exists in `test/task-105-workflow-panel.*` and `renderer/renderer.js:6740` — NOT touched by this ticket.
- Plain `node --test` + `node:assert/strict`, no cucumber, no new deps; read SKILL.md read-only.

## Impact If Not Fixed
Routine, correct edits to SKILL.md (which the Workflow panel consumes) would produce false test failures that look like parser regressions, eroding the suite's signal; a real fence-tracking regression could leak a fenced example heading into the parsed model undetected.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
