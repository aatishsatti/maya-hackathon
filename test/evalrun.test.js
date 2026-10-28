// The evaluation runner's pure parts: arguments, reading a child's result, merging the Meta usage tables, and the printed tables.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../eval/run');

test('arguments: sensible defaults, a suite list, run count limits, and unknown suites are ignored', () => {
  const d = R.parseArgs([]); assert.deepEqual(d.suites, R.SUITES); assert.equal(d.runs, 2); assert.equal(d.compare, true); assert.equal(d.updateBaseline, false); assert.equal(d.child, null);
  const a = R.parseArgs(['--suites', 'trends,nonsense,scam', '--runs', '99', '--no-compare', '--update-baseline', '--limit', '3']);
  assert.deepEqual(a.suites, ['trends', 'scam']); assert.equal(a.runs, 6, 'capped'); assert.equal(a.compare, false); assert.equal(a.updateBaseline, true); assert.equal(a.limit, 3);
  assert.equal(R.parseArgs(['--runs', '0']).runs, 2); assert.equal(R.parseArgs(['--child', 'scam']).child, 'scam');
  assert.ok(R.parseArgs(['--out', 'x.json']).out.endsWith('x.json'));
});

test('child result: the last EVAL_RESULT line is read; noise before it and broken JSON are ignored', () => {
  const ok = `warning: something\nEVAL_RESULT ${JSON.stringify({ suite: 'scam', metrics: { warned: 1 } })}\n`;
  assert.deepEqual(R.parseChild(ok), { suite: 'scam', metrics: { warned: 1 } });
  assert.equal(R.parseChild('no result here'), null); assert.equal(R.parseChild('EVAL_RESULT {broken'), null); assert.equal(R.parseChild(''), null); assert.equal(R.parseChild(null), null);
  assert.deepEqual(R.parseChild(`EVAL_RESULT {"a":1}\nEVAL_RESULT {"a":2}`), { a: 2 }, 'the last one wins');
});

test('usage tables from several suites merge by job and model; speed is weighted by calls', () => {
  const a = [{ purpose: 'live-reply', model: 'm', calls: 2, failed: 0, failedBy: {}, avgMs: 100, tokensIn: 10, tokensOut: 4, audioMs: 0 }, { purpose: 'scam-text', model: 'm', calls: 1, failed: 1, failedBy: { 'http-5xx': 1 }, avgMs: null, tokensIn: 0, tokensOut: 0, audioMs: 0 }];
  const b = [{ purpose: 'live-reply', model: 'm', calls: 6, failed: 1, failedBy: { aborted: 1 }, avgMs: 200, tokensIn: 60, tokensOut: 24, audioMs: 0 }];
  const m = R.mergeUsage([a, b, undefined]);
  assert.deepEqual(m.find((x) => x.purpose === 'live-reply'), { purpose: 'live-reply', model: 'm', calls: 8, failed: 1, failedBy: { aborted: 1 }, avgMs: 175, tokensIn: 70, tokensOut: 28, audioMs: 0 });
  assert.equal(m.find((x) => x.purpose === 'scam-text').avgMs, null); assert.deepEqual(m.map((x) => x.purpose), ['live-reply', 'scam-text']);
});

