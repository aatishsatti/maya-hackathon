// smart.js: the router, abilities on demand, the decision from signals, the cards and the draft guard. Every layer is a flag (all OFF by default); OFF adds nothing. No network, no Spark.
// The BEFORE / AFTER table (CASES) counts how many of these a layer handles with its flag off (0) and on: it measures the CODE (what Spark would be handed, what is blocked), not Spark's wording.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-smart-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const queue = []; const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'u', sparkStream: async (h, r, _s, onDelta) => { const t = queue.length > 1 ? queue.shift() : queue[0] || 'Okay.'; if (onDelta) onDelta(t); return t; } } };
const memory = require('../memory'); const smart = require('../smart'); const { Call } = require('../call');
const LAYERS = ['ROUTER', 'ABILITIES', 'DECISION', 'CARDS', 'GUARD', 'KINDS', 'SHORT', 'CONTRACT', 'CAPS', 'MEMORY', 'GENERAL'];
const setAll = (v) => { delete process.env.MAYA_SMART; for (const l of LAYERS) delete process.env[`MAYA_SMART_${l}`]; if (v) process.env.MAYA_SMART = 'on'; };
let n = 0; const person = () => { const id = memory.createProfile(`Smart${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n++ / 26))}`, 'female').id; return id; };
const session = () => { const id = person(); const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(id); c.channel = 'chat'; return c; };
const labelsFor = (turns) => { const c = session(); let out; for (const t of turns) { if (typeof t === 'object') Object.assign(c, t); else { c.careNotes(t); out = [...c.factLabels]; } } return out; };

// [turns (the last one is judged), the label that must appear with the flag ON]
const ABILITY_CASES = [
  [['Can you check this photo for me?'], 'smart-ability-photo'], [['can you read a pdf for me'], 'smart-ability-pdf'], [['Can you speak to me out loud?'], 'smart-ability-call'],
  [['can you call my son'], 'smart-ability-no'], [['Can you book me a taxi?'], 'smart-ability-no'], [['can u order food for me'], 'smart-ability-no'], [['what can you do'], 'smart-ability-general'],
  [['can you search the news about the floods'], 'smart-ability-web'], [['can you tell my daughter I am fine'], 'smart-ability-family'], [['can you send money to my grandson'], 'smart-ability-no'],
  [['Can you talk to me by voice?'], 'smart-ability-call'], [['can you look up the news for me'], 'smart-ability-web'],
];
const SWITCH_CASES = [
  [['A man called saying I won a lottery and must pay a fee', 'I want to tell you about my garden'], 'smart-switch'],
  [['Remind me in 5 minutes to take my tablets', 'Actually I feel dizzy and my chest hurts'], 'smart-switch'],
  [['what can you do', 'my son visited me today and brought sweets'], 'smart-switch'],
  [['I feel dizzy today', 'remind me at 5 pm to drink water'], 'smart-switch'],
  [['A man called saying I won a lottery and must pay a fee', 'can you set a reminder for my medicine'], 'smart-switch'],
  [['Remind me in 5 minutes to take my tablets', 'a stranger on the phone says my bank account is blocked and I must send my OTP'], 'smart-switch'],
];
const BAD_DRAFTS = [
  ['It is verified safe, you can go ahead.', 'certainty'], ['This is 100% a scam.', 'certainty'], ['That is definitely a scam.', 'certainty'], ['It\'s completely safe to pay.', 'certainty'],
  ['Please visit www.sbi-help.com to fix it.', 'link'], ['Go to https://secure-bank.example/login now.', 'link'], ['Call 1800 123 4567 right away.', 'number'], ['Ring them on +44 20 7946 0958.', 'number'],
  ["I've called the bank for you.", 'claim'], ["I checked online and it's fine.", 'claim'], ["I've told your family about it.", 'claim'], ['I searched the web and found nothing.', 'claim'],
];
const FINE_DRAFTS = ["I can't be sure, and I can make mistakes. Nothing unusual stands out so far, but please check with the number on your card.", 'That does not sound safe to me; please do not pay.', 'Please use the official app or the number on your card.', 'Tell me more about what they asked.'];

