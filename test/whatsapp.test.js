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
const oggopus = require('../oggopus');

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

// Graph stub: records every call, answers like Meta (media lookup, media download, upload, send).
const graphCalls = [];
let graphFail = null, outN = 0;
const inboundMedia = new Map(); // media id -> Buffer (what WhatsApp would hold for a voice note)
let callHook = null, callFail = null; // calls tests: a hook run on each POST to /calls, and per-action Meta failures
wa.deps.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  graphCalls.push({ url, opts, body });
  if (body && /\/calls$/.test(url)) { if (callFail && callFail[body.action]) return { ok: false, status: 400, json: async () => ({ error: callFail[body.action] }) }; if (callHook) await callHook(body); }
  const done = (data) => ({ ok: true, status: 200, json: async () => data, arrayBuffer: async () => data });
  if (graphFail) return { ok: false, status: 400, json: async () => ({ error: graphFail }) };
  if (/^https:\/\/lookaside\.test\//.test(url)) return done(Uint8Array.from(inboundMedia.get(url.split('/').pop())).buffer);
  const m = /graph\.facebook\.com\/v[\d.]+\/(\d+|wamid[\w.]*|MEDIA[\w]*)$/.exec(url);
  if (m && !opts.method) return done({ url: `https://lookaside.test/${m[1]}`, mime_type: 'audio/ogg; codecs=opus', file_size: inboundMedia.get(m[1]).length, id: m[1] });
  if (/\/media$/.test(url)) return done({ id: `MEDIAUP${graphCalls.length}` });
  return done({ messages: [{ id: `wamid.out${++outN}` }] });
};
const sent = () => graphCalls.filter((c) => /\/messages$/.test(c.url)).map((c) => c.body);
const uploads = () => graphCalls.filter((c) => /\/media$/.test(c.url));
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

// ------------------------------------------------------------------------------------------ step 2: voice notes
const tone = (sec = 1) => { const N = 24000 * sec, b = Buffer.alloc(N * 2); for (let i = 0; i < N; i++) b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 300 * i / 24000)), i * 2); return b; };
let mediaN = 0;
const voiceIn = (from, mime = 'audio/ogg; codecs=opus', ogg = oggopus.encode(tone(1))) => {
  const id = `MEDIAIN${mediaN++}`; inboundMedia.set(id, ogg);
  return incoming(from, '', { type: 'audio', text: undefined, audio: { id, mime_type: mime, voice: true } });
};
const heard = []; let transcript = 'I made some soup today.';
chat.deps.transcribe = async (wav) => { heard.push(wav); return transcript; };
const spoken = []; let speakFail = false;
chat.deps.speak = async (t) => { spoken.push(t); if (speakFail) throw new Error('voice is down'); return tone(1); };
const voiceReset = () => { clearCalls(); heard.length = 0; spoken.length = 0; speakFail = false; transcript = 'I made some soup today.'; };

test('incoming voice note -> Transcribe gets a real WAV -> the same Maya -> a voice note back (uploaded Ogg/Opus, voice:true), same ElevenLabs voice path as the app', async () => {
  voiceReset(); const { id, phone } = linked(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(voiceIn(phone)), ['voice']);
  assert.equal(heard.length, 1); assert.ok(chat.isWav(heard[0]));
  assert.ok(Math.abs(heard[0].length - 44 - 48000) < 4000, 'about one second of 24 kHz audio reached Transcribe');
  assert.match(asked[0].history.at(-1).content, /soup/, 'the transcript reached Spark');
  assert.ok(spoken.length > 0, 'the reply was spoken through the same speak() the app uses');
  const up = uploads(); assert.equal(up.length, 1); assert.equal(up[0].opts.headers.Authorization, 'Bearer TEST-TOKEN-NOT-REAL');
  const file = up[0].opts.body.get('file'); assert.equal(up[0].opts.body.get('messaging_product'), 'whatsapp'); assert.match(file.type, /^audio\/ogg; codecs=opus$/);
  const ogg = Buffer.from(await file.arrayBuffer()); assert.equal(ogg.toString('latin1', 0, 4), 'OggS'); assert.equal(ogg.toString('latin1', 28, 36), 'OpusHead'); assert.equal(ogg[28 + 9], 1, 'mono');
  assert.ok(ogg.length <= oggopus.MAX_PLAY_BYTES);
  const out = sent(); assert.equal(out.length, 1); assert.equal(out[0].type, 'audio'); assert.equal(out[0].to, phone); assert.equal(out[0].audio.voice, true); assert.match(out[0].audio.id, /^MEDIAUP/);
  assert.equal(out[0].text, undefined, 'a voice reply is not also sent as text');
  assert.ok(care.get(id).lastActivity.whatsapp); assert.ok(chat.thread(id).some((m) => m.role === 'senior' && m.kind === 'voice'));
});

test('voice reply is short and decodes back to speech (Ogg/Opus both ways)', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN);
  await wa.handleWebhook(voiceIn(phone));
  const ogg = Buffer.from(await uploads()[0].opts.body.get('file').arrayBuffer());
  const pcm = await oggopus.decode(ogg, 24000);
  assert.ok(pcm.length / 2 > 20000 && pcm.length / 2 < 60000, 'about the length that was spoken');
  let e = 0; for (let i = 0; i < pcm.length; i += 2) e += Math.abs(pcm.readInt16LE(i)); assert.ok(e / (pcm.length / 2) > 3000, 'it carries sound, not silence');
});

test('voice reply too big for the play icon (512 KB) goes out as the same words in text, not a download-icon file', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN);
  const keep = chat.deps.speak; chat.deps.speak = async () => tone(200);
  try { assert.deepEqual(await wa.handleWebhook(voiceIn(phone)), ['text-reply']); } finally { chat.deps.speak = keep; }
  assert.equal(sent()[0].type, 'text'); assert.match(sent()[0].text.body, /That sounds nice/); assert.equal(uploads().length, 0);
});

test('Maya\'s voice failing: the words go out as text, never a fake or empty voice note', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN); speakFail = true;
  assert.deepEqual(await wa.handleWebhook(voiceIn(phone)), ['text-reply']);
  assert.equal(uploads().length, 0); assert.equal(sent()[0].type, 'text'); assert.match(sent()[0].text.body, /That sounds nice/);
});

test('voice note with no words, an unreadable file, a non-Ogg file: one plain truthful text, no Spark call', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN); transcript = '';
  assert.deepEqual(await wa.handleWebhook(voiceIn(phone)), ['unheard']); assert.match(sent()[0].text.body, /could not hear any words/); assert.equal(asked.length, 0);
  voiceReset(); const bad = Buffer.from('this is not audio at all, just some bytes padded out to be long enough');
  const m = voiceIn(phone, 'audio/ogg; codecs=opus', bad);
  const errs = []; const e0 = console.error; console.error = (...a) => errs.push(a.join(' '));
  try { assert.deepEqual(await wa.handleWebhook(m), ['unreadable']); } finally { console.error = e0; }
  assert.match(sent()[0].text.body, /could not hear that voice note/); assert.equal(heard.length, 0);
  voiceReset(); assert.deepEqual(await wa.handleWebhook(voiceIn(phone, 'audio/mpeg')), ['unsupported']); assert.equal(heard.length, 0); assert.equal(sent().length, 1);
});

test('voice note from an unknown or opted-out number: ignored before anything is downloaded', async () => {
  voiceReset(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(voiceIn('447700900998')), ['ignored']);
  assert.equal(graphCalls.length, 0, 'no download, no upload, no send'); assert.equal(heard.length, 0);
});

test('scam voice note on WhatsApp: same warning, the family question comes back as a voice note, yes -> the dashboard flag (topic only)', async () => {
  voiceReset(); const { id, phone } = linked();
  chat.deps.scamText = async () => ({ level: 'warn', type: 'impersonation scam', reading: 'Someone says they are from the bank and wants a code.', signals: sig('impersonation', 'payment'), reads: rd(), count: 2 });
  transcript = 'A lady rang from my bank and wants me to read out the code from my text.'; reset(WARN);
  assert.deepEqual(await wa.handleWebhook(voiceIn(phone)), ['voice']);
  assert.match(asked.at(-1).roster, /SCAM CHECK \(a fact from the app, not from them\)/);
  assert.ok(spoken.some((t) => /family/i.test(t)), 'the spoken reply asks about the family'); assert.equal(care.scamPending(id).channel, 'spoken');
  assert.equal(care.view(id).scams.length, 0);
  chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: sig(), reads: rd(), count: 0 });
  voiceReset(); transcript = 'Yes, tell my family please'; reset(PLAIN); await wa.handleWebhook(voiceIn(phone));
  assert.equal(care.view(id).scams.length, 1); assert.equal(care.view(id).scams[0].level, 'alert');
  assert.ok(!/bank|code|lady/i.test(care.get(id).notifications.find((x) => x.to === 'family').text));
});

test('no live call claim in a voice reply: replaced by the plain truth, sent as text', async () => {
  voiceReset(); const { phone } = linked(); reset(CALLS);
  assert.deepEqual(await wa.handleWebhook(voiceIn(phone)), ['text-reply']);
  assert.equal(sent()[0].type, 'text'); assert.equal(sent()[0].text.body, wa.NO_CALL_LINE); assert.equal(uploads().length, 0);
});

test('a failed media download is an error in the log (code and reason), never a made-up answer', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN); graphFail = { code: 100, message: 'Media gone' };
  const logs = []; const e0 = console.error; console.error = (...a) => logs.push(a.join(' '));
  try { const r = await wa.handleWebhook(voiceIn(phone)); assert.deepEqual(r, ['error']); } finally { console.error = e0; }
  assert.equal(heard.length, 0); assert.ok(logs.join('').match(/100/));
});

test('the Ogg muxer: valid pages (CRC), mono OpusHead, granule counts the audio', () => {
  const ogg = oggopus.encode(tone(1)); let off = 0, pages = 0, last;
  while (off < ogg.length) {
    assert.equal(ogg.toString('latin1', off, off + 4), 'OggS'); const nseg = ogg[off + 26]; let body = 0; for (let i = 0; i < nseg; i++) body += ogg[off + 27 + i];
    const len = 27 + nseg + body, pg = Buffer.from(ogg.subarray(off, off + len)), crc = pg.readUInt32LE(22); pg.writeUInt32LE(0, 22);
    let c = 0; for (const b of pg) { c = ((c << 8) ^ CRCT[((c >>> 24) ^ b) & 0xff]) >>> 0; } assert.equal(c, crc, 'page CRC'); last = ogg.subarray(off, off + len); off += len; pages++;
  }
  assert.ok(pages >= 3); assert.equal(last[5], 0x04, 'last page is flagged end of stream'); assert.equal(Number(last.readBigUInt64LE(6)), 48000 + 312);
});
const CRCT = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t[i] = r >>> 0; } return t; })();

// ------------------------------------------------------------------------------------------ step 3: outgoing from the dashboard
const LF = () => path.join(process.env.MAYA_WA_DIR, 'links.json');
const shift = (id, ms) => { const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); for (const m of all[id].sent || []) m.at -= ms; fs.writeFileSync(LF(), JSON.stringify(all)); }; // time passes
const setInbound = (id, ago) => { const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[id].lastInboundAt = ago === null ? null : Date.now() - ago; fs.writeFileSync(LF(), JSON.stringify(all)); };
const H = 3600 * 1000;
const inWindow = () => { const x = linked(); setInbound(x.id, 2 * H); return x; };
const outside = () => { const x = linked(); setInbound(x.id, 25 * H); return x; };
const refusal = async (p, re, props = {}) => { await assert.rejects(p, (e) => re.test(e.message) && Object.entries(props).every(([k, v]) => e[k] === v)); };

