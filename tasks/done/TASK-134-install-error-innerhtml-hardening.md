---
id: TASK-134
title: Harden Tasks-banner install-error message (innerHTML → textContent)
status: done
created: 2026-07-21T09:01:45.000Z
updated: 2026-07-21T10:24:26.000Z
review-of: TASK-131
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T09:49:30.000Z","finishedAt":"2026-07-21T09:50:30.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T09:55:30.000Z","finishedAt":"2026-07-21T09:58:26.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T09:58:26.000Z","finishedAt":"2026-07-21T10:03:03.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T10:03:03.000Z","finishedAt":"2026-07-21T10:24:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T10:24:00.000Z","finishedAt":"2026-07-21T10:24:26.000Z"}]
---

## Description

Tech-lead review of TASK-131 found that `installOrchestrateSkill` renders its
install-failed message via `innerHTML` in `renderer/renderer.js` (currently
line ~9770; the function starts at ~:9760 — the review's ~:9610 reference has
drifted):

```
textEl.innerHTML = '<strong>Install failed.</strong> ' + ((res && res.error) || 'unknown error');
```

This is the only one of the three install surfaces that uses `innerHTML` for the
error — the Workflow (`buildWorkflowInstallHint`, ~:7206) and Agents
(`buildAgentsInstallHint`, ~:8018) surfaces already render the same error via
`textContent` on a `<strong>` element plus a text node, and the
`.skill-restart-notice` added by TASK-131 is `textContent`-only. `res.error` comes
from the `tasks:installSkill` IPC handler in `main.js`: it is either the fixed
`OUTSIDE_ROOT_ERROR` constant (`main.js:~691`) or a Node fs `err.message` that
embeds the target folder path, so a path containing HTML-like markup would be
parsed as HTML in the renderer. Pre-existing (not introduced by TASK-131) and
effectively self-XSS on a local desktop app, but it is an inconsistency in a
function TASK-131 edited and should be hardened to match the other two surfaces.

The fix: in the `!res.ok` branch of `installOrchestrateSkill`, replace the
`innerHTML` assignment with DOM construction — clear `textEl`
(`textEl.textContent = ''`), then append a `<strong>` element with
`textContent = 'Install failed.'` and a text node carrying
`' ' + ((res && res.error) || 'unknown error')`. Note that unlike the two sibling
builders (which create their banner nodes fresh each render), this `textEl` is a
**static element** declared in `renderer/index.html` (~:678–682) that already
contains `<strong>Orchestration skill not installed.</strong>` plus text, so the
element must be cleared before appending the failure nodes.

## Impact If Not Fixed

Low. A user who opens a folder whose name/path contains markup could see malformed
or script-bearing content rendered into the Tasks banner on an install error; in an
Electron renderer this is a latent injection surface. It is trivially removed by
switching to `textContent`, and leaving it keeps one surface inconsistent with the
two already-hardened ones.

## Acceptance Criteria
- [ ] `installOrchestrateSkill`'s install-failed message is rendered without
  `innerHTML` — the element is cleared, then a `<strong>` element with
  `textContent = 'Install failed.'` and a text node for the error string are
  appended, mirroring `buildWorkflowInstallHint` / `buildAgentsInstallHint`.
- [ ] The rendered text is unchanged for a normal error: the banner text still
  reads `Install failed. <error>` (single space between the strong prefix and the
  error), and a missing/falsy `res.error` still falls back to `unknown error`.
- [ ] An error string containing HTML-like markup (e.g. a folder path with
  `<img src=x onerror=...>`) appears literally in the banner text and is never
  parsed into element nodes.
- [ ] No other behavior of `installOrchestrateSkill` changes: the `textEl` null
  guard is kept, the button is re-enabled and its label restored on failure, the
  early `return` remains, and DOM class names (`install-banner-text`,
  `tasksSkillBanner`) stay stable.
- [ ] The pre-cleared banner content is fully replaced — repeated failed install
  attempts do not accumulate duplicate `Install failed.` nodes.
- [ ] A test asserts the error message is set without `innerHTML` (DOM
  nodes/textContent only) and that an error string containing markup is rendered
  literally, not parsed as HTML. The existing `innerHTML`-based assertions in
  `test/task-131-skill-registration.e2e.test.js` (~:469–470, ~:491) are updated to
  `textContent`-based assertions so the suite stays green.

## Cucumber Tests

