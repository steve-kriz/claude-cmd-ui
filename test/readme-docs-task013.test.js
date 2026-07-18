'use strict';

// TASK-013 tester deliverables: BOTH e2e cucumber-style scenarios AND unit tests
// for the README documentation contract.
//
// This is a DOCUMENTATION ticket (the coder edited only README.md), so the
// testable contract is that the README text + the referenced images on disk are
// internally consistent and that every acceptance criterion / Gherkin scenario in
// the ticket holds. There is no runtime behaviour to exercise; the only I/O is
// reading files from disk.
//
//   * UNIT TESTS  -> `test('UNIT: ...')` cases: the small, pure checker helpers
//                    (image-reference extractor, relative-link extractor,
//                    ASCII-mockup detector, GitHub anchor slugger, repo-root
//                    path validator) are exercised directly against synthetic
//                    strings. The failure/edge cases (a missing image, a stale
//                    relative link) are proven here deterministically WITHOUT
//                    mutating the real README.
//   * E2E CUCUMBER SCENARIOS -> `test('E2E cucumber: ...')` suites: Given/When/Then
//                    structured cases that read the real README.md + images/
//                    directory and assert each Gherkin scenario in the ticket.
//
// NO NETWORK, NO DATABASE (there are none in scope; we open no real connections).
// The only I/O is reading files from disk, which is the whole point of the
// documentation contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

const readReadme = () => fs.readFileSync(README_PATH, 'utf8');

// ---------------------------------------------------------------------------
// PURE CHECKER HELPERS
// These are dependency-free, side-effect-free functions. The e2e scenarios wire
// them to real fs.existsSync; the unit tests inject a fake `exists` predicate so
// the missing-image / stale-link failure paths are provable without touching the
// real README or the disk.
// ---------------------------------------------------------------------------

// The chars a WINDOW/SCREEN mockup is drawn with. Note we deliberately EXCLUDE
// `└` because the "## Project layout" file tree legitimately uses `├──`/`└──`;
// these five (top corners, bottom-right corner, double lines) never appear in a
// file-tree listing, so their presence means a screen mockup survived.
const SCREEN_MOCKUP_CHARS = ['┌', '┐', '┘', '║', '═']; // ┌ ┐ ┘ ║ ═

function findScreenMockupChars(md) {
  return SCREEN_MOCKUP_CHARS.filter((ch) => md.includes(ch));
}

function hasFileTree(md) {
  // A directory-tree code block uses branch connectors.
  return md.includes('├──') || md.includes('└──'); // ├── / └──
}

// Extract markdown image references: ![alt](target).
function extractImageRefs(md) {
  const refs = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    refs.push({ alt: m[1], target: m[2].trim() });
  }
  return refs;
}

// Extract markdown link references [text](target) but NOT image refs (`![...]`).
function extractLinkRefs(md) {
  const refs = [];
  const re = /(^|[^!])\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    refs.push({ text: m[2], target: m[3].trim() });
  }
  return refs;
}

const isRemote = (t) => /^(https?:)?\/\//i.test(t) || t.startsWith('mailto:');
const isAnchor = (t) => t.startsWith('#');

// Strip an optional markdown "title" and any fragment/query from a path target.
const cleanTarget = (t) => t.split(/\s+/)[0].split('#')[0].split('?')[0];

// A repo-root-relative image path: begins with images/, is not absolute, not a
// URL, has no leading slash and no leading "./" and no drive letter.
function isRepoRootRelativeImage(t) {
  if (isRemote(t) || isAnchor(t)) return false;
  const p = cleanTarget(t);
  if (p.startsWith('/')) return false; // leading slash (absolute-from-root)
  if (p.startsWith('./')) return false; // leading ./
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false; // windows drive letter
  if (p.startsWith('\\')) return false; // UNC / backslash root
  return /^images\//.test(p);
}

// Given local path targets and an `exists(relPath)` predicate, return the ones
// that do NOT resolve.
function findMissingTargets(targets, exists) {
  const missing = [];
  for (const t of targets) {
    const p = cleanTarget(t);
    if (!p) continue; // pure fragment/query -> nothing to resolve
    if (!exists(p)) missing.push(t);
  }
  return missing;
}

// GitHub-flavoured heading -> anchor slug: lowercase, drop everything that is not
// a word char / space / hyphen, then spaces -> hyphens.
function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

