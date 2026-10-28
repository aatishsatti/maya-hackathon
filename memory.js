// Per-profile memory: one JSON file per profile in data/profiles/<id>.json (no database, easy to
// read by hand, survives restarts; data/ is git-ignored because it holds family details).
// A call loads ONLY its own profile's file. No transcripts are ever stored: after a call, Spark
// turns the call's words into the columns below and the words are thrown away.
//   { id, name, gender, created, lastCallHeavy,
//     memory: { people:[{name, relationship, birthday, stories:[{text,told}]}],
//               events:[{who,text,date,told}], preferences:[{who,text,told}],
//               current:[{who,text,told}], topics:[{text,told}] } }
// "told" is the YYYY-MM-DD the fact was told. Facts are only what was said, never diagnosed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sparkComplete } = require('./brain');
const recall = require('./recall');

const DIR = process.env.MAYA_DATA_DIR || path.join(__dirname, 'data', 'profiles'); // env override is for tests
const GENDERS = { female: 'she/her', male: 'he/him', 'prefer-not': 'they/them' };
const MAX_TOPICS = 12;
const MAX_ITEMS = 80;
const cache = new Map(); // id -> profile (loaded from disk on first use)
const writeQueue = new Map(); // id -> promise chain, so two extractions never overlap

fs.mkdirSync(DIR, { recursive: true });

const emptyMemory = () => ({ people: [], events: [], preferences: [], current: [], topics: [], threads: [] });   // threads: open follow-ups (recall.js); an older file without them loads with none
const file = (id) => path.join(DIR, `${id}.json`);
const today = (tz) => new Date().toLocaleDateString('en-CA', tz ? { timeZone: tz } : undefined); // YYYY-MM-DD

