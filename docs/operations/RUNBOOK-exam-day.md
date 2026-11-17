# Runbook: exam day (teachers and exam coordinator)

Covers guide Runbooks A and D. Rule number one: **never edit student answers by hand and never touch the database.** Every recovery below
is a button in the system, needs a reason, and is written to the audit log.

## T-1 day
- [ ] Roster and enrollments verified (`GET /quizzes/:id/eligible-students`); a test student can start a dummy quiz.
- [ ] Quiz published, window and duration checked; access code (if any) written down: it is shown only once.
- [ ] Deployment freeze announced. Backups confirmed. Support contacts shared (D-15).
- [ ] No large imports planned for exam time (they wait automatically while an exam is running).

## T-30 minutes
- [ ] `/health` and `/ready` green; 2+ API instances healthy; the worker process (sweeper) running.
- [ ] Monitor page open (`GET /quizzes/:id/monitor`). Students may sign in now (pre-login window) to avoid a login storm at the start.

## During the exam
Watch **stalled** and **not started**. A stalled student usually has a flaky connection: the browser keeps their answers locally and syncs when it is back.

| What happened | What to do |
|---|---|
| Student refreshed, closed the tab, or the laptop died | Nothing. They sign in and press Start again: they are returned to their running attempt with their saved answers. |
| One student lost time to a technical problem | **Extend** with `scope: students` and a reason. They see the new deadline at their next save. |
| Whole room had a problem (power cut, network down) | **Extend** with `scope: all`, or **Pause** to stop NEW starts while running attempts continue. Resume afterwards. |
| Student submitted by mistake, or was auto-submitted by a failure | **Reopen** that attempt (minutes + reason). Their answers are kept. Not possible after results are published. |
| Server restarted or briefly down | Running attempts survive: answers acknowledged by the server are never lost. Students reconnect and continue. If many were cut off, **extend** all. |
| Fire alarm, security incident, exam must stop now | **Emergency close** (teacher or SUPER_ADMIN, reason mandatory): no new starts, every running attempt is submitted with its last saved answers. |
| A question is wrong or ambiguous | Do not change it now. After the exam use **regrade** (below). |
| Suspected unauthorized access or leaked paper | Stop. Tell the technical lead and the college privacy contact (Runbook C). Preserve the audit log. |

Never deploy code during an exam window. Log every interruption and every extend/reopen/pause with its reason (the system does this for you).

## After the exam
1. Wait for the deadline. Use **finalize expired attempts** (`POST /quizzes/:id/finalize-expired`) if anyone is still shown as running after their time.
2. Check the monitor: *in progress = 0* and *ungraded = 0*.
3. Reconcile: roster vs started vs submitted (the results table lists every enrolled student, including those who never started).
4. **Wrong answer key discovered** (Runbook B): do not edit the live question. Use **regrade** with the corrected key or "award everyone", a reason, and,
   if results are already published, the **name of the person who approved it**. The original grade is kept as history.
5. Publish results only when satisfied: choose what students may see (hidden / score only / score and answers).
6. Review the audit log for the exam (`GET /audit?targetId=<quizId>`).

## Who to call (fill in before the pilot)
- Incident lead: ____________  Technical lead: ____________  College privacy contact: ____________  Exam controller (approves corrections after publication): ____________
