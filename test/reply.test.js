// The splitter cuts a reply into voice pieces. A piece boundary inside a sentence is heard as a pause-then-rush, so the
// first piece ends at a sentence end (or after an opening interjection like "Oh dear,"), never at a mid-sentence comma.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChunkSplitter } = require('../reply');

function split(text, { chunk = 3 } = {}) {
  const pieces = [];
  const delivery = { emotion: 'neutral', intensity: 1, whisperPieces: 0, excitedOpening: false, openingTone: null, moments: 1, maxSentences: 9, maxExclaim: 1, escalate: false };
  const s = new ChunkSplitter({ onName() {}, onFeel: () => delivery, onPiece: (t, k) => pieces.push(t) });
  for (let i = 0; i < text.length; i += chunk) s.feed(text.slice(i, i + chunk)); // streamed in tiny bits like Spark
  s.end();
  return pieces;
}
const flat = (a) => a.join(' ').replace(/\s+/g, ' ').trim();

test('P1 commas inside a sentence stay in ONE piece (no pause-then-rush)', () => {
  const t = 'I am glad you called, Samantha, because the weather is lovely today and so are you.';
  const p = split(t);
  assert.equal(p.length, 1, JSON.stringify(p)); assert.equal(flat(p), t);
  const q = split('That sounds really hard, and I am here with you, love, so tell me more about it.');
  assert.equal(q.length, 1, JSON.stringify(q));
});

test('P2 sentence ends are still piece boundaries; nothing truncated, nothing doubled', () => {
  const t = 'Thank you for telling me, dear. I am here with you, Samantha, and I am not going anywhere. We can just sit together for a while.';
  const p = split(t);
  assert.ok(p.length >= 2 && p.length <= 3, JSON.stringify(p));
  assert.equal(flat(p), t);
  assert.ok(p.every((x) => !/,\s*$/.test(x.replace(/\s+$/, '')) || x === p[0] && false), 'no piece ends on a comma');
});

test('P3 an opening interjection may still be its own short piece', () => {
  const p = split('Oh dear, that sounds hard to carry, Samantha. I am right here with you.');
  assert.equal(p[0].trim(), 'Oh dear,'); assert.equal(flat(p), 'Oh dear, that sounds hard to carry, Samantha. I am right here with you.');
  assert.ok(!/,\s*$/.test(p[1].trim()));
});

test('P4 a very long sentence with no end is cut at a comma so the voice is not left waiting', () => {
  const long = 'Well I remember that you told me about the long walk by the river with your neighbour and the little dog that followed you all the way home, and then you made tea and sat by the window watching the evening light go slowly down over the old garden wall';
  const p = split(long);
  assert.ok(p.length >= 2, JSON.stringify(p)); assert.equal(flat(p).replace(/,/g, ''), long.replace(/,/g, ''));
});

test('isQuestion: a sentence with no question mark counts as a question only when it is built like one, never an order such as "Do not send it"', () => {
  const { isQuestion } = require('../reply');
  for (const t of ['Do you want me to let your family know', 'Does it sound right to you', 'Have you told anyone', 'Has he called back', 'Are you safe right now, is someone near you', 'Would you like a cup of tea?', 'Is it hurting a lot']) assert.equal(isQuestion(t), true, t);
  for (const t of ['Do not send anything yet.', "Don't pay anything today.", 'Please stop. Do not read out the code.', 'Have a rest and a cup of tea.', 'Have some water.', 'It is safest to check with the real bank yourself.']) assert.equal(isQuestion(t), false, t);
  assert.equal(isQuestion('Please stop for a moment. Do you want me to tell your family'), true, 'a real question after an order is still found');
});
