// A WhatsApp call end to end (wacall.js + wabridge.js + waears.js) with the app's REAL Call (call.js) and a REAL WebRTC peer standing in for the phone.
// No network: Meta Graph, Spark, the transcribe engine and ElevenLabs are stubbed. The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-wabridge-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
process.env.WHATSAPP_TOKEN = 'TEST-TOKEN-NOT-REAL';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_PHONE_ID = '1409237678935671';
process.env.META_API_KEY = 'TEST-META-KEY';

// The brain: Spark replies from a queue (or fails), ElevenLabs returns a 300 Hz tone as PCM16 24 kHz.
const SAY = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
let sparkReply = `${SAY} Hello there, it is nice to talk to you. How has your day been so far?`, sparkFails = false;
const TTS_S = 0.5;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (_h, _r, _s, onDelta) => { if (sparkFails) throw new Error('Meta Spark failed (HTTP 500)'); if (onDelta) onDelta(sparkReply); return sparkReply; },
  streamSpeech: async (_text, _signal, onChunk) => { const N = 24000 * TTS_S, b = Buffer.alloc(N * 2); for (let i = 0; i < N; i++) b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 300 * i / 24000)), i * 2); onChunk(b); },
} };
// The ears engine (Meta transcribe): records what the Call feeds it and lets the test see it. Patched BEFORE call.js loads (it takes openTranscribe when it loads).
const T = require('../transcribe');
const engine = { chunks: [], opened: 0, closed: false, h: null };
T.openTranscribe = (key, h) => { engine.opened++; engine.key = key; engine.h = h; setTimeout(() => h.onReady('SESSION'), 5); return { get ready() { return true; }, sendPcm(b) { engine.chunks.push(b); }, close() { engine.closed = true; } }; };

const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const wa = require('../whatsapp');
const wacall = require('../wacall');
const wabridge = require('../wabridge');
const { Call } = require('../call');
const { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useOPUS } = require('werift');
const OS = require('opusscript');

