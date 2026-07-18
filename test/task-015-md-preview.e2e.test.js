'use strict';

// Cucumber-style e2e scenarios for TASK-015: the Files viewer "Show preview"
// toggle for Markdown files. Written in Given/When/Then form as `node --test`
// cases (NO `cucumber` npm package is installed or added).
//
// The rendering behaviour is exercised against the REAL, pure renderer in
// lib/markdown.js (the browser mirror in renderer/renderer.js is a verbatim copy
// of it — a mirror guard in the unit suite pins them together). The toggle /
// button-visibility logic lives in renderer/renderer.js, which is a browser
// script (nodeIntegration:false, references `document`) and cannot be
// require()'d. Matching the house style of test/ticket-lanes.test.js, that
// logic is proven two ways:
//
//   1. A VERBATIM copy of isMarkdownPath / updateFilePreviewButton /
//      setFilePreviewMode / toggleFilePreview (renderer.js ~1427-1483) driven
//      against a tiny in-memory fake DOM element model — a behavioural contract.
//   2. A source/DOM assertion that renderer/index.html really carries the
//      `.filePreviewBtn` + `.filePreview` container and that the button starts
//      hidden + disabled, and that renderer.js defines the same helpers.
//
// NO DATABASE, NO NETWORK. The only I/O is reading the app's own source files
// (index.html / renderer.js) as fixtures. There is nothing to mock away here,
// but by construction no DB connection is ever opened.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderMarkdown } = require('../lib/markdown');

