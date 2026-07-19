'use strict';

// ===========================================================================
// TASK-028 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases (no cucumber npm package is installed or required).
//
// Feature: Post-processing lane replaces the failed-testing lane on the Tasks
// board. The failed-testing *lane* is gone; a post-processing lane takes its
// 5th-position slot. failed-testing stays a valid, claimable fix-loop status
// (folded into Testing with its red dot). Post-processing tickets (kind:
// post-processing) are recipes run against normal tasks after review and are
// NEVER built/tested/claimed by the swarm.
//
// NO DATABASE, REAL FILESYSTEM WRITE, OR NETWORK CALL IS MADE. The pure lib
// modules (lib/ticket-lanes.js, lib/ticket-folders.js, lib/ticket-queue.js) are
// exercised directly. The browser side (renderer/renderer.js, index.html,
// styles.css) cannot be require()'d, so — matching the repo convention in
// test/ticket-lanes.test.js / test/ticket-folders.test.js — its wiring is proven
// by SOURCE-SCANNING those files as text. The "board" is an in-memory array; all
// DB/disk access is mocked away by construction.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LANE_STATUSES,
  VALID_STATUSES,
  ACTIVE_STATUSES,
  FAILED_STATUS,
  POST_PROCESSING_STATUS,
  POST_PROCESSING_KIND,
  UNKNOWN_STATUS,
  isKnownStatus,
  isFailedStatus,
  isPostProcessingTicket,
  laneForStatus,
} = require('../lib/ticket-lanes');
const { folderForStatus } = require('../lib/ticket-folders');
const {
  CLAIMABLE_STATUSES,
  claimTicket,
  selectNextBatch,
} = require('../lib/ticket-queue');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');
const skillClaude = path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const skillAssets = path.join(REPO, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const skillSrc = fs.readFileSync(skillClaude, 'utf8');

// The real whole-file serializer, copied verbatim from renderer/renderer.js
// (browser script — not requireable). Used by Scenario 5's write round-trip.
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}
function parseTicketFrontmatter(content) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { closeIdx = i; break; }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim();
    if (key) fm[key] = lines[i].slice(idx + 1).trim();
  }
  return { fm, body: lines.slice(closeIdx + 1).join('\n') };
}

// VERBATIM copy of renderTasksBoard's per-ticket lane routing (renderer.js
// ~5624-5629): the in-memory board the DOM-free scenarios render against.
const LANES_PRESENT = [...LANE_STATUSES, UNKNOWN_STATUS];
function placeCard(fm) {
  const unknown = !VALID_STATUSES.includes(fm.status);
  let laneKey;
  if (unknown) laneKey = UNKNOWN_STATUS;
  else if (fm.status === FAILED_STATUS) laneKey = 'testing';
  else laneKey = fm.status;
  if (!LANES_PRESENT.includes(laneKey)) laneKey = 'todo';
  const failed = fm.status === FAILED_STATUS;
  const active = ACTIVE_STATUSES.includes(fm.status);
  const dot = (failed || active) ? { className: 'task-card-dot' + (failed ? ' failed' : '') } : null;
  return { laneKey, unknown, dot };
}

// ---------------------------------------------------------------------------
// Scenario 1: The failed-testing lane is gone and post-processing takes its place
// ---------------------------------------------------------------------------
test('Scenario: the failed-testing lane is gone and post-processing takes its place', () => {
  // When the board renders its lanes (read the real DOM template)
  const laneOrder = [...htmlSrc.matchAll(/class="tasks-lane[^"]*"\s+data-status="([^"]+)"/g)]
    .map((m) => m[1]);
  // Then there is no lane with data-status "failed-testing"
  assert.ok(!laneOrder.includes('failed-testing'), 'no failed-testing lane in the DOM');
  // And there is a lane with data-status "post-processing"
  assert.ok(laneOrder.includes('post-processing'), 'a post-processing lane exists');
  // And the lane order left-to-right is the six-value order (then trailing unknown)
  assert.deepEqual(laneOrder, [...LANE_STATUSES, UNKNOWN_STATUS]);
  // And post-processing occupies the 5th slot, between testing and done
  assert.equal(laneOrder[4], 'post-processing');
  assert.equal(laneOrder[3], 'testing');
  assert.equal(laneOrder[5], 'done');
  // And the lane header reads "Post-processing" with a count span + an Add button
  const laneBlock = htmlSrc.slice(htmlSrc.indexOf('data-status="post-processing"'));
  const header = laneBlock.slice(0, laneBlock.indexOf('</div>'));
  assert.match(header, /Post-processing/);
  assert.match(header, /class="tasks-lane-count"/);
  assert.match(header, /class="tasks-lane-add"/);
});

// ---------------------------------------------------------------------------
// Scenario 2: LANE_STATUSES and its renderer mirror agree on the six-value order
// ---------------------------------------------------------------------------
test('Scenario: LANE_STATUSES and TASKS_LANE_STATUSES agree on the new six-value order', () => {
  const expected = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];
  // Given lib/ticket-lanes.js LANE_STATUSES
  assert.deepEqual(LANE_STATUSES, expected);
  // And renderer.js TASKS_LANE_STATUSES (source-scanned — browser script)
  const m = rendererSrc.match(/const\s+TASKS_LANE_STATUSES\s*=\s*(\[[^\]]*\])/);
  assert.ok(m, 'TASKS_LANE_STATUSES declared in renderer.js');
  // Then both equal the six-value order
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), expected);
});

