---
id: TASK-074
title: PR review tickets — impact statement and Won't-do resolution
status: done
created: 2026-07-19T11:32:43.189Z
updated: 2026-07-19T21:36:56Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-19T12:20:00Z","finishedAt":"2026-07-19T20:56:10Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T21:11:03Z","finishedAt":"2026-07-19T21:15:53Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T21:15:53Z","finishedAt":"2026-07-19T21:24:31Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T21:24:31Z","finishedAt":"2026-07-19T21:28:23Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T21:28:23Z","finishedAt":"2026-07-19T21:28:23Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T21:28:23Z","finishedAt":"2026-07-19T21:33:22Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T21:33:22Z","finishedAt":"2026-07-19T21:36:56Z"}]
---

## Description
Two related changes to the tech-lead ("PR review") follow-up fix tickets and the
board's handling of tickets the user decides not to fix.

**Part 1 — impact statement + review marker.** When the Phase-4 tech-lead review
finds issues, the orchestrator creates one follow-up fix ticket per issue
(`.claude/skills/orchestrate/SKILL.md` Phase 4 step 2; reviewer contract in
`.claude/agents/tech-lead.md`). Today the created ticket has no required consequence
statement and no machine-identifiable marker. Change the convention so:
- The reviewer reports, for every finding, a short "impact if not fixed" statement
  (1–3 sentences: the concrete consequence of leaving it unfixed).
- Every review follow-up ticket the orchestrator writes contains a
  `## Impact If Not Fixed` section AND carries a `review-of: <reviewed ticket id>`
  frontmatter key (an extra key kept after the leading keys by the serializer,
  exactly like `bug-of` / `agent`). This marker is also the dependency for
  TASK-075's yellow type-bar.

This Part is an **instruction-file change**: edit `.claude/agents/tech-lead.md` and
`.claude/skills/orchestrate/SKILL.md`, and mirror **byte-for-byte** into
`assets/agents/tech-lead.md` and `assets/skills/orchestrate/SKILL.md` (the drift
guard `test/orchestrate-agents.test.js` asserts `bundled.equals(project)`).

**Part 2 — "Won't do" resolution.** The user can decide any ticket isn't worth
doing. Add a "Won't do" choice to the task-modal status `<select>`
(`renderer/index.html` ~47-54; modal logic `openTaskModal` in
`renderer/renderer.js` ~6027-6221). Choosing it and saving moves the ticket to the
**Done lane** carrying a persistent `wont-do` marker, represented as
**`status: done` + `resolution: wont-do`** (locked decision — NO status-enum
change):
- `doWrite` (renderer.js ~6176-6201) maps the "Won't do" pseudo-option to
  `status: 'done'` and sets `resolution: 'wont-do'` in a single whole-file
  `serializeTicket` write (bump `updated`, preserve `created`); the file reconciles
  into `tasks/done/` via the existing `reconcileTicketFolders` / `relocateTicketFile`
  flow — no reconciliation change needed.
- `fill()` (renderer.js ~6049-6071) selects "Won't do" when re-opening a ticket
  that is `status: done` + `resolution: wont-do`; picking plain "Done" clears the
  `resolution` key.
- The Done-lane card shows the won't-do ticket with a **struck-through / muted
  title** (styled in `renderer/styles.css` near the card styles), including inside
  the Done lane's "Archived (N)" expander.
- "Won't do" is available on **every** ticket in the modal, and is reachable
  **only via the modal status select** — plain drag-to-Done still means normal done
  (`moveTicketToStatus` must not set `resolution: wont-do`).

