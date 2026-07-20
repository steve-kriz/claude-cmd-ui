---
id: TASK-056
title: Slack command framework — pure matcher/registry module (lib/slack-commands.js)
status: done
created: 2026-07-19T00:00:00Z
updated: 2026-07-19T18:45:00Z
---

## Description
The Slack ↔ Claude thread proxy (TASK-009/011) already feeds every user reply in
the session anchor thread to Claude verbatim. We are adding a command system:
certain phrases typed into the thread (e.g. "show me the tasks") must be
answered by the app itself instead of being forwarded to Claude. This ticket
creates ONLY the Electron-free decision core: a new `lib/slack-commands.js`
module holding the command registry shape, input normalization, phrase matching,
and command listing. It performs no I/O, no DOM access, no network — exactly
like `lib/slack-proxy.js` — so it is fully unit-testable with `node --test`.
Renderer wiring is TASK-057; the first real command entries land in TASK-058
(tasks), TASK-059 (help) and TASK-060 (status), so `DEFAULT_COMMANDS` ships
EMPTY here and every function accepts an injectable registry for tests.

Registry design (extensible; adding a command later = one new entry + a renderer
handler): each entry is `{ name, description, patterns }` where `patterns` is an
array of trigger phrases compared against the NORMALIZED message text. Entries
are data-only — handlers live in the renderer (TASK-057) keyed by `name`,
because handlers need `tab` / `window.api` access the lib must not have.

## Acceptance Criteria
- [ ] New file `lib/slack-commands.js` with `'use strict'`, a header comment
      explaining the design (mirroring the style of lib/slack-proxy.js), and NO
      require of electron, DOM, or network modules (only `./ticket-lanes` may be
      added later by TASK-058; this ticket needs no requires at all).
- [ ] `normalizeCommandInput(text)`: returns `''` for null/undefined/non-string
      (never throws); otherwise lowercases, trims, collapses runs of internal
      whitespace to single spaces, and strips trailing punctuation (`.`, `!`,
      `?`, `…`) so "Show me   the tasks?" normalizes to "show me the tasks".
- [ ] `matchCommand(text, registry)`: normalizes `text`, then returns the FIRST
      entry (registry order) whose `patterns` contains that normalized string
      (patterns themselves are compared normalized, so a registry author may
      write them in any case). Returns `{ name, command }` on a match and `null`
      otherwise. `registry` defaults to `DEFAULT_COMMANDS`. Never throws for
      null/empty/junk text or a malformed registry entry (entries missing
      `patterns` are skipped).
- [ ] `listCommands(registry)`: returns `[{ name, description }]` in registry
      order (for the future help command); defaults to `DEFAULT_COMMANDS`;
      returns `[]` for a null/empty registry and never throws.
- [ ] `DEFAULT_COMMANDS` is exported and is an empty array in this ticket
      (commands are registered by TASK-058/059/060).
- [ ] `module.exports = { DEFAULT_COMMANDS, normalizeCommandInput, matchCommand, listCommands }`.
- [ ] Ordinary conversation text (e.g. "please fix the tasks page") does NOT
      match any command — matching is exact-phrase after normalization, never
      substring/fuzzy, so nothing meant for Claude is ever intercepted.
- [ ] New unit test file `test/slack-commands.test.js` using `node --test` +
      `node:assert/strict` (same layout as test/slack-proxy.test.js PART 1)
      covering every criterion above with injected registries; the whole suite
      passes via `node --test`.

## Cucumber Tests
```gherkin
Feature: Slack command matching (pure decision core)

  Scenario: A trigger phrase matches its command regardless of case and punctuation
    Given a registry with command "tasks" whose patterns include "show me the tasks"
    When matchCommand is called with "  Show me   the TASKS?! "
    Then it returns the "tasks" command entry

  Scenario: Ordinary conversation is never intercepted
    Given the same registry
    When matchCommand is called with "please fix the tasks page and show me the diff"
    Then it returns null

  Scenario: Registry order decides ties
    Given a registry with command "a" (pattern "go") before command "b" (pattern "go")
    When matchCommand is called with "go"
    Then it returns command "a"

  Scenario: listCommands feeds a future help command
    Given a registry with commands "tasks" and "status" carrying descriptions
    When listCommands is called
    Then it returns [{name:"tasks",…},{name:"status",…}] in registry order

  Scenario: Junk input never throws (failure/edge)
    When normalizeCommandInput and matchCommand are called with null, undefined,
      42, "", "   ", and a registry entry missing its patterns array
    Then no call throws, normalizeCommandInput returns "" for the non-strings,
      and matchCommand returns null in every case
```

## Edge Cases & Failure Paths
- null / undefined / number / object message text → `''` / `null`, never throw.
- Whitespace-only text → no match.
- Registry entry missing `patterns`, or `patterns` containing non-strings → the
  bad entry/pattern is skipped, no throw.
- Empty `DEFAULT_COMMANDS` → `matchCommand` returns null for everything (the
  proxy behaves exactly as today until commands are registered).
- Patterns are matched whole; "show me the tasks now" must NOT match a
  "show me the tasks" pattern (prevents accidental interception).

## Relevant Files & Context
- CREATE `lib/slack-commands.js` — pattern to copy: `lib/slack-proxy.js`
  (pure, 'use strict', rationale header, plain module.exports).
- CREATE `test/slack-commands.test.js` — pattern: PART 1 of
  `test/slack-proxy.test.js` (unit tests, no mocks needed since no I/O).
- READ `renderer/renderer.js` `handleIncomingSlackMessage` (~7807) and
  `decodeSlackText` (~7819): the renderer decodes Slack markup BEFORE any
  matching, so this module receives plain text — do not re-implement decoding.
- Do NOT touch main.js / preload.js — no IPC is involved in this ticket.
- Run tests with `node --test` (the repo's runner; see package.json).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
