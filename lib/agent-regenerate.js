'use strict';

// AI-assisted regeneration of an agent DEFINITION file (TASK-130). Given the
// current `.claude/agents/<name>.md` text plus a natural-language instruction
// (e.g. "also allow the Bash tool and mention linting in the description"), this
// module asks a Claude model to return the COMPLETE rewritten agent file. The
// caller (renderer) then parses + validates the result behind the same safety
// rails as a manual edit and only writes it after the user reviews and clicks
// Save — nothing here writes to disk.
//
// This is modeled EXACTLY on lib/slack-summarize.js: it is intentionally
// Electron-free, its network call is injectable (the `httpRequest` option) so it
// can be unit-tested with a mocked client and NO real API traffic, and it NEVER
// throws — every failure (no key, empty instruction/content, non-200, network
// error, timeout, malformed response, empty content) returns a structured
// { ok, content, reason } result. The main process wires the real client + key
// + input-size clamp.
//
// Anthropic Messages API (verified, same as the summarizer):
//   POST https://api.anthropic.com/v1/messages
//   headers: x-api-key, anthropic-version: 2023-06-01, content-type: json
//   body: { model, max_tokens, system, messages: [{ role:'user', content }] }
//   reply: { content: [ { type:'text', text } ], ... }  → first text block.
//
// NEVER logs or emits the API key (it lives only in the request headers).

const https = require('https');

// Model id kept in ONE place. Sonnet is stronger than Haiku for rewriting a full
// agent definition (the summarizer uses Haiku for a much simpler task).
const REGEN_MODEL = 'claude-sonnet-5';
const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_PATH = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Agent files are multi-KB; a whole rewritten file must fit, so the summarizer's
// 512-token cap is far too small. This bounds the OUTPUT the model may produce.
const REGEN_MAX_TOKENS = 8192;
// Time-bound the API call. Regeneration is user-initiated and produces a larger
// document than a summary, so this is more generous than the summarizer's 8s.
const REGEN_TIMEOUT_MS = 45000;

// System instructions: emit ONLY the complete agent .md file, no prose, no
// fences. The renderer tolerates one stray surrounding code fence defensively,
// but we ask the model to omit them.
const REGEN_SYSTEM_PROMPT = [
  'You are editing a Claude Code subagent definition file (a Markdown file with',
  'YAML frontmatter). You are given the CURRENT file and an instruction from the',
  'user describing how it should change. Return the COMPLETE, updated agent file',
  'and nothing else.',
  '',
  'Hard rules:',
  '- Output ONLY the file contents, starting with the opening "---" frontmatter',
  '  fence. Do NOT wrap the output in code fences (no ``` ). Do NOT add any',
  '  commentary, preamble, or explanation before or after the file.',
  '- Keep the frontmatter shape: a "name:" line, a folded "description: >-" block,',
  '  and optional "tools:" and "model:" single-line scalars, then "---", then the',
  '  markdown body.',
  '- Do NOT change the "name:" value — the agent must not be renamed.',
  '- "description" must remain non-empty. Put free-form prose only inside the',
  '  folded description block or the markdown body, never as a bare scalar.',
  '- "tools" and "model" must each stay on a single line with no line breaks and',
  '  must not begin with "---".'
].join('\n');

// The user-turn content: the current file followed by the instruction, clearly
// delimited so the model can tell them apart.
function buildUserContent(currentContent, instruction) {
  return [
    'CURRENT AGENT FILE:',
    '',
    currentContent,
    '',
    '---- END OF CURRENT AGENT FILE ----',
    '',
    'INSTRUCTION:',
    instruction
  ].join('\n');
}

// Default (real) HTTPS client, identical in shape to lib/slack-summarize.js's.
// Resolves { status, body }; rejects only on socket error / timeout so the
// caller's try/catch converts it to a structured failure. The API key lives only
// in the request headers and is never logged.
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
    req.setTimeout(timeoutMs || REGEN_TIMEOUT_MS, () => {
      req.destroy(new Error('anthropic request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// Ask the model to regenerate an agent file. Returns a Promise of
// { ok, content, reason } and NEVER rejects. On success `ok` is true and
// `content` is the model's raw text (the caller parses + validates it before
// use). On any failure `ok` is false, `content` is '' and `reason` names the
// branch (no-key, empty-instruction, empty-content, bad-status, bad-json,
// empty-response, error, ok).
//
// opts:
//   apiKey      LOG_REDACTING_ANTHROPIC_KEY (empty → reason 'no-key', no call)
//   content     the current agent file text (empty → reason 'empty-content')
//   instruction the user's change request (empty → reason 'empty-instruction')
//   httpRequest injectable client for tests (defaults to the real https client)
//   model, maxTokens, timeoutMs, system — tunables with sane defaults
async function regenerateAgentFile(opts = {}) {
  const {
    apiKey = '',
    content = '',
    instruction = '',
    httpRequest = defaultHttpRequest,
    model = REGEN_MODEL,
    maxTokens = REGEN_MAX_TOKENS,
    timeoutMs = REGEN_TIMEOUT_MS,
    system = REGEN_SYSTEM_PROMPT
  } = opts;

  const fileText = typeof content === 'string' ? content : '';
  const instr = typeof instruction === 'string' ? instruction.trim() : '';

  if (!apiKey) return { ok: false, content: '', reason: 'no-key' };
  if (!instr) return { ok: false, content: '', reason: 'empty-instruction' };
  if (!fileText.trim()) return { ok: false, content: '', reason: 'empty-content' };

  const userContent = buildUserContent(fileText, instr);

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
  regenerateAgentFile,
  defaultHttpRequest,
  buildUserContent,
  REGEN_MODEL,
  REGEN_MAX_TOKENS,
  REGEN_TIMEOUT_MS,
  REGEN_SYSTEM_PROMPT
};
