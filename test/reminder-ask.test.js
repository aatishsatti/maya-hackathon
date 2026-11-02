// A reminder being set up hands Maya a question to ask (is that right? how? where?). If her draft skips it and closes with "Perfect" / "Got it", it is written again once, and nothing is saved:
// the reminder is saved only by the person's own answers. No network: Spark is stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-rask-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push(roster); const text = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(text); return text; },
} };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat');
chat.deps.web = async () => ({ topics: [] });
chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
const FEEL = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const mine = (id) => care.get(id).reminders.filter((r) => r.by === 'senior');
let n = 0; const person = () => { const id = memory.createProfile(`Rask${String.fromCharCode(97 + n++)}`, 'male').id; care.setTimezone(id, 'Asia/Kolkata', 'manual'); return id; };

test('the "how" question skipped by Spark ("Perfect, that is noted") is asked again, and nothing is saved', async () => {
  const id = person();
  reset(`${FEEL} Got it, in two minutes I will remind you to drink water. Is that right?`); await chat.sendText(id, 'Remind me in 2 minutes to drink water', 'Asia/Kolkata');
  reset(`${FEEL} Perfect, that is noted.`, `${FEEL} Lovely. Would you like me to call you, send you a text, or send you a voice note?`);
  const r = await chat.sendText(id, 'oky', 'Asia/Kolkata');
  assert.equal(asked.length, 2, 'the first draft had no question: written again once'); assert.match(asked[1], /did not ask the question you were told to ask/);
  const said = r.messages[r.messages.length - 1].text; assert.match(said, /\?/, 'the reply asks how'); assert.doesNotMatch(said, /noted/);
  assert.equal(mine(id).length, 0, 'nothing is saved until they say how');
  reset(`${FEEL} Done, it is set.`); await chat.sendText(id, 'a text please', 'Asia/Kolkata');
  assert.equal(mine(id).length, 1, 'their answer saves it'); assert.deepEqual([mine(id)[0].deliver, mine(id)[0].channel], ['text', 'app']);
});

test('a reply that already asks is left alone (one request only)', async () => {
  const id = person();
  reset(`${FEEL} Got it, in two minutes I will remind you to drink water. Is that right?`); await chat.sendText(id, 'Remind me in 2 minutes to drink water', 'Asia/Kolkata');
  assert.equal(asked.length, 1);
});

test('if she skips the question even when asked again, the plain question closes her reply (the set-up never stalls) and still nothing is saved', async () => {
  const id = person();
  reset(`${FEEL} Got it, in two minutes I will remind you to drink water. Is that right?`); await chat.sendText(id, 'Remind me in 2 minutes to drink water', 'Asia/Kolkata');
  reset(`${FEEL} Perfect, that is noted.`);   // the same skip, twice
  const r = await chat.sendText(id, 'ok', 'Asia/Kolkata');
  assert.equal(asked.length, 2); const said = r.messages[r.messages.length - 1].text;
  assert.match(said, /call you, send you a text, or send you a voice note\?$/); assert.equal(mine(id).length, 0);
});
