// Trend simulation bench (NOT part of `node --test`; test/trendsim.test.js runs a smaller fixed version of it).
// Deterministic seeded 50-day timelines of daily numbers: ordinary life (bad days, visits, short colds) and slow declines. It measures what the
// judges care about: how many days until a real drift is noticed, and how often ordinary life is wrongly flagged.
// Run: node test/trend-sim.js [normalCount] [declineCount]
const T = require('../trends');

const DAYS = 50, ONSET = 25, RAMP = 5;
const START = '2026-09-01';

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const poisson = (r, lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; };
const binom = (r, n, p) => { let k = 0; for (let i = 0; i < n; i++) if (r() < p) k++; return k; };

// A person's usual: varies a lot between people.
function person(r) {
  return { turns: 8 + r() * 12, sd: 2 + r() * 3, heavyP: 0.03 + r() * 0.12, pain: 0.05 + r() * 0.35, missedP: 0.02 + r() * 0.08, callbacks: 0.05 + r() * 0.15, first: 480 + r() * 180, firstSd: 45 + r() * 30, noContactP: 0.02 + r() * 0.04 };
}

function genDay(r, date, p) {
  if (r() < p.noContactP) return T.blank(date);
  const turns = Math.max(0, Math.round(p.turns + p.sd * gauss(r)));
  const heavy = binom(r, turns, Math.min(0.95, Math.max(0, p.heavyP)));
  return { date, calls: Math.max(1, Math.ceil(turns / 8)), turns, heavy, maxIntensity: heavy ? 3 : 1, pain: poisson(r, Math.max(0, p.pain)), concerns: 0, remindersDue: 2, remindersMissed: binom(r, 2, Math.min(1, Math.max(0, p.missedP))), callbacks: poisson(r, Math.max(0, p.callbacks)), firstMin: Math.max(0, Math.min(1439, Math.round(p.first + p.firstSd * gauss(r)))) };
}

// Each scenario returns the parameter changes at full effect (a drift ramps in over RAMP days from ONSET).
const DECLINES = {
  lonelyDrift:  (p) => ({ ...p, heavyP: p.heavyP + 0.30, turns: p.turns * 0.6, first: p.first + 75 }),
  risingPain:   (p) => ({ ...p, pain: p.pain + 1.3, turns: p.turns * 0.85 }),
  missedMeds:   (p) => ({ ...p, missedP: 0.6, callbacks: p.callbacks + 0.7, turns: p.turns * 0.7 }),
  withdrawal:   (p) => ({ ...p, turns: p.turns * 0.25, callbacks: p.callbacks + 0.5, noContactP: p.noContactP + 0.2 }),
  moodOnly:     (p) => ({ ...p, heavyP: p.heavyP + 0.28 }),
};
const mix = (a, b, w) => { const o = {}; for (const k of Object.keys(a)) o[k] = a[k] + (b[k] - a[k]) * w; return o; };

// Ordinary-life disturbances that must NOT be flagged: a bad day, a busy visit, a short (two-day) cold.
function ordinaryEvents(r) {
  const ev = [];
  if (r() < 0.6) ev.push({ at: 14 + Math.floor(r() * 34), len: 1, f: (p) => ({ ...p, heavyP: p.heavyP + 0.3, turns: p.turns * 0.6 }) });
  if (r() < 0.5) ev.push({ at: 14 + Math.floor(r() * 34), len: 2, f: (p) => ({ ...p, turns: p.turns * 1.4 }) });
  if (r() < 0.5) ev.push({ at: 14 + Math.floor(r() * 33), len: 2, f: (p) => ({ ...p, pain: p.pain + 1.2, turns: p.turns * 0.7 }) });
  return ev;
}

