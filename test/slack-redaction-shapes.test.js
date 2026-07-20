'use strict';

// Unit tests for TASK-067: extend redactSecrets to cover more token shapes.
//
// TASK-063 shipped redactSecrets(text) in lib/slack-proxy.js (byte-mirrored in
// renderer/renderer.js) covering secret KEY=VALUE, Bearer, sk-, xox[baprs]-,
// gh[pousr]_, AKIA/ASIA, long hex(>=32)/base64(>=40). TASK-067 augments it with:
//
//   - Slack:  xapp-, xoxe-, xoxd- (broadened alongside the existing xox[baprs]-)
//   - Prefix: glpat-, github_pat_, npm_, dop_v1_, AIza…, SG.<id>.<secret>
//   - Bare JWTs: eyJ<b64url>.<b64url>.<b64url>
//
// These are direct unit tests of the SHIPPED pure helper (source of truth). The
// renderer mirror is proven byte-identical in test/slack-redaction.test.js, so
// exercising the lib helper here also covers the renderer path. Rules must stay
// CONSERVATIVE — the false-positive guards below assert ordinary prose/code is
// left untouched. No DOM / Electron / network.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { redactSecrets } = require('../lib/slack-proxy');

const R = '***REDACTED***';

// ===========================================================================
// PART 1 — Each NEW token shape is masked (surrounding prose kept intact)
// ===========================================================================

test('redactSecrets: Slack xapp- app-level token is masked', () => {
  const t = 'set xapp-1-A012345678-1234567890123-abcdefabcdefabcdef done';
  const out = redactSecrets(t);
  assert.match(out, /set \*\*\*REDACTED\*\*\* done/);
  assert.ok(!out.includes('xapp-'), 'no xapp- prefix leaks');
});

test('redactSecrets: Slack xoxe-/xoxd- tokens are masked', () => {
  const e = redactSecrets('refresh xoxe-1-abcdefghij1234567890 done');
  const d = redactSecrets('cookie xoxd-abcdefghij1234567890ABCD done');
  assert.match(e, /refresh \*\*\*REDACTED\*\*\* done/);
  assert.match(d, /cookie \*\*\*REDACTED\*\*\* done/);
  assert.ok(!e.includes('xoxe-') && !d.includes('xoxd-'));
});

test('redactSecrets: existing xoxb-/xoxp- Slack tokens still masked (no regression)', () => {
  const b = redactSecrets('token xoxb-1234567890-abcdefghij done');
  const p = redactSecrets('token xoxp-0987654321-zyxwvutsrq done');
  assert.match(b, /token \*\*\*REDACTED\*\*\* done/);
  assert.match(p, /token \*\*\*REDACTED\*\*\* done/);
});

test('redactSecrets: GitLab glpat- token is masked', () => {
  const out = redactSecrets('gitlab glpat-ABCDEFghij1234567890xy ok');
  assert.match(out, /gitlab \*\*\*REDACTED\*\*\* ok/);
  assert.ok(!out.includes('glpat-'));
});

test('redactSecrets: GitHub fine-grained PAT github_pat_ is masked', () => {
  const tok = 'github_pat_11ABCDEFG0abcdefghij1234567890ABCDEFghijklmnop';
  const out = redactSecrets('remote ' + tok + ' fetched');
  assert.match(out, /remote \*\*\*REDACTED\*\*\* fetched/);
  assert.ok(!out.includes('github_pat_'));
});

test('redactSecrets: npm access token npm_ is masked', () => {
  const tok = 'npm_' + 'a'.repeat(36);
  const out = redactSecrets('npm auth ' + tok + ' saved');
  assert.match(out, /npm auth \*\*\*REDACTED\*\*\* saved/);
  assert.ok(!out.includes(tok));
});

test('redactSecrets: DigitalOcean dop_v1_ token is masked', () => {
  const tok = 'dop_v1_' + 'a'.repeat(64);
  const out = redactSecrets('do token ' + tok + ' set');
  assert.match(out, /do token \*\*\*REDACTED\*\*\* set/);
  assert.ok(!out.includes(tok));
});

test('redactSecrets: Google API key AIza… is masked', () => {
  const tok = 'AIzaSyA1234567890abcdefghijKLMNOPQRSTU';
  const out = redactSecrets('gmaps ' + tok + ' loaded');
  assert.match(out, /gmaps \*\*\*REDACTED\*\*\* loaded/);
  assert.ok(!out.includes('AIza'));
});

test('redactSecrets: SendGrid SG.<id>.<secret> key is masked', () => {
  const tok = 'SG.abcdefghijklmnopqrst.abcdefghijklmnopqrstuvwxyz1234567890AB';
  const out = redactSecrets('sendgrid ' + tok + ' verified');
  assert.match(out, /sendgrid \*\*\*REDACTED\*\*\* verified/);
  assert.ok(!out.includes('SG.abcdef'));
});

test('redactSecrets: a bare JWT (eyJ…​.…​.…) is masked', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
    '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0' +
    '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const out = redactSecrets('id_token=' + jwt + ' cached');
  assert.ok(!out.includes(jwt), 'the full JWT is masked');
  assert.ok(!out.includes('eyJ'), 'no JWT header fragment leaks');
  assert.match(out, /\*\*\*REDACTED\*\*\* cached/);
});

