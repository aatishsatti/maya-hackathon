// Written chat, voice notes, photos, orb levels and call view states. No network: Spark, Transcribe, vision and the voice
// are stubbed. MAYA_REAL_SPARK=1 additionally runs the one live Meta vision check (needs META_API_KEY in .env).
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-chat-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const REAL = process.env.MAYA_REAL_SPARK === '1';

// Spark stub. Each queued item is a string or a function(history, roster) -> string; the last one repeats.
const queue = [];
const asked = []; // { history, roster } of every Spark request
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => {
    asked.push({ history: JSON.parse(JSON.stringify(history)), roster });
    const item = queue.length > 1 ? queue.shift() : queue[0];
    const text = typeof item === 'function' ? item(history, roster) : item;
    if (text instanceof Error) throw text;
    if (onDelta) onDelta(text);
    return text;
  },
} };

const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const { MayaOrbLevels, MayaCallState } = require('../public/app.js');
const { MayaWav } = require('../public/chat-client.js');

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} That sounds like a nice quiet afternoon. I am glad you told me.`;
const PAIN1 = `${tag({ emotion: 'neutral', intensity: 2, intent: 'share', concern: 'none', pain: 1 })} That sounds uncomfortable, and I am sorry it is bothering you today.`;
const PAIN2 = `${tag({ emotion: 'anxious', intensity: 3, intent: 'share', concern: 'unsure', pain: 1 })} I am sorry it has come back again. How bad is it, and would you like me to let your family know?`;
const FALL = `${tag({ emotion: 'anxious', intensity: 4, intent: 'share', concern: 'urgent', pain: 1 })} Oh no, I am so sorry. I am letting your family know right now, and I am here with you.`;
let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const newSenior = (name) => memory.createProfile(name || `Rosa${letters(n++)}`, 'female').id;
function family() {
  const ev = [];
  care.attachFamily({ write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } });
  return ev;
}
function seniorPage(id) {
  const ev = [];
  care.attachSenior(id, { write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } });
  return ev;
}
const alertsFor = (id) => care.get(id).notifications.filter((x) => x.to === 'family' && x.kind === 'alert');
const activeSafety = (id) => care.get(id).flags.filter((f) => f.safety && f.status === 'active');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const famAll = family();

// ------------------------------------------------------------------------------------------ 1 text chat

test('text: "I fell" alerts the family at once, topic-only, once; the reply is plain text', async () => {
  const id = newSenior();
  reset(FALL);
  const r = await chat.sendText(id, 'I fell in the kitchen and I cannot get up', 'Europe/London');
  const [you, maya] = r.messages;
  assert.equal(you.role, 'senior'); assert.equal(maya.role, 'maya'); assert.equal(maya.kind, 'text');
  assert.ok(!/\[\[|\]\]/.test(maya.text), 'private tags never reach the person');
  const alerts = alertsFor(id);
  assert.equal(alerts.length, 1, 'one alert, immediately');
  assert.ok(!/fell|kitchen|get up/i.test(alerts[0].text), 'topic only: none of their words');
  assert.match(alerts[0].text, /chat/i, 'the family is told Maya is in the chat, not on a call');
  assert.equal(activeSafety(id).length, 1, 'the same ticket the voice call uses');
  assert.ok(famAll.some((e) => e.ev === 'notify' && e.data.id === id && e.data.kind === 'alert'), 'pushed to the family page');
  // A second urgent message is the same incident: no second alert, no second ticket.
  reset(FALL);
  await chat.sendText(id, 'it really hurts, please help', 'Europe/London');
  assert.equal(alertsFor(id).length, 1);
  assert.equal(activeSafety(id).length, 1);
  assert.match(asked[0].roster, /emergency, and the app has just alerted|already been alerted/i, 'Maya is told the alert as a fact');
});

test('text: self-harm words alert before any reply is written, and the reply gets the safety note', async () => {
  const id = newSenior();
  reset(`${tag({ emotion: 'sad', intensity: 4, intent: 'share', concern: 'none', pain: 0 })} That sounds so heavy. I am staying right here with you. Are you safe right now?`);
  await chat.sendText(id, 'I want to end my life', null);
  assert.equal(activeSafety(id).length, 1);
  assert.equal(alertsFor(id).length, 1);
  assert.match(asked[0].roster, /SAFETY \(instructions for you/);
  assert.ok(!/end my life/i.test(alertsFor(id)[0].text));
});

test('text: Spark reads crisis before saying anything -> safety path, reply written again with the safety note', async () => {
  const id = newSenior();
  reset(`${tag({ emotion: 'crisis', intensity: 5, intent: 'share', concern: 'none', pain: 0 })} placeholder`,
    `${tag({ emotion: 'sad', intensity: 4, intent: 'share', concern: 'none', pain: 0 })} I hear how much pain you are in. I am here and I am not going anywhere.`);
  const r = await chat.sendText(id, 'nothing matters to me any more', null);
  assert.equal(activeSafety(id).length, 1);
  assert.equal(asked.length, 2);
  assert.match(asked[1].roster, /SAFETY \(instructions for you/);
  assert.ok(!/placeholder/.test(r.messages[1].text));
});

test('text: a no with family named stays a no (negation), is kept for the whole chat, and a later urgent read still alerts', async () => {
  const id = newSenior(); const sentCount = () => care.get(id).notifications.filter((x) => x.to === 'family').length;
  reset(PAIN2); await chat.sendText(id, 'my knee is hurting again', null);
  reset(PAIN1); await chat.sendText(id, 'No, please do not tell my family', null);
  assert.equal(sentCount(), 0, '"please do not tell my family" is not a yes');
  reset(PAIN2); await chat.sendText(id, 'the knee hurts again', null);
  assert.match(asked[0].roster, /told you no to letting their family know/);
  reset(PAIN1); await chat.sendText(id, 'I said do not alert my family', null);
  assert.equal(sentCount(), 0);
  reset(FALL); await chat.sendText(id, 'I fell and cannot get up', null);
  assert.equal(activeSafety(id).length, 1, 'urgent still alerts');
  const id2 = newSenior();
  reset(PLAIN); await chat.sendText(id2, 'I told you specifically do not tell my son', null);
  assert.equal(care.get(id2).notifications.filter((x) => x.to === 'family').length, 0, 'a refusal with no question open sends nothing');
});

test('text: what they said earlier in the chat is in her notes for a "do you remember" ask, and only then', async () => {
  const id = newSenior();
  reset(PLAIN); await chat.sendText(id, 'my grandson Toby called today', null);
  for (let k = 0; k < 8; k++) { reset(PLAIN); await chat.sendText(id, `just having tea number ${k}`, null); }
  assert.doesNotMatch(asked[0].roster, /Toby/);
  reset(PLAIN); await chat.sendText(id, 'you remember his name?', null);
  assert.match(asked[0].roster, /WHAT THEY TOLD YOU EARLIER IN THIS CONVERSATION/); assert.match(asked[0].roster, /grandson Toby/);
});

test('text: "remind me next time I call that I need to call my grandson" is kept as a next-call reminder, and she is not left to say she cannot', async () => {
  const id = newSenior();
  reset(PLAIN); await chat.sendText(id, 'Can you remind me the next time that I call you that I need to call my grandson?', null);
  const r = memory.load(id).memory.threads.filter((t) => t.kind === 'reminder');
  assert.equal(r.length, 1); assert.equal(r[0].text, 'I need to call my grandson'); assert.equal(r[0].status, 'open');
  assert.match(asked[0].roster, /The app keeps it and will bring it to you at the start of their next call/); assert.match(asked[0].roster, /Do not say you cannot do it/);
  reset(PLAIN); await chat.sendText(id, 'Remind me in 5 minutes to call him', null);
  assert.match(asked[0].roster, /only remind them during a voice call/, 'a timed ask in chat is still the timer answer');
  assert.equal(memory.load(id).memory.threads.filter((t) => t.kind === 'reminder').length, 1);
});

test('text: plain pain follows the ladder: first no alert, repeat asks, yes alerts; severe asks at once; fall alerts', async () => {
  const id = newSenior();
  const flagsBefore = () => care.get(id).flags.length + alertsFor(id).length;
  // (1) first plain mention: no alert, counted, Maya told "not mentioned before"
  reset(PAIN1);
  await chat.sendText(id, 'my knee is a bit stiff today', null);
  assert.equal(flagsBefore(), 0);
  assert.match(asked[0].roster, /not mentioned pain or discomfort in the last 3 days/);
  assert.equal(care.painCount(id), 1);
  // (2) the same again: Maya is told it came up before; she asks, nothing is sent yet
  reset(PAIN2);
  const r2 = await chat.sendText(id, 'my knee is hurting again', null);
  assert.match(asked[0].roster, /mentioned pain or discomfort 1 time before this turn/);
  assert.equal(flagsBefore(), 0, 'asking is not alerting');
  assert.match(r2.messages[1].text, /let your family know\?/);
  // (2b) "no" -> never an alert; the answer is taken at its word
  reset(PLAIN);
  await chat.sendText(id, 'no, it is fine, thank you', null);
  assert.equal(alertsFor(id).length, 0);
  assert.match(asked[0].roster, /said it is fine or normal\. No alert was made/);
  // (3) a fresh severe case: asks right away; "yes please" sends the topic-only alert (not an emergency ticket)
  const id2 = newSenior();
  reset(`${tag({ emotion: 'anxious', intensity: 4, intent: 'share', concern: 'unsure', pain: 1 })} I am so sorry, that sounds like a lot of pain. Would you like me to let your family know?`);
  await chat.sendText(id2, 'my chest feels very tight, it is too much, I cannot move', null);
  assert.equal(alertsFor(id2).length, 0, 'asked first, no alert before the answer');
  reset(PLAIN);
  await chat.sendText(id2, 'yes please tell them', null);
  assert.equal(alertsFor(id2).length, 1);
  assert.match(asked[0].roster, /the app has now sent their family an alert/);
  assert.equal(activeSafety(id2).length, 0, 'a yes after a question is a topic-only alert, not the emergency ticket');
  // (4) a fall is urgent with no asking: covered in the first test
});

test('text: no separate memory and no leak between profiles', async () => {
  const a = newSenior('Ada'), b = newSenior('Bea');
  memory.load(a).memory.people.push({ name: 'Zorbo', relationship: 'dog', birthday: null, stories: [] });
  reset(PLAIN);
  await chat.sendText(a, 'My secret word is pomegranate and my knee hurts', null);
  const aReq = asked.length;
  await chat.sendText(b, 'Hello there', null);
  const forB = asked.slice(aReq);
  assert.ok(forB.length >= 1);
  for (const q of forB) {
    assert.ok(!/Zorbo/.test(q.roster), "A's memory never reaches B");
    assert.ok(!JSON.stringify(q.history).includes('pomegranate'), "A's words never reach B");
    assert.match(q.roster, /Bea/);
  }
  assert.ok(asked.slice(0, aReq).some((q) => /Zorbo/.test(q.roster)), "A's own memory is what A's chat uses");
  assert.equal(care.painCount(b), 0);
  // The words go to the profile's own pending file (the same file calls use), and to nobody else's.
  const pend = (id) => { try { return fs.readFileSync(path.join(process.env.MAYA_DATA_DIR, `${id}.pending.jsonl`), 'utf8'); } catch { return ''; } };
  assert.match(pend(a), /pomegranate/);
  assert.ok(!/pomegranate/.test(pend(b)));
  assert.deepEqual(care.get(b).flags, []);
});

test('text: family Seen reaches the person in the chat, once, in fresh words', async () => {
  const id = newSenior();
  const page = seniorPage(id);
  reset(FALL);
  await chat.sendText(id, 'I fell and hurt my head', null);
  const notif = alertsFor(id)[0];
  reset('Your family has seen the worry and they know now. Someone will be checking on you, and I am right here.');
  care.markNotif(id, notif.id, 'seen');
  await sleep(100);
  assert.equal(activeSafety(id).length, 0, 'the ticket closes on Seen');
  const t = chat.thread(id);
  const last = t[t.length - 1];
  assert.equal(last.role, 'maya'); assert.ok(last.unprompted); assert.match(last.text, /family/i);
  assert.ok(page.some((e) => e.ev === 'chat' && e.data.message.id === last.id), 'pushed to the open app');
  care.markNotif(id, notif.id, 'seen'); // marking again says nothing again
  await sleep(50);
  assert.equal(chat.thread(id).length, t.length);
});

test('text: a timer cannot be set in a chat and Maya is told so (no pretend timer)', async () => {
  const id = newSenior();
  reset(PLAIN);
  await chat.sendText(id, 'remind me in 5 minutes to take the washing out', null);
  assert.match(asked[0].roster, /In this written chat you cannot set one/);
  assert.ok(!/A timer is set for it right now/.test(asked[0].roster));
});

test('text: Spark failure is an error, never a faked reply, and does not poison the next turn', async () => {
  const id = newSenior();
  reset(new Error('Meta Spark failed (HTTP 500)'));
  await assert.rejects(chat.sendText(id, 'hello', null), /Meta Spark failed/);
  assert.ok(chat.thread(id).every((m) => m.role !== 'maya'), 'no Maya bubble was invented');
  reset(PLAIN);
  await chat.sendText(id, 'are you there?', null);
  assert.equal(asked[0].history.filter((m) => m.role === 'user').length, 1, 'the failed message is not in the next request');
});

test('text: a failed chat turn leaves a due next-call reminder undelivered; the next good reply carries it and delivers it once', async () => {
  const id = newSenior();
  assert.equal(memory.addReminder(id, 'call my grandson', 'a-call-from-before').status, 'added');
  const asked1 = () => memory.load(id).memory.threads.find((t) => t.kind === 'reminder').asked;
  reset(new Error('Meta Spark failed (HTTP 500)'));
  await assert.rejects(chat.sendText(id, 'hello there my friend', null), /Meta Spark failed/);
  assert.match(asked[0].roster, /REMINDER THEY ASKED YOU FOR/, 'it was handed to Spark for the failed reply');
  assert.equal(asked1(), 0, 'a failed reply does not count as delivered');
  reset(PLAIN); await chat.sendText(id, 'hello again my friend', null);
  assert.match(asked[0].roster, /REMINDER THEY ASKED YOU FOR/); assert.match(asked[0].roster, /call my grandson/);
  assert.equal(asked1(), 1, 'the reply that went out delivered it');
  reset(PLAIN); await chat.sendText(id, 'what a nice afternoon it is', null);
  assert.doesNotMatch(asked[0].roster, /REMINDER THEY ASKED YOU FOR/, 'not repeated');
});

const sentencesOf = (t) => (t.match(/[.!?](\s|$)/g) || []).length;
const CRISISQ = `${tag({ emotion: 'crisis', intensity: 5, intent: 'share', concern: 'none', pain: 0 })} I am here with you. Are you alone right now? How are you feeling? Is anyone with you right now?`;

test('text: a bare yes gets one short line in the chat too; a real sentence keeps its length', async () => {
  const id = newSenior();
  const LONGR = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} That sounds lovely. I think it is a great plan. We can take our time with it. Tell me more.`;
  reset(LONGR); const r = await chat.sendText(id, "Yeah okay, let's do that", null);
  assert.equal(sentencesOf(r.messages[1].text), 1, r.messages[1].text); assert.match(asked[0].roster, /ONE short line/);
  reset(LONGR); const r2 = await chat.sendText(id, 'I went to the market today and bought some lovely vegetables.', null);
  assert.ok(sentencesOf(r2.messages[1].text) >= 2);
});

