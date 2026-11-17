# Live monitor and recovery tools (Step 8)

Goal (guide Phase 10): a teacher can watch a live exam and recover from interruptions **without anyone editing the database**.
Every control needs a **reason** and is **audited**.

## Who can do what
| | TEACHER (own quiz) | HOD (own dept) | SUPER_ADMIN | STUDENT |
|---|---|---|---|---|
| Watch the live monitor | yes | read-only | read-only | no |
| Pause / resume (blocks NEW starts only) | yes | no | no | no |
| Extend time | yes | no | **emergency** | no |
| Reopen a finished attempt | yes | no | no | no |
| Emergency close | yes | no | **emergency** | no |
| Finalize expired attempts | yes | no | no | no |
| Audit log viewer | no (D-18) | no (D-18) | yes, read-only | no |

Someone else's quiz or attempt is always **404**.

## The monitor: `GET /quizzes/:id/monitor`
Everyone who should sit the quiz (enrolled in a target class+division) with where they are:
`not_started | in_progress | submitted | auto_submitted`, plus **stalled**. Per running attempt: time remaining (server clock), last accepted save,
number of saves, extra minutes granted. Counts: eligible, not started, in progress, stalled, submitted, auto-submitted, **ungraded**
(finished but not graded yet: publication waits for these). Rows are ordered problems-first: stalled, running, not started, finished.
- **Built for polling**: it never loads answers or snapshots. The response carries `serverNow`, `lastUpdated` and `pollAfterSeconds` (10):
  the page asks again after that long, not continuously. `?view=summary` returns only the counts (the cheapest call). `?status=`
  filters (`stalled` is a pseudo-status); pages are bounded (max 100).
- **Stalled** = still has time, but the server accepted no save for longer than `MONITOR_STALL_SECONDS` (default 90, about four missed
  autosaves). It is a hint (the student may be reading), never an automatic action. The activity time is the server's, recorded on every accepted save.
- Polls are not audited (they show progress, not marks or answers).

## Extend time: `POST /quizzes/:id/extend`
`{ scope: "all" | "students" | "attempts", studentIds? | attemptIds?, minutes: 1-120, reason }`
- New deadline = old deadline + minutes. **Before and after are recorded on each attempt** (`extensions`), with who and why.
- The attempt's deadline **may exceed the quiz window** (guide Section 8); new starts are still refused after the window.
- Students see the new deadline at their **next save or sync** (`endsAt` is in every autosave and resume response).
- Only running attempts that still have time are extended: an attempt already past its deadline + grace is **not revived** (use reopen).
- The total added to one attempt is capped at **240 minutes**. Two simultaneous requests cannot lose an extension (conditional update).
- Per-student accommodations (D-08) are done with `scope: "students"`.

## Reopen: `POST /quizzes/:id/attempts/:attemptId/reopen`  `{ minutes: 1-120, reason }`
For an accidental submit or a student auto-submitted by a network failure. The attempt returns to `in_progress` with deadline **now + minutes**.
- Answers are kept; saves continue from the same sequence; it does **not** use up another attempt.
- The **previous grade is kept** in `grading.history`; grading resets to `pending` and is redone as a **new revision** when the attempt ends again.
- Refused when: the attempt is not submitted/auto-submitted, the student already has an attempt running (the one-active-attempt index
  guarantees it), or **results are published** (unpublish first).
- While reopened it is not part of the official results and publication waits.

## Emergency close: `POST /quizzes/:id/emergency-close`  `{ reason }`
Closes the quiz (no new starts) and finalizes **every running attempt as `auto_submitted` with its last acknowledged answers**, graded as usual.
Idempotent: a second call finds nothing left. A start that was in flight when it ran is caught by repeating until none is running.

## Audit log viewer: `GET /audit` (SUPER_ADMIN)
Filters: `action`, `actionPrefix` (anchored and escaped, never a pattern), `actorId`, `targetType`, `targetId`, `from`, `to`; newest first; bounded pages.
Each entry shows who (name, login, role), what, on what, when, request id and IP. The log is **append-only**: the application has no API that
changes or deletes an entry. Records never hold passwords, tokens, answers, keys, or marks per student.
**D-18 (PROPOSED)**: HOD and teacher views of their own area are not enabled until the college approves them.

## Audit actions added
`quizzes.time_extended`, `attempts.reopened`, `quizzes.emergency_closed` (each with reason, role and counts).
