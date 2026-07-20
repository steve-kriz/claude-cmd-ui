---
id: TASK-070
title: ticket cost
status: done
created: 2026-07-19T09:16:21.592Z
updated: 2026-07-20T00:30:00Z
---

## Description
Make sure all tickets collect start time, processing time, tokens up and down and model used and a complete used view of the cost of this ticket being processed, break it down by BA code, test, reviewing and what ever other activity is being down on the ticket. All tickets maust have this stored in the MD file

Add a **per-activity cost/accounting log** to each ticket, stored in the ticket's MD file, broken down by activity (`ba`, `code`, `test`, `review`, `post-processing`, plus any future activity string), each entry carrying: start time, processing time, tokens in (up), tokens out (down), model used, and optional cost — plus derivable totals. Surface it in the ticket modal as the "complete cost view".

**Feasibility (must be understood by the builder):** tickets are processed by the ORCHESTRATOR — an LLM following `.claude/skills/orchestrate/SKILL.md` — which dispatches BA/coder/tester/reviewer subagents via the Task tool. There is no app-side instrumentation of those subagents, so the data can only be **recorded by the orchestrator writing it into the ticket MD** after each dispatch, exactly like the existing `startedAt/finishedAt/tokens/costUsd` (TASK-003, `lib/ticket-accounting.js`) and `runs` log (TASK-012, `lib/ticket-runs.js`). Consequently: wall-clock timings are accurate; the **model** is exactly known for Phase 1 (the TASK-051 directive: `claude-fable-5`, fallback `claude-opus-4-8`) and is the session/dispatch model otherwise; **token counts are whatever the Task tool result reports and may be unavailable — approximate, and NEVER fabricated** (omit the field, following `isValidAmount` semantics); `costUsd` is optional (no pricing table exists in this repo) and recorded only when the orchestrator can supply a valid number. The app displays what is present and shows nothing otherwise.

**Storage schema (round-trip-safe with the flat frontmatter contract):** one new flat frontmatter key, `activities`, holding a **one-line JSON array** — the exact pattern proven by `runs` (`lib/ticket-runs.js`): `parseTicketFrontmatter` (renderer.js ~5170) takes everything after the first `:` as an opaque string, `serializeTicket` (renderer.js:5312) writes it back verbatim after the five leading keys, and `frontmatterValueLine` (5303) is a no-op because `JSON.stringify` emits no newlines. Do NOT use nested YAML and do NOT store the log in a body section (body sections risk heading-injection and duplicate-source-of-truth problems; frontmatter JSON already round-trips). Entry shape:

`{ "activity": "ba"|"code"|"test"|"review"|"post-processing"|<string>, "model": <string?>, "startedAt": <ISO?>, "finishedAt": <ISO?>, "durationMs": <number?>, "tokensIn": <number?>, "tokensOut": <number?>, "costUsd": <number?> }`

`activity` is required (entries without a non-empty activity are rejected/skipped); every other field is optional and written only when valid; `durationMs` is computed from `startedAt`/`finishedAt` when both are valid and not supplied explicitly.

Deliverables:
1. **New pure module `lib/ticket-cost.js`** (Electron-free, `node --test`-able), REUSING `orderFm` / `toIso` / `isValidAmount` from `lib/ticket-accounting.js` (do not duplicate them — `lib/ticket-runs.js:38` shows the require pattern). Exports: `ACTIVITIES_KEY = 'activities'`, `KNOWN_ACTIVITIES = ['ba','code','test','review','post-processing']`, `parseActivities(fm)` (tolerant: absent/non-string/bad JSON/non-array → `[]`), `serializeActivities(arr)` (one-line JSON), `appendActivity(fm, entry)` (validates, computes `durationMs`, appends chronologically, returns a NEW ordered fm — input not mutated), `totalActivities(activities)` → `{ durationMs, tokensIn, tokensOut, costUsd }` summing only valid present values (a total is omitted/null when no entry carried that field — never NaN or a fabricated 0-from-nothing).
2. **Renderer mirror + cost view**: browser-side duplicates of `parseActivities`/`totalActivities` (renderer.js cannot `require()`; place near `parseTicketRuns`, renderer.js:5380) and a per-activity breakdown + totals block in the ticket modal — new `.task-modal-cost` element next to `.task-modal-runs` (index.html line 58; fill/hide logic in `openTaskModal`, renderer.js:5820+, following the accounting/runs precedent: hidden when empty, formatted via the existing `formatCostUsd`/`formatTokens`/duration formatters). One row per activity (`activity · model · duration · tokens in/out · cost`) dropping absent fragments, plus a totals row.
3. **SKILL.md recording instruction** (BOTH copies, byte-identical — drift guards `test/orchestrate-agents.test.js:354` and `test/orchestrate-tech-lead.test.js:327`): after each phase's subagent completes (BA/coder/tester/tech-lead, and the post-processing step), the orchestrator appends one `activities` entry to that ticket's frontmatter — one-line JSON array, whole-file write, `updated` bumped — recording activity, model dispatched, startedAt/finishedAt, and tokensIn/tokensOut/costUsd only when actually reported (never fabricated). Existing accounting (`startedAt`/`finishedAt`/`tokens`/`costUsd`, `runs`) stays untouched — this is additive.

