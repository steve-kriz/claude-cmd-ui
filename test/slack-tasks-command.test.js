'use strict';

// TASK-058: the Slack "show me the tasks" command replies in-thread with the
// live tasks board (frontmatter is authoritative).
//
// Two layers (mirroring test/slack-command-wiring.test.js):
//
//   1. renderer/renderer.js source-scans — the browser-side handler is not
//      require()-able, so we assert against its source: SLACK_COMMAND_HANDLERS
//      gains a `tasks` handler that (a) returns "No project folder is open." when
//      !tab.folder, (b) guards on window.api.fs.exists(tasksJoin(tab.folder,
//      'tasks')) reading the { ok, exists } shape, (c) FORCE-polls the board via
//      pollTasksOnce(tab, true), and (d) formats tab.tasks.tickets AFTER the
//      awaited poll via formatTasksSummary. Plus the verbatim formatTasksSummary
//      mirror + its "Mirrors … in lib/slack-commands.js" sync note.
//
//   2. A behavioural harness (a verbatim copy of the handler wired to a fake
//      window.api.fs.exists + fake pollTasksOnce + in-memory ticket Map — no real
//      FS/network) proving the exists-guard, the force-poll, the read-after-poll
//      ordering, and the empty-board degrade-not-throw path. The REAL lib
//      formatTasksSummary backs the harness so it proves the wiring, not a
//      re-implemented formatter.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { formatTasksSummary } = require('../lib/slack-commands');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

// ===========================================================================
// PART 1 — Source-scan guards
// ===========================================================================

test('renderer SLACK_DEFAULT_COMMANDS carries the tasks command with all TASK-058 aliases', () => {
  const idx = rendererSrc.indexOf('const SLACK_DEFAULT_COMMANDS = [');
  assert.ok(idx !== -1, 'SLACK_DEFAULT_COMMANDS present');
  const block = rendererSrc.slice(idx, idx + 500);
  assert.match(block, /name:\s*'tasks'/);
  assert.match(block, /Show the tasks board and what is being worked on/);
  for (const alias of ['show me the tasks', 'show tasks', 'list tasks', 'tasks', 'what are you working on']) {
    assert.ok(block.includes(`'${alias}'`), `alias "${alias}" present`);
  }
});