test('dashboard text inside the 24 h window: one Graph text to the linked number, announced as the family\'s, status words come back from Meta', async () => {
  voiceReset(); const { id, phone } = inWindow();
  assert.deepEqual(await wa.sendOut(id, { kind: 'text', text: 'Thinking of you, call me later!' }), { sent: true, via: 'free', kind: 'text' });
  const o = sent(); assert.equal(o.length, 1); assert.equal(o[0].type, 'text'); assert.equal(o[0].to, phone); assert.equal(o[0].text.body, `${wa.FAMILY_PREFIX}Thinking of you, call me later!`);
  assert.equal(wa.view(id).lastSent.status, 'sent'); assert.equal(wa.view(id).windowOpen, true);
  const wamid = JSON.parse(fs.readFileSync(LF(), 'utf8'))[id].sent[0].id; assert.match(wamid, /^wamid\.out/);
  const status = (st, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1409237678935671' }, statuses: [{ id: wamid, status: st, recipient_id: phone, ...extra }] } }] }] });
  await wa.handleWebhook(status('delivered')); assert.equal(wa.view(id).lastSent.status, 'delivered');
  await wa.handleWebhook(status('read')); assert.equal(wa.view(id).lastSent.status, 'read');
  await wa.handleWebhook(status('delivered')); assert.equal(wa.view(id).lastSent.status, 'read', 'a late delivered never lowers read');
  await wa.handleWebhook(status('failed', { errors: [{ code: 131047, title: 'Re-engagement message' }] })); assert.deepEqual(wa.view(id).lastSent, { ...wa.view(id).lastSent, status: 'failed', error: { code: 131047, title: 'Re-engagement message' } });
  assert.equal(sent().length, 1, 'a status never makes Maya reply');
});

test('a dashboard voice note logs how many characters went to speech and how many seconds of audio came back; never the words', async () => {
  voiceReset(); const { id } = inWindow();
  const out = await capture(() => wa.sendOut(id, { kind: 'voice', text: 'Happy birthday tulips Mum' }));
  assert.match(out, new RegExp(`voice note made: ${(wa.FAMILY_PREFIX + 'Happy birthday tulips Mum').length} characters sent to speech, 1\\.0 s of audio`));
  assert.doesNotMatch(out, /tulips|birthday/); clearCalls();
});

test('dashboard voice note inside the window: Maya\'s voice reads the words (announced as the family\'s), uploaded as Ogg/Opus, sent as audio voice:true', async () => {
  voiceReset(); const { id, phone } = inWindow();
  assert.deepEqual(await wa.sendOut(id, { kind: 'voice', text: 'Happy birthday Mum' }), { sent: true, via: 'free', kind: 'voice' });
  assert.deepEqual(spoken, [`${wa.FAMILY_PREFIX}Happy birthday Mum`]);
  const ogg = Buffer.from(await uploads()[0].opts.body.get('file').arrayBuffer()); assert.equal(ogg.toString('latin1', 0, 4), 'OggS');
  assert.equal(sent()[0].type, 'audio'); assert.equal(sent()[0].audio.voice, true); assert.equal(sent()[0].to, phone);
});

test('opt-in guard: not linked, never opted in, or STOPped -> refused, nothing reaches Meta', async () => {
  voiceReset(); const none = senior();
  await refusal(wa.sendOut(none, { kind: 'text', text: 'hi' }), /no WhatsApp number linked/, { status: 409 });
  const { id, phone } = inWindow(); reset(PLAIN);
  await wa.handleWebhook(incoming(phone, 'STOP')); clearCalls();
  await refusal(wa.sendOut(id, { kind: 'text', text: 'hi' }), /not agreed|stopped/, { status: 403 });
  await refusal(wa.sendOut(id, { kind: 'text', text: 'hi' }, 'x'), /not agreed|stopped/);
  assert.equal(graphCalls.length, 0);
  assert.throws(() => wa.link(senior(), newPhone(), undefined), /agreed/);
});

test('24 h window guard: outside it a free text is refused (and says so), a voice note is refused; nothing reaches Meta', async () => {
  voiceReset(); const { id } = outside();
  await refusal(wa.sendOut(id, { kind: 'text', text: 'Are you ok?' }), /24 hours/, { status: 409, needsTemplate: true, windowClosed: true });
  await refusal(wa.sendOut(id, { kind: 'voice', text: 'Are you ok?' }), /voice note/, { status: 409, windowClosed: true });
  const never = linked(); // has never written at all
  await refusal(wa.sendOut(never.id, { kind: 'text', text: 'hi' }), /24 hours/, { needsTemplate: true });
  assert.equal(graphCalls.length, 0); assert.equal(wa.view(id).windowOpen, false);
  setInbound(id, 23 * H); assert.equal(wa.view(id).windowOpen, true, 'a message 23 h ago keeps the window open');
});

test('template guard: outside the window only the approved template goes out (never the family\'s own words), at most twice a day', async () => {
  voiceReset(); const { id, phone } = outside();
  assert.deepEqual(await wa.sendOut(id, { kind: 'text', text: 'my own words must not leak into a template', useTemplate: true }), { sent: true, via: 'template', kind: 'template' });
  const t = sent()[0]; assert.equal(t.type, 'template'); assert.equal(t.to, phone); assert.deepEqual(t.template, { name: 'hello_world', language: { code: 'en_US' } });
  assert.ok(!JSON.stringify(t).match(/leak/));
  shift(id, 60000); await wa.sendOut(id, { kind: 'text', useTemplate: true });
  shift(id, 60000); await refusal(wa.sendOut(id, { kind: 'text', useTemplate: true }), /already sent today/, { status: 429 });
  assert.equal(sent().length, 2);
  process.env.WHATSAPP_TEMPLATE_NAME = 'maya_checkin'; process.env.WHATSAPP_TEMPLATE_LANG = 'en_GB'; const o = outside(); clearCalls();
  try { await wa.sendOut(o.id, { kind: 'text', useTemplate: true }); assert.deepEqual(sent()[0].template, { name: 'maya_checkin', language: { code: 'en_GB' } }); }
  finally { delete process.env.WHATSAPP_TEMPLATE_NAME; delete process.env.WHATSAPP_TEMPLATE_LANG; }
  const back = inWindow(); await wa.sendOut(back.id, { kind: 'text', text: 'free text still works inside', useTemplate: true }); assert.equal(sent().at(-1).type, 'text', 'inside the window a template is never used');
});

test('spam guard: too soon, two at once, and the daily cap are refused; a failed send gives its slot back', async () => {
  voiceReset(); const { id } = inWindow();
  await wa.sendOut(id, { kind: 'text', text: 'one' });
  await refusal(wa.sendOut(id, { kind: 'text', text: 'two' }), /too soon/, { status: 429 }); assert.equal(sent().length, 1);
  shift(id, 60000);
  const both = await Promise.allSettled([wa.sendOut(id, { kind: 'text', text: 'a' }), wa.sendOut(id, { kind: 'text', text: 'b' })]);
  assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']); assert.equal(sent().length, 2);
  for (let i = 0; i < 20 && sent().length < 10; i++) { shift(id, 60000); await wa.sendOut(id, { kind: 'text', text: `m${i}` }); }
  assert.equal(sent().length, 10); shift(id, 60000);
  await refusal(wa.sendOut(id, { kind: 'text', text: 'eleven' }), /Enough messages for today/, { status: 429 }); assert.equal(sent().length, 10);
  const other = inWindow(); await wa.sendOut(other.id, { kind: 'text', text: 'another person is not limited by the first' });
  voiceReset(); const f = inWindow(); graphFail = { code: 131047, message: 'Re-engagement message' };
  await refusal(wa.sendOut(f.id, { kind: 'text', text: 'x' }), /131047/, { code: 131047 });
  graphFail = null; await wa.sendOut(f.id, { kind: 'text', text: 'right after a failure is fine, the slot was given back' });
  assert.equal(JSON.parse(fs.readFileSync(LF(), 'utf8'))[f.id].sent.length, 1, 'only the send that worked is kept');
});

test('never a live call: only text, audio and template ever leave; a call promise from the dashboard is refused; the module has no call function', async () => {
  voiceReset(); const { id } = inWindow();
  await refusal(wa.sendOut(id, { kind: 'text', text: 'I will call you in a minute' }), /cannot promise a call/, { status: 400 });
  await wa.sendOut(id, { kind: 'text', text: 'Your daughter called you earlier, she says hello' });
  shift(id, 60000); await wa.sendOut(id, { kind: 'voice', text: 'ok' });
  const o = outside(); shift(o.id, 1); await wa.sendOut(o.id, { kind: 'text', useTemplate: true });
  assert.ok(sent().length >= 3 && sent().every((b) => ['text', 'audio', 'template'].includes(b.type)));
  assert.deepEqual(Object.keys(wa).filter((k) => typeof wa[k] === 'function' && /call|ring|dial|video/i.test(k)), ['placeTestCall']); // the one test call (C1) is the only exception, and it never sends a message
  await refusal(wa.sendOut(id, { kind: 'call', text: 'x' }), /text message or a voice note/, { status: 400 });
  await refusal(wa.sendOut(id, { kind: 'text', text: 'x', who: 'stranger' }), /Bad sender/);
});

test('voice from the dashboard: a voice failure or an over-long note sends nothing and says so', async () => {
  voiceReset(); const { id } = inWindow(); speakFail = true;
  await refusal(wa.sendOut(id, { kind: 'voice', text: 'hello' }), /voice could not be made/, { status: 502 }); assert.equal(graphCalls.length, 0);
  speakFail = false; const keep = chat.deps.speak; chat.deps.speak = async () => tone(200);
  try { await refusal(wa.sendOut(id, { kind: 'voice', text: 'hello' }), /too long for a voice note/, { status: 400 }); } finally { chat.deps.speak = keep; }
  assert.equal(graphCalls.length, 0); await wa.sendOut(id, { kind: 'text', text: 'a failed voice note did not use up the slot' });
});

// ------------------------------------------------------------------------------------------ diagnosis log lines
const capture = async (fn) => { const logs = []; const l0 = console.log, e0 = console.error; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' ')); try { await fn(); } finally { console.log = l0; console.error = e0; } return logs.join('\n'); };

test('every drop leaves one plain log line with the reason, the last 4 digits only, never a word or the full number', async () => {
  voiceReset(); reset(PLAIN);
  let out = await capture(() => wa.handleWebhook(incoming('919876548237', 'My secret tulips sentence')));
  assert.match(out, /ignored a text from number ending 8237: no profile is linked/); assert.doesNotMatch(out, /tulips|919876548237|9876548237/);
  const { phone } = linked(); const p = incoming(phone, 'hello there');
  out = await capture(() => wa.handleWebhook(p)); assert.match(out, new RegExp(`received a text from number ending ${phone.slice(-4)}`)); assert.match(out, /replied to number ending/);
  out = await capture(() => wa.handleWebhook(p)); assert.match(out, /repeated message .* \(Meta retry\)/);
  reset(PLAIN); await wa.handleWebhook(incoming(phone, 'STOP'));
  out = await capture(() => wa.handleWebhook(incoming(phone, 'hello again'))); assert.match(out, /has not opted in or has stopped/);
  const other = incoming(phone, 'x'); other.entry[0].changes[0].value.metadata.phone_number_id = '999';
  out = await capture(() => wa.handleWebhook(other)); assert.match(out, /different phone number id than WHATSAPP_PHONE_ID/);
  out = await capture(() => wa.handleWebhook(voiceIn('919876548237'))); assert.match(out, /ignored a audio from number ending 8237/);
  clearCalls();
});

test('every webhook POST that arrives leaves one line (size, signature present / valid), and each change says its field, phone id (last 4) and counts; no words, no numbers', async () => {
  voiceReset(); const { phone } = linked(); const raw = Buffer.from(JSON.stringify(incoming(phone, 'my private tulips words')));
  const good = `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex')}`;
  let out = await capture(async () => wa.noteArrival(raw, good)); assert.match(out, /webhook POST arrived: \d+ bytes, X-Hub-Signature-256 present, WHATSAPP_APP_SECRET set, signature valid/);
  out = await capture(async () => wa.noteArrival(raw, `sha256=${'0'.repeat(64)}`)); assert.match(out, /present, .* signature INVALID/);
  out = await capture(async () => wa.noteArrival(raw, undefined)); assert.match(out, /Signature-256 missing, .* INVALID/);
  out = await capture(() => wa.handleWebhook(incoming(phone, 'my private tulips words'))); assert.match(out, /webhook change: field messages, phone id ending 5671, 1 message\(s\), 0 status update\(s\)/);
  out = await capture(() => wa.handleWebhook({ object: 'page', entry: [] })); assert.match(out, /object is not whatsapp_business_account/);
  assert.doesNotMatch(out, /tulips|TEST-TOKEN/); clearCalls();
});

// ---- photos in (onImage) ----
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(200, 7)]);
const imageIn = (from, bytes = JPEG, caption, type = 'image') => {
  const id = `MEDIAIN${mediaN++}`; if (bytes) inboundMedia.set(id, bytes);
  return incoming(from, '', { type, text: undefined, [type]: { id, mime_type: 'image/jpeg', ...(caption ? { caption } : {}) } });
};
const seenPhotos = []; const noScam = async () => ({ level: 'none', type: 'none', reading: '', signals: sig(), reads: rd(), count: 0 });
chat.deps.describe = async (buf) => { seenPhotos.push(buf); return 'A cup of tea on a table next to two biscuits.'; };
chat.deps.scam = noScam;
const DECLINE = 'I can read your typed messages and listen to voice notes here. Please type it or send a voice note.';

test('photo in: the bytes and caption reach chat.sendImage, Maya\'s reply goes back as ONE text message, and the photo is in the family thread', async () => {
  voiceReset(); seenPhotos.length = 0; const { id, phone } = linked(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(imageIn(phone, JPEG, 'my afternoon tea')), ['image']);
  assert.equal(seenPhotos.length, 1); assert.ok(seenPhotos[0].equals(JPEG));
  assert.match(asked[0].history.at(-1).content, /photo shows: A cup of tea.*my afternoon tea/);
  const out = sent(); assert.equal(out.length, 1); assert.equal(out[0].type, 'text'); assert.equal(out[0].to, phone); assert.match(out[0].text.body, /That sounds nice/);
  assert.ok(chat.thread(id).some((m) => m.role === 'senior' && m.kind === 'image' && m.text === 'my afternoon tea'));
  assert.ok(care.get(id).lastActivity.whatsapp);
});

test('photo in with no caption works', async () => {
  voiceReset(); seenPhotos.length = 0; const { id, phone } = linked(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(imageIn(phone)), ['image']);
  assert.equal(sent().length, 1); assert.ok(chat.thread(id).some((m) => m.kind === 'image' && m.text === ''));
});

test('photo from an unlinked number, an opted-out number, or a Meta retry is never downloaded or answered twice', async () => {
  voiceReset(); seenPhotos.length = 0; const { phone } = linked(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(imageIn('919876548237')), ['ignored']);
  const p = imageIn(phone); assert.deepEqual(await wa.handleWebhook(p), ['image']); clearCalls();
  assert.deepEqual(await wa.handleWebhook(p), ['duplicate']); assert.equal(graphCalls.length, 0, 'a retry does not download or send anything');
  await wa.handleWebhook(incoming(phone, 'STOP')); clearCalls(); seenPhotos.length = 0;
  assert.deepEqual(await wa.handleWebhook(imageIn(phone)), ['ignored']); assert.equal(graphCalls.length, 0); assert.equal(seenPhotos.length, 0);
});

