// Hearing suite (Meta Transcribe): fixed sentences are spoken by the Mac's built-in `say` command (SYNTHETIC, CLEAN speech: local, free, NO ElevenLabs)
// and sent to Meta Transcribe (the voice-note endpoint of muse-voice-transcribe-1.0). It measures the word error rate and whether the key words
// survive (names, places, and the words a scam turns on: gift cards, Medicare number, date of birth, code...). It proves the ears work and the key terms
// come through. It does NOT measure real older voices, accents, hesitation or a noisy room, and the page says so.
// Skipped on a machine without `say`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const C = require('./common');
const score = require('../score');
const inputs = require('../inputs/hearing.json');

const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira'];   // US, UK, Australian, Irish: plain natural English voices that ship with macOS

const defaultDeps = () => ({
  have: process.platform === 'darwin',
  voices: VOICES,
  // Writes `text` spoken by `voice` to a 24 kHz 16-bit mono WAV file (the same format a recorded voice note has).
  say: (text, voice, file) => new Promise((resolve, reject) => execFile('say', ['-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@24000', text], (e) => (e ? reject(e) : resolve()))),
  transcribe: (wav) => require(path.join(C.ROOT, 'transcribe')).transcribeWav(process.env.META_API_KEY, wav),
});

async function run({ runs = 2, limit = null, deps = null } = {}) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (!d.have) return { metrics: {}, details: { skipped: 'the local `say` voice is not available on this machine' } };
  const meta = require(path.join(C.ROOT, 'meta'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-hearing-'));
  const sentences = limit ? inputs.sentences.slice(0, limit) : inputs.sentences;
  const jobs = [];
  for (let r = 0; r < (limit ? 1 : runs); r++) sentences.forEach((s, i) => jobs.push({ s, i, voice: d.voices[(i + r) % d.voices.length] }));
  const before = meta.snapshot().length;
  let results;
  try {
    results = await C.pool(4, jobs, async (job, k) => {
      const file = path.join(dir, `s${k}.wav`);
      try {
        await d.say(job.s.text, job.voice, file);
        let heard = null, error = null;
        for (let attempt = 0; attempt < 2 && heard === null; attempt++) { try { heard = await d.transcribe(fs.readFileSync(file)); } catch (e) { error = e.message; } }
        if (heard === null) return { ...job, error: error || 'no result' };
        const t = score.termsFound(heard, job.s.terms);
        return { ...job, heard, wer: job.s.wer ? score.wer(job.s.text, heard) : null, found: t.found, total: t.total, missed: t.missed };
      } catch (e) { return { ...job, error: e.message }; }
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const ok = results.filter((x) => !x.error), werRows = ok.filter((x) => x.wer !== null), scamRows = ok.filter((x) => x.s.scam);
  const sum = (rows, k) => rows.reduce((a, x) => a + x[k], 0);
  const rows = meta.snapshot().slice(before).filter((x) => x.purpose === 'transcribe-voice-note' && x.ok);
  const metrics = {
    sentences: results.length, failed: results.length - ok.length,
    wer: werRows.length ? score.mean(werRows.map((x) => x.wer)) : null,
    exact: werRows.length ? werRows.filter((x) => x.wer === 0).length / werRows.length : null,
    termSurvival: sum(ok, 'total') ? sum(ok, 'found') / sum(ok, 'total') : null,
    scamTermSurvival: sum(scamRows, 'total') ? sum(scamRows, 'found') / sum(scamRows, 'total') : null,
    avgMs: rows.length ? Math.round(score.mean(rows.map((x) => x.ms || 0))) : null,
    audioSeconds: Math.round(sum(rows.map((x) => ({ a: (x.audioMs || 0) / 1000 })), 'a')),
  };
  return { metrics, details: { results: results.map((x) => ({ text: x.s.text, voice: x.voice, heard: x.heard, wer: x.wer, missed: x.missed, error: x.error })) } };
}
module.exports = { name: 'hearing', run, VOICES };
