---
id: TASK-019
title: parallel processing
status: done
created: 2026-07-18T11:04:06.712Z
updated: 2026-07-18T11:27:32.238Z
finishedAt: 2026-07-18T11:27:32.238Z
order: 1
---

## Description
Add a dropdown (`<select>`) to the Tasks screen toolbar that lets the user choose how many parallel build processes spawn (1..8). The chosen value is **persisted** so it survives folder switches and app restarts, and it is **passed into the build** so the swarm honours it as its concurrency limit.

Today the concurrency is fixed: the orchestrator defaults to `DEFAULT_CONCURRENCY = 3` (clamped to `MAX_CONCURRENCY = 8`) in `lib/ticket-queue.js`, and the Build button just queues the bare command `/orchestrate build`. This ticket lets the user pick N from the UI and carries it into the build as `/orchestrate build --concurrency <N>`.

Design decisions (assumptions — the user may adjust via `## Additional Context`):
1. **Where:** a `<select class="tasksConcurrency">` in the Tasks `.view-toolbar`, before the `New ticket` button, with a small label ("Parallel").
2. **Options:** exactly the integers `1..MAX_CONCURRENCY` (currently `1..8`), derived from `MAX_CONCURRENCY` so the ceiling never drifts. Default selected value is `DEFAULT_CONCURRENCY` (`3`).
3. **Persistence (per folder):** on `change`, store the value in `localStorage` under key `tasks:concurrency:<folder>`, mirroring the existing `slackStorageKey`/`saveSlackConfig`/`loadSlackConfig` pattern (renderer settings live in `localStorage`; there is no electron-store).
4. **Flow into the build:** `queueBuild` sends `/orchestrate build --concurrency <N>` where `<N>` is the resolved stored value. The orchestrator already resolves concurrency via `resolveConcurrency` and uses it as the `selectNextBatch` limit — **do not edit SKILL.md in this ticket** (avoid touching the skill docs; the flag is consumed by the existing concurrency resolution).
5. **New pure helper** `lib/tasks-settings.js` (Electron-free, requireable) holds the validation/clamp/read logic delegating to `resolveConcurrency`, so the tester can unit-test it with `node --test`. The renderer is a browser script (not requireable) so it must inline the same logic; keep the two in lockstep, matching the `ACTIVE_STATUSES`/`TASKS_ACTIVE_STATUSES` convention.

## Acceptance Criteria
- [ ] A `<select>` with class `tasksConcurrency` appears in the Tasks toolbar (`.view-toolbar` under `data-view="tasks"`), positioned before the `New ticket` button, with a visible label ("Parallel").
- [ ] The select contains exactly one `<option>` per integer from `1` to `MAX_CONCURRENCY` (currently `1..8`), values `"1".."8"`, ascending, no gaps or extras.
- [ ] The option list is derived from `MAX_CONCURRENCY` (not hard-coded to 8), so raising `MAX_CONCURRENCY` changes the options with no other edit.
- [ ] When no value is stored for the current folder, the selected value is `DEFAULT_CONCURRENCY` (`3`).
- [ ] Changing the select persists the value to `localStorage` under key `tasks:concurrency:<folder>` (per-folder), inside a `try/catch` like `saveSlackConfig`.
- [ ] On (re)opening a folder, the select initialises from that folder's stored value; a different folder shows its own value (or `3` if none).
- [ ] A stored value outside `1..MAX_CONCURRENCY` is clamped (`0`/negative → `1`; `>8` → `8`), and a missing/blank/non-numeric/corrupt value falls back to `3`. The select reflects the clamped/fallback value, never the raw bad value.
- [ ] The clamp/default rules are computed via `resolveConcurrency` from `lib/ticket-queue.js` (or the new helper delegating to it) — not re-implemented with different behaviour.
- [ ] When a build is queued, the queued command is `/orchestrate build --concurrency <N>` with `<N>` the resolved stored value; auto-continuation (`maybeContinueBuild`) queues the same argumented command, and stopping the build still removes the queued build command from `tab.promptQueue`.
- [ ] A new Electron-free module `lib/tasks-settings.js` exports pure helpers (`concurrencyOptions()`, `readStoredConcurrency(raw)`, `buildConcurrencyCommand(base, value)`, `storageKey(folder)`) that are `require`-able and unit-testable with `node --test`; `readStoredConcurrency` delegates its clamp/default to `resolveConcurrency`.
- [ ] The select is styled consistently with existing toolbar controls (reuse the `.profile-picker select` look in `renderer/styles.css`).
- [ ] The select's enabled/disabled state mirrors the Build button's readiness rules (never interactable in a state where a build cannot run). If the coder decides it should stay always-enabled, document why.
- [ ] This ticket does NOT modify `.claude/skills/orchestrate/SKILL.md` or `assets/skills/orchestrate/SKILL.md` (no assets drift-guard concern).

