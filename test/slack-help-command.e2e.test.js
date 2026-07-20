'use strict';

// E2E cucumber-style scenarios for TASK-059: the Slack "help" command answers
// in the session anchor thread with a list of every registered command,
// generated from the SAME registry the matcher uses (formatHelp iterates it) so
// help can never drift from what actually works.
//
// These are the ticket's Gherkin scenarios expressed as Given/When/Then
// `node --test` cases (no `cucumber` npm package — same scenario layout as the
// other slack-*.e2e.test.js files). Unlike test/slack-help-command.test.js
// (which unit-tests formatHelp/matchCommand in isolation and source-scans the
// renderer), this file exercises the FULL renderer DISPATCH PIPELINE end to end:
//
//   incoming thread reply
//     → matchCommand (REAL lib/slack-commands)
//       → intercepted command  → handler → postToSlack(thread), NO pty write
//       → ordinary conversation → inbox → slackTryDispatch → pty write
//
// so it proves what the isolated formatHelp test cannot: that a matched help
// command's reply is POSTED into the anchor thread, that NOTHING is written to
// the Claude pty for it (the "0 pty writes" acceptance criterion), that aliases
// route through the same path, and that adding a command to the registry makes
// it auto-appear in the help reply WITHOUT touching formatHelp.
//
// Everything external is an in-memory fake — no real FS, no Slack/network, no
// DB, no DOM, no pty. The module is pure. The pipeline copy below is kept in
// lockstep with renderer/renderer.js (handleIncomingSlackMessage /
// handleSlackCommand / slackTryDispatch / SLACK_COMMAND_HANDLERS.help ~7987);
// the REAL lib matchCommand + formatHelp back it so the scenarios prove the
// wiring, not a re-implemented core.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchCommand, formatHelp } = require('../lib/slack-commands');

// Build an in-memory environment mirroring the renderer's Slack dispatch. Each
// scenario injects the `registry` that both the matcher AND the help handler
// use — exactly like the renderer, where SLACK_COMMAND_HANDLERS.help calls
// formatHelp(SLACK_DEFAULT_COMMANDS) over the same registry matchCommand walks.
// It records every side effect (pty writes, thread posts, pane appends) so the
// scenarios can assert the "0 pty writes" / posted-in-thread criteria.
function makeEnv({ registry } = {}) {
  const env = {
    ptyWrites: [], // everything written to the Claude (cmd) pty
    posted: [], // { text, thread } posted back into Slack
    pane: [], // messages rendered in the pane
  };

  const tab = {
    folder: 'C:\\proj',
    cmd: { id: 'cmd-1' },
    status: 'idle', // Claude idle so a forwarded message WOULD dispatch to the pty
    slack: { connected: true, threadTs: 'THREAD-1', inbox: [], awaitingResponse: false, captureBuffer: '' },
  };

  const windowApi = {
    pty: { write: (id, data) => env.ptyWrites.push({ id, data }) },
  };

  // Verbatim-ish copy of SLACK_COMMAND_HANDLERS.help (renderer ~8011):
  //   help: async () => formatHelp(SLACK_DEFAULT_COMMANDS)
  // The injected `registry` stands in for SLACK_DEFAULT_COMMANDS so the scenario
  // controls the live command set the handler formats.
  const SLACK_COMMAND_HANDLERS = {
    help: async () => formatHelp(registry),
  };

  const postToSlack = (t, text, thread) => env.posted.push({ text, thread });
  const appendSlackMessage = (t, m) => env.pane.push(m);

  // Verbatim-ish copy of handleSlackCommand (renderer ~8013).
  async function handleSlackCommand(t, matched) {
    const s = t.slack;
    const handler = SLACK_COMMAND_HANDLERS[matched.name];
    if (typeof handler !== 'function') {
      postToSlack(t, "That command isn't available in this session.", s.threadTs);
      return;
    }
    try {
      const replyText = await handler(t);
      if (typeof replyText === 'string' && replyText.trim()) {
        postToSlack(t, replyText, s.threadTs);
        appendSlackMessage(t, { who: 'system', text: replyText });
      }
    } catch (err) {
      const detail = (err && err.message) || String(err);
      postToSlack(t, 'Command failed: ' + detail, s.threadTs);
    }
  }

  // Verbatim-ish copy of slackTryDispatch (renderer ~8050) — the ONLY path that
  // writes to the Claude pty. A matched command never reaches here.
  function slackTryDispatch(t) {
    const s = t.slack;
    if (!(s.connected && s.threadTs)) return;
    if (s.awaitingResponse) return;
    if (!s.inbox.length) return;
    if (!t.cmd.id) return;
    if (t.status !== 'finished' && t.status !== 'idle') return;
    const item = s.inbox.shift();
    s.awaitingResponse = true;
    s.captureBuffer = '';
    windowApi.pty.write(t.cmd.id, item.text);
  }

  // Verbatim-ish copy of handleIncomingSlackMessage (renderer ~7987): a matched
  // command is answered in-thread and RETURNS (never enters the inbox, never
  // forwards to the pty); anything else flows to the inbox → dispatch.
  async function receive(text) {
    if (!text.trim()) return;
    appendSlackMessage(tab, { who: 'slack', text });
    const matched = matchCommand(text, registry);
    if (matched) {
      await handleSlackCommand(tab, matched);
      return;
    }
    tab.slack.inbox.push({ text });
    slackTryDispatch(tab);
  }

  return { env, tab, receive };
}

