'use strict';

// Unit + source-scan + harness tests for TASK-061: post Claude output to the
// Slack anchor thread PERIODICALLY during long busy runs, not only at idle.
//
// Three layers, mirroring test/slack-proxy.test.js:
//
//   1. lib/slack-proxy.js — the pure shouldFlushCapture(state) decision, tested
//      directly (no DOM / Electron / network).
//
//   2. renderer/renderer.js source-scans — the browser-side wiring is not
//      require()-able, so we assert against its source: the verbatim mirror
//      slackShouldFlushCapture, the flushTimer lifecycle (started in
//      startSlackListening; cleared in stopSlackListening, disconnectSlack and
//      resetSlackForFolder), and the tick clearing the buffer before the post
//      and reusing cleanTerminalOutput / postToSlack.
//
//   3. A small harness proving once-and-only-once delivery: output produced
//      across several interval flushes plus the final finish flush is posted
//      exactly once (no overlap, no duplicate posts).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { shouldFlushCapture, isProxyEnabled } = require('../lib/slack-proxy');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const LIB = path.join(__dirname, '..', 'lib', 'slack-proxy.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');
const libSrc = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

// ===========================================================================
// PART 1 — Unit: shouldFlushCapture truth table
// ===========================================================================

// A fully-flushable state: proxy enabled + postReplies + non-empty buffer + busy.
function flushable(over) {
  return Object.assign({
    connected: true,
    threadTs: '1000.0001',
    postReplies: true,
    captureBuffer: 'some output',
    busy: true,
  }, over || {});
}

test('shouldFlushCapture: enabled + postReplies + buffer + busy → true', () => {
  assert.equal(shouldFlushCapture(flushable()), true);
});

test('shouldFlushCapture: proxy disabled (no connect / no threadTs) → false', () => {
  assert.equal(shouldFlushCapture(flushable({ connected: false })), false);
  assert.equal(shouldFlushCapture(flushable({ threadTs: null })), false);
  assert.equal(shouldFlushCapture(flushable({ threadTs: '' })), false);
  // Sanity: the disabled cases are disabled by isProxyEnabled itself.
  assert.equal(isProxyEnabled(flushable({ connected: false })), false);
});

test('shouldFlushCapture: postReplies unchecked → false', () => {
  assert.equal(shouldFlushCapture(flushable({ postReplies: false })), false);
  assert.equal(shouldFlushCapture(flushable({ postReplies: undefined })), false);
});

test('shouldFlushCapture: empty / non-string buffer → false', () => {
  assert.equal(shouldFlushCapture(flushable({ captureBuffer: '' })), false);
  assert.equal(shouldFlushCapture(flushable({ captureBuffer: null })), false);
  assert.equal(shouldFlushCapture(flushable({ captureBuffer: undefined })), false);
  assert.equal(shouldFlushCapture(flushable({ captureBuffer: 123 })), false);
});

test('shouldFlushCapture: not busy (idle/finished) → false', () => {
  assert.equal(shouldFlushCapture(flushable({ busy: false })), false);
  assert.equal(shouldFlushCapture(flushable({ busy: undefined })), false);
  // Only the literal busy:true flag flushes — a truthy string does not.
  assert.equal(shouldFlushCapture(flushable({ busy: 'busy' })), false);
});

test('shouldFlushCapture: null / partial state → false (never throws)', () => {
  assert.equal(shouldFlushCapture(null), false);
  assert.equal(shouldFlushCapture(undefined), false);
  assert.equal(shouldFlushCapture({}), false);
  assert.equal(shouldFlushCapture({ connected: true }), false);
  assert.equal(shouldFlushCapture({ connected: true, threadTs: 'x' }), false);
});

test('lib/slack-proxy.js exports shouldFlushCapture and stays pure', () => {
  assert.match(libSrc, /module\.exports\s*=\s*\{[^}]*shouldFlushCapture[^}]*\}/);
  // No require()/import in the pure module (comments may mention DOM/Electron).
  assert.ok(!/\brequire\s*\(/.test(libSrc), 'lib requires nothing');
  assert.ok(!/\bimport\s/.test(libSrc), 'lib imports nothing');
  // shouldFlushCapture is defined purely in terms of isProxyEnabled + state.
  const body = libSrc.slice(libSrc.indexOf('function shouldFlushCapture(state)'));
  const end = body.indexOf('\n}\n');
  assert.match(body.slice(0, end), /isProxyEnabled\(state\)/);
});

// ===========================================================================
// PART 2 — Source-scan guards: renderer wiring + verbatim mirror
// ===========================================================================

