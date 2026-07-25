# Agent management (Agents panel + Add agent)

## What it does and why

The **Agents** panel on the [Team tab](team-tab.md) is the UI for a project's
subagent definitions — the `.claude/agents/*.md` files the orchestrate workflow
dispatches to. It lets you:

- **List** every agent with its `name`, `model`, `tools`, and `description`.
- **Edit** an agent's full editable definition in place — **Description**,
  **Tools**, **Model**, and the markdown **Body** — as structured fields (the
  `name` is read-only; renaming is out of scope).
- **Regenerate with AI** — describe a change in natural language and have a Claude
  model propose a rewritten file, which is validated and loaded into the editor as
  a **preview** for you to review and **Save** (nothing is written automatically).
- **Add** a brand-new agent from a small form.

Editing these files by hand is error-prone: the frontmatter uses folded YAML
block scalars, and a stray newline or `---` can corrupt the file or (worse) let
free text inject a new frontmatter key. The panel centralises safe parsing,
safe rewriting, and validation so those hazards are handled once.

## How it works

### The pure model — `lib/agent-files.js`

[`lib/agent-files.js`](../lib/agent-files.js) is the Electron-free authority for
an agent definition file. It exposes:

- `parseAgentFile(content)` → `{ fm, body }` or `null` for malformed input.
  `fm` is `{ name, description, tools, model, ...unknownKeys }`.
- `serializeAgentFile(fm, body)` (or `serializeAgentFile(parseResult)`) → the
  file text, or `null` on bad input.
- `validateAgentName(name, existingNames)` → `{ valid, error }`.

**Byte-identical round-trip guarantee.** `serializeAgentFile(parseAgentFile(x))`
reproduces `x` exactly — same key order, unknown keys, folded-block wrapping,
line endings (CRLF or LF), and trailing-newline shape. This is achieved by
stashing the raw frontmatter lines, fence text, key order, and detected EOL on a
non-enumerable `Symbol` on the returned `fm`. On serialize, any key whose value
is **unchanged** since parse is re-emitted verbatim; only edited or brand-new
keys are freshly formatted. The Symbol is non-enumerable, so it never leaks into
`Object.keys`, JSON, spread, or `deepEqual`.

Everything is junk-tolerant: bad input to `parseAgentFile`/`serializeAgentFile`
returns `null` (never throws); `validateAgentName` always returns a structured
result.

**Scalar injection guard.** On the fresh-format path only, `serializeAgentFile`
returns `null` (rather than escaping, which would break the round-trip) if a
non-`description` key/value would emit a line break, a control character, a value
beginning with `---`, or an unparseable key name — mirroring the renderer's
`sanitizeAgentScalarField` character set; unchanged parsed keys and the folded
`description` block are unaffected.

**Name rules** (`validateAgentName`): must be a non-empty string matching
`[a-z0-9-]+`, must not be the reserved fallback agent `general-purpose`
(`FALLBACK_AGENT` from [`lib/orchestrate-agents.js`](../lib/orchestrate-agents.js)),
and must not duplicate an existing name.

### The renderer mirror

The renderer is a browser script and cannot `require` Node modules, so it
reimplements the slice it needs (marked *KEEP IN SYNC with lib/agent-files.js*):

- `parseAgentFileRenderer(content)` → `{ fm, body, meta }` — the `meta` carries
  the raw per-key lines, EOL, and fences so a rewrite can re-emit every *other*
  key byte-for-byte.
- `serializeAgentDescription(parsed, newDescription)` — rewrites the whole file
  changing **only** the folded `description` block. Every continuation line is
  indented two spaces (`formatAgentDescription`), so edited text can never inject
  a top-level key or a premature `---` fence.
