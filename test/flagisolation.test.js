// Flag isolation: the STATE layers (MAYA_SMART_STATE_CARDS / _GUARD / _DECISION) and the SCAM layers (MAYA_SMART_CARDS / _GUARD / _DECISION, and the MAYA_SMART master) never switch each other on.
// All default OFF. Each of the four combinations is checked for each layer, on observable behaviour, not on the flag function alone. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-flagiso-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async (_h, _r, _s, d) => { if (d) d('Okay.'); return 'Okay.'; } } };
const memory = require('../memory'); const care = require('../care'); const smart = require('../smart'); const social = require('../social'); const setrem = require('../setrem');
const TZ = 'America/New_York', NOW = setrem.zonedEpoch(2026, 11, 5, 10, 0, TZ);
const ALL = ['MAYA_SMART', 'MAYA_SMART_COMPANION', ...['CARDS', 'GUARD', 'DECISION'].flatMap((l) => [`MAYA_SMART_${l}`, `MAYA_SMART_STATE_${l}`])];
const reset = (on = []) => { for (const k of ALL) delete process.env[k]; for (const k of on) process.env[k] = 'on'; };
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => { const p = memory.createProfile(`Iso${letters(n++)}`, 'female'); care.get(p.id).tz = TZ; return p.id; };
const sess = (id) => ({ profile: memory.load(id), channel: 'chat', factLabels: [], outreach: null, _exec: {}, lastHeard: () => '' });
const ctx = () => ({ intent: 'smalltalk', callsOk: true, safe: true });
let clock = 0; const say = (s, t) => social.step(s, t, ctx(), NOW + 10 + (clock += 5));
test.afterEach(() => reset());
test.after(() => { reset(); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });

// What each layer does, observed:
// STATE CARDS    -> notes() carries 'smart-app-state'.        SCAM CARDS    -> notes() on a scam turn carries 'smart-state'.
// STATE GUARD    -> breaks() blocks a false "family needed".  SCAM GUARD    -> breaks() blocks "verified safe".
// STATE DECISION -> a repeated daily-call ask gives 'social-decide-existing'.   SCAM DECISION -> a scam turn carries 'smart-decision'.
const stateCards = () => { const id = senior(), s = sess(id); return smart.notes(s, 'hello there').some(([l]) => l === 'smart-app-state'); };
const scamCards = () => { const id = senior(), s = sess(id); s._scam = { scam: { level: 'caution', type: 'bank scam', signals: { urgency: true } }, failed: false, needed: true }; return smart.notes(s, 'a man called about my bank account and wants money').some(([l]) => l === 'smart-state'); };
const stateGuard = () => { const id = senior(), s = sess(id); s.factLabels = ['social-ask']; care.attachSenior(id, { write() { return true; } }, TZ); return Boolean(smart.breaks("You'd need to ask your son to set that up for you.", s)); };
const scamGuard = () => { const id = senior(), s = sess(id); return Boolean(smart.breaks('It is verified safe, you can go ahead.', s)); };
const stateDecision = () => { const id = senior(), s = sess(id); say(s, 'could you ring me every day please'); say(s, '3 pm tomorrow'); say(s, 'yes perfect'); const r = say(s, 'could you ring me every day please'); return Boolean(r && r[0] === 'social-decide-existing'); };
const scamDecision = () => { const id = senior(), s = sess(id); s._scam = { scam: { level: 'warn', type: 'bank scam', signals: { payment: true } }, failed: false, needed: true }; return smart.notes(s, 'a man called and wants me to pay a fee now').some(([l]) => l === 'smart-decision'); };
const LAYERS = [['CARDS', stateCards, scamCards], ['GUARD', stateGuard, scamGuard], ['DECISION', stateDecision, scamDecision]];

