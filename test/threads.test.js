// Memory file threads (conversation brain / memory that thinks, step 2): the filing step records open follow-ups and closes them, an
// older memory file without threads still loads, and the old columns keep working. Spark is stubbed; the sentences are test-only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-threads-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
const queue = []; const seen = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkStream: async () => '',
  sparkComplete: async (instructions, user) => { seen.push({ instructions, user }); const r = queue.shift(); if (r instanceof Error) throw r; return r; },
} };
const memory = require('../memory');
const TODAY = memory.today();

let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const fresh = () => memory.createProfile(`Ann${letters(n++)}`, 'female').id;
async function call(id, words, reply) {
  queue.push(typeof reply === 'string' ? reply : JSON.stringify(reply));
  const c = `c${Math.random().toString(16).slice(2)}`;
  memory.startCall(id, c, null);
  for (const w of words) memory.appendTurn(id, c, { label: 'A', text: w, userSaid: true });
  await memory.endCall(id, c);
  return memory.load(id).memory;
}
const base = { people: [], events: [], preferences: [], current: [], topics: [] };

test('an older memory file with no threads loads with an empty list and keeps its columns', () => {
  const id = 'abcdef01'; const f = path.join(process.env.MAYA_DATA_DIR, `${id}.json`);   // never created in this process, so load() really reads the file
  const old = { id, name: 'Olga', gender: 'female', created: '2026-01-01T00:00:00.000Z', lastCallHeavy: false, memory: { people: [{ name: 'Priya', relationship: 'granddaughter', birthday: '10-31', stories: [] }], events: [], preferences: [{ who: 'Olga', text: 'likes ginger tea', told: '2026-10-10' }], current: [], topics: [] } };
  fs.writeFileSync(f, JSON.stringify(old));
  assert.equal('threads' in JSON.parse(fs.readFileSync(f, 'utf8')).memory, false, 'the file really is the old shape');
  const loaded = memory.load(id);
  assert.deepEqual(loaded.memory.threads, []); assert.equal(loaded.memory.people[0].name, 'Priya'); assert.equal(loaded.memory.preferences[0].text, 'likes ginger tea');
  assert.match(memory.profileNote(loaded, null), /likes ginger tea/, 'the old columns still reach her notes');
  assert.deepEqual(memory.load(memory.createProfile(`Ann${letters(n++)}`, 'male').id).memory.threads, [], 'a new profile starts with none');
});

test('the filing step records an open follow-up with an id, today as told and nothing asked yet; old columns still fill in', async () => {
  const id = fresh();
  const m = await call(id, ['Priya is visiting this Saturday.'], { ...base, people: [{ name: 'Priya', relationship: 'granddaughter', birthday: '', stories: [] }], threads: [{ id: '', who: 'Priya', text: 'visiting on Saturday', due: '2026-10-31', kind: 'event', status: 'open', asked: 7, told: '1999-01-01' }], removed: [] });
  assert.equal(m.threads.length, 1);
  const t = m.threads[0];
  assert.match(t.id, /^t[0-9a-f]{6}$/); assert.equal(t.told, TODAY); assert.equal(t.asked, 0, 'asked is not Spark\'s to set'); assert.equal(t.status, 'open'); assert.equal(t.due, '2026-10-31');
  assert.equal(m.people[0].name, 'Priya', 'the old columns work as before');
  assert.match(seen[seen.length - 1].user, /"threads":\[\]/, 'Spark sees the current threads in the memory it is given');
});

test('the next call can close a thread by id; the closed thread keeps its told date and ask count; a repeat of it adds no duplicate', async () => {
  const id = fresh();
  let m = await call(id, ['Priya is visiting soon.'], { ...base, threads: [{ id: '', who: 'Priya', text: 'visiting on Saturday', due: '', kind: 'event', status: 'open' }] });
  const tid = m.threads[0].id;
  const p = memory.load(id); p.memory.threads[0].asked = 1;   // as step 3 will after offering it once
  m = await call(id, ['Priya came and we baked.'], { ...base, threads: [{ id: tid, status: 'closed' }] });
  assert.equal(m.threads.length, 1); assert.equal(m.threads[0].status, 'closed'); assert.equal(m.threads[0].asked, 1); assert.equal(m.threads[0].told, TODAY);
  m = await call(id, ['Chat.'], { ...base, threads: [{ who: 'Priya', text: 'visiting on Saturday', status: 'open' }] });
  assert.equal(m.threads.length, 1, 'no duplicate'); assert.equal(m.threads[0].status, 'closed', 'a closed thread does not reopen');
});

test('Spark leaving threads out, or returning nothing usable for them, never loses an open thread', async () => {
  const id = fresh();
  let m = await call(id, ['I worry about my test results.'], { ...base, threads: [{ id: '', who: 'Ann', text: 'worried about test results', due: '', kind: 'worry', status: 'open' }] });
  assert.equal(m.threads.length, 1);
  m = await call(id, ['The roses are finished.'], { ...base, topics: [{ text: 'garden', told: TODAY }] });   // no threads key at all
  assert.equal(m.threads.length, 1, 'kept when the key is missing');
  m = await call(id, ['Nothing.'], { ...base, threads: 'garbage' });
  assert.equal(m.threads.length, 1, 'kept when the value is garbage');
  assert.equal(m.threads[0].text, 'worried about test results');
});