const step = (m) => { if (process.env.DBG) process.stderr.write(`[${Date.now() % 100000}] ${m}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(20); } };
const capture = async (fn) => { const logs = []; const l0 = console.log, e0 = console.error; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' ')); try { await fn(); } finally { console.log = l0; console.error = e0; } return logs.join('\n'); };
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
let phoneN = 0;
const linked = () => { const id = memory.createProfile(`Wanda${letters(n++)}`, 'female').id, phone = `4477009${String(20000 + phoneN++)}`; wa.link(id, phone, true); return { id, phone }; };

// Graph stub: records every POST to /calls and can run a hook (the phone applies the answer) or fail an action.
const posts = []; let hook = null, fail = null;
wa.deps.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  if (body && /\/calls$/.test(url)) {
    posts.push(body);
    if (fail && fail[body.action]) return { ok: false, status: 400, json: async () => ({ error: fail[body.action] }) };
    if (hook) await hook(body);
  }
  return { ok: true, status: 200, json: async () => ({ messaging_product: 'whatsapp', success: true, messages: [{ id: 'wamid.x' }] }) };
};
let spoken = [];
chat.deps.speak = async (t) => { spoken.push(t); const b = Buffer.alloc(24000 * 0.4 * 2); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 500 * i / 24000)), i * 2); return b; };

let mid = 0;
const callIn = (person, { event = 'connect', sdp, extra = {} } = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15556408264', phone_number_id: '1409237678935671' }, contacts: [{ profile: { name: 'x' }, wa_id: person }], calls: [{ id: `wacid.BRIDGE${mid++}ABCD==`, from: person, to: '15556408264', event, direction: 'USER_INITIATED', timestamp: '1700000000', ...(event === 'connect' ? { session: { sdp_type: 'offer', sdp } } : {}), ...extra }] } }] }] });
const callIdOf = (p) => p.entry[0].changes[0].value.calls[0].id;
const actions = () => posts.map((b) => b.action);

// The phone: a WebRTC peer with an offer shaped like Meta's, recording what it hears (with arrival times) and able to talk (a 440 Hz tone as Opus).
async function phone() {
  const dec = new OS(48000, 1, OS.Application.VOIP); const heard = []; heard.at = [];
  const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] }, iceServers: [] });
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => { try { heard.push(Buffer.from(dec.decode(rtp.payload))); heard.at.push(Date.now()); } catch { /* ignore */ } }));
  const track = new MediaStreamTrack({ kind: 'audio' }); pc.addTransceiver(track, { direction: 'sendrecv' });
  await pc.setLocalDescription(await pc.createOffer());
  const offer = pc.localDescription.sdp.replace('UDP/TLS/RTP/SAVPF 111', 'UDP/TLS/RTP/SAVPF 111 9 0 8 126').replace('a=ice-options:trickle', 'a=ice-lite\r\na=ice-options:trickle')
    .replace('a=rtpmap:111 OPUS/48000/2', 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:9 G722/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:126 telephone-event/8000\r\na=fmtp:126 0-16');
  const enc = new OS(48000, 1, OS.Application.VOIP); let seq = 100, ts = 5000, k = 0, iv = null;
  const talk = () => { iv = setInterval(() => { const b = Buffer.alloc(1920); for (let i = 0; i < 960; i++) b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 440 * (k + i) / 48000)), i * 2); k += 960; track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq++, timestamp: ts, ssrc: 4321 }), Buffer.from(enc.encode(b, 960)))); ts += 960; }, 20); };
  return { pc, offer, heard, talk, stopTalk: () => iv && clearInterval(iv), close: async () => { iv && clearInterval(iv); await pc.close(); } };
}
const hzOf = (bufs, rate) => { const pcm = Buffer.concat(bufs); let z = 0; for (let i = 1; i < pcm.length / 2; i++) if ((pcm.readInt16LE((i - 1) * 2) < 0) !== (pcm.readInt16LE(i * 2) < 0)) z++; return Math.round(z / 2 / (pcm.length / 2 / rate)); };
const voiced = (bufs) => bufs.filter((b) => { for (let i = 0; i < b.length; i += 2) if (Math.abs(b.readInt16LE(i)) > 1500) return true; return false; });

// One scripted call. fn gets { id, phone, p (the connect webhook), ph (the phone peer), callRef, running }. Everything is closed afterwards.
async function withCall(opts, fn) {
  const { id, phone: num } = linked(); const ph = await phone(); const keep = { new: wa.deps.newCall }; let callRef = null;
  posts.length = 0; spoken = []; engine.chunks = []; engine.opened = 0; engine.closed = false; sparkFails = !!opts.sparkFails; fail = opts.fail || null;
  wa.deps.newCall = (socket, key) => { callRef = new Call(socket, key); return callRef; }; wa.deps.callTailMs = 60; wa.deps.callCapMs = opts.capMs;
  let beforeAccept = null;
  hook = async (body) => {
    if (body.action === 'pre_accept') await ph.pc.setRemoteDescription({ type: 'answer', sdp: body.session.sdp });
    if (body.action === 'accept') { beforeAccept = ph.heard.length; if (opts.talk !== false) ph.talk(); }
  };
  const p = callIn(num, { sdp: ph.offer }); let out = '', result = null;
  const logs = []; const l0 = console.log, e0 = console.error; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  const running = wa.handleWebhook(p).then((r) => { result = r; });
  try { await fn({ id, phone: num, p, ph, get callRef() { return callRef; }, running, get beforeAccept() { return beforeAccept; }, logs: () => logs.join('\n'), get result() { return result; } }); }
  finally {
    if (result === null) { try { await wa.handleWebhook(callIn(num, { event: 'terminate', extra: { id: callIdOf(p), status: 'COMPLETED', duration: 1 } })); } catch { /* ignore */ } } // a failed assertion must not leave the call running
    await running.catch(() => {}); console.log = l0; console.error = e0; hook = null; fail = null; sparkFails = false; wa.deps.newCall = keep.new; wa.deps.callTailMs = undefined; wa.deps.callCapMs = undefined;
    ph.stopTalk(); await ph.close(); if (callRef && !callRef.closed) callRef.end();
  }
}
const turn = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
const hangUpPhone = (num, p, extra = {}) => wa.handleWebhook(callIn(num, { event: 'terminate', extra: { id: callIdOf(p), status: 'COMPLETED', duration: 9, ...extra } }));

test('fixed fatal line is the approved one, word for word; localHour is only given when there is a saved time zone', () => {
  assert.equal(wabridge.FATAL_LINE, "I'm having trouble right now. Please try again a little later. Goodbye.");
  assert.ok(Number.isNaN(wabridge.localHour(null))); assert.ok(Number.isNaN(wabridge.localHour('Not/AZone')));
  const h = wabridge.localHour('Asia/Kolkata', Date.UTC(2026, 9, 30, 6, 30)); assert.equal(h, 12);
});

test('a whole call: the greeting is made while the phone rings and heard the moment it is answered, the caller is heard by the engine, her reply comes back, and the caller hanging up ends the Call', async () => {
  sparkReply = `${SAY} Hello there, it is nice to talk to you. How has your day been so far?`;
  let out;
  await withCall({}, async (c) => {
    step('start'); await until(() => c.ph.heard.length > 15);   // her greeting reaches the phone
    step('greeting heard');
    assert.equal(c.beforeAccept, 0, 'no media reached the phone before the accept'); assert.equal(engine.opened, 1, 'the Call opened its own transcribe session');
    assert.equal(c.callRef.profile.id, c.id, 'the Call is the linked person\'s'); assert.equal(care.liveCalls.get(c.id), c.callRef, 'registered as a live call');
    assert.ok(Math.abs(hzOf(voiced(c.ph.heard).slice(0, 12), 48000) - 300) < 30, 'the phone heard her voice (the 300 Hz stand-in) at the right pitch');
    await until(() => engine.chunks.length > 60); step('engine fed');   // the caller's tone reached the engine
    const fed = Buffer.concat(engine.chunks); assert.ok(engine.chunks.every((b) => b.length % 2 === 0)); const heardByEngine = voiced(engine.chunks.slice(-60)); assert.ok(heardByEngine.length >= 20, `the caller's tone reached the engine (${heardByEngine.length} chunks)`); assert.ok(Math.abs(hzOf(heardByEngine, 24000) - 440) < 25, `the engine hears the caller at 24 kHz (${hzOf(heardByEngine, 24000)} Hz)`);
    await sleep(1500);                                   // let the greeting finish and the stream go quiet before her next reply
    const before = c.ph.heard.length; sparkReply = `${SAY} That sounds lovely. Tell me more about the tea.`;
    step('respond'); c.callRef.pending = [turn('I had tea with my neighbour this morning')]; await c.callRef.respond(0); step('responded');
    await until(() => c.ph.heard.length > before + 20); step('reply heard'); // her reply reaches the phone
    await hangUpPhone(c.phone, c.p); step('hung up');
    await c.running; step('running done'); assert.equal(c.result[0], 'answered');
    out = c.logs();
    assert.deepEqual(actions(), ['pre_accept', 'accept'], 'the caller hung up: nothing more is sent'); assert.ok(c.callRef.closed, 'the Call was ended (memory filed as in the app)'); assert.equal(care.liveCalls.get(c.id), undefined);
    const gaps = c.ph.heard.at.slice(1).map((t, i) => t - c.ph.heard.at[i]); assert.ok(Math.max(...gaps) < 200, `her stream never stops (largest gap ${Math.max(...gaps)} ms)`);
  });
  assert.match(out, /pre-accepted/); assert.match(out, /media connected/); assert.match(out, /her greeting is ready \d+ ms after the media connected/); assert.ok(out.indexOf('her greeting is ready') < out.indexOf('accepted; the conversation has started'));
  assert.match(out, /reply 1: her first audio came \d+ ms after the last sound from you/); assert.match(out, /ears ended \(caller hung up\): \d+ packets received, \d+ put back in order, \d+ lost, \d+ late or repeated, 0 unreadable, 0 ms dropped for lag, \d+ ms kept before the engine was ready, [\d.]+ s heard, worst timer lateness \d+ ms/);
  assert.match(out, /conversation over \(caller hung up\): \d+ turn\(s\) heard, 1 reply timed, slowest \d+ ms to first audio/); assert.match(out, /answered call [0-9a-f]{6}.*conversation, caller hung up/);
  assert.doesNotMatch(out, /neighbour|nice to talk|lovely|a=fingerprint|v=0|TEST-TOKEN|TEST-META-KEY/, 'no words said by either side, no SDP, no keys');
});

