---
id: TASK-200
title: context optimisation
status: done
created: 2026-08-01T02:36:06.374Z
updated: 2026-08-01T13:31:00.000Z
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-08-01T02:57:25.000Z","finishedAt":"2026-08-01T03:02:13.000Z"},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-08-01T03:02:13.000Z","finishedAt":"2026-08-01T03:16:17.000Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-01T03:16:17.000Z","finishedAt":"2026-08-01T03:24:27.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-01T03:24:27.000Z","finishedAt":"2026-08-01T03:28:11.000Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-08-01T03:28:11.000Z","finishedAt":"2026-08-01T03:32:55.000Z"}]
---

## Description
Add a **Context optimisation** control to the **Team → Workflow** panel and wire the
`/orchestrate` skill to honour it, so that at **every phase movement** of a ticket
(plan → build → test → review → post-processing) the orchestrator drops context it no
longer needs, summarises what it must keep, and carries the minimum context forward.

Today the orchestrate skill already *describes* aggressive context minimisation — see
`.claude/skills/orchestrate/SKILL.md`'s **"### Distilled returns (never inherit a
sub-agent's raw context)"** and **"### Prompt caching (stable prefix, volatile
suffix)"** subsections (under `## Agent dispatch and fallback`, before `## Phase 1`).
That behaviour is currently unconditional and has no user-facing switch. This ticket
turns it into a **configurable, persisted setting** the user can see and tune from the
Team tab, exactly mirroring how the existing per-phase enable/reorder (TASK-182) and
build-concurrency-default (TASK-106) controls persist `skill.phases` /
`skill.concurrencyDefault` into `tasks/team-config.json`, and how TASK-181's SKILL.md
prose makes the orchestrator *consult* that config.

The new setting is `skill.contextOptimization` in `tasks/team-config.json`:

```json
"skill": {
  "concurrencyDefault": 3,
  "phases": { "...": "..." },
  "contextOptimization": { "enabled": true, "level": "standard" }
}
```

Two coordinated deliverables (one coherent feature, split the way TASK-182 = UI and
TASK-181 = behaviour were, but delivered together here so the toggle is not a dead
control):

1. **Config + UI (surface).** A new `skill.contextOptimization` field, normalised in
   `lib/team-config.js` and its renderer mirror, edited by a new control on the
   Workflow panel that persists it with the same re-read-then-whole-file-write pattern
   as the existing controls.
2. **Behaviour (directive).** A new SKILL.md subsection instructing the orchestrator to
   read `skill.contextOptimization` and, when `enabled`, at every phase movement drop
   unneeded context, summarise the rest, and carry the minimum — with `level` tuning how
   aggressively. Added to **both** `.claude/skills/orchestrate/SKILL.md` and
   `assets/skills/orchestrate/SKILL.md` **byte-for-byte identical** (assets-drift guard).

### Analyst clarifications & assumptions (no interactive user available this run)
The request is terse, so the following reasonable interpretations are adopted; the user
can amend via `## Additional Context` and re-open if any is wrong.

- **A1 — Home = Team → Workflow panel.** "the team tab" maps to the Team tab's
  **Workflow** panel (`refreshTeamWorkflow` / `buildWorkflowView` in
  `renderer/renderer.js`), which already hosts the sibling skill-level knobs
  (`Build concurrency default`, per-phase enable/reorder). The new control renders
  alongside `buildWorkflowConcurrencyControl`, not in the Agents or Board panels.
- **A2 — Persisted in `tasks/team-config.json` under `skill`.** It is a skill-scoped
  setting like `skill.phases` / `skill.concurrencyDefault`, normalised by
  `lib/team-config.js` (the source of truth) and its renderer mirror. It is NOT a
  per-folder localStorage value (that is only for the Tasks-toolbar concurrency
  override, `lib/tasks-settings.js`) and it is NOT stored in SKILL.md.
- **A3 — Data shape `{ enabled: boolean, level: string }`.** `enabled` gates the whole
  behaviour; `level` is one of exactly `"conservative"`, `"standard"`, `"aggressive"`
  (the "continue with as little context as needed" dial the request asks for). Object
  shape (not a bare boolean) matches `skill.phases`' object-per-key convention and
  leaves room to grow.
