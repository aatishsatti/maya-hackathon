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
const sparkAsked = [], ttsTexts = [];
let sparkReply = `${SAY} Hello there, it is nice to talk to you. How has your day been so far?`, sparkFails = false;
const TTS_S = 0.5;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (_h, roster, _s, onDelta) => { sparkAsked.push(roster); if (sparkFails) throw new Error('Meta Spark failed (HTTP 500)'); const r = typeof sparkReply === 'function' ? sparkReply() : sparkReply; if (onDelta) onDelta(r); return r; },
  streamSpeech: async (text, _signal, onChunk) => { ttsTexts.push(text); const N = 24000 * TTS_S, b = Buffer.alloc(N * 2); for (let i = 0; i < N; i++) b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 300 * i / 24000)), i * 2); onChunk(b); },
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
const { Call, latencyForLog } = require('../call');
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
    step('respond'); c.callRef.send({ type: 'speechEnd' }); /* the Call's own end-of-turn event, as it sends before answering */ c.callRef.pending = [turn('I had tea with my neighbour this morning')]; await c.callRef.respond(0); step('responded');
    await until(() => c.ph.heard.length > before + 20); step('reply heard'); // her reply reaches the phone
    await hangUpPhone(c.phone, c.p); step('hung up');
    await c.running; step('running done'); assert.equal(c.result[0], 'answered');
    out = c.logs();
    assert.deepEqual(actions(), ['pre_accept', 'accept'], 'the caller hung up: nothing more is sent'); assert.ok(c.callRef.closed, 'the Call was ended (memory filed as in the app)'); assert.equal(care.liveCalls.get(c.id), undefined);
    const gaps = c.ph.heard.at.slice(1).map((t, i) => t - c.ph.heard.at[i]); assert.ok(Math.max(...gaps) < 200, `her stream never stops (largest gap ${Math.max(...gaps)} ms)`);
  });
  assert.match(out, /pre-accepted/); assert.match(out, /media connected/); assert.match(out, /her greeting is ready \d+ ms after the media connected/); assert.ok(out.indexOf('her greeting is ready') < out.indexOf('accepted; the conversation has started'));
  assert.match(out, /she spoke on her own \(the greeting, a check-in or a reminder\), not as an answer/); assert.match(out, /reply 1: first audio \d+ ms after your turn ended, \d+ ms after your last sound/); assert.match(out, /ears ended \(caller hung up\): \d+ packets received, \d+ put back in order, \d+ lost, \d+ late or repeated, 0 unreadable, 0 ms dropped for lag, \d+ ms kept before the engine was ready, [\d.]+ s heard, worst timer lateness \d+ ms/);
  assert.match(out, /conversation over \(caller hung up\): \d+ turn\(s\) heard, \d+ answers? timed, \d+ turn\(s\) answered together with another, \d+ not answered, 1 line\(s\) she began on her own/); assert.match(out, /answered call [0-9a-f]{6}.*conversation, caller hung up/);
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

// ---- the reply timer and the turn counts, on their own (no network, no peer) ----
function bareBridge() {
  const logs = []; const b = new wabridge.PhoneBridge({ newCall: () => ({ closed: false, end() {} }), apiKey: 'k', profileId: 'p', tz: null, log: (m) => logs.push(m), speak: async () => Buffer.alloc(0) });
  b.out = { say: () => Promise.resolve(), flush() {} }; b.accepted = true;
  return { b, logs };
}
const frame = (peak) => { const f = Buffer.alloc(1920); for (let i = 0; i < 960; i += 2) { f.writeInt16LE(Math.round(peak * 32767), i * 2); f.writeInt16LE(Math.round(-peak * 32767), i * 2 + 2); } return f; };
const feed = (b, peak, frames) => { for (let i = 0; i < frames; i++) b.toCall(frame(peak)); };
const voice = () => Buffer.alloc(9600);

test('reply timer: one stray loud frame does not reset "your last sound"; a sustained sound does', async () => {
  const { b, logs } = bareBridge(); feed(b, 0.004, 50);
  feed(b, 0.3, 10); feed(b, 0.004, 5);                                // real speech, then a quiet gap
  await sleep(120); feed(b, 0.3, 1); feed(b, 0.004, 2);              // then ONE stray loud frame (a click or cough), then quiet
  b.onEvent({ type: 'speechEnd' }); await sleep(150); b.onVoice(voice());
  const m = /reply 1: first audio (\d+) ms after your turn ended, (\d+) ms after your last sound/.exec(logs.join('\n'));
  assert.ok(m, logs.join('\n')); assert.ok(Number(m[2]) >= Number(m[1]), 'the last SOUND is at or before the end of turn');
  assert.ok(Number(m[2]) >= 250, `"your last sound" was the speech 270 ms ago, not the stray frame (${m[2]} ms)`);
});

