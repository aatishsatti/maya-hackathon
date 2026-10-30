// Maya's EARS on a WhatsApp call (wabridge.js uses this): the caller's RTP/Opus packets -> 20 ms frames of PCM16 mono 48 kHz on a steady clock, for the sink
// (the Call's microphone input). No word is ever logged or stored here; this file only handles audio and counts.
//   * Packets are put back in ORDER first: a packet that arrives up to REORDER_MS late, behind its successor, is slotted in where it belongs. The live calls
//     showed "21 lost, 21 late" on every call: the "lost" packets were not lost, they were reordered, and dropping them left 20 ms holes in speech.
//   * A packet that really never comes (still missing after REORDER_MS) is silence in its place, found from the RTP timestamp gap; a late or repeated one is dropped.
//   * RTP: Opus clock 48000 Hz, 20 ms = 960 samples.
//   * A 20 ms WALL CLOCK then sends exactly one frame per tick: the next decoded audio or, when none arrived (loss, silence suppression), silence. It never runs ahead
//     of real time and, if the process is late, sends the frames that were due (the sink is then behind real time, never ahead).
//   * While the sink is not ready yet (the transcribe engine is still opening, about 1.3 s on the live calls) what the caller says is KEPT, up to 2.5 s, and sent at
//     once when go() is called (the engine takes audio up to about 5 s ahead of real time). After that only a 400 ms backlog is kept: the call must stay live, not lag.
const OpusScript = require('opusscript');

const FRAME_SAMPLES = 960, FRAME_BYTES = FRAME_SAMPLES * 2, FRAME_MS = 20;
const MAX_QUEUE_BYTES = 20 * FRAME_BYTES;       // 400 ms once running
const STARTUP_QUEUE_BYTES = 125 * FRAME_BYTES;  // 2.5 s while the sink is not ready
const MAX_GAP_SAMPLES = 2 * 48000;              // a timestamp gap longer than 2 s is not filled
const MAX_CATCHUP = 50;
const REORDER_MS = 60;                          // how long a missing packet is waited for (the next ones are held meanwhile)
const MAX_HELD = 10;

class Mic {
  // sink(frame): called with one Buffer of 960 PCM16 LE mono samples (48 kHz) per 20 ms.
  constructor({ sink, log = () => {}, reorderMs = REORDER_MS }) {
    this.sink = sink; this.log = log; this.reorderMs = reorderMs;
    this.fifo = Buffer.alloc(0); this.dec = null; this.maxQueue = STARTUP_QUEUE_BYTES; this.backlogMs = 0;
    this.started = false; this.running = false; this.stopped = false; this.timer = null;
    this.nextSeq = null; this.held = new Map(); this.lastTs = 0; this.lastLen = FRAME_SAMPLES; this.any = false;
    this.received = 0; this.lost = 0; this.late = 0; this.reordered = 0; this.bad = 0; this.overflow = 0; this.frames = 0; this.maxLateMs = 0;
  }

  // Begin collecting packets (what is heard is kept while the sink is not ready).
  start() { if (!this.started) { this.started = true; this.dec = new OpusScript(48000, 1, OpusScript.Application.VOIP); } }

  // The sink is ready: send what was kept at once, then keep to real time.
  go() {
    if (!this.started || this.running || this.stopped) return;
    this.running = true;
    this.backlogMs = Math.floor(this.fifo.length / FRAME_BYTES) * FRAME_MS;
    while (this.fifo.length >= FRAME_BYTES) this.emit();
    this.maxQueue = MAX_QUEUE_BYTES;
    this.next = Date.now() + FRAME_MS;
    const loop = () => {
      if (this.stopped) return;
      const now = Date.now(); let n = 0;
      this.release(now);
      while (this.next <= now && n++ < MAX_CATCHUP) { this.maxLateMs = Math.max(this.maxLateMs, now - this.next); this.emit(); this.next += FRAME_MS; }
      if (this.next <= now) this.next = now + FRAME_MS; // far behind: skip ahead rather than burst for ever
      this.timer = setTimeout(loop, Math.max(1, this.next - Date.now()));
    };
    loop();
  }

