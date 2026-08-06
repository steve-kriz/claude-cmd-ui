'use strict';

// ===========================================================================
// TASK-130 — UNIT tests.
//
// PART A: lib/agent-regenerate.js — the Electron-free, network-injectable AI
//   agent-file regenerator. EVERY network call is MOCKED via the injectable
//   `opts.httpRequest`; NO real API traffic, NO real key, NO network, NO DB.
//   Mirrors the mocked-httpRequest pattern of test/slack-summarize.test.js.
//   Covers all reason branches: ok, no-key, empty-instruction, empty-content,
//   bad-status, bad-json, empty-response, error (network/timeout), null body;
//   config constants; request shape handed to the client; the key never leaks
//   into the returned object; and defaultHttpRequest wire shape via a MOCKED
//   `https` module.
//
// PART B: main.js source-scan — the agents:regenerate handler's input clamps,
//   never-return-the-key contract, and delegation to the lib (main.js is not
//   require()-able under node --test, so this is a source pin like the existing
//   TASK-077 scan in test/slack-summarize.test.js).
//
// PART C: renderer/renderer.js pure logic — serializeAgentEdits (byte-identical
//   round-trip / omit-empty / canonical model insert / CRLF & no-body shape /
//   body-only frontmatter preservation), validateRegeneratedAgent (accept +
//   every reject case), and stripOneCodeFence. The functions are EXTRACTED
//   headless by brace-matching the source (the task-094 convention). NO DOM,
//   NO I/O beyond reading the REAL bundled agent files read-only as fixtures.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  regenerateAgentFile,
  defaultHttpRequest,
  buildUserContent,
  REGEN_MODEL,
  REGEN_MAX_TOKENS,
  REGEN_TIMEOUT_MS,
  REGEN_SYSTEM_PROMPT
} = require('../lib/agent-regenerate');

const REPO = path.join(__dirname, '..');

// Anthropic Messages API success body: first text content block is the output.
function okBody(text) {
  return JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }]
  });
}

// A fake httpRequest that records every call and returns a canned response.
function recordingHttp(response, calls) {
  return async (args) => { calls.push(args); return response; };
}

// A valid agent file the model might return for "orchestrate-docs".
const VALID_AGENT = [
  '---',
  'name: orchestrate-docs',
  'description: >-',
  '  A docs agent that also runs the linter now.',
  'tools: Read, Grep, Bash',
  'model: claude-sonnet-5',
  '---',
  '',
  'You are the docs agent.',
  ''
].join('\n');

const CURRENT_AGENT = [
  '---',
  'name: orchestrate-docs',
  'description: >-',
  '  A docs agent.',
  'tools: Read, Grep',
  '---',
  '',
  'You are the docs agent.',
  ''
].join('\n');

// ===========================================================================
// PART A — lib/agent-regenerate.js (mocked httpRequest)
// ===========================================================================

test('regenerate: success path returns { ok:true, content, reason:"ok" } with the model text', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody(VALID_AGENT) }, calls);
  const res = await regenerateAgentFile({
    apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'also allow Bash', httpRequest: http
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'ok');
  assert.equal(res.content, VALID_AGENT, 'raw model text is returned verbatim (renderer validates)');
  assert.equal(calls.length, 1, 'exactly one API call');
});

test('regenerate: picks the first type:"text" block, ignoring non-text blocks', async () => {
  const body = JSON.stringify({
    content: [
      { type: 'thinking', thinking: 'ignore me' },
      { type: 'text', text: VALID_AGENT },
      { type: 'text', text: 'second block ignored' }
    ]
  });
  const res = await regenerateAgentFile({
    apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: async () => ({ status: 200, body })
  });
  assert.equal(res.ok, true);
  assert.equal(res.content, VALID_AGENT);
});

test('regenerate: no API key → reason "no-key", NO API call', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody(VALID_AGENT) }, calls);
  const res = await regenerateAgentFile({ apiKey: '', content: CURRENT_AGENT, instruction: 'x', httpRequest: http });
  assert.deepEqual(res, { ok: false, content: '', reason: 'no-key' });
  assert.equal(calls.length, 0, 'no round-trip without a key');
});

test('regenerate: empty / whitespace instruction → reason "empty-instruction", NO API call', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody(VALID_AGENT) }, calls);
  for (const instr of ['', '   ', '\n\t ']) {
    const res = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: instr, httpRequest: http });
    assert.equal(res.reason, 'empty-instruction', `${JSON.stringify(instr)} → empty-instruction`);
    assert.equal(res.ok, false);
  }
  assert.equal(calls.length, 0, 'no API call for an empty instruction');
});

