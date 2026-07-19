# Terminals & PTY integration

## What it does and why

Each workspace tab embeds real terminals — a `cmd.exe` pane that auto-launches
the AI coding CLI (`claude`), and a Git Bash pane for ad-hoc shell work. They are
backed by genuine Windows ConPTY processes (via `@lydell/node-pty`) and rendered
with xterm.js, so they behave like normal terminals: colours, TUIs, resize,
copy/paste. A hidden "worker" shell can additionally run `gemini` or `codex`.

The point is to drive an interactive agent CLI from inside the app while keeping
a full shell one tab away.

## How it works

Spawning lives in [`lib/pty.js`](../lib/pty.js); the process registry and IPC
wiring live in [`main.js`](../main.js).

- **`spawnShell({ shell, cwd, cols, rows, worker, cliCommand })`** dispatches on
  `shell`:
  - `'cmd'` → `spawnCmd` spawns `cmd.exe` (`name: 'xterm-256color'`, default
    `120x30`).
  - `'bash'` → `spawnBash` resolves Git Bash from
    `C:\Program Files\Git\bin\bash.exe` (or the `(x86)` path) and spawns it
    `--login -i` with `TERM=xterm-256color` and `CHERE_INVOKING=1`.
  - `'worker'` → `spawnWorker` spawns `cmd.exe` and launches `gemini` or `codex`
    (from `WORKER_COMMANDS`).
  - Any other value throws `Unknown shell: <shell>`.
- **CLI auto-launch.** When `cliCommand` is supplied, the spawner watches the
  PTY output, strips ANSI with `ANSI_REGEX`, and once it detects the shell prompt
  (`CMD_PROMPT_REGEX` = `C:\…>` for cmd, `BASH_PROMPT_REGEX` = `…$`/`…#` for
  bash) it writes the command 50 ms later. A fixed fallback fires the command
  after `CMD_AUTOLAUNCH_FALLBACK_MS` (1500 ms) even if the prompt is masked,
  because the shell buffers stdin. The launch runs at most once (`launched`
  guard).
- **Process registry.** `main.js` keeps `ptys`, a `Map` of `id → pty`. `pty:spawn`
  kills any existing PTY with the same id, spawns a fresh one, and forwards
  `onData` → `pty:data` and `onExit` → `pty:exit` to the renderer. `pty:write`,
  `pty:resize`, `pty:kill` operate by id.
- **Status / idle detection (renderer).** In
  [`renderer/renderer.js`](../renderer/renderer.js) each tab tracks `idle` /
  `busy` / `waiting` / `finished`. Any output flips the tab to `busy`; `IDLE_MS`
  (2500 ms) after the last output the tab goes `finished` (or `waiting` if a TUI
  confirmation/menu is detected on screen by `isAwaitingTuiSelection`). This idle
  signal also gates prompt-queue auto-dispatch (see
  [`prompt-queue.md`](prompt-queue.md)).
- **`claude` detection.** `cli:checkClaude` runs `claude --version`, falling back
  to `where`/`which`; `cli:checkOpencode` does the same for `opencode`. When
  found, the renderer sets `cliCommand` on spawn so the CLI auto-launches; when
  missing, the pane shows an install banner.

## Usage

Terminals are created for you when you open a folder. The equivalent bridge calls
(see [`ipc-bridge.md`](ipc-bridge.md)):

```js
// cmd pane that auto-launches the claude CLI once the prompt appears
await window.api.pty.spawn({
  id: 'tab1-cmd', shell: 'cmd', cwd: 'C:/projects/my-app',
  cols: 120, rows: 30, cliCommand: 'claude'
});

// Git Bash pane
await window.api.pty.spawn({ id: 'tab1-bash', shell: 'bash', cwd: 'C:/projects/my-app' });

// worker pane running gemini
await window.api.pty.spawn({ id: 'tab1-worker', shell: 'worker', worker: 'gemini', cwd: 'C:/projects/my-app' });
```

Terminal clipboard shortcuts (renderer): paste `Ctrl+V` / `Shift+Insert`; copy
`Ctrl+Shift+C` / `Ctrl+Insert`; `Ctrl+C` copies a selection or sends SIGINT;
right-click copies-or-pastes.

## Configuration

- No env vars. Behaviour constants are in `lib/pty.js`:
  `CMD_AUTOLAUNCH_FALLBACK_MS = 1500`, default size `120x30`.
- Git Bash path candidates are hardcoded (`GIT_BASH_CANDIDATES`).
- `IDLE_MS = 2500` (renderer) governs the idle/finished transition.
- The `claude` / `opencode` choice is per-folder (`agent` field in
  `session.json`, see [`app-shell.md`](app-shell.md)).

## IPC / API reference

| Channel | `window.api` | Payload / result |
|---------|--------------|------------------|
| `pty:spawn` | `pty.spawn(opts)` | `{ id, shell, cwd, cols, rows, worker?, cliCommand? }` → `{ ok: true }` |
| `pty:write` | `pty.write(id, data)` | writes raw bytes to the PTY |
| `pty:resize` | `pty.resize(id, cols, rows)` | best-effort resize |
| `pty:kill` | `pty.kill(id)` | kills and forgets the PTY |
| `pty:data` (event) | `pty.onData(cb)` | `{ id, data }` output chunks |
| `pty:exit` (event) | `pty.onExit(cb)` | `{ id, exitCode }` |
| `cli:checkClaude` | `cli.checkClaude()` | `{ ok, installed, version?, path?, error? }` |
| `cli:checkOpencode` | `cli.checkOpencode()` | same shape as `checkClaude` |

## Edge cases, limitations & troubleshooting

- **Git Bash missing** → `resolveGitBash()` throws
  "Git Bash not found. Install Git for Windows." Install Git for Windows to fix.
- **Prompt masked by a TUI** — the fixed 1500 ms fallback still fires the CLI
  command because the shell buffers stdin.
- **Re-spawning an id** kills the old PTY first, so a tab can safely re-create
  its terminal.
- **`claude` not on PATH** — `cli:checkClaude` reports `installed: false`; the
  pane offers install options (npm / PowerShell installer) instead of
  auto-launching.
- **Worker shell** defaults to `gemini` if `worker` is unset/unknown.
