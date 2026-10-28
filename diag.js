// TEMPORARY hosting diagnostic (render-test branch only, to be removed before the final version). GET /api/diag answers, without ever
// showing a secret: what model Maya is set to use, how long the Meta key is (length only), what Meta's model list says from THIS
// server, a one-token test per model, and where this server's requests come from (country). It tells apart: a key without chat access,
// a region problem, and a setting that never reached the app. Cached for 60 s so the public URL cannot be used to run up calls.
const META = 'https://api.meta.ai/v1';
const FIXED_MODELS = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'];
const CACHE_MS = 60000;
let cached = null;

const deps = { fetch: (...a) => fetch(...a), WebSocket: (...a) => new WebSocket(...a), sparkStream: (...a) => require('./brain').sparkStream(...a) };

function redact(text, secrets) {
  let t = String(text == null ? '' : text);
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join('[secret]');
  return t.replace(/\s+/g, ' ').slice(0, 220);
}

async function run(env = process.env) {
  const key = env.META_API_KEY || '';
  const secrets = [key, env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID];
  const out = {
    at: new Date().toISOString(),
    node: process.version,
    settings: {
      META_MODE: env.META_MODE || null,
      MAYA_BRAIN_MODEL: env.MAYA_BRAIN_MODEL || null,        // a model name, not a secret: shows whether the setting reached the app
      MAYA_MEMORY_MODEL: env.MAYA_MEMORY_MODEL || null,
      modelInUse: env.MAYA_BRAIN_MODEL || 'muse-spark-1.3',
      PORT: env.PORT || null,
      commit: (env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,   // which commit Render is running (so a test can refuse to run on old code)
    },
    // fingerprint: first 6 hex of the key's SHA-256 (24 bits of a 48-character random key: it cannot be used to get the key back). Compare
    // it with the same number computed on the Mac to see whether Render holds the SAME key.
    metaKey: { present: Boolean(key), length: key.length, fingerprint: key ? require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 6) : null, hasWhitespace: /\s/.test(key), hasQuotes: /["']/.test(key), onlyKeySafeChars: /^[A-Za-z0-9._\-]+$/.test(key) },
    elevenLabs: { keyPresent: Boolean(env.ELEVENLABS_API_KEY), voiceIdPresent: Boolean(env.ELEVENLABS_VOICE_ID) },
    egress: null, metaModels: null, oneTokenTests: [],
  };
  const auth = { Authorization: `Bearer ${key}` };
  try {   // where this server's requests come from
    const r = await deps.fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    out.egress = { ip: j.ip, country: j.country, region: j.region, city: j.city, org: j.org };
  } catch (e) { out.egress = { error: redact(e.message, secrets) }; }
  let listed = [];
  try {   // what Meta says this key can see, from here
    const r = await deps.fetch(`${META}/models`, { headers: auth, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let ids = null;
    try { const j = JSON.parse(text); ids = (j.data || j.models || []).map((m) => m.id || m.name); } catch { /* not JSON */ }
    listed = ids || [];
    out.metaModels = { status: r.status, ids: ids, body: ids ? undefined : redact(text, secrets) };
  } catch (e) { out.metaModels = { error: redact(e.message, secrets) }; }
  const models = [...new Set([out.settings.modelInUse, ...FIXED_MODELS, ...listed.filter((m) => /spark/i.test(m))])];
  for (const model of models) {   // one tiny completion per model, same endpoint and shape Maya uses
    const t0 = Date.now();
    try {
      const r = await deps.fetch(`${META}/chat/completions`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hi.' }], max_completion_tokens: 16, reasoning_effort: 'minimal' }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await r.text();
      let code = null; try { const j = JSON.parse(text); code = (j.error && (j.error.code || j.error.type)) || null; } catch { /* not JSON */ }
      out.oneTokenTests.push({ model, status: r.status, ok: r.ok, errorCode: code, ms: Date.now() - t0, body: r.ok ? undefined : redact(text, secrets) });
    } catch (e) { out.oneTokenTests.push({ model, error: redact(e.message, secrets), ms: Date.now() - t0 }); }
  }
  return out;
}

async function get() {
  if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.value, cached: true };
  const value = await run();
  cached = { at: Date.now(), value };
  return value;
}


// ================= ASR streaming diagnostic: GET /api/diag?asr=1 (TEMPORARY, render-test only) =================
// The server opens a Meta Transcribe session ITSELF (same endpoint and session settings as a call, plus audioProgress so Meta reports how far
// behind it is) and streams ~12 s of synthetic speech-like audio from memory in real time: no browser, no call, no ElevenLabs. Run twice:
// idle, and while the server is busy (a real Spark call plus short bursts of synchronous work, like a call's start-up). It reports drops
// (Meta's close code and message, verbatim), how late each frame was sent, how far behind Meta says it is, the event loop's lag, and the
// container's own CPU-throttle counters (cgroup cpu.stat), which show directly whether a CPU cap is freezing the process.
const { monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const ASR_URL = 'wss://api.meta.ai/v1/asr/realtime';
const FRAME_MS = 50, FRAME_BYTES = 2400;           // 24 kHz PCM16 mono: 1200 samples = 2400 bytes = 50 ms
const ASR_CACHE_MS = 300000;
let cachedAsr = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function summarize(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(a[a.length - 1]), over100ms: a.filter((x) => x > 100).length, over500ms: a.filter((x) => x > 500).length };
}
// cgroup CPU limit and throttling counters (v2 first, then v1). Null where the container does not expose them.
function parseKv(text) { const o = {}; for (const line of String(text || '').split('\n')) { const m = /^(\w+)\s+(-?\d+)/.exec(line.trim()); if (m) o[m[1]] = Number(m[2]); } return o; }
function readCgroup(read = (f) => fs.readFileSync(f, 'utf8')) {
  const out = { version: null, cpuLimit: null, nrPeriods: null, nrThrottled: null, throttledMs: null };
  try { // cgroup v2
    const st = parseKv(read('/sys/fs/cgroup/cpu.stat')); const [quota, period] = String(read('/sys/fs/cgroup/cpu.max')).trim().split(/\s+/);
    out.version = 2; out.cpuLimit = quota === 'max' ? null : +(Number(quota) / Number(period)).toFixed(3);
    out.nrPeriods = st.nr_periods ?? null; out.nrThrottled = st.nr_throttled ?? null; out.throttledMs = st.throttled_usec != null ? Math.round(st.throttled_usec / 1000) : null;
    return out;
  } catch { /* not v2 */ }
  try { // cgroup v1
    const st = parseKv(read('/sys/fs/cgroup/cpu/cpu.stat')); const quota = Number(String(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')).trim()), period = Number(String(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us')).trim());
    out.version = 1; out.cpuLimit = quota > 0 ? +(quota / period).toFixed(3) : null;
    out.nrPeriods = st.nr_periods ?? null; out.nrThrottled = st.nr_throttled ?? null; out.throttledMs = st.throttled_time != null ? Math.round(st.throttled_time / 1e6) : null;
  } catch { /* no cgroup info */ }
  return out;
}
// Speech-like audio from memory: noise shaped by a ~4 Hz syllable envelope, with pauses, so Meta's detector treats it as talking.
function synthAudio(ms = 12000) {
  const n = Math.round(ms / FRAME_MS) * 1200, buf = Buffer.alloc(n * 2); let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) {
    const t = i / 24000, inPhrase = t % 4 >= 1 && t % 4 < 3.5;                         // 1 s quiet, 2.5 s of "speech", 0.5 s quiet
    const env = inPhrase ? 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t) : 0;
    buf.writeInt16LE(Math.round(rnd() * 2 * 9000 * env * (0.6 + 0.4 * Math.sin(2 * Math.PI * 220 * t))), i * 2);
  }
  return buf;
}
const diffCg = (a, b) => ({ cpuLimit: b.cpuLimit, throttledPeriods: b.nrThrottled != null && a.nrThrottled != null ? b.nrThrottled - a.nrThrottled : null, ofPeriods: b.nrPeriods != null && a.nrPeriods != null ? b.nrPeriods - a.nrPeriods : null, throttledMs: b.throttledMs != null && a.throttledMs != null ? b.throttledMs - a.throttledMs : null });

async function asrRun(label, { withLoad = false, ms = 12000, env = process.env, readCg = readCgroup } = {}) {
  const key = env.META_API_KEY || ''; const secrets = [key];
  const audio = synthAudio(ms), nFrames = Math.floor(audio.length / FRAME_BYTES);
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  const cg0 = readCg(), cpu0 = process.cpuUsage(), t0 = Date.now(), at = () => Date.now() - t0;
  const r = { label, withLoad, audioSentMs: 0, dropped: false, close: null, errors: [], sessionAckMs: null, senderLateMs: null, metaBehindMs: null, spark: null };
  let ack = false, closed = null; const progress = []; let sentMs = 0;
  const ws = deps.WebSocket(ASR_URL); ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => ws.send(JSON.stringify({ authorization: { accessToken: `Bearer ${key}` }, audioEncoding: 'PCM_24KHZ', model: 'muse-voice-transcribe-1.0', mode: 'DIARIZATION', partialMode: 'CUMULATIVE', emitAudioProgress: true, languageBias: ['English'] })));
  ws.addEventListener('message', (m) => {
    if (typeof m.data !== 'string') return;
    let e; try { e = JSON.parse(m.data); } catch { return; }
    if (!e.type && e.sessionId) { ack = true; r.sessionAckMs = at(); return; }
    if (e.type === 'audioProgress' && Number.isFinite(e.audioProcessedMs)) progress.push(sentMs - e.audioProcessedMs);   // how far behind the audio we have sent Meta says it is
    if (e.type === 'error') r.errors.push(redact(e.message, secrets));
  });
  ws.addEventListener('close', (e) => { if (!closed) closed = { code: e.code, reason: redact(e.reason || '', secrets) }; });   // the FIRST close is the one that matters
  ws.addEventListener('error', () => {});
  for (let i = 0; i < 400 && !ack && !closed; i++) await sleep(25);
  if (!ack) { lag.disable(); return { ...r, dropped: true, error: 'no session ack', close: closed }; }
  let sparkP = null;
  if (withLoad) {   // what a call does at the same moment: a real Spark request, and short bursts of synchronous work
    const s0 = Date.now(); let first = null;
    sparkP = deps.sparkStream([{ role: 'user', content: 'A: Hello Maya, how are you today?' }], '', AbortSignal.timeout(30000), () => { if (first === null) first = Date.now() - s0; })
      .then(() => { r.spark = { firstTokenMs: first, totalMs: Date.now() - s0 }; }, (e) => { r.spark = { error: redact(e.message, secrets) }; });
    for (const when of [1500, 3500, 5500, 7500, 9500]) setTimeout(() => { const end = Date.now() + 150; let x = 0; while (Date.now() < end) x += Math.sqrt(Date.now() % 97); r.burnSink = x > 0; }, when);
  }
  const late = []; const streamStart = Date.now();
  for (let i = 0; i < nFrames; i++) {
    if (closed) break;
    const due = streamStart + i * FRAME_MS, wait = due - Date.now(); if (wait > 0) await sleep(wait);
    late.push(Date.now() - due);
    try { ws.send(audio.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)); sentMs += FRAME_MS; } catch { break; }
  }
  r.audioSentMs = sentMs;
  await sleep(1500);   // let the last progress events and any close arrive
  if (sparkP) await Promise.race([sparkP, sleep(15000)]);
  try { ws.send(JSON.stringify({ type: 'endStream' })); } catch { /* closed */ } await sleep(300); try { ws.close(1000); } catch { /* closed */ }
  lag.disable();
  const cpu1 = process.cpuUsage(cpu0), wall = at();
  r.close = closed; r.dropped = Boolean(r.errors.length) || Boolean(closed && closed.code !== 1000);
  r.senderLateMs = summarize(late); r.metaBehindMs = summarize(progress);
  r.eventLoopDelayMs = { mean: +(lag.mean / 1e6).toFixed(1), p99: +(lag.percentile(99) / 1e6).toFixed(1), max: +(lag.max / 1e6).toFixed(1) };
  r.cpu = { usedMs: Math.round((cpu1.user + cpu1.system) / 1000), wallMs: wall, percentOfOneCore: +(((cpu1.user + cpu1.system) / 1000 / wall) * 100).toFixed(1) };
  r.cgroup = diffCg(cg0, readCg());
  delete r.burnSink;
  return r;
}

async function runAsr({ ms = 12000 } = {}) {
  const cg = readCgroup();
  const out = { at: new Date().toISOString(), node: process.version, cgroup: cg, note: 'synthetic speech-like audio from memory; no ElevenLabs, no browser, no call', runs: [] };
  out.runs.push(await asrRun('A  idle server', { withLoad: false, ms }));
  await sleep(2000);
  out.runs.push(await asrRun('B  server busy (real Spark call + 5 x 150 ms bursts of synchronous work)', { withLoad: true, ms }));
  return out;
}
async function getAsr(opts) {
  if (cachedAsr && Date.now() - cachedAsr.at < ASR_CACHE_MS) return { ...cachedAsr.value, cached: true };
  const value = await runAsr(opts);
  cachedAsr = { at: Date.now(), value };
  return value;
}

module.exports = { run, get, redact, deps, getAsr, runAsr, asrRun, synthAudio, summarize, parseKv, readCgroup, FRAME_BYTES };