## Cucumber Tests
```gherkin
Feature: Choose the number of parallel build processes

  Background:
    Given the Tasks board is open on a folder with the orchestration skill installed

  Scenario: The concurrency dropdown appears in the Tasks toolbar
    When the Tasks view renders
    Then a select element with class "tasksConcurrency" exists in the Tasks toolbar
    And it is positioned before the "New ticket" button
    And it has a visible label "Parallel"

  Scenario: Options span 1..MAX_CONCURRENCY derived from the constant
    Given MAX_CONCURRENCY is 8
    When concurrencyOptions() is evaluated
    Then it returns exactly [1,2,3,4,5,6,7,8] in ascending order
    And the rendered select has one option per value

  Scenario Outline: The option ceiling tracks MAX_CONCURRENCY
    Given MAX_CONCURRENCY is <max>
    When concurrencyOptions() is evaluated
    Then the last option value is <max>
    And the number of options is <max>
    Examples:
      | max |
      | 8   |
      | 5   |

  Scenario: Default selection when nothing is stored
    Given no value is stored under "tasks:concurrency:<folder>"
    When readStoredConcurrency(null) is evaluated
    Then it returns 3

  Scenario: Changing the dropdown persists per folder
    When the user selects "5" in the concurrency dropdown
    Then localStorage key "tasks:concurrency:<folder>" holds a value that resolves to 5

  Scenario: Stored value is restored on reopening the same folder
    Given "tasks:concurrency:<folder>" resolves to 6
    When the folder is reopened
    Then the select's selected value is "6"

  Scenario: Each folder keeps its own value
    Given folder A stored 2 and folder B stored 7
    When folder A is open then the select shows "2"
    When folder B is open then the select shows "7"

  Scenario: Build command carries the chosen concurrency
    Given "tasks:concurrency:<folder>" resolves to 5
    When buildConcurrencyCommand("/orchestrate build", 5) is evaluated
    Then it returns "/orchestrate build --concurrency 5"
    And starting the build enqueues that exact command onto the prompt queue

  Scenario: Auto-continuation reuses the argumented command
    Given auto-build is running with concurrency 4
    When maybeContinueBuild re-queues a build
    Then the enqueued command is "/orchestrate build --concurrency 4"

  Scenario: Stopping the build clears the argumented command from the queue
    Given a "/orchestrate build --concurrency 4" command is queued and not yet sent
    When the user stops the build
    Then no build command remains in tab.promptQueue

  Scenario Outline: Out-of-range and junk stored values are clamped or defaulted
    When readStoredConcurrency(<raw>) is evaluated
    Then it returns <resolved>
    Examples:
      | raw         | resolved |
      | "0"         | 1        |
      | "-3"        | 1        |
      | "9"         | 8        |
      | "1000"      | 8        |
      | "3.9"       | 3        |
      | ""          | 3        |
      | null        | 3        |
      | "abc"       | 3        |
      | "{bad json" | 3        |

  Scenario: A corrupt localStorage entry never crashes the board and shows the default
    Given "tasks:concurrency:<folder>" contains an unparseable value
    When the Tasks view initialises the dropdown
    Then the select's selected value is "3"
    And no exception propagates out of the load path

  Scenario: resolveConcurrency remains the single clamp authority
    When readStoredConcurrency delegates to resolveConcurrency
    Then readStoredConcurrency(raw) equals resolveConcurrency(raw) for every raw above
```

## Edge / failure cases the coder must handle
- Stored value `0`, negative, or `< 1` → clamp to `1`.
- Stored value `> MAX_CONCURRENCY` (e.g. `9`, `1000`) → clamp to `8`.
- Non-integer numeric (e.g. `3.9`) → floored (`3`), per `resolveConcurrency`.
- Missing / empty / non-numeric / unparseable value → fall back to `3`; never throw (wrap `localStorage` access in `try/catch`).
- No folder open (`tab.folder` falsy) → `storageKey` returns `null`; skip persistence and show the default.
- `localStorage` unavailable / write throws → swallow in `try/catch`, keep the UI responsive.
- Board must not crash if the select is absent from the DOM (defensive null check on `tab.els.tasksConcurrency`).
- Build command must be constructed from the current resolved value at queue time (no stale in-memory divergence).

## Relevant files and context
- `lib/ticket-queue.js` — `DEFAULT_CONCURRENCY` (3), `MAX_CONCURRENCY` (8), `resolveConcurrency` (clamps to `[1,8]`, floors, defaults 3), `selectNextBatch` (uses the resolved limit). Source of truth for clamp/default; do not duplicate.
- `lib/tasks-settings.js` — **NEW** Electron-free helper: `concurrencyOptions()` → `[1..MAX_CONCURRENCY]`; `readStoredConcurrency(raw)` → JSON/parse-safe, delegates to `resolveConcurrency`; `buildConcurrencyCommand(base, value)` → `` `${base} --concurrency ${resolveConcurrency(value)}` ``; `storageKey(folder)` → `tasks:concurrency:${folder}` or `null`. Follow the header-comment + pure-function style of `lib/ticket-queue.js`.
- `renderer/index.html` — Tasks toolbar (`.view-toolbar` under `data-view="tasks"`, near lines 593-600); add the labelled `<select class="tasksConcurrency">` before the `New ticket` button.
- `renderer/renderer.js` — collect the element in `tab.els` (near lines 458-466); wire a `change` handler near the other Tasks handlers (near lines 485-488); persistence helpers modelled on `slackStorageKey`/`saveSlackConfig`/`loadSlackConfig` (near lines 6203-6233); `BUILD_COMMAND` (~5879), `toggleAutoBuild` (~5917), `maybeContinueBuild` (~5945), `queueBuild` (~5973) — construct the `--concurrency <N>` command here; folder-open reset path (`resetSlackForFolder` ~6237) is the model for initialising the select on folder open. This file is a browser script (not requireable), so inline the clamp logic to mirror `lib/tasks-settings.js`.
- `renderer/styles.css` — `.view-toolbar`, `.small-btn`, `.profile-picker select` — reuse the select styling for visual consistency.
- `main.js` / `preload.js` — reviewed: the renderer↔main bridge exposes no settings channel; renderer settings live in `localStorage`, so **no IPC / main-process change is required**.
- `test/ticket-queue.test.js` — the style the tester will follow for `lib/tasks-settings.js` unit tests (`node:test` + `node:assert/strict`, pure, no Electron/DOM).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)

Open assumptions to confirm if you disagree: (1) per-folder vs global persistence; (2) passing concurrency as a `--concurrency` command argument (chosen) vs a config file.
