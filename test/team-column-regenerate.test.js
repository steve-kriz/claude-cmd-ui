'use strict';

// ===========================================================================
// UNIT tests for the Board column "Generate with AI" feature.
//
// PART A: lib/team-column-regenerate.js — the Electron-free, network-injectable
//   AI drafter/rewriter for a column's "instructions" text. EVERY network call
//   is MOCKED via the injectable `opts.httpRequest`; NO real API traffic, NO
//   real key, NO network, NO DB. Modeled on test/task-130-agent-regenerate.test.js
//   and test/task-184-skill-regen.e2e.test.js's PART A. The one behavior that
//   differs from those two regenerators: an EMPTY current `instructions` is a
//   valid "generate from scratch" request, not a failure.
//
// PART B: main.js source-scan — the team:regenerateColumnInstructions handler's
//   input clamps, never-return-the-key contract, and delegation to the lib
//   (main.js is not require()-able under node --test, so this is a source pin
//   like the existing TASK-130/184 scans).
//
// PART C: preload.js source-scan — window.api.team.regenerateColumnInstructions
//   invokes the right channel.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  regenerateColumnInstructions,
  defaultHttpRequest,
  buildUserContent,
  COLUMN_REGEN_MODEL,
  COLUMN_REGEN_MAX_TOKENS,
  COLUMN_REGEN_TIMEOUT_MS
} = require('../lib/team-column-regenerate');

const REPO = path.join(__dirname, '..');

function okBody(text) {
  return JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }]
  });
}

function recordingHttp(response, calls) {
  return async (args) => { calls.push(args); return response; };
}

// ===========================================================================
// PART A — lib/team-column-regenerate.js (mocked httpRequest)
// ===========================================================================

test('regenerate: success path returns { ok:true, content, reason:"ok" } with the model text', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('Run the linter, then hand off to review.') }, calls);
  const res = await regenerateColumnInstructions({
    apiKey: 'sk-key',
    instructions: 'Old brief.',
    label: 'Testing',
    description: 'QA lane',
    agent: 'tester',
    instruction: 'mention linting',
    httpRequest: http
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'ok');
  assert.equal(res.content, 'Run the linter, then hand off to review.');
  assert.equal(calls.length, 1);
});

test('regenerate: EMPTY current instructions is a valid "generate from scratch" request, not a failure', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('Draft brief.') }, calls);
  const res = await regenerateColumnInstructions({
    apiKey: 'sk-key',
    instructions: '',
    label: 'Review',
    instruction: 'write a brief for the review lane',
    httpRequest: http
  });
  assert.equal(res.ok, true, 'empty starting instructions does not block the call (differs from agent/skill regen)');
  assert.equal(calls.length, 1);
});

