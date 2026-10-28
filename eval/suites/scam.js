// Scam suite (#4): the DEV half of docs/scam-testset.json (never the held-out half) through the real detector (scam.assessText), plus the word-filter
// numbers (offline). It also measures the detector at two reasoning settings (the live one, 'low', and 'minimal'): rates, speed and tokens, side by side,
// MEASUREMENT ONLY: nothing live changes. Real Meta Spark, text only.
const fs = require('node:fs');
const path = require('node:path');
const C = require('./common');
const score = require('../score');

const SET = () => JSON.parse(fs.readFileSync(path.join(C.ROOT, 'docs', 'scam-testset.json'), 'utf8')).items;
const CHAT = () => JSON.parse(fs.readFileSync(path.join(C.ROOT, 'docs', 'ordinary-chat-lines.json'), 'utf8')).lines;
const SETTINGS = ['low', 'minimal'];   // 'low' is what runs live today

async function detect(scam, item, reasoning) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const r = await scam.assessText(item.text, undefined, { reasoning }); return { level: r.level, count: r.count }; }
    catch (e) { if (attempt === 2) return { level: 'none', error: e.message }; }
  }
}

async function run({ runs = 2, limit = null, settings = SETTINGS } = {}) {
  const meta = require(path.join(C.ROOT, 'meta')); const scam = require(path.join(C.ROOT, 'scam'));
  let items = SET().filter((i) => i.split === 'dev');
  if (limit) items = [...items.filter((i) => i.label === 'scam').slice(0, limit), ...items.filter((i) => i.label === 'normal').slice(0, limit)];
  const per = {};
  for (const setting of settings) {
    per[setting] = [];
    for (let r = 0; r < (limit ? 1 : runs); r++) {
      meta.reset();
      const res = await C.pool(4, items, (it) => detect(scam, it, setting));
      const byId = Object.fromEntries(items.map((it, i) => [it.id, res[i]]));
      per[setting].push({ ...score.scamMetrics(items, byId), cost: score.costMetrics(meta.snapshot().filter((x) => x.purpose === 'scam-text')), errors: res.filter((x) => x.error).length });
    }
  }
  const avg = (setting, f) => score.mean(per[setting].map(f));
  const metrics = {};
  for (const k of ['warned', 'cautioned', 'falseWarn', 'falseCaution', 'pauseInProgress', 'falsePauseGenuine', 'falsePauseOther']) metrics[k] = avg('low', (x) => x[k] ?? 0);
  for (const setting of settings) for (const k of ['warned', 'falseWarn', 'pauseInProgress']) metrics[`${setting}_${k}`] = avg(setting, (x) => x[k] ?? 0);
  for (const setting of settings) { metrics[`${setting}_avgMs`] = avg(setting, (x) => x.cost.avgMs); metrics[`${setting}_p90Ms`] = avg(setting, (x) => x.cost.p90Ms ?? 0); metrics[`${setting}_tokensOut`] = avg(setting, (x) => x.cost.avgTokensOut); metrics[`${setting}_tokensIn`] = avg(setting, (x) => x.cost.avgTokensIn); }
  // the cheap word filter (offline, deterministic)
  const devScams = SET().filter((i) => i.split === 'dev' && i.label === 'scam'), lines = CHAT();
  metrics.filterRecallDev = devScams.filter((i) => scam.needsCheck(i.text)).length / devScams.length;
  metrics.ordinaryTrigger = lines.filter(scam.needsCheck).length / lines.length;
  return { metrics, details: { per } };
}
module.exports = { name: 'scam', run, SETTINGS };
