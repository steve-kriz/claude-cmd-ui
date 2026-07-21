---
id: TASK-133
title: linux / mac compatibility
status: done
created: 2026-07-21T08:22:53.284Z
updated: 2026-07-21T09:54:54.000Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T08:22:58.000Z","finishedAt":"2026-07-21T08:31:25.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T09:29:26.000Z","finishedAt":"2026-07-21T09:41:58.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T09:41:58.000Z","finishedAt":"2026-07-21T09:48:31.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T09:48:31.000Z","finishedAt":"2026-07-21T09:54:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T09:54:00.000Z","finishedAt":"2026-07-21T09:54:54.000Z"}]
---

## Description

Make the app's documentation and user-facing copy match its now cross-platform
reality, and lock in the macOS/Linux "default command window" behavior with the few
missing regression tests — **without redoing TASK-107**.

**What TASK-107 / TASK-125 already delivered (do NOT reimplement):**

- `lib/pty.js` — `spawnShell(opts, deps)` is fully platform-aware with injectable
  `deps.platform` / `deps.pty`. On non-win32 every pane (`cmd`, `bash`, `worker`)
  routes to `spawnPosix`, which spawns `resolvePosixShell(platform, env)` — the
  user's `$SHELL` (trimmed) when set, else `/bin/zsh` on darwin and `/bin/bash`
  elsewhere — with `['-l','-i']` and `TERM=xterm-256color`. CLI autolaunch uses
  `'\n'` + `POSIX_PROMPT_REGEX` (`%`/`$`/`#`) with the 1500 ms fallback.
  `CHERE_INVOKING` and Git-Bash probing are win32-only. Covered by
  `test/task-107-mac-unix.test.js` and `test/task-107-mac-unix.e2e.test.js`.
- `lib/aws.js` — `resolveAwsExe(platform)`: fixed Windows path on win32, `aws` from
  PATH elsewhere.
- `main.js` — `augmentDarwinPath()` fixes the Finder-launched minimal launchd PATH
  on darwin (idempotent, no-op elsewhere). Covered by
  `test/task-125-darwin-path.test.js`.
- `preload.js` exposes `api.platform`; `renderer/renderer.js` `getPlatform()` falls
  back to `'win32'` for a stale preload. Install helpers are platform-aware: the
  winget button is hidden off win32 (renderer.js:649–657), the git download link
  targets `/download/mac|win|linux` (renderer.js:658–664), and the Claude PowerShell
  button is dynamically relabeled "Install via script" and wired to `curl -fsSL
  https://claude.ai/install.sh | bash` off win32 (renderer.js:787–801). Covered by
  `test/task-125-install-helpers.e2e.test.js`.
- Renderer path-join separator inference and `lib/fs-roots.js`
  platform-parameterized containment.

**The remaining gap (this ticket):**

1. **README.md (the "main document") still claims Windows-only.** Line 3 says
   "Windows-first", the platform blockquote (lines 15–17) says "Windows only …
   macOS/Linux are not supported", the Overview (lines 48–49) says terminals are
   "real Windows ConPTY processes", the Requirements table (lines 134–141) presents
   Git for Windows at `C:\Program Files\Git\bin\bash.exe` and the AWS CLI at a
   hardcoded path as unconditional requirements, and the Security notes (lines
   362–364) say those paths are "baked in". This directly contradicts README lines
   304–308, which already advertise the cross-platform shell support and link
   `docs/cross-platform.md`.
2. **Two docs pages are stale:** `docs/app-shell.md:98–99` ("Windows-first …
   macOS/Linux are not supported") and `docs/terminals.md` (lines 5–7, 21–26, 79,
   99–100 describe only the Windows spawn paths), both contradicting
   `docs/cross-platform.md` and the code.
3. **Static Windows-worded copy in `renderer/index.html`** misdescribes the panes
   on macOS/Linux, where both panes are actually the user's login shell: the
   empty-state (line 22, "open `cmd.exe` … and `Git Bash`"), the agent dropdown
   option "git bash · openCode" (line 161), the opencode banner "Install it to run
   openCode in Git Bash" / "Install in Git Bash" (lines 213/216), the right-pane tab
   label "Git Bash" (line 229), the winget hint "winget install runs in the Git Bash
   terminal" (line 399), and the gh login hint "Login runs in the Git Bash tab"
   (line 412). The dynamic-relabel pattern already exists (renderer.js:797 sets
   `claudeInstallPwshBtn.textContent` off win32) and must be followed; on win32 all
   copy stays byte-identical.
4. **Two small test-coverage gaps:** `test/task-107-mac-unix.e2e.test.js` covers the
   linux `cmd` fallback but has no linux `bash`/`worker` pane scenario proving the
   Git-for-Windows candidates are never probed and the `'\n'` terminator is used on
   linux.

