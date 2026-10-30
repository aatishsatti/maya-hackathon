// WhatsApp call answerer (whatsapp.js calls this). EARS STEP: answers one call, says ONE fixed intro sentence in Maya's real voice (the same chat.deps.speak the app
// and the WhatsApp voice notes use), then LISTENS for a fixed time through the same Meta transcribe engine the app's calls use (waears.js) and hangs up. She cannot
// answer yet, and the intro says so. Only counts are logged: never a word the caller said.
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
const { Ears } = require('./waears');
const crypto = require('node:crypto');

const RATE = 48000, FRAME = 960, FRAME_MS = 20;
const CONNECT_TIMEOUT_MS = 20000; // well inside Meta's 30 to 60 s window to accept
const TAIL_MS = 500;              // after the last frame, so the last word is not cut off by the hang-up
// The fixed sentences. True today: they claim nothing Maya cannot do yet.
const INTRO_LINE = "Hello, this is Maya. I'm only testing my ears on WhatsApp calls. Please say a few sentences now. I can hear you, but I can't answer yet. I'll hang up in thirty seconds.";
const CANT_HEAR_LINE = "I can't hear you right now. Please try again a little later. Goodbye.";
const LISTEN_MS = 30000;          // the intro promises thirty seconds
const GAP_MS = 700;               // between the end of her voice and the start of listening, so her own voice (an echo on a speaker phone) is not transcribed

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
  stop() { this.stopped = true; clearTimeout(this.timer); try { this.enc.delete && this.enc.delete(); } catch { /* ignore */ } }
}

// send(action, session?) posts to {phone id}/calls (whatsapp.js owns the Graph call and the token). speak(text) -> PCM16 mono 24 kHz (Maya's voice).
// openTranscribe / apiKey: the engine the app's calls use. expected: the tester's own sentence (server setting) to score, or ''. ended: a promise that resolves when the
// CALLER hangs up (the terminate webhook): then the call is already over on Meta's side and nothing more is sent. log(text): one plain line, no SDP, no numbers, no words.
// Returns 'completed' when we hung up after the listening, 'caller hung up' if they did, 'cannot hear' if the engine failed (she says so, then hangs up); throws if a
// step failed, after trying reject (before the accept) or terminate (after it): a call is never answered with silence or a fake reply.
async function answerWithEars({ offerSdp, send, log, speak, openTranscribe, apiKey, expected = '', ended = new Promise(() => {}), text = INTRO_LINE, listenMs = LISTEN_MS, gapMs = GAP_MS, tailMs = TAIL_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
  const speech = Promise.resolve().then(() => speak(text)); speech.catch(() => {}); // started NOW, while the connection comes up; awaited just before the accept
  const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()], video: [] }, iceServers: [] });
  const track = new MediaStreamTrack({ kind: 'audio' });
  const tx = pc.addTransceiver(track, { direction: 'sendrecv' });
  const ears = new Ears({ openTranscribe, apiKey, log, expected });
  let out = null; // the outgoing stream, started right after the accept
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => ears.hear(rtp)));
  let accepted = false, over = false;
  ended.then(() => { over = true; });
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
    let pcm;
    try { pcm = await speech; } catch (e) { throw new Error(`Maya's voice could not be made (${String(e.message).slice(0, 120)})`); }
    if (!Buffer.isBuffer(pcm) || pcm.length < 2) throw new Error("Maya's voice could not be made (no audio came back)");
    const pcm48 = upsample2(pcm);
    log(`speech made: ${text.length} characters sent to speech, ${(pcm.length / 48000).toFixed(1)} s of audio`);
    await send('accept', session);   // the SAME sdp as the pre-accept; media only after this returned 200
    accepted = true;
    log('accepted; speaking the intro');
    out = new Outbound(track, codec.payloadType); out.start();   // from now on a packet every 20 ms, silence when she is not speaking
    await Promise.race([out.say(pcm48, () => over), out.failed.then((e) => { throw e; })]);
    await sleep(over ? 0 : tailMs + gapMs);
    let how = 'caller hung up'; if (over) how = await ended.then((r) => r || 'caller hung up');
    if (!over) {
      let heardOk = true;
      try { await ears.start(); log('ears open (the transcribe engine accepted the session)'); }
      catch (e) { heardOk = false; log(`could not listen: ${String(e.message).slice(0, 160)}`); }
      if (heardOk) {
        const lost = pcLost(pc); let tm; const clock = new Promise((res) => { tm = setTimeout(() => res('time is up'), listenMs); });
        const why = await Promise.race([ended.then((r) => r || 'caller hung up'), clock, ears.closed.then(() => 'the engine closed'), lost.promise.then(() => 'the media connection dropped'), out.failed.then((e) => { throw e; })]);
        clearTimeout(tm); lost.cancel(); ears.stop(why); how = why;
      } else how = 'the engine closed';
      if (how === 'the engine closed' || how === 'the media connection dropped') {   // she never pretends to listen: she says so, in her own voice, then hangs up
        if (how === 'the engine closed') {
          try { const sorry = upsample2(await speak(CANT_HEAR_LINE)); await out.say(sorry, () => over); await sleep(tailMs); log('said she cannot hear'); }
          catch (e) { log(`could not say it either: ${String(e.message).slice(0, 120)}`); }
        }
      }
    }
    if (!over) { await send('terminate'); log(`hung up (${how})`); }
    else log(`the call was already over (${how}); nothing more to send`);
    return how === 'the engine closed' ? 'cannot hear' : over ? how : 'completed';
  } catch (e) {
    if (!over) { try { await send(accepted ? 'terminate' : 'reject'); } catch (e2) { log(`could NOT ${accepted ? 'terminate' : 'reject'} after the failure: ${String(e2.message).slice(0, 160)}`); } }
    throw e;
  } finally {
    ears.stop('call over'); if (out) out.stop();
    try { await pc.close(); } catch { /* already closed */ }
  }
}
// Resolves when the media connection is gone; cancel() stops the polling.
function pcLost(pc) {
  let iv; const promise = new Promise((res) => { iv = setInterval(() => { if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) res(); }, 200); });
  return { promise, cancel: () => clearInterval(iv) };
}

module.exports = { answerWithEars, Outbound, keepSha256Only, upsample2, INTRO_LINE, CANT_HEAR_LINE };
