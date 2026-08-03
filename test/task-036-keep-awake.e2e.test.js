'use strict';

// ===========================================================================
// TASK-036 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: Keep the laptop awake while orchestrate tasks run. While >=1 ticket is
// actively worked (defining / in-progress / testing) the app
// holds ONE OS wake-lock via Electron's powerSaveBlocker; when the board goes
// idle the lock is released; the lock is never stacked and never leaked past
// shutdown; and a platform where powerSaveBlocker is unavailable/throwing must
// not crash.
//
// NO DATABASE, DISK, NETWORK, ELECTRON, OR REAL powerSaveBlocker IS TOUCHED.
// - The pure DECISION half is the REAL lib/keep-awake.js (require()'d, executed).
// - main.js's wake-lock MANAGER is Electron-coupled and not requireable in
//   isolation (top-level app.whenReady / ipcMain / real electron require with
//   side effects). Following the repo convention (see
//   test/task-030-plan-button.e2e.test.js and task-028), its start/stop/
//   single-blocker/shutdown-release semantics are exercised behaviourally through
//   a small manager REPLICA driven by an injected FAKE powerSaveBlocker (records
//   start/stop/isStarted calls, hands out fake ids, plus a throwing variant), and
//   a SOURCE-SCAN DRIFT GUARD ties every assertion back to the real main.js
//   wiring so the replica cannot silently diverge from shipped code.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// Execute the REAL pure decision (yes — the manager replica delegates the
// yes/no call to lib/keep-awake, exactly as main.js's updateKeepAwake does).
const { shouldKeepAwake } = require('../lib/keep-awake');

// ---------------------------------------------------------------------------
// FAKE powerSaveBlocker — records every call, hands out incrementing ids, and
// tracks which ids are "started" so isStarted() answers truthfully. No real OS
// power API is touched.
// ---------------------------------------------------------------------------
function makeFakePSB() {
  const calls = { start: [], stop: [], isStarted: [] };
  const started = new Set();
  let nextId = 100;
  return {
    calls,
    startedIds: started,
    start(type) {
      calls.start.push(type);
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) {
      calls.stop.push(id);
      started.delete(id);
    },
    isStarted(id) {
      calls.isStarted.push(id);
      return started.has(id);
    },
  };
}

// A powerSaveBlocker whose start/stop THROW — models a platform where the API is
// present but unavailable. The manager must swallow this and never throw.
function makeThrowingPSB() {
  return {
    start() { throw new Error('powerSaveBlocker unavailable'); },
    stop() { throw new Error('powerSaveBlocker unavailable'); },
    isStarted() { return false; },
  };
}

// A powerSaveBlocker that STARTS fine (holds a real id) but THROWS on stop —
// models the OS API failing mid-release. Used to prove the renderer-gone reset
// (stopKeepAwake, wrapped in try/finally) cannot crash even when stop throws, and
// still clears the stored id so the single-blocker invariant is preserved.
function makeStopThrowingPSB() {
  const started = new Set();
  let nextId = 200;
  return {
    start() { const id = nextId++; started.add(id); return id; },
    stop() { throw new Error('powerSaveBlocker.stop unavailable'); },
    isStarted(id) { return started.has(id); },
  };
}

// ---------------------------------------------------------------------------
// MANAGER REPLICA — mirrors main.js keepAwakeActive/startKeepAwake/
// stopKeepAwake/updateKeepAwake (lines ~177-218). The stored blocker id is the
// single source of truth; start is a no-op while held; stop is a no-op when not
// held; every powerSaveBlocker call is guarded so an unavailable/throwing API
// cannot crash. The yes/no decision delegates to the REAL shouldKeepAwake. This
// replica is DRIFT-GUARDED against main.js in the guards at the bottom.
// ---------------------------------------------------------------------------
function createWakeManager(psb) {
  let blockerId = null;

  function active() {
    try {
      return blockerId !== null && !!psb && psb.isStarted(blockerId);
    } catch (_) {
      return false;
    }
  }
  function start() {
    if (active()) return; // already held — never stack a second blocker
    try {
      if (!psb || typeof psb.start !== 'function') return;
      blockerId = psb.start('prevent-display-sleep');
    } catch (_) {
      blockerId = null;
    }
  }
  function stop() {
    if (blockerId === null) return; // nothing to release
    try {
      if (psb && psb.isStarted(blockerId)) psb.stop(blockerId);
    } catch (_) {
      /* swallow */
    } finally {
      blockerId = null;
    }
  }
  function update(count) {
    if (shouldKeepAwake(count)) start();
    else stop();
  }
  return { update, start, stop, active, get id() { return blockerId; } };
}

