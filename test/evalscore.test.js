// The evaluation's scoring, comparison and guard rails: pure functions, no network. The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../eval/score');
const rules = require('../eval/rules');

const turn = (maya, o = {}) => ({ maya, want: 's', wantP: '0', tag: { topic: 'same', personal: '0', beat: 'acknowledge' }, ...o });

test('conversation metrics: repeat rate, questions, length, tag presence and accuracy, and the beat limits', () => {
  const chats = [{ turns: [turn('Tea sounds lovely. Which kind?'), turn('I hear you.', { want: 'n', tag: { topic: 'new', personal: '0', beat: 'acknowledge' } }), turn('I understand, truly.', { tag: { topic: 'same', personal: '1', beat: 'close' }, wantP: '1' })] },
    { turns: [turn('Roses need sun.', { tag: { topic: 'new', personal: '0', beat: 'connect' } }), turn('Is it hurting a lot?', { tag: { topic: 'same', personal: 'x', beat: 'close' } }), turn('Fine.', { tag: null, want: '?', wantP: '?' })] }];
  const m = S.conversationMetrics(chats);
  assert.equal(m.replies, 6); assert.equal(m.repeatRate, 0.25, 'chat 1: only the third reply repeats a kind used in her last two (1 of 2 later replies = 0.5); chat 2: none = 0; mean 0.25');
  assert.equal(m.questionRate, 2 / 6); assert.equal(m.thatSounds, 0);
  assert.equal(m.topicPresent, 5 / 6, 'five of six replies carried a valid topic tag');
  assert.equal(m.topicAccuracy, 4 / 5, 'labelled turns where the tag matches the label (want s -> same, n -> new)');
  assert.equal(m.personalPresent, 4 / 6); assert.equal(m.personalAccuracy, 4 / 5, 'five labelled turns, one with an invalid personal tag');
  assert.equal(m.limitViolations, 1, 'a close that asks a question is the one violation');
  assert.equal(S.conversationMetrics([{ turns: [turn('Quiet one.', { tag: { topic: 'same', personal: '0', beat: 'close' } }), turn('Two. Sentences here.', { tag: { topic: 'same', personal: '0', beat: 'close' } })] }]).limitViolations, 1, 'a close of two sentences');
  assert.equal(S.conversationMetrics([{ turns: [turn('Oh, that sounds nice.'), turn('That sounds hard.')] }]).thatSounds, 2);
});

test('worryAction: she states what the app does (further attempts, then the family hears), in whatever words', () => {
  for (const t of ["If I can't reach you, I'll try again a few times, and then your family will be told so they can check on you.", 'If I call and can\'t reach you I keep trying for a while and then your family is told.', "If I can't reach you, the app tries again and then lets your family know.", 'I check in, and if I cannot reach you your family hears about it.']) assert.equal(S.worryAction(t), true, t);
  for (const t of ['That thought makes sense when the house is so quiet. You deserve to feel safe in your own home.', "That's a really understandable worry to have. What part of it worries you most?", 'You are not alone, I am right here with you.', '']) assert.equal(S.worryAction(t), false, t);
});

test('memory helpers: the follow-up mention, admitting she does not know, and inventing a job', () => {
  assert.equal(S.mentionsFollowUp('How was the weekend with Priya?'), true); assert.equal(S.mentionsFollowUp('Are the birds still visiting out there?'), false, '"visiting" alone is not the follow-up');
  for (const t of ["I can't quite place her right now.", 'I only have Priya and Ravi in my notes.', "You haven't told me about his job."]) assert.equal(S.admitsNotKnowing(t), true, t);
  assert.equal(S.admitsNotKnowing('Yes, your daughter Sarah is lovely.'), false);
  assert.equal(S.inventsProfession('He works as an engineer in Chicago.'), true); assert.equal(S.inventsProfession("You haven't mentioned his job."), false);
});

test('scam metrics: warned / cautioned / false warn / pause on scams in progress / false pause on genuine payments and other normal items', () => {
  const items = [{ id: 'a', label: 'scam' }, { id: 'b', label: 'scam', now: true }, { id: 'c', label: 'scam' }, { id: 'd', label: 'normal' }, { id: 'e', label: 'normal', legitpay: true }, { id: 'f', label: 'normal' }];
  const by = { a: { level: 'warn' }, b: { level: 'pause' }, c: { level: 'caution' }, d: { level: 'caution' }, e: { level: 'pause' }, f: { level: 'none' } };
  assert.deepEqual(S.scamMetrics(items, by), { scams: 3, normal: 3, warned: 2 / 3, cautioned: 1, falseWarn: 1 / 3, falseCaution: 2 / 3, pauseInProgress: 1, falsePauseGenuine: 1, falsePauseOther: 0 });
  assert.equal(S.flagged({ level: 'pause' }), true); assert.equal(S.flagged({ level: 'caution' }), false); assert.equal(S.flagged(undefined), false);
});

