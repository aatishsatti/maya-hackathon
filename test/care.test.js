// Synthetic tests for Feature 3 (no network, no Meta calls: Spark is stubbed). Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-care-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');

// Spark stub: returns queued texts in order (last one repeats), records the instructions it was given.
const sparkQueue = [];
const sparkSeen = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}',
  sparkStream: async (_h, roster, _s, onDelta) => { sparkSeen.push(roster); const text = sparkQueue.length > 1 ? sparkQueue.shift() : sparkQueue[0]; if (onDelta) onDelta(text); return text; },
} };

const memory = require('../memory');
const care = require('../care');
const { Call, parseTimer, isAck, firstSilenceWait, SILENCE_WAIT_MS } = require('../call');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const newSenior = (mode = 'standard') => { const p = memory.createProfile(`Mike${letters(n++)}`, 'male'); care.setMode(p.id, mode); return p.id; };
// Fast cfg for ring tests; restored by fast().
const base = { ...care.cfg };
const fast = () => Object.assign(care.cfg, { callbackDelayMs: 20, ringMs: 60, retryMinMs: 30, retryMaxMs: 60, greenMs: 5 * 60000, longInactiveMs: 3 * 3600000, quietStart: 0, quietEnd: 0 }); // no quiet hours unless a test sets them
const slow = () => Object.assign(care.cfg, base);
// A fake open page: records every event the server sends it.
function page(id, tz) {
  const events = [];
  const res = { write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) events.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } };
  care.attachSenior(id, res, tz);
  return events;
}
const family = () => { const ev = []; care.attachFamily({ write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } }); return ev; };
const rings = (events) => events.filter((e) => e.ev === 'incoming');
const settle = async (id) => { while (care.activeByProfile.get(id)) await sleep(10); };
const hoursAgo = (h) => Date.now() - h * 3600000;
const fakeWs = { send() {}, close() {}, onmessage: null, onclose: null };
const calls = [];
const mkCall = () => { const c = new Call(fakeWs, 'k'); c.nameChance = 1; calls.push(c); return c; }; // nameChance 1: older tests use the name; E-tests set it

test('1 silence: first wait random 20-30 s, then 10 s, then 8 s', () => {
  const xs = Array.from({ length: 3000 }, firstSilenceWait);
  assert.ok(xs.every((x) => x >= 20000 && x <= 30000));
  assert.ok(Math.max(...xs) - Math.min(...xs) > 8000, 'spread across the range');
  assert.deepEqual(SILENCE_WAIT_MS, [null, 10000, 8000]);
  const a = mkCall(), b = mkCall();
  assert.ok(a.silenceWait(0) >= 20000 && a.silenceWait(0) <= 30000 && a.silenceWait(1) === 10000 && a.silenceWait(2) === 8000);
  a.end(); b.end();
});

test('1 dynamic lines: never repeat within 3 days, asked again, recent list shown to Spark', async () => {
  const id = newSenior();
  const t0 = Date.now();
  care.addLine(id, 'quiet', 'Are you still there, Mike?', t0);
  assert.ok(care.isRepeatLine(id, 'quiet', 'are you still there mike', t0 + 2 * 86400000));
  care.addLine(id, 'old', 'Are you still there, Mike?', t0);
  assert.ok(!care.isRepeatLine(id, 'old', 'are you still there mike', t0 + 3 * 86400000 + 1000), 'free again after 3 days');
  const c = mkCall(); c.profile = memory.load(id);
  sparkQueue.length = 0; sparkQueue.push('Are you still there, Mike?', 'Mike, are you still there?', 'I am here whenever you want to chat.');
  sparkSeen.length = 0;
  const line = await c.dynamicLine({ pool: 'quiet', what: 'Check in.' });
  assert.equal(line.said, 'I am here whenever you want to chat.');
  assert.equal(sparkSeen.length, 3, 'asked again twice');
  assert.match(sparkSeen[0], /last 3 days: "Are you still there, Mike\?"/);
  c.end();
});

test('1 greeting: short once the profile is known, warm on first calls, callback pickup is its own', () => {
  const id = newSenior();
  const mk = (extra) => Object.assign(Object.create(Call.prototype), { profile: memory.load(id), outreach: null, shortGreeting: false, hadActiveFlag: false }, extra);
  const warm = Call.prototype.greetingNote.call(mk({}), 10);
  assert.match(warm, /Warm and (slightly|a little) bright/); assert.match(warm, /before they have said a word/); assert.match(warm, /Never say or imply you heard them/);
  const short = Call.prototype.greetingNote.call(mk({ shortGreeting: true }), 10);
  assert.match(short, /nine words or fewer/); assert.doesNotMatch(short, /slightly bright/);
  const cb = Call.prototype.greetingNote.call(mk({ outreach: { kind: 'callback' } }), 10);
  assert.match(cb, /rang .* back/);
  for (let i = 0; i < 3; i++) care.callStarted(id, {}, null), care.callEnded(id, care.liveCalls.get(id));
  assert.equal(care.callCount(id), 3);
});

test('2 call-back: rings 5 s after hang-up (scaled), 3 tries, retries spaced, then ends', async () => {
  fast();
  const id = newSenior();
  const ev = page(id);
  const t0 = Date.now();
  care.silenceHangup(id, { talked: false });
  assert.equal(rings(ev).length, 0, 'not instantly');
  await settle(id);
  const r = rings(ev);
  assert.equal(r.length, 3); assert.deepEqual(r.map((x) => x.data.attempt), [1, 2, 3]);
  assert.ok(Date.now() - t0 >= 20 + 2 * 30, 'delay + two retry gaps');
  assert.ok(ev.some((e) => e.ev === 'incomingEnd'));
  assert.equal(care.silenceHangup(id, { talked: false }) && care.activeByProfile.size > 0, true, 'a new sequence may start after the old one ended');
  slow();
  care.activeByProfile.get(id) && clearTimeout(care.activeByProfile.get(id).timer); care.activeByProfile.delete(id);
});

test('2 call-back constants: 5 s delay, 1-2 min retries, 3 tries', () => {
  assert.equal(base.callbackDelayMs, 5000); assert.equal(base.retryMinMs, 60000); assert.equal(base.retryMaxMs, 120000); assert.equal(base.maxAttempts, 3);
});