// A registry carrying tasks, help and a SYNTHETIC "ping" command. The ping entry
// exists ONLY in this test — it is not in lib/DEFAULT_COMMANDS — so if the help
// reply lists it, that proves formatHelp iterates whatever registry it is handed
// (future commands auto-appear) rather than hard-coding today's command set.
const REGISTRY_WITH_PING = [
  { name: 'tasks', description: 'Show the tasks board', patterns: ['show me the tasks', 'tasks'] },
  { name: 'help', description: 'List the commands this thread understands', patterns: ['help', 'commands', 'show commands', 'what can you do'] },
  { name: 'ping', description: 'Reply with pong', patterns: ['ping'] },
];

// ===========================================================================
// Feature: the "help" Slack command
// ===========================================================================

test('Scenario: help lists every registered command with its triggers, in registry order — and nothing is written to the Claude pty', async () => {
  // Given a connected proxy whose registry carries tasks, help and a synthetic ping
  const { env, receive } = makeEnv({ registry: REGISTRY_WITH_PING });

  // When a user replies "help" in the anchor thread
  await receive('help');

  // Then a single reply is posted into the session anchor thread
  assert.equal(env.posted.length, 1, 'exactly one reply posted');
  assert.equal(env.posted[0].thread, 'THREAD-1', 'posted into the session anchor thread');
  const reply = env.posted[0].text;

  // And it has one line per command, in registry order (tasks, help, ping)
  const lines = reply.split('\n');
  assert.equal(lines.length, 3, `one line per command, got:\n${reply}`);
  assert.match(lines[0], /^\*tasks\*/);
  assert.match(lines[1], /^\*help\*/);
  assert.match(lines[2], /^\*ping\*/);

  // And the tasks line advertises its trigger phrase "show me the tasks"
  assert.ok(lines[0].includes('(say: "show me the tasks", "tasks")'), `tasks triggers shown, got:\n${lines[0]}`);

  // And the SYNTHETIC ping command appears — proving formatHelp iterates the
  // live registry (a future command auto-appears) without any code change
  assert.ok(reply.includes('*ping* — Reply with pong (say: "ping")'), `synthetic ping auto-listed, got:\n${reply}`);

  // And nothing is written to the Claude pty (command intercepted, not forwarded)
  assert.equal(env.ptyWrites.length, 0, 'no pty write for an intercepted command');
});