test('regenerate: missing apiKey → { ok:false, reason:"no-key" }, NO network call', async () => {
  let called = false;
  const http = async () => { called = true; return { status: 200, body: okBody('x') }; };
  const res = await regenerateColumnInstructions({
    apiKey: '', instructions: 'x', instruction: 'change it', httpRequest: http
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-key');
  assert.equal(res.content, '');
  assert.equal(called, false);
});

test('regenerate: empty (or whitespace-only) instruction → { ok:false, reason:"empty-instruction" }, NO network call', async () => {
  let called = false;
  const http = async () => { called = true; return { status: 200, body: okBody('x') }; };
  let res = await regenerateColumnInstructions({ apiKey: 'sk-key', instructions: 'x', instruction: '', httpRequest: http });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'empty-instruction');
  res = await regenerateColumnInstructions({ apiKey: 'sk-key', instructions: 'x', instruction: '   ', httpRequest: http });
  assert.equal(res.reason, 'empty-instruction');
  assert.equal(called, false);
});

test('regenerate: non-200 status → { ok:false, reason:"bad-status" }', async () => {
  const http = async () => ({ status: 500, body: 'server error' });
  const res = await regenerateColumnInstructions({ apiKey: 'sk-key', instruction: 'x', httpRequest: http });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-status');
});

test('regenerate: malformed JSON body → { ok:false, reason:"bad-json" }', async () => {
  const http = async () => ({ status: 200, body: 'not json' });
  const res = await regenerateColumnInstructions({ apiKey: 'sk-key', instruction: 'x', httpRequest: http });
  assert.equal(res.reason, 'bad-json');
});

test('regenerate: no text content block / blank text → { ok:false, reason:"empty-response" }', async () => {
  const http1 = async () => ({ status: 200, body: JSON.stringify({ content: [] }) });
  const res1 = await regenerateColumnInstructions({ apiKey: 'sk-key', instruction: 'x', httpRequest: http1 });
  assert.equal(res1.reason, 'empty-response');

  const http2 = async () => ({ status: 200, body: okBody('   ') });
  const res2 = await regenerateColumnInstructions({ apiKey: 'sk-key', instruction: 'x', httpRequest: http2 });
  assert.equal(res2.reason, 'empty-response');
});

test('regenerate: httpRequest rejecting (network error / timeout) → { ok:false, reason:"error" }, never throws', async () => {
  const http = async () => { throw new Error('boom'); };
  const res = await regenerateColumnInstructions({ apiKey: 'sk-key', instruction: 'x', httpRequest: http });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'error');
});

test('regenerate: null/undefined httpRequest response is treated as bad-status, never throws', async () => {
  const res = await regenerateColumnInstructions({
    apiKey: 'sk-key', instruction: 'x', httpRequest: async () => null
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-status');
});

test('regenerate: config constants — model claude-sonnet-5, a token cap, a generous timeout', () => {
  assert.equal(COLUMN_REGEN_MODEL, 'claude-sonnet-5');
  assert.ok(COLUMN_REGEN_MAX_TOKENS > 0);
  assert.ok(COLUMN_REGEN_TIMEOUT_MS >= 30000);
});

test('regenerate: the API key is handed to the transport but NEVER appears in the returned object', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('brief') }, calls);
  const res = await regenerateColumnInstructions({ apiKey: 'sk-super-secret', instruction: 'x', httpRequest: http });
  assert.equal(calls[0].apiKey, 'sk-super-secret');
  assert.ok(!JSON.stringify(res).includes('sk-super-secret'));
});

test('regenerate: the request handed to the client carries model / maxTokens / timeout / system', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody('brief') }, calls);
  await regenerateColumnInstructions({ apiKey: 'sk-key', instruction: 'x', httpRequest: http });
  const call = calls[0];
  assert.equal(call.model, COLUMN_REGEN_MODEL);
  assert.equal(call.maxTokens, COLUMN_REGEN_MAX_TOKENS);
  assert.equal(call.timeoutMs, COLUMN_REGEN_TIMEOUT_MS);
  assert.ok(typeof call.system === 'string' && call.system.length > 0);
});

test('buildUserContent: embeds label/description/agent/current instructions and the instruction, with a delimiter', () => {
  const text = buildUserContent({
    label: 'Testing', description: 'QA lane', agent: 'tester',
    instructions: 'Old brief.', instruction: 'mention linting'
  });
  assert.match(text, /COLUMN LABEL: Testing/);
  assert.match(text, /DISPLAY AGENT: tester/);
  assert.match(text, /Old brief\./);
  assert.match(text, /END OF CURRENT INSTRUCTIONS/);
  assert.match(text, /INSTRUCTION:\nmention linting/);
});

test('buildUserContent: empty context/instructions render as "(none)" / "(none yet)" placeholders, not blank', () => {
  const text = buildUserContent({ label: '', description: '', agent: '', instructions: '', instruction: 'draft one' });
  assert.match(text, /COLUMN LABEL: \(none\)/);
  assert.match(text, /DISPLAY AGENT: \(none\)/);
  assert.match(text, /\(none yet\)/);
});

