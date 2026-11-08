# ADR-003: Background import jobs, credential handling

Status: PROPOSED (needs technical-lead review). Deviates from guide T-04 for imports only.

## Decision: MongoDB-backed job runner instead of BullMQ (for imports)
Hashing 1,000 passwords cannot run inside one HTTP request. Instead of adding BullMQ now, import jobs live
in MongoDB (`importjobs`, `importrows`) and an in-process worker claims them:
- **Atomic claim with a lease** (`findOneAndUpdate`): two API instances never process the same job.
  An expired lease means the previous runner died; the job is resumed. After 5 attempts it is marked `failed`.
- **Restart-safe**: state is in the database, not in Redis memory. Works when Redis is down (T-05).
- **Idempotent rows**: the user id and encrypted temporary password are allocated and persisted *before*
  the account is created, so a crash or retry can never create a second account or lose the password.
  Rows already `done` are never touched again.
- BullMQ stays the plan for the deadline sweeper and exports (Step 7+), where Redis scheduling helps.
- Trade-off: the worker shares the API process, so hashing competes with exam traffic for CPU.
  **Run large imports outside exam windows.** Move the worker to its own process before the pilot if needed
  (it only needs the same environment variables; start it without the HTTP server).

## Flow
upload (`text/csv`, <= 2 MB, <= 5,000 rows) -> validate/preview (touches nothing) -> confirm -> background
processing -> one-time credential download -> (optional) retry failed rows.

## Credentials
- Temporary passwords are random 12-character strings, **AES-256-GCM encrypted at rest** with a sub-key
  derived from `TWO_FACTOR_ENCRYPTION_KEY` (label `import-credentials-v1`).
- Downloadable **once**, by SUPER_ADMIN, via `POST` (never a cacheable GET); the claim is atomic, so two
  simultaneous downloads cannot both succeed. After download, or after 24 h, they are wiped.
  A lost file means resetting individual passwords (`reset-password`). Students must change it at first login.
- CSV output neutralizes formula injection (cells starting `= + - @ TAB CR` get a leading `'`).

## Privacy (D-06)
- Only six columns are accepted; **any other column rejects the file** (no DOB, phone, address by accident).
- Import rows keep names and login IDs for audit/support. **Retention for `importrows` is undecided**:
  add a purge (for example 90 days after completion) once the college sets the retention rule.

## Known gaps
- Cancelling a running job is not supported (queued or validated only).
- A row whose user was created but whose enrollment failed keeps the account; the retry completes the enrollment.
- No per-row audit entries (job-level audit only: validated, confirmed, completed, retried, cancelled, exported).

## Addendum (Step 3c): operating the risks
- **Separate worker process.** `npm run start:worker -w server` (built: `node dist/worker.js`) runs only the
  background worker. Set `IMPORT_WORKER=off` on API instances so exam traffic and hashing never share a CPU.
  Workers and API instances may all run at once safely (atomic claim + lease). The worker needs no Redis.
  Hook: `ImportWorker` takes a `shouldPause()` function; the exam engine (Steps 6-7) will pass
  "is any exam window open?" so queued jobs wait instead of competing with students.
- **Bulk password reissue** (`POST /imports/credentials/reissue`) replaces the "lost credentials file" scenario:
  select students by `importJobId`, `classId`, `divisionId` or a list of `loginIds` (exactly one), with a mandatory
  `reason`. It uses the same preview -> confirm -> worker -> one-time download path (it is a job of type
  `credential_reissue`). Applying it sets a new temporary password, forces a change at next login, bumps
  `tokenVersion` (old access tokens die immediately) and revokes all refresh sessions.
  Do not run it during an exam: affected students would be signed out.
- **Retention (D-06).** Jobs and rows carry `purgeAt`, indexed with a MongoDB TTL index (`expireAfterSeconds: 0`).
  The date is `IMPORT_RETENTION_DAYS` (default 30) after a job finishes, fails or is cancelled (or after
  creation, for a preview nobody confirmed). It is cleared while a job is queued or running, so nothing expires
  mid-processing. MongoDB's TTL monitor runs about once a minute. Audit entries hold counts only, so they remain.