// Extract ATX headings (`#`..`######`) -> their text.
function extractHeadings(md) {
  const headings = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) headings.push(m[2]);
  }
  return headings;
}

// Extract in-page anchor link targets (those starting with '#') minus the '#'.
function extractInPageAnchors(md) {
  return extractLinkRefs(md)
    .map((r) => r.target)
    .filter((t) => isAnchor(t))
    .map((t) => t.slice(1));
}

// Body text of a `## <heading>` section, up to the next `#` or `##` heading.
function sectionBody(md, headingText) {
  const lines = md.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === `## ${headingText}`);
  if (idx < 0) return null;
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##?\s/.test(lines[i])) break; // next h1/h2
    out.push(lines[i]);
  }
  return out.join('\n');
}

// ===========================================================================
// UNIT TESTS — the pure checker helpers, exercised against synthetic strings.
// ===========================================================================

test('UNIT: findScreenMockupChars flags a ┌…┐ window mockup', () => {
  const mockup = [
    '┌── File ──┐',
    '║ hello       ║',
    '└───────┘',
  ].join('\n');
  const found = findScreenMockupChars(mockup);
  assert.ok(found.length > 0, 'expected a window mockup to be flagged');
});

test('UNIT: findScreenMockupChars does NOT flag a file-tree listing', () => {
  const tree = [
    'app/',
    '├── main.js',
    '├── lib/',
    '│   └── pty.js',
    '└── package.json',
  ].join('\n');
  // A file tree uses ├── │ └── but none of ┌ ┐ ┘ ║ ═.
  assert.deepEqual(findScreenMockupChars(tree), []);
  assert.ok(hasFileTree(tree), 'expected the file tree to be recognised');
});

test('UNIT: extractImageRefs pulls alt + target for each ![alt](path)', () => {
  const md = 'x ![The screen](images/a.jpg) y ![](images/b.png) z';
  assert.deepEqual(extractImageRefs(md), [
    { alt: 'The screen', target: 'images/a.jpg' },
    { alt: '', target: 'images/b.png' },
  ]);
});

test('UNIT: extractLinkRefs ignores image refs but keeps ordinary links', () => {
  const md = 'see ![img](images/a.jpg) and [docs](guide.md) and [x](#anchor)';
  const targets = extractLinkRefs(md).map((r) => r.target);
  assert.deepEqual(targets, ['guide.md', '#anchor']);
});

test('UNIT: isRepoRootRelativeImage accepts images/<file> and rejects the rest', () => {
  assert.equal(isRepoRootRelativeImage('images/working_screen1.jpg'), true);
  assert.equal(isRepoRootRelativeImage('/images/a.png'), false); // leading slash
  assert.equal(isRepoRootRelativeImage('./images/a.png'), false); // leading ./
  assert.equal(isRepoRootRelativeImage('http://x/y.png'), false); // remote
  assert.equal(isRepoRootRelativeImage('https://x/y.png'), false); // remote
  assert.equal(isRepoRootRelativeImage('C:/images/a.png'), false); // drive letter
  assert.equal(isRepoRootRelativeImage('assets/a.png'), false); // not images/
});

test('UNIT: githubSlug matches GitHub anchor generation for tricky headings', () => {
  assert.equal(githubSlug('Architecture'), 'architecture');
  assert.equal(githubSlug('AWS environment switcher'), 'aws-environment-switcher');
  assert.equal(
    githubSlug('Tasks board & the Orchestrate workflow'),
    'tasks-board--the-orchestrate-workflow',
  );
  assert.equal(githubSlug('The cmd / claude pane'), 'the-cmd--claude-pane');
  assert.equal(
    githubSlug('Change Viewer (diff & merge conflicts)'),
    'change-viewer-diff--merge-conflicts',
  );
});

test('UNIT: findMissingTargets — a referenced image that does not exist is caught', () => {
  const md = 'good ![ok](images/real.png) bad ![x](images/does-not-exist.png)';
  const targets = extractImageRefs(md).map((r) => r.target);
  // Fake filesystem: only real.png exists.
  const exists = (p) => p === 'images/real.png';
  const missing = findMissingTargets(targets, exists);
  assert.deepEqual(missing, ['images/does-not-exist.png']);
});

