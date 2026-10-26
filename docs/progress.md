# Progress
- Feature 1 (voice loop, full-duplex feel) done. Next: Feature 2 memory (not started).
- Files: server.js, call.js, brain.js, reply.js, emotion.js, transcribe.js, ws.js, public/app.js, public/mic-worklet.js.
- Stack: Meta Transcribe (ears) + Meta Spark (brain) + ElevenLabs Hope, eleven_v4_turbo 0.45/0.75/boost. Keys in server .env only.
- Passed (synthetic + owner ear test): varied short greeting, silence flow 8.0/4.5/4.5/5.5 s + hang-up, ding dips not stops,
  barge-in dip 165-198 ms (hard stop 973-1543 ms), own turn-end 0.88-0.98 s, "Okay." not stuck, 2 s dangling pause waits, piece gaps 249 -> 86 ms.
- Behaviour: whispers OFF, happy/excited first phrase only, varied empathy openings, self-harm words use a fixed safety reply (real escalation policy still to be defined).
- Known limits: Spark first token 2.0-3.9 s (dominates latency); Transcribe is text only, so no tone from voice;
  two-real-speaker diarization never tested on real people; a pause longer than ~1.2 s after a complete sentence still gets an answer;
  hang-up line can be interrupted by late speech (edge case, untested); names and last topic live in server memory only until Feature 2.
