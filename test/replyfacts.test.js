// Which KINDS of fact Spark gets for each reply, by name only: the 'reply facts' log line and the labels behind it. No words, no facts, ever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-facts-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, sparkComplete: async () => '{}', sparkStream: async () => '', streamSpeech: async () => {}, describeImage: async () => 'unused' } };
const memory = require('../memory');
const { Call } = require('../call');
const { ChatSession } = require('../chat');

let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const bareCall = () => { const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); clearInterval(c.endTimer); c.profile = memory.load(memory.createProfile(`Fct${letters(n++)}`, 'female').id); c.gen = 1; c.abort = new AbortController(); return c; };
const dropTimers = (c) => { for (const t of c.timers) clearTimeout(t.handle); c.timers = []; };

test('the labels name what the turn gave Spark: a timer request, a repeat of it, the next turn while it runs, and nothing when there is nothing', () => {
  const c = bareCall();
  c.careNotes('Remind me in 30 seconds to take my medicine.'); assert.deepEqual(c.factLabels, ['timer-set']);
  c.careNotes('Remind me in 30 seconds that I have to take it.'); assert.deepEqual(c.factLabels, ['timer-already-set']);
  c.careNotes('Can I hang up now?'); assert.deepEqual(c.factLabels, ['timer-open']);
  dropTimers(c); c.careNotes('Tell me a story.'); assert.deepEqual(c.factLabels, [], 'no facts, no labels');
  c.careNotes('Remind me in 5 hours to rest.'); assert.deepEqual(c.factLabels, ['timer-too-long']);
});

test('family labels: a reminder to call someone is NOT family-ask (the Call 3 failure, now visible); a real request is; a refusal is family-declined', () => {
  const a = bareCall(); a.careNotes('Can you remind me in 30 seconds that I have to call my sister.'); assert.deepEqual(a.factLabels, ['timer-set']); dropTimers(a);
  const b = bareCall(); b.careNotes('Tell my family I am not feeling well.'); assert.deepEqual(b.factLabels, ['family-ask']);
  const c = bareCall(); c.careNotes('Please do not tell my family.'); assert.deepEqual(c.factLabels, [], 'the refusal itself gives no fact on that turn'); assert.equal(c.familyDeclined, true);
  c.careNotes('How are you today?'); assert.deepEqual(c.factLabels, ['family-declined']);
});

test('the written chat (which borrows careNotes) gets labels too, and they are names, not text', () => {
  const s = new ChatSession(memory.load(memory.createProfile(`Chat${letters(n++)}`, 'female').id), null);
  s.careNotes('Remind me in 5 minutes to call my sister.'); assert.deepEqual(s.factLabels, ['timer-unavailable-in-chat']);
  for (const l of s.factLabels) assert.match(l, /^[a-z-]+$/);
});

test('every label in call.js is a plain name (letters and hyphens), so the log line can never carry a word the person said', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8');
  const labels = [...src.matchAll(/\bnote\('([^']+)',/g)].map((m) => m[1]);
  assert.ok(labels.length >= 23, `all the fact kinds are labelled (${labels.length})`); for (const l of labels) assert.match(l, /^[a-z]+(?:-[a-z]+)*$/, l);
  assert.equal(new Set(labels).size, labels.length, 'one label per kind of fact');
  assert.match(src, /console\.log\('reply facts', JSON\.stringify\(\{ source:/, 'the log line is there, and carries only source, labels and a count');
});
