// General web check (web.js, Tavily) for what is not on the official allow-list, end to end through typed chat. No network: Tavily and Spark are stubbed.
// The sentences below exist only in this test file. Maya's wording is Spark's; these tests check the facts she is given and what is (not) sent out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-web-'));
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

const KEY = 'tvly-SECRET-KEY-123';
const sent = [];
// A fake Tavily: results by a word found in the query.
const tavily = (table, { status = 200, throws = false, big = false } = {}) => async (url, opts) => {
  sent.push({ url, opts });
  if (throws) throw new Error('network down');
  if (status !== 200) return { ok: false, status, text: async () => '{}' };
  const q = JSON.parse(opts.body).query.toLowerCase();
  const hit = Object.entries(table).find(([k]) => q.includes(k));
  const body = JSON.stringify({ query: q, results: hit ? hit[1] : [], response_time: 0.1, request_id: 'r' });
  return { ok: true, status: 200, text: async () => (big ? body + ' '.repeat(600000) : body) };
};
const PAGES = {
  harbour: [{ title: 'Harbour Light Bank - Home', url: 'https://www.harbourlight.example/', content: 'Harbour Light Bank is a small regional bank. We will never ask for your PIN by text.' }, { title: 'Beware of scams', url: 'https://www.harbourlight.example/scams', content: 'dup host' }],
  metformin: [{ title: 'Metformin: medicine uses', url: 'https://www.nhs.example/metformin', content: 'Metformin is taken with food. Ask a pharmacist before changing how you take it.' }, { title: 'bad http', url: 'http://plain.example/x', content: 'insecure' }, { title: 'ip', url: 'https://10.0.0.5/x', content: 'private' }, { title: 'port', url: 'https://evil.example:8443/x', content: 'port' }],
  'free-gift-prize': [{ title: 'Scam alert: free-gift-prize.example', url: 'https://scamwatch.example/reports/free-gift-prize', content: 'Reports say this site collects card details.' }],
};
const useWeb = (table = PAGES, o = {}) => { W.cache.clear(); W.spent.length = 0; sent.length = 0; chat.deps.web = (w, opts) => W.lookup(w, { ...opts, fetch: tavily(table, o), key: o.key === undefined ? KEY : o.key }); chat.deps.official = (w, opts) => O.check(w, { ...opts, fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' }) }); };

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const PLAIN = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} Okay.`;
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Wen${letters(n++)}`, 'female').id;
const reset = () => { queue.length = 0; queue.push(PLAIN); asked.length = 0; };
const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const verdict = (level) => async () => ({ level, type: 'bank impersonation scam', reading: 'Someone says they are from a bank and wants a code.', signals: sig('impersonation', 'payment'), reads: Object.fromEntries(S.READS.map((k) => [k, false])), count: 2 });
const roster = () => asked.at(-1).roster;
const setup = (table, o, level = 'none') => { useWeb(table, o); chat.deps.scamText = verdict(level); reset(); };

test('extract: code only, what needs checking; no phone number, no long digits, no e-mail, ordinary chat nothing', () => {
  const k = (w, o) => W.extract(w, o).map((t) => t.kind);
  assert.deepEqual(k('I made soup today and it smelled lovely.'), []);
  assert.deepEqual(k('They sent a link free-gift-prize.example/claim and I should click it', { scam: true }), ['link']);
  assert.deepEqual(k('A man from Harbour Light Bank rang', { company: 'Harbour Light Bank', scam: true }), ['company']);
  assert.deepEqual(k('My doctor said I am taking Metformin for my sugar'), ['medicine']);
  assert.deepEqual(k('I heard that the pension is going up next month, is it true?'), ['claim']);
  const all = W.extract('Is it safe to take aspirin with my account 12345678 or call me on 0412 345 678 or mail a.b@mail.example?').map((t) => t.query).join(' ');
  assert.doesNotMatch(all, /\d{3}|@|a\.b/, all);
  assert.ok(W.extract('They sent a link free-gift-prize.example and chase.com/x and I heard that it is a scam, is it true?', { scam: true }).length <= 2, 'at most two searches a turn');
  assert.deepEqual(k('A man from Chase rang about chase.com/security', { scam: true }), [], 'an official address is not searched');
});

test('search request follows the Tavily docs; the key is only in the Authorization header', async () => {
  useWeb();
  const r = await W.search('metformin medicine', { fetch: tavily(PAGES), key: KEY });
  const { url, opts } = sent.at(-1);
  assert.equal(url, 'https://api.tavily.com/search'); assert.equal(opts.method, 'POST'); assert.equal(opts.headers.Authorization, `Bearer ${KEY}`); assert.equal(opts.headers['Content-Type'], 'application/json');
  const body = JSON.parse(opts.body); assert.equal(body.search_depth, 'basic'); assert.equal(body.max_results, 5); assert.equal(body.include_answer, false); assert.ok(!opts.body.includes(KEY));
  assert.equal(r.failed, null); assert.deepEqual(r.results.map((x) => x.host), ['nhs.example'], 'http, IP, odd-port results are dropped');
});

test('results: https only, one per site, cleaned and short; nothing invented', async () => {
  const r = await W.search('harbour', { fetch: tavily({ harbour: [{ title: '<b>Bank</b>\u0007', url: 'https://a.example/x', content: 'x'.repeat(2000) }, { title: 'again', url: 'https://a.example/y', content: 'dup' }, { title: '', url: 'https://b.example/', content: '' }] }), key: KEY });
  assert.equal(r.results.length, 1); assert.equal(r.results[0].title, 'Bank'); assert.ok(r.results[0].content.length <= 320);
  const none = await W.search('nothing here', { fetch: tavily({}), key: KEY });
  assert.deepEqual(none.results, []); assert.equal(none.failed, null);
  assert.match(W.note({ topics: [{ kind: 'claim', label: 'something they heard', failed: null, results: [] }] }), /found NO usable page, so it cannot be verified/);
});

test('failure of any kind = cannot verify: no key, HTTP error, rate limit, network error, timeout, oversized answer', async () => {
  for (const [name, o] of [['no key', { key: null }], ['500', { status: 500 }], ['429', { status: 429 }], ['432', { status: 432 }], ['throws', { throws: true }], ['big', { big: true }]]) {
    W.cache.clear(); W.spent.length = 0;
    const r = await W.search(`query ${name}`, { fetch: tavily(PAGES, o), key: o.key === undefined ? KEY : o.key });
    assert.ok(r.failed, name); assert.deepEqual(r.results, []);
    const note = W.note({ topics: [{ kind: 'claim', label: 'something they heard', failed: r.failed, results: [] }] });
    assert.match(note, /NOTHING can be verified/); assert.match(note, /do not guess/);
  }
  W.cache.clear();
  const slow = await W.search('slow', { fetch: (u, o) => new Promise((_, no) => o.signal.addEventListener('abort', () => no(Object.assign(new Error('t'), { name: 'TimeoutError' })))), key: KEY });
  assert.equal(slow.failed, 'timeout');
});

test('hourly cap protects the credits: past it, cannot verify without calling out', async () => {
  useWeb(); for (let i = 0; i < W.HOURLY_CAP; i += 1) W.spent.push(Date.now());
  const before = sent.length; const r = await W.search('another new question', { fetch: tavily(PAGES), key: KEY });
  assert.equal(r.failed, 'limit'); assert.equal(sent.length, before);
});

test('chat: a scam about a company NOT on the allow-list is still searched; the facts carry the site and what it says, and say it is not official', async () => {
  const id = senior(); setup(PAGES, {}, 'warn');
  await chat.sendText(id, 'A man from Harbour Light Bank rang me and wants me to read out the code in my text.', null);
  const r = roster();
  assert.match(r, /SCAM CHECK/); assert.match(r, /OFFICIAL SOURCE CHECK/); assert.match(r, /NO official source/);
  assert.match(r, /WEB CHECK \(a fact from the app: a general web search, NOT an official source/); assert.match(r, /site harbourlight\.example, titled "Harbour Light Bank - Home"/); assert.match(r, /never ask for your PIN by text/);
  assert.match(r, /never invent a source/); assert.ok(sent.some((x) => /harbour light bank/i.test(JSON.parse(x.opts.body).query)));
  assert.deepEqual(care.scamPending(id).official, { checked: true, found: false, name: null }, 'the dashboard still says: no official source, nothing from the web page');
});

test('chat: a link not on the allow-list is searched; address match / mismatch against the sites found', async () => {
  const id = senior(); setup(PAGES, {}, 'warn');
  await chat.sendText(id, 'The text says to claim my prize at free-gift-prize.example/claim and give the code they sent.', null);
  assert.match(roster(), /WEB CHECK/); assert.match(roster(), /site scamwatch\.example/); assert.match(roster(), /NOT one of the sites found; that alone does not prove anything/);
  assert.doesNotMatch(roster(), /RECONFIRM \(a fact/, 'the search gave something, so no question is needed');
  const m = await W.lookup('see harbourlight.example/login', { fetch: tavily({ 'harbourlight.example': PAGES.harbour }), key: KEY, scam: true });
  assert.equal(m.topics[0].address, 'match');
});

test('chat: a general question (medicine) is searched even without a scam', async () => {
  const id = senior(); setup(PAGES);
  await chat.sendText(id, 'Is it safe to take Metformin with my breakfast?', null);
  const r = roster();
  assert.doesNotMatch(r, /SCAM CHECK/); assert.match(r, /WEB CHECK/); assert.match(r, /site nhs\.example/); assert.match(r, /Ask a pharmacist/); assert.match(r, /not medical advice: suggest their doctor or pharmacist/);
  assert.doesNotMatch(r, /plain\.example|10\.0\.0\.5|evil\.example/);
});

test('chat: no search service / search failure on a question: she is told it cannot be verified, the reply is not blocked, nothing invented', async () => {
  for (const o of [{ key: null }, { status: 500 }, { throws: true }]) {
    const id = senior(); setup(PAGES, o);
    const out = await chat.sendText(id, 'I heard that the pension is going up next month, is it true?', null);
    assert.equal(out.messages[1].kind, 'text', 'the reply still comes');
    assert.match(roster(), /WEB CHECK/); assert.match(roster(), /NOTHING can be verified/); assert.match(roster(), /say plainly that you cannot verify it right now/); assert.doesNotMatch(roster(), /site [a-z0-9.-]+\.[a-z]+, titled/);
  }
  const id = senior(); setup(PAGES); chat.deps.web = async () => { throw new Error('boom'); };
  const out = await chat.sendText(id, 'Is it safe to take Metformin with my breakfast?', null);
  assert.equal(out.messages[1].kind, 'text'); assert.match(roster(), /NOTHING can be verified/);
});

test('chat: a scam company with a failed search: official none AND web cannot verify; no company and no link still goes to the one question', async () => {
  const id = senior(); setup(PAGES, { status: 500 }, 'warn');
  await chat.sendText(id, 'A man from Harbour Light Bank rang me and wants me to read out the code in my text.', null);
  assert.match(roster(), /NO official source/); assert.match(roster(), /NOTHING can be verified/);
  const id2 = senior(); setup(PAGES, {}, 'warn');
  await chat.sendText(id2, 'My bank texted me to read out the code that was sent to me, they said it is urgent.', null);
  assert.match(roster(), /RECONFIRM \(a fact/); assert.doesNotMatch(roster(), /WEB CHECK/); assert.equal(sent.length, 0);
});

test('ordinary chat, safety and self-harm: no search at all; the key never appears in anything Maya, the family or the log sees', async () => {
  const id = senior(); setup(PAGES);
  await chat.sendText(id, 'I made soup today and it smelled lovely.', null);
  assert.equal(sent.length, 0); assert.doesNotMatch(roster(), /WEB CHECK/);
  await chat.sendText(id, 'I feel like ending it all, is it true that nobody would notice?', null);
  assert.equal(sent.length, 0, 'never a web search on a safety turn');
  const id2 = senior(); setup(PAGES);
  await chat.sendText(id2, 'Is it safe to take Metformin with my breakfast?', null);
  const everything = JSON.stringify({ asked, view: care.view(id2), thread: chat.thread(id2) });
  assert.ok(!everything.includes(KEY)); assert.ok(sent.every((x) => !x.opts.body.includes(KEY)));
});

test.after(() => { for (const s of chat.sessions.values()) s.finish(); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
