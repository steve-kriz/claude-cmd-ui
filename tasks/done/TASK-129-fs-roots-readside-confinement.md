---
id: TASK-129
title: Extend fs-roots confinement to read-side + installSkill + prompts IPC handlers
status: done
created: 2026-07-21T03:47:47.275Z
updated: 2026-07-21T05:42:55.701Z
review-of: TASK-126
---

## Description
Review follow-up from TASK-126: that ticket confined the four mutating/probing fs IPC handlers (fs:writeFile/rename/mkdir/exists) to approved project roots via lib/fs-roots.js isPathAllowed, but the SAME trust-boundary gap remains open in the read-side and other-write handlers, which still hand ANY absolute renderer path to fs.promises with no containment check:
- main.js fs:readFile (~638-661), fs:readDir (~615-627), fs:findByExt (~482), fs:grep (~530) — arbitrary READ of any file (e.g. C:\Users\<u>\.ssh\id_rsa, .env, credential stores).
- main.js tasks:installSkill (~727-734, direct fsp.mkdir/fsp.writeFile to projectPath) and prompts:append/write/clear/syncFromCloud (~790-838, write to a cwd-relative history) — residual arbitrary-WRITE paths that bypass the new guard entirely.
Fix: reuse the existing lib/fs-roots.js isPathAllowed guard in each of these handlers (readFile/readDir/findByExt/grep gate the path; installSkill gates projectPath; prompts:* gate the cwd/target), returning each channel's existing failure shape (never throwing). Note fs:findByExt/fs:grep/prompts operate on a directory/root — gate that base path. Keep all legitimate in-root reads/installs/prompt writes working (the opened folder is already a registered root; the prompts history dir and skill install target are under the opened folder).

Severity: **high** (security; from the TASK-126 review, mirror of the TASK-035 finding).

## Impact If Not Fixed
A single renderer-side path-gate bypass (or a future un-gated caller) remains an arbitrary-file-READ primitive for credential/secret exfiltration, plus a residual arbitrary-WRITE path via installSkill/prompts — the exact OS-boundary threat TASK-126 was raised to eliminate, left half-open.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