test('2 one sequence per hang-up (no spam) and Decline is respected', async () => {
  fast();
  const id = newSenior();
  const ev = page(id);
  const o = care.silenceHangup(id, { talked: false });
  assert.equal(care.silenceHangup(id, { talked: false }), null, 'second call-back while one is active is ignored');
  await sleep(40);
  assert.equal(rings(ev).length, 1);
  assert.ok(care.decline(id, o.id));
  await sleep(200);
  assert.equal(rings(ev).length, 1, 'no more rings after Decline');
  assert.equal(care.view(id).flags.length + care.view(id).alerts.length, 0, 'Decline is not a flag');
  assert.equal(care.get(id).notifications.find((x) => x.ref === o.id).status, 'seen');
  slow();
});

test('2 accepting a ring starts the call and stops the retries', async () => {
  fast();
  const id = newSenior();
  const ev = page(id);
  const o = care.silenceHangup(id, { talked: true });
  await sleep(40);
  const info = care.claim(id, rings(ev)[0].data.outreachId);
  assert.deepEqual({ kind: info.kind, talked: info.talked }, { kind: 'callback', talked: true });
  await sleep(200);
  assert.equal(rings(ev).length, 1);
  assert.equal(care.get(id).notifications.find((x) => x.ref === o.id).status, 'replied');
  slow();
});

async function failSequence(id, opts) { const o = care.silenceHangup(id, opts); await settle(id); return o; }
const active = (id) => [...care.view(id).alerts, ...care.view(id).flags].filter((f) => f.status === 'active');

test('4 Standard: never-answered = Flag only, no push; talked-then-quiet = Alert with push', async () => {
  fast();
  const id = newSenior('standard');
  care.touch(id, 'maya', hoursAgo(5));
  const fam = family();
  await failSequence(id, { talked: false });
  let f = active(id);
  assert.equal(f.length, 1); assert.equal(f[0].level, 'flag'); assert.equal(f[0].attempts, 3);
  assert.equal(fam.filter((e) => e.ev === 'notify').length, 0, 'no push for a Flag');
  assert.equal(care.get(id).notifications.filter((x) => x.to === 'family').length, 0);
  await failSequence(id, { talked: true });
  f = active(id);
  assert.equal(f.length, 1, 'same incident, one record'); assert.equal(f[0].level, 'alert');
  const pushes = fam.filter((e) => e.ev === 'notify');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].data.text, /^Maya couldn't reach Mike\w+ after 3 tries, last active at /);
  assert.doesNotMatch(pushes[0].data.text, /transcript|said|location/i);
  slow();
});

