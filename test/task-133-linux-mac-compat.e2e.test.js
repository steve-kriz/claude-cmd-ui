'use strict';

// ===========================================================================
// TASK-133 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required.
//
// This ticket ships DOCS + in-app COPY truth for the cross-platform behaviour
// TASK-107/125 already implemented, plus the last PTY regression guards. It
// changes NO platform behaviour. The scenarios below implement every Gherkin
// scenario in the ticket:
//
//   Feature: README and docs reflect cross-platform support
//     - README no longer claims Windows-only
//     - README requirements are platform-qualified
//     - README documents Linux as best-effort (edge)
//     - app-shell and terminals docs match the code
//
//   Feature: Platform-truthful pane copy in the renderer
//     - terminal tab label on macOS
//     - labels on Windows are byte-identical (regression)
//     - stale preload falls back to Windows copy (edge)
//
//   Feature: Default command window on macOS and Linux (regression guards)
//     - bash pane on Linux never probes Git-for-Windows paths
//     - worker pane on Linux uses the POSIX terminator
//     - SHELL unset on macOS falls back to zsh (failure path)
//
// Platform is ALWAYS injected: file-content assertions for docs, an injected
// `isWin`/mock-DOM harness for renderer copy (the REAL relabel blocks are
// EXTRACTED from renderer.js by brace-matching and evaluated headless), and
// `spawnShell(opts, { platform, pty })` with a fake pty + spied fs for the
// spawn guards. NO real shell, PTY, mac, DOM, network, or database is touched.
// ===========================================================================

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const readme = readRepo('README.md');
const appShellDoc = readRepo(path.join('docs', 'app-shell.md'));
const terminalsDoc = readRepo(path.join('docs', 'terminals.md'));
const rendererSrc = readRepo(path.join('renderer', 'renderer.js'));

const { spawnShell } = require('../lib/pty');

// ---------------------------------------------------------------------------
// Brace-matching extractor (repo convention): pull a whole `if (...) { ... }`
// statement out of source so the REAL relabel code is evaluated headless.
// ---------------------------------------------------------------------------
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

// The two REAL TASK-133 relabel blocks, keyed off their unique comments so we
// grab the right `if (!isWin())` (there are several in the file).
const paneCopyIdx = rendererSrc.indexOf('Platform-truthful pane copy (TASK-133)');
assert.notEqual(paneCopyIdx, -1, 'pane-copy relabel block present');
const paneRelabelBlock = extractBraceBlock(rendererSrc, 'if (!isWin()) {', paneCopyIdx);

const emptyCopyIdx = rendererSrc.indexOf('Platform-truthful empty-state copy (TASK-133)');
assert.notEqual(emptyCopyIdx, -1, 'empty-state relabel block present');
const emptyRelabelBlock = extractBraceBlock(rendererSrc, 'if (!isWin()) {', emptyCopyIdx);

const runPaneRelabel = new Function('tab', 'isWin', paneRelabelBlock);
const runEmptyRelabel = new Function('dom', 'isWin', emptyRelabelBlock);

// ---------------------------------------------------------------------------
// Minimal mock DOM. querySelector returns pre-registered children by exact
// selector string — enough for the selectors the REAL block uses. NO real DOM.
// ---------------------------------------------------------------------------
function makeEl(opts = {}) {
  const classes = new Set(opts.classes || []);
  return {
    textContent: opts.textContent || '',
    childNodes: opts.childNodes || [],
    _children: opts.children || {},
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      contains(c) { return classes.has(c); },
    },
    querySelector(sel) { return this._children[sel] || null; },
  };
}

// Build the mocked workspace tab + empty-state DOM with the exact static
// Windows copy from index.html, run the REAL relabels for `platform`, and
// return the elements so a scenario can assert what changed.
function setupRendererHarness(platform) {
  const isWin = () => platform === 'win32';

  const bashTabBtn = makeEl({ textContent: 'Git Bash' });
  const opencodeOption = makeEl({ textContent: 'git bash · openCode' });
  // TASK-138: the sibling claude option (index.html:160 `cmd · claude`) is now
  // registered too, so the REAL block's claude relabel is exercised headless.
  const claudeOption = makeEl({ textContent: 'cmd · claude' });
  const agentSelect = makeEl({ children: {
    'option[value="opencode"]': opencodeOption,
    'option[value="claude"]': claudeOption,
  } });

  // The banner intro is a real text node ("… run openCode in Git Bash.").
  const bannerTextNode = { nodeType: 3, nodeValue: '\n            Install it to run openCode in Git Bash.\n          ' };
  const bannerStrong = { nodeType: 1, nodeValue: null };
  const bannerText = makeEl({ childNodes: [bannerStrong, bannerTextNode] });
  const opencodeBanner = makeEl({ children: { '.install-banner-text': bannerText } });

  const opencodeInstallBtn = makeEl({ textContent: 'Install in Git Bash' });
  const ghLoginHint = makeEl({ textContent: 'Login runs in the Git Bash tab. Follow the prompts (device code / browser) to complete sign-in, then come back and click re-check.' });
  const wingetHint = makeEl({ textContent: 'winget install runs in the Git Bash terminal. After it finishes, restart the app (or open a new folder) so the updated PATH is picked up, then click re-check.' });
  const gitNotInstalledGate = makeEl({ children: { '.git-auth-hint': wingetHint } });

  const ws = makeEl({ children: {
    '.tab-btn[data-tab="bash"]': bashTabBtn,
    '.gitAuthHint': ghLoginHint,
  } });

  const tab = { els: { ws, agentSelect, opencodeBanner, opencodeInstallBtn, gitNotInstalledGate } };
  runPaneRelabel(tab, isWin);

  const emptyMsgP = makeEl({ textContent: 'Pick a folder to open cmd.exe (with claude) and Git Bash side-by-side. Use + Folder… to open more folders in their own tabs.' });
  const emptyState = makeEl({ children: { '.empty-msg p': emptyMsgP } });
  const dom = { emptyState };
  runEmptyRelabel(dom, isWin);

  return { bashTabBtn, opencodeOption, claudeOption, agentSelect, bannerTextNode, opencodeInstallBtn, ghLoginHint, wingetHint, emptyMsgP };
}

