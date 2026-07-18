---
id: TASK-013
title: document
status: done
created: 2026-07-18T09:57:25.931Z
updated: 2026-07-18T11:26:50.363Z
startedAt: 2026-07-18T10:14:26.000Z
finishedAt: 2026-07-18T10:20:04.000Z
runs: [{"at":"2026-07-18T10:20:04.000Z","startedAt":"2026-07-18T10:14:26.000Z","finishedAt":"2026-07-18T10:20:04.000Z","minutes":5.63}]
order: 2
---

## Description
Update `README.md` so it (a) documents the app's newer features and (b) uses the real screenshots in `images/` to show the UI instead of ASCII-art screen mockups.

Two concrete changes remain on top of the current README:

1. **Remove the ASCII-art window mockup.** The fenced code block under "## The window at a glance" (the `┌─ … ┐` box-drawing window diagram) duplicates the screenshot `images/working_screen1.jpg` that already follows it. Delete the ASCII mockup and rely on the embedded image (with its caption). Do **not** remove the `## Project layout` directory tree (that is a file-tree listing using `├──`/`└──`, not a screen mockup, and must stay).
2. **Document the markdown-preview feature (TASK-015).** Under the "### File Explorer" section, describe the "Show preview" toggle that renders an open `.md` file as formatted HTML (headings, bold/italic, lists, inline/fenced code, links, images, blockquotes), toggles back to raw source, appears only for `.md` files, and is powered by the in-repo dependency-free renderer `lib/markdown.js` (safe against script injection, no new npm dependency).

While doing so, keep the README satisfying its documentation contract: every embedded screenshot uses markdown image syntax `![alt](images/<file>)` with a repo-root-relative path that resolves both on GitHub and in the in-app markdown viewer; every embedded image points to a file that exists in `images/`; all five screenshots are referenced; and the newer features (Slack integration + OAuth sign-in, multi-agent Orchestrate workflow, per-ticket tokens/cost accounting, the six-lane Tasks kanban board, folder-per-status ticket layout, and the markdown preview) are all documented. Every local relative link must resolve, and the Table of contents must stay consistent with the section headings.

Why: the README is the primary onboarding doc; ASCII mockups look dated and drift from the real UI, and several shipped features (esp. markdown preview) are currently undocumented.

## Acceptance Criteria
- [ ] The ASCII-art window mockup fenced code block under "## The window at a glance" (the `┌…┐` box-drawing diagram) is removed; no box-drawing screen mockup (chars `┌ ┐ └ ┘ ║ ═` used to draw a window/screen) remains anywhere in README.md.
- [ ] The `## Project layout` directory-tree code block (using `├──`/`└──`) is preserved.
- [ ] The "## The window at a glance" section still shows the window via `![alt](images/working_screen1.jpg)` with non-empty alt text and a caption line.
- [ ] Every local (non-http, non-anchor) markdown image reference points to a file that exists on disk under the repo root.
- [ ] All five screenshots are referenced at least once and exist in `images/`: `working_screen1.jpg`, `tab_finished_work.jpg`, `queue_up_prompts.jpg`, `github_view.png`, `workflow_task_view.png`.
- [ ] All embedded image paths are repo-root-relative `images/<file>` (no absolute paths, no `http(s)://`, no leading `/` or `./`).
- [ ] README documents the Slack integration, including bot-token (`SLACK_TOKEN`) setup and the "Sign in with Slack" OAuth v2 flow.
- [ ] README documents the multi-agent Orchestrate workflow: a `## Tasks board & the Orchestrate workflow` section exists, the three agent roles (business-analyst, coder, tester) are named, and the six lane names appear: `todo`, `defining`, `in-progress`, `testing`, `failed-testing`, `done`.
- [ ] README documents per-ticket tokens/cost/build-time accounting (e.g. build time and cost shown on cards).
- [ ] README documents the in-app markdown preview: a "Show preview" toggle in the Files viewer that renders open `.md` files to formatted HTML and toggles back to raw source, appearing only for `.md` files, with no new npm dependency.
- [ ] Every local (non-http, non-anchor) markdown link target resolves to a file on disk.
- [ ] The Table of contents entries and anchors remain consistent with the headings present in README.md.
- [ ] `test/readme-docs.test.js` (extended for this ticket by the tester) passes under `node --test`, and no new runtime dependency is added to `package.json`.

