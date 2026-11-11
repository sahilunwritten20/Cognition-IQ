# D-11 Late-entry rule and D-12 Network grace window (PROPOSED defaults, implemented)

- **D-11 (exam coordinator, needed by guide Phase 7)**: a student who starts late is NOT given the full duration:
  `endsAt = min(startedAt + durationMinutes, quiz window end)`, on the server clock, unless extended by an audited action (monitor step).
- **D-12 (exam coordinator, needed by guide Phase 8)**: the server accepts autosaves and submits up to `endsAt + 15 seconds` (server clock);
  later requests are rejected and the server auto-submits with the last acknowledged answers. Configurable: `EXAM_GRACE_SECONDS` (0-120).
- **Status**: neither is signed. The defaults are what the code does today.
- **Impact**: start endpoint, autosave/submit, sweeper, the student countdown copy ("late entry shortens your time"), reliability tests.
- **Review trigger**: complaints about lost answers near the deadline (raise the grace), or about late starters (revisit D-11).
