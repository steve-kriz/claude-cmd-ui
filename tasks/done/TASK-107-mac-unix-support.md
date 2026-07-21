---
id: TASK-107
title: mac & unix support
status: done
created: 2026-07-20T20:50:13.780Z
updated: 2026-07-21T08:22:11.684Z
order: 1
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T22:30:00Z","finishedAt":"2026-07-21T01:49:11Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T22:32:00Z","finishedAt":"2026-07-21T02:00:48Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T22:34:00Z","finishedAt":"2026-07-21T02:05:54Z"}]
---

## Description

The app is currently Windows-only in three areas, and simply fails or misbehaves when launched on macOS/Linux:

1. **Shell/PTY spawning** (`lib/pty.js`): every terminal pane spawns `cmd.exe` or a Git-for-Windows `bash.exe` resolved from hardcoded `C:\Program Files\...` paths. On macOS `cmd.exe` does not exist and `resolveGitBash()` throws "Git Bash not found. Install Git for Windows."
2. **Renderer path building** (`renderer/renderer.js`): all path-join helpers default to the backslash separator when the base path does not already end in a separator (e.g. `tasksJoin('/Users/x/proj', 'tasks')` → `/Users/x/proj\tasks`), so the tasks board, skill install check, file tree, and ticket writes all produce broken paths on POSIX.
3. **Windows-only commands and locations**: the AWS integration invokes a hardcoded `C:\Program Files\Amazon\AWSCLIV2\aws.exe`; the Claude install helper runs a PowerShell installer; the git install helper runs `winget`; the git download link points at `/download/win`. Additionally, on macOS a Finder-launched Electron app inherits the minimal launchd `PATH` (no `/usr/local/bin`, no `/opt/homebrew/bin`), so even PATH-based lookups (`claude`, `git`, `gh`, `aws`, `opencode`) fail despite being installed.

This ticket makes the app work on macOS (and other POSIX platforms) by making shell selection, binary resolution, path joining, and install-helper commands platform-aware — **without changing any behavior on Windows**. `main.js` already handles several things correctly (`where`/`which` at main.js:916/929, `window-all-closed` darwin check at main.js:195, `app.getPath('userData')`, `windowsHide` being a no-op on POSIX, keep-awake via `powerSaveBlocker`); those must not regress either.

Out of scope: electron-forge makers/packaging for mac (forge.config.js currently defines no makers at all), mac app-menu/keyboard-shortcut polish, and any change to the orchestrate skill/agent assets.

## Clarifications

Open questions for the user (ticket parked until answered — record answers here and clear `question`, add a non-empty `answer` to unblock):

1. **Linux scope**: title says "mac & unix". Treat Linux as fully supported (POSIX branch covers it, `/bin/bash` fallback) or is macOS the only target? Proposed default: all non-win32 take the POSIX branch; only darwin gets PATH augmentation and mac download links.
2. **AWS SSO on mac**: should the AWS Dev/Prod switcher work on macOS (resolve `aws` from PATH), or leave it gated off on mac? Affects the `lib/aws.js` criterion.
3. **Which shell backs the panes on mac**: drafted default is the user's login shell (`$SHELL`, typically zsh) for both the agent pane and the "Git Bash" pane. Alternative: force `/bin/bash` for the second pane to keep its "bash" identity.
4. **Install-helper buttons on mac**: replace the PowerShell button with `curl -fsSL https://claude.ai/install.sh | bash` (drafted), or simply hide Windows-only buttons and rely on the docs link?
5. **Packaging**: is dev-mode (`npm start`) mac support sufficient? `forge.config.js` defines no makers, so a distributable mac build is new scope. Proposed default: packaging out of scope.

**Resolution (user answer):** "Just need the shell to start so that on a mac I get the same effect — a command prompt on the left and right, so I can run claude on one side and do deployments on the other."

Interpreting this: the CORE, must-have scope is a working shell in both panes on mac (Acceptance Criteria group **A**, plus **B** path-joining and **C** platform exposure — required for the panes and the app to function). Q3 → back the panes with the user's login shell (`$SHELL`, zsh default). Q1 → all non-win32 take the POSIX branch. Q5 → packaging out of scope. Q2 (AWS switcher) and Q4 (install-helper buttons) — group **D** — are secondary polish, kept in the ticket per the drafted defaults (AWS resolves `aws` from PATH; PowerShell button replaced with the curl installer on non-win32) but must not block the core two-pane shell working on mac. Windows behavior must not regress (group **E**).

## Acceptance Criteria

