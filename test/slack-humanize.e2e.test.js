'use strict';

// E2E (cucumber-style) scenarios for TASK-071: auto-posted Claude terminal
// output is cleaned up to be human readable BEFORE it reaches the Slack anchor
// thread. humanizeSlackOutput runs BETWEEN cleanTerminalOutput and redactSecrets
// on both auto-post paths, so the pipeline is:
//
//   redactSecrets(humanizeSlackOutput(cleanTerminalOutput(buffer)))
//
// with redactSecrets the LAST transform before postToSlack (TASK-063 guarantee
// untouched).
//
// These are Given/When/Then scenario cases under node --test (the `cucumber`
// npm package is NOT installed and is not used). They drive an in-memory harness
// that mirrors the renderer wiring (renderer.js is a browser script, not
// require()-able), in the TASK-061/TASK-063 flush-harness style:
//
//   - slackShouldFlushCapture(s) — mirror of the renderer/lib decision.
//   - cleanTerminalOutput(raw)   — copied verbatim from renderer.js.
//   - humanizeSlackOutput(text)  — the SHIPPED pure helper from lib/slack-proxy.js.
//   - redactSecrets(text)        — the SHIPPED pure helper from lib/slack-proxy.js.
//   - slackFlushTick(tab)        — mid-run flush: clean -> humanize -> REDACT -> post.
//   - slackOnFinished(tab)       — idle finish flush: clean -> humanize -> REDACT -> post.
//
// ALL network / Slack / DB is mocked: postToSlack is an in-memory fake that
// captures posted text. No real connections of any kind — in-memory fakes only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { redactSecrets, humanizeSlackOutput, shouldFlushCapture } = require('../lib/slack-proxy');

const R = '***REDACTED***';

// --- ANSI + terminal scrub: copied verbatim from renderer.js ----------------
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

function cleanTerminalOutput(raw) {
  if (!raw) return '';
  let text = String(raw).replace(ANSI_RE, '');
  text = text.split('\n').map((line) => {
    const parts = line.split('\r');
    return parts[parts.length - 1];
  }).join('\n');

  const lines = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/[ \t]+$/g, '');
    if (/^[\s│┃┆┇┊┋╎╏╭╮╯╰─━┄┅┈┉┌┐└┘├┤┬┴┼>·•⠀-⣿]*$/.test(line)) continue;
    if (/^\s*>\s*$/.test(line)) continue;
    if (/^\s*\?\s*for shortcuts\s*$/i.test(line)) continue;
    lines.push(line);
  }
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > 12000) out = out.slice(-12000);
  return out;
}

// --- Verbatim mirror of the renderer decision (kept in sync with lib) -------
function slackProxyEnabled(s) { return !!(s && s.connected && s.threadTs); }
function slackShouldFlushCapture(s) {
  return !!(
    slackProxyEnabled(s) &&
    s.postReplies &&
    typeof s.captureBuffer === 'string' &&
    s.captureBuffer.length > 0 &&
    s.busy === true
  );
}

