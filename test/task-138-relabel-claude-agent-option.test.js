'use strict';

// ===========================================================================
// TASK-138 — UNIT tests (source-pin).
//
// This ticket adds a single null-guarded relabel of the `claude` agent
// <option> inside the existing TASK-133 `if (!isWin())` pane-copy block in
// renderer/renderer.js (the block anchored by the `Platform-truthful pane copy
// (TASK-133)` comment) — mirroring the sibling opencode relabel. On win32 the
// static markup (index.html) is left byte-identical.
//
// The behaviour is exercised headless by the e2e harness
// (test/task-133-linux-mac-compat.e2e.test.js). These unit tests SOURCE-PIN the
// relabel so a silent drift (wrong block, changed value/selector, or an edited
// index.html) is caught here too. No real DOM, PTY, shell, filesystem probe,
// Electron, network, or DB is touched — pure source-string assertions.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');

// Brace-matching extractor: pull the whole `if (!isWin()) { ... }` statement
// that follows the pane-copy anchor, so we can assert the claude relabel lives
// INSIDE that block (not the separate empty-state block).
function extractBraceBlock(src, anchor, from = 0) {
  const start = src.indexOf(anchor, from);
  assert.notEqual(start, -1, `anchor found: ${anchor}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

const paneCopyIdx = rendererSrc.indexOf('Platform-truthful pane copy (TASK-133)');
const paneRelabelBlock = extractBraceBlock(rendererSrc, 'if (!isWin()) {', paneCopyIdx);

const emptyCopyIdx = rendererSrc.indexOf('Platform-truthful empty-state copy (TASK-133)');
const emptyRelabelBlock = extractBraceBlock(rendererSrc, 'if (!isWin()) {', emptyCopyIdx);

// ---------------------------------------------------------------------------
// The claude relabel is present, null-guarded, and inside the pane-copy block.
// ---------------------------------------------------------------------------
test('UNIT: claude relabel queries option[value="claude"] and sets "shell · claude"', () => {
  assert.match(rendererSrc, /querySelector\('option\[value="claude"\]'\)/,
    'renderer queries the claude option by value');
  assert.match(rendererSrc, /'shell · claude'/,
    'renderer sets the claude option text to "shell · claude"');
});

test('UNIT: claude relabel lives INSIDE the TASK-133 pane-copy !isWin() block', () => {
  assert.match(paneRelabelBlock, /querySelector\('option\[value="claude"\]'\)/,
    'the claude query is inside the pane-copy block');
  assert.match(paneRelabelBlock, /'shell · claude'/,
    'the claude relabel text is inside the pane-copy block');
  // It must NOT have been placed in the separate empty-state block.
  assert.ok(!/option\[value="claude"\]/.test(emptyRelabelBlock),
    'claude relabel is NOT in the empty-state block');
});

test('UNIT: claude relabel is null-guarded on agentSelect and the queried option', () => {
  // Guard on tab.els.agentSelect (mirrors the opencode pattern) ...
  assert.match(paneRelabelBlock,
    /const claudeOption = tab\.els\.agentSelect &&\s*tab\.els\.agentSelect\.querySelector\('option\[value="claude"\]'\)/,
    'claudeOption guarded on tab.els.agentSelect');
  // ... and a guard on the queried option before assigning textContent.
  assert.match(paneRelabelBlock,
    /if \(claudeOption\) claudeOption\.textContent = 'shell · claude'/,
    'assignment is guarded by if (claudeOption)');
});

test('UNIT: claude relabel only changes textContent (no value / class / selector rewrite)', () => {
  // No reassignment of the option value and no classList mutation for claude.
  assert.ok(!/claudeOption\.value\s*=/.test(paneRelabelBlock),
    'claude option value is never reassigned');
  assert.ok(!/claudeOption\.classList/.test(paneRelabelBlock),
    'claude option DOM class is never mutated');
  // The selector targets claude specifically and does not rewrite opencode by mistake.
  assert.match(paneRelabelBlock, /opencodeOption\.textContent = 'shell · openCode'/,
    'opencode relabel still targets its own option');
});

// ---------------------------------------------------------------------------
// index.html (win32 markup) stays untouched — byte-identical `cmd · claude`.
// ---------------------------------------------------------------------------
test('UNIT: index.html still has <option value="claude">cmd · claude</option> (win32 unchanged)', () => {
  assert.match(indexHtml, /<option value="claude">cmd · claude<\/option>/,
    'index.html claude option is byte-identical (cmd · claude)');
  // Sibling opencode option markup is also the original Windows copy.
  assert.match(indexHtml, /<option value="opencode">git bash · openCode<\/option>/,
    'index.html opencode option unchanged (git bash · openCode)');
});
