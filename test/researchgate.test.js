// RESEARCH gate + evidence filter + source binding for DAILY-LIFE research (news, public claims, links), end to end through typed chat (chat.sendText -> deps.web -> web.lookup).
// STUBBED evidence: Tavily and Spark are fakes. They show routing decisions, exact outbound queries, accept / reject reasons and payloads; they say nothing about real search quality or the real model.
// MEDICINE is not researched at all (medical.js); its tests are in medical.test.js. The stub Spark answers from the accepted passage when there is one (process.env.RG_REPLY overrides its words).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-rg-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (_h, roster, _s, onDelta) => {
    asked.push({ roster }); const TAG = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
    const m = /a suitable source states[^:]*: 1\. site \S+ \([^)]*\): "([^"]+)"/.exec(roster);
    const body = process.env.RG_REPLY || (m ? m[1] : /could not verify|cannot be verified|cannot verify|NOTHING can be verified/i.test(roster) ? 'I could not verify that one.' : 'Okay, I am here.');
    const t = `${TAG} ${body}`; if (onDelta) onDelta(t); return t; } } };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat'); const S = require('../scam'); const O = require('../official'); const W = require('../web');
const sent = []; let table = {}; let lastG = null;
const fakeTavily = async (url, opts) => { const q = JSON.parse(opts.body).query; sent.push(q); const hit = Object.entries(table).find(([k]) => q.includes(k)); return { ok: true, status: 200, text: async () => JSON.stringify({ results: hit ? hit[1] : [], response_time: 0.1, request_id: 'r' }) }; };
const wire = (level = 'none', tbl = {}) => {
  W.cache.clear(); W.spent.length = 0; sent.length = 0; table = tbl; delete process.env.RG_REPLY;
  chat.deps.web = async (w, opts) => { lastG = await W.lookup(w, { ...opts, fetch: fakeTavily, key: 'tvly-test-key' }); return lastG; };
  chat.deps.official = (w, opts) => O.check(w, { ...opts, fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' }) });
  const sig = Object.fromEntries(S.SIGNALS.map((k) => [k, false]));
  chat.deps.scamText = async () => ({ level, type: 'scam', reading: 'x', signals: sig, reads: Object.fromEntries(S.READS.map((k) => [k, false])), count: 0 });
};
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Rgt${letters(n++)}`, 'female').id;
const page = (host, title, content, p = '/x') => ({ title, url: `https://${host}${p}`, content });
const KERALA = { flood: [page('www.bbc.com', 'Kerala floods', 'Heavy rain has caused floods across Kerala this week and thousands of people have left their homes.', '/news/kerala-floods'), page('www.reuters.com', 'Floods in Kerala', 'Floods across Kerala have forced thousands of people to leave their homes after heavy rain.', '/world/kerala'), page('apnews.com', 'Kerala flood news', 'Kerala floods this week: heavy rain has left thousands of people without their homes.', '/kerala')] };
const BUSES = { council: [page('www.bbc.com', 'Council confirms Sunday bus changes', 'The council will stop the Sunday buses next month on three rural routes.', '/news/council-sunday-buses')] };
const EVIDENCE = [];
async function turn(id, label, text, context = null) {
  const before = sent.length; lastG = null; const askedBefore = asked.length;
  const out = await chat.sendText(id, text, null); const maya = out.messages[1], g = lastG, tp = g && g.topics && g.topics[0], dec = g && g.decision;
  const ev = { case: label, input: text, context, turnId: out.messages[0].id, researchDecision: dec ? dec.decision : (tp ? 'research' : 'none'), resolvedQuestion: tp ? { kind: tp.kind, meaning: tp.meaning, query: tp.query } : null, cache: tp ? tp.cache : null, outboundQueries: sent.slice(before), outboundCount: sent.length - before,
    candidates: tp && tp.candidates ? tp.candidates.map((c) => ({ host: c.host, tier: c.tier, accepted: c.accepted, support: c.support.ok ? `OK: ${c.support.passage}` : `REJECTED: ${c.support.reason}`, suitability: c.suitability.ok ? `OK: ${c.suitability.reason}` : `REJECTED: ${c.suitability.reason}` })) : null, status: tp ? tp.status || null : null,
    finalAnswer: maya.text, hasSourcesKey: 'sources' in maya, sources: maya.sources || [], eye: Boolean(maya.sources && maya.sources.length), panel: (maya.sources || []).map((x) => `${x.site} | ${x.title} | ${x.excerpt} | ${x.url}`), noteToSpark: asked.length > askedBefore ? (asked.at(-1).roster.match(/(?:WEB CHECK)[^]*$/) || [null])[0] : null };
  EVIDENCE.push(ev); return ev;
}
test.after(() => { console.log('RESEARCH-GATE EVIDENCE (STUBBED Tavily + Spark, local, through chat.sendText)\n' + JSON.stringify(EVIDENCE, null, 1)); care.stop(); });

test('R1 companion-care: no research; a news question gets ONE targeted query; the pasted error right after it: no research, no sources, no eye, no source metadata', async () => {
  const id = senior(); wire('none', KERALA);
  const a = await turn(id, 'R1 companion-care', 'how can you take care of me?');
  assert.equal(a.outboundCount, 0); assert.equal(a.hasSourcesKey, false); assert.equal(a.eye, false); assert.doesNotMatch(asked.at(-1).roster, /WEB CHECK/);
  const b = await turn(id, 'R1 news', 'what is the latest news about the flood in Kerala?');
  assert.deepEqual(b.outboundQueries, ['flood kerala latest news']); assert.equal(b.researchDecision, 'research'); assert.equal(b.status, 'supported');
  const c = await turn(id, 'R1 error paste after the factual turn', 'this.compactRoster is not a function');
  assert.equal(c.outboundCount, 0); assert.equal(c.hasSourcesKey, false); assert.equal(c.eye, false); assert.doesNotMatch(asked.at(-1).roster, /WEB CHECK/);
});

test('R2 adequate evidence: three suitable pages are accepted, at most 2 links attach, each with its supporting passage and https URL, and only because the final answer uses them', async () => {
  const id = senior(); wire('none', KERALA);
  const r = await turn(id, 'R2 adequate', 'what is the latest news about the flood in Kerala?');
  assert.equal(r.candidates.length, 3); assert.equal(r.candidates.filter((c) => c.accepted).length, 3); assert.equal(r.sources.length, 2, 'at most 2'); assert.deepEqual(r.sources.map((x) => x.site), ['bbc.com', 'reuters.com']);
  assert.ok(r.sources.every((x) => /^https:\/\//.test(x.url) && /Kerala/.test(x.excerpt)));
  const id2 = senior(); wire('none', KERALA); process.env.RG_REPLY = 'Okay, thank you for telling me about that.';
  const c = await turn(id2, 'R2b answer does not use the pages', 'what is the latest news about the flood in Kerala?'); assert.equal(c.status, 'supported'); assert.equal(c.eye, false); assert.equal(c.hasSourcesKey, false);
});

test('R3 a public claim: the query is the proposition (privacy-safe); a relevant tier-2 page is accepted; a bare "is that true?" resolves from the previous message only', async () => {
  const id = senior(); wire('none', BUSES);
  const a = await turn(id, 'R3 claim', 'I heard that the council will stop the Sunday buses next month, is it true?');
  assert.deepEqual(a.outboundQueries, ['the council will stop the Sunday buses next month']); assert.equal(a.eye, true); assert.equal(a.sources[0].site, 'bbc.com');
  const id2 = senior(); wire('none', BUSES); await turn(id2, 'R3b statement', 'the council will stop the Sunday buses next month');
  const b = await turn(id2, 'R3b bare "is that true?"', 'is that true?', 'the previous message is the claim');
  assert.deepEqual(b.outboundQueries, ['the council will stop the Sunday buses next month']);
  const id3 = senior(); wire('none', BUSES); const c = await turn(id3, 'R3c nothing before it', 'is that true?'); assert.equal(c.outboundCount, 0);
});

test('R4 a changed subject is a NEW question (new key, miss, own request): the earlier page cannot qualify just because it is also a news page; a subject switch to small talk attaches nothing', async () => {
  const id = senior(); wire('none', { flood: [KERALA.flood[0]] });   // the only page this stub has: about Kerala
  const a = await turn(id, 'R4 Kerala', 'what is the latest news about the flood in Kerala?'); assert.equal(a.eye, true);
  const b = await turn(id, 'R4 Assam', 'what is the latest news about the flood in Assam?', 'one place changed, wording nearly identical');
  assert.deepEqual(b.outboundQueries, ['flood assam latest news']); assert.equal(b.cache, 'miss'); assert.equal(b.status, 'unverified'); assert.match(b.candidates[0].support, /REJECTED: matches only/); assert.equal(b.eye, false); assert.equal(b.hasSourcesKey, false);
  const t = await turn(id, 'R4 small talk', 'I think my tomatoes will be ready next week'); assert.equal(t.outboundCount, 0); assert.equal(t.hasSourcesKey, false); assert.equal(t.eye, false);
});

test('R5 relevant but LOW-TRUST evidence fails suitability; TRUSTED but IRRELEVANT evidence fails support; no results is unverified: none produces an eye', async () => {
  const id = senior(); wire('none', { flood: [page('kerala-news.example', 'Kerala floods', KERALA.flood[0].content)] });
  const a = await turn(id, 'R5 low trust', 'what is the latest news about the flood in Kerala?'); assert.ok(a.candidates[0].support.startsWith('OK')); assert.match(a.candidates[0].suitability, /REJECTED: tier 3/); assert.equal(a.status, 'unverified'); assert.equal(a.eye, false); assert.equal(a.hasSourcesKey, false); assert.match(a.finalAnswer, /could not verify/);
  const id2 = senior(); wire('none', { flood: [page('www.bbc.com', 'Garden tips', 'Spring is a good time to plant tomatoes and sweet peas in a sunny border.'), page('www.reuters.com', 'Markets', 'Shares rose on Tuesday as investors waited for the central bank decision.', '/m')] });
  const b = await turn(id2, 'R5 irrelevant trusted', 'what is the latest news about the flood in Kerala?'); assert.ok(b.candidates.every((c) => !c.accepted && /REJECTED/.test(c.support) && /^OK/.test(c.suitability))); assert.equal(b.eye, false);
  const id3 = senior(); wire('none', {}); const c = await turn(id3, 'R5 insufficient', 'what is the latest news about the flood in Kerala?'); assert.equal(c.status, 'unverified'); assert.equal(c.eye, false); assert.match(c.noteToSpark, /found NO usable page/);
});

test('R6 a rewrite / fallback that no longer uses the research keeps NO attribution', async () => {
  const id = senior(); wire('none', KERALA); process.env.RG_REPLY = 'I want to get this right. Could you tell me a little more about what you mean?';
  const r = await turn(id, 'R6 fallback', 'what is the latest news about the flood in Kerala?'); assert.equal(r.status, 'supported'); assert.equal(r.eye, false); assert.equal(r.hasSourcesKey, false);
  const id2 = senior(); wire('none', KERALA); process.env.RG_REPLY = "I can't verify that from what I found."; const q = await turn(id2, 'R6b could-not-verify reply', 'what is the latest news about the flood in Kerala?'); assert.equal(q.eye, false);
});

test('R7 scam regression: an explicit scam check still reaches the checking route (link: background check; company: official + web), a dotted code identifier is not a link; scam.js is untouched', async () => {
  const id = senior(); wire('warn', {});
  await turn(id, 'R7 scam link', 'The text says to claim my prize at free-gift-prize.example/claim and give the code they sent.');
  assert.match(asked.at(-1).roster, /BACKGROUND CHECK STARTED/); await require('../checks').idle(); assert.deepEqual(sent, ['free-gift-prize.example scam phishing reports']);
  const id2 = senior(); wire('warn', {}); await turn(id2, 'R7 scam company', 'A man from Harbour Light Bank rang me and wants me to read out the code in my text.'); assert.match(asked.at(-1).roster, /NO official source|RECONFIRM/);
  const id3 = senior(); wire('warn', {}); await turn(id3, 'R7 dotted identifier', 'this.compactRoster is not a function and they want my code'); assert.ok(!sent.some((q) => /compactroster/i.test(q)));
  assert.equal(require('child_process').execFileSync('git', ['diff', '--stat', '--', 'scam.js'], { cwd: path.join(__dirname, '..') }).toString().trim(), '', 'scam.js untouched');
});

test('voice stays outside this fix: call.js has no web lookup and the voice persona keeps its no-lookups rule', () => {
  const callSrc = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'); assert.ok(!/require\('\.\/web'\)/.test(callSrc), 'call.js must not require web.js');
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8'); assert.match(brainSrc, /You can only talk right now: no lookups or calls/);
});

test('web.extract / decide unit: one factual need = one query; a dotted code identifier is never a host; privacy; medicine is never a topic', () => {
  const q = (w, o) => W.extract(w, o).map((t) => `${t.kind}:${t.query}`);
  assert.deepEqual(q('what is the latest news about the flood in Kerala?'), ['news:flood kerala latest news']);
  assert.deepEqual(q('how can you take care of me?'), []); assert.deepEqual(q('take care of me'), []); assert.deepEqual(q('this.compactRoster is not a function'), []); assert.deepEqual(q('this.compactRoster is not a function', { scam: true }), []);
  assert.deepEqual(q('I heard that the pension is going up next month, my account 12345678, call me on 0412 345 678 or a.b@mail.example, is it true?'), ['claim:the pension is going up next month']);
  assert.deepEqual(q('is that true?', { ctx: { prevUser: 'the council will stop the Sunday buses next month, is that true' } }), ['claim:the council will stop the Sunday buses next month']);
  assert.deepEqual(q('is that true?', { ctx: { prevUser: 'this.compactRoster is not a function' } }), []);
  assert.deepEqual(q('They sent a link free-gift-prize.example/claim and I should click it', { scam: true }), ['link:free-gift-prize.example scam phishing reports']);
  assert.deepEqual(q('they sent me free-gift-prize.example/claim'), []); assert.deepEqual(q('is free-gift-prize.example/claim a real link?'), ['link:free-gift-prize.example scam phishing reports']);
  assert.deepEqual(q('I feel like ending it all, is it true that nobody would notice?'), []);
  assert.deepEqual(q('is it safe to take ibuprofen with warfarin?'), [], 'a medicine question is never a topic'); assert.equal(W.decide('is it safe to take ibuprofen with warfarin?').decision, 'refuse');
  assert.deepEqual(q('My doctor gave me ibuprofen. What is the latest news about the flood in Kerala?'), ['news:flood kerala latest news'], 'an incidental medicine mention is left out of the query');
  assert.equal(W.decide('and with aspirin?', { ctx: {} }), null, 'no context: a bare fragment authorises nothing');
});
