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

  function stopSpeaking() {
    if (window.speechSynthesis) speechSynthesis.cancel();
  }

  function speak(text, myGen) {
    setState('speaking');
    captionEl.textContent = `Maya: ${text}`;
    const done = () => {
      if (myGen === gen && call && orb.dataset.state === 'speaking') setState('listening');
    };
    if (!window.speechSynthesis) { setTimeout(done, 2500); return; }
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.85; // slow and patient
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

  async function onUtteranceStopped(u, myGen) {
    if (u.discard || myGen !== gen || !call) return;
    const blob = new Blob(u.chunks, { type: u.recorder.mimeType || 'audio/webm' });
    if (blob.size < MIN_BLOB_BYTES) { setState('listening'); return; }
    const c = call;
    c.turn += 1;
    const ac = new AbortController();
    c.fetchAbort = ac;
    try {
      const data = await api(`/api/turn?turn=${c.turn}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type },
        body: blob,
        signal: ac.signal,
      });
      if (myGen !== gen) return;
      c.fetchAbort = null;
      speak(data.reply, myGen);
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

  // ---- Call lifecycle ----

  async function startCall() {
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
      onsetTicks: 0, lastVoice: 0, turn: 0,
    };
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => { if (myGen === gen) endCall('The microphone stopped working. The call has ended.'); };
    });
    call.timer = setInterval(tick, TICK_MS);

    setState('thinking');
    try {
      const greet = await api('/api/greet', { method: 'POST' });
      if (myGen !== gen) return;
      if (call.utterance) return; // person started talking first; do not talk over them
      speak(greet.reply, myGen);
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
      if (c.fetchAbort) c.fetchAbort.abort();
      if (c.utterance) {
        c.utterance.discard = true;
        if (c.utterance.recorder.state !== 'inactive') c.utterance.recorder.stop();
      }
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

  api('/api/config').then((cfg) => {
    if (cfg.mode === 'mock') {
      modeNote.textContent = 'Mock mode: Maya’s replies are practice lines, not real understanding yet.';
      modeNote.hidden = false;
    }
  }).catch(() => {});

  setLive(false);
  setState('idle');
})();
