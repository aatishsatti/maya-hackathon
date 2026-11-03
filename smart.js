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
//   SHORT     first ability answer: at most 2 sentences, 3 things, one question (the full list only on "more / all"); every turn one question; a long dump or two questions is rewritten once, then a plain line.
//   CONTRACT  a short reply-shape line on every non-scam turn (what you see, what you are unsure of, ONE next step; keep who said what and every "not").
//   CAPS      the RECORD card on ability / reminder / "did you ..." turns too: tools available / unavailable here, and what really ran, failed or did not run.
//   MEMORY    one THREAD line each turn (topic, what she last asked and whether it was answered, questions already asked, kept across sessions); a repeated question is rewritten once.
//   GENERAL   a verification question on any topic ("is it safe", "is it true") is Not sure unless a check really ran; never safe, verified or guaranteed.
//   COMPANION friend, not tool: the first abilities answer is 2 sentences with 1-2 relevant examples (a question only if it helps); "more" gives a DIFFERENT category, never the same chunk or the full list ("all" still does); calls are offered only when ringing them is possible
//             and never as "scheduled" without a record; a style fact for small talk (respond first, a question is optional); the 14-day question memory covers answered INTRODUCTORY questions only; a brushed-off topic is not raised by her for 30 days (never
//             ignored when THEY raise it); "stop calling me" is kept until they ask for calls again (no expiry). Nothing here touches scam, consent or safety turns.
//   KINDS     for a scam turn only: what the real thing does and the common traps, for the kind named (data below; PROPOSED anchors, human check pending; no numbers, links or routes).
'use strict';

const LAYERS_ALL = ['ROUTER', 'ABILITIES', 'DECISION', 'CARDS', 'GUARD', 'KINDS', 'SHORT', 'CONTRACT', 'CAPS', 'MEMORY', 'GENERAL', 'COMPANION'];
const any = () => LAYERS_ALL.some((l) => flag(l)) || STATE_LAYERS.some((l) => stateFlag(l));
// STATE flags (the senior's own state card, its draft check and the daily-call decisions: state.js / social.js). INDEPENDENT of the scam layers above: their own env names, default OFF, and they
// ignore MAYA_SMART (the scam master switch). A scam flag never turns a state layer on, and a state flag never turns a scam layer on.
//   MAYA_SMART_STATE_CARDS=on      the APP STATE card on every turn          (scam CARDS stays MAYA_SMART_CARDS)
//   MAYA_SMART_STATE_GUARD=on      factual check of drafts against the state card (scam GUARD stays MAYA_SMART_GUARD)
//   MAYA_SMART_STATE_DECISION=on   add / replace / second call / weekday / re-set / fresh-consent decisions (scam DECISION stays MAYA_SMART_DECISION)
const STATE_LAYERS = ['CARDS', 'GUARD', 'DECISION'];
const stateFlag = (layer) => process.env[`MAYA_SMART_STATE_${layer}`] === 'on';
const flag = (layer) => { const v = process.env[`MAYA_SMART_${layer}`]; return v === 'on' || (process.env.MAYA_SMART === 'on' && v !== 'off'); };

