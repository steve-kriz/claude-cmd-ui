# Attention when waiting for input

## What it does and why

When Claude pauses and needs you, the app draws attention at two levels so a
backgrounded window is never silently blocked. This was added in TASK-078.

- **In-app tab pulse** — the waiting terminal tab's status dot pulses
  (`.ws-tab.status-waiting .ws-tab-dot` in
  [`renderer/styles.css`](../renderer/styles.css)), so it stays visible even on
  the active tab. Busy / idle / finished dots do not pulse.
- **OS taskbar flash** — while the window is **not** focused, the Windows taskbar
  button flashes (macOS dock bounce) via Electron `BrowserWindow.flashFrame`. It
  clears the moment the window gains focus or no attention condition remains.

An attention condition holds when any of these is true:

- a tab is `waiting` (Claude paused on a TUI confirmation / selection menu),
- a tab is `finished` (idle, awaiting the next prompt), or
- a board ticket is waiting for an answer (`isTicketWaitingForAnswer`).

## How it works

The decision is split from the effect so the decision half is pure and
unit-testable — the same pattern as [keep-awake](keep-awake.md):

- **Pure decision** — [`lib/window-attention.js`](../lib/window-attention.js)
  exposes `shouldRequestAttention({ attentionCount, windowFocused })`, which
  requires no Electron/OS access. It returns `true` only when `attentionCount` is
  a finite number `> 0` **and** `windowFocused === false`; any junk input
  (null, NaN, negative, non-object, unknown focus) yields `false` and it never
  throws. The in-app pulse is pure CSS and out of scope for this module.
- **Effect** — [`main.js`](../main.js) applies the verdict.
  `setWindowAttention(next)` calls `mainWindow.flashFrame(next)` guarded in
  try/catch (a destroyed window or unsupported platform can't crash the app) and
  deduped via a single `windowAttentionOn` flag, so repeated identical reports
  (e.g. a pty data tick while already waiting) never spam the OS.
- **Reporting** — the renderer owns tab/board state and aggregates the app-wide
  count in `reportWindowAttention()`
  ([`renderer/renderer.js`](../renderer/renderer.js)): it sums `waiting`/`finished`
  tabs plus board tickets satisfying `isTicketWaitingForAnswer`, across **all**
  tabs, and sends the bare number over the fire-and-forget `window:attention`
  channel (`api.attention.report(count)` in [`preload.js`](../preload.js)). It is
  called on every status transition, on each board render, on tab close, and on
  window `focus`/`blur`. `main.js` reads the live `mainWindow.isFocused()` state
  and combines it with the reported count through `shouldRequestAttention`.
- **Clear paths** — the flash is cleared when the window gains `focus` (a `main.js`
  `focus` handler calls `setWindowAttention(false)` directly, belt-and-braces
  alongside the renderer re-report) and on renderer `render-process-gone`, so a
  crashed renderer can't leave the taskbar stuck flashing.

## Usage

Fully automatic. The pure decision can be exercised directly:

```bash
node -e "const a=require('./lib/window-attention'); console.log(a.shouldRequestAttention({attentionCount:1,windowFocused:false}), a.shouldRequestAttention({attentionCount:1,windowFocused:true}))"
# -> true false
```

Run its unit tests:

```bash
node --test test/window-attention.test.js test/window-attention.e2e.test.js
```

## Configuration

None. The attention conditions and the flash-only-while-unfocused rule are code.

## Edge cases, limitations & troubleshooting

- **Flashes only while unfocused** — a focused window never flashes; the in-app
  dot pulse shows regardless of focus.
- **Never spams the OS** — `windowAttentionOn` dedupes, so only real on/off
  transitions reach `flashFrame`.
- **Junk / zero count → no flash** — `shouldRequestAttention` returns `false` for
  a zero/absent/NaN/negative count or an unknown focus state.
- **Crash-safe** — a renderer crash clears any active flash; a `flashFrame` call
  on a destroyed window is swallowed.
