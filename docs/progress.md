# Progress
- Feature 1 (voice loop) done, owner ear-tested. Feature 2 (memory + profile picker + dynamic length) done. Next: Feature 3 (calling-first/reminders), then global emotions.
- Stack: Meta Transcribe + Spark, ElevenLabs Hope eleven_v4_turbo. Keys in server .env only. Files: server.js call.js brain.js reply.js emotion.js memory.js transcribe.js ws.js public/{app,profiles,mic-worklet}.js.
- F2 storage: data/profiles/<id>.json per profile (git-ignored), only that profile loaded per call, no transcripts. Columns people/events/preferences/current/topics, each fact dated; Spark gets date/time every turn.
- Per-turn words go to <id>.pending.jsonl (disk only); Spark extracts at call end, server start, next call start. Corrections replace old facts and drop stale topics. Pending words deleted after filing.
- Picker: separate screens, Save goes straight to call, duplicate names 409, per-profile Delete, no profile = no call. Gender only for pronouns; Maya voice stays Hope.
- Length: normal chat 1-3 sentences; story/recall lifts cap only when Spark intent AND the person's words match (token cap 4000, stream timeout 120 s, stories keep 1500 chars).
- languageBias English, Spanish, French, Portuguese, Hindi; non-English quality untested, not claimed.
- Not done: reminder execution (F3), self-harm escalation is a placeholder fixed reply (policy: de-escalate aloud, calmly tell senior family is alerted, topic-only alert, family decides, never call emergency, literal intent + context not keywords), two-real-speaker diarization untested.
- Known limits: Spark first token 2-4 s; Transcribe is text only (no tone); late speech can interrupt the hang-up line.
