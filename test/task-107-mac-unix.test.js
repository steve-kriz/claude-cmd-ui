'use strict';

// ===========================================================================
// TASK-107 — UNIT tests for cross-platform (mac/unix) support.
//
// Covers the pure, injectable units introduced by the ticket:
//   - lib/pty.js  resolvePosixShell($SHELL / darwin-zsh / linux-bash matrix)
//   - lib/pty.js  prompt regexes (POSIX %/$/#, CMD drive-prompt, bash $/#) after
//     ANSI stripping
//   - lib/aws.js  resolveAwsExe(platform) win32 fixed path vs `aws` on PATH
//   - main.js     augmentDarwinPath idempotence / no-op off darwin (the pure
//     function is EXTRACTED from source — main.js's Electron entry code is never
//     executed here, per the ticket note)
//   - renderer.js inferSep separator-inference rule incl. mixed-separator edge
//     (EXTRACTED from the browser renderer source and evaluated headless)
//
// No real PTY, shell, binary, filesystem probe, or Electron is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

const { __testing: pty } = require('../lib/pty');
const { __testing: aws } = require('../lib/aws');

const {
  resolvePosixShell,
  CMD_PROMPT_REGEX,
  BASH_PROMPT_REGEX,
  POSIX_PROMPT_REGEX,
  ANSI_REGEX,
  CMD_AUTOLAUNCH_FALLBACK_MS,
} = pty;
const { resolveAwsExe } = aws;

// --- Extract a named `function foo(...) { ... }` by brace-matching so the REAL
// source (not a replica) is evaluated headless. Matches the repo convention. ---
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

const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// The REAL augmentDarwinPath pulled out of main.js (Electron entry code stays inert).
const augmentDarwinPath = new Function(
  extractFn(mainSrc, 'augmentDarwinPath') + '\nreturn augmentDarwinPath;'
)();

// The REAL renderer separator helpers evaluated headless.
const { inferSep } = new Function(
  [extractFn(rendererSrc, 'inferSep'), 'return { inferSep };'].join('\n')
)();

// Strip ANSI the exact way lib/pty.js's autolaunch does before prompt matching.
function strip(s) { return s.replace(ANSI_REGEX, ''); }

// ---------------------------------------------------------------------------
// resolvePosixShell matrix
// ---------------------------------------------------------------------------
test('UNIT: resolvePosixShell prefers $SHELL when set (any platform)', () => {
  assert.equal(resolvePosixShell('darwin', { SHELL: '/bin/fish' }), '/bin/fish');
  assert.equal(resolvePosixShell('linux', { SHELL: '/usr/bin/zsh' }), '/usr/bin/zsh');
});

test('UNIT: resolvePosixShell trims whitespace around $SHELL', () => {
  assert.equal(resolvePosixShell('darwin', { SHELL: '  /bin/zsh  ' }), '/bin/zsh');
});

test('UNIT: resolvePosixShell falls back to /bin/zsh on darwin without $SHELL', () => {
  assert.equal(resolvePosixShell('darwin', {}), '/bin/zsh');
  assert.equal(resolvePosixShell('darwin', { SHELL: '' }), '/bin/zsh');
  assert.equal(resolvePosixShell('darwin', { SHELL: '   ' }), '/bin/zsh');
  assert.equal(resolvePosixShell('darwin', undefined), '/bin/zsh');
});

test('UNIT: resolvePosixShell falls back to /bin/bash on linux without $SHELL', () => {
  assert.equal(resolvePosixShell('linux', {}), '/bin/bash');
  assert.equal(resolvePosixShell('linux', { SHELL: '' }), '/bin/bash');
});

test('UNIT: resolvePosixShell never returns cmd.exe and defaults to /bin/bash for non-darwin', () => {
  // win32 is never routed here in production, but the resolver must still yield a
  // POSIX shell (never cmd.exe) — proving no accidental cmd fallthrough.
  assert.equal(resolvePosixShell('win32', {}), '/bin/bash');
});