test('1 defaults: with no env at all every state flag and every scam flag is OFF and nothing of either runs', () => {
  reset();
  for (const [l, st, sc] of LAYERS) { assert.equal(smart.stateFlag(l), false, `state ${l}`); assert.equal(smart.flag(l), false, `scam ${l}`); assert.equal(st(), false, `state ${l} behaviour`); assert.equal(sc(), false, `scam ${l} behaviour`); }
  assert.equal(smart.any(), false);
});

for (const [layer, st, sc] of LAYERS) {
  test(`2 ${layer}: state on + scam off -> only the state layer runs`, () => { reset(['MAYA_SMART_COMPANION', `MAYA_SMART_STATE_${layer}`]); assert.equal(smart.stateFlag(layer), true); assert.equal(smart.flag(layer), false); assert.equal(st(), true, 'state behaviour on'); assert.equal(sc(), false, 'scam behaviour stays off'); });
  test(`3 ${layer}: state off + scam on -> only the scam layer runs`, () => { reset(['MAYA_SMART_COMPANION', `MAYA_SMART_${layer}`]); assert.equal(smart.flag(layer), true); assert.equal(smart.stateFlag(layer), false); assert.equal(sc(), true, 'scam behaviour on'); assert.equal(st(), false, 'state behaviour stays off'); });
  test(`4 ${layer}: both on -> both run, each by its own flag`, () => { reset(['MAYA_SMART_COMPANION', `MAYA_SMART_${layer}`, `MAYA_SMART_STATE_${layer}`]); assert.equal(st(), true); assert.equal(sc(), true); });
}

test('5 the scam master switch MAYA_SMART=on turns every scam layer on and NO state layer; a state flag never sets a scam flag', () => {
  reset(['MAYA_SMART_COMPANION', 'MAYA_SMART']);
  for (const [l, st, sc] of LAYERS) { assert.equal(smart.flag(l), true); assert.equal(smart.stateFlag(l), false); assert.equal(st(), false, `state ${l} stays off under MAYA_SMART`); assert.equal(sc(), true); }
  reset(['MAYA_SMART_COMPANION', 'MAYA_SMART_STATE_CARDS', 'MAYA_SMART_STATE_GUARD', 'MAYA_SMART_STATE_DECISION']);
  for (const l of ['CARDS', 'GUARD', 'DECISION', 'KINDS', 'SHORT', 'CONTRACT', 'CAPS', 'MEMORY', 'GENERAL', 'ROUTER', 'ABILITIES']) assert.equal(smart.flag(l), false, `scam/other ${l} stays off with every state flag on`);
});

test('6 the old names no longer control state: MAYA_SMART_CARDS/GUARD/DECISION alone give no state card, no state check, no state decision (the c4e8a1c behaviour)', () => {
  reset(['MAYA_SMART_COMPANION', 'MAYA_SMART_CARDS', 'MAYA_SMART_GUARD', 'MAYA_SMART_DECISION']);
  assert.equal(stateCards(), false); assert.equal(stateGuard(), false); assert.equal(stateDecision(), false);
});

test('7 each state flag is independent of the other two (one at a time)', () => {
  for (const on of ['CARDS', 'GUARD', 'DECISION']) { reset(['MAYA_SMART_COMPANION', `MAYA_SMART_STATE_${on}`]); const got = { CARDS: stateCards(), GUARD: stateGuard(), DECISION: stateDecision() }; for (const l of Object.keys(got)) assert.equal(got[l], l === on, `${on} on -> ${l}`); }
});

test('8 state flags off: the daily-call flow is exactly the COMPANION flow (no decision facts, no card), saved once', () => {
  reset(['MAYA_SMART_COMPANION']); const id = senior(), s = sess(id);
  assert.equal(say(s, 'could you ring me every day please')[0], 'social-ask'); say(s, '3 pm tomorrow'); assert.equal(say(s, 'yes perfect')[0], 'social-saved');
  assert.equal(care.get(id).reminders.filter((r) => r.social).length, 1);
  const r = say(s, 'can you call me every Monday Wednesday and Friday at 4 pm'); assert.ok(!r || !/^social-decide/.test(r[0]));
});
