'use strict';

// ===========================================================================
// TASK-134 — UNIT / source-level drift guards.
//
// renderer.js is a browser script (no module.exports), so — like the existing
// "never innerHTML" drift guards (task-044, task-075) — these are source-scan
// structure assertions over the REAL installOrchestrateSkill body. They fail
// the instant anyone reintroduces `innerHTML =` on the Tasks-banner error path,
// or drops the DOM-node construction / static-element clear.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// Brace-match the installOrchestrateSkill body (same extractor the e2e uses).
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

const block = extractFn(rendererSrc, 'installOrchestrateSkill');

test('UNIT drift guard: installOrchestrateSkill never assigns innerHTML (no HTML-injection surface)', () => {
  // A comment may mention innerHTML in prose; only an actual `.innerHTML =`
  // ASSIGNMENT is forbidden.
  assert.ok(!/\.innerHTML\s*=/.test(block), 'installOrchestrateSkill must not assign innerHTML anywhere');
});

test('UNIT drift guard: the failure branch clears the static element then builds nodes via createElement/createTextNode', () => {
  // The static .install-banner-text is cleared before appending (prevents
  // stacking + drops the index.html default prompt).
  assert.match(block, /textEl\.textContent\s*=\s*''/, "the text element is cleared with textContent = ''");
  // The "Install failed." prefix is a <strong> built via createElement + textContent.
  assert.match(block, /document\.createElement\('strong'\)/, "a <strong> is created via document.createElement('strong')");
  assert.match(block, /\.textContent\s*=\s*'Install failed\.'/, "the strong prefix is set via textContent = 'Install failed.'");
  // The error is appended as a text node (never parsed as HTML).
  assert.match(block, /document\.createTextNode\(/, 'the error string is appended via document.createTextNode');
  // Both nodes are appended to the text element.
  assert.match(block, /textEl\.appendChild\(/, 'the failure nodes are appended to textEl');
});

test('UNIT drift guard: the error fallback + whitespace expression is preserved', () => {
  // Byte-identical visible text: leading space in the text node, and the
  // ((res && res.error) || 'unknown error') fallback for missing/falsy error.
  assert.match(
    block,
    /' '\s*\+\s*\(\(res && res\.error\)\s*\|\|\s*'unknown error'\)/,
    "the text node is ' ' + ((res && res.error) || 'unknown error')",
  );
});

test('UNIT drift guard: the textEl null guard and button-restore path are kept', () => {
  assert.match(block, /if\s*\(textEl\)/, 'the `if (textEl)` null guard is retained');
  // On failure the branch re-enables the button, restores its label, and returns.
  assert.match(block, /btn\.disabled\s*=\s*false/, 'the button is re-enabled');
  assert.match(block, /btn\.textContent\s*=\s*prev/, 'the button label is restored');
});

test('UNIT drift guard: stable class-name lookups are unchanged', () => {
  assert.match(block, /querySelector\('\.install-banner-text'\)/, ".install-banner-text lookup is stable");
  assert.match(block, /tab\.els\.tasksSkillBanner/, 'the tasksSkillBanner element reference is stable');
});
