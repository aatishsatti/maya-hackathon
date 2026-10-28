// The scam-shield test set (docs/scam-testset.json): its shape, its balance, its dev / held-out split, and that it holds no real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scam-testset.json'), 'utf8'));
const items = SET.items;
const by = (f) => items.filter(f);

test('set: 56 scams and 56 normal items, every field present, ids unique, texts unique', () => {
  assert.equal(items.length, 112); assert.equal(by((i) => i.label === 'scam').length, 56); assert.equal(by((i) => i.label === 'normal').length, 56);
  assert.equal(new Set(items.map((i) => i.id)).size, 112); assert.equal(new Set(items.map((i) => i.text.toLowerCase())).size, 112);
  for (const i of items) {
    assert.ok(['scam', 'normal'].includes(i.label) && ['text', 'spoken'].includes(i.channel) && ['dev', 'held'].includes(i.split), i.id);
    assert.ok(i.category && i.text.length >= 25 && i.text.length <= 400, i.id);
    assert.ok(i.id.startsWith(i.label === 'scam' ? 'S' : 'N'), `${i.id} id matches label`);
  }
});

test('split: dev and held-out are the same size and both cover every kind of scam and every kind of normal message', () => {
  for (const label of ['scam', 'normal']) for (const split of ['dev', 'held']) assert.equal(by((i) => i.label === label && i.split === split).length, 28, `${label} ${split}`);
  for (const label of ['scam', 'normal']) {
    const kinds = [...new Set(by((i) => i.label === label).map((i) => i.category))];
    assert.ok(kinds.length >= 10, `${label}: ${kinds.length} kinds`);
    for (const k of kinds) for (const split of ['dev', 'held']) assert.ok(by((i) => i.label === label && i.category === k && i.split === split).length >= 2, `${label}/${k} appears in ${split}`);
  }
});

test('mix: both channels, hard cases, scams in progress and genuine payments in progress are all there', () => {
  for (const label of ['scam', 'normal']) for (const ch of ['text', 'spoken']) assert.ok(by((i) => i.label === label && i.channel === ch).length >= 26, `${label}/${ch}`);
  assert.ok(by((i) => i.hard && i.label === 'scam').length >= 10 && by((i) => i.hard && i.label === 'normal').length >= 10, 'hard cases on both sides');
  const now = by((i) => i.now), legit = by((i) => i.legitpay);
  assert.equal(now.length, 6); assert.ok(now.every((i) => i.label === 'scam' && i.channel === 'spoken'));
  assert.equal(legit.length, 6); assert.ok(legit.every((i) => i.label === 'normal' && i.channel === 'spoken'));
  assert.ok(now.some((i) => i.split === 'dev') && now.some((i) => i.split === 'held') && legit.some((i) => i.split === 'dev') && legit.some((i) => i.split === 'held'));
});

test('no real data: no email address, no real-looking phone number, no card or account number, and the file says it was written for this test', () => {
  for (const i of items) {
    assert.doesNotMatch(i.text, /[\w.+-]+@[\w-]+\.[\w.]+/, `${i.id} email`);
    for (const m of i.text.matchAll(/\b\d{3}[-. ]\d{3,4}\b/g)) assert.match(m[0], /^555-01\d\d$/, `${i.id} phone ${m[0]}`);
    assert.doesNotMatch(i.text, /\b\d{9,}\b/, `${i.id} long number`);
  }
  assert.match(SET.about, /written by the Maya team for this test; none comes from a real person or a real message/);
});

test('the readable copy lists every item', () => {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'scam-testset.md'), 'utf8');
  for (const i of items) assert.ok(md.includes(`| ${i.id} |`), i.id);
});