test('regenerate: empty / whitespace content → reason "empty-content", NO API call', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody(VALID_AGENT) }, calls);
  for (const c of ['', '    ', '\n\n']) {
    const res = await regenerateAgentFile({ apiKey: 'sk-key', content: c, instruction: 'do x', httpRequest: http });
    assert.equal(res.reason, 'empty-content', `${JSON.stringify(c)} → empty-content`);
  }
  assert.equal(calls.length, 0, 'no API call for empty content');
});

test('regenerate: non-200 status → reason "bad-status", never throws', async () => {
  const http = async () => ({ status: 500, body: 'internal error' });
  let res;
  await assert.doesNotReject(async () => {
    res = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: http });
  });
  assert.deepEqual(res, { ok: false, content: '', reason: 'bad-status' });
});

test('regenerate: malformed / non-JSON body → reason "bad-json", never throws', async () => {
  const http = async () => ({ status: 200, body: 'not json {{{' });
  let res;
  await assert.doesNotReject(async () => {
    res = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: http });
  });
  assert.deepEqual(res, { ok: false, content: '', reason: 'bad-json' });
});

test('regenerate: empty / non-text content → reason "empty-response"', async () => {
  // No text block at all.
  const noText = async () => ({ status: 200, body: JSON.stringify({ content: [{ type: 'thinking', thinking: 'hmm' }] }) });
  let r1 = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: noText });
  assert.equal(r1.reason, 'empty-response');
  assert.equal(r1.content, '');

  // A text block whose text is only whitespace trims to empty → still empty-response.
  const blank = async () => ({ status: 200, body: okBody('   \n  ') });
  let r2 = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: blank });
  assert.equal(r2.reason, 'empty-response');

  // Missing content array entirely.
  const noContent = async () => ({ status: 200, body: JSON.stringify({ id: 'x' }) });
  let r3 = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: noContent });
  assert.equal(r3.reason, 'empty-response');
});

test('regenerate: network error (httpRequest rejects) → reason "error", never throws', async () => {
  const http = async () => { throw new Error('ECONNRESET'); };
  let res;
  await assert.doesNotReject(async () => {
    res = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: http });
  });
  assert.deepEqual(res, { ok: false, content: '', reason: 'error' });
});

test('regenerate: timeout (httpRequest rejects with a timeout error) → reason "error"', async () => {
  const http = async () => { throw new Error('anthropic request timed out'); };
  let res;
  await assert.doesNotReject(async () => {
    res = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: http });
  });
  assert.equal(res.reason, 'error');
  assert.equal(res.ok, false);
});

test('regenerate: a null/undefined httpRequest response is treated as bad-status, never throws', async () => {
  let res;
  await assert.doesNotReject(async () => {
    res = await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'x', httpRequest: async () => null });
  });
  assert.equal(res.reason, 'bad-status');
});

test('regenerate: config constants — model claude-sonnet-5, larger max_tokens, generous timeout', () => {
  assert.equal(REGEN_MODEL, 'claude-sonnet-5', 'Sonnet model id (stronger than Haiku for a full rewrite)');
  assert.equal(REGEN_MAX_TOKENS, 8192, 'max_tokens large enough for a multi-KB agent file (not 512)');
  assert.ok(REGEN_MAX_TOKENS > 512, 'not the summarizer 512 cap');
  assert.equal(REGEN_TIMEOUT_MS, 45000);
  assert.equal(typeof REGEN_SYSTEM_PROMPT, 'string');
  assert.ok(REGEN_SYSTEM_PROMPT.length > 0, 'a system prompt exists');
});

test('regenerate: the request handed to the client carries model / maxTokens / timeout / system', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody(VALID_AGENT) }, calls);
  await regenerateAgentFile({ apiKey: 'sk-key', content: CURRENT_AGENT, instruction: 'do x', httpRequest: http });
  assert.equal(calls[0].model, REGEN_MODEL, 'the Sonnet model id is sent');
  assert.equal(calls[0].maxTokens, REGEN_MAX_TOKENS);
  assert.equal(calls[0].timeoutMs, REGEN_TIMEOUT_MS, 'a timeout bound is passed to the client');
  assert.equal(typeof calls[0].system, 'string');
  assert.ok(calls[0].system.length > 0, 'a system prompt is sent');
  // The user turn contains BOTH the current file and the instruction.
  assert.ok(calls[0].text.includes(CURRENT_AGENT), 'the current agent file is in the user turn');
  assert.ok(calls[0].text.includes('do x'), 'the instruction is in the user turn');
});

