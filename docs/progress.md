# Progress
- Done: F1 voice loop, F2 memory (per-profile), global emotions, F3 calling-first (committed). Next: wellness loop / app phase after AI is perfect, then F4 scam shield.
- Stack: Meta Transcribe + Spark, ElevenLabs. Keys in server .env only. data/ (profiles, care) git-ignored; no transcripts kept.
- F3 calls: silence 20-30 s, then 10 s, 8 s, hang up (never after worrying words). Call-back 5 s after silence hang-up, in-app ring only while the app is open, Accept/Decline, 3 tries 1-2 min apart. Reminders from /family.html, task named first, Spark-worded, only the family's words (no dose/advice).
- F3 alerts: Green=nothing; Standard=Flag, Alert on talked-then-quiet; Cautious=Flag+note, Alert after 3 h; Ultra=Alert always; quiet hours cap at Flag. Family push = dashboard + event to an open /family.html only. No phone push, no locked-phone ringing.
- Safety: self-harm intent -> Spark-written reply + urgent topic-only Alert, cleared only by family "I've seen this". safetyCut after family Seen = NO ring on purpose (family is handling it); active + no Seen + cut = ring in 5 s. Tier B (fear of dying) = empathy only.
- Messages: family text that is a message ("its leena your daughter", "your son ...") is delivered as a message, not a task.
- Voice: first TTS piece ends at a sentence end (comma only after "Oh dear,"/"Oh,"); ~3 s avg speechEnd->firstAudio, safety rewrites are slower (known).
- Tests: node --test test/*.test.js (59, Spark stubbed). MAYA_CARE_SCALE shrinks timers for manual tests.
- Not done: closed-app ringing, WhatsApp video, live video seeing, fall detection, non-English quality, two-speaker diarization.
