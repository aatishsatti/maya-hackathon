# Maya

****Judges: Please use the Android APK as the primary way to try Maya. The reported web voice issue has been fixed, but if you encounter a browser-specific problem(in chrome), please continue in the Android app or in Safari(tested).**.**
**Web voice was tested successfully in the tester’s Safari setup.**

A warm, voice-first companion for senior citizens who live alone.

**Demo video:** https://youtu.be/Yhtx0Oye1I0 — must stay live for judging Nov 5-8, do not set to Private.

**Live demo:** https://maya-singapore.onrender.com
**Live build at time of writing:** dc4f79f8f2a592e9e1beae1e43f365bfb289ca07 (branch `render-test`, mode real, demo true)
**Note on build:** Web voice start-guard fix (3500 ms local / 4500 ms network) is deployed as dc4f79f. Web voice works in Safari — see "What is proven, and what is not" below. In Chrome, we faced voice errors (see below).

## What Maya is

Maya is a voice-first companion for senior citizens who live alone and may not have someone to talk to every day.

**Senior is the user, NOT the buyer or installer.** Seniors will not discover an app themselves, and they should not have to learn one. Family, kids, or caregivers install Maya once, do one-time setup, and give the senior a link or code. The senior just talks — no signup, no password, no menu, no app to learn.

