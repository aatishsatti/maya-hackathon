// Wellbeing trends: pure rules. Numbers only. The example values exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../trends');

const D0 = '2026-09-01';
const day = (i, o = {}) => ({ date: T.addDays(D0, i), calls: 2, turns: 14, heavy: 1, maxIntensity: 2, pain: 0, concerns: 0, remindersDue: 2, remindersMissed: 0, callbacks: 0, firstMin: 540, ...o });
// A steady, slightly varying life: turns 12-16, heavy 0-2, a rare pain mention, rare missed reminder.
const steady = (n) => Array.from({ length: n }, (_, i) => day(i, { turns: 12 + (i * 7) % 5, heavy: (i * 3) % 3 === 0 ? 2 : 1, pain: i % 11 === 0 ? 1 : 0, remindersMissed: i % 13 === 0 ? 1 : 0, firstMin: 520 + (i * 17) % 50 }));
const at = (days, i) => days[i].date;

test('addDays / blank: dates move correctly and a blank day holds only numbers', () => {
  assert.equal(T.addDays('2026-10-31', 1), '2026-11-01'); assert.equal(T.addDays('2026-01-01', -1), '2025-12-31');
  const b = T.blank('2026-10-01');
  assert.deepEqual(Object.keys(b).sort(), ['calls', 'callbacks', 'concerns', 'date', 'firstMin', 'heavy', 'maxIntensity', 'pain', 'remindersDue', 'remindersMissed', 'turns'].sort());
  for (const [k, v] of Object.entries(b)) if (k !== 'date') assert.ok(v === 0 || v === null, k);
});

test('addEvent: counts only; heavy needs a heavy feeling at intensity 2+; crisis is the safety path, not a trend; the first contact time keeps the earliest', () => {
  let r = T.blank('2026-10-01');
  r = T.addEvent(r, { kind: 'call', atMin: 600 });
  r = T.addEvent(r, { kind: 'turn', emotion: 'lonely', intensity: 3, pain: 0, concern: 'none', atMin: 601 });
  r = T.addEvent(r, { kind: 'turn', emotion: 'sad', intensity: 1, atMin: 560 });
  r = T.addEvent(r, { kind: 'turn', emotion: 'crisis', intensity: 5, atMin: 700 });
  r = T.addEvent(r, { kind: 'turn', emotion: 'happy', intensity: 4, pain: '1', concern: 'unsure' });
  r = T.addEvent(r, { kind: 'reminder', acked: true }); r = T.addEvent(r, { kind: 'reminder', acked: false }); r = T.addEvent(r, { kind: 'callback' });
  assert.deepEqual({ calls: r.calls, turns: r.turns, heavy: r.heavy, pain: r.pain, concerns: r.concerns, due: r.remindersDue, missed: r.remindersMissed, callbacks: r.callbacks, first: r.firstMin, max: r.maxIntensity }, { calls: 1, turns: 4, heavy: 1, pain: 1, concerns: 1, due: 2, missed: 1, callbacks: 1, first: 560, max: 5 });
  assert.ok(!T.HEAVY.has('crisis'));
  const before = Object.freeze({ ...T.blank('2026-10-02') }); const after = T.addEvent(before, { kind: 'turn', emotion: 'sad', intensity: 3 });
  assert.equal(after.turns, 1); assert.equal(before.turns, 0, 'not mutated');
  assert.equal(T.addEvent(T.blank('2026-10-03'), { kind: 'turn', emotion: 'sad', intensity: 3, atMin: 99999 }).firstMin, 1439, 'a bad time is clamped');
  for (const v of Object.values(r)) assert.ok(typeof v === 'number' || typeof v === 'string' || v === null, 'no text is ever stored');
});

test('prune: only the last 30 days of daily numbers are kept; bad or future dates are dropped', () => {
  const today = '2026-10-31';
  const days = [-1, 0, 1, 29, 30, 31, 60].map((k) => ({ ...T.blank(T.addDays(today, -k)) })).concat([{ date: 'garbage' }, null]);
  assert.deepEqual(T.prune(days, today).map((d) => d.date), [today, T.addDays(today, -1), T.addDays(today, -29)]);
  assert.equal(T.KEEP_DAYS, 30);
});

