---
id: TASK-031
title: bug reporting
status: done
created: 2026-07-18T21:27:13.755Z
updated: 2026-07-18T23:27:00Z
---

## Description
Add a **Bug** button to the ticket-creation popup (`#newTaskModal`, opened by `openNewTaskModal` in `renderer/renderer.js`). Clicking Bug switches the create flow into "bug mode": instead of creating an ordinary ticket, it creates a **new bug ticket** in `todo`, **links** that bug ticket to an **original** ticket, and **updates the original ticket's `.md`** so its functionality description stays accurate and now accounts for the reported bug.

This is distinct from the existing bug-capture flow. Today, dragging a `done` card onto `todo` opens `openBugReportModal`, which appends the bug text to **that same** ticket's `## Bug Reports` section and moves **that** ticket back to `todo` — it does not create a separate ticket and has no cross-ticket link. The new Bug button instead **creates a second, linked ticket** while also folding the bug into the original. The coder should **reuse** the bug-append logic (`appendBugReportToMarkdown` in the renderer, mirror of `lib/ticket-bug-reports.js` `appendBugReport`) and its heading-escape safeguards (`neutralizeBugText` / `escapeLeadingHeadingRun` in `lib/markdown-escape.js`) for the original-ticket update, and **reuse** the create path in `openNewTaskModal` (fm composition → `serializeTicket` → `ticketFolderForStatus` → `window.api.fs.mkdir`/`writeFile`) for the new bug ticket.

Linking convention (none exists today — define one explicitly): add a frontmatter key `bug-of: <ORIGINAL_ID>` on the new bug ticket. `serializeTicket` preserves unknown keys after the leading `id,title,status,created,updated`, and `parseTicketFrontmatter` already parses hyphenated keys, so `bug-of` round-trips through whole-file writes and board polls. The original ticket must reference the bug in its updated body (a "Bug Reports" entry naming the new bug id) so the relationship is visible from both sides.

Assumption stated explicitly: the creation popup has no notion of an "original ticket", so bug mode must add a control for choosing/entering the original ticket id (a required field/select of existing ticket ids).

