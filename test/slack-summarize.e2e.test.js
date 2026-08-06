'use strict';

// E2E (cucumber-style) scenarios for TASK-073: auto-posted Slack output is
// summarized by a fast LLM AFTER it has been cleaned (TASK-071) and redacted
// (TASK-063). The two auto-post paths (slackFlushTick + slackOnFinished) run:
//
//   postToSlack( redactSecrets( summarize( redactSecrets(
//                humanizeSlackOutput( cleanTerminalOutput(buffer) ) ) ) ) )
//
// i.e. redact BEFORE the summarizer sees the text (security), then redact the
// returned summary AGAIN so redactSecrets stays LAST before postToSlack.
//
// These are Given/When/Then scenario cases under node --test (the `cucumber`
// npm package is NOT installed and is not used). They drive an in-memory harness
// that mirrors the renderer wiring (renderer.js is a browser script, not
// require()-able) in the TASK-061/063/071 flush-harness style, with the ONE
// external boundary — window.api.slack.summarize — wired to the REAL
// lib/slack-summarize.js summarizeForSlack + the REAL redactSecrets, and only
// the network client (httpRequest) faked. NO real network / API / DB / key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { redactSecrets, humanizeSlackOutput } = require('../lib/slack-proxy');
const { summarizeForSlack } = require('../lib/slack-summarize');

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

// A body long enough to be summarized (> the module's 200-char threshold).
function padded(s) { return s + '\n' + 'log detail '.repeat(30); }

// Anthropic Messages API success body: first text block is the summary.
function okBody(summary) {
  return JSON.stringify({ content: [{ type: 'text', text: summary }] });
}

// --- Harness: mirrors slackFlushTick / slackOnFinished with the TASK-073
// pipeline. The ONE external boundary (window.api.slack.summarize) is wired to
// the REAL summarizeForSlack + REAL redactSecrets, faking only the network
// client via `httpRequest`, exactly mirroring main.js's slack:summarize handler.
//
// opts.httpRequest — fake network client (records/answers); records go to
//                    opts.httpCalls if provided.
// opts.apiKey      — the key main.js would read from envStore (default set).
function makeHarness(opts = {}) {
  const posts = [];        // every text posted to Slack, in order
  const messages = [];     // local mirror (appendSlackMessage)
  const httpCalls = opts.httpCalls || [];
  const apiKey = 'apiKey' in opts ? opts.apiKey : 'sk-mock-anthropic-key-0123456789';
  const httpRequest = opts.httpRequest || (async () => ({ status: 200, body: okBody('mock summary') }));

  const tab = {
    status: 'idle',
    slack: {
      connected: true, threadTs: 'T1', postReplies: true, captureBuffer: '',
      awaitingResponse: false, replyThreadTs: null, inbox: [], flushTimer: null,
      summarize: false,
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

  // Mirror of preload's window.api.slack.summarize + main.js slack:summarize
  // handler: reads the key, injects redactSecrets as the redact-before-send
  // pass, calls the REAL summarizer with the FAKE network client, and returns
  // { ok, text, summarized } — never throwing.
  const windowApi = {
    slack: {
      async summarize(text, enabled) {
        const input = typeof text === 'string' ? text : '';
        try {
          const res = await summarizeForSlack(input, {
            apiKey, enabled: !!enabled, redact: redactSecrets, httpRequest,
          });
          return { ok: true, text: res.text, summarized: res.summarized };
        } catch (err) {
          return { ok: true, text: input, summarized: false, error: err && err.message };
        }
      },
    },
  };

  // Mirror of renderer slackSummarizeOutput: always returns a string, never
  // throws; returns the INPUT unchanged when the toggle is off / call fails.
  async function slackSummarizeOutput(t, text) {
    const s = t.slack;
    if (!s || !s.summarize || !text) return text;
    try {
      const res = await windowApi.slack.summarize(text, true);
      if (res && res.ok && typeof res.text === 'string' && res.text) return res.text;
    } catch (_) { /* fall through */ }
    return text;
  }

  // Mirror of renderer slackFlushTick (TASK-061 + 071 + 063 + 073).
  async function slackFlushTick() {
    const s = tab.slack;
    if (!s) return;
    const state = {
      connected: s.connected, threadTs: s.threadTs, postReplies: s.postReplies,
      captureBuffer: s.captureBuffer, busy: tab.status === 'busy',
    };
    if (!slackShouldFlushCapture(state)) return;
    // redact(humanize(clean(buffer))) — buffer cleared BEFORE the await.
    const inner = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)));
    s.captureBuffer = '';
    if (!inner) return;
    // redact → summarize → redact (redact LAST).
    const summarized = await slackSummarizeOutput(tab, inner);
    const text = redactSecrets(summarized);
    if (!text) return;
    appendSlackMessage(tab, { who: 'claude', text });
    await postToSlack(tab, text, s.threadTs);
  }

  // Mirror of renderer slackOnFinished (idle flush + 071 + 063 + 073).
  async function slackOnFinished() {
    const s = tab.slack;
    if (!s || !slackProxyEnabled(s)) { if (s) s.awaitingResponse = false; return; }
    const inner = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)));
    s.captureBuffer = '';
    s.awaitingResponse = false;
    s.replyThreadTs = null;
    if (inner) {
      const summarized = await slackSummarizeOutput(tab, inner);
      const reply = redactSecrets(summarized);
      if (reply) {
        appendSlackMessage(tab, { who: 'claude', text: reply });
        if (s.postReplies) await postToSlack(tab, reply, s.threadTs);
      }
    }
  }

  return { tab, posts, messages, httpCalls, emit, slackFlushTick, slackOnFinished, slackSummarizeOutput };
}

