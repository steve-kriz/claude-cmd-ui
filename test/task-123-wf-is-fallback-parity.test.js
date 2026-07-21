'use strict';

// ===========================================================================
// TASK-123 (F4) — UNIT tests locking the corrected renderer mirror
// `wfIsFallback` (renderer/renderer.js) to be BYTE-FAITHFUL to the lib source of
// truth `isFallback` (lib/orchestrate-agents.js).
//
// The pre-fix mirror returned `false` for an empty/null/non-string name; the lib
// resolves such a name to the general-purpose fallback, so it IS a fallback
// (true). This suite extracts the REAL shipped `wfIsFallback` headless (the
// task-094/task-105 brace-matching convention) and asserts, for a parity matrix
// covering empty / null / non-string / present / absent / general-purpose /
// non-array-available, that the renderer mirror agrees EXACTLY with lib
// isFallback — so any future divergence of the mirror is drift-caught here.
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK. The only read is the
// bundled renderer.js source (read-only) used to extract the real function.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isFallback, FALLBACK_AGENT } = require('../lib/orchestrate-agents');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

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
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

function loadWfIsFallback() {
  const body = [
    extractConst(rendererSrc, 'WF_FALLBACK_AGENT'),
    extractFn(rendererSrc, 'wfIsFallback'),
    'return wfIsFallback;',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)({}, {}, console);
}
const wfIsFallback = loadWfIsFallback();

assert.equal(FALLBACK_AGENT, 'general-purpose', 'sanity: lib fallback agent name');

// Each row: [name, available, expected]. `available` is always an ARRAY or a
// non-array (null/undefined/{}/string) value — exactly the inputs the renderer
// mirror ever sees (the lib also supports Set, which the renderer never receives).
const PRESENT = ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tester', 'orchestrate-tech-lead'];
const MATRIX = [
  // present -> not a fallback
  ['orchestrate-ba', PRESENT, false],
  ['orchestrate-tech-lead', PRESENT, false],
  // absent -> falls back
  ['orchestrate-tester', ['orchestrate-ba', 'orchestrate-coder'], true],
  ['orchestrate-ba', [], true],
  // empty / null / non-string name -> resolves to the fallback -> IS a fallback
  ['', PRESENT, true],
  [null, PRESENT, true],
  [undefined, PRESENT, true],
  [12345, PRESENT, true],
  [{}, PRESENT, true],
  // the general-purpose fallback itself is NEVER flagged (present or absent)
  ['general-purpose', ['general-purpose'], false],
  ['general-purpose', PRESENT, false],
  ['general-purpose', [], false],
  // non-array `available` + a real name -> treated as none-available -> falls back
  ['orchestrate-ba', null, true],
  ['orchestrate-ba', undefined, true],
  ['orchestrate-ba', 'orchestrate-ba', true],
  ['orchestrate-ba', {}, true],
];

test('unit: wfIsFallback matches its expected value across the full parity matrix', () => {
  for (const [name, available, expected] of MATRIX) {
    assert.equal(
      wfIsFallback(name, available), expected,
      `wfIsFallback(${JSON.stringify(name)}, ${JSON.stringify(available)}) === ${expected}`);
  }
});

test('unit: wfIsFallback agrees EXACTLY with lib isFallback for every matrix row (mirror parity)', () => {
  for (const [name, available] of MATRIX) {
    assert.equal(
      wfIsFallback(name, available), isFallback(name, available),
      `mirror parity for (${JSON.stringify(name)}, ${JSON.stringify(available)})`);
  }
});
