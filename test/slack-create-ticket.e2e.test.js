'use strict';

// E2E cucumber-style scenarios for TASK-072: create a ticket on the tasks board
// from a two-step reply in the Slack anchor thread.
//
// These are the ticket's Gherkin scenarios expressed as Given/When/Then
// `node --test` cases (NO `cucumber` npm package — same scenario layout as the
// other slack-*.e2e.test.js files). renderer/renderer.js is a browser script and
// cannot be require()d, so this file drives an in-memory harness that mirrors the
// renderer's create-ticket wiring (handleIncomingSlackMessage → pending check →
// handleCreateTicketReply / handleSlackCommand → SLACK_COMMAND_HANDLERS
// ['create-ticket'], plus postCreateTicketReply and slackTryDispatch), kept in
// lockstep with renderer.js ~8388-8605. The PURE core is the REAL lib —
// parseCreateTicketReply / matchCommand / DEFAULT_COMMANDS / normalizeCommandInput
// from lib/slack-commands.js and defangSlackControlSequences from lib/slack-proxy.js
// — so the scenarios prove the WIRING, not a re-implemented parser.
//
// Everything external is an in-memory fake: window.api.fs (mkdir/writeFile/
// exists/readFile/rename/findByExt), window.api.slack.post capture, and a fake
// Claude pty capture. NO real FS writes, NO Slack/network, NO DB, NO pty, NO DOM.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_COMMANDS,
  matchCommand,
  parseCreateTicketReply,
  normalizeCommandInput,
} = require('../lib/slack-commands');
const { defangSlackControlSequences } = require('../lib/slack-proxy');

// renderer/renderer.js is a browser script and cannot be require()d, so the
// wiring mirrors below are hand-copied. TASK-076 adds drift guards (bottom of
// file) that read the renderer source and fail if that real wiring diverges
// from what these mirrors assume.
const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

function fnFull(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}');
  assert.ok(end !== -1, `${decl} body closes`);
  return from.slice(0, end + 2);
}

// Verbatim mirror of decodeSlackText (renderer ~8667). handleIncomingSlackMessage
// runs this on every incoming reply BEFORE the pending-check / matchCommand /
// dispatch, so the create-ticket flow only ever parses UNWRAPPED text. `receive()`
// below applies it in the same position; the drift guard keeps it byte-identical.
function decodeSlackText(t) {
  return String(t)
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<@([^>]+)>/g, '@$1')
    .replace(/<#[^|>]+\|([^>]+)>/g, '#$1')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// --- Renderer helpers copied VERBATIM from renderer.js (kept in lockstep) ----
// tasksJoin (~5167), TASKS_VALID_STATUSES (~5134), ticketFolderForStatus (~5252),
// frontmatterValueLine (~5309), serializeTicket (~5318), taskSlug (~6621),
// nextTaskId (~6632), neutralizeBugText (~7182), and the two prompt strings
// (~8382). The Slack post/create replies run through the REAL lib defang.
function tasksJoin(...parts) {
  return parts.reduce((acc, p) => {
    if (!acc) return p;
    const sep = acc.endsWith('\\') || acc.endsWith('/') ? '' : '\\';
    return acc + sep + p;
  });
}

const TASKS_LANE_STATUSES = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];
const TASKS_VALID_STATUSES = [...TASKS_LANE_STATUSES, 'failed-testing'];

function ticketFolderForStatus(status) {
  return TASKS_VALID_STATUSES.includes(status) ? status : null;
}

function frontmatterValueLine(v) {
  return String(v).replace(/[\r\n]+/g, ' ');
}

function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${frontmatterValueLine(fm[k])}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}

function taskSlug(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'ticket';
}

