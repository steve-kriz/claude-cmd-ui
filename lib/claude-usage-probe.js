'use strict';

// Off-screen `/usage` probe (the usage bar's data source).
//
// `/usage` is an interactive-only Claude Code panel: the CLI has no
// non-interactive equivalent (`claude --help` lists no `usage` command) and the
// percentages are not written to disk anywhere under `~/.claude`. So to know how
// much of the weekly limit is gone, the app spawns a SHORT-LIVED, OFF-SCREEN
// `claude`, types `/usage`, scrapes the rendered frame, and kills it. Nothing is
// typed into the user's visible pane — their scrollback and their session are
// left completely alone, which is why this runs in its own throwaway pty.
//
// This module is the EFFECT half (it owns a real pty); lib/claude-usage.js is the
// pure parse/pace half. Every dependency is injectable so the whole state machine
// is exercised under `node --test` against a FAKE pty — no real terminal, no
// `claude` process, no clock. It never throws: every failure path resolves to a
// `{ ok: false, reason }` view so the bar can degrade to "—" with a reason in its
// tooltip instead of taking down the caller.

const { spawnShell } = require('./pty');
const { buildUsageView } = require('./claude-usage');

// CSI / OSC / generic ESC-X sequences, matching lib/pty.js's own ANSI_REGEX. The
// scrape strips these before parsing (see lib/claude-usage.js for why the result
// is whitespace-collapsed and therefore matched tolerantly).
const ANSI_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

// Claude Code has finished booting and is accepting input. Any one of these
// markers is enough — the composer hint, the shortcut footer, or the prompt caret.
const READY_RE = /Try "|for shortcuts|❯/;

// The scraped frame holds the figure we came for. Used to finish EARLY: the
// moment the weekly row has rendered there is nothing left to wait for.
const FRAME_READY_RE = /Current\s*week\s*\(\s*all\s*models\s*\)[\s\S]{0,80}?\d{1,3}(?:\.\d+)?\s*%\s*used/i;

// The folder-trust gate. If it appears the probe cwd is not trusted, and the
// probe ABORTS rather than answering it: auto-confirming a trust prompt on the
// user's behalf is a security decision that is not this feature's to make.
const TRUST_PROMPT_RE = /Is\s*this\s*a\s*project\s*you\s*(?:created|trust)/i;

const DEFAULTS = {
  // Boot is normally ~2s; allow generously for a cold start, then fall through to
  // typing anyway (prompt detection can be masked by a themed shell, exactly as
  // lib/pty.js's autolaunch fallback handles).
  readyTimeoutMs: 15000,
  // Whole-probe ceiling. Past this the pty is killed and the reason reported.
  timeoutMs: 45000,
  // Settle delay after readiness before typing, then between text and Enter, so
  // the slash-command menu has rendered and highlighted `/usage`.
  typeDelayMs: 400,
  submitDelayMs: 1000,
  // The panel repaints as it loads (a partial paint can hold a stale/absent
  // figure), so once the weekly row appears we wait briefly and take the LAST
  // paint rather than the first.
  settleMs: 1200,
  // A tall grid keeps the whole panel on screen; the pty is never displayed.
  cols: 120,
  rows: 40,
};

// Drive one probe to completion. Resolves a lib/claude-usage view object —
// never rejects.
//
// deps: { spawn, now, setTimeout, clearTimeout } — all injectable for tests.
function probeUsage(opts = {}, deps = {}) {
  const o = { ...DEFAULTS, ...opts };
  const spawn = deps.spawn || spawnShell;
  const now = deps.now || (() => new Date());
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;

  return new Promise((resolve) => {
    let proc = null;
    let buf = '';
    let phase = 'booting';
    let settled = false;
    const timers = [];

    const later = (fn, ms) => { const t = setT(fn, ms); timers.push(t); return t; };

    const cleanup = () => {
      for (const t of timers) { try { clearT(t); } catch (_) {} }
      timers.length = 0;
      if (proc) {
        try { proc.kill(); } catch (_) { /* already gone / unsupported */ }
        proc = null;
      }
    };

    // Single exit point. `text` is the scraped frame; an empty/garbled frame still
    // produces a view (ok:false + reason) via the pure model.
    const finish = (text) => {
      if (settled) return;
      settled = true;
      cleanup();
      let view;
      try {
        view = buildUsageView(text, now());
      } catch (e) {
        // The pure model is documented never to throw; belt-and-braces so a probe
        // can never propagate an exception to the IPC layer.
        view = { ok: false, reason: 'unparsed', percent: null, pacePercent: null, state: 'unknown', label: '—', title: 'Weekly usage unavailable.' };
      }
      view.checkedAt = now().toISOString();
      resolve(view);
    };

    const write = (s) => { try { if (proc) proc.write(s); } catch (_) {} };

    try {
      proc = spawn({
        shell: 'cmd',
        cwd: o.cwd,
        cols: o.cols,
        rows: o.rows,
        // Reuse lib/pty.js's tested autolaunch (prompt detection + fixed-delay
        // fallback) rather than re-implementing shell-prompt sniffing here.
        cliCommand: 'claude',
      });
    } catch (e) {
      finish('');
      return;
    }

    if (!proc || typeof proc.onData !== 'function') {
      finish('');
      return;
    }

    // Type `/usage` and submit it, once.
    const askForUsage = () => {
      if (phase !== 'booting') return;
      phase = 'asking';
      later(() => write('/usage'), o.typeDelayMs);
      later(() => {
        write('\r');
        phase = 'reading';
      }, o.typeDelayMs + o.submitDelayMs);
    };

    proc.onData((data) => {
      if (settled) return;
      buf += typeof data === 'string' ? data : String(data || '');
      // Bounded: the panel is a screenful, but a boot log can be long. Keep the
      // tail — the settled paint is always the most recent output.
      if (buf.length > 200000) buf = buf.slice(-200000);
      const clean = buf.replace(ANSI_REGEX, '');

      // An untrusted folder blocks before anything else can happen: abort with a
      // specific reason rather than sitting through the whole timeout.
      if (TRUST_PROMPT_RE.test(clean)) { finish(clean); return; }

      if (phase === 'booting' && READY_RE.test(clean)) { askForUsage(); return; }

      // Finish as soon as the weekly row lands (plus a short settle for repaints).
      if (phase === 'reading' && FRAME_READY_RE.test(clean)) {
        phase = 'settling';
        later(() => finish(buf.replace(ANSI_REGEX, '')), o.settleMs);
      }
    });

    if (typeof proc.onExit === 'function') {
      proc.onExit(() => {
        // `claude` died (missing CLI, crash, killed). Parse whatever arrived —
        // `unavailableReason` recognises "not recognized"/"command not found".
        if (!settled) finish(buf.replace(ANSI_REGEX, ''));
      });
    }

    // Readiness never detected → type anyway (mirrors autolaunch's fallback).
    later(askForUsage, o.readyTimeoutMs);
    // Whole-probe ceiling.
    later(() => finish(buf.replace(ANSI_REGEX, '')), o.timeoutMs);
  });
}

module.exports = {
  probeUsage,
  __testing: { ANSI_REGEX, READY_RE, FRAME_READY_RE, TRUST_PROMPT_RE, DEFAULTS },
};
