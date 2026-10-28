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


// ---- Next-call reminders (Henry: "remind me the next time I call that I need to call my grandson"). No network: Spark stubbed, no voice.
const recall = require('../recall');
const PLAINTAG = tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 });
const PLAIN2 = `${PLAINTAG} Lovely, tell me more.`;
const HEAVY = `${tag({ emotion: 'sad', intensity: 3, intent: 'share', concern: 'none', pain: 1 })} I am sorry you are hurting.`;
const ASK = 'Can you remind me the next time that I call you that I need to call my grandson?';
const reminders = (c) => memory.load(c.profile.id).memory.threads.filter((t) => t.kind === 'reminder');

test('parser: the ways of asking, the task in their words; timers, no-task and ordinary talk are not reminders', () => {
  const P = recall.parseNextCallReminder;
  assert.equal(P(ASK), 'I need to call my grandson');
  assert.equal(P('Remind me next time to call my grandson.'), 'call my grandson');
  assert.equal(P('please remind me to take the washing in when I call you again'), 'take the washing in');
  assert.equal(P('Remind me about the doctor on my next call'), 'the doctor');
  for (const t of ['Remind me in 5 minutes to call him', 'remind me next time', 'I will call him the next time he phones', 'what time is it', '']) assert.equal(P(t), '', t);
});

test('asked in a call: filed at once as an open reminder with his words; she is told the app keeps it; not shown again in the same call', async () => {
  const { c } = mkCall(); reset(PLAIN2);
  await say(c, ASK);
  const r = reminders(c); assert.equal(r.length, 1); assert.equal(r[0].status, 'open'); assert.equal(r[0].text, 'I need to call my grandson'); assert.equal(r[0].asked, 0);
  assert.match(lastRoster(), /The app keeps it and will bring it to you at the start of their next call/); assert.match(lastRoster(), /Do not say you cannot do it/);
  await say(c, 'Thank you, what a lovely day.');
  assert.doesNotMatch(lastRoster(), /REMINDER THEY ASKED YOU FOR/, 'not on the call it was asked in'); assert.equal(reminders(c)[0].asked, 0);
});

test('next call: task first as a fact on her first reply, delivered once; the call after that does not repeat it', async () => {
  const a = mkCall(); reset(PLAIN2); await say(a.c, ASK);
  const id = a.c.profile.id;
  const b = mkCall(id); await say(b.c, 'Hello Maya, how are you?');
  assert.match(lastRoster(), /REMINDER THEY ASKED YOU FOR/); assert.match(lastRoster(), /I need to call my grandson/); assert.match(lastRoster(), /task first/);
  assert.match(lastRoster(), /no health or dose words/);
  assert.equal(reminders(b.c)[0].asked, 1);
  await say(b.c, 'And what else is new?'); assert.doesNotMatch(lastRoster(), /REMINDER THEY ASKED YOU FOR/, 'once in the call');
  const c3 = mkCall(id); await say(c3.c, 'Hello again.');
  assert.doesNotMatch(lastRoster(), /REMINDER THEY ASKED YOU FOR/, 'not on the following call'); assert.equal(reminders(c3.c)[0].asked, 1);
});

test('"not done yet" about a reminder shown in this call brings it back next call, once more', async () => {
  const a = mkCall(); reset(PLAIN2); await say(a.c, ASK); const id = a.c.profile.id;
  const b = mkCall(id); await say(b.c, 'Hello Maya.'); assert.match(lastRoster(), /REMINDER THEY ASKED YOU FOR/);
  await say(b.c, 'Oh I have not done that yet, I still need to call him.');
  assert.match(lastRoster(), /still to do/); assert.equal(reminders(b.c)[0].asked, 0);
  await say(b.c, 'Anyway.'); assert.doesNotMatch(lastRoster(), /REMINDER THEY ASKED YOU FOR/, 'not again in the same call');
  const c3 = mkCall(id); await say(c3.c, 'Hello again, Maya.'); assert.match(lastRoster(), /REMINDER THEY ASKED YOU FOR/);
  const c4 = mkCall(id); await say(c4.c, 'Hello again, Maya.'); assert.doesNotMatch(lastRoster(), /REMINDER THEY ASKED YOU FOR/);
});

test('"still to do" said in a later call, when no reminder was shown in it, changes nothing', async () => {
  const a = mkCall(); reset(PLAIN2); await say(a.c, ASK); const id = a.c.profile.id;
  const b = mkCall(id); await say(b.c, 'Hello Maya.');
  const c3 = mkCall(id); await say(c3.c, 'I have not done many things yet.'); assert.equal(reminders(c3.c)[0].asked, 1);
});

test('a heavy moment holds the reminder back; a light turn later in that call delivers it', async () => {
  const a = mkCall(); reset(PLAIN2); await say(a.c, ASK); const id = a.c.profile.id;
  const b = mkCall(id); reset(HEAVY); await say(b.c, 'My knee hurts so much today.');
  assert.doesNotMatch(lastRoster(), /REMINDER THEY ASKED YOU FOR/); assert.equal(reminders(b.c)[0].asked, 0);
  reset(PLAIN2); await say(b.c, 'I am having tea now, it is nice.'); await say(b.c, 'The tea is ginger tea.');
  assert.equal(reminders(b.c)[0].asked, 1);
});

