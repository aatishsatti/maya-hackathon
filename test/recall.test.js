// Memory that thinks, step 1: pure rules. The example text below exists only in this test file; recall.js never returns a sentence to say.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../recall');

const TODAY = '2026-10-28';

test('days and plain-words relations are worked out in code', () => {
  assert.equal(R.daysBetween('2026-10-26', '2026-10-28'), 2);
  assert.equal(R.daysBetween('2026-10-28', '2026-10-26'), -2);
  assert.equal(R.daysBetween('2026-12-30', '2027-01-02'), 3, 'across a year end');
  assert.ok(Number.isNaN(R.daysBetween('soon', TODAY)));
  assert.deepEqual([0, 1, -1, 3, -4].map(R.rel), ['today', 'tomorrow', 'yesterday', 'in 3 days', '4 days ago']);
  assert.equal(R.rel(NaN), '');
});

test('dateFact: a full date is relative to today; a yearly date (birthday) is its next occurrence, today included', () => {
  assert.deepEqual(R.dateFact('2026-10-26', TODAY), { days: -2, text: '2 days ago' });
  assert.deepEqual(R.dateFact('2026-10-31', TODAY), { days: 3, text: 'in 3 days' });
  assert.deepEqual(R.dateFact('10-28', TODAY), { days: 0, text: 'today' });
  assert.deepEqual(R.dateFact('11-02', TODAY), { days: 5, text: 'in 5 days' });
  assert.deepEqual(R.dateFact('10-20', TODAY), { days: 357, text: 'in 357 days' }, 'already passed this year: next year');
  assert.equal(R.dateFact('', TODAY), null); assert.equal(R.dateFact('next week', TODAY), null); assert.equal(R.dateFact('2026-10-26', 'bad'), null);
});

test('score: shared words and the person named count; an unrelated item scores zero even if it is fresh', () => {
  const item = { who: 'Priya', text: 'is visiting on Saturday', told: '2026-10-27' };
  assert.ok(R.score(item, 'Priya is coming over soon', TODAY) > R.score(item, 'my visit to the shops', TODAY));
  assert.ok(R.score(item, 'when is she visiting', TODAY) > 0, 'a word shared with the fact (visiting) matches');
  assert.equal(R.score({ who: '', text: 'likes ginger tea', told: TODAY }, 'the roses are finished', TODAY), 0, 'fresh but unrelated: not relevant');
  assert.equal(R.score(item, '', TODAY), 0);
  const fresh = R.score({ who: '', text: 'likes ginger tea', told: '2026-10-27' }, 'ginger is nice', TODAY);
  const old = R.score({ who: '', text: 'likes ginger tea', told: '2026-09-01' }, 'ginger is nice', TODAY);
  assert.ok(fresh > old, 'recency only breaks ties between related items');
});

const MEM = {
  people: [
    { name: 'Priya', relationship: 'granddaughter', birthday: '10-31', stories: [{ text: 'plays the violin at school', told: '2026-10-20' }] },
    { name: 'Ravi', relationship: 'son', birthday: '03-02', stories: [] },
  ],
  events: [
    { who: 'Priya', text: 'visiting for the weekend', date: '2026-10-26', told: '2026-10-22' },
    { who: 'Mike', text: 'doctor appointment', date: '2026-11-20', told: '2026-10-25' },
  ],
  preferences: [{ who: 'Mike', text: 'likes ginger tea', told: '2026-10-10' }],
  current: [{ who: 'Mike', text: 'knee feels sore on the stairs', told: '2026-10-27' }],
  topics: [{ text: 'old steam trains', told: '2026-10-15' }],
};

test('select: only related items, best first, at most k; a named person always brings who they are; nothing unrelated is added', () => {
  const s = R.select(MEM, 'Priya is playing the violin tonight', TODAY);
  assert.equal(s[0].kind === 'person' || s[0].score >= 5, true);
  assert.ok(s.some((x) => x.kind === 'person' && x.who === 'Priya' && /granddaughter/.test(x.text)));
  assert.ok(s.some((x) => x.kind === 'story' && /violin/.test(x.text)));
  assert.ok(!s.some((x) => /ginger|steam|doctor/.test(x.text)), 'unrelated items are left out');
  assert.ok(s.every((x, i) => i === 0 || s[i - 1].score >= x.score), 'best first');
  assert.equal(R.select(MEM, 'Priya violin visiting ginger knee trains doctor', TODAY, { k: 2 }).length, 2);
  assert.deepEqual(R.select(MEM, 'nothing matches here at all', TODAY), []);
  assert.deepEqual(R.select({}, 'Priya', TODAY), []); assert.deepEqual(R.select(null, 'Priya', TODAY), []);
});

