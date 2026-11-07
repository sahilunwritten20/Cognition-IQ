# Cognition IQ

Secure college-wide quiz and exam platform. See the Master Execution Guide v2.0 for the plan.
Status: **Step 2 - authentication & authorization** (no exam features yet).

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

Cookie-based endpoints need the header `X-Requested-With: cognition-iq` (CSRF defence).
Errors use `{ error: { code, message, requestId, details? } }`.

## Rules
- Branch + pull request only; CI must be green. Never commit secrets.
- Record decisions in `docs/decisions/` and architecture in `docs/architecture/`.