test('every layer OFF (the default) adds nothing: no smart label, no draft blocked, the same notes as 47d321c', () => {
  setAll(false);
  for (const [turns] of [...ABILITY_CASES, ...SWITCH_CASES]) assert.ok(!labelsFor(turns).some((l) => l.startsWith('smart-')), turns.join(' | '));
  const s = session(); for (const [d] of BAD_DRAFTS) assert.equal(smart.breaks(d, s), null, d);
  assert.deepEqual(smart.notes(session(), 'can you check this photo'), []);
});

test('ABILITIES + ROUTER ON: 12 ability questions get the right fact, 6 topic switches get the switch fact; with the flag OFF it was 0 of 18', () => {
  setAll(true); let hit = 0;
  for (const [turns, want] of [...ABILITY_CASES, ...SWITCH_CASES]) { const got = labelsFor(turns); if (got.includes(want)) hit += 1; else assert.fail(`${turns.join(' | ')} -> ${got.join(',')} (wanted ${want})`); }
  assert.equal(hit, 18); setAll(false);
  process.env.MAYA_SMART = 'on'; process.env.MAYA_SMART_ABILITIES = 'off';
  assert.ok(!labelsFor(['can you check this photo for me']).some((l) => l.startsWith('smart-ability')), 'one layer off, the others still work'); assert.ok(labelsFor(['A man called saying I won a lottery and must pay a fee', 'I want to tell you about my garden']).includes('smart-switch')); setAll(false);
});

test('a reminder request that mentions "call my sister" is a reminder, not a "cannot do that" ability question', () => {
  setAll(true); const l = labelsFor(['remind me at noon tomorrow to call my sister']); assert.ok(!l.some((x) => x.startsWith('smart-ability')), l.join()); setAll(false);
});

test('only abilities that exist: every ability line names something the code really does, and nothing is invented', () => {
  const all = smart.CAN.map((c) => c[2]).join(' ') + ' ';
  assert.doesNotMatch(all, /weather|book|order food|translate|play music|navigate/i);
  for (const [re] of smart.CAN) assert.ok(re instanceof RegExp);
});

