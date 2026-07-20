---
id: TASK-059
title: Slack command "help" — list available thread commands in-thread
status: done
created: 2026-07-19T00:00:00Z
updated: 2026-07-19T20:12:00Z
---

## Description
Add a `help` command so a Slack user can discover what the session thread
understands. Typing "help" (or an alias) in the anchor thread posts a reply
listing every registered command with its description and trigger phrases,
generated from the SAME registry the matcher uses (`listCommands` from
TASK-056) so the help text can never drift from reality. Pure formatting lives
in `lib/slack-commands.js`; the renderer handler is one line thanks to the
TASK-057 plumbing.

## Acceptance Criteria
- [ ] `lib/slack-commands.js`: `DEFAULT_COMMANDS` gains entry
      `{ name: 'help', description: 'List the commands this thread understands', patterns: ['help', 'commands', 'show commands', 'what can you do'] }`.
- [ ] `lib/slack-commands.js`: new export `formatHelp(registry)` — defaults to
      `DEFAULT_COMMANDS`; returns mrkdwn with one line per command:
      `*<name>* — <description> (say: "<pattern1>", "<pattern2>", …)` in
      registry order; entries missing a description render with "(no
      description)"; an empty/null registry returns
      "No commands are available."; never throws.
- [ ] The help output automatically includes every command registered by other
      tickets (tasks, status, help itself) — proven by a test that registers a
      synthetic extra command and sees it appear without touching formatHelp.
- [ ] Renderer: mirror the entry + `formatHelp` verbatim ("Mirrors
      lib/slack-commands.js" comment) and add
      `SLACK_COMMAND_HANDLERS.help = async () => formatHelp(SLACK_DEFAULT_COMMANDS)`.
- [ ] Reply is posted into the anchor thread via TASK-057 plumbing; the message
      is never forwarded to Claude; works while Claude is busy.
- [ ] Unit tests in `test/slack-commands.test.js` for formatHelp (order,
      aliases shown, empty registry, missing description) and matching of all
      four trigger phrases; source-scan for the renderer mirror + handler.
      `node --test` passes.

## Cucumber Tests
```gherkin
Feature: "help" Slack command

  Scenario: Help lists every registered command with its triggers
    Given the registry contains tasks, help and a synthetic command "ping"
    When a user replies "help" in the anchor thread
    Then a reply is posted into the thread with one line per command in registry order
    And the "tasks" line includes the phrase "show me the tasks"
    And the "ping" line appears without any change to formatHelp
    And nothing is written to the Claude pty

  Scenario: Alias phrases trigger help
    When a user replies "What can you do?" in the anchor thread
    Then the same help reply is posted

  Scenario: Empty registry (failure/edge)
    Given an empty registry
    When formatHelp runs
    Then it returns "No commands are available." and does not throw

  Scenario: Command entry missing a description (edge)
    Given a registry entry with a name but no description
    When formatHelp runs
    Then that line renders "(no description)" and formatting does not throw
```

## Edge Cases & Failure Paths
- Empty or null registry → fixed friendly string, no throw.
- Entry with missing/empty `description` or `patterns` → placeholder text /
  omitted "(say: …)" suffix, no throw.
- "help" must not be matched inside larger sentences ("I need help with the
  build" goes to Claude) — exact-phrase matching from TASK-056 guarantees this;
  add an explicit regression test.
- Post failure → existing postToSlack error surfacing (TASK-057 path).

## Relevant Files & Context
- EDIT `lib/slack-commands.js` (entry + `formatHelp`, export it).
- EDIT `renderer/renderer.js` (mirror + one handler entry in
  `SLACK_COMMAND_HANDLERS`, near the TASK-057 block).
- EDIT `test/slack-commands.test.js`; source-scan additions follow
  `test/slack-thread-replies.test.js` PART 2 style. Runner: `node --test`.
- Depends on: TASK-056, TASK-057 (and lands after TASK-058 so its help line is
  covered by the "includes every registered command" test, though it does not
  strictly require 058's code).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