**A. Platform-aware PTY spawning (`lib/pty.js`)**
- [ ] `spawnShell({ shell: 'cmd' })` on `win32` behaves exactly as today: spawns `cmd.exe`, autolaunches `cliCommand` via `CMD_PROMPT_REGEX` detection + 1500 ms fallback, writes `cliCommand + '\r'`.
- [ ] `spawnShell({ shell: 'cmd' })` on `darwin`/`linux` spawns a POSIX shell instead of `cmd.exe`: the user's `$SHELL` when set, otherwise `/bin/zsh` on darwin and `/bin/bash` on linux; `cliCommand` is autolaunched with `'\n'` using POSIX prompt detection plus the same 1500 ms fallback.
- [ ] `spawnShell({ shell: 'bash' })` on `win32` still resolves Git Bash from the two `C:\Program Files` candidates and still throws `Git Bash not found. Install Git for Windows.` when absent.
- [ ] `spawnShell({ shell: 'bash' })` on `darwin`/`linux` spawns the POSIX shell (same resolution as above) and never consults the Git-for-Windows candidate paths; the MSYS-specific `CHERE_INVOKING: '1'` env var is only set on win32.
- [ ] `spawnShell({ shell: 'worker' })` follows the same platform split (cmd.exe on win32, POSIX shell elsewhere) and still autolaunches the worker command (`gemini`/`codex`/custom).
- [ ] The POSIX prompt-detection regex accepts zsh (`%`), bash (`$`), and root (`#`) prompt endings after ANSI stripping.
- [ ] `spawnShell` with an unknown `shell` value still throws `Unknown shell: <value>` on every platform.
- [ ] Platform and the pty backend are injectable (e.g. accepted as optional deps/params with `process.platform`/`@lydell/node-pty` defaults) so tests can exercise both platforms under `node --test` with no real PTY.

**B. Renderer path joining**
- [ ] `tasksJoin` (renderer.js:5197) infers the separator from the base path (`'\\'` only when the accumulated path contains a backslash and no forward slash; `'/'` otherwise) instead of always defaulting to `'\\'`.
- [ ] The equivalent inline joins at renderer.js:1310, 1379, 1383, 1892, 2928 and the `sep` default at renderer.js:2040 use the same inference (extract one shared helper rather than fixing each copy independently).
- [ ] With a Windows-style folder (`C:\proj`), all joined paths are byte-identical to today's output (regression guard).
- [ ] With a POSIX folder (`/Users/x/proj`), tasks-board paths, ticket file paths, skill path (`.../.claude/skills/orchestrate/SKILL.md`), and file-tree paths are all forward-slash joined.

**C. Platform exposure to the renderer**
- [ ] `preload.js` exposes the OS platform on the `api` bridge (e.g. `window.api.platform === process.platform`), and the renderer uses it for the platform-dependent UI below.

**D. Platform-aware commands and locations**
- [ ] Claude install helpers: on win32 the buttons behave exactly as today (npm global install; PowerShell `irm https://claude.ai/install.ps1 | iex`); on non-win32 the PowerShell option is replaced/hidden and a POSIX installer (`curl -fsSL https://claude.ai/install.sh | bash`) or the npm install is offered instead.
- [ ] Git install helpers: on non-win32 the `winget install --id Git.Git` button (renderer.js:2128) is not offered (hidden or replaced with a platform hint), and the download link (renderer.js:595) targets the platform page (`/download/mac` on darwin) instead of `/download/win`.
- [ ] AWS CLI resolution (`lib/aws.js:8`): on win32 the existing `C:\Program Files\Amazon\AWSCLIV2\aws.exe` path is used unchanged; on non-win32 the CLI is invoked as `aws` from PATH. All five call sites (execFile x4, spawn x1) go through the one resolver.
- [ ] On darwin, main-process startup augments `process.env.PATH` with standard GUI-missing locations (`/usr/local/bin`, `/opt/homebrew/bin`) when they are not already present, so `claude`/`git`/`gh`/`opencode`/`aws` lookups made via `execFile` succeed for Finder-launched apps. No PATH mutation on win32/linux where it already contains those entries or is not needed.

**E. No Windows regressions**
- [ ] All existing tests still pass (`npm test`, i.e. `node --test "test/**/*.test.js"`) apart from the known pre-existing failing baseline tests.
- [ ] No behavior change on win32 for: pty spawning, prompt detection timing, Git Bash resolution/error text, install buttons, AWS exe path, and renderer path output.

## Cucumber Tests

Tests run under `node --test` (no cucumber package); each scenario becomes a `test('Scenario: ...')` with Given/When/Then structured via mocks. All platform/OS calls (platform id, pty backend, `fs.existsSync`, `child_process`) must be mocked/injected — no real shells, binaries, or filesystem probes.

