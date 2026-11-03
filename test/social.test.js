// The companion call offer + daily timed call. No network: Spark and the push service are stubbed. Time is passed in (tick(now)) so nothing waits for the clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-social-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on';
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}',
  sparkStream: async (_h, _r, _s, onDelta) => { const t = 'Okay.'; if (onDelta) onDelta(t); return t; },
} };
const memory = require('../memory');
const care = require('../care');
const push = require('../push');
const smart = require('../smart');
const social = require('../social');
const setrem = require('../setrem');
const { Call } = require('../call');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const TZ = 'America/New_York';
// Wed 5 Nov 2026 10:00 in New York is the "now" of the conversation tests (a fixed clock, passed in).
const NOW = setrem.zonedEpoch(2026, 11, 5, 10, 0, TZ);
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = (tz = TZ) => { const p = memory.createProfile(`Social${letters(n++)}`, 'female'); if (tz) care.get(p.id).tz = tz; care.get(p.id).quietHours = true; return p.id; };   // quiet hours ON is now an explicit setting
const open = (id) => { const evs = []; care.attachSenior(id, { write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) evs.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } }, TZ); return evs; };
const sess = (id) => ({ profile: memory.load(id), factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' });
const ctx = (o = {}) => ({ intent: 'smalltalk', callsOk: true, safe: true, ...o });
const warm = (s, id, k = 4) => { let r = null; for (let i = 0; i < k; i++) { const q = social.step(s, 'it is a lovely day', ctx(), NOW + i); r = r || q; } return r; };
const say = (s, text, c = {}, at = NOW + 10) => social.step(s, text, ctx(c), at);
const p_ = (id) => care.get(id);
const recs = (id) => p_(id).reminders.filter((r) => r.social);
// A fake push service so rings can be pushed and the "end" messages seen.
const sent = []; push.deps.configured = () => true; push.deps.send = async (d, payload) => { sent.push(payload); return { ok: true }; };

test.after(() => { for (const c of calls) { try { c.end(); } catch { /* already over */ } } care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 the offer: only after a few warm turns, once, with a known time zone; never when stopped, declined (30 days), already arranged, at night or with no way to ring', () => {
  const id = senior(), s = sess(id);
  for (let i = 0; i < 3; i++) assert.equal(social.step(s, 'it is a lovely day', ctx(), NOW + i), null, `warm turn ${i + 1}: no offer yet`);
  const offer = social.step(s, 'the garden looks nice', ctx(), NOW + 4);
  assert.equal(offer[0], 'social-offer'); assert.match(offer[1], /ONE thing/); assert.match(offer[1], /do not say anything is arranged, scheduled or booked/); assert.match(offer[1], /Never invent/);
  assert.equal(social.step(s, 'yes the garden is lovely', ctx(), NOW + 5), null, 'a yes to something else is not an answer; nothing is asked twice');
  // gates around the offer
  const none = (setup) => { const i2 = senior(setup.tz === null ? null : TZ), s2 = sess(i2); setup.before && setup.before(i2); return warm(s2, i2, 5); };
  assert.equal(none({ tz: null }), null, 'no known time zone: never guessed, no offer');
  assert.equal(none({ before: (i) => care.persistSmart(i, { noCalls: { at: 1 } }) }), null, 'stop calling: no offer');
  assert.equal(none({ before: (i) => care.persistSmart(i, { social: { declinedAt: NOW - 29 * 86400000 } }) }), null, 'declined 29 days ago: no offer');
  assert.equal(none({ before: (i) => care.persistSmart(i, { social: { declinedAt: NOW - 31 * 86400000 } }) })[0], 'social-offer', 'declined 31 days ago: may offer');
  const i3 = senior(), s3 = sess(i3); care.persistSmart(i3, { social: { declinedAt: NOW - 86400000 } });
  assert.equal(social.step(s3, 'could you ring me every day please', ctx(), NOW)[0], 'social-ask', 'they ask themselves: a recent no does not apply');
  const i4 = senior(), s4 = sess(i4); assert.equal(social.step(sess(i4), 'x', ctx({ callsOk: false }), NOW), null); for (let i = 0; i < 5; i++) assert.equal(social.step(s4, 'nice', ctx({ callsOk: false }), NOW), null, 'no way to ring: no offer');
  const i5 = senior(), s5 = sess(i5); care.cfg.quietStart = 0; care.cfg.quietEnd = 24; assert.equal(warm(s5, i5, 6), null, 'night: no offer'); care.cfg.quietStart = 0; care.cfg.quietEnd = 0;
});

test('2 + 1 consent: "tomorrow afternoon" alone saves nothing; every missing piece is asked; only a plain yes to the confirm question saves; a quoted or unrelated yes is not permission', () => {
  const id = senior(), s = sess(id); warm(s, id);
  let r = say(s, 'tomorrow afternoon');
  assert.equal(r[0], 'social-ask'); assert.match(r[1], /not enough|clock time/); assert.equal(recs(id).length, 0, 'nothing saved');
  r = say(s, 'after lunch'); assert.equal(r[0], 'social-ask'); assert.match(r[1], /not a clock time|clock time/);
  r = say(s, 'at 3'); assert.equal(r[0], 'social-ask'); assert.match(r[1], /am or pm/);
  r = say(s, 'my daughter said yes to something'); assert.equal(r, null, 'an unrelated sentence with a yes in it: nothing');
  assert.equal(recs(id).length, 0);
  r = say(s, '3 pm tomorrow'); assert.equal(r[0], 'social-confirm'); assert.match(r[1], /EVERY DAY/); assert.match(r[1], /3:00 pm/); assert.match(r[1], /America\/New_York/); assert.match(r[1], /Fri 6 Nov/); assert.match(r[1], /Do not say it is scheduled/);
  assert.equal(recs(id).length, 0, 'still nothing saved: the question has only just been asked');
  assert.equal(say(s, '"yes" is what he said'), null, 'a quoted yes is not permission');
  assert.equal(recs(id).length, 0);
  r = say(s, 'yes');
  assert.equal(r[0], 'social-saved'); assert.match(r[1], /read from the saved record/); assert.match(r[1], /Your daily call is saved for 3:00 pm America\/New_York, starting Fri 6 Nov; you can tell me here anytime to skip one call, change the time, or cancel these daily calls\./);
  const [rec] = recs(id); assert.ok(rec); assert.equal(rec.repeat, 'daily'); assert.equal(rec.deliver, 'call'); assert.equal(rec.channel, 'app'); assert.equal(rec.by, 'senior');
  assert.deepEqual([rec.social.h, rec.social.mi, rec.social.tz, rec.social.start], [15, 0, TZ, '2026-11-06']);
  assert.equal(rec.dueAt, setrem.zonedEpoch(2026, 11, 6, 15, 0, TZ));
  assert.ok(rec.social.offerId, 'bound to one offer');
});

test('2 a yes with no question asked is nothing; the time can be corrected any number of times, each acknowledged; quiet hours are explained and the time is not moved', () => {
  const id = senior(), s = sess(id); warm(s, id);
  assert.equal(say(s, 'yes')[0], 'social-ask', 'a bare yes to the offer asks for the rest'); assert.equal(recs(id).length, 0);
  care.cfg.quietStart = 22; care.cfg.quietEnd = 7;
  let r = say(s, 'tomorrow at 11 pm'); assert.equal(r[0], 'social-quiet'); assert.match(r[1], /Do NOT move it/); assert.match(r[1], /22:00 to 07:00/); assert.equal(recs(id).length, 0);
  r = say(s, 'tomorrow at 4 pm'); assert.equal(r[0], 'social-confirm');
  r = say(s, 'no make it 5 pm'); assert.equal(r[0], 'social-confirm'); assert.match(r[1], /5:00 pm/); assert.match(r[1], /corrected the time/);
  r = say(s, 'sorry, 6 pm'); assert.equal(r[0], 'social-confirm'); assert.match(r[1], /6:00 pm/); assert.match(r[1], /no limit/);
  r = say(s, 'actually on sunday'); assert.equal(r[0], 'social-confirm'); assert.match(r[1], /Sun 8 Nov/);
  assert.equal(recs(id).length, 0); assert.equal(say(s, 'yes')[0], 'social-saved'); assert.equal(recs(id)[0].social.h, 18);
  care.cfg.quietStart = 0; care.cfg.quietEnd = 0;
});

test('2 a no is a no: declinedAt is recorded and nothing is offered again for 30 days', () => {
  const id = senior(), s = sess(id); warm(s, id);
  const r = say(s, 'no thank you'); assert.equal(r[0], 'social-declined'); assert.equal(recs(id).length, 0);
  assert.equal(care.get(id).smart.social.declinedAt, NOW + 10); assert.equal(care.get(id).smart.social.offer, null);
  const s2 = sess(id); assert.equal(warm(s2, id, 8), null, 'not re-offered');
});

test('3 a failed save: no "scheduled", the error is plain, no half-made schedule, and a retry cannot make two', () => {
  const id = senior(), s = sess(id); warm(s, id);
  say(s, 'tomorrow at 3 pm');
  const real = care.socialSave; care.socialSave = () => { throw Object.assign(new Error('The store is not available.'), { status: 500 }); };
  let r; try { r = say(s, 'yes'); } finally { care.socialSave = real; }
  assert.equal(r[0], 'social-failed'); assert.match(r[1], /NOT SAVED: The store is not available/); assert.match(r[1], /Do NOT say scheduled/);
  assert.equal(recs(id).length, 0, 'no schedule'); assert.equal(s._exec.socialFailed, true);
  s.factLabels = ['social-failed'];
  assert.equal(smart.breaks('Lovely, I have scheduled our daily call for three.', s), 'claim', 'a draft claiming it is scheduled is written again');
  assert.equal(smart.breaks('That did not work, so nothing is set up.', s), null);
  // the same offer saved twice is one record
  const a = care.socialSave(id, { offerId: 'o1', h: 15, mi: 0, start: '2026-11-06', tz: TZ }), b = care.socialSave(id, { offerId: 'o1', h: 15, mi: 0, start: '2026-11-06', tz: TZ });
  assert.equal(a.id, b.id); assert.equal(recs(id).length, 1);
  assert.throws(() => care.socialSave(id, { offerId: 'o2', h: 16, mi: 0, start: '2026-11-06', tz: TZ }), /already arranged/);
  assert.throws(() => care.socialSave(senior(), { offerId: 'o3', h: 12, mi: 0, start: '2026-11-06', tz: 'Europe/London' }), /time zone/);
});

test('3 a second offer while one is arranged (even one made long ago) is suppressed', () => {
  const id = senior(); care.socialSave(id, { offerId: 'old', h: 15, mi: 0, start: '2026-11-06', tz: TZ }); recs(id)[0].social.consentAt = NOW - 90 * 86400000;
  const s = sess(id); for (let i = 0; i < 8; i++) assert.equal(social.step(s, 'what a nice day', ctx(), NOW + i), null);
  assert.equal(recs(id).length, 1);
  const s2 = sess(id); assert.equal(social.step(s2, 'could you ring me every day', ctx(), NOW)[0], 'social-active', 'even when asked: no second offer, it already exists');
});

// ---- the scheduler ----
const arrange = (id, { h = 15, mi = 0, start = '2026-11-06', tz = TZ, now = Date.now() } = {}) => { care.socialSave(id, { offerId: `o${Math.random()}`, h, mi, start, tz }, now); return recs(id)[0]; };
const DUE = setrem.zonedEpoch(2026, 11, 6, 15, 0, TZ);

test('4 stop calling me reaches the scheduler: the saved chat and a queued ring stop, and it is re-checked at dispatch; restoring needs an explicit yes to its own question', async () => {
  const id = senior(), s = sess(id), page = open(id); const r = arrange(id); assert.equal(r.dueAt, DUE);
  // (a) said in the conversation
  const led = smart.ledger(s, 'please stop calling me'); assert.match(led, /CALLS REVOKED/);
  assert.ok(r.social.revoked); assert.equal(r.dueAt, null); care.tick(DUE + 1000); assert.equal(care.outreaches.size, 0, 'nothing rings');
  // (b) already queued: a ring in the making comes down
  const id2 = senior(); open(id2); const r2 = arrange(id2); care.tick(DUE + 1000); const o = [...care.outreaches.values()].find((x) => x.profileId === id2); assert.ok(o && o.social, 'queued');
  smart.ledger(sess(id2), 'do not call me'); assert.equal([...care.outreaches.values()].some((x) => x.profileId === id2), false, 'the queued ring is gone'); await sleep(30); assert.equal(sent.filter((x) => x.outreachId === o.id && x.type === 'incoming').length, 0);
  // (c) revoked in the permission only (not through the ledger): rechecked at dispatch and again at ringing
  const id3 = senior(); open(id3); const r3 = arrange(id3); care.persistSmart(id3, { noCalls: { at: 1 } }); care.tick(DUE + 1000); assert.equal([...care.outreaches.values()].some((x) => x.profileId === id3), false, 'dispatch rechecks'); assert.equal(r3.dueAt, null);
  const id4 = senior(); open(id4); const r4 = arrange(id4); care.tick(DUE + 1000); care.persistSmart(id4, { noCalls: { at: 1 } }); await sleep(30);
  assert.equal([...care.outreaches.values()].some((x) => x.profileId === id4), false, 'revoked between dispatch and ring: never rings'); assert.equal(r4.last.state, 'social_skipped'); assert.equal(r4.last.reason, 'stopped');
  // restore: a stray yes does not revive it
  const c1 = smart.ledger(s, 'you can call me again'); assert.match(c1, /NOT back on/); assert.match(c1, /ONE yes\/no question/); assert.ok(r.social.revoked, 'not revived by permission alone');
  assert.equal(social.step(sess(id), 'the weather is fine, yes yes', ctx(), Date.now() + 2), null); assert.ok(r.social.revoked, 'not revived by an unrelated yes');
  const restored = social.step(s, 'yes', ctx(), Date.now() + 5); assert.equal(restored[0], 'social-restored'); assert.equal(r.social.revoked, null); assert.ok(r.dueAt > Date.now());
  void page;
});

test('4 controls: skip today, change the time (asked and confirmed), cancel the daily calls', () => {
  const id = senior(), s = sess(id), r = arrange(id, { start: '2026-11-05', h: 15, now: NOW - 3600000 }); r.dueAt = setrem.zonedEpoch(2026, 11, 5, 15, 0, TZ);
  const NOWD = NOW;
  let x = social.step(s, 'please skip today', ctx(), NOWD); assert.equal(x[0], 'social-skip'); assert.match(x[1], /today's call is skipped/); assert.equal(r.social.skipDate, '2026-11-05');
  x = social.step(s, 'change the time of the call', ctx(), NOWD); assert.equal(x[0], 'social-ask'); assert.match(x[1], /CHANGE OF TIME/);
  x = social.step(s, 'make it 5 pm', ctx(), NOWD); assert.equal(x[0], 'social-confirm'); assert.match(x[1], /CHANGE OF TIME/); assert.equal(r.social.h, 15, 'not changed before the yes');
  x = social.step(s, 'yes', ctx(), NOWD); assert.equal(x[0], 'social-saved'); assert.match(x[1], /^CHANGED/); assert.equal(r.social.h, 17);
  x = social.step(s, 'cancel the daily calls', ctx(), NOWD); assert.equal(x[0], 'social-cancel'); assert.equal(recs(id).length, 0);
});

test('5 quiet hours at the moment of ringing: not rung, not moved, not held, not caught up; the next day is still on', () => {
  const id = senior(), r = arrange(id); open(id);
  care.cfg.quietStart = 22; care.cfg.quietEnd = 7;
  const lateNight = setrem.zonedEpoch(2026, 11, 6, 23, 0, TZ); r.dueAt = lateNight;   // (cannot be saved at 23:00, but a time zone can move under it)
  care.tick(lateNight + 1000);
  assert.equal(care.outreaches.size, 0, 'no ring'); assert.equal(r.last.state, 'social_skipped'); assert.equal(r.last.reason, 'quiet hours'); assert.ok(!r.held, 'not held for later');
  assert.equal(r.dueAt, setrem.zonedEpoch(2026, 11, 7, 15, 0, TZ), 'tomorrow, at the agreed time; not 07:00');
  assert.throws(() => care.socialSave(senior(), { offerId: 'q', h: 23, mi: 0, start: '2026-11-06', tz: TZ }), /quiet hours/);
  care.cfg.quietStart = 0; care.cfg.quietEnd = 0;
});

test('5 daylight saving and time zone changes: still 3 pm local on both sides of the clock change, one call a day, and a changed zone pauses it until they agree', () => {
  const id = senior(); open(id); const r = arrange(id, { start: '2027-11-06', now: setrem.zonedEpoch(2027, 11, 6, 9, 0, TZ) });
  assert.equal(r.dueAt, setrem.zonedEpoch(2027, 11, 6, 15, 0, TZ));
  care.tick(r.dueAt + 1000); const o1 = [...care.outreaches.values()].filter((x) => x.profileId === id); assert.equal(o1.length, 1, 'one call');
  const next = r.dueAt; assert.equal(next, setrem.zonedEpoch(2027, 11, 7, 15, 0, TZ), 'next day, 3 pm on the new clock'); assert.equal(next - setrem.zonedEpoch(2027, 11, 6, 15, 0, TZ), 25 * 3600000, 'a 25 hour day');
  care.tick(DUE - 5000); care.tick(DUE - 4000); assert.equal([...care.outreaches.values()].filter((x) => x.profileId === id).length, 1, 'no second call by ticking again');
  // the zone changes: no ring, no guessing, paused; the offer to confirm the new zone is asked once
  const id2 = senior(); open(id2); const r2 = arrange(id2); care.get(id2).tz = 'Europe/London'; care.tick(DUE + 1000);
  assert.equal([...care.outreaches.values()].some((x) => x.profileId === id2), false); assert.equal(r2.social.paused, 'timezone'); assert.equal(r2.dueAt, null);
  const s2 = sess(id2), q = social.step(s2, 'hello', ctx(), NOW); assert.equal(q[0], 'social-tz'); assert.match(q[1], /PAUSED/); assert.match(q[1], /Europe\/London/);
  const y = social.step(s2, 'yes', ctx(), NOW + 1); assert.equal(y[0], 'social-saved'); assert.equal(r2.social.tz, 'Europe/London'); assert.equal(r2.social.paused, null); assert.ok(r2.dueAt > Date.now());
});

test('6 a busy phone: already on a call = skipped, no catch-up, tomorrow stays', () => {
  const id = senior(); open(id); const r = arrange(id);
  care.callStarted(id, { deliverReminder: () => true, channel: 'call' }, TZ);
  care.tick(DUE + 1000);
  assert.equal([...care.outreaches.values()].some((x) => x.profileId === id), false); assert.equal(r.last.reason, 'busy'); assert.equal(r.dueAt, setrem.zonedEpoch(2026, 11, 7, 15, 0, TZ));
  care.tick(DUE + 60000); care.tick(DUE + 600000); assert.equal([...care.outreaches.values()].some((x) => x.profileId === id), false, 'nothing queued for after the call');
});

test('7 + 8 + 9 declined, hung up, unanswered: one ring, no same-day chase, no flag, no family, no retry, no WhatsApp, not a missed reminder; tomorrow stays on', async () => {
  Object.assign(care.cfg, { ringMs: 40, retryMinMs: 20, retryMaxMs: 40 });
  const whatsapp = []; care.setReminderSender({ channelFor: () => 'whatsapp', placeCall: async () => { whatsapp.push('call'); }, send: async () => { whatsapp.push('send'); }, callRoute: () => ({ permission: true, windowOpen: true }) });
  const base = () => { const id = senior(); open(id); care.get(id).familyCallConsent = true; care.get(id).mode = 'ultra'; const r = arrange(id); return { id, r }; };
  const rings = (id) => [...care.outreaches.values()].filter((x) => x.profileId === id);
  // unanswered
  let { id, r } = base(); const trends0 = JSON.stringify(care.get(id).days || []);
  care.tick(DUE + 1000); await sleep(15); assert.equal(rings(id).length, 1); assert.equal(rings(id)[0].attempts, 1);
  await sleep(120); assert.equal(rings(id).length, 0, 'the ring ended, once'); assert.equal(r.last.state, 'social_unanswered');
  await sleep(150); assert.equal(rings(id).length, 0, 'no second ring after the retry delay'); assert.equal(care.get(id).flags.length, 0, 'no flag'); assert.equal((care.get(id).escalations || []).length, 0, 'no family call');
  care.tick(DUE + 5 * 60000); care.tick(DUE + 30 * 60000); assert.equal(rings(id).length, 0, 'no 4-minute follow-up'); assert.deepEqual(whatsapp, [], 'no WhatsApp');
  assert.equal(JSON.stringify(care.get(id).days || []), trends0, 'not counted as a missed reminder'); assert.equal(r.dueAt, setrem.zonedEpoch(2026, 11, 7, 15, 0, TZ), 'tomorrow, because it is still authorised');
  assert.equal(care.view(id).notifications.filter((x) => x.noReply).length, 0);
  // declined
  ({ id, r } = base()); care.tick(DUE + 1000); await sleep(15); const o = rings(id)[0]; assert.ok(care.decline(id, o.id)); await sleep(150);
  assert.equal(r.last.state, 'declined'); assert.equal(rings(id).length, 0); assert.equal(care.get(id).flags.length, 0); assert.equal((care.get(id).escalations || []).length, 0); assert.ok(r.dueAt > DUE);
  // picked up, then hung up: nothing is owed and nothing is chased
  ({ id, r } = base()); care.tick(DUE + 1000); await sleep(15); const o2 = rings(id)[0]; const info = care.claim(id, o2.id); assert.equal(info.social, true); assert.equal(r.last.state, 'social_answered'); assert.equal(r.active, null);
  assert.ok(!care.reminderNoAck(id, r.id), 'nothing to acknowledge'); assert.equal(care.get(id).flags.length, 0); assert.deepEqual(whatsapp, []);
  // stopped after a decline: tomorrow does NOT happen
  ({ id, r } = base()); care.tick(DUE + 1000); await sleep(15); care.decline(id, rings(id)[0].id); smart.ledger(sess(id), 'stop calling me'); assert.equal(r.dueAt, null);
  Object.assign(care.cfg, { ringMs: 30000, retryMinMs: 60000, retryMaxMs: 120000 });
});

test('9 the lock screen says whose it is from the saved record, never a private fact; the ring text for the family\'s is different', () => {
  const id = senior(); open(id); const r = arrange(id);
  care.tick(DUE + 1000); const o = [...care.outreaches.values()].find((x) => x.profileId === id);
  assert.match(o.notif.text, /the chat you asked for/); assert.doesNotMatch(o.notif.text, /talk with Maya|garden|reminder/i);
  r.by = 'family'; care.outreaches.delete(o.id);
  const id2 = senior(); const r2 = arrange(id2); r2.by = 'family'; open(id2); care.tick(DUE + 1000);
  const o2 = [...care.outreaches.values()].find((x) => x.profileId === id2); assert.match(o2.notif.text, /arranged by your family/);
});

test('10 the pickup opening: written fresh each time, never the canned reminder line, never the same opening twice in a row, no invented facts', async () => {
  const id = senior(); const rem = arrange(id); const profile = memory.load(id);
  const mk = (said) => ({ profile, nameChance: 0, dynamicLine: async ({ check, pool }) => { const bad = check(said); return { said, full: said, bad, pool }; } });
  const canned = "It's time to talk to Maya. You just set it for yourself.";
  const a = await Call.prototype.socialLine.call(mk(canned), rem, undefined);
  assert.doesNotMatch(a.said, /time to talk to maya|you just set it/i, 'the canned line is refused'); care.addLine(id, 'social', a.said);
  const b = await Call.prototype.socialLine.call(mk(canned), rem, undefined);
  assert.notEqual(b.said, a.said, 'not the same fallback twice in a row'); care.addLine(id, 'social', b.said);
  const c = await Call.prototype.socialLine.call(mk("Hello Mary, I thought I would ring."), rem, undefined); assert.match(c.said, /thought I would ring|Hello|Hi|Good|What/);   // name left out by the check -> fallback
  const lonely = await Call.prototype.socialLine.call(mk('I called because you must be lonely.'), rem, undefined); assert.doesNotMatch(lonely.said, /lonely/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'); assert.match(src, /Never invent an interest, an event or the weather, never assume they are lonely/);
});

test('10 the ring is one bounded attempt and the phone\'s call screen comes down WITH it (the cut-off fix)', async () => {
  Object.assign(care.cfg, { ringMs: 40 });
  const id = senior(), r = arrange(id); care.registerDevice(id, { platform: 'android', token: 'tok_android_0123456789abcdef' });   // closed app: pushed
  sent.length = 0; care.tick(DUE + 1000); await sleep(15);
  const o = [...care.outreaches.values()].find((x) => x.profileId === id); assert.ok(o, 'rang'); assert.ok(sent.some((x) => x.type === 'incoming' && x.outreachId === o.id && x.ringMs === 40), 'the ring carries its length');
  await sleep(120);
  assert.ok(sent.some((x) => x.type === 'end' && x.outreachId === o.id), 'the end push is sent when the ring time is over'); assert.equal(r.last.state, 'social_unanswered');
  // an ordinary reminder ring also takes the phone screen down at each timeout (not only at the end of all its tries)
  const id2 = senior(); const rem = care.addReminder(id2, { task: 'Take pills', dueAt: Date.now() + 100, repeat: 'none', deliver: 'call', channel: 'app' }); care.registerDevice(id2, { platform: 'android', token: 'tok_android_abcdef0123456789' }); sent.length = 0;
  care.tick(Date.now() + 200); await sleep(15); const o2 = [...care.outreaches.values()].find((x) => x.profileId === id2); assert.ok(o2); await sleep(120);
  assert.ok(sent.some((x) => x.type === 'end' && x.outreachId === o2.id), 'a reminder ring: end push at the timeout'); void rem;
  for (const o3 of care.outreaches.values()) clearTimeout(o3.timer);
  Object.assign(care.cfg, { ringMs: 30000 });
  const dart = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'senior', 'senior_screen.dart'), 'utf8');
  assert.match(dart, /_ringEnd = Timer\(Duration\(milliseconds: \(\(e\.data\['ringMs'\] as num\?\)\?\.toInt\(\) \?\? 30000\) \+ 3000\), _dropIncoming\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'mayateam', 'maya_app', 'NativeCalls.kt'), 'utf8'), /setTimeoutAfter\(ringMs\)/);
});

// ================= the five live defects (Mathew, 3 Nov, 2:35 am) =================
const calls = [];
const fakeWs = () => { const rec = { sent: [], closed: [] }; return { rec, ws: { send: (d) => rec.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: (c) => rec.closed.push(c), onmessage: null, onclose: null } }; };

test('D1 "You can hang up now" ENDS the call on a web or app voice call even with the style / calls / daily-chat facts in play; with a real fact (safety, a scam question, an open reminder question) it still goes to Spark', async () => {
  const id = senior(); const said = [];
  const run = async (labels, text) => {
    const { ws } = fakeWs(); const call = new Call(ws, 'k'); clearInterval(call.endTimer); calls.push(call); call.profile = memory.load(id);
    call.sayFixed = async (t, o) => { said.push([t, o.bye]); }; call.hangUp = () => { said.push(['HANGUP', true]); }; call.careNotes = function () { this.factLabels = labels.slice(); return ''; };   // the facts this turn gave Spark (names only)
    call.pending = [{ text, partial: '', completedAt: Date.now(), endedAt: Date.now() }];
    call.attribute = (t) => [{ label: 'A', text: t.text }]; call.respond = Call.prototype.respond;
    try { await Promise.race([call.respond(0), sleep(300)]); } catch { /* the rest of respond needs a live Spark: only the decision to end matters here */ }
  };
  for (const t of ['You can hang up now.', 'You can hang up.', 'Please hang up', 'Okay, goodbye then']) await run(['smart-style', 'smart-calls', 'smart-thread', 'smart-shape', 'social-active', 'smart-ledger'], t);
  assert.deepEqual(said, [["Okay, goodbye. Take care.", true], ["Okay, goodbye. Take care.", true], ['HANGUP', true], ["Okay, goodbye. Take care.", true]], 'a goodbye: the close and the hang-up; "please hang up": the hang-up at once');
  said.length = 0; await run(['smart-style'], "You're still here."); await run(['smart-style'], "Please don't hang up"); assert.deepEqual(said, [], 'not a goodbye: carries on');
  said.length = 0; await run(['setrem-confirm'], 'You can hang up now.'); await run(['scam-warn'], 'You can hang up now.'); assert.equal(said.length, 2, 'an open question or a scam topic alone is no reason to keep them on the line');
});

test('D2 a call that begins while the chat is due, queued or ringing: the chat is skipped, closed cleanly, never rung twice, never caught up; a start message alone already counts as busy', async () => {
  // (a) the call's start message arrived but it is not registered yet
  const a = senior(); open(a); const ra = arrange(a); care.callStarting(a, DUE); care.tick(DUE + 1000);
  assert.equal([...care.outreaches.values()].some((x) => x.profileId === a), false, 'busy at due'); assert.equal(ra.last.reason, 'busy'); assert.equal(ra.dueAt, setrem.zonedEpoch(2026, 11, 7, 15, 0, TZ), 'tomorrow stays, today is not caught up');
  // (b) the ring is queued, then a call starts before it rings
  const b = senior(); open(b); const rb = arrange(b); care.tick(DUE + 1000); const ob = [...care.outreaches.values()].find((x) => x.profileId === b); assert.ok(ob && ob.social, 'queued');
  sent.length = 0; care.callStarted(b, { deliverReminder: () => true, ws: {} }, TZ); await sleep(30);
  assert.equal([...care.outreaches.values()].some((x) => x.profileId === b), false, 'the queued chat is closed'); assert.equal(rb.active, null, 'the record is not left half open (it used to stay "calling" and block every later day)');
  assert.equal(rb.last.state, 'social_skipped'); assert.equal(rb.last.reason, 'busy'); assert.equal(sent.filter((x) => x.outreachId === ob.id && x.type === 'incoming').length, 0, 'no ring went out');
  care.callEnded(b, { }, 'normal');
  // (c) a call is going at the moment of ringing (registered between dispatch and ring)
  const c = senior(); open(c); const rc = arrange(c); care.tick(DUE + 1000); const oc = [...care.outreaches.values()].find((x) => x.profileId === c); assert.ok(oc);
  const live = { deliverReminder: () => true, ws: {} }; care.liveCallsForTest ? care.liveCallsForTest.set(c, live) : null;
  care.callStarting(c, Date.now()); await sleep(30); assert.equal([...care.outreaches.values()].some((x) => x.profileId === c), false, 'rechecked at ringing: skipped'); assert.equal(rc.last.reason, 'busy');
  // (d) tomorrow only while authorised
  assert.ok(rc.dueAt > DUE);
});

test('D3 the call screen is not taken down when the app opens on the ring: no dismiss on `incoming`; it goes down with answer, decline, the server\'s end or its own ring time', () => {
  const dart = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'senior', 'senior_screen.dart'), 'utf8');
  const incoming = dart.slice(dart.indexOf("case 'incoming':"), dart.indexOf("case 'incomingEnd':"));
  assert.doesNotMatch(incoming, /NativeCall\.instance\.dismiss/, 'the cause of the ~2 second vanish: the open-up of the app cancelled the very notification that launched it');
  const drop = dart.slice(dart.indexOf('void _dropIncoming()'), dart.indexOf('Future<void> _acceptIncoming()'));
  assert.match(drop, /NativeCall\.instance\.dismiss\('\$oid'\)/, 'answer, decline, end and timeout all pass through here');
  assert.match(dart, /_ringEnd = Timer\(/); assert.match(dart, /case 'incomingEnd':[\s\S]*_dropIncoming\(\)/);
  const kt = fs.readFileSync(path.join(__dirname, '..', 'app', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'mayateam', 'maya_app', 'NativeCalls.kt'), 'utf8');
  assert.match(kt, /"end" -> NativeCalls\.cancel\(this, oid\)/); assert.match(kt, /setTimeoutAfter\(ringMs\)/);
});