test('text: second self-harm message in the chat is told which questions she already asked; one alert', async () => {
  const id = newSenior();
  reset(CRISISQ); await chat.sendText(id, "I'm tired of being alone. I'm going to hang myself.", null);
  assert.equal(activeSafety(id).length, 1);
  reset(CRISISQ); await chat.sendText(id, 'I really mean it.', null);
  assert.match(asked[0].roster, /ALREADY asked about: whether they are alone or someone is with them; how they are feeling/); assert.match(asked[0].roster, /more than once in this call/);
  assert.equal(activeSafety(id).length, 1);
});

test('text: after the family presses Seen, the next message is answered with a fact that their family knows, once', async () => {
  const id = newSenior();
  const r = care.selfHarmAlert(id, { channel: 'chat' }); care.markNotif(id, r.flag.notifId, 'seen');
  reset(PLAIN); await chat.sendText(id, 'hello again', null);
  assert.match(asked[0].roster, /their family has seen the alert about them and knows/);
  reset(PLAIN); await chat.sendText(id, 'and now?', null);
  assert.doesNotMatch(asked[0].roster, /their family has seen the alert about them and knows/);
});

// ------------------------------------------------------------------------------------------ 2 voice notes

const wavOf = (ms = 500) => chat.pcmToWav(Buffer.alloc(ms * 48), 24000);
function stubVoice(words, pcm = Buffer.alloc(24000 * 2, 3)) {
  const spoke = [];
  chat.deps.transcribe = async () => words;
  chat.deps.speak = async (text) => { spoke.push(text); return pcm; };
  return spoke;
}

