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
- A per-phase **Enabled** toggle and **↑/↓ reorder** control (writes
  `skill.phases.<phase>.{enabled,order}` into `tasks/team-config.json`,
  TASK-182).
- A **build concurrency default** control (writes `skill.concurrencyDefault` into
  `tasks/team-config.json`).
- A guided **"Regenerate this phase's instructions"** AI action (TASK-185) that
  DOES write `SKILL.md` — see below; it is the one deliberate exception to the
  read-only rule.

The app-global **Usage & telemetry** section (live tokens & cost, enable toggle,
and optional "forward to a URL" store) used to live here; it now has its own
**Stats** sub-tab. See [telemetry.md](telemetry.md).

The pipeline is parsed from the skill's prose so the panel can never drift from
what the orchestrator actually does, and — apart from the one guided AI-regenerate
action below — this panel **never writes** `SKILL.md`: that file is the workflow
contract and otherwise stays read-only here.

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
- **Model directive** (plan phase only): if `claude-opus-4-8` appears, returns
  `{ primary: 'claude-opus-4-8', fallback: <stated or 'claude-sonnet-5'> }`
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
curated datalist (`claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`, plus the
current value).
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

### Per-phase enable/reorder editor (TASK-182)

Each phase card also shows an **Enabled** checkbox and **↑/↓** reorder buttons,
seeded from `skill.phases.<phase>.{enabled,order}` (`wfNormalizePhaseConfig`,
defaulting per the TASK-180 schema — `review` unchecked, the other three checked
— when the config/key is absent). A disabled phase gets a dimmed **Disabled**
badge on its card, distinct from the missing-agent fallback warning.

**`order` is not display-only** — it drives the actual build/dispatch sequence
(a note next to the reorder controls says so plainly), so the panel shows a
**non-blocking** inline warning whenever the working order would run a phase
ahead of its natural dependency (`build` before `plan`, `test` before `build`,
`review` before `test`); the warning never blocks Save.

**Save** (one shared control below the phase cards) mirrors
`buildWorkflowConcurrencyControl`: re-reads `tasks/team-config.json` first
(falling back to the render-time config on a bad re-read, never to defaults),
merges the working `{ enabled, order }` map into `skill.phases`, writes through
`tasksSerializeTeamConfig`, and re-reads (`refreshTeamWorkflow`) on success. The
write is stale-guarded against the folder/tab changing mid-save. SKILL.md is
never touched — only `tasks/team-config.json`.

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

### "Regenerate this phase's instructions" — the one write path to SKILL.md (TASK-185)

Each phase card also gets a **Regenerate this phase's instructions** AI box —
an instruction textarea and a **Regenerate instructions with AI** button — that
deliberately, narrowly reverses the "never writes SKILL.md" rule: it is the
ONLY path in this panel that may write `SKILL.md`, and only that one phase's
`## Phase <n>` section body, never any other section or byte.

The interaction contract mirrors the [Agents panel's "Regenerate with AI"
box](agent-management.md) exactly: AI output is never written directly, only
loaded as a read-only **preview** pending an explicit **Save**; **Cancel**
discards the proposal with no write; the button reads **"Regenerating…"** and
is disabled while a request is in flight; a stale-guard discards a response
that arrives after the folder/tab changed or the card was torn down by a
re-render; every failure path (empty instruction, missing
`ANTHROPIC_API_KEY`, non-200/timeout/network/malformed/empty response, or an
invalid proposal) shows an inline message and writes nothing, preserving the
typed instruction. All dynamic text uses `textContent`.

Backend (TASK-184, Electron-free, never throws):

- [`lib/skill-section.js`](../lib/skill-section.js) — `extractPhaseBody(skillMd,
  phaseKey)` / `replacePhaseBody(skillMd, phaseKey, newBody)`, which splice just
  one `## Phase <n>` section's body while preserving every other byte of
  `SKILL.md` (other sections, EOL style, trailing newline), refusing via a
  byte-diff "every OTHER section is untouched" guard.
- [`lib/skill-regenerate.js`](../lib/skill-regenerate.js) —
  `regeneratePhaseSection(...)`, a sibling of `lib/agent-regenerate.js` that
  asks a Claude model to rewrite one phase section's prose from an
  instruction; injectable HTTP client, structured `{ ok, content, reason }`
  result.
- The `skill:regeneratePhase` IPC handler in `main.js` (exposed to the
  renderer as `window.api.skill.regeneratePhase`) clamps inputs and reads
  `ANTHROPIC_API_KEY` from the env store, delegating to the lib above.