test('regenerate: the API key is handed to the transport but NEVER appears in the returned object', async () => {
  const calls = [];
  const http = recordingHttp({ status: 200, body: okBody(VALID_AGENT) }, calls);
  const apiKey = 'sk-SUPERSECRETKEY0123456789abcdef';
  const res = await regenerateAgentFile({ apiKey, content: CURRENT_AGENT, instruction: 'x', httpRequest: http });
  assert.equal(calls[0].apiKey, apiKey, 'key handed to the transport only');
  assert.ok(!JSON.stringify(res).includes(apiKey), 'the API key is NEVER present in the returned object');
});

test('regenerate: buildUserContent embeds the file and instruction with a delimiter', () => {
  const out = buildUserContent('FILE-BODY', 'INSTRUCTION-TEXT');
  assert.ok(out.includes('FILE-BODY'));
  assert.ok(out.includes('INSTRUCTION-TEXT'));
  assert.ok(/END OF CURRENT AGENT FILE/.test(out), 'a delimiter separates the file from the instruction');
});

// --- defaultHttpRequest wire shape via a MOCKED https module (no network) -----

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
      process.nextTick(() => { res.emit('data', okBody('mock out')); res.emit('end'); });
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
      model: REGEN_MODEL,
      maxTokens: REGEN_MAX_TOKENS,
      system: 'sys prompt',
      text: 'the outbound text',
      timeoutMs: REGEN_TIMEOUT_MS
    });

    assert.deepEqual(result, { status: 200, body: okBody('mock out') });
    assert.equal(capturedOptions.hostname, 'api.anthropic.com');
    assert.equal(capturedOptions.path, '/v1/messages');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['x-api-key'], 'sk-wire-test-key');
    assert.equal(capturedOptions.headers['anthropic-version'], '2023-06-01');
    assert.equal(capturedOptions.headers['content-type'], 'application/json');
    assert.equal(typeof capturedOptions.headers['content-length'], 'number');
    const bodyObj = JSON.parse(capturedPayload);
    assert.equal(bodyObj.model, REGEN_MODEL, 'the model id is in the request body');
    assert.equal(bodyObj.max_tokens, REGEN_MAX_TOKENS);
    assert.equal(bodyObj.system, 'sys prompt');
    assert.deepEqual(bodyObj.messages, [{ role: 'user', content: 'the outbound text' }]);
  } finally {
    https.request = orig;
  }
});

test('defaultHttpRequest: a socket error rejects (so regenerateAgentFile can fall back to reason "error")', async () => {
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
      () => defaultHttpRequest({ apiKey: 'k', model: REGEN_MODEL, maxTokens: 1, system: 's', text: 't', timeoutMs: 10 }),
      /socket hang up/
    );
  } finally {
    https.request = orig;
  }
});

// ===========================================================================
// PART B — main.js source-scan: the agents:regenerate handler contract.
// (main.js is Electron-only; pin its behavior by source, like TASK-077.)
// ===========================================================================

