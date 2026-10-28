# Maya

A warm voice companion for senior citizens. Made by the Maya team.

Plain Node server plus plain static web. No dependencies, no build step.

## Run

```
cp .env.example .env
npm start
```

Open http://localhost:3000 (microphone access needs localhost or https).

## Modes

- `MAYA_MODE=mock` (default): canned replies, each marked as mock. No external calls.
- `MAYA_MODE=real`: not built yet. The API returns 501 and the UI shows the error. There is no fake reply.

## Tests and evaluation

Two commands, for two different jobs. Neither ever calls ElevenLabs.

- `npm test`: the offline tests (about 400, no network, no keys, about 40 seconds). They guard the logic: what Maya may say, the memory rules, the scam decisions, the trend rules, the family flow, the privacy rules and the generated page.
- `npm run eval`: the Meta evaluation. It runs Maya's real brain (Meta Spark) and ears (Meta Transcribe) on fixed inputs, text only, plus a few sentences spoken by the Mac's own `say` voice for the hearing test. About 700 Meta calls and about 5 minutes. It prints the guard rails, compares the numbers with the saved baseline, and prints a table of the Meta models doing the work. It exits with an error if a guard rail fails or a number has dropped by more than normal run-to-run noise. Each suite runs on throwaway data folders, never on your real data.
  - `npm run eval:offline` runs only the part that needs no Meta key (the trends simulation).
  - `node eval/run.js --suites scam,hearing --runs 4` runs chosen suites with more repeats.
  - Results go to `eval-results/` (git-ignored).
- The scam test set is split. Routine runs use only the **dev** half. The **held-out** half is reserved for deliberate final runs (see `docs/scam-results.md`).
- `docs/eval/baseline.json` is the saved baseline: the average of several full runs, with the spread seen between them. Update it (`node eval/baseline.js eval-results/run-*.json --write`) only after a deliberate improvement, never to hide a regression.
- `node eval/page.js` rebuilds `docs/meta-models.html` and `docs/meta-models.md` from the committed data. A test fails if they are out of date.
- Suggested pre-push check: copy `scripts/pre-push.example.sh` to `.git/hooks/pre-push` yourself. It runs the offline tests and the offline evaluation only, never the Meta calls.

## Status

Task 1: setup + Feature 1 (voice loop) skeleton in mock mode. Memory, calling-first,
scam shield, dashboard and WhatsApp come later, one at a time.

Keys live in server env only. Never in the repo, the frontend, or logs.
