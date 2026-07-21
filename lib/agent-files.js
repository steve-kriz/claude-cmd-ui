'use strict';

// Electron-free model for an agent DEFINITION file — the `.claude/agents/*.md`
// (and mirrored `assets/agents/*.md`) documents that describe an orchestration
// subagent. It parses the YAML-ish frontmatter (`name`, folded
// `description: >-`, `tools`, optional `model`, plus any unknown keys) and the
// markdown body, serializes them back, and validates a proposed agent name.
// This is the single authority for the Team tab (TASK-094/095/106) and the
// tests, superseding the ad-hoc parser inlined in test/orchestrate-agents.test.js.
//
// Like lib/ticket-lanes.js, lib/ticket-definition.js and lib/orchestrate-agents.js
// this module deliberately requires nothing from Electron or the DOM so it can be
// unit-tested with plain `node --test`. The renderer (a browser script that
// cannot require Node modules) duplicates the tiny slice of this logic it needs,
// matching how TASK-003/005 handled the browser side.
//
// BYTE-IDENTICAL ROUND-TRIP GUARANTEE:
//   `serializeAgentFile(parseAgentFile(content))` reproduces `content` exactly —
//   same key order, same unknown keys, same folded-block wrapping, same line
//   endings (CRLF or LF) and trailing-newline shape — for every bundled agent
//   file. This is achieved not by re-deriving the text from the parsed values
//   (folded YAML wrapping is not uniquely reversible) but by stashing the exact
//   RAW frontmatter lines, fence text, key order and detected EOL on the returned
//   `fm` object under a non-enumerable Symbol. Serialization re-emits those raw
//   lines verbatim for any key whose value is unchanged since parse, and only
//   falls back to freshly formatted YAML for values the caller edited or for
//   brand-new `fm` objects (the "Add agent" write path, TASK-093). The Symbol is
//   non-enumerable so it never leaks into Object.keys / JSON / spread / deepEqual.
//
// SCALAR INJECTION HARDENING (TASK-108): on the fresh-format path only, a
// non-`description` key/value that would emit a line break, a control char, a
// value beginning with `---`, or an unparseable key name is REJECTED (serialize
// returns null) rather than escaped — escaping would break the byte-identical
// round-trip since parseAgentFile does not unquote. Unchanged parsed keys still
// re-emit RAW verbatim (never validated) and the folded `description` path is
// untouched. The rejected character set mirrors the renderer sanitizeAgentScalarField.
//
// Everything here is TOTALLY tolerant of junk: malformed or non-string input to
// parseAgentFile returns null and never throws; serializeAgentFile returns null
// rather than throwing on bad input; validateAgentName always returns a structured
// result.

const { FALLBACK_AGENT } = require('./orchestrate-agents');

// Non-enumerable carrier for the raw round-trip metadata (see header). Keyed by a
// Symbol so it is invisible to Object.keys, for..in, JSON.stringify and object
// spread — the parsed `fm` still looks like a plain { name, description, ... }.
const RAW = Symbol('agentFileRaw');

// A top-level frontmatter key line: `key: value` with the key starting at column
// 0 (no leading whitespace — indented lines are block-scalar continuations, not
// keys). The value (m[2]) is optional so a bare `key:` is tolerated.
const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

// The parseable shape of a freshly emitted top-level key name (the key portion of
// KEY_RE). A fresh-format key that does not match this could not be re-parsed as a
// top-level key, so serialization REJECTS it (see formatKey's injection guard).
const FRESH_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// A YAML block-scalar indicator token: `>` / `|` optionally followed by a chomping
// (`-` strip / `+` keep) and/or explicit indent digit — e.g. the `>-` all four
// bundled agent files use for `description`.
const BLOCK_RE = /^[|>][+-]?\d*\s*$/;

// A frontmatter fence line: exactly `---` (trailing spaces tolerated).
const FENCE_RE = /^---\s*$/;

