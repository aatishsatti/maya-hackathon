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

// ---------------------------------------------------------------- mergeThreads: Spark proposes, code merges
let seq = 0; const mk = () => `tabc${String(++seq).padStart(3, '0')}`;
const old = (o = {}) => ({ id: 'told01', who: 'Priya', text: 'visiting for the weekend', due: '2026-10-26', kind: 'event', status: 'open', asked: 1, told: '2026-10-22', ...o });

test('mergeThreads: a new open thread gets an id, today as told, and nothing asked; told and asked are never Spark\'s', () => {
  const out = R.mergeThreads([], [{ who: 'Mike', text: 'blood test on Tuesday', due: '2026-11-03', kind: 'event', status: 'open', asked: 9, told: '1999-01-01' }], TODAY, mk);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 'tabc001', who: 'Mike', text: 'blood test on Tuesday', due: '2026-11-03', kind: 'event', status: 'open', asked: 0, told: TODAY });
});

test('mergeThreads: a thread Spark leaves out is kept exactly; a missing or garbage list changes nothing; the input is not mutated', () => {
  const before = [old()];
  const snap = JSON.stringify(before);
  assert.deepEqual(R.mergeThreads(before, [], TODAY, mk), before);
  for (const bad of [undefined, null, 'x', 7, {}]) assert.deepEqual(R.mergeThreads(before, bad, TODAY, mk), before);
  R.mergeThreads(before, [{ id: 'told01', status: 'closed' }], TODAY, mk);
  assert.equal(JSON.stringify(before), snap);
});

test('mergeThreads: closing by id keeps told and asked; a closed thread never reopens; a new thread cannot arrive already closed', () => {
  let out = R.mergeThreads([old()], [{ id: 'told01', status: 'closed' }], TODAY, mk);
  assert.equal(out[0].status, 'closed'); assert.equal(out[0].asked, 1); assert.equal(out[0].told, '2026-10-22'); assert.equal(out[0].text, 'visiting for the weekend');
  out = R.mergeThreads(out, [{ id: 'told01', status: 'open', text: 'something else', due: '2026-11-30' }], TODAY, mk);
  assert.equal(out[0].status, 'closed'); assert.equal(out[0].text, 'visiting for the weekend', 'a closed thread is left alone');
  out = R.mergeThreads([], [{ who: 'Mike', text: 'already over', status: 'closed' }], TODAY, mk);
  assert.deepEqual(out, [], 'a thread that was never open is not recorded');
});

test('mergeThreads: the same person and words (even without the id) is the same thread; a changed date updates it', () => {
  let out = R.mergeThreads([old()], [{ who: 'priya', text: 'Visiting for the weekend!', status: 'open' }], TODAY, mk);
  assert.equal(out.length, 1, 'no duplicate');
  out = R.mergeThreads([old()], [{ id: 'told01', due: '2026-10-30' }], TODAY, mk);
  assert.equal(out[0].due, '2026-10-30'); assert.equal(out[0].asked, 1);
});

test('mergeThreads: bad fields are normalised, never trusted', () => {
  const out = R.mergeThreads([], [{ who: 'M'.repeat(90), text: 'x'.repeat(500), due: 'next week', kind: 'secret', status: 'whatever' }, { text: '   ' }, null, 5], TODAY, mk);
  assert.equal(out.length, 1);
  assert.equal(out[0].who.length, 40); assert.equal(out[0].text.length, 200);
  assert.equal(out[0].due, ''); assert.equal(out[0].kind, 'plan', 'undated, unknown kind -> plan'); assert.equal(out[0].status, 'open');
  assert.equal(R.mergeThreads([], [{ text: 'dinner', due: '2026-11-01', kind: 'nonsense' }], TODAY, mk)[0].kind, 'event', 'dated, unknown kind -> event');
});

test('mergeThreads: threads past their window are expired on the way through, and the list is capped with open ones kept first', () => {
  const out = R.mergeThreads([old({ due: '2026-09-01' })], [], TODAY, mk);
  assert.equal(out[0].status, 'expired');
  const many = Array.from({ length: 30 }, (_, i) => old({ id: `tc${i}`, text: `closed ${i}`, status: 'closed' }));
  const capped = R.mergeThreads([...many, old({ id: 'topen', text: 'still open', status: 'open', due: '2026-10-27' })], [], TODAY, mk);
  assert.equal(capped.length, R.MAX_THREADS); assert.ok(capped.some((t) => t.id === 'topen'), 'the open one survives the cap');
  assert.ok(!capped.some((t) => t.id === 'tc0'), 'the oldest closed ones go first');
});

test('heavyTalk: a wide net that only blocks a follow-up; every way of saying they do not want to live is caught, ordinary talk is not', () => {
  for (const t of ['I do not want to live anymore', "I don't want to live", 'I dont want to be here', 'I no longer want to go on', 'I wish I was dead', 'there is no point', 'I give up', 'I feel so alone', 'I am scared', 'My head hurts', 'I fell in the kitchen', 'I got a call about my bank', 'I miss him so much', 'I am worried about it']) assert.equal(R.heavyTalk(t), true, t);
  for (const t of ['I am doing fine today, thank you.', 'The roses are finished I think.', 'I made some soup.', 'Priya came by on Saturday.', 'The tea is getting cold', '']) assert.equal(R.heavyTalk(t), false, t);
});

const CB_MEM = {
  people: [{ name: 'Leo', relationship: 'grandson', birthday: '', stories: [{ text: 'plays chess at school', told: '2026-10-20' }] }],
  events: [],
  preferences: [
    { who: 'Mathew', text: 'likes ginger and lemon tea since college', told: '2026-10-18' },
    { who: 'Mathew', text: 'likes iced coffee', told: '2026-10-19' },
    { who: 'Mathew', text: 'loves dark chocolate', told: '2026-10-21' },
  ],
  current: [],
  topics: [],
  threads: [],
};

