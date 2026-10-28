// The temporary hosting diagnostic (diag.js): reports settings, key LENGTH, Meta's model list and one tiny test per model, and never a secret.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const diag = require('../diag');

const KEY = 'metakey_ABCDEF1234567890_SECRETVALUE';
const EL = 'elkey_9876543210_SECRETVALUE';
const VOICE = 'voiceid_ZYXWVUTSRQ';
const env = { META_API_KEY: KEY, ELEVENLABS_API_KEY: EL, ELEVENLABS_VOICE_ID: VOICE, META_MODE: 'real', MAYA_BRAIN_MODEL: 'muse-spark-1.2', PORT: '10000' };

function fakeFetch(map) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers && opts.headers.Authorization });
    const h = map(url, opts.body ? JSON.parse(opts.body) : null);
    return { status: h.status, ok: h.status < 300, text: async () => (typeof h.body === 'string' ? h.body : JSON.stringify(h.body)), json: async () => (typeof h.body === 'string' ? JSON.parse(h.body) : h.body) };
  };
  f.calls = calls;
  return f;
}

test('diag: shows the settings, key length only, the model list and one test per model; nothing secret anywhere in the output', async () => {
  const f = fakeFetch((url, body) => {
    if (url.includes('ipinfo')) return { status: 200, body: { ip: '203.0.113.9', country: 'US', region: 'Oregon', city: 'Portland', org: 'AS16509 Amazon' } };
    if (url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'muse-spark-1.3' }, { id: 'muse-spark-1.2' }, { id: 'muse-voice-transcribe-1.0' }] } };
    if (body && body.model === 'muse-spark-1.3') return { status: 404, body: { error: { code: 'model_not_found', message: `The requested model was not found. (key ${KEY})` } } };
    return { status: 200, body: { choices: [{ message: { content: 'Hi' } }] } };
  });
  diag.deps.fetch = f;
  const out = await diag.run(env);
  const all = JSON.stringify(out);
  for (const secret of [KEY, EL, VOICE]) assert.ok(!all.includes(secret), 'a secret leaked into the diagnostic');
  const fp = require('node:crypto').createHash('sha256').update(KEY).digest('hex').slice(0, 6);
  assert.equal(out.metaKey.fingerprint, fp); assert.match(out.metaKey.fingerprint, /^[0-9a-f]{6}$/);
  assert.ok(!KEY.includes(out.metaKey.fingerprint) || fp.length === 6, 'only six hex characters of a hash, never part of the key');
  assert.equal((await diag.run({ ...env, META_API_KEY: KEY + 'x' })).metaKey.fingerprint === fp, false, 'a different key gives a different fingerprint');
  assert.equal((await diag.run({ META_MODE: 'real' })).metaKey.fingerprint, null);
  assert.equal(out.metaKey.length, KEY.length); assert.equal(out.metaKey.present, true); assert.equal(out.metaKey.hasWhitespace, false); assert.equal(out.metaKey.onlyKeySafeChars, true);
  assert.equal(out.settings.commit, null, 'no commit shown when the host does not provide one');
  assert.equal((await diag.run({ ...env, RENDER_GIT_COMMIT: 'abcdef1234567890' })).settings.commit, 'abcdef1', 'the deployed commit, 7 characters');
  assert.equal(out.settings.MAYA_BRAIN_MODEL, 'muse-spark-1.2'); assert.equal(out.settings.modelInUse, 'muse-spark-1.2');
  assert.equal(out.egress.country, 'US'); assert.deepEqual(out.metaModels.ids, ['muse-spark-1.3', 'muse-spark-1.2', 'muse-voice-transcribe-1.0']);
  const byModel = Object.fromEntries(out.oneTokenTests.map((t) => [t.model, t]));
  assert.equal(byModel['muse-spark-1.3'].status, 404); assert.equal(byModel['muse-spark-1.3'].errorCode, 'model_not_found'); assert.match(byModel['muse-spark-1.3'].body, /\[secret\]/, 'an echoed key is blanked');
  assert.equal(byModel['muse-spark-1.2'].ok, true); assert.ok(byModel['muse-spark-1.1']);
  assert.ok(!('muse-voice-transcribe-1.0' in byModel), 'only chat (spark) models are tested');
  assert.equal(new Set(out.oneTokenTests.map((t) => t.model)).size, out.oneTokenTests.length, 'one test per model, no repeats');
  for (const c of f.calls.filter((x) => x.body)) assert.ok(c.body.max_completion_tokens <= 16, 'tiny requests only');
  assert.ok(f.calls.some((c) => c.auth === `Bearer ${KEY}`), 'the key is sent to Meta, and only to Meta');
  assert.ok(f.calls.filter((c) => c.auth).every((c) => c.url.startsWith('https://api.meta.ai/')));
});

