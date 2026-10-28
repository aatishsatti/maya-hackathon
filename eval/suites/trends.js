// Trends suite (#2): the deterministic simulation on held-out seeds (test/trend-sim.js). No Meta calls, no files, no network.
async function run() {
  const S = require('../../test/trend-sim');
  const r = S.bench({ normal: 150, decline: 80 });
  const kinds = Object.keys(S.DECLINES);
  const metrics = { falseAlarmQuiet: r.quiet.falseAlarms, falseAlarmOrdinary: r.ordinary.falseAlarms, falseAlarmCold3: r.cold3.falseAlarms, detectionMean: kinds.reduce((a, k) => a + r[k].detected14, 0) / kinds.length };
  for (const k of kinds) { metrics[`detected_${k}`] = r[k].detected14; metrics[`medianDelay_${k}`] = r[k].medianDelay; }
  return { metrics, details: r };
}
module.exports = { name: 'trends', run };
