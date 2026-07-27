---
id: TASK-146
title: Model tie-breaker silently zeroes live cost correlation
status: done
created: 2026-07-26T06:32:29.644Z
updated: 2026-07-26T07:56:55.309Z
review-of: TASK-142
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-26T07:46:09.143Z","finishedAt":"2026-07-26T07:49:15.195Z","durationMs":186052},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-26T07:50:12.540Z","finishedAt":"2026-07-26T07:53:30.604Z","durationMs":198064},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-26T07:54:15.000Z","finishedAt":"2026-07-26T07:55:27.851Z","durationMs":72851},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-26T07:55:40.000Z","finishedAt":"2026-07-26T07:56:06.451Z","durationMs":26451}]
---

## Description

The task modal passes `entry.model` (the orchestrator's short dispatched model label,
e.g. `claude-haiku-4-5`) as `window.model` to `usageForWindow`. `usageForWindow` requires
an exact, trimmed, case-sensitive match when both sides are non-empty
(`lib/telemetry.js`). But OTEL `api_request` rows carry the full dated API model string
(e.g. `claude-haiku-4-5-20251001`). When the persisted activity label and the telemetry
model string differ in format, the tie-breaker excludes **every** row in the window, so
the live correlation shows nothing even though matching data was captured.

Fix so the live modal correlation does not silently degrade to "no numbers" when
telemetry data exists. Two acceptable approaches (pick one, justify in the ticket):
(a) omit `model` from the modal's `usageForWindow` query and rely on the time window
alone (activities rarely overlap in time), or (b) relax the tie-breaker to a
normalized model-family / prefix match (compare on the family before the date suffix).

## Impact If Not Fixed
Users who enable telemetry may see the live cost/cache breakdown stay blank for most
activities even though matching data was captured, making the feature appear broken and
undermining its purpose.

## Acceptance Criteria
- [ ] With telemetry rows present whose model is the full dated string
      (`claude-haiku-4-5-20251001`) and an activity whose persisted model is the short
      label (`claude-haiku-4-5`), the modal live correlation for that activity returns
      the matching rows' usage (non-empty) rather than zero.
- [ ] The chosen approach is implemented without breaking the existing pure
      `usageForWindow` contract and its unit tests: if approach (b), the normalized match
      is added in a way that still treats an empty model on either side as "no filter",
      still excludes genuinely different model families, and never throws on junk; if
      approach (a), the modal simply omits `model` and time-window correctness is
      unaffected.
- [ ] Time-window correctness is preserved: rows outside `[startedAt, finishedAt]` are
      still excluded regardless of model.
- [ ] Unit tests cover the label-vs-dated-string case and a genuinely-different-family
      case (the latter must still be excluded if approach (b) is chosen; if approach (a),
      document that the modal no longer filters by model and rely on the time window).
- [ ] No new npm dependency; `lib/telemetry.js` stays Electron-free and never throws.
- [ ] All tests green under `node --test` beyond the known baseline failures.

## Cucumber Tests
```gherkin
Feature: Live cost correlation matches real telemetry despite model-string format differences

  Scenario: Short label matches full dated telemetry model
    Given an api_request row inside the window with model "claude-haiku-4-5-20251001"
    And an activity whose persisted model is "claude-haiku-4-5"
    When the modal correlates usage for that activity
    Then the row is included and its usage is returned (non-zero)

  Scenario: Time window still bounds the match
    Given a row with a matching model family but a timestamp outside the window
    When correlation runs
    Then the row is excluded

  Scenario (edge): Genuinely different model families
    Given the fix uses a normalized-family match
    And a row whose model family differs from the activity's model
    When correlation runs
    Then the row is excluded
    # (If approach (a) omitting model is chosen instead, document that the modal relies on
    #  the time window alone and this scenario is covered by time bounds.)

  Scenario (edge): Empty model on either side is not a filter
    Given a row with an empty model, or an activity with an empty model
    When correlation runs
    Then the model comparison never excludes the row
```

## Relevant Files & Context
- `lib/telemetry.js` — the `usageForWindow` model-filter branch (exact trimmed match when
  both sides non-empty). If approach (b), add a normalized-family compare here behind the
  same "empty disables filter" rule; keep it pure and never-throwing.
- `renderer/renderer.js` — the modal `.task-modal-cost` block (~9875-9920) that builds the
  `{ startedAt, finishedAt, model }` query from `entry.model`. If approach (a), omit
  `model` here.
- `test/telemetry.test.js` — add unit cases for the label-vs-dated-string match and the
  different-family exclusion.
- Runner is `node --test`; `cucumber` not installed; mock all I/O.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
