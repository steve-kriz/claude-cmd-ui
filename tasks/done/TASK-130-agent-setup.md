---
id: TASK-130
title: agent setup
status: done
created: 2026-07-21T08:02:26.331Z
updated: 2026-07-21T08:43:58.000Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T08:03:44.000Z","finishedAt":"2026-07-21T08:12:01.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T08:14:05.000Z","finishedAt":"2026-07-21T08:26:15.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T08:26:15.000Z","finishedAt":"2026-07-21T08:37:29.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T08:37:29.000Z","finishedAt":"2026-07-21T08:43:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T08:43:00.000Z","finishedAt":"2026-07-21T08:43:58.000Z"}]
---

## Description

The Agents panel on the Team tab (`renderer/renderer.js` → `refreshTeamAgents` /
`buildAgentCard`) currently exposes only an agent's `description` for in-place
editing; the `model` scalar is editable only indirectly via the Workflow panel,
and the prompt **body** and `tools` are not editable at all after creation.
Setting up or tuning an agent therefore forces users into hand-editing
`.claude/agents/<name>.md`, which is exactly the hazard the panel was built to
remove (folded YAML, injection via stray newlines/`---`).

This ticket extends the agent card's edit mode in two ways:

1. **Full structured editing.** When the user clicks **Edit** on a parseable
   agent card, show all the editable parts of the `.md` file as separate
   **structured fields**: **Description** (folded block, existing path),
   **Tools** (single-line scalar), **Model** (single-line scalar), and the
   markdown **Body** (the prompt text after the closing fence). The `name` stays
   **read-only** (renaming is out of scope for this ticket). Saving performs ONE
   whole-file write through `writeWithMirror`, changing only the fields the user
   edited and preserving every other byte (unknown keys, key order, fences, EOL,
   trailing-newline shape) via the existing raw round-trip machinery.

2. **AI-assisted regeneration.** The edit mode gains an instruction box where the
   user types a natural-language description of the change they want (e.g. "make
   this agent also run the linter and forbid it from editing tests"). A
   **Regenerate with AI** button sends the current file content plus the
   instruction to the Anthropic Messages API via a new IPC handler modeled
   exactly on the existing `slack:summarize` mechanism (`lib/slack-summarize.js` +
   `ipcMain.handle('slack:summarize')` + `envStore.get('ANTHROPIC_API_KEY')`). The
   AI's proposed file is **never written directly**: it is parsed and validated
   (structural parse, name unchanged, scalar-injection guards, non-empty
   description), then loaded into the edit fields as a **preview** for the user to
   review and explicitly **Save**.

Why: agent tuning is the highest-friction part of the Team tab today, and
free-text edits to frontmatter are the highest-risk. This puts both the full file
and an AI assistant behind the panel's existing safety rails (parse → validate →
sanitized serialize → mirrored write → re-read).

## Clarifications

Resolved with the user before build (recorded here, not in Additional Context):

1. **Editing surface** → **Structured fields** (Description, Tools, Model, Body),
   Name read-only. Not a single raw-text editor.
2. **Renaming** (changing `name:`/filename) → **out of scope**. Name is
   display-only/read-only in the editor.
3. **AI mechanism** → **clone the `slack:summarize` Anthropic Messages API
   pattern** (direct API call using `ANTHROPIC_API_KEY`), NOT the local Claude CLI
   (pty).
4. **Apply flow** → **preview-then-Save**: the AI result fills the edit fields as
   a proposal; nothing is written until the user clicks Save (which runs full
   validation). No one-click regenerate-and-write.
5. **Model** → a single hardcoded constant using **`claude-sonnet-5`** (stronger
   than Haiku for rewriting a full agent definition). Not user-configurable this
   ticket.
6. **Placement** → **edit mode of an existing agent card only**. Do NOT add the AI
   box to the Add-agent modal in this ticket.

## Acceptance Criteria

**A. Expanded edit mode (structured fields)**

- [ ] Clicking **Edit** on a parseable agent card replaces the read view with an
  editor showing four editable fields pre-filled from the parsed file: Description
  (textarea), Tools (single-line input), Model (single-line input), and Body
  (textarea with the full markdown body after the closing frontmatter fence).
