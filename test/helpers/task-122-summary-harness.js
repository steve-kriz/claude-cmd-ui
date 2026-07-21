'use strict';

// ===========================================================================
// TASK-122 test harness — loads the REAL renderer/renderer.js summary logic
// (formatTasksSummary + its lane-order mirror helpers tasksUserSlugSetFor,
// tasksLaneStatusesFor, tasksLaneForStatusFor) headless so tests can compare the
// ACTUAL shipped renderer formatter against lib/slack-commands.js for the SAME
// (tickets, columns) — the lib-vs-renderer PARITY contract TASK-122 restores.
//
// renderer.js is a browser script (no module.exports, references `document`), so
// — matching test/helpers/task-101-lane-harness.js — the needed declarations are
// extracted from source by brace-matching / regex and evaluated inside a
// `new Function` scope. NOTHING real is invoked: these functions are pure (no DOM,
// no IPC, no FS, no DB, no network), so no stubs are required.
//
// This file is intentionally NOT named *.test.js so `node --test test/**/*.test.js`
// does not execute it as a test file — it is a shared require()-able harness.
// ===========================================================================

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const RENDERER = path.join(__dirname, '..', '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');

// Extract a named function declaration by brace-matching (the function bodies we
// need contain no braces inside strings/comments; template `${…}` braces are
// balanced, so plain brace counting is exact here).
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// Extract a `const NAME = …;` declaration up to its terminating semicolon. None of
// the constants we extract contain a `;` inside their value.
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

// Build the headless renderer summary module. Returns the extracted
// formatTasksSummary + the three mirror helpers, evaluated in isolation.
function loadRendererSummary() {
  const body = [
    // --- lane constants (mirrors of lib/ticket-lanes.js) ---
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_ACTIVE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_FAILED_STATUS'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    // --- TASK-122 mirror helpers + the formatter under test ---
    extractFn(rendererSrc, 'tasksUserSlugSetFor'),
    extractFn(rendererSrc, 'tasksLaneStatusesFor'),
    extractFn(rendererSrc, 'tasksLaneForStatusFor'),
    extractFn(rendererSrc, 'formatTasksSummary'),
    // --- exports ---
    'return { formatTasksSummary, tasksUserSlugSetFor,',
    '  tasksLaneStatusesFor, tasksLaneForStatusFor,',
    '  TASKS_LANE_STATUSES, TASKS_UNKNOWN_STATUS };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

module.exports = { loadRendererSummary, extractFn, extractConst, rendererSrc };