test('UNIT: findMissingTargets — a stale relative link to a deleted file is caught', () => {
  const md = 'see [live](lib/present.js) and [gone](lib/deleted-file.js)';
  const targets = extractLinkRefs(md)
    .map((r) => r.target)
    .filter((t) => !isRemote(t) && !isAnchor(t));
  const exists = (p) => p === 'lib/present.js'; // deleted-file.js no longer exists
  const missing = findMissingTargets(targets, exists);
  assert.deepEqual(missing, ['lib/deleted-file.js']);
});

test('UNIT: findMissingTargets returns [] when everything resolves', () => {
  const targets = ['images/a.png', 'lib/b.js'];
  const exists = () => true;
  assert.deepEqual(findMissingTargets(targets, exists), []);
});

test('UNIT: extractHeadings + extractInPageAnchors round-trip through githubSlug', () => {
  const md = [
    '# Title',
    '## Getting started',
    '- [Getting started](#getting-started)',
    '- [Missing](#no-such-heading)',
  ].join('\n');
  const slugs = new Set(extractHeadings(md).map(githubSlug));
  const anchors = extractInPageAnchors(md);
  assert.deepEqual(anchors, ['getting-started', 'no-such-heading']);
  assert.ok(slugs.has('getting-started'));
  assert.ok(!slugs.has('no-such-heading'));
});

test('UNIT: package.json adds no new runtime dependency (deps unchanged)', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  // The documented markdown preview is powered by in-repo lib/markdown.js, so
  // NO new runtime dependency may be introduced by this doc work.
  assert.deepEqual(
    Object.keys(pkg.dependencies || {}).sort(),
    ['@lydell/node-pty', '@xterm/addon-fit', '@xterm/xterm'],
    'runtime dependencies must be unchanged (no new dependency added)',
  );
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.optionalDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  const badge = Object.keys(allDeps).filter((n) =>
    /cucumber|marked|markdown-it|showdown|remark/i.test(n),
  );
  assert.deepEqual(
    badge,
    [],
    `no markdown/cucumber parser dependency may be added, found: ${badge.join(', ')}`,
  );
});

// ===========================================================================
// E2E CUCUMBER-STYLE SCENARIOS — read the real README.md + images/ directory and
// assert each Gherkin scenario in the ticket.
// ===========================================================================

const existsAtRoot = (relPath) => fs.existsSync(path.join(REPO_ROOT, relPath));

test('E2E cucumber: No ASCII-art screen mockup remains', async (t) => {
  await t.test(
    'Given README.md, When I scan for box-drawing window mockups (┌ ┐ ┘ ║ ═), ' +
      'Then no ASCII-art window/screen mockup is present, ' +
      'And "The window at a glance" instead embeds images/working_screen1.jpg',
    () => {
      const md = readReadme();

      const found = findScreenMockupChars(md);
      assert.deepEqual(
        found,
        [],
        `README.md still contains screen-mockup box-drawing chars: ${found
          .map((c) => JSON.stringify(c))
          .join(', ')}`,
      );

      const body = sectionBody(md, 'The window at a glance');
      assert.ok(body, 'expected a "## The window at a glance" section');
      assert.match(
        body,
        /!\[[^\]]+\]\(images\/working_screen1\.jpg\)/,
        'the section must embed images/working_screen1.jpg with non-empty alt text',
      );
      // And a caption line (a whole-line italic caption) accompanies the image.
      const hasCaption = body
        .split(/\r?\n/)
        .some((l) => /^\*.+\*$/.test(l.trim()));
      assert.ok(hasCaption, 'expected a caption line under the embedded window image');
    },
  );
});

test('E2E cucumber: The project-layout file tree is preserved', async (t) => {
  await t.test(
    'Given README.md, When I look at the "## Project layout" section, ' +
      'Then a directory-tree code block using "├──" is still present',
    () => {
      const md = readReadme();
      const body = sectionBody(md, 'Project layout');
      assert.ok(body, 'expected a "## Project layout" section');
      assert.ok(
        body.includes('├──') || body.includes('└──'),
        'the Project layout section must still contain the ├──/└── file tree',
      );
    },
  );
});

