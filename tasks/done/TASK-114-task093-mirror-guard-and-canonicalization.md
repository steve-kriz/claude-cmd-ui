---
id: TASK-114
title: TASK-093 review: mirror drift-sync guard test + mirror path canonicalization
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:44:45.155Z
review-of: TASK-093
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T03:06:00Z","finishedAt":"2026-07-21T03:34:25Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:08:00Z","finishedAt":"2026-07-21T03:41:27Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:10:00Z","finishedAt":"2026-07-21T03:44:45Z"}]
---

## Description
Review follow-ups for TASK-093 (assets-mirror auto-sync). This is a review follow-up of TASK-093. Severity **minor**.
- **F1 — drift-sync guard test.** `renderer/renderer.js` duplicates `lib/assets-mirror.js`'s mapping (`ASSETS_MIRRORED_SUBTREES` ~5964-5967, `mirrorRelPath` ~5972-5979, "KEEP IN SYNC"), but nothing enforces the sync. Add a cross-check test that extracts the renderer copy headless (the brace-matching `extractFn`/`extractSubtreesConst` convention from `test/task-093-assets-mirror.e2e.test.js`) and asserts it agrees with the lib: deepEqual of the subtree arrays + behavioral equality of `mirrorRelPath` over a representative path set.
- **F2 — mirror path canonicalization (security hardening).** `writeWithMirror` (~6008-6027) builds `mirrorPath = tasksJoin(tab.folder, ...mirrorRel.split('/'))` and exists-checks/writes with no canonicalization/containment. `relFromFolder` returns the raw remainder, so a crafted primary like `<folder>/.claude/agents/../../../evil.md` maps to a mirror path resolving OUTSIDE the project folder (and `.claude/agents/../../tasks/x.md` resolves inside the folder but outside `assets/`). Fix: after mapping, LEXICALLY canonicalize the mirror path (normalize `\`→`/`, resolve `.`/`..`), and mirror ONLY when the canonical path is strictly inside the project folder AND under its `assets/` subtree (case-insensitive, separator-tolerant, matching `relFromFolder`); else skip the mirror entirely (no exists, no write) and return `{...primary, mirrored:false}`. Use the single canonical path for both `fs.exists` and `fs.writeFile`. The exists→write TOCTOU and the symlink blind spot of a lexical check can't be closed from the renderer (no atomic write-if-exists IPC, no realpath IPC) — document both as residual limitations in a `writeWithMirror` comment.

Scope: edit only the renderer `writeWithMirror` path + tests; keep the renderer/lib duplication (do NOT make renderer require the lib). IMPORTANT: four e2e files (`task-093`, `task-094`, `task-095`, `task-106` e2e) brace-extract `writeWithMirror` with a FIXED helper list — if you add a new top-level helper `writeWithMirror` calls, update those extraction lists too, OR implement the guard INLINE inside `writeWithMirror` so the extracted function stays self-contained (preferred).

## Acceptance Criteria
- [ ] New unit test (`test/task-114-mirror-sync-guard.test.js`) extracts renderer `ASSETS_MIRRORED_SUBTREES` + `mirrorRelPath` headless and cross-checks vs `lib/assets-mirror.js`: deepEqual subtree arrays + per-path equality over a representative set (both subtrees, nested remainder, `\`/mixed separators, leading `./` and `/`, non-mirrored `.claude/settings.json`/`tasks/x.md`/`assets/agents/ba.md`, bare subtree dir, prefix-substring trap `.claude/agentsX/ba.md`, empty string, non-string junk, traversal `.claude/agents/../../../x.md`). Fails if either copy diverges.
- [ ] `writeWithMirror` lexically canonicalizes the mirror path before any mirror-side fs call and uses that single canonical path for both `fs.exists` and `fs.writeFile`.
- [ ] Canonical mirror path NOT strictly inside the project folder → mirror step skipped, `{...primary, mirrored:false}`, ZERO mirror-side calls; primary write still happens and its result returned.
- [ ] Canonical mirror path inside the folder but NOT under `assets/` (e.g. `<folder>/tasks/x.md`) → likewise skipped with `mirrored:false`.
- [ ] A benign `..` canonicalizing to a path still under the mapped `assets/` subtree (e.g. `.claude/agents/sub/../ba.md` → `<folder>/assets/agents/ba.md`) still mirrors normally (when the mirror exists), writing the canonical path.
- [ ] Containment comparison case-insensitive + separator-tolerant (Windows), matching `relFromFolder`; trailing slash on `tab.folder` normalized identically.
- [ ] All existing TASK-093 contracts preserved (primary-fail → no mirror attempt; no mapping / mirror absent → `mirrored:false`, never creates a mirror; mirror-write-fail → `{ok:false, primaryOk:true, mirrorPath, mirrorError}`).
- [ ] `node --test test/task-093-assets-mirror.test.js test/task-093-assets-mirror.e2e.test.js test/task-094-agents-panel.e2e.test.js test/task-095-add-agent.e2e.test.js test/task-106-guided-editor.e2e.test.js` passes (extraction lists updated if a new helper was added; inline preferred so no changes needed).
- [ ] A `writeWithMirror` comment documents the two residual limitations (TOCTOU; lexical canonicalization can't detect symlinks — no realpath IPC).
- [ ] New e2e tests (`test/task-114-mirror-canonicalization.e2e.test.js`) cover traversal-skip, inside-folder-but-outside-assets skip, benign-`..`, backslash-traversal — via the extract-headless + stubbed `window.api.fs` + real temp dir pattern, asserting on disk that no file is created at the escape target.
- [ ] Full `node --test` introduces no new failures (2 known baseline excepted).

## Cucumber Tests
```gherkin
Feature: TASK-093 follow-up — mirror map drift guard + mirror path canonicalization
  Scenario: Renderer and lib mirror maps agree
    Given the renderer ASSETS_MIRRORED_SUBTREES/mirrorRelPath extracted headless and the lib versions
    When mirrorRelPath is applied to a representative path set (subtrees, nested, backslash/mixed, ./, /, non-mirrored, bare dir, prefix trap, empty, junk, traversal)
    Then every path maps identically in both and the subtree arrays are deeply equal
  Scenario: Mirror path traversing outside the project folder is never written (failure)
    Given a pre-seeded file at the traversal escape target outside the folder
    And the primary path "<folder>/.claude/agents/../../../evil.md"
    When writeWithMirror writes content to that primary path
    Then the primary write happens and its result returns with mirrored=false
    And no exists/write is issued for any mirror path and the escape target is byte-identical to its seed
  Scenario: Mirror path inside folder but outside assets/ is skipped (failure)
    Given the primary path "<folder>/.claude/agents/../../tasks/x.md"
    When writeWithMirror runs
    Then the primary result returns with mirrored=false and <folder>/tasks/x.md is not written by the mirror step
  Scenario: Backslash-separator traversal is also caught (failure)
    Given the primary path "<folder>\.claude\agents\..\..\..\evil.md"
    When writeWithMirror runs
    Then the mirror step is skipped with mirrored=false
  Scenario: Benign dot segments canonicalize and still mirror
    Given .claude/agents/ba.md and an existing assets/agents/ba.md
    When writeWithMirror writes to "<folder>/.claude/agents/sub/../ba.md"
    Then the mirror write targets "<folder>/assets/agents/ba.md" and both copies are byte-identical
  Scenario: Never-create-a-mirror contract still holds (regression)
    Given .claude/agents/ba.md and no assets directory
    When writeWithMirror runs
    Then only the primary file is written, no assets file/dir created, result mirrored=false
```

## Edge Cases & Failure Paths
- Symlinked `assets/` (residual): lexical canonicalization can't see symlinks; no realpath IPC → documented in the comment, not fixed. If an e2e adds a symlink probe, try/catch `fs.symlinkSync` and skip on Windows EPERM.
- TOCTOU (residual): between exists and write another process could create/delete the mirror → documented; mitigation is the single canonical containment-checked path.
- Mixed/backslash `..\..\` caught same as `../../` (normalize before resolving). Case-insensitive Windows prefix. Trailing slash on tab.folder normalized. `..` resolving within assets/ allowed. More `..` than depth (climbs above root) → outside → skip, never throw. Non-string/null tab.folder/absPath → `null` from relFromFolder → mirrored:false, never throws. Primary result shape unchanged (callers at 7267/7698/7974 rely on mirrored/primaryOk/mirrorError/mirrorPath). New-helper extraction breakage — see scope note (prefer inline).

## Relevant Files & Context
- `lib/assets-mirror.js` — authoritative mapping (MIRRORED_SUBTREES, mirrorRelPath); F1 cross-check compares against this; no change needed.
- `renderer/renderer.js` — only source edit: `ASSETS_MIRRORED_SUBTREES` (5964-5967), `mirrorRelPath` (5972-5979), `relFromFolder` (5984-5991), `writeWithMirror` (6008-6027, add canonicalize+containment between mapping 6013 and exists 6019; `tasksJoin` 5955-5957). Callers 7267/7698/7974 (do not change).
- `test/task-093-assets-mirror.e2e.test.js` — the extract-headless pattern (extractFn brace matcher, extractSubtreesConst, stubbed window.api.fs + temp dir, failWrites); also one of the 4 files whose extraction list breaks if a new helper is added. Others: `test/task-094-agents-panel.e2e.test.js` (~67-69), `test/task-095-add-agent.e2e.test.js` (~76-78), `test/task-106-guided-editor.e2e.test.js` (~86-88).
- `test/task-093-assets-mirror.test.js` — lib unit tests; path-set template.
- `main.js` fs:writeFile/fs:exists (no path validation / no atomic write-if-exists — why the guard is renderer-side + TOCTOU residual). `preload.js` fs surface (no realpath). `docs/assets-mirror.md` — optionally extend limitations (docs-only).
- 2 known-baseline failures unrelated.

## Impact If Not Fixed
The renderer/lib mirror copies could silently diverge (reintroducing the assets drift this feature prevents) with the suite still green; a crafted/symlinked path could cause a write outside the intended assets/ subtree, and the "never create a mirror" guarantee is not race-safe.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
