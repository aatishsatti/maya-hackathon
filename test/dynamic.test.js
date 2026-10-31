// The dynamic delivery system and its neighbours: general "every N hours / days / weeks", WhatsApp failing and the Maya app covering it (the family SEES why), the approved invitation (template) after 24 hours
// of silence, "Both" (text and voice note on both; a call where they were last active first, never two rings), WhatsApp's rules in plain words, the time zone found automatically, and the welfare
// check options. No network: Meta Graph, Spark, the voice, the push service and the address lookup are stubbed. The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-dynamic-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
process.env.WHATSAPP_TOKEN = 'TEST-TOKEN-NOT-REAL';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_PHONE_ID = '1409237678935671';
process.env.WHATSAPP_TEMPLATE_NAME = 'maya_checkin';
process.env.WHATSAPP_TEMPLATE_LANG = 'en_GB';
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
const person = () => memory.createProfile(`Dyn${letters(n++)}`, 'female').id;
const linked = (open = true, prefix = '3500') => { const id = person(), phone = `${prefix}${String(100000 + ph++)}`; wa.link(id, phone, true); if (open) setInbound(id, 2 * 3600000); return { id, phone }; };
const quiet = () => { failMessages = false; for (const m of memory.listProfiles()) { care.welfareScheduleStop(m.id); const q = care.get(m.id); if (q) { q.reminders = []; for (const o of [...care.outreaches.values()]) { clearTimeout(o.timer); care.outreaches.delete(o.id); } care.activeByProfile.clear(); } } graphCalls.length = 0; wa.deps.testCooldownMs = 0; setrem.reset(); tz.reset(); };
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

// ---------------------------------------------------------------- 2. every N hours / days / weeks
test('"every 2 hours" SETS a reminder (no question); every N hours, days and weeks work; the next one is N units later; a too-large number is asked about', async () => {
  quiet(); const { id } = linked(true); care.get(id).tz = 'America/New_York'; const say = talker(id, 'whatsapp');
  const a = await say('Remind me every 2 hours to drink water.'); assert.ok(a.labels.includes('setrem-confirm'), a.labels.join()); assert.match(a.text, /So, every 2 hours, starting in 2 hours, I will remind you to drink water\./);
  await say('Yes.'); const s = await say('A text please.'); assert.ok(s.labels.includes('setrem-saved'));
  const r = rem(id); assert.deepEqual([r.repeat, r.every, r.deliver, r.channel], ['hourly', 2, 'text', 'whatsapp']); const due0 = r.dueAt;
  care.tick(due0 + 2000); await settle(); assert.equal(rem(id).dueAt, due0 + 2 * 3600000, 'the next one is two hours later'); assert.equal(care.view(id).reminders[0].every, 2);
  quiet(); const d = linked(true); care.get(d.id).tz = 'America/New_York'; const sd = talker(d.id, 'app');
  const b = await sd('Remind me every 3 days at 9 am to water the plants.'); assert.match(b.text, /every 3 days at 9:00 AM/); await sd('Yes.'); await sd('Text.');
  const rd = rem(d.id), due1 = rd.dueAt; assert.deepEqual([rd.repeat, rd.every], ['daily', 3]); care.tick(due1 + 2000); await settle(); assert.equal(rem(d.id).dueAt, due1 + 3 * 86400000);
  quiet(); const w = linked(true); care.get(w.id).tz = 'America/New_York'; const sw = talker(w.id, 'app');
  const c = await sw('Remind me every other week on Monday at 10 am to call my son.'); assert.match(c.text, /every 2 weeks, starting on Monday at 10:00 AM/); await sw('Yes.'); await sw('A text.'); assert.deepEqual([rem(w.id).repeat, rem(w.id).every], ['weekly', 2]);
  quiet(); const x = linked(true); const sx = talker(x.id, 'app');
  const e = await sx('Remind me every 100 hours to rest.'); assert.ok(e.labels.includes('setrem-ask-detail')); assert.match(e.text, /up to 72/); assert.equal(care.get(x.id).reminders.length, 0);
  assert.throws(() => care.addSeniorReminder(x.id, { task: 'x', dueAt: Date.now() + 9000, repeat: 'hourly', every: 73, deliver: 'text', channel: 'app', origin: 'app' }), /out of range/);
});