test('cost metrics: speed and tokens from the usage ledger rows', () => {
  const rows = [{ ok: true, ms: 100, tokensIn: 10, tokensOut: 4 }, { ok: true, ms: 300, tokensIn: 30, tokensOut: 8 }, { ok: true, ms: 200, tokensIn: 20, tokensOut: 6 }, { ok: false, ms: 50, tokensIn: null, tokensOut: null }];
  assert.deepEqual(S.costMetrics(rows), { calls: 4, failed: 1, avgMs: 200, medianMs: 200, p90Ms: 300, avgTokensIn: 15, avgTokensOut: 5 });
  assert.deepEqual(S.costMetrics([]), { calls: 0, failed: 0, avgMs: 0, medianMs: null, p90Ms: null, avgTokensIn: 0, avgTokensOut: 0 });
});

test('compare: worse than the baseline by more than the tolerance is REGRESSED; within it is same; better is improved; missing is n/a', () => {
  const r = { 'a.up': { dir: 'higher', tol: 0.1 }, 'a.down': { dir: 'lower', tol: 0.1 }, 'a.missing': { dir: 'higher', tol: 0.1 } };
  const rows = S.compare({ 'a.up': 0.7, 'a.down': 0.35, 'a.missing': null }, { 'a.up': 0.9, 'a.down': 0.2, 'a.missing': 1 }, r);
  assert.deepEqual(rows.map((x) => [x.key, x.status]), [['a.up', 'REGRESSED'], ['a.down', 'REGRESSED'], ['a.missing', 'n/a']]);
  assert.equal(S.compare({ 'a.up': 0.85, 'a.down': 0.25 }, { 'a.up': 0.9, 'a.down': 0.2 }, r).every((x) => x.status === 'same' || x.status === 'n/a'), true);
  assert.equal(S.compare({ 'a.up': 0.99, 'a.down': 0.05 }, { 'a.up': 0.8, 'a.down': 0.3 }, r)[0].status, 'improved');
  assert.deepEqual(S.compare({ 'a.up': 1 }, null, r).map((x) => x.status), ['n/a', 'n/a', 'n/a'], 'no baseline: nothing to compare, never a pass or a fail');
});

test('compare: the tolerance is never tighter than 1.5 times the spread seen between the baseline runs (noise is not a regression)', () => {
  const rules = { 'a.up': { dir: 'higher', tol: 0.05 } };
  const noisy = S.compare({ 'a.up': 0.6 }, { 'a.up': 0.8 }, rules, { 'a.up': 0.2 })[0];
  assert.ok(Math.abs(noisy.tol - 0.3) < 1e-9, 'tolerance = 1.5 x spread'); assert.equal(noisy.status, 'same', 'a drop of 0.2 is inside 1.5 x the 0.2 spread');
  assert.equal(S.compare({ 'a.up': 0.45 }, { 'a.up': 0.8 }, rules, { 'a.up': 0.2 })[0].status, 'REGRESSED', 'a drop of 0.35 is beyond it');
  assert.equal(S.compare({ 'a.up': 0.7 }, { 'a.up': 0.8 }, rules, { 'a.up': 0 })[0].status, 'REGRESSED', 'no spread: the rule tolerance alone');
  assert.equal(S.compare({ 'a.up': 0.7 }, { 'a.up': 0.8 }, rules)[0].status, 'REGRESSED', 'spread is optional');
});

test('flatten and runChecks: a check whose metric is missing is skipped, never a pass', () => {
  assert.deepEqual(S.flatten({ s: { a: 1, b: null, c: 'text', d: { x: 1 } }, t: { a: 2 } }), { 's.a': 1, 's.b': null, 't.a': 2 });
  const res = S.runChecks({ 'x.ok': 1, 'x.bad': 0 }, [{ id: '1', text: 't', test: (m) => m['x.ok'] === 1 }, { id: '2', text: 't', test: (m) => m['x.bad'] === 1 }, { id: '3', text: 't', test: (m) => (m['x.none'] === undefined ? null : true) }, { id: '4', text: 't', test: () => { throw new Error('x'); } }]);
  assert.deepEqual(res.map((r) => r.status), ['pass', 'FAIL', 'skipped', 'skipped']);
});

// What this project actually measured, as the evaluation would report it. The guard rails must pass on these, and fail on clearly worse numbers.
const OBSERVED = { 'conversation.limitViolations': 0, 'conversation.topicPresent': 1, 'conversation.topicAccuracy': 1, 'conversation.personalAccuracy': 27 / 28, 'conversation.repeatRate': 0, 'conversation.worryAction': 1,
  'memory.askedEarly': 0.8, 'memory.askedOnce': 1, 'memory.heavyQuiet': 1, 'memory.safetyQuiet': 1, 'memory.recallAccuracy': 1, 'memory.honest': 1, 'memory.closedAfterAnswer': 1, 'memory.closedAfterBrushoff': 1, 'memory.notRepeatedAfterClose': 1,
  'trends.falseAlarmOrdinary': 0.014, 'trends.falseAlarmQuiet': 0.01, 'trends.detectionMean': 0.78,
  'scam.warned': 38 / 38, 'scam.falseWarn': 0, 'scam.pauseInProgress': 1, 'scam.falsePauseGenuine': 0, 'scam.falsePauseOther': 0, 'scam.filterRecallDev': 1, 'scam.ordinaryTrigger': 0, 'meta.realFailureRate': 0, 'hearing.wer': 0.033, 'hearing.termSurvival': 0.992, 'hearing.scamTermSurvival': 1, 'hearing.failed': 0 };   // hearing: the first real run (48 hearings of synthetic clean speech)

