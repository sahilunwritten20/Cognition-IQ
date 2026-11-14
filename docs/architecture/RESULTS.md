# Results, publication and regrade (Step 7)

## Who sees what
| | TEACHER (own quiz) | HOD (own department) | SUPER_ADMIN | STUDENT |
|---|---|---|---|---|
| Results table + CSV export | yes | read-only | read-only, **audited** | no |
| One attempt in detail (answers vs key) | yes | no | no | no |
| Publish / unpublish / visibility / regrade / finalize expired | yes | no | no | no |
| Released result | - | - | - | own result only, after publication |

Someone else's quiz, attempt or result is always **404** (existence is never revealed).

## The results table (roster reconciliation)
`GET /quizzes/:id/results` lists **every enrolled student** of the quiz's class+divisions with where they stand:
`not_started | in_progress | grading_pending | submitted | auto_submitted`, every attempt, the official result, percentage and
pass/fail (if `passMarks` is set). The summary (enrolled, not started, in progress, completed, average, highest, lowest, passed, failed)
covers the WHOLE class, not just the page. Pages are bounded (max 100).
**D-17 (PROPOSED): the official result is the BEST score among submitted/auto-submitted attempts, ties to the earliest.** Every attempt stays on record.

`GET /quizzes/:id/results/export`: CSV with a BOM (Excel opens Marathi/Hindi names correctly), escaped, **formula injection neutralized**
(cells starting `= + - @` get a leading `'`), at most 5,000 rows, scoped by role, times shown in `DISPLAY_TIMEZONE` (default Asia/Kolkata;
storage stays UTC). Every export is audited with the row count.

## Publishing (D-01)
`POST /quizzes/:id/results/publish` needs: the quiz is not a draft, it has **ended or been closed**, **no attempt is still in progress**
(use `POST /quizzes/:id/finalize-expired`, the teacher's recovery action), and every finished attempt is **graded against the latest
corrections**. Otherwise 409 with a clear code (`ATTEMPTS_IN_PROGRESS`, `GRADING_INCOMPLETE`).
`unpublish` needs a reason. `POST /quizzes/:id/results/visibility` changes what students may see; **after publication it needs a reason**.

## What a student receives
`GET /student/quizzes/:id/result` and `GET /student/results`:
- Not published, or visibility `hidden`: `409 RESULT_NOT_RELEASED` (no score hint). Not graded yet: `409 RESULT_NOT_READY`.
- `score_only`: score, total, percentage, pass/fail, and the score of each attempt.
- `score_and_answers`: additionally `review`, a per-question view of the student's **own official attempt**.
  **This is the only student response that contains `correctOptionId`**, deliberately, and only after release.
  Note for the guide's leak test (Section 6): it must exempt this one endpoint when the quiz is `score_and_answers` and published;
  every attempt endpoint and every unreleased/hidden/score_only response is still scanned strictly (see the tests).

## Audited regrade (Runbook B, D-03, D-05)
`POST /quizzes/:id/regrade` `{ reason, approvedBy?, changes: [ {action: "set_key", questionId, correctOptionId} | {action: "award_all", questionId} ] }`
- **Corrections live on the quiz** (`quiz.corrections`, append-only, numbered by `gradingRevision`) and are applied ON TOP of every attempt's own
  key. The attempt's stored key is never overwritten, so the original grade stays reproducible.
- Each affected attempt gets a **new grading revision** and its previous grade is pushed onto `grading.history`: the original and every
  corrected grade are kept. Attempts that never saw the question are untouched (only their revision marker advances).
- `set_key` only applies where the option exists in that attempt's snapshot; `award_all` gives everyone the marks of a faulty question
  (items are flagged `adjusted`). A later `set_key` cancels an earlier `award_all` on the same question.
- It also applies to attempts that are still running or start later: grading always includes the quiz's corrections.
- **After publication `approvedBy` is mandatory** (the person who approved it) and students see the corrected result.
- Safe to repeat: attempts are regraded conditionally on their own revision; `POST /quizzes/:id/regrade/resume` finishes an interrupted regrade,
  and publication waits until every attempt is on the latest revision. A grading that had failed is retried by the regrade.
- Audit: `results.regrade_requested` (reason, approver, published, the kinds of change, never the key), `results.regraded` (counts).

## Audit actions
`results.support_access`, `results.exported`, `results.attempts_finalized`, `results.published`, `results.unpublished`,
`results.visibility_changed`, `results.regrade_requested`, `results.regraded`, `results.regrade_resumed`.
Records never contain student names or ids, marks per student, answers or keys.

## Pass marks
`passMarks` is an optional per-quiz field (D-04), checked against the total at publish time; the pass mark itself passes.
