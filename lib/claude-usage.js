'use strict';

// Claude weekly-usage model (the usage bar beside the cmd pane's agent select).
// Claude Code's `/usage` panel is the ONLY source that knows how much of your
// weekly rate limit you have burned — the percentages are not persisted anywhere
// on disk (`~/.claude/stats-cache.json` holds token counts, not limits) and the
// CLI has no non-interactive `usage` command. So the app scrapes the rendered
// `/usage` frame out of a short-lived off-screen `claude` pty
// (lib/claude-usage-probe.js drives that) and this module is the PURE,
// Electron-free half: text in, view state out.
//
// Like lib/keep-awake.js and lib/window-attention.js it requires nothing from
// Electron, touches no disk and no OS, and NEVER throws — every function is
// tolerant of missing/garbled input and answers `null` rather than guessing,
// because a scraped TUI is inherently best-effort and a wrong number on a quota
// bar is worse than a visibly absent one.
//
// The frame we parse looks like this once ANSI escapes are stripped (real
// capture; the TUI's cursor positioning means runs of spaces are frequently
// collapsed, so every pattern here is whitespace-tolerant rather than
// column-anchored):
//
//   Current session███6%usedResets 1:59pm (Australia/Sydney)
//   Current week (all models)████8%usedResets Aug 1, 4:59pm (Australia/Sydney)
//   Current week (Fable)0%used

// The weekly rate-limit window is 7 days, which is what makes a "where we should
// be" pace marker meaningful: the reset instant scraped from the frame is the END
// of the current window, so the window STARTED 7 days before it.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Bar glyphs and padding can sit between a section label and its percentage, so
// the label→percent patterns below hop over a bounded run of anything. Bounded
// (not `[\s\S]*?`) so a missing percentage can never match the NEXT section's
// number and silently report the wrong figure.
const GAP = '[\\s\\S]{0,80}?';

const WEEK_LABEL = 'Current\\s*week\\s*\\(\\s*all\\s*models\\s*\\)';
const SESSION_LABEL = 'Current\\s*session';

// A percentage as `/usage` writes it: an integer (optionally fractional) followed
// by `%` and the word `used`, with any/no whitespace between.
const PCT = '(\\d{1,3}(?:\\.\\d+)?)\\s*%\\s*used';

// `Resets <when> (<zone>)` — the zone is parenthesised and optional because only
// the timestamp drives the pace marker. Anchored to the START of the tail: in a
// real paint the clause follows its own percentage IMMEDIATELY ("…8%usedResets
// Aug 1, 4:59pm"), so only a tiny amount of collapsed padding is allowed before
// it. That tight anchor is load-bearing — see readSections below.
const RESETS_RE = /^[\s·|]{0,12}Resets\s*([^()\n\r]{1,40}?)\s*(?:\(([^)\n\r]{1,60})\))?(?=[A-Z+·\n\r]|$)/;

// Every occurrence of one labelled section in the frame, newest last, each as an
// ATOMIC { percent, resetRaw, resetZone } triple.
//
// Reading the percentage and the reset stamp as a pair — rather than "last
// percentage anywhere" plus "next Resets anywhere after it" — is what makes the
// pace marker stable. The `/usage` panel repaints several times while it loads,
// and a truncated final paint can hold a weekly percentage whose own reset clause
// has not rendered yet. A loose lookahead then walks past it into the NEXT
// paint's `Current session` row and silently reports the SESSION reset as the
// week's, which moves the pace marker by tens of points between two probes
// seconds apart. Pairing per paint, plus RESETS_RE's start-anchor, makes that
// impossible: a paint either carries its own reset or reports none.
function readSections(text, label) {
  if (typeof text !== 'string' || !text) return [];
  const re = new RegExp(label + GAP + PCT, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const pct = Number(m[1]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const r = RESETS_RE.exec(tail);
    const raw = r ? String(r[1] || '').trim() : '';
    out.push({ percent: pct, resetRaw: raw, resetZone: r && raw ? (r[2] || '').trim() : '' });
  }
  return out;
}

// The settled reading for one section: the LAST paint that carried a reset stamp,
// falling back to the last paint of any kind (percentage only, pace unknown) so a
// truncated final paint still shows the real percentage rather than nothing.
function readSection(text, label) {
  const all = readSections(text, label);
  if (!all.length) return null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].resetRaw) return all[i];
  }
  return all[all.length - 1];
}

// Percent for one labelled section. Returns a finite 0..100 number or null.
function percentFor(text, label) {
  const sec = readSection(text, label);
  return sec ? sec.percent : null;
}

// The `Resets …` clause belonging to one labelled section's own paint.
function resetsFor(text, label) {
  const sec = readSection(text, label);
  if (!sec || !sec.resetRaw) return null;
  return { raw: sec.resetRaw, zone: sec.resetZone };
}

