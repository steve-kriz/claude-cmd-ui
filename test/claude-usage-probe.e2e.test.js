'use strict';

// ===========================================================================
// e2e "cucumber" scenarios (Given/When/Then) for the weekly usage bar.
// Plain `node --test` cases — NO `cucumber` npm package is installed or added.
//
// Feature: the cmd pane shows how much of the WEEKLY Claude rate limit is gone
// (bar fill) against where a linear burn through the week would put us (the pace
// notch), scraped from Claude Code's `/usage` panel in a short-lived OFF-SCREEN
// `claude` so the user's own pane is never typed into.
//
// Two layers are covered:
//   1. lib/claude-usage-probe.js — the real state machine (boot → type /usage →
//      read the frame → kill) driven against a FAKE pty and a FAKE clock. No real
//      terminal, no `claude` process, no timers left running.
//   2. The wiring — main.js's cache/single-flight handler, preload's bridge, the
//      renderer's paint, and the header markup/CSS — verified by SOURCE-SCAN
//      drift guards plus a faithful in-memory mirror of main's caching handler,
//      wired to the REAL lib/claude-usage maths. main.js/renderer.js are not
//      require()-able (Electron main / browser script), which is the same
//      constraint the repo's other e2e suites work around this way.
// NO Electron, NO DB, NO IPC, NO network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { probeUsage, __testing: PROBE } = require('../lib/claude-usage-probe');
const U = require('../lib/claude-usage');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const rendererSrc = read('renderer/renderer.js');
const htmlSrc = read('renderer/index.html');
const cssSrc = read('renderer/styles.css');

// --- Extract a named function declaration from source by brace-matching. ------
// The parameter list is paren-matched FIRST so the body starts after it. The
// repo's other suites take `indexOf('{', start)` instead, which silently returns
// just `{}` for a function with an object default parameter
// (`probeUsage(opts = {}, deps = {})`) — a guard asserting on such a body would
// then pass or fail on two characters rather than the real code.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in source`);
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  i = src.indexOf('{', i);
  assert.ok(i !== -1, `function ${name} has a body`);
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// Strip comments so a guard asserts on CODE, not on prose that happens to name
// the thing being forbidden (e.g. a comment reading "textContent, never
// innerHTML" must not trip an "innerHTML is absent" guard).
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Real captured `/usage` output (ANSI already stripped by the probe).
const READY = '\x1b[32m❯\x1b[0m Try "fix typecheck errors"';
const SESSION_ROW = 'Current session███6%usedResets 1:59pm (Australia/Sydney)';
const WEEK_ROW = 'Current week (all models)████8%usedResets Aug 1, 4:59pm (Australia/Sydney)';
const FRAME = SESSION_ROW + WEEK_ROW + 'Current week (Fable)0%used';

const NOW = new Date(2026, 6, 31, 9, 42);

// ===========================================================================
// A FAKE pty: records what was written and what happened to it, and lets a
// scenario feed output back on demand. Never a real terminal.
// ===========================================================================
function makeFakePty() {
  const p = {
    writes: [],
    killed: 0,
    dataCb: null,
    exitCb: null,
    onData(cb) { p.dataCb = cb; },
    onExit(cb) { p.exitCb = cb; },
    write(s) { p.writes.push(s); },
    kill() { p.killed += 1; },
    // Test drivers:
    emit(s) { if (p.dataCb) p.dataCb(s); },
    exit() { if (p.exitCb) p.exitCb({ exitCode: 0 }); },
  };
  return p;
}

// Run the REAL probe against a fake pty on a COMPRESSED clock, so the whole state
// machine plays out in milliseconds instead of the ~5s a real probe takes.
// `script(pty)` is called once the probe has registered its listeners.
//
// Delays are SCALED (÷100), not flattened to zero: the probe's own timers are
// ordered relative to each other (type < submit < settle < ready-fallback <
// whole-probe ceiling), and collapsing them all to 0ms fires the ceiling first,
// so every scenario would "time out" with an empty buffer.
const TIME_SCALE = 100;

function runProbe(script, opts = {}) {
  const pty = makeFakePty();
  const spawnCalls = [];
  const deps = {
    spawn: (o) => { spawnCalls.push(o); return pty; },
    now: () => NOW,
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, Math.round((ms || 0) / TIME_SCALE))),
    clearTimeout: (t) => clearTimeout(t),
  };
  const promise = probeUsage({ cwd: 'C:\\proj', ...opts }, deps);
  // Let the probe register onData/onExit before the scenario drives the pty.
  setTimeout(() => script(pty), 0);
  return { promise, pty, spawnCalls };
}

