// The saved baseline: the mean of several full runs and how far they differed. Pure functions; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../eval/baseline');

const RUNS = [
  { metrics: { 'a.x': 1, 'a.y': 0.5, 'a.z': null, 'a.t': 'text' }, checks: [{ id: 'c1', status: 'pass', text: 'one' }, { id: 'c2', status: 'pass', text: 'two' }] },
  { metrics: { 'a.x': 0.5, 'a.y': 0.5, 'a.z': null }, checks: [{ id: 'c1', status: 'FAIL', text: 'one' }, { id: 'c2', status: 'skipped', text: 'two' }] },
  { metrics: { 'a.x': 0.75, 'a.y': 0.5, 'a.w': 3 }, checks: [{ id: 'c1', status: 'pass', text: 'one' }, { id: 'c2', status: 'pass', text: 'two' }] },
];

test('aggregate: mean, lowest, highest and spread per metric; null and text are ignored; a metric present in some runs is averaged over those', () => {
  const a = B.aggregate(RUNS);
  assert.equal(a.runs, 3); assert.equal(a.metrics['a.x'], 0.75); assert.equal(a.min['a.x'], 0.5); assert.equal(a.max['a.x'], 1); assert.equal(a.spread['a.x'], 0.5);
  assert.equal(a.spread['a.y'], 0); assert.ok(!('a.z' in a.metrics), 'always null: no number'); assert.ok(!('a.t' in a.metrics), 'text is not a metric');
  assert.deepEqual([a.metrics['a.w'], a.n['a.w'], a.n['a.x']], [3, 1, 3]);
  assert.deepEqual(a.checks.c1, { pass: 2, fail: 1, skipped: 0, text: 'one' }); assert.deepEqual(a.checks.c2, { pass: 2, fail: 0, skipped: 1, text: 'two' });
  assert.deepEqual(B.aggregate([]), { runs: 0, metrics: {}, min: {}, max: {}, spread: {}, n: {}, checks: {} });
});

test('the saved file: means, spread and how each rail fared, and nothing else (no replies, no keys, no text from a conversation)', () => {
  const f = B.toFile(B.aggregate(RUNS), new Date('2026-10-29T10:00:00Z'));
  assert.deepEqual(Object.keys(f).sort(), ['about', 'checks', 'max', 'metrics', 'min', 'runs', 'spread', 'when']); assert.equal(f.when, '2026-10-29'); assert.equal(f.runs, 3);
  assert.match(f.about, /mean over `runs` full runs/); assert.match(f.about, /Only update after a deliberate improvement/);
  assert.doesNotMatch(JSON.stringify(f), /sk-|Bearer|META_API_KEY/);
  const t = B.table(B.aggregate(RUNS)); assert.match(t, /BASELINE over 3 full runs/); assert.match(t, /a\.x +0\.75 +0\.5 +1 +0\.5/); assert.match(t, /c1 +pass 2 +FAIL 1 +skipped 0/);
});

test('the committed baseline file, once written, is the right shape and its rails all passed in every run it averages', () => {
  const file = B.FILE; if (!fs.existsSync(file)) return;
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(b.runs >= 3, 'a baseline is the average of at least three full runs'); assert.ok(Object.keys(b.metrics).length > 40);
  for (const [k, v] of Object.entries(b.metrics)) { assert.equal(typeof v, 'number', k); assert.ok(b.spread[k] >= 0 && b.min[k] <= v + 1e-9 && v <= b.max[k] + 1e-9, k); }
  for (const [id, c] of Object.entries(b.checks)) assert.equal(c.fail, 0, `the guard rail ${id} failed in a run that went into the baseline`);
  assert.doesNotMatch(JSON.stringify(b), /sk-|Bearer/);
});

test('baseline tool safety: it only reads result files and writes docs/eval/baseline.json', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'eval', 'baseline.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /fetch\(|child_process|process\.env/); assert.deepEqual([...src.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => m[1]), ['FILE']);
});
