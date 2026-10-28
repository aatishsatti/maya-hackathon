// Maya voice loop (browser side). Feature 1, mock mode.
//
// Call states: listening -> thinking -> speaking -> listening ...
// Off-call state: idle.
// Speech detection is a simple loudness gate on the mic (no external library).
// Known limits: the first ~100 ms of an utterance is not recorded (recorder starts
// after the gate opens). Playback in mock mode uses the browser's own speech voice
// as a placeholder; it is replaced when real audio output is built.
// Pure helpers, kept outside the page code so tests can load them in Node (module.exports at the bottom).
//
// Orb levels. Live loudness (mic RMS or Maya's playback RMS, 0..1) becomes 0..1 here, is smoothed, and then drives the orb
// (orb.js) INSIDE the dome only: how big and high the inner glow sits (level, raise) and how fast it moves (rate). No outer
// glow, no rings outside. When nothing is heard the orb breathes slowly on its own.
const MayaOrbLevels = {
  FLOOR_DB: -50,           // at or below this the level is 0
  CEIL_DB: -10,            // at or above this the level is 1
  ATTACK_MS: 80,           // rises quickly with the voice
  RELEASE_MS: 350,         // falls slowly
  MAX_RAISE: 14,           // percentage points the water can rise
  MAX_RATE: 3.5,           // swell speed multiplier at full level
  BREATH_MS: 6000,         // one slow breath when silent
  BREATH_RAISE: 2.5,
  BREATH_RATE: 0.7,
  normalize(rms) {
    if (!(rms > 0)) return 0;
    const db = 20 * Math.log10(rms);
    return Math.min(1, Math.max(0, (db - this.FLOOR_DB) / (this.CEIL_DB - this.FLOOR_DB)));
  },
  smooth(prev, target, dtMs) {
    const tau = target > prev ? this.ATTACK_MS : this.RELEASE_MS;
    return prev + (target - prev) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
  },
  // Mock mode only: the browser's own speech voice has no audio node, so there is no real playback level to read. While Maya
  // speaks the orb pulses slowly instead (it rises when she starts, settles when she stops). Real mode never uses this.
  MOCK_PULSE_MS: 1800,
  mockPulse(tMs) { return 0.3 + 0.25 * (0.5 - 0.5 * Math.cos((2 * Math.PI * tMs) / this.MOCK_PULSE_MS)); },
  // The level the orb should follow right now. Real playback and mic levels are always real readings; the synthetic pulse
  // exists only for mock mode, and real mode without a reading (for example the fallback browser voice) stays at 0.
  target({ src, mode, hasAnalyser, playRms, micRms, tMs }) {
    if (src === 'mic') return this.normalize(micRms);
    if (src !== 'playback') return 0;
    if (hasAnalyser) return this.normalize(playRms);
    return mode === 'mock' ? this.mockPulse(tMs) : 0;
  },
  // Which level the orb follows: Maya's playback while she speaks, the person's mic while they talk, none otherwise.
  source({ state, hearing, muted }) {
    if (state === 'speaking') return 'playback';
    if (state === 'listening' && hearing && !muted) return 'mic';
    return 'none';
  },
  // Smoothed level + time -> what to draw. Silence (level ~0) gives the slow breathing, speech overrides it.
  frame(level, tMs) {
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * tMs) / this.BREATH_MS); // 0..1..0
    const l = Math.min(1, Math.max(0, level));
    return {
      raise: Math.max(this.BREATH_RAISE * breath, l * this.MAX_RAISE),
      rate: (this.BREATH_RATE + 0.2 * breath) + l * (this.MAX_RATE - (this.BREATH_RATE + 0.2 * breath)),
    };
  },
};

