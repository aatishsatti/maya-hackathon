// WhatsApp door (whatsapp.js), step 1: webhook verify + signature, incoming text -> the same Maya -> reply text. No network: Meta Graph, Spark and the
// scam check are stubbed. Step 2 (voice notes) and step 3 (outgoing guards) add their tests to this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-wa-'));
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
  sparkStream: async (history, roster, _s, onDelta) => { asked.push({ history: JSON.parse(JSON.stringify(history)), roster }); const item = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(item); return item; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const S = require('../scam');
const wa = require('../whatsapp');

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} That sounds nice. Tell me more about it.`;
const WARN = `${tag({ emotion: 'neutral', intensity: 2, intent: 'share', concern: 'none', pain: 0 })} That sounds like a scam. Please do not read out any code. Would you like me to let your family know?`;
const CALLS = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} I will call you now and we can talk about it.`;
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Wanda${letters(n++)}`, 'female').id;
let phoneN = 0;
const newPhone = () => `4477009${String(10000 + phoneN++)}`;
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const rd = (...on) => Object.fromEntries(S.READS.map((k) => [k, on.includes(k)]));
chat.deps.web = async () => ({ topics: [] }); // no web check in these tests
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: sig(), reads: rd(), count: 0 });

// Graph stub: records every call, answers like Meta.
const graphCalls = [];
let graphFail = null;
wa.deps.fetch = async (url, opts) => {
  graphCalls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
  if (graphFail) return { ok: false, status: 400, json: async () => ({ error: graphFail }) };
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out${graphCalls.length}` }] }) };
};
const sent = () => graphCalls.filter((c) => /\/messages$/.test(c.url)).map((c) => c.body);
const clearCalls = () => { graphCalls.length = 0; graphFail = null; };

let mid = 0;
const incoming = (from, body, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15556408264', phone_number_id: '1409237678935671' }, contacts: [{ profile: { name: 'x' }, wa_id: from }], messages: [{ from, id: `wamid.in${mid++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body }, ...extra }] } }] }] });
const linked = () => { const id = senior(), phone = newPhone(); wa.link(id, phone, true); return { id, phone }; };

test('webhook verify: right token echoes the challenge, wrong token or mode gets nothing', () => {
  const q = (o) => new URL(`http://x/?${new URLSearchParams(o)}`).searchParams;
  assert.equal(wa.verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '12345' })), '12345');
  assert.equal(wa.verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' })), null);
  assert.equal(wa.verifyChallenge(q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '1' })), null);
  assert.equal(wa.verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.challenge': '1' })), null);
});

test('signature: sha256= HMAC of the raw body with the app secret; anything else is refused', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');
  const good = `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex')}`;
  assert.equal(wa.validSignature(raw, good), true);
  assert.equal(wa.validSignature(Buffer.from('{"object":"x"}'), good), false);
  assert.equal(wa.validSignature(raw, good.replace('sha256=', 'sha1=')), false);
  assert.equal(wa.validSignature(raw, undefined), false);
  assert.equal(wa.validSignature(raw, 'sha256=zz'), false);
});

