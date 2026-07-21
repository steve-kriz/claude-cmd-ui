'use strict';

// Electron-free read-model for the orchestrate SKILL.md (TASK-096). Parses the
// bundled `.claude/skills/orchestrate/SKILL.md` prose into an ordered, read-only
// workflow model the Workflow panel (TASK-105) and guided editor (TASK-106) can
// render WITHOUT re-scanning the markdown themselves. SKILL.md itself is NEVER
// written by anything downstream of this module (clarification Q3): this is a
// read model only — heading/pattern based, prose-tolerant, no I/O.
//
// Like lib/ticket-definition.js this module is intentionally pure: it requires
// nothing from Electron (and nothing but its sibling lib/orchestrate-agents.js),
// so it can be unit-tested with plain `node --test`. `parseWorkflow` is TOTALLY
// tolerant of junk: any null/undefined/non-string/binary/garbage input returns
// `{ phases: [], warnings: [...] }` and NEVER throws.
//
// Renderer-duplication convention: renderer/renderer.js is a browser script and
// cannot `require` Node modules, so — exactly like lib/ticket-progress.js
// (countRunning) and lib/ticket-lanes.js — this module hosts the CANONICAL
// parsing logic and the renderer mirrors whatever slice of it it needs inline
// browser-side. This file is the source of truth; keep any renderer mirror in
// lockstep — changing one without the other is a bug.

const { AGENT_TYPES, AGENT_NAMES } = require('./orchestrate-agents');

// The four ordered orchestrate phases, keyed plan -> build -> test -> review to
// match how work moves on the board. Each spec fixes:
//   key      — stable machine key used by the Workflow panel / guided editor.
//   number   — the `Phase <n>` number as written in SKILL.md's headings.
//   label    — human name for warnings (e.g. "Missing Phase 3 (test) heading").
//   agent    — the dedicated orchestrate-* subagent this phase dispatches to,
//              the canonical default used when the SKILL.md dispatch line for
//              this phase cannot be parsed. Sourced from AGENT_TYPES so it stays
//              in lockstep with lib/orchestrate-agents.js.
const PHASE_SPECS = Object.freeze([
  { key: 'plan', number: 1, label: 'plan', agent: AGENT_TYPES.ba },
  { key: 'build', number: 2, label: 'build', agent: AGENT_TYPES.coder },
  { key: 'test', number: 3, label: 'test', agent: AGENT_TYPES.tester },
  { key: 'review', number: 4, label: 'review', agent: AGENT_TYPES.techLead }
]);

// The Phase-1 planning model directive as stated in SKILL.md: dispatch the BA on
// `claude-fable-5` when available, otherwise fall back to `claude-opus-4-8`. Used
// as the canonical value when the prose form is present but its exact model
// tokens cannot be teased apart.
const PLAN_MODEL_PRIMARY = 'claude-fable-5';
const PLAN_MODEL_FALLBACK = 'claude-opus-4-8';

// A level-2 markdown heading line: `## <text>` (leading spaces tolerated).
// Returns the trimmed heading text, or null when the line is not a level-2
// heading. Mirrors lib/ticket-definition.js's headingName.
function headingName(line) {
  const m = /^\s*##\s+(.*?)\s*$/.exec(line);
  return m ? m[1] : null;
}

// Given a level-2 heading's text, return the `Phase <n>` number it declares, or
// null when it is not a phase heading. Tolerant of the em-dash/paren styling in
// SKILL.md (`Phase 1 — Plan / Define (business analyst)`).
function phaseNumberOf(headingText) {
  const m = /^Phase\s+(\d+)\b/i.exec(headingText);
  return m ? Number(m[1]) : null;
}

// Extract an orchestrate-* agent name that appears in `text` AND is a known
// dedicated agent (AGENT_NAMES). Returns the first match, or null. Kept strict
// to AGENT_NAMES so stray prose mentioning some other `orchestrate-x` token
// cannot masquerade as a dispatched agent.
function agentIn(text) {
  const re = /orchestrate-[a-z-]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[0].toLowerCase();
    if (AGENT_NAMES.includes(name)) return name;
  }
  return null;
}

// Detect the Phase-1 model directive inside `text`. Looks for the primary model
// `claude-fable-5`; when present, returns { primary, fallback } capturing the
// stated fallback (`claude-opus-4-8` when that token also appears, else the
// canonical fallback). Returns null when no directive is stated.
function modelDirectiveIn(text) {
  if (!/claude-fable-5/i.test(text)) return null;
  // Collect claude-* model tokens in order; the fallback is the first token that
  // is not the primary (SKILL.md states "on `claude-fable-5` ... otherwise fall
  // back to `claude-opus-4-8`"). Degrade to the canonical fallback if absent.
  let fallback = null;
  const re = /claude-[a-z0-9.-]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[0].toLowerCase();
    if (token !== PLAN_MODEL_PRIMARY) { fallback = token; break; }
  }
  return { primary: PLAN_MODEL_PRIMARY, fallback: fallback || PLAN_MODEL_FALLBACK };
}