const REPO_ROOT = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(REPO_ROOT, 'renderer', 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(REPO_ROOT, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// Tiny in-memory fake DOM: just enough of an element for the toggle logic.
// ---------------------------------------------------------------------------

function makeEl(initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    disabled: false,
    textContent: '',
    innerHTML: '',
    value: '',
    _attrs: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    isHidden() { return classes.has('hidden'); },
  };
}

// A fake Files tab, initialised the way index.html ships: the preview button
// starts hidden + disabled and the preview container starts hidden.
function makeTab() {
  const btn = makeEl(['hidden']);
  btn.disabled = true;
  btn.textContent = 'Show preview';
  btn.setAttribute('aria-pressed', 'false');
  return {
    currentFilePath: null,
    fileIsBinary: false,
    previewMode: false,
    els: {
      filePreviewBtn: btn,
      filePreview: makeEl(['hidden']),
      fileEditor: makeEl([]),
      fileFindOverlay: makeEl([]),
    },
  };
}

// --- VERBATIM copy of renderer.js toggle logic (renderer.js ~1427-1483) -----
// renderMarkdown below is the lib module, which renderer.js mirrors verbatim.

function isMarkdownPath(p) {
  return typeof p === 'string' && /\.md$/i.test(p);
}

function updateFilePreviewButton(tab) {
  const btn = tab.els.filePreviewBtn;
  if (!btn) return;
  const eligible = !!tab.currentFilePath && !tab.fileIsBinary && isMarkdownPath(tab.currentFilePath);
  if (!eligible) {
    setFilePreviewMode(tab, false);
    btn.classList.add('hidden');
    btn.disabled = true;
    return;
  }
  btn.classList.remove('hidden');
  btn.disabled = false;
}

function setFilePreviewMode(tab, on) {
  const btn = tab.els.filePreviewBtn;
  const preview = tab.els.filePreview;
  if (!preview) return;
  tab.previewMode = !!on;
  if (on) {
    preview.innerHTML = renderMarkdown(tab.els.fileEditor.value);
    preview.classList.remove('hidden');
    tab.els.fileEditor.classList.add('hidden');
    if (tab.els.fileFindOverlay) tab.els.fileFindOverlay.classList.add('hidden');
    if (btn) {
      btn.textContent = 'Show source';
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  } else {
    preview.classList.add('hidden');
    preview.innerHTML = '';
    if (!tab.fileIsBinary) tab.els.fileEditor.classList.remove('hidden');
    if (tab.els.fileFindOverlay) tab.els.fileFindOverlay.classList.remove('hidden');
    if (btn) {
      btn.textContent = 'Show preview';
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    }
  }
}

function toggleFilePreview(tab) {
  if (!isMarkdownPath(tab.currentFilePath) || tab.fileIsBinary) return;
  setFilePreviewMode(tab, !tab.previewMode);
}

// Mirror of loadFile/resetFileEditor semantics: opening a file always resets the
// viewer to source, then re-evaluates whether the preview toggle applies.
function openFile(tab, filePath, content, binary = false) {
  setFilePreviewMode(tab, false); // resetFileEditor forces source mode
  tab.currentFilePath = filePath;
  tab.fileIsBinary = binary;
  tab.els.fileEditor.value = content;
  updateFilePreviewButton(tab);
}

// ===========================================================================
// Feature: Markdown "Show preview" toggle in the Files viewer
// ===========================================================================

test('Scenario: Preview button appears for a Markdown file', () => {
  // Given a Files tab
  const tab = makeTab();
  // When the user opens README.md
  openFile(tab, 'C:/proj/README.md', '# Hello\n\n- a\n- b');
  // Then the preview button is visible and enabled in the toolbar
  assert.equal(tab.els.filePreviewBtn.isHidden(), false, 'button is visible');
  assert.equal(tab.els.filePreviewBtn.disabled, false, 'button is enabled');
});

test('Scenario: Preview button hidden/disabled for a non-Markdown file', () => {
  // Given a Files tab
  const tab = makeTab();
  // When the user opens renderer.js (not markdown)
  openFile(tab, 'C:/proj/renderer/renderer.js', 'const x = 1;');
  // Then the preview button is hidden and disabled
  assert.equal(tab.els.filePreviewBtn.isHidden(), true, 'button is hidden');
  assert.equal(tab.els.filePreviewBtn.disabled, true, 'button is disabled');
});

test('Scenario: No file open -> button hidden/disabled', () => {
  // Given a fresh Files tab with no file open
  const tab = makeTab();
  // When the button state is evaluated
  updateFilePreviewButton(tab);
  // Then the preview button is hidden and disabled
  assert.equal(tab.currentFilePath, null);
  assert.equal(tab.els.filePreviewBtn.isHidden(), true);
  assert.equal(tab.els.filePreviewBtn.disabled, true);
});

test('Scenario: Toggling to preview hides the textarea and shows rendered HTML', () => {
  // Given an open README.md with a heading and a list
  const tab = makeTab();
  openFile(tab, 'C:/proj/README.md', '# Title\n\n- one\n- two');
  // When the user toggles to preview
  toggleFilePreview(tab);
  // Then the raw textarea is hidden
  assert.equal(tab.els.fileEditor.isHidden(), true, 'textarea hidden in preview');
  // And the rendered preview is shown
  assert.equal(tab.els.filePreview.isHidden(), false, 'preview shown');
  // And it contains an h1 element and a ul
  assert.match(tab.els.filePreview.innerHTML, /<h1>Title<\/h1>/);
  assert.match(tab.els.filePreview.innerHTML, /<ul>.*<\/ul>/s);
  // And the button now offers returning to source
  assert.equal(tab.els.filePreviewBtn.textContent, 'Show source');
  assert.equal(tab.els.filePreviewBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(tab.previewMode, true);
});

test('Scenario: Toggling back restores the editable textarea with original content', () => {
  // Given an open README.md currently in preview mode
  const original = '# Title\n\n- one\n- two';
  const tab = makeTab();
  openFile(tab, 'C:/proj/README.md', original);
  toggleFilePreview(tab); // -> preview
  // When the user toggles back
  toggleFilePreview(tab); // -> source
  // Then the editable textarea is shown again
  assert.equal(tab.els.fileEditor.isHidden(), false, 'textarea shown again');
  assert.equal(tab.els.filePreview.isHidden(), true, 'preview hidden again');
  assert.equal(tab.els.filePreview.innerHTML, '', 'preview cleared');
  // And it still holds the original markdown content
  assert.equal(tab.els.fileEditor.value, original);
  // And the button offers preview again
  assert.equal(tab.els.filePreviewBtn.textContent, 'Show preview');
  assert.equal(tab.els.filePreviewBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(tab.previewMode, false);
});

test('Scenario Outline: Markdown constructs render to the expected HTML', () => {
  const cases = [
    { md: '# Title', pattern: /<h1>Title<\/h1>/, name: 'heading -> h1' },
    { md: '**bold**', pattern: /<strong>bold<\/strong>/, name: 'bold -> strong' },
    { md: '1. first', pattern: /<ol><li>first<\/li><\/ol>/, name: 'ordered -> ol/li' },
    { md: 'use `code` here', pattern: /<code>code<\/code>/, name: 'inline code -> code' },
    { md: '[link](https://example.com)', pattern: /<a href="https:\/\/example\.com">link<\/a>/, name: 'link -> a' },
    { md: '![alt](img.png)', pattern: /<img src="img\.png" alt="alt">/, name: 'image -> img' },
    { md: '> quote', pattern: /<blockquote>[\s\S]*quote[\s\S]*<\/blockquote>/, name: 'quote -> blockquote' },
  ];
  for (const c of cases) {
    // Given a markdown construct, When rendered, Then it matches the expected tag
    assert.match(renderMarkdown(c.md), c.pattern, `${c.name}: ${c.md}`);
  }
});

test('Scenario (edge): Script in markdown does not execute', () => {
  // Given markdown containing a script tag
  const tab = makeTab();
  openFile(tab, 'C:/proj/evil.md', '<script>window.__pwned = true</script>');
  // When the user views the preview
  toggleFilePreview(tab);
  const html = tab.els.filePreview.innerHTML;
  // Then no live <script> tag is present and it is shown as escaped text
  assert.ok(!/<script/i.test(html), 'output contains no live <script> tag');
  assert.match(html, /&lt;script&gt;/);
  // And no global was ever set as a side effect
  assert.equal(typeof globalThis.__pwned, 'undefined', 'window.__pwned is not set');
});

test('Scenario (edge): Switching files resets preview mode', () => {
  // Given a Markdown file is open and shown in preview mode
  const tab = makeTab();
  openFile(tab, 'C:/proj/README.md', '# Title\n\n- one');
  toggleFilePreview(tab);
  assert.equal(tab.previewMode, true, 'precondition: in preview');
  // When the user opens a non-markdown file
  openFile(tab, 'C:/proj/renderer/renderer.js', 'const x = 1;');
  // Then the viewer is back to raw source
  assert.equal(tab.previewMode, false, 'reset to source');
  assert.equal(tab.els.fileEditor.isHidden(), false, 'raw source shown');
  assert.equal(tab.els.filePreview.isHidden(), true, 'preview hidden');
  // And the preview button is hidden + disabled again
  assert.equal(tab.els.filePreviewBtn.isHidden(), true);
  assert.equal(tab.els.filePreviewBtn.disabled, true);
});

test('Scenario (edge): No new markdown runtime dependency was added', () => {
  // Given the project manifest
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  const devDeps = Object.keys(pkg.devDependencies || {});
  // Then no markdown/marked/markdown-it style parser is present anywhere
  const forbidden = /^(marked|markdown|markdown-it|remark|showdown|micromark|commonmark|snarkdown)$/i;
  const offending = [...deps, ...devDeps].filter((d) => forbidden.test(d));
  assert.deepEqual(offending, [], `no markdown parser dependency expected, found: ${offending.join(', ')}`);
  // And the runtime dependency set is exactly the pre-feature set (unchanged).
  assert.deepEqual(deps.sort(), [
    '@lydell/node-pty',
    '@xterm/addon-fit',
    '@xterm/xterm',
  ]);
});

// ---------------------------------------------------------------------------
// DOM/source assertions: the shipped markup carries the button + preview
// container and the button starts hidden + disabled; renderer.js defines the
// helpers whose behaviour the scenarios above pin down.
// ---------------------------------------------------------------------------

test('index.html ships a .filePreviewBtn that starts hidden + disabled', () => {
  const m = /<button class="filePreviewBtn[^"]*"[^>]*>/.exec(htmlSrc);
  assert.ok(m, '.filePreviewBtn button exists in index.html');
  const tag = m[0];
  assert.match(tag, /\bhidden\b/, 'button starts hidden');
  assert.match(tag, /\bdisabled\b/, 'button starts disabled');
  assert.match(tag, /aria-pressed="false"/, 'button starts un-pressed');
});

test('index.html ships a hidden .filePreview container', () => {
  const m = /<div class="filePreview[^"]*"[^>]*>/.exec(htmlSrc);
  assert.ok(m, '.filePreview container exists in index.html');
  assert.match(m[0], /\bhidden\b/, 'preview container starts hidden');
});

test('renderer.js defines the preview toggle helpers', () => {
  assert.match(rendererSrc, /function\s+isMarkdownPath\s*\(p\)/);
  assert.match(rendererSrc, /function\s+updateFilePreviewButton\s*\(tab\)/);
  assert.match(rendererSrc, /function\s+setFilePreviewMode\s*\(tab,\s*on\)/);
  assert.match(rendererSrc, /function\s+toggleFilePreview\s*\(tab\)/);
});