// ---------------------------------------------------------------- 3. WhatsApp cannot deliver: the app covers it, and the family sees why
test('WhatsApp cannot deliver a TEXT: the same text goes to the Maya app, the family sees what happened and why, and nothing is a silent "Not sent"', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); failMessages = true; add(id, { deliver: 'text', channel: 'whatsapp' }); await fire(); app.detach();
  const notice = app.ev.find(([k, d]) => k === 'notice' && d.kind === 'reminder'); assert.ok(notice, 'the open app was given the reminder'); assert.match(notice[1].text, /take your tablets/);
  assert.equal(cur(id).state, 'app_sent'); assert.deepEqual([cur(id).fellBack.from, cur(id).fellBack.reason], ['whatsapp', 'meta_error']);
  const e = acts(id).find((x) => x.where === 'app'); assert.match(e.note, /WhatsApp could not deliver it \(WhatsApp refused it\), so it went to the Maya app instead/); assert.equal(e.channel, 'text');
});

test('WhatsApp cannot deliver a VOICE NOTE: it goes to the app as a voice note in the chat', async () => {
  quiet(); const { id } = linked(true); failMessages = true; add(id, { deliver: 'voice', channel: 'whatsapp' }); await fire();
  const m = chat.thread(id).find((x) => x.role === 'maya' && x.kind === 'voice'); assert.ok(m, 'Maya\'s voice is in the chat'); assert.equal(cur(id).fellBack.from, 'whatsapp'); assert.equal(acts(id).find((x) => x.where === 'app').channel, 'voice');
});

test('WhatsApp cannot place a CALL (permission, limit, error): the app rings instead; the entry says why and stays a call', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); const keep = wa.deps.callOut; wa.deps.callOut = async () => { throw Object.assign(new Error('No approved call permission'), { code: 138006, status: 502 }); };
  try { add(id, { deliver: 'call', channel: 'whatsapp' }); await fire(); } finally { wa.deps.callOut = keep; }
  assert.ok(app.ev.some(([k, d]) => k === 'incoming' && d.kind === 'reminder'), 'the app rings'); const e = acts(id).find((x) => x.where === 'app'); assert.equal(e.channel, 'call'); assert.match(e.note, /the WhatsApp call could not be placed.*Maya app instead/); app.detach();
});

test('calls paused (2 unanswered in a row): a WhatsApp call is NOT turned into a message; the app rings and the family sees why', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[id].callMisses = 2; fs.writeFileSync(LF(), JSON.stringify(all));
  add(id, { deliver: 'call', channel: 'whatsapp' }); await fire(); assert.equal(sent().length, 0, 'no message instead of the call'); assert.ok(app.ev.some(([k]) => k === 'incoming')); assert.equal(cur(id).fellBack.reason, 'call_not_placed'); app.detach();
});

test('WhatsApp is picked but not set up for them: the app covers it (same type) and says so', async () => {
  quiet(); const id = person(); const app = openApp(id); add(id, { deliver: 'text', channel: 'whatsapp' }); await fire(); app.detach();
  assert.ok(app.ev.some(([k, d]) => k === 'notice' && /take your tablets/.test(d.text))); assert.equal(cur(id).fellBack.reason, 'not_linked'); assert.match(acts(id).find((x) => x.where === 'app').note, /WhatsApp is not set up for this person/);
});

// ---------------------------------------------------------------- 6. the approved template, after 24 hours of silence
test('the 24 hour window is closed: the approved invitation (template) goes first, the reminder follows their reply; the entry says so', async () => {
  quiet(); const { id } = linked(false); add(id, { deliver: 'text', channel: 'whatsapp' }); await fire();
  const tpl = sent(); assert.equal(tpl.length, 1); assert.equal(tpl[0].type, 'template'); assert.deepEqual([tpl[0].template.name, tpl[0].template.language.code], ['maya_checkin', 'en_GB']);
  assert.equal(rem(id).active.state, 'wa_invited'); assert.ok(!sent().some((m) => m.type === 'text'), 'the reminder itself has not been sent yet');
  const e = acts(id).find((x) => x.status !== 'scheduled'); assert.equal(e.label, 'Invitation sent, waiting for their reply'); assert.match(e.note, /approved invitation message was sent first/);
  setInbound(id, 1000); assert.equal(care.waWindowOpened(id), 1); await settle();   // they replied
  const texts = sent().filter((m) => m.type === 'text'); assert.equal(texts.length, 1, 'the reminder follows their reply'); assert.match(texts[0].text.body, /take your tablets/);
  assert.equal(rem(id).active.state, 'wa_sent'); assert.match(acts(id).find((x) => x.status !== 'scheduled').note, /after they replied to the invitation/);
});

