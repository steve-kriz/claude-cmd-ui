'use strict';

// AI-assisted drafting/rewriting of ONE Board column's free-text "instructions"
// field (the brief the orchestrator dispatches for tickets sitting in that
// lane). Given the column's label/description/display-agent for context, the
// CURRENT instructions text (which may be EMPTY — this doubles as "generate
// from scratch" for a column that has none yet), and a natural-language
// instruction, this module asks a Claude model to return ONLY the replacement
// instructions text. The caller (renderer) loads the result into the textarea
// as a preview; nothing here writes to disk or to tasks/team-config.json —
// the existing Board Save button persists it like any other field edit.
//
// Modeled EXACTLY on lib/skill-regenerate.js / lib/agent-regenerate.js: it is
// intentionally Electron-free, its network call is injectable (the
// `httpRequest` option) so it can be unit-tested with a mocked client and NO
// real API traffic, and it NEVER throws — every failure (no key, empty
// instruction, non-200, network error, timeout, malformed response, empty
// content) returns a structured { ok, content, reason } result. The main
// process wires the real client + key + input-size clamps.
//
// Anthropic Messages API (verified, same as the other regenerators):
//   POST https://api.anthropic.com/v1/messages
//   headers: x-api-key, anthropic-version: 2023-06-01, content-type: json
//   body: { model, max_tokens, system, messages: [{ role:'user', content }] }
//   reply: { content: [ { type:'text', text } ], ... }  → first text block.
//
// NEVER logs or emits the API key (it lives only in the request headers).

const https = require('https');

const COLUMN_REGEN_MODEL = 'claude-sonnet-5';
const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_PATH = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// A column's instructions are a short brief, not a document — a few hundred
// tokens is generous headroom.
const COLUMN_REGEN_MAX_TOKENS = 2048;
const COLUMN_REGEN_TIMEOUT_MS = 45000;

const COLUMN_REGEN_SYSTEM_PROMPT = [
  'You are drafting the "instructions" field for ONE lane (column) of a ticket',
  'Kanban board. This free-text brief is handed to the dispatched agent for',
  'every ticket sitting in this lane, describing what it should do while the',
  'ticket is in this stage of the workflow.',
  '',
  'You are given the column\'s label, description, and display agent (context',
  'only), the CURRENT instructions text (which may be empty if none exist',
  'yet), and an instruction from the user describing what the brief should say',
  'or how it should change.',
  '',
  'Hard rules:',
  '- Output ONLY the replacement instructions text. Do NOT include a heading or',
  '  label. Do NOT wrap the output in code fences (no ``` ). Do NOT add any',
  '  commentary, preamble, or explanation before or after the text.',
  '- Write it as a direct brief to the agent (imperative, concrete), not a',
  '  description of the column.',
  '- Keep it concise — a short paragraph or a few bullet points, not a document.'
].join('\n');

function buildUserContent({ label, description, agent, instructions, instruction }) {
  return [
    'COLUMN LABEL: ' + (label || '(none)'),
    'COLUMN DESCRIPTION: ' + (description || '(none)'),
    'DISPLAY AGENT: ' + (agent || '(none)'),
    '',
    'CURRENT INSTRUCTIONS:',
    '',
    instructions || '(none yet)',
    '',
    '---- END OF CURRENT INSTRUCTIONS ----',
    '',
    'INSTRUCTION:',
    instruction
  ].join('\n');
}

// Default (real) HTTPS client, identical in shape to the other regenerators.
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
    req.setTimeout(timeoutMs || COLUMN_REGEN_TIMEOUT_MS, () => {
      req.destroy(new Error('anthropic request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// Ask the model to draft/rewrite a column's instructions text. Returns a
// Promise of { ok, content, reason } and NEVER rejects. On success `ok` is
// true and `content` is the model's raw text (the caller previews it in the
// textarea and only persists it via the normal Board Save). On any failure
// `ok` is false, `content` is '' and `reason` names the branch (no-key,
// empty-instruction, bad-status, bad-json, empty-response, error, ok).
//
// opts:
//   apiKey       LOG_REDACTING_ANTHROPIC_KEY (empty → reason 'no-key', no call)
//   instructions the column's CURRENT instructions text — MAY be empty (a
//                brand-new column has none yet; this is a valid "generate
//                from scratch" request, unlike the other regenerators)
//   label, description, agent  context strings, all optional
//   instruction  the user's change/generation request (empty → reason
//                'empty-instruction')
//   httpRequest  injectable client for tests (defaults to the real https client)
//   model, maxTokens, timeoutMs, system — tunables with sane defaults
async function regenerateColumnInstructions(opts = {}) {
  const {
    apiKey = '',
    instructions = '',
    label = '',
    description = '',
    agent = '',
    instruction = '',
    httpRequest = defaultHttpRequest,
    model = COLUMN_REGEN_MODEL,
    maxTokens = COLUMN_REGEN_MAX_TOKENS,
    timeoutMs = COLUMN_REGEN_TIMEOUT_MS,
    system = COLUMN_REGEN_SYSTEM_PROMPT
  } = opts;

  const instr = typeof instruction === 'string' ? instruction.trim() : '';

  if (!apiKey) return { ok: false, content: '', reason: 'no-key' };
  if (!instr) return { ok: false, content: '', reason: 'empty-instruction' };

  const userContent = buildUserContent({
    label: typeof label === 'string' ? label.trim() : '',
    description: typeof description === 'string' ? description.trim() : '',
    agent: typeof agent === 'string' ? agent.trim() : '',
    instructions: typeof instructions === 'string' ? instructions.trim() : '',
    instruction: instr
  });

  try {
    const res = await httpRequest({ apiKey, model, maxTokens, system, text: userContent, timeoutMs });
    if (!res || res.status !== 200 || typeof res.body !== 'string') {
      return { ok: false, content: '', reason: 'bad-status' };
    }
    let json;
    try { json = JSON.parse(res.body); }
    catch (_) { return { ok: false, content: '', reason: 'bad-json' }; }
    const blocks = json && Array.isArray(json.content) ? json.content : null;
    const block = blocks ? blocks.find((b) => b && b.type === 'text') : null;
    const out = block && typeof block.text === 'string' ? block.text : '';
    if (!out.trim()) return { ok: false, content: '', reason: 'empty-response' };
    return { ok: true, content: out, reason: 'ok' };
  } catch (_) {
    return { ok: false, content: '', reason: 'error' };
  }
}

module.exports = {
  regenerateColumnInstructions,
  defaultHttpRequest,
  buildUserContent,
  COLUMN_REGEN_MODEL,
  COLUMN_REGEN_MAX_TOKENS,
  COLUMN_REGEN_TIMEOUT_MS,
  COLUMN_REGEN_SYSTEM_PROMPT
};
