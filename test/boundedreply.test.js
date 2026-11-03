// B1-B3: bounded scheduling language. Context is code-owned (a topic switch is not a change), negation never selects the negated time, a question is answered from storage, stopped and stale states are
// handled in code, a failed or uncertain write after a yes is reported (never a restarted confirmation), and a scheduling reply may only MEAN what the verified state allows. Synthetic, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-bounded-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on';
const TAG = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const asked = []; let script = () => `${TAG} Okay.`;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => '',
  sparkStream: async (history, roster, _s, onDelta) => { if (/has been silent for a little while/.test(roster)) { const t = `${TAG} Are you still there?`; if (onDelta) onDelta(t); return t; } asked.push({ roster }); const t = script(roster, history); if (onDelta) onDelta(t); return t; } } };
const memory = require('../memory'); const care = require('../care'); const setrem = require('../setrem'); const social = require('../social'); const smart = require('../smart'); const state = require('../state'); const chat = require('../chat'); const { Call } = require('../call');
care.cfg.quietStart = 0; care.cfg.quietEnd = 0;
const TZ = 'America/New_York', NOW = setrem.zonedEpoch(2026, 11, 5, 4, 0, TZ);
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];
function senior() { const p = memory.createProfile(`Bnd${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; care.get(p.id).tzSource = 'device'; care.attachSenior(p.id, { write() { return true; } }, TZ); return p.id; }
const sess = (id) => ({ profile: memory.load(id), channel: 'chat', factLabels: [], _exec: {}, lastHeard: () => '' });
const ctx = { intent: 'smalltalk', callsOk: true, safe: true };
let clock = 0; const say = (s, t) => { const r = social.step(s, t, ctx, NOW + (clock += 5)); const o = r && /^social-(?:confirm|decide-ambiguous)/.test(r[0]) && care.get(s.profile.id).smart.social.offer; if (o && o.stage === 'confirm' && o.time) social.markAsked(s.profile.id, `Shall I call you every day at ${o.time.h % 12 || 12}:${String(o.time.mi).padStart(2, '0')} ${o.time.h < 12 ? 'am' : 'pm'}?`); return r; };
const call635 = () => { const id = senior(), s = sess(id); say(s, 'call me every morning'); say(s, 'at 6:35 am starting tomorrow'); assert.equal(say(s, 'yes please')[0], 'social-saved'); return { id, s }; };
const rec = (id) => { const o = care.socialOf(id); return o && `${o.h}:${String(o.mi).padStart(2, '0')}`; };
const offer = (id) => care.get(id).smart.social.offer;
const recs = (id) => care.get(id).reminders.filter((r) => r.social);
function mkCall(id) { const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); c.profile = memory.load(id); c.callId = `c${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController(); c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; made.push(c); return c; }
const turn = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
const saidBy = (c) => c.history.filter((m) => m.role === 'assistant').map((m) => m.content.replace(/\[\[[^\]]*\]\]/g, '').trim());
async function vsay(c, text) { const before = asked.length; c.pending = [turn(text)]; await c.respond(0); await sleep(10); return { labels: [...c.factLabels], rosters: asked.slice(before) }; }
test.after(() => { for (const c of made) { try { c.end(); } catch { /* over */ } } care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

const checker = (id, text, { heard = '', labels = [], exec = {} } = {}) => state.checkScheduling(text, state.build(id, { channel: 'chat' }), { heard, labels, exec });

test('B1a a future-tense statement about the EXISTING record is a readback: it passes against storage, with no new write; a different time does not', () => {
  const { id } = call635();
  assert.equal(checker(id, 'Your next call will be at 6:35 am.', { labels: ['social-readback'] }), null);
  assert.equal(checker(id, "It's still 6:35 am every morning.", { heard: 'what time is my call' }), null);
  assert.equal(checker(id, 'Your next call will be at 6:35.', {}), null, 'no am/pm said: still the saved time');
  assert.ok(checker(id, 'Your next call will be at 6:57 am.', { labels: ['social-readback'] }), 'a time that is not in storage is blocked');
  assert.ok(checker(id, "Sure, I'll move it to 6:35 am.", {}), 'a promise of a NEW change needs a verified write even at the same time words');
});

test('B1b truthful proposals, readbacks, same-time and failure sentences all pass; promises and completions do not without a verified write', () => {
  const { id, s } = call635(); say(s, 'change my call to 6:57 am'); assert.deepEqual([offer(id).time.h, offer(id).time.mi], [6, 57]);
  const heard = 'change my call to 6:57 am';
  for (const ok of ['Shall I move your daily call to 6:57 am?', 'So that would be 6:57 am every morning.', "It's still 6:35 am for now.", "It's already set for that time."]) assert.equal(checker(id, ok, { heard, labels: ['social-confirm'] }), null, ok);
  for (const bad of ["Sure, I'll move it to 6:57 am.", 'That works, 6:57 every morning from here on.', 'Perfect, that daily call will be at 6:57 am.', 'All sorted!', 'Leave it with me.', "I'll take care of it."]) assert.ok(checker(id, bad, { heard: 'yes please', labels: ['social-confirm'] }), bad);
  const failed = { socialFailed: true };
  care.persistSmart(id, { social: { ...care.get(id).smart.social, offer: null, lastSave: { at: NOW, ok: false, op: 'change', h: 6, mi: 57, error: 'disk' } } });
  assert.equal(checker(id, "I couldn't change it to 6:57 am, your call is still at 6:35 am.", { heard: 'yes please', exec: failed, labels: ['social-failed'] }), null);
  for (const bad of ['Sounds good, all set for 6:57 am.', 'Perfect!', 'Done, 6:57 am it is.', 'Great, have a lovely day, I will take care of it.']) assert.ok(checker(id, bad, { heard: 'yes please', exec: failed, labels: ['social-failed'] }), bad);
});

test('B1c after a valid yes a FAILED write is reported as failed and an UNCERTAIN one as uncertain, in the voice path, and neither restarts the confirmation', async (t) => {
  for (const kind of ['failed', 'uncertain']) {
    const id = senior(); { const s = sess(id); say(s, 'call me every morning'); say(s, 'at 6:35 am starting tomorrow'); say(s, 'yes please'); }
    const c = mkCall(id); const real = care.socialChangeTime, realOf = care.socialOf;
    script = (roster) => (/CHANGE OF TIME/.test(roster) || /NOT SAVED|NOT VERIFIED/.test(roster) ? `${TAG} Sounds good, I'll move it to 6:57 each morning, all sorted.` : `${TAG} Okay.`);
    await vsay(c, 'Can you change my daily call to 6:57 am');
    assert.match(saidBy(c).at(-1), /Just to check: shall I move your daily call to 6:57 am\?/, 'one exact read-back');
    if (kind === 'failed') care.socialChangeTime = () => { throw Object.assign(new Error('The disk is full.'), { status: 500 }); };
    else care.socialChangeTime = (...a) => { const r = real(...a); care.socialOf = () => { care.socialOf = realOf; throw new Error('read failed'); }; return r; };   // the write goes through, the read-back cannot be read
    let yes; try { yes = await vsay(c, 'Yes, please'); } finally { care.socialChangeTime = real; care.socialOf = realOf; }
    const line = saidBy(c).at(-1);
    if (kind === 'failed') { assert.ok(yes.labels.includes('social-failed')); assert.match(line, /did not save/i); assert.match(line, /6:35 am/); assert.equal(rec(id), '6:35'); }
    else { assert.ok(yes.labels.includes('social-uncertain')); assert.match(line, /couldn't confirm/i); assert.doesNotMatch(line, /nothing changed|\bdone\b|all set|(?:it|that|call) (?:is|was|has been) saved|is now/i, 'never "nothing changed", never done'); }
    assert.doesNotMatch(saidBy(c).slice(2).join(' | '), /all sorted|I'll move it|each morning/i, 'the warm promise never reached the voice');
    assert.equal(care.get(id).smart.social.offer || null, null, 'the offer is consumed');
    const again = await vsay(c, 'Yes, please'); assert.ok(!again.labels.includes('social-confirm'), `${kind}: no confirmation loop after the outcome`);
    assert.equal(recs(id).length, 1);
  }
});

test('B2a a topic switch is NOT daily-call context: "make it 6:57" / "do it at 6:57am" after unrelated turns changes nothing; right after a call turn it does start ONE change', () => {
  const { id, s } = call635();
  for (const t of ['the garden looks lovely', 'my grandson visited today', 'it is a sunny day']) say(s, t);
  for (const t of ['make it 6:57am', 'do it at 6:57am every morning', '6:57am']) { const r = say(s, t); assert.equal(r, null, t); assert.equal(offer(id) || null, null, t); assert.equal(rec(id), '6:35', t); }
  const fresh = sess(id); for (const t of ['do it at 6:57am', 'make it 6:57']) { assert.equal(say(fresh, t), null, `a new session has no daily-call context: ${t}`); }
  const { id: id2, s: s2 } = call635(); say(s2, 'what daily calls do I have?');   // a call turn: context is valid now
  const r = say(s2, 'wait actually do it at 6:57am every morning starting today'); assert.equal(r[0], 'social-confirm'); assert.deepEqual([offer(id2).time.h, offer(id2).time.mi], [6, 57]); assert.equal(rec(id2), '6:35', 'a proposal changes nothing'); assert.equal(recs(id2).length, 1);
});

test('B2b negation: "not 6:57" alone selects nothing; negation + an alternative is a correction to the alternative; a negated pending time is withdrawn', () => {
  const { id, s } = call635(); say(s, 'what daily calls do I have?');
  assert.equal(say(s, 'not 6:57'), null); assert.equal(offer(id) || null, null); assert.equal(rec(id), '6:35');
  say(s, 'what time is my call?'); say(s, 'change my call to 6:56 am'); assert.deepEqual([offer(id).time.h, offer(id).time.mi], [6, 56]);
  let r = say(s, 'not 6:57'); assert.equal(r[0], 'social-confirm'); assert.deepEqual([offer(id).time.h, offer(id).time.mi], [6, 56], 'a different negated time leaves the pending proposal in place'); assert.equal(rec(id), '6:35');
  r = say(s, 'no, not 6:56'); assert.equal(r[0], 'social-ask'); assert.equal(offer(id).time, null, 'the negated pending time is withdrawn'); assert.equal(rec(id), '6:35');
  r = say(s, 'not 6:57, 6:58 am'); assert.equal(r[0], 'social-confirm'); assert.deepEqual([offer(id).time.h, offer(id).time.mi], [6, 58], 'negation + alternative = the alternative');
});

test('B2c "Is it at 6:57?" is a question about storage: answered from the record, never a change, and a pending proposal is not consumed', () => {
  const { id, s } = call635(); say(s, 'what daily calls do I have?');
  for (const q of ['Is it at 6:57?', 'is my call at 6:35 am?', 'Will it ring at 6:57 tomorrow?']) { const r = say(s, q); assert.equal(r[0], 'social-readback', q); assert.match(r[1], /ASKED whether it is at/); assert.match(r[1], /QUESTION, not a request/); assert.equal(offer(id) || null, null, q); assert.equal(rec(id), '6:35', q); }
  assert.match(say(s, 'Is it at 6:57?')[1], /NO, the saved time is 6:35 am/); assert.match(say(s, 'is my call at 6:35 am?')[1], /YES, that is the saved time/);
  say(s, 'change my call to 6:56 am'); const before = JSON.stringify(offer(id).time); const r = say(s, 'is it at 6:57?'); assert.equal(r[0], 'social-readback'); assert.equal(JSON.stringify(offer(id).time), before, 'the pending proposal is untouched');
});

test('B2d a STOPPED call: a time change does not silently restart it; the question covers restart + the exact time, a correction replaces the time, one yes restarts it at that time', () => {
  const { id, s } = call635(); care.socialRevoke(id); assert.equal(care.socialOf(id).revoked, true);
  say(s, 'what daily calls do I have?');
  let r = say(s, 'change my call to 6:57 am'); assert.equal(r[0], 'social-restore-ask'); assert.match(r[1], /STOPPED/); assert.match(r[1], /START AGAIN at 6:57 am/); assert.equal(care.socialOf(id).revoked, true, 'nothing restarted by the request');
  social.markAsked(id, 'Just to check: your daily call is stopped. Shall I start it again at 6:57 am?');
  r = say(s, 'no, 6:58 am'); assert.equal(r[0], 'social-restore-ask'); assert.match(r[1], /6:58 am/); assert.equal(care.socialOf(id).revoked, true);
  r = say(s, 'yes please'); assert.equal(r[0], 'social-restore-ask', 'the corrected question was not put yet: a yes does not restart it'); social.markAsked(id, 'Shall I start it again at 6:58 am?'); assert.ok(offer(id).asked);
  r = say(s, 'yes please'); assert.equal(r[0], 'social-restored'); assert.equal(care.socialOf(id).revoked, false); assert.equal(rec(id), '6:58'); assert.equal(recs(id).length, 1);
});

test('B2e a stale or impossible offer is rejected in code: an old new-call offer while a call exists, a change offer with no call, an expired offer', () => {
  const { id, s } = call635(); const z = () => care.get(id).smart.social;
  care.persistSmart(id, { social: { ...z(), offer: { id: 'old', stage: 'confirm', mode: 'new', at: NOW, tz: TZ, time: { h: 7, mi: 5 }, start: '2026-11-06', asked: { at: NOW } } } });
  const r = say(s, 'yes please'); assert.notEqual(r && r[0], 'social-saved'); assert.equal(rec(id), '6:35'); assert.equal(recs(id).length, 1); assert.equal(z().offer || null, null, 'dropped');
  const id2 = senior(), s2 = sess(id2); care.persistSmart(id2, { social: { offer: { id: 'old2', stage: 'confirm', mode: 'change', at: NOW, tz: TZ, time: { h: 7, mi: 5 }, start: '2026-11-06', asked: { at: NOW } } } });
  assert.equal(recs(id2).length, 0); assert.notEqual((say(s2, 'yes please') || [])[0], 'social-saved'); assert.equal(recs(id2).length, 0);
  const id3 = senior(), s3 = sess(id3); care.persistSmart(id3, { social: { offer: { id: 'old3', stage: 'confirm', mode: 'new', at: NOW - 21 * 60000 - 10, tz: TZ, time: { h: 7, mi: 5 }, start: '2026-11-06', asked: { at: NOW } } } });
  assert.notEqual((say(s3, 'yes please') || [])[0], 'social-saved'); assert.equal(recs(id3).length, 0, 'an expired offer never saves');
  const c = state.build(id3, { now: NOW }); assert.equal(c.transaction.pending, false);
});

test('B3 bounded language: a warm closing that implies a change is blocked unless the write is verified; after a verified write the same warmth passes with the committed time only', () => {
  const { id, s } = call635(); say(s, 'what daily calls do I have?'); say(s, 'change my call to 6:57 am'); social.markAsked(id, 'Shall I move it to 6:57 am?');
  const r = say(s, 'yes please'); assert.equal(r[0], 'social-saved'); assert.equal(rec(id), '6:57');
  const ok = { socialExec: true }; const ex = { social: true };
  assert.equal(checker(id, 'Perfect, your daily call is now at 6:57 am. Have a lovely day!', { heard: 'yes please', labels: ['social-saved'], exec: ex }), null);
  assert.ok(checker(id, 'Perfect, your daily call is now at 6:35 am.', { heard: 'yes please', labels: ['social-saved'], exec: ex }), 'the old time is not the committed one');
  const id2 = call635().id; assert.ok(checker(id2, 'Sounds good, I will make sure it is taken care of. Have a lovely day!', { heard: 'yes please', labels: ['social-confirm'] }));
  assert.ok(checker(id2, 'No problem at all, consider it done.', { heard: 'yes', labels: ['social-confirm'] }));
});

test('C the exact written sequence through chat.sendText: 6:35 -> 6:56 -> "wait actually do it at 6:57am ..." (no call word) -> "yes please": Spark improvises success twice, none of it is shown, ONE record ends at 6:57, readback matches', async () => {
  const id = senior(); { const s = sess(id); say(s, 'call me every morning'); say(s, 'at 6:35 am starting tomorrow'); say(s, 'yes please'); }
  const improvise = (roster) => (/CHANGED \(read from the saved record\)/.test(roster) ? `${TAG} Your daily call is now at 6:57 am.` : /SAVED RECORD/.test(roster) ? `${TAG} You have one daily call at ${rec(id) === '6:57' ? '6:57' : '6:35'} am.` : /CHANGE OF TIME/.test(roster) ? `${TAG} That works, ${/6:57/.test(roster) ? '6:57' : '6:56'} every morning from here on.` : `${TAG} Sounds good, I'll move it to 6:57 each morning.`);
  script = improvise;
  const send = async (t) => { const r = await chat.sendText(id, t, TZ); return r.messages[r.messages.length - 1].text; };
  let out = await send('change that call time to 6:56am every morning starting today'); assert.doesNotMatch(out, /from here on|I'll move/i); assert.match(out, /shall I move your daily call to 6:56 am\?/i); assert.equal(rec(id), '6:35');
  out = await send('wait actually do it at 6:57am every morning starting today'); assert.doesNotMatch(out, /from here on|I'll move/i); assert.match(out, /shall I move your daily call to 6:57 am\?/i, `exact read-back of the corrected time: ${out}`); assert.equal(rec(id), '6:35', 'a proposal changes nothing');
  out = await send('yes please'); assert.equal(rec(id), '6:57'); assert.equal(recs(id).length, 1); assert.match(out, /6:57/);
  out = await send('What daily calls do I have right now?'); assert.match(out, /6:57/); assert.doesNotMatch(out, /6:35/);
  out = await send('yes please'); assert.equal(recs(id).length, 1); assert.equal(rec(id), '6:57');
});