## Acceptance Criteria
- [x] The `#newTaskModal` action row gains a `Bug` button (`.newtask-bug`) alongside the existing Cancel / Create buttons.
- [x] Clicking `Bug` puts the modal into "bug mode": it reveals a **required** original-ticket selector (`.newtask-bug-of`) listing existing ticket ids in the current board (or a text input accepting a `TASK-nnn` id), and the primary action creates a bug ticket rather than a plain ticket.
- [x] In bug mode the description textarea is treated as the **bug description**; the placeholder/label updates to reflect that.
- [x] On confirm in bug mode with a non-empty title and a selected original id, a NEW ticket is created with: `status: todo`, a fresh `id` from `nextTaskId(tab)`, `created`/`updated` = now, and a `bug-of: <ORIGINAL_ID>` frontmatter key. It is written into `tasks/todo/` via `ticketFolderForStatus('todo')` + `window.api.fs.mkdir` + `window.api.fs.writeFile` (same path as `openNewTaskModal`).
- [x] The new bug ticket body follows the standard template (`## Description`, `## Acceptance Criteria`, `## Additional Context` with the user-owned placeholder) exactly as `openNewTaskModal` builds it, with the description passed through `neutralizeBugText` (heading-escape) as the create path already does.
- [x] The new bug ticket's body references the original ticket id (e.g. a line "Bug against <ORIGINAL_ID>") so the link is human-visible, in addition to the `bug-of` frontmatter.
- [x] The ORIGINAL ticket's `.md` is updated: the app re-reads the freshest file from disk (`window.api.fs.readFile` + `parseTicketFrontmatter`), folds the bug description into it via the `appendBugReportToMarkdown` pattern (`## Bug Reports` section, heading-escaped, inserted before `## Additional Context`), bumps `updated`, preserves `created`, and writes the whole file back with `serializeTicket` (mirroring `openBugReportModal`'s save).
- [x] The original ticket's `## Additional Context` section is never overwritten, moved out of tail position, or edited (guaranteed by reusing the append helper, which inserts `## Bug Reports` before `## Additional Context`).
- [x] All ticket writes are whole-file atomic (single `serializeTicket` + `writeFile`), and frontmatter key order is `id, title, status, created, updated` then extras (`bug-of`), per `serializeTicket`.
- [x] Confirming in bug mode with an empty title shows an inline error and does not create/modify anything.
- [x] Confirming in bug mode with no original ticket selected shows an inline error and does not create/modify anything.
- [x] If the original ticket file cannot be read or written, the operation fails safely: an inline error is shown, and the new bug ticket is NOT left orphaned in an inconsistent state (define and implement a clear ordering — see edge cases).
- [x] Listeners use `bindActionOnce` and re-arm on retry paths, consistent with `openNewTaskModal` / `openBugReportModal`.
- [x] Leaving bug mode (or re-opening the modal) resets the modal cleanly back to normal create mode with no stale original-id selection and no stale listeners.
- [x] No new npm dependencies are added.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Bug button creates a linked bug ticket and updates the original

  Background:
    Given a project folder is open on the Tasks tab
    And the board already contains ticket "TASK-010" with an "## Additional Context" section
    And I click "New ticket" to open the creation popup

  Scenario: Bug button reveals bug mode
    When I click the "Bug" button
    Then a required original-ticket selector appears
    And the description field is labelled as the bug description

  Scenario: Creating a linked bug ticket
    Given the creation popup is in bug mode
    And I set the title to "Toggle ignores saved preference"
    And I choose "TASK-010" as the original ticket
    And I enter the bug description "Reloading resets the toggle to on"
    When I confirm
    Then a new ticket is written into tasks/todo/ with status "todo"
    And the new ticket frontmatter contains "bug-of: TASK-010"
    And the new ticket body references "TASK-010"
    And the frontmatter key order is id, title, status, created, updated, then bug-of

  Scenario: The original ticket is updated with the bug
    Given the creation popup is in bug mode targeting "TASK-010"
    And I enter the bug description "Reloading resets the toggle to on"
    When I confirm
    Then TASK-010's file gains a "## Bug Reports" section containing the bug text
    And that section is inserted before "## Additional Context"
    And TASK-010's "## Additional Context" section is unchanged and still at the tail
    And TASK-010's "updated" timestamp is bumped while "created" is preserved

  Scenario: Heading-forging bug text cannot hijack a section (edge)
    Given the creation popup is in bug mode targeting "TASK-010"
    And I enter a bug description whose line is "## Additional Context"
    When I confirm
    Then the appended text is escaped to "\#\# Additional Context"
    And no new real "## Additional Context" section boundary is created in TASK-010

  Scenario: Empty title is rejected (failure)
    Given the creation popup is in bug mode targeting "TASK-010"
    And the title is empty
    When I confirm
    Then an inline error is shown
    And no new ticket is written
    And TASK-010 is not modified

  Scenario: Missing original ticket is rejected (failure)
    Given the creation popup is in bug mode
    And no original ticket is selected
    When I confirm
    Then an inline error is shown
    And no new ticket is written
    And no original ticket is modified

  Scenario: Original ticket unwritable fails safely (failure)
    Given the creation popup is in bug mode targeting "TASK-010"
    And writing TASK-010 will fail
    When I confirm
    Then an inline error is shown
    And the board is not left in an inconsistent linked state
```

## Edge and Failure Cases
- Empty/whitespace title → inline error, nothing created or modified.
- No original ticket selected in bug mode → inline error, nothing created or modified.
- Original ticket id refers to a ticket not present on the board / file missing → inline error; do not create a dangling bug ticket that links to nothing (validate the original exists before writing).
- Bug description that contains lines starting with `#`/`##` (heading forging) → must be neutralized by `neutralizeBugText` / `escapeLeadingHeadingRun` before it enters either the new ticket body or the original's `## Bug Reports` (TASK-022/025/033 safeguard). Verify a literal `## Additional Context` line cannot forge a section.
- Empty/whitespace-only bug description → the append helper treats it as a no-op; require a non-empty description in bug mode (like `openBugReportModal`) and error out rather than writing an empty entry.
- Concurrent-write safety: re-read the original's freshest file before appending so a parallel agent write isn't clobbered; whole-file atomic write only.
- Preserve `## Additional Context` untouched and at the tail (guaranteed by the append helper inserting `## Bug Reports` before it).
- `created` must be preserved and `updated` bumped on the original.
- Write-ordering on partial failure: define the order (recommended — update the original first, then create the bug ticket; or create the bug ticket, then update the original and, on original-write failure, surface an error clearly). Whichever order, on failure show an inline error and avoid a silently inconsistent link.
- Re-opening the modal must reset bug mode, clear the original-id selection, and dispose stale listeners (rely on `bindActionOnce`).
- `bug-of` must serialize as an extra key after the leading five and round-trip through `parseTicketFrontmatter` (hyphen in key is supported).

