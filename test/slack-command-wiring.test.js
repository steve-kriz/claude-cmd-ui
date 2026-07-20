'use strict';

// Source-scan + harness tests for TASK-057: intercept Slack thread commands in
// the renderer's inbound pipeline and answer them in-thread instead of
// forwarding to Claude.
//
// Two layers (mirroring test/slack-flush.test.js):
//
//   1. renderer/renderer.js source-scans — the browser-side wiring is not
//      require()-able, so we assert against its source: the verbatim mirrors of
//      normalizeCommandInput / matchCommand / listCommands + SLACK_DEFAULT_COMMANDS
//      (each carrying the "Mirrors … in lib/slack-commands.js; keep in sync"
//      note), and the handleIncomingSlackMessage ordering (matcher AFTER
//      appendSlackMessage, BEFORE inbox.push; command path returns before
//      dispatch; postToSlack targeted at the anchor thread; error path present).
//
//   2. A Given/When/Then harness (fake pty + in-memory post capture, verbatim
//      copies of the pipeline) proving: command → 1 thread post + 0 pty writes;
//      non-command → pty write; throwing handler → failure reply + 0 pty writes;
//      unknown-name → "isn't available" reply.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeCommandInput, matchCommand } = require('../lib/slack-commands');

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
// PART 1 — Source-scan guards: verbatim mirror + sync notes
// ===========================================================================

test('renderer mirrors normalizeCommandInput verbatim with a sync note', () => {
  const body = fnBody(rendererSrc, 'function normalizeCommandInput(text)');
  assert.match(body, /if\s*\(typeof\s+text\s*!==\s*'string'\)\s*return\s*''/);
  assert.match(body, /\.toLowerCase\(\)/);
  assert.match(body, /\.replace\(\/\\s\+\/g, ' '\)/);
  assert.match(body, /\.replace\(\/\[\.!\?…\]\+\$\/u, ''\)/);
  const idx = rendererSrc.indexOf('function normalizeCommandInput(text)');
  const preamble = rendererSrc.slice(idx - 400, idx);
  assert.match(preamble, /Mirrors normalizeCommandInput in lib\/slack-commands\.js; keep in sync/);
});

test('renderer mirrors matchCommand verbatim with a sync note', () => {
  const body = fnBody(rendererSrc, 'function matchCommand(text, registry = SLACK_DEFAULT_COMMANDS)');
  assert.match(body, /const\s+normalized\s*=\s*normalizeCommandInput\(text\)/);
  assert.match(body, /if\s*\(!Array\.isArray\(registry\)\)\s*return\s+null/);
  assert.match(body, /if\s*\(!entry\s*\|\|\s*!Array\.isArray\(entry\.patterns\)\)\s*continue/);
  assert.match(body, /return\s*\{\s*name:\s*entry\.name,\s*command:\s*entry\s*\}/);
  const idx = rendererSrc.indexOf('function matchCommand(text, registry = SLACK_DEFAULT_COMMANDS)');
  const preamble = rendererSrc.slice(idx - 400, idx);
  assert.match(preamble, /Mirrors matchCommand in lib\/slack-commands\.js; keep in sync/);
});

test('renderer mirrors listCommands verbatim with a sync note', () => {
  const body = fnBody(rendererSrc, 'function listCommands(registry = SLACK_DEFAULT_COMMANDS)');
  assert.match(body, /if\s*\(!Array\.isArray\(registry\)\)\s*return\s*\[\]/);
  assert.match(body, /out\.push\(\{\s*name:\s*entry\.name,\s*description:\s*entry\.description\s*\}\)/);
  const idx = rendererSrc.indexOf('function listCommands(registry = SLACK_DEFAULT_COMMANDS)');
  const preamble = rendererSrc.slice(idx - 400, idx);
  assert.match(preamble, /Mirrors listCommands in lib\/slack-commands\.js; keep in sync/);
});

