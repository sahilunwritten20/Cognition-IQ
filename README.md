# Cognition IQ

Secure college-wide quiz and exam platform. See the Master Execution Guide v2.0 for the plan.
Status: **Step 5 - quiz builder** (no exam taking yet).

## Prerequisites
Node 20+, Docker (for local MongoDB + Redis). The first `npm test` downloads a MongoDB binary
(needs internet once) for the in-memory test database.

## Run locally
```bash
npm install
docker compose up -d
cp server/.env.example server/.env     # then fill in every value (see comments in the file)
npm run dev:server                     # http://localhost:4000/ready
npm run dev:client                     # http://localhost:5173
```

## Create the first SUPER_ADMIN
Add to `server/.env` (temporarily): `SEED_ADMIN_LOGIN_ID`, `SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD`
(12+ chars), then:
```bash
npm run seed:admin -w server
```
Remove the `SEED_*` lines afterwards. First login forces a password change and 2FA enrolment.

Keep **two** SUPER_ADMIN accounts (create the second from the admin API). Lost authenticator or
password? See `docs/operations/RUNBOOK-admin-recovery.md`.

## Hosting layout
Serve the client and API from the same site (for example `app.college.edu` and `api.college.edu`) or one
origin; cookies are `SameSite=Strict`. Outside development use https and `COOKIE_SECURE=true`.

## Importing students
1. Download the template, fill it (only these columns are accepted: `loginId,name,rollNo,departmentCode,classCode,divisionName`).
2. Upload it, review the preview and any row errors, then confirm (`skipInvalid=true` imports just the valid rows).
3. Download the temporary passwords **once** (they are wiped after download or 24 h), hand them out in person.
Run big imports outside exam windows: in production set `IMPORT_WORKER=off` on the API and run the worker as its own
process (`npm run start:worker -w server`). Lost a passwords file? Use bulk reissue. Rows auto-delete after
`IMPORT_RETENTION_DAYS`. Details: `docs/architecture/ADR-003-import-jobs.md`, `docs/operations/RUNBOOK-imports.md`.

## Checks (same as CI)
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## API so far (`/api/v1`)
| Area | Endpoints |
|---|---|
| Auth (public) | `POST /auth/register`, `/auth/login`, `/auth/2fa/verify`, `/auth/refresh`, `/auth/logout` |
| Auth (bearer) | `GET /auth/me`, `POST /auth/change-password`, `/auth/2fa/setup`, `/auth/2fa/enable` |
| Admin (SUPER_ADMIN) | `GET/POST /admin/users`, `POST /admin/users/:id/{approve,reject,deactivate,activate,reset-password,reset-2fa}` |

| Academics reads (SUPER_ADMIN; HOD = own department only) | `GET /academics/{departments,years,classes,divisions,subjects,enrollments,teaching-assignments}` |
| Academics writes (SUPER_ADMIN) | `POST /academics/{departments,years,classes,divisions,subjects,enrollments,teaching-assignments}`, `PATCH .../:id`, `POST .../:id/archive`, `POST /academics/years/:id/set-current`, `POST /academics/teaching-assignments/:id/revoke`, `PATCH /academics/staff/:id/department` |
| Teacher | `GET /academics/teaching-assignments/mine` |

| Student import (SUPER_ADMIN) | `GET /imports/students/template`, `POST /imports/students` (raw `text/csv` body, optional `?academicYearId=`), `GET /imports`, `GET /imports/:id`, `GET /imports/:id/rows`, `POST /imports/:id/{confirm,retry,cancel}`, `POST /imports/:id/credentials/export` (one-time), `POST /imports/credentials/reissue` (fresh passwords for a set of students) |

| Question bank (TEACHER; SUPER_ADMIN read-only, audited) | `GET/POST /questions`, `GET /questions/my-subjects`, `GET/PATCH /questions/:id`, `POST /questions/:id/{archive,restore}` |

| Quizzes (TEACHER own; HOD and SUPER_ADMIN read-only) | `GET/POST /quizzes`, `GET/PATCH /quizzes/:id`, `GET /quizzes/:id/eligible-students`, `POST /quizzes/:id/{publish,unpublish,pause,resume,close,code/regenerate}` |
| Student | `GET /student/quizzes` (eligible quizzes with availability and reasons) |

Cookie-based endpoints need the header `X-Requested-With: cognition-iq` (CSRF defence).
Errors use `{ error: { code, message, requestId, details? } }`.

## Rules
- Branch + pull request only; CI must be green. Never commit secrets.
- Record decisions in `docs/decisions/` and architecture in `docs/architecture/`.
