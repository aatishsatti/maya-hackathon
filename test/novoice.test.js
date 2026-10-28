// TEMPORARY no-voice test switch (render-test): a call with `noVoice: true` makes NO ElevenLabs request. The greeting and replies go out as text
// events; the mic path, Transcribe and Spark are unchanged. The ElevenLabs lead-in clips are rendered after the first VOICED greeting, never at boot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-novoice-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
let elevenCalls = 0;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, sparkComplete: async () => '{}', sparkStream: async () => '',
  streamSpeech: async (_text, _sig, onChunk) => { elevenCalls += 1; onChunk(Buffer.alloc(9600)); },   // ElevenLabs: counts every request
} };
const memory = require('../memory');
const care = require('../care');
const { Call, leadClips } = require('../call');
const { fixedReply } = require('../reply');

const calls = [];
let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
function mk(noVoice) {
  const sent = []; const ws = { send: (d) => sent.push(typeof d === 'string' ? JSON.parse(d) : { binary: d.length }), close() {}, onmessage: null, onclose: null };
  const c = new Call(ws, 'k'); c.profile = memory.load(memory.createProfile(`Ivy${letters(n++)}`, 'female').id); c.callId = 'x'; c.registered = true; c.noVoice = noVoice; c.gen = 1; c.abort = new AbortController(); calls.push(c);
  return { c, sent };
}
const TEXT = '[[feel: emotion=neutral intensity=1 intent=chat]] Good evening, glad to meet you. Got anything nice planned for today?';

test('no-voice call: the greeting arrives as text events (speak, caption, audioEnd with noVoice), with no audio and NO ElevenLabs request', async () => {
  const { c, sent } = mk(true); elevenCalls = 0;
  await c.speakReply(fixedReply(TEXT), null, 1, { greeting: true, maxSentences: 2 });
  assert.equal(elevenCalls, 0, 'not one request to ElevenLabs');
  assert.ok(!sent.some((m) => m.binary), 'no audio was sent');
  const speak = sent.find((m) => m.type === 'speak'); assert.match(speak.text, /Good evening, glad to meet you/);
  assert.ok(sent.some((m) => m.type === 'caption' && /nice planned/.test(m.text)) || /nice planned/.test(speak.text), 'the whole greeting is delivered as text');
  const end = sent.find((m) => m.type === 'audioEnd'); assert.equal(end.noVoice, true);
  assert.ok(sent.indexOf(speak) < sent.indexOf(end));
  assert.equal(c.responding, false, 'the call is ready to listen again');
});

test('a voiced call is unchanged: ElevenLabs is asked for each piece and audio is sent (so the switch really is the only difference)', async () => {
  const { c, sent } = mk(false); elevenCalls = 0;
  await c.speakReply(fixedReply(TEXT), null, 1, { greeting: true, maxSentences: 2 });
  assert.ok(elevenCalls >= 1, 'voiced call asks ElevenLabs');
  assert.ok(sent.some((m) => m.binary > 0), 'audio is sent');
  assert.equal(sent.find((m) => m.type === 'audioEnd').noVoice, undefined);
});

test('no-voice call: no lead-in clip is ever played, even if clips exist; a normal call can still use one', () => {
  leadClips.set('Mm-hm, I\'m listening.', { text: 'Mm-hm, I\'m listening.', pcm: Buffer.alloc(80000) });
  const heard = [{ text: 'I had toast and tea for breakfast this morning.' }];
  const { c: quiet } = mk(true); assert.equal(quiet.pickLead(heard, '', null, true), null, 'no-voice: nothing');
  const { c: loud } = mk(false); assert.ok(loud.pickLead(heard, '', null, true), 'a voiced call still gets its lead-in');
  leadClips.clear();
});

