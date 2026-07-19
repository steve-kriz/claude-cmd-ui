---
id: TASK-030
title: planning
status: done
created: 2026-07-18T21:21:12.573Z
updated: 2026-07-18T23:10:51Z
---

## Description
Add a **Plan** button to the Tasks tab toolbar, immediately to the left of the existing **New ticket** button (`renderer/index.html` `.tasksNewBtn`). Clicking it opens a modal where the user describes the functionality they want — free text, typically a bullet list of everything the feature needs. On submit, the app hands that description off to the orchestrate BA/planning flow so the agent can fully plan the work and create all the tickets required to build it.

Realistic handoff mechanism (explicit — no agent-invocation API exists in this codebase): the app cannot call an agent directly. The one established path for running an orchestrate command from the UI is queuing a slash-command string onto `tab.promptQueue` and letting `tryDispatchNextPrompt` type it into the running Claude REPL (exactly how the Build button sends `/orchestrate build` via `queueBuild`). The Plan button therefore composes `/orchestrate plan <user's description text>` and enqueues it through that same prompt-queue path. The button itself does **not** write any ticket files — the orchestrate plan flow (the BA phase) creates the tickets. This matches the skill's documented entry point `/orchestrate plan <feature description>` and the empty-state hint already shown in `index.html` (`/orchestrate plan <feature>`).

Assumption stated explicitly: "use the BA agent to plan and create tickets" is realized by dispatching `/orchestrate plan …` into the Claude terminal; there is no separate programmatic BA API in this codebase, so the ticket covers the UI + the prompt-queue handoff that does exist.

## Acceptance Criteria
- [x] A `Plan` button (`.tasksPlanBtn`) exists in the Tasks toolbar in `renderer/index.html`, positioned immediately before the `New ticket` button (`.tasksNewBtn`), using the same `small-btn` styling classes as the sibling toolbar buttons.
- [x] The button element is registered in the per-tab `els` map in `renderer/renderer.js` (alongside `tasksNewBtn`) as `tasksPlanBtn`.
- [x] A click listener is wired for `tasksPlanBtn` in the same block that wires `tasksNewBtn`, opening a new plan modal (e.g. `openPlanModal(tab)`).
- [x] A new modal `#planModal` exists in `index.html`, following the existing `.task-modal.hidden` → `.task-modal-card` → `.task-modal-head` / `.task-modal-body` (textarea) / `.task-modal-error` / `.task-modal-actions` structure used by `#newTaskModal` and `#bugReportModal`.
- [x] The plan modal has a multi-line `<textarea>` (placeholder inviting a bullet list of required functionality), a Cancel button, and a primary submit button labelled `Plan` (or `Create plan`).
- [x] Opening the modal clears the textarea and any prior error, removes `hidden`, and focuses the textarea (mirroring `openNewTaskModal`).
- [x] Submit and Cancel are bound with `bindActionOnce` so re-opening never leaves a stale listener; the submit re-arms on the empty-input retry path exactly like `openNewTaskModal`/`openBugReportModal`.
- [x] On submit with non-empty text, the app enqueues `"/orchestrate plan " + <trimmed textarea text>` onto `tab.promptQueue`, calls `renderQueue(tab)`, and calls `tryDispatchNextPrompt(tab)` only when `tab.status === 'finished'` (mirroring `saveQueuePrompt` and `queueBuild`).
- [x] After a successful enqueue the modal closes (adds `hidden`, disposes listeners).
- [x] Submitting empty/whitespace-only text does not enqueue anything: it shows an inline error (e.g. "Describe what you want built.") and keeps the modal open with the submit re-armed.
- [x] The Plan button is disabled when no folder is open and when the orchestration skill is not installed (consistent with how Build is gated on `tab.tasks.skillInstalled`); its enabled/disabled state is refreshed on the same board updates that refresh the New/Build buttons.
- [x] No ticket files are written by the Plan button itself; ticket creation is left entirely to the dispatched `/orchestrate plan` flow.
- [x] The user's plan text is passed verbatim as the command argument (no truncation); multi-line bullet content is preserved as a single queued prompt string, exactly as the existing queue editor already supports multi-line prompts.
- [x] A plan prompt must NOT be matched by `isBuildCommand` (it is not a build command).
- [x] No new npm dependencies are added.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Plan button hands a feature request to the orchestrate plan flow

  Background:
    Given a project folder is open on the Tasks tab
    And the orchestration skill is installed
    And a Claude command terminal is running and idle

  Scenario: Plan button sits left of New ticket
    Then the Tasks toolbar shows a "Plan" button immediately before the "New ticket" button

  Scenario: Opening the plan modal
    When I click the "Plan" button
    Then the plan modal appears
    And its description textarea is empty and focused
    And no error message is shown

  Scenario: Submitting a bullet-list feature request dispatches an orchestrate plan command
    Given the plan modal is open
    And I enter:
      """
      - add a dark mode toggle
      - persist the choice per user
      - default to system preference
      """
    When I click the "Plan" submit button
    Then a prompt beginning with "/orchestrate plan" containing my three bullet lines is pushed onto the tab prompt queue
    And the prompt queue is dispatched because the terminal is idle
    And the plan modal closes
    And the Plan button does not itself write any ticket file

  Scenario: Cancel discards the request
    Given the plan modal is open with text entered
    When I click "Cancel"
    Then the modal closes
    And nothing is pushed onto the prompt queue

  Scenario Outline: Empty input is rejected (edge/failure)
    Given the plan modal is open
    And the description textarea contains "<text>"
    When I click the "Plan" submit button
    Then an inline error is shown
    And the modal stays open
    And nothing is pushed onto the prompt queue
    And the submit button remains clickable for a retry

    Examples:
      | text        |
      |             |
      | "   "       |
      | "\n\t  \n"  |

  Scenario: Plan is unavailable without the skill (failure gating)
    Given the orchestration skill is NOT installed
    Then the "Plan" button is disabled

  Scenario: Re-opening the modal does not double-dispatch (edge)
    Given I opened the plan modal, then closed it, then opened it again
    When I submit a valid description once
    Then exactly one "/orchestrate plan" prompt is enqueued
