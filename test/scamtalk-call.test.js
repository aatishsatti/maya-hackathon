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
const PAYING = 'He wants gift cards for the bail and I am going to the shop now to get them.';
const TOLD = 'A man phoned yesterday and said I owed tax and must pay with gift cards.';

test('ordinary talk: no check, no wait, no note; the filter step is synchronous so a normal turn gets no added delay', async () => {
  const { c } = mkCall(); calls = 0; callDeps.scamText = verdict('warn'); reset(PLAIN);
  assert.equal(typeof c.scamForTurn('I made some soup today and it smelled lovely.').then, 'undefined', 'nothing to wait for');
  await say(c, 'I made some soup today and it smelled lovely.');
  assert.equal(calls, 0); assert.doesNotMatch(lastRoster(), /SCAM CHECK/); assert.equal(care.scamPending(c.profile.id), null);
});

test('happening right now: the check is awaited, the SAME answer carries the pause note and is not shortened, and her one question is recorded as spoken + pause', async () => {
  const { c } = mkCall(); calls = 0; callDeps.scamText = verdict('pause', 'gift card scam', sig('money', 'payment'), rd('aboutToAct', 'happeningNow')); reset(FOUR);
  assert.equal(typeof c.scamForTurn(PAYING).then, 'function', 'a "happening right now" turn is the one that waits');
  const said = await say(c, PAYING);
  assert.equal(calls, 2, 'one check from the probe above and one from the turn itself');
  const roster = lastRoster();
  assert.match(roster, /about to act on it right now/); assert.match(roster, /Slow down: be steady, calm and brief/); assert.match(roster, /simply hang up or say they will call back/);
  assert.equal(sentences(said), 4, said);
  const p = care.scamPending(c.profile.id); assert.equal(p.channel, 'spoken'); assert.equal(p.pause, true); assert.equal(p.type, 'gift card scam');
  assert.equal(care.view(c.profile.id).scams.length, 0, 'no ticket until they answer');
});

test('already happened (not right now): the check runs beside her answer, THIS answer is untouched, the NEXT one carries the note', async () => {
  const { c } = mkCall(); calls = 0; callDeps.scamText = verdict('warn', 'tax scam', sig('urgency', 'payment')); reset(PLAIN);
  assert.equal(typeof c.scamForTurn(TOLD).then, 'undefined'); c.scamLater = null;
  const first = await say(c, TOLD); await sleep(10);
  assert.doesNotMatch(lastRoster(), /SCAM CHECK/, 'her first answer did not wait for it'); assert.equal(care.scamPending(c.profile.id), null);
  assert.ok(c.scamLater && c.scamLater.scam.level === 'warn', 'the verdict is kept for the next answer');
  reset(PLAIN); await say(c, 'He said it was very urgent.');
  assert.match(lastRoster(), /SCAM CHECK/); assert.match(lastRoster(), /looks like a possible tax scam/); assert.match(lastRoster(), /ONE short question/);
  assert.equal(care.scamPending(c.profile.id).channel, 'spoken'); assert.equal(care.scamPending(c.profile.id).pause, false);
  assert.equal(c.scamLater, null, 'used once');
});

test('a slow check never holds her back for long: after the cap she answers without it, and the verdict still shapes the next answer', async () => {
  const { c } = mkCall(); callDeps.awaitMs = 30;
  try {
    callDeps.scamText = async () => { await sleep(80); return { level: 'pause', type: 'gift card scam', reading: 'x', signals: sig('money', 'payment'), reads: rd('aboutToAct'), count: 2 }; }; reset(PLAIN);
    const t0 = Date.now(); await say(c, PAYING);
    assert.doesNotMatch(lastRoster(), /SCAM CHECK/); assert.ok(Date.now() - t0 < 70, 'did not wait for the slow check');
    await sleep(80); assert.equal(c.scamLater.scam.level, 'pause');
    reset(PLAIN); await say(c, 'I am nearly at the shop.'); assert.match(lastRoster(), /about to act on it right now/);
  } finally { callDeps.awaitMs = 2500; }
});

test('a late verdict goes stale: if the next thing she says comes much later it is not used', async () => {
  const { c } = mkCall(); calls = 0; callDeps.scamText = verdict('warn', 'tax scam', sig('urgency', 'payment')); reset(PLAIN);
  await say(c, TOLD); await sleep(10); assert.ok(c.scamLater);
  c.scamLater.at -= 31000; reset(PLAIN); await say(c, 'Anyway the weather is cold today.');
  assert.doesNotMatch(lastRoster(), /SCAM CHECK/);
});

