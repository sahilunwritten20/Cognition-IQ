# k6 load tests

See `docs/operations/LOAD_TESTING.md` for the full procedure, pass criteria and what to send back.

Quick start (from the repository root, against STAGING):

```powershell
npm run load:seed -w server -- --yes                      # creates load/data/users.json + meta.json and an open exam
k6 run -e BASE_URL=https://staging.college.edu -e SCENARIOS=exam,monitor `
       --console-output=load/results/acks.log load/k6/exam.js
npm run load:verify -w server -- --quiz <quizId> --acks ../load/results/acks.log
npm run load:seed -w server -- --yes --clean              # remove the synthetic data
```
