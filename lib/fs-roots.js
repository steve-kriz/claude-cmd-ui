'use strict';

// Project-root confinement for the main-process fs:* IPC handlers (TASK-126,
// review follow-up of TASK-035). The four mutating/probing handlers
// (fs:writeFile, fs:rename, fs:mkdir, fs:exists) used to hand ANY absolute path
// straight to fs.promises. All path safety lived in the renderer (isSafeTasksSlug,
// agent-name checks, normalizeTasksColumns) — the wrong side of the trust
// boundary. This module moves enforcement to the sink: a path is allowed only if
// it canonicalizes to inside an approved project root.
//
// Like lib/keep-awake.js and lib/assets-mirror.js this module requires NOTHING
// from Electron, so it can be unit-tested with plain `node --test`. It does use
// the Node core `fs`/`path` modules (realpath is inherently a filesystem probe),
// but every fs touch is injectable (see canonicalize opts) so containment can be
// tested with no disk at all, and the compare half (isInsideRoots) is a pure
// string function whose platform is a parameter so tests can force win32
// case-insensitive comparison on any host.
//
// The approved-roots registry is a main-process in-memory Set. main.js SEEDS it
// at startup from readSession() (session.json is main's own file under userData)
// and EXTENDS it on each successful dialog:pickFolder — the only ways a folder
// enters the app. session:save deliberately does NOT mint roots: a compromised
// renderer must not be able to add its own root live. Residual (documented, not
// solved here): session.json is renderer-persisted, so a fully-compromised
// renderer could persist a bogus root for the NEXT launch; the in-scope threat
// (crafted config/slug strings, not arbitrary renderer JS) is still fully
// mitigated. Symlink TOCTOU is a further documented residual — realpath resolves
// only the deepest EXISTING ancestor because write/mkdir targets may not exist
// yet.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// The main-process approved-root registry. Entries are canonicalized absolute
// paths (path.resolve + realpath of the deepest existing ancestor) so containment
// comparison is a cheap string test. Empty registry ⇒ every path is rejected.
const projectRoots = new Set();

// Platform-appropriate separator. Parameterized (not path.sep) so a test on a
// posix host can reason about win32 paths and vice-versa.
function sepFor(platform) {
  return platform === 'win32' ? '\\' : '/';
}

// Normalize a path for comparison on the given platform: win32 filesystems are
// case-insensitive for drive letters and folder names, so fold case there; never
// fold on darwin/linux (case-sensitive semantics). Callers pass already-resolved
// absolute paths, so separators are already consistent for that platform.
function normForCompare(p, platform) {
  const s = String(p);
  return platform === 'win32' ? s.toLowerCase() : s;
}

// Pure containment test: is `candidate` equal to `root` or nested beneath it?
// Prefix-collision-safe — `C:\work\proj2` is NOT inside root `C:\work\proj`
// because we require an exact match OR a `root + sep` prefix. Both inputs must
// already be canonical absolute paths for `platform`.
function isInsideRoot(root, candidate, platform) {
  const sep = sepFor(platform);
  const r = normForCompare(root, platform);
  const c = normForCompare(candidate, platform);
  // Trim a single trailing separator from the root (e.g. a drive root `C:\`) so
  // the `+ sep` prefix test below is unambiguous.
  const rTrim = r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
  if (c === rTrim) return true;
  return c.startsWith(rTrim + sep);
}

// Pure containment against a set/array of roots. Returns true iff `candidate`
// lands inside at least one root. Empty/absent roots ⇒ false (reject all).
// `candidate` and every root must already be canonical absolute paths.
function isInsideRoots(roots, candidate, platform) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const list = roots instanceof Set ? roots : Array.isArray(roots) ? roots : [];
  for (const root of list) {
    if (typeof root === 'string' && root && isInsideRoot(root, candidate, platform)) {
      return true;
    }
  }
  return false;
}

// Canonicalize an absolute-ish path: path.resolve() first (collapses `.`/`..` and
// normalizes mixed `/`\`\` separators), then realpath the deepest EXISTING
// ancestor (resolving symlinks, 8.3 short-names and UNC) and re-append the not-
// yet-existing tail (write/mkdir targets may not exist). If even the filesystem
// root cannot be realpath'd (e.g. an injected always-fail realpath) fall back to
// the resolved string. Never throws. `realpath`/`resolve` are injectable purely
// for unit tests; production uses fs.promises.realpath / path.resolve.
async function canonicalize(candidate, opts = {}) {
  const resolve = opts.resolve || path.resolve;
  const realpath = opts.realpath || fsp.realpath;
  const resolved = resolve(candidate);
  let current = resolved;
  const tail = [];
  // Walk up until an ancestor resolves, then rejoin the trailing segments.
  // Bounded by the filesystem root (dirname(root) === root).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = await realpath(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return resolved; // reached root, nothing realpath'd
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// Add one raw path to the registry as a canonical root. No-op on junk. Async
// because canonicalize realpaths the folder (roots are existing directories, so
// symlink/short-name normalization applies). `opts` is forwarded to canonicalize
// (test injection only).
async function addRoot(rawPath, opts) {
  if (typeof rawPath !== 'string' || !rawPath) return;
  const canon = await canonicalize(rawPath, opts);
  projectRoots.add(canon);
}

// Seed the registry from readSession() folders (entries are `{ path, agent }`
// objects or legacy bare strings). Tolerant of junk input.
async function seedRoots(folders, opts) {
  if (!Array.isArray(folders)) return;
  for (const f of folders) {
    const p = f && typeof f === 'object' ? f.path : f;
    await addRoot(p, opts);
  }
}

// Clear the registry (tests / re-seed).
function clearRoots() {
  projectRoots.clear();
}

// The guard main.js calls before every confined fsp op. Canonicalizes the
// candidate (resolve + realpath of deepest existing ancestor) and returns whether
// it lands inside an approved root. Empty registry ⇒ false (reject all).
// Non-string/empty candidate ⇒ false. Never throws — canonicalize swallows
// realpath errors — so callers keep returning the `{ok:false,error}` IPC shape.
async function isPathAllowed(candidate, opts = {}) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const roots = opts.roots || projectRoots;
  const size = roots instanceof Set ? roots.size : Array.isArray(roots) ? roots.length : 0;
  if (size === 0) return false;
  const platform = opts.platform || process.platform;
  let canon;
  try {
    canon = await canonicalize(candidate, opts);
  } catch (_) {
    return false;
  }
  return isInsideRoots(roots, canon, platform);
}

module.exports = {
  projectRoots,
  sepFor,
  isInsideRoot,
  isInsideRoots,
  canonicalize,
  addRoot,
  seedRoots,
  clearRoots,
  isPathAllowed,
};
