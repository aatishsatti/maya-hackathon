// Instant first voice + prediction rules (pure parts). The live behaviour is checked against real Meta and ElevenLabs separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../lead');
const { ChunkSplitter } = require('../reply');

test('routine: ordinary talk is routine; pain, health, worry, safety, family alerts, money, reminders are not', () => {
  for (const t of ['I had toast and tea for breakfast.', 'The roses are blooming in the garden.', 'My granddaughter called me yesterday.', 'What should I cook for dinner tonight?']) assert.equal(L.isRoutine(t), true, t);
  for (const t of ['My head hurts a lot.', 'I fell in the kitchen.', 'I feel dizzy.', 'I am so lonely today.', 'I think I want to die.', 'I am worried about my pills.',
    'Please tell my family I called.', 'Can you remind me at five?', 'I got a call about my bank account.', 'I have chest pain.', "I can't breathe properly.", 'Help me.']) assert.equal(L.isRoutine(t), false, t);
  assert.equal(L.isRoutine('Okay'), false, 'one word is not enough to be sure of');
  assert.equal(L.isRoutine('word '.repeat(60)), false, 'a long ramble is not guessed at');
});

test('lead-in: only acknowledgements, none promises an answer, none states a fact, and they never repeat within two', () => {
  for (const l of L.ALL) {
    assert.ok(l.split(/\s+/).length <= 8, l);
    assert.ok(!/\b(answer|tell you|know|remember|call|family|sorry|great|wonderful|glad|happy|sure|certainly|definitely)\b/i.test(l), `no promise or claim in "${l}"`);
  }
  assert.ok(L.LEAD.question.every((l) => /think/i.test(l)), 'questions get an honest "thinking" line');
  const seen = [];
  for (let i = 0; i < 30; i++) { const l = L.chooseLead('I had toast for breakfast.', seen.slice(-2), Math.random); assert.ok(l, 'a line is always available when only the last two are excluded'); assert.ok(!seen.slice(-2).includes(l)); seen.push(l); }
  assert.equal(L.chooseLead('I had toast.', L.LEAD.statement), null, 'nothing left in the pool: say nothing extra');
  assert.ok(L.LEAD.statement.length >= 4 && L.LEAD.question.length >= 2);
  assert.ok(L.LEAD.question.includes(L.chooseLead('How are you today?', [], () => 0)));
  assert.ok(L.LEAD.question.includes(L.chooseLead('Hello Maya, what is the date', [], () => 0)), 'a question without a question mark still counts');
  assert.ok(L.LEAD.statement.includes(L.chooseLead('The sun is out.', [], () => 0)));
});

test('lead-in length: the longest line that still ends before the reply is expected; never longer; shortest if none fits', () => {
  const dur = { "Mm-hm, I'm listening.": 1500, 'I see, thanks for telling me.': 2150, 'Okay, I hear you.': 1650, "Right, I'm following.": 1550, "Mm-hm, I'm listening. Just a moment.": 2600 };
  const pick = (budgetMs, recent = []) => { const seen = new Set(); for (let i = 0; i < 60; i++) seen.add(L.chooseLead('The sun is out.', recent, Math.random, { budgetMs, durOf: (l) => dur[l] })); return [...seen]; };
  for (const budget of [1400, 1600, 1900, 2200, 2700, 5000]) for (const l of pick(budget)) assert.ok(dur[l] <= Math.max(budget, 1500), `${l} (${dur[l]} ms) must fit ${budget}`);
  assert.deepEqual(pick(1400), ["Mm-hm, I'm listening."], 'nothing fits: only the shortest line');
  assert.ok(pick(2200).every((l) => dur[l] >= 1750), 'a roomy budget uses the longer lines, not the shortest');
  assert.ok(pick(5000).includes("Mm-hm, I'm listening. Just a moment.") && pick(5000).length <= 2, 'a slow reply uses the longest');
  assert.equal(L.chooseLead('The sun is out.', [], Math.random, { budgetMs: 2000, durOf: () => NaN }) !== null, true, 'unknown lengths fall back to any line');
});