// Allowed agent-name shape: lowercase letters, digits and hyphens only. Matches
// the `name:` convention of the bundled agents (e.g. `orchestrate-ba`).
const NAME_RE = /^[a-z0-9-]+$/;

// Structural, order-insensitive value equality used to decide whether a key's
// value is unchanged since parse (so its RAW lines can be re-emitted verbatim).
// All bundled values are plain strings, for which this is a fast `===`.
function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

// Resolve a YAML block scalar (`>` folded / `|` literal, with `-`/`+`/clip
// chomping) from its raw continuation lines. Used to produce the *parsed*
// `fm.description` string; round-trip fidelity does not depend on it (RAW lines
// are re-emitted), so the common single-paragraph folded case is what matters.
function resolveBlockScalar(rawLines, indicator) {
  const literal = indicator[0] === '|';
  const chomp = indicator.includes('-') ? 'strip'
    : indicator.includes('+') ? 'keep'
      : 'clip';
  const nonEmpty = rawLines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return '';
  const indent = Math.min(...nonEmpty.map((l) => l.match(/^ */)[0].length));
  const dedented = rawLines.map((l) => l.slice(indent));

  let value;
  if (literal) {
    value = dedented.join('\n');
  } else {
    // Folded: consecutive non-blank lines join with a single space; a blank line
    // becomes a paragraph break (newline).
    const parts = [];
    let buf = [];
    for (const line of dedented) {
      if (line.trim() === '') {
        parts.push(buf.join(' '));
        buf = [];
      } else {
        buf.push(line);
      }
    }
    parts.push(buf.join(' '));
    value = parts.join('\n');
  }

  if (chomp === 'strip') return value.replace(/\n+$/, '');
  if (chomp === 'clip') return value.replace(/\n+$/, '') + '\n';
  return value; // keep
}

// Format a single frontmatter key/value as fresh YAML lines (used only for
// caller-edited values and brand-new `fm` objects — never for an unchanged
// round-trip). `description` is emitted as a folded `>-` block wrapped to a
// readable width with 2-space indentation; everything else is a plain scalar.
//
// INJECTION GUARD (non-`description` scalar/array path): the emitted value is a
// single physical `key: value` line, so a line break or a premature `---` fence
// in the value — or a key name that could not re-parse as a top-level key — would
// smuggle extra frontmatter keys or split the fence on re-parse. Rather than
// escape (which parseAgentFile does not reverse, breaking the byte-identical
// round-trip), such input is REJECTED: formatKey returns `null`, which the caller
// turns into serializeAgentFile returning `null`. The character set mirrors the
// renderer `sanitizeAgentScalarField` exactly (line separators + C0/DEL controls,
// value not beginning with `---`). The folded `description` path is unchanged and
// out of scope for this guard.
function formatKey(key, value) {
  const out = [];

  if (key === 'description') {
    out.push(`${key}: >-`);
    const paragraphs = String(value).split('\n');
    // Emit exactly one blank separator line per `\n` in the value (i.e. before
    // every paragraph after the first) so a folded re-parse folds each paragraph
    // independently and the paragraph breaks round-trip. Without this, adjacent
    // non-empty paragraphs would re-fold into a single space-joined paragraph.
    paragraphs.forEach((para, idx) => {
      if (idx > 0) out.push('');
      const words = para.split(/\s+/).filter(Boolean);
      if (words.length === 0) return;
      let cur = '';
      for (const w of words) {
        if (cur === '') {
          cur = w;
        } else if (cur.length + 1 + w.length <= 74) {
          cur += ' ' + w;
        } else {
          out.push('  ' + cur);
          cur = w;
        }
      }
      if (cur !== '') out.push('  ' + cur);
    });
    return out;
  }

  // A freshly emitted key name must be a parseable top-level key.
  if (!FRESH_KEY_RE.test(key)) return null;

  const emitted = Array.isArray(value) ? value.join(', ') : String(value);
  // Reject line breaks and control chars, mirroring the renderer
  // sanitizeAgentScalarField set exactly: /[CR LF U+2028 U+2029]/ union
  // /[U+0000-U+001F U+007F]/. Scanned by char code so this source stays
  // ASCII-only (no literal line-separator characters).
  for (let i = 0; i < emitted.length; i++) {
    const c = emitted.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x2028 || c === 0x2029) return null;
  }
  // A value beginning (after optional whitespace) with `---` is refused too.
  if (/^\s*---/.test(emitted)) return null;

  out.push(`${key}: ${emitted}`);
  return out;
}