test('photo the scam check marks as a warning gets the same handling as in the app (warning words, never a fake verdict)', async () => {
  voiceReset(); const { id, phone } = linked(); reset(WARN);
  chat.deps.scam = async () => ({ level: 'warn', type: 'impersonation scam', reading: 'A text pretending to be the bank asks for a code.', signals: sig('impersonation', 'payment'), reads: rd(), count: 2 });
  try { assert.deepEqual(await wa.handleWebhook(imageIn(phone, JPEG, 'is this ok')), ['image']); } finally { chat.deps.scam = noScam; }
  const out = sent(); assert.equal(out.length, 1); assert.equal(out[0].type, 'text'); assert.match(out[0].text.body, /scam/i);
  assert.match(asked[0].roster, /scam|warn/i); assert.ok(chat.thread(id).some((m) => m.role === 'maya' && /scam/i.test(m.text)));
});

test('sticker, document and location still get the existing decline, word for word, and are never downloaded', async () => {
  voiceReset(); const { phone } = linked();
  for (const type of ['sticker', 'document']) {
    clearCalls(); assert.deepEqual(await wa.handleWebhook(imageIn(phone, JPEG, undefined, type)), ['unsupported']);
    assert.deepEqual(sent().map((m) => m.text.body), [DECLINE]); assert.equal(graphCalls.filter((c) => !/\/messages$/.test(c.url)).length, 0);
  }
  clearCalls(); assert.deepEqual(await wa.handleWebhook(incoming(phone, '', { type: 'location', text: undefined, location: { latitude: 1, longitude: 2 } })), ['unsupported']);
  assert.deepEqual(sent().map((m) => m.text.body), [DECLINE]);
});

test('photo failures are answered in plain words: too big and download failure -> could not see; not an image -> could not read; vision error -> could not see; nothing crashes', async () => {
  voiceReset(); seenPhotos.length = 0; const { phone } = linked(); reset(PLAIN);
  const SEE = 'I could not see that photo. Could you send it again?', READ = 'I could not read that file as a photo. Please send it again.';
  const words = () => sent().map((m) => m.text.body);
  assert.deepEqual(await wa.handleWebhook(imageIn(phone, Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]))), ['unseen']); assert.deepEqual(words(), [SEE]); assert.equal(seenPhotos.length, 0, 'too big never reaches sendImage');
  clearCalls(); assert.deepEqual(await wa.handleWebhook(imageIn(phone, null)), ['unseen']); assert.deepEqual(words(), [SEE]);
  clearCalls(); assert.deepEqual(await wa.handleWebhook(imageIn(phone, Buffer.from('this is plain text, not a picture at all'))), ['unreadable']); assert.deepEqual(words(), [READ]);
  clearCalls(); const keep = chat.deps.describe; chat.deps.describe = async () => { throw new Error('Meta vision failed (HTTP 400)'); };
  try { assert.deepEqual(await wa.handleWebhook(imageIn(phone)), ['unseen']); } finally { chat.deps.describe = keep; }
  assert.deepEqual(words(), [SEE]);
});

test('a voice note over 2 MB keeps the old limit and the old wording', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN);
  assert.deepEqual(await wa.handleWebhook(voiceIn(phone, 'audio/ogg; codecs=opus', Buffer.alloc(2 * 1024 * 1024 + 1))), ['unreadable']);
  assert.deepEqual(sent().map((m) => m.text.body), ['I could not hear that voice note. Could you send it again, or type it for me?']);
});

test('photo logs: last 4 digits and a result only; never the caption, the image or the full number', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN);
  let out = await capture(() => wa.handleWebhook(imageIn(phone, JPEG, 'my private tulips caption')));
  assert.match(out, new RegExp(`received a image from number ending ${phone.slice(-4)}`)); assert.match(out, /answered a photo from number ending/);
  assert.doesNotMatch(out, /tulips|TEST-TOKEN/); assert.ok(!out.includes(phone));
  clearCalls(); out = await capture(() => wa.handleWebhook(imageIn(phone, Buffer.from('not a picture, tulips')))); assert.match(out, /could not answer a photo from number ending/); assert.doesNotMatch(out, /tulips/);
});

// ---- calls in: the intro and a listening test for the linked person (wacall.js, waears.js), a refusal for everyone else ----
const { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useOPUS } = require('werift');
const SDP = 'v=0 o=- 4611731400430051336 2 IN IP4 127.0.0.1 SECRET-SDP-LINES';
const callIn = (person, { event = 'connect', direction = 'USER_INITIATED', swap = false, sdp = SDP, extra = {} } = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15556408264', phone_number_id: '1409237678935671' }, contacts: [{ profile: { name: 'x' }, wa_id: person }], calls: [{ id: `wacid.TESTCALL${mid++}ABCD==`, from: swap ? '15556408264' : person, to: swap ? person : '15556408264', event, direction, timestamp: '1700000000', ...(event === 'connect' ? { session: { sdp_type: 'offer', sdp } } : {}), ...extra }] } }] }] });
const callPosts = () => graphCalls.filter((c) => /\/calls$/.test(c.url)).map((c) => c.body);
const rejects = () => callPosts().filter((b) => b.action === 'reject');
const callIdOf = (p) => p.entry[0].changes[0].value.calls[0].id;
// A stand-in for the answerer, so these tests do not open a real media connection.
const withAnswer = async (stub, fn) => { const keep = wa.deps.answerCall; wa.deps.answerCall = stub; try { return await fn(); } finally { wa.deps.answerCall = keep; } };

test('a call from a linked, opted-in person is handed to the answerer with its offer, and logged as answered', async () => {
  voiceReset(); const { phone } = linked(); const p = callIn(phone); const seen = [];
  const out = await capture(() => withAnswer(async (o) => { seen.push(o); await o.send('accept', { sdp_type: 'answer', sdp: 'x' }); o.log('hello'); return 'completed'; }, async () => assert.deepEqual(await wa.handleWebhook(p), ['answered'])));
  assert.equal(seen.length, 1); assert.equal(seen[0].offerSdp, SDP);
  const posts = callPosts(); assert.equal(posts.length, 1); assert.match(graphCalls.find((c) => /\/calls$/.test(c.url)).url, /\/v\d+\.\d+\/1409237678935671\/calls$/);
  assert.deepEqual(posts[0], { messaging_product: 'whatsapp', call_id: callIdOf(p), action: 'accept', session: { sdp_type: 'answer', sdp: 'x' } });
  assert.match(out, /answered call [0-9a-f]{6} from number ending \d{4}: conversation, completed/); assert.equal(sent().length, 0, 'a call sends no message');
});

test('a call from an unlinked number, or from someone who opted out, is refused with the reason and never reaches the answerer', async () => {
  voiceReset(); const { phone } = linked(); let reached = 0; const stub = async () => { reached++; return 'completed'; };
  await withAnswer(stub, async () => {
    let out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn('919876548237')), ['rejected']));
    assert.match(out, /rejected call [0-9a-f]{6} from number ending 8237: no profile is linked/); assert.equal(rejects().length, 1);
    const p = callIn('919876548237'); clearCalls(); await wa.handleWebhook(p); assert.deepEqual(rejects().map((b) => b.call_id), [callIdOf(p)]);
    await wa.handleWebhook(incoming(phone, 'STOP')); clearCalls();
    out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone)), ['rejected']));
    assert.match(out, /has not opted in or has stopped/); assert.equal(rejects().length, 1);
  });
  assert.equal(reached, 0);
});

test('the person is found whichever way from / to point (the docs\' samples disagree); a call with no readable person is refused', async () => {
  voiceReset(); const { phone } = linked(); let who = null;
  await withAnswer(async (o) => { who = 'answered'; o.log('x'); return 'completed'; }, async () => {
    const swapped = callIn(phone, { swap: true }); swapped.entry[0].changes[0].value.contacts = [];
    const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(swapped), ['answered']));
    assert.equal(who, 'answered'); assert.match(out, new RegExp(`with number ending ${phone.slice(-4)}: x`));
    const none = callIn(phone); none.entry[0].changes[0].value.contacts = []; none.entry[0].changes[0].value.calls[0].from = none.entry[0].changes[0].value.calls[0].to = 'x';
    clearCalls(); assert.deepEqual(await wa.handleWebhook(none), ['rejected']); assert.equal(rejects().length, 1);
  });
});

test('a connect without an SDP offer is refused; a Meta retry of the same connect is not answered twice; a second call while one is being answered is refused', async () => {
  voiceReset(); const { phone } = linked(); let n = 0, release; const hold = new Promise((r) => { release = r; });
  await withAnswer(async () => { n++; await hold; return 'completed'; }, async () => {
    const noSdp = callIn(phone); delete noSdp.entry[0].changes[0].value.calls[0].session;
    assert.deepEqual(await wa.handleWebhook(noSdp), ['rejected']); assert.equal(n, 0);
    const first = callIn(phone); const running = wa.handleWebhook(first);
    await new Promise((r) => setTimeout(r, 20)); assert.equal(n, 1);
    clearCalls(); assert.deepEqual(await wa.handleWebhook(first), ['duplicate']); assert.equal(graphCalls.length, 0, 'a retry sends nothing');
    const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone)), ['rejected'])); assert.match(out, /another call is being answered/); assert.equal(rejects().length, 1);
    release(); assert.deepEqual(await running, ['answered']);
  });
});

test('if the answerer fails the call is reported as not answered, with the error text only', async () => {
  voiceReset(); const { phone } = linked();
  const out = await capture(() => withAnswer(async () => { throw new Error('the media connection did not come up in 20 s'); }, async () => assert.deepEqual(await wa.handleWebhook(callIn(phone)), ['answer-failed'])));
  assert.match(out, /could NOT answer call [0-9a-f]{6} from number ending \d{4}: the media connection did not come up/);
  // and a real offer that is not an SDP at all makes the real answerer refuse the call
  clearCalls(); const bad = callIn(phone, { sdp: 'this is not an sdp SECRET-SDP-LINES' });
  const out2 = await capture(async () => assert.deepEqual(await wa.handleWebhook(bad), ['answer-failed']));
  assert.deepEqual(rejects().map((b) => b.call_id), [callIdOf(bad)]); assert.doesNotMatch(out2, /SECRET-SDP/);
});

test('call terminate is logged (status, duration, error code) and answered with nothing; other events and business-started calls are ignored', async () => {
  voiceReset(); const { phone } = linked();
  let out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone, { event: 'terminate', extra: { status: 'FAILED', duration: 0, errors: [{ code: 138023, message: 'Accepted but no media' }] } })), ['ended']));
  assert.match(out, /call ended: number ending \d{4}, call [0-9a-f]{6}, status FAILED, duration 0 s, error 138023/); assert.equal(graphCalls.length, 0);
  await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone, { direction: 'BUSINESS_INITIATED' })), ['ignored'])); assert.equal(graphCalls.length, 0);
  assert.deepEqual(await wa.handleWebhook(callIn(phone, { event: 'ringing' })), ['ignored']);
});

test('when Meta refuses the reject, it is logged as a message and nothing crashes', async () => {
  voiceReset(); graphFail = { code: 138000, message: 'Calling not enabled' };
  const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn('919876548237')), ['reject-failed']));
  assert.match(out, /could NOT reject call [0-9a-f]{6} from number ending 8237: WhatsApp refused it \(138000\)/); clearCalls();
});

test('call logs: field names and a short hash only; never the SDP, a full number, the call id or the token', async () => {
  voiceReset(); const { phone } = linked(); const p = callIn(phone); const id = callIdOf(p);
  const out = await capture(() => withAnswer(async (o) => { o.log('media connected'); return 'completed'; }, () => wa.handleWebhook(p)));
  assert.match(out, /call connect: USER_INITIATED from number ending \d{4}, call [0-9a-f]{6}, fields \[.*direction.*event.*id.*session.*\], session \[sdp, sdp_type\]/);
  assert.doesNotMatch(out, /SECRET-SDP|v=0|TEST-TOKEN|wacid/); assert.ok(!out.includes(phone)); assert.ok(!out.includes(id)); assert.ok(!out.includes('15556408264'));
});

test('an interactive message logs its type (an enum) and never the person\'s words', async () => {
  voiceReset(); const { phone } = linked(); reset(PLAIN);
  const m = incoming(phone, '', { type: 'interactive', text: undefined, interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'tulips' } } });
  const out = await capture(() => wa.handleWebhook(m)); assert.match(out, /received a interactive from number ending \d{4} \(interactive type button_reply\)/); assert.doesNotMatch(out, /tulips/);
  const odd = incoming(phone, '', { type: 'interactive', text: undefined, interactive: { type: 'Say tulips please!' } });
  assert.match(await capture(() => wa.handleWebhook(odd)), /interactive type unknown/);
  clearCalls();
});

