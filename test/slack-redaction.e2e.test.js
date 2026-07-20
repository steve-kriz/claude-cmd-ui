'use strict';

// E2E (cucumber-style) scenarios for TASK-063: secrets/tokens in Claude terminal
// output are REDACTED before they are auto-posted to the Slack anchor thread.
//
// These are Given/When/Then scenario cases under node --test (no `cucumber`
// package). They drive an in-memory harness that mirrors the renderer wiring
// (renderer.js is a browser script, not require()-able) in the TASK-061 flush
// harness style:
//
//   - slackShouldFlushCapture(s)  — mirror of the renderer/lib decision.
//   - cleanTerminalOutput(raw)    — copied verbatim from renderer.js so ANSI /
//                                   chrome stripping is genuine before redaction.
//   - redactSecrets(text)         — the SHIPPED pure helper from lib/slack-proxy.js
//                                   (source of truth; renderer mirror proven
//                                   byte-identical in slack-redaction.test.js).
//   - slackFlushTick(tab)         — mid-run flush: clean -> REDACT -> post.
//   - slackOnFinished(tab)        — idle finish flush: clean -> REDACT -> post.
//   - sendSlackComposer(tab)      — user-composed path: posted verbatim, NO redaction.
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

// --- Harness: mirrors slackFlushTick / slackOnFinished / sendSlackComposer ---
// with the TASK-063 redaction wired in on BOTH auto-post paths exactly where
// renderer.js does it: redactSecrets(cleanTerminalOutput(s.captureBuffer)).
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

  // Verbatim mirror of renderer slackFlushTick (TASK-061 + TASK-063 redaction).
  async function slackFlushTick() {
    const s = tab.slack;
    if (!s) return;
    const state = {
      connected: s.connected, threadTs: s.threadTs, postReplies: s.postReplies,
      captureBuffer: s.captureBuffer, busy: tab.status === 'busy',
    };
    if (!slackShouldFlushCapture(state)) return;
    // clean -> REDACT -> post, buffer cleared BEFORE the await.
    const text = redactSecrets(cleanTerminalOutput(s.captureBuffer));
    s.captureBuffer = '';
    if (!text) return;
    appendSlackMessage(tab, { who: 'claude', text });
    await postToSlack(tab, text, s.threadTs);
  }

  // Verbatim mirror of renderer slackOnFinished (idle flush + TASK-063 redaction).
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

  // Verbatim mirror of renderer sendSlackComposer: user-composed text is posted
  // AS TYPED — no redaction (scope is auto terminal output only).
  async function sendSlackComposer() {
    const s = tab.slack;
    if (!slackProxyEnabled(s)) return;
    const text = String(s.composer || '').trim();
    if (!text) return;
    s.composer = '';
    appendSlackMessage(tab, { who: 'me', text });
    await postToSlack(tab, text, s.threadTs);
  }

  return { tab, posts, messages, emit, slackFlushTick, slackOnFinished, sendSlackComposer };
}

// ===========================================================================
// Scenario: API key in output is masked on the mid-run flush.
//   Given a busy run whose buffer holds an exported OPENAI_API_KEY
//   When the flush interval fires
//   Then the post contains ***REDACTED*** and NOT the raw sk- key.
// ===========================================================================
test('Scenario: an API key is masked on the mid-run flush', async () => {
  // Given a connected proxy on a busy run with an API key in the buffer
  const h = makeHarness();
  h.tab.status = 'busy';
  const rawKey = 'sk-abc123DEF456ghi789JKL012mno345';
  h.emit('export OPENAI_API_KEY=' + rawKey + '\n');
  assert.equal(shouldFlushCapture({
    connected: true, threadTs: 'T1', postReplies: true,
    captureBuffer: h.tab.slack.captureBuffer, busy: true,
  }), true);

  // When the flush interval fires
  await h.slackFlushTick();

  // Then exactly one post went out, it is masked, and the raw key never leaked
  assert.equal(h.posts.length, 1, 'one flush post');
  assert.match(h.posts[0], /\*\*\*REDACTED\*\*\*/, 'post carries the redaction placeholder');
  assert.ok(!h.posts[0].includes(rawKey), 'the raw sk- API key is NOT in the post');
  assert.ok(!h.posts[0].includes('sk-abc123'), 'no fragment of the sk- key leaked');
  // And the local mirror shows the same redacted text (never the raw secret)
  assert.ok(!h.messages.some((m) => m.text && m.text.includes(rawKey)),
    'the local message mirror never holds the raw key either');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after flush');
});

