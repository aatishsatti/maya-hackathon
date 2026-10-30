# Maya

A voice companion for older adults, with a dashboard for their family. Made by the Maya team.

Maya talks with a person on a live voice call or in a written chat. She remembers what matters to them (only what they said), keeps a gentle eye on how they are doing, helps them spot scams, and lets their family know when it matters. Plain Node server plus plain static web: no dependencies, no build step (Node 22 or newer).

## What it is made of

- **Ears: Meta Transcribe** (`muse-voice-transcribe-1.0`). Streamed for live calls, uploaded as a file for voice notes.
- **Brain: Meta Spark** (`muse-spark-1.3`). Writes Maya's replies, files memory after a call, reads photos, and checks for scams.
- **Voice: ElevenLabs.** Only turns Maya's words into speech. It is the one part that is not Meta.

See what each Meta model does, with real measured numbers, limits and costs, on one page: [`docs/meta-models.html`](docs/meta-models.html) (write-up: [`docs/meta-models.md`](docs/meta-models.md)). The scam shield's accuracy, with every miss listed, is in [`docs/scam-results.md`](docs/scam-results.md).

## What is in it

- **Live call.** The person opens the app, picks who they are, and calls Maya. She answers by voice, one friendly voice whose tone follows the conversation.
- **Written chat.** Typed messages, voice notes and photos, with the same Maya, memory and safety rules as a call.
- **Memory.** After a call Spark files what the person said into a small private file about them (people, events, likes, and open follow-ups she may gently ask about once). No transcript is kept.
- **Calling first.** The family sets reminders; Maya calls with them, rings back after a silence, and if someone says they might hurt themselves she stays with them and the family gets one alert. Mode (Standard, Cautious, Ultra Cautious) is the family's choice.
- **Wellbeing trends.** From daily counts only (never words), Maya notices when someone is quietly different from their own usual over several days. The family sees a plain "What changed" card with the numbers behind it. It is never an alert, and Maya says nothing about it to the person.
- **Scam shield.** She reads a photo of a letter or screen, and checks what the person types or says (a message, a call, a visitor). If it looks like a scam she says so without certainty, asks them not to pay or share anything yet, and, if they are about to act, asks them to pause. The family hears about it only if the person says yes, and then only the kind of scam, never the words.
- **Family dashboard** at `/family.html`. Alerts (red), flags (yellow), reminders, messages, scam cards and the "What changed" card. It never shows transcripts, audio, topics or location.

## Run

```
cp .env.example .env
npm start
```

Open http://localhost:3000 (the microphone needs localhost or https). The family dashboard is at http://localhost:3000/family.html. Change the port with `PORT`.

## Modes

Set `META_MODE` in `.env`:

- `META_MODE=mock` (the default): safe to try. No Meta or ElevenLabs request is ever made. Replies are canned and clearly marked as mock. Reminders and the family dashboard work; live calls and the written chat are switched off.
- `META_MODE=real`: needs `META_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. If a key is missing the server refuses to start. Live calls, chat, memory, trends and the scam shield are on. If Meta fails, Maya says so honestly: there is never a made-up reply.

`render.yaml` is a deploy blueprint for Render's paid `1c-2g` plan with a persistent disk at `/var/data` (the four data directories are set under it); the keys are entered in Render's dashboard, never in the repo.

## Privacy and rules

- Keys live in server environment variables only. Never in the repo, the frontend or the logs.
- After a call the words are filed into facts and thrown away; no transcript is kept. A person's facts are kept in a private file per person under `data/` (git-ignored). Photos and voice notes from the written chat are kept in `data/media/` and removed with the person.
- The family sees who, when, how many tries and the kind of thing (for example "payment scam"), never what was said.
- Maya never diagnoses, gives medical advice, gives a phone number, or invents facts about the person, the weather or the news.

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

Built: the live call, the written chat, memory, calling-first care and safety, wellbeing trends, the scam shield and the family dashboard.

Not built, and not claimed:

- **WhatsApp.** Planned, not started. Nothing is ever sent to WhatsApp.
- **Ringing a locked phone.** Maya rings only while the app is open, and the family is notified only while the family page is open. There is no phone push provider yet.
- **Fall detection.**
- **Login.** The person picks who they are from a list, and the family page has no password. Both are protected only by a same-origin check. This is a prototype, not ready for real households.
- **Measured on real people.** The evaluation uses test sets the team wrote and synthetic speech. See the limits on [`docs/meta-models.html`](docs/meta-models.html).
