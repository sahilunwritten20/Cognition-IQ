# D-17 Which attempt is the student's official result (PROPOSED, implemented)

- **Context**: A quiz may allow several attempts (`maxAttempts` 1-5). The guide does not say which one counts.
- **Options**: (a) best score; (b) first attempt; (c) last attempt; (d) average.
- **Decision (proposed default, implemented)**: **(a) best score** among submitted / auto-submitted attempts that are graded; ties go to the earliest
  attempt. Every attempt stays on record and is listed in the results table and the student's result.
- **Approver / date**: Exam committee, needed with D-04 (guide Week 8) / _not yet signed_
- **Impact**: `pickCounted` in `results.rules.ts` (one function), the results table, CSV, the student result. Changing the rule changes one function.
- **Review trigger**: the college wants "last attempt counts" or an average.
