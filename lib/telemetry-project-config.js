'use strict';

// Pure, Electron-free model for the per-project telemetry on/off switch
// (TASK-155). Like lib/team-config.js and lib/telemetry.js this module
// deliberately requires nothing from Electron, the DOM, disk, or the network
// so it can be unit-tested with plain `node --test`. Every function here is
// pure: it derives, normalises, or serialises a config object and never
// touches disk, git, localStorage, or the network, and NEVER throws —
// junk/partial/tampered input always collapses to a complete, valid config.
//
// File path contract: <projectFolder>/tasks/telemetry-config.json.
//
// Why a separate file (and not a key in tasks/team-config.json): telemetry
// (whether THIS project's usage is forwarded online) is an unrelated concern
// to team-config.json's board columns / skill schema, so it gets its own
// small file rather than growing team-config's schema.
//
// Scope: this is ONLY the per-project on/off switch. The global forwarding
// config (destination URL, bearer token, receiver port, master enable) stays
// app-level in .env — see lib/telemetry.js's normalizeTelemetryConfig — and is
// unaffected by this module.
//
// Config shape (tasks/telemetry-config.json):
//   { "version": 1, "storeOnline": false }
//
// storeOnline defaults to false (opt-in): a project must explicitly opt in
// before its telemetry is forwarded anywhere.

// The current persisted schema version. Newer versions round-trip untouched
// (see normalizeProjectTelemetryConfig) so a config written by a future build
// is never downgraded.
const CONFIG_VERSION = 1;

// Keys that must never be copied by plain assignment during an unknown-field
// round-trip (prototype-pollution guard), mirroring lib/team-config.js and
// lib/telemetry.js.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafeKey(k) {
  return UNSAFE_KEYS.has(k);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The default config: schema version 1, storeOnline opted out.
function defaultProjectTelemetryConfig() {
  return {
    version: CONFIG_VERSION,
    storeOnline: false,
  };
}

// Normalise ANY input into a complete, valid per-project telemetry config with
// a `warnings` list that reports every repair. Accepts a plain object, a JSON
// string, or junk (null/number/array/tampered) and never throws.
function normalizeProjectTelemetryConfig(raw) {
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
      const cfg = defaultProjectTelemetryConfig();
      cfg.warnings = warnings;
      return cfg;
    }

    // version: keep a positive integer as-is (a newer version round-trips),
    // else reset to the current schema version.
    let version = CONFIG_VERSION;
    if (src.version != null) {
      const v = Number(src.version);
      if (Number.isFinite(v) && v >= 1) {
        version = Math.floor(v);
      } else {
        warnings.push('config version was invalid; reset to ' + CONFIG_VERSION);
      }
    }

    // storeOnline: strict boolean coercion, matching normalizeTelemetryConfig's
    // style in lib/telemetry.js (true / "true" / 1 are true, everything else
    // false).
    const storeOnline = src.storeOnline === true || src.storeOnline === 'true' || src.storeOnline === 1;

    // Assemble, round-tripping any unknown top-level fields except
    // prototype-poisoning keys.
    const out = { version, storeOnline };
    for (const k of Object.keys(src)) {
      if (k === 'version' || k === 'storeOnline' || k === 'warnings') continue;
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
    const cfg = defaultProjectTelemetryConfig();
    cfg.warnings = ['config could not be parsed; regenerated from defaults'];
    return cfg;
  }
}

// Serialise a config to the persistable JSON string written to
// tasks/telemetry-config.json. Normalises first (so the on-disk file is
// always valid) and strips the transient `warnings` list. Ends with a
// trailing newline.
function serializeProjectTelemetryConfig(config) {
  const normalized = normalizeProjectTelemetryConfig(config);
  const out = {};
  for (const k of Object.keys(normalized)) {
    if (k === 'warnings') continue;
    // Defense-in-depth: normalizeProjectTelemetryConfig already drops these,
    // but keep the strip loop from ever re-introducing a prototype-poisoning
    // key on assignment.
    if (isUnsafeKey(k)) continue;
    out[k] = normalized[k];
  }
  return JSON.stringify(out, null, 2) + '\n';
}

module.exports = {
  CONFIG_VERSION,
  defaultProjectTelemetryConfig,
  normalizeProjectTelemetryConfig,
  serializeProjectTelemetryConfig,
};
