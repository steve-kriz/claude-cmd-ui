---
id: TASK-109
title: Validate slug is filesystem-safe in folderForStatusWith (lib path-traversal)
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T02:39:32.303Z
review-of: TASK-099
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:20:00Z","finishedAt":"2026-07-21T02:28:28Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:22:00Z","finishedAt":"2026-07-21T02:36:33Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T02:23:00Z","finishedAt":"2026-07-21T02:39:32Z"}]
---

## Description
`lib/ticket-folders.js` `folderForStatusWith` returns the status verbatim as a `tasks/<slug>/` folder name whenever `isKnownStatusFor` is true, and `userStatusSetFor` (lib/ticket-lanes.js) admits any trimmed non-empty non-reserved slug WITHOUT enforcing the `^[a-z0-9-]+$`/length rule that team-config `normalizeConfig` applies. So an un-normalized columns entry with `status: "../../evil"` yields that traversal string as `targetFolder`. The renderer consumer (TASK-102 `isSafeTasksSlug`) mitigates this in the app today, but the lib layer (the filesystem boundary) has no defense-in-depth.

**Fix:** enforce a filesystem-safe slug rule at the lib layer.
1. Add an exported predicate `isFsSafeSlug(slug)` to `lib/ticket-lanes.js` implementing EXACTLY team-config's rule (mirrored by renderer `isSafeTasksSlug`): `typeof slug === 'string'`, length 1..30, matches `/^[a-z0-9-]+$/` (this class inherently excludes `.`/`..`/`/`/`\`/`:`). Do NOT `require('./team-config')` (cycle — team-config requires ticket-lanes); its SLUG_RE/isValidUserSlug aren't exported. Define the rule locally with lockstep comments in both files.
2. Gate `userStatusSetFor` (ticket-lanes.js): a column slug failing `isFsSafeSlug` never enters the user-status set. This transitively hardens `folderForStatusWith`/`folderMatchesStatusWith`/`reconcileFolderWith`/`dedupeByFolder` and `isUserStatus`/`isKnownStatusFor`/`laneForStatusFor`/`laneStatusesFor`. All six system slugs + `failed-testing` satisfy the rule, so system behavior is untouched.
3. Do NOT change lib/team-config.js behavior/exports (MAX_SLUG_LENGTH stays 30) or touch renderer/renderer.js (test/ticket-folders.test.js source-scans it).

Consequence (intended): an unsafe slug also stops being a user LANE — `laneForStatusFor('../../evil', cols)` → `unknown` (never `todo`), `laneStatusesFor` omits it. team-config normalize already refuses to emit such a column, so only raw/tampered configs are affected.

Severity from review: **major**. This is a review follow-up of TASK-099.

## Acceptance Criteria
- [ ] `lib/ticket-lanes.js` exports `isFsSafeSlug(slug)` → true iff string, 1..30 chars, `/^[a-z0-9-]+$/`; false (never throws) for non-strings incl. null/undefined/number/Symbol (typeof-guard BEFORE any regex test).
- [ ] The rule is byte-equivalent to team-config `isValidUserSlug` (SLUG_RE `/^[a-z0-9-]+$/`, MAX 30); lockstep comments added in both lib files (ticket-lanes must NOT require team-config).
- [ ] `userStatusSetFor` excludes any column whose trimmed slug fails `isFsSafeSlug`: `../../evil`, `..`, `a/b`, `a\b`, `UX-Review`, `ux review`, and 31+ char slugs never enter the set.
- [ ] `folderForStatusWith('../../evil', columns)` returns `null` even when that column appears in `columns`; `folderMatchesStatusWith` false; `reconcileFolderWith` → `{needsMove:false, targetFolder:null}` (file left in place).
- [ ] `isUserStatus`/`isKnownStatusFor` false for unsafe slugs; `laneForStatusFor(unsafe, cols)` → `unknown` (never `todo`); `laneStatusesFor` omits unsafe slugs while still anchoring valid user columns correctly.
- [ ] `dedupeByFolder` with per-entry `columns` declaring an unsafe slug degrades to first-seen-wins, never throws.
- [ ] Valid slug (`ux-review`, and a 30-char slug) behaves exactly as before across all `*For`/`*With` helpers.
- [ ] Every system/valid status behaves identically for any `columns`; null/[]/junk `columns` still degrade to fixed system-only behavior.
- [ ] No export removed/changed in ticket-lanes.js/ticket-folders.js; team-config.js + renderer.js unmodified; team-config MAX_SLUG_LENGTH stays 30.
- [ ] All hardened functions never throw on hostile input (Symbols, objects, getters).
- [ ] `test/ticket-folders.test.js`, `test/task-098-*.{test,e2e.test}.js`, `test/task-099-*.{test,e2e.test}.js` pass UNMODIFIED.
- [ ] New unit tests (`test/task-109-slug-traversal-hardening.test.js`) cover traversal, the exclusion matrix, never-throws, and the unchanged-valid-slug regression.