- **A4 — Default `{ enabled: true, level: "standard" }`.** The skill *already* optimises
  context unconditionally today, so the default preserves current behaviour (on).
  `enabled: false` tells the orchestrator to carry fuller context (e.g. when a user is
  debugging a run and wants more state retained). This differs from `review`'s opt-in
  default because, unlike review, context optimisation is existing always-on behaviour.
- **A5 — "at every movement" = every phase transition, not board drag.** "movement"
  means a ticket advancing between orchestrate phases (the dispatch/hand-off points
  where a sub-agent returns and the next is launched), which is where context is
  actually carried. It is NOT a hook on the user manually dragging a card between lanes
  on the kanban board (that path involves no agent context).
- **A6 — Behaviour is expressed as SKILL.md prose, not enforced by app code.** The
  orchestrator is an LLM that reads SKILL.md; like `skill.phases` (whose enforcement is
  TASK-181's prose, with no runtime code gate), the "honour the setting" behaviour is a
  SKILL.md directive. The app's job is to persist the setting and surface it; the skill
  prose is what makes the orchestrator act on it. Tests assert the directive's presence
  in both SKILL.md copies (the same approach as `test/orchestrate-prompt-caching.test.js`
  and `test/task-197-parallel-dispatch-prose.test.js`), not runtime LLM behaviour.
- **A7 — Read-only elsewhere.** The Workflow panel's phase cards and the model directive
  stay read-only w.r.t. SKILL.md; the only SKILL.md edit in this ticket is the coder
  adding the new subsection to both copies during the build (not a runtime UI write
  path). The new UI control writes ONLY `tasks/team-config.json`.
- **A8 — `## Additional Context` is untouched** (user-owned).

## Acceptance Criteria

### Config model (`lib/team-config.js` — source of truth)
- [x] `defaultConfig()` returns `skill.contextOptimization` equal to
      `{ enabled: true, level: "standard" }` (A4), alongside the existing
      `concurrencyDefault` and `phases`.
- [x] A new `normalizeContextOptimization(raw, warnings)` (mirroring `normalizePhases`'
      style) normalises the field: missing/non-object → the default; `enabled` a strict
      boolean kept, else → `true` (warn only when a non-boolean value was actually
      present); `level` a string equal to one of `conservative`/`standard`/`aggressive`
      kept, else → `standard` (warn only when a non-empty invalid value was present);
      unknown keys dropped with a warning; prototype-poisoning keys
      (`__proto__`/`constructor`/`prototype`) dropped via the existing `isUnsafeKey`
      "unsafe" warning style. Never throws.
- [x] `normalizeConfig` wires `skill.contextOptimization` through
      `normalizeContextOptimization` inside the existing skill block (next to
      `concurrencyDefault`/`phases`), and the field is **excluded** from the unknown
      `skill`-key round-trip loop (so it is treated as a first-class key, not passed
      through raw).
- [x] `serializeConfig` emits the normalised `skill.contextOptimization` and never
      persists an invalid `enabled`/`level`.
- [x] The module-header schema comment documents the new `skill.contextOptimization`
      shape.
- [x] Junk/partial/tampered input (null, array, `{enabled:"yes",level:42}`,
      `{level:"warp"}`, extra keys, `__proto__`) always collapses to a complete valid
      value and never throws.

### Renderer mirror (`renderer/renderer.js`)
- [x] The renderer inlines a lockstep mirror of the level set + normaliser (near the
      existing `TASKS_PHASE_*` mirror, ~line 5651): a `TASKS_CONTEXT_OPT_LEVELS` /
      `TASKS_CONTEXT_OPT_DEFAULT` and a `tasksNormalizeContextOptimization(raw)`
      matching `lib/team-config.js` byte-for-behaviour, marked "KEEP IN LOCKSTEP".
- [x] `tasksSerializeTeamConfig` (~5910) round-trips `skill.contextOptimization`
      normalised (not just spread raw), so a Save can never persist an invalid value —
      matching how it clamps `concurrencyDefault`.
- [x] `buildWorkingConfigFromRaw` (~8463) preserves `skill.contextOptimization` on a
      concurrency-only or phase-only Save (it already spreads `obj.skill`; verify the
      field survives an unrelated Save unchanged).

### Workflow-panel control (`renderer/renderer.js`)
- [x] A new `buildWorkflowContextOptimizationControl(tab, rawConfig)` is appended in
      `buildWorkflowView` (~8454) adjacent to `buildWorkflowConcurrencyControl`, and
      renders independently of the phase cards (present even when SKILL.md parses to no
      phases), matching the concurrency control's structure/classes.
- [x] The control shows a title, a short help line, an **Enabled** checkbox seeded from
      the resolved `skill.contextOptimization.enabled`, and a **level** `<select>`
      offering exactly `Conservative`/`Standard`/`Aggressive` seeded from the resolved
      `level`. A clamped/invalid stored value renders as its normalised default so the
      option always exists.
- [x] A **Save** button re-reads `tasks/team-config.json` fresh (keep-last-good fallback
      to render-time `rawConfig` on a read/parse failure, exactly like the concurrency
      Save), sets `working.skill.contextOptimization` via `buildWorkingConfigFromRaw` +
      `tasksSerializeTeamConfig`, `mkdir`s `tasks/`, and writes the **whole** file in a
      single `fs.writeFile`. It never clobbers `columns`, `version`, `skill.phases`,
      `skill.concurrencyDefault`, or unknown top-level fields.
- [x] On write failure the inline error surfaces ("Save failed: … Try again.") and the
      button re-enables; on success the panel re-reads (`refreshTeamWorkflow`).
- [x] All dynamic/label text uses `textContent` (never `innerHTML`) — the panel's
      XSS-safe convention.
- [x] With **no folder open**, the Workflow panel still shows `(open a folder)` and the
      control is not rendered (existing `refreshTeamWorkflow` guard), throwing nothing.
- [x] With **SKILL.md not installed**, the install banner still shows and the control is
      not reached (existing guard) — no regression.

### Skill behaviour directive (both SKILL.md copies)
- [x] `.claude/skills/orchestrate/SKILL.md` gains a new subsection (e.g.
      `### Context optimisation (trim between phase movements)`) placed under
      `## Agent dispatch and fallback`, near **Distilled returns** / **Prompt caching**
      and before `## Phase 1`, that: (a) names `skill.contextOptimization` in
      `tasks/team-config.json` and its `enabled`/`level` fields; (b) instructs the
      orchestrator, at **every phase movement**, when `enabled` is not literal `false`,
      to drop context no longer needed, summarise what must be kept, and carry the
      minimum forward; (c) defines the `level` dial
      (`conservative`/`standard`/`aggressive`) as how aggressively to trim; (d) states
      the default (`enabled: true`, `level: standard`) and that a missing/invalid value
      is treated as the default; (e) ties it to the existing Distilled-returns /
      Prompt-caching rules rather than contradicting them.
- [x] `assets/skills/orchestrate/SKILL.md` receives the **identical** edit; the two
      copies are **byte-for-byte identical** afterwards (assets-drift guard;
      `readFileSync(ASSETS_SKILL).equals(readFileSync(PROJECT_SKILL))`).
- [x] The new prose introduces **no model id** and does not disturb the "no model id
      after Phase 2" invariant asserted by existing caching-prose tests.
- [x] **No agent definition file is regenerated or edited** (`.claude/agents/*` and
      `assets/agents/*` stay byte-stable — the cached stable prefix rule).

### Docs
- [x] `docs/orchestrate-workflow.md` documents the new `skill.contextOptimization`
      config field (in the **Configuration** section and the frontmatter/config
      reference) and the Workflow-panel control.

### Regression
- [x] All existing team-config / workflow-panel tests continue to pass
      (`test/task-097-team-config*.js`, `test/task-180-team-config-phases*.js`,
      `test/task-181-phase-enabled*.js`, `test/task-182*`, `test/task-114-mirror-sync-guard.test.js`,
      `test/orchestrate-prompt-caching.test.js`, `test/task-197-parallel-dispatch-prose.test.js`).

## Cucumber Tests
```gherkin
Feature: Context-optimisation setting on the Team → Workflow panel

  Background:
    Given a project with the orchestrate skill installed

  Scenario: Default config carries an enabled, standard context-optimisation setting
    When tasks/team-config.json is normalized from an empty/default config
    Then skill.contextOptimization equals { enabled: true, level: "standard" }

  Scenario: The Workflow panel renders the context-optimisation control
    Given the Team tab's Workflow panel is open on the project
    When the panel renders
    Then a "Context optimisation" control shows an Enabled checkbox and a level select
    And the level select offers exactly Conservative, Standard, and Aggressive
    And the controls are seeded from skill.contextOptimization in tasks/team-config.json

  Scenario: Saving persists the setting without clobbering other skill config
    Given the config has skill.concurrencyDefault 5, skill.phases customised, and user columns
    And the user unchecks Enabled and selects "aggressive"
    When the user clicks Save on the context-optimisation control
    Then tasks/team-config.json is rewritten whole with skill.contextOptimization { enabled: false, level: "aggressive" }
    And skill.concurrencyDefault, skill.phases, version, and every column are preserved

  Scenario: The setting round-trips through the config model
    Given skill.contextOptimization is { enabled: false, level: "conservative" }
    When the config is normalized and re-serialized
    Then the serialized config still holds { enabled: false, level: "conservative" }

  Scenario: Both SKILL.md copies instruct the orchestrator to honour the setting
    When each of .claude/ and assets/ skills/orchestrate/SKILL.md is read
    Then each contains a context-optimisation directive naming skill.contextOptimization
    And each instructs trimming/summarising context at every phase movement
    And the two copies are byte-for-byte identical

  Scenario (edge): A tampered config is repaired, never throws
    Given tasks/team-config.json has skill.contextOptimization = { enabled: "yes", level: 42, __proto__: {} }
    When the config is normalized
    Then enabled resets to true, level resets to "standard", the unsafe key is dropped
    And a warning is recorded for each repair and no exception is thrown

  Scenario (edge): An out-of-range stored level renders as its normalised default
    Given skill.contextOptimization.level is "warp"
    When the Workflow panel renders the control
    Then the level select shows "Standard" selected and no exception is thrown

  Scenario (failure): A write failure surfaces inline and preserves prior config
    Given the context-optimisation Save is clicked
    When fs.writeFile returns { ok: false }
    Then an inline "Save failed … Try again." message is shown and the button re-enables
    And no partial/corrupt config is left on disk

  Scenario (edge): No folder open degrades gracefully
    Given no folder is open
    When the Team tab is activated
    Then the Workflow panel shows "(open a folder)" and the control is not rendered and nothing throws
```

## Edge & Failure Cases the coder must handle
- **Whole value missing / not an object** (null, array, string, number) → default
  `{ enabled: true, level: "standard" }`, no throw.
- **`enabled` non-boolean** (`"true"`, `1`, `null`) → `true`, warn only when a value was
  actually present.
- **`level` invalid / non-string** (`"warp"`, `42`, `""`) → `"standard"`, warn only when
  a non-empty invalid value was present.
- **Prototype-poisoning keys** (`__proto__`/`constructor`/`prototype`) inside
  `contextOptimization` → dropped via `isUnsafeKey`, never assigned by the round-trip;
  the global `Object.prototype` is never mutated.
- **Unknown extra keys** inside `contextOptimization` → dropped with a warning (first-class
  field, not raw-passed).
- **Concurrent Save** (Board panel or concurrency control saving at the same time) → the
  context-optimisation Save re-reads fresh and preserves `columns`/`version`/other
  `skill` fields; a read/parse failure at Save time falls back to render-time `rawConfig`
  (keep-last-good), never wiping the config to defaults.
- **Renderer/lib drift** — the renderer mirror must stay byte-for-behaviour with
  `lib/team-config.js` (a `task-114`-style parity guard); a divergence must fail a test.
- **Assets drift** — editing only one SKILL.md copy must fail the byte-identity test;
  both copies must carry the identical directive.
- **No folder / SKILL.md not installed** — existing `refreshTeamWorkflow` guards: control
  not rendered, no throw.
- **Level default vs enabled=false** — a disabled setting still carries a valid `level`
  (it is not blanked), so re-enabling restores the last chosen level.

## Relevant Files & Context

### Config model (source of truth + mirror)
- `C:\projects\claude-cmd-ui2\lib\team-config.js`
  - Schema/comment header (~lines 12-31) — document the new `skill.contextOptimization`.
  - `PHASE_DEFAULTS` / `defaultPhases` / `normalizePhases` (~lines 108-351) — the exact
    pattern to mirror for `normalizeContextOptimization`.
  - `defaultConfig()` (~267-273) — add `contextOptimization` to the `skill` object.
  - `normalizeConfig` skill block (~474-492) — where `concurrencyDefault` and `phases`
    are normalised and unknown skill keys round-tripped; add the new field here and
    exclude its key from the unknown-key loop (the `if (k === 'concurrencyDefault' ||
    k === 'phases') continue;` guard at ~486).
  - `serializeConfig` (~553-564), `isUnsafeKey`/`UNSAFE_KEYS` (~137-141),
    `isPlainObject` (~143), and the `module.exports` block (~566-581) — export the new
    normaliser + any level constant.
- `C:\projects\claude-cmd-ui2\renderer\renderer.js`
  - Renderer team-config mirror region (~5601-5720): `TASKS_PHASE_KEYS` /
    `TASKS_PHASE_ENABLED_DEFAULTS` / `tasksNormalizeColumnPhase` (~5651-5666) — add
    `TASKS_CONTEXT_OPT_LEVELS` / `TASKS_CONTEXT_OPT_DEFAULT` /
    `tasksNormalizeContextOptimization` next to them, "KEEP IN LOCKSTEP".
  - `tasksSerializeTeamConfig` (~5910-5946) — normalise `skill.contextOptimization`
    into the emitted `skill` object (the `const skill = { ...rawSkill }` clamp block at
    ~5926-5934 is the model to follow).
  - `buildWorkingConfigFromRaw` (~8463-8479) — verify `skill.contextOptimization`
    survives an unrelated Save.

### Workflow-panel UI
- `C:\projects\claude-cmd-ui2\renderer\renderer.js`
  - `initTeamTab` (~7236-7256) → `refreshTeamWorkflow` (~8169-8274) — the panel entry and
    its no-folder / not-installed / unreadable guards; the new control renders only on the
    installed+readable path.
  - `buildWorkflowView(tab, model, agentNames, agentFiles, rawConfig, skillMdSnapshot, skillPath)`
    (~8333-8456) — append `buildWorkflowContextOptimizationControl(tab, rawConfig)` right
    beside the existing `wrap.appendChild(buildWorkflowConcurrencyControl(tab, rawConfig));`
    (~8454).
  - `buildWorkflowConcurrencyControl(tab, rawConfig)` (~8486-8582) — the **template** to
    copy for structure, the re-read-fresh-then-whole-file-write Save, keep-last-good
    fallback, inline error, `mkdir`, and `refreshTeamWorkflow` on success. Note it uses
    `tasksJoin`, `window.api.fs.readFile/writeFile/mkdir`, `tasksSerializeTeamConfig`,
    `buildWorkingConfigFromRaw`.
- `C:\projects\claude-cmd-ui2\renderer\styles.css`
  - Existing Workflow-panel classes to match visually: `.team-workflow-concurrency`,
    `.team-workflow-phase-title`, `.team-workflow-rule`, `.team-workflow-phase-meta`,
    `.team-workflow-concurrency-select`, `.team-agent-desc-error`. Add
    `.team-workflow-context-opt*` classes in the same dark palette.
- `C:\projects\claude-cmd-ui2\renderer\index.html`
  - Hosts the Team-tab body / `.teamWorkflowBody`; the panel is built entirely in JS, so
    no static markup change is required (keep any change comment-only).

### Skill behaviour directive (edit BOTH, byte-identical)
- `C:\projects\claude-cmd-ui2\.claude\skills\orchestrate\SKILL.md`
  - Add the subsection under `## Agent dispatch and fallback`, adjacent to
    `### Distilled returns (never inherit a sub-agent's raw context)` and
    `### Prompt caching (stable prefix, volatile suffix)`, before `## Phase 1 — Plan / Define`.
    Model the wording on the existing "consult `skill.phases.<phase>`" directive in
    `### Phase-enabled config and dispatch order (tasks/team-config.json)`.
- `C:\projects\claude-cmd-ui2\assets\skills\orchestrate\SKILL.md`
  - The identical edit; must end byte-for-byte identical to the `.claude/` copy.
  - Do **not** touch `.claude/agents/*.md` or `assets/agents/*.md` (byte-stable prefix).

### Docs
- `C:\projects\claude-cmd-ui2\docs\orchestrate-workflow.md`
  - **Configuration** section (~239-254, alongside the "Phase enabled/order (TASK-181)"
    bullet) and the frontmatter/config reference — document `skill.contextOptimization`
    and the Workflow-panel control.

### Tests the tester will exercise (existing patterns to follow)
- `C:\projects\claude-cmd-ui2\test\task-180-team-config-phases.test.js` /
  `.e2e.test.js` — model for unit + e2e coverage of a new `skill.*` field's normalise /
  default / round-trip / junk handling.
- `C:\projects\claude-cmd-ui2\test\task-181-phase-enabled.test.js` /
  `.e2e.test.js` — model for asserting a SKILL.md config-consultation directive.
- `C:\projects\claude-cmd-ui2\test\orchestrate-prompt-caching.test.js` and
  `C:\projects\claude-cmd-ui2\test\task-197-parallel-dispatch-prose.test.js` — the exact
  approach for asserting prose presence in **both** SKILL.md copies plus byte-identity
  (`ASSETS_SKILL` / `PROJECT_SKILL`, `readFileSync(...).equals(...)`).
- `C:\projects\claude-cmd-ui2\test\task-114-mirror-sync-guard.test.js` — the headless
  brace-match technique for asserting the renderer mirror equals the lib normaliser
  (extend for `tasksNormalizeContextOptimization` vs `normalizeContextOptimization`).

### Prior tickets (context only)
- TASK-097 (`skill`/columns config model + normalizeConfig), TASK-180 (`skill.phases`
  schema), TASK-181 (SKILL.md phase-enabled behaviour prose), TASK-182 (Workflow-panel
  per-phase enable/reorder UI), TASK-106 (build-concurrency-default control) — together
  they define the exact pattern this ticket extends.

## Build notes
- BA: defined the stub ticket (opus-4-8) — interpreted "context optimisation" against the
  existing `skill.phases`/`skill.concurrencyDefault` config pattern (A1-A8 assumptions).
- Coder: built in isolated worktree `.worktrees/task-200` (branch `orchestrate/task-200`,
  commit `c0da81e`): `skill.contextOptimization` config model + renderer mirror + Workflow
  panel control + byte-identical SKILL.md directive (both copies) + docs.
- Tester: added `test/task-200-context-optimization.test.js` (34 tests) and
  `.e2e.test.js` (12 tests), all 46 green. Full suite: no new regressions beyond the
  pre-existing ~55-failure baseline.
- Tech-lead review: no critical or high-security findings — verified prototype-pollution
  safety is real (unsafe keys dropped, `Object.prototype` never mutated), the renderer
  mirror matches the lib byte-for-behaviour, the Save path never clobbers other config,
  and both SKILL.md copies are genuinely byte-identical. Findings were coverage-only
  (not ticketed per policy, medium/low severity): the "mirror parity" test checks the lib
  normaliser and regex-checks renderer constants but never runs the renderer's own
  `tasksNormalizeContextOptimization` output against the lib's across the same edge
  cases (the task-114-style guard the ticket asked for); the unit `__proto__` case sets
  the object's prototype rather than an own enumerable key, so it doesn't exercise the
  `isUnsafeKey` own-key-drop path a real `JSON.parse`-sourced tampering would take; the
  Save click-handler is verified by source regex rather than executed (consistent with
  how the sibling concurrency control is tested elsewhere in this repo).
- Post-processing: `docs/orchestrate-workflow.md`, `docs/workflow-settings.md`,
  `docs/team-tab.md`, `docs/dynamic-statuses.md`, and `README.md` updated to document
  the new setting (commit `d1645da` on `orchestrate/task-200`).
- **Reconciliation note:** this ticket was marked `done` by the run above, but its
  code was never actually merged out of the isolated worktree (`.worktrees/task-200`,
  branch `orchestrate/task-200`) — a false "done". A later session (2026-08-01)
  discovered this. Unlike TASK-199's worktree, this one had diverged significantly
  from the main tree (branched before several later tickets landed, including
  TASK-196's usage-bar rewrite) — a straight file copy of `renderer.js`/`styles.css`
  would have deleted unrelated, already-shipped features. Instead, the
  context-optimisation-specific additions were identified and manually ported into
  the current main tree one at a time: the `TASKS_CONTEXT_OPT_*` constants +
  `tasksNormalizeContextOptimization` mirror, the `tasksSerializeTeamConfig`
  normalisation line, `buildWorkflowContextOptimizationControl` plus its
  `wrap.appendChild` wiring, the `.team-workflow-context-opt*` CSS block, the
  byte-identical "Context optimisation" SKILL.md subsection (both `.claude/` and
  `assets/` copies), and `lib/team-config.js` (safe to copy wholesale — untouched by
  any other ticket). The stale docs/README/test-file diffs were similarly checked
  file-by-file and either copied directly (where main hadn't diverged) or
  hand-spliced (README.md). Reran the full suite afterward: 46/46 new
  TASK-200 tests green, no regressions beyond the pre-existing baseline failures.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
