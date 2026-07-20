---
id: TASK-069
title: Reduce full-git-SHA false positives in the hex>=32 redaction rule (low priority)
status: done
created: 2026-07-19T21:05:00Z
updated: 2026-07-19T22:30:00Z
---

## Resolution: DECLINED / REVERTED (security)
Implementation was attempted and **reverted**. Exempting bare 40-char hex runs as
"git SHA-1" also exempts real secrets that are exactly 40 hex characters — notably
**legacy GitHub OAuth tokens** and hex-encoded 160-bit keys — which would then
leak *unlabeled* into Slack (an external destination). The harness flagged this as
a security regression, and the original TASK-063 reviewer had already noted that
over-redaction is the **safe** direction and this refinement was LOW/optional.

Outcome: `redactSecrets` now masks all hex runs ≥32 **unconditionally** (the secure
pre-069 behavior), and `test/slack-redaction.test.js` PART 1c asserts a bare 40-hex
string IS masked. No secret was exposed (nothing was committed or posted to a real
Slack workspace during the build).

If the git-SHA readability annoyance is worth revisiting, re-scope to a
**context-gated** exemption (only skip a 40-hex token when it appears in an explicit
git context, e.g. immediately after `commit ` / `git rev-parse` output) rather than
a blanket length exemption — so an unlabeled 40-hex secret with no git context stays
masked. That is a new, more careful ticket, not this one.

## Description
Follow-up from the TASK-063 tech-lead review (finding E, LOW/optional). The
hex≥32 rule in `redactSecrets` masks any 32+ contiguous hex run, which includes
full 40-char git SHA-1 hashes routinely echoed by `git log` / `git rev-parse`.
Over-redaction is the safe direction (this is NOT a security bug), but it
degrades legitimate dev output mirrored to Slack. The goal was to reduce this
false positive without weakening secret coverage — but see the Resolution above:
the only obvious implementation (blanket 40-hex exemption) DOES weaken coverage,
so it was declined.

## Acceptance Criteria
- [x] Decision recorded: the blanket 40-hex exemption is declined; redaction
      keeps masking all hex ≥32 (secure). A safer context-gated approach is left
      as a possible future ticket.
- [x] Renderer mirror stays byte-identical; helper stays pure and never throws.
- [x] Tests assert a bare 40-hex string IS masked and a `SECRET=<hex>` value is
      masked; full suite green under `node --test` aside from the two known
      pre-existing unrelated failures.

## Cucumber Tests
```gherkin
Feature: Hex secrets are not exempted by length

  Scenario: A bare 40-hex string is masked (no git-SHA exemption)
    Given output containing a bare 40-character hex string
    When redactSecrets runs
    Then it is replaced with the placeholder (over-redaction is the safe direction)

  Scenario: A secret-named hex value is masked
    Given output "SECRET=<40 hex>"
    When redactSecrets runs
    Then the value is replaced with the placeholder
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
