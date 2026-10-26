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

## Status

Task 1: setup + Feature 1 (voice loop) skeleton in mock mode. Memory, calling-first,
scam shield, dashboard and WhatsApp come later, one at a time.

Keys live in server env only. Never in the repo, the frontend, or logs.