function nextTaskId(tab) {
  let max = 0;
  for (const tk of tab.tasks.tickets.values()) {
    const m = /TASK-0*(\d+)/i.exec(tk.fm.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'TASK-' + String(max + 1).padStart(3, '0');
}

function neutralizeBugText(text) {
  const s = text == null ? '' : String(text);
  return s
    .split('\n')
    .map((line) => line.replace(/^(\s*)(#+)(\s)/, '$1\\$2$3'))
    .join('\n');
}

const CREATE_TICKET_PROMPT = 'What ticket should I create? Reply with `title: <your title>, description: <your description>` (description optional), or say `cancel`.';
const CREATE_TICKET_REPROMPT = "Sorry, I couldn't read that. Reply with `title: <your title>, description: <your description>` (description optional), or say `cancel`.";

// --- The in-memory harness --------------------------------------------------
function makeEnv({ folder = 'C:\\proj', seedTickets, writeResult = { ok: true }, writeThrows = false } = {}) {
  const env = {
    ptyWrites: [], // everything written to the Claude (cmd) pty — must stay empty
    posted: [], // { text, thread } posted back into Slack
    pane: [], // messages rendered in the pane (appendSlackMessage)
    writes: [], // { path, content } captured fake writeFile calls
    mkdirs: [], // dirs a fake mkdir was asked to create
    pollCount: 0,
    lastPollForce: null,
  };

  const tab = {
    folder,
    cmd: { id: 'cmd-1' },
    status: 'busy', // Claude BUSY — proves create runs without touching the pty
    tasks: { tickets: new Map() },
    slack: {
      connected: true, threadTs: 'THREAD-1', inbox: [], awaitingResponse: false,
      captureBuffer: '', transport: 'socket', pendingCommand: null,
    },
  };

  const windowApi = {
    fs: {
      mkdir: async (p) => { env.mkdirs.push(p); return { ok: true }; },
      writeFile: async (p, content) => {
        env.writes.push({ path: p, content });
        if (writeThrows) throw new Error('EACCES: disk on fire');
        return writeResult;
      },
      exists: async () => ({ ok: true, exists: true }),
      readFile: async () => ({ ok: true, content: '' }),
      rename: async () => ({ ok: true }),
      findByExt: async () => ({ ok: true, files: [] }),
    },
    slack: {
      // The ONLY network surface — a pure capture, no real connection.
      post: async (_thread, text) => { env.posted.push({ text }); return { ok: true }; },
    },
    pty: { write: (id, data) => env.ptyWrites.push({ id, data }) },
  };

  // Forced poll (re)loads the board from the seed — proving read-after-poll and
  // that nextTaskId sees the refreshed ids.
  const pollTasksOnce = async (t, force) => {
    env.pollCount += 1;
    env.lastPollForce = force;
    t.tasks.tickets.clear();
    if (typeof seedTickets === 'function') seedTickets(t.tasks.tickets);
  };

  const postToSlack = (t, text, thread) => { windowApi.slack.post(thread, text); };
  const appendSlackMessage = (t, m) => env.pane.push(m);

  // Verbatim mirror of postCreateTicketReply (renderer ~8532).
  function postCreateTicketReply(t, text) {
    const s = t.slack;
    const reply = defangSlackControlSequences(text);
    if (!reply) return;
    postToSlack(t, reply, s.threadTs);
    appendSlackMessage(t, { who: 'system', text: reply });
  }

  // Verbatim mirror of handleCreateTicketReply (renderer ~8548).
  async function handleCreateTicketReply(t, text) {
    const s = t.slack;
    if (normalizeCommandInput(text) === 'cancel') {
      s.pendingCommand = null;
      postCreateTicketReply(t, 'Ticket creation cancelled.');
      return;
    }
    const parsed = parseCreateTicketReply(text);
    if (!parsed.ok) {
      postCreateTicketReply(t, CREATE_TICKET_REPROMPT);
      return;
    }
    try {
      await pollTasksOnce(t, true);
      const id = nextTaskId(t);
      const now = new Date().toISOString();
      const fm = { id, title: parsed.title, status: 'todo', created: now, updated: now };
      const description = neutralizeBugText(parsed.description) || 'What needs doing and why.';
      const body = [
        '',
        '## Description',
        description,
        '',
        '## Acceptance Criteria',
        '- [ ] First testable criterion',
        '',
        '## Additional Context',
        '(User-owned. Read it before building. Never overwrite it.)',
        '',
      ].join('\n');
      const tasksDir = tasksJoin(t.folder, 'tasks');
      const subfolder = ticketFolderForStatus('todo');
      const destDir = subfolder ? tasksJoin(tasksDir, subfolder) : tasksDir;
      await windowApi.fs.mkdir(destDir);
      const filePath = tasksJoin(destDir, `${id}-${taskSlug(parsed.title)}.md`);
      const wr = await windowApi.fs.writeFile(filePath, serializeTicket(fm, body));
      if (!wr || !wr.ok) {
        s.pendingCommand = null;
        postCreateTicketReply(t, 'Create failed: ' + ((wr && wr.error) || 'unknown'));
        return;
      }
      s.pendingCommand = null;
      await pollTasksOnce(t, true);
      postCreateTicketReply(t, `Created ${id} — ${parsed.title} (todo).`);
    } catch (err) {
      s.pendingCommand = null;
      postCreateTicketReply(t, 'Create failed: ' + ((err && err.message) || String(err)));
    }
  }

  // Verbatim mirror of SLACK_COMMAND_HANDLERS['create-ticket'] (renderer ~8445).
  const SLACK_COMMAND_HANDLERS = {
    'create-ticket': async (t) => {
      if (!t.folder) return 'No project folder is open.';
      t.slack.pendingCommand = { name: 'create-ticket' };
      return CREATE_TICKET_PROMPT;
    },
  };

  // Verbatim mirror of handleSlackCommand (renderer ~8502): defang + post reply.
  async function handleSlackCommand(t, matched) {
    const s = t.slack;
    const handler = SLACK_COMMAND_HANDLERS[matched.name];
    if (typeof handler !== 'function') {
      postToSlack(t, "That command isn't available in this session.", s.threadTs);
      return;
    }
    try {
      const replyText = defangSlackControlSequences(await handler(t));
      if (typeof replyText === 'string' && replyText.trim()) {
        postToSlack(t, replyText, s.threadTs);
        appendSlackMessage(t, { who: 'system', text: replyText });
      }
    } catch (err) {
      const detail = (err && err.message) || String(err);
      postToSlack(t, defangSlackControlSequences('Command failed: ' + detail), s.threadTs);
    }
  }

  // Verbatim mirror of slackTryDispatch (renderer): the ONLY path to the pty. A
  // create-ticket prompt reply is consumed BEFORE this can run.
  function slackTryDispatch(t) {
    const s = t.slack;
    if (!(s.connected && s.threadTs)) return;
    if (s.awaitingResponse) return;
    if (!s.inbox.length) return;
    if (!t.cmd.id) return;
    if (t.status !== 'finished' && t.status !== 'idle') return;
    const item = s.inbox.shift();
    s.awaitingResponse = true;
    s.captureBuffer = '';
    windowApi.pty.write(t.cmd.id, item.text);
  }

  // Verbatim mirror of handleIncomingSlackMessage (renderer ~8466): pending
  // prompt is consumed BEFORE matchCommand; otherwise a matched command answers
  // in-thread; else the message flows to the inbox → dispatch.
  async function receive(rawText) {
    const s = tab.slack;
    // Mirror renderer ~8526: decode Slack-encoded auto-links/mentions BEFORE the
    // pending-check / matchCommand / dispatch, so the create-ticket flow parses
    // exactly the unwrapped text the real handler would.
    const text = decodeSlackText(rawText);
    if (!text.trim()) return;
    appendSlackMessage(tab, { who: 'slack', text });
    if (s.pendingCommand && s.pendingCommand.name === 'create-ticket') {
      await handleCreateTicketReply(tab, text);
      return;
    }
    const matched = matchCommand(text, DEFAULT_COMMANDS);
    if (matched) {
      await handleSlackCommand(tab, matched);
      return;
    }
    s.inbox.push({ text });
    slackTryDispatch(tab);
  }

  return { env, tab, receive };
}

// Parse the frontmatter block + body out of a serialized ticket for assertions.
function splitTicket(content) {
  const lines = content.split('\n');
  assert.equal(lines[0], '---', 'starts with frontmatter fence');
  const close = lines.indexOf('---', 1);
  assert.ok(close > 0, 'frontmatter closes');
  const fm = {};
  for (const line of lines.slice(1, close)) {
    const m = /^([^:]+):\s?(.*)$/.exec(line);
    if (m) fm[m[1].trim()] = m[2];
  }
  return { fm, fmLines: lines.slice(1, close), body: lines.slice(close + 1).join('\n') };
}

// A board seeded so nextTaskId → TASK-072.
const seedBoard = (map) => {
  map.set('TASK-070.md', { fm: { id: 'TASK-070', title: 'Prior', status: 'done' } });
  map.set('TASK-071.md', { fm: { id: 'TASK-071', title: 'Also prior', status: 'todo' } });
};

// ===========================================================================
// Feature: create a ticket from the Slack anchor thread
// ===========================================================================

test('Scenario: happy path — prompt, then a valid reply writes the ticket and confirms; nothing hits the pty', async () => {
  // Given a connected proxy with a folder open and a board ending at TASK-071
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard });

  // When the user says "create ticket"
  await receive('create ticket');
  // Then the two-step prompt is posted and the flow is now pending
  assert.equal(env.posted.length, 1);
  assert.equal(env.posted[0].text, CREATE_TICKET_PROMPT);
  assert.deepEqual(tab.slack.pendingCommand, { name: 'create-ticket' });
  assert.equal(env.writes.length, 0, 'no file written yet — only prompted');

  // When the user passes back title + description
  await receive('title: Fix login flow, description: The login button does nothing on mobile');

  // Then exactly one ticket file is written under tasks/todo/
  assert.equal(env.writes.length, 1, 'exactly one ticket file written');
  const { path: filePath, content } = env.writes[0];
  assert.equal(filePath, 'C:\\proj\\tasks\\todo\\TASK-072-fix-login-flow.md', `path was:\n${filePath}`);
  assert.deepEqual(env.mkdirs, ['C:\\proj\\tasks\\todo'], 'created the todo lane dir');

  // And the frontmatter carries id/title/status:todo/created+updated
  const { fm, body } = splitTicket(content);
  assert.equal(fm.id, 'TASK-072');
  assert.equal(fm.title, 'Fix login flow');
  assert.equal(fm.status, 'todo');
  assert.ok(fm.created && !Number.isNaN(Date.parse(fm.created)), 'created is an ISO timestamp');
  assert.ok(fm.updated && !Number.isNaN(Date.parse(fm.updated)), 'updated is an ISO timestamp');

  // And the body has the description, placeholder acceptance criteria and the
  // user-owned Additional Context placeholder
  assert.match(body, /## Description\nThe login button does nothing on mobile/);
  assert.match(body, /## Acceptance Criteria\n- \[ \] First testable criterion/);
  assert.match(body, /## Additional Context\n\(User-owned\. Read it before building\. Never overwrite it\.\)/);

  // And the confirmation is posted
  assert.ok(env.posted.some((p) => p.text === 'Created TASK-072 — Fix login flow (todo).'),
    `confirmation missing, posts:\n${env.posted.map((p) => p.text).join('\n---\n')}`);

  // And pending is cleared and NOTHING was written to the Claude pty
  assert.equal(tab.slack.pendingCommand, null, 'pending cleared after success');
  assert.equal(env.ptyWrites.length, 0, 'create flow never writes to the Claude pty');
  assert.equal(env.lastPollForce, true, 'board force-polled around the create');
});

test('Scenario: labels in either order + a multiline description are preserved', async () => {
  // Given a pending create-ticket prompt
  const { env, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('create ticket');

  // When the reply puts description first and spans multiple lines
  await receive('description: first line\nsecond line\nthird line, title: Ordered oddly');

  // Then the ticket title/description are parsed correctly and the newlines survive
  const { fm, body } = splitTicket(env.writes[0].content);
  assert.equal(fm.title, 'Ordered oddly');
  assert.match(body, /## Description\nfirst line\nsecond line\nthird line\n/);
});

test('Scenario: description omitted → the default description is used', async () => {
  // Given a pending create-ticket prompt
  const { env, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('create a ticket'); // alias

  // When the reply gives only a title
  await receive('title: Just a title');

  // Then the body uses the New-ticket-modal default description
  const { body } = splitTicket(env.writes[0].content);
  assert.match(body, /## Description\nWhat needs doing and why\.\n/);
  assert.ok(env.posted.some((p) => /^Created TASK-072 — Just a title \(todo\)\.$/.test(p.text)));
});

test('Scenario (failure): "cancel" aborts — no file written, pending cleared, cancellation posted', async () => {
  // Given a pending create-ticket prompt
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('new ticket'); // alias
  assert.deepEqual(tab.slack.pendingCommand, { name: 'create-ticket' });

  // When the user says "cancel"
  await receive('cancel');

  // Then no ticket is written, pending is cleared, and cancellation is confirmed
  assert.equal(env.writes.length, 0, 'no file written on cancel');
  assert.equal(tab.slack.pendingCommand, null, 'pending cleared on cancel');
  assert.ok(env.posted.some((p) => p.text === 'Ticket creation cancelled.'));
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (failure/edge): an unparseable reply re-prompts and STAYS pending; a following valid reply still creates', async () => {
  // Given a pending create-ticket prompt
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('add ticket'); // alias
  const promptCount = env.posted.length;

  // When the reply cannot be parsed (no title)
  await receive('uhh I dunno what to put here');

  // Then the format is restated, no file is written, and it is still pending
  assert.ok(env.posted.some((p) => p.text === CREATE_TICKET_REPROMPT), 're-prompt posted');
  assert.equal(env.writes.length, 0, 'nothing written for an unparseable reply');
  assert.deepEqual(tab.slack.pendingCommand, { name: 'create-ticket' }, 'stays pending');
  assert.ok(env.posted.length > promptCount);

  // And when the user then sends a valid reply, the ticket IS created
  await receive('title: Recovered ticket');
  assert.equal(env.writes.length, 1, 'the follow-up valid reply creates the ticket');
  assert.equal(splitTicket(env.writes[0].content).fm.title, 'Recovered ticket');
  assert.equal(tab.slack.pendingCommand, null, 'pending cleared after the eventual success');
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (failure): no project folder open → refused with no pending state', async () => {
  // Given no folder is open
  const { env, tab, receive } = makeEnv({ folder: null, seedTickets: seedBoard });

  // When the user says "create ticket"
  await receive('create ticket');

  // Then it is refused, no prompt pending, no file
  assert.ok(env.posted.some((p) => p.text === 'No project folder is open.'));
  assert.equal(tab.slack.pendingCommand, null, 'no pending state without a folder');
  assert.equal(env.writes.length, 0);
  assert.equal(env.ptyWrites.length, 0);

  // And a following "title: ..." reply is NOT consumed as a create (no pending),
  // so it flows onward instead of writing a ticket.
  await receive('title: Should not create');
  assert.equal(env.writes.length, 0, 'no ticket created when there was never a folder/pending');
});

test('Scenario (failure): the write fails → "Create failed:" reply, pending cleared, no crash', async () => {
  // Given a pending prompt but a filesystem whose writeFile will fail
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard, writeResult: { ok: false, error: 'disk full' } });
  await receive('create ticket');

  // When a valid reply is passed back
  await receive('title: Doomed write, description: will not persist');

  // Then the failure is surfaced, pending is cleared, and nothing crashes
  assert.ok(env.posted.some((p) => p.text === 'Create failed: disk full'),
    `expected a create-failed reply, got:\n${env.posted.map((p) => p.text).join('\n')}`);
  assert.equal(tab.slack.pendingCommand, null, 'pending cleared after a write failure');
  assert.ok(!env.posted.some((p) => /^Created /.test(p.text)), 'no false confirmation on failure');
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (failure/edge): a throwing writeFile is caught → "Create failed:" reply, pending cleared, no crash', async () => {
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard, writeThrows: true });
  await receive('create ticket');
  await receive('title: Throws on write');
  assert.ok(env.posted.some((p) => /^Create failed: /.test(p.text)), 'a create-failed reply is posted');
  assert.equal(tab.slack.pendingCommand, null, 'pending cleared after a thrown write');
  assert.ok(!env.posted.some((p) => /^Created /.test(p.text)));
});

test('Scenario (security): a malicious title/description cannot broadcast, inject frontmatter, or forge a section', async () => {
  // Given a pending prompt and a hostile reply: the title carries a <!channel>
  // broadcast AND an embedded newline, the description tries to forge a
  // "## Additional Context" heading.
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('create ticket');
  await receive('title: <!channel>\npwn line two, description: ## Additional Context takeover');

  // Then the confirmation NEUTRALIZES the broadcast (no live <!channel> ping)
  const confirmation = env.posted.find((p) => /^Created /.test(p.text));
  assert.ok(confirmation, 'a confirmation was posted');
  assert.ok(!/<!channel>/.test(confirmation.text), 'live <!channel> broadcast is neutralized');
  assert.match(confirmation.text, /&lt;!channel>/, 'broadcast rendered inertly');

  // And the written frontmatter title is a SINGLE physical line (no injected
  // frontmatter key / early `---` close from the embedded newline)
  const { fm, fmLines, body } = splitTicket(env.writes[0].content);
  assert.equal(fm.title, '<!channel> pwn line two', 'title collapsed onto one physical line');
  assert.equal(fmLines.filter((l) => /^title:/.test(l)).length, 1, 'exactly one title line');
  assert.ok(!fmLines.some((l) => /^pwn/.test(l)), 'the second title line did not become its own frontmatter key');

  // And the description cannot start a NEW "## " section — the forged heading is
  // escaped, so the only real "## Additional Context" heading is the template one.
  assert.match(body, /## Description\n\\## Additional Context takeover/, 'forged heading escaped inside Description');
  const realHeadings = body.split('\n').filter((l) => l === '## Additional Context');
  assert.equal(realHeadings.length, 1, 'exactly one genuine Additional Context section (the template)');
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (edge): while pending, an unrelated command phrase is consumed by the prompt, NOT matched as a command', async () => {
  // Given a pending create-ticket prompt
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('create ticket');
  const beforeWrites = env.writes.length;

  // When the user replies with something that would otherwise match "status"
  await receive('title: status, description: this is a real ticket about status');

  // Then it is treated as the create reply (a ticket is written), not the status
  // command, and nothing is forwarded to the pty.
  assert.equal(env.writes.length, beforeWrites + 1, 'the reply was consumed as the create title');
  assert.equal(splitTicket(env.writes[0].content).fm.title, 'status');
  assert.equal(tab.slack.pendingCommand, null);
  assert.equal(env.ptyWrites.length, 0);
});

// ===========================================================================
// Feature: Create-ticket test fidelity is hardened (TASK-076)
// ===========================================================================

test('Scenario (edge): a Slack auto-linked reply is decoded before parsing — the ticket reflects the unwrapped text', async () => {
  // Given a pending create-ticket prompt
  const { env, tab, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('create ticket');

  // When the reply arrives Slack-encoded (auto-linked URL + user mention)
  await receive('title: See <http://example.com|example.com>, description: ping <@U123>');

  // Then the flow decoded it (via decodeSlackText, exactly like the renderer) and
  // the ticket reflects the unwrapped text — the parser tolerated the decoded
  // input and did not throw.
  assert.equal(env.writes.length, 1, 'exactly one ticket written from the decoded reply');
  const { fm, body } = splitTicket(env.writes[0].content);
  assert.equal(fm.title, 'See example.com', 'the <http://…|example.com> link unwrapped to its label');
  assert.match(body, /## Description\nping @U123\n/, 'the <@U123> mention unwrapped to @U123');
  assert.ok(env.posted.some((p) => p.text === 'Created TASK-072 — See example.com (todo).'),
    `confirmation missing, posts:\n${env.posted.map((p) => p.text).join('\n---\n')}`);
  assert.equal(tab.slack.pendingCommand, null, 'pending cleared after the decoded create');
  assert.equal(env.ptyWrites.length, 0);
});

test('Scenario (edge): a decoded description that still contains commas parses whole', async () => {
  // Given a pending prompt
  const { env, receive } = makeEnv({ seedTickets: seedBoard });
  await receive('create ticket');

  // When the decoded description still holds commas (first-label-wins keeps them)
  await receive('title: Docs, description: see <http://a.com|a.com>, <http://b.com|b.com> and &amp; more');

  // Then the whole decoded description survives intact
  const { fm, body } = splitTicket(env.writes[0].content);
  assert.equal(fm.title, 'Docs');
  assert.match(body, /## Description\nsee a\.com, b\.com and & more\n/);
});

// --- Drift guards: tie the hand-copied wiring mirrors to renderer.js ---------
// NOTE: a full byte-identical guard is impractical for these browser-only
// wiring functions because this harness deliberately renames `window.api` →
// `windowApi`, uses the param name `t` (renderer uses `tab`), and omits the
// renderer's inline comments. So (per the ticket) these are the tightest
// feasible SOURCE-SCAN assertions: they extract each real renderer function body
// and assert it still carries every load-bearing statement these mirrors depend
// on. If the renderer wiring drifts, these fail instead of the e2e passing
// silently. `decodeSlackText` (a pure helper with no renaming) IS guarded
// byte-identically.

test('drift guard: decodeSlackText mirror is byte-identical to renderer.js', () => {
  const rendererFn = fnFull(rendererSrc, 'function decodeSlackText(t)');
  const localFn = decodeSlackText.toString().replace(/\r\n/g, '\n');
  assert.equal(localFn, rendererFn, 'the harness decodeSlackText must match renderer.js verbatim');
});

test('drift guard: renderer handleIncomingSlackMessage decodes, then checks pending BEFORE matchCommand', () => {
  const body = fnBody(rendererSrc, 'function handleIncomingSlackMessage(tab, msg)');
  const decodeAt = body.indexOf('const text = decodeSlackText(msg.text');
  const pendingAt = body.indexOf("s.pendingCommand.name === 'create-ticket'");
  const dispatchAt = body.indexOf('handleCreateTicketReply(tab, text)');
  const matchAt = body.indexOf('matchCommand(text');
  assert.ok(decodeAt !== -1, 'decodes the incoming text');
  assert.ok(pendingAt !== -1, 'checks the pending create-ticket prompt');
  assert.ok(dispatchAt !== -1, 'routes a pending reply to handleCreateTicketReply');
  assert.ok(matchAt !== -1, 'otherwise matches registry commands');
  assert.ok(decodeAt < pendingAt, 'decode happens BEFORE the pending check');
  assert.ok(pendingAt < matchAt, 'pending check happens BEFORE matchCommand (a pending reply is never command-matched)');
});

test('drift guard: renderer create-ticket handler still sets pending + returns the prompt', () => {
  const idx = rendererSrc.indexOf("'create-ticket': async (tab) => {");
  assert.ok(idx !== -1, 'create-ticket handler present');
  const block = rendererSrc.slice(idx, idx + 220);
  assert.match(block, /if \(!tab\.folder\) return 'No project folder is open\.';/);
  assert.match(block, /tab\.slack\.pendingCommand = \{ name: 'create-ticket' \};/);
  assert.match(block, /return CREATE_TICKET_PROMPT;/);
});

test('drift guard: renderer postCreateTicketReply still defangs + posts + mirrors to the pane', () => {
  const body = fnBody(rendererSrc, 'function postCreateTicketReply(tab, text)');
  assert.match(body, /const reply = defangSlackControlSequences\(text\);/);
  assert.match(body, /if \(!reply\) return;/);
  assert.match(body, /postToSlack\(tab, reply, s\.threadTs\);/);
  assert.match(body, /appendSlackMessage\(tab, \{ who: 'system', text: reply \}\);/);
});

test('drift guard: renderer handleCreateTicketReply still carries the full create wiring this harness mirrors', () => {
  const body = fnBody(rendererSrc, 'async function handleCreateTicketReply(tab, text)');
  // cancel branch
  assert.match(body, /normalizeCommandInput\(text\) === 'cancel'/);
  assert.match(body, /s\.pendingCommand = null;/);
  assert.match(body, /postCreateTicketReply\(tab, 'Ticket creation cancelled\.'\);/);
  // parse + re-prompt branch
  assert.match(body, /const parsed = parseCreateTicketReply\(text\);/);
  assert.match(body, /if \(!parsed\.ok\)/);
  assert.match(body, /postCreateTicketReply\(tab, CREATE_TICKET_REPROMPT\);/);
  // create branch: force-poll, id, frontmatter, defanged/neutralized body, write
  assert.match(body, /await pollTasksOnce\(tab, true\);/);
  assert.match(body, /const id = nextTaskId\(tab\);/);
  assert.match(body, /const fm = \{ id, title: parsed\.title, status: 'todo', created: now, updated: now \};/);
  assert.match(body, /neutralizeBugText\(parsed\.description\) \|\| 'What needs doing and why\.'/);
  assert.match(body, /await window\.api\.fs\.mkdir\(destDir\);/);
  assert.match(body, /await window\.api\.fs\.writeFile\(filePath, serializeTicket\(fm, body\)\);/);
  // write-failure + success + catch replies
  assert.match(body, /if \(!wr \|\| !wr\.ok\)/);
  assert.match(body, /postCreateTicketReply\(tab, 'Create failed: ' \+ \(\(wr && wr\.error\) \|\| 'unknown'\)\);/);
  assert.match(body, /postCreateTicketReply\(tab, `Created \$\{id\} — \$\{parsed\.title\} \(todo\)\.`\);/);
  assert.match(body, /postCreateTicketReply\(tab, 'Create failed: ' \+ \(\(err && err\.message\) \|\| String\(err\)\)\);/);
});
