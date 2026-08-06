'use strict';

// AI-assisted regeneration of ONE phase-section's prose inside the orchestrate
// SKILL.md (TASK-184). Given the CURRENT body of a single `## Phase <n> — …`
// section (extracted via lib/skill-section.js's extractPhaseBody) plus a
// natural-language instruction, this module asks a Claude model to rewrite
// just that section's prose and return ONLY the rewritten section body — not
// the whole file, and not a heading — so the volatile output stays small. The
// caller (renderer, TASK-185) validates the result and splices it back with
// lib/skill-section.js's replacePhaseBody, writing only on explicit Save.
// Nothing here writes to disk.
//
// This is modeled EXACTLY on lib/agent-regenerate.js: it is intentionally
// Electron-free, its network call is injectable (the `httpRequest` option) so
// it can be unit-tested with a mocked client and NO real API traffic, and it
// NEVER throws — every failure (no key, empty instruction/content, non-200,
// network error, timeout, malformed response, empty content) returns a
// structured { ok, content, reason } result. The main process wires the real
// client + key + input-size clamp.
//
// Anthropic Messages API (verified, same as lib/agent-regenerate.js):
//   POST https://api.anthropic.com/v1/messages
//   headers: x-api-key, anthropic-version: 2023-06-01, content-type: json
//   body: { model, max_tokens, system, messages: [{ role:'user', content }] }
//   reply: { content: [ { type:'text', text } ], ... }  → first text block.
//
// NEVER logs or emits the API key (it lives only in the request headers).

const https = require('https');

// Model id kept in ONE place, matching lib/agent-regenerate.js's REGEN_MODEL.
const SKILL_REGEN_MODEL = 'claude-sonnet-5';
const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_PATH = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// A single phase-section body is far smaller than a whole agent file, but
// give it comparable headroom to a full paragraph rewrite.
const SKILL_REGEN_MAX_TOKENS = 4096;
// Time-bound the API call; user-initiated, matches lib/agent-regenerate.js.
const SKILL_REGEN_TIMEOUT_MS = 45000;

// System instructions: emit ONLY the rewritten section body, no heading, no
// other phases, no fences, no commentary. The caller tolerates one stray
// surrounding code fence defensively (skill-section.js's stripOneCodeFence),
// but we ask the model to omit them, and explicitly forbid multi-section
// output so the splice-time byte-diff guard is never relied on alone.
const SKILL_REGEN_SYSTEM_PROMPT = [
  'You are editing ONE section of a Claude Code orchestration SKILL.md file:',
  'the prose body of a single "## Phase <n> — ..." section that describes one',
  'step of a multi-phase ticket workflow. You are given the CURRENT body text',
  'of just that one section (NOT the whole file, and NOT its heading line) and',
  'an instruction from the user describing how it should change.',
  '',
  'Hard rules:',
  '- Output ONLY the rewritten body text for THIS ONE section. Do NOT include',
  '  the "## Phase <n>" heading line itself. Do NOT wrap the output in code',
  '  fences (no ``` ). Do NOT add any commentary, preamble, or explanation',
  '  before or after the text.',
  '- Do NOT include any OTHER "## " level-2 heading anywhere in your output —',
  '  you are rewriting only this one section\'s prose, never the rest of the',
  '  file, and never more than one section.',
  '- Preserve any Markdown structure (lists, bold labels, fenced examples) the',
  '  instruction does not ask you to change; keep the same phase\'s intent and',
  '  role in the workflow, and do not change which agent this phase dispatches',
  '  to unless the instruction explicitly asks for that.'
].join('\n');

// The user-turn content: the current section body followed by the
// instruction, clearly delimited so the model can tell them apart.
function buildUserContent(currentSectionBody, instruction) {
  return [
    'CURRENT PHASE-SECTION BODY:',
    '',
    currentSectionBody,
    '',
    '---- END OF CURRENT PHASE-SECTION BODY ----',
    '',
    'INSTRUCTION:',
    instruction
  ].join('\n');
}

// Default (real) HTTPS client, identical in shape to lib/agent-regenerate.js's.
// Resolves { status, body }; rejects only on socket error / timeout so the
// caller's try/catch converts it to a structured failure. The API key lives
// only in the request headers and is never logged.
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
    req.setTimeout(timeoutMs || SKILL_REGEN_TIMEOUT_MS, () => {
      req.destroy(new Error('anthropic request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// Ask the model to regenerate ONE phase-section's prose body. Returns a
// Promise of { ok, content, reason } and NEVER rejects. On success `ok` is
// true and `content` is the model's raw text (the caller validates + splices
// it before use, and only writes on explicit Save). On any failure `ok` is
// false, `content` is '' and `reason` names the branch (no-key,
// empty-instruction, empty-content, bad-status, bad-json, empty-response,
// error, ok).
//
// opts:
//   apiKey      LOG_REDACTING_ANTHROPIC_KEY (empty → reason 'no-key', no call)
//   content     the current phase-section body text (empty → reason 'empty-content')
//   instruction the user's change request (empty → reason 'empty-instruction')
//   httpRequest injectable client for tests (defaults to the real https client)
//   model, maxTokens, timeoutMs, system — tunables with sane defaults
async function regeneratePhaseSection(opts = {}) {
  const {
    apiKey = '',
    content = '',
    instruction = '',
    httpRequest = defaultHttpRequest,
    model = SKILL_REGEN_MODEL,
    maxTokens = SKILL_REGEN_MAX_TOKENS,
    timeoutMs = SKILL_REGEN_TIMEOUT_MS,
    system = SKILL_REGEN_SYSTEM_PROMPT
  } = opts;

  const sectionText = typeof content === 'string' ? content : '';
  const instr = typeof instruction === 'string' ? instruction.trim() : '';

  if (!apiKey) return { ok: false, content: '', reason: 'no-key' };
  if (!instr) return { ok: false, content: '', reason: 'empty-instruction' };
  if (!sectionText.trim()) return { ok: false, content: '', reason: 'empty-content' };

  const userContent = buildUserContent(sectionText, instr);

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
    // Network error / timeout / anything unexpected → structured failure.
    return { ok: false, content: '', reason: 'error' };
  }
}

module.exports = {
  regeneratePhaseSection,
  defaultHttpRequest,
  buildUserContent,
  SKILL_REGEN_MODEL,
  SKILL_REGEN_MAX_TOKENS,
  SKILL_REGEN_TIMEOUT_MS,
  SKILL_REGEN_SYSTEM_PROMPT
};
