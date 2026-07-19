'use strict';

// Cucumber-style e2e scenarios for TASK-027 — "Extract shared markdown
// heading-escape helper".
//
// FEATURE: The per-line heading-escape transform (that stops agent/user-supplied
// text from forging a `## ` section boundary when a ticket body is re-parsed on
// `/^## /`) was extracted into the neutrally-named leaf module
// lib/markdown-escape.js (`escapeLeadingHeadingRun`). Both the bug-report path
// (lib/ticket-bug-reports.js appendBugReport) and the work-log history path
// (lib/ticket-history.js appendHistoryEntry) now use that SINGLE shared impl, and
// lib/ticket-bug-reports.js keeps `neutralizeBugText` as a thin re-export so
// earlier TASK-022/025 imports keep working. This is a pure refactor: no
// behavior change.
//
// These scenarios are written in Given/When/Then form as `node --test` cases (NO
// `cucumber` npm package is installed or added). Both helpers under test are
// Electron-free pure markdown transforms that touch no disk/network/DB, so by
// construction NO DATABASE CONNECTION is ever opened here.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { appendBugReport, BUG_REPORTS_HEADING } = require('../lib/ticket-bug-reports');
const { neutralizeBugText } = require('../lib/ticket-bug-reports');
const { appendHistoryEntry, HISTORY_HEADING } = require('../lib/ticket-history');

// Slice out the lines of the named `## ` section (heading through the line
// before the next `## ` heading), rejoined. Uses the SAME boundary detector the
// helpers use (`/^## /`) so a forged section would be visible as a real one.
function sectionSlice(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// The ordered list of REAL level-2 section headings (re-split on `/^## /`).
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// ===========================================================================
// SCENARIO 1: bug-report and history text are escaped IDENTICALLY (single impl)
// ===========================================================================
test('SCENARIO: a `## Summary` line is escaped identically on the bug-report and history paths', () => {
  // GIVEN a body line that would otherwise forge a `## Summary` section
  const SUPPLIED = 'Intro line\n## Summary\ntail line';

  // WHEN it is folded in via appendBugReport's path...
  const bugOut = appendBugReport('', {
    bug: SUPPLIED,
    timestamp: '2026-07-18T10:00:00.000Z',
  });
  // ...AND via appendHistoryEntry's path (as the response body)
  const histOut = appendHistoryEntry('', {
    role: 'tester',
    prompt: 'unused',
    response: SUPPLIED,
    timestamp: '2026-07-18T10:00:00.000Z',
  });

  // THEN in BOTH outputs the line appears escaped as `\## Summary`
  assert.match(sectionSlice(bugOut, BUG_REPORTS_HEADING), /\\## Summary/, 'bug path escapes the line');
  assert.match(sectionSlice(histOut, HISTORY_HEADING), /\\## Summary/, 'history path escapes the line');

  // AND neither output forges a real `## Summary` section boundary
  assert.equal((bugOut.match(/^## Summary$/gm) || []).length, 0, 'bug path forged no ## Summary section');
  assert.equal((histOut.match(/^## Summary$/gm) || []).length, 0, 'history path forged no ## Summary section');
  assert.ok(!realSections(bugOut).includes('## Summary'), 'no forged section in bug output');
  assert.ok(!realSections(histOut).includes('## Summary'), 'no forged section in history output');

  // AND the escaping is character-identical across the two paths — the SAME
  // shared impl (lib/markdown-escape.js) is used on both real code paths.
  const bugEscapedLine = bugOut.split('\n').find((l) => /## Summary/.test(l));
  const histEscapedLine = histOut.split('\n').find((l) => /## Summary/.test(l));
  assert.equal(bugEscapedLine, '\\## Summary');
  assert.equal(histEscapedLine, '\\## Summary');
  assert.equal(bugEscapedLine, histEscapedLine, 'both paths produce the identical escaped line');
});

// ===========================================================================
// SCENARIO 2 (regression): the neutralizeBugText re-export still works
// ===========================================================================
test('SCENARIO (regression): neutralizeBugText re-export from lib/ticket-bug-reports.js still escapes `## Foo`', () => {
  // GIVEN code importing `neutralizeBugText` from lib/ticket-bug-reports.js
  assert.equal(typeof neutralizeBugText, 'function', 'the re-export is importable and callable');

  // WHEN it is called with `## Foo`
  const out = neutralizeBugText('## Foo');

  // THEN it returns `\## Foo`
  assert.equal(out, '\\## Foo');
});

// ===========================================================================
// SCENARIO 3 (regression): well-formed text is unchanged (behavior-preserving)
// ===========================================================================
test('SCENARIO (regression): ordinary prose passes through byte-for-byte on both paths', () => {
  // GIVEN ordinary prose with no leading heading run
  const PROSE = 'The Save button throws on an empty form.\nSteps: open form, click Save.';

  // WHEN it is escaped via the shared re-export and folded through both helpers
  assert.equal(neutralizeBugText(PROSE), PROSE, 'prose is byte-for-byte identical after escape');

  const bugOut = appendBugReport('', { bug: PROSE, timestamp: '2026-07-18T10:00:00.000Z' });
  const histOut = appendHistoryEntry('', {
    role: 'coder', prompt: 'p', response: PROSE, timestamp: '2026-07-18T10:00:00.000Z',
  });

  // THEN the prose lines survive verbatim inside each section (no backslash added)
  const bugSec = sectionSlice(bugOut, BUG_REPORTS_HEADING);
  const histSec = sectionSlice(histOut, HISTORY_HEADING);
  assert.match(bugSec, /The Save button throws on an empty form\./);
  assert.match(bugSec, /Steps: open form, click Save\./);
  assert.match(histSec, /The Save button throws on an empty form\./);
  assert.match(histSec, /Steps: open form, click Save\./);
  assert.ok(!/\\/.test(bugSec), 'no backslash introduced in the bug entry for ordinary prose');
});
