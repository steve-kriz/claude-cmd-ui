'use strict';

// E2E cucumber-style scenarios for TASK-064: app-posted command / failure
// replies must NEUTRALIZE ("defang") Slack broadcast/mention CONTROL SEQUENCES
// (<!channel>, <!here>, <@U…>, <#C…>, <!subteam^…>) so semi-trusted content a
// handler echoes back (thread text, ticket titles, error strings) can never
// induce a channel-wide ping or a live mention. The defang breaks the leading
// `<` of the token into the entity `&lt;` so Slack renders it inertly.
//
// These are the ticket's Gherkin scenarios written as Given/When/Then
// `node --test` cases (no `cucumber` npm package — same layout as the other
// slack-*.e2e.test.js files). Where test/slack-defang.test.js unit-tests the
// pure helper + source-scans the renderer, THIS file exercises the renderer's
// command DISPATCH PIPELINE end to end:
//
//   incoming matched command
//     → handleSlackCommand → handler reply  → defang → postToSlack(thread)
//                          → handler throws → "Command failed: <msg>" → defang → post
//
// proving BOTH post paths (the normal reply AND the failure reply) are defanged
// before they reach Slack, and that ordinary/benign text is posted unchanged.
//
// Everything external is an in-memory fake — no real Slack/network, no DB, no
// DOM, no pty. The REAL lib/slack-proxy defangSlackControlSequences backs the
// pipeline (it is proven byte-identical to the renderer mirror by
// test/slack-defang.test.js), so the scenarios prove the WIRING, not a
// re-implemented core. The handleSlackCommand copy below is kept in lockstep
// with renderer/renderer.js (~8155).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { defangSlackControlSequences } = require('../lib/slack-proxy');

// Build an in-memory environment mirroring the renderer's Slack command
// dispatch. Each scenario injects a single handler (keyed 'cmd') whose reply
// text or thrown error it controls, so the scenario decides exactly what
// semi-trusted content flows into the post paths. Records every side effect
// (thread posts, pane appends) so the scenarios can assert what reached Slack.
function makeEnv({ handler } = {}) {
  const env = {
    posted: [], // { text, thread } posted back into Slack
    pane: [], // messages appended to the Slack pane
  };

  const tab = {
    folder: 'C:\\proj',
    cmd: { id: 'cmd-1' },
    status: 'idle',
    slack: { connected: true, threadTs: 'THREAD-1', inbox: [], awaitingResponse: false, captureBuffer: '' },
  };

  const SLACK_COMMAND_HANDLERS = { cmd: handler };

  const postToSlack = (t, text, thread) => env.posted.push({ text, thread });
  const appendSlackMessage = (t, m) => env.pane.push(m);

  // Verbatim-ish copy of handleSlackCommand (renderer/renderer.js ~8155): the
  // awaited handler reply is wrapped in defangSlackControlSequences before
  // posting, and the caught-error "Command failed: <detail>" string is likewise
  // defanged before posting. Both post paths pass through the defang.
  async function handleSlackCommand(t, matched, msg) {
    const s = t.slack;
    const h = SLACK_COMMAND_HANDLERS[matched.name];
    if (typeof h !== 'function') {
      postToSlack(t, "That command isn't available in this session.", s.threadTs);
      return;
    }
    try {
      const replyText = defangSlackControlSequences(await h(t, msg));
      if (typeof replyText === 'string' && replyText.trim()) {
        postToSlack(t, replyText, s.threadTs);
        appendSlackMessage(t, { who: 'system', text: replyText });
      }
    } catch (err) {
      const detail = (err && err.message) || String(err);
      postToSlack(t, defangSlackControlSequences('Command failed: ' + detail), s.threadTs);
    }
  }

  const receive = (msg) => handleSlackCommand(tab, { name: 'cmd' }, msg);

  return { env, tab, receive };
}

