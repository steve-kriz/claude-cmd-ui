'use strict';

// ===========================================================================
// TASK-075 — UNIT tests for the colored "ticket type" bar on board cards
// (green normal / red bug / yellow PR-review).
//
// The type derivation lives in two tiny pure predicates in renderer/renderer.js
// (~5246-5251):
//   isBugTicket(fm)    = ticketFieldNonEmpty(fm['bug-of'])     -> red  (.bug)
//   isReviewTicket(fm) = ticketFieldNonEmpty(fm['review-of'])  -> yellow (.review)
// green is the default (no modifier). renderer/renderer.js is a BROWSER script
// (no module.exports, references `document`) so it cannot be require()'d. Matching
// the repo convention (test/tasks-working-indicator.test.js), we EXTRACT the real
// predicate source out of renderer.js and EVALUATE it headless, so this test runs
// the app's actual logic rather than a hand-copied replica. Source-scan drift
// guards tie the render-time class composition, DOM insertion point, and CSS
// colors back to the real files.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK. The only I/O is reading the
// app's own source files as text fixtures.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// --- Extract a named `function foo(...) { ... }` declaration from source by
// brace-matching, so we can evaluate the REAL predicate headless. ---
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// Load the real predicates (ticketFieldNonEmpty + isBugTicket + isReviewTicket)
// out of renderer.js and evaluate them in an isolated scope.
const { ticketFieldNonEmpty, isBugTicket, isReviewTicket } = (function loadPredicates() {
  const body = [
    extractFn(rendererSrc, 'ticketFieldNonEmpty'),
    extractFn(rendererSrc, 'isBugTicket'),
    extractFn(rendererSrc, 'isReviewTicket'),
    'return { ticketFieldNonEmpty, isBugTicket, isReviewTicket };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
})();

// The EXACT render-time class composition (renderer.js ~5928-5929). Bug is
// checked first, so red wins when both markers are present; otherwise review
// (yellow); otherwise the bare `.task-card-type` (green default).
function typeClass(fm) {
  return 'task-card-type' + (isBugTicket(fm) ? ' bug' : (isReviewTicket(fm) ? ' review' : ''));
}

// The EXACT render-time text-alternative expression (renderer.js ~5935, TASK-082).
// Derived from the SAME predicates as the color, bug checked first (bug wins over
// review), a fixed literal per type (never interpolated from ticket text).
function typeLabel(fm) {
  return isBugTicket(fm) ? 'Bug' : (isReviewTicket(fm) ? 'Review' : 'Normal');
}

// ===========================================================================
// isBugTicket — trimmed-non-empty `bug-of` detection
// ===========================================================================
test('UNIT: isBugTicket is true only for a trimmed-non-empty bug-of', () => {
  assert.equal(isBugTicket({ 'bug-of': 'TASK-031' }), true);
  assert.equal(isBugTicket({ 'bug-of': '  TASK-031  ' }), true, 'surrounding whitespace still counts');
});

test('UNIT: isBugTicket is false for empty / whitespace / missing bug-of (green default)', () => {
  assert.equal(isBugTicket({ 'bug-of': '' }), false, 'empty string is not a bug');
  assert.equal(isBugTicket({ 'bug-of': '   ' }), false, 'whitespace-only is not a bug');
  assert.equal(isBugTicket({ 'bug-of': '\t\n ' }), false, 'tabs/newlines only is not a bug');
  assert.equal(isBugTicket({ 'bug-of': null }), false);
  assert.equal(isBugTicket({ 'bug-of': undefined }), false);
  assert.equal(isBugTicket({}), false, 'no bug-of key at all');
});

test('UNIT: isBugTicket guards against a non-object frontmatter', () => {
  for (const bad of [null, undefined, 0, '', false]) {
    assert.equal(isBugTicket(bad), false, `${JSON.stringify(bad)} is not a bug ticket`);
  }
});

// ===========================================================================
// isReviewTicket — trimmed-non-empty `review-of` detection
// ===========================================================================
test('UNIT: isReviewTicket is true only for a trimmed-non-empty review-of', () => {
  assert.equal(isReviewTicket({ 'review-of': 'TASK-046' }), true);
  assert.equal(isReviewTicket({ 'review-of': '  TASK-046 ' }), true);
});

test('UNIT: isReviewTicket is false for empty / whitespace / missing review-of (green default)', () => {
  assert.equal(isReviewTicket({ 'review-of': '' }), false);
  assert.equal(isReviewTicket({ 'review-of': '   ' }), false);
  assert.equal(isReviewTicket({ 'review-of': null }), false);
  assert.equal(isReviewTicket({}), false);
});

test('UNIT: isReviewTicket guards against a non-object frontmatter', () => {
  for (const bad of [null, undefined, 42, '', false]) {
    assert.equal(isReviewTicket(bad), false);
  }
});

test('UNIT: a review marker never fabricated from title text — frontmatter only', () => {
  // No `review-of` key even though the title reads "follow-up" -> stays green.
  assert.equal(isReviewTicket({ title: 'PR review follow-up for TASK-046', status: 'todo' }), false);
  assert.equal(typeClass({ title: 'PR review follow-up', status: 'todo' }), 'task-card-type',
    'green default: type is never inferred from title text');
});

// ===========================================================================
// typeClass composition — the three colors + precedence + edges
// ===========================================================================
test('UNIT: a plain ticket composes the bare green .task-card-type (no modifier)', () => {
  assert.equal(typeClass({ id: 'TASK-1', status: 'todo' }), 'task-card-type');
});

test('UNIT: a non-empty bug-of composes .task-card-type.bug (red)', () => {
  assert.equal(typeClass({ 'bug-of': 'TASK-031' }), 'task-card-type bug');
});

test('UNIT: a non-empty review-of composes .task-card-type.review (yellow)', () => {
  assert.equal(typeClass({ 'review-of': 'TASK-046' }), 'task-card-type review');
});

test('UNIT: both markers present -> red wins (bug precedence)', () => {
  assert.equal(typeClass({ 'bug-of': 'TASK-031', 'review-of': 'TASK-046' }), 'task-card-type bug',
    'bug is checked first, so red wins over yellow');
});

test('UNIT: an empty bug-of but non-empty review-of falls through to yellow', () => {
  assert.equal(typeClass({ 'bug-of': '   ', 'review-of': 'TASK-046' }), 'task-card-type review',
    'a whitespace-only bug-of does not out-rank a real review-of');
});

test('UNIT: empty markers on both fall back to green', () => {
  assert.equal(typeClass({ 'bug-of': '', 'review-of': '   ' }), 'task-card-type');
});

test('UNIT: post-processing and unknown-status tickets are green', () => {
  assert.equal(typeClass({ status: 'todo', kind: 'post-processing' }), 'task-card-type',
    'a post-processing recipe with no markers is green');
  assert.equal(typeClass({ status: 'totally-bogus' }), 'task-card-type',
    'an unknown-status ticket with no markers is green');
});

// ===========================================================================
// TASK-082 — type-bar text alternative (title / aria-label) label
// The label mirrors the color-class precedence exactly and is derived from the
// same predicates (never from title text). Fixed literal per type.
// ===========================================================================
test('UNIT: a bug ticket (non-empty bug-of) labels the type bar "Bug"', () => {
  assert.equal(typeLabel({ 'bug-of': 'TASK-031' }), 'Bug');
  assert.equal(typeLabel({ 'bug-of': '  TASK-031  ' }), 'Bug', 'surrounding whitespace still counts');
});

test('UNIT: a review ticket (non-empty review-of) labels the type bar "Review"', () => {
  assert.equal(typeLabel({ 'review-of': 'TASK-046' }), 'Review');
});

test('UNIT: a plain ticket (neither marker) labels the type bar "Normal"', () => {
  assert.equal(typeLabel({ id: 'TASK-1', status: 'todo' }), 'Normal');
  assert.equal(typeLabel({ 'bug-of': '', 'review-of': '   ' }), 'Normal', 'empty/whitespace markers -> Normal');
});

test('UNIT: both markers present -> "Bug" label (bug precedence, matches red)', () => {
  const fm = { 'bug-of': 'TASK-031', 'review-of': 'TASK-046' };
  assert.equal(typeLabel(fm), 'Bug', 'bug is checked first, so the label is Bug when both markers are present');
  assert.equal(typeClass(fm), 'task-card-type bug', 'and the color class is red (.bug) in the same case');
});

test('UNIT: the label matches the color class for every type (label/color never disagree)', () => {
  const cases = [
    { fm: { 'bug-of': 'TASK-031' }, label: 'Bug', cls: 'task-card-type bug' },
    { fm: { 'review-of': 'TASK-046' }, label: 'Review', cls: 'task-card-type review' },
    { fm: { id: 'TASK-1' }, label: 'Normal', cls: 'task-card-type' },
    { fm: { 'bug-of': 'TASK-031', 'review-of': 'TASK-046' }, label: 'Bug', cls: 'task-card-type bug' },
    { fm: { 'bug-of': '   ', 'review-of': 'TASK-046' }, label: 'Review', cls: 'task-card-type review' },
  ];
  for (const { fm, label, cls } of cases) {
    assert.equal(typeLabel(fm), label, `label for ${JSON.stringify(fm)}`);
    assert.equal(typeClass(fm), cls, `color class for ${JSON.stringify(fm)}`);
    // The color class carries `.bug` iff the label is "Bug", `.review` iff "Review".
    assert.equal(/\bbug\b/.test(cls), label === 'Bug', 'red iff Bug');
    assert.equal(/\breview\b/.test(cls), label === 'Review', 'yellow iff Review');
  }
});

test('UNIT: the label is derived from predicates, never from title text', () => {
  // A ticket titled "bug in login" but with NO bug-of frontmatter -> "Normal".
  assert.equal(typeLabel({ title: 'bug in login', status: 'todo' }), 'Normal',
    'the word "bug" in the title must not fabricate a Bug label');
  assert.equal(typeLabel({ title: 'PR review follow-up', status: 'todo' }), 'Normal',
    'the words "PR review" in the title must not fabricate a Review label');
});

test('UNIT: malformed / absent frontmatter labels "Normal" and never throws', () => {
  for (const bad of [null, undefined, 0, '', false, {}]) {
    assert.doesNotThrow(() => typeLabel(bad), `typeLabel(${JSON.stringify(bad)}) must not throw`);
    assert.equal(typeLabel(bad), 'Normal', `${JSON.stringify(bad)} -> Normal`);
  }
});

// ===========================================================================
// DRIFT GUARDS — tie the extracted logic + evaluated class to the real source.
// ===========================================================================
test('DRIFT GUARD: the predicates use ticketFieldNonEmpty on the exact hyphenated keys', () => {
  assert.match(rendererSrc, /function isBugTicket\(fm\)\s*\{\s*return !!fm && ticketFieldNonEmpty\(fm\['bug-of'\]\);\s*\}/,
    "isBugTicket must be ticketFieldNonEmpty(fm['bug-of'])");
  assert.match(rendererSrc, /function isReviewTicket\(fm\)\s*\{\s*return !!fm && ticketFieldNonEmpty\(fm\['review-of'\]\);\s*\}/,
    "isReviewTicket must be ticketFieldNonEmpty(fm['review-of'])");
});

test('DRIFT GUARD: ticketFieldNonEmpty is a trimmed-non-empty check (not raw truthiness)', () => {
  assert.match(rendererSrc, /function ticketFieldNonEmpty\(v\)\s*\{\s*return v != null && String\(v\)\.trim\(\) !== '';\s*\}/);
});

test('DRIFT GUARD: renderTasksBoard composes the type class bug-first (red wins), review else, green default', () => {
  assert.match(
    rendererSrc,
    /typeEl\.className = 'task-card-type' \+\s*\(isBugTicket\(tk\.fm\) \? ' bug' : \(isReviewTicket\(tk\.fm\) \? ' review' : ''\)\);/,
    'the render-time class composition must be bug ? " bug" : review ? " review" : "" (green default)',
  );
});

test('DRIFT GUARD (TASK-082): renderTasksBoard derives the label from the same predicates, bug-first', () => {
  assert.match(
    rendererSrc,
    /const typeLabel = isBugTicket\(tk\.fm\) \? 'Bug' : \(isReviewTicket\(tk\.fm\) \? 'Review' : 'Normal'\);/,
    "the label must be isBugTicket ? 'Bug' : isReviewTicket ? 'Review' : 'Normal' (same predicates, bug wins)",
  );
});

test('DRIFT GUARD (TASK-082): the label is set via title/aria-label attribute, NOT innerHTML', () => {
  // Isolate the type-bar construction block (from the typeEl create to its append).
  const start = rendererSrc.indexOf("const typeEl = document.createElement('div');");
  const end = rendererSrc.indexOf('card.appendChild(typeEl);');
  assert.ok(start !== -1 && end !== -1 && start < end, 'the type-bar construction block is present');
  const block = rendererSrc.slice(start, end);
  assert.match(block, /typeEl\.title = typeLabel;/, 'the label is applied via the title property');
  assert.match(block, /typeEl\.setAttribute\('aria-label', typeLabel\);/, 'and mirrored to aria-label');
  assert.ok(!/typeEl\.innerHTML/.test(block), 'the type bar never uses innerHTML (no injection surface)');
});

// ===========================================================================
// TASK-083 — the type bar carries an announceable role so its aria-label is
// exposed to screen readers. The reliable pattern for a purely-decorative
// colored strip is role="img" paired with the aria-label. The role is a fixed
// literal ('img') set unconditionally on the SAME universal construction path
// as the color/label, so it renders for every card (bug/review/normal, incl.
// archived / unknown-status). It must NOT make the strip focusable/interactive
// (no tabindex). Applied via setAttribute, never innerHTML. The label/color
// logic from TASK-082/075 is unchanged. renderer.js is a browser script, so —
// like the label logic above — the role is a fixed literal (not derived from
// frontmatter), and these are source-scan drift guards over the real
// renderTasksBoard construction block.
// ===========================================================================

// Isolate the type-bar construction block once for the TASK-083 role guards
// (from the typeEl create up to — but not including — its append).
function typeBarBlock() {
  const start = rendererSrc.indexOf("const typeEl = document.createElement('div');");
  const end = rendererSrc.indexOf('card.appendChild(typeEl);');
  assert.ok(start !== -1 && end !== -1 && start < end, 'the type-bar construction block is present');
  return rendererSrc.slice(start, end);
}

test('UNIT (TASK-083): the type bar sets role="img" via setAttribute on the construction path', () => {
  const block = typeBarBlock();
  assert.match(block, /typeEl\.setAttribute\('role', 'img'\);/,
    "the type bar must set role='img' via setAttribute so its aria-label is announceable");
});

test('UNIT (TASK-083): the role is a fixed literal "img" (never ticket-controlled / interpolated)', () => {
  const block = typeBarBlock();
  // The role literal is the constant string 'img' — not a template/variable, so
  // it can never be driven by ticket frontmatter text.
  assert.ok(!/setAttribute\('role',\s*`/.test(block), 'role value is not a template literal');
  assert.ok(!/setAttribute\('role',\s*typeLabel\)/.test(block), 'role value is not the label variable');
  assert.match(block, /setAttribute\('role', 'img'\)/, "role is the fixed literal 'img'");
});

test('UNIT (TASK-083): the role is set unconditionally (universal path) — same block, no if-guard around it', () => {
  const block = typeBarBlock();
  // The role line sits at the top level of the construction block (mirroring the
  // aria-label line just above it), so it applies to every card regardless of
  // type/status. Assert the aria-label and role are set on adjacent statements
  // with no conditional gating between them.
  assert.match(
    block,
    /typeEl\.setAttribute\('aria-label', typeLabel\);\s*(?:\/\/[^\n]*\n\s*)*typeEl\.setAttribute\('role', 'img'\);/,
    'role="img" follows the aria-label assignment unconditionally on the universal construction path',
  );
});

test('UNIT (TASK-083): the type bar is NON-interactive — no tabindex is ever set on it', () => {
  const block = typeBarBlock();
  assert.ok(!/typeEl\.tabIndex/.test(block), 'the type bar sets no tabIndex property');
  assert.ok(!/setAttribute\('tabindex'/i.test(block),
    'the type bar sets no tabindex attribute (role="img" stays non-focusable/non-interactive)');
});

test('UNIT (TASK-083): the role/label are set via attributes, the type bar never uses innerHTML', () => {
  const block = typeBarBlock();
  assert.match(block, /typeEl\.setAttribute\('role', 'img'\);/, 'role via setAttribute');
  assert.match(block, /typeEl\.setAttribute\('aria-label', typeLabel\);/, 'aria-label via setAttribute');
  assert.ok(!/typeEl\.innerHTML/.test(block), 'no innerHTML on the type bar (no injection surface)');
});

test('DRIFT GUARD (TASK-083): TASK-082 label logic is unchanged — role is ADDED, not a replacement', () => {
  const block = typeBarBlock();
  // The role addition must not have disturbed the label derivation or the
  // title/aria-label wiring from TASK-082.
  assert.match(block, /const typeLabel = isBugTicket\(tk\.fm\) \? 'Bug' : \(isReviewTicket\(tk\.fm\) \? 'Review' : 'Normal'\);/,
    'the TASK-082 label expression is intact');
  assert.match(block, /typeEl\.title = typeLabel;/, 'the TASK-082 title assignment is intact');
  assert.match(block, /typeEl\.setAttribute\('aria-label', typeLabel\);/, 'the TASK-082 aria-label assignment is intact');
  // And the TASK-075 color-class composition is intact.
  assert.match(block, /typeEl\.className = 'task-card-type' \+\s*\(isBugTicket\(tk\.fm\) \? ' bug' : \(isReviewTicket\(tk\.fm\) \? ' review' : ''\)\);/,
    'the TASK-075 color-class composition is intact');
});

test('DRIFT GUARD: the type bar is inserted AFTER .task-card-id and BEFORE .task-card-title', () => {
  const appendId = rendererSrc.indexOf('card.appendChild(idEl);');
  const createType = rendererSrc.indexOf("const typeEl = document.createElement('div');");
  const appendType = rendererSrc.indexOf('card.appendChild(typeEl);');
  const appendTitle = rendererSrc.indexOf('card.appendChild(titleEl);');
  assert.ok(appendId !== -1 && createType !== -1 && appendType !== -1 && appendTitle !== -1,
    'the id append, type element, type append and title append all exist');
  assert.ok(appendId < appendType, 'the type bar is appended after the id header');
  assert.ok(appendType < appendTitle, 'the type bar is appended before the title');
});

// ===========================================================================
// DRIFT GUARD: CSS colors match the required palette.
// ===========================================================================
test('DRIFT GUARD: .task-card-type defaults to green #6a9955, .bug is red #f14c4c, .review is yellow #e5c100', () => {
  assert.match(cssSrc, /\.task-card-type\s*\{[^}]*background:\s*#6a9955/i, 'green default #6a9955');
  assert.match(cssSrc, /\.task-card-type\.bug\s*\{[^}]*background:\s*#f14c4c/i, 'bug red #f14c4c');
  assert.match(cssSrc, /\.task-card-type\.review\s*\{[^}]*background:\s*#e5c100/i, 'review yellow #e5c100');
});

test('DRIFT GUARD: the type bar is a thin in-flow strip (has a height, no absolute positioning)', () => {
  const rule = cssSrc.slice(cssSrc.indexOf('.task-card-type {'), cssSrc.indexOf('.task-card-type.bug'));
  assert.match(rule, /height:\s*3px/, 'the bar is a thin 3px strip');
  assert.ok(!/position:\s*absolute/.test(rule),
    'the type bar is in normal flow (not absolute) so it never overlaps the absolutely-positioned dot');
});
