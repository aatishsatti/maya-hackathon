// "What can you do?": the TRUE list of what Maya can and cannot do reaches the brain as facts, for every door (the written chat and a call, app and web all share call.js / chat.js on the server),
// the second time they ask the answer is a fuller one, and the "always short" cap makes room for it. No network: Spark is stubbed; the wording of the answers is Spark's, never fixed text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-abil-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push({ roster }); const text = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(text); return text; },
} };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat'); const { Call, asksAbilities } = require('../call');
chat.deps.web = async () => ({ topics: [] });
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
const FEEL = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const SIX = `${FEEL} The first thing is a quite long and gentle sentence about talking together. The second thing is another long and gentle sentence about reminders. The third thing is one more long sentence about calling you. The fourth thing is yet another long sentence about photographs. The fifth thing is a long sentence about the scams. The sixth thing is a last long sentence about your family.`;
let n = 0; const person = () => memory.createProfile(`Abil${String.fromCharCode(97 + n++)}`, 'female').id;
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const sentences = (t) => (t.match(/[^.!?]+[.!?]+/g) || [t]).length;
const KEYS = [/talk with them/, /remind them/, /call them/, /read a schedule/, /photo or a PDF/, /help with scams/, /remember what they tell you/, /notes from their family/, /check in on how they are/, /not an emergency service/, /no diagnosis/, /where they are/, /detect a fall/];

test('the question is recognised in its usual forms, and "what can you do about my knee?" is not it', () => {
  for (const q of ['What can you do?', 'what can you do for me', 'What do you do?', 'how can you help me?', 'what are you able to do', 'tell me what you can do', 'what can I ask you?', 'what are your abilities', 'What else can you do?']) assert.ok(asksAbilities(q), q);
  for (const q of ['What can you do about my knee?', 'how can you help with my tablets', 'what can you do with this letter', 'good morning', 'what time is it']) assert.ok(!asksAbilities(q), q);
});

test('written chat (web and app): the first ask carries the TRUE list in full; the second ask is told to give a fuller one, not repeat', async () => {
  const id = person();
  reset(`${FEEL} Hello, I'm Maya, your companion. It's lovely to meet you.`); await chat.sendText(id, 'Hi Maya', null);
  reset(SIX); const r1 = await chat.sendText(id, 'What can you do?', null);
  const roster = asked[0].roster;
  assert.match(roster, /ABILITIES \(facts for you, never read out as written\)/);
  for (const k of KEYS) assert.match(roster, k, String(k));
  assert.match(roster, /naming EVERY one of the nine things/); assert.match(roster, /Do not say "lots of things"/);
  assert.doesNotMatch(roster, /fuller list this time/, 'the first time: the list');
  assert.ok(sentences(r1.messages[1].text) >= 5, `room for the list: ${r1.messages[1].text}`);
  reset(SIX); const r2 = await chat.sendText(id, 'Sorry, what else can you do?', null);
  assert.match(asked[0].roster, /do not repeat your last answer\. Give a fuller list this time, with one small concrete example for each thing/);
  for (const k of KEYS) assert.match(asked[0].roster, k, `second ask still has ${k}`);
  assert.ok(sentences(r2.messages[1].text) >= 6, 'and room for the fuller one');
});

test('a call (voice): the same list, with the photo / PDF part pointed to the chat', () => {
  const id = person();
  const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id);
  const roster = c.roster('', 'What can you do?');
  for (const k of KEYS) assert.match(roster, k, String(k));
  assert.match(roster, /They are on a call: say that the photo or PDF part is for the chat/);
});

test('an ordinary question is not given the list and stays short', async () => {
  const id = person();
  reset(`${FEEL} Hi, I'm Maya, your companion. Lovely to meet you.`); await chat.sendText(id, 'Hi', null);
  reset(SIX); const r = await chat.sendText(id, 'What can you do about my cold feet?', null);
  assert.doesNotMatch(asked[0].roster, /ABILITIES/); assert.ok(sentences(r.messages[1].text) <= 2, r.messages[1].text);
});