test('voice note: Transcribe -> brain -> ElevenLabs -> playable voice bubble, audio kept only in the media folder', async () => {
  const id = newSenior();
  const spoke = stubVoice('I had tea with my sister today');
  reset(PLAIN);
  const r = await chat.sendVoiceNote(id, wavOf(), 'Europe/London');
  const [you, maya] = r.messages;
  assert.equal(you.kind, 'voice'); assert.equal(you.text, 'I had tea with my sister today');
  assert.equal(maya.kind, 'voice'); assert.ok(maya.text.length > 10);
  assert.match(asked[0].history.at(-1).content, /Speaker A: I had tea with my sister today/, 'the brain got the transcript');
  assert.match(asked[0].roster, /voice note/);
  assert.ok(spoke.length >= 1);
  for (const url of [you.mediaUrl, maya.mediaUrl]) {
    const m = /^\/api\/chat\/([a-f0-9]{8})\/media\/([a-f0-9]{16}\.wav)$/.exec(url);
    assert.ok(m && m[1] === id, url);
    const f = chat.readMedia(m[1], m[2]);
    assert.equal(f.type, 'audio/wav'); assert.ok(chat.isWav(f.data));
    assert.ok(fs.existsSync(path.join(process.env.MAYA_MEDIA_DIR, id, m[2])), 'stored in the media folder');
  }
  assert.equal(chat.readMedia(newSenior(), /([a-f0-9]{16}\.wav)$/.exec(maya.mediaUrl)[1]), null, "another profile cannot open this person's audio");
  assert.equal(chat.readMedia(id, '../../etc/passwd'), null);
});

