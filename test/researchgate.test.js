// RESEARCH Steps 2 (intent gate, follow-up interpretation) + 3 (evidence filter + source binding), end to end through typed chat (chat.sendText -> deps.web -> web.lookup).
// STUBBED evidence: Tavily and Spark are fakes. They show routing decisions, exact outbound queries, accept/reject reasons and payloads; they say nothing about real search quality or the real model.
// The stub Spark FOLLOWS ITS FACTS (process.env.RG_REPLY overrides its words to model a bad / fallback reply). Step 4 (reuse / clearing) is NOT here.
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
    const body = process.env.RG_REPLY || (/a suitable source states/.test(roster) ? 'Taking those together can raise the risk of bleeding, so please ask your pharmacist or doctor first.' : /CLARIFY BEFORE ANSWERING/.test(roster) ? 'Do you mean that in place of one of them, or together with both?' : /UNVERIFIED|could not verify|cannot be verified|cannot verify|DISAGREE/i.test(roster) ? 'I could not verify that, so please ask your pharmacist or doctor.' : 'Okay, I am here.');
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
const IBU_WAR = 'Taking ibuprofen with warfarin can raise the risk of bleeding. Ask a pharmacist or doctor first.';
const GOOD = { 'ibuprofen warfarin': [page('www.nhs.uk', 'Ibuprofen and warfarin', IBU_WAR, '/medicines/ibuprofen-warfarin/'), page('www.mayoclinic.org', 'Warfarin interactions', 'Ibuprofen and other NSAIDs increase the risk of bleeding in people who take warfarin, so avoid the combination unless a doctor says otherwise.', '/drugs/warfarin'), page('medlineplus.gov', 'Warfarin', 'Do not take ibuprofen with warfarin without asking your doctor because the combination raises the risk of serious bleeding.', '/warfarin')] };
const EVIDENCE = [];
async function turn(id, label, text, extra = {}) {
  const before = sent.length, cacheBefore = W.cache.size; lastG = null; const askedBefore = asked.length;
  const out = await chat.sendText(id, text, null); const maya = out.messages[1], g = lastG, tp = g && g.topics && g.topics[0], dec = g && g.decision;
  const ev = { case: label, input: text, context: extra.context || null, turnId: out.messages[0].id, researchDecision: dec ? dec.decision : (tp ? 'research' : 'none'), resolvedMeaning: tp ? tp.meaning : dec && dec.clarify ? { clarify: dec.clarify } : dec && dec.unverified ? { unverified: dec.unverified } : null, resolvedFrom: tp ? tp.resolvedFrom : null,
    query: tp ? tp.query : null, cache: tp ? tp.cache : null, outboundQueries: sent.slice(before), outboundCount: sent.length - before,
    candidates: tp && tp.candidates ? tp.candidates.map((c) => ({ title: c.title, host: c.host, tier: c.tier, accepted: c.accepted, support: c.support.ok ? `OK: ${c.support.passage}` : `REJECTED: ${c.support.reason}`, suitability: c.suitability.ok ? `OK: ${c.suitability.reason}` : `REJECTED: ${c.suitability.reason}` })) : null, status: tp ? tp.status || null : null,
    finalAnswer: maya.text, hasSourcesKey: 'sources' in maya, sources: maya.sources || [], eye: Boolean(maya.sources && maya.sources.length), panel: (maya.sources || []).map((x) => `${x.site} | ${x.title} | ${x.excerpt} | ${x.url}`), noteToSpark: asked.length > askedBefore ? asked.at(-1).roster.match(/(?:WEB CHECK|CLARIFY BEFORE ANSWERING|UNVERIFIED)[^]*$/)?.[0] || null : null };
  EVIDENCE.push(ev); return ev;
}
test.after(() => { console.log('RESEARCH-GATE EVIDENCE (STUBBED Tavily + Spark, local, through chat.sendText)\n' + JSON.stringify(EVIDENCE, null, 1)); care.stop(); });

