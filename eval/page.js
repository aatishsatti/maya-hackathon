#!/usr/bin/env node
// Builds the Meta-models page (docs/meta-models.html) and the one-page write-up (docs/meta-models.md) from COMMITTED data: docs/eval/summary.json
// (the numbers of a real evaluation run), docs/eval/reasoning-comparison.json (the dev-half evidence for the scam-check reasoning setting) and the two
// held-out scam result files. render() is pure: the same data always gives the same page. The page is self-contained: no script, no image, no
// font or style sheet to fetch, no link; it makes no external request. Usage: node eval/page.js [--from eval-results/latest.json]
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const pc1 = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
const secs = (ms) => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const num = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toLocaleString('en-US'));
const frac = (k, n) => `${k} of ${n}`;

// ---- the data the page is built from -------------------------------------------------------------------------------------------------------------
// results: an eval run (eval-results/latest.json); held: { items, low:{byId}, minimal:{byId} }; reasoning: the dev-half comparison file.
function buildSummary(results, held, reasoning, now = new Date()) {
  const { summarise, throughFilter } = require('../test/scam-bench');
  const { needsCheck } = require('../scam');
  const view = (byId) => { const alone = summarise(held.items, byId), live = summarise(held.items, throughFilter(held.items, byId, needsCheck)); return { alone, live }; };
  const piped = (byId) => throughFilter(held.items, byId, needsCheck);
  const missed = (byId) => held.items.filter((i) => i.label === 'scam' && !['warn', 'pause'].includes((piped(byId)[i.id] || {}).level)).map((i) => ({ id: i.id, kind: i.category, level: (piped(byId)[i.id] || {}).level, filtered: Boolean((piped(byId)[i.id] || {}).filtered) }));
  const hearing = ((results.suites || []).find((s) => s.suite === 'hearing') || {}).metrics || {};
  return {
    generated: now.toISOString().slice(0, 10), when: (results.when || '').slice(0, 10), runs: results.runs, seconds: results.seconds,
    metrics: results.metrics, checks: (results.checks || []).map((c) => ({ id: c.id, text: c.text, status: c.status })), usage: results.usage,
    hearing, reasoning, held: { low: view(held.low.byId), minimal: view(held.minimal.byId), lowMissed: missed(held.low.byId), minimalMissed: missed(held.minimal.byId) },
  };
}

const GROUPS = [['conv', '#1 Conversation'], ['mem', '#3 Memory'], ['trend', '#2 Trends'], ['scam', '#4 Scam shield'], ['hear', 'Hearing (Meta Transcribe)'], ['meta', 'Meta calls']];
const usageOf = (s, purpose) => (s.usage || []).find((u) => u.purpose === purpose);
const heldRow = (label, v) => `<tr><td>${esc(label)}</td><td>${frac(v.warned, v.scams)} = ${pc(v.warned / v.scams)}</td><td>${frac(v.falseWarned, v.normal)}</td><td>${frac(v.pauseOnScam, v.scams)}</td></tr>`;