// ===========================================================================
// Scenario: Cleaned output is summarized before posting.
//   Given a configured API key and a busy window with long, cleaned output
//   When the finish flush runs
//   Then the Anthropic client is called with the already-redacted cleaned text
//   And a concise summary is posted to the anchor thread.
// ===========================================================================
test('Scenario: cleaned output is summarized before posting (client sees redacted text, summary posted)', async () => {
  // Given a configured key, summarization ON, and long cleaned output
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('Tests passed; renderer.js updated.') }; };
  const h = makeHarness({ httpRequest: http, httpCalls });
  h.tab.slack.summarize = true;
  h.tab.status = 'busy';
  h.emit(padded('Running the full test suite\nAll 42 tests passed\nedited renderer/renderer.js'));
  h.tab.status = 'finished';

  // When the finish flush runs
  await h.slackOnFinished();

  // Then the client was called once with the cleaned text and a summary posted
  assert.equal(httpCalls.length, 1, 'the Anthropic client was called exactly once');
  assert.match(httpCalls[0].text, /All 42 tests passed/, 'the client received the cleaned output');
  assert.deepEqual(h.posts, ['Tests passed; renderer.js updated.'], 'the concise summary is posted');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after finish');
});

// ===========================================================================
// Scenario: Secrets are redacted before the text leaves the process (security).
//   Given cleaned output that contained "sk-abc123DEF456ghi789" before redaction
//   When the flush requests a summary
//   Then the text passed to the client contains "***REDACTED***" and never the raw key.
// ===========================================================================
test('Scenario: secrets are redacted before the text leaves the process (security)', async () => {
  // Given a busy window whose buffer holds an exported API key
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('summary of the deploy') }; };
  const h = makeHarness({ httpRequest: http, httpCalls });
  h.tab.slack.summarize = true;
  h.tab.status = 'busy';
  const rawKey = 'sk-abc123DEF456ghi789JKL012mno345';
  h.emit(padded('deploying now\nexport OPENAI_API_KEY=' + rawKey));

  // When the periodic flush requests a summary
  await h.slackFlushTick();

  // Then the EXACT argument handed to the network boundary is redacted
  assert.equal(httpCalls.length, 1, 'the client boundary was reached');
  const outbound = httpCalls[0].text;
  assert.match(outbound, /\*\*\*REDACTED\*\*\*/, 'outbound text carries the redaction placeholder');
  assert.ok(!outbound.includes(rawKey), 'the raw sk- key NEVER reaches the client boundary');
  assert.ok(!outbound.includes('sk-abc123'), 'no fragment of the key leaked to the client');
  // And nothing raw leaked to Slack or the local mirror either.
  assert.ok(!h.posts.some((p) => p.includes(rawKey)), 'no raw key posted to Slack');
  assert.ok(!h.messages.some((m) => m.text && m.text.includes(rawKey)), 'no raw key in the local mirror');
});