// The real answerer against a real WebRTC peer in this process (a stand-in for WhatsApp, with an offer shaped like Meta's documented ones) and a stand-in for the Meta engine.
const wacall = require('../wacall'), waears = require('../waears'), wabridge = require('../wabridge'), OS = require('opusscript');
const hzOf = (bufs, rate = 48000) => { const pcm = Buffer.concat(bufs); let z = 0; for (let i = 1; i < pcm.length / 2; i++) if ((pcm.readInt16LE((i - 1) * 2) < 0) !== (pcm.readInt16LE(i * 2) < 0)) z++; return Math.round(z / 2 / (pcm.length / 2 / rate)); };
test('upsample2 turns 24 kHz PCM into 48 kHz: each sample, then the average with the next', () => {
  const inp = Buffer.alloc(6); [0, 100, 200].forEach((v, i) => inp.writeInt16LE(v, i * 2));
  const out = wacall.upsample2(inp); assert.equal(out.length, 12); assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => out.readInt16LE(i * 2)), [0, 50, 100, 150, 200, 200]);
});

test('a call_permission_reply (WhatsApp\'s own message after a call) is ignored: nothing is sent back and the 24 h window is not opened', async () => {
  voiceReset(); const { id, phone } = outside(); clearCalls(); reset(PLAIN);
  const before = wa.linkOf(id).lastInboundAt;
  const m = incoming(phone, '', { type: 'interactive', text: undefined, interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', secret: 'tulips' } } });
  const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(m), ['system']));
  assert.match(out, /ignored a call permission reply from number ending \d{4}: a WhatsApp system message/); assert.equal(sent().length, 0, 'no decline text is sent'); assert.equal(wa.linkOf(id).lastInboundAt, before, 'the 24 h window was not opened by it'); assert.doesNotMatch(out, /tulips/);
  // other interactive replies keep their old behaviour (the one decline)
  assert.deepEqual(await wa.handleWebhook(incoming(phone, '', { type: 'interactive', text: undefined, interactive: { type: 'button_reply', button_reply: { id: 'a', title: 'b' } } })), ['unsupported']); assert.equal(sent().length, 1);
  clearCalls();
});

// ---- the outgoing stream (wacall.Outbound): a packet every 20 ms, silence when she is not speaking ----
const fakeTrack = () => { const t = { pkts: [], at: [] }; t.writeRtp = (p) => { t.pkts.push(p); t.at.push(Date.now()); }; return t; };
test('outbound: one packet per 20 ms, silence when she says nothing, her voice when she does, one running sequence and timestamp', async () => {
  const track = fakeTrack(), out = new wacall.Outbound(track, 111); out.start();
  await new Promise((r) => setTimeout(r, 300)); const silentN = track.pkts.length; assert.ok(silentN >= 12 && silentN <= 17, `a packet every 20 ms of silence (${silentN})`);
  const voice = Buffer.alloc(48000 * 2 * 0.2); for (let i = 0; i < voice.length / 2; i++) voice.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / 48000)), i * 2);
  await out.say(voice); await new Promise((r) => setTimeout(r, 100)); out.stop();
  const dec = new OS(48000, 1, OS.Application.VOIP); const peak = (p) => { const b = Buffer.from(dec.decode(p.payload)); let m = 0; for (let i = 0; i < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i))); return m; };
  assert.ok(track.pkts.slice(0, silentN).every((p) => peak(p) < 100), 'silence out before she speaks'); assert.ok(track.pkts.slice(silentN, silentN + 8).some((p) => peak(p) > 2000), 'her voice goes out after');
  const seqs = track.pkts.map((p) => p.header.sequenceNumber), tss = track.pkts.map((p) => p.header.timestamp);
  assert.ok(seqs.every((x, i) => i === 0 || x === ((seqs[i - 1] + 1) & 0xffff)), 'sequence numbers run on'); assert.ok(tss.every((x, i) => i === 0 || ((x - tss[i - 1]) >>> 0) === 960), 'timestamps advance 960 per packet');
  assert.ok(track.at.slice(1).every((t, i) => t - track.at[i] < 80), 'no gap in the stream');
});

test('outbound: an aborted speech is dropped from the queue (she was stopped), and a failed frame fails the stream, not silently', async () => {
  const track = fakeTrack(), out = new wacall.Outbound(track, 111); out.start(); let stop = false;
  const long = Buffer.alloc(48000 * 2 * 5); const said = out.say(long, () => stop); setTimeout(() => { stop = true; }, 100);
  await said; assert.ok(track.pkts.length < 25, `the 5 s speech was cut short (${track.pkts.length} packets)`); out.stop();
  const keep = OS.prototype.encode; let n = 0; OS.prototype.encode = function (...a) { if (++n === 4) throw new Error('encoder broke'); return keep.apply(this, a); };
  try { const t2 = fakeTrack(), o2 = new wacall.Outbound(t2, 111); o2.start(); const e = await o2.failed; assert.match(e.message, /encoder broke/); await assert.rejects(o2.say(Buffer.alloc(1920)), /encoder broke/); o2.stop(); } finally { OS.prototype.encode = keep; }
});

// ---- the ears (waears.js Mic): packets in, ordered 20 ms real-time frames out ----
const opusPackets = (n, { skip = [], hz = 440, start = 65530 } = {}) => { const enc = new OS(48000, 1, OS.Application.VOIP); const out = []; for (let i = 0; i < n; i++) { const b = Buffer.alloc(1920); for (let k = 0; k < 960; k++) b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * hz * (i * 960 + k) / 48000)), k * 2); const payload = Buffer.from(enc.encode(b, 960)); if (!skip.includes(i)) out.push({ header: { sequenceNumber: (start + i) & 0xffff, timestamp: (4294967000 + i * 960) >>> 0 }, payload }); } return out; };
const micWith = (opts = {}) => { const frames = [], logs = []; const mic = new waears.Mic({ sink: (f) => frames.push(f), log: (m) => logs.push(m), reorderMs: opts.reorderMs }); return { mic, frames, logs }; };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('ears: with no packets at all the sink still gets one silent 20 ms frame per tick (never ahead of real time)', async () => {
  const { mic, frames } = micWith(); mic.start(); mic.go(); const t0 = Date.now(); await sleepMs(500); const s = mic.stop('test');
  assert.ok(frames.length >= 22 && frames.length <= 27, `about 25 frames in 0.5 s (${frames.length})`); assert.ok(frames.every((f) => f.length === 1920 && !f.some((x) => x !== 0)), 'all silence, 960 samples each');
  assert.ok(frames.length * 20 <= Date.now() - t0 + 60, 'never more audio than real time'); assert.equal(s.packets, 0);
  const n = frames.length; await sleepMs(100); assert.equal(frames.length, n, 'the clock stopped with stop()'); assert.equal(mic.stop('again'), null);
});

test('ears: Opus packets (sequence number and timestamp wrapping) come out as 48 kHz PCM with the right pitch', async () => {
  const { mic, frames } = micWith(); mic.start(); mic.go();
  for (const pk of opusPackets(30)) { mic.hear(pk); await sleepMs(20); }
  const s = mic.stop('test'); assert.equal(s.packets, 30); assert.equal(s.lost, 0); assert.equal(s.late, 0);
  const voiced = frames.slice(5).filter((f) => f.some((x) => x !== 0)); assert.ok(voiced.length >= 18, `most ticks carried audio (${voiced.length})`); assert.ok(Math.abs(hzOf(voiced, 48000) - 440) < 15, `440 Hz (${hzOf(voiced, 48000)})`);
});

test('ears: a packet that arrives a little late, behind its successor, is put back in its place (reordered, not lost); nothing is dropped', () => {
  const { mic } = micWith(); mic.start(); const pk = opusPackets(8);
  [0, 1, 3, 2, 5, 4, 6, 7].forEach((i) => mic.hear(pk[i])); mic.flush();
  assert.equal(mic.lost, 0); assert.equal(mic.late, 0); assert.equal(mic.reordered, 2); assert.equal(mic.fifo.length, 8 * 1920, 'all eight 20 ms frames are there, in order, with no hole');
  // and the audio really is in order: decoding the same eight packets in order gives the same bytes
  const ref = micWith(); ref.mic.start(); pk.forEach((x) => ref.mic.hear(x)); assert.ok(mic.fifo.equals(ref.mic.fifo), 'identical to the in-order audio'); mic.stop('x'); ref.mic.stop('x');
});

test('ears: a packet that never comes is silence in its place (from the RTP timestamp) after 60 ms; a late or repeated one is dropped; the audio keeps its length', async () => {
  const { mic } = micWith(); mic.start(); const pk = opusPackets(9, { skip: [5, 6] }); for (const x of pk) mic.hear(x);
  assert.equal(mic.fifo.length, 5 * 1920, 'still waiting for the missing packets: the later ones are held for up to 60 ms'); await sleepMs(70); mic.hear(opusPackets(10)[9]); mic.flush();
  assert.equal(mic.lost, 2); assert.equal(mic.fifo.length, 10 * 1920, 'the two lost 20 ms frames are silence, so the audio keeps its length');
  mic.hear(pk[3]); mic.hear(pk[pk.length - 1]); assert.equal(mic.late, 2, 'late and repeated packets are dropped'); assert.equal(mic.fifo.length, 10 * 1920); mic.stop('x');
});

test('ears: what is said while the sink is not ready is kept (up to 2.5 s) and sent at once on go(); nothing is dropped, and after that only 400 ms is kept', async () => {
  const { mic, frames } = micWith(); mic.start();
  for (const pk of opusPackets(50)) { mic.hear(pk); await sleepMs(20); }   // 1 s of speech before the sink is ready
  mic.flush(); assert.equal(frames.length, 0, 'nothing is sent before go()'); assert.equal(mic.overflow, 0);
  mic.go(); assert.ok(frames.length >= 48, `the backlog went in at once (${frames.length} frames)`);
  assert.ok(Math.abs(hzOf(frames.filter((f) => f.some((x) => x !== 0)), 48000) - 440) < 15, 'and it is the real audio');
  const s = mic.stop('test'); assert.equal(s.overflowMs, 0); assert.ok(s.backlogMs >= 900 && s.backlogMs <= 1100, `about 1 s was kept (${s.backlogMs} ms)`);
  const big = micWith(); big.mic.start(); for (const pk of opusPackets(160, { start: 1000 })) big.mic.hear(pk); big.mic.flush();
  assert.ok(big.mic.fifo.length <= 125 * 1920 && big.mic.overflow > 0, 'over 2.5 s while waiting drops only the oldest'); big.mic.stop('x');
});

test('the outgoing stream: flush() drops what is queued (she was interrupted) and drain() waits for what is queued', async () => {
  const track = fakeTrack(), out = new wacall.Outbound(track, 111); out.start();
  const said = out.say(Buffer.alloc(48000 * 2 * 3)); await sleepMs(100); out.flush(); await said; assert.ok(track.pkts.length < 15, `three seconds of speech were cut short (${track.pkts.length} packets)`);
  await out.drain(); const a = track.pkts.length; out.say(Buffer.alloc(48000 * 2 * 0.2)); await out.drain(); assert.ok(track.pkts.length - a >= 9, 'drain waited for the 0.2 s that was queued'); out.stop();
});

test('the real answerer: if Meta refuses the pre_accept the call is rejected and no media is attempted', async () => {
  voiceReset(); const { phone } = linked();
  const caller = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] }, iceServers: [] });
  caller.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' }); await caller.setLocalDescription(await caller.createOffer());
  callFail = { pre_accept: { code: 138007, message: 'Connect Timeout error' } }; const p = callIn(phone, { sdp: caller.localDescription.sdp });
  try {
    const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(p), ['answer-failed']));
    assert.deepEqual(callPosts().map((b) => b.action), ['pre_accept', 'reject']); assert.match(out, /could NOT answer call [0-9a-f]{6} from number ending \d{4}: WhatsApp refused it \(138007\)/);
  } finally { callFail = null; await caller.close(); }
});

test('a WhatsApp text that is a reminder or the person\'s own plan sends the family nothing; a real request sends one note', async () => {
  voiceReset(); const { id, phone } = linked(); reset(PLAIN);
  const familyNotes = () => care.get(id).notifications.filter((x) => x.to === 'family' && x.ref === 'family_ask').length;
  for (const t of ['Can you remind me in 30 seconds that I have to call my sister.', 'I need to call my daughter later', 'Remind me to ring my son tonight']) { assert.deepEqual(await wa.handleWebhook(incoming(phone, t)), ['text']); }
  assert.equal(familyNotes(), 0, 'no family note from a reminder or a plan');
  assert.deepEqual(await wa.handleWebhook(incoming(phone, 'Please let my daughter know I am home.')), ['text']); assert.equal(familyNotes(), 1);
  assert.deepEqual(await wa.handleWebhook(incoming(phone, 'And tell my son too, please.')), ['text']); assert.equal(familyNotes(), 1, 'once');
  clearCalls();
});

test('a WhatsApp text "Tell my family I am not feeling well" sends the family one note; "Did you tell my family?" sends none', async () => {
  voiceReset(); const { id, phone } = linked(); reset(PLAIN);
  const familyNotes = () => care.get(id).notifications.filter((x) => x.to === 'family' && x.ref === 'family_ask').length;
  assert.deepEqual(await wa.handleWebhook(incoming(phone, 'Did you tell my family?')), ['text']); assert.equal(familyNotes(), 0);
  assert.deepEqual(await wa.handleWebhook(incoming(phone, 'Tell my family I am not feeling well.')), ['text']); assert.equal(familyNotes(), 1);
  clearCalls();
});


