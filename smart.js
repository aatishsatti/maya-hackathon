// Code decides what Spark sees each turn and checks what comes back. Spark is the wording layer; this file owns the decisions. No model call is made here. Nothing here adds a feature,
// a surface or a scam type: it routes, reminds, decides from signals the V1 detector (scam.js, UNCHANGED, still the first gate) already produces, and checks drafts.
// A miss by the V1 detector cannot be rescued here: with no scam turn there is no decision to make (only the topic card, the abilities facts and the draft guards still apply).
//
// Flags (read on every call, so a bad layer is switched off by an env change and a restart, no code deploy). All OFF unless set; OFF = byte-identical to 47d321c.
//   MAYA_SMART=on            turns every layer on;  MAYA_SMART_<LAYER>=off|on overrides one.   LAYERS: ROUTER, ABILITIES, DECISION, CARDS, GUARD, KINDS.
//   ROUTER    intent per message (scam / reminder / ability / health / small talk / follow-up) + a topic-switch fact, so she follows the NEW subject.
//   ABILITIES one short fact per ability that really exists in code (and a "cannot" fact for what does not), only when that ability comes up.
//   DECISION  signals -> Warning / Caution / Not sure / Nothing-unusual-so-far, made here; unknown, unanswered or a failed check can never be Nothing-unusual.
//   CARDS     a one-line STATE card (kind, asked, contact, questions, next missing fact, consent read-only) and a RECORD card (what really ran this turn).
//   GUARD     a draft is rewritten once (then a plain safe line) if it says "verified safe" / "100% scam", invents a link or a number, or claims "I checked / called / told" with no record.
//   KINDS     for a scam turn only: what the real thing does and the common traps, for the kind named (data below; PROPOSED anchors, human check pending; no numbers, links or routes).
'use strict';

const flag = (layer) => { const v = process.env[`MAYA_SMART_${layer}`]; return v === 'on' || (process.env.MAYA_SMART === 'on' && v !== 'off'); };

// ---------------------------------------------------------------- 1. intent router
const HEALTH = /\b(pain|hurts?|aching|dizzy|chest|breath(?:ing|less)?|fell|fall(?:en)?|fever|bleed(?:ing)?|unwell|nauseous|hospital|ambulance|can'?t sleep)\b/i;
const REMIND = /\bremind(?:er|ers|ing)?\b|\btimer\b|\balarm\b|\btell me in \d+|\bin \d+ (?:minutes?|hours?)\b/i;
const ABILITY_Q = /\b(?:can|could|do|are|will)\s+(?:you|u|maya)\b[^?.!]{0,40}\b(?:photo|picture|screenshot|pdf|letter|call|ring|phone|remind|search|look up|check|read|book|order|buy|pay|send|text|message|voice|speak|language|help|tell|let|talk)\b|\bwhat\s+(?:can|could)\s+(?:you|u)\s+do\b|\bare you able\b/i;
const ACK = /^(?:ok(?:ay)?|oky|yes|yeah|yep|no|nope|hmm+|and\??|so\??|what about (?:it|that)\??|really\??|why\??|how\??|go on|thanks?|thank you)$/i;
const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);

function intent(heard, s) {
  const t = String(heard || '').trim();
  if (!t) return 'followup';
  const scam = require('./scam'), id = s && s.profile && s.profile.id, care = require('./care');
  const openScam = Boolean(id && (care.scamPending(id) || (s._smart && s._smart.topic === 'scam')));
  if (HEALTH.test(t) && !scam.needsCheck(t)) return 'health';
  const pend = require('./setrem').pending(id) && !scam.needsCheck(t);   // an open set-up is answered by short words; a scam story is a new subject
  if (REMIND.test(t) || pend) return !pend && !require('./setrem').isRequest(t) && ABILITY_Q.test(t) ? 'ability' : 'reminder';   // "do you set reminders?" is a question about her; "remind me at noon ..." is a request
  if (scam.needsCheck(t)) return 'scam';
  if (ABILITY_Q.test(t)) return 'ability';
  if ((words(t).length <= 4 && ACK.test(t.replace(/[.!,]+$/g, ''))) || (openScam && words(t).length <= 6)) return 'followup';
  return 'smalltalk';
}