test('redactSecrets: a base64url JWT with - and _ in segments is masked', () => {
  // Explicitly exercise URL-safe chars (-/_) that base64 (+//) rules miss.
  const jwt = 'eyJhbG-ciOiJ_IUzI1NiJ9.eyJzdWItIjoiYWJjX-ZGVmIn0.sig_nature-part_1234ABC';
  const out = redactSecrets('bearer-less token ' + jwt + ' here');
  assert.ok(!out.includes(jwt), 'base64url JWT masked whole');
  assert.match(out, /\*\*\*REDACTED\*\*\* here/);
});

// ===========================================================================
// PART 2 — False-positive guards: the new rules must NOT mask ordinary text
// ===========================================================================

test('redactSecrets: a sentence starting "SG." mid-text is NOT masked', () => {
  const samples = [
    'SG. Something went wrong during the build.',
    'See SG. for details in the report.',
    'MSG.length is 12 here.', // no leading word boundary before SG
  ];
  for (const s of samples) assert.equal(redactSecrets(s), s, `unchanged: ${s}`);
});

test('redactSecrets: the word "npm" and npm commands are NOT masked', () => {
  const samples = [
    'run npm install to fetch deps',
    'npm run build finished cleanly',
    'the npm_config_cache path was empty', // npm_ but short / not a token
    'npm ERR! code E404',
  ];
  for (const s of samples) assert.equal(redactSecrets(s), s, `unchanged: ${s}`);
});

test('redactSecrets: short base64/glpat/AIza-ish words below threshold survive', () => {
  const samples = [
    'AIza is a prefix', // "AIza" alone, no 20-char tail
    'glpat- was mentioned', // no token tail
    'the dop_v1_ scheme', // no 40-char tail
    'github_pat is discussed', // no _ token tail
    'a normal base64 image blob: iVBORw0KGgo=', // 12 chars, well under 40
  ];
  for (const s of samples) assert.equal(redactSecrets(s), s, `unchanged: ${s}`);
});

test('redactSecrets: prose containing "eyJ" without a 3-part dotted JWT is NOT masked', () => {
  const samples = [
    'eyJson is not a real word',
    'the token eyJabc.def only has two segments', // 2 segments -> not a JWT
  ];
  // Two-segment case: no third dotted segment, so the JWT rule must not fire.
  assert.equal(redactSecrets(samples[0]), samples[0]);
  const two = redactSecrets(samples[1]);
  assert.ok(!two.includes(R), 'a 2-segment eyJ… string is not treated as a JWT');
});

test('redactSecrets: ordinary prose/code with new rules present is unchanged', () => {
  const prose = 'Deployed the app. Google Maps and SendGrid integrations are configured via env vars.';
  const code = 'const npmVersion = require("npm").version; // AIza-style keys live in .env';
  assert.equal(redactSecrets(prose), prose);
  assert.equal(redactSecrets(code), code);
});

// ===========================================================================
// PART 3 — Safety: empty / null / undefined / non-string never throws
// ===========================================================================

test('redactSecrets (TASK-067): null / empty / non-string is safe', () => {
  for (const v of ['', null, undefined, 0, 123, {}, [], true]) {
    assert.doesNotThrow(() => redactSecrets(v));
    assert.equal(typeof redactSecrets(v), 'string');
  }
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
});

// ===========================================================================
// PART 4 — Mixed blob: new + old shapes together, only secrets masked
// ===========================================================================

test('redactSecrets: mixed new-shape secrets + prose masks only the secrets', () => {
  const input = [
    'Rotating credentials now.',
    'export GITLAB_TOKEN=glpat-ABCDEFghij1234567890xy',
    'gh_pat github_pat_11ABCDEFG0abcdefghij1234567890ABCDEFghij',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def-123XYZ',
    'All rotated.',
  ].join('\n');
  const out = redactSecrets(input);
  assert.match(out, /Rotating credentials now\./);
  assert.match(out, /All rotated\./);
  assert.ok(!out.includes('glpat-ABCDEF'), 'glpat masked');
  assert.ok(!out.includes('github_pat_11'), 'github_pat masked');
  assert.ok(!out.includes('eyJhbG'), 'jwt masked');
});

// ===========================================================================
// PART 5 — Linear / non-catastrophic on adversarial input (must complete fast)
// ===========================================================================

test('redactSecrets: adversarial repetitive input completes quickly (no catastrophic backtracking)', () => {
  const adversarial = [
    'eyJ' + 'A'.repeat(5000),            // JWT prefix w/o the two dots
    'SG.' + 'a'.repeat(5000),            // SG prefix w/o the second dot
    'x'.repeat(5000) + '-' + 'y'.repeat(5000),
    'npm_' + '1'.repeat(5000),
  ].join(' ');
  const start = Date.now();
  const out = redactSecrets(adversarial);
  const elapsed = Date.now() - start;
  assert.equal(typeof out, 'string');
  assert.ok(elapsed < 1000, `redaction stayed linear (${elapsed}ms)`);
});
