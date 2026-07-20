---
id: TASK-068
title: Redact inline connection-string credentials (scheme://user:pass@host) before Slack post
status: done
created: 2026-07-19T21:05:00Z
updated: 2026-07-19T22:15:00Z
---

## Description
Follow-up from the TASK-063 tech-lead review (finding B). Inline connection-string
credentials leak in auto-posted terminal output: a bare
`DATABASE_URL=postgres://user:hunter2@db:5432/app` is NOT redacted because
`DATABASE_URL` does not match the secret-key regex and the `://user:pass@` value
is not otherwise masked. DB/cache/broker URLs with inline passwords
(`postgres://`, `mysql://`, `mongodb+srv://`, `redis://:pass@…`, `amqp://…`) are
extremely common in logs and terminal output. Add a rule to `redactSecrets` that
masks the password segment of any `scheme://user:pass@host` URL.

## Acceptance Criteria
- [ ] `lib/slack-proxy.js` `redactSecrets` masks the password in
      `scheme://user:password@host` style URLs (any scheme), replacing the
      password with `***REDACTED***` while keeping the scheme/user/host readable
      (e.g. `postgres://user:***REDACTED***@db:5432/app`). Also handles the
      password-only form `redis://:password@host`.
- [ ] The renderer mirror stays BYTE-IDENTICAL (byte-identity test passes).
- [ ] Pure, never throws on null/undefined/non-string; runs after
      `cleanTerminalOutput` on both auto-post paths (no TASK-063 wiring change).
- [ ] Conservative — a URL with no credentials (`https://example.com/path`) is
      left completely unchanged; only the `user:pass@` credential segment is
      touched.
- [ ] Regex is backtracking-safe.
- [ ] Unit tests: each scheme masked; password-only form; no-credential URL
      untouched; null/empty safe. Full suite green under `node --test` (aside from
      the two known pre-existing unrelated failures).

## Cucumber Tests
```gherkin
Feature: Connection-string credential redaction

  Scenario: A Postgres URL password is masked
    Given output "DATABASE_URL=postgres://user:hunter2@db:5432/app"
    When redactSecrets runs
    Then the output contains "postgres://user:***REDACTED***@db:5432/app"
    And it does not contain "hunter2"

  Scenario: A password-only redis URL is masked
    Given output "redis://:s3cr3t@cache:6379"
    When redactSecrets runs
    Then "s3cr3t" is replaced with the placeholder

  Scenario: A credential-free URL is unchanged (edge)
    Given output "fetching https://example.com/api/v1/status"
    When redactSecrets runs
    Then the text is unchanged

  Scenario: Null/empty safe (failure/edge)
    When redactSecrets is called with "", null, undefined
    Then it returns a string and never throws
```

## Edge Cases & Failure Paths
- Only the password segment is masked; scheme/user/host stay readable for
  debuggability.
- Credential-free URLs and ordinary text are never altered.
- Keep the renderer mirror byte-identical.
- No catastrophic backtracking.

## Relevant Files & Context
- EDIT `lib/slack-proxy.js` `redactSecrets` (~100-122) + renderer mirror
  (`renderer/renderer.js` ~7833-7853).
- READ `test/slack-redaction.test.js` (TASK-063) for the test patterns; extend it
  or add `test/slack-redaction-conn.test.js`.
- Runner: `node --test`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
