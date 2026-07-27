---
id: TASK-177
title: decodeAttrValue can double-decode a project path containing literal %XX sequences
status: done
created: 2026-07-27T01:59:49.000Z
updated: 2026-07-27T03:09:38.432Z
review-of: TASK-167
resolution: wont-do
---

## Description
Tech-lead review of TASK-167 found a residual, medium-severity issue: after
TASK-167 removed the trim from `decodeAttrValue`, it still calls
`decodeURIComponent(s)` UNCONDITIONALLY. The ticket's own premise (an inline
comment) is that Claude Code's OTEL SDK "already fully percent-decodes" the
value before it reaches this parser, so the decode here should be a no-op
when no `%XX` escape survives.

That justification only holds when NO literal `%XX` sequence survives in the
value. But since `main.js`'s `buildOtelProjectEnv` percent-ENCODES the
project path on spawn (`encodeURIComponent`), and the SDK decodes exactly
ONCE before the OTLP export, a project folder whose LITERAL name contains a
`%` followed by two valid hex digits (e.g. `C:\report%2Fv2`, `cache%40home`,
`data%3Aset` — realistic folder names, especially auto-generated backup/cache
directories) gets decoded a SECOND time by `decodeAttrValue`, corrupting the
bucket key.

Worked example: folder `C:\report%2Fv2` — app encodes to
`project%3Dproject%253D...` wait, more precisely: app encodes the raw folder
string via `encodeURIComponent('C:\report%2Fv2')` →
`C%3A%5Creport%252Fv2` (the literal `%` in the folder name becomes `%25`) →
SDK decodes ONCE → back to `C:\report%2Fv2` (correct, matches the original) →
`decodeAttrValue` decodes AGAIN → `%2F` becomes `/` → bucket key becomes
`C:\report/v2`, which no longer matches the toggle key (`setProjectForwarding`
is never trimmed/decoded, stores the RAW `tab.folder` string
`C:\report%2Fv2` exactly).

## Impact If Not Fixed
A user whose project folder path contains a literal `%NN` (valid-hex)
sequence will silently get NO "store online" forwarding for that project
despite the toggle being ON, with no error or feedback — the same class of
silent misconfiguration TASK-167 set out to eliminate for whitespace, left
open here for percent-containing paths. This is a real, if narrow,
correctness bug for a realistic (if less common) folder-naming pattern.

## Acceptance Criteria
- [ ] Resolve the double-decode risk. Options to consider (pick whichever is
      cleanest given the actual empirical SDK behavior, documenting the
      choice):
      (a) Have `main.js`'s `buildOtelProjectEnv` double-encode on the way out
          (so the SDK's single decode still leaves one layer of encoding for
          `decodeAttrValue` to safely remove) — symmetric with the current
          single-decode-here design.
      (b) Remove the `decodeURIComponent` call from `decodeAttrValue`
          entirely (since the SDK already decodes once, per the empirical
          finding in TASK-153) and rely solely on the SDK's decode — this is
          simpler but only correct if the SDK decode assumption holds for
          every code path/version that could reach this parser.
      (c) Detect whether the value still contains percent-escapes needing
          decode vs. already being a literal path, and only decode if it's
          unambiguous — likely too fragile/heuristic, avoid unless (a)/(b)
          are both ruled out.
- [ ] Whichever approach is chosen, add a test using a project folder name
      containing a literal `%2F`/`%40`/`%3A`-style substring and verify the
      bucket key (post-parse) exactly matches the original folder string,
      with no corruption.
- [ ] Re-verify the whitespace fix from TASK-167 still holds after this
      change (no regression).
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: Project paths containing literal percent-escapes are not double-decoded

  Scenario: A folder name containing a literal %XX substring round-trips correctly
    Given a project folder "C:\\report%2Fv2" (containing a literal percent-escape-
      looking substring, not an actual encoding)
    When it flows through pty:spawn -> OTEL_RESOURCE_ATTRIBUTES -> the real
      Claude Code OTEL SDK -> lib/telemetry.js's parsing
    Then the resulting bucket key exactly equals the original folder string
      "C:\\report%2Fv2", not a corrupted/decoded variant

  Scenario: The toggle key still matches the (correctly parsed) bucket key
    Given setProjectForwarding is called with "C:\\report%2Fv2"
    And a row is ingested tagged with that same literal folder string
    When the forward tick fires
    Then the toggle correctly matches the bucket and forwarding fires
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry.js` — `decodeAttrValue`,
  `resourceProject`.
- `C:\projects\claude-cmd-ui2\main.js` — `buildOtelProjectEnv` (the encode
  side).
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` —
  `setProjectForwarding` (never decodes/trims, for comparison).
- `C:\projects\claude-cmd-ui2\tasks\done\TASK-153-pty-spawn-project-tag.md` —
  the empirical finding about the CLI's OTEL SDK decode behavior, to
  re-verify/re-check against if choosing option (a) or (b).

## Additional Context
_(user-owned — leave blank)_