// ---------------------------------------------------------------------------
// Fake pty backend + fs spy + $SHELL helper (mirrors task-107-mac-unix.e2e).
// ---------------------------------------------------------------------------
function makeFakePty() {
  const spawns = [];
  const backend = {
    spawn(file, args, opts) {
      const proc = {
        file, args, opts, writes: [], _dataCb: null,
        write(d) { this.writes.push(d); },
        onData(cb) { this._dataCb = cb; },
        emit(d) { if (this._dataCb) this._dataCb(d); },
      };
      spawns.push(proc);
      return proc;
    },
  };
  return { backend, spawns };
}

function spyExistsSync(ret) {
  const realFs = require('fs');
  const original = realFs.existsSync;
  const calls = [];
  realFs.existsSync = (p) => { calls.push(String(p)); return ret; };
  return { calls, restore() { realFs.existsSync = original; } };
}

function withShellEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SHELL');
  const prev = process.env.SHELL;
  if (value == null) delete process.env.SHELL; else process.env.SHELL = value;
  try { return fn(); }
  finally {
    if (had) process.env.SHELL = prev; else delete process.env.SHELL;
  }
}

// ===========================================================================
// Feature: README and docs reflect cross-platform support
// ===========================================================================
test('Scenario: README no longer claims Windows-only', () => {
  // Given the contents of README.md
  // Then it does not contain "Windows only" or "macOS/Linux are not supported"
  assert.ok(!/Windows only/i.test(readme), 'README must not say "Windows only"');
  assert.ok(!/macOS\/Linux are not supported/i.test(readme), 'no "macOS/Linux are not supported"');
  assert.ok(!/not supported/i.test(readme), 'no lingering platform "not supported" claim');
  assert.ok(!/Windows-first/i.test(readme), 'README must not say "Windows-first"');

  // And it states that on macOS/Linux the panes run the user's login shell
  assert.match(readme, /macOS\/Linux both panes are your login shell/,
    'README states login-shell panes on macOS/Linux');

  // And it links docs/cross-platform.md from the platform statement
  const blockquote = readme.slice(readme.indexOf('> **Platform:**'));
  assert.match(blockquote.slice(0, 700), /\(docs\/cross-platform\.md\)/,
    'platform blockquote links docs/cross-platform.md');
});

test('Scenario: README requirements are platform-qualified', () => {
  // Given the contents of README.md
  // Then the Git for Windows requirement is marked Windows-only
  assert.match(readme, /\*\*Windows:\*\*\s*Git for Windows/,
    'Git for Windows is scoped to Windows in the requirements table');
  assert.match(readme, /use your login shell, not Git Bash/,
    'macOS/Linux Git row notes the login shell, not Git Bash');

  // And the AWS CLI row says the fixed exe path applies on Windows and "aws" comes from PATH elsewhere
  const awsRow = readme.split('\n').find((l) => /AWS CLI v2/.test(l));
  assert.ok(awsRow, 'AWS CLI row present');
  assert.match(awsRow, /\*\*Windows:\*\*\s*fixed path `C:\\Program Files\\Amazon\\AWSCLIV2\\aws\.exe`/,
    'AWS fixed exe path is scoped to Windows');
  assert.match(awsRow, /\*\*macOS\/Linux:\*\*\s*`aws` resolved from `PATH`/,
    'off-Windows AWS comes from PATH');

  // And npm run start is documented as the cross-platform entry point
  assert.match(readme, /npm run start\s+# cross-platform entry point/,
    'npm run start is documented as the cross-platform entry point');
  assert.match(readme, /`run\.bat` is a convenience wrapper/,
    'run.bat described as a Windows convenience wrapper');
});

test('Scenario: README documents Linux as best-effort (edge)', () => {
  // Given the contents of README.md
  // Then Linux is described as expected-to-work / best-effort, not as a certified platform
  assert.match(readme, /Linux as best-effort/, 'Linux is described as best-effort');
  assert.match(readme, /expected to[\s\S]{0,12}work, less tested/,
    'best-effort is spelled out as expected-to-work / less tested');
  assert.ok(!/certified/i.test(readme), 'README does not claim any platform is certified');
});

