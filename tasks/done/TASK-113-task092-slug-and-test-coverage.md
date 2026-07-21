---
id: TASK-113
title: TASK-092 review: reject degenerate agent-name slugs + serializer test coverage
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:11:27.955Z
review-of: TASK-092
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:50:00Z","finishedAt":"2026-07-21T03:00:11Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:52:00Z","finishedAt":"2026-07-21T03:07:57Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T02:56:00Z","finishedAt":"2026-07-21T03:11:27Z"}]
---

## Description
Review follow-ups for TASK-092 (`lib/agent-files.js`), severity **minor**. This is a review follow-up of TASK-092. Scope: `validateAgentName` hardening + serializer test coverage + a minimal `formatKey` paragraph-separator fix (see F5). TASK-108 already added the scalar-injection guard to `serializeAgentFile`/`formatKey` — that guard must NOT be duplicated or modified.

- **F2 — degenerate slugs accepted.** `NAME_RE` (`/^[a-z0-9-]+$/`) lets `validateAgentName` accept `-`, `--`, `---`, `-foo`, `foo-`, all-hyphen. Reject leading/trailing/all-hyphen to reach parity with the renderer mirror `validateAgentNameRenderer` (which already rejects them). `orchestrate-docs` (interior hyphens) stays valid.
- **F3 — tautological assertion.** `test/task-092-agent-files.test.js:62` asserts `Object.getOwnPropertySymbols(fm).length >= 0` (always true). Replace with a meaningful check: parsed `fm` has exactly one own Symbol (the RAW carrier), it is non-enumerable, and a spread copy `{...fm}` has zero own symbols.
- **F4 — missing single-field-edit tests.** No test edits ONLY `description` (or ONLY `model`) proving the edited key is fresh-formatted while siblings re-emit RAW byte-for-byte.
- **F5 — multi-paragraph folded blocks untested + a real bug.** `formatKey`'s fresh-fold emits NO blank separator line between non-empty paragraphs, so editing a description to `"A\nB"` fresh-serializes to a block that re-parses as `"A B"` (paragraph break lost). SCOPE DECISION (orchestrator): fix it — emit one blank separator line per `\n` in the value so fresh-fold round-trips paragraph breaks. Also add the unchanged (RAW) multi-paragraph byte-identical round-trip test. The fix must NOT change the byte-identical RAW round-trip or the TASK-108 guard.

Out of scope (do not fix): duplicate-frontmatter-key collapse on parse; the TASK-108 guard itself.

## Acceptance Criteria
- [ ] `validateAgentName` rejects `-`, `--`, `---`, `-foo`, `foo-` (leading/trailing/all-hyphen) with `{valid:false, error:<clear lowercase message, no trailing period>}` (e.g. "name may not start or end with a hyphen").
- [ ] `validateAgentName('orchestrate-docs', ['orchestrate-ba'])` still `{valid:true, error:null}`; interior hyphens + single-char `a`/`7` + `a-b-c` unaffected.
- [ ] All pre-existing rejections still hold (non-string/empty/illegal chars/reserved `general-purpose`/duplicate from array or Set); never throws; always returns `{valid,error}`. New hyphen guard runs AFTER the NAME_RE char-class check, BEFORE reserved/duplicate (renderer ordering).
- [ ] `test/task-092-agent-files.test.js:62` tautology replaced with: exactly one own Symbol on `fm`, non-enumerable, and `Object.getOwnPropertySymbols({...fm}).length === 0`.
- [ ] New unit test: edit ONLY `fm.description`, serialize → output re-parses with the new description AND the sibling `name:`/`tools:`/`model:` RAW lines + body appear BYTE-EQUAL in the output.
- [ ] New unit test: edit ONLY `fm.model` (fixture with a multi-line folded description) → output equals the original with only the model line replaced; the folded description RAW block emitted verbatim.
- [ ] New test: a `description: >-` block with a blank line (two paragraphs) parses to a value containing `\n`, and the UNCHANGED round-trip is byte-identical.
- [ ] New test + fix: after editing `fm.description` to a two-paragraph value (with `\n`), serialize→re-parse yields the SAME string with the paragraph break preserved; long paragraphs re-wrap at 74-char width with 2-space indent. (Minimal `formatKey` paragraph-separator fix.)
- [ ] All existing task-092 tests still pass incl. the byte-identical round-trip over every bundled agent in LF and CRLF; TASK-108's guard (FRESH_KEY_RE, char-code scan, `---` prefix) untouched; `parseAgentFile` unchanged; renderer.js NOT edited.

