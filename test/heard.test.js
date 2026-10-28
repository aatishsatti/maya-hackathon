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



// ---- Generated is not heard: what must be TOLD (a new family alert, a scam warning, the family-Seen line) counts as told only when spoken to the end.
const PLAINTAG = tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 });
const PLAIN2 = `${PLAINTAG} Lovely, tell me more.`;
const CRISIS = `${tag({ emotion: 'crisis', intensity: 5, intent: 'share', concern: 'none', pain: 0 })} I am staying right here with you.`;
const HANG = "I'm tired of being alone. I'm going to hang myself.";
const TOLD = 'He wants gift cards for the bail and I am going to the shop now to get them.';   // happening now: the check is awaited, so the verdict shapes THIS reply
const sh = (c) => care.get(c.profile.id).flags.filter((f) => f.safety && f.status === 'active');
async function cut(c, text) {   // the person talks over her: the reply is dropped before it is spoken
  c.pending = [turn(text)]; global.__stubDelay = 80;
  const done = c.respond(0); await sleep(30); c.gen += 1; await done; global.__stubDelay = 0;
}

test('a cut reply does not use up "your family is being alerted": the alert exists once, the telling is repeated on the next reply, then not again', async () => {
  const { c } = mkCall(); reset(CRISIS);
  await cut(c, HANG);
  assert.equal(sh(c).length, 1, 'the alert itself is made at once');
  assert.match(asked.at(-1).roster, /In THIS reply tell them so/, 'it was handed to Spark for the cut reply');
  assert.equal(c.safetyFresh, true, 'but not counted as told');
  await say(c, 'I mean it.'); assert.match(lastRoster(), /In THIS reply tell them so/, 'owed again on the next reply');
  assert.equal(c.safetyFresh, false, 'spoken to the end: now told');
  await say(c, 'Still here.'); assert.doesNotMatch(lastRoster(), /In THIS reply tell them so/);
  assert.equal(sh(c).length, 1, 'never a second alert');
});

test('the same for an urgent health alert (no asking first)', async () => {
  const { c } = mkCall(); const URG = `${tag({ emotion: 'anxious', intensity: 4, intent: 'share', concern: 'urgent', pain: 1 })} I am letting your family know.`;
  reset(URG); await say(c, 'I fell and I cannot get up.');                       // the urgent tag is read on this reply; the fact is built for the NEXT one
  assert.equal(c.health, true); assert.equal(c.healthFresh, true);
  c.pending = [turn('Hello?')]; global.__stubDelay = 80; const done = c.respond(0); await sleep(30); c.gen += 1; await done; global.__stubDelay = 0;
  assert.match(asked.at(-1).roster, /has just alerted their family/); assert.equal(c.healthFresh, true, 'cut: still owed');
  await say(c, 'Are you there?'); assert.match(lastRoster(), /has just alerted their family/); assert.equal(c.healthFresh, false);
});

test('a scam warning that was cut off is owed again on the next reply; the family question is only registered once she has really asked it', async () => {
  const { c } = mkCall(); const id = c.profile.id; calls = 0;
  callDeps.scamText = verdict('warn'); reset(PLAIN2);
  await cut(c, TOLD);
  assert.match(asked.at(-1).roster, /scam/i, 'the cut reply did carry the scam note');
  assert.equal(care.scamPending(id), null, 'a cut warning did not register its question');
  assert.ok(c.scamLater && c.scamLater.scam.level === 'warn', 'the verdict is carried to the next reply');
  callDeps.scamText = async () => null;
  await say(c, 'Sorry, what did you say?');
  assert.match(lastRoster(), /SCAM|scam/, 'the next reply carries the scam note again');
  assert.ok(care.scamPending(id), 'now spoken to the end: the one question to the family is registered');
});

test('a scam warning that was spoken is not repeated on the next reply', async () => {
  const { c } = mkCall(); calls = 0; callDeps.scamText = verdict('warn'); reset(PLAIN2);
  await say(c, TOLD); assert.ok(care.scamPending(c.profile.id));
  callDeps.scamText = async () => null; await say(c, 'Thank you, dear.');
  assert.equal(c.scamLater, null); assert.doesNotMatch(lastRoster(), /SCAM CHECK|scam/i);
});

test('family Seen told by her own line: counted as told only when she got to say it', async () => {
  const { c } = mkCall(); reset(CRISIS); await say(c, HANG);
  const id = c.profile.id; care.liveCalls.set(id, c); reset(PLAIN2);
  care.markNotif(id, sh(c)[0].notifId, 'seen');
  await sleep(400); care.liveCalls.delete(id);
  assert.equal(care.seenToTell(id), false, 'she said it: no longer owed');
});

test.after(() => { made.forEach((c) => c.end()); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
