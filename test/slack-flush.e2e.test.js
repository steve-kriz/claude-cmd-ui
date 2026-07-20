'use strict';

// E2E (cucumber-style) scenarios for TASK-061: post Claude output to the Slack
// anchor thread PERIODICALLY during a long busy run, not only at idle.
//
// These are Given/When/Then scenario cases under node --test (no `cucumber`
// package). They drive an in-memory harness that is a VERBATIM mirror of the
// renderer wiring (renderer.js is a browser script, not require()-able):
//
//   - slackShouldFlushCapture(s)  — mirror of renderer/lib decision.
//   - cleanTerminalOutput(raw)    — copied verbatim from renderer.js so the
//                                   "TUI chrome only" scenario is genuine.
//   - slackFlushTick(tab)         — clears the buffer BEFORE the awaited post.
//   - slackOnFinished(tab)        — the final idle flush of the remainder.
//   - startSlackFlushTimer/stopSlackFlushTimer — the timer lifecycle.
//
// ALL network / Slack / DB is mocked: postToSlack is an in-memory fake that
// captures posted text and can be told to fail (ok:false) for a scenario. No
// real connections of any kind.
//
// The pure decision is ALSO exercised directly against lib/slack-proxy.js so the
// scenarios are anchored to the shipped source of truth, not just the mirror.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldFlushCapture, isProxyEnabled } = require('../lib/slack-proxy');

// --- ANSI + terminal scrub: copied verbatim from renderer.js ----------------
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

function cleanTerminalOutput(raw) {
  if (!raw) return '';
  let text = String(raw).replace(ANSI_RE, '');
  text = text.split('\n').map((line) => {
    const parts = line.split('\r');
    return parts[parts.length - 1];
  }).join('\n');

  const lines = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/[ \t]+$/g, '');
    if (/^[\s│┃┆┇┊┋╎╏╭╮╯╰─━┄┅┈┉┌┐└┘├┤┬┴┼>·•⠀-⣿]*$/.test(line)) continue;
    if (/^\s*>\s*$/.test(line)) continue;
    if (/^\s*\?\s*for shortcuts\s*$/i.test(line)) continue;
    lines.push(line);
  }
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > 12000) out = out.slice(-12000);
  return out;
}

// --- Verbatim mirror of the renderer decision (kept in sync with lib) -------
function slackProxyEnabled(s) { return !!(s && s.connected && s.threadTs); }
function slackShouldFlushCapture(s) {
  return !!(
    slackProxyEnabled(s) &&
    s.postReplies &&
    typeof s.captureBuffer === 'string' &&
    s.captureBuffer.length > 0 &&
    s.busy === true
  );
}

// --- Harness: mirrors slackFlushTick / slackOnFinished / the flush timer ----
function makeHarness() {
  const posts = [];        // every text posted to Slack, in order
  const failures = [];     // surfaced send failures (what postToSlack returned !ok)
  const messages = [];     // local mirror (appendSlackMessage)
  let postResult = { ok: true }; // controllable outcome of the next post(s)

  const tab = {
    status: 'idle',
    slack: {
      connected: true, threadTs: 'T1', postReplies: true, captureBuffer: '',
      flushTimer: null,
    },
  };

  // Fake Slack post. NO network — captures text and returns the scripted result.
  async function postToSlack(_tab, text, _threadTs) {
    await Promise.resolve();
    posts.push(text);
    if (!postResult.ok) {
      // Mirror postToSlack's failure surface (system message + returned error).
      messages.push({ who: 'system', text: 'Slack send failed: ' + postResult.error });
      failures.push(postResult.error);
    }
    return postResult;
  }
  function appendSlackMessage(_tab, msg) { messages.push(msg); }

  function emit(chunk) { tab.slack.captureBuffer += chunk; }
  function setPostResult(r) { postResult = r; }

  // Verbatim mirror of renderer slackFlushTick: build state, defer to the
  // mirror, clean, CLEAR the buffer before the await, skip empty, then post.
  async function slackFlushTick() {
    const s = tab.slack;
    if (!s) return;
    const state = {
      connected: s.connected,
      threadTs: s.threadTs,
      postReplies: s.postReplies,
      captureBuffer: s.captureBuffer,
      busy: tab.status === 'busy',
    };
    if (!slackShouldFlushCapture(state)) return;
    const text = cleanTerminalOutput(s.captureBuffer);
    s.captureBuffer = '';
    if (!text) return;
    appendSlackMessage(tab, { who: 'claude', text });
    await postToSlack(tab, text, s.threadTs);
  }

  // Verbatim mirror of renderer slackOnFinished's flush of the remainder.
  async function slackOnFinished() {
    const s = tab.slack;
    if (!s || !slackProxyEnabled(s)) { if (s) s.awaitingResponse = false; return; }
    const reply = cleanTerminalOutput(s.captureBuffer);
    s.captureBuffer = '';
    s.awaitingResponse = false;
    if (reply) {
      appendSlackMessage(tab, { who: 'claude', text: reply });
      if (s.postReplies) await postToSlack(tab, reply, s.threadTs);
    }
  }

  // Timer lifecycle. Uses a real interval id, but ticks are driven manually to
  // stay deterministic; the point under test is clear-before-set + null-on-stop.
  function startSlackFlushTimer() {
    const s = tab.slack;
    if (s.flushTimer) clearInterval(s.flushTimer);
    s.flushTimer = setInterval(() => {}, 1 << 30); // real handle; never auto-fires here
  }
  function stopSlackFlushTimer() {
    const s = tab.slack;
    if (s.flushTimer) { clearInterval(s.flushTimer); s.flushTimer = null; }
  }
  // A tick only does work while the timer is live (setInterval handle present).
  async function timerTick() {
    if (!tab.slack.flushTimer) return;
    await slackFlushTick();
  }

  return {
    tab, posts, failures, messages,
    emit, setPostResult,
    slackFlushTick, slackOnFinished,
    startSlackFlushTimer, stopSlackFlushTimer, timerTick,
  };
}

