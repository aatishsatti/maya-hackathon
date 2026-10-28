// Scam shield, end to end through the chat (no network: Spark, vision, the scam check and the voice are stubbed).
// photo -> check -> Maya reads it aloud and asks ONE question -> yes: topic-only alert / no: dashboard flag only, no nagging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-scamflow-'));
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

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} Thank you for showing me that. I am glad you did.`;
const FALL = `${tag({ emotion: 'anxious', intensity: 4, intent: 'share', concern: 'urgent', pain: 1 })} Oh no, I am so sorry. I am letting your family know right now.`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const LETTER = /lottery|winner|wire the|gift card|bank account|\$\d|transcript/i;
let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Edna${letters(n++)}`, 'female').id;
const family = () => { const ev = []; care.attachFamily({ write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } }); return ev; };
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const sig = (...on) => Object.fromEntries(['urgency', 'money', 'impersonation', 'secrecy', 'payment'].map((k) => [k, on.includes(k)]));
const check = (level, type = 'prize scam', ...on) => async () => ({ level, type, reading: 'A letter says you won a prize and must pay a fee to claim it.', signals: sig(...on), count: on.length });
const spoke = [];
chat.deps.describe = async () => 'A printed letter about a prize.';
chat.deps.speak = async (t) => { spoke.push(t); return Buffer.alloc(9600); };
const lastRoster = () => asked.at(-1).roster;

test('warn (2+ signals): read aloud as a voice note, ONE question asked, the question is remembered, and NOTHING is sent to the family yet', async () => {
  const id = senior(); const ev = family();
  chat.deps.scam = check('warn', 'prize scam', 'money', 'payment'); reset(PLAIN);
  const r = await chat.sendImage(id, PNG, '', null);
  assert.equal(r.scam, 'warn');
  assert.equal(r.messages[1].kind, 'voice', 'read aloud');
  assert.ok(spoke.length > 0, 'the voice was asked for');
  const roster = lastRoster();
  assert.match(roster, /SCAM CHECK/); assert.match(roster, /possible prize scam/); assert.match(roster, /ask them not to pay, send money, share codes or details, or reply yet/); assert.match(roster, /ONE short question/);
  assert.match(roster, /it looks like a scam, never that it is certain/); assert.match(roster, /never give a number yourself/); assert.match(roster, /No diagnosis, no legal advice, no guarantee/);
  assert.doesNotMatch(roster, /exact words|Use the words|"this looks like a scam"|please don't pay/i, 'principles only: Spark finds her own words, the app dictates none');
  assert.equal(care.scamPending(id).type, 'prize scam');
  assert.equal(care.view(id).scams.length, 0, 'no ticket until they answer');
  assert.equal(ev.filter((e) => e.ev === 'notify' && e.data.id === id).length, 0, 'nothing to the family');
});

test('warn then yes: one topic-only alert (kind of scam only), the existing family-ask note is not doubled, and Maya is told what was sent', async () => {
  const id = senior(); const ev = family();
  chat.deps.scam = check('warn', 'payment scam', 'urgency', 'payment'); reset(PLAIN);
  await chat.sendImage(id, PNG, '', null);
  reset(PLAIN);
  await chat.sendText(id, 'Yes please, tell my daughter', null);
  const v = care.view(id);
  assert.equal(v.scams.length, 1); assert.equal(v.scams[0].level, 'alert');
  const sent = ev.filter((e) => e.ev === 'notify' && e.data.id === id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].data.text, /possible payment scam/);
  assert.ok(!LETTER_RE(sent[0].data.text), sent[0].data.text);
  assert.equal(care.get(id).notifications.filter((x) => x.kind === 'gentle').length, 0, 'the ordinary "tell my family" note did not also fire');
  assert.match(lastRoster(), /the app has now sent their family an alert saying only what kind of message it was/);
  assert.match(lastRoster(), /saying "your family" and never naming a particular relative/);
  assert.equal(care.scamPending(id), null);
  assert.equal(care.get(id).flags.length, 0, 'not a safety or couldn\'t-reach flag');
});
function LETTER_RE(t) { return LETTER.test(t) || /fee to claim|you won/i.test(t); }

test('warn then no: a dashboard Flag only, no alert, no push, Maya respects it and never asks again', async () => {
  const id = senior(); const ev = family();
  chat.deps.scam = check('warn', 'prize scam', 'money', 'payment'); reset(PLAIN);
  await chat.sendImage(id, PNG, '', null);
  const before = ev.length;
  reset(PLAIN);
  await chat.sendText(id, "No, please don't tell anyone", null);
  const v = care.view(id);
  assert.equal(v.scams.length, 1); assert.equal(v.scams[0].level, 'flag');
  assert.equal(care.get(id).notifications.filter((x) => x.to === 'family').length, 0);
  assert.equal(ev.length, before, 'no push of any kind');
  assert.match(lastRoster(), /NOT sending their family any message/); assert.match(lastRoster(), /Do not ask about it again and do not push/);
  assert.match(lastRoster(), /Never say it stays between you, is private or secret, or that nobody will know/, 'no false promise of secrecy: the flag is on the family page');
  reset(PLAIN);
  await chat.sendText(id, 'ok thank you', null);
  assert.ok(!/SCAM CHECK|not sending their family|alert saying only/i.test(lastRoster()), 'no nagging: nothing about it on the next turn');
  assert.equal(care.view(id).scams.length, 1); assert.equal(care.view(id).scams[0].level, 'flag', 'still only a flag: she never alerts anyway');
});

