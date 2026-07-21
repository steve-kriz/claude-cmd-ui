'use strict';

// ===========================================================================
// TASK-136 — unit tests. Focused source-pins on the shipped clear-button markup
// and its JS lookup hooks. NO database / filesystem / Electron / network call is
// made: these read renderer/index.html and renderer/renderer.js as text, the
// same static-markup-assertion pattern used by
// test/task-091-team-tab-scaffold.e2e.test.js.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// The single <button ...> opening tag carrying the `tasksSearchClear` class.
function clearButtonTag() {
  const cls = htmlSrc.indexOf('tasksSearchClear');
  assert.notEqual(cls, -1, 'the tasksSearchClear button exists in index.html');
  const open = htmlSrc.lastIndexOf('<button', cls);
  const close = htmlSrc.indexOf('>', cls);
  assert.ok(open !== -1 && close !== -1 && close > open, 'the clear button tag is well-formed');
  return htmlSrc.slice(open, close + 1);
}

test('unit: the clear button markup carries aria-label="Clear search" and no tabindex="-1"', () => {
  const tag = clearButtonTag();
  assert.match(tag, /aria-label="Clear search"/, 'aria-label="Clear search" present');
  assert.ok(!/tabindex="-1"/.test(tag), 'tabindex="-1" removed');
  assert.ok(!/tabindex=/.test(tag), 'no tabindex attribute at all');
});

test('unit: the load-bearing classes tasksSearchClear / tasks-search-clear / hidden are unchanged', () => {
  const tag = clearButtonTag();
  const cls = (tag.match(/class="([^"]*)"/) || [])[1] || '';
  const set = new Set(cls.split(/\s+/).filter(Boolean));
  assert.ok(set.has('tasksSearchClear'), 'tasksSearchClear class kept (JS querySelector hook)');
  assert.ok(set.has('tasks-search-clear'), 'tasks-search-clear class kept (CSS hook)');
  assert.ok(set.has('hidden'), 'hidden class kept (visibility hook)');
  // The × text content and the tooltip are preserved.
  assert.match(tag, /title="Clear search \(Esc\)"/, 'tooltip kept');
});

test('unit: renderer.js still resolves the clear button by its .tasksSearchClear class', () => {
  // The els map lookup + the click handler both key off tasksSearchClear; the
  // markup change must not break either.
  assert.match(rendererSrc, /tasksSearchClear:\s*ws\.querySelector\('\.tasksSearchClear'\)/,
    'els.tasksSearchClear is resolved via .tasksSearchClear');
  assert.match(rendererSrc, /tab\.els\.tasksSearchClear\.addEventListener\('click'/,
    'the click handler binds to tab.els.tasksSearchClear');
});
