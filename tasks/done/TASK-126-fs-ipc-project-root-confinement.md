---
id: TASK-126
title: Confine main-process fs:* IPC handlers to the project root
status: done
created: 2026-07-21T02:15:52.733Z
updated: 2026-07-21T03:47:47.087Z
review-of: TASK-035
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T03:06:00Z","finishedAt":"2026-07-21T03:36:24Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:08:00Z","finishedAt":"2026-07-21T03:42:54Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:12:00Z","finishedAt":"2026-07-21T03:47:46Z"}]
---

## Description
Security post-processing finding (HIGH, from the TASK-035 pass). The four mutating/probing fs IPC handlers in `main.js` — `fs:writeFile` (~651), `fs:rename` (~663), `fs:mkdir` (~677), `fs:exists` (~687) — accept ANY absolute path from the renderer and pass it to `fs.promises` with no containment check. All path safety currently lives in the renderer (isSafeTasksSlug, agent-name validation, normalizeTasksColumns) — the wrong side of the trust boundary — so one renderer-side gate bypass becomes an arbitrary filesystem write. Move enforcement to the sink: each handler canonicalizes the path and rejects it unless it resolves inside an approved project root.

## Clarifications
**Resolution (orchestrator):** How main learns the approved roots — adopt the BA's recommended **option 1** (derive from existing signals; NO new IPC, NO renderer/preload/caller changes): a main-process in-memory root registry (a `Set`) SEEDED at startup from `readSession()` (session.json lives in userData and is main's own file) inside `app.whenReady()`, and EXTENDED on each successful `dialog:pickFolder` result (the only way a new folder enters the app). `session:save` does NOT register roots live (a compromised renderer must not mint roots). Roots accumulate for the app session; closing a tab does not revoke mid-session; next launch re-seeds from session.json. (Rejected: option 2 renderer-registration IPC adds no security; option 3 app.getPath-only breaks projects that live anywhere the user picks.) Residual noted: session.json is renderer-persisted, so a fully-compromised renderer could persist a bogus root for the NEXT launch — the in-scope threat (crafted config/slug strings, not arbitrary renderer JS) is still fully mitigated.

## Description (cont — containment rule)
Applies to all four handlers (`fs:rename` checks BOTH oldPath and newPath): canonicalize with `path.resolve()` (collapses `.`/`..`, normalizes mixed separators); resolve symlinks/short-names on the deepest EXISTING ancestor via `fsp.realpath` (target may not exist yet for writeFile/mkdir) and compare the realpath-resolved candidate against realpath-resolved roots; inside iff equal to a root or starts with `root + path.sep`; on win32 compare case-insensitively. Empty registry (no folder opened) → reject every call. Rejection returns the channel's existing `{ok:false, error}` shape — never a throw crossing IPC. Put the pure canonicalize/containment logic in a NEW Electron-free `lib/fs-roots.js` (mirroring lib/keep-awake.js / lib/assets-mirror.js) exporting a registry + an `isInsideRoots(roots, candidate, platform)`-style API, unit-tested with node --test; main.js only wires it in. Add a source-scan drift guard that each handler invokes the guard before its fsp op. Out of scope (note for a future ticket, do NOT expand): the read-side handlers fs:readFile/fs:readDir/fs:findByExt/fs:grep, tasks:installSkill, prompts:* are also unconfined and should reuse the same guard later.

Severity: **high** (from the TASK-035 security pass). This is a review follow-up of TASK-035.

