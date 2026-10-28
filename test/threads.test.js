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

test('threads are private: nothing outside the memory file and the filing step reads them yet (no notes to Maya, no family dashboard)', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['call.js', 'chat.js', 'server.js', 'care.js', 'ws.js', 'public/family.js', 'public/app.js']) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /\.threads\b|recall\./, `${f} does not touch threads`);
  const note = memory.profileNote(memory.load(fresh()), null);
  assert.doesNotMatch(note, /thread|follow-up/i);
});
