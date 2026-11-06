# Cognition IQ

Secure college-wide quiz and exam platform. See the Master Execution Guide v2.0 for the plan.
Status: **Step 1 - foundation** (no exam features yet).

## Prerequisites
Node 20+, Docker (for local MongoDB + Redis).

## Run locally
```bash
npm install
docker compose up -d
cp server/.env.example server/.env   # then replace the secrets
npm run dev:server    # http://localhost:4000/health
npm run dev:client    # http://localhost:5173
```

## Checks (same as CI)
```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Rules
- Branch + pull request only; CI must be green.
- Never commit secrets. Staging/production secrets come from a secret manager.
- Record decisions in `docs/decisions/`.
