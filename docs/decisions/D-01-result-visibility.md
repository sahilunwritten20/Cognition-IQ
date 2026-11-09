# D-01 Result visibility and who may change it (PROPOSED)

- **Context**: Students must never see unpublished marks, answers or keys. The guide proposes a safe default.
- **Decision (proposed default, implemented)**: every quiz starts with `resultVisibility = hidden`. The teacher chooses `hidden`,
  `score_only` or `score_and_answers` per quiz while it is a draft. Nothing reaches a student until `quiz.resultsPublishedAt` is
  set by an explicit teacher action (Step 9). Changes after publication need a reason and are audited.
- **Approver / date**: Product owner / exam coordinator, needed by quiz sign-off (guide Week 6) / _not yet signed_
- **Impact**: quiz model and builder (now), result endpoints and DTOs (Step 9). A visibility value can never expose more than
  the teacher chose.
- **Review trigger**: the college wants automatic release (for example right after the window closes).
