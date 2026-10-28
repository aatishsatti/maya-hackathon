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

test('throughFilter: an item the word filter does not pass has no verdict at all; one it passes keeps the detector\'s answer', () => {
  const items = [{ id: 'a', text: 'passes' }, { id: 'b', text: 'blocked' }];
  const by = { a: { level: 'warn' }, b: { level: 'pause' } };
  const out = B.throughFilter(items, by, (t) => t === 'passes');
  assert.equal(out.a.level, 'warn'); assert.equal(out.b.level, 'none'); assert.equal(out.b.filtered, true); assert.equal(by.b.level, 'pause', 'the input is not changed');
});

test('publishMarkdown: both views, the pause numbers, and every held-out miss and false alarm listed by id (the held-out half is published once, at the end)', () => {
  const items = [
    { id: 'S1', label: 'scam', category: 'bank', channel: 'text', text: 'urgent please send the gift cards and the code now', now: true },
    { id: 'S2', label: 'scam', category: 'prize', channel: 'text', text: 'a quiet one' },
    { id: 'N1', label: 'normal', category: 'bill', channel: 'text', text: 'Your bill is due, pay at the bank by Friday.', hard: true },
    { id: 'N2', label: 'normal', category: 'bill', channel: 'spoken', text: 'I paid the milkman.', legitpay: true },
  ];
  const by = { S1: { level: 'pause' }, S2: { level: 'caution' }, N1: { level: 'caution' }, N2: { level: 'none' } };
  const md = B.publishMarkdown(items, by, { S1: { level: 'warn' }, S2: { level: 'none' }, N1: { level: 'none' }, N2: { level: 'none' } }, 'T');
  assert.match(md, /^# T/); assert.match(md, /Original five-signal prompt \(baseline\)/); assert.match(md, /behind the cheap word filter/);
  assert.match(md, /Scams in progress paused: detector alone 1\/1/);
  assert.match(md, /- S2 \[prize\/text\] (caution|none)/); assert.doesNotMatch(md, /- S1 \[/, 'a warned scam is not listed as a miss');
  assert.match(md, /- N1 \[bill\/text\/hard\] caution/); assert.doesNotMatch(md, /- N2 \[/);
  const calm = B.publishMarkdown([{ id: 'S9', label: 'scam', category: 'x', channel: 'text', text: 'urgent gift cards and a code, please send now' }], { S9: { level: 'warn' } }, null, 'T2');
  assert.equal((calm.match(/- None\./g) || []).length, 2, 'an empty list says None, not nothing');
  assert.match(md, /## Caveats/); assert.match(md, /written by the same team that built the detector/); assert.match(md, /1 scam description in 20 gets no check/); assert.match(md, /frozen before this run/);
});

test('publishComparison: both runs side by side, the change stated first, every miss of every run listed, nothing hidden', () => {
  const items = [
    { id: 'S1', label: 'scam', category: 'bank', channel: 'text', text: 'urgent please send the gift cards and the code now', now: true },
    { id: 'S2', label: 'scam', category: 'invoice', channel: 'text', hard: true, text: 'Our bank details have changed so please pay the invoice to the new account with the code' },
    { id: 'N1', label: 'normal', category: 'bill', channel: 'text', text: 'Your bill is due, pay at the bank by Friday.' },
  ];
  const lo = { S1: { level: 'pause' }, S2: { level: 'warn' }, N1: { level: 'none' } }, mi = { S1: { level: 'pause' }, S2: { level: 'caution' }, N1: { level: 'none' } };
  const md = B.publishComparison(items, [{ label: 'Reasoning "low"', byId: lo }, { label: 'Reasoning "minimal" (live now)', byId: mi }], null, 'Both', 'The setting was changed from low to minimal.');
  assert.match(md, /^# Both/); assert.match(md, /\*\*Change, stated openly:\*\* The setting was changed from low to minimal\./);
  assert.match(md, /Reasoning "low": detector alone \| 2\/2 = 100%/); assert.match(md, /Reasoning "minimal" \(live now\): detector alone \| 1\/2 = 50%/);
  assert.match(md, /## Reasoning "minimal" \(live now\): every held-out scam that was not warned[^\n]*\n\n- S2 \[invoice\/text\/hard\] caution/);
  assert.match(md, /## Reasoning "low": every held-out scam that was not warned[^\n]*\n\n- None\./, 'a run with no misses says None');
  assert.match(md, /held-out half has now been run twice with the full detector/); assert.ok(md.indexOf('Change, stated openly') < md.indexOf('| detector |'), 'the change comes before any number');
});
