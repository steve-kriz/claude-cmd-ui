---
id: TASK-075
title: Colored type bar on board cards (green normal, red bug, yellow PR review)
status: done
created: 2026-07-19T11:33:44.002Z
updated: 2026-07-19T21:52:58Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-19T12:20:00Z","finishedAt":"2026-07-19T20:56:10Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T21:38:30Z","finishedAt":"2026-07-19T21:42:43Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T21:42:43Z","finishedAt":"2026-07-19T21:47:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T21:47:00Z","finishedAt":"2026-07-19T21:51:41Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T21:51:41Z","finishedAt":"2026-07-19T21:52:58Z"}]
---

## Description
Add a thin horizontal colored bar to every Tasks-board card, rendered directly
**below the ticket-number header and above the title** — i.e. between `idEl`
(`.task-card-id`) and `titleEl` (`.task-card-title`) in `renderTasksBoard`
(`renderer/renderer.js` ~5878-5885). The bar encodes the ticket's **type**, derived
purely from persisted frontmatter so it updates on the normal poll cycle:

- **Red** (`#f14c4c`) — bug ticket: non-empty `bug-of` frontmatter (written by the
  bug-create flow, renderer.js ~7065-7066; detect with the existing
  `ticketFieldNonEmpty` helper, renderer.js ~5218).
- **Yellow** (`#e5c100`) — PR review ticket: non-empty `review-of` frontmatter (the
  marker introduced by TASK-074; without it, review follow-ups are currently
  indistinguishable from normal tickets).
- **Green** (`#6a9955`) — every other ticket (the default), including
  `kind: post-processing` and unknown-status cards.

Implementation shape: a `div.task-card-type` element with modifier classes
(`.bug`, `.review`; green is the default with no modifier), styled in
`renderer/styles.css` next to the existing card styles (~2614-2637), reusing the
board's existing color tokens (red `#f14c4c`, yellow `#e5c100`) and adding green
`#6a9955`. The bar appears on every card in every lane, including cards inside the
Done lane's "Archived (N)" expander and unknown-lane cards, since they all flow
through the same card-construction code path.

Precedence: if a ticket somehow carries BOTH `bug-of` and `review-of`, **red (bug)
wins** (bug is the more urgent signal).

**Dependency (locked):** the yellow rule needs TASK-074's `review-of` convention.
Build TASK-074 first; pre-existing review follow-up tickets created before the
marker will render green (accepted — no backfill).

## Acceptance Criteria
- [ ] Every rendered task card contains a `.task-card-type` bar positioned after
  `.task-card-id` and before `.task-card-title`.
- [ ] A card whose frontmatter has non-empty `bug-of` renders the bar red
  (`#f14c4c`).
- [ ] A card whose frontmatter has non-empty `review-of` renders the bar yellow
  (`#e5c100`).
- [ ] All other cards render the bar green (`#6a9955`), including
  `kind: post-processing` and unknown-status cards.
- [ ] When both `bug-of` and `review-of` are non-empty, the bar is red (bug wins).
- [ ] Detection uses trimmed-non-empty checks (`ticketFieldNonEmpty`); an empty or
  whitespace-only `bug-of` / `review-of` yields the green default.
- [ ] The bar is derived purely from persisted frontmatter — no new state; it
  updates within one board poll after the file changes on disk.
- [ ] Existing card features are unaffected: working/waiting/failed dot (top-right,
  absolutely positioned — no overlap), accounting meta line, agent label, drag/drop,
  click-to-open-modal, archived expander, and (from TASK-074) the won't-do
  struck-through title.
- [ ] Colors are defined as CSS consistent with the existing `.task-card-dot`
  palette (`#f14c4c`, `#e5c100`) plus the new green `#6a9955`.
