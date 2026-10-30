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
let graphFail = null;
const inboundMedia = new Map(); // media id -> Buffer (what WhatsApp would hold for a voice note)
wa.deps.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  graphCalls.push({ url, opts, body });
  const done = (data) => ({ ok: true, status: 200, json: async () => data, arrayBuffer: async () => data });
  if (graphFail) return { ok: false, status: 400, json: async () => ({ error: graphFail }) };
  if (/^https:\/\/lookaside\.test\//.test(url)) return done(Uint8Array.from(inboundMedia.get(url.split('/').pop())).buffer);
  const m = /graph\.facebook\.com\/v[\d.]+\/(\d+|wamid[\w.]*|MEDIA[\w]*)$/.exec(url);
  if (m && !opts.method) return done({ url: `https://lookaside.test/${m[1]}`, mime_type: 'audio/ogg; codecs=opus', file_size: inboundMedia.get(m[1]).length, id: m[1] });
  if (/\/media$/.test(url)) return done({ id: `MEDIAUP${graphCalls.length}` });
  return done({ messages: [{ id: `wamid.out${graphCalls.length}` }] });
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
  assert.deepEqual(Object.keys(wa).filter((k) => typeof wa[k] === 'function' && /call|ring|dial|video/i.test(k)), []);
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

// ---- calls in (refused for now) ----
const SDP = 'v=0 o=- 4611731400430051336 2 IN IP4 127.0.0.1 SECRET-SDP-LINES';
const callIn = (person, { event = 'connect', direction = 'USER_INITIATED', swap = false, extra = {} } = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15556408264', phone_number_id: '1409237678935671' }, contacts: [{ profile: { name: 'x' }, wa_id: person }], calls: [{ id: `wacid.TESTCALL${mid++}ABCD`, from: swap ? '15556408264' : person, to: swap ? person : '15556408264', event, direction, timestamp: '1700000000', ...(event === 'connect' ? { session: { sdp_type: 'offer', sdp: SDP } } : {}), ...extra }] } }] }] });
const rejects = () => graphCalls.filter((c) => /\/calls$/.test(c.url)).map((c) => c.body);

test('a call from a linked, opted-in person is refused (action reject on the PHONE number id); Maya cannot answer yet', async () => {
  voiceReset(); const { phone } = linked(); const p = callIn(phone);
  assert.deepEqual(await wa.handleWebhook(p), ['rejected']);
  const calls = graphCalls.filter((c) => /\/calls$/.test(c.url)); assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v\d+\.\d+\/1409237678935671\/calls$/); assert.equal(calls[0].opts.method, 'POST'); assert.equal(calls[0].opts.headers.Authorization, 'Bearer TEST-TOKEN-NOT-REAL');
  assert.deepEqual(calls[0].body, { messaging_product: 'whatsapp', call_id: p.entry[0].changes[0].value.calls[0].id, action: 'reject' });
  assert.equal(sent().length, 0, 'a refused call sends no message');
});

test('a call from an unlinked number, or from someone who opted out, is refused too, with the reason', async () => {
  voiceReset(); const { phone } = linked();
  let out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn('919876548237')), ['rejected']));
  assert.match(out, /rejected call ending \w{4} from number ending 8237: no profile is linked/); assert.equal(rejects().length, 1);
  await wa.handleWebhook(incoming(phone, 'STOP')); clearCalls();
  out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone)), ['rejected']));
  assert.match(out, /has not opted in or has stopped/); assert.equal(rejects().length, 1);
});

test('the person is found whichever way from / to point (the docs\' samples disagree), and a call with no readable person is still refused', async () => {
  voiceReset(); const { phone } = linked();
  const swapped = callIn(phone, { swap: true }); swapped.entry[0].changes[0].value.contacts = [];
  const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(swapped), ['rejected']));
  assert.match(out, new RegExp(`from number ending ${phone.slice(-4)}.*linked and opted in, but Maya cannot answer calls yet`));
  const none = callIn(phone); none.entry[0].changes[0].value.contacts = []; none.entry[0].changes[0].value.calls[0].from = none.entry[0].changes[0].value.calls[0].to = 'x';
  clearCalls(); assert.deepEqual(await wa.handleWebhook(none), ['rejected']); assert.equal(rejects().length, 1);
});

test('call terminate is logged (status, duration, error code) and answered with nothing; other events and business-started calls are not refused', async () => {
  voiceReset(); const { phone } = linked();
  let out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone, { event: 'terminate', extra: { status: 'FAILED', duration: 0, errors: [{ code: 138021, message: 'Media receive timeout' }] } })), ['ended']));
  assert.match(out, /call ended: number ending \d{4}, call ending \w{4}, status FAILED, duration 0 s, error 138021/); assert.equal(graphCalls.length, 0);
  out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone, { direction: 'BUSINESS_INITIATED' })), ['ignored'])); assert.equal(graphCalls.length, 0);
  assert.deepEqual(await wa.handleWebhook(callIn(phone, { event: 'ringing' })), ['ignored']);
});

test('when Meta refuses the reject, it is logged as a message and nothing crashes', async () => {
  voiceReset(); const { phone } = linked(); graphFail = { code: 138000, message: 'Calling not enabled' };
  const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(phone)), ['reject-failed']));
  assert.match(out, /could NOT reject call ending \w{4} from number ending \d{4}: WhatsApp refused it \(138000\)/); clearCalls();
});

test('call logs hold field names only: never the SDP, a full number, a full call id or the token', async () => {
  voiceReset(); const { phone } = linked(); const p = callIn(phone); const id = p.entry[0].changes[0].value.calls[0].id;
  const out = await capture(() => wa.handleWebhook(p));
  assert.match(out, /call connect: USER_INITIATED from number ending \d{4}, call ending \w{4}, fields \[.*direction.*event.*id.*session.*\], session \[sdp, sdp_type\]/);
  assert.doesNotMatch(out, /SECRET-SDP|v=0|TEST-TOKEN/); assert.ok(!out.includes(phone)); assert.ok(!out.includes(id));
  assert.ok(!out.includes('15556408264'));
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