// Parse an agent definition file. Returns
//   { fm: { name, description, tools, model, ...unknownKeys }, body }
// or null for any non-string / unfenced / unclosed / otherwise malformed input.
// Never throws. The returned `fm` carries hidden RAW metadata enabling a
// byte-identical serialize (see header).
function parseAgentFile(content) {
  if (typeof content !== 'string') return null;
  try {
    const eol = /\r\n/.test(content) ? '\r\n' : '\n';
    const lines = content.split(eol);

    // Opening fence must be the very first line.
    if (lines.length === 0 || !FENCE_RE.test(lines[0])) return null;

    // Locate the closing fence.
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i])) {
        close = i;
        break;
      }
    }
    if (close === -1) return null; // unclosed frontmatter

    const openFence = lines[0];
    const closeFence = lines[close];
    const fmLines = lines.slice(1, close);
    const hasBody = lines.length > close + 1;
    const body = hasBody ? lines.slice(close + 1).join(eol) : '';

    const fm = {};
    const keyOrder = [];
    const rawByKey = {};
    const tokByKey = {};
    const contentByKey = {};
    const preamble = []; // any stray lines before the first key (tolerated)
    let curKey = null;

    for (const line of fmLines) {
      const m = KEY_RE.exec(line);
      const isTopKey = m && !/^\s/.test(line);
      if (isTopKey) {
        curKey = m[1];
        if (!(curKey in rawByKey)) keyOrder.push(curKey);
        rawByKey[curKey] = [line];
        tokByKey[curKey] = m[2] === undefined ? null : m[2];
        contentByKey[curKey] = [];
      } else if (curKey !== null) {
        rawByKey[curKey].push(line);
        contentByKey[curKey].push(line);
      } else {
        preamble.push(line);
      }
    }

    for (const key of keyOrder) {
      const tok = tokByKey[key];
      if (tok !== null && BLOCK_RE.test(tok)) {
        fm[key] = resolveBlockScalar(contentByKey[key], tok.trim());
      } else {
        fm[key] = tok === null ? '' : tok.replace(/\s+$/, '');
      }
    }

    const meta = {
      eol,
      openFence,
      closeFence,
      keyOrder,
      rawByKey,
      preamble,
      hasBody,
      origValues: Object.assign({}, fm)
    };
    Object.defineProperty(fm, RAW, {
      value: meta,
      enumerable: false,
      configurable: true,
      writable: true
    });

    return { fm, body };
  } catch (_) {
    return null;
  }
}

