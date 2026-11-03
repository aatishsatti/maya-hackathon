// Memory that thinks (step 1): pure rules for WHICH memory matters now and WHICH open follow-up is due. No network, no Spark, no stored state.
// CODE ONLY SELECTS AND DECIDES. Everything it returns is a fact (who, what, a date already worked out); it never returns a sentence for
// Maya to say. Spark phrases every word, from the facts and the principles in brain.js.
//
// Memory shape (see memory.js): { people:[{name,relationship,birthday,stories:[{text,told}]}], events:[{who,text,date,told}],
// preferences:[{who,text,told}], current:[{who,text,told}], topics:[{text,told}], threads:[Thread] }
// Thread: { who, text, due:'YYYY-MM-DD'|'', kind:'event'|'worry'|'plan'|'reminder', status:'open'|'closed'|'expired', asked:number, told:'YYYY-MM-DD' }
// A 'reminder' is a next-call note the person asked for ("remind me next time I call to ..."): only CODE creates one (parseNextCallReminder, memory.addReminder),
// it carries fromCall (the call it was asked in) and, once shown, deliveredCall; Spark may only close it at filing.

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MD = /^\d{2}-\d{2}$/;
const utc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

// Whole days from a to b (both YYYY-MM-DD); positive when b is later. NaN if either is not a date.
function daysBetween(a, b) {
  if (!ISO.test(String(a)) || !ISO.test(String(b))) return NaN;
  return Math.round((utc(b) - utc(a)) / DAY);
}

// Plain-words relation of a day count: 0 today, 1 tomorrow, -1 yesterday, else "in N days" / "N days ago".
function rel(days) {
  if (!Number.isFinite(days)) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

// A date fact for an absolute date (YYYY-MM-DD) or a yearly one (MM-DD, e.g. a birthday: its next occurrence, today included).
function dateFact(date, today) {
  const d = String(date || '');
  if (ISO.test(d)) { const days = daysBetween(today, d); return Number.isFinite(days) ? { days, text: rel(days) } : null; }
  if (MD.test(d) && ISO.test(String(today))) {
    const y = +today.slice(0, 4);
    let next = `${y}-${d}`;
    if (!Number.isFinite(daysBetween(today, next))) return null;
    if (daysBetween(today, next) < 0) next = `${y + 1}-${d}`;
    const days = daysBetween(today, next);
    return { days, text: rel(days) };
  }
  return null;
}

const STOP = new Set('a an and are as at be been but by can could did do does for from had has have he her him his i if in into is it its me my of on or our she so than that the their them then there they this to too us was we were what when where which who will with would you your'.split(' '));
const words = (t) => (String(t || '').toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}]+/gu) || [])
  .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).filter((w) => w.length > 2 && !STOP.has(w));

// How well one memory item matches what the person just said. who = name the item is about. Zero means unrelated.
function score(item, userText, today) {
  const u = new Set(words(userText));
  if (!u.size) return 0;
  const hit = words(item.text).filter((w) => u.has(w)).length;
  const named = item.who && words(item.who).some((w) => u.has(w)) ? 3 : 0;
  if (!hit && !named) return 0;                         // no connection: recency alone never makes it relevant
  const age = ISO.test(String(item.told)) && ISO.test(String(today)) ? daysBetween(item.told, today) : 99;
  return hit * 2 + named + (age >= 0 && age <= 7 ? 1 : 0);
}

// The few items worth putting in front of Spark for this turn. Returns [{ kind, who, text, told, score }], best first, at most k.
// People are matched by name (and by what was told about them); a person named in the turn always brings their relationship.
function select(memory, userText, today, { k = 6 } = {}) {
  const m = memory || {};
  const out = [];
  const add = (kind, item, extra = {}) => { const s = score(item, userText, today); if (s > 0) out.push({ kind, who: item.who || '', text: item.text, told: item.told || '', score: s, ...extra }); };
  for (const p of m.people || []) {
    const named = words(p.name).some((w) => new Set(words(userText)).has(w));
    if (named) out.push({ kind: 'person', who: p.name, text: p.relationship ? `${p.name}, ${p.relationship}` : p.name, told: '', score: 5 });
    for (const s of p.stories || []) add('story', { who: p.name, text: s.text, told: s.told });
  }
  for (const e of m.events || []) add('event', e, { date: e.date || '' });
  for (const x of m.preferences || []) add('likes', x);
  for (const x of m.current || []) add('current', x);
  for (const x of m.topics || []) add('topic', x);
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(0, k));
}

