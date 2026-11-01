// A schedule the person (or the family) gives Maya: by photo, PDF, a typed list, or by telling her. She reads it, learns what is in it (medicine, doctor, meals, walks, calls),
// then ASKS in simple words which items they want as reminders and lists what she saw. Only the items they say yes to become reminders, each a CALL at its time. Nothing is ever set silently.
// CODE owns every step: the extraction is checked item by item (a clear time, a short task taken from their own words), the answer is read by rules (a number, a word of the task,
// yes / all / none / not), and the words Maya says are fixed lines built from the items. The schedule is private: one file per person on the same disk as their chat
// (MEDIA_DIR/<profile id>/schedule.json), never shared, deleted with the person.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MEDIA_DIR = () => process.env.MAYA_MEDIA_DIR || path.join(__dirname, 'data', 'media');
const MAX_ITEMS = 12;
const TTL_MS = 3 * 24 * 3600 * 1000;   // an unanswered question is dropped after this: nothing is set later by a stray "yes"
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const deps = {
  // Reads the schedule text into items. The real one asks the brain; tests replace it. -> [{ task, time: 'HH:MM', repeat, weekday, kind }]
  extract: async (text) => {
    const brain = require('./brain');
    const out = await brain.sparkComplete('Read this schedule. Reply with ONLY a JSON array (no other words) of at most 12 objects: {"task": short words from the text itself, "time": "HH:MM" on a 24 hour clock, "repeat": "daily" | "weekly" | "none", "weekday": 0-6 (0 = Sunday) or null, "kind": "medicine" | "doctor" | "meal" | "walk" | "call" | "other"}. Use ONLY what the text says. If an item has no clear time, leave it out. Never invent a medicine, a dose, a time or a place.', String(text).slice(0, 6000));
    const m = /\[[\s\S]*\]/.exec(String(out || '')); return m ? JSON.parse(m[0]) : [];
  },
};

