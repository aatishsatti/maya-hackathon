// Scam turns and the family-told state: no health alert from a scam turn, a refusal is a no, an alert is remembered across turns and calls,
// a repeat incident is "already told", and the apology fact is factual. Facts and principles only (no sentence for Spark to copy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-scamtold-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async (_h, _r, _s, onDelta) => { const t = 'ok'; if (onDelta) onDelta(t); return t; } } };

const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const scam = require('../scam');
const { Call } = require('../call');
const { fixedReply } = require('../reply');

let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const fakeWs = { send() {}, close() {}, onmessage: null, onclose: null };
const calls = [];
const senior = () => { const p = memory.createProfile(`Lin${letters(n++)}`, 'female'); const c = new Call(fakeWs, 'k'); c.profile = memory.load(p.id); c.callId = 'x'; c.registered = true; calls.push(c); care.callStarted(p.id, c, null); return { id: p.id, c }; };
const active = (id) => care.get(id).flags.filter((f) => f.status === 'active' && f.safety);
const anyAlert = (id) => care.get(id).notifications.filter((x) => x.to === 'family' && x.kind === 'alert').length;
const PANIC = 'There is a man on the phone saying he is from my bank, he wants me to read out the code and transfer money now, I am going to pick up';

test('1 a scam turn never raises a health alert, even when the read says urgent', async () => {
  const { id, c } = senior();
  c.gen = 1; c.abort = new AbortController(); c.history.push({ role: 'user', content: `A: ${PANIC}` });
  assert.equal(c.inScamTurn(PANIC), true);
  await c.speakReply(fixedReply('[[feel: emotion=anxious intensity=5 intent=share concern=urgent]] Hang up now.'), null, 1, { record: true });
  assert.equal(c.health, false); assert.equal(anyAlert(id), 0); assert.equal(care.scamTold(id), null, 'and no scam alert without a yes either');
});

test('1b a real injury in the same breath is still an emergency; ordinary talk is not a scam turn', async () => {
  const { id, c } = senior();
  assert.equal(c.inScamTurn(`${PANIC}, and I fell down just now`), false);
  assert.equal(c.inScamTurn('I fell down the stairs'), false);
  assert.equal(c.inScamTurn('The garden looks lovely today'), false);
  c.gen = 1; c.abort = new AbortController(); c.history.push({ role: 'user', content: 'A: I fell down the stairs and cannot get up' });
  await c.speakReply(fixedReply('[[feel: emotion=anxious intensity=5 intent=share concern=urgent]] I am here.'), null, 1, { record: true });
  assert.equal(c.health, true); assert.equal(anyAlert(id), 1);
});

test('2 "I told you not to let my family know" is a no for the open scam question (not "unanswered")', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'bank impersonation scam', { channel: 'spoken', pause: true });
  const note = c.careNotes('I told you to not let my family know');
  assert.match(note, /NOT sending/); assert.match(note, /possible bank impersonation scam/); assert.ok(!/not answered that yet/.test(note));
  assert.equal(care.scamPending(id), null); assert.equal(care.scamTold(id), null, 'a no sends nothing');
});

test('2b a refusal after the alert already went out says so plainly: no denial, no "because I care" excuse', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'bank impersonation scam', { channel: 'spoken' }); care.scamAnswer(id, true);
  care.scamAsk(id, 'bank impersonation scam', { channel: 'spoken' });
  const note = c.careNotes("I told you not to let my family know");
  assert.match(note, /ALREADY told their family/); assert.match(note, /cannot be undone/); assert.match(note, /never deny it/); assert.match(note, /do not excuse it by saying you did it because you care/);
});

test('3 the alert stays in her facts on every later turn, across calls, until the family sees it', () => {
  const { id } = senior();
  care.scamAsk(id, 'tech support scam', { channel: 'spoken' }); care.scamAnswer(id, true);
  const c2 = new Call(fakeWs, 'k2'); c2.profile = memory.load(id); c2.callId = 'y'; calls.push(c2);
  for (const turn of ['hello again', 'what did you do', 'I told you not to']) { c2.careNotes(turn); assert.match(c2.roster(), /told their family about a possible tech support scam/); }
  const alert = care.scamTold(id); assert.ok(alert);
  assert.equal(care.markNotif(id, alert.notifId, 'seen'), true);
  assert.equal(care.scamTold(id), null, 'Seen closes it');
});