// --- Harness: mirrors slackFlushTick / slackOnFinished with the TASK-071
// humanize pass wired in on BOTH auto-post paths exactly where renderer.js does:
//   redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)))
function makeHarness() {
  const posts = [];        // every text posted to Slack, in order
  const messages = [];     // local mirror (appendSlackMessage)

  const tab = {
    status: 'idle',
    slack: {
      connected: true, threadTs: 'T1', postReplies: true, captureBuffer: '',
      awaitingResponse: false, replyThreadTs: null,
    },
  };

  // Fake Slack post. NO network — captures text and returns ok.
  async function postToSlack(_tab, text, _threadTs) {
    await Promise.resolve();
    posts.push(text);
    return { ok: true };
  }
  function appendSlackMessage(_tab, msg) { messages.push(msg); }
  function emit(chunk) { tab.slack.captureBuffer += chunk; }

  // Verbatim mirror of renderer slackFlushTick (TASK-061 + 071 humanize + 063 redact).
  async function slackFlushTick() {
    const s = tab.slack;
    if (!s) return;
    const state = {
      connected: s.connected, threadTs: s.threadTs, postReplies: s.postReplies,
      captureBuffer: s.captureBuffer, busy: tab.status === 'busy',
    };
    if (!slackShouldFlushCapture(state)) return;
    // clean -> humanize -> REDACT -> post, buffer cleared BEFORE the await.
    const text = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)));
    s.captureBuffer = '';
    if (!text) return;
    appendSlackMessage(tab, { who: 'claude', text });
    await postToSlack(tab, text, s.threadTs);
  }

  // Verbatim mirror of renderer slackOnFinished (idle flush + 071 humanize + 063 redact).
  async function slackOnFinished() {
    const s = tab.slack;
    if (!s || !slackProxyEnabled(s)) { if (s) s.awaitingResponse = false; return; }
    const reply = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)));
    s.captureBuffer = '';
    s.awaitingResponse = false;
    s.replyThreadTs = null;
    if (reply) {
      appendSlackMessage(tab, { who: 'claude', text: reply });
      if (s.postReplies) await postToSlack(tab, reply, s.threadTs);
    }
  }

  return { tab, posts, messages, emit, slackFlushTick, slackOnFinished };
}

// ===========================================================================
// Scenario: Consecutive duplicate redraw lines are collapsed.
//   Given captured output with "Running tests..." 5 times in a row
//   When the finish flush posts to the anchor thread
//   Then the posted text contains "Running tests..." exactly once.
// ===========================================================================
test('Scenario: consecutive duplicate redraw lines are collapsed to one', async () => {
  // Given captured output repeating the same line five times
  const h = makeHarness();
  h.tab.status = 'busy';
  h.emit(Array(5).fill('Running tests...').join('\n'));
  h.tab.status = 'finished';

  // When the finish flush posts to the anchor thread
  await h.slackOnFinished();

  // Then the posted text carries that line exactly once
  assert.equal(h.posts.length, 1, 'one finish post');
  const occurrences = h.posts[0].split('Running tests...').length - 1;
  assert.equal(occurrences, 1, 'the redraw line appears exactly once');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed after finish');
});

// ===========================================================================
// Scenario: TUI spinner/status noise lines are removed.
//   Given output with "✻ Thinking… (esc to interrupt)" between two content lines
//   When a periodic flush tick posts
//   Then both content lines are present and no spinner/status line is.
// ===========================================================================
test('Scenario: TUI spinner/status noise is removed while surrounding content is kept', async () => {
  // Given a busy run whose buffer has a spinner line between two real lines
  const h = makeHarness();
  h.tab.status = 'busy';
  h.emit('Compiling project\n✻ Thinking… (esc to interrupt)\nBuild succeeded\n');

  // When a periodic flush tick posts
  await h.slackFlushTick();

  // Then both content lines survive and the spinner/status line is gone
  assert.equal(h.posts.length, 1, 'one flush post');
  assert.match(h.posts[0], /Compiling project/, 'first content line kept');
  assert.match(h.posts[0], /Build succeeded/, 'second content line kept');
  assert.ok(!h.posts[0].includes('Thinking'), 'the spinner "…ing…" line is gone');
  assert.ok(!h.posts[0].includes('esc to interrupt'), 'the interrupt hint is gone');
});

// ===========================================================================
// Scenario: Blank-line runs are collapsed.
//   Given cleaned output with 2+ consecutive blank lines
//   When it is humanized
//   Then at most one blank line separates the paragraphs.
// ===========================================================================
test('Scenario: blank-line runs collapse to at most one blank line', () => {
  // Given cleaned output with 2+ consecutive blank lines between two paragraphs
  const cleaned = 'paragraph one\n\n\n\nparagraph two';

  // When it is humanized
  const out = humanizeSlackOutput(cleaned);

  // Then at most one blank line separates the paragraphs
  assert.equal(out, 'paragraph one\n\nparagraph two');
  assert.ok(!/\n{3,}/.test(out), 'no run of 2+ blank lines remains');
});

