'use strict';

// Pure, Electron-free model for tasks/team-config.json — the single source of
// truth for the dynamic-status engine (TASK-097). Like lib/ticket-lanes.js,
// lib/ticket-queue.js and lib/tasks-settings.js this module deliberately requires
// nothing from Electron or the DOM so it can be unit-tested with plain
// `node --test`. Every function here is pure: it derives, normalises, or
// validates a config object and never touches disk, git, localStorage, or the
// network, and NEVER throws — junk/partial/tampered input always collapses to a
// complete, valid config.
//
// Config shape (tasks/team-config.json):
//   { "version": 1,
//     "columns": [
//       { "status": "todo", "label": "To Do", "description": "",
//         "agent": null, "system": true },
//       { "status": "ux-review", "label": "UX Review", "description": "...",
//         "agent": "orchestrate-tech-lead", "system": false } ],
//     "skill": { "concurrencyDefault": 3 } }
//
// Columns
// -------
// The six SYSTEM columns mirror the fixed board lanes in lib/ticket-lanes.js's
// LANE_STATUSES order (todo → defining → in-progress → testing → post-processing
// → done) with today's board-header labels. Their slugs (the `status` field) and
// their `system: true` flag are IMMUTABLE — normalizeConfig re-injects any deleted
// system column and repairs any tampered slug/flag, so the six always survive with
// their exact canonical slugs and relative order. `failed-testing` is deliberately
// NOT a column: it stays a lane-less status that folds into Testing (see
// lib/ticket-lanes.js), so it is a RESERVED slug a user column may never take.
//
// USER columns (system:false) live between the system columns; their slug is
// chosen once and is immutable thereafter (a "rename" is a label edit only, so no
// ticket/folder migration is ever needed). A user slug must be `[a-z0-9-]`,
// <= 30 chars, and must not collide with VALID_STATUSES, `unknown`, `__wont-do__`,
// or an existing column. `agent` per column is display-only metadata (it may name
// a nonexistent agent — kept here, warned about at render time).
//
// skill.concurrencyDefault is normalised through resolveConcurrency (from
// lib/ticket-queue.js — the single authority for the [1, MAX_CONCURRENCY] clamp),
// so the config never carries an out-of-range build concurrency.
//
// Renderer-duplication convention: the renderer is a browser script that cannot
// `require` Node modules, so — exactly as ACTIVE_STATUSES / TASKS_ACTIVE_STATUSES
// and lib/tasks-settings.js's clamp are mirrored in renderer/renderer.js — the
// renderer inlines the tiny slug/label/normalize rules it needs and MUST be kept
// in lockstep with this file. This module stays the authoritative copy.

const { LANE_STATUSES, VALID_STATUSES } = require('./ticket-lanes');
const {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY, // re-exported for the renderer mirror; not used directly here
  resolveConcurrency,
} = require('./ticket-queue');

// The current persisted schema version. Newer versions round-trip untouched (see
// normalizeConfig) so a config written by a future build is never downgraded.
const CONFIG_VERSION = 1;

// The system columns, in canonical LANE_STATUSES order, keyed by slug → today's
// board-header label. Derived from LANE_STATUSES so the ordering can never drift
// from the board's own lane order.
const SYSTEM_LABELS = {
  todo: 'To Do',
  defining: 'Defining',
  'in-progress': 'In Progress',
  testing: 'Testing',
  'post-processing': 'Post-processing',
  done: 'Done',
};

// Canonical system slugs in board order (the immutable system columns).
const SYSTEM_SLUGS = LANE_STATUSES.slice();

// Slugs a user column may never take: every persistable status (all lane statuses
// PLUS failed-testing), the board's `unknown` routing lane, and the `__wont-do__`
// archive marker. The six system slugs are a subset of VALID_STATUSES, so a user
// column can never accidentally claim a system slug.
const RESERVED_SLUGS = new Set([...VALID_STATUSES, 'unknown', '__wont-do__']);

// Max length of a user slug, and the slug character class.
const MAX_SLUG_LENGTH = 30;
const SLUG_RE = /^[a-z0-9-]+$/;

// Canonical key order for a serialised column (unknown/newer fields round-trip
// after these, mirroring lib/ticket-queue.js's orderFm).
const COLUMN_KEYS = ['status', 'label', 'description', 'agent', 'system'];

