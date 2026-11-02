// A scam-like call with NO payment demand (a stranger says they won a car) must register the family question like any warning; a number with a country code is answered from a static table (which country,
// and that the number shown can be faked, never a lookup); "what can u do for me" and a follow-up "and?" get the abilities list; an open worry is not closed by "okay" / "hmm". No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-strig-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push(roster); const text = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(text); return text; },
} };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat'); const scam = require('../scam'); const phone = require('../phone'); const { abilitiesAsks, asksAbilities } = require('../call');
chat.deps.web = async () => ({ topics: [] });
const FEEL = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
let n = 0; const person = () => { const id = memory.createProfile(`Trig${String.fromCharCode(97 + n++)}`, 'female').id; care.setTimezone(id, 'Asia/Kolkata', 'manual'); return id; };

test('a verdict of one warning sign that still names a scam kind is treated as a warning (the live pipeline only); nothing else is promoted', () => {
  const v = { level: 'caution', type: 'prize scam', signals: { money: true } };
  assert.equal(scam.promote(v).level, 'warn'); assert.equal(scam.promote(v).softened, true); assert.equal(scam.promote(v).type, 'prize scam');
  assert.equal(scam.promote({ level: 'caution', type: '' }).level, 'caution', 'no kind named: left alone'); assert.equal(scam.promote({ level: 'none', type: 'none' }).level, 'none'); assert.equal(scam.promote({ level: 'pause', type: 'x' }).level, 'pause'); assert.equal(scam.promote(null), null);
});

test('car-prize call, no payment, no photo: the warning registers the family question (owed), it is asked on the next turn with the number, and a yes alerts, topic only', async () => {
  const id = person(); chat.deps.scamText = async () => scam.promote({ level: 'caution', type: 'prize scam', reading: 'A stranger rang to say they won a car.', signals: { money: true }, reads: {}, count: 1 });
  reset(`${FEEL} Could you tell me more about the call? Please do not pay or share anything yet.`);
  await chat.sendText(id, 'i just got a call from a man saying that i have won a gift and its a car', null);
  assert.equal(care.scamPending(id).asked, false, 'the warning registered the question, and it is OWED');
  chat.deps.scamText = async () => null; reset(`${FEEL} That code is from Pakistan, but a number shown can be faked. Would you like me to let your family know?`);
  await chat.sendText(id, 'his number was +927746328374', null);
  assert.match(asked[0], /they have not yet asked them whether they would like their family to know|you have not yet asked them whether they would like their family to know/i); assert.equal(care.scamPending(id).asked, true);
  reset(`${FEEL} Done.`); await chat.sendText(id, 'yes please', null);
  const sc = care.view(id).scams[0]; assert.equal(sc.level, 'alert'); assert.equal(sc.type, 'prize scam');
  assert.doesNotMatch(care.get(id).notifications.find((x) => x.to === 'family').text, /92|774|car|gift|number/i, 'topic only: no number, no words');
});

test('a phone number with a country code: the country from a static table, and that the number shown can be faked, never who owns it; no code, no country; the digits are never repeated', () => {
  assert.equal(phone.numbersIn('his number was +927746328374')[0].country, 'Pakistan'); assert.equal(phone.numbersIn('call 0044 20 7946 0958')[0].country, 'the United Kingdom');
  assert.equal(phone.numbersIn('he rang from +1 876 555 0100')[0].country, 'Jamaica'); assert.equal(phone.numbersIn('+91 98765 43210')[0].country, 'India'); assert.equal(phone.numbersIn('number 9876543210').length, 0, 'no + / 00: no code to read');
  const f = phone.fact('his number was +927746328374');
  assert.match(f, /\+92 belongs to Pakistan/); assert.match(f, /can be faked/); assert.match(f, /did NOT look the number up/); assert.match(f, /never give a caller or company name/); assert.doesNotMatch(f, /927746328374|7746328374/, 'the digits are not in the fact');
  assert.match(phone.fact('+999 12345678'), /not one you can place/);
});

test('in the chat the number fact reaches Spark in the same turn (text), and nothing about the number is stored', async () => {
  const id = person(); chat.deps.scamText = async () => null; reset(`${FEEL} That code is from Pakistan, and a number shown can be faked.`);
  await chat.sendText(id, 'idk his number was +927746328374', null);
  assert.match(asked[0], /A PHONE NUMBER WITH A COUNTRY CODE: they gave a number and the country code \+92 belongs to Pakistan/);
  assert.ok(!JSON.stringify(care.get(id)).includes('7746328374'), 'the number is not in the care file');
});