test('1-3 (Step 2) companion-care no research; the specific factual gets ONE targeted query; the pasted error right after it: no research, no sources, no eye, no source metadata', async () => {
  const id = senior(); wire('none', GOOD);
  const a = await turn(id, '1 companion-care', 'how can you take care of me?');
  assert.equal(a.outboundCount, 0); assert.equal(a.hasSourcesKey, false, 'no-research reply has NO source metadata'); assert.equal(a.eye, false); assert.doesNotMatch(asked.at(-1).roster, /WEB CHECK/);
  const b = await turn(id, '2 specific factual', 'is it safe to take ibuprofen with warfarin?');
  assert.deepEqual(b.outboundQueries, ['ibuprofen warfarin interaction safety']); assert.equal(b.researchDecision, 'research'); assert.deepEqual(b.resolvedMeaning.ents, ['ibuprofen', 'warfarin']);
  const c = await turn(id, '3 error paste after the factual turn', 'this.compactRoster is not a function');
  assert.equal(c.outboundCount, 0); assert.equal(c.hasSourcesKey, false); assert.equal(c.eye, false); assert.doesNotMatch(asked.at(-1).roster, /WEB CHECK/);
});

test('C1 unambiguous follow-up: "and with aspirin?" after a SINGLE-drug question is a fully resolved question (explicit "with"); the pair + "as well" joins all three; resolved meaning and the actual query are shown', async () => {
  const id = senior(); wire('none', { 'ibuprofen aspirin': [page('www.nhs.uk', 'Ibuprofen and aspirin', 'Taking aspirin with ibuprofen can raise the risk of stomach bleeding and may stop aspirin protecting the heart.')] });
  await turn(id, 'C1 setup', 'is it safe to take ibuprofen?', { context: 'first question, one drug' });
  const f = await turn(id, 'C1 follow-up', 'and with aspirin?', { context: 'immediately after "is it safe to take ibuprofen?"' });
  assert.equal(f.researchDecision, 'research'); assert.equal(f.resolvedFrom, 'follow-up (join)'); assert.deepEqual(f.resolvedMeaning, { relation: 'interaction', ents: ['ibuprofen', 'aspirin'] }); assert.deepEqual(f.outboundQueries, ['ibuprofen aspirin interaction safety']);
  assert.equal(f.eye, true); assert.deepEqual(f.sources.map((x) => x.site), ['nhs.uk']);
  const id2 = senior(); wire('none', GOOD); await turn(id2, 'C1b setup', 'is it safe to take ibuprofen with warfarin?');
  const g = await turn(id2, 'C1b follow-up', 'and aspirin as well?', { context: 'after the ibuprofen + warfarin question' });
  assert.deepEqual(g.resolvedMeaning.ents, ['ibuprofen', 'warfarin', 'aspirin']); assert.deepEqual(g.outboundQueries, ['ibuprofen warfarin aspirin interaction safety']);
});

test('C2 ambiguous follow-up: pair + "and with aspirin?" = CLARIFY, NO search; Spark writes the question (the note carries the fact, no sentence); the answer resolves it; an unrelated turn in between invalidates the context', async () => {
  const id = senior(); wire('none', GOOD);
  await turn(id, 'C2 setup', 'is it safe to take ibuprofen with warfarin?');
  const q = await turn(id, 'C2 ambiguous', 'and with aspirin?', { context: 'immediately after the ibuprofen + warfarin question' });
  assert.equal(q.researchDecision, 'clarify'); assert.equal(q.outboundCount, 0, 'no search until resolved'); assert.equal(q.resolvedMeaning.clarify.reason, 'followup-relationship'); assert.equal(q.hasSourcesKey, false);
  assert.match(q.noteToSpark, /CLARIFY BEFORE ANSWERING/); assert.match(q.noteToSpark, /IN PLACE OF one of them, or TOGETHER WITH both/); assert.doesNotMatch(q.noteToSpark, /Do you mean/, 'code supplies no sentence to copy');
  const r = await turn(id, 'C2 resolved', 'instead of warfarin', { context: 'answers the clarification' });
  assert.equal(r.researchDecision, 'research'); assert.equal(r.resolvedFrom, 'clarification (replace)'); assert.deepEqual(r.resolvedMeaning.ents, ['ibuprofen', 'aspirin']); assert.deepEqual(r.outboundQueries, ['ibuprofen aspirin interaction safety']);
  // stale: an unrelated turn between invalidates the context
  const id2 = senior(); wire('none', GOOD); await turn(id2, 'C2b setup', 'is it safe to take ibuprofen with warfarin?'); await turn(id2, 'C2b unrelated', 'the garden looks lovely today');
  const s = await turn(id2, 'C2b stale follow-up', 'and with aspirin?', { context: 'an unrelated turn came in between' });
  assert.equal(s.researchDecision, 'none'); assert.equal(s.outboundCount, 0);
  // answering the clarification with something unclear asks again, still no search
  const id3 = senior(); wire('none', GOOD); await turn(id3, 'C2c setup', 'is it safe to take ibuprofen with warfarin?'); await turn(id3, 'C2c ambiguous', 'what about aspirin?');
  const again = await turn(id3, 'C2c unclear answer', 'hmm I am not sure'); assert.equal(again.outboundCount, 0);
});