// ---------------------------------------------------------------- 2. abilities that really exist (each line is true in code today), and what she cannot do
const CAN = [
  [/\b(?:photo|picture|screenshot|image)\b/i, 'photo', 'ABILITY (photo): in the written chat in the app they can send a photo or screenshot of a letter, message or page; you read it and say if it looks like a scam. You cannot look at a photo on a voice call.'],
  [/\bpdf\b/i, 'pdf', 'ABILITY (PDF): in the written chat they can send a PDF; you read its text and say if anything looks like a scam. Not on a voice call.'],
  [/\b(?:remind(?:er|ers|ing)?|timers?|alarms?)\b/i, 'reminder', 'ABILITY (reminders): you set reminders yourself, from one minute away to days ahead, by text, voice note or a call; you say it is set only after the app saved it.'],
  [/\b(?:call|ring|phone|talk|speak|voice)\b/i, 'call', 'ABILITY (voice): they can talk to you live by voice: the phone button at the top right of the chat in the app. You cannot phone other people for them.'],
  [/\b(?:search|look up|google|news|check (?:if|whether|this|that))\b/i, 'web', 'ABILITY (checking): in the written chat you can check a claim or news on the web; if the search fails you say you could not check it. On a voice call you cannot search the web yet.'],
  [/\b(?:family|son|daughter|let .{0,12}know|tell .{0,12}(?:family|son|daughter))\b/i, 'family', 'ABILITY (family): when they ask, the app can send their family a short note, or an alert about a possible scam (topic only, never their words). You never do it without their yes.'],
  [/\b(?:schedule|timetable|routine|appointments?)\b/i, 'schedule', 'ABILITY (schedule): they can tell you a schedule and you offer to turn parts of it into reminders; only the ones they say yes to are set.'],
];
const CANNOT = /\b(?:(?:call|phone|ring)\s+(?:my|the)\s+(?:son|daughter|doctor|police|ambulance|bank|friend|wife|husband|brother|sister)|book|order|buy|purchase|pay for|transfer|send money|navigate|directions|play (?:music|a song|a video)|video call|translate (?:a )?(?:document|book)|order (?:food|a taxi|a cab))\b/i;
const NOT_ABLE = 'ABILITY (not available): you cannot do that (you cannot buy, book, pay, move money, play media or phone other people). Say so plainly in one sentence, and offer one thing you really can do: chat, a reminder, checking a message or photo for a scam, or a note to their family.';