const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('main.js: registers the agents:regenerate IPC handler', () => {
  assert.match(mainSrc, /ipcMain\.handle\(\s*['"]agents:regenerate['"]/, 'agents:regenerate handler exists');
});

test('main.js: declares content + instruction input clamps (defense in depth)', () => {
  assert.match(mainSrc, /const\s+AGENT_REGEN_MAX_CONTENT_CHARS\s*=\s*\d+/, 'a content clamp constant is declared');
  assert.match(mainSrc, /const\s+AGENT_REGEN_MAX_INSTRUCTION_CHARS\s*=\s*\d+/, 'an instruction clamp constant is declared');
  // Clamps run BEFORE the lib call so the billed API can never see an unbounded payload.
  const iClamp = mainSrc.indexOf('AGENT_REGEN_MAX_CONTENT_CHARS');
  const iCall = mainSrc.indexOf('regenerateAgentFile');
  assert.ok(iClamp !== -1 && iCall !== -1, 'clamp + lib call both present');
  assert.ok(iClamp < iCall, 'the clamp runs before regenerateAgentFile');
});

test('main.js: reads LOG_REDACTING_ANTHROPIC_KEY from the env store and delegates to the lib', () => {
  assert.match(mainSrc, /envStore\.get\(\s*['"]LOG_REDACTING_ANTHROPIC_KEY['"]\s*\)/, 'reads the key from the env store');
  assert.match(mainSrc, /regenerateAgentFile\(/, 'delegates to the lib module');
});

test('main.js: the handler returns only { ok, content, reason } — never the raw key', () => {
  // Grab the handler body and assert it returns the structured triple and no key.
  const start = mainSrc.indexOf("ipcMain.handle('agents:regenerate'");
  assert.ok(start !== -1);
  const end = mainSrc.indexOf('ipcMain.handle(', start + 10);
  const handler = mainSrc.slice(start, end === -1 ? mainSrc.length : end);
  assert.match(handler, /return\s*\{\s*ok:\s*res\.ok,\s*content:\s*res\.content,\s*reason:\s*res\.reason/,
    'success return is exactly { ok, content, reason }');
  assert.ok(!/return[^;]*apiKey/.test(handler), 'the handler never returns the apiKey');
});

// ===========================================================================
// PART C — renderer/renderer.js pure logic (headless extraction).
// ===========================================================================

const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const AGENTS_DIR = path.join(REPO, '.claude', 'agents');
const AGENT_FILES = ['ba.md', 'coder.md', 'tech-lead.md', 'tester.md'];

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

function loadHelpers() {
  const body = [
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
    extractFn(rendererSrc, 'resolveAgentBlockScalar'),
    extractFn(rendererSrc, 'formatAgentDescription'),
    extractFn(rendererSrc, 'parseAgentFileRenderer'),
    extractFn(rendererSrc, 'serializeAgentDescription'),
    extractFn(rendererSrc, 'serializeAgentEdits'),
    extractFn(rendererSrc, 'stripOneCodeFence'),
    extractFn(rendererSrc, 'agentDescriptionValid'),
    extractFn(rendererSrc, 'sanitizeAgentScalarField'),
    extractFn(rendererSrc, 'sanitizeAgentToolsField'),
    extractFn(rendererSrc, 'sanitizeAgentModelField'),
    extractFn(rendererSrc, 'validateRegeneratedAgent'),
    'return { parseAgentFileRenderer, serializeAgentEdits, stripOneCodeFence, validateRegeneratedAgent, agentDescriptionValid };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}
const {
  parseAgentFileRenderer,
  serializeAgentEdits,
  stripOneCodeFence,
  validateRegeneratedAgent
} = loadHelpers();

// --- serializeAgentEdits: byte-identical no-op round-trip on REAL files -------

for (const file of AGENT_FILES) {
  test(`serializeAgentEdits: no-op (no fields passed) reproduces ${file} byte-for-byte`, () => {
    const original = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const parsed = parseAgentFileRenderer(original);
    assert.ok(parsed, `${file} parses`);
    // Passing no edits falls back to every parsed value → identical bytes.
    const out = serializeAgentEdits(parsed, {});
    assert.equal(out, original, `${file} round-trips byte-for-byte with no edits`);
  });

  test(`serializeAgentEdits: re-supplying the SAME field values reproduces ${file} byte-for-byte`, () => {
    const original = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const parsed = parseAgentFileRenderer(original);
    const out = serializeAgentEdits(parsed, {
      description: parsed.fm.description,
      tools: parsed.fm.tools != null ? String(parsed.fm.tools).trim() : '',
      model: parsed.fm.model != null ? String(parsed.fm.model).trim() : '',
      body: parsed.body
    });
    assert.equal(out, original, `${file} round-trips byte-for-byte when nothing actually changed`);
  });
}

test('serializeAgentEdits: editing ONLY the body leaves the frontmatter block byte-identical', () => {
  const original = fs.readFileSync(path.join(AGENTS_DIR, 'ba.md'), 'utf8');
  const parsed = parseAgentFileRenderer(original);
  const NEWBODY = 'You are the business analyst.\n\nCompletely rewritten body text.\n';
  const out = serializeAgentEdits(parsed, { body: NEWBODY });
  const reparsed = parseAgentFileRenderer(out);
  // Frontmatter keys byte-identical to the original raw lines.
  const origParsed = parseAgentFileRenderer(original);
  assert.deepEqual(reparsed.meta.keyOrder, origParsed.meta.keyOrder, 'no keys added/removed');
  for (const key of origParsed.meta.keyOrder) {
    assert.deepEqual(reparsed.meta.rawByKey[key], origParsed.meta.rawByKey[key], `${key} raw lines byte-identical`);
  }
  assert.equal(reparsed.body, NEWBODY, 'body updated');
  // And the exact frontmatter prefix (through the closing fence) is unchanged.
  const origFmPrefix = original.slice(0, original.indexOf('\n---', 4) + 4);
  assert.ok(out.startsWith(origFmPrefix), 'the frontmatter prefix is byte-identical');
});

test('serializeAgentEdits: empty (trimmed) Tools/Model OMITS the key (empty-means-omit)', () => {
  const original = fs.readFileSync(path.join(AGENTS_DIR, 'ba.md'), 'utf8');
  const parsed = parseAgentFileRenderer(original);
  assert.ok(parsed.meta.keyOrder.includes('tools'), 'ba.md has tools');
  assert.ok(parsed.meta.keyOrder.includes('model'), 'ba.md has model');
  const out = serializeAgentEdits(parsed, { tools: '   ', model: '' });
  const reparsed = parseAgentFileRenderer(out);
  assert.ok(!reparsed.meta.keyOrder.includes('tools'), 'emptied Tools key is omitted');
  assert.ok(!reparsed.meta.keyOrder.includes('model'), 'emptied Model key is omitted');
  assert.ok(reparsed.meta.keyOrder.includes('name'), 'name preserved');
  assert.ok(reparsed.meta.keyOrder.includes('description'), 'description preserved');
});

test('serializeAgentEdits: a newly-added model is inserted in canonical position (after tools)', () => {
  // A synthetic agent with name/description/tools but NO model (every bundled
  // orchestrate agent now pins a model, so this path uses an in-memory fixture).
  const original = [
    '---', 'name: orchestrate-sample', 'description: >-', '  A sample agent.',
    'tools: Read, Grep, Glob', '---', '', 'Sample body.', '',
  ].join('\n');
  const parsed = parseAgentFileRenderer(original);
  assert.ok(!parsed.meta.keyOrder.includes('model'), 'the sample agent has no model to start');
  const out = serializeAgentEdits(parsed, { model: 'claude-opus-4' });
  const reparsed = parseAgentFileRenderer(out);
  assert.equal(reparsed.fm.model, 'claude-opus-4', 'model added');
  // Canonical order name → description → tools → model.
  const order = reparsed.meta.keyOrder;
  assert.ok(order.indexOf('model') > order.indexOf('tools'), 'model comes after tools');
  assert.ok(order.indexOf('tools') > order.indexOf('description'), 'tools after description');
});

test('serializeAgentEdits: CRLF line endings are preserved on a body edit', () => {
  const crlf = [
    '---', 'name: orchestrate-docs', 'description: >-', '  A docs agent.', 'tools: Read', '---', '', 'Old body.', ''
  ].join('\r\n');
  const parsed = parseAgentFileRenderer(crlf);
  assert.equal(parsed.meta.eol, '\r\n', 'CRLF detected');
  const out = serializeAgentEdits(parsed, { body: 'New body line one.\r\nNew body line two.\r\n' });
  assert.ok(/\r\n/.test(out), 'output keeps CRLF');
  assert.ok(!/[^\r]\n/.test(out.replace(/\r\n/g, '')), 'no bare LF introduced');
  const reparsed = parseAgentFileRenderer(out);
  assert.equal(reparsed.fm.name, 'orchestrate-docs', 'name preserved across CRLF edit');
});

test('serializeAgentEdits: a file with NO body keeps its no-trailing-EOL shape when body stays empty', () => {
  const noBody = ['---', 'name: orchestrate-docs', 'description: >-', '  A docs agent.', '---'].join('\n');
  const parsed = parseAgentFileRenderer(noBody);
  assert.equal(parsed.meta.hasBody, false, 'no body detected');
  const out = serializeAgentEdits(parsed, {});
  assert.equal(out, noBody, 'no-body file round-trips byte-for-byte (no trailing EOL added)');
});

test('serializeAgentEdits: description change routes through the folded 2-space-indented path', () => {
  const original = fs.readFileSync(path.join(AGENTS_DIR, 'ba.md'), 'utf8');
  const parsed = parseAgentFileRenderer(original);
  const out = serializeAgentEdits(parsed, { description: 'A single fresh line describing the agent for the test.' });
  assert.match(out, /description: >-/, 'folded block indicator emitted');
  // Continuation lines are 2-space indented (injection-safe home for free text).
  assert.match(out, /\n {2}A single fresh line/, 'continuation is 2-space indented');
  const reparsed = parseAgentFileRenderer(out);
  assert.match(reparsed.fm.description, /A single fresh line/);
});

test('serializeAgentEdits: returns null for a bad parsed object', () => {
  assert.equal(serializeAgentEdits(null, {}), null);
  assert.equal(serializeAgentEdits({}, {}), null);
});

// --- stripOneCodeFence --------------------------------------------------------

test('stripOneCodeFence: strips a ```markdown fence wrapping the whole payload', () => {
  const wrapped = '```markdown\n' + VALID_AGENT + '\n```';
  assert.equal(stripOneCodeFence(wrapped), VALID_AGENT);
});

test('stripOneCodeFence: strips a bare ``` fence', () => {
  const wrapped = '```\n' + VALID_AGENT + '\n```';
  assert.equal(stripOneCodeFence(wrapped), VALID_AGENT);
});

test('stripOneCodeFence: leaves an unfenced agent file untouched', () => {
  assert.equal(stripOneCodeFence(VALID_AGENT), VALID_AGENT);
});

test('stripOneCodeFence: non-string input yields ""', () => {
  assert.equal(stripOneCodeFence(null), '');
  assert.equal(stripOneCodeFence(undefined), '');
});

// --- validateRegeneratedAgent -------------------------------------------------

test('validateRegeneratedAgent: accepts a valid file and returns sanitized fields', () => {
  const r = validateRegeneratedAgent(VALID_AGENT, 'orchestrate-docs');
  assert.equal(r.ok, true);
  assert.match(r.fields.description, /docs agent/);
  assert.equal(r.fields.tools, 'Read, Grep, Bash');
  assert.equal(r.fields.model, 'claude-sonnet-5');
  assert.match(r.fields.body, /You are the docs agent/);
});

test('validateRegeneratedAgent: accepts a valid file wrapped in a ```markdown fence', () => {
  const r = validateRegeneratedAgent('```markdown\n' + VALID_AGENT + '\n```', 'orchestrate-docs');
  assert.equal(r.ok, true, 'the outer fence is stripped and the file validates');
});

test('validateRegeneratedAgent: rejects text that does not parse as an agent file', () => {
  const r = validateRegeneratedAgent('Sure! Here is your updated agent, hope it helps.', 'orchestrate-docs');
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('validateRegeneratedAgent: rejects a renamed agent', () => {
  const renamed = VALID_AGENT.replace('name: orchestrate-docs', 'name: orchestrate-evil');
  const r = validateRegeneratedAgent(renamed, 'orchestrate-docs');
  assert.equal(r.ok, false);
  assert.match(r.error, /renamed|name/i);
});

test('validateRegeneratedAgent: rejects an empty description', () => {
  const empty = [
    '---', 'name: orchestrate-docs', 'description: >-', '  ', 'tools: Read', '---', '', 'body', ''
  ].join('\n');
  const r = validateRegeneratedAgent(empty, 'orchestrate-docs');
  assert.equal(r.ok, false);
  assert.match(r.error, /description/i);
});

test('validateRegeneratedAgent: rejects a model scalar that begins with ---', () => {
  const injected = [
    '---', 'name: orchestrate-docs', 'description: >-', '  A docs agent.', 'model: ---evil', '---', '', 'body', ''
  ].join('\n');
  const r = validateRegeneratedAgent(injected, 'orchestrate-docs');
  assert.equal(r.ok, false, 'a model beginning with --- is rejected');
});

test('validateRegeneratedAgent: rejects a tools value with disallowed characters', () => {
  const injected = [
    '---', 'name: orchestrate-docs', 'description: >-', '  A docs agent.', 'tools: Read; rm -rf /', '---', '', 'body', ''
  ].join('\n');
  const r = validateRegeneratedAgent(injected, 'orchestrate-docs');
  assert.equal(r.ok, false, 'a tools value with a shell metacharacter is rejected');
});

test('validateRegeneratedAgent: a file with no tools/model still validates (fields default empty)', () => {
  const minimal = ['---', 'name: orchestrate-docs', 'description: >-', '  A docs agent.', '---', '', 'body', ''].join('\n');
  const r = validateRegeneratedAgent(minimal, 'orchestrate-docs');
  assert.equal(r.ok, true);
  assert.equal(r.fields.tools, '');
  assert.equal(r.fields.model, '');
});
