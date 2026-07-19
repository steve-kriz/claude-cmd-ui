# Keep-awake wake-lock

## What it does and why

While at least one orchestrate ticket is actively being worked, the machine must
not sleep or suspend mid-build. The app holds a single Electron
`powerSaveBlocker` (mode `prevent-display-sleep`) for exactly as long as work is
running, then releases it. This was added in TASK-036.

## How it works

The decision is split from the effect so the decision half is pure and
unit-testable:

- **Pure decision** — [`lib/keep-awake.js`](../lib/keep-awake.js) answers "given
  the current active work, should the wake-lock be held?" with no Electron/OS/
  disk access. `KEEP_AWAKE_STATUSES` is the board's `ACTIVE_STATUSES` (`defining`,
  `in-progress`, `testing`) plus `post-processing`, derived from
  [`lib/ticket-lanes.js`](../lib/ticket-lanes.js) so it never drifts from the
  status enum. `shouldKeepAwake(input)` accepts either a ready-made count
  (number) or a list of tickets and returns `true` when any keep-awake work is
  active.
- **Effect** — [`main.js`](../main.js) holds the actual blocker.
  `startKeepAwake()` / `stopKeepAwake()` guarantee **exactly one** blocker is
  ever held (`startKeepAwake` is a no-op while one is active; `stopKeepAwake` is
  a no-op when none is). `updateKeepAwake(count)` calls `shouldKeepAwake` and
  starts or stops accordingly. Every `powerSaveBlocker` call is wrapped in
  try/catch so a platform without it can never crash the app.
- **Reporting** — the renderer owns the board state, aggregates the app-wide
  active count, and sends it over the fire-and-forget `tasks:activity` channel
  (`api.tasks.reportActivity(count)` in [`preload.js`](../preload.js)). `main.js`
  translates a bare number (or `{ active }`) into `updateKeepAwake`.
- **Release paths** — the lock is released on `window-all-closed`, `will-quit`,
  window `closed`, and (via `updateKeepAwake(0)`) on renderer `render-process-gone`
  or `unresponsive`, so a crashed/hung renderer never leaves a stale lock held.

## Usage

The wake-lock is fully automatic. The pure decision can be exercised directly:

```bash
node -e "const k=require('./lib/keep-awake'); console.log(k.shouldKeepAwake(2), k.shouldKeepAwake(0))"
# -> true false

node -e "const k=require('./lib/keep-awake'); console.log(k.shouldKeepAwake([{status:'in-progress'},{status:'done'}]))"
# -> true  (one active ticket)
```

Run its unit tests:

```bash
node --test test/task-036-keep-awake.test.js test/task-036-keep-awake.e2e.test.js
```

## Configuration

None. The set of statuses that keep the machine awake is code, derived from the
ticket status enum (`lib/ticket-lanes.js`). The blocker mode is
`prevent-display-sleep` (keeps the display on, like moving the mouse), not
`prevent-app-suspension`.

## API reference (`lib/keep-awake.js`)

| Export | Description |
|--------|-------------|
| `KEEP_AWAKE_STATUSES` | `[...ACTIVE_STATUSES, 'post-processing']` |
| `isKeepAwakeStatus(status)` | `true` when a single status keeps the machine awake |
| `keepAwakeCount(tickets)` | count of keep-awake tickets (accepts `{ fm }` wrappers or bare fm; junk → 0) |
| `shouldKeepAwake(input)` | pure yes/no; number > 0 → true, else counts a ticket list; never throws |

`main.js` internals: `startKeepAwake()`, `stopKeepAwake()`,
`keepAwakeActive()`, `updateKeepAwake(count)`.

## Edge cases, limitations & troubleshooting

- **Never stacks blockers** — the stored block id is the single source of truth;
  a second `startKeepAwake` while active is a no-op.
- **Number 0 / empty / null / NaN / junk → not held** (`shouldKeepAwake` returns
  `false`).
- **`prevent-display-sleep`, not app-suspension** — the display stays awake while
  work runs; it is deliberately not the stronger suspension blocker.
- **Battery**: because it is released on crash/hang/close and whenever the active
  count returns to 0, it should not drain the battery outside active builds.
