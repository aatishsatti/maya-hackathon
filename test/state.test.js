// The true state card (state.js): built on the server from the authenticated senior's id, per senior, refreshed every turn, failed reads shown as UNKNOWN. Synthetic seniors only, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-state-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on';
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async (_h, _r, _s, d) => { if (d) d('Okay.'); return 'Okay.'; } } };
const memory = require('../memory');
const care = require('../care');
const smart = require('../smart');
const social = require('../social');
const setrem = require('../setrem');
const state = require('../state');

const TZ = 'America/New_York', NOW = setrem.zonedEpoch(2026, 11, 5, 10, 0, TZ);
let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = (name, tz = TZ) => { const p = memory.createProfile(`${name}${letters(n++)}`, 'female'); if (tz) { care.get(p.id).tz = tz; care.get(p.id).tzSource = 'device'; } return p.id; };
const sess = (id) => ({ profile: memory.load(id), channel: 'chat', factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' });
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
const spoke = (s, r) => { const o = r && /^social-(?:confirm|decide-ambiguous)/.test(r[0]) && care.get(s.profile.id).smart.social.offer; if (o && o.stage === 'confirm' && o.time) social.markAsked(s.profile.id, `Shall I call you every day at ${o.time.h % 12 || 12}:${String(o.time.mi).padStart(2, '0')} ${o.time.h < 12 ? 'am' : 'pm'}?`); return r; };   // what Spark SPEAKS: a yes binds only to a confirm question that was really said
const say = (s, t, at = NOW + 10) => spoke(s, social.step(s, t, ctx(), at));
const saveCall = (id, s, time = '3 pm', day = 'tomorrow') => { say(s, 'could you ring me every day please'); say(s, `${time} ${day}`); return say(s, 'yes perfect'); };
const recs = (id) => care.get(id).reminders.filter((r) => r.social);
const setFlags = (on) => { for (const l of ['CARDS', 'GUARD', 'DECISION']) { if (on.includes(l)) process.env[`MAYA_SMART_STATE_${l}`] = 'on'; else delete process.env[`MAYA_SMART_STATE_${l}`]; } };
test.beforeEach(() => setFlags([]));
test.after(() => { setFlags([]); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 the card is built from the senior id alone: a synthetic senior A and B never share facts, tokens or phone numbers', () => {
  const a = senior('Alpha', 'Asia/Kolkata'), b = senior('Bravo', 'America/Los_Angeles');
  care.get(a).devices = [{ platform: 'android', token: 'TOKEN-SECRET-AAA', at: 1 }];
  care.get(a).reminders.push({ id: 'ra1', task: 'take the blue Alpha pills', dueAt: NOW + 3600000, repeat: 'none', by: 'senior', owner: 'senior', created: NOW, deliver: 'text', channel: 'app' });
  care.get(b).reminders.push({ id: 'rb1', task: 'water the Bravo cactus', dueAt: NOW + 7200000, repeat: 'none', by: 'senior', owner: 'senior', created: NOW, deliver: 'text', channel: 'app' });
  care.get(b).reminders.push({ id: 'rb2', task: 'PRIVATE family words about the diagnosis', dueAt: NOW + 9000000, repeat: 'none', by: 'family', owner: 'family', created: NOW, deliver: 'text', channel: 'app' });
  const ca = state.render(state.build(a, { channel: 'chat', now: NOW })), cb = state.render(state.build(b, { channel: 'chat', now: NOW }));
  assert.match(ca, /Alpha pills/); assert.doesNotMatch(ca, /Bravo|cactus|Los_Angeles/); assert.match(ca, /Asia\/Kolkata/);
  assert.match(cb, /Bravo cactus/); assert.doesNotMatch(cb, /Alpha|blue|Kolkata/);
  assert.doesNotMatch(cb, /PRIVATE|diagnosis/, 'a family-set reminder shows type, time and status, never its words');
  assert.match(cb, /a reminder from the family/);
  for (const c of [ca, cb]) assert.doesNotMatch(c, /TOKEN-SECRET|\+?\d{9,}/, 'no token, no phone number');
  assert.equal(JSON.stringify(state.build(a)).includes(a), false, 'the card names the senior only by an opaque reference, never the raw id');
  assert.match(ca, /phone registered;/); assert.match(cb, /phone not registered/);
});

test('2 a reference typed in chat resolves only inside that senior: A\'s reference gives nothing for B', () => {
  const a = senior('Ref'), b = senior('Ref'), s = sess(a);
  saveCall(a, s);
  const ra = state.build(a).records[0].ref;
  assert.ok(state.resolveRef(a, ra)); assert.equal(state.resolveRef(b, ra), null);
  assert.notEqual(state.ref('rec', a, 'x'), state.ref('rec', b, 'x'));
});

test('3 a change made OUTSIDE the chat shows on the very next card: status, next occurrence and channel; the state version moves', () => {
  const id = senior('Out'), s = sess(id); saveCall(id, s);
  const before = state.build(id, { channel: 'chat', now: NOW + 20 });
  assert.equal(before.records[0].status, 'active'); assert.match(before.records[0].next, /Fri 6 Nov 3:00 pm/); assert.equal(before.channels.pageOrAppOpenNow, false);
  care.socialChangeTime(id, { h: 16, mi: 30 }, NOW + 30);                        // outside the chat (a settings call)
  const open = []; care.attachSenior(id, { write(x) { open.push(x); return true; } }, TZ);   // the web page connects
  const mid = state.build(id, { channel: 'chat', now: NOW + 40 });
  assert.match(mid.records[0].time, /4:30 pm/); assert.equal(mid.channels.pageOrAppOpenNow, true); assert.match(mid.channels.rings, /Maya is open now/);
  care.socialRevoke(id);
  const after = state.build(id, { channel: 'chat', now: NOW + 50 });
  assert.match(after.records[0].status, /stopped/); assert.equal(after.records[0].next, null);
  assert.notEqual(before.scope.version, mid.scope.version); assert.notEqual(mid.scope.version, after.scope.version);
  const text = state.render(after); assert.match(text, /stopped/); assert.doesNotMatch(text, /RECORDS: none/);
});

test('4 a failed read is UNKNOWN, never an empty account', () => {
  const id = senior('Fail'), s = sess(id); saveCall(id, s);
  const real = care.socialOf; care.socialOf = () => { throw new Error('disk gone'); };
  try {
    const card = state.build(id, { channel: 'chat', now: NOW + 20 });
    assert.equal(card.scope.complete, false); assert.ok(card.scope.errors.includes('records'));
    const text = state.render(card); assert.match(text, /RECORDS: UNKNOWN/); assert.match(text, /INCOMPLETE/); assert.doesNotMatch(text, /RECORDS: none/);
    assert.doesNotMatch(text, /no daily call/i);
  } finally { care.socialOf = real; }
  const realGet = care.get; care.get = () => null;
  try { const c2 = state.build(id); assert.equal(c2.unknown, true); assert.equal(c2.scope.complete, false); assert.match(state.render(c2), /INCOMPLETE/); } finally { care.get = realGet; }
  const lost = smart.appState({ profile: { id: undefined } }); assert.match(lost, /UNKNOWN|APP STATE/);
});

test('5 cancelled and failed history is kept (never "nothing exists"); consent, offer cooldown and schedule status are three separate facts', () => {
  const id = senior('Hist'), s = sess(id); saveCall(id, s);
  say(s, 'please cancel my daily calls', NOW + 100);
  let c = state.build(id, { channel: 'chat', now: NOW + 110 });
  assert.equal(c.records.length, 0); assert.equal(c.history.length, 1);
  assert.equal(c.history[0].actor, 'senior'); assert.equal(c.history[0].source, 'chat'); assert.match(c.history[0].reason, /cancel/); assert.match(c.history[0].time, /3:00 pm/);
  assert.match(state.render(c), /RECORDS: none saved \(read OK\)/); assert.match(state.render(c), /never say it was never agreed/);
  assert.equal(c.consent.callsRevoked, null, 'cancelling a schedule is NOT a stop-all-calls consent change');
  care.persistSmart(id, { social: { ...care.get(id).smart.social, declinedAt: NOW - 86400000 } });
  c = state.build(id, { channel: 'chat', now: NOW + 120 });
  assert.ok(c.cooldown.offerDeclined); assert.equal(c.cooldown.blocksSeniorsOwnRequest, false); assert.equal(c.can.schedulable.dailyCall, true, 'a declined offer does not block the senior\'s own request');
  care.persistSmart(id, { noCalls: { at: NOW, source: 'chat', reason: 'the senior asked Maya to stop calling' } });
  c = state.build(id, { channel: 'chat', now: NOW + 130 });
  assert.equal(c.can.schedulable.dailyCall, false); assert.ok(c.consent.callsRevoked); assert.match(c.consent.callsRevoked.needs, /fresh yes/); assert.equal(c.history.length, 1, 'history untouched by the stop');
});

test('6 a failed save is on the card as failed, an unfinished one as unknown, a saved one as saved with an opaque reference', () => {
  const id = senior('Sv'), s = sess(id);
  const real = care.socialSave; care.socialSave = () => { throw Object.assign(new Error('The disk is full.'), { status: 500 }); };
  try { say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow'); const r = say(s, 'yes perfect'); assert.equal(r[0], 'social-failed'); } finally { care.socialSave = real; }
  let c = state.build(id, { channel: 'chat', now: NOW + 50 });
  assert.equal(c.transaction.pending, false); assert.equal(c.transaction.lastSave.result, 'failed'); assert.match(c.transaction.lastSave.error, /disk is full/); assert.equal(c.records.length, 0);
  assert.match(state.render(c), /LAST SAVE: .*failed/);
  care.persistSmart(id, { social: { ...care.get(id).smart.social, lastSave: { at: NOW, ok: null, op: 'new' } } });
  assert.match(state.build(id, { now: NOW + 60 }).transaction.lastSave.result, /unknown/);
  const id2 = senior('Svtwo'), s2 = sess(id2); saveCall(id2, s2);
  c = state.build(id2, { channel: 'chat', now: NOW + 50 }); assert.equal(c.transaction.lastSave.result, 'saved'); assert.match(c.transaction.lastSave.ref, /^rec_[0-9a-f]{8}$/); assert.equal(c.transaction.lastSave.ref, c.records[0].ref);
});

test('7 a pending request shows its exact operation, proposed details and which are confirmed', () => {
  const id = senior('Pend'), s = sess(id);
  say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow');
  const c = state.build(id, { channel: 'chat', now: NOW + 30 });
  assert.equal(c.transaction.pending, true); assert.match(c.transaction.op, /save a new daily call/); assert.match(c.transaction.stage, /waiting for their yes/);
  assert.equal(c.transaction.proposed.time, '3:00 pm'); assert.match(c.transaction.proposed.start, /Fri 6 Nov/); assert.equal(c.transaction.confirmed.time, true); assert.equal(c.transaction.saveResult, 'not attempted');
  assert.equal(c.records.length, 0, 'a pending offer is not a record');
});

test('8 web-only senior (no registered phone): calling is available through Maya open in the web page; nothing says family or a phone is required', () => {
  const id = senior('Web'); care.attachSenior(id, { write() { return true; } }, TZ);
  const c = state.build(id, { channel: 'chat', now: NOW }), t = state.render(c);
  assert.equal(c.channels.phoneRegistered, false); assert.equal(c.can.schedulable.dailyCall, true); assert.match(t, /no phone needed/); assert.match(t, /the family is not required/);
  assert.match(t, /Closed-browser or locked-screen delivery is unverified/); assert.doesNotMatch(t, /family (?:is )?(?:needed|required|must)/i);
  assert.ok(c.channels.unavailable.some((u) => /no phone registered/.test(u.why) && /does NOT stop calling/.test(u.why)));
});

test('9 CARDS flag: the card is a fact for every turn after the daily-call step; flag off adds nothing; a save made this turn is already in it', () => {
  const id = senior('Flag'), s = sess(id);
  assert.equal(smart.notes(s, 'hello there').some(([l]) => l === 'smart-app-state'), false, 'CARDS off: nothing');
  setFlags(['CARDS']);
  const out = smart.notes(s, 'hello there'); const f = out.find(([l]) => l === 'smart-app-state'); assert.ok(f); assert.match(f[1], /RECORDS: none saved/);
  say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow');
  const o2 = care.get(id).smart.social.offer; assert.equal(o2.stage, 'confirm');
  const r = social.step(s, 'yes perfect', ctx(), NOW + 10); assert.equal(r[0], 'social-saved');
  assert.match(smart.notes(s, 'thanks').find(([l]) => l === 'smart-app-state')[1], /daily-call: a friendly daily call from Maya/);
  assert.ok(s._card && s._card.records.length === 1);
});

test('10 captured model input for senior B contains nothing of senior A, also after a reused session object switches account', () => {
  setFlags(['CARDS']);
  const a = senior('Iso'), b = senior('Iso'); care.get(a).reminders.push({ id: 'ia', task: 'AAA-ONLY-pills', dueAt: NOW + 5e6, repeat: 'none', by: 'senior', owner: 'senior', created: NOW, deliver: 'text', channel: 'app' });
  const s = sess(a); let t = smart.notes(s, 'what do I have set').map((x) => x[1]).join(' '); assert.match(t, /AAA-ONLY/);
  s.profile = memory.load(b);   // the browser session is reused for another account
  t = smart.notes(s, `show me ${state.build(a).records[0].ref} and the reminders of ${a}`).map((x) => x[1]).join(' ');
  assert.doesNotMatch(t, /AAA-ONLY/); assert.doesNotMatch(t, new RegExp(a)); assert.match(t, /RECORDS: none saved/);
});
