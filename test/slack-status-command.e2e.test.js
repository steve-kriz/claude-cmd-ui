'use strict';

// TASK-060 — E2E (cucumber-style Given/When/Then) scenarios for the Slack
// "status" command. These implement the ticket's Gherkin against a faithful,
// FULLY IN-MEMORY model of the renderer's incoming-Slack routing:
//
//     handleIncomingSlackMessage → matchCommand → (matched) status handler,
//     which posts a reply into the SAME thread and NEVER writes to Claude's pty;
//     (unmatched) the text lands in the inbox and is forwarded to the pty.
//
// Everything external is mocked in-memory — NO real DB / FS / Slack / network /
// pty. The board poll (pollTasksOnce) is a fake, the ticket board is an in-memory
// Map, "post to Slack" and "pty write" are recording spies. The REAL lib
// matchCommand + formatStatusReply back the harness so the scenarios prove the
// wiring, not a re-implemented core.
//
// Mirrors renderer/renderer.js:
//   - handleIncomingSlackMessage (lines ~8084): match → handler+return, else inbox
//   - SLACK_COMMAND_HANDLERS.status (lines ~8046): gather info, force-poll,
//     try/catch → null, count TASKS_ACTIVE_STATUSES tickets, formatStatusReply
//   - handleSlackCommand posts the reply back to the thread (never to pty)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchCommand, formatStatusReply } = require('../lib/slack-commands');

// The renderer's active-status mirror the handler counts against.
const TASKS_ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];

// ---------------------------------------------------------------------------
// In-memory world: a fake tab + recording spies for every external effect.
// ---------------------------------------------------------------------------
function makeWorld({ folder, status, transport, inbox, tickets, pollThrows }) {
  const spies = { ptyWrites: [], slackPosts: [], pollForce: null, pollCount: 0 };

  const tab = {
    folder: folder ?? null,
    status,
    slack: { transport, inbox, threadTs: 'T1' },
    tasks: { tickets: tickets || new Map() },
  };

  // Fake board poll — records the force flag, optionally throws. No FS/network.
  const pollTasksOnce = async (_t, force) => {
    spies.pollForce = force;
    spies.pollCount += 1;
    if (pollThrows) throw new Error('board read boom');
  };

  // Recording spies for the two possible outward effects.
  const postToSlack = (_tab, text) => spies.slackPosts.push(text);
  const ptyWrite = (data) => spies.ptyWrites.push(data);

  // Verbatim-faithful copy of SLACK_COMMAND_HANDLERS.status (renderer ~8046).
  const statusHandler = async (t) => {
    let activeTickets = null;
    if (t.folder) {
      try {
        await pollTasksOnce(t, true);
        activeTickets = 0;
        for (const tk of t.tasks.tickets.values()) {
          if (tk && tk.fm && TASKS_ACTIVE_STATUSES.includes(tk.fm.status)) activeTickets += 1;
        }
      } catch (_) {
        activeTickets = null;
      }
    }
    const info = {
      folder: t.folder,
      claudeState: t.status,
      transport: t.slack.transport,
      queued: (t.slack.inbox || []).length,
      activeTickets,
    };
    return formatStatusReply(info);
  };

  const HANDLERS = { status: statusHandler };

  // Faithful copy of handleIncomingSlackMessage routing (renderer ~8084):
  // matched command → run handler, post reply to thread, RETURN (no pty write);
  // unmatched → push to inbox and forward to the pty.
  async function receive(text) {
    const matched = matchCommand(text);
    if (matched) {
      const reply = await HANDLERS[matched.name](tab);
      if (typeof reply === 'string' && reply.trim()) postToSlack(tab, reply);
      return { routedTo: 'command', matched: matched.name, reply };
    }
    tab.slack.inbox.push({ text });
    ptyWrite(text + '\r'); // the inbox is drained to Claude's pty
    return { routedTo: 'pty', matched: null, reply: null };
  }

  return { tab, spies, receive };
}

