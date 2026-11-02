# Maya

A voice companion for older adults, with a dashboard for their family. Made by the Maya team.

Maya talks with a person on a live voice call or in a written chat. She remembers what matters to them (only what they said), keeps a gentle eye on how they are doing, helps them spot scams, and lets their family know when it matters. Plain Node server plus plain static web: no dependencies, no build step (Node 22 or newer).

## What it is made of

- **Ears: Meta Transcribe** (`muse-voice-transcribe-1.0`). Streamed for live calls, uploaded as a file for voice notes.
- **Brain: Meta Spark** (`muse-spark-1.3`). Writes Maya's replies, files memory after a call, reads photos, and checks for scams.
- **Voice: ElevenLabs.** Only turns Maya's words into speech. It is the one part that is not Meta.

See what each Meta model does, with real measured numbers, limits and costs, on one page: [`docs/meta-models.html`](docs/meta-models.html) (write-up: [`docs/meta-models.md`](docs/meta-models.md)). The scam shield's accuracy, with every miss listed, is in [`docs/scam-results.md`](docs/scam-results.md).

## What is in it

- **Live call.** The person opens the link their family sent (no login, no password) and calls Maya. She answers by voice, one friendly voice whose tone follows the conversation.
- **Written chat.** Typed messages, voice notes and photos, with the same Maya, memory and safety rules as a call.
- **Memory.** After a call Spark files what the person said into a small private file about them (people, events, likes, and open follow-ups she may gently ask about once). No transcript is kept.
- **Calling first.** The family sets reminders; Maya calls with them, rings back after a silence, and if someone says they might hurt themselves she stays with them and the family gets one alert. Mode (Standard, Cautious, Ultra Cautious) is the family's choice.
- **Wellbeing trends.** From daily counts only (never words), Maya notices when someone is quietly different from their own usual over several days. The family sees a plain "What changed" card with the numbers behind it. It is never an alert, and Maya says nothing about it to the person.
- **Scam shield.** She reads a photo of a letter or screen, and checks what the person types or says (a message, a call, a visitor). If it looks like a scam she says so without certainty, asks them not to pay or share anything yet, and, if they are about to act, asks them to pause. The family hears about it only if the person says yes, and then only the kind of scam, never the words.
- **Family dashboard** at `/family.html`. Alerts (red), flags (yellow), reminders, messages, scam cards and the "What changed" card. It never shows transcripts, audio, topics or location.

## Try it

Live: https://maya-singapore.onrender.com (a Render server in Singapore; the branch is `render-test`).

- **As the family:** open the live link, tap **Sign up**, make an account, add a family member (name, time zone, mode). Maya gives you the person's link and code.
- **As the person:** open that link (`/s/<code>`) on a phone or computer, or tap **Enter code** on the start screen. No login. Write to Maya, send a voice note, or tap the phone button to talk.
- **Back as the family:** log in again and open the dashboard to see reminders, flags and alerts for that person.

## Run

```
cp .env.example .env
npm start
```

Open http://localhost:3000 (the microphone needs localhost or https): with nobody linked it shows the start screen (Log in / Sign up / Enter code). The family dashboard is at http://localhost:3000/family.html. On a real (hosted) server the family login lock is on by default; set `MAYA_FAMILY_LOGIN=off` to open it for local work. Change the port with `PORT`.

## Modes

Set `META_MODE` in `.env`:

- `META_MODE=mock` (the default): safe to try. No Meta or ElevenLabs request is ever made. Replies are canned and clearly marked as mock. Reminders and the family dashboard work; live calls and the written chat are switched off.
- `META_MODE=real`: needs `META_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. If a key is missing the server refuses to start. Live calls, chat, memory, trends and the scam shield are on. If Meta fails, Maya says so honestly: there is never a made-up reply.

`render.yaml` is a deploy blueprint for Render's paid `1c-2g` plan with a persistent disk at `/var/data` (the four data directories are set under it); the keys are entered in Render's dashboard, never in the repo.

## Privacy and rules

- Keys live in server environment variables only. Never in the repo, the frontend or the logs.
- What is said on a call is also shown in that person's chat history, so nothing said aloud disappears: the latest 200 lines of chat and calls are kept per person on the server disk, and **are** words. Call audio is never recorded or kept. After a call Spark also files the words into short notes; the temporary file of words is deleted once it is filed. A person's facts are kept in a private file per person under `data/` (git-ignored). Photos and voice notes from the written chat are kept in `data/media/` and removed with the person.
- The family sees who, when, how many tries and the kind of thing (for example "payment scam"), never what was said.
- **If the person says no** to Maya telling their family about a possible scam, no message, alert or push is sent. The topic (for example "possible pension scam", never their words or the photo) **still appears as a yellow flag on the family dashboard**. Saying no stops the notification, not the dashboard note.
- Maya never diagnoses, gives medical advice, gives a phone number, or invents facts about the person, the weather or the news.

## Tests and evaluation

Two commands, for two different jobs. Neither ever calls ElevenLabs.

- `npm test`: the offline tests (957 checks: 953 pass and 4 are skipped because they need live keys, no network, no keys, about 80 seconds). They guard the logic: what Maya may say, the memory rules, the scam decisions, the trend rules, the family flow, the privacy rules and the generated page.
- `npm run eval`: the Meta evaluation. It runs Maya's real brain (Meta Spark) and ears (Meta Transcribe) on fixed inputs, text only, plus a few sentences spoken by the Mac's own `say` voice for the hearing test. About 700 Meta calls and about 5 minutes. It prints the guard rails, compares the numbers with the saved baseline, and prints a table of the Meta models doing the work. It exits with an error if a guard rail fails or a number has dropped by more than normal run-to-run noise. Each suite runs on throwaway data folders, never on your real data.
  - `npm run eval:offline` runs only the part that needs no Meta key (the trends simulation).
  - `node eval/run.js --suites scam,hearing --runs 4` runs chosen suites with more repeats.
  - Results go to `eval-results/` (git-ignored).
- The scam test set is split. Routine runs use only the **dev** half. The **held-out** half is reserved for deliberate final runs (see `docs/scam-results.md`).
- `docs/eval/baseline.json` is the saved baseline: the average of several full runs, with the spread seen between them. Update it (`node eval/baseline.js eval-results/run-*.json --write`) only after a deliberate improvement, never to hide a regression.
- `node eval/page.js` rebuilds `docs/meta-models.html` and `docs/meta-models.md` from the committed data. A test fails if they are out of date.
- Suggested pre-push check: copy `scripts/pre-push.example.sh` to `.git/hooks/pre-push` yourself. It runs the offline tests and the offline evaluation only, never the Meta calls.

## Status

Built: the live call (web and Android app), the written chat, memory, calling-first care and safety (reminders, call-backs, escalation to the family), wellbeing trends, the scam shield, WhatsApp (text, voice notes and calls through Meta's WhatsApp Business API), and the family dashboard with family accounts.

Not built, or built but not proven, and not claimed:

- **Ringing a closed phone.** Built for Android (Firebase push → the system call screen); **not yet proven on a real phone**. The iOS code exists and is untested. While the app is open, Maya rings it.
- **WhatsApp outside the 24-hour window.** The template message with a Got it button is built; **not yet proven live**.
- **Fall detection.** None.
- **Real-household security.** The family signs in with a username and password. The person never logs in: their link (an 8-character key) opens their chat, so anyone who has the link can open it. This is a prototype, not ready for real households.
- **Measured on real people.** The evaluation uses test sets the team wrote and synthetic speech, and one live voice call. See the limits on [`docs/meta-models.html`](docs/meta-models.html).
- **Voice speed.** Maya's first audio comes about 2 to 3 seconds after a person stops talking (live, 2 November): mostly Spark thinking time. See the live numbers on the same page.

## How Maya stays on topic (smart.js, flags, off by default)

Maya's voice model (Muse Spark 1.3) is fast, and a fast model drifts as the prompt grows. So **code decides what it sees each turn and checks what comes back**. Spark is the wording layer; code owns the decisions. No model call is made by this layer, no bigger model is used, and the first scam gate (`scam.js`) is unchanged. A miss by that first gate cannot be rescued here.

```
 senior says something
   |
   v
 [scam.js first gate, unchanged] ---> signals (urgency, money, impersonation, secrecy, payment)
   |
   v
 ROUTER (code)      scam / reminder / ability question / health / small talk / follow-up; a topic-switch fact
 ABILITIES (code)   one short fact per ability that really exists, and a "cannot" fact for what does not
 DECISION (code)    signals -> Warning / Caution / Not sure / "Nothing unusual so far"; unknown or failed is never safe
 KINDS (data)       what the real bank / tax office / lottery / airline / police / tech support / relative / investment does, and common traps
 CARDS (code)       STATE (kind, signs, contact, questions asked 0-3, next missing fact, consent read-only) + RECORD (what really ran)
   |
   v
 Spark words the reply  (wording only)
   |
   v
 GUARD (code)       blocks "verified safe", "100% scam", an invented link or number, "I checked / told / called" with no record;
                    rewritten once, then a plain true line. Never the bad draft.