test('DECISION: signals -> Warning / Caution / Not sure / Nothing unusual so far; unknown, short, unread or a failed check is NEVER "nothing unusual"', () => {
  setAll(true);
  const long = 'A letter came today from my bank about my account and I want to know what to do about it';
  const rows = [[{ level: 'warn', type: 'bank scam' }, {}, 'Warning'], [{ level: 'pause' }, {}, 'Warning'], [{ level: 'caution', type: 'prize' }, {}, 'Caution'], [{ level: 'none', reading: 'an ordinary letter' }, { needed: true, heard: long }, 'Nothing unusual so far'],
    [{ level: 'none', reading: 'an ordinary letter' }, { needed: true, heard: 'a letter came' }, 'Not sure'], [{ level: 'none', reading: '' }, { needed: true, heard: long }, 'Not sure'], [null, { needed: true, heard: long }, 'Not sure'], [{ level: 'none', reading: 'fine' }, { failed: true, needed: true, heard: long }, 'Not sure']];
  for (const [sc, ctx, want] of rows) assert.equal(smart.decide(sc, ctx).label, want, JSON.stringify([sc, ctx]));
  assert.equal(smart.decide(null, {}), null);
  // through careNotes: the decision text carries the label, one question at most, the disclosure once, and never the words safe / verified as allowed output
  const c = session(); c._scam = { scam: { level: 'caution', type: 'bank scam', signals: { urgency: true } }, failed: false, needed: true };
  const n1 = c.careNotes('A man from the bank phoned and said I must act today'); assert.ok(c.factLabels.includes('smart-decision') && c.factLabels.includes('smart-state') && c.factLabels.includes('smart-kind'), c.factLabels.join());
  assert.match(n1, /CAUTION/); assert.equal((n1.match(/Ask ONE short question/g) || []).length, 1); assert.match(n1, /can make mistakes/); assert.match(n1, /family consent \(read-only/);
  c._scam = { scam: { level: 'caution', type: 'bank scam', signals: { urgency: true } }, failed: false, needed: true };
  const n2 = c.careNotes('He said it is urgent'); assert.doesNotMatch(n2, /can make mistakes/, 'disclosed once per incident');
  let asked = 1; for (let i = 0; i < 5; i++) { c._scam = { scam: { level: 'caution', type: 'bank scam', signals: {} }, failed: false, needed: true }; const t = c.careNotes('hmm'); if (/Ask ONE short question/.test(t)) asked += 1; }
  assert.ok(asked + 1 <= 4, `at most three questions in one incident, got ${asked + 1}`); setAll(false);
});

test('STATE + CONTRACT + TRACE: who contacted whom and what was asked are kept, the other side is "reported", consent is read-only, and the trace names what was asked, learned, checked and still unknown', () => {
  setAll(true); const c = session(); c._scam = { scam: { level: 'caution', type: 'bank scam', signals: { urgency: true, payment: true } }, failed: false, needed: true };
  const n = c.careNotes('A man phoned me from my bank and says I must pay today'); assert.match(n, /who contacted whom=they contacted the senior/); assert.match(n, /requested action=pay or send details, act now/); assert.match(n, /REPORTED by the senior, not verified/);
  assert.match(n, /family consent \(read-only, never change, announce or guess it\)/); assert.match(n, /OUTPUT CONTRACT[^]*NOT a yes to you/);
  const tr = smart.trace(c); assert.deepEqual([tr.checked[0], tr.learned.includes('contact'), tr.unknown.includes('check')], ['scam check ran', true, true]); assert.ok(tr.asked.length <= 1);
  c._scam = { scam: null, failed: true, needed: true }; c.careNotes('hmm'); assert.equal(smart.trace(c).checked[0], 'scam check FAILED'); setAll(false);
});

test('speaker attribution: the CALLER saying "do not tell anyone" is not the senior saying no to their family (flag on); the senior\'s own no still is', () => {
  const care = require('../care'); const run = (on, said) => { setAll(on); const c = session(); const id = c.profile.id; care.scamAsk(id, 'bank scam', { channel: 'chat', asked: true }); c.careNotes(said); const l = [...c.factLabels]; setAll(false); return l; };
  assert.ok(run(false, 'they said do not tell anyone').includes('scam-no-to-family'), 'flag off = the old reading, unchanged');
  assert.ok(!run(true, 'they said do not tell anyone').includes('scam-no-to-family'));
  assert.ok(!run(true, 'he told me not to tell anyone').includes('scam-no-to-family'));
  assert.ok(run(true, 'no, do not tell them').includes('scam-no-to-family') && run(true, 'no').includes('scam-no-to-family'), 'their own no still counts');
});

test('KINDS: the kind named gets its real-behaviour rules and traps; no number, no link, no route in any of them', () => {
  setAll(true); const c = session(); c._scam = { scam: { level: 'warn', type: 'tax refund scam', signals: { payment: true } }, failed: false, needed: true };
  const t = c.careNotes('Someone from the tax office says I owe money and must pay in gift cards'); assert.match(t, /KIND \(tax\)/); assert.match(t, /every refund is fake|do not say every refund is fake/);
  for (const [, , rules] of smart.KINDS) { assert.doesNotMatch(rules, /\d{4,}|https?:|www\./); }
  assert.equal(smart.KINDS.length, 8); setAll(false);
});

test('GUARD: 12 bad drafts (certainty, an invented link or number, a claim with no record) are blocked; 4 honest ones pass; with the flag OFF it was 0 of 12', () => {
  setAll(true); const s = session(); s._exec = { family: false, web: null, scam: null };
  let blocked = 0; for (const [d, why] of BAD_DRAFTS) { const r = smart.breaks(d, s); assert.equal(r, why, d); blocked += 1; } assert.equal(blocked, 12);
  for (const d of FINE_DRAFTS) assert.equal(smart.breaks(d, s), null, d);
  s._exec = { family: true, web: 'ran', scam: 'ran' }; assert.equal(smart.breaks("I've told your family about it.", s), null, 'with a record the claim is true'); assert.equal(smart.breaks('I searched the web and found nothing.', s), null);
  s.lastHeard = () => 'my number is 98765 43210 and the site is www.mybank.com'; assert.equal(smart.breaks('Is www.mybank.com the one they gave you?', s), null, 'a link they gave is not invented'); s._q = 0; assert.equal(smart.breaks('So 98765 43210 called you?', s), null);
  assert.equal(c_breaks(), true); setAll(false);
});
function c_breaks() { const c = session(); return c.breaksFacts('It is verified safe.'); }

test('GUARD through the chat: a bad draft is rewritten once; if the rewrite is bad too the person sees the plain safe line, never the draft', async () => {
  setAll(true);
  const chat = require('../chat'); const care = require('../care');
  chat.deps.web = async () => ({ topics: [] }); chat.deps.scamText = async () => ({ level: 'caution', type: 'bank scam', reading: 'a call asking for a code', signals: { urgency: true }, reads: {}, count: 1 });
  const FEEL = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0]]';
  const id = memory.createProfile('Guarda', 'female').id; care.setTimezone(id, 'Asia/Kolkata', 'manual');
  queue.length = 0; queue.push(`${FEEL} Hello, I'm Maya, your companion.`); await chat.sendText(id, 'Hi', 'Asia/Kolkata');
  queue.length = 0; queue.push(`${FEEL} This is 100% a scam, go to www.sbi-help.com.`, `${FEEL} Fine. It is verified safe, call 1800 123 4567.`);
  const r = await chat.sendText(id, 'A man phoned saying he is from my bank and needs my OTP today', 'Asia/Kolkata'); const said = r.messages[r.messages.length - 1].text;
  assert.match(said, /I can't be sure about this one/); assert.doesNotMatch(said, /100%|verified|www\.|1800/);
  queue.length = 0; queue.push(`${FEEL} It is verified safe.`, `${FEEL} I can't be sure, so please do not share the code. What did he ask you for?`);
  const r2 = await chat.sendText(id, 'He wants the code now', 'Asia/Kolkata'); assert.match(r2.messages[r2.messages.length - 1].text, /do not share the code/);
  setAll(false);
});