test('Scenario: app-shell and terminals docs match the code', () => {
  // Given the contents of docs/app-shell.md and docs/terminals.md
  // Then neither claims macOS/Linux are unsupported
  for (const [name, doc] of [['app-shell.md', appShellDoc], ['terminals.md', terminalsDoc]]) {
    assert.ok(!/not supported/i.test(doc), `${name} no longer claims unsupported`);
    assert.ok(!/Windows-first/i.test(doc), `${name} no longer says Windows-first`);
    assert.ok(!/Windows only/i.test(doc), `${name} no longer says Windows only`);
  }

  // app-shell.md references cross-platform.md in place of the stale limitation
  assert.match(appShellDoc, /\*\*Cross-platform\.\*\*/, 'app-shell has a cross-platform statement');
  assert.match(appShellDoc, /\(cross-platform\.md\)/, 'app-shell links cross-platform.md');

  // And docs/terminals.md describes the POSIX login-shell branch and links docs/cross-platform.md
  assert.match(terminalsDoc, /resolvePosixShell/, 'terminals.md documents resolvePosixShell');
  assert.match(terminalsDoc, /POSIX_PROMPT_REGEX/, 'terminals.md documents the POSIX prompt regex');
  assert.match(terminalsDoc, /login shell/, 'terminals.md describes the POSIX login-shell pane');
  assert.match(terminalsDoc, /\[`cross-platform\.md`\]\(cross-platform\.md\)/,
    'terminals.md links cross-platform.md');
  // Git-Bash-missing edge is scoped to Windows
  assert.match(terminalsDoc, /Git Bash missing \(Windows\)/,
    'terminals.md scopes the Git-Bash-missing edge to Windows');
});

// ===========================================================================
// Feature: Platform-truthful pane copy in the renderer
// ===========================================================================
test('Scenario: terminal tab label on macOS', () => {
  // Given a renderer harness with platform "darwin"; When a workspace tab is created
  const h = setupRendererHarness('darwin');

  // Then the right-pane tab labelled "Git Bash" on Windows reads "Terminal"
  assert.equal(h.bashTabBtn.textContent, 'Terminal', 'bash-tab label is "Terminal" on macOS');

  // And the winget hint is hidden along with the winget button
  assert.ok(h.wingetHint.classList.contains('hidden'), 'winget hint hidden on macOS');

  // And the other Windows-worded copy is made platform-appropriate
  assert.equal(h.opencodeOption.textContent, 'shell · openCode', 'agent option relabelled');
  assert.equal(h.opencodeInstallBtn.textContent, 'Install openCode', 'opencode install btn relabelled');
  assert.match(h.bannerTextNode.nodeValue, /run openCode in your shell/, 'banner text no longer names Git Bash');
  assert.ok(!/Git Bash/.test(h.bannerTextNode.nodeValue), 'banner text drops "Git Bash"');
  assert.match(h.ghLoginHint.textContent, /^Login runs in the terminal\./, 'gh hint no longer names Git Bash');
  assert.match(h.emptyMsgP.textContent, /open your login shell with claude/, 'empty-state reworded');
  assert.ok(!/cmd\.exe|Git Bash/.test(h.emptyMsgP.textContent), 'empty-state drops cmd.exe / Git Bash');
});

test('Scenario: labels on Windows are byte-identical (regression)', () => {
  // Given a renderer harness with platform "win32"; When a workspace tab is created
  const h = setupRendererHarness('win32');

  // Then the tab label is "Git Bash" and the empty-state, opencode, and hint copy are unchanged
  assert.equal(h.bashTabBtn.textContent, 'Git Bash', 'tab label unchanged on win32');
  assert.equal(h.opencodeOption.textContent, 'git bash · openCode', 'agent option unchanged on win32');
  assert.equal(h.opencodeInstallBtn.textContent, 'Install in Git Bash', 'opencode btn unchanged on win32');
  assert.match(h.bannerTextNode.nodeValue, /run openCode in Git Bash/, 'banner text unchanged on win32');
  assert.match(h.ghLoginHint.textContent, /^Login runs in the Git Bash tab\./, 'gh hint unchanged on win32');
  assert.match(h.emptyMsgP.textContent, /open cmd\.exe \(with claude\) and Git Bash/, 'empty-state unchanged on win32');

  // And no DOM class name has changed (the winget hint is NOT hidden on win32)
  assert.ok(!h.wingetHint.classList.contains('hidden'), 'winget hint not hidden on win32 (no class change)');
});

test('Scenario: stale preload falls back to Windows copy (edge)', () => {
  // Given window.api has no platform property; When the renderer computes its platform
  // (getPlatform is extracted from the REAL source and evaluated headless)
  const getPlatform = new Function(
    extractBraceBlock(rendererSrc, 'function getPlatform(') + '\nreturn getPlatform();'
  );
  // Then it treats the platform as "win32" and does not throw
  let plat;
  assert.doesNotThrow(() => {
    // simulate a stale preload: window.api present but no .platform
    global.window = { api: {} };
    try { plat = getPlatform(); } finally { delete global.window; }
  }, 'getPlatform tolerates a stale preload without throwing');
  assert.equal(plat, 'win32', 'stale preload falls back to win32');

  // And the relabel harness driven with that fallback leaves Windows copy intact
  const h = setupRendererHarness('win32');
  assert.equal(h.bashTabBtn.textContent, 'Git Bash', 'fallback keeps Windows labels, no throw');
});