test('E2E cucumber: Every embedded local image exists on disk', async (t) => {
  await t.test(
    'Given README.md, When I extract every local markdown image reference, ' +
      'Then each referenced image file exists on disk under the repo root',
    () => {
      const md = readReadme();
      const localTargets = extractImageRefs(md)
        .map((r) => r.target)
        .filter((tt) => !isRemote(tt) && !isAnchor(tt));

      assert.ok(localTargets.length > 0, 'expected at least one local image ref');

      const missing = findMissingTargets(localTargets, existsAtRoot);
      assert.deepEqual(
        missing,
        [],
        `these README image references point to files that do not exist: ${missing.join(', ')}`,
      );
    },
  );
});

test('E2E cucumber: All five screenshots are referenced and present', async (t) => {
  await t.test(
    'Given README.md and the images/ directory, When I check for the five ' +
      'screenshots, Then each is referenced at least once and exists in images/',
    () => {
      const md = readReadme();
      const expected = [
        'working_screen1.jpg',
        'tab_finished_work.jpg',
        'queue_up_prompts.jpg',
        'github_view.png',
        'workflow_task_view.png',
      ];

      const notReferenced = expected.filter((name) => !md.includes(name));
      assert.deepEqual(
        notReferenced,
        [],
        `not referenced in README.md: ${notReferenced.join(', ')}`,
      );

      const notOnDisk = expected.filter(
        (name) => !fs.existsSync(path.join(REPO_ROOT, 'images', name)),
      );
      assert.deepEqual(
        notOnDisk,
        [],
        `missing from images/: ${notOnDisk.join(', ')}`,
      );
    },
  );
});

test('E2E cucumber: Image paths are repo-root-relative', async (t) => {
  await t.test(
    'Given README.md, When I extract every local image reference, ' +
      'Then each path begins with "images/" and is not absolute/http/leading-slash/leading-./',
    () => {
      const md = readReadme();
      const localTargets = extractImageRefs(md)
        .map((r) => r.target)
        .filter((tt) => !isRemote(tt) && !isAnchor(tt));

      const bad = localTargets.filter((tt) => !isRepoRootRelativeImage(tt));
      assert.deepEqual(
        bad,
        [],
        `these image paths are not clean repo-root-relative images/<file>: ${bad.join(', ')}`,
      );
    },
  );
});

test('E2E cucumber: Slack integration is documented', async (t) => {
  await t.test(
    'Given README.md, Then it describes SLACK_TOKEN bot-token setup ' +
      'and the "Sign in with Slack" OAuth flow',
    () => {
      const md = readReadme();
      assert.ok(md.includes('SLACK_TOKEN'), 'expected SLACK_TOKEN bot-token setup to be documented');
      assert.ok(
        /sign in with slack/i.test(md),
        'expected the "Sign in with Slack" OAuth flow to be documented',
      );
      assert.ok(/oauth/i.test(md), 'expected the OAuth flow to be named');
    },
  );
});

test('E2E cucumber: The Orchestrate workflow and Tasks board are documented', async (t) => {
  await t.test(
    'Given README.md, Then it contains the Tasks board heading, the three agent ' +
      'roles, and all six lane names',
    () => {
      const md = readReadme();
      assert.ok(
        md.includes('## Tasks board & the Orchestrate workflow'),
        'expected the "## Tasks board & the Orchestrate workflow" heading',
      );

      for (const role of ['business-analyst', 'coder', 'tester']) {
        assert.ok(md.includes(role), `expected agent role "${role}" to be named`);
      }

      const lanes = ['todo', 'defining', 'in-progress', 'testing', 'failed-testing', 'done'];
      const missing = lanes.filter((l) => !md.includes(l));
      assert.deepEqual(missing, [], `lane names not documented: ${missing.join(', ')}`);
    },
  );
});

test('E2E cucumber: Tokens/cost/build-time accounting is documented', async (t) => {
  await t.test(
    'Given README.md, Then it describes per-ticket build time and cost accounting',
    () => {
      const md = readReadme();
      const lower = md.toLowerCase();
      assert.ok(/build time/.test(lower), 'expected per-ticket build time to be documented');
      assert.ok(/cost/.test(lower), 'expected per-ticket cost to be documented');
      assert.ok(
        /token/.test(lower),
        'expected tokens accounting to be documented',
      );
    },
  );
});

