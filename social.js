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

const YES_ALONE = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please do|go ahead|that'?s right|that is right|correct|sounds good|yes,? please|yes,? that'?s (?:right|fine|good))\s*[.!]*\s*$/i;
const DECLINE = /^\s*(?:no|nope|nah)\b|\bnot (?:now|today|really|interested)\b|\bno,? thanks?\b|\bno,? thank you\b|\bmaybe later\b|\bi(?:'d| would) rather not\b|\bi don'?t (?:want|need)\b|\bleave it\b/i;
const VAGUE = /\b(?:after (?:lunch|dinner|breakfast|tea|supper|my (?:nap|walk))|before (?:lunch|dinner|bed)|sometime|some time|later|whenever|any ?time|in the (?:morning|afternoon|evening)|afternoon|morning|evening|around then)\b/i;
const SKIP = /\b(?:skip|miss|pass on)\b[^.?!]{0,25}\b(?:today|this one|the call)\b|\bdon'?t call me today\b|\bno call today\b|\bnot today\b/i;
const CANCEL = /\b(?:cancel|end|delete|remove|turn off|stop)\b[^.?!]{0,20}\b(?:daily|every ?day|regular|these|the|my)\b[^.?!]{0,12}\bcalls?\b|\bno more daily calls\b/i;
const CHANGE = /\b(?:change|move|switch|reschedule|make)\b[^.?!]{0,25}\b(?:call|time|chat)\b|\bcall me (?:at|around)\b[^.?!]{0,15}\binstead\b/i;
// The senior asking for a daily call themselves (so a recent "no" does not apply): "call me every day", "can you ring me daily".
const SELF_ASK = /\b(?:can|could|would|will) you (?:please )?(?:call|ring|phone) me\b[^.?!]{0,40}\b(?:every ?day|daily|each day|every (?:morning|afternoon|evening))\b|\b(?:call|ring|phone) me (?:every ?day|daily|each day|every (?:morning|afternoon|evening))\b|\bi(?:'d| would) (?:like|love) (?:you to |a )?(?:call|ring|chat)[^.?!]{0,30}\b(?:every ?day|daily)\b/i;

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
  return Boolean(SELF_ASK.test(String(heard || '')) && !arr);
}

// "Stop calling me" reaches the scheduler: the saved chat and any queued ring stop at once (the senior's other reminders are untouched).
function onNoCalls(id) { zput(id, { offer: null }); return care.socialRevoke(id); }
// "You can call me again": the permission to offer is back, but a revoked daily chat is NOT switched on by that: it is asked about, and only a plain yes to that question restores it.
function onCallsBack(id, now = Date.now()) {
  const arr = care.socialOf(id); if (!arr || !arr.revoked) return null;
  zput(id, { offer: { id: uid(), stage: 'restore', mode: 'restore', at: now, tz: arr.tz, time: { h: arr.h, mi: arr.mi }, start: arr.start } });
  return `They asked for calls again. They used to have a daily call from you at ${clockWords(arr.h, arr.mi)} (their time) that was stopped. It is NOT back on. Ask ONE yes/no question: do they want that daily call back at ${clockWords(arr.h, arr.mi)}? Only a plain yes to that question brings it back; say nothing is scheduled until then.`;
}

function slots(heard, tz, now) {
  const { found } = setrem.readTime(heard, { bare: true }), out = { time: null, start: null, daily: false, notDaily: false, ambiguous: false, vague: false };
  if (found.clock) { const c = setrem.resolveClock(found.clock, found.daypart); if (c.ok) out.time = { h: c.h, mi: c.mi }; else if (c.ambiguous) out.ambiguous = true; }
  else if (found.daypart || VAGUE.test(heard)) out.vague = true;
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
const confirmFact = (offer, tz, extra = '') => `SOCIAL CALL, CONFIRM (nothing is saved yet): ask ONE yes/no question that says all of it: a call from you EVERY DAY, starting ${dateWords(offer.start)}, at ${clockWords(offer.time.h, offer.time.mi)}, in their own local time (${tz}). Do not say it is scheduled, arranged or booked: it is only saved if they answer yes to this question.${extra ? ` ${extra}` : ''}`;
const confirmChangeFact = (offer, tz, extra = '') => `SOCIAL CALL, CHANGE OF TIME (nothing is changed yet): ask ONE yes/no question: should the daily call move to ${clockWords(offer.time.h, offer.time.mi)}, their local time (${tz})? It only changes if they answer yes to that question.${extra ? ` ${extra}` : ''}`;

// One turn of the daily-call flow. Returns [label, text] or null. s = the Call/Chat object, ctx = { intent, callsOk, safe }.
function step(s, heard, ctx = {}, now = Date.now()) {
  const id = s.profile && s.profile.id, p = id && care.get(id); if (!p) return null;
  heard = String(heard || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const x = s._social || (s._social = { warm: 0 }), z = zget(id), arr = care.socialOf(id), noCalls = Boolean(p.smart && p.smart.noCalls);
  if ((ctx.intent === 'smalltalk' || ctx.intent === 'followup') && ctx.safe !== false) x.warm += 1;
  let offer = z.offer && now - z.offer.at < OFFER_TTL_MS ? { ...z.offer } : null;
  if (z.offer && !offer) zput(id, { offer: null });
  if (noCalls) { if (offer) zput(id, { offer: null }); return null; }

  // ---- the controls on a saved daily call: skip today, change the time, cancel the daily calls
  if (arr && !arr.revoked && !(offer && offer.stage === 'confirm' && YES_ALONE.test(heard))) {
    if (CANCEL.test(heard)) { care.socialCancel(id); zput(id, { offer: null }); return ['social-cancel', 'CANCELLED: the daily calls are cancelled and no more will come. Say so in one short sentence. They can ask for them again whenever they like. Do not ask them to reconsider.']; }
    if (SKIP.test(heard)) {
      const r = care.socialSkipToday(id, now);
      if (r && r.skipped) return ['social-skip', `SKIPPED: today's call is skipped. Tomorrow's daily call is still on at ${clockWords(arr.h, arr.mi)}. Say so in one short sentence.`];
      return ['social-skip', `NOTHING TO SKIP: there is no call left today; the next one is ${r && r.nextAt ? `tomorrow at ${clockWords(arr.h, arr.mi)}` : 'not set'}. Say that in one short sentence and that they can say "skip" on the day.`];
    }
    if (CHANGE.test(heard) && !offer) { offer = { id: uid(), stage: 'collect', mode: 'change', at: now, tz: p.tz || arr.tz, time: null, start: arr.start }; zput(id, { offer }); return advance(s, id, p, offer, heard, now, true); }
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
    if (yes) {
      try { const r = care.socialRestore(id, now); zput(id, { offer: null }); return ['social-restored', `RESTORED: the daily call is back on at ${clockWords(r.h, r.mi)} each day. Say so in one short sentence, and that they can skip a day, change the time or cancel whenever they like.`]; }
      catch (e) { zput(id, { offer: null }); return ['social-failed', `NOT RESTORED: ${e.message} Tell them plainly that it is not back on. Do not say scheduled or arranged.`]; }
    }
    if (DECLINE.test(heard)) { zput(id, { offer: null }); return ['social-declined', 'They do not want the daily call back. Accept it in one short, friendly sentence.']; }
    return null;
  }
  const sl = slots(heard, tz, now);
  const was = { time: offer.time, start: offer.start };
  const hadConfirm = offer.stage === 'confirm';
  // a plain yes to the confirm question is the only thing that saves
  if (hadConfirm && yes && offer.time && (offer.start || offer.mode === 'change')) return save(s, id, offer, now);
  let correction = '';
  if (sl.time) { if (was.time && (was.time.h !== sl.time.h || was.time.mi !== sl.time.mi)) correction = 'They corrected the time: acknowledge the new time in a few words (for example that you have noted it) and carry on; there is no limit on how many times they may change it.'; offer.time = sl.time; }
  if (sl.start && offer.mode !== 'change') { if (was.start && was.start !== sl.start) correction = correction || 'They corrected the start day: acknowledge it in a few words and carry on.'; offer.start = sl.start; }
  const changed = (sl.time && (!was.time || was.time.h !== sl.time.h || was.time.mi !== sl.time.mi)) || (sl.start && was.start !== sl.start);
  const related = fresh || yes || changed || sl.daily || sl.notDaily || sl.ambiguous || sl.vague || DECLINE.test(heard);
  if (!related) return null;   // something else was said: the offer waits (it lapses by itself), nothing is asked twice
  if (!changed && !fresh && DECLINE.test(heard) && !yes) {
    zput(id, { offer: null, ...(offer.mode === 'new' ? { declinedAt: now } : {}) });
    return ['social-declined', offer.mode === 'new' ? 'They do not want the daily call. Accept that in one short, friendly sentence. Do not persuade and do not offer again.' : 'They do not want to change the call time. Accept that in one short sentence; the daily call stays as it is.'];
  }
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
  const notes = [correction, sl.notDaily ? 'They mentioned a different rhythm: say plainly that this is a DAILY call only, and ask if daily suits them.' : '', sl.ambiguous ? 'The time they gave could be morning or evening: ask whether it is am or pm.' : '', sl.vague && !sl.time ? 'What they gave is not a clock time: ask what time exactly.' : ''].filter(Boolean).join(' ');
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
  try {
    const r = offer.mode === 'change' ? care.socialChangeTime(id, offer.time, now) : care.socialSave(id, { offerId: offer.id, h: offer.time.h, mi: offer.time.mi, start: offer.start, tz: offer.tz }, now);
    zput(id, { offer: null }); s._exec.social = true;
    return ['social-saved', `${offer.mode === 'change' ? 'CHANGED' : 'SAVED'} (the record exists now): a call from you every day at ${clockWords(r.h, r.mi)}, their own local time${offer.mode === 'change' ? '' : `, starting ${dateWords(offer.start)}`}. You may now say it is arranged, in one short sentence. Add, in plain words, that they can skip a day, change the time or cancel the daily calls whenever they like. Promise nothing else.`];
  } catch (e) {
    zput(id, { offer: null }); s._exec.socialFailed = true;
    return ['social-failed', `NOT SAVED: ${String(e.message || 'it did not work').slice(0, 140)} Tell them plainly, in one short sentence, that it did not work and nothing is set up. Do NOT say scheduled, arranged or booked, and do not say you will try again by yourself.`];
  }
}

// A draft that says the call is arranged while nothing is saved must be written again (smart.js breaks()).
const SCHEDULED_CLAIM = /\b(?:i(?:'ve| have| will)?\s+(?:scheduled|arranged|booked|set (?:it|that|this) up)|(?:is|'s|has been|have been|all)\s+(?:scheduled|arranged|booked)|i(?:'ll| will) call you (?:every|each|tomorrow|daily))\b/i;
function claimsScheduled(text) { return SCHEDULED_CLAIM.test(String(text || '')); }

module.exports = { step, claims, onNoCalls, onCallsBack, claimsScheduled, slots, YES_ALONE, SELF_ASK, clockWords, dateWords, WARM_MIN, DECLINE_MS, OFFER_TTL_MS };