```

Flags: `MAYA_SMART=on` turns all layers on; `MAYA_SMART_<ROUTER|ABILITIES|DECISION|CARDS|GUARD|KINDS>=off|on` overrides one. All off = the same output as before.

| Check (code level, no model) | Layer off | Layer on |
|---|---|---|
| Ability questions get the right fact (12 cases) + topic switches get the switch fact (6) | 0 / 18 | 18 / 18 |
| Bad drafts blocked: certainty, invented link or number, claim with no record (12); honest drafts passed (4) | 0 / 12 | 12 / 12, 4 / 4 pass |
| Decision from signals (8 cases); short, unread, unknown or failed never "nothing unusual" | n/a | 8 / 8 |
| First scam gate, held-out set (`docs/scam-results.md`): warned / false alarms | 37 / 38, 0 / 38 | unchanged (scam tests 133 / 133) |

These count what the code hands Spark or blocks, not how Spark words it. Live checks used the real model with fresh seniors.

**What Maya will not claim.** She never says something is "verified safe" or "100% a scam". She says what she sees, says she can make mistakes, and the choice is the senior's. If a check failed or there is too little to go on, she says she is not sure and asks. She does not say she checked, called or told anyone unless the app's record shows it. She does not give phone numbers or links. Family consent is unchanged: yes sends a topic-only alert, no leaves only a quiet flag and is never asked again, one incident counts once.

The scam kinds and their "what the real thing does" rules are kinds and behaviours, checked by a human, versioned in `smart.js`. They are proposed anchors and still need a human source check before the flag goes on.

### The six layers, and how honest each label is

| # | Layer | Where | Status |
|---|---|---|---|
| 1 | V1 screening: signals from the message | `scam.js` (unchanged), held-out set in `docs/scam-results.md` | implemented |
| 2 | State and attribution: who contacted whom, what the senior reported vs what is verified, answered questions, the speaker of "do not tell anyone" | `smart.js` STATE card, `attributedToOther` | implemented (simple patterns; semantic drift beyond them remains) |
| 3 | Kind reasoning: what the real bank, tax office, lottery, airline, police, tech support, relative or investment firm does, and the traps | `smart.js` KINDS | implemented as data; **proposed anchors, country and agency exceptions not yet human-checked** |
| 4 | Evidence and tool validation: a claim like "I checked / called / told" needs a matching record | `smart.js` RECORD card and GUARD | implemented for the checks that exist (scam check, web check, family alert, saved reminder); no other tools exist |
| 5 | Code decisions and consent: Warning / Caution / Not sure / "Nothing unusual so far"; the family question, yes / no / never again, are code | `smart.js` DECISION, `care.js` | implemented; consent state is read-only to the model |
| 6 | Output and audit controls: output contract, draft guard, bounded rewrite, plain fallback, trace | `smart.js` GUARD, `trace()` | implemented; the audit trace is names and counts only |

Trace shown for a session (names only, never the senior's words): `asked`, `learned`, `checked`, `still unknown`. Example from a live-local scam run: `{"asked":[],"checked":["scam check ran","web check not run"],"unknown":["contact","source","ask","check"]}`, and when the check fails: `checked: ["scam check FAILED"]` and the decision is Not sure, never "nothing unusual".

Failure handling is shown, not only success: a stubbed draft saying "verified safe, call 1800 ..." is rewritten, and when the rewrite is also bad the senior sees "I can't be sure about this one, and I can make mistakes..." (`test/smart.test.js`). A failed scam check gives Not sure. A caller's "do not tell anyone" is not taken as the senior saying no to their family.

**Limits, plainly.** If the first gate (V1) misses a scam, nothing here can rescue it. Checks are simple patterns, so a reply that drifts in meaning can still get through. No design here guarantees zero hallucination or zero forgetting. A consent or state bug is a release blocker of its own and is tested separately. Sensitive holds are unchanged. The model never decides what is sent to the family.