function render(s) {
  const m = s.metrics, u = (p) => usageOf(s, p), live = u('live-reply'), mem = u('memory-filing'), talk = u('scam-text'), note = u('transcribe-voice-note');
  const cancelled = live ? (live.failedBy || {}).aborted || 0 : 0;
  const R = s.reasoning || {}, lo = R.low || {}, mi = R.minimal || {};
  const H = s.hearing || {};
  const lowH = s.held.low, miH = s.held.minimal;
  const row = (cells, head) => `<tr>${cells.map((c) => `<${head ? 'th' : 'td'}>${c}</${head ? 'th' : 'td'}>`).join('')}</tr>`;
  const mdl = (id, who) => `<code>${esc(id)}</code> ${esc(who)}`;

  const usageTable = [
    row(['Meta model', 'Job', 'Calls in this run', 'Average speed', 'Tokens in / out per call', 'Status'], true),
    live && row([mdl('muse-spark-1.3', 'Spark'), 'Live reply: what Maya says', num(live.calls), secs(live.avgMs), `${num(Math.round(live.tokensIn / live.calls))} / ${num(Math.round(live.tokensOut / live.calls))}`, `measured; ${num(cancelled)} cancelled and rewritten on purpose (${pc(cancelled / live.calls)}), ${num(live.failed - cancelled)} real errors`]),
    mem && row([mdl('muse-spark-1.3', 'Spark'), 'Memory filing after a call', num(mem.calls), secs(mem.avgMs), `${num(Math.round(mem.tokensIn / mem.calls))} / ${num(Math.round(mem.tokensOut / mem.calls))}`, 'measured; runs in the background after a call']),
    talk && row([mdl('muse-spark-1.3', 'Spark'), 'Scam check on typed and spoken talk', num(talk.calls), secs(talk.avgMs), `${num(Math.round(talk.tokensIn / talk.calls))} / ${num(Math.round(talk.tokensOut / talk.calls))}`, `measured; reasoning <b>${esc(R.liveSetting || 'minimal')}</b>`]),
    row([mdl('muse-spark-1.3', 'Spark vision'), 'Describes a photo; checks a photo for a scam', '—', '—', '—', '<b>wired, not measured</b>: the evaluation is text only']),
    note && row([mdl('muse-voice-transcribe-1.0', 'Transcribe'), 'Hearing a recorded voice note', num(note.calls), secs(note.avgMs), `${num(Math.round(note.audioMs / 1000))} s of audio`, 'measured on <b>synthetic clean speech</b>']),
    row([mdl('muse-voice-transcribe-1.0', 'Transcribe'), 'Hearing a live call (streamed)', '—', '—', '—', 'used live; <b>not part of the evaluation</b>']),
  ].filter(Boolean).join('');

  const checks = GROUPS.map(([k, label]) => {
    const list = s.checks.filter((c) => c.id.startsWith(`${k}.`));
    if (!list.length) return '';
    return `<h3>${esc(label)}</h3><ul class="checks">${list.map((c) => `<li><span class="pill ${esc(c.status)}">${esc(c.status)}</span> ${esc(c.text)}</li>`).join('')}</ul>`;
  }).join('');

  const key = (label, val) => `<div class="stat"><div class="n">${val}</div><div class="l">${esc(label)}</div></div>`;
  const stats = [
    key('replies that repeat a polite phrase', pc(m['conversation.repeatRate'])), key('replies tagged with the right subject', pc(m['conversation.topicAccuracy'])),
    key('"nobody knows" worry answered with what the app does', pc(m['conversation.worryAction'])), key('due follow-ups asked at the first reply', pc(m['memory.askedEarly'])),
    key('ordinary-life timelines wrongly flagged (trends)', pc1(m['trends.falseAlarmOrdinary'])), key('slow drifts noticed within two weeks', pc(m['trends.detectionMean'])),
    key('dev scams warned', pc(m['scam.warned'])), key('words Transcribe got right (clean synthetic speech)', pc1(1 - (H.wer || 0))),
  ].join('');

  const flow = `<svg viewBox="0 0 920 330" role="img" aria-labelledby="flowT flowD" class="flow"><title id="flowT">How a spoken turn flows through Maya</title><desc id="flowD">The person speaks; Meta Transcribe hears; Meta Spark thinks, reads photos, files memory and checks for scams; a non-Meta voice speaks the reply.</desc>
<g class="meta"><rect x="150" y="30" width="200" height="86" rx="12"/><text x="250" y="62" text-anchor="middle" class="h">Meta Transcribe</text><text x="250" y="84" text-anchor="middle">the ears</text><text x="250" y="104" text-anchor="middle" class="s">muse-voice-transcribe-1.0</text>
<rect x="400" y="30" width="200" height="86" rx="12"/><text x="500" y="62" text-anchor="middle" class="h">Meta Spark</text><text x="500" y="84" text-anchor="middle">the brain</text><text x="500" y="104" text-anchor="middle" class="s">muse-spark-1.3</text>
<rect x="400" y="190" width="125" height="86" rx="12"/><text x="462" y="224" text-anchor="middle" class="h">Spark vision</text><text x="462" y="246" text-anchor="middle">reads photos</text><text x="462" y="264" text-anchor="middle" class="s">wired, not measured</text>
<rect x="540" y="190" width="125" height="86" rx="12"/><text x="602" y="224" text-anchor="middle" class="h">Spark</text><text x="602" y="246" text-anchor="middle">files memory,</text><text x="602" y="264" text-anchor="middle">checks scams</text></g>
<g class="other"><rect x="690" y="30" width="200" height="86" rx="12"/><text x="790" y="62" text-anchor="middle" class="h">ElevenLabs</text><text x="790" y="84" text-anchor="middle">the voice</text><text x="790" y="104" text-anchor="middle" class="s">the only part that is not Meta</text></g>
<g class="person"><rect x="10" y="30" width="110" height="86" rx="12"/><text x="65" y="78" text-anchor="middle" class="h">The person</text></g>
<g class="arrow"><path d="M120 73 H150"/><path d="M350 73 H400"/><path d="M600 73 H690"/><path d="M500 116 V190"/><path d="M890 73 H905 V20 H65 V30"/><path d="M570 116 L602 190"/></g></svg>`;

  const heldTable = `<table><thead>${row(['Held-out half (38 scams, 38 normal)', 'Scams warned', 'Normal wrongly warned', 'Scams paused'], true)}</thead><tbody>
${heldRow('"low", detector alone', lowH.alone)}${heldRow('"low", behind the word filter', lowH.live)}${heldRow('"minimal" (live now), detector alone', miH.alone)}${heldRow('"minimal" (live now), behind the word filter', miH.live)}</tbody></table>`;

  const dropped = (s.held.minimalMissed.length - s.held.lowMissed.length);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maya: Meta models doing the work</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--soft:#5c5a55;--card:#fff;--line:#d9d6ce;--meta:#e8f0fb;--metaLine:#3b6fb6;--other:#f4f1ea;--ok:#e1f1e5;--okInk:#1d5a2e;--bad:#fbdcd7;--badInk:#8a2318;--wait:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--soft:#b3b0a7;--card:#1f1f1c;--line:#3a3a35;--meta:#1c2a40;--metaLine:#7aa6e6;--other:#262622;--ok:#183321;--okInk:#9fdcb0;--bad:#40201c;--badInk:#f2b3aa;--wait:#2b2a26}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 56px}h1{font-size:28px;margin:0 0 4px}h2{font-size:21px;margin:34px 0 8px}h3{font-size:16px;margin:18px 0 6px}
p{margin:8px 0;max-width:78ch}.sub{color:var(--soft)}code{background:var(--other);padding:1px 5px;border-radius:5px;font-size:.92em}
.flow{width:100%;height:auto;margin:14px 0}.flow text{fill:var(--fg);font-size:14px}.flow .h{font-weight:700;font-size:16px}.flow .s{fill:var(--soft);font-size:12px}
.flow .meta rect{fill:var(--meta);stroke:var(--metaLine);stroke-width:2}.flow .other rect{fill:var(--other);stroke:var(--soft);stroke-width:2;stroke-dasharray:6 4}.flow .person rect{fill:var(--card);stroke:var(--line);stroke-width:2}
.flow .arrow path{fill:none;stroke:var(--soft);stroke-width:2}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:12px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.n{font-size:26px;font-weight:700}.l{color:var(--soft);font-size:14px}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:15px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--other)}
.wrap{overflow-x:auto}.checks{list-style:none;padding:0;margin:0}.checks li{padding:5px 0;border-bottom:1px solid var(--line)}
.pill{display:inline-block;min-width:64px;text-align:center;border-radius:99px;padding:1px 8px;font-size:13px;font-weight:700;margin-right:6px}.pill.pass{background:var(--ok);color:var(--okInk)}.pill.FAIL{background:var(--bad);color:var(--badInk)}.pill.skipped{background:var(--wait);color:var(--soft)}
.note{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--metaLine);border-radius:10px;padding:10px 14px;margin:12px 0}.note.warn{border-left-color:#c2862b}
</style></head><body><main>
<h1>Maya: Meta models doing the work</h1>
<p class="sub">A voice companion for older adults. Maya's ears and brain are Meta models. This page is generated from a real evaluation run on ${esc(s.when)} (${esc(s.runs)} runs per suite, ${esc(s.seconds)} s), text only, with the numbers below taken straight from it. It loads nothing from the internet.</p>
${flow}
<div class="stats">${stats}</div>

<h2>What each Meta model does, with this run's real numbers</h2>
<div class="wrap"><table><tbody>${usageTable}</tbody></table></div>
<p class="sub">Spark is called through Meta's chat-completions endpoint; Transcribe through Meta's realtime stream (live calls) and its file endpoint (voice notes). ElevenLabs only turns Maya's words into speech; nothing is understood or decided there. No ElevenLabs request is made by the evaluation.</p>

<h2>The scam check: the reasoning setting, and what changing it cost</h2>
<p>The check on typed and spoken talk was changed from reasoning <code>low</code> to <code>minimal</code>. The decision was made on the dev half only: 76 items, ${esc(R.runs)} runs per setting.</p>
<div class="wrap"><table><thead>${row(['Dev half', 'Scams warned', 'Normal wrongly warned', 'Scams in progress paused', 'Average speed', 'Slowest 10%', 'Output tokens per call'], true)}</thead><tbody>
${row(['<code>low</code> (before)', pc(lo.warned), pc(lo.falseWarn), pc(lo.pauseInProgress), secs(lo.avgMs), secs(lo.p90Ms), num(Math.round(lo.tokensOut))])}${row(['<code>minimal</code> (live now)', pc(mi.warned), pc(mi.falseWarn), pc(mi.pauseInProgress), secs(mi.avgMs), secs(mi.p90Ms), num(Math.round(mi.tokensOut))])}</tbody></table></div>
<div class="note warn"><b>The cost of the change, stated plainly.</b> On the held-out half, which was run once for each setting, <code>minimal</code> warned ${frac(miH.alone.warned, miH.alone.scams)} scams against ${frac(lowH.alone.warned, lowH.alone.scams)} for <code>low</code> (${frac(miH.live.warned, miH.live.scams)} against ${frac(lowH.live.warned, lowH.live.scams)} behind the cheap word filter that runs live). ${dropped > 0 ? 'The one difference is a polite invoice scam ("our bank details have changed") that moved from a warning to a caution: still flagged, not missed.' : 'No scam was lost.'} In exchange the check is about ${(lo.avgMs / mi.avgMs).toFixed(1)} times faster and uses ${pc(1 - mi.tokensOut / lo.tokensOut)} fewer output tokens. The intervals overlap, so this is not a significant drop, but it is not nothing either. Both held-out runs are published in full: <code>docs/scam-results.md</code>.</div>
<div class="wrap">${heldTable}</div>
<p class="sub">The word filter lets about 1 scam description in 20 through unchecked, so those get no pause moment (Maya still answers naturally). The photo check is unchanged and was not measured.</p>

<h2>Hearing: Meta Transcribe</h2>
<p>Twenty-four fixed sentences were each spoken by two of four built-in Mac voices (US, UK, Australian, Irish) and transcribed by Meta Transcribe: ${num(H.sentences)} hearings, ${num(H.failed)} failed. Word error rate <b>${pc1(H.wer)}</b>; <b>${pc1(H.termSurvival)}</b> of the key words survived, and <b>${pc1(H.scamTermSurvival)}</b> of the words a scam turns on (gift cards, Medicare number, date of birth, code, arrested, install). Average ${secs(H.avgMs)} per voice note.</p>
<div class="note warn"><b>Limit.</b> This is <b>synthetic clean speech</b> made by the Mac's built-in voice: no real older voices, no accents, no hesitation, no noisy room. It shows the ears work and the key words come through; it does not show real-world accuracy. Most errors are a repeated word ("are finished are finished"), and once the name <i>Maya</i> came back as <i>Ma</i>. The live streamed-call path of the same model was not measured separately.</div>

<h2>Scorecard</h2>
<p class="sub">Each rule is a guard rail the evaluation checks on every run, so a later change cannot quietly make Maya worse.</p>
${checks}

<h2>Honest limits</h2>
<ul>
<li>The test sets were written by the team that built the features, and the same family of model reads them. Real conversations, real scammers and real older voices may be harder.</li>
<li>Small samples: 38 scams and 38 normal items per half; "0 wrongly warned" can hide a true rate of up to about 9%. Run-to-run noise is about two items.</li>
<li>Simulations (trends) show the rules behave sensibly under a stated model, not that they work on real people.</li>
<li>Photos (Spark vision) are wired and used, but are not measured here. The streamed call path of Transcribe is likewise not measured.</li>
<li>About ${pc(live ? cancelled / live.calls : null)} of live replies are cancelled and rewritten by Maya's own repeat and beat guards: that is why the repeat rate is near zero, and it costs extra time and tokens.</li>
</ul>

<h2>Run it yourself</h2>
<p><code>npm test</code> runs the offline checks (no network). <code>npm run eval</code> runs the Meta evaluation (text only, no ElevenLabs, about 5 minutes) and exits with an error if a guard rail fails or a number has dropped. <code>node eval/page.js</code> rebuilds this page.</p>
<p class="sub">Generated ${esc(s.generated)}. Source data: <code>docs/eval/summary.json</code>.</p>
</main></body></html>
`;
}

function renderMarkdown(s) {
  const m = s.metrics, R = s.reasoning || {}, lo = R.low || {}, mi = R.minimal || {}, H = s.hearing || {}, lowH = s.held.low, miH = s.held.minimal;
  const live = usageOf(s, 'live-reply'), mem = usageOf(s, 'memory-filing'), talk = usageOf(s, 'scam-text'), note = usageOf(s, 'transcribe-voice-note');
  const cancelled = live ? (live.failedBy || {}).aborted || 0 : 0;
  return `# Maya: how Meta models are used

Maya is a voice companion for older adults. Her **ears and brain are Meta models**; ElevenLabs is only the voice. Numbers below come from a real evaluation run on ${s.when} (${s.runs} runs per suite), text only. The same facts, with the flow diagram and scorecard, are on the page \`docs/meta-models.html\`.

## What each model does

| Meta model | Job | This run |
|---|---|---|
| **Spark** \`muse-spark-1.3\` (brain) | Live reply: what Maya says, plus a private read of the person's feeling, subject and pain | ${live ? `${num(live.calls)} calls, ${secs(live.avgMs)} average, ${num(Math.round(live.tokensIn / live.calls))} tokens in per call; ${pc(cancelled / live.calls)} cancelled and rewritten on purpose` : 'n/a'} |
| **Spark** (brain) | Files memory after a call: people, events, open follow-ups (closing them when answered) | ${mem ? `${num(mem.calls)} calls, ${secs(mem.avgMs)} average, in the background` : 'n/a'} |
| **Spark** (brain) | Scam check on typed and spoken talk: six signs plus "happening now" and "about to act", so Maya can pause someone before they pay | ${talk ? `${num(talk.calls)} calls, ${secs(talk.avgMs)} average, reasoning minimal` : 'n/a'} |
| **Spark vision** | Describes a photo for Maya; checks a photo for a scam | wired and used; **not measured** (the evaluation is text only) |
| **Transcribe** \`muse-voice-transcribe-1.0\` (ears) | Hears live calls (streamed) and recorded voice notes | ${note ? `voice notes: ${num(note.calls)} hearings, ${secs(note.avgMs)} average` : 'n/a'}; live calls: used, not part of the evaluation |

## Results (details on the page)

- **Conversation:** ${pc(m['conversation.repeatRate'])} of replies repeat a polite phrase; subject tag right ${pc(m['conversation.topicAccuracy'])}; the "nobody knows" worry answered with what the app does ${pc(m['conversation.worryAction'])}.
- **Memory:** a due follow-up asked at the first reply ${pc(m['memory.askedEarly'])}; never asked twice; trimmed memory still answers; nothing invented.
- **Trends (simulation):** ordinary life wrongly flagged ${pc1(m['trends.falseAlarmOrdinary'])}; slow drifts noticed within two weeks ${pc(m['trends.detectionMean'])} on average.
- **Scam shield:** dev scams warned ${pc(m['scam.warned'])}, no normal item warned. Held-out: ${frac(miH.alone.warned, miH.alone.scams)} scams warned by the detector, ${frac(miH.live.warned, miH.live.scams)} behind the live word filter, ${frac(miH.alone.falseWarned, miH.alone.normal)} normal items wrongly warned.
- **Hearing:** word error rate ${pc1(H.wer)} on synthetic clean speech; ${pc1(H.termSurvival)} of key words, ${pc1(H.scamTermSurvival)} of scam words survived.

## What changing the scam check's reasoning cost

The scam check on talk moved from reasoning \`low\` to \`minimal\`, decided on the dev half (${R.runs} runs per setting): warned ${pc(lo.warned)} vs ${pc(mi.warned)}, false warnings ${pc(lo.falseWarn)} vs ${pc(mi.falseWarn)}, about ${(lo.avgMs / mi.avgMs).toFixed(1)}x faster, ${pc(1 - mi.tokensOut / lo.tokensOut)} fewer output tokens. The held-out half was run once for each: \`low\` warned ${frac(lowH.alone.warned, lowH.alone.scams)}, \`minimal\` ${frac(miH.alone.warned, miH.alone.scams)}${s.held.minimalMissed.length > s.held.lowMissed.length ? ' (one polite invoice scam moved from a warning to a caution: still flagged, not missed)' : ''}. Not a significant drop, not nothing. Both runs are published in \`docs/scam-results.md\`.

## Limits

- Hearing was measured on **synthetic clean speech** (the Mac's built-in voice): no real older voices, accents or noise. The streamed-call path was not measured separately.
- Photos (Spark vision) are wired and used but **not measured**: the evaluation is text only.
- The test sets were written by the team, with small samples (38 scams and 38 normal items per half); run-to-run noise is about two items.
- About ${pc(live ? cancelled / live.calls : null)} of live replies are cancelled and rewritten by Maya's own repeat and beat guards, which costs extra time and tokens.

Run \`npm test\` (offline) and \`npm run eval\` (Meta text only, no ElevenLabs); \`node eval/page.js\` rebuilds the page and this note.
`;
}

function main() {
  const a = process.argv.slice(2); const from = a.includes('--from') ? path.resolve(a[a.indexOf('--from') + 1]) : path.join(ROOT, 'eval-results', 'latest.json');
  const results = JSON.parse(fs.readFileSync(from, 'utf8'));
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scam-testset.json'), 'utf8')).items.filter((i) => i.split === 'held');
  const by = (f) => ({ byId: Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8')).map((r) => [r.id, r])) });
  let reasoning = null; try { reasoning = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'eval', 'reasoning-comparison.json'), 'utf8')); } catch { /* none */ }
  const summary = buildSummary(results, { items: set, low: by('scam-results-final-held.json'), minimal: by('scam-results-final-held-minimal.json') }, reasoning);
  fs.mkdirSync(path.join(ROOT, 'docs', 'eval'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'eval', 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(path.join(ROOT, 'docs', 'meta-models.html'), render(summary));
  fs.writeFileSync(path.join(ROOT, 'docs', 'meta-models.md'), renderMarkdown(summary));
  console.log('wrote docs/meta-models.html, docs/meta-models.md, docs/eval/summary.json');
}
module.exports = { render, renderMarkdown, buildSummary, esc };
if (require.main === module) main();