// ===========================================================================
// Scenario: No API key falls back to the cleaned output (edge).
//   Given no LOG_REDACTING_ANTHROPIC_KEY is configured
//   When the flush runs
//   Then no API call is made and the TASK-071 cleaned+redacted output is posted.
// ===========================================================================
test('Scenario: no API key → no API call, TASK-071 cleaned+redacted output posted', async () => {
  // Given summarization is ON but NO key is configured
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('should never be used') }; };
  const h = makeHarness({ httpRequest: http, httpCalls, apiKey: '' });
  h.tab.slack.summarize = true;
  h.tab.status = 'busy';
  h.emit(padded('Build succeeded in 12s\n40 files compiled'));
  h.tab.status = 'finished';

  // When the finish flush runs
  await h.slackOnFinished();

  // Then no API call was made and the cleaned+redacted TASK-071 text is posted
  assert.equal(httpCalls.length, 0, 'no API call without a key');
  assert.equal(h.posts.length, 1, 'one post');
  const expected = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(
    padded('Build succeeded in 12s\n40 files compiled'))));
  assert.equal(h.posts[0], expected, 'posts exactly the TASK-071 cleaned+redacted output');
});

// ===========================================================================
// Scenario: Summarizer error/timeout never loses the post (failure).
//   Drives the non-200, malformed-json, network-error and timeout branches;
//   in every case the cleaned+redacted output is posted and nothing throws.
// ===========================================================================
const FAILURE_MODES = [
  ['non-200 status', async () => ({ status: 503, body: 'service unavailable' })],
  ['malformed JSON body', async () => ({ status: 200, body: 'not-json {{{' })],
  ['network error (reject)', async () => { throw new Error('ECONNRESET'); }],
  ['timeout (reject)', async () => { throw new Error('anthropic request timed out'); }],
];

for (const [label, http] of FAILURE_MODES) {
  test(`Scenario: summarizer failure (${label}) → cleaned+redacted output posted, nothing throws`, async () => {
    // Given a configured key but a failing summarizer
    const h = makeHarness({ httpRequest: http });
    h.tab.slack.summarize = true;
    h.tab.status = 'busy';
    const raw = padded('starting task\nran npm test\nedited lib/slack-summarize.js');
    h.emit(raw);
    h.tab.status = 'finished';

    // When the finish flush runs it must NOT throw
    await assert.doesNotReject(() => h.slackOnFinished());

    // Then the cleaned+redacted TASK-071 output is posted (fallback), never lost
    const expected = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(raw)));
    assert.deepEqual(h.posts, [expected], `${label}: fallback to cleaned+redacted output`);
    assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed once (no duplicate/lost post)');
  });
}

// ===========================================================================
// Scenario: Summarization disabled behaves exactly like TASK-071 (edge).
//   Given the Slack-summarization setting is off
//   When the flush runs
//   Then no API call is made and the output is posted exactly as TASK-071 would.
// ===========================================================================
test('Scenario: summarization disabled (toggle off) → no API call, behaves exactly like TASK-071', async () => {
  // Given summarization OFF (default) with a valid key present
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('never called') }; };
  const h = makeHarness({ httpRequest: http, httpCalls });
  h.tab.slack.summarize = false; // default OFF
  h.tab.status = 'busy';
  const raw = padded('Compiling project\nBuild succeeded');
  h.emit(raw);

  // When the periodic flush runs
  await h.slackFlushTick();

  // Then no summary was requested and the TASK-071 output is posted verbatim
  assert.equal(httpCalls.length, 0, 'no API call while the toggle is off');
  const expected = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(raw)));
  assert.deepEqual(h.posts, [expected], 'off behaves exactly like TASK-071');
});

// ===========================================================================
// Scenario: the returned summary is redacted AGAIN before posting (redact-AFTER).
//   Given the model echoes a secret-shaped string in its summary
//   When the flush posts the summary
//   Then the posted text is redacted and never carries the raw secret.
// ===========================================================================
test('Scenario: redact-AFTER — a secret echoed by the model is redacted before posting', async () => {
  // Given a model whose summary text contains a secret-shaped token
  const leakedKey = 'sk-MODELechoedSECRET0123456789abcXYZ';
  const http = async () => ({ status: 200, body: okBody('Summary: rotate the key ' + leakedKey + ' immediately.') });
  const h = makeHarness({ httpRequest: http });
  h.tab.slack.summarize = true;
  h.tab.status = 'busy';
  h.emit(padded('rotating credentials as requested'));
  h.tab.status = 'finished';

  // When the finish flush posts the summary
  await h.slackOnFinished();

  // Then the posted summary is re-redacted — the raw secret never reaches Slack
  assert.equal(h.posts.length, 1, 'one post');
  assert.match(h.posts[0], /Summary: rotate the key \*\*\*REDACTED\*\*\* immediately\./,
    'the echoed secret is masked by the final redactSecrets');
  assert.ok(!h.posts[0].includes(leakedKey), 'the raw echoed key is NOT posted');
  assert.ok(!h.messages.some((m) => m.text && m.text.includes(leakedKey)),
    'the local mirror never holds the raw echoed key');
});

