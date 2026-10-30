// WhatsApp call <-> the app's own Call (call.js). The Call is Maya's whole call brain (greeting, memory, turns, scam shield, family flow, silence, goodbye) and it
// speaks to a browser socket. This file is a socket that looks like that one, so the Call runs UNCHANGED over a WhatsApp call:
//   Browser -> server (call.js header): text {type:'start', profileId, tz, localHour, sampleRate} | {type:'bargein'}; binary = Float32 mono mic at sampleRate.
//   Server -> browser: text events (ready, speechStart, partial, speechEnd, idle, thinking, speak, audioEnd, stopped, hangup, error ...); binary = PCM16 24 kHz mono voice.
// Here: the start message is sent once (48 kHz mic); the caller's audio (waears.js Mic: ordered, 20 ms, steady clock) goes in as Float32 frames; her voice (24 kHz,
// sent faster than real time) is doubled to 48 kHz and queued into wacall's Outbound, which paces it into RTP and sends silence between speech; 'stopped' clears that
// queue (she was interrupted); 'hangup' / close(1000) means she said goodbye; an 'error' event then close(1011) is a fatal Call error.
// Logs: counts and times only, never a word. Barge-in 'duck' / 'bargein' messages are not sent: she is stopped when the engine confirms the caller's words.
const { Mic } = require('./waears');
const care = require('./care');

const FATAL_LINE = "I'm having trouble right now. Please try again a little later. Goodbye.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TTV_GAP_MS = 1200;      // a pause this long between voice chunks starts a new reply
const VOICED_PEAK = 0.02;     // mic frame peak (0..1) that counts as the caller making a sound (the same level call.js treats as clearly above a quiet room)

// A time of day for the greeting, only when the profile has a saved time zone; otherwise NaN and the greeting names no part of the day (call.js greetingNote).
function localHour(tz, now = Date.now()) {
  if (!tz) return NaN;
  try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date(now))); } catch { return NaN; }
}

// What call.js sees as "the browser socket".
class PhoneSocket {
  constructor({ onEvent, onVoice, onClose }) { this.onEvent = onEvent; this.onVoice = onVoice; this.onClose = onClose; this.onmessage = null; this.onclose = null; this.closed = false; this.cleanClose = false; this.noRingback = true; }  // noRingback: call.js skips the in-app ring-back after a silence hang-up (the person is on WhatsApp, not in the app)
  send(data) {
    if (this.closed) return;
    if (typeof data === 'string') { let m; try { m = JSON.parse(data); } catch { return; } if (m && typeof m.type === 'string') this.onEvent(m); }
    else this.onVoice(Buffer.from(data));
  }
  close(code) { if (this.closed) return; this.closed = true; this.cleanClose = code === 1000; this.onClose(code); }
  toCall(data, isBinary) { if (!this.closed && this.onmessage) this.onmessage(data, isBinary); }
}

class PhoneBridge {
  // newCall(socket, apiKey) -> a Call (call.js). speak(text) -> PCM16 24 kHz (Maya's voice), for the one fixed fatal line.
  constructor({ newCall, apiKey, profileId, tz, log, speak }) {
    this.log = log; this.speak = speak; this.profileId = profileId; this.tz = tz || null;
    this.out = null; this.held = []; this.accepted = false; this.callReady = false; this.error = null; this.finished = false;
    this.speechEnds = 0; this.replies = 0; this.lastVoicedAt = 0; this.lastChunkAt = 0; this.born = Date.now(); this.maxTtv = 0;
    this.greeting = new Promise((res) => { this.greetingReady = res; });               // resolves when her first audio exists (the greeting is ready)
    this.done = new Promise((res) => { this.finish = (r) => { if (!this.finished) { this.finished = true; res(r); } }; }); // 'maya hung up' | 'fatal'
    this.mic = new Mic({ sink: (frame) => this.toCall(frame), log });
    this.socket = new PhoneSocket({ onEvent: (m) => this.onEvent(m), onVoice: (b) => this.onVoice(b), onClose: (code) => this.finish(code === 1000 ? 'maya hung up' : 'fatal') });
    this.call = newCall(this.socket, apiKey);
  }