## Relevant Files and Context
- `renderer/index.html` (~73-86) — `#newTaskModal` markup; add a `Bug` button (`.newtask-bug`) to `.task-modal-actions` and a hidden-by-default original-ticket selector (`.newtask-bug-of`) plus optional bug-mode label.
- `renderer/index.html` (~88-102) — `#bugReportModal`, reference markup/copy for describing a bug (reuse its wording/`.bugreport-desc` style).
- `renderer/renderer.js` (~6396-6485) — `openNewTaskModal`: the create path to extend for bug mode. Reuse fm composition, `neutralizeBugText` on the description, body template, subfolder write, `nextTaskId`/`taskSlug`, `bindActionOnce`/`armCreate`/`cleanup` lifecycle. Add `bug-of` to `fm` in bug mode (after the leading keys, like `kind`).
- `renderer/renderer.js` (~6508-6554) — `appendBugReportToMarkdown` (browser mirror): reuse to fold the bug into the original ticket's `## Bug Reports`, preserving `## Additional Context`.
- `renderer/renderer.js` (~6500-6506) — `neutralizeBugText` (renderer mirror of `escapeLeadingHeadingRun`): heading-escape for bug text; must be applied to text entering the original and the new ticket.
- `renderer/renderer.js` (~6561-6637) — `openBugReportModal`: reference for the freshest-file re-read, `updated`/`created` handling, whole-file `serializeTicket` write, error/retry lifecycle. NOTE this flow updates the SAME ticket and does not create a new one — call out in code comments how the new Bug button differs (creates a linked second ticket).
- `renderer/renderer.js` (~5285-5291) — `serializeTicket`: leading key order + unknown-key preservation (`bug-of` survives).
- `renderer/renderer.js` (~5159-5179) — `parseTicketFrontmatter`: confirms hyphenated `bug-of` parses; used to re-read the original.
- `renderer/renderer.js` (~5233-5291 region) — `ticketFolderForStatus`, `tasksJoin`, and the write helpers used by the create path.
- `renderer/renderer.js` (~6328-6346) — `nextTaskId` / `taskSlug` for the new bug ticket's id and filename.
- `lib/ticket-bug-reports.js` (whole file) — canonical `appendBugReport` (pure, `node --test`-able). If any append behavior is extended, keep the renderer mirror byte-for-byte in step (TASK-027 rule) and add/extend a unit test.
- `lib/markdown-escape.js` — canonical `escapeLeadingHeadingRun`; the renderer `neutralizeBugText` must match it.
- `lib/modal-actions.js` + `renderer.js` (~6363-6388) — `bindActionOnce` canonical + mirror for listener lifecycle.
- Board data: `tab.tasks.tickets` (a Map keyed by file path; values have `.fm`, `.body`, `.path`) is the source for populating the original-ticket selector and validating the chosen id (see usage in `openBugReportModal`).
- Tests to add (repo conventions): pure `node --test` unit coverage for any new/extended `lib/ticket-bug-reports.js` behavior and for `bug-of` round-tripping through the serializer; a source-scan e2e test (pattern of `test/task-028-post-processing.e2e.test.js` and `test/ticket-bug-reports.e2e.test.js`) asserting `index.html` has `.newtask-bug` + `.newtask-bug-of`, and `renderer.js` composes `bug-of` frontmatter, reuses `appendBugReportToMarkdown` for the original, and writes into `tasks/todo/`. No new npm dependencies.
- Note on `bug-of`: this is a NEW convention — no `links`/`relates`/parent key exists anywhere in `lib/`. If the orchestrate skill or any consumer should recognize the link, that is out of scope here unless the skill docs are updated; if `.claude/skills/orchestrate/SKILL.md` is touched, its `assets/skills/orchestrate/SKILL.md` mirror must be synced byte-for-byte (assets-drift guard) or tests fail.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
