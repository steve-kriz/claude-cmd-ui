'use strict';

// Pure decision logic for the Slack <-> Claude thread proxy (TASK-009).
//
// When Slack is connected the app uses ONE Slack thread as a two-way proxy
// between the Claude window (cmd pane) and Slack: connect posts a single anchor
// message and reuses its `thread_ts` for the whole session. These helpers hold
// the two "should we act?" decisions so they can be unit-tested without the
// renderer / Electron:
//
//   isProxyEnabled(state)          — is the two-way proxy active at all?
//   shouldDispatchIncoming(msg, s) — should this inbound Slack message be fed
//                                    to Claude (bot/self/seen/thread filtering)?
//   shouldFlushCapture(state)      — should the accumulated capture buffer be
//                                    flushed to the anchor thread right now
//                                    (mid-run periodic flush during long runs)?
//
// The module is intentionally free of DOM, Electron and network access. The
// renderer keeps a verbatim mirror of this logic (search "Mirrors … in
// lib/slack-proxy.js"); keep the two in sync.

// The proxy is only active once a connection is established AND a single anchor
// thread has been created (state.threadTs). When this is false BOTH directions
// must be a no-op: nothing is posted outbound and nothing is written into the
// Claude window from Slack.
function isProxyEnabled(state) {
  return !!(state && state.connected && state.threadTs);
}

// Membership test that tolerates a Set, an array, or absence.
function hasSeen(seen, ts) {
  if (!seen || ts == null) return false;
  if (typeof seen.has === 'function') return seen.has(ts);
  if (Array.isArray(seen)) return seen.indexOf(ts) !== -1;
  return false;
}

// Decide whether an incoming Slack message should be dispatched to the Claude
// window. Returns { accept, reason } so callers/tests can see WHY a message was
// dropped. A message is accepted only when:
//   - the proxy is enabled (connected + anchor thread exists),
//   - it carries a ts,
//   - it is not the bot's own post (bot_id / botUserId) and hasn't been seen
//     (seenTs) — this is what stops Claude's own output looping back in,
//   - it is a real user message (no disruptive subtype), and
//   - it belongs to the session anchor thread (thread_ts === state.threadTs).
function shouldDispatchIncoming(msg, state) {
  if (!msg || msg.ts == null) return { accept: false, reason: 'no-ts' };
  if (!isProxyEnabled(state)) return { accept: false, reason: 'not-connected' };
  if (msg.bot_id) return { accept: false, reason: 'bot' };
  if (state.botUserId && msg.user === state.botUserId) return { accept: false, reason: 'self' };
  if (hasSeen(state.seenTs, msg.ts)) return { accept: false, reason: 'seen' };
  if (msg.subtype && msg.subtype !== 'thread_broadcast' && msg.subtype !== 'file_share') {
    return { accept: false, reason: 'subtype' };
  }
  // Only replies within the session anchor thread are proxied. The anchor
  // itself (ts === threadTs, no thread_ts) is the bot's own post and is already
  // rejected above by bot_id / seenTs; a top-level channel message has no
  // thread_ts and is not part of this session.
  const thread = msg.thread_ts || msg.ts;
  if (thread !== state.threadTs) return { accept: false, reason: 'other-thread' };
  return { accept: true, reason: 'ok' };
}

// Decide whether the accumulated capture buffer should be flushed to the anchor
// thread on a periodic tick WHILE a run is still busy (TASK-061). Today output is
// only posted at idle (slackOnFinished); this lets a long run stream progress to
// the thread instead of going silent for minutes. Returns true only when the
// proxy is enabled, replies are being posted, there is buffered output, and the
// run is currently busy. False (never throws) for null/partial state.
function shouldFlushCapture(state) {
  return !!(
    isProxyEnabled(state) &&
    state.postReplies &&
    typeof state.captureBuffer === 'string' &&
    state.captureBuffer.length > 0 &&
    state.busy === true
  );
}

