// Scam-shield bench (NOT part of `node --test`; the pure statistics are tested in test/scambench.test.js).
// Runs a detector over docs/scam-testset.json with REAL Meta Spark (text only: no voice, no ElevenLabs) and reports hit / false-alarm rates
// with 95% confidence intervals. Usage:
//   node test/scam-bench.js run <results.json> [dev|held|t1|t2|all] [baseline|talk]     run the detector (needs META_API_KEY in .env)
//   node test/scam-bench.js report <results.json>                 print the rates; held-out items are only ever shown as totals
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SET = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scam-testset.json'), 'utf8')).items;

// Wilson 95% interval for k out of n (honest about small samples).
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
const pc = (x) => `${Math.round(x * 100)}%`;
const fmt = (k, n) => { const [a, b] = wilson(k, n); return `${k}/${n} = ${pc(n ? k / n : 0)} (95% CI ${pc(a)}-${pc(b)})`; };
const isWarn = (r) => Boolean(r) && (r.level === 'warn' || r.level === 'pause');

// Rates for a set of items given results by id. Pure.
function summarise(items, byId, filter = () => true) {
  const sc = items.filter((i) => i.label === 'scam' && filter(i)), no = items.filter((i) => i.label === 'normal' && filter(i));
  const k = (list, f) => list.filter((i) => f(byId[i.id])).length;
  return {
    scams: sc.length, normal: no.length,
    warned: k(sc, isWarn), cautioned: k(sc, (r) => r && r.level !== 'none'), falseWarned: k(no, isWarn), falseCautioned: k(no, (r) => r && r.level !== 'none'),
    pauseOnScam: k(sc, (r) => r && r.level === 'pause'), pauseOnNormal: k(no, (r) => r && r.level === 'pause'),
  };
}

async function runWith(detect, outFile, which = 'all') {
  const items = SET().filter((i) => which === 'all' || i.split === which || (which === 't1' && i.tranche === 1) || (which === 't2' && i.tranche === 2));
  const out = []; let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { for (;;) { const i = next++; if (i >= items.length) return; const r = await detect(items[i]); out[i] = { id: items[i].id, ...r }; } }));
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  return out;
}

// The detector under test (second argument to `run`): 'baseline' is the original five-signal prompt read on text; 'talk' is scam.assessText
// (the five signals plus remote access, happening now and about to act, with the pause level decided in code).
async function talkDetect(item) {
  const scam = require('../scam');
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const r = await scam.assessText(item.text); return { level: r.level, count: r.count, signals: r.signals, reads: r.reads }; }
    catch (e) { if (attempt === 2) return { error: e.message, level: 'none', signals: {} }; }
  }
}

// The original detector: today this is the original five-signal prompt (scam.ASK) read on text, the baseline.
async function baselineDetect(item) {
  const brain = require('../brain'); const scam = require('../scam');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(brain.META_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.META_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: brain.liveModel(), messages: [{ role: 'user', content: `${scam.ASK}\n\nTHE MESSAGE (as it reached them, or as they told you about it):\n${item.text}` }], reasoning_effort: 'low', max_completion_tokens: 3000 }), signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const o = scam.parse((await r.json()).choices[0].message.content); if (!o) throw new Error('unusable');
      return { ...scam.levelOf(o.signals), signals: o.signals };
    } catch (e) { if (attempt === 2) return { error: e.message, level: 'none', signals: {} }; }
  }
}