```

## Edge and Failure Cases
- Empty / whitespace-only description → inline error, no enqueue, modal stays open, submit re-armed.
- No folder open → button disabled (guard like `openNewTaskModal`'s `if (!tab.folder) return;`).
- Orchestration skill not installed → button disabled (parallels Build gating).
- Terminal not running / not idle (`tab.status !== 'finished'`, `tab.cmd.id` absent) → the prompt is still queued and `renderQueue` reflects it; dispatch only fires when idle, so nothing is lost (mirror `saveQueuePrompt`'s conditional dispatch — do NOT force-write to a missing pty).
- Multi-line bullet text must remain a single queued prompt (do not split on newlines); confirm it round-trips through `tab.promptQueue.push` unchanged.
- Re-opening the modal before submitting must not leave a stale submit listener (rely on `bindActionOnce`).
- Very long text: no truncation; passed verbatim as the command argument.
- Do not confuse this with `queueBuild`: Plan enqueues `/orchestrate plan …`, not `/orchestrate build`; `isBuildCommand` must NOT treat the plan prompt as a build command.

## Relevant Files and Context
- `renderer/index.html` — `.tasksNewBtn` toolbar button; add `.tasksPlanBtn` immediately before it inside the same `.view-toolbar`. Empty-state hint already present nearby.
- `renderer/index.html` (~73-102) — existing modal markup pattern (`#newTaskModal`, `#bugReportModal`); clone this structure for `#planModal` with classes `.plan-body` (textarea), `.plan-error`, `.plan-cancel`, `.plan-submit`.
- `renderer/renderer.js` (~455-467) — per-tab `els` registration; add `tasksPlanBtn: ws.querySelector('.tasksPlanBtn')`.
- `renderer/renderer.js` (~486-494) — toolbar click wiring block; add `tab.els.tasksPlanBtn.addEventListener('click', () => openPlanModal(tab));`.
- `renderer/renderer.js` (~6396-6485) — `openNewTaskModal`, the canonical modal-open pattern (clear fields, `classList.remove('hidden')`, focus, `bindActionOnce`, `armCreate`/re-arm, `cleanup`). Model `openPlanModal` on this but do NOT write a file.
- `renderer/renderer.js` (~6561-6637) — `openBugReportModal`, a second reference for the arm/cleanup/error pattern.
- `renderer/renderer.js` (~5002-5012) — `saveQueuePrompt`: the exact enqueue + `renderQueue` + conditional `tryDispatchNextPrompt` pattern to reuse.
- `renderer/renderer.js` (~6168-6172) — `queueBuild`: reference for building a command string and dispatching; `BUILD_COMMAND` (~5959); `isBuildCommand` (~6025) — ensure plan prompts don't match it.
- `renderer/renderer.js` (~5052-5098) — `tryDispatchNextPrompt`: prompts go out via `window.api.pty.write(tab.cmd.id, next)` then `\r`; multi-line strings are supported.
- `renderer/renderer.js` (~6363-6388) — `bindActionOnce` (mirror of `lib/modal-actions.js`); reuse for listener lifecycle.
- `renderer/renderer.js` (~6088-6107) — `updateBuildBtn` shows the skill-installed / pending gating idiom to mirror when enabling/disabling the Plan button.
- `.claude/skills/orchestrate/SKILL.md` — documents `/orchestrate plan <feature description>`, the command the button dispatches. This ticket likely needs no SKILL edit since plan is already documented. NOTE the assets-drift guard: if any `.claude/skills/orchestrate/SKILL.md` copy is edited, the mirror under `assets/skills/orchestrate/SKILL.md` must be kept byte-for-byte in sync or tests fail.
- `renderer/styles.css` — `.task-modal`, `.task-modal-card`, `small-btn`, `primary-btn` styles already cover the new modal/button; reuse, add nothing unless a Plan-specific class is needed.
- Tests to add (repo conventions): a source-scan e2e test (pattern of `test/task-028-post-processing.e2e.test.js`) asserting `index.html` has `.tasksPlanBtn` before `.tasksNewBtn` and a `#planModal`, and `renderer.js` wires `tasksPlanBtn` → `openPlanModal`, composes `'/orchestrate plan '`, and enqueues via `tab.promptQueue.push` + `tryDispatchNextPrompt`. If the command-composition is extracted into a `lib/` helper (optional), add a matching `node --test` unit test and a renderer mirror.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
