# Electron app shell & windowing

## What it does and why

Claude CMD UI is a single-window Electron desktop app. The "app shell" is the
main (Node) process that owns the application lifecycle, creates the one
`BrowserWindow`, wires the secure preload bridge, restores the set of open
project folders, and cleans up child processes on shutdown. Everything else in
the app (terminals, Git, Slack, the Tasks board) hangs off this shell.

It exists so the privileged work (spawning processes, touching the filesystem,
calling CLIs) runs in the main process behind a locked-down IPC surface, while
the UI runs in a sandboxed renderer with `contextIsolation` on and
`nodeIntegration` off.

## How it works

Key components, all in [`main.js`](../main.js):

- **Window creation** — `createWindow()` builds a `1400x860` `BrowserWindow`
  titled `Claude CMD UI`, background `#1e1e1e`, and loads
  [`renderer/index.html`](../renderer/index.html). `webPreferences` sets
  `preload: preload.js`, `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: false`. The native menu is removed (`removeMenu()`).
- **App lifecycle** — `app.whenReady()` loads `.env` into `process.env`
  (`envStore.loadIntoProcessEnv()`), points the AWS module at Electron's
  userData dir, sets `sessionFilePath = <userData>/session.json`, then opens the
  window. `window-all-closed` quits the app (except on macOS), and `will-quit`
  releases the keep-awake wake-lock.
- **Session persistence** — `readSession()` / `writeSession()` read and write
  `<userData>/session.json`, an object `{ folders: [...] }`. Each folder entry is
  normalized by `normalizeFolderEntry()` to `{ path, agent }` where `agent` is
  `'claude'` or `'opencode'`; a legacy bare-string entry is upgraded to
  `{ path, agent: 'claude' }`. Writes are atomic (write to `.tmp`, then rename).
- **Crash / hang resilience** — the window's `webContents` listens for
  `render-process-gone` and `unresponsive` and calls `updateKeepAwake(0)` to
  release the wake-lock; `preload-error` and `console-message` are logged to the
  main-process console.
- **DevTools** — opened detached on launch unless `OPEN_DEVTOOLS=0`. Global
  shortcuts `Control+Shift+I` and `F12` toggle DevTools
  (`globalShortcut_register`).
- **Teardown** — on window `closed`, every tracked PTY in the `ptys` map is
  killed, the map is cleared, and `stopKeepAwake()` runs.

The renderer renders multiple "workspace tabs" (one per open folder) inside a
single window; the tab model lives in the renderer, while the main process only
tracks the open-folder list (for `session.json`) and the PTYs keyed by id.

## Usage

Launch the shell:

```bash
npm install
npm run start
```

Suppress the auto-opened DevTools:

```bash
# PowerShell
$env:OPEN_DEVTOOLS = "0"; npm run start
```

```bash
# Git Bash / POSIX
OPEN_DEVTOOLS=0 npm run start
```

On first launch the window shows an empty state; open a folder from the UI and
it is added to `session.json` and restored next launch.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPEN_DEVTOOLS` | (unset → DevTools open) | Set to `0` to stop DevTools opening on launch |

Other environment/config lives in [`configuration.md`](configuration.md). The
open-folder list is stored in `<userData>/session.json` (Electron's per-user
app-data directory), not an env var.

## IPC reference (shell-level channels)

Handled in `main.js`, exposed on `window.api` via [`preload.js`](../preload.js):

| Channel | `window.api` | Returns |
|---------|--------------|---------|
| `dialog:pickFolder` | `api.pickFolder()` | `{ path }` or `null` if cancelled |
| `window:setTitle` | `api.setTitle(title)` | sets the window title (falls back to `Claude CMD UI`) |
| `session:load` | `api.session.load()` | `{ folders: [{ path, agent }] }` |
| `session:save` | `api.session.save(folders)` | `{ ok }` |

See [`ipc-bridge.md`](ipc-bridge.md) for the full channel catalogue.

## Edge cases, limitations & troubleshooting

- **Cross-platform.** On Windows the panes shell out to `cmd.exe` + Git Bash and
  the AWS CLI at a fixed Windows path; on macOS/Linux both panes are the user's
  login shell and `git`/`aws` resolve from `PATH` (Linux is best-effort). The
  Electron lifecycle already guards for `darwin`, and a Finder-launch `PATH` fix
  runs at startup. See [`cross-platform.md`](cross-platform.md).
- **Corrupt `session.json`** is tolerated: `readSession()` catches parse errors
  and returns `{ folders: [] }` (empty state) rather than crashing.
- **A single window only.** `activate` recreates the window if none exist
  (macOS convention), but the app is designed around one window.
- **Renderer crash leaves no dangling wake-lock** — the `render-process-gone` /
  `unresponsive` handlers release it; the next live render re-engages it. See
  [`keep-awake.md`](keep-awake.md).