// Split `md` into level-2 sections: an array of { name, startLine, lines },
// where `lines` are the body lines after the heading up to (but excluding) the
// next level-2 heading, and `startLine` is the heading's 1-based line number.
// Fence-aware so a `## ` INSIDE a ```fenced``` block does not open a section
// (SKILL.md embeds a sample ticket with `## Description` etc. in a fence).
function sectionsOf(md) {
  const lines = String(md).split(/\r?\n/);
  const sections = [];
  let current = null;
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A real fenced-code line is ONLY the fence marker plus an optional single
    // info word (no trailing prose) — this rejects inline prose like
    // "```gherkin block. A ..." that would otherwise open a never-closed fence
    // and swallow later headings.
    const fence = /^\s*(`{3,}|~{3,})\s*\S*\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) { inFence = true; fenceMarker = marker; }
      else if (marker === fenceMarker) { inFence = false; }
      if (current) current.lines.push(line);
      continue;
    }
    if (!inFence) {
      const h = headingName(line);
      if (h != null) {
        current = { name: h, startLine: i + 1, lines: [] };
        sections.push(current);
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

// Parse SKILL.md content into a read-only workflow model:
//   { phases: [{ key, title, agent, model?, headingLine }], warnings: [] }
// Phases return in canonical order (plan, build, test, review) regardless of the
// order the headings appear in the document. A phase whose `## Phase <n>`
// heading is absent is OMITTED from `phases` and named in `warnings`. Any
// null/non-string/binary/garbage input yields { phases: [], warnings: [...] }.
// Never throws.
function parseWorkflow(skillMd) {
  const warnings = [];
  if (typeof skillMd !== 'string') {
    warnings.push('SKILL.md content is not a string; no workflow parsed.');
    return { phases: [], warnings };
  }
  try {
    const sections = sectionsOf(skillMd);

    // Locate each phase's `## Phase <n>` heading section by its declared number.
    const phaseSectionByNumber = new Map();
    for (const section of sections) {
      const num = phaseNumberOf(section.name);
      if (num != null && !phaseSectionByNumber.has(num)) {
        phaseSectionByNumber.set(num, section);
      }
    }

    // The "Agent dispatch and fallback" section maps each phase -> its agent and
    // states the Phase-1 model directive. Prefer it as the agent/model source.
    const dispatchSection = sections.find(s => /dispatch/i.test(s.name)
      && /fallback/i.test(s.name));
    const dispatchText = dispatchSection ? dispatchSection.lines.join('\n') : '';

    const phases = [];
    for (const spec of PHASE_SPECS) {
      const section = phaseSectionByNumber.get(spec.number);
      if (!section) {
        warnings.push(
          `Missing Phase ${spec.number} (${spec.label}) heading in SKILL.md.`
        );
        continue;
      }
      const bodyText = section.lines.join('\n');

      // Agent: prefer the dispatch section's `**Phase <n> ...** -> orchestrate-x`
      // line, then this phase's own body, then the canonical default.
      let agent = agentFromDispatch(dispatchText, spec.number)
        || agentIn(bodyText)
        || spec.agent;

      const phase = {
        key: spec.key,
        title: section.name,
        agent,
        headingLine: section.startLine
      };

      // Model directive applies to Phase 1 (plan) only. Detect it from the
      // dispatch section first, then the plan phase's own body.
      if (spec.number === 1) {
        const model = modelDirectiveIn(dispatchText) || modelDirectiveIn(bodyText);
        if (model) phase.model = model;
      }

      phases.push(phase);
    }

    return { phases, warnings };
  } catch (_) {
    // Total tolerance: any unexpected parse failure degrades to empty phases.
    return { phases: [], warnings: warnings.concat('Could not parse SKILL.md.') };
  }
}

// From the dispatch section text, find the agent named on the line that also
// mentions `Phase <n>` (e.g. `**Phase 1 (Plan / Define)** -> \`orchestrate-ba\``).
// Returns the known orchestrate-* agent or null.
function agentFromDispatch(dispatchText, number) {
  if (!dispatchText) return null;
  const lines = dispatchText.split(/\r?\n/);
  const re = new RegExp('Phase\\s+' + number + '\\b', 'i');
  for (const line of lines) {
    if (re.test(line)) {
      const agent = agentIn(line);
      if (agent) return agent;
    }
  }
  return null;
}

module.exports = {
  PHASE_SPECS,
  PLAN_MODEL_PRIMARY,
  PLAN_MODEL_FALLBACK,
  parseWorkflow
};
