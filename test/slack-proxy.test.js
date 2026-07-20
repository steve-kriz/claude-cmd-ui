'use strict';

// Unit + source-scan + cucumber-style tests for TASK-009: the Slack <-> Claude
// thread proxy. When Slack is connected the app posts ONE anchor message and
// reuses its thread_ts as a two-way proxy between the Claude cmd pane and Slack.
//
// Three layers are under test:
//
//   1. lib/slack-proxy.js — the Electron-free, pure decision logic
//      (isProxyEnabled, shouldDispatchIncoming, hasSeen). No DOM / Electron /
//      network, so it is exercised directly with plain `node --test`.
//
//   2. renderer/renderer.js's browser-side wiring (connectSlack anchor creation,
//      onCmdData capture, ingestSlackMessage funnel, slackTryDispatch idle
//      gating, slackOnFinished flush, postToSlack error surfacing,
//      disconnectSlack / resetSlackForFolder cleanup, and the
//      slackProxyEnabled / slackShouldDispatchIncoming mirror). renderer.js is a
//      browser script (no module.exports, references document/window) so —
//      matching test/ticket-lanes.test.js and test/ticket-folders.test.js — its
//      behaviour is proven both by source-scan guards on the real source and by
//      VERBATIM copies driven against a fully MOCKED Slack surface.
//
//   3. Gherkin e2e scenarios from tasks/TASK-009 driven over a FULLY MOCKED
//      Slack surface: window.api.slack.post / .fetch return {ok, ts}; an
//      in-memory channel/thread store records every post; a fake pty captures
//      writes; a fake finished/idle signal drives the flush. NO real network,
//      DB, Slack API or Electron is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isProxyEnabled,
  shouldDispatchIncoming,
  hasSeen,
} = require('../lib/slack-proxy');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const LIB = path.join(__dirname, '..', 'lib', 'slack-proxy.js');
// Normalise CRLF → LF so the `\n}\n` function-body delimiter and the regex
// guards below match regardless of the checked-out line-ending style.
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');
const libSrc = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');

// ===========================================================================
// PART 1 — Unit tests: lib/slack-proxy.js pure logic
// ===========================================================================

// --- isProxyEnabled --------------------------------------------------------

test('isProxyEnabled: connected AND threadTs present → true', () => {
  assert.equal(isProxyEnabled({ connected: true, threadTs: '111.222' }), true);
});

test('isProxyEnabled: missing threadTs → false', () => {
  assert.equal(isProxyEnabled({ connected: true, threadTs: null }), false);
  assert.equal(isProxyEnabled({ connected: true }), false);
  assert.equal(isProxyEnabled({ connected: true, threadTs: '' }), false);
});

test('isProxyEnabled: not connected → false (even with a threadTs)', () => {
  assert.equal(isProxyEnabled({ connected: false, threadTs: '111.222' }), false);
  assert.equal(isProxyEnabled({ threadTs: '111.222' }), false);
});

test('isProxyEnabled: null/undefined state → false (never throws)', () => {
  assert.equal(isProxyEnabled(null), false);
  assert.equal(isProxyEnabled(undefined), false);
  assert.equal(isProxyEnabled({}), false);
});

// --- hasSeen (Set OR array tolerant) ---------------------------------------

test('hasSeen: works with seenTs as a Set', () => {
  const seen = new Set(['1.1', '2.2']);
  assert.equal(hasSeen(seen, '1.1'), true);
  assert.equal(hasSeen(seen, '2.2'), true);
  assert.equal(hasSeen(seen, '9.9'), false);
});

test('hasSeen: works with seenTs as an array', () => {
  const seen = ['1.1', '2.2'];
  assert.equal(hasSeen(seen, '1.1'), true);
  assert.equal(hasSeen(seen, '2.2'), true);
  assert.equal(hasSeen(seen, '9.9'), false);
});

test('hasSeen: absent seen or null ts → false (never throws)', () => {
  assert.equal(hasSeen(null, '1.1'), false);
  assert.equal(hasSeen(undefined, '1.1'), false);
  assert.equal(hasSeen(new Set(['1.1']), null), false);
  assert.equal(hasSeen(new Set(['1.1']), undefined), false);
  assert.equal(hasSeen({}, '1.1'), false); // non-Set, non-array object
});

// --- shouldDispatchIncoming: every reason branch ---------------------------
// A fully-enabled state that accepts an in-thread human reply by default; each
// test perturbs exactly one field to drive one rejection branch.