// ===========================================================================
// Scenario: output is posted mid-run on the flush interval; buffer empties.
// ===========================================================================
test('Scenario: mid-run flush posts buffered output and empties the buffer', async () => {
  // Given a connected proxy on the anchor thread and a busy run producing output
  const h = makeHarness();
  h.tab.status = 'busy';
  h.emit('building step 1...\n');
  // And the shipped decision agrees this state is flushable
  assert.equal(shouldFlushCapture({
    connected: true, threadTs: 'T1', postReplies: true,
    captureBuffer: h.tab.slack.captureBuffer, busy: true,
  }), true);

  // When the flush interval fires
  await h.slackFlushTick();

  // Then the buffered output is posted to the anchor thread and the buffer is empty
  assert.deepEqual(h.posts, ['building step 1...']);
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer emptied after the flush');
});

// ===========================================================================
// Scenario: no double-posting at end of run — part A flushed mid-run, part B
// produced after; slackOnFinished posts only part B; part A appears once.
// ===========================================================================
test('Scenario: no double-post at end of run (part A mid-run, part B at finish)', async () => {
  // Given a busy run that has produced "part A"
  const h = makeHarness();
  h.tab.status = 'busy';
  h.emit('part A');
  // When the interval flush fires mid-run
  await h.slackFlushTick();          // posts "part A"
  // And then the run produces "part B" before going idle
  h.emit('part B');
  h.tab.status = 'finished';
  // And the run finishes
  await h.slackOnFinished();         // posts only the remainder "part B"

  // Then part A and part B are each posted exactly once, in order
  assert.deepEqual(h.posts, ['part A', 'part B']);
  const joined = h.posts.join('|');
  assert.equal(joined.split('part A').length - 1, 1, 'part A posted exactly once');
  assert.equal(joined.split('part B').length - 1, 1, 'part B posted exactly once');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer fully consumed');
});

// ===========================================================================
// Scenario: idle ticks are no-ops — buffer left for slackOnFinished.
// ===========================================================================
test('Scenario: an idle tick posts nothing and leaves the buffer for the finish flush', async () => {
  // Given output accumulated while the tab is idle (not busy)
  const h = makeHarness();
  h.tab.status = 'idle';
  h.emit('accumulated while idle');
  // And the decision confirms an idle state is not flushable
  assert.equal(shouldFlushCapture({
    connected: true, threadTs: 'T1', postReplies: true,
    captureBuffer: 'x', busy: false,
  }), false);

  // When the flush interval fires
  await h.slackFlushTick();

  // Then nothing is posted and the buffer is preserved for slackOnFinished
  assert.deepEqual(h.posts, []);
  assert.equal(h.tab.slack.captureBuffer, 'accumulated while idle', 'buffer untouched when idle');

  // And when the run later finishes, slackOnFinished posts the accumulated output
  h.tab.status = 'finished';
  await h.slackOnFinished();
  assert.deepEqual(h.posts, ['accumulated while idle']);
});

// ===========================================================================
// Scenario: postReplies off suppresses mid-run posting.
// ===========================================================================
test('Scenario: with postReplies off, a busy-run tick posts nothing', async () => {
  // Given a busy run with buffered output but replies posting turned OFF
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.postReplies = false;
  h.emit('would-be output');
  // And the decision confirms postReplies:false is not flushable
  assert.equal(shouldFlushCapture({
    connected: true, threadTs: 'T1', postReplies: false,
    captureBuffer: 'x', busy: true,
  }), false);

  // When the flush interval fires
  await h.slackFlushTick();

  // Then nothing is posted; mid-run streaming is suppressed
  assert.deepEqual(h.posts, []);
  // The buffer is left untouched (the decision short-circuited before consuming it)
  assert.equal(h.tab.slack.captureBuffer, 'would-be output');
});

