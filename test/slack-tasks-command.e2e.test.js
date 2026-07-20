'use strict';

// E2E cucumber-style scenarios for TASK-058: the Slack "show me the tasks"
// command answers in the session anchor thread with the live tasks board.
//
// These are the ticket's Gherkin scenarios expressed as Given/When/Then
// `node --test` cases (no `cucumber` npm package — same scenario layout as the
// other slack-*.e2e.test.js files). Unlike test/slack-tasks-command.test.js
// (which unit-tests the handler in isolation and source-scans the renderer),
// this file exercises the FULL renderer DISPATCH PIPELINE end to end:
//
//   incoming thread reply
//     → matchCommand (REAL lib/slack-commands)
//       → intercepted command  → handler → postToSlack(thread), NO pty write
//       → ordinary conversation → inbox → slackTryDispatch → pty write
//
// so it proves the two behaviours the isolated handler test cannot: that a
// matched command's reply is POSTED into the anchor thread and that NOTHING is
// written to the Claude pty for it (the "0 pty writes" acceptance criterion),
// and that the aliases route through the same path.
//
// Everything external is an in-memory fake — no real FS, no Slack/network, no
// DB, no DOM, no pty. The pipeline copy below is kept in lockstep with
// renderer/renderer.js (handleIncomingSlackMessage / handleSlackCommand /
// slackTryDispatch / SLACK_COMMAND_HANDLERS.tasks ~7952–8078); the REAL lib
// matchCommand + DEFAULT_COMMANDS + formatTasksSummary back it so the scenarios
// prove the wiring, not a re-implemented core.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_COMMANDS, matchCommand, formatTasksSummary } = require('../lib/slack-commands');

// Build an in-memory environment mirroring the renderer's Slack dispatch. It
// records every side effect (pty writes, thread posts, pane appends) so the
// scenarios can assert on them, and lets each scenario seed the board that the
// forced poll "loads".
function makeEnv({ folder = 'C:\\proj', existsResult = { ok: true, exists: true }, existsThrows = false, seedTickets } = {}) {
  const env = {
    ptyWrites: [], // everything written to the Claude (cmd) pty
    posted: [], // { text, thread } posted back into Slack
    pane: [], // messages rendered in the pane
    existsArg: null,
    pollForce: null,
    pollCount: 0,
  };

  const tab = {
    folder,
    cmd: { id: 'cmd-1' },
    status: 'idle', // Claude idle so a forwarded message WOULD dispatch to the pty
    tasks: { tickets: new Map() },
    slack: { connected: true, threadTs: 'THREAD-1', inbox: [], awaitingResponse: false, captureBuffer: '' },
  };

  const windowApi = {
    fs: {
      exists: async (p) => {
        env.existsArg = p;
        if (existsThrows) throw new Error('exists boom');
        return existsResult;
      },
    },
    pty: {
      write: (id, data) => env.ptyWrites.push({ id, data }),
    },
  };
  const tasksJoin = (...parts) => parts.join('\\');

  // The forced poll is what (re)loads the board — proving read-after-poll.
  const pollTasksOnce = async (t, force) => {
    env.pollForce = force;
    env.pollCount += 1;
    t.tasks.tickets.clear();
    if (typeof seedTickets === 'function') seedTickets(t.tasks.tickets);
  };

  // Verbatim-ish copy of SLACK_COMMAND_HANDLERS.tasks (renderer ~7958).
  const SLACK_COMMAND_HANDLERS = {
    tasks: async (t) => {
      if (!t.folder) return 'No project folder is open.';
      let exists = false;
      try {
        const res = await windowApi.fs.exists(tasksJoin(t.folder, 'tasks'));
        exists = !!(res && res.ok && res.exists);
      } catch (_) {
        exists = false;
      }
      if (!exists) return 'No tasks board found in this project.';
      await pollTasksOnce(t, true);
      return formatTasksSummary(Array.from(t.tasks.tickets.values()));
    },
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
    const matched = matchCommand(text, DEFAULT_COMMANDS);
    if (matched) {
      await handleSlackCommand(tab, matched);
      return;
    }
    tab.slack.inbox.push({ text });
    slackTryDispatch(tab);
  }

  return { env, tab, receive };
}