test('renderer mirror slackShouldFlushCapture matches lib and carries the sync note', () => {
  const body = fnBody(rendererSrc, 'function slackShouldFlushCapture(s)');
  assert.match(body, /slackProxyEnabled\(s\)/);
  assert.match(body, /s\.postReplies/);
  assert.match(body, /typeof\s+s\.captureBuffer\s*===\s*'string'/);
  assert.match(body, /s\.captureBuffer\.length\s*>\s*0/);
  assert.match(body, /s\.busy\s*===\s*true/);
  // The "Mirrors … in lib/slack-proxy.js; keep in sync" comment must be present.
  const idx = rendererSrc.indexOf('function slackShouldFlushCapture(s)');
  const preamble = rendererSrc.slice(idx - 400, idx);
  assert.match(preamble, /Mirrors shouldFlushCapture in lib\/slack-proxy\.js; keep in sync/);
});

test('SLACK_FLUSH_INTERVAL_MS default is 30000 and slack state seeds flushTimer', () => {
  assert.match(rendererSrc, /const\s+SLACK_FLUSH_INTERVAL_MS\s*=\s*30000/);
  assert.match(rendererSrc, /flushTimer:\s*null/);
});

test('flushTimer lifecycle: started in startSlackListening, cleared in the three teardown sites', () => {
  assert.match(fnBody(rendererSrc, 'async function startSlackListening(tab)'),
    /startSlackFlushTimer\(tab\)/);
  assert.match(fnBody(rendererSrc, 'function stopSlackListening(tab)'),
    /stopSlackFlushTimer\(tab\)/);
  // start/stop helpers clear-before-set and null the timer (mirror pollTimer).
  assert.match(fnBody(rendererSrc, 'function startSlackFlushTimer(tab)'),
    /if\s*\(s\.flushTimer\)\s*clearInterval\(s\.flushTimer\)/);
  assert.match(fnBody(rendererSrc, 'function startSlackFlushTimer(tab)'),
    /s\.flushTimer\s*=\s*setInterval\([^,]+,\s*SLACK_FLUSH_INTERVAL_MS\)/);
  assert.match(fnBody(rendererSrc, 'function stopSlackFlushTimer(tab)'),
    /if\s*\(s\.flushTimer\)\s*\{\s*clearInterval\(s\.flushTimer\);\s*s\.flushTimer\s*=\s*null/);
  // disconnectSlack and resetSlackForFolder each null the timer explicitly too.
  assert.match(fnBody(rendererSrc, 'function disconnectSlack(tab)'),
    /clearInterval\(s\.flushTimer\);\s*s\.flushTimer\s*=\s*null/);
  assert.match(fnBody(rendererSrc, 'function resetSlackForFolder(tab)'),
    /clearInterval\(s\.flushTimer\);\s*s\.flushTimer\s*=\s*null/);
});

test('slackFlushTick clears the buffer BEFORE the post and reuses cleanTerminalOutput/postToSlack', () => {
  const body = fnBody(rendererSrc, 'async function slackFlushTick(tab)');
  // Builds the decision state with busy from tab.status and defers to the mirror.
  assert.match(body, /busy:\s*tab\.status\s*===\s*'busy'/);
  assert.match(body, /slackShouldFlushCapture\(state\)/);
  // Uses cleanTerminalOutput and clears the buffer before awaiting the post.
  assert.match(body, /cleanTerminalOutput\(s\.captureBuffer\)/);
  const cleanIdx = body.indexOf('cleanTerminalOutput(s.captureBuffer)');
  const clearIdx = body.indexOf("s.captureBuffer = ''");
  const postIdx = body.indexOf('postToSlack(tab, text, s.threadTs)');
  assert.ok(clearIdx !== -1 && postIdx !== -1 && cleanIdx !== -1);
  assert.ok(clearIdx < postIdx, 'buffer cleared before the awaited post');
  assert.ok(clearIdx > cleanIdx, 'buffer read (cleaned) before it is cleared');
  // Empty cleaned text posts nothing (no empty Slack messages).
  assert.match(body, /if\s*\(!text\)\s*return/);
  // Non-empty posts to the anchor thread + mirrors it locally as a claude message.
  assert.match(body, /appendSlackMessage\(tab,\s*\{\s*who:\s*'claude',\s*text\s*\}\)/);
  assert.match(body, /await\s+postToSlack\(tab,\s*text,\s*s\.threadTs\)/);
  // The flush must not touch dispatch state.
  assert.ok(!/awaitingResponse/.test(body), 'flush does not touch awaitingResponse');
  assert.ok(!/s\.inbox/.test(body), 'flush does not touch inbox');
  assert.ok(!/setTabStatus/.test(body), 'flush does not change tab.status');
});

// ===========================================================================
// PART 3 — Harness: once-and-only-once delivery across interval + finish flush
// ===========================================================================

// Verbatim-ish copies of the renderer's flush logic (kept in lockstep with the
// PART 2 source-scans). cleanTerminalOutput is stubbed to a trim so the harness
// focuses on the buffer bookkeeping (consume-before-await) rather than TUI scrub.
function slackProxyEnabled(s) { return !!(s && s.connected && s.threadTs); }
function slackShouldFlushCapture(s) {
  return !!(slackProxyEnabled(s) && s.postReplies &&
    typeof s.captureBuffer === 'string' && s.captureBuffer.length > 0 && s.busy === true);
}

function makeHarness() {
  const posts = []; // every text posted to Slack, in order
  const tab = { status: 'idle', slack: { connected: true, threadTs: 'T1', postReplies: true, captureBuffer: '' } };
  const clean = (raw) => String(raw).trim(); // stand-in for cleanTerminalOutput

  function emit(chunk) { tab.slack.captureBuffer += chunk; }

  async function postToSlack(text) {
    // Simulate an async network post; buffer must already be cleared by callers.
    await Promise.resolve();
    posts.push(text);
    return { ok: true };
  }

  // Mirrors slackFlushTick: clear the buffer BEFORE the await.
  async function flushTick() {
    const s = tab.slack;
    const state = {
      connected: s.connected, threadTs: s.threadTs, postReplies: s.postReplies,
      captureBuffer: s.captureBuffer, busy: tab.status === 'busy',
    };
    if (!slackShouldFlushCapture(state)) return;
    const text = clean(s.captureBuffer);
    s.captureBuffer = '';
    if (!text) return;
    await postToSlack(text);
  }

  // Mirrors slackOnFinished's flush of the remainder at idle.
  async function onFinished() {
    const s = tab.slack;
    if (!slackProxyEnabled(s)) return;
    const reply = clean(s.captureBuffer);
    s.captureBuffer = '';
    if (reply && s.postReplies) await postToSlack(reply);
  }

  return { tab, posts, emit, flushTick, onFinished };
}

test('Harness: interval flushes + finish flush deliver every part exactly once', async () => {
  const h = makeHarness();
  h.tab.status = 'busy';
  // Three interval windows of output, then a remainder that only the finish flush sees.
  h.emit('alpha');
  await h.flushTick();              // posts "alpha"
  h.emit('beta');
  await h.flushTick();              // posts "beta"
  h.emit('gamma');
  await h.flushTick();              // posts "gamma"
  h.emit('delta');                  // arrives after the last interval tick
  h.tab.status = 'finished';
  await h.onFinished();             // posts "delta"

  assert.deepEqual(h.posts, ['alpha', 'beta', 'gamma', 'delta']);
  // Every part appears exactly once across the whole session (no duplicates).
  const joined = h.posts.join('|');
  for (const part of ['alpha', 'beta', 'gamma', 'delta']) {
    assert.equal(joined.split(part).length - 1, 1, `${part} delivered exactly once`);
  }
});

test('Harness: output arriving DURING a post lands in the next window, never lost or doubled', async () => {
  const h = makeHarness();
  h.tab.status = 'busy';
  h.emit('one');
  // Start the tick but interleave new output before the awaited post resolves.
  const p = h.flushTick();
  h.emit('two'); // arrives while "one" is being posted → buffer already cleared
  await p;
  assert.deepEqual(h.posts, ['one']);
  assert.equal(h.tab.slack.captureBuffer, 'two', '"two" survived for the next window');
  // Next tick delivers "two".
  await h.flushTick();
  assert.deepEqual(h.posts, ['one', 'two']);
});

test('Harness: idle / postReplies-off / disconnected ticks are no-ops', async () => {
  const h = makeHarness();
  // Idle: nothing posts even with a full buffer.
  h.tab.status = 'idle';
  h.emit('while-idle');
  await h.flushTick();
  assert.deepEqual(h.posts, []);
  assert.equal(h.tab.slack.captureBuffer, 'while-idle', 'buffer untouched when idle');

  // postReplies off, busy: still a no-op.
  h.tab.status = 'busy';
  h.tab.slack.postReplies = false;
  await h.flushTick();
  assert.deepEqual(h.posts, []);

  // Disconnected: no-op.
  h.tab.slack.postReplies = true;
  h.tab.slack.connected = false;
  await h.flushTick();
  assert.deepEqual(h.posts, []);
});

test('Harness: a pure-noise buffer cleans to empty → consumed, no empty Slack post', async () => {
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.captureBuffer = '   \n  '; // trims to ''
  await h.flushTick();
  assert.deepEqual(h.posts, [], 'no empty message posted');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed anyway');
});