test('median and mad', () => {
  assert.equal(T.median([3, 1, 2]), 2); assert.equal(T.median([1, 2, 3, 4]), 2.5); assert.ok(Number.isNaN(T.median([])));
  assert.equal(T.mad([1, 2, 3, 4, 100], 3), 1);
});

test('tails are right: they reduce to the known cases, fall as k grows, and allow for an uncertain usual rate', () => {
  assert.equal(T.poissonTail(0, 2), 1); assert.ok(Math.abs(T.poissonTail(1, Math.LN2) - 0.5) < 1e-12);
  assert.equal(T.binomTail(2, 2, 0.5), 0.25); assert.equal(T.binomTail(3, 2, 0.5), 0);
  for (const [a, b] of [[1, 14], [3, 14], [0.3, 14]]) { let last = 1; for (let k = 1; k <= 12; k++) { const p = T.negBinTail(k, a, b, 8); assert.ok(p <= last + 1e-12 && p >= 0, `${a}/${b}/${k}`); last = p; } }
  // with a huge, well-known history the predictive tail approaches the plain Poisson tail
  assert.ok(Math.abs(T.negBinTail(4, 1e6 * 0.5, 1e6, 8) - T.poissonTail(4, 4)) < 1e-3);
  // with a tiny history it is much more cautious (fatter tail) than a plug-in rate would be
  assert.ok(T.negBinTail(6, 1.3, 14, 8) > 10 * T.poissonTail(6, (1.3 / 14) * 8));
  let last = 1; for (let k = 1; k <= 8; k++) { const p = T.betaBinomTail(k, 10, 0.5, 9.5); assert.ok(p <= last + 1e-12); last = p; }
  assert.equal(T.betaBinomTail(0, 5, 1, 1), 1); assert.equal(T.betaBinomTail(6, 5, 1, 1), 0);
  assert.ok(Math.abs(T.betaBinomTail(1, 1, 1, 1) - 0.5) < 1e-12, 'uniform prior, one trial: P(miss)=1/2');
});

test('evaluate: no history or too little history is "learning", never a judgement', () => {
  assert.equal(T.evaluate([], '2026-10-01').status, 'learning');
  assert.equal(T.evaluate(null, '2026-10-01').status, 'learning');
  const days = steady(T.MIN_SPAN - 1); assert.equal(T.evaluate(days, at(days, days.length - 1)).status, 'learning');
  // even a dramatic change inside the learning period is not judged
  const hurt = steady(10).map((d, i) => (i > 4 ? { ...d, turns: 0, pain: 4 } : d)); assert.equal(T.evaluate(hurt, at(hurt, 9)).status, 'learning');
});

test('evaluate: a steady life stays "ok" for weeks and says nothing', () => {
  const days = steady(40); let prev = null;
  for (let i = 0; i < days.length; i++) { const r = T.evaluate(days.slice(0, i + 1), at(days, i), prev); prev = r; assert.ok(['learning', 'ok'].includes(r.status), `${i}: ${r.status}`); assert.deepEqual(T.describe(r), []); }
});

test('evaluate: shifts in different kinds of signal together are "notable", with the numbers behind each', () => {
  const days = steady(30).map((d, i) => (i >= 22 ? { ...d, turns: 5, heavy: 4, callbacks: 2, firstMin: 700 } : d));
  const r = T.evaluate(days, at(days, 29));
  assert.equal(r.status, 'notable'); assert.equal(r.since, at(days, 29));
  const ids = r.signals.filter((s) => s.raised).map((s) => s.id); for (const id of ['turns', 'heavyShare', 'callbacks']) assert.ok(ids.includes(id), id);
  const t = r.signals.find((s) => s.id === 'turns'); assert.ok(t.recent < t.usual && t.shifted >= 5 && t.of === 8);
  const lines = T.describe(r); assert.ok(lines.length >= 3);
  assert.ok(lines.some((l) => /^Spoke less: about 5 things said a day lately, usual is about 1[2-6]/.test(l)), lines.join(' | '));
  assert.ok(lines.every((l) => /\(shifted on \d of the last 8 days\)\.$/.test(l)));
});

