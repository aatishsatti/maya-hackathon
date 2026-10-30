// WhatsApp call answerer (whatsapp.js calls this): the signalling and the WebRTC media for ONE call. It answers a call from a linked, opted-in person and hands it to
// the app's own Call (call.js) through wabridge.js, so Maya greets, listens, answers, and says goodbye exactly as in the app. This file never logs a word.
// Docs read (developers.facebook.com/docs/whatsapp/cloud-api/calling/user-initiated-calls, .../calling/reference):
//   1. The `connect` webhook carries the caller's SDP OFFER (session { sdp_type: "offer", sdp }). Meta's samples: a=ice-lite, a=setup:actpass, Opus on payload type 111,
//      plus G722 / PCMU / PCMA / telephone-event, a=rtcp-mux. Answers in the samples: a=setup:active.
//   2. POST {Phone-Number-ID}/calls { messaging_product: "whatsapp", call_id, action: "pre_accept", session: { sdp_type, sdp } } with OUR answer SDP.
//      The docs' parameter table says sdp_type is "offer" but every request example uses "answer": "answer" is sent here (to be confirmed by the first live call).
//   3. Wait for the WebRTC connection (ICE + DTLS). Then POST the same body with action "accept" and the SAME sdp (a different one is refused:
//      "SDP answer provided in accept does not match the SDP answer given in the Pre-Accept endpoint for the same call-id").
//   4. Media flows ONLY after the accept came back 200 (earlier: the caller misses the first words; later: silence). About 30 to 60 s after `connect` to accept.
//      So the speech is made WHILE the connection comes up (started before the pre_accept) and is ready when the accept goes out: no silence after the person answers.
//   5. POST action "terminate" ends the call even if media says RTCP BYE. Failure codes arrive in the terminate webhook: 138019 setup failed, 138020 relay
//      connection failed, 138021 / 138022 media receive / transmit timeout, 138023 accepted with no media signals.
//   Opus, 48 kHz, 20 ms frames (960 samples). Speech arrives as PCM16 mono 24 kHz and is doubled to 48 kHz (linear) before encoding. WhatsApp only takes SHA-256 DTLS fingerprints (the pipecat reference client strips the others), so only sha-256 lines are kept.
//   No STUN / TURN is documented. Meta's side is ICE-lite, so this side makes the outbound checks; no STUN server is asked (iceServers: []).
//   Media must never stop: the phone ends a call that gets no media for about 30 s (138021, status FAILED), so after the accept a packet goes out every 20 ms, silence when she is not speaking.
// Library: werift 0.25.2 (MIT, pure JS, no native build) for WebRTC; opusscript (already used for voice notes) for Opus.
const { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useOPUS } = require('werift');
const OpusScript = require('opusscript');
const { PhoneBridge } = require('./wabridge');
const crypto = require('node:crypto');

const RATE = 48000, FRAME = 960, FRAME_MS = 20;
const CONNECT_TIMEOUT_MS = 20000; // well inside Meta's 30 to 60 s window to accept
const TAIL_MS = 600;              // after her last frame, so her last word is not cut off by the hang-up
const CALL_CAP_MS = 10 * 60 * 1000; // a prototype call ends after 10 minutes (three paid services run for every minute of it)
const GREETING_TIMEOUT_MS = 15000;  // her greeting must be ready this soon after the media connects, or the call is refused

const keepSha256Only = (sdp) => sdp.split(/\r?\n/).filter((l) => !(l.startsWith('a=fingerprint:') && !l.startsWith('a=fingerprint:sha-256'))).join('\r\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitConnected(pc, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(t); clearInterval(iv); fn(v); };
    const t = setTimeout(() => done(reject, new Error(`the media connection did not come up in ${Math.round(ms / 1000)} s (state ${pc.connectionState}, ice ${pc.iceConnectionState}); is outbound UDP allowed?`)), ms);
    const iv = setInterval(() => {
      if (pc.connectionState === 'connected') done(resolve);
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') done(reject, new Error(`the media connection ${pc.connectionState} (ice ${pc.iceConnectionState})`));
    }, 25);
  });
}

// PCM16 LE mono 24 kHz -> 48 kHz: every sample, then the average with the next one (speech, so a linear step is plenty).
function upsample2(pcm) {
  const n = pcm.length >> 1, out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = pcm.readInt16LE(i * 2), b = i + 1 < n ? pcm.readInt16LE((i + 1) * 2) : a;
    out.writeInt16LE(a, i * 4); out.writeInt16LE((a + b) >> 1, i * 4 + 2);
  }
  return out;
}