test('4 a repeat incident is "already told": no question, no new alert, and no open question left behind', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'tech support scam', { channel: 'spoken' }); care.scamAnswer(id, true);
  const v = { level: 'pause', type: 'tech support scam', signals: {}, reads: null, reading: 'x' };
  const told = scam.talkNote(v, { told: true }); const fresh = scam.talkNote(v);
  assert.match(told, /ALREADY told about a possible scam/); assert.match(told, /do NOT ask whether to tell them/); assert.ok(!/ask ONE short question/.test(told));
  assert.match(fresh, /ask ONE short question/);
  assert.match(scam.talkNote({ ...v, level: 'warn', reading: 'y' }, { told: true }), /do NOT ask whether to tell them/);
  const t = c.scamForTurn('The man is still on the phone, asking me to read out my bank code and to transfer money right now');
  return Promise.resolve(t).then((r) => { assert.equal(r.told, true); if (r.note) assert.match(r.note, /ALREADY told/); });
});

test('4b an open question is dropped once an alert exists (an unclear answer does not keep asking)', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'tech support scam', { channel: 'spoken' }); care.scamAnswer(id, true);
  care.scamAsk(id, 'tech support scam', { channel: 'spoken' });
  const note = c.careNotes('hmm, what was that about');
  assert.ok(!/not answered that yet/.test(note)); assert.equal(care.scamPending(id), null);
});

test('4c a repeat yes says the family was already told, and a typed turn gets the same already-told note', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'tech support scam', { channel: 'spoken' }); care.scamAnswer(id, true);
  care.scamAsk(id, 'tech support scam', { channel: 'spoken' });
  assert.match(c.careNotes('yes please tell my family'), /ALREADY told/);
});

test('5 the apology fact is factual: what was sent, that it cannot be undone, never denied, never excused by caring', () => {
  const { id } = senior();
  care.scamAsk(id, 'tech support scam', { channel: 'spoken' }); care.scamAnswer(id, true);
  const f = care.appFacts(id);
  assert.match(f, /only the kind of scam, no words, no photo/); assert.match(f, /cannot be undone/); assert.match(f, /never deny it/); assert.match(f, /never excuse it by saying you did it because you care/);
  assert.ok(!/earlier message/.test(f.replace(/never "an earlier message"/, '')));
});

test('6 the "is something wrong?" question is never opened on a scam turn, and its yes-words never become a family alert', async () => {
  const { id, c } = senior();
  c.gen = 1; c.abort = new AbortController(); c.history.push({ role: 'user', content: `A: ${PANIC}` });
  await c.speakReply(fixedReply('[[feel: emotion=anxious intensity=4 intent=share concern=unsure]] Hang up now.'), null, 1, { record: true });
  assert.equal(c.pendingConcern, null, 'no concern question on a scam turn');
  const note = c.careNotes('Yeah you did let them know');
  assert.ok(!/has now sent their family an alert/.test(note)); assert.equal(anyAlert(id), 0);
  assert.equal(c.health, false);
});

test('6b the follow-ups of a scam conversation (no scam words of their own) are still the scam\'s: no health alert, no concern question; a real injury still is', async () => {
  const { id, c } = senior();
  c.inScamTurn(PANIC);   // the scam turn
  assert.equal(c.inScamTurn('he is still there, what do I do'), true);
  c.gen = 1; c.abort = new AbortController(); c.history.push({ role: 'user', content: 'A: he is still there, what do I do' });
  await c.speakReply(fixedReply('[[feel: emotion=anxious intensity=5 intent=share concern=urgent]] Stay calm.'), null, 1, { record: true });
  assert.equal(c.health, false); assert.equal(anyAlert(id), 0);
  assert.equal(c.inScamTurn('I fell down and cannot get up'), false, 'an injury is never swallowed');
  c.scamAt = Date.now() - 11 * 60000; assert.equal(c.inScamTurn('he is still there'), false, 'the window closes after ten minutes');
});

test('6c outside a scam conversation the unsure question still opens as before', async () => {
  const { c } = senior();
  c.gen = 1; c.abort = new AbortController(); c.history.push({ role: 'user', content: 'A: my knee feels a bit odd today' });
  await c.speakReply(fixedReply('[[feel: emotion=worried intensity=3 intent=share concern=unsure]] Oh dear.'), null, 1, { record: true });
  assert.ok(c.pendingConcern);
});

// ---- a yes must be an answer TO MAYA (steve and roger: a false yes made a family alert) ----
const { saysYesToFamily, asksFamily } = require('../call');
test('7 yes-words that are not an answer to her question never count: caller, hand-over, past tense, question, statement', () => {
  for (const t of ['Yeah, there\'s that man calling.', 'what should I tell him?', 'Yeah you did let them know', 'Yes, I will give you my social security number', 'I will give you my Social Security number', 'Yes ok my account number is 4455', 'Yes he is still on the line', 'yes he wants me to call my son', 'I told you not to let my family know', 'no'])
    assert.equal(saysYesToFamily(t), false, t);
});

