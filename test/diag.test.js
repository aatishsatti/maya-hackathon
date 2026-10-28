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
  assert.equal(out.metaKey.length, KEY.length); assert.equal(out.metaKey.present, true); assert.equal(out.metaKey.hasWhitespace, false); assert.equal(out.metaKey.onlyKeySafeChars, true);
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
