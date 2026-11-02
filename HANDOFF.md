# Handoff (written 2 Nov 2026; live at 97f808b; the work below is LOCAL, NOT pushed)

Maya: voice companion for older adults. Branch `render-test` is the working and deployed branch; `main` is fast-forwarded to it on every push. Live: https://maya-singapore.onrender.com (Render, Singapore).

## State
- Live at the time of writing: `97f808b`. The car-prize / conversation work is local only until the push word.
- Tests: `node --test test/*.test.js` -> 949 checks, 945 pass, 4 skipped (need live keys), 0 fail.
- `docs/maya-prompt.md` is 7,494 of 7,500 characters (a test enforces < 7,500): never add words without trimming.

## The scam family question (this change)
Live bugs: A) lottery / photo / call scams never asked the family question; B) a late "yes" answered "Done" but only sent a generic contact request; C) the open question was lost after a gap.
Causes in code:
- `chat.js afterTalkReply`: registered the open family question whenever the verdict was warn, even when her reply was the link/photo request (reconfirm), so later replies were told "the question is already open" (`official.js answeredNote`, `familyState.pending`) and it was never asked.
- `care.js`: the open question dropped after two non-answers (`scamUnclear`, `left`) or 20 minutes (`SCAM_ASK_MS`). With nothing pending, `call.js careNotes` took "please let my family know" as the generic `familyAsk` and Spark said "Done".
What it does now:
- `care.scamAsk(..., {asked})`: the question is registered ASKED only if her reply really put it (`care.asksFamilyQ`); otherwise it is OWED and the next reply is told to ask it (`scam-family-owed`). Every reply is scanned (`care.scamAskedOut`).
- It stays open 24 h (`SCAM_OPEN_MS`); unclear answers no longer drop it. A yes counts only while FRESH (asked < 15 min ago and < 2 non-answers). Otherwise `scam-resume`: she restates the worry (topic only) and asks again; the generic family note is NOT sent.
- After 24 h an unanswered incident is remembered (`care.scamLost`, 7 days): a yes / "let my family know" gets `scam-lost` (plain "I lost that set-up", asks what happened), nothing is sent until the answer.
- Chat retry: if Spark skips a required question twice, a plain question closes her reply (`chat.js`, labels setrem-* and scam-*).
- `FAMILY_CLAIM` also blocks "I'm letting your family know now" when nothing was sent. Chat sessions now carry `scamAt`, so "okay" after a scam talk is not read as a health emergency.
- Unchanged: the detector (`scam.js`), the held-out numbers (37/38 warned, S114 cautioned, 0/38 false), false-yes protection (`saysYesToFamily`), "a no covers the incident" (`care.scamDeclined`), topic-only family text, voice / push / WhatsApp / reminders.

## Second round (car prize call, conversation, numbers) - local, not pushed
Live bugs at 97f808b: (1) a stranger's car-prize call with no payment demand never asked the family question; (2) replies were generic, no relevant question, "settled / good" closure while a worry was open; abilities answers were short.
Causes in code:
- The detector returned `caution` (one sign) for the prize call; only warn / pause registered the family question (`chat.js afterTalkReply`, `scam.js talkNote` told her NOT to ask). Number-only follow-ups are not re-checked.
- `call.js ABILITIES_ASK` matched only "you" (not "u") and had no follow-up ("and?"), so the nine-item list never fired. `beat.js` closed light chat after 3 replies with "no question", also on "okay" / "hmm" while something was open.
Changes: `scam.promote` (live pipeline only; stubs untouched) treats a one-sign verdict that names a kind as a warning, so every warn path (owed question, notes, official reconfirm) applies; the detector and held-out numbers are unchanged (checked: S114 has no kind, so nothing in the held-out run is promoted, 0 normal items were cautioned). A warning turn must itself ask the family question (rewritten once, then the plain question closes the reply); both-drafts-blocked now ends in the plain question instead of an error. `call.js unresolvedTalk` (open scam question, or a heavy feeling in her last reply) turns the beat limits off and drops the "close gently" note. New chat note UNDERSTAND THEM (context, care in one line, one relevant question, no closure on okay / hmm). Abilities: "u"/"ya", "and?" / "what else" follow-ups (`abilitiesAsks`). `phone.js`: static country-code table; a number with + / 00 gets the country and "the number shown can be faked", never a lookup, never stored (chat, photo and PDF text, and calls via `limitsFacts`).

## Third round (reminder card stays on screen) - local, not pushed
Live report: Open / Got it did nothing visible, the card stayed, the family dashboard showed Seen. Could NOT be reproduced with one tab (real mouse events, desktop and phone width, real mode, the exact chat flow): the card closed. Reproduced with the senior page open in TWO tabs: Got it in one reported Seen and left the other tab's card up (the server never told the other page). Fix: `care.markNotif` pushes `noticeSeen` to every open page of that senior; `public/inbox.js` drops the card on it, removes the clicked card by element at once, shows a short "Done. Marked as seen" line, ignores a replay of an answered notice (no second Seen); Open shows the reminder in the chat (`maya-show-reminder` in `chat-ui.js`). Family dashboard logic unchanged.

## Proof status (needs Render + phone)
- Scam fixes: proven locally with real Spark (fresh seniors); NOT yet live.
- Voice latency (06530d2), closed Android push, WhatsApp template + Got it: NOT PROVEN until the user's live tests (steps were given in the chat).
- Open app follow-ups: Flutter menu "No time set" for a sent reminder; no "both" channel text. Voice-call reminder path unchanged (written chat only).
- Parked until after submission: yellow/red sound escalation, calling the family if a flag is not noticed.

## Where things are
`chat.js` (written chat, scam / reminder notes), `call.js` (voice call, shared `careNotes`), `care.js` (reminders, alerts, scam incident state), `setrem.js` (reminders by talking), `scam.js` / `official.js` / `web.js` (scam checks), `public/` (web), `app/` (Flutter). Docs: `README.md`, `docs/meta-models.md` (generated by `eval/page.js`), `docs/scam-results.md`.
