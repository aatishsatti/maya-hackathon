// "Let my family know" must be a request TO MAYA. The person's own plans and reminders ("remind me to call my sister", "I have to call my daughter") are not, and used to
// send the family a real note (care.familyAsk). The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-famreq-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, sparkComplete: async () => '{}', sparkStream: async () => '', streamSpeech: async () => {}, describeImage: async () => 'unused' } };
const memory = require('../memory');
const care = require('../care');
const { Call, asksFamily, saysYesToFamily, refusedFamily, ownPlan } = require('../call');
const { ChatSession } = require('../chat');

let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const profile = () => memory.load(memory.createProfile(`Fam${letters(n++)}`, 'female').id);
const familyNotes = (id) => care.get(id).notifications.filter((x) => x.to === 'family' && x.ref === 'family_ask');
const bareCall = () => { const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = profile(); c.gen = 1; c.abort = new AbortController(); return c; };

// What must NOT count as "let my family know".
const NOT_REQUESTS = [
  'Can you remind me in 30 seconds that I have to call my sister.', 'Remind me in 30 seconds that I have to call my sister', 'remind me to call my son tonight', 'remind me in 10 minutes to ring my daughter',
  'Please set a reminder to phone my wife', 'I have to call my sister', 'I need to call my daughter later', 'I want to ring my brother', "I'll call my son after lunch", "I'm going to call my sister tomorrow",
  'I forgot to call my son', 'I should call my daughter', 'We must tell the kids', 'I would like to call my wife', "I'd like to call my son", 'I really have to call my sister', 'I am about to call my husband',
  'I was supposed to call my daughter', 'I am trying to call my brother',
];
// What MUST still count.
const REQUESTS = ['Tell my family', 'Please let my daughter know I fell', 'call my son for me', 'Could you contact my family', 'Please alert my family', 'message my daughter please', 'Let my sister know I am fine',
  'Tell my family I am fine', 'I want you to tell my family', "I'd like you to call my son", 'I have to ask you to tell my family', 'Can you tell my daughter I am home', 'ring my daughter', 'Yes, let my son know'];

test('own plans and reminders are not requests to Maya (asksFamily, ownPlan, and the explicit-request part of saysYesToFamily)', () => {
  for (const t of NOT_REQUESTS) { assert.equal(asksFamily(t), false, `asksFamily: ${t}`); assert.equal(saysYesToFamily(t), false, `saysYesToFamily: ${t}`); }
  for (const t of ['Can you remind me in 30 seconds that I have to call my sister.', 'remind me to call my son tonight', 'I have to call my sister', 'I want to ring my brother', "I'll call my son after lunch"]) assert.equal(ownPlan(t), true, `ownPlan: ${t}`);
});

test('real requests to Maya still count', () => {
  for (const t of REQUESTS) assert.equal(asksFamily(t), true, `asksFamily: ${t}`);
  for (const t of ['Tell my family', 'Please tell my daughter', 'Yes, let them know', 'please let my daughter know']) assert.equal(saysYesToFamily(t), true, `saysYesToFamily: ${t}`);
});

test('only the text up to the family word decides: "Please tell my family I will call them tomorrow" is still a request (to the helper)', () => {
  assert.equal(ownPlan('Please tell my family I will call them tomorrow'), false);
  assert.equal(ownPlan('Let my daughter know I will be late'), false);
  assert.equal(ownPlan('I want you to tell my family'), false); assert.equal(ownPlan("I'd like you to call my son"), false); assert.equal(ownPlan('I have to ask you to tell my family'), false);
  assert.equal(ownPlan('I will call my son'), true); assert.equal(ownPlan('remind me to tell my family hello'), true);
});

test('refusals: "do not tell my family" is still a no; "I don\'t want to call my daughter" is her own plan, not a refusal', () => {
  for (const t of ['Please do not tell my family', "Don't tell my son", 'I do not want you to tell my family', 'no please, never call my daughter']) assert.equal(refusedFamily(t), true, t);
  for (const t of ["I don't want to call my daughter", 'I do not need to call my son', "I won't have to call my sister"]) assert.equal(refusedFamily(t), false, t);
  assert.equal(refusedFamily('Yes tell my son'), false);
});

test('a reminder turn creates NO family notification and no "note was sent" fact; a genuine request creates exactly one, and only once per call', () => {
  const c = bareCall(); const id = c.profile.id;
  for (const t of ['Can you remind me in 30 seconds that I have to call my sister.', 'remind me to call my son tonight', 'I need to call my daughter later']) { const note = c.careNotes(t); assert.doesNotMatch(note, /let their family know|gentle note/, t); }
  assert.equal(c.timers.length, 1, 'the 30 second reminder was still set as a timer'); for (const t of c.timers) clearTimeout(t.handle);
  assert.equal(familyNotes(id).length, 0, 'no family notification from reminders or plans'); assert.equal(c.familyAsked, undefined); assert.ok(!c.familyDeclined);
  const note = c.careNotes('Please let my daughter know I fell'); assert.match(note, /they asked you to let their family know, and the app has sent their family a gentle note/); assert.equal(familyNotes(id).length, 1);
  c.careNotes('And tell my son too, please'); assert.equal(familyNotes(id).length, 1, 'once per call');
});

test('"I don\'t want to call my daughter" no longer silences later alerts for the call; a real refusal still does', () => {
  const a = bareCall(); a.careNotes("I don't want to call my daughter"); assert.ok(!a.familyDeclined, 'her own plan is not a refusal');
  const b = bareCall(); b.careNotes('Please do not tell my family'); assert.equal(b.familyDeclined, true);
});

test('the written chat (which borrows the same code) behaves the same: a reminder sends nothing, a request sends one note', () => {
  const p = profile(); const s = new ChatSession(p, null);
  assert.doesNotMatch(s.careNotes('Remind me to call my sister tomorrow.'), /gentle note/); assert.equal(familyNotes(p.id).length, 0);
  assert.match(s.careNotes('Please tell my family I am home.'), /gentle note/); assert.equal(familyNotes(p.id).length, 1);
});
