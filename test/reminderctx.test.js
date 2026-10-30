// care.reminderContext: what a person is dealing with on WhatsApp right now (waiting / answered / missed), for what Maya is told before she answers. Pure: it changes nothing,
// logs nothing. The selection is the same list the acknowledgement uses, so the fact and the ack always agree. The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-rctx-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const memory = require('../memory');
const care = require('../care');

const MIN = 60000, NOW = Date.now();   // the real clock: finishOccurrence stamps its own time
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const profile = () => memory.createProfile(`Ctx${letters(n++)}`, 'female').id;
// A reminder with a WhatsApp occurrence in the given state, sent `ago` minutes before NOW.
function remind(id, task, state, ago, extra = {}) {
  const r = care.addReminder(id, { task, dueAt: Date.now() + 99999, repeat: 'none' }); const mine = care.get(id).reminders.find((x) => x.id === r.id); mine.dueAt = null;
  const sentAt = NOW - ago * MIN;
  if (['wa_sent', 'wa_delivered', 'wa_read', 'wa_sending'].includes(state)) mine.active = { dueAt: sentAt, state, channel: 'whatsapp', attempts: 1, nudged: false, key: `${r.id}:x`, wamid: `wamid.${r.id}`, via: 'text', sentAt, startedAt: sentAt, nudgeAt: sentAt + 10 * MIN, missAt: sentAt + 60 * MIN, ...extra };
  else mine.last = { dueAt: sentAt, state, at: sentAt + (extra.afterMin || 0) * MIN, channel: 'whatsapp', via: 'text', sentAt, ...extra };
  return mine;
}

test('nothing in flight: all three are empty', () => {
  const id = profile(); assert.deepEqual(care.reminderContext(id, NOW), { waiting: null, answered: null, missed: null });
  assert.deepEqual(care.reminderContext('deadbeef', NOW), { waiting: null, answered: null, missed: null }, 'an unknown person is just empty');
});

test('waiting: a sent reminder with no answer yet, in any of sent / delivered / read, with the family\'s task, how long ago, voice or text, nudged or not', () => {
  for (const state of ['wa_sent', 'wa_delivered', 'wa_read']) {
    const id = profile(); remind(id, 'take your tablets', state, 7, { via: 'voice', nudged: false });
    const w = care.reminderContext(id, NOW).waiting; assert.deepEqual({ ...w, id: undefined }, { id: undefined, task: 'take your tablets', minutesAgo: 7, via: 'voice', nudged: false, others: 0 }, state);
  }
  const id = profile(); remind(id, 'go for a walk', 'wa_delivered', 12, { nudged: true }); assert.equal(care.reminderContext(id, NOW).waiting.nudged, true);
});

test('waiting: not while still sending, not once it is past its 60 minute Missed line, not if it never reached them', () => {
  const a = profile(); remind(a, 'x', 'wa_sending', 0); assert.equal(care.reminderContext(a, NOW).waiting, null, 'still sending: nothing has reached them');
  const b = profile(); remind(b, 'x', 'wa_delivered', 59); assert.ok(care.reminderContext(b, NOW).waiting, 'at 59 minutes it is still waiting');
  const c = profile(); remind(c, 'x', 'wa_delivered', 60); assert.equal(care.reminderContext(c, NOW).waiting, null, 'at 60 minutes it is past its line, even before the tick marks it Missed');
  const d = profile(); remind(d, 'x', 'wa_failed', 5); assert.deepEqual(care.reminderContext(d, NOW), { waiting: null, answered: null, missed: null }, 'Not sent: it never reached them');
});

test('several waiting: the most recently SENT is the one, a tie goes to the one added last, and the others are counted', () => {
  const id = profile(); remind(id, 'oldest', 'wa_delivered', 40); remind(id, 'newest', 'wa_sent', 3); remind(id, 'middle', 'wa_read', 20);
  const w = care.reminderContext(id, NOW).waiting; assert.equal(w.task, 'newest'); assert.equal(w.minutesAgo, 3); assert.equal(w.others, 2);
  const t = profile(); remind(t, 'added first', 'wa_sent', 5); remind(t, 'added second', 'wa_sent', 5); assert.equal(care.reminderContext(t, NOW).waiting.task, 'added second');
});

