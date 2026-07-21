'use strict';

// ===========================================================================
// TASK-125 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required.
//
// Review follow-up of TASK-107. These scenarios EXECUTE the real install-helper
// click handlers per mocked platform (previously they were only source-text
// regex-checked) and assert the command / hidden-button behaviour by INVOKING
// the handler, not by matching source:
//   F2.1 Claude install button — win32 runs the PowerShell installer; off win32
//        the button is relabelled "Install via script" and runs the curl script.
//   F2.2 Git download button — opens git-scm.com/download/{mac|win|linux}.
//   F2.3 Winget button — wired to startGitInstall on win32; hidden off win32.
//
// It also re-covers F1 (augmentDarwinPath prepend + idempotence + no-op) in
// Given/When/Then form so the e2e suite exercises every acceptance criterion.
//
// The REAL wiring blocks are EXTRACTED from renderer/renderer.js by brace-
// matching (they live inline inside createTab, not a standalone function) and
// evaluated headless via `new Function` against an injected mock DOM/window +
// injected platform helpers. The REAL augmentDarwinPath is extracted from
// main.js the same way. NO real Electron, DOM, filesystem, network, or database
// is touched — all DB/IO surfaces are mocked.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');

// --- Extract a whole `if (...) { ... }` (following `else { ... }`) by brace-
// matching from an anchor, so the REAL wiring is evaluated headless. ---
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
function extractIfElse(src, anchor, from = 0) {
  const start = src.indexOf(anchor, from);
  assert.notEqual(start, -1, `anchor found: ${anchor}`);
  // match the `if` body
  let i = src.indexOf('{', start);
  let depth = 0;
  let j;
  for (j = i; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
  }
  // is an `else` block attached?
  let k = j;
  while (/\s/.test(src[k])) k += 1;
  if (src.slice(k, k + 4) === 'else') {
    let m = src.indexOf('{', k);
    let d2 = 0;
    let n;
    for (n = m; n < src.length; n++) {
      if (src[n] === '{') d2 += 1;
      else if (src[n] === '}') { d2 -= 1; if (d2 === 0) { n += 1; break; } }
    }
    return src.slice(start, n);
  }
  return src.slice(start, j);
}
// Named-function extractor (for augmentDarwinPath in main.js).
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// The REAL wiring blocks (winget + git-download + claude-install if/else).
const wingetBlock = extractBraceBlock(rendererSrc, 'if (tab.els.gitInstallWingetBtn) {');
const downloadBlock = extractBraceBlock(rendererSrc, 'if (tab.els.gitInstallDownloadBtn) {');
// Anchor from the npm-button wiring (which precedes the isWin() branch inside
// createTab) so we grab the CLAUDE install if/else, not an earlier isWin() use.
const claudeWireIdx = rendererSrc.indexOf('claudeInstallNpmBtn.addEventListener');
const claudeIfElse = extractIfElse(rendererSrc, 'if (isWin()) {', claudeWireIdx);

// Bundle the three REAL blocks into one injectable wiring routine. Its free
// identifiers (tab, isWin, getPlatform, runInCmdPty, startGitInstall, window)
// are supplied as parameters — exactly the names the source references.
const wireInstallHelpers = new Function(
  'tab', 'isWin', 'getPlatform', 'runInCmdPty', 'startGitInstall', 'window',
  [wingetBlock, downloadBlock, claudeIfElse].join('\n')
);

// The REAL darwin PATH fix from main.js (Electron entry code never runs).
const augmentDarwinPath = new Function(
  extractFn(mainSrc, 'augmentDarwinPath') + '\nreturn augmentDarwinPath;'
)();

