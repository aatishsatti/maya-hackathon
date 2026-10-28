// Scam shield rules that need no network: the five-signal count, parsing Spark's JSON, and what may reach the family.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scam');

const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));

test('scam levels: two or more signals warn, one is caution, none is nothing (an ordinary letter never warns)', () => {
  assert.deepEqual(S.levelOf(sig()), { count: 0, level: 'none' });
  assert.deepEqual(S.levelOf(sig('urgency')), { count: 1, level: 'caution' });
  assert.deepEqual(S.levelOf(sig('money', 'payment')), { count: 2, level: 'warn' });
  assert.equal(S.levelOf(sig('urgency', 'money', 'impersonation', 'secrecy', 'payment')).level, 'warn');
  assert.deepEqual(S.levelOf(null), { count: 0, level: 'none' }, 'no answer is never a warning');
  assert.deepEqual(S.SIGNALS, ['urgency', 'money', 'impersonation', 'secrecy', 'payment'], 'exactly the five signals asked for');
  assert.equal(S.WARN_AT, 2); assert.equal(S.CAUTION_AT, 1);
});

test('scam parse: JSON in a fence or sentence is read; junk is rejected; only true / "yes" counts as a signal', () => {
  const ok = S.parse('```json\n{"reading":"A letter says you won a prize and must pay a fee.","type":"prize scam","urgency":true,"money":true,"impersonation":false,"secrecy":"no","payment":"yes"}\n```');
  assert.equal(ok.signals.urgency, true); assert.equal(ok.signals.money, true); assert.equal(ok.signals.secrecy, false); assert.equal(ok.signals.payment, true);
  assert.match(ok.reading, /prize/);
  assert.equal(S.parse('Sure! Here you go: {"reading":"x","type":"y","urgency":false}').signals.urgency, false);
  assert.equal(S.parse('not json at all'), null);
  assert.equal(S.parse('{"reading": broken'), null);
  assert.equal(S.parse(''), null);
  const all = S.parse('{"reading":"r","type":"t"}'); assert.ok(S.SIGNALS.every((k) => all.signals[k] === false), 'a missing signal is false, never true');
});

test('scam type label: a few plain words only (letters and spaces), never digits, names or phone numbers', () => {
  assert.equal(S.typeLabel('Payment scam', sig()), 'payment scam');
  assert.equal(S.typeLabel('prize', sig()), 'prize scam');
  assert.equal(S.typeLabel('bank impersonation scam 1-800-555-0100 call Mr Smith', sig()), 'bank impersonation scam', 'cut at four words, digits dropped');
  assert.ok(!/\d/.test(S.typeLabel('Account 12345 phishing', sig())));
  assert.equal(S.typeLabel('ordinary letter', sig('payment')), 'payment scam', 'an empty or "ordinary" label falls back to the signals');
  assert.equal(S.typeLabel('', sig('impersonation')), 'impersonation scam');
  assert.equal(S.typeLabel('', sig()), 'scam');
  assert.ok(S.typeLabel('x '.repeat(50), sig()).length <= 40);
});

test('scam prompt: names the five signals and says an ordinary letter has none; no invented list of scams or phone numbers', () => {
  for (const k of S.SIGNALS) assert.ok(S.ASK.includes(`- ${k}:`), k);
  assert.match(S.ASK, /ordinary letter[^.]*all five false/i);
  assert.match(S.ASK, /not from single words/i);
  assert.ok(!/\d{3}[- ]\d{3,4}/.test(S.ASK), 'no phone numbers');
  assert.equal(S.said(sig('urgency', 'secrecy')).length, 2);
});
