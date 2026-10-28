// Trend simulation (fixed, deterministic, held-out seeds; the larger bench is `node test/trend-sim.js`). If a change to the rules makes them
// miss real drifts or flag ordinary life, this fails. Thresholds sit a little looser than what was measured on exactly these seeds.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./trend-sim');

const res = S.bench({ normal: 150, decline: 80 });
const pc = (x) => `${(x * 100).toFixed(1)}%`;

test('simulation: ordinary life is almost never flagged (pure noise, bad days, visits, short colds)', () => {
  assert.ok(res.quiet.falseAlarms <= 0.03, `noise only: ${pc(res.quiet.falseAlarms)}`);
  assert.ok(res.ordinary.falseAlarms <= 0.04, `ordinary life: ${pc(res.ordinary.falseAlarms)}`);
  assert.ok(res.ordinary.alarmDaysPerTimeline <= 0.15, `flagged days per ordinary timeline: ${res.ordinary.alarmDaysPerTimeline}`);
  assert.ok(res.cold3.falseAlarms <= 0.12, `a 3-day cold (the hard case): ${pc(res.cold3.falseAlarms)}`);
});

test('simulation: real slow drifts are noticed within two weeks of starting, with a median delay under ten days', () => {
  for (const k of Object.keys(S.DECLINES)) {
    const r = res[k];
    const floor = k === 'risingPain' ? 0.5 : 0.75;   // rare-event counts are the hardest to be sure about
    assert.ok(r.detected14 >= floor, `${k}: noticed within 14 days ${pc(r.detected14)}`);
    assert.ok(r.medianDelay != null && r.medianDelay <= 10, `${k}: median delay ${r.medianDelay}`);
    assert.ok(r.before <= 0.05, `${k}: flagged before the drift began ${pc(r.before)}`);
  }
  const mean = Object.keys(S.DECLINES).reduce((a, k) => a + res[k].detected14, 0) / Object.keys(S.DECLINES).length;
  assert.ok(mean >= 0.72, `mean detection ${pc(mean)}`);
});

test('simulation is deterministic: the same seed gives the same timeline and the same answers', () => {
  const a = S.statuses(S.timeline(81234, 'lonelyDrift')), b = S.statuses(S.timeline(81234, 'lonelyDrift'));
  assert.deepEqual(a, b); assert.notDeepEqual(S.timeline(1, 'ordinary'), S.timeline(2, 'ordinary'));
  assert.equal(a.length, S.DAYS); assert.ok(a.slice(0, 18).every((s) => s === 'learning'), 'the first 18 days are learning only'); assert.notEqual(a[18], 'learning', 'and the 19th day is the first that can be judged');
});