// Call view states. The call is either not live (ended) or live with a view and a mute flag:
//   full       chat hidden, big orb only
//   minimized  small orb, chat visible, call live
//   muted      call live, Maya cannot hear; the orb is marked muted (small, or big if the person expanded it)
//   ended      chat full, Call button back
// Muting never un-mutes by itself: minimizing or expanding a muted call keeps it muted. While live, typed chat gets a text
// reply only and a voice note's reply is text too (one Maya voice at a time); the chat is one thread before, during and after.
class MayaCallState {
  constructor(onChange) { this.live = false; this.view = 'full'; this.muted = false; this.onChange = onChange || (() => {}); }
  get state() { return !this.live ? 'ended' : this.muted ? 'muted' : this.view; }
  get orb() { return !this.live ? 'none' : this.view === 'full' ? 'big' : 'small'; }
  get chatVisible() { return !this.live || this.view === 'minimized'; }
  get micOpen() { return this.live && !this.muted; }
  get callButton() { return !this.live; }
  get typedReply() { return this.live ? 'text-only' : 'text'; }
  get voiceNoteReply() { return this.live ? 'text-only' : 'voice'; }
  set(live, view, muted) {
    const before = `${this.state}/${this.view}`;
    this.live = live; this.view = view; this.muted = muted;
    if (`${this.state}/${this.view}` !== before) this.onChange(this);
  }
  start() { this.set(true, 'full', false); }
  end() { this.set(false, 'full', false); }
  minimize() { if (this.live) this.set(true, 'minimized', this.muted); }
  expand() { if (this.live) this.set(true, 'full', this.muted); }
  mute() { if (this.live) this.set(true, this.view, true); }
  unmute() { if (this.live) this.set(true, this.view, false); }
}
// Line recovery (render-test, hosting): what the page does when the call's socket dies without a goodbye. It reconnects within a second or two
// and sends the call's token so the server hands the same call back. Gives up after WINDOW_MS (the server holds the call for a little longer).
// Heartbeat: the page pings every PING_MS and expects to hear anything from the server within DEAD_MS, else the line counts as lost.
const MayaLine = {
  WINDOW_MS: 18000, RETRY_MS: [300, 1000], PING_MS: 5000, DEAD_MS: 12000, ATTEMPT_MS: 4000,
  // First loss at lostAt; `attempt` is how many reconnects were tried. -> { retry, delay } or { retry: false }.
  next({ now, lostAt, attempt, hasToken }) {
    if (!hasToken || now - lostAt >= this.WINDOW_MS) return { retry: false };
    return { retry: true, delay: this.RETRY_MS[Math.min(attempt, this.RETRY_MS.length - 1)] };
  },
  dead({ now, lastRx }) { return now - lastRx > this.DEAD_MS; },
};

if (typeof module !== 'undefined') module.exports = { MayaOrbLevels, MayaCallState, MayaLine };

