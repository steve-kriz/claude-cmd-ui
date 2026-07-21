---
id: TASK-125
title: TASK-107 review: augmentDarwinPath prepend/comment fix + execute-the-handler install test
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T05:14:02.987Z
review-of: TASK-107
---

## Description
Review follow-ups for TASK-107 (mac/unix): (F1) augmentDarwinPath APPENDS /usr/local/bin and /opt/homebrew/bin but its comment says "Prepend"; for a tool in both a system dir and Homebrew (notably git via Xcode CLT) the app then resolves the system copy while the user's terminal resolves Homebrew — fix the comment and consider prepending to match terminal precedence. (F2) install-helper platform wiring is verified only by source-text regex, not by executing the click handlers with a mocked platform — add tests that run the handlers and assert the correct command/hidden button per platform.

Severity from review: **minor**. This is a review follow-up of TASK-107.

## Impact If Not Fixed
On macOS the app may invoke a different (older, Apple-shipped) git than the user runs in their shell, causing subtle version-dependent differences; and a regression swapping which install button runs which command could ship undetected, presenting a non-functional install action to mac users.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
