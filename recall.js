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
function select(memory, userText, today, { k = 6, changed = null } = {}) {
  const m = memory || {};
  const chSet = changedSetFrom(changed);
  const out = [];
  const add = (kind, item, extra = {}) => {
    if (chSet.size && words(item.text).some((w) => !BROAD_TOPICS.has(w) && chSet.has(w))) return;
    const s = score(item, userText, today);
    if (s > 0) out.push({ kind, who: item.who || '', text: item.text, told: item.told || '', score: s, ...extra });
  };
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
const BROAD_TOPICS = new Set(TOPIC_GROUPS.flat());
const CHALLENGE_TEXT = /\b(?:i\s+(?:never|didn'?t|did\s+not|haven'?t|have\s+not)\s+(?:ever\s+)?(?:tell|told|say|said|mention\w*|share\w*)\b|(?:when|where|how)\s+(?:did|do|would|could)\s+you\s+(?:ever\s+)?(?:know|remember|hear|get|learn|find\s+out|think)\b|when\s+did\s+i\s+(?:ever\s+)?(?:tell|say|mention|share)\b|who\s+told\s+you\b|did\s+i\s+(?:ever\s+)?(?:tell|say|mention)\s+(?:to\s+you|you)\b|you\s+(?:just\s+)?(?:made\s+(?:that|it)\s+up|guessed\s+(?:that|it)|invented\s+(?:that|it)|added\s+that)\b|did\s+you\s+(?:just\s+)?(?:guess|make\s+(?:that|it)\s+up)\b)/i;
const CHALLENGE_SKIP = /\b(?:remind\w*|alarms?|timers?|schedul\w*|daily\s+calls?|stop\s+calling|call\s+me|ring\s+me|phone\s+me|alert\w*|scam\w*|fraud)\b/i;
const CHALLENGE_STOP = new Set('about added afternoon assume assumed before claim claimed come came could day days did didn didnt does doesn dont don drink drinking drinks earlier eat eating eats evening ever find found friend friends from get getting got guess guessed had has have having hear heard how invent invented just kind kinds know knowing knew learn learned like liked likes love loved loves made make making maybe mean meant memory mention mentioned morning myselves myself never night note notes now only out part prefer preferred prefers remember remembered right said say saying says share shared some something suppose supposed tell telling tells thing things think thinking thought time times today together told took true turn turns two used wait what when where which who why with would yesterday you your yourself'.split(' '));
const CHANGED_PREF_RE = /\b(?:i\s+(?:don'?t|do\s+not|no\s+longer)\s+(?:like|love|drink|eat|enjoy|want|care\s+for)\b|i\s+(?:stopped|quit|gave\s+up)\s+(?:drinking|eating|having|liking)\b|i(?:'m|\s+am)\s+(?:off|done\s+with|tired\s+of)\b|i\s+hate\b|not\s+a\s+fan\s+of\b)/i;
const CHANGED_STOP = new Set('anymore longer stopped stop quit gave hate fan tired done off now'.split(' '));
const QUOTED_OTHER_RE = /\b(?:he|she|they|my\s+(?:friend|sister|brother|son|daughter|neighbor|neighbour|wife|husband|coworker))\s+(?:said|told\s+me|says|asked|likes?|loves?|prefers?|had|drank|ate)\b/i;
const SELF_ACTOR_RE = /\b(?:i|we)\s+(?:had|drank|ate|made|like|love|enjoy|prefer|want|am\s+having|are\s+having|am\s+drinking|are\s+drinking|am\s+making)\b/i;

function isQuotingOtherOnly(userText) {
  const raw = String(userText || '').replace(/[\u2018\u2019]/g, "'");
  if (!raw) return false;
  const unquoted = raw.replace(/["“][^"”]*["”]/g, ' ');
  if (QUOTED_OTHER_RE.test(unquoted) && !SELF_ACTOR_RE.test(unquoted)) return true;
  return false;
}

function changedSetFrom(changed) {
  if (!changed) return new Set();
  if (changed instanceof Set) return changed;
  if (Array.isArray(changed)) return new Set(changed);
  return new Set();
}

function changedPreference(memory, userText, opts = {}) {
  const raw = String(userText || '').replace(/[\u2018\u2019]/g, "'");
  if (!raw || !CHANGED_PREF_RE.test(raw) || CHALLENGE_TEXT.test(raw) || DAILY_CALL_TEXT.test(raw) || MEDICINE_TEXT.test(raw) || CHALLENGE_SKIP.test(raw)) return null;
  if (isQuotingOtherOnly(raw)) return null;
  const m = memory && typeof memory === 'object' && memory.memory && typeof memory.memory === 'object' ? memory.memory : (memory || {});
  const owner = String(opts.ownerName || (memory && memory.name) || '').trim();
  const ownerWords = new Set(words(owner));
  const qWords = words(raw).filter((w) => !CHALLENGE_STOP.has(w) && !CALLBACK_FILLER.has(w) && !CHANGED_STOP.has(w) && !ownerWords.has(w));
  if (!qWords.length) return null;
  const specific = qWords.filter((w) => !BROAD_TOPICS.has(w));
  const target = specific.length ? specific : qWords;
  const items = [
    ...(m.preferences || []),
    ...(m.people || []).flatMap((p) => (p && seniorToldItem(p, `${p.name || ''} ${p.relationship || ''}`)) ? (p.stories || []) : []),
    ...(m.events || []),
    ...(m.current || []),
    ...(m.topics || []),
  ];
  const hasStored = items.some((it) => {
    if (!seniorToldItem(it, it && it.text)) return false;
    const iSet = new Set(words(it && it.text));
    return target.some((w) => iSet.has(w));
  });
  if (!hasStored) return null;
  return { words: qWords, specific, topic: specific[0] || qWords[0] || '', text: clip(raw, 200) };
}

function challengeFact(memory, userText, today = '', opts = {}) {
  const raw = String(userText || '').replace(/[\u2018\u2019]/g, "'");
  if (!raw || !CHALLENGE_TEXT.test(raw) || DAILY_CALL_TEXT.test(raw) || MEDICINE_TEXT.test(raw) || CHALLENGE_SKIP.test(raw)) return null;
  const m = memory && typeof memory === 'object' && memory.memory && typeof memory.memory === 'object' ? memory.memory : (memory || {});
  const profileId = String(opts.profileId || (memory && memory.id) || '').trim();
  const owner = String(opts.ownerName || (memory && memory.name) || '').trim();
  const ownerWords = new Set(words(owner));
  const qWords = words(raw).filter((w) => !CHALLENGE_STOP.has(w) && !CALLBACK_FILLER.has(w) && !ownerWords.has(w));
  if (!qWords.length) {
    const last = opts.lastCallback;
    const sameProfile = !profileId || !last || !last.profileId || last.profileId === profileId;
    if (last && last.delivered !== false && last.fresh !== false && sameProfile && last.fact && last.text && seniorToldItem(last, last.text)) {
      return { status: 'recorded', challengeKind: 'preference', topic: last.topic || '', who: last.who || '', text: last.text, told: last.told || '', fact: last.fact, newWords: [], newToday: '' };
    }
    return { status: 'unrecorded', challengeKind: 'preference', topic: '', who: '', text: '', told: '', fact: '', newWords: [], newToday: '' };
  }
  const specificQ = qWords.filter((w) => !BROAD_TOPICS.has(w));
  const broadQ = qWords.filter((w) => BROAD_TOPICS.has(w));
  const eventFraming = /\b(?:i|we)\s+(?:had|drank|ate|made|ordered|got|were\s+having|was\s+having|were\s+drinking|was\s+drinking)\b|\b(?:today|just\s+now|this\s+(?:morning|afternoon|evening)|with\s+(?:my|a)\s+friend)\b/i.test(raw)
    && !/\b(?:never|didn'?t|did\s+not)\s+(?:ever\s+)?(?:tell|told|say|said|mention\w*)\s+you\s+i\s+(?:like\w*|love\w*|enjoy\w*|prefer\w*)\b/i.test(raw);
  const matches = [];
  const checkItem = (kind, item, factText, coreText, personWords = []) => {
    if (!seniorToldItem(item, factText)) return;
    const fWords = topicWords(coreText, ownerWords);
    const pWords = personWords.filter((w) => !ownerWords.has(w));
    const iSet = new Set([...pWords, ...fWords, ...words(factText)]);
    let matchedSpecific = [];
    let newWords = [];
    if (specificQ.length) {
      matchedSpecific = specificQ.filter((w) => iSet.has(w));
      if (!matchedSpecific.length) return;
      const itemBroad = [...iSet].filter((w) => BROAD_TOPICS.has(w));
      if (broadQ.length && itemBroad.length && !broadQ.some((w) => iSet.has(w) || relatedMatch(w, iSet))) return;
      newWords = specificQ.filter((w) => !iSet.has(w));
    } else {
      if (!qWords.every((w) => iSet.has(w))) return;
    }
    const hitCount = (matchedSpecific.length ? matchedSpecific.length * 2 : 0) + broadQ.filter((w) => iSet.has(w)).length;
    if (!hitCount) return;
    const who = clip(item.who || item.name || '', 40);
    const cleanText = clip(factText, 200);
    const told = ISO.test(String(item.told)) ? String(item.told) : '';
    const fact = `${who ? `${who}: ` : ''}${cleanText}${told ? `; told ${told}` : ''}`;
    const challengeKind = newWords.length > 0 || eventFraming ? 'event' : 'preference';
    matches.push({ kind, who, text: cleanText, told, topic: (matchedSpecific[0] || qWords[0] || ''), fact, challengeKind, newWords, newToday: newWords.join(' '), rank: hitCount * 10 + (kind === 'likes' ? 4 : kind === 'story' ? 3 : 2) });
  };
  for (const x of m.preferences || []) checkItem('likes', x, x.text, x.text);
  for (const p of m.people || []) {
    if (!seniorToldItem(p, `${p.name || ''} ${p.relationship || ''}`)) continue;
    const pWords = topicWords(`${p.name || ''} ${p.relationship || ''}`, ownerWords);
    const label = p.relationship ? `${p.name} (${p.relationship})` : String(p.name || '');
    for (const s of p.stories || []) {
      if (!seniorToldItem(s, s && s.text)) continue;
      checkItem('story', { ...p, ...s, who: label }, s.text, s.text, pWords);
    }
    if (p.name && p.relationship) checkItem('person', { ...p, who: p.name, text: label }, label, label, pWords);
  }
  for (const e of m.events || []) checkItem('event', e, e.text, e.text);
  for (const c of m.current || []) checkItem('current', c, c.text, c.text);
  for (const t of m.topics || []) checkItem('topic', t, t.text, t.text);
  if (matches.length) {
    matches.sort((a, b) => b.rank - a.rank);
    const best = matches[0];
    return { status: 'recorded', challengeKind: best.challengeKind, topic: best.topic, who: best.who, text: best.text, told: best.told, fact: best.fact, newWords: best.newWords, newToday: best.newToday };
  }
  return { status: 'unrecorded', challengeKind: eventFraming ? 'event' : 'preference', topic: (specificQ[0] || qWords[0] || ''), who: '', text: '', told: '', fact: '', newWords: [], newToday: '' };
}

function unconfirmedFacts(memory, userText, today = '', opts = {}) {
  const raw = String(userText || '').replace(/[\u2018\u2019]/g, "'");
  if (!raw || heavyTalk(raw) || MEDICINE_TEXT.test(raw) || CHALLENGE_TEXT.test(raw) || CHANGED_PREF_RE.test(raw)) return [];
  const selfText = raw.replace(/(?:he|she|they|my\s+(?:friend|sister|brother|son|daughter|neighbor|neighbour|wife|husband))\s+(?:said|told\s+me|says|had|drank|likes?|loves?)\s*[:,]?\s*["“][^"”]*["”]/gi, ' ');
  const uSet = new Set(words(isQuotingOtherOnly(raw) ? '' : selfText));
  const fullUSet = new Set(words(raw));
  if (!fullUSet.size) return [];
  const m = memory && typeof memory === 'object' && memory.memory && typeof memory.memory === 'object' ? memory.memory : (memory || {});
  const owner = String(opts.ownerName || (memory && memory.name) || '').trim();
  const ownerWords = new Set(words(owner));
  const changed = changedSetFrom(opts.changed);
  const candidates = [];
  const consider = (kind, item, factText, coreText, personWords = []) => {
    if (!seniorToldItem(item, factText)) return;
    const fWords = topicWords(coreText, ownerWords);
    const pWords = personWords.filter((w) => !ownerWords.has(w));
    const allWords = [...new Set([...pWords, ...fWords])];
    if (!allWords.length) return;
    if (changed.size && allWords.some((w) => !BROAD_TOPICS.has(w) && changed.has(w))) return;
    const directCore = fWords.filter((w) => uSet.has(w));
    const directPerson = pWords.filter((w) => uSet.has(w));
    const related = allWords.filter((w) => !uSet.has(w) && relatedMatch(w, fullUSet));
    const broadHits = allWords.filter((w) => BROAD_TOPICS.has(w) && fullUSet.has(w));
    const hits = [...new Set([...directPerson, ...directCore, ...related, ...broadHits])];
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
    candidates.push({ kind, who, text: cleanText, told, topic: hits[0], fact, confirmed: false, ask: true, unmentioned, rank });
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
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates;
}

function callbackFact(memory, userText, today = '', opts = {}) {
  const session = opts && typeof opts.session === 'object' ? opts.session : null;
  if (!userText || opts.heavy || opts.callbackUsed || opts.used || (session && session.callbackUsed)) return null;
  if (isQuotingOtherOnly(userText)) return null;
  const candidates = unconfirmedFacts(memory, userText, today, opts);
  if (!candidates.length) return null;
  const best = candidates[0];
  return { kind: best.kind, who: best.who, text: best.text, told: best.told, topic: best.topic, fact: best.fact, confirmed: false, ask: true, unmentioned: best.unmentioned };
}

// ---- Feature 1: Correct and Forget (senior's own non-medical conversational memories only) ----
const FORGET_VERB_RE = /\b(?:please\s+)?(?:forget|delete|erase|remove|drop|wipe|clear)\b[^.?!]{0,40}\b(?:what\s+i\s+(?:told|said|mentioned|shared)|(?:your|my|the|that)\s+(?:note|memory|notes|memories|fact)|that\s+i\s+(?:like|love|enjoy|prefer|drink|eat|had|have|went|play)|about\s+\w+)/i;
const FORGET_DIRECT_RE = /^\s*(?:please\s+)?(?:forget|delete|erase|remove)\s+(?:that|what\s+i\s+said|everything|all\s+my\s+notes|my\s+notes|(?:my|the|your)\s+\w+|about\b.*|that\s+i\b.*)/i;
const CORRECT_NOTE_RE = /\b(?:please\s+)?(?:correct|update|change|replace|fix|amend)\s+(?:your|my|the|that)?\s*(?:note|notes|memory|memories|what\s+i\s+(?:told|said|mentioned))\b/i;
const REPLACE_WITH_RE = /\b(?:replace|change|swap|switch)\s+(.+?)\s+(?:with|to|for)\s+(.+?)(?:[.?!]|$)/i;
const NOT_X_ITS_Y_RE = /\b(?:correct|update|fix|change|amend|in\s+your\s+notes?)[^.?!]*?\b(?:i\s+(?:like|love|enjoy|prefer|drink|eat)|it(?:'s|\s+is)|(?:he|she|they|my\s+\w+(?:\s+\w+)?)\s+plays?)\s+([^,.?!]+?)\s*,\s*not\s+([^,.?!]+?)(?:[.?!]|$)/i;
const PROTECTED_EDIT_RE = /\b(?:safety\s+(?:alert|incident|ticket|record)s?|scam\s+(?:alert|flag|incident|record)s?|consent\s+record|provenance|medical\s+record|medicine\s+(?:note|record|refusal)|prescription|dosage|daily\s+calls?|family(?:'s|\s+dashboard|\s+note)s?|other\s+(?:senior|person|profile)'?s?)\b/i;
const SCHED_REM_CANCEL_RE = /\b(?:cancel|stop|skip|change|move|reschedule)\s+(?:my\s+|the\s+|our\s+|today'?s\s+)?(?:daily\s+call|calls?|reminders?|alarms?|timers?)\b/i;
const EDIT_STOP = new Set('about actually all amend change changed clear correct corrected delete deleted dont drop dropped erase erased everything fact facts fix fixed for forget forgotten from into memory memories mine note notesimah notes please record records remove removed replace replaced said say shared something take tell that the their them thing things told update updated what with wipe wiped wrote your'.split(' '));

function collectEditableItems(m, ownerWords) {
  const list = [];
  (m.preferences || []).forEach((x, idx) => {
    if (!seniorToldItem(x, x && x.text)) return;
    const who = clip(x.who || '', 40);
    const cleanText = clip(x.text, 200);
    const told = ISO.test(String(x.told)) ? String(x.told) : '';
    const fWords = topicWords(cleanText, ownerWords);
    list.push({ section: 'preferences', index: idx, kind: 'likes', who, text: cleanText, told, fact: `${who ? `${who}: ` : ''}${cleanText}${told ? `; told ${told}` : ''}`, coreWords: fWords, allWords: new Set([...fWords, ...words(cleanText)]) });
  });
  (m.people || []).forEach((p, pIdx) => {
    if (!seniorToldItem(p, `${p.name || ''} ${p.relationship || ''}`)) return;
    const pWords = topicWords(`${p.name || ''} ${p.relationship || ''}`, ownerWords);
    const label = p.relationship ? `${p.name} (${p.relationship})` : String(p.name || '');
    (p.stories || []).forEach((s, sIdx) => {
      if (!seniorToldItem(s, s && s.text)) return;
      const cleanText = clip(s.text, 200);
      const told = ISO.test(String(s.told)) ? String(s.told) : '';
      const fWords = topicWords(cleanText, ownerWords);
      list.push({ section: 'stories', personIndex: pIdx, storyIndex: sIdx, kind: 'story', who: label, text: cleanText, told, fact: `${label ? `${label}: ` : ''}${cleanText}${told ? `; told ${told}` : ''}`, coreWords: [...new Set([...pWords, ...fWords])], allWords: new Set([...pWords, ...fWords, ...words(cleanText)]) });
    });
  });
  (m.events || []).forEach((e, idx) => {
    if (!seniorToldItem(e, e && e.text)) return;
    const who = clip(e.who || '', 40);
    const cleanText = clip(e.text, 200);
    const told = ISO.test(String(e.told)) ? String(e.told) : '';
    const fWords = topicWords(cleanText, ownerWords);
    list.push({ section: 'events', index: idx, kind: 'event', who, text: cleanText, told, fact: `${who ? `${who}: ` : ''}${cleanText}${told ? `; told ${told}` : ''}`, coreWords: fWords, allWords: new Set([...fWords, ...words(cleanText)]) });
  });
  (m.current || []).forEach((c, idx) => {
    if (!seniorToldItem(c, c && c.text)) return;
    const who = clip(c.who || '', 40);
    const cleanText = clip(c.text, 200);
    const told = ISO.test(String(c.told)) ? String(c.told) : '';
    const fWords = topicWords(cleanText, ownerWords);
    list.push({ section: 'current', index: idx, kind: 'current', who, text: cleanText, told, fact: `${who ? `${who}: ` : ''}${cleanText}${told ? `; told ${told}` : ''}`, coreWords: fWords, allWords: new Set([...fWords, ...words(cleanText)]) });
  });
  return list;
}

function hasProtectedMatchOnly(m, qWords) {
  if (!qWords.length) return null;
  const allItems = [
    ...(m.preferences || []),
    ...(m.events || []),
    ...(m.current || []),
    ...(m.people || []).flatMap((p) => [p, ...(p && p.stories ? p.stories : [])]),
  ].filter(Boolean);
  for (const it of allItems) {
    const txt = `${it.name || ''} ${it.relationship || ''} ${it.text || ''}`;
    const wSet = new Set(words(txt));
    if (!qWords.some((w) => wSet.has(w))) continue;
    if (MEDICINE_TEXT.test(txt)) return 'medicine';
    if (it.social || DAILY_CALL_TEXT.test(txt)) return 'daily-call';
    if (!seniorToldItem(it, txt)) return 'family';
  }
  return null;
}

function memoryEditIntent(memory, userText, today = '', opts = {}) {
  const raw = String(userText || '').replace(/[\u2018\u2019]/g, "'").trim();
  if (!raw || isQuotingOtherOnly(raw)) return null;
  if (SCHED_REM_CANCEL_RE.test(raw) && !/\b(?:note|notes|memory|memories|what\s+i\s+told\s+you)\b/i.test(raw)) return null;

  const m = memory && typeof memory === 'object' && memory.memory && typeof memory.memory === 'object' ? memory.memory : (memory || {});
  const owner = String(opts.ownerName || (memory && memory.name) || '').trim();
  const ownerWords = new Set(words(owner));
  const pending = opts.pendingEdit || null;

  const isForget = FORGET_VERB_RE.test(raw) || FORGET_DIRECT_RE.test(raw);
  const isCorrect = !isForget && (CORRECT_NOTE_RE.test(raw) || NOT_X_ITS_Y_RE.test(raw) || (/\b(?:note|notes|memory|memories|told\s+you)\b/i.test(raw) && REPLACE_WITH_RE.test(raw)));
  if (!isForget && !isCorrect && !pending) return null;

  const op = isForget ? 'forget' : isCorrect ? 'correct' : pending.op;

  // Protected categories must never be deleted or altered via conversational memory edit
  if (PROTECTED_EDIT_RE.test(raw) || DAILY_CALL_TEXT.test(raw) || MEDICINE_TEXT.test(raw)) {
    const cat = /safety/i.test(raw) ? 'safety'
      : /scam/i.test(raw) ? 'scam'
      : /consent|provenance/i.test(raw) ? 'consent'
      : /daily\s+call/i.test(raw) || DAILY_CALL_TEXT.test(raw) ? 'daily-call'
      : /family|dashboard/i.test(raw) ? 'family'
      : /other\s+(?:senior|person|profile)/i.test(raw) ? 'other-senior'
      : 'medicine';
    return { op, status: 'protected', category: cat };
  }
  if (/\b(?:remind\w*|alarms?|timers?)\b/i.test(raw)) {
    return { op, status: 'protected', category: 'reminder' };
  }

  // If resolving a pending missing-replacement clarification
  if (pending && pending.reason === 'missing-replacement' && pending.target && !isForget) {
    const rep = clip(raw.replace(/^(?:it\s+should\s+(?:be|say)|change\s+it\s+to|make\s+it|to|that)\s+/i, ''), 160);
    if (!rep || words(rep).length === 0) return { op: 'correct', status: 'unclear', reason: 'missing-replacement', target: pending.target };
    return { op: 'correct', status: 'ready', target: pending.target, replacementText: rep };
  }

  let targetPart = raw;
  let replacementText = '';
  if (op === 'correct') {
    const notMatch = NOT_X_ITS_Y_RE.exec(raw);
    const repMatch = REPLACE_WITH_RE.exec(raw);
    const colonMatch = /\b(?:correct|update|change|fix|amend)\s+(?:your|my|the|that)?\s*(?:note|notes|memory|memories|what\s+i\s+(?:told|said|mentioned))[^:]*:\s*(.+)$/i.exec(raw);
    if (notMatch) {
      replacementText = clip(notMatch[1], 160);
      targetPart = notMatch[2];
    } else if (repMatch) {
      targetPart = repMatch[1];
      replacementText = clip(repMatch[2], 160);
    } else if (colonMatch) {
      const clause = colonMatch[1];
      const m2 = /\b(?:i\s+(?:like|love|enjoy|prefer)|it(?:'s|\s+is)|plays?)\s+([^,.?!]+?)\s+(?:instead\s+of|not|rather\s+than)\s+([^,.?!]+)/i.exec(clause);
      if (m2) {
        replacementText = clip(m2[1], 160);
        targetPart = m2[2];
      } else {
        const mTo = /\bfrom\s+(.+?)\s+to\s+(.+?)(?:[.?!]|$)/i.exec(clause);
        if (mTo) { targetPart = mTo[1]; replacementText = clip(mTo[2], 160); }
        else targetPart = clause;
      }
    } else {
      const mInstead = /\b(?:to|as)\s+([^,.?!]+?)\s+(?:instead\s+of|not)\s+([^,.?!]+)/i.exec(raw);
      if (mInstead) { replacementText = clip(mInstead[1], 160); targetPart = mInstead[2]; }
    }
  }

  const qWords = words(targetPart).filter((w) => !EDIT_STOP.has(w) && !CHALLENGE_STOP.has(w) && !CALLBACK_FILLER.has(w) && !ownerWords.has(w));
  if (!qWords.length || /\b(?:everything|all\s+of\s+it|all\s+my\s+notes|anything\s+i\s+said)\b/i.test(raw)) {
    return { op, status: 'unclear', reason: 'missing-target', candidates: [] };
  }

  const items = collectEditableItems(m, ownerWords);
  const specificQ = qWords.filter((w) => !BROAD_TOPICS.has(w));
  const matched = items.map((it) => {
    const specHits = specificQ.filter((w) => it.allWords.has(w));
    const allHits = qWords.filter((w) => it.allWords.has(w));
    if (specificQ.length > 0 && specHits.length === 0) return null;
    if (allHits.length === 0) return null;
    return { ...it, matchedWords: specHits.length ? specHits : allHits, score: specHits.length * 10 + allHits.length };
  }).filter(Boolean);

  if (!matched.length) {
    const prot = hasProtectedMatchOnly(m, qWords);
    if (prot) return { op, status: 'protected', category: prot };
    return { op, status: 'not-found', targetTopic: qWords.join(' ') };
  }

  matched.sort((a, b) => b.score - a.score);
  const topScore = matched[0].score;
  const topMatches = matched.filter((x) => x.score === topScore);
  // Check if topMatches refer to distinct facts
  const uniqueTexts = [...new Set(topMatches.map((x) => x.text.toLowerCase()))];
  if (uniqueTexts.length > 1) {
    return { op, status: 'unclear', reason: 'ambiguous-target', candidates: topMatches.map((x) => x.fact) };
  }

  const best = topMatches[0];
  if (op === 'correct') {
    if (!replacementText) return { op: 'correct', status: 'unclear', reason: 'missing-replacement', target: best };
    // Build full replacement text preserving verb/structure when target is a preference/story
    let fullNewText = replacementText;
    if (specificQ.length === 1 && new RegExp(`\\b${specificQ[0]}\\b`, 'i').test(best.text) && words(replacementText).length <= 4 && !/^(?:plays?|likes?|loves?|enjoys?|prefers?)\b/i.test(replacementText)) {
      const repCore = replacementText.replace(/\s+at\s+school$/i, '').trim();
      fullNewText = best.text.replace(new RegExp(`\\b${specificQ[0]}\\b`, 'i'), repCore);
    } else if (best.kind === 'story' && !/^(?:plays?|likes?|loves?|enjoys?|prefers?|went|has|is)\b/i.test(fullNewText) && /^plays\b/i.test(best.text)) {
      fullNewText = `plays ${fullNewText}`;
    } else if (best.kind === 'likes' && !/^(?:likes?|loves?|enjoys?|prefers?)\b/i.test(fullNewText)) {
      fullNewText = `likes ${fullNewText}`;
    }
    return { op: 'correct', status: 'ready', target: best, replacementText: clip(fullNewText, 200) };
  }
  return { op: 'forget', status: 'ready', target: best, replacementText: '' };
}

// ---- Feature 2: Bounded In-Conversation Initiative (permitted senior-told topic selector) ----
function nudgeTopicFact(memory, opts = {}) {
  const m = memory && typeof memory === 'object' && memory.memory && typeof memory.memory === 'object' ? memory.memory : (memory || {});
  const owner = String(opts.ownerName || (memory && memory.name) || '').trim();
  const ownerWords = new Set(words(owner));
  const changed = changedSetFrom(opts.changed);
  const mentioned = opts.mentioned instanceof Set ? opts.mentioned : new Set(Array.isArray(opts.mentioned) ? opts.mentioned : []);
  const histText = Array.isArray(opts.history) ? opts.history.map((h) => h && h.content || '').join(' ') : '';
  const histWords = new Set(words(histText));
  const brushList = Array.isArray(opts.brush) ? opts.brush : [];

  const items = collectEditableItems(m, ownerWords);
  for (const it of items) {
    if (mentioned.has(it.fact)) continue;
    const spec = it.coreWords.filter((w) => !BROAD_TOPICS.has(w));
    if (changed.size && (spec.length ? spec : it.coreWords).some((w) => changed.has(w))) continue;
    if ((spec.length ? spec : it.coreWords).some((w) => histWords.has(w))) continue;
    if (brushList.some((b) => Array.isArray(b.w) && b.w.some((bw) => it.allWords.has(bw)))) continue;
    return { kind: it.kind, who: it.who, text: it.text, told: it.told, fact: it.fact, topic: (spec[0] || it.coreWords[0] || '') };
  }
  return null;
}

module.exports = { callbackFact, challengeFact, changedPreference, unconfirmedFacts, isQuotingOtherOnly, memoryEditIntent, nudgeTopicFact, parseNextCallReminder, addReminderTo, STILL_TO_DO, REMINDER_DAYS, MAX_OPEN_REMINDERS, heavyTalk, OPEN_WORRY_DAYS, DATED_GRACE_DAYS, daysBetween, rel, dateFact, words, score, select, upcoming, dueThread, threadFact, expire, mergeThreads, MAX_THREADS };
