// One live call: browser socket <-> Meta Transcribe (ears) -> Spark (brain) -> ElevenLabs (voice).
// Speaker labels are session-scoped, so the label->name map and the short history die with the call.
// What carries across calls is the picked profile's memory file (memory.js): it is loaded at the start
// and updated from this call's words after it ends. The words themselves are never stored.
//
// Browser -> server: text {type:'start', sampleRate} | {type:'bargein'}; binary = Float32 mono mic.
// Server -> browser: text events below; binary = PCM16 24 kHz mono of Maya's voice.
//   ready, speechStart, partial{text}, speechEnd, idle, thinking, speak{text},
//   audioEnd{timing}, stopped, ttsFailed{text,error}, error{message}
const { openTranscribe, Resampler } = require('./transcribe');
const { streamSpeech, sparkStream } = require('./brain');
const { startReply, fixedReply, ChunkSplitter, stripTags } = require('./reply');
const { mapEmotionToDelivery, selfHarmText, INTENTS } = require('./emotion');
const memory = require('./memory');

// Seniors pause mid-thought. Meta has no endpointing settings, so after Meta says a turn is
// complete we wait before answering: short if it ended like a sentence, long if it trailed off.
// A new speechStart inside the wait cancels it and the turns are answered together.
const HOLD_SENTENCE_MS = 0;
const HOLD_COMPLETE_MS = 800;   // reads as a finished thought but Meta gave no final period
const HOLD_TRAILING_MS = 1500;  // trails off ("and", "my", ...) or is a fragment: they are still going
// Meta takes ~2 s to call a turn finished. To hide Spark's time inside that wait, once the
// partial transcript ends like a sentence and holds still, Spark starts on it speculatively.
// The reply is only spoken after Meta confirms the turn ended with the same words and labels.
// Any change in words or labels throws the guess away.
const SPEC_QUIET_MS = 350;
// Meta sometimes leaves a short turn ("Okay.") open through silence. With no endpointing settings
// to change, a turn whose words have stopped changing is completed here from its last partial.
const STALE_SENTENCE_MS = 2500;  // partial ends like a sentence
const STALE_OPEN_MS = 6000;      // partial trails off: seniors pause, so wait longer
// Our own end-of-turn: the person has stopped when there has been no voice-like mic energy AND no new
// partial words for this long. Transcribe's own end (1.3-2.9 s late, or never for "Okay.") and the holds
// above are only the fallback.
// Complete sentence: 0.7 s without voice-like mic energy and 0.4 s without a new partial word (Transcribe's
// partials trail the voice by about half a second, so waiting a full 0.7 s on them would double count).
// Dangling sentence (ends on "and", "my", ...): 2.25 s on both, they are mid-thought.
const OWN_END_COMPLETE_MS = 700;
const OWN_END_WORDS_COMPLETE_MS = 400;
const OWN_END_DANGLING_MS = 2250;
// When we ended the turn ourselves, the first 300 ms of Maya's audio is held back in the browser, so a
// person who was only pausing can speak again before she is audible.
const HOLD_BACK_MS = 300;
// Loud sound over Maya's voice dips her volume at once (browser); the stop is only for real words.
const DUCK_CONFIRM_MS = 1500;
// Piece joins: each reply is several TTS requests. ElevenLabs pads every piece with silence, which would
// be heard as a 200-400 ms gap between pieces, so each piece's tail is held back, its trailing silence
// trimmed (about 60 ms kept) and its leading silence trimmed (about 15 ms kept).
const TAIL_HOLD_BYTES = 350 * 48;  // 24 kHz s16 mono = 48 bytes per ms
const PAD_TAIL_BYTES = 60 * 48;
const PAD_LEAD_BYTES = 15 * 48;
const SILENT = 0.006 * 32768;
const MAX_HISTORY = 12;
// A turn left open (noise, a fan) must not hold back an answer that is already waiting.
const MAX_HOLD_OPEN_MS = 8000;
const DUPLICATE_WINDOW_MS = 8000;
const SENTENCE_END = /[.?!]["')\]]*\s*$/;
// Words a sentence cannot end on: if the last word is one of these the person is mid-thought.
const DANGLING = new Set(['and', 'but', 'so', 'because', 'or', 'if', 'the', 'a', 'an', 'to', 'of', 'with', 'my', 'your', 'his', 'her', 'their', 'that', 'which', 'i', 'we', 'um', 'uh', 'like', 'then', 'when', 'for', 'in', 'on', 'at', 'is', 'are', 'was', 'be', 'about', 'it', 'as', 'than']);
function looksComplete(text) {
  const t = String(text || '').trim();
  if (SENTENCE_END.test(t)) return true;
  const words = t.toLowerCase().match(/[\p{L}\p{N}'\u2019]+/gu) || [];
  return words.length >= 3 && !DANGLING.has(words[words.length - 1]);
}
// Silence flow: after Maya finishes speaking, wait this long for the person before the next step.
// The first wait is the longest because older people pause; follow-ups are shorter; the last wait
// before hanging up is a little longer again. Index = how many steps have already been taken.
const SILENCE_WAIT_MS = [8000, 4500, 4500, 5500];
// Said instead of any normal reply when someone talks about harming themselves or ending their life.
// No phone number is given because none may be invented. The real escalation policy (who is told,
// which service is named) is not defined yet and belongs to the owner.
const ESCALATION = "I'm really glad you told me, and I'm worried about you. You matter. Please tell someone who is near you right now, or call your local emergency number. I'm here with you.";
// Barge-in: only real speech may stop Maya. A system ding, a click or Maya's own voice coming back
// through the mic must not. All of these must hold: (1) Transcribe produced actual words, not sound
// words like "ding"; (2) at least two real words (or one clear stop word like "stop"); (3) they
// stay in the transcript for BARGE_MIN_MS, unless there are four or more; (4) the mic was
// actually loud recently; (5) the words are not just Maya's own words coming back.
const BARGE_MIN_MS = 250;
const BARGE_MIN_PEAK = 0.03;     // mic samples are -1..1
const BARGE_LOUD_WINDOW_MS = 1500;
const STOP_WORDS = new Set(['stop', 'wait', 'pardon', 'sorry', 'hello', 'excuse']);
const NOISE_WORDS = new Set(['ding', 'dong', 'beep', 'ping', 'buzz', 'click', 'tick', 'ring', 'knock', 'bang', 'whoosh', 'bell', 'chime', 'hm', 'hmm', 'mm', 'mmm', 'uh', 'um', 'er', 'ah']);
const ECHO_OVERLAP = 0.7;        // share of heard word pairs that are Maya's own consecutive words
const ECHO_WINDOW_MS = 6000;     // after she finishes, her echo can still be transcribed
const RECOVER_AFTER_MS = 9000;   // stopped but nobody said anything usable
const INTERRUPTED = "Sorry, I got interrupted, can you say that again?";
const tokens = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}'\u2019]+/gu) || [];
const realTokens = (text) => tokens(text).filter((w) => !NOISE_WORDS.has(w));
const RECOVERY = "Sorry, I didn't catch that, can you say that again?";
// Measured: [excited] came out about twice as loud as normal speech on this voice. Scale it down so
// the first phrase does not jump out; this changes level only, not the voice.
const EXCITED_GAIN = 0.6; // measured: [excited] RMS 707 vs plain 397; 0.6 levels it to about plain
// Delivery moments. Tag names are from the ElevenLabs v4 audio-tag docs (non-exhaustive list; [sympathetic], [warmly],
// [happy] are used in their examples). Measured on this voice: none is read aloud (same duration as plain text);
// they raise level (RMS vs plain 397: sympathetic 494, warmly 559, happy 671), so each gets a gain that levels it out.
const TONES = { excited: ['[excited]', EXCITED_GAIN], soft: ['[sympathetic]', 0.85], warm: ['[warmly]', 0.8], bright: ['[happy]', 0.62] };
// Clean boundary around a tone piece: its tail fades out over 30 ms (a tagged piece can end while still loud, which
// sounds like its last word running into the next piece's first), 40 ms of silence follows, and its start fades in
// over 8 ms. The browser already plays pieces strictly one after another (nextPlayTime), so they cannot overlap there.
// Excited is loud and ends abruptly more often, so it alone gets a longer fade (80 ms) and gap (100 ms); other tones keep 30/40.
const FADE_OUT_BYTES = { excited: 80 * 48, other: 30 * 48 }, FADE_IN_BYTES = 8 * 48;
const TONE_GAP = { excited: Buffer.alloc(100 * 48), other: Buffer.alloc(40 * 48) };
function fadeOut(buf, kind) {
  const key = kind === 'excited' ? 'excited' : 'other';
  const n = Math.min(FADE_OUT_BYTES[key], buf.length) & ~1, out = Buffer.from(buf);
  for (let i = 0; i < n; i += 2) { const o = out.length - n + i; out.writeInt16LE(Math.round(out.readInt16LE(o) * (1 - (i + 2) / n)), o); }
  return Buffer.concat([out, TONE_GAP[key]]);
}
function fadeIn(buf) {
  const n = Math.min(FADE_IN_BYTES, buf.length) & ~1, out = Buffer.from(buf);
  for (let i = 0; i < n; i += 2) out.writeInt16LE(Math.round(out.readInt16LE(i) * (i / n)), i);
  return out;
}
function scale(buf, g) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * g))), i);
  return out;
}