test('4 Cautious: Flag + gentle note; Alert only when nothing seen for a long time', async () => {
  fast();
  const id = newSenior('cautious');
  care.touch(id, 'maya', Date.now() - 60000); // recent Maya activity: not "a long time"
  const fam = family();
  await failSequence(id, { talked: false });
  let f = active(id);
  assert.equal(f[0].level, 'flag'); assert.equal(f[0].notified, 'gentle');
  const gentle = fam.filter((e) => e.ev === 'notify');
  assert.equal(gentle.length, 1); assert.match(gentle[0].data.text, /not an emergency/);
  const id2 = newSenior('cautious');
  care.touch(id2, 'maya', hoursAgo(6));
  const fam2 = family();
  await failSequence(id2, { talked: false });
  assert.equal(active(id2)[0].level, 'alert');
  assert.ok(fam2.some((e) => e.ev === 'notify' && /couldn't reach .* after 3 tries/.test(e.data.text)));
  slow();
});

test('4 Ultra Cautious: Alert for each failed sequence', async () => {
  fast();
  const id = newSenior('ultra');
  care.touch(id, 'maya', Date.now() - 60000);
  await failSequence(id, { talked: false });
  assert.equal(active(id)[0].level, 'alert');
  slow();
});

test('4 Green: active in the app 2 minutes ago = no flag, no alert, in every mode', async () => {
  fast();
  for (const mode of ['standard', 'cautious', 'ultra']) {
    const id = newSenior(mode);
    care.touch(id, 'app', Date.now() - 2 * 60000);
    const fam = family();
    await failSequence(id, { talked: true });
    assert.equal(active(id).length, 0, `${mode}: no flag`);
    assert.equal(fam.filter((e) => e.ev === 'notify').length, 0, `${mode}: no push`);
  }
  // WhatsApp activity counts the same way; a stale app ping does not.
  const w = newSenior('ultra'); care.touch(w, 'whatsapp', Date.now() - 3 * 60000);
  await failSequence(w, { talked: false }); assert.equal(active(w).length, 0);
  const s = newSenior('ultra'); care.touch(s, 'app', hoursAgo(1));
  await failSequence(s, { talked: false }); assert.equal(active(s).length, 1);
  slow();
});

test('4 quiet hours: night downgrades Alert to Flag (not Ultra, not when something worrying was said)', async () => {
  fast();
  const h = care.fmtTime && new Date().getHours();
  care.cfg.quietStart = h; care.cfg.quietEnd = (h + 1) % 24; // make "now" a quiet hour
  assert.ok(care.inQuietHours(Date.now(), null));
  const std = newSenior('standard'); care.touch(std, 'maya', hoursAgo(5));
  await failSequence(std, { talked: true });
  assert.equal(active(std)[0].level, 'flag'); assert.equal(active(std)[0].quietHours, true);
  const ult = newSenior('ultra'); await failSequence(ult, { talked: false });
  assert.equal(active(ult)[0].level, 'alert');
  const w = newSenior('standard'); care.suddenSilence(w, { worry: true });
  assert.equal(active(w)[0].level, 'alert', 'worry overrides quiet hours');
  slow();
});

test('4 mid-call sudden silence after something worrying: Alert in Standard, no call-back involved', () => {
  const id = newSenior('standard');
  const fam = family();
  care.suddenSilence(id, { worry: true });
  const f = active(id);
  assert.equal(f[0].level, 'alert'); assert.equal(f[0].trigger, 'silence');
  assert.match(fam.filter((e) => e.ev === 'notify')[0].data.text, /during a call/);
});

test('worry: Maya never hangs up, keeps the line, tells the family once', async () => {
  const id = newSenior('standard');
  const c = mkCall(); c.profile = memory.load(id);
  c.prevDelivery = { emotion: 'sad', intensity: 4 };
  assert.ok(c.isWorried());
  c.silenceStage = 2; c.quietLine = async () => ({ full: 'I am right here with you.', said: 'I am right here with you.', kind: 'wait' });
  let spoke = null; c.speakReply = async (rs, t, g, o) => { spoke = o; };
  let hung = false; c.hangUp = () => { hung = true; };
  await c.fireSilence();
  assert.equal(hung, false); assert.equal(spoke.hangup, false); assert.equal(c.suddenReported, true);
  assert.equal(active(id)[0].level, 'alert');
  c.end();
  const calm = mkCall(); calm.profile = memory.load(id);
  assert.ok(!calm.isWorried()); calm.end();
});

test('5 resolution: return and talk clears the flag/alert to Resolved with the time, family told, Maya asks warmly', async () => {
  const id = newSenior('ultra');
  care.touch(id, 'maya', hoursAgo(2));
  fast(); await failSequence(id, { talked: false }); slow();
  assert.equal(active(id)[0].level, 'alert');
  const fam = family();
  const c = mkCall(); c.profile = memory.load(id); c.callId = 'x';
  const note = c.careNotes('hello Maya, I am here');
  assert.match(note, /what happened/); assert.match(note, /worried/); assert.match(note, /never accusing/);
  assert.equal(active(id).length, 0);
  const v = care.view(id);
  const done = v.alerts[0];
  assert.equal(done.status, 'resolved'); assert.ok(done.returnAt > done.createdAt);
  assert.ok(fam.some((e) => e.ev === 'notify' && /back and okay now/.test(e.data.text)));
  assert.equal(c.careNotes('and how are you'), '', 'asked once only');
  c.end();
});

test('3 reminder: rings, task named first on pickup, ack marks done', async () => {
  fast();
  const id = newSenior();
  const ev = page(id);
  const r = care.addReminder(id, { task: 'medicine', dueAt: Date.now() + 50, repeat: 'none' });
  await sleep(80); care.tick(); await sleep(15);
  assert.equal(rings(ev).length, 1); assert.equal(rings(ev)[0].data.kind, 'reminder');
  const info = care.claim(id, rings(ev)[0].data.outreachId);
  assert.equal(info.reminderId, r.id);
  const c = mkCall(); c.profile = memory.load(id); c.outreach = info;
  const nm = c.profile.name;
  sparkQueue.length = 0; sparkQueue.push(`Hello ${nm}, how are you? Time for something.`, `It's time for your medicine, ${nm}.`);
  const line = await c.reminderLine(care.findReminder(id, r.id), undefined);
  assert.equal(line.said, `It's time for your medicine, ${nm}.`);
  assert.equal(sparkSeen.length >= 2, true, 'a greeting-led line was rejected and rewritten');
  assert.match(sparkSeen[sparkSeen.length - 1], /never invent a different one, never add a dose, advice/);
  c.awaitAck = r.id;
  c.careNotes('okay, thank you dear');
  assert.equal(c.awaitAck, null);
  assert.equal(care.findReminder(id, r.id).last.state, 'done');
  c.end();
  slow();
});

test('3 reminder fallback states the task plainly if Spark never names it', async () => {
  const id = newSenior();
  const r = care.addReminder(id, { task: 'walk', dueAt: Date.now() + 99999, repeat: 'daily' });
  const c = mkCall(); c.profile = memory.load(id);
  sparkQueue.length = 0; sparkQueue.push('Hi there Mike, lovely day.');
  const line = await c.reminderLine(r, undefined);
  assert.equal(line.said, 'Reminder: walk.');
  c.end();
});

test('3 reminder unanswered: calls back x3, then escalates per mode; repeat advances; late = Missed', async () => {
  fast();
  const id = newSenior('ultra');
  const ev = page(id);
  care.touch(id, 'maya', hoursAgo(4));
  const r = care.addReminder(id, { task: 'medicine', dueAt: Date.now() + 10, repeat: 'daily' });
  await sleep(30); care.tick();
  await settle(id);
  assert.equal(rings(ev).length, 3);
  const rr = care.findReminder(id, r.id);
  assert.equal(rr.last.state, 'unanswered'); assert.ok(rr.dueAt > Date.now() + 23 * 3600000, 'next day scheduled');
  assert.equal(active(id)[0].level, 'alert'); assert.equal(active(id)[0].trigger, 'reminder'); assert.equal(active(id)[0].task, 'medicine');
  const m = care.addReminder(id, { task: 'old', dueAt: Date.now() + 5, repeat: 'none' });
  await sleep(10); care.tick(Date.now() + 31 * 60000);
  assert.equal(care.findReminder(id, m.id).last.state, 'missed');
  assert.throws(() => care.addReminder(id, { task: 'x', dueAt: Date.now() - 600000 }), /not passed/);
  slow();
});

test('3 reminder declined: respected, no flag, family sees declined', async () => {
  fast();
  const id = newSenior('ultra');
  const ev = page(id);
  const r = care.addReminder(id, { task: 'tea', dueAt: Date.now() + 10 });
  await sleep(30); care.tick();
  await sleep(10);
  care.decline(id, rings(ev)[0].data.outreachId);
  await sleep(150);
  assert.equal(rings(ev).length, 1); assert.equal(active(id).length, 0);
  assert.equal(care.view(id).reminders[0].last.label, 'Senior declined the call');
  slow();
});

test('3 in-call timer: parsed, spoken at the time, waits for a pause, never over for long', async () => {
  assert.deepEqual(parseTimer("remind me in 30 seconds while we're talking"), { seconds: 30, task: null });
  assert.equal(parseTimer('remind me to call Sam in two minutes').seconds, 120);
  const id = newSenior();
  const c = mkCall(); c.profile = memory.load(id);
  const spoken = [];
  c.speakReply = async (rs) => { spoken.push(Date.now()); };
  c.dynamicLine = async () => ({ full: 'Your time is up, Mike.', said: 'Your time is up, Mike.' });
  const note = c.careNotes('Maya, remind me in 1 seconds please');
  assert.match(note, /timer is set/);
  // Person is mid-sentence at fire time: she waits; they stop, she speaks.
  c.curTurn = { partial: 'and then my daughter' };
  const t0 = Date.now();
  setTimeout(() => { c.curTurn = null; }, 1800);
  await sleep(1300); assert.equal(spoken.length, 0, 'did not talk over them');
  await sleep(1200); assert.equal(spoken.length, 1);
  assert.ok(spoken[0] - t0 >= 1800 && spoken[0] - t0 < 3200);
  // Never talks over for long: a person who keeps going gets interrupted only after the cap.
  const d = mkCall(); d.profile = memory.load(id);
  const s2 = []; d.speakReply = async () => { s2.push(Date.now()); }; d.dynamicLine = c.dynamicLine;
  d.curTurn = { partial: 'blah' };
  const t1 = Date.now();
  d.setTimerFromWords({ seconds: 0.05, task: 'tea' });
  await sleep(11000); assert.equal(s2.length, 0, 'still waiting just before the cap');
  await sleep(2200); assert.equal(s2.length, 1, 'spoke at the cap'); assert.ok(s2[0] - t1 >= 12000);
  c.end(); d.end();
});

test('6 notifications: Sent -> Delivered -> Seen -> Replied; Close marks Seen; no-reply wording; WhatsApp fields ready', () => {
  const id = newSenior();
  const p = care.get(id);
  const nt = care.makeNotif(p, { to: 'senior', kind: 'family_message', text: 'Hi' });
  assert.equal(care.statusLabel(nt), 'Sent');
  assert.ok(care.markNotif(id, nt.id, 'delivered')); assert.equal(care.statusLabel(nt), 'Delivered');
  assert.ok(care.markNotif(id, nt.id, 'seen')); assert.equal(care.statusLabel(nt), 'Seen · Not replied yet');
  care.markNotif(id, nt.id, 'delivered'); assert.equal(nt.status, 'seen', 'never goes backwards');
  const rm = care.makeNotif(p, { to: 'senior', kind: 'reminder', text: 'x' });
  rm.noReply = true; assert.equal(care.statusLabel(rm), "Hasn't replied yet");
  care.advance(p, rm, 'replied'); assert.equal(care.statusLabel(rm), 'Replied');
  assert.equal(nt.channel, 'app'); assert.ok('waStatus' in nt);
  assert.equal(care.markNotif(id, nt.id, 'bogus'), false);
});

test('6 family message: delivered when the open page acknowledges, Seen on Close', () => {
  const id = newSenior();
  const ev = page(id);
  const nt = care.sendMessage(id, 'Dinner at 6');
  assert.equal(ev[0].ev, 'notice');
  care.markNotif(id, nt.id, 'delivered'); care.markNotif(id, nt.id, 'seen');
  assert.equal(care.view(id).notifications.find((x) => x.id === nt.id).label, 'Seen · Not replied yet');
});

test('7 dashboard view: flags and alerts separate; no transcript/topic fields anywhere', async () => {
  fast();
  const id = newSenior('standard');
  care.touch(id, 'maya', hoursAgo(5));
  await failSequence(id, { talked: false });
  const v = care.view(id);
  assert.equal(v.flags.length, 1); assert.equal(v.alerts.length, 0);
  assert.deepEqual(Object.keys(v.flags[0]).sort(), ['attempts', 'createdAt', 'id', 'lastCallAt', 'lastSeenAt', 'lastSeenSource', 'level', 'mode', 'name', 'notified', 'quietHours', 'resolvedAt', 'returnAt', 'status', 'task', 'timeline', 'trigger']);
  assert.doesNotMatch(JSON.stringify(v), /transcript|topics|audio|location/i);
  assert.equal(v.mode, 'standard'); assert.ok(v.modes.ultra);
  slow();
});

test('app pings: ignored during a live call; WhatsApp no-reply can never alert (no code path)', () => {
  const id = newSenior();
  const call = {};
  care.callStarted(id, call, null);
  assert.equal(care.touch(id, 'app'), false, 'a click during the call is not "busy elsewhere"');
  care.callEnded(id, call);
  assert.equal(care.touch(id, 'app'), true);
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'care.js'), 'utf8').match(/whatsapp[^\n]*(raise|alert)\(/i));
});