// ---------------------------------------------------------------- SHORT / CONTRACT / CAPS / MEMORY / GENERAL
test('SHORT: the first "what can you do" is told to be two sentences, three things, one question; "more" and "all" get the full list; flag off = the old nine-item fact', () => {
  const run = (on, turns) => { setAll(false); if (on) process.env.MAYA_SMART_SHORT = 'on'; const c = session(); c.channel = 'chat'; let n = ''; for (const t of turns) { c.history.push({ role: 'user', content: t }); n = c.limitsFacts(t); } const d = { maxSentences: 9, noQuestion: false, emotion: 'neutral', intensity: 1 }; c.applyBeat(d, {}, false); setAll(false); return { n, d }; };
  const first = run(true, ['what can you do for me']); assert.match(first.n, /AT MOST TWO short sentences[^]*at most THREE things[^]*ONE short question/); assert.ok(first.d.maxSentences <= 2, `cap ${first.d.maxSentences}`);
  const more = run(true, ['what can you do for me', 'more']); assert.match(more.n, /THE TRUE LIST|nine/i); assert.ok(more.d.maxSentences >= 5);
  const all = run(true, ['tell me everything you can do']); assert.doesNotMatch(all.n, /AT MOST TWO short sentences/);
  const off = run(false, ['what can you do for me']); assert.doesNotMatch(off.n, /AT MOST TWO short sentences/); assert.ok(off.d.maxSentences >= 5, 'flag off = unchanged');
});

test('SHORT guard: a dump of four abilities and a second question are rewritten (reason given), then a plain true line; three things and one question pass', () => {
  setAll(false); process.env.MAYA_SMART_SHORT = 'on'; const c = session(); c._abilityFirst = true;
  const feed = (...ps) => { c._q = 0; c._cats = null; c._why = null; return ps.map((p) => smart.breaks(p, c)); };
  assert.deepEqual(feed('I can chat with you, set reminders, and check messages for scams.', 'What would you like help with?'), [null, null]);
  assert.deepEqual(feed('I can talk, set reminders, check photos for scams, search the news and tell your family.').map(String), ['dump']); assert.match(c._why, /too many abilities/); assert.match(smart.fallback(c), /What would you like help with\?$/);
  assert.deepEqual(feed('How are you today?', 'And what did you eat?'), [null, 'twoq']); assert.match(c._why, /only ONE/); setAll(false);
});

