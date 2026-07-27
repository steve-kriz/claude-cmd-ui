'use strict';

// Pure, Electron-free scoped-section splice for the orchestrate SKILL.md
// (TASK-184). Given the full SKILL.md text and one of the four canonical
// PHASE_SPECS keys (plan/build/test/review), this module can:
//   - extractPhaseBody:  pull out that `## Phase <n>` section's body text.
//   - replacePhaseBody:  produce a new full SKILL.md with ONLY that section's
//     body replaced — every other byte (other phases, other `##` sections,
//     frontmatter, EOL style, trailing newline) preserved exactly.
//
// This is the reusable engine a later ticket (TASK-185, the Workflow panel's
// "Regenerate this phase's instructions" action) feeds into the renderer's
// existing writeWithMirror so the write lands scoped + mirror-synced. Nothing
// in this module performs any I/O; it never writes a file, and it NEVER
// throws — every function returns a structured `{ ok, ..., reason }` result,
// degrading to `ok: false` on any unexpected input or internal error.
//
// Reuses lib/skill-workflow.js's fence-aware `sectionsOf` splitter and
// `phaseNumberOf` matcher (the exact same logic `parseWorkflow` uses) so a
// `## Phase <n>` heading inside a fenced code block is never mistaken for a
// real section boundary, and phase numbering stays in lockstep with
// PHASE_SPECS. Duplicate `## Phase <n>` headings are resolved first-wins,
// exactly like parseWorkflow.
const { PHASE_SPECS, sectionsOf, phaseNumberOf } = require('./skill-workflow');

// The four canonical phase keys, derived from PHASE_SPECS so this module can
// never drift out of sync with the single source of truth.
const PHASE_KEYS = Object.freeze(PHASE_SPECS.map((s) => s.key));

function specForKey(phaseKey) {
  return PHASE_SPECS.find((s) => s.key === phaseKey) || null;
}

// The line-ending style to rejoin with. `sectionsOf`/split are EOL-agnostic
// (they split on /\r?\n/), so this just decides which style to use when we
// serialize lines back into text; matches the CRLF-detection convention used
// by renderer.js's agent-file serializer (task-130).
function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