// Seed helpers ---------------------------------------------------------------

const seedActiveBoard = (map) => {
  // Same wrapper shape the poll produces: Map of file → { fm, ... }.
  map.set('TASK-101.md', { fm: { id: 'TASK-101', title: 'API', status: 'in-progress' } });
  map.set('TASK-102.md', { fm: { id: 'TASK-102', title: 'UI', status: 'testing' } });
  map.set('TASK-103.md', { fm: { id: 'TASK-103', title: 'Docs', status: 'todo' } });
};

// ===========================================================================
// Feature: "show me the tasks" Slack command
// ===========================================================================

test('Scenario: active work is reported from the live board — and nothing is written to the Claude pty', async () => {
  // Given a connected proxy and a board with TASK-101 "API" in-progress,
  // TASK-102 "UI" testing, and TASK-103 "Docs" todo
  const { env, receive } = makeEnv({ seedTickets: seedActiveBoard });

  // When a user replies "Show me the tasks?" in the anchor thread
  await receive('Show me the tasks?');

  // Then a single reply is posted into the anchor thread
  assert.equal(env.posted.length, 1, 'exactly one reply posted');
  assert.equal(env.posted[0].thread, 'THREAD-1', 'posted into the session anchor thread');
  const reply = env.posted[0].text;
  // containing the active tickets
  assert.ok(reply.includes('TASK-101 — API (in-progress)'), 'lists the in-progress ticket');
  assert.ok(reply.includes('TASK-102 — UI (testing)'), 'lists the testing ticket');
  // And the counts line reports todo 1, in-progress 1, testing 1
  assert.ok(
    reply.includes('todo 1 · defining 0 · in-progress 1 · testing 1 · post-processing 0 · done 0'),
    `counts line present, got:\n${reply}`,
  );
  // And nothing is written to the Claude pty (command intercepted, not forwarded)
  assert.equal(env.ptyWrites.length, 0, 'no pty write for an intercepted command');
  // And the forced poll ran (board refreshed before formatting)
  assert.equal(env.pollForce, true, 'board force-polled before formatting');
});

test('Scenario: alias phrases trigger the same command', async () => {
  // Given the same active board
  const { env, receive } = makeEnv({ seedTickets: seedActiveBoard });

  // When a user replies "what are you working on" in the anchor thread
  await receive('what are you working on');

  // Then the same tasks summary reply is posted (same active lines), no pty write
  assert.equal(env.posted.length, 1);
  const reply = env.posted[0].text;
  assert.ok(reply.includes('TASK-101 — API (in-progress)'));
  assert.ok(reply.includes('TASK-102 — UI (testing)'));
  assert.equal(env.ptyWrites.length, 0, 'alias command is not forwarded to the pty');
});

test('Scenario: alias "list tasks" also routes to the tasks command', async () => {
  // Given the same active board (extra alias coverage over the registry)
  const { env, receive } = makeEnv({ seedTickets: seedActiveBoard });

  // When a user replies with the "list tasks" alias
  await receive('list tasks');

  // Then the tasks summary is posted in-thread with no pty write
  assert.equal(env.posted.length, 1);
  assert.ok(env.posted[0].text.includes('TASK-101 — API (in-progress)'));
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario: nothing active — all tickets todo or done', async () => {
  // Given a board whose tickets are all todo or done
  const { env, receive } = makeEnv({
    seedTickets: (map) => {
      map.set('TASK-001.md', { fm: { id: 'TASK-001', title: 'Setup', status: 'done' } });
      map.set('TASK-002.md', { fm: { id: 'TASK-002', title: 'Idea', status: 'todo' } });
    },
  });

  // When the tasks command runs
  await receive('show me the tasks');

  // Then the reply contains the idle sentinel and no "Failed testing:" section
  const reply = env.posted[0].text;
  assert.ok(reply.includes('Nothing is being worked on right now.'));
  assert.ok(!reply.includes('*Failed testing:*'));
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (edge): failed-testing is surfaced, not hidden', async () => {
  // Given a board with TASK-104 in failed-testing
  const { env, receive } = makeEnv({
    seedTickets: (map) => {
      map.set('TASK-104.md', { fm: { id: 'TASK-104', title: 'Flaky', status: 'failed-testing' } });
      map.set('TASK-105.md', { fm: { id: 'TASK-105', title: 'Other', status: 'todo' } });
    },
  });

  // When the tasks command runs
  await receive('tasks');

  // Then the reply lists TASK-104 under "Failed testing:"
  const reply = env.posted[0].text;
  assert.ok(reply.includes('*Failed testing:*'), 'has a failed-testing section');
  assert.ok(reply.includes('TASK-104 — Flaky (failed-testing)'), 'lists the failed ticket');
  // failed-testing folds into the testing lane count (never its own column)
  assert.ok(reply.includes('testing 1'), 'failed-testing counted in the testing lane');
});