// ---------------------------------------------------------------- 1. intent router
const HEALTH = /\b(pain|hurts?|aching|dizzy|chest|breath(?:ing|less)?|fell|fall(?:en)?|fever|bleed(?:ing)?|unwell|nauseous|hospital|ambulance|can'?t sleep)\b/i;
const REMIND = /\bremind(?:er|ers|ing)?\b|\btimer\b|\balarm\b|\btell me in \d+|\bin \d+ (?:minutes?|hours?)\b/i;
const ABILITY_Q = /\b(?:can|could|do|are|will)\s+(?:you|u|maya)\b[^?.!]{0,40}\b(?:photo|picture|screenshot|pdf|letter|call|ring|phone|remind|search|look up|check|read|book|order|buy|pay|send|text|message|voice|speak|language|help|tell|let|talk)\b|\bwhat\s+(?:can|could)\s+(?:you|u)\s+do\b|\bare you able\b/i;
const ACK = /^(?:ok(?:ay)?|oky|yes|yeah|yep|no|nope|hmm+|and\??|so\??|more|all|everything|tell me more|what else|anything else|what about (?:it|that)\??|really\??|why\??|how\??|go on|thanks?|thank you)$/i;
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

// ---------------------------------------------------------------- short ceiling (SHORT)
const WANTS_ALL = /\b(?:all|everything|every ?thing|full list|the whole|in full|more|and\?|what else|anything else|go on)\b/i;
const wantsAll = (t) => WANTS_ALL.test(String(t || ''));
const ABILITY_SHORT = ' ABILITIES (facts for you, never read out as written): they have just asked what you can do. Reply in AT MOST TWO short sentences: name at most THREE things, picked for what fits this chat and said in your own fresh words, then ask ONE short question about what they would like. Do not list more than three; if they want everything they will say "more" or "all". Only real things: talking by voice or writing, setting reminders yourself, checking a message, photo or PDF for a scam (the written chat), and telling their family when they ask. Never a stock sentence.';
const CATS = [['talk', /\b(?:voice|talk|chat|speak|company|conversation)\b/i], ['remind', /\bremind/i], ['scam', /\b(?:scam|photo|screenshot|pdf)\b/i], ['web', /\b(?:news|search|look(?:ing)? up|the web)\b/i], ['family', /\bfamily\b/i], ['schedule', /\bschedule\b/i], ['call', /\b(?:call|ring|phone) you\b/i]];
const ABILITY_COMPANION = ' ABILITIES (facts for you, never read out as written): they asked what you can do. You are a friend to them, not a menu. Answer in AT MOST TWO short sentences with ONE or TWO things that fit what they are doing or what you know of them, in your own fresh words. Do not list everything and do not count them off; a question only if it truly helps (often none). If they want more they will ask. Only real things (below).';
const POOL = [['talk', 'chatting by voice or in writing, any time'], ['remind', 'setting reminders yourself, from a minute away to days ahead'], ['scam', 'looking at a message, photo or PDF that worries them and saying if it looks like a scam (the written chat)'], ['family', 'letting their family know when they ask'], ['schedule', 'turning a schedule they tell you into reminders they choose'], ['call', 'helping them arrange a call from you as a reminder'], ['web', 'checking a claim or news on the web (the written chat)']];
// What is really available now: ringing needs the app open or a registered phone; it is gone while they have told her to stop calling.
function callsOk(s) { const care = require('./care'), id = s.profile && s.profile.id; const p = id && care.get(id); if (p && p.smart && p.smart.noCalls) return false; return Boolean(id && (care.appOpen(id) || care.pushReady(id))); }
function availPool(s) { const chat = s.channel === 'chat'; return POOL.filter(([k]) => (k === 'call' ? callsOk(s) : (k === 'scam' || k === 'web') ? chat : true)); }
function abilityFact(s, text, nAsk) {
  const sh = flag('SHORT'), co = flag('COMPANION'); if (!(sh || co) || !nAsk) return null;
  const x = st(s), all = /\b(?:all|everything|every ?thing|full list|the whole|in full)\b/i.test(String(text || ''));
  if (all) return null;   // an explicit "all": the full list, as before
  if (co && nAsk >= 2) {
    const said = new Set(x.abilitySaid || []), left = availPool(s).filter(([k]) => !said.has(k));
    s._abilityMode = { first: false, max: 2, avoid: [...said] };
    return { first: false, text: left.length ? ` ABILITIES (facts for you, never read out as written): they want to hear more. Tell them about ONE other thing, in at most two short sentences and your own words, from ONLY these: ${left.map(([, w]) => w).join('; ')}. Do NOT repeat anything you already told them (${[...said].join(', ') || 'nothing yet'}) and do not list them all.` : ' ABILITIES (facts for you): you have already told them the main things. Say so lightly in one short sentence and ask what they would like, without listing again.' };
  }
  if (nAsk === 1 && !wantsAll(text)) {
    if (co) { s._abilityMode = { first: true, max: 2, avoid: [] }; return { first: true, text: ABILITY_COMPANION.trim() + ` Real things you can mention: ${availPool(s).map(([, w]) => w).join('; ')}. ${callsOk(s) ? '' : 'Do NOT offer to call or ring them.'}` }; }
    s._abilityMode = { first: true, max: 3, avoid: [] }; return { first: true, text: ABILITY_SHORT.trim() };
  }
  return null;
}
const ABILITY_FALLBACK = 'I can chat with you, set reminders, and check a message for scams. What would you like help with?';
const STOP = new Set('that this with would could should have your you what when where which about there their they them then than from were been will just like some into also very much more'.split(' '));
const contentWords = (t) => [...new Set(String(t || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)))];
const overlap = (a, b) => { if (a.length < 3 || b.length < 3) return 0; const sb = new Set(b); return a.filter((w) => sb.has(w)).length / Math.min(a.length, b.length); };

