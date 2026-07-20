'use strict';

// Unit tests for TASK-073: lib/slack-summarize.js — the Electron-free, network-
// injectable LLM summarizer for auto-posted Slack output. Every network call is
// MOCKED via the injectable `opts.httpRequest`; the redact-before-send pass is
// exercised via the injectable `opts.redact`. NO real API traffic, NO real key.
//
// Layers:
//   PART 1 — summarizeForSlack success path + response parsing.
//   PART 2 — redact-before-send (security): outbound text is redacted, raw
//            secret never reaches the httpRequest boundary.
//   PART 3 — every fallback branch returns the UNCHANGED input, never throws.
//   PART 4 — config constants + request shape handed to the client.
//   PART 5 — defaultHttpRequest wire shape (endpoint/headers/body) via a mocked
//            `https` module — still NO real network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  summarizeForSlack,
  defaultHttpRequest,
  SUMMARY_MODEL,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TIMEOUT_MS,
  SUMMARY_MIN_CHARS
} = require('../lib/slack-summarize');

const { redactSecrets } = require('../lib/slack-proxy');

const R = '***REDACTED***';

// A body long enough to clear SUMMARY_MIN_CHARS so the summarizer actually runs.
const LONG = ('Build finished. ' + 'x'.repeat(SUMMARY_MIN_CHARS + 50));

// Anthropic Messages API success body: first text content block is the summary.
function okBody(summary) {
  return JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: summary }]
  });
}

// A fake httpRequest that records every call and returns a canned response.
function recordingHttp(response, calls) {
  return async (args) => { calls.push(args); return response; };
}

// ===========================================================================
// PART 1 — success path + response parsing
// ===========================================================================

test('summarize: success path returns the trimmed model summary text', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('  Tests passed; 3 files changed.  ') }, calls);
  const res = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: http });
  assert.equal(res.summarized, true);
  assert.equal(res.reason, 'ok');
  assert.equal(res.text, 'Tests passed; 3 files changed.', 'summary is trimmed');
  assert.equal(calls.length, 1, 'exactly one API call');
});

test('summarize: picks the first type:"text" block, ignoring non-text blocks', async () => {
  const body = JSON.stringify({
    content: [
      { type: 'thinking', thinking: 'ignore me' },
      { type: 'text', text: 'the real summary' },
      { type: 'text', text: 'second block ignored' }
    ]
  });
  const res = await summarizeForSlack(LONG, {
    apiKey: 'sk-key', enabled: true, httpRequest: async () => ({ status: 200, body })
  });
  assert.equal(res.text, 'the real summary');
  assert.equal(res.summarized, true);
});

// ===========================================================================
// PART 2 — redact-before-send (security)
// ===========================================================================

test('summarize: redact-before-send — the text passed to httpRequest is redacted, never the raw secret', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('summary') }, calls);
  const raw = 'sk-abc123DEF456ghi789JKL012mno345';
  // Deliberately feed UN-redacted text plus an injected redactor; the module
  // MUST redact before it hands anything to the external client.
  const input = 'Deploy log line one.\nexport OPENAI_API_KEY=' + raw + '\n' + 'padding '.repeat(40);
  const res = await summarizeForSlack(input, {
    apiKey: 'sk-key', enabled: true, httpRequest: http, redact: redactSecrets
  });
  assert.equal(calls.length, 1, 'the client was called');
  const outbound = calls[0].text;
  assert.match(outbound, /\*\*\*REDACTED\*\*\*/, 'outbound text carries the redaction placeholder');
  assert.ok(!outbound.includes(raw), 'the raw sk- key never reaches the client boundary');
  assert.ok(!outbound.includes('sk-abc123'), 'no fragment of the raw key leaked to the client');
  // Belt-and-braces: the summary we return is whatever the model gave (renderer
  // redacts it again); the security guarantee is about the OUTBOUND text.
  assert.equal(res.summarized, true);
});

