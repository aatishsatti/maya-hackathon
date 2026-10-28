// Wellbeing trends (step 1): pure rules. No network, no Spark, no files, no clock. Numbers only: no words, no topics, ever.
// Question answered: "is this person quietly different from THEIR OWN usual, over several days?" It never diagnoses and never raises a
// safety alert (the care layer's job). The family sees what changed with the numbers behind it, nothing more.
//
// Day record (one per local day, kept 30 days): { date, calls, turns, heavy, maxIntensity, pain, concerns, remindersDue, remindersMissed,
// callbacks, firstMin } where turns = what the person said, heavy = turns Spark read as a heavy tone (lonely, sad, grieving, anxious,
// frustrated, angry), firstMin = minutes after local midnight of the first contact that day.
const { daysBetween } = require('./recall');

const KEEP_DAYS = 30;       // daily numbers older than this are dropped
const RECENT = 8;           // the days compared with the usual
const BASELINE = 14;        // the days before them that make up the person's usual
const MIN_SPAN = 19;        // fewer days than this since the first record: still learning, no judgement
const MIN_BASE_VALUES = 9;  // a signal needs this many usual-days with a value
const RAISE_DAYS = 5;       // shifted on at least this many of the last RECENT days to be raised
const KEEP_RAISED_DAYS = 3; // an already raised signal stays raised while shifted on at least this many
const STRONG_DAYS = 6;       // level signals: strong when shifted on at least this many of the last RECENT days...
const STRONG_Z = 2;          // ...and moved at least this many spreads (bounded measures such as turns never reach very large values)
const ZMIN = 1;          // level signals: the middle of the last RECENT days must have moved at least this many spreads from usual
const P_RAISE = 0.015;      // count signals: the recent total must be this unlikely at the person's usual rate to be raised...
const P_KEEP = 0.02;        // ...and this unlikely to stay raised
const P_STRONG = 0.0002;   // a count signal this unlikely at the person's usual rate is a strong one on its own
const COUNT_PRIOR = 0.3;      // pseudo-events added to a person's usual count, so a spotless history is not treated as certain
const MIN_COUNT = 3;        // ...and be at least this many events
const SPREAD_SAFETY = 1.1; // the usual spread is estimated from few days, so it is widened a little (level signals)
const ZDAY = 1.5;           // a day counts as shifted when it is this many robust spreads from usual (and also moves enough, see minDelta)

const HEAVY = new Set(['sad', 'lonely', 'grief', 'anxious', 'frustrated', 'angry']);   // crisis is the safety path's, not a trend

const addDays = (iso, k) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const blank = (date) => ({ date, calls: 0, turns: 0, heavy: 0, maxIntensity: 0, pain: 0, concerns: 0, remindersDue: 0, remindersMissed: 0, callbacks: 0, firstMin: null });

// Adds one event to a day record (returns a new record). Events: {kind:'call', atMin} | {kind:'turn', emotion, intensity, pain, concern, atMin}
// | {kind:'reminder', acked} | {kind:'callback'}. Only counts are kept.
function addEvent(rec, ev) {
  const r = { ...(rec || {}) };
  const b = blank(r.date);
  for (const k of Object.keys(b)) if (r[k] === undefined) r[k] = b[k];
  const at = Number.isFinite(ev.atMin) ? Math.max(0, Math.min(1439, Math.round(ev.atMin))) : null;
  if (at != null) r.firstMin = r.firstMin == null ? at : Math.min(r.firstMin, at);
  if (ev.kind === 'call') r.calls += 1;
  else if (ev.kind === 'turn') {
    r.turns += 1;
    const n = Math.max(0, Math.min(5, Number(ev.intensity) || 0));
    if (HEAVY.has(String(ev.emotion || '').toLowerCase()) && n >= 2) r.heavy += 1;
    r.maxIntensity = Math.max(r.maxIntensity, n);
    if (ev.pain === true || /^(1|yes|true)$/i.test(String(ev.pain || ''))) r.pain += 1;
    if (['unsure', 'urgent'].includes(String(ev.concern || '').toLowerCase())) r.concerns += 1;
  } else if (ev.kind === 'reminder') { r.remindersDue += 1; if (ev.acked === false) r.remindersMissed += 1; }
  else if (ev.kind === 'callback') r.callbacks += 1;
  return r;
}

// Drops records older than KEEP_DAYS (and any with a bad date). Pure.
const prune = (days, today, keep = KEEP_DAYS) => (days || []).filter((d) => d && Number.isFinite(daysBetween(d.date, today)) && daysBetween(d.date, today) < keep && daysBetween(d.date, today) >= 0);

const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mad = (a, med) => median(a.map((x) => Math.abs(x - med)));

