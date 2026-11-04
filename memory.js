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
const suppressedByProfile = new Map(); // id -> [{ oldText, coreWords, replacement, section, who, told }] so pending extraction never restores a forgotten/corrected fact

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
Columns: people = each named person in their life (relationship, birthday, stories = what they said or did, kept close to the words told, including what that person said to the owner, e.g. said he loves her and wants to come over sometime). A thing someone says to the owner goes in that person's stories, not in events; events = life events (past or coming, with date if told); preferences = likes/dislikes; current = things happening around them right now, as they told it; topics = 1-3 short subject labels for this call (a few words each, never sentences from the call); threads = things still open that a caring friend would gently ask about on a later call: a dated event coming up or just past (a visit, an appointment, a trip, a gathering), a worry they raised that was left unresolved, or something they plan to do. Give the absolute due date when the event has one, otherwise leave due empty. One thread per item, short plain text, only what they said. Existing threads carry an id; a thread of kind "reminder" is something they asked to be reminded of on a later call and the app keeps it: never create, copy or reword one, and return it (same id, status closed) only if this call shows it was done; for the rest, leave existing threads out unless this call changes them; when this call shows a thread happened or was settled, return it with the same id and status closed. Also close it when the person declines to talk about it, asks to drop it, or clearly brushes it off: their wish is respected and it is not raised again. Never make a thread from ordinary chat, feelings, memories of the past, or health beyond the person's own words about an upcoming appointment or an unresolved worry, and never advise.
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
  const supList = suppressedByProfile.get(id) || [];
  if (supList.length) {
    const matchesSup = (txt, sup) => {
      const low = String(txt || '').toLowerCase();
      if (sup.oldText && low === sup.oldText.toLowerCase()) return true;
      const wSet = new Set(recall.words(low));
      return sup.coreWords.length > 0 && sup.coreWords.every((w) => wSet.has(w));
    };
    for (const sup of supList) {
      for (const k of ['preferences', 'events', 'current', 'topics']) {
        m[k] = (m[k] || []).filter((it) => !matchesSup(it && it.text, sup));
      }
      for (const person of m.people || []) {
        person.stories = (person.stories || []).filter((s) => !matchesSup(s && s.text, sup));
      }
      m.threads = (m.threads || []).filter((t) => t.kind === 'reminder' || !matchesSup(t && t.text, sup));
      if (sup.op === 'correct' && sup.replacement) {
        if (sup.section === 'preferences' && !m.preferences.some((x) => String(x.text || '').toLowerCase() === sup.replacement.toLowerCase())) {
          m.preferences.push({ who: sup.who || p.name, text: sup.replacement, told: sup.told || date });
        } else if (sup.section === 'events' && !m.events.some((x) => String(x.text || '').toLowerCase() === sup.replacement.toLowerCase())) {
          m.events.push({ who: sup.who || p.name, text: sup.replacement, date: '', told: sup.told || date });
        } else if (sup.section === 'current' && !m.current.some((x) => String(x.text || '').toLowerCase() === sup.replacement.toLowerCase())) {
          m.current.push({ who: sup.who || p.name, text: sup.replacement, told: sup.told || date });
        } else if (sup.section === 'stories' && sup.personName) {
          const per = m.people.find((pe) => String(pe.name || '').toLowerCase() === sup.personName.toLowerCase());
          if (per && !per.stories.some((s) => String(s.text || '').toLowerCase() === sup.replacement.toLowerCase())) {
            per.stories.push({ text: sup.replacement, told: sup.told || date });
          }
        }
      }
    }
  }
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
  const sel = recall.select(m, focus.text, t, { k: 6, changed: focus.changed }).filter((x) => x.kind !== 'person');
  bits.push(sel.length
    ? `Notes that relate to what they just said (only what they told you): ${sel.map((x) => `${kind[x.kind]}${x.told ? `, told ${x.told}` : ''}${x.date ? `, date ${x.date}` : ''}: ${x.who ? `${x.who}: ` : ''}${x.text}`).join(' | ')}`
    : 'None of your other notes relate to what they just said.');
  let out = `What you remember, for this reply (only what they told you; other notes exist but are not shown now, so if they ask about something not shown, say honestly that you cannot think of it right now): ${bits.join('. ')}.`;
  if (focus.memEdit) {
    const ed = focus.memEdit;
    if (ed.status === 'verified') {
      out += ` MEMORY EDIT VERIFIED (operation: ${ed.op}; old fact: ${ed.oldFact}${ed.newFact ? `; new saved fact: ${ed.newFact}` : '; result: removed from saved notes'}): acknowledge calmly without arguing and describe ONLY this verified outcome in your own words. Do NOT claim deletion from every backup, log, server, or external service.`;
    } else if (ed.status === 'unclear') {
      out += ` MEMORY EDIT UNCLEAR (operation: ${ed.op}; reason: ${ed.reason}${ed.candidates && ed.candidates.length ? `; matching notes: ${ed.candidates.join(' | ')}` : ''}${ed.target ? `; matched note: ${ed.target.fact}` : ''}): nothing was changed or deleted yet. Ask ONE short, focused clarification question in your own words (${ed.reason === 'missing-replacement' ? `what they would like the note "${ed.target.text}" changed to` : ed.candidates && ed.candidates.length ? 'which of those notes they mean' : 'which specific note they want to change or remove'}). Do NOT guess and do NOT say anything was updated or deleted.`;
    } else if (ed.status === 'not-found') {
      out += ` MEMORY EDIT NOT FOUND (operation: ${ed.op}; searched for: ${ed.targetTopic}): no matching senior-told note was found in what is saved, so nothing was changed. Say honestly in your own words that you cannot find a matching note in what you have saved; NEVER say "you never told me" or deny their history, and do NOT claim anything was deleted or updated.`;
    } else if (ed.status === 'failed') {
      out += ` MEMORY EDIT NOT VERIFIED (operation: ${ed.op}; target: ${ed.oldFact}): the app could not verify the change on disk, so do NOT claim it was updated, corrected, forgotten, or deleted. Say plainly in one short sentence that you could not confirm the change went through right now.`;
    } else if (ed.status === 'protected') {
      out += ` MEMORY EDIT PROTECTED (category: ${ed.category}): ${ed.category} records cannot be deleted or altered through conversational memory editing${ed.category === 'daily-call' ? ' (to cancel a daily call, they can ask to cancel their daily calls directly)' : ''}. Do NOT claim anything was deleted, forgotten, or changed.`;
    }
  } else if (focus.challenge) {
    if (focus.challenge.status === 'recorded') {
      out += focus.challenge.challengeKind === 'event'
        ? ` MEMORY CHALLENGE (true senior-told record; challenge kind: event; remembered preference fact: ${focus.challenge.fact}; unsupported inference today: ${focus.challenge.topic}${focus.challenge.newToday ? `; current kind today: ${focus.challenge.newToday}` : ''}): give a SCOPED correction in your own words, never total denial and never arguing. Acknowledge the inference error about today (you did not know today's was ${focus.challenge.topic}), stand by the genuine preference record they told you earlier (${focus.challenge.fact})${focus.challenge.newToday ? `, and warmly accept ${focus.challenge.newToday} for today` : ''}. NEVER say you do not remember them telling you about ${focus.challenge.topic}, NEVER say you added it yourself, guessed, or made it up, and do NOT argue with them.`
        : ` MEMORY CHALLENGE (true senior-told record; challenge kind: preference; fact: ${focus.challenge.fact}): they are challenging how you know this or saying they never told you. Stand by the record calmly and kindly in your own words: say they did tell you earlier and state only the record fact (${focus.challenge.fact}), while clarifying you were asking rather than assuming about today. NEVER say you do not remember them telling you, NEVER say you added it yourself, guessed, or made it up, and do NOT argue with them.`;
    } else {
      out += ' MEMORY CHALLENGE (no record in their profile): no eligible senior-told record substantiates this, which means your notes cannot confirm it (NOT proof they never said it). Say honestly and plainly in your own words that you do not have a note of that or cannot think of it right now; NEVER claim they told you earlier and NEVER claim you remembered it, and NEVER say "you never told me" or make a hard denial of their history.';
    }
  } else if (focus.changedPref) {
    out += ` PREFERENCE CHANGE IN CONVERSATION (topic: ${focus.changedPref.topic}): they just told you their preference has changed. Accept what they like or do not like now warmly in your own words; do NOT override them with an older preference in this conversation, and NEVER promise or claim to forget, delete, or update your saved notes.`;
  } else if (focus.thread && focus.reminder) out += ` REMINDER THEY ASKED YOU FOR (a fact for you, not words to say; they wanted you to remind them on their next call, and this is that call): ${focus.thread}. Remind them of it once, simply, in your own words, task first, early in this reply. Add no advice, no health or dose words and nothing about it that they did not say.`;
  else if (focus.thread) out += ` Open follow-up from an earlier call (a fact for you, not words to say): ${focus.thread}. If it fits the moment, ask about it once, simply, in your own words, early in this reply; if what they are saying makes it awkward, leave it.`;
  else if (focus.callback) {
    out += focus.callback.confirmed
      ? ` RELEVANT MEMORY CALLBACK (a fact they told you earlier, not words to copy; topic match: ${focus.callback.topic}; fact: ${focus.callback.fact}; confirmed this turn: yes): they confirmed this kind in this turn, so a warm acknowledgement in your own words is fine, no question needed; add nothing they did not tell you.`
      : ` RELEVANT MEMORY CALLBACK (optional — once-per-conversation ceiling, not a quota; omit entirely if it would interrupt grief, a task, or their actual point; a fact they told you earlier, not words to copy; topic match: ${focus.callback.topic}; fact: ${focus.callback.fact}; question instruction: ask a non-leading question referencing this fact, do NOT assert it): they have NOT confirmed the specific kind or detail in this turn, so do NOT assert or assume they had or did that kind right now, and do NOT ask a leading question assuming today was that kind. Separate past preference from today's event: ask ONE short question in your own words about what kind they had/did today while referencing the liked fact separately, once only, do not require an answer to continue, and add nothing they did not tell you.`;
  } else if (sel.length) {
    out += ` For any note above whose specific kind or detail they have NOT confirmed in this turn, do NOT assert or assume it happened today${focus.callbackUsed ? ' and do NOT bring up another spontaneous callback in this conversation' : '; if you reference it, ask ONE short non-leading question separating their past preference from today'}.`;
  }
  return out;
}