```gherkin
Feature: Cross-platform shell and PTY spawning

  Scenario: cmd slot on Windows is unchanged
    Given the platform is "win32"
    And a mocked pty backend
    When spawnShell is called with shell "cmd" and cliCommand "claude"
    Then the backend spawns "cmd.exe" with empty args
    And after a mocked CMD prompt "C:\proj>" is emitted, "claude\r" is written

  Scenario: cmd slot on macOS uses the user's shell
    Given the platform is "darwin"
    And env SHELL is "/bin/zsh"
    When spawnShell is called with shell "cmd" and cliCommand "claude"
    Then the backend spawns "/bin/zsh" (not "cmd.exe")
    And after a mocked zsh prompt ending in "%" is emitted, "claude\n" is written

  Scenario: cmd slot on macOS without $SHELL falls back
    Given the platform is "darwin"
    And env SHELL is unset
    When spawnShell is called with shell "cmd"
    Then the backend spawns "/bin/zsh"

  Scenario: cmd slot on Linux without $SHELL falls back
    Given the platform is "linux"
    And env SHELL is unset
    When spawnShell is called with shell "cmd"
    Then the backend spawns "/bin/bash"

  Scenario: bash slot on Windows still requires Git Bash (edge/failure)
    Given the platform is "win32"
    And neither Git Bash candidate path exists
    When spawnShell is called with shell "bash"
    Then it throws "Git Bash not found. Install Git for Windows."

  Scenario: bash slot on macOS never probes Git-for-Windows paths
    Given the platform is "darwin"
    When spawnShell is called with shell "bash"
    Then no fs existence check is made against any "C:\Program Files" path
    And the spawned env does not include CHERE_INVOKING

  Scenario: worker slot follows the platform split
    Given the platform is "darwin"
    When spawnShell is called with shell "worker" and worker "gemini"
    Then the backend spawns the POSIX shell and later writes "gemini\n"

  Scenario: prompt never detected still autolaunches via fallback (edge)
    Given the platform is "darwin"
    And the shell emits output that never matches a prompt
    When 1500 ms elapse (mocked timer)
    Then the cliCommand is written exactly once

  Scenario: unknown shell rejected on every platform (failure)
    Given the platform is "<any of win32, darwin, linux>"
    When spawnShell is called with shell "fish-tank"
    Then it throws "Unknown shell: fish-tank"

Feature: Cross-platform path joining in the renderer

  Scenario: Windows folder joins are byte-identical to today
    Given a base folder "C:\proj"
    When tasksJoin builds the tasks dir and a ticket path
    Then the results are "C:\proj\tasks" and "C:\proj\tasks\todo\TASK-001-x.md"

  Scenario: POSIX folder joins use forward slashes
    Given a base folder "/Users/steve/proj"
    When tasksJoin builds ".claude/skills/orchestrate/SKILL.md" under it
    Then the result is "/Users/steve/proj/.claude/skills/orchestrate/SKILL.md"
    And no backslash appears in the result

  Scenario: base already ending in a separator adds none (edge)
    Given a base folder "/Users/steve/proj/"
    When tasksJoin appends "tasks"
    Then the result is "/Users/steve/proj/tasks"

Feature: Platform-aware commands and locations

  Scenario: AWS CLI path on Windows is unchanged
    Given the platform is "win32"
    When the aws module resolves its CLI binary
    Then it is "C:\Program Files\Amazon\AWSCLIV2\aws.exe"

  Scenario: AWS CLI on macOS comes from PATH
    Given the platform is "darwin"
    When the aws module resolves its CLI binary
    Then it is "aws"

  Scenario: darwin PATH augmentation for GUI-launched apps
    Given the platform is "darwin"
    And process.env.PATH is "/usr/bin:/bin:/usr/sbin:/sbin"
    When the startup PATH fix runs
    Then PATH contains "/usr/local/bin" and "/opt/homebrew/bin"

  Scenario: PATH not duplicated when already correct (edge)
    Given the platform is "darwin"
    And PATH already contains "/opt/homebrew/bin"
    When the startup PATH fix runs
    Then "/opt/homebrew/bin" appears exactly once in PATH

  Scenario: no PATH mutation on Windows
    Given the platform is "win32"
    When the startup PATH fix runs
    Then process.env.PATH is unchanged

  Scenario: install helpers pick platform commands
    Given the exposed platform is "darwin"
    When the Claude install command set is computed
    Then it offers "curl -fsSL https://claude.ai/install.sh | bash" and not the PowerShell command
    And the git download URL targets the mac page
    And no winget command is offered
```