// Dates that deserve a mention whatever they said: birthdays in the next 7 days and dated events from 3 days ahead to 7 days back.
function upcoming(memory, today) {
  const m = memory || {};
  const out = [];
  for (const p of m.people || []) { const f = dateFact(p.birthday, today); if (f && f.days >= 0 && f.days <= 7) out.push({ kind: 'birthday', who: p.name, text: `${p.name}'s birthday`, when: f.text, days: f.days }); }
  for (const e of m.events || []) { const f = dateFact(e.date, today); if (f && ISO.test(String(e.date)) && f.days <= 3 && f.days >= -7) out.push({ kind: 'event', who: e.who || '', text: e.text, when: f.text, days: f.days }); }
  return out.sort((a, b) => Math.abs(a.days) - Math.abs(b.days));
}

// A deliberately wide net for "this is not a moment for a follow-up": distress, fear, loss, pain, giving up, any contraction of not wanting
// to live. It only ever BLOCKS a follow-up (never alerts, never decides care), so a false positive costs one missed question and nothing else.
const HEAVY_TALK = new RegExp(String.raw`\b(die|died|dying|dead|death|suicid\w*|kill\w*|end (it|my life|things)|(do not|don'?t|dont|no longer|not) (want|wish) to (live|be here|go on|wake|carry on|exist)|wish i (was|were) (dead|gone)|no (point|reason|hope)|give up|giving up|hopeless|worthless|burden|can'?t (go on|cope|take|manage|breathe)|cannot (go on|cope|take|manage|breathe)|lonely|alone|sad|scared|afraid|frightened|terrified|worried|worry|anxious|panic\w*|cry|crying|cried|upset|depress\w*|grie\w*|miss(ing)? (him|her|them)|pain\w*|hurt\w*|ache\w*|sore|fell|fall|dizz\w*|faint\w*|chest|bleed\w*|hospital|ambulance|emergency|help me|scam|fraud|money|bank)\b`, 'i');
const heavyTalk = (text) => HEAVY_TALK.test(String(text || '').replace(/[\u2018\u2019]/g, "'"));

const OPEN_WORRY_DAYS = 10;   // an undated worry or plan is followed up from the next day until this many days after it was told
const REMINDER_DAYS = 30;     // a next-call reminder nobody got to deliver still stands this long
const DATED_GRACE_DAYS = 14;  // a dated thread is still worth one gentle ask for this long after its date; later it is just over

// Which open thread, if any, should be offered to Spark in this call. At most one.
// ctx: { heavy: the moment is heavy/careful, askedThisCall: a follow-up was already offered in this call }.
function dueThread(threads, today, { heavy = false, askedThisCall = false, callId = '' } = {}) {
  if (heavy || askedThisCall) return null;
  const live = [];
  for (const t of threads || []) {
    if (!t || t.status !== 'open' || !String(t.text || '').trim()) continue;
    if (t.kind === 'reminder') {          // due from the NEXT call (never the call it was asked in), shown once, ahead of every other thread
      if (!(t.asked || 0) && (!callId || t.fromCall !== callId) && ISO.test(String(t.told)) && daysBetween(t.told, today) <= REMINDER_DAYS) live.push({ t, rank: -1 });
      continue;
    }
    if ((t.asked || 0) >= 2) continue;
    if (ISO.test(String(t.due))) {
      const since = daysBetween(t.due, today);                       // days since the date; negative = not yet
      if (since >= 0 && since <= DATED_GRACE_DAYS) live.push({ t, rank: since });
    } else if (ISO.test(String(t.told))) {
      const age = daysBetween(t.told, today);
      if (age >= 1 && age <= OPEN_WORRY_DAYS) live.push({ t, rank: 100 + age });   // dated ones first
    }
  }
  live.sort((a, b) => a.rank - b.rank);
  return live.length ? live[0].t : null;
}

// The fact line handed to Spark for a thread: who, what, told date, and the date worked out in plain words. Never wording for her to say.
function threadFact(t, today) {
  if (t.kind === 'reminder') return `${t.text}; they asked on ${t.told || 'an earlier call'} to be reminded of this when they next called`;
  const f = ISO.test(String(t.due)) ? dateFact(t.due, today) : null;
  const when = f ? `, was due ${t.due} (${f.text})` : '';
  return `${t.who ? `${t.who}: ` : ''}${t.text}${when}; told ${t.told || 'earlier'}`;
}

// Threads that can no longer be asked about are marked expired (never deleted here); everything else is returned unchanged.
function expire(threads, today) {
  return (threads || []).map((t) => {
    if (!t || t.status !== 'open') return t;
    if (t.kind === 'reminder') return ISO.test(String(t.told)) && daysBetween(t.told, today) > REMINDER_DAYS ? { ...t, status: 'expired' } : t;
    const over = ISO.test(String(t.due)) ? daysBetween(t.due, today) > DATED_GRACE_DAYS : ISO.test(String(t.told)) && daysBetween(t.told, today) > OPEN_WORRY_DAYS;
    return over ? { ...t, status: 'expired' } : t;
  });
}

