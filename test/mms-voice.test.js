// Meta MMS TTS (facebook/mms-tts-eng) voice tests: PCM16 24 kHz mono format, warm synthesis without reload per sentence,
// speech-presentation markup stripping after safety/feel processing, and interruption stopping playback.
const test = require('node:test');
const assert = require('node:assert/strict');
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