// The outgoing media, ONE continuous stream from the accept to the hang-up: a 20 ms wall clock sends exactly one Opus packet per tick, her voice (48 kHz PCM16 mono
// queued with say()) when she has some, otherwise a frame of SILENCE. Never stopping the stream matters: the phone ends a call that receives no media for about 30 s
// (error 138021 "Media receive timeout", status FAILED) and she is silent whenever she is only listening. One RTP sequence / timestamp counter across speech and silence.
class Outbound {
  constructor(track, payloadType) {
    this.track = track; this.pt = payloadType; this.enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0); this.seq = crypto.randomBytes(2).readUInt16BE(0); this.ts = crypto.randomBytes(4).readUInt32BE(0);
    this.queue = Buffer.alloc(0); this.waiters = []; this.timer = null; this.stopped = false; this.first = true; this.sent = 0; this.silent = 0;
    this.failed = new Promise((res) => { this.signalFailed = res; }); // resolves with the Error if a frame cannot be made or sent
  }
  start() {
    this.next = Date.now();
    const loop = () => {
      if (this.stopped) return;
      const now = Date.now(); let n = 0;
      while (this.next <= now && n++ < 50 && !this.stopped) { this.tick(); this.next += FRAME_MS; }   // late: send the frames that were due, in order
      if (this.next <= now) this.next = now + FRAME_MS;
      this.timer = setTimeout(loop, Math.max(1, this.next - Date.now()));
    };
    loop();
  }
  tick() {
    try {
      for (const w of this.waiters) if (w.aborted()) { this.queue = Buffer.alloc(0); break; }  // she was stopped: her queued words are dropped
      const voice = this.queue.length > 0, chunk = Buffer.alloc(FRAME * 2);
      if (voice) { this.queue.copy(chunk, 0, 0, Math.min(this.queue.length, FRAME * 2)); this.queue = this.queue.subarray(Math.min(this.queue.length, FRAME * 2)); }
      this.track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: this.pt, sequenceNumber: this.seq, timestamp: this.ts, ssrc: this.ssrc, marker: this.first }), Buffer.from(this.enc.encode(chunk, FRAME))));
      this.first = false; this.seq = (this.seq + 1) & 0xffff; this.ts = (this.ts + FRAME) >>> 0; this.sent++; if (!voice) this.silent++;
      if (this.queue.length === 0 && this.waiters.length) { const w = this.waiters; this.waiters = []; w.forEach((x) => x.res()); }
    } catch (e) { this.error = e; this.stopped = true; clearTimeout(this.timer); this.waiters.forEach((x) => x.rej(e)); this.waiters = []; this.signalFailed(e); }
  }
  // Queues 48 kHz PCM16 mono; resolves when its last frame has been sent (or at once if aborted() turns true).
  say(pcm48, aborted = () => false) { if (this.stopped) return Promise.reject(this.error || new Error('the outgoing stream has stopped')); return new Promise((res, rej) => { this.queue = Buffer.concat([this.queue, pcm48]); this.waiters.push({ res, rej, aborted }); }); }
  // Drops everything queued (she was interrupted); the waiting say() calls resolve.
  flush() { this.queue = Buffer.alloc(0); const w = this.waiters; this.waiters = []; w.forEach((x) => x.res()); }
  // Resolves when everything queued so far has been sent.
  drain() { return this.queue.length === 0 ? Promise.resolve() : new Promise((res) => { this.waiters.push({ res, rej: res, aborted: () => false }); }); }
  stop() { this.stopped = true; clearTimeout(this.timer); try { this.enc.delete && this.enc.delete(); } catch { /* ignore */ } }
}

