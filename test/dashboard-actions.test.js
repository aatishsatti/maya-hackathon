// The family dashboard's own actions: edit a reminder (and stop it), and the schedule upload (read into items, then set ONLY the ticked ones).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-dact-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory');
const care = require('../care');
const sched = require('../schedule');
const chat = require('../chat');
let n = 0; const person = () => { const id = memory.createProfile(`Dact${String.fromCharCode(97 + n++)}`, 'female').id; care.setTimezone(id, 'Europe/London', 'manual'); return id; };
const soon = (h = 5) => Date.now() + h * 3600000;
const mine = (id) => care.get(id).reminders;

test('edit a reminder: the same checks as adding one; a past time, an empty task and an odd repeat are refused; it saves what changed', () => {
  const id = person(); const r = care.addReminder(id, { task: 'take tablets', dueAt: soon(), repeat: 'none', deliver: 'call' });
  const out = care.updateReminder(id, r.id, { task: 'take the blue tablets', dueAt: soon(8), repeat: 'daily', deliver: 'text', channel: 'app' });
  assert.deepEqual([out.task, out.repeat, out.deliver, out.channel], ['take the blue tablets', 'daily', 'text', 'app']);
  const cleared = care.updateReminder(id, r.id, { task: 'take the blue tablets', dueAt: soon(8), repeat: 'none', deliver: '', channel: '' });
  assert.equal(cleared.deliver, undefined); assert.equal(cleared.channel, undefined, 'a cleared pick means "use the setting"');
  assert.throws(() => care.updateReminder(id, r.id, { task: 'x', dueAt: Date.now() - 3600000, repeat: 'none' }), /has not passed/);
  assert.throws(() => care.updateReminder(id, r.id, { task: '  ', dueAt: soon(), repeat: 'none' }), /what Maya should remind/);
  assert.throws(() => care.updateReminder(id, r.id, { task: 'x', dueAt: soon(), repeat: 'hourly' }), /Repeat must be/);
  assert.throws(() => care.updateReminder(id, 'nope', { task: 'x', dueAt: soon(), repeat: 'none' }), /not there any more/);
  r.active = { state: 'calling' }; mine(id).find((x) => x.id === r.id).active = { state: 'calling' };
  assert.throws(() => care.updateReminder(id, r.id, { task: 'x', dueAt: soon(), repeat: 'none' }), /going out right now/);
  mine(id).find((x) => x.id === r.id).active = null;
  assert.equal(care.deleteReminder(id, r.id), true, 'stopping is the existing delete');
});

test('schedule upload: reading shows items and sets NOTHING; only the ticked ones become call reminders; the rest are reported as not set', async () => {
  sched.deps.extract = async () => [
    { task: 'take your blood pressure tablet', time: '08:00', repeat: 'daily', weekday: null, kind: 'medicine' },
    { task: 'go for a walk', time: '17:00', repeat: 'daily', weekday: null, kind: 'walk' },
    { task: 'see Dr Rao', time: '10:30', repeat: 'weekly', weekday: 4, kind: 'doctor' },
    { task: 'no time given', time: '', repeat: 'none' }];
  const id = person();
  const items = await sched.read(id, 'My schedule: tablet 8am daily, walk 5pm daily, Dr Rao Thursday 10:30');
  assert.equal(items.length, 3); assert.deepEqual(items.map((i) => i.when), ['8:00 AM every day', '5:00 PM every day', '10:30 AM every Thursday']);
  assert.equal(mine(id).filter((x) => x.by === 'senior').length, 0, 'reading sets nothing');
  const r = sched.setChosen(id, ['1', '3'], { tz: 'Europe/London' });
  assert.equal(r.set.length, 2); assert.deepEqual(r.skipped, ['go for a walk']); assert.equal(r.failed.length, 0);
  const set = mine(id).filter((x) => x.by === 'senior'); assert.equal(set.length, 2); assert.ok(set.every((x) => x.deliver === 'call' && x.channel === 'app'));
  assert.deepEqual(sched.setChosen(id, ['1', '3']).set, [], 'ticking the same ones again does not set them twice');
  assert.equal(sched.setChosen(id, []).set.length, 0, 'nothing ticked, nothing set');
  const other = person(); assert.deepEqual(sched.setChosen(other, ['1']), { set: [], failed: [], skipped: [] }, 'another person has no such schedule');
});

test('the upload routes are the family\'s: text, pdf, photo and voice each go through schedule.read; Set takes only the ticked ids; the words of a PDF, photo or voice note are read then dropped', async () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /b === 'schedule' && \(c === 'pdf' \|\| c === 'image' \|\| c === 'voice'\)/); assert.match(server, /b === 'schedule' && c === 'set'.*setChosen\(a, body\.ids/);
  assert.match(server, /const seniorRoute = \(b === 'events'[^)]*\)/); assert.doesNotMatch(server.match(/const seniorRoute = [^\n]*/)[0], /schedule|escalation|reminders/, 'these are not on the senior\'s open list');
  assert.match(server, /b === 'reminders' && c && !d\) return sendJson\(res, 200, \{ reminder: care\.updateReminder/);
  await assert.rejects(chat.scheduleText('pdf', Buffer.from('not a pdf')), /not a PDF/); await assert.rejects(chat.scheduleText('image', Buffer.from('nope')), /not a photo/);
  chat.deps.transcribe = async () => 'tablet at 8 am'; assert.equal(await chat.scheduleText('voice', Buffer.from('x')), 'tablet at 8 am');
});
test.after(() => care.stop());
