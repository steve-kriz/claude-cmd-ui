'use strict';

// Canonical, Electron-free per-line markdown heading-escape transform (extracted
// in TASK-027 from lib/ticket-bug-reports.js's `neutralizeBugText`). Pure and
// dependency-free so it can be unit-tested with plain `node --test`, mirroring
// the style of lib/ticket-progress.js and lib/ticket-folders.js.
//
// Why this exists: helpers that fold agent/user-supplied text into a ticket's
// markdown body (bug reports, work-log history) split the body into level-2
// sections using `/^## /`. A supplied line like `## Additional Context` would
// otherwise forge a phantom section boundary on every re-parse and corrupt the
// ticket. Escaping the LEADING run of `#`s on each line with a backslash means
// the line no longer starts with `## `, yet it still renders as the literal
// `## …` text — so nothing is silently dropped.
//
// This module is a LEAF: it requires nothing (no ticket modules, no Electron),
// so there is exactly one implementation of the transform and no circular
// requires. renderer/renderer.js keeps a hand-maintained browser-side mirror of
// this function (it cannot `require` Node modules); that mirror MUST stay
// byte-for-byte in step with the body below.

// Escape the leading run of `#`s (`#`, `##`, `###`, …) on each line of `text`
// with a single backslash, preserving leading whitespace and the following
// whitespace char. `null`/`undefined` collapse to '' and non-strings are
// stringified. Lines without a leading `#`-run are returned unchanged.
function escapeLeadingHeadingRun(text) {
  const s = text == null ? '' : String(text);
  return s
    .split('\n')
    .map((line) => line.replace(/^(\s*)(#+)(\s)/, '$1\\$2$3'))
    .join('\n');
}

module.exports = {
  escapeLeadingHeadingRun,
};