// send(action, session?) posts to {phone id}/calls (whatsapp.js owns the Graph call and the token). newCall(socket, apiKey) makes the app's Call (call.js).
// speak(text) -> PCM16 24 kHz (Maya's voice), used only for the one fixed fatal line. ended: a promise that resolves, with the reason, when the CALLER's side ends the
// call (the terminate webhook): then the call is already over on Meta's side and nothing more is sent. log(text): one plain line, no SDP, no numbers, no words.
// Order: pre_accept; media connects; the Call starts and her greeting is made WHILE the phone is still ringing; accept (so she speaks the moment they pick up);
// then the conversation until she says goodbye, the caller (or the phone) ends it, the media drops, or the 10-minute cap. Returns the end reason; throws if a step
// failed, after trying reject (before the accept) or terminate (after it): a call is never answered with silence or a fake reply.
async function answerWithBridge({ offerSdp, send, log, speak, newCall, apiKey, profileId, tz, ended = new Promise(() => {}), connectTimeoutMs = CONNECT_TIMEOUT_MS, tailMs = TAIL_MS, capMs = CALL_CAP_MS, greetingTimeoutMs = GREETING_TIMEOUT_MS }) {
  const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()], video: [] }, iceServers: [] });
  const track = new MediaStreamTrack({ kind: 'audio' });
  const tx = pc.addTransceiver(track, { direction: 'sendrecv' });
  let bridge = null, out = null, accepted = false, over = false, overReason = null;
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => { if (bridge) bridge.hear(rtp); })); // subscribed BEFORE the offer is applied: the track appears then
  ended.then((r) => { over = true; overReason = r || 'caller hung up'; });
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    const session = { sdp_type: 'answer', sdp: keepSha256Only(pc.localDescription.sdp) };
    const codec = (tx.codecs || []).find((c) => /opus/i.test(c.name)) || (pc.getTransceivers()[0].codecs || [])[0];
    if (!codec) throw new Error('the offer has no Opus audio');
    await send('pre_accept', session);
    log(`pre-accepted (Opus payload type ${codec.payloadType}, answer ${session.sdp.length} bytes)`);
    await waitConnected(pc, connectTimeoutMs);
    log('media connected (ICE and DTLS up)');
    bridge = new PhoneBridge({ newCall, apiKey, profileId, tz, log, speak });
    bridge.begin();
    let tm; const timeout = new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('her greeting was not ready in time')), greetingTimeoutMs); });
    try { await Promise.race([bridge.greeting, timeout, bridge.done.then((r) => { throw new Error(`the call brain stopped before the greeting (${bridge.error || r})`); }), ended.then((r) => { throw new Error(`the call ended before it was answered (${r || 'caller hung up'})`); })]); }
    finally { clearTimeout(tm); }
    log(`her greeting is ready ${Date.now() - bridge.born} ms after the media connected`);
    await send('accept', session);   // the SAME sdp as the pre-accept; media only after this returned 200
    accepted = true;
    out = new Outbound(track, codec.payloadType); out.start();   // from now on a packet every 20 ms, silence when she is not speaking
    bridge.attach(out);
    log('accepted; the conversation has started');
    const lost = pcLost(pc); let capTimer; const cap = new Promise((res) => { capTimer = setTimeout(() => res('time cap'), capMs); });
    const why = await Promise.race([bridge.done, ended.then((r) => r || 'caller hung up'), cap, lost.promise.then(() => 'the media connection dropped'), out.failed.then((e) => { throw e; })]);
    clearTimeout(capTimer); lost.cancel();
    if (!over && why === 'fatal') { await bridge.sayFatal(tailMs); }
    else if (!over && why === 'maya hung up') { await out.drain(); await sleep(tailMs); }
    bridge.stop(why);
    if (over || why === overReason) log(`the call was already over (${why}); nothing more to send`);
    else { await send('terminate'); log(`hung up (${why})`); }
    return why;
  } catch (e) {
    if (bridge) bridge.stop('failed');
    if (!over) { try { await send(accepted ? 'terminate' : 'reject'); } catch (e2) { log(`could NOT ${accepted ? 'terminate' : 'reject'} after the failure: ${String(e2.message).slice(0, 160)}`); } }
    throw e;
  } finally {
    if (bridge) bridge.stop('call over'); if (out) out.stop();
    try { await pc.close(); } catch { /* already closed */ }
  }
}
// Resolves when the media connection is gone; cancel() stops the polling.
function pcLost(pc) {
  let iv; const promise = new Promise((res) => { iv = setInterval(() => { if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) res(); }, 200); });
  return { promise, cancel: () => clearInterval(iv) };
}