const ANCHOR = '1000.0001';
function enabledState(over) {
  return Object.assign({
    connected: true,
    threadTs: ANCHOR,
    botUserId: 'UBOT',
    seenTs: new Set(),
  }, over || {});
}
function humanReply(over) {
  return Object.assign({ ts: '1001.0002', user: 'UHUMAN', thread_ts: ANCHOR, text: 'hi' }, over || {});
}

test('shouldDispatchIncoming reason: no-ts (message without a ts)', () => {
  // no-ts is checked before proxy-enabled, so it fires even on a live state.
  assert.deepEqual(shouldDispatchIncoming({ user: 'UHUMAN' }, enabledState()),
    { accept: false, reason: 'no-ts' });
  assert.deepEqual(shouldDispatchIncoming(null, enabledState()),
    { accept: false, reason: 'no-ts' });
});

test('shouldDispatchIncoming reason: not-connected (proxy disabled)', () => {
  const r = shouldDispatchIncoming(humanReply(), { connected: false, threadTs: ANCHOR });
  assert.deepEqual(r, { accept: false, reason: 'not-connected' });
  // Missing threadTs is also "not-connected" (proxy not enabled).
  assert.deepEqual(shouldDispatchIncoming(humanReply(), { connected: true, threadTs: null }),
    { accept: false, reason: 'not-connected' });
});

test('shouldDispatchIncoming reason: bot (bot_id present)', () => {
  const r = shouldDispatchIncoming(humanReply({ bot_id: 'B123' }), enabledState());
  assert.deepEqual(r, { accept: false, reason: 'bot' });
});

test('shouldDispatchIncoming reason: self (msg.user === botUserId)', () => {
  const r = shouldDispatchIncoming(humanReply({ user: 'UBOT' }), enabledState());
  assert.deepEqual(r, { accept: false, reason: 'self' });
});

test('shouldDispatchIncoming reason: seen (ts already in seenTs)', () => {
  const state = enabledState({ seenTs: new Set(['1001.0002']) });
  const r = shouldDispatchIncoming(humanReply({ ts: '1001.0002' }), state);
  assert.deepEqual(r, { accept: false, reason: 'seen' });
});

test('shouldDispatchIncoming reason: subtype (non-user subtype dropped)', () => {
  const r = shouldDispatchIncoming(humanReply({ subtype: 'channel_join' }), enabledState());
  assert.deepEqual(r, { accept: false, reason: 'subtype' });
});

test('shouldDispatchIncoming reason: other-thread (thread_ts !== state.threadTs)', () => {
  const r = shouldDispatchIncoming(humanReply({ thread_ts: '9999.9999' }), enabledState());
  assert.deepEqual(r, { accept: false, reason: 'other-thread' });
  // A top-level channel message (no thread_ts) uses its own ts as the thread and
  // therefore is not part of the session anchor thread.
  const top = shouldDispatchIncoming({ ts: '1002.0003', user: 'UHUMAN', text: 'x' }, enabledState());
  assert.deepEqual(top, { accept: false, reason: 'other-thread' });
});

test('shouldDispatchIncoming reason: ok (in-thread human reply accepted)', () => {
  const r = shouldDispatchIncoming(humanReply(), enabledState());
  assert.deepEqual(r, { accept: true, reason: 'ok' });
});

test('shouldDispatchIncoming: allowed subtypes (thread_broadcast, file_share) pass', () => {
  for (const subtype of ['thread_broadcast', 'file_share']) {
    const r = shouldDispatchIncoming(humanReply({ subtype }), enabledState());
    assert.deepEqual(r, { accept: true, reason: 'ok' }, `${subtype} is accepted`);
  }
});

test('shouldDispatchIncoming: gating order — no-ts beats not-connected', () => {
  // A message with no ts against a disabled proxy reports no-ts (checked first).
  const r = shouldDispatchIncoming({ user: 'U' }, { connected: false });
  assert.equal(r.reason, 'no-ts');
});

test('shouldDispatchIncoming: gating order — bot beats self/seen/subtype/thread', () => {
  // A bot message that is ALSO self+seen+wrong-subtype+wrong-thread still
  // reports the earliest applicable reason: bot.
  const state = enabledState({ seenTs: new Set(['1001.0002']) });
  const msg = humanReply({ bot_id: 'B1', user: 'UBOT', subtype: 'channel_join', thread_ts: 'X' });
  assert.equal(shouldDispatchIncoming(msg, state).reason, 'bot');
});

test('shouldDispatchIncoming: hasSeen tolerates seenTs as an array here too', () => {
  const state = enabledState({ seenTs: ['1001.0002'] });
  assert.deepEqual(shouldDispatchIncoming(humanReply({ ts: '1001.0002' }), state),
    { accept: false, reason: 'seen' });
});