const file = (id) => path.join(MEDIA_DIR(), id, 'schedule.json');
const valid = (id) => /^[a-f0-9]{8}$/.test(id);
function load(id) { if (!valid(id)) return null; try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } }
function save(id, s) {
  if (!valid(id)) return;
  try { fs.mkdirSync(path.join(MEDIA_DIR(), id), { recursive: true }); const tmp = `${file(id)}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, file(id)); }
  catch (e) { console.log('schedule', JSON.stringify({ event: 'not saved', reason: String((e && e.message) || e).slice(0, 80) })); }
}
const forget = (id) => { if (valid(id)) { try { fs.rmSync(file(id), { force: true }); } catch { /* none */ } } };

// Does this text look like a schedule? Two clock times, or one with a word like schedule / routine / timetable.
const TIME = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
function looksLikeSchedule(text) {
  const t = String(text || ''); const n = (t.match(TIME) || []).length;
  return n >= 2 || (n >= 1 && /\b(?:schedule|routine|timetable|my day|medicine list|pill list)\b/i.test(t));
}

const h12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const whenOf = (it) => `${h12(it.time)}${it.repeat === 'daily' ? ' every day' : it.repeat === 'weekly' && it.weekday != null ? ` every ${WEEKDAYS[it.weekday]}` : ''}`;
const lineOf = (it) => `${it.task} at ${whenOf(it)}`;

// Checks what the reader returned, item by item. Anything unclear is left out, never guessed.
function clean(items) {
  const out = [];
  for (const x of Array.isArray(items) ? items : []) {
    if (!x || typeof x !== 'object') continue;
    const task = String(x.task || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(x.time || '').trim());
    if (task.length < 3 || !time) continue;
    const repeat = ['daily', 'weekly', 'none'].includes(x.repeat) ? x.repeat : 'none';
    const weekday = Number.isInteger(x.weekday) && x.weekday >= 0 && x.weekday <= 6 ? x.weekday : null;
    if (repeat === 'weekly' && weekday == null) continue;
    out.push({ id: String(out.length + 1), task, time: `${String(Number(time[1])).padStart(2, '0')}:${time[2]}`, repeat, weekday, kind: String(x.kind || 'other').slice(0, 12), status: 'proposed' });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// Learns the schedule from text and asks. Returns the words Maya says, or null when there is nothing clear in it. Nothing is set.
async function propose(profileId, text, { now = Date.now() } = {}) {
  let items = [];
  try { items = clean(await deps.extract(text)); } catch (e) { console.log('schedule', JSON.stringify({ event: 'not read', reason: String((e && e.message) || e).slice(0, 60) })); }
  if (!items.length) return null;
  save(profileId, { at: now, items });
  const list = items.map((it) => `${it.id}. ${lineOf(it)}.`).join(' ');
  return `I read your schedule and this is what I saw: ${list} Do you want any reminders from your schedule? For each one, tell me yes or no. You can say "all", "none", or "yes to 1 and 3". I will not set anything until you say.`;
}

const pending = (profileId, now = Date.now()) => { const s = load(profileId); return s && s.items && s.items.some((i) => i.status === 'proposed') && now - s.at < TTL_MS ? s : null; };

const NEG = /\b(?:no|not|don'?t|do not|skip|without|except|nope|none|nothing|never ?mind|no thanks)\b/i;
const NUMW = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// Reads their answer: per item yes / no / not mentioned. null when the words are not an answer to this question at all.
function readAnswer(text, items) {
  const t = String(text || '').toLowerCase().replace(/[’]/g, "'").trim();
  if (!t) return null;
  const yes = /\b(?:yes|yeah|yep|yup|sure|please|ok(?:ay)?|go ahead|do it|set (?:them|it|all))\b/.test(t), neg = NEG.test(t);
  const all = /\b(?:all|everything|each|every one|all of them|them all)\b/.test(t);
  const none = /^(?:no|nope|none|nothing|no thanks|no thank you|not now|don'?t)\b/.test(t) || /\bnone\b|\bnone of\b|\bnot any\b/.test(t) || (/\bno\b/.test(t) && !/\b(?:yes|and|but)\b/.test(t) && !all && !mentions(t, items).length);
  if (none && !(yes && !/^no\b/.test(t))) return items.map((i) => [i.id, 'no']);
  if (all && !neg) return items.map((i) => [i.id, 'yes']);
  const m = mentions(t, items);
  if (m.length) {
    // each mentioned item: "not the walk" / "no to 2" / "skip" before it -> no; otherwise yes. Items not mentioned are not set.
    return items.map((i) => { const hit = m.find((x) => x.id === i.id); return [i.id, hit ? (hit.no ? 'no' : 'yes') : 'unsaid']; });
  }
  if (yes && !neg) return items.map((i) => [i.id, 'yes']);   // a plain yes to the list
  return null;
}
function mentions(t, items) {
  const found = [];
  const clauses = t.split(/\b(?:but|and then|however|;)\b|[.,]/);
  for (const c of clauses) {
    const no = NEG.test(c) && !/\byes\b/.test(c);
    const nums = new Set([...(c.match(/\b\d{1,2}\b/g) || []).map(Number), ...c.split(/\W+/).map((w) => NUMW[w]).filter(Boolean)]);
    for (const it of items) {
      const words = it.task.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !['take', 'your', 'with', 'have'].includes(w));
      const byNum = nums.has(Number(it.id)), byWord = words.some((w) => new RegExp(`\\b${w}`).test(c)) || (it.kind !== 'other' && new RegExp(`\\b${it.kind}`).test(c));
      if ((byNum || byWord) && !found.some((x) => x.id === it.id)) found.push({ id: it.id, no });
    }
  }
  return found;
}

// Their answer: only the yes items become reminders (a call at that time, in the app), and Maya says exactly what was set and what was not.
function answer(profileId, text, { tz = null, now = Date.now() } = {}) {
  const s = pending(profileId, now); if (!s) return null;
  const verdict = readAnswer(text, s.items); if (!verdict) return null;
  const care = require('./care'), setrem = require('./setrem');
  const set = [], skipped = [], failed = [];
  for (const [id, v] of verdict) {
    const it = s.items.find((x) => x.id === id);
    if (v !== 'yes') { it.status = v === 'no' ? 'no' : 'no'; skipped.push(it); continue; }
    const phrase = `remind me ${it.repeat === 'daily' ? 'every day' : it.repeat === 'weekly' ? `every ${WEEKDAYS[it.weekday].toLowerCase()}` : 'today'} at ${h12(it.time).toLowerCase()} to ${it.task}`;
    const spec = setrem.parseRequest(phrase, { now, tz });
    if (!spec.dueAt || spec.noTz) { failed.push(it); continue; }
    try {
      care.addSeniorReminder(profileId, { task: it.task, dueAt: spec.dueAt, repeat: spec.repeat, every: spec.every || 1, deliver: 'call', channel: 'app', origin: 'app' });
      it.status = 'set'; set.push(it);
    } catch { failed.push(it); }
  }
  for (const it of failed) it.status = 'proposed';
  save(profileId, s);
  const parts = [];
  if (set.length) parts.push(`Done. I will call you for: ${set.map(lineOf).join('; ')}.`);
  if (skipped.length) parts.push(`I did not set: ${skipped.map((i) => i.task).join('; ')}.`);
  if (failed.length) parts.push(`I could not set ${failed.map((i) => i.task).join('; ')} just now. Tell me again and I will try.`);
  if (!set.length && !failed.length) parts.unshift('Okay, I have not set any reminders.');
  parts.push('You can ask me to change this any time.');
  return parts.join(' ');
}

// One step for a typed message: an answer to an open question, or a new schedule told to Maya. Returns { text } or null (the message is ordinary chat).
async function handle(profileId, text, { tz = null, now = Date.now() } = {}) {
  if (pending(profileId, now)) { const a = answer(profileId, text, { tz, now }); if (a) return { text: a }; }
  if (looksLikeSchedule(text)) { const p = await propose(profileId, text, { now }); if (p) return { text: p }; }
  return null;
}

module.exports = { deps, handle, propose, answer, pending, looksLikeSchedule, readAnswer, clean, forget, file, load, MAX_ITEMS, TTL_MS };