test('renderer defines SLACK_DEFAULT_COMMANDS (with the tasks command) and a SLACK_COMMAND_HANDLERS map', () => {
  assert.match(rendererSrc, /const\s+SLACK_DEFAULT_COMMANDS\s*=\s*\[/);
  assert.match(rendererSrc, /const\s+SLACK_COMMAND_HANDLERS\s*=\s*\{/);
  // The registry mirror carries the DEFAULT_COMMANDS sync note.
  const idx = rendererSrc.indexOf('const SLACK_DEFAULT_COMMANDS = [');
  const preamble = rendererSrc.slice(idx - 400, idx);
  assert.match(preamble, /Mirrors DEFAULT_COMMANDS in lib\/slack-commands\.js; keep in sync/);
});

test('handleIncomingSlackMessage: matcher runs AFTER appendSlackMessage, BEFORE inbox.push', () => {
  const body = fnBody(rendererSrc, 'function handleIncomingSlackMessage(tab, msg)');
  const appendIdx = body.indexOf('appendSlackMessage(tab,');
  const matchIdx = body.indexOf('matchCommand(text, SLACK_DEFAULT_COMMANDS)');
  const pushIdx = body.indexOf('s.inbox.push');
  const dispatchIdx = body.indexOf('slackTryDispatch(tab)');
  assert.ok(appendIdx !== -1 && matchIdx !== -1 && pushIdx !== -1 && dispatchIdx !== -1);
  assert.ok(appendIdx < matchIdx, 'append the user message before matching');
  assert.ok(matchIdx < pushIdx, 'match before pushing to the inbox');
  assert.ok(matchIdx < dispatchIdx, 'match before dispatch');
});

test('handleIncomingSlackMessage: command path calls handleSlackCommand and RETURNS before inbox/dispatch', () => {
  const body = fnBody(rendererSrc, 'function handleIncomingSlackMessage(tab, msg)');
  // The matched block must call the command handler and return.
  assert.match(body, /if\s*\(matched\)\s*\{\s*handleSlackCommand\(tab,\s*matched,\s*msg\);\s*return;/);
  // The return must sit before inbox.push in source order.
  const returnIdx = body.indexOf('handleSlackCommand(tab, matched, msg);');
  const pushIdx = body.indexOf('s.inbox.push');
  assert.ok(returnIdx !== -1 && pushIdx !== -1 && returnIdx < pushIdx,
    'command handled + returned before the inbox push');
});

test('handleSlackCommand: async, posts to the anchor thread, has unknown + error paths, no idle-gate touches', () => {
  const body = fnBody(rendererSrc, 'async function handleSlackCommand(tab, matched, msg)');
  // Looks the handler up by matched name.
  assert.match(body, /SLACK_COMMAND_HANDLERS\[matched\.name\]/);
  // Unknown handler → "isn't available" reply into the anchor thread.
  assert.match(body, /That command isn't available in this session\./);
  // Non-empty handler result posts to the anchor thread + mirrors as a system msg.
  assert.match(body, /postToSlack\(tab,\s*replyText,\s*s\.threadTs\)/);
  assert.match(body, /appendSlackMessage\(tab,\s*\{\s*who:\s*'system',\s*text:\s*replyText\s*\}\)/);
  // Empty/whitespace return posts nothing (guarded by a trim check).
  assert.match(body, /replyText\.trim\(\)/);
  // Error path: try/catch posting a "Command failed:" reply.
  assert.match(body, /catch\s*\(err\)/);
  assert.match(body, /Command failed: /);
  // Never touches the idle-gate / dispatch state.
  assert.ok(!/awaitingResponse/.test(body), 'command handling never touches awaitingResponse');
  assert.ok(!/captureBuffer/.test(body), 'command handling never touches captureBuffer');
  assert.ok(!/setTabStatus/.test(body), 'command handling never changes tab.status');
  assert.ok(!/window\.api\.pty\.write/.test(body), 'command handling never writes to the pty');
});

// ===========================================================================
// PART 2 — Harness: verbatim-mirrored pipeline behaviour
// ===========================================================================

// Verbatim-ish copies of the renderer's command wiring (kept in lockstep with
// the PART 1 source-scans). The pure matcher is the REAL lib implementation so
// the harness proves the wiring, not a re-implemented matcher.
function makeHarness(registry, handlers) {
  const ptyWrites = []; // every text written to the fake Claude pty
  const posts = [];     // every { text, threadTs } posted to Slack
  const paneRows = [];  // every message appended to the Slack pane

  const tab = {
    status: 'busy', // start busy to prove commands bypass the idle gate
    cmd: { id: 'pty-1' },
    slack: {
      connected: true,
      threadTs: 'T-anchor',
      inbox: [],
      awaitingResponse: false,
      captureBuffer: 'preexisting',
    },
  };

  function appendSlackMessage(t, m) { paneRows.push(m); }
  function proxyEnabled(s) { return !!(s && s.connected && s.threadTs); }
  function postToSlack(t, text, threadTs) {
    if (!proxyEnabled(t.slack) || !text) return { ok: false };
    posts.push({ text, threadTs });
    return { ok: true };
  }
  function slackTryDispatch(t) {
    const s = t.slack;
    if (!proxyEnabled(s)) return;
    if (s.awaitingResponse) return;
    if (!s.inbox.length) return;
    // Idle gate: busy/awaiting must NOT dispatch. Kept here so the harness can
    // prove commands still run while busy (they never reach this function).
    if (t.status !== 'finished' && t.status !== 'idle') return;
    const item = s.inbox.shift();
    s.awaitingResponse = true;
    ptyWrites.push(item.text);
  }

  async function handleSlackCommand(t, matched, msg) {
    const s = t.slack;
    const handler = handlers[matched.name];
    if (typeof handler !== 'function') {
      postToSlack(t, "That command isn't available in this session.", s.threadTs);
      return;
    }
    try {
      const replyText = await handler(t, msg);
      if (typeof replyText === 'string' && replyText.trim()) {
        postToSlack(t, replyText, s.threadTs);
        appendSlackMessage(t, { who: 'system', text: replyText });
      }
    } catch (err) {
      const detail = (err && err.message) || String(err);
      postToSlack(t, 'Command failed: ' + detail, s.threadTs);
    }
  }

  async function handleIncoming(t, msg) {
    const s = t.slack;
    const text = String(msg.text || '');
    if (!text.trim()) return;
    appendSlackMessage(t, { who: 'slack', author: msg.user || 'user', text, ts: msg.ts });
    const matched = matchCommand(text, registry);
    if (matched) {
      await handleSlackCommand(t, matched, msg);
      return;
    }
    s.inbox.push({ text, ts: msg.ts, user: msg.user });
    slackTryDispatch(t);
  }

  return { tab, ptyWrites, posts, paneRows, handleIncoming };
}

const REGISTRY = [{ name: 'status', description: 'Show status', patterns: ['status'] }];

test('Given a registered command When it arrives Then 1 thread post, 0 pty writes', async () => {
  const h = makeHarness(REGISTRY, { status: async () => 'All good.' });
  await h.handleIncoming(h.tab, { text: 'status', ts: '1.1', user: 'U1' });
  assert.deepEqual(h.posts, [{ text: 'All good.', threadTs: 'T-anchor' }]);
  assert.equal(h.ptyWrites.length, 0, 'command never reaches the pty');
  assert.equal(h.tab.slack.inbox.length, 0, 'command never enters the inbox');
  // The user's command still shows in the pane, plus the system reply.
  assert.equal(h.paneRows[0].who, 'slack');
  assert.equal(h.paneRows[1].who, 'system');
  assert.equal(h.paneRows[1].text, 'All good.');
  // Dispatch state untouched — commands bypass the idle gate.
  assert.equal(h.tab.slack.awaitingResponse, false);
  assert.equal(h.tab.slack.captureBuffer, 'preexisting');
  assert.equal(h.tab.status, 'busy');
});

test('Given a non-command reply Then it is dispatched to the pty', async () => {
  const h = makeHarness(REGISTRY, { status: async () => 'All good.' });
  h.tab.status = 'idle'; // idle so dispatch actually fires
  await h.handleIncoming(h.tab, { text: 'please refactor this', ts: '2.1', user: 'U1' });
  assert.equal(h.posts.length, 0, 'no thread post for ordinary conversation');
  assert.deepEqual(h.ptyWrites, ['please refactor this']);
});

test('Given a throwing handler Then a failure reply is posted and 0 pty writes', async () => {
  const h = makeHarness(REGISTRY, { status: async () => { throw new Error('boom'); } });
  await h.handleIncoming(h.tab, { text: 'status', ts: '3.1', user: 'U1' });
  assert.deepEqual(h.posts, [{ text: 'Command failed: boom', threadTs: 'T-anchor' }]);
  assert.equal(h.ptyWrites.length, 0, 'throwing command never reaches the pty');
  assert.equal(h.tab.slack.inbox.length, 0);
});

test('Given a matched command with NO handler Then the "isn\'t available" reply is posted', async () => {
  const h = makeHarness(REGISTRY, {}); // registry has "status" but no handler wired
  await h.handleIncoming(h.tab, { text: 'status', ts: '4.1', user: 'U1' });
  assert.deepEqual(h.posts, [{ text: "That command isn't available in this session.", threadTs: 'T-anchor' }]);
  assert.equal(h.ptyWrites.length, 0);
  assert.equal(h.tab.slack.inbox.length, 0);
});

test('Given a handler returning empty/whitespace Then nothing is posted', async () => {
  const h = makeHarness(REGISTRY, { status: async () => '   ' });
  await h.handleIncoming(h.tab, { text: 'status', ts: '5.1', user: 'U1' });
  assert.equal(h.posts.length, 0, 'no empty message posted');
  assert.equal(h.ptyWrites.length, 0);
});

test('Sanity: the real matcher backs the harness (whole-phrase, punctuation-tolerant)', () => {
  assert.equal(normalizeCommandInput('  STATUS! '), 'status');
  assert.deepEqual(matchCommand('Status.', REGISTRY), { name: 'status', command: REGISTRY[0] });
  assert.equal(matchCommand('status now', REGISTRY), null, 'not a substring match');
});