test('summarize: with no injected redact, outbound equals the (already-redacted) input verbatim', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('summary') }, calls);
  const alreadyClean = 'All good. ' + 'ok '.repeat(80);
  await summarizeForSlack(alreadyClean, { apiKey: 'sk-key', enabled: true, httpRequest: http });
  assert.equal(calls[0].text, alreadyClean, 'no redactor → outbound is the input unchanged');
});

// ===========================================================================
// PART 3 — every fallback branch returns UNCHANGED input, never throws, no call
// ===========================================================================

test('summarize: disabled (enabled=false) → unchanged input, no API call, reason "disabled"', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('x') }, calls);
  const res = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: false, httpRequest: http });
  assert.equal(res.text, LONG);
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(calls.length, 0, 'no API call when disabled');
});

test('summarize: no API key → unchanged input, no API call, reason "no-key"', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('x') }, calls);
  const res = await summarizeForSlack(LONG, { apiKey: '', enabled: true, httpRequest: http });
  assert.equal(res.text, LONG);
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'no-key');
  assert.equal(calls.length, 0, 'no API call without a key');
});

test('summarize: empty input → unchanged, no call, reason "empty"', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('x') }, calls);
  const res = await summarizeForSlack('', { apiKey: 'sk-key', enabled: true, httpRequest: http });
  assert.equal(res.text, '');
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'empty');
  assert.equal(calls.length, 0);
});

test('summarize: too-short input (< SUMMARY_MIN_CHARS) → unchanged, no call, reason "too-short"', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('x') }, calls);
  const short = 'tiny output';
  assert.ok(short.length < SUMMARY_MIN_CHARS);
  const res = await summarizeForSlack(short, { apiKey: 'sk-key', enabled: true, httpRequest: http });
  assert.equal(res.text, short);
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'too-short');
  assert.equal(calls.length, 0, 'no round-trip for trivial windows');
});

test('summarize: non-200 status → unchanged input, reason "bad-status", never throws', async () => {
  const http = async () => ({ status: 500, body: 'internal error' });
  let res;
  await assert.doesNotReject(async () => { res = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: http }); });
  assert.equal(res.text, LONG);
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'bad-status');
});

test('summarize: malformed / non-JSON body → unchanged input, reason "bad-json", never throws', async () => {
  const http = async () => ({ status: 200, body: 'this is not json {{{' });
  let res;
  await assert.doesNotReject(async () => { res = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: http }); });
  assert.equal(res.text, LONG);
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'bad-json');
});

test('summarize: empty / non-text content → unchanged input, reason "empty-response"', async () => {
  // No text block at all.
  const noText = async () => ({ status: 200, body: JSON.stringify({ content: [{ type: 'thinking', thinking: 'hmm' }] }) });
  let r1 = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: noText });
  assert.equal(r1.text, LONG);
  assert.equal(r1.summarized, false);
  assert.equal(r1.reason, 'empty-response');

  // A text block whose text is only whitespace trims to empty → still fallback.
  const blank = async () => ({ status: 200, body: okBody('   \n  ') });
  let r2 = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: blank });
  assert.equal(r2.text, LONG);
  assert.equal(r2.reason, 'empty-response');

  // Missing content array entirely.
  const noContent = async () => ({ status: 200, body: JSON.stringify({ id: 'x' }) });
  let r3 = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: noContent });
  assert.equal(r3.text, LONG);
  assert.equal(r3.reason, 'empty-response');
});

test('summarize: network error (httpRequest rejects) → unchanged input, reason "error", never throws', async () => {
  const http = async () => { throw new Error('ECONNRESET'); };
  let res;
  await assert.doesNotReject(async () => { res = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: http }); });
  assert.equal(res.text, LONG);
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'error');
});

test('summarize: timeout (httpRequest rejects with a timeout error) → unchanged input, reason "error"', async () => {
  const http = async () => { throw new Error('anthropic request timed out'); };
  let res;
  await assert.doesNotReject(async () => { res = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: http }); });
  assert.equal(res.text, LONG);
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'error');
});

test('summarize: a null/undefined httpRequest response is treated as bad-status, never throws', async () => {
  const http = async () => null;
  let res;
  await assert.doesNotReject(async () => { res = await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: http }); });
  assert.equal(res.text, LONG);
  assert.equal(res.reason, 'bad-status');
});

