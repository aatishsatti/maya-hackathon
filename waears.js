// Maya's EARS on a WhatsApp call (wacall.js uses this). Caller's RTP/Opus -> PCM16 24 kHz -> the SAME Meta Muse Voice Transcribe engine the app's calls use
// (transcribe.js openTranscribe: realtime WebSocket, PCM_24KHZ, mode DIARIZATION). Counts only: no word is ever logged or stored.
// Docs read (transcribe.js header, dev.meta.ai/docs/speech-to-text): audio goes as raw binary PCM frames "paced about real time (never more than ~5 s ahead;
//   below-real-time ingress closes with 1008)"; events speechStart {turnId, audioProcessedMs}, transcript, speechEnd {turnId, audioProcessedMs},
//   speechComplete {turnId, transcript, audioProcessedMs}; close codes 1000 done, 1008 bad request / pacing, 1011 internal, 1013 rate limited.
// So the feed is a 20 ms WALL-CLOCK: every tick sends exactly one 20 ms frame, the next decoded packet or, when none has arrived (loss, silence suppression), silence.
// It never runs ahead of real time and, if the process is late, catches up with the frames that were due (the ASR is then behind real time, never ahead).
// RTP: Opus clock 48000 Hz, 20 ms = 960 samples. A lost packet is silence (its place is found from the RTP timestamp gap); a late or duplicate packet is dropped.
const OpusScript = require('opusscript');
const { Resampler } = require('./transcribe');

const FRAME_SAMPLES = 960, FRAME_BYTES = FRAME_SAMPLES * 2, FRAME_MS = 20;
const MAX_QUEUE_BYTES = 20 * FRAME_BYTES;       // 400 ms of decoded audio; a longer backlog drops the oldest (the call must stay live, not lag)
const STARTUP_QUEUE_BYTES = 125 * FRAME_BYTES;  // 2.5 s while the engine is still opening: what the caller says right after the intro is kept, then sent at once
//   (the engine takes audio up to about 5 s ahead of real time, so a 2.5 s backlog is inside its limit)
const MAX_GAP_SAMPLES = 2 * 48000;              // a timestamp gap longer than 2 s is not filled
const MAX_CATCHUP = 50;

const words = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
// Share of the EXPECTED words that were heard (each heard word used once). A number only; reveals nothing of what a caller said.
function overlapPercent(expectedWords, heardWords) {
  if (!expectedWords.length) return null;
  const bag = new Map(); for (const w of heardWords) bag.set(w, (bag.get(w) || 0) + 1);
  let hit = 0; for (const w of expectedWords) { const n = bag.get(w) || 0; if (n > 0) { hit++; bag.set(w, n - 1); } }
  return Math.round((100 * hit) / expectedWords.length);
}

class Ears {
  // expected: the tester's own sentence (server setting WHATSAPP_EARS_EXPECT) or empty: then nothing is compared and nothing is kept.
  constructor({ openTranscribe, apiKey, log, expected = '' }) {
    this.openTranscribe = openTranscribe; this.apiKey = apiKey; this.log = log;
    this.expected = words(expected); this.heard = [];
    this.fifo = Buffer.alloc(0); this.resampler = new Resampler(48000); this.dec = null; this.maxQueue = STARTUP_QUEUE_BYTES; this.backlogMs = 0;
    this.started = false; this.stopped = false; this.timer = null; this.asr = null;
    this.lastSeq = null; this.lastTs = 0; this.lastLen = FRAME_SAMPLES;
    this.received = 0; this.lost = 0; this.late = 0; this.bad = 0; this.overflow = 0; this.frames = 0; this.maxLateMs = 0;
    this.turns = 0; this.totalWords = 0; this.turnInfo = new Map();
    this.closed = new Promise((res) => { this.signalClosed = res; }); // resolves { code, reason } if the engine goes away while we listen
  }

  // Opens the engine and starts the 20 ms clock when it says it is ready. Rejects if it cannot be opened.
  start() {
    this.started = true; this.dec = new OpusScript(48000, 1, OpusScript.Application.VOIP);
    return new Promise((resolve, reject) => {
      let ready = false;
      this.asr = this.openTranscribe(this.apiKey, {
        onReady: () => { ready = true; this.beginClock(); resolve(); },
        onEvent: (ev) => this.onEvent(ev),
        onClose: (code, reason) => {
          if (this.stopped) return;
          const r = String(reason || '').replace(/\s+/g, ' ').slice(0, 100);
          if (!ready) reject(new Error(`the listening engine could not be opened (${code}) ${r}`.trim()));
          else { this.log(`listening failed: the engine closed (${code}) ${r}`.trim()); this.signalClosed({ code, reason: r }); }
        },
      });
    });
  }