**Senior door:** link/code to chat/call, straight in, no dashboard, no Family link inside senior chat.
**Family door:** username + password dashboard, for family/team only, to see reminders, flags, alerts, and daily calls (view-only for senior's calls).

**What Maya does:**
- Talks by voice call or written chat, like a companion/friend, not a tool listing features — varies wording, gets to know a senior over hours, one thing at a time, only from what they actually say, never invents history or preferences.
- Remembers what matters (only what they said), calls them for daily chats they asked for, reminds them, and checks messages/photos for possible scams.
- Tells family only what the senior said yes to, topic only — senior no = dashboard-only yellow flag, no alert, Maya never asks again on that incident.
- Refuses medical advice always, advises contacting a doctor/healthcare provider, never diagnoses.
- Quiet hours available, OFF by default, Tier A safety alerts ignore quiet hours.

**What Maya is NOT:**
- Not a medical device, not a diagnosis tool, not a fall detector, not a location tracker, not an emergency/PSTN caller.
- Not a WhatsApp feature — WhatsApp is ONE channel, Maya is a standalone product: app + phone calls + dashboard, WhatsApp integration live.
- - English is the demonstrated language. Other-language behaviour is best-effort unless a specific tested language and result are documented; broad multilingual capability is not claimed as live-proven.
- Senior self-signup with a form is NOT built — it is vision only. Today, family/team creates the senior profile and gives the senior a link/code. Senior gets link/code + chat/call, not a dashboard.

## Try it — judges, no account needed for senior

**Demo senior: Frank, code `96618dfe`**
Link form: `https://maya-singapore.onrender.com/s/96618dfe`

**In the app:**
1. Open the Maya app.
2. If another senior is already linked on that phone, tap Sign out first — sign out only forgets the link, it does NOT delete Frank's profile/chat on the server.
3. Start screen → **Enter code** → type `96618dfe` → straight into Frank's chat/call.
4. Senior has no username, no password, no signup form.

**On the web:**
Open the senior link above or the demo start screen. The judge deployment provides access to a shared fictional demo without a signup task. Outside this demo, family-dashboard access requires a family account; the senior’s personal link/code remains passwordless. Private family credentials are not published. The submit form for this hackathon has no private/judges-only field, so no password is published here or there.

**Family dashboard:** Web pre-logged-in demo for judges, and app family login for family/team accounts. Family dashboard is view-only for senior-owned daily calls — family cannot cancel or change a senior's daily call without senior permission.

## How Maya works — Meta models at runtime

Every AI model the project itself calls at runtime is Meta. Development tools are credited separately below and are NOT runtime features.

- **Brain / sentence-writing: Muse Spark, `muse-spark-1.3`.** Writes every reply, files memory after a call, reads photos, and checks for scams. Code supplies permitted facts only, never a sentence for Spark to copy, except approved fixed strings in code.
- - **WhatsApp: WhatsApp Cloud API — Meta, and WhatsApp Business Calling API — Meta.** The reported live template configuration is `maya_reminder`, language `en`, with reminder text and a Got it quick reply. An inbound user reply/button response opens or refreshes the messaging window; sending an invitation alone does not. Calling requires separate active permission and is subject to Meta’s limits. The selected video demonstrates message receipt and incoming ringing. Maya does not use `hello_world`.
- **WhatsApp: WhatsApp Cloud API — Meta, and WhatsApp Business Calling API — Meta.** Template `maya_reminder`, live language `en` (not `en_US`), variable `{{1}}` = reminder text, "Got it" quick-reply, 24-hour window opens on Got it. Maya never sends `hello_world`.
- **Voice, current:**
  - **WhatsApp calls and voice notes: Meta MMS, `facebook/mms-tts-eng`, Meta open-source, self-hosted speech generation, male voice for English.** This is the current server voice on WhatsApp, disclosed here plainly.
  - **App and web: device voice, OS/browser feature, NOT a model call.** Android native TTS on app, browser `speechSynthesis` on web, female when available on the device. Judges on phones hear their own device voice, not a Mac-only voice.
- **Voice change — ElevenLabs removed:** Earlier builds used ElevenLabs for voice. For this hackathon, every AI model at runtime must be Meta, so ElevenLabs was removed from runtime and replaced with the Meta-compliant voices above: Meta MMS on WhatsApp, and OS/browser device voice on app/web. **ElevenLabs is NOT used at runtime in the final submission. Tavily is also NOT used at runtime. FastSpeech2 was dropped and is NOT used.**
- **Development tools, separate from runtime:** Claude Code, Gemini CLI / Argon, Anti-Gravity, Astra, Z Code / Sonnet. These built, reviewed, or checked the product during development. They are NOT runtime features and are NOT presented as such.

**Live-API diagram labels, used in video:** "Diagram (illustration)" for animation, "Actual application log — this recording" for real log lines. Animation alone is NOT proof; log lines are the proof. No reconstructed payloads, no fabricated `200 OK` panels, no full raw HTTP bodies are claimed.

## What is proven, and what is not

The evidence below concerns specific recorded sessions, not automatic verification of every feature in the latest deployment. Henry’s WhatsApp sessions are associated with build `309c61a`; Frank’s app, scam and plant sessions with `84fe439`. These associations are inferred from deployment timing because runtime logs do not print commit hashes.

The retained Render export is partial: Nov 4 17:58:43–20:02:20 UTC, equivalent to Nov 4 23:28:43–Nov 5 01:32:20 IST. Video/log matches use recognised words, event order and available timing evidence. Maya’s spoken reply text is not logged; recordings establish that wording. Only selected, redacted evidence should be published.

- **Daily-call set — Frank, Nov 5 00:39-00:41 IST:** Loneliness → daily-call offer → confirm → saved. Log labels: `social-offer`, `social-ask`, `social-confirm`, `social-saved`. Turn texts include "Nothing much. Just sitting by myself." / "Yeah, I'm always by myself." / "No one to talk to, you know," / "Yeah, sure. If you can do that." / "So, when can you call me?" / "Just call me at / one AM / 1 AM / every day starting today" / "Yes," / "Thank you Maya. I'm looking forward to talk to you". Call stages: `startReceivedAt 1793819385183`, `transcribeReadyMs 1091`, `greetSparkFirstMs 3871`.
- **App incoming ring — Frank, Nov 5 01:00 IST:** `care ring profile 96618dfe kind reminder attempt 1 appOpen false`, Android push ring pushed ok true. Turns: "All good, Maya." / "Yes. It / is calm." / "Okay Maya, bye bye." Call stages: `startReceivedAt 1793820612596`, `transcribeReadyMs 1158`.
- - **Plant reminder — Frank:** A family-set plant reminder arrives in chat. The recording shows Got it changing to Marked as seen; a later dashboard screenshot shows the same task as Seen. The 01:12 IST application log establishes sending/reach only. The unrelated 01:32:20 IST “answered via app” event is not used as this reminder’s acknowledgement evidence. Seen means acknowledged, not proof the plant was watered.
- **Scam, lottery/prize only, NOT bank — Frank, Nov 5 01:17-01:19 IST:** Turns: "Just sitting Maya you know I got a message saying that I have won a lottery" / "so they've given me a number to call" / "No, I haven't done that yet" / "I was thinking of calling it." / "No," + `care scam flag profile 96618dfe type prize scam` at 01:19:25 IST / "don't tell my family." at 01:19:27 IST. Result: dashboard-only yellow flag, NO topic-only alert sent — the correct No branch. Maya analyses whether something is a possible scam, never claims to detect every scam, never claims uniqueness.
- **WhatsApp — Henry (`197abefc`), labelled separately, NOT Frank:** Text Nov 4 11:46:02 PM IST, call Nov 4 11:36:01 PM IST, call id `d00d6c`, duration 61 s, turns "Okay, Maya." / "Hello, Henry. How are you today?" / "That sounds lovely. Tell me more." Proven: text delivery + reply / 24h-window path via `maya_reminder`, rang/picked up/spoke/hung up. WhatsApp video in the backup is ring-only for the call clip, do NOT claim a full WhatsApp conversation from a ring-only clip. WhatsApp voice is male MMS, as disclosed above.

**Web voice status:** Web voice echo cut-off is fixed in code (device voice plays, mic uplink sends silence plus 400 ms tail, so Maya does not answer her own echo; web status line: "Maya is speaking. Please wait until she finishes, then talk."). Web voice start guard was raised in dc4f79f (local 3500 ms, network 4500 ms, was 1000/2500 ms).
- **Web voice works in Safari.** Judges testing web in Safari should hear device voice.
- **In Chrome, we faced errors:** Samantha / Flo (English (United States)) failed with "did not start in 1000 ms" then "did not start in 3500 ms", then text only, on the tester's Chrome 156.
- **- Android app voice and WhatsApp voice were tested separately from web voice. Their results do not establish support on every device or browser..**

## Safety, alerts, reminders

- **Medicine: ALWAYS refusal**, natural and non-repeating, advise contacting a doctor/healthcare provider. No medical, diet-medicine-interaction, or wellness suggestion from research.
- **Scam family-sharing:** Senior yes = topic-only Alert. Senior no = yellow flag only, Maya never asks again on that incident. An ordinary/quoted/scammer-directed "yes", a question, or past-tense talk is NOT a yes to Maya's family question.
- **Alerts:** Tier A safety immediate regardless of mode/quiet hours, topic-only, cleared only when family presses Seen. App modes: Standard (default, flag only for non-safety), Cautious (flag + gentle non-emergency notification), Ultra Cautious (opt-in, noisy by choice). WhatsApp: status only, no auto-alert. Tier B (death worry without intent): no alert or callback.
- **Daily calls:** Senior owns them — senior can skip today / change time / cancel / stop anytime. Family dashboard is view-only for senior calls. Delivery is app-only, one ring, one bounded attempt, no WhatsApp, no retry, no family escalation.
- **Quiet hours:** Available, OFF by default for every profile, ON only when explicitly set true, toggle still works. Senior-local 22:00-07:00 when ON, unknown timezone = nothing held, Tier A exempt.
- **Reminders:** Way/channel from senior's words, else source channel default. Only one reminder at a given slot — Maya says one exists / asks keep-or-change, never silently creates a second.

## Privacy and rules

- - Runtime API credentials are configured server-side. Credentials must not be included in the repository, client bundles, screenshots or published logs. Publish only reviewed, redacted excerpts; keep unredacted originals private.
- Family sees who, when, how many tries, and the kind of thing (for example "prize scam"), never what was said, never transcripts, audio, topics, or location.
- If the person says no to telling family about a possible scam, no message, alert, or push is sent. The topic still appears as a yellow flag on the family dashboard. Saying no stops the notification, not the dashboard note.
- - Maya’s enforced boundaries prohibit diagnosis, medical advice, invented contact details and unsupported claims about the senior or current information. Code checks and prompting reduce these risks; they are not a guarantee of error-free model output.
- - Demo maintenance is separate from the senior product. The public demo contains a fictional senior profile, setup facts and genuine test conversations—not fabricated conversation history. Maintenance tools are not judge-facing features.
- Solo senior self-registration form is NOT built — vision only, in this README only, not in video claims.

## Run
**Requires Node.js 22 or later.**

```
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000 (microphone needs localhost or https): with nobody linked it shows the start screen (family login/signup / Enter code). Family dashboard is at http://localhost:3000/family.html. On a real (hosted) server the family login lock is on by default. Change the port with `PORT`.

Modes: `META_MODE=mock` (default, safe to try, no Meta request, replies canned and marked mock, live calls/chat off) vs `META_MODE=real` (needs Meta key, live calls, chat, memory, trends, scam shield on; if Meta fails, Maya says so honestly, never a made-up reply).

`render.yaml` is a deploy blueprint for Render's paid 1c-2g plan with a persistent disk at `/var/data`; keys are entered in Render's dashboard, never in the repo.

## Tests and evaluation

Targeted suites for the web-voice guard fix on the working tree: mms-voice 9/0, novoice 8/0, interrupt 4/0, prompt 60/0 (3 skipped). Full per-file suite (106 files, 150 s timeout each, because the full `node --test` run hangs on wabridge.test.js): 1013 tests, 958 pass, 51 fail, 4 skipped, 14 files non-zero — identical totals and same 14 files in the working tree and in a clean export of 84fe439, so those 51 are pre-existing in this environment, NOT caused by the guard fix. They were not investigated or fixed for this submission. The mms-voice 7/2 flake was captured with names (Call 2 ready beep timing, greeting parallel-start timing), both timing-order tests, not the guard test, cause not proven.

Live proof is the tester's own verdict on phone/browser. Coded and mock-tested are never called fixed until pushed, deployed, config-checked, and live-retested.
