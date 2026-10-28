// The Meta usage ledger (meta.js): off by default, counts only, nothing from a message / audio / key can get in, and every real Meta call
// site records exactly one row. The network is stubbed; the distinctive words below exist only to prove they never reach the ledger.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.META_API_KEY = 'sk-test-key-not-real-7788';
const meta = require('../meta');
const brain = require('../brain');
const scam = require('../scam');
const transcribe = require('../transcribe');

const realFetch = global.fetch, RealWS = global.WebSocket;
const SECRET_WORDS = ['xylophone', 'sk-test-key-not-real-7788', 'Bearer', 'Margaret', 'purple elephant'];
const on = () => { process.env.MAYA_META_LEDGER = '1'; meta.reset(); };
const off = () => { delete process.env.MAYA_META_LEDGER; meta.reset(); global.fetch = realFetch; global.WebSocket = RealWS; };
const reply = (content, usage) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }), text: async () => '' });
const USAGE = { prompt_tokens: 120, completion_tokens: 35 };

test('off by default: nothing is recorded, begin() is a no-op, and a real call leaves no trace', async () => {
  off();
  assert.equal(meta.enabled(), false); assert.equal(meta.record({ purpose: 'live-reply', model: 'm' }), false);
  const m = meta.begin('live-reply', 'm'); m.first(); m.done(true, { usage: USAGE });
  global.fetch = reply('hello xylophone', USAGE);
  assert.equal(await brain.sparkComplete('instructions', 'user text'), 'hello xylophone');
  assert.deepEqual(meta.snapshot(), []); assert.deepEqual(meta.summary(), []);
  off();
});

test('only numbers and a purpose label get in: everything else handed to the ledger is dropped', () => {
  on();
  meta.record({ purpose: 'live-reply', model: 'muse-spark-1.3', ok: true, ms: 812.6, firstMs: 301, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, secret: 'purple elephant' },
    text: 'my xylophone is out of tune', transcript: 'Margaret said hello', audio: Buffer.from('audio'), apiKey: 'sk-test-key-not-real-7788', authorization: 'Bearer abc', name: 'Margaret' });
  const [row] = meta.snapshot();
  assert.deepEqual(Object.keys(row).sort(), ['audioMs', 'firstMs', 'tokensIn', 'tokensOut', 'model', 'ms', 'ok', 'purpose'].sort());
  assert.deepEqual(row, { purpose: 'live-reply', model: 'muse-spark-1.3', ok: true, ms: 813, firstMs: 301, tokensIn: 100, tokensOut: 20, audioMs: null });
  const dump = JSON.stringify([meta.snapshot(), meta.summary()]);
  for (const w of SECRET_WORDS) assert.ok(!dump.includes(w), `${w} must never be in the ledger`);
  off();
});

test('labels and numbers are cleaned: an unknown purpose is "other", the model is a short safe token, bad numbers become null', () => {
  on();
  meta.record({ purpose: 'say-anything-here', model: 'muse spark<script>1.3' + 'x'.repeat(100), ms: -5, firstMs: 'soon', usage: { prompt_tokens: NaN, completion_tokens: Infinity }, audioMs: '' });
  meta.record({ purpose: 'scam-text', model: 7, usage: { input_tokens: 9, output_tokens: 4 }, audioMs: 2300 });
  const [a, b] = meta.snapshot();
  assert.equal(a.purpose, 'other'); assert.match(a.model, /^[\w.\-]{0,40}$/); assert.deepEqual([a.ms, a.firstMs, a.tokensIn, a.tokensOut, a.audioMs], [null, null, null, null, null]);
  assert.equal(b.model, ''); assert.deepEqual([b.tokensIn, b.tokensOut, b.audioMs], [9, 4, 2300], 'both token field spellings are understood');
  assert.equal(meta.record(null), false); assert.equal(meta.record('text'), false);
  off();
});