test('no reply to the invitation: the app delivers the reminder after the wait; an invitation that cannot go falls straight to the app', async () => {
  quiet(); const { id } = linked(false); const app = openApp(id); add(id, { deliver: 'text', channel: 'whatsapp' }); await fire(); assert.equal(rem(id).active.state, 'wa_invited');
  care.tick(Date.now() + 16 * 60000); await settle(); assert.ok(app.ev.some(([k, d]) => k === 'notice' && /take your tablets/.test(d.text)), 'the app delivered it'); assert.equal(cur(id).fellBack.reason, 'no_reply_to_invitation'); app.detach();
  quiet(); const b = linked(false); const app2 = openApp(b.id); failMessages = true; add(b.id, { deliver: 'text', channel: 'whatsapp' }); await fire();
  assert.ok(app2.ev.some(([k]) => k === 'notice'), 'the invitation failed: the app covers it at once'); assert.equal(cur(b.id).fellBack.reason, 'invite_failed'); app2.detach();
  quiet(); const c = linked(false); const app3 = openApp(c.id); add(c.id, { deliver: 'text', channel: 'whatsapp' }); await fire(); care.tick(Date.now() + 20 * 60000); await settle();
  quiet(); add(c.id, { deliver: 'text', channel: 'whatsapp' }); await fire(); care.tick(Date.now() + 20 * 60000); await settle();
  quiet(); add(c.id, { deliver: 'text', channel: 'whatsapp' }); await fire(); assert.ok(cur(c.id).fellBack, 'the third invitation of the day is refused by the daily limit: the app covers it'); app3.detach();
});

// ---------------------------------------------------------------- 3. Both
test('Both + Text and Both + Voice note: delivered on BOTH; if WhatsApp cannot, the app part still arrives (and the family sees both)', async () => {
  quiet(); const { id } = linked(true); const app = openApp(id); add(id, { deliver: 'text', channel: 'both' }); await fire();
  assert.equal(sent().filter((m) => m.type === 'text').length, 1, 'on WhatsApp'); assert.ok(app.ev.some(([k, d]) => k === 'notice' && /take your tablets/.test(d.text)), 'and in the app'); assert.deepEqual(acts(id).filter((e) => e.status !== 'scheduled').map((e) => e.where).sort(), ['app', 'whatsapp']); app.detach();
  quiet(); const v = linked(true); const app2 = openApp(v.id); add(v.id, { deliver: 'voice', channel: 'both' }); await fire(); assert.equal(sent().filter((m) => m.type === 'audio').length, 1); assert.ok(chat.thread(v.id).some((x) => x.kind === 'voice'), 'a voice note in the app chat too'); app2.detach();
  quiet(); const f = linked(true); const app3 = openApp(f.id); failMessages = true; add(f.id, { deliver: 'text', channel: 'both' }); await fire();
  assert.ok(app3.ev.some(([k]) => k === 'notice'), 'WhatsApp failed, the app part still arrived'); assert.equal(care.get(f.id).reminders[0].last.state, 'wa_failed'); assert.equal(care.get(f.id).reminders[0].last.app.state, 'app_sent'); app3.detach();
});