// ===========================================================================
// PART 2 — Source-scan guards: the renderer wiring must match the ticket, and
// the browser mirror must stay in sync with lib/slack-proxy.js.
// (renderer.js is not require()-able, so we assert against its source.)
// ===========================================================================

// Slice a named function body out of the renderer source for scoped asserts.
function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present in renderer.js`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

test('browser mirror slackProxyEnabled matches lib isProxyEnabled', () => {
  const body = fnBody(rendererSrc, 'function slackProxyEnabled(s)');
  assert.match(body, /return\s+!!\(s\s*&&\s*s\.connected\s*&&\s*s\.threadTs\)/);
});

test('browser mirror slackShouldDispatchIncoming matches lib gating order', () => {
  const body = fnBody(rendererSrc, 'function slackShouldDispatchIncoming(msg, s)');
  // Same gating, same order as lib/slack-proxy.js.
  assert.match(body, /if\s*\(!msg\s*\|\|\s*msg\.ts\s*==\s*null\)\s*return\s+false/);
  assert.match(body, /if\s*\(!slackProxyEnabled\(s\)\)\s*return\s+false/);
  assert.match(body, /if\s*\(msg\.bot_id\)\s*return\s+false/);
  assert.match(body, /if\s*\(s\.botUserId\s*&&\s*msg\.user\s*===\s*s\.botUserId\)\s*return\s+false/);
  assert.match(body, /if\s*\(s\.seenTs[\s\S]*?s\.seenTs\.has\(msg\.ts\)\)\s*return\s+false/);
  assert.match(body, /msg\.subtype\s*!==\s*'thread_broadcast'\s*&&\s*msg\.subtype\s*!==\s*'file_share'/);
  assert.match(body, /const\s+thread\s*=\s*msg\.thread_ts\s*\|\|\s*msg\.ts/);
  assert.match(body, /if\s*\(thread\s*!==\s*s\.threadTs\)\s*return\s+false/);
});

test('lib/slack-proxy.js exports the helpers and stays the source of truth', () => {
  // isProxyEnabled, shouldDispatchIncoming, hasSeen are the original three;
  // shouldFlushCapture (TASK-061) is exported alongside them.
  assert.match(libSrc, /module\.exports\s*=\s*\{[^}]*\bisProxyEnabled\b[^}]*\bshouldDispatchIncoming\b[^}]*\bhasSeen\b[^}]*\}/);
  assert.match(libSrc, /module\.exports\s*=\s*\{[^}]*\bshouldFlushCapture\b[^}]*\}/);
  // The lib gating order the mirror must follow.
  const decide = libSrc.slice(libSrc.indexOf('function shouldDispatchIncoming'));
  const order = ['no-ts', 'not-connected', 'bot', 'self', 'seen', 'subtype', 'other-thread', 'ok'];
  let last = -1;
  for (const reason of order) {
    const idx = decide.indexOf(`'${reason}'`);
    assert.ok(idx !== -1, `${reason} branch present in lib`);
    assert.ok(idx > last, `${reason} appears after the previous branch (gating order)`);
    last = idx;
  }
});

test('connectSlack posts exactly ONE anchor and stores s.threadTs from its ts', () => {
  const body = fnBody(rendererSrc, 'async function connectSlack(tab)');
  // Exactly one anchor post (thread arg null → a top-level message).
  const posts = [...body.matchAll(/window\.api\.slack\.post\(/g)];
  assert.equal(posts.length, 1, 'connectSlack posts a single anchor');
  assert.match(body, /window\.api\.slack\.post\(token,\s*s\.channelId,\s*headerText,\s*null\)/);
  // The anchor's ts becomes the session thread.
  assert.match(body, /s\.threadTs\s*=\s*anchor\.ts/);
  // The anchor is marked seen so it never loops back into Claude.
  assert.match(body, /s\.seenTs\.add\(anchor\.ts\)/);
});

test('a failed anchor post does NOT set connected/threadTs (early return)', () => {
  const body = fnBody(rendererSrc, 'async function connectSlack(tab)');
  // Guard bails before s.connected / s.threadTs assignment when the post fails.
  assert.match(body, /if\s*\(!anchor\s*\|\|\s*!anchor\.ok\s*\|\|\s*!anchor\.ts\)\s*\{/);
  const guardIdx = body.indexOf('if (!anchor || !anchor.ok || !anchor.ts)');
  const returnIdx = body.indexOf('return;', guardIdx);
  const threadSetIdx = body.indexOf('s.threadTs = anchor.ts');
  const connectedIdx = body.indexOf('s.connected = true');
  assert.ok(returnIdx !== -1 && returnIdx < threadSetIdx,
    'the failure guard returns before threadTs is assigned');
  assert.ok(returnIdx < connectedIdx, 'and before s.connected = true');
  // A thrown post is caught and coerced to an ok:false result (no crash).
  assert.match(body, /catch\s*\(err\)\s*\{\s*anchor\s*=\s*\{\s*ok:\s*false,\s*error/);
});

test('outbound flush uses s.threadTs, not a per-inbound replyThreadTs', () => {
  const flush = fnBody(rendererSrc, 'function slackOnFinished(tab)');
  // Flush posts into the single session anchor thread.
  assert.match(flush, /postToSlack\(tab,\s*reply,\s*s\.threadTs\)/);
  // The old per-message threading is gone: replyThreadTs is never assigned an
  // inbound item's ts anywhere in the renderer.
  assert.ok(!/replyThreadTs\s*=\s*item\.ts/.test(rendererSrc),
    'the old s.replyThreadTs = item.ts per-message threading is gone');
  assert.ok(!/replyThreadTs\s*=\s*msg\.ts/.test(rendererSrc),
    'no per-inbound-message reply thread is set from a message ts');
});

test('onCmdData accumulates outbound capture whenever the proxy is enabled', () => {
  const body = fnBody(rendererSrc, 'function onCmdData(tab, data)');
  assert.match(body, /if\s*\(tab\.slack\s*&&\s*slackProxyEnabled\(tab\.slack\)\)/);
  assert.match(body, /tab\.slack\.captureBuffer\s*\+=\s*String\(data\)/);
});

test('inbound funnel keeps bot_id / botUserId / seenTs filtering and idle-gating', () => {
  const ingest = fnBody(rendererSrc, 'function ingestSlackMessage(tab, msg)');
  // Applies the shared dispatch decision and records the ts as seen.
  assert.match(ingest, /slackShouldDispatchIncoming\(msg,\s*s\)/);
  assert.match(ingest, /s\.seenTs\.add\(msg\.ts\)/);
  // Idle-gating happens in slackTryDispatch (called from handleIncoming).
  const handle = fnBody(rendererSrc, 'function handleIncomingSlackMessage(tab, msg)');
  assert.match(handle, /slackTryDispatch\(tab\)/);
  const dispatch = fnBody(rendererSrc, 'function slackTryDispatch(tab)');
  assert.match(dispatch, /if\s*\(s\.awaitingResponse\)\s*return/);
  assert.match(dispatch, /if\s*\(tab\.status\s*!==\s*'finished'\s*&&\s*tab\.status\s*!==\s*'idle'\)\s*return/);
  assert.match(dispatch, /isAwaitingTuiSelection\(tab\)/);
  // The dispatched prompt is written to the pty and followed by Enter (\r).
  assert.match(dispatch, /window\.api\.pty\.write\(tab\.cmd\.id,\s*item\.text\)/);
  assert.match(dispatch, /window\.api\.pty\.write\(tab\.cmd\.id,\s*'\\r'\)/);
});

test('no-op paths guard on proxy-enabled (both directions)', () => {
  // Outbound capture, dispatch, flush, post, and the manual composer all bail
  // when the proxy is not enabled.
  assert.match(fnBody(rendererSrc, 'function slackTryDispatch(tab)'),
    /if\s*\(!slackProxyEnabled\(s\)\)\s*return/);
  assert.match(fnBody(rendererSrc, 'async function postToSlack(tab, text, threadTs)'),
    /if\s*\(!slackProxyEnabled\(s\)\s*\|\|\s*!text\)\s*return/);
  assert.match(fnBody(rendererSrc, 'function sendSlackComposer(tab)'),
    /if\s*\(!slackProxyEnabled\(s\)\)\s*return/);
  assert.match(fnBody(rendererSrc, 'function slackOnFinished(tab)'),
    /if\s*\(!s\s*\|\|\s*!slackProxyEnabled\(s\)\)/);
});

test('disconnectSlack and resetSlackForFolder both clear threadTs', () => {
  assert.match(fnBody(rendererSrc, 'function disconnectSlack(tab)'), /s\.threadTs\s*=\s*null/);
  // resetSlackForFolder clears it too (search the surrounding reset region).
  assert.match(rendererSrc,
    /Drop any prior session anchor[\s\S]*?s\.threadTs\s*=\s*null/,
    'resetSlackForFolder clears the session anchor');
});

test('postToSlack checks ok, surfaces errors without throwing, does not stick awaitingResponse', () => {
  const body = fnBody(rendererSrc, 'async function postToSlack(tab, text, threadTs)');
  // Checks the per-chunk ok flag and records the last error.
  assert.match(body, /if\s*\(!res\s*\|\|\s*!res\.ok\)\s*\{\s*ok\s*=\s*false;\s*lastError/);
  // Network throw is caught, not propagated.
  assert.match(body, /catch\s*\(err\)\s*\{[\s\S]*?ok\s*=\s*false;[\s\S]*?lastError\s*=\s*err\.message/);
  // Failure is surfaced to the UI and returned as a value.
  assert.match(body, /slackStatus\.textContent\s*=\s*'send failed: '\s*\+\s*lastError/);
  assert.match(body, /return\s*\{\s*ok,\s*error:\s*lastError\s*\}/);
  // postToSlack never touches awaitingResponse — the flush that calls it clears
  // the flag itself, so a failed send cannot leave dispatch stuck.
  assert.ok(!/awaitingResponse/.test(body), 'postToSlack does not manage awaitingResponse');
  const flush = fnBody(rendererSrc, 'function slackOnFinished(tab)');
  assert.match(flush, /s\.awaitingResponse\s*=\s*false/);
  const postIdx = flush.indexOf('postToSlack');
  const clearIdx = flush.indexOf('s.awaitingResponse = false');
  assert.ok(clearIdx !== -1 && clearIdx < postIdx,
    'awaitingResponse is cleared before the (possibly failing) post, so it never sticks');
});

// ===========================================================================
// PART 3 — Feature: Slack <-> Claude thread proxy (Gherkin scenarios)
//
// Driven over a FULLY MOCKED Slack surface + VERBATIM copies of the renderer's
// proxy decision / capture / dispatch / flush logic. NO real network, DB, Slack
// API or Electron: window.api.slack.{post,fetch} are in-memory, the pty is a
// write-capturing fake, and "finished/idle" is a function call.
// ===========================================================================

// --- Mocked Slack surface: an in-memory channel with threaded posts ---------
function makeSlackMock() {
  let seq = 1000;
  const posts = [];      // every post: { channel, text, threadTs, ts }
  let failNext = false;  // when true, the next post() resolves ok:false
  let throwNext = false; // when true, the next post() throws
  const api = {
    _posts: posts,
    failNextPost() { failNext = true; },
    throwNextPost() { throwNext = true; },
    // Top-level posts (threadTs null) are anchors; others are thread replies.
    async post(token, channel, text, threadTs) {
      if (throwNext) { throwNext = false; throw new Error('network down'); }
      if (failNext) { failNext = false; return { ok: false, error: 'rate_limited' }; }
      const ts = (seq++ / 1000).toFixed(6);
      posts.push({ channel, text, threadTs: threadTs || null, ts });
      return { ok: true, ts, channel };
    },
    // Poll transport — returns queued inbound messages (drained each call).
    async fetch() { return { ok: true, messages: pending.splice(0) }; },
  };
  const pending = []; // inbound messages a human "sent", awaiting a poll
  api._enqueueInbound = (msg) => pending.push(msg);
  api._topLevelPosts = () => posts.filter((p) => p.threadTs == null);
  api._threadPosts = (threadTs) => posts.filter((p) => p.threadTs === threadTs);
  return api;
}

// --- Fake pty capturing writes ---------------------------------------------
function makePty() {
  const writes = [];
  return {
    _writes: writes,
    write(id, data) { writes.push({ id, data }); },
    prompts() { return writes.filter((w) => w.data !== '\r').map((w) => w.data); },
    enters() { return writes.filter((w) => w.data === '\r').length; },
  };
}

// --- Verbatim copies of the renderer's proxy logic (kept in lockstep with the
// PART 2 source-scan guards) ------------------------------------------------

function slackProxyEnabled(s) {
  return !!(s && s.connected && s.threadTs);
}
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

// The harness models one Claude tab wired to the mocked Slack surface. It mirrors
// connectSlack's anchor creation, onCmdData capture, ingestSlackMessage funnel,
// slackTryDispatch idle gating, slackOnFinished flush and postToSlack.
function makeTab(slackApi, pty) {
  const tab = {
    status: 'idle',
    cmd: { id: 'cmd-1' },
    slack: null,
    _local: [], // appendSlackMessage stand-in (what the UI would show)
  };

  function freshState() {
    return {
      connected: false, token: 'xoxb-1', channelId: 'C1', channelName: 'general',
      botUserId: 'UBOT', postReplies: true, lastTs: '0', seenTs: new Set(),
      inbox: [], awaitingResponse: false, captureBuffer: '', threadTs: null,
      statusText: '', statusError: false,
    };
  }

  async function connect() {
    const s = freshState();
    tab.slack = s;
    // ONE anchor post; its ts becomes the session thread. On failure, leave
    // connected false and threadTs null (verbatim connectSlack behaviour).
    let anchor;
    try {
      anchor = await slackApi.post(s.token, s.channelId, ':robot_face: Claude session started', null);
    } catch (err) {
      anchor = { ok: false, error: err.message || String(err) };
    }
    if (!anchor || !anchor.ok || !anchor.ts) {
      s.statusText = 'anchor failed: ' + ((anchor && anchor.error) || 'post failed');
      return { ok: false };
    }
    s.threadTs = anchor.ts;
    s.seenTs.add(anchor.ts);
    s.connected = true;
    return { ok: true, threadTs: s.threadTs };
  }

  function disconnect() {
    const s = tab.slack;
    if (!s) return;
    s.connected = false;
    s.threadTs = null;
    s.awaitingResponse = false;
    s.captureBuffer = '';
    s.inbox = [];
  }

  // onCmdData: accumulate terminal output whenever the proxy is enabled.
  function onCmdData(data) {
    if (tab.slack && slackProxyEnabled(tab.slack)) {
      tab.slack.captureBuffer += String(data);
    }
  }

  // ingestSlackMessage funnel (shared by poll + socket transports).
  function ingest(msg) {
    const s = tab.slack;
    if (!msg || msg.ts == null) return;
    if (Number(msg.ts) > Number(s.lastTs)) s.lastTs = msg.ts;
    const accept = slackShouldDispatchIncoming(msg, s);
    s.seenTs.add(msg.ts);
    if (!accept) return;
    if (!String(msg.text || '').trim()) return;
    s.inbox.push({ text: msg.text, ts: msg.ts, user: msg.user });
    tryDispatch();
  }

  function tryDispatch() {
    const s = tab.slack;
    if (!slackProxyEnabled(s)) return;
    if (s.awaitingResponse) return;
    if (!s.inbox.length) return;
    if (!tab.cmd.id) return;
    if (tab.status !== 'finished' && tab.status !== 'idle') return;
    const item = s.inbox.shift();
    s.awaitingResponse = true;
    s.captureBuffer = '';
    tab.status = 'busy';
    pty.write(tab.cmd.id, item.text);
    pty.write(tab.cmd.id, '\r'); // Enter (delay collapsed in the harness)
  }

  // slackOnFinished: flush the captured reply into the anchor thread, clear the
  // in-flight flag BEFORE the (possibly failing) post so it can never stick.
  async function onFinished() {
    const s = tab.slack;
    if (!s || !slackProxyEnabled(s)) { if (s) s.awaitingResponse = false; return; }
    const reply = s.captureBuffer.trim();
    s.captureBuffer = '';
    s.awaitingResponse = false;
    if (reply && s.postReplies) {
      await postToSlack(reply, s.threadTs);
    }
    if (s.inbox.length) await tryDispatchAsyncTick();
  }

  async function tryDispatchAsyncTick() { tryDispatch(); }

  async function postToSlack(text, threadTs) {
    const s = tab.slack;
    if (!slackProxyEnabled(s) || !text) return { ok: false };
    const thread = threadTs || s.threadTs;
    let ok = true, lastError = null;
    try {
      const res = await slackApi.post(s.token, s.channelId, text, thread);
      if (res && res.ok && res.ts) s.seenTs.add(res.ts);
      if (!res || !res.ok) { ok = false; lastError = (res && res.error) || 'post failed'; }
    } catch (err) {
      ok = false; lastError = err.message || String(err);
    }
    if (!ok) { s.statusText = 'send failed: ' + lastError; s.statusError = true; }
    return { ok, error: lastError };
  }

  // Manual composer send (sendSlackComposer): outbound into the anchor thread.
  async function composerSend(text) {
    const s = tab.slack;
    if (!slackProxyEnabled(s)) return { ok: false };
    return postToSlack(text, s.threadTs);
  }

  return {
    tab, connect, disconnect, onCmdData, ingest, tryDispatch, onFinished,
    postToSlack, composerSend,
    // Simulate a full Claude turn: run goes busy, emits output, then goes idle.
    async claudeTurn(output) { onCmdData(output); tab.status = 'finished'; await onFinished(); },
    setStatus(st) { tab.status = st; },
  };
}

test('Scenario: Connecting creates a single anchor thread', async () => {
  const slackApi = makeSlackMock();
  const h = makeTab(slackApi, makePty());
  const r = await h.connect();
  assert.equal(r.ok, true);
  // Exactly one top-level (anchor) post, and threadTs points at its ts.
  assert.equal(slackApi._topLevelPosts().length, 1, 'exactly one anchor created');
  assert.equal(h.tab.slack.threadTs, slackApi._topLevelPosts()[0].ts);
  assert.equal(slackProxyEnabled(h.tab.slack), true);
  // The anchor is pre-seen so it never loops back into Claude.
  assert.equal(h.tab.slack.seenTs.has(h.tab.slack.threadTs), true);
});

test('Scenario: A failed connect creates no anchor and does not enable the proxy', async () => {
  const slackApi = makeSlackMock();
  slackApi.failNextPost();
  const h = makeTab(slackApi, makePty());
  const r = await h.connect();
  assert.equal(r.ok, false);
  assert.equal(h.tab.slack.connected, false, 'not connected on a failed anchor');
  assert.equal(h.tab.slack.threadTs, null, 'no session thread stored');
  assert.equal(slackProxyEnabled(h.tab.slack), false);
  // The mock still records the attempted post, but the app treats it as no anchor.
  assert.equal(slackApi._topLevelPosts().filter((p) => p.ts).length, 0,
    'no successful anchor post recorded');
});

test('Scenario: Outbound goes to the anchor thread (no new top-level message)', async () => {
  const slackApi = makeSlackMock();
  const h = makeTab(slackApi, makePty());
  await h.connect();
  const anchorTs = h.tab.slack.threadTs;
  // Claude produces output on an idle turn → flushed to Slack.
  await h.claudeTurn('here is my answer');
  // Still exactly one top-level message (the anchor); the reply is a thread post.
  assert.equal(slackApi._topLevelPosts().length, 1, 'no new top-level message created');
  const replies = slackApi._threadPosts(anchorTs);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'here is my answer');
  assert.equal(replies[0].threadTs, anchorTs, 'reply posted into the anchor thread');
});

test('Scenario: The same thread is reused across three messages', async () => {
  const slackApi = makeSlackMock();
  const h = makeTab(slackApi, makePty());
  await h.connect();
  const anchorTs = h.tab.slack.threadTs;
  await h.claudeTurn('reply one');
  await h.claudeTurn('reply two');
  await h.claudeTurn('reply three');
  // Only ever the single anchor at top level.
  assert.equal(slackApi._topLevelPosts().length, 1, 'one anchor across the whole session');
  // All three replies landed in the SAME thread.
  const replies = slackApi._threadPosts(anchorTs);
  assert.deepEqual(replies.map((r) => r.text), ['reply one', 'reply two', 'reply three']);
  for (const r of replies) assert.equal(r.threadTs, anchorTs);
});

test('Scenario: An inbound thread reply reaches the Claude window when idle', async () => {
  const slackApi = makeSlackMock();
  const pty = makePty();
  const h = makeTab(slackApi, pty);
  await h.connect();
  const anchorTs = h.tab.slack.threadTs;
  h.setStatus('idle');
  // A human replies in the anchor thread.
  h.ingest({ ts: '1500.0001', user: 'UHUMAN', thread_ts: anchorTs, text: 'do the thing' });
  // The prompt was written to the pty and followed by an Enter keystroke.
  assert.deepEqual(pty.prompts(), ['do the thing']);
  assert.equal(pty.enters(), 1, 'Enter (\\r) sent after the prompt');
  assert.equal(h.tab.slack.awaitingResponse, true, 'now awaiting Claude');
});

test('Scenario: An inbound message waits while Claude is busy, then flushes on idle', async () => {
  const slackApi = makeSlackMock();
  const pty = makePty();
  const h = makeTab(slackApi, pty);
  await h.connect();
  const anchorTs = h.tab.slack.threadTs;
  // Claude is mid-run.
  h.setStatus('busy');
  h.ingest({ ts: '1600.0001', user: 'UHUMAN', thread_ts: anchorTs, text: 'queued question' });
  // Nothing dispatched yet — it is queued in the inbox.
  assert.equal(pty.prompts().length, 0, 'nothing written while busy');
  assert.equal(h.tab.slack.inbox.length, 1, 'message queued');
  // Claude finishes its current turn; onFinished should drain the queue.
  h.setStatus('finished');
  await h.onFinished();
  // Now the queued prompt is delivered.
  assert.deepEqual(pty.prompts(), ['queued question']);
  assert.equal(pty.enters(), 1);
  assert.equal(h.tab.slack.inbox.length, 0, 'queue drained');
});

test("Scenario: The bot's own posts do not loop back into Claude", async () => {
  const slackApi = makeSlackMock();
  const pty = makePty();
  const h = makeTab(slackApi, pty);
  await h.connect();
  const anchorTs = h.tab.slack.threadTs;
  h.setStatus('idle');
  // Claude replies → that lands in the thread as the bot's own post.
  await h.claudeTurn('claude output that mentions something');
  const botReply = slackApi._threadPosts(anchorTs)[0];
  // The poller now sees the bot's own message come back. It must NOT dispatch it.
  // (a) it was recorded as seen when posted, and (b) it carries the bot user id.
  h.ingest({ ts: botReply.ts, user: 'UBOT', thread_ts: anchorTs, text: botReply.text });
  h.ingest({ ts: botReply.ts, bot_id: 'B1', thread_ts: anchorTs, text: botReply.text });
  assert.equal(pty.prompts().length, 0, "the bot's own post is never fed back to Claude");
  assert.equal(h.tab.slack.inbox.length, 0);
});

test('Scenario: No-op when not connected (both directions)', async () => {
  const slackApi = makeSlackMock();
  const pty = makePty();
  const h = makeTab(slackApi, pty);
  // Never connected: slack state exists only after connect(), so simulate a
  // pre-connect state with the proxy disabled.
  h.tab.slack = { connected: false, threadTs: null, seenTs: new Set(), inbox: [], captureBuffer: '', awaitingResponse: false, botUserId: 'UBOT', postReplies: true, token: 't', channelId: 'C1' };
  // Outbound capture is a no-op.
  h.onCmdData('some terminal output');
  assert.equal(h.tab.slack.captureBuffer, '', 'no capture while disconnected');
  // Inbound dispatch is a no-op.
  h.ingest({ ts: '1700.0001', user: 'UHUMAN', thread_ts: 'X', text: 'hello?' });
  assert.equal(pty.prompts().length, 0, 'nothing dispatched while disconnected');
  // Outbound post is a no-op (nothing hits the Slack surface).
  const r = await h.postToSlack('anything', 'X');
  assert.equal(r.ok, false);
  assert.equal(slackApi._posts.length, 0, 'no Slack post attempted while disconnected');
});

test('Scenario: Disconnect clears the thread; reconnect makes a fresh anchor', async () => {
  const slackApi = makeSlackMock();
  const h = makeTab(slackApi, makePty());
  await h.connect();
  const firstAnchor = h.tab.slack.threadTs;
  h.disconnect();
  assert.equal(h.tab.slack.threadTs, null, 'thread cleared on disconnect');
  assert.equal(slackProxyEnabled(h.tab.slack), false);
  // Reconnect → a brand new anchor with a different ts.
  await h.connect();
  const secondAnchor = h.tab.slack.threadTs;
  assert.ok(secondAnchor && secondAnchor !== firstAnchor, 'a fresh anchor thread is created');
  // Two distinct top-level anchors exist across the two sessions.
  assert.equal(slackApi._topLevelPosts().length, 2, 'each connect made its own anchor');
});

test('Scenario: Edge — a failed Slack send is surfaced, non-fatal, and does not stick awaitingResponse', async () => {
  const slackApi = makeSlackMock();
  const pty = makePty();
  const h = makeTab(slackApi, pty);
  await h.connect();
  h.setStatus('idle');
  // Inbound prompt → dispatched, now awaiting.
  h.ingest({ ts: '1800.0001', user: 'UHUMAN', thread_ts: h.tab.slack.threadTs, text: 'question' });
  assert.equal(h.tab.slack.awaitingResponse, true);
  // Claude finishes and the reply flush hits a FAILING Slack send.
  slackApi.failNextPost();
  h.onCmdData('the reply');
  h.setStatus('finished');
  await h.onFinished(); // must not throw
  // The failure was surfaced to the UI ...
  assert.equal(h.tab.slack.statusError, true);
  assert.match(h.tab.slack.statusText, /send failed: rate_limited/);
  // ... and awaitingResponse is NOT stuck — a later message can still dispatch.
  assert.equal(h.tab.slack.awaitingResponse, false, 'not left stuck after a failed send');
  h.setStatus('idle');
  h.ingest({ ts: '1800.0002', user: 'UHUMAN', thread_ts: h.tab.slack.threadTs, text: 'again' });
  assert.deepEqual(pty.prompts(), ['question', 'again'], 'the next prompt still dispatches');

  // A thrown (network) send is also caught and non-fatal.
  slackApi.throwNextPost();
  const r = await h.composerSend('manual message');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /network down/);
});
