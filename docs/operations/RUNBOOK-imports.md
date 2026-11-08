# Runbook: student imports and credentials

## Running the worker
- **Development**: `IMPORT_WORKER=inline` (default). The API process runs the worker.
- **Production / pilot**: API instances `IMPORT_WORKER=off`; one dedicated process runs
  `npm run build -w server` once, then `npm run start:worker -w server` under your process manager
  (restart on failure). Same environment variables as the API. Check its logs for `import worker started`.
- A stuck job resumes by itself when its 60-second lease expires. After 5 failed attempts it is marked `failed`;
  fix the cause and press retry (`POST /imports/:id/retry`).
- Do not run big imports or reissues during an exam window.

## A temporary-password file was lost or expired
1. `POST /imports/credentials/reissue` with `{ "importJobId": "<id>", "reason": "File lost" }`
   (or `divisionId`, `classId`, or `loginIds`). Check the preview.
2. `POST /imports/:newJobId/confirm`, wait until its status is `completed`.
3. `POST /imports/:newJobId/credentials/export` (one-time). Hand the passwords out in person.
Students keep no working session after this and must change the password at first login.

## Retention
Rows are deleted `IMPORT_RETENTION_DAYS` days after completion (default 30; set the real value under D-06).
To keep an import longer, export what you need first; there is no "pause deletion" switch by design.