## Acceptance Criteria
- [ ] New pure module `lib/ticket-cost.js` exists, requires nothing from Electron, reuses `orderFm`/`toIso`/`isValidAmount` from `lib/ticket-accounting.js`, and exports `ACTIVITIES_KEY`, `KNOWN_ACTIVITIES`, `parseActivities`, `serializeActivities`, `appendActivity`, `totalActivities`.
- [ ] `appendActivity` appends an entry with required non-empty `activity`; entries missing an activity are rejected (fm returned unchanged apart from key ordering) rather than half-written.
- [ ] `appendActivity` records `model` (string), `startedAt`/`finishedAt` (normalised ISO-8601 via `toIso`), and computes `durationMs` from the pair when both are valid; `tokensIn`/`tokensOut`/`costUsd` are written ONLY when they pass `isValidAmount` — missing/NaN/negative/'' values leave the field absent, never fabricated.
- [ ] `appendActivity` preserves existing entries in order, appends last, stores the log as a single-line JSON string under `activities`, returns a NEW fm object (input not mutated) with `id, title, status, created, updated` leading.
- [ ] `parseActivities` is tolerant: absent field, non-string, invalid JSON, non-array payload, or non-object array members all yield a clean array (bad members filtered) — a hand-edited/corrupt ticket never throws.
- [ ] `totalActivities` sums `durationMs`, `tokensIn`, `tokensOut`, `costUsd` across entries counting only valid present values, and omits (nulls) any total for which no entry carried data — never NaN and never a made-up figure.
- [ ] A ticket carrying an `activities` value round-trips byte-preserved through `serializeTicket` → `parseTicketFrontmatter` (same parse/serialize behavior as the existing `runs` key), and a ticket WITHOUT the key is completely unaffected — existing parsing, board rendering, and the `startedAt/finishedAt/tokens/costUsd/runs` fields never break.
- [ ] The ticket modal shows a cost view when `activities` is non-empty: one line per activity (activity name, model, duration, tokens up/down, cost — absent fragments dropped) plus a totals line; the block is hidden entirely when the ticket has no activity data (nothing fabricated).
- [ ] The renderer mirrors (`parseActivities`/`totalActivities` equivalents) exist in `renderer/renderer.js` and match the lib semantics (verified by unit tests plus a source-scan in the style of `test/tasks-working-indicator.test.js`).
- [ ] Both SKILL.md copies instruct the orchestrator to append an `activities` entry per completed activity (ba/code/test/review/post-processing) with model, start/finish times, and tokens/cost only when actually reported — and remain byte-identical (drift guard green).
- [ ] Unit tests for `lib/ticket-cost.js` run under `node --test` with fixed timestamps and pass; the full existing suite stays green.

## Cucumber Tests
```gherkin
Feature: Per-activity cost accounting stored in the ticket MD file

  Scenario: The orchestrator records a BA activity on a ticket
    Given a ticket frontmatter with no activities field
    When appendActivity is called with activity "ba", model "claude-fable-5",
         startedAt "2026-07-19T10:00:00Z", finishedAt "2026-07-19T10:04:30Z",
         tokensIn 12000 and tokensOut 3500
    Then the returned frontmatter has an activities field holding a one-line JSON array of one entry
    And the entry's durationMs is 270000
    And the original frontmatter object is not mutated

  Scenario: Each phase appends its own entry in order
    Given a ticket whose activities already hold a "ba" entry
    When "code", "test" and "review" entries are appended in turn
    Then parseActivities returns four entries in chronological append order

  Scenario: Totals sum only what was actually recorded
    Given activities where only two of three entries carry tokensIn/tokensOut and only one carries costUsd
    When totalActivities runs
    Then tokensIn/tokensOut totals cover exactly the two carrying entries
    And the costUsd total equals the single recorded cost
    And no total is NaN

  Scenario: Missing token data is never fabricated (edge/failure)
    Given an appendActivity call with tokensIn NaN, tokensOut -5 and costUsd ""
    When the entry is appended
    Then the stored entry has no tokensIn, tokensOut or costUsd fields

  Scenario: An entry without an activity name is rejected (edge/failure)
    Given an appendActivity call whose activity is missing or blank
    When it runs
    Then no entry is appended and the activities log is unchanged

  Scenario: A corrupt activities field never breaks the board (edge/failure)
    Given a ticket whose activities frontmatter value is "not-json{{{"
    When parseActivities runs and the board renders the ticket
    Then parseActivities returns an empty array
    And no exception is thrown and the card renders normally

  Scenario: Round-trip through the board serializer
    Given a frontmatter object carrying an activities JSON array
    When it is serialized with serializeTicket and re-parsed with parseTicketFrontmatter
    Then the activities value is byte-identical
    And id, title, status, created, updated remain the leading keys

  Scenario: The modal shows the complete cost view
    Given a ticket with ba, code and test activity entries and computable totals
    When the ticket modal opens
    Then a cost section lists one row per activity with model, duration, tokens and cost fragments
    And a totals row shows the summed duration, tokens up/down and cost

  Scenario: No activity data shows no cost view
    Given a ticket with no activities field
    When the ticket modal opens
    Then the cost section is hidden

  Scenario: SKILL.md copies document the recording duty and stay in sync
    Given both copies of the orchestrate SKILL.md
    Then each instructs the orchestrator to append a per-activity accounting entry after each phase
    And the two copies are byte-for-byte identical
```