test('7b plain answers and explicit requests still count', () => {
  for (const t of ['yes', 'Yes please', 'yeah go ahead', 'please tell my family', 'Yes, tell my family', 'Yes tell them', 'okay yes', 'Yes, I think you should'])
    assert.equal(saysYesToFamily(t), true, t);
  assert.equal(asksFamily('please let my daughter know'), true); assert.equal(asksFamily('he says to call my son'), false);
});

test('7c an open scam question: talk to the caller does not make an alert; a real yes does; the old no stays a no', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'phone scam', { channel: 'spoken', pause: true });
  const n1 = c.careNotes('Yes, I will give you my Social Security number');
  assert.equal(care.scamTold(id), null, 'no alert from a line to the caller'); assert.ok(!/has now sent their family an alert/.test(n1));
  care.scamAsk(id, 'phone scam', { channel: 'spoken', pause: true });
  c.careNotes('Yeah, there\'s that man calling.'); assert.equal(care.scamTold(id), null);
  care.scamAsk(id, 'phone scam', { channel: 'spoken', pause: true });
  c.careNotes('yes please tell my family'); assert.ok(care.scamTold(id), 'a real yes still alerts');
});

test('7d the same rule guards the older "is something wrong?" yes', () => {
  const { id, c } = senior(); c.pendingConcern = { left: 2 };
  c.careNotes('Yeah, there\'s that man calling.'); assert.equal(anyAlert(id), 0);
  c.pendingConcern = { left: 2 }; c.careNotes('yes please let them know'); assert.equal(anyAlert(id), 1);
});

// ---- never ask again after a no ----
test('8 after a no on an incident she never asks again; a different kind of scam is a new incident', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'pension scam', { channel: 'spoken' });
  c.careNotes('no, do not tell them');
  assert.ok(care.scamDeclined(id, 'pension scam')); assert.equal(care.scamTold(id), null);
  assert.equal(care.scamAsk(id, 'pension scam', { channel: 'spoken', pause: true }), null, 'the same incident is not asked about again');
  assert.equal(care.scamAsk(id, 'Pension  Scam', { channel: 'text' }), null, 'however the kind is spelt');
  assert.equal(care.scamPending(id), null);
  assert.ok(care.scamAsk(id, 'tech support scam', { channel: 'spoken' }), 'a different scam is asked about as usual');
  assert.equal(care.scamDeclined(id, 'tech support scam'), null);
});

test('8b a repeat incident after a no: flag state, no question in her note, still the safety words; and a typed turn gets the same', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'pension scam', { channel: 'spoken' }); care.scamAnswer(id, false);
  const v = { level: 'pause', type: 'pension scam', signals: {}, reads: null, reading: 'x' };
  const note = scam.talkNote(v, { declined: true });
  assert.match(note, /already said NO/); assert.match(note, /do NOT ask again/); assert.ok(!/ask ONE short question/.test(note));
  assert.match(note, /not to pay or share/);
  c.scamLater = { scam: v, at: Date.now() };   // the verdict for this turn
  return Promise.resolve(c.scamForTurn('He is on the line again and wants me to read out my bank code and send money right now')).then((r) => { assert.equal(r.told, true, 'no question this turn'); if (r.note) assert.match(r.note, /already said NO/); assert.equal(care.scamPending(id), null); });
});

test('8c the no is not a yes later: nothing is sent, and her facts say nobody was told', () => {
  const { id, c } = senior();
  care.scamAsk(id, 'pension scam', { channel: 'spoken' }); care.scamAnswer(id, false);
  c.careNotes('Yeah, there\'s that man calling.'); c.careNotes('Yes, I will give you my number');
  assert.equal(care.scamTold(id), null); assert.equal(anyAlert(id), 0);
  assert.match(care.appFacts(id), /nobody was told/);
});

test('the chat borrows the same guards (health alert, already-told note)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');
  assert.match(src, /concern === 'urgent' && !this\.health && !this\.safety && !this\.inScamTurn\(lastUser\)/);
  assert.match(src, /care\.scamTold\(profileId\)/);
  assert.match(src, /concern === 'unsure'[^\n]*!this\.inScamTurn\(lastUser\)/);
});

test.after(() => { calls.forEach((c) => c.end && c.end()); chat.endAll(); care.stop(); setTimeout(() => process.exit(), 50).unref(); });
