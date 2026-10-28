// Conversation beats: pure rules. Code decides and limits; it never supplies a sentence.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../beat');

const light = { emotion: 'neutral', intent: 'share', concern: 'none', pain: false, special: false };

test('beat plan: a subject runs acknowledge, connect, close; a new subject starts again', () => {
  assert.deepEqual(B.plan({ ...light, count: 0, topic: 'new' }), { type: 'acknowledge', n: 1 });
  assert.deepEqual(B.plan({ ...light, count: 1, topic: 'same' }), { type: 'connect', n: 2 });
  assert.deepEqual(B.plan({ ...light, count: 2, topic: 'same' }), { type: 'close', n: 3 });
  assert.deepEqual(B.plan({ ...light, count: 5, topic: 'same' }), { type: 'close', n: 6 }, 'stays closed while they stay on it');
  assert.deepEqual(B.plan({ ...light, count: 5, topic: 'new' }), { type: 'acknowledge', n: 1 });
});

test('beat plan: a missing or invalid topic counts as new, so it can never cut a talk short', () => {
  for (const topic of [undefined, null, '', 'maybe', 'SAME ish']) assert.equal(B.plan({ ...light, count: 4, topic }).type, 'acknowledge', String(topic));
  assert.equal(B.plan({ ...light, count: 4, topic: 'SAME' }).type, 'close', 'case does not matter');
});

test('beat plan: heavy feelings, pain, any concern and safety/scam/health moments are free and reset the count', () => {
  for (const emotion of ['sad', 'lonely', 'grief', 'anxious', 'frustrated', 'angry', 'crisis']) assert.deepEqual(B.plan({ ...light, count: 3, topic: 'same', emotion }), { type: 'free', n: 0 }, emotion);
  assert.deepEqual(B.plan({ ...light, count: 3, topic: 'same', pain: true }), { type: 'free', n: 0 });
  for (const concern of ['unsure', 'urgent']) assert.equal(B.plan({ ...light, count: 3, topic: 'same', concern }).type, 'free', concern);
  assert.deepEqual(B.plan({ ...light, count: 3, topic: 'same', special: true }), { type: 'free', n: 0 });
});

test('beat plan: answering is never limited; the count holds on the same subject and resets on a new one', () => {
  for (const intent of ['ask', 'request', 'story', 'recall', 'check', 'farewell']) {
    assert.deepEqual(B.plan({ ...light, intent, count: 2, topic: 'same' }), { type: 'free', n: 2 }, intent);
    assert.deepEqual(B.plan({ ...light, intent, count: 2, topic: 'new' }), { type: 'free', n: 0 }, intent);
  }
});

test('beat limits: acknowledge is unrestricted, connect asks nothing, close is one short statement', () => {
  assert.deepEqual(B.limits('acknowledge'), { noQuestion: false, maxSentences: Infinity });
  assert.deepEqual(B.limits('free'), { noQuestion: false, maxSentences: Infinity });
  assert.deepEqual(B.limits('connect'), { noQuestion: true, maxSentences: 2 });
  assert.deepEqual(B.limits('close'), { noQuestion: true, maxSentences: 1 });
});

test('beat note: principles only; empty before any beat; never a line to copy', () => {
  assert.equal(B.note(0), '');
  for (const n of [1, 2, 7]) { const t = B.note(n); assert.ok(t.length > 40); assert.doesNotMatch(t, /["“”]/, 'no quoted sentence'); assert.match(t, /new subject/); }
  assert.match(B.note(1), /no question/); assert.match(B.note(2), /no question/);
});

test('beat plan: a memory of, or news about, a person in their life is never counted or closed; the count holds on the same subject, restarts on a new one', () => {
  assert.deepEqual(B.plan({ ...light, personal: true, count: 2, topic: 'same' }), { type: 'free', n: 2 }, 'no close, no count');
  assert.deepEqual(B.plan({ ...light, personal: true, count: 2, topic: 'new' }), { type: 'free', n: 0 });
  assert.deepEqual(B.plan({ ...light, personal: false, count: 2, topic: 'same' }), { type: 'close', n: 3 }, 'without the flag the old rule is unchanged');
  assert.deepEqual(B.plan({ ...light, personal: undefined, count: 2, topic: 'same' }), { type: 'close', n: 3 }, 'a missing flag is not personal');
  assert.deepEqual(B.plan({ ...light, emotion: 'lonely', personal: true, count: 2, topic: 'same' }), { type: 'free', n: 0 }, 'a heavy feeling still resets the count');
});
