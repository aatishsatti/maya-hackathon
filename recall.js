// Memory that thinks (step 1): pure rules for WHICH memory matters now and WHICH open follow-up is due. No network, no Spark, no stored state.
// CODE ONLY SELECTS AND DECIDES. Everything it returns is a fact (who, what, a date already worked out); it never returns a sentence for
// Maya to say. Spark phrases every word, from the facts and the principles in brain.js.
//
// Memory shape (see memory.js): { people:[{name,relationship,birthday,stories:[{text,told}]}], events:[{who,text,date,told}],
// preferences:[{who,text,told}], current:[{who,text,told}], topics:[{text,told}], threads:[Thread] }
// Thread: { who, text, due:'YYYY-MM-DD'|'', kind:'event'|'worry'|'plan', status:'open'|'closed'|'expired', asked:number, told:'YYYY-MM-DD' }

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
const DATED_GRACE_DAYS = 14;  // a dated thread is still worth one gentle ask for this long after its date; later it is just over

// Which open thread, if any, should be offered to Spark in this call. At most one.
// ctx: { heavy: the moment is heavy/careful, askedThisCall: a follow-up was already offered in this call }.
function dueThread(threads, today, { heavy = false, askedThisCall = false } = {}) {
  if (heavy || askedThisCall) return null;
  const live = [];
  for (const t of threads || []) {
    if (!t || t.status !== 'open' || (t.asked || 0) >= 2 || !String(t.text || '').trim()) continue;
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
  const f = ISO.test(String(t.due)) ? dateFact(t.due, today) : null;
  const when = f ? `, was due ${t.due} (${f.text})` : '';
  return `${t.who ? `${t.who}: ` : ''}${t.text}${when}; told ${t.told || 'earlier'}`;
}

// Threads that can no longer be asked about are marked expired (never deleted here); everything else is returned unchanged.
function expire(threads, today) {
  return (threads || []).map((t) => {
    if (!t || t.status !== 'open') return t;
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
      if (hit) {
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

module.exports = { heavyTalk, OPEN_WORRY_DAYS, DATED_GRACE_DAYS, daysBetween, rel, dateFact, words, score, select, upcoming, dueThread, threadFact, expire, mergeThreads, MAX_THREADS };