// ===========================================================================
// Scenario: a Slack bot token is masked on the finish flush.
//   Given a run that produced a xoxb- token, now idle
//   When slackOnFinished posts the remainder
//   Then the post does NOT contain the raw xoxb- token.
// ===========================================================================
test('Scenario: a Slack bot token is masked on the finish flush', async () => {
  // Given a run that produced a bot token and has gone idle
  const h = makeHarness();
  h.tab.status = 'busy';
  const rawToken = 'xoxb-1234-5678-abcdefghijklmnop';
  h.emit('token=' + rawToken + '\n');
  h.tab.status = 'finished';

  // When the run finishes and slackOnFinished flushes the remainder
  await h.slackOnFinished();

  // Then the post went out redacted and the raw xoxb- token never leaked
  assert.equal(h.posts.length, 1, 'one finish post');
  assert.ok(!h.posts[0].includes(rawToken), 'the raw xoxb- token is NOT in the post');
  assert.ok(!h.posts[0].includes('xoxb-'), 'no xoxb- prefix leaked');
  assert.match(h.posts[0], /\*\*\*REDACTED\*\*\*/, 'post carries the redaction placeholder');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after finish');
});

// ===========================================================================
// Scenario: ordinary output is posted verbatim (no false-positive redaction).
//   Given a busy run with a plain build-success line
//   When the flush interval fires
//   Then the exact line is posted unchanged.
// ===========================================================================
test('Scenario: ordinary build output is posted verbatim (no false positives)', async () => {
  // Given a busy run with ordinary, secret-free output
  const h = makeHarness();
  h.tab.status = 'busy';
  const plain = 'Build succeeded in 12s, 40 files compiled';
  h.emit(plain);

  // When the flush interval fires
  await h.slackFlushTick();

  // Then the line is posted exactly as-is, with no placeholder inserted
  assert.deepEqual(h.posts, [plain], 'ordinary output posted verbatim');
  assert.ok(!h.posts[0].includes(R), 'no redaction applied to ordinary output');
});

// ===========================================================================
// Scenario: Bearer and AKIA/ghp_ shapes are masked; a short hex is NOT.
//   Given a busy run whose buffer mixes secrets with a short ordinary hex
//   When the flush interval fires
//   Then each secret shape is masked but the short "abc123" survives.
// ===========================================================================
test('Scenario: Bearer + AKIA + ghp_ are masked, a short hex is left alone', async () => {
  // Given a busy run whose output mixes several secret shapes with a short hex
  const h = makeHarness();
  h.tab.status = 'busy';
  const bearer = 'Authorization: Bearer abc123DEF456ghi789jkl012';
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  const gh = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  h.emit([bearer, 'aws ' + aws + ' end', 'remote ' + gh + ' ok', 'short hex abc123 stays'].join('\n'));

  // When the flush interval fires
  await h.slackFlushTick();

  // Then all three secret shapes are masked out of the single post
  assert.equal(h.posts.length, 1);
  const posted = h.posts[0];
  assert.ok(!posted.includes('abc123DEF456ghi789jkl012'), 'Bearer credential masked');
  assert.match(posted, /Bearer \*\*\*REDACTED\*\*\*/, 'Bearer scheme word kept, token masked');
  assert.ok(!posted.includes(aws), 'AWS AKIA key masked');
  assert.ok(!posted.includes(gh), 'ghp_ GitHub token masked');
  // And the short, ordinary hex "abc123" is conservatively left untouched
  assert.match(posted, /short hex abc123 stays/, 'short hex below threshold survives');
});

