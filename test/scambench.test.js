// The bench's statistics are pure and tested here; the real-Spark runs are done by `node test/scam-bench.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('./scam-bench');

test('wilson interval: known values, always inside 0..1, wider for fewer items, and honest at 0 and n', () => {
  const [a, b] = B.wilson(50, 100); assert.ok(Math.abs(a - 0.404) < 0.002 && Math.abs(b - 0.596) < 0.002, `${a} ${b}`);
  const [z0, z1] = B.wilson(0, 28); assert.equal(z0, 0); assert.ok(z1 > 0.1 && z1 < 0.14, 'zero misses out of 28 can still hide a rate near 12%');
  const [n0, n1] = B.wilson(28, 28); assert.equal(n1, 1); assert.ok(n0 > 0.85 && n0 < 0.9);
  assert.deepEqual(B.wilson(0, 0), [0, 0]);
  const w = (k, n) => { const [x, y] = B.wilson(k, n); return y - x; };
  assert.ok(w(5, 10) > w(50, 100) && w(50, 100) > w(500, 1000));
});

test('summarise: counts warned / cautioned / pause on scams and normal separately, and respects the filter', () => {
  const items = [{ id: 'a', label: 'scam', split: 'dev' }, { id: 'b', label: 'scam', split: 'dev' }, { id: 'c', label: 'scam', split: 'held' }, { id: 'd', label: 'normal', split: 'dev' }, { id: 'e', label: 'normal', split: 'held' }];
  const by = { a: { level: 'warn' }, b: { level: 'caution' }, c: { level: 'pause' }, d: { level: 'caution' }, e: { level: 'warn' } };
  assert.deepEqual(B.summarise(items, by), { scams: 3, normal: 2, warned: 2, cautioned: 3, falseWarned: 1, falseCautioned: 2, pauseOnScam: 1, pauseOnNormal: 0 });
  assert.deepEqual(B.summarise(items, by, (i) => i.split === 'dev'), { scams: 2, normal: 1, warned: 1, cautioned: 2, falseWarned: 0, falseCautioned: 1, pauseOnScam: 0, pauseOnNormal: 0 });
  assert.equal(B.isWarn({ level: 'pause' }), true); assert.equal(B.isWarn({ level: 'caution' }), false); assert.equal(B.isWarn(undefined), false);
  assert.equal(B.fmt(1, 4), '1/4 = 25% (95% CI 5%-70%)');
});

test('the bench never touches ElevenLabs or any voice', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'scam-bench.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /elevenlabs|streamSpeech|ELEVEN/i);
});