test('incoming text -> the same Maya -> a text reply to that number, in the right Graph call', async () => {
  clearCalls(); const { id, phone } = linked(); reset(PLAIN);
  const out = await wa.handleWebhook(incoming(phone, 'I made some soup today.'));
  assert.deepEqual(out, ['text']);
  const s = sent(); assert.equal(s.length, 1);
  assert.equal(s[0].messaging_product, 'whatsapp'); assert.equal(s[0].to, phone); assert.equal(s[0].type, 'text');
  assert.match(s[0].text.body, /That sounds nice/); assert.doesNotMatch(s[0].text.body, /\[\[/, 'the private feel tag never reaches the person');
  assert.match(graphCalls[0].url, /graph\.facebook\.com\/v\d+\.\d+\/1409237678935671\/messages$/);
  assert.equal(graphCalls[0].opts.headers.Authorization, 'Bearer TEST-TOKEN-NOT-REAL');
  assert.match(asked[0].history.at(-1).content, /soup/, 'the words reached Spark');
  assert.ok(care.get(id).lastActivity.whatsapp, 'WhatsApp activity is recorded as WhatsApp');
  assert.equal(care.get(id).lastActivity.app, null);
});

test('same memory and profile: the WhatsApp turn lands in the person\'s own chat thread, no other profile sees it', async () => {
  clearCalls(); const a = linked(), b = linked(); reset(PLAIN);
  await wa.handleWebhook(incoming(a.phone, 'My granddaughter Priya visited.'));
  assert.ok(chat.thread(a.id).some((m) => m.role === 'senior' && /Priya/.test(m.text)));
  assert.ok(!chat.thread(b.id).some((m) => /Priya/.test(m.text)));
});

test('unknown number, not-opted-in number, and a repeated message id get no reply and cost nothing', async () => {
  clearCalls(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(incoming('447700900999', 'hello')), ['ignored']);
  assert.equal(sent().length, 0); assert.equal(asked.length, 0, 'no Spark call for a stranger');
  const { phone } = linked(); const p = incoming(phone, 'hello there');
  assert.deepEqual(await wa.handleWebhook(p), ['text']); assert.deepEqual(await wa.handleWebhook(p), ['duplicate']);
  assert.equal(sent().length, 1);
});

test('STOP opts out: one confirmation, then silence; the link needs a recorded opt-in to exist at all', async () => {
  clearCalls(); const { id, phone } = linked(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(incoming(phone, 'STOP')), ['text']);
  assert.equal(sent().length, 1); assert.match(sent()[0].text.body, /will not message you here again/);
  assert.equal(wa.view(id).optIn, false); clearCalls();
  assert.deepEqual(await wa.handleWebhook(incoming(phone, 'hello?')), ['ignored']); assert.equal(sent().length, 0);
  assert.throws(() => wa.link(senior(), newPhone(), false), /agreed/); assert.throws(() => wa.link(senior(), '12', true), /country code/);
  assert.throws(() => wa.link(id, phone.replace(/.$/, '0'), true) && wa.link(senior(), phone.replace(/.$/, '0'), true), /already belongs/);
});

test('scam text on WhatsApp: same warning path, ONE family question, nothing sent to family until yes, then the dashboard flag', async () => {
  clearCalls(); const { id, phone } = linked();
  chat.deps.scamText = async () => ({ level: 'warn', type: 'impersonation scam', reading: 'Someone says they are from the bank and wants a code.', signals: sig('impersonation', 'payment'), reads: rd(), count: 2 });
  reset(WARN);
  await wa.handleWebhook(incoming(phone, 'A lady rang from my bank and wants me to read out the code from my text.'));
  assert.match(asked.at(-1).roster, /SCAM CHECK \(a fact from the app, not from them\)/);
  assert.match(sent()[0].text.body, /scam/i); assert.match(sent()[0].text.body, /family/i);
  assert.equal(care.scamPending(id).type, 'impersonation scam'); assert.equal(care.view(id).scams.length, 0, 'no ticket before the yes');
  chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: sig(), reads: rd(), count: 0 });
  reset(PLAIN); await wa.handleWebhook(incoming(phone, 'Yes, tell my family please'));
  const sc = care.view(id).scams; assert.equal(sc.length, 1); assert.equal(sc[0].level, 'alert');
  const note = care.get(id).notifications.find((x) => x.to === 'family');
  assert.ok(note && !/bank|code|lady/i.test(note.text), 'the family note is topic-only, never her words');
});

test('no live call claim: a reply that promises to ring or call is replaced by the plain truth', async () => {
  clearCalls(); const { phone } = linked(); reset(CALLS);
  await wa.handleWebhook(incoming(phone, 'Can we talk about it?'));
  assert.equal(sent()[0].text.body, wa.NO_CALL_LINE); assert.doesNotMatch(sent()[0].text.body, /I will call/);
  for (const ok of ['I am glad you called your sister.', 'Your daughter called you today, how nice.', 'It is a good idea to call the bank yourself.']) assert.equal(wa.mayaWords(ok), ok);
  for (const bad of ['I will call you tomorrow.', "I'll ring you in a minute.", 'Let me call you back.', 'Calling you now.', 'Shall I video call you?']) assert.equal(wa.mayaWords(bad), wa.NO_CALL_LINE, bad);
});

test('no transcript leak: the token and the person\'s words are in nothing but the one reply path (no log, no family record)', async () => {
  clearCalls(); const { id, phone } = linked(); reset(PLAIN);
  const logs = []; const orig = { log: console.log, error: console.error }; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try { await wa.handleWebhook(incoming(phone, 'My secret sentence about tulips.')); graphFail = { code: 131030, message: 'Recipient phone number not in allowed list' }; reset(PLAIN); await wa.handleWebhook(incoming(phone, 'Another tulips sentence.')); }
  finally { console.log = orig.log; console.error = orig.error; }
  assert.ok(!logs.join('\n').match(/tulips|TEST-TOKEN/), 'nothing is logged');
  assert.ok(logs.join('\n').match(/131030/), 'a Meta refusal is logged as a code and a reason, not hidden');
  assert.ok(!JSON.stringify(care.view(id)).match(/tulips/), 'the family view has no words');
  assert.ok(!fs.readFileSync(path.join(process.env.MAYA_WA_DIR, 'links.json'), 'utf8').match(/tulips/), 'the WhatsApp store has no words');
  clearCalls();
});

test('a failed Graph send is an error, never a fake success; unset WhatsApp env refuses plainly', async () => {
  clearCalls(); graphFail = { code: 190, message: 'Access token has expired' };
  await assert.rejects(wa.sendTextTo('447700900001', 'hi'), (e) => e.code === 190 && /190/.test(e.message) && !/TEST-TOKEN/.test(e.message));
  clearCalls(); const t = process.env.WHATSAPP_TOKEN; delete process.env.WHATSAPP_TOKEN;
  await assert.rejects(wa.sendTextTo('447700900001', 'hi'), /not set up/); process.env.WHATSAPP_TOKEN = t;
});
