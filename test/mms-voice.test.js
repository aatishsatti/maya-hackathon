// Meta MMS TTS (facebook/mms-tts-eng) voice tests: PCM16 24 kHz mono format, warm synthesis without reload per sentence,
// speech-presentation markup stripping after safety/feel processing, and interruption stopping playback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mmsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-mms-voice-'));
process.env.MAYA_DATA_DIR = path.join(mmsTmpDir, 'profiles');
process.env.MAYA_CARE_DIR = path.join(mmsTmpDir, 'care');
process.env.MAYA_MEDIA_DIR = path.join(mmsTmpDir, 'media');

const brain = require('../brain');
const chat = require('../chat');

test.after(() => {
  brain.closeSpeechWorker();
});

test('MMS stripSpeechMarkup: removes [[bright]], [[soft]], [[warm]], [[whisper:...]], and bracketed tone tags so they are never spoken aloud', () => {
  const raw = '[[bright]] Hello Mathew! [[soft]] [sympathetic] I am right here with you. [[whisper: take your time]] [excited]';
  const cleaned = brain.stripSpeechMarkup(raw);
  assert.equal(cleaned, 'Hello Mathew! I am right here with you. take your time');
  assert.doesNotMatch(cleaned, /\[\[|\]\]|bright|soft|warm|sympathetic|excited|whisper/i);
});

test('MMS speak() and streamSpeech(): warm facebook/mms-tts-eng synthesizes non-empty PCM16 24kHz mono and interruption stops playback', async () => {
  const ready = await brain.warmSpeech();
  assert.equal(ready.model, 'facebook/mms-tts-eng');
  assert.equal(ready.target_sr, 24000);

  const sentences = [
    '[[bright]] Hello Mathew, how are you feeling today?',
    '[[warm]] That cup of tea with your friend sounds lovely.',
    '[[soft]] Please do not click that link or share any code yet.',
  ];
  const timings = [];
  for (const s of sentences) {
    const t0 = Date.now();
    const pcm = await brain.speak(s);
    const ms = Date.now() - t0;
    timings.push({ text: brain.stripSpeechMarkup(s), synthMs: ms, bytes: pcm.length, durationSec: Number((pcm.length / 48000).toFixed(2)) });
    assert.ok(Buffer.isBuffer(pcm) && pcm.length > 4800, 'non-empty PCM16 24kHz buffer (>100ms)');
    assert.equal(pcm.length % 2, 0, 'PCM16 sample-aligned (even byte length)');
    const wav = chat.pcmToWav(pcm);
    assert.equal(chat.isWav(wav), true, 'valid WAV header wrapping PCM16 24kHz mono');
    assert.equal(wav.readUInt16LE(22), 1, 'mono (1 channel)');
    assert.equal(wav.readUInt32LE(24), 24000, '24000 Hz sample rate');
    assert.equal(wav.readUInt16LE(34), 16, '16-bit PCM');
  }
  console.log('MMS_SYNTHESIS_TIMINGS', JSON.stringify(timings));

  // Interruption stops streamSpeech playback mid-stream
  const ac = new AbortController();
  const chunks = [];
  await assert.rejects(
    brain.streamSpeech('This is a longer sentence to test that an interruption aborts streaming playback immediately.', ac.signal, (c) => {
      chunks.push(c);
      ac.abort(new Error('bargein'));
    }),
    /bargein|aborted/i,
  );
  assert.equal(chunks.length, 1, 'streaming stops immediately when aborted on first chunk');

  // Sub-clause chunked streaming cuts time-to-first-chunk vs full-sentence synthesis
  const longSentence = 'Hello Mathew, I am really glad you called today, and I would love to hear all about how your afternoon with your friend went.';
  const clauses = brain.splitSpeechClauses(longSentence);
  assert.ok(clauses.length >= 2, `long sentence splits into sub-clauses: ${JSON.stringify(clauses)}`);
  const tFull0 = Date.now();
  const fullPcm = await brain.speak(longSentence);
  const fullMs = Date.now() - tFull0;
  let firstChunkMs = null;
  let streamedBytes = 0;
  const tStream0 = Date.now();
  await brain.streamSpeech(longSentence, new AbortController().signal, (c) => {
    if (firstChunkMs === null) firstChunkMs = Date.now() - tStream0;
    streamedBytes += c.length;
  });
  const totalStreamMs = Date.now() - tStream0;
  console.log('MMS_FIRST_CHUNK_VS_FULL', JSON.stringify({ clauses, firstChunkMs, fullMs, totalStreamMs, fullBytes: fullPcm.length, streamedBytes }));
  assert.ok(firstChunkMs !== null && firstChunkMs < fullMs, `first chunk (${firstChunkMs}ms) arrives significantly earlier than full-sentence synthesis (${fullMs}ms)`);
  assert.ok(streamedBytes > 4800 && streamedBytes % 2 === 0, 'streamed PCM16 24kHz bytes are non-empty and sample-aligned');
});

