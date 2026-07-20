'use strict';

// Electron-free predicate for whether a ticket BODY is "defined" (TASK-079): it
// carries real business-analyst output rather than the New-ticket skeleton. A
// defined body has BOTH:
//   (a) a `## Acceptance Criteria` section with at least one checkbox item that is
//       NOT the literal placeholder `- [ ] First testable criterion`, AND
//   (b) a `## Cucumber Tests` section holding a non-empty ```gherkin fenced block.
//
// Like lib/ticket-queue.js and lib/ticket-lanes.js this module deliberately
// requires nothing from Electron so it can be unit-tested with plain `node
// --test`. `isTicketDefined` is pure and TOTALLY tolerant of junk: any
// null/undefined/non-string/malformed body returns false and never throws.

// The exact placeholder criterion the New-ticket modal, the bug-create path, and
// the Slack `create ticket` flow stamp into a skeleton's `## Acceptance Criteria`.
// A checkbox equal to this (after trimming) does NOT count as a real, BA-authored
// criterion — a body whose only checkbox is this placeholder is undefined.
const PLACEHOLDER_CRITERION = '- [ ] First testable criterion';

// A level-2 markdown heading line: `## <name>` (leading spaces tolerated). Returns
// the heading text, or null when the line is not a level-2 heading.
function headingName(line) {
  const m = /^\s*##\s+(.*?)\s*$/.exec(line);
  return m ? m[1] : null;
}

// A GFM task-list checkbox line: `- [ ] text` / `- [x] text` (any indent).
const CHECKBOX_RE = /^\s*-\s*\[[ xX]\]/;

// A fenced-code opener/closer: ``` or ~~~ (3+) with an optional info string.
// Returns { marker, lang } (marker is the fence char, lang lowercased) or null.
function fenceInfo(line) {
  const m = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
  if (!m) return null;
  return { marker: m[1][0], lang: (m[2] || '').toLowerCase() };
}

// Return the lines belonging to the `## <name>` section — everything after that
// heading up to (but excluding) the next level-2 heading. Fence-aware so a `## `
// that appears INSIDE a fenced code block does not prematurely end the section.
// Returns null when the heading is absent, else an array (possibly empty).
function sectionLines(body, name) {
  const lines = String(body).split(/\r?\n/);
  let inSection = false;
  let found = false;
  let inFence = false;
  let fenceMarker = '';
  const out = [];
  for (const line of lines) {
    const fi = fenceInfo(line);
    if (fi) {
      if (!inFence) { inFence = true; fenceMarker = fi.marker; }
      else if (fi.marker === fenceMarker) { inFence = false; }
      if (inSection) out.push(line);
      continue;
    }
    if (!inFence) {
      const h = headingName(line);
      if (h != null) {
        if (inSection) break;                 // next heading ends our section
        if (h === name) { inSection = true; found = true; continue; }
        continue;
      }
    }
    if (inSection) out.push(line);
  }
  return found ? out : null;
}

// True when the `## Acceptance Criteria` section exists AND holds at least one
// checkbox whose full trimmed text is NOT the placeholder criterion.
function hasRealAcceptanceCriteria(body) {
  const lines = sectionLines(body, 'Acceptance Criteria');
  if (!lines) return false;
  for (const line of lines) {
    if (!CHECKBOX_RE.test(line)) continue;
    if (line.trim() === PLACEHOLDER_CRITERION) continue;
    return true;
  }
  return false;
}

// True when the `## Cucumber Tests` section exists AND contains at least one
// ```gherkin fenced block whose content (between the fences) is non-empty.
function hasNonEmptyGherkinFence(body) {
  const lines = sectionLines(body, 'Cucumber Tests');
  if (!lines) return false;
  let inGherkin = false;
  let fenceMarker = '';
  let content = '';
  for (const line of lines) {
    const fi = fenceInfo(line);
    if (fi && !inGherkin) {
      if (fi.lang === 'gherkin') { inGherkin = true; fenceMarker = fi.marker; content = ''; }
      continue;
    }
    if (fi && inGherkin && fi.marker === fenceMarker) {
      if (content.trim() !== '') return true;
      inGherkin = false;
      continue;
    }
    if (inGherkin) content += line + '\n';
  }
  return false;
}

// True iff `body` is a fully defined ticket body (real AC AND a non-empty gherkin
// block). Never throws for any input — a non-string / blank / malformed body
// returns false.
function isTicketDefined(body) {
  if (typeof body !== 'string' || body.trim() === '') return false;
  try {
    return hasRealAcceptanceCriteria(body) && hasNonEmptyGherkinFence(body);
  } catch (_) {
    return false;
  }
}

module.exports = {
  PLACEHOLDER_CRITERION,
  isTicketDefined,
};