// ---- Phase 2: reminders the family set are delivered on WhatsApp inside the 24 h window, with honest status, acknowledgement, a nudge and a visible Missed ----
const MIN = 60000;
const statusIn = (wamid, st, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1409237678935671' }, statuses: [{ id: wamid, status: st, recipient_id: 'x', ...extra }] } }] }] });
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const remindProfile = (opts = {}) => { for (const m of memory.listProfiles()) { const q = care.get(m.id); if (q) q.reminders = []; } /* every test starts with no other reminder running */ const x = inWindow(); if (opts.mode) care.setMode(x.id, opts.mode); if (opts.tz) care.get(x.id).tz = opts.tz; if (opts.delivery) care.setDelivery(x.id, { reminders: opts.delivery }); return x; };
const addRem = (id, task = 'take your tablets', ahead = 5000) => { const dueAt = Date.now() + ahead; const r = care.addReminder(id, { task, dueAt, repeat: 'none' }); return { r, dueAt }; };
const rem = (id) => care.get(id).reminders[0];
const stateOf = (id) => (rem(id).active || rem(id).last || {}).state;
const reminderCalls = () => graphCalls.filter((c) => c.body || /\/media$/.test(c.url));
const carePath = (id) => path.join(process.env.MAYA_CARE_DIR, `${id}.json`);

test('Phase 2: a due reminder is saved as "sending" on DISK before the network call, then shown as sent only because WhatsApp gave a message id', async () => {
  voiceReset(); const { id } = remindProfile({ delivery: 'text' }); const { dueAt } = addRem(id); let onDisk = null;
  const keep = wa.deps.fetch; wa.deps.fetch = async (url, opts = {}) => { if (/\/messages$/.test(url) && !onDisk) { const f = JSON.parse(fs.readFileSync(carePath(id), 'utf8')).reminders[0]; onDisk = f.active && f.active.state; } return keep(url, opts); };
  try { care.tick(dueAt); assert.equal(stateOf(id), 'wa_sending'); await settle(); } finally { wa.deps.fetch = keep; }
  assert.equal(onDisk, 'wa_sending', 'the occurrence was on disk, as sending, when the message went out');
  const a = rem(id).active; assert.equal(a.state, 'wa_sent'); assert.match(a.wamid, /^wamid\.out/); assert.equal(a.via, 'text'); assert.equal(a.voiceUnavailable, false);
  const m = sent(); assert.equal(m.length, 1); assert.equal(m[0].type, 'text'); assert.equal(m[0].text.body, 'A reminder from your family: take your tablets. Reply when you have seen this.');
  assert.match(care.view(id).reminders[0].active.label, /^Sent as text\. WhatsApp accepted it\.$/); clearCalls();
});

test('Phase 2: the default is a voice note in Maya\'s voice; if the voice cannot be made it goes as text and says so, never claiming a voice note', async () => {
  voiceReset(); const a = remindProfile(); const { dueAt } = addRem(a.id);
  care.tick(dueAt); await settle(); const m = sent(); assert.equal(m.length, 1); assert.equal(m[0].type, 'audio'); assert.equal(m[0].audio.voice, true);
  assert.deepEqual(spoken, ['A reminder from your family: take your tablets. Reply when you have seen this.']); assert.equal(rem(a.id).active.via, 'voice'); assert.match(care.view(a.id).reminders[0].active.label, /^Sent as a voice note\. WhatsApp accepted it\.$/);
  voiceReset(); speakFail = true; const b = remindProfile(); const d2 = addRem(b.id).dueAt; care.tick(d2); await settle();
  assert.equal(sent().length, 1); assert.equal(sent()[0].type, 'text'); const x = rem(b.id).active; assert.equal(x.via, 'text'); assert.equal(x.voiceUnavailable, true);
  assert.equal(care.view(b.id).reminders[0].active.label, 'Sent as text (voice unavailable). WhatsApp accepted it.'); speakFail = false; clearCalls();
});

test('Reminder voice failures name the stage and WhatsApp\'s own code (never a reason in words, never a word of the reminder); each falls back to text and the dashboard says so', async () => {
  const oggEncode = oggopus.encode; const keepFetch = wa.deps.fetch; const keepSpeak = chat.deps.speak;
  const run = async (arrange, undo = () => {}) => {
    voiceReset(); const { id } = remindProfile(); const { dueAt } = addRem(id, 'take my private tulips tablets'); arrange();
    const logs = await captureLogs(async () => { care.tick(dueAt); await settle(); }); undo();
    return { id, logs, vf: logs.filter((l) => l.includes('voice failed')), sent: sent() };
  };
  const failOn = (test, error) => { wa.deps.fetch = async (url, opts = {}) => { const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; if (test(url, body, opts)) return { ok: false, status: 400, json: async () => ({ error }) }; return keepFetch(url, opts); }; };
  const back = () => { wa.deps.fetch = keepFetch; oggopus.encode = oggEncode; chat.deps.speak = keepSpeak; speakFail = false; };
  try {
    let r = await run(() => { speakFail = true; }, back);
    assert.deepEqual(r.vf, ['reminder {"event":"voice failed","stage":"speech","code":null,"then":"text"}']); assert.equal(r.sent[0].type, 'text'); assert.equal(rem(r.id).active.voiceUnavailable, true); assert.match(care.view(r.id).reminders[0].active.label, /voice unavailable/);
    r = await run(() => { oggopus.encode = () => { throw new Error('encoder'); }; }, back); assert.deepEqual(r.vf, ['reminder {"event":"voice failed","stage":"encode","code":null,"then":"text"}']);
    r = await run(() => { chat.deps.speak = async () => tone(200); }, back); assert.deepEqual(r.vf, ['reminder {"event":"voice failed","stage":"too_long","code":null,"then":"text"}']); assert.equal(r.sent[0].type, 'text');
    r = await run(() => failOn((url) => /\/media$/.test(url), { code: 131053, message: 'Media upload error' }), back); assert.deepEqual(r.vf, ['reminder {"event":"voice failed","stage":"upload","code":131053,"then":"text"}']); assert.equal(r.sent[0].type, 'text');
    r = await run(() => failOn((url, body) => /\/messages$/.test(url) && body && body.type === 'audio', { code: 131047, message: 'Re-engagement message' }), back); assert.deepEqual(r.vf, ['reminder {"event":"voice failed","stage":"send","code":131047,"then":"text"}']); assert.equal(r.sent[0].type, 'text');
    for (const x of [r]) assert.doesNotMatch(x.logs.join('\n'), /tulips|tablets|Re-engagement|encoder|Media upload/, 'codes and stages only: no reason text, no task');
    // and when the voice works there is no such line, and the text-only setting never tries a voice at all
    const ok = await run(() => {}); assert.deepEqual(ok.vf, []); assert.equal(ok.sent[0].type, 'audio');
    voiceReset(); const t = remindProfile({ delivery: 'text' }); const d2 = addRem(t.id).dueAt; const l2 = await captureLogs(async () => { care.tick(d2); await settle(); }); assert.ok(!l2.some((l) => l.includes('voice failed')));
  } finally { back(); clearCalls(); }
});

test('An incoming message of a type Maya does not handle logs its SHAPE (field names, never a value), so the first tap on a template quick-reply button shows its real structure', async () => {
  voiceReset(); const { id, phone } = linked(); reset(PLAIN);
  const btn = incoming(phone, '', { type: 'button', text: undefined, button: { payload: 'SECRET-PAYLOAD-VALUE', text: 'Got it tulips' }, context: { from: '15556408264', id: 'wamid.CONTEXT-ID-1' } });
  let logs = await captureLogs(async () => assert.deepEqual(await wa.handleWebhook(btn), ['unsupported']));
  const line = logs.find((l) => l.includes('unhandled incoming message'));
  assert.equal(line, `whatsapp: unhandled incoming message from number ending ${phone.slice(-4)}: type button, fields [button{payload,text},context{from,id},from,id,timestamp,type]`);
  assert.doesNotMatch(logs.join('\n'), /SECRET-PAYLOAD|tulips|CONTEXT-ID|15556408264/, 'names only: no value, no id, no number'); assert.ok(!logs.join('\n').includes(phone));
  assert.deepEqual(sent().map((m) => m.text.body), ['I can read your typed messages and listen to voice notes here. Please type it or send a voice note.'], 'what the person gets is unchanged');
  // other unhandled types too, and odd or deep structures are bounded and sanitised
  clearCalls(); logs = await captureLogs(async () => { await wa.handleWebhook(incoming(phone, '', { type: 'sticker', text: undefined, sticker: { id: 'x', mime_type: 'image/webp' } })); });
  assert.ok(logs.some((l) => /type sticker, fields \[from,id,sticker\{id,mime_type\},timestamp,type\]$/.test(l)), logs.join(' | '));
  clearCalls(); const odd = incoming(phone, '', { type: 'Weird Type!', text: undefined, 'bad key!': 1, nested: { a: { b: { c: { d: 1 } } } }, list: [{ k1: 1, k2: 2 }, { other: 1 }] });
  logs = await captureLogs(async () => { await wa.handleWebhook(odd); });
  assert.ok(logs.some((l) => /type unknown, fields \[from,id,list\[k1,k2\],nested\{a\{b\}\},timestamp,type\]$/.test(l)), logs.join(' | '));
  assert.doesNotMatch(logs.join('\n'), /bad key|Weird|other/, 'an odd type name and odd keys never reach the log');
  // the types Maya DOES handle do not write this line
  clearCalls(); reset(PLAIN); logs = await captureLogs(async () => { await wa.handleWebhook(incoming(phone, 'hello there')); });
  assert.ok(!logs.some((l) => l.includes('unhandled incoming message'))); clearCalls();
});

test('Phase 2: delivered and read come ONLY from WhatsApp\'s status webhooks and never go backwards; no status, no claim', async () => {
  voiceReset(); const { id } = remindProfile({ delivery: 'text' }); const { dueAt } = addRem(id); care.tick(dueAt); await settle(); const wamid = rem(id).active.wamid;
  assert.equal(stateOf(id), 'wa_sent', 'sent is as far as it goes with no status');
  await wa.handleWebhook(statusIn(wamid, 'delivered')); assert.equal(stateOf(id), 'wa_delivered'); assert.equal(care.view(id).reminders[0].active.label, 'Delivered to their phone, not read yet');
  await wa.handleWebhook(statusIn(wamid, 'read')); assert.equal(stateOf(id), 'wa_read'); assert.equal(care.view(id).reminders[0].active.label, 'Read, no reply yet');
  await wa.handleWebhook(statusIn(wamid, 'delivered')); assert.equal(stateOf(id), 'wa_read', 'a late "delivered" does not take it back from read');
  assert.deepEqual(await wa.handleWebhook(statusIn('wamid.not-ours', 'read')), []); assert.equal(stateOf(id), 'wa_read', 'an id that is not ours changes nothing'); clearCalls();
});

test('Phase 2: a reply that acknowledges it answers the reminder; "not now" does not; a voice note reply counts too; the family sees Answered', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN); const { dueAt } = addRem(id); care.tick(dueAt); await settle(); clearCalls();
  await wa.handleWebhook(incoming(phone, 'Not now, later please')); assert.equal(stateOf(id), 'wa_sent', 'not an acknowledgement');
  await wa.handleWebhook(incoming(phone, 'ok thanks, got it')); assert.equal(stateOf(id), 'done'); assert.equal(rem(id).last.answeredBy, 'a reply on WhatsApp'); assert.equal(care.view(id).reminders[0].last.label, 'Done, senior replied');
  const v = remindProfile({ delivery: 'text' }); transcript = 'okay I have taken them'; const d2 = addRem(v.id).dueAt; care.tick(d2); await settle(); clearCalls();
  assert.deepEqual(await wa.handleWebhook(voiceIn(v.phone)), ['voice']); assert.equal(stateOf(v.id), 'done', 'a spoken reply answers it too');
  voiceReset(); clearCalls();
});

test('Phase 2: several reminders waiting: a reply answers the MOST RECENTLY SENT one, then the next most recent; older ones stay waiting (and turn Missed on their own); a late status changes nothing', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN);
  const t1 = Date.now() + 5000; for (const task of ['first one', 'second one', 'third one']) care.addReminder(id, { task, dueAt: t1, repeat: 'none' });
  care.tick(t1); await settle(); const rs = care.get(id).reminders; rs.forEach((r, i) => { assert.equal(r.active.state, 'wa_sent'); r.active.sentAt -= (2 - i) * 60000; });   // first sent longest ago, third most recently
  for (const r of rs) await wa.handleWebhook(statusIn(r.active.wamid, 'delivered')); clearCalls();
  const states = () => rs.map((r) => (r.active || r.last).state);
  await wa.handleWebhook(incoming(phone, 'Okay.')); assert.deepEqual(states(), ['wa_delivered', 'wa_delivered', 'done'], 'the newest was answered');
  await wa.handleWebhook(statusIn(rs[2].last.wamid, 'read')); assert.deepEqual(states(), ['wa_delivered', 'wa_delivered', 'done'], 'a read status after the answer changes nothing');
  await wa.handleWebhook(incoming(phone, 'Okay.')); assert.deepEqual(states(), ['wa_delivered', 'done', 'done'], 'then the next most recent');
  care.tick(t1 + 61 * MIN); await settle(); assert.deepEqual(states(), ['wa_missed', 'done', 'done'], 'the oldest was never answered and is Missed, visible');
  assert.equal(care.view(id).reminders[0].last.label, 'Missed: no reply within 60 minutes'); assert.equal(care.view(id).reminders[2].last.label, 'Done, senior replied'); clearCalls();
});

