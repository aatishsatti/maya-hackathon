// The companion call offer: ONE friendly offer of a daily call, and the explicit consent that must exist before anything is saved. Code decides WHEN to offer, WHAT is still needed,
// WHETHER the senior really agreed and WHAT was saved; Spark only writes the sentences (every text below is a FACT for Spark, never spoken as written). Flag: MAYA_SMART_COMPANION (smart.js).
//
// Consent is explicit and bound to one offer (p.smart.social.offer, with its own id): the four things are DAILY, a START DATE, a LOCAL TIME and the TIME ZONE (the one Maya already knows
// for them: never guessed from a place or a language). Nothing is saved until Maya has asked one question naming all four and the senior's NEXT message is a plain yes by itself.
// A "yes" inside a longer sentence, a quoted one, or one said before the question was asked, is not permission. "Scheduled" may be said only after care.socialSave succeeded.
// The saved record, its dispatch checks and the single bounded ring live in care.js (socialSave, fireSocial, socialBlock).
'use strict';
const crypto = require('node:crypto');
const care = require('./care');
const setrem = require('./setrem');

const OFFER_TTL_MS = 20 * 60000;          // an unanswered offer or question lapses
const DECLINE_MS = 30 * 86400000;         // a "no" is remembered: Maya does not offer again for 30 days (unless THEY bring it up)
const OFFER_GAP_MS = 24 * 3600000;        // and an offer nobody answered is not repeated within a day
const WARM_MIN = 4;                       // warm turns before the first offer