test('E2E cucumber: Markdown preview feature is documented', async (t) => {
  await t.test(
    'Given README.md, Then the File Explorer docs describe a "Show preview" toggle ' +
      'that renders .md files as formatted HTML and toggles back to raw source',
    () => {
      const md = readReadme();
      const body = sectionBody(md, 'Features') || md; // File Explorer lives under Features
      const scope = body.toLowerCase();
      assert.ok(/show preview/i.test(md), 'expected a "Show preview" toggle to be documented');
      assert.ok(/\.md/.test(scope), 'expected the toggle to be tied to .md files');
      assert.ok(
        /formatted html|as html|to html/i.test(md),
        'expected the toggle to render .md as formatted HTML',
      );
      assert.ok(
        /raw source|back to (the )?raw|toggles? .*raw/i.test(md),
        'expected the toggle to switch back to raw source',
      );
      assert.ok(
        /no new npm dependency|dependency-free|no new (npm )?dependency/i.test(md),
        'expected the docs to note no new npm dependency (in-repo lib/markdown.js)',
      );
    },
  );
});

test('E2E cucumber: Table of contents stays consistent with headings', async (t) => {
  await t.test(
    'Given README.md, When I resolve every in-page anchor link, ' +
      'Then each anchor corresponds to a heading that exists in README.md',
    () => {
      const md = readReadme();
      const slugSet = new Set(extractHeadings(md).map(githubSlug));
      const anchors = extractInPageAnchors(md);

      assert.ok(anchors.length > 0, 'expected the ToC to contain in-page anchors');

      const dangling = anchors.filter((a) => !slugSet.has(a));
      assert.deepEqual(
        dangling,
        [],
        `these ToC anchors do not resolve to any heading: ${dangling.join(', ')}`,
      );
    },
  );
});

test('E2E cucumber: Every local relative link resolves', async (t) => {
  await t.test(
    'Given README.md, When I extract every local (non-http, non-anchor) link target, ' +
      'Then each target file exists on disk under the repo root',
    () => {
      const md = readReadme();
      const localTargets = extractLinkRefs(md)
        .map((r) => r.target)
        .filter((tt) => !isRemote(tt) && !isAnchor(tt));

      const missing = findMissingTargets(localTargets, existsAtRoot);
      assert.deepEqual(
        missing,
        [],
        `these relative README links point to files that do not exist: ${missing.join(', ')}`,
      );
    },
  );
});

test('E2E cucumber (failure/edge): a referenced image that does not exist is caught', async (t) => {
  await t.test(
    'Given a crafted README string referencing images/does-not-exist.png, ' +
      'When the docs-integrity image check runs against the REAL images/ dir, ' +
      'Then it fails and reports images/does-not-exist.png as missing',
    () => {
      // Craft a synthetic string; do NOT modify the real README.
      const synthetic = 'intro\n\n![nope](images/does-not-exist.png)\n';
      const localTargets = extractImageRefs(synthetic).map((r) => r.target);
      const missing = findMissingTargets(localTargets, existsAtRoot);

      assert.ok(
        missing.includes('images/does-not-exist.png'),
        'the checker must catch a referenced image that does not exist',
      );

      // And prove that a real screenshot from images/ would NOT be flagged.
      const ok = 'x ![real](images/working_screen1.jpg)';
      assert.deepEqual(
        findMissingTargets(extractImageRefs(ok).map((r) => r.target), existsAtRoot),
        [],
      );
    },
  );
});

test('E2E cucumber (failure/edge): a stale relative link is caught', async (t) => {
  await t.test(
    'Given a crafted README string linking to a deleted local file, ' +
      'When the docs-integrity link check runs against the REAL repo, ' +
      'Then it fails and reports the broken relative link',
    () => {
      // A relative link to a file that does not exist in the repo.
      const synthetic = 'see [old notes](lib/removed-notes-xyz.js) for details';
      const localTargets = extractLinkRefs(synthetic)
        .map((r) => r.target)
        .filter((tt) => !isRemote(tt) && !isAnchor(tt));
      const missing = findMissingTargets(localTargets, existsAtRoot);

      assert.ok(
        missing.includes('lib/removed-notes-xyz.js'),
        'the checker must catch a stale relative link to a deleted file',
      );

      // A link to a file that really exists is NOT flagged.
      const ok = 'see [lanes](lib/ticket-lanes.js)';
      assert.deepEqual(
        findMissingTargets(
          extractLinkRefs(ok).map((r) => r.target),
          existsAtRoot,
        ),
        [],
      );
    },
  );
});
