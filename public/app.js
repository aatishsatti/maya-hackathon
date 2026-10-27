// Maya voice loop (browser side). Feature 1, mock mode.
//
// Call states: listening -> thinking -> speaking -> listening ...
// Off-call state: idle.
// Speech detection is a simple loudness gate on the mic (no external library).
// Known limits: the first ~100 ms of an utterance is not recorded (recorder starts
// after the gate opens). Playback in mock mode uses the browser's own speech voice
// as a placeholder; it is replaced when real audio output is built.
(() => {
  'use strict';

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
      case 'ready': c.ready = true; chime(c); break; // an instant soft cue while the greeting is being written; it says nothing and claims nothing
      case 'speak':
        stopPlayback(); c.voiceDone = false;
        c.ducked = false; clearTimeout(c.duckFailsafe); setMaster(c, 1, 0.01);
        c.gate = ev.hold ? { holdMs: ev.hold, open: false, paused: false, held: [], timer: null } : null;
        setState('speaking'); captionEl.textContent = `Maya: ${ev.text}`; break;
      case 'unduck': unduck(c); break;
      case 'caption': if (orb.dataset.state === 'speaking') captionEl.textContent = `Maya: ${ev.text}`; break;
      case 'audioEnd':
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

  async function startReal(c, myGen) {
    try { await c.ctx.audioWorklet.addModule('/mic-worklet.js'); }
    catch { endCall('Maya could not start the microphone. Please reload the page and try again.'); return; }
    if (myGen !== gen) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    c.master = c.ctx.createGain(); // Maya's voice goes through this so her volume can dip instantly
    c.master.connect(c.ctx.destination);
    const tap = new AudioWorkletNode(c.ctx, 'mic-tap');
    c.tap = tap;
    const mute = c.ctx.createGain(); // worklet must be connected to run; silent so the mic is never played back
    mute.gain.value = 0;
    c.ctx.createMediaStreamSource(c.stream).connect(tap);
    tap.connect(mute).connect(c.ctx.destination);
    tap.port.onmessage = (e) => { if (c.ready && ws.readyState === WebSocket.OPEN) ws.send(e.data.buffer); };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', sampleRate: c.ctx.sampleRate, localHour: new Date().getHours(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, profileId: window.mayaProfile && window.mayaProfile.id, reason: c.reason, outreachId: c.outreachId }));
    ws.onmessage = (m) => {
      if (myGen !== gen) return;
      if (typeof m.data === 'string') { try { onServerEvent(c, JSON.parse(m.data)); } catch { /* ignore */ } return; }
      if (orb.dataset.state === 'speaking') feedChunk(c, new Uint8Array(m.data));
    };
    ws.onclose = () => { if (myGen === gen) endCall('The connection to Maya ended. Please call again.'); };
    ws.onerror = () => {};
  }

  // ---- Call lifecycle ----

  // opts: { reason: 'callback'|'reminder', outreachId } when Maya rang and the person pressed Accept.
  async function startCall(opts = {}) {
    if (!window.mayaProfile || !window.mayaProfile.id) { showError('Please pick who is talking first.'); return; } // no profile, no call
    const myGen = ++gen;
    showError('');
    captionEl.textContent = '';
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
      reason: opts.reason, outreachId: opts.outreachId,
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
