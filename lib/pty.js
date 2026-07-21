const nodePty = require('@lydell/node-pty');
const path = require('path');
const fs = require('fs');

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
];

function resolveGitBash() {
  for (const p of GIT_BASH_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Git Bash not found. Install Git for Windows.');
}

// Resolve the POSIX shell that backs a pane on macOS/Linux: prefer the user's
// login shell ($SHELL) and otherwise fall back to zsh on darwin, bash elsewhere.
// Never falls through to cmd.exe.
function resolvePosixShell(platform, env) {
  const fromEnv = ((env && env.SHELL) || '').trim();
  if (fromEnv) return fromEnv;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

// Matches `C:\path>` (or any drive letter) at end of buffer, after stripping ANSI escapes.
const CMD_PROMPT_REGEX = /[A-Za-z]:\\[^\r\n]*>\s*$/;
// Matches a bash prompt (…$ or …# for root) at end of buffer, after stripping ANSI escapes.
const BASH_PROMPT_REGEX = /[$#]\s*$/;
// POSIX login shells: zsh ends its prompt with `%`, bash/sh with `$`, root with `#`.
const POSIX_PROMPT_REGEX = /[%$#]\s*$/;
// CSI / OSC / generic ESC-X sequences emitted by ConPTY.
const ANSI_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CMD_AUTOLAUNCH_FALLBACK_MS = 1500;

// Autolaunch `command` into a freshly spawned pty once its prompt renders,
// with a fixed-delay fallback if prompt detection never matches (heavily
// themed prompts, ConPTY masking, etc.). The `launched` flag guarantees the
// command is written exactly once. `terminator` is the newline convention the
// target shell expects ('\r' for cmd.exe, '\n' for POSIX/bash shells).
function autolaunch(proc, command, terminator, promptRegex) {
  let launched = false;
  let buf = '';
  const launch = () => {
    if (launched) return;
    launched = true;
    try { proc.write(command + terminator); } catch (_) {}
  };

  proc.onData((data) => {
    if (launched) return;
    buf += data;
    if (buf.length > 4096) buf = buf.slice(-4096);
    const clean = buf.replace(ANSI_REGEX, '');
    if (promptRegex.test(clean)) {
      // 50 ms after the prompt renders so the shell is ready to accept input
      setTimeout(launch, 50);
    }
  });

  // Fallback: if the prompt is masked the shell still buffers stdin, so the
  // command executes once the prompt appears.
  setTimeout(launch, CMD_AUTOLAUNCH_FALLBACK_MS);
}

// Spawn the POSIX login shell backing a pane on non-win32 platforms.
function spawnPosix({ cwd, cols, rows }, platform, ptyBackend) {
  const shell = resolvePosixShell(platform, process.env);
  return ptyBackend.spawn(shell, ['-l', '-i'], {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });
}

function spawnCmd({ cwd, cols, rows, cliCommand }, platform, ptyBackend) {
  if (platform === 'win32') {
    const proc = ptyBackend.spawn('cmd.exe', [], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd,
      env: process.env
    });
    if (cliCommand) autolaunch(proc, cliCommand, '\r', CMD_PROMPT_REGEX);
    return proc;
  }

  const proc = spawnPosix({ cwd, cols, rows }, platform, ptyBackend);
  if (cliCommand) autolaunch(proc, cliCommand, '\n', POSIX_PROMPT_REGEX);
  return proc;
}

const WORKER_COMMANDS = {
  gemini: 'gemini',
  codex: 'codex'
};

function spawnWorker({ worker, cwd, cols, rows }, platform, ptyBackend) {
  const command = WORKER_COMMANDS[worker] || worker || 'gemini';

  if (platform === 'win32') {
    const proc = ptyBackend.spawn('cmd.exe', [], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd,
      env: process.env
    });
    autolaunch(proc, command, '\r', CMD_PROMPT_REGEX);
    return proc;
  }

  const proc = spawnPosix({ cwd, cols, rows }, platform, ptyBackend);
  autolaunch(proc, command, '\n', POSIX_PROMPT_REGEX);
  return proc;
}

function spawnBash({ cwd, cols, rows, cliCommand }, platform, ptyBackend) {
  if (platform === 'win32') {
    const bash = resolveGitBash();
    const proc = ptyBackend.spawn(bash, ['--login', '-i'], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        // MSYS-only hint: honour the launch cwd. Never set on POSIX platforms.
        CHERE_INVOKING: '1'
      }
    });
    if (cliCommand) autolaunch(proc, cliCommand, '\n', BASH_PROMPT_REGEX);
    return proc;
  }

  // On POSIX the "bash" pane is just the user's login shell — never probe the
  // Git-for-Windows candidate paths and never set CHERE_INVOKING.
  const proc = spawnPosix({ cwd, cols, rows }, platform, ptyBackend);
  if (cliCommand) autolaunch(proc, cliCommand, '\n', POSIX_PROMPT_REGEX);
  return proc;
}

// Platform and the pty backend are injectable so tests can exercise both
// platforms under `node --test` with no real PTY. Production callers pass no
// deps and get process.platform / @lydell/node-pty.
function spawnShell(opts, deps = {}) {
  const platform = deps.platform || process.platform;
  const ptyBackend = deps.pty || nodePty;
  const { shell } = opts;
  if (shell === 'cmd') return spawnCmd(opts, platform, ptyBackend);
  if (shell === 'bash') return spawnBash(opts, platform, ptyBackend);
  if (shell === 'worker') return spawnWorker(opts, platform, ptyBackend);
  throw new Error(`Unknown shell: ${shell}`);
}

module.exports = {
  spawnShell,
  __testing: {
    resolvePosixShell,
    resolveGitBash,
    CMD_PROMPT_REGEX,
    BASH_PROMPT_REGEX,
    POSIX_PROMPT_REGEX,
    ANSI_REGEX,
    CMD_AUTOLAUNCH_FALLBACK_MS
  }
};