- [ ] Tests: unit + e2e (`node --test`, source-scan + Given/When/Then) cover the
  three colors, the both-markers precedence, the empty-marker edge, and
  poll-cycle update. Green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Card type bar encodes ticket type by color

  Scenario: Normal ticket shows a green bar
    Given a ticket with no bug-of and no review-of frontmatter
    When the board renders its card
    Then a type bar appears below the ticket id and above the title
    And the bar is green (#6a9955)

  Scenario: Bug ticket shows a red bar
    Given a ticket whose frontmatter contains "bug-of: TASK-031"
    When the board renders its card
    Then the type bar is red (#f14c4c)

  Scenario: PR review ticket shows a yellow bar
    Given a ticket whose frontmatter contains "review-of: TASK-046"
    When the board renders its card
    Then the type bar is yellow (#e5c100)

  Scenario: Empty marker values fall back to green (edge)
    Given a ticket whose frontmatter contains "bug-of:" with a blank value
    When the board renders its card
    Then the type bar is green

  Scenario: Both markers present uses precedence (edge)
    Given a ticket with non-empty bug-of and non-empty review-of
    When the board renders its card
    Then the type bar is red

  Scenario: Post-processing and unknown cards are green (edge)
    Given a kind: post-processing ticket and an unknown-status ticket
    When the board renders their cards
    Then each type bar is green

  Scenario: Bar updates on the poll cycle
    Given a rendered green-bar ticket
    When "bug-of: TASK-001" is added to its file on disk and "updated" is bumped
    Then within one board poll the card's type bar is red

  Scenario: Existing indicators are unaffected (edge)
    Given a bug ticket with status "failed-testing"
    When the board renders its card in the Testing lane
    Then the card shows both the red type bar and the red failed dot without overlap
```

## Impact If Not Fixed
Without the type bar, users can't distinguish bug, review, and normal tickets at a
glance on a busy board — bugs and reviewer-requested fixes look identical to routine
work, so the highest-signal cards get no visual priority.

## Edge Cases & Failure Paths
- Empty/whitespace `bug-of` or `review-of` → green (use `ticketFieldNonEmpty`, not
  raw-string truthiness).
- Both markers present → red (bug) wins (deterministic).
- Unknown-status cards already have a red left border
  (`.task-card.unknown-status`, styles.css ~2637) — the bar must not be confused
  with it; verify visual stacking.
- Archived done cards (TASK-065 expander) are the same DOM nodes — the bar must
  render there too.
- The board re-render signature (`pollTasksOnce`, renderer.js ~5721-5724) keys on
  `id|status|updated`; a frontmatter marker edit that doesn't bump `updated` won't
  re-render until forced — acceptable (agents always bump `updated`); tests must
  bump `updated` when mutating files.
- Pre-existing review follow-ups without `review-of` render green (accepted — no
  backfill).
- No fabrication: never infer "review" from title text like "follow-up";
  frontmatter only.

## Relevant Files & Context
- `renderer/renderer.js` — card construction in `renderTasksBoard` ~5813-5940
  (insert the bar between the `idEl` append ~5884 and the `titleEl` append ~5885);
  `ticketFieldNonEmpty` ~5218; bug marker origin `fm['bug-of']` ~7065; poll/signature
  ~5670-5739.
- `renderer/styles.css` — `.task-card` ~2614, `.task-card-id` ~2623,
  `.task-card-title` ~2628; color tokens: `#f14c4c` (failed red ~2737), `#e5c100`
  (waiting yellow ~2724), `#4ec9b0` (done-lane teal ~2571), lane header colors
  ~2566-2572. Add `.task-card-type` + `.bug` / `.review` rules and green `#6a9955`.
- `lib/ticket-lanes.js` — `isPostProcessingTicket` pattern (~77-80) if a
  unit-testable pure predicate (`isBugTicket` / `isReviewTicket`) is wanted; the
  renderer duplicates tiny pure helpers by convention.
- `.claude/skills/orchestrate/SKILL.md` + `assets` copy — where the `review-of`
  convention lands (shared with TASK-074; that ticket ships it).
- Test patterns: `test/tasks-working-indicator.test.js` (source-scan of renderer
  constants/DOM wiring), `test/task-031-bug-reporting.test.js` / `.e2e.test.js`
  (`bug-of` coverage precedent).

## Clarifications
- Q (075 review marker): how is a "PR review" ticket identified?
  A: By the `review-of` frontmatter key introduced in TASK-074 (mirrors `bug-of`).
- Q (075 green shade): which green?
  A: VS Code green `#6a9955` (red `#f14c4c` and yellow `#e5c100` reuse existing
  tokens).
- Q (075 other kinds): do post-processing / unknown-status cards get a bar?
  A: Yes — green default for all cards unless bug (red) or review (yellow).
- Q (075 precedence): if both `bug-of` and `review-of` are present?
  A: Red (bug) wins.
- Q (075 backfill): pre-existing review tickets without the marker?
  A: Accept green — no backfill.
- Q (075 sequencing): build order vs TASK-074?
  A: Build TASK-074 first (it ships the `review-of` marker), then TASK-075.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