test('voice note: same safety as a call — a fall in a voice note alerts the family at once', async () => {
  const id = newSenior();
  stubVoice('I fell and I cannot get up');
  reset(FALL);
  await chat.sendVoiceNote(id, wavOf(), null);
  assert.equal(alertsFor(id).length, 1);
  assert.equal(activeSafety(id).length, 1);
  assert.ok(!/fell/i.test(alertsFor(id)[0].text));
});

test('voice note: the same voice tone as a call (ElevenLabs tag + gain per delivery piece)', async () => {
  const id = newSenior();
  const spoke = stubVoice('my husband passed away last year');
  reset(`${tag({ emotion: 'grief', intensity: 4, intent: 'share', concern: 'none', pain: 0 })} I am so sorry for your loss. That must be very hard.`);
  await chat.sendVoiceNote(id, wavOf(), null);
  assert.match(spoke[0], /^\[sympathetic\] /, 'a heavy-hearted person gets the soft opening tone, as on a call');
});

test('voice note: while a call is live the reply is text only (no second voice)', async () => {
  const id = newSenior();
  const spoke = stubVoice('good morning Maya');
  reset(PLAIN);
  care.liveCalls.set(id, {});
  try {
    const r = await chat.sendVoiceNote(id, wavOf(), null);
    assert.equal(r.messages[1].kind, 'text');
    assert.equal(r.voice, 'suppressed-call-live');
    assert.equal(spoke.length, 0, 'ElevenLabs was never asked');
  } finally { care.liveCalls.delete(id); }
});