test('Both + Call: the app rings if it is open; otherwise where they were last active goes first; if that cannot ring, the other; never two rings', async () => {
  const keep = wa.deps.callOut; let rang = 0; wa.deps.callOut = async (o) => { rang++; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  try {
    quiet(); const a = linked(true); const app = openApp(a.id); add(a.id, { deliver: 'call', channel: 'both' }); await fire(); assert.ok(app.ev.some(([k]) => k === 'incoming')); assert.equal(rang, 0, 'the app is open: one ring, in the app'); app.detach();
    // app closed, a phone registered for the push (so both are possible), WhatsApp active more recently -> WhatsApp first
    push.deps.configured = () => true; const pushes = []; push.deps.send = async (d, payload) => { pushes.push(payload); return { ok: true }; };
    quiet(); const b = linked(true); care.registerDevice(b.id, { platform: 'ios', token: 'T'.repeat(64) }); care.get(b.id).lastActivity.app = Date.now() - 3 * 3600000; care.get(b.id).lastActivity.whatsapp = Date.now() - 60000;
    add(b.id, { deliver: 'call', channel: 'both' }); rang = 0; let pushesWhileWA = null; const inner = wa.deps.callOut; wa.deps.callOut = async (o) => { pushesWhileWA = pushes.length; return inner(o); }; await fire(); wa.deps.callOut = inner; assert.equal(rang, 1, 'WhatsApp was the more recent door: it rings first'); assert.equal(pushesWhileWA, 0, 'and the phone is not also rung while WhatsApp rings');
    quiet(); const c = linked(true); care.registerDevice(c.id, { platform: 'ios', token: 'U'.repeat(64) }); care.get(c.id).lastActivity.app = Date.now() - 60000; care.get(c.id).lastActivity.whatsapp = Date.now() - 3 * 3600000;
    add(c.id, { deliver: 'call', channel: 'both' }); rang = 0; pushes.length = 0; await fire(); assert.equal(pushes.length, 1, 'the app was the more recent door: the phone is rung'); assert.equal(rang, 0, 'and WhatsApp does not also ring');
    quiet(); const d = linked(true); care.registerDevice(d.id, { platform: 'ios', token: 'V'.repeat(64) }); care.get(d.id).lastActivity.whatsapp = Date.now() - 1000; wa.deps.callOut = async () => { throw Object.assign(new Error('No approved call permission'), { code: 138006, status: 502 }); };
    const app4 = openApp(d.id); app4.detach(); pushes.length = 0; add(d.id, { deliver: 'call', channel: 'both' }); await fire(); assert.equal(pushes.length, 1, 'WhatsApp could not ring, so the other one was tried');
  } finally { wa.deps.callOut = keep; push.deps.configured = () => false; }
});

// ---------------------------------------------------------------- the rules, in plain words, before the family picks
test('WhatsApp\'s rules are in the dashboard data in plain words (window, invitation, call limits, the app fallback), and on the web page and in the app', () => {
  quiet(); const { id } = linked(true); const rules = care.view(id).whatsappRules; assert.ok(Array.isArray(rules) && rules.length >= 5);
  const all = rules.join(' '); for (const re of [/24 hours/, /invitation/, /template/, /2 invitations a day/, /allowed WhatsApp calls/, /limits how many calls/, /2 calls in a row/, /30 reminder messages/, /Maya app instead/, /last active/]) assert.match(all, re);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.html'), 'utf8'); assert.match(html, /id="waRulesA"/); assert.match(html, /id="waRulesB"/); assert.match(html, /WhatsApp rules, in plain words/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8'); assert.match(js, /v\.whatsappRules/);
  const dart = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'family', 'tab_reminders.dart'), 'utf8'); assert.match(dart, /WhatsappRules\(rules: WhatsappRules\.from\(widget\.data\.care\['whatsappRules'\]\)\)/);
});

