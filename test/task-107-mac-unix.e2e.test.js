'use strict';

// ===========================================================================
// TASK-107 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required.
//
// Feature coverage (every Gherkin scenario in the ticket):
//   * Cross-platform shell & PTY spawning (lib/pty.js) — cmd/bash/worker slots on
//     win32 vs darwin/linux, $SHELL resolution + fallbacks, the Git-Bash-absent
//     failure path, no Git-for-Windows fs probing / no CHERE_INVOKING on POSIX,
//     the 1500ms prompt-fallback firing EXACTLY once, and unknown-shell rejection
//     on every platform.
//   * Cross-platform path joining (renderer.js) — byte-identical Windows output,
//     POSIX forward-slash joins, and the trailing-separator edge.
//   * Platform-aware commands & locations — resolveAwsExe (win32 vs darwin),
//     augmentDarwinPath (adds both dirs / idempotent / no-op win32), and the
//     install-helper platform selection (source-pinned + pure page mapping).
//
// EVERYTHING platform-related is INJECTED or MOCKED: the platform id and pty
// backend are injected into spawnShell; fs.existsSync is spied; the 50ms/1500ms
// timers are driven by node:test mock timers. NO real shell, binary, PTY,
// Electron, or database/network is touched.
// ===========================================================================

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

const { spawnShell } = require('../lib/pty');
const { __testing: aws } = require('../lib/aws');
const { resolveAwsExe } = aws;