## Cucumber Tests
```gherkin
Feature: TASK-092 review follow-ups — degenerate slug rejection + serializer coverage
  Scenario: Degenerate slugs are rejected (failure)
    Given existing agent names are empty
    When validateAgentName is called with "-", "--", "---", "-foo", "foo-"
    Then each returns valid=false with a clear leading/trailing-hyphen error and no throw
  Scenario: Well-formed hyphenated names still accepted
    When validateAgentName gets "orchestrate-docs" with existing ["orchestrate-ba"]
    Then valid=true, error null
  Scenario: Existing rejections unchanged
    When validateAgentName gets "", null, "Bad Name!", "general-purpose", and a duplicate
    Then every call is valid=false with a non-empty error
  Scenario: RAW Symbol present but hidden
    Given a parsed agent file fm
    Then fm has exactly one own Symbol, it is non-enumerable, and a spread copy has zero own symbols
  Scenario: Editing only the description re-folds it while siblings stay raw
    Given a parsed agent file with name/description/tools/model
    When only fm.description changes and the file is serialized
    Then the output re-parses with the new description and the name/tools/model lines + body are byte-identical
  Scenario: Editing only the model replaces one line
    Given a parsed agent file with a multi-line folded description
    When only fm.model changes and the file is serialized
    Then the output equals the original with only the model line replaced
  Scenario: Multi-paragraph folded description round-trips (RAW)
    Given an agent file whose description block has a blank line between two paragraphs
    When it is parsed then serialized unchanged
    Then fm.description contains a newline at the break and the output is byte-identical to the input
  Scenario: Fresh re-wrap preserves paragraph breaks
    Given a parsed agent file
    When fm.description is set to a two-paragraph value containing a newline and serialized then re-parsed
    Then the re-parsed description equals the two-paragraph value exactly (paragraphs not collapsed)
```

## Edge Cases & Failure Paths
- `-` is simultaneously all/leading/trailing hyphen — one guard covers it, return one clear error. `---` also collides with the fence visually — all-hyphen rejection closes it. Hyphen guard after NAME_RE, before reserved/dup. Don't regress `a-b-c`/`a`/`7`. F4 asserts BYTE-equality of sibling RAW lines (re-parse equality alone can't distinguish fresh vs raw). F4 model-edit fixture uses a multi-line folded description. F5 unchanged round-trip goes through the RAW path (no mutation). F5 fresh covers a short two-paragraph value AND one long enough to force 74-char wrapping. The formatKey fix must emit one blank line per `\n` and must NOT change the RAW round-trip or the TASK-108 guard. CRLF: don't hard-code LF in whole-file comparisons (use the e2e withEol/readAgent pattern). renderer.js NOT edited.

## Relevant Files & Context
- `lib/agent-files.js`: `NAME_RE` (~70); `validateAgentName` (~354-380, add hyphen guard); `formatKey` (~138-183, folded description emission — the paragraph off-by-one is here; the TASK-108 guard lines ~167-181 DO NOT TOUCH); `resolveBlockScalar` (~88-121, parse-side folding — blank line → `\n`); RAW Symbol (~48) + `Object.defineProperty(enumerable:false)` (~259-264, what F3 verifies); `serializeAgentFile` (~281-346, RAW re-emit vs fresh fallback — the F4 mechanism).
- `test/task-092-agent-files.test.js`: tautology line 62; SIMPLE fixture (24-36) is single-paragraph — add a multi-paragraph fixture; validateAgentName tests (170-195) to extend; name-edit test (197) is the F4 pattern (add byte-level sibling assertions).
- `test/task-092-agent-files.e2e.test.js`: 'Invalid names rejected' (~92) extend with degenerate slugs; withEol/readAgent helpers for EOL variants.
- `renderer/renderer.js` (~7736, 7751-7774): `AGENT_NAME_SLUG_RE` + `validateAgentNameRenderer` — the already-shipped parity target. READ ONLY.
- `lib/orchestrate-agents.js`: `FALLBACK_AGENT`. `.claude/agents/*.md`: round-trip fixtures. Run `node --test test/task-092-agent-files.test.js test/task-092-agent-files.e2e.test.js`. 2 known-baseline failures unrelated.

## Impact If Not Fixed
Degenerate names create hard-to-see/hard-to-delete agent files; the untested serializer branches (edited description re-serialize, multi-paragraph folding) could regress undetected when the Team edit flows mutate parsed fm, silently corrupting agent frontmatter (multi-paragraph descriptions already collapse on a fresh re-fold).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