test('D4 the pickup opening: authorship from the saved record, never family wording for a senior-set chat, never the welfare question, fresh and varied', async () => {
  const id = senior(); const rem = arrange(id); const profile = memory.load(id); assert.equal(rem.by, 'senior');
  let seenWhat = '';
  const mk = (said, r = rem) => ({ profile, nameChance: 0, dynamicLine: async ({ check, what }) => { seenWhat = what; return { said, full: said, bad: check(said) }; } });
  const live = "Hello I was thinking about you and your family asked me to check in. Are you okay right now?";
  const a = await Call.prototype.socialLine.call(mk(live), rem, undefined);
  assert.doesNotMatch(a.said, /family|asked me|thinking about you|are you okay/i, 'the live line is refused'); assert.match(seenWhat, /THEY asked for this daily chat themselves/); assert.match(seenWhat, /Their family did not ask you to call/); assert.match(seenWhat, /never ask whether they are okay/);
  for (const bad of ['Hello, are you okay?', 'Hi, I am just checking in on you.', "Your daughter asked me to ring.", 'Hello, I was thinking of you.', "It's time to talk to Maya."]) { const x = await Call.prototype.socialLine.call(mk(bad), rem, undefined); assert.equal(x.said === bad, false, bad); }
  const good = 'Hi there! What have you been up to today?'; const g = await Call.prototype.socialLine.call(mk(good), rem, undefined); assert.equal(g.said, good, 'a fresh friendly opening passes'); care.addLine(id, 'social', good);
  const again = await Call.prototype.socialLine.call(mk('Hi there! How is the afternoon going?'), rem, undefined); assert.notEqual(again.said, good);
  const same = await Call.prototype.socialLine.call(mk('Hi there! Everything fine at home?'), rem, undefined); assert.notEqual(same.said, 'Hi there! Everything fine at home?', 'the same opening as the last call is refused');
  const fam = { ...rem, by: 'family' }; await Call.prototype.socialLine.call(mk(good), fam, undefined); assert.match(seenWhat, /Their family arranged this daily chat/); assert.doesNotMatch(seenWhat, /THEY asked/);
  // the lock screen reads the saved record too
  open(id); care.tick(DUE + 1000); const o = [...care.outreaches.values()].find((x) => x.profileId === id); assert.match(o.notif.text, /the chat you asked for/); assert.doesNotMatch(o.notif.text, /family/i);
});