function report(file) {
  const items = SET(); const res = JSON.parse(fs.readFileSync(file, 'utf8')); const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  const have = items.filter((i) => byId[i.id]);
  const line = (label, f) => { const s = summarise(have, byId, f); console.log(`${label}\n  scams warned:            ${fmt(s.warned, s.scams)}\n  scams at least cautioned: ${fmt(s.cautioned, s.scams)}\n  normal wrongly warned:    ${fmt(s.falseWarned, s.normal)}\n  normal wrongly cautioned: ${fmt(s.falseCautioned, s.normal)}`); };
  console.log('errors:', res.filter((r) => r.error).length);
  line('ALL', () => true); line('DEV', (i) => i.split === 'dev'); line('HELD-OUT (totals only)', (i) => i.split === 'held');
  for (const ch of ['text', 'spoken']) line(`channel ${ch}`, (i) => i.channel === ch);
  const hard = (l) => have.filter((i) => i.hard && i.label === l);
  console.log(`hard scams warned: ${fmt(hard('scam').filter((i) => isWarn(byId[i.id])).length, hard('scam').length)} | hard normal wrongly warned: ${fmt(hard('normal').filter((i) => isWarn(byId[i.id])).length, hard('normal').length)}`);
  const now = have.filter((i) => i.now), lp = have.filter((i) => i.legitpay);
  console.log(`in progress warned: ${fmt(now.filter((i) => isWarn(byId[i.id])).length, now.length)} (pause: ${now.filter((i) => byId[i.id].level === 'pause').length}) | genuine payments wrongly warned: ${fmt(lp.filter((i) => isWarn(byId[i.id])).length, lp.length)} (pause: ${lp.filter((i) => byId[i.id].level === 'pause').length})`);
  const pausedOf = (list) => list.filter((i) => byId[i.id].level === 'pause').length;
  const scamsAll = have.filter((i) => i.label === 'scam'), normAll = have.filter((i) => i.label === 'normal');
  const notNow = scamsAll.filter((i) => !i.now), notLegit = normAll.filter((i) => !i.legitpay);
  console.log(`PAUSE  scams in progress paused: ${fmt(pausedOf(now), now.length)} | genuine payments in progress wrongly paused: ${fmt(pausedOf(lp), lp.length)} | other normal wrongly paused: ${fmt(pausedOf(notLegit), notLegit.length)} | other scams paused: ${pausedOf(notNow)}/${notNow.length}`);
  console.log('DEV scams not warned:'); for (const i of have.filter((x) => x.split === 'dev' && x.label === 'scam' && !isWarn(byId[x.id]))) console.log(`  ${i.id} [${i.category}/${i.channel}] ${byId[i.id].level}: ${i.text.slice(0, 90)}`);
  console.log('DEV normal wrongly flagged:'); for (const i of have.filter((x) => x.split === 'dev' && x.label === 'normal' && byId[x.id].level !== 'none')) console.log(`  ${i.id} [${i.category}/${i.channel}] ${byId[i.id].level}: ${i.text.slice(0, 90)}`);
}

// What the live system does: talk only reaches the Spark check if the cheap word filter lets it through; otherwise there is no verdict at all.
// byId: the detector's answers. Returns answers as the whole pipeline would give them (filtered-out items become level 'none').
function throughFilter(items, byId, needsCheck) {
  const out = {};
  for (const i of items) out[i.id] = byId[i.id] ? (needsCheck(i.text) ? byId[i.id] : { ...byId[i.id], level: 'none', filtered: true }) : undefined;
  return out;
}