test('defaultHttpRequest: endpoint, headers and body shape are correct (mocked https, no real network)', async () => {
  const https = require('https');
  const originalRequest = https.request;
  let capturedOptions = null;
  let capturedPayload = '';
  https.request = (options, cb) => {
    capturedOptions = options;
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    req.write = (chunk) => { capturedPayload += chunk; };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      cb(res);
      res.emit('data', okBody('brief'));
      res.emit('end');
    };
    req.setTimeout = () => {};
    req.destroy = () => {};
    return req;
  };
  try {
    const res = await defaultHttpRequest({
      apiKey: 'sk-key', model: 'claude-sonnet-5', maxTokens: 100, system: 'sys', text: 'user text', timeoutMs: 1000
    });
    assert.equal(capturedOptions.hostname, 'api.anthropic.com');
    assert.equal(capturedOptions.path, '/v1/messages');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['x-api-key'], 'sk-key');
    assert.equal(capturedOptions.headers['anthropic-version'], '2023-06-01');
    const payload = JSON.parse(capturedPayload);
    assert.equal(payload.model, 'claude-sonnet-5');
    assert.equal(payload.messages[0].content, 'user text');
    assert.equal(res.status, 200);
  } finally {
    https.request = originalRequest;
  }
});

// ===========================================================================
// PART B — main.js source-scan: the team:regenerateColumnInstructions handler.
// ===========================================================================

const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('main.js: registers the team:regenerateColumnInstructions IPC handler', () => {
  assert.match(mainSrc, /ipcMain\.handle\(\s*['"]team:regenerateColumnInstructions['"]/,
    'team:regenerateColumnInstructions handler exists');
});

test('main.js: declares input clamps (defense in depth) and runs them before the lib call', () => {
  assert.match(mainSrc, /const\s+COLUMN_REGEN_MAX_CONTENT_CHARS\s*=\s*\d+/);
  assert.match(mainSrc, /const\s+COLUMN_REGEN_MAX_INSTRUCTION_CHARS\s*=\s*\d+/);
  const iClamp = mainSrc.indexOf('COLUMN_REGEN_MAX_CONTENT_CHARS');
  const iCall = mainSrc.indexOf('regenerateColumnInstructions(');
  assert.ok(iClamp !== -1 && iCall !== -1, 'clamp + lib call both present');
  assert.ok(iClamp < iCall, 'the clamp runs before regenerateColumnInstructions');
});

test('main.js: reads LOG_REDACTING_ANTHROPIC_KEY from the env store and delegates to the lib module', () => {
  const start = mainSrc.indexOf("ipcMain.handle('team:regenerateColumnInstructions'");
  assert.ok(start !== -1);
  const end = mainSrc.indexOf('ipcMain.handle(', start + 10);
  const handler = mainSrc.slice(start, end === -1 ? mainSrc.length : end);
  assert.match(handler, /envStore\.get\(\s*['"]LOG_REDACTING_ANTHROPIC_KEY['"]\s*\)/, 'reads the key from the env store');
  assert.match(handler, /teamColumnRegenerate\.regenerateColumnInstructions\(/, 'delegates to the lib module');
  assert.match(handler, /return\s*\{\s*ok:\s*res\.ok,\s*content:\s*res\.content,\s*reason:\s*res\.reason/,
    'success return is exactly { ok, content, reason }');
  assert.ok(!/return[^;]*apiKey/.test(handler), 'the handler never returns the apiKey');
});

// ===========================================================================
// PART C — preload.js source-scan.
// ===========================================================================

const preloadSrc = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

test('preload.js: window.api.team.regenerateColumnInstructions invokes team:regenerateColumnInstructions', () => {
  assert.match(
    preloadSrc,
    /regenerateColumnInstructions:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]team:regenerateColumnInstructions['"]\s*,\s*payload\s*\)/
  );
});
