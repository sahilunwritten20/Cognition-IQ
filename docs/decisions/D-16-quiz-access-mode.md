# D-16 Meaning of `accessMode` = scheduled | code | both (OPEN - please confirm)

- **Context**: The guide's data model lists `accessMode (scheduled, code, both)` but does not say how the three differ, while also
  stating that a code is only an ADDITIONAL condition and never bypasses the schedule.
- **Implemented (interim)**: the schedule window always applies. `scheduled` = no code needed. `code` and `both` = the
  student must also enter the access code. The two code modes currently behave identically.
- **Options**: (a) keep as implemented and drop `both` later; (b) `code` = teacher releases the quiz by sharing the code within the
  window, `both` = auto-start at the window AND code; (c) something else the exam coordinator needs.
- **Decision**: none yet. **Owner**: exam coordinator. **Needed by**: before the exam engine (Step 7).
- **Impact**: the start endpoint's checks and the student instructions screen only; stored data does not change.