test('reply timer: the room\'s noise level is learned (as call.js does), so a sound only slightly above a noisy room is not "your last sound", while real speech is', () => {
  const { b, logs } = bareBridge();
  feed(b, 0.012, 300);                                               // a noisy room, below the 0.02 floor: learned
  assert.ok(b.noise > 0.01 && b.noise < 0.013, `the room level was learned (${b.noise.toFixed(4)})`);
  feed(b, 0.025, 10); assert.equal(b.lastSoundAt, 0, '0.025 is above 0.02 but not 3 x this room: not a sound');
  feed(b, 0.4, 6); assert.ok(b.lastSoundAt > 0, 'real speech above the room counts'); const spoke = b.lastSoundAt; feed(b, 0.012, 40); assert.equal(b.lastSoundAt, spoke);
  b.onEvent({ type: 'speechEnd' }); b.onVoice(voice()); assert.match(logs.join('\n'), /reply 1: first audio \d+ ms after your turn ended, \d+ ms after your last sound/);
});

test('reply timer: two turns answered together are said so and counted as merged; a line she begins on her own is not an answer; chunks of one reply are one reply', async () => {
  const { b, logs } = bareBridge();
  b.onVoice(voice()); assert.match(logs.join('\n'), /she spoke on her own/);
  await sleep(1300); b.onEvent({ type: 'speechEnd' }); await sleep(30); b.onEvent({ type: 'speechEnd' }); await sleep(30);
  b.onVoice(voice()); b.onVoice(voice()); b.onVoice(voice());       // one reply, three chunks
  assert.match(logs.join('\n'), /reply 1: first audio \d+ ms after your turn ended(, \d+ ms after your last sound)?; 2 turns of yours were answered together/); assert.equal(logs.filter((l) => /^reply /.test(l)).length, 1);
  b.onEvent({ type: 'speechEnd' }); b.stop('test');                  // a turn left unanswered when the call ends
  assert.match(logs.join('\n'), /conversation over \(test\): 3 turn\(s\) heard, 1 answer timed, 1 turn\(s\) answered together with another, 1 not answered, 1 line\(s\) she began on her own, slowest \d+ ms after your turn ended/);
});

// ---- no words in the call logs ----
test('the call\'s latency log line shows numbers and flags only; what the person said is logged only under TURN_DEBUG', () => {
  const timing = { holdMs: 0, metaEndpointMs: 120, endedAt: 5, decidedAt: 1700000000000, guess: 'hit', heard: 'my private tulips sentence', predicted: 'my private tulips', ttsFirstMs: 300, speechEndToFirstAudioMs: 1800, replyReadyMs: 900, noVoice: false, note: 'a text field added later' };
  const line = JSON.stringify(latencyForLog(timing, false)); assert.doesNotMatch(line, /tulips|heard|predicted|text field/); assert.match(line, /"speechEndToFirstAudioMs":1800/); assert.match(line, /"guess":"hit"/); assert.doesNotMatch(line, /endedAt/);
  assert.match(JSON.stringify(latencyForLog(timing, true)), /tulips/, 'TURN_DEBUG still shows the words, for a developer at a desk');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'), /console\.log\('latency', JSON\.stringify\(latencyForLog\(timing\)\)\)/, 'the real log line goes through the filter');
});

// ---- the goodbye after a silence on a WhatsApp call: never a call-back promise ----
const { CALL_PROMISE, WHATSAPP_GOODBYE_LINE, timerOpenFact } = require('../call');
const QUIET = (said) => `${SAY} ${said}`;
function quietCall(whatsapp, userTurns = 0) {
  const sent = []; const ws = { send: (d) => sent.push(d), close() {}, onmessage: null, onclose: null, ...(whatsapp ? { noRingback: true } : {}) };
  const c = new Call(ws, 'k'); clearInterval(c.endTimer); /* a bare Call has no endpoint ticker to run */ c.profile = memory.load(memory.createProfile(`Quiet${letters(n++)}`, 'female').id); c.userTurns = userTurns; c.gen = 1; c.abort = new AbortController();
  return c;
}

