# Cross-platform (macOS / Linux) shell support

## What it does and why

The app was originally Windows-only: it spawned `cmd.exe`, hunted for Git Bash at
`C:\Program Files\Git\bin\bash.exe`, and invoked the AWS CLI from a hardcoded
`C:\Program Files\…\aws.exe`. This feature makes the terminal/PTY layer and the
external-CLI lookups **platform-aware** so panes and integrations work on macOS
and Linux too, while remaining byte-identical on Windows.

## How it works

### PTY spawning — `lib/pty.js`

The pane spawners are refactored to branch on platform, with both the platform
and the PTY backend **injectable** so tests can exercise both platforms under
`node --test` with no real PTY:

```js
spawnShell(opts, deps = {})
// deps.platform  → defaults to process.platform
// deps.pty       → defaults to @lydell/node-pty
```

- **`resolvePosixShell(platform, env)`** — picks the POSIX login shell: the user's
  `$SHELL` if set, else `/bin/zsh` on `darwin`, `/bin/bash` elsewhere. It never
  falls through to `cmd.exe`.
- **`spawnPosix(...)`** — spawns that shell with `['-l', '-i']` (login,
  interactive) and `TERM=xterm-256color`.
- **`spawnCmd` / `spawnBash` / `spawnWorker`** each branch:
  - **win32** keeps the exact prior behaviour — `cmd.exe`, or Git Bash via
    `resolveGitBash()` with `--login -i` and `CHERE_INVOKING=1` (an MSYS-only hint,
    never set on POSIX).
  - **non-win32** routes to `spawnPosix` — the "bash" pane is simply the user's
    login shell (it never probes Git-for-Windows paths and never sets
    `CHERE_INVOKING`).

**CLI auto-launch** is unified into one `autolaunch(proc, command, terminator,
promptRegex)` helper. It writes the command exactly once — as soon as the shell's
prompt renders (50 ms after a match) or after a fixed fallback delay
(`CMD_AUTOLAUNCH_FALLBACK_MS = 1500`) if the prompt is masked. The line terminator
is `'\r'` for `cmd.exe` and `'\n'` for POSIX/bash. Prompt detection uses
`CMD_PROMPT_REGEX` (`C:\…>`), `BASH_PROMPT_REGEX` (`…$` / `…#`), or the new
`POSIX_PROMPT_REGEX` (`…%` for zsh, `…$`, `…#` for root), after stripping ANSI.

Internals are exported under `__testing` (`resolvePosixShell`, `resolveGitBash`,
the regexes, and the fallback constant).

### AWS CLI lookup — `lib/aws.js`

`resolveAwsExe(platform)` returns the fixed Windows install path
(`C:\Program Files\Amazon\AWSCLIV2\aws.exe`) on `win32` and plain `aws` (from
`PATH`, where Homebrew/pkg installs put it) everywhere else. `AWS_EXE` is derived
from it, and it is exported under `__testing`.

### macOS GUI PATH fix — `main.js`

`augmentDarwinPath(platform, env)` (called in `app.whenReady`) fixes a macOS
gotcha: a **Finder-launched** app inherits launchd's minimal `PATH` (no
`/usr/local/bin`, no `/opt/homebrew/bin`), so PATH-based lookups of
`claude`/`git`/`gh`/`aws`/`opencode` fail even when the tools are installed. It
prepends the standard GUI-missing locations that are not already present. It is a
no-op off `darwin` and idempotent (repeat calls never grow `PATH`), and is
exported for unit testing (Electron ignores an entry script's exports at runtime).

### Renderer platform awareness — `preload.js`

`preload.js` now exposes `api.platform` (mirroring `process.platform`) on the
`window.api` bridge, so the renderer can pick platform-appropriate install
commands, download links, and pane copy.

## Usage

No user action is required — the app detects the platform at startup. On macOS
and Linux the "cmd"/"bash" panes back onto your login shell; on Windows behaviour
is unchanged. If a CLI is installed but not found on macOS when launched from
Finder, the startup PATH augmentation is what makes it discoverable.

## Inputs and outputs

- **Inputs:** `process.platform`, `process.env.SHELL` / `process.env.PATH`, and
  the pane's `{ shell, cwd, cols, rows, worker, cliCommand }` options.
- **Outputs:** a spawned PTY backed by the correct shell for the platform, an AWS
  CLI invocation that resolves on every platform, and a `PATH` on macOS that
  includes the common Homebrew/local locations.

## Edge cases and limitations

- **`$SHELL` wins** on POSIX; the zsh/bash defaults only apply when it is unset.
- **`augmentDarwinPath` only adds `/usr/local/bin` and `/opt/homebrew/bin`** — a
  CLI installed elsewhere and off `PATH` is still not found.
- **Windows behaviour is preserved byte-for-byte** — the win32 branches spawn the
  same processes with the same env as before.
- Git Bash probing (`resolveGitBash`) still throws
  *"Git Bash not found. Install Git for Windows."* on Windows when absent; on
  POSIX that path is never taken.
- macOS is supported alongside Windows; Linux is best-effort (expected to work,
  less tested) rather than a certified first-class platform. The README and the
  `app-shell.md` / `terminals.md` docs describe this cross-platform support.
