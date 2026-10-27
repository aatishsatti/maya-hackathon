# Progress
- Done: F1 voice loop, F2 memory (per-profile, picker, dynamic length), global emotions. Next: Feature 3 (calling-first/reminders).
- Stack: Meta Transcribe + Spark, ElevenLabs Hope eleven_v4_turbo. Keys in server .env only. Files: server.js call.js brain.js reply.js emotion.js memory.js transcribe.js ws.js public/{app,profiles,mic-worklet}.js.
- F2 storage: data/profiles/<id>.json per profile (git-ignored), pending words in <id>.pending.jsonl (disk only), Spark files them at call end/start. No transcripts kept. Gender only for pronouns.
- Length: normal chat 1-3 sentences; story (default 150-300 words; "full story" expands the SAME story) and recall lift the cap only when Spark intent AND the person's words match; "do you remember X?" is intent=check, short answer only.
- Emotions: global, sparing, from words only. Sad/lonely/grief/anxious/frustrated/angry at 3+ -> soft first phrase; happy/excited -> excited opening; neutral -> warm baseline. Spark may mark [[soft]]/[[warm]]/[[bright]]: max 1 per normal reply, 3 per story/recall, 4 pieces apart, none in greetings/silence. Whispers OFF; speed/style ignored.
- Tags [sympathetic]/[warmly]/[happy]/[excited], gains 0.85/0.8/0.62/0.6; fade+gap after tone pieces (excited 80+100 ms, others 30+40 ms).
- WATCH: live excited overlap was heard 2 of 5-6 before the fade fix; clips sound clean but live re-test after the fix is pending. If it returns, it is a streaming/duck issue, not a join issue.
- Not done: reminders (F3), self-harm escalation is a placeholder fixed reply, two-real-speaker diarization and non-English quality untested.
- Known limits: Spark first token 2-4 s; Transcribe is text only; late speech can interrupt the hang-up line.
