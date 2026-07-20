'use strict';

// Unit + source-scan tests for TASK-063: redact secrets/tokens from Claude
// terminal output BEFORE it is auto-posted to the Slack anchor thread.
//
// cleanTerminalOutput strips ANSI/chrome but does NO secret redaction, and
// TASK-061 made the app post output CONTINUOUSLY mid-run (slackFlushTick) as
// well as at idle (slackOnFinished). redactSecrets(text) masks common secret
// shapes and is applied on the shared post path so NEITHER auto-post path can
// post un-redacted output. The user-composed sendSlackComposer path is left
// alone by design.
//
// Three layers, mirroring test/slack-proxy.test.js / test/slack-flush.test.js:
//
//   1. lib/slack-proxy.js — the pure, Electron-free redactSecrets, tested
//      directly (no DOM / Electron / network).
//   2. renderer/renderer.js — the browser mirror is not require()-able, so it
//      is proven byte-identical to the lib helper and carries the sync note.
//   3. Source-scan proving BOTH slackFlushTick and slackOnFinished apply
//      redactSecrets AFTER cleanTerminalOutput, and that sendSlackComposer does
//      NOT redact.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { redactSecrets } = require('../lib/slack-proxy');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const LIB = path.join(__dirname, '..', 'lib', 'slack-proxy.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');
const libSrc = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} present`);
  const from = src.slice(start);
  const end = from.indexOf('\n}\n');
  return from.slice(0, end === -1 ? from.length : end);
}

const R = '***REDACTED***';

// ===========================================================================
// PART 1 — Unit: each secret shape is masked
// ===========================================================================

test('redactSecrets: sk-… OpenAI-style key is masked', () => {
  const out = redactSecrets('using key sk-abcdEFGH1234ijklMNOP5678qrst here');
  assert.match(out, /using key \*\*\*REDACTED\*\*\* here/);
  assert.ok(!out.includes('sk-abcd'), 'the sk- token is gone');
});

test('redactSecrets: xoxb-/xoxp- Slack tokens are masked', () => {
  const b = redactSecrets('token xoxb-1234567890-abcdefghij done');
  const p = redactSecrets('token xoxp-0987654321-zyxwvutsrq done');
  assert.match(b, /token \*\*\*REDACTED\*\*\* done/);
  assert.match(p, /token \*\*\*REDACTED\*\*\* done/);
  assert.ok(!b.includes('xoxb-') && !p.includes('xoxp-'));
});

test('redactSecrets: ghp_ GitHub token is masked', () => {
  const out = redactSecrets('remote ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ok');
  assert.match(out, /remote \*\*\*REDACTED\*\*\* ok/);
  assert.ok(!out.includes('ghp_'));
});

test('redactSecrets: AKIA… AWS access key id is masked', () => {
  const out = redactSecrets('aws AKIAIOSFODNN7EXAMPLE end');
  assert.match(out, /aws \*\*\*REDACTED\*\*\* end/);
  assert.ok(!out.includes('AKIA'));
});

test('redactSecrets: long hex blob (>=32) is masked', () => {
  const hex = 'a'.repeat(40);
  const out = redactSecrets('digest ' + hex + ' tail');
  assert.match(out, /digest \*\*\*REDACTED\*\*\* tail/);
  // A short hex run (below threshold) is left alone.
  assert.equal(redactSecrets('deadbeef'), 'deadbeef');
});

test('redactSecrets: long base64 blob (>=40) is masked', () => {
  // 49-char continuous base64 run: includes letters beyond a-f so it is NOT a
  // hex blob, and no '=' padding mid-string that would break the run.
  const b64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP+012345';
  const out = redactSecrets('blob ' + b64 + ' tail');
  assert.match(out, /blob \*\*\*REDACTED\*\*\* tail/);
  assert.ok(!out.includes(b64), 'the base64 blob is masked');
});

test('redactSecrets: KEY=VALUE / KEY: VALUE with a secret key name masks the value, keeps the key', () => {
  assert.equal(redactSecrets('API_KEY=supersecretvalue'), 'API_KEY=' + R);
  assert.equal(redactSecrets('access_token: abc123def'), 'access_token: ' + R);
  assert.equal(redactSecrets('DB_PASSWORD="hunter2!"'), 'DB_PASSWORD=' + R);
  assert.equal(redactSecrets('apikey=zzz'), 'apikey=' + R);
  assert.equal(redactSecrets('client_secret = xyz'), 'client_secret = ' + R);
  // A non-secret key name is NOT touched.
  assert.equal(redactSecrets('name=Steve'), 'name=Steve');
  assert.equal(redactSecrets('count: 42'), 'count: 42');
});

test('redactSecrets: Bearer <token> masks the credential, keeps the scheme word', () => {
  const out = redactSecrets('Authorization: Bearer abc123DEF456ghi789');
  assert.match(out, /Bearer \*\*\*REDACTED\*\*\*/);
  assert.ok(!out.includes('abc123DEF456ghi789'));
  // The word "Bearer" on its own (no token) is not mangled into a placeholder.
  assert.equal(redactSecrets('the bearer of bad news'), 'the bearer of bad news');
});

// ===========================================================================
// PART 1b — Unit: inline connection-string credentials (TASK-068)
// scheme://user:password@host — mask ONLY the password, keep scheme/user/host.
// ===========================================================================

test('redactSecrets: connection-string password is masked for each scheme, host readable', () => {
  assert.equal(
    redactSecrets('postgres://user:s3cr3tPass@db:5432/app'),
    'postgres://user:' + R + '@db:5432/app'
  );
  assert.equal(
    redactSecrets('mysql://root:hunter2@127.0.0.1:3306/shop'),
    'mysql://root:' + R + '@127.0.0.1:3306/shop'
  );
  assert.equal(
    redactSecrets('mongodb://admin:p%40ss@cluster.example.net/db'),
    'mongodb://admin:' + R + '@cluster.example.net/db'
  );
  assert.equal(
    redactSecrets('amqp://guest:guestpw@rabbit:5672'),
    'amqp://guest:' + R + '@rabbit:5672'
  );
});

test('redactSecrets: password-only connection form scheme://:pass@host is masked', () => {
  assert.equal(
    redactSecrets('redis://:s3cr3t@cache:6379/0'),
    'redis://:' + R + '@cache:6379/0'
  );
});

test('redactSecrets: credential-free URLs are left completely unchanged', () => {
  // No user:pass@ authority → nothing to mask.
  assert.equal(redactSecrets('https://example.com/path'), 'https://example.com/path');
  // host:port with no '@' is NOT a credential and must stay intact.
  assert.equal(redactSecrets('http://host:8080/path'), 'http://host:8080/path');
  assert.equal(redactSecrets('postgres://db:5432/app'), 'postgres://db:5432/app');
  assert.equal(
    redactSecrets('See the docs at https://example.com/a:b for details'),
    'See the docs at https://example.com/a:b for details'
  );
});

test('redactSecrets: connection-string masking is null/empty/non-string safe', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
});

// ===========================================================================
// PART 1c — Unit: the hex>=32 rule masks 40-char hex UNCONDITIONALLY (TASK-069
// reverted). A blanket "exempt bare 40-hex as a git SHA-1" rule was tried and
// reverted on security grounds: real secrets are also exactly 40 hex (legacy
// GitHub OAuth tokens, hex-encoded 160-bit keys), so exempting them would leak
// unlabeled secrets to Slack. Over-redaction (masking a bare git SHA) is the
// safe direction for a boundary that posts to an external destination.
// ===========================================================================

const SHA1 = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // 40 hex chars

test('redactSecrets: a bare 40-hex string is masked (no git-SHA exemption)', () => {
  assert.equal(SHA1.length, 40);
  assert.equal(redactSecrets(SHA1), R);
});

test('redactSecrets: a 40-hex value in commit / rev-parse style lines is masked', () => {
  assert.equal(redactSecrets('commit ' + SHA1), 'commit ' + R);
  assert.equal(redactSecrets('$ git rev-parse HEAD\n' + SHA1),
    '$ git rev-parse HEAD\n' + R);
});

test('redactSecrets: 32-64+ hex runs are all masked', () => {
  assert.equal(redactSecrets('digest ' + 'b'.repeat(64) + ' end'), 'digest ' + R + ' end');
  assert.equal(redactSecrets('c'.repeat(32)), R);
  assert.equal(redactSecrets('f'.repeat(41)), R);
});

test('redactSecrets: a SECRET=<hex> value is masked by the key rule too', () => {
  assert.equal(redactSecrets('SECRET=' + SHA1), 'SECRET=' + R);
  assert.equal(redactSecrets('api_token: ' + SHA1), 'api_token: ' + R);
});

// ===========================================================================
// PART 2 — Unit: ordinary text is left intact (no false-positive mangling)
// ===========================================================================

test('redactSecrets: ordinary prose is unchanged', () => {
  const prose = 'This is a normal sentence describing what Claude just did. It ran the tests and they all passed.';
  assert.equal(redactSecrets(prose), prose);
});

test('redactSecrets: ordinary code / paths / short tokens are unchanged', () => {
  const samples = [
    'function add(a, b) { return a + b; }',
    'const total = items.reduce((s, x) => s + x, 0);',
    'edited renderer/renderer.js and lib/slack-proxy.js',
    'commit 5d868d8 removed initial logs', // short hash, below hex threshold
    'The API key is stored elsewhere.', // "key" not in a KEY:VALUE shape
    'Status: OK',
  ];
  for (const s of samples) {
    assert.equal(redactSecrets(s), s, `unchanged: ${s}`);
  }
});

// ===========================================================================
// PART 3 — Unit: empty / null / non-string is safe (never throws)
// ===========================================================================

test('redactSecrets: empty / null / undefined / non-string → safe, never throws', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(12345), '');
  assert.equal(redactSecrets({}), '');
  assert.equal(redactSecrets([]), '');
});

test('redactSecrets: mixed secret + prose in one blob masks only the secrets', () => {
  const input = [
    'Deploying now.',
    'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdefghijklmnop',
    'Using Bearer sk-liveXXXXXXXXXXXXXXXXXXXX for the call.',
    'All good.',
  ].join('\n');
  const out = redactSecrets(input);
  assert.match(out, /Deploying now\./);
  assert.match(out, /All good\./);
  assert.ok(!out.includes('wJalrXUtnFEMI'), 'the secret value is masked');
  assert.ok(!out.includes('sk-live'), 'the sk- token is masked');
});

// ===========================================================================
// PART 4 — lib export + renderer mirror byte-identity
// ===========================================================================

test('lib/slack-proxy.js exports redactSecrets and stays pure (no require/import)', () => {
  assert.match(libSrc, /module\.exports\s*=\s*\{[^}]*\bredactSecrets\b[^}]*\}/);
  assert.ok(!/\brequire\s*\(/.test(libSrc), 'lib requires nothing');
  assert.ok(!/\bimport\s/.test(libSrc), 'lib imports nothing');
});

test('renderer mirror redactSecrets is byte-identical to the lib helper and carries the sync note', () => {
  const libFn = fnBody(libSrc, 'function redactSecrets(text)');
  const rendererFn = fnBody(rendererSrc, 'function redactSecrets(text)');
  assert.equal(rendererFn, libFn, 'renderer mirror must match lib verbatim');
  // The "Mirrors … in lib/slack-proxy.js; keep in sync" note precedes the mirror.
  const idx = rendererSrc.indexOf('function redactSecrets(text)');
  const preamble = rendererSrc.slice(idx - 400, idx);
  assert.match(preamble, /Mirrors redactSecrets in lib\/slack-proxy\.js; keep in sync/);
});

// ===========================================================================
// PART 5 — Source-scan: BOTH auto-post paths redact as the LAST transform, and
// the user-composed path is NOT redacted. TASK-071 inserted the mechanical
// readability pass humanizeSlackOutput BETWEEN cleanTerminalOutput and
// redactSecrets, so the shipped pipeline is now
//   redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)))
// — redactSecrets stays OUTERMOST (last before postToSlack), preserving the
// TASK-063 "no auto-post path ever posts un-redacted output" guarantee.
// ===========================================================================

const POST_PIPELINE = /redactSecrets\(humanizeSlackOutput\(cleanTerminalOutput\(s\.captureBuffer\)\)\)/;

test('slackFlushTick redacts LAST (outermost) on the post path', () => {
  const body = fnBody(rendererSrc, 'async function slackFlushTick(tab)');
  // Redaction wraps the humanized+cleaned output before it is assigned to `text`.
  assert.match(body, POST_PIPELINE);
  // The redacted `text` is what gets posted (once-and-only-once preserved).
  assert.match(body, /await\s+postToSlack\(tab,\s*text,\s*s\.threadTs\)/);
});

test('slackOnFinished redacts LAST (outermost) on the post path', () => {
  const body = fnBody(rendererSrc, 'function slackOnFinished(tab)');
  assert.match(body, POST_PIPELINE);
  assert.match(body, /postToSlack\(tab,\s*reply,\s*s\.threadTs\)/);
});

test('EVERY auto-post path routes cleaned output through redactSecrets last (no bypass)', () => {
  // Guard against a future third auto-post path: every place that cleans the
  // capture buffer for posting must wrap it in redactSecrets as the outermost
  // (last) transform, with humanizeSlackOutput nested inside.
  const cleanUses = [...rendererSrc.matchAll(/cleanTerminalOutput\(s\.captureBuffer\)/g)];
  const redactedUses = [...rendererSrc.matchAll(/redactSecrets\(humanizeSlackOutput\(cleanTerminalOutput\(s\.captureBuffer\)\)\)/g)];
  assert.ok(cleanUses.length >= 2, 'both auto-post paths clean the capture buffer');
  assert.equal(redactedUses.length, cleanUses.length,
    'every cleanTerminalOutput(s.captureBuffer) on a post path is wrapped in redactSecrets(humanizeSlackOutput(...))');
});

test('sendSlackComposer (user-composed) is NOT redacted — scope is auto terminal output only', () => {
  const body = fnBody(rendererSrc, 'function sendSlackComposer(tab)');
  assert.ok(!/redactSecrets/.test(body), 'user-composed messages are posted as typed');
  // It still posts the composer text verbatim into the anchor thread.
  assert.match(body, /postToSlack\(tab,\s*text,\s*s\.threadTs\)/);
});
