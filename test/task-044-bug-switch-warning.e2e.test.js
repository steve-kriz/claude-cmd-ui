'use strict';

// ===========================================================================
// TASK-044 — DRIFT GUARD tying renderer/renderer.js's inline bug-switch-warning
// mirror to the canonical lib/bug-switch-warning.js. renderer.js is a browser
// script and cannot be `require`d under `node --test`, so the executable
// behaviour is unit-tested against the lib module (test/task-044-bug-switch-
// warning.test.js); THIS suite guarantees the renderer's inline MIRROR stays
// byte-for-byte behaviour-identical to that lib source — the established
// lib-canonical + renderer-mirror convention (cf. lib/modal-actions.js /
// test/task-034-routing-drift-guard.test.js).
//
// Each predicate is pure over SOURCE TEXT (readFileSync). The "true" cases read
// the ACTUAL sources; every "false" case string-replaces a real substring so a
// rotted marker cannot yield a silent pass. No DOM, no jsdom, no dependency.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(REPO, 'lib', 'bug-switch-warning.js'), 'utf8');

// Slice the renderer's inline mirror block (from its banner comment to the
// New-ticket modal that follows it) so guards target the mirror, not unrelated
// look-alike code elsewhere in the file.
function rendererMirrorRegion(src) {
  const start = src.indexOf('// Browser-side mirror of lib/bug-switch-warning.js');
  if (start === -1) return '';
  const end = src.indexOf('// New-ticket modal.', start);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

// The decision helper's cross-target filter, present in BOTH sources.
function decisionMirrored(rSrc, lSrc) {
  const line = 'if (originalId !== selectedOriginalId) out.push(originalId);';
  return rSrc.includes(line) && lSrc.includes(line);
}

// The at-most-one-listener guard: detach the prior handler FIRST, then bind one.
function lifecycleMirrored(rSrc, lSrc) {
  const region = rendererMirrorRegion(rSrc);
  const detachPrev = "el.removeEventListener('change', prev);";
  const bindOne = "el.addEventListener('change', handler);";
  const clearBookkeeping = 'el._bugSwitchWarnHandler = null;';
  const rendererOk = region.includes('const prev = el._bugSwitchWarnHandler;')
    && region.includes(detachPrev)
    && region.includes(bindOne)
    && region.includes(clearBookkeeping);
  const libOk = lSrc.includes(detachPrev) && lSrc.includes(bindOne) && lSrc.includes(clearBookkeeping);
  return rendererOk && libOk;
}

// The safe text write: textContent, and NOWHERE in the mirror/lib an innerHTML
// ASSIGNMENT (the word may appear in prose comments — only an `innerHTML =`
// write is a security regression).
function textWriteIsSafe(rSrc, lSrc) {
  const region = rendererMirrorRegion(rSrc);
  const write = "el.textContent = text == null ? '' : String(text);";
  const rendererOk = region.includes(write) && !/innerHTML\s*=/.test(region);
  const libOk = lSrc.includes(write) && !/innerHTML\s*=/.test(lSrc);
  return rendererOk && libOk;
}

// The renderer actually CALLS the mirror helpers where the behaviour lives.
function rendererCallsMirror(src) {
  const usesDecision = src.includes('staleBugSwitchTargets(selected, Array.from(bugFoldedTargets, foldKeyOriginal))');
  const usesWrite = /writeBugWarnText\(bugWarnEl,/.test(src);
  const usesAttach = src.includes('attachBugSwitchWarning(bugOfSelect, updateBugSwitchWarning)');
  return usesDecision && usesWrite && usesAttach;
}

// The lib actually EXPORTS the mirrored API.
function libExportsApi(src) {
  return /module\.exports\s*=\s*\{[\s\S]*staleBugSwitchTargets[\s\S]*shouldWarnBugSwitch[\s\S]*attachBugSwitchWarning[\s\S]*writeBugWarnText[\s\S]*\}/.test(src);
}

function mutate(src, from, to) {
  assert.ok(src.includes(from), `precondition: source must contain ${JSON.stringify(from)}`);
  const out = src.replace(from, to);
  assert.notEqual(out, src, 'mutation must change the source');
  return out;
}

// ---------------------------------------------------------------------------
// TRUE on the real sources
// ---------------------------------------------------------------------------
test('drift: decision filter is mirrored in BOTH renderer and lib', () => {
  assert.equal(decisionMirrored(rendererSrc, libSrc), true);
});

test('drift: at-most-one-listener lifecycle is mirrored in BOTH renderer and lib', () => {
  assert.equal(lifecycleMirrored(rendererSrc, libSrc), true);
});

test('drift: the warning text write uses textContent (never innerHTML) in BOTH', () => {
  assert.equal(textWriteIsSafe(rendererSrc, libSrc), true);
});

test('drift: renderer CALLS the mirror helpers where the behaviour lives', () => {
  assert.equal(rendererCallsMirror(rendererSrc), true);
});

test('drift: lib exports the mirrored API', () => {
  assert.equal(libExportsApi(libSrc), true);
});

// ---------------------------------------------------------------------------
// FALSE when a tracked behaviour diverges (guard is non-tautological)
// ---------------------------------------------------------------------------
test('drift: FALSE if the lib decision filter is inverted (renderer keeps the correct one)', () => {
  const mutatedLib = mutate(
    libSrc,
    'if (originalId !== selectedOriginalId) out.push(originalId);',
    'if (originalId === selectedOriginalId) out.push(originalId);',
  );
  assert.equal(decisionMirrored(rendererSrc, mutatedLib), false);
});

test('drift: FALSE if the renderer stops detaching the prior listener (accumulation reintroduced)', () => {
  const mutated = mutate(
    rendererSrc,
    "el.removeEventListener('change', prev);",
    "/* no detach */;",
  );
  assert.equal(lifecycleMirrored(mutated, libSrc), false);
});

test('drift: FALSE if the renderer never clears the handler bookkeeping on dispose', () => {
  const mutated = rendererSrc.replace('el._bugSwitchWarnHandler = null;', '/* leak */;');
  assert.notEqual(mutated, rendererSrc);
  assert.equal(lifecycleMirrored(mutated, libSrc), false);
});

test('drift: FALSE if the renderer switches the warning write to innerHTML (injection risk)', () => {
  const mutated = mutate(
    rendererSrc,
    "el.textContent = text == null ? '' : String(text);",
    "el.innerHTML = text == null ? '' : String(text);",
  );
  assert.equal(textWriteIsSafe(mutated, libSrc), false);
});

test('drift: FALSE if the lib switches the warning write to innerHTML', () => {
  const mutated = mutate(
    libSrc,
    "el.textContent = text == null ? '' : String(text);",
    "el.innerHTML = text == null ? '' : String(text);",
  );
  assert.equal(textWriteIsSafe(rendererSrc, mutated), false);
});

test('drift: FALSE if the renderer stops calling the decision helper', () => {
  const mutated = mutate(
    rendererSrc,
    'staleBugSwitchTargets(selected, Array.from(bugFoldedTargets, foldKeyOriginal))',
    '[]',
  );
  assert.equal(rendererCallsMirror(mutated), false);
});

test('drift: FALSE if the renderer stops wiring the persistent listener via the helper', () => {
  const mutated = mutate(
    rendererSrc,
    'attachBugSwitchWarning(bugOfSelect, updateBugSwitchWarning)',
    'null',
  );
  assert.equal(rendererCallsMirror(mutated), false);
});

// ---------------------------------------------------------------------------
// Cross-check: all fidelity predicates hold together on the untouched sources.
// ---------------------------------------------------------------------------
test('drift: all mirror predicates pass together on the real, untouched sources', () => {
  assert.equal(decisionMirrored(rendererSrc, libSrc), true);
  assert.equal(lifecycleMirrored(rendererSrc, libSrc), true);
  assert.equal(textWriteIsSafe(rendererSrc, libSrc), true);
  assert.equal(rendererCallsMirror(rendererSrc), true);
  assert.equal(libExportsApi(libSrc), true);
});