// ===========================================================================
// TASK-138 — Feature: The claude agent option is platform-truthful on macOS/Linux
//
// Extends the TASK-133 relabel harness above (the mock agentSelect now also
// registers `option[value="claude"]` with the static Windows copy `cmd · claude`
// from index.html:160). The REAL `if (!isWin())` block is still brace-extracted
// and evaluated headless, so the claude relabel is exercised for real.
// ===========================================================================
test('TASK-138 Scenario: claude option relabeled on macOS', () => {
  // Given a renderer harness with platform "darwin"
  // When a workspace tab is created and the agent dropdown is relabeled
  const h = setupRendererHarness('darwin');

  // Then the option with value "claude" reads "shell · claude"
  assert.equal(h.claudeOption.textContent, 'shell · claude',
    'claude option relabelled to "shell · claude" on macOS');
  // And the option with value "opencode" reads "shell · openCode" (unbroken)
  assert.equal(h.opencodeOption.textContent, 'shell · openCode',
    'opencode option still relabelled to "shell · openCode" on macOS');
});

test('TASK-138 Scenario: claude option unchanged on Windows (regression)', () => {
  // Given a renderer harness with platform "win32"; When a workspace tab is created
  const h = setupRendererHarness('win32');

  // Then the option with value "claude" reads "cmd · claude"
  assert.equal(h.claudeOption.textContent, 'cmd · claude',
    'claude option byte-identical on win32');
  // And no option value or DOM class has changed (only visible text is ever touched;
  // the mock select still resolves both options by their unchanged value selectors)
  assert.strictEqual(h.agentSelect.querySelector('option[value="claude"]'), h.claudeOption,
    'claude option value selector unchanged on win32');
  assert.strictEqual(h.agentSelect.querySelector('option[value="opencode"]'), h.opencodeOption,
    'opencode option value selector unchanged on win32');
  assert.ok(!h.claudeOption.classList.contains('hidden'), 'claude option DOM class unchanged on win32');
});

test('TASK-138 Scenario (edge): stale preload falls back to Windows label', () => {
  // Given window.api has no platform property → getPlatform() falls back to win32
  const getPlatform = new Function(
    extractBraceBlock(rendererSrc, 'function getPlatform(') + '\nreturn getPlatform();'
  );
  let plat;
  assert.doesNotThrow(() => {
    global.window = { api: {} };
    try { plat = getPlatform(); } finally { delete global.window; }
  }, 'getPlatform tolerates a stale preload without throwing');
  assert.equal(plat, 'win32', 'stale preload falls back to win32');

  // When the renderer computes its platform and relabels (driven with that fallback)
  const h = setupRendererHarness('win32');
  // Then the claude option keeps "cmd · claude" and no error is thrown
  assert.equal(h.claudeOption.textContent, 'cmd · claude',
    'stale-preload fallback keeps the Windows claude label');
});

test('TASK-138 Scenario (edge): claude option missing from the select', () => {
  // Given a workspace tab whose agent select has no option with value "claude"
  const isWin = () => false; // darwin/linux path
  const bashTabBtn = makeEl({ textContent: 'Git Bash' });
  const opencodeOption = makeEl({ textContent: 'git bash · openCode' });
  // agentSelect resolves opencode but returns null for the claude selector
  const agentSelect = makeEl({ children: { 'option[value="opencode"]': opencodeOption } });
  const ws = makeEl({ children: { '.tab-btn[data-tab="bash"]': bashTabBtn } });
  const tab = { els: { ws, agentSelect } };

  // When the non-win32 relabel block runs
  // Then no error is thrown and the other relabels still apply
  assert.doesNotThrow(() => runPaneRelabel(tab, isWin),
    'missing claude option does not throw');
  assert.equal(agentSelect.querySelector('option[value="claude"]'), null,
    'claude option genuinely absent from the mock select');
  assert.equal(bashTabBtn.textContent, 'Terminal', 'other relabels still apply (bash tab)');
  assert.equal(opencodeOption.textContent, 'shell · openCode', 'other relabels still apply (opencode)');
});