// ===========================================================================
// Scenario: Wake-lock engages when a task becomes active (0 -> 1 starts a blocker)
//   AC: while >=1 task is active, a wake-lock is held.
// ===========================================================================
test('Scenario: wake-lock engages when a task becomes active (count 0 -> 1 starts one blocker)', () => {
  // Given no active tasks and no wake-lock held
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);
  mgr.update(0);
  assert.equal(psb.calls.start.length, 0, 'no blocker started while idle');
  assert.equal(mgr.id, null, 'no blocker id held while idle');

  // When the active count rises to 1
  mgr.update(1);

  // Then exactly one blocker is started, with the 'prevent-display-sleep' type
  assert.equal(psb.calls.start.length, 1, 'exactly one blocker started');
  assert.equal(psb.calls.start[0], 'prevent-display-sleep', 'uses prevent-display-sleep');
  assert.notEqual(mgr.id, null, 'a blocker id is now held');
  assert.ok(psb.startedIds.has(mgr.id), 'the held id is actually started');
  assert.equal(mgr.active(), true, 'the wake-lock is held');
});

// ===========================================================================
// Scenario: Wake-lock releases when the board goes idle (count -> 0 stops it)
//   AC: when active count is 0, the wake-lock is released.
// ===========================================================================
test('Scenario: wake-lock releases when the board goes idle (count -> 0 stops the blocker)', () => {
  // Given a wake-lock is held for one active task
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);
  mgr.update(2);
  const heldId = mgr.id;
  assert.equal(mgr.active(), true, 'lock held while work is active');

  // When the board goes idle (count -> 0)
  mgr.update(0);

  // Then the blocker is stopped and no id is retained
  assert.equal(psb.calls.stop.length, 1, 'exactly one stop call');
  assert.equal(psb.calls.stop[0], heldId, 'the held blocker id is the one stopped');
  assert.equal(mgr.id, null, 'no blocker id retained after release');
  assert.equal(mgr.active(), false, 'the wake-lock is released');
  assert.ok(!psb.startedIds.has(heldId), 'the id is no longer started');
});

// ===========================================================================
// Scenario: No double-start (already held + positive count -> no second blocker)
//   AC: only one wake-lock ever held; double-start is a no-op.
// ===========================================================================
test('Scenario: no double-start — a positive count while already held starts no second blocker', () => {
  // Given a wake-lock already held
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);
  mgr.update(1);
  const firstId = mgr.id;
  assert.equal(psb.calls.start.length, 1);

  // When further positive counts are reported (still active)
  mgr.update(3);
  mgr.update(1);
  mgr.update(7);

  // Then no second blocker is ever started; the same single id remains held
  assert.equal(psb.calls.start.length, 1, 'still exactly one start — never stacked');
  assert.equal(mgr.id, firstId, 'the same single blocker id is retained');
  assert.equal(psb.startedIds.size, 1, 'only one blocker is live');
});

// ===========================================================================
// Scenario (edge): stop-when-not-held is a no-op (only one lock ever, no crash)
//   AC: stop-when-not-held is a no-op.
// ===========================================================================
test('Scenario (edge): releasing when nothing is held is a harmless no-op', () => {
  // Given no wake-lock is held
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);

  // When idle is reported repeatedly (and stop() is called directly)
  mgr.update(0);
  mgr.stop();
  mgr.update(0);

  // Then no stop call is ever issued to the OS API and nothing throws
  assert.equal(psb.calls.stop.length, 0, 'stop never called when nothing is held');
  assert.equal(mgr.id, null);
});

// ===========================================================================
// Scenario: No leaked lock on shutdown (held + quit -> stopped)
//   AC: wake-lock released on window-closed / window-all-closed / will-quit.
// ===========================================================================
test('Scenario: no leaked lock on shutdown — a held lock is released on quit', () => {
  // Given a wake-lock held while a build is running
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);
  mgr.update(1);
  const heldId = mgr.id;
  assert.equal(mgr.active(), true);

  // When the app shuts down (main.js calls stopKeepAwake on closed/all-closed/quit)
  mgr.stop();

  // Then the blocker is released — no lock leaks past shutdown
  assert.equal(psb.calls.stop.length, 1, 'the held blocker is stopped on shutdown');
  assert.equal(psb.calls.stop[0], heldId);
  assert.equal(mgr.id, null, 'no blocker id survives shutdown');
  assert.ok(!psb.startedIds.has(heldId), 'no live blocker leaks');
});