test('voice note: silence, wrong format and a failed voice are all honest errors', async () => {
  const id = newSenior();
  stubVoice('');
  reset(PLAIN);
  await assert.rejects(chat.sendVoiceNote(id, wavOf(), null), (e) => e.status === 422 && /could not hear any words/.test(e.message));
  assert.equal(asked.length, 0, 'the brain was not called for silence');
  await assert.rejects(chat.sendVoiceNote(id, Buffer.from('not audio at all, definitely longer than forty-four bytes of text'), null), (e) => e.status === 415);
  stubVoice('hello Maya');
  chat.deps.speak = async () => { throw new Error('ElevenLabs failed (HTTP 401)'); };
  const r = await chat.sendVoiceNote(id, wavOf(), null);
  assert.equal(r.messages[1].kind, 'text'); assert.match(r.messages[1].voiceError, /voice failed.*401/);
  chat.deps.transcribe = async () => { throw new Error('Meta Transcribe failed (HTTP 429)'); };
  await assert.rejects(chat.sendVoiceNote(id, wavOf(), null), /Meta Transcribe failed/);
});

test('voice note: audio and photos go only under data/media, which git ignores', () => {
  execFileSync('git', ['check-ignore', '-q', 'data/media/abcd1234/0123456789abcdef.wav'], { cwd: path.join(__dirname, '..') });
  execFileSync('git', ['check-ignore', '-q', 'data/media/abcd1234/0123456789abcdef.jpg'], { cwd: path.join(__dirname, '..') });
});

