'use strict';

// Pure command framework for the Slack <-> Claude thread proxy (TASK-056).
//
// The proxy (lib/slack-proxy.js) normally forwards every user reply in the
// session anchor thread to Claude verbatim. Some phrases typed into that thread
// (e.g. "show me the tasks") should instead be answered by the app itself. This
// module is the Electron-free DECISION CORE for that command system: it defines
// the registry shape, normalizes inbound message text, matches a normalized
// message against a registry, and lists the available commands. It performs no
// I/O, no DOM access and no network — exactly like lib/slack-proxy.js — so it is
// fully unit-testable with `node --test`.
//
// Registry shape (extensible, data-only): each entry is
//   { name, description, patterns }
// where `patterns` is an array of trigger phrases. Handlers do NOT live here —
// they are wired in the renderer (TASK-057) keyed by the entry `name`. Real
// command entries land in TASK-058/059/060, so DEFAULT_COMMANDS ships EMPTY and
// every function accepts an injectable `registry` for tests.
//
// Public API:
//   normalizeCommandInput(text)  — safe lowercase/trim/collapse/strip-punct
//   matchCommand(text, registry) — first exact-phrase match → { name, command }
//   listCommands(registry)       — [{ name, description }] in registry order
//   formatTasksSummary(tickets)  — mrkdwn summary of the tasks board (TASK-058)
//   formatHelp(registry)         — mrkdwn list of every registered command (TASK-059)
//   parseCreateTicketReply(text) — parse a create-ticket prompt reply (TASK-072)
//   DEFAULT_COMMANDS             — the built-in registry

const {
  ACTIVE_STATUSES, FAILED_STATUS,
  laneStatusesFor, laneForStatusFor,
} = require('./ticket-lanes');

// The built-in command registry. The `tasks` command (TASK-058) answers "show me
// the tasks" (and aliases) in-thread with the live board; the `help` command
// (TASK-059) lists every registered command. Handlers live in the renderer keyed
// by `name`.
const DEFAULT_COMMANDS = [
  {
    name: 'tasks',
    description: 'Show the tasks board and what is being worked on',
    patterns: ['show me the tasks', 'show tasks', 'list tasks', 'tasks', 'what are you working on'],
  },
  {
    name: 'help',
    description: 'List the commands this thread understands',
    patterns: ['help', 'commands', 'show commands', 'what can you do'],
  },
  {
    name: 'status',
    description: 'Show session status: folder, Claude activity, queue and active tickets',
    patterns: ['status', 'show status', "what's your status", 'are you busy'],
  },
  {
    name: 'create-ticket',
    description: 'Create a new ticket on the tasks board',
    patterns: ['create ticket', 'create a ticket', 'new ticket', 'add ticket'],
  },
];

// Normalize a raw Slack message into the canonical form used for matching:
// lowercase, trimmed, internal whitespace runs collapsed to single spaces, and
// trailing punctuation (. ! ? …) stripped. Never throws: anything that is not a
// string (null, undefined, number, object, …) returns ''.
function normalizeCommandInput(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
}

// Match a message against a registry. `text` is normalized, then the FIRST entry
// (registry order) whose `patterns` (each normalized) contains that string wins.
// Matching is WHOLE-PHRASE after normalization — never substring/fuzzy — so
// ordinary conversation ("please fix the tasks page") does not match, and
// "show me the tasks now" does not match a "show me the tasks" pattern.
//
// Return shape: { name, command } where `name` is the matched entry's name and
// `command` is the entry object itself, so callers get both the key and the full
// entry. Returns null when there is no match. Never throws for null/empty/junk
// text or a malformed registry entry — entries missing a `patterns` array (or
// whose patterns are non-strings) are skipped.
function matchCommand(text, registry = DEFAULT_COMMANDS) {
  const normalized = normalizeCommandInput(text);
  if (!normalized) return null;
  if (!Array.isArray(registry)) return null;
  for (const entry of registry) {
    if (!entry || !Array.isArray(entry.patterns)) continue;
    for (const pattern of entry.patterns) {
      if (typeof pattern !== 'string') continue;
      if (normalizeCommandInput(pattern) === normalized) {
        return { name: entry.name, command: entry };
      }
    }
  }
  return null;
}

// List the commands in a registry as [{ name, description }] in registry order.
// Defaults to DEFAULT_COMMANDS. Returns [] for a null/empty/non-array registry
// and never throws; malformed entries are skipped.
function listCommands(registry = DEFAULT_COMMANDS) {
  if (!Array.isArray(registry)) return [];
  const out = [];
  for (const entry of registry) {
    if (!entry) continue;
    out.push({ name: entry.name, description: entry.description });
  }
  return out;
}