test('ARGON Job 2: Tavily/web search stripped, medicine refusal preserved, honest no-online-lookup note, and wording-only scam note', async () => {
  const web = require('../web');
  const scam = require('../scam');

  // Daily-life news/fact question: zero network calls, empty sources, honest "haven't checked online" note
  const res = await web.lookup('What is the latest news about the election today?');
  assert.ok(res);
  assert.equal(res.decision, 'search');
  assert.deepEqual(web.sources(res), []);
  assert.deepEqual(web.boundSources(res, 'any reply'), []);
  const note = web.note(res);
  assert.match(note, /ONLINE CHECK NOT AVAILABLE.*you haven't checked online.*Never invent a web fact or current news detail, and never claim web verification/);

  // Medicine refusal still triggers first before anything else
  const med = await web.lookup('Is it safe to take ibuprofen with warfarin?');
  assert.ok(med);
  assert.equal(med.decision, 'refuse');

  // Scam detection stays wording-only: says "possible scam", never claims web verification or catching every scam
  const warnNote = scam.talkNote({
    level: 'warn',
    type: 'prize scam',
    reading: 'A caller claiming a lottery prize for a fee.',
    signals: { money: true, urgency: true },
    reads: {},
  });
  assert.match(warnNote, /looks like a possible scam/);
  assert.match(warnNote, /Never claim web verification of a company or prize, and never claim you catch every scam/);
});

test('Web call primary device/browser voice (deviceVoice: true): skips server MMS wait so text and voice start together (latency = Spark + device voice start), while App/WhatsApp stay on MMS', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Call } = require('../call');
  const { fixedReply } = require('../reply');

  const events = [];
  const binaryFrames = [];
  const ws = {
    readyState: 1,
    send(d) {
      if (Buffer.isBuffer(d) || d instanceof Uint8Array) binaryFrames.push(d);
      else events.push(JSON.parse(d));
    },
    close() {},
  };
  const call = new Call(ws, 'test-key');
  clearInterval(call.endTimer);
  call.abort = new AbortController();
  call.profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: { people: [], events: [], preferences: [], current: [], topics: [], threads: [] } };
  call.callId = 'web-device-test';
  call.deviceVoice = true;

  const sparkSimulatedMs = 25;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, sparkSimulatedMs));
  const timing = { endedAt: t0, decidedAt: Date.now() };
  let deviceVoiceStartMs = null;
  const origSend = ws.send;
  ws.send = (d) => {
    origSend(d);
    if (typeof d === 'string') {
      const ev = JSON.parse(d);
      if (ev.type === 'speak' && ev.deviceVoice && deviceVoiceStartMs === null) {
        // Browser speechSynthesis.speak(u) is invoked synchronously inside case 'speak' in public/app.js
        deviceVoiceStartMs = Date.now() - t0;
      }
    }
  };
  await call.speakReply(
    fixedReply('[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Hello Mathew, how are you doing today? It is great to hear from you.'),
    timing,
    call.gen,
    { record: false },
  );
  call.cancelSilence();
  console.log('WEB_DEVICE_VOICE_LATENCY', JSON.stringify({
    sparkSimulatedMs,
    ttsChunkMs: timing.ttsChunkMs,
    ttsFirstMs: timing.ttsFirstMs,
    speechEndToFirstAudioMs: timing.speechEndToFirstAudioMs,
    deviceVoiceStartMs,
  }));
  assert.equal(binaryFrames.length, 0, 'web call with deviceVoice: true sends zero server MMS PCM frames');
  assert.equal(timing.deviceVoice, true);
  assert.equal(timing.ttsChunkMs, 0, 'zero server MMS synthesis wait on web deviceVoice path');
  assert.ok(timing.ttsFirstMs <= 5, `server text-to-voice handoff is immediate (${timing.ttsFirstMs}ms)`);
  const speakEv = events.find((e) => e.type === 'speak');
  const capEv = events.find((e) => e.type === 'caption');
  assert.ok(speakEv && speakEv.deviceVoice === true && speakEv.piece === 'Hello Mathew, how are you doing today?');
  assert.ok(capEv && capEv.deviceVoice === true && capEv.piece === 'It is great to hear from you.');

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appSrc, /Maya \(device browser voice\):/, 'web primary device voice is honestly labelled in public/app.js');
  assert.match(appSrc, /Maya \(Meta MMS server voice fallback\):/, 'MMS fallback when device voice is unavailable is clearly labelled in public/app.js');
});

