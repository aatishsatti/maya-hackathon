// GUARD (factual): a draft is judged against the senior's own state card, built at check time. Synthetic seniors, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-sguard-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on';
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async (_h, _r, _s, d) => { if (d) d('Okay.'); return 'Okay.'; } } };
const memory = require('../memory'); const care = require('../care'); const smart = require('../smart'); const social = require('../social'); const setrem = require('../setrem'); const state = require('../state');
const TZ = 'America/New_York', NOW = setrem.zonedEpoch(2026, 11, 5, 10, 0, TZ);
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => { const p = memory.createProfile(`Guard${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; return p.id; };
const sess = (id, labels = []) => ({ profile: memory.load(id), channel: 'chat', factLabels: labels, outreach: null, _exec: {}, lastHeard: () => '', _knownText: '' });
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
const spoke = (s, r) => { const o = r && /^social-(?:confirm|decide-ambiguous)/.test(r[0]) && care.get(s.profile.id).smart.social.offer; if (o && o.stage === 'confirm' && o.time) social.markAsked(s.profile.id, `Shall I call you every day at ${o.time.h % 12 || 12}:${String(o.time.mi).padStart(2, '0')} ${o.time.h < 12 ? 'am' : 'pm'}?`); return r; };   // what Spark SPEAKS: a yes binds only to a confirm question that was really said
const say = (s, t) => spoke(s, social.step(s, t, ctx(), NOW + 10));
const saveCall = (id, s) => { say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow'); return say(s, 'yes perfect'); };
const blocked = (s, t) => smart.breaks(t, s);
test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 forced save failure: no success claim reaches the senior, and the plain line is true', () => {
  const id = senior(), s = sess(id);
  const real = care.socialSave; care.socialSave = () => { throw Object.assign(new Error('The disk is full.'), { status: 500 }); };
  let r; try { say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow'); r = say(s, 'yes perfect'); } finally { care.socialSave = real; }
  assert.equal(r[0], 'social-failed'); s.factLabels = ['social-failed'];
  for (const d of ['Done! Your daily call is all set for 3 pm.', "Lovely, I've scheduled it.", 'Okay, noted, I will call you at 3 pm tomorrow.', 'Your daily call is saved for 3:00 pm.', 'All set, see you tomorrow at 3 pm.']) assert.ok(blocked(s, d), d);
  assert.equal(smart.breaks('That did not work, so nothing is set up. Would you like to try again?', s), null, 'the honest sentence is spoken');
  assert.match(smart.fallback(s), /did not save, so nothing is set up/); assert.doesNotMatch(smart.fallback(s), /saved for|scheduled|all set/i);
});

test('2 false refusals are blocked while the card says Maya can schedule: family required, "I cannot schedule", app-only, no phone number', () => {
  const id = senior(), s = sess(id, ['social-ask']); care.attachSenior(id, { write() { return true; } }, TZ);   // a web-only senior, page open, no registered phone
  assert.equal(state.build(id).can.schedulable.dailyCall, true);
  for (const d of ["You'd need to ask your son to set that up for you.", "I can't schedule calls myself, but your daughter can set one up.", 'Calls only work in the Maya app, I am afraid.', 'Without a registered phone number I cannot ring you.', 'Your family has to arrange the daily call.', 'I need your phone number to call you every day.', "I'm unable to schedule a daily call for you."]) assert.ok(blocked(s, d), d);
  assert.equal(s._guardWhy, 'refusal');
  for (const d of ["I can only do one daily call at a time, so a second one isn't something I can set up.", 'Your family can see it on their page, but only you can cancel it.', 'A phone number is not needed while Maya is open on your computer.', 'What time would you like me to call you each day?']) assert.equal(blocked(s, d), null, d);
});

test('3 factual claims are checked against the record: a wrong time, a false "no calls", a false "never agreed", "still on" after cancelling, "cancelled" while active', () => {
  const id = senior(), s = sess(id, ['social-readback']); saveCall(id, s);
  assert.ok(blocked(s, 'Your daily call is saved for 5 pm.'), 'wrong time');
  assert.equal(blocked(s, 'Your daily call is saved for 3 pm, starting tomorrow.'), null, 'the right time');
  assert.ok(blocked(s, "You don't have any daily calls at the moment."), 'denies a saved call');
  assert.ok(blocked(s, 'Nothing is scheduled yet.'), 'denies a saved call 2');
  assert.ok(blocked(s, 'I have cancelled your daily call.'), 'says cancelled while active');
  assert.match(smart.fallback(s), /^Your daily call is saved for 3:00 pm America\/New_York\. You can ask me to skip one/);
  social.step(s, 'please cancel my daily calls', ctx(), NOW + 100);
  assert.ok(blocked(s, 'Your daily call will ring you tomorrow at 3 pm.'), 'still on after cancel');
  assert.ok(blocked(s, 'You never asked for a daily call.'), 'never agreed');
  assert.ok(blocked(s, "You never agreed to daily calls, so there isn't one."), 'never agreed 2');
  assert.equal(blocked(s, 'Your earlier daily call was cancelled, and I can set up a new one if you like.'), null, 'the true history');
  assert.equal(blocked(s, 'You have no daily call set up right now, though the earlier one was cancelled.'), null, 'a true denial after a cancel that also names the cancel');
});

test('4 an unreadable record: no denial, no success claim; the plain line says it cannot see them', () => {
  const id = senior(), s = sess(id, ['social-readback']); saveCall(id, s);
  const real = care.socialOf; care.socialOf = () => { throw new Error('gone'); };
  try {
    assert.ok(blocked(s, 'You have no daily calls set up.')); assert.ok(blocked(s, 'Your daily call is set for 3 pm.'));
    assert.ok(blocked(s, 'You have no daily calls set up.')); assert.match(smart.fallback(s), /can't see your saved calls right now/);
  } finally { care.socialOf = real; }
});

test('5 GUARD off: no state check (the older rules only)', () => {
  const id = senior(), s = sess(id); delete process.env.MAYA_SMART_STATE_GUARD;
  try { assert.equal(blocked(s, 'You would need to ask your son to set that up for you.'), null); } finally { process.env.MAYA_SMART_STATE_GUARD = 'on'; }
});
