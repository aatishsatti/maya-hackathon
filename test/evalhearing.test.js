// The hearing suite: the fixed sentences, and the suite itself with a stand-in `say` and stand-in Transcribe (no audio device, no network).
// The stand-in "audio" is a WAV-shaped file that carries its own text, so concurrent jobs can never hear each other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MAYA_META_LEDGER = '1';
const meta = require('../meta');
const H = require('../eval/suites/hearing');
const inputs = require('../eval/inputs/hearing.json');
const S = require('../eval/score');
const rules = require('../eval/rules');

const fakeWav = (text) => Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.alloc(32), Buffer.from(text)]);   // 44 bytes of "header", then the words
const spokenText = (wav) => wav.subarray(44).toString();
const voicesUsed = [];
const mkDeps = (hear) => ({ have: true, say: async (text, voice, file) => { voicesUsed.push(voice); fs.writeFileSync(file, fakeWav(text)); }, transcribe: async (wav) => hear(spokenText(wav)) });
// What a perfect listener writes: the sentence, with amounts and dates in the written forms Transcribe typically uses.
const written = (t) => t.replace('two hundred pounds', '£200').replace('four seven two one', '4721').replace('three hundred and fifty dollars', '$350').replace('third of May nineteen forty eight', '3rd of May 1948');

test('the sentences: enough of them, unique, every one has key terms, scam words are covered, and only the number sentences are scored on terms alone', () => {
  const s = inputs.sentences;
  assert.ok(s.length >= 20); assert.equal(new Set(s.map((x) => x.text)).size, s.length);
  for (const x of s) { assert.ok(x.text.length > 20 && x.terms.length >= 1 && x.terms.every((t) => t.length >= 1), x.text); if (x.wer) assert.doesNotMatch(x.text, /\d/, 'sentences scored on every word have no digits whose written form could vary'); }
  const all = s.map((x) => x.text).join(' ').toLowerCase();
  for (const w of ['gift cards', 'medicare number', 'date of birth', 'code', 'bank', 'arrested', 'install', 'priya', 'ravi', 'chicago']) assert.ok(all.includes(w), w);
  assert.ok(s.filter((x) => x.scam).length >= 8); assert.ok(s.filter((x) => !x.wer).length >= 3 && s.filter((x) => !x.wer).length <= 5);
  assert.match(inputs.about, /SYNTHETIC, CLEAN speech/); assert.deepEqual(H.VOICES, ['Samantha', 'Daniel', 'Karen', 'Moira']);
});

test('perfect hearing: word error 0, every key term found (including amounts in their written form), four voices used, and the ledger counts the calls', async () => {
  meta.reset(); voicesUsed.length = 0;
  const r = await H.run({ runs: 1, deps: mkDeps((t) => written(t)) });
  assert.equal(r.metrics.failed, 0); assert.equal(r.metrics.sentences, inputs.sentences.length);
  assert.equal(r.metrics.wer, 0); assert.equal(r.metrics.exact, 1); assert.equal(r.metrics.termSurvival, 1); assert.equal(r.metrics.scamTermSurvival, 1);
  assert.deepEqual([...new Set(voicesUsed)].sort(), H.VOICES.slice().sort(), 'all four voices were used');
  assert.equal(meta.summary().filter((x) => x.purpose === 'transcribe-voice-note').length, 0, 'the stand-in does not touch the real ledger hooks, so nothing is counted');
  assert.ok(r.details.results.every((x) => x.heard && x.voice));
});

test('imperfect hearing is measured, not hidden: a wrong word raises the error rate and a lost key term is named', async () => {
  const r = await H.run({ runs: 1, deps: mkDeps((t) => written(t).replace('gift cards', 'kitchen cards').replace('Medicare', 'medical care')) });
  assert.ok(r.metrics.wer > 0 && r.metrics.exact < 1 && r.metrics.termSurvival < 1 && r.metrics.scamTermSurvival < 1);
  const missed = r.details.results.flatMap((x) => x.missed || []);
  assert.ok(missed.includes('gift cards') && missed.includes('medicare'), JSON.stringify(missed));
});

test('failures are counted honestly (one retry, then a failed sentence, never a made-up transcript) and a missing `say` skips the suite', async () => {
  const seen = new Set();
  const flaky = mkDeps((t) => t); const inner = flaky.transcribe;
  flaky.transcribe = async (wav) => { const t = spokenText(wav); if (!seen.has(t)) { seen.add(t); throw new Error('Meta Transcribe failed (HTTP 503)'); } return inner(wav); };
  const r = await H.run({ runs: 1, limit: 4, deps: flaky });
  assert.equal(r.metrics.failed, 0, 'the retry recovered each sentence'); assert.equal(r.metrics.sentences, 4);
  const dead = await H.run({ runs: 1, limit: 2, deps: { ...mkDeps((t) => t), transcribe: async () => { throw new Error('Meta Transcribe failed (HTTP 503)'); } } });
  assert.equal(dead.metrics.failed, 2); assert.equal(dead.metrics.wer, null); assert.equal(dead.metrics.termSurvival, null); assert.ok(dead.details.results.every((x) => x.error && !x.heard));
  const skipped = await H.run({ deps: { have: false } });
  assert.deepEqual(skipped.metrics, {}); assert.match(skipped.details.skipped, /not available/);
  const hearChecks = S.runChecks(skipped.metrics, rules.CHECKS).filter((c) => c.id.startsWith('hear.'));
  assert.ok(hearChecks.length >= 3 && hearChecks.every((c) => c.status === 'skipped'), 'a skipped suite is never a pass');
});

test('safe by construction: temporary audio is deleted, it is local `say` only, and nothing here can reach ElevenLabs', async () => {
  const count = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('maya-hearing-')).length;
  const before = count();
  await H.run({ runs: 1, limit: 2, deps: mkDeps((t) => t) });
  assert.equal(count(), before, 'the folder of audio files is removed');
  const src = fs.readFileSync(path.join(__dirname, '..', 'eval', 'suites', 'hearing.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /api\.elevenlabs|ELEVENLABS_|xi-api-key|streamSpeech/i); assert.match(src, /execFile\('say'/);
});

test.after(() => { meta.reset(); delete process.env.MAYA_META_LEDGER; });