test('upcoming: birthdays within 7 days and dated events from 3 days ahead to 7 days back, closest first, dates already worked out', () => {
  const u = R.upcoming(MEM, TODAY);
  assert.deepEqual(u.map((x) => [x.kind, x.when]), [['event', '2 days ago'], ['birthday', 'in 3 days']]);
  assert.ok(!u.some((x) => /doctor/.test(x.text)), 'an event 23 days away is not pinned');
  assert.deepEqual(R.upcoming({ people: [{ name: 'Ravi', birthday: '03-02' }] }, TODAY), []);
});

const th = (o) => ({ who: 'Priya', text: 'visiting for the weekend', due: '2026-10-26', kind: 'event', status: 'open', asked: 0, told: '2026-10-22', ...o });

test('dueThread: a dated follow-up is due once its date has come, and only for a limited time', () => {
  assert.equal(R.dueThread([th()], TODAY).text, 'visiting for the weekend');
  assert.equal(R.dueThread([th({ due: '2026-10-28' })], TODAY).who, 'Priya', 'due today');
  assert.equal(R.dueThread([th({ due: '2026-10-29' })], TODAY), null, 'not yet');
  assert.equal(R.dueThread([th({ due: '2026-10-14' })], TODAY).who, 'Priya', 'exactly 14 days after is still allowed');
  assert.equal(R.dueThread([th({ due: '2026-10-13' })], TODAY), null, 'too late: it is just over');
});

test('dueThread: heavy moments, an earlier ask this call, two asks in total, and closed or expired threads never offer one', () => {
  assert.equal(R.dueThread([th()], TODAY, { heavy: true }), null);
  assert.equal(R.dueThread([th()], TODAY, { askedThisCall: true }), null);
  assert.equal(R.dueThread([th({ asked: 2 })], TODAY), null);
  assert.ok(R.dueThread([th({ asked: 1 })], TODAY), 'one earlier ask leaves one more');
  assert.equal(R.dueThread([th({ status: 'closed' })], TODAY), null);
  assert.equal(R.dueThread([th({ status: 'expired' })], TODAY), null);
  assert.equal(R.dueThread([th({ text: '  ' })], TODAY), null);
  assert.equal(R.dueThread(null, TODAY), null); assert.equal(R.dueThread([null, {}], TODAY), null);
});

test('dueThread: an undated worry or plan is followed up from the next day for ten days; dated ones come first; the nearest date wins', () => {
  const w = th({ due: '', kind: 'worry', who: 'Mike', text: 'worried about the test results', told: '2026-10-27' });
  assert.equal(R.dueThread([w], TODAY).kind, 'worry');
  assert.equal(R.dueThread([{ ...w, told: TODAY }], TODAY), null, 'not on the same day it was told');
  assert.equal(R.dueThread([{ ...w, told: '2026-10-18' }], TODAY).kind, 'worry', 'exactly 10 days');
  assert.equal(R.dueThread([{ ...w, told: '2026-10-17' }], TODAY), null, 'older than 10 days');
  assert.equal(R.dueThread([w, th()], TODAY).kind, 'event', 'dated before undated');
  assert.equal(R.dueThread([th({ due: '2026-10-20', text: 'older' }), th({ due: '2026-10-27', text: 'newer' })], TODAY).text, 'newer', 'the most recently passed date');
});

test('threadFact: facts only (who, what, the date worked out, when told), never a sentence to say', () => {
  assert.equal(R.threadFact(th(), TODAY), 'Priya: visiting for the weekend, was due 2026-10-26 (2 days ago); told 2026-10-22');
  assert.equal(R.threadFact(th({ due: '', who: '', text: 'worried about the results', told: '2026-10-27' }), TODAY), 'worried about the results; told 2026-10-27');
  assert.doesNotMatch(R.threadFact(th(), TODAY), /["“”?]/, 'no quote, no question');
});

test('expire: only open threads past their window are marked expired; nothing is deleted or changed otherwise', () => {
  const list = [th({ due: '2026-10-01' }), th(), th({ status: 'closed', due: '2026-09-01' }), th({ due: '', told: '2026-10-01' }), th({ due: '', told: '2026-10-25' }), null];
  const out = R.expire(list, TODAY);
  assert.deepEqual(out.map((t) => t && t.status), ['expired', 'open', 'closed', 'expired', 'open', null]);
  assert.equal(out.length, list.length);
  assert.equal(list[0].status, 'open', 'the input is not mutated');
});

test('recall.js is pure: no network, no file, no Spark, and no module that has any', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'recall.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/require\(|fetch\(|process\.env|writeFile|readFile/.test(src));
});
