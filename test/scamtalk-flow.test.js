// Scam shield for typed and spoken talk, end to end through the chat (no network: Spark, the scam check, the transcript and the voice are stubbed).
// The sentences below exist only in this test file. Maya's wording is Spark's; these tests check the facts, limits and family flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-scamtalk-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');

const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push({ history: JSON.parse(JSON.stringify(history)), roster }); const item = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(item); return item; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const S = require('../scam');
const realScamText = chat.deps.scamText;

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} That sounds nice. Tell me more about it.`;
const FOUR = (emotion) => `${tag({ emotion, intensity: 3, intent: 'share', concern: 'none', pain: 0 })} Please stop for a moment. Do not send anything yet. It is safest to check with the real bank yourself. Would you like me to let your family know?`;
const sentences = (t) => (t.match(/[.!?](\s|$)/g) || []).length;
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Ida${letters(n++)}`, 'female').id;
const family = () => { const ev = []; care.attachFamily({ write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } }); return ev; };
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const rd = (...on) => Object.fromEntries(S.READS.map((k) => [k, on.includes(k)]));
let calls = 0;
const verdict = (level, type = 'impersonation scam', signals = sig('impersonation', 'payment'), reads = rd()) => async () => { calls += 1; return { level, type, reading: 'Someone says they are from the bank and wants a code.', signals, reads, count: 2 }; };
const lastRoster = () => asked.at(-1).roster;
const SCAMMY = 'A lady rang from my bank and wants me to read out the code from my text.';
const spoke = [];
chat.deps.speak = async (t) => { spoke.push(t); return Buffer.alloc(9600); };

test('ordinary talk is never checked: no Spark check, no scam note, no question, no change to the reply', async () => {
  const id = senior(); calls = 0; chat.deps.scamText = verdict('warn'); reset(PLAIN);
  const r = await chat.sendText(id, 'I made some soup today and it smelled lovely.', null);
  assert.equal(calls, 0); assert.doesNotMatch(lastRoster(), /SCAM CHECK/); assert.equal(care.scamPending(id), null); assert.equal(r.scam, undefined);
});

test('warn (typed): checked before she answers, she is given facts and principles, ONE question is asked, nothing goes to the family yet, text only (no voice)', async () => {
  const id = senior(); const ev = family(); calls = 0; spoke.length = 0;
  chat.deps.scamText = verdict('warn'); reset(PLAIN);
  const r = await chat.sendText(id, SCAMMY, null);
  assert.equal(calls, 1); assert.equal(r.scam, 'warn'); assert.equal(r.messages[1].kind, 'text'); assert.equal(spoke.length, 0, 'no voice for a typed message');
  const roster = lastRoster();
  assert.match(roster, /SCAM CHECK \(a fact from the app, not from them\)/); assert.match(roster, /looks like a possible impersonation scam/);
  assert.match(roster, /never that it is certain/); assert.match(roster, /never give a number yourself/); assert.match(roster, /ONE short question: would they like you to let their family know\?/);
  assert.match(roster, /concern=none and pain=0 and never emotion=crisis/);
  assert.doesNotMatch(roster, /exact words|Use the words/i, 'principles only: no wording is dictated');
  const p = care.scamPending(id); assert.equal(p.type, 'impersonation scam'); assert.equal(p.channel, 'text'); assert.equal(p.pause, false);
  assert.equal(care.view(id).scams.length, 0, 'no ticket until they answer'); assert.equal(ev.filter((e) => e.ev === 'notify' && e.data.id === id).length, 0);
});