test('Maya says goodbye (the Call hangs up): her last words are played out, then we terminate', async () => {
  await withCall({}, async (c) => {
    await until(() => c.ph.heard.length > 15); await sleep(400);
    c.callRef.hangUp();                                  // what the Call does after a goodbye it has spoken
    await c.running; assert.equal(c.result[0], 'answered');
    assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']); assert.ok(c.callRef.closed);
    assert.match(c.logs(), /hung up \(maya hung up\)/); assert.match(c.logs(), /conversation over \(maya hung up\)/);
    assert.equal(care.activeByProfile.get(c.id), undefined, 'no in-app ring-back is started for a WhatsApp call (it would only end as a false unreachable later)');
  });
});

test('a fatal Call error: the one fixed line is spoken if her voice still works, then we terminate', async () => {
  await withCall({}, async (c) => {
    await until(() => c.ph.heard.length > 15); const before = c.ph.heard.length;
    c.callRef.fatal('boom from the brain');
    await c.running; assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']);
    assert.deepEqual(spoken, [wabridge.FATAL_LINE]); assert.ok(c.ph.heard.length > before + 10, 'the phone heard the fixed line (the 500 Hz stand-in)');
    assert.ok(Math.abs(hzOf(voiced(c.ph.heard).slice(-8), 48000) - 500) < 40);
    assert.match(c.logs(), /the call brain reported an error: boom from the brain/); assert.match(c.logs(), /hung up \(fatal\)/);
  });
});