// Format the tasks board into a single Slack mrkdwn string (TASK-058, made
// config-aware in TASK-104). Inputs:
//   tickets  — an array of ticket wrappers `{ fm }` (as produced by the board
//              poll) OR bare frontmatter objects; both are tolerated and
//              frontmatter is authoritative.
//   columns  — OPTIONAL normalised team-config columns (each
//              `{ status, label, ..., system }`, as produced by
//              lib/team-config.js normalizeConfig). Omitted / null / junk yields
//              exactly the six fixed system lanes, so the no-config output is
//              byte-identical to the historic fixed-lane summary.
// The summary has three parts:
//   *Currently working on:*  — one line per ACTIVE ticket (status in
//       ACTIVE_STATUSES) as "TASK-0NN — <title> (<status>)", or the sentinel
//       "Nothing is being worked on right now." when none are active. Active
//       status is SYSTEM-ONLY (defining/in-progress/testing) — user columns
//       never inflate it.
//   *Failed testing:*        — same line shape, only shown when at least one
//       failed-testing ticket exists.
//   lane counts              — configured board order (laneStatusesFor: the six
//       system lanes plus any user columns in the position they hold), folding
//       failed-testing into `testing` (via laneForStatusFor) and counting any
//       out-of-enum / unconfigured status under a trailing "unknown N" (only
//       when non-empty). The count-piece label stays the raw SLUG for system
//       lanes (regression: no-config == historic format) and uses the configured
//       LABEL for user columns.
// Never throws: an empty/null/non-array `tickets` returns "The tasks board is
// empty."; tickets missing id/title render "(no id)"/"(untitled)" placeholders.
function formatTasksSummary(tickets, columns) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return 'The tasks board is empty.';
  }

  const fms = tickets.map((t) => (t && t.fm ? t.fm : t) || {});
  const idOf = (fm) => (fm.id != null && String(fm.id).trim() !== '' ? String(fm.id).trim() : '(no id)');
  const titleOf = (fm) => (fm.title != null && String(fm.title).trim() !== '' ? String(fm.title).trim() : '(untitled)');
  const lineOf = (fm) => `${idOf(fm)} — ${titleOf(fm)} (${fm.status})`;

  const active = fms.filter((fm) => ACTIVE_STATUSES.includes(fm.status));
  const failed = fms.filter((fm) => fm.status === FAILED_STATUS);

  // Config-aware lane order + labels. laneStatusesFor gives the board lane slugs
  // in configured order (== LANE_STATUSES with no config); the label map keeps
  // the raw slug for SYSTEM lanes (byte-identical no-config output) and the
  // configured label for USER columns.
  const laneOrder = laneStatusesFor(columns);
  const labelBySlug = new Map();
  if (Array.isArray(columns)) {
    for (const col of columns) {
      if (!col || typeof col !== 'object' || Array.isArray(col)) continue;
      const slug = typeof col.status === 'string' ? col.status.trim() : '';
      if (slug === '' || labelBySlug.has(slug)) continue;
      const label = col.system === true
        ? slug
        : (typeof col.label === 'string' && col.label.trim() !== '' ? col.label : slug);
      labelBySlug.set(slug, label);
    }
  }
  const pieceLabel = (slug) => (labelBySlug.has(slug) ? labelBySlug.get(slug) : slug);

  // Lane counts: seed every configured lane at 0, fold failed-testing into
  // testing and route out-of-enum / unconfigured statuses to "unknown" via
  // laneForStatusFor.
  const counts = new Map(laneOrder.map((s) => [s, 0]));
  let unknown = 0;
  for (const fm of fms) {
    const lane = laneForStatusFor(fm.status, columns);
    if (counts.has(lane)) counts.set(lane, counts.get(lane) + 1);
    else unknown += 1;
  }

  const parts = ['*Currently working on:*'];
  if (active.length) {
    for (const fm of active) parts.push(lineOf(fm));
  } else {
    parts.push('Nothing is being worked on right now.');
  }

  if (failed.length) {
    parts.push('', '*Failed testing:*');
    for (const fm of failed) parts.push(lineOf(fm));
  }

  const countPieces = laneOrder.map((s) => `${pieceLabel(s)} ${counts.get(s)}`);
  if (unknown > 0) countPieces.push(`unknown ${unknown}`);
  parts.push('', countPieces.join(' · '));

  return parts.join('\n');
}