// Keys that must never be copied by plain assignment during an unknown-field
// round-trip. `JSON.parse` (which normalizeConfig accepts as a string) defines
// `"__proto__"` as an OWN key; assigning `out.__proto__ = value` would fire the
// Object.prototype.__proto__ setter and reassign the target's prototype (object
// value) or silently swallow the key (primitive). `constructor`/`prototype` are
// skipped as defense-in-depth. These are dropped (with a warning where a
// warnings channel exists) rather than round-tripped. NOTE: the renderer mirror
// `tasksSerializeTeamConfig`'s `w.extra` loop (renderer/renderer.js ~5432-5437)
// shares this hazard and is a separate follow-up — do NOT rely on it being safe.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafeKey(k) {
  return UNSAFE_KEYS.has(k);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Return a copy of `col` with the canonical column keys first (in COLUMN_KEYS
// order, those present) then any remaining keys in insertion order — so unknown /
// newer-version column fields are preserved on round-trip.
function orderColumn(col) {
  const src = isPlainObject(col) ? col : {};
  const out = {};
  const hasOwn = Object.prototype.hasOwnProperty;
  for (const k of COLUMN_KEYS) {
    // hasOwnProperty (not `in`) so a column field named like an Object member
    // (toString/valueOf/…) is treated as its own value, never an inherited one.
    if (hasOwn.call(src, k)) out[k] = src[k];
  }
  for (const k of Object.keys(src)) {
    // Skip prototype-poisoning keys (F2 must land with F1): switching to
    // hasOwnProperty removes the accidental shielding the old `in` check gave
    // `out[k] = src[k]`, so drop __proto__/constructor/prototype here. This
    // path has no warnings channel, so the skip is silent (per the ticket).
    if (isUnsafeKey(k)) continue;
    if (!hasOwn.call(out, k)) out[k] = src[k];
  }
  return out;
}

// Normalise a column's `agent` metadata: a non-empty string is kept (trimmed),
// anything else becomes null. The agent is display-only, so a value naming a
// nonexistent agent is preserved here (any render-time warning happens elsewhere).
function normalizeAgent(agent) {
  if (typeof agent === 'string' && agent.trim() !== '') return agent.trim();
  return null;
}

// A readable fallback label derived from a slug ("ux-review" → "Ux Review"), used
// only when a column arrives without a usable label.
function prettifyLabel(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// True when `slug` is a syntactically valid user slug ([a-z0-9-], 1..30 chars).
function isValidUserSlug(slug) {
  return typeof slug === 'string'
    && slug.length > 0
    && slug.length <= MAX_SLUG_LENGTH
    && SLUG_RE.test(slug);
}

// Derive a user slug from a free-text label ("UX Review" → "ux-review"), clamped
// to MAX_SLUG_LENGTH with no leading/trailing dashes. Returns '' when the label
// yields nothing slug-worthy (the caller reports the error).
function slugForLabel(label) {
  return String(label == null ? '' : label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

// Build a fresh, canonical system column for `slug`.
function defaultSystemColumn(slug) {
  return orderColumn({
    status: slug,
    label: SYSTEM_LABELS[slug] || prettifyLabel(slug),
    description: '',
    agent: null,
    system: true,
  });
}

// Repair a raw system column: force the canonical slug and system:true, keep a
// user-customised label/description/agent when valid, default them otherwise, and
// round-trip any unknown fields.
function repairSystemColumn(slug, rawCol) {
  const src = isPlainObject(rawCol) ? { ...rawCol } : {};
  src.status = slug;          // immutable slug
  src.system = true;          // immutable flag
  if (typeof src.label !== 'string' || src.label.trim() === '') {
    src.label = SYSTEM_LABELS[slug] || prettifyLabel(slug);
  }
  if (typeof src.description !== 'string') src.description = '';
  src.agent = normalizeAgent(src.agent);
  return orderColumn(src);
}

// Build a normalised user column from a raw (already slug-validated) column.
function buildUserColumn(rawCol) {
  const src = { ...rawCol };
  src.status = src.status.trim();
  src.system = false;
  if (typeof src.label !== 'string' || src.label.trim() === '') {
    src.label = prettifyLabel(src.status);
  }
  if (typeof src.description !== 'string') src.description = '';
  src.agent = normalizeAgent(src.agent);
  return orderColumn(src);
}

// The default config: the six system columns in LANE_STATUSES order with today's
// board-header labels, and skill.concurrencyDefault === DEFAULT_CONCURRENCY.
function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    columns: SYSTEM_SLUGS.map((slug) => defaultSystemColumn(slug)),
    skill: { concurrencyDefault: DEFAULT_CONCURRENCY },
  };
}

// Normalise ANY input into a complete, valid config with a `warnings` list that
// reports every repair. Tolerates null/junk/partial/tampered input and never
// throws. See the module header for the guarantees enforced here.
function normalizeConfig(raw) {
  const warnings = [];
  try {
    let src = raw;
    if (typeof src === 'string') {
      try {
        src = JSON.parse(src);
      } catch (_) {
        warnings.push('config was not valid JSON; regenerated from defaults');
        src = null;
      }
    }
    if (!isPlainObject(src)) {
      if (raw != null && !(typeof raw === 'string' && warnings.length)) {
        warnings.push('config was missing or not an object; regenerated from defaults');
      }
      const cfg = defaultConfig();
      cfg.warnings = warnings;
      return cfg;
    }

    // version: keep a positive integer as-is (a newer version round-trips), else
    // reset to the current schema version.
    let version = CONFIG_VERSION;
    if (src.version != null) {
      const v = Number(src.version);
      if (Number.isFinite(v) && v >= 1) {
        version = Math.floor(v);
      } else {
        warnings.push('config version was invalid; reset to ' + CONFIG_VERSION);
      }
    }

    // Walk the raw columns once, classifying each as a system column (matched by
    // canonical slug) or a user column (anchored to the last system slug that
    // preceded it, so its position between system columns is preserved).
    let rawCols = [];
    if (Array.isArray(src.columns)) {
      rawCols = src.columns;
    } else if (src.columns != null) {
      warnings.push('columns was not an array; rebuilt from defaults');
    }

    const seenSystem = new Set();
    const seenUserSlugs = new Set();
    const systemRaw = Object.create(null); // slug → first raw column seen
    const userCols = []; // { anchor: slug|null, col }
    let lastSystemSlug = null; // anchor for a user column; null = before `todo`

    for (const rc of rawCols) {
      if (!isPlainObject(rc)) {
        warnings.push('ignored a non-object column entry');
        continue;
      }
      const status = typeof rc.status === 'string' ? rc.status.trim() : '';

      if (SYSTEM_SLUGS.includes(status)) {
        if (seenSystem.has(status)) {
          warnings.push(`duplicate system column "${status}" ignored (first wins)`);
          continue;
        }
        seenSystem.add(status);
        systemRaw[status] = rc;
        lastSystemSlug = status;
        if (rc.system === false) {
          warnings.push(`system column "${status}" had system:false; repaired to system:true`);
        }
        continue;
      }

      // Not a system slug. A column flagged system:true here is a tampered/renamed
      // system column — the flag is invalid on a non-system slug, so it is demoted
      // to a user column (the real system column is re-injected below).
      if (rc.system === true) {
        warnings.push(`column "${status || '(blank)'}" was flagged system with a non-system slug; demoted to a user column`);
      }

      if (status === '') {
        warnings.push('ignored a column with a blank slug');
        continue;
      }
      if (RESERVED_SLUGS.has(status)) {
        warnings.push(`ignored user column with reserved slug "${status}"`);
        continue;
      }
      if (!isValidUserSlug(status)) {
        warnings.push(`ignored user column with invalid slug "${status}" (must be [a-z0-9-], <= ${MAX_SLUG_LENGTH} chars)`);
        continue;
      }
      if (seenUserSlugs.has(status)) {
        warnings.push(`duplicate user column "${status}" ignored (first wins)`);
        continue;
      }
      seenUserSlugs.add(status);
      userCols.push({ anchor: lastSystemSlug, col: rc });
    }

    // Rebuild: user columns anchored before any system column first, then each
    // system column (canonical order, re-injecting any missing one) followed by
    // its anchored user columns.
    const columns = [];
    const appendAnchored = (anchor) => {
      for (const u of userCols) {
        if (u.anchor === anchor) columns.push(buildUserColumn(u.col));
      }
    };

    appendAnchored(null);
    for (const slug of SYSTEM_SLUGS) {
      if (seenSystem.has(slug)) {
        columns.push(repairSystemColumn(slug, systemRaw[slug]));
      } else {
        warnings.push(`missing system column "${slug}" re-inserted`);
        columns.push(defaultSystemColumn(slug));
      }
      appendAnchored(slug);
    }

    // skill.concurrencyDefault clamped through resolveConcurrency; unknown skill
    // fields round-trip.
    const rawSkill = isPlainObject(src.skill) ? { ...src.skill } : {};
    const concInput = rawSkill.concurrencyDefault;
    const resolvedConc = resolveConcurrency(concInput);
    if (concInput != null && concInput !== '' && String(concInput) !== String(resolvedConc)) {
      warnings.push(`skill.concurrencyDefault ${JSON.stringify(concInput)} normalized to ${resolvedConc}`);
    }
    const skill = { concurrencyDefault: resolvedConc };
    for (const k of Object.keys(rawSkill)) {
      if (k === 'concurrencyDefault') continue;
      if (isUnsafeKey(k)) {
        warnings.push(`ignored unsafe skill key "${k}"`);
        continue;
      }
      skill[k] = rawSkill[k];
    }

    // Assemble, round-tripping any unknown top-level fields.
    const out = { version, columns, skill };
    for (const k of Object.keys(src)) {
      if (k === 'version' || k === 'columns' || k === 'skill' || k === 'warnings') continue;
      if (isUnsafeKey(k)) {
        warnings.push(`ignored unsafe top-level key "${k}"`);
        continue;
      }
      out[k] = src[k];
    }
    out.warnings = warnings;
    return out;
  } catch (_) {
    // Absolute safety net: this module must never throw.
    const cfg = defaultConfig();
    cfg.warnings = ['config could not be parsed; regenerated from defaults'];
    return cfg;
  }
}

// Validate a proposed NEW user column. `slug` is optional — when blank it is
// derived from `label` via slugForLabel. Returns { ok, slug, error } and never
// throws. Rejects: blank label; a slug that is blank, contains non-slug
// characters, exceeds MAX_SLUG_LENGTH, is reserved (VALID_STATUSES / `unknown` /
// `__wont-do__`), or collides with an existing column in `config`.
function validateNewColumn(label, slug, config) {
  const labelStr = typeof label === 'string' ? label.trim() : '';
  if (labelStr === '') {
    return { ok: false, slug: '', error: 'Label is required.' };
  }

  const provided = slug == null ? '' : String(slug).trim();
  const finalSlug = provided !== '' ? provided : slugForLabel(labelStr);

  if (finalSlug === '') {
    return { ok: false, slug: '', error: 'Slug is required.' };
  }
  if (finalSlug.length > MAX_SLUG_LENGTH) {
    return { ok: false, slug: finalSlug, error: `Slug must be ${MAX_SLUG_LENGTH} characters or fewer.` };
  }
  if (!SLUG_RE.test(finalSlug)) {
    return { ok: false, slug: finalSlug, error: 'Slug may only contain lowercase letters, numbers, and dashes.' };
  }
  if (RESERVED_SLUGS.has(finalSlug)) {
    return { ok: false, slug: finalSlug, error: `Slug "${finalSlug}" is reserved.` };
  }

  const cfg = normalizeConfig(config);
  const existing = new Set(cfg.columns.map((c) => c.status));
  if (existing.has(finalSlug)) {
    return { ok: false, slug: finalSlug, error: `A column with slug "${finalSlug}" already exists.` };
  }

  return { ok: true, slug: finalSlug, error: null };
}

// Serialise a config to the persistable JSON string written to
// tasks/team-config.json. Normalises first (so the on-disk file is always valid)
// and strips the transient `warnings` list. Ends with a trailing newline.
function serializeConfig(config) {
  const normalized = normalizeConfig(config);
  const out = {};
  for (const k of Object.keys(normalized)) {
    if (k === 'warnings') continue;
    // Defense-in-depth: normalizeConfig already drops these, but keep the strip
    // loop from ever re-introducing a prototype-poisoning key on assignment.
    if (isUnsafeKey(k)) continue;
    out[k] = normalized[k];
  }
  return JSON.stringify(out, null, 2) + '\n';
}

module.exports = {
  CONFIG_VERSION,
  SYSTEM_SLUGS,
  SYSTEM_LABELS,
  RESERVED_SLUGS,
  MAX_SLUG_LENGTH,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  defaultConfig,
  normalizeConfig,
  validateNewColumn,
  slugForLabel,
  serializeConfig,
};