// ===========================================================================
// Scenario: Ordinary output is untouched (edge).
//   Given captured output "Build succeeded in 12s\n40 files compiled"
//   When it is humanized
//   Then the text is unchanged.
// ===========================================================================
test('Scenario: ordinary output passes through unchanged', async () => {
  // Given a busy run with ordinary, noise-free output
  const h = makeHarness();
  h.tab.status = 'busy';
  const plain = 'Build succeeded in 12s\n40 files compiled';
  h.emit(plain);

  // When the flush humanizes and posts it
  await h.slackFlushTick();

  // Then the exact text is posted unchanged
  assert.deepEqual(h.posts, [plain], 'ordinary output posted verbatim');
});

// ===========================================================================
// Scenario: Redaction still runs last and is never weakened (edge/security).
//   Given output with "export API_KEY=sk-abc123DEF456ghi789" repeated twice
//   When the flush posts
//   Then the posted text contains "***REDACTED***" and never the raw key.
// ===========================================================================
test('Scenario: redaction still runs last after humanize — the raw key never leaks', async () => {
  // Given a busy run whose buffer repeats an exported API key twice
  const h = makeHarness();
  h.tab.status = 'busy';
  const rawKey = 'sk-abc123DEF456ghi789';
  h.emit(('export API_KEY=' + rawKey + '\n').repeat(2));

  // When the flush fires (clean -> humanize -> REDACT -> post)
  await h.slackFlushTick();

  // Then the post is redacted and the raw key never leaks, even after dedupe
  assert.equal(h.posts.length, 1, 'one flush post');
  assert.match(h.posts[0], /\*\*\*REDACTED\*\*\*/, 'post carries the redaction placeholder');
  assert.ok(!h.posts[0].includes(rawKey), 'the raw sk- key is NOT in the post');
  assert.ok(!h.posts[0].includes('sk-abc'), 'no fragment of the key leaked');
  assert.ok(!h.messages.some((m) => m.text && m.text.includes(rawKey)),
    'the local message mirror never holds the raw key either');

  // And the SHIPPED full pipeline (lib exports) yields the same guarantee.
  const piped = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(
    ('export API_KEY=' + rawKey + '\n').repeat(2))));
  assert.match(piped, /\*\*\*REDACTED\*\*\*/);
  assert.ok(!piped.includes(rawKey), 'full pipeline never emits the raw key');
});

// ===========================================================================
// Scenario: Pure-noise window posts nothing (edge).
//   Given a busy window whose output is only spinner/redraw/status noise
//   When the flush tick runs
//   Then no Slack post is made and the capture buffer is consumed.
// ===========================================================================
test('Scenario: a pure-noise window posts nothing yet consumes the buffer', async () => {
  // Given a busy run whose buffer holds only TUI noise (spinner/hint/counter/mode)
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.captureBuffer = [
    '✻ Thinking… (esc to interrupt)',
    '✻ Thinking… (esc to interrupt)',
    '(esc to interrupt)',
    '↑ 1.2k tokens',
    '⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n') + '\n';
  // Sanity: the shipped pipeline genuinely cleans this to the empty string
  assert.equal(
    redactSecrets(humanizeSlackOutput(cleanTerminalOutput(h.tab.slack.captureBuffer))),
    '');

  // When the flush tick runs
  await h.slackFlushTick();

  // Then nothing is posted, yet the buffer is consumed (no re-post later)
  assert.deepEqual(h.posts, [], 'no empty message posted for pure noise');
  assert.equal(h.tab.slack.captureBuffer, '', 'buffer consumed even though nothing posted');
});

