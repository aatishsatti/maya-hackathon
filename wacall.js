// WhatsApp call answerer, FIRST LIVE MEDIA TEST (whatsapp.js calls this): answers one call, plays a fixed 440 Hz test tone, hangs up.
// No Maya voice, no Meta ears yet: this only proves the signalling + WebRTC media path with real WhatsApp.
// Docs read (developers.facebook.com/docs/whatsapp/cloud-api/calling/user-initiated-calls, .../calling/reference):
//   1. The `connect` webhook carries the caller's SDP OFFER (session { sdp_type: "offer", sdp }). Meta's samples: a=ice-lite, a=setup:actpass, Opus on payload type 111,
//      plus G722 / PCMU / PCMA / telephone-event, a=rtcp-mux. Answers in the samples: a=setup:active.
//   2. POST {Phone-Number-ID}/calls { messaging_product: "whatsapp", call_id, action: "pre_accept", session: { sdp_type, sdp } } with OUR answer SDP.
//      The docs' parameter table says sdp_type is "offer" but every request example uses "answer": "answer" is sent here (to be confirmed by the first live call).
//   3. Wait for the WebRTC connection (ICE + DTLS). Then POST the same body with action "accept" and the SAME sdp (a different one is refused:
//      "SDP answer provided in accept does not match the SDP answer given in the Pre-Accept endpoint for the same call-id").
//   4. Media flows ONLY after the accept came back 200 (earlier: the caller misses the first words; later: silence). About 30 to 60 s after `connect` to accept.
//   5. POST action "terminate" ends the call even if media says RTCP BYE. Failure codes arrive in the terminate webhook: 138019 setup failed, 138020 relay
//      connection failed, 138021 / 138022 media receive / transmit timeout, 138023 accepted with no media signals.
//   Opus, 48 kHz, 20 ms frames (960 samples). WhatsApp only takes SHA-256 DTLS fingerprints (the pipecat reference client strips the others), so only sha-256 lines are kept.
//   No STUN / TURN is documented. Meta's side is ICE-lite, so this side makes the outbound checks; no STUN server is asked (iceServers: []).
// Library: werift 0.25.2 (MIT, pure JS, no native build) for WebRTC; opusscript (already used for voice notes) for Opus.
const { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useOPUS } = require('werift');
const OpusScript = require('opusscript');
const crypto = require('node:crypto');

const RATE = 48000, FRAME = 960, FRAME_MS = 20;
const TONE_HZ = 440, TONE_AMPLITUDE = 9000;
const TONE_MS = 3000;            // how long the test tone plays before we hang up
const CONNECT_TIMEOUT_MS = 20000; // well inside Meta's 30 to 60 s window to accept

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

// Opus packets of a 440 Hz sine, one per 20 ms, on the payload type the offer chose. Resolves when the tone has been sent.
async function playTone(track, payloadType, ms) {
  const enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  const ssrc = crypto.randomBytes(4).readUInt32BE(0);
  let seq = crypto.randomBytes(2).readUInt16BE(0), ts = crypto.randomBytes(4).readUInt32BE(0), n = 0;
  const frames = Math.ceil(ms / FRAME_MS), start = Date.now();
  for (let f = 0; f < frames; f++) {
    const pcm = Buffer.alloc(FRAME * 2);
    for (let i = 0; i < FRAME; i++) pcm.writeInt16LE(Math.round(TONE_AMPLITUDE * Math.sin(2 * Math.PI * TONE_HZ * (n + i) / RATE)), i * 2);
    n += FRAME;
    track.writeRtp(new RtpPacket(new RtpHeader({ payloadType, sequenceNumber: seq, timestamp: ts, ssrc, marker: f === 0 }), Buffer.from(enc.encode(pcm, FRAME))));
    seq = (seq + 1) & 0xffff; ts = (ts + FRAME) >>> 0;
    const wait = start + (f + 1) * FRAME_MS - Date.now();   // keep to the clock, not to setInterval drift
    if (wait > 0) await sleep(wait);
  }
  enc.delete && enc.delete();
}

// send(action, session?) posts to {phone id}/calls (whatsapp.js owns the Graph call and the token). log(text) writes one plain line (no SDP, no numbers).
// Returns 'completed' once the tone has played and the call was terminated; throws (after trying reject / terminate) if any step failed.
async function answerWithTone({ offerSdp, send, log, toneMs = TONE_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
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
    await send('accept', session);   // the SAME sdp as the pre-accept
    accepted = true;
    log(`accepted; playing the ${TONE_HZ} Hz test tone for ${Math.round(toneMs / 1000)} s`);
    await playTone(track, codec.payloadType, toneMs);
    await sleep(200);
    await send('terminate');
    log('tone played, call terminated by us');
    return 'completed';
  } catch (e) {
    try { await send(accepted ? 'terminate' : 'reject'); } catch (e2) { log(`could NOT ${accepted ? 'terminate' : 'reject'} after the failure: ${String(e2.message).slice(0, 160)}`); }
    throw e;
  } finally {
    try { await pc.close(); } catch { /* already closed */ }
  }
}

module.exports = { answerWithTone, keepSha256Only, TONE_HZ };