// ===========================================================================
// Scenario (failure/edge): powerSaveBlocker.start throws -> updateKeepAwake does
// not throw (unavailable API cannot crash the app).
//   AC: unavailable/throwing powerSaveBlocker does not crash.
// ===========================================================================
test('Scenario (edge): a throwing powerSaveBlocker.start does not crash updateKeepAwake', () => {
  // Given a platform where powerSaveBlocker throws
  const psb = makeThrowingPSB();
  const mgr = createWakeManager(psb);

  // When activity is reported (would call start) and later idle (would call stop)
  assert.doesNotThrow(() => mgr.update(1), 'a throwing start is swallowed');
  assert.equal(mgr.id, null, 'no blocker id retained when start throws');
  assert.equal(mgr.active(), false, 'no lock is held when the API is unavailable');
  assert.doesNotThrow(() => mgr.update(0), 'idle reconcile is also safe');
  assert.doesNotThrow(() => mgr.stop(), 'direct stop is safe when the API throws');
});

// ===========================================================================
// Scenario (failure/edge): shouldKeepAwake(NaN / junk) -> false, so junk activity
// reports never engage the lock. Drives the REAL lib decision through the manager.
// ===========================================================================
test('Scenario (edge): junk/NaN activity reports never engage the wake-lock', () => {
  // Given an idle manager
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);

  // When junk / NaN / negative counts are reported (e.g. a garbled IPC payload)
  for (const junk of [NaN, -1, 'nope', null, undefined, {}, Infinity]) {
    mgr.update(junk);
  }

  // Then the REAL shouldKeepAwake rejects them and no blocker is ever started
  assert.equal(psb.calls.start.length, 0, 'no wake-lock engaged for junk activity');
  assert.equal(mgr.id, null);
  // And the underlying pure decision agrees (real lib executed)
  for (const junk of [NaN, -1, 'nope', null, undefined, {}, Infinity]) {
    assert.equal(shouldKeepAwake(junk), false, `shouldKeepAwake(${String(junk)}) is false`);
  }
});

// ===========================================================================
// Scenario: full lifecycle 0 -> active -> more active -> idle -> active again
// (start, no-op double, stop, restart) — one blocker at a time throughout.
// ===========================================================================
test('Scenario: a full active/idle lifecycle holds exactly one lock at a time', () => {
  // Given a fresh manager
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);

  // When work starts, ramps, goes idle, then starts again
  mgr.update(1);         // start #1
  mgr.update(4);         // no-op (already held)
  const firstId = mgr.id;
  mgr.update(0);         // stop #1
  mgr.update(2);         // start #2 (fresh blocker)
  const secondId = mgr.id;

  // Then two distinct start/stop lifecycles occurred, never more than one live
  assert.equal(psb.calls.start.length, 2, 'two separate blockers over the lifecycle');
  assert.equal(psb.calls.stop.length, 1, 'the first was stopped before the second started');
  assert.notEqual(firstId, secondId, 'the restart uses a fresh blocker id');
  assert.equal(psb.startedIds.size, 1, 'only one blocker is ever live at a time');
  assert.equal(mgr.active(), true, 'the second lock is held at the end');
});

// ===========================================================================
// Scenario (TASK-049): renderer-gone releases the wake-lock, and a later
// positive report from the reloaded renderer re-engages it. In main.js the
// 'render-process-gone'/'unresponsive' handlers call updateKeepAwake(0) — the
// replica models that as mgr.update(0).
// ===========================================================================
test('Scenario: a renderer-gone reset releases a held lock; a later report re-engages it', () => {
  // Given a wake-lock held for active tasks
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);
  mgr.update(1);
  const firstId = mgr.id;
  assert.equal(mgr.active(), true, 'lock held while work is active');

  // When the renderer process is gone (main.js calls updateKeepAwake(0))
  mgr.update(0);

  // Then the blocker is stopped and no id is retained (no stale wake-lock)
  assert.equal(psb.calls.stop.length, 1, 'the held blocker is stopped on renderer-gone');
  assert.equal(psb.calls.stop[0], firstId);
  assert.equal(mgr.id, null, 'no blocker id survives the reset');
  assert.equal(mgr.active(), false, 'the wake-lock is released after renderer-gone');

  // When the reloaded renderer re-reports a positive active count
  mgr.update(2);

  // Then the wake-lock is started again with a fresh blocker
  assert.equal(psb.calls.start.length, 2, 'a fresh blocker starts on re-report');
  assert.notEqual(mgr.id, null, 'a blocker id is held again');
  assert.notEqual(mgr.id, firstId, 'the re-engage uses a fresh blocker id');
  assert.equal(mgr.active(), true, 'the wake-lock is held again after recovery');
});