test('diag: a missing key, a bad key and a network failure are reported plainly (still no secret)', async () => {
  diag.deps.fetch = fakeFetch((url) => (url.includes('ipinfo') ? { status: 200, body: { country: 'IN' } } : { status: 401, body: { error: { code: 'invalid_api_key', message: 'bad key' } } }));
  const bad = await diag.run({ ...env, META_API_KEY: ' spaced "key" ' });
  assert.equal(bad.metaKey.hasWhitespace, true); assert.equal(bad.metaKey.hasQuotes, true); assert.equal(bad.metaKey.onlyKeySafeChars, false);
  assert.equal(bad.metaModels.status, 401); assert.ok(bad.oneTokenTests.every((t) => t.status === 401 && t.errorCode === 'invalid_api_key'));
  const none = await diag.run({ META_MODE: 'real' });
  assert.equal(none.metaKey.present, false); assert.equal(none.metaKey.length, 0); assert.equal(none.settings.modelInUse, 'muse-spark-1.3');
  diag.deps.fetch = async () => { throw new Error(`connect ECONNREFUSED while using ${KEY}`); };
  const down = await diag.run(env);
  assert.ok(!JSON.stringify(down).includes(KEY)); assert.ok(down.metaModels.error); assert.ok(down.oneTokenTests.every((t) => t.error));
});

test('diag: cached for 60 s (a public URL cannot be used to run up Meta calls); only GET, only in real mode', async () => {
  const f = fakeFetch((url) => (url.includes('ipinfo') ? { status: 200, body: {} } : url.endsWith('/models') ? { status: 200, body: { data: [] } } : { status: 200, body: {} }));
  diag.deps.fetch = f;
  const first = await diag.get(); const n = f.calls.length;
  const second = await diag.get();
  assert.equal(f.calls.length, n, 'the second call within a minute makes no upstream calls');
  assert.equal(second.cached, true); assert.equal(first.cached, undefined);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /url\.pathname === '\/api\/diag' && req\.method === 'GET'\) return MODE === 'real'/);
  assert.match(src, /TEMPORARY \(render-test branch\)/);
});

// ---------------- ASR streaming diagnostic (GET /api/diag?asr=1) ----------------
class FakeWS {
  constructor(script) { this.script = script; this.l = {}; this.sent = []; this.frames = 0; FakeWS.last = this; setImmediate(() => this.emit('open', {})); }
  addEventListener(e, f) { (this.l[e] = this.l[e] || []).push(f); }
  emit(e, ev) { for (const f of this.l[e] || []) f(ev); }
  send(d) {
    if (typeof d === 'string') { this.sent.push(d); if (!/endStream/.test(d)) setImmediate(() => this.emit('message', { data: JSON.stringify({ sessionId: 'fake-session' }) })); return; }
    this.frames += 1; this.sent.push(d.length);
    setImmediate(() => this.emit('message', { data: JSON.stringify({ type: 'audioProgress', audioProcessedMs: this.frames * 50 - this.script.behindMs }) }));
    if (this.script.dropAtFrame === this.frames) setImmediate(() => this.emit('close', { code: 1011, reason: this.script.reason }));
  }
  close() { if (!this.closedOnce) { this.closedOnce = true; this.emit('close', { code: 1000, reason: '' }); } }
}

test('asr diag: cgroup counters are read (v2 and v1) and summarised; no cgroup is reported as null, not an error', () => {
  const v2 = { '/sys/fs/cgroup/cpu.stat': 'usage_usec 5\nnr_periods 200\nnr_throttled 37\nthrottled_usec 410000\n', '/sys/fs/cgroup/cpu.max': '10000 100000\n' };
  const a = diag.readCgroup((f) => { if (!(f in v2)) throw new Error('nope'); return v2[f]; });
  assert.deepEqual(a, { version: 2, cpuLimit: 0.1, nrPeriods: 200, nrThrottled: 37, throttledMs: 410 });
  const v1 = { '/sys/fs/cgroup/cpu/cpu.stat': 'nr_periods 50\nnr_throttled 9\nthrottled_time 2500000000\n', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '10000\n', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n' };
  const b = diag.readCgroup((f) => { if (!(f in v1)) throw new Error('nope'); return v1[f]; });
  assert.deepEqual(b, { version: 1, cpuLimit: 0.1, nrPeriods: 50, nrThrottled: 9, throttledMs: 2500 });
  assert.equal(diag.readCgroup(() => { throw new Error('no cgroup'); }).version, null);
  assert.deepEqual(diag.summarize([10, 20, 30, 600, 700, 120]), { n: 6, p50: 120, p95: 700, max: 700, over100ms: 3, over500ms: 2 });
  assert.deepEqual(diag.summarize([]), { n: 0 });
});

test('asr diag: the audio is made in memory (24 kHz PCM16, 50 ms frames), speech-like with pauses, and is not a recording of anyone', () => {
  const a = diag.synthAudio(12000);
  assert.equal(a.length, 12 * 24000 * 2); assert.equal(a.length / diag.FRAME_BYTES, 240, '240 frames = 12 s');
  let loud = 0, quiet = 0; for (let f = 0; f < 240; f++) { let peak = 0; for (let i = 0; i < diag.FRAME_BYTES; i += 2) peak = Math.max(peak, Math.abs(a.readInt16LE(f * diag.FRAME_BYTES + i))); if (peak > 1500) loud++; else if (peak < 50) quiet++; }
  assert.ok(loud > 80 && quiet > 40, `speech-like bursts and pauses: ${loud} loud, ${quiet} quiet frames`);
  assert.ok(a.equals(diag.synthAudio(12000)), 'deterministic');
  const src = fs.readFileSync(path.join(__dirname, '..', 'diag.js'), 'utf8');
  assert.ok(!/elevenlabs|ELEVENLABS_API_KEY\]/.test(src.slice(src.indexOf('ASR streaming diagnostic'))), 'the ASR diagnostic never touches ElevenLabs');
});

