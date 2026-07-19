'use strict';

// E2E cucumber-style (Given/When/Then) scenarios for the modal listener-
// accumulation bug fixed in TASK-024. These are scenario-shaped `node --test`
// cases (no `cucumber` package). They model the real renderer flow —
// openBugReportModal / openNewTaskModal bind the submit button's `click`
// handler through bindActionOnce every time the modal opens, closing over the
// current `file` — using the canonical lib helper against an in-memory fake
// element. No DOM, no Electron, no DB/IO: all "database"/ticket state is a
// plain in-test variable.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bindActionOnce } = require('../lib/modal-actions');

// Same minimal fake element as the unit suite, with browser-faithful once
// semantics in fire().
function makeSubmitButton() {
  return {
    listeners: [],
    addEventListener(event, handler, opts) {
      this.listeners.push({ event, handler, opts });
    },
    removeEventListener(event, handler) {
      const i = this.listeners.findIndex(
        (l) => l.event === event && l.handler === handler,
      );
      if (i !== -1) this.listeners.splice(i, 1);
    },
    fire(event) {
      const matched = this.listeners.filter((l) => l.event === event);
      for (const l of matched) {
        if (l.opts && l.opts.once) {
          const i = this.listeners.indexOf(l);
          if (i !== -1) this.listeners.splice(i, 1);
        }
        l.handler.call(this, { type: event });
      }
    },
  };
}

// Mirror of openBugReportModal's submit wiring: opening the modal for `file`
// binds a submit handler that records which file it acted on. Returns the
// disposer (renderer uses it on cancel).
function openModalForFile(submitBtn, file, actedOn) {
  const onSubmit = () => { actedOn.file = file; };
  return bindActionOnce(submitBtn, 'click', onSubmit);
}

// ---------------------------------------------------------------------------
// Scenario: Re-opening the modal rebinds to the new ticket
// ---------------------------------------------------------------------------

test('Scenario: re-opening the modal binds submit to the NEW ticket, not the stale one', () => {
  // Given the modal was opened for file A but not dismissed
  const submitBtn = makeSubmitButton();
  const actedOn = { file: null };
  openModalForFile(submitBtn, 'A', actedOn);

  // When it is opened again for file B
  openModalForFile(submitBtn, 'B', actedOn);
  // And the submit event fires
  submitBtn.fire('click');

  // Then only file B's handler runs (A's stale handler was detached)
  assert.equal(actedOn.file, 'B', 'submit acted on the current ticket B, not stale A');
  assert.equal(submitBtn.listeners.length, 0, 'handler self-detached after firing');
});

// ---------------------------------------------------------------------------
// Scenario: A single submit fires exactly once
// ---------------------------------------------------------------------------

test('Scenario: a single submit fires exactly once then detaches ({ once: true })', () => {
  // Given the modal is open
  const submitBtn = makeSubmitButton();
  let submits = 0;
  bindActionOnce(submitBtn, 'click', () => { submits += 1; });

  // When submit fires
  submitBtn.fire('click');
  // And the user (or a stray event) fires submit again
  submitBtn.fire('click');

  // Then the handler ran exactly once and was detached after the first fire
  assert.equal(submits, 1);
  assert.equal(submitBtn.listeners.length, 0);
});

// ---------------------------------------------------------------------------
// Scenario (edge): dispose before fire — cancelled modal never submits
// ---------------------------------------------------------------------------

test('Scenario (edge): a cancelled modal (dispose before fire) never runs submit', () => {
  // Given the modal opened for file A then cancelled (dispose called)
  const submitBtn = makeSubmitButton();
  const actedOn = { file: null };
  const dispose = openModalForFile(submitBtn, 'A', actedOn);
  dispose();

  // When submit fires
  submitBtn.fire('click');

  // Then nothing runs — no stale submit against the cancelled ticket
  assert.equal(actedOn.file, null);
  assert.equal(submitBtn.listeners.length, 0);
});

// ---------------------------------------------------------------------------
// Scenario: retry path re-arms submit after a self-detaching fire
// ---------------------------------------------------------------------------

test('Scenario: after a submit fires, re-arming binds a fresh handler for the retry', () => {
  // Given the modal is open for file A and submit has fired once (empty input
  // / save-failed path in the renderer re-arms submit)
  const submitBtn = makeSubmitButton();
  const actedOn = { file: null };
  openModalForFile(submitBtn, 'A', actedOn);
  submitBtn.fire('click');
  assert.equal(actedOn.file, 'A');

  // When the retry path re-arms submit for the still-current file A
  actedOn.file = null;
  openModalForFile(submitBtn, 'A', actedOn);
  // And submit fires again
  submitBtn.fire('click');

  // Then the fresh handler runs once more for A
  assert.equal(actedOn.file, 'A');
  assert.equal(submitBtn.listeners.length, 0);
});
