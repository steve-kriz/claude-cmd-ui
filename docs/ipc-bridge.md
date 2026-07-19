# IPC bridge (`window.api`)

## What it does and why

The renderer runs with `nodeIntegration: false` and `contextIsolation: true`, so
it cannot touch Node or Electron APIs directly. Every privileged operation is
brokered through a single, explicit bridge object, `window.api`, exposed by
[`preload.js`](../preload.js) with `contextBridge.exposeInMainWorld`. Each method
is a thin wrapper over an `ipcRenderer.invoke(...)` (request/response) or
`ipcRenderer.on(...)` (event stream) that lands on an `ipcMain.handle(...)` /
`ipcMain.on(...)` handler in [`main.js`](../main.js).

This is the security boundary: the renderer can only do what the bridge allows,
and the bridge names every channel it forwards.

## How it works

- **Invoke channels** return a Promise. The main-process handlers use a
  consistent `{ ok: true, ... }` / `{ ok: false, error }` result convention for
  fallible operations.
- **Event channels** (`onData`, `onLog`, `onStatus`, `onExit`, `onLog` for
  gitops, `onOAuthStarted`) register a listener and **return an unsubscribe
  function** that removes it — call it on teardown to avoid listener leaks.
- **Clipboard** is exposed synchronously (`api.clipboard.readText/writeText`)
  because it maps to Electron's `clipboard` module directly in the preload.

## Usage

```js
// Pick a folder, then load a directory listing.
const picked = await window.api.pickFolder();      // { path } | null
if (picked) {
  const res = await window.api.fs.readDir(picked.path);
  if (res.ok) console.log(res.entries);
}

// Spawn a terminal and stream its output.
const off = window.api.pty.onData(({ id, data }) => term.write(data));
await window.api.pty.spawn({ id: 'tab1-cmd', shell: 'cmd', cwd: picked.path, cols: 120, rows: 30 });
// later:
off();                       // unsubscribe from pty:data
await window.api.pty.kill('tab1-cmd');
```

## Configuration

None. The bridge itself takes no configuration; feature-specific env vars are
documented per feature and collected in [`configuration.md`](configuration.md).

## API reference

Grouped exactly as exposed on `window.api` in `preload.js`. All `invoke` methods
return Promises.

### Top level
- `pickFolder()` → `dialog:pickFolder`
- `setTitle(title)` → `window:setTitle`
- `openExternal(url)` → `shell:openExternal` (http/https only)
- `clipboard.readText()` / `clipboard.writeText(text)` (synchronous)

### `pty` — terminals (see [`terminals.md`](terminals.md))
- `spawn(opts)` → `pty:spawn` `{ id, shell, cwd, cols, rows, worker?, cliCommand? }`
- `write(id, data)` → `pty:write`
- `resize(id, cols, rows)` → `pty:resize`
- `kill(id)` → `pty:kill`
- `onData(cb)` / `onExit(cb)` — event streams (`pty:data`, `pty:exit`); return unsubscribe

### `fs` — filesystem (see [`file-explorer.md`](file-explorer.md))
- `readDir(path)`, `readFile(path)`, `writeFile(path, content)`, `mkdir(path)`,
  `rename(oldPath, newPath)`, `findByExt(root, ext, excludeDirs)`,
  `grep(root, query)`, `exists(path)`

### `git` — Git (see [`git-github.md`](git-github.md))
- `checkGit()`, `status(cwd)`, `diff(cwd, file, untracked)`, `repoInfo(cwd)`,
  `aheadBehind(cwd)`, `listBranches(cwd)`, `commitPush(opts)`,
  `recentCommits(cwd, limit)`, `commitShow(cwd, hash)`, `add(cwd, file)`,
  `ignore(cwd, file, mode)`, `checkoutSide(cwd, file, side)`, `abortMerge(cwd)`

### `github` — GitHub via `gh` (see [`git-github.md`](git-github.md))
- `checkGh()`, `listOwners()`, `publish(opts)`, `listWorkflows(cwd)`,
  `workflowInputs(cwd, workflowPath)`, `runWorkflow(opts)`,
  `recentEnvDeployments(cwd, workflowPath, inputs)`, `createPR(opts)`,
  `prInfo(cwd, branch)`, `listPRs(cwd, state)`

### `cli` — agent CLI detection (see [`terminals.md`](terminals.md))
- `checkClaude()`, `checkOpencode()`

### `aws` — SSO switcher (see [`aws-sso.md`](aws-sso.md))
- `listEnvironments()`, `listRoles(accountId)`,
  `applyRole(accountId, accountName, role, profile)`, `status()`,
  `listProfiles()`, `onLog(cb)`, `onStatus(cb)`

### `slack` — Slack bridge (see [`slack-bridge.md`](slack-bridge.md))
- `getToken()`, `connect(token, channel)`, `fetch(token, channel, oldest, limit)`,
  `fetchReplies(token, channel, ts, oldest, limit)`,
  `post(token, channel, text, threadTs)`, `openSocket(appToken)`,
  `startOAuth()`, `onOAuthStarted(cb)`

### `prompts` — history (see [`prompt-history.md`](prompt-history.md))
- `read(cwd)`, `append(cwd, entry)`, `write(cwd, entries)`, `clear(cwd)`,
  `syncFromCloud(cwd)`

### `tasks` — Tasks board (see [`orchestrate-workflow.md`](orchestrate-workflow.md))
- `installSkill(projectPath)` → `tasks:installSkill`
- `reportActivity(activeCount)` → `tasks:activity` (fire-and-forget `send`, no
  response; drives the wake-lock — see [`keep-awake.md`](keep-awake.md))

### `env` — `.env` values (see [`configuration.md`](configuration.md))
- `get(key)` → `env:get`, `set(key, value)` → `env:set`

### `session` — open folders (see [`app-shell.md`](app-shell.md))
- `load()`, `save(folders)`

### `gitops` — streamed git/github logs
- `onLog(cb)` — subscribes to `gitops:log` `{ id, line }`; long-running
  commit/push/publish/PR/workflow operations stream progress here

## Edge cases, limitations & troubleshooting

- **Always unsubscribe.** `onData` / `onLog` / `onStatus` / `onExit` /
  `onOAuthStarted` return a disposer; failing to call it on tab close leaks
  `ipcRenderer` listeners.
- **`tasks:activity` is `send`, not `invoke`** — it never resolves; do not
  `await` it.
- **`openExternal` rejects non-http(s) URLs** in `main.js`
  (`shell:openExternal`), so it cannot be abused to launch arbitrary schemes.
- A channel present in `preload.js` but without a matching `ipcMain` handler in
  `main.js` will reject with "No handler registered"; the preload lists a few
  git channels (`git:diff`, `git:recentCommits`, `git:add`, `git:ignore`,
  `git:checkoutSide`, `git:abortMerge`) that are all implemented in `main.js`.
