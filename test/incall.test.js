// Scam shield on a live call, end to end through Call.respond() (no network: Spark and the scam check are stubbed; no voice at all, noVoice).
// The sentences below exist only in this test file. Maya's wording is Spark's; these tests check the facts, limits, timing rules and family flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-scamcall-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');

const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}',
  sparkStream: async (history, roster, _s, onDelta) => {
    if (/has been silent for a little while/.test(roster)) { const idle = `${'[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]'} Are you still there?`; if (onDelta) onDelta(idle); return idle; }   // the call's own silence check is not one of the replies under test
    asked.push({ roster }); const item = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(item); return item; },
} };
const memory = require('../memory');
const care = require('../care');
const { Call, callDeps } = require('../call');
const { fixedReply } = require('../reply');
const S = require('../scam');

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} That sounds nice. Tell me more about it.`;
const FOUR = `${tag({ emotion: 'anxious', intensity: 3, intent: 'share', concern: 'none', pain: 0 })} Please stop for a moment. Do not send anything yet. It is safest to check with the real bank yourself. Would you like me to let your family know?`;
const sentences = (t) => (t.match(/[.!?](\s|$)/g) || []).length;
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const rd = (...on) => Object.fromEntries(S.READS.map((k) => [k, on.includes(k)]));
let calls = 0;
const verdict = (level, type = 'gift card scam', signals = sig('money', 'payment'), reads = rd()) => async () => { calls += 1; return { level, type, reading: 'Someone wants gift cards.', signals, reads, count: 2 }; };
const family = () => { const ev = []; care.attachFamily({ write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } }); return ev; };

const made = [];
function mkCall() {
  const sent = []; const ws = { send: (d) => sent.push(typeof d === 'string' ? JSON.parse(d) : { binary: d.length }), close() {}, onmessage: null, onclose: null };
  const c = new Call(ws, 'k'); c.profile = memory.load(memory.createProfile(`Ola${letters(n++)}`, 'female').id); c.callId = `c${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController();
  c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; made.push(c);
  return { c, sent };
}
const turn = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
// The reply under test is the FIRST Spark request after respond() starts: later requests are the call's own speculative guesses for the next turn.
let replyRosterText = '';
async function say(c, text) { const before = asked.length; c.pending = [turn(text)]; await c.respond(0); await sleep(5); replyRosterText = asked[before] ? asked[before].roster : ''; return c.history.filter((m) => m.role === 'assistant').at(-1).content; }
const lastRoster = () => replyRosterText;

// ---- In-call recall, pain consent, alert state (Henry's live test). No network: Spark is stubbed, no voice. Sentences below exist only here.
const PLAINTAG = tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 });
const CHECKTAG = tag({ emotion: 'neutral', intensity: 2, intent: 'check', concern: 'none', pain: 0 });
const PAIN1 = `${tag({ emotion: 'sad', intensity: 2, intent: 'share', concern: 'none', pain: 1 })} I am sorry, that sounds uncomfortable.`;
const UNSURE = `${tag({ emotion: 'anxious', intensity: 3, intent: 'share', concern: 'unsure', pain: 1 })} I am sorry it is back. Would you like me to let your family know?`;
const URGENT = `${tag({ emotion: 'anxious', intensity: 4, intent: 'share', concern: 'urgent', pain: 1 })} I am letting your family know, and I am right here with you.`;
const familyCount = (c) => require('../care').get(c.profile.id).notifications.filter((x) => x.to === 'family').length;
const active = (c) => require('../care').get(c.profile.id).flags.filter((f) => f.status === 'active' && f.safety);

test('in-call recall: a name told early in the call is in Spark\'s notes 10 turns later, only for asks that need it', async () => {
  const { c } = mkCall(); reset(PLAINTAG + ' Lovely.');
  await say(c, 'Today I was really happy because my grandson Toby called.');
  await say(c, 'He was promoted as a captain in his football team.');
  for (let k = 0; k < 10; k++) await say(c, `I am just enjoying my tea number ${k}.`);
  assert.ok(c.history.length <= 13 && !c.history.some((m) => /Toby/.test(m.content)), 'Toby has left the short history');
  assert.doesNotMatch(lastRoster(), /Toby/, 'an ordinary turn does not carry the call transcript');
  reset(CHECKTAG + ' Yes, I do.');
  await say(c, 'You remember his name?');
  assert.match(lastRoster(), /WHAT THEY TOLD YOU EARLIER IN THIS CONVERSATION/);
  assert.match(lastRoster(), /grandson Toby called/); assert.match(lastRoster(), /captain in his football team/);
});

test('in-call recall: the call words are capped, and a call with nothing said adds nothing', async () => {
  const { callWords } = require('../call');
  assert.equal(callWords([], 'do you remember my son'), ''); assert.equal(callWords(undefined, 'do you remember my son'), '');
  const said = Array.from({ length: 60 }, (_, k) => `Olaf: ${'word '.repeat(60)}${k}`);
  assert.ok(callWords(said, 'what did I tell you').length < 5800);
  assert.equal(callWords(said, 'I am having tea'), '');
});

