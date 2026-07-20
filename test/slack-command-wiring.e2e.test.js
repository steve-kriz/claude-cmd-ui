'use strict';

// ===========================================================================
// TASK-057 — E2E (cucumber-style) scenarios for the Slack thread-command
// interception wiring in renderer/renderer.js.
//
// These are Given/When/Then `node --test` scenarios (no cucumber npm package).
// The browser-side renderer cannot be require()'d, so this harness re-creates
// the REAL inbound pipeline VERBATIM from renderer.js —
//
//     ingestSlackMessage
//       → slackShouldDispatchIncoming   (bot-self + seenTs loop guard + thread)
//       → handleIncomingSlackMessage    (append → matchCommand → inbox/dispatch)
//       → handleSlackCommand            (unknown / reply / empty / throw paths)
//       → slackTryDispatch              (idle gate + pty write + Enter)
//
// and drives it through the pure command matcher, which is the REAL
// lib/slack-commands.js implementation (proving the WIRING, not a re-impl).
//
// ALL I/O is faked in-memory: the Claude pty is a write-recording fake, Slack
// posting is an in-memory capture, and the "poller" is just a function call.
// There are NO real Slack, pty, or network connections anywhere.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCommandInput, matchCommand } = require('../lib/slack-commands');

const QUEUE_ENTER_DELAY_MS = 0; // real code uses a small delay; 0 keeps tests fast

// Wait for scheduled Enter writes / async command posts to settle.
const flush = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// Harness — verbatim mirror of the renderer's inbound Slack pipeline, with
// every external effect replaced by an in-memory fake.
// ---------------------------------------------------------------------------
function makeHarness(registry, handlers, opts = {}) {
  const ptyWrites = []; // [{ id, data }] — every write to the fake Claude pty
  const posts = [];     // [{ text, threadTs }] — every Slack post
  const paneRows = [];  // every message appended to the Slack pane

  const tab = {
    // Start BUSY with a live prompt in flight so scenarios can prove commands
    // bypass the idle gate. Overridable per-scenario.
    status: opts.status || 'busy',
    idleTimer: null,
    cmd: { id: 'pty-1' },
    slack: {
      connected: true,
      threadTs: 'T',
      botUserId: 'BOT',
      inbox: [],
      lastTs: '0',
      seenTs: new Set(),
      awaitingResponse: opts.awaitingResponse || false,
      captureBuffer: opts.captureBuffer != null ? opts.captureBuffer : '',
      postReplies: true,
    },
  };

  // Fake Electron pty bridge — records writes, never touches a real process.
  const pty = { write(id, data) { ptyWrites.push({ id, data }); } };

  function appendSlackMessage(t, m) { paneRows.push(m); }
  function slackProxyEnabled(s) { return !!(s && s.connected && s.threadTs); }

  // Mirror of postToSlack: records the post AND marks the returned ts as seen,
  // exactly like the real renderer, so the bot's own replies can't loop back.
  let postSeq = 0;
  function postToSlack(t, text, threadTs) {
    const s = t.slack;
    if (!slackProxyEnabled(s) || !text) return { ok: false };
    const ts = 'bot.' + (++postSeq);
    posts.push({ text, threadTs, ts });
    s.seenTs.add(ts); // loop-guard: our own post must never be re-dispatched
    return { ok: true, ts };
  }

  function decodeSlackText(x) { return String(x); }

  // Verbatim mirror of slackShouldDispatchIncoming.
  function slackShouldDispatchIncoming(msg, s) {
    if (!msg || msg.ts == null) return false;
    if (!slackProxyEnabled(s)) return false;
    if (msg.bot_id) return false;
    if (s.botUserId && msg.user === s.botUserId) return false;
    if (s.seenTs && typeof s.seenTs.has === 'function' && s.seenTs.has(msg.ts)) return false;
    if (msg.subtype && msg.subtype !== 'thread_broadcast' && msg.subtype !== 'file_share') return false;
    const thread = msg.thread_ts || msg.ts;
    if (thread !== s.threadTs) return false;
    return true;
  }

  // Verbatim mirror of slackTryDispatch (fake pty + fake timer for Enter).
  function slackTryDispatch(t) {
    const s = t.slack;
    if (!slackProxyEnabled(s)) return;
    if (s.awaitingResponse) return;
    if (!s.inbox.length) return;
    if (!t.cmd.id) return;
    if (t.status !== 'finished' && t.status !== 'idle') return;
    const item = s.inbox.shift();
    s.awaitingResponse = true;
    s.captureBuffer = '';
    t.status = 'busy';
    if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
    try {
      pty.write(t.cmd.id, item.text);
      setTimeout(() => {
        if (t.cmd && t.cmd.id) { try { pty.write(t.cmd.id, '\r'); } catch (_) {} }
      }, QUEUE_ENTER_DELAY_MS);
    } catch (err) {
      s.awaitingResponse = false;
    }
  }

  // Verbatim mirror of handleSlackCommand.
  async function handleSlackCommand(t, matched, msg) {
    const s = t.slack;
    const handler = handlers[matched.name];
    if (typeof handler !== 'function') {
      postToSlack(t, "That command isn't available in this session.", s.threadTs);
      return;
    }
    try {
      const replyText = await handler(t, msg);
      if (typeof replyText === 'string' && replyText.trim()) {
        postToSlack(t, replyText, s.threadTs);
        appendSlackMessage(t, { who: 'system', text: replyText });
      }
    } catch (err) {
      const detail = (err && err.message) || String(err);
      postToSlack(t, 'Command failed: ' + detail, s.threadTs);
    }
  }

  // Verbatim mirror of handleIncomingSlackMessage.
  function handleIncomingSlackMessage(t, msg) {
    const s = t.slack;
    const text = decodeSlackText(msg.text || '');
    if (!text.trim()) return;
    appendSlackMessage(t, { who: 'slack', author: msg.user || 'user', text, ts: msg.ts });
    const matched = matchCommand(text, registry);
    if (matched) {
      handleSlackCommand(t, matched, msg);
      return;
    }
    s.inbox.push({ text, ts: msg.ts, user: msg.user });
    slackTryDispatch(t);
  }

  // Verbatim mirror of ingestSlackMessage — the funnel the poller calls.
  function ingestSlackMessage(t, msg) {
    const s = t.slack;
    if (!msg || msg.ts == null) return;
    if (Number(msg.ts) > Number(s.lastTs)) s.lastTs = msg.ts;
    const accept = slackShouldDispatchIncoming(msg, s);
    s.seenTs.add(msg.ts);
    if (!accept) return;
    handleIncomingSlackMessage(t, msg);
  }

  return { tab, ptyWrites, posts, paneRows, ingestSlackMessage };
}

