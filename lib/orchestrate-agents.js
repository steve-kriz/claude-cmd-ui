// Pure helpers describing the dedicated orchestration subagent types and the
// graceful fallback used when a named agent definition is missing at dispatch.
// No I/O, no Electron — safe to require from anywhere and unit-test in isolation.

'use strict';

// The generic agent every phase falls back to when its dedicated definition
// is absent from the project's .claude/agents/.
const FALLBACK_AGENT = 'general-purpose';

// Dedicated agent type names, keyed by orchestration phase/role. These match the
// `name:` frontmatter in assets/agents/*.md (and the project's .claude/agents/).
const AGENT_TYPES = Object.freeze({
  ba: 'orchestrate-ba',
  coder: 'orchestrate-coder',
  tester: 'orchestrate-tester',
  techLead: 'orchestrate-tech-lead'
});

// All dedicated agent names as an array (ordered plan -> build -> test -> review).
const AGENT_NAMES = Object.freeze([
  AGENT_TYPES.ba,
  AGENT_TYPES.coder,
  AGENT_TYPES.tester,
  AGENT_TYPES.techLead
]);

// Resolve which agent type to dispatch to. Returns `name` when it appears in the
// list of available agents; otherwise returns the generic fallback so dispatch
// continues instead of aborting. `availableAgents` may be an array or a Set of
// agent name strings; anything falsy/malformed is treated as "none available".
function resolveAgentType(name, availableAgents) {
  if (typeof name !== 'string' || name === '') return FALLBACK_AGENT;
  let has = false;
  if (Array.isArray(availableAgents)) {
    has = availableAgents.includes(name);
  } else if (availableAgents instanceof Set) {
    has = availableAgents.has(name);
  }
  return has ? name : FALLBACK_AGENT;
}

// Convenience: true when resolveAgentType had to fall back (i.e. the dedicated
// agent was missing and the caller should report it).
function isFallback(name, availableAgents) {
  return resolveAgentType(name, availableAgents) === FALLBACK_AGENT
    && name !== FALLBACK_AGENT;
}

module.exports = {
  FALLBACK_AGENT,
  AGENT_TYPES,
  AGENT_NAMES,
  resolveAgentType,
  isFallback
};