test('End-to-end call latency stages: First Call vs Second Call (no 7-8s beep delay from Call 1 flushPending) and Greeting vs Normal Reply, plus deviceVoice post-voiceReady fallback correction', async () => {
  const transcribe = require('../transcribe');
  const memory = require('../memory');
  const care = require('../care');
  const { Call } = require('../call');

  const origOpenTranscribe = transcribe.openTranscribe;
  const suffix = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const uniqueName = `LatencySenior${suffix}`;
  const profile = memory.createProfile(uniqueName, 'male');

  try {
    // --- CALL 1: Greeting + 1 user turn, then hang up (which triggers memory.endCall -> flushPending) ---
    const call1Events = [];
    const ws1 = {
      readyState: 1,
      send(d) { if (typeof d === 'string') call1Events.push({ at: Date.now(), ev: JSON.parse(d) }); },
      close() {},
    };
    const call1 = new Call(ws1, 'test-key');
    clearInterval(call1.endTimer);
    const call1StartAt = Date.now();
    // Simulate Call 1 start + greeting + 1 user turn recorded in pending file
    memory.startCall(profile.id, call1.callId, 'America/New_York');
    memory.appendTurn(profile.id, call1.callId, { label: 'A', who: uniqueName, text: 'I had cinnamon tea today.', userSaid: true });
    call1.profile = memory.load(profile.id);
    call1.callStarted = true;
    call1.deviceVoice = true;
    call1.startAt = call1StartAt;
    call1.callStages = { startReceivedAt: call1StartAt, flushPendingWaitMs: 0, flushPendingTotalMs: 0, transcribeReadyMs: 12, greetStartMs: 1, greetSparkFirstMs: 30, greetSparkDoneMs: 35, greetTries: 1, greetSpeakSentMs: 36 };
    call1.end();

    // Simulate an in-flight 700ms (representing 7s live) memory extraction from Call 1 on memory.flushPending
    const origFlush = memory.flushPending;
    let slowFlushResolved = false;
    memory.flushPending = () => new Promise((resolve) => {
      setTimeout(() => { slowFlushResolved = true; resolve(); }, 700);
    });

    // --- CALL 2: Starts while Call 1's memory.flushPending is still in flight ---
    const call2Events = [];
    let readyBeepAt = null;
    const ws2 = {
      readyState: 1,
      send(d) {
        if (typeof d === 'string') {
          const ev = JSON.parse(d);
          const at = Date.now();
          call2Events.push({ at, ev });
          if (ev.type === 'ready' && readyBeepAt === null) readyBeepAt = at;
        }
      },
      close() {},
    };
    const call2 = new Call(ws2, 'test-key');
    clearInterval(call2.endTimer);
    // Stub greet on Call 2 to simulate a 40ms Spark greeting while openMeta runs
    call2.openMeta = function (m) {
      const hour = Number(m.localHour);
      const startGreetWhenReady = new Promise((r) => { this._onTranscribeReady = r; });
      this.callStages.greetStartMs = Date.now() - this.startAt;
      setTimeout(() => {
        this.callStages.transcribeReadyMs = Date.now() - this.startAt;
        this.send({ type: 'ready', resume: this.token, stages: { flushPendingWaitMs: this.callStages.flushPendingWaitMs, transcribeReadyMs: this.callStages.transcribeReadyMs } });
        if (this._onTranscribeReady) { const r = this._onTranscribeReady; this._onTranscribeReady = null; r(); }
      }, 15);
      (async () => {
        await new Promise((r) => setTimeout(r, 40));
        await startGreetWhenReady;
        this.callStages.greetSparkFirstMs = 35;
        this.callStages.greetSparkDoneMs = 40;
        this.callStages.greetTries = 1;
        this.callStages.greetSpeakSentMs = Date.now() - this.startAt;
        this.send({ type: 'speak', text: 'Hello again! How is your afternoon going?', piece: 'Hello again!', deviceVoice: true, hold: 0 });
      })();
    };

    const call2StartAt = Date.now();
    call2.onBrowser(JSON.stringify({ type: 'start', sampleRate: 16000, localHour: 14, tz: 'America/New_York', profileId: profile.id, deviceVoice: true }), false);
    await new Promise((r) => setTimeout(r, 140));
    const call2BeepMs = readyBeepAt - call2StartAt;
    console.log('CALL1_VS_CALL2_STAGES', JSON.stringify({
      call1Stages: call1.callStages,
      call2Stages: call2.callStages,
      call2BeepMs,
      slowFlushResolvedWhenCall2Spoke: slowFlushResolved,
    }));
    assert.ok(call2.callStages.flushPendingWaitMs <= 65, `Call 2 flushPendingWaitMs (${call2.callStages.flushPendingWaitMs}ms) is bounded to ~50ms instead of waiting 700ms+ for Call 1 extraction`);
    assert.ok(call2BeepMs < 100, `Call 2 ready/chime beep (${call2BeepMs}ms) fires immediately without waiting for Call 1 flushPending`);
    assert.equal(slowFlushResolved, false, 'Call 2 connected, beeped, and spoke before Call 1 slow flushPending finished');

    // Verify post-voiceReady deviceVoice correction: if voiceReady resolves with no female voice (on: false), server flips deviceVoice to false and falls back to MMS
    assert.equal(call2.deviceVoice, true);
    call2.onBrowser(JSON.stringify({ type: 'deviceVoice', on: false }), false);
    assert.equal(call2.deviceVoice, false, 'server switches deviceVoice to false when voiceReady correction reports no female device voice');

    await new Promise((r) => setTimeout(r, 600));
    memory.flushPending = origFlush;
    call2.end();
  } finally {
    transcribe.openTranscribe = origOpenTranscribe;
    care.stop();
  }
});