test('caution (1 signal): read aloud gently, never called a scam, NO question about family, nothing stored or sent', async () => {
  const id = senior(); const ev = family();
  chat.deps.scam = check('caution', 'payment scam', 'urgency'); reset(PLAIN);
  const r = await chat.sendImage(id, PNG, '', null);
  assert.equal(r.scam, 'caution'); assert.equal(r.messages[1].kind, 'voice');
  assert.match(lastRoster(), /one warning sign/); assert.match(lastRoster(), /Do not call it a scam and do not ask about telling their family/);
  assert.ok(!/ONE short question/.test(lastRoster()));
  assert.equal(care.scamPending(id), null);
  assert.equal(care.view(id).scams.length, 0);
  assert.equal(ev.filter((e) => e.data && e.data.id === id).length, 0);
});

test('none (a normal letter): no warning at all, no note, no voice, no question, nothing stored', async () => {
  const id = senior(); const ev = family();
  chat.deps.scam = check('none', 'ordinary letter'); reset(PLAIN);
  const r = await chat.sendImage(id, PNG, 'my gas bill', null);
  assert.equal(r.scam, 'none'); assert.equal(r.messages[1].kind, 'text');
  assert.ok(!/SCAM CHECK/.test(lastRoster()));
  assert.equal(care.scamPending(id), null); assert.equal(care.view(id).scams.length, 0);
  assert.equal(ev.filter((e) => e.data && e.data.id === id).length, 0);
});

test('a failed scam check never blocks the photo and never invents a verdict', async () => {
  const id = senior();
  chat.deps.scam = async () => { throw new Error('Meta Spark failed (HTTP 500)'); }; reset(PLAIN);
  const orig = console.error; console.error = () => {};
  let r; try { r = await chat.sendImage(id, PNG, '', null); } finally { console.error = orig; }
  assert.equal(r.scam, 'none'); assert.equal(r.messages[1].kind, 'text');
  assert.ok(!/SCAM CHECK/.test(lastRoster())); assert.equal(care.scamPending(id), null);
});

test('during a live call the reading is written (two Mayas never talk at once) and the question still works', async () => {
  const id = senior();
  care.liveCalls.set(id, { fake: true });
  try {
    chat.deps.scam = check('warn', 'prize scam', 'money', 'payment'); reset(PLAIN);
    const r = await chat.sendImage(id, PNG, '', null);
    assert.equal(r.messages[1].kind, 'text'); assert.equal(r.scam, 'warn');
    assert.equal(care.scamPending(id).type, 'prize scam');
  } finally { care.liveCalls.delete(id); }
});

test('an urgent matter comes first: after a fall, a "yes" can never become a scam alert, and the one alert is the safety alert', async () => {
  const id = senior();
  chat.deps.scam = check('warn', 'prize scam', 'money', 'payment'); reset(PLAIN);
  await chat.sendImage(id, PNG, '', null);
  reset(FALL);
  await chat.sendText(id, 'Oh I fell down and I cannot get up', null);
  assert.equal(care.view(id).scams.length, 0, 'the fall turn made no scam ticket');
  reset(PLAIN);
  await chat.sendText(id, 'Yes please tell them', null);   // with a health ticket open the scam question is dropped, not answered
  assert.equal(care.scamPending(id), null);
  assert.equal(care.view(id).scams.length, 0, 'no scam alert, ever, while a safety matter is open');
  assert.equal(care.get(id).notifications.filter((x) => x.kind === 'alert').length, 1, 'the one alert is the safety alert');
  assert.ok(!/alert saying only what kind of message/.test(lastRoster()));
});

test('an unclear answer is not a yes: she leans in at most once more, then lets it go, and a later yes does nothing', async () => {
  const id = senior();
  chat.deps.scam = check('warn', 'prize scam', 'money', 'payment'); reset(PLAIN);
  await chat.sendImage(id, PNG, '', null);
  reset(PLAIN); await chat.sendText(id, 'What time is it now', null);
  assert.match(lastRoster(), /not answered that yet/); assert.ok(care.scamPending(id));
  reset(PLAIN); await chat.sendText(id, 'The weather looks grey', null);
  assert.equal(care.scamPending(id), null);
  reset(PLAIN); await chat.sendText(id, 'Yes', null);
  assert.equal(care.view(id).scams.length, 0, 'a late yes about something else is not an alert');
});