// A natural plain yes to the question just asked: "yes", "yes please", "yes perfect", "yes that sounds good", "sure", "perfect". It must be NOTHING BUT yes-words and filler (so "my daughter said yes",
// "yes but not on Fridays", a question, or a quoted "yes" are not it), and it only counts when it answers the confirm question that was asked.
const YES_CORE = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'perfect', 'correct', 'right', 'absolutely', 'definitely', 'certainly', 'exactly', 'works', 'good', 'great', 'lovely', 'fine', 'wonderful']);
const YES_FILLER = new Set(['please', 'thanks', 'thank', 'you', 'that', 'thats', 'sounds', 'sound', 'is', 'it', 'be', 'would', 'do', 'go', 'ahead', 'of', 'course', 'dear', 'maya', 'very', 'so', 'much', 'to', 'me', 'too', 'for', 'all', 'works', 'work', 'nice', 'brilliant', 'just', 'what', 'i', 'want', 'like', 'love', 'a', 'the', 'idea', 'plan', 'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'perfect', 'correct', 'right', 'absolutely', 'definitely', 'certainly', 'exactly', 'good', 'great', 'lovely', 'fine', 'wonderful', 'well', 'then', 'thing']);
function isYes(text) {
  const raw = String(text || '');
  if (/["“”?]/.test(raw)) return false;
  const w = raw.toLowerCase().replace(/[‘’]/g, "'").replace(/'/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  return w.length >= 1 && w.length <= 7 && w.every((x) => YES_FILLER.has(x)) && w.some((x) => YES_CORE.has(x));
}
const YES_ALONE = { test: isYes };
// A "no" that carries more ("No, you just said you can call me every day", "no, five ten") is a CORRECTION of what was said, not a refusal of the call. Only a bare no / no thanks / not now is a decline.
const LEAD_NO = /^\s*(?:no|nope|nah)\b[\s,.!-]*/i;
const PLAIN_NO_REST = /^(?:thanks?|thank you|not (?:now|today|really|interested)|i(?:'d| would) rather not|i don'?t (?:want|need)(?: it| that| to)?|maybe later|leave it|it'?s (?:ok|okay|fine)|that'?s (?:ok|okay|fine)|no)(?:\s+(?:thanks?|thank you|maya|dear))?$/;
function isDecline(t) {
  const x = String(t || ''); if (!DECLINE.test(x)) return false;
  if (!D()) return true;
  const m = LEAD_NO.exec(x); if (!m) return true;
  const rest = x.slice(m[0].length).replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return !rest || PLAIN_NO_REST.test(rest);
}
const isCorrection = (t) => D() && LEAD_NO.test(String(t || '')) && !isDecline(t);
// "Yeah, 5.10 am" after "shall I call you every day at 5:10 am starting today?": a yes that only restates the proposal IS the yes. Anything that differs, adds a condition or asks something is not.
const RESTATE_OK = new Set(['today', 'tomorrow', 'every', 'day', 'daily', 'morning', 'afternoon', 'evening', 'night', 'at', 'starting', 'start', 'from', 'call', 'me', 'please', 'thats', 'right', 'correct', 'its', 'is', 'the', 'time', 'am', 'pm', 'a', 'm', 'p', 'i', 'want', 'like', 'that', 'sounds', 'good', 'yes']);
function confirmsProposal(heard, offer, tz, now) {
  if (!D() || !offer || offer.stage !== 'confirm' || !offer.time) return false;
  const raw = String(heard || ''); if (/["“”?]/.test(raw)) return false;
  const w = raw.toLowerCase().replace(/[‘’']/g, '').split(/[^a-z0-9.:]+/).filter(Boolean);
  if (!w.length || w.length > 12 || !YES_CORE.has(w[0].replace(/[.:]/g, ''))) return false;
  if (/\b(?:but|except|only|unless|not|dont|no|instead|though)\b/i.test(w.join(' '))) return false;
  const sl = slots(raw, tz, now);
  if (sl.ambiguous || sl.notDaily || (sl.time && (sl.time.h !== offer.time.h || sl.time.mi !== offer.time.mi))) return false;
  if (sl.start && offer.start && sl.start !== offer.start) return false;
  const rest = normSpeech(raw).toLowerCase().replace(/[‘’']/g, '').replace(/\b\d{1,2}(?::\d{2})?\b/g, ' ').replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
  return rest.every((x) => YES_FILLER.has(x) || YES_CORE.has(x) || RESTATE_OK.has(x));
}   // kept for callers that used the old pattern
const DECLINE = /^\s*(?:no|nope|nah)\b|\bnot (?:now|today|really|interested)\b|\bno,? thanks?\b|\bno,? thank you\b|\bmaybe later\b|\bi(?:'d| would) rather not\b|\bi don'?t (?:want|need)\b|\bleave it\b/i;
const VAGUE = /\b(?:after (?:lunch|dinner|breakfast|tea|supper|my (?:nap|walk))|before (?:lunch|dinner|bed)|sometime|some time|later|whenever|any ?time|in the (?:morning|afternoon|evening)|afternoon|morning|evening|around then)\b/i;
const READBACK = /\b(?:what|which|any)\b[^.?!]{0,30}\b(?:calls?|chats?)\b[^.?!]{0,25}\b(?:do i have|have i (?:got|set)|(?:are|is) (?:set|arranged|scheduled|saved)|set up)\b|\bwhat time (?:do|will|are) you (?:call|ring|phone)\b|\bis my (?:daily )?(?:call|chat) (?:still )?(?:on|set|arranged|saved)\b|\b(?:do i have|have i got) (?:a |any )?(?:daily )?(?:call|calls)\b/i;
const SKIP = /\b(?:skip|miss|pass on)\b[^.?!]{0,25}\b(?:today|this one|the call)\b|\bdon'?t call me today\b|\bno call today\b|\bnot today\b/i;
const CANCEL = /\b(?:cancel|end|delete|remove|turn off|stop)\b[^.?!]{0,20}\b(?:daily|every ?day|regular|these|the|my)\b[^.?!]{0,12}\bcalls?\b|\bno more daily calls\b/i;
const CHANGE = /\b(?:change|move|switch|reschedule|make)\b[^.?!]{0,25}\b(?:call|time|chat)\b|\bcall me (?:at|around)\b[^.?!]{0,15}\binstead\b/i;
// The senior asking for a daily call themselves (so a recent "no" does not apply): "call me every day", "can you ring me daily".
const SELF_ASK = /\b(?:can|could|would|will) you (?:please )?(?:call|ring|phone) me\b[^.?!]{0,40}\b(?:every ?day|daily|each day|every (?:morning|afternoon|evening))\b|\b(?:call|ring|phone) me (?:every ?day|daily|each day|every (?:morning|afternoon|evening))\b|\bi(?:'d| would) (?:like|love) (?:you to |a )?(?:call|ring|chat)[^.?!]{0,30}\b(?:every ?day|daily)\b/i;

// ---- DECISION (smart.js flag MAYA_SMART_STATE_DECISION): Spark may read the request; THIS code validates the operation, the target and what the scheduler really supports. Nothing here widens the scheduler:
// the companion call is ONE daily call at ONE time of day. Several weekdays in one schedule and a second daily call do not exist, so they are explained as exactly that limit (never "family needed", never "I cannot schedule").
const D = () => require('./smart').stateFlag('DECISION');
const CALL_ASK = /\b(?:call|ring|phone)\s+me\b|\b(?:daily|every ?day)\s+(?:call|chat)s?\b|\bdaily calls?\b|\bgive me a (?:call|ring)\b/i;
const DAILYW = /\b(?:every ?day|daily|each day|every (?:morning|afternoon|evening))\b/i;
const DOW = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?';
const MULTI_DAYS = new RegExp(`\\b(?:weekdays?|week days?|weekends?|${DOW}(?:\\s*(?:,|and|&|/|-|to)\\s*${DOW})+|(?:twice|three times|two times|2 times|3 times) a week|every other day|every (?:second|2nd) day|alternate days?)\\b`, 'i');
const SECOND = /\b(?:another|a second|second|an extra|extra|additional|one more|as well|on top|in addition|two (?:daily )?calls|twice a day|also)\b/i;
const CHANGE_CUE = /\b(?:change|move|switch|reschedule|instead|rather|replace|swap)\b/i;
function predecessor(id, p, now) {   // what the record says happened before this request: acknowledged, never denied
  if (care.socialOf(id)) return '';
  const z = zget(id), sm = p.smart || {}, parts = [];
  const h = (sm.history || []).filter((e) => e.type === 'daily-call').slice(-1)[0];
  if (h) parts.push(`Their earlier daily call${h.h != null ? ` at ${clockWords(h.h, h.mi)}` : ''} was CANCELLED on ${dateWords(care.localDate(h.at, p.tz || 'UTC'))} (by the ${h.actor}, ${h.source}). It was real: never say it was never agreed or set up, and it is NOT a refusal of future calls: they are asking again themselves, which is their own choice. Mention in a few words that the earlier one was cancelled, then carry on.`);
  else if (z.cancelledAt) parts.push(`Their earlier daily call was CANCELLED on ${dateWords(care.localDate(z.cancelledAt, p.tz || 'UTC'))} (details not recorded). It was real, and it is NOT a refusal of future calls: they are asking again themselves. Mention in a few words that it was cancelled, then carry on.`);
  const ls = z.lastSave;
  if (ls && ls.ok !== true) parts.push(ls.ok === false ? `An earlier attempt to save a daily call did NOT save (${String(ls.error || 'it failed').slice(0, 80)}); the app checked and no daily call exists. Say so in a few words, then carry on.` : 'An earlier attempt to save a daily call did not finish; the app checked and no daily call exists. Say so in a few words, then carry on.');
  return parts.join(' ');
}
function existingFact(arr, p, why = '') {
  const v = care.socialView(p, p.reminders.find((r) => r.social));
  return ['social-decide-existing', `ALREADY SAVED (read from the saved record): they already have a daily call at ${clockWords(arr.h, arr.mi)} (${arr.tz}), status: ${v.status}${v.next ? `, next call ${dateWords(care.localDate(v.next, arr.tz))} at ${clockWords(arr.h, arr.mi)}` : ''}. Nothing new was saved: a repeated request never makes a second call.${why} Tell them it is already set up, from the record, in one or two short sentences.`];
}
function decision(s, id, p, arr, offer, heard, now) {
  const ask = CALL_ASK.test(heard) || SELF_ASK.test(heard), live = arr && !arr.revoked ? arr : null;
  const at = live ? `${clockWords(live.h, live.mi)} (${live.tz})` : '';
  if (ask && MULTI_DAYS.test(heard) && (CALL_ASK.test(heard) || p.reminders.some((r) => r.social)))
    return ['social-decide-days', `WEEKDAY PATTERN NOT AVAILABLE (a limit of Maya's scheduler, NOT a permission, not a family rule, not a lack of phone): the daily call can only be EVERY day at ONE time. Days such as Mon/Wed/Fri, weekdays, weekends or every other day are not available for it. ${live ? `Their existing daily call at ${at} is UNCHANGED and still active.` : 'Nothing is saved.'} Say that specific limit plainly in one or two short sentences. Do NOT say you cannot schedule calls, that the family is needed, or that only the app works. ${live ? 'Ask ONE question: keep it as it is?' : 'Ask ONE question: would an every-day call suit them instead?'} (A call on one single weekday, like every Tuesday, is an ordinary reminder they can ask for.)`];
  if (live && ask && DAILYW.test(heard) && SECOND.test(heard) && !CHANGE_CUE.test(heard))
    return ['social-decide-second', `SECOND DAILY CALL NOT AVAILABLE (a limit of Maya's scheduler: ONE daily call at a time; not a permission, not a family rule). Their existing daily call at ${at} is UNCHANGED and stays. Nothing new is saved. Say that specific limit plainly in one or two short sentences, and offer ONE thing: changing the time of the existing call, or keeping it. Do NOT say you cannot schedule calls or that the family is needed.`];
  if (live && !CHANGE_CUE.test(heard) && (SELF_ASK.test(heard) || (CALL_ASK.test(heard) && DAILYW.test(heard)))) {   // an explicit change ("change my daily call to 6:05") is the change flow's, never "already saved"
    const sl = slots(heard, live.tz, now), ls = zget(id).lastSave, why = !ls || ls.ok === true ? '' : ' (An earlier save looked unfinished, but the app checked: the call IS saved.)';
    if (!sl.time || (sl.time.h === live.h && sl.time.mi === live.mi)) return existingFact(live, p, why);
    if (!CHANGE_CUE.test(heard) && !offer) {   // a different time for a call they already have: change or add? Add does not exist, so ONE question that binds to exactly the change
      const o = { id: uid(), stage: 'confirm', mode: 'change', at: now, tz: p.tz || live.tz, time: sl.time, start: live.start, ack: true };
      zput(id, { offer: o });
      return ['social-decide-ambiguous', `CHANGE OR ADD? (nothing is changed yet) They already have a daily call at ${at} and asked for ${clockWords(sl.time.h, sl.time.mi)}. A second daily call is not available (scheduler limit: ONE daily call at a time), so say that in a few words and ask ONE yes/no question: should the existing daily call MOVE to ${clockWords(sl.time.h, sl.time.mi)}, their local time (${o.tz})? If not, it stays at ${clockWords(live.h, live.mi)}. Only a yes to that question changes it.`];
    }
  }
  if (CHANGE.test(heard) && !/\b(?:call|chat|ring|phone)\b/i.test(heard) && !offer) {
    const others = p.reminders.filter((r) => !r.social && r.by === 'senior' && (r.dueAt != null || r.active)).length;
    if (others && live) return ['social-decide-which', `WHICH ONE? (nothing is changed) They want to change a time but have a daily call at ${at} AND ${others} other reminder${others > 1 ? 's' : ''} they set. Ask ONE short question: which one do they mean (the daily call, or which reminder)? Change nothing until they say.`];
  }
  return null;
}
// "Stop all calls" is a consent change: scheduling needs their fresh yes. A request for a daily call afterwards is ASKED about, and only a plain yes to that question lifts it.
function reconsent(s, id, p, z, heard, now) {
  const arr0 = care.socialOf(id);
  if (D() && arr0 && arr0.revoked) {
    const sl = slots(heard, p.tz || arr0.tz, now), timeGiven = Boolean(sl.time || (sl.ambiguous && sl.amb)), x = s._social || {};
    if (timeGiven && !sl.negated && (ctxValid(x, now) || (z.reconsent && now - z.reconsent.at < OFFER_TTL_MS) || CALL_ASK.test(heard) || SELF_ASK.test(heard))) {
      // a time while the call is STOPPED never restarts it by itself: ONE question covers the fresh consent, the restart, the exact time and the first day
      if (!p.tz) return ['social-restore-blocked', 'Their daily call is STOPPED and their time zone is not known, so nothing can be restarted. Say plainly that it stays stopped, and ask which city or time zone they are in. Do not guess it.'];
      let t = sl.time; if (!t) t = with24(sl.amb.h, sl.amb.mi, arr0.h < 12 ? 'am' : 'pm');
      const np = nowParts(p.tz, now), todayStr = `${np.y}-${pad2(np.m)}-${pad2(np.d)}`;
      const todayAt = setrem.zonedEpoch(np.y, np.m, np.d, t.h, t.mi, p.tz), passed = todayAt <= now + 60000;
      const offer = { id: uid(), stage: 'restore', needAsk: true, mode: 'restore', reconsent: true, at: now, tz: p.tz, time: t, start: passed ? addDays(todayStr, 1) : todayStr, passed };
      zput(id, { offer, reconsent: null });
      return ['social-restore-ask', restoreAskFact(offer, p.tz)];
    }
  }
  const fresh = z.reconsent && now - z.reconsent.at < OFFER_TTL_MS;
  if (fresh && isYes(heard)) {
    care.persistSmart(id, { noCalls: null, callsRestored: { at: now, source: 'chat: yes to the fresh-consent question' } }); zput(id, { reconsent: null });
    const q = onCallsBack(id, now); if (q) return ['social-ask', `CALLS ALLOWED AGAIN by their yes. ${q}`];
    const offer = { id: uid(), stage: 'collect', mode: 'new', at: now, tz: p.tz, time: null, start: null };
    if (!p.tz) return null;
    zput(id, { offer }); return advance(s, id, care.get(id), offer, '', now, true);
  }
  if (fresh && DECLINE.test(heard)) { zput(id, { reconsent: null }); return ['social-declined', 'They do not want calls from you again. Accept that in one short sentence; nothing is scheduled.']; }
  if (CALL_ASK.test(heard) || SELF_ASK.test(heard)) { zput(id, { reconsent: { at: now } }); return ['social-decide-revoked', 'CALLS ARE STOPPED: earlier they told you to stop calling them. Nothing is scheduled and nothing will be until they clearly say they want calls from you again (this is their consent, not a family rule and not a technical limit). Ask ONE short yes/no question: do they want you to start calling them again? Do not ask for a time yet and do not say anything is arranged.']; }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n) => String(n).padStart(2, '0');
const clockWords = (h, mi) => `${h % 12 === 0 ? 12 : h % 12}:${pad2(mi)} ${h < 12 ? 'am' : 'pm'}`;
const addDays = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`; };
const dateWords = (ds) => { const [y, m, d] = ds.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d)); return `${DAYS[t.getUTCDay()]} ${d} ${MONTHS[m - 1]}`; };
const nowParts = (tz, now = Date.now()) => setrem.partsIn(now, tz);

const zget = (id) => ((care.get(id) || {}).smart || {}).social || {};
const zput = (id, patch) => care.persistSmart(id, { social: { ...zget(id), ...patch } });
const uid = () => crypto.randomBytes(5).toString('hex');
const quietWords = () => `${pad2(care.cfg.quietStart)}:00 to ${pad2(care.cfg.quietEnd)}:00`;

// Does this message belong to the daily-call flow (so the ordinary "call me" reminder flow in setrem.js must stay out of it)?
function claims(id, heard, now = Date.now()) {
  const z = zget(id), arr = care.socialOf(id);
  if (z.offer && now - z.offer.at < OFFER_TTL_MS) return true;
  const h = String(heard || '');
  if (D() && CALL_ASK.test(h) && (DAILYW.test(h) || MULTI_DAYS.test(h))) return true;   // a daily-call request (even with a call already saved, or in a pattern that does not exist) is this flow's, never an ordinary reminder that would add a second record
  return Boolean(SELF_ASK.test(h) && !arr);
}

// "Stop calling me" reaches the scheduler: the saved chat and any queued ring stop at once (the senior's other reminders are untouched).
function onNoCalls(id) { zput(id, { offer: null }); return care.socialRevoke(id); }
// "You can call me again": the permission to offer is back, but a revoked daily chat is NOT switched on by that: it is asked about, and only a plain yes to that question restores it.
function onCallsBack(id, now = Date.now()) {
  const arr = care.socialOf(id); if (!arr || !arr.revoked) return null;
  zput(id, { offer: { id: uid(), stage: 'restore', mode: 'restore', at: now, tz: arr.tz, time: { h: arr.h, mi: arr.mi }, start: arr.start } });
  return `They asked for calls again. They used to have a daily call from you at ${clockWords(arr.h, arr.mi)} (their time) that was stopped. It is NOT back on. Ask ONE yes/no question: do they want that daily call back at ${clockWords(arr.h, arr.mi)}? Only a plain yes to that question brings it back; say nothing is scheduled until then.`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// STOP-CALLS TARGETING (smart.notes runs this BEFORE the daily-call step, once per turn). Who a "stop calling me" is aimed at is decided here, in code:
//   none      third-person, quoted or role-played speech (or a pretend talk): changes NOTHING, asks nothing
//   direct    Maya is named, or "you" with no scam/pretend context: honoured at once, with a provenance record
//   ambiguous anything else: ONE scoped question; only a fresh yes to THAT question (really spoken) authorizes the stop
// Ending a conversation ("goodbye", "I have to go") is never a stop and never reaches this code.
const STOP_PHRASE = /\b(?:stop calling me|don'?t (?:ever )?call me|do not call me|no more calls|never call me)\b/i;
const MAYA_NAMED = /\bmaya\b/i;
const MY_CALLS = /\b(?:my|your|the) daily (?:call|chat)s?\b|\bdaily calls?\b|\b(?:every ?day|regular) calls?\b|\b(?:stop|cancel|end) (?:calling|your calls|my calls)\b/i;
const PLAY = /\b(?:pretend(?:ing)?|role-?play(?:ing)?|let'?s practi[cs]e|practi[cs]e (?:saying|with|how)|you be the|act (?:as|like)|imagine (?:you|he|she|they|a)|let'?s say)\b/i;
const SCAMTALK = /\b(?:scam(?:mer|mers|s)?|fraud(?:ster|sters)?|phishing|con ?(?:man|artist)|the other (?:caller|person)|that (?:caller|man|woman|guy|lady|person)|password|pin number|social security|gift cards?|wire (?:the )?money|bank account|verification code|one[- ]time (?:code|password)|otp|credit card|how did you get my number|who is this|not (?:giving|telling|sending) you|the (?:bank|irs|police|government|microsoft|amazon) (?:called|says|said|is))\b/i;
const THIRD_FRAME = /\b(?:i|we)\s+(?:said|told|say|tell|shouted|yelled|would say|will say)\b|\b(?:tell|told|say|said|shout|yell)\s+(?:to\s+)?(?:him|her|them|that \w+|the \w+)\b|\b(?:he|she|they|the (?:caller|man|guy|lady|woman|scammer|person)|someone|somebody)\s+(?:said|says|told|tells|asked|keeps?|kept)\b|["“”]/i;
const recentText = (s) => (Array.isArray(s.history) ? s.history.slice(-6) : []).map((m) => String(m.content || '').replace(/\[\[[^\]]*\]\]/g, ' ')).join(' ');
const aMeridiem = (h, mi) => `${h % 12 === 0 ? 12 : h % 12}:${pad2(mi)} ${h < 12 ? 'a.m.' : 'p.m.'}`;
function stopClass(s, heard) {
  const phrase = STOP_PHRASE.test(heard), cancel = CANCEL.test(heard);
  if (!phrase && !cancel) return null;
  const recent = recentText(s), named = MAYA_NAMED.test(heard) || (cancel && MY_CALLS.test(heard)) ;
  const play = PLAY.test(heard) || PLAY.test(recent), frame = THIRD_FRAME.test(heard), scamCtx = SCAMTALK.test(heard) || SCAMTALK.test(recent) || Boolean(s._smart && s._smart.topic === 'scam');
  const action = phrase ? 'revoke' : 'cancel';
  if (!MAYA_NAMED.test(heard) && (frame || play)) return { kind: 'none', action };
  if (named) return { kind: 'direct', action };
  if (!scamCtx) return { kind: 'direct', action };   // bare words on a call with Maya and no scam / third-party context: aimed at her, honoured without a hurdle
  return { kind: 'ambiguous', action };
}
const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
// A bounded, server-side record of why a stop (or a restart) happened. Transcriptions are speech-to-text of the audio, not guaranteed exact. Only the triggering words, two turns of context, the question and the answer are kept (never the whole conversation).
function recordStopEvent(s, id, ev) {
  const p = care.get(id); if (!p) return false;
  const full = { id: uid(), kind: 'stop-calls-record', note: 'quoted text is a speech-to-text transcription, not guaranteed exact audio', at: ev.at || Date.now(), atIso: new Date(ev.at || Date.now()).toISOString(), tz: p.tz || null, channel: s.channel === 'chat' ? 'chat' : 'voice call', session: s.callId ? String(s.callId) : null, ...ev };
  care.persistSmart(id, { stopEvents: [...(((p.smart || {}).stopEvents) || []), full].slice(-5) });
  return full.id;
}
function applyStop(s, id, st, how, heard, now) {
  const p = care.get(id), arr = care.socialOf(id), before = { noCalls: Boolean(p.smart && p.smart.noCalls), call: arr ? { status: arr.revoked ? 'stopped' : 'active', time: clockWords(arr.h, arr.mi), tz: arr.tz } : null };
  const ctx = (Array.isArray(s.history) ? s.history.slice(-2) : []).map((m) => ({ role: m.role, transcription: clip(String(m.content || '').replace(/\[\[[^\]]*\]\]/g, ' '), 120) }));
  let ok = false, afterNo = false, call2 = null;
  try {
    if (st.action === 'cancel') { care.socialCancel(id, { actor: 'senior', source: how === 'confirmed' ? 'chat: yes to the scoped stop question' : 'chat: direct request', reason: 'the senior asked to cancel the daily calls' }); zput(id, { offer: null }); ok = !care.socialOf(id); }
    else { care.persistSmart(id, { noCalls: { at: now, source: s.channel === 'chat' ? 'chat' : 'voice call', reason: how === 'confirmed' ? 'the senior said yes to the question whether to stop Maya\'s calls' : 'the senior told Maya directly to stop calling' } }); onNoCalls(id); const q = care.get(id), r = care.socialOf(id); ok = Boolean(q.smart && q.smart.noCalls) && (!r || Boolean(r.revoked)); }
    const q2 = care.get(id), r2 = care.socialOf(id); afterNo = Boolean(q2.smart && q2.smart.noCalls); call2 = r2 ? { status: r2.revoked ? 'stopped' : 'active', time: clockWords(r2.h, r2.mi) } : null;
  } catch { ok = false; }
  const evId = recordStopEvent(s, id, { type: 'stop', at: now, trigger: how === 'confirmed' ? 'scoped question answered yes' : 'directed at Maya', decision: how === 'confirmed' ? 'a fresh yes to the question that was actually spoken' : 'the words named Maya (or "you") with no scam or pretend context', action: st.action === 'cancel' ? 'cancel the daily call record' : 'stop the daily call and all new calls until they ask again',
    scope: { affectedCall: arr ? { id: arr.id || null, time: clockWords(arr.h, arr.mi), tz: arr.tz } : null }, transcription: { text: clip(st.heard || heard, 200), context: ctx },
    confirmation: how === 'confirmed' ? { question: st.question, askedAt: st.asked && st.asked.at, answer: { transcription: clip(heard, 160) }, answeredAt: now } : null, before, after: { noCalls: afterNo, call: call2 }, writeVerified: ok });
  s._exec = s._exec || {}; if (!ok) s._exec.socialFailed = true;
  if (!ok) return ['social-stop-failed', 'STOP NOT CONFIRMED: the app could not confirm that the calls were stopped. Say plainly that you could not confirm it went through and that you will check again if they ask. Do not say it is stopped.'];
  return ['social-stopped', st.action === 'cancel' ? 'CANCELLED (verified in the app): the daily calls are cancelled and no more will come. Say so in one short sentence. They can ask for them again whenever they like. Do not ask them to reconsider.' : 'CALLS STOPPED (verified in the app): you will not call them unless they ask you to again. Say so kindly in one short sentence. Never offer, arrange or promise a call after this, until THEY ask for calls again. Do not change any reminder they set themselves.'];
}
function stopTurn(s, id, heard, now = Date.now()) {
  heard = String(heard || '').replace(/\s+/g, ' ').trim(); if (!id || !heard) return null;
  s._stopTurnRan = true;
  const z = zget(id), sa = z.stopAsk;
  if (sa && now - sa.at >= OFFER_TTL_MS) zput(id, { stopAsk: null });
  else if (sa) {
    if (!sa.asked) {   // the question was never put to them aloud: a yes binds to nothing
      if (isYes(heard)) return ['social-stop-ask', `STOP-CALLS QUESTION (nothing is changed, and their yes did not answer anything yet because the question has not been put to them): ask exactly ONE yes/no question, in these words: "${sa.question}" Nothing changes unless they answer yes to that question.`];
      zput(id, { stopAsk: null });
    } else if (isYes(heard) && !STOP_PHRASE.test(heard)) { zput(id, { stopAsk: null }); return applyStop(s, id, sa, 'confirmed', heard, now); }
    else { zput(id, { stopAsk: null }); if (DECLINE.test(heard) || isDecline(heard)) return ['social-stop-kept', 'They do NOT want the calls stopped. Nothing was changed. Say in one short, warm sentence that you will keep the call as it is.']; }
  }
  const st = stopClass(s, heard); if (!st || st.kind === 'none') return null;
  if (st.action === 'cancel' && !care.socialOf(id)) return null;   // nothing to cancel: the ordinary path answers
  if (st.kind === 'direct') return applyStop(s, id, st, 'direct', heard, now);
  const arr = care.socialOf(id), question = arr && !arr.revoked ? `Do you mean you want me, Maya, to stop your daily ${aMeridiem(arr.h, arr.mi)} call?` : 'Do you mean you want me, Maya, to stop calling you?';
  zput(id, { stopAsk: { id: uid(), at: now, asked: null, action: st.action, question, heard: clip(heard, 200), h: arr && !arr.revoked ? arr.h : null, mi: arr && !arr.revoked ? arr.mi : null, tz: arr ? arr.tz : (care.get(id).tz || null) } });
  return ['social-stop-ask', `STOP-CALLS QUESTION (nothing is changed): what they just said may have been about someone else (a caller, or a pretend talk), not about you. Do NOT stop, cancel or change anything. Ask exactly ONE yes/no question, in these words: "${question}" Add nothing else about stopping. Nothing changes unless they answer yes to that question.`];
}

// ---- spoken times (DECISION): a voice transcript says "5.10 am", "five ten", "ten past five", "a.m.". setrem.readTime reads "5.10 am" as 10 am, so spoken forms are turned into "5:10 am" first.
const HW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const MW = { 'oh five': 5, 'zero five': 5, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, 'twenty-five': 25, thirty: 30, 'thirty five': 35, 'thirty-five': 35, forty: 40, 'forty five': 45, 'forty-five': 45, fifty: 50, 'fifty five': 55, 'fifty-five': 55 };
for (const [w, d] of Object.entries({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 })) for (const z of ['oh', 'zero', 'o']) MW[`${z} ${w}`] = d;   // "six oh six", "six zero six", "six o six" are 6:06
for (const [tw, tv] of Object.entries({ twenty: 20, thirty: 30, forty: 40, fifty: 50 })) for (const [uw, uv] of Object.entries({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 })) { MW[`${tw} ${uw}`] = tv + uv; MW[`${tw}-${uw}`] = tv + uv; }   // "one twenty six" is 1:26
const HWRE = Object.keys(HW).join('|'), MWRE = Object.keys(MW).sort((a, b) => b.length - a.length).join('|');
function normSpeech(text) {
  let t = String(text || '').replace(/\b([ap])\.\s?m\b\.?/gi, '$1m').replace(/\b(\d{1,2})\.(\d{2})\b(?!\s?(?:%|dollars?|pounds?|rupees?))/g, '$1:$2');
  t = t.replace(/\b(1[0-2]|[1-9])\s*(?:oh|o|zero)\s*([1-9])\b/gi, (_, h, d) => `${h}:0${d}`);   // "6 oh 6"
  t = t.replace(/\b(1[0-2]|[1-9])\s+([0-5]\d)\s*(am|pm)\b/gi, (_, h, m, ap) => `${h}:${m} ${ap}`);   // "1 26 PM" (a transcript that dropped the colon): readTime would read hour 26 (or 1:00 for "at 1 26 PM")
  if (t.trim().split(/\s+/).length <= 6) t = t.replace(/(?<![\d:.])\b(1[0-2]|[1-9])([0-5]\d)\b(?![\d:.])/g, (_, h, m) => `${h}:${m}`);   // "606", "1005" said as a clock time (only inside the daily-call flow)
  t = t.replace(new RegExp(`\\b(half|quarter) past (${HWRE})\\b`, 'gi'), (_, q, h) => `${HW[h.toLowerCase()]}:${q.toLowerCase() === 'half' ? '30' : '15'}`);
  t = t.replace(new RegExp(`\\bquarter to (${HWRE})\\b`, 'gi'), (_, h) => `${((HW[h.toLowerCase()] + 10) % 12) + 1}:45`);
  t = t.replace(new RegExp(`\\b(${MWRE}|twenty|ten|five) (past|to) (${HWRE})\\b`, 'gi'), (_, m, w, h) => { const mm = MW[m.toLowerCase()] || (m.toLowerCase() === 'five' ? 5 : 0); const hh = HW[h.toLowerCase()]; return w.toLowerCase() === 'past' ? `${hh}:${pad2(mm)}` : `${((hh + 10) % 12) + 1}:${pad2(60 - mm)}`; });
  t = t.replace(new RegExp(`\\b(?:at )?(${HWRE}) (${MWRE})(?= ?(?:am|pm)\\b|\\s*$|\\s*[,.]|\\s+(?:every|starting|today|tomorrow|please))`, 'gi'), (_, h, m) => `${HW[h.toLowerCase()]}:${pad2(MW[m.toLowerCase()])}`);
  return t;
}
const AP_ONLY = /^\s*(?:(?:yes|yeah|ok|okay|sure|and)[\s,]+)?(?:in the )?(am|pm|morning|afternoon|evening|night)\s*[.!]?\s*$/i;
const apOf = (w) => (/^(?:am|morning)$/i.test(w) ? 'am' : 'pm');
const with24 = (h, mi, ap) => ({ h: ap === 'am' ? (h === 12 ? 0 : h) : (h < 12 ? h + 12 : h), mi });
// "not 6:57", "instead of 6:56", "6:56 isn't right": a NEGATED time is never selected. Negation plus an alternative is a correction to the alternative; negation alone selects nothing.
const NEG_BEFORE = /\b(?:not|no|isn'?t|aren'?t|never|don'?t want|do not want|rather than|instead of|anything but)\s+(?:at\s+|to\s+|for\s+)?(\d{1,2}(?::\d{2})?\s?(?:am|pm)?)/gi;
const NEG_AFTER = /(\d{1,2}(?::\d{2})?\s?(?:am|pm)?)\s+(?:is not|isn'?t|is wrong|was wrong|is not right|isn'?t right)\b/gi;
function slots(heard, tz, now) {
  let negated = false; const negTimes = [];
  if (D()) { heard = normSpeech(heard); const cut = (m, t) => { negated = true; const q = /(\d{1,2})(?::(\d{2}))?\s?(am|pm)?/i.exec(t); if (q) negTimes.push({ h12: Number(q[1]) % 12 || 12, mi: Number(q[2] || 0), ap: q[3] ? q[3].toLowerCase() : null }); return ' '; }; heard = heard.replace(NEG_BEFORE, cut).replace(NEG_AFTER, cut); }
  const { found } = setrem.readTime(heard, { bare: true }), out = { time: null, start: null, daily: false, notDaily: false, ambiguous: false, vague: false };
  if (found.clock) { const c = setrem.resolveClock(found.clock, found.daypart); if (c.ok) out.time = { h: c.h, mi: c.mi }; else if (c.ambiguous) { out.ambiguous = true; out.amb = { h: c.h, mi: c.mi }; } }
  else if (found.daypart || VAGUE.test(heard)) out.vague = true;
  out.daypart = found.daypart || null; out.negated = negated && !out.time && !out.ambiguous; out.negTimes = negTimes;
  const today = nowParts(tz, now), todayStr = `${today.y}-${pad2(today.m)}-${pad2(today.d)}`;
  if (found.day === 'today') out.start = todayStr; else if (found.day === 'tomorrow') out.start = addDays(todayStr, 1);
  else if (found.weekday != null) out.start = addDays(todayStr, ((found.weekday - today.wd + 7) % 7) || 7);
  if (found.repeat === 'daily' && (found.every || 1) === 1) out.daily = true; else if (found.repeat || found.unsupported) out.notDaily = true;
  return out;
}

const NEED = {
  time: "the time of day as a clock time (a vague time like 'after lunch' or 'in the afternoon' is not enough: ask what time exactly, and am or pm if it is unclear)",
  start: 'which day the daily calls should start (today, tomorrow or a weekday)',
};

function askFact(offer, extra = '') {
  const missing = [!offer.time && NEED.time, !offer.start && NEED.start].filter(Boolean);
  return `SOCIAL CALL (not arranged yet, nothing is saved): they are open to a daily call from you. Still needed: ${missing.join('; and ')}. Ask for it in ONE plain question (a clarifying question is fine, an interview is not). Do not say it is scheduled, arranged or booked.${extra ? ` ${extra}` : ''}`;
}
const restoreAskFact = (offer, tz) => offer.reconsent
  ? `SOCIAL CALL, RESTART WITH FRESH CONSENT (nothing is restarted yet): their daily call is STOPPED because calls were stopped earlier. Say plainly that it is still stopped and stays stopped until they say yes. ${offer.passed ? `That time (${clockWords(offer.time.h, offer.time.mi)}) has already passed today, so the first call would be ${dateWords(offer.start)}. ` : ''}Ask ONE yes/no question that covers all of it: should I START CALLING YOU AGAIN every day at ${clockWords(offer.time.h, offer.time.mi)}, their local time (${tz}), starting ${dateWords(offer.start)}? Only a yes to that question restarts it; a time alone is not a yes.`
  : `SOCIAL CALL, RESTART (nothing is restarted yet): their daily call was STOPPED. Say that, and ask ONE yes/no question that covers the restart and the exact time: should the stopped daily call START AGAIN at ${clockWords(offer.time.h, offer.time.mi)}, their local time (${tz})? It only restarts if they answer yes to that question.`;
const confirmFact = (offer, tz, extra = '') => `SOCIAL CALL, CONFIRM (nothing is saved yet): ask ONE yes/no question that says all of it: a call from you EVERY DAY, starting ${dateWords(offer.start)}, at ${clockWords(offer.time.h, offer.time.mi)}, in their own local time (${tz}). Do not say it is scheduled, arranged or booked: it is only saved if they answer yes to this question.${extra ? ` ${extra}` : ''}`;
const confirmChangeFact = (offer, tz, extra = '') => `SOCIAL CALL, CHANGE OF TIME (nothing is changed yet, the call stays at its OLD time until they say yes): say the COMPLETE new time aloud, with am or pm, and ask ONE yes/no question: should the daily call move to ${clockWords(offer.time.h, offer.time.mi)}, their local time (${tz})? ${offer.inferred ? 'You assumed am or pm to match their current call, so say it clearly so they can correct it. ' : ''}It only changes if they answer yes to that question. If they give another time, that new time REPLACES this one and you ask again.${extra ? ` ${extra}` : ''}`;

// One turn of the daily-call flow. Returns [label, text] or null. s = the Call/Chat object, ctx = { intent, callsOk, safe }.
// Daily-call CONTEXT (code, not Spark): the previous one or two turns were about the daily call and it was within 10 minutes. "make it" / "do it at" / a bare time after a topic switch is NOT a change request.
const ctxValid = (x, now) => Boolean(x && x.lastSocial != null && x.turn - x.lastSocial <= 2 && now - (x.lastSocialAt || 0) < 10 * 60000);
function step(s, heard, ctx = {}, now = Date.now()) {
  const x = s._social || (s._social = { warm: 0 }); x.turn = (x.turn || 0) + 1;
  const r = stepCore(s, heard, ctx, now);
  if (r) { x.lastSocial = x.turn; x.lastSocialAt = now; }
  return r;
}
const CALLLESS_CUE = /\b(?:make it|do it|set it|put it|move it|change it|switch it|how about|what about|let'?s (?:do|make|say)|instead|actually|wait|rather|can we|no)\b/i;
const QUESTIONISH = (t) => /\?\s*$/.test(t) || /^\s*(?:is|are|does|do|did|will|what|which|when)\b/i.test(t);
const ASKS_FOR_CHANGE = /\b(?:can|could|would|will) you\b|\bplease\b|\b(?:change|move|switch|make|set|put)\b/i;
// "Is it at 6:57?" is a question about the record, answered from storage, never a change request (and it consumes nothing).
function questionReadback(p, arr, offer, heard, now, x) {
  if (!QUESTIONISH(heard) || CHANGE.test(heard) || CHANGE_CUE.test(heard) || SELF_ASK.test(heard) || /\b(?:can|could|would|will) you\b/i.test(heard)) return null;
  const sl = slots(heard, (arr && arr.tz) || p.tz, now); if (!sl.time && !sl.ambiguous) return null;
  if (!(/\b(?:call|calls|daily|ring)\b/i.test(heard) || ctxValid(x, now) || offer)) return null;
  const want = sl.time || sl.amb, same = arr && !arr.revoked && (sl.time ? (arr.h === sl.time.h && arr.mi === sl.time.mi) : (arr.h % 12 === sl.amb.h % 12 && arr.mi === sl.amb.mi));
  const asked = sl.time ? clockWords(want.h, want.mi) : `${want.h}:${pad2(want.mi)}`;
  const rec = arr ? `${clockWords(arr.h, arr.mi)} (${arr.tz})${arr.revoked ? ', status: STOPPED' : ''}` : null;
  return ['social-readback', `SAVED RECORD: ${rec ? `a daily call at ${rec}` : 'no daily call is saved'}. They ASKED whether it is at ${asked}: ${same ? 'YES, that is the saved time' : rec ? `NO, the saved time is ${rec}` : 'there is none'}. This is a QUESTION, not a request: nothing is changed and nothing was saved; answer it from the record in one short sentence.`];
}
const questionOnly = (t) => QUESTIONISH(t) && !ASKS_FOR_CHANGE.test(t);
function stepCore(s, heard, ctx = {}, now = Date.now()) {
  const id = s.profile && s.profile.id, p = id && care.get(id); if (!p) return null;
  heard = String(heard || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const x = s._social || (s._social = { warm: 0 }), z = zget(id), arr = care.socialOf(id), noCalls = Boolean(p.smart && p.smart.noCalls);
  if ((ctx.intent === 'smalltalk' || ctx.intent === 'followup') && ctx.safe !== false) x.warm += 1;
  let offer = z.offer && now - z.offer.at < OFFER_TTL_MS ? { ...z.offer } : null;
  // a stale or impossible offer is rejected HERE, in code: a new-call offer while a call exists, a change offer with nothing to change, or one older than its time
  if (D() && offer && ((offer.mode === 'new' && arr && !arr.revoked) || (offer.mode === 'change' && (!arr || arr.revoked)))) offer = null;
  if (z.offer && !offer) zput(id, { offer: null });
  if (noCalls) {
    if (D() && offer && offer.stage === 'restore' && offer.reconsent && arr && arr.revoked) return advance(s, id, p, offer, heard, now);   // the restart question that also asks for the fresh consent
    if (offer) zput(id, { offer: null });
    return D() ? reconsent(s, id, p, z, heard, now) : null;
  }
  if (D() && !(offer && offer.stage === 'confirm' && YES_ALONE.test(heard)) && !CANCEL.test(heard) && !SKIP.test(heard) && !READBACK.test(heard)) { const f = decision(s, id, p, arr, offer, heard, now); if (f) return f; }

  if (D() && !READBACK.test(heard)) { const q = questionReadback(p, arr, offer, heard, now, x); if (q) return q; }
  // ---- what the record says (never from memory of the conversation): "What daily calls do I have?"
  if (READBACK.test(heard)) {
    if (arr) { const v = care.socialView(p, p.reminders.find((r) => r.social)); return ['social-readback', `SAVED RECORD: a daily call at ${clockWords(arr.h, arr.mi)} (${arr.tz}), status: ${v.status}${v.next ? `, next call ${dateWords(care.localDate(v.next, arr.tz))} at ${clockWords(arr.h, arr.mi)}` : ', no next call'}. Tell them this from the record only. They can skip one call, change the time or cancel these daily calls by telling you here.`]; }
    return ['social-readback', z.cancelledAt ? `SAVED RECORD: no daily call is arranged now. One was cancelled on ${dateWords(care.localDate(z.cancelledAt, p.tz || 'UTC'))}; it did not fail to save. Say that plainly, and that they can ask for a new one.` : 'SAVED RECORD: no daily call is saved. Say so plainly; never say one is arranged or scheduled.'];
  }
  if (z.misled && now - z.misled < 3600000 && !arr && !(offer && ['confirm'].includes(offer.stage))) { zput(id, { misled: null }); return ['social-correct', 'CORRECTION: earlier you may have given the impression that a daily call is arranged. NO daily call is saved. Say so plainly in one short sentence, and ask if they would like to set one up.']; }

  // ---- the controls on a saved daily call: skip today, change the time, cancel the daily calls
  if (arr && !arr.revoked && !(offer && offer.stage === 'confirm' && YES_ALONE.test(heard))) {
    if (CANCEL.test(heard) && !s._stopTurnRan) { care.socialCancel(id, { actor: 'senior', source: 'chat', reason: 'the senior asked to cancel the daily calls' }); zput(id, { offer: null }); return ['social-cancel', 'CANCELLED: the daily calls are cancelled and no more will come. Say so in one short sentence. They can ask for them again whenever they like. Do not ask them to reconsider.']; }
    if (SKIP.test(heard)) {
      const r = care.socialSkipToday(id, now);
      if (r && r.skipped) return ['social-skip', `SKIPPED: today's call is skipped. Tomorrow's daily call is still on at ${clockWords(arr.h, arr.mi)}. Say so in one short sentence.`];
      return ['social-skip', `NOTHING TO SKIP: there is no call left today; the next one is ${r && r.nextAt ? `tomorrow at ${clockWords(arr.h, arr.mi)}` : 'not set'}. Say that in one short sentence and that they can say "skip" on the day.`];
    }
    if (CHANGE.test(heard) && !offer) { offer = { id: uid(), stage: 'collect', mode: 'change', at: now, tz: p.tz || arr.tz, time: null, start: arr.start }; zput(id, { offer }); return advance(s, id, p, offer, heard, now, true); }
  }
  if (D() && !offer && arr && !questionOnly(heard)) {
    const sl0 = slots(heard, p.tz || arr.tz, now), timeGiven = Boolean(sl0.time || sl0.ambiguous);
    const cue = CHANGE.test(heard) || (ctxValid(x, now) && timeGiven && (CALLLESS_CUE.test(heard) || /^\s*(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[.!]?\s*$/i.test(normSpeech(heard))));
    if (cue && !sl0.negated && (timeGiven || CHANGE.test(heard))) {
      if (!arr.revoked) { offer = { id: uid(), stage: 'collect', mode: 'change', at: now, tz: p.tz || arr.tz, time: null, start: arr.start }; zput(id, { offer }); return advance(s, id, p, offer, heard, now, true); }
      if (timeGiven) {   // a STOPPED call: a new time must not silently restart it; the question covers the restart and the time
        let t = sl0.time; if (!t && sl0.amb) t = with24(sl0.amb.h, sl0.amb.mi, arr.h < 12 ? 'am' : 'pm');
        offer = { id: uid(), stage: 'restore', needAsk: true, mode: 'restore', at: now, tz: p.tz || arr.tz, time: t, start: arr.start }; zput(id, { offer });
        return ['social-restore-ask', restoreAskFact(offer, offer.tz)];
      }
    }
  }
  if (arr && arr.paused === 'timezone' && !offer && p.tz) {
    offer = { id: uid(), stage: 'confirm', mode: 'change', at: now, tz: p.tz, time: { h: arr.h, mi: arr.mi }, start: arr.start, tzChanged: true };
    zput(id, { offer }); return ['social-tz', `Their time zone has changed, so the daily call is PAUSED (it did not ring and will not until they agree). Ask ONE yes/no question: should the daily call stay at ${clockWords(arr.h, arr.mi)} in their new local time (${p.tz})? Nothing is changed until they say yes.`];
  }

  if (offer) return advance(s, id, p, offer, heard, now);

  // ---- a new offer: only when everything allows it
  if (arr) return (/\b(?:call|ring)\b/i.test(heard) && !arr.revoked) ? ['social-active', `Their daily call is arranged for ${clockWords(arr.h, arr.mi)} each day (their own time). If it comes up, they can say: skip today, change the time, or cancel the daily calls.`] : null;
  const self = SELF_ASK.test(heard);
  if (!ctx.callsOk || !p.tz) return null;   // never an offer Maya cannot keep, and never a time zone guessed
  if (!self) {
    if (x.warm < WARM_MIN || ctx.safe === false || (ctx.intent !== 'smalltalk' && ctx.intent !== 'followup')) return null;
    if (z.declinedAt && now - z.declinedAt < DECLINE_MS) return null;
    if (z.offeredAt && now - z.offeredAt < OFFER_GAP_MS) return null;
    if (care.inQuiet(id, now)) return null;   // no offer at night
    if (s.outreach) return null;              // not on a call Maya started for something else
  }
  offer = { id: uid(), stage: self ? 'collect' : 'offered', mode: 'new', at: now, tz: p.tz, time: null, start: null };
  zput(id, { offer, offeredAt: now });
  if (self) return advance(s, id, p, offer, heard, now, true);
  return ['social-offer', 'SOCIAL CALL OFFER (made by the app, once): you have been chatting warmly. In one or two short sentences, in your own words, offer ONE thing: that you could ring them for a friendly chat every day at a time that suits them. It is only an offer: do not pick a time, do not say anything is arranged, scheduled or booked, and add no other question. If something they told you in this chat is clearly relevant you may mention it once, using only what they actually said; otherwise say nothing personal. Never invent an interest or an event, and never suggest they are lonely or bored.'];
}

function advance(s, id, p, offer, heard, now, fresh = false) {
  const tz = offer.tz;
  if (!p.tz || p.tz !== tz) { zput(id, { offer: null }); return null; }   // the zone changed mid-conversation: the offer lapses
  const yes = YES_ALONE.test(heard);
  if (offer.stage === 'restore') {
    if (D() && offer.needAsk) {   // a restart with a time: the confirmation must cover the restart AND that exact time, and a correction replaces the time and asks again
      const s2 = slots(heard, tz, now), cur = care.socialOf(id);
      if (s2.ambiguous && s2.amb && cur) { s2.time = with24(s2.amb.h, s2.amb.mi, cur.h < 12 ? 'am' : 'pm'); s2.ambiguous = false; }
      if (s2.time && (!offer.time || s2.time.h !== offer.time.h || s2.time.mi !== offer.time.mi)) { offer.time = s2.time; offer.asked = null; offer.at = now; zput(id, { offer }); return ['social-restore-ask', restoreAskFact(offer, tz)]; }
      if (s2.negated) { offer.asked = null; offer.at = now; zput(id, { offer }); return ['social-restore-ask', `${restoreAskFact(offer, tz)} They said that is NOT the time: ask what time they want instead, and change nothing.`]; }
      if (yes && !offer.asked) { offer.at = now; zput(id, { offer }); return ['social-restore-ask', `${restoreAskFact(offer, tz)} (They said yes, but this exact question has not been put to them yet, so nothing is restarted: ask it now.)`]; }
    }
    if (yes) {
      const oldNo = offer.reconsent ? (care.get(id).smart || {}).noCalls || null : null;
      try {
        if (offer.reconsent) { if (!offer.asked) throw new Error('The restart question was not put to them yet.'); care.persistSmart(id, { noCalls: null, callsRestored: { at: now, source: 'spoken yes to the restart question', offerId: offer.id } }); }
        const r = care.socialRestore(id, now);
        if (D() && offer.time && r && (offer.time.h !== r.h || offer.time.mi !== r.mi)) care.socialChangeTime(id, offer.time, now);
        const rec = D() ? care.socialOf(id) : r;
        if (D() && !(rec && !rec.revoked && (!offer.time || (rec.h === offer.time.h && rec.mi === offer.time.mi)))) throw new Error('The restarted call could not be read back, so it is not confirmed.');
        if (offer.reconsent) {   // the first day is read back from storage too: a restart that cannot be seen on the right day is not reported
          const pz = care.get(id), v = care.socialView(pz, pz.reminders.find((q) => q.social));
          if (!(v && v.next && care.localDate(v.next, rec.tz) === offer.start)) throw new Error('The restarted call could not be read back on the day we agreed, so it is not confirmed.');
          recordStopEvent(s, id, { type: 'restart', at: now, decision: 'fresh spoken yes to the restart question', question: offer.askedText || null, answer: { transcription: String(heard).slice(0, 160) }, restart: { time: clockWords(offer.time.h, offer.time.mi), start: offer.start, tz: offer.tz }, writeVerified: true });
        }
        s._exec = s._exec || {}; s._exec.social = true; zput(id, { offer: null, lastSave: { at: now, ok: true, op: 'restore', offerId: offer.id, rid: rec && rec.id || null } }); return ['social-restored', `RESTORED: the daily call is back on at ${clockWords(rec.h, rec.mi)} each day. Say so in one short sentence, and that they can skip a day, change the time or cancel whenever they like.`]; }
      catch (e) { if (oldNo) { care.persistSmart(id, { noCalls: oldNo, callsRestored: null }); try { const pq = care.get(id), rq = pq.reminders.find((q) => q.social); if (rq && !rq.social.revoked) care.socialRevoke(id); } catch { /* the stop stands */ } } zput(id, { offer: null, lastSave: { at: now, ok: false, op: 'restore', offerId: offer.id, error: String(e.message || '').slice(0, 100) } }); s._exec = s._exec || {}; s._exec.socialFailed = true; return ['social-failed', `NOT RESTORED: ${e.message} Tell them plainly that it is not back on and that it stays stopped. Do not say scheduled or arranged.`]; }
    }
    if (isDecline(heard)) { zput(id, { offer: null }); return ['social-declined', 'They do not want the daily call back. Accept it in one short, friendly sentence.']; }
    return null;
  }
  const sl = slots(heard, tz, now);
  const was = { time: offer.time, start: offer.start };
  const hadConfirm = offer.stage === 'confirm';
  // Split speech ("at five ten" / "every morning starting" / "today" / "am"): ONE pending proposal keeps what each fragment gave. A bare am/pm (or a daypart) settles the clock time that was waiting for it; a bare am/pm that comes first waits for the time.
  if (D()) {
    const apm = AP_ONLY.exec(String(heard || ''));
    if (sl.ambiguous && sl.amb) { const cur = offer.mode === 'change' ? care.socialOf(id) : null; let ap = offer.ap || (sl.daypart ? apOf(sl.daypart) : null); if (!ap && cur) { ap = cur.h < 12 ? 'am' : 'pm'; offer.inferred = true; }  /* a change keeps the half of the day of the call they have; the read-back says it aloud so they can correct it */ if (ap) { sl.time = with24(sl.amb.h, sl.amb.mi, ap); sl.ambiguous = false; offer.ap = null; offer.amb = null; } else offer.amb = sl.amb; }
    else if (apm || (sl.daypart && offer.amb && !sl.time)) { const ap = apOf(apm ? apm[1] : sl.daypart); if (offer.amb) { sl.time = with24(offer.amb.h, offer.amb.mi, ap); offer.amb = null; sl.vague = false; } else if (apm) { offer.ap = ap; sl.apOnly = true; } }
    else if (sl.daypart && !sl.time && !sl.ambiguous && !offer.amb) offer.ap = apOf(sl.daypart);   // "every morning" said first: the clock time that follows is a morning one
    if (sl.time) offer.amb = null;
  }
  if (D() && sl.negated && !yes) {   // "not 6:57" alone: that time is NOT selected. If it was the pending time the proposal is withdrawn; otherwise the pending proposal stands and is asked again
    const same = offer.time && sl.negTimes.some((n) => n.mi === offer.time.mi && n.h12 === (offer.time.h % 12 || 12) && (!n.ap || (offer.time.h < 12) === (n.ap === 'am')));
    if (offer.time && !same) { offer.asked = null; offer.at = now; zput(id, { offer }); return [offer.mode === 'change' ? 'social-confirm' : 'social-confirm', `${offer.mode === 'change' ? confirmChangeFact(offer, tz) : confirmFact(offer, tz)} They said a DIFFERENT time is not what they want: nothing changes; the pending proposal is still the one above.`]; }
    offer.time = null; offer.amb = null; offer.asked = null; offer.stage = 'collect'; offer.at = now; zput(id, { offer });
    return ['social-ask', `${offer.mode === 'change' ? 'SOCIAL CALL, CHANGE OF TIME (nothing is changed yet)' : askFact(offer).split(':')[0]}: they said that time is NOT what they want. Withdraw it, change nothing, and ask ONE question: what time would they like instead? (${NEED.time}).`];
  }
  const restated = !yes && confirmsProposal(heard, offer, tz, now);
  // a plain yes to the confirm question (or a yes that only restates it) is the only thing that saves, and only a confirm question that was really SPOKEN counts (noteSpoken): a proposal Maya never said aloud cannot be agreed to
  if (hadConfirm && (yes || restated) && offer.time && (offer.start || offer.mode === 'change')) {
    if (D() && !offer.asked) { offer.stage = 'confirm'; offer.at = now; zput(id, { offer }); return [offer.mode === 'change' ? 'social-confirm' : 'social-confirm', (offer.mode === 'change' ? confirmChangeFact(offer, tz) : confirmFact(offer, tz)) + ' (They said yes, but this exact question has not been put to them yet, so nothing is saved: ask it now.)']; }
    return save(s, id, offer, now);
  }
  let correction = '';
  if (sl.time) { if (was.time && (was.time.h !== sl.time.h || was.time.mi !== sl.time.mi)) correction = 'They corrected the time: acknowledge the new time in a few words (for example that you have noted it) and carry on; there is no limit on how many times they may change it.'; offer.time = sl.time; }
  if (sl.start && offer.mode !== 'change') { if (was.start && was.start !== sl.start) correction = correction || 'They corrected the start day: acknowledge it in a few words and carry on.'; offer.start = sl.start; }
  const changed = (sl.time && (!was.time || was.time.h !== sl.time.h || was.time.mi !== sl.time.mi)) || (sl.start && was.start !== sl.start);
  if (!changed && !yes && !fresh && (offer.stage === 'confirm') && /^\s*(?:yes|yeah|yep|sure|ok(?:ay)?)\b[^.?!]*\b(?:but|except|only|unless|though|however)\b/i.test(heard)) {
    offer.stage = 'collect'; offer.at = now; offer.asked = null; zput(id, { offer });   // the old question no longer stands: a later bare yes does not save it
    return ['social-condition', 'They said yes BUT added a condition. NOTHING is saved. Ask ONE short question about what they would like to change, and do not say anything is arranged, noted or scheduled.'];
  }
  const corrected = isCorrection(heard) && !yes;
  const related = fresh || yes || changed || sl.daily || sl.notDaily || sl.ambiguous || sl.vague || sl.apOnly || corrected || Boolean(sl.time && offer.stage === 'collect') || isDecline(heard);
  if (!related) return null;   // something else was said: the offer waits (it lapses by itself), nothing is asked twice
  if (!changed && !fresh && isDecline(heard) && !yes) {
    zput(id, { offer: null, ...(offer.mode === 'new' ? { declinedAt: now } : {}) });
    return ['social-declined', offer.mode === 'new' ? 'They do not want the daily call. Accept that in one short, friendly sentence. Do not persuade and do not offer again.' : 'They do not want to change the call time. Accept that in one short sentence; the daily call stays as it is.'];
  }
  if (changed || corrected || sl.apOnly) offer.asked = null;   // the proposal moved: the old spoken question no longer stands
  offer.at = now;
  // the quiet hours
  if (offer.time && care.hourQuiet(p, offer.time.h)) {
    offer.time = null; offer.stage = 'collect'; zput(id, { offer });
    return ['social-quiet', `QUIET HOURS: that time falls in their quiet hours (${quietWords()} where they are), when you do not ring. Tell them kindly in one short sentence, and ask what other time suits them. Do NOT move it to another time yourself.`];
  }
  // a start today whose time has already passed
  if (offer.mode !== 'change' && offer.start && offer.time) {
    const t = nowParts(tz, now), today = `${t.y}-${pad2(t.m)}-${pad2(t.d)}`;
    if (offer.start < today || (offer.start === today && (offer.time.h * 60 + offer.time.mi) <= t.h * 60 + t.mi + 1)) { offer.start = null; offer.stage = 'collect'; zput(id, { offer }); return ['social-past', `That start is already in the past. Say so kindly and ask ONE question: which day should the daily calls start (tomorrow, or a later day)?${correction ? ` ${correction}` : ''}`]; }
  }
  const pre = D() && !offer.ack && offer.mode === 'new' ? predecessor(id, p, now) : '';
  if (pre) offer.ack = true;
  if (corrected && !changed) correction = correction || 'They said "no" but that was a CORRECTION of something you said, NOT a refusal of the call: nothing is cancelled and the call is still wanted. Acknowledge it in a few words, put right whatever they objected to (you CAN set up this daily call yourself: the family is not needed, and a registered phone is not needed to be called through Maya open in a browser or the app), and ask the confirm question again.';
  const notes = [pre, correction, sl.notDaily ? 'They mentioned a different rhythm: say plainly that this is a DAILY call only, and ask if daily suits them.' : '', sl.ambiguous ? 'The time they gave could be morning or evening: ask whether it is am or pm.' : '', sl.vague && !sl.time ? 'What they gave is not a clock time: ask what time exactly.' : ''].filter(Boolean).join(' ');
  if (offer.mode === 'change') {
    if (!offer.time) { offer.stage = 'collect'; zput(id, { offer }); return ['social-ask', `SOCIAL CALL, CHANGE OF TIME (nothing is changed yet): ask ONE question: what time would they like the daily call instead? ${NEED.time}.${notes ? ` ${notes}` : ''}`]; }
    offer.stage = 'confirm'; zput(id, { offer }); return ['social-confirm', confirmChangeFact(offer, tz, notes)];
  }
  if (!offer.time || !offer.start) { offer.stage = 'collect'; zput(id, { offer }); return ['social-ask', askFact(offer, notes)]; }
  offer.stage = 'confirm'; zput(id, { offer });
  return ['social-confirm', confirmFact(offer, tz, notes)];
}

function save(s, id, offer, now = Date.now()) {
  s._exec = s._exec || {};
  const at = { h: offer.time.h, mi: offer.time.mi };
  zput(id, { lastSave: { at: now, ok: null, op: offer.mode, offerId: offer.id, ...at } });   // started, not yet confirmed: if the write never reports back the card says UNKNOWN, not "never tried"
  let err = null, r = null;
  try { r = offer.mode === 'change' ? care.socialChangeTime(id, offer.time, now) : care.socialSave(id, { offerId: offer.id, h: offer.time.h, mi: offer.time.mi, start: offer.start, tz: offer.tz }, now); } catch (e) { err = e; }
  // The RESULT is what storage says afterwards, never what the write call returned: match = committed, nomatch = not committed, unreadable = nobody can say (an uncertain write is never reported as done, and never as "nothing changed").
  let v, rec = null;
  if (!D()) v = err ? 'nomatch' : 'match';
  else { try { rec = care.socialOf(id); v = rec && !rec.revoked && rec.h === offer.time.h && rec.mi === offer.time.mi && rec.tz === offer.tz ? 'match' : 'nomatch'; } catch { v = 'unreadable'; } }
  if (v === 'match') {
    rec = rec || care.socialOf(id) || r;
    zput(id, { offer: null, lastSave: { at: now, ok: true, op: offer.mode, offerId: offer.id, rid: (r && r.id) || (rec && rec.id) || null, ...at } }); s._exec.social = true;
    const when = `${clockWords(rec.h, rec.mi)} ${rec.tz}`;   // the words come from the PERSISTED record, not from what was proposed
    return ['social-saved', offer.mode === 'change'
      ? `CHANGED (read from the saved record): the daily call is now at ${when}. Tell them in your own words, in ONE short sentence, this content: "Your daily call is now at ${when}; you can tell me here anytime to skip one call, change the time, or cancel these daily calls." Promise nothing else.`
      : `SAVED (read from the saved record): a call from you every day at ${when}, starting ${dateWords(rec.start)}. Tell them in your own words, in ONE short sentence, this content: "Your daily call is saved for ${when}, starting ${dateWords(rec.start)}; you can tell me here anytime to skip one call, change the time, or cancel these daily calls." Promise nothing else.`];
  }
  if (v === 'unreadable') {
    zput(id, { offer: null, lastSave: { at: now, ok: null, unverified: true, op: offer.mode, offerId: offer.id, ...at } }); s._exec.socialUnknown = true;
    return ['social-uncertain', `RESULT NOT VERIFIED (nothing is confirmed either way): the app asked to ${offer.mode === 'change' ? `move the daily call to ${clockWords(offer.time.h, offer.time.mi)}` : `save the daily call at ${clockWords(offer.time.h, offer.time.mi)}`} but could not read the saved record afterwards. Tell them plainly, in one short sentence, that you could not confirm whether it went through, so they should not count on it yet and can ask you to read back what is saved in a moment. Do NOT say it is done, saved, changed or scheduled, do NOT say nothing changed, and do NOT ask them to confirm again.`];
  }
  const why = String((err && err.message) || 'the saved call did not match what was agreed').slice(0, 140);
  zput(id, { offer: null, lastSave: { at: now, ok: false, op: offer.mode, offerId: offer.id, error: why.slice(0, 100), ...at } }); s._exec.socialFailed = true;
  const old = rec && !rec.revoked ? `Their existing daily call is UNCHANGED at ${clockWords(rec.h, rec.mi)}.` : '';
  return ['social-failed', `NOT SAVED: ${why} Tell them plainly, in one short sentence, that it did not work${old ? ' and the call stays as it was' : ' and nothing is set up'}. ${old} Do NOT say scheduled, arranged, changed, moved or done, do not say you will try again by yourself, and do NOT ask them to confirm it again.`];
}

// A sentence that says a call is arranged / noted / saved while nothing is saved must never be spoken or shown (smart.breaks checks every piece BEFORE it is spoken): "Got it, 3:40 noted",
// "I've scheduled it", "I'll call you at 3". A denial ("nothing is scheduled yet") is not a claim.
const ARRANGED = /\b(?:noted|locked in|lock(?:ed)? it in|scheduled|arranged|booked|all set|set up|saved|i(?:'ll| will) (?:call|ring|phone) you|i(?:'ve| have) (?:got|put) (?:it|that|you) (?:down|in)|see you (?:at|then|tomorrow))\b/i;
const CALL_CONTEXT = /\b(?:call|ring|chat|daily)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/i;
const DENIAL = /\b(?:not|no|nothing|isn'?t|hasn'?t|haven'?t|didn'?t|can'?t|cannot|yet|unless|if|would|could|once|until)\b/i;
// GUARD (state): promises of an arrangement that are not worded "scheduled": "I'll get that 5:13 call ready for you", "I'll pass that along", "I'll get that set", "on it".
const COMMIT = /\bI(?:'ll| will|'m going to| am going to)\s+(?:\w+\s+){0,2}(?:get|set|put|sort|line up|have|make|arrange|pass|send|book|note|jot)\b[^.?!]{0,30}\b(?:ready|set|up|along|down|in place|sorted|booked|for you|that|it|this)\b|\bready for you\b|\bpass(?:ing)?\s+(?:that|it|this)\s+along\b|\bgot (?:it|that) down\b|\bon it\b|\bI(?:'ve| have) (?:got|made|put|set|noted|written)\b[^.?!]{0,20}\b(?:that|it|this|down|up)\b/i;
const G = () => require('./smart').stateFlag('GUARD');
const CHANGED_CLAIM = /\b(?:done|all set|(?:it'?s|that'?s|it is|that is|is|now)\s+(?:changed|moved|updated|switched|rescheduled)|(?:changed|moved|updated|switched|rescheduled)\s+(?:it|that|your|the))\b/i;
const promises = (t, s) => ARRANGED.test(t) || (G() && CHANGED_CLAIM.test(t) && !/\?\s*$/.test(t)) || (G() && COMMIT.test(t) && (CALL_CONTEXT.test(t) || CALL_CONTEXT.test(String(s && s.lastHeard ? s.lastHeard() : ''))));
function claimsScheduled(text) { const t = String(text || ''); return ARRANGED.test(t) && CALL_CONTEXT.test(t) && !DENIAL.test(t); }
// May a sentence claiming a call is arranged be said on this turn? Only when the record says so: saved this turn, read back from the record, or an ordinary reminder was saved.
const OK_LABELS = /^(?:social-(?:saved|readback|active|restored|skip|tz)|setrem-saved)/;
const PENDING_LABELS = /^social-(?:offer|ask|confirm|restore-ask|uncertain|failed|declined|quiet|past|condition|cancel|correct|decide-(?:days|second|ambiguous|which|revoked))/;
function claimBlocked(text, s) {
  const labels = s.factLabels || [], id = s.profile && s.profile.id;
  if (s._exec && s._exec.social) return false;
  const t = String(text || '');
  if (labels.some((l) => PENDING_LABELS.test(l)) && promises(t, s) && !DENIAL.test(t)) return true;   // in a turn about the daily call, "all set" / "scheduled" / "noted" can only mean that call
  if (!claimsScheduled(text) && !(G() && promises(t, s) && !DENIAL.test(t) && !labels.some((l) => OK_LABELS.test(l)))) return false;
  if (labels.some((l) => OK_LABELS.test(l))) return false;
  if (s._exec && s._exec.reminder && !/\d|\bdaily\b|\bevery day\b/i.test(t)) return false;   // the senior has an ordinary reminder and this names no time: the older rule (smart.js CLAIM) judges it
  return !(id && care.socialOf(id));
}
// A claim got through (or was said before it could be stopped): the next turn corrects the impression.
// What Maya REALLY said aloud: a confirm question that was spoken (a question naming the proposed time) is the one a later yes binds to. Nothing else binds it.
function timesIn(text) { const out = [], re = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)?\b/gi; let m; while ((m = re.exec(text))) { const h = Number(m[1]), mi = Number(m[2] || 0); if (h >= 0 && h <= 24 && (m[2] || m[3])) out.push({ h, mi, ap: m[3] ? m[3].toLowerCase() : null }); } return out; }
function markAsked(id, text, now = Date.now()) {
  const z = zget(id), o = z.offer; if (!o || !(o.stage === 'confirm' || (o.stage === 'restore' && o.needAsk)) || o.asked || !o.time || !/\?/.test(text)) return;
  const ok = timesIn(String(text)).some((t) => t.h % 12 === o.time.h % 12 && t.mi === o.time.mi && (!t.ap || (t.ap === 'am') === (o.time.h < 12)));
  if (ok) zput(id, { offer: { ...o, asked: { at: now }, askedText: String(text).slice(0, 200) } });
}
// The scoped stop question counts as ASKED only when the spoken words really put it (they name the daily call time or stopping calls, as a question).
function markStopAsked(id, text, now = Date.now()) {
  const za = zget(id).stopAsk; if (!za || za.asked || !/\?/.test(text)) return;
  const named = za.h != null ? timesIn(String(text)).some((t) => t.h % 12 === za.h % 12 && t.mi === za.mi) : /\bcalling you\b|\bstop (?:your|my|the)\b/i.test(text);
  if (named && /\bstop/i.test(text)) zput(id, { stopAsk: { ...za, asked: { at: now, said: String(text).slice(0, 200) } } });
}
// The confirm question is OWED when this turn's fact asked for one, the proposal is complete and Spark's words did not put it (a vague "Got that, 6:05", or a wrong draft replaced by a plain line that named nothing):
// code then says the exact read-back itself, once, with the complete time. A yes binds to THIS, never to a proposal nobody heard.
function owedReadback(s) {
  if (!D()) return null;
  const id = s.profile && s.profile.id; if (!id) return null;
  const za = zget(id).stopAsk; if (za && !za.asked && (s.factLabels || []).includes('social-stop-ask')) return za.question;   // the scoped stop question, in code, when Spark's words did not put it
  const o = zget(id).offer;
  if (!o || !(o.stage === 'confirm' || (o.stage === 'restore' && o.needAsk)) || o.asked || !o.time) return null;
  if (!(s.factLabels || []).some((l) => /^social-(?:confirm|decide-ambiguous|restore-ask)/.test(l))) return null;
  if (o.mode === 'restore' && o.reconsent) return `Just to check: your daily call is stopped. Shall I start calling you again every day at ${clockWords(o.time.h, o.time.mi)}, starting ${dateWords(o.start)}? It stays stopped until you say yes.`;
  if (o.mode === 'restore') return `Just to check: your daily call is stopped. Shall I start it again at ${clockWords(o.time.h, o.time.mi)}? It stays stopped until you say yes.`;
  if (o.mode === 'change') return `Just to check: shall I move your daily call to ${clockWords(o.time.h, o.time.mi)}? It stays as it is until you say yes.`;
  if (o.mode === 'new' && o.start) return `Just to check: shall I call you every day at ${clockWords(o.time.h, o.time.mi)}, starting ${dateWords(o.start)}? Nothing is saved until you say yes.`;
  return null;
}
function noteSpoken(s, text) {
  const id = s.profile && s.profile.id; if (!id) return;
  if (D()) markAsked(id, text);
  markStopAsked(id, text);
  if (!claimBlocked(text, s)) return;
  zput(id, { misled: Date.now() });
}

module.exports = { stopTurn, stopClass, recordStopEvent, owedReadback, markAsked, normSpeech, isDecline, confirmsProposal, step, claims, onNoCalls, onCallsBack, claimsScheduled, claimBlocked, noteSpoken, slots, YES_ALONE, isYes, SELF_ASK, clockWords, dateWords, WARM_MIN, DECLINE_MS, OFFER_TTL_MS };
