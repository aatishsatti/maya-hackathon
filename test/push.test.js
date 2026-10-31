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
const PLAIN = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] ok.';
const push = require('../push');
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
const quiet = () => { for (const m of memory.listProfiles()) { care.welfareScheduleStop(m.id); const q = care.get(m.id); if (q) { q.reminders = []; for (const o of [...care.outreaches.values()]) { clearTimeout(o.timer); care.outreaches.delete(o.id); } care.activeByProfile.clear(); } } graphCalls.length = 0; wa.deps.testCooldownMs = 0; };
// an open Maya app: an event stream that records what the server pushes
const openApp = (id) => { const ev = []; const res = { write: (s) => { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push([m[1], JSON.parse(m[2])]); return true; } }; const detach = care.attachSenior(id, res, null); return { ev, detach }; };
const due = (id, task, extra = {}) => care.addReminder(id, { task, dueAt: Date.now() + 3000, repeat: 'none', ...extra });
const entry = (id, words, pred = () => true) => wa.activityOf(id).entries.filter((e) => e.words === words && pred(e));


// ---- closed-app calling: a push to the phone rings it; a failed push falls back under the Both-call rules ----
const nightTz = () => { const h = new Date().getUTCHours(); let o = (23 - h + 24) % 24; if (o > 14) o -= 24; return o === 0 ? 'Etc/GMT' : o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`; };
const TOKEN = 'TESTTOKEN0123456789abcdef';
const pushes = []; let pushResult = { ok: true };
push.deps.configured = () => true; push.deps.send = async (d, payload) => { pushes.push({ platform: d.platform, ...payload }); return typeof pushResult === 'function' ? pushResult(d) : pushResult; };
const device = (id, platform = 'ios') => care.registerDevice(id, { platform, token: TOKEN + platform });
const noPerm = (id) => { const j = JSON.parse(fs.readFileSync(LF(), 'utf8')); j[id].noCallPermission = { at: Date.now() }; fs.writeFileSync(LF(), JSON.stringify(j)); };
const reset = () => { pushes.length = 0; pushResult = { ok: true }; };
const logsOf = async (f) => { const out = [], l0 = console.log; console.log = (...a) => out.push(a.join(' ')); try { await f(); } finally { console.log = l0; } return out; };

test('push then app: a Call reminder with the app CLOSED sends ONE push, the phone Accepts with the outreach id, and it is one live call (no WhatsApp ring, no token in any log)', async () => {
  quiet(); reset(); const { id } = linked(true); noPerm(id); device(id); const before = calls().length;
  const out = await logsOf(async () => { due(id, 'closed app call', { channel: 'both', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT(); });
  assert.equal(pushes.length, 1, 'one push'); assert.equal(pushes[0].type, 'incoming'); assert.equal(pushes[0].kind, 'reminder'); assert.ok(pushes[0].outreachId);
  assert.equal(calls().length, before, 'WhatsApp was not rung'); assert.ok(!out.join('\n').includes(TOKEN), 'the token is never logged');
  const info = care.claim(id, pushes[0].outreachId); assert.equal(info.kind, 'reminder', 'Accept joins the same live call'); assert.equal(care.claim(id, pushes[0].outreachId), null, 'and only once');
  const o = care.outreaches.get(pushes[0].outreachId); assert.equal(o, undefined);
  // the app is open: it rings in the app, no push
  quiet(); reset(); const b = linked(true); noPerm(b.id); device(b.id); const app = openApp(b.id); due(b.id, 'open app call', { channel: 'both', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT();
  assert.ok(app.ev.some(([k]) => k === 'incoming')); assert.equal(pushes.length, 0, 'an open app is rung by the app, not by a push'); app.detach(); quiet();
});

test('push fails -> WhatsApp under the Both-call rules: permission and window fine -> WhatsApp rings once; permission missing -> NOT tried, the entry says the push did not go; no phone registered -> WhatsApp at once', async () => {
  const keep = wa.deps.callOut, keepCd = wa.deps.testCooldownMs; let rang = 0; wa.deps.testCooldownMs = 0; wa.deps.callOut = async (o) => { rang++; await o.place({ sdp_type: 'offer', sdp: 'x' }); return 'completed'; };
  try {
    quiet(); reset(); const a = linked(true); device(a.id); pushResult = { ok: false, reason: 'apns_500' };
    const out = await logsOf(async () => { due(a.id, 'push down', { channel: 'app', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT(); await settleT(); });
    assert.equal(pushes.length, 1); assert.equal(rang, 1, 'WhatsApp rang once instead'); assert.ok(out.some((l) => /"event":"push failed"/.test(l) && !l.includes(TOKEN)));
    quiet(); reset(); const b = linked(true); noPerm(b.id); device(b.id); pushResult = { ok: false, reason: 'apns_500' }; const n0 = rang;
    due(b.id, 'push down no perm', { channel: 'both', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT(); await settleT();
    assert.equal(rang, n0, 'rule 1 still holds: WhatsApp is not tried'); const e = entry(b.id, 'push down no perm'); assert.equal(e.length, 1); assert.match(e[0].note || e[0].label || '', /push to the phone did not go|Not sent/);
    quiet(); reset(); const c = linked(true); const n1 = rang; due(c.id, 'no phone', { channel: 'app', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT(); await settleT();
    assert.equal(pushes.length, 0, 'no phone registered: nothing to push'); assert.equal(rang, n1 + 1, 'WhatsApp rang at once');
    // a dead token is forgotten
    quiet(); reset(); const d = linked(true); noPerm(d.id); device(d.id); pushResult = { ok: false, reason: 'apns_410', gone: true }; due(d.id, 'dead', { channel: 'both', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT(); await settleT();
    assert.equal((care.get(d.id).devices || []).length, 0, 'a refused token is dropped'); quiet();
  } finally { wa.deps.callOut = keep; wa.deps.testCooldownMs = keepCd; }
});

test('decline: Decline on the phone ends the ring cleanly, one Activity entry (Declined), no words, nothing more rings', async () => {
  quiet(); reset(); const { id } = linked(true); noPerm(id); device(id);
  due(id, 'declined one', { channel: 'both', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT();
  const oid = pushes[0].outreachId; assert.equal(care.decline(id, oid), true); await settleT();
  const es = entry(id, 'declined one'); assert.equal(es.length, 1, 'one entry'); assert.match(JSON.stringify(es[0]), /[Dd]eclin/); assert.equal(pushes.length, 1, 'no second push'); assert.equal(care.decline(id, oid), false, 'declining twice does nothing');
  assert.ok(!JSON.stringify(care.get(id).notifications).includes(TOKEN)); assert.ok(!JSON.stringify(care.view(id)).includes(TOKEN), 'the token is never in a view'); quiet();
});

test('quiet hours hold the push: a Call reminder due at night sends no push; at 07:00 it goes', async () => {
  quiet(); reset(); const { id } = linked(true); noPerm(id); device(id); care.get(id).tz = nightTz();
  const r = due(id, 'night call', { channel: 'both', deliver: 'call' }); care.tick(Date.now() + 5000); await settleT();
  assert.equal(pushes.length, 0, 'held: nothing was pushed'); care.tick(Date.now() + 8 * 3600000); await settleT();
  assert.equal(pushes.length, 1, 'the morning push'); assert.ok(r.id);
  // a bad device registration is refused
  assert.throws(() => care.registerDevice(id, { platform: 'windows', token: TOKEN }), /ios or android/); assert.throws(() => care.registerDevice(id, { platform: 'ios', token: 'x' }), /push token/); quiet();
});

test('push.js with no keys sends nothing and says so; labels only', async () => {
  const k = push.deps.configured; push.deps.configured = null; try { assert.equal(push.configured('ios'), false); const r = await push.send({ platform: 'ios', token: TOKEN }, { type: 'incoming' }); assert.deepEqual(r, { ok: false, reason: 'not_configured' }); } finally { push.deps.configured = k; }
});
