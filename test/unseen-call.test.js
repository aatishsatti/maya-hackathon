// A reminder the SENIOR set, sent in the app and not seen (Got it) within 4 minutes: Maya rings them ONCE instead (care.unseenCall) and the ring speaks the reminder (call.js reminderLine).
// Seen in time: nothing more. An unanswered ring is not repeated. Family-set reminders and reminders chosen as a call are not touched. No network: Spark and the voice are not used here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MAYA_CARE_SCALE = '0.01';   // rings and the 4 minutes shrink (care.cfg), so a real ring can be seen to end
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-unseen-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory'); const care = require('../care');
const U = care.cfg.unseenCallMs, wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const letters = (k) => String.fromCharCode(97 + (k % 26)) + String.fromCharCode(97 + Math.floor(k / 26));
const person = () => memory.createProfile(`Una${letters(n++)}`, 'female').id;
const openApp = (id) => { const ev = []; const res = { write: (s) => { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push([m[1], JSON.parse(m[2])]); return true; } }; const detach = care.attachSenior(id, res, null); return { ev, detach }; };
const rings = (app) => app.ev.filter(([k]) => k === 'incoming');
const setup = (extra = {}) => { const id = person(); const app = openApp(id); const t0 = Date.now(); const r = care.addSeniorReminder(id, { task: 'take my medicine', dueAt: t0 + 3000, repeat: 'none', deliver: 'text', channel: 'app', origin: 'app', ...extra }); return { id, app, fire: t0 + 5000, rid: r.id }; };
const rem = (id, rid) => care.get(id).reminders.find((x) => x.id === rid);
const done = (app) => { app.detach(); for (const x of care.outreaches.values()) clearTimeout(x.timer); care.outreaches.clear(); care.activeByProfile.clear(); };

test('the limit is 4 minutes (times the test scale)', () => { assert.equal(U, 4 * 60000 * 0.01); });

test('not seen in 4 minutes: the text is closed as "not seen" and Maya rings the app once, for THIS reminder; nothing before the 4 minutes', async () => {
  const { id, app, fire, rid } = setup();
  care.tick(fire); assert.equal(rem(id, rid).active.state, 'app_sent'); assert.ok(app.ev.some(([k]) => k === 'notice'), 'the text came first');
  care.tick(fire + U - 500); await wait(20); assert.equal(rings(app).length, 0, 'not before 4 minutes'); assert.equal(rem(id, rid).active.state, 'app_sent');
  care.tick(fire + U + 100); await wait(60);
  assert.equal(rings(app).length, 1, 'one ring'); const o = [...care.outreaches.values()].find((x) => x.profileId === id); assert.ok(o && o.kind === 'reminder' && o.reminderId === rid && o.single, 'a single ring for this reminder');
  assert.equal(rem(id, rid).last.state, 'app_unseen'); assert.match(care.view(id).reminders.find((x) => x.id === rid).last.label, /Not seen in the app within \d+ minutes, so Maya called/);
  assert.equal(rem(id, rid).active.escalated, 'app'); assert.equal(rem(id, rid).active.state, 'calling');
  done(app);
});

test('unanswered: the one ring ends, it is recorded as not reached, and it is NEVER rung again (no loop)', async () => {
  const { id, app, fire, rid } = setup();
  care.tick(fire); care.tick(fire + U + 100); await wait(60); assert.equal(rings(app).length, 1);
  await wait(care.cfg.ringMs + 200);   // nobody answers
  assert.equal(care.outreaches.size, 0, 'the ring is over'); assert.equal(rem(id, rid).active, null); assert.equal(rem(id, rid).last.state, 'unanswered'); assert.equal(rem(id, rid).last.escalated, 'app');
  assert.match(care.view(id).reminders.find((x) => x.id === rid).last.label, /Not seen in \d+ minutes, so Maya called: Couldn't reach senior/);
  for (let k = 1; k <= 20; k++) care.tick(fire + U + 100 + k * U); await wait(100);
  assert.equal(rings(app).length, 1, 'still the one ring: no second call, no loop'); assert.equal(rem(id, rid).dueAt, null);
  done(app);
});

test('Got it (seen) before 4 minutes: no call and no extra noise', async () => {
  const { id, app, fire, rid } = setup();
  care.tick(fire); const notice = app.ev.find(([k]) => k === 'notice')[1]; care.markNotif(id, notice.notifId, 'delivered'); care.markNotif(id, notice.notifId, 'seen');
  assert.equal(rem(id, rid).active.state, 'app_read'); care.tick(fire + U + 100); care.tick(fire + 10 * U); await wait(60);
  assert.equal(rings(app).length, 0); assert.equal(care.outreaches.size, 0); assert.ok(!rem(id, rid).last || rem(id, rid).last.state !== 'app_unseen'); done(app);
});

test('a family-set reminder is not escalated (family flow unchanged); neither is a reminder the senior chose as a call', async () => {
  const id = person(); const app = openApp(id); const t0 = Date.now();
  care.addReminder(id, { task: 'family one', dueAt: t0 + 3000, repeat: 'none', deliver: 'text', channel: 'app' });
  care.tick(t0 + 5000); care.tick(t0 + 5000 + 10 * U); await wait(60); assert.equal(rings(app).length, 0); assert.equal(care.get(id).reminders[0].active.callAt, undefined, 'no escalation timer on a family reminder');
  done(app);
  const b = setup({ deliver: 'call' }); care.tick(b.fire); await wait(60); const ringsNow = rings(b.app).length; assert.equal(rem(b.id, b.rid).active.callAt, undefined); assert.ok(ringsNow <= 1); done(b.app);
});

test('a call already going is not rung over: tried once, logged as not seen; quiet hours: no call either', async () => {
  const b = setup(); care.tick(b.fire); care.liveCalls.set(b.id, { deliverReminder() { return true; } });
  care.tick(b.fire + U + 100); await wait(40); assert.equal(rings(b.app).length, 0, 'already on a call'); assert.equal(rem(b.id, b.rid).active.unseen, 'busy');
  care.liveCalls.delete(b.id); care.tick(b.fire + 3 * U); await wait(40); assert.equal(rings(b.app).length, 0, 'tried once only'); done(b.app);
  // 21:59:58 in Kolkata the text goes out; 4 minutes later (past 22:00) it is quiet hours: Maya does not ring
  const d = new Date(); d.setUTCHours(16, 30, 0, 0); if (d.getTime() < Date.now() + 3600000) d.setUTCDate(d.getUTCDate() + 1); const base = d.getTime();
  const qid = person(); care.get(qid).tz = 'Asia/Kolkata'; const qa = openApp(qid); const qr = care.addSeniorReminder(qid, { task: 'late one', dueAt: base - 4000, repeat: 'none', deliver: 'text', channel: 'app', origin: 'app' });
  care.tick(base - 2000); assert.equal(rem(qid, qr.id).active.state, 'app_sent'); care.tick(base - 2000 + U + 100); await wait(40);
  assert.equal(rings(qa).length, 0); assert.equal(rem(qid, qr.id).active.unseen, 'quiet hours'); done(qa);
});
