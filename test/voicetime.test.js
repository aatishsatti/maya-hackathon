// Voice-transcript details of the daily-call flow (social.step level): spoken times, split fragments, a yes that restates, a correction that is not a decline, a yes that needs a SPOKEN question, promises blocked by GUARD. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-vtime-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on';
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async (_h, _r, _s, d) => { if (d) d('Okay.'); return 'Okay.'; } } };
const memory = require('../memory'); const care = require('../care'); const social = require('../social'); const setrem = require('../setrem'); const smart = require('../smart'); const state = require('../state');
const TZ = 'America/New_York', NOW = setrem.zonedEpoch(2026, 11, 5, 4, 0, TZ);   // 04:00, so a 5:10 am start today is still ahead
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => { const p = memory.createProfile(`Vt${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; care.get(p.id).tzSource = 'device'; return p.id; };
const sess = (id) => ({ profile: memory.load(id), channel: 'call', factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' });
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
let clock = 0; const say = (s, t) => social.step(s, t, ctx(), NOW + (clock += 5));
const offer = (id) => care.get(id).smart.social.offer; const recs = (id) => care.get(id).reminders.filter((r) => r.social);
const speak = (id, text) => social.markAsked(id, text);
care.cfg.quietStart = 0; care.cfg.quietEnd = 0;
test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 spoken times are read right: "5.10 am", "five ten", "ten past five", "half past five", "quarter to six", "a.m."', () => {
  const cases = [['5.10 am', '5:10 am'], ['at five ten', '5:10'], ['five ten am', '5:10 am'], ['ten past five', '5:10'], ['half past five', '5:30'], ['quarter to six', '5:45'], ['4.40 a.m.', '4:40 am'], ['quarter past seven', '7:15']];
  for (const [said, want] of cases) assert.match(social.normSpeech(said), new RegExp(want.replace('.', '\\.')), said);
  const id = senior(), s = sess(id);
  say(s, 'could you call me every morning'); const r = say(s, 'at 5.10 am starting today');
  assert.equal(r[0], 'social-confirm'); assert.deepEqual([offer(id).time.h, offer(id).time.mi], [5, 10], '"5.10 am" is 5:10, not 10:00');
});

test('2 split speech keeps ONE proposal: "at five ten" / "every morning starting" / "today" / "am" in any order', () => {
  const orders = [['every day', 'at five ten', 'starting today', 'am'], ['every morning', 'at five ten', 'starting today'], ['can you call me every day', 'am', 'at five ten', 'today'], ['call me daily', 'five ten', 'in the morning', 'starting today']];
  for (const frags of orders) {
    const id = senior(), s = sess(id); let last;
    for (const f of frags) last = say(s, f.startsWith('every') || f.startsWith('call') || f.startsWith('can') ? (/call/.test(f) ? f : `call me ${f}`) : f);
    const o = offer(id); assert.ok(o, frags.join(' | ')); assert.deepEqual([o.time && o.time.h, o.time && o.time.mi], [5, 10], frags.join(' | ')); assert.equal(recs(id).length, 0);
    assert.equal(o.stage, 'confirm', frags.join(' | ')); assert.ok(last && last[0] === 'social-confirm', frags.join(' | '));
  }
});

test('3 a yes that only restates the proposal is the yes; a different time, a condition or a question is not; and only a SPOKEN confirm question can be agreed to', () => {
  const id = senior(), s = sess(id);
  say(s, 'call me every morning'); say(s, 'at 5.10 am starting today');
  let r = say(s, 'Yeah, 5.10 am');   // the confirm was never spoken
  assert.equal(r[0], 'social-confirm'); assert.match(r[1], /has not been put to them yet/); assert.equal(recs(id).length, 0, 'a proposal Maya never said aloud cannot be agreed to');
  speak(id, 'Shall I call you every morning at 5:10 am starting today?'); assert.ok(offer(id).asked);
  r = say(s, 'Yeah, 6.10 am'); assert.notEqual(r[0], 'social-saved'); assert.equal(recs(id).length, 0);   // a different time: a correction, asked again
  assert.equal(offer(id).asked, null, 'the old spoken question no longer stands'); speak(id, 'So every day at 6:10 am starting today?');
  r = say(s, 'yes but not on sundays'); assert.equal(recs(id).length, 0); assert.equal(r[0], 'social-condition');
  say(s, 'ok six ten am'); speak(id, 'Shall I call you every day at 6:10 am starting today?');
  r = say(s, "Yeah, it's 6.10 am"); assert.equal(r[0], 'social-saved'); assert.equal(recs(id).length, 1); assert.equal(care.socialOf(id).h, 6);
  say(s, "Yeah, it's 6.10 am"); assert.equal(recs(id).length, 1, 'a repeated yes saves nothing more');
});

test('4 a "no" that corrects is not a decline and cancels nothing; a bare "no thanks" still declines', () => {
  const id = senior(), s = sess(id); say(s, 'call me every morning'); say(s, 'at 5.10 am starting today'); speak(id, 'Shall I call you every day at 5:10 am starting today?');
  for (const t of ['No, you just said you can call me every day.', 'No, I said five ten', 'no that is not what I said']) { const r = say(s, t); assert.ok(!r || r[0] !== 'social-declined', t); assert.ok(offer(id), `${t}: the proposal is still pending`); assert.equal(care.get(id).smart.social.declinedAt, undefined, t); }
  const r = say(s, 'no thanks'); assert.equal(r[0], 'social-declined'); assert.ok(care.get(id).smart.social.declinedAt);
  assert.equal(social.isDecline('No.'), true); assert.equal(social.isDecline('no, not now'), true); assert.equal(social.isDecline('No, you can call me every day'), false);
});

test('5 GUARD: promises worded as "I\'ll get that ready", "pass that along", "I\'ll get that set" are blocked while nothing is saved, and pass once it is saved', () => {
  const id = senior(), s = sess(id); s.lastHeard = () => 'can you call me at 5.13 every day'; s.factLabels = ['social-confirm'];
  for (const d of ["I'll get that 5:13 morning call ready for you.", "Sure, I'll pass that along.", "I'll get that set.", 'Noted, 3:40.', "I'll get that set up for you right away.", "On it, I'll have your call ready."]) assert.ok(smart.breaks(d, s), d);
  assert.equal(smart.breaks('Shall I call you every day at 5:13 am starting today?', s), null);
  say(s, 'call me every morning'); say(s, 'at 5.13 am starting today'); speak(id, 'Shall I call you every day at 5:13 am?'); const r = say(s, 'yes perfect'); assert.equal(r[0], 'social-saved'); s.factLabels = ['social-saved']; s._exec.social = true;
  assert.equal(smart.breaks('Your daily call is saved for 5:13 am; I will ring you then.', s), null);
});

test('6 the write is verified before any success language: a save the record does not confirm is reported as NOT saved', () => {
  const id = senior(), s = sess(id); say(s, 'call me every morning'); say(s, 'at 5.10 am starting today'); speak(id, 'Shall I call you every day at 5:10 am?');
  const real = care.socialOf; let first = true; care.socialOf = (i) => { const o = real(i); return first && o ? ((first = false), { ...o, h: 9 }) : o; };
  let r; try { r = say(s, 'yes please'); } finally { care.socialOf = real; }
  assert.equal(r[0], 'social-failed'); assert.match(r[1], /NOT SAVED/); assert.match(care.get(id).smart.social.lastSave.error || '', /did not match what was agreed/);
});

test('7 the compact APP TRUTH block: ownership, web eligibility, pending detail, latest verified action; unknown when unreadable', () => {
  const id = senior(), s = sess(id); say(s, 'call me every morning'); say(s, 'at 5.10 am starting today');
  const t = state.compact(state.build(id, { channel: 'call', now: NOW + 100 }));
  for (const re of [/senior owns their daily call/, /family is NOT needed/, /registered phone is NOT needed/, /web page or app/, /DAILY CALL: none saved/, /PENDING.*5:10 am/, /LATEST ACTION: none/, /unverified/]) assert.match(t, re);
  assert.ok(t.length < 1400, `${t.length}`);
  assert.match(state.compact({ unknown: true }), /could not be read/);
});
