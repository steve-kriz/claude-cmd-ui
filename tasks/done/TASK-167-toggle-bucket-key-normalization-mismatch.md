---
id: TASK-167
title: setProjectForwarding key normalization can silently mismatch bucket keys
status: done
created: 2026-07-26T23:16:54.000Z
updated: 2026-07-27T02:08:53.000Z
agent: swarm-orch1
review-of: TASK-156
---

## Description
Traced the FULL chain: pty:spawn -> OTEL_RESOURCE_ATTRIBUTES ->
lib/telemetry.js parsing -> bucket key -> renderer's setProjectConfig call ->
setProjectForwarding's stored key. Found a GENUINE bug (unlike sibling
verification tickets TASK-162/166): `lib/telemetry.js`'s `decodeAttrValue`
was trimming a value BEFORE percent-decoding, but Claude Code's OTEL SDK
already delivers a DECODED value in the OTLP resource attribute (empirically
confirmed during TASK-153) — so the trim was operating on the literal decoded
string and silently stripping legitimate leading/trailing whitespace from the
project id used as the ingest bucket key. Every other step in the chain does
NOT trim. Fixed `decodeAttrValue` to stop trimming, making the whole chain
consistently non-trimming.

## Acceptance Criteria
- [x] Confirmed the exact same string value flows through the full chain
      (traced every step).
- [x] Applied consistent no-trim normalization throughout.
- [x] Test verifies a project string with incidental whitespace matches
      between ingest and setProjectForwarding paths — VERIFIED by tech-lead
      to genuinely prove the fix via a real OTLP POST through the real
      receiver (the positive assertion is load-bearing; a negative-control
      weakness was found and filed separately as TASK-178).
- [x] All tests green beyond the known pre-existing baseline failures.

## Cucumber Tests
```gherkin
Feature: Consistent project-key normalization across ingest and toggle paths

  Scenario: A project string with incidental whitespace still matches
    Given a row ingested with project " C:\\projects\\alpha " (surrounding
      whitespace, however it may realistically arise)
    And setProjectForwarding is called with the SAME string as produced by
      the renderer's actual call site
    When the forward tick fires
    Then the toggle correctly matches the bucket and forwarding behaves as
      the user configured (not silently defaulting to off)
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry.js` — `decodeAttrValue` fixed to
  stop trimming.
- `C:\projects\claude-cmd-ui2\test\telemetry.test.js` — one test updated.
- `C:\projects\claude-cmd-ui2\test\telemetry-receiver.e2e.test.js` — new e2e
  verification test.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — added a brief accurate
  note explaining why `decodeAttrValue` deliberately doesn't trim.

## Build/Test/Review Notes
- Coder: traced the full 8-step chain, found the genuine trim-before-decode
  bug (unlike TASK-162/166's false alarms), fixed it, added regression tests.
- Tester: confirmed the new e2e test genuinely POSTs a real OTLP payload
  through the real receiver proving the fix (not indirect). Full suite: 3442
  pass, 3 fail (confirmed baseline).
- Tech-lead review: fix confirmed correct for the whitespace case. TWO
  follow-ups filed:
  - TASK-177 (Medium) — a RELATED residual bug: `decodeAttrValue` still
    unconditionally calls `decodeURIComponent`, which can DOUBLE-decode a
    project path containing a literal `%XX`-looking substring (e.g.
    `C:\report%2Fv2`), corrupting the bucket key in a way that reintroduces
    the same silent-mismatch class of bug for a different input shape.
  - TASK-178 — the new e2e test's "negative control" doesn't actually
    exercise anything (no ingest happens in that window, so it can't fail
    for the reason claimed); needs rewriting to be load-bearing.
- Post-processing: independent security pass found no additional issues
  (untrimmed keys only affect Map-key identity, already LRU-capped by
  TASK-163/165; no path/injection surface). docs/telemetry.md updated with a
  brief note explaining the deliberate no-trim design.

## Additional Context
_(user-owned — leave blank)_