// Next-call reminders (recall.js): code files one the moment the person asks, shows it once on the next call, and reopens it only when they say it is
// still to do. Returns { status:'added'|'duplicate'|'full'|'none' }.
function addReminder(id, task, callId) {
  const p = load(id);
  if (!p || !String(task || '').trim()) return { status: 'none' };
  const r = recall.addReminderTo(p.memory.threads, task, callId, today());
  if (r.status === 'added') { p.memory.threads.push(r.thread); save(p); }
  return { status: r.status };
}
function deliverReminder(id, threadId, callId) {
  const p = load(id);
  const t = p && p.memory.threads.find((x) => x.id === threadId && x.kind === 'reminder');
  if (!t) return false;
  t.asked = (t.asked || 0) + 1; t.deliveredCall = callId;
  save(p);
  return true;
}
// "Not done yet": reminders shown in THIS call come due again on the next call. Returns how many.
function reopenReminders(id, callId) {
  const p = load(id);
  const hit = p ? p.memory.threads.filter((t) => t.kind === 'reminder' && t.status === 'open' && t.deliveredCall === callId && (t.asked || 0) > 0) : [];
  for (const t of hit) { t.asked = 0; t.fromCall = callId; delete t.deliveredCall; }
  if (hit.length) save(p);
  return hit.length;
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
    `This call is on the profile of ${p.name} (${GENDERS[p.gender]}); pronouns are for talking about ${p.name} to others only. This profile was picked for ${p.name}, so the person talking is ${p.name} unless they say they are someone else: if asked who they are or whether you know them, say yes, they are ${p.name}. If another person joins and speaks, they are a separate person, keep their facts apart. NAME RULE: call them ${p.name} and no other name, never a name you guessed or made up. A different name you hear for them is a mishearing or another person's: do not use it for them. If you are unsure who is speaking, say so or ask; never guess a name.`];
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
  if (focus && !focus.full && (mem.length || focus.thread || focus.callback || focus.challenge || focus.changedPref || focus.memEdit)) lines.push(focusedMemory(m, focus, tz));   // one reply's worth: only what relates to what was just said
  else {
    lines.push(mem.length ? `What you remember (only what they told you; nothing else is known): ${mem.join(' | ')}` : 'You have no memories of this person yet.');
    if (focus && focus.full) lines.push(`USER-PROMPTED RECALL: answer ONLY what they asked using only their own senior-told notes above; do NOT introduce extra unrelated facts${focus.alreadyMentioned ? `, and do NOT redundantly repeat a fact already mentioned earlier in this conversation (${focus.alreadyMentioned}) unless they specifically asked about it` : ''}.`);
  }
  return lines.join(' ');
}

