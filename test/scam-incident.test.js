// The scam family question as a durable incident (found live): it must really be ASKED (the reply has to put it), it survives a gap and is restated before any yes counts, an incident whose question ran
// out is brought back (never a fake "done", never a vague contact request), and a yes only ever creates the topic-only alert. No network: Spark and the scam check are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-scaminc-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push(roster); const text = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(text); return text; },
} };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat'); const { Call } = require('../call');
chat.deps.web = async () => ({ topics: [] });
const verdict = (level, type = 'bank impersonation scam') => async () => ({ level, type, reading: 'A message says the account will close unless they click a link and give a PIN.', signals: { payment: true, urgency: true, impersonation: true }, reads: {}, count: 3 });
const FEEL = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const URGENT = '[[feel: emotion=anxious intensity=3 intent=chat concern=urgent pain=0]]';
const ASKS = `${FEEL} That looks like a scam, please do not pay or share anything. Would you like me to let your family know?`;
const NOQ = `${FEEL} Please do not click that link or share anything.`;
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
let n = 0; const person = () => { const id = memory.createProfile(`Scam${String.fromCharCode(97 + n++)}`, 'female').id; care.setTimezone(id, 'Asia/Kolkata', 'manual'); return id; };
const MSG = 'I got a message saying my bank account will be closed unless I click this link and enter my PIN';
const last = (r) => r.messages[r.messages.length - 1].text;
const advance = (ms) => { const real = Date.now; Date.now = () => real() + ms; return () => { Date.now = real; }; };

test('a warning whose reply never asked the family question leaves it OWED; a yes does not count, the next reply is told to ask it, and once she asks it a yes alerts (topic only)', async () => {
  const id = person(); chat.deps.scamText = verdict('warn'); reset(NOQ);
  await chat.sendText(id, MSG, null);
  assert.equal(care.scamPending(id).asked, false, 'owed, not asked'); assert.equal(care.scamFresh(id), false);
  chat.deps.scamText = verdict('none'); reset(ASKS); await chat.sendText(id, 'yes', null);
  assert.match(asked[0], /you have not yet asked them whether they would like their family to know/); assert.equal(care.view(id).scams.length, 0, 'a yes to a question that was never asked is not consent');
  assert.equal(care.scamPending(id).asked, true, 'her reply put the question: now it is asked'); assert.equal(care.scamFresh(id), true);
  reset(`${FEEL} Done, your family knows.`); await chat.sendText(id, 'yes please', null);
  const sc = care.view(id).scams[0]; assert.equal(sc.level, 'alert');
  const text = care.get(id).notifications.find((x) => x.to === 'family').text; assert.doesNotMatch(text, /PIN|link|click|account/i, 'topic only: no words from the message'); assert.match(text, /bank impersonation scam/);
});

test('unclear answers never drop the incident; after a gap even a plain yes is NOT acted on: she restates the worry and asks again, and only then does a yes create the alert', async () => {
  const id = person(); chat.deps.scamText = verdict('warn'); reset(ASKS); await chat.sendText(id, MSG, null);
  chat.deps.scamText = verdict('none');
  for (const t of ['okay ill wait for your message', 'okay i will', 'hmm']) { reset(NOQ); await chat.sendText(id, t, null); }
  assert.ok(care.scamPending(id), 'still open after three non-answers');
  const back = advance(5 * 3600000);
  try {
    reset(NOQ, NOQ); const r = await chat.sendText(id, 'Please, yes, please let my family know.', null);
    assert.match(asked[0], /left open while they were away and NOTHING has been sent/); assert.equal(care.view(id).scams.length, 0, 'a late yes is not acted on'); assert.equal(care.get(id).notifications.filter((x) => x.to === 'family').length, 0, 'and no vague "they would like to hear from you" note was sent either');
    assert.match(last(r), /\?$/, 'she asks again (the plain question closes the reply if Spark skipped it twice)');
    reset(`${FEEL} Done.`); await chat.sendText(id, 'yes please', null);
    assert.equal(care.view(id).scams[0].level, 'alert', 'the yes to the re-asked question creates the alert');
  } finally { back(); }
});

test('an incident whose question ran out (a day later): a yes says plainly it was lost, asks, sends nothing; the answer then alerts; never a fake done', async () => {
  const id = person(); chat.deps.scamText = verdict('warn'); reset(ASKS); await chat.sendText(id, MSG, null); chat.deps.scamText = verdict('none');
  const back = advance(30 * 3600000);
  try {
    assert.equal(care.scamPending(id), null, 'expired'); assert.ok(care.scamLost(id), 'but remembered as lost');
    reset(`${FEEL} Done, I let them know.`, `${FEEL} I lost that set-up while you were away, so nothing was sent yet.`); const r = await chat.sendText(id, 'yes please let my family know', null);
    assert.match(asked[0], /was lost while they were away, so NOTHING was sent/); assert.equal(care.view(id).scams.length, 0); assert.equal(care.get(id).notifications.filter((x) => x.to === 'family').length, 0);
    assert.match(last(r), /What happened, and would you like me to let your family know\?$/, 'the false "done" was rewritten, and the plain question closes it');
    reset(`${FEEL} Done.`); await chat.sendText(id, 'yes please', null); assert.equal(care.view(id).scams[0].level, 'alert');
  } finally { back(); }
});

test('"I\'m letting your family know now" with nothing sent is a false claim: blocked and rewritten', () => {
  const id = person(); const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id);
  for (const t of ["I'm letting your family know about that bank message now.", "I am telling your family about it.", "I've let your family know."]) assert.ok(c.breaksFacts(t), t);
  assert.ok(!c.breaksFacts('Would you like me to let your family know about this?'), 'the question is fine');
});

test('the follow-ups of a scam talk ("okay") are part of it: Spark reading them as urgent does not raise a health alert', async () => {
  const id = person(); chat.deps.scamText = verdict('warn'); reset(ASKS); await chat.sendText(id, MSG, null);
  chat.deps.scamText = verdict('none'); reset(`${FEEL} Good.`); await chat.sendText(id, 'no do not tell them', null);
  reset(`${URGENT} Good, leave that call alone.`); await chat.sendText(id, 'okay', null);
  assert.equal(care.get(id).notifications.filter((x) => x.to === 'family').length, 0, 'no alert to the family'); assert.ok(!care.hasActiveSafety(id));
});
