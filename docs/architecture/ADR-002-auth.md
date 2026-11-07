# ADR-002: Tokens, sessions, CSRF and 2FA

Status: PROPOSED (needs technical-lead review before the pilot). Implements guide T-07 and Phase 4.

## Decisions
- **Access token**: JWT (HS256, algorithm pinned on verify), 15 min, held in client memory only.
  Claims are minimal: `sub`, `cid` (college), `tv` (token version). Role/status are **always read
  from the database** on each request, so deactivation and role changes take effect immediately.
- **Refresh token**: opaque 384-bit random value in an `HttpOnly; SameSite=Strict; Path=/api/v1/auth`
  cookie (`Secure` outside development). Only its SHA-256 is stored. It is **rotated on every use**.
  Rotation is an atomic claim (`findOneAndUpdate`), so exactly one request wins.
- **Reuse detection**: presenting an already-rotated token revokes the whole family. A 10-second
  grace window returns `409 REFRESH_IN_PROGRESS` instead, so two tabs racing is not treated as theft.
- **Revocation**: password change/reset and deactivation bump `user.tokenVersion` (kills outstanding
  access tokens) and revoke all refresh sessions. Logout revokes the family; the current access
  token lives until it expires (max 15 min).
- **CSRF**: cookie-involving endpoints require `X-Requested-With: cognition-iq`, and the `Origin`
  header (if present) must equal `CLIENT_ORIGIN`; CORS allows only that origin. Bearer-only
  endpoints are not CSRF-exposed.
- **2FA**: TOTP (RFC 6238, SHA-1, 6 digits). Secrets are AES-256-GCM encrypted at rest with
  `TWO_FACTOR_ENCRYPTION_KEY`. Login returns a 5-minute challenge token that works only at
  `/auth/2fa/verify`. Codes cannot be replayed (`lastUsedStep`, claimed atomically).
  Mandatory for SUPER_ADMIN (`ROLES_REQUIRING_2FA`): without it, every endpoint except the
  setup/password/me ones returns `403 ACTION_REQUIRED`.
- **Anti-enumeration**: one generic login error for unknown / wrong password / pending / inactive;
  dummy hash on unknown users; registration returns the same `202` for duplicates.
- **Throttling**: per account (10 failures / 15 min), generous per IP (300 / 15 min, shared NAT),
  2FA (5 failures / 10 min). Redis-backed with per-instance memory fallback (T-05).

## Decisions adopted from the Step 2 review
- **Recovery (two-admin model)**: a SUPER_ADMIN can create another SUPER_ADMIN and reset any other
  user's password or authenticator (never their own). Mandatory reason for 2FA resets; all audited.
  Break-glass script for the case where no admin can sign in: see
  `docs/operations/RUNBOOK-admin-recovery.md`. Startup warns when fewer than 2 active admins exist.
- **Hosting layout**: client and API must share a registrable domain (for example `app.college.edu` and
  `api.college.edu`) or be served from one origin, because the refresh cookie is `SameSite=Strict`.
  Outside development `CLIENT_ORIGIN` must be `https://` and `COOKIE_SECURE` must be `true`
  (enforced at startup). If D-09 forces unrelated domains, revisit this ADR before building.
- **Pending students**: every login failure returns the same message, which now says a recent
  registration may still be awaiting approval. It reveals nothing about which accounts exist.
- **HOD 2FA**: mandatory now (`ROLES_REQUIRING_2FA` = SUPER_ADMIN, HOD).

## Known gaps (tracked, not hidden)
- Any SUPER_ADMIN can take over another SUPER_ADMIN's account via reset (needed for recovery). Mitigated
  by audit; consider alerting and a two-person rule later.
- Audit writes are best-effort (logged on failure); move into transactions with multi-document flows.
- Failed-login events are not yet written to the audit log (only logged by the request logger).
- No recovery codes (a user-held backup for 2FA); the runbook covers recovery instead.
