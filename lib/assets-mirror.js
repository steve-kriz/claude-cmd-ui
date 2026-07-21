'use strict';

// Assets drift-guard mapping (TASK-093, Q6). The repo keeps two copies of the
// orchestrate instruction files: the live ones the app reads/writes under a
// project's `.claude/`, and a byte-identical `assets/` copy that ships with the
// installer and is asserted equal by the drift-guard tests
// (test/orchestrate-agents.test.js, test/orchestrate-swarm.test.js). Whenever the
// app writes one of the mirrored files it must write BOTH copies so the mirror
// never drifts — see the renderer's writeWithMirror, which duplicates this tiny
// logic (the renderer is a browser script and cannot require Node modules, the
// same duplication convention lib/ticket-lanes.js documents).
//
// Like lib/ticket-definition.js and lib/ticket-lanes.js this module requires
// nothing from Electron so it can be unit-tested with plain `node --test`.
// `mirrorRelPath` is PURE and totally tolerant of junk: any non-string / path
// outside the two mirrored subtrees returns null and it never throws. It maps
// only paths, never touches the filesystem, and therefore never creates a
// mirror — the caller checks the mirror exists before writing it.

// The two mirrored subtrees. A project-root-relative path under one of these
// `.claude/` prefixes maps to the same remainder under the matching `assets/`
// prefix; everything else (e.g. `.claude/settings.json`, `tasks/x.md`) is not
// mirrored. Prefixes are stored with `/` separators; mirrorRelPath normalises
// its input to `/` first so both `/` and `\` inputs match.
const MIRRORED_SUBTREES = [
  { from: '.claude/agents/', to: 'assets/agents/' },
  { from: '.claude/skills/orchestrate/', to: 'assets/skills/orchestrate/' },
];

// Map a project-root-relative path to its `assets/…` mirror path, or null when
// the path is not one of the two mirrored subtrees. Handles both `/` and `\`
// separators, tolerates a leading `./` and leading slashes, and returns a
// `/`-separated relative path. Never throws.
//
// Examples:
//   '.claude/agents/ba.md'                 -> 'assets/agents/ba.md'
//   '.claude\\skills\\orchestrate\\SKILL.md' -> 'assets/skills/orchestrate/SKILL.md'
//   '.claude/settings.json'                -> null
//   'tasks/x.md'                           -> null
function mirrorRelPath(relPath) {
  if (typeof relPath !== 'string') return null;
  // Normalise separators, then strip a leading `./` and any leading slashes so
  // `./.claude/agents/x.md` and `/.claude/agents/x.md` still match.
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  for (const { from, to } of MIRRORED_SUBTREES) {
    // Require a non-empty remainder — the directory itself never maps to a file.
    if (norm.startsWith(from) && norm.length > from.length) {
      return to + norm.slice(from.length);
    }
  }
  return null;
}

module.exports = {
  MIRRORED_SUBTREES,
  mirrorRelPath,
};
