// RESEARCH reuse + clearing for DAILY-LIFE research, per-senior cache scoping, and the unconditional voice claim block. STUBBED Tavily + Spark through the real chat.sendText / Call.respond.
// The cache identity is SENIOR + RESOLVED QUESTION (kind, relation, the subject's words); a hit only supplies candidates, every reply judges them again (support + suitability) and keeps a link only if ITS OWN final answer uses it.
// Medicine is never researched, so it has no cache entry at all (medical.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-rr-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const asked = []; let voiceReplies = [], voiceCalls = 0, sparkMode = 'chat', forceReply = null;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused', stats: [], META_URL: '', liveModel: () => 'x', COMPACT_MARK: '[[COMPACT]]', developerContent: () => '', SHORT_PERSONA: '',
  sparkStream: async (_h, roster, _s, onDelta) => {
    asked.push({ roster }); const TAG = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0 topic=same personal=0]]';
    let body;
    if (forceReply) body = forceReply;
    else if (sparkMode === 'voice') { body = /Write your short line now/.test(_h[_h.length - 1].content) ? 'Okay.' : voiceReplies[Math.min(voiceCalls++, voiceReplies.length - 1)]; }
    else { const m = /a suitable source states[^:]*: 1\. site \S+ \([^)]*\): "([^"]+)"/.exec(roster); body = m ? m[1] : /could not verify|cannot be verified|cannot verify|NOTHING can be verified/i.test(roster) ? 'I could not verify that one.' : 'Okay, I am here.'; }
    const t = `${TAG} ${body}`; if (onDelta) onDelta(t); return t; } } };
