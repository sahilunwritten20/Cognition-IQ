# Question bank (Step 4)

R1 scope: **MCQ** (2-6 options, exactly one correct) and **True/False**. Descriptive and coding questions are R2.

## Data and integrity
- `questions`: `collegeId`, `departmentId` (derived from the subject), `subjectId`, `topic`, `type`, `text`, `options[{optionId,text}]`,
  `correctOptionId`, `marks`, `difficulty`, `status` (`active`/`archived`), `createdBy`, `revision`.
- **Answer key protection, in layers**
  1. `correctOptionId` is `select:false`: no default query returns it; code must ask for it explicitly (`+correctOptionId`).
  2. Teacher responses are built by `toAuthoringDto` (includes the key); students never use it.
  3. Students receive only `toStudentQuestionDto`, an explicit allow-list
     `{questionId, type, text, options[{optionId,text}], marks, sequence}`. A unit test proves extra fields never pass through.
  4. Audit records never contain question text, options or the key (only `keyChanged: true`).
  5. Responses are `Cache-Control: no-store`.
- **Option ids are server-assigned and stable across edits** (`o_` + 10 hex). Edits keep the id of surviving options, which is what
  attempt snapshots and audited regrades (Runbook B) rely on. Clients cannot choose ids on create.
- `marks`: > 0, <= 100, at most 2 decimals (D-04). Text: Unicode allowed (Marathi/Hindi), control characters rejected,
  plain text only: **clients must render question text as text, never as HTML**.
- `revision` + required `revision` in every edit = optimistic concurrency: a stale edit gets 409, it is never merged.
- Nothing is deleted: questions are archived/restored. Editing an archived question requires restoring it first.

## Who can do what (PROPOSED, D-13)
| Role | Access |
|---|---|
| TEACHER | **Private bank**: sees, creates, edits and archives **only their own** questions, and only in subjects they are **currently assigned** to. A colleague teaching the same subject cannot see them or their answer keys. Losing the assignment removes access immediately. |
| SUPER_ADMIN | Read-only support access; **every read is audited** (`questions.support_access`). Cannot write. |
| HOD, STUDENT | No access (guide Section 2). |

Someone else's question, a question outside your subjects, and a question that does not exist all return **404** (existence is never revealed); creating in an unassigned or non-existent subject returns **403** for both.
Sharing between colleagues (copying a question into another teacher's bank) is an R2 feature, not part of R1.

## Audit actions
`questions.created`, `questions.updated` (fields changed, `keyChanged`), `questions.key_changed`, `questions.archived`,
`questions.restored`, `questions.support_access`.

## Next
Step 5 (quiz builder) references questions by id and computes `totalMarks` on the server; Step 7-8 copy the question into the
attempt snapshot at start, so later edits never change a running or finished attempt.