// Format the command registry into a single Slack mrkdwn help string (TASK-059).
// Iterates the SAME registry the matcher uses, so help can never drift from the
// commands that actually work. One line per command, in registry order:
//   *<name>* — <description> (say: "<pattern1>", "<pattern2>", …)
// Entries with a missing/empty description render "(no description)"; entries
// with no usable (non-empty string) patterns omit the "(say: …)" suffix. An
// empty/null/non-array registry (or one with no renderable entries) returns
// "No commands are available." Never throws; malformed entries are skipped.
function formatHelp(registry = DEFAULT_COMMANDS) {
  if (!Array.isArray(registry) || registry.length === 0) {
    return 'No commands are available.';
  }
  const lines = [];
  for (const entry of registry) {
    if (!entry) continue;
    const name = entry.name != null && String(entry.name).trim() !== '' ? String(entry.name).trim() : '(unnamed)';
    const description = entry.description != null && String(entry.description).trim() !== '' ? String(entry.description).trim() : '(no description)';
    let line = `*${name}* — ${description}`;
    const patterns = Array.isArray(entry.patterns)
      ? entry.patterns.filter((p) => typeof p === 'string' && p.trim() !== '')
      : [];
    if (patterns.length) {
      line += ` (say: ${patterns.map((p) => `"${p}"`).join(', ')})`;
    }
    lines.push(line);
  }
  if (lines.length === 0) return 'No commands are available.';
  return lines.join('\n');
}

// Format a one-shot session snapshot into a single Slack mrkdwn string
// (TASK-060). Pure formatting: the renderer handler gathers the live `info`
// object and this function shapes it into text. Input is
//   { folder, claudeState, transport, queued, activeTickets }
// and every field is optional — a missing/partial/non-object `info` renders
// placeholders and NEVER throws. Field mapping:
//   folder        → the string, or "(no folder open)" when falsy
//   claudeState   → "busy" when exactly 'busy', otherwise "idle"
//   transport     → "Socket Mode" for 'socket', "polling" for 'poll', else "none"
//   queued        → "Queued: N" (0 when not a finite number)
//   activeTickets → "Active tickets: N", or "Active tickets: unknown" when the
//                   count is null/undefined (board unreadable / no folder open)
function formatStatusReply(info) {
  const i = info && typeof info === 'object' ? info : {};
  const folder = i.folder ? String(i.folder) : '(no folder open)';
  const claude = i.claudeState === 'busy' ? 'busy' : 'idle';
  const transport = i.transport === 'socket' ? 'Socket Mode' : i.transport === 'poll' ? 'polling' : 'none';
  const queued = typeof i.queued === 'number' && Number.isFinite(i.queued) ? i.queued : 0;
  const activeTickets = i.activeTickets == null ? 'unknown' : i.activeTickets;
  return [
    '*Session status*',
    `Folder: ${folder}`,
    `Claude: ${claude}`,
    `Transport: ${transport}`,
    `Queued: ${queued}`,
    `Active tickets: ${activeTickets}`,
  ].join('\n');
}

// Parse a two-step "create ticket" reply into a ticket draft (TASK-072). The
// user is prompted for `title: <your title>, description: <your description>`
// and this turns that free-text reply into { ok: true, title, description } or
// { ok: false, error }. It NEVER throws: non-string / null / junk input returns
// { ok: false }. Parsing rules (locked in):
//   • The labels `title:` and `description:` are case-insensitive and may appear
//     in EITHER order.
//   • A label only starts a field when it sits at the very start of the reply or
//     immediately after a comma and/or newline (with optional surrounding
//     whitespace). A `title:`/`description:` sitting mid-sentence is literal text.
//   • FIRST-LABEL-WINS: a `title:` value that itself contains the word
//     `description:` keeps it (that inner label is not a field boundary because
//     it is not preceded by a comma/newline) — only a comma/newline-preceded
//     `description:` closes the title. Ditto per field: the first boundary
//     occurrence of a label wins.
//   • A field's value runs from its label up to the next field boundary (or end
//     of the reply), so the description may itself contain commas and newlines.
//   • `title` is REQUIRED and must be non-empty after trimming; a missing/empty
//     `description` falls back to the New-ticket-modal default 'What needs doing
//     and why.' (never re-prompt for a missing description).
function parseCreateTicketReply(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Expected a text reply.' };
  const re = /(^|[,\n])\s*(title|description)\s*:/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ field: m[2].toLowerCase(), boundary: m.index, valueStart: m.index + m[0].length });
  }
  const fields = {};
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].boundary : text.length;
    const value = text.slice(matches[i].valueStart, end).trim();
    if (!(matches[i].field in fields)) fields[matches[i].field] = value;
  }
  const title = (fields.title || '').trim();
  if (!title) return { ok: false, error: 'Missing title.' };
  const description = (fields.description || '').trim() || 'What needs doing and why.';
  return { ok: true, title, description };
}

module.exports = { DEFAULT_COMMANDS, normalizeCommandInput, matchCommand, listCommands, formatTasksSummary, formatHelp, formatStatusReply, parseCreateTicketReply };