test('guard rails: every check passes on the numbers this project observed, ids are unique, and each fails on clearly worse numbers', () => {
  assert.equal(new Set(rules.CHECKS.map((c) => c.id)).size, rules.CHECKS.length);
  assert.deepEqual(S.runChecks(OBSERVED, rules.CHECKS).filter((r) => r.status !== 'pass'), []);
  const worse = { ...OBSERVED, 'conversation.limitViolations': 2, 'conversation.topicPresent': 0.8, 'conversation.topicAccuracy': 0.6, 'conversation.personalAccuracy': 0.5, 'conversation.repeatRate': 0.4, 'conversation.worryAction': 0.3,
    'memory.askedEarly': 0.2, 'memory.askedOnce': 0.5, 'memory.heavyQuiet': 0.75, 'memory.recallAccuracy': 0.5, 'memory.honest': 0.5, 'memory.closedAfterAnswer': 0.5, 'meta.realFailureRate': 0.2, 'hearing.wer': 0.3, 'hearing.termSurvival': 0.5, 'hearing.failed': 2, 'trends.falseAlarmOrdinary': 0.2, 'trends.detectionMean': 0.4,
    'scam.warned': 0.7, 'scam.falseWarn': 0.05, 'scam.pauseInProgress': 0.2, 'scam.filterRecallDev': 0.9 };
  const failed = S.runChecks(worse, rules.CHECKS).filter((r) => r.status === 'FAIL').map((r) => r.id);
  assert.deepEqual(failed.sort(), rules.CHECKS.map((c) => c.id).sort(), 'every guard rail catches its own regression');
  const oneMiss = { ...OBSERVED, 'memory.honest': 0.875, 'memory.closedAfterBrushoff': 0.5, 'memory.askedEarly': 0.5, 'scam.pauseInProgress': 0.7 };
  assert.deepEqual(S.runChecks(oneMiss, rules.CHECKS).filter((r) => r.status !== 'pass'), [], 'one unlucky reply out of eight is noise, not a failure');
  assert.ok(S.runChecks({}, rules.CHECKS).every((r) => r.status === 'skipped'), 'with no numbers nothing passes by default');
  const noneAsked = S.runChecks({ ...OBSERVED, 'memory.closedAfterAnswer': null, 'memory.closedAfterBrushoff': null, 'memory.notRepeatedAfterClose': null }, rules.CHECKS).find((r) => r.id === 'mem.closing');
  assert.equal(noneAsked.status, 'skipped', 'if she never asked there is nothing to judge: skipped, not passed');
});

test('rules: every comparison rule names a direction and a positive tolerance', () => {
  for (const [k, r] of Object.entries(rules.RULES)) { assert.match(k, /^[a-z]+\.\w+$/); assert.ok(['higher', 'lower'].includes(r.dir) && r.tol > 0, k); }
});

test('hearing scoring: word error rate (substitutions, insertions, deletions over the words said) and key terms that survive, with alternate spellings', () => {
  assert.deepEqual(S.normWords("Hello, Maya! It's  £200."), ['hello', 'maya', "it's", '200']);
  assert.equal(S.wer('the roses are finished', 'The roses are finished.'), 0, 'case and punctuation do not count');
  assert.equal(S.wer('the roses are finished', 'the rose are finished'), 0.25, 'one substitution in four words');
  assert.equal(S.wer('the roses are finished', 'the roses finished'), 0.25, 'one deletion');
  assert.equal(S.wer('the roses are finished', 'the old roses are finished'), 0.25, 'one insertion');
  assert.equal(S.wer('one two', ''), 1); assert.equal(S.wer('', ''), 0); assert.equal(S.wer('', 'something'), 1);
  assert.equal(S.wer('a b c d', 'x y z w'), 1);
  const t = S.termsFound('A man wanted my Medicare number and my date of birth.', [['medicare'], ['date of birth'], ['gift cards', 'gift card'], ['two hundred pounds', '200 pounds', '200']]);
  assert.deepEqual(t, { found: 2, total: 4, missed: ['gift cards', 'two hundred pounds'] });
  assert.equal(S.termsFound('He wants 200 pounds today', [['two hundred pounds', '200 pounds']]).found, 1, 'an alternate spelling counts');
  assert.equal(S.termsFound('the cardigans are warm', [['card']]).found, 0, 'whole words only, not part of a word');
  assert.deepEqual(S.termsFound('anything', []), { found: 0, total: 0, missed: [] });
});
