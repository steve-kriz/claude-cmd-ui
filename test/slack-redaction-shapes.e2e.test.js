'use strict';

// E2E (cucumber-style) scenarios for TASK-067: the EXTENDED secret token shapes
// added to redactSecrets (Slack xapp-/xoxe-/xoxd-, github_pat_, glpat-, npm_,
// dop_v1_, AIza…, SG.<id>.<secret>, bare JWTs) are REDACTED before they reach
// the Slack anchor thread on BOTH auto-post paths.
//
// These are Given/When/Then scenario cases under node --test (no `cucumber`
// package). They reuse the TASK-061 flush-harness style: an in-memory fake post
// capture, a verbatim copy of cleanTerminalOutput from renderer.js, the SHIPPED
// redactSecrets pure helper (source of truth), and the slackFlushTick /
// slackOnFinished mirrors with redaction wired in exactly where renderer.js does
// it. TASK-063's slack-redaction.e2e.test.js already covers the baseline shapes;
// this file adds proof that the NEW shapes are masked mid-run AND at finish.
//
// ALL network / Slack / DB is mocked: postToSlack is an in-memory fake that
// captures posted text. No real connections of any kind — in-memory fakes only.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { redactSecrets, shouldFlushCapture, isProxyEnabled } = require('../lib/slack-proxy');

const R = '***REDACTED***';

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

// --- Harness: mirrors slackFlushTick / slackOnFinished with the redaction
// wired in on BOTH auto-post paths exactly where renderer.js does it:
// redactSecrets(cleanTerminalOutput(s.captureBuffer)).
function makeHarness() {
  const posts = [];        // every text posted to Slack, in order
  const messages = [];     // local mirror (appendSlackMessage)

  const tab = {
    status: 'idle',
    slack: {
      connected: true, threadTs: 'T1', postReplies: true, captureBuffer: '',
      awaitingResponse: false, replyThreadTs: null, inbox: [], flushTimer: null,
      composer: '',
    },
  };

  // Fake Slack post. NO network — captures text and returns ok.
  async function postToSlack(_tab, text, _threadTs) {
    await Promise.resolve();
    posts.push(text);
    return { ok: true };
  }
  function appendSlackMessage(_tab, msg) { messages.push(msg); }

  function emit(chunk) { tab.slack.captureBuffer += chunk; }

  // Verbatim mirror of renderer slackFlushTick (mid-run flush + redaction).
  async function slackFlushTick() {
    const s = tab.slack;
    if (!s) return;
    const state = {
      connected: s.connected, threadTs: s.threadTs, postReplies: s.postReplies,
      captureBuffer: s.captureBuffer, busy: tab.status === 'busy',
    };
    if (!slackShouldFlushCapture(state)) return;
    const text = redactSecrets(cleanTerminalOutput(s.captureBuffer));
    s.captureBuffer = '';
    if (!text) return;
    appendSlackMessage(tab, { who: 'claude', text });
    await postToSlack(tab, text, s.threadTs);
  }

  // Verbatim mirror of renderer slackOnFinished (idle finish flush + redaction).
  async function slackOnFinished() {
    const s = tab.slack;
    if (!s || !slackProxyEnabled(s)) { if (s) s.awaitingResponse = false; return; }
    const reply = redactSecrets(cleanTerminalOutput(s.captureBuffer));
    s.captureBuffer = '';
    s.awaitingResponse = false;
    s.replyThreadTs = null;
    if (reply) {
      appendSlackMessage(tab, { who: 'claude', text: reply });
      if (s.postReplies) await postToSlack(tab, reply, s.threadTs);
    }
  }

  return { tab, posts, messages, emit, slackFlushTick, slackOnFinished };
}