// ===========================================================================
// Scenario: A successful scrape yields the weekly figure and the pace marker
//   Given an off-screen claude that boots and renders the /usage panel
//   When the probe runs
//   Then it types /usage (never into the user's pane), reads the weekly row,
//     reports the percentage and a pace marker, and kills the pty
// ===========================================================================
test('Scenario: a successful /usage scrape reports the weekly figure, the pace marker, and cleans up', async () => {
  const { promise, pty, spawnCalls } = runProbe((p) => {
    p.emit(READY);                       // claude has booted
    setTimeout(() => p.emit(FRAME), 20); // the panel renders after /usage
  });
  const view = await promise;

  // Then the figure and the marker are both there
  assert.equal(view.ok, true, 'the scrape succeeded');
  assert.equal(view.percent, 8, 'the weekly all-models percentage');
  assert.equal(view.label, '8%');
  assert.ok(view.pacePercent > 0 && view.pacePercent < 100, 'a pace marker was derived');
  assert.equal(view.state, 'ok', '8% used against an 81% pace is comfortably ok');
  assert.equal(typeof view.checkedAt, 'string', 'stamped with when it was read');

  // And it asked for /usage exactly once, by typing then submitting
  assert.deepEqual(pty.writes, ['/usage', '\r'], 'typed /usage and pressed Enter, once');

  // And it ran OFF-SCREEN in its own throwaway claude, in the folder it was given
  assert.equal(spawnCalls.length, 1, 'exactly one pty spawned');
  assert.equal(spawnCalls[0].cliCommand, 'claude', 'autolaunches claude via lib/pty');
  assert.equal(spawnCalls[0].cwd, 'C:\\proj', 'in the folder passed in');

  // And the throwaway pty is always killed — a probe must never leak a process
  assert.ok(pty.killed >= 1, 'the off-screen pty was killed');
});

// ===========================================================================
// Scenario: The probe never types into the user's visible pane
// ===========================================================================
test('Scenario: the probe only ever writes to its OWN spawned pty', async () => {
  const { promise, pty, spawnCalls } = runProbe((p) => {
    p.emit(READY);
    setTimeout(() => p.emit(FRAME), 20);
  });
  await promise;
  // Everything written went to the pty the probe itself spawned, and nothing else
  // was spawned. (The renderer never calls pty:write for a probe — drift-guarded
  // below by the absence of any /usage write in renderer.js.)
  assert.equal(spawnCalls.length, 1);
  assert.ok(pty.writes.every((w) => typeof w === 'string'));
  assert.doesNotMatch(rendererSrc, /pty\.write\([^)]*\/usage/, 'the renderer never types /usage into a pane');
});

// ===========================================================================
// Scenario: The panel repaints — the settled paint wins
//   Given the panel first renders a rounded 7% and then a settled 8%
//   Then the probe reports the LAST paint
// ===========================================================================
test('Scenario: a repainting panel reports the settled (last) paint, not the first', async () => {
  const EARLY = 'Current week (all models)███▌7%usedResets Aug1, 5pm (Australia/Sydney)';
  const { promise } = runProbe((p) => {
    p.emit(READY);
    setTimeout(() => p.emit(EARLY), 10);
    setTimeout(() => p.emit(FRAME), 20);
  });
  const view = await promise;
  assert.equal(view.percent, 8, 'the settled figure, not the intermediate 7%');
});

// ===========================================================================
// Scenario: readiness is never detected — the probe types anyway
//   Given a themed/masked shell where the ready marker never appears
//   When the readiness timeout elapses
//   Then /usage is typed regardless (mirroring lib/pty.js's autolaunch fallback)
// ===========================================================================
test('Scenario (fallback): with no readiness marker the probe still asks for /usage', async () => {
  const { promise, pty } = runProbe((p) => {
    // Only noise — no ❯ / "Try " / "for shortcuts" marker ever arrives.
    p.emit('some masked prompt with no marker');
    setTimeout(() => p.emit(FRAME), 30);
  });
  const view = await promise;
  assert.deepEqual(pty.writes, ['/usage', '\r'], 'the readiness fallback still typed /usage');
  assert.equal(view.percent, 8);
});

