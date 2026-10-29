// Fixes after the Harvey live test: short replies with the source behind an eye button, chat -> call continuity, and a family claim that must match the records.
// No network: Spark, Tavily and the scam check are stubbed. The sentences below exist only in this file; Maya's wording is Spark's, these tests check facts, limits and guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-harvey-'));
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
const { Call } = require('../call');
const S = require('../scam');
const W = require('../web');

const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const FEEL = tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 });
const sentences = (t) => (t.match(/[.!?](\s|$)/g) || []).length;
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Har${letters(n++)}`, 'male').id;
const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const verdict = (level, type = 'gift card scam') => async () => ({ level, type, reading: 'Someone from a bank wants gift cards.', signals: sig('impersonation', 'payment'), reads: Object.fromEntries(S.READS.map((k) => [k, false])), count: 2 });
const roster = () => asked.at(-1).roster;
const reset = (...q) => { queue.length = 0; queue.push(...q); asked.length = 0; };
const LONG = `${FEEL} Turmeric is a common spice. Some people take it as capsules. Studies are mixed about arthritis. Check the dose with a pharmacist. It can interact with blood thinners. Ask your doctor first.`;
const PAGES = { turmeric: [{ title: 'Turmeric: what the research says', url: 'https://www.nhs.example/turmeric', content: 'Evidence for turmeric capsules is limited. Ask a pharmacist.' }] };
const tavily = (table) => async (url, opts) => { const q = JSON.parse(opts.body).query.toLowerCase(); const hit = Object.entries(table).find(([k]) => q.includes(k)); return { ok: true, status: 200, text: async () => JSON.stringify({ results: hit ? hit[1] : [] }) }; };
const useWeb = () => { W.cache.clear(); W.spent.length = 0; chat.deps.web = (w, o) => W.lookup(w, { ...o, fetch: tavily(PAGES), key: 'k' }); };
const made = [];
const mkCall = (id) => { const ws = { send() {}, close() {}, onmessage: null, onclose: null }; const c = new Call(ws, 'k'); c.profile = memory.load(id); c.callId = `c${n}`; c.registered = true; c.noVoice = true; made.push(c); return c; };

// ---- A. short replies, source behind the eye button ----
test('A: a turmeric question gets two sentences at most; the source is stored apart and is not in the text', async () => {
  const id = senior(); useWeb(); chat.deps.scamText = verdict('none'); reset(LONG);
  const out = await chat.sendText(id, 'I heard that turmeric capsules cure arthritis, is it true?', null);
  const m = out.messages[1];
  assert.ok(sentences(m.text) <= 2, m.text);
  assert.doesNotMatch(m.text, /nhs\.example|research says|Evidence for turmeric/);
  assert.equal(m.sources.length, 1); assert.equal(m.sources[0].site, 'nhs.example'); assert.match(m.sources[0].excerpt, /limited/);
  assert.match(roster(), /ONE OR TWO SHORT SENTENCES/); assert.doesNotMatch(roster(), /name the site it came from/);
  const stored = chat.thread(id).at(-1); assert.equal(stored.sources[0].site, 'nhs.example');
});

test('A: they can still ask for more (the cap lifts)', async () => {
  const id = senior(); useWeb(); chat.deps.scamText = verdict('none'); reset(LONG);
  const out = await chat.sendText(id, 'I heard that turmeric capsules cure arthritis, is it true? Please explain in full.', null);
  assert.ok(sentences(out.messages[1].text) > 2, out.messages[1].text);
});

test('A: a gift card message with no company clear: the reply is the short question, never more than three sentences, and no source box', async () => {
  const id = senior(); useWeb(); chat.deps.scamText = verdict('warn'); reset(`${FEEL} Could you type that message or send me a screenshot? Do not do anything yet until I confirm. A bank asking for a gift card looks like a scam. The safe way is to check. Never share a code.`);
  const out = await chat.sendText(id, 'A lady from a bank says I must buy gift cards today.', null);
  const m = out.messages[1];
  assert.ok(sentences(m.text) <= 3, m.text); assert.equal(m.sources, undefined);
  assert.match(roster(), /TWO SHORT SENTENCES IN ALL/);
});

test('A: the page has an eye button that opens the source apart from the message text', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-ui.js'), 'utf8');
  assert.match(ui, /function sourceBox/); assert.match(ui, /className = 'eye'|el\('button', 'eye'/); assert.match(ui, /list\.hidden = !list\.hidden/); assert.match(ui, /m\.sources/);
  assert.doesNotMatch(ui, /innerHTML = .*source/i, 'source text is set as text, never as HTML');
});

// ---- B. chat -> call continuity ----
test('B: chat about a gift card, then a call at once: the greeting facts carry that topic and forbid a fresh introduction', async () => {
  const id = senior(); useWeb(); chat.deps.scamText = verdict('warn'); reset(`${FEEL} Could you type that message or send me a screenshot? Do not do anything yet.`);
  await chat.sendText(id, 'A lady from a bank says I must buy gift cards today.', null);
  const note = mkCall(id).greetingNote(20);
  assert.match(note, /CHAT CONTINUES ON THE PHONE/); assert.match(note, /gift card scam/); assert.match(note, /last chat turn 1 minute ago/); assert.match(note, /their family was NOT told/);
  assert.match(note, /Do NOT introduce yourself, do NOT say it is nice to be talking again, and do NOT ask what they have been up to/);
  assert.doesNotMatch(note, /For variety this time/); assert.doesNotMatch(note, /Their last call was about/);
});

test('B: an open question to the family, and a family that WAS told, show up as facts', async () => {
  const id = senior(); useWeb(); chat.deps.scamText = verdict('warn'); reset(`${FEEL} Could you type that message or send me a screenshot?`);
  await chat.sendText(id, 'A lady from a bank says I must buy gift cards today.', null);
  care.scamAsk(id, 'gift card scam', {}); assert.match(mkCall(id).greetingNote(20), /whether to let their family know, and it is still unanswered/);
  care.scamAnswer(id, true); assert.match(mkCall(id).greetingNote(20), /their family WAS told about it \(topic only\)/);
});

test('B: chat about a different topic, then a call: the greeting facts carry that topic', async () => {
  const id = senior(); useWeb(); chat.deps.scamText = verdict('none'); reset(`${FEEL} That sounds lovely.`);
  await chat.sendText(id, 'My granddaughter is visiting on Sunday and I am baking a lemon cake.', null);
  const note = mkCall(id).greetingNote(20);
  assert.match(note, /CHAT CONTINUES ON THE PHONE/); assert.match(note, /lemon cake/); assert.doesNotMatch(note, /scam/);
});

test('B: no recent chat (or one older than half an hour): the usual greeting, no continuity', async () => {
  const id = senior(); assert.doesNotMatch(mkCall(id).greetingNote(20), /CHAT CONTINUES/);
  useWeb(); chat.deps.scamText = verdict('none'); reset(`${FEEL} Lovely.`);
  await chat.sendText(id, 'I am baking a lemon cake today.', null);
  for (const m of chat.thread(id)) m.at -= 31 * 60000;
  assert.equal(chat.continuity(id), null); assert.doesNotMatch(mkCall(id).greetingNote(20), /CHAT CONTINUES/);
});

// ---- C. the family claim must match the records ----
test('C: no alert exists -> the fact says nobody was told, never a reason, and a denial of self-harm is agreed with plainly', () => {
  const id = senior(); const f = care.appFacts(id);
  assert.match(f, /told their family NOTHING/); assert.match(f, /say plainly in your own words that nobody was told/); assert.match(f, /never say or suggest they spoke of hurting themselves/); assert.match(f, /agree plainly that you got it wrong, with no soothing line/);
  assert.deepEqual(care.familyToldTopics(id), []);
});

test('C: an alert that exists is named by topic only, with no excuse', () => {
  const id = senior(); care.scamAsk(id, 'gift card scam', {}); care.scamAnswer(id, true);
  const f = care.appFacts(id);
  assert.match(f, /ONLY these topics: a possible gift card scam/); assert.match(f, /name that topic and nothing else/); assert.match(f, /never say "because I care about you"/);
  assert.doesNotMatch(f, /told their family NOTHING/);
  const id2 = senior(); care.selfHarmAlert(id2, { channel: 'call' });
  assert.deepEqual(care.familyToldTopics(id2), ['a safety worry']);
  const c = mkCall(id2); const sc = c.safetyContext(); assert.match(sc, /a safety worry/); assert.doesNotMatch(sc, /because they said they might hurt themselves/);
});

test('C: breaksFacts reads the records: an invented alert, an invented reason and the stock counselling lines are blocked; a real alert may be named', () => {
  const id = senior(); const c = mkCall(id);
  assert.equal(c.breaksFacts('I have let your family know to keep you safe.'), true);
  assert.equal(c.breaksFacts("I'll let your family know because you said you might hurt yourself."), true);
  assert.equal(c.breaksFacts('Your family has been told about it.'), true);
  for (const s of ["I'm right here with you.", "We'll take this slow together.", "I'm standing with you.", 'I did it because I care about you.']) assert.equal(c.breaksFacts(s), true, s);
  assert.equal(c.breaksFacts('Nobody was told. I have not contacted your family.'), true, 'not volunteered on a turn that is not about the family');
  c.history.push({ role: 'user', content: 'A: Did you tell my family?' });
  assert.equal(c.breaksFacts('Nobody was told. I have not contacted your family.'), false, 'but plainly allowed when they ask');
  assert.equal(c.breaksFacts('Please hold off on the gift cards for now.'), false);
  care.scamAsk(id, 'gift card scam', {}); care.scamAnswer(id, true);
  assert.equal(c.breaksFacts('Yes, I let your family know about the gift card scam.'), false, 'a real alert can be named');
  assert.equal(c.breaksFacts("I'll let your family know because you said you might hurt yourself."), true, 'but a self-harm reason is still invented');
});

test('C: in chat, a draft that claims an alert that was never made is written again; nothing false is shown', async () => {
  const id = senior(); chat.deps.scamText = verdict('none');
  reset(`${FEEL} I have let your family know to keep you safe. Could you send that message?`, `${FEEL} Nobody was told. Do you still want to send that screenshot?`);
  const out = await chat.sendText(id, 'Why did you let my family know? I never said you could.', null);
  assert.doesNotMatch(out.messages[1].text, /let your family know|keep you safe/i); assert.match(out.messages[1].text, /Nobody was told/);
  assert.equal(asked.length, 2); assert.match(roster(), /FAMILY ALERTS fact/); assert.match(asked[1].roster, /told their family NOTHING/);
});

test('C: in chat, a stock counselling reply is rewritten, and a second try that still has it is cut', async () => {
  const id = senior(); chat.deps.scamText = verdict('none');
  reset(`${FEEL} I got that wrong. I'm standing with you. We'll take this slow together.`);
  const out = await chat.sendText(id, 'I never said I would hurt myself. What are you even saying?', null);
  assert.doesNotMatch(out.messages[1].text, /standing with you|take this slow|right here with you/i); assert.match(out.messages[1].text, /got that wrong/);
});

test('C: the master prompt and the reply note ban the stock counselling lines and "I care about you" as an excuse', () => {
  const c = mkCall(senior()); const note = c.replyNote();
  assert.match(note, /Never say "I'm right here with you", "we'll take this slow together", "I'm standing with you"/); assert.match(note, /never give "I care about you" as the reason/);
});

// ---- leak: the family fact is internal, spoken only when the turn is about it ----
const LEAK = `${FEEL} I haven't told anyone anything. No news went to anyone about you.`;
test('leak: "Hi Maya", light chat, "What are you talking about?" and "What?" get no family fact in the roster, and a family claim draft is rewritten', async () => {
  const id = senior(); chat.deps.scamText = verdict('none');
  for (const line of ['Hi Maya', 'I am baking a lemon cake today.', 'What are you talking about?', 'What?']) {
    reset(LEAK, `${FEEL} Sorry, I got that wrong. Let's go back to what you were saying.`);
    const out = await chat.sendText(id, line, null);
    assert.doesNotMatch(asked[0].roster, /FAMILY ALERTS/, line); assert.doesNotMatch(asked[0].roster, /told their family NOTHING/, line);
    assert.doesNotMatch(out.messages[1].text, /told anyone|no news|family/i, line); assert.equal(asked.length, 2, `${line}: the leaking draft was written again`);
  }
});