// ===========================================================================
// Scenario (edge): short/pure-noise windows are not summarized (cost guard).
// ===========================================================================
test('Scenario: a short window skips the summarizer (below threshold) and posts TASK-071 output', async () => {
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('unused') }; };
  const h = makeHarness({ httpRequest: http, httpCalls });
  h.tab.slack.summarize = true;
  h.tab.status = 'busy';
  h.emit('done'); // well under the 200-char threshold

  await h.slackFlushTick();

  assert.equal(httpCalls.length, 0, 'no API round-trip for a trivial window');
  assert.deepEqual(h.posts, ['done'], 'the short cleaned output is posted verbatim');
});

test('Scenario: a pure-noise window posts nothing and never calls the summarizer', async () => {
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('unused') }; };
  const h = makeHarness({ httpRequest: http, httpCalls });
  h.tab.slack.summarize = true;
  h.tab.status = 'busy';
  h.tab.slack.captureBuffer = [
    '✻ Thinking… (esc to interrupt)',
    '(esc to interrupt)',
    '↑ 1.2k tokens',
  ].join('\n') + '\n';

  await h.slackFlushTick();

  assert.deepEqual(h.posts, [], 'nothing posted for pure noise');
  assert.equal(httpCalls.length, 0, 'no summary requested for an empty-after-clean window');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed even though nothing posted');
});

// ===========================================================================
// Source-scan: BOTH auto-post paths apply the TASK-073 pipeline —
//   redact(humanize(clean(buffer))) → summarize → redact  (redact LAST) —
// with the buffer cleared BEFORE the await. (Pattern from the TASK-071 scans.)
// ===========================================================================

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

// The inner redact-before-send pass: redact(humanize(clean(buffer))).
const INNER = /redactSecrets\(humanizeSlackOutput\(cleanTerminalOutput\(s\.captureBuffer\)\)\)/;

function assertPipelineOrder(body, name) {
  // inner redact-before-send present
  assert.match(body, INNER, `${name}: redact-before-send wraps humanize(clean(buffer))`);
  const iInner = body.search(INNER);
  const iClear = body.indexOf("s.captureBuffer = ''");
  const iSummarize = body.indexOf('slackSummarizeOutput(tab, ');
  const iAwaitSummarize = body.indexOf('await slackSummarizeOutput(tab, ');
  const iOuterRedact = body.indexOf('redactSecrets(summarized)');
  const iPost = body.indexOf('postToSlack(tab,');

  assert.ok(iSummarize !== -1, `${name}: calls slackSummarizeOutput`);
  assert.ok(iAwaitSummarize !== -1, `${name}: awaits the summarizer`);
  assert.ok(iOuterRedact !== -1, `${name}: re-redacts the summary (redact-AFTER)`);
  assert.ok(iPost !== -1, `${name}: posts to Slack`);

  // Order: inner redact → clear buffer → await summarize → outer redact → post
  assert.ok(iInner < iClear, `${name}: inner redact runs before the buffer clear`);
  assert.ok(iClear < iAwaitSummarize, `${name}: buffer cleared BEFORE the summarizer await`);
  assert.ok(iSummarize < iOuterRedact, `${name}: summarize sits INSIDE the outer redactSecrets`);
  assert.ok(iOuterRedact < iPost, `${name}: redactSecrets is the LAST transform before postToSlack`);
}

test('slackFlushTick: pipeline is redact→summarize→redact, buffer cleared before the await', () => {
  const body = fnBody(rendererSrc, 'async function slackFlushTick(tab)');
  assertPipelineOrder(body, 'slackFlushTick');
});

test('slackOnFinished: pipeline is redact→summarize→redact, buffer cleared before the await', () => {
  const body = fnBody(rendererSrc, 'async function slackOnFinished(tab)');
  assertPipelineOrder(body, 'slackOnFinished');
});

test('slackOnFinished is async (it awaits the LLM summary)', () => {
  assert.match(rendererSrc, /async function slackOnFinished\(tab\)/,
    'the finish path is async so it can await the summarizer');
});