// ===========================================================================
// Scenario: An untrusted folder is reported, NOT silently confirmed
//   Given claude asks "Is this a project you trust?"
//   Then the probe aborts with folder-untrusted and answers nothing
// ===========================================================================
test('Scenario (security): a folder-trust prompt is reported, never auto-answered', async () => {
  const { promise, pty } = runProbe((p) => {
    p.emit('Quick safety check: Is this a project you created or one you trust?'
      + ' ❯ 1. Yes, I trust this folder  2. No, exit');
  });
  const view = await promise;
  assert.equal(view.ok, false);
  assert.equal(view.reason, 'folder-untrusted', 'the reason is specific, not generic');
  assert.match(view.title, /not trusted/i, 'the tooltip explains the blocker');
  // The critical assertion: the probe did NOT press 1/Enter to grant trust.
  assert.deepEqual(pty.writes, [], 'nothing was written — trust is the user\'s decision');
  assert.ok(pty.killed >= 1, 'and the pty was still cleaned up');
});

// ===========================================================================
// Scenario: claude is missing / dies early
// ===========================================================================
test('Scenario (failure): a missing claude CLI is reported as claude-missing', async () => {
  const { promise } = runProbe((p) => {
    p.emit("'claude' is not recognized as an internal or external command");
    setTimeout(() => p.exit(), 10);
  });
  const view = await promise;
  assert.equal(view.ok, false);
  assert.equal(view.reason, 'claude-missing');
  assert.equal(view.percent, null, 'no fabricated figure');
});

test('Scenario (failure): an early exit with no output resolves rather than hanging', async () => {
  const { promise, pty } = runProbe((p) => p.exit());
  const view = await promise;
  assert.equal(view.ok, false);
  assert.equal(view.reason, 'no-output');
  assert.ok(pty.killed >= 1);
});

test('Scenario (failure): a spawn that throws resolves to a view, never a rejection', async () => {
  const view = await probeUsage({}, {
    spawn: () => { throw new Error('ConPTY unavailable'); },
    now: () => NOW,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (t) => clearTimeout(t),
  });
  assert.equal(view.ok, false, 'a spawn failure is a view, not a throw');
  assert.equal(view.reason, 'no-output');
});

test('Scenario (failure): a pty object missing onData resolves instead of crashing', async () => {
  const view = await probeUsage({}, {
    spawn: () => ({ write() {}, kill() {} }),
    now: () => NOW,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (t) => clearTimeout(t),
  });
  assert.equal(view.ok, false);
});

test('Scenario (edge): the whole-probe timeout resolves with whatever was scraped', async () => {
  // The panel never renders the weekly row; the ceiling fires and reports.
  // The ceiling is set low but still AFTER the scenario's emits (delays are
  // scaled by TIME_SCALE), so the probe times out holding unusable output rather
  // than holding nothing at all.
  const { promise, pty } = runProbe((p) => { p.emit(READY); p.emit('nothing useful here'); },
    { timeoutMs: 400, readyTimeoutMs: 100, typeDelayMs: 0, submitDelayMs: 0 });
  const view = await promise;
  assert.equal(view.ok, false, 'no weekly row → no figure');
  assert.equal(view.reason, 'unparsed');
  assert.ok(pty.killed >= 1, 'the pty is killed on timeout — no leaked claude');
});

test('Scenario (edge): a probe resolves exactly once even as more output arrives', async () => {
  let resolutions = 0;
  const { promise, pty } = runProbe((p) => {
    p.emit(READY);
    setTimeout(() => {
      p.emit(FRAME);
      // Keep pushing output and fire an exit after the probe has settled.
      setTimeout(() => { p.emit(FRAME); p.exit(); }, 40);
    }, 10);
  });
  promise.then(() => { resolutions += 1; });
  const view = await promise;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(view.percent, 8);
  assert.equal(resolutions, 1, 'the promise settled once');
});

