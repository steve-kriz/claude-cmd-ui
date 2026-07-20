'use strict';

// TASK-060: the Slack "status" command replies in-thread with a one-shot session
// snapshot — open project folder, whether Claude is busy/idle, how many Slack
// messages are queued, the live transport (Socket Mode vs polling), and how many
// tickets are actively being worked.
//
// Three layers (mirroring test/slack-tasks-command.test.js):
//
//   1. Pure-core unit tests against the REAL lib formatStatusReply for every
//      field variant (incl. a missing/partial/non-object info) + phrase matching
//      through the full pipeline (incl. "what's your status" and "are you busy",
//      and the exact-phrase negative "are you busy with the build").
//
//   2. renderer/renderer.js source-scans — the browser-side handler is not
//      require()-able, so we assert against its source: the verbatim
//      formatStatusReply mirror + sync note, and SLACK_COMMAND_HANDLERS.status
//      gathering each field, force-polling the board, wrapping the read in
//      try/catch and passing null on failure / no folder.
//
//   3. A behavioural harness (a verbatim copy of the handler wired to a fake
//      pollTasksOnce + in-memory ticket Map — no real FS/network) proving the
//      force-poll, the active-ticket counting, and the null-on-failure /
//      null-without-folder paths. The REAL lib formatStatusReply backs the
//      harness so it proves the wiring, not a re-implemented formatter.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_COMMANDS,
  matchCommand,
  listCommands,
  formatStatusReply,
} = require('../lib/slack-commands');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');

// The renderer mirrors are kept BYTE-IDENTICAL modulo each file's own
// line-ending convention (lib = LF, renderer = CRLF). The active set of
// TASKS_ACTIVE_STATUSES the handler counts against.
const TASKS_ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];

// ===========================================================================
// PART 1 — formatStatusReply (pure core, REAL lib implementation)
// ===========================================================================

test('formatStatusReply: full info renders every field with the expected substrings', () => {
  const out = formatStatusReply({
    folder: 'C:\\proj',
    claudeState: 'busy',
    transport: 'socket',
    queued: 3,
    activeTickets: 2,
  });
  assert.ok(out.includes('C:\\proj'), 'folder shown');
  assert.ok(out.includes('Claude: busy'), 'busy state');
  assert.ok(out.includes('Socket Mode'), 'socket transport label');
  assert.ok(out.includes('Queued: 3'), 'queue count');
  assert.ok(out.includes('Active tickets: 2'), 'active ticket count');
});

test('formatStatusReply: falsy folder → "(no folder open)"', () => {
  assert.ok(formatStatusReply({ folder: null }).includes('(no folder open)'));
  assert.ok(formatStatusReply({ folder: '' }).includes('(no folder open)'));
  assert.ok(formatStatusReply({}).includes('(no folder open)'));
});

test('formatStatusReply: Claude state — "busy" only when exactly "busy", else "idle"', () => {
  assert.ok(formatStatusReply({ claudeState: 'busy' }).includes('Claude: busy'));
  assert.ok(formatStatusReply({ claudeState: 'idle' }).includes('Claude: idle'));
  assert.ok(formatStatusReply({ claudeState: 'finished' }).includes('Claude: idle'));
  assert.ok(formatStatusReply({}).includes('Claude: idle'));
});

test('formatStatusReply: transport — socket→"Socket Mode", poll→"polling", else "none"', () => {
  assert.ok(formatStatusReply({ transport: 'socket' }).includes('Socket Mode'));
  assert.ok(formatStatusReply({ transport: 'poll' }).includes('polling'));
  assert.ok(formatStatusReply({ transport: null }).includes('none'));
  assert.ok(formatStatusReply({ transport: 'bogus' }).includes('none'));
  assert.ok(formatStatusReply({}).includes('none'));
});

test('formatStatusReply: queued defaults to 0 when not a finite number', () => {
  assert.ok(formatStatusReply({ queued: 5 }).includes('Queued: 5'));
  assert.ok(formatStatusReply({}).includes('Queued: 0'));
  assert.ok(formatStatusReply({ queued: null }).includes('Queued: 0'));
  assert.ok(formatStatusReply({ queued: NaN }).includes('Queued: 0'));
});

test('formatStatusReply: activeTickets null/undefined → "Active tickets: unknown"', () => {
  assert.ok(formatStatusReply({ activeTickets: 0 }).includes('Active tickets: 0'));
  assert.ok(formatStatusReply({ activeTickets: 7 }).includes('Active tickets: 7'));
  assert.ok(formatStatusReply({ activeTickets: null }).includes('Active tickets: unknown'));
  assert.ok(formatStatusReply({ activeTickets: undefined }).includes('Active tickets: unknown'));
  assert.ok(formatStatusReply({}).includes('Active tickets: unknown'));
});