// ── Secret redaction (TASK-063) ─────────────────────────────────────────────
// Mask common secret shapes in AUTO-POSTED terminal output before it reaches
// Slack (slackFlushTick + slackOnFinished). cleanTerminalOutput strips
// ANSI/chrome but does NO secret redaction; this runs AFTER it. Deliberately
// CONSERVATIVE to avoid mangling ordinary prose/code: anchors on known token
// prefixes and high-entropy length thresholds rather than broad matches. Each
// matched secret is replaced with the fixed placeholder '***REDACTED***'.
//
// Patterns covered:
//   - KEY=VALUE / KEY: VALUE where the key name matches
//     /secret|token|key|password|passwd|pwd|apikey/i (value masked, key kept)
//   - Bearer <token>   (Authorization headers; keeps the 'Bearer ' scheme word)
//   - sk-…             OpenAI-style secret keys (>=16 token chars)
//   - xoxb-/xoxp-/xoxa-/xoxr-/xoxs-/xoxe-/xoxd-/xapp-…  Slack tokens (TASK-067)
//   - ghp_/gho_/ghu_/ghs_/ghr_…       GitHub tokens (>=20 chars)
//   - github_pat_…     GitHub fine-grained PAT (>=20 chars)          (TASK-067)
//   - glpat-…          GitLab PAT (>=16 chars)                       (TASK-067)
//   - npm_…            npm access token (>=30 chars)                 (TASK-067)
//   - dop_v1_…         DigitalOcean token (>=40 chars)               (TASK-067)
//   - AIza…            Google API key (>=20 chars)                   (TASK-067)
//   - SG.<id>.<secret> SendGrid API key                             (TASK-067)
//   - bare JWTs        eyJ<b64url>.<b64url>.<b64url>                 (TASK-067)
//   - AKIA…/ASIA…      AWS access key ids (16 upper-alnum chars)
//   - long continuous hex blobs (>=32) and base64 blobs (>=40)
//
// Never throws: null / undefined / non-string input returns '' (safe).
function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  const R = '***REDACTED***';
  let out = text;
  // KEY=VALUE / KEY: VALUE with a secret-looking key name (mask value, keep key).
  out = out.replace(
    /\b([\w.-]*(?:secret|token|key|password|passwd|pwd|apikey)[\w.-]*)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s]+)/gi,
    (m, key, sep) => key + sep + R
  );
  // Bearer <token> (keep the scheme word, mask the credential).
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer ' + R);
  // Inline connection-string credentials scheme://user:password@host — mask
  // ONLY the password (group 2), keeping scheme+user (group 1) and the '@'
  // (group 3) readable; also covers the password-only form scheme://:pass@host
  // (empty user). Char classes exclude '@', whitespace and '/' so the match
  // cannot run past the authority, and a URL with no ':pass@' segment (e.g.
  // https://example.com/path or http://host:8080/path) is left untouched.
  // Linear — no nested quantifiers, so backtracking-safe.
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]*:)([^@\s/]+)(@)/g, '$1' + R + '$3');
  // Known token prefixes with plausible length/charset.
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, R);
  out = out.replace(/\bx(?:ox[baprsed]|app)-[A-Za-z0-9-]{8,}/g, R);
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R);
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R);
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, R);
  out = out.replace(/\bnpm_[A-Za-z0-9]{30,}/g, R);
  out = out.replace(/\bdop_v1_[A-Za-z0-9]{40,}/g, R);
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, R);
  out = out.replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, R);
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R);
  // Bare JWTs (base64url header.payload.signature) — mask BEFORE the blob rules.
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, R);
  // High-entropy blobs above a length threshold (hex first, then base64). These
  // mask UNCONDITIONALLY: over-redaction (e.g. masking a bare git SHA) is the safe
  // direction for a security boundary that posts to an external destination.
  // A blanket 40-hex exemption was tried (TASK-069) and reverted — real secrets
  // are also exactly 40 hex (legacy GitHub OAuth tokens, hex-encoded 160-bit keys)
  // and would have leaked unlabeled.
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, R);
  out = out.replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, R);
  return out;
}