// ------------------------------------------------------------------------------------------ 3 photos

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('image: vision description -> brain -> bubble with the image and Maya\'s reply; stored in the media folder', async () => {
  const id = newSenior();
  let seenMime = null;
  chat.deps.describe = async (buf, mime) => { seenMime = mime; return 'A cup of tea on a table next to a plate with two biscuits.'; };
  reset(PLAIN);
  const r = await chat.sendImage(id, PNG, 'my afternoon tea', null);
  assert.equal(seenMime, 'image/png');
  const [you, maya] = r.messages;
  assert.equal(you.kind, 'image'); assert.match(you.mediaUrl, /\.png$/); assert.equal(you.text, 'my afternoon tea');
  assert.equal(maya.kind, 'text');
  assert.match(asked[0].history.at(-1).content, /photo shows: A cup of tea/);
  assert.match(asked[0].roster, /sent you a photo/);
  const m = /\/media\/([a-f0-9]{16}\.png)$/.exec(you.mediaUrl);
  assert.equal(chat.readMedia(id, m[1]).type, 'image/png');
  assert.ok(fs.existsSync(path.join(process.env.MAYA_MEDIA_DIR, id, m[1])));
});

test('image: not a photo, or vision failing, is an honest error and the brain is not asked', async () => {
  const id = newSenior();
  reset(PLAIN);
  await assert.rejects(chat.sendImage(id, Buffer.from('%PDF-1.4 not an image'), '', null), (e) => e.status === 415);
  chat.deps.describe = async () => { throw new Error('Meta vision failed (HTTP 400)'); };
  await assert.rejects(chat.sendImage(id, PNG, '', null), /Meta vision failed/);
  assert.equal(asked.length, 0);
});

test('image: the words typed with a photo still follow the safety rules (a fall caption alerts)', async () => {
  const id = newSenior();
  chat.deps.describe = async () => 'A bruised knee with a graze.';
  reset(FALL);
  await chat.sendImage(id, PNG, 'I fell down the stairs', null);
  assert.equal(alertsFor(id).length, 1);
});

test('image: LIVE Meta vision check (Chat Completions image_url on muse-spark-1.3)', { skip: REAL ? false : 'set MAYA_REAL_SPARK=1 (needs META_API_KEY)' }, async () => {
  // Needs the real brain module; this file stubs it, so the check calls the endpoint directly with the documented shape.
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* env may be set already */ }
  const zlib = require('node:zlib');
  const W = 96, raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; const left = x < W / 2; raw[o] = left ? 0 : 255; raw[o + 1] = left ? 0 : 220; raw[o + 2] = left ? 255 : 0; }
  const crcT = Array.from({ length: 256 }, (_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let r = 0xffffffff; for (const x of b) r = crcT[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const r = await fetch('https://api.meta.ai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.META_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'muse-spark-1.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the colors in this image in one short sentence.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] }], reasoning_effort: 'minimal', max_completion_tokens: 2000 }) });
  assert.equal(r.status, 200);
  const text = (await r.json()).choices[0].message.content.toLowerCase();
  assert.match(text, /blue/); assert.match(text, /yellow/);
});

// ------------------------------------------------------------------------------------------ 4 orb levels

test('orb levels: loudness maps to 0..1, silence to 0, loud to 1', () => {
  const L = MayaOrbLevels;
  assert.equal(L.normalize(0), 0); assert.equal(L.normalize(-1), 0); assert.equal(L.normalize(NaN), 0);
  assert.equal(L.normalize(0.001), 0, '-60 dB is below the floor');
  assert.equal(L.normalize(0.5), 1, 'above the ceiling');
  const mid = L.normalize(0.03);
  assert.ok(mid > 0.3 && mid < 0.8, `speech-level mic is in the middle: ${mid}`);
  assert.ok(L.normalize(0.06) > L.normalize(0.03), 'louder is higher');
});

test('orb levels: rises fast, falls slowly, never overshoots', () => {
  const L = MayaOrbLevels;
  const up = L.smooth(0, 1, 80), down = L.smooth(1, 0, 80);
  assert.ok(up > 0.6 && up < 1, `attack: ${up}`);
  assert.ok(down > 0.7 && down < 1, `release is slower: ${down}`);
  let v = 0; for (let i = 0; i < 200; i++) v = L.smooth(v, 0.4, 16);
  assert.ok(Math.abs(v - 0.4) < 0.001);
  assert.equal(L.smooth(0.5, 0.5, 16), 0.5); assert.equal(L.smooth(0.2, 0.9, -5), 0.2);
});