Renderer (TASK-185, `buildWorkflowPhaseRegenerator`): the renderer is a browser
script that cannot `require` Node modules, so `lib/skill-section.js`'s splice
logic is mirrored inline as `wfExtractPhaseBody`/`wfReplacePhaseBody` — the same
duplication convention `wfParseWorkflow` already follows for
`lib/skill-workflow.js` (KEEP IN LOCKSTEP with the lib copies).

1. On submit, `wfExtractPhaseBody` pulls the current section body from the
   SKILL.md text captured when the card was built, and sends it plus the
   instruction to `window.api.skill.regeneratePhase`.
2. The response is validated by `validateRegeneratedPhaseSection` — rather than
   re-implementing heading detection, it re-uses `wfReplacePhaseBody` itself as
   the validator (splicing the candidate into the captured SKILL.md snapshot),
   so a result that would merge/duplicate a section, or is empty, is rejected
   with no write and validation can never disagree with the real Save.
3. A valid result is shown as a **read-only preview** (not an editable field)
   with an "AI proposal pending Save" note.
4. **Save** re-reads `SKILL.md` fresh from disk (never trusting the build-time
   snapshot — a concurrent manual edit is respected), re-splices with
   `wfReplacePhaseBody`, and writes through `writeWithMirror` so
   `assets/skills/orchestrate/SKILL.md` stays byte-identical
   ([assets-mirror.md](assets-mirror.md)). If the section shape changed
   underneath (e.g. the heading is gone), the splice returns a structured
   failure and nothing is written. A mirror-only failure surfaces the drift
   warning naming both paths; a primary-write failure keeps the preview and
   shows an inline error. On success the panel re-reads
   (`refreshTeamWorkflow`), so the read-only pipeline reflects the new prose.

Phase cards (and this control) only ever exist when SKILL.md parsed at least
one phase, so there is no case where the control renders without a valid
SKILL.md snapshot to validate/splice against.

## Configuration

- **SKILL.md** at `.claude/skills/orchestrate/SKILL.md` — the phase headings and
  the "Agent dispatch and fallback" section are what the parser reads. Read-only
  from this panel EXCEPT for the guided "Regenerate this phase's instructions"
  Save (TASK-185, above), which writes only the target phase's section body.
- **`tasks/team-config.json` → `skill.concurrencyDefault`** — an integer in
  `[1, 8]`. A per-folder choice on the Tasks toolbar overrides it.
- **`tasks/team-config.json` → `skill.phases`** — the TASK-180 schema
  (`lib/team-config.js`'s `PHASE_KEYS`/`PHASE_DEFAULTS`/`normalizePhases`)
  reserving a `{ plan, build, test, review }` map, each an `{ enabled, order }`
  pair (`review` defaults `enabled: false`; the other three default `true`).
  Read and written by this Workflow panel's per-phase enable/reorder editor
  (TASK-182, above); `order` also drives the live build dispatch sequence
  (a separate, already-shipped behaviour ticket).

## Inputs and outputs

- **Reads:** `SKILL.md`, `.claude/agents/*.md`, `tasks/team-config.json`.
- **Writes:** an agent file's `model:` line (mirror-synced),
  `skill.concurrencyDefault` / `skill.phases` in `tasks/team-config.json`, and —
  only via the guided "Regenerate this phase's instructions" Save — one phase's
  `## Phase <n>` section body in `SKILL.md` (mirror-synced). No other part of
  `SKILL.md` is ever written from this panel.

## Edge cases and limitations

- **No polling.** The panel refreshes on activation and on **Refresh** only.
- **SKILL.md writes are scoped to one phase-section body.** Every other write
  path in this panel (model editor, enable/reorder, concurrency default) is
  config-only and never touches `SKILL.md`; only the AI-regenerate Save does,
  and only that one phase's section.
- **Missing dedicated agent** → a fallback warning on the phase card *and* no
  model editor for that phase (there is no file to rewrite).
- **Partially parseable SKILL.md** → warnings render above whatever phases parsed;
  never a blank panel; no phase cards (and so no regenerate control) render for
  an unreadable/binary SKILL.md.
- **Concurrent manual edit of SKILL.md** between an AI-regenerate preview and its
  Save → the splice re-reads the file fresh and fails with a structured reason
  if the phase's section shape changed, showing an inline error with no partial
  write.
- The plan phase's **SKILL.md model directive** is display-only and takes
  precedence over the agent-file model for planning dispatch — editing the agent
  model does not change the planning model.
