# Ticket archiving — stale-done cards fold into an expander

## What it does and why

The Tasks board's **Done** lane grows without bound: every completed ticket stays
there forever and, over a long-running project, buries the recently-finished work
under weeks of history. Archiving keeps the Done lane readable by folding **stale**
done tickets — those whose last activity is more than five days old — out of the
normal card list and into a single collapsible **"Archived (N)"** expander at the
bottom of the lane. Recently-done tickets stay visible; old ones are one click
away. This was added in TASK-065.

Archiving is **derived, never stored**. There is **no new status** (the enum in
[`lib/ticket-lanes.js`](../lib/ticket-lanes.js) is unchanged) and **no file move or
rewrite**. Whether a ticket is archived is a pure function of its frontmatter
timestamps plus the current time, recomputed on every board render, so a ticket
re-appears in the normal list the moment its `updated` timestamp changes.

## How it works

The decision is split from the effect so the decision half is pure and
unit-testable, mirroring the other `ticket-*.js` board helpers:

- **Pure decision** — [`lib/ticket-archive.js`](../lib/ticket-archive.js) answers
  "given this ticket's frontmatter and the current time, is it archived?" with no
  Electron/OS/disk access. It **never reads the clock itself** — the caller injects
  `now` — so tests can pin a fixed time and the result is fully deterministic.
- **Renderer mirror + expander** — the renderer runs with `nodeIntegration:false`
  and cannot `require()` Node modules, so it keeps a verbatim mirror of the
  constant and predicate (`TASKS_ARCHIVE_AFTER_MS`, `ticketArchiveTimestamp`,
  `ticketIsArchived`) in [`renderer/renderer.js`](../renderer/renderer.js) around
  lines 5543-5576, with a "keep in sync" comment. The board-render code
  (`renderer/renderer.js:5913-5955`) collects done cards for which
  `ticketIsArchived(fm, now)` is true into an `archivedDoneCards` list, still
  counting them in the Done lane total, then builds the expander.

### Flow (per board render)

1. As each ticket card is created, if its lane is `done` **and**
   `ticketIsArchived(tk.fm, now)` is true, the card is pushed onto
   `archivedDoneCards` instead of being appended to the visible Done list; the
   lane `count` is still incremented so the lane header shows the true total
   (`renderer/renderer.js:5913-5922`).
2. After all cards are placed, if `archivedDoneCards` is non-empty, a
   `.tasks-archived` block is appended to the bottom of the Done lane with a
   `.tasks-archived-toggle` button labelled `Archived (N)` and a
   `.tasks-archived-cards` body holding the archived cards
   (`renderer/renderer.js:5924-5955`).
3. The open/closed state lives on `tab.tasks.archiveExpanded` so it survives the
   poll re-render (which wipes lane `innerHTML` each cycle). The toggle flips that
   flag and applies the state synchronously, so the panel opens/closes immediately
   without waiting for the next poll.

No expander is rendered when the archived count is `0` (there is never an empty
`Archived (0)`). Archived cards keep all their normal behaviour — click opens the
ticket modal, and they can still be dragged out of Done; only where the card node
is appended differs.

## Inputs / outputs (API reference)

`lib/ticket-archive.js` exports:

| Export | Signature / value | Description |
|--------|-------------------|-------------|
| `ARCHIVE_AFTER_DAYS` | `5` | How old a done ticket's last activity must be before it archives. |
| `ARCHIVE_AFTER_MS` | `5 * 24 * 60 * 60 * 1000` | The same threshold in milliseconds. |
| `archiveTimestamp(fm)` | `→ number \| null` | Epoch-ms of the ticket's age-driving timestamp: `fm.updated`, falling back to `fm.created`, else `null`. |
| `isArchived(fm, now)` | `→ boolean` | The core predicate (see below). |
| `partitionArchived(entries, now)` | `→ { visible, archived }` | Splits an entry list by `isArchived`, preserving input order. |

### `isArchived(fm, now)`

```js
const { isArchived } = require('./lib/ticket-archive');

// now is epoch ms or a Date, injected by the caller — the module never calls the clock.
isArchived(fm, now); // → true only when the ticket is done AND older than 5 days
```

Returns `true` **only** when **all** of the following hold:

- `fm.status === 'done'` (a `{ fm }`-wrapper or a bare fm object is tolerated —
  the module unwraps either), and
- the injected `now` coerces to a valid epoch-ms, and
- `archiveTimestamp(fm)` resolves to a valid epoch-ms, and
- the age (`now − timestamp`) is **strictly greater than** `ARCHIVE_AFTER_MS`.

The age-driving timestamp is `fm.updated`, falling back to `fm.created` when
`updated` is missing or unparseable. Both epoch-ms, numeric strings, ISO-8601
strings, and `Date` values are accepted and coerced to epoch-ms (never `NaN`).

### `partitionArchived(entries, now)`

```js
const { partitionArchived } = require('./lib/ticket-archive');

const { visible, archived } = partitionArchived(tickets, Date.now());
// visible: cards to render normally; archived: cards to fold into the expander
```

Splits a list of entries (each a `{ fm }`-wrapper **or** a bare fm object) into
`{ visible, archived }` by `isArchived`, preserving the input order and mutating
neither the array nor its entries.

## Configuration / constants

There is **no** environment variable or user setting. The threshold is a code
constant:

```js
const ARCHIVE_AFTER_DAYS = 5;                       // lib/ticket-archive.js
const ARCHIVE_AFTER_MS   = ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
```

The renderer mirror uses the identically-valued `TASKS_ARCHIVE_AFTER_DAYS = 5` /
`TASKS_ARCHIVE_AFTER_MS`. Changing the window means editing **both** the `lib/`
constant and its renderer mirror (they are kept in sync by hand, guarded by the
mirror's "keep in sync" comment and the unit tests).

## Edge cases & limitations

Every failure mode is **fail-safe: show, don't hide** — when anything is
missing, invalid, or ambiguous the ticket is treated as *not* archived and stays
visible:

- **Non-done status** — only `done` tickets are ever archived; any other status is
  `false`.
- **Strict `>` boundary** — a ticket exactly at or under the 5-day threshold is
  **not** archived; the age must be *strictly greater than* `ARCHIVE_AFTER_MS`.
- **Missing/invalid timestamp** — if both `updated` and `created` are missing or
  unparseable, `archiveTimestamp` returns `null` and the ticket is not archived.
- **Missing/invalid `now`** — if the injected `now` does not coerce to a finite
  epoch-ms, the predicate returns `false`.
- **Future timestamp** — a negative age (a timestamp ahead of `now`, e.g. from
  clock skew) yields `false` rather than archiving.
- **No file move, no new status** — archiving is purely a render-time fold; the
  ticket file, its `status: done`, and its `tasks/done/` location are untouched, so
  the ticket returns to the visible list automatically once its `updated` bumps
  back inside the window.
- **`Archived (0)` never renders** — the expander only appears when at least one
  card is archived.

## Tests

```bash
node --test test/ticket-archive.test.js test/ticket-archive.e2e.test.js
```