test('Phase 2: two reminders sent in the same moment: the one added last is answered first (a tie goes to the later one)', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN);
  const t1 = Date.now() + 5000; care.addReminder(id, { task: 'added first', dueAt: t1, repeat: 'none' }); care.addReminder(id, { task: 'added second', dueAt: t1, repeat: 'none' });
  care.tick(t1); await settle(); const rs = care.get(id).reminders; const at = Date.now(); rs.forEach((r) => { r.active.sentAt = at; }); clearCalls();
  await wa.handleWebhook(incoming(phone, 'Okay.')); assert.deepEqual(rs.map((r) => (r.active || r.last).state), ['wa_sent', 'done']); clearCalls();
});

test('Phase 2: with one reminder waiting, a reply answers it (the clean case from the live run: waiting 1, delivered, "Okay")', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN); const { dueAt } = addRem(id); care.tick(dueAt); await settle(); await wa.handleWebhook(statusIn(rem(id).active.wamid, 'delivered')); clearCalls();
  const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' ')); try { await wa.handleWebhook(incoming(phone, 'okay')); } finally { console.log = l0; }
  assert.ok(logs.includes('reminder {"event":"reply checked","ack":true,"waiting":1,"states":["wa_delivered"],"inFlightOtherChannel":0}')); assert.ok(logs.includes('reminder {"event":"answered"}')); assert.equal(stateOf(id), 'done'); clearCalls();
});

// ---- Reminder replies, step 2: when the person writes while a reminder is in flight, Maya is told about it, so her reply is about it ----
const { reminderFacts } = require('../call');
const sendReminderTo = async (id, task, ago = 0) => { const due = Date.now() + 5000; care.addReminder(id, { task, dueAt: due, repeat: 'none' }); const r = care.get(id).reminders.at(-1); care.tick(due); await settle(); const a = r.active; a.sentAt -= ago * MIN; await wa.handleWebhook(statusIn(a.wamid, 'delivered')); return r; };
const rosterWith = (re) => asked.map((a) => a.roster).filter((r) => re.test(r)).at(-1);
const captureLogs = async (fn) => { const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' ')); try { await fn(); } finally { console.log = l0; } return logs; };

test('Reminder replies: the dad example. "Okay I\'ll take it. Stop haggling with me" answers the reminder, and Maya is told it did, that he sounds annoyed, not to argue, nag or say it is done; the log names the fact, never a word', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN); const r = await sendReminderTo(id, 'Meds dad, remember?', 3); clearCalls(); asked.length = 0;
  const logs = await captureLogs(() => wa.handleWebhook(incoming(phone, "Okay I'll take it. Stop haggling with me")));
  assert.equal((r.active || r.last).state, 'done', 'the acknowledgement marked it answered (code, not Spark)');
  const ro = rosterWith(/THIS message from them answers it/); assert.ok(ro, 'Spark was told');
  assert.match(ro, /FACT: 3 minutes ago you sent them a reminder from their family: "Meds dad, remember\?", and THIS message from them answers it: it is marked answered\./);
  assert.match(ro, /using only what they said \(for example that they will do it, or that they saw it\)/); assert.match(ro, /Never say it is done unless they said they did it/); assert.match(ro, /If they sound annoyed or push back, take it lightly and kindly: do not argue, do not explain, do not repeat the task, do not remind them again and do not ask about it again\./);
  assert.match(ro, /add no advice, no dose, no reason and no medicine of your own\. Answer in the language they used\./);
  assert.ok(logs.includes('reply facts {"source":"whatsapp","labels":["reminder-answered-now"],"turns":1}'), logs.join(' | ')); assert.doesNotMatch(logs.join('\n'), /haggling|Meds|take it|remember/i, 'labels only, never a word');
  // then he talks about something else: the reminder is finished business and stays in mind for 30 minutes, not repeated
  asked.length = 0; const l2 = await captureLogs(() => wa.handleWebhook(incoming(phone, 'How is the weather today?')));
  const ro2 = rosterWith(/they answered it[^.]*\. That is finished/); assert.ok(ro2, 'a message right after the one that answered it is NOT "the one that answered it"'); assert.match(ro2, /FACT: 3 minutes ago you sent them a reminder from their family: "Meds dad, remember\?" and they answered it less than a minute ago\. That is finished: do not mention it, repeat it or ask about it again unless they bring it up\. Carry on with whatever they say now, keeping it in mind\./);
  assert.ok(l2.includes('reply facts {"source":"whatsapp","labels":["reminder-answered-earlier"],"turns":1}'));
  r.last.at -= 31 * MIN; asked.length = 0; const l3 = await captureLogs(() => wa.handleWebhook(incoming(phone, 'And tomorrow?')));
  assert.ok(!rosterWith(/from their family/), 'after 30 minutes it is just history'); assert.ok(!l3.some((l) => l.startsWith('reply facts')), 'and no fact is logged'); clearCalls();
});

test('Reminder replies: while it is waiting, a message that is not an acknowledgement is told it may be a reply to it; "later" must not become a promise to remind again; it stays waiting', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN); const r = await sendReminderTo(id, 'go for a walk', 12); clearCalls(); asked.length = 0;
  const logs = await captureLogs(() => wa.handleWebhook(incoming(phone, 'What was that about?')));
  const ro = rosterWith(/Their message may be a reply to it/); assert.ok(ro);
  assert.match(ro, /FACT: 12 minutes ago you sent them a reminder from their family: "go for a walk"\. They have not confirmed it yet\./); assert.match(ro, /if they ask what it was, tell them the family's words exactly/);
  assert.match(ro, /if they say not now or later, keep it light, do not push and do NOT promise to remind them again \(you cannot yet\)/); assert.match(ro, /if they are talking about something else, just talk and do not bring the reminder up/);
  assert.equal(r.active.state, 'wa_delivered', 'not an acknowledgement: still waiting'); assert.ok(logs.includes('reply facts {"source":"whatsapp","labels":["reminder-waiting"],"turns":1}'));
  await wa.handleWebhook(incoming(phone, 'later please')); assert.equal(r.active.state, 'wa_delivered', '"later" does not answer it and stays waiting'); clearCalls();
});

test('Reminder replies: several waiting: the fact is about the newest, the same one the acknowledgement answers; a voice note reply gets the same treatment', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN);
  const a = await sendReminderTo(id, 'oldest thing', 40), b = await sendReminderTo(id, 'middle thing', 20), c = await sendReminderTo(id, 'newest thing', 2); clearCalls(); asked.length = 0;
  await wa.handleWebhook(incoming(phone, 'hm, what?')); const ro = rosterWith(/older ones are also still waiting/); assert.ok(ro);
  assert.match(ro, /"newest thing"\. They have not confirmed it yet \(2 older ones are also still waiting; this is about the newest\)/); assert.doesNotMatch(ro, /oldest thing|middle thing/, 'only the newest is named');
  // A voice note is transcribed inside the chat turn; chat.js hands the words to whatsapp.js (onWords) BEFORE the reply is written, so a spoken "okay" is marked answered first and Maya is told so.
  asked.length = 0; transcript = 'okay thanks'; const vl = await captureLogs(async () => assert.deepEqual(await wa.handleWebhook(voiceIn(phone)), ['voice']));
  assert.deepEqual([a, b, c].map((r) => (r.active || r.last).state), ['wa_delivered', 'wa_delivered', 'done'], 'the voice note answered the SAME newest one');
  assert.match(rosterWith(/THIS message from them answers it/), /"newest thing"/); assert.ok(vl.includes('reply facts {"source":"whatsapp","labels":["reminder-answered-now"],"turns":1}'), vl.join(' | '));
  // and a spoken reply that is not an acknowledgement is still just "waiting"; the note right after the one that answered is not "the one that answered it"
  asked.length = 0; transcript = 'what was that about?'; const wl = await captureLogs(async () => { await wa.handleWebhook(voiceIn(phone)); });
  assert.match(rosterWith(/Their message may be a reply to it/), /"middle thing"\. They have not confirmed it yet \(1 older one is also still waiting/); assert.ok(wl.includes('reply facts {"source":"whatsapp","labels":["reminder-waiting"],"turns":1}'));
  voiceReset(); clearCalls();
});

test('Reminder replies: a Missed reminder is known silently for 2 hours; a message from the family is passed on as a message, never as "take your meds"; a Not sent reminder is not mentioned at all', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN); const r = await sendReminderTo(id, 'rest a little', 0); const due = r.active.sentAt - 1000;
  care.tick(due + 61 * MIN); await settle(); assert.equal(r.last.state, 'wa_missed'); clearCalls(); asked.length = 0;
  const logs = await captureLogs(() => wa.handleWebhook(incoming(phone, 'Hello Maya')));
  const ro = rosterWith(/did not answer it\. Do not mention it unless they do/); assert.ok(ro); assert.match(ro, /no guilt, no pushing, no checking up\. If they raise it, say only what the family's words were: "rest a little"\./);
  assert.ok(logs.includes('reply facts {"source":"whatsapp","labels":["reminder-missed"],"turns":1}'));
  r.last.at -= 3 * 60 * MIN; asked.length = 0; await wa.handleWebhook(incoming(phone, 'Anything new?')); assert.ok(!rosterWith(/from their family/), 'after 2 hours it is forgotten');
  const m = remindProfile({ delivery: 'text' }); await sendReminderTo(m.id, "Mum, it's your daughter - I love you!", 1); asked.length = 0; await wa.handleWebhook(incoming(m.phone, 'who is this?'));
  const rm = rosterWith(/Their message may be a reply to it/); assert.match(rm, /1 minute ago you sent them a message from their family: "Mum, it's your daughter - I love you!"/); assert.doesNotMatch(rm, /reminder from their family/);
  const f = outside(); care.setMode(f.id, 'standard'); const due2 = Date.now() + 5000; care.addReminder(f.id, { task: 'never sent', dueAt: due2, repeat: 'none' }); care.tick(due2); await settle(); asked.length = 0; await wa.handleWebhook(incoming(f.phone, 'hello')); assert.ok(!rosterWith(/never sent/), 'Not sent: it never reached them, so Maya says nothing about it'); clearCalls();
});

test('Reminder replies: only a reply that really came through WhatsApp is told (not the same person typing in the app, not a call), and the door is closed again afterwards', async () => {
  voiceReset(); const { id } = remindProfile({ delivery: 'text' }); reset(PLAIN); await sendReminderTo(id, 'take your tablets', 5); clearCalls(); asked.length = 0;
  await chat.sendText(id, 'What was that about?', null, { source: 'app' }); assert.ok(!rosterWith(/from their family/), 'typed in the app: no reminder fact'); assert.deepEqual((chat.sessions.get(id) || {}).factLabels, []);
  assert.equal(care.turnChannel(id), null, 'the door is closed');
  const { Call } = require('../call'); const call = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(call.endTimer); call.profile = memory.load(id);
  const note = await care.withTurnChannel(id, 'whatsapp', async () => call.careNotes('What was that about?')); assert.doesNotMatch(note, /from their family/, 'a call speaks its reminders itself'); assert.equal(care.turnChannel(id), null);
  await assert.rejects(care.withTurnChannel(id, 'whatsapp', async () => { throw new Error('boom'); }), /boom/); assert.equal(care.turnChannel(id), null, 'closed even when the turn fails'); clearCalls();
});

test('Reminder replies: safety words still reach her first when a reminder is in flight; and the four labels are plain names in the source', async () => {
  voiceReset(); const { id, phone } = remindProfile({ delivery: 'text' }); reset(PLAIN); await sendReminderTo(id, 'take your tablets', 5); clearCalls();
  await wa.handleWebhook(incoming(phone, 'I want to end my life')); const labels = chat.sessions.get(id).factLabels; assert.equal(labels[0], 'safety', 'the safety fact comes first'); assert.ok(labels.includes('reminder-waiting'), labels.join(','));
  const src = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'); for (const l of ['reminder-answered-now', 'reminder-waiting', 'reminder-answered-earlier', 'reminder-missed']) assert.match(src, new RegExp(`'${l}'`), l);
  assert.equal(reminderFacts(null), null); assert.equal(reminderFacts({ waiting: null, answered: null, missed: null }), null);
  assert.equal(reminderFacts({ waiting: { task: 'x', minutesAgo: 0, via: 'voice', nudged: true, others: 0 }, answered: null, missed: null }).text.startsWith('FACT: less than a minute ago you sent them a reminder from their family: "x" as a voice note and checked once more.'), true); clearCalls();
});

test('chat.js onWords hook: called once with the transcript BEFORE Maya\'s reply is written, not called when nothing was heard, and a failing callback never breaks the chat', async () => {
  voiceReset(); const x = linked(); reset(PLAIN); const order = []; const wav = chat.pcmToWav(tone(1));
  const keepT = chat.deps.transcribe; chat.deps.transcribe = async () => 'okay I will'; const before = asked.length;
  const r = await chat.sendVoiceNote(x.id, wav, null, { source: 'whatsapp', onWords: (w) => order.push(['words', w, asked.length]) });
  assert.deepEqual(order, [['words', 'okay I will', before]], 'called once, and no Spark call had been made yet'); assert.ok(r.messages.find((m) => m.role === 'maya'));
  const logs = []; const e0 = console.error; console.error = (...a) => logs.push(a.join(' '));
  try { const r2 = await chat.sendVoiceNote(x.id, wav, null, { onWords: () => { throw new Error('callback exploded'); } }); assert.ok(r2.messages.find((m) => m.role === 'maya'), 'the chat still answered'); } finally { console.error = e0; }
  assert.ok(logs.some((l) => /voice note callback failed: callback exploded/.test(l)));
  chat.deps.transcribe = async () => ''; let called = 0; await assert.rejects(chat.sendVoiceNote(x.id, wav, null, { onWords: () => { called += 1; } }), (e) => e.status === 422); assert.equal(called, 0, 'nothing heard: not called');
  chat.deps.transcribe = keepT; voiceReset(); clearCalls();
});

