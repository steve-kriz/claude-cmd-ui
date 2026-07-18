'use strict';

// Docs-integrity tests for TASK-013: "document — update documents with the new
// features, also use the images from the images folder to display the screen".
//
// This is a DOCUMENTATION ticket: there is no runtime behaviour to exercise, but
// the README has a mechanically testable CONTRACT. These tests verify the README
// is internally consistent so the docs actually render as intended:
//
//   1. Every LOCAL (non-http) markdown image reference `![alt](path)` points to a
//      file that exists on disk — i.e. the screenshots really display.
//   2. Each of the five screenshots embedded for this ticket is referenced at
//      least once in the README.
//   3. The new "Tasks board & the Orchestrate workflow" section and the six lane
//      names are documented.
//   4. Every LOCAL relative markdown LINK target (not an anchor, not http) exists
//      on disk, so a stale relative link fails the test.
//
// NO NETWORK, NO DATABASE. The only I/O is reading files from disk (README.md and
// the referenced assets), which is the whole point of the contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');

function readReadme() {
  return fs.readFileSync(README_PATH, 'utf8');
}

// Extract markdown image references: ![alt](target). alt may contain anything
// except a closing bracket; target is everything up to the closing paren.
function extractImageRefs(md) {
  const refs = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    refs.push(m[1].trim());
  }
  return refs;
}

// Extract markdown link references: [text](target) but NOT image refs (those are
// preceded by `!`). Uses a lookbehind-free approach by tracking the char before.
function extractLinkRefs(md) {
  const refs = [];
  const re = /(^|[^!])\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    refs.push(m[2].trim());
  }
  return refs;
}

const isRemote = (t) => /^(https?:)?\/\//i.test(t) || t.startsWith('mailto:');
const isAnchor = (t) => t.startsWith('#');

test('TASK-013 docs integrity', async (t) => {
  await t.test(
    'Given README.md, When we extract every local markdown image reference, ' +
      'Then every referenced image file exists on disk',
    () => {
      const md = readReadme();
      const imageRefs = extractImageRefs(md);

      // Sanity: the README embeds screenshots at all.
      assert.ok(
        imageRefs.length > 0,
        'expected README.md to contain at least one markdown image reference',
      );

      const localImages = imageRefs.filter((t) => !isRemote(t) && !isAnchor(t));
      const missing = [];
      for (const ref of localImages) {
        // Strip any optional "title" and URL fragment/query just in case.
        const cleanPath = ref.split(/\s+/)[0].split('#')[0].split('?')[0];
        const abs = path.join(REPO_ROOT, cleanPath);
        if (!fs.existsSync(abs)) missing.push(ref);
      }

      assert.deepEqual(
        missing,
        [],
        `these README image references point to files that do not exist: ${missing.join(', ')}`,
      );
    },
  );

  await t.test(
    'Given the images embedded for this ticket, Then each of the five expected ' +
      'screenshots is referenced at least once in README.md',
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
        `these expected screenshots are not referenced in README.md: ${notReferenced.join(', ')}`,
      );

      // And each of those referenced files actually exists on disk.
      const notOnDisk = expected.filter(
        (name) => !fs.existsSync(path.join(REPO_ROOT, 'images', name)),
      );
      assert.deepEqual(
        notOnDisk,
        [],
        `these expected screenshots are missing from images/: ${notOnDisk.join(', ')}`,
      );
    },
  );

  await t.test(
    'Given the new Tasks board documentation, Then the README contains the new ' +
      'section heading and the six lane names',
    () => {
      const md = readReadme();

      assert.ok(
        md.includes('## Tasks board & the Orchestrate workflow'),
        'expected README.md to contain the "## Tasks board & the Orchestrate workflow" section heading',
      );

      // ToC anchor for the new section.
      assert.ok(
        md.includes('#tasks-board--the-orchestrate-workflow'),
        'expected README.md table of contents to link to #tasks-board--the-orchestrate-workflow',
      );

      const lanes = [
        'todo',
        'defining',
        'in-progress',
        'testing',
        'failed-testing',
        'done',
      ];
      const missingLanes = lanes.filter((lane) => !md.includes(lane));
      assert.deepEqual(
        missingLanes,
        [],
        `these lane names are not documented in README.md: ${missingLanes.join(', ')}`,
      );
    },
  );

  await t.test(
    'Given every in-repo relative markdown LINK target that points to a local ' +
      'file, Then it exists on disk (stale relative links fail the test)',
    () => {
      const md = readReadme();
      const linkRefs = extractLinkRefs(md);

      const localFileLinks = linkRefs.filter(
        (target) => !isRemote(target) && !isAnchor(target),
      );

      const missing = [];
      for (const target of localFileLinks) {
        const cleanPath = target.split(/\s+/)[0].split('#')[0].split('?')[0];
        if (!cleanPath) continue; // pure fragment/query -> nothing to resolve
        const abs = path.join(REPO_ROOT, cleanPath);
        if (!fs.existsSync(abs)) missing.push(target);
      }

      assert.deepEqual(
        missing,
        [],
        `these relative README links point to files that do not exist: ${missing.join(', ')}`,
      );
    },
  );
});
