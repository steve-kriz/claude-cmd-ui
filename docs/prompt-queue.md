# Prompt queue

## What it does and why

The prompt queue lets you line up prompts for the `claude` pane and have the app
feed them to the agent one at a time, automatically, as the agent finishes each
one. Instead of babysitting the REPL you queue several tasks and let them drain
while you do something else.

## How it works

The queue is a per-tab, in-renderer feature implemented in
[`renderer/renderer.js`](../renderer/renderer.js); it has no dedicated lib module.

- **Queue model** — each tab keeps an ordered list of queued prompt strings.
  Items can be reordered (up/down) or deleted; item #1 is marked "next". A badge
  on the tab and an in-pane counter show the pending count.
- **Auto-dispatch** — dispatch is gated on the terminal's idle detection (see
  [`terminals.md`](terminals.md)). When the pane goes **finished** (idle for
  `IDLE_MS` = 2500 ms after producing output) **and** no TUI menu is detected on
  screen (`isAwaitingTuiSelection`), the next prompt is typed into the REPL,
  logged to prompt history, and `Enter` is sent a moment later. If the agent is
  paused on a confirmation/menu, dispatch waits until you resolve it.
- **Logging** — every dispatched prompt is recorded to prompt history with the
  source tag `queue` (see [`prompt-history.md`](prompt-history.md)).

## Usage

From the UI: open the **Queue** panel, click **+ Queue Prompt**, type a
(multi-line) prompt, and **Add to queue** (`Ctrl+Enter`). Reorder or delete items
as needed; the app dispatches item #1 the next time the agent goes idle.

![The prompt queue panel with several prompts queued to feed the agent one at a time.](../images/queue_up_prompts.jpg)

Related bridge calls that back the feature (dispatch types into the PTY and logs
the prompt):

```js
// what the queue does under the hood when it dispatches an item
window.api.pty.write('tab1-cmd', promptText);         // type into the REPL
await window.api.prompts.append(cwd, { source: 'queue', prompt: promptText });
// Enter is sent a moment later
```

## Configuration

None. Timing is governed by the renderer's `IDLE_MS` (2500 ms) idle window; the
queue itself is not persisted to disk (it lives in renderer memory for the tab's
lifetime).

## Inputs / outputs

- **Input:** prompt strings you add via the Queue editor.
- **Output:** keystrokes written to the tab's `cmd`/`claude` PTY
  (`pty:write`) followed by `Enter`, plus a `queue`-tagged prompt-history entry.
- **Guards:** dispatch only fires on `finished` state with no on-screen TUI
  selection.

## Edge cases, limitations & troubleshooting

- **Nothing dispatches while a menu is up** — if the agent is paused on a
  `Yes/No` or `❯` selection, the queue intentionally waits; resolve the prompt in
  the terminal and dispatch resumes.
- **Queue is not persisted** — closing the tab or app discards unsent queued
  prompts (unlike prompt *history*, which is written to disk).
- **One at a time** — only the next item is dispatched per idle transition; the
  rest wait, so a long-running prompt naturally holds the queue.
