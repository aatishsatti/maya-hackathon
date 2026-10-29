// Background check + delivery, source tiers, e-mail sender, phone numbers, safety first. No network: Tavily, the official sites and Spark are stubbed.
// The sentences below exist only in this test file. Maya's wording is Spark's; these tests check the facts she is given, when, and what is stored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-bg-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');

const queue = []; const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push({ roster }); const item = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(item); return item; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const S = require('../scam');
const O = require('../official');
const W = require('../web');
const C = require('../checks');

const KEY = 'tvly-SECRET-KEY-456';
const sent = [];
const tavily = (table, { throws = false } = {}) => async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  if (throws) throw new Error('down');
  const q = JSON.parse(opts.body).query.toLowerCase(); const hit = Object.entries(table).find(([k]) => q.includes(k));
  return { ok: true, status: 200, text: async () => JSON.stringify({ results: hit ? hit[1] : [] }) };
};
const PAGES = {
  'fake-bank-login': [{ title: 'Secure Bank Login', url: 'https://fake-bank-login.example/', content: 'Welcome to your bank. Log in here to verify your account.' }],
  'scam-reports': [{ title: 'Reported scam sites', url: 'https://scamwatch.gov.au/reports', content: 'Report a scam site to the authorities.' }, { title: 'Chase fraud', url: 'https://www.chase.com/security', content: 'Chase will never ask for your code.' }],
};
const BANK = { 'https://chase.com/': { html: '<title>Chase Online</title><a href="/security/fraud">Fraud</a>' }, 'https://chase.com/security/fraud': { html: '<title>Protect yourself from fraud</title><meta name="description" content="Chase will never ask you to share a one-time code.">' } };
const site = (pages) => async (url) => { const p = pages[url]; return p ? { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => p.html } : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }; };
const useWeb = (table = PAGES, o = {}) => { W.cache.clear(); W.spent.length = 0; O.cache.clear(); sent.length = 0; chat.deps.web = (w, opts) => W.lookup(w, { ...opts, fetch: tavily(table, o), key: KEY }); chat.deps.official = (w, opts) => O.check(w, { ...opts, fetch: site(BANK) }); };

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} Okay.`;
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Bea${letters(n++)}`, 'female').id;
const reset = () => { queue.length = 0; queue.push(PLAIN); asked.length = 0; };
const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const verdict = (level) => async () => ({ level, type: 'bank impersonation scam', reading: 'A message from a bank asks them to log in.', signals: sig('impersonation', 'payment'), reads: Object.fromEntries(S.READS.map((k) => [k, false])), count: 2 });
const roster = () => asked.at(-1).roster;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
chat.deps.speak = async () => Buffer.alloc(9600);
const setup = (table, o, level = 'warn') => { useWeb(table, o); chat.deps.scamText = verdict(level); chat.deps.scam = verdict(level); reset(); };
const LINK = 'The text says my bank account is locked and I must log in at fake-bank-login.example/verify to unlock it.';

test('tiers are set by code from the host: official allow-list = 1, government / reputable = 2, everything else = 3', () => {
  assert.equal(W.tierOf('www.chase.com'), 1); assert.equal(W.tierOf('secure.barclays.co.uk'), 1);
  assert.equal(W.tierOf('scamwatch.gov.au'), 2); assert.equal(W.tierOf('www.nhs.uk'), 2); assert.equal(W.tierOf('consumer.ftc.gov'), 2); assert.equal(W.tierOf('www.gov.uk'), 2, 'gov.uk is never tier 1: only its pension pages are official, and only via official.js');
  assert.equal(W.tierOf('fake-bank-login.example'), 3); assert.equal(W.tierOf('chase.com.evil.example'), 3); assert.equal(W.tierOf('my-chase-bank.example'), 3);
});

test('Tier 3 only (a fake bank site that a search found): CANNOT confirm official; a found site is never validated as real', async () => {
  const w = await W.lookup('they say go to fake-bank-login.example', { fetch: tavily(PAGES), key: KEY, scam: true });
  const note = W.note(w);
  assert.match(note, /fake-bank-login\.example \(tier 3: general web, NOT official\)/); assert.match(note, /Only tier 3 pages were found: you CANNOT confirm anything is official or real/);
  assert.match(note, /Never say a site is real, genuine or safe just because a search found it/); assert.equal(w.topics[0].address, 'match');
  assert.match(note, /that alone does not make the message safe/);
  assert.doesNotMatch(note, /is the real|is genuine\b(?! or)/);
});

