#!/usr/bin/env node
// The saved baseline of the Maya evaluation: the AVERAGE of several full runs, plus how far the runs differed from each other (the run-to-run noise),
// which is what tells a real regression from bad luck. Meta's answers vary a little every time, so a single run is never "the" number.
//   node eval/baseline.js eval-results/run-1.json eval-results/run-2.json ... [--write]
// Prints, for every metric, the mean / lowest / highest across the runs and, for every guard rail, in how many runs it passed. --write saves
// docs/eval/baseline.json (only after a deliberate improvement: never to hide a regression).
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs', 'eval', 'baseline.json');

// runs: [{ metrics:{key:number|null}, checks:[{id,status}] }]. Pure.
function aggregate(runs) {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics || {})))].sort();
  const metrics = {}, min = {}, max = {}, spread = {}, n = {};
  for (const k of keys) {
    const v = runs.map((r) => (r.metrics || {})[k]).filter((x) => typeof x === 'number' && Number.isFinite(x));
    if (!v.length) continue;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    metrics[k] = mean; min[k] = Math.min(...v); max[k] = Math.max(...v); spread[k] = max[k] - min[k]; n[k] = v.length;
  }
  const checks = {};
  for (const r of runs) for (const c of r.checks || []) { const t = checks[c.id] || (checks[c.id] = { pass: 0, fail: 0, skipped: 0, text: c.text }); if (c.status === 'pass') t.pass += 1; else if (c.status === 'FAIL') t.fail += 1; else t.skipped += 1; }
  return { runs: runs.length, metrics, min, max, spread, n, checks };
}

// The file that is saved and committed: means (what later runs are compared with) and the spread seen between runs. No replies, no keys, no text.
function toFile(agg, when = new Date()) {
  return { about: 'Saved baseline of the Maya evaluation (rates 0..1; times in ms). metrics = the mean over `runs` full runs (each run itself has 2 repeats); spread = highest minus lowest seen between those runs, the run-to-run noise. Written by `node eval/baseline.js ... --write`. Only update after a deliberate improvement.', when: when.toISOString().slice(0, 10), runs: agg.runs, metrics: agg.metrics, spread: agg.spread, min: agg.min, max: agg.max, checks: agg.checks };
}

const r3 = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 1000) / 1000);
function table(agg) {
  const L = [`BASELINE over ${agg.runs} full runs`, '', `  ${'metric'.padEnd(36)} ${'mean'.padEnd(9)} ${'lowest'.padEnd(9)} ${'highest'.padEnd(9)} spread`];
  for (const k of Object.keys(agg.metrics)) L.push(`  ${k.padEnd(36)} ${String(r3(agg.metrics[k])).padEnd(9)} ${String(r3(agg.min[k])).padEnd(9)} ${String(r3(agg.max[k])).padEnd(9)} ${r3(agg.spread[k])}`);
  L.push('', 'GUARD RAILS: in how many runs each passed');
  for (const [id, c] of Object.entries(agg.checks)) L.push(`  ${id.padEnd(18)} pass ${c.pass}  FAIL ${c.fail}  skipped ${c.skipped}   ${c.text}`);
  return L.join('\n');
}

module.exports = { aggregate, toFile, table, FILE };

if (require.main === module) {
  const args = process.argv.slice(2), files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node eval/baseline.js <result.json>... [--write]'); process.exit(2); }
  const runs = files.map((f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')));
  const agg = aggregate(runs);
  console.log(table(agg));
  if (args.includes('--write')) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(toFile(agg), null, 1) + '\n'); console.log(`\nwritten: ${path.relative(ROOT, FILE)}`); }
}