// The registry mirrors what a real command build (TASK-058+) would carry:
//   ping  → wired to a handler returning "pong"
//   ghost → matched by the registry but NO handler wired
//   boom  → wired to a handler that throws
const REGISTRY = [
  { name: 'ping', description: 'Health check', patterns: ['ping'] },
  { name: 'ghost', description: 'Orphan command', patterns: ['ghost'] },
  { name: 'boom', description: 'Explodes', patterns: ['boom'] },
];

// ===========================================================================
// Scenario 1 — a registered command answers in-thread, never touches Claude.
// ===========================================================================
test('Scenario: registered command "ping" replies "pong" exactly once, 0 pty writes, empty inbox', async () => {
  // Given a session connected to thread T with "ping" → "pong" wired
  const h = makeHarness(REGISTRY, { ping: async () => 'pong' });

  // When the user replies "ping" in thread T (delivered by the poller)
  h.ingestSlackMessage(h.tab, { text: 'ping', ts: '10.1', user: 'U1', thread_ts: 'T' });
  await flush();

  // Then "pong" is posted to T exactly once
  assert.equal(h.posts.length, 1, 'exactly one post');
  assert.deepEqual(
    { text: h.posts[0].text, threadTs: h.posts[0].threadTs },
    { text: 'pong', threadTs: 'T' },
  );
  // And there are zero pty writes
  assert.equal(h.ptyWrites.length, 0, 'command never reaches the Claude pty');
  // And the inbox stays empty
  assert.equal(h.tab.slack.inbox.length, 0, 'command never enters the inbox');
  // And the pane shows the user message then the system reply
  assert.equal(h.paneRows[0].who, 'slack');
  assert.equal(h.paneRows[1].who, 'system');
  assert.equal(h.paneRows[1].text, 'pong');
});

// ===========================================================================
// Scenario 2 — commands work while Claude is busy AND awaiting a response.
// ===========================================================================
test('Scenario: command still answered while Claude is busy + awaitingResponse, idle-gate state unchanged', async () => {
  // Given Claude is busy with a prompt already in flight (awaitingResponse true,
  // a non-empty capture buffer accumulating)
  const h = makeHarness(REGISTRY, { ping: async () => 'pong' }, {
    status: 'busy',
    awaitingResponse: true,
    captureBuffer: 'partial output so far',
  });

  // When the user replies "ping" in the thread
  h.ingestSlackMessage(h.tab, { text: 'ping', ts: '11.1', user: 'U1', thread_ts: 'T' });
  await flush();

  // Then "pong" is still posted
  assert.deepEqual(
    { text: h.posts[0].text, threadTs: h.posts[0].threadTs },
    { text: 'pong', threadTs: 'T' },
  );
  assert.equal(h.ptyWrites.length, 0, 'no pty write even though a prompt is in flight');
  // And the idle-gate state is completely unchanged
  assert.equal(h.tab.slack.awaitingResponse, true, 'awaitingResponse unchanged');
  assert.equal(h.tab.slack.captureBuffer, 'partial output so far', 'captureBuffer unchanged');
  assert.equal(h.tab.status, 'busy', 'tab.status unchanged');
});

