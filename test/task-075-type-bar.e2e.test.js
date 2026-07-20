'use strict';

// ===========================================================================
// TASK-075 — e2e "cucumber" scenarios (Given/When/Then) for the colored ticket
// "type" bar on Tasks-board cards, implemented as plain `node --test` cases.
// NO `cucumber` npm package is installed or added.
//
// Feature: a thin horizontal colored bar below the ticket-id header and above the
// title encodes the ticket's type, derived purely from persisted frontmatter:
//   green (#6a9955)  — normal ticket (default)
//   red   (#f14c4c)  — bug ticket: non-empty `bug-of`
//   yellow(#e5c100)  — PR-review ticket: non-empty `review-of`
// Bug wins when both markers are present.
//
// renderer/renderer.js is a BROWSER script (no module.exports, references
// `document`), so — matching the repo convention (test/ticket-lanes.test.js,
// test/task-031-bug-reporting.e2e.test.js) — the scenarios drive a TINY fake-DOM
// card builder that mirrors renderTasksBoard's exact append order
// (id -> type bar -> title -> dot), wired to the REAL predicates + status
// constants EXTRACTED and evaluated headless out of renderer.js. Source-scan
// guards tie the insertion point, poll signature, and CSS colors to the real
// files, so a divergence in production fails a test here.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK. The "board" is an in-memory
// array of frontmatter objects; every DB/disk read the renderer would do is
// mocked away by construction (the only I/O is reading the app's own source).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// --- Extract a named function declaration by brace-matching. ---
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// Load the REAL predicates + status/archive constants headless out of renderer.js.
const R = (function loadRenderer() {
  const activeM = rendererSrc.match(/const\s+TASKS_ACTIVE_STATUSES\s*=\s*(\[[^\]]*\])/);
  const failedM = rendererSrc.match(/const\s+TASKS_FAILED_STATUS\s*=\s*('[^']*')/);
  const daysM = rendererSrc.match(/const\s+TASKS_ARCHIVE_AFTER_DAYS\s*=\s*(\d+)/);
  assert.ok(activeM && failedM && daysM, 'status/archive constants found in renderer.js');
  const body = [
    `const TASKS_ACTIVE_STATUSES = ${activeM[1]};`,
    `const TASKS_FAILED_STATUS = ${failedM[1]};`,
    `const TASKS_ARCHIVE_AFTER_DAYS = ${daysM[1]};`,
    'const TASKS_ARCHIVE_AFTER_MS = TASKS_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;',
    extractFn(rendererSrc, 'ticketFieldNonEmpty'),
    extractFn(rendererSrc, 'isTicketWaitingForAnswer'),
    extractFn(rendererSrc, 'isWontDoTicket'),
    extractFn(rendererSrc, 'isBugTicket'),
    extractFn(rendererSrc, 'isReviewTicket'),
    extractFn(rendererSrc, 'ticketArchiveTimestamp'),
    extractFn(rendererSrc, 'ticketIsArchived'),
    'return { TASKS_ACTIVE_STATUSES, TASKS_FAILED_STATUS, TASKS_ARCHIVE_AFTER_MS,'
      + ' ticketFieldNonEmpty, isTicketWaitingForAnswer, isWontDoTicket, isBugTicket,'
      + ' isReviewTicket, ticketArchiveTimestamp, ticketIsArchived };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
})();

// --- Minimal fake DOM node (only what the card builder touches). ---
function makeEl(tag) {
  const el = { tagName: tag, className: '', title: '', _children: [], _text: '', _attrs: {} };
  const set = new Set();
  el.classList = {
    _set: set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
  };
  el.appendChild = function appendChild(c) { this._children.push(c); return c; };
  el.setAttribute = function setAttribute(k, v) { this._attrs[k] = String(v); };
  el.getAttribute = function getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = v; },
  });
  return el;
}