// ---------------------------------------------------------------- 4. time zone
test('time zone: the device first (it always wins), then the connection, then the phone number\'s country, and only then the family; never a required step', async () => {
  quiet(); const a = person(); care.touch(a, 'app', Date.now(), 'Europe/Paris'); assert.deepEqual([care.get(a).tz, care.get(a).tzSource], ['Europe/Paris', 'device']);
  assert.equal(await tz.learnFromIp(care, a, '8.8.8.8'), false, 'already known: no lookup');
  let asked = 0; tz.deps.geoTz = async (ip) => { asked += 1; return ip === '8.8.8.8' ? 'America/Chicago' : null; };
  const b = person(); assert.equal(await tz.learnFromIp(care, b, '192.168.1.5'), false); assert.equal(asked, 0, 'a private address is never looked up');
  assert.equal(await tz.learnFromIp(care, b, '8.8.8.8'), true); assert.deepEqual([care.get(b).tz, care.get(b).tzSource], ['America/Chicago', 'ip']);
  care.touch(b, 'app', Date.now(), 'America/Denver'); assert.deepEqual([care.get(b).tz, care.get(b).tzSource], ['America/Denver', 'device'], 'their own device overrides the connection guess');
  care.touch(b, 'app', Date.now(), 'America/Chicago'); assert.equal(care.get(b).tz, 'America/Chicago');
  const c = person(); assert.equal(await tz.learnFromIp(care, c, '9.9.9.9'), false, 'the lookup found nothing: the zone stays unknown'); assert.equal(care.get(c).tz, null); assert.equal(await tz.learnFromIp(care, c, '9.9.9.9'), false, 'and it is not tried again within hours');
  assert.equal(care.view(c).quiet.tz, null, 'the dashboard sees it is unknown, and asks only now');
  assert.equal(care.setTimezone(c, 'Asia/Kolkata'), true); assert.deepEqual([care.get(c).tz, care.get(c).tzSource], ['Asia/Kolkata', 'manual']); assert.throws(() => care.setTimezone(c, 'Mars/Base'), /not a time zone name/);
  care.touch(c, 'app', Date.now(), 'Asia/Kolkata'); assert.equal(care.get(c).tzSource, 'device', 'a device that later reports it takes over');
  assert.equal(tz.fromPhone('447700900123'), 'Europe/London'); assert.equal(tz.fromPhone('919876543210'), 'Asia/Kolkata'); assert.equal(tz.fromPhone('353851234567'), 'Europe/Dublin'); assert.equal(tz.fromPhone('12025550123'), null, 'a country with several zones is not guessed'); assert.equal(tz.fromPhone('5511987654321'), null);
  const lk = linked(false, '447700'); assert.deepEqual([care.get(lk.id).tz, care.get(lk.id).tzSource], ['Europe/London', 'phone'], 'linking a UK WhatsApp number gives the zone'); const us = linked(false, '1202555'); assert.equal(care.get(us.id).tz, null);
});

test('with the zone found automatically, "at 8" just works; with it unknown Maya does not guess', async () => {
  quiet(); const a = person(); care.touch(a, 'app', Date.now(), 'Asia/Tokyo'); const say = talker(a, 'app');
  const r = await say('Remind me at 8 in the morning to take my pills.'); assert.ok(r.labels.includes('setrem-confirm')); assert.match(r.text, /at 8:00 AM/);
  const b = person(); const sb = talker(b, 'app'); const u = await sb('Remind me at 8 in the morning to take my pills.'); assert.ok(u.labels.includes('setrem-no-time-zone'), 'unknown zone: not guessed');
  tz.deps.geoTz = async () => 'Europe/London'; await tz.learnFromIp(care, b, '1.2.3.4'); setrem.reset(b); const v = await sb('Remind me at 8 in the morning to take my pills.'); assert.ok(v.labels.includes('setrem-confirm'), 'found from the connection: it works');
});

test('the dashboard asks for the time zone only when it is unknown (web and app), and shows where a known one came from', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.html'), 'utf8'); assert.match(html, /id="tzRow" hidden/); const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8'); assert.match(js, /\$\('tzRow'\)\.hidden = Boolean\(tzq\.tz\)/);
  const dart = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'family', 'tab_setup.dart'), 'utf8'); assert.match(dart, /if \(tz != null\) return \[sectionLabel\('Time zone'\)/); assert.match(dart, /\/timezone/);
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'); assert.match(srv, /b === 'timezone'/); assert.match(srv, /learnFromIp/);
});

