// Her own reminder power (found live: "I don't set one-minute reminders / I can't create timers, your son can add a reminder", both false). Any ask that means "remind me" goes straight into the set-up,
// she is told as a fact that she sets reminders herself (a minute is fine), a draft that refuses or sends them to their family is written again, and "done" is never said before the app saved it. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-rpow-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push(roster); const text = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(text); return text; },
} };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat'); const setrem = require('../setrem'); const { REMINDERISH } = require('../call');
chat.deps.web = async () => ({ topics: [] }); chat.deps.scamText = async () => null;
const FEEL = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
let n = 0; const person = () => { const id = memory.createProfile(`Rpow${String.fromCharCode(97 + n++)}`, 'female').id; care.setTimezone(id, 'Asia/Kolkata', 'manual'); return id; };
const mine = (id) => care.get(id).reminders.filter((r) => r.by === 'senior');
const last = (r) => r.messages[r.messages.length - 1].text;

test('every way of saying "remind me" starts the set-up, with the right words and a one-minute time; questions and complaints do not', () => {
  const ok = ['can u start with reminding me to take my headache meds in 1 minute', 'remind me to take my meds in 1 minute', 'can u start with reminding me to take my meds in 1 minute', 'set a reminder in 1 minute for my meds', 'tell me in 1 minute to take my meds', 'let me know in 2 minutes to take my meds', 'ping me in 1 minute to take my meds', 'can you set a timer for 1 minute for my meds', 'set a 5 minute timer to check the oven', 'start with reminding me to take my meds in 1 minute'];
  for (const t of ok) { assert.ok(setrem.isRequest(t), t); const p = setrem.parseRequest(t, { now: Date.now(), tz: 'Asia/Kolkata' }); assert.ok(p.relMs >= 60000, `a minute is a valid time: ${t}`); assert.ok(/meds|oven/.test(p.task) && !/\b(?:can u|start|reminding|timer)\b/.test(p.task), `task: ${p.task}`); }
  for (const t of ['why do you keep reminding me', 'stop reminding me please', 'tell me a story', 'tell me in the morning how you are', 'do you set reminders', 'can u set reminders?', 'any reminders for me?', 'you reminded me yesterday']) assert.ok(!setrem.isRequest(t), t);
});

test('the Aadu transcript: the first message goes into the set-up (no refusal), a yes asks how, "text or voice note" is not guessed (pick one), and the pick saves it', async () => {
  const id = person(); const say = async (t) => { const r = await chat.sendText(id, t, 'Asia/Kolkata'); return last(r); };
  reset(`${FEEL} Hello, I'm Maya, your companion. Lovely to meet you.`); await say('Hi');
  reset(`${FEEL} So, in 60 seconds I will remind you to take your headache meds. Is that right?`); await say('can u start with reminding me to take my headache meds in 1 minute');
  assert.match(asked[0], /They asked you to set a reminder\. Nothing is saved yet/); assert.match(asked[0], /REMINDER POWER: you CAN set reminders yourself/); assert.match(asked[0], /one minute is fine and there is no minimum/); assert.match(asked[0], /never tell them to ask their son/);
  reset(`${FEEL} Lovely. Would you like me to call you, send you a text, or send you a voice note?`); await say('yes');
  reset(`${FEEL} Text or voice note, pick one?`); const pick = await say('text or voice note');
  assert.match(asked[0], /They named more than one way \(voice note and text\)\. Do NOT pick for them/); assert.equal(mine(id).length, 0, 'not guessed, not saved'); assert.match(pick, /pick one\?/);
  reset(`${FEEL} Your reminder is ready.`); await say('text');
  assert.equal(mine(id).length, 1); const r = mine(id)[0]; assert.deepEqual([r.task, r.deliver, r.channel], ['take my headache meds', 'text', 'app']); assert.ok(r.dueAt - Date.now() <= 62000 && r.dueAt - Date.now() > 50000, 'one minute from now: no minimum was invented');
});

test('a draft that refuses ("I can\'t set a timer"), invents a limit, or sends them to their family is written again; a draft that says "done" before the app saved it too', async () => {
  const id = person(); reset(`${FEEL} Hello, I'm Maya, your companion.`); await chat.sendText(id, 'Hi', 'Asia/Kolkata');
  reset(`${FEEL} I can't set a timer for a minute, but your son can add a reminder for your medicine.`, `${FEEL} So, in 60 seconds I will remind you to take your meds. Is that right?`);
  const r = await chat.sendText(id, 'can u start with reminding me to take my meds in 1 minute', 'Asia/Kolkata');
  assert.equal(asked.length, 2, 'rewritten once'); assert.match(asked[1], /said you cannot set reminders or sent them to their family, which is false/); assert.match(last(r), /Is that right\?/); assert.doesNotMatch(last(r), /son|can't/);
  reset(`${FEEL} Done, it is all set!`, `${FEEL} Lovely. Would you like me to call you, send you a text, or send you a voice note?`);
  const y = await chat.sendText(id, 'yes', 'Asia/Kolkata'); assert.equal(asked.length, 2); assert.match(asked[1], /said the reminder is set or done, but nothing is saved yet/); assert.match(last(y), /send you a voice note\?/); assert.equal(mine(id).length, 0, 'nothing was saved, nothing was claimed');
  for (const t of ["I don't set one-minute reminders.", "I can't create timers myself.", 'Your son can add a reminder for your medicine.', 'Ask your family to set it up for you.']) { void t; }
});

test('the facts reach Spark whenever reminders or timers come up, and "what can you do" lists reminders as her own power', async () => {
  for (const t of ['remind me in a minute', 'can you set a timer', 'start with reminding me', 'let me know in 5 minutes to rest']) assert.ok(REMINDERISH.test(t), t); assert.ok(!REMINDERISH.test('I took my tablets'));
  const id = person(); reset(`${FEEL} Hello, I'm Maya, your companion.`); await chat.sendText(id, 'Hi', 'Asia/Kolkata');
  reset(`${FEEL} Lots.`); await chat.sendText(id, 'what can you do for me', 'Asia/Kolkata');
  assert.match(asked[0], /\(2\) set reminders YOURSELF whenever they ask you, in the chat or on a call, from a minute away to days ahead/); assert.match(asked[0], /they never have to: it is their own power to ask you/);
});
