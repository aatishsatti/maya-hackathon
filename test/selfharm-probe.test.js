// The deterministic self-harm check (emotion.selfHarmText), in both directions at once.
//  - Controls: clear danger MUST alert, so narrowing the housing pattern can never lose one.
//  - Housing / loneliness wishes ("I don't want to live alone") are NOT a wish to die and must not alert the family.
//  - Clear wishes to die that the check used to miss ("I'd rather be dead", "no point in living", ...) now alert.
// A Spark-side read (emotion=crisis) is a separate path and is not exercised here; this is the code-only check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { selfHarmText } = require('../emotion');

const CONTROLS = ['I want to die.', "I'm going to kill myself tonight.", "I don't want to live anymore.", "I don't want to be here any more.", 'I wish I was dead.',
  "I'm going to hang myself.", 'I want to end my life.', 'I want to cut my wrists.', 'I will overdose tonight.', "I don't want to live alone, I'd rather be dead."];
test('controls: clear danger alerts', () => { for (const t of CONTROLS) assert.equal(selfHarmText(t), true, t); });

test('quiet stays quiet (5 phrases) and the washing / finger / coat idioms do not alert', () => {
  for (const t of ['I will hang the washing.', 'I cut my finger on the bread knife.', 'I am going to hang my coat up.', 'I will go on with my knitting.', 'I do not want to go on the bus today.', 'I want to disappear into a good book.', 'I want this meeting to end soon.', 'I want to live to see my granddaughter married.', "I don't want to live far from the sea."]) assert.equal(selfHarmText(t), false, t);
  for (const t of ["I'm afraid of dying alone.", 'I think I might die soon.', "I'm tired of being alone.", "I don't want to be alone.", "I wouldn't want to live without my cat."]) assert.equal(selfHarmText(t), false, t);
});

const HOUSING = ["I don't want to live alone.", "I don't want to live alone any more.", "I do not want to live alone, I wish my daughter would take me in.",
  "I don't want to live by myself in this big house.", "I don't want to live here alone after my husband passed.", "I don't want to live in a care home.",
  "My son says I should move to a care home but I don't want to live there.", "I don't want to live so far from my grandchildren.", "I don't want to live with my sister, she is too bossy.", "I don't want to be here alone tonight."];
test('false positives stopped: a wish about WHERE or HOW to live is not intent to die (10 phrases)', () => {
  assert.equal(HOUSING.length, 10);
  for (const t of HOUSING) assert.equal(selfHarmText(t), false, t);
});

const MISSED = ["I'd rather be dead.", 'I would be better off dead.', 'I do not want to go on.', 'There is no point in living.', 'I want to go to sleep and not wake up.', 'I want to disappear.', 'I want it all to be over.'];
test('missed dangers now alert (7 phrases), and so does the whole "rather be dead" family', () => {
  assert.equal(MISSED.length, 7);
  for (const t of ["I'd rather be dead.", 'I would rather be dead than live like this.', "I'd rather die.", 'I would rather die tonight.', 'I would be better off dead.', "I'd be better off dead than a burden.", 'Honestly I wish I were dead.', "I don't want to live alone, I'd rather be dead."]) assert.equal(selfHarmText(t), true, t);
  for (const t of MISSED) assert.equal(selfHarmText(t), true, t);
});
