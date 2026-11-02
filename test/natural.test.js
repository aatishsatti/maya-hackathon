// Natural goodbye (whole-turn), dashboard ownership (senior-set daily calls are view-only), and save confirmation from the persisted record. No network; Spark and push are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-natural-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on';
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}',
  sparkStream: async (_h, _r, _s, onDelta) => { const t = 'Okay.'; if (onDelta) onDelta(t); return t; },
} };
const memory = require('../memory');
const care = require('../care');
const smart = require('../smart');
const social = require('../social');
const setrem = require('../setrem');
const { Call, endIntent } = require('../call');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const TZ = 'America/New_York', NOW = setrem.zonedEpoch(2026, 11, 5, 10, 0, TZ);
const senior = (tz = TZ) => { const p = memory.createProfile(`Nat${letters(n++)}`, 'female'); if (tz) care.get(p.id).tz = tz; return p.id; };
const sess = (id) => ({ profile: memory.load(id), factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' });
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
const say = (s, text, at = NOW + 10) => social.step(s, text, ctx(), at);
const warm = (s) => { for (let i = 0; i < 4; i++) social.step(s, 'it is a lovely day', ctx(), NOW + i); };
const recs = (id) => care.get(id).reminders.filter((r) => r.social);
const calls = [];
test.after(() => { for (const c of calls) { try { c.end(); } catch { /* over */ } } care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

// ---------------------------------------------------------------- 1. natural goodbye
test('1 the whole finished turn decides: a clear completed goodbye ends; a goodbye plus a question, a quoted / negated / hypothetical / reported / joking one does not; unsure is its own answer; stop is immediate', () => {
  for (const t of ['I gotta go', 'I have to go now', 'talk later', 'bye', 'Okay, bye bye', 'Good night Maya', 'I gotta go, my daughter is here', 'Thanks Maya, talk to you later']) assert.equal(endIntent(t), 'bye', t);
  for (const t of ['I gotta go, but what time will you call?', 'I have to go. Can you call me tomorrow?', 'talk later, but first, how do I stop the alarm', 'he said bye', '"bye" is what the machine says', 'I don\'t have to go', 'if I have to go I will tell you', 'when I have to go I say bye', 'haha I gotta go, just kidding', 'what if I had to go', 'Hang up the washing, will you?', 'tell the kids bye']) assert.equal(endIntent(t), null, t);
  for (const t of ['I should probably go', 'maybe I should go', 'I think I need to go', 'I might go now, maybe']) assert.equal(endIntent(t), 'unclear', t);
  for (const t of ['stop', 'hang up', 'please hang up', 'Hang up now', 'end the call']) assert.equal(endIntent(t), 'stop', t);
  assert.equal(endIntent('stop talking about the weather'), null, 'a stop with other words is not the command');
});

const runTurn = async (id, text, setup = () => {}) => {
  const rec = { sent: [], closed: [] };
  const ws = { send: (d) => rec.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: (c) => rec.closed.push(c), onmessage: null, onclose: null };
  const call = new Call(ws, 'k'); clearInterval(call.endTimer); calls.push(call); call.profile = memory.load(id);
  const log = []; call.sayFixed = async (t, o) => { log.push(['say', o.bye]); }; call.hangUp = (o) => { log.push(['hangUp']); };
  call.careNotes = function () { this.factLabels = this.labels || []; return ''; };
  call.pending = [{ text, partial: '', completedAt: Date.now(), endedAt: Date.now() }]; call.attribute = (t) => [{ label: 'A', text: t.text }]; call.respond = Call.prototype.respond;
  setup(call);
  try { await Promise.race([call.respond(0), sleep(250)]); } catch { /* the rest of a normal reply needs Spark */ }
  return { call, log, rec };
};

test('1 on a voice call (web and app are the same path): a goodbye ends it with no further confirmation; goodbye + question is answered; unsure asks ONE question, once; a yes then ends it', async () => {
  const id = senior();
  for (const t of ['I gotta go', 'talk later', 'bye']) { const r = await runTurn(id, t); assert.deepEqual(r.log, [['say', true]], t); }
  let r = await runTurn(id, 'I gotta go, but what time will you call?'); assert.deepEqual(r.log, [], 'answered, not disconnected');
  r = await runTurn(id, 'he said bye'); assert.deepEqual(r.log, []);
  r = await runTurn(id, 'I should probably go'); assert.deepEqual(r.log, [], 'a question first, not a disconnect'); assert.equal(r.call.askedEnd, true); assert.equal(r.call.askedEndOnce, true);
  // the answer to that one question
  const r2 = await runTurn(id, 'yes', (c) => { c.askedEnd = true; c.askedEndOnce = true; }); assert.deepEqual(r2.log, [['say', true]], 'a plain yes ends it');
  const r3 = await runTurn(id, 'no I will stay a bit', (c) => { c.askedEnd = true; c.askedEndOnce = true; }); assert.deepEqual(r3.log, [], 'a no carries on');
  const r4 = await runTurn(id, 'maybe I should go', (c) => { c.askedEndOnce = true; }); assert.ok(!r4.call.askedEnd, 'ONE clarification only: not asked again');
  // an unanswered question of Maya's, a health topic or a scam topic does not keep them on the line
  const r5 = await runTurn(id, 'okay bye now', (c) => { c.history.push({ role: 'assistant', content: 'Did you take your pills today?' }); c.labels = ['scam-warn', 'smart-state', 'setrem-confirm']; }); assert.deepEqual(r5.log, [['say', true]]);
  // explicit stop / hang up: at once (the call is really hung up, nothing is said first)
  const r6 = await runTurn(id, 'hang up'); assert.deepEqual(r6.log, [['hangUp']]);
});

test('1 concrete danger while they leave: ONE brief safety instruction, then the call is closed after it; no interview', async () => {
  const id = senior();
  const r = await runTurn(id, 'I gotta go', (c) => { c.safety = true; });
  assert.equal(r.call.endAfterReply, true); assert.deepEqual(r.log, [['hangUp']], 'not the bare fixed goodbye: Spark gives the one instruction, and the call is closed after that reply');
  const src = read('call.js'); assert.match(src, /bye: Boolean\(this\.endAfterReply\)/); assert.match(src, /ONE brief safety instruction only/); assert.match(src, /Ask NO question/);
});

test('1 the call is ACTUALLY disconnected (socket closed, hangup sent), not only said farewell to', async () => {
  const id = senior(); const rec = { sent: [], closed: [] }; const ws = { send: (d) => rec.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: (c) => rec.closed.push(c), onmessage: null, onclose: null };
  const call = new Call(ws, 'k'); clearInterval(call.endTimer); calls.push(call); call.profile = memory.load(id);
  call.hangUp({ quiet: false }); await sleep(800);
  assert.deepEqual(rec.closed, [1000]); assert.ok(rec.sent.some((m) => m.type === 'hangup')); assert.equal(call.closed, true);
});

// ---------------------------------------------------------------- 2. ownership
const arrange = (id) => { care.socialSave(id, { offerId: `o${Math.random()}`, h: 15, mi: 0, start: '2026-11-06', tz: TZ }); return recs(id)[0]; };

test('2 senior-set daily calls are view-only for the family: the family cannot stop or change one (server side), the senior can, a family-set one still can be stopped by the family', () => {
  const id = senior(); const mine = arrange(id), theirs = care.addReminder(id, { task: 'Water the plants', dueAt: Date.now() + 3600000, repeat: 'daily' });
  assert.equal(mine.owner, 'senior'); assert.equal(theirs.owner, 'family');
  assert.throws(() => care.deleteReminder(id, mine.id, 'family'), (e) => e.status === 403 && /theirs to change/.test(e.message));
  assert.throws(() => care.updateReminder(id, mine.id, { task: 'x', dueAt: Date.now() + 3600000, repeat: 'daily' }, 'family'), (e) => e.status === 403);
  assert.equal(recs(id).length, 1, 'still there after both attempts'); assert.equal(care.get(id).reminders.length, 2);
  assert.equal(care.deleteReminder(id, theirs.id, 'family'), true, 'the family-set one: stopped'); assert.equal(care.get(id).reminders.length, 1, 'only THAT record went');
  // unknown ownership is view-only; legacy records are stamped once on load
  mine.owner = 'whatever'; assert.throws(() => care.deleteReminder(id, mine.id, 'family'), (e) => e.status === 403); delete mine.owner;
  assert.throws(() => care.deleteReminder(id, mine.id, 'family'), (e) => e.status === 403, 'no owner at all: view-only');
  mine.owner = 'senior';
  // the senior's own stop (chat or menu) works
  assert.equal(care.stopSeniorReminder(id, mine.id), true); assert.equal(recs(id).length, 0);
  assert.ok(care.get(id).smart.social.cancelledAt, 'remembered as cancelled');
});

test('2 the family page gets the facts and no controls: owner, "Set by senior", time + zone, next call, status; the routes pass the family as the actor; stale buttons fail because the server decides', () => {
  const id = senior(); const r = arrange(id); const v = care.view(id).reminders.find((x) => x.id === r.id);
  assert.equal(v.owner, 'senior'); assert.equal(v.seniorSet, true); assert.deepEqual([v.social.time, v.social.tz, v.social.status, v.social.setBy], ['15:00', TZ, 'Active', 'senior']); assert.equal(v.social.next, r.dueAt);
  r.social.revoked = { at: 1 }; assert.match(care.view(id).reminders.find((x) => x.id === r.id).social.status, /Stopped/); r.social.revoked = null;
  r.social.paused = 'timezone'; assert.match(care.view(id).reminders.find((x) => x.id === r.id).social.status, /Paused/); r.social.paused = null;
  const srv = read('server.js'); assert.match(srv, /care\.deleteReminder\(a, c, 'family'\)/); assert.match(srv, /care\.updateReminder\(a, c, body, 'family'\)/);
  const web = read('public', 'family.js'); assert.match(web, /const viewOnly = r\.owner !== 'family'/); assert.match(web, /Set by senior/); assert.match(web, /Only the senior can change it, by talking to Maya/);
  assert.doesNotMatch(web.slice(web.indexOf('const viewOnly'), web.indexOf("c.append(head);")), /viewOnly[^\n]*openEdit/);
  const dart = read('app', 'lib', 'family', 'tab_reminders.dart'); assert.match(dart, /onTap: r\.seniorSet \? null :/); assert.match(dart, /Set by senior/);
  assert.match(read('app', 'lib', 'models.dart'), /seniorSet: j\['owner'\] != 'family'/, 'unknown ownership is view-only');
});

test('2 Maya describes the real state: cancelled is cancelled (not "never saved"), nothing is nothing, the record is read back', () => {
  const id = senior(), s = sess(id);
  let r = social.step(s, 'What daily calls do I have?', ctx(), NOW); assert.equal(r[0], 'social-readback'); assert.match(r[1], /no daily call is saved/);
  arrange(id); r = social.step(s, 'What daily calls do I have?', ctx(), NOW); assert.match(r[1], /daily call at 3:00 pm \(America\/New_York\), status: Active, next call Fri 6 Nov at 3:00 pm/);
  r = social.step(s, 'cancel the daily calls', ctx(), NOW); assert.equal(r[0], 'social-cancel');
  r = social.step(s, 'what time do you call me?', ctx(), NOW); assert.match(r[1], /no daily call is arranged now\. One was cancelled on/); assert.match(r[1], /did not fail to save/);
});

// ---------------------------------------------------------------- 3. save confirmation
test('3 the confirmation question names daily, time, start date and the zone; "yes perfect" saves exactly once; "yes, but..." saves nothing and a later bare yes does not save the old offer', () => {
  const id = senior(), s = sess(id); warm(s);
  const q = say(s, 'tomorrow at 3 pm'); assert.equal(q[0], 'social-confirm'); for (const re of [/EVERY DAY/, /3:00 pm/, /Fri 6 Nov/, /America\/New_York/]) assert.match(q[1], re);
  const a = say(s, 'yes perfect'); assert.equal(a[0], 'social-saved'); assert.equal(recs(id).length, 1);
  assert.equal(say(s, 'yes perfect'), null, 'said again: nothing new'); assert.equal(recs(id).length, 1, 'exactly once');
  const id2 = senior(), s2 = sess(id2); warm(s2); say(s2, 'tomorrow at 3 pm');
  const c = say(s2, 'yes, but not on fridays'); assert.equal(c[0], 'social-condition'); assert.match(c[1], /NOTHING is saved/); assert.equal(recs(id2).length, 0);
  assert.notEqual(say(s2, 'yes')[0], 'social-saved', 'the old question no longer stands'); assert.equal(recs(id2).length, 0);
  const x = say(s2, 'make it 4 pm tomorrow'); assert.equal(x[0], 'social-confirm'); assert.match(x[1], /4:00 pm/); assert.equal(say(s2, 'yes')[0], 'social-saved'); assert.equal(recs(id2)[0].social.h, 16);
});

test('3 a time that has already passed today, or an unknown zone, is never guessed', () => {
  const id = senior(), s = sess(id); warm(s);
  const r = say(s, 'today at 9 am', NOW + 10); assert.equal(r[0], 'social-past'); assert.equal(recs(id).length, 0);
  const none = senior(null), s2 = sess(none); for (let i = 0; i < 6; i++) assert.equal(social.step(s2, 'lovely', ctx(), NOW + i), null, 'no zone: no offer');
  assert.equal(social.step(s2, 'call me every day please', ctx(), NOW), null, 'even when asked: the zone is not guessed');
});

test('3 the saved words come from the PERSISTED record (time + zone + date + controls)', () => {
  const id = senior(), s = sess(id); warm(s); say(s, 'tomorrow at 3 pm');
  const real = care.socialSave; care.socialSave = (i, o, now) => { real(i, o, now); const r = recs(i)[0]; r.social.h = 16; r.social.mi = 30; return care.socialOf(i); };   // the record differs from the proposal: the sentence follows the record
  let out; try { out = say(s, 'yes perfect'); } finally { care.socialSave = real; }
  assert.equal(out[0], 'social-saved'); assert.match(out[1], /4:30 pm America\/New_York, starting Fri 6 Nov/); assert.doesNotMatch(out[1], /3:00 pm/);
  assert.match(out[1], /skip one call, change the time, or cancel these daily calls/);
});

test('3 no record = no "noted" or "scheduled": blocked BEFORE it is spoken; a failed save says plainly it is not saved; a claim that got out is corrected next turn', () => {
  const id = senior(), s = sess(id); warm(s); say(s, 'tomorrow at 3:40 pm'); s.factLabels = ['social-confirm'];
  for (const bad of ['Got it, 3:40 noted.', "I've scheduled our daily call for 3:40.", 'Lovely, all set for 3:40 tomorrow.', "I'll call you at 3:40 tomorrow.", 'That is booked: a call every day.']) assert.equal(smart.breaks(bad, s), 'claim', bad);
  for (const ok of ['Shall I call you every day at 3:40 pm, starting tomorrow?', 'Nothing is scheduled yet.', 'It is not saved until you say yes.']) assert.equal(smart.breaks(ok, s), null, ok);
  const plain = sess(senior()); assert.equal(smart.breaks('Got it, 3:40 noted.', plain), 'claim', 'no record at all');
  const reminder = sess(senior()); reminder.factLabels = ['setrem-saved']; assert.equal(smart.breaks("I've set your reminder to call your daughter at 3:40.", reminder), null, 'an ordinary saved reminder is its own record');
  // failed save
  const real = care.socialSave; care.socialSave = () => { throw Object.assign(new Error('The store is not available.'), { status: 500 }); };
  let f; try { f = say(s, 'yes perfect'); } finally { care.socialSave = real; }
  assert.equal(f[0], 'social-failed'); assert.match(f[1], /NOT SAVED/); assert.match(f[1], /Do NOT say scheduled/); s.factLabels = ['social-failed']; assert.equal(smart.breaks('All set, I have scheduled it.', s), 'claim');
  // after it was spoken: the impression is corrected
  const id3 = senior(), s3 = sess(id3); smart.afterReply(s3, 'Got it, 3:40 noted.'); const c = social.step(s3, 'thank you', ctx(), Date.now()); assert.equal(c[0], 'social-correct'); assert.match(c[1], /NO daily call is saved/);
  assert.notEqual((social.step(s3, 'thank you', ctx(), Date.now()) || [])[0], 'social-correct', 'said once');
  // with a record, saying so is fine
  const id4 = senior(); arrange(id4); const s4 = sess(id4); s4.factLabels = ['social-readback']; assert.equal(smart.breaks('Your daily call is saved for 3:00 pm.', s4), null);
});