// ===========================================================================
// SCENARIO 1 — Status while Claude is busy (polling transport, work in flight)
// ===========================================================================
test('E2E Scenario: status while busy over polling, 2 queued, 1 in-progress ticket', async () => {
  // GIVEN a project folder is open, Claude is busy, the transport is polling,
  // two messages are queued and exactly one ticket is in-progress
  const tickets = new Map([
    ['a.md', { fm: { status: 'in-progress' } }],
    ['b.md', { fm: { status: 'done' } }],
    ['c.md', { fm: { status: 'todo' } }],
  ]);
  const w = makeWorld({
    folder: 'C:\\proj', status: 'busy', transport: 'poll',
    inbox: [{ text: 'earlier one' }, { text: 'earlier two' }], tickets,
  });

  // WHEN the user says "status" in the anchor thread
  const res = await w.receive('status');

  // THEN it is answered as a command (never forwarded to Claude)
  assert.equal(res.routedTo, 'command');
  assert.equal(res.matched, 'status');
  // AND the board was force-polled before the reply was built
  assert.equal(w.spies.pollForce, true, 'force-polled the board');
  // AND the reply reports busy, polling, the queue depth and the active count
  assert.ok(res.reply.includes('Claude: busy'), 'reports busy');
  assert.ok(res.reply.includes('polling'), 'reports polling transport');
  assert.ok(res.reply.includes('Queued: 2'), 'reports queue depth 2');
  assert.ok(res.reply.includes('Active tickets: 1'), 'reports 1 active ticket');
  // AND the reply was posted back into the same thread
  assert.deepEqual(w.spies.slackPosts, [res.reply]);
  // AND ZERO pty writes occurred — a command never reaches Claude
  assert.equal(w.spies.ptyWrites.length, 0, '0 pty writes for a command');
});

// ===========================================================================
// SCENARIO 2 — Status while idle over Socket Mode with an empty queue
// ===========================================================================
test('E2E Scenario: status while idle over Socket Mode, empty inbox', async () => {
  // GIVEN a folder is open, Claude is idle, the transport is Socket Mode and
  // nothing is queued
  const w = makeWorld({
    folder: 'C:\\proj', status: 'idle', transport: 'socket',
    inbox: [], tickets: new Map(),
  });

  // WHEN the user says "show status"
  const res = await w.receive('show status');

  // THEN the reply reports idle, Socket Mode and an empty queue
  assert.equal(res.routedTo, 'command');
  assert.ok(res.reply.includes('Claude: idle'), 'reports idle');
  assert.ok(res.reply.includes('Socket Mode'), 'reports Socket Mode transport');
  assert.ok(res.reply.includes('Queued: 0'), 'reports empty queue');
  // AND no pty write occurred
  assert.equal(w.spies.ptyWrites.length, 0, '0 pty writes for a command');
});

// ===========================================================================
// SCENARIO 3 — No folder open
// ===========================================================================
test('E2E Scenario: status with no folder open → "(no folder open)" and unknown active count', async () => {
  // GIVEN no project folder is open
  const w = makeWorld({
    folder: null, status: 'idle', transport: 'socket', inbox: [],
  });

  // WHEN the user says "what's your status"
  const res = await w.receive("what's your status");

  // THEN the reply notes there is no folder and cannot know the active count
  assert.equal(res.routedTo, 'command');
  assert.ok(res.reply.includes('(no folder open)'), 'notes no folder open');
  assert.ok(res.reply.includes('Active tickets: unknown'), 'active count unknown');
  // AND the board was never polled (no folder to read)
  assert.equal(w.spies.pollForce, null, 'no poll without a folder');
  assert.equal(w.spies.pollCount, 0, 'poll never attempted');
  // AND no pty write occurred
  assert.equal(w.spies.ptyWrites.length, 0, '0 pty writes for a command');
});