// The published page for one result file (the detector alone, then the whole pipeline), listing every miss and false alarm by id.
function publishMarkdown(items, byId, baselineById, title) {
  const { needsCheck } = require('../scam');
  const piped = throughFilter(items, byId, needsCheck);
  const rows = (map, label) => {
    const s = summarise(items, map);
    return `| ${label} | ${fmt(s.warned, s.scams)} | ${fmt(s.cautioned, s.scams)} | ${fmt(s.falseWarned, s.normal)} | ${fmt(s.falseCautioned, s.normal)} |`;
  };
  const now = items.filter((i) => i.now), lp = items.filter((i) => i.legitpay);
  const paused = (map, list) => list.filter((i) => map[i.id] && map[i.id].level === 'pause').length;
  const other = (f) => items.filter((i) => f(i) && !i.now && !i.legitpay);
  const L = [`# ${title}`, '', 'Meta Spark, text only, run once on the held-out half of docs/scam-testset.json (never used for tuning). Intervals are 95% Wilson intervals; with this few items they are wide.', '',
    '| detector | scams warned | scams at least cautioned | normal wrongly warned | normal wrongly cautioned |', '|---|---|---|---|---|'];
  if (baselineById) L.push(rows(baselineById, 'Original five-signal prompt (baseline)'));
  L.push(rows(byId, 'New detector alone (six signs, pause level)'), rows(piped, 'New detector behind the cheap word filter (what runs live)'), '');
  L.push('## The pause moment', '', `- Scams in progress paused: detector alone ${fmt(paused(byId, now), now.length)}; behind the filter ${fmt(paused(piped, now), now.length)}.`,
    `- Genuine payments in progress wrongly paused: ${fmt(paused(byId, lp), lp.length)}.`, `- Other normal items wrongly paused: ${fmt(paused(byId, other((i) => i.label === 'normal')), other((i) => i.label === 'normal').length)}.`, '');
  const wrongs = (map, f) => items.filter(f).map((i) => `- ${i.id} [${i.category}/${i.channel}${i.hard ? '/hard' : ''}] ${map[i.id] ? map[i.id].level : 'n/a'}${map[i.id] && map[i.id].filtered ? ' (the word filter did not pass it to Spark)' : ''}: ${i.text}`);
  const orNone = (list) => (list.length ? list : ['- None.']);
  L.push('## Every held-out scam that was not warned (behind the filter)', '', ...orNone(wrongs(piped, (i) => i.label === 'scam' && !isWarn(piped[i.id]))), '');
  L.push('## Every held-out normal item that was wrongly flagged (warned or cautioned, behind the filter)', '', ...orNone(wrongs(piped, (i) => i.label === 'normal' && piped[i.id] && piped[i.id].level !== 'none')), '');
  L.push('## Caveats (please read before quoting any number)', '',
    '- The test set was written by the same team that built the detector, so both halves are ours. Real scams in the wild may be harder, or phrased differently.',
    '- There are only 38 scams and 38 normal items in this half. "0 wrongly warned" can hide a true rate of up to about 9%. The intervals above are the honest range.',
    '- The same family of model reads both the examples and the checks, and the same detector run twice can differ by about two items (identical dev runs gave 36 and 38 of 38).',
    '- Text only. Photos (the vision path) were not measured here.',
    '- Warn accuracy is not meaningfully different from the original five-signal prompt (overlapping intervals). What the new detector adds is the pause moment, coverage of typed and spoken talk, and the remote-access and identity-details reads.',
    '- The cheap word filter that guards the live check let through 36 of 38 held-out scams: about 1 scam description in 20 gets no check and no pause moment, although Maya still replies naturally. A looser filter would check more than half of ordinary chat lines, which costs too much, so it was left as is. The two misses are listed above.',
    '- The held-out half was looked at in totals twice before this run (the original prompt, and the word filter\'s pass rate). Neither led to any change; the detector, the filter and the prompts were frozen before this run.', '');
  return L.join('\n');
}

module.exports = { wilson, fmt, summarise, isWarn, runWith, throughFilter, publishMarkdown };

if (require.main === module) {
  const [cmd, file, which] = process.argv.slice(2);
  if (cmd === 'run') {
    try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }
    runWith(process.argv[5] === 'talk' ? talkDetect : baselineDetect, file, which || 'all').then((o) => console.log('done', o.length, 'items,', o.filter((x) => x.error).length, 'errors'));
  } else if (cmd === 'report') report(file);
  else if (cmd === 'publish') {   // node test/scam-bench.js publish <held-results.json> <out.md> [baseline-held.json]
    const held = SET().filter((i) => i.split === 'held');
    const by = (f) => Object.fromEntries(JSON.parse(fs.readFileSync(f, 'utf8')).map((r) => [r.id, r]));
    const base = process.argv[5] ? by(process.argv[5]) : null;
    fs.writeFileSync(which, publishMarkdown(held, by(file), base, 'Scam shield: final held-out results'));
    console.log('wrote', which);
  }
  else if (cmd !== 'publish') console.log('usage: node test/scam-bench.js run <results.json> [dev|held|t1|t2|all] [baseline|talk] | report <results.json> | publish <held.json> <out.md> [baseline.json]');
}