test('Production-path greeting event order: openMeta + greet emits ready -> thinking while Spark greeting is still in flight, then speak -> audioEnd when Spark finishes', async () => {
  const memory = require('../memory');
  const care = require('../care');
  const suffix = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const profile = memory.createProfile(`GreetOrder${suffix}`, 'female');

  // Patch transcribe.openTranscribe and brain.sparkStream BEFORE re-requiring call.js so Call.prototype.openMeta and dynamicLine use the production code path
  const transcribePath = require.resolve('../transcribe');
  const transcribeMod = require('../transcribe');
  const origOpenTranscribe = transcribeMod.openTranscribe;
  const origSparkStream = brain.sparkStream;
  const callPath = require.resolve('../call');
  const savedCallCache = require.cache[callPath];

  let transcribeOpenedAt = null;
  let transcribeReadyFiredAt = null;
  let sparkStartedAt = null;
  let releaseSpark = null;
  const sparkGate = new Promise((r) => { releaseSpark = r; });

  transcribeMod.openTranscribe = (_key, handlers) => {
    transcribeOpenedAt = Date.now();
    setTimeout(() => {
      transcribeReadyFiredAt = Date.now();
      handlers.onReady('SESSION-PROD');
    }, 15);
    return {
      get ready() { return true; },
      sendPcm() {},
      close() {},
    };
  };
  brain.sparkStream = async (_history, _roster, _signal, onDelta) => {
    sparkStartedAt = Date.now();
    await sparkGate;
    const text = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Hello there, it is lovely to talk with you!';
    if (onDelta) onDelta(text);
    return text;
  };

  delete require.cache[callPath];
  const { Call } = require('../call');

  const sentEvents = [];
  const ws = {
    readyState: 1,
    send(d) {
      if (typeof d === 'string') sentEvents.push({ at: Date.now(), ev: JSON.parse(d) });
    },
    close() {},
  };
  const call = new Call(ws, 'test-key');
  clearInterval(call.endTimer);

  try {
    call.onBrowser(JSON.stringify({
      type: 'start',
      sampleRate: 16000,
      localHour: 10,
      tz: 'America/New_York',
      profileId: profile.id,
      deviceVoice: true,
    }), false);

    // Wait for openTranscribe.onReady (15ms) while Spark greeting is still blocked on sparkGate
    await new Promise((r) => setTimeout(r, 45));

    assert.ok(sparkStartedAt !== null && transcribeOpenedAt !== null, 'Spark greeting and Transcribe handshake both started in parallel');
    assert.ok(transcribeReadyFiredAt !== null, 'Transcribe onReady has fired');
    assert.deepEqual(
      sentEvents.map((x) => x.ev.type),
      ['ready', 'thinking'],
      'ready -> thinking emitted in order WHILE Spark greeting is still pending (so browser 30s watchdog starts immediately)',
    );

    // Now let Spark finish the greeting and verify speak -> audioEnd follow with no duplicate thinking event
    releaseSpark();
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(
      sentEvents.map((x) => x.ev.type),
      ['ready', 'thinking', 'speak', 'audioEnd'],
      'production greeting path emits exact ready -> thinking -> speak -> audioEnd ordering',
    );
  } finally {
    call.end();
    care.stop();
    transcribeMod.openTranscribe = origOpenTranscribe;
    brain.sparkStream = origSparkStream;
    if (savedCallCache) require.cache[callPath] = savedCallCache;
  }
});

