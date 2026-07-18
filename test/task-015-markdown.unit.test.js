'use strict';

// Unit tests for TASK-015: the safe Markdown -> HTML renderer in lib/markdown.js
// (renderMarkdown, escapeHtml, sanitizeUrl, renderInline).
//
// The module is pure and Electron-free (no disk/DB/network/Electron), so it is
// exercised directly with `node --test`, mirroring test/ticket-lanes.js etc.
// NO DATABASE, FILESYSTEM (beyond reading the app's own source as a fixture in
// the mirror guard), OR NETWORK CALL IS MADE.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  renderMarkdown,
  escapeHtml,
  sanitizeUrl,
  renderInline,
} = require('../lib/markdown');

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

test('escapeHtml neutralizes all five HTML-significant characters', () => {
  assert.equal(
    escapeHtml(`<a href="x" onclick='y'>&`),
    '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
  );
});

test('escapeHtml coerces non-string input to string', () => {
  assert.equal(escapeHtml(42), '42');
});

// ---------------------------------------------------------------------------
// sanitizeUrl
// ---------------------------------------------------------------------------

test('sanitizeUrl permits http, https, mailto and tel', () => {
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com');
  assert.equal(sanitizeUrl('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
  assert.equal(sanitizeUrl('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(sanitizeUrl('tel:+123'), 'tel:+123');
});

test('sanitizeUrl permits relative paths and fragments (no scheme)', () => {
  assert.equal(sanitizeUrl('/img/logo.png'), '/img/logo.png');
  assert.equal(sanitizeUrl('./doc.md'), './doc.md');
  assert.equal(sanitizeUrl('#section'), '#section');
});

test('sanitizeUrl permits data:image but rejects data:text/html', () => {
  assert.equal(sanitizeUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(sanitizeUrl('data:text/html,<script>x</script>'), '#');
});

test('sanitizeUrl neutralizes javascript:/vbscript: to #', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), '#');
  assert.equal(sanitizeUrl('JavaScript:alert(1)'), '#');
  assert.equal(sanitizeUrl('vbscript:msgbox'), '#');
});

test('sanitizeUrl strips control/whitespace chars that hide a dangerous scheme', () => {
  assert.equal(sanitizeUrl('java\tscript:alert(1)'), '#');
  assert.equal(sanitizeUrl('  javascript:alert(1)'), '#');
});

// ---------------------------------------------------------------------------
// renderInline
// ---------------------------------------------------------------------------

test('renderInline turns **bold** into <strong>', () => {
  assert.equal(renderInline(escapeHtml('a **b** c')), 'a <strong>b</strong> c');
  assert.equal(renderInline(escapeHtml('a __b__ c')), 'a <strong>b</strong> c');
});

test('renderInline turns *italic*/_italic_ into <em>', () => {
  assert.equal(renderInline(escapeHtml('a *b* c')), 'a <em>b</em> c');
  assert.equal(renderInline(escapeHtml('a _b_ c')), 'a <em>b</em> c');
});

test('renderInline turns inline `code` into <code> and does not re-process it', () => {
  assert.equal(renderInline(escapeHtml('a `x * y` b')), 'a <code>x * y</code> b');
});

test('renderInline turns [text](http…) into a sanitized <a>', () => {
  assert.equal(
    renderInline(escapeHtml('[go](https://example.com)')),
    '<a href="https://example.com">go</a>',
  );
});

test('renderInline turns ![alt](img) into a sanitized <img>', () => {
  assert.equal(
    renderInline(escapeHtml('![logo](img.png)')),
    '<img src="img.png" alt="logo">',
  );
});

test('renderInline neutralizes a javascript: link URL to #', () => {
  assert.equal(
    renderInline(escapeHtml('[x](javascript:alert)')),
    '<a href="#">x</a>',
  );
});

// ---------------------------------------------------------------------------
// renderMarkdown: block constructs
// ---------------------------------------------------------------------------

test('renderMarkdown renders headings h1..h6', () => {
  for (let n = 1; n <= 6; n++) {
    const hashes = '#'.repeat(n);
    const html = renderMarkdown(`${hashes} Title`);
    assert.equal(html, `<h${n}>Title</h${n}>`);
  }
});

test('renderMarkdown renders an unordered list as ul/li', () => {
  const html = renderMarkdown('- one\n- two');
  assert.equal(html, '<ul><li>one</li><li>two</li></ul>');
});

test('renderMarkdown renders an ordered list as ol/li', () => {
  const html = renderMarkdown('1. first\n2. second');
  assert.equal(html, '<ol><li>first</li><li>second</li></ol>');
});

test('renderMarkdown renders a fenced code block as pre/code, verbatim + escaped', () => {
  const html = renderMarkdown('```\nlet x = 1 < 2;\n```');
  assert.equal(html, '<pre><code>let x = 1 &lt; 2;</code></pre>');
});

test('renderMarkdown renders a blockquote as blockquote', () => {
  const html = renderMarkdown('> quoted');
  assert.match(html, /^<blockquote>/);
  assert.match(html, /<\/blockquote>$/);
  assert.match(html, /quoted/);
});

test('renderMarkdown wraps plain text in a paragraph with inline formatting', () => {
  assert.equal(renderMarkdown('hello **world**'), '<p>hello <strong>world</strong></p>');
});

test('renderMarkdown returns empty string for null/undefined', () => {
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

// ---------------------------------------------------------------------------
// Injection / safety cases
// ---------------------------------------------------------------------------

test('a raw <script> tag becomes inert escaped text, never live markup', () => {
  const html = renderMarkdown('<script>window.__pwned = true</script>');
  assert.ok(!/<script/i.test(html), 'no live <script> tag in output');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;\/script&gt;/);
  assert.equal(typeof globalThis.__pwned, 'undefined', 'window.__pwned must never be set');
});

test('a javascript: URL in a markdown link is neutralized in rendered output', () => {
  const html = renderMarkdown('[click me](javascript:alert(1))');
  assert.match(html, /<a href="#">click me<\/a>/);
  assert.ok(!/javascript:/i.test(html), 'no javascript: scheme survives into the href');
});

test('a javascript: URL in a markdown image is neutralized in rendered output', () => {
  const html = renderMarkdown('![x](javascript:alert)');
  assert.match(html, /<img src="#" alt="x">/);
  assert.ok(!/javascript:/i.test(html));
});

test('inline HTML attributes cannot break out of an emitted attribute', () => {
  // A quote in link text is escaped, so it cannot terminate an attribute.
  const html = renderMarkdown('[a"onmouseover="alert(1)](https://ex.com)');
  assert.ok(!/onmouseover="alert/.test(html), 'quote is escaped, no attribute injection');
  assert.match(html, /&quot;/);
});

// ---------------------------------------------------------------------------
// Mirror guard: renderer.js keeps a verbatim copy of the renderer. If the two
// drift, the browser preview no longer matches the tested lib behaviour.
// (renderer.js is a browser script and cannot be require()'d.)
// ---------------------------------------------------------------------------

test('renderer.js mirrors lib/markdown.js renderMarkdown/helpers', () => {
  const rendererSrc = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSrc, /function\s+renderMarkdown\s*\(src\)/);
  assert.match(rendererSrc, /function\s+mdEscapeHtml\s*\(s\)/);
  assert.match(rendererSrc, /function\s+mdSanitizeUrl\s*\(url\)/);
  assert.match(rendererSrc, /function\s+mdRenderInline\s*\(escaped\)/);
  // The mirror declares it is kept in sync with the lib module.
  assert.match(rendererSrc, /mirrors lib\/markdown\.js/);
});
