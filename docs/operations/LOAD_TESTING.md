# Load testing (guide Phase 12)

**Goal:** replace the guide's *targets* with *measured* numbers. Until this has been run on staging and the report accepted, the capacity figures
(1,000+ concurrent exam takers, 20+ teachers) are a plan, not a fact. If a target cannot be met, the product owner approves a revised capacity in writing.

## Rules
- Run against **staging**, never production. Staging must mirror production: same instance sizes, **2+ API instances behind a load balancer**,
  a **dedicated paid MongoDB tier** (not shared/free), the same `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST`, the worker process running.
- Run k6 from a **separate machine** (a laptop on the same Wi-Fi as the server tests the Wi-Fi, not the server).
- Staging only: set `LOAD_TEST_MODE=true` (the server **refuses to start with it in production**). It lifts only the *per-IP* login/registration
  limits, because a load generator is one IP. Per-user limits (autosave, start, submit, 2FA, access codes) stay on, exactly as in production.
- API instances: `IMPORT_WORKER=off`, `SWEEPER=off`; run `npm run start:worker -w server` as its own process (import worker + deadline sweeper).
- On the API hosts consider `UV_THREADPOOL_SIZE=16`: Argon2 hashing runs on the libuv thread pool (default 4), which limits how many logins hash at once.

## The arithmetic (from the guide, to check against the results)
- Autosave: 1,000 students every 20 s = **about 50 writes/s**. Mass start: 1,000 starts in 60 s = **17/s** (in 10 s = **100/s**), each writing a snapshot.
- Login storm: 1,000 passwords hashed at the same moment is **CPU-bound**. The mitigation is the pre-login window (students sign in 10-15 min early).
- 99.9% availability in a 3-hour window allows **about 11 seconds** of downtime: a stretch target, not promised.

## Procedure
1. **Install k6** on the load machine (Windows: `winget install k6`).
2. **Seed** (from the repo root, with `server/.env` pointing at STAGING's database):
   `npm run load:seed -w server -- --yes` creates 1,500 students (`load.1` ... `load.1500`, one shared password), one teacher (`load.teacher`), 30 questions and an
   already-open exam; it writes `load/data/users.json` and `meta.json`. Options (env): `LOAD_USERS`, `LOAD_QUESTIONS`, `LOAD_WINDOW_START_MINUTES`,
   `LOAD_WINDOW_MINUTES`, `LOAD_DURATION_MINUTES`. The exam window starts immediately: **re-run the seed to reset it** before each run.
3. **Run a scenario** (always keep the console output: it carries the proof of what the server acknowledged):
   `k6 run -e BASE_URL=https://staging.example -e SCENARIOS=exam,monitor --console-output=load/results/acks.log load/k6/exam.js`
4. **Verify** after the exam deadline plus the grace period plus a minute: `npm run load:verify -w server -- --quiz <quizId> --acks ../load/results/acks.log`
   (exit code 0 = **no acknowledged answer was lost, nothing was stored wrongly, one attempt per student, everything graded once**).
5. **Clean up**: `npm run load:seed -w server -- --yes --clean`.

## Scenarios to run (guide Section 12): each separately, then combined, at 100 / 500 / 1,000 / 1,500 users (`-e USERS=...`)
| # | What | How |
|---|---|---|
| A | **Login storm** | `SCENARIOS=login_storm STORM_RATE=50` then 100, 200 (logins/second). Also the mitigation case: `SCENARIOS=exam LOGIN_SPREAD_SECONDS=600` |
| B | **Mass start** | `SCENARIOS=exam LOGIN_SPREAD_SECONDS=120 START_SPREAD_SECONDS=10` (everyone signed in, then everyone starts within 10 s) and `=60` |
| C | **Steady autosave** | `SCENARIOS=exam EXAM_SECONDS=1800` (a 30-minute exam; 20 s autosave with retries and late older requests mixed in) |
| D | **Mass submit + deadline** | B with `START_SPREAD_SECONDS=10` (all submit within seconds), and with `ABANDON_PERCENT=10` (10% close the laptop: the sweeper must finalize them) |
| E | **Teachers and results** | `SCENARIOS=exam,monitor MONITOR_VUS=20`; then publish the results (below) and run `SCENARIOS=results` |
| F | **Imports during an exam** | upload and confirm a 1,000-row import while scenario C runs: it must **stay queued** until the exam is over, then complete (functional check, not speed) |
| G | **Faults** (below) | scenario C with a fault injected; then verify |

Publishing the results between E's two runs (as the teacher; PowerShell/curl):
`login` (`POST /api/v1/auth/login` with headers `X-Requested-With: cognition-iq` and `Origin: <client origin>`) -> `POST /api/v1/quizzes/<id>/close` `{"reason":"load test"}` ->
`POST /api/v1/quizzes/<id>/results/visibility` `{"visibility":"score_only"}` -> `POST /api/v1/quizzes/<id>/results/publish`.

## Fault injection (scenario C running, then verify must PASS)
| Fault | Expect |
|---|---|
| Kill ONE API instance (`kill -9`) mid-exam | the load balancer routes around it; a few retries; **no lost acknowledged answer** |
| Restart all API instances one by one (graceful) | in-flight requests drain; clients continue |
| Stop the worker process (sweeper) | exam continues; abandoned attempts are finalized lazily or when it returns; the teacher's "finalize expired" works |
| Stop Redis | exam endpoints keep working (per-instance limiter), `/ready` reports "degraded" |
| MongoDB primary step-down (Atlas "Test Failover") | a short error burst, then recovery; **verify PASS** |
| Disconnect a subset of clients (kill some k6 VUs) | their attempts are finalized by the sweeper after the deadline |

## Pass criteria (guide Section 12)
| Metric | Target |
|---|---|
| p95 latency of start, autosave, submit, monitor, results | **< 500 ms** at the agreed load |
| Error rate | **< 0.1%** |
| `load:verify` | **PASS** (no loss of server-acknowledged answers) |
| Login p95 | measured; bound set to 2 s here. Tune `ARGON2_*` / instances / pre-login window from it |
| Results visible to the teacher after a submit | within **10 s** (grading is synchronous): check the results table right after the mass submit |
| Sweeper | abandoned attempts finalized within about a minute after deadline + grace |
| API and DB CPU | below about 70% sustained; memory flat (no leak); no connection-pool queueing; no errors in logs |

## What to collect and send back
`load/results/last-summary.json`; the `load:verify` JSON; for each instance and for MongoDB: CPU, memory, connections, operations/s, slow queries;
the number of 5xx/429 in the server logs; the exact configuration used (instance sizes and count, Mongo tier and region, `ARGON2_*`, `MONGODB_MAX_POOL_SIZE`, `UV_THREADPOOL_SIZE`).
Fill in `docs/operations/LOAD_REPORT_TEMPLATE.md`.

## If a target is missed (levers, in order of effort)
1. Lengthen the **pre-login window** and/or add **staggered entry** (division start slots).
2. Add API instances; raise `UV_THREADPOOL_SIZE`; lower `ARGON2_*` only as far as the security review allows (target 100-250 ms per hash).
3. Bigger MongoDB tier; check slow queries and indexes (`explain`); raise `MONGODB_MAX_POOL_SIZE` only if connections queue.
4. Revise the stated capacity and have the product owner approve it in writing (guide Section 12).