// ---------------------------------------------------------------- 5. welfare
test('welfare options: Every hour, Every day, Every 3 days, Every week and Custom (hours / days / weeks); a daily one runs until stopped (90 days), an hourly one 24 hours as before', async () => {
  quiet(); const { id } = linked(true); const keep = wa.deps.callOut; wa.deps.callOut = async (o) => { await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  try {
    for (const [body, mins] of [[{ everyMin: 60 }, 60], [{ everyMin: 1440 }, 1440], [{ everyMin: 4320 }, 4320], [{ everyMin: 10080 }, 10080], [{ every: 2, unit: 'weeks' }, 20160], [{ every: 5, unit: 'days' }, 7200], [{ every: 6, unit: 'hours' }, 360]]) {
      care.welfareScheduleStop(id); const t0 = Date.now(); const s = care.welfareScheduleStart(id, { ...body, via: 'call' }); assert.equal(s.everyMin, mins); assert.equal(s.status, 'running');
      assert.equal(s.until - s.startedAt, mins >= 1440 ? 90 * 86400000 : 24 * 3600000, `${mins} minutes: ${mins >= 1440 ? '90 days' : '24 hours'}`); assert.ok(s.next >= t0 + mins * 60000);
    }
    assert.throws(() => care.welfareScheduleStart(id, { every: 13, unit: 'weeks', via: 'call' }), /every hour, every day, every 3 days, every week/); assert.throws(() => care.welfareScheduleStart(id, { every: 2, unit: 'years', via: 'call' }), /every hour/); assert.throws(() => care.welfareScheduleStart(id, { everyMin: 2, via: 'call' }), /every hour/);
    care.welfareScheduleStop(id); const s = care.welfareScheduleStart(id, { everyMin: 1440, via: 'call' }); const p = care.get(id); p.welfareSchedule.next = Date.now() - 1000; care.tick(Date.now()); await settleT();
    const after = care.welfareScheduleView(id); assert.equal(after.fired, 1, 'the daily check fired once'); assert.ok(after.next > Date.now() + 23 * 3600000, 'and the next one is a day away'); assert.ok(wa.activityOf(id).entries.some((e) => e.type === 'welfare'), 'it shows in Activity');
    assert.equal(care.welfareScheduleStop(id), true, 'stop works'); assert.equal(care.welfareScheduleView(id).status, 'ended'); void s;
    // quiet hours still hold it
    care.welfareScheduleStart(id, { everyMin: 1440, via: 'call' }); care.get(id).tz = 'UTC'; const nightTick = new Date(); nightTick.setUTCHours(23, 30, 0, 0); if (nightTick.getTime() < Date.now()) nightTick.setUTCDate(nightTick.getUTCDate() + 1);
    care.get(id).welfareSchedule.next = nightTick.getTime() - 1000; const before = care.welfareScheduleView(id).fired; care.tick(nightTick.getTime()); await settle(); assert.equal(care.welfareScheduleView(id).fired, before, 'held for quiet hours'); assert.equal(care.welfareScheduleView(id).held, true);
  } finally { wa.deps.callOut = keep; care.welfareScheduleStop(id); }
});

test('the welfare options are on the web page and in the app: no disabled "not available yet" row, a number-and-unit custom choice', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.html'), 'utf8'); for (const v of ['60', '1440', '4320', '10080', 'custom']) assert.match(html, new RegExp(`<option value="${v}">`)); assert.match(html, /id="schedUnit"/); assert.doesNotMatch(html, /not available yet/);
  const dart = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'family', 'tab_welfare.dart'), 'utf8'); for (const t of ['Every hour', 'Every day', 'Every 3 days', 'Every week', 'Custom']) assert.match(dart, new RegExp(t)); assert.doesNotMatch(dart, /not available yet/);
});

// ---------------------------------------------------------------- follow-up: Both + Call when the first ring is NOT ANSWERED
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test('Both + Call, the app rings first and is NOT ANSWERED: WhatsApp is tried once, only after that ring has ended; if nobody answers there either it is over (no third ring)', async () => {
  quiet(); const keepRing = care.cfg.ringMs; care.cfg.ringMs = 40; const keep = wa.deps.callOut; let rang = 0, appEndedFirst = null;
  const { id } = linked(true); const app = openApp(id);
  wa.deps.callOut = async (o) => { rang += 1; appEndedFirst = app.ev.some(([k]) => k === 'incomingEnd'); await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'no answer'; };
  try { add(id, { deliver: 'call', channel: 'both' }); care.tick(Date.now() + 5000); await wait(300); await settleT(); } finally { care.cfg.ringMs = keepRing; wa.deps.callOut = keep; app.detach(); }
  assert.equal(app.ev.filter(([k]) => k === 'incoming').length, 1, 'the app rang once: it was not retried, WhatsApp had the next turn'); assert.equal(rang, 1, 'WhatsApp rang once'); assert.equal(appEndedFirst, true, 'the app ring had ENDED before WhatsApp rang: never two rings at once');
  assert.equal(calls().filter((c) => c.action === 'connect').length, 1); const r = rem(id); assert.equal(r.active, null); assert.equal(r.last.state, 'unanswered'); assert.equal(r.last.alsoTried.channel, 'app');
  assert.match(acts(id).find((e) => e.status !== 'scheduled').note, /The Maya app rang first and was not answered, so WhatsApp was tried/);
});