// ===========================================================================
// PART 4 — config constants + request params handed to the client
// ===========================================================================

test('summarize: SUMMARY_MODEL is claude-haiku-4-5 and is the model sent to the client', async () => {
  assert.equal(SUMMARY_MODEL, 'claude-haiku-4-5');
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('s') }, calls);
  await summarizeForSlack(LONG, { apiKey: 'sk-key', enabled: true, httpRequest: http });
  assert.equal(calls[0].model, 'claude-haiku-4-5', 'the Haiku model id is sent');
  assert.equal(calls[0].maxTokens, SUMMARY_MAX_TOKENS);
  assert.equal(calls[0].timeoutMs, SUMMARY_TIMEOUT_MS, 'a timeout bound is passed to the client');
  assert.equal(typeof calls[0].system, 'string');
  assert.ok(calls[0].system.length > 0, 'a system prompt is sent');
});

test('summarize: the API key is passed to the client but never appears in the returned object', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('the summary') }, calls);
  const apiKey = 'sk-SUPERSECRETKEY0123456789abcdef';
  const res = await summarizeForSlack(LONG, { apiKey, enabled: true, httpRequest: http });
  assert.equal(calls[0].apiKey, apiKey, 'key handed to the transport only');
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(apiKey), 'the API key is NEVER present in the returned object');
});

// ===========================================================================
// PART 5 — defaultHttpRequest wire shape via a MOCKED https module (no network)
// ===========================================================================

test('defaultHttpRequest: endpoint, headers and body shape are correct (mocked https, no real network)', async () => {
  const https = require('https');
  const orig = https.request;
  let capturedOptions = null;
  let capturedPayload = null;
  try {
    https.request = (options, cb) => {
      capturedOptions = options;
      const res = new EventEmitter();
      res.statusCode = 200;
      // deliver the fake response asynchronously, after end() is called
      process.nextTick(() => { res.emit('data', okBody('mock summary')); res.emit('end'); });
      cb(res);
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = (p) => { capturedPayload = p; };
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };

    const result = await defaultHttpRequest({
      apiKey: 'sk-wire-test-key',
      model: SUMMARY_MODEL,
      maxTokens: SUMMARY_MAX_TOKENS,
      system: 'sys prompt',
      text: 'the outbound text',
      timeoutMs: SUMMARY_TIMEOUT_MS
    });

    assert.deepEqual(result, { status: 200, body: okBody('mock summary') });

    // Endpoint
    assert.equal(capturedOptions.hostname, 'api.anthropic.com');
    assert.equal(capturedOptions.path, '/v1/messages');
    assert.equal(capturedOptions.method, 'POST');
    // Headers
    assert.equal(capturedOptions.headers['x-api-key'], 'sk-wire-test-key');
    assert.equal(capturedOptions.headers['anthropic-version'], '2023-06-01');
    assert.equal(capturedOptions.headers['content-type'], 'application/json');
    assert.equal(typeof capturedOptions.headers['content-length'], 'number');
    // Body
    const body = JSON.parse(capturedPayload);
    assert.equal(body.model, SUMMARY_MODEL, 'the model id is in the request body');
    assert.equal(body.max_tokens, SUMMARY_MAX_TOKENS);
    assert.equal(body.system, 'sys prompt');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'the outbound text' }]);
  } finally {
    https.request = orig;
  }
});

test('defaultHttpRequest: a socket error rejects (so summarizeForSlack can fall back)', async () => {
  const https = require('https');
  const orig = https.request;
  try {
    https.request = (_options, _cb) => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      process.nextTick(() => req.emit('error', new Error('socket hang up')));
      return req;
    };
    await assert.rejects(
      () => defaultHttpRequest({ apiKey: 'k', model: SUMMARY_MODEL, maxTokens: 1, system: 's', text: 't', timeoutMs: 10 }),
      /socket hang up/
    );
  } finally {
    https.request = orig;
  }
});