test('the same ask twice is one reminder; the sixth open one is not kept and she is told', async () => {
  const { c } = mkCall(); reset(PLAIN2);
  await say(c, ASK); await say(c, ASK); assert.equal(reminders(c).length, 1);
  for (const w of ['feed the cat', 'phone the bank', 'water the plants', 'post the letter']) await say(c, `Remind me next time to ${w}.`);
  assert.equal(reminders(c).length, 5);
  await say(c, 'Remind me next time to buy milk.'); assert.equal(reminders(c).length, 5); assert.match(lastRoster(), /already holding several reminders/);
});

test('a timer ask is still a timer, not a next-call reminder', async () => {
  const { c } = mkCall(); reset(PLAIN2); await say(c, 'Remind me in 20 seconds to turn the stove off.');
  assert.equal(reminders(c).length, 0);
});

test('filing: Spark cannot create, rewrite, duplicate or reopen a reminder; it can close one that was done', () => {
  const mk = () => [{ id: 't000001', who: '', text: 'call my grandson', due: '', kind: 'reminder', status: 'open', asked: 0, told: '2026-10-29', fromCall: 'x' }];
  let out = recall.mergeThreads(mk(), [{ id: 't000001', text: 'call my grandson Toby', kind: 'plan', due: '2026-11-01' }, { who: '', text: 'call my grandson', kind: 'reminder' }], '2026-10-30');
  assert.equal(out.length, 1); assert.equal(out[0].text, 'call my grandson'); assert.equal(out[0].kind, 'reminder'); assert.equal(out[0].due, '');
  out = recall.mergeThreads(mk(), [{ id: 't000001', status: 'closed' }], '2026-10-30'); assert.equal(out[0].status, 'closed');
  const closed = [{ ...mk()[0], status: 'closed' }];
  out = recall.mergeThreads(closed, [{ id: 't000001', text: 'call my grandson', status: 'open' }], '2026-10-30'); assert.equal(out[0].status, 'closed');
  out = recall.mergeThreads(mk(), [], '2026-12-30'); assert.equal(out[0].status, 'expired', 'after 30 days it is just over');
});

test('dueThread: a reminder comes before dated follow-ups, and never in the call that made it', () => {
  const th = [{ id: 'a', who: '', text: 'visit', due: '2026-10-29', kind: 'event', status: 'open', asked: 0, told: '2026-10-20' }, { id: 'b', who: '', text: 'call him', due: '', kind: 'reminder', status: 'open', asked: 0, told: '2026-10-29', fromCall: 'c1' }];
  assert.equal(recall.dueThread(th, '2026-10-29', { callId: 'c2' }).id, 'b'); assert.equal(recall.dueThread(th, '2026-10-29', { callId: 'c1' }).id, 'a');
  assert.match(recall.threadFact(th[1], '2026-10-29'), /^call him; they asked on 2026-10-29/);
});

test('a reply cut off before it is spoken leaves the reminder due: not marked delivered, offered again next time, then delivered once', async () => {
  const a = mkCall(); reset(PLAIN2); await say(a.c, ASK); const id = a.c.profile.id;
  const b = mkCall(id); b.c.pending = [turn('Hello Maya, how are you today?')];
  global.__stubDelay = 80;
  const done = b.c.respond(0);
  await sleep(30); b.c.gen += 1;          // the person talks over her: this reply is dropped before it is spoken
  await done; global.__stubDelay = 0;
  assert.match(asked.at(-1).roster, /REMINDER THEY ASKED YOU FOR/, 'it was handed to Spark for that reply');
  assert.equal(reminders(b.c)[0].asked, 0, 'but not marked delivered');
  assert.equal(b.c.reminderShown, null);
  await say(b.c, 'Sorry, as I was saying, how are you?');            // the next reply in the same call carries it again
  assert.match(lastRoster(), /REMINDER THEY ASKED YOU FOR/); assert.equal(reminders(b.c)[0].asked, 1, 'now spoken: delivered');
  const c3 = mkCall(id); await say(c3.c, 'Hello again, Maya.'); assert.doesNotMatch(lastRoster(), /REMINDER THEY ASKED YOU FOR/);
});

test('a cut reply in one call keeps the reminder for the NEXT call too', async () => {
  const a = mkCall(); reset(PLAIN2); await say(a.c, ASK); const id = a.c.profile.id;
  const b = mkCall(id); b.c.pending = [turn('Hello Maya, how are you today?')];
  global.__stubDelay = 80; const done = b.c.respond(0); await sleep(30); b.c.gen += 1; await done; global.__stubDelay = 0;
  assert.equal(reminders(b.c)[0].asked, 0);
  const c3 = mkCall(id); await say(c3.c, 'Hello again, Maya.'); assert.match(lastRoster(), /REMINDER THEY ASKED YOU FOR/); assert.equal(reminders(c3.c)[0].asked, 1);
});

test.after(() => { made.forEach((c) => c.end()); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
