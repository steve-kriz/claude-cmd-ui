# Claude CMD UI

A Windows-first Electron desktop app that wraps an AI coding CLI (`claude`) and a
Git Bash terminal side-by-side, then layers a full project cockpit around them: a
file explorer with search and inline editing, a Git/GitHub panel, a diff &
merge-conflict viewer, a test runner, a Slack bridge, a ticket-driven **Tasks
kanban board** with a multi-agent "orchestrate" build workflow, and a
multi-account AWS SSO credential switcher.

The goal is to drive an AI coding agent from a single window — queue up prompts,
watch it work, review the diffs it produces, commit & push, open a PR, run a
GitHub Action, and (optionally) relay the whole conversation to and from a Slack
channel — without leaving the app.

> **Platform:** Windows only. It shells out to `cmd.exe`, Git Bash
> (`C:\Program Files\Git\bin\bash.exe`), and the AWS CLI v2 at a hardcoded path.
> macOS/Linux are not supported.

**Who it's for:** developers using an agent CLI (primarily Anthropic's `claude`)
who want a single cockpit for prompting, reviewing, versioning, and shipping.

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The window at a glance](#the-window-at-a-glance)
- [Configuration](#configuration)
- [Development and testing](#development-and-testing)
- [Tasks board & the Orchestrate workflow](#tasks-board--the-orchestrate-workflow)
- [Data and files written](#data-and-files-written)
- [Documentation](#documentation)
- [Security notes](#security-notes)
- [Project layout](#project-layout)

---

## Overview

The app follows the standard Electron split with context isolation enabled: a
privileged main process, a locked-down preload bridge, and a sandboxed renderer.
Terminals are real Windows ConPTY processes rendered with
[xterm.js](https://xtermjs.org/), so the embedded `cmd` and `bash` shells behave
like normal terminals (colours, TUIs, resize, copy/paste). Every feature is one
tab of a single window; open multiple project folders and each gets its own tab
with its own pair of terminals and its own state.

## Features

Each feature has its own page under [`docs/`](docs) — click through for details,
usage, and API/IPC references.

- **[Electron app shell & windowing](docs/app-shell.md)** — the main process,
  the single window, lifecycle, and per-folder session persistence.
- **[IPC bridge (`window.api`)](docs/ipc-bridge.md)** — the `contextBridge`
  surface the renderer uses to reach every privileged operation.
- **[Terminals & PTY integration](docs/terminals.md)** — the `cmd`/`claude`,
  Git Bash, and worker (`gemini`/`codex`) panes, with CLI auto-launch and idle
  detection.
- **[Prompt queue](docs/prompt-queue.md)** — line up prompts and auto-dispatch
  them one at a time as the agent goes idle.
- **[Prompt history & cloud sync](docs/prompt-history.md)** — per-project prompt
  log with token/cost estimates and optional Lambda-backed sync.
- **[File Explorer, editor & search](docs/file-explorer.md)** — lazy tree, inline
  editor, content/file search, and a **Show preview** toggle that renders `.md`
  files as formatted HTML and back to raw source (dependency-free, no new npm
  dependency).
- **[Git & GitHub integration](docs/git-github.md)** — branch tracking, commit &
  push (protected-branch guards), publish, pull requests, and Actions dispatch.
- **[Change Viewer](docs/change-viewer.md)** — colorized diffs and an interactive
  merge-conflict resolver.
- **[Tests tab](docs/tests-tab.md)** — discover and run unit vs. UI/e2e tests.
- **[AWS SSO environment switcher](docs/aws-sso.md)** — discover accounts, pick a
  role, and rewrite `~/.aws/credentials`.
- **[Slack bridge](docs/slack-bridge.md)** — two-way channel/agent proxy via a
  `SLACK_TOKEN` bot token or the **Sign in with Slack** OAuth flow.
- **[Tasks board & the Orchestrate workflow](docs/orchestrate-workflow.md)** —
  the ticket-driven kanban board and its multi-agent build swarm.
- **[Keep-awake wake-lock](docs/keep-awake.md)** — hold the OS awake while builds
  run.
- **[Configuration & environment](docs/configuration.md)** — every env var and
  state file in one place.

![The Git tab showing branch info, commit & push controls, and GitHub actions.](images/github_view.png)

*The Git/GitHub panel — branch tracking, commit & push, publish, pull requests, and workflow dispatch.*

## Architecture

- **[`main.js`](main.js)** — the main (Node) process. Owns the `BrowserWindow`,
  spawns PTYs, and implements every privileged operation behind
  `ipcMain.handle(...)` channels: folder picking, filesystem helpers
  (read/write/rename/grep/find), Git (via `execFile('git', …)`), GitHub via the
  `gh` CLI, prompt-history persistence, and the AWS/Slack bridges.
- **[`preload.js`](preload.js)** — the secure bridge. Uses `contextBridge` to
  expose a single `window.api` object; the renderer never touches Node directly.
- **[`renderer/`](renderer)** — the UI (plain HTML/CSS/JS, no framework).
  `index.html` defines the layout and a per-tab `<template>`; `renderer.js`
  drives all interaction; `styles.css` themes it.
- **[`lib/`](lib)** — Electron-free main-process helpers: `pty.js` (PTY spawn +
  CLI auto-launch), `aws.js` (SSO), `slack.js` / `slack-oauth.js` /
  `slack-proxy.js` (Slack), `env-store.js` (`.env`), `cloud-logs.js` (cloud
  sync), `markdown.js` (preview renderer), `keep-awake.js` (wake-lock decision),
  `orchestrate-agents.js`, and the `ticket-*.js` board helpers.
- **[`.claude/skills/orchestrate/`](.claude/skills/orchestrate/SKILL.md) +
  `.claude/agents/`** — the orchestrate skill and the subagent definitions.
- **[`lambda/prompt-logs/`](lambda/prompt-logs/index.mjs)** — an optional AWS
  Lambda that stores prompt history in CloudWatch Logs.

## Requirements

| Tool | Why | Notes |
|------|-----|-------|
| **Node.js + npm** | Build/run the app | Ships Electron `^34.5.8` |
| **Git for Windows** | Git Bash terminal + all Git operations | Expected at `C:\Program Files\Git\bin\bash.exe` |
| **`claude` CLI** | The AI agent that runs in the cmd pane | Optional — the app offers to install it if missing |
| **GitHub CLI (`gh`)** | Publish, PRs, Actions | Optional — only the Git tab needs it |
| **AWS CLI v2** | SSO account/role switching | Expected at `C:\Program Files\Amazon\AWSCLIV2\aws.exe` |
| **`gemini` / `codex`** | Optional worker CLIs | Only if you use the worker shell |

Runtime dependencies (from [`package.json`](package.json)): `@lydell/node-pty`
`^1.1.0`, `@xterm/xterm` `^5.5.0`, `@xterm/addon-fit` `^0.10.0`. Dev/build:
`@electron-forge/cli` `^7.6.0`, `electron` `^34.5.8`.

Most integrations degrade gracefully: if `gh`, `claude`, or AWS aren't present,
the rest of the app still works and the relevant tab shows install/sign-in
guidance.

## Installation

```bash
npm install
```

## Quick start

```bash
npm run start      # launches via electron-forge (run.bat does the same)
```

On first launch you'll see an empty state — open a project folder from the UI.
Open folders are remembered and reopened on the next launch. DevTools open
automatically (detached); set `OPEN_DEVTOOLS=0` to suppress that, and use
`Ctrl+Shift+I` or `F12` to toggle them.

## The window at a glance

![The main working screen: the claude REPL on the left, a right-hand tabbed surface, and the workspace tabs across the top.](images/working_screen1.jpg)

*The main working screen — the `claude` REPL on the left, the tabbed right-hand surface, and the queue/logs panels below.*

- **Left pane:** the `cmd` terminal running `claude`, plus the prompt **Queue**
  and **Logs** panels.
- **Right pane:** a tabbed surface — Git Bash, File Explorer, Slack, Git, Change
  Viewer, Tests, and the **Tasks** board.
- A draggable **splitter** sets the left/right ratio; terminals re-fit on release.

Each workspace tab carries a **status dot** (idle / busy / waiting / finished) and
a badge showing the number of queued prompts.

![A workspace tab showing the green "finished" status dot after the agent goes idle.](images/tab_finished_work.jpg)

*A tab flips to the green **finished** state once the agent goes idle after producing output.*

![The prompt queue panel with several prompts queued up to feed the agent one at a time.](images/queue_up_prompts.jpg)

*Queue up prompts and let the app auto-dispatch them one at a time as the agent goes idle.*

## Configuration

Secrets and settings come from a project-root `.env` file (read/written by
[`lib/env-store.js`](lib/env-store.js)); see
[docs/configuration.md](docs/configuration.md) for the full reference. Key
variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPEN_DEVTOOLS` | (unset → open) | Set `0` to stop DevTools opening on launch |
| `AWS_SSO_START_URL` | (required for AWS) | SSO portal start URL; prompted and saved on first use |
| `AWS_DEV_ACCOUNT_ID` / `AWS_PROD_ACCOUNT_ID` | (none) | Account ids for legacy profile sync |
| `SLACK_TOKEN` | (required to connect) | Slack bot token `xoxb-…` (or user token `xoxp-…` written by OAuth) |
| `SLACK_APP_TOKEN` | (none) | App-level token `xapp-…` to enable Socket Mode |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | (none) | OAuth app credentials for **Sign in with Slack** |
| `CLOUD_LOG_ENDPOINT` | (unset → disabled) | Prompt-logs Lambda URL for cloud sync |
| `CLOUD_LOG_API_KEY` / `CLOUD_LOG_USERNAME` | (none / OS user) | Cloud-sync secret and username tag |

State that is not in `.env` lives as JSON in Electron's userData dir
(`session.json`, `status.json`) — see [Data and files written](#data-and-files-written).

## Development and testing

```bash
npm run start      # run the app (electron-forge start)
npm run package    # package the app with electron-forge
npm run make       # build distributables
npm test           # run the test suite: node --test "test/**/*.test.js"
```

Tests are plain [`node --test`](https://nodejs.org/api/test.html) suites in
[`test/`](test) — no extra test-runner dependency. The Electron-free `lib/`
modules (`ticket-*.js`, `keep-awake.js`, `markdown.js`, `slack-*.js`,
`env-store.js`, …) are unit-testable in isolation; run a single file with, e.g.:

```bash
node --test test/ticket-queue.test.js
```

> **Note:** editing any instruction file under `.claude/` requires syncing its
> byte-for-byte copy under `assets/` or the drift-guard tests fail.

## Tasks board & the Orchestrate workflow

The **Tasks** tab is a live kanban board for ticket-driven development: you plan a
feature into tickets, review them, and let a set of AI subagents build, test, and
review them while you watch progress move across the lanes. Full details are in
[docs/orchestrate-workflow.md](docs/orchestrate-workflow.md).

![The Tasks kanban board showing tickets moving across the todo, defining, in-progress, testing, post-processing and done lanes.](images/workflow_task_view.png)

*The Tasks board — one lane per status, with per-ticket build time, cost, and token markers.*

**Tickets are files** under `tasks/` with flat frontmatter (`id`, `title`,
`status`, `created`, `updated`, plus optional extras) and `## Description`,
`## Acceptance Criteria`, `## Cucumber Tests`, and a user-owned
`## Additional Context` section.

**Six lanes**, left to right:
`todo → defining → in-progress → testing → post-processing → done`. The
`failed-testing` status is still valid and claimable but has no dedicated lane —
its cards fold into **testing** with a red marker.

**Agent roles** driven by the `orchestrate` skill
([`.claude/skills/orchestrate/SKILL.md`](.claude/skills/orchestrate/SKILL.md)):
the **business-analyst** turns a request into tickets, the **coder** implements
one ticket in its own isolated branch/worktree, the **tester** writes e2e cucumber
+ unit tests, and a **tech-lead** reviews before done. Drive it with
`/orchestrate plan <feature>`, `/orchestrate build`, and `/orchestrate status`.

**Accounting.** Each ticket records how long its build took and what it cost — the
board shows per-ticket **build time**, **cost**, and estimated **token** usage,
and every re-run appends to a durable run log.

## Data and files written

| Location | What | Written by |
|----------|------|-----------|
| `<userData>/session.json` | List of open folders (restored on launch) | app |
| `<userData>/status.json` | Active AWS env/role/expiration | `lib/aws.js` |
| `<project>/.claude-logs/logs/prompt_history.json` | Per-project prompt history | app |
| `<project>/tasks/<status>/TASK-*.md` | Ticket files (one subfolder per status) | orchestrate workflow |
| `~/.aws/config` | `[sso-session claude-cmd-ui]` + a `[profile sso-<account>]` per account | `lib/aws.js` |
| `~/.aws/credentials` | Rewrites the chosen profile and `[default]` (backed up once first) | `lib/aws.js` |
| `<project>/.gitignore` | Appended when you use the ignore menu | app |

`<userData>` is Electron's per-user app-data directory.

## Documentation

The full per-feature documentation set lives in [`docs/`](docs):

| Page | What it covers |
|------|----------------|
| [docs/app-shell.md](docs/app-shell.md) | Electron main process, window, lifecycle, session persistence |
| [docs/ipc-bridge.md](docs/ipc-bridge.md) | The `window.api` preload bridge and full channel catalogue |
| [docs/terminals.md](docs/terminals.md) | PTY spawning, CLI auto-launch, idle/status detection |
| [docs/prompt-queue.md](docs/prompt-queue.md) | Queuing prompts and idle-gated auto-dispatch |
| [docs/prompt-history.md](docs/prompt-history.md) | Prompt log, token/cost estimates, cloud sync + Lambda |
| [docs/file-explorer.md](docs/file-explorer.md) | Tree, editor, search, safe Markdown preview |
| [docs/git-github.md](docs/git-github.md) | Commit/push, publish, PRs, Actions dispatch |
| [docs/change-viewer.md](docs/change-viewer.md) | Diffs and interactive merge-conflict resolver |
| [docs/tests-tab.md](docs/tests-tab.md) | Discovering and running project tests |
| [docs/aws-sso.md](docs/aws-sso.md) | SSO login, account/role selection, credential rewrite |
| [docs/slack-bridge.md](docs/slack-bridge.md) | Slack Web API client, OAuth, two-way thread proxy |
| [docs/orchestrate-workflow.md](docs/orchestrate-workflow.md) | Tasks board, ticket contract, build swarm |
| [docs/keep-awake.md](docs/keep-awake.md) | OS wake-lock while builds run |
| [docs/configuration.md](docs/configuration.md) | Every env var and state file |

## Security notes

This is an internal tool with several sharp edges worth calling out:

- **Hardcoded paths:** the AWS CLI, Git Bash, SSO region, and session name are
  baked into `lib/aws.js` / `lib/pty.js`.
- **Credential rewriting:** the AWS switcher overwrites your `~/.aws/credentials`
  `[default]` (and chosen) profile. A one-time backup
  (`credentials.bak.<timestamp>`) is created before the first rewrite.
- **Protected branches:** direct commits to `main`/`master` are refused by the
  Commit & Push flow.
- **Safe Markdown preview:** the preview renderer HTML-escapes source before any
  transform and scheme-checks link/image URLs, so raw HTML or a `javascript:` URL
  can never execute.
- **`.env` holds secrets** (Slack tokens, cloud-log API key) — keep it out of
  version control.

## Project layout

```
claude-cmd-ui/
├── main.js                  # Main process: window, PTYs, all IPC handlers
├── preload.js               # contextBridge → window.api
├── lib/
│   ├── pty.js               # cmd / bash / worker PTY spawning + CLI auto-launch
│   ├── aws.js               # SSO login, role selection, credential rewrite
│   ├── slack.js             # Slack Web API client (incl. thread replies)
│   ├── slack-oauth.js       # "Sign in with Slack" OAuth v2 flow
│   ├── slack-proxy.js       # Two-way Slack/Claude thread proxy logic
│   ├── env-store.js         # Read/write .env values
│   ├── cloud-logs.js        # Optional prompt-logs Lambda client (cloud sync)
│   ├── markdown.js          # Dependency-free Markdown → HTML (preview)
│   ├── keep-awake.js        # Wake-lock decision (pure)
│   ├── orchestrate-agents.js# Subagent type names + missing-agent fallback
│   ├── tasks-settings.js    # Parallel-build concurrency option helpers
│   ├── ticket-lanes.js      # Status enum + board lanes
│   ├── ticket-folders.js    # Folder-per-status reconciliation
│   ├── ticket-queue.js      # Concurrency, claims, isolation, ordering
│   ├── ticket-accounting.js # Per-ticket build time & cost
│   ├── ticket-runs.js       # Durable per-run accounting log
│   ├── ticket-questions.js  # Clarifying question / answer
│   └── ticket-history.js    # Append to a ticket's ## History
├── renderer/
│   ├── index.html           # Layout + per-tab workspace template
│   ├── renderer.js          # All UI behavior
│   └── styles.css           # Theme
├── docs/                    # Per-feature documentation (this set)
├── .claude/
│   ├── skills/orchestrate/  # The orchestrate skill (SKILL.md)
│   └── agents/              # ba / coder / tester / tech-lead subagent definitions
├── tasks/                   # Ticket files for the Tasks board (one subfolder per status)
├── lambda/
│   └── prompt-logs/         # Optional CloudWatch-backed prompt log store
├── test/                    # node --test suites
├── run.bat                  # Convenience launcher (npm run start)
└── package.json
```

---

*Built with Electron, xterm.js, and `@lydell/node-pty`. Internal tool — UNLICENSED / private.*
