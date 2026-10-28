// The four evaluation suites, end to end and OFFLINE: a stand-in Spark and a stand-in network replace Meta. This proves the plumbing, the metric
// names, the usage ledger and the safety rules (dev half only, both reasoning settings asked for, no voice). The real numbers come from `npm run eval`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-evalsuites-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.META_API_KEY = 'sk-test-not-real'; process.env.MAYA_META_LEDGER = '1';

let sparkCalls = 0;
const TAGGED = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0 topic=same personal=0]] That sounds nice. Tell me more about it.';
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => { throw new Error('the voice must never be reached'); }, sparkComplete: async () => '{}', describeImage: async () => 'x',
  sparkStream: async (_h, roster, _s, onDelta) => { if (/has been silent for a little while/.test(roster)) return ''; sparkCalls += 1; if (onDelta) onDelta(TAGGED); return TAGGED; },
  META_URL: 'https://api.meta.ai/v1/chat/completions', liveModel: () => 'muse-spark-1.3',
} };
const sent = [];
global.fetch = async (url, o) => {
  const body = JSON.parse(o.body); sent.push({ url, reasoning: body.reasoning_effort, content: body.messages[0].content });
  const scammy = /gift card|gift cards|bank|code|prize|rebate|cheque|refund|virus|arrest/i.test(body.messages[0].content.split('WHAT THEY RECEIVED OR TOLD YOU:')[1] || '');
  const ans = { reading: 'x', type: scammy ? 'payment scam' : 'ordinary message', urgency: scammy, money: false, impersonation: false, secrecy: false, payment: scammy, remoteAccess: false, idDetails: false, happeningNow: false, aboutToAct: false };
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(ans) } }], usage: { prompt_tokens: 700, completion_tokens: body.reasoning_effort === 'minimal' ? 80 : 600 } }), text: async () => '' };
};
const care = require('../care'); const meta = require('../meta');
const score = require('../eval/score');
const SET = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'scam-testset.json'), 'utf8')).items;

const numeric = (m) => Object.entries(m).every(([, v]) => v === null || typeof v === 'number');

test('trends suite: offline, deterministic, the published held-out-seed numbers, no Meta calls', async () => {
  const before = sent.length; const r = await require('../eval/suites/trends').run();
  assert.equal(sent.length, before, 'no network'); assert.ok(numeric(r.metrics));
  for (const k of ['falseAlarmQuiet', 'falseAlarmOrdinary', 'falseAlarmCold3', 'detectionMean', 'detected_lonelyDrift', 'detected_risingPain', 'medianDelay_withdrawal']) assert.ok(k in r.metrics, k);
  assert.ok(r.metrics.falseAlarmOrdinary <= 0.04 && r.metrics.detectionMean >= 0.72, JSON.stringify(r.metrics));
  assert.deepEqual(r.metrics, (await require('../eval/suites/trends').run()).metrics, 'the same numbers every time');
});

test('conversation suite: real Call path, tags captured, every metric present and numeric, worry runs scored', async () => {
  meta.reset(); const r = await require('../eval/suites/conversation').run({ runs: 1, limit: 2 });
  for (const k of ['replies', 'repeatRate', 'thatSounds', 'questionRate', 'avgWords', 'topicPresent', 'topicAccuracy', 'personalPresent', 'personalAccuracy', 'limitViolations', 'worryAction', 'worrySeededAction', 'worryColdAction']) assert.ok(k in r.metrics, k);
  assert.ok(numeric(r.metrics)); assert.equal(r.metrics.replies, 8, '4 chats x 2 lines'); assert.equal(r.metrics.topicPresent, 1, 'the private tag was read on every reply');
  assert.equal(r.metrics.personalPresent, 1); assert.equal(r.metrics.limitViolations, 0); assert.equal(r.metrics.worryAction, 0, 'the stand-in never says what the app does');
  assert.equal(r.details.chats.length, 4); assert.ok(r.details.chats.every((c) => c.turns.every((t) => t.tag && t.maya)));
});

test('memory suite: every scenario runs through the real memory and care code and reports its rates', async () => {
  const r = await require('../eval/suites/memory').run({ runs: 1, limit: 1 });
  for (const k of ['askedEarly', 'askedOnce', 'heavyQuiet', 'safetyQuiet', 'askedFirstInNextCall', 'recallAccuracy', 'honest', 'closedAfterAnswer', 'closedAfterBrushoff', 'notRepeatedAfterClose']) assert.ok(k in r.metrics, k);
  assert.ok(numeric(r.metrics)); assert.equal(r.metrics.heavyQuiet, 1); assert.equal(r.metrics.safetyQuiet, 1, 'the safety words really did raise the safety path');
  assert.equal(r.metrics.askedEarly, 0, 'the stand-in never mentions the follow-up, so nothing is counted as asked'); assert.equal(r.metrics.recallAccuracy, 0);
  assert.equal(r.metrics.askedFirstInNextCall, 0); assert.equal(r.metrics.closedAfterAnswer, null, 'no scenario where she asked: nothing to judge, so no number (never a made-up pass)'); assert.equal(r.metrics.closedAfterBrushoff, null);
});

test('scam suite: dev half only, both reasoning settings asked for, rates + speed + tokens per setting, and the filter numbers', async () => {
  sent.length = 0; const r = await require('../eval/suites/scam').run({ runs: 1, limit: 3 });
  const reasoning = new Set(sent.map((s) => s.reasoning)); assert.deepEqual([...reasoning].sort(), ['low', 'minimal']);
  const devTexts = new Set(SET.filter((i) => i.split === 'dev').map((i) => i.text)); const heldTexts = SET.filter((i) => i.split === 'held').map((i) => i.text);
  for (const s of sent) { const msg = s.content.split('WHAT THEY RECEIVED OR TOLD YOU:\n')[1]; assert.ok(devTexts.has(msg), 'only dev items are ever sent'); assert.ok(!heldTexts.includes(msg), 'the held-out half is never touched'); }
  for (const k of ['warned', 'falseWarn', 'pauseInProgress', 'low_warned', 'minimal_warned', 'low_avgMs', 'minimal_avgMs', 'low_tokensOut', 'minimal_tokensOut', 'low_p90Ms', 'filterRecallDev', 'ordinaryTrigger']) assert.ok(k in r.metrics, k);
  assert.ok(numeric(r.metrics)); assert.equal(r.metrics.low_tokensOut, 600); assert.equal(r.metrics.minimal_tokensOut, 80, 'tokens come from the usage ledger, per setting');
  assert.equal(r.metrics.filterRecallDev, 1); assert.ok(r.metrics.ordinaryTrigger <= 2 / 30 + 1e-9);
});

test('the suites together: the usage ledger names the Meta jobs that ran, and no voice was reached', () => {
  const jobs = new Set(meta.summary().map((x) => x.purpose));
  assert.ok(jobs.has('scam-text')); assert.ok(sparkCalls > 0);
  const flat = score.flatten({ scam: { warned: 1 }, trends: { a: 0.5 } }); assert.deepEqual(flat, { 'scam.warned': 1, 'trends.a': 0.5 });
});

test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); meta.reset(); delete process.env.MAYA_META_LEDGER; });