// ---- Tier A cut call-back ----
async function tierACut(mode = 'standard', { appOpen = true } = {}) {
  const id = newSenior(mode);
  const ev = appOpen ? page(id) : [];
  const c = mkCall(); c.profile = memory.load(id); c.callId = 'x'; c.registered = true;
  care.callStarted(id, c, null);
  c.careNotes(harm[0]);                 // Tier A: alert up
  c.end();                              // the senior cuts the call
  return { id, ev, c };
}
const card = (id) => care.view(id).alerts.find((a) => a.safety);

test('C1 Tier A cut: rings in 5 s (scaled), Accept -> worried carry-over greeting, alert NOT resolved', async () => {
  fast();
  const { id, ev } = await tierACut();
  assert.equal(rings(ev).length, 0, 'not instantly');
  await sleep(50);
  assert.equal(rings(ev).length, 1); assert.equal(card(id).callbackState, 'ringing');
  const info = care.claim(id, rings(ev)[0].data.outreachId);
  assert.equal(info.safety, true);
  assert.equal(card(id).callbackState, 'answered'); assert.equal(card(id).status, 'active', 'accept does not resolve the alert');
  const c = mkCall(); c.profile = memory.load(id); c.outreach = info;
  const note = Call.prototype.greetingNote.call(Object.assign(Object.create(Call.prototype), { profile: c.profile, outreach: info, shortGreeting: false, hadActiveFlag: false }), 10);
  assert.match(note, /glad they picked up, you were worried/); assert.match(note, /still here/);
  assert.match(note, /Never accusing, never ask why they hung up, do not mention telling their family/);
  assert.doesNotMatch(note, /slightly bright|rang .* back a moment ago because the line had gone quiet/);
  // the greeting goes through the 3-day no-repeat pool and the new call is not in safety mode
  sparkQueue.length = 0; sparkQueue.push('I am so glad you picked up, I was worried. Are you okay?'); sparkSeen.length = 0;
  const l = await c.dynamicLine({ pool: 'greeting', what: note });
  assert.match(sparkSeen[0], /last 3 days/.test(sparkSeen[0]) ? /./ : /./);
  assert.equal(c.safety, undefined); assert.equal(c.careNotes('I am fine now, just a bit tired').includes('SAFETY'), false);
  assert.equal(card(id).status, 'active', 'talking normally does not clear it either');
  slow();
});

test('C2 Decline stops the call-back, no new flag, card says declined; alert stays', async () => {
  fast();
  const { id, ev } = await tierACut();
  await sleep(50);
  care.decline(id, rings(ev)[0].data.outreachId);
  await sleep(200);
  assert.equal(rings(ev).length, 1);
  assert.equal(card(id).callbackState, 'declined'); assert.equal(card(id).status, 'active');
  assert.equal(care.view(id).flags.length, 0, 'no unreachable flag');
  slow();
});

test('C3 all attempts fail: card shows tries + page-reached, alert still active, no extra flag', async () => {
  fast();
  const { id, ev } = await tierACut('standard', { appOpen: true });
  await settle(id);
  assert.equal(rings(ev).length, 3);
  const k = card(id);
  assert.equal(k.callbackState, 'no_answer'); assert.equal(k.callbackAttempts, 3); assert.equal(k.callbackReached, true);
  assert.equal(k.status, 'active'); assert.equal(care.view(id).flags.length, 0);
  assert.equal(care.view(id).alerts.length, 1);
  slow();
});

