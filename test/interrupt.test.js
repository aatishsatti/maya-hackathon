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
  requireRealEnv() {}, streamSpeech: async (text, signal, onChunk) => { if (global.__voice) await global.__voice(text, signal, onChunk); }, sparkComplete: async () => '{}',
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



// ---- Interruption: what was generated but never reached the browser is not "said". Fake voice: the first piece sends audio, the rest wait.
const LOUD = (ms) => Buffer.alloc(48 * ms, 0x40);          // 16-bit samples 0x4040: loud enough to count as speech
const THREE = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} First, that sounds lovely to me. Second, I would like to hear more about it. Third, please tell me how the tea tasted.`;
const chatThread = (c) => require('../chat').thread(c.profile.id).filter((m) => m.spoken && m.role === 'maya').map((m) => m.text);

test('cut off after the first piece was heard: only that piece enters her history and the written thread; the queued pieces were never said', async () => {
  const { c, sent } = mkCall(); c.noVoice = false; reset(THREE);
  global.__voice = async (text, signal, onChunk) => {
    if (/First/.test(text)) { onChunk(LOUD(400)); return; }
    await new Promise((r) => { const t = setTimeout(r, 400); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  };
  c.pending = [turn('I had ginger tea this morning.')];
  const done = c.respond(0);
  for (let k = 0; k < 400 && !sent.some((m) => m.binary); k++) await sleep(5);
  assert.ok(sent.some((m) => m.binary), 'the first piece reached the browser');
  c.interrupt();                                          // the person talks over her
  await done; global.__voice = null;
  const said = c.history.filter((m) => m.role === 'assistant').at(-1).content;
  assert.match(said, /First/); assert.doesNotMatch(said, /Second|Third/, said);
  assert.deepEqual(chatThread(c).join(' ').match(/Second|Third/), null, 'the written thread does not show unheard sentences');
  assert.match(sent.filter((m) => m.type === 'stopped').length ? 'stopped' : '', /stopped/, 'the browser was told to drop its queue');
});

test('cut off before any audio was sent: nothing she "said" is recorded at all', async () => {
  const { c, sent } = mkCall(); c.noVoice = false; reset(THREE);
  global.__voice = async (text, signal) => { await new Promise((r) => { const t = setTimeout(r, 400); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }); };
  c.pending = [turn('I had ginger tea this morning.')];
  const done = c.respond(0); await sleep(60); c.interrupt(); await done; global.__voice = null;
  assert.equal(c.history.filter((m) => m.role === 'assistant').length, 0);
  assert.equal(chatThread(c).length, 0);
});

test('a reply that was spoken to the end is recorded whole, as before', async () => {
  const { c } = mkCall(); c.noVoice = false; reset(THREE);
  global.__voice = async (text, signal, onChunk) => { onChunk(LOUD(300)); };
  const said = await say(c, 'I had ginger tea this morning.'); global.__voice = null;
  assert.match(said, /First/); assert.match(said, /Second/); assert.match(said, /Third/);
});

test('a no-voice test call still records its words (its text events are its "audio")', async () => {
  const { c } = mkCall(); reset(THREE); const said = await say(c, 'Hello there.');
  assert.match(said, /First/);
});

test.after(() => { made.forEach((c) => c.end()); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
