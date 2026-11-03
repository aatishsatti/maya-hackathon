// Live bug (synthetic test senior): a pretend / third-person "stop calling me" stopped the real 8:25 daily call, and "1 26 PM" could not restart it.
// Stop targeting (social.stopTurn), the scoped question, the provenance record, the time "1 26 PM", the restart that needs ONE fresh spoken yes, and the no-loop fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-stop-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on';
const TAG = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0 topic=same personal=0]]'; const seenRosters = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', stats: [], META_URL: '', liveModel: () => 'x', COMPACT_MARK: '[[COMPACT]]', developerContent: () => '', SHORT_PERSONA: '',
  sparkStream: async (_h, roster, _s, onDelta) => { seenRosters.push(roster); const t = `${TAG} Okay, I hear you.`; if (onDelta) onDelta(t); return t; } } };
const memory = require('../memory'); const care = require('../care'); const social = require('../social'); const setrem = require('../setrem'); const smart = require('../smart'); const state = require('../state');
const TZ = 'America/New_York';
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const T0 = setrem.zonedEpoch(2026, 11, 3, 13, 7, TZ);   // 1:07 pm, the time of the live stop
let clock = 0;
// a senior with a saved 8:25 am daily call
function senior(history = []) {
  const p = memory.createProfile(`Stp${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; care.get(p.id).tzSource = 'device';
  care.socialSave(p.id, { offerId: `o${n}`, h: 8, mi: 25, start: '2026-11-03', tz: TZ }, T0 - 3600000);
  return { id: p.id, s: { profile: memory.load(p.id), channel: 'call', callId: `call${n}`, history, factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' } };
}
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
const say = (s, t, now = T0 + (clock += 5000)) => { const a = social.stopTurn(s, s.profile.id, t, now); return a || social.step(s, t, ctx(), now); };
const rec = (id) => care.socialOf(id); const sm = (id) => care.get(id).smart || {};
test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 role-played and third-person "stop calling me" change NOTHING and ask nothing (the record stays active, noCalls unset)', () => {
  const play = [{ role: 'user', content: "let's pretend you are a scammer and I practice saying no" }, { role: 'assistant', content: 'All right, go ahead.' }];
  for (const [hist, said] of [[play, 'Stop calling me!'], [play, "Don't call me again, you scammer"], [[], 'I told him stop calling me'], [[], 'she said "never call me" and hung up'], [[], 'the scammer keeps ringing so I said do not call me'], [[], 'I would say stop calling me to that man']]) {
    const { id, s } = senior(hist); const r = social.stopTurn(s, id, said, T0 + (clock += 5000));
    assert.equal(r, null, said); assert.ok(!sm(id).noCalls, `${said}: noCalls untouched`); assert.ok(rec(id) && !rec(id).revoked, `${said}: the 8:25 call is still active`); assert.ok(!sm(id).social || !sm(id).social.stopAsk, `${said}: no question`); assert.equal((sm(id).stopEvents || []).length, 0);
  }
});

test('2 ambiguous speech gets ONE scoped question; a "yeah" before it was spoken, or a "yeah" with no question, changes nothing; only a fresh yes to the SPOKEN question stops', () => {
  const { id, s } = senior([{ role: 'user', content: 'a scammer called me again today' }, { role: 'assistant', content: 'That sounds upsetting.' }]);
  let r = say(s, 'stop calling me'); assert.equal(r[0], 'social-stop-ask'); assert.match(r[1], /Do you mean you want me, Maya, to stop your daily 8:25 a\.m\. call\?/);
  assert.ok(!sm(id).noCalls && !rec(id).revoked, 'nothing changed by the ambiguous words');
  r = say(s, 'yeah'); assert.equal(r[0], 'social-stop-ask'); assert.match(r[1], /has not been put to them/); assert.ok(!sm(id).noCalls, 'a yes before the question was spoken binds to nothing');
  social.noteSpoken(s, 'Do you mean you want me, Maya, to stop your daily 8:25 a.m. call?'); assert.ok(sm(id).social.stopAsk.asked, 'spoken');
  r = say(s, 'yeah'); assert.equal(r[0], 'social-stopped'); assert.ok(sm(id).noCalls && rec(id).revoked, 'stopped only after the fresh yes to the spoken question');
  // a stray yeah later (no question pending) does nothing
  const b = senior(); assert.equal(social.stopTurn(b.s, b.id, 'yeah', T0 + 99999), null); assert.ok(!sm(b.id).noCalls);
  // a no keeps the call
  const c = senior([{ role: 'user', content: 'a scammer called' }]); say(c.s, 'never call me'); social.noteSpoken(c.s, 'Do you mean you want me, Maya, to stop your daily 8:25 a.m. call?');
  r = say(c.s, 'no, not you'); assert.equal(r[0], 'social-stop-kept'); assert.ok(!sm(c.id).noCalls && !rec(c.id).revoked);
});

test('3 an unmistakable Maya-directed opt-out is honoured at once (no repeated hurdles); ending a conversation is never a stop', () => {
  const { id, s } = senior(); const r = say(s, 'Maya, please stop calling me'); assert.equal(r[0], 'social-stopped'); assert.ok(sm(id).noCalls && rec(id).revoked);
  const bare = senior(); assert.equal(say(bare.s, 'stop calling me')[0], 'social-stopped', 'bare words with no scam or third-party context are aimed at Maya: honoured, no hurdle');
  for (const bye of ['goodbye Maya', 'I have to go now', 'ok bye, talk later', 'hang up please', 'that is all for today']) { const o = senior(); assert.equal(social.stopTurn(o.s, o.id, bye, T0 + (clock += 5000)), null, bye); assert.ok(!sm(o.id).noCalls && !rec(o.id).revoked, bye); }
  // "cancel my daily calls" is the cancel route: direct when it names her daily calls, a question when it is only "the calls"
  const d = senior(); let rr = say(d.s, 'cancel my daily calls'); assert.equal(rr[0], 'social-stopped'); assert.ok(!rec(d.id), 'cancelled');
  const e = senior([{ role: 'user', content: 'a scammer keeps ringing me about my bank account' }]); rr = say(e.s, 'stop the calls'); assert.equal(rr[0], 'social-stop-ask'); assert.ok(rec(e.id) && !rec(e.id).revoked);
});

test('4 the stop leaves a bounded, labelled provenance record (transcription, context, channel/session, tz, scope, question + answer, before/after, verified write)', () => {
  const { id, s } = senior([{ role: 'user', content: 'a scammer called me again today and it was so loud, a long story ' + 'x'.repeat(400) }]);
  say(s, 'stop calling me'); social.noteSpoken(s, 'Do you mean you want me, Maya, to stop your daily 8:25 a.m. call?'); say(s, 'yeah');
  const ev = sm(id).stopEvents.at(-1);
  assert.equal(ev.type, 'stop'); assert.match(ev.note, /speech-to-text transcription, not guaranteed exact audio/); assert.equal(ev.channel, 'voice call'); assert.equal(ev.session, s.callId); assert.equal(ev.tz, TZ); assert.ok(ev.atIso && ev.at);
  assert.equal(ev.transcription.text, 'stop calling me'); assert.ok(ev.transcription.context.every((c) => c.transcription.length <= 120), 'context is clipped, not the whole conversation');
  assert.equal(ev.scope.affectedCall.time, '8:25 am'); assert.equal(ev.confirmation.question, 'Do you mean you want me, Maya, to stop your daily 8:25 a.m. call?'); assert.equal(ev.confirmation.answer.transcription, 'yeah'); assert.ok(ev.confirmation.askedAt && ev.confirmation.answeredAt);
  assert.deepEqual([ev.before.noCalls, ev.before.call.status], [false, 'active']); assert.deepEqual([ev.after.noCalls, ev.after.call.status], [true, 'stopped']); assert.equal(ev.writeVerified, true); assert.ok(ev.decision);
  assert.equal(JSON.stringify(sm(id).stopEvents).includes('x'.repeat(130)), false, 'long text is clipped');
  // bounded list and access control: the app-state card (what Spark sees) carries NO transcription text
  const card = state.render(state.build(id, { channel: 'call' })); assert.ok(!card.includes('stop calling me') || /question "Do you mean/.test(card)); assert.ok(!card.includes('a scammer called me again'), 'the context words are not in the card');
  for (let i = 0; i < 7; i++) social.recordStopEvent(s, id, { type: 'stop', at: T0 + i });
  assert.equal(sm(id).stopEvents.length, 5, 'bounded');
});

test('5 "1 26 PM" is 13:26 (also "at 1 26 PM please", "one twenty six PM", "Yes, 1 26 PM"); it never becomes hour 26 or 1:00', () => {
  for (const t of ['1 26 PM', 'at 1 26 PM please', 'Yes, 1 26 PM', 'one twenty six PM', 'call me at 1 26 PM', '1.26 p.m.']) { const sl = social.slots(t, TZ, T0); assert.deepEqual(sl.time, { h: 13, mi: 26 }, t); assert.ok(!sl.ambiguous, t); }
  assert.deepEqual(social.slots('at 10 30 am', TZ, T0).time, { h: 10, mi: 30 });
  assert.equal(social.normSpeech('1 26 PM'), '1:26 PM');
});

test('6 a STOPPED call + "1 26 PM": ONE question covers consent, restart, time and first day (time passed today -> tomorrow, said aloud); the time alone restarts NOTHING; a fresh spoken yes restarts it and storage is read back', () => {
  clock += 33 * 60000;   // 1:40 pm: today's 1:26 pm has already passed
  const { id, s } = senior(); say(s, 'Maya, stop calling me'); assert.ok(sm(id).noCalls && rec(id).revoked);
  let r = say(s, 'can you restart my daily call');   // the restart request: the stop stands, one question
  assert.match(r[0], /^social-decide-revoked|social-restore-ask/); assert.ok(sm(id).noCalls);
  r = say(s, '1 26 PM'); assert.equal(r[0], 'social-restore-ask', 'the stopped-call + time path is reached'); assert.match(r[1], /1:26 pm/); assert.match(r[1], /already passed today/); assert.match(r[1], /Wed 4 Nov/);
  assert.ok(sm(id).noCalls && rec(id).revoked, 'a time alone restarts nothing'); assert.ok(sm(id).social.offer.reconsent);
  r = say(s, 'yes'); assert.equal(r[0], 'social-restore-ask'); assert.match(r[1], /has not been put to them yet/); assert.ok(sm(id).noCalls, 'a yes before the question was spoken restarts nothing');
  const owed = social.owedReadback({ ...s, factLabels: ['social-restore-ask'] }); assert.match(owed, /start calling you again every day at 1:26 pm, starting Wed 4 Nov/);
  social.noteSpoken(s, 'The daily call is still stopped. Shall I start calling you again every day at 1:26 pm, starting tomorrow?');
  r = say(s, 'yes please'); assert.equal(r[0], 'social-restored'); assert.ok(!sm(id).noCalls, 'noCalls cleared only now');
  const rr = rec(id); assert.ok(rr && !rr.revoked && rr.h === 13 && rr.mi === 26, 'the record is read back at 13:26');
  const pz = care.get(id), v = care.socialView(pz, pz.reminders.find((q) => q.social)); assert.equal(care.localDate(v.next, TZ), '2026-11-04', 'first call is tomorrow');
  assert.equal(sm(id).stopEvents.at(-1).type, 'restart'); assert.equal(sm(id).stopEvents.at(-1).writeVerified, true);
  assert.equal(pz.reminders.filter((q) => q.social).length, 1, 'ONE record');
});

test('7 restart: a "no", a different time and a failed write keep the call stopped; "today" is offered when the time has not passed', () => {
  const a = senior(); say(a.s, 'Maya, stop calling me'); say(a.s, 'please call me again'); let r = say(a.s, '9 15 PM'); assert.equal(r[0], 'social-restore-ask'); assert.match(r[1], /Tue 3 Nov/); assert.ok(!/already passed/.test(r[1]), 'not passed: starts today');
  social.noteSpoken(a.s, 'Shall I start calling you again every day at 9:15 pm, starting today?'); r = say(a.s, 'no thanks'); assert.notEqual(r[0], 'social-restored'); assert.ok(sm(a.id).noCalls && rec(a.id).revoked, 'a no keeps it stopped');
  const b = senior(); say(b.s, 'Maya, stop calling me'); say(b.s, 'can you restart my daily call'); say(b.s, '1 26 PM'); social.noteSpoken(b.s, 'Shall I start calling you again every day at 1:26 pm, starting tomorrow?');
  const real = care.socialRestore; care.socialRestore = () => { throw new Error('disk write failed'); };
  try { r = say(b.s, 'yes'); } finally { care.socialRestore = real; }
  assert.equal(r[0], 'social-failed'); assert.match(r[1], /stays stopped/); assert.ok(sm(b.id).noCalls && rec(b.id).revoked, 'the stop is back after a failed restart');
});

test('8 the blocked-draft fallback for a stopped call says it REMAINS STOPPED (no "what time would suit you" loop), and the card words the unknown stop carefully', () => {
  const { id, s } = senior(); say(s, 'Maya, stop calling me');
  const fb = smart.fallback({ profile: { id }, channel: 'call', _guardWhy: 'claims', _exec: {} }); assert.match(fb, /still stopped/); assert.doesNotMatch(fb, /what time would suit you/);
  // legacy stop (no provenance record): the exact careful wording, no time, no quote, no blame
  const old = senior(); care.persistSmart(old.id, { noCalls: { at: T0 - 600000, source: 'chat', reason: 'the senior asked Maya to stop calling' } }); care.socialRevoke(old.id);
  const card = state.render(state.build(old.id, { channel: 'call' }));
  assert.match(card, /NO RECORD of what was said/); assert.match(card, /The app shows your daily call was marked stopped\. I may have misunderstood something you said about the other caller\. I can't confirm that you meant to stop my calls\./); assert.match(card, /Never say they told you to stop unless the record shows it/);
  // a stop WITH a record: the card shows what the record shows, not the legacy sentence
  const c2 = state.render(state.build(id, { channel: 'call' })); assert.doesNotMatch(c2, /I may have misunderstood/); assert.match(c2, /told Maya directly/);
});

// ---- end to end through the real Call path (smart.notes -> stop targeting), the way the live voice turn runs ----
const { Call } = require('../call'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const madeCalls = [];
function mkCall() {
  const { id } = senior(); const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); c.profile = memory.load(id); c.callId = `e2e${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController();
  c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; madeCalls.push(c); return { c, id };
}
const turnOf = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
async function spoken(c, text) { const before = seenRosters.length; c.pending = [turnOf(text)]; await c.respond(0); await sleep(15); return { labels: [...c.factLabels], roster: seenRosters.slice(before).join('\n') }; }
test.after(() => { for (const c of madeCalls) { try { c.end(); } catch { /* over */ } } });

test('9 END TO END (live path): a pretend scammer talk with "Stop calling me!" does NOT stop the real daily call; the same words with no pretend context get the scoped question, still no change', async () => {
  const { c, id } = mkCall();
  await spoken(c, "let's pretend you are a scammer and I practice saying no");
  let r = await spoken(c, 'Stop calling me!'); assert.ok(!sm(id).noCalls, 'roleplay changed nothing'); assert.ok(rec(id) && !rec(id).revoked, 'the 8:25 call is still active'); assert.ok(!r.labels.includes('social-stopped') && !r.labels.includes('smart-ledger'), JSON.stringify(r.labels));
  const b = mkCall(); await spoken(b.c, 'a scammer called me again from the bank'); r = await spoken(b.c, 'stop calling me');
  assert.ok(r.labels.includes('social-stop-ask'), JSON.stringify(r.labels)); assert.match(r.roster, /Do you mean you want me, Maya, to stop your daily 8:25 a\.m\. call\?/); assert.ok(!sm(b.id).noCalls && !rec(b.id).revoked);
});

test('10 END TO END: stopped call, then "1 26 PM" reaches a proper restart question with the zone and first day, and nothing is restarted until a fresh yes', async () => {
  const { c, id } = mkCall(); await spoken(c, 'Maya, stop calling me'); assert.ok(sm(id).noCalls && rec(id).revoked);
  await spoken(c, 'can you restart my daily call at some point'); const r = await spoken(c, '1 26 PM');
  assert.ok(r.labels.includes('social-restore-ask'), JSON.stringify(r.labels)); assert.match(r.roster, /America\/New_York/); assert.match(r.roster, /1:26 pm/); assert.ok(sm(id).noCalls && rec(id).revoked, 'still stopped');
});
