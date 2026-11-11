# Exam engine (Step 6)

The **server owns every exam rule**: eligibility, attempt limits, deadlines, which answers are accepted, grading. The browser only
displays. Every mutation is ONE conditional atomic update, so double clicks, retries, two tabs, out-of-order requests and duplicate
sweeper runs all converge on a single result.

## Endpoints (STUDENT only; `Authorization: Bearer`, JSON)
| Call | Result |
|---|---|
| `POST /student/quizzes/:id/start` `{ accessCode? }` | **201** new attempt, or **200** the running one (`resumed: true`). Returns `attempt`, `quiz`, `questions` (StudentQuestionDTO), `answers`, `serverNow` |
| `GET /student/attempts/:id` | Resume after refresh/reconnect. In progress: same payload as start. Finished: `{ attempt, serverNow }` only |
| `PUT /student/attempts/:id/answers` `{ seq, answers:[{questionId, selectedOptionId \| null}] }` | `{ ok, lastSeq, stale, serverNow, endsAt }` |
| `POST /student/attempts/:id/submit` `{ seq?, answers? }` | `{ attempt, serverNow, lateRejected }` |

Error codes the client must handle: `QUIZ_UNAVAILABLE` (409, `details.reason`: not_started / ended / paused / closed / no_attempts_left),
`ACCESS_CODE_REQUIRED` / `INVALID_ACCESS_CODE` (403), `ATTEMPT_FINISHED` and `TIME_UP` (409: show the "submitted" screen),
`RATE_LIMITED` (429: back off and retry the same payload), 404 (not yours / does not exist).

## Start (atomic, race-safe)
Checks, in this order: quiz exists and is not a draft - student is enrolled in a target class+division of the quiz's year (else 404) -
**running attempt? return it** (pause/close block NEW starts only) - availability window `[startAt, endAt)`, status and attempt limit
(`evaluateAvailability`) - access code if required (constant-time, 10 wrong guesses per student per quiz per 15 min, then 429; the code is
checked only after every other rule passed, so it can never bypass one) - then the snapshot and insert.
`endsAt = min(startedAt + duration, window end)` on the server clock (D-11). Client time is never used.
Integrity is enforced by MongoDB unique indexes, not application checks (T-06): a partial unique index allows only ONE in-progress
attempt per student per quiz, and `(quizId, studentId, attemptNo)` is unique. A duplicate-key error is handled as "return the existing
attempt". Attempt numbers are `max(existing) + 1`; voided (`invalidated`) attempts do not use up an attempt.

## Snapshot (ADR-001)
The questions are copied into the attempt at start with the marks of that quiz; the answer key is stored apart in `answerKey`
(`select:false`, never in a default query). Editing or archiving a question or changing a key afterwards changes nothing for running or
finished attempts; only an audited regrade can (next step). Students who start later get the then-current content.

## Autosave: cumulative and sequence-guarded
Every request carries **all answers changed since the last server-acknowledged save** plus a strictly increasing `seq`. The server applies
it with one conditional update: owner, `in_progress`, `now <= endsAt + grace`, stored `lastSeq < seq`. A stale or repeated request
returns **200 with `stale: true`** and changes nothing; because requests are cumulative, a dropped or reordered older request loses nothing.
Invalid answers (unknown question, option of another question) reject the whole request with 400 and apply nothing.

**Client contract (for the React exam screen):** keep unacknowledged changes in IndexedDB; autosave about every 20 s; never show "saved"
until a 200 arrives; on failure resend the same cumulative payload; after a refresh, resume with `GET /student/attempts/:id`, continue
numbering from `max(local seq, attempt.lastSeq) + 1`, and resend only local changes made after the last acknowledgement. The countdown
is display-only: sync it to `serverNow` and `attempt.endsAt` on every response.

## Deadline and submit
- **Grace (D-12, PROPOSED 15 s, `EXAM_GRACE_SECONDS`)**: saves/submits are accepted up to exactly `endsAt + grace`. A later request is
  refused and the attempt is **auto-submitted with the last acknowledged answers** (`TIME_UP`, or `lateRejected: true` on submit).
- **Submit** is one conditional flip `in_progress -> submitted`; a repeat returns the same final state and never re-grades.
  It may carry the final cumulative answers, applied just before the flip.
- **Lazy finalization**: any request touching an attempt past `endsAt + grace` finalizes it as `auto_submitted`.
- **Sweeper** (every 30 s, bounded batches): finalizes attempts of students who left, using the same idempotent function, and grades any
  closed-but-ungraded attempt (a crash between the two steps). See ADR-004.

## Grading (T-03, D-04 PROPOSED)
Objective grading runs inside finalization, from the attempt's own snapshot: correct = the quiz's marks for that question, otherwise 0;
no negative marking, no grace marks, total rounded half-up to 2 decimals. `grading` = `{ status, score, totalMarks, revision, items }`
and stays on the server: **students receive no score** from these endpoints until results are published (next step).
`grading.status`: `pending -> done` (or `failed`, logged, retried by regrade).

## Not in this step
Teacher results, publishing, CSV export, regrade (next step); live monitor, extend/reopen/emergency close (after that);
per-student shuffle (R2).