test('pause (about to act): a steadier note (stop, hang up, check yourself, ask family now), the pause is remembered, and the reply keeps all four sentences', async () => {
  const id = senior(); calls = 0;
  chat.deps.scamText = verdict('pause', 'gift card scam', sig('money', 'payment'), rd('aboutToAct', 'happeningNow')); reset(FOUR('anxious'));
  const r = await chat.sendText(id, 'He wants gift cards and I am going to the shop now to get them.', null);
  assert.equal(r.scam, 'pause');
  const roster = lastRoster();
  assert.match(roster, /about to act on it right now/); assert.match(roster, /Slow down: be steady, calm and brief, with no cheerfulness/); assert.match(roster, /simply hang up or say they will call back/);
  assert.match(roster, /say once, gently, why you are worried[^.]*do not nag or argue/); assert.match(roster, /let their family know now\?/);
  assert.equal(care.scamPending(id).pause, true);
  assert.equal(sentences(r.messages[1].text), 4, 'a pause is never cut short to two sentences: ' + r.messages[1].text);
});

test('caution (one sign): a gentle double-check, never called a scam, no family question, nothing remembered or sent', async () => {
  const id = senior(); chat.deps.scamText = verdict('caution', 'impersonation scam', sig('impersonation')); reset(PLAIN);
  const r = await chat.sendText(id, 'My bank texted me about a new savings rate and a code.', null);
  assert.equal(r.scam, 'caution'); assert.match(lastRoster(), /has one warning sign/); assert.match(lastRoster(), /Do not call it a scam and do not ask about telling their family/);
  assert.equal(care.scamPending(id), null); assert.equal(care.view(id).scams.length, 0);
});

test('warn then yes: one topic-only alert that says it was a typed message, no words from it, and Maya is told what was sent', async () => {
  const id = senior(); const ev = family();
  chat.deps.scamText = verdict('warn', 'bank impersonation scam'); reset(PLAIN);
  await chat.sendText(id, SCAMMY, null);
  reset(PLAIN); chat.deps.scamText = verdict('none');
  await chat.sendText(id, 'Yes please, tell my daughter', null);
  const v = care.view(id); assert.equal(v.scams.length, 1); assert.equal(v.scams[0].level, 'alert'); assert.equal(v.scams[0].channel, 'text'); assert.equal(v.scams[0].pause, false);
  const sent = ev.filter((e) => e.ev === 'notify' && e.data.id === id); assert.equal(sent.length, 1);
  assert.match(sent[0].data.text, /told Maya about a message that looks like a possible bank impersonation scam/); assert.doesNotMatch(sent[0].data.text, /lady|rang|code|text|read out/i, 'no word from what they said');
  assert.match(lastRoster(), /the app has now sent their family an alert saying only what kind of message it was/);
  assert.equal(care.scamPending(id), null);
});

test('pause then yes: the family alert says they may have been about to pay, and the dashboard facts carry the channel and the pause', async () => {
  const id = senior(); const ev = family();
  chat.deps.scamText = verdict('pause', 'gift card scam', sig('money', 'payment'), rd('aboutToAct')); reset(PLAIN);
  await chat.sendText(id, 'He wants gift cards and I am on my way to the shop right now.', null);
  reset(PLAIN); chat.deps.scamText = verdict('none');
  await chat.sendText(id, 'Yes please let my son know', null);
  const sc = care.view(id).scams[0]; assert.equal(sc.level, 'alert'); assert.equal(sc.pause, true); assert.equal(sc.channel, 'text');
  const text = ev.find((e) => e.ev === 'notify' && e.data.id === id).data.text;
  assert.match(text, /may have been about to pay or share details, so Maya asked .* to stop and check first/); assert.doesNotMatch(text, /gift cards|shop/i, 'kind of scam only: nothing from what they said');
  const fam = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8');
  assert.match(fam, /'May have been about to pay'/); assert.match(fam, /'Typed message'/); assert.match(fam, /'Told Maya'/);
});