// ===========================================================================
// Feature: Default command window on macOS and Linux (regression guards)
// ===========================================================================
test('Scenario: bash pane on Linux never probes Git-for-Windows paths', () => {
  // Given the injected platform is "linux" and a mocked pty backend and fs
  withShellEnv('/bin/bash', () => {
    const spy = spyExistsSync(false);
    const { backend, spawns } = makeFakePty();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // When spawnShell is called with shell "bash" and cliCommand "npm test"
      const proc = spawnShell({ shell: 'bash', cliCommand: 'npm test', cwd: '/home/steve/proj' },
        { platform: 'linux', pty: backend });

      // Then the POSIX shell is spawned with ["-l","-i"]
      assert.equal(spawns.length, 1, 'exactly one spawn');
      assert.equal(proc.file, '/bin/bash', 'linux bash pane is the POSIX login shell');
      assert.deepEqual(proc.args, ['-l', '-i'], 'login+interactive args');
      assert.notEqual(proc.file, 'cmd.exe', 'never cmd.exe on linux');

      // And no existence check is made against any "C:\Program Files" path
      assert.equal(spy.calls.filter((p) => p.includes('Program Files')).length, 0,
        'no Git-for-Windows fs probe on linux');

      // And the spawned env does not include CHERE_INVOKING
      assert.ok(!('CHERE_INVOKING' in proc.opts.env), 'CHERE_INVOKING never set on POSIX');

      // And after a prompt ending in "$" renders, "npm test\n" is written
      proc.emit('steve@box:~/proj$ ');
      mock.timers.tick(50);
      assert.deepEqual(proc.writes, ['npm test\n'], 'POSIX newline terminator, exactly once');
    } finally {
      mock.timers.reset();
      spy.restore();
    }
  });
});

test('Scenario: worker pane on Linux uses the POSIX terminator', () => {
  // Given the injected platform is "linux" and a mocked pty backend
  withShellEnv('/bin/bash', () => {
    const { backend, spawns } = makeFakePty();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // When spawnShell is called with shell "worker" and worker "gemini"
      const proc = spawnShell({ shell: 'worker', worker: 'gemini', cwd: '/home/steve/proj' },
        { platform: 'linux', pty: backend });

      // Then the POSIX shell is spawned
      assert.equal(spawns.length, 1, 'one spawn');
      assert.equal(proc.file, '/bin/bash', 'linux worker pane is the POSIX login shell');
      assert.notEqual(proc.file, 'cmd.exe', 'never cmd.exe on linux');

      // And "gemini\n" is eventually written exactly once
      assert.deepEqual(proc.writes, [], 'nothing written before the prompt');
      proc.emit('steve@box:~/proj$ ');
      mock.timers.tick(50);
      assert.deepEqual(proc.writes, ['gemini\n'], 'worker command with POSIX newline');
      // A late prompt / more time cannot double-write (launched guard)
      mock.timers.tick(5000);
      proc.emit('steve@box:~/proj$ ');
      mock.timers.tick(50);
      assert.deepEqual(proc.writes, ['gemini\n'], 'written exactly once');
    } finally {
      mock.timers.reset();
    }
  });
});

test('Scenario: SHELL unset on macOS falls back to zsh (failure path)', () => {
  // Given the injected platform is "darwin" and env SHELL is unset
  withShellEnv(null, () => {
    const { backend, spawns } = makeFakePty();
    // When spawnShell is called with shell "cmd"
    const proc = spawnShell({ shell: 'cmd', cwd: '/Users/steve/proj' },
      { platform: 'darwin', pty: backend });
    // Then "/bin/zsh" is spawned and never "cmd.exe"
    assert.equal(spawns.length, 1);
    assert.equal(proc.file, '/bin/zsh', 'falls back to /bin/zsh on darwin with no $SHELL');
    assert.notEqual(proc.file, 'cmd.exe', 'never cmd.exe on darwin');
  });

  // And a whitespace-only $SHELL is treated the same (blank -> fallback)
  withShellEnv('   ', () => {
    const { backend } = makeFakePty();
    const proc = spawnShell({ shell: 'cmd', cwd: '/Users/steve/proj' },
      { platform: 'darwin', pty: backend });
    assert.equal(proc.file, '/bin/zsh', 'blank $SHELL also falls back to /bin/zsh');
  });
});

// ===========================================================================
// TASK-139 — Feature: The relabel e2e is source-pinned to index.html
//
// setupRendererHarness above builds a SYNTHETIC mock DOM whose "before" strings
// (`Git Bash`, `git bash · openCode`, `Install in Git Bash`, …) and selector
// keys (`.tab-btn[data-tab="bash"]`, `option[value="opencode"]`, `.gitAuthHint`,
// …) are hard-coded copies of today's renderer/index.html. Nothing tied those
// copies back to the shipped markup, so a later index.html edit (renaming the
// bash tab, the opencode/claude option text, or the
// gitAuthHint / opencodeInstallBtn / git-auth-hint classes) could silently turn
// the mac/Linux relabels into no-ops while this whole suite stays green,
// reintroducing Windows-worded copy on mac with no failing test to catch it.
//
// These scenarios read the REAL renderer/index.html at test time (via the same
// readRepo helper the file already uses for README/docs/renderer.js) and pin
// BOTH the exact "before" strings AND the selector-bearing classes/attributes
// the relabels depend on. The non-unique classes (.install-banner-text ×3 at
// :198/:211/:679, .git-auth-hint ×2 at :399/:412) are SCOPED to their container
// block so a rename of the relevant occurrence cannot pass on a sibling.
// ===========================================================================
const indexHtml = readRepo(path.join('renderer', 'index.html'));

