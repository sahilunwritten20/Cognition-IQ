# D-13 Question bank policy (PROPOSED, option (a) selected)

- **ID / title**: D-13 / Question approval and visibility in the question bank
- **Context**: The guide proposes "no approval in R1, teacher-owned; review workflow in R2". The code also has to decide who can
  read colleagues' questions (which include answer keys) and who may edit them.
- **Options**: (a) private banks, each teacher sees only their own; (b) shared bank per subject, author-only editing;
  (c) shared bank with anyone editing.
- **Decision**: **(a) private bank**, selected by the project lead on 2026-11-08. No approval step in R1. A teacher sees and
  changes only their own questions, and only in subjects they are currently assigned to. SUPER_ADMIN has audited read-only support
  access; HOD has none.
- **Approver / date**: Exam committee / _not yet signed_ (the default becomes binding only when the named approver signs it)
- **Impact**: question list/get/edit scope (a `createdBy` filter on every teacher query), quiz builder (a teacher can add only their
  own questions to a quiz), no cross-teacher reuse until R2 adds copy/share. A colleague's answer keys are never exposed.
- **Review trigger**: teachers of one subject want to build common exams from a shared pool (move to (b)), or the college wants a
  review/approval workflow (R2).
