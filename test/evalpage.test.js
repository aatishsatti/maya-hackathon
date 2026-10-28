// The Meta-models page and write-up: built from committed data, self-contained (no external request), honest about its limits, and never stale.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../eval/page');

const ROOT = path.join(__dirname, '..');
const mk = (id, label, extra = {}) => ({ id, label, category: 'bank', channel: 'text', text: `item ${id} gift cards and the code now please send`, ...extra });
const ITEMS = [mk('S1', 'scam'), mk('S2', 'scam', { hard: true }), mk('S3', 'scam', { now: true }), mk('N1', 'normal'), mk('N2', 'normal', { legitpay: true })];
const LOW = { S1: { level: 'warn' }, S2: { level: 'warn' }, S3: { level: 'pause' }, N1: { level: 'none' }, N2: { level: 'none' } };
const MIN = { S1: { level: 'warn' }, S2: { level: 'caution' }, S3: { level: 'pause' }, N1: { level: 'none' }, N2: { level: 'none' } };
const RESULTS = {
  when: '2026-10-28T20:00:00Z', runs: 2, seconds: 321,
  metrics: { 'conversation.repeatRate': 0, 'conversation.topicAccuracy': 0.98, 'conversation.worryAction': 1, 'memory.askedEarly': 0.75, 'trends.falseAlarmOrdinary': 0.014, 'trends.detectionMean': 0.78, 'scam.warned': 0.99, 'scam.minimal_avgMs': 2471, 'scam.minimal_tokensIn': 727, 'scam.minimal_tokensOut': 371.5 },
  checks: [{ id: 'conv.limits', text: 'no connect / close reply asks a question', status: 'pass' }, { id: 'scam.warn', text: 'dev scams warned at least 94%', status: 'pass' }, { id: 'hear.wer', text: 'word error rate at most 8%', status: 'FAIL' }, { id: 'mem.recall', text: 'a <script>alert(1)</script> check', status: 'skipped' }],
  usage: [{ purpose: 'live-reply', model: 'muse-spark-1.3', calls: 100, failed: 30, failedBy: { aborted: 28, 'http-5xx': 2 }, avgMs: 2000, tokensIn: 350000, tokensOut: 20000, audioMs: 0 },
    { purpose: 'memory-filing', model: 'muse-spark-1.3', calls: 10, failed: 0, failedBy: {}, avgMs: 9000, tokensIn: 15000, tokensOut: 22000, audioMs: 0 },
    { purpose: 'scam-text', model: 'muse-spark-1.3', calls: 300, failed: 0, failedBy: {}, avgMs: 2800, tokensIn: 218000, tokensOut: 110000, audioMs: 0 },
    { purpose: 'transcribe-voice-note', model: 'muse-voice-transcribe-1.0', calls: 48, failed: 0, failedBy: {}, avgMs: 2034, tokensIn: 0, tokensOut: 0, audioMs: 169000 }],
  suites: [{ suite: 'hearing', metrics: { sentences: 48, failed: 0, wer: 0.033, exact: 0.65, termSurvival: 0.992, scamTermSurvival: 1, avgMs: 2034, audioSeconds: 169 } }],
};
const REASONING = { runs: 4, liveSetting: 'minimal', low: { warned: 1, falseWarn: 0, pauseInProgress: 0.95, avgMs: 4984, p90Ms: 7458, tokensIn: 727, tokensOut: 851 }, minimal: { warned: 0.993, falseWarn: 0, pauseInProgress: 0.95, avgMs: 2881, p90Ms: 4309, tokensIn: 727, tokensOut: 367 } };
const summary = () => P.buildSummary(RESULTS, { items: ITEMS, low: { byId: LOW }, minimal: { byId: MIN } }, REASONING, new Date('2026-10-29T00:00:00Z'));

test('the summary keeps the numbers, the checks and the held-out views for both settings, and nothing else (no replies, no keys)', () => {
  const s = summary();
  assert.equal(s.when, '2026-10-28'); assert.equal(s.generated, '2026-10-29'); assert.equal(s.runs, 2); assert.equal(s.hearing.wer, 0.033);
  assert.deepEqual([s.held.low.alone.warned, s.held.minimal.alone.warned], [3 - 0, 2], 'low warned 3 of 3 scams, minimal 2 of 3');
  assert.deepEqual(s.held.lowMissed, []); assert.deepEqual(s.held.minimalMissed.map((x) => [x.id, x.level]), [['S2', 'caution']]);
  assert.equal(JSON.stringify(s).includes('sk-'), false);
  assert.deepEqual(Object.keys(s.checks[0]).sort(), ['id', 'status', 'text']);
});

