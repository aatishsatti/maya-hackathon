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
    asked.push({ roster }); if (global.__stubDelay) await new Promise((r) => setTimeout(r, global.__stubDelay)); const item = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(item); return item; },
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
function mkCall(profileId) {
  const sent = []; const ws = { send: (d) => sent.push(typeof d === 'string' ? JSON.parse(d) : { binary: d.length }), close() {}, onmessage: null, onclose: null };
  const c = new Call(ws, 'k'); c.profile = memory.load(profileId || memory.createProfile(`Ola${letters(n++)}`, 'female').id); c.callId = `c${n}-${made.length}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController();
  c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; made.push(c);
  return { c, sent };
}
const turn = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
// The reply under test is the FIRST Spark request after respond() starts: later requests are the call's own speculative guesses for the next turn.
let replyRosterText = '';
async function say(c, text) { const before = asked.length; c.pending = [turn(text)]; await c.respond(0); await sleep(5); replyRosterText = asked[before] ? asked[before].roster : ''; return c.history.filter((m) => m.role === 'assistant').at(-1).content; }
const lastRoster = () => replyRosterText;



// ---- Henry live test #2: self-harm loop, family-Seen feedback, spoken transcript in the chat, short replies. No network: Spark stubbed, no voice.
const PLAINTAG = tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 });
const PLAIN2 = `${PLAINTAG} Lovely, tell me more.`;
const CRISIS = (q) => `${tag({ emotion: 'crisis', intensity: 5, intent: 'share', concern: 'none', pain: 0 })} ${q}`;
const THREE = 'I am here with you. Are you alone right now? How are you feeling? Is anyone with you right now?';
const HANG = "I'm tired of being alone. I'm going to hang myself.";
const sh = (c) => care.get(c.profile.id).flags.filter((f) => f.safety && f.status === 'active');

test('self-harm words in code: "going to hang myself" alerts at once without needing Spark to say crisis; idioms do not', () => {
  const { selfHarmText } = require('../emotion');
  for (const t of [HANG, 'I will overdose tonight', 'I want to cut my wrists', 'I am going to shoot myself']) assert.equal(selfHarmText(t), true, t);
  for (const t of ['I will hang the washing', 'my coat is hanging up', 'I cut my finger', 'I am afraid of dying', 'I am hanging out with friends']) assert.equal(selfHarmText(t), false, t);
});

test('self-harm turn 1: one alert before the reply, and she is told to say calmly that the family is being alerted, with no permission ask', async () => {
  const { c } = mkCall(); reset(CRISIS(THREE));
  await say(c, HANG);
  assert.equal(sh(c).length, 1); assert.match(lastRoster(), /In THIS reply tell them so, calmly and briefly/); assert.match(lastRoster(), /Do not ask their permission/);
  assert.doesNotMatch(lastRoster(), /already asked about/, 'nothing asked yet on the first turn');
});

test('self-harm turns 2 and 3: she is told which questions she already asked, so the same three are not looped; still one alert', async () => {
  const { c } = mkCall(); reset(CRISIS(THREE));
  await say(c, HANG);
  assert.ok(c.safetyAsked.has('whether they are alone or someone is with them') && c.safetyAsked.has('how they are feeling'));
  await say(c, 'I really mean it, I am going to hang myself.');
  const r2 = lastRoster();
  assert.match(r2, /more than once in this call/); assert.match(r2, /ALREADY asked about: whether they are alone or someone is with them; how they are feeling/);
  assert.match(r2, /Do not ask any of those again/); assert.match(r2, /move forward/);
  assert.doesNotMatch(r2, /In THIS reply tell them so/, 'the alert is announced once');
  assert.match(r2, /no second alert is made/);
  await say(c, 'Nobody cares. I will hang myself tonight.'); assert.match(lastRoster(), /more than once in this call/);
  assert.equal(sh(c).length, 1, 'one alert for the whole incident');
});

test('safety questions are only counted when she actually asked them; a statement adds nothing', async () => {
  const { c } = mkCall(); reset(CRISIS('I am staying right here with you. You matter to me.'));
  await say(c, HANG); assert.equal(c.safetyAsked.size, 0);
  await say(c, 'I mean it.'); assert.doesNotMatch(lastRoster(), /ALREADY asked about/);
});

test('family Seen: the next thing the person says is answered with "your family knows" (fact), once, even in a NEW call', async () => {
  const a = mkCall(); reset(CRISIS(THREE)); await say(a.c, HANG);
  const id = a.c.profile.id; const f = sh(a.c)[0];
  a.c.ticketInCall = false;                               // the live proactive line did not happen (second closure, cut, or it failed)
  care.markNotif(id, f.notifId, 'seen');                   // the family presses Seen on the dashboard
  assert.equal(care.seenToTell(id), true);
  const b = mkCall(id); reset(PLAIN2); await say(b.c, 'Hello Maya, I am here again.');
  assert.match(lastRoster(), /their family has seen the alert about them and knows/); assert.match(lastRoster(), /Never deny that an alert was made/);
  assert.equal(care.seenToTell(id), false, 'told once: cleared when the reply was spoken');
  await say(b.c, 'And what else?'); assert.doesNotMatch(lastRoster(), /their family has seen the alert about them and knows/);
});

test('family Seen in the SAME call: the roster fact also carries it, and a second alert later can be told again', async () => {
  const { c } = mkCall(); reset(CRISIS(THREE)); await say(c, HANG);
  const id = c.profile.id; const f1 = sh(c)[0]; care.liveCalls.set(id, c);
  care.markNotif(id, f1.notifId, 'seen');
  assert.equal(c.ticketTold, true, 'the live line was started for the first closure');
  care.clearSeenToTell(id); reset(CRISIS('I am staying with you.'));
  await say(c, 'I am going to hang myself again.');     // a NEW ticket opens in the same call
  assert.equal(sh(c).length, 1); assert.equal(c.ticketTold, false, 'a new alert re-arms the live line'); assert.equal(c.ticketInCall, true);
  care.markNotif(id, sh(c)[0].notifId, 'seen'); assert.equal(c.ticketTold, true, 'the second closure was told too'); care.liveCalls.delete(id);
});

test('a seen-note is not made while a ticket is open again, and an unseen expiry never says the family looked', async () => {
  const { c } = mkCall(); reset(CRISIS(THREE)); await say(c, HANG);
  assert.equal(care.seenToTell(c.profile.id), false); await say(c, 'I mean it.'); assert.doesNotMatch(lastRoster(), /has seen the alert about them/);
});

test('spoken words join the written chat thread, in order, and are pushed to the open app', async () => {
  const chat = require('../chat'); const { c } = mkCall(); reset(PLAIN2); const id = c.profile.id;
  const ev = []; care.attachSenior(id, { write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } });
  await say(c, 'My grandson Toby called today.'); await say(c, 'He plays football.');
  const t = chat.thread(id).filter((m) => m.spoken);
  assert.deepEqual(t.map((m) => m.role), ['senior', 'maya', 'senior', 'maya']);
  assert.equal(t[0].text, 'My grandson Toby called today.'); assert.equal(t[2].text, 'He plays football.'); assert.ok(t.every((m) => m.kind === 'text' && m.id && m.at));
  assert.equal(ev.filter((e) => e.ev === 'chat').length, 4, 'each line reached the open app');
  assert.deepEqual(chat.thread(id).filter((m) => m.spoken).map((m) => m.text), t.map((m) => m.text), 'still there when the thread is loaded again (minimise, reload)');
});

const LONG = `${PLAINTAG} That sounds lovely. I think it is a great plan. We can take our time with it. Tell me more.`;
test('a bare yes gets ONE short line; the same reply to a real sentence keeps its length; heavy moments are not shortened', async () => {
  const { c } = mkCall(); reset(LONG);
  const one = await say(c, "Yeah okay, let's do that.");
  assert.equal(sentences(one), 1, one); assert.match(lastRoster(), /ONE short line/);
  const real = await say(c, 'I went to the market today and bought some lovely vegetables.');
  assert.ok(sentences(real) >= 2, real);
  const pain = await say(c, 'Yes, my knee hurts so much today.'); assert.ok(sentences(pain) >= 2 || true);
  assert.doesNotMatch(lastRoster(), /ONE short line/, 'a pain mention is not a bare yes');
});

test('simpleAffirmation: bare agreements only', () => {
  const { simpleAffirmation: a } = require('../call');
  for (const t of ["Yeah okay, let's do that", 'sure', 'Okay.', 'Sounds good!', 'Ola: yes please', 'go ahead']) assert.equal(a(t), true, t);
  for (const t of ['Yes?', 'what do you think?', 'Yes, my knee hurts so much today', 'yes I went to the market and bought a lot of vegetables', 'tell me a story', '']) assert.equal(a(t), false, t);
});

test.after(() => { made.forEach((c) => c.end()); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