test('mixed tiers: sorted official-first, tier 2 alone cannot call a site the real company, tier 1 may speak for the company', async () => {
  W.cache.clear();
  const w = await W.lookup('see scam-reports on fake-bank-login.example', { fetch: tavily({ 'fake-bank-login': PAGES['scam-reports'] }), key: KEY, scam: true });
  assert.deepEqual(w.topics[0].results.map((x) => x.tier), [1, 2]);
  assert.match(W.note(w), /A tier 1 source was found/);
  W.cache.clear(); const gov = await W.lookup('see fake-bank-login.example', { fetch: tavily({ 'fake-bank-login': [PAGES['scam-reports'][0]] }), key: KEY, scam: true });
  assert.match(W.note(gov), /only a government or reputable one: .* you cannot say a given site or message is the real company/);
});

test('Tier 1 mismatch = not real: the official site was reached and the address is not it', async () => {
  const r = await O.check('A man from Chase rang. Log in at chase-secure-verify.example/login', { fetch: site(BANK) });
  const note = O.note(r);
  assert.equal(r.caller, 'mismatch'); assert.match(note, /it does not match the real Chase/); assert.match(note, /say it is not from the real Chase/);
});

test('e-mail sender mismatch = scam; sender match = caution, NOT confirmed', async () => {
  const bad = await O.check('An e-mail from Chase Support <help@chase-alerts.example> says my account is closed.', { fetch: site(BANK) });
  assert.equal(bad.sender, 'mismatch'); assert.match(O.note(bad), /sender address is NOT on chase\.com/); assert.match(O.note(bad), /say plainly that this e-mail is a scam/);
  const good = await O.check('An e-mail from Chase <alerts@chase.com> says to confirm my login.', { fetch: site(BANK) });
  assert.equal(good.sender, 'match'); assert.match(O.note(good), /sender addresses can be faked, so this is NOT confirmed/); assert.match(O.note(good), /never that it is genuine or safe/);
  assert.doesNotMatch(O.note(good), /say plainly that this e-mail is a scam/);
  const none = await O.check('Chase rang me about my account.', { fetch: site(BANK) }); assert.equal(none.sender, 'none');
});