// Slice the opencodeInstallBanner block (index.html:210-221) so the
// install-banner-text / banner-sentence / install-button pins cannot pass on
// the claudeInstallBanner (:197) or tasksSkillBanner (:678) siblings.
const opencodeBannerBlock = (() => {
  const start = indexHtml.indexOf('opencodeInstallBanner');
  assert.notEqual(start, -1, 'opencodeInstallBanner block present in index.html');
  const end = indexHtml.indexOf('cmdTerm term', start);
  assert.notEqual(end, -1, 'opencodeInstallBanner block bounded by the cmdTerm element');
  return indexHtml.slice(start, end);
})();

// Slice the gitNotInstalledGate block (index.html:388-400) so the winget
// git-auth-hint pin cannot pass on the gitAuthHint occurrence at :412 (which
// also carries the git-auth-hint class inside the sibling gitAuthGate block).
const gitNotInstalledGateBlock = (() => {
  const start = indexHtml.indexOf('gitNotInstalledGate');
  assert.notEqual(start, -1, 'gitNotInstalledGate block present in index.html');
  const end = indexHtml.indexOf('gitAuthGate', start);
  assert.notEqual(end, -1, 'gitNotInstalledGate block bounded by the gitAuthGate sibling');
  return indexHtml.slice(start, end);
})();

// TASK-141 Finding 1: slice the empty-msg container (index.html:20-24) so the
// empty-state relabel's SELECTOR structure (`.empty-msg p`, renderer.js:12602)
// can be pinned WITHOUT an unrelated `.empty-msg`/`<p>` elsewhere satisfying it.
// Bounded by </main>, mirroring the opencodeBannerBlock / gitNotInstalledGateBlock
// container-slice approach used for the non-unique class pins above.
const emptyMsgBlock = (() => {
  const start = indexHtml.indexOf('class="empty-msg"');
  assert.notEqual(start, -1, 'empty-msg container present in index.html');
  const end = indexHtml.indexOf('</main>', start);
  assert.notEqual(end, -1, 'empty-msg block bounded by the closing </main>');
  return indexHtml.slice(start, end);
})();

// TASK-141 Finding 2: slice the bash tab <button> element (index.html:229) so the
// `tab-btn` class token and the `data-tab="bash"` attribute can be pinned together
// but ORDER-INSENSITIVELY (scoped to the one button), instead of the old regex that
// required class to precede data-tab and the token to be first in the class list.
const bashTabButton = (() => {
  const attrIdx = indexHtml.indexOf('data-tab="bash"');
  assert.notEqual(attrIdx, -1, 'data-tab="bash" present in index.html');
  const open = indexHtml.lastIndexOf('<button', attrIdx);
  assert.notEqual(open, -1, 'the bash tab is a <button> element');
  const close = indexHtml.indexOf('>', attrIdx);
  assert.notEqual(close, -1, 'bash tab button open tag is terminated');
  return indexHtml.slice(open, close + 1);
})();

test('TASK-139 Scenario: before-strings are pinned to the shipped markup', () => {
  // Given the contents of renderer/index.html read at test time
  // Then it contains the bash-tab label "Git Bash" (index.html:229)
  assert.match(indexHtml, /data-tab="bash">Git Bash</,
    'bash-tab still labelled "Git Bash" (index.html:229)');

  // And the opencode option text "git bash · openCode" (index.html:161)
  assert.match(indexHtml, /<option value="opencode">git bash · openCode<\/option>/,
    'opencode option still reads "git bash · openCode" (index.html:161)');

  // And the claude option text "cmd · claude" (index.html:160) — kept in sync
  // with TASK-138's renderer-only relabel (index.html is unchanged by TASK-138)
  assert.match(indexHtml, /<option value="claude">cmd · claude<\/option>/,
    'claude option still reads "cmd · claude" (index.html:160)');

  // And the opencode banner sentence (index.html:213), scoped to its block
  assert.match(opencodeBannerBlock, /Install it to run openCode in Git Bash\./,
    'opencode banner still says "Install it to run openCode in Git Bash." (index.html:213)');

  // And the opencode install button text (index.html:216), scoped to its block
  assert.match(opencodeBannerBlock, /Install in Git Bash</,
    'opencode install button still reads "Install in Git Bash" (index.html:216)');

  // And the gh-login hint prefix (index.html:412)
  assert.match(indexHtml, /Login runs in the Git Bash tab\./,
    'gh-login hint still starts "Login runs in the Git Bash tab." (index.html:412)');

  // And the winget hint prefix (index.html:399), scoped to the gate block
  assert.match(gitNotInstalledGateBlock, /winget install runs in the Git Bash terminal/,
    'winget hint still starts "winget install runs in the Git Bash terminal" (index.html:399)');

  // And the empty-state fragments naming cmd.exe and Git Bash (index.html:22).
  // The raw markup wraps these in <code> tags, so pin the markup-aware fragment,
  // NOT the flat textContent string the harness uses at :133.
  assert.match(indexHtml, /<code>cmd\.exe<\/code>/,
    'empty-state names cmd.exe in <code> markup (index.html:22)');
  assert.match(indexHtml, /<code>Git Bash<\/code>/,
    'empty-state names Git Bash in <code> markup (index.html:22)');
  assert.match(indexHtml,
    /open <code>cmd\.exe<\/code> \(with <code>claude<\/code>\) and <code>Git Bash<\/code>/,
    'empty-state intro markup fragment intact (index.html:22)');
});