// Greetings are written by Spark each call. Only real things from this server process are passed
// along: the last few greetings and silence lines (so none repeats; wording only, no personal facts).
// Names, topics and everything else about a person come from that profile's own memory, never from here.
const recent = { greetings: [], quiet: [] };
const firstSentence = (text) => { const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim()); return (m ? m[0] : text).trim(); };
// Byte offset of the first / end of the last sample above the silence threshold (even offsets).
function firstLoud(buf) { for (let i = 0; i + 1 < buf.length; i += 2) if (Math.abs(buf.readInt16LE(i)) >= SILENT) return i; return buf.length; }
function lastLoud(buf) { for (let i = buf.length - 2; i >= 0; i -= 2) if (Math.abs(buf.readInt16LE(i)) >= SILENT) return i + 2; return 0; }
// Words that must be in the person's last turn before a reply may run long (see onFeel).
const STORY_ASK = /\b(stor(y|ies)|tale)\b/i;
// A bare "do you remember / do you know X?" is a check (short answer), not a recall: it does not match here.
const RECALL_ASK = /\b(tell me|stor(y|ies)|what (was|happened|did|is|were)|then what)\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME_OK = /^[\p{L}][\p{L} '\-]{0,29}$/u;

class Call {
  constructor(ws, apiKey) {
    this.ws = ws;
    this.apiKey = apiKey;
    this.meta = null;
    this.resampler = null;
    this.turns = new Map();      // turnId -> { partial, spans:[{label,end}], text, endedAt }
    this.curTurn = null;         // turn that partials/speaker events belong to
    this.pending = [];           // completed turns waiting for the hold timer
    this.lastLabel = null;       // most recent speaker label, used only for turns completed by the watchdog
    this.forcedOpen = null;      // { id, base }: Meta turn we completed early, which Meta still thinks is open
    this.staleTimer = null;
    this.names = new Map();      // label -> name, this call only
    this.seen = new Set();       // labels heard this call
    this.history = [];
    this.profile = null;         // the picked profile (memory.js), set at 'start'
    this.tz = null;              // browser time zone, for the date/time Spark is given
    this.callId = require('node:crypto').randomBytes(4).toString('hex');
    this.callStarted = false;    // memory.startCall done: turns are being appended to the pending file
    this.holdTimer = null;
    this.abort = null;           // aborts the in-flight reply
    this.lastAnswered = null;    // { key, at } of the last turn Maya replied to
    this.prevDelivery = null;    // last turn's mapped delivery (one turn of carry-over)
    this.escalations = 0;
    this.lastLoudAt = 0;         // last time the mic was clearly loud
    this.noiseFloor = 0.004;     // slow estimate of the room's background level (mic peak units)
    this.lastVoiceAt = 0;        // last time the mic was clearly above the room's background
    this.lastPartialChangeAt = 0;
    this.hasMic = false;
    this.duckTimer = null;
    this.endTimer = setInterval(() => this.endpointTick(), 100);
    this.sayingText = '';        // what Maya has said so far in the current reply
    this.lastSaidAt = 0;
    this.bargeSince = 0;
    this.playUntil = 0;          // when the browser finishes playing the audio sent so far (24 kHz s16 = 48 bytes/ms)
    this.recoverTimer = null;
    this.silenceTimer = null;
    this.silenceStage = 0;       // 0,1: check-in lines; 2: 'I will wait'; 3: hang up
    this.quietPrefetch = null;   // the next silence line, written ahead while the countdown runs
    this.openings = [];          // first words of Maya's last replies
    this.openedWithInterjection = false;
    this.greeted = false;        // a call is greeted once, at its start, never again
    this.replyCount = 0;         // normal replies so far
    this.askedName = false;
    this.lastNameUse = -10;      // reply number that last used the person's name
    this.willAskName = Math.random() < 0.6; // decided per call, so asking is neither fixed nor every call
    this.spec = null;            // speculative Spark reply { key, promise, abort }
    this.specTimer = null;
    this.responding = false;
    this.gen = 0;
    this.closed = false;
    ws.onmessage = (data, isBinary) => this.onBrowser(data, isBinary);
    ws.onclose = () => this.end();
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  fatal(message) {
    if (this.closed) return;
    console.error('Call error:', message);
    try { this.send({ type: 'error', message }); } catch { /* socket gone */ }
    this.end();
    this.ws.close(1011);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    this.saveMemory();
    clearTimeout(this.holdTimer);
    clearTimeout(this.staleTimer);
    clearTimeout(this.duckTimer);
    clearInterval(this.endTimer);
    this.cancelSilence();
    this.dropSpec();
    if (this.abort) this.abort.abort();
    if (this.meta) this.meta.close();
  }

  // After the call: its pending words are filed into the profile's memory by Spark in the background.
  saveMemory() {
    if (!this.profile || !this.callStarted) return;
    const heavy = this.escalations > 0 || (this.prevDelivery && ['sad', 'lonely', 'grief', 'anxious'].includes(this.prevDelivery.emotion));
    memory.endCall(this.profile.id, this.callId, { heavy: Boolean(heavy) });
  }

  onBrowser(data, isBinary) {
    if (this.closed) return;
    if (isBinary) {
      if (!this.resampler || !this.meta || !this.meta.ready || data.length % 4) return;
      const f32 = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
      let peak = 0;
      for (let i = 0; i < f32.length; i += 8) { const a = Math.abs(f32[i]); if (a > peak) peak = a; }
      const now = Date.now();
      if (peak >= BARGE_MIN_PEAK) this.lastLoudAt = now;
      this.hasMic = true;
      if (peak > Math.max(0.02, this.noiseFloor * 3)) this.lastVoiceAt = now;          // clearly above the room
      else this.noiseFloor = this.noiseFloor * 0.98 + peak * 0.02;                      // learn the room
      const pcm = this.resampler.process(f32);
      if (pcm.length) this.meta.sendPcm(pcm);
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'start' && !this.meta && !this.starting) {
      this.profile = memory.load(m.profileId);
      if (!this.profile) return this.fatal('Please pick a profile first.');
      try { new Intl.DateTimeFormat('en-US', { timeZone: m.tz }); this.tz = m.tz; } catch { this.tz = null; }
      const rate = Number(m.sampleRate);
      if (!(rate >= 8000 && rate <= 96000)) return this.fatal('Bad microphone sample rate');
      this.starting = true;
      // Words a crashed or unfinished earlier call left behind are filed first, so this call knows them.
      memory.flushPending(this.profile.id).then(() => {
        if (this.closed) return;
        memory.startCall(this.profile.id, this.callId, this.tz);
        this.callStarted = true;
        this.openMeta(m, rate);
      });
      return;
    }
    this.onBrowserMessage(m);
  }

  openMeta(m, rate) {
    {
      this.resampler = new Resampler(rate);
      this.meta = openTranscribe(this.apiKey, {
        onReady: () => { this.send({ type: 'ready' }); this.greet(Number(m.localHour)); },
        onEvent: (ev) => this.onMeta(ev),
        onClose: (code, reason) => {
          if (this.closed) return;
          this.fatal(code === 1000 ? 'The listening connection ended.' : `Listening failed (${code}) ${reason}`.trim());
        },
      });
    }
  }

  onBrowserMessage(m) {
    if (m.type === 'duck') {
      // The browser dipped Maya's volume because of loud sound. Give real words DUCK_CONFIRM_MS to arrive
      // (considerBargeIn then stops her); if none do, her volume goes back and she carries on.
      if (this.isSpeaking()) {
        this.lastLoudAt = Date.now();
        clearTimeout(this.duckTimer);
        this.duckTimer = setTimeout(() => { if (!this.closed) this.send({ type: 'unduck' }); }, DUCK_CONFIRM_MS);
      }
    } else if (m.type === 'bargein') {
      this.interrupt();
    }
  }

  // Stops Maya at once: aborts Spark/TTS and tells the browser to drop queued audio.
  // Maya is audible while Spark/the voice are still working AND while the browser is still playing
  // audio the server has already finished sending (the server streams faster than real time).
  isSpeaking() { return this.responding || Date.now() < this.playUntil; }

  interrupt() {
    if (!this.isSpeaking()) return;
    this.gen += 1;
    if (this.abort) this.abort.abort();
    this.responding = false;
    this.playUntil = 0;
    this.bargeSince = 0;
    clearTimeout(this.duckTimer);
    this.send({ type: 'stopped' });
    // If what stopped her never turns into a usable question, say so instead of going quiet.
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => this.recoverFromInterrupt(), RECOVER_AFTER_MS);
  }

  recoverFromInterrupt() {
    if (this.closed || this.isSpeaking()) return;
    if (this.curTurn || this.pending.length) { this.recoverTimer = setTimeout(() => this.recoverFromInterrupt(), 3000); return; } // still listening to them
    console.log('recovery: interrupted with nothing usable heard');
    this.speak(INTERRUPTED);
  }

  // Words of Maya's own reply coming back through the mic (or just after she stopped).
  isEcho(text) {
    const heard = realTokens(text);
    if (heard.length < 2) return false;
    if (!this.isSpeaking() && Date.now() - this.lastSaidAt > ECHO_WINDOW_MS) return false;
    // Her echo repeats her words in order; a person who merely uses the same topic words does not.
    const pairs = (words) => words.slice(1).map((w, i) => `${words[i]} ${w}`);
    const mine = new Set(pairs(tokens(this.sayingText)));
    const theirs = pairs(tokens(text));
    return theirs.length > 0 && theirs.filter((p) => mine.has(p)).length / theirs.length >= ECHO_OVERLAP;
  }

  // Called with every non-empty partial transcript.
  considerBargeIn(partial) {
    if (!this.isSpeaking()) return;
    const real = realTokens(partial);
    const stop = real.length === 1 && STOP_WORDS.has(real[0]);
    if ((real.length < 2 && !stop) || this.isEcho(partial)
        || Date.now() - this.lastLoudAt > BARGE_LOUD_WINDOW_MS) { this.bargeSince = 0; return; }
    const now = Date.now();
    if (!this.bargeSince) this.bargeSince = now;
    if (real.length >= 4 || stop || now - this.bargeSince >= BARGE_MIN_MS) this.interrupt();
  }

  onMeta(ev) {
    switch (ev.type) {
      case 'speechStart': {
        clearTimeout(this.holdTimer);
        if (this.pending.length) this.holdTimer = setTimeout(() => this.respond(MAX_HOLD_OPEN_MS), MAX_HOLD_OPEN_MS);
        this.dropSpec();
        this.forcedOpen = null;
        this.curTurn = { partial: '', spans: [], text: null };
        this.turns.set(ev.turnId, this.curTurn);
        this.send({ type: 'speechStart' });
        break;
      }
      case 'transcript': {
        let t = this.curTurn;
        const heard = (ev.transcript || '').trim();
        const fo = this.forcedOpen;
        if (!t && fo && heard.length > fo.base.length + 3) {
          // The person kept talking in a Meta turn we had already completed: start the next turn from the new words.
          t = this.curTurn = { partial: '', spans: [], text: null, base: fo.base };
          this.turns.set(fo.id, t);
          this.send({ type: 'speechStart' });
        }
        if (!t) break;
        const before = t.partial;
        t.partial = t.base && heard.startsWith(t.base) ? heard.slice(t.base.length).trim() : heard;
        if (t.partial !== before) this.lastPartialChangeAt = Date.now();
        if (t.partial) {
          this.considerBargeIn(t.partial);
          if (realTokens(t.partial).length) { this.cancelSilence(); this.send({ type: 'partial', text: t.partial }); } // sounds like "ding" are not shown as speech
          this.armStale(t);
        }
        this.maybeSpeculate(t);
        break;
      }
      case 'speaker': {
        // Labels the span since the previous boundary, so it ends at the current partial's end.
        // Since we now end turns ourselves, this usually arrives after the turn was completed: still learn the label.
        this.seen.add(ev.label);
        this.lastLabel = ev.label;
        const t = this.curTurn;
        if (!t) break;
        t.spans.push({ label: ev.label, end: t.partial.length });
        this.send({ type: 'speaker', label: ev.label });
        break;
      }
      case 'speechEnd': {
        if (this.forcedOpen && this.forcedOpen.id === ev.turnId && !this.turns.has(ev.turnId)) break; // already completed here
        clearTimeout(this.staleTimer);
        const t = this.turns.get(ev.turnId);
        if (t) t.endedAt = Date.now();
        this.send({ type: 'speechEnd' });
        break;
      }
      case 'speechComplete': {
        clearTimeout(this.staleTimer);
        if (!ev.synthetic && this.forcedOpen && this.forcedOpen.id === ev.turnId) {
          const continued = this.turns.has(ev.turnId);
          this.forcedOpen = null;
          if (!continued) break; // Meta caught up with a turn we already answered
        }
        const t = this.turns.get(ev.turnId) || { partial: '', spans: [] };
        this.turns.delete(ev.turnId);
        if (this.curTurn === t) this.curTurn = null; // turn is over: its partial buffer is done
        let said = (ev.transcript || '').trim();
        if (t.base && said.startsWith(t.base)) said = said.slice(t.base.length).trim();
        t.text = this.collapseRepeat(said);
        t.completedAt = Date.now();
        const key = this.textKey([t]);
        const last = this.pending[this.pending.length - 1];
        const dup = key && ((last && this.textKey([last]) === key)
          || (this.lastAnswered && this.lastAnswered.key === key && t.completedAt - this.lastAnswered.at < DUPLICATE_WINDOW_MS));
        if (!t.text || dup || !realTokens(t.text).length || this.isEcho(t.text)) {
          if (this.pending.length) { clearTimeout(this.holdTimer); this.holdTimer = setTimeout(() => this.respond(0), HOLD_TRAILING_MS); } // keep the wait going
          else if (!this.isSpeaking()) this.send({ type: 'idle' });
          if (!this.pending.length) this.armSilence(); // that was not a usable answer: keep counting the quiet
          break;
        }
        this.pending.push(t);
        clearTimeout(this.holdTimer);
        clearTimeout(this.specTimer);
        t.synthetic = Boolean(ev.synthetic); // we ended this turn ourselves: Maya's first 300 ms is held back
        let hold;
        if (ev.synthetic) hold = 0;                                                  // already waited the full quiet period
        else if (this.hasMic) {
          // Transcribe's end: only top up to our own quiet period (usually 0, it is slower than we are).
          hold = this.quietNeeded(t.text);
        } else {
          hold = SENTENCE_END.test(t.text) ? HOLD_SENTENCE_MS : looksComplete(t.text) ? HOLD_COMPLETE_MS : HOLD_TRAILING_MS; // no mic data: the old fixed holds
        }
        if (this.spec && this.spec.textKey !== this.textKey(this.pending)) this.dropSpec();
        this.holdTimer = setTimeout(() => this.respond(hold), hold);
        break;
      }
      default: break; // audioProgress and unknown events are ignored
    }
  }

  // Splits one turn's final text into [{label, text}] using the speaker spans (scaled from
  // the last partial's length to the final text's length, snapped to a word boundary).
  attribute(t) {
    if (!t.spans.length) return [{ label: null, text: t.text }];
    const total = Math.max(t.partial.length, 1);
    const parts = [];
    let from = 0;
    t.spans.forEach((s, i) => {
      let end = i === t.spans.length - 1 ? t.text.length : Math.round((s.end / total) * t.text.length);
      if (end < t.text.length) { const sp = t.text.indexOf(' ', end); end = sp === -1 ? t.text.length : sp; }
      const text = t.text.slice(from, end).trim();
      from = Math.max(from, end);
      if (text) parts.push({ label: s.label, text });
    });
    // Any text after the last span belongs to the last speaker.
    const rest = t.text.slice(from).trim();
    if (rest) parts.push({ label: t.spans[t.spans.length - 1].label, text: rest });
    return parts;
  }

  // "Name: words" lines for a set of turns; consecutive spans by one speaker are joined.
  userMessage(turns) {
    const lines = [];
    for (const t of turns) {
      for (const p of this.attribute(t)) {
        const who = this.who(p.label);
        const last = lines[lines.length - 1];
        if (last && last.who === who) last.text += ` ${p.text}`;
        else lines.push({ who, text: p.text });
      }
    }
    return lines.map((l) => `${l.who}: ${l.text}`).join('\n');
  }

  // Identity of what was heard: letters and digits only, so punctuation changes do not matter.
  textKey(turns) {
    return turns.map((t) => t.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).join(' ');
  }

  dropSpec() {
    clearTimeout(this.specTimer);
    if (this.spec) { for (const s of this.spec.byLabel.values()) s.abort.abort(); this.spec = null; }
  }

  // Meta sends a turn's speaker label only when the turn ends, so the guess is made for each
  // voice label heard so far plus the next unused one; the one that matches the final label is used.
  maybeSpeculate(t) {
    clearTimeout(this.specTimer);
    if (this.pending.length || !t.partial.trim()) return;
    const key = this.textKey([{ text: t.partial }]);
    if (this.spec && this.spec.textKey !== key) this.dropSpec();
    if (this.spec || !looksComplete(t.partial)) return;
    this.specTimer = setTimeout(() => {
      if (this.closed || this.spec) return;
      const next = 'ABCDEFGH'.split('').find((l) => !this.seen.has(l));
      const labels = [...new Set([...this.seen, next].filter(Boolean))].slice(0, 4);
      const spec = { textKey: key, byLabel: new Map() };
      for (const label of labels) {
        const abort = new AbortController();
        const turn = { ...t, text: t.partial, spans: [{ label, end: t.partial.length }] };
        const msgs = [...this.history, { role: 'user', content: this.userMessage([turn]) }].slice(-MAX_HISTORY);
        // A failed or dropped guess is silent (ReplyStream keeps the error; nothing reads it).
        spec.byLabel.set(label, { rs: startReply(msgs, this.roster(this.replyNote()), abort.signal), abort });
      }
      this.spec = spec;
    }, SPEC_QUIET_MS);
  }

  // Fallback: Transcribe never closed the turn and its words stopped changing.
  armStale(t) {
    clearTimeout(this.staleTimer);
    const ms = looksComplete(t.partial) ? STALE_SENTENCE_MS : STALE_OPEN_MS;
    this.staleTimer = setTimeout(() => this.forceComplete(t), ms);
  }

  // Primary: our own end-of-turn, checked every 100 ms while a turn is open.
  endpointTick() {
    const t = this.curTurn;
    if (this.closed || !t || !this.hasMic || !t.partial || !realTokens(t.partial).length) return;
    if (this.quietNeeded(t.partial) === 0) this.forceComplete(t);
  }

  // Milliseconds still to wait before the person can be considered finished (0 = finished).
  quietNeeded(text) {
    const now = Date.now();
    const complete = looksComplete(text);
    return Math.max(0,
      (complete ? OWN_END_COMPLETE_MS : OWN_END_DANGLING_MS) - (now - this.lastVoiceAt),
      (complete ? OWN_END_WORDS_COMPLETE_MS : OWN_END_DANGLING_MS) - (now - this.lastPartialChangeAt));
  }

  forceComplete(t) {
    if (this.closed || this.curTurn !== t) return;
    const id = [...this.turns].find(([, v]) => v === t);
    if (!id) return;
    clearTimeout(this.staleTimer);
    // Transcribe sends the speaker label after the turn ends, which is now after we have ended it: assume the
    // last speaker (or 'A', its first label) is still the one talking. A wrong guess only costs the early guess.
    const guess = this.lastLabel || (this.seen.size ? [...this.seen][0] : 'A');
    if (!t.spans.length) { t.spans = [{ label: guess, end: t.partial.length }]; this.seen.add(guess); }
    this.forcedOpen = { id: id[0], base: (t.base ? `${t.base} ${t.partial}` : t.partial).trim() };
    this.send({ type: 'speechEnd' });
    this.onMeta({ type: 'speechComplete', turnId: id[0], transcript: t.partial, synthetic: true });
  }

  // "hello maya hello maya" (final text arriving on top of its own partial) becomes "hello maya".
  collapseRepeat(text) {
    const words = text.split(/\s+/);
    if (words.length >= 2 && words.length % 2 === 0) {
      const n = words.length / 2;
      const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (words.slice(0, n).every((w, i) => norm(w) === norm(words[n + i]))) return words.slice(n).join(' ');
    }
    return text;
  }

  who(label) { return label ? (this.names.get(label) || `Speaker ${label}`) : 'Someone'; }

  roster(note = '') {
    const known = [...this.names].map(([l, n]) => `${l}=${n}`);
    const unknown = [...this.seen].filter((l) => !this.names.has(l));
    return `${memory.profileNote(this.profile, this.tz)}\nPeople heard on this call. Known names: ${known.join(', ') || 'none'}. Names not known yet: ${unknown.join(', ') || 'none'}.${note ? ` ${note}` : ''}`;
  }

  // Notes Spark gets with every normal reply: how not to repeat the openings it just used.
  replyNote() {
    const bits = [];
    bits.push('The conversation is already under way: do not greet them or begin with Hello, Hi or a Good morning/evening.');
    if (this.names.size) {
      const ago = this.replyCount - this.lastNameUse;
      bits.push(ago < 3 ? 'You used their name recently, so do not use it in this reply.' : 'If this reply comforts or encourages them (sadness, loneliness, worry), start it with their name once, like "Mike, I\'m right here with you." For ordinary chat or happy news leave their name out.');
    } else if (this.profile) {
      bits.push('Do not ask for their name.');
    } else if (this.willAskName && !this.askedName && this.replyCount === 1) {
      bits.push('If the moment is light, end this reply by asking what you should call them, once, gently. If it is a heavy or sad moment, do not ask.');
    } else {
      bits.push('Do not ask for their name in this reply.');
    }
    return bits.join(' ') + ' ' + (this.openings.length
      ? `Your last reply openings were: ${this.openings.map((o) => `"${o}"`).join(', ')}. Open this reply differently, in fresh words chosen from the feeling. Do not begin with any of these word pairs: ${[...new Set(this.openings.map((o) => o.split(' ').slice(0, 2).join(' ')))].map((p) => `"${p}"`).join(', ')}.`
      : '');
  }

  greetingNote(hour) {
    const h = Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null;
    const part = h === null ? null : h < 5 ? 'late at night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
    const bits = ['The call has just connected and you greet first. Write exactly ONE short sentence (under fifteen words): warm and slightly bright, joyful but never loud, theatrical or over-excited. Fresh every time. Do not ask their name or any question. Do not say you are an AI.'];
    const name = this.profile.name;
    {
      const usedLast = recent.greetings.length && new RegExp(`\\b${name}\\b`, 'i').test(recent.greetings[recent.greetings.length - 1]);
      bits.push(`This call is on ${name}'s profile; the caller is probably ${name}. ${this.profile.memory.topics.length ? 'Do NOT introduce yourself and do not say your own name.' : 'This is their first call: say your name, Maya, once in the sentence (for example "I\'m Maya").'} ${usedLast ? 'You used their name in your last greeting, so leave it out this time and just greet them warmly.' : 'You may greet them by that name, or just warmly without it; do not do it every time.'}`);
    }
    if (part) bits.push(`It is ${part} where they are; you may mention it naturally, but not every time. "Good night" is a goodbye, never a hello: for the late evening or night use "Hello" or "Good evening".`);
    if (recent.greetings.length) bits.push(`Your recent greetings were: ${recent.greetings.map((g) => `"${g}"`).join('; ')}. Use clearly different wording and a different opening.`);
    const topics = this.profile.memory.topics;
    if (this.profile.lastCallHeavy) bits.push('Their last call ended on a heavy topic. Greet them extra gently and do not mention specifics unless they do.');
    else if (topics.length) bits.push(`Their last call was about: "${topics[topics.length - 1].text}". You may refer to it briefly if it fits, but never add details you were not told.`);
    return bits.join(' ');
  }

  // ---- Silence flow ----
  // After Maya finishes speaking (greeting or reply), 8 s of nothing (then 4.5, 4.5, 5.5) triggers the next step:
  // check-in, check-in, "I'll wait", then hang up. Wording is written by Spark each time (never the
  // same line twice in a row); the timing is fixed. The next line is written ahead during the
  // countdown so it is ready on time. Any real words from the person cancel it and reset the steps.
  cancelSilence() {
    clearTimeout(this.silenceTimer);
    if (this.quietPrefetch) { this.quietPrefetch.abort.abort(); this.quietPrefetch = null; }
  }

  armSilence() {
    this.cancelSilence();
    if (this.closed || this.escalations > 0) return; // never hang up on someone who has just said something worrying
    const stage = this.silenceStage;
    const wait = Math.max(0, this.playUntil - Date.now()) + SILENCE_WAIT_MS[Math.min(stage, SILENCE_WAIT_MS.length - 1)];
    const abort = new AbortController();
    const promise = this.quietLine(stage, abort.signal);
    promise.catch(() => {});
    this.quietPrefetch = { stage, abort, promise };
    this.silenceTimer = setTimeout(() => this.fireSilence(), wait);
  }

  async quietLine(stage, signal) {
    const kind = stage < 2 ? 'check' : stage === 2 ? 'wait' : 'hangup';
    const what = {
      check: 'The person has been silent for a few seconds. In one short, warm sentence gently check whether they are still there (the idea of "are you there?", but choose your own words).',
      wait: 'The person is still silent. In one short, warm sentence say that if no one is there you will just wait quietly for them to speak. Choose your own words.',
      hangup: 'The person is still silent. In one or two short, kind sentences say it seems the call was placed by mistake, or was a pocket dial, so you are going to hang up now, and say a gentle goodbye. Choose your own words.',
    }[kind];
    let note = `${what} Do not ask their name. Do not say you are an AI. This is not a greeting: do not start with Hello, Hi or Good morning/evening.`;
    if (recent.quiet.length) note += ` Lines you used recently: ${recent.quiet.map((q) => `"${q}"`).join('; ')}. Do not repeat or closely echo any of them.`;
    const ask = [{ role: 'user', content: '(The person has said nothing. Write your short line now.)' }];
    let full;
    let said;
    for (let attempt = 0; attempt < 2; attempt++) {
      full = await sparkStream(ask, this.roster(note), signal, () => {});
      said = stripTags(full);
      const norm = said.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (!recent.quiet.slice(-2).some((q) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === norm)) break;
      note += ' That repeats a recent line. Write something clearly different.';
    }
    return { full, said, kind };
  }

  async fireSilence() {
    if (this.closed) return;
    // Still talking, thinking, or hearing them: not silence. Look again shortly.
    if (this.responding || this.isSpeaking() || this.pending.length || (this.curTurn && this.curTurn.partial)) {
      this.silenceTimer = setTimeout(() => this.fireSilence(), 1000);
      return;
    }
    const pre = this.quietPrefetch;
    this.quietPrefetch = null;
    this.silenceStage += 1;
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    let line;
    try {
      line = await (pre ? pre.promise : this.quietLine(this.silenceStage - 1, this.abort.signal));
    } catch (e) {
      if (myGen !== this.gen || this.closed) return;
      return this.fatal(e.message);
    }
    if (myGen !== this.gen || this.closed) return;
    recent.quiet = [...recent.quiet, line.said].slice(-6);
    this.history.push({ role: 'assistant', content: line.said });
    console.log('silence step', JSON.stringify({ step: this.silenceStage, kind: line.kind }));
    await this.speakReply(fixedReply(line.full), null, myGen, { greeting: true, hangup: line.kind === 'hangup', stripGreeting: true });
  }

  // After the goodbye has actually been played, end the call: the browser stops the mic and audio.
  hangUp() {
    const wait = Math.max(0, this.playUntil - Date.now()) + 600;
    setTimeout(() => {
      if (this.closed) return;
      console.log('hangup: silence');
      try { this.send({ type: 'hangup' }); } catch { /* socket gone */ }
      this.end();
      this.ws.close(1000);
    }, wait);
  }

  // Spark writes the greeting. If it repeats a recent one it is asked once more; no fixed fallback text exists.
  async greet(hour) {
    if (this.greeted) return; // once per call, at the start only
    this.greeted = true;
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    this.send({ type: 'thinking' });
    const ask = [{ role: 'user', content: '(The call has just connected. Greet the person now.)' }];
    let note = this.greetingNote(hour);
    let full;
    let said;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        full = await sparkStream(ask, this.roster(note), this.abort.signal, () => {});
        said = firstSentence(stripTags(full));
        const norm = said.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (/good night/i.test(said)) { note += ' You used "Good night" as a hello. It is only a goodbye. Use "Hello" or "Good evening".'; continue; }
        if (!recent.greetings.some((g) => g.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === norm)) break;
        note += ' That greeting repeats an earlier one. Write something clearly different.';
      }
    } catch (e) {
      if (myGen !== this.gen || this.closed) return;
      return this.fatal(e.message);
    }
    if (myGen !== this.gen || this.closed) return;
    said = said.replace(/good night/gi, 'Good evening'); // last-resort guard: it is never a hello
    recent.greetings = [...recent.greetings, said].slice(-4);
    this.history.push({ role: 'assistant', content: said });
    await this.speakReply(fixedReply(full), null, myGen, { greeting: true });
  }

  async respond(holdMs) {
    clearTimeout(this.recoverTimer);
    this.cancelSilence();
    this.silenceStage = 0; // they spoke: the silence steps start over
    const turns = this.pending;
    this.pending = [];
    if (!turns.length || this.closed) return;
    let spec = null;
    if (this.spec && this.spec.textKey === this.textKey(turns)) {
      const labels = new Set(turns.flatMap((t) => this.attribute(t).map((p) => p.label)));
      const [only] = labels;
      if (labels.size === 1 && this.spec.byLabel.has(only)) {
        spec = this.spec.byLabel.get(only);
        this.spec.byLabel.delete(only);
      }
    }
    this.dropSpec(); // aborts every other guess
    this.history.push({ role: 'user', content: this.userMessage(turns) });
    this.history = this.history.slice(-MAX_HISTORY);
    for (const t of turns) for (const pt of this.attribute(t)) memory.appendTurn(this.profile.id, this.callId, { label: pt.label, text: pt.text, userSaid: true });
    const t0 = turns[turns.length - 1];
    const timing = {
      holdMs,
      metaEndpointMs: t0.endedAt ? t0.completedAt - t0.endedAt : null, // speechEnd -> speechComplete
      endedAt: t0.endedAt || t0.completedAt,
      guess: spec ? 'hit' : 'miss',
    };

    if (this.abort) this.abort.abort(); // never two replies at once
    this.lastAnswered = { key: this.textKey(turns), at: Date.now() };
    if (turns.some((t) => selfHarmText(t.text))) {
      // Safety first, decided by code from the person's own words: no Spark reply, no sadness script.
      this.dropSpec();
      this.history.push({ role: 'assistant', content: ESCALATION });
      return this.escalate('words', timing);
    }
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    this.send({ type: 'thinking' });
    let rs;
    if (spec) {
      this.abort.signal.addEventListener('abort', () => spec.abort.abort(), { once: true });
      rs = spec.rs;
    } else {
      rs = startReply(this.history, this.roster(this.replyNote()), this.abort.signal);
    }
    await this.speakReply(rs, timing, myGen, { record: true, stripGreeting: true, holdBack: turns.some((t) => t.synthetic) });
  }

  escalate(reason, timing) {
    this.escalations += 1;
    console.log('escalation', JSON.stringify({ reason, count: this.escalations })); // no words logged
    this.prevDelivery = null;
    return this.speak(ESCALATION);
  }

  recordName(label, name) {
    // The first turn of a call can be answered before Transcribe has sent any speaker label; a name
    // given then belongs to the only voice there is.
    if (!this.seen.size && /^[A-H]$/.test(label)) this.seen.add(label);
    if (this.seen.has(label) && NAME_OK.test(name)) { this.names.set(label, name); memory.noteNames(this.profile.id, this.callId, Object.fromEntries(this.names)); }
  }

  // Streams Spark's text into the voice sentence by sentence. Each sentence is sent to the voice
  // as soon as it is complete (requests run side by side, audio goes out in order), so speech
  // starts while Spark is still writing. Plain text, with an excited opening phrase for happy news.
  async speakReply(rs, timing, myGen, { record = false, greeting = false, hangup = false, stripGreeting = false, holdBack = false } = {}) {
    const signal = this.abort.signal;
    this.sayingText = '';
    this.playUntil = 0;
    const jobs = [];
    const said = [];
    let started = false;
    let sentAny = false;
    let producerDone = false;
    let producerErr = null;
    const tStart = Date.now();
    let tEnqueue = 0;

    let pieces = 0;
    let excited = false;
    let delivery = null;
    let feel = null;
    const splitter = new ChunkSplitter({
      stripInterjection: record && this.openedWithInterjection,
      stripGreeting,
      onName: (l, n) => this.recordName(l, n),
      onFeel: (raw) => {
        // Spark's read goes through the deterministic map; nothing else from it is used.
        const d = mapEmotionToDelivery(raw && raw.emotion, raw && raw.intensity, this.prevDelivery);
        // Length follows the request: only an explicit story or memory-recall ask lifts the short-reply cap.
        // Spark names the intent, and the person's own last words must also look like such an ask.
        const intent = raw && String(raw.intent).toLowerCase();
        const lastUser = ([...this.history].reverse().find((m) => m.role === 'user') || { content: '' }).content;
        if (!greeting && ((intent === 'story' && STORY_ASK.test(lastUser)) || (intent === 'recall' && RECALL_ASK.test(lastUser)))) { d.maxSentences = Infinity; d.moments = 3; }
        if (greeting) { d.excitedOpening = false; d.openingTone = null; d.moments = 0; d.maxSentences = 1; }          // a greeting is one warm sentence, never theatrical
        delivery = d;
        feel = { emotion: d.emotion, intensity: d.intensity, intent: raw && INTENTS.includes(String(raw.intent).toLowerCase()) ? String(raw.intent).toLowerCase() : 'unclear', whisperPieces: d.whisperPieces };
        return d;
      },
      onPiece: (text, kind, next) => {
        const job = { chunks: [], done: false, err: null, tone: Boolean(kind), kind };
        jobs.push(job);
        if (!tEnqueue) tEnqueue = Date.now();
        if (kind === 'excited') excited = true;
        pieces += 1;
        // [excited] is an ElevenLabs v4 audio tag (docs); it covers only its own short opening piece.
        // The excited piece is quieter-scaled below: in measurement the tag roughly doubled loudness.
        const spoken = text.replace(/^[,;:\s]+/, ''); // a piece cut after an opening phrase can start with its comma
        const tone = TONES[kind];
        const tagged = tone ? `${tone[0]} ${spoken}` : spoken;
        const gain = tone ? tone[1] : 1;
        streamSpeech(tagged, signal, (c) => job.chunks.push(gain === 1 ? c : scale(c, gain)), said.length ? said.join(' ').slice(-300) : undefined, next || undefined)
          .then(() => { job.done = true; }, (e) => { job.err = e; job.done = true; });
        said.push(text);
        this.sayingText = said.join(' ');
        const shown = said.join(' ').replace(/\s+([,.;:!?])/g, '$1');
        if (!started) { started = true; this.send({ type: 'speak', text: shown, hold: holdBack ? HOLD_BACK_MS : 0 }); }
        else this.send({ type: 'caption', text: shown });
      },
    });
    const producer = (async () => {
      try {
        for await (const d of rs.chunks()) {
          if (timing && timing.sparkFirstMs === undefined) timing.sparkFirstMs = Date.now() - tStart;
          splitter.feed(d);
          if (splitter.halted) break;
        }
        splitter.end();
      } catch (e) { producerErr = e; } finally { producerDone = true; }
    })();

    const keep = () => { if (record && said.length) { this.history.push({ role: 'assistant', content: said.join(' ') }); memory.appendTurn(this.profile.id, this.callId, { who: 'Maya', text: said.join(' ') }); } };
    for (;;) {
      if (myGen !== this.gen || this.closed) { keep(); return; } // interrupted
      const head = jobs[0];
      if (!head) { if (producerDone) break; await sleep(4); continue; }
      // Piece joins: drop each piece's leading silence, hold back its tail until we know where it ends,
      // then trim the trailing silence. Held back only when more audio can follow in this reply.
      while (head.chunks.length) head.buf = head.buf ? Buffer.concat([head.buf, head.chunks.shift()]) : head.chunks.shift();
      if (head.buf && !head.leadDone && (head.done || head.buf.length >= 120 * 48)) {
        head.leadDone = true;
        head.buf = head.buf.subarray(Math.max(0, firstLoud(head.buf) - PAD_LEAD_BYTES));
        if (head.tone) head.buf = fadeIn(head.buf);
      }
      if (head.buf && head.leadDone) {
        const mayFollow = !producerDone || jobs.length > 1;
        const keepBack = head.done ? head.buf.length : (mayFollow ? TAIL_HOLD_BYTES : 0);
        let out = null;
        if (head.done) { out = head.buf.subarray(0, Math.min(head.buf.length, lastLoud(head.buf) + PAD_TAIL_BYTES)); head.buf = null; if (head.tone) out = fadeOut(out, head.kind); }
        else if (head.buf.length > keepBack) { const n = (head.buf.length - keepBack) & ~1; out = head.buf.subarray(0, n); head.buf = head.buf.subarray(n); }
        if (out && out.length) {
          if (!sentAny && timing) {
            const now = Date.now();
            timing.ttsFirstMs = now - tEnqueue;
            timing.speechEndToFirstAudioMs = now - timing.endedAt;
          }
          sentAny = true;
          this.lastSaidAt = Date.now();
          this.playUntil = Math.max(this.playUntil, this.lastSaidAt) + out.length / 48;
          this.ws.send(out);
        }
      }
      if (head.done) {
        if (head.err) {
          if (sentAny) { this.abort.abort(); return this.fatal(head.err.message); }
          // Voice failed before any sound: show the whole reply; the browser labels its own voice MOCK.
          console.error('TTS error:', head.err.message);
          await producer;
          this.abort.abort();
          keep();
          this.responding = false;
          this.playUntil = Date.now() + said.join(' ').length * 70; // browser voice: rough length
          this.armSilence();
          return this.send({ type: 'ttsFailed', text: said.join(' '), error: head.err.message });
        }
        jobs.shift();
        continue;
      }
      await sleep(4);
    }
    await producer;
    if (myGen !== this.gen || this.closed) { keep(); return; }
    if (splitter.halted) {
      // Spark read the person as in crisis before saying anything: use the safety reply instead.
      this.abort.abort();
      this.history.push({ role: 'assistant', content: ESCALATION });
      return this.escalate('feel', timing);
    }
    if (producerErr && !(producerErr.empty && !said.length)) return this.fatal(producerErr.message);
    if (!said.length) {
      // Spark said nothing even after one retry. Never fake a reply: say so honestly, drop the
      // turn from history so it cannot poison the next one, and leave the call ready to listen.
      console.error('Recovery: Spark returned no reply text');
      if (record && this.history.length && this.history[this.history.length - 1].role === 'user') this.history.pop();
      return this.speak(RECOVERY);
    }
    keep();
    this.responding = false;
    if (record && said.length) {
      // Remember how this reply opened, so the next one can open differently.
      const first = said[0].toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
      this.openings = [...this.openings, first].slice(-3);
      this.openedWithInterjection = /^(oh|well|ah|hmm|um)\b/i.test(said[0]);
      const all = said.join(' ');
      if (/\b(your name|what should i call you|what to call you|call you\?|who am i (talking|speaking) (to|with))\b/i.test(all)) this.askedName = true;
      for (const n of this.names.values()) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(all)) this.lastNameUse = this.replyCount;
      this.replyCount += 1;
    }
    if (hangup) this.hangUp(); else this.armSilence();
    if (timing) {
      timing.feel = feel;
      timing.excited = excited;
      timing.whisperPieces = 0; // whispers are off
      this.prevDelivery = delivery;
      console.log('latency', JSON.stringify({ ...timing, endedAt: undefined }));
    }
    this.send({ type: 'audioEnd', timing: timing ? { ...timing, endedAt: undefined } : null });
  }

  // Greeting: fixed words, spoken through the same voice path.
  speak(text) {
    clearTimeout(this.recoverTimer);
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    return this.speakReply(fixedReply(text), null, myGen);
  }
}

module.exports = { Call };
