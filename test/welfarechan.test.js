const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-welfarechan-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
process.env.WHATSAPP_TOKEN = 'TEST-TOKEN-NOT-REAL';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_PHONE_ID = '1409237678935671';
delete process.env.WHATSAPP_TEMPLATE_NAME; delete process.env.WHATSAPP_TEMPLATE_LANG;   // the defaults: maya_reminder / en_US
process.env.MAYA_TZ_GUESS = 'on';   // the automatic guesses (connection, phone number) are tested here; the test runner switches them off elsewhere

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
const tz = require('../tz');
const push = require('../push');
const { Call } = require('../call');
chat.deps.web = async () => ({ topics: [] });
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
chat.deps.speak = async () => Buffer.alloc(48000);
const graphCalls = []; let failMessages = false;
wa.deps.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; graphCalls.push({ url, body });
  if (failMessages && /\/(messages|media)$/.test(url)) return { ok: false, status: 400, json: async () => ({ error: { code: 131026, message: 'Message undeliverable' } }) };
  if (/\/media$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: `MEDIA${graphCalls.length}` }) };
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out${graphCalls.length}` }], calls: [{ id: 'wacid.X' }] }) };
};
const sent = () => graphCalls.filter((c) => /\/messages$/.test(c.url)).map((c) => c.body);
const calls = () => graphCalls.filter((c) => /\/calls$/.test(c.url)).map((c) => c.body);
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
const settleT = async () => { await settle(); await new Promise((r) => setTimeout(r, 80)); await settle(); };
const LF = () => path.join(process.env.MAYA_WA_DIR, 'links.json');
const setInbound = (id, ago) => { const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[id].lastInboundAt = ago === null ? null : Date.now() - ago; fs.writeFileSync(LF(), JSON.stringify(all)); };
let ph = 0;
const person = () => memory.createProfile(`Wch${letters(n++)}`, 'female').id;
const linked = (open = true, prefix = '3500') => { const id = person(), phone = `${prefix}${String(100000 + ph++)}`; wa.link(id, phone, true); if (open) setInbound(id, 2 * 3600000); return { id, phone }; };
const quiet = () => { wa.deps.testCooldownMs = 0; failMessages = false; for (const m of memory.listProfiles()) { care.welfareScheduleStop(m.id); const q = care.get(m.id); if (q) { q.reminders = []; for (const o of [...care.outreaches.values()]) { clearTimeout(o.timer); care.outreaches.delete(o.id); } care.activeByProfile.clear(); } } graphCalls.length = 0; wa.deps.testCooldownMs = 0; setrem.reset(); tz.reset(); };
const openApp = (id) => { const ev = []; const res = { write: (s) => { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push([m[1], JSON.parse(m[2])]); return true; } }; const detach = care.attachSenior(id, res, null); return { ev, detach }; };
const add = (id, extra = {}) => care.addReminder(id, { task: 'take your tablets', dueAt: Date.now() + 3000, repeat: 'none', ...extra });
const fire = async () => { care.tick(Date.now() + 5000); await settleT(); };
const rem = (id) => care.get(id).reminders[0];
const cur = (id) => rem(id).active || rem(id).last;   // the occurrence now in front of the family (the app's, after WhatsApp could not deliver)
const acts = (id) => wa.activityOf(id).entries.filter((e) => e.type === 'reminder');
const talker = (id, origin) => {
  const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id);
  if (origin !== 'call') c.channel = 'chat';
  return async (text) => { const run = () => c.careNotes(text); const out = origin === 'whatsapp' ? await care.withTurnChannel(id, 'whatsapp', async () => run()) : run(); return { text: out, labels: [...c.factLabels] }; };
};


const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const welfare = (id) => wa.activityOf(id).entries.filter((e) => e.type === 'welfare');
const chan = require('../welfarechan');
const WORDS = 'This is Maya. Your family asked me to check in on you. How are you today?';
const answered = (keep) => async (o) => { await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
const unanswered = async (o) => { await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'no answer'; };
const READY = (on) => { push.deps.configured = () => on; };

test('Where it goes: the channel is App / WhatsApp / Both, and anything else is refused', async () => {
  quiet(); const { id } = linked(true);
  await assert.rejects(chan.run(id, { via: 'text', channel: 'sms' }), /the Maya app, WhatsApp or both/); await assert.rejects(chan.run(id, { via: 'fax', channel: 'app' }), /call, a text or a voice note/); await assert.rejects(chan.run(id, { via: 'text' }), /the Maya app, WhatsApp or both/);
  assert.deepEqual(chan.CHANNELS, ['app', 'whatsapp', 'both']);
});

test('App only: a text is a notice in the app, a voice note is Maya\'s voice in the chat; nothing goes to WhatsApp', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id);
  const t = await chan.run(id, { via: 'text', channel: 'app' }); assert.equal(t.delivered[0].where, 'app'); const notice = app.ev.find(([k, d]) => k === 'notice' && d.kind === 'welfare'); assert.ok(notice, 'the open app was given the check-in'); assert.equal(notice[1].text, WORDS);
  const v = await chan.run(id, { via: 'voice', channel: 'app' }); assert.ok(chat.thread(id).some((m) => m.role === 'maya' && m.kind === 'voice'), 'her voice is in the chat'); assert.equal(v.delivered[0].via, 'voice');
  assert.equal(graphCalls.length, 0, 'nothing went to WhatsApp'); const w = welfare(id); assert.deepEqual(w.map((e) => [e.where, e.channel]).sort(), [['app', 'text'], ['app', 'voice']]); assert.ok(w.every((e) => e.words === null)); app.detach();
});

test('App only, a CALL: the app rings (kind welfare) once; a closed app with no push cannot be rung and the entry says Not sent and why', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); const r = await chan.run(id, { via: 'call', channel: 'app' }); await settleT(); assert.equal(r.delivered[0].ringing, true);
  assert.ok(app.ev.some(([k, d]) => k === 'incoming' && d.kind === 'welfare'), 'the app rings'); assert.equal(calls().length, 0, 'WhatsApp does not ring'); assert.equal(welfare(id)[0].where, 'app'); assert.equal(welfare(id)[0].channel, 'call'); app.detach();
  quiet(); const b = linked(true); await assert.rejects(chan.run(b.id, { via: 'call', channel: 'app' }), (e) => { assert.equal(e.status, 409); assert.match(e.message, /closed.*Nothing rang/); return true; });
  const e = welfare(b.id)[0]; assert.deepEqual([e.where, e.status, e.label], ['app', 'failed', 'Not sent']); assert.match(e.note, /Not sent: .*closed phone cannot be rung/);
});

test('App only needs no WhatsApp at all', async () => {
  quiet(); const id = person(); const app = openApp(id); await chan.run(id, { via: 'text', channel: 'app' }); assert.ok(app.ev.some(([k, d]) => k === 'notice' && d.kind === 'welfare')); app.detach();
});

test('WhatsApp only: a text and a voice note go on WhatsApp (the 24 hour window), nothing goes to the app', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id);
  await chan.run(id, { via: 'text', channel: 'whatsapp' }); assert.equal(sent().length, 1); assert.equal(sent()[0].text.body, WORDS);
  const shift = JSON.parse(fs.readFileSync(LF(), 'utf8')); for (const m of shift[id].sent) m.at -= 60000; fs.writeFileSync(LF(), JSON.stringify(shift));
  await chan.run(id, { via: 'voice', channel: 'whatsapp' }); assert.equal(sent()[1].type, 'audio');
  assert.equal(app.ev.filter(([k]) => k === 'notice').length, 0, 'the app was not told'); assert.deepEqual(welfare(id).map((e) => e.where), ['whatsapp', 'whatsapp']); app.detach();
});

test('WhatsApp only, a CALL: WhatsApp rings, the app does not', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); const keep = wa.deps.callOut; wa.deps.callOut = answered();
  try { await chan.run(id, { via: 'call', channel: 'whatsapp' }); await settleT(); } finally { wa.deps.callOut = keep; }
  assert.equal(calls().filter((c) => c.action === 'connect').length, 1); assert.equal(app.ev.filter(([k]) => k === 'incoming').length, 0); app.detach();
});

test('WhatsApp fails (an error): the SAME check goes to the Maya app and Activity says why; no Paused row is left', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); failMessages = true;
  const r = await chan.run(id, { via: 'text', channel: 'whatsapp' }); failMessages = false;
  assert.ok(r.fellBack && r.fellBack.from === 'whatsapp'); assert.match(r.summary, /WhatsApp could not deliver it/); assert.ok(app.ev.some(([k, d]) => k === 'notice' && d.kind === 'welfare'), 'the app got it');
  const w = welfare(id); const e = w.find((x) => x.where === 'app'); assert.match(e.note, /WhatsApp could not deliver it: .* So it went to the Maya app instead/); assert.equal(w.filter((x) => x.status === 'paused').length, 0, 'no silent Paused'); app.detach();
});

test('WhatsApp window closed (they have not written for 24 h) and the call cannot be placed: the check goes to the app with the reason', async () => {
  quiet(); const { id } = linked(false); const app = openApp(id); const keep = wa.deps.callOut; wa.deps.callOut = async () => { throw Object.assign(new Error('No approved call permission'), { code: 138006, status: 502 }); };
  let r; try { r = await chan.run(id, { via: 'text', channel: 'whatsapp' }); } finally { wa.deps.callOut = keep; }
  assert.equal(r.delivered[0].where, 'app'); assert.match(r.fellBack.why, /24 hour window/); const w = welfare(id); assert.equal(w.length, 1, 'one entry, from the app'); assert.equal(w[0].where, 'app'); assert.match(w[0].note, /24 hour window.*Maya app instead/); app.detach();
});

test('WhatsApp daily limit (10 in 24 hours): the check goes to the app and says "X / Y"; the cap still applies on WhatsApp', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id);
  const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[id].sent = Array.from({ length: 10 }, (_, i) => ({ at: Date.now() - 3600000 - i * 60000, kind: 'text', via: 'free', who: 'maya', id: `x${i}`, status: 'sent', error: null })); fs.writeFileSync(LF(), JSON.stringify(all));
  const r = await chan.run(id, { via: 'text', channel: 'whatsapp' }); assert.match(r.fellBack.why, /10 \/ 10/); assert.equal(sent().length, 0, 'WhatsApp sent nothing more'); assert.equal(welfare(id).find((e) => e.where === 'app').channel, 'text'); app.detach();
});

test('WhatsApp refuses the call (138012): the fixed text on WhatsApp stays as before; calls paused with no window: the app takes it with the reason', async () => {
  quiet(); const a = linked(true); const keep = wa.deps.callOut; wa.deps.callOut = async () => { throw Object.assign(new Error('Business Initiated Calls Limit Hit'), { code: 138012, status: 502 }); };
  try {
    const r = await chan.run(a.id, { via: 'call', channel: 'whatsapp' }); assert.equal(r.result.fallback, 'message'); assert.equal(sent().length, 1, 'the fixed text went on WhatsApp, as before');
    quiet(); const b = linked(false); const app = openApp(b.id); const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[b.id].callMisses = 2; fs.writeFileSync(LF(), JSON.stringify(all));
    const r2 = await chan.run(b.id, { via: 'call', channel: 'whatsapp' }); await settleT(); assert.equal(r2.delivered[0].where, 'app'); assert.ok(app.ev.some(([k, d]) => k === 'incoming' && d.kind === 'welfare'), 'the app rings');
    const w = welfare(b.id); assert.equal(w.filter((e) => e.status === 'paused').length, 0, 'no silent Paused'); assert.match(w.find((e) => e.where === 'app').note, /not answered|2 calls|unanswered/i); app.detach();
  } finally { wa.deps.callOut = keep; }
});

test('Both, text: it goes on WhatsApp AND to the app, two entries, each with its own delivery state; senior words are never stored', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); const r = await chan.run(id, { via: 'text', channel: 'both' });
  assert.deepEqual(r.delivered.map((d) => d.where), ['whatsapp', 'app']); assert.equal(sent().length, 1); assert.ok(app.ev.some(([k, d]) => k === 'notice' && d.kind === 'welfare'));
  const w = welfare(id); assert.deepEqual(w.map((e) => e.where).sort(), ['app', 'whatsapp']); assert.ok(w.every((e) => e.channel === 'text' && e.words === null)); assert.match(JSON.stringify(wa.activityOf(id)), /^(?!.*okay thanks).*$/);
  care.markNotif(id, care.get(id).notifications.find((n) => n.kind === 'welfare').id, 'delivered'); assert.equal(welfare(id).find((e) => e.where === 'app').status, 'delivered'); app.detach();
});

test('Both, voice note: a voice note on WhatsApp and Maya\'s voice in the app chat', async () => {
  quiet(); const { id } = linked(true); await chan.run(id, { via: 'voice', channel: 'both' });
  assert.equal(sent()[0].type, 'audio'); assert.ok(chat.thread(id).some((m) => m.role === 'maya' && m.kind === 'voice')); assert.deepEqual(welfare(id).map((e) => [e.where, e.channel]).sort(), [['app', 'voice'], ['whatsapp', 'voice']]);
});

test('Both, text: WhatsApp cannot deliver -> the app still gets it and WhatsApp\'s half is a "Not sent" entry with the reason', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); failMessages = true; const r = await chan.run(id, { via: 'text', channel: 'both' }); failMessages = false;
  assert.deepEqual(r.delivered.map((d) => d.where), ['app']); const w = welfare(id); const wae = w.find((e) => e.where === 'whatsapp'); assert.deepEqual([wae.status, wae.label], ['failed', 'Not sent']); assert.match(wae.note, /Not sent: /); assert.ok(w.find((e) => e.where === 'app')); app.detach();
});

test('Both + Call: the app rings first when it is open; WhatsApp does not ring at the same time', async () => {
  quiet(); const keep = wa.deps.callOut; let rang = 0; wa.deps.callOut = async (o) => { rang++; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  try { const { id } = linked(true); const app = openApp(id); await chan.run(id, { via: 'call', channel: 'both' }); await settleT(); assert.ok(app.ev.some(([k, d]) => k === 'incoming' && d.kind === 'welfare')); assert.equal(rang, 0, 'one ring, in the app'); app.detach(); }
  finally { wa.deps.callOut = keep; }
});

test('Both + Call, app closed: where they were last active goes first (WhatsApp), or the phone is pushed; if the first cannot ring, the other; never two rings', async () => {
  const keep = wa.deps.callOut; let rang = 0; wa.deps.callOut = async (o) => { rang++; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; }; const pushes = []; READY(true); push.deps.send = async (d, payload) => { pushes.push(payload); return { ok: true }; };
  try {
    quiet(); const b = linked(true); care.registerDevice(b.id, { platform: 'ios', token: 'T'.repeat(64) }); care.get(b.id).lastActivity.app = Date.now() - 3 * 3600000; care.get(b.id).lastActivity.whatsapp = Date.now() - 60000;
    let pushesWhileWA = null; const inner = wa.deps.callOut; wa.deps.callOut = async (o) => { pushesWhileWA = pushes.length; return inner(o); }; await chan.run(b.id, { via: 'call', channel: 'both' }); await settleT(); wa.deps.callOut = inner;
    assert.equal(rang, 1, 'WhatsApp was the more recent door: it rings first'); assert.equal(pushesWhileWA, 0, 'the phone is not also rung while WhatsApp rings'); assert.ok(pushes.length <= 1, 'the app is only tried after WhatsApp ended, once (this stub never answers)');
    quiet(); const c = linked(true); care.registerDevice(c.id, { platform: 'ios', token: 'U'.repeat(64) }); care.get(c.id).lastActivity.app = Date.now() - 60000; care.get(c.id).lastActivity.whatsapp = Date.now() - 3 * 3600000; rang = 0; pushes.length = 0;
    await chan.run(c.id, { via: 'call', channel: 'both' }); await settleT(); await wait(50); assert.equal(pushes.filter((p) => p.type === 'incoming').length, 1, 'the app was the more recent door: the phone is rung'); assert.equal(rang, 0, 'WhatsApp does not also ring');
    quiet(); const d = linked(true); care.registerDevice(d.id, { platform: 'ios', token: 'V'.repeat(64) }); care.get(d.id).lastActivity.whatsapp = Date.now() - 1000; pushes.length = 0; wa.deps.callOut = async () => { throw Object.assign(new Error('No approved call permission'), { code: 138006, status: 502 }); };
    const r = await chan.run(d.id, { via: 'call', channel: 'both' }); await settleT(); assert.equal(pushes.filter((p) => p.type === 'incoming').length, 1, 'WhatsApp could not ring, so the other one was tried'); assert.ok(r.fellBack); assert.match(welfare(d.id).find((e) => e.where === 'app').note, /WhatsApp could not deliver it.*Maya app instead/);
  } finally { wa.deps.callOut = keep; READY(false); }
});

test('Both + Call, the app rings first and is NOT ANSWERED: WhatsApp is tried once, only after that ring ended; unanswered there too it is over (no third ring)', async () => {
  quiet(); const keepRing = care.cfg.ringMs; care.cfg.ringMs = 40; const keep = wa.deps.callOut; let rang = 0, appEndedFirst = null; const { id } = linked(true); const app = openApp(id);
  wa.deps.callOut = async (o) => { rang += 1; appEndedFirst = app.ev.some(([k]) => k === 'incomingEnd'); await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'no answer'; };
  try { await chan.run(id, { via: 'call', channel: 'both' }); await wait(300); await settleT(); } finally { care.cfg.ringMs = keepRing; wa.deps.callOut = keep; app.detach(); }
  assert.equal(app.ev.filter(([k]) => k === 'incoming').length, 1, 'the app rang once'); assert.equal(rang, 1, 'WhatsApp rang once'); assert.equal(appEndedFirst, true, 'the app ring had ENDED before WhatsApp rang: never two rings at once');
  const w = welfare(id); assert.deepEqual(w.map((e) => e.where).sort(), ['app', 'whatsapp']); assert.match(w.find((e) => e.where === 'whatsapp').note, /The Maya app rang first and was not answered, so WhatsApp was tried/); assert.ok(w.every((e) => e.status === 'unreached'), JSON.stringify(w.map((e) => e.status)));
});

test('Both + Call, WhatsApp rings first and is NOT ANSWERED: the app gets one ring; unanswered there too, it is over', async () => {
  quiet(); const keepRing = care.cfg.ringMs; care.cfg.ringMs = 40; const keep = wa.deps.callOut; let rang = 0; READY(true); const pushes = []; push.deps.send = async (d, payload) => { pushes.push(payload); return { ok: true }; };
  const { id } = linked(true); care.registerDevice(id, { platform: 'ios', token: 'W'.repeat(64) }); care.get(id).lastActivity.app = Date.now() - 3 * 3600000; care.get(id).lastActivity.whatsapp = Date.now() - 1000;
  wa.deps.callOut = async (o) => { rang += 1; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'no answer'; };
  try { await chan.run(id, { via: 'call', channel: 'both' }); await wait(300); await settleT(); } finally { care.cfg.ringMs = keepRing; wa.deps.callOut = keep; READY(false); }
  assert.equal(rang, 1, 'WhatsApp rang once, first'); assert.equal(pushes.filter((p) => p.type === 'incoming').length, 1, 'then the phone was rung once'); assert.match(welfare(id).find((e) => e.where === 'app').note, /WhatsApp rang first and was not answered, so the Maya app was tried/);
});

test('Both + Call, nothing can ring (app closed, no window): both halves are Not sent entries with their reasons', async () => {
  quiet(); const { id } = linked(false); await assert.rejects(chan.run(id, { via: 'call', channel: 'both' }), /Nothing could ring/); const w = welfare(id); assert.deepEqual(w.map((e) => e.status), ['failed', 'failed']); assert.ok(w.every((e) => /Not sent: /.test(e.note)));
});

test('Quiet hours: the app is never rung at night (a call), and the entry says why', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); care.get(id).tz = 'UTC'; const real = Date.now; const night = new Date(); night.setUTCHours(23, 30, 0, 0); Date.now = () => night.getTime();
  try { await assert.rejects(chan.run(id, { via: 'call', channel: 'app' }), /quiet hours/); } finally { Date.now = real; app.detach(); }
  assert.match(welfare(id)[0].note, /quiet hours/);
});

test('The app welfare text or voice note is answered when they write or say anything in the app chat; Activity shows the same entry Answered', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); await chan.run(id, { via: 'text', channel: 'app' }); assert.equal(welfare(id)[0].status, 'sent');
  await chat.sendText(id, 'I am fine, thank you', null, {}); const w = welfare(id); assert.equal(w.length, 1, 'the same entry, no duplicate'); assert.deepEqual([w[0].status, w[0].label], ['answered', 'Answered']); app.detach();
});

test('An app welfare call that the senior answers: claimed as welfare, settled when the call ends', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); await chan.run(id, { via: 'call', channel: 'app' }); await settleT(); const inc = app.ev.find(([k]) => k === 'incoming')[1];
  const info = care.claim(id, inc.outreachId); assert.equal(info.kind, 'welfare'); assert.equal(welfare(id)[0].label, 'Picked up'); care.welfareCallEnded(id, info.notifId, info.startedAt); assert.equal(welfare(id)[0].status, 'noreply'); app.detach();
});

test('Scheduled check-ins carry the channel: an app-only schedule needs no WhatsApp and fires into the app; a both schedule fires on both; quiet hours hold it', async () => {
  quiet(); const id = person(); const app = openApp(id); const s = care.welfareScheduleStart(id, { everyMin: 1440, via: 'text', channel: 'app' }); assert.equal(s.channel, 'app');
  care.get(id).welfareSchedule.next = Date.now() - 1000; care.tick(Date.now()); await settleT(); assert.ok(app.ev.some(([k, d]) => k === 'notice' && d.kind === 'welfare')); assert.equal(care.welfareScheduleView(id).fired, 1); assert.equal(care.welfareScheduleView(id).status, 'running'); care.welfareScheduleStop(id); app.detach();
  quiet(); const b = linked(true); const app2 = openApp(b.id); care.welfareScheduleStart(b.id, { everyMin: 1440, via: 'text', channel: 'both' }); care.get(b.id).welfareSchedule.next = Date.now() - 1000; care.tick(Date.now()); await settleT();
  assert.equal(sent().length, 1); assert.ok(app2.ev.some(([k, d]) => k === 'notice' && d.kind === 'welfare')); assert.deepEqual(welfare(b.id).map((e) => e.where).sort(), ['app', 'whatsapp']); care.welfareScheduleStop(b.id); app2.detach();
  assert.throws(() => care.welfareScheduleStart(b.id, { everyMin: 1440, via: 'text', channel: 'sms' }), /the Maya app, WhatsApp or both/);
  quiet(); const w = linked(true); failMessages = true; const app3 = openApp(w.id); care.welfareScheduleStart(w.id, { everyMin: 1440, via: 'text', channel: 'whatsapp' }); care.get(w.id).welfareSchedule.next = Date.now() - 1000; care.tick(Date.now()); await settleT(); failMessages = false;
  assert.equal(care.welfareScheduleView(w.id).status, 'running', 'WhatsApp failed but the app covered it: the schedule is not silently paused'); assert.ok(app3.ev.some(([k, d]) => k === 'notice' && d.kind === 'welfare')); care.welfareScheduleStop(w.id); app3.detach();
});

test('The dashboards: a "Where it goes" picker (App / WhatsApp / Both) for welfare on the web page and in the app; Send-a-message is gone', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.html'), 'utf8'), js = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8');
  assert.match(html, /id="waWelfareWhere"[\s\S]*?data-v="app"[\s\S]*?data-v="whatsapp"[\s\S]*?data-v="both"/); assert.match(html, /id="schedWhere"[\s\S]*?data-v="app"[\s\S]*?data-v="whatsapp"[\s\S]*?data-v="both"/);
  assert.match(js, /channel: welfareWhere\.get\(\)/); assert.match(js, /channel: schedWhere\.get\(\)/);
  assert.doesNotMatch(html, /Send a message|id="msgPanel"|id="waSend"|Send message/); assert.doesNotMatch(js, /\/messages`|\/send`/);
  const dart = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'family', 'tab_welfare.dart'), 'utf8'); assert.match(dart, /WherePicker/); assert.match(dart, /'channel': _where/); assert.match(dart, /'channel': _schedWhere/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'app', 'lib', 'family', 'tab_message.dart')), false); assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'family', 'dashboard.dart'), 'utf8'), /MessageTab|'Message'/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'); assert.doesNotMatch(server, /b === 'send'|b === 'messages'/); assert.equal(typeof wa.placeMessageCall, 'undefined'); assert.equal(typeof care.sendMessage, 'undefined');
});