test('formatStatusReply: missing/partial/non-object info never throws', () => {
  assert.doesNotThrow(() => formatStatusReply(undefined));
  assert.doesNotThrow(() => formatStatusReply(null));
  assert.doesNotThrow(() => formatStatusReply('nope'));
  assert.doesNotThrow(() => formatStatusReply(42));
  // A wholly missing info still produces the full placeholder snapshot.
  const out = formatStatusReply();
  assert.ok(out.includes('(no folder open)'));
  assert.ok(out.includes('Claude: idle'));
  assert.ok(out.includes('none'));
  assert.ok(out.includes('Queued: 0'));
  assert.ok(out.includes('Active tickets: unknown'));
});

// ===========================================================================
// PART 2 — phrase matching through the full pipeline
// ===========================================================================

test('DEFAULT_COMMANDS: carries the status command with all TASK-060 patterns', () => {
  const status = DEFAULT_COMMANDS.find((c) => c.name === 'status');
  assert.ok(status, 'a "status" entry exists');
  assert.equal(status.description, 'Show session status: folder, Claude activity, queue and active tickets');
  assert.deepEqual(status.patterns, ['status', 'show status', "what's your status", 'are you busy']);
});

test('matchCommand: every status alias resolves to the status command', () => {
  for (const p of ['status', 'show status', "what's your status", 'are you busy']) {
    assert.equal(matchCommand(p).name, 'status', `alias "${p}" matches`);
  }
});

test('matchCommand: "what\'s your status" matches (apostrophe preserved — only TRAILING punctuation is stripped)', () => {
  assert.equal(matchCommand("what's your status").name, 'status');
  assert.equal(matchCommand("What's your status?").name, 'status');
});

test('matchCommand: "are you busy" matches but "are you busy with the build" does NOT (exact-phrase)', () => {
  assert.equal(matchCommand('are you busy').name, 'status');
  assert.equal(matchCommand('are you busy with the build'), null);
});

test('listCommands defaults now surface tasks, help AND status in registry order', () => {
  assert.deepEqual(listCommands(), [
    { name: 'tasks', description: 'Show the tasks board and what is being worked on' },
    { name: 'help', description: 'List the commands this thread understands' },
    { name: 'status', description: 'Show session status: folder, Claude activity, queue and active tickets' },
    { name: 'create-ticket', description: 'Create a new ticket on the tasks board' },
  ]);
});

// ===========================================================================
// PART 3 — renderer source-scan guards
// ===========================================================================

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

test('renderer SLACK_DEFAULT_COMMANDS carries the status command with all TASK-060 patterns', () => {
  const idx = rendererSrc.indexOf('const SLACK_DEFAULT_COMMANDS = [');
  assert.ok(idx !== -1, 'SLACK_DEFAULT_COMMANDS present');
  const block = rendererSrc.slice(idx, idx + 900);
  assert.match(block, /name:\s*'status'/);
  assert.match(block, /Show session status: folder, Claude activity, queue and active tickets/);
  for (const alias of ['status', 'show status', "what's your status", 'are you busy']) {
    assert.ok(block.includes(`'${alias}'`) || block.includes(`"${alias}"`), `alias "${alias}" present`);
  }
});

test('renderer mirrors formatStatusReply VERBATIM (byte-identical to lib) with a sync note', () => {
  const rndBody = fnBody(rendererSrc, 'function formatStatusReply(info)');
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'slack-commands.js'), 'utf8').replace(/\r\n/g, '\n');
  const libBody = fnBody(libSrc, 'function formatStatusReply(info)');
  assert.equal(rndBody, libBody, 'renderer formatStatusReply is byte-identical to lib (LF-normalized)');
  const idx = rendererSrc.indexOf('function formatStatusReply(info)');
  const preamble = rendererSrc.slice(idx - 800, idx);
  assert.match(preamble, /Mirrors formatStatusReply in lib\/slack-commands\.js; keep in sync/);
});

