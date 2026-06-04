# Claude CMD UI

A Windows-first Electron desktop app that wraps an AI coding CLI (`claude`) and a `Git Bash`
terminal side-by-side, then layers a full project cockpit around them: a file explorer with search
and inline editing, a Git/GitHub panel, a diff & merge-conflict viewer, a test runner, a Slack
bridge, and a multi-account AWS SSO credential switcher.

The goal is to drive an AI coding agent from a single window — queue up prompts, watch it work,
review the diffs it produces, commit & push, open a PR, run a GitHub Action, and (optionally) relay
the whole conversation to and from a Slack channel — without leaving the app.

> **Platform:** Windows only. It shells out to `cmd.exe`, Git Bash (`C:\Program Files\Git\bin\bash.exe`),
> and the AWS CLI v2 at a hardcoded path. macOS/Linux are not supported.

---

## Table of contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [The window at a glance](#the-window-at-a-glance)
- [Features](#features)
  - [Workspace tabs (multi-folder)](#workspace-tabs-multi-folder)
  - [The cmd / claude pane](#the-cmd--claude-pane)
  - [Prompt queue](#prompt-queue)
  - [Prompt history (logs)](#prompt-history-logs)
  - [Git Bash terminal](#git-bash-terminal)
  - [AWS environment switcher](#aws-environment-switcher)
  - [File Explorer](#file-explorer)
  - [Git tab](#git-tab)
  - [Change Viewer (diff & merge conflicts)](#change-viewer-diff--merge-conflicts)
  - [Tests tab](#tests-tab)
  - [Slack bridge](#slack-bridge)
- [Data & files written](#data--files-written)
- [The prompt-logs Lambda](#the-prompt-logs-lambda)
- [Security notes](#security-notes)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Project layout](#project-layout)

---

## Architecture

The app follows the standard Electron split with context isolation enabled:

- **`main.js`** — the main (Node) process. Owns the `BrowserWindow`, spawns PTYs, and implements
  every privileged operation behind `ipcMain.handle(...)` channels: folder picking, the filesystem
  helpers (read/write/rename/grep/find), Git commands (via `execFile('git', …)`), GitHub via the
  `gh` CLI, prompt-history persistence, and the AWS/Slack bridges.
- **`preload.js`** — the secure bridge. Uses `contextBridge` to expose a single `window.api` object
  to the renderer; the renderer never touches Node APIs directly.
- **`renderer/`** — the UI (plain HTML/CSS/JS, no framework). `index.html` defines the layout and a
  `<template>` cloned per workspace tab; `renderer.js` (~5k lines) drives all interaction; `styles.css`
  themes it.
- **`lib/`** — main-process helper modules:
  - `pty.js` — spawns `cmd.exe`, Git Bash, or a "worker" shell (gemini/codex) via `@lydell/node-pty`,
    with logic to auto-launch a CLI once the shell prompt is detected.
  - `aws.js` — AWS SSO login, role listing/selection, and credential rewriting.
  - `slack.js` — a thin Slack Web API client (auth, channel resolution, history, post).
  - `cloud-logs.js` — optional HTTP client for the prompt-logs Lambda (used for cloud sync).
- **`lambda/prompt-logs/`** — an optional AWS Lambda that stores prompt history in CloudWatch Logs.

Terminals are rendered with [xterm.js](https://xtermjs.org/) and backed by real ConPTY processes, so
the embedded `cmd` and `bash` shells behave like normal terminals (colors, TUIs, resize, copy/paste).

---

## Requirements

| Tool | Why | Notes |
|------|-----|-------|
| **Node.js + npm** | Build/run the app | |
| **Git for Windows** | Git Bash terminal + all Git operations | Expected at `C:\Program Files\Git\bin\bash.exe` |
| **`claude` CLI** | The AI agent that runs in the cmd pane | Optional — the app offers to install it if missing |
| **GitHub CLI (`gh`)** | Publish, PRs, Actions | Optional — only the Git tab needs it |
| **AWS CLI v2** | Dev/Prod SSO switching | Expected at `C:\Program Files\Amazon\AWSCLIV2\aws.exe` |
| **`gemini` / `codex`** | Optional worker CLIs | Only if you use the worker shell |

Most integrations degrade gracefully: if `gh`, `claude`, or AWS aren't present, the rest of the app
still works and the relevant tab shows install/sign-in guidance.

---

## Getting started

```bash
npm install
npm run start      # launches via electron-forge (run.bat does the same)
```

Other scripts:

```bash
npm run package    # package the app with electron-forge
npm run make       # build distributables
```

DevTools open automatically (detached). Set `OPEN_DEVTOOLS=0` to suppress that, and use
`Ctrl+Shift+I` or `F12` to toggle them.

On first launch you'll see an empty state — click **Browse Folder…** (or **+ Folder…**) to open a
project. Open folders are remembered and reopened on the next launch.

---

## The window at a glance

```
┌─ workspace tabs ──────────────────────────────────────  [+ Folder…] ─┐
├───────────────────────────────┬──────────────────────────────────────┤
│  cmd · claude                 ║  [Git Bash][Files][Slack][Git]        │
│  ┌─────────────────────────┐  ║  [Change Viewer][Tests]               │
│  │                         │  ║                                        │
│  │  claude REPL            │  ║   (active right-hand tab view)         │
│  │  (xterm terminal)       │  ║                                        │
│  │                         │  ║                                        │
│  └─────────────────────────┘  ║                                        │
│  Logs / Queue / +Prompt       ║                                        │
└───────────────────────────────┴──────────────────────────────────────┘
                                 ↑ draggable splitter
```

- **Left pane:** the `cmd` terminal running `claude`, plus the prompt **Queue** and **Logs** panels.
- **Right pane:** a tabbed surface — Git Bash, File Explorer, Slack, Git, Change Viewer, Tests.
- A draggable **splitter** sets the left/right ratio; terminals re-fit on release.

---

## Features

### Workspace tabs (multi-folder)

- Open any number of project folders, each in its own tab with its own pair of terminals and its own
  state.
- The tab label is the folder's leaf name; the full path is in the tooltip; the window title tracks
  the active tab.
- Tabs are **drag-to-reorder** with before/after drop indicators.
- Closing a tab kills its `cmd`/`bash` PTYs and clears its timers; closing the last tab returns you to
  the empty state.
- The open-folder list is **persisted** (`session.json` in Electron's userData) and restored on
  startup.
- Each tab shows a **status dot**:
  - **idle** — nothing running
  - **busy** — `claude` is producing output
  - **waiting** — idle, but the agent is paused on a TUI confirmation/menu (detected by scanning the
    terminal for selection cursors like `❯` or `Yes/No` prompts)
  - **finished** (green) — went idle after producing output; "needs your attention." Clicking the tab
    clears it.
- A small badge on the tab shows the number of **queued prompts**.

### The cmd / claude pane

- On opening a folder the app checks whether `claude` is installed (`claude --version`, falling
  back to `where`).
  - If found, it auto-launches `claude` in the cmd terminal once the shell prompt appears.
  - If missing, an install banner offers **Install via npm** (`npm install -g @anthropic-ai/claude-code`),
    **Install via PowerShell** (`irm https://claude.ai/install.ps1 | iex`), **Install docs…**,
    **Re-check**, and a manual **Launch** button.
- The terminal is a real ConPTY `cmd.exe` session — full color, TUIs, resize, and clipboard support
  (paste with `Ctrl+V` / `Shift+Insert`; copy with `Ctrl+Shift+C` / `Ctrl+Insert`; `Ctrl+C` copies a
  selection or sends SIGINT; right-click copies-or-pastes).
- **Idle detection:** ~2.5 s after the last output, the pane decides the agent is idle and flips the
  tab to *finished* (or *waiting* if a menu is on screen). This drives both the status dots and the
  queue auto-dispatch.

### Prompt queue

- Queue up prompts to feed the agent one at a time. Open the **Queue** panel, hit **+ Queue Prompt**,
  type (multi-line OK), and **Add to queue** (`Ctrl+Enter`).
- Queued items can be reordered (up/down) or deleted; item #1 is marked "next".
- When the pane goes **finished** (idle after output) and no TUI menu is on screen, the next prompt is
  **auto-dispatched**: the text is typed into the REPL, logged, and `Enter` is sent a moment later.
  If the agent is paused on a confirmation, dispatch waits until you resolve it.
- The per-tab badge and the in-pane count track the pending queue.

### Prompt history (logs)

- Every prompt — whether typed manually, dispatched from the queue, or received from Slack — is
  recorded with a timestamp and a **source tag** (`user` / `queue` / `slack`).
- The **Logs** panel lists them with estimated token count and an approximate cost (rough estimate:
  length ÷ 4 tokens; priced against Sonnet at \$3/M in, \$15/M out). Pending entries show "awaiting
  response."
- History is saved per-project to **`.claude-logs/logs/prompt_history.json`** inside the folder.
- **Refresh** re-reads the file and **Clear** wipes it (with confirmation).
- An optional **cloud sync** can pull history from the prompt-logs Lambda (GET) to repopulate the
  local file — see [The prompt-logs Lambda](#the-prompt-logs-lambda).

### Git Bash terminal

- A full Git Bash login shell (`--login -i`) rooted at the project folder, with `TERM=xterm-256color`
  and `CHERE_INVOKING=1`.
- This is where ad-hoc shell commands, `gh auth login`, and dispatched test runs land. There's also a
  hidden **worker** shell that can run `gemini` or `codex`.

### AWS environment switcher

In the Git Bash tab's sub-toolbar there's an **AWS environment ▾** button and a status chip showing
the currently selected environment. The account list, **List accounts ↻** action, and **Profile**
picker live inside the popup the button opens — keeping the toolbar uncluttered. The app discovers
every account you can reach from your SSO portal and lets you sign into any of them, writing the token
to the profile you choose:

1. Click **AWS environment ▾** to open the popup, then **List accounts ↻**. The app ensures a shared
   `[sso-session claude-cmd-ui]` block exists in `~/.aws/config`, runs `aws sso login` once (output
   streams into the bash pane), then calls `aws sso list-accounts` and renders **one button per
   account** you have access to inside the popup. The discovered list is cached (in the renderer) so
   the accounts reappear on the next launch without re-listing.
2. Click an **account button**. The popup closes; the app lists the roles available to you in that
   account; if there's more than one a **role picker** appears, otherwise the single role is applied.
3. It creates/updates a `[profile sso-<account>]` entry (bound to the shared SSO session) with the
   chosen role, exports temporary credentials, and writes them into the **selected Profile** plus
   `[default]` in `~/.aws/credentials`. Your existing `credentials` file is backed up once before the
   first rewrite.
4. The **status chip** shows the active account, role, target profile, and expiration time; it
   persists across restarts (`status.json` in userData).

The SSO start URL is prompted for on first use and stored in `.env` (`AWS_SSO_START_URL`); the region
and account IDs are at the top of `lib/aws.js`.

### File Explorer

- A lazy-loading **tree** of the project (skips `node_modules`/`.git` by default). Click folders to
  expand, files to open.
- **Inline editor:** open a text file, edit it, and **Save** (`Ctrl+S`). A "● unsaved" chip and dirty
  tracking warn before you lose changes; **Reload** re-reads from disk. Binary and oversized files
  show a placeholder instead of garbage.
- **Rename** files in place (with illegal-character validation).
- Two quick filters: **Readme** (Markdown only) and **Changes** (only git-modified files).
- **Find bar** (`Ctrl+F`) with three scopes:
  - **Tree** — live filter of file/folder names.
  - **Content** — full-text search across the folder (debounced), with file + line + snippet results.
  - **File** — find within the open file, with match count and prev/next navigation.

### Git tab

Gated behind a GitHub sign-in check — if `gh` isn't installed or authenticated, the tab shows a sign-in
prompt with a **Login with gh** button (runs `gh auth login` in the bash pane) and a re-check button.

Once authenticated:

- **Branch info:** current branch, upstream tracking header, and **ahead/behind** vs. the detected
  trunk (`origin/HEAD`, else `main`/`master`/`trunk`/`develop`), color-coded.
- **Commit & Push:** pick/create a branch, write a message, choose stage-all / push / set-upstream,
  and run it with live streamed output. **Protected branches (`main`/`master`) are blocked** — you
  must create a new branch. Includes an expandable **Recent check-ins** list (click a commit to see its
  diff and changed files).
- **Publish to GitHub:** turn a local folder into a new GitHub repo — pick the owner (your account or
  an org), name, visibility (private/public/internal), description, and initial commit, then
  `gh repo create … --push`.
- **Pull Request:**
  - Create a PR (title, base branch, body, draft toggle).
  - Browse **Open pull requests** and select one.
  - View **reviews, comments, and inline (file:line) comments**, newest first.
  - **Send to Claude** bundles all the PR feedback into a single prompt and queues it for the agent.
- **Run Action:** dispatch a GitHub Actions **`workflow_dispatch`** workflow. The app reads the
  workflow YAML to render typed inputs (text / boolean / choice with options), lets you choose the
  ref/branch, and — for workflows that target named environments — can show **recent environment
  deployments (last 24 h)** so you can see who deployed what before you trigger it. After dispatch it
  surfaces an **Open run ↗** link.

### Change Viewer (diff & merge conflicts)

- Lists every changed file with its git status code; conflicted files are flagged with a red
  **CONFLICT** tag, and a badge on the tab shows the change count.
- Click a file to see a colorized diff (staged and unstaged sections; untracked files render as
  all-additions).
- **Right-click** a file for an **ignore** menu: add the file, its folder, or its top-level folder to
  `.gitignore`.
- **Interactive merge-conflict resolver:** for each conflict block, choose **ours / theirs / both /
  neither**, with a running "N/M resolved" summary and bulk "all ours / all theirs / all both"
  actions. **Save** writes your choices; **Save & mark resolved** also runs `git add` once everything
  is resolved. Binary conflicts offer checkout-ours / checkout-theirs / mark-resolved. An **Abort
  merge** button cleanly aborts an in-progress merge, rebase, or cherry-pick.

### Tests tab

- Scans the project for test files and splits them into **Unit tests** and **UI/e2e tests** (by
  extension — `.test.*`, `.spec.*`, `.cy.*`, `.e2e.*`, `.feature` — and by path hints like `e2e/`,
  `cypress/`, `playwright/`).
- Each file gets a **Run** button; each group gets **Run all**. Running a test resolves the right
  command from `package.json` (Jest/Vitest/Playwright/Cypress, etc.) and dispatches it to the bash
  pane.
- **Update unit tests** queues a multi-step prompt asking the agent to audit and fill coverage gaps.
- UI tests add a **headed** toggle (appends `--headed`) and a **watch** toggle (streams output into an
  inline panel instead of switching to the terminal).

### Slack bridge

Bridges a Slack channel to the agent: messages posted in Slack become prompts, and the agent's replies
are posted back.

- **Token** is read from the `SLACK_TOKEN` variable in your `.env` file (the bot token, `xoxb-…`, from
  your Slack app's *OAuth & Permissions → Bot User OAuth Token*). AWS Secrets Manager is no longer used.
  If the token is missing or the connection fails, the Slack tab shows setup instructions.
- **Connect** to a channel by `#name` or ID; the app validates the token and resolves the channel.
- **Live** listening keeps the channel connected and dispatches each new message to the agent
  (respecting the same idle/TUI guards as the queue), skipping the bot's own posts and system events,
  de-duplicating by timestamp, and decoding Slack markup. Two transports:
  - **Socket Mode (preferred)** — when an app-level token (`xapp-…`, scope `connections:write`) is
    available via `SLACK_APP_TOKEN`, the app opens a persistent
    **WebSocket** (`apps.connections.open`) that Slack keeps alive with ping/pong and pushes messages
    in real time. Drops auto-reconnect with backoff (and fall back to polling if a socket can't be
    re-established). Requires Socket Mode + message events enabled on the Slack app.
  - **Polling (fallback)** — without an app token it fetches new messages on an interval (3/5/10/30 s).
  The status chip shows which transport is live (`live (socket)` / `live (poll)`).
- The agent's terminal output is captured, cleaned (ANSI/box-drawing stripped, blank lines collapsed,
  length-capped), chunked to Slack's limit, and **posted back in-thread** — toggleable with **Post
  Claude's replies back to Slack**.
- A built-in **composer** lets you send messages to the channel directly. Slack config is remembered
  per project, and a dot on the tab indicates live listening.

---

## Data & files written

| Location | What | Written by |
|----------|------|-----------|
| `<userData>/session.json` | List of open folders (restored on launch) | app |
| `<userData>/status.json` | Active AWS env/role/expiration | `lib/aws.js` |
| `<project>/.claude-logs/logs/prompt_history.json` | Per-project prompt history | app |
| `~/.aws/config` | Adds `[sso-session claude-cmd-ui]` + a `[profile sso-<account>]` per account you sign into | `lib/aws.js` |
| `~/.aws/credentials` | Rewrites `[default]` & `[ohq-dev]` (backed up once first) | `lib/aws.js` |
| `<project>/.gitignore` | Appended when you use the ignore menu | app |

`<userData>` is Electron's per-user app data directory.

---

## The prompt-logs Lambda

`lambda/prompt-logs/` is an **optional** AWS Lambda that mirrors prompt history into CloudWatch Logs,
keyed by `username__project` log streams. It supports:

- `GET {endpoint}?username=…&project=…` → returns the stored entries (used by the in-app **cloud
  sync** to repopulate local history).
- `POST {endpoint}` → appends an entry (the in-app posting path has been removed; the Lambda still
  accepts POSTs if you wire one up).

Configure it with `LOG_GROUP`, `AWS_REGION`, and an optional `API_KEY` (sent as `X-Api-Key`). The
client side lives in `lib/cloud-logs.js`, which reads `CLOUD_LOG_ENDPOINT`, `CLOUD_LOG_API_KEY`, and
`CLOUD_LOG_USERNAME` from the environment.

---

## Security notes

This is an internal tool with several sharp edges worth calling out:

- **Hardcoded paths:** the AWS CLI, Git Bash, SSO start URL, and account IDs are baked into
  `lib/aws.js` / `lib/pty.js`.
- **Default cloud-log credentials:** `lib/cloud-logs.js` ships with a default endpoint and API key.
  Override them with env vars (or leave cloud sync unused).
- **Credential rewriting:** the AWS switcher overwrites your `~/.aws/credentials` `[default]` and
  `[ohq-dev]` profiles. A one-time backup (`credentials.bak.<timestamp>`) is created before the first
  rewrite.
- **Protected branches:** direct commits to `main`/`master` are refused by the Commit & Push flow.

---

## Keyboard shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+F` | File Explorer | Open the find bar (editor scope if the cursor is in the editor) |
| `Ctrl+S` | File editor | Save the open file |
| `Enter` / `Shift+Enter` | Find input | Next / previous match |
| `Esc` | Find input | Close the find bar |
| `Ctrl+Enter` | Queue editor | Add the prompt to the queue |
| `Enter` / `Shift+Enter` | Slack composer | Send / newline |
| `Ctrl+V`, `Shift+Insert` | Terminals | Paste |
| `Ctrl+Shift+C`, `Ctrl+Insert` | Terminals | Copy selection |
| `Ctrl+Shift+I` / `F12` | Anywhere | Toggle DevTools |

---

## Project layout

```
claude-cmd-ui/
├── main.js                  # Main process: window, PTYs, all IPC handlers
├── preload.js               # contextBridge → window.api
├── lib/
│   ├── pty.js               # cmd / bash / worker PTY spawning + CLI auto-launch
│   ├── aws.js               # SSO login, role selection, credential rewrite
│   ├── slack.js             # Slack Web API client
│   └── cloud-logs.js        # Optional prompt-logs Lambda client (cloud sync)
├── renderer/
│   ├── index.html           # Layout + per-tab workspace template
│   ├── renderer.js          # All UI behavior (~5k lines)
│   └── styles.css           # Theme
├── lambda/
│   └── prompt-logs/         # Optional CloudWatch-backed prompt log store
├── run.bat                  # Convenience launcher (npm run start)
└── package.json
```

---

*Built with Electron, xterm.js, and `@lydell/node-pty`. Internal tool — UNLICENSED / private.*
