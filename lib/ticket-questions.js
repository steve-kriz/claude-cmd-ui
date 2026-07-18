'use strict';

// Electron-free helpers for the "claude questions" flow (TASK-005): when an
// agent needs the user to answer a question before it can continue a ticket, the
// question and the eventually-chosen answer are stored durably ON the ticket so a
// later reader can see both what was asked and what was decided. The board turns
// the ticket's "being worked on" dot YELLOW while it is waiting for that answer.
//
// Like lib/ticket-history.js, lib/ticket-accounting.js and lib/ticket-queue.js
// this file deliberately requires nothing from Electron so it can be unit-tested
// with plain `node --test`. Every function is pure: it computes a decision or a
// NEW frontmatter object and never touches disk. The renderer (a browser script
// that cannot require Node modules) duplicates the tiny `isWaitingForAnswer`
// predicate, matching how TASK-003 handled the browser side.
//
// Storage scheme
// --------------
// The question/answer live in the ticket's flat frontmatter as two keys:
//   - `question`  the text the agent raised (single line).
//   - `answer`    the answer the user chose (single line).
// serializeTicket keeps `id, title, status, created, updated` leading and
// preserves any extra key in insertion order, so `question` / `answer` round-trip
// without disturbing the known ordering or the user-owned `## Additional Context`
// body section (which whole-file writes leave byte-for-byte untouched).
//
// Waiting state is DERIVED, not stored as its own flag: a ticket is "waiting for
// an answer" exactly when it has a non-empty `question` and no non-empty
// `answer`. Deriving it from persisted content is what makes the yellow dot
// update within one board poll: the moment the answer lands on disk the predicate
// flips and the next render drops the yellow.
//
// Frontmatter values are single-line ("key: value"), so question/answer text is
// normalised to a single line (newlines collapsed to spaces) before storage.

// Fixed leading keys the board parser/serializer expect up front, in this order.
const LEADING_KEYS = ['id', 'title', 'status', 'created', 'updated'];

// Return a shallow copy of `fm` with keys ordered: LEADING_KEYS (those present,
// in that order) first, then every other key in its existing insertion order —
// matching serializeTicket and the other lib helpers so the on-disk layout stays
// stable.
function orderFm(fm) {
  const src = fm && typeof fm === 'object' ? fm : {};
  const out = {};
  for (const k of LEADING_KEYS) {
    if (src[k] != null) out[k] = src[k];
  }
  for (const k of Object.keys(src)) {
    if (!(k in out)) out[k] = src[k];
  }
  return out;
}

// Resolve an `updated` timestamp from opts.at (Date | ISO string), defaulting to
// now. Mirrors the pattern in lib/ticket-queue.js.
function resolveNow(opts) {
  const at = opts && opts.at;
  if (at instanceof Date && !Number.isNaN(at.getTime())) return at.toISOString();
  if (typeof at === 'string' && at.trim()) return at.trim();
  return new Date().toISOString();
}

// Collapse any text to a single trimmed line so it fits flat "key: value"
// frontmatter (which cannot hold newlines). Returns '' for null/undefined.
function toSingleLine(v) {
  if (v == null) return '';
  return String(v).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

// True when a frontmatter field holds a non-empty (after-trim) value.
function nonEmpty(v) {
  return v != null && String(v).trim() !== '';
}

// True when the ticket carries a question the agent raised.
function hasQuestion(fm) {
  return !!(fm && nonEmpty(fm.question));
}

// True when the ticket carries a chosen answer.
function hasAnswer(fm) {
  return !!(fm && nonEmpty(fm.answer));
}

// The core predicate: a ticket is waiting for the user's answer exactly when it
// has a question and no answer yet. Pure function of persisted content, so the
// yellow dot derived from it clears within one board poll once the answer lands.
function isWaitingForAnswer(fm) {
  return hasQuestion(fm) && !hasAnswer(fm);
}

// Record a question the agent raised. Sets `question` (normalised to one line)
// and clears any prior `answer` so the ticket re-enters the waiting state, then
// bumps `updated`. An empty question is treated as clearing the whole Q/A pair.
// Returns a NEW frontmatter object (input not mutated).
function askQuestion(fm, question, opts) {
  const out = orderFm(fm);
  const q = toSingleLine(question);
  if (!q) {
    delete out.question;
    delete out.answer;
  } else {
    out.question = q;
    delete out.answer;
  }
  out.updated = resolveNow(opts);
  return out;
}

// Record the user's chosen answer. Keeps `question` intact (so a later reader
// sees both what was asked and what was decided), sets `answer` (normalised to
// one line), and bumps `updated`. An empty answer removes `answer`, leaving the
// ticket waiting again. Returns a NEW frontmatter object.
function answerQuestion(fm, answer, opts) {
  const out = orderFm(fm);
  const a = toSingleLine(answer);
  if (!a) delete out.answer;
  else out.answer = a;
  out.updated = resolveNow(opts);
  return out;
}

// Remove both the question and the answer (e.g. once the resolved Q/A has been
// folded into the ticket body, or to reset). Bumps `updated`. Returns a NEW fm.
function clearQuestion(fm, opts) {
  const out = orderFm(fm);
  delete out.question;
  delete out.answer;
  out.updated = resolveNow(opts);
  return out;
}

module.exports = {
  LEADING_KEYS,
  orderFm,
  toSingleLine,
  hasQuestion,
  hasAnswer,
  isWaitingForAnswer,
  askQuestion,
  answerQuestion,
  clearQuestion,
};