// ===========================================================================
// Scenario: A mid-line glyph is not mistaken for a noise line (edge).
//   Given a real content line containing a "✻" in the middle of the text
//   When it is humanized
//   Then that content line is preserved.
// ===========================================================================
test('Scenario: a mid-line glyph inside real content is preserved', async () => {
  // Given a busy run with a content line that has a ✻ mid-line
  const h = makeHarness();
  h.tab.status = 'busy';
  const line = 'The star ✻ marks the spot';
  h.emit(line);

  // When the flush humanizes and posts it
  await h.slackFlushTick();

  // Then the content line survives untouched (only WHOLE noise lines are dropped)
  assert.deepEqual(h.posts, [line], 'mid-line glyph content preserved');
});

// ===========================================================================
// Scenario: Null/junk input is safe (failure).
//   When humanizeSlackOutput is called with "", null, undefined and a number
//   Then it returns a string and does not throw.
// ===========================================================================
test('Scenario: null / junk input returns a string and never throws', () => {
  for (const v of ['', null, undefined, 12345, {}, []]) {
    assert.doesNotThrow(() => humanizeSlackOutput(v));
    assert.equal(typeof humanizeSlackOutput(v), 'string', 'always returns a string');
    assert.equal(humanizeSlackOutput(v), '', 'degenerate input humanizes to ""');
  }
});

// A guard that the enabled precondition still gates the humanize+redact path.
test('Scenario (precondition): a disconnected proxy posts nothing (no leak path)', async () => {
  const h = makeHarness();
  h.tab.status = 'busy';
  h.tab.slack.connected = false;
  h.emit('Compiling project\n✻ Thinking…\n');
  assert.equal(shouldFlushCapture({ connected: false, threadTs: 'T1', postReplies: true,
    captureBuffer: 'x', busy: true }), false);
  await h.slackFlushTick();
  assert.deepEqual(h.posts, [], 'nothing posted while proxy disabled');
});

// ===========================================================================
// Source-scan: BOTH auto-post paths apply the pipeline in the required order
// with redactSecrets LAST — redactSecrets(humanizeSlackOutput(cleanTerminalOutput(...))).
// (Pattern from test/slack-redaction.test.js source scans.)
// ===========================================================================

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

const PIPELINE = /redactSecrets\(humanizeSlackOutput\(cleanTerminalOutput\(s\.captureBuffer\)\)\)/;
const PIPELINE_G = /redactSecrets\(humanizeSlackOutput\(cleanTerminalOutput\(s\.captureBuffer\)\)\)/g;

test('slackFlushTick applies humanize between clean and redact, redact LAST', () => {
  const body = fnBody(rendererSrc, 'async function slackFlushTick(tab)');
  assert.match(body, PIPELINE, 'flush path uses redact(humanize(clean(buffer)))');
  assert.match(body, /await\s+postToSlack\(tab,\s*text,\s*s\.threadTs\)/);
});

test('slackOnFinished applies humanize between clean and redact, redact LAST', () => {
  const body = fnBody(rendererSrc, 'function slackOnFinished(tab)');
  assert.match(body, PIPELINE, 'finish path uses redact(humanize(clean(buffer)))');
  assert.match(body, /postToSlack\(tab,\s*reply,\s*s\.threadTs\)/);
});

test('EVERY auto-post path routes cleaned output through humanize THEN redact (no bypass)', () => {
  // Every place that cleans the capture buffer for posting must wrap it in
  // humanizeSlackOutput and then redactSecrets — no third path may bypass either.
  const cleanUses = [...rendererSrc.matchAll(/cleanTerminalOutput\(s\.captureBuffer\)/g)];
  const pipedUses = [...rendererSrc.matchAll(PIPELINE_G)];
  assert.ok(cleanUses.length >= 2, 'both auto-post paths clean the capture buffer');
  assert.equal(pipedUses.length, cleanUses.length,
    'every cleanTerminalOutput(s.captureBuffer) on a post path is wrapped in redact(humanize(...))');
});