// ===========================================================================
// Scenario (edge): the user-composed path is NOT redacted.
//   Given the user typed a message that happens to contain a token
//   When sendSlackComposer posts it
//   Then it is posted verbatim (auto-redaction scope is terminal output only).
// ===========================================================================
test('Scenario: a user-composed message is posted verbatim (composer path not redacted)', async () => {
  // Given the user typed a message containing a token-shaped string
  const h = makeHarness();
  const typed = 'please rotate xoxb-1234-5678-abcdefghijklmnop for me';
  h.tab.slack.composer = typed;

  // When the composer send fires
  await h.sendSlackComposer();

  // Then the message is posted exactly as typed — no redaction on this path
  assert.deepEqual(h.posts, [typed], 'composer text posted verbatim');
  assert.ok(!h.posts[0].includes(R), 'composer path is not redacted by design');
});

// ===========================================================================
// Scenario (edge/safety): redactSecrets never throws on empty/null/undefined.
//   Given a finish flush where the cleaned buffer is empty
//   When slackOnFinished runs
//   Then it posts nothing and does not throw; and redactSecrets is safe directly.
// ===========================================================================
test('Scenario: empty / null / undefined input is safe and never throws', async () => {
  // Given redactSecrets called directly with degenerate inputs
  assert.doesNotThrow(() => redactSecrets(''));
  assert.doesNotThrow(() => redactSecrets(null));
  assert.doesNotThrow(() => redactSecrets(undefined));
  for (const v of ['', null, undefined, 123, {}, []]) {
    assert.equal(typeof redactSecrets(v), 'string', 'always returns a string');
  }

  // And a finish flush over an empty buffer posts nothing and does not throw
  const h = makeHarness();
  h.tab.status = 'finished';
  h.tab.slack.captureBuffer = '';
  await assert.doesNotReject(() => h.slackOnFinished());
  assert.deepEqual(h.posts, [], 'nothing posted for an empty buffer');
});

// ===========================================================================
// Scenario (integration): a run streams a secret mid-run and more secrets at
// finish — BOTH auto-post paths redact, so no raw secret ever reaches Slack.
// ===========================================================================
test('Scenario: across mid-run flush AND finish flush, no raw secret ever reaches Slack', async () => {
  // Given a busy run that first emits an API key
  const h = makeHarness();
  h.tab.status = 'busy';
  const midKey = 'sk-MIDrunKEY0123456789abcdefXYZ';
  h.emit('starting up\nAPI_KEY=' + midKey + '\n');
  // When the mid-run flush fires
  await h.slackFlushTick();
  // And then the run emits an AWS key before going idle
  const finKey = 'AKIAABCDEFGHIJKLMNOP';
  h.emit('cleanup ' + finKey + ' done\n');
  h.tab.status = 'finished';
  await h.slackOnFinished();

  // Then two posts went out and neither carries any raw secret
  assert.equal(h.posts.length, 2, 'one mid-run + one finish post');
  const all = h.posts.join('\n');
  assert.ok(!all.includes(midKey), 'mid-run API key never posted raw');
  assert.ok(!all.includes(finKey), 'finish AWS key never posted raw');
  assert.ok(h.posts[0].includes(R) && h.posts[1].includes(R),
    'both posts carry the redaction placeholder');
  // And ordinary surrounding prose survived on both paths
  assert.match(all, /starting up/);
  assert.match(all, /cleanup .* done/);
});

// ===========================================================================
// TASK-068 — inline connection-string credentials scheme://user:pass@host:
// the password is masked through the auto-post paths, keeping scheme/user/host
// readable; credential-free URLs are posted verbatim.
// ===========================================================================

// ---------------------------------------------------------------------------
// Scenario: a Postgres connection-string password is masked on the mid-run flush.
//   Given a busy run whose buffer holds DATABASE_URL=postgres://user:hunter2@db:5432/app
//   When the flush interval fires
//   Then the post contains postgres://user:***REDACTED***@db:5432/app and NOT "hunter2".
// ---------------------------------------------------------------------------
test('Scenario: a Postgres URL password is masked on the mid-run flush, host readable', async () => {
  // Given a connected proxy on a busy run with a Postgres connection string
  const h = makeHarness();
  h.tab.status = 'busy';
  h.emit('DATABASE_URL=postgres://user:hunter2@db:5432/app\n');

  // When the flush interval fires
  await h.slackFlushTick();

  // Then exactly one post went out, the password is masked and scheme/user/host survive
  assert.equal(h.posts.length, 1, 'one flush post');
  assert.match(h.posts[0], /postgres:\/\/user:\*\*\*REDACTED\*\*\*@db:5432\/app/,
    'password masked, scheme + user + host + port + path kept readable');
  assert.ok(!h.posts[0].includes('hunter2'), 'the raw password never leaked');
  assert.ok(!h.messages.some((m) => m.text && m.text.includes('hunter2')),
    'the local message mirror never holds the raw password either');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after flush');
});

