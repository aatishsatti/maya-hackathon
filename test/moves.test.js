// Repeat detector: pure rules. The sentences below exist only inside this test file to exercise the detector.
// None of them is ever sent to Spark or spoken by Maya.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../moves');

test('families: the same kind of stock acknowledgement is found in different wording', () => {
  assert.deepEqual(M.familiesOf('I hear you.'), ['hear-you']);
  assert.deepEqual(M.familiesOf("I can hear how hard that was."), ['hear-you']);
  assert.ok(M.familiesOf('That sounds really tough.').includes('sounds-like'));
  assert.ok(M.familiesOf("I'm so sorry to hear that.").includes('sorry'));
  assert.ok(M.familiesOf('Thank you for telling me.').includes('thanks-sharing'));
  assert.ok(M.familiesOf("I'm right here with you.").includes('here-for-you'));
  assert.ok(M.familiesOf('That’s completely understandable.').includes('understandable'));
  assert.ok(M.familiesOf('Hmm, let me think about that.').includes('let-me-think'));
});

test('families: ordinary talk with no stock acknowledgement matches nothing', () => {
  for (const t of ['Which tea do you like best?', 'Roses need a lot of sun in the morning.', 'Your grandson sounds like a clever boy.', 'Two sugars, then.']) {
    assert.deepEqual(M.familiesOf(t), [], t);
  }
});

test('two-reply rule: a family used in her last 2 replies is blocked, an older one is free again', () => {
  const r = ['I hear you.', 'Tea is a good habit.', 'The garden must be pretty now.'];
  assert.deepEqual(M.blockedFamilies(r), [], 'the family is 3 replies back: free again');
  assert.deepEqual(M.blockedFamilies(r.slice(0, 2)), ['hear-you']);
  assert.equal(M.violations('I understand, truly.', r.slice(0, 2)).repeat, true, 'a different wording of the same kind is still a repeat');
  assert.equal(M.violations('I understand, truly.', r).repeat, false);
  assert.equal(M.violations('Which tea was it?', r.slice(0, 2)).repeat, false);
});

test('spread rule: a family used twice among her last five replies is blocked even when neither use was in the last two', () => {
  const spread = ['That sounds hard.', 'Which tea?', 'That sounds lovely.', 'Roses need sun.', 'Two sugars, then.'];
  assert.deepEqual(M.blockedFamilies(spread.slice(-2)), [], 'nothing in the last two');
  assert.deepEqual(M.blockedFamilies(spread), ['sounds-like'], 'twice in five');
  assert.equal(M.violations('That sounds wonderful.', spread).repeat, true);
  assert.deepEqual(M.blockedFamilies(['That sounds hard.', 'Which tea?', 'Roses need sun.', 'Two sugars, then.', 'Sunny today.']), [], 'once in five is free');
  assert.ok(M.blockedFamilies(['That sounds hard.', 'a', 'b', 'c', 'd', 'That sounds lovely.']).includes('sounds-like'), 'the latest use counts (it is in the last two)');
  assert.deepEqual(M.blockedFamilies(['That sounds hard.', 'a', 'b', 'c', 'd', 'e', 'That sounds lovely.', 'f', 'g']), [], 'the first use is older than five replies');
  assert.equal(M.repeatRate(['That sounds hard.', 'Which tea?', 'That sounds lovely.', 'Roses need sun.', 'Two sugars, then.', 'That sounds good.']), 2 / 5, 'the third repeats the last-two rule, the sixth the twice-in-five rule');
});

test('phrase rule: four words in a row shared with any of her last 3 replies is a repeat; three is not', () => {
  const recent = ['The kettle is on the stove by the window.', 'Mornings are quiet here.'];
  assert.equal(M.violations('Yes, the kettle is on again.', recent).phrase, true);
  assert.equal(M.violations('The kettle is cold.', recent).phrase, false, 'only three shared words');
  assert.equal(M.violations('Quiet mornings are lovely.', recent).phrase, false);
  assert.equal(M.sharesRun('a b c', 'a b c', 4), false, 'too short to count');
  const old = ['one two three four five', 'x', 'y', 'z'];
  assert.equal(M.violations('one two three four', old).phrase, false, 'older than the last 3 replies');
});

test('repeatRate: 0 for a varied run, 1 when every later reply repeats, partial in between', () => {
  assert.equal(M.repeatRate([]), 0);
  assert.equal(M.repeatRate(['I hear you.']), 0, 'one reply cannot repeat');
  assert.equal(M.repeatRate(['Which tea?', 'Roses need sun.', 'Is the window open?', 'Two sugars, then.']), 0);
  assert.equal(M.repeatRate(['I hear you.', 'I understand.', 'I can hear that.', 'I get it.']), 1);
  assert.equal(M.repeatRate(['I hear you.', 'Which tea?', 'I understand.', 'Roses need sun.']), 1 / 3, 'only the third repeats a kind used within 2 replies');
});

test('detector patterns are code-only: nothing outside moves.js and its test names a family pattern to Spark', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'moves.js'), 'utf8');
  assert.ok(/never sent to Spark/i.test(src));
  for (const f of ['brain.js', 'reply.js']) assert.ok(!/require\(['"]\.\/moves['"]\)/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), `${f} must not import the detector patterns`);
});
