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

module.exports = { isProxyEnabled, shouldDispatchIncoming, hasSeen };