test('callbackFact (1): topic matches senior-told fact -> callback eligible once with fact + topic match only', () => {
  const cb = R.callbackFact(CB_MEM, 'I am making a warm cup of tea right now.', TODAY, { ownerName: 'Mathew' });
  assert.ok(cb, 'topic match on tea returns a callback');
  assert.equal(cb.topic, 'tea');
  assert.match(cb.fact, /ginger and lemon tea since college/);
  assert.doesNotMatch(cb.fact, /["“”?]/, 'code supplies fact only, never a quoted sentence or question');

  const coffee = R.callbackFact(CB_MEM, 'I might brew some coffee this afternoon.', TODAY, { ownerName: 'Mathew' });
  assert.ok(coffee);
  assert.equal(coffee.topic, 'coffee');
  assert.match(coffee.fact, /iced coffee/);

  const grandson = R.callbackFact(CB_MEM, 'My grandson called me earlier today.', TODAY, { ownerName: 'Mathew' });
  assert.ok(grandson);
  assert.equal(grandson.topic, 'grandson');
  assert.match(grandson.fact, /Leo \(grandson\): plays chess at school/);
});

test('callbackFact (2): topic does not match -> no callback', () => {
  assert.equal(R.callbackFact(CB_MEM, 'The weather is sunny and the roses are blooming.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(CB_MEM, 'I watched a documentary about old airplanes.', TODAY, { ownerName: 'Mathew' }), null);
});

test('callbackFact (3): same fact already mentioned this turn -> no callback', () => {
  assert.equal(R.callbackFact(CB_MEM, 'I am drinking ginger and lemon tea like I have since college.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(CB_MEM, 'I just made myself some ginger tea.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(CB_MEM, 'I am having an iced coffee right now.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(CB_MEM, 'I had some dark chocolate after lunch.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(CB_MEM, 'My grandson Leo plays chess at school.', TODAY, { ownerName: 'Mathew' }), null);
});

test('callbackFact (4): second callback in same conversation -> blocked; reset on new conversation (session-only)', () => {
  const memory = require('../memory');
  const { Call } = require('../call');
  const { ChatSession } = require('../chat');
  const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };

  const call = new Call({ send() {}, readyState: 1 }, 'test-key');
  clearInterval(call.endTimer);
  call.profile = profile;
  call.tz = 'America/New_York';

  call.setFocus('I am making a cup of tea right now.');
  assert.ok(call.focus.callback, 'first matching turn in conversation gets callback');
  const note1 = memory.profileNote(profile, call.tz, call.focus);
  assert.match(note1, /RELEVANT MEMORY CALLBACK.*topic match: tea.*ginger and lemon tea since college/);
  call.commitReminder('What kind of tea did you make, since I remember you like ginger and lemon tea?');
  assert.equal(call.callbackUsed, true);

  call.setFocus('I might also have some coffee or chocolate later.');
  assert.equal(call.focus.callback, null, 'second callback in same call conversation is blocked');
  const note2 = memory.profileNote(profile, call.tz, call.focus);
  assert.doesNotMatch(note2, /RELEVANT MEMORY CALLBACK/);

  const chat1 = new ChatSession(profile, 'America/New_York');
  assert.equal(chat1.callbackUsed, false, 'new conversation starts with callbackUsed = false');
  chat1.setFocus('I am thinking about having some coffee.');
  assert.ok(chat1.focus.callback, 'eligible once in new chat conversation');
  chat1.commitReminder('What kind of coffee are you thinking of, since you enjoy iced coffee?');
  assert.equal(chat1.callbackUsed, true);
  chat1.setFocus('And maybe some tea after.');
  assert.equal(chat1.focus.callback, null, 'second callback in same chat conversation is blocked');
});

test('callbackFact (5): family-set, dashboard, and inferred facts -> never used', () => {
  const famMem = {
    people: [{ name: 'Leo', relationship: 'grandson', by: 'family', stories: [{ text: 'plays chess at school', by: 'family', told: TODAY }] }],
    events: [{ who: 'Mathew', text: 'family lunch on Sunday', source: 'family dashboard', told: TODAY }],
    preferences: [
      { who: 'Mathew', text: 'likes ginger and lemon tea since college', by: 'family', told: TODAY },
      { who: 'Mathew', text: 'likes iced coffee', owner: 'family', told: TODAY },
      { who: 'Mathew', text: 'loves dark chocolate', source: 'dashboard', told: TODAY },
      { who: 'Mathew', text: 'enjoys green tea in the afternoon', inferred: true, told: TODAY },
      { who: 'Mathew', text: 'family-set note about chamomile tea', told: TODAY },
    ],
    current: [],
    topics: [],
    threads: [],
  };
  assert.equal(R.callbackFact(famMem, 'I am making a cup of tea.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(famMem, 'I could go for some coffee.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(famMem, 'I want some chocolate.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(famMem, 'My grandson called me.', TODAY, { ownerName: 'Mathew' }), null);
});

test('callbackFact (6): daily call record and medicine-related facts -> never used as callback fact', () => {
  const mixed = {
    id: 'fbde4db7',
    name: 'Mathew',
    reminders: [
      { id: 'r1', task: 'Friendly daily call from Maya at 2:12 PM every day', by: 'senior', social: { h: 14, mi: 12 }, type: 'daily-call' },
    ],
    memory: {
      people: [],
      events: [
        { who: 'Mathew', text: 'daily call from Maya at 2:12 PM every day', told: TODAY },
        { who: 'Mathew', text: 'doctor appointment for blood pressure', told: TODAY },
      ],
      preferences: [
        { who: 'Mathew', text: 'Friendly daily call at 2:12 PM every day', social: true, told: TODAY },
        { who: 'Mathew', text: 'takes vitamin D supplement and blood pressure pills with tea', told: TODAY },
        { who: 'Mathew', text: 'takes 500mg metformin tablet after coffee', told: TODAY },
      ],
      current: [
        { who: 'Mathew', text: 'ibuprofen medication for knee', told: TODAY },
      ],
      topics: [],
      threads: [],
    },
  };
  assert.equal(R.callbackFact(mixed, 'Will you give me a call today?', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(mixed, 'Let us talk about our daily call at 2:12 PM.', TODAY, { ownerName: 'Mathew' }), null);
  assert.equal(R.callbackFact(mixed, 'I am having a cup of tea and coffee.', TODAY, { ownerName: 'Mathew' }), null);
});

test('Fix 1.1 (1): callback note instructs question form (not assertion) when kind is not confirmed this turn; confirmed fact needs no question', () => {
  const memory = require('../memory');
  const { Call } = require('../call');
  const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
  const call = new Call({ send() {}, readyState: 1 }, 'test-key');
  clearInterval(call.endTimer);
  call.profile = profile;
  call.tz = 'America/New_York';

  call.setFocus('We had some tea with a friend.');
  assert.ok(call.focus.callback, 'callback selected when broad topic matches');
  assert.equal(call.focus.callback.confirmed, false);
  assert.equal(call.focus.callback.ask, true);
  assert.ok(call.focus.callback.unmentioned.includes('ginger'));
  const note = memory.profileNote(profile, call.tz, call.focus);
  assert.match(note, /question instruction: ask a non-leading question referencing this fact, do NOT assert it/);
  assert.match(note, /they have NOT confirmed the specific kind or detail in this turn, so do NOT assert or assume/);
  assert.match(note, /Separate past preference from today's event/);

  const confirmedFocus = { text: 'We had some ginger tea.', full: false, thread: '', callback: { ...call.focus.callback, confirmed: true, ask: false } };
  const confirmedNote = memory.profileNote(profile, call.tz, confirmedFocus);
  assert.match(confirmedNote, /confirmed this turn: yes.*warm acknowledgement in your own words is fine, no question needed/);
});

test('Fix 1.1 (2 & 3): challengeFact distinguishes true senior-told record vs no record (and excludes family-set facts)', () => {
  const memory = require('../memory');
  const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };

  const rec = R.challengeFact(CB_MEM, 'i never told you i had ginger tea', TODAY, { ownerName: 'Mathew' });
  assert.ok(rec);
  assert.equal(rec.status, 'recorded');
  assert.match(rec.fact, /Mathew: likes ginger and lemon tea since college; told 2026-10-18/);
  assert.equal(R.callbackFact(CB_MEM, 'i never told you i had ginger tea', TODAY, { ownerName: 'Mathew' }), null, 'no spontaneous callback on a challenge turn');
  const recNote = memory.profileNote(profile, 'America/New_York', { text: 'i never told you i had ginger tea', full: false, thread: '', callback: null, challenge: rec });
  assert.match(recNote, /MEMORY CHALLENGE \(true senior-told record;.*Mathew: likes ginger and lemon tea since college; told 2026-10-18/);
  assert.match(recNote, /NEVER say you added it yourself, guessed, or made it up/);

  const unrec = R.challengeFact(CB_MEM, 'i never told you i had chamomile tea', TODAY, { ownerName: 'Mathew' });
  assert.ok(unrec);
  assert.equal(unrec.status, 'unrecorded');
  assert.equal(unrec.fact, '');
  const unrecNote = memory.profileNote(profile, 'America/New_York', { text: 'i never told you i had chamomile tea', full: false, thread: '', callback: null, challenge: unrec });
  assert.match(unrecNote, /MEMORY CHALLENGE \(no record in their profile\)/);
  assert.match(unrecNote, /Say honestly and plainly in your own words that you do not have a note of that or cannot think of it right now/);

  const famOnly = {
    people: [], events: [], current: [], topics: [], threads: [],
    preferences: [{ who: 'Mathew', text: 'likes peppermint tea', by: 'family', told: TODAY }],
  };
  const famCh = R.challengeFact(famOnly, 'how do you know i like peppermint tea', TODAY, { ownerName: 'Mathew' });
  assert.ok(famCh);
  assert.equal(famCh.status, 'unrecorded', 'family-set fact is never treated as senior-told record');
});

test('Fix 1.1 (4): direct tell turn (senior says fact herself) -> acknowledgement via passive notes, no spontaneous callback, no challenge', () => {
  const memory = require('../memory');
  const { Call } = require('../call');
  const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
  const call = new Call({ send() {}, readyState: 1 }, 'test-key');
  clearInterval(call.endTimer);
  call.profile = profile;
  call.tz = 'America/New_York';

  call.setFocus('I am drinking ginger and lemon tea right now.');
  assert.equal(call.focus.callback, null, 'no spontaneous callback when senior states the fact herself');
  assert.equal(call.focus.challenge, null, 'not a challenge turn');
  assert.equal(call.callbackUsed, false);
  const note = memory.profileNote(profile, call.tz, call.focus);
  assert.match(note, /Notes that relate to what they just said.*likes ginger and lemon tea since college/);
  assert.doesNotMatch(note, /RELEVANT MEMORY CALLBACK/);
  assert.doesNotMatch(note, /MEMORY CHALLENGE/);
});

test('Fix 1.2 (1): later-turn assertion after callbackUsed is blocked; leading question is blocked; non-leading question passes', () => {
  const smart = require('../smart');
  const { Call } = require('../call');
  const prevGuard = process.env.MAYA_SMART_GUARD;
  process.env.MAYA_SMART_GUARD = 'on';
  try {
    const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
    const call = new Call({ send() {}, readyState: 1 }, 'test-key');
    clearInterval(call.endTimer);
    call.profile = profile;
    call.tz = 'America/New_York';
    call.callbackUsed = true; // callback already used earlier in this conversation

    call.setFocus('and we had some tea');
    assert.equal(call.focus.callback, null, 'callback not re-selected after callbackUsed = true');
    assert.equal(smart.breaks('Ginger tea with a friend hits just right.', call), 'callback-assert', 'assertion on later turn without callback active is blocked');
    assert.equal(smart.breaks('Did you two have ginger tea again together?', call), 'callback-assert', 'leading question assuming today was ginger is blocked');
    assert.equal(smart.breaks('What kind of tea did you two have today — I remember you like ginger and lemon tea?', call), null, 'non-leading question separating past preference from today passes');
  } finally {
    if (prevGuard === undefined) delete process.env.MAYA_SMART_GUARD;
    else process.env.MAYA_SMART_GUARD = prevGuard;
  }
});

test('Fix 1.2 (2): challenge with new kind ("ginger tea who told you I had ginger tea I had cinnamon tea") returns recorded for ginger, GUARD blocks denial, rewrite gives scoped correction', () => {
  const smart = require('../smart');
  const { Call } = require('../call');
  const prevGuard = process.env.MAYA_SMART_GUARD;
  process.env.MAYA_SMART_GUARD = 'on';
  try {
    const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
    const call = new Call({ send() {}, readyState: 1 }, 'test-key');
    clearInterval(call.endTimer);
    call.profile = profile;
    call.tz = 'America/New_York';

    const heard = 'ginger tea who told you I had ginger tea I had cinnamon tea';
    const ch = R.challengeFact(CB_MEM, heard, TODAY, { ownerName: 'Mathew', profileId: 'fbde4db7' });
    assert.ok(ch);
    assert.equal(ch.status, 'recorded');
    assert.equal(ch.challengeKind, 'event');
    assert.equal(ch.topic, 'ginger');
    assert.equal(ch.newToday, 'cinnamon');
    assert.match(ch.fact, /Mathew: likes ginger and lemon tea since college; told 2026-10-18/);

    call.setFocus(heard);
    assert.equal(
      smart.breaks("You're right, my mistake - it was cinnamon tea. I don't remember you telling me about ginger tea.", call),
      'challenge-denial',
      'GUARD blocks denial of recorded ginger tea preference',
    );
    const retryNote = smart.challengeRetryNote(call);
    assert.match(retryNote, /remembered preference fact: Mathew: likes ginger and lemon tea since college; told 2026-10-18/);
    assert.match(retryNote, /current kind today: cinnamon/);
    const scopedRewrite = 'My mistake for assuming today was ginger — I only asked because you told me earlier you like ginger and lemon tea since college, and cinnamon tea today sounds lovely.';
    assert.equal(smart.breaks(scopedRewrite, call), null, 'scoped correction acknowledging today inference, standing by ginger preference, and accepting cinnamon today passes GUARD');
  } finally {
    if (prevGuard === undefined) delete process.env.MAYA_SMART_GUARD;
    else process.env.MAYA_SMART_GUARD = prevGuard;
  }
});

test('Fix 1.2 (3): preference challenge vs event challenge: preference dispute stands by record; event dispute acknowledges today inference error without denying preference record and blocks arguing', () => {
  const memory = require('../memory');
  const smart = require('../smart');
  const { Call } = require('../call');
  const prevGuard = process.env.MAYA_SMART_GUARD;
  process.env.MAYA_SMART_GUARD = 'on';
  try {
    const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
    const call = new Call({ send() {}, readyState: 1 }, 'test-key');
    clearInterval(call.endTimer);
    call.profile = profile;
    call.tz = 'America/New_York';

    // Preference dispute ("i never told you i like ginger tea") -> challengeKind: 'preference'
    const prefCh = R.challengeFact(CB_MEM, 'i never told you i like ginger tea', TODAY, { ownerName: 'Mathew', profileId: 'fbde4db7' });
    assert.ok(prefCh);
    assert.equal(prefCh.status, 'recorded');
    assert.equal(prefCh.challengeKind, 'preference');
    call.setFocus('i never told you i like ginger tea');
    const prefNote = memory.profileNote(profile, call.tz, call.focus);
    assert.match(prefNote, /challenge kind: preference; fact: Mathew: likes ginger and lemon tea since college; told 2026-10-18/);
    assert.equal(smart.breaks('I guessed that one, sorry.', call), 'challenge-denial');
    assert.equal(smart.breaks('You did tell me earlier that you like ginger and lemon tea since college, and I was only asking from that note.', call), null);

    // Event dispute ("i never told you i had ginger tea today") -> challengeKind: 'event'
    const evCh = R.challengeFact(CB_MEM, 'i never told you i had ginger tea today', TODAY, { ownerName: 'Mathew', profileId: 'fbde4db7' });
    assert.ok(evCh);
    assert.equal(evCh.status, 'recorded');
    assert.equal(evCh.challengeKind, 'event');
    call.setFocus('i never told you i had ginger tea today');
    const evNote = memory.profileNote(profile, call.tz, call.focus);
    assert.match(evNote, /challenge kind: event; remembered preference fact: Mathew: likes ginger and lemon tea since college; told 2026-10-18/);
    assert.equal(smart.breaks("I don't remember you telling me about ginger tea.", call), 'challenge-denial', 'denying preference record is blocked');
    assert.equal(smart.breaks('You did say that you had ginger tea today.', call), 'challenge-argue', 'arguing that they had ginger today is blocked');
    assert.equal(smart.breaks('I did not know what kind of tea you had today — I only remembered you told me earlier that you like ginger and lemon tea since college.', call), null, 'scoped correction passes');
  } finally {
    if (prevGuard === undefined) delete process.env.MAYA_SMART_GUARD;
    else process.env.MAYA_SMART_GUARD = prevGuard;
  }
});

test('Fix 1.2 (4): no-record challenge blocks false-memory claim and hard denial ("you never told me"), allows honest "I don\'t have a note of that / I can\'t think of it right now"', () => {
  const smart = require('../smart');
  const { Call } = require('../call');
  const prevGuard = process.env.MAYA_SMART_GUARD;
  process.env.MAYA_SMART_GUARD = 'on';
  try {
    const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
    const call = new Call({ send() {}, readyState: 1 }, 'test-key');
    clearInterval(call.endTimer);
    call.profile = profile;
    call.tz = 'America/New_York';

    const unrec = R.challengeFact(CB_MEM, 'how do you know i like hibiscus tea', TODAY, { ownerName: 'Mathew', profileId: 'fbde4db7' });
    assert.ok(unrec);
    assert.equal(unrec.status, 'unrecorded');

    call.setFocus('how do you know i like hibiscus tea');
    assert.equal(smart.breaks('You told me earlier that you love hibiscus tea.', call), 'challenge-unrecorded', 'false memory claim is blocked');
    assert.equal(smart.breaks('You never told me that.', call), 'challenge-hard-denial', 'hard denial of senior history ("you never told me") is blocked');
    assert.equal(smart.breaks("I don't have a note of that and I can't think of it right now.", call), null, 'honest unsubstantiated wording passes');
  } finally {
    if (prevGuard === undefined) delete process.env.MAYA_SMART_GUARD;
    else process.env.MAYA_SMART_GUARD = prevGuard;
  }
});

test('Fix 1.2 (5): bare challenge ("How do you know that?") resolves ONLY against last delivered callback in this conversation, not any convenient memory, not family-only fact, not another senior record, not after intervening topic', () => {
  const { Call } = require('../call');
  const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };

  // Without a delivered callback -> unrecorded (does NOT retrieve any convenient memory from CB_MEM)
  const noPrior = R.challengeFact(CB_MEM, 'How do you know that?', TODAY, { ownerName: 'Mathew', profileId: 'fbde4db7', lastCallback: null });
  assert.ok(noPrior);
  assert.equal(noPrior.status, 'unrecorded');

  // Selected but NOT delivered callback -> unrecorded
  const undelivered = R.challengeFact(CB_MEM, 'How do you know that?', TODAY, {
    ownerName: 'Mathew',
    profileId: 'fbde4db7',
    lastCallback: { topic: 'tea', who: 'Mathew', text: 'likes ginger and lemon tea since college', told: '2026-10-18', fact: 'Mathew: likes ginger and lemon tea since college; told 2026-10-18', delivered: false, fresh: true, profileId: 'fbde4db7' },
  });
  assert.equal(undelivered.status, 'unrecorded');

  // Another senior's record -> unrecorded
  const otherSenior = R.challengeFact(CB_MEM, 'How do you know that?', TODAY, {
    ownerName: 'Mathew',
    profileId: 'fbde4db7',
    lastCallback: { topic: 'tea', who: 'Other', text: 'likes ginger and lemon tea since college', told: '2026-10-18', fact: 'Other: likes ginger and lemon tea since college; told 2026-10-18', delivered: true, fresh: true, profileId: 'other-id' },
  });
  assert.equal(otherSenior.status, 'unrecorded');

  // Family-only fact -> unrecorded
  const famLast = R.challengeFact(CB_MEM, 'How do you know that?', TODAY, {
    ownerName: 'Mathew',
    profileId: 'fbde4db7',
    lastCallback: { topic: 'tea', who: 'Mathew', text: 'likes ginger and lemon tea since college', by: 'family', told: '2026-10-18', fact: 'Mathew: likes ginger and lemon tea since college; told 2026-10-18', delivered: true, fresh: true, profileId: 'fbde4db7' },
  });
  assert.equal(famLast.status, 'unrecorded');

  // Delivered callback in this conversation -> recorded; after an unrelated intervening turn -> unrecorded
  const call = new Call({ send() {}, readyState: 1 }, 'test-key');
  clearInterval(call.endTimer);
  call.profile = profile;
  call.tz = 'America/New_York';
  call.setFocus('We had some tea.');
  call.commitReminder('What kind of tea did you have today, since I remember you like ginger and lemon tea?');
  call.setFocus('How do you know that?');
  assert.ok(call.focus.challenge);
  assert.equal(call.focus.challenge.status, 'recorded');
  assert.match(call.focus.challenge.fact, /likes ginger and lemon tea since college/);

  // Intervening unrelated turn clears freshness of lastCallback for bare challenges
  call.setFocus('The weather is sunny.');
  call.commitReminder('A sunny afternoon sounds lovely.');
  call.setFocus('How do you know that?');
  assert.ok(call.focus.challenge);
  assert.equal(call.focus.challenge.status, 'unrecorded', 'intervening unrelated topic prevents bare challenge from binding to stale callback');
});

test('Fix 1.2 (6): changed preference ("I don\'t like ginger tea anymore") is accepted in conversation, older preference does not override it, and no promise to forget/update is allowed', () => {
  const memory = require('../memory');
  const smart = require('../smart');
  const { Call } = require('../call');
  const prevGuard = process.env.MAYA_SMART_GUARD;
  process.env.MAYA_SMART_GUARD = 'on';
  try {
    const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
    const call = new Call({ send() {}, readyState: 1 }, 'test-key');
    clearInterval(call.endTimer);
    call.profile = profile;
    call.tz = 'America/New_York';

    call.setFocus("I don't like ginger tea anymore");
    assert.ok(call.focus.changedPref);
    assert.equal(call.focus.changedPref.topic, 'ginger');
    const note = memory.profileNote(profile, call.tz, call.focus);
    assert.match(note, /PREFERENCE CHANGE IN CONVERSATION.*NEVER promise or claim to forget, delete, or update/);

    assert.equal(smart.breaks('But you always love ginger tea!', call), 'changed-pref-override', 'overriding current preference with older note is blocked');
    assert.equal(smart.breaks("I've updated my notes and deleted ginger tea from your profile.", call), 'changed-pref-promise', 'promising to forget/update saved notes is blocked');
    assert.equal(smart.breaks('Tastes change — what kind of tea do you enjoy having now?', call), null, 'accepting current preference in conversation passes');

    // Subsequent tea turn in same conversation does NOT surface disavowed ginger preference
    call.setFocus('I am making a cup of tea.');
    assert.equal(call.focus.callback, null, 'disavowed preference is not offered as callback in same conversation');
    const noteAfter = memory.profileNote(profile, call.tz, call.focus);
    assert.doesNotMatch(noteAfter, /ginger and lemon tea/);
  } finally {
    if (prevGuard === undefined) delete process.env.MAYA_SMART_GUARD;
    else process.env.MAYA_SMART_GUARD = prevGuard;
  }
});

test('Fix 1.2 (7): delivery-counted once-only: selected but discarded callback does NOT consume allowance, delivered callback DOES, user-prompted recall does NOT reset spontaneous allowance', () => {
  const memory = require('../memory');
  const { Call } = require('../call');
  const profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
  const call = new Call({ send() {}, readyState: 1 }, 'test-key');
  clearInterval(call.endTimer);
  call.profile = profile;
  call.tz = 'America/New_York';

  // Turn 1: callback selected, but reply omits the callback fact (e.g. senior's point took priority) -> allowance NOT consumed
  call.setFocus('We had some tea.');
  assert.ok(call.focus.callback, 'callback selected on turn 1');
  assert.equal(call.callbackUsed, false, 'selection alone does not set callbackUsed');
  call.commitReminder('That sounds like a lovely visit with your friend.');
  assert.equal(call.callbackUsed, false, 'omitted/discarded callback does not consume once-per-conversation allowance');

  // Turn 2: callback selected again and actually delivered -> allowance IS consumed
  call.setFocus('Now I am having some coffee.');
  assert.ok(call.focus.callback, 'callback still available because turn 1 did not deliver it');
  assert.match(call.focus.callback.fact, /iced coffee/);
  call.commitReminder('What kind of coffee are you having today, since I remember you like iced coffee?');
  assert.equal(call.callbackUsed, true, 'delivered callback consumes allowance');

  // Turn 3: user-prompted recall ("Tell me what we talked about?") stays allowed, does NOT reset spontaneous allowance, and notes already-mentioned fact
  call.setFocus('Tell me what we talked about?');
  assert.equal(call.focus.full, true, 'user-prompted recall sets full memory focus');
  assert.equal(call.callbackUsed, true, 'user-prompted recall does not reset spontaneous callbackUsed');
  const recallNote = memory.profileNote(profile, call.tz, call.focus);
  assert.match(recallNote, /do NOT redundantly repeat a fact already mentioned earlier in this conversation \(Mathew: likes iced coffee; told 2026-10-19\)/);

  // Turn 4: another spontaneous callback after user-prompted recall is still blocked
  call.setFocus('I might have some chocolate later.');
  assert.equal(call.focus.callback, null, 'spontaneous callback remains used after user-prompted recall');
});

test('Correct & Forget (1): exact item correction and deletion verify disk readback, update dependent recall copies, preserve callbackUsed counter, and prevent pending extraction from restoring old fact', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-memedit-'));
  const prevData = process.env.MAYA_DATA_DIR;
  const prevCare = process.env.MAYA_CARE_DIR;
  process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
  process.env.MAYA_CARE_DIR = path.join(tmp, 'care');

  const brainPath = require.resolve('../brain');
  const savedBrain = require.cache[brainPath];
  const memPath = require.resolve('../memory');
  const savedMem = require.cache[memPath];
  const callPath = require.resolve('../call');
  const savedCall = require.cache[callPath];

  try {
    // Stub brain.sparkComplete to simulate a stale pending extraction trying to restore ginger tea and chess
    require.cache[brainPath] = {
      id: brainPath,
      filename: brainPath,
      loaded: true,
      exports: {
        ...(savedBrain ? savedBrain.exports : {}),
        requireRealEnv() {},
        streamSpeech: async () => {},
        sparkStream: async () => '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Okay.',
        sparkComplete: async () => JSON.stringify({
          people: [{ name: 'Leo', relationship: 'grandson', birthday: '', stories: ['plays chess at school'] }],
          events: [],
          preferences: ['likes ginger and lemon tea since college', 'likes iced coffee', 'loves dark chocolate'],
          current: [],
          topics: ['ginger and lemon tea', 'chess with Leo'],
          threads: [],
          removed: [],
        }),
      },
    };
    delete require.cache[memPath];
    delete require.cache[callPath];
    const memory = require('../memory');
    const { Call } = require('../call');

    const suffix = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
    const p = memory.createProfile(`EditSenior${suffix}`, 'male');
    const loaded = memory.load(p.id);
    loaded.memory = JSON.parse(JSON.stringify(CB_MEM));
    loaded.memory.topics = [
      { text: 'ginger and lemon tea', told: '2026-10-18' },
      { text: 'plays chess at school', told: '2026-10-20' },
    ];
    loaded.memory.threads = [
      { id: 't1', kind: 'plan', who: loaded.name, text: 'making ginger and lemon tea', date: '', told: '2026-10-18', status: 'open', asked: 0 },
      { id: 'r1', kind: 'reminder', who: loaded.name, text: 'call dentist', date: TODAY, told: TODAY, status: 'open', asked: 0 },
    ];
    fs.writeFileSync(path.join(process.env.MAYA_DATA_DIR, `${p.id}.json`), JSON.stringify(loaded, null, 2));

    const call = new Call({ send() {}, readyState: 1 }, 'test-key');
    clearInterval(call.endTimer);
    call.profile = loaded;
    call.tz = 'America/New_York';
    call.callbackUsed = true;
    call._lastCallback = { fact: 'Mathew: likes ginger and lemon tea since college; told 2026-10-18', text: 'likes ginger and lemon tea since college', topic: 'tea', delivered: true, fresh: true, profileId: p.id };

    // 1. Correct exact item: replace chess with basketball on grandson Leo's story
    call.setFocus('Please correct your note: my grandson Leo plays basketball at school, not chess.');
    assert.ok(call.focus.memEdit);
    assert.equal(call.focus.memEdit.status, 'verified');
    assert.equal(call.focus.memEdit.op, 'correct');
    assert.match(call.focus.memEdit.newFact, /basketball/);
    assert.equal(call.callbackUsed, true, 'callbackUsed once-only counter is preserved');
    const diskAfterCorrect = JSON.parse(fs.readFileSync(path.join(process.env.MAYA_DATA_DIR, `${p.id}.json`), 'utf8'));
    assert.equal(diskAfterCorrect.memory.people[0].stories[0].text, 'plays basketball at school');
    assert.ok(!diskAfterCorrect.memory.topics.some((t) => /chess/i.test(t.text)), 'dependent topic copy referencing chess was removed');

    // 2. Forget exact item: remove ginger and lemon tea preference and dependent topic/plan copies (while keeping reminder thread r1)
    call.setFocus('Please forget what I told you about liking ginger and lemon tea.');
    assert.ok(call.focus.memEdit);
    assert.equal(call.focus.memEdit.status, 'verified');
    assert.equal(call.focus.memEdit.op, 'forget');
    assert.equal(call._lastCallback, null, 'dependent _lastCallback for forgotten fact is cleared');
    assert.equal(call.callbackUsed, true, 'callbackUsed once-only counter remains true');
    const diskAfterForget = JSON.parse(fs.readFileSync(path.join(process.env.MAYA_DATA_DIR, `${p.id}.json`), 'utf8'));
    assert.ok(!diskAfterForget.memory.preferences.some((x) => /ginger/i.test(x.text)), 'ginger tea removed from disk preferences');
    assert.ok(!diskAfterForget.memory.topics.some((t) => /ginger/i.test(t.text)), 'dependent ginger topic removed');
    assert.ok(!diskAfterForget.memory.threads.some((t) => /ginger/i.test(t.text)), 'dependent non-reminder thread removed');
    assert.ok(diskAfterForget.memory.threads.some((t) => t.id === 'r1'), 'reminder thread is preserved');

    // 3. Pending extraction does NOT restore forgotten ginger tea or overwritten chess story
    memory.startCall(p.id, 'pending-call-1', 'America/New_York');
    memory.appendTurn(p.id, 'pending-call-1', { label: 'A', who: loaded.name, text: 'We talked about iced coffee.', userSaid: true });
    await memory.flushPending(p.id);
    const diskAfterExtract = JSON.parse(fs.readFileSync(path.join(process.env.MAYA_DATA_DIR, `${p.id}.json`), 'utf8'));
    assert.ok(!diskAfterExtract.memory.preferences.some((x) => /ginger/i.test(x.text)), 'pending extraction did NOT restore forgotten ginger tea');
    assert.ok(!diskAfterExtract.memory.people[0].stories.some((s) => /chess/i.test(s.text)), 'pending extraction did NOT restore overwritten chess story');
    assert.ok(diskAfterExtract.memory.people[0].stories.some((s) => /basketball/i.test(s.text)), 'corrected basketball story is preserved after extraction');
  } finally {
    if (savedBrain) require.cache[brainPath] = savedBrain;
    if (savedMem) require.cache[memPath] = savedMem;
    if (savedCall) require.cache[callPath] = savedCall;
    if (prevData === undefined) delete process.env.MAYA_DATA_DIR; else process.env.MAYA_DATA_DIR = prevData;
    if (prevCare === undefined) delete process.env.MAYA_CARE_DIR; else process.env.MAYA_CARE_DIR = prevCare;
  }
});

test('Correct & Forget (2): unclear target, ambiguous target, no-match, failed write verification, and protected categories (safety/medicine/daily-call/reminder/scam/family)', () => {
  const fs = require('node:fs');
  const memory = require('../memory');
  const smart = require('../smart');
  const { Call } = require('../call');
  const prevGuard = process.env.MAYA_SMART_GUARD;
  process.env.MAYA_SMART_GUARD = 'on';

  try {
    // 1. Unclear target (vague request -> no broad deletion)
    const vague = R.memoryEditIntent(CB_MEM, 'Please forget what I told you.', TODAY, { ownerName: 'Mathew' });
    assert.ok(vague);
    assert.equal(vague.status, 'unclear');
    assert.equal(vague.reason, 'missing-target');

    // 2. Ambiguous target (two distinct tea notes -> asks which one)
    const twoTeas = {
      ...CB_MEM,
      preferences: [
        { who: 'Mathew', text: 'likes ginger tea in the morning', told: '2026-10-18' },
        { who: 'Mathew', text: 'likes peppermint tea after dinner', told: '2026-10-19' },
      ],
    };
    const amb = R.memoryEditIntent(twoTeas, 'Please delete your note about tea.', TODAY, { ownerName: 'Mathew' });
    assert.ok(amb);
    assert.equal(amb.status, 'unclear');
    assert.equal(amb.reason, 'ambiguous-target');
    assert.equal(amb.candidates.length, 2);

    // 3. Unclear replacement ("correct your note about ginger tea" without saying what to change it to)
    const noRep = R.memoryEditIntent(CB_MEM, 'Please correct your note about ginger tea.', TODAY, { ownerName: 'Mathew' });
    assert.ok(noRep);
    assert.equal(noRep.status, 'unclear');
    assert.equal(noRep.reason, 'missing-replacement');

    // 4. No-match -> status: 'not-found', blocks "you never told me" and blocks claiming deletion
    const noMatch = R.memoryEditIntent(CB_MEM, 'Please forget what I told you about skydiving.', TODAY, { ownerName: 'Mathew' });
    assert.ok(noMatch);
    assert.equal(noMatch.status, 'not-found');
    const call = new Call({ send() {}, readyState: 1 }, 'test-key');
    clearInterval(call.endTimer);
    call.profile = { id: 'fbde4db7', name: 'Mathew', gender: 'male', memory: JSON.parse(JSON.stringify(CB_MEM)) };
    call._memEdit = noMatch;
    call.focus = { text: 'Please forget what I told you about skydiving.', full: false, memEdit: noMatch };
    assert.equal(smart.breaks('You never told me about skydiving.', call), 'memedit-hard-denial');
    assert.equal(smart.breaks("I've deleted that from my notes.", call), 'memedit-unverified');
    assert.equal(smart.breaks("I can't find a matching note about skydiving in what I have saved.", call), null);

    // 5. Failed write / unverified disk readback -> status: 'failed', blocks success claim and blocks backup/log overclaims
    const readyPlan = R.memoryEditIntent(CB_MEM, 'Please forget that I like iced coffee.', TODAY, { ownerName: 'Mathew' });
    assert.equal(readyPlan.status, 'ready');
    const origRead = fs.readFileSync;
    fs.readFileSync = () => { throw new Error('simulated disk readback failure'); };
    let failedRes;
    try {
      failedRes = memory.applyMemoryEdit('nonexistent-id', readyPlan, { tz: 'America/New_York' });
    } finally {
      fs.readFileSync = origRead;
    }
    assert.equal(failedRes.status, 'failed');
    call._memEdit = failedRes;
    call.focus = { text: 'Please forget that I like iced coffee.', full: false, memEdit: failedRes };
    assert.equal(smart.breaks("I've deleted iced coffee from my notes.", call), 'memedit-unverified');
    assert.equal(smart.breaks("I couldn't confirm that change went through right now.", call), null);
    call._memEdit = { op: 'forget', status: 'verified', oldFact: 'Mathew: likes iced coffee; told 2026-10-19' };
    assert.equal(smart.breaks("I removed that from my saved notes and wiped it from every backup and server log.", call), 'memedit-overclaim');

    // 6. Protected categories: safety, medicine, daily-call, reminder, scam, family-owned
    assert.equal(R.memoryEditIntent(CB_MEM, 'Forget my safety incident record.', TODAY).status, 'protected');
    assert.equal(R.memoryEditIntent(CB_MEM, 'Delete my medicine note about blood pressure pills.', TODAY).status, 'protected');
    assert.equal(R.memoryEditIntent(CB_MEM, 'Forget my daily call at 2:12 PM.', TODAY).status, 'protected');
    assert.equal(R.memoryEditIntent(CB_MEM, 'Delete my reminder for tomorrow.', TODAY).status, 'protected');
    assert.equal(R.memoryEditIntent(CB_MEM, 'Forget the scam alert.', TODAY).status, 'protected');
    const famMem = {
      people: [], events: [], current: [], topics: [], threads: [],
      preferences: [{ who: 'Mathew', text: 'likes chamomile tea', by: 'family', told: TODAY }],
    };
    const famEdit = R.memoryEditIntent(famMem, 'Forget the note about chamomile tea.', TODAY, { ownerName: 'Mathew' });
    assert.equal(famEdit.status, 'protected');
    assert.equal(famEdit.category, 'family');
  } finally {
    if (prevGuard === undefined) delete process.env.MAYA_SMART_GUARD;
    else process.env.MAYA_SMART_GUARD = prevGuard;
  }
});

test('Bounded In-Conversation Initiative: appropriate invitation once per conversation, deliberate silence, interruption/scam/safety guards, decline suppression, and quiet-hours ON/OFF', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-nudge-'));
  const prevData = process.env.MAYA_DATA_DIR;
  const prevCare = process.env.MAYA_CARE_DIR;
  process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
  process.env.MAYA_CARE_DIR = path.join(tmp, 'care');

  const care = require('../care');
  const memory = require('../memory');
  const smart = require('../smart');
  const { Call } = require('../call');

  try {
    const suffix = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
    const p = memory.createProfile(`NudgeSenior${suffix}`, 'male');
    care.setTimezone(p.id, 'America/New_York', 'manual');
    const loaded = memory.load(p.id);
    loaded.memory = JSON.parse(JSON.stringify(CB_MEM));

    const makeCall = () => {
      const c = new Call({ send() {}, readyState: 1 }, 'test-key');
      clearInterval(c.endTimer);
      c.profile = memory.load(p.id);
      c.tz = 'America/New_York';
      c.userTurns = 1;
      c.history = [{ role: 'user', content: `${loaded.name}: The weather is nice.` }];
      c.dynamicLine = async ({ what }) => ({ full: '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Still here with you.', said: 'Still here with you.', tries: 1, what });
      return c;
    };

    // 1. Before any user turn (userTurns === 0): no proactive nudge on initial silent pickup
    const c0 = makeCall();
    c0.userTurns = 0;
    assert.equal(c0.proactiveNudge(), null, 'no proactive nudge before senior has spoken in the conversation');

    // 2. Deliberate silence / unfinished request ("Hold on a second", "Let me think...") -> no proactive nudge
    const cDelib = makeCall();
    cDelib.history = [{ role: 'user', content: `${loaded.name}: Hold on a second, let me think...` }];
    assert.equal(cDelib.proactiveNudge(), null, 'deliberate pause / unfinished request suppresses nudge');

    // 3. Interruption / active speech / partial turn / safety / unresolved scam -> no proactive nudge
    const cBusy = makeCall();
    cBusy.curTurn = { partial: 'I was going to say' };
    assert.equal(cBusy.proactiveNudge(), null, 'unfinished partial speech suppresses nudge');
    cBusy.curTurn = null;
    cBusy.safety = true;
    assert.equal(cBusy.proactiveNudge(), null, 'safety handling suppresses nudge');
    cBusy.safety = false;
    cBusy.scamReply = 'warn';
    assert.equal(cBusy.proactiveNudge(), null, 'scam exchange suppresses nudge');

    // 4. Quiet hours OFF by default -> allows ONE proactive nudge; second nudge in same conversation -> blocked; stage >= 1 stops nudging
    assert.equal(care.get(p.id).quietHours, undefined, 'quiet hours OFF by default');
    const c1 = makeCall();
    const q0 = await c1.quietLine(0, new AbortController().signal);
    assert.ok(q0.nudge, 'appropriate proactive nudge permitted at stage 0 when quiet hours OFF');
    assert.equal(q0.nudge.kind, 'topic');
    assert.equal(c1.nudgeUsed, true, 'nudgeUsed set to true after one nudge');
    assert.equal(c1.proactiveNudge(), null, 'second nudge in same conversation is blocked (one per conversation total, not per category)');
    const q1 = await c1.quietLine(1, new AbortController().signal);
    assert.equal(q1.nudge, null, 'silence or non-answer at stage 1 stops nudging');

    // 5. Quiet hours explicitly ON -> suppresses ordinary proactive invitations; turning back OFF allows in a new conversation
    care.setQuietHours(p.id, true);
    const cQuietOn = makeCall();
    assert.equal(cQuietOn.proactiveNudge(), null, 'quiet hours explicitly ON suppresses proactive nudge');
    care.setQuietHours(p.id, false);
    const cQuietOff = makeCall();
    assert.ok(cQuietOff.proactiveNudge(), 'quiet hours explicitly OFF allows proactive nudge in a new conversation');

    // 6. Decline suppression & persistent opt-out ("Don't suggest topics again")
    const prevComp = process.env.MAYA_SMART_COMPANION;
    process.env.MAYA_SMART_COMPANION = 'on';
    try {
      const cDec = makeCall();
      const offered = cDec.proactiveNudge();
      assert.ok(offered);
      const decNote = smart.ledger(cDec, 'No thanks, not now.');
      assert.match(decNote, /INVITATION DECLINED/);
      assert.equal(cDec.nudgeDeclined, true);

      const cOptOut = makeCall();
      const optNote = smart.ledger(cOptOut, 'Please do not suggest topics or offer calls again.');
      assert.match(optNote, /DO NOT OFFER AGAIN/);
      assert.ok(care.get(p.id).smart.noNudge, 'explicit opt-out persisted on senior record');
      const cNextCall = makeCall();
      assert.equal(cNextCall.proactiveNudge(), null, 'persistent opt-out suppresses nudges in future conversations until senior changes choice');

      const reAllow = smart.ledger(cNextCall, 'You can suggest topics again.');
      assert.match(reAllow, /INITIATIVE ALLOWED AGAIN/);
      assert.equal(care.get(p.id).smart.noNudge, null, 'senior explicit permission clears opt-out');
    } finally {
      if (prevComp === undefined) delete process.env.MAYA_SMART_COMPANION;
      else process.env.MAYA_SMART_COMPANION = prevComp;
    }
  } finally {
    care.stop();
    if (prevData === undefined) delete process.env.MAYA_DATA_DIR; else process.env.MAYA_DATA_DIR = prevData;
    if (prevCare === undefined) delete process.env.MAYA_CARE_DIR; else process.env.MAYA_CARE_DIR = prevCare;
  }
});




