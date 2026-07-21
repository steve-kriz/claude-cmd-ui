# Assets mirror auto-sync

## What it does and why

The repo keeps **two** copies of the orchestrate instruction files:

- the **live** ones the app reads and writes under a project's `.claude/`, and
- a byte-identical **`assets/`** copy that ships with the installer.

Drift-guard tests (e.g. `test/orchestrate-agents.test.js`,
`test/orchestrate-swarm.test.js`) assert the two copies are equal. So whenever the
app writes one of the mirrored files — for example editing an agent description or
model on the [Team tab](team-tab.md) — it must write **both** copies, or the
mirror drifts and the tests fail.

This feature is the tiny path-mapping module plus the renderer's mirror-aware
writer that keep the two subtrees in sync automatically.

## How it works

### The mapping — `lib/assets-mirror.js`

[`lib/assets-mirror.js`](../lib/assets-mirror.js) is pure, Electron-free, and
never throws. It maps a project-root-relative path to its `assets/…` mirror path
for the two mirrored subtrees, or returns `null` for anything else:

```
MIRRORED_SUBTREES = [
  { from: '.claude/agents/',              to: 'assets/agents/' },
  { from: '.claude/skills/orchestrate/',  to: 'assets/skills/orchestrate/' },
]
```

`mirrorRelPath(relPath)`:

- `'.claude/agents/ba.md'` → `'assets/agents/ba.md'`
- `'.claude\\skills\\orchestrate\\SKILL.md'` → `'assets/skills/orchestrate/SKILL.md'`
- `'.claude/settings.json'` → `null` (not mirrored)
- `'tasks/x.md'` → `null`

It normalises `\`→`/`, tolerates a leading `./` and leading slashes, requires a
non-empty remainder (the directory itself never maps to a file), and maps paths
only — it **never** touches the filesystem, so it never creates a mirror. The
caller checks the mirror exists before writing it.

### The writer — `writeWithMirror` (renderer)

The renderer duplicates the mapping (`ASSETS_MIRRORED_SUBTREES` /
`mirrorRelPath`, KEEP-IN-SYNC with the lib module — a browser script cannot
`require` Node) and wires it into `writeWithMirror(tab, absPath, content)`, the
writer every Team-tab save uses (agent description, agent model, add agent):

1. Write the **primary** file. If that fails, return the failure — **no** mirror
   write is attempted.
2. Map the path (`relFromFolder` → `mirrorRelPath`). No mapping → return
   `{ ...primary, mirrored: false }`.
3. If the mirror file does **not** already exist → return `{ ...primary,
   mirrored: false }`. It **never creates** a mirror that did not exist (so a
   brand-new agent, which has no `assets/` copy, is a natural no-op).
4. Mirror exists and writes OK → `{ ok: true, mirrored: true, mirrorPath }`.
5. Mirror exists but its write **fails** → `{ ok: false, primaryOk: true,
   mirrorPath, mirrorError }` — the primary write stands and the caller shows a
   drift warning naming both paths.

## Usage

This is automatic and internal — there is no UI control. Any save through the
Team tab's agent editors routes through `writeWithMirror`. To confirm the mirror
is healthy, run the drift-guard tests:

```bash
node --test test/orchestrate-agents.test.js
```

## Inputs and outputs

- **Input:** an absolute path inside the project folder + file content.
- **Output:** the primary file always; the `assets/` twin **only when it already
  exists**. A result object reports `mirrored` / `primaryOk` / `mirrorError` /
  `mirrorPath` so the UI can message drift precisely.

## Edge cases and limitations

- **New files are not mirrored** (no pre-existing twin to sync) — this is by
  design; the installer, not the app, seeds `assets/`.
- **Only two subtrees are mirrored** (`.claude/agents/`,
  `.claude/skills/orchestrate/`); `.claude/settings.json`, `tasks/`, etc. are not.
- **Mirror-only failure is surfaced, never swallowed** — the primary write is kept
  and the UI names both paths so a drift is visible and fixable.
- **Manual edits to `.claude/` files still require syncing `assets/`** — this
  auto-sync only covers writes the app itself performs. (See the note in the
  project README's Development section.)
- The renderer mirror of `mirrorRelPath` must be kept in lockstep with
  `lib/assets-mirror.js`.