test('call-promise detector: catches "ring you right back", "call you", "talk in a moment" and friends; lets "you are welcome to call me again" and the fixed line through', () => {
  for (const t of ["I'll hang up for now and ring you right back to check. Talk in a moment.", 'I will call you back soon.', 'Talk in a moment.', "I'm going to call you in a minute.", "I'll be right back.", 'Let me give you a call later.', "I'll ring you shortly.", 'Calling you back now.'])
    assert.ok(CALL_PROMISE.test(t), `should be caught: ${t}`);
  for (const t of [WHATSAPP_GOODBYE_LINE, "You're welcome to call me again whenever you like. Goodbye.", 'Take care, and call me any time.', "I'm here whenever you want to talk. Goodbye for now.", 'Talk soon, take care.', 'Please call again whenever you like.', 'It is okay, take your time.'])
    assert.ok(!CALL_PROMISE.test(t), `should be let through: ${t}`);
  assert.equal(WHATSAPP_GOODBYE_LINE, "I'm going to hang up for now. You're welcome to call me again whenever you like. Goodbye.", 'the approved fallback, word for word');
});

test('WhatsApp goodbye prompts: no call-back promise asked for, "mistake or pocket dial" dropped for a caller who said nothing; the in-app prompts are unchanged', async () => {
  sparkReply = QUIET('Take care for now.');
  for (const [talked, mustHave, mustNotAsk] of [[1, /welcome to call you again whenever they like.*never say you will call, ring or call them back/s, /will call right back in a moment to check/], [0, /cannot hear anything.*never say you will call, ring or call them back.*do not say it was a mistake or a pocket dial/s, /say it seems the call was a mistake or a pocket dial/]]) {
    sparkAsked.length = 0; await quietCall(true, talked).quietLine(2, new AbortController().signal);
    assert.match(sparkAsked[0], mustHave); assert.doesNotMatch(sparkAsked[0], mustNotAsk);
    sparkAsked.length = 0; await quietCall(false, talked).quietLine(2, new AbortController().signal);
    assert.match(sparkAsked[0], talked ? /will call right back in a moment to check they are alright/ : /it seems the call was a mistake or a pocket dial, so you are hanging up for now and will call right back/);
  }
});