// ---------------------------------------------------------------------------
// Minimal mock button + harness. NO real DOM.
// ---------------------------------------------------------------------------
function makeBtn() {
  const listeners = {};
  const classes = new Set();
  return {
    textContent: '',
    _listeners: listeners,
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      contains(c) { return classes.has(c); },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
}
function click(el) {
  const fns = (el && el._listeners && el._listeners.click) || [];
  for (const fn of fns) fn({ preventDefault() {}, stopPropagation() {} });
  return fns.length;
}

// Build a mocked tab + injected platform deps, wire the REAL handlers, and
// return recorders so a scenario can assert what the handlers actually do.
function setupHarness(platform) {
  const tab = {
    els: {
      gitInstallWingetBtn: makeBtn(),
      gitInstallDownloadBtn: makeBtn(),
      claudeInstallPwshBtn: makeBtn(),
    },
  };
  const cmdCalls = [];      // runInCmdPty(tab, cmd)
  const gitInstallCalls = []; // startGitInstall(tab)
  const openExternalCalls = []; // window.api.openExternal(url)

  const isWin = () => platform === 'win32';
  const getPlatform = () => platform;
  const runInCmdPty = (t, cmd) => { cmdCalls.push({ t, cmd }); };
  const startGitInstall = (t) => { gitInstallCalls.push(t); };
  const window = { api: { openExternal: (url) => { openExternalCalls.push(url); } } };

  wireInstallHelpers(tab, isWin, getPlatform, runInCmdPty, startGitInstall, window);
  return { tab, cmdCalls, gitInstallCalls, openExternalCalls };
}

// ===========================================================================
// Feature: platform-correct Claude install button (F2.1)
// ===========================================================================
test('Scenario: on win32 the Claude install button runs the PowerShell installer', () => {
  // Given the platform is win32 and the install helpers are wired
  const h = setupHarness('win32');
  // Then the button keeps its default label (not relabelled)
  assert.notEqual(h.tab.els.claudeInstallPwshBtn.textContent, 'Install via script');
  // When the Claude install (pwsh) button is clicked
  const n = click(h.tab.els.claudeInstallPwshBtn);
  assert.equal(n, 1, 'exactly one click handler wired');
  // Then it runs the PowerShell claude.ai installer
  assert.equal(h.cmdCalls.length, 1, 'runInCmdPty called once');
  assert.equal(h.cmdCalls[0].cmd,
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
  assert.equal(h.cmdCalls[0].t, h.tab, 'command runs against the same tab');
});

test('Scenario: off win32 the Claude install button is relabelled and runs the curl script', () => {
  for (const platform of ['darwin', 'linux']) {
    // Given a non-Windows platform and the install helpers are wired
    const h = setupHarness(platform);
    // Then the button is relabelled to the script variant
    assert.equal(h.tab.els.claudeInstallPwshBtn.textContent, 'Install via script',
      `relabelled on ${platform}`);
    // When the button is clicked
    click(h.tab.els.claudeInstallPwshBtn);
    // Then it runs the curl shell installer, NOT PowerShell
    assert.equal(h.cmdCalls.length, 1, `one command on ${platform}`);
    assert.equal(h.cmdCalls[0].cmd, 'curl -fsSL https://claude.ai/install.sh | bash',
      `curl installer on ${platform}`);
    assert.ok(!/powershell|install\.ps1/.test(h.cmdCalls[0].cmd),
      `no PowerShell installer offered on ${platform}`);
  }
});

// ===========================================================================
// Feature: platform-correct Git download button (F2.2)
// ===========================================================================
test('Scenario: the Git download button opens the platform-specific download page', () => {
  // Given each platform maps to its git-scm download page
  const cases = { darwin: 'mac', win32: 'win', linux: 'linux' };
  for (const [platform, page] of Object.entries(cases)) {
    const h = setupHarness(platform);
    // When the Git download button is clicked
    const n = click(h.tab.els.gitInstallDownloadBtn);
    assert.equal(n, 1, `download handler wired on ${platform}`);
    // Then openExternal is called with the correct download page URL
    assert.equal(h.openExternalCalls.length, 1, `one openExternal call on ${platform}`);
    assert.equal(h.openExternalCalls[0], 'https://git-scm.com/download/' + page,
      `git download page for ${platform}`);
  }
});

test('Scenario: the Git download button no-ops safely when openExternal is unavailable (edge)', () => {
  // Given the wiring but a window.api without openExternal
  const tab = { els: { gitInstallWingetBtn: makeBtn(), gitInstallDownloadBtn: makeBtn(), claudeInstallPwshBtn: makeBtn() } };
  const window = { api: {} };
  wireInstallHelpers(tab, () => false, () => 'linux', () => {}, () => {}, window);
  // When the download button is clicked it must not throw (guarded by the if)
  assert.doesNotThrow(() => click(tab.els.gitInstallDownloadBtn),
    'download click is a safe no-op without openExternal');
});

// ===========================================================================
// Feature: platform-correct Winget button (F2.3)
// ===========================================================================
test('Scenario: on win32 the Winget button is wired to start the git install', () => {
  // Given the platform is win32 and the helpers are wired
  const h = setupHarness('win32');
  // Then the winget button is NOT hidden
  assert.ok(!h.tab.els.gitInstallWingetBtn.classList.contains('hidden'),
    'winget button visible on win32');
  // When the Winget button is clicked
  const n = click(h.tab.els.gitInstallWingetBtn);
  assert.equal(n, 1, 'winget click handler wired on win32');
  // Then it starts the git install and fires no command directly
  assert.equal(h.gitInstallCalls.length, 1, 'startGitInstall invoked once');
  assert.equal(h.gitInstallCalls[0], h.tab, 'startGitInstall gets the tab');
  assert.equal(h.cmdCalls.length, 0, 'winget button does not fire a command directly');
});

test('Scenario: off win32 the Winget button is hidden and fires nothing (failure/edge path)', () => {
  for (const platform of ['darwin', 'linux']) {
    // Given a non-Windows platform and the helpers are wired
    const h = setupHarness(platform);
    // Then the winget button is hidden
    assert.ok(h.tab.els.gitInstallWingetBtn.classList.contains('hidden'),
      `winget button hidden on ${platform}`);
    // When it is clicked, no handler is wired so nothing happens
    const n = click(h.tab.els.gitInstallWingetBtn);
    assert.equal(n, 0, `no winget click handler wired on ${platform}`);
    assert.equal(h.gitInstallCalls.length, 0, `startGitInstall never runs on ${platform}`);
    assert.equal(h.cmdCalls.length, 0, `no command fires on ${platform}`);
  }
});

// ===========================================================================
// Feature: darwin PATH augmentation prepends Homebrew-first dirs (F1) — e2e
// ===========================================================================
test('Scenario: GUI-launched macOS app gets Homebrew dirs prepended ahead of /usr/bin', () => {
  // Given the platform is darwin and a minimal launchd PATH
  const env = { PATH: '/usr/bin:/bin' };
  // When the startup PATH fix runs
  augmentDarwinPath('darwin', env);
  // Then both GUI-missing dirs lead the PATH (prepend, guarding the append regression)
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin');
});

test('Scenario: repeat startup PATH fixes never grow or duplicate PATH (idempotent)', () => {
  // Given a darwin env already augmented once
  const env = { PATH: '/usr/bin:/bin' };
  augmentDarwinPath('darwin', env);
  const after1 = env.PATH;
  // When the fix runs again
  augmentDarwinPath('darwin', env);
  // Then PATH is byte-identical (no growth, no duplicate segments)
  assert.equal(env.PATH, after1);
  assert.equal(env.PATH.split(':').filter((p) => p === '/opt/homebrew/bin').length, 1);
});

test('Scenario: a pre-existing Homebrew dir is not moved, only the missing dir is prepended', () => {
  // Given PATH already contains /opt/homebrew/bin
  const env = { PATH: '/opt/homebrew/bin:/usr/bin' };
  // When the fix runs
  augmentDarwinPath('darwin', env);
  // Then only /usr/local/bin is prepended; the existing dir keeps its place
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin:/usr/bin');
});

test('Scenario: the startup PATH fix is a no-op off darwin (win32 + linux)', () => {
  // Given win32 and linux envs
  const win = { PATH: 'C:\\Windows\\System32' };
  const linux = { PATH: '/usr/bin:/bin' };
  // When the fix runs on each
  augmentDarwinPath('win32', win);
  augmentDarwinPath('linux', linux);
  // Then neither PATH changes
  assert.equal(win.PATH, 'C:\\Windows\\System32');
  assert.equal(linux.PATH, '/usr/bin:/bin');
});