test('summary: one line per purpose and model with calls, failures, speed, tokens and audio', () => {
  on();
  for (const ms of [100, 300, 200]) meta.record({ purpose: 'live-reply', model: 'm1', ms, firstMs: ms / 2, usage: { prompt_tokens: 10, completion_tokens: 5 } });
  meta.record({ purpose: 'live-reply', model: 'm1', ok: false, ms: 50 });
  meta.record({ purpose: 'transcribe-call', model: 't1', audioMs: 1500 }); meta.record({ purpose: 'transcribe-call', model: 't1', audioMs: 500 });
  const s = Object.fromEntries(meta.summary().map((x) => [x.purpose, x]));
  assert.deepEqual(s['live-reply'], { purpose: 'live-reply', model: 'm1', calls: 4, failed: 1, avgMs: 163, medianMs: 200, avgFirstMs: 100, tokensIn: 30, tokensOut: 15, audioMs: 0 });
  assert.equal(s['transcribe-call'].calls, 2); assert.equal(s['transcribe-call'].audioMs, 2000); assert.equal(s['transcribe-call'].avgMs, null, 'unknown speed stays unknown, not zero');
  assert.deepEqual(meta.summary().map((x) => x.purpose), ['live-reply', 'transcribe-call'], 'sorted');
  off();
});

test('bounded: a long-running server never grows the ledger without limit (oldest rows go first)', () => {
  on();
  for (let i = 0; i < meta.MAX_ROWS + 50; i++) meta.record({ purpose: 'scam-text', model: 'm', ms: i });
  assert.equal(meta.snapshot().length, meta.MAX_ROWS); assert.equal(meta.snapshot()[0].ms, 50);
  off();
});

test('begin().done: records the time, the first-token time, failure, and the usage numbers', async () => {
  on();
  const ok = meta.begin('live-reply', 'm'); await new Promise((r) => setTimeout(r, 15)); ok.first(); ok.first(); ok.done(true, { usage: USAGE });
  const bad = meta.begin('scam-text', 'm'); bad.done(false);
  const [a, b] = meta.snapshot();
  assert.ok(a.ms >= 10 && a.firstMs >= 10 && a.firstMs <= a.ms); assert.equal(a.ok, true); assert.deepEqual([a.tokensIn, a.tokensOut], [120, 35]);
  assert.equal(b.ok, false); assert.equal(b.firstMs, null);
  off();
});

test('every real call site records exactly one row with the right purpose, and the call behaves exactly as before', async () => {
  on();
  global.fetch = reply('filed: purple elephant', USAGE);
  assert.equal(await brain.sparkComplete('instr', 'Margaret said xylophone'), 'filed: purple elephant');
  global.fetch = reply('A photo of a xylophone.', USAGE);
  assert.equal(await brain.describeImage(Buffer.from('img'), 'image/png'), 'A photo of a xylophone.');
  global.fetch = reply(JSON.stringify({ reading: 'xylophone letter', type: 'prize scam', urgency: true, money: true, impersonation: false, secrecy: false, payment: true }), USAGE);
  assert.equal((await scam.assess(Buffer.from('img'), 'image/png')).level, 'warn');
  global.fetch = reply(JSON.stringify({ reading: 'Margaret rang', type: 'bank scam', urgency: false, money: false, impersonation: true, secrecy: false, payment: true, remoteAccess: false, idDetails: false, happeningNow: false, aboutToAct: false }), USAGE);
  assert.equal((await scam.assessText('Margaret rang about the xylophone')).level, 'warn');
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ transcript: 'purple elephant', audioDurationMs: 4200 }), text: async () => '' });
  assert.equal(await transcribe.transcribeWav('sk-test-key-not-real-7788', Buffer.alloc(100)), 'purple elephant');
  const enc = new TextEncoder();
  global.fetch = async () => ({ ok: true, status: 200, body: (async function* () { yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`); yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'xylophone' } }], usage: USAGE })}\n\ndata: [DONE]\n\n`); })() });
  const parts = []; assert.equal(await brain.sparkStream([{ role: 'user', content: 'hi' }], 'roster', new AbortController().signal, (d) => parts.push(d)), 'Hello xylophone');
  const got = Object.fromEntries(meta.summary().map((x) => [x.purpose, x]));
  assert.deepEqual(Object.keys(got).sort(), ['live-reply', 'memory-filing', 'scam-photo', 'scam-text', 'transcribe-voice-note', 'vision-describe'].sort());
  for (const k of Object.keys(got)) { assert.equal(got[k].calls, 1, k); assert.equal(got[k].failed, 0, k); assert.equal(got[k].model.length > 0, true, k); }
  assert.deepEqual([got['memory-filing'].tokensIn, got['memory-filing'].tokensOut], [120, 35]); assert.deepEqual([got['live-reply'].tokensIn, got['live-reply'].tokensOut], [120, 35], 'usage from the stream');
  assert.equal(got['transcribe-voice-note'].audioMs, 4200); assert.ok(got['live-reply'].avgFirstMs !== null, 'time to first words is kept for the live reply');
  const dump = JSON.stringify([meta.snapshot(), meta.summary()]);
  for (const w of SECRET_WORDS) assert.ok(!dump.includes(w), `${w} must never be in the ledger`);
  off();
});

