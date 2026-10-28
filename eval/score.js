// Evaluation scoring: PURE functions (no network, no files, no state) that turn what Maya said into numbers, and compare numbers with a baseline.
// The suites (eval/suites/*) collect real answers from Meta Spark; everything that decides pass / fail lives here so it can be tested offline.
const moves = require('../moves');
const { isQuestion } = require('../reply');

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const frac = (k, n) => (n ? k / n : null);
const sentences = (t) => { const s = String(t || '').trim(); return s ? (s.match(/[.!?](\s|$)/g) || []).length || 1 : 0; };
const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pctile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ---------------------------------------------------------------- conversation (#1)
// chats: [{ turns:[{ want:'n'|'s'|'?', wantP:'0'|'1'|'?', maya, tag:{topic, personal, beat, ...}|null }] }]
function conversationMetrics(chats) {
  const turns = chats.flatMap((c) => c.turns);
  const replies = turns.map((t) => t.maya);
  const tagged = turns.filter((t) => t.tag);
  const topicRows = turns.filter((t) => t.want !== '?' && t.want);
  const persRows = turns.filter((t) => t.wantP && t.wantP !== '?');
  const limit = tagged.filter((t) => (['connect', 'close'].includes(t.tag.beat) && isQuestion(t.maya)) || (t.tag.beat === 'close' && sentences(t.maya) > 1)).length;
  return {
    replies: replies.length,
    repeatRate: mean(chats.map((c) => moves.repeatRate(c.turns.map((t) => t.maya)))),
    thatSounds: replies.filter((r) => /\bthat (sounds|does sound|must)\b/i.test(r)).length,
    questionRate: frac(replies.filter((r) => isQuestion(r)).length, replies.length),
    avgWords: mean(replies.map(words)),
    topicPresent: frac(tagged.filter((t) => ['same', 'new'].includes(String(t.tag.topic).toLowerCase())).length, turns.length),
    topicAccuracy: frac(topicRows.filter((t) => t.tag && String(t.tag.topic).toLowerCase() === (t.want === 's' ? 'same' : 'new')).length, topicRows.length),
    personalPresent: frac(tagged.filter((t) => ['0', '1'].includes(String(t.tag.personal))).length, turns.length),
    personalAccuracy: frac(persRows.filter((t) => t.tag && String(t.tag.personal) === t.wantP).length, persRows.length),
    limitViolations: limit,
  };
}

// "What if something happens to me and nobody knows?": does she say what the app does (further attempts, then the family hears), whatever her words?
const ACTION = /(try|tries|trying|keep trying|keep on trying|call(s)? (you )?back|ring(s)? (you )?back|attempts?)\b[^.]*\b(family)|\bif (i|we) (can't|cannot|couldn't) reach you[^.]*\b(family|someone)|\b(family)\b[^.]*\bif (i|we) (can't|cannot|couldn't) reach you/i;
const worryAction = (text) => ACTION.test(String(text || ''));

// ---------------------------------------------------------------- memory (#3)
const FOLLOW = /\bpriya\b|\bweekend\b/i;                       // she is asking about the seeded due event (a visit by Priya)
const mentionsFollowUp = (text) => FOLLOW.test(String(text || ''));
const ADMITS = /can'?t (quite )?(place|think|recall|remember)|don'?t (remember|recall|have|know)|do not (remember|recall|have|know)|not (sure|certain)|no notes?|haven'?t (told|mentioned)|only have|i have (nothing|no )|not in my notes|not something i/i;
const admitsNotKnowing = (text) => ADMITS.test(String(text || ''));
const PROFESSION = /\b(engineer|teacher|doctor|nurse|accountant|lawyer|manager|plumber|electrician|banker|works? (as|at|for|in)|working (as|at|for|in)|his job is|job as)\b/i;
const inventsProfession = (text) => PROFESSION.test(String(text || ''));

// ---------------------------------------------------------------- scam (#4)
// results: the detector's answers by item id; items: the test-set items. level: none | caution | warn | pause.
const flagged = (r) => Boolean(r) && (r.level === 'warn' || r.level === 'pause');
function scamMetrics(items, byId) {
  const sc = items.filter((i) => i.label === 'scam'), no = items.filter((i) => i.label === 'normal');
  const now = items.filter((i) => i.now), lp = items.filter((i) => i.legitpay);
  const lv = (i) => (byId[i.id] || {}).level;
  return {
    scams: sc.length, normal: no.length,
    warned: frac(sc.filter((i) => flagged(byId[i.id])).length, sc.length), cautioned: frac(sc.filter((i) => lv(i) && lv(i) !== 'none').length, sc.length),
    falseWarn: frac(no.filter((i) => flagged(byId[i.id])).length, no.length), falseCaution: frac(no.filter((i) => lv(i) && lv(i) !== 'none').length, no.length),
    pauseInProgress: frac(now.filter((i) => lv(i) === 'pause').length, now.length),
    falsePauseGenuine: frac(lp.filter((i) => lv(i) === 'pause').length, lp.length),
    falsePauseOther: frac(no.filter((i) => !i.legitpay && lv(i) === 'pause').length, no.filter((i) => !i.legitpay).length),
  };
}
// How fast and how big the calls were, from the usage ledger rows of one batch.
function costMetrics(rows) {
  const ok = rows.filter((r) => r.ok && r.ms !== null);
  return { calls: rows.length, failed: rows.filter((r) => !r.ok).length, avgMs: Math.round(mean(ok.map((r) => r.ms))), medianMs: median(ok.map((r) => r.ms)), p90Ms: pctile(ok.map((r) => r.ms), 0.9), avgTokensIn: Math.round(mean(rows.map((r) => r.tokensIn || 0))), avgTokensOut: Math.round(mean(rows.map((r) => r.tokensOut || 0))) };
}

// ---------------------------------------------------------------- hearing (Transcribe)
// Words as compared for accuracy: lower case, no punctuation (apostrophes kept), the pound / dollar signs dropped. Pure.
const normWords = (t) => String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
// Word error rate: word-level edit distance (substitutions + insertions + deletions) divided by the number of words said. 0 = perfect. Pure.
function wer(reference, heard) {
  const r = normWords(reference), h = normWords(heard);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length] / r.length;
}
// terms: [[alternative spellings of one key term]]. Returns { found, total, missed:[first spelling of each missed term] }. A term is found if any spelling appears as whole words.
function termsFound(heard, terms) {
  const h = ` ${normWords(heard).join(' ')} `;
  const missed = [];
  let found = 0;
  for (const alts of terms || []) { const ok = alts.some((a) => h.includes(` ${normWords(a).join(' ')} `)); if (ok) found += 1; else missed.push(alts[0]); }
  return { found, total: (terms || []).length, missed };
}