test('TASK-139 Scenario: relabel selectors are pinned to the shipped markup', () => {
  // Given the contents of renderer/index.html read at test time
  // Then the bash tab <button> (index.html:229) carries BOTH data-tab="bash" and
  // a `tab-btn` class token — the harness keys this as `.tab-btn[data-tab="bash"]`.
  // Asserted order-insensitively and scoped to the button element (TASK-141
  // Finding 2), so a cosmetic attribute/class reorder does not falsely fail.
  assert.match(bashTabButton, /data-tab="bash"/,
    'the bash tab button carries data-tab="bash" (index.html:229)');
  assert.match(bashTabButton, /\btab-btn\b/,
    'the bash tab button carries the tab-btn class token, order-insensitive (index.html:229)');

  // And it contains option value="opencode" (:161) and option value="claude" (:160)
  assert.match(indexHtml, /<option value="opencode">/,
    'option[value="opencode"] present (index.html:161)');
  assert.match(indexHtml, /<option value="claude">/,
    'option[value="claude"] present (index.html:160)');

  // And it contains an install-banner-text INSIDE the opencodeInstallBanner
  // block (index.html:211) — scoped so the :198/:679 siblings cannot satisfy it
  assert.match(opencodeBannerBlock, /class="install-banner-text"/,
    'install-banner-text exists inside the opencodeInstallBanner block (index.html:211)');

  // And the opencodeInstallBtn class TOKEN (index.html:216), scoped to the banner.
  // Asserted as a `\bopencodeInstallBtn\b` token (TASK-141 Finding 2) so it need not
  // be the first token in class="…" — a cosmetic token reorder does not falsely fail.
  assert.match(opencodeBannerBlock, /\bopencodeInstallBtn\b/,
    'opencodeInstallBtn class token present in the opencode banner, order-insensitive (index.html:216)');

  // And the gitAuthHint class (index.html:412) — unique, no scoping needed
  assert.match(indexHtml, /class="gitAuthHint[^"]*"/,
    'gitAuthHint class present (index.html:412)');

  // And a git-auth-hint INSIDE the gitNotInstalledGate block (index.html:399) —
  // scoped so the :412 occurrence in the sibling gitAuthGate cannot satisfy it
  assert.match(gitNotInstalledGateBlock, /class="git-auth-hint"/,
    'git-auth-hint exists inside the gitNotInstalledGate block (index.html:399)');
});

test('TASK-139 Scenario (failure): a renamed bash-tab label would fail the "Git Bash" pin', () => {
  // Given a hypothetical index.html where the bash tab label was renamed
  const mutated = indexHtml.replace('data-tab="bash">Git Bash<', 'data-tab="bash">Terminal<');
  assert.notEqual(mutated, indexHtml,
    'the mutation actually changed the markup (guards against a stale anchor)');

  // Then the source-pin assertion for "Git Bash" fails — catching the gap that
  // would silently no-op the mac relabel (the harness would keep matching its
  // own hard-coded "Git Bash" copy while the live DOM had drifted)
  assert.ok(!/data-tab="bash">Git Bash</.test(mutated),
    'renaming the bash tab label is caught by the before-string pin');
});

test('TASK-139 Scenario (edge): a gitAuthHint class rename is caught even when the copy is kept', () => {
  // Given a hypothetical index.html where the gitAuthHint class was renamed but
  // the "Login runs in the Git Bash tab." copy was left untouched
  const mutated = indexHtml.replace('class="gitAuthHint git-auth-hint"',
    'class="ghLoginHint git-auth-hint"');
  assert.notEqual(mutated, indexHtml, 'the mutation actually renamed the class');

  // Then the STRING pin still passes (copy unchanged) — a string-only pin misses it
  assert.match(mutated, /Login runs in the Git Bash tab\./,
    'the copy is untouched, so a string-only pin would not catch the rename');

  // But the SELECTOR pin for gitAuthHint fails, catching the silent no-op the
  // relabel's `.gitAuthHint` querySelector would hit on the live DOM
  assert.ok(!/class="gitAuthHint[^"]*"/.test(mutated),
    'renaming gitAuthHint is caught by the selector pin even though the copy pin passes');
});