test('Web call Bugs 1-4: echo suppression across playbackStart/playbackDone, no 1-turn-late stall after speechEnd or forcedOpen, serialized respond, and gate-safe sequential TTS in app.js', async () => {
  const { Call } = require('../call');
  const care = require('../care');
  const sent = [];
  const ws = {
    readyState: 1,
    send(d) { if (typeof d === 'string') sent.push(JSON.parse(d)); },
    close() {},
  };
  const c = new Call(ws, 'test-key');
  clearInterval(c.endTimer);
  c.deviceVoice = true;
  c.greeted = true;
  c.sayingText = 'Hello Henry, how have you been getting on today?';
  c.lastSaidAt = Date.now() - 8000;
  c.playUntil = Date.now() - 1000;

  // Bug 1: playbackStart keeps isSpeaking() true while browser speechSynthesis is still playing, and subsequence echo is caught
  c.onBrowserMessage({ type: 'playbackStart' });
  assert.equal(c.isSpeaking(), true, 'isSpeaking stays true while browser speechSynthesis is playing');
  assert.equal(c.isEcho('how have you getting today'), true, 'subsequence speaker bleed during deviceVoice is caught as echo');
  c.onBrowserMessage({ type: 'playbackDone' });
  assert.equal(c.browserPlaying, false);

  // Bug 1: echo turn dropped in speechComplete cancels recoverTimer so recoverFromInterrupt never fires by itself
  c.recoverTimer = setTimeout(() => { throw new Error('recoverTimer should have been cancelled'); }, 50);
  c.turns.set(1, { partial: 'how have you getting today', spans: [] });
  c.onMeta({ type: 'speechComplete', turnId: 1, transcript: 'how have you getting today' });
  await new Promise((r) => setTimeout(r, 70));

  // Bug 2: forcedOpen short continuation ("No" / "Yes") and revised base punctuation are not dropped
  c.forcedOpen = { id: 2, base: 'I went to the park.' };
  c.onMeta({ type: 'transcript', transcript: 'I went to the park, no' });
  assert.ok(c.curTurn, 'short continuation after forcedOpen reopens curTurn');
  assert.equal(c.curTurn.partial, 'no');

  // Bug 4: public/app.js guards finishIfDone with !hasHeldAudio(c) and !queuedTts, and uses sequential ttsQueue with watchdog
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appSrc, /!hasHeldAudio\(c\) && !queuedTts/);
  assert.match(appSrc, /function pumpDeviceVoice\(c\)/);
  assert.match(appSrc, /type: 'playbackDone'/);

  c.end();
  care.stop();
});

