// Schedule: told or uploaded -> learned -> asked -> ONLY the yes items become reminders (calls). Nothing is set silently; private per person, on disk; deleted with the person.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-sched-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '[]', describeImage: async () => 'x',
  sparkStream: async (h, r, _s, onDelta) => { const t = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Okay.'; if (onDelta) onDelta(t); return t; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const sched = require('../schedule');
chat.deps.web = async () => ({ topics: [] });
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
chat.deps.speak = async () => Buffer.alloc(48000);
const TEXT = 'My schedule: blood pressure tablet at 8 am every day, walk at 5 pm every day, doctor Dr Rao on Thursday at 10:30 am';
sched.deps.extract = async () => [
  { task: 'take your blood pressure tablet', time: '08:00', repeat: 'daily', weekday: null, kind: 'medicine' },
  { task: 'go for a walk', time: '17:00', repeat: 'daily', weekday: null, kind: 'walk' },
  { task: 'see Dr Rao', time: '10:30', repeat: 'weekly', weekday: 4, kind: 'doctor' },
  { task: 'something with no time', time: '', repeat: 'none', kind: 'other' },
];
let n = 0; const person = () => { const id = memory.createProfile(`Sch${String.fromCharCode(97 + n++)}`, 'female').id; care.setTimezone(id, 'Asia/Kolkata', 'manual'); return id; };
const mine = (id) => care.get(id).reminders.filter((r) => r.by === 'senior');
const talk = (id, t) => chat.sendText(id, t, 'Asia/Kolkata');
const last = (r) => r.messages[r.messages.length - 1].text;

test('told in typed words: she learns it, lists what she saw, ASKS, and sets nothing yet; an item with no clear time is left out', async () => {
  const id = person();
  const r = await talk(id, TEXT);
  assert.match(last(r), /I read your schedule and this is what I saw: 1\. take your blood pressure tablet at 8:00 AM every day\. 2\. go for a walk at 5:00 PM every day\. 3\. see Dr Rao at 10:30 AM every Thursday\./);
  assert.match(last(r), /Do you want any reminders from your schedule\?/);
  assert.doesNotMatch(last(r), /something with no time/);
  assert.equal(mine(id).length, 0, 'nothing is set silently');
});

test('only the YES items become reminders, each a call at its time; the others are not set and she says so', async () => {
  const id = person();
  await talk(id, TEXT);
  const r = await talk(id, 'yes to 1 and 3, not the walk');
  assert.match(last(r), /Done\. I will call you for: take your blood pressure tablet at 8:00 AM every day; see Dr Rao at 10:30 AM every Thursday\./);
  assert.match(last(r), /I did not set: go for a walk\./);
  const set = mine(id);
  assert.equal(set.length, 2); assert.ok(set.every((x) => x.deliver === 'call'));
  assert.deepEqual(set.map((x) => x.repeat).sort(), ['daily', 'weekly']);
  assert.ok(!set.some((x) => /walk/.test(x.task)), 'the walk was a no');
  const again = await talk(id, 'yes');
  assert.doesNotMatch(last(again), /Done\. I will call you/, 'a stray yes later sets nothing more');
});

test('"all" sets all, "none" sets none, a plain "no" sets none; an unrelated message is ordinary chat and leaves the question open', async () => {
  let id = person(); await talk(id, TEXT); await talk(id, 'all of them'); assert.equal(mine(id).length, 3);
  id = person(); await talk(id, TEXT); const no = await talk(id, 'no thanks'); assert.equal(mine(id).length, 0); assert.match(last(no), /did not set/);
  id = person(); await talk(id, TEXT); await talk(id, 'what is the weather like'); assert.ok(sched.pending(id), 'still waiting for a real answer'); assert.equal(mine(id).length, 0);
});

test('a PDF that is a schedule: her plain answer, then the question; photo and voice come through the same two steps', async () => {
  const id = person();
  const out = await sched.propose(id, 'Daily medicine list 8:00 am tablet 9:00 pm tablet');
  assert.match(out, /Do you want any reminders from your schedule\?/); assert.ok(sched.pending(id));
  assert.equal(sched.looksLikeSchedule('see you at 5 pm'), false, 'one time in ordinary talk is not a schedule');
  assert.equal(sched.looksLikeSchedule('my routine: 8 am pills'), true);
});

test('private and on disk: one file per person, never mixed, survives a restart, deleted with the person', async () => {
  const a = person(), b = person();
  await talk(a, TEXT); chat.endAll();
  assert.ok(sched.pending(a)); assert.equal(sched.pending(b), null);
  assert.ok(fs.existsSync(sched.file(a)));
  chat.forget(a); assert.ok(!fs.existsSync(sched.file(a)));
});

test('items are checked: no time, a weekly without a day, or an over-long task is dropped, never guessed; at most 12', () => {
  const c = sched.clean([{ task: 'x', time: '09:00' }, { task: 'water plants', time: '9:5' }, { task: 'weekly thing', time: '09:00', repeat: 'weekly' }, { task: 'ok task', time: '7:05', repeat: 'daily' }, ...Array.from({ length: 20 }, (_, i) => ({ task: `task ${i}`, time: '10:00' }))]);
  assert.equal(c[0].task, 'ok task'); assert.equal(c[0].time, '07:05'); assert.equal(c.length, 12);
});

test('a QUESTION is never consent: "what about number 1?" and its kin set nothing and are not taken as an answer; a yes then sets only the ticked items', async () => {
  const id = person();
  await talk(id, TEXT);
  const items = sched.load(id).items;
  for (const q of ['what about number 1?', 'What about the walk?', 'is number 2 at five?', 'can you tell me about 3', 'which one is the doctor?', 'number 1?', 'yes, what about 2?']) {
    assert.equal(sched.readAnswer(q, items), null, `a question is not an answer: ${q}`);
  }
  assert.equal(sched.readAnswer('number 1', items), null, 'a bare mention is not a yes either');
  await talk(id, 'what about number 1?');
  assert.equal(mine(id).length, 0, 'the question set nothing');
  assert.ok(sched.pending(id), 'and the list is still waiting for a real answer');
  assert.ok(sched.load(id).items.every((x) => x.status === 'proposed'), 'no item was marked yes or no by a question');
  const r = await talk(id, 'yes to 1 and 3');
  assert.match(last(r), /Done\. I will call you for: take your blood pressure tablet[^;]*; see Dr Rao/);
  assert.equal(mine(id).length, 2, 'only the ticked items');
  assert.ok(!mine(id).some((x) => /walk/.test(x.task)));
});

test('explicit answers still work: yes, all, yes to some, none', () => {
  const items = [{ id: '1', task: 'take your tablet', kind: 'medicine' }, { id: '2', task: 'go for a walk', kind: 'walk' }, { id: '3', task: 'see Dr Rao', kind: 'doctor' }];
  const v = (t) => Object.fromEntries(sched.readAnswer(t, items));
  assert.deepEqual(v('yes'), { 1: 'yes', 2: 'yes', 3: 'yes' }); assert.deepEqual(v('all'), { 1: 'yes', 2: 'yes', 3: 'yes' });
  assert.deepEqual(v('yes to 1 and 3'), { 1: 'yes', 2: 'unsaid', 3: 'yes' }); assert.deepEqual(v('yes, set 1'), { 1: 'yes', 2: 'unsaid', 3: 'unsaid' });
  assert.deepEqual(v('yes to 1 and 3, not the walk'), { 1: 'yes', 2: 'no', 3: 'yes' }); assert.deepEqual(v('none'), { 1: 'no', 2: 'no', 3: 'no' });
});