test('renderer mirrors formatTasksSummary with a sync note reusing the existing lane mirrors', () => {
  // TASK-104: formatTasksSummary gained an optional `columns` param (config-aware
  // summaries), so the mirror's signature is now `(tickets, columns)`.
  const body = fnBody(rendererSrc, 'function formatTasksSummary(tickets, columns)');
  // Empty/null guard + placeholders + sentinel lines are byte-for-byte with lib.
  assert.match(body, /return 'The tasks board is empty\.'/);
  assert.match(body, /\(no id\)/);
  assert.match(body, /\(untitled\)/);
  assert.match(body, /\*Currently working on:\*/);
  assert.match(body, /Nothing is being worked on right now\./);
  assert.match(body, /\*Failed testing:\*/);
  // Reuses the EXISTING renderer lane mirrors — not a third copy of the constants.
  // TASK-122: lane-order derivation moved OUT of the formatTasksSummary body into
  // the tasksLaneStatusesFor helper (the renderer mirror of laneStatusesFor that
  // re-injects the six system lanes), so the formatter now REFERENCES that helper
  // rather than TASKS_LANE_STATUSES directly. Keep the "no third copy of the lane
  // constants" intent by asserting (a) the formatter routes through the helper and
  // (b) the helper — not a fresh inline copy — is what carries TASKS_LANE_STATUSES.
  assert.match(body, /tasksLaneStatusesFor\(/);
  assert.match(body, /TASKS_ACTIVE_STATUSES/);
  assert.match(body, /TASKS_FAILED_STATUS/);
  const laneHelperBody = fnBody(rendererSrc, 'function tasksLaneStatusesFor(columns)');
  assert.match(laneHelperBody, /TASKS_LANE_STATUSES/);
  // TASK-104: the fixed TASKS_UNKNOWN_STATUS sentinel is no longer referenced by
  // the formatter — unknown routing is now a counts-map fallback (`unknown N`
  // appended only when > 0). The config-aware `columns` param drives the lane
  // order/labels (raw slug for system lanes, configured label for user columns).
  assert.match(body, /unknown \$\{unknown\}/);
  assert.match(body, /col\.system === true/);
  // Sync note + adaptation note in the preamble. TASK-122 expanded this preamble
  // (documenting the tasksLaneStatusesFor re-injection), pushing the sync note
  // further above the declaration, so widen the lookback window to keep the guard
  // meaningful rather than accidentally scoped past the note.
  const idx = rendererSrc.indexOf('function formatTasksSummary(tickets, columns)');
  const preamble = rendererSrc.slice(idx - 1400, idx);
  assert.match(preamble, /Mirrors formatTasksSummary in lib\/slack-commands\.js; keep in sync/);
  assert.match(preamble, /ADAPTATION/);
});

test('renderer SLACK_COMMAND_HANDLERS.tasks: folder guard, exists guard, force poll, read-after-poll formatter', () => {
  const idx = rendererSrc.indexOf('tasks: async (tab) =>');
  assert.ok(idx !== -1, 'the tasks handler is wired');
  // TASK-104: the caller now spans multiple lines (it passes a second `columns`
  // arg), and the handler carries extra explanatory comments, so widen the slice.
  const block = rendererSrc.slice(idx, idx + 1100);
  // No-folder guard.
  assert.match(block, /if\s*\(!tab\.folder\)\s*return 'No project folder is open\.'/);
  // Exists guard reads the { ok, exists } shape of window.api.fs.exists.
  assert.match(block, /window\.api\.fs\.exists\(tasksJoin\(tab\.folder,\s*'tasks'\)\)/);
  assert.match(block, /res\.ok\s*&&\s*res\.exists/);
  assert.match(block, /return 'No tasks board found in this project\.'/);
  // Force poll (bypasses the tasks-tab-visible gate) is AWAITED.
  assert.match(block, /await pollTasksOnce\(tab,\s*true\)/);
  // Reads the Map AFTER the awaited poll, feeding the config-aware formatter.
  // TASK-104: the caller passes a SECOND arg — the normalized columns derived
  // from the already-loaded board config (tab.tasks.config), NOT re-read from
  // disk — so user columns appear in the summary in board order.
  assert.match(
    block,
    /return formatTasksSummary\(\s*Array\.from\(tab\.tasks\.tickets\.values\(\)\),\s*normalizeTasksColumns\(tab\.tasks && tab\.tasks\.config\)\)/,
  );
  // The poll must precede the formatter call in source order (read-after-poll).
  const pollIdx = block.indexOf('await pollTasksOnce(tab, true)');
  const fmtIdx = block.indexOf('formatTasksSummary(');
  assert.ok(pollIdx !== -1 && fmtIdx !== -1 && pollIdx < fmtIdx, 'poll before format');
});

// ===========================================================================
// PART 2 — Behavioural harness (verbatim copy of the handler, fake IO)
// ===========================================================================

// A verbatim-ish copy of SLACK_COMMAND_HANDLERS.tasks, kept in lockstep with the
// PART 1 source-scan. The formatter is the REAL lib implementation.
function makeTasksHandler({ folder, existsResult, existsThrows, pollImpl, tickets }) {
  const calls = { existsArgs: null, pollForce: null, pollOrder: [], readAfterPoll: false };
  const tab = {
    folder,
    tasks: { tickets: tickets || new Map() },
  };
  const windowApi = {
    fs: {
      exists: async (p) => {
        calls.existsArgs = p;
        if (existsThrows) throw new Error('exists boom');
        return existsResult;
      },
    },
  };
  const tasksJoin = (...parts) => parts.join('\\');
  const pollTasksOnce = async (t, force) => {
    calls.pollForce = force;
    calls.pollOrder.push('poll');
    if (typeof pollImpl === 'function') await pollImpl(t);
  };

  const handler = async (t) => {
    if (!t.folder) return 'No project folder is open.';
    let exists = false;
    try {
      const res = await windowApi.fs.exists(tasksJoin(t.folder, 'tasks'));
      exists = !!(res && res.ok && res.exists);
    } catch (_) {
      exists = false;
    }
    if (!exists) return 'No tasks board found in this project.';
    await pollTasksOnce(t, true);
    calls.pollOrder.push('format');
    return formatTasksSummary(Array.from(t.tasks.tickets.values()));
  };

  return { handler, tab, calls };
}

test('Scenario: no project folder open → "No project folder is open." and no poll', async () => {
  const h = makeTasksHandler({ folder: null });
  const reply = await h.handler(h.tab);
  assert.equal(reply, 'No project folder is open.');
  assert.equal(h.calls.pollForce, null, 'never polls without a folder');
});

test('Scenario: tasks/ dir absent → "No tasks board found in this project." and no poll', async () => {
  const h = makeTasksHandler({ folder: 'C:\\proj', existsResult: { ok: true, exists: false } });
  const reply = await h.handler(h.tab);
  assert.equal(reply, 'No tasks board found in this project.');
  assert.equal(h.calls.existsArgs, 'C:\\proj\\tasks', 'checked the tasks dir');
  assert.equal(h.calls.pollForce, null, 'no poll when the board is absent');
});

test('Scenario: board present → FORCE polls (true), reads the map AFTER the poll, formats it', async () => {
  const seeded = new Map();
  const h = makeTasksHandler({
    folder: 'C:\\proj',
    existsResult: { ok: true, exists: true },
    tickets: seeded,
    // The force poll is what populates the map — proving read-after-poll.
    pollImpl: (t) => {
      t.tasks.tickets.set('TASK-058.md', { fm: { id: 'TASK-058', title: 'Slack tasks command', status: 'in-progress' } });
    },
  });
  const reply = await h.handler(h.tab);
  assert.equal(h.calls.pollForce, true, 'poll is forced (bypasses the tasks-tab gate)');
  assert.deepEqual(h.calls.pollOrder, ['poll', 'format'], 'map read strictly after the poll');
  assert.ok(reply.includes('TASK-058 — Slack tasks command (in-progress)'));
});

test('Scenario (edge): a failed poll leaves an empty map → "The tasks board is empty." (no throw)', async () => {
  const h = makeTasksHandler({
    folder: 'C:\\proj',
    existsResult: { ok: true, exists: true },
    tickets: new Map(),
    pollImpl: () => {}, // poll "fails" silently, leaving the map empty
  });
  const reply = await h.handler(h.tab);
  assert.equal(reply, 'The tasks board is empty.');
});

test('Scenario (edge): exists() rejecting is treated as absent → "No tasks board found" (no throw)', async () => {
  const h = makeTasksHandler({ folder: 'C:\\proj', existsThrows: true });
  const reply = await h.handler(h.tab);
  assert.equal(reply, 'No tasks board found in this project.');
  assert.equal(h.calls.pollForce, null);
});
