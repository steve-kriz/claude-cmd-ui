'use strict';

// Tests for TASK-011 ("slack bug"): a user's reply typed inside the Slack
// session anchor thread never came back into the app (and so was never posted
// into the Claude window). Root cause: the HTTP polling fallback used
// conversations.history, which never returns thread replies. Fix: a new
// lib/slack.js `fetchReplies` (conversations.replies) plus renderer poll wiring
// that advances s.lastReplyTs and feeds each new reply through the existing
// ingest -> shouldDispatch -> pty.write pipeline.
//
// Three layers are under test here, ALL with zero real network / DB / Electron:
//
//   1. Unit — lib/slack.js fetchReplies over a FULLY MOCKED https.request
//      (helpers/fake-https). Verifies it calls conversations.replies with the
//      right params + auth header, parses/sorts messages, and degrades
//      gracefully on ok:false and transport errors.
//
//   2. Source-scan — the renderer's pollSlackOnce reply-polling wiring
//      (renderer.js is a browser script, not require()-able), asserting the fix
//      is actually present: it calls slack.fetchReplies for the anchor thread,
//      skips the parent, advances s.lastReplyTs, and funnels replies through
//      ingestSlackMessage. Plus the IPC handler + preload bridge exist.
//
//   3. Gherkin e2e — the inbound-dispatch decision (shouldDispatchIncoming from
//      lib/slack-proxy.js, the exported source-of-truth the renderer mirrors),
//      driven as Given/When/Then scenarios: a genuine anchor-thread reply IS
//      dispatched to the pty; the bot's own reply is NOT (no loop); a reply in
//      another thread is NOT; an already-seen ts is NOT dispatched twice.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { makeFakeHttps } = require('./helpers/fake-https');

const slack = require('../lib/slack');
const { shouldDispatchIncoming } = require('../lib/slack-proxy');

// Install a fake https.request (see slack-exchange.test.js for the pattern).
function stubHttps(responder) {
  const fake = makeFakeHttps(responder);
  mock.method(https, 'request', fake.request);
  return fake;
}

// ===========================================================================
// PART 1 — Unit: lib/slack.js fetchReplies (conversations.replies), MOCKED net
// ===========================================================================

