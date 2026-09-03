---
id: TASK-208
title: QConnect is not replicating the client notes or contact status correctly
status: done
created: 2026-08-07T00:00:00.000Z
updated: 2026-08-20T04:46:08.317Z
jira-key: DEV-14449
jira-url: https://officehq.atlassian.net/browse/DEV-14449
jira-status: TODO
jira-priority: Highest
jira-type: Support
jira-parent: DEV-14213
jira-links: Relates to JS-230
imported-from: TASK-207
resolution: wont-do
---

## Description
Imported from Jira issue DEV-14449 ("[JS-230] - QConnect is not replicating the
client notes or contact status correctly"). Routed from JSM ticket
[JS-230](https://officehq.atlassian.net/browse/JS-230).

Reporter: Heeni Rongo
Priority: Highest
Who is affected: Many clients or receptionists (10+)
Severity Label: S5

### Issue description (verbatim from Jira)
When using Test Mode to review calls in QConnect, we enter the date and time
before accessing the call details. During these reviews, we have identified
several issues that result in the system not accurately reflecting the live call
environment:

a) If the selected time is in the AM, QConnect displays the greeting as
"Good afternoon..." rather than the correct salutation, "Good morning...".
(see screenshot 1)

b) When viewing the client notes, the information displayed does not accurately
reflect the notes that were available in the live system at the time the
receptionist handled the call. (see screenshot 2)

c) When selecting the appropriate contact, QConnect often displays the contact's
availability incorrectly. On multiple occasions, the availability shown in Test
Mode has been the complete opposite of what occurred in the live environment.
(see screenshot 3)

Please note the last 2 screenshots did not show the 'DOC ALL XFER' message when I
used Test mode the previous day. This was noted in the scorecard review so Tracy
could check PostHog.

### Notes for whoever picks this up
- The Jira description references three screenshots that were not imported with
  this ticket; view them on the original Jira issue if they are needed.
- The reported symptoms all point at Test Mode not honouring the selected
  as-at date/time when resolving greeting/salutation, client notes, and contact
  availability — that is the likely common root cause, but it has not been
  confirmed here.

## Acceptance Criteria
- [ ] NEEDS DEFINITION — this ticket was imported directly from Jira DEV-14449 and
      has not been analysed yet. A BA/coder must replace this placeholder with real,
      testable acceptance criteria plus Gherkin scenarios covering (a) the AM/PM
      salutation, (b) point-in-time client notes, and (c) point-in-time contact
      availability, including failure/edge cases.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