const KINDS = new Set(['event', 'worry', 'plan']);
const MAX_THREADS = 20;     // open ones are always kept; the oldest closed / expired ones go first
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const key = (who, text) => `${words(who).join(' ')}|${words(text).join(' ')}`;
const newId = () => `t${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;

// Applies what the filing step (Spark) returned about threads to the threads already kept. Spark only ever proposes changes:
// it never sets told or asked (code owns those), a closed thread never reopens, an existing thread Spark leaves out is kept as it was,
// and a duplicate (same id, or same person and words) is the same thread. A new thread must arrive open. `returned` that is not a
// list (the key missing or garbage) changes nothing. Pure: the input is not mutated; makeId is injectable for tests.
function mergeThreads(existing, returned, today, makeId = newId) {
  const out = (Array.isArray(existing) ? existing : []).filter((t) => t && String(t.text || '').trim()).map((t) => ({ ...t }));
  if (Array.isArray(returned)) {
    for (const r of returned) {
      if (!r || typeof r !== 'object') continue;
      const text = clip(r.text, 200);
      const hit = out.find((t) => (r.id && t.id === r.id) || (text && key(t.who, t.text) === key(r.who, text)));
      const due = ISO.test(String(r.due)) ? String(r.due) : '';
      const kind = KINDS.has(String(r.kind)) ? String(r.kind) : null;
      const closing = String(r.status) === 'closed';
      if (hit && hit.kind === 'reminder') {
        if (hit.status === 'open' && closing) hit.status = 'closed';   // Spark may close one that was done; it never rewrites, reopens or duplicates one
      } else if (hit) {
        if (hit.status === 'open') {
          if (text) hit.text = text;
          if (due) hit.due = due;
          if (kind) hit.kind = kind;
          if (closing) hit.status = 'closed';
        }
      } else if (text && !closing) {
        out.push({ id: makeId(), who: clip(r.who, 40), text, due, kind: kind || (due ? 'event' : 'plan'), status: 'open', asked: 0, told: today });
      }
    }
  }
  const kept = expire(out, today);
  const open = kept.filter((t) => t.status === 'open');
  const rest = kept.filter((t) => t.status !== 'open').slice(-Math.max(0, MAX_THREADS - open.length));
  return kept.filter((t) => open.includes(t) || rest.includes(t));
}

// "Remind me the next time I call (you) that I need to call my grandson" / "remind me next time to call X" / "remind me to call X when I call again".
// Returns the task in the person's own words, or '' when it is not a next-call reminder or has no task. A timed ask ("in 5 minutes") is not one.
const NEXT_CALL = /\b(?:the )?next (?:time|call)\b(?: that| when)?(?: (?:i|we) (?:call|ring|phone|talk|speak)(?: to)?(?: you)?(?: again| back| next)?)?|\bwhen (?:i|we) (?:call|ring|phone|talk|speak)(?: to)?(?: you)?(?: again| back| next)\b|\bon my next call\b/i;
function parseNextCallReminder(text) {
  const sentence = String(text || '').replace(/[‘’]/g, "'").split(/[.?!]/).find((c) => /\bremind me\b/i.test(c) && NEXT_CALL.test(c));
  if (!sentence || /\b(?:in|after)\s+(?:\d+(?:\.\d+)?|[a-z]+)\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i.test(sentence)) return '';
  const rest = sentence.replace(NEXT_CALL, ' ').replace(/^.*?\bremind me\b/i, '').replace(/\s+/g, ' ');
  const task = rest.replace(/^[\s,]*(?:to|about|that)\b\s*/i, '').replace(/^[\s,]+|[\s,]+$/g, '');
  return words(task).length >= 1 && task.length >= 3 ? clip(task, 120) : '';
}

const MAX_OPEN_REMINDERS = 5;
// Pure: the reminder to add to the threads, or why not. makeId injectable for tests.
function addReminderTo(threads, task, callId, today, makeId = newId) {
  const open = (threads || []).filter((t) => t && t.kind === 'reminder' && t.status === 'open');
  if (open.some((t) => key('', t.text) === key('', task))) return { status: 'duplicate' };
  if (open.length >= MAX_OPEN_REMINDERS) return { status: 'full' };
  return { status: 'added', thread: { id: makeId(), who: '', text: clip(task, 120), due: '', kind: 'reminder', status: 'open', asked: 0, told: today, fromCall: callId } };
}

// They said the thing they asked to be reminded of is not done yet / still to do.
const STILL_TO_DO = /\b(?:not (?:done|finished)(?: yet)?|haven'?t (?:done|called|managed|got(?:ten)? to)(?: it| that)?(?: yet)?|still (?:need|have|got) to|still to do|didn'?t (?:get|manage) to|not yet|remind me again)\b/i;

// Relevant memory callback: when the senior talks about a topic, code may surface at most ONE matching senior-told fact per conversation,
// never if the senior already mentioned that fact in this turn, never from family/dashboard/inferred/daily-call records, and never for medicine.
const CALLBACK_FILLER = new Set('always also back been before being both call called calling came come comes coming day days does doing done down drink drinking drinks eat eating eats enjoy enjoyed enjoys even ever every favorite favourite feel feeling feels felt find first fond from gave get gets getting give given gives going gone good great had has have having hear heard here high just keep kept kind kinds know known knows last late like liked likes little live lived lives long look looked looking love loved loves made make makes making many might more most much must name named names need needed needs never nice often only other over part past prefer preferred prefers quite rather really said same saw say saying says seem seemed seems seen since small some something sometimes still take taken takes taking talk talked talking tell telling tells thing things think thinking thinks thought time times today told took true turn turned turns used usually very want wanted wants well went were year years'.split(' '));
const TOPIC_GROUPS = [
  ['tea', 'cuppa', 'chai', 'teapot', 'kettle'],
  ['coffee', 'espresso', 'latte', 'cappuccino', 'caffeine', 'decaf'],
  ['chocolate', 'cocoa', 'sweet', 'dessert', 'treat', 'candy', 'fudge'],
  ['grandson', 'granddaughter', 'grandchild', 'grandchildren', 'grandkid'],
];
const NON_SENIOR_META = /\b(?:family|dashboard|inferred|guess\w*|system|caregiver|carer|daily[-_ ]?call|social|welfare|check[-_ ]?in|reminder)\b/i;
const NON_SENIOR_TEXT = /\b(?:family[- ]set|set by (?:the |their )?(?:family|son|daughter|dashboard)|from (?:the )?(?:family|dashboard)|family dashboard|inferred|reminder from (?:the )?family|check-in set by|unnamed speaker)\b/i;
const DAILY_CALL_TEXT = /\b(?:daily[- ]?calls?|friendly daily call|call from maya|maya['’]?s (?:daily )?call|every day at \d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}\s*(?:am|pm)\s+every\s+day)\b/i;
const MEDICINE_TEXT = /\b(?:medicin\w*|medicat\w*|meds|pills?|tablets?|capsules?|doses?|dosag\w*|mg|mcg|ml|prescript\w*|rx|pharmac\w*|drug\w*|vitamins?|supplements?|inhaler\w*|insulin|antibiotic\w*|painkiller\w*|ibuprofen|paracetamol|acetaminophen|tylenol|aspirin|naproxen|advil|motrin|warfarin|eliquis|apixaban|metformin|lisinopril|statin\w*|atorvastatin|amlodipine|omeprazole|gabapentin|prednison\w*|levothyroxin\w*|losartan|hydrochlorothiazide|albuterol|furosemide|pantoprazole|sertraline|zolpidem|tramadol|oxycodon\w*|morphin\w*|codein\w*|ointment\w*|eyedrop\w*|ear\s*drop\w*|syrup\w*|inject\w*|vaccin\w*|booster\w*|refill\w*|side[- ]effect\w*|symptom\w*|diagnos\w*|treatment\w*|therap\w*|doctor\w*|dr\.?\b|gp\b|physician\w*|surgeon\w*|nurse\w*|clinic\w*|hospital\w*|surger\w*|operation\w*|appointment\w*|blood\s*(?:pressure|sugar|test|work|thinner\w*)|cholesterol|diabetes|arthritis|chemo\w*|dialysis)\b/i;

function seniorToldItem(x, text = '') {
  if (!x || typeof x !== 'object') return false;
  if (x.inferred || x.family || x.dashboard || x.social) return false;
  if (x.by && String(x.by).toLowerCase() !== 'senior') return false;
  if (x.owner && String(x.owner).toLowerCase() !== 'senior') return false;
  if (x.creator && String(x.creator).toLowerCase() !== 'senior') return false;
  const meta = [x.source, x.origin, x.type, x.kind, x.channel].filter(Boolean).join(' ');
  if (NON_SENIOR_META.test(meta)) return false;
  const body = `${x.who || ''} ${x.name || ''} ${x.relationship || ''} ${text || x.text || ''}`;
  if (NON_SENIOR_TEXT.test(body) || DAILY_CALL_TEXT.test(body) || MEDICINE_TEXT.test(body)) return false;
  return true;
}

const topicWords = (text, ownerWords) => words(text).filter((w) => !CALLBACK_FILLER.has(w) && !ownerWords.has(w));
const relatedMatch = (w, uSet) => TOPIC_GROUPS.some((g) => g.includes(w) && g.some((x) => x !== w && uSet.has(x)));

function callbackFact(memory, userText, today = '', opts = {}) {
  const session = opts && typeof opts.session === 'object' ? opts.session : null;
  if (!userText || opts.heavy || opts.callbackUsed || opts.used || (session && session.callbackUsed)) return null;
  if (heavyTalk(userText) || MEDICINE_TEXT.test(String(userText))) return null;
  const uSet = new Set(words(userText));
  if (!uSet.size) return null;
  const m = memory && typeof memory === 'object' && memory.memory && typeof memory.memory === 'object' ? memory.memory : (memory || {});
  const owner = String(opts.ownerName || (memory && memory.name) || '').trim();
  const ownerWords = new Set(words(owner));
  const candidates = [];
  const consider = (kind, item, factText, coreText, personWords = []) => {
    if (!seniorToldItem(item, factText)) return;
    const fWords = topicWords(coreText, ownerWords);
    const pWords = personWords.filter((w) => !ownerWords.has(w));
    const allWords = [...new Set([...pWords, ...fWords])];
    if (!allWords.length) return;
    const directCore = fWords.filter((w) => uSet.has(w));
    const directPerson = pWords.filter((w) => uSet.has(w));
    const related = allWords.filter((w) => !uSet.has(w) && relatedMatch(w, uSet));
    const hits = [...new Set([...directPerson, ...directCore, ...related])];
    if (!hits.length) return;
    const checkWords = pWords.length && fWords.length ? fWords : allWords;
    const checkDirect = pWords.length && fWords.length ? directCore : [...new Set([...directPerson, ...directCore])];
    const unmentioned = checkWords.filter((w) => !uSet.has(w));
    if (!unmentioned.length || checkDirect.length > 1) return;
    const age = ISO.test(String(item.told)) && ISO.test(String(today)) ? daysBetween(item.told, today) : 99;
    const rank = (kind === 'likes' ? 4 : kind === 'story' ? 3 : kind === 'person' ? 2 : 1) * 10 + hits.length * 2 + (age >= 0 && age <= 30 ? 1 : 0);
    const who = clip(item.who || item.name || '', 40);
    const cleanText = clip(factText, 200);
    const told = ISO.test(String(item.told)) ? String(item.told) : '';
    const fact = `${who ? `${who}: ` : ''}${cleanText}${told ? `; told ${told}` : ''}`;
    candidates.push({ kind, who, text: cleanText, told, topic: hits[0], fact, rank });
  };
  for (const x of m.preferences || []) consider('likes', x, x.text, x.text);
  for (const p of m.people || []) {
    if (!seniorToldItem(p, `${p.name || ''} ${p.relationship || ''}`)) continue;
    const pWords = topicWords(`${p.name || ''} ${p.relationship || ''}`, ownerWords);
    const label = p.relationship ? `${p.name} (${p.relationship})` : String(p.name || '');
    for (const s of p.stories || []) {
      if (!seniorToldItem(s, s && s.text)) continue;
      consider('story', { ...p, ...s, who: label }, s.text, s.text, pWords);
    }
    const storyMentioned = (p.stories || []).some((s) => {
      const sw = topicWords(s && s.text, ownerWords);
      return sw.length > 0 && sw.filter((w) => uSet.has(w)).length >= Math.min(2, sw.length);
    });
    if (p.name && p.relationship && !storyMentioned) consider('person', { ...p, who: p.name, text: label }, label, label);
  }
  for (const e of m.events || []) consider('event', e, e.text, e.text);
  for (const c of m.current || []) consider('current', c, c.text, c.text);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rank - a.rank);
  const best = candidates[0];
  if (session) session.callbackUsed = true;
  return { kind: best.kind, who: best.who, text: best.text, told: best.told, topic: best.topic, fact: best.fact };
}

module.exports = { callbackFact, parseNextCallReminder, addReminderTo, STILL_TO_DO, REMINDER_DAYS, MAX_OPEN_REMINDERS, heavyTalk, OPEN_WORRY_DAYS, DATED_GRACE_DAYS, daysBetween, rel, dateFact, words, score, select, upcoming, dueThread, threadFact, expire, mergeThreads, MAX_THREADS };