## Acceptance Criteria
- [ ] A main-process root registry: seeded from `readSession()` folders at startup, extended by each successful `dialog:pickFolder`; `session:save` does NOT add roots; roots persist for the app session.
- [ ] `fs:writeFile` canonicalizes `path` (resolve + realpath of deepest existing ancestor) and returns `{ok:false, error}` without writing when it resolves outside every approved root.
- [ ] `fs:rename` checks BOTH `oldPath` and `newPath`; either out-of-root → `{ok:false, error}`, no rename; the existing "Target already exists" refusal still works for in-root paths.
- [ ] `fs:mkdir` rejects out-of-root paths (`{ok:false, error}`, creates nothing incl. no intermediate `recursive` dirs).
- [ ] `fs:exists` rejects out-of-root paths with `{ok:false, error}` (no existence-oracle outside roots); in-root behavior unchanged.
- [ ] Traversal via `..`, mixed `/`\``\``\` separators, trailing separators, and (win32) drive/folder casing cannot escape a root; an in-root path with any of those quirks still SUCCEEDS.
- [ ] Symlink escape blocked as feasible: a candidate whose existing-ancestor realpath resolves outside all roots is rejected.
- [ ] Empty registry (no folder opened) → all four handlers reject cleanly (never a throw, never a write).
- [ ] Multiple roots: with two folders open, writes inside either succeed, writes inside neither fail. Prefix-collision roots (`C:\work\proj2` vs root `C:\work\proj`) do NOT match (compare with `root + path.sep`).
- [ ] ALL existing legitimate flows still succeed inside an opened folder: ticket create/save/move (`tasks/<lane>/…` + rename between lanes), `tasks/team-config.json`, `.claude/agents/<name>.md`, `.claude/skills/` checks, `assets/` mirror (writeWithMirror), open-file editor save/rename.
- [ ] Rejections use the `{ok:false, error}` shape on every channel; no handler throws to the renderer. Non-string/empty path payloads keep the existing `path required` guard → `{ok:false}`.
- [ ] No `preload.js` or renderer caller changes required; `npm test` passes with no new failures beyond the 2-failure baseline.
- [ ] New `lib/fs-roots.js` has direct `node --test` unit coverage (containment incl. win32 case/separator, prefix-collision, symlink-ancestor, empty registry); a source-scan test pins that each of the four handlers invokes the guard before its fsp call.

## Cucumber Tests
```gherkin
Feature: fs IPC handlers are confined to approved project roots
  Background:
    Given the user opened "C:\work\proj" via the native folder picker
    And the root registry contains "C:\work\proj"
  Scenario: Legitimate ticket write inside the root succeeds
    When fs:writeFile is invoked with "C:\work\proj\tasks\todo\TASK-001-x.md"
    Then it returns ok:true and the file exists under the project folder
  Scenario: Traversal escaping the root is rejected (failure)
    When fs:writeFile is invoked with "C:\work\proj\tasks\..\..\..\Users\victim\evil.txt"
    Then it returns ok:false with an error and no file is created outside the root
  Scenario: Rename with an out-of-root destination is rejected
    Given "C:\work\proj\tasks\todo\TASK-001-x.md" exists
    When fs:rename is invoked with newPath "C:\other\stolen.md"
    Then it returns ok:false and the source is untouched
  Scenario: mkdir outside every root is rejected
    When fs:mkdir is invoked with "C:\Windows\evil"
    Then it returns ok:false and no directory is created
  Scenario: exists cannot probe outside the roots
    When fs:exists is invoked with "C:\Users\victim\.ssh\id_rsa"
    Then it returns ok:false and reveals no existence info
  Scenario: Windows case/separator quirks don't break legitimate writes
    When fs:writeFile is invoked with "c:/WORK/Proj/tasks/team-config.json"
    Then it returns ok:true
  Scenario: No folder open means no filesystem access (edge)
    Given the registry is empty
    When fs:mkdir is invoked with "C:\anything"
    Then it returns ok:false with an error
  Scenario: Second opened folder is a valid root
    Given the user also opened "D:\repos\other" via the picker
    When fs:writeFile is invoked with "D:\repos\other\tasks\todo\T.md"
    Then it returns ok:true
  Scenario: Symlinked escape inside the root is rejected (as feasible)
    Given "C:\work\proj\link" is a symlink to "C:\outside"
    When fs:writeFile is invoked with "C:\work\proj\link\evil.txt"
    Then it returns ok:false with an error
```

## Edge Cases & Failure Paths
- Symlink TOCTOU residual (realpath resolves only the existing portion) — document, don't fully solve. No-folder-open → reject cleanly, no crash. Roots accumulate per session; closing a tab doesn't revoke mid-session (avoids racing in-flight writes); next launch re-seeds from session.json only. win32 case-insensitive compare; do NOT case-fold on darwin/linux (keep the lib platform-parameterizable for tests). Mixed separators normalized by path.resolve before compare. Prefix-collision roots via `root + path.sep`. 8.3 short names / UNC handled by realpath. Non-string/empty path → existing guard → `{ok:false}`. fs:exists out-of-root now `{ok:false}` where it never was — all current callers already treat `!ok` as "not exists" (verify none crashes). session.json trust residual noted in a comment.

## Relevant Files & Context
- `main.js` — the four handlers: fs:writeFile 651-661, fs:rename 663-675, fs:mkdir 677-685, fs:exists 687-694. Root sources: `dialog:pickFolder` 334-341; `readSession`/`writeSession` 33-52; `session:load`/`session:save` 451-462; startup `app.whenReady()` 196-210 (`sessionFilePath` set ~205). Out-of-scope unconfined siblings: fs:readDir 603, fs:readFile 626, fs:findByExt 470, fs:grep 518, tasks:installSkill 699, prompts:* 752-812.
- `preload.js` fs bridge 52-61 (no change). `renderer/renderer.js` callers to keep working (all tab.folder-relative): editor save 1629, editor rename 2150, agent write 2768, team-config 5914/7059, writeWithMirror 6008-6027, skill checks 6854/8014, agents dir 7955-7966, ticket move 8176-8177, ticket saves 8914/9303/9348/9707/9800/9841/10063/11400, tasks-dir check 11203; `relFromFolder` 5984-5991 already case-insensitive (win32 precedent).
- NEW `lib/fs-roots.js` — Electron-free guard (pure, injectable platform), unit-tested; follow lib/keep-awake.js / lib/assets-mirror.js. Source-scan drift-guard pattern: `test/slack-summarize.test.js` PART 6, `test/task-036-keep-awake.e2e.test.js`.
- No existing test exercises the real main.js fs handlers (e2e suites mock window.api.fs — those mocks stay valid). 2 known-baseline failures unrelated.

## Impact If Not Fixed
A single renderer-side path-gate bypass (or a future un-gated caller) becomes an arbitrary filesystem read/write with the user's privileges outside the project tree; path safety is not enforced at the OS boundary where it belongs.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