## Edge Cases & Failure Paths
- Token/cost data unavailable from a subagent run → fields omitted entirely (`isValidAmount` gate); the UI and totals must cope with any subset of fields being absent.
- `finishedAt` earlier than `startedAt`, or either invalid → no `durationMs` (mirror `computeMinutes` in `lib/ticket-runs.js:46` returning null on a bad pair).
- Corrupt/hand-edited `activities` (bad JSON, a JSON object instead of array, array containing strings/nulls) → tolerant parse to `[]`/filtered, never a throw during board polls or modal open.
- Unknown activity strings (beyond `KNOWN_ACTIVITIES`) are stored and displayed as-is — the list is open-ended ("whatever other activity"), known values only aid display ordering/labels.
- Duplicate activity types (e.g. two `code` entries from the fix loop) are legitimate — entries are a log, not a map; totals sum across duplicates.
- Very long logs stay on ONE line (JSON.stringify emits no newlines) so `frontmatterValueLine` (renderer.js:5303) never mangles them; never pretty-print the JSON into frontmatter.
- `appendActivity` on a ticket already carrying legacy `tokens`/`costUsd`/`runs` keys must leave those untouched (additive, backward compatible); the modal keeps showing the existing accounting/runs blocks unchanged.
- Zero is a valid recorded amount (`isValidAmount(0)` is true) — distinguish "recorded 0" from "absent".
- Orchestrator-side: the write is the standard whole-file `serializeTicket` write with `updated` bumped, and only the orchestrator (never a subagent) writes it — consistent with the SKILL.md state-consistency rules; SKILL.md edits must keep both copies byte-identical or the drift guards fail.

## Relevant Files & Context
- `lib/ticket-accounting.js` — existing single-build accounting (TASK-003): `recordBuildStart`/`recordBuildEnd`/`formatDuration`; REUSE its exported `orderFm`, `toIso`, `isValidAmount`, `LEADING_KEYS`. Do not duplicate.
- `lib/ticket-runs.js` — the template for this ticket: one-line JSON array on a flat key (`RUNS_KEY = 'runs'`), tolerant `parseRuns`, `computeMinutes`, `appendRun` requiring ticket-accounting helpers (line 38). Model `lib/ticket-cost.js` directly on it.
- `renderer/renderer.js` — `parseTicketFrontmatter` (~5170: value = everything after first `:`), `serializeTicket` (5312) + `frontmatterValueLine` (5303), display-formatter mirrors `formatCostUsd` (5352) / `formatTokens` (5361) / `formatBuildDuration` (5330), runs mirror `parseTicketRuns`/`ticketRunLines` (5380-5423), `ticketAccountingParts` (5427), `openTaskModal` (5820+, fills `.task-modal-accounting` / `.task-modal-runs`).
- `renderer/index.html` — task modal markup lines 42-70; add `.task-modal-cost` beside `.task-modal-runs` (line 58).
- `renderer/styles.css` — style beside the runs/accounting modal styles (search `task-modal-runs`).
- `.claude/skills/orchestrate/SKILL.md` + `assets/skills/orchestrate/SKILL.md` — add the orchestrator recording duty (phases at "## Phase 1"-"## Phase 4"; state-consistency rules at the end). Byte-identical or `test/orchestrate-agents.test.js:354` / `test/orchestrate-tech-lead.test.js:327` fail. Do not disturb wording pinned by `test/task-051-planning-model.test.js`, `test/orchestrate-swarm.test.js`, `test/orchestrate-tech-lead.test.js`.
- Test patterns: `test/ticket-runs.test.js` and `test/ticket-accounting.test.js` (pure-lib, fixed timestamps, invalid-amount matrices), `test/tasks-working-indicator.test.js` (renderer source-scan). Runner: `node --test`.
- Done references for how token/cost features landed before: `tasks/done/TASK-003-tokens-used.md`, `tasks/done/TASK-012-ticket-processing.md`, `tasks/done/TASK-021-ticket-progress.md`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
