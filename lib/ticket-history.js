'use strict';

// Electron-free helper for appending a work-log entry to a ticket's markdown
// body. This backs TASK-002's "keep a durable history inside the ticket file"
// requirement: the orchestrator (never a subagent) calls appendHistoryEntry to
// fold each coder/tester prompt+response into a `## History` section, then
// writes the whole file back in one shot per the live-board rules.
//
// Like lib/env-store.js and lib/slack-oauth.js this file deliberately requires
// nothing from Electron so it can be unit-tested with plain `node --test`.
//
// Contract:
//   - The new entry is appended in chronological order under `## History`.
//   - Every OTHER section is preserved verbatim (byte-for-byte).
//   - The user-owned `## Additional Context` section is never edited or moved
//     out of place: when `## History` has to be created it is inserted BEFORE
//     `## Additional Context` so that user section stays at the tail.
//   - Only level-2 (`## `) lines delimit sections, so the `### <ts> — <role>`
//     entry headings we emit never get mistaken for section boundaries.

// Reuse the exact per-line heading-escape transform (TASK-027 extracted it into
// the neutrally-named leaf module lib/markdown-escape.js) so history bodies are
// neutralized IDENTICALLY to bug text — one shared impl, no second divergent
// copy, and no coupling to the bug-report module. The leaf is pure/Electron-free,
// so this require stays unit-testable.
const { escapeLeadingHeadingRun } = require('./markdown-escape');

const HISTORY_HEADING = '## History';
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

// Render a single history entry: a `### <timestamp> — <role>` heading followed
// by the prompt and response blocks. Returns an array of lines.
function formatHistoryEntry({ role, prompt, response, timestamp } = {}) {
  const ts = timestamp || new Date().toISOString();
  const label = (role == null || role === '') ? 'agent' : String(role);
  // Neutralize the agent-supplied bodies (only) so no line can begin with `## `
  // and forge a phantom level-2 section that `splitSections` (`/^## /`) would
  // later treat as a boundary. The `### … — role` heading and the
  // `**Prompt:**`/`**Response:**` labels we emit below are NOT neutralized.
  const promptText = escapeLeadingHeadingRun(prompt == null ? '' : String(prompt));
  const responseText = escapeLeadingHeadingRun(response == null ? '' : String(response));
  return [
    `### ${ts} — ${label}`,
    '',
    '**Prompt:**',
    '',
    promptText,
    '',
    '**Response:**',
    '',
    responseText,
  ];
}

// Append a timestamped, role-labelled entry to the `## History` section of a
// ticket markdown body and return the new body. Pure: does not touch disk.
//
//   appendHistoryEntry(markdown, { role, prompt, response, timestamp })
//
// - `role`      phase/role label, e.g. 'coder' or 'tester' (defaults 'agent').
// - `prompt`    the prompt text sent to the subagent.
// - `response`  the result the subagent returned in-band.
// - `timestamp` ISO string; defaults to now if omitted.
function appendHistoryEntry(markdown, entry) {
  const body = typeof markdown === 'string' ? markdown : '';
  const { preamble, sections } = splitSections(body);
  const entryLines = formatHistoryEntry(entry || {});

  const historyIdx = sections.findIndex((s) => isSection(s.heading, HISTORY_HEADING));
  if (historyIdx !== -1) {
    // Append after the existing entries, chronological order preserved.
    const sec = sections[historyIdx];
    const kept = trimTrailingBlank(sec.lines);
    sec.lines = kept.length ? [...kept, '', ...entryLines] : ['', ...entryLines];
  } else {
    // Create the section. Keep it BEFORE `## Additional Context` so the
    // user-owned section stays at the tail; otherwise append at the end.
    const newSection = { heading: HISTORY_HEADING, lines: ['', ...entryLines] };
    const acIdx = sections.findIndex((s) => isSection(s.heading, ADDITIONAL_CONTEXT_HEADING));
    if (acIdx !== -1) sections.splice(acIdx, 0, newSection);
    else sections.push(newSection);
  }

  return joinSections(preamble, sections);
}

module.exports = {
  appendHistoryEntry,
  formatHistoryEntry,
  HISTORY_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
};
