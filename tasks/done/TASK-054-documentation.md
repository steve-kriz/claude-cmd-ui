---
id: TASK-054
title: Documentation
status: done
created: 2026-07-19T06:08:24.489Z
updated: 2026-08-03T11:00:00.000Z
resolution: wont-do
---

## Description
Retired: this was a post-processing ticket; it was never run and is kept here, unbuilt, after the post-processing column was removed (TASK-206).

Thought process
Thought process
Here's the revised prompt.

Prompt: Generate README plus per-feature documentation

You are a technical writer and engineer. Your job is to produce a complete README.md and a docs/ folder containing one Markdown file for each core piece of functionality in this project.

Method

Explore the codebase first to build a ground-truth inventory of functionality before writing anything. Look at: entry points, CLI commands/flags, public APIs and exported functions, HTTP routes/endpoints, config options and environment variables, build/run scripts, feature flags, and integrations.
Group that inventory into distinct "core pieces of functionality" — each one meaningful enough to warrant its own doc (e.g. authentication, data import, the API layer, background jobs, the CLI). List them before writing.
Create the README and one doc file per core feature, with every claim traceable to real code.
README.md must include

Project overview: what it does and who it's for.
Feature summary: a short description of each core piece of functionality, each linking to its detailed file in docs/.
Installation / prerequisites (exact commands, versions, dependencies).
Quick start: the minimal path to running the project.
Configuration overview: key env vars and config options (defaults + purpose).
Development / testing: how to build, run, and test locally.
A "Documentation" section with a table of contents linking to every file in docs/.
docs/ folder — one .md file per core feature
Name each file clearly (e.g. docs/authentication.md, docs/data-import.md). Each file must contain:

What the feature does and why it exists.
How it works: key components, flow, and where it lives in the code (file/module references).
Usage: runnable examples — commands, API calls, or code snippets that work as written.
Configuration specific to this feature (env vars, options, defaults).
Inputs/outputs or API/CLI reference for this feature (parameters, return values, endpoints).
Edge cases, limitations, and troubleshooting.
Rules

Verify every example against the actual code — do not document behavior you haven't confirmed exists.
Keep one feature per file; don't merge unrelated functionality or split one feature across files.
Use consistent structure and headings across all docs/ files so they read as a set.
Use code blocks for all commands and snippets; keep everything clear and scannable.
Flag anything ambiguous rather than guessing.
At the end, output the list of files created (README + each docs file) and a note of anything you couldn't verify and need the maintainer to confirm.

## Acceptance Criteria
- [ ] First testable criterion

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
