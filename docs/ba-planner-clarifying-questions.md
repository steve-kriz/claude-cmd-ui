# BA planner clarifying questions

## What it does and why

During the orchestrate **Plan / Define** phase (Phase 1) the business-analyst (BA)
agent turns a feature request into small, testable tickets. If the BA silently
guesses when part of the request is genuinely ambiguous, that guess is baked into
the acceptance criteria and only surfaces as rework after the code is built.

This feature makes the BA **gather maximal context and surface clarifying
questions** for anything it cannot settle from the codebase or the request, and
makes the orchestrator get **every** raised question answered by the **user**
before planning is allowed to complete. No ticket leaves the `defining` stage —
and the Phase-1 STOP message is not issued — until every question has a non-empty
answer. Answers are recorded in the ticket **body**, never in the user-owned
`## Additional Context` section. This was added in TASK-066.

## How it works

This feature is **instructions plus an existing storage helper**, not new
executable logic. Two instruction files drive it, and the durable
question/answer storage reuses the TASK-005 mechanism.

- **BA agent instructions** —
  [`.claude/agents/ba.md`](../.claude/agents/ba.md), the `## Clarifying questions`
  section. The BA must enumerate **every** open question (about scope, behavior,
  data shape, or intent) instead of quietly picking one interpretation, and report
  those questions back to the orchestrator **alongside** the tickets it defined,
  **naming the affected ticket id(s)** for each question. The BA still **never
  writes files** — it only raises the questions; the orchestrator puts them to the
  user and records the answers.
- **Orchestrator instructions** —
  [`.claude/skills/orchestrate/SKILL.md`](../.claude/skills/orchestrate/SKILL.md),
  Phase 1, step 3 ("Resolve every clarifying question before you finish").
- **Question/answer storage** —
  [`lib/ticket-questions.js`](../lib/ticket-questions.js) (the TASK-005 mechanism),
  which stores a question/answer pair on a ticket's flat frontmatter and derives a
  "waiting for answer" state that turns the ticket's board dot **yellow**.

> Note: the instruction files under `.claude/` have byte-for-byte copies under
> `assets/` (`assets/agents/ba.md`, `assets/skills/orchestrate/SKILL.md`) that the
> install step (`tasks:installSkill`) copies into a project. Editing one requires
> syncing the other or the drift-guard tests fail.

### Phase-1 flow

From `SKILL.md` Phase 1:

1. The orchestrator creates the `tasks/` folder if needed and finds the highest
   `TASK-<nnn>` so new ids continue the sequence.
2. It launches **one** `orchestrate-ba` subagent (dispatched on the premium
   `claude-opus-4-8` tier, falling back to the default `claude-sonnet-5` if it is
   unavailable, and to `general-purpose` if the `orchestrate-ba` definition is
   missing). The BA thoroughly analyzes the codebase
   and writes one `tasks/TASK-<nnn>-<slug>.md` per ticket, **and** returns any
   clarifying questions it raised, each naming the affected ticket id(s).
3. **Resolve every clarifying question.** The orchestrator must put **every**
   raised question to the **user**:
   - use the **AskUserQuestion** tool when available; **otherwise**
   - write the question onto the affected ticket's `question` frontmatter field
     (the `lib/ticket-questions.js` mechanism, which turns that ticket's board dot
     **yellow**) and wait for a non-empty `answer`.

   Planning is **not** complete — the orchestrator does **not** issue the Phase-1
   STOP message and **no** ticket leaves `defining` — until **every** raised
   question has a non-empty answer. Each answer is recorded in the ticket **body**
   (for example a `## Clarifications` section of Q/A pairs) and **never** written
   into the user-owned `## Additional Context` section.
4. Only once every question is answered does the orchestrator list the created
   tickets and STOP with:

   > Tickets created. Review and enrich them in the **Tasks** tab — especially the
   > **Additional Context** of each ticket — then run `/orchestrate build`.

