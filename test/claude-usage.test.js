'use strict';

// ===========================================================================
// Unit tests for lib/claude-usage.js — the PURE half of the weekly usage bar:
// scraped `/usage` text in, view state out. No Electron, no pty, no clock of its
// own (every `now` is injected), no I/O.
//
// The fixtures below are REAL captures from a headless `claude` running `/usage`
// (ANSI stripped), including the panel's characteristic collapsed spacing — the
// same text the app's probe hands this module in production.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const U = require('../lib/claude-usage');

// A real settled frame: session row, weekly all-models row, per-model row.
const FRAME_REAL = 'Current session███6%usedResets 1:59pm (Australia/Sydney)'
  + 'Current week (all models)████8%usedResets Aug 1, 4:59pm (Australia/Sydney)'
  + '+50% weekly limits promo through Aug 19 · clau.de/cc-50-promo'
  + 'Current week (Fable)0%used';

// The SAME panel one paint earlier: rounded figures and the collapsed `Aug1,`
// spelling. Both spellings must resolve to the same instant — the collapsed one
// silently dropping its date is what made the pace marker jump 81% → 96%.
const FRAME_EARLIER_PAINT = 'Current session███6%usedResets 1:59pm (Australia/Sydney)'
  + 'Current week (all models)███▌7%usedResets Aug1, 5pm (Australia/Sydney)';

// now = Fri 31 Jul 2026 09:42 local; the weekly window ends Sat 1 Aug 16:59.
const NOW = new Date(2026, 6, 31, 9, 42);

test('parses the weekly percentage, session percentage and reset stamp from a real frame', () => {
  const p = U.parseUsageFrame(FRAME_REAL, NOW);
  assert.equal(p.ok, true);
  assert.equal(p.weekPercent, 8, 'the weekly all-models figure');
  assert.equal(p.sessionPercent, 6, 'the session figure');
  assert.equal(p.weekResetsZone, 'Australia/Sydney');
  assert.equal(p.weekResetsAt.getFullYear(), 2026);
  assert.equal(p.weekResetsAt.getMonth(), 7, 'August');
  assert.equal(p.weekResetsAt.getDate(), 1);
  assert.equal(p.weekResetsAt.getHours(), 16);
  assert.equal(p.weekResetsAt.getMinutes(), 59);
});

test('the weekly row is never confused with the session row or the per-model row', () => {
  // The session row appears FIRST in the frame and a per-model weekly row LAST;
  // both carry their own `N%used`. Neither may be reported as the all-models week.
  const p = U.parseUsageFrame(FRAME_REAL, NOW);
  assert.equal(p.weekPercent, 8, 'not 6 (session) and not 0 (per-model)');
  // The session's own reset (1:59pm, no date) must not become the week's.
  assert.equal(p.weekResetsRaw.includes('Aug'), true, 'the weekly reset keeps its date');
  assert.equal(p.sessionResetsRaw, '1:59pm');
});

// ===========================================================================
// The collapsed-spacing regression: `Aug1,` and `Aug 1,` are the same instant.
// ===========================================================================
test('REGRESSION: a collapsed `Aug1,` date parses identically to `Aug 1,`', () => {
  const spaced = U.parseResetAt('Aug 1, 4:59pm', NOW);
  const collapsed = U.parseResetAt('Aug1, 4:59pm', NOW);
  assert.notEqual(collapsed, null, 'the collapsed spelling still yields a date');
  assert.equal(collapsed.getTime(), spaced.getTime(), 'both spellings are the same instant');
  // And therefore the same pace — the bug was a ~15-point swing between paints.
  assert.equal(
    U.weekPacePercent(collapsed, NOW).toFixed(4),
    U.weekPacePercent(spaced, NOW).toFixed(4),
    'the pace marker does not move with the spelling',
  );
});

test('REGRESSION: two successive paints of the same panel agree on the reset instant', () => {
  const a = U.parseUsageFrame(FRAME_REAL, NOW);
  const b = U.parseUsageFrame(FRAME_EARLIER_PAINT, NOW);
  assert.equal(a.weekResetsAt.getDate(), 1);
  assert.equal(b.weekResetsAt.getDate(), 1, 'the earlier paint resolves to Aug 1, not today');
  // Same day → pace within a minute of each other (17:00 vs 16:59).
  assert.ok(
    Math.abs(U.weekPacePercent(a.weekResetsAt, NOW) - U.weekPacePercent(b.weekResetsAt, NOW)) < 0.2,
    'successive paints do not swing the pace marker',
  );
});

test('a truncated final paint still reports its percentage, with no pace marker', () => {
  // The weekly row rendered but its `Resets …` clause had not painted yet. The
  // percentage is real and must show; the pace is unknown and must NOT be guessed
  // by borrowing a reset from elsewhere in the frame.
  const truncated = 'Current session███6%usedResets 1:59pm (Australia/Sydney)'
    + 'Current week (all models)████9%used';
  const p = U.parseUsageFrame(truncated, NOW);
  assert.equal(p.ok, true);
  assert.equal(p.weekPercent, 9);
  assert.equal(p.weekResetsRaw, '', 'no reset stamp is invented');
  assert.equal(p.weekResetsAt, null);
  assert.equal(p.pacePercent, null, 'no pace marker without a reset instant');
});

