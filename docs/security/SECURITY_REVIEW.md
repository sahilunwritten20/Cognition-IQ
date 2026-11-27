# Security review (guide Phase 11)

Status of each control: **TESTED** = an automated test fails if it breaks; **PROCESS** = enforced by CI or configuration;
**OPEN** = needs a person, a provider or the web app, and is NOT done. "Plan, not proof": nothing here is a promise until the
evidence exists and a human reviewer has signed it.

## Verified by automated tests
| Control (guide Section 7) | Evidence |
|---|---|
| Deny by default: **every route** needs a token. The route table is read from the real app, so a new unprotected route fails the build | `security.test.ts` "every non-public route answers 401" |
| Role fences across ALL routes: students only `/student`+`/auth`; HOD read-only; teachers cannot use admin/import/audit/student or change the structure; SUPER_ADMIN cannot take exams or run teacher actions | `security.test.ts` role sweeps, plus a per-module allow/deny matrix |
| Authentication (Argon2id, rotating refresh tokens with reuse detection, 2FA with replay protection, forced password change, lockout) | `auth.test.ts`, `unit.test.ts`, `e2e.test.ts` steps 1-3, 10 |
| CSRF on cookie endpoints; CORS never reflects another origin or uses a wildcard | `auth.test.ts`, `security.test.ts` |
| IDOR: another person's record answers 404 (existence not revealed) | per-module tests (questions, quizzes, attempts, results, monitor) |
| Answer keys never reach students (default queries, DTO allow-lists, error responses); released review is the only exception | `questions.test.ts`, `attempts.test.ts` leak scan, `results.test.ts`, `e2e.test.ts` step 12 |
| NoSQL operator injection / mass assignment: strict schemas reject objects and unknown fields everywhere | every module's validation table |
| CSV formula injection neutralized in all exports | `csv.test.ts`, `results.test.ts`, `import.test.ts` |
| Errors reveal no stack, message or path; oversized and malformed bodies refused | `security.test.ts` |
| Logs never hold passwords, tokens, cookies, hashes or keys (direct and real request logging) | `security.test.ts` |
| Rate limits: login, registration, 2FA, access codes, per-user exam endpoints (not per IP, because of shared college NAT) | `auth.test.ts`, `security.test.ts`, `attempts.test.ts` |
| Audit log is append-only (no write API) and contains no secrets | `monitor.test.ts`, `e2e.test.ts` step 11 |
| Protective headers (Helmet), `no-store` on API responses | `security.test.ts` |
| The whole flow works with real logins across all roles | `e2e.test.ts` |

## Enforced by CI / configuration
- `npm audit --omit=dev --audit-level=high` on every pull request and every Monday (`.github/workflows/security.yml`).
- Secret scanning with gitleaks on every push.
- Dependabot weekly updates (`.github/dependabot.yml`).
- Environment validation at startup: short or identical secrets, non-HTTPS origin and insecure cookies are refused outside development.
- Lint, type-check, tests and build block merges (`.github/workflows/ci.yml`).

## OPEN: needs a person, a provider, or the web app
1. **Independent penetration test** of the deployed staging system (the automated tests are not a substitute).
2. **D-06 privacy review** (India DPDP Act 2023, including students under 18) signed by a qualified adviser BEFORE any real student data.
3. **Hosting hardening**: TLS configuration, HSTS at the edge, a WAF / DDoS protection, MongoDB network isolation and a least-privilege
   application role (insert/read-only on `auditlogs` where the tier allows it, otherwise record the limitation in the risk register).
4. **Secrets**: a secret manager in staging/production, rotation procedure, `TWO_FACTOR_ENCRYPTION_KEY` backed up (losing it makes every
   enrolled 2FA secret and every unexported import password unusable). Nothing from this repository's `.env.example` is used in production.
5. **Backups**: encrypted, restore drill with recorded RTO/RPO (Phase 12).
6. **Web app review (Phase 11, once the client exists)**: render question text as plain text only (never HTML), no answer keys in client state,
   CSP for the client origin, dependency review of the front end, Playwright end-to-end tests, accessibility checks.
7. **Monitoring and alerting** for SEV-1/SEV-2 conditions (failed grading, sweeper not running, error rate, Redis/Mongo health).
8. **Operations**: two SUPER_ADMIN accounts, the recovery runbook rehearsed, named incident contacts, deployment freeze during exams.
9. **Load and recovery testing** (Phase 12): the k6 scripts, verifier and restore check exist (`docs/operations/LOAD_TESTING.md`, `BACKUP_RESTORE.md`); **the measured results are still OPEN**: run them on staging and fill in the report.

## Known accepted risks (recorded, not hidden)
- Any SUPER_ADMIN can reset another SUPER_ADMIN's credentials (needed for recovery); mitigated by mandatory reasons and audit.
- Audit writes are best-effort (logged on failure) and not yet in transactions.
- Cookies are `SameSite=Strict`: the client and API must share a registrable domain (or one origin).
- Imports hash passwords inside the API or worker process: run big imports outside exam windows (they wait automatically).
- Access codes are 8 characters (about 40 bits): protected by per-student rate limiting and keyed hashing, not by entropy alone.