// ---------------------------------------------------------------------------
// FAKE pty backend — records every spawn and every write, and lets a test drive
// the shell's output via proc.emit(). No real PTY. Shape matches the ticket's
// `{ spawn(file, args, opts) -> { write, onData } }`.
// ---------------------------------------------------------------------------
function makeFakePty() {
  const spawns = [];
  const backend = {
    spawn(file, args, opts) {
      const proc = {
        file,
        args,
        opts,
        writes: [],
        _dataCb: null,
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

// Run `fn` with process.env.SHELL forced to `value` (or unset when value == null),
// restoring the previous value afterwards. spawnPosix reads process.env directly.
function withShellEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SHELL');
  const prev = process.env.SHELL;
  if (value == null) delete process.env.SHELL; else process.env.SHELL = value;
  try { return fn(); }
  finally {
    if (had) process.env.SHELL = prev; else delete process.env.SHELL;
  }
}

// Spy on fs.existsSync (the SAME module object lib/pty.js holds a reference to),
// recording every path it is asked about and returning `ret`.
function spyExistsSync(ret) {
  const realFs = require('fs');
  const original = realFs.existsSync;
  const calls = [];
  realFs.existsSync = (p) => { calls.push(String(p)); return ret; };
  return { calls, restore() { realFs.existsSync = original; } };
}

// --- Extract a named function from source (brace-matching), repo convention. --
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} present`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');

// REAL renderer join helpers, evaluated headless (no window/DOM needed).
const { tasksJoin } = new Function(
  [
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    'return { tasksJoin };',
  ].join('\n')
)();

// REAL darwin PATH fix, extracted so main.js's Electron entry code never runs.
const augmentDarwinPath = new Function(
  extractFn(mainSrc, 'augmentDarwinPath') + '\nreturn augmentDarwinPath;'
)();

// ===========================================================================
// Feature: Cross-platform shell and PTY spawning
// ===========================================================================

test('Scenario: cmd slot on Windows is unchanged', () => {
  // Given the platform is "win32" and a mocked pty backend
  const { backend, spawns } = makeFakePty();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // When spawnShell is called with shell "cmd" and cliCommand "claude"
    const proc = spawnShell({ shell: 'cmd', cliCommand: 'claude', cwd: 'C:\\proj' },
      { platform: 'win32', pty: backend });

    // Then the backend spawns "cmd.exe" with empty args, env === process.env
    assert.equal(spawns.length, 1, 'exactly one spawn');
    assert.equal(proc.file, 'cmd.exe', 'spawns cmd.exe on win32');
    assert.deepEqual(proc.args, [], 'cmd.exe gets EMPTY args (no regression)');
    assert.equal(proc.opts.env, process.env, 'cmd.exe inherits process.env by reference (no regression)');

    // And after a mocked CMD prompt "C:\proj>" is emitted, "claude\r" is written
    proc.emit('Microsoft Windows [Version]\r\nC:\\proj>');
    mock.timers.tick(50);
    assert.deepEqual(proc.writes, ['claude\r'], 'writes claude + CR terminator exactly once');
  } finally {
    mock.timers.reset();
  }
});

test('Scenario: cmd slot on macOS uses the user\'s shell', () => {
  // Given the platform is "darwin" and env SHELL is "/bin/zsh"
  withShellEnv('/bin/zsh', () => {
    const { backend, spawns } = makeFakePty();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // When spawnShell is called with shell "cmd" and cliCommand "claude"
      const proc = spawnShell({ shell: 'cmd', cliCommand: 'claude', cwd: '/Users/steve/proj' },
        { platform: 'darwin', pty: backend });

      // Then the backend spawns "/bin/zsh" (not "cmd.exe")
      assert.equal(spawns.length, 1);
      assert.equal(proc.file, '/bin/zsh', 'darwin cmd slot spawns the login shell');
      assert.notEqual(proc.file, 'cmd.exe', 'never cmd.exe on darwin');

      // And after a mocked zsh prompt ending in "%" is emitted, "claude\n" is written
      proc.emit('steve@mac proj % ');
      mock.timers.tick(50);
      assert.deepEqual(proc.writes, ['claude\n'], 'POSIX newline terminator (\\n), not \\r');
    } finally {
      mock.timers.reset();
    }
  });
});

test('Scenario: cmd slot on macOS without $SHELL falls back to /bin/zsh', () => {
  withShellEnv(null, () => {
    const { backend } = makeFakePty();
    const proc = spawnShell({ shell: 'cmd', cwd: '/Users/steve/proj' },
      { platform: 'darwin', pty: backend });
    assert.equal(proc.file, '/bin/zsh', 'darwin fallback is /bin/zsh');
  });
});

test('Scenario: cmd slot on Linux without $SHELL falls back to /bin/bash', () => {
  withShellEnv(null, () => {
    const { backend } = makeFakePty();
    const proc = spawnShell({ shell: 'cmd', cwd: '/home/steve/proj' },
      { platform: 'linux', pty: backend });
    assert.equal(proc.file, '/bin/bash', 'linux fallback is /bin/bash');
  });
});

test('Scenario: bash slot on Windows still requires Git Bash (edge/failure)', () => {
  // Given the platform is "win32" and neither Git Bash candidate path exists
  const spy = spyExistsSync(false);
  const { backend } = makeFakePty();
  try {
    // When spawnShell is called with shell "bash"
    // Then it throws the exact preserved error text
    assert.throws(
      () => spawnShell({ shell: 'bash', cwd: 'C:\\proj' }, { platform: 'win32', pty: backend }),
      /^Error: Git Bash not found\. Install Git for Windows\.$/,
      'exact Git Bash error text is preserved',
    );
    // And it probed the two C:\Program Files candidates
    assert.ok(spy.calls.some((p) => p.includes('Program Files\\Git\\bin\\bash.exe')),
      'win32 bash slot probes the Git-for-Windows candidate path');
  } finally {
    spy.restore();
  }
});

test('Scenario: bash slot on macOS never probes Git-for-Windows paths', () => {
  // $SHELL forced so the spawned shell is deterministic regardless of the host
  // env this test itself runs under.
  withShellEnv('/bin/zsh', () => {
    const spy = spyExistsSync(false);
    const { backend } = makeFakePty();
    try {
      // Given the platform is "darwin"; When spawnShell is called with shell "bash"
      const proc = spawnShell({ shell: 'bash', cwd: '/Users/steve/proj' },
        { platform: 'darwin', pty: backend });

      // Then no fs existence check is made against any "C:\Program Files" path
      assert.equal(spy.calls.filter((p) => p.includes('Program Files')).length, 0,
        'no Git-for-Windows fs probe on darwin');
      // And a POSIX shell was spawned, whose env does NOT include CHERE_INVOKING
      assert.equal(proc.file, '/bin/zsh', 'darwin bash pane is the POSIX login shell');
      assert.ok(!('CHERE_INVOKING' in proc.opts.env),
        'CHERE_INVOKING (MSYS-only) is never set on POSIX');
    } finally {
      spy.restore();
    }
  });
});

test('Scenario: bash slot on Windows sets CHERE_INVOKING and Git Bash args (win32 no-regression)', () => {
  // Guards the win32 side of the same criterion: Git Bash resolved + --login -i +
  // CHERE_INVOKING='1'. Uses a spy that reports the FIRST candidate present.
  const realFs = require('fs');
  const original = realFs.existsSync;
  realFs.existsSync = (p) => String(p) === 'C:\\Program Files\\Git\\bin\\bash.exe';
  const { backend } = makeFakePty();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const proc = spawnShell({ shell: 'bash', cliCommand: 'claude', cwd: 'C:\\proj' },
      { platform: 'win32', pty: backend });
    assert.equal(proc.file, 'C:\\Program Files\\Git\\bin\\bash.exe', 'resolves Git Bash exe');
    assert.deepEqual(proc.args, ['--login', '-i'], 'Git Bash launched with --login -i');
    assert.equal(proc.opts.env.CHERE_INVOKING, '1', 'CHERE_INVOKING is set on win32 only');
  } finally {
    mock.timers.reset();
    realFs.existsSync = original;
  }
});

test('Scenario: worker slot follows the platform split', () => {
  // Given the platform is "darwin"
  withShellEnv('/bin/zsh', () => {
    const { backend, spawns } = makeFakePty();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // When spawnShell is called with shell "worker" and worker "gemini"
      const proc = spawnShell({ shell: 'worker', worker: 'gemini', cwd: '/Users/steve/proj' },
        { platform: 'darwin', pty: backend });

      // Then the backend spawns the POSIX shell and later writes "gemini\n"
      assert.equal(spawns.length, 1);
      assert.equal(proc.file, '/bin/zsh', 'worker pane uses the POSIX shell on darwin');
      assert.notEqual(proc.file, 'cmd.exe');
      proc.emit('steve@mac proj % ');
      mock.timers.tick(50);
      assert.deepEqual(proc.writes, ['gemini\n'], 'worker command with POSIX newline');
    } finally {
      mock.timers.reset();
    }
  });
});

test('Scenario: worker slot on win32 is unchanged (cmd.exe + \\r)', () => {
  const { backend } = makeFakePty();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const proc = spawnShell({ shell: 'worker', worker: 'codex', cwd: 'C:\\proj' },
      { platform: 'win32', pty: backend });
    assert.equal(proc.file, 'cmd.exe');
    assert.deepEqual(proc.args, []);
    proc.emit('C:\\proj>');
    mock.timers.tick(50);
    assert.deepEqual(proc.writes, ['codex\r'], 'worker on win32 keeps cmd.exe + CR');
  } finally {
    mock.timers.reset();
  }
});

test('Scenario: prompt never detected still autolaunches via fallback (edge)', () => {
  // Given the platform is "darwin" and output that never matches a prompt
  withShellEnv('/bin/zsh', () => {
    const { backend } = makeFakePty();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const proc = spawnShell({ shell: 'cmd', cliCommand: 'claude', cwd: '/Users/steve/proj' },
        { platform: 'darwin', pty: backend });
      proc.emit('a heavily themed powerlevel10k banner with no prompt char');

      assert.deepEqual(proc.writes, [], 'nothing written before the fallback fires');
      // When 1500 ms elapse (mocked timer)
      mock.timers.tick(1500);
      // Then the cliCommand is written exactly once
      assert.deepEqual(proc.writes, ['claude\n'], 'fallback writes the command once');
      // And further time / a late prompt cannot double-write (launched guard)
      mock.timers.tick(5000);
      proc.emit('steve@mac proj % ');
      mock.timers.tick(50);
      assert.deepEqual(proc.writes, ['claude\n'], 'still exactly one write — never doubled');
    } finally {
      mock.timers.reset();
    }
  });
});

test('Scenario: unknown shell rejected on every platform (failure)', () => {
  const { backend } = makeFakePty();
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.throws(
      () => spawnShell({ shell: 'fish-tank', cwd: '/x' }, { platform, pty: backend }),
      /^Error: Unknown shell: fish-tank$/,
      `unknown shell throws on ${platform}`,
    );
  }
});

// ===========================================================================
// Feature: Cross-platform path joining in the renderer
// ===========================================================================

test('Scenario: Windows folder joins are byte-identical to today', () => {
  // Given a base folder "C:\proj"
  // When tasksJoin builds the tasks dir and a ticket path
  const tasksDir = tasksJoin('C:\\proj', 'tasks');
  const ticket = tasksJoin('C:\\proj', 'tasks', 'todo', 'TASK-001-x.md');
  // Then the results are byte-identical to the pre-change backslash form
  assert.equal(tasksDir, 'C:\\proj\\tasks');
  assert.equal(ticket, 'C:\\proj\\tasks\\todo\\TASK-001-x.md');
});

test('Scenario: POSIX folder joins use forward slashes', () => {
  // Given a base folder "/Users/steve/proj"
  const skill = tasksJoin('/Users/steve/proj', '.claude', 'skills', 'orchestrate', 'SKILL.md');
  // Then the result is the forward-slash skill path, and no backslash appears
  assert.equal(skill, '/Users/steve/proj/.claude/skills/orchestrate/SKILL.md');
  assert.ok(!skill.includes('\\'), 'no backslash in a POSIX join');
});

test('Scenario: base already ending in a separator adds none (edge)', () => {
  // Given a base folder "/Users/steve/proj/"; When tasksJoin appends "tasks"
  assert.equal(tasksJoin('/Users/steve/proj/', 'tasks'), '/Users/steve/proj/tasks',
    'no doubled separator when the base already ends in one');
  // And the Windows equivalent likewise adds no doubled backslash
  assert.equal(tasksJoin('C:\\proj\\', 'tasks'), 'C:\\proj\\tasks');
});

// ===========================================================================
// Feature: Platform-aware commands and locations
// ===========================================================================

test('Scenario: AWS CLI path on Windows is unchanged', () => {
  assert.equal(resolveAwsExe('win32'), 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe');
});

test('Scenario: AWS CLI on macOS comes from PATH', () => {
  assert.equal(resolveAwsExe('darwin'), 'aws');
});

test('Scenario: darwin PATH augmentation for GUI-launched apps', () => {
  // Given the platform is "darwin" and a minimal launchd PATH
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  // When the startup PATH fix runs
  augmentDarwinPath('darwin', env);
  // Then PATH contains both GUI-missing locations
  const parts = env.PATH.split(':');
  assert.ok(parts.includes('/usr/local/bin'), 'PATH contains /usr/local/bin');
  assert.ok(parts.includes('/opt/homebrew/bin'), 'PATH contains /opt/homebrew/bin');
});

test('Scenario: PATH not duplicated when already correct (edge)', () => {
  // Given PATH already contains "/opt/homebrew/bin"
  const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
  augmentDarwinPath('darwin', env);
  assert.equal(env.PATH.split(':').filter((p) => p === '/opt/homebrew/bin').length, 1,
    '/opt/homebrew/bin appears exactly once');
});

test('Scenario: no PATH mutation on Windows', () => {
  const env = { PATH: 'C:\\Windows\\System32;C:\\Windows' };
  augmentDarwinPath('win32', env);
  assert.equal(env.PATH, 'C:\\Windows\\System32;C:\\Windows', 'win32 PATH is unchanged');
});

test('Scenario: install helpers pick platform commands', () => {
  // The install-helper wiring lives inside DOM setup functions in renderer.js.
  // We (a) evaluate the REAL platform->download-page mapping headless, and
  // (b) pin the real source so the platform branch cannot silently regress.

  // (a) The git download page mapping (renderer.js): darwin -> mac, win32 -> win.
  const gitPage = (plat) => (plat === 'darwin' ? 'mac' : plat === 'win32' ? 'win' : 'linux');
  // Source-pin: the real expression exists so the replica stays faithful.
  assert.match(rendererSrc,
    /plat === 'darwin'\s*\?\s*'mac'\s*:\s*plat === 'win32'\s*\?\s*'win'\s*:\s*'linux'/,
    'renderer maps platform -> git download page');
  assert.match(rendererSrc, /git-scm\.com\/download\/'\s*\+\s*page/,
    'the download URL is built from the platform page');

  // Given the exposed platform is "darwin"
  // Then the git download URL targets the mac page
  assert.equal('https://git-scm.com/download/' + gitPage('darwin'),
    'https://git-scm.com/download/mac');
  // ...win32 still targets /download/win (no regression), linux -> /download/linux
  assert.equal(gitPage('win32'), 'win');
  assert.equal(gitPage('linux'), 'linux');

  // And on non-win32 the Claude install offers the curl script, not PowerShell.
  // Source-pin the isWin()-guarded branch and the two install commands.
  assert.match(rendererSrc, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/,
    'non-win32 Claude install uses the curl script');
  assert.match(rendererSrc, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/,
    'win32 Claude install keeps the PowerShell installer');
  assert.match(rendererSrc, /if \(isWin\(\)\)/,
    'the Claude/git install helpers branch on isWin()');
  // And winget is only wired on win32 (else the button is hidden).
  const wingetIdx = rendererSrc.indexOf('winget install --id Git.Git');
  assert.notEqual(wingetIdx, -1, 'winget command still present for win32');
  assert.match(rendererSrc, /gitInstallWingetBtn\.classList\.add\('hidden'\)/,
    'winget button hidden off win32 (no winget offered)');
});
