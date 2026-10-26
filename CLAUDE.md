# Maya — Meta Hackathon, Oct 26-Nov 4, 2026

Fresh public repo. Web app, senior voice companion. Meta models only for brain/ears.
Build order, one at a time, perfect before next: Setup -> F1 voice loop -> F2 memory -> F3 calling-first -> F4 scam shield -> F5 dashboard -> F6 WhatsApp. No sprawl.

## Rules
- Never copy code from old senior-voice project. Fresh code only.
- Never put API keys in repo, frontend, or logs. Server env only.
- Never invent history, capabilities, weather, or phone numbers. Fail fast on Meta errors, no fake reply.
- Read official Meta docs at build time for exact API formats/enums, record them in code comments. Do not guess.
- Identity: Maya, made by Maya team. Never Google, never "Meta model" as identity.

## Workflow
- Fresh session per feature. /clear between features, never /compact unless asked.
- Do NOT switch models mid-session. Default Sonnet. Opus only when explicitly told.
- Keep this file short. Full specs live in docs/, read them only when that feature is the task.