test('Both + Call, WhatsApp rings first (more recent) and is NOT ANSWERED: the app gets one ring; unanswered there too, it is over', async () => {
  quiet(); const keepRing = care.cfg.ringMs; care.cfg.ringMs = 40; const keep = wa.deps.callOut; let rang = 0; push.deps.configured = () => true; const pushes = []; push.deps.send = async (d, payload) => { pushes.push(payload); return { ok: true }; };
  const { id } = linked(true); care.registerDevice(id, { platform: 'ios', token: 'W'.repeat(64) }); care.get(id).lastActivity.app = Date.now() - 3 * 3600000; care.get(id).lastActivity.whatsapp = Date.now() - 1000;
  wa.deps.callOut = async (o) => { rang += 1; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'no answer'; };
  try { add(id, { deliver: 'call', channel: 'both' }); care.tick(Date.now() + 5000); await wait(300); await settleT(); } finally { care.cfg.ringMs = keepRing; wa.deps.callOut = keep; push.deps.configured = () => false; }
  assert.equal(rang, 1, 'WhatsApp rang once, first'); assert.equal(pushes.filter((p) => p.type === 'incoming').length, 1, 'then the phone was rung once'); const r = rem(id);
  assert.equal(r.active, null); assert.equal(r.last.state, 'unanswered'); assert.equal(r.last.alsoTried.channel, 'whatsapp'); assert.match(acts(id).find((e) => e.status !== 'scheduled').note, /WhatsApp rang first and was not answered, so the Maya app was tried/);
});

