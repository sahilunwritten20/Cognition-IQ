# D-18 Who may read the audit log (PROPOSED)

- **Context**: The guide's role table says audit logs are visible to SUPER_ADMIN, to HOD for their own department "if approved", and to teachers for
  their own actions "if approved".
- **Decision (proposed default, implemented)**: SUPER_ADMIN only (`GET /audit`, read-only, append-only log). HOD and teacher views are NOT enabled.
- **Approver**: College sponsor / privacy adviser (with D-06). **Status**: not signed.
- **Impact**: one route and a scoped filter if the college approves a HOD (department) or teacher (own actions) view; no data-model change.
