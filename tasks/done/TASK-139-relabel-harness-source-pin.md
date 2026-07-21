---
id: TASK-139
title: Source-pin index.html in the TASK-133 relabel e2e harness
status: done
created: 2026-07-21T09:54:54.000Z
updated: 2026-07-21T11:10:24.000Z
review-of: TASK-133
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T09:56:00.000Z","finishedAt":"2026-07-21T09:59:30.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T11:03:00.000Z","finishedAt":"2026-07-21T11:03:00.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T11:03:00.000Z","finishedAt":"2026-07-21T11:06:34.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T11:06:34.000Z","finishedAt":"2026-07-21T11:10:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T11:10:00.000Z","finishedAt":"2026-07-21T11:10:24.000Z"}]
---

## Description

Tech-lead review of TASK-133 found that `setupRendererHarness` in
`test/task-133-linux-mac-compat.e2e.test.js:101-133` builds a synthetic mock DOM whose
element text and selector keys are hard-coded copies of today's `renderer/index.html`
strings (e.g. `makeEl({ textContent: 'Git Bash' })` at :104 and the selector-keyed
`_children` maps at :106, :112, :117, :119-122, :128). The REAL relabel blocks are
extracted from `renderer.js` and executed against that synthetic DOM, but no assertion
ties the relabels' selectors / "before" text back to the actual `renderer/index.html`.
TASK-133's AC group C's real guarantee — that the relabels fire on the live DOM — is
therefore unverified. The strings currently match (verified 2026-07-21), so there is
no live defect; this is a coverage/robustness gap only. No production code change is
expected — this ticket adds source-pin assertions that read `renderer/index.html` at
test time, mirroring how the TASK-133 unit test
(`test/task-133-linux-mac-compat.test.js:28`) already source-pins `renderer.js` via
`fs.readFileSync`.

## Impact If Not Fixed

Low. A later edit to `index.html` (renaming the bash tab, changing the opencode option
text, or renaming the `git-auth-hint` / `gitAuthHint` / `opencodeInstallBtn` classes)
would silently turn the mac/Linux relabels into no-ops while the whole suite stays
green, reintroducing Windows-worded copy on mac with no failing test to catch it.

## Acceptance Criteria

- [ ] The TASK-133 e2e (or a sibling test in the same file) reads `renderer/index.html`
  at test time and asserts the exact "before" strings the relabels depend on are
  present:
  - the bash-tab label `Git Bash` (index.html:229, `data-tab="bash">Git Bash`),
  - the opencode option text `git bash · openCode` (index.html:161),
  - the empty-state intro (index.html:22 — note the raw markup contains
    `<code>cmd.exe</code>` / `<code>Git Bash</code>`, so pin markup-aware fragments,
    not the flat textContent string the harness uses at :127),
  - the opencode banner sentence `Install it to run openCode in Git Bash.`
    (index.html:213),
  - the opencode install button text `Install in Git Bash` (index.html:216),
  - the gh-login hint prefix `Login runs in the Git Bash tab.` (index.html:412),
  - the winget hint prefix `winget install runs in the Git Bash terminal`
    (index.html:399) —
  so a change to any of them fails the test.
- [ ] The e2e also asserts the selector-bearing classes/attributes the relabels query
  exist in `index.html`: `tab-btn` with `data-tab="bash"` (:229),
  `option value="opencode"` (:161), `install-banner-text` inside the
  `opencodeInstallBanner` block (:210-211 — the class alone is not unique; it also
  appears at :198 and :679), `opencodeInstallBtn` (:216), `gitAuthHint` (:412), and
  the winget hint's `git-auth-hint` inside the `gitNotInstalledGate` block
  (:388, :399 — `git-auth-hint` alone is not unique; :412 also carries it).
- [ ] The pins additionally cover the claude option `option value="claude"` /
  `cmd · claude` (index.html:160) so they stay in sync with TASK-138's relabel
  (TASK-138 does not edit index.html, so this pin is safe whether or not it has
  landed).
- [ ] The assertions read the real `renderer/index.html` at test time (source-pin), the
  same way the TASK-133 unit test source-pins `renderer.js` via `fs.readFileSync`
  (test/task-133-linux-mac-compat.test.js:28) and the e2e's own `readRepo` helper
  (test/task-133-linux-mac-compat.e2e.test.js:40-46) — not a hard-coded duplicate of
  the strings.
- [ ] No production files change (test-only: `renderer/index.html`,
  `renderer/renderer.js`, and all `lib/` files are untouched).
- [ ] All existing tests stay green; only the 2 known baseline failures remain.

## Cucumber Tests