## Cucumber Tests
```gherkin
Feature: README documents the new features and shows screens via images, not ASCII

  Scenario: No ASCII-art screen mockup remains
    Given the contents of README.md
    When I scan for box-drawing window mockups (┌ ┐ └ ┘ ║ ═ used to draw a screen)
    Then no ASCII-art window/screen mockup block is present
    And the "The window at a glance" section instead embeds images/working_screen1.jpg

  Scenario: The project-layout file tree is preserved
    Given the contents of README.md
    When I look at the "## Project layout" section
    Then a directory-tree code block using "├──" is still present

  Scenario: Every embedded local image exists on disk
    Given the contents of README.md
    When I extract every local markdown image reference "![alt](path)"
    Then each referenced image file exists on disk under the repo root

  Scenario: All five screenshots are referenced and present
    Given README.md and the images/ directory
    When I check for working_screen1.jpg, tab_finished_work.jpg, queue_up_prompts.jpg, github_view.png and workflow_task_view.png
    Then each name is referenced at least once in README.md
    And each file exists in images/

  Scenario: Image paths are repo-root-relative
    Given the contents of README.md
    When I extract every local image reference
    Then each path begins with "images/" and is not absolute, not "http(s)://", and has no leading "/" or "./"

  Scenario: Slack integration is documented
    Given the contents of README.md
    Then it describes the SLACK_TOKEN bot-token setup
    And it describes the "Sign in with Slack" OAuth flow

  Scenario: The Orchestrate workflow and Tasks board are documented
    Given the contents of README.md
    Then it contains the "## Tasks board & the Orchestrate workflow" heading
    And it names the business-analyst, coder and tester agent roles
    And it contains the lane names todo, defining, in-progress, testing, failed-testing and done

  Scenario: Tokens/cost accounting is documented
    Given the contents of README.md
    Then it describes per-ticket build time and cost (tokens/cost accounting)

  Scenario: Markdown preview feature is documented
    Given the contents of README.md
    Then the File Explorer docs describe a "Show preview" toggle that renders .md files as formatted HTML and toggles back to raw source

  Scenario: Table of contents stays consistent with headings
    Given the contents of README.md
    When I resolve every in-page anchor link in the Table of contents
    Then each anchor corresponds to a heading that exists in README.md

  Scenario: Every local relative link resolves
    Given the contents of README.md
    When I extract every local (non-http, non-anchor) markdown link target
    Then each target file exists on disk under the repo root

  Scenario (failure/edge): A referenced image that does not exist is caught
    Given a README.md that references "![x](images/does-not-exist.png)"
    When the docs-integrity test runs
    Then the test fails and reports images/does-not-exist.png as missing

  Scenario (failure/edge): A stale relative link is caught
    Given a README.md containing a link to a local file that has been deleted
    When the docs-integrity test runs
    Then the test fails and reports the broken relative link
```

## Edge / failure cases the coder must handle
- Broken image link: do not introduce an `![alt](images/…)` whose target does not exist; the docs-integrity test must catch a missing image.
- Image path correctness for both renderers: paths must be repo-root-relative `images/<file>` (correct for GitHub, safe for the in-app viewer `lib/markdown.js`).
- Filename case sensitivity: referenced filename must match on-disk name exactly (`.jpg` vs `.png`), since Git/GitHub are case-sensitive.
- Do not delete the `## Project layout` directory-tree block when removing the ASCII screen mockup.
- Stale ToC anchors: removing/renaming a heading must not leave a dangling ToC entry.
- No new dependency: documenting markdown preview must not add an npm dependency; `package.json` dependencies stay unchanged.
- Each embedded image needs meaningful alt text plus a caption line.

## Relevant files and context
- `README.md` — the only source file to edit. Key spots: ToC near lines 18-41; ASCII window mockup to remove near lines 121-134; the window image already near line 136; File Explorer section near lines 247-258 (add the markdown-preview paragraph); Slack section near lines 318-353; Tasks/Orchestrate section near lines 354-434; Project layout tree to preserve near lines 502-534. (Line numbers approximate — locate by heading.)
- `images/working_screen1.jpg`, `images/tab_finished_work.jpg`, `images/queue_up_prompts.jpg`, `images/github_view.png`, `images/workflow_task_view.png` — the five screenshots.
- `test/readme-docs.test.js` — existing docs-integrity test the tester will extend (image existence, five-screenshot references, Tasks section + six lanes, relative-link existence). Reads README.md + `images/`; no network/DB.
- Feature-source modules to reference accurately while writing docs (read-only): `lib/markdown.js` (markdown preview / TASK-015), `lib/slack.js`, `lib/slack-oauth.js`, `lib/slack-proxy.js` (Slack), `lib/orchestrate-agents.js` + `.claude/skills/orchestrate/SKILL.md` (multi-agent), `lib/ticket-accounting.js`, `lib/ticket-runs.js` (accounting), `lib/ticket-lanes.js`, `lib/ticket-folders.js` (six-lane enum, folder-per-status).
- Note: this ticket edits only `README.md`; it does not touch `.claude/` instruction files, so the assets/ drift-guard does not apply here.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
