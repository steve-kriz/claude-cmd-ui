'use strict';

// Round-trip tests for lib/env-store.js against a REAL temp .env file (created
// in the OS temp dir, removed afterward). This is the persistence layer the
// OAuth flow uses to save SLACK_TOKEN and the SLACK_CLIENT_ID/SECRET creds, so
// proving set -> file -> get here is what backs the ticket's "token is saved to
// SLACK_TOKEN" / "subsequent calls use the newly saved token" claims.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const envStore = require('../lib/env-store');

let tmpDir;
let tmpEnv;
const savedEnv = {};
const TRACKED = ['SLACK_TOKEN', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-oauth-test-'));
  tmpEnv = path.join(tmpDir, '.env');
  envStore.setEnvPath(tmpEnv);
  // Isolate process.env for the keys we touch so tests don't leak into each
  // other (env-store mirrors writes into process.env).
  for (const k of TRACKED) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TRACKED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

test('setEnvPath / getEnvPath point at the temp file', () => {
  assert.equal(envStore.getEnvPath(), tmpEnv);
});

test('set writes SLACK_TOKEN to the .env file and get reads it back', async () => {
  await envStore.set('SLACK_TOKEN', 'xoxp-user-token-abc');
  // Physically on disk
  const onDisk = fs.readFileSync(tmpEnv, 'utf8');
  assert.match(onDisk, /^SLACK_TOKEN=xoxp-user-token-abc$/m);
  // Readable via get (reflects process.env, which set() also updates)
  assert.equal(envStore.get('SLACK_TOKEN'), 'xoxp-user-token-abc');
  // Readable via readAll (re-parses the file)
  const all = await envStore.readAll();
  assert.equal(all.SLACK_TOKEN, 'xoxp-user-token-abc');
});

test('set overwrites an existing SLACK_TOKEN in place (no duplicate line)', async () => {
  await envStore.set('SLACK_TOKEN', 'first-token');
  await envStore.set('SLACK_TOKEN', 'second-token');
  const onDisk = fs.readFileSync(tmpEnv, 'utf8');
  const occurrences = onDisk.split(/\r?\n/).filter((l) => l.startsWith('SLACK_TOKEN=')).length;
  assert.equal(occurrences, 1, 'only one SLACK_TOKEN line should remain');
  assert.equal(envStore.get('SLACK_TOKEN'), 'second-token');
});

test('client id + secret persist alongside the token', async () => {
  await envStore.set('SLACK_CLIENT_ID', '123.456');
  await envStore.set('SLACK_CLIENT_SECRET', 'sh_secret');
  await envStore.set('SLACK_TOKEN', 'xoxp-abc');
  const all = await envStore.readAll();
  assert.equal(all.SLACK_CLIENT_ID, '123.456');
  assert.equal(all.SLACK_CLIENT_SECRET, 'sh_secret');
  assert.equal(all.SLACK_TOKEN, 'xoxp-abc');
});

test('get returns empty string (not undefined) for an unset key', () => {
  assert.equal(envStore.get('SLACK_TOKEN'), '');
});

test('a value with spaces round-trips exactly (quoting path)', async () => {
  const spaced = 'has spaces and stuff';
  await envStore.set('SLACK_TOKEN', spaced);
  const all = await envStore.readAll();
  assert.equal(all.SLACK_TOKEN, spaced);
});

// KNOWN env-store bug (out of scope for TASK-001): set() escapes an embedded
// double-quote as \" when writing, but parse() never un-escapes it, so values
// containing " do NOT round-trip. Pinned here so the asymmetry is documented and
// a regression (or a fix) is visible. Slack tokens (xoxp-…) contain no quotes,
// so this does not affect the OAuth flow.
test('KNOWN BUG: embedded double-quotes are not un-escaped on read', async () => {
  await envStore.set('SLACK_TOKEN', 'a"b');
  const all = await envStore.readAll();
  assert.equal(all.SLACK_TOKEN, 'a\\"b'); // current (buggy) behavior: backslash leaks through
});

test('set rejects an invalid key name', async () => {
  await assert.rejects(() => envStore.set('bad key!', 'x'), /Invalid \.env key/);
});