```gherkin
Feature: Tasks-banner install-error message is rendered as text, never HTML

  Background:
    Given a project tab whose Tasks board shows the "Orchestration skill not installed" banner
    And the banner's text element is the static ".install-banner-text" from index.html

  Scenario: Failed install shows the plain-text failure message
    Given the tasks:installSkill IPC responds with ok=false and error "disk full"
    When the user clicks the Install button and the call completes
    Then the banner text reads "Install failed. disk full"
    And the "Install failed." prefix is a <strong> element set via textContent
    And the error is appended as a text node, not via innerHTML
    And the Install button is re-enabled with its original label

  Scenario: Missing error falls back to "unknown error"
    Given the tasks:installSkill IPC responds with ok=false and no error field
    When the user clicks the Install button and the call completes
    Then the banner text reads "Install failed. unknown error"

  Scenario: Edge/failure — error containing markup is rendered literally, not parsed as HTML
    Given the tasks:installSkill IPC responds with ok=false and error containing "<img src=x onerror=alert(1)>"
    When the user clicks the Install button and the call completes
    Then the banner's textContent contains the literal string "<img src=x onerror=alert(1)>"
    And no <img> element (or any element parsed from the error string) exists inside ".install-banner-text"
    And the element's innerHTML setter was never invoked

  Scenario: Edge — repeated failures do not stack duplicate messages
    Given the tasks:installSkill IPC responds with ok=false and error "boom"
    When the user clicks the Install button twice, letting each call complete
    Then the banner text reads "Install failed. boom" exactly once
    And there is exactly one <strong> child inside ".install-banner-text"

  Scenario: Edge — banner text element missing is a no-op
    Given the tasksSkillBanner contains no ".install-banner-text" descendant
    And the tasks:installSkill IPC responds with ok=false
    When the user clicks the Install button and the call completes
    Then no exception is thrown
    And the Install button is re-enabled with its original label

  Scenario: Successful install path is unchanged
    Given the tasks:installSkill IPC responds with ok=true
    When the user clicks the Install button and the call completes
    Then the banner gains the "hidden" class and its text is not modified
    And the restart-registration notice flow (promptSkillRegistration) still runs
```

## Edge Cases and Failure Modes

- **Markup in the error string**: `res.error` embeds a filesystem path (Node fs
  `err.message`); a path segment like `<img src=x>` or `<script>` must render as
  literal text. This is the core of the fix.
- **Falsy `res` or missing `res.error`**: must still fall back to `'unknown error'`
  — preserve the `((res && res.error) || 'unknown error')` expression.
- **Stale static content**: `.install-banner-text` starts with the
  index.html-declared `<strong>Orchestration skill not installed.</strong>` +
  description text. The old `innerHTML` write implicitly replaced it; the new
  DOM-building code must explicitly clear (`textContent = ''`) first, or the failure
  message would be appended after the original prompt.
- **Repeated failures**: clicking Install again after a failure re-enters the
  branch; without clearing first, `<strong>Install failed.</strong>` nodes would
  accumulate.
- **`textEl` is null**: `querySelector('.install-banner-text')` can return null; the
  existing `if (textEl)` guard must be kept so the button-restore path still runs.
- **Whitespace fidelity**: the current message renders as `Install failed. <error>`
  (strong, space, error). Mirror the siblings' pattern of putting the leading space
  in the text node (`' ' + error`) so the visible text is byte-identical.
- **Existing test coupling**: `test/task-131-skill-registration.e2e.test.js`
  asserts `.install-banner-text`'s `innerHTML`; after the fix the fake element's
  `innerHTML` getter returns `''`, so those assertions must move to `textContent`.

## Relevant Files and Context

- `renderer/renderer.js`
  - `installOrchestrateSkill(tab)` — ~:9760–9789. The offending write is ~:9770:
    `textEl.innerHTML = '<strong>Install failed.</strong> ' + ((res && res.error) || 'unknown error');`
    inside the `!res || !res.ok` branch. Keep the surrounding logic (button
    disable/restore, early return, success path, catch block) untouched.
  - `buildWorkflowInstallHint(tab)` — ~:7206–7252. The pattern to mirror: creates
    `strong` (`document.createElement('strong')`) and a text node, and on failure
    sets `strong.textContent = 'Install failed.'` / text node `' ' + error`.
  - `buildAgentsInstallHint(tab)` — ~:8018–8064. Same pattern.
- `renderer/index.html` — ~:678–682. The static `tasksSkillBanner` markup whose
  `.install-banner-text` child holds the default text the failure message replaces.
  Do not change this markup; class names are looked up by renderer.js and tests.
- `test/task-131-skill-registration.e2e.test.js` — the existing e2e harness for
  these three surfaces. Update the `innerHTML` assertions (~:469–470, ~:491) to
  `textContent`, and add the new markup-literal + no-innerHTML assertions here (or in
  a small sibling `task-134` test following this file's conventions). The mock DOM's
  `makeEl` has no `replaceChildren`; prefer `textContent = ''` + `appendChild`.
- `main.js` — ~:691 `OUTSIDE_ROOT_ERROR` and the `tasks:installSkill` handler that
  produces `res.error`. No changes needed here; context only for why the error
  string is untrusted.
- Convention precedent: existing "never innerHTML" drift guards in the test suite —
  a source-level guard asserting no `innerHTML =` in the `installOrchestrateSkill`
  block would match house style.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