test('the context and the acknowledgement always pick the SAME reminder, in every arrangement', () => {
  for (const arrangement of [[40, 3, 20], [5, 5, 5], [1, 59, 30], [10, 10, 2], [59, 58, 57]]) {
    const id = profile(); arrangement.forEach((ago, i) => remind(id, `task ${i}`, ['wa_sent', 'wa_delivered', 'wa_read'][i % 3], ago));
    const told = care.reminderContext(id, NOW).waiting.task; assert.equal(care.reminderAckWhatsApp(id, true, NOW), true);
    const answered = care.get(id).reminders.filter((r) => r.last && r.last.state === 'done').map((r) => r.task); assert.deepEqual(answered, [told], `arrangement ${arrangement}`);
  }
});

test('answered: the most recent one answered in the last 30 minutes; older, or answered in another way, is not; thisMessage only for the reply that answered it', () => {
  const id = profile(); remind(id, 'took a while', 'done', 50, { afterMin: 5 }); remind(id, 'recent', 'done', 20, { afterMin: 8 });   // answered 37 and 12 minutes before NOW
  const a = care.reminderContext(id, NOW).answered; assert.equal(a.task, 'recent'); assert.equal(a.minutesAgo, 12); assert.equal(a.thisMessage, false);
  const old = profile(); remind(old, 'too long ago', 'done', 60, { afterMin: 5 }); assert.equal(care.reminderContext(old, NOW).answered, null, 'answered 55 minutes ago: out of the 30 minute window');
  const ring = profile(); const r = remind(ring, 'rung', 'done', 10); delete r.last.channel; assert.equal(care.reminderContext(ring, NOW).answered, null, 'answered in the app or a call: not a WhatsApp reply');
  const now = profile(); const m = remind(now, 'just now', 'wa_delivered', 4); care.get(now).lastAck = null;
  assert.equal(care.reminderAckWhatsApp(now, true, NOW), true); assert.equal(care.reminderContext(now, NOW).answered.thisMessage, true, 'the reply that answered it');
  assert.equal(care.reminderContext(now, NOW + 16 * 1000).answered.thisMessage, false, '16 seconds later it is just something that was answered earlier'); assert.equal(m.last.state, 'done');
});

test('missed: the most recent Missed one in the last 2 hours, silently known; older is not', () => {
  const id = profile(); remind(id, 'missed one', 'wa_missed', 100, { afterMin: 60 });   // marked Missed 40 minutes before NOW
  const m = care.reminderContext(id, NOW).missed; assert.equal(m.task, 'missed one'); assert.equal(m.minutesAgo, 40);
  const old = profile(); remind(old, 'long ago', 'wa_missed', 300, { afterMin: 60 }); assert.equal(care.reminderContext(old, NOW).missed, null);
});

test('all three can be true at once (another is waiting while one was just answered), and the call changes nothing and logs nothing', () => {
  const id = profile(); remind(id, 'answered earlier', 'done', 25, { afterMin: 5 }); remind(id, 'waiting now', 'wa_delivered', 4); remind(id, 'missed before', 'wa_missed', 150, { afterMin: 60 });
  const before = JSON.stringify(care.get(id)); const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' '));
  let c; try { c = care.reminderContext(id, NOW); c = care.reminderContext(id, NOW); } finally { console.log = l0; }
  assert.equal(c.waiting.task, 'waiting now'); assert.equal(c.answered.task, 'answered earlier'); assert.equal(c.missed.task, 'missed before');
  assert.equal(JSON.stringify(care.get(id)), before, 'nothing changed'); assert.deepEqual(logs, [], 'nothing logged');
});