// ===========================================================================
// Scenario 3 — non-command conversation is dispatched to Claude (regression).
// ===========================================================================
test('Scenario: non-command "run the build" is written to the Claude pty + Enter, no command reply', async () => {
  // Given Claude is idle so the dispatcher will fire
  const h = makeHarness(REGISTRY, { ping: async () => 'pong' }, { status: 'idle' });

  // When the user sends ordinary text (not a command)
  h.ingestSlackMessage(h.tab, { text: 'run the build', ts: '12.1', user: 'U1', thread_ts: 'T' });
  await flush();

  // Then it is written to the Claude pty followed by an Enter keypress
  assert.deepEqual(h.ptyWrites, [
    { id: 'pty-1', data: 'run the build' },
    { id: 'pty-1', data: '\r' },
  ]);
  // And no command reply is posted to the thread
  assert.equal(h.posts.length, 0, 'ordinary conversation is not answered as a command');
  // And a prompt is now in flight
  assert.equal(h.tab.slack.awaitingResponse, true);
});

// ===========================================================================
// Scenario 4 — loop guard: the bot's own reply, re-delivered by the poller,
// is rejected (nothing posted, nothing typed).
// ===========================================================================
test('Scenario: loop guard rejects the bot\'s own "pong" when the poller re-delivers it', async () => {
  // Given a "ping" command has just been answered with "pong"
  const h = makeHarness(REGISTRY, { ping: async () => 'pong' }, { status: 'idle' });
  h.ingestSlackMessage(h.tab, { text: 'ping', ts: '13.1', user: 'U1', thread_ts: 'T' });
  await flush();
  assert.equal(h.posts.length, 1);
  const ownPost = h.posts[0]; // the bot's own message, its ts now in seenTs

  const postsBefore = h.posts.length;
  const writesBefore = h.ptyWrites.length;

  // When the poller returns the bot's own "pong" message (ts already in seenTs)
  h.ingestSlackMessage(h.tab, {
    text: 'pong',
    ts: ownPost.ts,          // same ts the bot recorded as seen
    user: 'BOT',             // the bot user
    thread_ts: 'T',
  });
  await flush();

  // Then it is rejected: nothing new posted and nothing typed to Claude
  assert.equal(h.posts.length, postsBefore, 'the bot\'s own reply is not re-posted');
  assert.equal(h.ptyWrites.length, writesBefore, 'the bot\'s own reply is never dispatched to the pty');
  assert.equal(h.tab.slack.inbox.length, 0, 'the bot\'s own reply never enters the inbox');
});

// ===========================================================================
// Scenario 5 — a throwing handler yields a failure reply, never crashes, no pty.
// ===========================================================================
test('Scenario: handler "boom" throws "kaput" → "Command failed: kaput" posted to T, 0 pty writes, no crash', async () => {
  // Given the "boom" command is wired to a handler that throws "kaput"
  const h = makeHarness(REGISTRY, {
    boom: async () => { throw new Error('kaput'); },
  });

  // When the user triggers "boom"
  await assert.doesNotReject(async () => {
    h.ingestSlackMessage(h.tab, { text: 'boom', ts: '14.1', user: 'U1', thread_ts: 'T' });
    await flush();
  }, 'a throwing handler must never crash the pipeline');

  // Then a failure reply mentioning the error is posted to T
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].threadTs, 'T');
  assert.match(h.posts[0].text, /Command failed/);
  assert.match(h.posts[0].text, /kaput/);
  // And there are zero pty writes
  assert.equal(h.ptyWrites.length, 0);
  assert.equal(h.tab.slack.inbox.length, 0);
});

// ===========================================================================
// Scenario 6 — a matched name with no wired handler → "isn't available" reply.
// ===========================================================================
test('Scenario: matched command "ghost" with no handler → "isn\'t available" reply posted to T', async () => {
  // Given "ghost" is in the registry but no handler is wired
  const h = makeHarness(REGISTRY, { ping: async () => 'pong' }); // no ghost handler

  // When the user triggers "ghost"
  h.ingestSlackMessage(h.tab, { text: 'ghost', ts: '15.1', user: 'U1', thread_ts: 'T' });
  await flush();

  // Then the "isn't available" reply is posted to T and nothing is typed
  assert.deepEqual(
    { text: h.posts[0].text, threadTs: h.posts[0].threadTs },
    { text: "That command isn't available in this session.", threadTs: 'T' },
  );
  assert.equal(h.posts.length, 1);
  assert.equal(h.ptyWrites.length, 0);
  assert.equal(h.tab.slack.inbox.length, 0);
});

// ===========================================================================
// Extra edge scenario — punctuation/case-insensitive matching still routes to
// the command path (proves the real matcher backs the wiring end-to-end).
// ===========================================================================
test('Scenario (edge): "  PING! " normalizes and still routes to the command handler', async () => {
  // Given the same "ping" → "pong" wiring
  const h = makeHarness(REGISTRY, { ping: async () => 'pong' });

  // Sanity on the real matcher the wiring depends on
  assert.equal(normalizeCommandInput('  PING! '), 'ping');

  // When a messy-but-equivalent "ping" arrives
  h.ingestSlackMessage(h.tab, { text: '  PING! ', ts: '16.1', user: 'U1', thread_ts: 'T' });
  await flush();

  // Then it is still answered as a command, never dispatched
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].text, 'pong');
  assert.equal(h.ptyWrites.length, 0);
});
