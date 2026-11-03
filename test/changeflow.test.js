// Patch A: the written chat reads back the daily call without a crash (the compact roster is available in the written path, and its absence falls back to the full roster).
// Patch B: the live CHANGE sequence through the real voice path: change 5:51 -> 6:05, correction to 6:06 before the final confirm, ONE "Yes, please", one record at the corrected time, a false "Done" blocked while the record is still old,
// a failed write keeps the old schedule with no success claim. Spark is a stub that misbehaves as it did live. No network, noVoice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-change-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on';
const TAG = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const asked = []; let script = () => `${TAG} Okay.`;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => '',
  sparkStream: async (history, roster, _s, onDelta) => { if (/has been silent for a little while/.test(roster)) { const t = `${TAG} Are you still there?`; if (onDelta) onDelta(t); return t; } asked.push({ roster, retry: /Your draft began/.test(roster) }); const t = script(roster, history); if (onDelta) onDelta(t); return t; } } };
const memory = require('../memory'); const care = require('../care'); const setrem = require('../setrem'); const social = require('../social'); const chat = require('../chat'); const { Call } = require('../call');
care.cfg.quietStart = 0; care.cfg.quietEnd = 0;
const TZ = 'America/New_York';
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];
const clockOf = (min) => { const t = setrem.partsIn(Date.now() + min * 60000, TZ), h12 = t.h % 12 || 12, mm = String(t.mi).padStart(2, '0'); return { h: t.h, mi: t.mi, colon: `${h12}:${mm}`, ap: t.h < 12 ? 'am' : 'pm', day: t.d === setrem.partsIn(Date.now(), TZ).d ? 'today' : 'tomorrow' }; };
function senior() { const p = memory.createProfile(`Chg${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; care.get(p.id).tzSource = 'device'; care.attachSenior(p.id, { write() { return true; } }, TZ); return p.id; }
function saveCall(id, T) {   // a call that already exists (created through the daily-call flow, the confirm question spoken, one yes)
  const s = { profile: memory.load(id), channel: 'chat', factLabels: [], _exec: {}, lastHeard: () => '' }, ctx = { intent: 'smalltalk', callsOk: true, safe: true }, at = Date.now();
  social.step(s, 'could you ring me every day please', ctx, at); social.step(s, `${T.colon} ${T.ap} ${T.day}`, ctx, at + 1); social.markAsked(id, `Shall I call you every day at ${T.colon} ${T.ap}?`);
  assert.equal(social.step(s, 'yes perfect', ctx, at + 2)[0], 'social-saved');
}
function mkCall(id) { const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); c.profile = memory.load(id); c.callId = `c${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController(); c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; made.push(c); return c; }
const turn = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
const said = (c) => c.history.filter((m) => m.role === 'assistant').map((m) => m.content.replace(/\[\[[^\]]*\]\]/g, '').trim());
async function say(c, text) { const before = asked.length; c.pending = [turn(text)]; await c.respond(0); await sleep(10); return { labels: [...c.factLabels], rosters: asked.slice(before) }; }
const recs = (id) => care.get(id).reminders.filter((r) => r.social);
const sameHalf = (a, b) => (a.h < 12) === (b.h < 12) && a.day === 'today' && b.day === 'today';
test.after(() => { for (const c of made) { try { c.end(); } catch { /* over */ } } care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('A1 written chat: "What daily calls do I have right now?" sends and answers from the record: twice without refreshing, once after a refresh, and with the compact helper missing', async () => {
  const id = senior(), T = clockOf(40); saveCall(id, T);
  script = (roster) => (/SAVED RECORD/.test(roster) ? `${TAG} You have a daily call at ${T.colon} ${T.ap}.` : `${TAG} Okay.`);
  const ask = async () => { const before = asked.length; const r = await chat.sendText(id, 'What daily calls do I have right now?', TZ); assert.ok(r && r.messages && r.messages.length >= 2, 'the message was sent and answered'); const roster = asked[before] && asked[before].roster; assert.ok(roster, 'Spark was asked'); assert.match(roster, new RegExp(`daily call at ${T.colon.replace(':', ':0?')}`.replace('0?', '')), 'the answer is read from the saved record'); assert.match(roster, new RegExp(`${T.colon} ${T.ap}`)); return roster; };
  const r1 = await ask(); await ask();                       // twice, no refresh
  chat.sessions.delete(id); await ask();                      // a refresh: the session is built again
  assert.match(r1, /^\[\[COMPACT\]\]/, 'the written path uses the compact scheduling prompt');
  const real = chat.ChatSession.prototype.compactRoster; delete chat.ChatSession.prototype.compactRoster;   // if the helper were ever missing: the full roster, never a crash
  try { chat.sessions.delete(id); const before = asked.length; const r = await chat.sendText(id, 'What daily calls do I have right now?', TZ); assert.ok(r.messages.length >= 2); assert.doesNotMatch(asked[before].roster, /^\[\[COMPACT\]\]/); assert.match(asked[before].roster, new RegExp(`${T.colon} ${T.ap}`)); } finally { chat.ChatSession.prototype.compactRoster = real; }
  assert.equal(recs(id).length, 1);
});

test('B1 the live change sequence: 5:51 -> 6:05, corrected to 6:06 before the confirm is spoken, ONE "Yes, please": exactly one schedule at the corrected time, false "Done" blocked while the record is old', async (t) => {
  const id = senior(), T0 = clockOf(30), T1 = clockOf(40), T2 = clockOf(41);
  if (!sameHalf(T0, T1) || !sameHalf(T0, T2)) return t.skip('the test hour crosses noon or midnight');
  saveCall(id, T0); const c = mkCall(id);
  const z = () => care.get(id).smart.social;
  // Spark misbehaves as it did live: a vague "Got that", then a false "Done ... all set" with the record still old
  script = (roster) => (/CHANGE OF TIME/.test(roster) && !/CHANGED \(read/.test(roster) ? (roster.includes(`move to ${T2.colon} ${T2.ap}`) ? `${TAG} Done, ${T2.colon} is all set.` : `${TAG} Got that, ${T1.colon}.`) : /CHANGED \(read from the saved record\)/.test(roster) ? `${TAG} Your daily call is now at ${T2.colon} ${T2.ap}.` : `${TAG} Okay.`);
  const r1 = await say(c, `Can you change my daily call to ${T1.colon}`);
  assert.ok(r1.labels.includes('social-confirm')); assert.equal(z().offer.mode, 'change'); assert.deepEqual([z().offer.time.h, z().offer.time.mi], [T1.h, T1.mi], 'the half of the day follows the call they have');
  assert.match(said(c).at(-1), new RegExp(`^Just to check: shall I move your daily call to ${T1.colon} ${T1.ap}\\?`), '"Got that" is not a confirmation: the exact read-back was added in code'); assert.ok(z().offer.asked);
  const rc = await say(c, `No, make it ${T2.colon}`); assert.equal(rc.rosters.some((r) => r.retry), true, 'the false "Done" draft was drafted, blocked and rewritten');   // the correction REPLACES the pending target and invalidates the confirmation of the old one
  assert.deepEqual([z().offer.time.h, z().offer.time.mi], [T2.h, T2.mi]); assert.equal(recs(id).length, 1); assert.equal(care.socialOf(id).h, T0.h, 'nothing changed yet'); assert.equal(care.socialOf(id).mi, T0.mi);
  assert.doesNotMatch(said(c).join(' | '), /all set|done/i, 'a false "Done" never reached the voice (both drafts)');
  const rb = said(c).at(-1); assert.match(rb, new RegExp(`^Just to check: shall I move your daily call to ${T2.colon} ${T2.ap}\\?`), 'the complete corrected time was read aloud');
  assert.ok(z().offer.asked, 'and that read-back is the question a yes binds to');
  const yes = await say(c, 'Yes, please');
  assert.ok(yes.labels.includes('social-saved'), `one yes commits (${yes.labels.join(',')})`); assert.equal(recs(id).length, 1, 'exactly ONE active daily schedule');
  const rec = care.socialOf(id); assert.deepEqual([rec.h, rec.mi], [T2.h, T2.mi], 'the old time is replaced'); assert.equal(z().lastSave.ok, true);
  const again = await say(c, 'Yes, please'); assert.ok(!again.labels.includes('social-confirm'), 'no repeated confirmation after the yes'); assert.equal(recs(id).length, 1); assert.deepEqual([care.socialOf(id).h, care.socialOf(id).mi], [T2.h, T2.mi]);
  const rd = await say(c, 'what daily calls do I have?'); assert.ok(rd.labels.includes('social-readback')); assert.match(rd.rosters[0].roster, new RegExp(`${T2.colon} ${T2.ap}`)); assert.doesNotMatch(rd.rosters[0].roster, new RegExp(`at ${T0.colon} ${T0.ap}`));
});

test('B2 a failed write preserves the old schedule and no success claim is spoken (both drafts say it is done)', async (t) => {
  const id = senior(), T0 = clockOf(30), T1 = clockOf(40);
  if (!sameHalf(T0, T1)) return t.skip('the test hour crosses noon or midnight');
  saveCall(id, T0); const c = mkCall(id);
  script = (roster) => (/NOT SAVED/.test(roster) || /CHANGE OF TIME/.test(roster) ? `${TAG} Done, ${T1.colon} is all set.` : `${TAG} Okay.`);
  await say(c, `Can you change my daily call to ${T1.colon}`);
  social.markAsked(id, `Shall I move your daily call to ${T1.colon} ${T1.ap}?`);
  const real = care.socialChangeTime; care.socialChangeTime = () => { throw Object.assign(new Error('The disk is full.'), { status: 500 }); };
  let yes; try { yes = await say(c, 'Yes, please'); } finally { care.socialChangeTime = real; }
  assert.ok(yes.labels.includes('social-failed')); assert.equal(recs(id).length, 1); assert.deepEqual([care.socialOf(id).h, care.socialOf(id).mi], [T0.h, T0.mi], 'the old schedule is preserved');
  assert.doesNotMatch(said(c).join(' | '), /all set|done/i, 'no success claim reached the senior'); assert.match(said(c).at(-1), /did not save, so nothing is set up|did not save/i);
  assert.equal(care.get(id).smart.social.lastSave.ok, false);
});

test('B3 time parsing: 6:06 is never 6:00 ("606", "six oh six", "6 oh 6", "6.06"), and the new-save path still reads the same times', () => {
  for (const said of ['6:06', '606', 'No, 606', 'six oh six', '6 oh 6', '6.06', 'six zero six']) assert.match(social.normSpeech(said), /6:06/, said);
  for (const said of ['5.51', 'five fifty-one'.replace('-', ' '), '5:51']) assert.match(social.normSpeech(said), /5:51|five fifty one/, said);
  assert.match(social.normSpeech('ten past five'), /5:10/); assert.match(social.normSpeech('half past five'), /5:30/);
});