// First `<month><day>` pair in a reset stamp whose month name is real, as
// `{ month: 0-11, day: 1-31 }` — or null when the stamp carries no date at all
// (the session row's bare `1:59pm`). Tolerates the panel's collapsed spacing
// (`Aug1` as well as `Aug 1`) and a trailing abbreviation dot.
function firstMonthDay(s) {
  const re = /\b([A-Za-z]{3,9})\.?\s*(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month == null) continue;              // not a month name — keep scanning
    const day = Number(m[2]);
    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
    return { month, day };
  }
  return null;
}

// Parse a `/usage` reset stamp into an absolute Date, relative to `now`.
// Handles the two shapes the panel emits: a weekly `Aug 1, 4:59pm` (month + day
// + time) and a session-scoped bare `1:59pm` (today). The frame prints times in
// the machine's own timezone (the parenthesised zone is the local one), so a
// local-time Date is the correct reconstruction.
//
// Returns null for anything unparseable — never a guessed or partial date.
function parseResetAt(raw, now) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const base = now instanceof Date && Number.isFinite(now.getTime()) ? now : null;
  if (!base) return null;

  const s = raw.trim().replace(/\s+at\s+/i, ' ');
  const time = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(s);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = time[2] == null ? 0 : Number(time[2]);
  if (!Number.isFinite(hour) || hour < 1 || hour > 12) return null;
  if (!Number.isFinite(minute) || minute > 59) return null;
  const pm = time[3].toLowerCase() === 'p';
  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;

  // Optional `<Mon> <day>` date part (weekday names are ignored — the month/day
  // pair is unambiguous and a weekday adds nothing).
  //
  // The separator is `\s*`, NOT `\s+`: the panel's cursor positioning collapses
  // runs of spaces, so the SAME reset renders as both `Aug 1, 4:59pm` and
  // `Aug1, 4:59pm` across successive paints. Requiring a space silently dropped
  // the date on the collapsed variant, fell through to the bare-time branch
  // below, and read a reset ~6 days early — which swung the pace marker from
  // 81% to 96% between two probes seconds apart.
  //
  // Candidates are scanned in order and the first one naming a REAL month wins,
  // so incidental letter+digit noise ("at 5", "v2") cannot be mistaken for a date.
  const date = firstMonthDay(s);
  if (!date) {
    // Bare time → today at that time, rolled forward a day if already past. A
    // reset stamp always names an instant still to come.
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
    if (d.getTime() < base.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  const { month, day } = date;

  const d = new Date(base.getFullYear(), month, day, hour, minute, 0, 0);
  if (d.getMonth() !== month || d.getDate() !== day) return null;   // e.g. Feb 31
  // Year inference across a December→January rollover. The stamp carries no year,
  // so it is first built in the CURRENT year; when that lands far in the past the
  // panel must mean next year (`Jan 2` seen on Dec 30).
  if (d.getTime() < base.getTime() - WEEK_MS) d.setFullYear(d.getFullYear() + 1);
  // A weekly reset is by definition at most 7 days out. Anything still implausibly
  // far away is a misread, and null (no pace marker) is the honest answer — a
  // fabricated date would park the marker at a confidently wrong spot.
  if (d.getTime() > base.getTime() + 2 * WEEK_MS) return null;
  return d;
}

// How far THROUGH the current weekly window we are, as a 0..100 percentage —
// the "where we should be at" marker. Derived from the reset instant: the window
// ends there and began WEEK_MS earlier, so elapsed = WEEK_MS - timeToReset.
// Clamped to 0..100 so a stale or skewed reset stamp can't park the marker off
// the end of the bar. Returns null when the reset instant is unknown.
function weekPacePercent(resetAt, now) {
  if (!(resetAt instanceof Date) || !Number.isFinite(resetAt.getTime())) return null;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  const remaining = resetAt.getTime() - now.getTime();
  const elapsed = WEEK_MS - remaining;
  const pct = (elapsed / WEEK_MS) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

// Reasons the panel can yield no usable figure. Reported so the UI can say WHY
// the bar is blank instead of silently showing nothing.
function unavailableReason(text) {
  if (typeof text !== 'string' || !text.trim()) return 'no-output';
  if (/Is\s*this\s*a\s*project\s*you\s*(?:created|trust)/i.test(text)) return 'folder-untrusted';
  if (/run\s*\/login|Please\s*log\s*in|not\s*logged\s*in/i.test(text)) return 'login-required';
  if (/command\s*not\s*found|is\s*not\s*recognized/i.test(text)) return 'claude-missing';
  return 'unparsed';
}

// Parse a captured `/usage` frame into the numbers the bar needs.
// Always returns an object; `ok` is false with a `reason` when the weekly
// percentage — the one figure the bar cannot do without — is absent.
function parseUsageFrame(text, now) {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date(0);
  // One atomic read per section, so a percentage and the reset stamp beside it
  // always come from the same paint of the panel.
  const week = readSection(text, WEEK_LABEL);
  if (!week) {
    return { ok: false, reason: unavailableReason(text), weekPercent: null };
  }
  const session = readSection(text, SESSION_LABEL);
  const weekResetsAt = week.resetRaw ? parseResetAt(week.resetRaw, at) : null;
  return {
    ok: true,
    reason: '',
    weekPercent: week.percent,
    weekResetsRaw: week.resetRaw,
    weekResetsZone: week.resetZone,
    weekResetsAt,
    pacePercent: weekPacePercent(weekResetsAt, at),
    sessionPercent: session ? session.percent : null,
    sessionResetsRaw: session ? session.resetRaw : '',
  };
}

// How the bar should read: `over` once actual usage has passed the pace marker
// (burning the week's allowance faster than the week is elapsing), `near` within
// a few points of it, `ok` below. A null pace (unknown reset) has nothing to
// compare against, so it is always `ok` — the bar still shows the real figure.
const NEAR_POINTS = 5;

function usageState(percent, pacePercent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'unknown';
  if (typeof pacePercent !== 'number' || !Number.isFinite(pacePercent)) return 'ok';
  if (percent > pacePercent) return 'over';
  if (percent >= pacePercent - NEAR_POINTS) return 'near';
  return 'ok';
}

// The full view model the renderer binds to. Pure: same inputs → same output,
// no clock read of its own (`now` is always injected) so it is deterministic
// under test.
function buildUsageView(text, now) {
  const parsed = parseUsageFrame(text, now);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, percent: null, pacePercent: null, state: 'unknown', label: '—', title: usageTitleFor(parsed) };
  }
  return {
    ok: true,
    reason: '',
    percent: parsed.weekPercent,
    pacePercent: parsed.pacePercent,
    state: usageState(parsed.weekPercent, parsed.pacePercent),
    label: `${formatPercent(parsed.weekPercent)}%`,
    title: usageTitleFor(parsed),
    // The reset instant travels WITH the view (as an ISO string, so it survives
    // IPC structured-clone and JSON alike) because a cached view has to be able
    // to re-derive its pace marker later: the percentage is only as fresh as the
    // probe, but "where we should be in the week" advances every minute.
    weekResetsAt: parsed.weekResetsAt ? parsed.weekResetsAt.toISOString() : '',
    weekResetsRaw: parsed.weekResetsRaw,
    weekResetsZone: parsed.weekResetsZone,
    sessionPercent: parsed.sessionPercent,
  };
}