// ===========================================================================
// main.js's caching handler — faithful in-memory mirror wired to the REAL maths.
// Proves the three properties the bar depends on: TTL cache, single-flight, and
// pace re-derivation on cached reads.
// ===========================================================================
function makeUsageHandler(opts = {}) {
  const TTL = 5 * 60 * 1000;
  let cache = null;
  let inFlight = null;
  let clock = opts.startAt || NOW.getTime();
  const probes = [];

  const probe = opts.probe || (() => Promise.resolve(U.buildUsageView(FRAME, new Date(clock))));

  // The REAL pace-refresh shape from main.js.
  const refreshPace = (view, nowDate) => {
    if (!view || !view.ok || !view.weekResetsAt) return view;
    const pacePercent = U.weekPacePercent(new Date(view.weekResetsAt), nowDate);
    return { ...view, pacePercent, state: U.usageState(view.percent, pacePercent) };
  };

  async function get(arg) {
    const a = arg || {};
    const now = clock;
    if (!a.force && cache && (now - cache.at) < TTL) {
      return { ok: true, view: refreshPace(cache.view, new Date(clock)), cached: true };
    }
    if (inFlight) {
      const view = await inFlight;
      return { ok: true, view: refreshPace(view, new Date(clock)), cached: true };
    }
    inFlight = Promise.resolve()
      .then(() => { probes.push(clock); return probe(); })
      .then((view) => { if (view && view.ok) cache = { view, at: clock }; return view; })
      .finally(() => { inFlight = null; });
    const view = await inFlight;
    return { ok: true, view, cached: false };
  }

  return { get, probes, advance(ms) { clock += ms; }, get clock() { return clock; } };
}

test('Scenario: the weekly figure is cached — a second read within the TTL costs no probe', async () => {
  const h = makeUsageHandler();
  const a = await h.get({});
  const b = await h.get({});
  assert.equal(a.view.percent, 8);
  assert.equal(b.view.percent, 8);
  assert.equal(h.probes.length, 1, 'one probe served both reads');
  assert.equal(b.cached, true);
});

test('Scenario: many tabs asking at once share ONE probe (single-flight)', async () => {
  // Given a slow probe and eight tabs mounting simultaneously. The deferred is
  // built UP FRONT: the handler only calls probe() a tick later, so capturing the
  // resolver from inside the promise executor would still be undefined here.
  let resolveProbe;
  const pending = new Promise((r) => { resolveProbe = r; });
  const h = makeUsageHandler({ probe: () => pending });
  const all = Promise.all(Array.from({ length: 8 }, () => h.get({})));
  resolveProbe(U.buildUsageView(FRAME, NOW));
  const results = await all;
  // Then exactly one off-screen claude was spawned, and every tab got the figure
  assert.equal(h.probes.length, 1, 'eight simultaneous asks = one probe');
  for (const r of results) assert.equal(r.view.percent, 8);
});

test('Scenario: force bypasses the cache (the bar click re-scrapes)', async () => {
  const h = makeUsageHandler();
  await h.get({});
  await h.get({ force: true });
  assert.equal(h.probes.length, 2, 'a forced read really re-probes');
});

test('Scenario: the TTL expires and the next read re-probes', async () => {
  const h = makeUsageHandler();
  await h.get({});
  h.advance(5 * 60 * 1000 + 1);
  await h.get({});
  assert.equal(h.probes.length, 2);
});

test('Scenario: a CACHED read still advances the pace marker as the week elapses', async () => {
  // This is why the reset instant travels with the view: the percentage is only as
  // fresh as the last probe, but "where we should be at" moves every minute.
  const h = makeUsageHandler();
  const first = await h.get({});
  h.advance(20 * 60 * 60 * 1000);          // 20 hours later, still inside the TTL? no —
  // Re-seed the cache so we read a CACHED entry at the later clock.
  const h2 = makeUsageHandler();
  const a = await h2.get({});
  h2.advance(60 * 60 * 1000);               // one hour later, within the 5-min TTL? no.
  // Use a short hop that stays inside the TTL to prove the marker still moves.
  const h3 = makeUsageHandler();
  const c1 = await h3.get({});
  h3.advance(4 * 60 * 1000);                // 4 minutes: inside the TTL
  const c2 = await h3.get({});
  assert.equal(h3.probes.length, 1, 'served from cache — no new probe');
  assert.equal(c2.cached, true);
  assert.ok(c2.view.pacePercent > c1.view.pacePercent, 'the pace marker advanced without a re-probe');
  assert.equal(c2.view.percent, c1.view.percent, 'the scraped percentage is unchanged');
  assert.ok(first.view.percent === 8 && a.view.percent === 8);
});

