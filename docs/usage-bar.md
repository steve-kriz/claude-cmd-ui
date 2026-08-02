# Weekly usage bar (are we ahead of our week?)

## What it does and why

The cmd pane header carries a small bar immediately right of the agent
dropdown. It answers one question at a glance: **am I burning my weekly Claude
allowance faster than the week is passing?**

```
cmd · claude ▾  [███████▏······╎·······] 41%
                               ↑ where a linear burn would have us
```

- **The fill** is actual usage — the percentage of your **weekly (all models)**
  rate limit already consumed, exactly as Claude Code's `/usage` panel reports
  it.
- **The notch** is the pace marker: how far *through* the weekly window we are.
  Two thirds of the way through the week, the notch sits at 66%.
- **Fill left of the notch** means headroom. **Fill past the notch** means the
  allowance is going faster than the week — the fill turns amber approaching the
  notch and red past it.

Hovering gives the detail in words (actual, pace, the gap in points, the reset
time, and the current session's percentage). Clicking forces a fresh reading.

This is distinct from [Usage & telemetry](telemetry.md): that feature counts
**tokens and dollars** from OpenTelemetry, while this one reports **rate-limit
headroom**, which is the number that decides whether you can keep working today.

## How it works

### The honest constraint (important)

The weekly percentage exists in exactly one place: Claude Code's interactive
`/usage` panel. It is **not** available any other way —

- the CLI has no non-interactive equivalent (`claude --help` lists no `usage`
  command, and `/usage` is a TUI-only slash command), and
- nothing on disk holds it: `~/.claude/stats-cache.json` has per-day token
  counts but no limits, and `~/.claude/policy-limits.json` holds policy
  restrictions, not quota.

So the app **scrapes it**. That is a deliberate, eyes-open trade-off: the figure
is real and matches what you would see by typing `/usage` yourself, but it
depends on the panel's rendered layout, so every layer below is built to fail
soft and say so rather than show a confident wrong number.

### The probe

[`lib/claude-usage-probe.js`](../lib/claude-usage-probe.js) spawns a
**short-lived, off-screen `claude`**, types `/usage`, reads the frame, and kills
it. Nothing is typed into your visible pane — your scrollback and your session
are untouched, which is the whole reason it uses a throwaway pty of its own.

It reuses [`lib/pty.js`](../lib/pty.js)'s tested `spawnShell` (including its
prompt-detection autolaunch and fixed-delay fallback), then runs a small state
machine: wait for readiness → type `/usage` → submit → wait for the weekly row →
settle briefly for repaints → resolve → kill. A real probe takes ~4–5 seconds.

Every failure path resolves to a view carrying a **reason** rather than throwing:

| Reason | Meaning |
| --- | --- |
| `no-output` | `claude` produced nothing (died early, spawn failed) |
| `folder-untrusted` | the probe folder is not trusted by Claude Code |
| `login-required` | Claude Code needs `/login` |
| `claude-missing` | the `claude` CLI was not found |
| `unparsed` | output arrived but the weekly row could not be read |
| `no-bridge` | (renderer-only) `window.api.usage` isn't available at all |

**`/usage` is a tabbed dialog, and it can open on the wrong tab.** In the
currently-installed Claude Code, `/usage` no longer prints the weekly row
directly — it opens an interactive dialog (observed tabs: Settings / Status /
Config / Session) and the tab it opens *on* is a session cost/duration
summary, not the one carrying the weekly percentage. The probe recognises the
dialog is open (every tab shows an "Esc to cancel/close" hint the plain
composer never does) and, if the weekly row hasn't rendered a beat after
opening, nudges through the other tabs with the same Left arrow a person would
press — bounded (`maxTabCycles`, `tabCycleMs` in `DEFAULTS`) so a plan/version
whose dialog has no such tab at all still falls through to the normal
`unparsed`/timeout path instead of spinning. This is a no-op for a dialog that
happens to open straight on the right tab (or for the older flat-frame
layout): the very first frame already matches and the probe settles before any
nudge would fire.

**A trust prompt is never auto-answered.** If Claude Code asks "is this a project
you trust?", the probe aborts and reports `folder-untrusted`. Confirming trust on
the user's behalf is not this feature's decision to make, so the renderer passes
the tab's own project folder — one Claude Code already trusts.

### The pure model

[`lib/claude-usage.js`](../lib/claude-usage.js) is the Electron-free half: text
in, view state out. It touches no disk, no OS, reads no clock of its own (`now`
is always injected) and **never throws** — junk yields `null`, never a guess.

Once ANSI is stripped, the panel's cursor positioning collapses runs of spaces,
so the parser is whitespace-tolerant rather than column-anchored. A real frame:

```
Current session███6%usedResets 1:59pm (Australia/Sydney)
Current week (all models)████8%usedResets Aug 1, 4:59pm (Australia/Sydney)
Current week (Fable)0%used
```

Two properties of the parser are load-bearing, and both exist because the first
implementation got them wrong and the pace marker visibly jumped between probes
seconds apart:

- **Percent and reset stamp are read as one atomic pair, per paint.** The panel
  repaints several times while it loads, and a truncated final paint can hold a
  weekly percentage whose reset clause has not rendered yet. Taking "last
  percentage anywhere" plus "next `Resets` anywhere after it" walked into the
  *next* paint's `Current session` row and reported the **session** reset as the
  week's. A paint now either carries its own reset or reports none.