test('Scenario (edge): empty board — a forced poll that loads no parseable tickets', async () => {
  // Given a tasks/ folder with no parseable tickets (poll leaves an empty map)
  const { env, receive } = makeEnv({ seedTickets: () => {} });

  // When the tasks command runs
  await receive('show tasks');

  // Then the reply is exactly the empty-board sentinel — never a throw
  assert.equal(env.posted.length, 1);
  assert.equal(env.posted[0].text, 'The tasks board is empty.');
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (failure): no project folder open', async () => {
  // Given no project folder is open
  const { env, receive } = makeEnv({ folder: null });

  // When the tasks command runs
  await receive('show me the tasks');

  // Then the reply is "No project folder is open." and nothing hits the pty
  assert.equal(env.posted[0].text, 'No project folder is open.');
  assert.equal(env.ptyWrites.length, 0);
  assert.equal(env.pollForce, null, 'never polls without a folder');
});

test('Scenario (failure): a folder without a tasks/ directory', async () => {
  // Given a folder without a tasks/ directory
  const { env, receive } = makeEnv({ existsResult: { ok: true, exists: false } });

  // When the tasks command runs
  await receive('show me the tasks');

  // Then the reply is "No tasks board found in this project."
  assert.equal(env.posted[0].text, 'No tasks board found in this project.');
  assert.equal(env.existsArg, 'C:\\proj\\tasks', 'checked the tasks dir');
  assert.equal(env.pollForce, null, 'no poll when the board directory is absent');
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (failure/edge): exists() rejecting is treated as absent — no throw', async () => {
  // Given the exists probe rejects (transient FS error)
  const { env, receive } = makeEnv({ existsThrows: true });

  // When the tasks command runs
  await receive('show me the tasks');

  // Then it degrades to "No tasks board found in this project." rather than crashing
  assert.equal(env.posted[0].text, 'No tasks board found in this project.');
  assert.equal(env.pollForce, null);
});

test('Scenario (failure): a malformed ticket never crashes the formatter', () => {
  // Given a board containing a ticket with no id and no title
  const board = [{ fm: { status: 'in-progress' } }];

  // When formatTasksSummary runs
  let out;
  assert.doesNotThrow(() => {
    out = formatTasksSummary(board);
  });

  // Then it returns text containing "(no id)" and "(untitled)" and does not throw
  assert.ok(out.includes('(no id) — (untitled) (in-progress)'), `got:\n${out}`);
});

// ===========================================================================
// Negative pipeline scenario: ordinary conversation is NOT intercepted — it is
// forwarded to the Claude pty (the exact opposite of the command path). This
// guards the "command message is never forwarded to Claude" criterion from the
// other side: prove a non-command DOES write to the pty and posts no reply.
// ===========================================================================

test('Scenario: ordinary conversation flows through to the Claude pty (not intercepted)', async () => {
  // Given an active board and a message that merely mentions "tasks"
  const { env, receive } = makeEnv({ seedTickets: seedActiveBoard });

  // When a user types a sentence that is not a whole-phrase command
  await receive('please fix the tasks page and show me the diff');

  // Then it is forwarded to the Claude pty and no tasks summary is posted
  assert.equal(env.ptyWrites.length, 1, 'message forwarded to the pty');
  assert.equal(env.ptyWrites[0].data, 'please fix the tasks page and show me the diff');
  assert.equal(env.posted.length, 0, 'no in-thread command reply for ordinary conversation');
});
