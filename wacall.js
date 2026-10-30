// WhatsApp call answerer (whatsapp.js calls this). VOICE-ONLY STEP: answers one call, says ONE fixed sentence in Maya's real voice (the same chat.deps.speak
// the app and the WhatsApp voice notes use), then hangs up. No Maya ears, no conversation yet: she cannot hear the caller, and the sentence says so.
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
// Library: werift 0.25.2 (MIT, pure JS, no native build) for WebRTC; opusscript (already used for voice notes) for Opus.
const { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useOPUS } = require('werift');
const OpusScript = require('opusscript');
const crypto = require('node:crypto');

const RATE = 48000, FRAME = 960, FRAME_MS = 20;
const CONNECT_TIMEOUT_MS = 20000; // well inside Meta's 30 to 60 s window to accept
const TAIL_MS = 500;              // after the last frame, so the last word is not cut off by the hang-up
// The one sentence. True today: it claims nothing Maya cannot do yet.
const TEST_LINE = "Hello, this is Maya. This is only a test of my voice on WhatsApp calls. I can't talk with you yet, so I'll hang up now. Goodbye.";

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

// 48 kHz PCM16 mono -> one Opus packet per 20 ms on the payload type the offer chose (the last frame padded with silence). Resolves when it has all been sent.
async function playPcm(track, payloadType, pcm48) {
  const enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  const ssrc = crypto.randomBytes(4).readUInt32BE(0);
  let seq = crypto.randomBytes(2).readUInt16BE(0), ts = crypto.randomBytes(4).readUInt32BE(0);
  const frames = Math.ceil(pcm48.length / (FRAME * 2)), start = Date.now();
  try {
    for (let f = 0; f < frames; f++) {
      const chunk = Buffer.alloc(FRAME * 2); pcm48.copy(chunk, 0, f * FRAME * 2, Math.min(pcm48.length, (f + 1) * FRAME * 2));
      track.writeRtp(new RtpPacket(new RtpHeader({ payloadType, sequenceNumber: seq, timestamp: ts, ssrc, marker: f === 0 }), Buffer.from(enc.encode(chunk, FRAME))));
      seq = (seq + 1) & 0xffff; ts = (ts + FRAME) >>> 0;
      const wait = start + (f + 1) * FRAME_MS - Date.now();   // keep to the clock, not to setInterval drift
      if (wait > 0) await sleep(wait);
    }
  } finally { enc.delete && enc.delete(); }
}

// send(action, session?) posts to {phone id}/calls (whatsapp.js owns the Graph call and the token). speak(text) -> PCM16 mono 24 kHz (Maya's voice).
// log(text) writes one plain line (no SDP, no numbers, no words said). Returns 'completed' once the sentence has played and we ended the call; throws if any step
// failed, after trying reject (before the accept) or terminate (after it): a call is never answered with silence or a fake reply.
async function answerWithVoice({ offerSdp, send, log, speak, text = TEST_LINE, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
  const speech = Promise.resolve().then(() => speak(text)); speech.catch(() => {}); // started NOW, while the connection comes up; awaited just before the accept
  const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()], video: [] }, iceServers: [] });
  const track = new MediaStreamTrack({ kind: 'audio' });
  const tx = pc.addTransceiver(track, { direction: 'sendrecv' });
  let accepted = false;
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
    log('accepted; speaking');
    await playPcm(track, codec.payloadType, pcm48);
    await sleep(TAIL_MS);
    await send('terminate');
    log('spoke, call terminated by us');
    return 'completed';
  } catch (e) {
    try { await send(accepted ? 'terminate' : 'reject'); } catch (e2) { log(`could NOT ${accepted ? 'terminate' : 'reject'} after the failure: ${String(e2.message).slice(0, 160)}`); }
    throw e;
  } finally {
    try { await pc.close(); } catch { /* already closed */ }
  }
}

module.exports = { answerWithVoice, keepSha256Only, upsample2, TEST_LINE };
