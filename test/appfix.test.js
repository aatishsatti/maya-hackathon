// The app fixes: the profile's name is the only name Maya uses; app calls, in-call timers and app chats are in Activity; a reminder can go to WhatsApp, to the app or to both.
// No network: Meta Graph, Spark and the voice are stubbed, as in whatsapp.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-appfix-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
process.env.WHATSAPP_TOKEN = 'TEST-TOKEN-NOT-REAL';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_PHONE_ID = '1409237678935671';

const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push({ roster }); const item = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(item); return item; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const wa = require('../whatsapp');
const callMod = require('../call');
const PLAIN = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] That sounds nice. Tell me more about it.';
queue.push(PLAIN);
chat.deps.web = async () => ({ topics: [] });
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
chat.deps.speak = async () => Buffer.alloc(48000);   // one second of voice
const spoken = [];
const graphCalls = [];
wa.deps.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; graphCalls.push({ url, body });
  if (/\/media$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: `MEDIA${graphCalls.length}` }) };
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out${graphCalls.length}` }], calls: [{ id: 'wacid.X' }] }) };
};
const sent = () => graphCalls.filter((c) => /\/messages$/.test(c.url)).map((c) => c.body);
const calls = () => graphCalls.filter((c) => /\/calls$/.test(c.url)).map((c) => c.body);
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = (name) => memory.createProfile(name || `Wanda${letters(n++)}`, 'female').id;
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
const settleT = async () => { await settle(); await new Promise((r) => setTimeout(r, 60)); await settle(); };   // a ring starts on a 0 ms timer
const LF = () => path.join(process.env.MAYA_WA_DIR, 'links.json');
const setInbound = (id, ago) => { const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[id].lastInboundAt = ago === null ? null : Date.now() - ago; fs.writeFileSync(LF(), JSON.stringify(all)); };
let ph = 0;
const linked = (open = true) => { const id = senior(), phone = `4477008${String(10000 + ph++)}`; wa.link(id, phone, true); if (open) setInbound(id, 2 * 3600000); return { id, phone }; };
// care.tick ticks everybody: start each test with no other reminder, schedule or ring running
const quiet = () => { for (const m of memory.listProfiles()) { care.welfareScheduleStop(m.id); const q = care.get(m.id); if (q) { q.reminders = []; for (const o of [...care.outreaches.values()]) care.outreaches.delete(o.id); care.activeByProfile.clear(); } } graphCalls.length = 0; wa.deps.testCooldownMs = 0; };
// an open Maya app: an event stream that records what the server pushes
const openApp = (id) => { const ev = []; const res = { write: (s) => { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push([m[1], JSON.parse(m[2])]); return true; } }; const detach = care.attachSenior(id, res, null); return { ev, detach }; };
const due = (id, task, extra = {}) => care.addReminder(id, { task, dueAt: Date.now() + 3000, repeat: 'none', ...extra });
const entry = (id, words, pred = () => true) => wa.activityOf(id).entries.filter((e) => e.words === words && pred(e));

test('the name: the first voice never gets a name that is not the profile\'s (live: Maya called Kali "Ravi"); other voices keep theirs; the prompt says so', () => {
  const id = senior('Kali'); const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    const call = new callMod.Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(call.endTimer); call.profile = memory.load(id); call.callId = 'tcall'; memory.startCall(id, 'tcall', null);
    call.seen.add('A'); call.seen.add('B');
    call.recordName('A', 'Ravi'); assert.equal(call.names.size, 0, 'a name that is not Kali, for the first voice, is not kept');
    call.recordName('A', 'Callie'); assert.equal(call.names.size, 0, 'a mishearing of her name is not kept either: the profile name is used');
    call.recordName('A', 'kali'); assert.equal(call.names.get('A'), 'kali', 'her own name, in any case, is fine');
    call.recordName('B', 'Priya'); assert.equal(call.names.get('B'), 'Priya', 'another voice that says who they are keeps their own name');
    assert.ok(logs.some((m) => /name ignored \{"label":"A","why":"not the profile name"\}/.test(m)), 'logged by label and reason only'); assert.ok(!logs.join('\n').includes('Ravi'), 'the name itself never reaches the log');
    const note = memory.profileNote(call.profile, null); assert.match(note, /NAME RULE: call them Kali and no other name/); assert.match(note, /never a name you guessed or made up/); assert.match(note, /If you are unsure who is speaking, say so or ask; never guess a name/);
    assert.match(call.roster('', 'hello'), /call them Kali and no other name/, 'the call and the chat both carry it');
    assert.equal(callMod.sameName('Kali', 'KALI'), true); assert.equal(callMod.sameName('Kali', 'Ravi'), false); assert.equal(callMod.sameName('', 'Kali'), false);
    assert.doesNotMatch(JSON.stringify(care.get(id) || {}) + fs.readdirSync(process.env.MAYA_DATA_DIR).map((f) => fs.readFileSync(path.join(process.env.MAYA_DATA_DIR, f), 'utf8')).join(''), /Ravi/, 'memory never holds it');
  } finally { console.log = l0; }
});

test('Activity: an app call, a timer the person set in a call and an app chat each make an entry (times and counts, never a word); a Maya-placed call and a WhatsApp reply do not make a second one', async () => {
  quiet(); const id = senior(); care.get(id).tz = 'Europe/London';
  const call = { ws: {}, userTurns: 3 }; care.callStarted(id, call, 'Europe/London'); care.callEnded(id, call, 'left');
  const e = wa.activityOf(id).entries.find((x) => x.type === 'call'); assert.ok(e, 'the app call is in Activity'); assert.deepEqual([e.where, e.channel, e.status], ['app', 'call', 'completed']); assert.match(e.label, /^Talked, \d+ s$/); assert.equal(e.words, null);
  const quietCall = { ws: {}, userTurns: 0 }; care.callStarted(id, quietCall); care.callEnded(id, quietCall, 'quiet'); assert.equal(wa.activityOf(id).entries.filter((x) => x.type === 'call').find((x) => x.label === 'No talk').status, 'completed');
  const wcall = { ws: { noRingback: true }, userTurns: 1 }; care.callStarted(id, wcall); care.callEnded(id, wcall, 'left'); assert.ok(wa.activityOf(id).entries.some((x) => x.type === 'call' && x.where === 'whatsapp'), 'a call they made on WhatsApp is labelled so');
  const before = wa.activityOf(id).entries.length; const out = { ws: { noRingback: true, outbound: true }, userTurns: 2 }; care.callStarted(id, out); care.callEnded(id, out, 'left'); assert.equal(wa.activityOf(id).entries.length, before, 'a call Maya placed is already the reminder or welfare entry');
  care.timerFired(id); const t = wa.activityOf(id).entries.find((x) => x.type === 'reminder' && x.where === 'app'); assert.deepEqual([t.channel, t.status, t.label, t.words], ['call', 'delivered', 'Delivered', null]); assert.match(t.note, /set themselves/);
  // chat: two messages close together are one entry
  queue.length = 0; queue.push(PLAIN); await chat.sendText(id, 'I made soup today, secret-words-here', null, { source: 'app' }); await chat.sendText(id, 'and bread', null, { source: 'app' });
  let chats = wa.activityOf(id).entries.filter((x) => x.type === 'chat'); assert.equal(chats.length, 1); assert.equal(chats[0].label, '2 messages'); assert.equal(chats[0].words, null);
  care.get(id).callLog.find((x) => x.kind === 'chat').endedAt -= 11 * 60000; await chat.sendText(id, 'again', null, { source: 'app' }); assert.equal(wa.activityOf(id).entries.filter((x) => x.type === 'chat').length, 2, 'more than 10 minutes later: a new entry');
  await chat.sendText(id, 'from whatsapp', null, { source: 'whatsapp' }); assert.equal(wa.activityOf(id).entries.filter((x) => x.type === 'chat').length, 2, 'a WhatsApp reply answers its check or reminder: no entry of its own');
  assert.doesNotMatch(JSON.stringify(wa.activityOf(id)), /secret-words-here|soup|bread/, 'no word anyone said is in Activity'); care.flush(); assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.MAYA_CARE_DIR, `${id}.json`), 'utf8')).callLog.length >= 6, 'kept on disk');
  assert.equal(wa.activityOf(id).summary.answered, 0, 'calls and chats are not counted as answered deliveries');
});

test('reminder to the APP as a text: a notice reaches the open app, the entry goes Sent -> Delivered -> Seen as the app reports it, "okay" answers it, and one nobody sees is Missed', async () => {
  quiet(); const { id } = linked(false); const app = openApp(id); const r = due(id, 'take your tablets', { channel: 'app', deliver: 'text' });
  care.tick(Date.now() + 5000); await settle();
  const notice = app.ev.find(([k, d]) => k === 'notice' && d.kind === 'reminder'); assert.ok(notice, 'the open app was told'); assert.match(notice[1].text, /take your tablets/); assert.equal(sent().length, 0, 'nothing went on WhatsApp'); assert.equal(calls().length, 0);
  let e = entry(id, 'take your tablets')[0]; assert.deepEqual([e.where, e.channel, e.label], ['app', 'text', 'Sent']);
  care.markNotif(id, notice[1].notifId, 'delivered'); e = entry(id, 'take your tablets')[0]; assert.equal(e.label, 'Delivered'); care.markNotif(id, notice[1].notifId, 'seen'); e = entry(id, 'take your tablets')[0]; assert.deepEqual([e.status, e.label], ['read', 'Seen']);
  assert.match(care.view(id).reminders[0].active.label, /Seen in the app/);
  queue.length = 0; queue.push(PLAIN); await chat.sendText(id, 'Okay, thank you', null, { source: 'app' }); e = entry(id, 'take your tablets')[0]; assert.deepEqual([e.status, e.label], ['answered', 'Answered']); assert.equal(care.view(id).reminders[0].last.state, 'done');
  // nobody sees it
  quiet(); const x = linked(false); const app2 = openApp(x.id); due(x.id, 'drink water', { channel: 'app', deliver: 'text' }); care.tick(Date.now() + 5000); await settle(); care.tick(Date.now() + 65 * 60000); await settle();
  const m = entry(x.id, 'drink water')[0]; assert.deepEqual([m.status, m.label], ['missed', 'Missed']); app.detach(); app2.detach();
});

test('reminder to the APP as a voice note: Maya\'s voice lands in the chat and is pushed to the open app; a closed app finds it in the thread; her voice failing sends the words as text, never a fake voice note', async () => {
  quiet(); const { id } = linked(false); const app = openApp(id); due(id, 'go for a walk', { channel: 'app', deliver: 'voice' }); care.tick(Date.now() + 5000); await settle();
  const pushed = app.ev.find(([k, d]) => k === 'chat' && d.message.kind === 'voice'); assert.ok(pushed, 'a voice message reached the open app'); assert.match(pushed[1].message.mediaUrl, /\/api\/chat\/[a-f0-9]{8}\/media\/.+\.wav$/); assert.equal(sent().length, 0);
  let e = entry(id, 'go for a walk')[0]; assert.deepEqual([e.where, e.channel, e.label], ['app', 'voice', 'Delivered']); assert.ok(chat.thread(id).some((m) => m.kind === 'voice' && m.role === 'maya'));
  app.detach();
  // the app is closed: it waits in the thread; opening the chat delivers it
  quiet(); const y = linked(false); due(y.id, 'closed one', { channel: 'app', deliver: 'voice' }); care.tick(Date.now() + 5000); await settle();
  assert.equal(entry(y.id, 'closed one')[0].label, 'Sent'); care.appThreadOpened(y.id); assert.equal(entry(y.id, 'closed one')[0].label, 'Delivered');
  // her voice fails: the words go as text, and it says so
  quiet(); const z = linked(false); const app3 = openApp(z.id); const keep = chat.deps.speak; chat.deps.speak = async () => { throw new Error('voice is down'); };
  try { due(z.id, 'voice failure', { channel: 'app', deliver: 'voice' }); care.tick(Date.now() + 5000); await settle(); } finally { chat.deps.speak = keep; }
  assert.ok(app3.ev.some(([k, d]) => k === 'notice' && /voice failure/.test(d.text)), 'sent as a text notice'); const f = entry(z.id, 'voice failure')[0]; assert.equal(f.channel, 'text'); assert.match(f.note, /voice was not available/); app3.detach();
});

test('reminder to the APP as a call: the app rings when it is open; closed, WhatsApp takes it (its rules) or, with no WhatsApp, the entry says plainly that a closed phone cannot be rung', async () => {
  quiet(); const { id } = linked(false); const app = openApp(id); due(id, 'ring me', { channel: 'app', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT();
  const ring = app.ev.find(([k]) => k === 'incoming'); assert.ok(ring, 'the open app is rung'); assert.equal(ring[1].kind, 'reminder'); assert.equal(calls().length, 0, 'no WhatsApp call'); assert.equal(entry(id, 'ring me')[0].where, 'app'); assert.equal(entry(id, 'ring me')[0].channel, 'call'); app.detach();
  // closed app, WhatsApp linked: the WhatsApp call is the fallback (it goes through the same call code and its own rules)
  quiet(); const w = linked(true); let placed = null; const keep = wa.deps.callOut; wa.deps.callOut = async (o) => { placed = true; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  try { due(w.id, 'closed ring', { channel: 'app', deliver: 'call' }); care.tick(Date.now() + 5000); await settle(); await new Promise((r) => setTimeout(r, 120)); } finally { wa.deps.callOut = keep; }
  assert.ok(placed && calls().some((c) => c.action === 'connect' && c.to === w.phone), 'the WhatsApp call was tried because the app was closed');
  // closed app, no WhatsApp: nothing can ring
  quiet(); const x = senior(); due(x, 'nobody home', { channel: 'app', deliver: 'call' }); care.tick(Date.now() + 5000); await settle();
  const e = entry(x, 'nobody home')[0]; assert.deepEqual([e.status, e.label, e.where], ['failed', 'Not sent', 'app']); assert.match(e.note, /app was closed, and a closed phone cannot be rung yet/); assert.equal(calls().length + sent().length, 0);
});

test('reminder to BOTH: the same reminder goes on WhatsApp (its rules) and to the app, each with its own entry; a Call rings the app when it is open (never two rings at once), else WhatsApp', async () => {
  quiet(); const { id, phone } = linked(true); const app = openApp(id); due(id, 'both ways', { channel: 'both', deliver: 'text' }); care.tick(Date.now() + 5000); await settle();
  assert.equal(sent().length, 1); assert.equal(sent()[0].to, phone); assert.ok(app.ev.some(([k, d]) => k === 'notice' && /both ways/.test(d.text)), 'and the app got it');
  const es = entry(id, 'both ways'); assert.deepEqual(es.map((e) => e.where).sort(), ['app', 'whatsapp']); assert.ok(es.every((e) => e.channel === 'text'));
  // a call: the app is open, so it rings (and WhatsApp does not also ring)
  quiet(); const b = linked(true); const app2 = openApp(b.id); due(b.id, 'both call', { channel: 'both', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT();
  assert.ok(app2.ev.some(([k]) => k === 'incoming')); assert.equal(calls().length, 0, 'one ring, not two'); app.detach(); app2.detach();
  // WhatsApp's own rule still holds on its side: window closed -> the WhatsApp part is Not sent / rescued, the app part still arrives
  quiet(); const c = linked(false); const app3 = openApp(c.id); const keep = wa.deps.callOut; wa.deps.callOut = async () => { throw Object.assign(new Error('No approved call permission'), { code: 138006, status: 502 }); };
  try { due(c.id, 'window shut', { channel: 'both', deliver: 'text' }); care.tick(Date.now() + 5000); await settle(); await new Promise((r) => setTimeout(r, 150)); } finally { wa.deps.callOut = keep; }
  assert.ok(app3.ev.some(([k, d]) => k === 'notice' && /window shut/.test(d.text)), 'the app part arrives whatever WhatsApp says'); app3.detach();
});

test('the default channel (Setup) and the per-reminder channel: a reminder with none uses the default (WhatsApp until changed); a bad channel is refused; the view and the list show both', async () => {
  quiet(); const { id } = linked(true); assert.equal(care.view(id).delivery.channel, undefined, 'WhatsApp is the old default'); assert.throws(() => care.addReminder(id, { task: 'x', dueAt: Date.now() + 9000, repeat: 'none', channel: 'pigeon' }), /WhatsApp, the app or both/);
  assert.throws(() => care.setDelivery(id, { channel: 'pigeon' }), /WhatsApp, in the app or both/); assert.equal(care.setDelivery(id, { channel: 'app' }).channel, 'app'); assert.equal(care.setDelivery(id, { reminders: 'text' }).channel, 'app', 'changing voice / text keeps the channel');
  const app = openApp(id); const r1 = due(id, 'uses the default'); assert.equal(r1.channel, undefined); care.tick(Date.now() + 5000); await settle();
  assert.ok(app.ev.some(([k, d]) => k === 'notice' && /uses the default/.test(d.text)), 'the default said app'); assert.equal(sent().length, 0);
  quiet(); const r2 = due(id, 'wa only', { channel: 'whatsapp', deliver: 'text' }); assert.equal(care.view(id).reminders.find((x) => x.task === 'wa only').channel, 'whatsapp'); care.tick(Date.now() + 5000); await settle();
  assert.equal(sent().length, 1, 'this one overrides the default and goes on WhatsApp'); assert.equal(entry(id, 'wa only')[0].where, 'whatsapp'); app.detach();
  assert.equal(wa.activityOf(id).entries.find((e) => e.words === 'uses the default') === undefined, true, 'its record was cleared by quiet() above; the scheduled entry shows where it goes:');
  quiet(); const r3 = due(id, 'planned', { channel: 'both' }); assert.equal(wa.activityOf(id).entries.find((e) => e.words === 'planned').where, 'both'); void r2; void r3;
});

// ---- the web family page: the reminder list and the channel choice ----
const vm = require('node:vm');
const webPage = (careView, handlers = {}) => {
  class E { constructor(t) { this.tag = t; this.children = []; this.textContent = ''; this.hidden = false; this.disabled = false; this.value = ''; this.className = ''; this.handlers = {}; this.style = {}; this.dataset = {}; this.attrs = {}; }
    append(...k) { this.children.push(...k); } replaceChildren(...k) { this.children = k; } addEventListener(e, f) { this.handlers[e] = f; } setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k]; } focus() {}
    text() { return [this.textContent, ...this.children.map((c) => (c.text ? c.text() : String(c)))].join(' | '); } }
  const els = {}; const document = { getElementById: (i) => (els[i] = els[i] || new E('x')), createElement: (t) => new E(t) };
  const posts = []; const care = JSON.parse(JSON.stringify(careView));
  const sandbox = { document, window: {}, localStorage: { getItem: () => 'abcdef12', setItem() {} }, Date, JSON, Promise, console, Intl, EventSource: class { addEventListener() {} }, setInterval: () => 1, clearInterval() {},
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null; if (opts.method && opts.method !== 'GET') posts.push({ url, method: opts.method, body });
      const out = handlers[`${opts.method || 'GET'} ${url}`] ? handlers[`${opts.method || 'GET'} ${url}`](body) : url === '/api/profiles' ? { profiles: [{ id: 'abcdef12', name: 'Kali' }] } : url === '/api/care/abcdef12' ? care : url === '/api/whatsapp/abcdef12' ? { linked: false, configured: true, activity: { entries: [], summary: {} } } : {};
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(out)) };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8'), sandbox);
  return { els, posts, care, el: (i) => document.getElementById(i) };
};
const careWith = (reminders) => ({ id: 'abcdef12', name: 'Kali', mode: 'standard', modes: { standard: { label: 'Standard', blurb: 'x' } }, delivery: { reminders: 'voice' }, appOpen: false, inCall: false, lastSeen: null, callCount: 0, flags: [], alerts: [], scams: [], notifications: [], reminders, quiet: { start: 22, end: 7, tz: 'Europe/London' } });
const finishedReminder = (i) => ({ id: `f${i}`, task: `Old reminder ${i}`, dueAt: null, repeat: 'none', active: null, last: { state: 'done', at: 1700000000000 + i * 1000, dueAt: 1700000000000, attempts: 1, label: 'Done, senior replied' }, held: false, msg: false });

test('web reminders: with many finished reminders the one just added is at the TOP and shown at once (live: it was the 19th row, below the fold); only the latest five finished show', async () => {
  const finished = Array.from({ length: 19 }, (_, i) => finishedReminder(i));
  const added = { id: 'new1', task: 'Drink water', dueAt: Date.now() + 120000, repeat: 'none', deliver: 'text', channel: 'app', active: null, last: null, held: false, msg: false };
  // the server confirms the add, but the next read of the list does not have it yet (the live case where the list seemed not to update)
  const page = webPage(careWith(finished), { 'POST /api/care/abcdef12/reminders': () => ({ reminder: added }) });
  await new Promise((r) => setTimeout(r, 50));
  let items = page.els.reminders.children; assert.equal(items.length, 6, 'five finished and one "Show earlier" button'); assert.match(items[5].text(), /Show 14 earlier finished reminders/);
  page.el('task').value = 'Drink water'; page.el('at').value = '2031-01-01T10:00'; page.el('remForm').handlers.submit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(page.posts.map((x) => [x.method, x.url.replace('/api/care/abcdef12', '')]), [['POST', '/reminders']]); assert.equal(page.posts[0].body.task, 'Drink water');
  items = page.els.reminders.children; assert.match(items[0].text(), /Drink water/, 'the new reminder is the first row'); assert.match(items[0].text(), /App/, 'and says where it goes'); assert.match(items[0].text(), /Text/);
  assert.equal(items.length, 7, 'one more than before'); assert.equal(page.els.err.hidden, true, 'no error');
  // the server's own copy replaces it once the list has it
  page.care.reminders.push(added); await new Promise((r) => setTimeout(r, 20)); page.el('remForm').handlers.submit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 60));
  const again = page.els.reminders.children.filter((c) => /Drink water/.test(c.text())); assert.ok(again.length >= 1);
  const btn = page.els.reminders.children.find((c) => /earlier finished/.test(c.text())); btn.handlers.click(); await new Promise((r) => setTimeout(r, 60)); assert.ok(page.els.reminders.children.length > 20, 'Show earlier opens them all');
});

test('web reminders: the channel choice (WhatsApp / Maya app / Both) is on the Add form and sent with the reminder; the default is in the settings; the Activity list has Calls and the where-pill', async () => {
  const page = webPage(careWith([]), { 'POST /api/care/abcdef12/reminders': (b) => ({ reminder: { id: 'n2', task: b.task, dueAt: b.dueAt, repeat: b.repeat, deliver: b.deliver, channel: b.channel, active: null, last: null } }), 'POST /api/care/abcdef12/delivery': () => ({}) });
  await new Promise((r) => setTimeout(r, 40));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.html'), 'utf8');
  assert.match(html, /id="channelPick"[\s\S]*?data-v="whatsapp">WhatsApp<[\s\S]*?data-v="app">Maya app<[\s\S]*?data-v="both">Both</); assert.match(html, /id="delivChan"[\s\S]*?value="whatsapp">On WhatsApp<[\s\S]*?value="app">In the Maya app<[\s\S]*?value="both">On both</);
  page.el('delivChan').value = 'both'; page.el('delivChan').handlers.change(); await new Promise((r) => setTimeout(r, 30)); assert.deepEqual(page.posts.at(-1).body, { channel: 'both' });
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8'); assert.match(src, /\.\.\.\(channelSeg\.get\(\) \? \{ channel: channelSeg\.get\(\) \} : \{\}\)/); assert.match(src, /\['call', 'Calls'\]/); assert.match(src, /ACT_WHERE = \{ app: 'App', whatsapp: 'WhatsApp', both: 'App \+ WhatsApp' \}/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'inbox.js'), 'utf8'), /d\.kind === 'reminder' \? 'Reminder from your family'/);
});

test('reminders on WhatsApp still go as a call, a text and a voice note (the existing rules: window, calls); the app does the same three without them', async () => {
  quiet(); const { id, phone } = linked(true); const keep = wa.deps.callOut; let rang = 0; wa.deps.callOut = async (o) => { rang++; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  try {
    due(id, 'wa text', { channel: 'whatsapp', deliver: 'text' }); care.tick(Date.now() + 5000); await settle(); assert.equal(sent().at(-1).type, 'text'); assert.equal(entry(id, 'wa text')[0].where, 'whatsapp');
    graphCalls.length = 0; quiet(); due(id, 'wa voice', { channel: 'whatsapp', deliver: 'voice' }); care.tick(Date.now() + 5000); await settle(); assert.equal(sent().at(-1).type, 'audio', 'a voice note');
    graphCalls.length = 0; quiet(); due(id, 'wa call', { channel: 'whatsapp', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT(); assert.equal(rang, 1); assert.ok(calls().some((c) => c.action === 'connect' && c.to === phone));
    // the window closed: WhatsApp's own rule still applies (a call is the rescue), the app side needs none of it
    graphCalls.length = 0; quiet(); setInbound(id, 30 * 3600000); const app = openApp(id); due(id, 'app text no window', { channel: 'app', deliver: 'text' }); care.tick(Date.now() + 5000); await settle();
    assert.ok(app.ev.some(([k, d]) => k === 'notice' && /app text no window/.test(d.text)), 'in the app: no window, it just arrives'); assert.equal(sent().length + calls().length, 0); app.detach();
  } finally { wa.deps.callOut = keep; }
});
