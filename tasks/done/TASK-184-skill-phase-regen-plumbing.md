---
id: TASK-184
title: Phase-prose AI regeneration plumbing — scoped section splice, IPC, mirror-synced write
status: done
created: 2026-07-27T12:00:00Z
updated: 2026-07-27T17:20:00Z
agent: orchestrator-main
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T16:50:00Z","finishedAt":"2026-07-27T17:00:00Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-27T17:00:00Z","finishedAt":"2026-07-27T17:10:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T17:10:00Z","finishedAt":"2026-07-27T17:18:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T17:10:00Z","finishedAt":"2026-07-27T17:18:00Z"}]
---

## Description
Add the main-process + lib plumbing that lets the Workflow panel (TASK-185) AI-regenerate the
prose body of a single `## Phase <n> — …` section inside
`.claude/skills/orchestrate/SKILL.md`, preview it, and write it back **scoped only to that
phase's section** and **mirror-synced** to `assets/skills/orchestrate/SKILL.md`. No UI in this
ticket — this is the reusable engine TASK-185 consumes. TASK-185 depends on this.

Two pure pieces plus wiring, all modelled on the existing agent-regenerate stack:

1. **Section splice (pure, Electron-free, never throws):** given SKILL.md text and a phase key,
   extract that `## Phase <n>` section body (reusing the fence-aware `sectionsOf` splitter
   already in `lib/skill-workflow.js`), and — given a replacement body — produce the full new
   SKILL.md with **only** that section's body replaced and **every other byte** (all other
   phases, all other sections, frontmatter, EOL, trailing newline) preserved. Must refuse
   (return a structured failure, never a partial write) if the target section is missing,
   ambiguous, or if the replacement would alter another section's heading/body.
2. **AI regeneration lib** (`lib/skill-regenerate.js`), a sibling of `lib/agent-regenerate.js`:
   injectable `httpRequest`, structured `{ ok, content, reason }`, never throws, key never
   logged; its own system prompt instructs the model to rewrite **only the phase-section prose**
   and return just that section body (not the whole file), so the volatile output stays small.
3. **IPC + preload**: a `skill:regeneratePhase` handler in `main.js` mirroring `agents:regenerate`
   (reads `ANTHROPIC_API_KEY` from the env store, never returns it, clamps content/instruction),
   exposed as `window.api.skill.regeneratePhase(...)` in `preload.js`.

The write itself reuses the existing renderer `writeWithMirror`, which **already** maps
`.claude/skills/orchestrate/` → `assets/skills/orchestrate/` — so no new write IPC is needed;
this ticket provides the section-splice module the renderer will feed into `writeWithMirror`.

## Acceptance Criteria
- [x] A pure module (e.g. `lib/skill-section.js`) exports: extract-phase-body(skillMd, phaseKey) → `{ ok, body, reason }`, and replace-phase-body(skillMd, phaseKey, newBody) → `{ ok, content, reason }`; both never throw and reuse the fence-aware section logic consistent with `lib/skill-workflow.js` (`## Phase <n>` detection, fence-aware, canonical phase keys from `PHASE_SPECS`).
- [x] `replace` changes ONLY the target phase's section body — a byte diff shows every other phase, every other `##` section, the frontmatter, and the trailing-newline/EOL shape unchanged; replacing with the identical body reproduces the file byte-for-byte.
- [x] `replace`/`extract` return a structured failure (no throw, no partial output) when: the phase heading is absent, the input is not a string/garbage, or `phaseKey` is not one of the four canonical keys.
- [x] `lib/skill-regenerate.js` mirrors `lib/agent-regenerate.js`: injectable `httpRequest` (unit-testable with NO real API traffic), `{ ok, content, reason }` for every branch (`no-key`/`empty-instruction`/`empty-content`/`bad-status`/`bad-json`/`empty-response`/`error`/`ok`), never throws, never logs/returns the key; its system prompt asks for ONLY the rewritten phase-section prose.
- [x] `main.js` registers `skill:regeneratePhase` reading `ANTHROPIC_API_KEY` from the env store (never returned over IPC), clamping content + instruction (reuse the existing char caps), returning `{ ok, content, reason }`; a thrown error degrades to a structured failure.
- [x] `preload.js` exposes `window.api.skill.regeneratePhase(content, instruction)` (or equivalent) over the new channel, matching the `agents.regenerate` shape.
- [x] No behaviour change to `agents:regenerate` / `lib/agent-regenerate.js` (the new stack is additive and independent).

