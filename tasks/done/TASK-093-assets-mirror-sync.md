---
id: TASK-093
title: Assets drift-guard auto-sync helper (lib/assets-mirror.js + renderer write-through)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:43:09.244Z
order: 4
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:33:00Z","finishedAt":"2026-07-20T21:34:52Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:36:00Z","finishedAt":"2026-07-20T21:40:07Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:38:00Z","finishedAt":"2026-07-20T21:43:09Z"}]
---

## Description
Implement Q6: whenever the app writes a file under the opened project's `.claude/` that has
a matching `assets/` mirror, write both copies byte-identically so the mirror tests
(`test/orchestrate-agents.test.js` line 298, `test/orchestrate-swarm.test.js` lines 192–201)
stay green. Pure lib maps `.claude/`-relative paths to mirror paths
(`.claude/agents/<f>.md` → `assets/agents/<f>.md`; `.claude/skills/orchestrate/<f>` →
`assets/skills/orchestrate/<f>`); a renderer helper `writeWithMirror(tab, absPath, content)`
writes the primary via `window.api.fs.writeFile`, then checks `fs.exists` on the mirror and
writes it too when present. Used by TASK-094/095/106.

## Clarifications
- Q6: AUTO-SYNC — write both copies in sync when a mirror exists. Projects without an `assets/` mirror are unaffected (mirror write is skipped, not created).

## Acceptance Criteria
- [ ] `lib/assets-mirror.js` exports `mirrorRelPath(relPath)` → the `assets/…` relative path for the two mirrored subtrees, null for anything else (e.g. `.claude/settings.json`, `tasks/x.md`); pure, never throws, handles both `/` and `\` separators.
- [ ] Renderer `writeWithMirror` mirrors the lib logic (duplication convention), writes the primary first, and writes the mirror only when `fs.exists` reports it present.
- [ ] After a mirrored write, both files' contents are identical strings (asserted in e2e test via temp dirs).
- [ ] Primary write failure → no mirror write attempted; mirror write failure → surfaced to the caller (`{ ok:false, mirrorError }`) while the primary write stands, with the caller expected to show a drift warning.
- [ ] Never creates a mirror file that did not already exist.
- [ ] Unit + e2e tests (`task-093-*` pair) using temp directories.

## Cucumber Tests
```gherkin
Feature: Assets mirror auto-sync
  Scenario: Editing a mirrored agent file
    Given a project with .claude/agents/ba.md and assets/agents/ba.md
    When writeWithMirror writes new content to .claude/agents/ba.md
    Then assets/agents/ba.md holds the identical bytes

  Scenario: Project without an assets mirror (edge)
    Given a project with .claude/agents/ba.md and no assets directory
    When writeWithMirror runs
    Then only the .claude file is written and no assets file is created

  Scenario: Mirror write fails (failure)
    Given the mirror path is unwritable
    When writeWithMirror runs
    Then the primary write succeeds and the result carries mirrorError for the UI to warn
```

## Edge Cases & Failure Paths
- Path with mixed separators; file outside the two mirrored subtrees (null mapping); mirror exists but primary missing (still writes primary, then mirror).

## Relevant Files & Context
- `main.js` fs handlers (584–675, unrestricted — no new IPC); `preload.js` (48–57).
- Drift-guard tests: `test/orchestrate-agents.test.js` line 298, `test/orchestrate-swarm.test.js` lines 192–201.
- Memory note "Assets drift guard".

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