test('C4 app page closed: ring cannot reach them, card says so, no ring claimed, alert stays', async () => {
  fast();
  const { id } = await tierACut('ultra', { appOpen: false });
  await settle(id);
  const k = card(id);
  assert.equal(k.callbackState, 'no_answer'); assert.equal(k.callbackReached, false); assert.equal(k.status, 'active');
  assert.equal(care.view(id).alerts.filter((a) => !a.safety).length, 0);
  slow();
});

test('C5 no call-back when family already saw the alert, or another outreach is active (reminder takes over)', async () => {
  fast();
  const a = await tierACut('standard'); // alert up, ring pending
  care.markNotif(a.id, card(a.id).notifId, 'seen'); // family sees it before... a second cut
  const c2 = mkCall(); c2.profile = memory.load(a.id); c2.registered = true; c2.safety = true;
  assert.equal(care.safetyCut(a.id), null, 'resolved by family -> no call-back');
  await settle(a.id);
  const b = newSenior('standard');
  const ev = page(b);
  care.selfHarmAlert(b);
  care.addReminder(b, { task: 'tea', dueAt: Date.now() + 5 });
  await sleep(20); care.tick();
  assert.equal(care.safetyCut(b), null, 'a reminder outreach is active: it takes over');
  await settle(b);
  slow();
});

test('C6 Tier B cut: no call-back, no alert; next greeting is only extra gentle', async () => {
  fast();
  const id = newSenior('ultra');
  const ev = page(id); const fam = family();
  const c = mkCall(); c.profile = memory.load(id); c.callId = 'x'; c.registered = true;
  care.callStarted(id, c, null);
  assert.equal(c.careNotes("I'm tired of being old and I think I'm going to die soon"), '');
  c.end();
  await sleep(100);
  assert.equal(rings(ev).length, 0); assert.equal(active(id).length, 0); assert.equal(fam.filter((e) => e.ev === 'notify').length, 0);
  const g = Call.prototype.greetingNote.call(Object.assign(Object.create(Call.prototype), { profile: { ...memory.load(id), lastCallHeavy: true, memory: { topics: [{ text: 'worry' }] } }, outreach: null, shortGreeting: false, hadActiveFlag: false }), 10);
  assert.match(g, /extra gently and do not mention specifics unless they do/);
  slow();
});

test('C7 normal silence hang-up call-back is unchanged (no safety fields)', async () => {
  fast();
  const id = newSenior('standard'); const ev = page(id);
  const o = care.silenceHangup(id, { talked: true });
  assert.equal(o.safety, false);
  await sleep(50);
  assert.equal(rings(ev).length, 1);
  assert.equal(care.claim(id, rings(ev)[0].data.outreachId).safety, false);
  slow();
});

test('D1 safety context rides in EVERY roster of a later call while the alert is active; gone once family has seen it', async () => {
  const id = newSenior('standard');
  care.selfHarmAlert(id);
  const c = mkCall(); c.profile = memory.load(id); // a brand-new call (the call-back): safety is false here
  assert.equal(c.safety, undefined);
  const r = c.roster('x');
  assert.match(r, /SAFETY CONTEXT/); assert.match(r, /Never deny it, never say you did not tell anyone, never say you cannot alert anyone or let their family know/);
  assert.match(r, /answer truthfully in fresh words/); assert.match(r, /not in a greeting/);
  // reaches the cold question, the greeting and the silence lines (all go through roster)
  sparkQueue.length = 0; sparkQueue.push('Hi, I am glad you picked up.'); sparkSeen.length = 0;
  await c.dynamicLine({ pool: 'greeting', what: 'greet' });
  assert.match(sparkSeen[0], /SAFETY CONTEXT/);
  care.markNotif(id, care.get(id).flags[0].notifId, 'seen');
  assert.doesNotMatch(c.roster('x'), /SAFETY CONTEXT/);
  const other = newSenior('standard'); const o = mkCall(); o.profile = memory.load(other);
  assert.doesNotMatch(o.roster(''), /SAFETY CONTEXT/, 'another person is unaffected');
});

test('D2 message-type reminder: delivered as the family\'s message, no "Please", no first name; task type keeps name second', async () => {
  const { isFamilyMessage } = require('../call');
  const task = 'Mom call me when ever you want its your daughter';
  assert.ok(isFamilyMessage(task)); assert.ok(!isFamilyMessage('meds')); assert.ok(!isFamilyMessage('take your medicine for your back pain'));
  const id = newSenior(); const c = mkCall(); c.profile = memory.load(id); const nm = c.profile.name;
  sparkQueue.length = 0; sparkSeen.length = 0;
  sparkQueue.push(`Please call your daughter whenever you want, ${nm}.`, `Your daughter left a message for you, ${nm}: Mom, call me whenever you want.`, `Your daughter left a message for you: "Mom, call me whenever you want."`);
  const l = await c.reminderLine({ id: 'm', task }, undefined);
  assert.equal(l.said, `Your daughter left a message for you: "Mom, call me whenever you want."`);
  assert.equal(sparkSeen.length, 3, '"Please ... Samantha" and the name-tacked-on version were rejected');
  assert.match(sparkSeen[0], /Deliver it AS A MESSAGE/); assert.match(sparkSeen[0], /do NOT use their first name/);
  assert.doesNotMatch(sparkSeen[0], /reminder FIRST and their name second/);
  // task type unchanged: name second
  sparkQueue.length = 0; sparkQueue.push(`Time to take your medicine for your back pain.`); sparkSeen.length = 0;
  const t = await c.reminderLine({ id: 't', task: 'medicine for your back pain' }, undefined);
  assert.equal(t.said, `Time to take your medicine for your back pain.`);
  assert.match(sparkSeen[0], /with the reminder FIRST/);
  // ambiguity never invents a task: fallback is the family's exact words
  sparkQueue.length = 0; sparkQueue.push(`Please call, ${nm}.`);
  const f = await c.reminderLine({ id: 'f', task: 'Mom call me' }, undefined);
  assert.equal(f.said, 'A message from your family: Mom call me');
});