Why: a mac user reading the README today is told the app will not work for them; a
mac user running it sees panes labeled "Git Bash" that are actually zsh. The
behavior shipped in TASK-107 — this ticket ships the truth about it, plus the last
regression guards.

**Testing note for the tester:** tests run on the current platform (win32) under
`node --test` (`npm test` → `node --test "test/**/*.test.js"`). All
platform-specific behavior must be exercised by *injecting* the platform —
`spawnShell(opts, { platform, pty })` for PTY tests, and source/DOM-harness
assertions for renderer copy (follow the `rendererSrc` regex + `setupHarness(platform)`
patterns in `test/task-125-install-helpers.e2e.test.js` and
`test/task-107-mac-unix.e2e.test.js`). Documentation criteria are testable as
file-content assertions (read README.md/docs with `fs.readFileSync` and assert
required/forbidden phrases). No real mac, real shell, or real PTY may be required.

Out of scope: any change to `lib/pty.js` / `lib/aws.js` / `main.js` platform
behavior (done in TASK-107/125); electron-forge makers / packaged mac builds
(`forge.config.js` defines no makers — dev-mode `npm run start` is the supported
path); mac app-menu/shortcut polish; launching the OS Terminal.app (the "default
command window" is the login shell inside the app's embedded PTY panes).

## Clarifications

Resolved with the user before build (recorded here, not in Additional Context):

1. **"Default command windows"** → the login shell **inside the app's embedded
   terminal panes** (zsh on mac), which TASK-107 already implemented. NOT launching
   the external macOS Terminal.app.
2. **In-app UI copy** → **in scope**: relabel the Windows-worded UI strings on
   mac/Linux (e.g. right-pane tab "Git Bash" → "Terminal", cmd.exe/Git Bash/winget
   hints made platform-appropriate). Windows copy stays byte-identical. (AC group C
   applies.)
3. **Linux support level** → document Linux as **best-effort / expected to work
   (less tested)**, not a certified first-class platform equal to macOS.
4. **"Main document" scope** → README.md **plus** the two stale docs pages
   (`docs/app-shell.md`, `docs/terminals.md`) so no doc still claims mac/Linux is
   unsupported. (AC group B applies.)
5. **Packaging** → **out of scope**: no mac distributables/makers; `npm run start`
   dev-mode on mac is sufficient and `forge.config.js` stays untouched (matches
   TASK-107).

## Acceptance Criteria

**A. README.md reflects cross-platform support (the "main document")**
- [ ] The platform blockquote (currently lines 15–17) no longer says "Windows only"
  / "macOS/Linux are not supported"; it states the app runs on Windows and macOS
  (and Linux as best-effort/expected-to-work per clarification #3): on Windows the
  panes are `cmd.exe` + Git Bash; on macOS/Linux both panes are the user's login
  shell (`$SHELL`, defaulting to zsh on macOS / bash on Linux), linking
  `docs/cross-platform.md`.
- [ ] The intro (line 3, "Windows-first") and Overview (lines 48–49, "real Windows
  ConPTY processes") are reworded platform-neutrally (e.g. real PTY processes via
  `@lydell/node-pty` — ConPTY on Windows).
- [ ] The Requirements table qualifies platform-specific rows: Git for Windows / the
  `C:\Program Files\Git\bin\bash.exe` path is Windows-only (macOS/Linux need `git` on
  PATH and use the login shell); the AWS CLI row states the fixed `aws.exe` path
  applies on Windows and `aws` is resolved from PATH elsewhere.
- [ ] Quick start / Development notes that `run.bat` is a Windows convenience wrapper
  and `npm run start` is the cross-platform entry point; the macOS Finder-launch PATH
  caveat (Homebrew CLIs found via the startup PATH augmentation) is mentioned or
  linked.
- [ ] The Security-notes "Hardcoded paths" bullet is scoped to Windows (on
  macOS/Linux the AWS CLI and shell are resolved from PATH/`$SHELL`).
- [ ] After the edit, README.md contains no remaining claim that macOS/Linux are
  unsupported (no occurrence of "Windows only", "not supported" in a platform sense,
  or "Windows-first"), and remains consistent with lines 304–308. Linux is described
  as best-effort/expected-to-work, not certified.

**B. Stale docs pages corrected**
- [ ] `docs/app-shell.md` (lines 98–99): the "Windows-first … macOS/Linux are not
  supported" limitation bullet is replaced with an accurate statement referencing
  `docs/cross-platform.md`.
- [ ] `docs/terminals.md`: describes both spawn branches — win32 (`cmd.exe` / Git
  Bash, unchanged) and POSIX (login shell via `resolvePosixShell`,
  `POSIX_PROMPT_REGEX`, `'\n'` terminator) — and links `docs/cross-platform.md`; the
  "Git Bash missing" edge case is scoped to Windows.

**C. Platform-truthful in-app copy (renderer)**
- [ ] On non-win32 (`window.api.platform`), the right-pane terminal tab label
  (index.html:229, currently "Git Bash") reads "Terminal" (or equivalent), relabeled
  at tab creation in renderer.js following the existing
  `claudeInstallPwshBtn.textContent` pattern (renderer.js:796–800).
- [ ] On non-win32, the empty-state copy (index.html:22), the "git bash · openCode"
  agent option (index.html:161), the opencode install banner/button
  (index.html:213/216), and the gh-login hint (index.html:412) no longer name
  `cmd.exe`/Git Bash; the winget hint (index.html:399) is hidden together with the
  already-hidden winget button.
- [ ] On win32, all of the above render byte-identical to today (no label or DOM
  change), and all DOM class names used by renderer queries and existing tests remain
  unchanged on every platform.
- [ ] With a stale preload (no `api.platform`), the renderer falls back to Windows
  labels without throwing (existing `getPlatform()` fallback at renderer.js:15–21
  keeps working).

**D. Regression-test gaps closed (no production code change expected)**
- [ ] A test proves `spawnShell({ shell: 'bash' })` with injected platform `linux`
  spawns the POSIX shell, never checks any `C:\Program Files` Git-Bash candidate,
  does not set `CHERE_INVOKING`, and autolaunches `cliCommand` with `'\n'`.
- [ ] A test proves `spawnShell({ shell: 'worker' })` with injected platform `linux`
  spawns the POSIX shell and writes the worker command with `'\n'`.
- [ ] A failure-path test proves that on darwin with `SHELL` unset/blank the `cmd`
  pane still spawns `/bin/zsh` (never `cmd.exe`).

**E. No regressions**
- [ ] `npm test` passes apart from the known pre-existing failing baseline tests; all
  TASK-107/TASK-125 suites stay green.
- [ ] No behavior change on win32: pty spawning, prompt timing, Git Bash
  resolution/error text ("Git Bash not found. Install Git for Windows."), install
  buttons, AWS exe path.

## Cucumber Tests

Tests run under `node --test` on win32; each scenario becomes a `test('Scenario: ...')`.
Platform is always injected (`spawnShell(opts, { platform, pty })`, harness
`platform` param, or file-content assertions) — never taken from the host.

```gherkin
Feature: README and docs reflect cross-platform support

  Scenario: README no longer claims Windows-only
    Given the contents of README.md
    Then it does not contain "Windows only" or "macOS/Linux are not supported"
    And it states that on macOS/Linux the panes run the user's login shell
    And it links docs/cross-platform.md from the platform statement

  Scenario: README requirements are platform-qualified
    Given the contents of README.md
    Then the Git for Windows requirement is marked Windows-only
    And the AWS CLI row says the fixed exe path applies on Windows and "aws" comes from PATH elsewhere
    And npm run start is documented as the cross-platform entry point

  Scenario: README documents Linux as best-effort (edge)
    Given the contents of README.md
    Then Linux is described as expected-to-work / best-effort, not as a certified platform

  Scenario: app-shell and terminals docs match the code
    Given the contents of docs/app-shell.md and docs/terminals.md
    Then neither claims macOS/Linux are unsupported
    And docs/terminals.md describes the POSIX login-shell branch and links docs/cross-platform.md

Feature: Platform-truthful pane copy in the renderer

  Scenario: terminal tab label on macOS
    Given a renderer harness with platform "darwin"
    When a workspace tab is created
    Then the right-pane tab labelled "Git Bash" on Windows reads "Terminal"
    And the winget hint is hidden along with the winget button

  Scenario: labels on Windows are byte-identical (regression)
    Given a renderer harness with platform "win32"
    When a workspace tab is created
    Then the tab label is "Git Bash" and the empty-state, opencode, and hint copy are unchanged
    And no DOM class name has changed

  Scenario: stale preload falls back to Windows copy (edge)
    Given window.api has no platform property
    When the renderer computes its platform
    Then it treats the platform as "win32" and does not throw

Feature: Default command window on macOS and Linux (regression guards)

  Scenario: bash pane on Linux never probes Git-for-Windows paths
    Given the injected platform is "linux" and a mocked pty backend and fs
    When spawnShell is called with shell "bash" and cliCommand "npm test"
    Then the POSIX shell is spawned with ["-l","-i"]
    And no existence check is made against any "C:\Program Files" path
    And the spawned env does not include CHERE_INVOKING
    And after a prompt ending in "$" renders, "npm test\n" is written

  Scenario: worker pane on Linux uses the POSIX terminator
    Given the injected platform is "linux" and a mocked pty backend
    When spawnShell is called with shell "worker" and worker "gemini"
    Then the POSIX shell is spawned and "gemini\n" is eventually written exactly once

  Scenario: SHELL unset on macOS falls back to zsh (failure path)
    Given the injected platform is "darwin"
    And env SHELL is unset or blank
    When spawnShell is called with shell "cmd"
    Then "/bin/zsh" is spawned and never "cmd.exe"
```

## Edge Cases and Failure Modes

- **`$SHELL` unset or whitespace-only on macOS/Linux** — must fall back to
  `/bin/zsh` (darwin) / `/bin/bash` (linux), never `cmd.exe`. Already implemented in
  `resolvePosixShell` (lib/pty.js:20–24); this ticket keeps it guarded, not
  reimplemented.
- **`$SHELL` points at a nonexistent binary** — the pty backend's spawn error
  propagates through the existing `pty:spawn` IPC error path; document in
  `docs/terminals.md` rather than adding new handling (out of scope to change
  spawning).
- **Heavily themed POSIX prompts** (powerlevel10k etc.) that never match
  `POSIX_PROMPT_REGEX` — the 1500 ms `CMD_AUTOLAUNCH_FALLBACK_MS` fallback still
  writes the command exactly once (`launched` flag). Must not regress.
- **Stale preload during dev reload** (no `api.platform`) — `getPlatform()` returns
  `'win32'`; the new relabel code must tolerate this (Windows copy shown, no throw).
- **Windows byte-identical output** — README may change, but the win32 runtime copy,
  Git-Bash error text, and all existing test assertions (e.g.
  `test/task-125-install-helpers.e2e.test.js` source-regex checks) must keep
  passing; do not rename DOM classes such as `gitInstallWingetBtn`.
- **Docs drift guard** — the byte-for-byte `assets/` mirror rule applies only to
  files under `.claude/`; README/docs edits do not require mirror syncs. Do not touch
  `.claude/` files in this ticket.
- **Linux scope** — per clarification #3, README must describe Linux as
  best-effort/expected-to-work rather than implying certified support.
- **Hidden winget hint** — hiding the hint (index.html:399) must not hide the
  surrounding git-install section needed for the download-page button that IS offered
  off win32.

## Relevant Files and Context

- `README.md` — the main document. Edit points: line 3 ("Windows-first"), 15–17
  (platform blockquote), 48–49 ("Windows ConPTY"), 132–149 (Requirements table +
  note), 157–166 (Quick start / `run.bat`), 214–231 (Development), 304–308
  (already-correct cross-platform bullet — keep consistent with it), 360–373
  (Security notes "Hardcoded paths"), 375–414 (Project layout `run.bat` comment).
- `docs/app-shell.md` — lines 98–99, the stale "Windows-first / not supported"
  limitation.
- `docs/terminals.md` — lines 5–7, 21–26, 64, 79, 99–100: Windows-only description
  of `lib/pty.js`; align with `docs/cross-platform.md`.
- `docs/cross-platform.md` — the authoritative description of what TASK-107 shipped;
  its final paragraph (lines 97–99) explicitly names this README gap and can be
  trimmed once the README is fixed.
- `lib/pty.js` — read-only reference: `resolvePosixShell` (20–24), `spawnPosix`
  (67–79), `spawnCmd` (81–97), `spawnWorker` (104–122), `spawnBash` (124–148),
  `spawnShell(opts, deps)` (153–161), `__testing` exports (165–173). No production
  change expected.
- `renderer/index.html` — static copy at lines 22, 161, 204 (already relabeled
  dynamically), 213, 216, 229, 395, 399, 412, 649. Keep class names stable.
- `renderer/renderer.js` — `getPlatform`/`isWin` (15–21); winget/download wiring
  (649–664); the dynamic-relabel pattern to copy (787–801, esp. 797 `textContent =
  'Install via script'`); tab-creation is where new relabels belong.
- `preload.js` — `api.platform` (lines 4–6), already exposed.
- Tests to extend / follow as patterns: `test/task-107-mac-unix.e2e.test.js` (fake
  pty backend + injected platform; linux `cmd` fallback at 177–182 — add linux
  `bash`/`worker` siblings), `test/task-107-mac-unix.test.js` (unit tests for
  `resolvePosixShell`), `test/task-125-install-helpers.e2e.test.js`
  (`setupHarness(platform)` DOM harness + `rendererSrc` source assertions — the
  pattern for copy/label tests and for doc-content assertions).
- Test command: `npm test` → `node --test "test/**/*.test.js"`; two pre-existing
  baseline failures are known noise.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