// Applies a senior-requested correction or deletion to their own non-medical conversational memory, updates dependent recall copies,
// suppresses pending extraction from restoring the old fact, and verifies the saved result by reading back from disk before confirming.
function applyMemoryEdit(id, plan, opts = {}) {
  if (!plan || plan.status !== 'ready' || !plan.target) return plan || null;
  const p = load(id);
  if (!p || p.id !== id) return { op: plan.op, status: 'failed', oldFact: plan.target.fact, error: 'profile not found' };
  const target = plan.target;
  const date = today(opts.tz);
  const beforeSnap = JSON.stringify(p.memory);
  const specWords = (target.coreWords || []).filter((w) => w.length >= 3);
  const keyWords = Array.isArray(target.matchedWords) && target.matchedWords.length
    ? target.matchedWords.filter((w) => w.length >= 3)
    : specWords;
  const matchesTargetWords = (txt) => {
    const low = String(txt || '').toLowerCase();
    if (!low) return false;
    if (low === String(target.text || '').toLowerCase()) return true;
    const wSet = new Set(recall.words(low));
    return keyWords.length > 0 && keyWords.every((w) => wSet.has(w));
  };

  let personName = '';
  try {
    if (plan.op === 'forget') {
      if (target.section === 'preferences') {
        p.memory.preferences = (p.memory.preferences || []).filter((it, idx) => idx !== target.index && !matchesTargetWords(it && it.text));
      } else if (target.section === 'events') {
        p.memory.events = (p.memory.events || []).filter((it, idx) => idx !== target.index && !matchesTargetWords(it && it.text));
      } else if (target.section === 'current') {
        p.memory.current = (p.memory.current || []).filter((it, idx) => idx !== target.index && !matchesTargetWords(it && it.text));
      } else if (target.section === 'stories') {
        const per = p.memory.people && p.memory.people[target.personIndex];
        if (per && Array.isArray(per.stories)) {
          personName = per.name || '';
          per.stories = per.stories.filter((s, idx) => idx !== target.storyIndex && !matchesTargetWords(s && s.text));
        }
      }
      p.memory.topics = (p.memory.topics || []).filter((t) => !matchesTargetWords(t && t.text));
      p.memory.threads = (p.memory.threads || []).filter((t) => t.kind === 'reminder' || !matchesTargetWords(t && t.text));
    } else if (plan.op === 'correct') {
      const rep = clip(plan.replacementText, 200);
      if (target.section === 'preferences' && p.memory.preferences && p.memory.preferences[target.index]) {
        p.memory.preferences[target.index] = { ...p.memory.preferences[target.index], text: rep, told: date };
      } else if (target.section === 'events' && p.memory.events && p.memory.events[target.index]) {
        p.memory.events[target.index] = { ...p.memory.events[target.index], text: rep, told: date };
      } else if (target.section === 'current' && p.memory.current && p.memory.current[target.index]) {
        p.memory.current[target.index] = { ...p.memory.current[target.index], text: rep, told: date };
      } else if (target.section === 'stories') {
        const per = p.memory.people && p.memory.people[target.personIndex];
        if (per && Array.isArray(per.stories) && per.stories[target.storyIndex]) {
          personName = per.name || '';
          per.stories[target.storyIndex] = { ...per.stories[target.storyIndex], text: rep, told: date };
        }
      }
      p.memory.topics = (p.memory.topics || []).filter((t) => !matchesTargetWords(t && t.text));
      p.memory.threads = (p.memory.threads || []).map((t) => (t.kind !== 'reminder' && matchesTargetWords(t && t.text) ? { ...t, text: rep } : t));
    }

    save(p);
    // Verify the stored result by reading back directly from disk before confirming
    const diskRaw = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    const diskMem = diskRaw && diskRaw.memory ? diskRaw.memory : null;
    if (!diskMem) throw new Error('disk memory missing');
    const collectTexts = (mem) => [
      ...(mem.preferences || []).map((x) => x.text),
      ...(mem.events || []).map((x) => x.text),
      ...(mem.current || []).map((x) => x.text),
      ...(mem.people || []).flatMap((pe) => (pe.stories || []).map((s) => s.text)),
    ].map((s) => String(s || '').toLowerCase());
    const diskTexts = collectTexts(diskMem);
    const oldStillThere = diskTexts.includes(String(target.text || '').toLowerCase());
    const newPresent = plan.op === 'correct' ? diskTexts.includes(String(plan.replacementText || '').toLowerCase()) : true;
    if (oldStillThere || !newPresent) throw new Error('disk verification mismatch');
  } catch (e) {
    p.memory = JSON.parse(beforeSnap);
    return { op: plan.op, status: 'failed', oldFact: target.fact, error: String(e && e.message || 'write failed') };
  }

  // Record suppression tombstone and scrub pending lines so pending extraction never restores the old fact
  const list = suppressedByProfile.get(id) || [];
  list.push({
    op: plan.op,
    section: target.section,
    who: target.who,
    personName,
    oldText: target.text,
    coreWords: keyWords,
    replacement: plan.op === 'correct' ? clip(plan.replacementText, 200) : '',
    told: date,
  });
  suppressedByProfile.set(id, list);
  try {
    const pend = readPending(id);
    if (pend.length) {
      const filtered = pend.filter((l) => !l.text || !matchesTargetWords(l.text));
      if (filtered.length !== pend.length) {
        if (filtered.length) fs.writeFileSync(pendingFile(id), filtered.map((l) => JSON.stringify(l)).join('\n') + '\n');
        else fs.rmSync(pendingFile(id), { force: true });
      }
    }
  } catch { /* ignore pending scrub error */ }

  // Update dependent recall state on the active session while preserving Fix 1.2 callbackUsed once-only counter
  const s = opts.session;
  if (s) {
    if (s.profile && s.profile.id === id) s.profile.memory = p.memory;
    s._changedPrefs = s._changedPrefs || new Set();
    for (const w of specWords) s._changedPrefs.add(w);
    if (s._lastCallback && s._lastCallback.fact === target.fact) s._lastCallback = null;
    if (s.callbackShown && s.callbackShown.fact === target.fact) s.callbackShown = null;
    if (s.focus && s.focus.callback && s.focus.callback.fact === target.fact) s.focus.callback = null;
    if (s._mentionedCallbacks instanceof Set) s._mentionedCallbacks.delete(target.fact);
  }

  const newFact = plan.op === 'correct'
    ? `${target.who ? `${target.who}: ` : ''}${clip(plan.replacementText, 200)}; told ${date}`
    : null;
  return { op: plan.op, status: 'verified', oldFact: target.fact, newFact, section: target.section };
}

module.exports = { listProfiles, createProfile, deleteProfile, load, startCall, appendTurn, noteNames, endCall, flushPending, recoverAll, profileNote, markAsked, addReminder, deliverReminder, reopenReminders, applyMemoryEdit, suppressedByProfile, today, GENDERS };