## Edge Cases & Failure Paths

- **Git Bash absent on Windows**: existing throw message and behavior must be preserved exactly (tests and the install banner depend on it).
- **`$SHELL` unset on POSIX** (e.g. spawned from a minimal env): fall back to `/bin/zsh` (darwin) / `/bin/bash` (linux); never fall through to `cmd.exe`.
- **zsh prompt ends with `%`**, and heavily themed prompts (powerlevel10k etc.) may match nothing: the 1500 ms `CMD_AUTOLAUNCH_FALLBACK_MS` fallback must still fire the cliCommand exactly once (the `launched` flag guards double-writes).
- **Finder-launched app on macOS** has launchd's minimal PATH: without the PATH augmentation, `cli:checkClaude`/`git:checkGit`/`github:checkGh` would all report "not installed" for installed tools. Detection failures must remain non-crashing (they already return `{ installed: false }`).
- **AWS CLI missing on macOS**: `execFile('aws', ...)` fails with ENOENT — must surface as the existing `{ ok: false, error }` IPC result, not an uncaught exception.
- **Mixed-separator base paths** (Windows path containing forward slashes, e.g. from git output): separator inference must not produce mixed output worse than today; rule is "backslash only when the string contains `\` and no `/`".
- **Unknown `shell` value** passed over IPC: still throws `Unknown shell: <value>` on all platforms.
- **PATH augmentation idempotence**: repeated startup calls (or an env that already contains the entries) must not grow PATH.
- **`worker` shell on POSIX**: must not attempt `cmd.exe`; write terminator must be `'\n'`.
- **Renderer without the new `api.platform`** (stale preload during dev reload): renderer platform checks should default to current Windows behavior rather than throwing.

## Relevant Files & Context

- `lib/pty.js` — the whole file (147 lines). `GIT_BASH_CANDIDATES` (5–8), `resolveGitBash` (10–15), `CMD_PROMPT_REGEX`/`BASH_PROMPT_REGEX`/`ANSI_REGEX` (18–22), `spawnCmd` (25–60), `spawnWorker` (67–97, `WORKER_COMMANDS` 62–65), `spawnBash` (99–138, note `CHERE_INVOKING`), `spawnShell` dispatcher (140–145). Uses `@lydell/node-pty`. No existing test file covers this module — new tests must inject a fake pty backend and platform.
- `main.js` — `pty:spawn` IPC handler (324–343) passes through to `spawnShell`; `execGit`/`execCapture` (54–94, PATH-dependent, `windowsHide` is POSIX-harmless); startup (`app.whenReady`, 180–191) is where darwin PATH augmentation belongs (before anything execs binaries); `where`/`which` split already correct (916, 929); darwin quit handling already correct (193–196); keep-awake (198+) is platform-guarded already.
- `preload.js` — `contextBridge.exposeInMainWorld('api', {...})` (line 3): add `platform: process.platform`.
- `renderer/renderer.js` — `tasksJoin` (5195–5203, comment explicitly says "assumes Windows backslash paths"); inline `'\\'`-defaulting joins at 1310, 1379, 1383, 1892, 2928 and default `sep: '\\'` at 2040 (2041, 2301, 2755 already infer from content and are the pattern to follow); Claude install buttons (720–734, PowerShell at 725); opencode installer already POSIX (747); git download link (593–596); `startGitInstall` winget (2126–2131); `launchCmdAgent` (974–1000) — its comment "Claude runs in cmd.exe" becomes platform-dependent; `runInCmdPty` writes `'\r'` (1083) — fine in a PTY on both platforms, leave as-is.
- `renderer/index.html` — user-facing copy referencing `cmd.exe`, PowerShell, winget, Git Bash: lines 22, 133–134, 177, 186–189, 372, 385. Adjust labels only where behavior changes; keep DOM class names stable (renderer queries by class).
- `lib/aws.js` — `AWS_EXE` (8), used at 167, 198, 231, 462; also `AWS_DIR = path.join(os.homedir(), '.aws')` (47) is already cross-platform.
- `lib/ticket-queue.js` — `ticketWorktreeDir` (~404–407) already normalizes with forward slashes; no change, but do not break its tests (test/ticket-queue.test.js:716 asserts mixed-sep output).
- Test conventions: `npm test` → `node --test "test/**/*.test.js"`; follow the dependency-injection style of `test/task-036-keep-awake.e2e.test.js` (fake `powerSaveBlocker`) for the fake pty backend/platform. Existing tests hardcode `C:\proj` folders (e.g. test/slack-create-ticket.e2e.test.js:364) — they must keep passing, which the separator-inference rule guarantees.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