- [ ] The agent `name` is displayed in the editor but is read-only (not an input).
- [ ] **Cancel** discards all changes, restores the read view, and performs no
  write.
- [ ] **Save** validates before writing: Description must be non-whitespace
  (`agentDescriptionValid`); Tools must pass `sanitizeAgentToolsField`; Model must
  pass `sanitizeAgentModelField`. Any failure shows an inline error in the card and
  performs NO write.
- [ ] **Save** produces the new file content by rewriting only the changed parts
  on top of the parsed raw metadata (same approach as `serializeAgentDescription` /
  `serializeAgentModel`: unchanged frontmatter keys, unknown keys, key order,
  fences, detected EOL and trailing-newline shape are re-emitted byte-for-byte;
  description via the folded 2-space-indented `description: >-` path; tools/model as
  single sanitized `key: value` lines; an empty trimmed Tools/Model value
  removes/omits that key consistent with the Add-agent form's "empty means omit").
- [ ] Editing ONLY the body and saving leaves the entire frontmatter block
  byte-identical to the original.
- [ ] **Save** writes via `writeWithMirror(tab, filePath, content)`; on success the
  panel re-reads the directory (`refreshTeamAgents`) so the card reflects disk.
- [ ] A primary-write failure keeps the editor open with the user's text and shows
  the error inline; a mirror-only failure (`res.primaryOk && res.mirrorPath`) shows
  the existing drift message naming both paths.
- [ ] Unparseable/binary agent files keep today's behavior: `unparseable` badge, no
  editor, no AI controls, never rewritten.
- [ ] All dynamic text is rendered with `textContent` (never `innerHTML`).

**B. AI instruction box + regeneration**

- [ ] The editor includes an instruction textarea (placeholder explaining its
  purpose, e.g. "Describe how this agent should change...") and a **Regenerate with
  AI** button, shown ONLY in the edit mode of an existing parseable agent card.
- [ ] Clicking Regenerate with an empty/whitespace instruction shows an inline
  error and makes NO API call.
- [ ] A new Electron-free module `lib/agent-regenerate.js` (modeled on
  `lib/slack-summarize.js`: injectable `httpRequest`, never throws, structured
  `{ ok/content/reason }` results, model/max-tokens/timeout constants in one place)
  builds the prompt (current full file text + user instruction + strict "output
  ONLY the complete agent .md file, starting with `---`, no commentary or code
  fences" system instructions) and calls the Anthropic Messages API (`POST
  api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`)
  using model constant **`claude-sonnet-5`** with a regeneration-appropriate
  `max_tokens` (agent files are multi-KB; 512 is too small) and a timeout.
- [ ] A new `ipcMain.handle('agents:regenerate', ...)` in `main.js` reads
  `ANTHROPIC_API_KEY` from the env store (never logs or returns the key), enforces
  an input-size clamp before the external call (defense-in-depth, mirroring
  `SLACK_SUMMARIZE_MAX_INPUT_CHARS`), delegates to the lib module, and never throws
  into the renderer (structured `{ ok, ... }` results only). `preload.js` exposes it
  (e.g. `window.api.agents.regenerate(...)`).
- [ ] If `ANTHROPIC_API_KEY` is absent/empty, the regenerate flow shows a clear
  inline message telling the user to set the key (no API call, no crash). The
  renderer may pre-check via `window.api.env.get('ANTHROPIC_API_KEY')`.
- [ ] While a regeneration is in flight the Regenerate button is disabled with
  progress feedback (e.g. "Regenerating..."), and a stale-guard ensures a response
  arriving after the folder/tab changed or the editor closed is discarded without
  touching the DOM or disk.
- [ ] The AI response is validated in the renderer before it is shown: it must
  parse via `parseAgentFileRenderer` (tolerating and stripping one surrounding ```
  / ```markdown code fence first); the parsed `name` must equal the existing
  agent's `name` (the AI must not rename); `description` must be non-empty;
  `tools`/`model` (when present) must pass `sanitizeAgentToolsField` /
  `sanitizeAgentModelField`. Any validation failure shows an inline error ("AI
  returned an invalid agent file...") and NOTHING is written; the user's current
  edits are preserved.
- [ ] A validated AI result is NOT written automatically: it populates the four
  edit fields (Description/Tools/Model/Body) as a preview, with a visible note that
  this is an AI proposal, and the user must click **Save** (which runs the full
  section-A validation + write path) to persist it. Cancel discards it.
- [ ] An API failure (no key, timeout, non-200, network error, empty/malformed
  response) shows an inline error and leaves the editor state untouched — it never
  clears the user's fields, never writes, and never crashes the panel.

**C. Docs and tests**

- [ ] `docs/agent-management.md` (and the Agents row in `docs/team-tab.md`) are
  updated to describe the expanded editor and the AI regeneration flow, including
  the key requirement and the preview-then-save contract.
- [ ] `lib/agent-regenerate.js` has `node --test` unit tests with a mocked
  `httpRequest` (no real API traffic), covering: success, missing key, empty
  instruction/content, oversize clamp, non-200, malformed JSON, empty response,
  code-fence stripping, and timeout — mirroring `test/slack-summarize.test.js`.
- [ ] Renderer-side validation logic (AI-output acceptance rules, only-changed-fields
  serialization) is covered by tests following the existing renderer-mirror test
  pattern, including a byte-identical round-trip assertion for an untouched save and
  frontmatter preservation for a body-only edit.

## Cucumber Tests

```gherkin
Feature: Agent editor exposes the full editable agent file

  Background:
    Given a project folder is open on the Team tab
    And ".claude/agents/orchestrate-docs.md" is a parseable agent file
    And the Agents panel has rendered a card for "orchestrate-docs"

  Scenario: Edit opens a structured editor for all editable parts
    When I click "Edit" on the "orchestrate-docs" card
    Then I see editable fields pre-filled with the file's description, tools, model and body
    And the agent name "orchestrate-docs" is shown but not editable

  Scenario: Saving a body-only edit preserves the frontmatter byte-for-byte
    Given I clicked "Edit" on the card
    When I change only the Body field and click "Save"
    Then the file is written once via the mirror-aware writer
    And the frontmatter block of the written file is byte-identical to the original
    And the panel re-reads ".claude/agents/" and shows the updated card

  Scenario: Saving with no changes reproduces the file byte-identically
    Given I clicked "Edit" on the card
    When I click "Save" without changing any field
    Then the written content is byte-identical to the original file

  Scenario: Invalid scalar field is rejected inline with no write
    Given I clicked "Edit" on the card
    When I set the Model field to a value containing a line break
    And I click "Save"
    Then an inline error says the model must be a single line
    And no file write occurs

  Scenario: Empty description is rejected inline with no write
    Given I clicked "Edit" on the card
    When I clear the Description field and click "Save"
    Then an inline error says the description cannot be empty
    And no file write occurs

  Scenario: Cancel discards all edits
    Given I clicked "Edit" and changed the Tools and Body fields
    When I click "Cancel"
    Then the read view is restored showing the original values
    And no file write occurs

  Scenario: Mirror-only write failure surfaces a drift warning
    Given the file has an existing mirror under "assets/agents/"
    And the mirror write will fail
    When I save a valid edit
    Then the primary file is written
    And an inline message names both the primary path and the mirror path

  Scenario: Unparseable agent file has no editor and no AI controls
    Given ".claude/agents/broken.md" fails to parse
    Then its card shows the "unparseable" badge
    And no Edit button, instruction box or Regenerate control is shown for it

Feature: AI regeneration of an agent file from a natural-language instruction

  Background:
    Given a project folder is open on the Team tab
    And I clicked "Edit" on the parseable card for "orchestrate-docs"

  Scenario: Successful regeneration previews the result without writing
    Given ANTHROPIC_API_KEY is configured
    When I type "also allow the Bash tool and mention linting in the description" in the instruction box
    And I click "Regenerate with AI"
    And the API returns a valid agent file for "orchestrate-docs"
    Then the Description, Tools, Model and Body fields are replaced with the AI proposal
    And a note indicates the content is an AI proposal pending Save
    And no file has been written yet
    When I click "Save"
    Then the file is written via the mirror-aware writer and the panel refreshes

  Scenario: Empty instruction makes no API call
    When I click "Regenerate with AI" with an empty instruction box
    Then an inline error asks for an instruction
    And no API request is sent

  Scenario: Missing API key is reported without calling the API
    Given ANTHROPIC_API_KEY is not set
    When I enter an instruction and click "Regenerate with AI"
    Then an inline message says the Anthropic API key must be configured
    And no API request is sent

  Scenario: AI returns malformed frontmatter and is rejected
    Given ANTHROPIC_API_KEY is configured
    When I enter an instruction and click "Regenerate with AI"
    And the API responds with text that does not parse as an agent file
    Then an inline error says the AI returned an invalid agent file
    And the edit fields keep my current values
    And no file write occurs

  Scenario: AI attempts to rename the agent and is rejected
    When the API responds with a parseable file whose "name" is not "orchestrate-docs"
    Then the proposal is rejected with an inline error
    And no file write occurs

  Scenario: AI output smuggles a frontmatter injection and is rejected
    When the API responds with a file whose "model" value contains a line break or begins with "---"
    Then the proposal is rejected with an inline error
    And no file write occurs

  Scenario: AI output wrapped in a markdown code fence is tolerated
    When the API responds with a valid agent file wrapped in a ```markdown fence
    Then the fence is stripped and the proposal is validated and previewed normally

  Scenario: API call fails without disturbing the editor
    When the API call times out or returns a non-200 status
    Then an inline error reports the failure
    And the Regenerate button is re-enabled
    And my typed field values and instruction are unchanged
    And no file write occurs

  Scenario: Response arriving after the editor closed is discarded
    Given a regeneration is in flight
    When I switch the tab's folder before the response arrives
    Then the response is discarded with no DOM update and no write
```

## Edge Cases and Failure Modes

- **Byte-identical no-op:** saving with zero changes must reproduce the file exactly
  (CRLF vs LF, trailing-newline shape, unknown frontmatter keys, key order, folded
  wrapping) — reuse the parsed `meta` raw-lines approach; do not re-derive unchanged
  keys.
- **Frontmatter injection via Tools/Model:** line breaks (`\r\n`, ` `,
  ` `), C0/DEL control chars, and values starting with `---` must be rejected
  (`sanitizeAgentScalarField` set) — both for user input and for AI-proposed values.
  Escaping is not an option (breaks the round-trip); reject instead.
- **Description injection:** free text is safe only through the folded
  2-space-indented path (`formatAgentDescription` / `serializeAgentDescription`);
  never emit description as a bare scalar.
- **Body handling:** the body lives after the closing fence and cannot inject
  frontmatter, but body edits must not disturb the fence lines or the EOL
  convention; preserve the file's `hasBody === false` shape rules when the body is
  emptied.
- **Empty Tools/Model on save:** "empty removes the key" (matching Add-agent's
  omit-if-empty) and keep `serializeAgentModel`'s canonical-position insert behavior
  for a newly added model.
- **Unparseable existing file:** no editor, no AI box, never rewritten (existing
  contract).
- **AI failure modes:** missing key, disabled/empty instruction, oversize input
  clamp, non-200, network error, timeout, JSON parse failure, empty `content`
  blocks, response that is prose instead of a file, response wrapped in code fences
  (strip one outer fence), response that renames the agent, response with injected
  scalars, response with empty description. Every one: inline error, no write,
  editor state preserved.
- **Secrets:** the API key is read only in `main.js` from the env store and never
  logged or returned over IPC; the agent file text goes to an external billed API —
  clamp its size in main before the call.
- **Concurrency/staleness:** disable Regenerate and Save while a request/write is in
  flight; stale-guard the async response against tab/folder change and editor close
  (same pattern as `refreshTeamAgents`'s `tab.els.teamAgentsBody !== body` check).
- **Mirror drift:** mirror-only write failure must surface both paths (existing
  `writeWithMirror` contract); a mirror write that succeeds keeps `assets/agents/`
  byte-synced so drift-guard tests stay green.
- **`bindActionOnce`-style re-arming:** if the modal/editor buttons use once-bound
  handlers, every early-return error path must re-arm the button (see
  `openAddAgentModal`'s `armCreate`).

## Relevant Files and Context

**AI mechanism to reuse (verified — the app has exactly two AI paths today):**
1. `slack:summarize` — the ONLY structured request/response AI call: `preload.js`
   (`window.api.slack.summarize`) → `ipcMain.handle('slack:summarize')` in
   `main.js` (~line 1840; reads `ANTHROPIC_API_KEY` via `envStore.get`, clamps input
   to `SLACK_SUMMARIZE_MAX_INPUT_CHARS = 12000`) → `lib/slack-summarize.js`
   (`summarizeForSlack` + `defaultHttpRequest`: Anthropic Messages API `POST
   /v1/messages`, headers `x-api-key` / `anthropic-version: 2023-06-01`, model
   `claude-haiku-4-5`, 512 max tokens, 8s timeout, injectable `httpRequest` for
   tests, never throws). **This is the pattern to clone** for a new
   `agents:regenerate` IPC + `lib/agent-regenerate.js` — the summarize handler
   itself cannot be reused as-is (fixed summarization system prompt, 512-token cap,
   tail-clamp semantics). Use model constant `claude-sonnet-5` and a larger
   max_tokens for regeneration.
2. `pty:spawn` (`lib/pty.js`) — interactive Claude CLI terminals only; unsuitable
   for a structured inline regeneration call. (Not used for this ticket.)

**Editing/serialization:**
- `lib/agent-files.js` — `parseAgentFile` / `serializeAgentFile` /
  `validateAgentName`; byte-identical round-trip via the non-enumerable RAW Symbol;
  scalar-injection guard in `formatKey`. KEEP-IN-SYNC contract with the renderer
  mirror.
- `renderer/renderer.js` — `parseAgentFileRenderer` (~7571, returns
  `{ fm, body, meta }` with raw per-key lines/EOL/fences), `serializeAgentDescription`
  (~7634), `serializeAgentModel` (~7671), `agentDescriptionValid` (~7710),
  `refreshTeamAgents` (~7718, stale-guard pattern), `buildAgentCard` (~7801, current
  description-only editor + save/error/drift handling to extend),
  `validateAgentNameRenderer` (~7962), `sanitizeAgentScalarField` (~7995),
  `sanitizeAgentToolsField` (~8009), `sanitizeAgentModelField` (~8020),
  `buildAgentFileContent` (~8035), `openAddAgentModal` (~8081, `bindActionOnce`
  re-arm pattern), `writeWithMirror` (~6138, primary + existing-mirror-only sync +
  drift result contract). Listener wiring for the panel is at ~555-568; `initTeamTab`
  ~6765.
- `renderer/index.html` — `#addAgentModal` (line 92, field/label/error markup
  conventions to copy), Agents panel section (~703-710).
- `renderer/styles.css` — `team-agent*`, `addagent-*`, `install-banner` classes.

**Write path / mirror:**
- `lib/assets-mirror.js` + `docs/assets-mirror.md` — mirror mapping; `writeWithMirror`
  never creates a missing mirror; mirror-only failure → `{ ok:false, primaryOk:true,
  mirrorPath, mirrorError }`.

**IPC plumbing:**
- `preload.js` — add the new `agents.regenerate` bridge next to the existing groups;
  `env.get` (line 144) already lets the renderer check `ANTHROPIC_API_KEY` presence
  (`main.js` `env:get` at line 446 returns the value).
- `main.js` — place the new handler near `slack:summarize` and follow its
  structured-result / never-throw / never-log-key conventions.

**Docs & tests to follow:**
- `docs/agent-management.md`, `docs/team-tab.md` — update.
- `test/slack-summarize.test.js` / `test/slack-summarize.e2e.test.js` — the
  mocked-`httpRequest`, no-real-traffic test pattern for the new lib module.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
