'use strict';

// ===========================================================================
// UNIT + E2E-cucumber tests for the last-prompt strip: a white highlighted bar
// at the top of the command window carrying the most recent prompt sent to the
// agent, so the user can see what claude is working on.
//
// setLastPrompt is a browser function and cannot be require()'d, so it is
// EXTRACTED FROM THE SHIPPED renderer.js SOURCE and instantiated against DOM
// mocks — the real code under test, not a replica, so it cannot drift. The
// markup and the white-highlight styling are asserted by source-scanning
// index.html / styles.css as text.
//
// NO DATABASE, NO REAL DB CONNECTION, NO ELECTRON RUNTIME, NO NETWORK. Every
// element is a plain in-memory mock.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// --- Extract a top-level `function name(...) { ... }` from source by brace
// matching, so the tests exercise the shipped implementation verbatim. -------
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `renderer.js must declare function ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Instantiate the real setLastPrompt with its two collaborators injected:
// fitTab (recorded, so the refit-on-visibility-change rule is observable) and
// requestAnimationFrame (run synchronously so the test needs no timers).
function loadSetLastPrompt() {
  const fits = [];
  const factory = new Function(
    'fitTab',
    'requestAnimationFrame',
    `${extractFn(rendererSrc, 'setLastPrompt')}; return setLastPrompt;`,
  );
  const fn = factory((tab) => fits.push(tab), (cb) => cb());
  return { setLastPrompt: fn, fits };
}

// --- DOM mocks ------------------------------------------------------------
function makeSpan() {
  return { textContent: '' };
}

function makeBar(hidden = true) {
  const classes = new Set(hidden ? ['hidden'] : []);
  const attrs = new Map();
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    set title(v) { attrs.set('title', v); },
    get title() { return attrs.get('title'); },
    removeAttribute: (a) => attrs.delete(a),
    hasAttribute: (a) => attrs.has(a),
    get isHidden() { return classes.has('hidden'); },
  };
}

function makeTab({ hidden = true } = {}) {
  const bar = makeBar(hidden);
  const text = makeSpan();
  return { els: { lastPromptBar: bar, lastPromptText: text }, bar, text };
}

// ===========================================================================
// UNIT TESTS
// ===========================================================================

test('UNIT: a prompt reveals the strip, sets its text, and keeps the full text as the tooltip', () => {
  const { setLastPrompt, fits } = loadSetLastPrompt();
  const tab = makeTab();

  setLastPrompt(tab, 'refactor the queue dispatcher');

  assert.equal(tab.bar.isHidden, false, 'the strip is revealed');
  assert.equal(tab.text.textContent, 'refactor the queue dispatcher');
  assert.equal(tab.bar.title, 'refactor the queue dispatcher', 'full text kept as the tooltip');
  assert.deepEqual(fits, [tab], 'revealing the strip refits the pane (its height changed)');
});

test('UNIT: a multi-line prompt collapses to one line, but the tooltip keeps the original', () => {
  const { setLastPrompt } = loadSetLastPrompt();
  const tab = makeTab();
  const prompt = 'fix the cmd pane\n\n  the text is black\ton black\n';

  setLastPrompt(tab, prompt);

  assert.equal(tab.text.textContent, 'fix the cmd pane the text is black on black',
    'newlines/tabs/whitespace runs collapse to single spaces and the ends are trimmed');
  assert.equal(tab.bar.title, prompt, 'the tooltip carries the untouched original');
});

test('UNIT: an empty / whitespace-only prompt hides the strip and drops the tooltip', () => {
  for (const empty of ['', '   ', '\n\t\n', null, undefined]) {
    const { setLastPrompt } = loadSetLastPrompt();
    const tab = makeTab({ hidden: false });

    setLastPrompt(tab, empty);

    assert.equal(tab.bar.isHidden, true, `hidden for ${JSON.stringify(empty)}`);
    assert.equal(tab.text.textContent, '', 'text cleared');
    assert.equal(tab.bar.hasAttribute('title'), false, 'stale tooltip removed');
  }
});

test('UNIT: replacing the text on an already-visible strip does NOT refit the pane', () => {
  const { setLastPrompt, fits } = loadSetLastPrompt();
  const tab = makeTab();

  setLastPrompt(tab, 'first prompt');
  assert.equal(fits.length, 1, 'the reveal refit once');
  setLastPrompt(tab, 'second prompt');

  assert.equal(tab.text.textContent, 'second prompt', 'the newest prompt wins');
  assert.equal(fits.length, 1, 'a same-height text swap leaves the layout alone');
});

test('UNIT (failure): a tab whose strip elements are missing is a no-op, never a throw', () => {
  const { setLastPrompt, fits } = loadSetLastPrompt();
  for (const els of [{}, { lastPromptBar: makeBar() }, { lastPromptText: makeSpan() }]) {
    assert.doesNotThrow(() => setLastPrompt({ els }, 'anything'));
  }
  assert.deepEqual(fits, [], 'nothing is refit when there is no strip to size');
});

// ===========================================================================
// STRUCTURE / DRIFT GUARDS — markup, styling, and the single feed point
// ===========================================================================

test('UNIT: the strip is markup at the top of the command window, directly above the terminal', () => {
  const barIdx = htmlSrc.indexOf('class="lastPromptBar last-prompt-bar hidden"');
  const termIdx = htmlSrc.indexOf('class="cmdTerm term"');
  assert.notEqual(barIdx, -1, 'index.html declares the strip');
  assert.notEqual(termIdx, -1, 'index.html declares the cmd terminal');
  assert.ok(barIdx < termIdx, 'the strip sits ABOVE the terminal in the cmd pane');
  assert.match(htmlSrc, /class="lastPromptText last-prompt-text"/, 'the text span exists');
  assert.match(htmlSrc, /class="last-prompt-label">Working on</, 'the strip is labelled');
});

test('UNIT: the strip renders as white-highlighted text, single-line and ellipsised', () => {
  const bar = /\.last-prompt-bar\s*\{([^}]*)\}/.exec(cssSrc);
  assert.ok(bar, 'styles.css defines .last-prompt-bar');
  assert.match(bar[1], /background:\s*#ffffff/i, 'white highlight ground');
  assert.match(bar[1], /color:\s*#1e1e1e/i, 'dark text on the white ground (readable)');
  assert.match(bar[1], /flex:\s*0 0 auto/, 'the strip never steals the terminal\'s flex space');
  assert.match(cssSrc, /\.last-prompt-bar\.hidden\s*\{\s*display:\s*none/, 'hidden collapses it');

  const text = /\.last-prompt-text\s*\{([^}]*)\}/.exec(cssSrc);
  assert.ok(text, 'styles.css defines .last-prompt-text');
  assert.match(text[1], /white-space:\s*nowrap/, 'one line only');
  assert.match(text[1], /text-overflow:\s*ellipsis/, 'overflow ellipsised, not wrapped');
  assert.match(text[1], /min-width:\s*0/, 'so the flex child can actually shrink and ellipsise');
});

test('UNIT: the strip is wired into the tab element map', () => {
  assert.match(rendererSrc, /lastPromptBar:\s*ws\.querySelector\('\.lastPromptBar'\)/);
  assert.match(rendererSrc, /lastPromptText:\s*ws\.querySelector\('\.lastPromptText'\)/);
});

test('UNIT: logPromptEntry is the single feed point, so every prompt route updates the strip', () => {
  const logFn = extractFn(rendererSrc, 'logPromptEntry');
  assert.match(logFn, /setLastPrompt\(tab,\s*text\)/,
    'logPromptEntry paints the strip — the one funnel every prompt route passes through');
  // The three routes that reach logPromptEntry: typed, queue-dispatched, Slack.
  for (const source of ["'user'", "'queue'", "'slack'"]) {
    assert.ok(rendererSrc.includes(`logPromptEntry(tab, ${source}`),
      `the ${source} prompt route feeds logPromptEntry`);
  }
});

test('UNIT: relaunching the cmd agent clears the strip alongside the terminal', () => {
  const launch = extractFn(rendererSrc, 'launchCmdAgent');
  assert.match(launch, /tab\.cmd\.term\.clear\(\)/, 'the terminal is cleared on relaunch');
  assert.match(launch, /setLastPrompt\(tab,\s*''\)/,
    'the strip is cleared too, so it never reports a prompt from a dead session');
});

// ===========================================================================
// E2E CUCUMBER-STYLE SCENARIOS
// ===========================================================================

test('E2E cucumber: the user sees what claude is working on after sending a prompt', async (t) => {
  await t.test(
    'Given a cmd pane with no prompt sent yet, When the user submits a prompt, ' +
    'Then the top of the command window shows it as highlighted text',
    () => {
      const { setLastPrompt } = loadSetLastPrompt();
      const tab = makeTab();
      assert.equal(tab.bar.isHidden, true, 'nothing to report before the first prompt');

      setLastPrompt(tab, 'add a last-prompt bar to the cmd pane');

      assert.equal(tab.bar.isHidden, false);
      assert.equal(tab.text.textContent, 'add a last-prompt bar to the cmd pane');
    },
  );
});

test('E2E cucumber: a queued prompt firing replaces what the strip reports', async (t) => {
  await t.test(
    'Given the strip shows the prompt the user typed, When the queue dispatches the next one, ' +
    'Then the strip shows the newest prompt only',
    () => {
      const { setLastPrompt } = loadSetLastPrompt();
      const tab = makeTab();

      setLastPrompt(tab, 'first: fix the theme');
      setLastPrompt(tab, 'second: update the agents');

      assert.equal(tab.text.textContent, 'second: update the agents');
      assert.equal(tab.bar.title, 'second: update the agents',
        'the tooltip tracks the newest prompt, not the first');
    },
  );
});

test('E2E cucumber (edge): switching agents restarts the pane and empties the strip', async (t) => {
  await t.test(
    'Given the strip reports a prompt, When the cmd pane relaunches (terminal cleared), ' +
    'Then the strip is hidden again and the pane is refit',
    () => {
      const { setLastPrompt, fits } = loadSetLastPrompt();
      const tab = makeTab();

      setLastPrompt(tab, 'work in the old session');
      setLastPrompt(tab, '');

      assert.equal(tab.bar.isHidden, true, 'hidden after the session restarts');
      assert.equal(tab.text.textContent, '');
      assert.equal(fits.length, 2, 'both the reveal and the hide refit the terminal');
    },
  );
});
