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
const LAYERS = ['ROUTER', 'ABILITIES', 'DECISION', 'CARDS', 'GUARD', 'KINDS'];
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
  s.lastHeard = () => 'my number is 98765 43210 and the site is www.mybank.com'; assert.equal(smart.breaks('Is www.mybank.com the one they gave you?', s), null, 'a link they gave is not invented'); assert.equal(smart.breaks('So 98765 43210 called you?', s), null);
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
