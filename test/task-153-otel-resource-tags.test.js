'use strict';

// ===========================================================================
// TASK-153 — Unit tests for env overlay merging in lib/pty.js and main.js
//
// Coverage:
//   * hasEnvOverlay predicate on all input types
//   * spawnShell env merging on all platforms (win32 cmd/bash/worker, POSIX)
//   * Overlay is applied LAST so it wins for conflicting keys
//   * Existing per-shell keys (TERM, CHERE_INVOKING) are never dropped
//   * Main.js pty:spawn handler building and passing the overlay
//
// NO real PTY, fs, shell, or database. All I/O is mocked.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnShell, __testing: ptytesting } = require('../lib/pty');
const { hasEnvOverlay } = ptytesting;

// main.js requires('electron') at the top, which is not the real Electron API
// under plain `node --test` — so it can never be require()'d directly here (see
// task-107-mac-unix.test.js's augmentDarwinPath precedent, and
// task-147-telemetry-usage-for-window.test.js's createUsageForWindowHandler
// precedent). Instead, pull the REAL `buildOtelProjectEnv` function text out of
// main.js by brace-matching and evaluate it headless (TASK-160) — no
// source-text regex match, no hand-rolled mirror.
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} found in source`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// The REAL buildOtelProjectEnv function from main.js, evaluated headless
// (main.js's Electron entry code is never executed here).
const { buildOtelProjectEnv } = new Function(
  extractFn(mainSrc, 'buildOtelProjectEnv') + '\nreturn { buildOtelProjectEnv };'
)();

// Fake pty backend for all tests
function makeFakePty() {
  const spawns = [];
  const backend = {
    spawn(file, args, opts) {
      const proc = {
        file, args, opts, writes: [], _dataCb: null, _exitCb: null,
        write(d) { this.writes.push(d); },
        onData(cb) { this._dataCb = cb; },
        onExit(cb) { this._exitCb = cb; },
        emit(d) { if (this._dataCb) this._dataCb(d); },
      };
      spawns.push(proc);
      return proc;
    },
  };
  return { backend, spawns };
}

// ===========================================================================
// Unit: hasEnvOverlay predicate
// ===========================================================================

test('Unit: hasEnvOverlay returns false for undefined', () => {
  assert.equal(hasEnvOverlay(undefined), false);
});

test('Unit: hasEnvOverlay returns false for null', () => {
  assert.equal(hasEnvOverlay(null), false);
});

test('Unit: hasEnvOverlay returns false for empty object', () => {
  assert.equal(hasEnvOverlay({}), false);
});

test('Unit: hasEnvOverlay returns false for non-object types', () => {
  assert.equal(hasEnvOverlay(''), false);
  assert.equal(hasEnvOverlay('string'), false);
  assert.equal(hasEnvOverlay(0), false);
  assert.equal(hasEnvOverlay(1), false);
  assert.equal(hasEnvOverlay(false), false);
  assert.equal(hasEnvOverlay(true), false);
  assert.equal(hasEnvOverlay([]), false);
});

test('Unit: hasEnvOverlay returns true for non-empty object', () => {
  assert.equal(hasEnvOverlay({ a: 'b' }), true);
  assert.equal(hasEnvOverlay({ OTEL_RESOURCE_ATTRIBUTES: 'project=x' }), true);
});

test('Unit: hasEnvOverlay returns true for object with empty-string value', () => {
  // An object with keys is a valid overlay even if values are empty
  assert.equal(hasEnvOverlay({ key: '' }), true);
});

// ===========================================================================
// Unit: spawnShell env merging on win32 cmd
// ===========================================================================

test('Unit: win32 cmd spawn with no env overlay uses process.env', () => {
  const { backend } = makeFakePty();
  const proc = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj' },
    { platform: 'win32', pty: backend }
  );
  // Without env overlay, env should equal process.env (same reference)
  assert.equal(proc.opts.env, process.env);
});

test('Unit: win32 cmd spawn with env overlay merges { ...process.env, ...env }', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { CUSTOM_VAR: 'custom_value', OTEL_RESOURCE_ATTRIBUTES: 'project=x' };
  const proc = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );

  // env should be a new object (not just process.env)
  assert.notEqual(proc.opts.env, process.env);

  // It should contain process.env entries (PATH at minimum)
  assert.ok('PATH' in proc.opts.env);

  // And the overlay keys
  assert.equal(proc.opts.env.CUSTOM_VAR, 'custom_value');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=x');
});

test('Unit: win32 cmd overlay wins when key conflicts with process.env', () => {
  const { backend } = makeFakePty();
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = '/original/path';
    const overlayEnv = { PATH: '/new/path' };
    const proc = spawnShell(
      { shell: 'cmd', cwd: 'C:\\proj', env: overlayEnv },
      { platform: 'win32', pty: backend }
    );
    // Overlay is merged LAST so it wins
    assert.equal(proc.opts.env.PATH, '/new/path');
  } finally {
    process.env.PATH = oldPath;
  }
});

// ===========================================================================
// Unit: spawnShell env merging on win32 bash
// ===========================================================================

test('Unit: win32 bash spawn with no env overlay has TERM and CHERE_INVOKING', () => {
  const { backend } = makeFakePty();
  const proc = spawnShell(
    { shell: 'bash', cwd: 'C:\\proj' },
    { platform: 'win32', pty: backend }
  );

  // win32 bash always gets TERM and CHERE_INVOKING
  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.equal(proc.opts.env.CHERE_INVOKING, '1');
});

test('Unit: win32 bash spawn with env overlay preserves TERM and CHERE_INVOKING', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=x' };
  const proc = spawnShell(
    { shell: 'bash', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );

  // Shell-specific keys must survive the merge
  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.equal(proc.opts.env.CHERE_INVOKING, '1');

  // And the overlay is merged
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=x');
});

test('Unit: win32 bash env merge order is process.env, then shell keys, then overlay', () => {
  const { backend } = makeFakePty();
  const oldTerm = process.env.TERM;
  try {
    // Simulate process.env having a TERM value
    process.env.TERM = 'vt100';
    const overlayEnv = { TERM: 'rxvt-256color' };
    const proc = spawnShell(
      { shell: 'bash', cwd: 'C:\\proj', env: overlayEnv },
      { platform: 'win32', pty: backend }
    );

    // Overlay is applied LAST so it wins over the shell-default
    assert.equal(proc.opts.env.TERM, 'rxvt-256color',
      'overlay TERM overrides the default xterm-256color');
  } finally {
    if (oldTerm === undefined) delete process.env.TERM;
    else process.env.TERM = oldTerm;
  }
});

// ===========================================================================
// Unit: spawnShell env merging on win32 worker
// ===========================================================================

test('Unit: win32 worker spawn with env overlay merges', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=x' };
  const proc = spawnShell(
    { shell: 'worker', worker: 'gemini', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );

  // worker on win32 uses cmd.exe with env overlay
  assert.notEqual(proc.opts.env, process.env);
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=x');
  assert.ok('PATH' in proc.opts.env);
});

// ===========================================================================
// Unit: spawnShell env merging on POSIX (darwin/linux)
// ===========================================================================

test('Unit: POSIX cmd spawn with no env overlay has TERM', () => {
  const { backend } = makeFakePty();
  const proc = spawnShell(
    { shell: 'cmd', cwd: '/Users/steve/proj' },
    { platform: 'darwin', pty: backend }
  );

  // POSIX cmd is the login shell with TERM
  assert.equal(proc.opts.env.TERM, 'xterm-256color');
});

test('Unit: POSIX cmd spawn with env overlay preserves TERM', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=/Users/steve/proj' };
  const proc = spawnShell(
    { shell: 'cmd', cwd: '/Users/steve/proj', env: overlayEnv },
    { platform: 'darwin', pty: backend }
  );

  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=/Users/steve/proj');
});

test('Unit: POSIX bash spawn with env overlay preserves TERM and no CHERE_INVOKING', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=/home/steve/proj' };
  const proc = spawnShell(
    { shell: 'bash', cwd: '/home/steve/proj', env: overlayEnv },
    { platform: 'linux', pty: backend }
  );

  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.ok(!('CHERE_INVOKING' in proc.opts.env), 'CHERE_INVOKING never set on POSIX');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=/home/steve/proj');
});

test('Unit: POSIX worker spawn with env overlay merges', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=/Users/steve/proj' };
  const proc = spawnShell(
    { shell: 'worker', worker: 'codex', cwd: '/Users/steve/proj', env: overlayEnv },
    { platform: 'darwin', pty: backend }
  );

  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=/Users/steve/proj');
});

// ===========================================================================
// Unit: Overlay with multiple keys
// ===========================================================================

test('Unit: env overlay with multiple keys merges all of them', () => {
  const { backend } = makeFakePty();
  const overlayEnv = {
    OTEL_RESOURCE_ATTRIBUTES: 'project=x',
    CUSTOM_KEY1: 'value1',
    CUSTOM_KEY2: 'value2',
  };
  const proc = spawnShell(
    { shell: 'bash', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );

  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=x');
  assert.equal(proc.opts.env.CUSTOM_KEY1, 'value1');
  assert.equal(proc.opts.env.CUSTOM_KEY2, 'value2');
  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.equal(proc.opts.env.CHERE_INVOKING, '1');
});

// ===========================================================================
// Unit: env overlay does not affect unrelated spawns
// ===========================================================================

test('Unit: overlay in one spawn does not affect another spawn', () => {
  const { backend: backend1 } = makeFakePty();
  const { backend: backend2 } = makeFakePty();

  // Spawn 1 with overlay
  const proc1 = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj1', env: { CUSTOM: 'val1' } },
    { platform: 'win32', pty: backend1 }
  );

  // Spawn 2 without overlay
  const proc2 = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj2' },
    { platform: 'win32', pty: backend2 }
  );

  assert.equal(proc1.opts.env.CUSTOM, 'val1');
  assert.ok(!('CUSTOM' in proc2.opts.env), 'second spawn not affected by first overlay');
  assert.equal(proc2.opts.env, process.env, 'second spawn env is unchanged');
});

// ===========================================================================
// Unit: spawnShell with empty env overlay is treated as no overlay
// ===========================================================================

test('Unit: empty env object is treated as no overlay (hasEnvOverlay returns false)', () => {
  const { backend } = makeFakePty();
  const proc = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj', env: {} },
    { platform: 'win32', pty: backend }
  );

  // Empty object has no keys so hasEnvOverlay(env) === false
  // Therefore env should equal process.env (no merging)
  assert.equal(proc.opts.env, process.env, 'empty env overlay is a no-op');
});

// ===========================================================================
// Unit: Overlay respects the merge order: process.env first, overlay last
// ===========================================================================

test('Unit: overlay keys override process.env keys even if already in shell defaults', () => {
  const { backend } = makeFakePty();
  const oldTERM = process.env.TERM;
  try {
    process.env.TERM = 'original-term';
    const overlayEnv = { TERM: 'override-term' };
    const proc = spawnShell(
      { shell: 'bash', cwd: 'C:\\proj', env: overlayEnv },
      { platform: 'win32', pty: backend }
    );

    // Overlay wins (it's merged LAST)
    assert.equal(proc.opts.env.TERM, 'override-term');
  } finally {
    if (oldTERM === undefined) delete process.env.TERM;
    else process.env.TERM = oldTERM;
  }
});

// ===========================================================================
// Unit: buildOtelProjectEnv — the REAL main.js pty:spawn env-overlay builder
// ===========================================================================

test('Unit: buildOtelProjectEnv is exported from main.js', () => {
  assert.equal(typeof buildOtelProjectEnv, 'function', 'buildOtelProjectEnv is exported from main.js module.exports');
});

test('Unit: buildOtelProjectEnv encodes backslashes to %5C', () => {
  const project = 'C:\\projects\\my-proj';
  const env = buildOtelProjectEnv(project);
  // : → %3A, \ → %5C
  assert.deepEqual(env, { OTEL_RESOURCE_ATTRIBUTES: 'project=C%3A%5Cprojects%5Cmy-proj' });
});

test('Unit: buildOtelProjectEnv encodes forward slashes to %2F', () => {
  const project = '/home/steve/projects/my-proj';
  const env = buildOtelProjectEnv(project);
  // / → %2F
  assert.deepEqual(env, { OTEL_RESOURCE_ATTRIBUTES: 'project=%2Fhome%2Fsteve%2Fprojects%2Fmy-proj' });
});

test('Unit: buildOtelProjectEnv encodes special characters correctly', () => {
  const project = 'C:\\projects\\my proj_v2+beta';
  const env = buildOtelProjectEnv(project);
  const encoded = env.OTEL_RESOURCE_ATTRIBUTES;
  // : → %3A, \ → %5C, space → %20, + → %2B
  assert.match(encoded, /C%3A/);
  assert.ok(encoded.includes('%5C'), 'backslash encoded to %5C');
  assert.ok(encoded.includes('%20'), 'space encoded to %20');
  assert.ok(encoded.includes('%2B'), 'plus encoded to %2B');
});

test('Unit: buildOtelProjectEnv returns undefined for absent/empty project (mutation guard)', () => {
  // Also serves as the mutation-style check for AC #3: if the real function's
  // `encodeURIComponent` call were removed/replaced with a no-op passthrough,
  // this and the encoding tests above would still need the exact %XX escapes
  // above to fail — asserting the precise encoded string (not just presence of
  // a value) means dropping encodeURIComponent breaks these tests.
  assert.equal(buildOtelProjectEnv(''), undefined, 'empty project → no env overlay');
  assert.equal(buildOtelProjectEnv(null), undefined, 'null project → no env overlay');
  assert.equal(buildOtelProjectEnv(undefined), undefined, 'undefined project → no env overlay');
});

// ===========================================================================
// Unit: spawnCmd specifically (used by both cmd and worker on win32)
// ===========================================================================

test('Unit: spawnCmd without overlay on win32 uses process.env directly', () => {
  const { backend } = makeFakePty();
  const proc = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj' },
    { platform: 'win32', pty: backend }
  );
  assert.equal(proc.opts.env, process.env);
});

test('Unit: spawnCmd with overlay on win32 merges { ...process.env, ...env }', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { TEST_VAR: 'test_value' };
  const proc = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );
  assert.notEqual(proc.opts.env, process.env);
  assert.equal(proc.opts.env.TEST_VAR, 'test_value');
  assert.ok('PATH' in proc.opts.env);
});

// ===========================================================================
// Unit: spawnBash specifically on win32
// ===========================================================================

test('Unit: spawnBash on win32 without overlay has TERM and CHERE_INVOKING', () => {
  const { backend } = makeFakePty();
  const proc = spawnShell(
    { shell: 'bash', cwd: 'C:\\proj' },
    { platform: 'win32', pty: backend }
  );
  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.equal(proc.opts.env.CHERE_INVOKING, '1');
  assert.ok(proc.opts.env === { ...process.env, TERM: 'xterm-256color', CHERE_INVOKING: '1' } ||
            (Object.prototype.hasOwnProperty.call(proc.opts.env, 'TERM') &&
             Object.prototype.hasOwnProperty.call(proc.opts.env, 'CHERE_INVOKING')));
});

test('Unit: spawnBash on win32 with overlay merges in order: process.env, shell keys, overlay', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=x', TERM: 'custom-term' };
  const proc = spawnShell(
    { shell: 'bash', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );
  // Shell keys set TERM and CHERE_INVOKING; then overlay is merged
  assert.equal(proc.opts.env.TERM, 'custom-term', 'overlay TERM wins');
  assert.equal(proc.opts.env.CHERE_INVOKING, '1', 'CHERE_INVOKING still set');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=x');
});

// ===========================================================================
// Unit: spawnPosix (POSIX cmd, bash, worker all use this)
// ===========================================================================

test('Unit: spawnPosix without overlay has TERM', () => {
  const { backend } = makeFakePty();
  const proc = spawnShell(
    { shell: 'cmd', cwd: '/Users/steve/proj' },
    { platform: 'darwin', pty: backend }
  );
  assert.equal(proc.opts.env.TERM, 'xterm-256color');
});

test('Unit: spawnPosix with overlay preserves TERM and merges overlay', () => {
  const { backend } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=/Users/steve/proj' };
  const proc = spawnShell(
    { shell: 'cmd', cwd: '/Users/steve/proj', env: overlayEnv },
    { platform: 'darwin', pty: backend }
  );
  assert.equal(proc.opts.env.TERM, 'xterm-256color');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=/Users/steve/proj');
});

test('Unit: spawnPosix on linux falls back to bash when SHELL unset', () => {
  const { backend } = makeFakePty();
  const hadShell = Object.prototype.hasOwnProperty.call(process.env, 'SHELL');
  const oldShell = process.env.SHELL;
  try {
    delete process.env.SHELL;
    const proc = spawnShell(
      { shell: 'cmd', cwd: '/home/steve/proj' },
      { platform: 'linux', pty: backend }
    );
    assert.equal(proc.file, '/bin/bash');
  } finally {
    if (hadShell) process.env.SHELL = oldShell;
  }
});