test('C3 changed-drug question is a NEW question: the earlier pair\'s page cannot qualify just because both are interactions', async () => {
  const id = senior(); wire('none', { 'ibuprofen': [page('www.nhs.uk', 'Ibuprofen and warfarin', IBU_WAR)] });   // the ONLY page this stub has: about warfarin
  const a = await turn(id, 'C3 first', 'is it safe to take ibuprofen with warfarin?'); assert.equal(a.eye, true);
  const b = await turn(id, 'C3 changed', 'is it safe to take ibuprofen with aspirin?');
  assert.deepEqual(b.outboundQueries, ['ibuprofen aspirin interaction safety'], 'a different query'); assert.equal(b.cache, 'miss');
  assert.equal(b.candidates[0].accepted, false); assert.match(b.candidates[0].support, /REJECTED: does not mention aspirin/); assert.equal(b.status, 'unverified');
  assert.equal(b.eye, false); assert.equal(b.hasSourcesKey, false); assert.match(b.finalAnswer, /could not verify/);
});

test('C4 subject switch: news about something else, then ordinary talk: no unrelated sources and no eye', async () => {
  const id = senior(); wire('none', { ...GOOD, flood: [page('www.bbc.com', 'Kerala floods', 'Heavy rain has caused floods across Kerala this week and thousands of people have left their homes.')] });
  await turn(id, 'C4 health', 'is it safe to take ibuprofen with warfarin?');
  const nw = await turn(id, 'C4 switch', 'what is the latest news about the flood in Kerala?');
  assert.deepEqual(nw.outboundQueries, ['flood kerala latest news']); assert.ok(nw.sources.every((x) => !/nhs|mayo|medline/.test(x.site)), 'nothing from the earlier health question');
  const t = await turn(id, 'C4 talk', 'I think I will water the garden'); assert.equal(t.outboundCount, 0); assert.equal(t.hasSourcesKey, false); assert.equal(t.eye, false);
});

test('C5 harm / risk paraphrases with an identifiable substance are researched; arbitrary nouns, companion talk and feelings are not', async () => {
  const yes = ['will ibuprofen hurt me if I am on warfarin?', 'is ibuprofen dangerous with warfarin?', 'are warfarin and ibuprofen ok together?', 'I took ibuprofen and warfarin today, is that a problem?', 'could aspirin affect my kidneys?', 'what happens if I mix warfarin and ibuprofen?'];
  for (const t of yes) { const id = senior(); wire('none', { warfarin: [page('www.nhs.uk', 'x', IBU_WAR)], aspirin: [] }); const r = await turn(id, 'C5 yes', t); assert.equal(r.researchDecision, 'research', t); assert.equal(r.outboundCount, 1, t); assert.match(r.query, /^(?:ibuprofen warfarin|warfarin ibuprofen|aspirin) /, `${t} -> ${r.query}`); }
  const no = ['will a nap hurt me?', 'is chocolate bad for me?', 'could the weather affect my mood?', 'I feel lonely, will you stay with me?', 'can I take a walk after lunch?', 'is the garden dangerous at night?', 'how can you look after me when I am ill?', 'will you remind me to take my pills?'];
  const id = senior(); wire('none', GOOD);
  for (const t of no) { const r = await turn(id, 'C5 no', t); assert.equal(r.outboundCount, 0, t); assert.equal(r.hasSourcesKey, false, t); }
  // a consuming frame with a word the app does not know: UNVERIFIED, no search, no reassurance
  const u = await turn(id, 'C5 unknown', 'is it safe to take xyzzyfen?'); assert.equal(u.researchDecision, 'unverified'); assert.equal(u.outboundCount, 0); assert.match(u.noteToSpark, /Do NOT say it is safe/); assert.equal(u.hasSourcesKey, false);
});

