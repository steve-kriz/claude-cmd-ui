'use strict';

// Tiny .env reader/writer so the app can store secrets (AWS SSO start URL,
// Slack token, …) in a single file the user owns. No external dependency.
//
//   loadIntoProcessEnv()  read the file once at startup into process.env
//                         (without clobbering values already in the real env)
//   get(key)              current value (process.env, so reflects the file)
//   set(key, value)       persist a value to the .env file AND process.env
//   readAll()             parse the file into an object
//
// The path defaults to <cwd>/.env but main.js points it at the app root.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let envPath = path.join(process.cwd(), '.env');

function setEnvPath(p) {
  if (p) envPath = p;
}
function getEnvPath() {
  return envPath;
}

function parse(content) {
  const out = {};
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

// Read .env synchronously at boot and seed process.env. Real environment
// variables win over file values so you can still override on the command line.
function loadIntoProcessEnv() {
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); }
  catch (_) { return {}; }
  const vars = parse(content);
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
  return vars;
}

async function readAll() {
  try { return parse(await fsp.readFile(envPath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

function get(key) {
  const v = process.env[key];
  return v == null ? '' : String(v);
}

function needsQuote(v) {
  return v === '' || /[\s#"'=]/.test(v);
}

async function set(key, value) {
  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid .env key: ${key}`);
  }
  const val = value == null ? '' : String(value);
  const serialized = needsQuote(val)
    ? `${key}="${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : `${key}=${val}`;

  let content = '';
  try { content = await fsp.readFile(envPath, 'utf8'); } catch (_) { /* new file */ }
  const lines = content.split(/\r?\n/);
  const keyRe = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');

  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i])) { lines[i] = serialized; replaced = true; break; }
  }
  if (!replaced) {
    // Drop trailing blank lines, append the new pair, keep one trailing newline.
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(serialized);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';

  const tmp = envPath + '.tmp';
  await fsp.writeFile(tmp, out, 'utf8');
  await fsp.rename(tmp, envPath);
  process.env[key] = val;
  return { ok: true };
}

module.exports = { setEnvPath, getEnvPath, loadIntoProcessEnv, readAll, get, set };
