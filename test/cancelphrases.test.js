// Live bug (4 Nov 2026): Maya said the daily call was cancelled while the 4:30 pm record stayed; "any calls lined up?" skipped the record readback.
// Cancel phrasing ("cancel it", "cancel that", "I don't want the daily call anymore"), readback phrasing, cancel verified from storage,
// a failed cancel never says "cancelled" (and names what is still lined up), and a repeat cancel is answered truthfully. Uses the real clock (no fixed dates).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-cxl-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_STATE_CARDS = 'on'; process.env.MAYA_SMART_STATE_GUARD = 'on'; process.env.MAYA_SMART_STATE_DECISION = 'on';
const memory = require('../memory'); const care = require('../care'); const social = require('../social');
const TZ = 'America/New_York';
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
function senior(history, withCall = true) {
  const p = memory.createProfile(`Cxl${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; care.get(p.id).tzSource = 'device';
  const now = Date.now(); const tomorrow = care.localDate(now + 86400000, TZ);
  if (withCall) care.socialSave(p.id, { offerId: `o${n}`, h: 16, mi: 30, start: tomorrow, tz: TZ }, now);
  return { id: p.id, s: { profile: memory.load(p.id), channel: 'call', callId: `call${n}`, history: history || [], factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' } };
}
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
const say = (s, t) => { const a = social.stopTurn(s, s.profile.id, t, Date.now()); return a || social.step(s, t, ctx(), Date.now()); };
test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

test('1 every cancel phrasing really cancels, and the answer is a verified CANCELLED note', () => {
  const talk = [{ role: 'user', content: 'what about my daily call' }, { role: 'assistant', content: 'Your daily call is at 4:30 pm.' }];
  for (const said of ['cancel it', 'Cancel that.', 'please cancel it', "I don't want the daily call anymore", 'I dont want the daily calls any more', 'cancel my daily call', 'cancel the 4:30 call', 'stop the calls']) {
    const { id, s } = senior(talk); assert.ok(care.socialOf(id), 'call exists first');
    const r = say(s, said); assert.ok(r && /^social-(stopped|cancel)/.test(r[0]), `${said}: ${r && r[0]}`);
    assert.match(r[1], /CANCELLED/, said); assert.equal(care.socialOf(id), null, `${said}: record gone from storage`);
    assert.ok((care.get(id).smart.social || {}).cancelledAt, `${said}: cancelledAt kept`);
  }
});
test('2 a bare "cancel it" with no daily call, or about something else, cancels nothing', () => {
  const none = senior([], false); const r = social.stopTurn(none.s, none.id, 'cancel it', Date.now()); assert.equal(r, null);
  const other = senior([{ role: 'assistant', content: 'I set your tablet reminder for 9.' }]); // call exists but talk is not about calls
  const r2 = social.stopTurn(other.s, other.id, 'cancel it', Date.now()); assert.equal(r2, null); assert.ok(care.socialOf(other.id), 'call untouched');
});
test('3 readback phrasing: lined up / coming up / scheduled, in either order', () => {
  const { id, s } = senior([]);
  for (const said of ['any calls lined up?', 'Are any calls scheduled?', 'do I have any calls lined up', 'is there a call coming up', 'what calls do I have', 'what is lined up, any calls', 'when is my next call']) {
    const r = say(s, said); assert.ok(r && r[0] === 'social-readback', `${said}: ${r && r[0]}`); assert.match(r[1], /daily call at/i, said);
  }
  const { id: id2, s: s2 } = senior([], false); const r = say(s2, 'any calls lined up?');
  assert.ok(r && r[0] === 'social-readback' && /no daily call/i.test(r[1]), 'nothing saved says so'); void id; void id2;
  const hit = say(senior([]).s, 'I got a call from my son on Monday'); assert.ok(!hit || hit[0] !== 'social-readback', 'a plain statement is not a readback');
});
test('4 after a cancel, "lined up?" reads the same saved state: none, and says it was cancelled not failed', () => {
  const { id, s } = senior([{ role: 'assistant', content: 'daily call 4:30' }]); say(s, 'cancel it');
  const r = say(s, 'any calls lined up?'); assert.equal(r[0], 'social-readback'); assert.match(r[1], /no daily call is arranged now[\s\S]*cancelled/i); assert.equal(care.socialOf(id), null);
});
test('5 a repeat cancel is answered truthfully (no active daily call), never "cancelled" again', () => {
  const { id, s } = senior([{ role: 'assistant', content: 'daily call' }]); say(s, 'cancel my daily call');
  const r = say(s, 'cancel my daily call'); assert.ok(r && r[0] === 'social-cancel-none', r && r[0]); assert.match(r[1], /NO ACTIVE DAILY CALL/); assert.doesNotMatch(r[1], /CANCELLED/); assert.equal(care.socialOf(id), null);
});
test('6 a cancel that does not stick never says "cancelled" and names what is still lined up', () => {
  const { id, s } = senior([{ role: 'assistant', content: 'daily call' }]);
  const orig = care.socialCancel; care.socialCancel = () => false;   // the write silently fails: the record stays
  try { const r = say(s, 'cancel my daily call'); assert.equal(r[0], 'social-stop-failed'); assert.match(r[1], /NOT CONFIRMED/); assert.match(r[1], /still lined up/); assert.match(r[1], /4:30/); assert.ok(care.socialOf(id), 'record still there'); }
  finally { care.socialCancel = orig; }
});