// ---------------------------------------------------------------- 7. kinds + what the real thing does + common traps. PROPOSED anchors (Astra), human check pending. Never a number, a link or a report route.
const KINDS = [
  ['bank', /\b(bank|card|account|pin|otp|one.?time (?:code|password)|debit|credit|upi|netbanking)\b/i, 'A real bank does not ask for your PIN, full password or one-time code, even on a call it started. Typing your own PIN into a card machine or the official app is not telling it to someone. To check: use the bank\'s app, the number on your card, or a branch; a caller ID or someone at the door is not proof. Do not say banks never phone.'],
  ['tax', /\b(tax|hmrc|irs|cra|refund|revenue|income tax)\b/i, 'A real tax office does not demand gift cards, crypto or payment within minutes, and does not threaten arrest by phone. Check through the agency\'s own official site or the contact on its letters. Real notices and refunds exist, so do not say every refund is fake; agencies in different countries work differently.'],
  ['lottery', /\b(lottery|prize|won|winner|jackpot|lucky draw|sweepstake)\b/i, 'A real prize never asks you to pay a fee to release it, and you can only win something you entered. Check who runs it and whether you entered. Do not say every prize is fake.'],
  ['airline', /\b(airline|flight|ticket|booking|rebook|airport|baggage)\b/i, 'A real rebooking appears in the airline\'s own app or on your ticket. A phone number from a search ad can be fake, and a caller who knows your booking is not proof. Fees can be real, so check them in the booking, not on the call.'],
  ['police', /\b(police|court|arrest|warrant|investigator|cbi|fbi|custom)\b/i, 'A real police or court process does not ask you to move your savings to a "safe account" or hand money to an investigator on the phone. Police do sometimes phone, so check through the station using a number you find yourself.'],
  ['tech', /\b(tech support|virus|computer|microsoft|windows|remote access|anydesk|teamviewer|pop.?up|infected|router|wifi)\b/i, 'Ask who contacted whom. If they called you, or a pop-up or search ad gave the number, take care; a number from an ad is not proof of the company. Remote access plus a payment request is the main risk, but not every remote helper is a fraud.'],
  ['relative', /\b(grandson|granddaughter|grandchild|son|daughter|nephew|niece|relative)\b.*\b(trouble|jail|accident|hospital|bail|money|help)\b|\b(trouble|jail|accident|bail)\b.*\b(grandson|granddaughter|son|daughter)\b/i, 'Reach the relative on a number you already have. Secrecy and a request for money are separate warning signs from urgency. A familiar voice is not proof, since voices can be copied, and an urgent message alone is not a scam.'],
  ['investment', /\b(invest|investment|crypto|bitcoin|trading|returns?|profit|forex|shares?|stock)\b/i, 'Check yourself whether the firm is registered with your country\'s regulator, who contacted whom, the fees and how you would withdraw. Being registered, a small first payout or a real company\'s name is not proof of safety.'],
];
const kindOf = (typeText, heard) => { const t = `${typeText || ''} ${heard || ''}`; const k = KINDS.find(([, re]) => re.test(t)); return k ? { name: k[0], rules: k[2] } : null; };

// ---------------------------------------------------------------- 3. the questions a real person would ask, one per turn, three per incident at most; code picks, Spark words it
const QUESTIONS = [
  ['contact', 'did they contact you first, or did you contact them?'],
  ['source', 'where did the number or link come from: the official app or your card, or an ad or a message?'],
  ['ask', 'what exactly did they ask you to do or send?'],
  ['check', 'have you been able to double-check with the real company or someone you trust?'],
];
const KNOWS = { contact: /\b(?:called|rang|phoned|messaged|texted|emailed|contacted|came to)\s+(?:me|us)\b|\bi (?:called|rang|phoned|clicked|searched|found)\b/i, source: /\b(?:google|ad|advert|app|card|website|link|search)\b/i, ask: /\b(?:asked|wants?|wanted|told me to|send|pay|give|share|install|download)\b/i, check: /\b(?:checked|double.?checked|called the bank|asked my (?:son|daughter|family))\b/i };

// ---------------------------------------------------------------- state per session
// "They said do not tell anyone": the CALLER's instruction, not the senior refusing to tell their family. Speaker attribution for the consent reader (call.js careNotes, ROUTER flag).
const attributedToOther = (t) => /\b(?:they|he|she|the (?:man|woman|lady|caller|person|officer)|someone|that (?:man|person))\s+(?:said|says|told|asked|wants?|keeps?|insists?)\b|\b(?:told|asked|warned) me\b/i.test(String(t || ''));

function st(s) { return s._smart || (s._smart = { topic: null, kind: null, incident: null, asked: [], known: {}, contact: null, disclosed: false, prev: null }); }

// ---------------------------------------------------------------- 4. decision from signals (made here, not by Spark's mood)
// scam: the V1 / Spark-reading result { level, type, signals, reading } or null; ctx: { failed, needed, heard }.
function decide(scam, { failed = false, needed = false, heard = '' } = {}) {
  if (failed) return { label: 'Not sure', why: 'the check failed' };
  if (!scam) return needed ? { label: 'Not sure', why: 'nothing was checked' } : null;
  if (scam.level === 'warn' || scam.level === 'pause') return { label: 'Warning' };
  if (scam.level === 'caution') return { label: 'Caution' };
  // none: "Nothing unusual found so far" needs an actual reading and enough said; unknown, short or unanswered is Not sure, never safe
  if (needed && scam.reading && words(heard).length >= 8) return { label: 'Nothing unusual so far' };
  return { label: 'Not sure', why: 'too little to go on' };
}