// ---- the first outbound test call (business-initiated) ----
// Docs read (developers.facebook.com/docs/whatsapp/cloud-api/calling/business-initiated-calls and .../calling/reference):
//   POST {Phone-Number-ID}/calls { messaging_product: "whatsapp", to, action: "connect", session: { sdp_type: "offer", sdp } }   (OUR offer; the sample has a=setup:actpass, sha-256, Opus 48000/2)
//     -> { messaging_product, calls: [{ id: "wacid..." }] }. The call needs the person's call permission (error 138006 when they have not granted it).
//   The SDP ANSWER arrives in a webhook, field "calls": value.calls[] { id, event: "connect", direction: "BUSINESS_INITIATED", session { sdp_type: "answer", sdp } }. Applied to the peer connection.
//   Then webhooks with value.statuses[] { id, type: "call", status: "RINGING" | "ACCEPTED" | "REJECTED", recipient_id, timestamp } (REJECTED is followed by a terminate webhook).
//   POST action "terminate" (call_id) ends it; the docs ask for it even when the media says RTCP BYE. A terminate webhook (direction BUSINESS_INITIATED, status COMPLETED | FAILED,
//   errors[], and start_time / end_time / duration only when they picked up; an unanswered call is COMPLETED with none) follows whoever ended it. No ring time-out is documented: it is 45 s here.
//   No pre_accept / accept for this direction (the docs' business-initiated flow uses only connect and terminate). Media: the docs tie it to applying the answer; here it starts after ACCEPTED
//   and the peer connection being up, so nothing is said into a ringing phone.
const TEST_CALL_LINE = "Hello, this is Maya. This is a test call to check that I can ring you. I'll hang up now. Goodbye.";
const RING_CAP_MS = 45000;
const MEDIA_UP_MS = 15000;
const STATUSES = ['RINGING', 'ACCEPTED', 'REJECTED'];

