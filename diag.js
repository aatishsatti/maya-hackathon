// TEMPORARY hosting diagnostic (render-test branch only, to be removed before the final version). GET /api/diag answers, without ever
// showing a secret: what model Maya is set to use, how long the Meta key is (length only), what Meta's model list says from THIS
// server, a one-token test per model, and where this server's requests come from (country). It tells apart: a key without chat access,
// a region problem, and a setting that never reached the app. Cached for 60 s so the public URL cannot be used to run up calls.
const META = 'https://api.meta.ai/v1';
const FIXED_MODELS = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'];
const CACHE_MS = 60000;
let cached = null;

const deps = { fetch: (...a) => fetch(...a) };

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

module.exports = { run, get, redact, deps };