test('typed chat: she says she is looking into it; the reply is not blocked; the lookup runs in the background and is delivered ONCE on the next turn', async () => {
  const id = senior(); setup();
  let release; const gate = new Promise((r) => { release = r; });
  chat.deps.web = async (w, o) => { if (/fake-bank-login/.test(w)) await gate; return W.lookup(w, { ...o, fetch: tavily(PAGES), key: KEY }); };
  const first = await chat.sendText(id, LINK, null);
  assert.equal(first.messages[1].kind, 'text', 'the reply came while the lookup was still waiting');
  assert.match(roster(), /BACKGROUND CHECK STARTED/); assert.match(roster(), /say briefly and naturally that you are looking into it/); assert.match(roster(), /Do NOT give or guess any result now/);
  assert.doesNotMatch(roster(), /FINISHED|fake-bank-login\.example \(tier/);
  assert.equal(care.get(id).checks[0].status, 'pending');
  reset(); await chat.sendText(id, 'Thank you dear, I will wait.', null);
  assert.match(roster(), /still running\. If they ask, say you are still looking; give no result and no guess/); assert.doesNotMatch(roster(), /FINISHED/);
  release(); await C.idle();
  assert.equal(care.get(id).checks[0].status, 'done');
  reset(); await chat.sendText(id, 'Is there any news about it?', null);
  assert.match(roster(), /has FINISHED/); assert.match(roster(), /fake-bank-login\.example \(tier 3: general web, NOT official\)/); assert.match(roster(), /you CANNOT confirm anything is official or real/);
  assert.equal(care.get(id).checks[0].delivered, true);
  reset(); await chat.sendText(id, 'Alright then.', null);
  assert.doesNotMatch(roster(), /has FINISHED|still running/, 'told once only');
});

test('what is stored: facts only. Not their words, not the link, not a phone number; the key is nowhere', async () => {
  const id = senior(); setup();
  await chat.sendText(id, `${LINK} They said to ring 0412 345 678 and give my account 55512345.`, null);
  await C.idle();
  const stored = JSON.stringify(care.get(id).checks) + JSON.stringify(care.view(id));
  assert.doesNotMatch(stored, /0412|345 678|55512345|locked|must log in/); assert.ok(!stored.includes(KEY));
  assert.ok(sent.length >= 1 && sent.every((b) => !/\d{3}/.test(b.query)), `queries carry no digit runs: ${sent.map((b) => b.query).join(' | ')}`);
});

test('phone number sent in chat: never searched, never passed to Tavily, never in the facts', async () => {
  const id = senior(); setup(PAGES, {}, 'none');
  await chat.sendText(id, 'Please ring my daughter on 0412 345 678 and tell her I am fine.', null);
  assert.equal(sent.length, 0, 'a number alone is not searched'); assert.doesNotMatch(roster(), /0412|345 678/);
  const w = await W.lookup('I heard that the pension is going up, is it true? ring me on 0412 345 678', { fetch: tavily(PAGES), key: KEY });
  assert.ok(w.topics.every((t) => true)); assert.ok(sent.every((b) => !/0412|345|678/.test(JSON.stringify(b))));
});

test('photo / screenshot with a link: the reply says she is looking into it; the lookup is delivered on the next turn', async () => {
  const id = senior(); setup();
  chat.deps.describe = async () => 'A text message that says the account is locked and to log in at fake-bank-login.example/verify.';
  const out = await chat.sendImage(id, PNG, '', null);
  assert.equal(out.scam, 'warn'); assert.match(roster(), /BACKGROUND CHECK STARTED/);
  await C.idle();
  reset(); await chat.sendText(id, 'What did you find?', null);
  assert.match(roster(), /has FINISHED/); assert.match(roster(), /tier 3: general web, NOT official/);
});

test('photo with no link or company: nothing to look up, no background check, nothing invented', async () => {
  const id = senior(); setup();
  chat.deps.describe = async () => 'A blurry photo of a table.';
  await chat.sendImage(id, PNG, '', null);
  assert.doesNotMatch(roster(), /BACKGROUND CHECK STARTED/); assert.equal((care.get(id).checks || []).length, 0);
});

test('a lookup that fails or never finishes is cannot verify, never a made-up result', async () => {
  const id = senior(); setup(PAGES, { throws: true });
  await chat.sendText(id, LINK, null); await C.idle();
  reset(); await chat.sendText(id, 'So?', null);
  assert.match(roster(), /has FINISHED/); assert.match(roster(), /NOTHING can be verified/); assert.doesNotMatch(roster(), /tier [123]: /);
  const id2 = senior(); setup(); const c = care.checkStart(id2); c.at = Date.now() - 6 * 60000;
  reset(); await chat.sendText(id2, 'Hello again.', null);
  assert.match(roster(), /could not be finished, so NOTHING was verified/);
});

test('safety first and distress: with a safety ticket open nothing is searched, no background check starts and a finished one is not handed over', async () => {
  const id = senior(); setup();
  const c = care.checkStart(id); care.checkDone(id, c.id, 'BACKGROUND CHECK (a fact): something.');
  care.selfHarmAlert(id);
  assert.ok(care.hasActiveSafety(id));
  await chat.sendText(id, LINK, null);
  assert.equal(sent.length, 0, 'no search'); assert.doesNotMatch(roster(), /BACKGROUND CHECK|FINISHED/); assert.equal(care.get(id).checks.length, 1, 'no new background check');
  const id2 = senior(); setup();
  await chat.sendText(id2, 'I feel like ending it all, is it true that nobody would notice?', null);
  assert.equal(sent.length, 0); assert.doesNotMatch(roster(), /WEB CHECK|BACKGROUND/);
});

test.after(() => { for (const s of chat.sessions.values()) s.finish(); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