## Cucumber Tests
```gherkin
Feature: Filesystem-safe slug enforcement in lib folder/lane helpers
  Scenario: A path-traversal slug never owns a folder (failure)
    Given a columns array containing { status: "../../evil", system: false }
    When folderForStatusWith("../../evil", columns) is called
    Then it returns null
    And reconcileFolderWith("todo","../../evil",columns) returns { needsMove:false, targetFolder:null }
  Scenario Outline: Unsafe slugs are excluded from the user-status set
    Given a columns array containing { status: "<slug>", system: false }
    Then isUserStatus("<slug>", columns) is false
    And laneForStatusFor("<slug>", columns) is "unknown"
    And laneStatusesFor(columns) does not include "<slug>"
    Examples:
      | slug |
      | .. |
      | ../../evil |
      | evil/child |
      | evil\child |
      | UX-Review |
      | ux review |
      | this-slug-is-way-too-long-to-be-allowed-here-x |
  Scenario: A valid user slug keeps working (regression)
    Given the default config columns plus { status: "ux-review", system: false }
    Then folderForStatusWith("ux-review", columns) is "ux-review"
    And laneForStatusFor("ux-review", columns) is "ux-review"
    And a slug of exactly 30 [a-z0-9-] characters is likewise accepted
  Scenario: System statuses unaffected under any columns input
    Given any columns value including null, [], junk, and arrays with unsafe slugs
    Then every VALID_STATUSES entry still owns its own folder and degrades exactly to folderForStatus/reconcileFolder
  Scenario: Hostile input never throws (failure)
    Given columns containing Symbols, numbers, nested arrays, getter-trap objects
    When the hardened helpers run
    Then nothing throws and each returns its safe degraded result
```

## Edge Cases & Failure Paths
- `..`/`.`/`../../evil`/`evil/child`/`evil\child`/`C:\x` all fail; 31-char rejected, 30-char accepted (boundary). `UX-Review`/`ux_review`/`ux review`/unicode/`%2e%2e%2f` rejected. Non-string `status` coerced to '' by columnSlug — no reintroduced throw; Symbol handled by typeof-guard before regex. columnSlug trims before add. Reserved slugs (VALID_STATUSES/`unknown`) stay excluded (additive gate). `system:true` columns stay skipped. Unsafe slug produces no lane and must not disturb valid user-column anchoring. dedupeByFolder junk per-entry columns first-seen-wins. Do NOT normalize/strip a bad slug — it owns no folder, full stop.

## Relevant Files & Context
- `lib/ticket-lanes.js` — primary edit: `columnSlug` (~119), `userStatusSetFor` (~126-136) ← add gate; consumers `isUserStatus`/`isKnownStatusFor`/`laneForStatusFor`/`laneStatusesFor` hardened transitively (verify laneStatusesFor anchoring loop still skips unsafe via `userSlugs.has`); `module.exports` add `isFsSafeSlug`; module contract comments (~103-109: never require team-config).
- `lib/ticket-folders.js` — no logic change (hardened via isKnownStatusFor); update the TASK-099 comment block to document the gate.
- `lib/team-config.js` — READ ONLY: SLUG_RE/MAX_SLUG_LENGTH (~82-83), isValidUserSlug (~127-132); requires ticket-lanes (cycle constraint). Do not modify.
- `renderer/renderer.js` — DO NOT MODIFY (isSafeTasksSlug ~6153-6159 stays as the second layer; ticket-folders.test.js source-scans it).
- Tests to keep unmodified: ticket-folders.test.js, task-098-*, task-099-*. New: `test/task-109-slug-traversal-hardening.test.js` (pure node --test, hand-built columns, defaultConfig where needed).

## Impact If Not Fixed
If any future caller passes raw (un-normalized) config to the lib folder helpers, a malformed/tampered team-config.json slug could cause ticket .md files to be created or relocated outside the tasks/ tree (arbitrary directory write / path traversal).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