test('a failed call records a failed row and still throws the same error; an unusable answer is a failed row too', async () => {
  on();
  global.fetch = async () => ({ ok: false, status: 503, text: async () => 'busy', json: async () => ({}) });
  await assert.rejects(brain.sparkComplete('i', 'u'), /Meta Spark failed \(HTTP 503\) busy/);
  await assert.rejects(scam.assessText('hello there my friend'), /Meta Spark failed \(HTTP 503\)/);
  await assert.rejects(transcribe.transcribeWav('k', Buffer.alloc(10)), /Meta Transcribe failed \(HTTP 503\)/);
  global.fetch = reply('not json at all');
  await assert.rejects(scam.assessText('hello there my friend'), /no usable scam check/);
  const s = Object.fromEntries(meta.summary().map((x) => [x.purpose, x]));
  assert.deepEqual([s['memory-filing'].calls, s['memory-filing'].failed], [1, 1]); assert.deepEqual([s['scam-text'].calls, s['scam-text'].failed], [2, 2]); assert.deepEqual([s['transcribe-voice-note'].calls, s['transcribe-voice-note'].failed], [1, 1]);
  off();
});

test('Transcribe on a live call: each finished turn is one row with its audio length (never the words); a refused session is a failed row', () => {
  on();
  class FakeWS { constructor() { FakeWS.last = this; this.l = {}; this.readyState = 1; } addEventListener(t, f) { this.l[t] = f; } send() {} close() {} }
  FakeWS.OPEN = 1; global.WebSocket = FakeWS;
  const events = [];
  const s = transcribe.openTranscribe('sk-test-key-not-real-7788', { onReady() {}, onEvent: (e) => events.push(e), onClose() {} });
  const ws = FakeWS.last;
  ws.l.message({ data: JSON.stringify({ sessionId: 'abc' }) });
  ws.l.message({ data: JSON.stringify({ type: 'speechComplete', turnId: 1, transcript: 'Margaret said purple elephant', audioProcessedMs: 2300 }) });
  ws.l.message({ data: JSON.stringify({ type: 'speechComplete', turnId: 2, transcript: 'and the xylophone', audioProcessedMs: 1700 }) });
  ws.l.message({ data: JSON.stringify({ type: 'error', message: 'nope' }) });
  assert.equal(events.filter((e) => e.type === 'speechComplete').length, 2, 'events still reach the caller unchanged');
  const [row] = meta.summary(); assert.deepEqual([row.purpose, row.calls, row.failed, row.audioMs], ['transcribe-call', 3, 1, 4000]);
  for (const w of SECRET_WORDS) assert.ok(!JSON.stringify(meta.snapshot()).includes(w), w);
  s.close(); off();
});

test('the ledger module is pure bookkeeping: no network, no file, no key, no app module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'meta.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /require\(|fetch\(|process\.env\.(?!MAYA_META_LEDGER)|writeFile|readFile|console\./);
});

test.after(() => off());