test('renderer SLACK_COMMAND_HANDLERS.status: gathers info, force polls, try/catch, null on failure/no folder', () => {
  const idx = rendererSrc.indexOf('status: async (tab) =>');
  assert.ok(idx !== -1, 'the status handler is wired');
  const block = rendererSrc.slice(idx, idx + 900);
  // Default null active count, only overwritten when a folder is open.
  assert.match(block, /let activeTickets = null/);
  assert.match(block, /if\s*\(tab\.folder\)/);
  // Force poll (bypasses the tasks-tab gate) is AWAITED, inside a try.
  assert.match(block, /try\s*\{/);
  assert.match(block, /await pollTasksOnce\(tab,\s*true\)/);
  // Active-ticket counting against the existing renderer active-status mirror.
  assert.match(block, /TASKS_ACTIVE_STATUSES\.includes\(tk\.fm\.status\)/);
  // Board read failure → null.
  assert.match(block, /catch\s*\(_\)\s*\{\s*activeTickets = null;/);
  // Info gathering: each field from live state.
  assert.match(block, /folder:\s*tab\.folder/);
  assert.match(block, /claudeState:\s*tab\.status/);
  assert.match(block, /transport:\s*tab\.slack\.transport/);
  assert.match(block, /queued:\s*\(tab\.slack\.inbox \|\| \[\]\)\.length/);
  assert.match(block, /activeTickets,/);
  assert.match(block, /return formatStatusReply\(info\)/);
  // Force poll must precede the info gathering / formatter call.
  const pollIdx = block.indexOf('await pollTasksOnce(tab, true)');
  const fmtIdx = block.indexOf('return formatStatusReply(info)');
  assert.ok(pollIdx !== -1 && fmtIdx !== -1 && pollIdx < fmtIdx, 'poll before format');
});

// ===========================================================================
// PART 4 — behavioural harness (verbatim copy of the handler, fake IO)
// ===========================================================================

// A verbatim-ish copy of SLACK_COMMAND_HANDLERS.status, kept in lockstep with
// the PART 3 source-scan. The formatter is the REAL lib implementation.
function makeStatusHandler({ folder, status, transport, inbox, tickets, pollImpl, pollThrows }) {
  const calls = { pollForce: null };
  const tab = {
    folder,
    status,
    slack: { transport, inbox },
    tasks: { tickets: tickets || new Map() },
  };
  const pollTasksOnce = async (t, force) => {
    calls.pollForce = force;
    if (pollThrows) throw new Error('poll boom');
    if (typeof pollImpl === 'function') await pollImpl(t);
  };

  const handler = async (t) => {
    let activeTickets = null;
    if (t.folder) {
      try {
        await pollTasksOnce(t, true);
        activeTickets = 0;
        for (const tk of t.tasks.tickets.values()) {
          if (tk && tk.fm && TASKS_ACTIVE_STATUSES.includes(tk.fm.status)) activeTickets += 1;
        }
      } catch (_) {
        activeTickets = null;
      }
    }
    const info = {
      folder: t.folder,
      claudeState: t.status,
      transport: t.slack.transport,
      queued: (t.slack.inbox || []).length,
      activeTickets,
    };
    return formatStatusReply(info);
  };

  return { handler, tab, calls };
}

test('Scenario: folder open, Claude busy, socket, queue of 2, 2 active tickets', async () => {
  const tickets = new Map([
    ['a.md', { fm: { status: 'in-progress' } }],
    ['b.md', { fm: { status: 'testing' } }],
    ['c.md', { fm: { status: 'done' } }],
    ['d.md', { fm: { status: 'todo' } }],
  ]);
  const h = makeStatusHandler({
    folder: 'C:\\proj', status: 'busy', transport: 'socket',
    inbox: [{ text: 'a' }, { text: 'b' }], tickets,
  });
  const reply = await h.handler(h.tab);
  assert.equal(h.calls.pollForce, true, 'force-polled the board');
  assert.ok(reply.includes('C:\\proj'));
  assert.ok(reply.includes('Claude: busy'), 'reports busy while Claude is busy');
  assert.ok(reply.includes('Socket Mode'));
  assert.ok(reply.includes('Queued: 2'));
  assert.ok(reply.includes('Active tickets: 2'));
});

test('Scenario: no folder → no poll, activeTickets null → "unknown"', async () => {
  const h = makeStatusHandler({
    folder: null, status: 'idle', transport: 'poll', inbox: [],
  });
  const reply = await h.handler(h.tab);
  assert.equal(h.calls.pollForce, null, 'never polls without a folder');
  assert.ok(reply.includes('(no folder open)'));
  assert.ok(reply.includes('Claude: idle'));
  assert.ok(reply.includes('polling'));
  assert.ok(reply.includes('Queued: 0'));
  assert.ok(reply.includes('Active tickets: unknown'));
});

test('Scenario (edge): board read failure → activeTickets null ("unknown"), never throws', async () => {
  const h = makeStatusHandler({
    folder: 'C:\\proj', status: 'idle', transport: 'poll', inbox: [], pollThrows: true,
  });
  let reply;
  await assert.doesNotReject(async () => { reply = await h.handler(h.tab); });
  assert.equal(h.calls.pollForce, true, 'attempted the force poll');
  assert.ok(reply.includes('Active tickets: unknown'));
});

test('Scenario (edge): transport null → "none"; missing inbox → "Queued: 0"', async () => {
  const h = makeStatusHandler({
    folder: 'C:\\proj', status: 'idle', transport: null, inbox: undefined,
    tickets: new Map(),
  });
  const reply = await h.handler(h.tab);
  assert.ok(reply.includes('none'));
  assert.ok(reply.includes('Queued: 0'));
  assert.ok(reply.includes('Active tickets: 0'), 'empty board → 0 active, not unknown');
});