test('asr diag: a clean real-time stream reports no drop, how far behind Meta says it is, sender lateness, event-loop lag and CPU use; the key is never in the output', async () => {
  diag.deps.WebSocket = () => new FakeWS({ behindMs: 300 });
  const r = await diag.asrRun('t', { ms: 1000, env, readCg: () => ({ cpuLimit: 0.1, nrPeriods: 10, nrThrottled: 2, throttledMs: 5, version: 2 }) });
  assert.equal(r.dropped, false); assert.ok(r.close === null || r.close.code === 1000, 'only a normal close at the end'); assert.equal(r.audioSentMs, 1000);
  assert.equal(r.metaBehindMs.n, 20); assert.equal(r.metaBehindMs.p50, 300);
  assert.equal(r.senderLateMs.n, 20); assert.ok(r.senderLateMs.max < 500);
  assert.ok(r.eventLoopDelayMs.max >= 0 && r.cpu.percentOfOneCore >= 0); assert.equal(r.cgroup.cpuLimit, 0.1);
  assert.ok(!JSON.stringify(r).includes(KEY));
  const hs = JSON.parse(FakeWS.last.sent[0]); assert.equal(hs.emitAudioProgress, true); assert.equal(hs.audioEncoding, 'PCM_24KHZ'); assert.equal(hs.model, 'muse-voice-transcribe-1.0'); assert.equal(hs.mode, 'DIARIZATION');
});

test('asr diag: a drop mid-stream is reported with Meta\'s code and message verbatim (key redacted), and the stream stops', async () => {
  diag.deps.WebSocket = () => new FakeWS({ behindMs: 0, dropAtFrame: 8, reason: `Ingress audio slower than real-time (key ${KEY})` });
  const r = await diag.asrRun('t', { ms: 2000, env, readCg: () => ({}) });
  assert.equal(r.dropped, true); assert.equal(r.close.code, 1011); assert.match(r.close.reason, /^Ingress audio slower than real-time/); assert.ok(!JSON.stringify(r).includes(KEY)); assert.match(r.close.reason, /\[secret\]/);
  assert.ok(r.audioSentMs < 2000, 'it stopped sending when Meta closed');
});

test('asr diag: the busy condition runs a real Spark request beside the stream and reports it; a Spark failure is reported, not hidden', async () => {
  diag.deps.WebSocket = () => new FakeWS({ behindMs: 100 });
  diag.deps.sparkStream = async (_h, _r, _s, onDelta) => { onDelta('Hi'); return 'Hi'; };
  const ok = await diag.asrRun('busy', { ms: 1000, withLoad: true, env, readCg: () => ({}) });
  assert.equal(ok.withLoad, true); assert.ok(ok.spark.firstTokenMs >= 0); assert.equal(ok.dropped, false);
  diag.deps.sparkStream = async () => { throw new Error(`Meta Spark failed (HTTP 404) key ${KEY}`); };
  const bad = await diag.asrRun('busy', { ms: 500, withLoad: true, env, readCg: () => ({}) });
  assert.match(bad.spark.error, /HTTP 404/); assert.ok(!JSON.stringify(bad).includes(KEY));
  diag.deps.sparkStream = (...a) => require('../brain').sparkStream(...a);
});

test('asr diag: it is expensive, so it is cached for 5 minutes, GET only, real mode only, and the plain diag still works without ?asr=1', async () => {
  let made = 0; diag.deps.WebSocket = () => { made += 1; return new FakeWS({ behindMs: 0 }); };
  diag.deps.sparkStream = async () => 'Hi';
  const first = await diag.getAsr({ ms: 500 }); const n = made;
  const second = await diag.getAsr({ ms: 500 });
  assert.equal(made, n, 'no new Meta session within 5 minutes'); assert.equal(second.cached, true); assert.equal(first.runs.length, 2);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /req\.method === 'GET'\) return MODE === 'real' \? sendJson\(res, 200, url\.searchParams\.get\('asr'\) === '1' \? await require\('\.\/diag'\)\.getAsr\(\) : await require\('\.\/diag'\)\.get\(\)\)/);
  diag.deps.sparkStream = (...a) => require('../brain').sparkStream(...a);
});