// ===========================================================================
// PART 6 — TASK-077: main.js slack:summarize input-size clamp (defense in
// depth). The clamp lives in the Electron main process (`main.js`), which is
// not require()-able under node --test, so this part combines:
//   (a) a SOURCE-SCAN pinning the real clamp in main.js (constant, tail slice,
//       and that it runs BEFORE summarizeForSlack), and
//   (b) BEHAVIORAL units that drive a byte-for-byte mirror of the handler's
//       clamp into the REAL summarizeForSlack with a MOCKED httpRequest, proving
//       the text handed to the (mocked) Anthropic boundary is ≤ the cap and is
//       still redacted (redact-before-send preserved).
// NO real network / API / DB / key anywhere in this part.
// ===========================================================================

const MAIN_JS = path.join(__dirname, '..', 'main.js');
const mainSrc = fs.readFileSync(MAIN_JS, 'utf8').replace(/\r\n/g, '\n');

// The shared cap the renderer (cleanTerminalOutput 12,000-char tail) and main
// both use. Pinned here so the behavioral mirror can never silently diverge.
const SLACK_SUMMARIZE_MAX_INPUT_CHARS = 12000;

// Byte-for-byte mirror of main.js's slack:summarize clamp (main.js ~1680-1686):
// coerce non-strings to '', then keep only the TAIL when over the cap. Safe on
// '' (''.slice(-N) === ''). Kept identical to main so the pin below guards it.
function clampSummarizeInput(text) {
  const raw = typeof text === 'string' ? text : '';
  return raw.length > SLACK_SUMMARIZE_MAX_INPUT_CHARS
    ? raw.slice(-SLACK_SUMMARIZE_MAX_INPUT_CHARS)
    : raw;
}

// --- (a) SOURCE-SCAN: pin the real clamp in main.js -------------------------

test('TASK-077 unit (source-scan): main.js defines the 12,000-char summarize cap constant', () => {
  assert.match(
    mainSrc,
    /const\s+SLACK_SUMMARIZE_MAX_INPUT_CHARS\s*=\s*12000\s*;/,
    'main.js declares SLACK_SUMMARIZE_MAX_INPUT_CHARS = 12000 (mirrors the renderer 12,000 tail)'
  );
});

test('TASK-077 unit (source-scan): main.js clamps to the TAIL before summarizeForSlack', () => {
  // The clamp keeps the tail (slice with a NEGATIVE bound), mirroring the
  // renderer's cleanTerminalOutput `slice(-12000)`.
  assert.match(
    mainSrc,
    /raw\.slice\(-SLACK_SUMMARIZE_MAX_INPUT_CHARS\)/,
    'main.js keeps the TAIL via raw.slice(-SLACK_SUMMARIZE_MAX_INPUT_CHARS)'
  );
  // And the clamp must run BEFORE the summarizer sees the text.
  const iClamp = mainSrc.indexOf('raw.slice(-SLACK_SUMMARIZE_MAX_INPUT_CHARS)');
  const iSummarize = mainSrc.indexOf('summarizeForSlack(input');
  assert.ok(iClamp !== -1, 'clamp present');
  assert.ok(iSummarize !== -1, 'summarizeForSlack(input, ...) present');
  assert.ok(iClamp < iSummarize, 'clamp runs BEFORE summarizeForSlack, so the cap bounds the outbound payload');
});