(() => {
  'use strict';
  if (typeof document === 'undefined') return; // loaded by a test, not a page

  const SILENCE_MS = 1400;       // seniors pause; wait before ending an utterance
  const MAX_UTTERANCE_MS = 30000;
  const TICK_MS = 50;
  const MIN_BLOB_BYTES = 1000;   // anything smaller is a click or breath, not speech
  // Loudness (RMS, 0..1) needed to count as speech. Higher while Maya speaks so her
  // own voice leaking into the mic does not cut her off. Echo cancellation is also on.
  const THRESH_NORMAL = 0.02;
  const THRESH_WHILE_SPEAKING = 0.06;
  const ONSET_TICKS_NORMAL = 2;        // 100 ms
  const ONSET_TICKS_WHILE_SPEAKING = 6; // 300 ms

  const STATUS = {
    idle: 'Press the button to talk with Maya.',
    starting: 'Connecting to your microphone...',
    listening: 'Maya is listening.',
    hearing: 'I hear you.',
    thinking: 'Maya is thinking.',
    speaking: 'Maya is speaking. You can talk any time to stop her.',
    reconnecting: 'The line dropped. Reconnecting...',
  };

  const $ = (id) => document.getElementById(id);
  const orb = $('orb');
  const statusEl = $('status');
  const captionEl = $('caption');
  const errorEl = $('error');
  const callBtn = $('callBtn');
  const modeNote = $('modeNote');

  let call = null;   // active call, or null
  let mode = 'mock'; // from /api/config
  let gen = 0;       // bumped on every start/end; stale async work checks it

  // Call view state (full / minimized / muted / ended). Wired to the real call here; the screens that show it come later:
  // body[data-call-view] and orb[data-muted] are the hooks. Muting turns the mic track off (Maya hears silence) and tells
  // the server so its silence timers do not hang up a call the person chose to mute.
  const callState = new MayaCallState((cs) => {
    document.body.dataset.callView = cs.state;   // ended | full | minimized | muted
    document.body.dataset.callLayout = cs.orb;   // none | big | small (what the screen shows)
    orb.dataset.muted = String(cs.muted);
    window.dispatchEvent(new Event('maya-callstate'));
    const c = call;
    if (!c) return;
    c.stream.getAudioTracks().forEach((t) => { t.enabled = cs.micOpen; });
    if (c.ws && c.ws.readyState === WebSocket.OPEN && c.sentMute !== cs.muted) { c.ws.send(JSON.stringify({ type: 'mute', on: cs.muted })); c.sentMute = cs.muted; } // only when the mute flag really changed
  });
  document.body.dataset.callView = callState.state;
  document.body.dataset.callLayout = callState.orb;

  // ---- Orb levels: live loudness moves the water inside the circle (see MayaOrbLevels above) ----
  const reduceMotion = Boolean(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  let orbLevel = 0;
  let orbLast = 0;
  function rmsOf(analyser, buf) {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }
  function orbTick(ts) {
    requestAnimationFrame(orbTick);
    const dt = orbLast ? ts - orbLast : 16;
    orbLast = ts;
    const c = call;
    let target = 0;
    if (c) {
      const src = MayaOrbLevels.source({ state: orb.dataset.state, hearing: statusEl.textContent === STATUS.hearing, muted: callState.muted });
      target = MayaOrbLevels.target({ src, mode, hasAnalyser: Boolean(c.playAnalyser), playRms: src === 'playback' ? rmsOf(c.playAnalyser, c.playBuf) : 0, micRms: src === 'mic' ? rmsOf(c.analyser, c.buf) : 0, tMs: ts });
    }
    orbLevel = MayaOrbLevels.smooth(orbLevel, target, dt);
    const f = MayaOrbLevels.frame(orbLevel, ts);
    if (window.mayaOrb) window.mayaOrb.draw(ts, orbLevel, f); // orb.js paints the dome from the live level, speed and raise
  }
  if (!reduceMotion) requestAnimationFrame(orbTick);

  function setState(state, statusKey) {
    orb.dataset.state = state;
    orb.setAttribute('aria-label', state === 'idle' ? 'Maya is not on a call' : `Maya is ${state}`);
    statusEl.textContent = STATUS[statusKey || state];
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function setLive(live) {
    callBtn.dataset.live = String(live);
    callBtn.textContent = live ? 'End Call' : 'Call Maya';
    if (window.mayaProfile) window.mayaProfile.setLive(live);
  }

  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error */ }
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  // ---- Speaking ----

  let player = null; // current ElevenLabs audio element

  function stopSpeaking() {
    if (player) { player.onended = null; player.onerror = null; player.pause(); player = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
  }

  // Real voice: server returns base64 mp3 from ElevenLabs. Resolves true if it played.
  function playServerAudio(data, myGen, done) {
    return new Promise((resolve) => {
      const a = new Audio(`data:${data.audioType};base64,${data.audio}`);
      player = a;
      a.onended = () => { player = null; done(); resolve(true); };
      a.onerror = () => { player = null; resolve(false); };
      a.play().catch(() => { player = null; resolve(false); });
    });
  }

  // Mock-mode voice. Only a clear female en-US voice is used; never the system default,
  // which can be a male or novelty voice. Order: Samantha (Mac), Google US English
  // (Chrome), then the first en voice with a known female name.
  const VOICE_VOLUME = 1.0;
  const VOICE_RATE = 1.0;
  const VOICE_PITCH = 1.0;
  const FEMALE_NAMES = ['Samantha', 'Google US English', 'Ava', 'Allison', 'Susan', 'Karen',
    'Victoria', 'Zira', 'Aria', 'Jenny', 'Joanna', 'Moira', 'Tessa', 'Serena', 'Female'];

  function pickVoice() {
    const en = speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
    for (const name of FEMALE_NAMES) {
      const us = en.find((v) => /^en[-_]US$/i.test(v.lang) && v.name.startsWith(name));
      if (us) return us;
    }
    for (const name of FEMALE_NAMES) {
      const any = en.find((v) => v.name.startsWith(name));
      if (any) return any;
    }
    return null;
  }

  // Voices load asynchronously in Chrome; wait briefly for them.
  function voiceReady() {
    return new Promise((resolve) => {
      if (speechSynthesis.getVoices().length) return resolve();
      const t = setTimeout(resolve, 1500);
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  async function speak(data, myGen) {
    const text = data.reply;
    setState('speaking');
    captionEl.textContent = `Maya: ${text}`;
    const done = () => {
      if (myGen === gen && call && orb.dataset.state === 'speaking') {
        setState('listening');
      }
    };
    if (data.audio) {
      if (await playServerAudio(data, myGen, done)) return;
      data = { ...data, ttsError: 'Audio could not be played' };
    }
    if (data.ttsError) {
      // ElevenLabs failed: browser voice, clearly labelled. Never silent, never fake.
      captionEl.textContent = `Maya (MOCK voice, ElevenLabs failed): ${text}`;
      showError(`ElevenLabs voice failed: ${data.ttsError}`);
    }
    if (!window.speechSynthesis) { setTimeout(done, 2500); return; }
    await voiceReady();
    if (myGen !== gen || !call || orb.dataset.state !== 'speaking') return; // ended or interrupted
    const voice = pickVoice();
    if (!voice) {
      // Fail visibly rather than speak in an unknown, possibly male or distorted voice.
      showError('No clear female English voice was found on this device, so Maya\u2019s reply is shown as text only.');
      setTimeout(done, 2500);
      return;
    }
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.volume = VOICE_VOLUME;
    u.rate = VOICE_RATE;
    u.pitch = VOICE_PITCH;
    u.onend = done;
    u.onerror = (e) => { if (e.error !== 'canceled' && e.error !== 'interrupted') done(); };
    speechSynthesis.speak(u);
  }

  // ---- Utterance capture ----

  function startUtterance() {
    const c = call;
    if (orb.dataset.state === 'speaking') stopSpeaking();     // barge-in over Maya
    if (c.fetchAbort) { c.fetchAbort.abort(); c.fetchAbort = null; } // barge-in while thinking
    const u = { chunks: [], discard: false, recorder: null, startedAt: Date.now() };
    const mime = pickMime();
    u.recorder = new MediaRecorder(c.stream, mime ? { mimeType: mime } : undefined);
    u.recorder.ondataavailable = (e) => { if (e.data && e.data.size) u.chunks.push(e.data); };
    u.recorder.onstop = () => onUtteranceStopped(u, c.gen);
    u.recorder.start();
    c.utterance = u;
    c.lastVoice = Date.now();
    setState('listening', 'hearing');
  }

  function finishUtterance() {
    const c = call;
    const u = c.utterance;
    c.utterance = null;
    c.onsetTicks = 0;
    setState('thinking');
    if (u.recorder.state !== 'inactive') u.recorder.stop();
  }

  // Mock mode only (real mode streams to the server and never starts a recorder): the recorder stopped, so send what was said
  // to the mock server and play the mock reply. Restored as it was before Feature 1 removed it while startUtterance still calls it.
  async function onUtteranceStopped(u, myGen) {
    if (u.discard || myGen !== gen || !call) return;
    const blob = new Blob(u.chunks, { type: u.recorder.mimeType || 'audio/webm' });
    if (blob.size < MIN_BLOB_BYTES) { setState('listening'); return; }
    const c = call;
    c.turn += 1;
    const ac = new AbortController();
    c.fetchAbort = ac;
    try {
      const data = await api(`/api/turn`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type },
        body: blob,
        signal: ac.signal,
      });
      if (myGen !== gen) return;
      c.fetchAbort = null;
      speak(data, myGen);
    } catch (e) {
      if (e.name === 'AbortError' || myGen !== gen) return;
      endCall(`Something went wrong: ${e.message}`);
    }
  }

  function tick() {
    const c = call;
    if (!c) return;
    c.analyser.getFloatTimeDomainData(c.buf);
    let sum = 0;
    for (let i = 0; i < c.buf.length; i++) sum += c.buf[i] * c.buf[i];
    const rms = Math.sqrt(sum / c.buf.length);
    const speaking = orb.dataset.state === 'speaking';
    const loud = rms > (speaking ? THRESH_WHILE_SPEAKING : THRESH_NORMAL);
    const now = Date.now();

    if (c.ws) { realTick(c, rms); return; } // real mode: duck on loud sound; the server decides the stop from real words
    if (!c.utterance) {
      c.onsetTicks = loud ? c.onsetTicks + 1 : 0;
      if (c.onsetTicks >= (speaking ? ONSET_TICKS_WHILE_SPEAKING : ONSET_TICKS_NORMAL)) {
        c.onsetTicks = 0;
        startUtterance();
      }
      return;
    }
    if (loud) c.lastVoice = now;
    if (now - c.lastVoice > SILENCE_MS || now - c.utterance.startedAt > MAX_UTTERANCE_MS) finishUtterance();
  }

  // ---- Real mode: live socket to the server (Transcribe ears, Spark brain, ElevenLabs voice) ----
  // Mic goes up as Float32 mono at the browser's own rate; Maya's voice comes back as
  // PCM16 mono 24 kHz and is scheduled on the audio clock so the first chunk plays at once.
  const HEARING_STUCK_MS = 15000; // noise (TV, fan) that never turns into words must not hold the mic
  const voiceSources = new Set();
  let nextPlayTime = 0;

  // Full-duplex feel. Loud sound over Maya's voice (the person starting to talk, or a system ding) makes
  // her volume dip within ~150 ms and tells the server. The server stops her for good only when it hears
  // real words within ~1.5 s ('stopped'); otherwise it sends 'unduck' and her volume comes back and she
  // carries on. A ding is therefore a dip, never a stop.
  const DUCK_RMS = 0.05;          // mic level that counts as loud
  const DUCK_TICKS = 3;           // x TICK_MS (50 ms) = 150 ms of sustained loudness
  const DUCK_GAIN = 0.12;         // her volume while ducked
  const DUCK_FAILSAFE_MS = 2200;  // never stay ducked if the server says nothing

  function setMaster(c, gain, seconds) {
    if (!c.master) return;
    c.master.gain.cancelScheduledValues(c.ctx.currentTime);
    c.master.gain.setTargetAtTime(gain, c.ctx.currentTime, seconds);
  }

  function duck(c) {
    c.ducked = true;
    setMaster(c, DUCK_GAIN, 0.01);
    if (c.gate && !c.gate.open) { c.gate.paused = true; clearTimeout(c.gate.timer); } // not playing yet: hold the start
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'duck' }));
    console.log('duck', Date.now());
    clearTimeout(c.duckFailsafe);
    c.duckFailsafe = setTimeout(() => unduck(c), DUCK_FAILSAFE_MS);
  }

  function unduck(c) {
    if (!c.ducked) return;
    c.ducked = false;
    clearTimeout(c.duckFailsafe);
    setMaster(c, 1, 0.04);
    if (c.gate && !c.gate.open) { c.gate.paused = false; openGate(c); }
    console.log('unduck', Date.now());
  }

  function realTick(c, rms) {
    if (orb.dataset.state !== 'speaking' || c.ducked) { c.loudTicks = 0; return; }
    c.loudTicks = rms > DUCK_RMS ? (c.loudTicks || 0) + 1 : 0;
    if (c.loudTicks >= DUCK_TICKS) { c.loudTicks = 0; duck(c); }
  }

  // Hold-back: when the server ended the turn itself (not Transcribe), the first 300 ms of Maya's audio
  // is held before it plays. If the person starts talking again in that window the start is held
  // (duck) and, once words arrive, discarded - so a false start does not talk over them.
  function openGate(c) {
    const g = c.gate;
    if (!g || g.open || g.paused) return;
    g.open = true;
    for (const b of g.held) playChunk(c, b);
    g.held = [];
  }

  function feedChunk(c, buf) {
    const g = c.gate;
    if (!g || g.open) { playChunk(c, buf); return; }
    g.held.push(buf);
    if (!g.timer && !g.paused) g.timer = setTimeout(() => openGate(c), g.holdMs);
  }

  function stopPlayback() {
    for (const src of voiceSources) { src.onended = null; try { src.stop(); } catch { /* already ended */ } }
    voiceSources.clear();
    nextPlayTime = 0;
    if (call && call.gate) { clearTimeout(call.gate.timer); call.gate = null; }
  }

  function playChunk(c, buf) {
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const ab = c.ctx.createBuffer(1, f32.length, 24000);
    ab.copyToChannel(f32, 0);
    const src = c.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(c.master || c.ctx.destination);
    nextPlayTime = Math.max(nextPlayTime, c.ctx.currentTime + 0.03);
    src.start(nextPlayTime);
    nextPlayTime += ab.duration;
    voiceSources.add(src);
    src.onended = () => { voiceSources.delete(src); finishIfDone(c); };
  }

  function finishIfDone(c) {
    if (call === c && c.voiceDone && voiceSources.size === 0 && orb.dataset.state === 'speaking') {
      c.voiceDone = false;
      setState('listening');
    }
  }

  function armStuckWatchdog(c) {
    clearTimeout(c.stuck);
    c.stuck = setTimeout(() => { if (call === c && orb.dataset.state === 'listening' && statusEl.textContent === STATUS.hearing) setState('listening'); }, HEARING_STUCK_MS);
  }

  // No loudness-based barge-in here: a system ding or a click must not stop Maya. The server stops her
  // only when Transcribe hears real words (see call.js considerBargeIn) and sends 'stopped'.

  const THINK_TIMEOUT_MS = 30000; // fail fast: a turn that never gets an answer ends the call

  // Two soft rising notes (about 0.4 s), played the moment the line is live, so there is no dead silence while Maya's
  // first words are written. A sound only: it does not pretend she has heard anything.
  function chime(c) {
    try {
      const t0 = c.ctx.currentTime + 0.02;
      [[523.25, 0], [659.25, 0.16]].forEach(([hz, at]) => {
        const o = c.ctx.createOscillator(), g = c.ctx.createGain();
        o.type = 'sine'; o.frequency.value = hz;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.06, t0 + at + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.3);
        o.connect(g); g.connect(c.master || c.ctx.destination);
        o.start(t0 + at); o.stop(t0 + at + 0.32);
      });
    } catch { /* no audio context: skip the cue */ }
  }

  function onServerEvent(c, ev) {
    clearTimeout(c.thinkTimer);
    if (ev.type === 'thinking' || ev.type === 'speechEnd') {
      c.thinkTimer = setTimeout(() => { if (call === c) endCall('Maya did not answer in time. Please call again.'); }, THINK_TIMEOUT_MS);
    }
    switch (ev.type) {
      case 'ready': c.ready = true; c.token = ev.resume; c.lostAt = 0; chime(c); break;
      case 'resumed': // the server gave this call back after the line dropped: carry on
        c.ready = true; c.lostAt = 0; c.attempt = 0; clearTimeout(c.attemptTimer);
        if (callState.muted && c.ws.readyState === WebSocket.OPEN) { c.ws.send(JSON.stringify({ type: 'mute', on: true })); c.sentMute = true; }
        setState(voiceSources.size ? 'speaking' : 'listening');
        break;
      case 'resumeFailed': endCall(LINE_LOST_MSG); break;
      case 'pong': break; // an instant soft cue while the greeting is being written; it says nothing and claims nothing
      case 'speak':
        // cont: the reply's first words, arriving behind a lead-in line that is still playing: do not cut that line off.
        if (!ev.cont) {
          stopPlayback(); c.voiceDone = false;
          c.ducked = false; clearTimeout(c.duckFailsafe); setMaster(c, 1, 0.01);
          c.gate = ev.hold ? { holdMs: ev.hold, open: false, paused: false, held: [], timer: null } : null;
        }
        // lead: a short acknowledgement while Maya is still writing the real reply. The orb stays in its thinking colours.
        c.leadActive = Boolean(ev.lead);
        if (ev.lead) { setState('thinking'); break; }
        setState('speaking'); captionEl.textContent = `Maya: ${ev.text}`; break;
      case 'unduck': unduck(c); break;
      case 'caption': if (orb.dataset.state === 'speaking') captionEl.textContent = `Maya: ${ev.text}`; break;
      case 'audioEnd':
        c.leadActive = false;
        c.voiceDone = true; finishIfDone(c);
        if (ev.timing) console.log('latency', ev.timing);
        break;
      case 'ttsFailed':
        speak({ reply: ev.text, ttsError: ev.error }, c.gen); break; // browser voice, labelled MOCK
      case 'speechStart':
        if (orb.dataset.state !== 'speaking') { setState('listening', 'hearing'); armStuckWatchdog(c); }
        break;
      case 'partial': captionEl.textContent = `You: ${ev.text}`; armStuckWatchdog(c); break;
      case 'speechEnd': if (orb.dataset.state !== 'speaking') setState('thinking'); break;
      case 'thinking': setState('thinking'); break;
      case 'idle': if (orb.dataset.state !== 'speaking') setState('listening'); break;
      case 'stopped':
        c.leadActive = false;
        console.log('stopped', Date.now());
        stopPlayback(); c.voiceDone = false;
        c.ducked = false; clearTimeout(c.duckFailsafe); setMaster(c, 1, 0.01);
        if (orb.dataset.state === 'speaking') setState('listening', 'hearing');
        break;
      case 'hangup': {
        // Maya said goodbye after a long silence: end the call cleanly (mic, audio, timers released).
        const said = captionEl.textContent;
        endCall();
        captionEl.textContent = said;
        statusEl.textContent = 'The call has ended.';
        break;
      }
      case 'error': endCall(`Something went wrong: ${ev.message}`); break;
      default: break;
    }
  }

  const LINE_LOST_MSG = 'The connection to Maya ended. Please call again.';

  async function startReal(c, myGen) {
    try { await c.ctx.audioWorklet.addModule('/mic-worklet.js'); }
    catch { endCall('Maya could not start the microphone. Please reload the page and try again.'); return; }
    if (myGen !== gen) return;
    c.attempt = 0; c.lostAt = 0; c.lastRx = Date.now();
    openSocket(c, myGen, false);
    c.master = c.ctx.createGain(); // Maya's voice goes through this so her volume can dip instantly
    c.master.connect(c.ctx.destination);
    c.playAnalyser = c.ctx.createAnalyser(); // reads Maya's playback loudness for the orb; its output goes nowhere
    c.playAnalyser.fftSize = 1024;
    c.playBuf = new Float32Array(c.playAnalyser.fftSize);
    c.master.connect(c.playAnalyser);
    const tap = new AudioWorkletNode(c.ctx, 'mic-tap');
    c.tap = tap;
    const mute = c.ctx.createGain(); // worklet must be connected to run; silent so the mic is never played back
    mute.gain.value = 0;
    c.ctx.createMediaStreamSource(c.stream).connect(tap);
    tap.connect(mute).connect(c.ctx.destination);
    tap.port.onmessage = (e) => { if (c.ready && c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(e.data.buffer); };
    c.heartbeat = setInterval(() => {
      if (myGen !== gen || call !== c) return;
      if (c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'ping' }));
      if (c.ws && MayaLine.dead({ now: Date.now(), lastRx: c.lastRx })) lineLost(c, c.ws, myGen); // a half-open socket can take minutes to report itself
    }, MayaLine.PING_MS);
  }

  // One socket for the call. resume=false: a new call ('start'). resume=true: the same call again, identified by the token the server gave at 'ready'.
  function openSocket(c, myGen, resume) {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    c.lastRx = Date.now();
    ws.onopen = () => {
      if (myGen !== gen || c.ws !== ws) return;
      if (resume) { ws.send(JSON.stringify({ type: 'resume', token: c.token })); return; }
      ws.send(JSON.stringify({ type: 'start', sampleRate: c.ctx.sampleRate, localHour: new Date().getHours(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, profileId: window.mayaProfile && window.mayaProfile.id, reason: c.reason, outreachId: c.outreachId }));
      if (callState.muted) { ws.send(JSON.stringify({ type: 'mute', on: true })); c.sentMute = true; } // muted while the line was still connecting
    };
    ws.onmessage = (m) => {
      if (myGen !== gen || c.ws !== ws) return;
      c.lastRx = Date.now();
      if (typeof m.data === 'string') { try { onServerEvent(c, JSON.parse(m.data)); } catch { /* ignore */ } return; }
      if (orb.dataset.state === 'speaking' || c.leadActive) feedChunk(c, new Uint8Array(m.data)); // a lead-in line plays while the orb is still in its thinking colours
    };
    ws.onclose = () => lineLost(c, ws, myGen);
    ws.onerror = () => {};
    if (resume) { clearTimeout(c.attemptTimer); c.attemptTimer = setTimeout(() => lineLost(c, ws, myGen), MayaLine.ATTEMPT_MS); } // this try never connected or never got the call back
  }

  // The socket ended or went silent without the server saying goodbye. Before the call was live, or past the window, the call ends; otherwise reconnect.
  function lineLost(c, ws, myGen) {
    if (myGen !== gen || call !== c || c.ws !== ws) return;
    ws.onclose = null; ws.onmessage = null; ws.onopen = null;
    try { ws.close(); } catch { /* ignore */ }
    clearTimeout(c.thinkTimer); clearTimeout(c.attemptTimer);
    c.ready = false;
    const now = Date.now();
    if (!c.lostAt) c.lostAt = now;
    const step = MayaLine.next({ now, lostAt: c.lostAt, attempt: c.attempt, hasToken: Boolean(c.token) });
    if (!step.retry) { endCall(LINE_LOST_MSG); return; }
    c.attempt += 1;
    setState('thinking', 'reconnecting');
    c.reconnectTimer = setTimeout(() => { if (myGen === gen && call === c) openSocket(c, myGen, true); }, step.delay);
  }

  // ---- Call lifecycle ----

  // opts: { reason: 'callback'|'reminder', outreachId } when Maya rang and the person pressed Accept.
  async function startCall(opts = {}) {
    if (!window.mayaProfile || !window.mayaProfile.id) { showError('Please pick who is talking first.'); return; } // no profile, no call
    const myGen = ++gen;
    showError('');
    captionEl.textContent = '';
    callState.start();
    setLive(true);
    setState('idle', 'starting');

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      endCall('This browser cannot use the microphone here. Try Chrome or Safari on localhost or https.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (myGen === gen) endCall('Maya could not use the microphone. Please allow microphone access and try again.');
      return;
    }
    if (myGen !== gen) { stream.getTracks().forEach((t) => t.stop()); return; } // ended while asking

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);

    call = {
      gen: myGen, stream, ctx, analyser,
      buf: new Float32Array(analyser.fftSize),
      utterance: null, fetchAbort: null, timer: null,
      onsetTicks: 0, lastVoice: 0, turn: 0, ws: null, tap: null, ready: false,
      reason: opts.reason, outreachId: opts.outreachId, sentMute: false,
    };
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => { if (myGen === gen) endCall('The microphone stopped working. The call has ended.'); };
    });
    call.timer = setInterval(tick, TICK_MS);

    setState('thinking');
    if (mode === 'real') { await startReal(call, myGen); return; }
    try {
      const greet = await api('/api/greet', { method: 'POST' });
      if (myGen !== gen) return;
      if (call.utterance) return; // person started talking first; do not talk over them
      speak(greet, myGen);
    } catch (e) {
      if (myGen === gen) endCall(`Something went wrong: ${e.message}`);
    }
  }

  // Idempotent. Releases mic, audio, timers, requests and speech so nothing is left running.
  function endCall(errorMsg) {
    gen += 1;
    const c = call;
    call = null;
    if (c) {
      clearInterval(c.timer);
      clearTimeout(c.stuck);
      clearTimeout(c.duckFailsafe);
      clearTimeout(c.thinkTimer);
      clearInterval(c.heartbeat); clearTimeout(c.reconnectTimer); clearTimeout(c.attemptTimer);
      if (c.fetchAbort) c.fetchAbort.abort();
      if (c.utterance) {
        c.utterance.discard = true;
        if (c.utterance.recorder.state !== 'inactive') c.utterance.recorder.stop();
      }
      if (c.ws) { c.ws.onclose = null; c.ws.onmessage = null; try { c.ws.close(); } catch { /* ignore */ } }
      if (c.tap) { c.tap.port.onmessage = null; c.tap.disconnect(); }
      stopPlayback();
      c.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      c.ctx.close().catch(() => {});
    }
    stopSpeaking();
    callState.end();
    setLive(false);
    setState('idle');
    callBtn.disabled = false;
    showError(errorMsg || '');
    if (!errorMsg) captionEl.textContent = '';
  }

  callBtn.addEventListener('click', () => {
    if (callBtn.dataset.live === 'true') endCall();
    else startCall();
  });
  window.addEventListener('pagehide', () => endCall());
  window.mayaEndCall = () => endCall();
  window.mayaStartCall = (opts) => { if (!call) startCall(opts); };
  window.mayaInCall = () => Boolean(call);
  window.mayaCallState = callState; // minimize() / expand() / mute() / unmute(); read .state, .chatVisible, .orb, .typedReply, .voiceNoteReply

  api('/api/config').then((cfg) => {
    mode = cfg.mode;
    if (cfg.mode === 'mock') {
      modeNote.textContent = 'Mock mode: Maya’s replies are practice lines, not real understanding yet.';
      modeNote.hidden = false;
    }
  }).catch(() => {});

  setLive(false);
  setState('idle');
})();