test('warn then no: a dashboard flag only, with the channel; she does not ask again', async () => {
  const id = senior(); const ev = family();
  chat.deps.scamText = verdict('warn'); reset(PLAIN); await chat.sendText(id, SCAMMY, null);
  reset(PLAIN); chat.deps.scamText = verdict('none'); await chat.sendText(id, 'No, do not worry them', null);
  const sc = care.view(id).scams[0]; assert.equal(sc.level, 'flag'); assert.equal(sc.channel, 'text');
  assert.equal(ev.filter((e) => e.ev === 'notify' && e.data.id === id).length, 0); assert.equal(care.scamPending(id), null);
});

test('spoken (a voice note): the transcript is checked the same way, the channel is "spoken", and the answer is a voice note as before', async () => {
  const id = senior(); calls = 0; spoke.length = 0;
  chat.deps.transcribe = async () => 'A man phoned and told me to buy gift cards and not to tell my son.';
  chat.deps.scamText = verdict('warn', 'gift card scam', sig('money', 'secrecy', 'payment')); reset(PLAIN);
  const r = await chat.sendVoiceNote(id, chat.pcmToWav(Buffer.alloc(9600)), null);
  assert.equal(calls, 1); assert.equal(care.scamPending(id).channel, 'spoken'); assert.match(lastRoster(), /SCAM CHECK/); assert.equal(r.messages[1].kind, 'voice'); assert.ok(spoke.length > 0);
  reset(PLAIN); chat.deps.scamText = verdict('none'); chat.deps.transcribe = async () => 'Yes, tell my family please';
  await chat.sendVoiceNote(id, chat.pcmToWav(Buffer.alloc(9600)), null);
  const sc = care.view(id).scams[0]; assert.equal(sc.channel, 'spoken');
  assert.match(care.get(id).notifications.find((x) => x.kind === 'alert').text, /told Maya about a call or message that looks like a possible gift card scam/);
});

test('a failed check never blocks the reply and never invents a verdict; with no Meta key nothing is checked at all', async () => {
  const id = senior(); chat.deps.scamText = async () => { throw new Error('Meta Spark failed (HTTP 503)'); }; reset(PLAIN);
  const r = await chat.sendText(id, SCAMMY, null);
  assert.equal(r.messages[1].role, 'maya'); assert.equal(r.scam, undefined); assert.doesNotMatch(lastRoster(), /SCAM CHECK/); assert.equal(care.scamPending(id), null);
  const keep = process.env.META_API_KEY; delete process.env.META_API_KEY;
  try { assert.equal(await realScamText(SCAMMY), null, 'no key: no check'); } finally { if (keep) process.env.META_API_KEY = keep; }
});

test('safety comes first: nothing is checked while a safety alert is active or when the words themselves are about self-harm; a pending question is answered, not re-asked', async () => {
  calls = 0; chat.deps.scamText = verdict('warn');
  const a = senior(); care.selfHarmAlert(a); reset(PLAIN);
  await chat.sendText(a, SCAMMY, null); assert.equal(calls, 0, 'an active safety alert');
  const b = senior(); reset(PLAIN);
  await chat.sendText(b, 'I do not want to live anymore and a man asked me for gift cards.', null); assert.equal(calls, 0, 'self-harm words');
  const c = senior(); reset(PLAIN); await chat.sendText(c, SCAMMY, null); assert.equal(calls, 1);
  reset(PLAIN); await chat.sendText(c, 'He also said I must not tell my son about the code.', null); assert.equal(calls, 1, 'a pending question: no second check');
});

test('the note is principles and facts only, and the shared module stays pure', () => {
  for (const level of ['warn', 'pause', 'caution']) {
    const t = S.talkNote({ level, type: 'prize scam', reading: 'x', signals: sig('money'), reads: rd('remoteAccess') });
    assert.doesNotMatch(t, /exact words|"this looks like|please don't pay/i, level); assert.doesNotMatch(t, /\d{3}[- ]\d{3,4}/, 'no phone numbers'); assert.match(t, /a request to install something, give control of a device, or read out a code/);
  }
  assert.equal(S.talkNote({ level: 'none' }), ''); assert.equal(S.talkNote(null), '');
});