test('evaluate: one weak or short change does not raise anything; a single strong signal is "watch" and one group only', () => {
  const brief = steady(30).map((d, i) => (i >= 28 ? { ...d, turns: 3 } : d));   // two bad days
  assert.equal(T.evaluate(brief, at(brief, 29)).status, 'ok');
  const oneBadDay = steady(30).map((d, i) => (i === 29 ? { ...d, heavy: 9, pain: 3, turns: 9 } : d)); assert.equal(T.evaluate(oneBadDay, at(oneBadDay, 29)).status, 'ok');
  const painful = steady(30).map((d, i) => (i >= 21 ? { ...d, pain: 3 } : d));
  const r = T.evaluate(painful, at(painful, 29)); assert.equal(r.status, 'watch'); assert.deepEqual([...new Set(r.signals.filter((s) => s.raised).map((s) => s.group))], ['body']);
  assert.match(T.describe(r)[0], /^Pain mentioned about 3 times a day lately, usual is about 0\.\d/);
});

test('evaluate: no flapping: a signal already raised stays raised on a looser bar than it needed to be raised', () => {
  const mk = () => steady(30).map((d, i) => (i >= 22 && [22, 23, 24, 25].includes(i) ? { ...d, turns: 5 } : d));   // 4 low days of the last 8, then recovery
  const days = mk();
  const fresh = T.evaluate(days, at(days, 29), null);
  assert.equal(fresh.status, 'ok', 'raising needs 5 of 8');
  const kept = T.evaluate(days, at(days, 29), { status: 'watch', since: at(days, 27), signals: [{ id: 'turns', raised: true }] });
  assert.equal(kept.status, 'watch', 'staying raised needs only 3 of 8'); assert.equal(kept.since, at(days, 27), 'and it remembers since when');
  const gone = T.evaluate(steady(30), at(steady(30), 29), { status: 'watch', since: at(days, 27), signals: [{ id: 'turns', raised: true }] });
  assert.equal(gone.status, 'ok'); assert.equal(gone.since, null);
});

test('evaluate: the person\'s own usual decides: the same numbers are fine for one person and a change for another', () => {
  const quiet = Array.from({ length: 30 }, (_, i) => day(i, { turns: 4 + (i % 3), heavy: 0 }));
  assert.equal(T.evaluate(quiet, at(quiet, 29)).status, 'ok', 'a quiet person talking 5 times a day is normal');
  const chatty = Array.from({ length: 30 }, (_, i) => day(i, { turns: i >= 22 ? 5 : 20 + (i % 3), heavy: 1 }));
  assert.notEqual(T.evaluate(chatty, at(chatty, 29)).status, 'ok', 'a chatty person dropping to 5 is');
});

test('evaluate: inputs are not mutated, bad records are ignored, and future days are ignored', () => {
  const days = steady(30); const snap = JSON.stringify(days);
  T.evaluate(days, at(days, 29)); assert.equal(JSON.stringify(days), snap);
  assert.equal(T.evaluate([...days, null, { date: 'nope' }, day(40)], at(days, 29)).status, 'ok');
});

test('describe: plain facts with numbers only: no diagnosis, no cause, no advice, no names, no words from a conversation', () => {
  const days = steady(30).map((d, i) => (i >= 22 ? { ...d, turns: 5, heavy: 4, pain: 2, callbacks: 2, firstMin: 700, remindersMissed: 2 } : d));
  const text = T.describe(T.evaluate(days, at(days, 29))).join(' ');
  assert.ok(text.length > 100);
  assert.doesNotMatch(text, /depress|ill\b|illness|sick|declin|dement|alzheim|diagnos|disease|disorder|should|must|because|caused|suggest|emergency|urgent|alert/i);
  assert.deepEqual(T.describe({ status: 'ok', signals: [] }), []); assert.deepEqual(T.describe(null), []); assert.deepEqual(T.describe({ status: 'learning', signals: [] }), []);
});

test('privacy and purity: trends.js touches no file, network, clock, key or conversation text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trends.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.deepEqual([...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]), ['./recall']);
  assert.ok(!/fetch\(|process\.env|writeFile|readFile|Date\.now\(|new Date\(\)|transcript|\.text\b|content/.test(src));
});
