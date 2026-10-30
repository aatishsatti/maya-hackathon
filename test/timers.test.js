// In-call reminder timers: asking again for the SAME reminder is kept once (never two timers, never two reminders in two wordings), a different reminder is added, and every timer
// event is logged as counts only. The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-timers-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, sparkComplete: async () => '{}', sparkStream: async () => '', streamSpeech: async () => {}, describeImage: async () => 'unused' } };
const memory = require('../memory');
const { Call, restatedTimer } = require('../call');

let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const bareCall = () => { const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(memory.createProfile(`Tim${letters(n++)}`, 'female').id); c.gen = 1; c.abort = new AbortController(); return c; };
const dropTimers = (c) => { for (const t of c.timers) clearTimeout(t.handle); c.timers = []; };
const capture = (fn) => { const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' ')); try { fn(); } finally { console.log = l0; } return logs; };

test('the call that went wrong: ask, ask again, ask once more with different words: ONE timer, kept, with the repeat told that it is already set', () => {
  const c = bareCall();
  const first = c.careNotes('Remind me in 30 seconds to take my medicine.'); assert.equal(c.timers.length, 1); assert.match(first, /A timer is set for it right now/); const due = c.timers[0].dueAt;
  const middle = c.careNotes("I'll stay on the call. You remind me."); assert.equal(c.timers.length, 1, 'that is not a timer request'); assert.match(middle, /running right now/);
  const third = c.careNotes('You just remind me in 30 seconds that I have to take it.');
  assert.equal(c.timers.length, 1, 'still ONE timer'); assert.equal(c.timers[0].dueAt, due, 'the original due time is kept'); assert.equal(c.timers[0].task, 'take my medicine', 'and the original thing to remember');
  assert.match(third, /asked again for a reminder that is already set \(it is due in about \d+ seconds?\)/); assert.match(third, /Do not set another/); assert.match(third, /stay on the call for it, because the reminder only works while the call is open/);
  assert.doesNotMatch(third, /A timer is set for it right now/, 'not confirmed as a new timer'); dropTimers(c);
});

test('a repeat fills in the thing to remember if the first ask had none; a repeat with none keeps the first one\'s', () => {
  const a = bareCall(); a.careNotes('Remind me in 30 seconds.'); assert.ok(!a.timers[0].task, 'the first ask had no thing to remember');
  a.careNotes('Remind me in 30 seconds to drink water.'); assert.equal(a.timers.length, 1); assert.equal(a.timers[0].task, 'drink water'); dropTimers(a);
  const b = bareCall(); b.careNotes('Remind me in 2 minutes to call the pharmacy.'); b.careNotes('Remind me in 2 minutes.'); assert.equal(b.timers.length, 1); assert.equal(b.timers[0].task, 'call the pharmacy'); dropTimers(b);
});

test('a different length, a different thing, or an old timer are NOT the same reminder: they are added', () => {
  const a = bareCall(); a.careNotes('Remind me in 30 seconds to take my medicine.'); a.careNotes('Remind me in 60 seconds to take my medicine.'); assert.equal(a.timers.length, 2, 'a different length'); dropTimers(a);
  const b = bareCall(); b.careNotes('Remind me in 5 minutes to take my tablets.'); b.careNotes('Remind me in 5 minutes to call my sister.'); assert.equal(b.timers.length, 2, 'the same length but a different thing'); dropTimers(b);
  const c = bareCall(); c.careNotes('Remind me in 30 seconds to take my medicine.'); c.timers[0].createdAt -= 130000; c.careNotes('Remind me in 30 seconds to take my medicine.'); assert.equal(c.timers.length, 2, 'the first was made over two minutes ago'); dropTimers(c);
  assert.equal(restatedTimer([], { seconds: 30 }), null);
});

test('timer events are logged as counts only: set, already set, fired (and spoken), dropped when the call ends; never the words', async () => {
  const c = bareCall(); const logs = capture(() => { c.careNotes('Remind me in 30 seconds to take my private tulips medicine.'); c.careNotes('Remind me in 30 seconds that I have to take it, tulips.'); });
  assert.equal(logs.length, 2); assert.match(logs[0], /^timer \{"event":"set","seconds":30,"hasTask":true,"pending":1\}$/); assert.match(logs[1], /^timer \{"event":"already set","seconds":30,"hasTask":true,"pending":1\}$/);
  c.speakWhenFree = async () => ({ said: 'It is time.' }); const t = c.timers[0]; clearTimeout(t.handle);
  const l2 = []; const l0 = console.log; console.log = (...a) => l2.push(a.join(' ')); try { await c.fireTimer(t); } finally { console.log = l0; }
  assert.match(l2[0], /^timer \{"event":"fired","seconds":30,"hasTask":true,"lateMs":\d+,"pending":0\}$/); assert.match(l2[1], /^timer \{"event":"spoken","seconds":30\}$/);
  c.careNotes('Remind me in 10 minutes to rest.'); const l3 = capture(() => c.end()); assert.ok(l3.some((l) => /^timer \{"event":"dropped: the call ended before they were due","pending":1\}$/.test(l)), l3.join(' | '));
  assert.doesNotMatch([...logs, ...l2, ...l3].join('\n'), /tulips|medicine|rest|sister/);
});

test('a timer that comes due after the call is over says so (counts only) and speaks nothing', async () => {
  const c = bareCall(); c.careNotes('Remind me in 30 seconds to take my medicine.'); const t = c.timers[0]; clearTimeout(t.handle); c.closed = true;
  const out = []; const l0 = console.log; console.log = (...a) => out.push(a.join(' ')); try { await c.fireTimer(t); } finally { console.log = l0; }
  assert.deepEqual(out, ['timer {"event":"not fired: call already over","seconds":30}']);
});

test('the written chat cannot set timers and is unchanged', () => {
  const c = bareCall(); c.noTimers = true; const logs = capture(() => assert.match(c.careNotes('Remind me in 30 seconds to take my medicine.'), /you cannot set one/)); assert.equal(c.timers.length, 0); assert.equal(logs.length, 0);
});