test('CONTRACT + CAPS: every non-scam turn carries the reply shape; ability and reminder turns carry the RECORD with tools available and unavailable here', () => {
  setAll(false); process.env.MAYA_SMART_CONTRACT = 'on'; process.env.MAYA_SMART_CAPS = 'on';
  const c = session(); c.careNotes('can you check a photo for me'); assert.ok(c.factLabels.includes('smart-shape') && c.factLabels.includes('smart-record'), c.factLabels.join());
  const n = c.careNotes('can you check a photo for me'); assert.match(n, /available: chat, reminders, photo/); assert.match(n, /unavailable: phoning anyone/);
  const v = session(); v.channel = 'call'; assert.match(v.careNotes('can you check a photo for me'), /unavailable: photo, PDF, web search/);
  assert.match(n, /keep who said what/); setAll(false);
});

test('MEMORY: one THREAD line each turn; an ANSWERED introductory question is not asked again (also in a new session); a relevant follow-up is never blocked; an unanswered question is flagged; a required set-up question is never blocked', async () => {
  setAll(false); process.env.MAYA_SMART_MEMORY = 'on'; const care = require('../care');
  const a = session(); const id = a.profile.id; a.careNotes('hello there'); smart.afterReply(a, 'Lovely to meet you. Do you have any hobbies you enjoy?');
  let n = a.careNotes('hmm'); assert.match(n, /THREAD: topic=/); assert.match(n, /have not answered it yet/);
  n = a.careNotes('I like my garden and grow roses and tomatoes'); assert.doesNotMatch(n, /have not answered it yet/); assert.match(n, /never ask the same thing again/);
  assert.equal(smart.breaks('So what hobbies do you have these days?', a), 'repeat'); a._why = null;
  assert.equal(smart.breaks('Which roses are blooming right now?', a), null, 'a relevant follow-up is not an introductory question');
  smart.afterReply(a, 'Which roses are blooming right now?'); a.careNotes('the red ones'); assert.equal(smart.breaks('Which roses are blooming right now?', a), null, 'not introductory: never blocked by the 14-day rule');
  const b = session(); b.profile = memory.load(id); b.profile.id = id; assert.equal(smart.breaks('Do you have any hobbies you enjoy?', b), 'repeat', 'a new session, same person');
  b.factLabels = ['setrem-confirm']; assert.equal(smart.breaks('Do you have any hobbies you enjoy?', b), null, 'a required set-up question is never blocked'); assert.ok(care.get(id).smart.qs.length >= 1); setAll(false);
});

test('GENERAL: "is it safe / true / ok" on any topic is Not sure unless a check really ran; a failed check says so; never safe or verified', () => {
  assert.equal(smart.decideGeneral('is it safe to take two of my tablets', {}).label, 'Not sure'); assert.equal(smart.decideGeneral('is it true that the bank closes', { web: 'failed' }).why, 'the check failed');
  assert.equal(smart.decideGeneral('is it safe to eat this', { web: 'ran' }).label, 'Checked'); assert.equal(smart.decideGeneral('I had a lovely day', {}), null);
  setAll(false); process.env.MAYA_SMART_GENERAL = 'on'; const c = session(); const n = c.careNotes('is it safe to take two tablets together'); assert.match(n, /NOT SURE \(nothing was checked\)[^]*never say safe, verified, fine or guaranteed/); setAll(false);
  const off = session().careNotes('is it safe to take two tablets together'); assert.doesNotMatch(off, /NOT SURE/);
});

