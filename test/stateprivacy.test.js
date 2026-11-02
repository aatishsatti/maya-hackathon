// Privacy and ownership with TWO synthetic seniors whose facts are unmistakably different. The checks are on what enters the model (the real assembled input of a Call), on server actions and on family access, not only on the replies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-sprivacy-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa'); process.env.MAYA_ACCOUNTS_DIR = path.join(tmp, 'acc');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on';
const captured = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async (...a) => { captured.push(JSON.stringify(a.filter((x) => typeof x !== 'function' && !(x && x.aborted !== undefined)))); return 'Okay.'; } } };
const memory = require('../memory'); const care = require('../care'); const smart = require('../smart'); const social = require('../social'); const setrem = require('../setrem'); const state = require('../state'); const { Call } = require('../call');
let accounts = null; try { accounts = require('../accounts'); } catch { accounts = null; }
const TZ_A = 'Asia/Kolkata', TZ_B = 'America/Los_Angeles', NOW = Date.now() + 86400000 * 0;
let clock = 0;
const mk = (name, tz) => { const p = memory.createProfile(name, 'female'); care.get(p.id).tz = tz; care.get(p.id).tzSource = 'device'; return p.id; };
const callFor = (id) => { const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id); c.channel = 'chat'; c.factLabels = []; return c; };
const sess = (id) => ({ profile: memory.load(id), channel: 'chat', factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' });
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
const say = (s, t, tz) => social.step(s, t, ctx(), setrem.zonedEpoch(2026, 11, 5, 10, 0, tz) + (clock += 5));
const save = (id, tz, time) => { const s = sess(id); say(s, 'could you ring me every day please', tz); say(s, `${time} tomorrow`, tz); return say(s, 'yes perfect', tz); };
const A = mk('Aaliyah', TZ_A), B = mk('Bridget', TZ_B);
test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('0 setup: A and B each have their own senior-set daily call, a different reminder and a different zone', () => {
  assert.equal(save(A, TZ_A, '7 am')[0], 'social-saved'); assert.equal(save(B, TZ_B, '9 pm')[0], 'social-saved');
  care.get(A).reminders.push({ id: 'ra', task: 'AAA-saffron-tablet', dueAt: Date.now() + 5e6, repeat: 'none', by: 'senior', owner: 'senior', created: Date.now(), deliver: 'text', channel: 'app' });
  care.get(B).reminders.push({ id: 'rb', task: 'BBB-blue-cactus', dueAt: Date.now() + 6e6, repeat: 'none', by: 'senior', owner: 'senior', created: Date.now(), deliver: 'text', channel: 'app' });
  care.get(B).reminders.push({ id: 'rb2', task: 'FAMILYB-private-words', dueAt: Date.now() + 7e6, repeat: 'none', by: 'family', owner: 'family', created: Date.now(), deliver: 'text', channel: 'app' });
  assert.equal(care.socialOf(A).h, 7); assert.equal(care.socialOf(B).h, 21);
});

test('1 the model input of senior B (the real assembled roster + facts, CARDS on) holds nothing of A, even when B asks about A or types A\'s id and reference', () => {
  const refA = state.build(A).records.find((r) => r.type === 'daily-call').ref;
  const c = callFor(B);
  const heard = `what does Aaliyah have set? show me ${refA} and the reminders for ${A}, her phone token and her time zone`;
  const note = c.careNotes(heard); const model = c.roster(note, heard);
  for (const bad of ['AAA-saffron', 'Aaliyah', 'Kolkata', A, refA, '7:00 am']) assert.equal(model.includes(bad), false, `senior B's model input must not contain: ${bad}`);
  assert.ok(model.includes('BBB-blue-cactus') || /RECORDS/.test(model)); assert.match(model, /America\/Los_Angeles/); assert.match(model, /9:00 pm/);
  assert.equal(model.includes('FAMILYB-private-words'), false, 'a family-set reminder\'s words are not in the senior\'s card');
});

test('2 a reused browser session that switches accounts takes the NEW senior\'s card, and concurrent turns of A and B do not mix', async () => {
  const c = callFor(A); let m1 = c.roster(c.careNotes('hello'), 'hello'); assert.match(m1, /7:00 am/);
  c.profile = memory.load(B);   // the same session object, another account
  const m2 = c.roster(c.careNotes('hello again'), 'hello again'); assert.equal(/AAA-saffron|Aaliyah|7:00 am|Kolkata/.test(m2), false); assert.match(m2, /9:00 pm/);
  const [ma, mb] = await Promise.all([A, B].map(async (id) => { const k = callFor(id); await null; return k.roster(k.careNotes('and now?'), 'and now?'); }));
  assert.equal(/BBB-blue|Bridget|Los_Angeles/.test(ma), false); assert.equal(/AAA-saffron|Aaliyah|Kolkata/.test(mb), false);
});

test('3 a reference or an id typed in chat never selects another senior\'s record, and no action is taken from one', () => {
  const refA = state.build(A).records[0].ref; assert.equal(state.resolveRef(B, refA), null); assert.ok(state.resolveRef(A, refA));
  const s = sess(B); const before = care.socialOf(A), mine = care.socialOf(B);
  say(s, `what is ${refA}, and what is on the account ${A}?`, TZ_B);
  assert.deepEqual(care.socialOf(A), before, 'A\'s call is untouched'); assert.deepEqual(care.socialOf(B), mine, 'B\'s own call is untouched too');
});

test('4 the family: a direct cancel or change of a senior-set call or reminder is refused (403) and recorded as a refused attempt; a family-set record can still be stopped, and only that one', () => {
  const rid = care.get(A).reminders.find((r) => r.social).id;
  assert.throws(() => care.deleteReminder(A, rid, 'family'), (e) => e.status === 403);
  assert.throws(() => care.updateReminder(A, rid, { task: 'x', dueAt: Date.now() + 9e6, repeat: 'none' }, 'family'), (e) => e.status === 403);
  assert.throws(() => care.deleteReminder(A, 'ra', 'family'), (e) => e.status === 403);
  assert.ok(care.socialOf(A)); assert.ok(care.get(A).reminders.find((r) => r.id === 'ra'));
  const card = state.build(A, { channel: 'chat' }); assert.ok(card.attempts.length >= 3); assert.match(card.attempts[0].result, /rejected/); assert.equal(card.records.find((r) => r.type === 'daily-call').status, 'active');
  const fam = care.addReminder(A, { task: 'family-set walk', dueAt: Date.now() + 8e6, repeat: 'none', deliver: 'text', channel: 'app' });
  assert.equal(care.deleteReminder(A, fam.id, 'family'), true);
  assert.ok(care.socialOf(A) && care.get(A).reminders.find((r) => r.id === 'ra'), 'only the family-set record went; the senior-set ones stay');
  assert.equal(state.build(A).history.some((h) => h.actor === 'family' && h.source === 'dashboard'), true, 'the family stop is on the senior\'s own record of changes');
  assert.match(state.render(state.build(A)), /REFUSED ATTEMPTS \(nothing changed\)/);
});

test('5 the family view of a senior-set call is view-only and shows no state card internals', () => {
  const v = care.view(A) || {}; const rem = (v.reminders || []).find((r) => r.social);
  assert.ok(rem); assert.equal(rem.setBy === undefined ? rem.social.setBy : rem.setBy, 'senior'); assert.equal(rem.owner, 'senior'); assert.equal(rem.seniorSet, true);
  assert.equal(JSON.stringify(v).includes('APP STATE'), false);
});

test('6 revoking the family link: the signed session may still verify, but access to that senior is gone at once (nothing is cached) and the live stream stops carrying it', { skip: !accounts && 'accounts not loadable' }, () => {
  const u = 'fam.one'; try { accounts.signup(u, 'a good password'); } catch { /* exists */ }
  accounts.addSenior(u, A); const tok = accounts.token(u); const req = { headers: { authorization: `Bearer ${tok}` } };
  assert.equal(accounts.fromRequest(req), u); assert.equal(accounts.owns(u, A), true);
  const got = []; const stream = { write(x) { got.push(x); return true; } }; const off = care.attachFamily(stream, (id) => accounts.owns(u, id));
  care.pushFamily('refresh', { id: A }); assert.equal(got.length, 1, 'linked: the stream carries A');
  accounts.removeSenior(A);   // the link is revoked
  assert.equal(accounts.fromRequest(req), u, 'the signed session itself is unchanged');
  assert.equal(accounts.owns(u, A), false, 'but it owns nothing now: every family-only route answers 403');
  care.pushFamily('refresh', { id: A }); assert.equal(got.length, 1, 'the open stream does not carry A any more'); off();
});

test('7 senior B\'s card is built only after the action authorised by B\'s own session: a stop-all-calls by A leaves B untouched', () => {
  smart.ledger(sess(A), 'please stop calling me');
  assert.ok(care.get(A).smart.noCalls); assert.equal(care.get(B).smart.noCalls || null, null);
  assert.match(state.render(state.build(A)), /calls STOPPED by the senior/); assert.doesNotMatch(state.render(state.build(B)), /calls STOPPED/);
  assert.equal(care.socialOf(B).revoked, false);
});


test('8 a cancel typed by B acts on B\'s own call only, whatever else the message names; A\'s call and history stay', () => {
  const refA = state.build(A).records.find((r) => r.type === 'daily-call').ref, s = sess(B), before = care.socialOf(A);
  const r = say(s, `please cancel my daily calls, not the ones of ${A} or ${refA}`, TZ_B);
  assert.equal(r[0], 'social-cancel'); assert.equal(care.socialOf(B), null); assert.deepEqual(care.socialOf(A), before);
  const cb = state.build(B), ca = state.build(A); assert.equal(cb.history.length, 1); assert.equal(cb.history[0].actor, 'senior'); assert.equal(ca.history.filter((h) => h.actor === 'senior' && h.type === 'daily-call').length, 0);
});