- `serializeAgentModel(parsed, newModel)` — rewrites **only** the `model:` scalar
  (used by the Workflow panel's per-phase model editor). Inserts the key in
  canonical position (after `name`/`description`/`tools`) if absent.
- `serializeAgentEdits(parsed, { description, tools, model, body })` — the
  expanded-editor serializer: rewrites the whole file applying all four editable
  fields in **one pass**. Each key whose edited value equals the parsed value
  re-emits its RAW lines verbatim (byte-identical); only changed fields are freshly
  formatted (description via the folded 2-space-indented path, tools/model as single
  sanitized `key: value` lines). An empty (trimmed) tools/model value **omits** that
  key (matching the Add form's "empty means omit"); a newly-added tools/model key is
  inserted in canonical position. An unchanged/empty body preserves the file's
  `hasBody === false` no-trailing-EOL shape. tools/model must be pre-sanitized.
- `validateRegeneratedAgent(text, expectedName)` / `stripOneCodeFence(text)` — the
  AI-output acceptance rules (see below).

### Agents panel — list and edit (`refreshTeamAgents`, `buildAgentCard`)

`refreshTeamAgents(tab)` reads `<folder>/.claude/agents/`, sorts by filename, and
builds one card per file:

- **Parseable file** → shows the `name` (falling back to filename), a `model`
  badge and `tools` (when present), and the description with an **Edit** button.
  Edit replaces the read view with a structured editor exposing four editable
  fields pre-filled from the file — **Description** (textarea), **Tools**
  (single-line), **Model** (single-line), and **Body** (textarea, the markdown
  after the closing fence) — plus the read-only agent **name** and the AI box
  (below), with **Save**/**Cancel**. **Save** validates first (non-empty
  description via `agentDescriptionValid`; `sanitizeAgentToolsField` /
  `sanitizeAgentModelField` for the scalars) — any failure is inline with **no
  write** — then produces the new content with `serializeAgentEdits` and writes it
  in ONE `writeWithMirror` (see [assets-mirror.md](assets-mirror.md)), then re-reads
  the directory. A body-only edit leaves the frontmatter byte-identical; a no-change
  save reproduces the file byte-for-byte. **Cancel** discards all edits (including
  any AI proposal) and performs no write. A primary-write failure keeps the editor
  open with your text; a mirror-only failure shows the drift message naming both
  paths.
- **Unparseable/binary file** → listed by filename with an `unparseable` badge and
  editing disabled (no editor, **no AI controls**, never rewritten).
- **Empty/missing `.claude/agents/`** → an **Install orchestration skill** banner.

All dynamic text is written via `textContent`, never `innerHTML`.

### AI regeneration (`agents:regenerate`, `lib/agent-regenerate.js`)

The editor includes a **Regenerate with AI** box (shown only in the edit mode of a
parseable card). You type a natural-language instruction — e.g. "also allow the
Bash tool and mention linting in the description" — and click **Regenerate with
AI**. The current editor state (serialized via `serializeAgentEdits`) plus the
instruction go to the new `agents:regenerate` IPC handler in `main.js`, which reads
`ANTHROPIC_API_KEY` from the env store (**never** logged or returned), clamps both
inputs (defense-in-depth, mirroring the Slack summarizer's cap), and delegates to
the Electron-free [`lib/agent-regenerate.js`](../lib/agent-regenerate.js).

`lib/agent-regenerate.js` is modeled exactly on
[`lib/slack-summarize.js`](../lib/slack-summarize.js): an injectable `httpRequest`
(so it is unit-tested with **no real API traffic**), constants for the model
(`claude-sonnet-5`), `max_tokens` (large enough for a multi-KB file) and timeout in
one place, and it **never throws** — every branch returns a structured
`{ ok, content, reason }`. It calls the Anthropic Messages API
(`POST api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`)
with a system prompt instructing the model to output ONLY the complete agent file
(starting with `---`, no commentary or code fences).

**Preview-then-save contract.** The AI's proposal is **never written directly**.
The renderer validates it via `validateRegeneratedAgent`:

1. `stripOneCodeFence` tolerates one surrounding ```` ``` ````/```` ```markdown ````
   fence (a real agent file starts with `---`, so internal body fences are untouched).
2. it must parse via `parseAgentFileRenderer`;
3. the `name` must equal the existing agent's name (the AI must not rename);
4. `description` must be non-empty;
5. `tools`/`model` (when present) must pass the injection sanitizers.

On success the four edit fields are replaced with the proposal and a visible note
says it is an AI proposal pending **Save**; you must click Save (running the full
validation + write path) to persist it. **Cancel** discards it. Any failure — empty
instruction (no call), missing key (no call, clear inline message), non-200,
timeout, network error, malformed/empty response, unparseable file, rename, injected
scalar, or empty description — shows an inline error and leaves the editor state
untouched (your fields and instruction are preserved, nothing is written). The
Regenerate button is disabled with "Regenerating…" while a request is in flight, and
a stale-guard discards any response that arrives after the folder/tab changed or the
editor closed.

### Add agent (`openAddAgentModal`, `buildAgentFileContent`)

The **Add agent** button opens the `#addAgentModal` (defined in
[`renderer/index.html`](../renderer/index.html)) with fields: **Name**,
**Description** (required), **Tools** (optional), **Model** (optional), and a
prompt **body** (seeded with a starter). On **Create**:

1. `validateAgentNameRenderer(name, existingNames)` — mirrors `validateAgentName`
   plus extra guards rejecting leading/trailing-hyphen and all-hyphen slugs.
2. Description must be non-empty (`agentDescriptionValid`).
3. `sanitizeAgentToolsField` / `sanitizeAgentModelField` — reject any value with a
   line break, control character, or leading `---`, so a single `key: value`
   line can never break out of the frontmatter. Tools must be a
   comma/space-separated token list; model must be a single bare token.
4. `buildAgentFileContent(fields)` emits canonical `name / description / tools? /
   model?` frontmatter (description via the folded 2-space-indented path) plus
   the body — producing `---\n…\n---\n\n<body>\n`.
5. `mkdir -p .claude/agents/`, then an **existence check right before writing**
   refuses to overwrite an existing file (races a bundled install), then one
   `writeWithMirror`. On success the modal closes and the panel re-reads.

Q2 (design note in code): adding an agent does **not** change orchestrate
dispatch — the skill's phase→agent mapping is fixed. New agents are for
manual/display use.

## Configuration

An agent file's shape (matching the bundled agents under `assets/agents/`):

```markdown
---
name: orchestrate-docs
description: >-
  What this agent does, folded across
  wrapped lines at ~74 columns.
tools: Read, Grep, Glob
model: claude-sonnet-5
---
You are a specialized subagent.
...body...
```

`tools` and `model` are optional. `description` is required.

## Inputs and outputs

- **Input:** the form fields (Add), the structured editor fields (Edit:
  description/tools/model/body), or the AI instruction box (Regenerate).
- **Output:** a written `.claude/agents/<name>.md`, plus a byte-identical mirror
  under `assets/agents/<name>.md` **only if that mirror already exists**
  (see [assets-mirror.md](assets-mirror.md)). The AI regeneration path writes
  nothing on its own — it only fills the editor for review.

## Edge cases and limitations

- **Editing only some fields changes only those fields**; every other byte
  (unknown keys, key order, untouched values, fences, EOL, trailing newline) is
  preserved. A body-only edit keeps the frontmatter byte-identical, and a
  no-change save reproduces the file exactly.
- **AI never writes:** a validated proposal is a preview only; Save runs the same
  validation + write path as a manual edit. Any AI failure preserves your edits.
- **Secrets:** `ANTHROPIC_API_KEY` is read only in `main.js` and never logged or
  returned over IPC; the file text is size-clamped in main before the billed call.
- **Duplicate/invalid name** → inline error, no write. The write-time existence
  check is the authoritative race guard; the in-memory name set is an early hint.
- **Mirror drift on save** (primary written, mirror write failed) → an inline
  message naming both paths; the primary write still stands.
- **Reserved name** `general-purpose` is always rejected.
- The renderer duplicates parsing logic; it must be kept in lockstep with
  `lib/agent-files.js` (both files carry KEEP-IN-SYNC comments).