test('the settled (last) paint wins when several paints are present', () => {
  const both = FRAME_EARLIER_PAINT + FRAME_REAL;   // 7% paint, then the 8% paint
  assert.equal(U.parseUsageFrame(both, NOW).weekPercent, 8, 'the final paint is authoritative');
});

// ===========================================================================
// parseResetAt
// ===========================================================================
test('parseResetAt handles every stamp shape the panel emits', () => {
  const at = (raw) => U.parseResetAt(raw, NOW);
  assert.equal(at('Aug 1, 4:59pm').getHours(), 16);
  assert.equal(at('Aug 1, 5pm').getHours(), 17, 'minutes are optional');
  assert.equal(at('Aug 1, 5pm').getMinutes(), 0);
  // A weekday prefix and an `at` separator are both tolerated and ignored.
  const wd = at('Tue Aug 5 at 10:00am');
  assert.equal(wd.getMonth(), 7);
  assert.equal(wd.getDate(), 5);
  assert.equal(wd.getHours(), 10);
  // 12-hour edge cases.
  assert.equal(at('Aug 1, 12am').getHours(), 0, '12am is midnight');
  assert.equal(at('Aug 1, 12pm').getHours(), 12, '12pm is noon');
});

test('parseResetAt rolls a bare time (the session row) forward, never backward', () => {
  // now = 09:42. A bare 1:59pm is later today.
  const future = U.parseResetAt('1:59pm', NOW);
  assert.equal(future.getDate(), 31);
  assert.equal(future.getHours(), 13);
  // A bare 8:00am has already passed today, so it means tomorrow — a reset stamp
  // always names an instant still to come.
  const rolled = U.parseResetAt('8:00am', NOW);
  assert.equal(rolled.getDate(), 1, 'rolled into next month');
  assert.equal(rolled.getMonth(), 7);
});

test('parseResetAt infers the year across a December → January rollover', () => {
  const dec30 = new Date(2026, 11, 30, 10, 0);
  const d = U.parseResetAt('Jan 2, 9am', dec30);
  assert.equal(d.getFullYear(), 2027, 'January belongs to next year');
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 2);
});

test('parseResetAt refuses an implausible far-future stamp rather than guessing', () => {
  // A weekly reset is at most 7 days out; anything months away is a misread and
  // null (no marker) is the honest answer.
  assert.equal(U.parseResetAt('Dec 31, 11pm', NOW), null);
});

test('parseResetAt never throws and yields null for junk', () => {
  for (const junk of [null, undefined, '', '   ', 'garbage', 'Resets', 42, {}, [], 'Feb 31, 9am', 'Aug 1, 25pm', 'Aug 1, 0am']) {
    assert.doesNotThrow(() => U.parseResetAt(junk, NOW), `junk ${String(junk)} must not throw`);
    assert.equal(U.parseResetAt(junk, NOW), null, `junk ${String(junk)} yields null`);
  }
  // A junk / missing `now` is equally survivable.
  assert.equal(U.parseResetAt('Aug 1, 4:59pm', null), null);
  assert.equal(U.parseResetAt('Aug 1, 4:59pm', new Date(NaN)), null);
});

// ===========================================================================
// weekPacePercent — "where we should be at"
// ===========================================================================
test('weekPacePercent is the fraction of the 7-day window already elapsed', () => {
  const reset = new Date(2026, 6, 31, 9, 42);          // reset exactly at `now`
  assert.equal(U.weekPacePercent(reset, NOW), 100, 'window ending now is 100% elapsed');

  const weekOut = new Date(NOW.getTime() + U.WEEK_MS);  // a full week remaining
  assert.equal(U.weekPacePercent(weekOut, NOW), 0, 'window ending a week out is 0% elapsed');

  const halfway = new Date(NOW.getTime() + U.WEEK_MS / 2);
  assert.equal(U.weekPacePercent(halfway, NOW), 50, 'half the window left is 50% elapsed');
});

test('weekPacePercent clamps to 0..100 so a skewed stamp cannot leave the bar', () => {
  const wayPast = new Date(NOW.getTime() - 30 * U.WEEK_MS);
  const wayFuture = new Date(NOW.getTime() + 30 * U.WEEK_MS);
  assert.equal(U.weekPacePercent(wayPast, NOW), 100);
  assert.equal(U.weekPacePercent(wayFuture, NOW), 0);
});

test('weekPacePercent never throws and yields null for junk', () => {
  for (const junk of [null, undefined, 'x', 0, NaN, {}, new Date(NaN)]) {
    assert.doesNotThrow(() => U.weekPacePercent(junk, NOW));
    assert.equal(U.weekPacePercent(junk, NOW), null);
    assert.equal(U.weekPacePercent(new Date(), junk), null);
  }
});