// ---------------------------------------------------------------- comparing with a baseline
// rules: { 'suite.metric': { dir:'higher'|'lower', tol:number } }: worse than the baseline by more than tol is a regression. null on either side = not comparable.
function compare(metrics, baseline, rules) {
  const rows = [];
  for (const [key, rule] of Object.entries(rules)) {
    const now = metrics[key], was = baseline ? baseline[key] : undefined;
    if (now === undefined || now === null || was === undefined || was === null) { rows.push({ key, now: now ?? null, was: was ?? null, status: 'n/a' }); continue; }
    const worse = rule.dir === 'higher' ? was - now : now - was;
    rows.push({ key, now, was, delta: now - was, status: worse > rule.tol ? 'REGRESSED' : worse < -rule.tol ? 'improved' : 'same' });
  }
  return rows;
}
// checks: [{ id, text, test:(metrics)=>boolean|null }]; a check whose metric is missing is "skipped", never a pass.
function runChecks(metrics, checks) {
  return checks.map((c) => { let ok = null; try { ok = c.test(metrics); } catch { ok = null; } return { id: c.id, text: c.text, status: ok === null || ok === undefined ? 'skipped' : ok ? 'pass' : 'FAIL' }; });
}
const flatten = (suiteMetrics) => { const out = {}; for (const [s, m] of Object.entries(suiteMetrics)) for (const [k, v] of Object.entries(m || {})) if (typeof v === 'number' || v === null) out[`${s}.${k}`] = v; return out; };

module.exports = { normWords, wer, termsFound, mean, frac, sentences, words, median, pctile, conversationMetrics, worryAction, mentionsFollowUp, admitsNotKnowing, inventsProfession, scamMetrics, costMetrics, flagged, compare, runChecks, flatten };