test('lead-in is never said twice: Spark opening with the same words has them removed', () => {
  assert.equal(L.withoutLead('Mm-hm. That sounds lovely.'), 'That sounds lovely.');
  assert.equal(L.withoutLead('I see, a garden full of roses.'), 'A garden full of roses.');
  assert.equal(L.withoutLead('Okay, let us have a look.'), 'Let us have a look.');
  for (const l of L.ALL) assert.equal(L.withoutLead(`${l} The garden sounds lovely.`), 'The garden sounds lovely.', `strips "${l}"`);
  assert.equal(L.withoutLead('Hmm, let me think. Maybe soup.'), 'Maybe soup.');
  assert.equal(L.withoutLead('Right, that is a fair point.'), 'That is a fair point.');
  assert.equal(L.withoutLead('Right, that is a fair point.'), 'That is a fair point.');
  assert.equal(L.withoutLead('Roses are lovely in June.'), 'Roses are lovely in June.', 'a normal opening is untouched');
  assert.equal(L.withoutLead('Right.'), 'Right.', 'never strips a reply down to nothing');
  assert.equal(L.startsWithLead('Mm-hm, yes.'), true);
  assert.equal(L.startsWithLead('That is nice.'), false);
});

test('splitter: with a lead-in spoken, the first piece of the reply drops a repeated acknowledgement and any opening interjection', () => {
  const pieces = [];
  const sp = new ChunkSplitter({ onName() {}, onFeel: () => ({ emotion: 'neutral', intensity: 1, maxSentences: 2, maxExclaim: 1, moments: 0, excitedOpening: false, whisperPieces: 0 }), onPiece: (t) => pieces.push(t), stripLead: true, stripInterjection: true });
  sp.feed("[[feel: emotion=neutral intensity=1 intent=chat]] I see, toast and tea is a good start. Did you sleep well? ");
  sp.end();
  assert.ok(pieces.length && !/^i see/i.test(pieces[0]), pieces[0]);
  assert.match(pieces[0], /^Toast and tea/);
});

test('prediction: only routine, exact matches count; anything extra, a question or a sensitive word drops it', () => {
  for (const t of ["I'm fine, thank you.", 'Fine.', "I'm doing well.", 'Good, thanks', 'Not bad']) assert.equal(L.prethinkClass(t), 'fine', t);
  for (const t of ['Hello Maya.', 'Hi', 'Good morning, Maya!']) assert.equal(L.prethinkClass(t), 'hello', t);
  for (const t of ["I'm fine, how are you?", "I'm fine but my knee hurts", 'Fine, I was thinking about the garden', 'Hello Maya, how are you today?', "I'm not fine", 'No', 'Yes please', 'I fell down', '']) assert.equal(L.prethinkClass(t), null, `"${t}"`);
  assert.ok(Object.values(L.PRETHINK).every((c) => c.re.test(c.sample)), 'each sample belongs to its own class');
});

test('wiring: lead-in never plays for safety, health, a pending worry or care notes; the browser keeps it playing; the orb flows while thinking', () => {
  const call = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8');
  const pick = call.slice(call.indexOf('  pickLead('), call.indexOf('  // Sends the clip now.'));
  for (const guard of ['!leadClips.size', 'extra', 'this.safety', 'this.health', 'this.pendingConcern', 'lead.isRoutine(heard)', 'spec.rs.text.length']) assert.ok(pick.includes(guard), guard);
  assert.ok(call.includes("lead.isRoutine(t.partial)"), 'early guesses are for routine talk only');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(!ev\.cont\) \{\s*stopPlayback\(\)/, 'a continuing speak must not cut the lead-in off');
  assert.match(app, /if \(ev\.lead\) \{ setState\('thinking'\)/);
  assert.match(app, /orb\.dataset\.state === 'speaking' \|\| c\.leadActive\) feedChunk/, 'audio is not dropped while a lead-in plays in the thinking state');
  assert.match(app, /c\.leadActive = Boolean\(ev\.lead\)/);
  const { MayaOrbMath: M } = require('../public/orb.js');
  assert.ok(M.THINKING_ENERGY >= 0.3 && M.THINKING_ENERGY < 0.7, 'visibly moving, calmer than speech');
  assert.ok(M.flowRate(M.THINKING_ENERGY) > 2 * M.flowRate(0), 'thinking flows clearly faster than silence');
});