test('Scenario: a FAILED probe is not cached — the next read retries', async () => {
  let n = 0;
  const h = makeUsageHandler({
    probe: () => { n += 1; return Promise.resolve(n === 1 ? U.buildUsageView('', NOW) : U.buildUsageView(FRAME, NOW)); },
  });
  const bad = await h.get({});
  assert.equal(bad.view.ok, false, 'first read failed');
  const good = await h.get({});
  assert.equal(good.view.ok, true, 'the failure was not pinned for the whole TTL');
  assert.equal(h.probes.length, 2);
});

// ===========================================================================
// SOURCE-SCAN drift guards — tie the mirrors and the UI wiring to real source.
// ===========================================================================

test('DRIFT GUARD (lib): the probe reuses lib/pty spawnShell and the pure model', () => {
  const src = read('lib/claude-usage-probe.js');
  assert.match(src, /require\('\.\/pty'\)/, 'reuses the tested spawnShell (with its autolaunch)');
  assert.match(src, /require\('\.\/claude-usage'\)/, 'defers all parsing to the pure model');
  assert.match(src, /cliCommand:\s*'claude'/, 'launches claude');
  // The probe must always clean up its pty.
  assert.match(extractFn(src, 'probeUsage'), /proc\.kill\(\)/, 'kills the off-screen pty');
});