test('orb levels: level -> water raise and swell speed, inside the circle; silence breathes slowly', () => {
  const L = MayaOrbLevels;
  const loud = L.frame(1, 0), quiet = L.frame(0, 0);
  assert.equal(loud.raise, L.MAX_RAISE); assert.equal(loud.rate, L.MAX_RATE);
  assert.ok(L.frame(0.5, 0).raise > quiet.raise && L.frame(0.5, 0).rate > quiet.rate);
  assert.equal(L.frame(5, 0).raise, L.MAX_RAISE, 'clamped');
  // Silent: a slow breath, small and below natural speed, period BREATH_MS, never louder than speech.
  const samples = Array.from({ length: 61 }, (_, i) => L.frame(0, (i * L.BREATH_MS) / 60));
  const raises = samples.map((s) => s.raise);
  assert.ok(Math.max(...raises) <= L.BREATH_RAISE + 1e-9 && Math.min(...raises) === 0);
  assert.ok(samples.every((s) => s.rate < 1), 'breathing is slower than the natural swell');
  assert.ok(Math.abs(samples[0].raise - samples[60].raise) < 1e-9, 'one breath per BREATH_MS');
  assert.ok(L.BREATH_MS >= 4000, 'slow');
});

test('orb levels: who drives the orb (Maya playback, the person\'s mic, nothing when muted/thinking/idle)', () => {
  const s = (o) => MayaOrbLevels.source(o);
  assert.equal(s({ state: 'speaking', hearing: false, muted: false }), 'playback');
  assert.equal(s({ state: 'listening', hearing: true, muted: false }), 'mic');
  assert.equal(s({ state: 'listening', hearing: true, muted: true }), 'none', 'muted: Maya cannot hear, so the orb does not follow the mic');
  assert.equal(s({ state: 'listening', hearing: false, muted: false }), 'none');
  assert.equal(s({ state: 'thinking', hearing: false, muted: false }), 'none');
  assert.equal(s({ state: 'idle', hearing: false, muted: false }), 'none');
});

test('orb levels: the speaking pulse exists for mock mode only; real mode always follows a real reading', () => {
  const L = MayaOrbLevels;
  // mock mode, no audio node: a slow pulse, in a calm band, that moves (so it is not just breathing, and not flat)
  const pulses = Array.from({ length: 60 }, (_, i) => L.target({ src: 'playback', mode: 'mock', hasAnalyser: false, playRms: 0, micRms: 0, tMs: i * (L.MOCK_PULSE_MS / 60) }));
  assert.ok(Math.min(...pulses) >= 0.29 && Math.max(...pulses) <= 0.56 && Math.max(...pulses) - Math.min(...pulses) > 0.2);
  assert.ok(L.MOCK_PULSE_MS >= 1200, 'slow');
  assert.ok(L.frame(Math.min(...pulses), 0).raise > L.BREATH_RAISE, 'a speaking pulse sits above the silent breathing');
  // real mode: a real playback reading is used as read, never replaced by the pulse
  const real = L.target({ src: 'playback', mode: 'real', hasAnalyser: true, playRms: 0.03, micRms: 0.5, tMs: 123 });
  assert.equal(real, L.normalize(0.03));
  assert.equal(L.target({ src: 'playback', mode: 'real', hasAnalyser: true, playRms: 0, micRms: 0, tMs: 456 }), 0, 'real silence stays silent, no pulse');
  assert.equal(L.target({ src: 'playback', mode: 'real', hasAnalyser: false, playRms: 0, micRms: 0, tMs: 789 }), 0, 'real mode without a reading is 0, never synthetic');
  assert.equal(L.target({ src: 'mic', mode: 'mock', hasAnalyser: false, playRms: 0, micRms: 0.03, tMs: 1 }), L.normalize(0.03), 'the mic is always a real reading');
  assert.equal(L.target({ src: 'none', mode: 'mock', hasAnalyser: false, playRms: 0, micRms: 0, tMs: 1 }), 0);
});

test('orb levels: app.js changes only the orb for this (no pain, ticket, memory or call logic in the browser file)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/painMention|healthAlert|selfHarm|memory\./.test(src));
});

// ------------------------------------------------------------------------------------------ 5 call view states

