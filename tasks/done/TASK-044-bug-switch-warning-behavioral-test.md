---
id: TASK-044
title: add executable coverage for the bug-switch warning listener lifecycle and DOM write
status: done
created: 2026-07-19T01:46:37Z
updated: 2026-07-19T02:33:00Z
---

## Description
Follow-up from the TASK-042 tech-lead review (minor — test coverage). TASK-042's riskiest behavior — the persistent `change`-listener on `.newtask-bug-of` not accumulating across modal re-opens (`_bugSwitchWarnHandler` attach/detach/dispose, renderer/renderer.js ~6796-6807) — and the security-relevant `bugWarnEl.textContent` warning write (~6529, NOT innerHTML) are currently verified ONLY by regex SOURCE-SCAN drift guards. The TASK-042 tests drive an in-memory replica state machine, so the real `updateBugSwitchWarning`, listener lifecycle, and DOM write have no executable assertion. A future edit to `innerHTML`, or a listener leak, would pass all green tests as long as the regex shapes still match. This is consistent with the repo's documented "renderer.js not requireable" convention, so it is a coverage gap, not a defect.

## Acceptance Criteria
- [ ] Add a test that EXECUTES (not just source-scans) the switch-warning listener lifecycle and DOM write, via EITHER:
  - (a) a jsdom-backed test (only if a jsdom dev-dependency is acceptable to the maintainer — do NOT add heavyweight deps without confirmation; prefer option (b) otherwise), OR
  - (b) extracting the pure logic (`updateBugSwitchWarning` decision + the listener attach/detach/dispose bookkeeping) into a requireable helper and unit-testing it against a minimal fake element, so the real logic (not a replica) runs. If extraction touches production code, keep the renderer behavior identical and follow the established mirror/extract patterns (e.g. lib/modal-actions.js bindActionOnce).
- [ ] The test asserts: across simulated modal re-opens, at most ONE live `change` listener exists on the select (no accumulation) and it is removed on cleanup.
- [ ] The test asserts the warning is written via `textContent` (or otherwise cannot inject markup): feeding an id containing `<script>` produces NO child element nodes / no HTML injection.
- [ ] The test asserts the warning fires only when a committed fold exists for a DIFFERENT original than currently selected, and never blocks Create.
- [ ] No production/runtime dependency added; any new dependency is dev-only and confirmed acceptable, otherwise use option (b).
- [ ] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The bug-switch warning is executable-tested, not just source-scanned

  Scenario: Listener does not accumulate across re-opens
    Given the bug-create modal is opened and closed several times
    Then at most one change listener is attached to the original-select at any time
    And the listener is removed on cleanup

  Scenario: The warning cannot inject markup (security edge)
    Given a committed fold whose id contains "<script>alert(1)</script>"
    When the warning line is written
    Then it is inserted as text (no child element nodes / no executable markup)

  Scenario: Warning fires only on a cross-target mismatch
    Given a committed fold for original "A"
    When the selected original is "B"
    Then the warning is shown
    And Create is not blocked
```

## Relevant Files and Context
- `renderer/renderer.js` — `updateBugSwitchWarning` (~6518-6535), the persistent change-listener wiring/dispose (~6796-6807), `bugWarnEl.textContent` write (~6529). Not requireable as-is.
- `lib/modal-actions.js` — `bindActionOnce` extraction pattern (the established way pure listener logic is factored out + mirrored).
- Tests: `test/task-042-bug-multitarget-switch.{test,e2e}.test.js` — the current replica + source-scan guards to complement with executable coverage.
- Repo convention: renderer behavior verified by source-scan (see test/task-034-routing-drift-guard.test.js) — option (b) should extend that with a real executable assertion.

## Edge and Failure Cases
- Many re-opens / repeated bug-mode toggles → no listener accumulation.
- Id containing HTML/script → written as inert text.
- Empty committed set or only-same-original → no warning.
- Cleanup removes the listener (no dangling handler after close).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)

## Orchestration Notes
- Build extracted the logic into `lib/bug-switch-warning.js` (canonical, Electron-free) with a byte-for-byte MIRROR in `renderer/renderer.js` (~6461-6502) tied by a source-scan drift guard (established lib/modal-actions.js convention, since renderer can't require). Rewired updateBugSwitchWarning + the persistent-listener block to call the mirror; reconciled the stale task-042 source-scan guard to the new attachBugSwitchWarning wiring.
- Test: both kinds green — `test/task-044-bug-switch-warning.test.js` (unit, executes the REAL lib) + `test/task-044-bug-switch-warning.e2e.test.js` (drift + mutation guards that flip to fail on innerHTML swap / dropped detach / inverted filter in BOTH files). Full suite 1063/1063 (quiescent gate).
- Tech-lead review: CLEAN, no follow-ups. Verified behavior-preserving (key-equality iff original-equality because `id` is session-constant; foldKeyOriginal injective even with spaces; stale list + order identical), mirror executed at runtime, at-most-one live change listener with dispose on cleanup, textContent-only (no injection).
- Post-processing (TASK-035 security review): satisfied via the tech-lead security dimension (no innerHTML sink, task-042 guard reconciliation did not weaken security).
