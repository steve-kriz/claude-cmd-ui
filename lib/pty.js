const pty = require('@lydell/node-pty');
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

// Matches `C:\path>` (or any drive letter) at end of buffer, after stripping ANSI escapes.
const CMD_PROMPT_REGEX = /[A-Za-z]:\\[^\r\n]*>\s*$/;
// CSI / OSC / generic ESC-X sequences emitted by ConPTY.
const ANSI_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CMD_AUTOLAUNCH_FALLBACK_MS = 1500;

function spawnCmd({ cwd, cols, rows, cliCommand }) {
  const proc = pty.spawn('cmd.exe', [], {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd,
    env: process.env
  });

  if (!cliCommand) return proc;

  let launched = false;
  let buf = '';
  const launch = () => {
    if (launched) return;
    launched = true;
    try { proc.write(cliCommand + '\r'); } catch (_) {}
  };

  proc.onData((data) => {
    if (launched) return;
    buf += data;
    if (buf.length > 4096) buf = buf.slice(-4096);
    const clean = buf.replace(ANSI_REGEX, '');
    if (CMD_PROMPT_REGEX.test(clean)) {
      // 50 ms after the prompt renders so cmd is ready to accept input
      setTimeout(launch, 50);
    }
  });

  // Fallback: if ConPTY masks the prompt, fire after a fixed delay anyway —
  // cmd buffers stdin, so the command still executes once the prompt appears.
  setTimeout(launch, CMD_AUTOLAUNCH_FALLBACK_MS);

  return proc;
}

const WORKER_COMMANDS = {
  gemini: 'gemini',
  codex: 'codex'
};

function spawnWorker({ worker, cwd, cols, rows }) {
  const command = WORKER_COMMANDS[worker] || worker || 'gemini';
  const proc = pty.spawn('cmd.exe', [], {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd,
    env: process.env
  });

  let launched = false;
  let buf = '';
  const launch = () => {
    if (launched) return;
    launched = true;
    try { proc.write(command + '\r'); } catch (_) {}
  };

  proc.onData((data) => {
    if (launched) return;
    buf += data;
    if (buf.length > 4096) buf = buf.slice(-4096);
    const clean = buf.replace(ANSI_REGEX, '');
    if (CMD_PROMPT_REGEX.test(clean)) {
      setTimeout(launch, 50);
    }
  });

  setTimeout(launch, CMD_AUTOLAUNCH_FALLBACK_MS);
  return proc;
}

function spawnBash({ cwd, cols, rows }) {
  const bash = resolveGitBash();
  const proc = pty.spawn(bash, ['--login', '-i'], {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      CHERE_INVOKING: '1'
    }
  });
  return proc;
}

function spawnShell({ shell, cwd, cols, rows, worker, cliCommand }) {
  if (shell === 'cmd') return spawnCmd({ cwd, cols, rows, cliCommand });
  if (shell === 'bash') return spawnBash({ cwd, cols, rows });
  if (shell === 'worker') return spawnWorker({ worker, cwd, cols, rows });
  throw new Error(`Unknown shell: ${shell}`);
}

module.exports = { spawnShell };
