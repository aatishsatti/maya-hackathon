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
const meta = require('./meta');   // usage ledger: counts only, off unless MAYA_META_LEDGER=1
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
// languageBias is a priority-ordered list of language names (docs: "a list of languages, not free-form
// context", example ["English", "French"]; the speech-to-text page lists 25 supported languages including
// Spanish, French, Portuguese and Hindi). Target markets are US/UK: English first. Other languages are
// best-effort only, not a feature claim.
const DEFAULT_BIAS = ['English', 'Spanish', 'French', 'Portuguese', 'Hindi'];
function openTranscribe(apiKey, { onReady, onEvent, onClose, languageBias = DEFAULT_BIAS }) {
  const ws = new WebSocket(URL);
  ws.binaryType = 'arraybuffer';
  let ready = false;
  let done = false;
  const fail = (msg) => { if (!done) { done = true; meta.record({ purpose: 'transcribe-call', model: MODEL, ok: false }); try { ws.close(); } catch { /* ignore */ } onClose(1011, msg); } };
  const ackTimer = setTimeout(() => fail('Meta Transcribe did not accept the session in time'), ACK_TIMEOUT_MS);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      authorization: { accessToken: `Bearer ${apiKey}` },
      audioEncoding: 'PCM_24KHZ',
      model: MODEL,
      mode: 'DIARIZATION',
      partialMode: 'CUMULATIVE',
      emitAudioProgress: false,
      languageBias,
    }));
  });
  ws.addEventListener('message', (m) => {
    if (typeof m.data !== 'string') return; // server binary frames are not described; skip
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (!ready && !ev.type && ev.sessionId) { ready = true; clearTimeout(ackTimer); onReady(ev.sessionId); return; }
    if (ev.type === 'error') { fail(`Meta Transcribe error: ${ev.message}`); return; }
    if (ev.type === 'speechComplete') meta.record({ purpose: 'transcribe-call', model: MODEL, ok: true, audioMs: ev.audioProcessedMs });   // one finished turn: a count and its audio length, never the words
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

// Voice notes: one recorded WAV, one HTTP request (no socket).
// Docs: https://dev.meta.ai/docs/api-reference/voice/transcribe
//   POST https://api.meta.ai/v1/asr/transcribe, Authorization: Bearer <key>, multipart/form-data with two parts:
//   `request` (JSON, Content-Type application/json): { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK" }
//   and `audio` (audio/wav, up to 10 minutes, body at most 32 MB). Errors: 400 unsupported audio or over 10 min, 413 too big,
//   429 limit reached, 500 failed. The docs do not show the JSON reply fields; checked live on this account: 200 with
//   { sessionId, transcript, audioDurationMs, turns }. The words are in `transcript` ("" when nothing was said).
const FILE_URL = 'https://api.meta.ai/v1/asr/transcribe';
async function transcribeWav(apiKey, wav, signal) {
  const lm = meta.begin('transcribe-voice-note', MODEL), note = {};
  try { const words = await transcribeWavCore(note, apiKey, wav, signal); lm.done(true, { audioMs: note.audioMs }); return words; }
  catch (e) { lm.done(false); throw e; }
}
async function transcribeWavCore(note, apiKey, wav, signal) {
  const fd = new FormData();
  fd.append('request', new Blob([JSON.stringify({ model: MODEL, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }), 'request.json');
  fd.append('audio', new Blob([wav], { type: 'audio/wav' }), 'note.wav');
  const r = await fetch(FILE_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd, signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]) });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Meta Transcribe failed (HTTP ${r.status}) ${detail}`.trim());
  }
  const d = await r.json();
  note.audioMs = d.audioDurationMs;
  if (typeof d.transcript !== 'string') throw new Error('Meta Transcribe returned no transcript field');
  return d.transcript.trim();
}

module.exports = { openTranscribe, Resampler, transcribeWav };