  // The Call starts: it opens its own transcribe session, files memory as in the app, and speaks first with its own written greeting.
  begin() {
    care.touch(this.profileId, 'whatsapp');
    const hour = localHour(this.tz);
    this.socket.toCall(JSON.stringify({ type: 'start', profileId: this.profileId, tz: this.tz, sampleRate: 48000, ...(Number.isInteger(hour) ? { localHour: hour } : {}) }), false);
  }

  // The accept went through: from now on her voice is sent and the caller is heard.
  attach(out) {
    this.out = out; this.accepted = true; this.born = Date.now();
    const held = this.held; this.held = []; for (const b of held) this.play(b);
    this.mic.start(); if (this.callReady) this.mic.go();
  }

  onEvent(m) {
    if (m.type === 'ready') { this.callReady = true; if (this.accepted) this.mic.go(); }
    else if (m.type === 'stopped') { this.held = []; if (this.out) this.out.flush(); }
    else if (m.type === 'speechEnd') this.speechEnds++;
    else if (m.type === 'error') { this.error = String(m.message || 'unknown').replace(/\s+/g, ' ').slice(0, 160); this.log(`the call brain reported an error: ${this.error}`); }
  }
  onVoice(buf) {
    if (!this.accepted) { this.held.push(buf); this.greetingReady(); return; }
    this.play(buf);
  }
  play(buf) {
    const now = Date.now();
    if (now - this.lastChunkAt > TTV_GAP_MS && this.lastVoicedAt && now - this.lastVoicedAt < 30000) {   // a new reply starts: how long after the caller's last sound?
      const ms = now - this.lastVoicedAt; this.replies++; this.maxTtv = Math.max(this.maxTtv, ms);
      this.log(`reply ${this.replies}: her first audio came ${ms} ms after the last sound from you`);
    }
    this.lastChunkAt = now;
    const even = buf.subarray(0, buf.length & ~1);
    if (even.length) this.out.say(require('./wacall').upsample2(even)).catch(() => {}); // a failed stream is reported by out.failed
  }

  // One 20 ms frame of the caller (PCM16 48 kHz) -> the Call as Float32 (the browser's format).
  toCall(frame) {
    const f32 = new Float32Array(frame.length >> 1); let peak = 0;
    for (let i = 0; i < f32.length; i++) { const v = frame.readInt16LE(i * 2) / 32768; f32[i] = v; const a = Math.abs(v); if (a > peak) peak = a; }
    if (peak >= VOICED_PEAK) this.lastVoicedAt = Date.now();
    this.socket.toCall(Buffer.from(f32.buffer), true); // offset 0: the Call views it as Float32Array
  }

  hear(rtp) { this.mic.hear(rtp); }

  // The one fixed line when the Call has failed, if her voice still works (approved wording). Returns true if it was played.
  async sayFatal(tailMs = 500) {
    try { const pcm = await this.speak(FATAL_LINE); if (!Buffer.isBuffer(pcm) || pcm.length < 2) return false; await this.out.say(require('./wacall').upsample2(pcm)); await sleep(tailMs); return true; }
    catch (e) { this.log(`could not say the fatal line: ${String(e.message).slice(0, 120)}`); return false; }
  }

  // Ends the Call if it is still open (the caller hung up, the media dropped, the cap) and logs the summary. Safe to call twice.
  stop(why) {
    this.mic.stop(why);
    this.socket.closed = true;
    try { if (this.call && !this.call.closed) this.call.end(); } catch (e) { this.log(`the call did not end cleanly: ${String(e.message).slice(0, 120)}`); }
    this.finish(why);
    if (!this.summed) { this.summed = true; this.log(`conversation over (${why}): ${this.speechEnds} turn(s) heard, ${this.replies} repl${this.replies === 1 ? 'y' : 'ies'} timed${this.replies ? `, slowest ${this.maxTtv} ms to first audio` : ''}`); }
  }
}

module.exports = { PhoneBridge, PhoneSocket, FATAL_LINE, localHour };