test('"what can u do for me" is the abilities question; "and?" / "what else" right after it asks again (fuller); "and?" alone is not', () => {
  for (const q of ['who is this and what can u do for me, my son told me to use your app', 'but what can u do for me', 'what do u do', 'how can u help me']) assert.ok(asksAbilities(q), q);
  const h = (...m) => m.map((x) => ({ role: 'user', content: `Ravi: ${x}` }));
  assert.equal(abilitiesAsks(h('what can u do for me'), 'what can u do for me'), 1);
  assert.equal(abilitiesAsks(h('what can u do for me', 'but what can u do for me'), 'but what can u do for me'), 2);
  assert.equal(abilitiesAsks(h('what can u do for me', 'and?'), 'and?'), 2); assert.equal(abilitiesAsks(h('hello', 'and?'), 'and?'), 0);
});

test('abilities, in the chat: the first ask carries the full true list, "and?" is told to give a fuller one', async () => {
  const id = person(); chat.deps.scamText = async () => null;
  reset(`${FEEL} Hello, I'm Maya, your companion. Lovely to meet you.`); await chat.sendText(id, 'Hi', null);
  reset(`${FEEL} Lots.`); await chat.sendText(id, 'but what can u do for me', null);
  assert.match(asked[0], /THE TRUE LIST/); assert.match(asked[0], /not an emergency service/); assert.doesNotMatch(asked[0], /fuller list this time/);
  reset(`${FEEL} More.`); await chat.sendText(id, 'and?', null);
  assert.match(asked[0], /Give a fuller list this time, with one small concrete example for each thing/);
});

test('an open scam question is not closed by "okay" or "hmm": no "close gently" beat, and she is told the worry is NOT settled', async () => {
  const id = person(); chat.deps.scamText = async () => scam.promote({ level: 'caution', type: 'prize scam', reading: 'x', signals: { money: true }, reads: {}, count: 1 });
  reset(`${FEEL} That looks like a scam. Would you like me to let your family know?`); await chat.sendText(id, 'i got a call from a man saying i won a car', null);
  chat.deps.scamText = async () => null;
  for (const t of ['okay', 'hmm']) { reset(`${FEEL} Good.`); await chat.sendText(id, t, null); assert.match(asked[0], /NOT answered that/); assert.match(asked[0], /Do not close it or call it settled, good or sorted/); assert.doesNotMatch(asked[0], /close gently with one short statement/); }
  assert.ok(care.scamPending(id), 'still open');
});

test('a warning turn must itself ask the family question: a draft without it is written again, and after a second miss the plain question closes the reply', async () => {
  const id = person(); chat.deps.scamText = async () => ({ level: 'warn', type: 'bank impersonation scam', reading: 'x', signals: { payment: true, urgency: true }, reads: {}, count: 2 });
  reset(`${FEEL} That looks like a scam. Please do not click that link or share your PIN.`);   // the same draft, twice
  const r = await chat.sendText(id, 'I got a message saying my bank account will be closed unless I click http://secure-bank-verify.xyz/login and enter my PIN', null);
  assert.equal(asked.length, 2, 'asked again once'); assert.match(asked[1], /did not ask whether they would like their family to know/);
  const said = r.messages[r.messages.length - 1].text; assert.match(said, /Would you like me to let your family know about this\?$/); assert.equal(care.scamPending(id).asked, true, 'and it is registered as asked');
});

test('when both drafts claim "done" with nothing sent, the reply is the plain question, never an error', async () => {
  const id = person(); chat.deps.scamText = async () => ({ level: 'warn', type: 'bank impersonation scam', reading: 'x', signals: { payment: true, urgency: true }, reads: {}, count: 2 });
  reset(`${FEEL} Do not click anything. Would you like me to let your family know?`); await chat.sendText(id, 'I got a message saying my bank account will be closed unless I click this link and enter my PIN', null);
  care.get(id).pendingScam.asked = false; care.get(id).pendingScam.askedAt = 0;   // the question was left out of that reply
  chat.deps.scamText = async () => null; reset(`${FEEL} Done, I have let your family know.`);
  const r = await chat.sendText(id, 'yes please tell my family', null);
  assert.match(r.messages[r.messages.length - 1].text, /Would you like me to let your family know about this\?$/); assert.equal(care.view(id).scams.length, 0, 'nothing was sent, nothing was claimed');
});