function nextQuestion(s, heard) {
  const x = st(s);
  for (const [k] of QUESTIONS) if (!x.known[k] && KNOWS[k].test(heard || '')) x.known[k] = true;
  if (/\b(?:called|rang|phoned|messaged|texted|emailed|contacted|came to|knocked)\s+(?:me|us)\b|\b(?:someone|a man|a woman|a lady|they|he|she)\s+(?:called|rang|phoned|messaged|texted|emailed)\b/i.test(heard || '')) x.contact = 'they contacted the senior';
  else if (/\bi (?:called|rang|phoned|clicked|searched|found|googled)\b/i.test(heard || '')) x.contact = 'the senior contacted them';
  if (x.asked.length >= 3) return null;
  const q = QUESTIONS.find(([k]) => !x.known[k] && !x.asked.includes(k));
  return q || null;
}

function consent(s) {
  const care = require('./care'), id = s.profile && s.profile.id; if (!id) return 'unknown';
  const p = care.scamPending(id);
  return care.scamTold(id) ? 'family already told (topic only)' : p && care.scamDeclined(id, p.type) ? 'they said no (yellow flag only, never ask again)' : p ? 'question to the family is open' : 'no family question open';
}

// ---------------------------------------------------------------- the notes for one turn: [[label, text], ...]
function notes(s, heard) {
  const out = [];
  if (!(flag('ROUTER') || flag('ABILITIES') || flag('DECISION') || flag('CARDS') || flag('KINDS'))) return out;
  const sc = s._scam;   // set by chat.js for this turn: { scam, failed, needed }
  const x = st(s); let it = intent(heard, s); const old = x.topic;
  // "Can you check a photo of a letter?" is a question about her, not a scam story: it stays an ability question unless the V1 detector itself flagged it.
  if (it === 'scam' && ABILITY_Q.test(heard) && /^(?:can|could|do|are|will|what)\b/i.test(String(heard).trim()) && !(sc && sc.scam && sc.scam.level && sc.scam.level !== 'none')) it = 'ability';
  const switched = old && old !== 'smalltalk' && it !== old && it !== 'followup' && !(old === 'scam' && it === 'smalltalk' && words(heard).length <= 6) || (old === 'scam' && it === 'smalltalk' && words(heard).length > 6);
  if (flag('ROUTER') && switched) out.push(['smart-switch', `TOPIC CHANGE: they have moved on from ${old} to ${it === 'smalltalk' ? 'something else' : it}. Answer what they just said first, and stay on it. Do not go back to ${old} unless they do${old === 'scam' ? '; the only exception is a family question that is still open, which you may repeat once, in one short sentence at the end' : ''}. (Any other FACT in this message still applies.)`]);
  if (it !== 'followup') x.topic = it;
  if (it !== 'scam' && switched && old === 'scam') { x.kind = null; x.incident = null; x.asked = []; x.known = {}; x.disclosed = false; }
  if (flag('ABILITIES') && it === 'ability') {
    const hit = CAN.filter(([re]) => re.test(heard)).slice(0, 2);
    const chat = s.channel === 'chat';
    if (CANNOT.test(heard)) out.push(['smart-ability-no', NOT_ABLE]);
    else if (hit.length) for (const [, k, text] of hit) out.push([`smart-ability-${k}`, text]);
    else if (it === 'ability' && chat !== undefined) out.push(['smart-ability-general', 'ABILITY: you can chat, set reminders yourself, check a message, photo or PDF for a scam (written chat), check a claim on the web (written chat), and send their family a short note when they ask. Say only what fits what they asked, and never claim an ability not listed here.']);
  }
  if (it === 'scam' || (it !== 'ability' && sc && sc.needed)) {
    if (flag('KINDS')) {
      const k = kindOf(sc && sc.scam && sc.scam.type, heard) || (x.kind && KINDS.find((q) => q[0] === x.kind) && { name: x.kind, rules: KINDS.find((q) => q[0] === x.kind)[2] });
      if (k) { x.kind = k.name; out.push(['smart-kind', `KIND (${k.name}) - what the real thing does, for you to rely on (do not read it out as written): ${k.rules}`]); }
    }
    let d = null;
    if (flag('DECISION')) {
      d = decide(sc && sc.scam, { failed: sc && sc.failed, needed: Boolean(sc && sc.needed) || it === 'scam', heard });
      if (d) {
        const nq0 = nextQuestion(s, heard);   // also learns from what they said, on every scam turn
        const nq = d.label === 'Warning' ? null : nq0;
        const body = { 'Warning': 'WARNING. Your FIRST sentence must say plainly that this looks like a possible scam and why, from the signs (then do not pay or share anything). Never "definitely" or "100%".', 'Caution': 'CAUTION. Name ONE thing to double-check; do not call it a scam.', 'Not sure': `NOT SURE (${d.why}). Say honestly you cannot tell yet. Do not say it is safe or that it is a scam.`, 'Nothing unusual so far': 'NOTHING UNUSUAL FOUND SO FAR. You may say nothing unusual stands out in what they have told you so far. Never say safe, verified, legit or genuine.' }[d.label];
        let t = `DECISION (made by the app from the signals, not by you): ${body}`;
        if (nq) { x.asked.push(nq[0]); t += ` Ask ONE short question in your own words, only this: ${nq[1]}`; }
        if (!x.disclosed && d.label !== 'Warning') { x.disclosed = true; t += ' Say once that you can make mistakes and the choice is theirs.'; }
        else if (!x.disclosed) { x.disclosed = true; t += ' Say once, briefly, that you can be wrong and the choice is theirs.'; }
        out.push(['smart-decision', t]);
      }
    }
    if (flag('CARDS')) {
      const sig = (sc && sc.scam && sc.scam.signals) || {};
      const asked = ['payment', 'secrecy', 'urgency', 'impersonation', 'money'].filter((k) => sig[k]);
      const unk = QUESTIONS.filter(([k]) => !x.known[k]).map(([k]) => k);
      const ACT = { payment: 'pay or send details', secrecy: 'keep it secret', urgency: 'act now', impersonation: 'trust a claimed authority', money: 'money out of the blue' };
      out.push(['smart-state', `STATE: topic=scam; incident=${x.kind || 'unclear'}#1; kind=${x.kind || 'not clear'}; requested action=${asked.map((k) => ACT[k]).join(', ') || 'none seen yet'}; who contacted whom=${x.contact || 'unknown'}; everything the senior says about the other side is REPORTED by the senior, not verified (say "you say they...", never state it as fact); answered=${Object.keys(x.known).filter((k) => x.known[k]).join(',') || 'none'}; questions asked ${x.asked.length}/3; next missing fact=${(QUESTIONS.find(([k]) => !x.known[k] && !x.asked.includes(k)) || [])[0] || 'none'}; family consent (read-only, never change, announce or guess it): ${consent(s)}.`]);
      out.push(['smart-contract', 'OUTPUT CONTRACT: short; say what you see, what you are unsure of, and ONE next question or check; one worry, one step. Keep who said what, keep "not/never/didn\'t" exactly as said, and keep past apart from now. Answering the caller\'s questions is NOT a yes to you or to telling their family; only their answer to YOUR family question counts, and the app decides what is sent.']);
    }
  }
  const claimy = /\b(?:did|have|had)\s+you\b[^?.!]{0,30}\b(?:check|call|ring|tell|told|send|sent|look|search|verif)/i.test(heard) || it === 'scam';
  if (flag('CARDS') && s._exec && claimy) {
    const e = s._exec;
    out.push(['smart-record', `RECORD (what really happened this turn; claim nothing that is "no"): family alert/note sent by the app: ${e.family ? 'yes' : 'no'}; web check: ${e.web || 'not run'}; message/photo scam check: ${e.scam || 'not run'}; reminder saved: ${e.reminder ? 'yes' : 'no'}. You never phoned anyone for them.`]);
  }
  return out;
}

