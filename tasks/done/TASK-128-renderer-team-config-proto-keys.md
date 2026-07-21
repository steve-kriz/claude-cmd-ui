---
id: TASK-128
title: Renderer team-config unknown-key loops fire the __proto__ setter (mirror of TASK-116/097)
status: done
created: 2026-07-21T03:06:44.049Z
updated: 2026-07-21T05:45:57.241Z
review-of: TASK-116
---

## Description
Review follow-up from TASK-116: the renderer mirror of the team-config round-trip has the same prototype-key hazard the lib just fixed, in THREE loops that do plain `obj[k]=src[k]` for unknown top-level keys pulled from a config read off disk via JSON.parse, with no unsafe-key skip:
- renderer.js ~5432-5437 `tasksSerializeTeamConfig` (`out[k]=w.extra[k]`)
- renderer.js ~5532-5535 `refreshTeamBoard` (`extra[k]=raw[k]`, reads the parsed on-disk config directly)
- renderer.js ~6976-6979 `buildWorkingConfigFromRaw` (`extra[k]=obj[k]`)
An own `__proto__`/`constructor`/`prototype` key from a tampered tasks/team-config.json reaches these loops: `extra['__proto__']=value` fires the setter, reassigning the working-model object's prototype (object value) or silently swallowing the key (primitive) — the exact defect fixed in lib/team-config.js by TASK-116. Fix: mirror the lib guard — skip `__proto__`/`constructor`/`prototype` (or copy via null-prototype/defineProperty) in all three renderer loops, and keep renderer/normalizeTasksColumns in sync. Instance-only (does not touch global Object.prototype), requires a malformed/tampered config → severity minor.

Severity: **minor** (security-hardening, renderer mirror of TASK-116).

## Impact If Not Fixed
A tampered team-config.json can hand the column-manager working model an object with an unexpected prototype (inheriting attacker-controlled properties) and silently discard a legitimately-persisted top-level field whose name collides with a reserved key; the renderer authoring/serialize path then operates on and can re-persist a subtly corrupted model, and the renderer stays out of lockstep with the hardened lib.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