// ===========================================================================
// Scenario: a Slack app-level token (xapp-) is masked on the mid-run flush.
//   Given a busy run whose buffer holds an xapp- app-level token
//   When the flush interval fires
//   Then the flush post contains ***REDACTED*** and NOT the raw token.
// ===========================================================================
test('Scenario: an xapp- app-level token is masked on the mid-run flush', async () => {
  // Given a connected proxy on a busy run with an xapp- token in the buffer
  const h = makeHarness();
  h.tab.status = 'busy';
  const rawToken = 'xapp-1-A0000-1111-abcdefabcdefabcdef1234567890';
  h.emit('SLACK_APP_TOKEN=' + rawToken + '\n');
  assert.equal(shouldFlushCapture({
    connected: true, threadTs: 'T1', postReplies: true,
    captureBuffer: h.tab.slack.captureBuffer, busy: true,
  }), true);

  // When the flush interval fires
  await h.slackFlushTick();

  // Then exactly one post went out, masked, with no fragment of the raw token
  assert.equal(h.posts.length, 1, 'one flush post');
  assert.match(h.posts[0], /\*\*\*REDACTED\*\*\*/, 'post carries the redaction placeholder');
  assert.ok(!h.posts[0].includes(rawToken), 'the raw xapp- token is NOT in the post');
  assert.ok(!h.posts[0].includes('xapp-'), 'no xapp- prefix leaked');
  assert.ok(!h.messages.some((m) => m.text && m.text.includes(rawToken)),
    'the local message mirror never holds the raw token either');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after flush');
});

// ===========================================================================
// Scenario: a bare JWT is masked on the finish flush.
//   Given a run that produced a 3-part bare JWT, now idle
//   When slackOnFinished posts the remainder
//   Then the posted text has NO raw JWT (no header fragment leaks).
// ===========================================================================
test('Scenario: a bare JWT is masked on the finish flush', async () => {
  // Given a run that produced a base64url JWT (with - and _ in segments)
  const h = makeHarness();
  h.tab.status = 'busy';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123-_';
  h.emit('id_token: ' + jwt + '\n');
  h.tab.status = 'finished';

  // When the run finishes and slackOnFinished flushes the remainder
  await h.slackOnFinished();

  // Then the post went out redacted and no part of the raw JWT leaked
  assert.equal(h.posts.length, 1, 'one finish post');
  assert.match(h.posts[0], /\*\*\*REDACTED\*\*\*/, 'post carries the redaction placeholder');
  assert.ok(!h.posts[0].includes(jwt), 'the raw JWT is NOT in the post');
  assert.ok(!h.posts[0].includes('eyJ'), 'no JWT header fragment leaked');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after finish');
});

// ===========================================================================
// Scenario: a GitLab PAT (glpat-) and a Google API key (AIza…) are masked.
//   Given a busy run whose buffer mixes a glpat- token and an AIza key
//   When the flush interval fires
//   Then both are masked in the single post and neither prefix leaks.
// ===========================================================================
test('Scenario: a GitLab PAT and a Google API key are masked on the flush', async () => {
  // Given a busy run whose output holds both a glpat- token and an AIza key
  const h = makeHarness();
  h.tab.status = 'busy';
  const glpat = 'glpat-ABCDEFghij1234567890xy';
  const aiza = 'AIzaSyA1234567890abcdefghijKLMNOPQRSTU';
  h.emit('gitlab ' + glpat + '\ngmaps ' + aiza + '\n');

  // When the flush interval fires
  await h.slackFlushTick();

  // Then the single post masks both secrets and leaks neither prefix
  assert.equal(h.posts.length, 1, 'one flush post');
  const posted = h.posts[0];
  assert.ok(!posted.includes(glpat), 'the raw glpat- token is masked');
  assert.ok(!posted.includes('glpat-'), 'no glpat- prefix leaked');
  assert.ok(!posted.includes(aiza), 'the raw AIza key is masked');
  assert.ok(!posted.includes('AIzaSy'), 'no AIza key fragment leaked');
  assert.match(posted, /\*\*\*REDACTED\*\*\*/, 'post carries the redaction placeholder');
  // And the ordinary prose framing survived.
  assert.match(posted, /gitlab \*\*\*REDACTED\*\*\*/);
  assert.match(posted, /gmaps \*\*\*REDACTED\*\*\*/);
});

