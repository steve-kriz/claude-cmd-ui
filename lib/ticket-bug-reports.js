'use strict';

// Electron-free helper for appending a bug report to a ticket's markdown body.
// This backs TASK-020's "capture the bug so I don't lose the context" flow: when
// a `done` ticket is dragged back to `todo` the user is asked to describe the bug
// they found, and that text is folded into a `## Bug Reports` section before the
// ticket is moved back for a re-build.
//
// Like lib/ticket-history.js this file deliberately requires nothing from
// Electron so it can be unit-tested with plain `node --test`.
//
// Contract:
//   - The new entry is appended in chronological order under `## Bug Reports`.
//   - Every OTHER section is preserved verbatim (byte-for-byte).
//   - The user-owned `## Additional Context` section is never edited or moved
//     out of place: when `## Bug Reports` has to be created it is inserted BEFORE
//     `## Additional Context` so that user section stays at the tail (mirrors how
//     lib/ticket-history.js places `## History`).
//   - Only level-2 (`## `) lines delimit sections, so the `### <ts>` entry
//     headings we emit never get mistaken for section boundaries.

// The per-line heading-escape transform lives in the neutrally-named leaf module
// lib/markdown-escape.js (TASK-027). It is re-exported below as `neutralizeBugText`
// so existing TASK-022/025 imports keep working, and lib/ticket-history.js reuses
// the SAME implementation (no divergent second copy). The leaf requires nothing
// from this file, so there is no circular require.
const { escapeLeadingHeadingRun } = require('./markdown-escape');

const BUG_REPORTS_HEADING = '## Bug Reports';
const ADDITIONAL_CONTEXT_HEADING = '## Additional Context';

// True when a heading line is the given `## Foo` section (trimmed, case-insensitive).
function isSection(headingLine, section) {
  return headingLine.trim().toLowerCase() === section.toLowerCase();
}

// Split a markdown body into a leading preamble (anything before the first
// `## ` heading) plus an ordered list of level-2 sections. Rejoining
// { preamble, sections } reproduces the input exactly, so untouched sections
// round-trip verbatim.
function splitSections(body) {
  const lines = body.split('\n');
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    // Level-2 heading only: `## ` matches, `### ` does not (char after ## is #).
    if (/^## /.test(line)) {
      if (current) sections.push(current);
      current = { heading: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

function joinSections(preamble, sections) {
  const out = preamble.slice();
  for (const sec of sections) {
    out.push(sec.heading);
    for (const l of sec.lines) out.push(l);
  }
  return out.join('\n');
}

// Drop trailing empty lines from a section body so a fresh entry attaches with
// exactly one blank-line separator rather than an accreting gap.
function trimTrailingBlank(lines) {
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

// Neutralize heading-forging in user bug text (TASK-022). `splitSections` treats
// any line matching `/^## /` as a level-2 section boundary, so a bug body line
// like `## Additional Context` would forge a section on every re-parse and
// corrupt the ticket. This is a thin re-export of the shared leaf transform
// (lib/markdown-escape.js `escapeLeadingHeadingRun`, TASK-027) — kept under this
// name because existing TASK-022/025 tests import `neutralizeBugText` from here.
const neutralizeBugText = escapeLeadingHeadingRun;

// Render a single bug-report entry: a `### <timestamp>` heading followed by the
// bug text. Returns an array of lines. The bug text is neutralized so it cannot
// forge a `## ` section boundary; the `### <ts>` heading we emit is left as-is.
function formatBugReportEntry({ bug, timestamp } = {}) {
  const ts = timestamp || new Date().toISOString();
  const bugText = neutralizeBugText(bug == null ? '' : String(bug).trim());
  return [
    `### ${ts}`,
    '',
    bugText,
  ];
}

// Append a timestamped bug report to the `## Bug Reports` section of a ticket
// markdown body and return the new body. Pure: does not touch disk.
//
//   appendBugReport(markdown, { bug, timestamp })
//
// - `bug`       the bug description text the user typed.
// - `timestamp` ISO string; defaults to now if omitted.
function appendBugReport(markdown, entry) {
  // Defense-in-depth guard (TASK-023): empty/whitespace-only bug text is a no-op.
  // Normalize the bug value the SAME way formatBugReportEntry does (String().trim())
  // so null/undefined/''/whitespace-only all collapse to '' and are rejected here,
  // BEFORE any section is created or extended. Return the ORIGINAL markdown so a
  // string input round-trips byte-for-byte (no re-serialization that could alter
  // whitespace); a non-string collapses to '' so the no-op path's return type
  // matches the non-empty path's `typeof markdown === 'string' ? markdown : ''`
  // normalization (TASK-026 return-type consistency).
  const bug = entry ? entry.bug : undefined;
  if (String(bug == null ? '' : bug).trim() === '') {
    return typeof markdown === 'string' ? markdown : '';
  }

  const body = typeof markdown === 'string' ? markdown : '';
  const { preamble, sections } = splitSections(body);
  const entryLines = formatBugReportEntry(entry || {});

  const idx = sections.findIndex((s) => isSection(s.heading, BUG_REPORTS_HEADING));
  if (idx !== -1) {
    // Append after the existing entries, chronological order preserved.
    const sec = sections[idx];
    const kept = trimTrailingBlank(sec.lines);
    sec.lines = kept.length ? [...kept, '', ...entryLines] : ['', ...entryLines];
  } else {
    // Create the section. Keep it BEFORE `## Additional Context` so the
    // user-owned section stays at the tail; otherwise append at the end.
    const newSection = { heading: BUG_REPORTS_HEADING, lines: ['', ...entryLines] };
    const acIdx = sections.findIndex((s) => isSection(s.heading, ADDITIONAL_CONTEXT_HEADING));
    if (acIdx !== -1) sections.splice(acIdx, 0, newSection);
    else sections.push(newSection);
  }

  return joinSections(preamble, sections);
}

module.exports = {
  appendBugReport,
  formatBugReportEntry,
  neutralizeBugText,
  BUG_REPORTS_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
};
