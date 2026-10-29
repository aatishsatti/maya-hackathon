// Reconfirm + screenshot ask (official.js step / look), on a live call (Call.respond) and in typed chat (sendText / sendImage). No network: Spark, the scam
// check, the vision read and the official sites are stubbed. The sentences below exist only in this file; Maya's wording is Spark's, so these tests check the
// FACTS and PRINCIPLES she is given, when the official check runs, and what reaches the family dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-reconfirm-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');

const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => {
    if (/has been silent for a little while/.test(roster)) { const idle = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]] Are you still there?'; if (onDelta) onDelta(idle); return idle; }
    asked.push({ roster }); const item = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(item); return item; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const { Call, callDeps } = require('../call');
const S = require('../scam');
const O = require('../official');

const fetched = [];
const web = (pages) => async (url) => {
  fetched.push(url); const p = pages[url];
  if (!p) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => p.html || '' };
};
const BANK = {
  'https://chase.com/': { html: '<title>Chase Online</title><a href="/security/fraud">Fraud and security</a>' },
  'https://chase.com/security/fraud': { html: '<title>Protect yourself from fraud</title><meta name="description" content="Chase will never ask you to share a one-time code.">' },
};
const useWeb = (pages) => { O.cache.clear(); fetched.length = 0; const f = (w, o) => O.check(w, { ...o, fetch: web(pages) }); chat.deps.official = f; callDeps.official = f; };

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} Okay.`;
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => { queue.length = 0; queue.push(PLAIN); asked.length = 0; };
const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const rd = (...on) => Object.fromEntries(S.READS.map((k) => [k, on.includes(k)]));
const verdict = (level) => async () => ({ level, type: 'bank impersonation scam', reading: 'Someone says they are from the bank and wants a code.', signals: sig('impersonation', 'payment'), reads: rd(level === 'pause' ? 'aboutToAct' : 'idDetails'), count: 2 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
chat.deps.speak = async () => Buffer.alloc(9600);

// ---- calls ----
const made = [];
function mkCall() {
  const ws = { send() {}, close() {}, onmessage: null, onclose: null };
  const c = new Call(ws, 'k'); c.profile = memory.load(memory.createProfile(`Rue${letters(n++)}`, 'female').id); c.callId = `c${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController();
  c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; made.push(c);
  return c;
}
const turn = (text) => ({ text, partial: text, spans: [{ label: 'A', end: text.length }], endedAt: Date.now(), completedAt: Date.now() });
let roster = '';
async function say(c, text) { const before = asked.length; c.pending = [turn(text)]; await c.respond(0); await sleep(5); roster = asked[before] ? asked[before].roster : ''; }
const NOW = 'A lady from my bank rang and I am going to the shop now to buy the gift cards she asked for.';
const callSetup = (pages = BANK) => { useWeb(pages); callDeps.scamText = verdict('pause'); reset(); };