  // One RTP packet from the caller (werift rtp: header.sequenceNumber, header.timestamp, payload).
  hear(rtp) {
    if (!this.started || this.stopped) return;
    this.received++;
    const seq = rtp.header.sequenceNumber, now = Date.now();
    if (this.nextSeq === null) this.nextSeq = seq;
    const d = (seq - this.nextSeq) & 0xffff;
    if (d >= 0x8000) { this.late++; return; }                       // already passed: late or repeated, dropped
    if (d === 0) { const wasHeld = this.held.size > 0; this.process(rtp); this.nextSeq = (seq + 1) & 0xffff; if (wasHeld) this.reordered++; this.drain(); }
    else if (this.held.has(seq)) this.late++;                       // repeated while held
    else { this.held.set(seq, { rtp, at: now }); if (this.held.size > MAX_HELD) this.release(now, true); }
    this.release(now);
  }

  // Delivers held packets that follow the one just processed.
  drain() { while (this.held.has(this.nextSeq)) { const h = this.held.get(this.nextSeq); this.held.delete(this.nextSeq); this.process(h.rtp); this.nextSeq = (this.nextSeq + 1) & 0xffff; } }
  // A missing packet is waited for REORDER_MS; after that it is given up (silence in its place) and the held packets go in.
  release(now, force = false) {
    while (this.held.size) {
      let oldest = Infinity, first = null;
      for (const [seq, h] of this.held) { if (h.at < oldest) oldest = h.at; if (first === null || ((seq - this.nextSeq) & 0xffff) < ((first - this.nextSeq) & 0xffff)) first = seq; }
      if (!force && now - oldest < this.reorderMs) return;
      this.lost += (first - this.nextSeq) & 0xffff; this.nextSeq = first; this.drain();
      force = false;
    }
  }
  flush() { this.release(Date.now(), true); }

  process(rtp) {
    const ts = rtp.header.timestamp >>> 0;
    if (this.any) {
      const gap = ((ts - this.lastTs) >>> 0) - this.lastLen;         // samples missing between the two packets (loss or silence suppression)
      if (gap > 0 && gap <= MAX_GAP_SAMPLES) this.queue(Buffer.alloc(gap * 2));
    }
    let pcm; try { pcm = Buffer.from(this.dec.decode(rtp.payload)); } catch { this.bad++; return; }
    this.any = true; this.lastTs = ts; this.lastLen = pcm.length >> 1;
    this.queue(pcm);
  }
  queue(buf) {
    this.fifo = Buffer.concat([this.fifo, buf]);
    if (this.fifo.length > this.maxQueue) { this.overflow += this.fifo.length - this.maxQueue; this.fifo = this.fifo.subarray(this.fifo.length - this.maxQueue); }
  }
  emit() {
    let frame;
    if (this.fifo.length >= FRAME_BYTES) { frame = this.fifo.subarray(0, FRAME_BYTES); this.fifo = this.fifo.subarray(FRAME_BYTES); }
    else { frame = Buffer.alloc(FRAME_BYTES); this.fifo.copy(frame); this.fifo = Buffer.alloc(0); } // nothing (or a part) arrived: silence for the rest of the frame
    this.frames++;
    this.sink(Buffer.from(frame));
  }

  // Stops the clock; logs the summary once (counts and times only). Safe to call twice; returns the numbers.
  stop(why) {
    if (this.stopped) return null;
    this.stopped = true; clearTimeout(this.timer);
    try { this.dec && this.dec.delete && this.dec.delete(); } catch { /* ignore */ }
    if (!this.started) return null;
    const s = { why, packets: this.received, lost: this.lost, late: this.late, reordered: this.reordered, bad: this.bad, overflowMs: Math.round(this.overflow / 96), backlogMs: this.backlogMs, fedSeconds: +(this.frames * FRAME_MS / 1000).toFixed(1), maxLateMs: this.maxLateMs };
    this.log(`ears ended (${why}): ${s.packets} packets received, ${s.reordered} put back in order, ${s.lost} lost, ${s.late} late or repeated, ${s.bad} unreadable, ${s.overflowMs} ms dropped for lag, ${s.backlogMs} ms kept before the engine was ready, ${s.fedSeconds} s heard, worst timer lateness ${s.maxLateMs} ms`);
    return s;
  }
}

module.exports = { Mic };