// ===========================================================================
// Scenario: only TUI chrome in the window → cleanTerminalOutput yields '' →
// nothing posted, but the buffer is still consumed.
// ===========================================================================
test('Scenario: a TUI-chrome-only window cleans to empty — nothing posted, buffer consumed', async () => {
  // Given a busy run whose buffer holds only terminal redraw chrome
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.captureBuffer = '\x1b[2K╭─────────╮\n│ > │\n╰─────────╯\n? for shortcuts\n';
  // Sanity: this genuinely cleans to the empty string
  assert.equal(cleanTerminalOutput(h.tab.slack.captureBuffer), '');

  // When the flush interval fires
  await h.slackFlushTick();

  // Then no (empty) Slack message is posted, yet the buffer is consumed
  assert.deepEqual(h.posts, [], 'no empty message posted');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed even though nothing was posted');
});

// ===========================================================================
// Scenario (failure path): a flush post fails (ratelimited) → failure surfaced,
// the same text is NOT re-posted, and the next tick still runs.
// ===========================================================================
test('Scenario: a failing flush post surfaces the error, is not retried, and the next tick still runs', async () => {
  // Given a busy run whose first flush post will be rate-limited
  const h = makeHarness();
  h.tab.status = 'busy';
  h.setPostResult({ ok: false, error: 'ratelimited' });
  h.emit('first chunk');

  // When the flush interval fires
  const res1 = await h.slackFlushTick();

  // Then the failure is surfaced (system message) and the buffer was still consumed
  assert.deepEqual(h.posts, ['first chunk'], 'the post was attempted once');
  assert.ok(h.failures.includes('ratelimited'), 'the ratelimited failure was surfaced');
  assert.ok(h.messages.some((m) => m.who === 'system' && /ratelimited/.test(m.text)),
    'a system failure message was recorded locally');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed — the failed text is NOT retried');

  // And when the next interval fires (posting recovers) only NEW output is sent;
  // "first chunk" is never re-posted.
  h.setPostResult({ ok: true });
  h.emit('second chunk');
  await h.slackFlushTick();
  assert.deepEqual(h.posts, ['first chunk', 'second chunk']);
  assert.equal(h.posts.filter((p) => p === 'first chunk').length, 1, 'failed text never re-posted');
});

// ===========================================================================
// Scenario: disconnect clears the flush timer → no further ticks post.
// ===========================================================================
test('Scenario: disconnecting clears the flush timer so later ticks post nothing', async () => {
  // Given a live flush timer on a busy run
  const h = makeHarness();
  h.tab.status = 'busy';
  h.startSlackFlushTimer();
  assert.ok(h.tab.slack.flushTimer, 'timer is live after start');
  h.emit('before disconnect');
  await h.timerTick();               // posts "before disconnect"
  assert.deepEqual(h.posts, ['before disconnect']);

  // When the session disconnects (stopSlackListening -> stopSlackFlushTimer)
  h.stopSlackFlushTimer();
  assert.equal(h.tab.slack.flushTimer, null, 'timer handle nulled on disconnect');

  // And more output arrives and a tick would otherwise fire
  h.emit('after disconnect');
  await h.timerTick();

  // Then nothing further is posted — the timer is gone
  assert.deepEqual(h.posts, ['before disconnect'], 'no further posts after disconnect');
});

// ===========================================================================
// Scenario (edge): re-starting the timer clears the prior one (no leaked timer).
// ===========================================================================
test('Scenario: restarting the flush timer clears the prior handle (clear-before-set)', () => {
  // Given a live flush timer
  const h = makeHarness();
  h.startSlackFlushTimer();
  const first = h.tab.slack.flushTimer;
  assert.ok(first, 'first timer live');

  // When the timer is started again (rapid reconnect)
  h.startSlackFlushTimer();

  // Then a new handle replaces the old one (exactly one live timer)
  assert.ok(h.tab.slack.flushTimer, 'a timer is still live');
  assert.notEqual(h.tab.slack.flushTimer, first, 'prior handle was cleared and replaced');

  // Cleanup so the interval does not keep the test process alive.
  h.stopSlackFlushTimer();
  assert.equal(h.tab.slack.flushTimer, null);
});

// A tiny guard that the proxy-enabled precondition is what gates everything.
test('Scenario (precondition): a disconnected proxy never flushes', async () => {
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.connected = false; // no proxy
  h.emit('orphan output');
  assert.equal(isProxyEnabled({ connected: false, threadTs: 'T1' }), false);
  await h.slackFlushTick();
  assert.deepEqual(h.posts, []);
  assert.equal(h.tab.slack.captureBuffer, 'orphan output', 'buffer untouched when proxy disabled');
});