test('a WhatsApp goodbye that promises a call-back is rejected and rewritten (up to 4 attempts); if every attempt promises one, the fixed line is used', async () => {
  let k = 0; sparkReply = () => QUIET(k++ < 2 ? "I'll hang up now and ring you right back. Talk in a moment." : 'I will hang up for now. Take good care of yourself.');
  sparkAsked.length = 0; let line = await quietCall(true).quietLine(2, new AbortController().signal);
  assert.ok(!CALL_PROMISE.test(line.said), line.said); assert.ok(sparkAsked.length >= 3, 'it asked again after each rejected attempt'); assert.ok(!line.fixed);
  assert.match(sparkAsked[1], /do not say you will call, ring or call them back/);
  sparkReply = QUIET("I'll ring you right back in a moment to check on you."); sparkAsked.length = 0;
  line = await quietCall(true).quietLine(2, new AbortController().signal); assert.equal(line.said, WHATSAPP_GOODBYE_LINE); assert.equal(line.fixed, true); assert.equal(sparkAsked.length, 4, 'four attempts, then the fixed line');
  assert.ok(/^\[\[feel: .*intent=farewell/.test(line.full));
});

test('in an in-app call the goodbye is unchanged: a call-back line is accepted as it always was', async () => {
  sparkReply = QUIET("I'll hang up for now and ring you right back to check. Talk in a moment."); sparkAsked.length = 0;
  const line = await quietCall(false).quietLine(2, new AbortController().signal); assert.match(line.said, /ring you right back/); assert.ok(!line.fixed); assert.equal(sparkAsked.length, 1);
});

test('end to end on a WhatsApp call: a goodbye that promises a call-back is replaced by the fixed line, spoken whole, then we hang up', async () => {
  sparkReply = QUIET('Hello there, it is nice to talk to you.'); let c0;
  await withCall({}, async (c) => {
    await until(() => c.ph.heard.length > 15); await sleep(900); c0 = c;
    sparkReply = QUIET("I'll hang up for now and ring you right back to check. Talk in a moment."); ttsTexts.length = 0;
    c.callRef.silenceStage = 2; await c.callRef.fireSilence();
    await c.running; assert.equal(c.result[0], 'answered');
    assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']); assert.match(c.logs(), /hung up \(maya hung up\)/);
    const said = ttsTexts.join(' '); assert.match(said, /hang up for now/); assert.match(said, /welcome to call me again whenever you like/); assert.match(said, /Goodbye/); assert.doesNotMatch(said, /ring you|right back|in a moment/, 'no promise reaches her voice');
    assert.equal(care.activeByProfile.get(c.id), undefined, 'and still no in-app ring-back');
  });
  assert.ok(c0);
});

// ---- a reminder timer only lives while the call is open: she must say so ----
const dropTimers = (c) => { for (const t of c.timers) clearTimeout(t.handle); c.timers = []; };

test('asking for a reminder: the note tells her to confirm AND to say they must stay on the call; the timer records when it is due', () => {
  const c = quietCall(true); const note = c.careNotes('Can you remind me in 30 seconds to drink water?');
  assert.match(note, /remind them in 30 seconds about "drink water"/); assert.match(note, /need to stay on the call for it, because the reminder only works while the call is open/);
  assert.equal(c.timers.length, 1); assert.ok(Math.abs(c.timers[0].dueAt - (Date.now() + 30000)) < 1000); assert.doesNotMatch(note, /ONLY work while this call stays open/, 'the confirmation is not doubled with the standing fact'); dropTimers(c);
});

test('while a timer is pending, the next turn carries the standing fact (the same in the app and on WhatsApp); with no timer, or once it has gone, there is none', () => {
  const wa = quietCall(true), app = quietCall(false); const facts = [];
  for (const c of [wa, app]) {
    c.careNotes('Please remind me in 20 minutes to take my tablets.');
    const note = c.careNotes('Can I hang up now?'); facts.push(note);
    assert.match(note, /FACT: a reminder timer is running right now, and it is the only one set: "take my tablets" \(due in about \d+ minutes\)/);
    assert.match(note, /They ONLY work while this call stays open/); assert.match(note, /when the call ends the app drops them and nothing will remind them afterwards/); assert.match(note, /ask about hanging up, leaving or ending the call, or they say goodbye/);
    assert.match(note, /Never say they can hang up whenever they like without saying that, never say you will remind them later or after the call, and never say you will call, ring or message them/);
    dropTimers(c); assert.doesNotMatch(c.careNotes('Can I hang up now?'), /reminder timer/, 'no timer, no fact');
  }
  assert.equal(facts[0], facts[1], 'identical in-app and on WhatsApp');
  const fresh = quietCall(true); assert.doesNotMatch(fresh.careNotes('Can I hang up now?'), /reminder timer/);
});

test('the written chat is unchanged (it cannot set a timer, and so has no standing fact); a timer that is too long says so', () => {
  const c = quietCall(false); c.noTimers = true; const note = c.careNotes('Remind me in 5 minutes to call my sister.'); assert.match(note, /you cannot set one/); assert.doesNotMatch(note, /reminder timer|stay on the call/); assert.equal(c.timers.length, 0);
  const d = quietCall(true); assert.match(d.careNotes('Remind me in 5 hours to rest.'), /too long or unclear/); assert.doesNotMatch(d.careNotes('Okay.'), /reminder timer/);
});

test('the written chat (chat.js borrows careNotes and has no timers list) still works and has no timer fact', () => {
  const { ChatSession } = require('../chat'); assert.equal(typeof ChatSession, 'function');
  const session = Object.create(ChatSession.prototype); Object.assign(session, { profile: memory.load(memory.createProfile(`Chat${letters(n++)}`, 'female').id), noTimers: true, userTurns: 0 });
  assert.equal(session.timers, undefined); assert.doesNotMatch(session.careNotes('Can I hang up now?'), /reminder timer/);
});

test('timerOpenFact: seconds are rounded the way a person says them', () => {
  const now = 1000000; assert.match(timerOpenFact([{ dueAt: now + 20000 }], now), /due in about 20 seconds/); assert.match(timerOpenFact([{ dueAt: now + 500 }], now), /due in about 1 second\)/); assert.match(timerOpenFact([{ dueAt: now + 300000 }, { dueAt: now + 900000 }], now), /due in about 5 minutes/);
});

test('on a whole WhatsApp call: Spark is told the reminder needs the call open, both when it is set and when she is asked about hanging up', async () => {
  sparkReply = QUIET('Hello there, it is nice to talk to you.');
  await withCall({}, async (c) => {
    await until(() => c.ph.heard.length > 15); await sleep(900); sparkReply = QUIET('Okay, I will remind you.');
    sparkAsked.length = 0; c.callRef.pending = [turn('Can you remind me in 20 minutes to drink water?')]; await c.callRef.respond(0);
    assert.ok(sparkAsked.some((r) => /stay on the call for it, because the reminder only works while the call is open/.test(r)), 'told when the timer was set');
    sparkAsked.length = 0; c.callRef.pending = [turn('Can I hang up now?')]; await c.callRef.respond(0);
    assert.ok(sparkAsked.some((r) => /They ONLY work while this call stays open/.test(r) && /nothing will remind them afterwards/.test(r)), 'told when she is asked about hanging up');
    // and the log says WHICH kinds of fact each reply was given, by name only
    const facts = c.logs().split('\n').filter((l) => l.startsWith('reply facts '));
    assert.ok(facts.some((l) => l === 'reply facts {"source":"written-now","labels":["timer-set"],"turns":1}'), facts.join(' | '));
    assert.ok(facts.some((l) => l === 'reply facts {"source":"written-now","labels":["timer-open"],"turns":1}'), facts.join(' | '));
    assert.doesNotMatch(facts.join('\n'), /water|hang up|remind/i, 'names only: no word from the turns');
    await hangUpPhone(c.phone, c.p); await c.running; assert.ok(c.callRef.closed); assert.ok(c.callRef.timers.every((t) => t.handle), 'the timer was set');
  });
});

// ---- Fix E: the standing fact LISTS the running timers, so "any reminders for me?" is answered truthfully ----
test('Fix E: the fact names each running timer and when it is due, sorted by due time; one with no thing named is said so; a reminder already given is not listed', () => {
  const c = quietCall(true);
  c.careNotes('Okay can you remind me in 20 seconds that I have to call my sister?'); c.careNotes('Remind me in 5 minutes to take my tablets.'); c.careNotes('Remind me in 10 minutes.');
  const note = c.careNotes('Any reminders for me?');
  assert.match(note, /FACT: 3 reminder timers are running right now, and these are the only ones set: "I have to call my sister" \(due in about \d+ seconds?\); "take my tablets" \(due in about [45] minutes\); one with no thing named \(due in about 10 minutes\)\./);
  assert.match(note, /If they ask what reminders you have, or whether anything is set, tell them exactly these in one short sentence and nothing else/);
  assert.match(note, /A reminder you have already given aloud is finished: never list it as still to come/);
  dropTimers(c);
});

test('Fix E: after the first reminder has fired only the second is listed (the transcript that went wrong: medicine fired, sister pending, "any reminders for me?")', () => {
  const c = quietCall(true);
  c.careNotes('Hey Maya, can you remind me in 30 seconds to take my medicine?'); const medicine = c.timers[0]; clearTimeout(medicine.handle); c.timers = c.timers.filter((t) => t !== medicine);   // it has fired
  c.careNotes('Okay can you remind me in 20 seconds that I have to call my sister?');
  const note = c.careNotes('Still here with you. Any reminders for me?');
  assert.match(note, /FACT: a reminder timer is running right now, and it is the only one set: "I have to call my sister"/); assert.match(note, /tell them exactly this one in one short sentence/); assert.doesNotMatch(note, /medicine/);
  dropTimers(c);
});

test('Fix E: still none when nothing is running; the hang-up rule and the never-promise rule are still in it', () => {
  const c = quietCall(false); assert.doesNotMatch(c.careNotes('Any reminders for me?'), /reminder timer/);
  c.careNotes('Remind me in 2 minutes to rest.'); const note = c.careNotes('Can I hang up?');
  assert.match(note, /If they ask about hanging up, leaving or ending the call, or they say goodbye, tell them plainly in one short sentence that the reminder only works while the call stays open and they will not get it if they hang up/);
  assert.match(note, /Never say they can hang up whenever they like without saying that, never say you will remind them later or after the call, and never say you will call, ring or message them/); dropTimers(c);
});

test('Fix E on a whole WhatsApp call: Spark is given the list for "Any reminders for me?" and for "Can I hang up?"', async () => {
  sparkReply = QUIET('Hello there, it is nice to talk to you.');
  await withCall({}, async (c) => {
    await until(() => c.ph.heard.length > 15); await sleep(900); sparkReply = QUIET('Okay.');
    c.callRef.pending = [turn('Can you remind me in 20 minutes that I have to call my sister?')]; await c.callRef.respond(0);
    sparkAsked.length = 0; c.callRef.pending = [turn('Any reminders for me?')]; await c.callRef.respond(0);
    assert.ok(sparkAsked.some((r) => /running right now, and it is the only one set: "I have to call my sister" \(due in about \d+ minutes\)/.test(r) && /tell them exactly this one/.test(r)), 'told what is running when asked what reminders she has');
    sparkAsked.length = 0; c.callRef.pending = [turn('Can I hang up now?')]; await c.callRef.respond(0);
    assert.ok(sparkAsked.some((r) => /call my sister/.test(r) && /hanging up, leaving or ending the call/.test(r)), 'and told the hang-up rule with the same list');
    await hangUpPhone(c.phone, c.p); await c.running; assert.ok(c.callRef.closed);
  });
});