test('Both + Call, answered on the first platform: the other is never rung', async () => {
  quiet(); const keep = wa.deps.callOut; let rang = 0; wa.deps.callOut = async (o) => { rang += 1; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  const { id } = linked(true); const app = openApp(id);
  try { add(id, { deliver: 'call', channel: 'both' }); care.tick(Date.now() + 5000); await settle(); const o = [...care.outreaches.values()].find((x) => x.profileId === id); assert.ok(o && o.alt, 'WhatsApp is the standby'); assert.ok(care.claim(id, o.id), 'they pick up the app ring'); await wait(80); } finally { wa.deps.callOut = keep; app.detach(); }
  assert.equal(rang, 0, 'answered: WhatsApp never rang');
});

// ---------------------------------------------------------------- follow-up: the template name, a wrong or missing one
test('a missing or wrong template name falls back to the Maya app cleanly: Activity says why, nothing crashes, no silent "Not sent"', async () => {
  const keepName = process.env.WHATSAPP_TEMPLATE_NAME, keepFetch = wa.deps.fetch;
  try {
    // 1. nothing set: not guessed (no hello_world), the app covers it, and the reason names the setting to check
    delete process.env.WHATSAPP_TEMPLATE_NAME; quiet(); const a = linked(false); const appA = openApp(a.id); add(a.id, { deliver: 'text', channel: 'whatsapp' }); await fire(); appA.detach();
    assert.equal(sent().length, 0, 'no template was sent'); assert.ok(appA.ev.some(([k, d]) => k === 'notice' && /take your tablets/.test(d.text)), 'the app delivered the reminder'); assert.equal(cur(a.id).fellBack.reason, 'template_not_configured');
    assert.match(acts(a.id).find((e) => e.where === 'app').note, /no approved invitation template is set up on the server \(WHATSAPP_TEMPLATE_NAME\).*Maya app instead/);
    // 2. a name WhatsApp does not know (132001): the app covers it, the reason says the template was rejected
    process.env.WHATSAPP_TEMPLATE_NAME = 'no_such_template'; wa.deps.fetch = async (url, opts = {}) => { const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; graphCalls.push({ url, body }); if (body && body.type === 'template') return { ok: false, status: 400, json: async () => ({ error: { code: 132001, message: 'Template name does not exist in the translation' } }) }; return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x' }] }) }; };
    quiet(); const b = linked(false); const appB = openApp(b.id); add(b.id, { deliver: 'text', channel: 'whatsapp' }); await fire(); appB.detach();
    assert.ok(appB.ev.some(([k, d]) => k === 'notice' && /take your tablets/.test(d.text))); assert.equal(cur(b.id).fellBack.reason, 'template_rejected'); assert.match(acts(b.id).find((e) => e.where === 'app').note, /rejected the invitation template \(its name or language is not an approved one\)/);
    assert.equal(rem(b.id).active.state === 'wa_invited', false, 'it is not left waiting for a reply to an invitation that never went');
    // 3. Meta is down for the invitation (any other error): still the app
    process.env.WHATSAPP_TEMPLATE_NAME = 'maya_checkin'; wa.deps.fetch = async (url, opts = {}) => { graphCalls.push({ url, body: null }); return { ok: false, status: 500, json: async () => ({ error: { code: 1, message: 'Server error' } }) }; };
    quiet(); const c = linked(false); const appC = openApp(c.id); add(c.id, { deliver: 'voice', channel: 'whatsapp' }); await fire(); appC.detach(); assert.equal(cur(c.id).fellBack.reason, 'invite_failed'); assert.ok(chat.thread(c.id).some((m) => m.kind === 'voice'), 'the voice note reached the app chat');
  } finally { wa.deps.fetch = keepFetch; if (keepName === undefined) delete process.env.WHATSAPP_TEMPLATE_NAME; else process.env.WHATSAPP_TEMPLATE_NAME = keepName; }
});

// ---------------------------------------------------------------- follow-up: the IP lookup, in plain words and switchable
test('the IP-to-time-zone lookup can be switched off by config (nothing is sent to the service); device, phone-country and the dashboard still work; the privacy page says it in plain words', async () => {
  const keep = process.env.MAYA_TZ_IP_LOOKUP; let asked = 0; tz.deps.geoTz = async () => { asked += 1; return 'America/Chicago'; };
  try {
    process.env.MAYA_TZ_IP_LOOKUP = 'off'; quiet(); const a = person(); assert.equal(await tz.learnFromIp(care, a, '8.8.8.8'), false); assert.equal(asked, 0, 'switched off: the address is never sent anywhere'); assert.equal(care.get(a).tz, null);
    care.touch(a, 'app', Date.now(), 'Europe/Paris'); assert.equal(care.get(a).tz, 'Europe/Paris', 'the device still works');
    const lk = linked(false, '447700'); assert.equal(care.get(lk.id).tz, 'Europe/London', 'the phone number\'s country still works'); const m = person(); assert.equal(care.setTimezone(m, 'Asia/Tokyo'), true, 'and so does the dashboard');
    process.env.MAYA_TZ_IP_LOOKUP = 'on'; quiet(); const b = person(); assert.equal(await tz.learnFromIp(care, b, '8.8.8.8'), true); assert.equal(asked, 1, 'on: exactly one lookup');
    care.get(b).tz = null; assert.equal(await tz.learnFromIp(care, b, '8.8.4.4'), false, 'and the same person is not looked up again within hours'); assert.equal(asked, 1);
  } finally { if (keep === undefined) delete process.env.MAYA_TZ_IP_LOOKUP; else process.env.MAYA_TZ_IP_LOOKUP = keep; }
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'privacy.html'), 'utf8'); const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const re of [/Time zone/, /one-time lookup of where their internet connection is/, /only while the time zone is still unknown/, /is not kept by Maya/, /public location service/, /can be switched off by whoever runs the server/, /country code of their linked WhatsApp number/, /Only if none of these works does the family dashboard ask/]) assert.match(text, re);
  assert.match(text, /approved invitation message that asks them to reply/); assert.doesNotMatch(text, /whose text is the reminder/);
});