test('EVERY auto-post path that summarizes re-redacts before posting (no bypass)', () => {
  // Each summarize call on a post path must be followed by a redactSecrets(...)
  // that feeds the post — count them to prove neither path skips the redact-after.
  const summarizeUses = [...rendererSrc.matchAll(/await slackSummarizeOutput\(tab, /g)];
  const reRedacts = [...rendererSrc.matchAll(/redactSecrets\(summarized\)/g)];
  assert.ok(summarizeUses.length >= 2, 'both auto-post paths summarize');
  assert.equal(reRedacts.length, summarizeUses.length,
    'every summarize on a post path is followed by a redactSecrets(summarized)');
});

test('slackSummarizeOutput always returns a string and never throws into the flush path', () => {
  const body = fnBody(rendererSrc, 'async function slackSummarizeOutput(tab, text)');
  assert.match(body, /try\s*{/, 'wraps the IPC call in try/catch');
  assert.match(body, /catch\s*\(_?\w*\)\s*{/, 'swallows summarizer errors');
  assert.match(body, /return text/, 'falls back to the unchanged input text');
});

test('default summarize state is OFF (opt-in)', () => {
  assert.match(rendererSrc, /summarize:\s*false/, 'slack state defaults summarize to false');
});

// ===========================================================================
// TASK-077 — Feature: The slack:summarize handler bounds its input size
// (defense-in-depth). The clamp lives in the Electron main process, which is
// not require()-able, so — following the established slack-*.e2e pattern — we
// combine a SOURCE-SCAN pinning main.js's clamp with a BEHAVIORAL run through a
// byte-for-byte mirror of the handler into the REAL summarizeForSlack + REAL
// redactSecrets, faking ONLY the network client. NO real network / API / key.
// ===========================================================================

const MAIN_JS = path.join(__dirname, '..', 'main.js');
const mainSrc = fs.readFileSync(MAIN_JS, 'utf8').replace(/\r\n/g, '\n');

// The shared cap: the renderer's cleanTerminalOutput keeps a 12,000-char tail
// and main mirrors it. Pinned so the mirror below cannot silently diverge.
const SLACK_SUMMARIZE_MAX_INPUT_CHARS = 12000;

// Mirror of the REAL main.js slack:summarize handler (main.js ~1679-1700):
// coerce non-strings to '', CLAMP to the tail before the summarizer, inject
// redactSecrets as the redact-before-send pass, and never throw. Faithfully
// reproduces the clamp-then-summarize order the source-scan below pins.
async function mainSlackSummarizeHandler({ text, enabled }, { apiKey, httpRequest }) {
  const raw = typeof text === 'string' ? text : '';
  const input = raw.length > SLACK_SUMMARIZE_MAX_INPUT_CHARS
    ? raw.slice(-SLACK_SUMMARIZE_MAX_INPUT_CHARS)
    : raw;
  try {
    const res = await summarizeForSlack(input, {
      apiKey, enabled: !!enabled, redact: redactSecrets, httpRequest,
    });
    return { ok: true, text: res.text, summarized: res.summarized };
  } catch (err) {
    return { ok: true, text: input, summarized: false, error: err && err.message };
  }
}

// ---------------------------------------------------------------------------
// Source-scan: pin the real clamp in main.js (constant, TAIL slice, and that it
// runs BEFORE summarizeForSlack — mirroring the renderer 12,000-char tail).
// ---------------------------------------------------------------------------
test('TASK-077 source-scan: main.js clamps slack:summarize input to the 12,000-char TAIL before summarizeForSlack', () => {
  assert.match(
    mainSrc,
    /const\s+SLACK_SUMMARIZE_MAX_INPUT_CHARS\s*=\s*12000\s*;/,
    'main.js declares the 12,000-char cap constant'
  );
  assert.match(
    mainSrc,
    /raw\.slice\(-SLACK_SUMMARIZE_MAX_INPUT_CHARS\)/,
    'main.js keeps the TAIL (negative slice), mirroring the renderer cleanTerminalOutput tail'
  );
  const iClamp = mainSrc.indexOf('raw.slice(-SLACK_SUMMARIZE_MAX_INPUT_CHARS)');
  const iSummarize = mainSrc.indexOf('summarizeForSlack(input');
  assert.ok(iClamp !== -1 && iSummarize !== -1, 'both the clamp and the summarizer call are present');
  assert.ok(iClamp < iSummarize, 'the clamp runs BEFORE summarizeForSlack (bounds the outbound payload)');
});

// ---------------------------------------------------------------------------
// Scenario: Oversized input is truncated before it reaches the API.
//   Given the slack:summarize handler receives text far larger than the cap
//   When it forwards the text to the summarizer
//   Then the text handed to the (mocked) Anthropic http request is <= the cap
//   And it is still redacted (redact-before-send preserved)
// ---------------------------------------------------------------------------
test('Scenario (TASK-077): oversized input is truncated to the cap before the API and still redacted', async () => {
  // Given a payload FAR larger than the cap, with a secret in the surviving TAIL
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('bounded summary') }; };
  const rawSecret = 'sk-abc123DEF456ghi789JKL012mno345';
  const oversized =
    'export OLD_KEY=sk-truncated-head-secret000000\n' +
    'X'.repeat(30000) +
    '\nexport OPENAI_API_KEY=' + rawSecret + '\nfinal line';
  assert.ok(oversized.length > SLACK_SUMMARIZE_MAX_INPUT_CHARS, 'the input exceeds the cap');

  // When the handler forwards it to the summarizer
  const res = await mainSlackSummarizeHandler(
    { text: oversized, enabled: true },
    { apiKey: 'sk-mock-anthropic-key', httpRequest: http }
  );

  // Then the text at the (mocked) network boundary is <= the cap
  assert.equal(httpCalls.length, 1, 'the Anthropic client boundary was reached once');
  const outbound = httpCalls[0].text;
  assert.ok(
    outbound.length <= SLACK_SUMMARIZE_MAX_INPUT_CHARS,
    'the text handed to the mocked Anthropic http request is <= the 12,000-char cap'
  );
  // And it is still redacted (redact-before-send preserved)
  assert.match(outbound, /\*\*\*REDACTED\*\*\*/, 'the surviving tail secret is masked before send');
  assert.ok(!outbound.includes(rawSecret), 'the raw sk- key NEVER reaches the client boundary');
  assert.ok(!outbound.includes('sk-abc123'), 'no fragment of the tail key leaked to the client');
  assert.equal(res.ok, true);
  assert.equal(res.summarized, true);
});

// ---------------------------------------------------------------------------
// Scenario: Normal-size window is unaffected (edge).
//   Given a cleaned window at or below the cap
//   When it is summarized
//   Then the text is forwarded unchanged apart from the existing redaction
// ---------------------------------------------------------------------------
test('Scenario (TASK-077): a normal <=cap window is forwarded unchanged apart from the existing redaction', async () => {
  // Given a window comfortably under the cap, carrying a secret
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('summary') }; };
  const rawSecret = 'sk-normalWINDOWsecret0123456789abcXYZ';
  const window = 'Build finished.\nexport TOKEN=' + rawSecret + '\n' + padded('all steps green');
  assert.ok(window.length <= SLACK_SUMMARIZE_MAX_INPUT_CHARS, 'the window is at/under the cap');

  // When it is summarized through the handler
  await mainSlackSummarizeHandler(
    { text: window, enabled: true },
    { apiKey: 'sk-mock-anthropic-key', httpRequest: http }
  );

  // Then the boundary sees exactly the redacted window — redacted, NOT truncated
  assert.equal(httpCalls.length, 1, 'the client boundary was reached once');
  assert.equal(
    httpCalls[0].text, redactSecrets(window),
    'a normal window reaches the boundary byte-identically to prior behavior (redaction only)'
  );
  assert.ok(!httpCalls[0].text.includes(rawSecret), 'the secret is still redacted');
});