test('a failed check changes nothing: she answers normally, nothing is asked, nothing is invented', async () => {
  const { c } = mkCall(); callDeps.scamText = async () => { throw new Error('Meta Spark failed (HTTP 503)'); }; reset(PLAIN);
  const said = await say(c, PAYING);
  assert.equal(said.length > 0, true); assert.doesNotMatch(lastRoster(), /SCAM CHECK/); assert.equal(care.scamPending(c.profile.id), null);
  callDeps.scamText = async () => null; reset(PLAIN); await say(c, TOLD); assert.equal(care.scamPending(c.profile.id), null, 'no key: no check');
});

test('a guessed early answer cannot skip the note: on a checked turn it is thrown away and the answer is written again', async () => {
  const { c } = mkCall(); calls = 0; let aborted = false;
  callDeps.scamText = verdict('pause', 'gift card scam', sig('money', 'payment'), rd('aboutToAct')); reset(FOUR);
  const t = turn(PAYING);
  c.spec = { textKey: c.textKey([t]), byLabel: new Map([['A', { rs: fixedReply(`${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} GUESSED ANSWER`), abort: { abort() { aborted = true; } } }]]) };
  c.pending = [t]; await c.respond(0); await sleep(5);
  const said = c.history.filter((m) => m.role === 'assistant').at(-1).content;
  assert.equal(aborted, true); assert.doesNotMatch(said, /GUESSED/); assert.match(asked[0].roster, /SCAM CHECK/, 'the first request after the turn is the one written with the note');
});

test('safety first: no check while a safety alert is active, for self-harm words, or while the family question is open', async () => {
  calls = 0; callDeps.scamText = verdict('warn');
  const a = mkCall().c; care.selfHarmAlert(a.profile.id); reset(PLAIN); await say(a, TOLD); assert.equal(calls, 0, 'active safety alert');
  const b = mkCall().c; reset(PLAIN); await say(b, 'I do not want to live and a man asked me for gift cards.'); assert.equal(calls, 0, 'self-harm words');
  const d = mkCall().c; reset(PLAIN); await say(d, TOLD); await sleep(10); const before = calls; assert.ok(before >= 1);
  reset(PLAIN); await say(d, 'He also said I must not tell my son about the code.'); // this answer carries the verdict above and asks her one question: it is now open
  const after = calls; reset(PLAIN); await say(d, 'He also asked about my bank account number and said it was urgent.'); assert.equal(calls, after, 'a pending question: no new check');
});

test('yes to her question: one topic-only alert that says it was something they told Maya (spoken), and she is told what was sent', async () => {
  const { c } = mkCall(); const ev = family(); callDeps.scamText = verdict('warn', 'tax scam', sig('urgency', 'payment')); reset(PLAIN);
  await say(c, TOLD); await sleep(10); reset(PLAIN); await say(c, 'He said it was very urgent.');
  assert.ok(care.scamPending(c.profile.id)); callDeps.scamText = verdict('none'); reset(PLAIN);
  await say(c, 'Yes please, tell my son.');
  const v = care.view(c.profile.id); assert.equal(v.scams.length, 1); assert.equal(v.scams[0].level, 'alert'); assert.equal(v.scams[0].channel, 'spoken');
  const sent = ev.filter((e) => e.ev === 'notify' && e.data.id === c.profile.id); assert.equal(sent.length, 1);
  assert.match(sent[0].data.text, /told Maya about a call or message that looks like a possible tax scam/); assert.doesNotMatch(sent[0].data.text, /gift cards|owed|bail|phoned/i);
  assert.match(lastRoster(), /the app has now sent their family an alert saying only what kind of message it was/);
});

test('the scam answer never starts the older "is something wrong?" health alert, and no memory follow-up is offered in a scam moment', async () => {
  const { c } = mkCall(); const p = memory.load(c.profile.id); p.memory.threads = [{ id: 'tdue001', who: 'Priya', text: 'visiting', due: '2020-01-01', kind: 'event', status: 'open', asked: 0, told: '2019-12-01' }];
  callDeps.scamText = verdict('pause', 'gift card scam', sig('money', 'payment'), rd('aboutToAct')); reset(`${tag({ emotion: 'anxious', intensity: 4, intent: 'share', concern: 'unsure', pain: 0 })} Please stop for a moment. Would you like me to let your family know?`);
  await say(c, PAYING);
  assert.equal(c.pendingConcern, null, 'a "concern=unsure" read during a scam reply does not start the health question');
  assert.doesNotMatch(lastRoster(), /Open follow-up/); assert.equal(memory.load(c.profile.id).memory.threads[0].asked, 0);
});

test.after(() => { made.forEach((c) => c.end()); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