// What the audit shows for a session: asked, learned, checked, still unknown (names only, never the senior's words).
function trace(s) {
  const x = st(s), sc = s._scam || {}, e = s._exec || {};
  return { asked: [...x.asked], learned: Object.keys(x.known).filter((k) => x.known[k]).concat(x.contact ? ['contact'] : []), checked: [sc.scam ? 'scam check ran' : sc.failed ? 'scam check FAILED' : 'scam check not run', e.web === 'ran' ? 'web check ran' : 'web check not run'], unknown: QUESTIONS.map(([k]) => k).filter((k) => !x.known[k]) };
}

// ---------------------------------------------------------------- 5/6. draft guard
const SAFE_CLAIM = /\bverified(?:\s+as)?\s+(?:safe|legit|genuine|real)\b|\b(?:100|a hundred)\s?%\s*(?:a\s+)?(?:scam|safe|sure|certain|genuine|legit)\b|\bdefinitely\s+(?:a\s+)?(?:scam|safe|fake|genuine|legit)\b|\b(?:completely|totally|absolutely|perfectly)\s+(?:safe|legit|genuine|fine to)\b|\b(?:it|this|that)\s*(?:is|'s)\s+(?:safe|legit|legitimate|genuine|a real)\b(?!\s+to ask)|\bguarantee/i;
const URL_ = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9][a-z0-9-]{1,}\.(?:com|org|net|gov|edu|co|in|uk|au|ca|io|info|xyz)\b/i;
const PHONE_ = /(?:\+?\d[\s().-]*){8,}/;
const digits = (t) => String(t || '').replace(/\D+/g, '');
const CLAIM = [
  [/\bI(?:'ve| have| just)?\s+(?:looked (?:it )?up|searched|googled)\b/i, (e) => e.web === 'ran'],
  [/\bI(?:'ve| have| just)?\s+(?:checked|verified|confirmed)\b/i, (e) => e.web === 'ran' || e.scam === 'ran'],
  [/\bI(?:'ve| have| just)?\s+(?:called|rang|phoned|contacted|emailed|messaged)\s+(?!you\b)/i, () => false],
  [/\bI(?:'ve| have| just)?\s+(?:notified|alerted|told|informed|sent)\s+(?:your\s+)?(?:family|son|daughter|them|the bank|the police)\b/i, (e) => Boolean(e.family)],
];
// Returns a reason string when the draft must be written again, else null. rec = s._exec (what really ran); known = the text the facts and the senior gave (a link or number must already be in it).
function breaks(text, s) {
  if (!flag('GUARD')) return null;
  const t = String(text || '').replace(/’/g, "'");
  if (SAFE_CLAIM.test(t) && !/\bnot\s+(?:100|a hundred|safe|verified)|\bn't\s+(?:safe|verified)|\bcan'?t\s+(?:say|be)\b[^.]{0,30}\b(?:safe|sure)/i.test(t)) return 'certainty';
  const known = `${s.lastHeard ? s.lastHeard() : ''} ${s._knownText || ''}`;
  const u = URL_.exec(t); if (u && !known.toLowerCase().includes(u[0].toLowerCase().replace(/[.,!?)]+$/, ''))) return 'link';
  const p = PHONE_.exec(t); if (p && !digits(known).includes(digits(p[0]))) return 'number';
  const e = s._exec || {};
  for (const [re, ok] of CLAIM) if (re.test(t) && !ok(e)) return 'claim';
  return null;
}

// The line a person sees when both drafts were blocked: plain, true, asks one thing. Never a faked answer, never the bad draft.
function fallback(s) {
  const x = st(s);
  return x.topic === 'scam' || (s._scam && s._scam.needed)
    ? "I can't be sure about this one, and I can make mistakes. Please don't pay or share anything until you've checked with your family or the real company, using a number or app you already trust. What did they ask you for?"
    : 'I want to get this right. Could you tell me a little more about what you mean?';
}

module.exports = { attributedToOther, trace, flag, intent, notes, decide, nextQuestion, breaks, fallback, kindOf, KINDS, CAN, QUESTIONS };
