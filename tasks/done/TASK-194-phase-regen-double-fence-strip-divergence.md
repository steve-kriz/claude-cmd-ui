---
id: TASK-194
title: TASK-185 review — double code-fence strip causes preview≠saved content divergence
status: done
created: 2026-07-27T18:00:00Z
updated: 2026-07-31T23:13:11.000Z
review-of: TASK-185
---

## Description
The TASK-185 tech-lead review found that `validateRegeneratedPhaseSection`
(`renderer/renderer.js` ~lines 7477-7492) returns `body = stripOneCodeFence(rawText)` (stripped
once), and that stripped body is what the preview shows the user. At Save time,
`wfReplacePhaseBody(fresh, key, proposedBody)` strips a code fence again internally (~line
7439). For an AI response that is still a complete code fence after the first strip (e.g. a
doubly-fenced model reply), the bytes actually written to `SKILL.md` differ from the bytes the
user reviewed and approved in the preview — breaking the "what you preview is what you save"
invariant on the one path allowed to write SKILL.md.

## Acceptance Criteria
- [x] Either: (a) `validateRegeneratedPhaseSection` fully normalizes fence-stripping (loop until
      no surrounding fence remains, or explicitly reject a doubly-fenced response as invalid
      rather than silently under-stripping it for preview), so the previewed body is exactly
      what a subsequent `wfReplacePhaseBody` call would strip to; or (b) `wfReplacePhaseBody`'s
      internal stripping is removed/skipped when called from the Save path (since the body was
      already normalized at preview time), so no second strip ever changes the content between
      preview and save. Pick whichever keeps the two call sites' behavior provably identical and
      document the choice.
- [x] A test proves: for a doubly-fenced AI response, the preview body and the actually-saved
      section body are byte-identical.
- [x] A regression check: reintroducing the double-strip divergence must make the corrected test
      fail (verify locally, then revert).

## Cucumber Tests
```gherkin
Feature: preview content matches saved content exactly
  Scenario: doubly-fenced AI response previews and saves identically
    Given an AI response that is still fully wrapped in a code fence after one strip
    When it is validated for preview and later saved
    Then the previewed body and the saved section body are byte-identical

  Scenario: regression is caught (failure/edge)
    Given the double-strip divergence were reintroduced
    When the corrected test runs
    Then it fails
```

## Edge & Failure Cases
- A response with no fence, or exactly one fence, must be unaffected by whichever fix is chosen.
- Don't change `lib/skill-section.js`'s own `stripOneCodeFence` contract if TASK-185's renderer
  mirror is meant to stay in lockstep with it — prefer fixing at the call-site/validation layer
  described above.

## Relevant Files & Context
- `renderer/renderer.js` — `validateRegeneratedPhaseSection` (~7477-7492), `wfReplacePhaseBody`
  (~7439), `stripOneCodeFence` (~9279).
- `lib/skill-section.js` — the real (non-renderer) `stripOneCodeFence`/`replacePhaseBody`, for
  reference on keeping behavior consistent if choice (a) is taken.

## Impact If Not Fixed
In the rare doubly-fenced-output case the user approves one thing and a slightly different
thing lands on disk; low likelihood and benign in practice, but it is a real preview/write
divergence on the one path allowed to write the orchestrate skill's contract file.

## Build notes
- Coder chose option (a): `validateRegeneratedPhaseSection` now loops `stripOneCodeFence` until stable (fully normalizes), leaving `wfReplacePhaseBody`'s internal strip untouched but reduced to a guaranteed no-op on already-normalized input. Verified via scratch script: no-fence unaffected, single-fence unaffected, double-fence now fully unwraps and is idempotent under a further strip pass.

## Test notes
- Tester added `test/task-194-fence-strip.e2e.test.js` (7 Given/When/Then scenarios covering every Gherkin scenario, including the regression check) and `test/task-194-fence-strip.unit.test.js` (17 unit tests, including a byte-identical preview/save proof). All 24 pass; full suite shows only the known pre-existing baseline failures (unrelated telemetry feature), no new failures.

## Review notes
- Tech-lead review: no critical or high-security findings. Verified the fix holds in the real production save path (not just tests): preview sets `textContent` from the normalized body, Save reads that same text back with no re-normalization in between. Three nit-level observations (test assertions trim before comparing; regression tests recreate old behavior inline rather than mutating the fix; a 10-iteration fence-strip cap is unreachable in practice) — none warrant a follow-up ticket.

## Post-processing notes
- Checked `docs/workflow-settings.md`, `docs/team-tab.md`, `docs/agent-management.md` for claims invalidated by this fix. None made a claim this fix contradicts (workflow-settings.md's existing claim is unaffected/still true; agent-management.md's single-strip description covers a different, untouched feature). No doc changes needed.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