test('wiring: the scam check runs beside the description (not instead), only with a Meta key, and the family text carries no letter words', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');
  assert.match(src, /Promise\.all\(\[deps\.describe\(buf, mime\), check\]\)/);
  assert.match(src, /process\.env\.META_API_KEY \? require\('\.\/scam'\)\.assess/);
  const care_ = fs.readFileSync(path.join(__dirname, '..', 'care.js'), 'utf8');
  const t = care_.slice(care_.indexOf('function scamAlert'), care_.indexOf('function scamFlag'));
  assert.ok(!/reading|transcript|photo|mediaUrl/.test(t.replace(/never the letter, a transcript or the photo/g, '')), 'the alert text is built from the name and the kind only');
});

const SCAM4 = `${tag({ emotion: 'neutral', intensity: 2, intent: 'share', concern: 'none', pain: 0 })} It says you won a prize and must pay a fee. This looks like a scam, please don't pay or share any details. It is best not to reply. Would you like me to let your family know?`;
const SCAM4_UNSURE = `${tag({ emotion: 'anxious', intensity: 3, intent: 'share', concern: 'unsure', pain: 0 })} It says you won a prize and must pay a fee. This looks like a scam, please don't pay or share any details. It is best not to reply. Would you like me to let your family know?`;

const FOUR = (emotion) => `${tag({ emotion, intensity: 3, intent: 'share', concern: 'none', pain: 0 })} It says you won a prize and must pay a fee. This looks like a scam, please don't pay or share any details. It is best not to reply. Would you like me to let your family know?`;
const sentences = (t) => (t.match(/[.?]/g) || []).length;

test('a scam warning keeps ALL its sentences even when Spark reads the person as anxious (normally capped at 2); a normal photo reply keeps the usual cap', async () => {
  const id = senior();
  chat.deps.scam = check('warn', 'prize scam', 'money', 'payment'); reset(FOUR('anxious'));
  const r = await chat.sendImage(id, PNG, '', null);
  const text = r.messages[1].text;
  assert.match(text, /looks like a scam, please don't pay/); assert.match(text, /Would you like me to let your family know\?/);
  assert.equal(sentences(text), 4, text);
  assert.doesNotMatch(lastRoster(), /exact words|"this looks like a scam"|please don't pay/i, 'no phrase is dictated: she words the warning herself'); assert.match(lastRoster(), /ask them not to pay, send money, share codes or details, or reply yet/);
  const id2 = senior();
  chat.deps.scam = check('none', 'ordinary letter'); reset(FOUR('anxious'));
  const r2 = await chat.sendImage(id2, PNG, '', null);
  assert.equal(sentences(r2.messages[1].text), 2, 'an ordinary photo keeps the usual cap, so only a warning is lengthened: ' + r2.messages[1].text);
  const id3 = senior();
  chat.deps.scam = check('caution', 'payment scam', 'urgency'); reset(FOUR('anxious'));
  const r3 = await chat.sendImage(id3, PNG, '', null);
  assert.ok(sentences(r3.messages[1].text) <= 3, 'caution gets at most three sentences and no family question: ' + r3.messages[1].text);
  assert.ok(!/Would you like me to let your family know/.test(r3.messages[1].text));
});

test('the scam question is its own question: a Spark "unsure" read on the photo turn does not also start the older "is something wrong" alert', async () => {
  const id = senior(); const ev = family();
  chat.deps.scam = check('warn', 'prize scam', 'money', 'payment'); reset(SCAM4_UNSURE);
  await chat.sendImage(id, PNG, '', null);
  reset(PLAIN);
  await chat.sendText(id, 'Yes please', null);
  const v = care.view(id);
  assert.equal(v.scams.length, 1); assert.equal(v.scams[0].level, 'alert');
  assert.equal(care.get(id).notifications.filter((x) => x.to === 'family').length, 1, 'exactly one family notification');
  assert.equal(care.get(id).notifications.filter((x) => x.ref === 'asked').length, 0, 'no "told Maya something is not right" alert');
  assert.ok(!ev.some((e) => e.ev === 'notify' && /something is not right/.test(e.data.text)));
});

test('a scam note tells Maya the feel tag must say concern=none (a scam letter is not a health emergency), for both warn and caution', async () => {
  for (const level of ['warn', 'caution']) {
    const id = senior();
    chat.deps.scam = check(level, 'prize scam', ...(level === 'warn' ? ['money', 'payment'] : ['urgency'])); reset(PLAIN);
    await chat.sendImage(id, PNG, '', null);
    assert.match(lastRoster(), /use concern=none and pain=0 and never emotion=crisis: this is about a message, not about their health or safety/, level);
  }
  const id = senior();
  chat.deps.scam = check('none', 'ordinary letter'); reset(PLAIN);
  await chat.sendImage(id, PNG, '', null);
  assert.ok(!/concern=none and pain=0/.test(lastRoster()), 'an ordinary photo gets no extra instruction');
});
