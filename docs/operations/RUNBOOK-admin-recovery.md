# Runbook: SUPER_ADMIN lost authenticator or password

**Prevention (do before the pilot):** keep at least **two** active SUPER_ADMIN accounts, held by two
different trusted people. The API logs a warning at startup when fewer than two exist.

## Path 1 - normal (another SUPER_ADMIN is available)
1. The helping admin signs in (password + authenticator).
2. Confirm the locked-out person's identity out-of-band (in person or a known phone number).
3. Authenticator lost: `POST /api/v1/admin/users/:id/reset-2fa` with a `reason`.
   Password also lost: additionally `POST /api/v1/admin/users/:id/reset-password`
   and hand over the temporary password in person.
4. The locked-out admin signs in, sets a new password if prompted, and enrols a new authenticator
   (they cannot use any other endpoint until they do).
5. Both actions are written to the audit log (`admin.2fa_reset`, `admin.password_reset`).

## Path 2 - break-glass (no admin can sign in)
Requires access to the server environment and database credentials, so only the technical lead or
IT owner should do this.
1. Set in the server environment: `RECOVER_LOGIN_ID` (and optionally `RECOVER_NEW_PASSWORD`, 12+ chars).
2. Run: `npm run recover:admin -w server -- --yes`
3. Remove the `RECOVER_*` variables immediately.
4. The admin signs in (new password if you set one), enrols 2FA again. An `ops.admin_recovery`
   audit record is written, including the operator name.
5. Tell the college sponsor that a break-glass recovery was performed and why.

## After any recovery
- Review the audit log for activity by that account since it was last known to be safe.
- If compromise is suspected, follow Runbook C (guide Section 13) and rotate secrets.
- Create a second SUPER_ADMIN if one does not exist.

## Risks accepted (document in the risk register)
- Any SUPER_ADMIN can reset another SUPER_ADMIN's credentials. This is required for Path 1 and is
  mitigated by mandatory reasons and audit records; consider alerting on `admin.2fa_reset` later.
- Path 2 bypasses 2FA by design; protect database credentials and the server environment.