  // One RTP packet from the caller (werift rtp: header.sequenceNumber, header.timestamp, payload).
  hear(rtp) {
    if (!this.started || this.stopped || !this.dec) return;
    this.received++;
    const seq = rtp.header.sequenceNumber, ts = rtp.header.timestamp;
    if (this.lastSeq !== null) {
      const d = (seq - this.lastSeq) & 0xffff;
      if (d === 0 || d >= 0x8000) { this.late++; return; }          // duplicate or late: dropped
      if (d > 1) this.lost += d - 1;
      const gap = ((ts - this.lastTs) >>> 0) - this.lastLen;         // samples missing between the two packets (loss or silence suppression)
      if (gap > 0 && gap <= MAX_GAP_SAMPLES) this.queue(Buffer.alloc(gap * 2));
    }
    let pcm; try { pcm = Buffer.from(this.dec.decode(rtp.payload)); } catch { this.bad++; return; }
    this.lastSeq = seq; this.lastTs = ts >>> 0; this.lastLen = pcm.length >> 1;
    this.queue(pcm);
  }
  queue(buf) {
    this.fifo = Buffer.concat([this.fifo, buf]);
    if (this.fifo.length > this.maxQueue) { this.overflow += this.fifo.length - this.maxQueue; this.fifo = this.fifo.subarray(this.fifo.length - this.maxQueue); }
  }

  beginClock() {
    // The engine is ready: send what was kept while it opened, at once (it is already past, so it goes straight in), then keep to real time with the small lag cap.
    this.backlogMs = Math.floor(this.fifo.length / FRAME_BYTES) * FRAME_MS;
    while (this.fifo.length >= FRAME_BYTES) this.emit();
    this.maxQueue = MAX_QUEUE_BYTES;
    this.next = Date.now() + FRAME_MS;
    const loop = () => {
      if (this.stopped) return;
      const now = Date.now(); let n = 0;
      while (this.next <= now && n++ < MAX_CATCHUP) { this.maxLateMs = Math.max(this.maxLateMs, now - this.next); this.emit(); this.next += FRAME_MS; }
      if (this.next <= now) this.next = now + FRAME_MS; // far behind: skip ahead rather than burst for ever
      this.timer = setTimeout(loop, Math.max(1, this.next - Date.now()));
    };
    loop();
  }
  emit() {
    let frame;
    if (this.fifo.length >= FRAME_BYTES) { frame = this.fifo.subarray(0, FRAME_BYTES); this.fifo = this.fifo.subarray(FRAME_BYTES); }
    else { frame = Buffer.alloc(FRAME_BYTES); this.fifo.copy(frame); this.fifo = Buffer.alloc(0); } // nothing (or a part) arrived: silence for the rest of the frame
    const f32 = new Float32Array(FRAME_SAMPLES); for (let i = 0; i < FRAME_SAMPLES; i++) f32[i] = frame.readInt16LE(i * 2) / 32768;
    const out = this.resampler.process(f32); // the app's own 48 kHz -> 24 kHz step
    if (out.length && this.asr) this.asr.sendPcm(out);
    this.frames++;
  }

  // Engine events. Only counts and times are kept; the words are counted in memory and dropped (kept as plain words ONLY while an expected sentence is set, to score it).
  onEvent(ev) {
    if (ev.type === 'speechStart') this.turnInfo.set(ev.turnId, { start: Number(ev.audioProcessedMs) || 0, end: null });
    else if (ev.type === 'speechEnd') { const t = this.turnInfo.get(ev.turnId); if (t) t.end = Number(ev.audioProcessedMs) || 0; }
    else if (ev.type === 'speechComplete') {
      const w = words(ev.transcript); const t = this.turnInfo.get(ev.turnId) || { start: 0, end: null }; const end = t.end != null ? t.end : Number(ev.audioProcessedMs) || t.start;
      this.turns++; this.totalWords += w.length; if (this.expected.length) this.heard.push(...w);
      this.log(`heard turn ${this.turns}: ${w.length} word(s), ${((end - t.start) / 1000).toFixed(1)} s of speech (${(t.start / 1000).toFixed(1)} s to ${(end / 1000).toFixed(1)} s into the listening)`);
      this.turnInfo.delete(ev.turnId);
    }
  }

  // Stops the clock and the engine; logs the summary once (counts and times only). Safe to call twice.
  stop(why) {
    if (this.stopped) return null;
    this.stopped = true; clearTimeout(this.timer);
    if (!this.started) return null; // never listened: nothing to summarise
    try { this.asr && this.asr.close(); } catch { /* already closed */ }
    try { this.dec && this.dec.delete && this.dec.delete(); } catch { /* ignore */ }
    const s = { why, packets: this.received, lost: this.lost, late: this.late, bad: this.bad, overflowMs: Math.round(this.overflow / 96), backlogMs: this.backlogMs, fedSeconds: +(this.frames * FRAME_MS / 1000).toFixed(1), maxLateMs: this.maxLateMs, turns: this.turns, words: this.totalWords };
    this.log(`listening ended (${why}): ${s.packets} packets received, ${s.lost} lost, ${s.late} late or repeated, ${s.bad} unreadable, ${s.overflowMs} ms dropped for lag, ${s.backlogMs} ms kept while the engine opened, ${s.fedSeconds} s fed to the engine, worst timer lateness ${s.maxLateMs} ms, ${s.turns} turn(s), ${s.words} word(s)`);
    if (this.expected.length) { s.match = overlapPercent(this.expected, this.heard); this.log(`matched ${s.match}% of the expected words`); }
    this.heard = []; // nothing of what was said is kept
    return s;
  }
}

module.exports = { Ears, overlapPercent, words };