// ---------------------------------------------------------------------------
// Scenario (edge/failure): non-string / empty input is handled as today —
// clamped to '' without throwing, no API round-trip.
// ---------------------------------------------------------------------------
test('Scenario (TASK-077 edge): non-string / empty input is handled as today without throwing (no API call)', async () => {
  const httpCalls = [];
  const http = async (args) => { httpCalls.push(args); return { status: 200, body: okBody('unused') }; };

  for (const bad of [undefined, null, 12345, {}, [], true]) {
    let res;
    await assert.doesNotReject(async () => {
      res = await mainSlackSummarizeHandler(
        { text: bad, enabled: true },
        { apiKey: 'sk-mock-anthropic-key', httpRequest: http }
      );
    }, `input ${String(bad)} must not throw`);
    assert.equal(res.ok, true);
    assert.equal(res.text, '', 'coerced empty input is returned unchanged');
    assert.equal(res.summarized, false);
  }
  // Explicit empty string, too.
  const empty = await mainSlackSummarizeHandler(
    { text: '', enabled: true },
    { apiKey: 'sk-mock-anthropic-key', httpRequest: http }
  );
  assert.equal(empty.text, '');
  assert.equal(empty.summarized, false);
  assert.equal(httpCalls.length, 0, 'no API round-trip for non-string / empty input');
});