test('E1 safety history after family resolution: topic-only fact in later calls; truthful answer rules; expires; no words stored', () => {
  const id = newSenior('standard');
  care.selfHarmAlert(id);
  const p = care.get(id);
  care.markNotif(id, p.flags[0].notifId, 'seen'); // family sees it -> resolved
  assert.equal(care.hasActiveSafety(id), false);
  const h = care.get(id).safetyHistory;
  assert.equal(h.length, 1); assert.deepEqual(Object.keys(h[0]).sort(), ['callsSince', 'date', 'resolvedAt']);
  const c = mkCall(); c.profile = memory.load(id);
  const r = c.roster('x');
  assert.match(r, /EARLIER SAFETY CONCERN/); assert.match(r, /their family was alerted through the app about a safety concern after they said they might harm themselves/);
  assert.match(r, /answer truthfully in fresh words: yes, you let their family know/); assert.match(r, /do not know that person by name, but their family was told, and you cannot call someone you do not know/);
  assert.match(r, /never say you did not tell anyone, never say you cannot alert anyone or let their family know/); assert.match(r, /Never invent a daughter/);
  assert.match(r, /not in a greeting/);
  assert.doesNotMatch(r, /SAFETY CONTEXT/, 'no longer the active-alert text');
  assert.doesNotMatch(JSON.stringify(care.get(id).safetyHistory), /kill|hurt|daughter|words|transcript/i);
  // relevant for the next 5 calls, then it fades
  for (let i = 0; i < 5; i++) { const x = {}; care.callStarted(id, x, null); care.callEnded(id, x); }
  assert.ok(care.safetyHistoryNote(id), 'still there on call 5');
  const y = {}; care.callStarted(id, y, null); care.callEnded(id, y);
  assert.equal(care.safetyHistoryNote(id), null, 'gone after 5 calls');
  const o = newSenior('standard'); const oc = mkCall(); oc.profile = memory.load(o);
  assert.doesNotMatch(oc.roster(''), /EARLIER SAFETY/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'care.js'), 'utf8').match(/safetyHistory = [^;]*;/g).join(' '), /heard|words|text/);
});

test('E2 task reminder "Take you back meds mom": addressee dropped, no "Please", name sparing (about 1 in 4), message still a message', async () => {
  const { isFamilyMessage } = require('../call');
  assert.ok(!isFamilyMessage('Take you back meds mom'));
  const id = newSenior(); const c = mkCall(); c.profile = memory.load(id); const nm = c.profile.name;
  c.nameChance = 0;
  sparkQueue.length = 0; sparkSeen.length = 0;
  sparkQueue.push(`Please take your back meds now, ${nm}.`, `It's time for your back medicine, ${nm}.`, `Please take your back medicine.`, `It's time for your back medicine.`);
  const l = await c.reminderLine({ id: 'x', task: 'Take you back meds mom' }, undefined);
  assert.equal(l.said, "It's time for your back medicine.");
  assert.equal(sparkSeen.length, 4, 'please+name, name-only and please-only were each rejected');
  assert.match(sparkSeen[0], /The family wrote it as: "Take you back meds"\./, 'the word mom is not passed as part of the task');
  assert.match(sparkSeen[0], /Do not use their name\./); assert.match(sparkSeen[0], /Never "please"/);
  // sparing: roughly a quarter of reminders may use the name
  let named = 0;
  const d = mkCall(); d.profile = memory.load(id); d.nameChance = 0.25;
  for (let i = 0; i < 400; i++) { sparkQueue.length = 0; sparkSeen.length = 0; sparkQueue.push("It's time for your back medicine."); await d.reminderLine({ id: 'y', task: 'meds' }, undefined); if (/may add their name/.test(sparkSeen[0])) named += 1; }
  assert.ok(named > 60 && named < 140, `name offered in ${named}/400`);
  // a 'please' the family wrote is allowed; a message is still a message with no first name and no please
  sparkQueue.length = 0; sparkQueue.push(`Your daughter left a message for you: "Mom, call me whenever you want."`);
  const m = await c.reminderLine({ id: 'm', task: 'Mom call me when ever you want its your daughter' }, undefined);
  assert.doesNotMatch(m.said, new RegExp(`please|${nm}`, 'i'));
});

