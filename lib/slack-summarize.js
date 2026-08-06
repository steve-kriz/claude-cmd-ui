'use strict';

// LLM summarization of AUTO-POSTED Slack output (TASK-073), a follow-up to
// TASK-071's mechanical cleanup. The two auto-post paths (slackFlushTick +
// slackOnFinished) hand this module text that has ALREADY been cleaned
// (cleanTerminalOutput), made readable (humanizeSlackOutput) and — critically —
// redacted (redactSecrets). This module asks a fast Claude model to turn that
// text into a short human-readable summary for someone reading Slack.
//
// Security: the summarizer is an EXTERNAL service, so the text it receives must
// never contain un-redacted secrets. The renderer pipeline redacts BEFORE
// calling here; as defense in depth this module also runs an injected `redact`
// pass over the outbound text before it leaves the process (see redact-before-
// send below). The returned summary is redacted AGAIN by the renderer before it
// is posted to Slack.
//
// This module is intentionally Electron-free and its network call is injectable
// (the `httpRequest` option) so it can be unit-tested with a mocked client and
// NO real API traffic. The main process wires the real client + key + settings.
//
// Anthropic Messages API (verified):
//   POST https://api.anthropic.com/v1/messages
//   headers: x-api-key, anthropic-version: 2023-06-01, content-type: json
//   body: { model, max_tokens, system, messages: [{ role:'user', content }] }
//   reply: { content: [ { type:'text', text } ], ... }  → first text block.
//
// NEVER logs, throws into the flush path, or emits the API key. Any failure
// (disabled, no key, short input, non-200, network error, timeout, malformed
// response) falls back to returning the INPUT text unchanged, i.e. exactly
// TASK-071's cleaned+redacted output.

const https = require('https');

// Model id kept in ONE place so it is trivial to bump when Haiku advances.
const SUMMARY_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_PATH = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const SUMMARY_MAX_TOKENS = 512;
// Time-bound the API call so a slow response can never stall the 30s periodic
// flush (TASK-061). On timeout the request is destroyed and we fall back.
const SUMMARY_TIMEOUT_MS = 8000;
// Windows shorter than this are posted verbatim — there is nothing worth
// summarizing, and a round-trip would only add latency and cost.
const SUMMARY_MIN_CHARS = 200;

// System instructions for the summarizer. Concise, faithful, no invention.
const SUMMARY_SYSTEM_PROMPT = [
  'You are summarizing raw terminal output from a Claude coding session so a',
  'human can read it quickly in Slack. Write a concise summary (a few short',
  'sentences or bullet points). Preserve concrete results: pass/fail status,',
  'file names, commands run, and any error messages. Do not invent facts and do',
  'not add anything that is not present in the output. Do not include preamble',
  'such as "Here is a summary" — output only the summary text itself.'
].join(' ');

// Default (real) HTTPS client, mirroring the outbound-HTTP pattern in
// lib/slack.js. Resolves { status, body }; rejects only on socket error /
// timeout so the caller's try/catch converts it to a fallback. The API key
// lives only in the request headers and is never logged.
function defaultHttpRequest({ apiKey, model, maxTokens, system, text, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: text }]
    });
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    };
    const req = https.request(
      { hostname: ANTHROPIC_HOST, path: ANTHROPIC_PATH, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || SUMMARY_TIMEOUT_MS, () => {
      req.destroy(new Error('anthropic request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// Summarize already-cleaned+redacted text for Slack. Returns a Promise of
// { text, summarized, reason } and NEVER rejects — on any disabled/unavailable/
// error condition `text` is the INPUT unchanged and `summarized` is false, so
// the caller's final redactSecrets() reproduces TASK-071's behavior exactly.
//
// opts:
//   apiKey      LOG_REDACTING_ANTHROPIC_KEY (empty → disabled, silent fallback)
//   enabled     the user toggle (false → fallback; default OFF / opt-in)
//   httpRequest injectable client for tests (defaults to the real https client)
//   redact      optional redactor applied to the outbound text as defense in
//               depth so no un-redacted secret can leave the process even if a
//               caller forgets to redact first (redact-before-send test hook)
//   model, maxTokens, timeoutMs, minChars, system — tunables with sane defaults
async function summarizeForSlack(input, opts = {}) {
  const text = typeof input === 'string' ? input : '';
  const {
    apiKey = '',
    enabled = false,
    httpRequest = defaultHttpRequest,
    redact = null,
    model = SUMMARY_MODEL,
    maxTokens = SUMMARY_MAX_TOKENS,
    timeoutMs = SUMMARY_TIMEOUT_MS,
    minChars = SUMMARY_MIN_CHARS,
    system = SUMMARY_SYSTEM_PROMPT
  } = opts;

  if (!enabled) return { text, summarized: false, reason: 'disabled' };
  if (!apiKey) return { text, summarized: false, reason: 'no-key' };
  if (!text) return { text, summarized: false, reason: 'empty' };
  if (text.length < minChars) return { text, summarized: false, reason: 'too-short' };

  // Redact-before-send (defense in depth): the renderer already redacts, but we
  // redact again here so the text handed to the external client is guaranteed
  // clean regardless of caller. This is the enforcement point a test can assert.
  const outbound = typeof redact === 'function' ? redact(text) : text;

  try {
    const res = await httpRequest({ apiKey, model, maxTokens, system, text: outbound, timeoutMs });
    if (!res || res.status !== 200 || typeof res.body !== 'string') {
      return { text, summarized: false, reason: 'bad-status' };
    }
    let json;
    try { json = JSON.parse(res.body); }
    catch (_) { return { text, summarized: false, reason: 'bad-json' }; }
    const blocks = json && Array.isArray(json.content) ? json.content : null;
    const block = blocks ? blocks.find((b) => b && b.type === 'text') : null;
    const summary = block && typeof block.text === 'string' ? block.text.trim() : '';
    if (!summary) return { text, summarized: false, reason: 'empty-response' };
    return { text: summary, summarized: true, reason: 'ok' };
  } catch (_) {
    // Network error / timeout / anything unexpected → silent fallback.
    return { text, summarized: false, reason: 'error' };
  }
}

module.exports = {
  summarizeForSlack,
  defaultHttpRequest,
  SUMMARY_MODEL,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TIMEOUT_MS,
  SUMMARY_MIN_CHARS,
  SUMMARY_SYSTEM_PROMPT
};
