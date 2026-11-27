# Backup and restore (guide Phase 12, Runbook)

A backup that has never been restored is a hope, not a backup. **Restore drills are part of the go-live gate.**

## What must be backed up
| Item | How |
|---|---|
| MongoDB (everything that matters: users, structure, questions, quizzes, attempts, audit log, import jobs) | Managed automated backups, **continuous / point-in-time recovery** where the tier allows; otherwise scheduled snapshots at least every 15 minutes during exam windows |
| Secrets and configuration (`ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, **`TWO_FACTOR_ENCRYPTION_KEY`**, database credentials, `COLLEGE_ID`) | The secret manager's own backup. **Losing `TWO_FACTOR_ENCRYPTION_KEY` makes every enrolled authenticator and every not-yet-downloaded import password unusable.** Store a sealed copy with the sponsor |
| Redis | **Nothing**: it holds only rate-limit counters. A lost Redis loses no data |
| Code | Git |

**Goals to validate (PROPOSED):** RPO (maximum data loss) **15 minutes**, RTO (time to restore) **60 minutes**. Record the measured values.

## Drill procedure
1. Pick a quiet time. Note the **incident time** T0 (the moment you pretend the data was lost) and the **restore start** time.
2. **Restore into a NEW, separate database or cluster, never over production.**
   - Atlas: *Restore* a snapshot or a point in time to a new cluster.
   - Self-managed: `mongodump --uri="<prod-readonly-uri>" --gzip --archive=backup.gz` then
     `mongorestore --uri="<scratch-uri>" --gzip --archive=backup.gz --drop`.
3. Note the **restore finished** time.
4. Point `MONGODB_URI` at the restored copy and run the read-only integrity check:
   `npm run restore:check -w server -- --incident 2026-11-20T10:30:00Z --restore-started 2026-11-20T11:00:00Z --restore-finished 2026-11-20T11:35:00Z --report ../docs/operations/restore-drills`
   It reports record counts, the **required indexes** (one in-progress attempt per student, unique login IDs...), orphaned records, attempts without an answer key, ungraded or stuck attempts, an active SUPER_ADMIN,
   and the measured **RPO** (newest restored record vs the incident) and **RTO**. Exit code 1 means a check failed.
5. Start the application against the restored copy (it rebuilds any missing index), log in as SUPER_ADMIN, and walk through: a quiz, a result, the audit log.
6. Fill in `docs/operations/restore-drills/TEMPLATE.md` (copy it), have the technical lead sign it, archive it with the go-live evidence.

## If a real restore happens
- Stop deployments and announce the incident (Runbook A). Restore into a new database, run `restore:check`, switch `MONGODB_URI`.
- After a point-in-time restore during or just after an exam, students' last saves may be missing: use the monitor to see who is running, **extend** or **reopen** where needed, and tell the exam coordinator which window of data was lost.
- The deadline sweeper and grading resume by themselves: attempts left running are finalized, ungraded ones graded.
- Sessions issued before the incident may still work (tokens are not stored with the data); if compromise is suspected, rotate the token secrets (all users sign in again).