test('negation: "please do not tell my family" is not a yes and not a request; a plain yes and a plain request still are', () => {
  const { affirmed, refusedFamily, CONCERN_YES, FAMILY_ASK } = require('../call');
  for (const t of ['Please do not tell my family', "Don't tell my son", 'I told you specifically do not alert my family', 'no please, never call my daughter']) {
    assert.equal(affirmed(CONCERN_YES, t), false, t); assert.equal(affirmed(FAMILY_ASK, t), false, t);
  }
  assert.equal(refusedFamily('Please do not tell my family'), true); assert.equal(refusedFamily('Yes tell my son'), false);
  for (const t of ['Yes please', 'yeah go ahead', 'Please tell my daughter', 'Yes, let them know']) assert.equal(affirmed(CONCERN_YES, t) || affirmed(FAMILY_ASK, t), true, t);
});

test('pain: ask, no, ask again is blocked, no again: nothing is sent and the question is not repeated', async () => {
  const { c } = mkCall(); const id = c.profile.id;
  reset(PAIN1); await say(c, 'My knee hurts a bit.');
  reset(UNSURE); await say(c, 'My knee hurts again.');
  assert.ok(c.pendingConcern, 'she asked and waits');
  reset(PAIN1); await say(c, 'No, please do not tell my family.');
  assert.equal(c.pendingConcern, null); assert.equal(c.familyDeclined, true); assert.equal(familyCount(c), 0, 'nothing sent after a no');
  reset(UNSURE); await say(c, 'The knee is hurting again.');
  assert.equal(c.pendingConcern, null, 'a second unsure read does not reopen the question');
  assert.match(lastRoster(), /told you no to letting their family know/, 'the no is a standing fact, not a one-turn note');
  reset(PAIN1); await say(c, 'No, I said do not tell them.');
  assert.equal(familyCount(c), 0); assert.equal(active(c).length, 0); assert.equal(c.health, false);
});

test('a refusal with no question open sends nothing and is remembered for the call', async () => {
  const { c } = mkCall(); reset(PLAINTAG + ' Alright.');
  await say(c, 'I told you specifically do not alert my family.');
  assert.equal(familyCount(c), 0); assert.equal(c.familyDeclined, true);
});

test('"cannot move" from the start: she asks first and nothing is alerted until the answer is yes', async () => {
  const { c } = mkCall();
  reset(UNSURE); await say(c, 'The pain is way too much, I cannot move.');
  assert.ok(c.pendingConcern); assert.equal(familyCount(c), 0); assert.equal(active(c).length, 0);
  reset(PAIN1); await say(c, 'Yes please tell them.');
  assert.equal(familyCount(c), 1);
});

test('urgent after an earlier no: the alert is made, the reason is logged, and she is told it is different', async () => {
  const { c } = mkCall(); const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    reset(UNSURE); await say(c, 'My knee hurts again.');
    reset(PAIN1); await say(c, 'No, do not tell my family.');
    reset(URGENT); await say(c, 'I fell and I cannot get up.');
  } finally { console.log = orig; }
  assert.equal(c.health, true); assert.equal(active(c).length, 1);
  const h = logs.find((l) => /^health /.test(l)); assert.ok(h, 'a health log line exists');
  const j = JSON.parse(h.slice(7)); assert.equal(j.reason, 'concern=urgent'); assert.equal(j.overrodeEarlierNo, true); assert.equal(j.newAlert, true);
  reset(PAIN1); await say(c, 'Why did you do that?');
  assert.match(lastRoster(), /different because what they described sounds serious/);
  await say(c, 'But why?');
  assert.match(lastRoster(), /already been alerted/); assert.match(lastRoster(), /never deny it/);
});

test('urgent with no earlier no: the log says so too', async () => {
  const { c } = mkCall(); const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  try { reset(URGENT); await say(c, 'I fell and hit my head.'); } finally { console.log = orig; }
  const j = JSON.parse(logs.find((l) => /^health /.test(l)).slice(7)); assert.equal(j.overrodeEarlierNo, false); assert.equal(j.reason, 'concern=urgent');
});

test('alert state: after she asked and they said yes, every later reply carries that a note was sent; she is never left to deny it', async () => {
  const { c } = mkCall();
  reset(UNSURE); await say(c, 'My knee hurts again.');
  reset(PAIN1); await say(c, 'Yes, please let them know.');
  assert.equal(familyCount(c), 1);
  reset(PLAINTAG + ' Of course.'); await say(c, 'Why did you do that?');
  const r = lastRoster();
  assert.match(r, /sent their family 1 note/); assert.match(r, /never say you have not told them/); assert.match(r, /do not know what the dashboard shows/);
  await say(c, 'And what else?'); assert.match(lastRoster(), /sent their family 1 note/, 'still there on the turn after');
});

test('alert state: a plain "tell my family" request is also remembered as a sent note', async () => {
  const { c } = mkCall(); reset(PLAINTAG + ' Done.');
  await say(c, 'Please tell my family I would like to hear from them.');
  assert.equal(familyCount(c), 1);
  await say(c, 'Did you do it?'); assert.match(lastRoster(), /sent their family 1 note/);
});

test('alert state: with nothing sent, the roster does not claim a note', async () => {
  const { c } = mkCall(); reset(PLAINTAG + ' Fine.'); await say(c, 'Hello there.');
  assert.doesNotMatch(lastRoster(), /sent their family \d note/);
});
test.after(() => { made.forEach((c) => c.end()); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