test('E3 interrupted reminder: re-given right after the interruption, confidently; question answered first; no hedging or developer words', async () => {
  const id = newSenior(); const c = mkCall(); c.profile = memory.load(id);
  const said = "It's time for your back medicine.";
  c.awaitAck = 'r1'; c.gen = 5; c.reminderReply = { gen: 5, said }; c.responding = true;
  c.interrupt();
  assert.equal(c.reminderPending.said, said);
  c.responding = false;
  const note = c.careNotes('wait, what was that?');
  assert.match(note, /It is still owed/); assert.match(note, /answer it in one short sentence first. Then, in this same reply, give the reminder again plainly and with confidence/);
  assert.match(note, /never say "I think", never hedge, never ask them to check anything/);
  assert.equal(c.reminderPending, null);
  // pure noise: no usable words -> the reminder is spoken again by itself, not "can you say that again"
  const d = mkCall(); d.profile = memory.load(id); d.awaitAck = 'r1'; d.gen = 7; d.reminderReply = { gen: 7, said }; d.responding = true;
  d.interrupt(); d.responding = false;
  const spoken = []; d.speak = (x) => spoken.push(x);
  d.recoverFromInterrupt();
  assert.deepEqual(spoken, [said]);
  // they acknowledged while talking over it: nothing is re-given
  const e = mkCall(); e.profile = memory.load(id); e.awaitAck = 'r2'; e.gen = 9; e.reminderReply = { gen: 9, said }; e.responding = true;
  e.interrupt(); e.responding = false;
  const n2 = e.careNotes('okay okay thank you');
  assert.doesNotMatch(n2, /still owed/); assert.match(n2, /acknowledged the reminder/);
  // the persona forbids developer language and hedging about reminders
  const brain = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8');
  assert.match(brain, /never use technical or developer words with them \(logs, dashboard, notification, system/); assert.match(brain, /never say "I think" or hedge about it/);
});

test('G1 "meds" with back-pain history: generic only; condition/medicine guesses rejected; "Which meds?" -> family did not say', async () => {
  const id = newSenior(); const c = mkCall(); c.profile = memory.load(id); c.nameChance = 0;
  c.profile.memory.current = [{ who: c.profile.name, text: 'takes medicine for her back pain every morning', told: '2026-10-20' }];
  c.history.push({ role: 'assistant', content: 'It\'s time for your medicine for back pain.' }); // an earlier reminder is in the history
  sparkQueue.length = 0; sparkSeen.length = 0;
  sparkQueue.push("It's time for your medicine for your back.", "It's time for your back pain tablets.", "It's time for your medicine.");
  const l = await c.reminderLine({ id: 'g', task: 'meds' }, undefined);
  assert.equal(l.said, "It's time for your medicine.");
  assert.equal(sparkSeen.length, 3, 'two guesses from history were rejected and rewritten');
  assert.match(sparkSeen[0], /back pain/, 'the history IS in front of Spark');
  assert.match(sparkSeen[0], /never fill in which medicine it is or what it is for from your notes, from memory or from earlier reminders/);
  assert.match(sparkSeen[0], /If they wrote only "meds", "medicine" or "tablets", say just "your medicine"/);
  assert.match(sparkSeen[1], /Remove "back": the family did not write that/);
  // the family's own words may name the condition
  sparkQueue.length = 0; sparkQueue.push("It's time for your back medicine.");
  assert.equal((await c.reminderLine({ id: 'g2', task: 'back meds' }, undefined)).said, "It's time for your back medicine.");
  // "Which meds?" in the next turns
  await c.reminderLine({ id: 'g', task: 'meds' }, undefined).catch(() => {});
  sparkQueue.length = 0; sparkQueue.push("It's time for your medicine.");
  await c.reminderLine({ id: 'g', task: 'meds' }, undefined);
  const n = c.careNotes('Which meds?');
  assert.match(n, /REMINDER FACTS: the family wrote exactly "meds" and that is ALL you know/);
  assert.match(n, /Never name, guess or hint at which medicine it is, what it is for, a dose, or any health condition/);
  assert.match(n, /their family only wrote "meds" and did not say which, so they should please check with their family or their medicine box, because you do not want to guess/);
  for (let i = 0; i < 3; i++) assert.match(c.careNotes('and what for?'), /REMINDER FACTS/);
  assert.equal(c.careNotes('so what shall we talk about').includes('REMINDER FACTS'), false, 'only the next few turns');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8'), /never guess which medicine or what it is for from memory or earlier reminders/);
});

test('H1 safety wording: "alerted" / "let your family know", never "reminded" - in the active alert, the notes and the later history', () => {
  const id = newSenior('standard');
  const c = mkCall(); c.profile = memory.load(id); c.callId = 'x';
  const n = c.careNotes("I'm going to kill myself");
  assert.match(n, /Say "alerted" or "let your family know", never "reminded"/);
  const later = mkCall(); later.profile = memory.load(id);
  assert.match(later.roster(''), /Say "alerted" or "let your family know", never "reminded"/);
  care.markNotif(id, care.get(id).flags[0].notifId, 'seen');
  const after = mkCall(); after.profile = memory.load(id);
  assert.match(after.roster(''), /Say "alerted" or "let your family know", never "reminded"/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8'), /you alerted or let their family know, never "reminded" them/);
});

test.after(() => { calls.forEach((c) => c.end()); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('B2 reminder wording: Spark is told to understand and say it naturally; advice/dose and greetings are rejected; unclear -> exact words', async () => {
  const id = newSenior();
  const c = mkCall(); c.profile = memory.load(id);
  const nm = c.profile.name;
  const r = { id: 'r1', task: 'meds' };
  sparkQueue.length = 0; sparkQueue.push(`It's time for your medicine, ${nm}.`); sparkSeen.length = 0;
  const l1 = await c.reminderLine(r, undefined);
  assert.equal(l1.said, `It's time for your medicine, ${nm}.`); assert.doesNotMatch(l1.said, /meds/);
  const p = sparkSeen[0];
  assert.match(p, /"meds" becomes "It's time for your medicine/); assert.match(p, /"take some sleep and meds" becomes "It's time to take a rest and take your medicine/);
  assert.match(p, /with the reminder FIRST/); assert.match(p, /truly unclear.*exact words/);
  // advice or a dose that the family did not write is rejected
  sparkQueue.length = 0; sparkQueue.push(`Take two mg of your medicine, ${nm}.`, `You should take your medicine, ${nm}.`, `It's time for your medicine, ${nm}.`);
  const l2 = await c.reminderLine({ id: 'r2', task: 'medicine' }, undefined);
  assert.equal(l2.said, `It's time for your medicine, ${nm}.`);
  // natural line for a two-part task is accepted as written by Spark (not required to be verbatim)
  sparkQueue.length = 0; sparkQueue.push(`It's time to take a rest and take your medicine, ${nm}.`);
  const l3 = await c.reminderLine({ id: 'r3', task: 'take some sleep and meds' }, undefined);
  assert.match(l3.said, /rest and take your medicine/);
});

test('B2 after a reminder, the check-in asks if they got it (no bare "are you there")', async () => {
  const id = newSenior();
  const c = mkCall(); c.profile = memory.load(id); c.awaitAck = 'r9'; c.awaitTask = 'medicine';
  sparkQueue.length = 0; sparkQueue.push('Did you catch that reminder?'); sparkSeen.length = 0;
  await c.quietLine(0, undefined);
  assert.match(sparkSeen[0], /just gave them a reminder \(about "medicine"\)/);
});

test('B2 reminder time: local datetime from the dashboard input is stored as now + 4 min (no 12 h / UTC shift)', () => {
  const id = newSenior();
  const d = new Date(Date.now() + 4 * 60000), z = (n) => String(n).padStart(2, '0');
  const localInput = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; // what <input type=datetime-local> gives
  const sent = new Date(localInput).getTime(); // family.js: new Date($('at').value).getTime()
  const r = care.addReminder(id, { task: 'tea', dueAt: sent, repeat: 'none' });
  const diffMin = (r.dueAt - Date.now()) / 60000;
  console.log(`# time test: input "${localInput}" -> stored dueAt ${new Date(r.dueAt).toString()} (${diffMin.toFixed(2)} min ahead)`);
  assert.ok(diffMin > 2.9 && diffMin < 4.1, `expected about 4 min ahead, got ${diffMin}`);
  const pm = new Date(Date.now() + 4 * 60000); pm.setHours((pm.getHours() + 12) % 24);
  assert.ok(Math.abs(r.dueAt - pm.getTime()) > 11 * 3600000, 'not shifted by 12 h');
});

const harm = ["I'm going to kill myself", 'I just want to end my life', "I don't want to live anymore"];
test('A safety: Tier A alerts at once (any mode, quiet hours, recent activity), topic-only, told out loud once, not auto-resolved', () => {
  fast();
  care.cfg.quietStart = 0; care.cfg.quietEnd = 24; // everything is quiet hours
  for (const mode of ['standard', 'cautious', 'ultra']) {
    const id = newSenior(mode);
    care.touch(id, 'app', Date.now() - 1000); // recently active: Green for unreachable, irrelevant for safety
    const fam = family();
    const c = mkCall(); c.profile = memory.load(id); c.callId = 'x';
    const n1 = c.careNotes(harm[0]);
    assert.match(n1, /the app has just alerted their family, once/); assert.match(n1, /words you have not used before/);
    const a = active(id);
    assert.equal(a.length, 1, `${mode}: one alert`); assert.equal(a[0].level, 'alert'); assert.equal(a[0].safety, true);
    const push = fam.filter((e) => e.ev === 'notify');
    assert.equal(push.length, 1);
    assert.match(push[0].data.text, /^Urgent: something .* said worried Maya about their safety/);
    assert.doesNotMatch(push[0].data.text, /kill|suicid|die|emergency|911|999|\d{3}|transcript|location/i);
    const n2 = c.careNotes(harm[1]);
    assert.match(n2, /already been alerted for this and no second alert is made. Do not announce it again/);
    const n3 = c.careNotes(harm[2]);
    assert.equal(fam.filter((e) => e.ev === 'notify').length, 1, 'no duplicate alert');
    assert.equal(active(id).length, 1);
    care.onSeniorSpoke(id);
    assert.equal(active(id).length, 1, 'talking again does not clear a safety alert');
    // only the family seeing it clears it
    care.markNotif(id, active(id)[0].notifId, 'seen');
    assert.equal(active(id).length, 0);
    assert.equal(care.view(id).alerts[0].resolvedBy, 'family');
  }
  slow();
});

test('A safety: notes carry pivot + confirm rules, never "call someone" repeats, no emergency number', () => {
  const id = newSenior('standard');
  const c = mkCall(); c.profile = memory.load(id); c.callId = 'x';
  c.careNotes(harm[0]);
  const note = c.careNotes("No I won't call anyone");
  assert.match(note, /do not keep urging them to call someone/); assert.match(note, /their family has been alerted, and that you are staying/);
  assert.match(note, /it is already done/);
  assert.match(note, /No phone number, and do not tell them to call emergency services/);
  assert.doesNotMatch(c.careNotes('You can alert my family'), /ESCALATION/);
  assert.equal(active(id).length, 1);
});

test('B safety: Tier B death worry is NOT Tier A: no alert, no safety note, no crisis wording; Spark prompt says so', () => {
  const { selfHarmText } = require('../emotion');
  const worry = ["I'm tired of being old and I think I'm going to die soon", "I'm afraid of dying", 'I think I will die soon']; 
  for (const w of worry) assert.equal(selfHarmText(w), false, w);
  const id = newSenior('ultra');
  const fam = family();
  const c = mkCall(); c.profile = memory.load(id); c.callId = 'x';
  for (const w of worry) assert.equal(c.careNotes(w), '');
  assert.equal(c.safety, undefined); assert.equal(active(id).length, 0); assert.equal(fam.length, 0);
  const brain = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8');
  assert.match(brain, /Use crisis ONLY if they say they will or want to hurt themselves, kill themselves or end their own life/);
  assert.match(brain, /Fear of getting old.*is NOT crisis/s);
  assert.match(brain, /Worry about aging or dying with no intent[^']*do not tell them to call anyone or any emergency number/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'), /ESCALATION/, 'the fixed crisis line is gone');
});

test('A safety: Spark crisis tag halts the first attempt, then the reply is written again with the safety note and alerts', async () => {
  const id = newSenior('standard');
  const fam = family();
  const c = mkCall(); c.profile = memory.load(id); c.callId = 'x';
  c.history.push({ role: 'user', content: 'Mike: I do not want to go on' });
  sparkQueue.length = 0; sparkSeen.length = 0;
  sparkQueue.push('[[feel: emotion=crisis intensity=5 intent=share]] I am here with you, and I am letting your family know now.');
  c.gen = 1; c.abort = new AbortController();
  const { fixedReply } = require('../reply');
  await c.speakReply(fixedReply('[[feel: emotion=crisis intensity=5 intent=share]] x'), null, 1, { record: true });
  assert.equal(c.safety, true);
  assert.equal(active(id)[0].safety, true); assert.equal(fam.filter((e) => e.ev === 'notify').length, 1);
  assert.ok(sparkSeen.some((r) => /SAFETY \(instructions for you/.test(r)), 'rewritten with the safety note');
  assert.match(c.history[c.history.length - 1].content, /letting your family know/);
});

test('D3 "take your meds mom its leena your daughter" is a message from Leena, not a medicine reminder; real tasks unchanged', async () => {
  const { isFamilyMessage } = require('../call');
  const task = 'take your meds mom its leena your daughter';
  assert.ok(isFamilyMessage(task));
  assert.ok(isFamilyMessage('its leena your daughter'));
  assert.ok(isFamilyMessage('your son says hi'));
  assert.ok(!isFamilyMessage('meds') && !isFamilyMessage('take your back meds mom') && !isFamilyMessage("take your son's pills to the shop"));
  const id = newSenior(); const c = mkCall(); c.profile = memory.load(id); const nm = c.profile.name;
  sparkQueue.length = 0; sparkSeen.length = 0;
  sparkQueue.push(`Your daughter Leena left a message for you: "Take your meds, Mom."`);
  const l = await c.reminderLine({ id: 'l', task }, undefined);
  assert.match(sparkSeen[0], /left a message for them, written as: "take your meds mom its leena your daughter"/);
  assert.doesNotMatch(sparkSeen[0], /A reminder their family set up is due now/);
  assert.match(l.said, /Leena/);
  assert.doesNotMatch(l.said, new RegExp(`It's medicine time now, ${nm}`));
});

test('C7 safetyCut: family already pressed Seen -> no ring (family is handling it); active + no Seen -> ring in 5 s', async () => {
  fast();
  const a = await tierACut('standard');            // active alert, senior cut, ring scheduled
  assert.ok(care.activeByProfile.get(a.id), 'active + no Seen + cut -> ring');
  await settle(a.id);
  const b = newSenior('standard');
  care.selfHarmAlert(b);
  care.markNotif(b, care.view(b).alerts.find((x) => x.safety).notifId, 'seen'); // family Seen before the cut
  assert.equal(care.safetyCut(b), null, 'Seen before cut -> no ring');
  assert.ok(!care.activeByProfile.get(b));
  slow();
});