const INTRO = /\b(?:hobbies|hobby|what do you (?:like|enjoy)(?: to do| doing)?|where do you live|how many (?:children|grandchildren|kids|grandkids)|tell me (?:a bit )?about yourself|what did you do (?:today|this morning|yesterday)|how (?:was|is) your day|what(?:'s| is) your (?:favou?rite|name)|do you have (?:any )?(?:children|grandchildren|pets|family|hobbies))\b/i;   // the INTRODUCTORY questions: asked and answered once, not asked again for 14 days (a relevant follow-up is never one of these)
const INTRO_KEYS = [['hobbies', /\bhobb(?:y|ies)\b|what do you (?:like|enjoy)(?: to do| doing)?|do you have any hobbies/i], ['home', /where do you live/i], ['kids', /how many (?:children|grandchildren|kids|grandkids)|do you have (?:any )?(?:children|grandchildren|family)/i], ['self', /tell me (?:a bit )?about yourself/i], ['today', /what did you do (?:today|this morning|yesterday)|how (?:was|is) your day/i], ['favourite', /what(?:'s| is) your (?:favou?rite|name)/i], ['pets', /do you have (?:any )?pets/i]];
const introKey = (q) => { const k = INTRO_KEYS.find(([, re]) => re.test(String(q || ''))); return k ? k[0] : ''; };
// ---------------------------------------------------------------- context memory (MEMORY): questions she asked, kept in the session and (content words + a short text) on the profile for 14 days
const DAY14 = 14 * 86400000;
function savedQs(s) { const care = require('./care'), id = s.profile && s.profile.id, p = id && care.get(id); return ((p && p.smart && p.smart.qs) || []).filter((q) => Date.now() - q.at < DAY14); }
function allQs(s) { const x = st(s); return [...savedQs(s), ...(x.qs || [])]; }
function afterReply(s, text) {
  const x = st(s);
  if (flag('COMPANION') && s.profile) require('./social').noteSpoken(s, text);   // a claim that slipped out: corrected on the next turn
  if (flag('COMPANION') && x.topic === 'ability') { x.abilitySaid = [...new Set([...(x.abilitySaid || []), ...CATS.filter(([, re]) => re.test(text)).map(([k]) => k)])]; }
  if (!flag('MEMORY')) return;
  const qs = String(text || '').split(/(?<=[.!?])\s+/).filter((q) => /\?\s*$/.test(q));
  if (!qs.length) { x.lastQ = null; return; }
  x.qs = x.qs || [];
  for (const q of qs) { const w = contentWords(q); if (w.length >= 3 || introKey(q)) x.qs.push({ w, t: q.replace(/\s+/g, ' ').slice(0, 90), at: Date.now(), intro: introKey(q), answered: false }); }
  x.lastQ = { t: qs[qs.length - 1].replace(/\s+/g, ' ').slice(0, 90), answered: false, entry: x.qs[x.qs.length - 1] };
  x.qs = x.qs.slice(-10);
  try { require('./care').persistSmart(s.profile.id, { qs: allQs(s).slice(-10).map(({ w, t, at, intro, answered }) => ({ w, t: t.slice(0, 60), at, intro: intro || '', answered: Boolean(answered) })) }); } catch { /* no profile: session memory only */ }
}
function threadLine(s, heard) {
  const x = st(s); if (x.lastQ && !x.lastQ.answered && words(heard).length >= 3 && !ACK.test(String(heard).trim().replace(/[.!,]+$/g, ''))) { x.lastQ.answered = true; if (x.lastQ.entry) x.lastQ.entry.answered = true; }
  const qs = allQs(s).slice(-6).map((q) => `"${q.t.replace(/"/g, '')}"`);
  if (!x.topic && !qs.length) return null;
  return `THREAD: topic=${x.topic || 'none'}; ${x.lastQ && !x.lastQ.answered ? `you last asked "${x.lastQ.t.replace(/"/g, '')}" and they have not answered it yet, so do not move on as if they had; ` : ''}questions you already asked (never ask the same thing again, in any wording): ${qs.join(' ') || 'none'}.`;
}

// ---------------------------------------------------------------- general decision (GENERAL): any "is it safe / true / ok" question
const VERIFY_Q = /\b(?:is (?:it|this|that) (?:true|safe|ok(?:ay)?|real|normal|fine|good for)|are (?:they|these) (?:safe|ok(?:ay)?)|should i (?:take|stop|eat|drink|stop taking)|can i (?:take|stop|eat|drink|mix)|is it (?:ok|okay|safe) to)\b/i;
function decideGeneral(heard, exec = {}) {
  if (!VERIFY_Q.test(String(heard || ''))) return null;
  if (exec.web === 'ran') return { label: 'Checked', why: 'a web check ran' };
  return { label: 'Not sure', why: exec.web === 'failed' ? 'the check failed' : 'nothing was checked' };
}

// ---------------------------------------------------------------- the controls they can say out loud (COMPANION): a brushed-off topic (30 days, only her own raising of it), "stop calling me" (kept until THEY ask again, no expiry)
const BRUSH = /\b(?:i (?:don'?t|do not) (?:want|wish) to (?:talk|discuss|speak) about|(?:let'?s|can we) (?:not talk about|drop|stop talking about)|drop it|not now|i'?d rather not|i would rather not|leave it)\b/i;
const NOCALLS = /\b(?:stop calling me|don'?t (?:ever )?call me|do not call me|no more calls|never call me)\b/i;
// Only an explicit permission lifts the stop at once (and it then ASKS about the restart). "Can you call me", "please call me", "call me at 1:26" are requests: they go to social.reconsent, which asks ONE question and needs a fresh yes.
const CALLS_PERMISSION = /\b(?:you can|it'?s (?:ok|okay|fine) (?:to|for you to)|go ahead and|start) call(?:ing)? me\b|\bcall me again\b/i;
const CALLS_BACK = /\b(?:you can|please|it'?s (?:ok|okay|fine) (?:to|for you to)|go ahead and|start) call(?:ing)? me\b|\bcall me again\b|\b(?:can|could|would) you (?:please )?call me\b|\bplease call me\b|\bcall me (?:tomorrow|later|at|every|daily)\b/i;
function ledger(s, heard) {
  const care = require('./care'), id = s.profile && s.profile.id, p = id && care.get(id); if (!p) return null;
  const sm = p.smart || {}; const x = st(s); const prev = x.prevHeard; x.prevHeard = heard;
  // "stop calling me" is NOT handled here any more: who it is aimed at is decided in social.stopTurn (roleplay / third person change nothing, ambiguity gets one scoped question).
  if (sm.noCalls && CALLS_PERMISSION.test(heard)) { care.persistSmart(id, { noCalls: null, callsRestored: { at: Date.now(), source: 'chat: the senior asked for calls again' } }); const q = require('./social').onCallsBack(id); return q ? `CALLS RESTORED: they have asked for calls again. ${q}` : 'CALLS RESTORED: they have asked for calls again. You may offer to arrange one.'; }
  if (BRUSH.test(heard) && (x.lastQ || prev)) { const w = contentWords(x.lastQ ? x.lastQ.t : prev); if (w.length >= 2) { care.persistSmart(id, { brush: [...(sm.brush || []).filter((b) => Date.now() - b.at < 30 * 86400000), { w, at: Date.now() }].slice(-6) }); return 'DROP IT: they do not want to talk about that. Say okay, lightly, and move on. Do not raise that topic yourself again; if THEY bring it up, talk about it normally.'; }
  }
  return null;
}

// ---------------------------------------------------------------- the notes for one turn: [[label, text], ...]
// The companion style fact (the ONLY fact on a routine smalltalk turn when no state flag is on). Exported so call.js can give a speculative guess the very same note (speculation reuse, call.js).
const STYLE_NOTE = 'YOU ARE their friend, not a tool, not a menu and never a romantic partner. Respond to what they just said first, warmly, in short fresh words (begin differently from your last replies). A question is optional, never more than ONE: when something they said invites it, ask the small question a friend would (gardening: what they grow), about every second or third reply, and otherwise answer with a warm short remark. No interview.';
const SHAPE_NOTE = 'REPLY SHAPE: at most two short sentences and at most ONE question, only when it helps (often none); say what you see, what you are unsure of, and one next step if there is one; keep who said what and every "not / never / didn\'t" exactly as said; past stays past.';

// The APP STATE card text WITHOUT side effects (appState() also stores s._card on the call): for a speculative guess only. Same builder, same renderer.
function appStateText(s) {
  const st_ = require('./state');
  try { return st_.render(st_.build(s.profile.id, { channel: s.channel === 'chat' ? 'chat' : 'call' })); }
  catch { return 'APP STATE: UNKNOWN (the app could not read it this turn). Say you cannot see their saved calls right now; never say they have none, and never say anything is saved or scheduled.'; }
}
// What notes() WOULD give an ordinary (smalltalk / follow-up) turn, built from the same constants and the same state builder, with NO side effects (no topic switch, no ledger, no social step, no s._card, no s._compact).
// Returns { labels, text } (text = the notes joined exactly as careNotes joins them), or null when the partial is not ordinary talk (ability, reminder, health, scam, a call word, safety, a pending set-up): then nothing is guessed.
// call.js reuses a guess ONLY if the final turn's own labels and text are identical to these, so a final turn never inherits older state.
const CALL_WORD = /\b(?:call|ring|phone)\b/i;
function guessNotes(s, heard) {
  if (!any()) return { labels: [], text: '' };
  if (s.safety || s.health || !s.profile || !s.profile.id) return null;
  // intent() calls care.scamPending(), which MOVES an expired pending-scam question to lostScam and saves it (a consent-state write). A guess must never write, so any scam context at all (open or lost) is a read-only "not ordinary" here.
  const pz = require('./care').get(s.profile.id);
  if (!pz || pz.pendingScam || pz.lostScam) return null;
  const it = intent(heard, s);
  if (it !== 'smalltalk' && it !== 'followup') return null;
  if (CALL_WORD.test(heard)) return null;
  const out = [];
  if (flag('COMPANION')) out.push(['smart-style', STYLE_NOTE]);
  if (stateFlag('CARDS')) out.push(['smart-app-state', appStateText(s)]);
  if (flag('CONTRACT')) out.push(['smart-shape', SHAPE_NOTE]);
  return { labels: out.map((o) => o[0]), text: out.map((o) => o[1]).join(' ') };
}
function notes(s, heard) {
  const out = [];
  if (!any()) return out;
  const sc = s._scam;   // set by chat.js for this turn: { scam, failed, needed }
  const x = st(s); let it = intent(heard, s); const old = x.topic;
  // "Can you check a photo of a letter?" is a question about her, not a scam story: it stays an ability question unless the V1 detector itself flagged it.
  if (it === 'scam' && ABILITY_Q.test(heard) && /^(?:can|could|do|are|will|what)\b/i.test(String(heard).trim()) && !(sc && sc.scam && sc.scam.level && sc.scam.level !== 'none')) it = 'ability';
  const switched = old && old !== 'smalltalk' && it !== old && it !== 'followup' && !(old === 'scam' && it === 'smalltalk' && words(heard).length <= 6) || (old === 'scam' && it === 'smalltalk' && words(heard).length > 6);
  if (flag('ROUTER') && switched) out.push(['smart-switch', `TOPIC CHANGE: they have moved on from ${old} to ${it === 'smalltalk' ? 'something else' : it}. Answer what they just said first, and stay on it. Do not go back to ${old} unless they do${old === 'scam' ? '; the only exception is a family question that is still open, which you may repeat once, in one short sentence at the end' : ''}. (Any other FACT in this message still applies.)`]);
  if (it !== 'followup') x.topic = it;
  if (it !== 'scam' && switched && old === 'scam') { x.kind = null; x.incident = null; x.asked = []; x.known = {}; x.disclosed = false; }
  if (flag('COMPANION') && s.profile && s.profile.id) { const sf = require('./social').stopTurn(s, s.profile.id, heard); if (sf) out.push(sf); }   // stop-calls targeting (provenance, scoped question)
  if (flag('COMPANION')) { const f = ledger(s, heard); if (f) out.push(['smart-ledger', f]); }
  if (flag('COMPANION') && (it === 'smalltalk' || it === 'followup') && !s.safety && !s.health) out.push(['smart-style', STYLE_NOTE]);
  if (flag('COMPANION') && (it === 'ability' || /\b(?:call|ring|phone)\b/i.test(heard))) out.push(['smart-calls', callsOk(s) ? 'CALLS: you can help ARRANGE a call from you when they ask (it is saved as a reminder). Arranging is not scheduled: say a call is scheduled ONLY when the RECORD below says reminder saved: yes.' : 'CALLS: do not offer or arrange a call from you (ringing them is not possible right now, or they told you to stop). If they ask, say so plainly and kindly.']);
  s._compact = false;
  let sched = false;
  try { const pz = s.profile && care_().get(s.profile.id), o = pz && pz.smart && pz.smart.social && pz.smart.social.offer; if (o && Date.now() - o.at < 20 * 60000) sched = !s.safety && !s.health; } catch { /* no state */ }   // a proposal is pending: this is a scheduling turn even when the words were only a fragment
  if (flag('COMPANION') && s.profile) { const sf = require('./social').step(s, heard, { intent: it, callsOk: callsOk(s), safe: !s.safety && !s.health && it !== 'scam' }); if (sf) { out.push(sf); sched = /^social-(?!offer)/.test(sf[0]) && !s.safety && !s.health && it !== 'scam'; } }   // the daily-call offer and its consent (social.js)
  if (stateFlag('CARDS') && s.profile && s.profile.id) { const c = appState(s, sched); if (c) out.push(['smart-app-state', c]); s._compact = Boolean(sched && c); }
  s._sched = Boolean(stateFlag('GUARD') && (sched || out.some(([l]) => /^social-/.test(l)) || (/\b(?:calls?|daily|ring)\b/i.test(heard) && (() => { try { return Boolean(care_().socialOf(s.profile.id)); } catch { return false; } })())));   // a SCHEDULING turn: the bounded-language check applies   // state.js: built AFTER the daily-call step so a save made this turn is already in it; id from the session, never from the chat
  if (flag('MEMORY')) { const tl = threadLine(s, heard); if (tl) out.push(['smart-thread', tl]); }
  if (flag('CONTRACT') && it !== 'scam' && !s.safety) out.push(['smart-shape', SHAPE_NOTE]);
  if (flag('GENERAL') && it !== 'scam' && !s.safety) {
    const g = decideGeneral(heard, s._exec || {});
    if (g) out.push(['smart-decision-general', g.label === 'Checked' ? 'DECISION (made by the app): a web check ran. You may share what it returned as "what I found", never as proof, never "verified", "safe" or "guaranteed"; no diagnosis or medicine advice; they decide.' : `DECISION (made by the app): NOT SURE (${g.why}). You have NOT verified this. Say honestly that you cannot be sure, say a trusted source (their doctor or pharmacist, or the official site) is the place to confirm, and never say safe, verified, fine or guaranteed. No diagnosis or medicine advice; they decide.`]);
  }
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
  if ((flag('CARDS') || flag('CAPS')) && (s._exec || flag('CAPS')) && (claimy || (flag('CAPS') && (it === 'ability' || it === 'reminder')))) {
    const e = s._exec || {}, chat = s.channel === 'chat';
    const tools = flag('CAPS') ? ` TOOLS here: available: ${chat ? 'chat, reminders, photo / PDF / message scam check, web check, family note' : 'voice talk, reminders, family note'}; unavailable: ${chat ? 'phoning anyone, location, payments' : 'photo, PDF, web search, phoning anyone, location, payments'}.` : '';
    out.push(['smart-record', `RECORD (what really happened this turn; claim nothing that is "no"): family alert/note sent by the app: ${e.family ? 'yes' : 'no'}; web check: ${e.web || 'not run'}; message/photo scam check: ${e.scam || 'not run'}; reminder saved: ${e.reminder ? 'yes' : 'no'}. You never phoned anyone for them.${tools}`]);
  }
  return out;
}

// The senior's own state card (state.js) as text. s.profile.id is the authenticated senior; nothing typed in the chat selects whose card this is. Kept on s._card for the draft guard.
const care_ = () => require('./care');
function appState(s, short = false) {
  const st_ = require('./state');
  try { const card = st_.build(s.profile.id, { channel: s.channel === 'chat' ? 'chat' : 'call' }); s._card = card; return short ? st_.compact(card) : st_.render(card); }
  catch { s._card = null; return 'APP STATE: UNKNOWN (the app could not read it this turn). Say you cannot see their saved calls right now; never say they have none, and never say anything is saved or scheduled.'; }
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
  [/\bI(?:'ve| have| just)?\s+(?:scheduled|booked|arranged)\b|\b(?:is|'s|has been|have been)\s+(?:all\s+)?(?:scheduled|booked)\b/i, (e) => !e.socialFailed && Boolean(e.reminder || e.social), true],
  [/\bI(?:'ve| have| just)?\s+(?:notified|alerted|told|informed|sent)\s+(?:your\s+)?(?:family|son|daughter|them|the bank|the police)\b/i, (e) => Boolean(e.family)],
];
// Returns a reason string when the draft must be written again, else null. rec = s._exec (what really ran); known = the text the facts and the senior gave (a link or number must already be in it).
function breaks(text, s) {
  const t = String(text || '').replace(/’/g, "'"); s._guardWhy = null;
  if (flag('SHORT') || flag('COMPANION')) {
    s._q = (s._q || 0) + (t.match(/\?/g) || []).length;
    if (s._q > 1) { s._why = 'you asked more than one question: ask only ONE'; return 'twoq'; }
    const am = s._abilityMode || (s._abilityFirst ? { first: true, max: 3, avoid: [] } : null);
    if (am) {
      s._cats = s._cats || new Set(); const seen = new Set(); for (const [k, re] of CATS) if (re.test(t)) { s._cats.add(k); seen.add(k); }
      if (s._cats.size > am.max) { s._why = 'you listed too many abilities: name at most ' + am.max + ', in at most two short sentences'; return 'dump'; }
      if (am.avoid.some((k) => seen.has(k))) { s._why = 'you repeated something you already told them about your abilities: say a different one'; return 'dump'; }
    }
  }
  if (flag('MEMORY') && /\?\s*$/.test(t) && !(s.factLabels || []).some((l) => /^(setrem|scam)/.test(l))) {
    const w = contentWords(t); const ik = introKey(t); if (ik && allQs(s).some((q) => q.intro === ik && q.answered)) { s._why = 'they already answered that introductory question: do not ask it again, build on their answer'; return 'repeat'; }
    const ls = (s.profile && require('./care').get(s.profile.id) || {}).smart;
    if (flag('COMPANION') && ls && (ls.brush || []).some((b) => Date.now() - b.at < 30 * 86400000 && overlap(w, b.w) >= 0.5 && !(b.w.some((x) => String(s.lastHeard ? s.lastHeard() : '').toLowerCase().includes(x))))) { s._why = 'they asked you to drop that topic: do not raise it'; return 'brushed'; }
  }
  if (flag('COMPANION') && require('./social').claimBlocked(t, s)) { s._why = 'nothing is saved: do not say the call is scheduled, arranged, noted or booked. Say what is still needed, or that it was not saved'; return 'claim'; }
  if (stateFlag('GUARD') && s.profile && s.profile.id) {   // factual claims about calls and records, judged against a card built NOW for the authenticated senior (never against a phrase list alone)
    const st_ = require('./state'); let card = null;
    try { card = st_.build(s.profile.id, { channel: s.channel === 'chat' ? 'chat' : 'call' }); } catch { card = null; }
    const bad = st_.checkDraft(t, card, { labels: s.factLabels || [], heard: s.lastHeard ? s.lastHeard() : '', exec: s._exec || {}, sched: Boolean(s._sched) });
    if (bad) { s._why = bad.note; s._guardWhy = bad.why; return `state-${bad.why}`; }
  }
  if (!flag('GUARD')) return null;
  if (SAFE_CLAIM.test(t) && !/\bnot\s+(?:100|a hundred|safe|verified)|\bn't\s+(?:safe|verified)|\bcan'?t\s+(?:say|be)\b[^.]{0,30}\b(?:safe|sure)/i.test(t)) return 'certainty';
  const known = `${s.lastHeard ? s.lastHeard() : ''} ${s._knownText || ''}`;
  const u = URL_.exec(t); if (u && !known.toLowerCase().includes(u[0].toLowerCase().replace(/[.,!?)]+$/, ''))) return 'link';
  const p = PHONE_.exec(t); if (p && !digits(known).includes(digits(p[0]))) return 'number';
  const e = s._exec || {};
  const sentences = t.split(/(?<=[.!?])\s+/);
  for (const [re, ok, denyOk] of CLAIM) if (!ok(e) && sentences.some((x) => re.test(x) && !(denyOk && /\b(?:no|not|nothing|never|nobody|haven'?t|hasn'?t|didn'?t|isn'?t|wasn'?t|yet)\b/i.test(x)))) return 'claim';   // "nothing is scheduled yet" is a denial, not a claim; the other claims stay strict
  return null;
}

// The line a person sees when both drafts were blocked: plain, true, asks one thing. Never a faked answer, never the bad draft.
function fallback(s) {
  const x = st(s);
  if (/abilities/.test(s._why || '')) return ABILITY_FALLBACK;
  if (s.profile && s.profile.id && s._exec && (s._exec.socialFailed || s._exec.socialUnknown)) {   // from the app's own write result, whatever the blocked draft said; never "nothing changed" unless the record was read, never a new confirmation
    let rec = null, readable = true; try { rec = require('./care').socialOf(s.profile.id); } catch { readable = false; }
    const cl = (r) => `${r.h % 12 || 12}:${String(r.mi).padStart(2, '0')} ${r.h < 12 ? 'am' : 'pm'}`;
    if (s._exec.socialUnknown || !readable) return "I couldn't confirm whether that change went through, so please don't count on it yet. Ask me in a moment and I'll read back what is saved.";
    return rec && !rec.revoked ? `That did not save. Your daily call is still at ${cl(rec)}.` : 'That did not save, so nothing is set up yet. You can ask me again whenever you like.';
  }
  if (s._guardWhy) {   // a plain line that is true from the app's own records (checked again here, never from the bad draft)
    const c = (() => { try { return require('./state').build(s.profile.id, { channel: 'chat' }); } catch { return null; } })();
    const live = c && Array.isArray(c.records) && c.records.find((r) => r.type === 'daily-call' && /^(active|today)/.test(r.status));
    const tx = c && c.transaction;
    if (tx && tx.pending && tx.proposed && tx.proposed.time && /change/.test(tx.op) && /confirm/.test(tx.stage)) return `Just to check: shall I move your daily call to ${tx.proposed.time}? It stays at its current time until you say yes.`;
    if (tx && tx.pending && tx.proposed && tx.proposed.time && tx.proposed.start && /confirm/.test(tx.stage)) return `Just to check: shall I call you every day at ${tx.proposed.time}, starting ${tx.proposed.start}? Nothing is saved until you say yes.`;   // a real read-back of the proposal, so a yes can bind to what was actually said
    if (!c || !Array.isArray(c.records)) return "I can't see your saved calls right now, so I don't want to say anything wrong. Could you ask me again in a moment?";
    if (s._exec && s._exec.socialFailed) return 'That did not save, so nothing is set up yet. Would you like to try once more?';
    const stopped = c && ((c.consent && c.consent.callsRevoked) || (Array.isArray(c.records) && c.records.some((r) => r.type === 'daily-call' && /^stopped/.test(String(r.status)))));
    if (stopped) return 'Your daily call is still stopped, and I have not started it again. If you would like it back, tell me the time and I will ask you to confirm it first.';
    if (live) return `Your daily call is saved for ${live.time}. You can ask me to skip one, change the time or cancel it.`;
    return 'I do not have a daily call saved for you right now. I can set one up with you myself: what time would suit you?';
  }
  return x.topic === 'scam' || (s._scam && s._scam.needed)
    ? "I can't be sure about this one, and I can make mistakes. Please don't pay or share anything until you've checked with your family or the real company, using a number or app you already trust. What did they ask you for?"
    : 'I want to get this right. Could you tell me a little more about what you mean?';
}

module.exports = { STYLE_NOTE, SHAPE_NOTE, guessNotes, stateFlag, STATE_LAYERS, appState, ledger, abilityFact, callsOk, any, wantsAll, ABILITY_SHORT, decideGeneral, afterReply, threadLine, attributedToOther, trace, flag, intent, notes, decide, nextQuestion, breaks, fallback, kindOf, KINDS, CAN, QUESTIONS };
