# Maya: how Meta models are used

Maya is a voice companion for older adults. Her **ears and brain are Meta models**; ElevenLabs is only the voice. Numbers below are the average of 3 full evaluation runs (baseline of 2026-10-28; each run repeats every check 2 times), text only. The same facts, with the flow diagram and scorecard, are on the page `docs/meta-models.html`.

## What each model does

| Meta model | Job | This run |
|---|---|---|
| **Spark** `muse-spark-1.3` (brain) | Live reply: what Maya says, plus a private read of the person's feeling, subject and pain | 382 calls, 2.0 s average, 3,517 tokens in per call; 26% cancelled and rewritten on purpose |
| **Spark** (brain) | Files memory after a call: people, events, open follow-ups (closing them when answered) | 24 calls, 9.3 s average, in the background |
| **Spark** (brain) | Scam check on typed and spoken talk: six signs plus "happening now" and "about to act", so Maya can pause someone before they pay | 304 calls (half at each reasoning setting, for the comparison); the live setting, minimal: 2.3 s average |
| **Spark vision** | Describes a photo for Maya; checks a photo for a scam | wired and used; **not measured** (the evaluation is text only) |
| **Transcribe** `muse-voice-transcribe-1.0` (ears) | Hears live calls (streamed) and recorded voice notes | voice notes: 48 hearings, 2.1 s average; live calls: used, not part of the evaluation |

## Results (details on the page)

- **Conversation:** 0% of replies repeat a polite phrase; subject tag right 93%; the "nobody knows" worry answered with what the app does 98%.
- **Memory:** a due follow-up asked at the first reply 92%; never asked twice; trimmed memory still answers; nothing invented.
- **Trends (simulation):** ordinary life wrongly flagged 2.0%; slow drifts noticed within two weeks 78% on average.
- **Scam shield:** dev scams warned 99%, no normal item warned. Held-out: 37 of 38 scams warned by the detector, 35 of 38 behind the live word filter, 0 of 38 normal items wrongly warned.
- **Hearing:** word error rate 3.0% on synthetic clean speech (the average of 8 runs); 98.5% of key words, 99.4% of scam words survived.

## What changing the scam check's reasoning cost

The scam check on talk moved from reasoning `low` to `minimal`, decided on the dev half (4 runs per setting): warned 100% vs 99%, false warnings 0% vs 0%, about 1.7x faster, 57% fewer output tokens. The held-out half was run once for each: `low` warned 38 of 38, `minimal` 37 of 38 (one polite invoice scam moved from a warning to a caution: still flagged, not missed). Not a significant drop, not nothing. Both runs are published in `docs/scam-results.md`.

## Limits

- Hearing was measured on **synthetic clean speech** (the Mac's built-in voice): no real older voices, accents or noise. The streamed-call path was not measured separately.
- Photos (Spark vision) are wired and used but **not measured**: the evaluation is text only.
- The test sets were written by the team, with small samples (38 scams and 38 normal items per half); run-to-run noise is about two items.
- About 26% of live replies are cancelled and rewritten by Maya's own repeat and beat guards, which costs extra time and tokens.

Run `npm test` (offline) and `npm run eval` (Meta text only, no ElevenLabs); `node eval/page.js` rebuilds the page and this note.