test('if Spark fails before her greeting, the call is rejected and the phone never hears a thing', async () => {
  await withCall({ sparkFails: true }, async (c) => {
    await c.running; assert.equal(c.result[0], 'answer-failed'); assert.deepEqual(actions(), ['pre_accept', 'reject']); assert.equal(c.ph.heard.length, 0, 'no media at all');
    assert.match(c.logs(), /could NOT answer call [0-9a-f]{6}.*the call brain stopped before the greeting/); assert.ok(c.callRef.closed);
  });
});

test('the 10-minute cap ends a call (shortened here): terminate, no spoken line, the Call ended', async () => {
  await withCall({ capMs: 1500 }, async (c) => {
    await c.running; assert.equal(c.result[0], 'answered'); assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']); assert.match(c.logs(), /hung up \(time cap\)/); assert.ok(c.callRef.closed);
  });
});

test('the phone ending the call (error 138021) is reported as that, and nothing more is sent', async () => {
  await withCall({}, async (c) => {
    await until(() => c.ph.heard.length > 15);
    await hangUpPhone(c.phone, c.p, { status: 'FAILED', duration: 42, errors: [{ code: 138021, message: 'Media receive timeout' }] });
    await c.running; assert.deepEqual(actions(), ['pre_accept', 'accept']);
    assert.match(c.logs(), /the call was already over \(the phone ended the call \(error 138021: media receive timeout\)\)/); assert.doesNotMatch(c.logs(), /hung up \(/);
  });
});

test('a call from a person who is already in a call in the app is refused as busy, and the Call is never started', async () => {
  const { id, phone: num } = linked(); posts.length = 0; engine.opened = 0; care.liveCalls.set(id, { fake: true });
  try {
    const out = await capture(async () => assert.deepEqual(await wa.handleWebhook(callIn(num, { sdp: 'v=0 x' })), ['rejected']));
    assert.match(out, /rejected call [0-9a-f]{6} from number ending \d{4}: that person is already in a call in the app/); assert.deepEqual(actions(), ['reject']); assert.equal(engine.opened, 0);
  } finally { care.liveCalls.delete(id); }
});