// Serialize a frontmatter object + body back into agent-file text. Accepts either
//   serializeAgentFile(fm, body)
// or the whole parse result:
//   serializeAgentFile({ fm, body })
// Re-emits the RAW lines verbatim for unchanged keys (byte-identical round-trip)
// and freshly formats edited/new keys. Returns null (never throws) for bad input,
// and also returns null when a freshly formatted non-`description` key/value would
// inject a newline / control char / premature `---` fence, or has an unparseable
// key name (see formatKey's injection guard).
function serializeAgentFile(fmArg, bodyArg) {
  try {
    let fm = fmArg;
    let body = bodyArg;
    // Unwrap a parse result passed as a single argument.
    if (bodyArg === undefined && fmArg && typeof fmArg === 'object'
      && fmArg.fm && typeof fmArg.fm === 'object'
      && typeof fmArg.body === 'string') {
      fm = fmArg.fm;
      body = fmArg.body;
    }
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null;

    const meta = fm[RAW] || null;
    const eol = (meta && meta.eol) || '\n';
    const openFence = (meta && meta.openFence != null) ? meta.openFence : '---';
    const closeFence = (meta && meta.closeFence != null) ? meta.closeFence : '---';

    // Determine the key emission order. With RAW metadata: preserve the original
    // order, then append any newly added keys. Without it (a fresh object):
    // canonical name/description/tools/model first, then the rest.
    let allKeys;
    if (meta) {
      const seen = new Set(meta.keyOrder);
      const extras = Object.keys(fm).filter((k) => !seen.has(k));
      allKeys = meta.keyOrder.concat(extras);
    } else {
      const preferred = ['name', 'description', 'tools', 'model'];
      const rest = Object.keys(fm).filter((k) => !preferred.includes(k));
      allKeys = preferred.filter((k) => Object.prototype.hasOwnProperty.call(fm, k)).concat(rest);
    }

    const outLines = [openFence];
    if (meta && Array.isArray(meta.preamble)) {
      for (const l of meta.preamble) outLines.push(l);
    }

    for (const key of allKeys) {
      if (!Object.prototype.hasOwnProperty.call(fm, key)) continue; // key removed
      const raw = meta && meta.rawByKey ? meta.rawByKey[key] : null;
      const unchanged = raw && meta.origValues
        && sameValue(fm[key], meta.origValues[key]);
      if (unchanged) {
        for (const l of raw) outLines.push(l);
      } else {
        const formatted = formatKey(key, fm[key]);
        // A rejected fresh-format key/value (injection guard) fails the whole
        // serialize — return null rather than emit an unsafe or partial file.
        if (formatted === null) return null;
        for (const l of formatted) outLines.push(l);
      }
    }

    outLines.push(closeFence);

    // With RAW metadata reproduce the exact trailing-newline shape: a file that
    // had NO body section after the closing fence gets no trailing EOL.
    const bodyStr = typeof body === 'string' ? body : '';
    if (meta && meta.hasBody === false) {
      return outLines.join(eol);
    }
    return outLines.join(eol) + eol + bodyStr;
  } catch (_) {
    return null;
  }
}

// Validate a proposed agent name against the naming rules and the set of names
// already in use. Returns { valid, error } — `error` is null when valid, else a
// human-readable reason. Rejects: non-string / empty, characters outside
// [a-z0-9-], the reserved FALLBACK_AGENT (`general-purpose`), and duplicates of an
// existing name. `existingNames` may be an array or a Set (anything else is
// treated as "none in use"). Accepts e.g. `orchestrate-docs`.
function validateAgentName(name, existingNames) {
  if (typeof name !== 'string') {
    return { valid: false, error: 'name must be a string' };
  }
  if (name === '') {
    return { valid: false, error: 'name must not be empty' };
  }
  if (!NAME_RE.test(name)) {
    return {
      valid: false,
      error: 'name may only contain lowercase letters, digits and hyphens'
    };
  }
  // Reject leading/trailing/all-hyphen slugs (`-`, `--`, `-foo`, `foo-`) — parity
  // with the renderer mirror validateAgentNameRenderer. Interior hyphens
  // (`orchestrate-docs`, `a-b-c`) stay valid. Runs after the NAME_RE char-class
  // check and before the reserved/duplicate checks (renderer ordering).
  if (/^-/.test(name) || /-$/.test(name) || /^-+$/.test(name)) {
    return { valid: false, error: 'name may not start or end with a hyphen' };
  }
  if (name === FALLBACK_AGENT) {
    return { valid: false, error: `"${FALLBACK_AGENT}" is a reserved agent name` };
  }
  let existing = [];
  if (Array.isArray(existingNames)) {
    existing = existingNames;
  } else if (existingNames instanceof Set) {
    existing = [...existingNames];
  }
  if (existing.includes(name)) {
    return { valid: false, error: `an agent named "${name}" already exists` };
  }
  return { valid: true, error: null };
}

module.exports = {
  parseAgentFile,
  serializeAgentFile,
  validateAgentName
};