const memory = require('../memory'); const care = require('../care'); const chat = require('../chat'); const S = require('../scam'); const O = require('../official'); const W = require('../web'); const { Call } = require('../call');
const sent = []; let table = {}; let lastG = null;
const fakeTavily = async (url, opts) => { const q = JSON.parse(opts.body).query; sent.push(q); const hit = Object.entries(table).find(([k]) => q.includes(k)); return { ok: true, status: 200, text: async () => JSON.stringify({ results: hit ? hit[1] : [] }) }; };
const wire = (level = 'none', tbl = {}) => {
  W.cache.clear(); W.spent.length = 0; sent.length = 0; table = tbl; sparkMode = 'chat';
  chat.deps.web = async (w, opts) => { lastG = await W.lookup(w, { ...opts, fetch: fakeTavily, key: 'tvly-test-key' }); return lastG; };
  chat.deps.official = (w, opts) => O.check(w, { ...opts, fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' }) });
  const sig = Object.fromEntries(S.SIGNALS.map((k) => [k, false]));
  chat.deps.scamText = async () => ({ level, type: 'scam', reading: 'x', signals: sig, reads: Object.fromEntries(S.READS.map((k) => [k, false])), count: 0 });
};
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Rru${letters(n++)}`, 'female').id;
const page = (host, title, content, p = '/x') => ({ title, url: `https://${host}${p}`, content });
const KERALA = { flood: [page('www.bbc.com', 'Kerala floods', 'Heavy rain has caused floods across Kerala this week and thousands of people have left their homes.', '/news/kerala-floods'), page('www.reuters.com', 'Floods in Kerala', 'Floods across Kerala have forced thousands of people to leave their homes after heavy rain.', '/world/kerala'), page('apnews.com', 'Kerala flood news', 'Kerala floods this week: heavy rain has left thousands of people without their homes.', '/kerala')] };
const ASK = 'what is the latest news about the flood in Kerala?';
const EVIDENCE = [];
async function turn(id, label, text, context = null) {
  const before = sent.length; lastG = null;
  const out = await chat.sendText(id, text, null); const maya = out.messages[1], g = lastG, tp = g && g.topics && g.topics[0], dec = g && g.decision;
  const ev = { case: label, input: text, context, turnId: out.messages[0].id, researchDecision: dec ? dec.decision : (tp ? 'research' : 'none'), resolvedQuestion: tp ? { kind: tp.kind, meaning: tp.meaning, query: tp.query } : null, cacheKey: tp ? tp.cacheKey : null, cacheAgeMs: tp ? tp.cacheAgeMs : null, cache: tp ? tp.cache : null,
    outboundQueries: sent.slice(before), outboundCount: sent.length - before, status: tp ? tp.status || null : null, candidates: tp && tp.candidates ? tp.candidates.map((c) => `${c.host}:${c.accepted ? 'ACCEPT' : 'REJECT'}`) : null,
    finalAnswer: maya.text, hasSourcesKey: 'sources' in maya, sources: maya.sources || [], eye: Boolean(maya.sources && maya.sources.length), panel: (maya.sources || []).map((x) => `${x.site} | ${x.title} | ${x.excerpt} | ${x.url}`) };
  EVIDENCE.push(ev); return ev;
}
test.after(() => { console.log('RESEARCH-REUSE EVIDENCE (STUBBED Tavily + Spark, local)\n' + JSON.stringify(EVIDENCE, null, 1)); care.stop(); });

test('1 repeat inside the fresh cache: the same key, a cache age, a hit, ZERO new Tavily requests; the answer keeps only its bounded links and the list does not grow; 61 minutes later it is a miss again', async () => {
  const id = senior(); wire('none', KERALA);
  const a = await turn(id, '1 first ask', ASK);
  assert.equal(a.cache, 'miss'); assert.equal(a.outboundCount, 1); assert.equal(a.sources.length, 2); assert.match(a.cacheKey, new RegExp(`^${id}\\|news\\|news\\|flood kerala$`));
  const key = a.cacheKey; W.cache.get(key).at -= 30 * 60000;   // 30 minutes old: still fresh
  const b = await turn(id, '1 repeat, other wording', 'any news about the Kerala flood?', 'same resolved question, different words and word order, 30 minutes later');
  assert.equal(b.cacheKey, key, 'the same key: it represents the resolved question, not the wording'); assert.equal(b.cache, 'hit'); assert.ok(b.cacheAgeMs >= 29 * 60000 && b.cacheAgeMs < 31 * 60000, `age ${b.cacheAgeMs}`); assert.equal(b.outboundCount, 0, 'no new Tavily request');
  assert.equal(b.sources.length, 2, 'at most 2, never accumulating'); assert.deepEqual(b.sources.map((x) => x.site), a.sources.map((x) => x.site));
  const c = await turn(id, '1 third time', ASK); assert.equal(c.cache, 'hit'); assert.equal(c.sources.length, 2, 'still 2 after three asks'); assert.equal(chat.thread(id).filter((m) => m.role === 'maya' && m.sources).every((m) => m.sources.length <= 2), true);
  W.cache.get(key).at -= 31 * 60000;   // now 61+ minutes old: past the 60-minute lifetime
  const d = await turn(id, '1 after expiry', ASK); assert.equal(d.cache, 'miss', 'expired entries are not reused'); assert.equal(d.outboundCount, 1);
});

test('1b a cache hit alone attaches nothing: the reply starts with no evidence, and a reply that does not use the finding keeps no links even though the entry is fresh', async () => {
  const id = senior(); wire('none', KERALA); await turn(id, '1b warm', ASK);
  forceReply = 'Okay, thank you for telling me about that.';
  try { const r = await turn(id, '1b hit, reply ignores it', ASK); assert.equal(r.cache, 'hit'); assert.equal(r.eye, false); assert.equal(r.hasSourcesKey, false); } finally { forceReply = null; }
});

test('2 subject change: a factual answer, then tomatoes / small talk: no search, no unrelated sources, no source metadata; the old entry is merely stored, not attached', async () => {
  const id = senior(); wire('none', KERALA); await turn(id, '2 factual', ASK);
  const t = await turn(id, '2 tomatoes', 'I think my tomatoes will be ready next week'); assert.equal(t.researchDecision, 'none'); assert.equal(t.outboundCount, 0); assert.equal(t.hasSourcesKey, false); assert.equal(t.eye, false); assert.deepEqual(t.panel, []);
  assert.ok(W.cache.size >= 1, 'unrelated cache entries may stay stored');
  const u = await turn(id, '2 fragment with no context', 'and in Assam?'); assert.equal(u.researchDecision, 'none', 'a bare fragment authorises nothing'); assert.equal(u.hasSourcesKey, false);
});

test('3 changed meaning-relevant context with similar wording is a NEW question: new key, miss, its own outbound; the old page cannot qualify by wording; a claim and a news question about the same words are different questions', async () => {
  const id = senior(); wire('none', { flood: [KERALA.flood[0]] });   // the only page this stub has: about Kerala
  const a = await turn(id, '3 Kerala', ASK); assert.equal(a.eye, true);
  const b = await turn(id, '3 Assam', 'what is the latest news about the flood in Assam?', 'one place changed, wording nearly identical');
  assert.notEqual(b.cacheKey, a.cacheKey); assert.match(b.cacheKey, /assam flood$/); assert.equal(b.cache, 'miss'); assert.equal(b.outboundCount, 1); assert.equal(b.status, 'unverified'); assert.deepEqual(b.candidates, ['bbc.com:REJECT']); assert.equal(b.eye, false);
  const c = await turn(id, '3 claim, same words', 'I heard that the flood in Kerala is over, is it true?'); assert.notEqual(c.cacheKey, a.cacheKey); assert.equal(c.cache, 'miss');
  const d = await turn(id, '3 back to the first', ASK); assert.equal(d.cacheKey, a.cacheKey); assert.equal(d.cache, 'hit', 'the first question is still its own entry');
});

test('4 cross-senior: senior A\'s query, evidence and sources never reach senior B (same question, a different question, no question, a fragment, and a caller with no scope)', async () => {
  const A = senior(), B = senior(); wire('none', KERALA);
  const a = await turn(A, '4 A asks', ASK); assert.equal(a.eye, true);
  table = {};   // A's pages are gone from the stub: only A's CACHE could still hold them
  const b1 = await turn(B, '4 B asks the SAME question', ASK, 'senior B, A\'s entry is fresh');
  assert.equal(b1.cache, 'miss', 'B does not see A\'s entry'); assert.equal(b1.outboundCount, 1, 'B makes its own request'); assert.notEqual(b1.cacheKey, a.cacheKey); assert.ok(b1.cacheKey.startsWith(`${B}|`) && a.cacheKey.startsWith(`${A}|`));
  assert.equal(b1.status, 'unverified'); assert.equal(b1.eye, false); assert.equal(b1.hasSourcesKey, false, 'no A sources');
  const b2 = await turn(B, '4 B asks something else', 'I heard that the council will stop the Sunday buses next month, is it true?'); assert.ok(!b2.sources.some((x) => /bbc|reuters|apnews/.test(x.site)));
  const b3 = await turn(B, '4 B small talk', 'the garden looks lovely'); assert.equal(b3.outboundCount, 0); assert.equal(b3.hasSourcesKey, false); assert.equal(b3.eye, false);
  const b4 = await turn(B, '4 B fragment', 'and in Assam?'); assert.equal(b4.researchDecision, 'none'); assert.equal(b4.outboundCount, 0);
  table = KERALA; sent.length = 0; W.cache.clear(); const r1 = await W.lookup(ASK, { fetch: fakeTavily, key: 'k' }); const r2 = await W.lookup(ASK, { fetch: fakeTavily, key: 'k' });
  assert.equal(sent.length, 2, 'no scope = no cache'); assert.equal(r1.topics[0].cache, 'miss'); assert.equal(r2.topics[0].cache, 'miss'); assert.equal(W.cache.size, 0);
});

// ---- voice: no lookup exists, so no reply may claim one. Unconditional: the same result with the smart GUARD flags on and off. ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const madeCalls = [];
async function voiceSays(drafts, flags, said0 = 'what is the weather like in Kerala today') {
  const keep = {}; for (const k of ['MAYA_SMART_GUARD', 'MAYA_SMART_STATE_GUARD', 'MAYA_SMART_COMPANION']) { keep[k] = process.env[k]; if (flags) process.env[k] = 'on'; else delete process.env[k]; }
  const fetches = []; const realFetch = global.fetch; global.fetch = (u, o) => { fetches.push(String(u)); return realFetch(u, o); };
  try {
    sparkMode = 'voice'; voiceReplies = drafts; voiceCalls = 0;
    const p = memory.createProfile(`Voi${letters(n++)}`, 'female'); care.get(p.id).tz = 'America/New_York';
    const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); c.profile = memory.load(p.id); c.callId = `v${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController();
    c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; madeCalls.push(c);
    c.pending = [{ text: said0, partial: said0, spans: [{ label: 'A', end: said0.length }], endedAt: Date.now(), completedAt: Date.now() }]; await c.respond(0); await sleep(40);
    const said = c.history.filter((m) => m.role === 'assistant').map((m) => m.content.replace(/\[\[[^\]]*\]\]/g, '').trim()).join(' | ');
    return { said, fetches: fetches.filter((u) => /tavily/.test(u)), sparkCalls: voiceCalls };
  } finally { global.fetch = realFetch; sparkMode = 'chat'; for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
}
test.after(() => { for (const c of madeCalls) { try { c.end(); } catch { /* over */ } } });
const CLAIMS = ["I've just looked that up and it is raining in Kerala.", 'I searched online and it is dry.', "I checked the latest sources and they say it's sunny.", 'My search shows no problem.', 'According to my search it is okay.', 'I verified it with the weather service.'];
test('5 voice claim block: a voice reply that claims it searched / looked up / checked sources / verified is blocked and rewritten; if the rewrite claims it too, only a plain true line is spoken; no lookup is added; same with the GUARD flags ON and OFF', async () => {
  for (const flags of [false, true]) for (const claim of CLAIMS) {
    const one = await voiceSays([`${claim} Please take care.`, 'I am not able to check that from here, so a weather page would be the best place.'], flags);
    assert.doesNotMatch(one.said, /looked that up|searched|latest sources|my search|according to|verified/i, `flags ${flags}: ${claim} -> ${one.said}`); assert.match(one.said, /not able to check that from here/, 'the clean rewrite is what is spoken'); assert.equal(one.sparkCalls, 2, 'one rewrite'); assert.deepEqual(one.fetches, [], 'voice added no lookup');
    const both = await voiceSays([`${claim} Please take care.`, `${claim} Really.`], flags);
    assert.doesNotMatch(both.said, /looked that up|searched|latest sources|my search|according to|verified/i, `flags ${flags}: second draft ${claim} -> ${both.said}`); assert.match(both.said, /I'm not able to look things up while we're talking, so I haven't checked that/, `the plain true line, flags ${flags}`); assert.deepEqual(both.fetches, []);
  }
});
test('5b the block is narrow: honest voice replies pass (a denial, a general answer), and the chat channel is not touched', async () => {
  for (const ok of ['I am not able to look things up while we talk, so a weather page is the best place.', 'I have not checked that, so I do not want to guess.', 'Kerala is on the south west coast, so it gets a lot of rain in the monsoon.', 'Let me think about that with you.']) { const r = await voiceSays([ok], false); assert.match(r.said, new RegExp(ok.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ok); assert.equal(r.sparkCalls, 1, `not blocked: ${ok}`); }
  const callSrc = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'); assert.ok(!/require\('\.\/web'\)/.test(callSrc), 'call.js still has no web lookup');
});

test('6 scam regression: the explicit checking routes still work and are scoped per senior too; scam.js untouched', async () => {
  const A = senior(), B = senior(); wire('warn', {});
  await turn(A, '6 A scam link', 'The text says to claim my prize at free-gift-prize.example/claim and give the code they sent.'); assert.match(asked.at(-1).roster, /BACKGROUND CHECK STARTED/); await require('../checks').idle();
  await turn(B, '6 B scam link, same address', 'The text says to claim my prize at free-gift-prize.example/claim and give the code they sent.'); await require('../checks').idle();
  assert.deepEqual(sent, ['free-gift-prize.example scam phishing reports', 'free-gift-prize.example scam phishing reports'], 'each senior\'s check made its own request');
  assert.equal(require('child_process').execFileSync('git', ['diff', '--stat', '--', 'scam.js'], { cwd: path.join(__dirname, '..') }).toString().trim(), '', 'scam.js untouched');
});