// The signals. Three kinds, because they need different statistics:
//  level  a number every day (turns said, first-contact time, share of heavy tone): a day is shifted when it is ZDAY robust spreads (and
//         minDelta) from the person's usual in the bad direction; raised when it is shifted on RAISE_DAYS of the last RECENT days AND the
//         middle value of those days has moved at least ZMIN spreads. dir +1: a RISE is the change worth noting; -1: a FALL.
//  count  rare events (pain mentions, call-backs needed): judged by how unlikely the recent TOTAL is at the person's usual daily rate (exact
//         Poisson tail), on at least RAISE_DAYS distinct days. One mention on a quiet week is nothing; a run of them is.
//  rate   missed reminders out of reminders due: same idea with an exact binomial tail.
// floor: the least spread ever assumed (a perfectly steady usual must not make a tiny change look huge).
const SIGNALS = [
  { id: 'turns', group: 'engagement', kind: 'level', dir: -1, floor: 2, minDelta: (u) => Math.max(3, 0.3 * u), get: (d) => (d ? d.turns : 0) },
  { id: 'firstMin', group: 'engagement', kind: 'level', dir: +1, floor: 45, minDelta: () => 90, get: (d) => (d && d.firstMin != null ? d.firstMin : null) },
  { id: 'heavyShare', group: 'mood', kind: 'level', dir: +1, floor: 0.08, minDelta: () => 0.15, get: (d) => (d && d.turns >= 3 ? d.heavy / d.turns : null) },
  { id: 'pain', group: 'body', kind: 'count', get: (d) => (d ? d.pain : null) },
  { id: 'callbacks', group: 'reliability', kind: 'count', get: (d) => (d ? d.callbacks : null) },
  { id: 'missed', group: 'reliability', kind: 'rate', get: (d) => (d ? d.remindersMissed : null), of: (d) => (d ? d.remindersDue : 0) },
];

// Upper tails that already allow for not knowing the person's true usual rate exactly (the rate is estimated from a few days):
//  negBinTail  P(X >= k) for X | rate ~ Poisson(rate * t) with rate ~ Gamma(a, b): the Gamma-Poisson (negative binomial) predictive.
//  betaBinomTail  P(X >= k) of k or more misses out of n, with the miss rate ~ Beta(alpha, beta).
// Both are exact sums; poissonTail / binomTail (known rate) are kept for tests and comparison.
function negBinTail(k, a, b, t) { if (k <= 0) return 1; const q = t / (b + t); let p = (b / (b + t)) ** a, cdf = 0; for (let x = 0; x < k; x++) { cdf += p; p *= (a + x) / (x + 1) * q; } return Math.max(0, 1 - cdf); }
function betaBinomTail(k, n, alpha, beta) { if (k <= 0) return 1; if (k > n) return 0; let p = 1; for (let i = 0; i < n; i++) p *= (beta + i) / (alpha + beta + i); let cdf = 0; for (let x = 0; x < k; x++) { cdf += p; p *= (n - x) / (x + 1) * (x + alpha) / (n - x - 1 + beta); } return Math.max(0, 1 - cdf); }
// P(X >= k) for X ~ Poisson(lam), and for X ~ Binomial(n, p). Exact sums.
function poissonTail(k, lam) { if (k <= 0) return 1; let term = Math.exp(-lam), cdf = term; for (let i = 1; i < k; i++) { term *= lam / i; cdf += term; } return Math.max(0, 1 - cdf); }
function binomTail(k, n, p) { if (k <= 0) return 1; if (k > n) return 0; let c = 1, tail = 0; for (let i = 0; i <= n; i++) { if (i > 0) c = c * (n - i + 1) / i; if (i >= k) tail += c * p ** i * (1 - p) ** (n - i); } return Math.min(1, tail); }