// Build a card the way renderTasksBoard does (renderer.js ~5906-5949): append
// order is idEl -> typeEl -> titleEl -> (optional) dot. Uses the REAL predicates.
function buildCard(fm) {
  const card = makeEl('div');
  card.className = 'task-card';
  const idEl = makeEl('div');
  idEl.className = 'task-card-id';
  idEl.textContent = fm.id;
  const titleEl = makeEl('div');
  titleEl.className = 'task-card-title';
  titleEl.textContent = fm.title || '(untitled)';
  if (R.isWontDoTicket(fm)) titleEl.classList.add('wont-do');
  card.appendChild(idEl);
  const typeEl = makeEl('div');
  // Text alternative (TASK-082): same predicates as the color, bug checked first,
  // fixed literal per type, applied via title/aria-label attribute (never innerHTML).
  const typeLabel = R.isBugTicket(fm) ? 'Bug' : (R.isReviewTicket(fm) ? 'Review' : 'Normal');
  typeEl.className = 'task-card-type'
    + (R.isBugTicket(fm) ? ' bug' : (R.isReviewTicket(fm) ? ' review' : ''));
  typeEl.title = typeLabel;
  typeEl.setAttribute('aria-label', typeLabel);
  // Announceable role (TASK-083): role="img" reliably exposes the aria-label for
  // this purely-decorative colored strip, set unconditionally on the universal
  // construction path (every card, every type/status), via setAttribute (never
  // innerHTML), keeping the bar non-interactive/non-focusable (no tabindex).
  typeEl.setAttribute('role', 'img');
  card.appendChild(typeEl);
  card.appendChild(titleEl);
  const waitingForAnswer = R.isTicketWaitingForAnswer(fm);
  const failed = fm.status === R.TASKS_FAILED_STATUS;
  const active = R.TASKS_ACTIVE_STATUSES.includes(fm.status);
  if (waitingForAnswer || failed || active) {
    const dot = makeEl('span');
    dot.className = 'task-card-dot' + (waitingForAnswer ? ' waiting' : (failed ? ' failed' : ''));
    card.appendChild(dot);
  }
  return card;
}

const baseClass = (el) => el.className.split(' ')[0];
const childIndexByBase = (card, base) => card._children.findIndex((c) => baseClass(c) === base);
const typeBar = (card) => card._children.find((c) => baseClass(c) === 'task-card-type');
const hasMod = (el, mod) => el.className.split(' ').includes(mod);
// The type bar's text alternative (TASK-082): title and aria-label must agree.
const typeBarLabel = (card) => {
  const bar = typeBar(card);
  assert.equal(bar.title, bar.getAttribute('aria-label'),
    'title and aria-label carry the same label');
  return bar.title;
};

// The renderer's board re-render signature (renderer.js ~5750). A frontmatter edit
// only forces a re-render when this key changes (id|status|updated).
function renderSignature(fm) {
  return `${fm.id}|${fm.status}|${fm.updated}`;
}