// ---------------------------------------------------------------------------
// Scenario: a password-only redis connection string is masked on the finish flush.
//   Given a run that produced redis://:s3cr3t@cache:6379, now idle
//   When slackOnFinished posts the remainder
//   Then the post does NOT contain "s3cr3t" and keeps redis://:***REDACTED***@cache:6379.
// ---------------------------------------------------------------------------
test('Scenario: a password-only redis URL is masked on the finish flush', async () => {
  // Given a run that emitted a password-only redis URL and has gone idle
  const h = makeHarness();
  h.tab.status = 'busy';
  h.emit('connecting to redis://:s3cr3t@cache:6379\n');
  h.tab.status = 'finished';

  // When the run finishes and slackOnFinished flushes the remainder
  await h.slackOnFinished();

  // Then the post went out with the password masked, empty user + host kept
  assert.equal(h.posts.length, 1, 'one finish post');
  assert.match(h.posts[0], /redis:\/\/:\*\*\*REDACTED\*\*\*@cache:6379/,
    'password-only form masked, host readable');
  assert.ok(!h.posts[0].includes('s3cr3t'), 'the raw password never leaked');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after finish');
});

// ---------------------------------------------------------------------------
// Scenario (edge): credential-free URLs are posted verbatim (no false positives).
//   Given a busy run whose buffer holds a plain https URL and a host:port URL
//   When the flush interval fires
//   Then both URLs are posted exactly as-is with no placeholder inserted.
// ---------------------------------------------------------------------------
test('Scenario: credential-free URLs (no user:pass@) are posted verbatim', async () => {
  // Given a busy run whose output holds URLs with NO inline credentials
  const h = makeHarness();
  h.tab.status = 'busy';
  const line1 = 'fetching https://example.com/api/v1/status';
  const line2 = 'proxy http://host:8080/path';
  h.emit([line1, line2].join('\n'));

  // When the flush interval fires
  await h.slackFlushTick();

  // Then both URLs survive untouched — a bare host:port is NOT a credential
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0], /fetching https:\/\/example\.com\/api\/v1\/status/,
    'credential-free https URL verbatim');
  assert.match(h.posts[0], /proxy http:\/\/host:8080\/path/,
    'host:port with no @ is left intact');
  assert.ok(!h.posts[0].includes(R), 'no redaction applied to credential-free URLs');
});

// ---------------------------------------------------------------------------
// Scenario (edge/safety): an empty finish flush over a would-be conn-string
// buffer posts nothing and never throws (null/empty safe on the auto-post path).
// ---------------------------------------------------------------------------
test('Scenario: an empty buffer finish flush is null/empty safe and posts nothing', async () => {
  // Given a finished run whose capture buffer is empty
  const h = makeHarness();
  h.tab.status = 'finished';
  h.tab.slack.captureBuffer = '';

  // When slackOnFinished runs it must not throw and must post nothing
  await assert.doesNotReject(() => h.slackOnFinished());
  assert.deepEqual(h.posts, [], 'nothing posted for an empty buffer');
  // And redactSecrets itself is safe on the degenerate connection-string inputs
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
});

// A guard that the enabled precondition still gates the auto-post redaction path.
test('Scenario (precondition): a disconnected proxy posts nothing (no leak path)', async () => {
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.connected = false;
  h.emit('API_KEY=sk-shouldNeverLeak0123456789abc');
  assert.equal(isProxyEnabled({ connected: false, threadTs: 'T1' }), false);
  await h.slackFlushTick();
  assert.deepEqual(h.posts, [], 'nothing posted while proxy disabled');
});