```gherkin
Feature: The relabel e2e is source-pinned to index.html

  Scenario: before-strings are pinned to the shipped markup
    Given the contents of renderer/index.html read at test time
    Then it contains the bash-tab label "Git Bash"
    And it contains the opencode option text "git bash · openCode"
    And it contains the banner sentence "Install it to run openCode in Git Bash."
    And it contains the install button text "Install in Git Bash"
    And it contains the gh-login hint prefix "Login runs in the Git Bash tab."
    And it contains the winget hint prefix "winget install runs in the Git Bash terminal"
    And it contains the empty-state fragments naming cmd.exe and Git Bash

  Scenario: relabel selectors are pinned to the shipped markup
    Given the contents of renderer/index.html read at test time
    Then it contains a tab-btn element with data-tab="bash"
    And it contains option value="opencode" and option value="claude"
    And it contains the opencodeInstallBtn and gitAuthHint classes
    And it contains a git-auth-hint inside the gitNotInstalledGate block
    And it contains an install-banner-text inside the opencodeInstallBanner block

  Scenario (failure): a renamed selector/string would fail the pin
    Given a hypothetical index.html where the bash tab label was renamed
    Then the source-pin assertion for "Git Bash" fails
    And the gap that would silently no-op the mac relabel is caught

  Scenario (edge): a class rename without a copy change is still caught
    Given a hypothetical index.html where gitAuthHint was renamed but the hint text kept
    Then the selector pin for gitAuthHint fails even though the string pin passes
```

## Edge Cases and Failure Modes

- **Strings vs classes**: pin BOTH the "before" text (so a copy change is caught) and
  the selector classes/attributes (so a class rename is caught) — either alone leaves
  a silent-no-op gap.
- **Non-unique selectors**: `.install-banner-text` appears three times in index.html
  (:198, :211, :679) and `.git-auth-hint` twice (:399, :412). The pins must scope to
  the right block (the `opencodeInstallBanner` at :210 and the `gitNotInstalledGate` at
  :388 respectively) — e.g. by slicing the file at the container class before asserting
  — otherwise a rename of the relevant occurrence could pass on a sibling.
- **Markup vs textContent**: the empty-state copy at index.html:22 contains
  `<code>`/`<strong>` tags, so the harness's flat textContent string (e2e :127) cannot
  be asserted verbatim against raw HTML. Pin markup-aware fragments (or strip tags)
  rather than the flattened string.
- **Keep in sync with TASK-138**: TASK-138 adds a claude-option relabel in renderer.js
  only. Pin `option value="claude"` / `cmd · claude` (index.html:160) now — index.html
  is unchanged by TASK-138, so the pin holds before and after it lands.
- **Test-only**: do not modify `renderer/index.html` or `renderer/renderer.js`; if a
  pin fails against today's markup, the pin is wrong, not the markup.
- **Baseline noise**: only the 2 known baseline failures may remain.

## Relevant Files and Context

- `test/task-133-linux-mac-compat.e2e.test.js:101-133` — `setupRendererHarness` with
  the hard-coded synthetic DOM strings and selector-keyed `_children` maps (`makeEl` at
  :83-96); add the source-pin assertions in this file. The file already has a `readRepo`
  helper (:40-46) that reads repo files with `fs.readFileSync` — use it
  (`readRepo(path.join('renderer', 'index.html'))`).
- `test/task-133-linux-mac-compat.test.js:28, :82-102` — the unit test that already
  source-pins `renderer.js` via `fs.readFileSync` + `assert.match` phrase pins; mirror
  this approach for `index.html`.
- `renderer/index.html` — lines 22 (empty-state `<p>` inside `.empty-msg` at :20), 160
  (`option value="claude"` / `cmd · claude`), 161 (`option value="opencode"` /
  `git bash · openCode`), 210-213 (`opencodeInstallBanner` > `install-banner-text` >
  "Install it to run openCode in Git Bash."), 216 (`opencodeInstallBtn` / "Install in
  Git Bash"), 229 (`tab-btn` `data-tab="bash"` / "Git Bash"), 388 (`gitNotInstalledGate`),
  399 (winget `git-auth-hint` hint), 412 (`gitAuthHint git-auth-hint` gh-login hint).
- `renderer/renderer.js:838-870` — the pane-copy `if (!isWin())` relabel block whose
  selectors must match index.html; `renderer.js:12597-12602` — the empty-state relabel
  querying `.empty-msg p`.
- `tasks/todo/TASK-138-relabel-claude-agent-option.md` — sibling review follow-up adding
  the `option[value="claude"]` relabel (renderer.js only); the pins here must stay in
  sync with it.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