test('a failed or unreadable filing keeps the words and the threads for the next try', async () => {
  const id = fresh();
  await call(id, ['Priya visits Saturday.'], { ...base, threads: [{ who: 'Priya', text: 'visit', due: '2026-10-31', kind: 'event', status: 'open' }] });
  const m = await call(id, ['More talk.'], 'not json at all');
  assert.equal(m.threads.length, 1, 'unreadable output changes nothing');
  assert.ok(fs.existsSync(path.join(process.env.MAYA_DATA_DIR, `${id}.pending.jsonl`)), 'the words stay for the next attempt');
});

test('the filing instructions describe threads as principles and facts: no quoted example line, no advice, ids kept', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'memory.js'), 'utf8');
  const instr = src.slice(src.indexOf('const EXTRACT_INSTRUCTIONS'), src.indexOf('function parseJson'));
  for (const must of [/threads = things still open/, /Existing threads carry an id/, /status closed/, /never advise/, /Never make a thread from ordinary chat/]) assert.match(instr, must);
  assert.match(instr, /"threads":\[\{"id"/);
});

test('threads stay private to Maya: no family-facing file reads them (server, care, ws, the family and senior pages); only her own notes do', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['server.js', 'care.js', 'ws.js', 'public/family.js', 'public/family.html', 'public/inbox.js', 'public/app.js', 'public/profiles.js']) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /\.threads\b|recall\./, `${f} does not touch threads`);
  const note = memory.profileNote(memory.load(fresh()), null);
  assert.doesNotMatch(note, /thread|follow-up/i, 'no focus (greeting, call-back, silence line): no follow-up in the note');
});

// ---------------------------------------------------------------- the per-reply note (Step 3)
const ago = (k) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); };
function seeded(extra = {}) {
  const id = fresh(); const p = memory.load(id);
  p.memory.people = [{ name: 'Priya', relationship: 'granddaughter', birthday: '', stories: [{ text: 'plays the violin at school', told: ago(8) }] }, { name: 'Ravi', relationship: 'son', birthday: '', stories: [] }];
  p.memory.preferences = [{ who: p.name, text: 'likes ginger tea', told: ago(20) }];
  p.memory.events = [{ who: 'Priya', text: 'visiting for the weekend', date: ago(2), told: ago(6) }];
  p.memory.current = [{ who: p.name, text: 'knee feels sore on the stairs', told: ago(1) }];
  p.memory.topics = [{ text: 'old steam trains', told: ago(30) }];
  Object.assign(p.memory, extra);
  return p;
}
const DUE = () => ({ id: 'tdue001', who: 'Priya', text: 'visiting for the weekend', due: ago(2), kind: 'event', status: 'open', asked: 0, told: ago(6) });

test('focused note: people, dates around now and only the items that relate to what was just said; the rest of the file is not shown', () => {
  const p = seeded();
  const note = memory.profileNote(p, null, { text: 'My violin lesson is tonight', full: false, thread: '' });
  assert.match(note, /People in their life: Priya \(granddaughter\), Ravi \(son\)/);
  assert.match(note, /plays the violin at school/, 'the related story is shown');
  assert.doesNotMatch(note, /ginger|steam trains|knee feels sore/, 'unrelated items are left out');
  assert.match(note, /other notes exist but are not shown now/);
  assert.match(note, /Dates around now, worked out for you: visiting for the weekend 2 days ago/);
  assert.doesNotMatch(note, /follow-up/i, 'no thread offered here');
  assert.match(memory.profileNote(p, null, { text: 'zzz nothing', full: false, thread: '' }), /None of your other notes relate/);
});

test('a request for an account or a story keeps the whole memory; with no focus the note is the full file as before', () => {
  const p = seeded();
  const full = memory.profileNote(p, null, { text: 'tell me about Priya', full: true, thread: '' });
  assert.match(full, /ginger tea/); assert.match(full, /steam trains/); assert.match(full, /What you remember \(only what they told you; nothing else is known\)/);
  assert.equal(memory.profileNote(p, null), memory.profileNote(p, null, null));
  assert.match(memory.profileNote(p, null), /ginger tea/);
  const empty = fresh(); assert.match(memory.profileNote(memory.load(empty), null, { text: 'hello', full: false, thread: '' }), /no memories of this person yet/);
});

test('the follow-up is a fact with its date worked out, and the instruction is a principle: ask once, own words, leave it if awkward', () => {
  const p = seeded();
  const fact = require('../recall').threadFact(DUE(), TODAY);
  const note = memory.profileNote(p, null, { text: 'Hello there', full: false, thread: fact });
  assert.match(note, /Open follow-up from an earlier call \(a fact for you, not words to say\): Priya: visiting for the weekend, was due .* \(2 days ago\); told/);
  assert.match(note, /ask about it once, simply, in your own words/); assert.match(note, /leave it\./);
  assert.doesNotMatch(note.slice(note.indexOf('Open follow-up')), /"[^"]+"/, 'no quoted sentence');
});

test('markAsked counts an offer and saves it; an unknown thread is ignored', () => {
  const p = seeded({ threads: [DUE()] });
  assert.equal(memory.markAsked(p.id, 'tdue001'), true); assert.equal(memory.load(p.id).memory.threads[0].asked, 1);
  assert.equal(memory.markAsked(p.id, 'nope'), false); assert.equal(memory.markAsked('deadbeef', 'tdue001'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.MAYA_DATA_DIR, `${p.id}.json`), 'utf8')).memory.threads[0].asked, 1, 'saved to the file');
});