test('Scenario (edge): a renderer-gone reset while nothing is held is a harmless no-op', () => {
  // Given no wake-lock is held
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);

  // When the renderer is gone with count already 0 (main.js updateKeepAwake(0))
  mgr.update(0);

  // Then nothing is stopped and nothing throws
  assert.equal(psb.calls.stop.length, 0, 'no stop issued when nothing is held');
  assert.equal(mgr.id, null);
});

// ===========================================================================
// Scenario (TASK-049, failure/edge): powerSaveBlocker throws DURING the
// renderer-gone reset. main.js's stopKeepAwake wraps the OS stop in try and
// clears the id in finally, so updateKeepAwake(0) must not crash and must leave
// no stale id behind even when the release itself throws.
// ===========================================================================
test('Scenario (edge): a throwing powerSaveBlocker.stop during a renderer-gone reset does not crash and clears the id', () => {
  // Given a wake-lock is held for active tasks (start succeeded)
  const psb = makeStopThrowingPSB();
  const mgr = createWakeManager(psb);
  mgr.update(1);
  assert.notEqual(mgr.id, null, 'a blocker id is held before the reset');

  // When the renderer process is gone and stop() throws mid-release
  assert.doesNotThrow(() => mgr.update(0), 'renderer-gone reset swallows a throwing stop');

  // Then no stale id survives (finally cleared it) and the manager reports released
  assert.equal(mgr.id, null, 'the stored id is cleared even when stop throws');
  assert.equal(mgr.active(), false, 'no wake-lock is reported held after the reset');

  // And a later positive report can still re-engage a fresh blocker (recovery)
  assert.doesNotThrow(() => mgr.update(3), 're-engage after a throwing reset is safe');
  assert.notEqual(mgr.id, null, 'a fresh blocker is held again after recovery');
});

// ===========================================================================
// Scenario (TASK-049, edge): rapid reload — repeated renderer-gone resets never
// leave a lock leaked and never stack a second blocker on recovery.
// ===========================================================================
test('Scenario (edge): rapid renderer-gone resets keep a single blocker (no leak, no double-start)', () => {
  // Given a wake-lock held
  const psb = makeFakePSB();
  const mgr = createWakeManager(psb);
  mgr.update(2);
  assert.equal(psb.calls.start.length, 1);

  // When the renderer goes gone repeatedly (rapid reload) before re-reporting
  mgr.update(0); // reset #1
  mgr.update(0); // reset #2 (already released -> no-op)
  mgr.update(0); // reset #3 (no-op)

  // Then only one stop was issued and nothing is held
  assert.equal(psb.calls.stop.length, 1, 'only the held blocker is stopped; extra resets are no-ops');
  assert.equal(mgr.id, null, 'no lock leaks across rapid resets');

  // When the reloaded renderer finally re-reports positive counts
  mgr.update(1);
  mgr.update(4);

  // Then exactly one fresh blocker is engaged (never stacked)
  assert.equal(psb.calls.start.length, 2, 'exactly one fresh start on recovery');
  assert.equal(psb.startedIds.size, 1, 'only one blocker live after recovery');
  assert.equal(mgr.active(), true);
});

// ===========================================================================
// DRIFT GUARD (main.js manager): tie the replica's start/stop/single-blocker/
// shutdown-release semantics to the REAL main.js wiring so they cannot diverge.
// ===========================================================================
test('DRIFT GUARD: main.js imports powerSaveBlocker and delegates the decision to lib/keep-awake', () => {
  assert.match(mainSrc, /require\('electron'\)/, 'main.js requires electron');
  assert.match(mainSrc, /powerSaveBlocker/, 'main.js destructures powerSaveBlocker from electron');
  assert.match(mainSrc, /require\(['"][^'"]*keep-awake['"]\)|shouldKeepAwake/,
    'main.js uses the shouldKeepAwake decision from lib/keep-awake');
  assert.match(mainSrc, /shouldKeepAwake\(activeCount\)/, 'updateKeepAwake delegates to shouldKeepAwake');
});

