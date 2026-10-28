// Probe of the deterministic self-harm check (emotion.selfHarmText), written BEFORE any change to it. It records what the check does today.
//  - Controls (plain tests): clear danger MUST alert. These guard against anyone narrowing the pattern to fix a false positive.
//  - Housing / loneliness wishes ("I don't want to live alone") alert today as self-harm: that is a false positive. The desired behaviour is
//    written as `todo` tests: they are reported but do not fail the suite until the check is deliberately changed.
//  - Clear-danger phrasings the check misses today (Spark's own crisis read is then the only alert path) are `todo` tests too.
// A Spark-side read (emotion=crisis) is a separate path and is not exercised here; this is the code-only check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { selfHarmText } = require('../emotion');

const CONTROLS = ['I want to die.', "I'm going to kill myself tonight.", "I don't want to live anymore.", "I don't want to be here any more.", 'I wish I was dead.',
  "I'm going to hang myself.", 'I want to end my life.', 'I want to cut my wrists.', 'I will overdose tonight.', "I don't want to live alone, I'd rather be dead."];
test('controls: clear danger alerts', () => { for (const t of CONTROLS) assert.equal(selfHarmText(t), true, t); });

test('controls: ordinary fear and loneliness without a wish to die stay quiet today', () => {
  for (const t of ["I'm afraid of dying alone.", 'I think I might die soon.', "I'm tired of being alone.", "I don't want to be alone.", "I wouldn't want to live without my cat."]) assert.equal(selfHarmText(t), false, t);
});

const HOUSING = ["I don't want to live alone.", "I don't want to live alone any more.", "I do not want to live alone, I wish my daughter would take me in.",
  "I don't want to live by myself in this big house.", "I don't want to live here alone after my husband passed.", "I don't want to live in a care home.",
  "My son says I should move to a care home but I don't want to live there.", "I don't want to live so far from my grandchildren.", "I don't want to live with my sister, she is too bossy.", "I don't want to be here alone tonight."];
test('KNOWN FALSE POSITIVE: a wish about WHERE or HOW to live is not intent to die (all of these alert today)', { todo: 'selfHarmText matches "(don\'t) want to live|be here" with any continuation' }, () => {
  for (const t of HOUSING) assert.equal(selfHarmText(t), false, t);
});

const MISSED = ["I'd rather be dead.", 'I would be better off dead.', 'I do not want to go on.', 'There is no point in living.', 'I want to go to sleep and not wake up.', 'I want to disappear.', 'I want it all to be over.'];
test('KNOWN GAP: clear wishes to die that the code-only check misses today (only Spark\'s crisis read would alert)', { todo: 'add deliberately, with the false-positive fix, never by weakening a control' }, () => {
  for (const t of MISSED) assert.equal(selfHarmText(t), true, t);
});