test('TASK-077 unit (source-scan): the clamped `input` (not the raw text) is what is summarized', () => {
  // Guard against a regression that clamps but then forwards `raw`/`text`.
  assert.match(
    mainSrc,
    /summarizeForSlack\(\s*input\b/,
    'main.js passes the clamped `input` variable to summarizeForSlack'
  );
});

// --- (b) BEHAVIORAL: clamp mirror → REAL summarizeForSlack → mocked http -----

test('TASK-077 unit: oversized input is truncated to the cap BEFORE the mocked http boundary, and still redacted', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('summary') }, calls);

  // A payload FAR larger than the cap, with a secret embedded in the TAIL so it
  // survives truncation and MUST be masked by redact-before-send.
  const rawSecret = 'sk-abc123DEF456ghi789JKL012mno345';
  const oversized =
    'HEAD-SECRET export OLD_KEY=sk-should-be-truncated-away0000\n' +
    'A'.repeat(30000) +
    '\nexport OPENAI_API_KEY=' + rawSecret + '\ntrailing log line';
  assert.ok(oversized.length > SLACK_SUMMARIZE_MAX_INPUT_CHARS, 'input is over the cap');

  const clamped = clampSummarizeInput(oversized);
  assert.ok(clamped.length <= SLACK_SUMMARIZE_MAX_INPUT_CHARS, 'clamp bounds the input to the cap');

  const res = await summarizeForSlack(clamped, {
    apiKey: 'sk-key', enabled: true, httpRequest: http, redact: redactSecrets
  });

  assert.equal(calls.length, 1, 'the client boundary was reached once');
  const outbound = calls[0].text;
  assert.ok(
    outbound.length <= SLACK_SUMMARIZE_MAX_INPUT_CHARS,
    'the text handed to the (mocked) Anthropic http request is <= the 12,000-char cap'
  );
  assert.match(outbound, /\*\*\*REDACTED\*\*\*/, 'the surviving tail secret is redacted before send');
  assert.ok(!outbound.includes(rawSecret), 'the raw sk- key never reaches the client boundary');
  assert.ok(!outbound.includes('sk-abc123'), 'no fragment of the tail key leaked to the client');
  assert.equal(res.summarized, true);
});

test('TASK-077 unit: summarizeForSlack ITSELF does not bound length — the main.js clamp is load-bearing', async () => {
  // Proves the cap must live in main.js: fed an oversized payload WITHOUT the
  // clamp, the summarizer forwards the whole thing (only redacting), so removing
  // main's clamp would send an unbounded payload to the billed API.
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('summary') }, calls);
  const oversized = 'B'.repeat(SLACK_SUMMARIZE_MAX_INPUT_CHARS + 5000);
  await summarizeForSlack(oversized, { apiKey: 'sk-key', enabled: true, httpRequest: http });
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].text.length > SLACK_SUMMARIZE_MAX_INPUT_CHARS,
    'unclamped, the summarizer would forward > cap — hence main.js must clamp first'
  );
});

test('TASK-077 unit: a normal <=cap window is forwarded unchanged apart from the existing redaction', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('summary') }, calls);
  // A realistic window comfortably under the cap, carrying a secret so we can
  // pin that ONLY redaction (not truncation) alters it.
  const rawSecret = 'sk-normalWINDOWsecret0123456789abcXYZ';
  const window = 'Deploy finished.\nexport TOKEN=' + rawSecret + '\n' + 'ok line '.repeat(200);
  assert.ok(window.length <= SLACK_SUMMARIZE_MAX_INPUT_CHARS, 'the window is at/under the cap');

  const clamped = clampSummarizeInput(window);
  assert.equal(clamped, window, 'the clamp is a no-op for a normal window (byte-identical)');

  await summarizeForSlack(clamped, {
    apiKey: 'sk-key', enabled: true, httpRequest: http, redact: redactSecrets
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].text, redactSecrets(window),
    'a normal window reaches the boundary exactly as before: redacted, NOT truncated'
  );
  assert.ok(!calls[0].text.includes(rawSecret), 'the secret is still redacted');
});

test('TASK-077 unit (edge): non-string / empty input is clamped to "" without throwing, no API call', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('unused') }, calls);
  for (const bad of [undefined, null, 12345, {}, [], true, () => {}]) {
    assert.equal(clampSummarizeInput(bad), '', `${String(bad)} coerces to '' without throwing`);
  }
  // Empty string threads through unchanged and short-circuits before any call.
  assert.equal(clampSummarizeInput(''), '');
  let res;
  await assert.doesNotReject(async () => {
    res = await summarizeForSlack(clampSummarizeInput(null), {
      apiKey: 'sk-key', enabled: true, httpRequest: http, redact: redactSecrets
    });
  });
  assert.equal(res.text, '', 'empty coerced input is returned unchanged');
  assert.equal(res.summarized, false);
  assert.equal(res.reason, 'empty');
  assert.equal(calls.length, 0, 'no round-trip for non-string / empty input');
});
