# Tests tab (test runner)

## What it does and why

The Tests tab scans the open project for test files, splits them into unit vs.
UI/e2e groups, and gives each a **Run** button (and each group a **Run all**)
that dispatches the right test command into the Git Bash pane. It turns "find and
run the tests" into one click, and can ask the agent to fill coverage gaps.

## How it works

Implemented in [`renderer/renderer.js`](../renderer/renderer.js), backed by the
`fs:findByExt` IPC handler in [`main.js`](../main.js) and the Git Bash terminal
(see [`terminals.md`](terminals.md)).

- **Discovery** — the renderer finds test files by extension and path hints and
  classifies them:
  - **Unit**: `.test.*`, `.spec.*` (js/ts/jsx/tsx/mjs/cjs).
  - **UI/e2e**: `.cy.*`, `.e2e.*`, `.feature`, and files under path hints like
    `e2e/`, `cypress/`, `playwright/`.
- **Run** — clicking Run resolves a command appropriate to the project
  (`package.json` scripts / Jest / Vitest / Playwright / Cypress, etc.) and
  dispatches it to the bash pane via the prompt-queue editor (`buildRunPrompt`),
  so the actual run happens in a real terminal.
- **UI toggles** — UI tests add a **headed** toggle (appends `--headed` for
  Playwright, `--headed --no-exit` for Cypress) and a **watch** toggle that
  streams output into an inline panel rather than switching to the terminal.
- **Update unit tests** — queues a multi-step prompt asking the agent to audit
  and fill coverage gaps. When no UI/e2e tests exist, the "create UI tests"
  action asks for a Cucumber `.feature`-driven suite.

## Usage

From the UI: open the **Tests** tab, click **Run** on a file or **Run all** on a
group; toggle **headed**/**watch** for UI tests; click **Update unit tests** to
have the agent scaffold coverage. The discovery scan uses:

```js
const found = await window.api.fs.findByExt('C:/projects/my-app', '.test.js');
// { ok, files: [...], dirs: [...] }
```

This project itself uses the built-in Node test runner:

```bash
npm test          # runs: node --test "test/**/*.test.js"
```

## Configuration

None (no env vars). The recognised test extensions and path hints are constants
in `renderer/renderer.js` (`.spec.*`, `.cy.*`, `.e2e.*`, `.feature`, etc.). The
resolved run command depends on the target project's `package.json`.

## Inputs / outputs

- **Input:** the open project folder (scanned for test files).
- **Output:** a test command dispatched into the Git Bash pane (or an inline
  watch panel), plus optional agent prompts for coverage.

## Edge cases, limitations & troubleshooting

- **No tests found** — the group is empty; the "create tests" action queues a
  prompt to scaffold a suite (Cucumber `.feature` files for UI).
- **Command resolution is heuristic** — it infers Jest/Vitest/Playwright/Cypress
  from the project; verify the dispatched command in the bash pane before it
  runs.
- **Runs happen in the terminal** — the tab dispatches the command; it does not
  capture pass/fail itself (except the inline **watch** panel for UI tests).