test('C6 relevant but LOW-TRUST evidence fails suitability: no accepted source, "could not verify", no eye', async () => {
  const id = senior(); wire('none', { 'ibuprofen warfarin': [page('healthtips.example', 'Ibuprofen with warfarin', IBU_WAR), page('www.bbc.com', 'Painkillers', 'Ibuprofen and warfarin can be a risky mix, doctors warn that bleeding risk rises.')] });
  const r = await turn(id, 'C6 low trust', 'is it safe to take ibuprofen with warfarin?');
  const by = (h) => r.candidates.find((c) => c.host === h);
  assert.ok(by('healthtips.example').support.startsWith('OK'), 'relevant: it states the interaction'); assert.match(by('healthtips.example').suitability, /REJECTED: tier 3/); assert.match(by('bbc.com').suitability, /REJECTED: a reputable source, but not a health authority/);
  assert.equal(r.status, 'unverified'); assert.equal(r.eye, false); assert.equal(r.hasSourcesKey, false); assert.match(r.finalAnswer, /could not verify/); assert.match(r.noteToSpark, /Do NOT reassure/);
});

test('C7 TRUSTED but IRRELEVANT evidence fails support: no eye', async () => {
  const id = senior(); wire('none', { 'ibuprofen warfarin': [page('www.nhs.uk', 'Paracetamol', 'Paracetamol is used to treat pain and fever. It is safe to take for most people.'), page('medlineplus.gov', 'Warfarin', 'Warfarin is a medicine that makes your blood take longer to clot. Take it at the same time every day.', '/w'), page('www.mayoclinic.org', 'Ibuprofen', 'Ibuprofen is a pain reliever. Common side effects include nausea and headache.')] });
  const r = await turn(id, 'C7 irrelevant', 'is it safe to take ibuprofen with warfarin?');
  assert.ok(r.candidates.every((c) => !c.accepted)); assert.ok(r.candidates.every((c) => /REJECTED/.test(c.support) && /^OK/.test(c.suitability)), 'trusted hosts, failed on SUPPORT');
  assert.match(r.candidates.find((c) => c.title === 'Warfarin').support, /does not mention ibuprofen/); assert.match(r.candidates.find((c) => c.title === 'Paracetamol').support, /does not mention ibuprofen and warfarin/);
  assert.equal(r.eye, false); assert.equal(r.hasSourcesKey, false);
});