test('Phase 2: outside the 24 h window nothing is sent (no Meta call), it is shown as Not sent with the reason; the family is told in cautious and ultra, not in standard', async () => {
  for (const [mode, kind] of [['standard', null], ['cautious', 'gentle'], ['ultra', 'alert']]) {
    voiceReset(); const x = outside(); care.setMode(x.id, mode); const { dueAt } = addRem(x.id); care.tick(dueAt); await settle();
    assert.equal(stateOf(x.id), 'wa_failed'); assert.equal(rem(x.id).last.reason, 'window_closed'); assert.equal(graphCalls.length, 0, 'no Meta call at all');
    assert.equal(care.view(x.id).reminders[0].last.label, "Not sent: WhatsApp's 24-hour window is closed, so Maya cannot message them yet");
    const fam = care.get(x.id).notifications.filter((n) => n.to === 'family' && n.ref === 'reminder_failed'); assert.equal(fam.length, kind ? 1 : 0); if (kind) { assert.equal(fam[0].kind, kind); assert.match(fam[0].text, /Maya could not send the reminder "take your tablets"/); }
  }
});

test('Phase 2: a Meta refusal is shown as Not sent with its error code, never as sent; a send with no message id is not "sent" either', async () => {
  voiceReset(); const a = remindProfile({ delivery: 'text' }); graphFail = { code: 131026, message: 'Message undeliverable' }; const d = addRem(a.id).dueAt; care.tick(d); await settle();
  assert.equal(stateOf(a.id), 'wa_failed'); assert.equal(rem(a.id).last.error.code, 131026); assert.equal(care.view(a.id).reminders[0].last.label, 'Not sent: Message undeliverable (WhatsApp error 131026)'); clearCalls();
  const b = remindProfile({ delivery: 'text' }); const keep = wa.deps.fetch; wa.deps.fetch = async (url, opts = {}) => (/\/messages$/.test(url) ? { ok: true, status: 200, json: async () => ({ messages: [] }) } : keep(url, opts));
  try { const d2 = addRem(b.id).dueAt; care.tick(d2); await settle(); } finally { wa.deps.fetch = keep; }
  assert.equal(stateOf(b.id), 'wa_failed'); assert.equal(rem(b.id).last.reason, 'no_id'); clearCalls();
  const c = remindProfile({ delivery: 'text' }); const d3 = addRem(c.id).dueAt; care.tick(d3); await settle(); const wamid = rem(c.id).active.wamid;
  await wa.handleWebhook(statusIn(wamid, 'failed', { errors: [{ code: 131049, title: 'Not delivered to protect the ecosystem' }] }));
  assert.equal(stateOf(c.id), 'wa_failed'); assert.equal(rem(c.id).last.reason, 'whatsapp_failed'); assert.equal(rem(c.id).last.error.code, 131049); clearCalls();
});

test('Phase 2: one nudge after 10 minutes if not answered, then Missed after 60 minutes, visible in every mode; standard says nothing more, cautious a gentle note, ultra an alert', async () => {
  for (const [mode, kind] of [['standard', null], ['cautious', 'gentle'], ['ultra', 'alert']]) {
    voiceReset(); const x = remindProfile({ mode, delivery: 'text' }); const { dueAt } = addRem(x.id); care.tick(dueAt); await settle(); clearCalls();
    care.tick(dueAt + 5 * MIN); await settle(); assert.equal(sent().length, 0, 'too early for the nudge');
    care.tick(dueAt + 10 * MIN + 1000); await settle(); assert.equal(sent().length, 1); assert.equal(sent()[0].text.body, 'Just checking that you saw this reminder from your family: take your tablets. Reply when you have seen it.');
    care.tick(dueAt + 20 * MIN); await settle(); assert.equal(sent().length, 1, 'only ONE nudge'); assert.equal(rem(x.id).active.nudged, true);
    care.tick(dueAt + 61 * MIN); await settle(); assert.equal(stateOf(x.id), 'wa_missed'); assert.equal(care.view(x.id).reminders[0].last.label, 'Missed: no reply within 60 minutes'); assert.equal(rem(x.id).active, null);
    const fam = care.get(x.id).notifications.filter((n) => n.to === 'family' && n.ref === 'reminder_missed'); assert.equal(fam.length, kind ? 1 : 0, mode); if (kind) { assert.equal(fam[0].kind, kind); assert.match(fam[0].text, /has not confirmed the reminder "take your tablets"/); }
    care.tick(dueAt + 90 * MIN); assert.equal(care.get(x.id).notifications.filter((n) => n.ref === 'reminder_missed').length, kind ? 1 : 0, 'the family is told once'); clearCalls();
  }
});

test('Phase 2: quiet hours (22:00-07:00, when the time zone is known): the reminder is sent at its time, but the nudge and the family note wait; with no time zone nothing is assumed', async () => {
  voiceReset(); const x = remindProfile({ mode: 'ultra', delivery: 'text', tz: 'UTC' }); const due = Date.UTC(2026, 10, 3, 22, 50);
  care.addReminder(x.id, { task: 'take your tablets', dueAt: Date.now() + 5000, repeat: 'none' }); care.get(x.id).reminders[0].dueAt = due;
  care.tick(due); await settle(); assert.equal(sent().length, 1, 'the reminder itself goes at the time the family chose, even in quiet hours'); clearCalls();
  care.tick(due + 11 * MIN); await settle(); assert.equal(sent().length, 0, 'the nudge waits for 07:00');
  care.tick(due + 61 * MIN); await settle(); assert.equal(stateOf(x.id), 'wa_missed', 'Missed is recorded at once'); assert.equal(care.get(x.id).notifications.filter((n) => n.ref === 'reminder_missed').length, 0, 'but the family note is held');
  assert.equal(rem(x.id).last.escalate.pending, true);
  care.tick(Date.UTC(2026, 10, 4, 7, 1)); assert.equal(care.get(x.id).notifications.filter((n) => n.ref === 'reminder_missed' && n.kind === 'alert').length, 1, 'sent once quiet hours end'); assert.equal(rem(x.id).last.escalate.pending, false);
  voiceReset(); const y = remindProfile({ mode: 'cautious', delivery: 'text' }); assert.equal(care.get(y.id).tz, null); const d2 = Date.UTC(2026, 10, 3, 23, 0); care.addReminder(y.id, { task: 'rest', dueAt: Date.now() + 5000, repeat: 'none' }); care.get(y.id).reminders[0].dueAt = d2;
  care.tick(d2); await settle(); clearCalls(); care.tick(d2 + 11 * MIN); await settle(); assert.equal(sent().length, 1, 'no time zone known: no quiet hours assumed'); clearCalls();
});

test('Phase 2: never sent late (the 30 minute rule stays); a restart in the middle of sending is shown as not sent and is NEVER sent again; finished one-time reminders go after 30 days', async () => {
  voiceReset(); const a = remindProfile({ delivery: 'text' }); const { dueAt } = addRem(a.id); care.tick(dueAt + 31 * MIN); await settle(); assert.equal(graphCalls.length, 0, 'nothing is sent 31 minutes late'); assert.equal(stateOf(a.id), 'missed');
  voiceReset(); const b = remindProfile({ delivery: 'text' }); const d2 = addRem(b.id).dueAt; care.tick(d2); const key = rem(b.id).active.key; assert.equal(stateOf(b.id), 'wa_sending');
  // the process "restarts" here: nothing in memory but the file on disk
  const onDisk = JSON.parse(fs.readFileSync(carePath(b.id), 'utf8')); assert.equal(onDisk.reminders[0].active.state, 'wa_sending'); assert.equal(onDisk.reminders[0].active.key, key);
  await settle(); clearCalls(); care.get(b.id).reminders[0].active = onDisk.reminders[0].active; care.get(b.id).reminders[0].last = null; care.get(b.id).reminders[0].active.state = 'wa_sending'; care.get(b.id).reminders[0].active.wamid = null;
  const keepSpy = graphCalls.length; care.start(); assert.equal(stateOf(b.id), 'wa_failed'); assert.equal(rem(b.id).last.reason, 'restart'); assert.equal(graphCalls.length, keepSpy, 'recovery sends nothing'); care.tick(d2 + 5 * MIN); await settle(); assert.equal(graphCalls.length, keepSpy, 'and nothing later either');
  assert.equal(care.view(b.id).reminders[0].last.label, 'Not sent: the server restarted while sending, so it may not have reached them');
  const c = remindProfile({ delivery: 'text' }); addRem(c.id); care.get(c.id).reminders[0].dueAt = null; care.get(c.id).reminders[0].last = { dueAt: Date.now(), state: 'done', at: Date.now() - 31 * 24 * 60 * MIN, attempts: 1 };
  care.addReminder(c.id, { task: 'again', dueAt: Date.now() + 99999, repeat: 'daily' }); care.tick(Date.now()); assert.deepEqual(care.get(c.id).reminders.map((r) => r.task), ['again'], 'finished one-time reminder deleted after 30 days; a repeating one kept');
  const d = remindProfile({ delivery: 'text' }); addRem(d.id); care.get(d.id).reminders[0].dueAt = null; care.get(d.id).reminders[0].last = { dueAt: Date.now(), state: 'done', at: Date.now() - 29 * 24 * 60 * MIN, attempts: 1 }; care.tick(Date.now()); assert.equal(care.get(d.id).reminders.length, 1, 'kept at 29 days'); clearCalls();
});

test('Phase 2: a person with no WhatsApp link keeps the old in-app ring; a reminder during a live call is still spoken in the call; delivery preference is validated', async () => {
  voiceReset(); const id = senior(); const { dueAt } = addRem(id); care.tick(dueAt); await settle(); assert.equal(stateOf(id), 'calling', 'the in-app ring, as before'); assert.equal(graphCalls.length, 0); care.decline(id, rem(id).active.outreachId);
  const p = remindProfile(); assert.deepEqual(care.setDelivery(p.id, { reminders: 'text' }), { reminders: 'text' }); assert.equal(care.view(p.id).delivery.reminders, 'text'); assert.throws(() => care.setDelivery(p.id, { reminders: 'carrier pigeon' }), /voice note or as text/);
  assert.equal(care.get(senior()).delivery.reminders, 'voice', 'default: a voice note');
});

test('Phase 2: reminder logs are counts and kinds only; a family message is passed on as a message; the daily cap stops a flood', async () => {
  voiceReset(); const x = remindProfile({ delivery: 'text' }); addRem(x.id, 'take my private tulips pills'); const rr = rem(x.id);
  const due = rr.dueAt; const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' ')); try { care.tick(due); await settle(); care.tick(due + 11 * MIN); await settle(); care.tick(due + 61 * MIN); await settle(); } finally { console.log = l0; }
  const out = logs.join('\n'); assert.match(out, /reminder \{"event":"sent","via":"text","voiceUnavailable":false\}/); assert.match(out, /reminder \{"event":"nudge sent"\}/); assert.match(out, /reminder \{"event":"missed"\}/); assert.doesNotMatch(out, /tulips|pills|TEST-TOKEN/); assert.ok(!out.includes(x.phone));
  assert.equal(wa.reminderWords("Mum, it's your daughter - I love you!", false).text, "A message from your family: Mum, it's your daughter - I love you. Reply when you have seen this.");
  assert.equal(wa.reminderWords('Take your meds mom', false).text, 'A reminder from your family: Take your meds. Reply when you have seen this.', 'how the family addresses her is not part of the task');
  const y = remindProfile({ delivery: 'text' }); const all = JSON.parse(fs.readFileSync(LF(), 'utf8')); all[y.id].remSent = Array.from({ length: wa.REMINDER_CAP }, () => Date.now() - 1000); fs.writeFileSync(LF(), JSON.stringify(all));
  clearCalls(); const d = addRem(y.id).dueAt; care.tick(d); await settle(); assert.equal(stateOf(y.id), 'wa_failed'); assert.equal(rem(y.id).last.reason, 'daily_cap'); assert.equal(graphCalls.length, 0); clearCalls();
});

test('dashboard sends are logged: the attempt, the success, every refusal and every Meta error, with the last 4 digits and the reason, never the family\'s words', async () => {
  voiceReset(); const { id, phone } = outside(); const end4 = phone.slice(-4);
  let out = await capture(async () => { await wa.sendOut(id, { kind: 'text', text: 'my private tulips words', useTemplate: false }).catch(() => {}); });
  assert.match(out, new RegExp(`dashboard text send to number ending ${end4}`)); assert.match(out, /NOT sent: .*24 hours/); assert.doesNotMatch(out, /tulips|TEST-TOKEN/);
  assert.ok(!out.includes(phone), 'only the last 4 digits');
  out = await capture(() => wa.sendOut(id, { kind: 'text', text: 'x', useTemplate: true }));
  assert.match(out, /invitation template requested/); assert.match(out, new RegExp(`dashboard template sent to number ending ${end4} \\(template\\)`));
  shift(id, 60000); graphFail = { code: 131030, message: 'Recipient phone number not in allowed list' };
  out = await capture(() => wa.sendOut(id, { kind: 'text', useTemplate: true }).catch(() => {})); assert.match(out, /NOT sent: .*131030/);
  clearCalls();
  out = await capture(() => wa.sendOut(senior(), { kind: 'text', text: 'x' }).catch(() => {})); assert.match(out, /a profile with no linked number NOT sent: .*no WhatsApp number linked/);
});