- **The month/day separator is optional.** The same reset renders as both
  `Aug 1, 4:59pm` and `Aug1, 4:59pm` across paints. Requiring a space dropped the
  date on the collapsed spelling, fell through to the "bare time = today" branch,
  and read a reset ~6 days early — swinging the marker from 81% to 96%.

The pace marker itself is simple arithmetic on the reset instant: the weekly
window **ends** at the reset and began 7 days earlier, so
`pace = (WEEK − timeToReset) / WEEK`, clamped to 0–100. No reset instant → no
marker (the notch is hidden), never a marker at a guessed position.

### Caching

A probe costs seconds and a process, so `main.js` never runs one on demand
twice:

- **one app-global entry** — the limit is per account, so every tab and window
  shares the same figure,
- **single-flight** — eight tabs mounting at once await the *same* in-flight
  probe rather than spawning eight `claude` processes,
- **5-minute TTL**, and **failures are not cached** so the next read retries.

A **cached read still re-derives the pace marker** against the current clock,
which is why the reset instant travels with the view: the percentage is only as
fresh as the last probe, but "where we should be" advances every minute.

### When it refreshes

- when a tab is activated (cached — normally no probe),
- when a run **finishes** — the moment quota has just moved. Deliberately *not*
  forced, so a burst of finishes costs at most one real probe per TTL,
- every 5 minutes on a shared, idempotent poll,
- immediately on **click**, which forces a real re-scrape past the cache.

The bar is fully **hidden** only for **openCode** panes (it is a Claude rate
limit, meaningless there). Whenever a `claude` pane's reading is
*unavailable* — probe failed, not logged in, folder untrusted, no bridge, or
just not read yet — the bar stays **visible** as a muted/greyed affordance
(`.usage-bar.is-unavailable`) with the fill and label reset to their empty
state, rather than either a blank empty track or vanishing outright; the
reason is in the `title` tooltip. A reading that fails after a previous
success never keeps showing the old number as current — the reset happens on
every repaint, success or not.

## Usage

Fully automatic. The pure model can be exercised directly:

```bash
node -e "const u=require('./lib/claude-usage'); console.log(u.buildUsageView('Current week (all models)####8%usedResets Aug 1, 4:59pm (Australia/Sydney)', new Date()))"
```

And a real probe (spawns a throwaway `claude`, ~5s):

```bash
node -e "require('./lib/claude-usage-probe').probeUsage({cwd:process.cwd()}).then(v=>console.log(v))"
```

Run the tests:

```bash
node --test test/claude-usage.test.js test/claude-usage-probe.e2e.test.js
```

## Configuration

None. The 7-day window, the 5-minute cache TTL and the amber/red thresholds
(`NEAR_POINTS`, 5 points) are code.

## Edge cases, limitations & troubleshooting

- **Scraping is best-effort.** If Claude Code restyles the `/usage` panel (or
  moves the weekly row to a dialog tab the probe's bounded tab-cycling never
  reaches) the parse can stop matching; the bar then goes to the muted
  `is-unavailable` state and the tooltip says `the /usage panel could not be
  read`. It cannot show a wrong number, because an unreadable frame yields
  `null`, never a default.
- **The bar looks greyed out / unavailable.** Hover it for the reason, then
  check in order: the pane is a `claude` pane (not openCode); the folder is
  trusted by Claude Code; you are logged in; `claude` is on `PATH`.
- **The bar is fully missing (not just greyed out).** That only happens for an
  openCode pane — it is a Claude rate limit and has nothing to show there.
- **Up to 5 minutes stale.** Click the bar to force a fresh scrape.
- **Weekly all-models only.** `/usage` also reports a session limit and a
  per-model (e.g. Opus) weekly limit. The session figure is in the tooltip; the
  per-model one is not shown — the all-models limit is the one the single bar
  tracks.
- **Each probe is a real `claude` launch.** It consumes no API tokens (the panel
  is local UI over your account's limit state) but it does start and stop a
  process, which is exactly why reads are cached and coalesced.
- **The percentage is Anthropic's, the pace is ours.** `/usage` supplies actual
  usage and the reset instant; the linear pace marker is the app's own
  interpretation of "where we should be at" and assumes an even burn across the
  week.

## Code map

- [`lib/claude-usage.js`](../lib/claude-usage.js) — pure, unit-tested model:
  `parseUsageFrame`, `parseResetAt`, `weekPacePercent`, `usageState`,
  `buildUsageView`, `usageTitleFor`. No Electron, no I/O, never throws.
- [`lib/claude-usage-probe.js`](../lib/claude-usage-probe.js) — the effect half:
  drives the off-screen `claude` pty via `lib/pty.js#spawnShell` and hands the
  scraped text to the pure model. Fully dependency-injected (`spawn`, `now`,
  `setTimeout`) so the state machine is tested against a fake pty.
- `main.js` — `getClaudeUsage` (TTL cache + single-flight + `refreshUsagePace`)
  behind the `usage:get` IPC channel.
- `preload.js` — `window.api.usage.get({ cwd, force })`.
- `renderer/renderer.js` — `applyUsageView` / `refreshUsageBar` /
  `refreshAllUsageBars` / `startUsagePolling`, called from `activateTab`,
  `setTabStatus`'s finished branch, the agent select, and the bar's click.
- `renderer/index.html`, `renderer/styles.css` — the `.usage-bar` markup
  (track + fill + pace notch + label) and its states.