// ===========================================================================
// Scenario: Normal ticket shows a green bar
// ===========================================================================
test('Scenario: a normal ticket shows a green type bar below the id and above the title', () => {
  // Given a ticket with no bug-of and no review-of frontmatter
  const fm = { id: 'TASK-100', title: 'Routine work', status: 'todo', updated: '2026-07-19T00:00:00.000Z' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then a type bar appears below the ticket id and above the title
  const idIdx = childIndexByBase(card, 'task-card-id');
  const typeIdx = childIndexByBase(card, 'task-card-type');
  const titleIdx = childIndexByBase(card, 'task-card-title');
  assert.ok(idIdx !== -1 && typeIdx !== -1 && titleIdx !== -1, 'id, type bar, and title all rendered');
  assert.ok(idIdx < typeIdx, 'the type bar comes after the ticket id');
  assert.ok(typeIdx < titleIdx, 'the type bar comes before the title');
  // And the bar is green (default, no modifier)
  assert.equal(typeBar(card).className, 'task-card-type', 'green default: no .bug / .review modifier');
  // And the CSS paints the default bar green (#6a9955).
  assert.match(cssSrc, /\.task-card-type\s*\{[^}]*background:\s*#6a9955/i);
});

// ===========================================================================
// Scenario: Bug ticket shows a red bar
// ===========================================================================
test('Scenario: a ticket with a non-empty bug-of shows a red type bar', () => {
  // Given a ticket whose frontmatter contains "bug-of: TASK-031"
  const fm = { id: 'TASK-101', title: 'Toggle regression', status: 'todo', 'bug-of': 'TASK-031', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the type bar is red (.bug), still between id and title
  const bar = typeBar(card);
  assert.ok(hasMod(bar, 'bug'), 'the bar carries the .bug modifier');
  assert.ok(!hasMod(bar, 'review'), 'and not the review modifier');
  assert.ok(childIndexByBase(card, 'task-card-id') < childIndexByBase(card, 'task-card-type'));
  assert.ok(childIndexByBase(card, 'task-card-type') < childIndexByBase(card, 'task-card-title'));
  // And the CSS paints .bug red (#f14c4c).
  assert.match(cssSrc, /\.task-card-type\.bug\s*\{[^}]*background:\s*#f14c4c/i);
});

// ===========================================================================
// Scenario: PR review ticket shows a yellow bar
// ===========================================================================
test('Scenario: a ticket with a non-empty review-of shows a yellow type bar', () => {
  // Given a ticket whose frontmatter contains "review-of: TASK-046"
  const fm = { id: 'TASK-102', title: 'Address review comments', status: 'todo', 'review-of': 'TASK-046', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the type bar is yellow (.review)
  const bar = typeBar(card);
  assert.ok(hasMod(bar, 'review'), 'the bar carries the .review modifier');
  assert.ok(!hasMod(bar, 'bug'), 'and not the bug modifier');
  // And the CSS paints .review yellow (#e5c100).
  assert.match(cssSrc, /\.task-card-type\.review\s*\{[^}]*background:\s*#e5c100/i);
});

// ===========================================================================
// Scenario: Empty marker values fall back to green (edge)
// ===========================================================================
test('Scenario (edge): an empty / whitespace-only marker value falls back to green', () => {
  // Given a ticket whose frontmatter contains "bug-of:" with a blank value
  for (const marker of [{ 'bug-of': '' }, { 'bug-of': '   ' }, { 'review-of': '' }, { 'review-of': '\t ' }]) {
    const fm = Object.assign({ id: 'TASK-103', title: 'x', status: 'todo', updated: 'x' }, marker);
    // When the board renders its card
    const card = buildCard(fm);
    // Then the type bar is green (no modifier)
    assert.equal(typeBar(card).className, 'task-card-type', `${JSON.stringify(marker)} -> green default`);
  }
});

// ===========================================================================
// Scenario: Both markers present uses precedence (edge)
// ===========================================================================
test('Scenario (edge): both bug-of and review-of non-empty -> red (bug wins)', () => {
  // Given a ticket with non-empty bug-of and non-empty review-of
  const fm = { id: 'TASK-104', title: 'x', status: 'todo', 'bug-of': 'TASK-031', 'review-of': 'TASK-046', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the type bar is red (bug precedence), NOT yellow
  const bar = typeBar(card);
  assert.equal(bar.className, 'task-card-type bug', 'red wins over yellow when both markers are present');
});

// ===========================================================================
// Scenario: Post-processing and unknown cards are green (edge)
// ===========================================================================
test('Scenario (edge): post-processing and unknown-status cards render a green bar', () => {
  // Given a kind: post-processing ticket and an unknown-status ticket
  const pp = { id: 'TASK-105', title: 'Recipe', status: 'todo', kind: 'post-processing', updated: 'x' };
  const unknown = { id: 'TASK-106', title: 'Weird', status: 'totally-bogus-status', updated: 'x' };
  // When the board renders their cards
  const ppCard = buildCard(pp);
  const unknownCard = buildCard(unknown);
  // Then each type bar is green (no marker -> default)
  assert.equal(typeBar(ppCard).className, 'task-card-type', 'post-processing recipe -> green');
  assert.equal(typeBar(unknownCard).className, 'task-card-type', 'unknown-status -> green');
});

// ===========================================================================
// Scenario: Bar updates on the poll cycle
// ===========================================================================
test('Scenario: adding bug-of and bumping updated flips the bar to red within one poll', () => {
  // Given a rendered green-bar ticket
  const before = { id: 'TASK-107', title: 'x', status: 'todo', updated: '2026-07-19T00:00:00.000Z' };
  assert.equal(typeBar(buildCard(before)).className, 'task-card-type', 'starts green');
  const sigBefore = renderSignature(before);
  // When "bug-of: TASK-001" is added to its file on disk and "updated" is bumped
  const after = Object.assign({}, before, { 'bug-of': 'TASK-001', updated: '2026-07-19T01:00:00.000Z' });
  const sigAfter = renderSignature(after);
  // Then the render signature changes (so the board re-renders within one poll)
  assert.notEqual(sigAfter, sigBefore, 'bumping updated changes the id|status|updated signature -> re-render');
  // And the newly-rendered card's type bar is red (derived purely from frontmatter).
  assert.equal(typeBar(buildCard(after)).className, 'task-card-type bug', 'the bar is red after the marker lands');
});

test('DRIFT GUARD: the board re-render signature keys on id|status|updated (poll-cycle basis)', () => {
  assert.match(rendererSrc, /`\$\{tk\.fm\.id\}\|\$\{tk\.fm\.status\}\|\$\{tk\.fm\.updated\}`/,
    'the poll re-render signature must include updated so a marker edit that bumps updated re-renders');
});

// ===========================================================================
// Scenario: Existing indicators are unaffected (edge)
// ===========================================================================
test('Scenario (edge): a failed-testing bug ticket shows BOTH the red type bar and the red failed dot without overlap', () => {
  // Given a bug ticket with status "failed-testing"
  const fm = { id: 'TASK-108', title: 'Broken bug fix', status: 'failed-testing', 'bug-of': 'TASK-031', updated: 'x' };
  // When the board renders its card (folds into the Testing lane)
  const card = buildCard(fm);
  // Then the card shows the red type bar ...
  const bar = typeBar(card);
  assert.ok(hasMod(bar, 'bug'), 'the red .bug type bar is present');
  // ... AND the red failed dot ...
  const dot = card._children.find((c) => baseClass(c) === 'task-card-dot');
  assert.ok(dot, 'the working/failed dot is present');
  assert.ok(hasMod(dot, 'failed'), 'the dot carries the red .failed modifier');
  // ... as two distinct nodes (no overlap: the dot is absolutely positioned,
  // the type bar is a thin in-flow strip).
  assert.notEqual(bar, dot, 'the type bar and the failed dot are different DOM nodes');
  const dotRule = cssSrc.slice(cssSrc.indexOf('.task-card-dot {'), cssSrc.indexOf('@keyframes task-card-dot-pulse'));
  assert.match(dotRule, /position:\s*absolute/, 'the dot is absolutely positioned (top-right), so it never overlaps the in-flow bar');
  const typeRule = cssSrc.slice(cssSrc.indexOf('.task-card-type {'), cssSrc.indexOf('.task-card-type.bug'));
  assert.ok(!/position:\s*absolute/.test(typeRule), 'the type bar stays in normal flow');
});

// ===========================================================================
// Scenario: the bar renders inside the Done lane's "Archived (N)" expander (edge)
// ===========================================================================
test('Scenario (edge): an archived done card carries its type bar into the Archived expander', () => {
  // Given a done bug ticket old enough to be archived (TASK-065 expander fold)
  const now = Date.parse('2026-07-19T00:00:00.000Z');
  const oldUpdated = new Date(now - (R.TASKS_ARCHIVE_AFTER_MS + 60000)).toISOString();
  const fm = { id: 'TASK-109', title: 'Old fixed bug', status: 'done', 'bug-of': 'TASK-031', updated: oldUpdated };
  // Sanity: this ticket really is archived (uses the REAL ticketIsArchived).
  assert.equal(R.ticketIsArchived(fm, now), true, 'the ticket qualifies for the Archived expander');
  // When the board renders and folds archived done cards into the expander body
  const card = buildCard(fm);
  const expanderBody = makeEl('div');
  expanderBody.className = 'tasks-archived-cards';
  if (fm.status === 'done' && R.ticketIsArchived(fm, now)) {
    expanderBody.appendChild(card); // mirrors renderer.js ~5980-6003
  }
  // Then the same card node (with its red type bar) lives inside the expander body.
  assert.equal(expanderBody._children.length, 1, 'the archived card is folded into the expander');
  const foldedCard = expanderBody._children[0];
  const bar = typeBar(foldedCard);
  assert.ok(bar, 'the archived card still carries a type bar');
  assert.ok(hasMod(bar, 'bug'), 'and it is red (the marker survives the archival fold)');
  // And it is still positioned after the id and before the title inside the fold.
  assert.ok(childIndexByBase(foldedCard, 'task-card-id') < childIndexByBase(foldedCard, 'task-card-type'));
  assert.ok(childIndexByBase(foldedCard, 'task-card-type') < childIndexByBase(foldedCard, 'task-card-title'));
});

// ===========================================================================
// TASK-082 — Feature: Card type bar has a text alternative for accessibility.
// The bar carries a title/aria-label describing its type, derived from the same
// predicates as the color (bug wins over review), set via attribute not innerHTML.
// ===========================================================================
test('Scenario: a bug card exposes a "Bug" label on the type bar', () => {
  // Given a ticket whose frontmatter has non-empty bug-of
  const fm = { id: 'TASK-200', title: 'Toggle regression', status: 'todo', 'bug-of': 'TASK-031', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the type bar's title/aria-label is "Bug"
  assert.equal(typeBarLabel(card), 'Bug', 'title and aria-label read "Bug"');
  // And the bar is red (label matches the color class).
  assert.ok(hasMod(typeBar(card), 'bug'), 'and the bar is red (.bug)');
});

test('Scenario: a review card exposes a "Review" label on the type bar', () => {
  // Given a ticket whose frontmatter has non-empty review-of
  const fm = { id: 'TASK-201', title: 'Address review comments', status: 'todo', 'review-of': 'TASK-046', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the type bar's title/aria-label is "Review"
  assert.equal(typeBarLabel(card), 'Review');
  assert.ok(hasMod(typeBar(card), 'review'), 'and the bar is yellow (.review)');
});

test('Scenario (edge): a normal card exposes a "Normal" label on the type bar', () => {
  // Given a ticket with no bug-of and no review-of
  const fm = { id: 'TASK-202', title: 'Routine work', status: 'todo', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the type bar's title/aria-label is "Normal"
  assert.equal(typeBarLabel(card), 'Normal');
  assert.equal(typeBar(card).className, 'task-card-type', 'and the bar is green (default, no modifier)');
});

test('Scenario (edge, precedence): both markers -> "Bug" label AND a red bar', () => {
  // Given a ticket with non-empty bug-of and non-empty review-of
  const fm = { id: 'TASK-203', title: 'x', status: 'todo', 'bug-of': 'TASK-031', 'review-of': 'TASK-046', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the type bar's title/aria-label is "Bug" and the bar is red
  assert.equal(typeBarLabel(card), 'Bug', 'bug wins over review for the label, matching the color');
  assert.equal(typeBar(card).className, 'task-card-type bug', 'and the bar is red (.bug), not yellow');
});

test('Scenario (edge): the label is derived from predicates, never from title text', () => {
  // Given a ticket titled "bug in login" but with NO bug-of frontmatter
  const fm = { id: 'TASK-204', title: 'bug in login', status: 'todo', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  // Then the label is "Normal" (the word "bug" in the title does not fabricate a Bug label)
  assert.equal(typeBarLabel(card), 'Normal', 'title text must not drive the label');
  assert.equal(typeBar(card).className, 'task-card-type', 'and the bar stays green');
});

test('Scenario (edge): a whitespace-only marker labels "Normal" (matches green fallback)', () => {
  for (const marker of [{ 'bug-of': '   ' }, { 'review-of': '\t ' }]) {
    const fm = Object.assign({ id: 'TASK-205', title: 'x', status: 'todo', updated: 'x' }, marker);
    const card = buildCard(fm);
    assert.equal(typeBarLabel(card), 'Normal', `${JSON.stringify(marker)} -> Normal label`);
    assert.equal(typeBar(card).className, 'task-card-type', 'and green bar');
  }
});

test('Scenario (edge): the label is set via attribute (title/aria-label), never innerHTML', () => {
  // Given any rendered card
  const card = buildCard({ id: 'TASK-206', title: 'x', status: 'todo', 'bug-of': 'TASK-031', updated: 'x' });
  const bar = typeBar(card);
  // Then the label lives on the title property and the aria-label attribute...
  assert.equal(bar.title, 'Bug');
  assert.equal(bar.getAttribute('aria-label'), 'Bug');
  // ...and the bar's textContent is empty (no text/markup injected into the DOM node).
  assert.equal(bar.textContent, '', 'the type bar carries no text content / innerHTML');
});

test('DRIFT GUARD (TASK-082): the fake-DOM builder mirrors the real label expression + attribute wiring', () => {
  // Tie the harness above to the real renderTasksBoard: the label expression and
  // its title/aria-label application must match production source exactly.
  assert.match(
    rendererSrc,
    /const typeLabel = isBugTicket\(tk\.fm\) \? 'Bug' : \(isReviewTicket\(tk\.fm\) \? 'Review' : 'Normal'\);/,
    'real label expression is bug ? Bug : review ? Review : Normal',
  );
  assert.match(rendererSrc, /typeEl\.title = typeLabel;/, 'real code sets the label via title');
  assert.match(rendererSrc, /typeEl\.setAttribute\('aria-label', typeLabel\);/, 'real code mirrors it to aria-label');
  // And the type-bar construction block never uses innerHTML.
  const start = rendererSrc.indexOf("const typeEl = document.createElement('div');");
  const end = rendererSrc.indexOf('card.appendChild(typeEl);');
  assert.ok(!/typeEl\.innerHTML/.test(rendererSrc.slice(start, end)), 'no innerHTML on the type bar');
});

test('DRIFT GUARD: archived done cards are the SAME card nodes appended to the Archived expander body', () => {
  // Ties the fold model above to the real source: the same `card` built earlier is
  // pushed into archivedDoneCards and then appended to the expander body node.
  assert.match(rendererSrc, /if \(laneKey === 'done' && ticketIsArchived\(tk\.fm, now\)\) \{\s*archivedDoneCards\.push\(card\);/,
    'archived done cards reuse the same constructed card node (type bar included)');
  assert.match(rendererSrc, /for \(const c of archivedDoneCards\) body\.appendChild\(c\);/,
    'the archived card nodes are appended into the expander body');
});

// ===========================================================================
// TASK-083 — Feature: Card type bar is announceable to screen readers.
// The type bar carries role="img" alongside its aria-label ("Bug"/"Review"/
// "Normal") so assistive tech reliably exposes the type. The role is set on the
// SAME universal construction path (every card, every type/status incl. archived
// / unknown), via setAttribute (never innerHTML), and keeps the strip
// non-interactive (no tabindex). The label/color logic from TASK-082/075 is
// unchanged. The fake-DOM builder above sets role the way the real code does.
// ===========================================================================

// The type bar's announceable role must be exactly "img".
const typeBarRole = (card) => typeBar(card).getAttribute('role');

test('Scenario: the type bar of a bug card carries role="img" and aria-label "Bug"', () => {
  // Given a bug ticket (non-empty bug-of)
  const fm = { id: 'TASK-300', title: 'Toggle regression', status: 'todo', 'bug-of': 'TASK-031', updated: 'x' };
  // When the board renders its card
  const card = buildCard(fm);
  const bar = typeBar(card);
  // Then the type bar has role "img" and aria-label "Bug"
  assert.equal(typeBarRole(card), 'img', 'the type bar announces as an image role');
  assert.equal(bar.getAttribute('aria-label'), 'Bug', 'and its aria-label reads "Bug"');
  assert.equal(bar.title, 'Bug', 'and its title still reads "Bug" (TASK-082 unchanged)');
  assert.ok(hasMod(bar, 'bug'), 'and the bar is red (.bug), color logic unchanged');
});

test('Scenario (edge): review and normal cards are likewise announceable (role="img" + their labels)', () => {
  // Given a review ticket and a normal ticket
  const review = { id: 'TASK-301', title: 'Address review comments', status: 'todo', 'review-of': 'TASK-046', updated: 'x' };
  const normal = { id: 'TASK-302', title: 'Routine work', status: 'todo', updated: 'x' };
  // When the board renders their cards
  const reviewCard = buildCard(review);
  const normalCard = buildCard(normal);
  // Then each type bar has role "img" with aria-label "Review" and "Normal" respectively
  assert.equal(typeBarRole(reviewCard), 'img', 'review card type bar announces as img');
  assert.equal(typeBar(reviewCard).getAttribute('aria-label'), 'Review');
  assert.ok(hasMod(typeBar(reviewCard), 'review'), 'and the review bar is yellow (.review)');
  assert.equal(typeBarRole(normalCard), 'img', 'normal card type bar announces as img');
  assert.equal(typeBar(normalCard).getAttribute('aria-label'), 'Normal');
  assert.equal(typeBar(normalCard).className, 'task-card-type', 'and the normal bar is green (no modifier)');
});

test('Scenario (edge): the role is applied on the universal path — every card carries role="img" regardless of type/status', () => {
  // Given cards spanning every type and several statuses (incl. unknown-status)
  const cards = [
    { id: 'TASK-303', title: 'bug', status: 'todo', 'bug-of': 'TASK-031', updated: 'x' },
    { id: 'TASK-304', title: 'review', status: 'in-progress', 'review-of': 'TASK-046', updated: 'x' },
    { id: 'TASK-305', title: 'normal', status: 'todo', updated: 'x' },
    { id: 'TASK-306', title: 'both markers', status: 'failed-testing', 'bug-of': 'TASK-031', 'review-of': 'TASK-046', updated: 'x' },
    { id: 'TASK-307', title: 'post-processing', status: 'todo', kind: 'post-processing', updated: 'x' },
    { id: 'TASK-308', title: 'unknown status', status: 'totally-bogus-status', updated: 'x' },
    { id: 'TASK-309', title: 'empty markers', status: 'todo', 'bug-of': '   ', 'review-of': '', updated: 'x' },
  ];
  // When the board renders each card
  // Then every type bar carries role="img" regardless of type/status, alongside its label
  for (const fm of cards) {
    const card = buildCard(fm);
    assert.equal(typeBarRole(card), 'img', `${fm.id} (${fm.status}) type bar has role="img"`);
    const label = typeBar(card).getAttribute('aria-label');
    assert.ok(['Bug', 'Review', 'Normal'].includes(label), `${fm.id} carries a fixed-literal label alongside the role`);
  }
});

test('Scenario (edge): an archived done card carries role="img" on its type bar inside the Archived expander', () => {
  // Given a done bug ticket old enough to be archived (TASK-065 expander fold)
  const now = Date.parse('2026-07-19T00:00:00.000Z');
  const oldUpdated = new Date(now - (R.TASKS_ARCHIVE_AFTER_MS + 60000)).toISOString();
  const fm = { id: 'TASK-310', title: 'Old fixed bug', status: 'done', 'bug-of': 'TASK-031', updated: oldUpdated };
  assert.equal(R.ticketIsArchived(fm, now), true, 'the ticket qualifies for the Archived expander');
  // When the board renders and folds the archived done card into the expander body
  const card = buildCard(fm);
  const expanderBody = makeEl('div');
  expanderBody.className = 'tasks-archived-cards';
  if (fm.status === 'done' && R.ticketIsArchived(fm, now)) expanderBody.appendChild(card);
  // Then the folded card's type bar still carries role="img" and its "Bug" label
  const bar = typeBar(expanderBody._children[0]);
  assert.equal(bar.getAttribute('role'), 'img', 'the archived card type bar is still announceable');
  assert.equal(bar.getAttribute('aria-label'), 'Bug', 'and still labelled "Bug"');
});

test('Scenario (edge): malformed/absent frontmatter still labels "Normal" with role="img" and never throws', () => {
  // Given tickets with missing/blank type markers (worst-case frontmatter)
  const cases = [
    { id: 'TASK-311', title: 'x', status: 'todo', updated: 'x' },
    { id: 'TASK-312', title: 'x', status: 'todo', 'bug-of': '', 'review-of': '   ', updated: 'x' },
  ];
  for (const fm of cases) {
    // When the board renders the card
    let card;
    assert.doesNotThrow(() => { card = buildCard(fm); }, `${fm.id} renders without throwing`);
    // Then the type bar is announceable (role="img") with the "Normal" fallback label
    assert.equal(typeBar(card).getAttribute('role'), 'img', `${fm.id} type bar has role="img"`);
    assert.equal(typeBar(card).getAttribute('aria-label'), 'Normal', `${fm.id} falls back to "Normal"`);
  }
});

test('Scenario (edge): the type bar is NOT focusable/interactive — no tabindex is set on it', () => {
  // Given any rendered card
  const card = buildCard({ id: 'TASK-313', title: 'x', status: 'todo', 'bug-of': 'TASK-031', updated: 'x' });
  const bar = typeBar(card);
  // Then the role="img" strip carries no tabindex (stays non-focusable/non-interactive)
  assert.equal(bar.getAttribute('role'), 'img', 'the bar has the img role');
  assert.equal(bar.getAttribute('tabindex'), null, 'the type bar has no tabindex attribute');
  assert.equal(bar.tabIndex, undefined, 'and no tabIndex property is set on the node');
});

test('Scenario (edge): the role/label are set via setAttribute, never innerHTML (no injected markup)', () => {
  // Given any rendered card
  const card = buildCard({ id: 'TASK-314', title: 'x', status: 'todo', 'review-of': 'TASK-046', updated: 'x' });
  const bar = typeBar(card);
  // Then role and aria-label live on attributes and the node carries no text/markup
  assert.equal(bar.getAttribute('role'), 'img');
  assert.equal(bar.getAttribute('aria-label'), 'Review');
  assert.equal(bar.textContent, '', 'the type bar carries no text content / innerHTML');
});

test('DRIFT GUARD (TASK-083): the fake-DOM builder mirrors the real role wiring in renderTasksBoard', () => {
  // Tie the harness above to the real renderTasksBoard: the role must be set as a
  // fixed literal via setAttribute on the type-bar construction path, unchanged
  // label/color logic, no innerHTML, no tabindex.
  const start = rendererSrc.indexOf("const typeEl = document.createElement('div');");
  const end = rendererSrc.indexOf('card.appendChild(typeEl);');
  assert.ok(start !== -1 && end !== -1 && start < end, 'the type-bar construction block is present');
  const block = rendererSrc.slice(start, end);
  assert.match(block, /typeEl\.setAttribute\('role', 'img'\);/, "real code sets role='img' via setAttribute");
  assert.match(block, /typeEl\.setAttribute\('aria-label', typeLabel\);/, 'aria-label wiring (TASK-082) intact');
  assert.match(block, /const typeLabel = isBugTicket\(tk\.fm\) \? 'Bug' : \(isReviewTicket\(tk\.fm\) \? 'Review' : 'Normal'\);/,
    'label expression (TASK-082) intact');
  assert.ok(!/typeEl\.innerHTML/.test(block), 'no innerHTML on the type bar');
  assert.ok(!/typeEl\.tabIndex/.test(block) && !/setAttribute\('tabindex'/i.test(block),
    'the type bar sets no tabindex (role="img" stays non-interactive)');
});