// ===========================================================================
// usageState — the colour decision
// ===========================================================================
test('usageState compares actual against pace', () => {
  assert.equal(U.usageState(60, 81.4), 'ok', 'well under pace');
  assert.equal(U.usageState(78, 81.4), 'near', 'within NEAR_POINTS of pace');
  assert.equal(U.usageState(90, 81.4), 'over', 'past pace = burning too fast');
  assert.equal(U.usageState(81.4, 81.4), 'near', 'exactly on pace is not yet over');
});

test('usageState is `ok` when the pace is unknown, and `unknown` without a figure', () => {
  // Nothing to compare against must never read as a warning.
  assert.equal(U.usageState(95, null), 'ok');
  assert.equal(U.usageState(null, 50), 'unknown');
  assert.equal(U.usageState(NaN, 50), 'unknown');
  assert.equal(U.usageState('80', 50), 'unknown', 'a string figure is not a figure');
});

// ===========================================================================
// buildUsageView — what the renderer binds
// ===========================================================================
test('buildUsageView carries the reset instant so a cached view can re-derive its pace', () => {
  const v = U.buildUsageView(FRAME_REAL, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.percent, 8);
  assert.equal(v.label, '8%');
  assert.equal(typeof v.weekResetsAt, 'string', 'ISO string, so it survives IPC/JSON');
  assert.equal(new Date(v.weekResetsAt).getTime(), new Date(2026, 7, 1, 16, 59).getTime());
  // The whole point: pace recomputed later against the same reset advances.
  const later = new Date(NOW.getTime() + 20 * 60 * 60 * 1000);
  const pace2 = U.weekPacePercent(new Date(v.weekResetsAt), later);
  assert.ok(pace2 > v.pacePercent, 'the marker creeps forward as the week elapses');
});

test('buildUsageView reports WHY it has no figure, and never a fabricated zero', () => {
  const cases = {
    '': 'no-output',
    'Quick safety check: Is this a project you created or one you trust?': 'folder-untrusted',
    'Please log in · run /login to renew': 'login-required',
    "'claude' is not recognized as an internal or external command": 'claude-missing',
    'some unrelated terminal noise': 'unparsed',
  };
  for (const [text, reason] of Object.entries(cases)) {
    const v = U.buildUsageView(text, NOW);
    assert.equal(v.ok, false, `${reason}: not ok`);
    assert.equal(v.reason, reason);
    assert.equal(v.percent, null, `${reason}: no fabricated percentage`);
    assert.equal(v.state, 'unknown');
    assert.equal(v.label, '—');
    assert.match(v.title, /unavailable/i, `${reason}: the tooltip explains itself`);
  }
});

test('buildUsageView never throws for any junk input', () => {
  for (const junk of [null, undefined, '', 0, 42, {}, [], () => {}, '%%%', 'used', 'Current week (all models)']) {
    assert.doesNotThrow(() => U.buildUsageView(junk, NOW), `junk ${String(junk)}`);
    const v = U.buildUsageView(junk, NOW);
    assert.equal(v.ok, false);
  }
  // A junk clock degrades to "no pace", not an exception.
  assert.doesNotThrow(() => U.buildUsageView(FRAME_REAL, null));
  assert.doesNotThrow(() => U.buildUsageView(FRAME_REAL, new Date(NaN)));
});

test('a percentage outside 0..100 is rejected rather than clamped into the bar', () => {
  assert.equal(U.buildUsageView('Current week (all models)###999%used', NOW).ok, false);
  assert.equal(U.buildUsageView('Current week (all models)###100%used', NOW).percent, 100);
  assert.equal(U.buildUsageView('Current week (all models)###0%used', NOW).percent, 0);
});

test('a fractional percentage is kept and formatted without trailing noise', () => {
  const v = U.buildUsageView('Current week (all models)###7.5%used', NOW);
  assert.equal(v.percent, 7.5);
  assert.equal(v.label, '7.5%');
  assert.equal(U.formatPercent(7), '7', 'integers stay integers');
  assert.equal(U.formatPercent(7.04), '7', '7.04 → 7 (one decimal, .0 trimmed)');
  assert.equal(U.formatPercent(null), '—');
});

test('the tooltip states actual, pace, the gap and the reset', () => {
  const v = U.buildUsageView(FRAME_REAL, NOW);
  assert.match(v.title, /Weekly limit \(all models\): 8% used/);
  assert.match(v.title, /Pace for this point in the week: 81/);
  assert.match(v.title, /behind pace/, '8% used at 81% pace is behind pace (headroom)');
  assert.match(v.title, /Resets Aug 1, 4:59pm \(Australia\/Sydney\)/);
  assert.match(v.title, /Current session: 6% used/);

  // The over-pace direction reads as AHEAD of pace.
  const over = U.buildUsageView('Current week (all models)###95%usedResets Aug 1, 4:59pm (Australia/Sydney)', NOW);
  assert.equal(over.state, 'over');
  assert.match(over.title, /AHEAD of pace/);
});
