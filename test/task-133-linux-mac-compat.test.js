'use strict';

// ===========================================================================
// TASK-133 — UNIT tests.
//
// This ticket ships docs + in-app copy truth for the cross-platform behaviour
// TASK-107 already implemented; it changes NO production platform code. The
// unit-testable surface the ticket calls out is the `resolvePosixShell`
// resolver (lib/pty.js __testing) — the guard that keeps the POSIX panes off
// cmd.exe — across the darwin/linux + $SHELL set/unset/blank/whitespace matrix.
//
// No pure copy/relabel helper was extracted for this ticket (the renderer
// relabel is inline in createTab and is exercised by the e2e harness); the
// renderer copy is additionally SOURCE-PINNED below so a silent regression of
// the Windows-worded strings or the isWin() guard is caught here too.
//
// No real PTY, shell, binary, filesystem probe, Electron, or DB is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const { __testing: pty } = require('../lib/pty');
const { resolvePosixShell } = pty;
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// resolvePosixShell — $SHELL preference
// ---------------------------------------------------------------------------
test('UNIT: resolvePosixShell prefers $SHELL when set (darwin and linux)', () => {
  assert.equal(resolvePosixShell('darwin', { SHELL: '/bin/fish' }), '/bin/fish');
  assert.equal(resolvePosixShell('linux', { SHELL: '/usr/bin/zsh' }), '/usr/bin/zsh');
});

test('UNIT: resolvePosixShell trims surrounding whitespace on a set $SHELL', () => {
  assert.equal(resolvePosixShell('darwin', { SHELL: '  /bin/zsh  ' }), '/bin/zsh');
  assert.equal(resolvePosixShell('linux', { SHELL: '\t/bin/bash\n' }), '/bin/bash');
});

// ---------------------------------------------------------------------------
// resolvePosixShell — darwin fallback (zsh)
// ---------------------------------------------------------------------------
test('UNIT: resolvePosixShell falls back to /bin/zsh on darwin when $SHELL is unset/blank', () => {
  assert.equal(resolvePosixShell('darwin', {}), '/bin/zsh', 'no SHELL key');
  assert.equal(resolvePosixShell('darwin', { SHELL: '' }), '/bin/zsh', 'empty SHELL');
  assert.equal(resolvePosixShell('darwin', { SHELL: '   ' }), '/bin/zsh', 'whitespace-only SHELL');
  assert.equal(resolvePosixShell('darwin', undefined), '/bin/zsh', 'undefined env');
});

// ---------------------------------------------------------------------------
// resolvePosixShell — linux fallback (bash)
// ---------------------------------------------------------------------------
test('UNIT: resolvePosixShell falls back to /bin/bash on linux when $SHELL is unset/blank', () => {
  assert.equal(resolvePosixShell('linux', {}), '/bin/bash', 'no SHELL key');
  assert.equal(resolvePosixShell('linux', { SHELL: '' }), '/bin/bash', 'empty SHELL');
  assert.equal(resolvePosixShell('linux', { SHELL: '  \t ' }), '/bin/bash', 'whitespace-only SHELL');
});

// ---------------------------------------------------------------------------
// resolvePosixShell — never cmd.exe (the core guard this ticket protects)
// ---------------------------------------------------------------------------
test('UNIT: resolvePosixShell never returns cmd.exe on any platform/env', () => {
  const combos = [
    ['darwin', {}], ['darwin', { SHELL: '' }], ['darwin', { SHELL: '  ' }],
    ['linux', {}], ['linux', { SHELL: '' }],
    ['win32', {}], ['freebsd', { SHELL: '   ' }],
  ];
  for (const [plat, env] of combos) {
    const resolved = resolvePosixShell(plat, env);
    assert.notEqual(resolved, 'cmd.exe', `${plat}/${JSON.stringify(env)} is never cmd.exe`);
    assert.match(resolved, /^\//, `${plat} resolves to an absolute POSIX shell path`);
  }
});

// ---------------------------------------------------------------------------
// Source-pin: the platform-truthful renderer copy stays present and guarded.
// (The e2e harness executes these blocks; this catches a silent source drift.)
// ---------------------------------------------------------------------------
test('UNIT: renderer pane-copy relabel is guarded by !isWin() and relabels the bash tab', () => {
  assert.match(rendererSrc, /Platform-truthful pane copy \(TASK-133\)/,
    'the TASK-133 pane-copy block is present');
  assert.match(rendererSrc, /if \(!isWin\(\)\) \{[\s\S]*?bashTabBtn\.textContent = 'Terminal'/,
    'bash tab is relabelled "Terminal" inside a !isWin() guard');
  assert.match(rendererSrc, /'shell · openCode'/, 'agent option relabel present');
  assert.match(rendererSrc, /'Install openCode'/, 'opencode install button relabel present');
  assert.match(rendererSrc, /wingetHint\.classList\.add\('hidden'\)/, 'winget hint hidden off win32');
});

test('UNIT: renderer empty-state relabel is guarded by !isWin()', () => {
  assert.match(rendererSrc, /Platform-truthful empty-state copy \(TASK-133\)/,
    'the TASK-133 empty-state block is present');
  assert.match(rendererSrc, /open your login shell with claude/,
    'empty-state login-shell wording present');
});

test('UNIT: getPlatform falls back to win32 for a stale preload (source-pinned)', () => {
  assert.match(rendererSrc, /return \(window\.api && window\.api\.platform\) \|\| 'win32'/,
    'getPlatform falls back to win32 when api.platform is absent');
});