// status: 'learning' | 'ok' | 'watch' (one strong signal) | 'notable' (shifted signals in two or more different groups).
// prev: the result of the previous day's evaluation (for the no-flapping rule), or null.
function evaluate(days, today, prev = null) {
  const list = (days || []).filter((d) => d && Number.isFinite(daysBetween(d.date, today)) && daysBetween(d.date, today) >= 0);
  if (!list.length) return { status: 'learning', span: 0, since: null, signals: [] };
  const first = list.map((d) => d.date).sort()[0];
  const span = daysBetween(first, today) + 1;
  if (span < MIN_SPAN) return { status: 'learning', span, since: null, signals: [] };
  const byDate = new Map(list.map((d) => [d.date, d]));
  const recentDates = Array.from({ length: RECENT }, (_, i) => addDays(today, -(RECENT - 1 - i)));
  const baseDates = Array.from({ length: BASELINE }, (_, i) => addDays(today, -(RECENT + BASELINE - 1 - i)));
  const wasRaised = new Set(prev && ['watch', 'notable'].includes(prev.status) ? prev.signals.map((s) => s.id) : []);
  const signals = [];
  for (const sig of SIGNALS) {
    const keepIt = wasRaised.has(sig.id);
    const baseRecs = baseDates.filter((dt) => dt >= first).map((dt) => byDate.get(dt));
    if (sig.kind === 'level') {
      const base = baseDates.map((dt) => (dt < first ? null : sig.get(byDate.get(dt)))).filter((v) => v != null);
      if (base.length < MIN_BASE_VALUES) continue;
      const usual = median(base);
      const scale = SPREAD_SAFETY * Math.max(1.4826 * mad(base, usual), sig.floor);
      const need = Math.max(ZDAY * scale, sig.minDelta(usual));
      const rec = recentDates.map((dt) => sig.get(byDate.get(dt)));
      const vals = rec.filter((v) => v != null);
      if (!vals.length) continue;
      const shifted = rec.filter((v) => v != null && sig.dir * (v - usual) >= need).length;
      const recent = median(vals);
      const z = sig.dir * (recent - usual) / scale;
      const raised = shifted >= (keepIt ? KEEP_RAISED_DAYS : RAISE_DAYS) && z >= (keepIt ? ZMIN * 0.6 : ZMIN);
      signals.push({ id: sig.id, group: sig.group, shifted, of: RECENT, recent, usual, z, strong: shifted >= STRONG_DAYS && z >= STRONG_Z, raised });
    } else {
      // count / rate: usual daily rate from the previous BASELINE days with one pseudo-event so a spotless history is not infinitely sure
      const have = baseRecs.length;
      if (have < MIN_BASE_VALUES) continue;
      const recRecs = recentDates.map((dt) => byDate.get(dt));
      const rSum = recRecs.reduce((a, d) => a + (sig.get(d) || 0), 0);
      const days = recRecs.filter((d) => (sig.get(d) || 0) > 0).length;
      let usual, recent, p;
      if (sig.kind === 'count') {
        const bSum = baseRecs.reduce((a, d) => a + (sig.get(d) || 0), 0);
        usual = (bSum + COUNT_PRIOR) / have; recent = rSum / RECENT; p = negBinTail(rSum, bSum + COUNT_PRIOR, have, RECENT);
      } else {
        const bDue = baseRecs.reduce((a, d) => a + sig.of(d), 0), bMiss = baseRecs.reduce((a, d) => a + sig.get(d), 0);
        const rDue = recRecs.reduce((a, d) => a + sig.of(d), 0);
        if (bDue < 6 || rDue < 3) continue;
        usual = bMiss / bDue; recent = rSum / rDue; p = betaBinomTail(rSum, rDue, bMiss + 0.5, bDue - bMiss + 1.5);
      }
      const raised = rSum >= MIN_COUNT && days >= (keepIt ? KEEP_RAISED_DAYS : RAISE_DAYS - (sig.kind === 'rate' ? 1 : 0)) && p <= (keepIt ? P_KEEP : P_RAISE);
      const z = p > 0 ? Math.min(9, -Math.log10(p)) : 9;
      signals.push({ id: sig.id, group: sig.group, shifted: days, of: RECENT, recent, usual, z, strong: days >= RAISE_DAYS && rSum >= MIN_COUNT + 1 && p <= P_STRONG, raised });
    }
  }
  const up = signals.filter((s) => s.raised);
  const groups = new Set(up.map((s) => s.group));
  // notable: shifted signals in two or more different groups agree. watch: ONE group, and a strong signal in it (or it was already raised
  // yesterday). A single weak signal is not enough: that is how ordinary noise would get through.
  const status = groups.size >= 2 ? 'notable' : up.length && (up.some((x) => x.strong) || up.some((x) => wasRaised.has(x.id))) ? 'watch' : 'ok';
  const raised = status === 'watch' || status === 'notable';
  return { status, span, since: raised ? (prev && ['watch', 'notable'].includes(prev.status) && prev.since ? prev.since : today) : null, signals: raised ? up : signals.filter((s) => s.shifted > 0) };
}

// Plain factual lines for the family, from the numbers only. No diagnosis, no cause, no advice.
const r1 = (x) => (Math.round(x * 10) / 10).toString();
const pct = (x) => `${Math.round(x * 100)}%`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const LINE = {
  turns: (s) => `Spoke less: about ${r1(s.recent)} things said a day lately, usual is about ${r1(s.usual)}`,
  firstMin: (s) => `First contact of the day later: around ${hhmm(s.recent)} lately, usual is around ${hhmm(s.usual)}`,
  heavyShare: (s) => `More conversation with a low or worried tone: ${pct(s.recent)} lately, usual is ${pct(s.usual)}`,
  pain: (s) => `Pain mentioned about ${r1(s.recent)} times a day lately, usual is about ${r1(s.usual)}`,
  missed: (s) => `Reminders missed: ${pct(s.recent)} lately, usual is ${pct(s.usual)}`,
  callbacks: (s) => `Call-backs needed about ${r1(s.recent)} times a day lately, usual is about ${r1(s.usual)}`,
};
function describe(result) {
  if (!result || !['watch', 'notable'].includes(result.status)) return [];
  return result.signals.filter((s) => s.raised).map((s) => `${LINE[s.id](s)} (shifted on ${s.shifted} of the last ${s.of} days).`);
}

module.exports = { poissonTail, binomTail, negBinTail, betaBinomTail, KEEP_DAYS, RECENT, BASELINE, MIN_SPAN, RAISE_DAYS, HEAVY, SIGNALS, addDays, blank, addEvent, prune, median, mad, evaluate, describe };