test('leak: the reply note says family is internal, and a wrong answer is corrected plainly (no "let us drop it")', async () => {
  const id = senior(); chat.deps.scamText = verdict('none'); reset(`${FEEL} Sorry about that. Let's drop it.`, `${FEEL} Sorry, I got that wrong. Let's go back to what you were saying.`);
  const out = await chat.sendText(id, 'What?', null);
  assert.match(asked[0].roster, /INTERNAL: never bring them up unless they asked/); assert.match(asked[0].roster, /never "let's drop it"/);
  assert.doesNotMatch(out.messages[1].text, /drop it/i); assert.match(out.messages[1].text, /got that wrong/);
});

test('leak: "Did you tell my family?" with no alert -> the fact is there and "nobody was told" may be said', async () => {
  const id = senior(); chat.deps.scamText = verdict('none'); reset(`${FEEL} Nobody was told. I have not contacted your family.`);
  const out = await chat.sendText(id, 'Did you tell my family?', null);
  assert.match(asked[0].roster, /told their family NOTHING/); assert.equal(asked.length, 1); assert.match(out.messages[1].text, /Nobody was told/);
  const out2 = (reset(`${FEEL} Nobody was told.`), await chat.sendText(id, 'Why did you let my family know?', null));
  assert.match(asked[0].roster, /told their family NOTHING/); assert.match(out2.messages[1].text, /Nobody was told/);
});

test('leak: "Did you tell my family?" with an alert -> topic only, no excuse', async () => {
  const id = senior(); chat.deps.scamText = verdict('none'); care.scamAsk(id, 'gift card scam', {}); care.scamAnswer(id, true); reset(`${FEEL} Yes, about the gift card scam only.`);
  const out = await chat.sendText(id, 'Did you tell my family?', null);
  assert.match(asked[0].roster, /ONLY these topics: a possible gift card scam/); assert.match(asked[0].roster, /never say "because I care about you"/); assert.match(out.messages[1].text, /gift card scam/);
});

test.after(() => { made.forEach((c) => c.end()); for (const s of chat.sessions.values()) s.finish(); care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