test('a template send logs the phone id (last 4 only), API version, template name and language, and the Meta error code; never the token or a full number', async () => {
  voiceReset(); const { id, phone } = outside(); graphFail = { code: 10, message: '(#10) Viewer cannot access the provided Paid Message Account 1116892537450220' };
  const out = await capture(() => wa.sendOut(id, { kind: 'text', useTemplate: true }).catch(() => {}));
  assert.match(out, /template send: phone id ending 5671, api v\d+\.\d+, template hello_world\/en_US/); assert.match(out, /NOT sent: WhatsApp refused it \(10\)/);
  assert.match(out, /token length 19, sha256 [0-9a-f]{8}(?!,? ODD)/); // shape of the token the process reads, not the token
  assert.doesNotMatch(out, /TEST-TOKEN|1409237678935671/); assert.ok(!out.includes(phone));
  const call = graphCalls.find((c) => c.body && c.body.type === 'template'); assert.match(call.url, /\/v\d+\.\d+\/1409237678935671\/messages$/, 'the PHONE number id, not the WABA id');
  assert.match(call.url, /\/v26\.0\//, 'default API version matches the Explorer send that worked');
  clearCalls();
});


// ---- C1: the first outbound test call (wacall.callOut, whatsapp.placeTestCall): connect -> SDP answer webhook -> RINGING -> ACCEPTED -> media -> fixed sentence -> terminate ----
const { TEST_CALL_LINE } = wacall;
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleepMs(10); } };
const OUT_ID = 'wacid.OUTBOUND1TESTCALL==';
const outWebhook = (phone, { calls, statuses }) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15556408264', phone_number_id: '1409237678935671' }, ...(calls ? { contacts: [{ wa_id: phone }], calls } : {}), ...(statuses ? { statuses } : {}) } }] }] });
const outAnswer = (phone, sdp, id = OUT_ID) => outWebhook(phone, { calls: [{ id, from: '15556408264', to: phone, event: 'connect', direction: 'BUSINESS_INITIATED', timestamp: '1700000000', session: { sdp_type: 'answer', sdp } }] });
const outStatus = (phone, status, id = OUT_ID) => outWebhook(phone, { statuses: [{ id, type: 'call', status, recipient_id: phone, timestamp: '1700000001' }] });
const outEnd = (phone, status = 'COMPLETED', extra = {}, id = OUT_ID) => outWebhook(phone, { calls: [{ id, from: '15556408264', to: phone, event: 'terminate', direction: 'BUSINESS_INITIATED', timestamp: '1700000009', status, ...extra }] });
// WhatsApp's side: a real peer that answers OUR offer (receives the media).
const fakeDevice = async (offerSdp) => {
  const peer = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] }, iceServers: [] }); const got = [];
  peer.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((r) => got.push(r)));
  peer.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });
  await peer.setRemoteDescription({ type: 'offer', sdp: offerSdp }); await peer.setLocalDescription(await peer.createAnswer());
  return { peer, got, answer: peer.localDescription.sdp };
};
// Meta's answer to the connect POST: { calls: [{ id }] } (docs); a failure per action through callFail as everywhere else.
const withConnectReply = async (reply, fn) => { const keep = wa.deps.fetch; wa.deps.fetch = async (url, opts = {}) => { const b = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; if (b && /\/calls$/.test(url) && b.action === 'connect' && !(callFail && callFail.connect)) { graphCalls.push({ url, opts, body: b }); return { ok: true, status: 200, json: async () => reply }; } return keep(url, opts); }; try { return await fn(); } finally { wa.deps.fetch = keep; } };
const actions = () => callPosts().map((b) => b.action);
const outReset = () => { voiceReset(); wa.deps.testCooldownMs = 0; wa.deps.testRingCapMs = undefined; wa.deps.testTailMs = 50; callFail = null; };

test('C1 the whole test call: connect with our offer, the SDP answer webhook is applied, RINGING, ACCEPTED, media up, the fixed sentence is spoken verbatim, then terminate; logs hold no SDP, number or word', async () => {
  outReset(); const { id, phone } = linked(); let dev = null;
  const out = await capture(async () => {
    await withConnectReply({ messaging_product: 'whatsapp', calls: [{ id: OUT_ID }] }, async () => {
      const placed = await wa.placeTestCall(id); assert.deepEqual(placed, { placed: true });
      const conn = callPosts().find((b) => b.action === 'connect');
      assert.equal(conn.to, phone); assert.equal(conn.messaging_product, 'whatsapp'); assert.equal(conn.session.sdp_type, 'offer'); assert.match(conn.session.sdp, /m=audio/); assert.match(conn.session.sdp, /opus/i); assert.equal(conn.call_id, undefined);
      assert.deepEqual(spoken, [TEST_CALL_LINE], 'the sentence is exactly the fixed one');
      dev = await fakeDevice(conn.session.sdp);
      assert.equal(wa.view(id).testCall.state, 'requested');
      assert.deepEqual(await wa.handleWebhook(outStatus(phone, 'RINGING')), ['status']); assert.equal(wa.view(id).testCall.state, 'ringing');
      assert.deepEqual(await wa.handleWebhook(outAnswer(phone, dev.answer)), ['outbound-answer']);
      assert.equal(actions().includes('terminate'), false, 'nothing is hung up before they answer');
      assert.deepEqual(await wa.handleWebhook(outStatus(phone, 'ACCEPTED')), ['status']);
      await waitFor(() => actions().includes('terminate'));
      assert.deepEqual(actions(), ['connect', 'terminate']); assert.equal(callPosts().at(-1).call_id, OUT_ID);
      assert.ok(dev.got.length >= 45, `the phone received the one second of speech (${dev.got.length} packets)`);
      assert.deepEqual(await wa.handleWebhook(outEnd(phone, 'COMPLETED', { start_time: 1, end_time: 9, duration: 8 })), ['ended']);
      await waitFor(() => wa.view(id).testCall.state === 'completed');
    });
  });
  try {
    assert.match(out, /test call [0-9a-f]{6} to number ending \d{4}: requested/); assert.match(out, /RINGING \d+ ms after the request/); assert.match(out, /answer applied/); assert.match(out, /ACCEPTED \d+ ms after the request/);
    assert.match(out, /media up \d+ ms/); assert.match(out, /the fixed sentence was spoken/); assert.match(out, /hung up \d+ ms/); assert.match(out, /call ended: .*status COMPLETED, duration 8 s/); assert.match(out, /finished, completed/);
    assert.ok(out.indexOf('RINGING') < out.indexOf('ACCEPTED') && out.indexOf('ACCEPTED') < out.indexOf('media up') && out.indexOf('media up') < out.indexOf('hung up'));
    assert.doesNotMatch(out, /v=0|a=fingerprint|TEST-TOKEN|wacid|Hello, this is Maya/); assert.ok(!out.includes(phone));
    assert.equal(sent().length, 0, 'a call sends no message');
  } finally { await dev.peer.close(); }
});

test('C1 ring cap: nobody answers, so it is terminated at the cap, once, with no retry; RINGING alone does not stop the clock', async () => {
  outReset(); wa.deps.testRingCapMs = 200; const { id, phone } = linked();
  const out = await capture(async () => withConnectReply({ calls: [{ id: OUT_ID }] }, async () => {
    await wa.placeTestCall(id); await wa.handleWebhook(outStatus(phone, 'RINGING'));
    await waitFor(() => actions().includes('terminate')); await waitFor(() => wa.view(id).testCall.state === 'no answer');
  }));
  assert.deepEqual(actions(), ['connect', 'terminate']); assert.match(out, /no answer in \d+ s/); assert.match(out, /finished, no answer/);
  await sleepMs(300); assert.deepEqual(actions(), ['connect', 'terminate'], 'one attempt, no retry');
  await wa.handleWebhook(outEnd(phone, 'COMPLETED')); // Meta's terminate webhook for an unanswered call: COMPLETED with no duration
});

test('C1 they reject it: REJECTED is logged, nothing is terminated (Meta ends it), no media, no sentence', async () => {
  outReset(); const { id, phone } = linked();
  const out = await capture(async () => withConnectReply({ calls: [{ id: OUT_ID }] }, async () => {
    await wa.placeTestCall(id); await wa.handleWebhook(outStatus(phone, 'RINGING')); await wa.handleWebhook(outStatus(phone, 'REJECTED'));
    await waitFor(() => wa.view(id).testCall.state === 'rejected'); await sleepMs(100); await wa.handleWebhook(outEnd(phone, 'COMPLETED'));
  }));
  assert.deepEqual(actions(), ['connect']); assert.match(out, /REJECTED \d+ ms/); assert.match(out, /finished, rejected/); assert.doesNotMatch(out, /fixed sentence was spoken/);
});

test('C1 refusals place nothing: unlinked, opted out, in an app call, a second test, the cooldown; Meta refusing the connect (138006) says so and frees the line', async () => {
  outReset(); const err = async (p, re, status) => { await assert.rejects(p, (e) => { assert.match(e.message, re); assert.equal(e.status, status); return true; }); };
  await err(wa.placeTestCall(senior()), /Link their WhatsApp number/, 400); assert.equal(callPosts().length, 0);
  const o = linked(); await wa.handleWebhook(incoming(o.phone, 'STOP')); await err(wa.placeTestCall(o.id), /stopped messages/, 400); assert.equal(callPosts().length, 0);
  const b = linked(); care.liveCalls.set(b.id, {}); try { await err(wa.placeTestCall(b.id), /in a call in the app/, 409); } finally { care.liveCalls.delete(b.id); } assert.equal(callPosts().length, 0);
  const { id, phone } = linked(); callFail = { connect: { code: 138006, message: 'No approved call permission from the user' } };
  await err(wa.placeTestCall(id), /WhatsApp refused it \(138006\)/, 502); assert.equal(wa.view(id).testCall.state, 'failed'); assert.deepEqual(actions(), ['connect']); callFail = null;
  clearCalls(); await withConnectReply({ calls: [{ id: OUT_ID }] }, async () => {
    await wa.placeTestCall(id); await err(wa.placeTestCall(id), /Another call is in progress/, 409);
    await wa.handleWebhook(outStatus(phone, 'RINGING')); await wa.handleWebhook(outStatus(phone, 'REJECTED')); await waitFor(() => wa.view(id).testCall.state === 'rejected'); await sleepMs(100);
    wa.deps.testCooldownMs = 60000; await err(wa.placeTestCall(id), /Wait a minute/, 429);
  });
  assert.deepEqual(actions(), ['connect'], 'only the one that was allowed reached Meta');
});

test('C1 if her voice cannot be made, nothing is placed and the phone never rings; a status or answer for a call nobody placed is ignored', async () => {
  outReset(); const { id, phone } = linked(); speakFail = true;
  await assert.rejects(wa.placeTestCall(id), /voice is down/); assert.equal(callPosts().length, 0); assert.equal(wa.view(id).testCall.state, 'failed');
  voiceReset();
  assert.deepEqual(await wa.handleWebhook(outStatus(phone, 'RINGING', 'wacid.NOBODYASKED==')), ['ignored']);
  assert.deepEqual(await wa.handleWebhook(outAnswer(phone, 'v=0 SECRET-SDP', 'wacid.NOBODYASKED==')), ['ignored']); assert.equal(graphCalls.length, 0);
});

test('C1 a status or answer for some OTHER call id while ours is in flight is ignored; the call route is mock-safe and the panel shows the button only when linked', async () => {
  outReset(); const { id, phone } = linked();
  await withConnectReply({ calls: [{ id: OUT_ID }] }, async () => {
    await wa.placeTestCall(id);
    assert.deepEqual(await wa.handleWebhook(outStatus(phone, 'ACCEPTED', 'wacid.SOMEONEELSE==')), ['ignored']);
    assert.notEqual(wa.view(id).testCall.state, 'answered');
    await wa.handleWebhook(outStatus(phone, 'REJECTED')); await waitFor(() => wa.view(id).testCall.state === 'rejected'); await sleepMs(100);
  });
  assert.equal(wa.view(senior()).testCall, undefined);
});

test('C1 the connect response logs its SHAPE (field names only, two levels) and which key held the call id; no value, id or number ever appears', async () => {
  outReset(); const { id, phone } = linked();
  const shapes = [[{ messaging_product: 'whatsapp', calls: [{ id: OUT_ID, extra: 'SECRET-VALUE' }] }, /connect response fields \[calls\[extra,id\],messaging_product\], call id from calls\[0\]\.id/], [{ messaging_product: 'whatsapp', call_id: OUT_ID, success: 'SECRET-VALUE' }, /connect response fields \[call_id,messaging_product,success\], call id from call_id/], [{ messaging_product: 'whatsapp', success: true }, /connect response fields \[messaging_product,success\], call id not in the response \(taken from the first webhook\)/]];
  for (const [reply, re] of shapes) {
    const out = await capture(async () => withConnectReply(reply, async () => { await wa.placeTestCall(id); await wa.handleWebhook(outStatus(phone, 'REJECTED')); await waitFor(() => wa.view(id).testCall.state === 'rejected'); await sleepMs(100); }));
    assert.match(out, re); assert.doesNotMatch(out, /SECRET-VALUE|wacid|TEST-TOKEN/); assert.ok(!out.includes(phone));
  }
});