// ── Readability pass for auto-posted output (TASK-071) ─────────────────────
// Mechanical, deterministic cleanup of Claude TUI terminal output for the two
// AUTO-POST paths (slackFlushTick + slackOnFinished). Runs BETWEEN
// cleanTerminalOutput (which strips ANSI/chrome) and redactSecrets, so
// redactSecrets stays the LAST transform before posting and the TASK-063
// guarantee (no auto-post path posts un-redacted output) is untouched. This is
// dedupe / strip / collapse ONLY — it never rewrites, reorders or summarizes.
// Behaviors:
//   - Collapse consecutive identical lines to one (TUI redraw dedupe).
//   - Drop WHOLE Claude-TUI status/hint noise lines (never a real content line
//     that merely contains such a glyph mid-line): spinner-prefixed progress
//     lines (leading ✻/✽/✶/✢/·-style glyph + a "…ing…" gerund phrase),
//     standalone "(esc to interrupt)" hints, standalone elapsed/token counter
//     lines, and ⏵⏵-style mode/permission hint lines.
//   - Collapse remaining runs of 2+ blank lines to a single blank line; trim
//     outer whitespace.
// Never throws: null / undefined / non-string / numeric input returns ''.
function humanizeSlackOutput(text) {
  if (typeof text !== 'string' || !text) return '';
  // Whole-line Claude-TUI noise patterns, tested against the TRIMMED line so a
  // real content line that merely contains such a glyph mid-line is never hit.
  const NOISE = [
    // Spinner progress line: leading spinner glyph + a "…ing…" gerund phrase,
    // e.g. "✻ Thinking… (esc to interrupt)".
    /^[✻✽✶✢✳✷✴✵✺∗·]\s+.*[A-Za-z]+ing(?:…|\.\.\.)/,
    // Standalone "(esc to interrupt)" hint line.
    /^\(?\s*esc to interrupt\s*\)?$/i,
    // Standalone elapsed / token counter line, e.g. "12s", "↑ 1.2k tokens",
    // "5s · 234 tokens".
    /^[·•\s]*(?:\d+(?:\.\d+)?\s*[smh](?:\s+\d+(?:\.\d+)?\s*[smh])*|[↑↓⚒]?\s*[\d.,]+\s*[kKmM]?\s*tokens?)(?:\s*·\s*(?:\d+(?:\.\d+)?\s*[smh](?:\s+\d+(?:\.\d+)?\s*[smh])*|[↑↓⚒]?\s*[\d.,]+\s*[kKmM]?\s*tokens?))*$/i,
    // Mode/permission hint line, e.g. "⏵⏵ accept edits on (shift+tab to cycle)".
    /^⏵/,
  ];
  const kept = [];
  let prev = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r/g, '');
    const trimmed = line.trim();
    if (trimmed && NOISE.some((re) => re.test(trimmed))) continue;
    if (line === prev) continue; // collapse consecutive identical (TUI redraw)
    kept.push(line);
    prev = line;
  }
  // Collapse any remaining 2+ blank-line runs to a single blank line, then trim.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Neutralize ("defang") Slack broadcast/mention CONTROL SEQUENCES in app-posted
// command / failure replies so crafted, semi-trusted content (thread text,
// ticket titles, error strings) cannot induce a channel-wide ping or a mention.
// Slack honors already-encoded control forms inside chat.postMessage text:
//   <!channel> <!here> <!everyone>   broadcast pings
//   <!subteam^ID>                    user-group ping
//   <@U…>  <#C…>                     user / channel links
// The cleanest defang is to break Slack's leading `<` trigger for these forms
// ONLY: replace the opening `<` of a `<!…>` / `<@…>` / `<#…>` token with the
// HTML-style entity `&lt;`, which Slack renders as a literal `<`. The token then
// displays inertly (e.g. "<!channel>") and is never interpreted as a mention or
// broadcast. A lone `<` in ordinary prose or code (e.g. "a < b", "List<int>") is
// left untouched — the regex only fires when `<` is immediately followed by `!`,
// `@` or `#` and a closing `>` follows on the same line — so replies stay
// readable and chunking is unaffected. Never throws: non-string input → ''.
function defangSlackControlSequences(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/<([!@#][^>\n]*)>/g, '&lt;$1>');
}

module.exports = { isProxyEnabled, shouldDispatchIncoming, hasSeen, shouldFlushCapture, redactSecrets, humanizeSlackOutput, defangSlackControlSequences };