// ---------------------------------------------------------------------------
// resolveAwsExe
// ---------------------------------------------------------------------------
test('UNIT: resolveAwsExe is the fixed Program Files path on win32', () => {
  assert.equal(resolveAwsExe('win32'), 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe');
});

test('UNIT: resolveAwsExe is bare `aws` (from PATH) on darwin and linux', () => {
  assert.equal(resolveAwsExe('darwin'), 'aws');
  assert.equal(resolveAwsExe('linux'), 'aws');
});

// ---------------------------------------------------------------------------
// Prompt regexes (after ANSI stripping)
// ---------------------------------------------------------------------------
test('UNIT: POSIX_PROMPT_REGEX accepts zsh %, bash $, and root # endings', () => {
  assert.ok(POSIX_PROMPT_REGEX.test('steve@mac proj % '), 'zsh % prompt');
  assert.ok(POSIX_PROMPT_REGEX.test('steve@box:~/proj$ '), 'bash $ prompt');
  assert.ok(POSIX_PROMPT_REGEX.test('root@box:/# '), 'root # prompt');
  assert.ok(POSIX_PROMPT_REGEX.test('%'), 'bare %');
});

test('UNIT: POSIX_PROMPT_REGEX rejects non-prompt output', () => {
  assert.ok(!POSIX_PROMPT_REGEX.test('installing packages...'), 'plain text is not a prompt');
  assert.ok(!POSIX_PROMPT_REGEX.test('done > output.log'), 'a > is not a POSIX prompt end');
});

test('UNIT: POSIX_PROMPT_REGEX matches a zsh prompt after ANSI escapes are stripped', () => {
  const raw = '\x1b[32msteve@mac\x1b[0m \x1b[34mproj\x1b[0m % ';
  assert.ok(POSIX_PROMPT_REGEX.test(strip(raw)), 'ANSI-coloured zsh prompt matches once cleaned');
});

test('UNIT: CMD_PROMPT_REGEX matches a Windows drive prompt and rejects POSIX prompts', () => {
  assert.ok(CMD_PROMPT_REGEX.test('C:\\proj>'), 'C:\\proj> is a cmd prompt');
  assert.ok(CMD_PROMPT_REGEX.test('D:\\a\\b\\c> '), 'trailing space tolerated');
  assert.ok(!CMD_PROMPT_REGEX.test('steve@mac %'), 'zsh prompt is not a cmd prompt');
});

test('UNIT: BASH_PROMPT_REGEX (git-bash pane on win32) matches $ and # endings', () => {
  assert.ok(BASH_PROMPT_REGEX.test('user@host MINGW64 ~/proj$ '), 'MSYS bash $ prompt');
  assert.ok(BASH_PROMPT_REGEX.test('#'), 'root #');
  assert.ok(!BASH_PROMPT_REGEX.test('nothing here'), 'plain text rejected');
});

test('UNIT: CMD_AUTOLAUNCH_FALLBACK_MS is the documented 1500 ms', () => {
  assert.equal(CMD_AUTOLAUNCH_FALLBACK_MS, 1500);
});

// ---------------------------------------------------------------------------
// augmentDarwinPath idempotence / no-op off darwin
// ---------------------------------------------------------------------------
test('UNIT: augmentDarwinPath appends both GUI-missing dirs on darwin when absent', () => {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  augmentDarwinPath('darwin', env);
  const parts = env.PATH.split(':');
  assert.ok(parts.includes('/usr/local/bin'), 'adds /usr/local/bin');
  assert.ok(parts.includes('/opt/homebrew/bin'), 'adds /opt/homebrew/bin');
});

test('UNIT: augmentDarwinPath is idempotent — a second call does not grow PATH', () => {
  const env = { PATH: '/usr/bin:/bin' };
  augmentDarwinPath('darwin', env);
  const after1 = env.PATH;
  augmentDarwinPath('darwin', env);
  assert.equal(env.PATH, after1, 'PATH unchanged on the second call');
  assert.equal(env.PATH.split(':').filter((p) => p === '/opt/homebrew/bin').length, 1,
    '/opt/homebrew/bin appears exactly once');
});

test('UNIT: augmentDarwinPath does not duplicate a dir already present', () => {
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin' };
  augmentDarwinPath('darwin', env);
  assert.equal(env.PATH.split(':').filter((p) => p === '/opt/homebrew/bin').length, 1,
    'pre-existing /opt/homebrew/bin stays single');
  assert.ok(env.PATH.split(':').includes('/usr/local/bin'), 'still adds the missing /usr/local/bin');
});

test('UNIT: augmentDarwinPath is a no-op on win32 and linux', () => {
  const win = { PATH: 'C:\\Windows\\System32' };
  augmentDarwinPath('win32', win);
  assert.equal(win.PATH, 'C:\\Windows\\System32', 'win32 PATH untouched');

  const linux = { PATH: '/usr/bin:/bin' };
  augmentDarwinPath('linux', linux);
  assert.equal(linux.PATH, '/usr/bin:/bin', 'linux PATH untouched');
});

// ---------------------------------------------------------------------------
// renderer inferSep rule (incl. mixed-separator edge)
// ---------------------------------------------------------------------------
test('UNIT: inferSep returns backslash ONLY for a pure Windows path', () => {
  assert.equal(inferSep('C:\\proj'), '\\', 'backslash present, no forward slash');
  assert.equal(inferSep('C:\\a\\b\\c'), '\\', 'multi-segment windows path');
});

test('UNIT: inferSep returns forward slash for POSIX paths', () => {
  assert.equal(inferSep('/Users/steve/proj'), '/');
  assert.equal(inferSep('relative/dir'), '/');
});

test('UNIT: inferSep returns forward slash for a MIXED-separator base (edge)', () => {
  // Rule: backslash ONLY when the string has \ AND no / — a mixed path yields '/'.
  assert.equal(inferSep('C:\\a/b'), '/', 'mixed base falls back to forward slash');
  assert.equal(inferSep('C:/proj'), '/', 'windows drive with forward slashes -> /');
});

test('UNIT: inferSep on a separator-less base defaults to forward slash', () => {
  assert.equal(inferSep('proj'), '/');
});