test('Web browser speechSynthesis simulation (Suspects a-d): reaches speak() when speaking=true at pump start, drains queue in order with no infinite cancel loop, and requests MMS fallback when no device voice is picked', async () => {
  const vm = require('node:vm');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  function makeEnv({ voices, stuckSpeakingOnCancel = false }) {
    const els = {};
    const getEl = (id) => {
      if (!els[id]) els[id] = { id, dataset: { state: 'idle', muted: 'false' }, textContent: '', hidden: false, setAttribute() {}, addEventListener() {} };
      return els[id];
    };
    const wsSent = [];
    let lastWs = null;
    class FakeWebSocket {
      constructor() {
        this.readyState = 1;
        this.bufferedAmount = 0;
        lastWs = this;
        setImmediate(() => { if (this.onopen) this.onopen(); });
      }
      send(d) { if (typeof d === 'string') wsSent.push(JSON.parse(d)); }
      close() {}
    }
    FakeWebSocket.OPEN = 1;

    let cancelCount = 0;
    const spokenUtterances = [];
    const speechSynthesis = {
      speaking: stuckSpeakingOnCancel,
      pending: false,
      paused: false,
      getVoices: () => voices,
      addEventListener() {},
      cancel() {
        cancelCount += 1;
        if (!stuckSpeakingOnCancel) {
          this.speaking = false;
          this.pending = false;
        }
      },
      resume() { this.paused = false; },
      speak(u) {
        this.speaking = true;
        spokenUtterances.push(u);
      },
    };
    class FakeUtterance {
      constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
    }
    class FakeAudioContext {
      constructor() {
        this.sampleRate = 16000;
        this.currentTime = 0;
        this.state = 'running';
        this.destination = {};
        this.audioWorklet = { addModule: async () => {} };
      }
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData() {} }; }
      createMediaStreamSource() { return { connect() { return { connect() {} }; } }; }
      createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return { connect() {} }; } }; }
      createOscillator() { return { frequency: { value: 440 }, connect() {}, start() {}, stop() {} }; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    class FakeAudioWorkletNode {
      constructor() { this.port = { onmessage: null }; }
      connect() { return { connect() {} }; }
      disconnect() {}
    }
    const sandbox = {
      window: null,
      document: {
        body: { dataset: {} },
        getElementById: getEl,
      },
      navigator: {
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ enabled: true, stop() {} }] }) },
      },
      MediaRecorder: Object.assign(function () {}, { isTypeSupported: () => true }),
      AudioContext: FakeAudioContext,
      AudioWorkletNode: FakeAudioWorkletNode,
      WebSocket: FakeWebSocket,
      SpeechSynthesisUtterance: FakeUtterance,
      speechSynthesis,
      location: { protocol: 'https:', host: 'maya.test' },
      Intl,
      Date,
      Math,
      JSON,
      Promise,
      Set,
      Map,
      Float32Array,
      Uint8Array,
      Int16Array,
      Event: class {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      requestAnimationFrame: () => {},
      addEventListener() {},
      dispatchEvent() {},
      fetch: async () => ({ ok: true, json: async () => ({ mode: 'real' }) }),
      console: { log() {}, warn() {}, error() {} },
    };
    sandbox.window = sandbox;
    sandbox.window.mayaProfile = { id: '197abefc', name: 'Henry', setLive() {} };
    vm.runInNewContext(appSrc, sandbox);
    return { sandbox, els, wsSent, getWs: () => lastWs, speechSynthesis, spokenUtterances, getCancelCount: () => cancelCount };
  }

  // Case 1, 2, 3: speechSynthesis.speaking is stuck true at pump start (and stays true across cancel() and inside onend)
  const env1 = makeEnv({
    voices: [{ name: 'Samantha', lang: 'en-US' }],
    stuckSpeakingOnCancel: true,
  });
  await new Promise((r) => setTimeout(r, 15));
  env1.sandbox.mayaStartCall();
  await new Promise((r) => setTimeout(r, 25));
  const ws1 = env1.getWs();
  ws1.onmessage({ data: JSON.stringify({ type: 'ready', resume: 'tok1' }) });
  ws1.onmessage({ data: JSON.stringify({ type: 'speak', text: 'Hello Henry.', piece: 'Hello Henry.', deviceVoice: true, hold: 0 }) });
  ws1.onmessage({ data: JSON.stringify({ type: 'caption', text: 'Hello Henry. How are you feeling today?', piece: 'How are you feeling today?', deviceVoice: true }) });
  ws1.onmessage({ data: JSON.stringify({ type: 'audioEnd' }) });

  // Wait 160 ms (more than 3 x 45 ms ticks): must NOT loop cancel() forever, and first utterance MUST have reached speak()
  await new Promise((r) => setTimeout(r, 160));
  assert.ok(env1.spokenUtterances.length >= 1, '(1) first queued utterance reached speechSynthesis.speak() even when speaking was stuck true at pump start');
  assert.ok(env1.getCancelCount() <= 2, `(3) no infinite cancel loop (cancelCount=${env1.getCancelCount()})`);
  assert.equal(env1.spokenUtterances[0].text, 'Hello Henry.');

  // Trigger onend of utterance 1 while speechSynthesis.speaking is STILL true (Chrome/WebKit behavior inside onend)
  env1.speechSynthesis.speaking = true;
  env1.spokenUtterances[0].onend();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(env1.spokenUtterances.length, 2, '(2) second queued utterance reached speak() after first completed');
  assert.equal(env1.spokenUtterances[1].text, 'How are you feeling today?', '(2) queue drains in exact order');
  env1.speechSynthesis.speaking = false;
  env1.spokenUtterances[1].onend();
  await new Promise((r) => setTimeout(r, 20));
  env1.sandbox.mayaEndCall();

  // Case 4: When no female English device voice is available (pickVoice() -> null), fallback to Meta MMS is requested for the greeting
  const env2 = makeEnv({
    voices: [{ name: 'Alex', lang: 'en-US' }], // male voice only -> pickVoice() returns null
    stuckSpeakingOnCancel: false,
  });
  await new Promise((r) => setTimeout(r, 15));
  env2.sandbox.mayaStartCall();
  await new Promise((r) => setTimeout(r, 25));
  const ws2 = env2.getWs();
  ws2.onmessage({ data: JSON.stringify({ type: 'ready', resume: 'tok2' }) });
  // Simulate server sending greeting with deviceVoice: true (e.g. if server started before deviceVoice:false arrived)
  ws2.onmessage({ data: JSON.stringify({ type: 'speak', text: 'Hello Henry!', piece: 'Hello Henry!', deviceVoice: true, hold: 0 }) });
  await new Promise((r) => setTimeout(r, 30));
  const fallbackMsgs = env2.wsSent.filter((m) => m.type === 'deviceVoice' && m.on === false && m.respeak === 'Hello Henry!');
  assert.equal(fallbackMsgs.length, 1, '(4) fallback to Meta MMS server voice with respeak is requested when no female device voice is picked');
  env2.sandbox.mayaEndCall();
});




