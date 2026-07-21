---
id: TASK-127
title: Make add-agent create atomic (exclusive-create) instead of exists-then-write TOCTOU
status: done
created: 2026-07-21T02:15:52.733Z
updated: 2026-07-21T05:27:45.683Z
review-of: TASK-035
---

## Description
Security post-processing finding. openAddAgentModal.onCreate checks fs.exists(targetPath) (renderer.js ~7961) then calls writeWithMirror -> fs:writeFile, which does a plain fsp.writeFile with no wx/O_EXCL (main.js ~655). Between the check and the write another process could create .claude/agents/<name>.md and it would be silently overwritten. (fs:rename at main.js ~667 IS guarded; only fs:writeFile is not.) Fix: add an exclusive-create option (flag "wx") to fs:writeFile and use it on create-new-file paths so the no-overwrite guarantee is enforced atomically by the OS.

Severity: **low** (from the TASK-035 security post-processing pass).

## Impact If Not Fixed
A rare race (or a concurrent skill install) between the existence check and the write can silently overwrite an existing/bundled agent definition, so the ticket’s "abort, no overwrite" guarantee is not race-safe.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
