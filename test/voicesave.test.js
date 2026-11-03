// The LIVE VOICE SEQUENCE, through the real Call.respond() path (not only social.step): split speech fragments, a wrong refusal drafted by Spark (twice), a "no" that is a correction, a fresh yes that only restates the time.
// Spark is a stub that reproduces the live misbehaviour; the checks are on what is actually SPOKEN (the history of what was said aloud), on the stored schedule, and on the facts handed to Spark. No network, noVoice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-voicesave-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on';
const TAG = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
const asked = []; let script = () => `${TAG} Okay.`;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}',
  sparkStream: async (history, roster, _s, onDelta) => { if (/has been silent for a little while/.test(roster)) { const t = `${TAG} Are you still there?`; if (onDelta) onDelta(t); return t; } asked.push({ roster, retry: /Your draft began/.test(roster) }); const t = script(roster, history); if (onDelta) onDelta(t); return t; } } };
const memory = require('../memory'); const care = require('../care'); const setrem = require('../setrem'); const social = require('../social'); const { Call } = require('../call');
care.cfg.quietStart = 0; care.cfg.quietEnd = 0;
const TZ = 'America/New_York';
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];
function mkCall() {
  const ws = { send() {}, close() {}, onmessage: null, onclose: null };
  const p = memory.createProfile(`Voice${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; care.get(p.id).tzSource = 'device';
  care.attachSenior(p.id, { write() { return true; } }, TZ);   // a web-only senior: the page is open, NO registered phone
  const c = new Call(ws, 'k'); c.profile = memory.load(p.id); c.callId = `c${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController();
  c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; made.push(c); return c;
}
const turn = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
const said = (c) => c.history.filter((m) => m.role === 'assistant').map((m) => m.content.replace(/\[\[[^\]]*\]\]/g, '').trim());
async function say(c, text) { const before = asked.length; c.pending = [turn(text)]; await c.respond(0); await sleep(10); return { labels: [...c.factLabels], rosters: asked.slice(before) }; }
const recs = (id) => care.get(id).reminders.filter((r) => r.social);
const spoken = (c, i = -1) => said(c).at(i);
// a time 45 minutes from now in their zone, spoken the way a transcript writes it ("4.10 pm")
function soon() { const t = setrem.partsIn(Date.now() + 45 * 60000, TZ), now = setrem.partsIn(Date.now(), TZ); const h12 = t.h % 12 || 12, mm = String(t.mi).padStart(2, '0'), ap = t.h < 12 ? 'am' : 'pm'; return { dotted: `${h12}.${mm}`, colon: `${h12}:${mm}`, ap, h: t.h, mi: t.mi, day: t.d === now.d ? 'today' : 'tomorrow' }; }
test.after(() => { for (const c of made) { try { c.end(); } catch { /* over */ } } care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 the live voice sequence: split speech, a refused-by-Spark confirm (both drafts wrong), a correction that is NOT a decline, a fresh yes that restates the time -> ONE saved schedule, only true words spoken', async () => {
  const c = mkCall(), id = c.profile.id, T = soon(); const ev = []; care.attachSenior(id, { write(x) { const m = /event: (\w+)\ndata: (.*)\n/.exec(x); if (m) ev.push(m[1]); return true; } }, TZ);
  // start from a CANCELLED state
  const s0 = { profile: memory.load(id), channel: 'chat', factLabels: [], _exec: {}, lastHeard: () => '' };
  const ctx = { intent: 'smalltalk', callsOk: true, safe: true }, at = Date.now();
  social.step(s0, 'could you ring me every day please', ctx, at); social.step(s0, `${T.colon} ${T.ap} ${T.day}`, ctx, at + 1); social.markAsked(id, `Shall I call you every day at ${T.colon} ${T.ap}?`); social.step(s0, 'yes perfect', ctx, at + 2);
  assert.equal(recs(id).length, 1); social.step(s0, 'please cancel my daily calls', ctx, at + 3); assert.equal(recs(id).length, 0);
  // Spark misbehaves exactly as it did live, twice (the draft and its rewrite)
  const BAD = `${TAG} I can't set up daily calls myself, that's something your family arranges.`;
  script = (roster) => (/SOCIAL CALL, CONFIRM|CORRECTION of something you said/.test(roster) && !/ALREADY|SAVED \(read/.test(roster) && !c._allowGood ? BAD : /SAVED \(read from the saved record\)/.test(roster) ? `${TAG} Your daily call is saved, I'll ring you then.` : `${TAG} Okay.`);
  // 1: the request; 2-4: split fragments of one answer; each is its own turn
  await say(c, 'can you call me every day');
  await say(c, `at ${T.dotted}`);
  await say(c, `starting ${T.day}`);
  const r4 = await say(c, T.ap);   // "am" / "pm" on its own settles the clock time that was waiting for it
  assert.equal(recs(id).length, 0, 'nothing is saved by fragments');
  const z = () => care.get(id).smart.social;
  assert.ok(z().offer, 'ONE pending proposal survived the split turns'); assert.deepEqual([z().offer.time.h, z().offer.time.mi], [T.h, T.mi]); assert.equal(z().offer.stage, 'confirm');
  assert.ok(r4.labels.includes('social-confirm'));
  assert.equal(r4.rosters.some((x) => x.retry), true, 'Spark\'s wrong draft was blocked and rewritten');
  const line = spoken(c); assert.doesNotMatch(line, /family arranges|can't set up|cannot set up/i, 'the wrong refusal never reached the voice, even in the SECOND draft');
  assert.match(line, /^Just to check: shall I call you every day at /, 'a plain, true read-back of the proposal was spoken instead');
  assert.ok(z().offer.asked, 'the read-back WAS spoken, so a yes can bind to it');
  // the correction: "No, you just said ..." keeps the proposal and does not decline
  const corr = await say(c, 'No, you just said you can call me every day.');
  assert.ok(!corr.labels.includes('social-declined'), 'a correction is not a decline'); assert.ok(corr.labels.includes('social-confirm'));
  assert.ok(z().offer && !z().declinedAt, 'the proposal is still pending and no decline is recorded');
  assert.match(corr.rosters[0].roster, /CORRECTION of something you said, NOT a refusal/);
  // the correction led to another read-back (Spark's draft was wrong again, so the plain true line was spoken)
  assert.match(spoken(c), /^Just to check/); assert.ok(z().offer.asked);
  script = (roster) => (/SAVED \(read from the saved record\)/.test(roster) ? `${TAG} Your daily call is saved for ${T.colon} ${T.ap}; you can skip, change or cancel it here anytime.` : `${TAG} Okay.`);
  const yes = await say(c, `Yeah, it's ${T.dotted} ${T.ap}`);
  assert.ok(yes.labels.includes('social-saved'), `fresh yes saves (labels: ${yes.labels.join(',')})`); assert.equal(recs(id).length, 1, 'exactly ONE committed schedule');
  const rec = care.socialOf(id); assert.deepEqual([rec.h, rec.mi, rec.tz], [T.h, T.mi, TZ]);
  assert.match(spoken(c), /saved for/); assert.doesNotMatch(said(c).join(' '), /family (arranges|has to|needs)/i);
  // a repeated yes cannot make a second record
  await say(c, `Yeah, it's ${T.dotted} ${T.ap}`); assert.equal(recs(id).length, 1);
  // the ring (local, through the scheduler's own tick): at the agreed time the OPEN web page gets the call, with no phone registered and no family involved
  assert.equal((care.get(id).devices || []).length, 0, 'no registered phone'); const before = ev.filter((e) => e === 'incoming').length;
  care.tick(rec.nextAt + 1000); for (let k = 0; k < 40 && ev.filter((e) => e === 'incoming').length === before; k++) await sleep(50); assert.equal(ev.filter((e) => e === 'incoming').length, before + 1, 'the web page was rung at the agreed time'); assert.equal(recs(id).length, 1);
  // separate readback from storage
  const rb = await say(c, 'what daily calls do I have?'); assert.ok(rb.labels.includes('social-readback')); assert.match(rb.rosters[0].roster, new RegExp(`${T.colon.replace(':', ':')} ${T.ap}`));
});

test('2 the scheduling turn is compact: short style block, no full profile or roster, the compact APP TRUTH block near the end (state CARDS on)', async () => {
  const c = mkCall(); script = () => `${TAG} Okay.`;
  const r = await say(c, 'can you call me every day');
  const roster = r.rosters[0].roster;
  assert.ok(roster.startsWith('[[COMPACT]]'), 'compact roster'); assert.match(roster, /APP TRUTH/); assert.doesNotMatch(roster, /WHAT YOU KNOW ABOUT WHAT IS HAPPENING/); assert.ok(roster.length < 3200, `compact roster ${roster.length}`);
  assert.ok(roster.indexOf('APP TRUTH') > roster.length / 3, 'the truth block is in the later part');
  assert.match(roster, /family is NOT needed and a registered phone is NOT needed/);
  const c2 = mkCall(); const r2 = await say(c2, 'the garden looks lovely today');   // an ordinary turn: the full prompt, unchanged
  assert.doesNotMatch(r2.rosters[0].roster, /^\[\[COMPACT\]\]/);
});