test('no-voice call: the switch comes only from the start message, the latency line says so, and the only ElevenLabs call sites are the per-piece voice and the lead-in renderer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8');
  assert.match(src, /this\.noVoice = m\.noVoice === true;/);
  assert.match(src, /this\.fakeAudio = this\.noVoice && m\.fakeAudio === true;/, 'fakeAudio is only ever honoured together with noVoice');
  assert.match(src, /\.\.\.\(this\.noVoice \? \{ noVoice: true, \.\.\.\(this\.fakeAudio \? \{ fakeAudio: true \} : \{\}\) \} : \{\}\),\n      guess:/, 'the latency line carries noVoice / fakeAudio');
  assert.equal((src.match(/streamSpeech\(/g) || []).length, 2, 'only two ElevenLabs call sites: the per-piece voice and the lead-in clip renderer');
  assert.match(src, /if \(this\.noVoice && !this\.fakeAudio\) job\.done = true;[^\n]*\n\s+else \(this\.noVoice \? fakeSpeech\(tagged, signal, onVoiceChunk\) : streamSpeech\(tagged, signal, onVoiceChunk,/);
  const fake = src.slice(src.indexOf('async function fakeSpeech'), src.indexOf('// Renders any missing clips'));
  assert.ok(!/streamSpeech|fetch\(|elevenlabs|https?:/i.test(fake.replace(/\/\/.*$/gm, '')), 'the synthetic voice makes no network request and never touches ElevenLabs');
});

test('fake audio: synthetic PCM goes down the call through the SAME playback loop, faster than real time, and still NO ElevenLabs request', async () => {
  const { c, sent } = mk(true); c.fakeAudio = true; elevenCalls = 0;
  const timing = { endedAt: Date.now(), decidedAt: Date.now() };
  const t0 = Date.now();
  await c.speakReply(fixedReply(TEXT), timing, 1, { greeting: true, maxSentences: 2 });
  const wall = Date.now() - t0;
  assert.equal(elevenCalls, 0, 'not one request to ElevenLabs');
  const audio = sent.filter((m) => m.binary); const bytes = audio.reduce((x, m) => x + m.binary, 0); const audioMs = bytes / 48;
  assert.ok(audio.length >= 3 && bytes > 40000, `audio frames were sent: ${audio.length} frames, ${Math.round(audioMs)} ms of audio`);
  assert.ok(audioMs > 1200 && audioMs < 6000, `about the length the words would take: ${Math.round(audioMs)} ms`);
  assert.ok(wall < audioMs, `delivered faster than real time: ${wall} ms of work for ${Math.round(audioMs)} ms of audio`);
  assert.ok(timing.ttsChunkMs >= 100 && timing.ttsChunkMs < 800, `first chunk after about 150 ms like ElevenLabs: ${timing.ttsChunkMs}`);
  assert.ok(timing.ttsFirstMs >= timing.ttsChunkMs, 'the playback loop held the first piece back as it does for a real voice');
  const end = sent.find((m) => m.type === 'audioEnd'); assert.equal(end.noVoice, true); assert.equal(end.timing.fakeAudio, undefined);
  assert.ok(sent.lastIndexOf(audio[audio.length - 1]) < sent.indexOf(end), 'all audio is sent before audioEnd');
  assert.ok(c.playUntil > Date.now(), 'the call knows Maya is still "speaking" while the audio plays, as with a real voice');
});

test('fakeSpeech: even-length PCM16 chunks, speech-like with silence before and after, stops when aborted, deterministic', async () => {
  const { fakeSpeech } = require('../call');
  const got = []; await fakeSpeech('Hello there my friend.', new AbortController().signal, (b) => got.push(b), { firstChunkMs: 1, everyMs: 1 });
  assert.ok(got.length >= 4 && got.every((b) => b.length % 2 === 0 && b.length <= 4096));
  const all = Buffer.concat(got); const expectedMs = Math.max(600, 22 * 65) + 120 + 150; assert.equal(all.length, Math.round(expectedMs / 1000 * 24000) * 2);
  const peak = (b) => { let m = 0; for (let i = 0; i < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i))); return m; };
  assert.equal(peak(all.subarray(0, 2000)), 0, 'silence first'); assert.ok(peak(all.subarray(all.length / 2 - 2000, all.length / 2 + 2000)) > 2000, 'speech-like in the middle'); assert.equal(peak(all.subarray(all.length - 2000)), 0, 'silence last');
  const again = []; await fakeSpeech('Hello there my friend.', new AbortController().signal, (b) => again.push(b), { firstChunkMs: 1, everyMs: 1 });
  assert.ok(Buffer.concat(again).equals(all), 'deterministic');
  const ac = new AbortController(); let n = 0;
  await assert.rejects(fakeSpeech('A longer sentence that would take a while to say out loud.', ac.signal, () => { n += 1; if (n === 2) ac.abort(new Error('barge-in')); }, { firstChunkMs: 1, everyMs: 1 }), /barge-in/);
  assert.ok(n < 20, 'it stopped when aborted');
});

test('the lead-in clips are no longer rendered at server start: a deploy or a wake alone makes no ElevenLabs request; only a voiced greeting warms them', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/\.warmLeads\(\)/.test(server.replace(/\/\/.*$/gm, '')), 'server.js does not call warmLeads');
  const call = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8');
  assert.match(call, /if \(!this\.noVoice\) warmLeads\(\);/);
  assert.equal((call.match(/\bwarmLeads\(\)/g) || []).length >= 2, true);
});

test.after(() => { calls.forEach((c) => c.end()); care.stop(); });
