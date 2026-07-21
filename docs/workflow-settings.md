# Workflow panel (pipeline view, model editor, concurrency default)

## What it does and why

The **Workflow** panel on the [Team tab](team-tab.md) visualises the project's
orchestrate build pipeline and exposes the two settings that shape a build
without hand-editing files:

- A **read-only** view of the four ordered phases (plan → build → test → review),
  each with its dispatched agent, missing-agent fallback warnings, and (for the
  plan phase) the planning model directive.
- A guided **per-phase agent model** editor (writes only the agent file's
  `model:` line).
- A **build concurrency default** control (writes `skill.concurrencyDefault` into
  `tasks/team-config.json`).

The pipeline is parsed from the skill's prose so the panel can never drift from
what the orchestrator actually does, and it deliberately **never writes**
`SKILL.md` — that file is the workflow contract and stays read-only here.

## How it works

### The pure read-model — `lib/skill-workflow.js`

[`lib/skill-workflow.js`](../lib/skill-workflow.js) parses
`.claude/skills/orchestrate/SKILL.md` prose into an ordered workflow model:

```js
parseWorkflow(skillMd)
// → { phases: [{ key, title, agent, model?, headingLine }], warnings: [] }
```

Key points:

- **`PHASE_SPECS`** fixes the four phases (`plan`/`build`/`test`/`review`) with a
  canonical default agent per phase, sourced from `AGENT_TYPES` in
  [`lib/orchestrate-agents.js`](../lib/orchestrate-agents.js) so they stay in
  lockstep: `orchestrate-ba`, `orchestrate-coder`, `orchestrate-tester`,
  `orchestrate-tech-lead`.
- **Phase detection** is heading-based (`## Phase <n> …`) and **fence-aware**, so
  a `## ` inside a fenced code block (the sample ticket embedded in SKILL.md)
  never opens a phantom phase.
- **Agent resolution** per phase: prefer the "Agent dispatch and fallback"
  section's `Phase <n> … → orchestrate-x` line, then the phase body, then the
  canonical default.
- **Model directive** (plan phase only): if `claude-fable-5` appears, returns
  `{ primary: 'claude-fable-5', fallback: <stated or 'claude-opus-4-8'> }`
  (`PLAN_MODEL_PRIMARY` / `PLAN_MODEL_FALLBACK`).
- A phase whose heading is absent is **omitted** and named in `warnings`. Any
  non-string/garbage input yields `{ phases: [], warnings: [...] }` and never
  throws.

The renderer mirrors this parser inline (the `wf*` functions, e.g.
`wfParseWorkflow`) because a browser script cannot `require` the module — the lib
copy is the source of truth and the two are kept in lockstep.

### Rendering — `refreshTeamWorkflow` / `buildWorkflowView`

`refreshTeamWorkflow(tab)`:

1. Reads `.claude/agents/`, parsing each file to collect the set of declared
   `name:` values **and** a map from `name` → `{ filePath, parsed }`. The
   installed-agent test keys off the frontmatter `name:` (not the filename),
   matching `resolveAgentType`/`isFallback` — the bundled files ship as
   `ba.md`/`coder.md`/etc. but declare `name: orchestrate-*`.
2. Reads `tasks/team-config.json` (for the concurrency control).
3. Checks `SKILL.md` existence: **absent** → install banner; **present but
   unreadable/binary** → a warning card (never a blank panel); otherwise parses
   and renders.

Each phase card (`buildWorkflowPhase`) shows the heading, the dispatched **Agent**
badge, an explicit **fallback warning** when that agent has no definition in
`.claude/agents/` (`wfIsFallback`), the always-shown fallback rule ("Falls back
to `general-purpose` when the agent definition is missing"), the per-phase model
editor, and — for the plan phase — the read-only SKILL.md model directive with a
note that it takes precedence over the agent-file model for planning dispatch.
All dynamic text uses `textContent` (SKILL.md is untrusted → no XSS).

### Per-phase agent model editor — `buildWorkflowModelEditor`

Each phase whose agent file exists gets an **Agent model** row: the current model
(or `(default)`) and an **Edit** button that reveals a free-text input with a
curated datalist (`claude-fable-5`, `claude-opus-4-8`, plus the current value).
On **Save**:

- `sanitizeAgentModelField(value)` enforces a single bare token (letters, digits,
  dot, hyphen, underscore) — no newlines/control chars/`---`. Empty is rejected.
- `serializeAgentModel(parsed, value)` rewrites **only** the `model:` line (all
  other bytes preserved — the round-trip guarantee).
- The write goes through `writeWithMirror`, so `assets/agents/` stays byte-synced
  (see [assets-mirror.md](assets-mirror.md)). A mirror-only failure surfaces
  inline naming both paths. On success the panel re-reads.

Phases whose agent file is missing/unparseable show a disabled note instead of an
editor. Agent **descriptions** are edited in the [Agents panel](agent-management.md),
not duplicated here.

### Build concurrency default — `buildWorkflowConcurrencyControl`

A `[1..8]` `<select>` seeded from `skill.concurrencyDefault` (clamped through the
`resolveTasksConcurrency` mirror so an out-of-range stored value like `99` still
renders). **Save**:

- Re-reads `tasks/team-config.json` first so a concurrent Board-panel edit's
  columns are not clobbered (`buildWorkingConfigFromRaw` preserves columns /
  version / unknown fields).
- Writes `skill.concurrencyDefault` through `tasksSerializeTeamConfig`
  (`mkdir -p tasks/` first), then reflects the new default on the Tasks toolbar
  (only when there is no per-folder override) via `syncTasksConcurrencyOption`,
  then re-reads.

The clamp authority is `resolveConcurrency` in
[`lib/ticket-queue.js`](../lib/ticket-queue.js): `[1, MAX_CONCURRENCY]`,
`DEFAULT_CONCURRENCY = 3`, `MAX_CONCURRENCY = 8`.

## Configuration

- **SKILL.md** at `.claude/skills/orchestrate/SKILL.md` — the phase headings and
  the "Agent dispatch and fallback" section are what the parser reads. Read-only
  from this panel.
- **`tasks/team-config.json` → `skill.concurrencyDefault`** — an integer in
  `[1, 8]`. A per-folder choice on the Tasks toolbar overrides it.

## Inputs and outputs

- **Reads:** `SKILL.md`, `.claude/agents/*.md`, `tasks/team-config.json`.
- **Writes:** an agent file's `model:` line (mirror-synced), and
  `skill.concurrencyDefault` in `tasks/team-config.json`. Never `SKILL.md`.

## Edge cases and limitations

- **No polling / no write to SKILL.md.** The panel refreshes on activation and on
  **Refresh** only.
- **Missing dedicated agent** → a fallback warning on the phase card *and* no
  model editor for that phase (there is no file to rewrite).
- **Partially parseable SKILL.md** → warnings render above whatever phases parsed;
  never a blank panel.
- The plan phase's **SKILL.md model directive** is display-only and takes
  precedence over the agent-file model for planning dispatch — editing the agent
  model does not change the planning model.
