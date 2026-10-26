// Ears: Meta Muse Voice Transcribe, realtime WebSocket (raw WebSocket, no plugin).
// Docs: https://dev.meta.ai/docs/speech-to-text and /docs/api-reference/voice/{realtime,schemas}
//   URL: wss://api.meta.ai/v1/asr/realtime  (optional ?sessionId=<log correlation id>)
//   The HTTP Authorization header is ignored. First frame (JSON text) within 10 s of open:
//     { authorization: { accessToken: "Bearer <key>" },
//       audioEncoding: "PCM_24KHZ" | "PCM_16KHZ",   // signed 16-bit LE mono; 24k is native
//       model: "muse-voice-transcribe-1.0",
//       mode: "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION",  // fixed for the session
//       partialMode: "CUMULATIVE" | "DELTA", emitAudioProgress: bool,
//       keywords: [string], languageBias: [string] }
//   There are NO endpointing/VAD/silence tuning fields. Turn ends are decided by Meta.
//   Server replies with an ack object holding sessionId (no "type" field); wait for it
//   before sending audio. Then audio goes as raw binary PCM frames, paced about real time
//   (never more than ~5 s ahead; below-real-time ingress closes with 1008).
//   Events (JSON text, dispatch on "type", ignore unknown):
//     speechStart {turnId, audioProcessedMs}
//     transcript {transcript, final, audioProcessedMs}   partial; CUMULATIVE replaces the last;
//                                                        no turnId: belongs to latest speechStart
//     speaker {label, audioProcessedMs}   DIARIZATION only; labels the span since the previous
//                                         speechStart/speaker event; label is session-scoped and
//                                         not a verified identity; no turnId
//     speechEnd {turnId, audioProcessedMs}
//     speechComplete {turnId, transcript, audioProcessedMs}   final text of one turn
//     audioProgress, error {message, sessionId}
//   Turns can overlap: key state by turnId.
//   End: send {"type":"endStream"}, then read until the server closes with 1000.
//   Close codes: 1000 done, 1008 bad request/pacing, 1011 internal (or "Max session duration
//   reached": 60 min, no resume token, open a new session), 1013 rate limited.
const URL = 'wss://api.meta.ai/v1/asr/realtime';
const MODEL = 'muse-voice-transcribe-1.0';
const ACK_TIMEOUT_MS = 8000;
const RATE = 24000;

// Browser mic (Float32 mono at the browser's native rate) -> PCM16 mono 24 kHz.
// Streaming box-filter resampler; keeps its position between chunks.
class Resampler {
  constructor(inRate) { this.ratio = inRate / RATE; this.buf = new Float32Array(0); this.pos = 0; }
  process(chunk) {
    const b = new Float32Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length);
    const out = [];
    let pos = this.pos;
    while (pos + this.ratio <= b.length) {
      const end = pos + this.ratio;
      let sum = 0;
      for (let i = Math.floor(pos); i < Math.ceil(end); i++) {
        sum += b[i] * (Math.min(i + 1, end) - Math.max(i, pos));
      }
      const v = Math.max(-1, Math.min(1, sum / this.ratio));
      out.push(v < 0 ? v * 32768 : v * 32767);
      pos = end;
    }
    const drop = Math.floor(pos);
    this.buf = b.subarray(drop);
    this.pos = pos - drop;
    const pcm = Buffer.alloc(out.length * 2);
    out.forEach((v, i) => pcm.writeInt16LE(Math.round(v), i * 2));
    return pcm;
  }
}

// Opens a session. Calls onReady(), onEvent(obj), onClose(code, reason). Fails fast.
function openTranscribe(apiKey, { onReady, onEvent, onClose }) {
  const ws = new WebSocket(URL);
  ws.binaryType = 'arraybuffer';
  let ready = false;
  let done = false;
  const fail = (msg) => { if (!done) { done = true; try { ws.close(); } catch { /* ignore */ } onClose(1011, msg); } };
  const ackTimer = setTimeout(() => fail('Meta Transcribe did not accept the session in time'), ACK_TIMEOUT_MS);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      authorization: { accessToken: `Bearer ${apiKey}` },
      audioEncoding: 'PCM_24KHZ',
      model: MODEL,
      mode: 'DIARIZATION',
      partialMode: 'CUMULATIVE',
      emitAudioProgress: false,
      languageBias: ['English'],
    }));
  });
  ws.addEventListener('message', (m) => {
    if (typeof m.data !== 'string') return; // server binary frames are not described; skip
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (!ready && !ev.type && ev.sessionId) { ready = true; clearTimeout(ackTimer); onReady(ev.sessionId); return; }
    if (ev.type === 'error') { fail(`Meta Transcribe error: ${ev.message}`); return; }
    if (ev.type) onEvent(ev);
  });
  ws.addEventListener('error', () => fail('Could not connect to Meta Transcribe'));
  ws.addEventListener('close', (e) => {
    clearTimeout(ackTimer);
    if (done) return;
    done = true;
    onClose(e.code, e.reason || '');
  });
  return {
    get ready() { return ready && ws.readyState === WebSocket.OPEN; },
    sendPcm(pcm) { if (ready && ws.readyState === WebSocket.OPEN) ws.send(pcm); },
    close() { done = true; clearTimeout(ackTimer); try { ws.close(1000); } catch { /* ignore */ } },
  };
}

module.exports = { openTranscribe, Resampler };
