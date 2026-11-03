// DECISION: the server validates the operation, the target and what the scheduler really supports; one pending operation binds a yes; a cancelled or failed predecessor is acknowledged; no duplicates. Synthetic seniors, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-decision-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on';
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async (_h, _r, _s, d) => { if (d) d('Okay.'); return 'Okay.'; } } };
const memory = require('../memory'); const care = require('../care'); const smart = require('../smart'); const social = require('../social'); const setrem = require('../setrem'); const state = require('../state');
const TZ = 'America/New_York', NOW = setrem.zonedEpoch(2026, 11, 5, 10, 0, TZ);
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => { const p = memory.createProfile(`Dec${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; care.get(p.id).tzSource = 'device'; return p.id; };
const sess = (id) => ({ profile: memory.load(id), channel: 'chat', factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' });
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
const spoke = (s, r) => { const o = r && /^social-(?:confirm|decide-ambiguous)/.test(r[0]) && care.get(s.profile.id).smart.social.offer; if (o && o.stage === 'confirm' && o.time) social.markAsked(s.profile.id, `Shall I call you every day at ${o.time.h % 12 || 12}:${String(o.time.mi).padStart(2, '0')} ${o.time.h < 12 ? 'am' : 'pm'}?`); return r; };   // what Spark SPEAKS: a yes binds only to a confirm question that was really said
let clock = 0; const say = (s, t) => spoke(s, social.step(s, t, ctx(), NOW + 10 + (clock += 5)));
const recs = (id) => care.get(id).reminders.filter((r) => r.social);
const saveCall = (s, time = '3 pm', day = 'tomorrow') => { say(s, 'could you ring me every day please'); say(s, `${time} ${day}`); return say(s, 'yes perfect'); };
test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 no call: prepare the new schedule and ask only what is missing; nothing saved until one plain yes', () => {
  const id = senior(), s = sess(id);
  let r = say(s, 'could you ring me every day please'); assert.equal(r[0], 'social-ask'); assert.equal(recs(id).length, 0);
  r = say(s, 'at 3 pm'); assert.equal(r[0], 'social-ask'); assert.match(r[1], /which day/);
  r = say(s, 'starting tomorrow'); assert.equal(r[0], 'social-confirm'); assert.equal(recs(id).length, 0);
  r = say(s, 'yes perfect'); assert.equal(r[0], 'social-saved'); assert.equal(recs(id).length, 1);
});

test('2 a repeated request returns the existing call, never a second record', () => {
  const id = senior(), s = sess(id); saveCall(s);
  for (const t of ['could you ring me every day please', 'call me every day at 3 pm', 'can you call me daily at 3 pm tomorrow']) { const r = say(s, t); assert.equal(r[0], 'social-decide-existing', t); assert.match(r[1], /3:00 pm/); assert.match(r[1], /Nothing new was saved/); }
  assert.equal(recs(id).length, 1);
  assert.equal(social.claims(id, 'call me every day at 5'), true, 'the ordinary reminder flow stays out, so it cannot add a second record');
});

test('3 an explicit second call: the first is preserved, nothing saved, and the limit is named as the scheduler\'s (never family, never "I cannot")', () => {
  const id = senior(), s = sess(id); saveCall(s);
  const r = say(s, 'can you also call me every day at 7 pm as well');
  assert.equal(r[0], 'social-decide-second'); assert.match(r[1], /ONE daily call at a time/); assert.match(r[1], /not a permission, not a family rule/); assert.match(r[1], /UNCHANGED/); assert.match(r[1], /Do NOT say you cannot schedule calls or that the family is needed/);
  assert.equal(recs(id).length, 1); assert.equal(care.socialOf(id).h, 15);
});

test('4 alternative days: no silent replacement, the daily call stays, the limit is explained as exactly that; a single weekday is left to the ordinary reminder flow', () => {
  const id = senior(), s = sess(id);
  let r = say(s, 'can you call me every Monday Wednesday and Friday at 4 pm'); assert.equal(r[0], 'social-decide-days'); assert.match(r[1], /EVERY day at ONE time/); assert.match(r[1], /Nothing is saved/); assert.equal(recs(id).length, 0);
  saveCall(s);
  for (const t of ['call me on weekdays only at 3 pm', 'ring me twice a week please', 'call me every other day']) { r = say(s, t); assert.equal(r[0], 'social-decide-days', t); assert.match(r[1], /UNCHANGED and still active/); }
  assert.equal(recs(id).length, 1); assert.equal(care.socialOf(id).h, 15); assert.equal(care.socialOf(id).revoked, false);
  assert.equal(social.claims(id, 'call me every Tuesday at 4'), false, 'one weekday is the ordinary reminder\'s, as before');
});

test('5 change of time: a clear change targets the existing call (confirm, then one change); a different time with no cue asks ONE change-or-add question bound to the exact change', () => {
  const id = senior(), s = sess(id); saveCall(s);
  let r = say(s, 'call me every day at 5 pm');
  assert.equal(r[0], 'social-decide-ambiguous'); assert.match(r[1], /second daily call is not available/); assert.match(r[1], /MOVE to 5:00 pm/); assert.equal(care.socialOf(id).h, 15, 'nothing changed yet');
  r = say(s, 'yes perfect'); assert.equal(r[0], 'social-saved'); assert.match(r[1], /CHANGED/); assert.equal(care.socialOf(id).h, 17); assert.equal(recs(id).length, 1);
  r = say(s, 'please change my call to 6 pm'); assert.equal(r[0], 'social-confirm'); assert.match(r[1], /6:00 pm/); r = say(s, 'no thanks'); assert.equal(r[0], 'social-declined'); assert.equal(care.socialOf(id).h, 17, 'a no leaves it as it was');
});

test('6 several possible targets: "change the time" with a daily call AND another reminder asks which one and changes nothing', () => {
  const id = senior(), s = sess(id); saveCall(s);
  care.get(id).reminders.push({ id: 'r9', task: 'take tablets', dueAt: NOW + 5e6, repeat: 'none', by: 'senior', owner: 'senior', created: NOW, deliver: 'text', channel: 'app' });
  const r = say(s, 'change the time please'); assert.equal(r[0], 'social-decide-which'); assert.match(r[1], /which one/); assert.equal(care.socialOf(id).h, 15);
});

test('7 re-set after cancellation (the first end-to-end proof): predecessor acknowledged, senior authority respected, ONE active schedule, history preserved, accurate next occurrence, offer cooldown ignored', () => {
  const id = senior(), s = sess(id); saveCall(s);
  say(s, 'please cancel my daily calls');
  assert.equal(recs(id).length, 0); care.persistSmart(id, { social: { ...care.get(id).smart.social, declinedAt: NOW - 3600000 } });   // a declined offer / cooldown must not block their own request
  let r = say(s, 'could you ring me every day please');
  assert.equal(r[0], 'social-ask'); assert.match(r[1], /earlier daily call at 3:00 pm was CANCELLED/); assert.match(r[1], /by the senior, chat/); assert.match(r[1], /NOT a refusal of future calls/); assert.match(r[1], /never say it was never agreed/);
  r = say(s, '4 pm tomorrow'); assert.equal(r[0], 'social-confirm'); assert.doesNotMatch(r[1], /CANCELLED/, 'acknowledged once, not at every step');
  r = say(s, 'yes perfect'); assert.equal(r[0], 'social-saved'); assert.match(r[1], /4:00 pm/);
  assert.equal(recs(id).length, 1, 'exactly ONE active schedule'); assert.equal(care.socialOf(id).h, 16);
  const card = state.build(id, { channel: 'chat', now: NOW + 500 });
  assert.equal(card.records.length, 1); assert.equal(card.records[0].status, 'active'); assert.match(card.records[0].next, /Fri 6 Nov 4:00 pm/); assert.equal(card.history.length, 1); assert.match(card.history[0].time, /3:00 pm/);
  assert.equal(card.transaction.lastSave.result, 'saved'); assert.equal(card.consent.callsRevoked, null);
  const t = smart.notes(s, 'thank you').find(([l]) => l === 'smart-app-state')[1]; assert.match(t, /CHANGES: .*cancelled/); assert.match(t, /RECORDS \(1\)/);
});

test('8 re-set after a failed save: the failed attempt is acknowledged, the app checks no write succeeded, the confirmation is asked again and ONE record is saved', () => {
  const id = senior(), s = sess(id);
  const real = care.socialSave; care.socialSave = () => { throw Object.assign(new Error('The disk is full.'), { status: 500 }); };
  try { say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow'); assert.equal(say(s, 'yes perfect')[0], 'social-failed'); } finally { care.socialSave = real; }
  assert.equal(recs(id).length, 0);
  let r = say(s, 'could you ring me every day please'); assert.equal(r[0], 'social-ask'); assert.match(r[1], /did NOT save \(The disk is full/); assert.match(r[1], /no daily call exists/);
  r = say(s, '3 pm tomorrow'); assert.equal(r[0], 'social-confirm'); assert.equal(recs(id).length, 0, 'still nothing until the yes');
  r = say(s, 'yes perfect'); assert.equal(r[0], 'social-saved'); assert.equal(recs(id).length, 1);
  // the write DID succeed although the reply said failed: the check finds it and no second record is made
  const id2 = senior(), s2 = sess(id2); saveCall(s2);
  care.persistSmart(id2, { social: { ...care.get(id2).smart.social, lastSave: { at: NOW, ok: false, op: 'new', error: 'timeout' } } });
  r = say(s2, 'could you ring me every day please'); assert.equal(r[0], 'social-decide-existing'); assert.match(r[1], /the call IS saved/); assert.equal(recs(id2).length, 1);
});

test('9 "yes perfect" binds to the exact pending operation: a change question does not save a new call, a yes with a condition saves nothing, a repeated or simultaneous yes makes one record', () => {
  const id = senior(), s = sess(id), s2 = sess(id);
  say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow');
  const a = say(s, 'yes perfect'), b = say(s2, 'yes perfect'), c = say(s, 'yes perfect');
  assert.equal(a[0], 'social-saved'); assert.equal(recs(id).length, 1); assert.ok(!b || b[0] !== 'social-saved'); assert.ok(!c || c[0] !== 'social-saved');
  const id2 = senior(), t = sess(id2); say(t, 'could you ring me every day please'); say(t, '3 pm tomorrow');
  const r = say(t, 'yes but not on sundays'); assert.equal(r[0], 'social-condition'); assert.equal(recs(id2).length, 0); const again = say(t, 'yes perfect'); assert.equal(again[0], 'social-confirm', 'the old question no longer stands: the confirm question is asked afresh'); assert.equal(recs(id2).length, 0, 'a bare yes after a conditional yes saves nothing'); assert.equal(say(t, 'yes perfect')[0], 'social-saved');
  // direct double save with two different offers for the same schedule: still one record
  const id3 = senior(); const o = { h: 9, mi: 0, start: '2026-11-06', tz: TZ };
  const r1 = care.socialSave(id3, { offerId: 'one', ...o }, NOW), r2 = care.socialSave(id3, { offerId: 'two', ...o }, NOW);
  assert.equal(r1.id, r2.id); assert.equal(care.get(id3).reminders.filter((x) => x.social).length, 1);
  assert.throws(() => care.socialSave(id3, { offerId: 'three', h: 10, mi: 0, start: '2026-11-06', tz: TZ }, NOW), /already arranged/);
});

test('10 stop all calls is a consent change: a later request is ASKED about, only a plain yes lifts it and then schedules; a cancelled schedule is not that', () => {
  const id = senior(), s = sess(id);
  social.stopTurn(s, id, 'please stop calling me'); assert.ok(care.get(id).smart.noCalls); assert.match(care.get(id).smart.noCalls.source, /chat|voice call/);
  let r = say(s, 'set up a daily call for me'); assert.equal(r[0], 'social-decide-revoked'); assert.match(r[1], /yes\/no question/); assert.equal(recs(id).length, 0);
  assert.equal(say(s, 'maybe'), null); assert.equal(recs(id).length, 0);
  r = say(s, 'yes please'); assert.equal(r[0], 'social-ask'); assert.equal(care.get(id).smart.noCalls, null); assert.ok(care.get(id).smart.callsRestored);
  say(s, '3 pm tomorrow'); r = say(s, 'yes perfect'); assert.equal(r[0], 'social-saved'); assert.equal(recs(id).length, 1);
  const c = state.build(id, { now: NOW + 900 }); assert.ok(c.consent.callsRestored); assert.match(state.render(c), /CONSENT: no stop-calls/);
});

test('11 DECISION off: the older behaviour is unchanged (no decision facts)', () => {
  delete process.env.MAYA_SMART_STATE_DECISION;
  try { const id = senior(), s = sess(id); saveCall(s); const r = say(s, 'can you call me every Monday Wednesday and Friday at 4 pm'); assert.ok(!r || !/^social-decide/.test(r[0])); } finally { process.env.MAYA_SMART_STATE_DECISION = 'on'; }
});