function save(p) {
  const tmp = `${file(p.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file(p.id));
}

function load(id) {
  if (!/^[a-f0-9]{8}$/.test(String(id))) return null;
  if (cache.has(id)) return cache.get(id);
  let p;
  try { p = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
  p.memory = { ...emptyMemory(), ...(p.memory || {}) };
  if (!Array.isArray(p.memory.threads)) p.memory.threads = [];
  cache.set(id, p);
  return p;
}

// Removes a profile and its files. Never touches another profile.
function deleteProfile(id) {
  if (!load(id)) return false;
  cache.delete(id);
  for (const f of [file(id), `${file(id)}.bak`, `${file(id)}.tmp`, pendingFile(id)]) fs.rmSync(f, { force: true });
  return true;
}

function listProfiles() {
  return fs.readdirSync(DIR).filter((f) => /^[a-f0-9]{8}\.json$/.test(f))
    .map((f) => load(f.slice(0, 8))).filter(Boolean)
    .sort((a, b) => a.created.localeCompare(b.created))
    .map((p) => ({ id: p.id, name: p.name, gender: p.gender }));
}

function createProfile(name, gender) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}][\p{L} '\-]{0,29}$/u.test(name)) throw Object.assign(new Error('Please enter a name (letters only).'), { status: 400 });
  if (!GENDERS[gender]) throw Object.assign(new Error('Please choose Female, Male or Prefer not to say.'), { status: 400 });
  const dup = listProfiles().find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (dup) throw Object.assign(new Error(`${dup.name} already exists, pick that one.`), { status: 409 });
  const p = { id: crypto.randomBytes(4).toString('hex'), name, gender, created: new Date().toISOString(), lastCallHeavy: false, memory: emptyMemory() };
  save(p);
  cache.set(p.id, p);
  return { id: p.id, name: p.name, gender: p.gender };
}

const clip = (v, n = 300) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// Keeps only the expected shape from whatever Spark returned.
function sanitize(m, fallbackDate, existingThreads) {
  const told = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x && x.told) ? x.told : fallbackDate);
  const arr = (a) => (Array.isArray(a) ? a.slice(0, MAX_ITEMS) : []);
  const out = emptyMemory();
  for (const x of arr(m.people)) {
    if (!x || !clip(x.name, 40)) continue;
    out.people.push({
      name: clip(x.name, 40), relationship: clip(x.relationship, 60), birthday: clip(x.birthday, 40),
      stories: arr(x.stories).map((s) => ({ text: clip(s && s.text, 1500), told: told(s) })).filter((s) => s.text),
    });
  }
  for (const k of ['events', 'preferences', 'current']) {
    for (const x of arr(m[k])) {
      if (!x || !clip(x.text)) continue;
      out[k].push({ who: clip(x.who, 40), text: clip(x.text), ...(k === 'events' ? { date: clip(x.date, 40) } : {}), told: told(x) });
    }
  }
  out.threads = recall.mergeThreads(existingThreads, m.threads, fallbackDate);   // Spark proposes, code merges (told / asked are never Spark's)
  out.topics = arr(m.topics).map((x) => ({ text: clip(x && x.text, 120), told: told(x) })).filter((x) => x.text).slice(-MAX_TOPICS);
  return out;
}

const EXTRACT_INSTRUCTIONS = `You update a memory file for Maya, a voice companion for an older adult. You get the CURRENT MEMORY (JSON), the profile owner's name, today's date, and the words of ONE finished call, each line "Name: words" (a line from "Speaker X" means the name is not known).
Return ONLY the full updated memory as JSON, no other text, no code fences, with exactly these keys:
{"people":[{"name":"","relationship":"to the profile owner","birthday":"","stories":[{"text":"","told":"YYYY-MM-DD"}]}],
 "events":[{"who":"","text":"","date":"","told":"YYYY-MM-DD"}],
 "preferences":[{"who":"","text":"","told":"YYYY-MM-DD"}],
 "current":[{"who":"","text":"","told":"YYYY-MM-DD"}],
 "topics":[{"text":"","told":"YYYY-MM-DD"}],
 "threads":[{"id":"","who":"","text":"","due":"YYYY-MM-DD or empty","kind":"event|worry|plan","status":"open|closed"}],
 "removed":["short phrase of each old fact this call corrected or showed is no longer true, e.g. ice cream"]}
Columns: people = each named person in their life (relationship, birthday, stories = what they said or did, kept close to the words told, including what that person said to the owner, e.g. said he loves her and wants to come over sometime). A thing someone says to the owner goes in that person's stories, not in events; events = life events (past or coming, with date if told); preferences = likes/dislikes; current = things happening around them right now, as they told it; topics = 1-3 short subject labels for this call (a few words each, never sentences from the call); threads = things still open that a caring friend would gently ask about on a later call: a dated event coming up or just past (a visit, an appointment, a trip, a gathering), a worry they raised that was left unresolved, or something they plan to do. Give the absolute due date when the event has one, otherwise leave due empty. One thread per item, short plain text, only what they said. Existing threads carry an id: leave them out unless this call changes them; when this call shows a thread happened or was settled, return it with the same id and status closed. Never make a thread from ordinary chat, feelings, memories of the past, or health beyond the person's own words about an upcoming appointment or an unresolved worry, and never advise.
Rules:
- Keep every existing item unless this call corrects or contradicts it. A correction REPLACES the old fact: the old one must not remain anywhere (no "used to"), and that includes topics: delete or reword any topic that names the old fact, and list the old fact in \"removed\" (an empty list if nothing was corrected).
- Only record what was actually said, as told. Never guess, infer, diagnose, interpret or recommend. Health things are recorded only as the person said them, in their words.
- "who" is the person the fact is about, by name (the profile owner's name for the owner). If the speaker's name is unknown, do not guess who they are: use "an unnamed speaker".
- Never merge one person's facts into another's. A fact told by one speaker about themselves belongs to that speaker; a fact about someone else goes under that someone. Keep two stories separate.
- "current" holds only what is happening now: when this call shows an item is over or no longer true, remove it; drop current items told more than 3 days before today.
- Dates: write absolute dates (YYYY-MM-DD, or MM-DD for a birthday without a year) using today's date for "today", "yesterday", "tomorrow", "next week". "told" is today's date for anything new from this call, and unchanged for old items.
- A story or sequence of events the person tells goes into that person's stories complete, in order, as told, never shortened to one detail. Keep every other text short and plain, in English even if the call was in another language (keep names as spoken). Remove empty or duplicate items. Keep only the 12 newest topics.`;

function parseJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Memory update had no JSON');
  return JSON.parse(text.slice(a, b + 1));
}

// ---- Per-turn saving ----
// Every turn is appended to data/profiles/<id>.pending.jsonl the moment it happens (disk append only, no
// Spark, never in the way of the voice). Extraction runs in the background at call end, at server start and
// before the next call of that profile; a crash can lose extraction work, never the raw words. The pending
// words are a temporary buffer and are deleted once Spark has filed them into the columns.
// Lines: {call, meta:{tz}} | {call, names:{A:'Mike'}} | {call, label|who, text, userSaid} | {call, heavy:true}
const pendingFile = (id) => path.join(DIR, `${id}.pending.jsonl`);
const activeCalls = new Set();

function appendPending(id, call, entry) {
  if (!load(id)) return;
  try { fs.appendFileSync(pendingFile(id), `${JSON.stringify({ call, ...entry })}\n`); }
  catch (e) { console.error('Memory save failed:', e.message); }
}
const startCall = (id, call, tz) => { activeCalls.add(call); appendPending(id, call, { meta: { tz: tz || null } }); };
const appendTurn = (id, call, entry) => appendPending(id, call, entry);
const noteNames = (id, call, names) => appendPending(id, call, { names });

function readPending(id) {
  let raw;
  try { raw = fs.readFileSync(pendingFile(id), 'utf8'); } catch { return []; }
  return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Removes the given calls' lines (read-modify-write with no await, so live appends are not lost).
function dropPending(id, calls) {
  const rest = readPending(id).filter((l) => !calls.has(l.call));
  if (rest.length) fs.writeFileSync(pendingFile(id), rest.map((l) => JSON.stringify(l)).join('\n') + '\n');
  else fs.rmSync(pendingFile(id), { force: true });
}

// Files every finished call's pending words (one Spark call per call, in order). A call still live is left alone.
function flushPending(id) {
  const prev = writeQueue.get(id) || Promise.resolve();
  const next = prev.then(async () => {
    const lines = readPending(id);
    const order = [...new Set(lines.map((l) => l.call))].filter((c) => !activeCalls.has(c));
    for (const call of order) {
      const mine = lines.filter((l) => l.call === call);
      const names = Object.assign({}, ...mine.filter((l) => l.names).map((l) => l.names));
      const tz = (mine.find((l) => l.meta) || { meta: {} }).meta.tz;
      const heavy = mine.some((l) => l.heavy);
      const said = mine.filter((l) => l.text).map((l) => ({ who: l.who || names[l.label] || `Speaker ${l.label || '?'}`, text: l.text, userSaid: l.userSaid }));
      const ok = await extract(id, said, { heavy, tz });
      if (!ok) break; // keep the words on disk; try again at the next start or call
      dropPending(id, new Set([call]));
    }
  }).catch((e) => console.error('Memory update error:', e.message));
  writeQueue.set(id, next);
  return next;
}

// Call over: its words stay in the pending file until extracted.
function endCall(id, call, { heavy = false } = {}) {
  if (heavy) appendPending(id, call, { heavy: true });
  activeCalls.delete(call);
  return flushPending(id);
}

// Server start: file whatever a crash left behind.
function recoverAll() {
  for (const f of fs.readdirSync(DIR)) { const m = /^([a-f0-9]{8})\.pending\.jsonl$/.exec(f); if (m) flushPending(m[1]); }
}

// Returns true when the memory file was updated (or there was nothing to learn).
async function extract(id, said, { heavy = false, tz } = {}) {
  const p = load(id);
  if (!p) return true;
  if (!said.some((l) => l.userSaid)) return true; // nobody spoke: nothing to learn
  const date = today(tz);
  const transcript = said.map((l) => `${l.who}: ${l.text}`).join('\n');
  const user = `Today: ${date}\nProfile owner: ${p.name}\nCURRENT MEMORY:\n${JSON.stringify(p.memory)}\n\nCALL:\n${transcript}`;
  let raw;
  try { raw = await sparkComplete(EXTRACT_INSTRUCTIONS, user); } catch (e) { console.error('Memory update failed:', e.message); return false; }
  let m;
  let removed;
  try { const j = parseJson(raw); m = sanitize(j, date, p.memory.threads); removed = (Array.isArray(j.removed) ? j.removed : []).map((x) => clip(x, 60).toLowerCase()).filter((x) => x.length >= 4); }
  catch (e) { console.error('Memory update unreadable:', e.message); return false; }
  // A corrected fact leaves no label behind: topics naming anything Spark says was removed are dropped here too.
  m.topics = m.topics.filter((t) => !removed.some((r) => t.text.toLowerCase().includes(r)));
  if (fs.existsSync(file(id))) fs.copyFileSync(file(id), `${file(id)}.bak`);
  p.memory = m;
  p.lastCallHeavy = Boolean(heavy);
  save(p);
  console.log('memory updated', JSON.stringify({ profile: id, people: m.people.length, events: m.events.length, preferences: m.preferences.length, current: m.current.length, topics: m.topics.length }));
  return true;
}

// The memory text for ONE reply (see recall.js): the people in their life, dates around now already worked out, the few items that relate
// to what the person just said, and at most one due follow-up. All facts; the rest of the file is not shown, and Spark is told so.
function focusedMemory(m, focus, tz) {
  const t = today(tz);
  const bits = [];
  if (m.people.length) bits.push(`People in their life: ${m.people.map((x) => `${x.name}${x.relationship ? ` (${x.relationship})` : ''}`).join(', ')}`);
  const up = recall.upcoming(m, t);
  if (up.length) bits.push(`Dates around now, worked out for you: ${up.map((u) => `${u.text} ${u.when}`).join('; ')}`);
  const kind = { person: 'Person', story: 'Told about', event: 'Life event', likes: 'Likes', current: 'Happening around them', topic: 'Recent topic' };
  const sel = recall.select(m, focus.text, t, { k: 6 }).filter((x) => x.kind !== 'person');
  bits.push(sel.length
    ? `Notes that relate to what they just said (only what they told you): ${sel.map((x) => `${kind[x.kind]}${x.told ? `, told ${x.told}` : ''}${x.date ? `, date ${x.date}` : ''}: ${x.who ? `${x.who}: ` : ''}${x.text}`).join(' | ')}`
    : 'None of your other notes relate to what they just said.');
  let out = `What you remember, for this reply (only what they told you; other notes exist but are not shown now, so if they ask about something not shown, say honestly that you cannot think of it right now): ${bits.join('. ')}.`;
  if (focus.thread) out += ` Open follow-up from an earlier call (a fact for you, not words to say): ${focus.thread}. If it fits the moment, ask about it once, simply, in your own words, early in this reply; if what they are saying makes it awkward, leave it.`;
  return out;
}

// A follow-up thread was offered to Spark: count it (never more than two offers in total, see recall.dueThread). Returns false if not found.
function markAsked(id, threadId) {
  const p = load(id);
  const t = p && p.memory.threads.find((x) => x.id === threadId);
  if (!t) return false;
  t.asked = (t.asked || 0) + 1;
  save(p);
  return true;
}

// Text for Spark's instructions: who this profile is, the date/time now, and only this profile's memory.
function profileNote(p, tz, focus = null) {
  const now = new Date();
  const opt = tz ? { timeZone: tz } : {};
  const when = `${now.toLocaleDateString('en-US', { ...opt, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${now.toLocaleTimeString('en-US', { ...opt, hour: 'numeric', minute: '2-digit' })}`;
  const m = p.memory;
  const lines = [`Current date and time where they are: ${when} (${today(tz)}).`,
    `This call is on the profile of ${p.name} (${GENDERS[p.gender]}); pronouns are for talking about ${p.name} to others only. This profile was picked for ${p.name}, so the person talking is ${p.name} unless they say they are someone else: if asked who they are or whether you know them, say yes, they are ${p.name}. If another person joins and speaks, they are a separate person, keep their facts apart.`];
  const mem = [];
  const who = (x) => (x.who ? `${x.who}: ` : '');
  m.people.forEach((x) => {
    const bits = [x.relationship && `relationship: ${x.relationship}`, x.birthday && `birthday: ${x.birthday}`, ...x.stories.map((s) => `told ${s.told}: ${s.text}`)].filter(Boolean);
    mem.push(`Person ${x.name}${bits.length ? ` (${bits.join('; ')})` : ''}`);
  });
  m.events.forEach((x) => mem.push(`Life event, told ${x.told}${x.date ? `, date ${x.date}` : ''}: ${who(x)}${x.text}`));
  m.preferences.forEach((x) => mem.push(`Likes, told ${x.told}: ${who(x)}${x.text}`));
  m.current.forEach((x) => mem.push(`Happening around them, told ${x.told}: ${who(x)}${x.text}`));
  m.topics.slice(-5).forEach((x) => mem.push(`Recent topic, ${x.told}: ${x.text}`));
  if (focus && !focus.full && mem.length) lines.push(focusedMemory(m, focus, tz));   // one reply's worth: only what relates to what was just said
  else lines.push(mem.length ? `What you remember (only what they told you; nothing else is known): ${mem.join(' | ')}` : 'You have no memories of this person yet.');
  return lines.join(' ');
}

module.exports = { listProfiles, createProfile, deleteProfile, load, startCall, appendTurn, noteNames, endCall, flushPending, recoverAll, profileNote, markAsked, today, GENDERS };
