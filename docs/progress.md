# Progress
- Done: F1 voice loop, F2 per-profile memory, F3 calling-first (reminders, call-back, smart alerts, safety escalation, family Seen).
- Done: one Maya (cheerful start, soft/calm by conversation), pain ladder, greeting rules, no-repeat (identity once, normal replies), profile isolation.
- Stack: Meta Transcribe + Spark, ElevenLabs. Keys in server .env only; data/ git-ignored; no transcripts kept.
- Tests: node --test test/*.test.js (101 total, 98 pass, 0 fail, 3 skipped need MAYA_REAL_SPARK=1).
- Open: ring only while app is open; family push only on open family page; no locked-phone ringing; no real WhatsApp sends.
- Open: no fall detection; safety-line wording can still repeat; tired brightness is prompt-only (no code hook).
- Next: live re-test of tone and repeats, then F4 scam shield, F5 dashboard, F6 WhatsApp.