test('fetchReplies: GETs conversations.replies with channel/ts/oldest/limit + Bearer auth', async () => {
  const body = JSON.stringify({
    ok: true,
    messages: [
      { ts: '1000.0001', text: 'anchor (parent)', user: 'UBOT' },
      { ts: '1000.0003', text: 'second reply', user: 'UHUMAN' },
      { ts: '1000.0002', text: 'first reply', user: 'UHUMAN' },
    ],
  });
  const fake = stubHttps(() => ({ statusCode: 200, body }));
  try {
    const res = await slack.fetchReplies('xoxb-tok', 'C123', '1000.0001', '1000.0001', 200);
    assert.equal(res.ok, true);
    assert.equal(fake.calls.length, 1, 'exactly one HTTP call');

    const { options } = fake.calls[0];
    assert.equal(options.hostname, 'slack.com');
    assert.equal(options.method, 'GET');
    assert.match(options.path, /^\/api\/conversations\.replies\?/);
    assert.equal(options.headers.Authorization, 'Bearer xoxb-tok');

    // Query params carry channel / ts (the parent) / oldest / limit, and set
    // inclusive:false so already-seen replies (oldest) are excluded.
    const qs = new URLSearchParams(options.path.split('?')[1]);
    assert.equal(qs.get('channel'), 'C123');
    assert.equal(qs.get('ts'), '1000.0001');
    assert.equal(qs.get('oldest'), '1000.0001');
    assert.equal(qs.get('inclusive'), 'false');
    assert.equal(qs.get('limit'), '200');

    // Messages come back oldest-first (Slack may return them unsorted).
    assert.deepEqual(res.messages.map((m) => m.ts), ['1000.0001', '1000.0002', '1000.0003']);
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: no ts → short-circuits with an empty list and makes NO network call', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{"ok":true,"messages":[]}' }));
  try {
    const res = await slack.fetchReplies('xoxb-tok', 'C123', '', '0', 200);
    assert.deepEqual(res, { ok: true, messages: [] });
    assert.equal(fake.calls.length, 0, 'no HTTP request when there is no thread ts');
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: omits oldest/inclusive when no oldest cursor is given', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{"ok":true,"messages":[]}' }));
  try {
    await slack.fetchReplies('xoxb-tok', 'C123', '1000.0001');
    assert.equal(fake.calls.length, 1);
    const qs = new URLSearchParams(fake.calls[0].options.path.split('?')[1]);
    assert.equal(qs.get('channel'), 'C123');
    assert.equal(qs.get('ts'), '1000.0001');
    assert.equal(qs.get('oldest'), null, 'no oldest param without a cursor');
    assert.equal(qs.get('inclusive'), null, 'no inclusive param without a cursor');
    // limit defaults to 200 for replies.
    assert.equal(qs.get('limit'), '200');
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: clamps limit into [1,200]', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{"ok":true,"messages":[]}' }));
  try {
    await slack.fetchReplies('t', 'C1', '9.9', null, 9999);
    await slack.fetchReplies('t', 'C1', '9.9', null, 0);
    const hi = new URLSearchParams(fake.calls[0].options.path.split('?')[1]);
    const lo = new URLSearchParams(fake.calls[1].options.path.split('?')[1]);
    assert.equal(hi.get('limit'), '200', 'over-large limit clamped to 200');
    assert.equal(lo.get('limit'), '200', 'falsy limit falls back to the 200 default');
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: Slack ok:false is surfaced as ok:false with an error, no throw', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: JSON.stringify({ ok: false, error: 'thread_not_found' }) }));
  try {
    const res = await slack.fetchReplies('t', 'C1', '9.9', '0', 200);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'thread_not_found');
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: missing_scope error is expanded into a human-readable hint', async () => {
  const fake = stubHttps(() => ({
    statusCode: 200,
    body: JSON.stringify({ ok: false, error: 'missing_scope', needed: 'channels:history', provided: 'chat:write' }),
  }));
  try {
    const res = await slack.fetchReplies('t', 'C1', '9.9', '0', 200);
    assert.equal(res.ok, false);
    assert.match(res.error, /missing_scope/);
    assert.match(res.error, /channels:history/);
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: a transport/connection error is caught and returned as ok:false', async () => {
  const fake = stubHttps(() => ({ error: new Error('ECONNRESET') }));
  try {
    const res = await slack.fetchReplies('t', 'C1', '9.9', '0', 200);
    assert.equal(res.ok, false);
    // slackRequest maps req 'error' -> { ok:false, error: err.message }; then
    // describeError passes the code through unchanged for non-scope errors.
    assert.equal(res.error, 'ECONNRESET');
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: non-JSON body is reported, not thrown', async () => {
  const fake = stubHttps(() => ({ statusCode: 502, body: '<html>bad gateway</html>' }));
  try {
    const res = await slack.fetchReplies('t', 'C1', '9.9', '0', 200);
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid JSON from Slack/);
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('fetchReplies: a missing messages array yields ok:true with an empty list', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{"ok":true}' }));
  try {
    const res = await slack.fetchReplies('t', 'C1', '9.9', '0', 200);
    assert.deepEqual(res, { ok: true, messages: [] });
  } finally {
    mock.restoreAll();
  }
});

test('lib/slack.js exports fetchReplies', () => {
  assert.equal(typeof slack.fetchReplies, 'function');
});

// ===========================================================================
// PART 2 — Source-scan: the renderer poll + IPC + preload wiring for the fix.
// renderer.js / main.js / preload.js browser-and-Electron surfaces are scanned
// against their real source (not require()-able / need Electron).
// ===========================================================================

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const MAIN = path.join(__dirname, '..', 'main.js');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');
const mainSrc = fs.readFileSync(MAIN, 'utf8').replace(/\r\n/g, '\n');
const preloadSrc = fs.readFileSync(PRELOAD, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

test('renderer pollSlackOnce polls conversations.replies for the anchor thread', () => {
  const body = fnBody(rendererSrc, 'async function pollSlackOnce(tab)');
  // History is polled first (the pre-existing top-level poll)...
  assert.match(body, /window\.api\.slack\.fetch\(s\.token,\s*s\.channelId,\s*s\.lastTs/);
  // ...and the FIX: also poll replies in the session anchor thread.
  assert.match(body, /if\s*\(s\.threadTs\)/, 'guards the reply poll on an anchor thread');
  assert.match(body,
    /window\.api\.slack\.fetchReplies\(s\.token,\s*s\.channelId,\s*s\.threadTs,\s*s\.lastReplyTs/,
    'polls conversations.replies for the anchor thread using the reply cursor');
});

test('renderer reply poll skips the parent, advances lastReplyTs, and funnels through ingest', () => {
  const body = fnBody(rendererSrc, 'async function pollSlackOnce(tab)');
  // Skip the anchor/parent message (ts === threadTs) so it is not re-dispatched.
  assert.match(body, /if\s*\(msg\.ts\s*===\s*s\.threadTs\)\s*continue/);
  // Advance the dedicated reply cursor so already-seen replies are not re-fetched.
  assert.match(body, /if\s*\(Number\(msg\.ts\)\s*>\s*Number\(s\.lastReplyTs\)\)\s*s\.lastReplyTs\s*=\s*msg\.ts/);
  // Each new reply goes through the SAME ingest funnel as history messages, so
  // the bot/self/seen/thread filtering + idle-gated pty dispatch is reused.
  assert.match(body, /ingestSlackMessage\(tab,\s*msg\)/);
  // A reply-poll error is surfaced, not swallowed.
  assert.match(body, /rep\.error/);
});

test('renderer seeds the reply cursor (lastReplyTs) from the anchor on connect', () => {
  // On connect the reply baseline is set to the anchor ts so we pick up every
  // reply typed AFTER the session starts.
  assert.match(rendererSrc, /s\.lastReplyTs\s*=\s*anchor\.ts/);
  // A fresh Slack state initialises the reply cursor.
  assert.match(rendererSrc, /lastReplyTs:\s*'0'/);
});

test('main.js exposes the slack:fetchReplies IPC handler delegating to slack.fetchReplies', () => {
  assert.match(mainSrc, /ipcMain\.handle\(\s*'slack:fetchReplies'/);
  const body = fnBody(mainSrc, "ipcMain.handle('slack:fetchReplies'");
  assert.match(body, /slack\.fetchReplies\(token,\s*channel,\s*ts,\s*oldest,\s*limit\)/);
  // Guards required params and returns ok:false rather than throwing across IPC.
  assert.match(body, /if\s*\(!token\s*\|\|\s*!channel\s*\|\|\s*!ts\)/);
  assert.match(body, /return\s*\{\s*ok:\s*false,\s*error:\s*err\.message\s*\}/);
});

test('preload.js bridges slack.fetchReplies to the slack:fetchReplies channel', () => {
  assert.match(preloadSrc,
    /fetchReplies:\s*\(token,\s*channel,\s*ts,\s*oldest,\s*limit\)\s*=>\s*ipcRenderer\.invoke\(\s*'slack:fetchReplies',\s*\{\s*token,\s*channel,\s*ts,\s*oldest,\s*limit\s*\}\)/);
});

// ===========================================================================
// PART 3 — Feature: a Slack thread reply comes back into the app and is posted
// into the Claude window (TASK-011). Gherkin scenarios over the exported
// inbound-dispatch decision (lib/slack-proxy.shouldDispatchIncoming) plus a
// verbatim mirror of the renderer's reply-poll loop driving a FAKE pty. NO real
// network / DB / Electron — the Slack surface and pty are in-memory.
// ===========================================================================

const ANCHOR = '1000.0001';

// A fake pty capturing what the renderer would type into the Claude window.
function makePty() {
  const writes = [];
  return {
    write(id, data) { writes.push({ id, data }); },
    prompts() { return writes.filter((w) => w.data !== '\r').map((w) => w.data); },
    enters() { return writes.filter((w) => w.data === '\r').length; },
  };
}

// Verbatim mirror of the renderer's reply-poll loop body (pollSlackOnce, the
// `if (s.threadTs)` branch): skip parent, advance lastReplyTs, ingest. `ingest`
// applies the SHARED dispatch decision (lib/slack-proxy) and, when accepted and
// idle, writes the prompt + Enter into the pty — exactly like slackTryDispatch.
function makeHarness() {
  const pty = makePty();
  const state = {
    connected: true, threadTs: ANCHOR, botUserId: 'UBOT',
    seenTs: new Set([ANCHOR]), lastReplyTs: ANCHOR,
    awaitingResponse: false, inbox: [], cmdId: 'cmd-1', status: 'idle',
  };

  function ingest(msg) {
    const s = state;
    const r = shouldDispatchIncoming(msg, s); // { accept, reason }
    s.seenTs.add(msg.ts);
    if (!r.accept) return r;
    if (!String(msg.text || '').trim()) return { accept: false, reason: 'empty' };
    s.inbox.push({ text: msg.text, ts: msg.ts });
    // Idle-gated dispatch into the Claude pty.
    if (s.awaitingResponse) return r;
    if (s.status !== 'finished' && s.status !== 'idle') return r;
    const item = s.inbox.shift();
    s.awaitingResponse = true;
    pty.write(s.cmdId, item.text);
    pty.write(s.cmdId, '\r');
    return r;
  }

  // Mirror of the pollSlackOnce reply branch over an in-memory replies payload.
  function pollReplies(messages) {
    for (const msg of messages) {
      if (!msg || msg.ts == null) continue;
      if (msg.ts === state.threadTs) continue;         // parent, not a reply
      if (Number(msg.ts) > Number(state.lastReplyTs)) state.lastReplyTs = msg.ts;
      ingest(msg);
    }
  }

  return { pty, state, ingest, pollReplies };
}

test('Scenario: a user reply typed in the anchor thread comes back and is typed into Claude', () => {
  // Given a connected Slack proxy on the session anchor thread, and Claude idle
  const h = makeHarness();
  // When conversations.replies returns the parent + a genuine user reply
  h.pollReplies([
    { ts: ANCHOR, user: 'UBOT', text: ':robot_face: Claude session started' }, // parent
    { ts: '1000.0002', user: 'UHUMAN', thread_ts: ANCHOR, text: 'run the build' },
  ]);
  // Then the reply is written into the Claude window, followed by Enter
  assert.deepEqual(h.pty.prompts(), ['run the build']);
  assert.equal(h.pty.enters(), 1, 'Enter (\\r) sent so Claude actually runs it');
  assert.equal(h.state.awaitingResponse, true, 'now awaiting Claude');
  // And the reply cursor advanced past the parent so it is not re-fetched.
  assert.equal(h.state.lastReplyTs, '1000.0002');
});

test("Scenario (loop guard): the bot's own reply is NOT typed back into Claude", () => {
  // Given the same connected proxy
  const h = makeHarness();
  // When the reply carries the bot user id (Claude's own posted output)...
  const rBot = h.ingest({ ts: '1000.0003', user: 'UBOT', thread_ts: ANCHOR, text: 'claude output' });
  // ...or a bot_id (posted via chat.postMessage as the bot)
  const rBotId = h.ingest({ ts: '1000.0004', bot_id: 'B99', thread_ts: ANCHOR, text: 'claude output' });
  // Then neither is dispatched — no feedback loop
  assert.equal(rBot.accept, false);
  assert.equal(rBot.reason, 'self');
  assert.equal(rBotId.accept, false);
  assert.equal(rBotId.reason, 'bot');
  assert.equal(h.pty.prompts().length, 0, 'the bot never feeds its own output back to Claude');
});

test('Scenario: a reply in a DIFFERENT thread is NOT dispatched', () => {
  // Given the connected proxy anchored on ANCHOR
  const h = makeHarness();
  // When a reply arrives whose thread_ts is some other thread
  const r = h.ingest({ ts: '1000.0005', user: 'UHUMAN', thread_ts: '9999.9999', text: 'not my thread' });
  // Then it is rejected as belonging to another thread and nothing is typed
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'other-thread');
  assert.equal(h.pty.prompts().length, 0);
});

test('Scenario: an already-seen reply ts is NOT dispatched twice', () => {
  // Given a genuine reply that has already been dispatched once
  const h = makeHarness();
  h.state.status = 'idle';
  const first = h.ingest({ ts: '1000.0006', user: 'UHUMAN', thread_ts: ANCHOR, text: 'only once' });
  assert.equal(first.accept, true);
  assert.deepEqual(h.pty.prompts(), ['only once']);
  // Reset the busy gate so ONLY the seen-ts guard could block the redelivery.
  h.state.awaitingResponse = false;
  h.state.status = 'idle';
  // When the poller sees the same ts again (Slack re-returns it)
  const again = h.ingest({ ts: '1000.0006', user: 'UHUMAN', thread_ts: ANCHOR, text: 'only once' });
  // Then it is rejected as already-seen and not re-typed into Claude
  assert.equal(again.accept, false);
  assert.equal(again.reason, 'seen');
  assert.deepEqual(h.pty.prompts(), ['only once'], 'dispatched exactly once');
});

test('Scenario: the anchor/parent message itself is never dispatched by the reply poll', () => {
  // Given the connected proxy — conversations.replies always includes the parent
  const h = makeHarness();
  // When only the parent (ts === threadTs) is returned
  h.pollReplies([{ ts: ANCHOR, user: 'UBOT', text: 'anchor header' }]);
  // Then it is skipped entirely (not even ingested) and nothing is typed
  assert.equal(h.pty.prompts().length, 0);
  assert.equal(h.state.lastReplyTs, ANCHOR, 'cursor unchanged by the parent');
});