// Trim a percentage for display: integers stay integers, fractions keep one
// decimal (`7` not `7.0`, `7.5` not `7.500000001`).
function formatPercent(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace(/\.0$/, '');
}

// Hover text. Spells out actual vs pace and the reset stamp, so the single bar
// carries the detail without a second row of chrome.
function usageTitleFor(parsed) {
  if (!parsed || !parsed.ok) {
    const why = {
      'no-output': 'Claude produced no /usage output',
      'folder-untrusted': 'the probe folder is not trusted by Claude Code',
      'login-required': 'Claude Code needs you to log in',
      'claude-missing': 'the claude CLI was not found',
      unparsed: 'the /usage panel could not be read',
    }[(parsed && parsed.reason) || 'unparsed'] || 'the /usage panel could not be read';
    return `Weekly usage unavailable — ${why}.`;
  }
  const lines = [`Weekly limit (all models): ${formatPercent(parsed.weekPercent)}% used`];
  if (parsed.pacePercent != null) {
    lines.push(`Pace for this point in the week: ${formatPercent(parsed.pacePercent)}%`);
    const delta = parsed.weekPercent - parsed.pacePercent;
    lines.push(delta > 0
      ? `Running ${formatPercent(Math.abs(delta))} points AHEAD of pace`
      : `Running ${formatPercent(Math.abs(delta))} points behind pace`);
  }
  if (parsed.weekResetsRaw) {
    lines.push(`Resets ${parsed.weekResetsRaw}${parsed.weekResetsZone ? ` (${parsed.weekResetsZone})` : ''}`);
  }
  if (parsed.sessionPercent != null) lines.push(`Current session: ${formatPercent(parsed.sessionPercent)}% used`);
  return lines.join('\n');
}

module.exports = {
  parseUsageFrame,
  parseResetAt,
  weekPacePercent,
  usageState,
  buildUsageView,
  formatPercent,
  usageTitleFor,
  unavailableReason,
  WEEK_MS,
  NEAR_POINTS,
  __testing: { percentFor, resetsFor, readSection, readSections, WEEK_LABEL, SESSION_LABEL },
};