test('the page is self-contained: no script, no image, no link, no style sheet or font to fetch, and no web address at all', () => {
  const html = P.render(summary());
  assert.match(html, /^<!doctype html>\n<html lang="en">/); assert.match(html, /<meta name="viewport"/); assert.match(html, /<title>Maya: Meta models doing the work<\/title>/);
  assert.doesNotMatch(html, /<script|<img|<link|<iframe|<object|<embed|@import|url\((?!#)|\bsrc=|\bhref=/i, 'the only url() allowed is a same-file #fragment (the arrowhead)');
  assert.deepEqual([...html.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ['#ah']);
  assert.doesNotMatch(html, /https?:\/\//i, 'not even a printed web address that someone could mistake for a request');
  assert.ok(html.length < 40000, `small: ${html.length}`); assert.match(html, /prefers-color-scheme:dark/);
});

test('everything from the data is escaped: text that looks like markup is shown as text', () => {
  const html = P.render(summary());
  assert.ok(!html.includes('<script>alert(1)</script>')); assert.ok(html.includes('a &lt;script&gt;alert(1)&lt;/script&gt; check'));
  assert.equal(P.esc(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('the page says what has to be said: the Meta models and their jobs, ElevenLabs as the only non-Meta part, vision wired-not-measured, hearing is synthetic clean speech, the cost of minimal', () => {
  const html = P.render(summary());
  for (const t of ['muse-spark-1.3', 'muse-voice-transcribe-1.0', 'Live reply', 'Memory filing', 'Scam check on typed and spoken talk', 'Hearing a recorded voice note', 'Hearing a live call']) assert.ok(html.includes(t), t);
  assert.match(html, /the only part that is not Meta/); assert.match(html, /<b>wired, not measured<\/b>: the evaluation is text only/);
  assert.match(html, /<b>synthetic clean speech<\/b>/); assert.match(html, /no real older voices, no accents, no hesitation, no noisy room/); assert.match(html, /used live; <b>not part of the evaluation<\/b>/);
  assert.match(html, /The cost of the change, stated plainly/); assert.match(html, /<code>minimal<\/code> warned 2 of 3 scams against 3 of 3 for <code>low<\/code>/);
  assert.match(html, /polite invoice scam[^.]*moved from a warning to a caution: still flagged, not missed/); assert.match(html, /about 1\.7 times faster/); assert.match(html, /57% fewer output tokens/);
  assert.match(html, /No ElevenLabs request is made by the evaluation/); assert.match(html, /loads nothing from the internet/);
});

test('the numbers on the page are the numbers in the data', () => {
  const html = P.render(summary());
  assert.match(html, /<td>100<\/td><td>2\.0 s<\/td><td>3,500 \/ 200<\/td>/, 'live reply: calls, speed, tokens per call'); assert.match(html, /30% cancelled|28 cancelled and rewritten on purpose \(28%\), 2 real errors/);
  assert.match(html, /<td>300 \(half at each setting, for the comparison\)<\/td><td>2\.5 s<\/td><td>727 \/ 372<\/td>/, 'the scam-check row shows the LIVE setting\'s speed and tokens, not a blend of both settings');
  assert.doesNotMatch(html, /<td>2\.8 s<\/td><td>727 \/ 367<\/td><td>measured; speed/, 'never the blended average');
  assert.match(html, /<td>48<\/td><td>2\.0 s<\/td><td>169 s of audio<\/td>/); assert.match(html, /Word error rate <b>3\.3%<\/b>/); assert.match(html, /<b>99\.2%<\/b> of the key words/); assert.match(html, /<b>100%<\/b> of the words a scam turns on/);
  assert.match(html, /Twenty-four fixed sentences[^.]*48 hearings, 0 failed/); assert.match(html, /<div class="n">78%<\/div>/); assert.match(html, /<div class="n">1\.4%<\/div>/);
  assert.match(html, /<span class="pill FAIL">FAIL<\/span> word error rate at most 8%/, 'a failing rail is shown as FAIL, in words not only colour'); assert.match(html, /<span class="pill skipped">skipped<\/span>/);
});

test('the one-page write-up: short, the same facts, the limits, and the numbers match the data', () => {
  const md = P.renderMarkdown(summary());
  assert.ok(md.split('\n').length <= 60, `one page: ${md.split('\n').length} lines`);
  for (const t of ['# Maya: how Meta models are used', 'muse-spark-1.3', 'muse-voice-transcribe-1.0', '**not measured**', '**synthetic clean speech**', 'Photos (Spark vision) are wired and used but **not measured**', 'about 1.7x faster', '57% fewer output tokens', 'ElevenLabs is only the voice']) assert.ok(md.includes(t), t);
  assert.match(md, /word error rate 3\.3% on synthetic clean speech; 99\.2% of key words, 100% of scam words/); assert.match(md, /`low` warned 3 of 3, `minimal` 2 of 3/);
  assert.doesNotMatch(md, /https?:\/\//);
});

test('same data, same page (deterministic), and the committed page and write-up are never stale', () => {
  assert.equal(P.render(summary()), P.render(summary())); assert.equal(P.renderMarkdown(summary()), P.renderMarkdown(summary()));
  const file = path.join(ROOT, 'docs', 'eval', 'summary.json');
  if (!fs.existsSync(file)) return;   // before the first generation
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fs.readFileSync(path.join(ROOT, 'docs', 'meta-models.html'), 'utf8'), P.render(s), 'docs/meta-models.html is rebuilt from docs/eval/summary.json: run `node eval/page.js`');
  assert.equal(fs.readFileSync(path.join(ROOT, 'docs', 'meta-models.md'), 'utf8'), P.renderMarkdown(s), 'docs/meta-models.md is rebuilt from docs/eval/summary.json: run `node eval/page.js`');
});

test('the generator touches no network and no app file: it reads committed data and writes only docs/', () => {
  const src = fs.readFileSync(path.join(ROOT, 'eval', 'page.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /fetch\(|require\('node:(http|https|net)'\)|child_process|process\.env/);
  const writes = [...src.matchAll(/writeFileSync\(path\.join\(ROOT, '([^']+)'/g)].map((m) => m[1]); assert.deepEqual(writes, ['docs', 'docs', 'docs'], 'three files, all under docs/');
  assert.ok(!fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8').includes('meta-models'), 'no app page links to it');
});