// ===========================================================================
// Scenario (edge / false-positive): ordinary text mentioning "npm" and "SG."
// is posted verbatim on the auto-post path.
//   Given a busy run with a plain line "Installed via npm; see the SG. section"
//   When the flush interval fires
//   Then the exact line is posted unchanged (no placeholder inserted).
// ===========================================================================
test('Scenario: ordinary "npm" / "SG." prose is posted verbatim (no false positive)', async () => {
  // Given a busy run with ordinary, secret-free output that trips the prefixes
  const h = makeHarness();
  h.tab.status = 'busy';
  const plain = 'Installed via npm; see the SG. section';
  h.emit(plain);

  // When the flush interval fires
  await h.slackFlushTick();

  // Then the line is posted exactly as-is, with no placeholder inserted
  assert.deepEqual(h.posts, [plain], 'ordinary npm/SG. prose posted verbatim');
  assert.ok(!h.posts[0].includes(R), 'no redaction applied to ordinary output');
});

// ===========================================================================
// Scenario (integration): NEW shapes stream mid-run AND at finish — BOTH
// auto-post paths redact, so no raw secret of the new shapes reaches Slack.
// ===========================================================================
test('Scenario: across mid-run flush AND finish flush, no raw NEW-shape secret reaches Slack', async () => {
  // Given a busy run that first emits a github_pat_ fine-grained PAT
  const h = makeHarness();
  h.tab.status = 'busy';
  const midPat = 'github_pat_11ABCDEFG0abcdefghij1234567890ABCDEFghijklmnop';
  h.emit('cloning\nGH_TOKEN=' + midPat + '\n');
  // When the mid-run flush fires
  await h.slackFlushTick();
  // And then the run emits an npm token before going idle
  const finTok = 'npm_' + 'a'.repeat(36);
  h.emit('publish ' + finTok + ' done\n');
  h.tab.status = 'finished';
  await h.slackOnFinished();

  // Then two posts went out and neither carries any raw new-shape secret
  assert.equal(h.posts.length, 2, 'one mid-run + one finish post');
  const all = h.posts.join('\n');
  assert.ok(!all.includes(midPat), 'mid-run github_pat_ never posted raw');
  assert.ok(!all.includes('github_pat_'), 'no github_pat_ prefix leaked');
  assert.ok(!all.includes(finTok), 'finish npm_ token never posted raw');
  assert.ok(h.posts[0].includes(R) && h.posts[1].includes(R),
    'both posts carry the redaction placeholder');
  // And ordinary surrounding prose survived on both paths.
  assert.match(all, /cloning/);
  assert.match(all, /publish .* done/);
});

// ===========================================================================
// Scenario (edge/safety): a null/empty buffer at finish posts nothing and
// never throws, and redactSecrets is safe called directly on degenerate input.
// ===========================================================================
test('Scenario: null / empty buffer is safe and never throws on the finish path', async () => {
  // Given redactSecrets called directly with degenerate inputs
  for (const v of ['', null, undefined, 0, 123, {}, [], true]) {
    assert.doesNotThrow(() => redactSecrets(v));
    assert.equal(typeof redactSecrets(v), 'string', 'always returns a string');
  }

  // And a finish flush over an empty buffer posts nothing and does not throw
  const h = makeHarness();
  h.tab.status = 'finished';
  h.tab.slack.captureBuffer = '';
  await assert.doesNotReject(() => h.slackOnFinished());
  assert.deepEqual(h.posts, [], 'nothing posted for an empty buffer');
});

// A guard that the enabled precondition still gates the new-shape redaction path.
test('Scenario (precondition): a disconnected proxy posts no new-shape secret', async () => {
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.connected = false;
  h.emit('SLACK_APP_TOKEN=xapp-1-A0000-1111-abcdefabcdefabcdef1234567890');
  assert.equal(isProxyEnabled({ connected: false, threadTs: 'T1' }), false);
  await h.slackFlushTick();
  assert.deepEqual(h.posts, [], 'nothing posted while proxy disabled');
});