## Cucumber Tests
```gherkin
Feature: phase-prose regeneration plumbing
  Scenario: extract a phase body
    Given a SKILL.md with all four phase sections
    When the review phase body is extracted
    Then the returned body is the text under "## Phase 4" up to the next level-2 heading

  Scenario: replace only the target section
    Given a SKILL.md with all four phases
    When the review phase body is replaced with new prose
    Then the produced file differs only within the Phase 4 section body
    And all other phases and sections are byte-identical

  Scenario: identical replacement is byte-stable
    When a phase body is replaced with its current body
    Then the produced file equals the input byte-for-byte

  Scenario: regenerate returns structured failure with no key (failure)
    Given no ANTHROPIC_API_KEY is set
    When skill regeneration is invoked
    Then it returns ok false with reason "no-key" and makes no API call

  Scenario: missing phase heading (failure/edge)
    Given a SKILL.md missing the "## Phase 4" heading
    When replace-phase-body targets review
    Then it returns ok false and produces no output (no partial write)

  Scenario: key never leaves main (security)
    When skill:regeneratePhase runs
    Then the returned object never contains the API key
```

## Edge & Failure Cases
- Non-string / binary / empty SKILL.md → structured failure, never throws, never writes.
- A `## Phase <n>` heading that appears inside a fenced code block must NOT be treated as the section (fence-aware, matching `sectionsOf`).
- Duplicate phase headings → treat like `parseWorkflow` (first wins) or refuse; be deterministic and documented.
- Model returns the whole file instead of just the section, or wraps it in a code fence → the renderer (TASK-185) validates; this lib should tolerate/strip one surrounding fence like `stripOneCodeFence` does, but must not silently accept multi-section output as a single body.
- Clamp must bound the billed call; SKILL.md is large but only a single section body is sent, keeping the volatile tail small.
- IPC must never throw across the boundary (structured `{ok:false}` on any error), matching `agents:regenerate`.

## Relevant Files & Context
- `lib/agent-regenerate.js` — the exact template for `lib/skill-regenerate.js` (injectable `httpRequest`, constants, never-throws contract).
- `lib/skill-workflow.js` — `sectionsOf` (fence-aware level-2 splitter, lines ~103-134), `phaseNumberOf`, `PHASE_SPECS`; reuse this logic for the splice module.
- `main.js` — `agents:regenerate` handler (~2104) and `AGENT_REGEN_MAX_*` char caps (~2094); env store usage; register the new handler alongside.
- `preload.js` — `agents.regenerate` exposure (~148-155); add `skill.regeneratePhase`.
- `renderer/renderer.js` — `writeWithMirror` (~6243, already maps `.claude/skills/orchestrate/` → `assets/`); no new write IPC needed.
- `lib/assets-mirror.js` — `MIRRORED_SUBTREES` already covers the skill subtree.
- Tests to model on: existing `agent-regenerate` unit tests (mocked httpRequest); add a `task-184-*` unit pair for the splice + regenerate lib.
- Depended on by: TASK-185.

## Build notes
- Coder: added `lib/skill-section.js` (extractPhaseBody/replacePhaseBody, byte-diff boundary guard) and `lib/skill-regenerate.js` (sibling of agent-regenerate.js); wired `skill:regeneratePhase` IPC in main.js (20000/4000 char clamps, key never returned) and `window.api.skill.regeneratePhase` in preload.js; additively exported `sectionsOf`/`phaseNumberOf` from `lib/skill-workflow.js`.
- Tester: added `test/task-184-skill-section.unit.test.js` (36 tests), `test/task-184-skill-regenerate.unit.test.js` (39 tests), `test/task-184-skill-regen.e2e.test.js` (12 tests). Orchestrator independently re-ran the full suite: 3682 pass, 3 pre-existing baseline failures, 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review found no vulnerabilities (key never leaks, no HTTP injection via instruction, section-boundary guard genuinely robust, clamp enforced before the network call) but flagged one test-fidelity gap — filed as **TASK-190** (the e2e tests exercise local reimplementations of the IPC handler/lib instead of the real `main.js` code, and the clamp assertions are vacuous). Documentation pass added a factual section to `docs/workflow-settings.md`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