test('DRIFT GUARD (main.js): usage:get is registered, cached, single-flighted and pace-refreshed', () => {
  assert.match(mainSrc, /ipcMain\.handle\('usage:get'/, 'the usage:get channel is registered');
  assert.match(mainSrc, /require\('\.\/lib\/claude-usage-probe'\)/, 'main requires the probe');
  assert.match(mainSrc, /require\('\.\/lib\/claude-usage'\)/, 'main requires the pure model');

  const body = extractFn(mainSrc, 'getClaudeUsage');
  assert.match(body, /USAGE_CACHE_TTL_MS/, 'reads are TTL-cached');
  assert.match(body, /usageInFlight/, 'concurrent reads share one in-flight probe');
  assert.match(body, /a\.force/, 'force bypasses the cache');
  assert.match(body, /if \(view && view\.ok\) usageCache/, 'only successful probes are cached');
  assert.match(body, /refreshUsagePace/, 'cached reads re-derive the pace marker');
  assert.match(body, /\.catch\(/, 'a rejected probe never propagates to the renderer');

  // The pace maths is delegated, never re-implemented in main.
  const pace = extractFn(mainSrc, 'refreshUsagePace');
  assert.match(pace, /claudeUsage\.weekPacePercent/, 'delegates the pace maths to lib/claude-usage');
  assert.match(pace, /claudeUsage\.usageState/, 'delegates the state decision too');
  assert.doesNotMatch(pace, /7\s*\*\s*24\s*\*\s*60/, 'main does not hardcode a second week constant');
});

test('DRIFT GUARD (preload.js): usage.get bridges the channel and forwards cwd + force', () => {
  assert.match(
    preloadSrc,
    /usage:\s*\{[\s\S]*get:\s*\(arg\)\s*=>\s*ipcRenderer\.invoke\('usage:get'/,
    'preload exposes usage.get → invoke("usage:get")',
  );
  const region = preloadSrc.slice(preloadSrc.indexOf('usage: {'));
  assert.match(region, /cwd:\s*arg && arg\.cwd/, 'forwards the trusted cwd');
  assert.match(region, /force:\s*!!\(arg && arg\.force\)/, 'forwards force as a real boolean');
});

test('DRIFT GUARD (index.html): the bar sits beside the agent select with fill + pace + label', () => {
  const header = htmlSrc.slice(htmlSrc.indexOf('<select class="agentSelect"'), htmlSrc.indexOf('claudeStatus'));
  assert.match(header, /class="usageBar usage-bar hidden"/, 'the bar follows the agent select and starts hidden');
  assert.match(header, /usageBarFill usage-bar-fill/, 'has the actual-usage fill');
  assert.match(header, /usageBarPace usage-bar-pace/, 'has the pace marker');
  assert.match(header, /usageBarLabel usage-bar-label/, 'has the percentage label');
  assert.match(header, /<button class="usageBar/, 'a button, so it is keyboard-reachable and clickable');
});

test('DRIFT GUARD (styles.css): fill, pace notch and the over-pace state are all styled', () => {
  assert.match(cssSrc, /\.usage-bar-fill\s*\{/, 'the fill rule exists');
  assert.match(cssSrc, /\.usage-bar-pace\s*\{/, 'the pace marker rule exists');
  assert.match(cssSrc, /\.usage-bar\.state-over \.usage-bar-fill/, 'over-pace recolours the fill');
  assert.match(cssSrc, /\.usage-bar\.state-near \.usage-bar-fill/, 'near-pace recolours the fill');
  assert.match(cssSrc, /\.usage-bar\.pace-unknown \.usage-bar-pace\s*\{\s*display:\s*none/, 'an unknown pace hides the marker');
  const label = cssSrc.slice(cssSrc.indexOf('.usage-bar-label {'));
  assert.match(label, /tabular-nums/, 'the figure does not jitter between refreshes');
});

test('DRIFT GUARD (renderer.js): the bar is painted from the view and never from innerHTML', () => {
  const apply = extractFn(rendererSrc, 'applyUsageView');
  assert.match(apply, /usageBarFill\.style\.width = pct \+ '%'/, 'the fill width is the scraped percentage');
  assert.match(apply, /usageBarPace\.style\.left = \(pace == null \? 0 : pace\) \+ '%'/, 'the notch is positioned from the pace');
  assert.match(apply, /textContent = view\.label/, 'the label is set via textContent (scraped text is untrusted)');
  assert.doesNotMatch(codeOnly(apply), /innerHTML/, 'never innerHTML');
  // A failed/absent view hides the bar rather than showing a misleading 0%.
  assert.match(apply, /tab\.agent !== 'claude' \|\| !view \|\| !view\.ok/, 'hidden for openCode and for a failed scrape');
  assert.match(apply, /classList\.add\('hidden'\)/, 'hides rather than showing a zero');
});

test('DRIFT GUARD (renderer.js): the bar refreshes from every site that can change it', () => {
  // Tab activation + the shared poll.
  const activate = extractFn(rendererSrc, 'activateTab');
  assert.match(activate, /refreshUsageBar\(t\)/, 'activating a tab paints its bar');
  assert.match(activate, /startUsagePolling\(\)/, 'and ensures the shared poll runs');
  // A finished run is when usage has just moved.
  const setTabStatus = extractFn(rendererSrc, 'setTabStatus');
  assert.match(setTabStatus, /refreshUsageBar\(tab\)/, 'a finished run refreshes the bar');
  assert.doesNotMatch(setTabStatus, /refreshUsageBar\(tab,\s*\{\s*force:\s*true/, 'and does NOT force a probe per finish');
  // Agent switch shows/hides it; the click forces a real re-scrape.
  assert.match(rendererSrc, /refreshUsageBar\(tab\);\n\s*if \(!tab\.folder\) return;/, 'switching agent repaints the bar');
  assert.match(rendererSrc, /usageBar\.addEventListener\('click', \(\) => refreshUsageBar\(tab, \{ force: true \}\)\)/, 'clicking forces a re-scrape');
  // The poll is idempotent so tab churn cannot stack timers.
  const startPoll = extractFn(rendererSrc, 'startUsagePolling');
  assert.match(startPoll, /if \(usagePollTimer\) return/, 'starting the poll twice is a no-op');
});

test('DRIFT GUARD (renderer.js): the renderer holds no copy of the usage maths', () => {
  // All arithmetic belongs to lib/claude-usage (unit-tested); the renderer binds.
  const apply = extractFn(rendererSrc, 'applyUsageView');
  assert.doesNotMatch(apply, /7\s*\*\s*24\s*\*\s*60/, 'no second week constant in the renderer');
  assert.doesNotMatch(apply, /Resets/, 'the renderer does not parse reset stamps');
});

test('DRIFT GUARD: the probe frame matcher and the pure parser agree on the weekly row', () => {
  // The probe finishes early when FRAME_READY_RE matches; if that ever diverged
  // from what the parser can actually read, the probe would resolve on a frame the
  // model then reports as unparsed.
  assert.match(FRAME, PROBE.FRAME_READY_RE, 'the probe recognises a real frame');
  assert.equal(U.buildUsageView(FRAME, NOW).ok, true, 'and the parser reads that same frame');
  // Neither accepts the session row alone.
  assert.doesNotMatch(SESSION_ROW, PROBE.FRAME_READY_RE);
  assert.equal(U.buildUsageView(SESSION_ROW, NOW).ok, false);
});