test('C8 adequate trusted evidence: at most 2 distinct links, each with its supporting passage; the note separates the general finding from personal clearance; a reply that clears it for them keeps NO attribution', async () => {
  const id = senior(); wire('none', GOOD);
  const r = await turn(id, 'C8 adequate', 'is it safe to take ibuprofen with warfarin?');
  assert.equal(r.status, 'supported'); assert.equal(r.candidates.length, 3); assert.equal(r.candidates.filter((c) => c.accepted).length, 3, 'three suitable pages were found');
  assert.equal(r.sources.length, 2, 'at most 2 attached'); assert.deepEqual(r.sources.map((x) => x.site), ['nhs.uk', 'mayoclinic.org']); assert.ok(r.sources.every((x) => /^https:\/\//.test(x.url) && /bleeding/.test(x.excerpt)));
  assert.match(r.noteToSpark, /GENERAL finding about the substances/); assert.match(r.noteToSpark, /NOT medical clearance for this person/); assert.match(r.noteToSpark, /do not say it is safe or fine for THEM/);
  const id2 = senior(); wire('none', GOOD); process.env.RG_REPLY = 'Good news, that is perfectly safe for you, you can take them together.';
  const c = await turn(id2, 'C8b clearance reply', 'is it safe to take ibuprofen with warfarin?'); assert.equal(c.eye, false, 'a personal-clearance answer is not attributed to the sources'); assert.equal(c.hasSourcesKey, false);
});

test('C9 insufficient and conflicting evidence: "could not be verified", no reassurance, no decorative panel', async () => {
  const id = senior(); wire('none', { 'ibuprofen warfarin': [page('www.nhs.uk', 'Ibuprofen and warfarin', 'There is no known interaction between ibuprofen and warfarin for most people.'), page('www.mayoclinic.org', 'Warfarin interactions', 'Avoid taking ibuprofen with warfarin because the combination raises the risk of serious bleeding.')] });
  const c = await turn(id, 'C9 conflict', 'is it safe to take ibuprofen with warfarin?'); assert.equal(c.status, 'conflict'); assert.match(c.noteToSpark, /DISAGREE/); assert.match(c.finalAnswer, /could not verify/); assert.equal(c.eye, false); assert.equal(c.hasSourcesKey, false);
  const id2 = senior(); wire('none', {}); const i = await turn(id2, 'C9 insufficient', 'is it safe to take ibuprofen with warfarin?');
  assert.equal(i.status, 'unverified'); assert.equal(i.eye, false); assert.match(i.noteToSpark, /found NO usable page/);
});

test('C10 a rewrite / fallback that no longer uses the research keeps NO attribution', async () => {
  const id = senior(); wire('none', GOOD); process.env.RG_REPLY = 'I want to get this right. Could you tell me a little more about what you mean?';
  const r = await turn(id, 'C10 fallback', 'is it safe to take ibuprofen with warfarin?'); assert.equal(r.status, 'supported', 'adequate evidence existed'); assert.equal(r.eye, false); assert.equal(r.hasSourcesKey, false);
  const id2 = senior(); wire('none', GOOD); process.env.RG_REPLY = 'I can\'t verify that from what I found, so best to check with your doctor.';
  const q = await turn(id2, 'C10b could-not-verify reply', 'is it safe to take ibuprofen with warfarin?'); assert.equal(q.eye, false);
});

test('C11 scam regression: an explicit scam check still reaches the checking route (link: background check; company: official + web), a dotted code identifier is not a link; scam.js is untouched', async () => {
  const id = senior(); wire('warn', {});
  await turn(id, 'C11 scam link', 'The text says to claim my prize at free-gift-prize.example/claim and give the code they sent.');
  assert.match(asked.at(-1).roster, /BACKGROUND CHECK STARTED/); await require('../checks').idle(); assert.deepEqual(sent, ['free-gift-prize.example scam phishing reports']);
  const id2 = senior(); wire('warn', {}); await turn(id2, 'C11 scam company', 'A man from Harbour Light Bank rang me and wants me to read out the code in my text.');
  assert.match(asked.at(-1).roster, /NO official source|RECONFIRM/);
  const id3 = senior(); wire('warn', {}); await turn(id3, 'C11 dotted identifier', 'this.compactRoster is not a function and they want my code'); assert.ok(!sent.some((q) => /compactroster/i.test(q)));
  assert.equal(require('child_process').execFileSync('git', ['diff', '--stat', '--', 'scam.js'], { cwd: path.join(__dirname, '..') }).toString().trim(), '', 'scam.js untouched');
});

test('voice stays outside this fix: call.js has no web lookup and the voice persona keeps its no-lookups rule', () => {
  const callSrc = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'); assert.ok(!/require\('\.\/web'\)/.test(callSrc), 'call.js must not require web.js');
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8'); assert.match(brainSrc, /You can only talk right now: no lookups or calls/);
});

test('web.extract / decide unit: one factual need = one query; no automatic "medicine" or "claim" duplicate; a dotted code identifier is never a host; privacy', () => {
  const q = (w, o) => W.extract(w, o).map((t) => `${t.kind}:${t.query}`);
  assert.deepEqual(q('is it safe to take ibuprofen with warfarin?'), ['health:ibuprofen warfarin interaction safety']);
  assert.deepEqual(q('how can you take care of me?'), []); assert.deepEqual(q('take care of me'), []); assert.deepEqual(q('this.compactRoster is not a function'), []);
  assert.deepEqual(q('this.compactRoster is not a function', { scam: true }), []);
  assert.deepEqual(q('is it safe to take my pills?'), []);
  assert.deepEqual(q('Can I take aspirin and ibuprofen together? my number is 0412 345 678 and a.b@mail.example'), ['health:aspirin ibuprofen interaction safety']);
  assert.deepEqual(q('is that true?', { ctx: { prevUser: 'is it safe to take ibuprofen with warfarin?' } }), ['health:ibuprofen warfarin interaction safety']);
  assert.deepEqual(q('is that true?', { ctx: { prevUser: 'this.compactRoster is not a function' } }), []);
  assert.deepEqual(q('They sent a link free-gift-prize.example/claim and I should click it', { scam: true }), ['link:free-gift-prize.example scam phishing reports']);
  assert.deepEqual(q('they sent me free-gift-prize.example/claim'), []); assert.deepEqual(q('is free-gift-prize.example/claim a real link?'), ['link:free-gift-prize.example scam phishing reports']);
  assert.deepEqual(q('I feel like ending it all, is it safe to take all my pills?'), []);
  assert.equal(W.decide('and with aspirin?', { ctx: {} }), null, 'no prior question: a bare follow-up is nothing');
});
