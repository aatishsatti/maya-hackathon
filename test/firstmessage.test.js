// The written chat's first message to a new person, and how Maya talks after it. No network: Spark is stubbed (the wording below exists only in this test file).
// The first ever message is a short, slow hello that says she is Maya, their companion, plus one small warm line, then it stops: two short sentences, no question. After it she is always short,
// never introduces herself again, and never invents anything about them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-first-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push({ history: JSON.parse(JSON.stringify(history)), roster }); const text = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(text); return text; },
} };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat');
chat.deps.web = async () => ({ topics: [] });
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
const FEEL = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
let n = 0; const person = () => memory.createProfile(`Veer${String.fromCharCode(97 + n++)}`, 'female').id;
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const sentences = (t) => (t.match(/[^.!?]+[.!?]+/g) || [t]).length;

test('a new person\'s first "Hi": Maya says she is Maya, their companion, warmly, in two short sentences and no question; the greeting is not stripped', async () => {
  const id = person();
  reset(`${FEEL} Hi, I'm Maya, your companion. It's lovely to meet you.`);
  const r = await chat.sendText(id, 'Hi Maya', null);
  const text = r.messages[1].text;
  assert.match(asked[0].roster, /FIRST EVER MESSAGE/);
  assert.match(text, /^Hi, I'm Maya, your companion\./, 'the intro stays (the greeting strip is off for the first message only)');
  assert.match(text, /Maya/); assert.match(text, /companion/i);
  assert.ok(sentences(text) <= 2 && text.length < 120, `short: ${text}`);
  assert.ok(!/\?/.test(text), 'no question, no "what is on your mind"');
  assert.equal(asked.length, 1);
});

test('a first reply that forgets to say who she is is written again once, in her own words', async () => {
  const id = person();
  reset(`${FEEL} What is on your mind today?`, `${FEEL} Hello, I'm Maya, your companion. I'm glad you wrote.`);
  const r = await chat.sendText(id, 'Hi Maya', null);
  assert.equal(asked.length, 2); assert.match(asked[1].roster, /did not say who you are/);
  assert.match(r.messages[1].text, /I'm Maya, your companion/); assert.ok(!/on your mind/.test(r.messages[1].text));
});

test('after the first message: no introduction, no greeting, never more than two sentences unless asked, one small question at most, nothing invented', async () => {
  const id = person();
  reset(`${FEEL} Hi, I'm Maya, your companion. It's lovely to meet you.`);
  await chat.sendText(id, 'Hi Maya', null);
  reset(`${FEEL} Hello again, I'm Maya. That sounds like a quiet day. I hope the sun comes out later. Would you like some company this afternoon?`);
  const r = await chat.sendText(id, 'It is a grey day today', null);
  const roster = asked[0].roster;
  assert.ok(!/FIRST EVER MESSAGE/.test(roster)); assert.match(roster, /never introduce yourself or say your name again/);
  assert.match(roster, /CHAT STYLE: one or two short/); assert.match(roster, /ONLY from what they actually say; never assume/);
  const text = r.messages[1].text;
  assert.ok(sentences(text) <= 2, `two sentences at most: ${text}`); assert.ok(!/^Hello/.test(text), 'a greeting belongs to the start only');
});

test('they ask for more: the short rule lets go', async () => {
  const id = person();
  reset(`${FEEL} Hi, I'm Maya, your companion. It's lovely to meet you.`); await chat.sendText(id, 'Hi', null);
  reset(`[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Sure. The first part is this. Then comes the second. And the third.`);
  const r = await chat.sendText(id, 'Please explain it in full', null);
  assert.ok(sentences(r.messages[1].text) >= 3, r.messages[1].text);
});

test('a real question as the very first line is simply answered: no forced introduction and no second request', async () => {
  const id = person();
  reset(`${FEEL} It is a grey and quiet day today, as far as I know from what you tell me.`);
  const r = await chat.sendText(id, 'What do you think about the day today for a walk?', null);
  assert.ok(!/FIRST EVER MESSAGE/.test(asked[0].roster)); assert.equal(asked.length, 1);
  assert.ok(r.messages[1].text.length > 0);
});