// ===========================================================================
// TASK-141 — Feature: the empty-state relabel SELECTOR is source-pinned and the
// two order-sensitive pins are order-insensitive
//
// Review follow-up of TASK-139. Finding 1: the empty-state relabel does
// `dom.emptyState.querySelector('.empty-msg p')` (renderer.js:12602) then
// overwrites textContent. TASK-139 pinned only the COPY fragments (<code>cmd.exe</code>,
// <code>Git Bash</code>, the intro fragment) — NOT the selector structure. If
// `.empty-msg` were renamed (or the `<p>` removed) while the copy stayed,
// querySelector returns null, the relabel silently no-ops, and mac/Linux keep the
// Windows-only wording while every string pin still passes. These scenarios pin the
// `.empty-msg` class and the `<p>` descendant (scoped to the sliced empty-msg
// container). Finding 2's loosened bash-tab / opencodeInstallBtn pins are proven
// here to (a) still PASS under a cosmetic reorder and (b) still FAIL when the real
// token/attribute is actually removed (i.e. they did not become vacuous).
// ===========================================================================
test('TASK-141 Scenario: the empty-state selector structure is pinned', () => {
  // Given the contents of renderer/index.html read at test time
  // Then it contains class="empty-msg" (index.html:20)
  assert.match(indexHtml, /class="empty-msg"/,
    'empty-state container class="empty-msg" present (index.html:20)');

  // And a <p> element exists INSIDE the empty-msg container (index.html:22) —
  // scoped to the sliced block so an unrelated .empty-msg/<p> cannot satisfy it.
  // This pins the `.empty-msg p` selector the relabel depends on (renderer.js:12602).
  assert.match(emptyMsgBlock, /<p>/,
    'a <p> descendant exists inside the empty-msg container (index.html:22)');

  // And that <p> still carries the Windows-only copy the relabel overwrites off-win32
  assert.match(emptyMsgBlock, /open <code>cmd\.exe<\/code> \(with <code>claude<\/code>\) and <code>Git Bash<\/code>/,
    'the empty-msg <p> still carries the cmd.exe/Git Bash intro copy (index.html:22)');
});

test('TASK-141 Scenario (edge): an empty-msg class rename is caught even when the copy is kept', () => {
  // Given a hypothetical index.html where the empty-msg container class was renamed
  // but the cmd.exe/Git Bash copy was left untouched
  const mutated = indexHtml.replace('class="empty-msg"', 'class="first-run-msg"');
  assert.notEqual(mutated, indexHtml, 'the mutation actually renamed the class');

  // Then the STRING/copy pin still passes (copy unchanged) — a string-only pin misses it
  assert.match(mutated,
    /open <code>cmd\.exe<\/code> \(with <code>claude<\/code>\) and <code>Git Bash<\/code>/,
    'the copy is untouched, so a string-only pin would not catch the rename');

  // But the SELECTOR pin for .empty-msg fails, catching the silent no-op the
  // relabel's `.empty-msg p` querySelector would hit on the live DOM (mac/Linux
  // would keep the Windows-only empty-state wording)
  assert.ok(!/class="empty-msg"/.test(mutated),
    'renaming .empty-msg is caught by the selector pin even though the copy pin passes');
});

test('TASK-141 Scenario (edge): a cosmetic bash-tab reorder still passes the loosened pin', () => {
  // Given index.html writes the bash tab with attributes/tokens reordered
  // (data-tab before class, and tab-btn not first in the class list)
  const reordered = '<button data-tab="bash" class="active tab-btn">Git Bash</button>';

  // Then the loosened bash-tab pin still passes: both data-tab="bash" and the
  // tab-btn token are present regardless of order
  assert.match(reordered, /data-tab="bash"/,
    'reordered bash tab still carries data-tab="bash"');
  assert.match(reordered, /\btab-btn\b/,
    'reordered bash tab still carries the tab-btn class token');
});

test('TASK-141 Scenario (failure): removing the tab-btn token from the bash tab fails the loosened pin', () => {
  // Given a hypothetical bash tab button that lost its tab-btn class
  const mutated = bashTabButton.replace(/\btab-btn\b/, 'nav-btn');
  assert.notEqual(mutated, bashTabButton, 'the mutation actually removed the tab-btn token');

  // Then the loosened bash-tab token pin FAILS — proving it did not become vacuous
  assert.ok(!/\btab-btn\b/.test(mutated),
    'a removed tab-btn class token is still caught (loosened pin is not vacuous)');
  // And data-tab="bash" alone is not enough to keep the pin green
  assert.match(mutated, /data-tab="bash"/,
    'data-tab="bash" survives, so only the class-token pin catches this regression');
});

test('TASK-141 Scenario (edge): a cosmetic opencodeInstallBtn token reorder still passes the loosened pin', () => {
  // Given the install button written with opencodeInstallBtn NOT first in the class list
  const reordered = '<button class="small-btn primary-btn opencodeInstallBtn">Install in Git Bash</button>';

  // Then the loosened opencodeInstallBtn token pin still passes
  assert.match(reordered, /\bopencodeInstallBtn\b/,
    'opencodeInstallBtn token matches even when it is not the first class token');
});

test('TASK-141 Scenario (failure): removing the opencodeInstallBtn token fails the loosened pin', () => {
  // Given a hypothetical opencode banner where the install button lost its token
  const mutated = opencodeBannerBlock.replace(/\bopencodeInstallBtn\b/, 'installBtn');
  assert.notEqual(mutated, opencodeBannerBlock, 'the mutation actually removed the token');

  // Then the loosened opencodeInstallBtn token pin FAILS — proving it is not vacuous
  assert.ok(!/\bopencodeInstallBtn\b/.test(mutated),
    'a removed opencodeInstallBtn class token is still caught (loosened pin is not vacuous)');
});
