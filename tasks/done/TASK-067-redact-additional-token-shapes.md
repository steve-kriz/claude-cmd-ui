---
id: TASK-067
title: Extend redactSecrets to cover more token shapes (Slack xapp/xoxe/xoxd, GitLab/GitHub-PAT/npm/DO/Google/SendGrid, bare JWTs)
status: done
created: 2026-07-19T21:05:00Z
updated: 2026-07-19T21:55:00Z
---

## Description
Follow-up from the TASK-063 tech-lead review (consolidates findings A, C, D —
all are "add more secret shapes to the same `redactSecrets` function + its
renderer mirror + tests"). TASK-063 shipped baseline redaction of auto-posted
Claude terminal output, but these realistic secret shapes still slip through:
- **Slack** `xapp-…` (app-level / Socket Mode), `xoxe-…`, `xoxd-…` — the current
  rule only matches `xox[baprs]-`. Especially relevant since this app IS a Slack
  integration whose config plausibly echoes `xapp-` tokens.
- **Other common prefixes**: `glpat-` (GitLab PAT), `github_pat_…` (GitHub
  fine-grained PAT — `ghp_` only covers classic), `npm_…`, `dop_v1_…`
  (DigitalOcean), `AIza…` (Google API key), `SG.…` (SendGrid).
- **Bare JWTs**: `eyJ<base64url>.<base64url>.<base64url>` — the base64≥40 rule
  uses `[A-Za-z0-9+/]` and requires a contiguous run, so dot-separated base64url
  JWT segments escape unless prefixed by a secret-named key.

Extend `redactSecrets` in `lib/slack-proxy.js` (and its verbatim renderer
mirror) to mask all of the above to `***REDACTED***`.

## Acceptance Criteria
- [ ] `lib/slack-proxy.js` `redactSecrets` masks: `xapp-…`, `xoxe-…`, `xoxd-…`
      (extend/augment the existing Slack-token rule); `glpat-…`, `github_pat_…`,
      `npm_…`, `dop_v1_…`, `AIza…`, `SG.<id>.<secret>` prefixes with plausible
      length/charset; and bare JWTs `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`.
- [ ] The renderer mirror is updated to stay BYTE-IDENTICAL (the existing
      byte-identity test must still pass).
- [ ] Redaction stays pure, never throws on null/undefined/non-string, and keeps
      running after `cleanTerminalOutput` on BOTH auto-post paths (no change to
      the TASK-063 wiring).
- [ ] Conservative — the new rules must not mask ordinary prose/code (e.g. a
      sentence starting "SG." mid-text, the word "npm", a normal `eyJ`-free
      base64 image blob under threshold). Add false-positive guard tests.
- [ ] Any new regex is linear / non-catastrophic (input is already truncated to
      ~12k by cleanTerminalOutput, but keep patterns backtracking-safe).
- [ ] Unit tests: each new shape masked; ordinary text untouched; null/empty safe.
      Full suite green under `node --test` (aside from the two known pre-existing
      unrelated failures).

## Cucumber Tests
```gherkin
Feature: Extended secret redaction shapes

  Scenario: A Slack app-level token is masked
    Given terminal output "SLACK_APP_TOKEN=xapp-1-A0000-1111-abcdef"
    When redactSecrets runs
    Then the output contains "***REDACTED***" and not the raw xapp- token

  Scenario: A bare JWT is masked
    Given output "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123-_"
    When redactSecrets runs
    Then the JWT is replaced with the placeholder

  Scenario: A GitLab PAT and a Google API key are masked
    Given output containing "glpat-xxxxxxxxxxxxxxxxxxxx" and "AIzaSyD-xxxxxxxxxxxxxxxxxxxxxxxxxxx"
    When redactSecrets runs
    Then both are replaced

  Scenario: Ordinary text is not mangled (edge)
    Given output "Installed via npm; see the SG. section of the docs"
    When redactSecrets runs
    Then the text is unchanged

  Scenario: Null/empty safe (failure/edge)
    When redactSecrets is called with "", null, undefined
    Then it returns a string and never throws
```

## Edge Cases & Failure Paths
- Do not regress the shapes TASK-063 already covers.
- Keep the renderer mirror byte-identical (drift = leak on the renderer path).
- Base64url (with `-`/`_`) differs from base64 — the JWT rule needs the URL-safe
  charset.
- No catastrophic backtracking on adversarial input.

## Relevant Files & Context
- EDIT `lib/slack-proxy.js` `redactSecrets` (~100-122) and its renderer mirror
  in `renderer/renderer.js` (~7833-7853).
- READ TASK-063's `test/slack-redaction.test.js` for the unit + byte-identity +
  no-bypass source-scan patterns; extend it (or add `test/slack-redaction-shapes.test.js`).
- Runner: `node --test`. Mock all Slack calls.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