test('reasoning comparison rows and the printed tables carry the numbers and the "nothing live changed" label', () => {
  const rows = R.reasoningRows({ low_warned: 1, low_falseWarn: 0, low_pauseInProgress: 1, low_avgMs: 3400, low_p90Ms: 5000, low_tokensIn: 700, low_tokensOut: 620, minimal_warned: 0.97, minimal_falseWarn: 0, minimal_pauseInProgress: 0.8, minimal_avgMs: 1500, minimal_p90Ms: 2200, minimal_tokensIn: 700, minimal_tokensOut: 90 });
  assert.deepEqual(rows.map((r) => r.setting), ['low', 'minimal']); assert.equal(rows[1].avgMs, 1500); assert.deepEqual(R.reasoningRows({}), []); assert.deepEqual(R.reasoningRows(undefined), []);
  const t = R.tables({ metrics: {}, checks: [{ status: 'pass', text: 'a check' }, { status: 'FAIL', text: 'another' }], cmp: [{ key: 'scam.warned', now: 0.9, was: 1, status: 'REGRESSED' }, { key: 'x.y', now: null, was: 1, status: 'n/a' }],
    usage: [{ purpose: 'live-reply', model: 'muse-spark-1.3', calls: 8, failed: 3, failedBy: { aborted: 2 }, avgMs: 175, tokensIn: 70, tokensOut: 28 }], reasoning: rows });
  assert.match(t, /GUARD RAILS/); assert.match(t, /FAIL +another/); assert.match(t, /REGRESSED +scam\.warned +was 100% +now 90%/); assert.doesNotMatch(t, /x\.y/, 'n/a rows are not printed');
  assert.match(t, /META MODELS DOING THE WORK/); assert.match(t, /live-reply +muse-spark-1\.3 +8 +2 +1 +175/, 'calls, cancelled on purpose, real failures, speed'); assert.match(t, /cancelled = stopped on purpose/); assert.match(t, /REASONING SETTING \(dev half; minimal is live since 2026-10-28, low is the earlier setting\)/); assert.match(t, /minimal +97% +0% +80% +1500/);
});

test('safety of the runner: children always get throwaway data folders and the ledger, the voice cannot be reached, and the held-out scam half is never read', () => {
  const run = fs.readFileSync(path.join(__dirname, '..', 'eval', 'run.js'), 'utf8');
  assert.match(run, /process\.env\.MAYA_DATA_DIR = path\.join\(tmp/); assert.match(run, /process\.env\.MAYA_META_LEDGER = '1'/); assert.match(run, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\)/);
  const all = ['run.js', 'score.js', 'rules.js', 'suites/common.js', 'suites/conversation.js', 'suites/memory.js', 'suites/scam.js', 'suites/trends.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'eval', f), 'utf8').replace(/\/\/.*$/gm, '')).join('\n');
  assert.doesNotMatch(all, /api\.elevenlabs|ELEVENLABS_|xi-api-key|streamSpeech\(/i, 'no ElevenLabs address, key or voice call anywhere in the evaluation'); assert.match(fs.readFileSync(path.join(__dirname, '..', 'eval', 'suites', 'common.js'), 'utf8'), /brain\.streamSpeech = async \(\) => \{\}/);
  const scam = fs.readFileSync(path.join(__dirname, '..', 'eval', 'suites', 'scam.js'), 'utf8');
  assert.match(scam, /i\.split === 'dev'/); assert.doesNotMatch(scam.replace(/\/\/.*$/gm, ''), /split === 'held'/);
});

test('usage metrics: real errors exclude replies Maya cancelled on purpose; the cancelled share and the request size are reported', () => {
  const u = [{ purpose: 'live-reply', model: 'm', calls: 100, failed: 30, failedBy: { aborted: 28, 'http-5xx': 2 }, tokensIn: 350000, tokensOut: 20000 }, { purpose: 'scam-text', model: 'm', calls: 100, failed: 1, failedBy: { timeout: 1 }, tokensIn: 70000, tokensOut: 60000 }];
  assert.deepEqual(R.usageMetrics(u), { realFailureRate: (3) / 200, liveCancelledShare: 0.28, liveTokensInPerCall: 3500 });
  assert.deepEqual(R.usageMetrics([]), { realFailureRate: null, liveCancelledShare: null, liveTokensInPerCall: null });
  assert.deepEqual(R.usageMetrics([{ purpose: 'scam-text', model: 'm', calls: 5, failed: 0, tokensIn: 1, tokensOut: 1 }]), { realFailureRate: 0, liveCancelledShare: null, liveTokensInPerCall: null });
});