The `wont-do` marker is a `resolution` frontmatter value; the status enum in
`lib/ticket-lanes.js` is unchanged. A ticket whose frontmatter status were literally
`wont-do` still routes to the unknown lane (today's behavior) — it is never treated
as done.

## Acceptance Criteria
- [ ] `.claude/agents/tech-lead.md` instructs the reviewer to report a short
  "impact if not fixed" statement (1–3 sentences) for every finding, alongside
  what/where/why.
- [ ] `.claude/skills/orchestrate/SKILL.md` Phase 4 instructs the orchestrator to
  (a) include a `## Impact If Not Fixed` section in every review follow-up ticket
  body, and (b) stamp `review-of: <reviewed ticket id>` frontmatter on each
  follow-up ticket (extra key kept after the leading keys by the serializer).
- [ ] `assets/agents/tech-lead.md` and `assets/skills/orchestrate/SKILL.md` are
  byte-for-byte identical to their `.claude/` counterparts
  (`test/orchestrate-agents.test.js` stays green).
- [ ] The task modal's status `<select>` offers a "Won't do" option on every ticket.
- [ ] Saving with "Won't do" selected persists `status: done` + `resolution: wont-do`
  in a single whole-file `serializeTicket` write, `updated` bumped, `created`
  preserved.
- [ ] After saving, the card appears in the Done lane and the file reconciles into
  `tasks/done/` on the next poll (no reconciliation-code change).
- [ ] Re-opening a `done` + `resolution: wont-do` ticket shows "Won't do" selected
  (not plain "Done"); re-saving without touching the select preserves the marker.
- [ ] Selecting "Done" (or any other status) on a won't-do ticket clears the
  `resolution` key from the rewritten frontmatter.
- [ ] A won't-do card is rendered with a struck-through / muted title in the Done
  lane, including inside the Archived (N) expander.
- [ ] Plain drag-to-Done (`moveTicketToStatus`) does NOT set `resolution: wont-do`.
- [ ] `lib/ticket-lanes.js` `VALID_STATUSES` is unchanged; `node --test
  test/ticket-lanes.test.js` passes unmodified. A ticket with literal
  `status: wont-do` still routes to the unknown lane.
- [ ] The user-owned `## Additional Context` section is never touched by any write.
- [ ] Tests: unit + e2e (`node --test`, source-scan + Given/When/Then) cover the
  save→done+resolution write, modal round-trip, revert-clears-marker, the
  struck-through render, the instruction-file + assets drift guards, and the
  enum-unchanged edge. Green aside from the two known pre-existing unrelated
  failures (`test/task-030-plan-button.e2e.test.js`,
  `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: PR review follow-up tickets carry impact and can be resolved as won't-do

  Scenario: Reviewer instructions require an impact statement
    Given the tech-lead agent definition in .claude/agents/tech-lead.md
    Then it instructs the reviewer to report the impact if each finding is not fixed
    And the assets/agents/tech-lead.md copy is byte-identical

  Scenario: Orchestrator instructions require the Impact section and review-of marker
    Given the orchestrate SKILL.md Phase 4 instructions
    Then follow-up fix tickets must contain a "## Impact If Not Fixed" section
    And must carry a "review-of" frontmatter key naming the reviewed ticket
    And the assets SKILL.md copy is byte-identical

  Scenario: User marks a ticket as won't do
    Given a ticket TASK-080 with status "todo" open in the task modal
    When the user selects "Won't do" in the status dropdown and saves
    Then the ticket file is rewritten whole with status "done" and resolution "wont-do"
    And "updated" is bumped and "created" preserved
    And on the next poll the card renders in the Done lane with a struck-through title
    And the file is reconciled into tasks/done/

  Scenario: Won't-do round-trips through the modal
    Given a ticket with status "done" and resolution "wont-do"
    When the user opens it in the task modal
    Then the status select shows "Won't do" selected
    When the user saves without changing the select
    Then status remains "done" and resolution remains "wont-do"

  Scenario: Reverting won't-do clears the marker
    Given a ticket with status "done" and resolution "wont-do"
    When the user selects "Done" and saves
    Then the resolution key is absent from the rewritten frontmatter

  Scenario: Drag to Done does not mark won't-do (edge)
    Given a ticket dragged onto the Done lane
    When the move is written
    Then status is "done" and no resolution key is set

  Scenario: The status enum is not expanded (edge)
    Given lib/ticket-lanes.js
    Then VALID_STATUSES does not contain "wont-do"
    And a ticket whose frontmatter status is literally "wont-do" routes to the unknown lane

  Scenario: Won't-do write failure surfaces an error (failure)
    Given the ticket file write fails
    When the user saves "Won't do"
    Then the modal shows the save error and the ticket file on disk is unchanged
```

## Impact If Not Fixed
This section is also the template the review follow-up tickets must now carry. For
this ticket itself: without it, review follow-ups convey no urgency and can't be
distinguished from normal tickets, and users have no first-class way to decline a
suggested fix — declined items either clutter `todo` forever or get force-dragged to
Done with no record that they were intentionally skipped.

## Edge Cases & Failure Paths
- Hand-edited literal `status: wont-do` → unknown lane, `Unknown status:` tooltip,
  left un-filed — never silently treated as done.
- Changed-on-disk race: the won't-do save must flow through `onSave`'s existing
  two-click overwrite guard (renderer.js ~6202-6218) unchanged.
- `resolution` with an unexpected value (e.g. `fixed`) must NOT trigger the won't-do
  rendering; only exactly `wont-do` (trimmed) does.
- Injected-option logic (renderer.js ~6059-6070): the fixed "Won't do" option must
  not collide with the injected current-status option (e.g. for `failed-testing`
  tickets), and re-fills must not accumulate duplicate options.
- Won't-do done cards age into the Done lane's "Archived (N)" expander after 5 days
  like any done card (`ticketIsArchived`, `lib/ticket-archive.js`,
  `ARCHIVE_AFTER_DAYS = 5`) — the struck-through treatment must still render inside
  the expander.
- A ticket carrying an `agent` claim marked won't-do: the write leaves the claim
  untouched (orchestrator owns claims).
- Slack `show tasks`/`status` (`lib/slack-commands.js`) counts won't-do as ordinary
  done for now (locked decision) — no Slack change in this ticket.

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md` — Phase 4 (~314-359); enum rules (~60-91,
  ~414-417); extra-key precedent `agent` (~92) / `kind` (~83). Mirror to
  `assets/skills/orchestrate/SKILL.md`.
- `.claude/agents/tech-lead.md` — reviewer reporting contract. Mirror to
  `assets/agents/tech-lead.md`.
- `test/orchestrate-agents.test.js` — the byte-identical drift guard.
- `renderer/index.html` — `#taskModal` status select (~47-54).
- `renderer/renderer.js` — `openTaskModal` ~6027-6221 (`fill` status handling
  ~6049-6071, `doWrite` ~6176-6201, `onSave` overwrite guard ~6202-6218),
  `serializeTicket` ~5330-5336 (unknown-key round-trip), `parseTicketFrontmatter`
  ~5190-5210, `ticketFolderForStatus` ~5264, `reconcileTicketFolders` ~5767,
  `renderTasksBoard` done-lane/archive handling ~5788-5972, `moveTicketToStatus`
  ~6532, `ticketFieldNonEmpty` ~5218.
- `renderer/styles.css` — card styles ~2614-2748; add the struck-through/muted
  won't-do treatment near `.task-card-meta` / `.task-card-title`.
- `lib/ticket-lanes.js` — must remain unchanged (`VALID_STATUSES` line ~38).
- Test patterns: `test/tasks-working-indicator.test.js` (source-scan style),
  `test/ticket-lanes.test.js`, `test/orchestrate-agents.test.js`.

## Clarifications
- Q (074 wont-do model): status enum vs frontmatter key?
  A: `status: done` + `resolution: wont-do` frontmatter key — no enum change,
  honors the "never invent a status" rule; the serializer already round-trips
  extra keys.
- Q (074 scope): who gets the "Won't do" option?
  A: Every ticket in the task modal (not only review follow-ups).
- Q (074 trigger): modal-only or also drag?
  A: Modal status select only. Plain drag-to-Done stays "normal done".
- Q (074 visual): how does a won't-do card look?
  A: Struck-through / muted title in the Done lane.
- Q (074/075 review marker): standardize `review-of`?
  A: Yes — stamp `review-of: <reviewed ticket id>` on review follow-up tickets
  (mirrors `bug-of`). Enables TASK-075's yellow bar.
- Q (074 Slack): distinguish won't-do in Slack summaries?
  A: No — count won't-do as ordinary done for now.
- Q (074/075 sequencing): build order?
  A: Build TASK-074 first so the `review-of` marker exists, then TASK-075 reads it.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