// ---------------------------------------------------------------------------
// The load-bearing keepAwakeActive() body pinned as reusable assertions so the
// same checks drive both the real-source guard and the mutation fail-mode case
// (TASK-050). keepAwakeActive() is what makes the no-double-start guard in
// startKeepAwake correct and lets an isStarted() throw be swallowed instead of
// crashing / falsely reporting "held". We assert the three load-bearing tokens
// (blockerId !== null check, isStarted(keepAwakeBlockerId) call, try/catch
// wrapping) rather than exact offsets, so benign reformatting stays green.
// ---------------------------------------------------------------------------
function assertKeepAwakeActiveWiring(region) {
  // Guards on the stored id first (a constant-return regression drops this).
  assert.match(region, /keepAwakeBlockerId !== null/,
    'keepAwakeActive checks the stored blocker id is not null');
  // Actually asks the OS whether the stored blocker is still started.
  assert.match(region, /powerSaveBlocker\.isStarted\(keepAwakeBlockerId\)/,
    'keepAwakeActive calls powerSaveBlocker.isStarted(keepAwakeBlockerId)');
  // The isStarted() call is wrapped in try/catch so a throw is swallowed and
  // returns false (never crashes, never misleads the no-double-start guard).
  assert.match(region, /try \{/, 'keepAwakeActive wraps the isStarted call in try');
  assert.match(region, /catch[^]*return false;/,
    'keepAwakeActive swallows a throw and returns false');
}

// Slice the keepAwakeActive() region head -> next-function marker, BOUNDED
// (TASK-054). String.indexOf returns -1 when the end marker `function
// startKeepAwake` is missing/renamed; slice(start, -1) would then balloon into
// nearly the rest of main.js, where startKeepAwake/stopKeepAwake repeat the very
// tokens assertKeepAwakeActiveWiring asserts (blockerId !== null,
// isStarted(keepAwakeBlockerId), try/catch) and could false-pass a gutted
// keepAwakeActive. So we assert the end marker is present and follows the head
// BEFORE slicing — a missing marker throws instead of expanding the region.
function sliceKeepAwakeActiveRegion(src) {
  const start = src.indexOf('function keepAwakeActive');
  assert.notEqual(start, -1, 'main.js has a keepAwakeActive function');
  const end = src.indexOf('function startKeepAwake');
  assert.notEqual(end, -1,
    'the keepAwakeActive region end marker (function startKeepAwake) is present ' +
    '— without it the slice would balloon into the rest of main.js');
  assert.ok(end > start, 'the end marker follows the keepAwakeActive head');
  return src.slice(start, end);
}

// ===========================================================================
// Feature: The real keepAwakeActive body is pinned by a drift guard (TASK-050)
//
// Scenario: keepAwakeActive wiring is asserted against real main.js
//   Given the real main.js source
//   Then a drift guard asserts keepAwakeActive checks blockerId !== null and
//        calls isStarted within try/catch.
// ===========================================================================
test('Scenario (TASK-050): keepAwakeActive wiring is asserted against real main.js', () => {
  // Given the real main.js source (read once at the top of this file into mainSrc)
  assert.ok(mainSrc.length > 0, 'the real main.js source is available');

  // When the drift guard slices the real keepAwakeActive() region (head -> bounded end marker)
  const region = sliceKeepAwakeActiveRegion(mainSrc);
  assert.ok(region.length > 0, 'main.js has a keepAwakeActive function');
  assert.ok(region.indexOf('function startKeepAwake') === -1,
    'the bounded region stops before startKeepAwake');

  // Then the region checks blockerId !== null, calls isStarted, and wraps it in try/catch
  assert.doesNotThrow(() => assertKeepAwakeActiveWiring(region),
    'the real keepAwakeActive satisfies the wiring guard');
});

// ===========================================================================
// Scenario: Regression is caught (edge)
//   Given keepAwakeActive is mutated to always return false (or loses its try/catch)
//   Then the drift guard fails.
// ===========================================================================
test('Scenario (TASK-050, edge): a keepAwakeActive that always returns a constant is caught', () => {
  // Given keepAwakeActive is mutated to always return a constant (id check and
  // the isStarted() call are both gone).
  const constantReturn = 'function keepAwakeActive() {\n  return false;\n}\n';

  // When / Then the drift guard fails on the mutant.
  assert.throws(() => assertKeepAwakeActiveWiring(constantReturn),
    'a constant-return keepAwakeActive is rejected by the drift guard');
});

test('Scenario (TASK-050, edge): a keepAwakeActive that loses its try/catch is caught', () => {
  // Given keepAwakeActive is mutated to drop its try/catch — isStarted() is called
  // bare, so a throw would crash / mislead the no-double-start guard.
  const noTryCatch =
    'function keepAwakeActive() {\n' +
    '  return keepAwakeBlockerId !== null\n' +
    '    && !!powerSaveBlocker\n' +
    '    && powerSaveBlocker.isStarted(keepAwakeBlockerId);\n' +
    '}\n';

  // When / Then the drift guard fails on the mutant.
  assert.throws(() => assertKeepAwakeActiveWiring(noTryCatch),
    'a keepAwakeActive without try/catch is rejected by the drift guard');

  // And (not vacuous): the real region still satisfies the same assertions.
  const region = sliceKeepAwakeActiveRegion(mainSrc);
  assert.doesNotThrow(() => assertKeepAwakeActiveWiring(region),
    'the real keepAwakeActive still satisfies the guard');
});

// ===========================================================================
// Scenario (TASK-054): A missing end marker is caught, not silently absorbed
//   Given main.js with `function startKeepAwake` removed/renamed (in-memory)
//   Then the keepAwakeActive drift guard fails rather than slicing the rest of
//        the file (the old slice(start, -1) would balloon into startKeepAwake /
//        stopKeepAwake, which repeat the guarded tokens and could false-pass a
//        gutted keepAwakeActive).
// ===========================================================================
test('Scenario (TASK-054): a missing end marker fails the slice instead of ballooning', () => {
  // Given an in-memory copy of main.js with the end marker renamed away.
  const mutant = mainSrc.replace('function startKeepAwake', 'function startKeepDrowsy');
  assert.ok(mutant.indexOf('function startKeepAwake') === -1,
    'the mutation actually removed the end marker');

  // When/Then the bounded slice FAILS rather than expanding to end-of-file.
  assert.throws(() => sliceKeepAwakeActiveRegion(mutant),
    'a missing end marker is caught, not silently sliced to end-of-file');

  // And (not vacuous): the real source still yields a bounded region the guard accepts.
  const region = sliceKeepAwakeActiveRegion(mainSrc);
  assert.ok(region.indexOf('function startKeepAwake') === -1,
    'the real bounded region stops before startKeepAwake');
  assert.doesNotThrow(() => assertKeepAwakeActiveWiring(region),
    'the real bounded keepAwakeActive region satisfies the wiring guard');
});

test('DRIFT GUARD: startKeepAwake starts a single prevent-display-sleep blocker, guarded by the stored id', () => {
  // Slice the manager region so assertions are local to it.
  const region = mainSrc.slice(mainSrc.indexOf('let keepAwakeBlockerId'), mainSrc.indexOf("ipcMain.on('tasks:activity'"));
  assert.match(region, /let keepAwakeBlockerId = null;/, 'stored blocker id is the single source of truth');
  // Never stack a second blocker: start is a no-op while already active.
  assert.match(region, /function startKeepAwake\(\)\s*\{\s*if \(keepAwakeActive\(\)\) return;/,
    'startKeepAwake returns early when a blocker is already held (no double-start)');
  assert.match(region, /powerSaveBlocker\.start\('prevent-display-sleep'\)/,
    "starts with 'prevent-display-sleep'");
  assert.match(region, /keepAwakeBlockerId = powerSaveBlocker\.start\('prevent-display-sleep'\)/,
    'the started id is stored');
  // The start is inside try/catch (unavailable API cannot crash).
  const startFn = region.slice(region.indexOf('function startKeepAwake'), region.indexOf('function stopKeepAwake'));
  assert.match(startFn, /try \{/, 'startKeepAwake wraps the OS call in try');
  assert.match(startFn, /catch/, 'startKeepAwake has a catch');
  assert.match(startFn, /keepAwakeBlockerId = null;/, 'start resets the id to null on failure');
});

test('DRIFT GUARD: stopKeepAwake is a guarded no-op when nothing is held, and clears the id', () => {
  const region = mainSrc.slice(mainSrc.indexOf('function stopKeepAwake'), mainSrc.indexOf('function updateKeepAwake'));
  assert.match(region, /if \(keepAwakeBlockerId === null\) return;/, 'no-op when nothing is held');
  assert.match(region, /try \{/, 'stop wraps the OS call in try');
  assert.match(region, /powerSaveBlocker\.isStarted\(keepAwakeBlockerId\)/, 'checks isStarted before stopping');
  assert.match(region, /powerSaveBlocker\.stop\(keepAwakeBlockerId\)/, 'stops the held blocker');
  assert.match(region, /finally \{\s*keepAwakeBlockerId = null;/, 'always clears the id in finally');
});

test('DRIFT GUARD: updateKeepAwake starts when active else stops (reconciles to the decision)', () => {
  const region = mainSrc.slice(mainSrc.indexOf('function updateKeepAwake'), mainSrc.indexOf("ipcMain.on('tasks:activity'"));
  assert.match(region, /if \(shouldKeepAwake\(activeCount\)\) startKeepAwake\(\);/, 'starts when the decision is yes');
  assert.match(region, /else stopKeepAwake\(\);/, 'stops when the decision is no');
});

test('DRIFT GUARD: main.js releases the wake-lock on window-closed, window-all-closed, and will-quit', () => {
  // window 'closed' handler releases the lock.
  const closedStart = mainSrc.indexOf("mainWindow.on('closed'");
  const closed = mainSrc.slice(closedStart, mainSrc.indexOf('mainWindow = null;', closedStart) + 20);
  assert.match(closed, /stopKeepAwake\(\);/, "window 'closed' releases the wake-lock");
  // app 'window-all-closed' handler releases the lock.
  const allClosed = mainSrc.slice(mainSrc.indexOf("app.on('window-all-closed'"), mainSrc.indexOf("app.on('window-all-closed'") + 160);
  assert.match(allClosed, /stopKeepAwake\(\);/, "'window-all-closed' releases the wake-lock");
  // app 'will-quit' handler releases the lock.
  assert.match(mainSrc, /app\.on\('will-quit', \(\) => \{ stopKeepAwake\(\); \}\);/, "'will-quit' releases the wake-lock");
});

// Slice a single webContents handler body out of source, bounded by the START
// of the NEXT wc.on(...) registration (or end-of-source if none follows) rather
// than a fixed char window. This keeps each handler's slice from bleeding into
// its neighbour — so an assertion about one handler cannot be satisfied by a
// sibling handler that happens to sit within a fixed +N chars (TASK-053).
// Tolerant of whitespace/reformatting: it keys only off the wc.on( boundaries.
function sliceWcHandler(src, event) {
  const start = src.indexOf(`wc.on('${event}'`);
  if (start === -1) return null;
  // Find the next wc.on( registration after this one; that is the handler boundary.
  const nextBoundary = src.indexOf('wc.on(', start + 1);
  const end = nextBoundary === -1 ? src.length : nextBoundary;
  return src.slice(start, end);
}

test('DRIFT GUARD (TASK-049/TASK-053): render-process-gone and unresponsive independently reset keep-awake to 0', () => {
  // The crashed-renderer handler releases the lock (no stale wake-lock leak).
  // Its slice is bounded by the NEXT handler (unresponsive) so it cannot borrow
  // the unresponsive handler's updateKeepAwake(0).
  const goneHandler = sliceWcHandler(mainSrc, 'render-process-gone');
  assert.ok(goneHandler !== null, "main.js has a 'render-process-gone' handler");
  assert.doesNotThrow(() => assert.match(goneHandler, /updateKeepAwake\(0\);/),
    "'render-process-gone' resets the keep-awake count to 0 (releases the lock)");
  // The hung-renderer handler resets the same way, bounded by its own next handler.
  const unresponsiveHandler = sliceWcHandler(mainSrc, 'unresponsive');
  assert.ok(unresponsiveHandler !== null, "main.js has an 'unresponsive' handler");
  assert.doesNotThrow(() => assert.match(unresponsiveHandler, /updateKeepAwake\(0\);/),
    "'unresponsive' resets the keep-awake count to 0 (releases the lock)");

  // Sanity: the bounded gone slice must NOT already contain the unresponsive
  // registration — otherwise the boundary failed and the guard could bleed.
  assert.doesNotMatch(goneHandler, /wc\.on\('unresponsive'/,
    'the render-process-gone slice is bounded before the unresponsive handler');
});

// ===========================================================================
// Scenario (TASK-053): the gone-handler slice does not bleed into unresponsive.
//   Given main.js with updateKeepAwake(0) removed from ONLY the
//   render-process-gone handler (but still present in unresponsive),
//   Then the render-process-gone drift guard fails.
// (Proves the fixed +200 window's false-pass mode is now closed.)
// ===========================================================================
test('DRIFT GUARD (TASK-053, edge): gone-handler slice does not borrow the unresponsive reset', () => {
  // Given: mutate the real source to drop updateKeepAwake(0) from ONLY the
  // render-process-gone handler, leaving the unresponsive handler untouched.
  const mutated = mainSrc.replace(
    /(wc\.on\('render-process-gone'[^]*?)\n\s*updateKeepAwake\(0\);/,
    '$1');
  // The mutation actually changed something and left unresponsive intact.
  assert.notStrictEqual(mutated, mainSrc,
    'the mutation removed updateKeepAwake(0) from the render-process-gone handler');

  const goneHandler = sliceWcHandler(mutated, 'render-process-gone');
  const unresponsiveHandler = sliceWcHandler(mutated, 'unresponsive');
  // The unresponsive handler still resets (mutation was scoped to gone only)...
  assert.match(unresponsiveHandler, /updateKeepAwake\(0\);/,
    'unresponsive still resets after the scoped mutation');
  // ...yet the bounded gone slice no longer matches: with the old fixed +200
  // window this could have FALSELY PASSED by reaching into unresponsive.
  assert.doesNotMatch(goneHandler, /updateKeepAwake\(0\);/,
    'the gone guard FAILS when its own reset is removed (no bleed into unresponsive)');

  // Not vacuous: the real (unmutated) gone handler still passes the guard.
  assert.match(sliceWcHandler(mainSrc, 'render-process-gone'), /updateKeepAwake\(0\);/,
    'the real render-process-gone handler still resets keep-awake to 0');
});

test('DRIFT GUARD: the tasks:activity IPC tolerates a bare number and an { active } object', () => {
  const region = mainSrc.slice(mainSrc.indexOf("ipcMain.on('tasks:activity'"), mainSrc.indexOf("ipcMain.on('tasks:activity'") + 320);
  assert.match(region, /typeof payload === 'number'/, 'bare number payload accepted');
  assert.match(region, /payload\.active/, '{ active } object payload tolerated');
  assert.match(region, /updateKeepAwake\(count\)/, 'the reconciled count drives updateKeepAwake');
});

// ===========================================================================
// DRIFT GUARD (preload + renderer wiring): the activity signal is plumbed end to
// end — renderer aggregates across ALL tabs and fires reportActivity; preload
// sends it fire-and-forget on 'tasks:activity'.
// ===========================================================================
test('DRIFT GUARD: preload exposes tasks.reportActivity as a fire-and-forget send on tasks:activity', () => {
  assert.match(preloadSrc,
    /reportActivity:\s*\(activeCount\)\s*=>\s*ipcRenderer\.send\('tasks:activity', activeCount\)/,
    'preload.tasks.reportActivity sends (not invokes) on tasks:activity');
});

test('DRIFT GUARD: renderer aggregates keep-awake tickets across all tabs and reports the app-wide count', () => {
  // The renderer's status set mirrors lib/keep-awake KEEP_AWAKE_STATUSES.
  assert.match(rendererSrc,
    /const TASKS_KEEP_AWAKE_STATUSES = \['defining', 'in-progress', 'testing'\];/,
    'renderer keep-awake status set matches the lib');
  const fn = rendererSrc.slice(rendererSrc.indexOf('function reportTasksActivity'),
    rendererSrc.indexOf('function reportTasksActivity') + 500);
  assert.match(fn, /for \(const tb of TABS\.values\(\)\)/, 'aggregates across ALL tabs (app-wide)');
  assert.match(fn, /TASKS_KEEP_AWAKE_STATUSES\.includes\(tk\.fm\.status\)/, 'counts tickets in keep-awake statuses');
  assert.match(fn, /window\.api\.tasks\.reportActivity\(active\)/, 'reports the aggregated count');
  // Called at the end of the board render and in closeTab (so a closed tab drops out).
  assert.ok((rendererSrc.match(/reportTasksActivity\(\);/g) || []).length >= 2,
    'reportTasksActivity is invoked from at least the board render and closeTab');
});