## The ticket question/answer mechanism (`lib/ticket-questions.js`)

The fallback (frontmatter) path stores the question/answer on two flat
frontmatter keys and derives the waiting state:

- `question` — the text the agent raised (a single line).
- `answer` — the answer the user chose (a single line).

Both values are normalised to a single trimmed line (newlines collapsed to
spaces) before storage, because flat `key: value` frontmatter cannot hold
newlines. A ticket is **waiting for an answer** exactly when it has a non-empty
`question` and no non-empty `answer` — this is **derived, not stored as its own
flag**, so the yellow board dot clears within one board poll the moment the answer
lands on disk.

`lib/ticket-questions.js` exports (all pure; each returns a **new** frontmatter
object and never touches disk):

| Export | Signature | Description |
|--------|-----------|-------------|
| `isWaitingForAnswer(fm)` | `→ boolean` | `true` when a question is present and no answer yet (the yellow-dot predicate; also mirrored in the renderer). |
| `hasQuestion(fm)` | `→ boolean` | `true` when `fm.question` is non-empty. |
| `hasAnswer(fm)` | `→ boolean` | `true` when `fm.answer` is non-empty. |
| `askQuestion(fm, question, opts)` | `→ fm'` | Sets `question` (one line), clears any prior `answer`, bumps `updated`. Empty question clears the whole Q/A pair. |
| `answerQuestion(fm, answer, opts)` | `→ fm'` | Sets `answer` (one line) keeping `question`, bumps `updated`. Empty answer removes `answer` (ticket waits again). |
| `clearQuestion(fm, opts)` | `→ fm'` | Removes both `question` and `answer`, bumps `updated`. |
| `orderFm(fm)` / `toSingleLine(v)` | helpers | Key ordering (`id, title, status, created, updated` first) and single-line normalisation. |

`opts.at` (a `Date` or ISO string) sets the `updated` stamp, defaulting to now.

## Usage / examples

Recording an answer against a ticket via the frontmatter mechanism:

```js
const q = require('./lib/ticket-questions');

// Agent raises a question (orchestrator writes this to the ticket file):
let fm = q.askQuestion(ticketFm, 'Should the export include archived rows?');
q.isWaitingForAnswer(fm); // → true  (board dot goes yellow)

// User answers (via the modal / board):
fm = q.answerQuestion(fm, 'Yes, include archived rows.');
q.isWaitingForAnswer(fm); // → false (yellow clears next poll)
```

The resulting frontmatter carries the Q/A durably so a later reader sees both what
was asked and what was decided:

```
question: Should the export include archived rows?
answer: Yes, include archived rows.
```

Once the resolved Q/A has been folded into the ticket **body**, the orchestrator
may call `clearQuestion(fm)` to remove the frontmatter pair.

## Edge cases & limitations

- **Every question must be answered before planning completes.** A single
  unanswered question blocks the Phase-1 STOP message and keeps tickets in
  `defining`.
- **Answers go in the ticket body, never in `## Additional Context`.** That
  section is user-owned; the BA leaves it as an empty heading with a placeholder
  and the orchestrator never writes into it.
- **The BA never writes files.** It only raises questions; the orchestrator owns
  ticket status/frontmatter and all writes.
- **Single-line frontmatter.** `question` / `answer` text is collapsed to one line
  (newlines → spaces) to fit flat frontmatter; multi-line answers lose their line
  breaks in the frontmatter (the full prose belongs in the ticket body).
- **Waiting state is derived, not stored.** There is no separate "waiting" flag;
  it is computed from `question` present + `answer` absent, so it self-heals on the
  next poll.
- **AskUserQuestion is preferred when available**; the frontmatter/yellow-dot path
  is the fallback when it is not.

## Tests

```bash
node --test test/task-066-ba-clarifying-questions.test.js \
            test/task-066-ba-clarifying-questions.e2e.test.js
```
