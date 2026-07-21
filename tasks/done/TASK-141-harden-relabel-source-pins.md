---
id: TASK-141
title: Pin the empty-state relabel selector and loosen order-sensitive pin regexes
status: done
created: 2026-07-21T11:10:24.000Z
updated: 2026-07-21T11:24:53.000Z
review-of: TASK-139
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T11:10:24.000Z","finishedAt":"2026-07-21T11:10:24.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T11:16:30.000Z","finishedAt":"2026-07-21T11:16:30.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T11:16:30.000Z","finishedAt":"2026-07-21T11:21:33.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T11:21:33.000Z","finishedAt":"2026-07-21T11:24:40.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T11:24:40.000Z","finishedAt":"2026-07-21T11:24:53.000Z"}]
---

## Description

Tech-lead review of TASK-139 found two low-severity gaps in the index.html
source-pins added to `test/task-133-linux-mac-compat.e2e.test.js`. Both are
test-only (no production change). This ticket addresses both:

**Finding 1 (legitimate coverage gap) — the empty-state relabel selector `.empty-msg p`
is not pinned (only its copy is).** The empty-state relabel does
`dom.emptyState.querySelector('.empty-msg p')` then overwrites `textContent`
(renderer.js:~12602; markup index.html:20-22). TASK-139 pins the copy fragments
(`<code>cmd.exe</code>`, `<code>Git Bash</code>`, the intro fragment) but NOT the
selector structure (`.empty-msg` class / the `<p>` descendant). If `.empty-msg` were
renamed (or the `<p>` changed) while the copy stayed, `querySelector` returns null,
the relabel silently no-ops, and macOS/Linux keep the Windows-only wording — while
every string pin still passes. This is the exact silent-no-op class TASK-139 exists
to prevent, left open for one selector, and inconsistent with the `.gitAuthHint`
coverage (which has a dedicated "class renamed, copy kept" edge).

**Finding 2 (brittleness note) — two pin regexes assume attribute/class-token order.**
`test/task-133-linux-mac-compat.e2e.test.js:~573` (`class="tab-btn[^"]*"\s+data-tab="bash"`)
and `:~588` (`class="opencodeInstallBtn[^"]*"`) require `class` to precede `data-tab`
and require the token to be first in the class list. The real relabels use
order-independent CSS selectors, so a purely cosmetic markup reformat
(`data-tab="bash" class="tab-btn ..."` or `class="active tab-btn"`) would keep the
relabel working but fail these pins — a false positive.

## Impact If Not Fixed

Low. Finding 1: a future index.html rename of the empty-state container/paragraph
selector would silently disable the macOS/Linux empty-state relabel and reintroduce
"cmd.exe"/"Git Bash" wording on the first-run screen for Mac/Linux users, with the
suite staying green. Finding 2: a harmless markup reformat could break the build with
a misleading "relabel dependency gone" failure, costing developer time; no
user-facing risk.

## Acceptance Criteria
- [ ] A source-pin is added asserting the empty-state relabel's SELECTOR structure:
  `renderer/index.html` contains `class="empty-msg"` and a `<p>` inside that
  container (slice the `empty-msg` block the way `opencodeBannerBlock` /
  `gitNotInstalledGateBlock` are sliced), so a rename of `.empty-msg` or the `<p>`
  fails the pin.
- [ ] A mutation/edge scenario is added (mirroring the existing `.gitAuthHint`
  "class renamed, copy kept" edge) proving the new selector pin FAILS when
  `.empty-msg` is renamed while the copy is unchanged.
- [ ] The two order-sensitive pin regexes (bash-tab `tab-btn`+`data-tab="bash"`, and
  `opencodeInstallBtn`) are loosened to be order-insensitive: match the
  `data-tab="bash"` attribute and separately assert a `\btab-btn\b` class token; and
  assert `\bopencodeInstallBtn\b` as a token — so a cosmetic attribute/token reorder
  does not falsely fail while a genuine removal still does.
- [ ] The loosened pins still FAIL if the real dependency is actually removed
  (a negative check proving they didn't become vacuous).
- [ ] No production files change (test-only); no existing TASK-133/TASK-138/TASK-139
  assertion is weakened.
- [ ] All existing tests stay green; only the 2 known baseline failures remain.

## Cucumber Tests

```gherkin
Feature: The empty-state relabel selector is source-pinned and pins are order-insensitive

  Scenario: the empty-state selector structure is pinned
    Given the contents of renderer/index.html read at test time
    Then it contains class="empty-msg"
    And a <p> element exists inside the empty-msg container

  Scenario (failure): renaming .empty-msg while keeping the copy fails the pin
    Given a hypothetical index.html where empty-msg was renamed but the cmd.exe/Git Bash copy kept
    Then the empty-state selector pin fails
    And the silent-no-op of the empty-state relabel on mac/Linux is caught

  Scenario (edge): a cosmetic attribute/token reorder does not falsely fail
    Given index.html writes the bash tab as data-tab="bash" class="active tab-btn"
    Then the loosened bash-tab pin still passes (data-tab + tab-btn token both present)

  Scenario (failure): removing the tab-btn token still fails the loosened pin
    Given a hypothetical index.html where the bash tab lost its tab-btn class
    Then the loosened bash-tab pin fails
```

## Edge Cases and Failure Modes
- **Scope the empty-msg slice** so the selector pin can't be satisfied by an
  unrelated `.empty-msg`/`<p>` elsewhere (mirror the container-slice approach used for
  the non-unique `.install-banner-text` / `.git-auth-hint` pins).
- **Don't go vacuous**: each loosened regex must still fail when the real token is
  removed — include a negative assertion.
- **Test-only**: do not modify renderer.js or index.html.
- **Baseline noise**: only the 2 known baseline failures may remain.

## Relevant Files and Context
- `test/task-133-linux-mac-compat.e2e.test.js` — the TASK-139 source-pin block
  (~:482-629); empty-state copy pins ~:557-566; the two order-sensitive regexes
  ~:573 and ~:588; the `.gitAuthHint` rename edge ~:614-628 to mirror; the
  container-slice pattern (`opencodeBannerBlock`, `gitNotInstalledGateBlock`) to reuse
  for the `empty-msg` slice.
- `renderer/renderer.js:~12601-12606` — the empty-state relabel querying `.empty-msg p`.
- `renderer/index.html:20-22` — the `empty-msg` container + `<p>`; :229 bash tab
  (`tab-btn` + `data-tab="bash"`); :216 `opencodeInstallBtn`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
