// Call-set FUTURE reminders: the senior sets one by talking (on a call, on WhatsApp or in the app chat). Maya understands the time and the repeat, asks ONE short question when it is unclear,
// says it back BEFORE saving, saves only after a yes, never asks how or where (the way they said, else a text in the door they asked on; a call is the Maya app), and at due time delivers EXACTLY that
// way. No network: Meta Graph, Spark and the voice are stubbed, as in appfix.test.js. The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-setrem-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
process.env.WHATSAPP_TOKEN = 'TEST-TOKEN-NOT-REAL';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_PHONE_ID = '1409237678935671';

const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { const t = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Okay.'; if (onDelta) onDelta(t); return t; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const wa = require('../whatsapp');
const setrem = require('../setrem');
const { Call } = require('../call');
chat.deps.web = async () => ({ topics: [] });
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
chat.deps.speak = async () => Buffer.alloc(48000);
const graphCalls = [];
wa.deps.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; graphCalls.push({ url, body });
  if (/\/media$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: `MEDIA${graphCalls.length}` }) };
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out${graphCalls.length}` }], calls: [{ id: 'wacid.X' }] }) };
};
const sent = () => graphCalls.filter((c) => /\/messages$/.test(c.url)).map((c) => c.body);
const calls = () => graphCalls.filter((c) => /\/calls$/.test(c.url)).map((c) => c.body);
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
const settleT = async () => { await settle(); await new Promise((r) => setTimeout(r, 60)); await settle(); };
const LF = () => path.join(process.env.MAYA_WA_DIR, 'links.json');
const setInbound = (id, ago) => { const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[id].lastInboundAt = ago === null ? null : Date.now() - ago; fs.writeFileSync(LF(), JSON.stringify(all)); };
let ph = 0;
const person = () => memory.createProfile(`Ada${letters(n++)}`, 'female').id;
const linked = (open = true) => { const id = person(), phone = `4477009${String(10000 + ph++)}`; wa.link(id, phone, true); if (open) setInbound(id, 2 * 3600000); return { id, phone }; };
const quiet = () => { for (const m of memory.listProfiles()) { care.welfareScheduleStop(m.id); const q = care.get(m.id); if (q) { q.reminders = []; for (const o of [...care.outreaches.values()]) { clearTimeout(o.timer); care.outreaches.delete(o.id); } care.activeByProfile.clear(); } } graphCalls.length = 0; wa.deps.testCooldownMs = 0; setrem.reset(); };
const openApp = (id) => { const ev = []; const res = { write: (s) => { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push([m[1], JSON.parse(m[2])]); return true; } }; const detach = care.attachSenior(id, res, null); return { ev, detach }; };
const mine = (id) => care.get(id).reminders.filter((r) => r.by === 'senior');
const ent = (id, pred = () => true) => wa.activityOf(id).entries.filter((e) => e.type === 'reminder' && pred(e));

// One person talking: origin 'call' | 'whatsapp' | 'app'. Every sentence goes through the same careNotes a call and the written chat share.
const talker = (id, origin) => {
  const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id);
  if (origin !== 'call') { c.channel = 'chat'; c.noTimers = true; }
  return async (text) => { const run = () => c.careNotes(text); const out = origin === 'whatsapp' ? await care.withTurnChannel(id, 'whatsapp', async () => run()) : run(); return { text: out, labels: [...c.factLabels] }; };
};
const has = (r, label) => assert.ok(r.labels.includes(label), `expected ${label}, got ${r.labels.join(',')}`);

test('one-time: "remind me in 1 hour to take my medicine" is said back first WITH the way and the place, nothing is saved before the yes, and the yes saves it: no how question, the door they asked on', async () => {
  quiet(); const { id } = linked(true); const say = talker(id, 'whatsapp');
  const a = await say('Remind me in 1 hour to take my medicine.');
  has(a, 'setrem-confirm'); assert.match(a.text, /So, in 1 hour, I will send you a text on WhatsApp and remind you to take your medicine\. Is that right\?/); assert.equal(mine(id).length, 0, 'NOT saved before a yes');
  const t0 = Date.now(); const b = await say('Yes, that is right.'); has(b, 'setrem-saved'); assert.ok(!b.labels.includes('setrem-ask-delivery') && !b.labels.includes('setrem-ask-channel'), 'no how / where question');
  assert.equal(mine(id).length, 1); const r = mine(id)[0];
  assert.deepEqual([r.task, r.repeat, r.deliver, r.channel, r.by, r.strict], ['take my medicine', 'none', 'text', 'whatsapp', 'senior', true], 'asked on WhatsApp -> a text on WhatsApp, their own words');
  assert.ok(Math.abs(r.dueAt - (t0 + 3600000)) < 5000, 'one hour from now'); assert.doesNotMatch(b.text, /stay on the call|hang up/, 'WhatsApp: nothing about a call');
  // said in the first sentence: taken as said, never asked
  quiet(); const w = linked(true); const sw = talker(w.id, 'whatsapp');
  const c = await sw('Remind me in 1 hour to take my medicine by voice note.'); has(c, 'setrem-confirm'); assert.match(c.text, /send you a voice note on WhatsApp and remind you to take your medicine/);
  const d = await sw('Yes.'); has(d, 'setrem-saved'); assert.deepEqual([mine(w.id)[0].deliver, mine(w.id)[0].channel], ['voice', 'whatsapp']);
});

test('every hour: the senior\'s own plain words become an hourly reminder; on a CALL the door is the Maya app; nothing is asked after the yes; they may hang up', async () => {
  quiet(); const { id } = linked(true); const say = talker(id, 'call');
  const a = await say('Set a reminder for every hour and remind me every hour that I need to do a certain thing.');
  has(a, 'setrem-confirm'); assert.match(a.text, /So, every hour, starting in one hour, I will send you a text in the Maya app and remind you to do a certain thing\./); assert.equal(mine(id).length, 0);
  const b = await say('Yes.'); has(b, 'setrem-saved'); const r = mine(id)[0];
  assert.deepEqual([r.task, r.repeat, r.deliver, r.channel], ['do a certain thing', 'hourly', 'text', 'app']);
  assert.match(b.text, /They do NOT need to stay on the call/); assert.match(b.text, /not a timer/);
  assert.equal(care.view(id).reminders.find((x) => x.id === r.id).repeat, 'hourly');
  quiet(); const w = linked(true); const sc = talker(w.id, 'call');
  const c = await sc('Remind me every hour to stretch by calling me.'); has(c, 'setrem-confirm'); assert.match(c.text, /I will call you in the Maya app and remind you to stretch/);
  const d = await sc('Yes.'); has(d, 'setrem-saved'); assert.deepEqual([mine(w.id)[0].deliver, mine(w.id)[0].channel], ['call', 'app']);
});

test('a daily routine: "every morning at 8 am" is daily at 8:00 in their time zone; with WhatsApp set up nothing is asked: a text in the door they asked on (the app)', async () => {
  quiet(); const { id } = linked(true); care.get(id).tz = 'America/New_York'; const say = talker(id, 'app');
  const a = await say('Every morning at 8 am, remind me to take my pills.');
  has(a, 'setrem-confirm'); assert.match(a.text, /every day at 8:00 AM, I will send you a text in the Maya app and remind you to take your pills/); assert.equal(mine(id).length, 0);
  const c = await say('Yeah.'); has(c, 'setrem-saved'); assert.ok(!c.labels.includes('setrem-ask-channel'), 'WhatsApp is set up for them, yet no question');
  const r = mine(id)[0]; assert.deepEqual([r.repeat, r.deliver, r.channel], ['daily', 'text', 'app']);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(new Date(r.dueAt)); assert.equal(f, '08:00'); assert.ok(r.dueAt > Date.now() && r.dueAt - Date.now() <= 24 * 3600000 + 5000);
});

test('unclear time: ONE short question, nothing saved; a second miss drops it (never a guess); "at 8" alone asks morning or evening', async () => {
  quiet(); const { id } = linked(true); care.get(id).tz = 'America/New_York'; const say = talker(id, 'whatsapp');
  const a = await say('Remind me to take my pills.'); has(a, 'setrem-ask-detail'); assert.match(a.text, /"When should I remind you\?"/); assert.equal(mine(id).length, 0);
  const b = await say('Hmm, I am not sure, whenever.'); has(b, 'setrem-dropped'); assert.match(b.text, /NOTHING was saved/); assert.equal(mine(id).length, 0); assert.equal(setrem.pending(id), null);
  // the question was asked ONCE: never a second question for the same request
  assert.equal([a, b].filter((x) => x.labels.includes('setrem-ask-detail')).length, 1);
  // a bare "8" is not guessed
  const c = await say('Remind me to take my pills at 8.'); has(c, 'setrem-ask-detail'); assert.match(c.text, /8 in the morning or in the evening/); assert.equal(mine(id).length, 0);
  const d = await say('In the evening.'); has(d, 'setrem-confirm'); assert.match(d.text, /8:00 PM/);
  // no thing to remember: asked, not invented
  setrem.reset(id); const e = await say('Remind me every hour.'); has(e, 'setrem-ask-detail'); assert.match(e.text, /What should I remind you about\?/);
  setrem.reset(id); const f = await say('Remind me every 100 hours to drink water.'); has(f, 'setrem-ask-detail'); assert.match(f.text, /every few hours \(up to 72\)/);
});

test('a no, a change and an unclear answer: "no" saves nothing; a correction is said back again; an answer that is neither yes nor no is asked once more, then dropped', async () => {
  quiet(); const { id } = linked(true); const say = talker(id, 'whatsapp');
  await say('Remind me in 30 minutes to call my sister.'); const no = await say('No.'); has(no, 'setrem-dropped'); assert.equal(mine(id).length, 0);
  await say('Remind me in 30 minutes to call my sister.'); const fix = await say('No, make it in 2 hours.'); has(fix, 'setrem-confirm'); assert.match(fix.text, /in 2 hours, I will send you a text on WhatsApp and remind you to call your sister/); assert.equal(mine(id).length, 0);
  const yes = await say('Yes.'); has(yes, 'setrem-saved'); assert.equal(mine(id).length, 1); quiet();
  setrem.reset(id); await say('Remind me in 30 minutes to call my sister.');
  const u1 = await say('The weather is nice today.'); has(u1, 'setrem-confirm-again'); assert.equal(mine(id).length, 0);
  const u2 = await say('And my knee hurts.'); has(u2, 'setrem-dropped'); assert.equal(mine(id).length, 0);
});

test('"call" in the task is not a delivery: "remind me to call my sister" is a text in the door they asked on; "by call" in the first sentence is a call and is in what is said back; nothing is asked', async () => {
  quiet(); const { id } = linked(true); const say = talker(id, 'whatsapp');
  const a = await say('Remind me in 20 minutes to call my sister.'); assert.doesNotMatch(a.text, /call you and/);
  const b = await say('Yes.'); has(b, 'setrem-saved'); assert.deepEqual([mine(id)[0].deliver, mine(id)[0].channel], ['text', 'whatsapp']);
  quiet(); const y = linked(true); const say2 = talker(y.id, 'whatsapp');
  const c = await say2('Remind me by call in 20 minutes to take my tablets.'); has(c, 'setrem-confirm'); assert.match(c.text, /I will call you on WhatsApp and remind you to take your tablets/);
  const d = await say2('Yes.'); has(d, 'setrem-saved'); assert.deepEqual([mine(y.id)[0].deliver, mine(y.id)[0].channel], ['call', 'whatsapp'], 'no delivery question: they had said it');
  quiet(); const z = linked(true); const say3 = talker(z.id, 'app');   // "by calling me" / "by texting me": the shapes from the live report
  const e = await say3('Remind me in 1 minute to take my medicine by calling me'); has(e, 'setrem-confirm'); assert.match(e.text, /in 60 seconds, I will call you in the Maya app and remind you to take your medicine/);
  has(await say3('Yes'), 'setrem-saved'); assert.deepEqual([mine(z.id)[0].deliver, mine(z.id)[0].channel, mine(z.id)[0].task], ['call', 'app', 'take my medicine']);
  quiet(); const u = linked(true); const say4 = talker(u.id, 'app');
  const g = await say4('Remind me in 1 minute to take my medicine by texting me'); assert.match(g.text, /send you a text in the Maya app and remind you to take your medicine/);
  has(await say4('Yes'), 'setrem-saved'); assert.deepEqual([mine(u.id)[0].deliver, mine(u.id)[0].channel, mine(u.id)[0].task], ['text', 'app', 'take my medicine']);
});

test('channel = the door they asked on, never asked: WhatsApp -> WhatsApp; the app -> the app even with WhatsApp set up; a channel they NAME wins; WhatsApp not set up is not mentioned unless they ask for it', async () => {
  quiet(); const w = linked(true); const sw = talker(w.id, 'whatsapp');
  await sw('Remind me in 15 minutes to stretch.'); const rw = await sw('Yes.'); has(rw, 'setrem-saved'); assert.equal(mine(w.id)[0].channel, 'whatsapp', 'default');
  quiet(); const a = linked(true); const sa = talker(a.id, 'app');
  await sa('Remind me in 15 minutes to stretch.'); const ac = await sa('Yes.'); has(ac, 'setrem-saved'); assert.deepEqual([mine(a.id)[0].deliver, mine(a.id)[0].channel], ['text', 'app'], 'asked in the app with WhatsApp set up: the app, no question');
  quiet(); const o1 = linked(true); const s1 = talker(o1.id, 'whatsapp');
  await s1('Remind me in 15 minutes to stretch by voice note in the Maya app.'); const r1 = await s1('Yes.'); has(r1, 'setrem-saved');
  assert.deepEqual([mine(o1.id)[0].deliver, mine(o1.id)[0].channel], ['voice', 'app'], 'asked on WhatsApp, named the app: the app is used');
  quiet(); const o2 = linked(true); const s2 = talker(o2.id, 'app');
  await s2('Remind me in 15 minutes to stretch on WhatsApp.'); await s2('Yes.');
  assert.deepEqual([mine(o2.id)[0].deliver, mine(o2.id)[0].channel], ['text', 'whatsapp'], 'asked in the app, named WhatsApp in the first sentence');
  quiet(); const nw = person(); const s3 = talker(nw, 'call');   // no WhatsApp linked
  await s3('Remind me in 2 hours to stretch on WhatsApp.'); const r3 = await s3('Yes.'); has(r3, 'setrem-ask-channel'); assert.match(r3.text, /WhatsApp is not set up for them/); assert.equal(mine(nw).length, 0);
  const r4 = await s3('Yes the app is fine.'); has(r4, 'setrem-saved'); assert.equal(mine(nw)[0].channel, 'app');
});

test('delivery on WhatsApp: a text goes as a text, a voice note as a voice note, a call as a call, exactly as chosen, in their own words (never "from your family")', async () => {
  quiet(); const t = linked(true); care.addSeniorReminder(t.id, { task: 'take my medicine', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'whatsapp', origin: 'call' });
  care.tick(Date.now() + 5000); await settle();
  assert.equal(sent().length, 1); assert.equal(sent()[0].type, 'text'); assert.equal(sent()[0].text.body, 'Your reminder: take your medicine.'); assert.doesNotMatch(sent()[0].text.body, /family/);
  quiet(); const v = linked(true); care.addSeniorReminder(v.id, { task: 'drink water', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'voice', channel: 'whatsapp', origin: 'whatsapp' });
  care.tick(Date.now() + 5000); await settle();
  assert.deepEqual(sent().map((m) => m.type), ['audio'], 'one voice note, no text beside it'); assert.ok(graphCalls.some((c) => /\/media$/.test(c.url)));
  quiet(); const c = linked(true); const keep = wa.deps.callOut; let rang = 0; wa.deps.callOut = async (o) => { rang++; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  try { care.addSeniorReminder(c.id, { task: 'lock the door', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'call', channel: 'whatsapp', origin: 'app' }); care.tick(Date.now() + 5000); await settleT(); } finally { wa.deps.callOut = keep; }
  assert.equal(rang, 1); assert.ok(calls().some((x) => x.action === 'connect' && x.to === c.phone), 'a call was placed'); assert.equal(sent().length, 0, 'and no message');
});

test('delivery in the app: a text is a notice, a voice note is Maya\'s voice in the chat, a call rings the app; nothing goes on WhatsApp', async () => {
  quiet(); const t = linked(true); const app = openApp(t.id); care.addSeniorReminder(t.id, { task: 'take my medicine', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'app', origin: 'app' });
  care.tick(Date.now() + 5000); await settle();
  const notice = app.ev.find(([k, d]) => k === 'notice' && d.kind === 'reminder'); assert.ok(notice); assert.equal(notice[1].text, 'Your reminder: take your medicine.'); assert.equal(notice[1].by, 'senior'); assert.equal(sent().length + calls().length, 0); app.detach();
  quiet(); const v = linked(true); const app2 = openApp(v.id); care.addSeniorReminder(v.id, { task: 'go for a walk', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'voice', channel: 'app', origin: 'call' });
  care.tick(Date.now() + 5000); await settle();
  const m = chat.thread(v.id).find((x) => x.role === 'maya' && x.kind === 'voice'); assert.ok(m, 'a voice note in the chat'); assert.equal(m.text, 'Your reminder: go for a walk.'); assert.equal(sent().length, 0); app2.detach();
  quiet(); const c = linked(true); const app3 = openApp(c.id); care.addSeniorReminder(c.id, { task: 'ring test', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'call', channel: 'app', origin: 'call' });
  care.tick(Date.now() + 5000); await settleT();
  const ring = app3.ev.find(([k]) => k === 'incoming'); assert.ok(ring, 'the app rings'); assert.equal(ring[1].kind, 'reminder'); assert.match(JSON.stringify(ring[1]), /your reminder/i); assert.doesNotMatch(JSON.stringify(ring[1]), /from your family/); assert.equal(calls().length + sent().length, 0); app3.detach();
});

test('the TYPE is never switched on its own (a voice note is never a text, a call is never a message); a failed WhatsApp send falls to the app as the SAME type, and an app that cannot take it says so plainly', async () => {
  quiet(); const a = linked(true); const keep = chat.deps.speak; chat.deps.speak = async () => { throw new Error('voice is down'); };
  try { care.addSeniorReminder(a.id, { task: 'voice one', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'voice', channel: 'whatsapp', origin: 'whatsapp' }); care.tick(Date.now() + 5000); await settle(); } finally { chat.deps.speak = keep; }
  assert.equal(sent().length, 0, 'no text instead of the voice note, on WhatsApp'); const la = care.get(a.id).reminders[0].last;
  assert.equal(la.state, 'app_failed', 'the app could not make the voice note either: said plainly, never sent as a text'); assert.equal(la.fellBack.from, 'whatsapp'); assert.match(la.fellBack.why, /voice note/);
  quiet(); const c = person(); care.addSeniorReminder(c, { task: 'closed app', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'call', channel: 'app', origin: 'call' }); care.tick(Date.now() + 5000); await settleT();
  assert.equal(calls().length + sent().length, 0, 'a closed app with no WhatsApp: nothing else is rung or sent'); assert.equal(care.get(c).reminders[0].last.state, 'app_failed');
  quiet(); const d = linked(true); const app = openApp(d.id); const kp = chat.deps.speak; chat.deps.speak = async () => { throw new Error('voice is down'); };
  try { care.addSeniorReminder(d.id, { task: 'app voice', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'voice', channel: 'app', origin: 'app' }); care.tick(Date.now() + 5000); await settle(); } finally { chat.deps.speak = kp; }
  assert.ok(!app.ev.some(([k]) => k === 'notice'), 'no text notice instead of the voice note'); assert.equal(care.get(d.id).reminders[0].last.state, 'app_failed'); app.detach();
});

test('a senior-set text or voice note gets no second "nudge" message and never tells the family their words; a live call does not turn a text into speech', async () => {
  quiet(); const { id } = linked(true); care.get(id).mode = 'ultra'; care.addSeniorReminder(id, { task: 'private tulips', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'whatsapp', origin: 'call' });
  care.tick(Date.now() + 5000); await settle(); assert.equal(sent().length, 1); care.tick(Date.now() + 20 * 60000); await settle(); assert.equal(sent().length, 1, 'no nudge');
  assert.equal(care.get(id).reminders[0].last.state, 'wa_unseen', 'not read in 4 minutes: Maya rings once instead (care.unseenCall)'); care.tick(Date.now() + 70 * 60000); await settle(); assert.equal(sent().length, 1, 'still one message, never a second one'); assert.equal(care.get(id).reminders[0].last.state === 'wa_missed', false, 'the unseen text was closed by the call, not left to turn Missed'); assert.ok(!care.get(id).notifications.some((x) => x.to === 'family'), 'the family is not sent their words');
  quiet(); const live = linked(true); let spoken = 0; care.liveCalls.set(live.id, { deliverReminder() { spoken += 1; return true; } });
  care.addSeniorReminder(live.id, { task: 'in a call', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'whatsapp', origin: 'call' }); care.tick(Date.now() + 5000); await settle();
  care.liveCalls.delete(live.id); assert.equal(spoken, 0, 'a text stays a text'); assert.equal(sent().length, 1);
});

test('hourly goes on: after it is delivered the next one is an hour later; a daily one a day later', async () => {
  quiet(); const { id } = linked(true); const due0 = Date.now() + 3000;
  care.addSeniorReminder(id, { task: 'hourly one', dueAt: due0, repeat: 'hourly', deliver: 'text', channel: 'whatsapp', origin: 'call' });
  care.tick(due0 + 2000); await settle(); const r = care.get(id).reminders[0]; assert.equal(sent().length, 1); assert.equal(r.dueAt, due0 + 3600000, 'the next one is an hour later');
  assert.throws(() => care.addReminder(id, { task: 'x', dueAt: Date.now() + 9000, repeat: 'hourly' }), /none, daily or weekly/, 'the family form still offers none / daily / weekly');
});

test('quiet hours hold a senior-set reminder on every channel; released, it goes once', async () => {
  quiet(); const { id } = linked(true); care.get(id).tz = 'UTC'; const base = new Date(); base.setUTCHours(23, 30, 0, 0); if (base.getTime() < Date.now() + 10000) base.setUTCDate(base.getUTCDate() + 1);
  const r = care.addSeniorReminder(id, { task: 'held one', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'whatsapp', origin: 'call' });
  care.tick(base.getTime()); await settle(); assert.equal(sent().length, 0, 'held at 23:30'); assert.equal(care.get(id).reminders[0].held, true);
  const morning = new Date(base); morning.setUTCDate(morning.getUTCDate() + 1); morning.setUTCHours(7, 0, 30, 0); setInbound(id, 3600000);
  care.tick(morning.getTime()); await settle(); assert.equal(sent().length, 1, 'released at 07:00'); void r;
});

test('there is NO in-call timer: every ask on a call, 30 seconds or 5 minutes or an hour or every hour, is a future reminder; the written chat does the same', async () => {
  quiet(); const { id } = linked(true); const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id);
  assert.equal(c.timers, undefined, 'the call has no timers list at all'); assert.equal(typeof c.setTimerFromWords, 'undefined'); assert.equal(typeof c.fireTimer, 'undefined');
  for (const [say, expect] of [['Remind me in 30 seconds to take my medicine.', /So, I will remind you to take your medicine right after you hang up the call/], ['Remind me in 5 minutes to take my medicine.', /So, I will remind you to take your medicine right after you hang up the call/], ['Remind me in 2 hours to take my medicine.', /So, in 2 hours, I will send you a text in the Maya app and remind you/], ['Remind me in 5 minutes to rest, every hour.', /every hour, starting in 5 minutes/]]) {
    setrem.reset(id); const n = c.careNotes(say); assert.match(n, expect, say); assert.doesNotMatch(n, /timer|stay on the call/i, 'nothing about a timer or staying on the call'); assert.equal(mine(id).length, 0, 'said back first, nothing saved');
  }
  setrem.reset(id); const ch = talker(id, 'whatsapp'); const w = await ch('Remind me in 30 seconds to take my medicine.'); has(w, 'setrem-confirm'); assert.doesNotMatch(w.text, /cannot set one/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'); assert.doesNotMatch(src, /parseTimer|fireTimer|setTimerFromWords|timerOpenFact/, 'the timer code is gone');
});

test('"remind me next time I call" is still the next-call reminder, not this', async () => {
  quiet(); const { id } = linked(true); const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id); c.callId = 'c1';
  const t = c.careNotes('Remind me next time I call to ask about my pills.'); assert.ok(c.factLabels.every((l) => !l.startsWith('setrem')), c.factLabels.join(',')); assert.equal(setrem.pending(id), null); void t;
});

test('shown to the family: Family > Reminders lists it with its channel, delivery type and repeat; Activity has times, counts and a label, never a word; logs and the family never get the words', async () => {
  quiet(); const { id } = linked(true); const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    const say = talker(id, 'call'); await say('Remind me every hour by voice note on WhatsApp to take my private tulips.'); has(await say('Yes.'), 'setrem-saved');
    const v = care.view(id).reminders.find((x) => x.by === 'senior'); assert.ok(v, 'it is in the family list'); assert.deepEqual([v.channel, v.deliver, v.repeat, v.task], ['whatsapp', 'voice', 'hourly', 'take my private tulips']);
    const e = ent(id).find((x) => x.status === 'scheduled'); assert.ok(e, 'a scheduled Activity entry'); assert.deepEqual([e.where, e.channel, e.words], ['whatsapp', 'voice', null], 'channel and type shown, no words');
    assert.match(e.note, /Set by talking to Maya, every hour/); care.tick(Date.now() + 3600000 + 5000); await settle();
    assert.ok(ent(id).every((x) => x.words === null), 'no entry carries their words'); assert.ok(JSON.stringify(wa.activityOf(id)).indexOf('tulips') === -1);
  } finally { console.log = l0; }
  assert.doesNotMatch(logs.join('\n'), /tulips/, 'the words are never logged'); assert.ok(logs.some((l) => /^setrem \{"event":"saved","repeat":"hourly","every":1,"deliver":"voice","channel":"whatsapp","origin":"call"\}$/.test(l)), logs.join(' | '));
});

test('nothing invented: the said-back sentence and the saved reminder hold only their words; a task that is too long is asked shorter; a clock time with no time zone is not guessed; the limit of open reminders holds', async () => {
  quiet(); const { id } = linked(true); const say = talker(id, 'whatsapp');
  const a = await say('Remind me in 1 hour to take my medicine.'); assert.doesNotMatch(/"(So, [^"]*)"/.exec(a.text)[1], /\b(mg|dose|blood|pressure|heart|tablets?)\b/i); assert.match(a.text, /add no medicine, no dose, no reason, no advice/);
  setrem.reset(id); const long = await say(`Remind me in 1 hour to ${'take all of the many medicines in my box '.repeat(4)}`); has(long, 'setrem-ask-detail'); assert.match(long.text, /a bit shorter/);
  setrem.reset(id); const nz = await say('Remind me to take my pills at 9 am.'); has(nz, 'setrem-no-time-zone'); assert.equal(mine(id).length, 0); assert.match(nz.text, /in an hour/);
  quiet(); const full = linked(true); for (let i = 0; i < setrem.MAX_OPEN; i++) care.addSeniorReminder(full.id, { task: `thing ${i}`, dueAt: Date.now() + 3600000, repeat: 'none', deliver: 'text', channel: 'app', origin: 'app' });
  const sf = talker(full.id, 'app'); const f = await sf('Remind me in 1 hour to rest.'); has(f, 'setrem-full'); assert.equal(mine(full.id).length, setrem.MAX_OPEN);
});

test('an open set-up is forgotten after ten minutes, and a set-up begun on one door is not finished from another', async () => {
  quiet(); const { id } = linked(true); const say = talker(id, 'whatsapp'); await say('Remind me in 1 hour to take my medicine.'); assert.ok(setrem.pending(id));
  const other = talker(id, 'call'); const x = await other('Yes.'); assert.ok(!x.labels.some((l) => l.startsWith('setrem')), 'a yes on another door does not save it'); assert.equal(mine(id).length, 0);
  const now = Date.now(); setrem.step(id, 'Remind me in 1 hour to take my medicine.', { origin: 'app', now }); const late = setrem.step(id, 'Yes', { origin: 'app', now: now + setrem.TTL_MS + 1000 }); assert.equal(late.label, 'setrem-lost', 'too late: nothing is saved, and the answer is told plainly that the set-up was lost'); assert.equal(setrem.pending(id), null); assert.equal(mine(id).length, 0);
});

test('a WhatsApp reply to a senior-set reminder is told to Maya as THEIR reminder, never "from their family"', () => {
  const { reminderFacts } = require('../call');
  const f = reminderFacts({ waiting: { by: 'senior', task: 'take my medicine', minutesAgo: 3, via: 'text', nudged: false, others: 0 }, answered: null, missed: null });
  assert.match(f.text, /a reminder they asked you for themselves: "take your medicine"/); assert.doesNotMatch(f.text, /from their family/);
  const g = reminderFacts({ waiting: { by: null, task: 'take your pills mom', minutesAgo: 3, via: 'text', nudged: false, others: 0 }, answered: null, missed: null }); assert.match(g.text, /from their family/);
});

// Quiet hours stay (the test above): a senior-set reminder is HELD at night. Maya must say so honestly when she says it back and when it is saved, and the menus show it as waiting until morning.
test('quiet hours: Maya says plainly it is quiet hours and that she will remind at 7 in the morning (not "right after you hang up"); the reminder shows as Waiting until morning', async () => {
  quiet(); const { id } = linked(true); care.get(id).tz = 'Asia/Kolkata';
  const real = Date.now, at = Date.parse('2026-11-01T22:31:00Z');   // 04:01 in Kolkata
  Date.now = () => at;
  try {
    const say = talker(id, 'call'); setrem.reset && setrem.reset(id);
    let r = await say('Call me in one minute to remind me to take my headache medicine.');
    const texts = [r.text];
    for (const reply of ['Yes, that is right.', 'The Maya app is fine.', 'A phone call please.']) { if (r.labels.includes('setrem-saved')) break; r = await say(reply); texts.push(r.text); }
    const all = texts.join('\n');
    assert.match(all, /quiet hours/i, 'she says it is quiet hours');
    assert.match(all, /7 in the morning/, 'and that she will remind at 7 in the morning');
    assert.doesNotMatch(all, /right after you hang up/i, 'never the false promise');
    assert.ok(r.labels.includes('setrem-saved'), `saved, got ${r.labels.join(',')}`);
    assert.match(r.text, /quiet hours/i);
    assert.equal(mine(id).length, 1, 'kept, not refused');
    setrem.afterHangup(id);   // the call ends: what was asked for "in a minute" is brought forward to a minute after the hang-up, which is at night
    const menu = care.seniorMenu(id).reminders[0];
    assert.ok(menu.waitUntil > at, 'My Reminders: Waiting until morning, with the 07:00 release time');
    assert.equal(new Date(menu.waitUntil).toISOString(), '2026-11-02T01:30:00.000Z', '7:00 am in Kolkata');
    const fam = care.view(id).reminders[0];
    assert.equal(fam.waitUntil, menu.waitUntil, 'the dashboard shows the same');
  } finally { Date.now = real; }
});

test('quiet hours: an ordinary daytime reminder is not shown as waiting, and Maya adds nothing about quiet hours', async () => {
  quiet(); const { id } = linked(true); care.get(id).tz = 'Asia/Kolkata';
  const real = Date.now, at = Date.parse('2026-11-01T06:30:00Z');   // noon in Kolkata
  Date.now = () => at;
  try {
    const say = talker(id, 'whatsapp');
    const a = await say('Remind me in 1 hour to take my medicine.');
    assert.doesNotMatch(a.text, /quiet hours/i);
    const c = await say('Yes, that is right.'); has(c, 'setrem-saved'); assert.doesNotMatch(c.text, /quiet hours/i);
    assert.equal(care.seniorMenu(id).reminders[0].waitUntil, null);
  } finally { Date.now = real; }
});

// "oky" live: a mistyped yes was not a yes, so nothing was saved, the menu stayed empty and no pop-up ever came. A yes, however it is typed, goes on to the delivery question; once it is
// saved the reminder is in the senior's menu BEFORE it is due, and at its time the open app gets the notice (the pop-up).
test('"oky", "ok", "okk", "okie", "yess", "yes": each counts as the yes; then a saved reminder shows in the senior menu before it is due and fires the pop-up at its time', async () => {
  for (const yes of ['oky', 'ok', 'okk', 'okie', 'yess', 'Yes.', 'okay thanks']) {
    quiet(); const { id } = linked(true); care.get(id).tz = 'Asia/Kolkata'; const say = talker(id, 'app');
    await say('Remind me in 2 minutes to drink water');
    const a = await say(yes); assert.ok(a.labels.includes('setrem-saved'), `"${yes}" is a yes, got ${a.labels.join(',')}`);
    assert.equal(mine(id).length, 1, 'a yes saves it: nothing more is asked');
  }
  quiet(); const { id } = linked(true); care.get(id).tz = 'Asia/Kolkata'; const say = talker(id, 'app'); const app = openApp(id);
  await say('Remind me in 2 minutes to drink water'); const saved = await say('oky'); assert.ok(saved.labels.includes('setrem-saved'), saved.labels.join(','));
  assert.equal(mine(id).length, 1); assert.deepEqual([mine(id)[0].deliver, mine(id)[0].channel], ['text', 'app']);
  const menu = care.seniorMenu(id).reminders; assert.equal(menu.length, 1, 'the menu shows it before it is due'); assert.match(menu[0].task, /drink water/);
  assert.ok(menu[0].dueAt > Date.now() && menu[0].dueAt < Date.now() + 3 * 60000, 'about two minutes from now');
  care.tick(menu[0].dueAt + 2000); await settle();
  const notice = app.ev.find(([k]) => k === 'notice'); assert.ok(notice, 'at its time the open app gets the notice, which is the pop-up');
  assert.equal(notice[1].by, 'senior'); assert.match(notice[1].text, /drink water/i); app.detach();
});

test('a reply that is not a yes (a new thought, or a no) is still not taken for one', () => {
  for (const t of ['no', 'not now', 'tell me a story', 'what is the time', 'hmm', 'maybe', 'okay but at 5 instead']) {
    quiet(); const { id } = linked(true); care.get(id).tz = 'Asia/Kolkata';
    setrem.step(id, 'Remind me in 2 minutes to drink water', { origin: 'app', tz: 'Asia/Kolkata', now: Date.now() });
    const r = setrem.step(id, t, { origin: 'app', tz: 'Asia/Kolkata', now: Date.now() });
    assert.ok(!r || r.label !== 'setrem-ask-delivery', `"${t}" must not count as yes (${r && r.label})`);
  }
});


// The corrected rule: after the yes Maya asks HOW; WhatsApp is mentioned ONLY when it is set up for them; nothing is saved until the answers are in.
test('WhatsApp set up: nothing is asked; the say-back names the app; "both please" while confirming is taken as said, said back again, and a yes keeps "both"', async () => {
  quiet(); const { id } = linked(true); care.get(id).tz = 'Asia/Kolkata'; const say = talker(id, 'app');
  const first = await say('Remind me in 2 minutes to drink water'); has(first, 'setrem-confirm'); assert.match(first.text, /send you a text in the Maya app and remind you/);
  const where = await say('Both please'); has(where, 'setrem-confirm'); assert.match(where.text, /Maya app and on WhatsApp/); assert.equal(mine(id).length, 0, 'not saved until the yes');
  const done = await say('Yes'); has(done, 'setrem-saved');
  const r = mine(id)[0]; assert.deepEqual([r.deliver, r.channel], ['text', 'both']); assert.match(done.text, /Maya app and on WhatsApp/);
  assert.equal(care.seniorMenu(id).reminders[0].channel, 'both');
});

test('WhatsApp NOT set up: nothing is asked, the way they said is used, it is saved to the Maya app, and WhatsApp is never mentioned', async () => {
  quiet(); const id = person(); care.get(id).tz = 'Asia/Kolkata'; const say = talker(id, 'app'); const seen = [];
  seen.push((await say('Remind me in 2 minutes to drink water by voice note')).text);
  const done = await say('Yes'); has(done, 'setrem-saved'); seen.push(done.text); assert.ok(!done.labels.includes('setrem-ask-delivery'));
  const r = mine(id)[0]; assert.deepEqual([r.deliver, r.channel], ['voice', 'app']);
  for (const t of seen) assert.doesNotMatch(t, /WhatsApp/i, `no WhatsApp in: ${t.slice(0, 80)}`);
});

// Away between the question and the answer: the set-up must never end in "I couldn't set that, your family can add reminders". Either it is resumed (the asked time has gone: sorry, when instead?) or,
// if it timed out, a short answer to it gets a plain "I lost that set-up, tell me again".
test('away, then back: the asked time has passed -> sorry, when instead? (what / how / where are kept), and the next answer saves it; never "your family can add"', () => {
  const t0 = Date.now(); const MIN = 60000; quiet(); const id = person(); care.get(id).tz = 'Asia/Kolkata'; const o = { origin: 'app', tz: 'Asia/Kolkata' };
  const notes = [];
  notes.push(setrem.step(id, 'Remind me in 2 minutes to drink water', { ...o, now: t0 }));
  notes.push(setrem.step(id, 'oky', { ...o, now: t0 + 6 * MIN }));   // back after six minutes: "in 2 minutes" has gone
  const back = notes[1]; assert.equal(back.label, 'setrem-ask-detail'); assert.match(back.text, /has already passed while they were away/); assert.match(back.text, /When should I remind you\?/);
  assert.equal(mine(id).length, 0);
  notes.push(setrem.step(id, 'in 3 minutes', { ...o, now: t0 + 6 * MIN + 2000 }));
  assert.equal(notes[2].label, 'setrem-confirm'); assert.match(notes[2].text, /in 3 minutes/);
  const done = setrem.step(id, 'yes', { ...o, now: t0 + 6 * MIN + 4000 }); assert.equal(done.label, 'setrem-saved');
  assert.equal(mine(id).length, 1); const r = mine(id)[0]; assert.deepEqual([r.task, r.deliver, r.channel], ['drink water', 'text', 'app']);
  assert.ok(r.dueAt > t0 + 6 * MIN, 'the new time is from now, not the old one');
  for (const n of notes.concat(done)) assert.doesNotMatch(n.text, /family (?:can|could|should) add|their family can/i, `never "family can add": ${n.label}`);
});

test('away, timed out: a short answer to the forgotten question gets "I lost that set-up, start again" - never "your family can add reminders"', () => {
  const t0 = Date.now(); const MIN = 60000; quiet(); const id = person(); const o = { origin: 'app', tz: 'Asia/Kolkata' };
  setrem.step(id, 'Remind me in 2 minutes to drink water', { ...o, now: t0 });   // the say-back waits for a yes; they are away for 25 minutes
  const late = setrem.step(id, 'yes', { ...o, now: t0 + 25 * MIN });
  assert.equal(late.label, 'setrem-lost'); assert.match(late.text, /lost that set-up while they were away/); assert.match(late.text, /tell you again what to remind them about and when/);
  assert.doesNotMatch(late.text, /their family can|family can add/i); assert.match(late.text, /Never mention their family/); assert.equal(mine(id).length, 0);
  assert.equal(setrem.step(id, 'yes', { ...o, now: t0 + 26 * MIN }), null, 'said once, then ordinary talk again');
  assert.equal(setrem.step(id, 'Good morning', { ...o, now: t0 + 27 * MIN }), null, 'not an answer: nothing');
});

test('a real save failure says plainly it could not be set just now, or that they can stop one in My Reminders - never "your family can add"', () => {
  quiet(); const id = person(); care.get(id).tz = 'Asia/Kolkata'; const o = { origin: 'app', tz: 'Asia/Kolkata' };
  for (let i = 0; i < setrem.MAX_OPEN; i++) care.addSeniorReminder(id, { task: `t${i}`, dueAt: Date.now() + 3600000 + i * 1000, repeat: 'none', deliver: 'text', channel: 'app', origin: 'app' });
  const full = setrem.step(id, 'Remind me in 20 minutes to rest', o); assert.equal(full.label, 'setrem-full'); assert.match(full.text, /My Reminders/); assert.doesNotMatch(full.text, /their family can|family can add/i);
});