// sig: an EventEmitter the webhooks feed: 'answer' (sdp text), 'status' (RINGING | ACCEPTED | REJECTED), 'end' (reason text; the terminate webhook).
// place(session) -> posts the connect and resolves once Meta took it (throws if refused: nothing rang). terminate() -> posts the terminate for this call.
// speak(text) -> PCM16 24 kHz. The sentence is made BEFORE anything is placed: if her voice does not work, the phone never rings. log(text): one line, no SDP, no number, no word.
// Returns the outcome in plain words; throws if a step failed, after trying terminate. One attempt, no retry.
// bridge (C2, a reminder call): { newCall, apiKey, profileId, tz, outreachId, capMs, greetingTimeoutMs }. Instead of the fixed sentence the app's own Call (call.js) takes the call as soon as they pick up (ACCEPTED):
// its start message carries reason 'reminder' + the outreach id, so the greeting IS the family's reminder (Spark's words, the existing guards) and the acknowledgement rule is the app's. The Call is
// started at ACCEPTED, not while it rings, so "picked up" is never claimed for a ringing phone; the cost is her first words come about as late as the greeting takes (logged).
async function callOut({ sig, place, terminate, log, speak, text = TEST_CALL_LINE, bridge = null, ringCapMs = RING_CAP_MS, mediaUpMs = MEDIA_UP_MS, tailMs = TAIL_MS }) {
  let pcm = null;
  if (!bridge) {
    pcm = await speak(text);
    if (!Buffer.isBuffer(pcm) || pcm.length < 2) throw new Error('her voice could not be made, so nothing was placed');
  }
  const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()], video: [] }, iceServers: [] });
  const track = new MediaStreamTrack({ kind: 'audio' });
  const tx = pc.addTransceiver(track, { direction: 'sendrecv' });
  let out = null, over = null, capTimer = null, t0 = Date.now(), placed = false, br = null;
  const since = () => `${Date.now() - t0} ms`;
  let gotAnswer, gotAccepted, resolveOutcome;
  const answerP = new Promise((r) => { gotAnswer = r; }), acceptedP = new Promise((r) => { gotAccepted = r; });
  const outcome = new Promise((r) => { resolveOutcome = r; });
  outcome.then((o) => { over = o; });
  const onAnswer = (sdp) => gotAnswer(sdp), onEnd = (why) => resolveOutcome({ kind: 'ended', reason: why || 'ended' });
  const seen = new Set();
  const onStatus = (s) => {
    if (!STATUSES.includes(s)) { log('a call status this build does not know (not RINGING, ACCEPTED or REJECTED)'); return; }
    if (seen.has(s)) return; seen.add(s);
    log(`${s} ${since()} after the request`);
    if (s === 'ACCEPTED') gotAccepted(true); else if (s === 'REJECTED') resolveOutcome({ kind: 'rejected', reason: 'they rejected it' });
  };
  sig.once('answer', onAnswer); sig.on('status', onStatus); sig.once('end', onEnd);
  const step = (p) => { Promise.resolve(p).catch(() => {}); return Promise.race([Promise.resolve(p).then((v) => ({ ok: true, v })), outcome]); };
  const finish = async (o) => {   // o: { kind: 'cap' | 'ended' | 'rejected', reason }
    if (o.kind === 'cap') { await terminate(); log(`no answer in ${Math.round(ringCapMs / 1000)} s: hung up the request`); return `no answer in ${Math.round(ringCapMs / 1000)} s`; }
    log(`the call is already over (${o.reason}); nothing more to send`); return o.kind === 'rejected' ? 'rejected' : `ended: ${o.reason}`;
  };
  // The conversation, as an answered inbound call: her greeting (the reminder) is ready, the stream starts, the Call runs until it ends, the caller leaves, the media drops or the cap.
  const converse = async () => {
    let tm; const timeout = new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('her reminder was not ready in time')), bridge.greetingTimeoutMs || GREETING_TIMEOUT_MS); });
    try { await Promise.race([br.greeting, timeout, br.done.then((x) => { throw new Error(`the call brain stopped before the reminder (${br.error || x})`); }), outcome.then((o) => { throw Object.assign(new Error('over'), { over: o }); })]); }
    catch (e) { if (e.over) return await finish(e.over); throw e; }
    finally { clearTimeout(tm); }
    log(`her first words are ready ${Date.now() - br.born} ms after the media connected`);
    out = new Outbound(track, codecPt); out.start(); br.attach(out);
    log('picked up; the reminder call has started');
    const lost = pcLost(pc); let capTimer2; const cap = new Promise((res) => { capTimer2 = setTimeout(() => res('time cap'), bridge.capMs || CALL_CAP_MS); });
    let why;
    try { why = await Promise.race([br.done, outcome.then((o) => ({ over: o })), cap, lost.promise.then(() => 'the media connection dropped'), out.failed.then((e) => { throw e; })]); }
    finally { clearTimeout(capTimer2); lost.cancel(); }
    if (why && why.over) { br.stop('they ended it'); return await finish(why.over); }
    if (why === 'fatal') await br.sayFatal(tailMs); else if (why === 'maya hung up') { await out.drain(); await sleep(tailMs); }
    br.stop(why);
    if (over) return await finish(over);
    await terminate(); log(`hung up ${since()} after the request (${why})`);
    return 'completed';
  };
  let codecPt = 111;
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => { if (br) br.hear(rtp); })); // THE EARS: the caller's audio goes to the Call (the answerer does the same; C2 forgot it, so she heard silence). Subscribed BEFORE the answer is applied: the track appears then
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await place({ sdp_type: 'offer', sdp: keepSha256Only(pc.localDescription.sdp) });
    placed = true; t0 = Date.now();
    log('requested: Meta took the call, waiting for its answer');
    capTimer = setTimeout(() => resolveOutcome({ kind: 'cap', reason: 'ring cap' }), ringCapMs);
    let r = await step(answerP); if (!r.ok) return await finish(r);
    await pc.setRemoteDescription({ type: 'answer', sdp: r.v });
    const codec = (tx.codecs || []).find((c) => /opus/i.test(c.name)) || (pc.getTransceivers()[0].codecs || [])[0];
    if (!codec) throw new Error('the answer has no Opus audio');
    codecPt = codec.payloadType;
    log(`answer applied ${since()} after the request (Opus payload type ${codec.payloadType})`);
    r = await step(acceptedP); if (!r.ok) return await finish(r);
    clearTimeout(capTimer); capTimer = null;
    if (bridge) {
      br = new PhoneBridge({ newCall: bridge.newCall, apiKey: bridge.apiKey, profileId: bridge.profileId, tz: bridge.tz, log, speak, outbound: true });
      br.begin({ reason: 'reminder', outreachId: bridge.outreachId });
    }
    r = await step(waitConnected(pc, mediaUpMs)); if (!r.ok) return await finish(r);
    log(`media up ${since()} after the request`);
    if (bridge) return await converse();
    out = new Outbound(track, codec.payloadType); out.start();
    r = await step(out.say(upsample2(pcm))); if (!r.ok) return await finish(r);
    log('the fixed sentence was spoken');
    await sleep(tailMs);
    if (over) return await finish(over);
    await terminate(); log(`hung up ${since()} after the request`);
    return 'completed';
  } catch (e) {
    if (placed && !over) { try { await terminate(); } catch (e2) { log(`could NOT hang up after the failure: ${String(e2.message).slice(0, 160)}`); } }
    throw e;
  } finally {
    clearTimeout(capTimer); sig.off('answer', onAnswer); sig.off('status', onStatus); sig.off('end', onEnd);
    if (br) br.stop('call over'); if (out) out.stop();
    try { await pc.close(); } catch { /* already closed */ }
  }
}

module.exports = { answerWithBridge, callOut, TEST_CALL_LINE, Outbound, keepSha256Only, upsample2 };