test('call, no company clear: ONE reconfirm fact (what they said, what is unclear, not asked before), no internet check yet, her usual family question still stands', async () => {
  callSetup(); const c = mkCall();
  await say(c, NOW);
  assert.match(roster, /RECONFIRM \(a fact from the app/); assert.match(roster, /What they have already said: no company name and no web address/);
  assert.match(roster, /Still unclear: the company or website/); assert.match(roster, /asked 0 times before this reply/);
  assert.match(roster, /which company or website it was, whether they can spell the website slowly, or whether they can send a screenshot of the message after the call/);
  assert.match(roster, /ONE short, natural question, the way a friend would/); assert.match(roster, /Do not ask it again in later replies/); assert.match(roster, /Never ask for a phone number or a code/);
  assert.doesNotMatch(roster, /OFFICIAL SOURCE CHECK/); assert.equal(fetched.length, 0);
  assert.match(roster, /SCAM CHECK/); assert.equal(c.rc.stage, 'asked', 'asked once the reply was spoken');
});

test('call reconfirm, spelled website: the official check runs on the spelled name; mismatch, the quoted page, acknowledged, not asked again; the dashboard chip is yes (Chase)', async () => {
  callSetup(); const c = mkCall();
  await say(c, NOW);
  reset(); await say(c, 'It said c h a s e dash secure dash verify dot example, the lady spelled it out to me.');
  assert.match(roster, /RECONFIRM ANSWERED/); assert.match(roster, /do NOT ask it again/); assert.match(roster, /they have now given the company Chase/); assert.match(roster, /Acknowledge what they said/);
  assert.match(roster, /OFFICIAL SOURCE CHECK/); assert.match(roster, /NOT chase\.com/); assert.match(roster, /Protect yourself from fraud/);
  assert.ok(fetched.some((u) => u === 'https://chase.com/') && !fetched.some((u) => /secure-verify/.test(u)));
  assert.equal(c.rc.stage, 'done');
  const p = care.scamPending(c.profile.id); assert.deepEqual(p.official, { checked: true, found: true, name: 'Chase' }); assert.equal(p.channel, 'spoken');
  care.scamAnswer(c.profile.id, true);
  assert.deepEqual(care.view(c.profile.id).scams[0].official, { checked: true, found: true, name: 'Chase' });
  assert.doesNotMatch(JSON.stringify(care.view(c.profile.id).scams), /secure-verify|gift cards|lady/i);
});

test('call reconfirm, a company name only: the check runs with "no address to compare"; not repeated afterwards', async () => {
  callSetup(); const c = mkCall();
  await say(c, NOW);
  reset(); await say(c, 'Oh, it was Chase.');
  assert.match(roster, /RECONFIRM ANSWERED/); assert.match(roster, /the company Chase/); assert.match(roster, /gave no web address to compare/);
  reset(); await say(c, 'Thank you, I will ring them myself on the number in my wallet.');
  assert.doesNotMatch(roster, /RECONFIRM/, 'the question is never asked again once answered');
});

test('call reconfirm, no website or company given: cannot verify, nothing invented, chip says no', async () => {
  callSetup(); const c = mkCall();
  await say(c, NOW);
  reset(); await say(c, 'I do not know, I did not catch it and I never wrote it down.');
  assert.match(roster, /RECONFIRM ANSWERED/); assert.match(roster, /nothing the app could read as a company or website/);
  assert.match(roster, /NO official source/); assert.match(roster, /cannot be verified from an official source/); assert.doesNotMatch(roster, /official website \(/);
  assert.equal(fetched.length, 0);
  // "I do not know" also reads as a no to her family question: the flag that results still carries the official-source line (attached after the fact).
  assert.deepEqual((care.scamPending(c.profile.id) || care.view(c.profile.id).scams[0]).official, { checked: true, found: false, name: null });
});

test('call reconfirm: a plain "yes" to the family question does not use up the reconfirm; asked only once however many warnings follow', async () => {
  callSetup(); const c = mkCall();
  await say(c, NOW);
  assert.ok(care.scamPending(c.profile.id), 'her family question is open too');
  reset(); await say(c, 'Yes please.');
  assert.doesNotMatch(roster, /RECONFIRM ANSWERED/); assert.equal(c.rc.stage, 'asked'); assert.equal(care.view(c.profile.id).scams[0].level, 'alert');
  reset(); callDeps.scamText = verdict('pause'); await say(c, 'He rang again, now I am at the cash machine to get the money out.');
  assert.doesNotMatch(roster, /RECONFIRM \(a fact/, 'never asked a second time');
});

test('call: a reconfirm reply that was cut off before it was spoken asks nothing', async () => {
  callSetup(); const c = mkCall();
  await say(c, NOW);
  c.rc.stage = 'offered';   // as if the reply were cut off: the commit happens only when the reply is really spoken
  c.scamLater = { scam: await verdict('pause')(), at: Date.now() };   // and its warning is owed again (heard.test.js)
  reset(); await say(c, 'Sorry, what did you say?');
  assert.match(roster, /RECONFIRM \(a fact/, 'asked again, because the first was never heard'); assert.match(roster, /asked 0 times before this reply/);
});

test('call, company named already: the official check runs at once, no reconfirm', async () => {
  callSetup(); const c = mkCall();
  await say(c, 'A man from Chase rang and I am about to read out the code in my text to him.');
  assert.doesNotMatch(roster, /RECONFIRM/); assert.match(roster, /OFFICIAL SOURCE CHECK/); assert.equal(c.rc.stage, 'done');
});

test('call: a slow lookup is cannot verify, the reply is not blocked', async () => {
  callSetup(); const c = mkCall(); callDeps.officialMs = 30; callDeps.official = () => new Promise(() => {});
  await say(c, 'A man from Chase rang and I am about to read out the code in my text to him.');
  callDeps.officialMs = 4000;
  assert.match(roster, /NO official source/); assert.match(roster, /could not be reached just now/);
});

test('call: not a scam / only a caution: no reconfirm and no official check', async () => {
  for (const level of ['none', 'caution']) {
    callSetup(); callDeps.scamText = verdict(level); const c = mkCall();
    await say(c, NOW);
    assert.doesNotMatch(roster, /RECONFIRM|OFFICIAL SOURCE/); assert.equal(fetched.length, 0);
  }
});

// ---- typed chat + screenshots ----
const senior = () => memory.createProfile(`Ina${letters(n++)}`, 'female').id;
const chatSetup = (pages = BANK, level = 'warn') => { useWeb(pages); chat.deps.scamText = verdict(level); chat.deps.scam = verdict(level); reset(); };
const NOLINK = 'My bank texted me to read out the code that was sent to me, they said it is urgent.';

test('chat, no link or company: the reconfirm fact asks for the link or a screenshot (principles, no fixed sentence), once', async () => {
  chatSetup(); const id = senior();
  await chat.sendText(id, NOLINK, null);
  const r = asked.at(-1).roster;
  assert.match(r, /RECONFIRM \(a fact from the app/); assert.match(r, /whether they can type the link, or send a screenshot or photo of the message/); assert.match(r, /TWO SHORT SENTENCES IN ALL/);
  assert.doesNotMatch(r, /OFFICIAL SOURCE CHECK/); assert.equal(fetched.length, 0);
  assert.doesNotMatch(r, /"(Can|Could|Would) you /, 'no sentence is dictated');
  reset(); await chat.sendText(id, 'Yes please.', null);
  assert.doesNotMatch(asked.at(-1).roster, /RECONFIRM/); assert.equal(care.view(id).scams[0].level, 'alert');
});

test('chat screenshot WITH a link (after the question): the vision read goes through the official check; mismatch + official name; chip yes (Chase); no link or code in the ticket', async () => {
  chatSetup(); const id = senior();
  await chat.sendText(id, NOLINK, null);
  chat.deps.describe = async () => 'A text message that says it is from Chase and asks for the code, with the link chase-secure-verify.example/login.';
  reset(); const out = await chat.sendImage(id, PNG, '', null);
  assert.equal(out.scam, 'warn');
  const r = asked.at(-1).roster;
  assert.match(r, /RECONFIRM ANSWERED/); assert.match(r, /OFFICIAL SOURCE CHECK/); assert.match(r, /NOT chase\.com/); assert.match(r, /Protect yourself from fraud/);
  assert.deepEqual(care.scamPending(id).official, { checked: true, found: true, name: 'Chase' });
  care.scamAnswer(id, true);
  assert.deepEqual(care.view(id).scams[0].official, { checked: true, found: true, name: 'Chase' });
  assert.doesNotMatch(JSON.stringify(care.view(id).scams), /secure-verify|read out|login/i);
});

test('chat screenshot with a link, sent on its own as a scam photo: the official check runs on what the vision read', async () => {
  chatSetup(); const id = senior();
  chat.deps.describe = async () => 'A text message from Chase asking to confirm a login at chase-secure-verify.example/login.';
  await chat.sendImage(id, PNG, '', null);
  const r = asked.at(-1).roster;
  assert.match(r, /SCAM CHECK/); assert.match(r, /OFFICIAL SOURCE CHECK/); assert.match(r, /NOT chase\.com/); assert.doesNotMatch(r, /RECONFIRM/);
  assert.deepEqual(care.scamPending(id).official, { checked: true, found: true, name: 'Chase' });
});

test('chat screenshot with NO link or company: cannot verify, nothing invented', async () => {
  chatSetup(); const id = senior();
  chat.deps.describe = async () => 'A blurry photo of a letter; the writing cannot be read.';
  await chat.sendImage(id, PNG, '', null);
  const r = asked.at(-1).roster;
  assert.match(r, /NO official source/); assert.match(r, /no company name or web address could be read/); assert.doesNotMatch(r, /official website \(/); assert.equal(fetched.length, 0);
  assert.deepEqual(care.scamPending(id).official, { checked: true, found: false, name: null });
});

test('chat: the screenshot that answers the question has no link: cannot verify, and the question is not asked again', async () => {
  chatSetup(); const id = senior();
  await chat.sendText(id, NOLINK, null);
  chat.deps.describe = async () => 'A photo of a kitchen table with a phone on it.';
  reset(); await chat.sendImage(id, PNG, '', null);
  const r = asked.at(-1).roster;
  assert.match(r, /RECONFIRM ANSWERED/); assert.match(r, /NO official source/); assert.doesNotMatch(r, /RECONFIRM \(a fact/);
});

test('chat: a typed company name answers the question and runs the check; then it is never asked again', async () => {
  chatSetup(); const id = senior();
  await chat.sendText(id, NOLINK, null);
  reset(); await chat.sendText(id, 'It was Chase I think.', null);
  assert.match(asked.at(-1).roster, /RECONFIRM ANSWERED/); assert.match(asked.at(-1).roster, /OFFICIAL SOURCE CHECK/);
  reset(); await chat.sendText(id, 'Thank you dear.', null);
  assert.doesNotMatch(asked.at(-1).roster, /RECONFIRM/);
});

test.after(() => { made.forEach((c) => c.end()); for (const s of chat.sessions.values()) s.finish(); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
