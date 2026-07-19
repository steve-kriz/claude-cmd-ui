# Change Viewer (diff & merge-conflict resolver)

## What it does and why

The Change Viewer lists every changed file in the open repo, shows colorized
diffs, and provides an interactive resolver for merge conflicts — so you can
review and untangle a messy working tree without dropping to the command line.

## How it works

The UI is in [`renderer/renderer.js`](../renderer/renderer.js); Git operations
are main-process IPC in [`main.js`](../main.js) (all via `execFile('git', …)`).

- **Change list** — `git:status` parses `git status --branch --porcelain=v1`
  into `{ branch, header, entries: [{ x, y, path }], raw }`. Conflicted files
  (status codes) are flagged with a **CONFLICT** tag; a badge on the tab shows the
  change count.
- **Diffs** — `git:diff` returns staged and unstaged sections
  (`### Staged` / `### Unstaged`); untracked files are rendered as all-additions
  by reading the file and prefixing `+`.
- **Ignore menu** — right-click a file to append a pattern to `.gitignore` via
  `git:ignore` with `mode`:
  - `file` → ignore just that file (`/src/utils/log.js`)
  - `folder` → ignore its immediate parent folder (`/src/utils/`)
  - `root` → ignore its top-level folder (`/src/`)
  Duplicate patterns are detected and not re-added.
- **Merge-conflict resolver** — for each conflict block, choose
  **ours / theirs / both / neither**, with a running "N/M resolved" summary and
  bulk actions. **Save** writes your choices; **Save & mark resolved** also runs
  `git add` (`git:add`) once everything is resolved. Binary conflicts offer
  `git:checkoutSide` (`--ours` / `--theirs`, then `git add`). **Abort merge**
  (`git:abortMerge`) cleanly aborts an in-progress merge, rebase, or cherry-pick.
- **Recent check-ins** — `git:recentCommits` and `git:commitShow` back an
  expandable commit list with per-commit diff and changed files (shared with the
  Git tab, see [`git-github.md`](git-github.md)).

## Usage

From the UI: open the **Change Viewer** tab, click a file to see its diff,
right-click for the ignore menu, and use the conflict resolver on conflicted
files. Bridge calls (see [`ipc-bridge.md`](ipc-bridge.md)):

```js
const status = await window.api.git.status(cwd);                 // { ok, branch, entries, ... }
const diff = await window.api.git.diff(cwd, 'src/app.js', false); // { ok, diff }
await window.api.git.ignore(cwd, 'src/utils/log.js', 'folder');   // -> ignores /src/utils/
await window.api.git.checkoutSide(cwd, 'src/app.js', 'ours');     // resolve binary conflict
const aborted = await window.api.git.abortMerge(cwd);             // { ok, kind } | { ok:false }
```

## Configuration

None. Requires Git for Windows on PATH (used by every `git:*` channel).

## API reference (Git IPC)

| Channel | `window.api.git` | Result |
|---------|-------------------|--------|
| `git:status` | `status(cwd)` | `{ ok, branch, header, entries, raw }` |
| `git:diff` | `diff(cwd, file, untracked)` | `{ ok, diff }` |
| `git:ignore` | `ignore(cwd, file, mode)` | `{ ok, pattern, alreadyPresent? }` |
| `git:add` | `add(cwd, file)` | `{ ok }` |
| `git:checkoutSide` | `checkoutSide(cwd, file, side)` | `{ ok }` (`side` = `ours`/`theirs`) |
| `git:abortMerge` | `abortMerge(cwd)` | `{ ok, kind }` or `{ ok:false, error }` |
| `git:recentCommits` | `recentCommits(cwd, limit)` | `{ ok, commits }` |
| `git:commitShow` | `commitShow(cwd, hash)` | `{ ok, files, diff }` |

## Edge cases, limitations & troubleshooting

- **Ignoring a root-level file** — `folder`/`root` modes throw when the file has
  no containing/top-level folder ("This file is at the repository root …").
- **`checkoutSide`** only accepts `ours` or `theirs`; anything else throws.
- **Abort with nothing in progress** — `git:abortMerge` returns
  `{ ok: false, error: 'No merge/rebase/cherry-pick in progress.' }`.
- **`commitShow` validates the hash** (`/^[0-9a-f]{4,40}$/i`) before running.
- **Untracked file diffs** are synthesized (all `+` lines); binary/unreadable
  untracked files show a `(binary or unreadable: …)` placeholder.