test('D5 natural yes answers to THAT confirm question save ("yes", "yes please", "yes perfect", "yes that sounds good", "sure", "perfect"); quoted, unrelated or conditional ones do not; before the question is asked nothing saves; the saved fact asks for time + start + controls in one sentence', () => {
  for (const yes of ['yes', 'Yes please', 'yes perfect', 'Yes, that sounds good', 'sure', 'perfect', 'okay that works', 'yes thank you Maya']) {
    const id = senior(), s = sess(id); warm(s, id); say(s, 'tomorrow at 3 pm');
    const r = say(s, yes); assert.equal(r[0], 'social-saved', yes); assert.equal(recs(id).length, 1, yes);
    assert.match(r[1], /ONE short sentence/); assert.match(r[1], /skip one call, change the time, or cancel these daily calls/);
  }
  for (const no of ['"yes"', 'my daughter said yes', 'yes but not on fridays', 'yes?', 'no', 'yes I like the garden too']) {
    const id = senior(), s = sess(id); warm(s, id); say(s, 'tomorrow at 3 pm'); say(s, no); assert.equal(recs(id).length, 0, no);
  }
  const id = senior(), s = sess(id); warm(s, id); assert.notEqual(say(s, 'yes perfect')[0], 'social-saved', 'a yes before the confirm question was asked is nothing'); assert.equal(recs(id).length, 0);
});
