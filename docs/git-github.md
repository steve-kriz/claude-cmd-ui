# Git & GitHub integration

## What it does and why

The Git tab is a project cockpit for version control: branch tracking, commit &
push with protected-branch guards, publishing a folder as a new GitHub repo,
pull-request review, and dispatching GitHub Actions `workflow_dispatch`
workflows. It lets you go from local changes to a pushed branch, a PR, and a
triggered deploy without leaving the app.

## How it works

Git operations shell out to `git` via `execFile`; GitHub operations shell out to
the GitHub CLI (`gh`). All handlers are in [`main.js`](../main.js); the UI is in
[`renderer/renderer.js`](../renderer/renderer.js). Long-running operations stream
progress over the `gitops:log` event channel (`api.gitops.onLog`).

- **Sign-in gate** — `github:checkGh` runs `gh --version` and `gh auth status`;
  when `gh` is missing or unauthenticated the tab shows a sign-in prompt.
- **Branch info** — `git:repoInfo`, `git:listBranches`, and `git:aheadBehind`
  report the current branch, upstream header, and ahead/behind counts versus the
  detected trunk. Trunk resolution (`resolveTrunkRef`) prefers `origin/HEAD`,
  then `main`/`master`/`trunk`/`develop` on the remote, then locally.
- **Commit & Push** — `git:commitPush` optionally `git init`s, checks out or
  creates a branch, stages all (`git add -A`), commits, and pushes (with optional
  `-u`). **Protected branches (`main`/`master`) are refused**
  (`isProtectedBranch`) — you must create a new branch. Nothing-staged commits
  are skipped with a warning; a missing `origin` skips the push.
- **Publish** — `github:listOwners` lists your account and orgs;
  `github:publish` `git init`s if needed, makes an initial commit if there are no
  commits, and runs `gh repo create <name> <visibility> --source . --remote origin --push`,
  then reports the repo URL. Refuses if an `origin` remote already exists.
- **Pull requests** — `github:createPR` (`gh pr create`), `github:listPRs`
  (`gh pr list`), and `github:prInfo` (`gh pr view` + a `gh api …/pulls/N/comments`
  call for inline file:line comments). The renderer's **Send to Claude** bundles
  a PR's reviews/comments/inline comments into a single prompt and queues it (see
  [`prompt-queue.md`](prompt-queue.md)).
- **Run Action** — `github:listWorkflows` (`gh workflow list`),
  `github:workflowInputs` parses `workflow_dispatch` inputs (text / boolean /
  choice-with-options) straight from the workflow YAML, and `github:runWorkflow`
  runs `gh workflow run` with `-f key=value` fields and reports the run URL. For
  workflows targeting named environments, `github:recentEnvDeployments` parses
  the `environment:` refs and queries `gh api …/deployments` for deploys in the
  last 24 h so you can see who deployed what before triggering.

## Usage

From the UI: open the **Git** tab (sign in with `gh` if prompted), then use
Commit & Push / Publish / Pull Request / Run Action. Bridge calls
(see [`ipc-bridge.md`](ipc-bridge.md)):

```js
const gh = await window.api.github.checkGh();          // { installed, authed, user }
const ab = await window.api.git.aheadBehind(cwd);      // { ahead, behind, trunkName, ... }

// commit & push onto a new branch (main/master are refused)
const off = window.api.gitops.onLog(({ line }) => console.log(line));
await window.api.git.commitPush({
  id: 'op1', cwd, branch: 'feature/x', newBranch: true,
  commitMessage: 'Add X', stageAll: true, push: true, setUpstream: true
});
off();

// dispatch a workflow_dispatch workflow
const wfs = await window.api.github.listWorkflows(cwd);
const inputs = await window.api.github.workflowInputs(cwd, wfs.workflows[0].path);
await window.api.github.runWorkflow({ id: 'op2', cwd, workflow: 'deploy.yml',
  ref: 'main', inputs: [{ key: 'environment', value: 'staging' }] });
```

## Configuration

No env vars. Requires **Git for Windows** (all `git:*` channels) and, for the
GitHub features, the **GitHub CLI (`gh`)** installed and authenticated
(`gh auth login`). Protected branch names are `['main', 'master']`
(`PROTECTED_BRANCHES` in `main.js`).

## API reference

| Channel | `window.api` | Result |
|---------|--------------|--------|
| `git:repoInfo` | `git.repoInfo(cwd)` | `{ isRepo, branch, originUrl, hasCommits }` |
| `git:listBranches` | `git.listBranches(cwd)` | `{ branches, current }` |
| `git:aheadBehind` | `git.aheadBehind(cwd)` | `{ ahead, behind, trunk, trunkName, onTrunk }` |
| `git:commitPush` | `git.commitPush(opts)` | `{ ok }` (streams `gitops:log`) |
| `github:checkGh` | `github.checkGh()` | `{ installed, authed, user, statusText }` |
| `github:listOwners` | `github.listOwners()` | `{ user, orgs }` |
| `github:publish` | `github.publish(opts)` | `{ ok, repoUrl }` |
| `github:listWorkflows` | `github.listWorkflows(cwd)` | `{ workflows }` |
| `github:workflowInputs` | `github.workflowInputs(cwd, path)` | `{ inputs }` |
| `github:runWorkflow` | `github.runWorkflow(opts)` | `{ ok, run }` |
| `github:recentEnvDeployments` | `github.recentEnvDeployments(cwd, path, inputs)` | `{ deployments, environments }` |
| `github:createPR` | `github.createPR(opts)` | `{ ok, pr }` |
| `github:listPRs` | `github.listPRs(cwd, state)` | `{ prs }` |
| `github:prInfo` | `github.prInfo(cwd, branch)` | `{ pr }` (incl. `inlineComments`) |

## Edge cases, limitations & troubleshooting

- **`gh` not installed / not authenticated** — GitHub operations throw with an
  actionable message (`Install from https://cli.github.com/` /
  `Run: gh auth login`); the tab gates behind the sign-in check.
- **Direct commit to `main`/`master`** is refused; create a new branch.
- **Publish over an existing `origin`** is refused — use Commit & Push instead.
- **Workflow YAML parsing is best-effort** — inputs/environments are parsed from
  the local file; a workflow not present locally yields empty inputs with a note.
- **`prInfo` with no PR** returns `{ ok: true, pr: null }` rather than an error.
