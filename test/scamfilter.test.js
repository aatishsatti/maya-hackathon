// The cheap scam word filter: which talk is worth a Spark check (needsCheck) and which turns are "happening right now" (payNow, checkPlan).
// Designed and tested on the DEV half of docs/scam-testset.json and the ordinary-chat lines only; the held-out half is measured once, by hand, at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../scam');

const ROOT = path.join(__dirname, '..');
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scam-testset.json'), 'utf8')).items;
const chat = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'ordinary-chat-lines.json'), 'utf8')).lines;
const dev = items.filter((i) => i.split === 'dev');

test('filter: every dev scam is worth a check (a miss would mean a scam goes unchecked)', () => {
  const scams = dev.filter((i) => i.label === 'scam'); assert.equal(scams.length, 38);
  assert.deepEqual(scams.filter((i) => !S.needsCheck(i.text)).map((i) => i.id), []);
});

test('filter: everyday talk almost never costs a check (at most 2 of 30 lines), and "I\'m fine" never does', () => {
  assert.equal(chat.length, 30);
  assert.ok(chat.filter(S.needsCheck).length <= 2, chat.filter(S.needsCheck).join(' | '));
  for (const t of ["I'm fine, thank you, just having my tea.", 'Fine, thanks, and you?', 'That is fine by me, dear.', 'I found nothing, ha.']) assert.equal(S.needsCheck(t), false, t);
  assert.equal(S.needsCheck(''), false); assert.equal(S.needsCheck(null), false); assert.equal(S.needsCheck('ok'), false, 'too short to be worth a check');
});

test('filter: single classic tells are enough on their own; one ordinary word group is not', () => {
  for (const t of ['He told me to buy gift cards for the bail money.', 'She wants me to read out the code that came in the text.', 'A man said I must not tell my son about it.', 'It said my computer has a virus and to ring a number.', 'There is a rebate waiting for me apparently.']) assert.equal(S.needsCheck(t), true, t);
  for (const t of ['I went to the bank this morning for some stamps.', 'My phone rang but it was my sister.', 'I paid the milkman on Friday.', 'The council changed the bin day for Christmas.']) assert.equal(S.needsCheck(t), false, t);
});

test('payNow: the person is on the way to, or in the middle of, paying / giving / installing; a calm telling of a past event is not', () => {
  const now = dev.filter((i) => i.now); assert.equal(now.length, 5);
  assert.deepEqual(now.filter((i) => !S.checkPlan(i.text).await).map((i) => i.id), [], 'every dev scam in progress is awaited');
  for (const t of ['I am on my way to the shop now to get them.', 'I am at the cash machine now.', 'He is still on the phone with me.', 'I have got the code in front of me.', 'I am about to press enter.', 'He wants me to click run.', 'I am putting the card in.']) assert.equal(S.payNow(t), true, t);
  for (const t of ['A man rang yesterday and said I owed tax.', 'I had a letter about a prize last week.', 'My bank sent a statement.']) assert.equal(S.payNow(t), false, t);
});

test('checkPlan: no check for ordinary talk; a check beside the reply for most scammy talk; awaited only when it is happening right now AND worth a check', () => {
  assert.deepEqual(S.checkPlan('I made some soup today and it smelled lovely.'), { check: false, await: false });
  assert.deepEqual(S.checkPlan('I am on my way to the shop now.'), { check: false, await: false }, 'on the way somewhere is not a scam by itself: never awaited');
  const other = dev.filter((i) => i.label === 'scam' && !i.now); assert.equal(other.filter((i) => S.checkPlan(i.text).await).length, 0, 'a scam that already happened is checked beside the reply, not awaited');
  assert.deepEqual(S.checkPlan('He wants gift cards and I am going to the shop now to get them.'), { check: true, await: true });
  assert.equal(chat.filter((l) => S.checkPlan(l).await).length, 0, 'no everyday line is ever awaited');
});

test('the filter is pure: no network, no file, no state', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scam.js'), 'utf8');
  const part = src.slice(src.indexOf('// ---- Cheap word filter'), src.indexOf('// The reply is JSON')).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(part, /fetch\(|require\(|process\.env|writeFile|readFile|Date\.now/);
});