// ===========================================================================
// SCENARIO 4 — Board read failure during the handler (edge / failure path)
// ===========================================================================
test('E2E Scenario (edge): board read failure → reply still returns with unknown active count, no crash', async () => {
  // GIVEN a folder is open but the board poll will throw
  const w = makeWorld({
    folder: 'C:\\proj', status: 'busy', transport: 'poll', inbox: [{ text: 'q' }],
    pollThrows: true,
  });

  // WHEN the user says "are you busy"
  let res;
  await assert.doesNotReject(async () => { res = await w.receive('are you busy'); }, 'handler never crashes');

  // THEN the reply still comes back, with the active count as unknown
  assert.equal(res.routedTo, 'command');
  assert.ok(res.reply.includes('Active tickets: unknown'), 'unknown active count on failure');
  // AND the busy state / queue are still reported from live state
  assert.ok(res.reply.includes('Claude: busy'));
  assert.ok(res.reply.includes('Queued: 1'));
  // AND the poll was actually attempted (then swallowed)
  assert.equal(w.spies.pollForce, true, 'attempted the force poll');
  // AND still no pty write
  assert.equal(w.spies.ptyWrites.length, 0, '0 pty writes even on failure');
});

// ===========================================================================
// SCENARIO 5 — Partial / empty info to formatStatusReply (never throws)
// ===========================================================================
test('E2E Scenario (edge): formatStatusReply with empty/partial/null-ish info yields a well-formed reply, no throw', () => {
  // GIVEN wholly missing, empty and non-object info values
  const inputs = [undefined, null, {}, 'nope', 42, { folder: '', queued: NaN, activeTickets: null }];

  for (const info of inputs) {
    // WHEN the reply is formatted
    let out;
    assert.doesNotThrow(() => { out = formatStatusReply(info); }, `no throw for ${JSON.stringify(info)}`);
    // THEN it is a well-formed 6-line snapshot with every placeholder present
    const lines = out.split('\n');
    assert.equal(lines.length, 6, 'always 6 mrkdwn lines');
    assert.equal(lines[0], '*Session status*');
    assert.ok(out.includes('Folder: '), 'has a folder line');
    assert.ok(out.includes('Claude: idle'), 'defaults to idle');
    assert.ok(out.includes('Transport: none'), 'defaults to none');
    assert.ok(out.includes('Queued: 0'), 'defaults queue to 0');
    assert.ok(out.includes('Active tickets: unknown'), 'defaults active to unknown');
  }
});

// ===========================================================================
// SCENARIO 6 — Command matching: exact-phrase, not substring
// ===========================================================================
test('E2E Scenario: "are you busy" is a command but "are you busy with the build" goes to Claude', async () => {
  // GIVEN a folder is open (so a matched command would poll)
  const w = makeWorld({
    folder: 'C:\\proj', status: 'idle', transport: 'socket', inbox: [], tickets: new Map(),
  });

  // WHEN the user says the exact phrase "are you busy"
  const cmd = await w.receive('are you busy');
  // THEN it is handled as the status command (posted to thread, no pty write)
  assert.equal(cmd.routedTo, 'command');
  assert.equal(cmd.matched, 'status');
  assert.equal(w.spies.ptyWrites.length, 0, 'command produced no pty write');
  assert.equal(w.spies.slackPosts.length, 1, 'command posted a reply');

  // WHEN instead the user says "are you busy with the build" (a conversation)
  const chat = await w.receive('are you busy with the build');
  // THEN it is NOT a command — it is forwarded to Claude's pty and queued
  assert.equal(chat.routedTo, 'pty');
  assert.equal(chat.matched, null);
  assert.equal(w.spies.ptyWrites.length, 1, 'conversation reached the pty');
  assert.deepEqual(w.spies.ptyWrites, ['are you busy with the build\r']);
  assert.equal(w.tab.slack.inbox.length, 1, 'conversation queued to the inbox');
});

test('E2E Scenario: "what\'s your status" (with trailing punctuation) still matches the command', async () => {
  // GIVEN a folder is open
  const w = makeWorld({
    folder: 'C:\\proj', status: 'idle', transport: 'poll', inbox: [], tickets: new Map(),
  });
  // WHEN the user asks "What's your status?" with capitalisation + trailing "?"
  const res = await w.receive("What's your status?");
  // THEN normalization still resolves it to the status command
  assert.equal(res.routedTo, 'command');
  assert.equal(res.matched, 'status');
  assert.equal(w.spies.ptyWrites.length, 0);
});