// ---------------------------------------------------------------- COMPANION
test('COMPANION abilities: the first answer is 2 sentences, 1-2 examples, a question only if useful; calls are offered only when ringing is possible; "more" is a DIFFERENT category, never the same chunk; "all" is still the full list', () => {
  setAll(false); process.env.MAYA_SMART_COMPANION = 'on'; const care = require('../care');
  const c = session(); const id = c.profile.id; c.history.push({ role: 'user', content: 'what can you do' }); let f = c.limitsFacts('what can you do');
  assert.match(f, /AT MOST TWO short sentences with ONE or TWO things/); assert.match(f, /a question only if it truly helps/); assert.match(f, /Do NOT offer to call or ring them/); assert.doesNotMatch(f, /arrange a call/);
  const ev = []; const detach = care.attachSenior(id, { write: () => true }, null); f = c.limitsFacts('what can you do'); assert.match(f, /arrange a call/); assert.doesNotMatch(f, /Do NOT offer to call/);
  assert.equal(c._abilityMode.first, true); assert.equal(c._abilityMode.max, 2);
  c._smart = { topic: 'ability' }; smart.afterReply(c, 'I can chat with you any time and set reminders for you.');
  c.history.push({ role: 'user', content: 'more' }); const m = c.limitsFacts('more'); assert.match(m, /ONE other thing/); assert.match(m, /Do NOT repeat anything you already told them \(talk, remind\)/); assert.doesNotMatch(m, /reminders yourself, from a minute away to days ahead; /);
  assert.equal(c._abilityMode.first, false); c._q = 0; c._cats = null; assert.equal(smart.breaks('I can also set reminders for you.', c), 'dump', 'the same chunk again is rewritten'); c._q = 0; c._cats = null; c._why = null;
  assert.equal(smart.breaks('I can also look at a photo of a letter and tell you if it seems like a scam.', c), null, 'a different category passes');
  c.history.push({ role: 'user', content: 'what can you do, tell me everything' }); assert.match(c.limitsFacts('what can you do, tell me everything'), /THE TRUE LIST|nine/i);
  detach(); setAll(false);
});

test('COMPANION: "scheduled / booked / arranged" is blocked without a record and passes with one', () => {
  setAll(false); process.env.MAYA_SMART_GUARD = 'on'; const s = session(); s._exec = { reminder: false };
  for (const d of ["I've scheduled a call for you at six.", 'Your call is scheduled for tomorrow.', "I've arranged it for you."]) assert.equal(smart.breaks(d, s), 'claim', d);
  assert.equal(smart.breaks('I can help arrange a call if you like.', s), null); s._exec = { reminder: true }; assert.equal(smart.breaks('Your call is scheduled for tomorrow.', s), null); setAll(false);
});

test('COMPANION controls: a brushed-off topic is not raised by her for 30 days but is answered when THEY bring it up; "stop calling me" never expires and ends only when they ask for calls again', () => {
  setAll(false); process.env.MAYA_SMART_COMPANION = 'on'; process.env.MAYA_SMART_MEMORY = 'on'; const care = require('../care');
  const c = session(); const id = c.profile.id; c.careNotes('hi there'); smart.afterReply(c, 'How is your sister doing in Pune these days?');
  let n = c.careNotes('I would rather not talk about that'); assert.match(n, /DROP IT/);
  c.factLabels = []; c._q = 0; assert.equal(smart.breaks('Is your sister coming to Pune soon?', c), 'brushed'); c._why = null;
  c.lastHeard = () => 'my sister called me from Pune today'; c._q = 0; assert.equal(smart.breaks('How was the call with your sister in Pune?', c), null, 'they raised it themselves');
  c.lastHeard = () => 'ok'; c._q = 0; assert.equal(smart.breaks('What do you like to cook on Sundays?', c), null, 'other topics are free');
  const real = Date.now; const ago = 29 * 86400000; care.get(id).smart.brush[0].at = real() - ago; c._q = 0; assert.equal(smart.breaks('Is your sister coming to Pune soon?', c), 'brushed', 'still inside 30 days'); care.get(id).smart.brush[0].at = real() - 31 * 86400000; c._why = null; c._q = 0; assert.equal(smart.breaks('Is your sister coming to Pune soon?', c), null, 'after 30 days it is free again');
  const d = session(); const did = d.profile.id; assert.match(d.careNotes('please stop calling me'), /CALLS STOPPED/); assert.equal(smart.callsOk(d), false);
  care.get(did).smart.noCalls.at = real() - 400 * 86400000; assert.equal(smart.callsOk(d), false, 'no expiry, even a year on');
  assert.match(d.careNotes('can you tell me what you can do'), /do not offer or arrange a call/);
  d.careNotes('can you call me tomorrow'); assert.equal(Boolean(care.get(did).smart.noCalls), true, 'a request to call tomorrow is not a permission: the stop stands (social.reconsent asks one question)');
  assert.match(d.careNotes('you can call me again'), /CALLS RESTORED/); assert.equal(Boolean(care.get(did).smart.noCalls), false); setAll(false);
});