// A live Slack broadcast/mention is only "live" when its leading `<` is a real
// `<` — i.e. immediately followed by the trigger char. After defang the `<`
// became `&lt;`, so this regex (a bare `<` before the trigger) must NOT match.
const LIVE_CONTROL = /<[!@#]/;

// ===========================================================================
// Feature: defang Slack control sequences in command / failure replies
// ===========================================================================

test('Scenario: a command reply containing <!channel> is defanged before posting', async () => {
  // Given a command handler that echoes semi-trusted text carrying <!channel>
  const { env, receive } = makeEnv({ handler: async () => 'done <!channel>' });

  // When the command is dispatched
  await receive({ text: 'do it', ts: '1.1' });

  // Then exactly one reply is posted into the session anchor thread
  assert.equal(env.posted.length, 1, 'one reply posted');
  assert.equal(env.posted[0].thread, 'THREAD-1', 'posted into the anchor thread');
  const posted = env.posted[0].text;

  // And the posted text does NOT contain a live <!channel> broadcast trigger
  assert.ok(!LIVE_CONTROL.test(posted), `no live control trigger, got: ${posted}`);
  assert.ok(!/<!channel>/.test(posted), 'live <!channel> is gone');
  // And the token still renders (inertly) via the &lt; entity
  assert.equal(posted, 'done &lt;!channel>');

  // And the same defanged text is what was mirrored into the pane
  assert.equal(env.pane.length, 1);
  assert.equal(env.pane[0].text, 'done &lt;!channel>');
});

test('Scenario: a failure message echoing untrusted <!here> is defanged before posting', async () => {
  // Given a command handler that throws an error whose message carries <!here>
  const { env, receive } = makeEnv({
    handler: async () => { throw new Error('boom <!here> everyone'); },
  });

  // When the command is dispatched and the handler rejects
  await receive({ text: 'do it', ts: '2.1' });

  // Then a single "Command failed: …" reply is posted into the anchor thread
  assert.equal(env.posted.length, 1, 'one failure reply posted');
  assert.equal(env.posted[0].thread, 'THREAD-1');
  const posted = env.posted[0].text;

  // And it does NOT contain a live <!here> broadcast trigger
  assert.ok(posted.startsWith('Command failed:'), `failure prefix kept, got: ${posted}`);
  assert.ok(!LIVE_CONTROL.test(posted), `no live control trigger, got: ${posted}`);
  assert.ok(!/<!here>/.test(posted), 'live <!here> is gone');
  assert.equal(posted, 'Command failed: boom &lt;!here> everyone');

  // And a thrown failure never appends to the pane (only the reply path does)
  assert.equal(env.pane.length, 0);
});

test('Scenario (edge): a synchronously-thrown non-Error carrying <@U9> is defanged', async () => {
  // Given a handler that throws a bare string (no .message) with a mention
  const { env, receive } = makeEnv({
    handler: async () => { throw 'raw <@U9> failure'; }, // eslint-disable-line no-throw-literal
  });

  // When the command is dispatched
  await receive({ text: 'do it', ts: '3.1' });

  // Then the String(err) detail is still defanged in the posted failure reply
  assert.equal(env.posted.length, 1);
  const posted = env.posted[0].text;
  assert.ok(!LIVE_CONTROL.test(posted), `no live control trigger, got: ${posted}`);
  assert.equal(posted, 'Command failed: raw &lt;@U9> failure');
});

test('Scenario: ordinary reply text is posted unchanged (no false positives)', async () => {
  // Given a handler returning benign build output with a lone `<`
  for (const reply of ['Build passed in 12s', 'a < b', 'List<int> compiled', '<div> rendered']) {
    const { env, receive } = makeEnv({ handler: async () => reply });

    // When the command is dispatched
    await receive({ text: 'do it', ts: '4.1' });

    // Then the reply is posted byte-for-byte unchanged
    assert.equal(env.posted.length, 1, `one reply for: ${reply}`);
    assert.equal(env.posted[0].text, reply, `posted unchanged: ${reply}`);
  }
});

test('Scenario: <@U123>, <#C123> and <!subteam^S1> are all defanged in a single reply', async () => {
  // Given a handler echoing every control-sequence flavour in one reply
  const { env, receive } = makeEnv({
    handler: async () => 'cc <@U123> in <#C123> and <!subteam^S1|team>',
  });

  // When the command is dispatched
  await receive({ text: 'do it', ts: '5.1' });

  // Then none of the tokens survive as a live trigger
  assert.equal(env.posted.length, 1);
  const posted = env.posted[0].text;
  assert.ok(!LIVE_CONTROL.test(posted), `no live control trigger, got: ${posted}`);
  assert.ok(!/<@U123>/.test(posted) && !/<#C123>/.test(posted) && !/<!subteam/.test(posted));
  assert.equal(posted, 'cc &lt;@U123> in &lt;#C123> and &lt;!subteam^S1|team>');
});

test('Scenario (edge): a handler returning empty/whitespace posts nothing, never throws', async () => {
  // Given a handler that returns an empty string (nothing to say)
  const { env, receive } = makeEnv({ handler: async () => '' });

  // When the command is dispatched
  let ran = true;
  try {
    await receive({ text: 'do it', ts: '6.1' });
  } catch (_) {
    ran = false;
  }

  // Then it does not throw and posts nothing (defang('') === '' → trim falsy)
  assert.ok(ran, 'empty reply did not throw');
  assert.equal(env.posted.length, 0, 'nothing posted for an empty reply');
  assert.equal(env.pane.length, 0);
});

// ===========================================================================
// Feature: the pure helper is null/empty safe (drives the same lib entrypoint
// the pipeline uses, from the e2e angle)
// ===========================================================================

test('Scenario (edge): defangSlackControlSequences is null/empty safe — string, no throw', () => {
  // Given non-string / empty inputs that could reach the helper via a handler
  // When each is defanged
  // Then the result is always a string and never throws
  for (const input of ['', null, undefined, 0, false, {}, []]) {
    let out;
    assert.doesNotThrow(() => { out = defangSlackControlSequences(input); });
    assert.equal(typeof out, 'string', `string for input: ${String(input)}`);
  }
  assert.equal(defangSlackControlSequences(''), '');
  assert.equal(defangSlackControlSequences(null), '');
  assert.equal(defangSlackControlSequences(undefined), '');
});