// ---------------------------------------------------------------------------
// Scenario 3: failed-testing is still a known, valid status without its own lane
// ---------------------------------------------------------------------------
test('Scenario: failed-testing is still a known status folding into the testing lane', () => {
  // Given a ticket with status "failed-testing"
  const fm = { id: 'TASK-3', status: 'failed-testing' };
  // Then isKnownStatus("failed-testing") is true
  assert.equal(isKnownStatus('failed-testing'), true);
  // And laneForStatus("failed-testing") is "testing"
  assert.equal(laneForStatus('failed-testing'), 'testing');
  // And its card renders in the testing lane with the red "task-card-dot failed" marker
  const placed = placeCard(fm);
  assert.equal(placed.laneKey, 'testing');
  assert.equal(placed.unknown, false);
  assert.equal(placed.dot.className, 'task-card-dot failed');
  // And the CSS paints that class red (unchanged rule)
  assert.match(cssSrc, /\.task-card-dot\.failed\s*\{[^}]*background:\s*#f14c4c/i);
});

// ---------------------------------------------------------------------------
// Scenario 4: A post-processing ticket lands in the post-processing lane
// ---------------------------------------------------------------------------
test('Scenario: a post-processing ticket lands in the post-processing lane', () => {
  // Given a ticket with status "post-processing" and kind "post-processing"
  const fm = { id: 'PP-1', status: 'post-processing', kind: 'post-processing' };
  // Then laneForStatus("post-processing") is "post-processing"
  assert.equal(laneForStatus('post-processing'), 'post-processing');
  // And its card appears in the post-processing lane
  const placed = placeCard(fm);
  assert.equal(placed.laneKey, 'post-processing');
  // And it is not marked unknown
  assert.equal(placed.unknown, false);
  // And it shows no active/failed dot (post-processing is idle)
  assert.equal(placed.dot, null);
});

// ---------------------------------------------------------------------------
// Scenario 5: Adding a post-processing ticket from the lane Add button
// ---------------------------------------------------------------------------
test('Scenario: adding a post-processing ticket from the lane Add button writes status+kind into tasks/post-processing/', () => {
  // Given the post-processing lane Add button opens the modal in post-processing mode
  // (source-scan: the Add binding passes status+kind to openNewTaskModal).
  const bind = rendererSrc.slice(rendererSrc.indexOf('if (status === TASKS_POST_PROCESSING_STATUS)'));
  const bindBody = bind.slice(0, bind.indexOf('\n    }\n'));
  assert.match(bindBody, /\.tasks-lane-add/);
  assert.match(bindBody, /openNewTaskModal\(tab,\s*\{[\s\S]*status:\s*TASKS_POST_PROCESSING_STATUS/);
  assert.match(bindBody, /kind:\s*TASKS_POST_PROCESSING_KIND/);

  // And openNewTaskModal derives status/kind from the passed mode and files the
  // ticket into the status subfolder (source-scan of the parameterised opener).
  assert.match(rendererSrc, /const\s+status\s*=\s*mode\.status\s*\|\|\s*'todo'/);
  assert.match(rendererSrc, /const\s+kind\s*=\s*mode\.kind\s*\|\|\s*null/);
  assert.match(rendererSrc, /if\s*\(kind\)\s*fm\.kind\s*=\s*kind/);
  assert.match(rendererSrc, /const\s+subfolder\s*=\s*ticketFolderForStatus\(status\)/);

  // When the user confirms with a title (mirror the modal's frontmatter build), the
  // written ticket carries status + kind post-processing and files under
  // tasks/post-processing/.
  const now = '2026-07-18T00:00:00.000Z';
  const fm = { id: 'TASK-050', title: 'Regenerate changelog', status: POST_PROCESSING_STATUS, created: now, updated: now };
  fm.kind = POST_PROCESSING_KIND; // openNewTaskModal appends kind after the leading keys
  const body = ['', '## Description', 'x', '', '## Additional Context', '(User-owned. Read it before building. Never overwrite it.)', ''].join('\n');
  const round = parseTicketFrontmatter(serializeTicket(fm, body));

  // Then its frontmatter has status "post-processing" and kind "post-processing"
  assert.equal(round.fm.status, 'post-processing');
  assert.equal(round.fm.kind, 'post-processing');
  // And the kind key round-trips (preserved as an unknown key by serializeTicket)
  assert.deepEqual(Object.keys(round.fm).slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.ok(Object.keys(round.fm).includes('kind'), 'kind survives after the leading keys');
  // And the ## Additional Context placeholder line is present
  assert.match(round.body, /## Additional Context/);
  assert.match(round.body, /\(User-owned\./);
  // And it is a post-processing ticket, filed into tasks/post-processing/
  assert.equal(isPostProcessingTicket(round.fm), true);
  assert.equal(folderForStatus(round.fm.status), 'post-processing');
  // And it appears as a card in the post-processing lane
  assert.equal(placeCard(round.fm).laneKey, 'post-processing');
});

// ---------------------------------------------------------------------------
// Scenario 6: The toolbar New ticket button still creates a plain todo ticket
// ---------------------------------------------------------------------------
test('Scenario: the toolbar New ticket button still creates a plain todo ticket with no kind', () => {
  // When a ticket is created via the toolbar (no mode → status todo, kind null).
  assert.match(rendererSrc, /const\s+status\s*=\s*mode\.status\s*\|\|\s*'todo'/);
  assert.match(rendererSrc, /const\s+kind\s*=\s*mode\.kind\s*\|\|\s*null/);
  // The toolbar binding passes no mode.
  assert.match(rendererSrc, /tasksNewBtn[\s\S]{0,80}openNewTaskModal\(\s*tab\s*\)/);
  // Then the produced frontmatter has status "todo" and no "kind" (kind only set when truthy).
  const now = '2026-07-18T00:00:00.000Z';
  const fm = { id: 'TASK-051', title: 'Fresh', status: 'todo', created: now, updated: now };
  const round = parseTicketFrontmatter(serializeTicket(fm, '\n## Description\nx\n'));
  assert.equal(round.fm.status, 'todo');
  assert.ok(!('kind' in round.fm), 'no kind field on a toolbar-created ticket');
  // And the card appears in the todo lane.
  assert.equal(placeCard(round.fm).laneKey, 'todo');
});

// ---------------------------------------------------------------------------
// Scenario 7: Post-processing tickets are excluded from the build swarm
// ---------------------------------------------------------------------------
test('Scenario: post-processing tickets are excluded from the build swarm', () => {
  // Given a board containing a todo ticket and a post-processing ticket
  const board = [
    { fm: { id: 'TASK-100', status: 'todo' } },
    { fm: { id: 'PP-1', status: 'post-processing', kind: 'post-processing' } },
  ];
  // When selectNextBatch chooses the next batch
  const batch = selectNextBatch(board, { limit: 8 });
  // Then only the todo ticket is selected
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-100']);
  // And the post-processing ticket is never claimed
  const claim = claimTicket({ id: 'PP-1', status: 'post-processing', kind: 'post-processing' }, 'a1', { at: '2026-07-18T00:00:00.000Z' });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'post-processing');
  // And the Build button pending count does not include the post-processing ticket
  // (source-scan: pending counts only todo + failed-testing).
  assert.match(rendererSrc, /const\s+pending\s*=\s*counts\.todo\s*\+\s*counts\['failed-testing'\]/);
});

// ---------------------------------------------------------------------------
// Scenario 8: Completion ordering runs post-processing before done
// ---------------------------------------------------------------------------
test('Scenario: SKILL.md documents testing -> tech-lead review -> post-processing -> done and the kind exclusion', () => {
  // Then the skill documents the completion ordering (arrow form used in the doc).
  assert.match(skillSrc, /testing\s*→\s*tech-lead review\s*→\s*post-processing\s*→\s*done/);
  // And it documents the six-lane board order.
  assert.match(skillSrc, /todo\s*→\s*defining\s*→\s*in-progress\s*→\s*testing\s*→\s*post-processing\s*→\s*done/);
  // And it states post-processing tickets are identified by kind post-processing and never built by the swarm.
  assert.match(skillSrc, /kind:\s*post-processing/);
  assert.match(skillSrc, /un-claimable|never (built|claimed)|excluded/i);
});

// ---------------------------------------------------------------------------
// Scenario 9: The assets copy stays byte-identical (drift guard)
// ---------------------------------------------------------------------------
test('Scenario: assets/skills/orchestrate/SKILL.md is byte-for-byte identical to the .claude copy', () => {
  // Given .claude/skills/orchestrate/SKILL.md has been edited
  const a = fs.readFileSync(skillClaude);
  const b = fs.readFileSync(skillAssets);
  // Then the assets copy is byte-for-byte identical
  assert.equal(Buffer.compare(a, b), 0, 'SKILL.md copies must be byte-identical (drift guard)');
});

// ---------------------------------------------------------------------------
// Scenario 10 (FAILURE/EDGE): Editing a failed-testing ticket in the detail modal
// does not silently relabel it to todo
// ---------------------------------------------------------------------------
test('Scenario (edge): editing a failed-testing ticket in the detail modal does not silently relabel it to todo', () => {
  // Given the detail-modal <select> offers only the six lane statuses (no failed-testing option)
  const selBlock = htmlSrc.slice(htmlSrc.indexOf('class="task-modal-status"'));
  const sel = selBlock.slice(0, selBlock.indexOf('</select>'));
  assert.ok(!/value="failed-testing"/.test(sel), 'no failed-testing option in the modal select');
  assert.match(sel, /value="post-processing"/, 'post-processing option present');
  const optValues = [...sel.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(optValues, LANE_STATUSES, 'select offers exactly the six lane statuses in order');

  // When the modal fills a failed-testing ticket, it injects the stored status as a
  // selected option rather than defaulting the select to todo (source-scan of `fill`).
  const fillIdx = rendererSrc.indexOf('const fill = (fmObj, body) =>');
  const fillBody = rendererSrc.slice(fillIdx, rendererSrc.indexOf('bodyArea.value = body', fillIdx));
  assert.match(fillBody, /const\s+hasOption\s*=\s*Array\.from\(statusSel\.options\)\.some\(\(o\)\s*=>\s*o\.value\s*===\s*curStatus\)/);
  assert.match(fillBody, /if\s*\(!hasOption\)\s*\{[\s\S]*?opt\.dataset\.injected\s*=\s*'1'/);
  assert.match(fillBody, /statusSel\.value\s*=\s*curStatus/);
  // curStatus is the stored fm.status, only falling back to todo when truly blank —
  // never overriding a present failed-testing value.
  assert.match(fillBody, /const\s+curStatus\s*=\s*fmObj\.status\s*!=\s*null[\s\S]*?\?\s*String\(fmObj\.status\)\s*:\s*'todo'/);

  // Then a save writes back statusSel.value (which was set to the injected
  // failed-testing option), NOT a hard-coded todo.
  assert.match(rendererSrc, /newFm\.status\s*=\s*statusSel\.value/);
});

// ---------------------------------------------------------------------------
// Scenario 11: An existing failed-testing ticket on disk keeps working
// ---------------------------------------------------------------------------
test('Scenario: an existing failed-testing ticket keeps working after the change', () => {
  // Given a pre-existing failed-testing ticket
  const fm = { id: 'TASK-015', status: 'failed-testing' };
  // Then it still loads / renders its red failed dot in the testing lane
  const placed = placeCard(fm);
  assert.equal(placed.laneKey, 'testing');
  assert.equal(placed.dot.className, 'task-card-dot failed');
  assert.equal(isFailedStatus('failed-testing'), true);
  // And it remains claimable (CLAIMABLE_STATUSES still includes failed-testing)
  assert.ok(CLAIMABLE_STATUSES.includes('failed-testing'));
  const claim = claimTicket(fm, 'agent-1', { at: '2026-07-18T00:00:00.000Z' });
  assert.equal(claim.ok, true, 'a failed-testing ticket is still claimable for a re-fix');
  assert.equal(claim.fm.status, 'in-progress');
  // And it still owns its tasks/failed-testing/ folder (never auto-moved out)
  assert.equal(folderForStatus('failed-testing'), 'failed-testing');
});

// ---------------------------------------------------------------------------
// Scenario 12: A genuinely out-of-enum status routes to unknown, not post-processing
// ---------------------------------------------------------------------------
test('Scenario: an out-of-enum status routes to the unknown lane, not post-processing or todo', () => {
  // Given a ticket with status "bogus"
  const fm = { id: 'TASK-999', status: 'bogus' };
  // Then laneForStatus("bogus") is the unknown lane
  assert.equal(laneForStatus('bogus'), UNKNOWN_STATUS);
  assert.equal(isKnownStatus('bogus'), false);
  // And it is not placed in the post-processing lane or the todo lane
  const placed = placeCard(fm);
  assert.equal(placed.laneKey, UNKNOWN_STATUS);
  assert.equal(placed.unknown, true);
  assert.notEqual(placed.laneKey, 'post-processing');
  assert.notEqual(placed.laneKey, 'todo');
});

// ---------------------------------------------------------------------------
// Scenario 13 (EDGE): kind guard — a tampered todo-status post-processing recipe
// is still not built
// ---------------------------------------------------------------------------
test('Scenario (edge): a kind:post-processing ticket with status todo is still not claimable', () => {
  // Given a recipe ticket whose status was tampered to a claimable value
  const fm = { id: 'PP-9', status: 'todo', kind: 'post-processing' };
  // Then isPostProcessingTicket recognises it purely by kind
  assert.equal(isPostProcessingTicket(fm), true);
  // And claimTicket refuses it (kind guard, not status)
  const claim = claimTicket(fm, 'a1', { at: '2026-07-18T00:00:00.000Z' });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'post-processing');
  // And selectNextBatch excludes it while still picking a genuine todo alongside it
  const batch = selectNextBatch([
    { fm },
    { fm: { id: 'TASK-1', status: 'todo' } },
  ], { limit: 8 });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-1']);
});

// ===========================================================================
// SOURCE-TRACKING DRIFT GUARDS (TASK-034)
//
// The scenarios above render against the VERBATIM `placeCard` copy of the real
// renderTasksBoard routing (~lines 81-95). On their own those scenarios carry a
// tautology risk: if the REAL renderer routing/create/fill logic diverged from
// the copy, the scenarios would still pass. The three guards below close that
// gap by reading the ACTUAL `renderer/renderer.js` source (and this file's own
// `placeCard` copy) and failing when they diverge. Each guard names the exact
// divergence it catches.
// ===========================================================================

// Normalise the two source dialects (renderer uses tk.fm/TASKS_* constants/
// lanes[laneKey]; the copy uses fm/bare constants/LANES_PRESENT.includes) to a
// single canonical token form so the two routing blocks can be compared for
// structural (behavioural) identity rather than incidental naming.
function canonicalizeRouting(src) {
  return src
    .replace(/\btk\.fm\.status\b/g, 'S')
    .replace(/\bfm\.status\b/g, 'S')
    .replace(/\bTASKS_VALID_STATUSES\b/g, 'VALID')
    .replace(/\bVALID_STATUSES\b/g, 'VALID')
    .replace(/\bTASKS_UNKNOWN_STATUS\b/g, 'UNKNOWN')
    .replace(/\bUNKNOWN_STATUS\b/g, 'UNKNOWN')
    .replace(/\bTASKS_FAILED_STATUS\b/g, 'FAILED')
    .replace(/\bFAILED_STATUS\b/g, 'FAILED')
    .replace(/!lanes\[laneKey\]/g, 'LANE_ABSENT')
    .replace(/!LANES_PRESENT\.includes\(laneKey\)/g, 'LANE_ABSENT')
    .replace(/\s+/g, ' ')
    .trim();
}

function sliceInclusive(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s !== -1, `start marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s);
  assert.ok(e !== -1, `end marker not found: ${endMarker}`);
  return src.slice(s, e + endMarker.length);
}

// ---------------------------------------------------------------------------
// DRIFT GUARD 1: the real renderTasksBoard routing still folds failed-testing
// into testing and routes each canonical status to its own lane — and the
// verbatim placeCard copy above matches it byte-for-byte (after normalisation).
//
// Catches: "Renderer routing changed so failed-testing no longer folds into
// testing" (or a status routed elsewhere) — the normalised source stops
// matching the normalised copy AND the explicit failed→testing assertion fails.
// ---------------------------------------------------------------------------
test('DRIFT GUARD: renderTasksBoard routing folds failed-testing into testing and matches the placeCard copy', () => {
  // Extract the ACTUAL routing region of renderTasksBoard from renderer.js.
  const routeSrc = sliceInclusive(
    rendererSrc,
    'const unknown = !TASKS_VALID_STATUSES.includes(tk.fm.status);',
    "if (!lanes[laneKey]) laneKey = 'todo';"
  );

  // The failed-testing status MUST fold into the testing lane in the real source.
  assert.match(
    routeSrc,
    /else if \(tk\.fm\.status === TASKS_FAILED_STATUS\) laneKey = 'testing';/,
    'real routing must fold failed-testing into the testing lane',
  );
  // An out-of-enum status routes to the dedicated unknown lane, NOT todo.
  assert.match(routeSrc, /if \(unknown\) laneKey = TASKS_UNKNOWN_STATUS;/,
    'real routing must send unknown statuses to the unknown lane');
  // Every other (canonical, in-enum) status routes to its own same-named lane.
  assert.match(routeSrc, /else laneKey = tk\.fm\.status;/,
    'real routing must send each canonical status to its own lane');
  // The only fallback is the DOM-missing safety net → todo (never the primary path).
  assert.match(routeSrc, /if \(!lanes\[laneKey\]\) laneKey = 'todo';/,
    'todo is only the DOM-missing-lane safety net, not a status default');
  // And the constant the fold keys on really is 'failed-testing'.
  assert.match(rendererSrc, /const\s+TASKS_FAILED_STATUS\s*=\s*'failed-testing'/);
  assert.match(rendererSrc, /const\s+TASKS_UNKNOWN_STATUS\s*=\s*'unknown'/);

  // Now TIE the verbatim placeCard copy (this file, ~lines 84-90) to the real
  // source: both routing blocks must be structurally identical after
  // normalisation. If either drifts, the strings differ and this fails.
  const copySrc = sliceInclusive(
    fs.readFileSync(__filename, 'utf8'),
    'const unknown = !VALID_STATUSES.includes(fm.status);',
    "if (!LANES_PRESENT.includes(laneKey)) laneKey = 'todo';"
  );
  assert.equal(
    canonicalizeRouting(copySrc),
    canonicalizeRouting(routeSrc),
    'placeCard copy has drifted from renderTasksBoard routing — update the copy AND re-verify the scenarios',
  );
  // Sanity: the canonical form is the expected routing (documents intent + guards
  // against a normalisation that accidentally erases the behaviour).
  assert.equal(
    canonicalizeRouting(routeSrc),
    "const unknown = !VALID.includes(S); let laneKey; if (unknown) laneKey = UNKNOWN; "
    + "else if (S === FAILED) laneKey = 'testing'; else laneKey = S; if (LANE_ABSENT) laneKey = 'todo';",
  );
});

// ---------------------------------------------------------------------------
// DRIFT GUARD 2: the real Add-button create path writes status:post-processing
// AND kind:post-processing into the tasks/post-processing/ folder.
//
// Catches: "Add-path status/kind/folder changed" — a change to the passed
// status/kind, the fm composition, or the folder derivation breaks a match.
// ---------------------------------------------------------------------------
test('DRIFT GUARD: the post-processing Add path composes status + kind post-processing and files into tasks/post-processing/', () => {
  // The post-processing lane Add binding passes BOTH status and kind constants.
  const bind = sliceInclusive(
    rendererSrc,
    'if (status === TASKS_POST_PROCESSING_STATUS) {',
    '});'
  );
  assert.match(bind, /\.tasks-lane-add/, 'the Add affordance lives on the post-processing lane');
  assert.match(bind, /openNewTaskModal\(tab,\s*\{[\s\S]*?status:\s*TASKS_POST_PROCESSING_STATUS/,
    'Add passes status: post-processing');
  assert.match(bind, /kind:\s*TASKS_POST_PROCESSING_KIND/, 'Add passes kind: post-processing');

  // Both constants must literally be 'post-processing' (status AND kind).
  assert.match(rendererSrc, /const\s+TASKS_POST_PROCESSING_STATUS\s*=\s*'post-processing'/);
  assert.match(rendererSrc, /const\s+TASKS_POST_PROCESSING_KIND\s*=\s*'post-processing'/);

  // openNewTaskModal derives status/kind from the passed mode.
  assert.match(rendererSrc, /const\s+status\s*=\s*mode\.status\s*\|\|\s*'todo'/);
  assert.match(rendererSrc, /const\s+kind\s*=\s*mode\.kind\s*\|\|\s*null/);

  // The real onCreate composition writes status into frontmatter, appends kind
  // when present, and files the ticket into ticketFolderForStatus(status).
  const create = sliceInclusive(
    rendererSrc,
    'const fm = { id, title, status, created: now, updated: now };',
    'const destDir = subfolder ? tasksJoin(tasksDir, subfolder) : tasksDir;'
  );
  assert.match(create, /const fm = \{ id, title, status, created: now, updated: now \};/,
    'status is written into the created frontmatter');
  assert.match(create, /if \(kind\) fm\.kind = kind;/, 'kind is appended to frontmatter when present');
  assert.match(create, /const subfolder = ticketFolderForStatus\(status\);/,
    'the destination folder is derived from the ticket status');

  // The status→folder mapping the create path relies on: post-processing files
  // into the tasks/post-processing/ subfolder (requireable lib mirror).
  assert.equal(folderForStatus('post-processing'), 'post-processing');
});

// ---------------------------------------------------------------------------
// DRIFT GUARD 3: the real detail-modal fill preserves an out-of-list status
// (e.g. failed-testing) instead of defaulting the select to todo.
//
// Catches: "Detail-modal fill reverting to a todo fallback for out-of-list
// statuses" — a `statusSel.value = ... : 'todo'` re-default trips the negative
// guard and the unconditional-assignment guard.
// ---------------------------------------------------------------------------
test('DRIFT GUARD: detail-modal fill preserves an out-of-list status and never re-defaults the select to todo', () => {
  const fillBody = sliceInclusive(
    rendererSrc,
    'const fill = (fmObj, body) =>',
    'statusSel.value = curStatus;'
  );

  // curStatus is the stored status, only falling back to todo when TRULY blank.
  assert.match(
    fillBody,
    /const\s+curStatus\s*=\s*fmObj\.status\s*!=\s*null[\s\S]*?\?\s*String\(fmObj\.status\)\s*:\s*'todo'/,
    'curStatus keeps a present status and only defaults to todo when blank',
  );
  // An out-of-list status is injected as a selected option (not dropped).
  assert.match(fillBody, /const\s+hasOption\s*=\s*Array\.from\(statusSel\.options\)\.some\(\(o\)\s*=>\s*o\.value\s*===\s*curStatus\)/);
  assert.match(fillBody, /if\s*\(!hasOption\)\s*\{[\s\S]*?opt\.dataset\.injected\s*=\s*'1'/,
    'an out-of-list status is injected as a selected option');

  // The select is set UNCONDITIONALLY to curStatus — no ternary re-defaulting a
  // present-but-out-of-list status to todo.
  assert.match(rendererSrc, /statusSel\.value\s*=\s*curStatus;/,
    'the select value is set to the preserved status');
  // NEGATIVE guard: the fill must never assign the status select to a 'todo'
  // literal (which is exactly what an out-of-list → todo re-default would emit,
  // e.g. `statusSel.value = hasOption ? curStatus : 'todo';`). The legitimate
  // blank fallback lives on `curStatus`, not on `statusSel.value`.
  const fillWithSet = sliceInclusive(
    rendererSrc,
    'const fill = (fmObj, body) =>',
    'bodyArea.value = body'
  );
  assert.ok(
    !/statusSel\.value\s*=\s*[^;]*['"]todo['"]/.test(fillWithSet),
    'fill must not relabel an out-of-list status to todo via the status select',
  );
  // And a save persists that preserved select value — not a hard-coded todo.
  assert.match(rendererSrc, /newFm\.status\s*=\s*statusSel\.value/);
  assert.ok(!/newFm\.status\s*=\s*['"]todo['"]/.test(rendererSrc),
    'save must not hard-code the status back to todo');
});