test('call states: ended -> full -> minimized -> full -> ended, with what each shows', () => {
  const seen = [];
  const c = new MayaCallState((s) => seen.push(s.state));
  assert.equal(c.state, 'ended'); assert.equal(c.chatVisible, true); assert.equal(c.callButton, true); assert.equal(c.orb, 'none'); assert.equal(c.micOpen, false);
  c.start();
  assert.equal(c.state, 'full'); assert.equal(c.chatVisible, false, 'full: chat hidden'); assert.equal(c.orb, 'big'); assert.equal(c.callButton, false); assert.equal(c.micOpen, true);
  c.minimize();
  assert.equal(c.state, 'minimized'); assert.equal(c.chatVisible, true); assert.equal(c.orb, 'small'); assert.equal(c.micOpen, true, 'call is live');
  c.expand();
  assert.equal(c.state, 'full'); assert.equal(c.chatVisible, false);
  c.end();
  assert.equal(c.state, 'ended'); assert.equal(c.chatVisible, true); assert.equal(c.callButton, true);
  assert.deepEqual(seen, ['full', 'minimized', 'full', 'ended']);
});

test('call states: mute keeps the call live and Maya deaf; minimizing or expanding a muted call keeps it muted', () => {
  const c = new MayaCallState();
  c.start(); c.minimize(); c.mute();
  assert.equal(c.state, 'muted'); assert.equal(c.live, true); assert.equal(c.micOpen, false); assert.equal(c.orb, 'small'); assert.equal(c.chatVisible, true);
  c.expand();
  assert.equal(c.state, 'muted', 'expanding keeps it muted'); assert.equal(c.orb, 'big'); assert.equal(c.chatVisible, false); assert.equal(c.micOpen, false);
  c.minimize();
  assert.equal(c.state, 'muted'); assert.equal(c.orb, 'small'); assert.equal(c.micOpen, false);
  c.unmute(); assert.equal(c.state, 'minimized'); assert.equal(c.micOpen, true);
  c.mute(); c.end();
  assert.equal(c.state, 'ended'); assert.equal(c.muted, false, 'a new call starts un-muted');
  c.start(); assert.equal(c.state, 'full'); assert.equal(c.micOpen, true);
});

test('call states: nothing happens when there is no call', () => {
  const c = new MayaCallState();
  c.minimize(); c.expand(); c.mute(); c.unmute();
  assert.equal(c.state, 'ended'); assert.equal(c.muted, false);
});

test('call states: while live, typing and voice notes get text only; when it ends, one thread continues', async () => {
  const c = new MayaCallState();
  assert.equal(c.typedReply, 'text'); assert.equal(c.voiceNoteReply, 'voice');
  c.start(); c.minimize();
  assert.equal(c.typedReply, 'text-only'); assert.equal(c.voiceNoteReply, 'text-only');
  // The server enforces it too (voice note while a call is live: covered above). One thread across the call:
  const id = newSenior();
  reset(PLAIN);
  await chat.sendText(id, 'hello before the call', null);
  care.liveCalls.set(id, {});
  await chat.sendText(id, 'typing during the call', null);
  assert.equal(chat.thread(id).at(-1).kind, 'text', 'typing during a call: a text reply, no voice');
  care.liveCalls.delete(id);
  await chat.sendText(id, 'and after the call', null);
  assert.equal(chat.thread(id).filter((m) => m.role === 'senior').length, 3, 'the same thread before, during and after');
  c.end();
  assert.equal(c.typedReply, 'text');
});

test('call states: the server pauses silence timers while muted (a muted call is not hung up)', () => {
  const { Call } = require('../call');
  const sent = [];
  const ws = { send: (x) => sent.push(x), close() {}, onmessage: null, onclose: null };
  const call = new Call(ws, 'k');
  call.profile = { id: 'x' };
  call.onBrowserMessage({ type: 'mute', on: true });
  assert.equal(call.muted, true);
  call.armSilence();
  assert.equal(call.silenceTimer, null, 'no silence countdown while muted');
  call.end();
});

// ------------------------------------------------------------------------------------------ voice-note WAV in the browser

test('browser WAV: 24 kHz mono 16-bit, resampled from the recorder rate', () => {
  const f = new Float32Array(48000).map((_, i) => Math.sin(i / 20) * 0.5);
  const out = MayaWav.resample(f, 48000);
  assert.equal(out.length, 24000);
  const wav = Buffer.from(MayaWav.encode(out));
  assert.ok(chat.isWav(wav));
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 24000 * 2);
  assert.equal(MayaWav.resample(out, 24000), out);
});

test.after(() => { chat.endAll(); setTimeout(() => process.exit(), 50).unref(); });
