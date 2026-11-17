# D-02 Who grants extra time or reattempts, D-15 Delegated powers and exam-day escalation (PROPOSED, implemented)

- **D-02 (exam coordinator / HOD, needed before the exam engine)**: the **teacher of the quiz** may extend time and reopen an attempt on their own
  quiz, with a mandatory reason, always audited. **SUPER_ADMIN** may extend time or emergency-close in an emergency, also with a reason.
  Reopening is teacher-only. Extra *attempts* (a new attempt beyond `maxAttempts`) are not implemented: reopen the existing attempt instead.
- **D-15 (college sponsor, needed before the pilot)**: HOD is **read-only** (watches the monitor and results of their department).
  A teacher may pause, resume, extend, reopen and emergency-close their OWN quiz. SUPER_ADMIN may emergency-close and extend. Named support
  contacts per exam are listed in `docs/operations/RUNBOOK-exam-day.md`.
- **Limits built in**: 120 minutes per extension, 240 minutes in total per attempt, reopen refused after results are published.
- **Status**: defaults implemented, not signed.
- **Review trigger**: the college wants HOD to act, or wants a second approver for reopen/extend.
