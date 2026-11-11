# ADR-004: Deadline sweeper with a database lease (instead of BullMQ)

Status: PROPOSED. Same reasoning as ADR-003, applied to guide T-04's "expired-attempt sweeper".

- **Need**: finalize attempts of students who closed the laptop, every ~30 s, run once across all instances, safe to run twice.
- **Decision**: `AttemptSweeper` runs on an interval and takes a named lease in MongoDB (`joblocks`, unique `_id`; the held lease makes the
  upsert fail with a duplicate key). No Redis is involved, which also satisfies T-05 (exam endpoints and the deadline keep working when Redis is down).
- **Why this is enough**: the work is idempotent by construction (`finalize` is one conditional update; grading only touches `pending`
  attempts), so even two sweepers running at once is harmless; the lease only avoids wasted work. A test runs two at the same moment.
- **Where it runs**: `SWEEPER=inline` inside the API (default) or `SWEEPER=off` with `npm run start:worker` (runs the sweeper and the import worker).
- **Safety nets**: lazy finalization on every request, and `AttemptService.finalizeExpired({ quizId })` for the teacher's
  "finalize expired attempts" action in the live monitor.
- **Revisit** if exports/notifications (R3) need delayed or retried jobs; BullMQ would then be justified.

Also in this step: background imports now **wait while any exam is running or open** (`AttemptService.examWindowOpen`, wired as the import
worker's `shouldPause`), closing the CPU-contention risk from ADR-003.