function timeline(seed, kind) {
  const r = rng(seed);
  const base = person(r);
  const events = kind === 'ordinary' ? ordinaryEvents(r) : kind === 'cold3' ? [{ at: 30, len: 3, f: (p) => ({ ...p, pain: p.pain + 1.2, turns: p.turns * 0.65 }) }] : [];
  const days = [];
  for (let i = 0; i < DAYS; i++) {
    let p = base;
    if (DECLINES[kind] && i >= ONSET) p = mix(base, DECLINES[kind](base), Math.min(1, (i - ONSET + 1) / RAMP));
    for (const e of events) if (i >= e.at && i < e.at + e.len) p = e.f(p);
    days.push(genDay(r, T.addDays(START, i), p));
  }
  return days;
}

// Runs the evaluator day by day (as the live app would) and returns the status for each day.
function statuses(days) {
  let prev = null; const out = [];
  for (let i = 0; i < days.length; i++) {
    const res = T.evaluate(days.slice(0, i + 1), days[i].date, prev);
    prev = res; out.push(res.status);
  }
  return out;
}

function runKind(kind, count, seed0) {
  const rows = [];
  for (let s = 0; s < count; s++) {
    const st = statuses(timeline(seed0 + s, kind));
    const raised = (x) => x === 'watch' || x === 'notable';
    const firstAfter = st.findIndex((x, i) => i >= ONSET && raised(x));
    rows.push({ falseAlarm: st.some((x, i) => i < ONSET && raised(x)) || (!DECLINES[kind] && st.some(raised)), raisedDays: st.filter(raised).length, delay: firstAfter < 0 ? null : firstAfter - ONSET, notable: st.some((x, i) => i >= ONSET && x === 'notable') });
  }
  return rows;
}

function summarise(kind, rows) {
  const n = rows.length;
  if (DECLINES[kind]) {
    const hit = rows.filter((x) => x.delay != null && x.delay <= 14), d = hit.map((x) => x.delay).sort((a, b) => a - b);
    return { kind, n, detected14: hit.length / n, medianDelay: d.length ? d[d.length >> 1] : null, p90Delay: d.length ? d[Math.floor(d.length * 0.9)] : null, before: rows.filter((x) => x.falseAlarm).length / n };
  }
  return { kind, n, falseAlarms: rows.filter((x) => x.falseAlarm).length / n, alarmDaysPerTimeline: rows.reduce((a, x) => a + x.raisedDays, 0) / n };
}

// The seeds below were never used while the rules were tuned (tuning used 1000-5000 and 20000-24000), so these numbers are held-out.
function bench({ normal = 300, decline = 150 } = {}) {
  const out = { quiet: summarise('quiet', runKind('quiet', normal, 60000)), ordinary: summarise('ordinary', runKind('ordinary', normal, 70000)), cold3: summarise('cold3', runKind('cold3', normal, 75000)) };
  let seed = 80000;
  for (const k of Object.keys(DECLINES)) { out[k] = summarise(k, runKind(k, decline, seed)); seed += 1000; }
  return out;
}

module.exports = { DAYS, ONSET, RAMP, rng, person, genDay, timeline, statuses, runKind, summarise, bench, DECLINES };

if (require.main === module) {
  const res = bench({ normal: Number(process.argv[2]) || 300, decline: Number(process.argv[3]) || 150 });
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  console.log('no events at all (pure day-to-day noise):', `${pc(res.quiet.falseAlarms)} of timelines wrongly flagged`);
  console.log('ordinary life (bad days, visits, 2-day colds):', `${pc(res.ordinary.falseAlarms)} of timelines wrongly flagged; ${res.ordinary.alarmDaysPerTimeline.toFixed(2)} flagged days per timeline`);
  console.log('3-day cold (harder case):', `${pc(res.cold3.falseAlarms)} flagged; ${res.cold3.alarmDaysPerTimeline.toFixed(2)} flagged days per timeline`);
  for (const k of Object.keys(DECLINES)) { const r = res[k]; console.log(k.padEnd(12), `noticed within 14 days: ${pc(r.detected14)}; median delay ${r.medianDelay} days; 90th pct ${r.p90Delay}; flagged before the drift began: ${pc(r.before)}`); }
}