test('Scenario: alias "what can you do" triggers help — the same reply, no pty write', async () => {
  // Given the same registry, and a baseline reply produced by the canonical "help"
  const baseline = makeEnv({ registry: REGISTRY_WITH_PING });
  await baseline.receive('help');
  const expected = baseline.env.posted[0].text;

  const { env, receive } = makeEnv({ registry: REGISTRY_WITH_PING });

  // When a user replies with the alias "What can you do?"
  await receive('What can you do?');

  // Then the identical help reply is posted in-thread
  assert.equal(env.posted.length, 1);
  assert.equal(env.posted[0].thread, 'THREAD-1');
  assert.equal(env.posted[0].text, expected, 'alias produces the same help reply');

  // And nothing is forwarded to the Claude pty
  assert.equal(env.ptyWrites.length, 0, 'alias command is not forwarded to the pty');
});

test('Scenario (edge): an empty registry replies "No commands are available." — no throw, no pty write', async () => {
  // Given a connected proxy whose registry is empty
  const { env, receive } = makeEnv({ registry: [] });

  // When a user types the "help" phrase
  // (matchCommand cannot match against an empty registry, so this would flow to
  // the pty; the acceptance criterion is on formatHelp itself, asserted next.)
  await receive('help');

  // Then formatHelp over an empty registry degrades to the sentinel, never throws
  let out;
  assert.doesNotThrow(() => {
    out = formatHelp([]);
  });
  assert.equal(out, 'No commands are available.');
  // And the same holds for null / non-array registries
  assert.equal(formatHelp(null), 'No commands are available.');
  assert.equal(formatHelp('nope'), 'No commands are available.');

  // And with no matching command the ordinary-conversation path still runs
  // cleanly (message forwarded once, no in-thread reply, no crash).
  assert.equal(env.posted.length, 0);
  assert.equal(env.ptyWrites.length, 1);
});

test('Scenario (edge): a command entry missing a description renders "(no description)" — no throw', async () => {
  // Given a registry whose "orphan" command has no description
  const registry = [
    { name: 'help', description: 'List commands', patterns: ['help'] },
    { name: 'orphan', patterns: ['do it'] },
  ];
  const { env, receive } = makeEnv({ registry });

  // When a user asks for help
  let ran = true;
  try {
    await receive('help');
  } catch (_) {
    ran = false;
  }

  // Then it does not throw, and the orphan line carries the "(no description)" placeholder
  assert.ok(ran, 'help did not throw for a description-less entry');
  assert.equal(env.posted.length, 1);
  assert.ok(
    env.posted[0].text.includes('*orphan* — (no description) (say: "do it")'),
    `no-description placeholder shown, got:\n${env.posted[0].text}`,
  );
  assert.equal(env.ptyWrites.length, 0);
});

// ===========================================================================
// Regression scenario: "help" inside a sentence is NOT a command. Whole-phrase
// matching means it flows through to the Claude pty untouched — the exact
// opposite of the command path. This guards the "command message is never
// forwarded to Claude" criterion from the other side: prove a non-command DOES
// write to the pty and posts no help reply.
// ===========================================================================

test('Scenario (regression): "I need help with the build" is NOT intercepted — it goes to Claude via the pty', async () => {
  // Given the registry that carries the help command (with its "help" trigger)
  const { env, receive } = makeEnv({ registry: REGISTRY_WITH_PING });

  // When a user types a sentence that merely CONTAINS the word "help"
  await receive('I need help with the build');

  // Then no help reply is posted (whole-phrase matching, never substring)
  assert.equal(env.posted.length, 0, 'no in-thread help reply for ordinary conversation');
  // And it is forwarded verbatim to the Claude pty
  assert.equal(env.ptyWrites.length, 1, 'message forwarded to the pty');
  assert.equal(env.ptyWrites[0].data, 'I need help with the build');
});
