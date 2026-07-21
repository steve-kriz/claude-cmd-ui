'use strict';

// ===========================================================================
// TASK-094 — UNIT tests for the renderer's Agents-panel pure helpers:
//   parseAgentFileRenderer / serializeAgentDescription / agentDescriptionValid
// (renderer/renderer.js — a browser script that cannot be require()'d, so the
// functions are EXTRACTED headless by brace-matching the source text, the same
// convention test/task-093-assets-mirror.e2e.test.js uses).
//
// NO DATABASE / REAL DB CONNECTION / NETWORK / DISK-WRITE / ELECTRON is used.
// These helpers touch no I/O; inputs are in-memory strings. The four REAL bundled
// agent files (.claude/agents/*.md) are read ONLY as read-only fixtures for the
// byte-identical round-trip assertions — they are never modified.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const AGENTS_DIR = path.join(REPO, '.claude', 'agents');
const AGENT_FILES = ['ba.md', 'coder.md', 'tech-lead.md', 'tester.md'];

// --- Extract a named function declaration by brace-matching (from task-093). --
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// --- Extract a `const NAME = …;` declaration (single-line or bracketed). ------
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

// Load the REAL renderer helpers headless. These pure helpers reference no
// window/document, so no injection is required.
function loadHelpers() {
  const body = [
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
    extractFn(rendererSrc, 'resolveAgentBlockScalar'),
    extractFn(rendererSrc, 'formatAgentDescription'),
    extractFn(rendererSrc, 'parseAgentFileRenderer'),
    extractFn(rendererSrc, 'serializeAgentDescription'),
    extractFn(rendererSrc, 'agentDescriptionValid'),
    'return { parseAgentFileRenderer, serializeAgentDescription, agentDescriptionValid };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}
const { parseAgentFileRenderer, serializeAgentDescription, agentDescriptionValid } = loadHelpers();

// ===========================================================================
// Byte-identical unchanged round-trip on all four REAL bundled agent files.
// ===========================================================================
for (const file of AGENT_FILES) {
  test(`round-trip: serializeAgentDescription(parse, same description) is byte-identical for ${file}`, () => {
    const original = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const parsed = parseAgentFileRenderer(original);
    assert.ok(parsed, `${file} parses`);
    assert.ok(parsed.fm.description && parsed.fm.description.trim() !== '', `${file} has a description`);
    // Re-serialize with the UNCHANGED description → must equal the original bytes.
    const out = serializeAgentDescription(parsed, parsed.fm.description);
    assert.equal(out, original, `${file} round-trips byte-for-byte when description is unchanged`);
  });
}

// ===========================================================================
// Description-only change preserves name / model / tools (and every other key's
// RAW lines, plus the body).
// ===========================================================================
for (const file of AGENT_FILES) {
  test(`description-only change preserves name/model/tools/body for ${file}`, () => {
    const original = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const parsed = parseAgentFileRenderer(original);
    const NEW = 'A totally rewritten single-line description for the agent under test.';
    const out = serializeAgentDescription(parsed, NEW);
    assert.notEqual(out, original, 'the file text changed');

    const after = parseAgentFileRenderer(out);
    assert.ok(after, 'the rewritten file still parses');

    // Key order is unchanged (no keys added or removed).
    assert.deepEqual(after.meta.keyOrder, parsed.meta.keyOrder, 'key order preserved');

    // Every non-description key keeps its exact value AND its exact RAW lines.
    for (const key of parsed.meta.keyOrder) {
      if (key === 'description') continue;
      assert.equal(after.fm[key], parsed.fm[key], `${key} value preserved`);
      assert.deepEqual(after.meta.rawByKey[key], parsed.meta.rawByKey[key], `${key} raw lines byte-identical`);
    }
    // The description actually changed to the new value.
    assert.equal(after.fm.description, NEW, 'description updated to the new value');
    // Body + fences preserved.
    assert.equal(after.body, parsed.body, 'body preserved');
    assert.equal(after.meta.openFence, parsed.meta.openFence, 'open fence preserved');
    assert.equal(after.meta.closeFence, parsed.meta.closeFence, 'close fence preserved');
  });
}

// ===========================================================================
// INJECTION: a description containing a `\n---\n` fence and a `name: evil` line
// must NOT inject any new frontmatter — it must stay inside the folded block,
// every continuation line indented by 2 spaces.
// ===========================================================================
test('INJECTION: description with \\n---\\nname: evil produces NO new frontmatter keys and stays in the folded block', () => {
  const original = fs.readFileSync(path.join(AGENTS_DIR, 'ba.md'), 'utf8');
  const parsed = parseAgentFileRenderer(original);
  const MALICIOUS = 'Innocent lead-in.\n---\nname: evil\ntools: everything\nmodel: pwned';
  const out = serializeAgentDescription(parsed, MALICIOUS);

  const after = parseAgentFileRenderer(out);
  assert.ok(after, 'the file still parses after the injection attempt');

  // No new top-level keys: the key set is exactly the original.
  assert.deepEqual(after.meta.keyOrder, parsed.meta.keyOrder, 'no new frontmatter keys injected');

  // The real `name` is untouched — the injected `name: evil` did NOT take over.
  assert.equal(after.fm.name, 'orchestrate-ba', 'the agent name was not hijacked');
  assert.notEqual(after.fm.name, 'evil');

  // The injected tokens live INSIDE the folded description value.
  assert.match(after.fm.description, /name: evil/, 'injected name text is inside the description');
  assert.match(after.fm.description, /---/, 'injected fence text is inside the description');

  // Structurally: between the opening and closing fence there must be EXACTLY the
  // two real fence lines — no injected top-level `---` and no bare `name: evil`
  // at column 0. Every injected line is indented (2 spaces) inside the block.
  const eol = /\r\n/.test(out) ? '\r\n' : '\n';
  const lines = out.split(eol);
  const fenceIdxs = lines.map((l, i) => (/^---\s*$/.test(l) ? i : -1)).filter((i) => i !== -1);
  assert.equal(fenceIdxs.length, 2, 'only the two real frontmatter fences exist (no injected fence)');
  const fmLines = lines.slice(fenceIdxs[0] + 1, fenceIdxs[1]);
  assert.ok(!fmLines.some((l) => /^name:/.test(l) && !/^\s/.test(l) && l !== 'name: orchestrate-ba'),
    'no injected top-level name: key');
  // The injected content lines are all indented continuations.
  for (const needle of ['name: evil', 'tools: everything', 'model: pwned', '---']) {
    const line = fmLines.find((l) => l.includes(needle) && l.trim() === (needle === '---' ? '---' : needle));
    assert.ok(line !== undefined, `injected token "${needle}" appears in frontmatter`);
    assert.match(line, /^ {2}/, `injected token "${needle}" is a 2-space indented folded continuation`);
  }
});

// ===========================================================================
// agentDescriptionValid — trim-nonempty gate.
// ===========================================================================
test('agentDescriptionValid rejects empty / whitespace-only / non-string and accepts real text', () => {
  assert.equal(agentDescriptionValid(''), false, 'empty rejected');
  assert.equal(agentDescriptionValid('   '), false, 'spaces rejected');
  assert.equal(agentDescriptionValid('\n\t  \r\n'), false, 'whitespace-only rejected');
  assert.equal(agentDescriptionValid(null), false, 'null rejected');
  assert.equal(agentDescriptionValid(undefined), false, 'undefined rejected');
  assert.equal(agentDescriptionValid(123), false, 'non-string rejected');
  assert.equal(agentDescriptionValid('x'), true, 'single char accepted');
  assert.equal(agentDescriptionValid('  Real description.  '), true, 'padded real text accepted');
});

// ===========================================================================
// parseAgentFileRenderer — null on non-string / no-fence / unclosed input.
// ===========================================================================
test('parseAgentFileRenderer returns null for malformed / non-string input (never throws)', () => {
  assert.equal(parseAgentFileRenderer(null), null, 'null → null');
  assert.equal(parseAgentFileRenderer(undefined), null, 'undefined → null');
  assert.equal(parseAgentFileRenderer(123), null, 'number → null');
  assert.equal(parseAgentFileRenderer({}), null, 'object → null');
  assert.equal(parseAgentFileRenderer('no frontmatter here'), null, 'no opening fence → null');
  assert.equal(parseAgentFileRenderer('---\nname: x\nbody with no closing fence'), null, 'unclosed fence → null');
  assert.equal(parseAgentFileRenderer(''), null, 'empty string → null');
});

test('parseAgentFileRenderer parses a well-formed file into fm + body + meta', () => {
  const src = ['---', 'name: demo', 'description: >-', '  Hello world folded.', 'tools: Read', 'model: opus', '---', '', 'Body.', ''].join('\n');
  const parsed = parseAgentFileRenderer(src);
  assert.ok(parsed);
  assert.equal(parsed.fm.name, 'demo');
  assert.equal(parsed.fm.tools, 'Read');
  assert.equal(parsed.fm.model, 'opus');
  assert.equal(parsed.fm.description, 'Hello world folded.');
  assert.match(parsed.body, /Body\./);
  assert.deepEqual(parsed.meta.keyOrder, ['name', 'description', 'tools', 'model']);
});