// Strip ONE surrounding markdown code fence from AI output, if present, so a
// phase-section body the model wrapped in ``` / ```markdown still splices
// cleanly (mirrors renderer.js's stripOneCodeFence for agent files, TASK-130).
// Non-string input yields ''. Only fires when the ENTIRE payload is fenced;
// this does not (and must not) try to detect or merge multiple sections —
// that guard lives in the byte-diff check inside replacePhaseBody below.
function stripOneCodeFence(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  const m = /^```[^\n]*\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (m) return m[1];
  return raw;
}

// Locate the (first-wins) section for `spec.number` inside `skillMd`'s
// sectionsOf() output. Returns the section object or null. Never throws by
// itself (sectionsOf already tolerates anything coercible to a string); the
// callers wrap this in try/catch as belt-and-braces.
function findPhaseSection(sections, spec) {
  for (const section of sections) {
    if (phaseNumberOf(section.name) === spec.number) return section;
  }
  return null;
}

// extractPhaseBody(skillMd, phaseKey) -> { ok, body, reason }
// Pulls the current prose body of the `## Phase <n>` section identified by
// `phaseKey` (one of PHASE_KEYS). NEVER throws. `reason` on failure is one of:
//   'invalid-input'  — skillMd is not a non-empty string
//   'bad-phase-key'  — phaseKey is not one of the four canonical keys
//   'missing-phase'  — no `## Phase <n>` heading for that phase exists
//   'parse-error'    — an unexpected internal failure (defense in depth)
function extractPhaseBody(skillMd, phaseKey) {
  try {
    if (typeof skillMd !== 'string' || skillMd.length === 0) {
      return { ok: false, body: '', reason: 'invalid-input' };
    }
    const spec = specForKey(phaseKey);
    if (!spec) return { ok: false, body: '', reason: 'bad-phase-key' };

    const sections = sectionsOf(skillMd);
    const section = findPhaseSection(sections, spec);
    if (!section) return { ok: false, body: '', reason: 'missing-phase' };

    const eol = detectEol(skillMd);
    return { ok: true, body: section.lines.join(eol), reason: 'ok' };
  } catch (_) {
    return { ok: false, body: '', reason: 'parse-error' };
  }
}

// replacePhaseBody(skillMd, phaseKey, newBody) -> { ok, content, reason }
// Produces the FULL new SKILL.md text with ONLY the `phaseKey` phase's
// section body replaced by `newBody` — every other line (other phases, other
// `##` sections, any preamble/frontmatter before the first section, EOL
// style, trailing-newline shape) is preserved byte-for-byte. Replacing with
// the section's own current body reproduces the input exactly.
//
// Tolerates ONE surrounding code fence around `newBody` (see
// stripOneCodeFence above) before splicing.
//
// Refuses (returns { ok:false }, produces no output — never a partial write)
// when:
//   'invalid-input'            — skillMd is not a non-empty string
//   'bad-phase-key'            — phaseKey is not one of the four canonical keys
//   'invalid-body'             — newBody is not a string
//   'missing-phase'            — no `## Phase <n>` heading for that phase exists
//   'section-boundary-violation' — splicing in newBody would change the
//                                   heading or body of ANY other section (e.g.
//                                   newBody contains an unbalanced code fence
//                                   that shifts later fence-parsing state, or
//                                   newBody itself contains another `##`
//                                   heading, merging/duplicating sections)
//   'parse-error'              — an unexpected internal failure
function replacePhaseBody(skillMd, phaseKey, newBody) {
  try {
    if (typeof skillMd !== 'string' || skillMd.length === 0) {
      return { ok: false, content: '', reason: 'invalid-input' };
    }
    const spec = specForKey(phaseKey);
    if (!spec) return { ok: false, content: '', reason: 'bad-phase-key' };
    if (typeof newBody !== 'string') {
      return { ok: false, content: '', reason: 'invalid-body' };
    }

    const originalSections = sectionsOf(skillMd);
    const section = findPhaseSection(originalSections, spec);
    if (!section) return { ok: false, content: '', reason: 'missing-phase' };

    const eol = detectEol(skillMd);
    const lines = skillMd.split(/\r?\n/);

    // section.startLine is the heading's 1-based line number, so 0-based the
    // heading sits at (startLine - 1) and the body begins immediately after.
    const headingIndex = section.startLine - 1;
    const bodyStart = headingIndex + 1;
    const bodyLen = section.lines.length;

    const cleanedBody = stripOneCodeFence(newBody);
    const newBodyLines = cleanedBody.split(/\r?\n/);

    const newLines = lines
      .slice(0, bodyStart)
      .concat(newBodyLines)
      .concat(lines.slice(bodyStart + bodyLen));
    const newContent = newLines.join(eol);

    // Byte-diff guard: rebuild the section map of the spliced result and
    // require every OTHER section to be untouched (same name, same body) at
    // the same position, and the total section count to be unchanged. This
    // catches both an unbalanced fence in newBody (which would shift later
    // fence-parsing state) and newBody smuggling in another `##` heading
    // (which would insert/merge a section) — never silently accepted.
    const rebuiltSections = sectionsOf(newContent);
    if (rebuiltSections.length !== originalSections.length) {
      return { ok: false, content: '', reason: 'section-boundary-violation' };
    }
    const targetIdx = originalSections.indexOf(section);
    for (let i = 0; i < originalSections.length; i++) {
      if (i === targetIdx) continue;
      const before = originalSections[i];
      const after = rebuiltSections[i];
      if (!after || before.name !== after.name
        || before.lines.join('\n') !== after.lines.join('\n')) {
        return { ok: false, content: '', reason: 'section-boundary-violation' };
      }
    }

    return { ok: true, content: newContent, reason: 'ok' };
  } catch (_) {
    return { ok: false, content: '', reason: 'parse-error' };
  }
}

module.exports = {
  PHASE_KEYS,
  extractPhaseBody,
  replacePhaseBody,
  stripOneCodeFence
};
