// Speculation reuse (interim, COMPANION-only): a guess is spoken ONLY for a routine turn whose single fact is the companion style note, and only after the final turn proves it saw the same thing.
// Real Call state machine, stub Spark that records every request. Every mismatch must take the normal path (a fresh request written for the final turn); with CARDS on (smart-app-state) it never reuses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-specreuse-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_SMART_COMPANION = 'on';
const TAG = '[[feel: emotion=neutral intensity=1 intent=chat concern=none pain=0 topic=same personal=0]]';
let reqs = [], replyText = `${TAG} Sounds nice.`, failAfter = 0;
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}',
  sparkStream: (history, roster, signal, onDelta) => new Promise((res, rej) => {
    const r = { roster, last: history[history.length - 1].content, aborted: false, done: false }; reqs.push(r);
    const tm = setTimeout(() => { if (failAfter) { r.failed = true; rej(new Error('Meta Spark failed (HTTP 500)')); return; } r.done = true; onDelta(replyText); res(replyText); }, failAfter || 40);
    signal.addEventListener('abort', () => { r.aborted = true; clearTimeout(tm); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  }), stats: [], META_URL: '', liveModel: () => 'x', COMPACT_MARK: '[[COMPACT]]', developerContent: () => '', SHORT_PERSONA: '' } };
const memory = require('../memory'); const care = require('../care'); const { Call } = require('../call');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const made = [];
function mk() {
  const p = memory.createProfile(`Spec${letters(n++)}`, 'female'); care.get(p.id).tz = 'America/New_York';
  const c = new Call({ send() {}, close() {}, onmessage: null, onclose: null }, 'k'); c.profile = memory.load(p.id); c.callId = `c${n}`; c.registered = true; c.noVoice = true; c.gen = 1; c.abort = new AbortController();
  c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true; made.push(c); return c;
}
const facts = []; const origLog = console.log;
console.log = (...a) => { if (a[0] === 'reply facts') { try { facts.push(JSON.parse(a[1])); } catch { /* ignore */ } } else origLog(...a); };
test.after(() => { console.log = origLog; for (const c of made) { try { c.end(); } catch { /* over */ } } care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
// speech: partials, then (after the guess had time to start) speaker + speechEnd + speechComplete with the final words.
async function turn(c, { partial = 'how is the weather today', final = 'How is the weather today?', label = 'A', wait = 450, between } = {}) {
  reqs = []; facts.length = 0; const id = `t${Math.random()}`;
  c.onMeta({ type: 'speechStart', turnId: id }); c.onMeta({ type: 'transcript', turnId: id, transcript: partial.split(' ').slice(0, 3).join(' ') }); c.onMeta({ type: 'transcript', turnId: id, transcript: partial });
  await sleep(wait);   // SPEC_QUIET_MS = 250: the guess is in flight now
  const guesses = reqs.length;
  if (between) await between(c);
  c.onMeta({ type: 'speaker', turnId: id, label }); c.onMeta({ type: 'speechEnd', turnId: id }); c.onMeta({ type: 'speechComplete', turnId: id, transcript: final });
  await sleep(300);
  return { guesses, source: facts.length ? facts[facts.length - 1].source : null, labels: facts.length ? facts[facts.length - 1].labels : null, total: reqs.filter((r) => !/Write your short line now/.test(r.last)).length, aborted: reqs.filter((r) => r.aborted).length };
}

test('1 COMPANION only, routine turn, same words + label: the guess is reused (one fewer request, the other candidate cancelled)', async () => {
  const c = mk(); const r = await turn(c);
  assert.equal(r.guesses, 2, 'a guess for the heard label and one for the next label'); assert.equal(r.source, 'guess-hit'); assert.deepEqual(r.labels, ['smart-style']);
  assert.equal(r.total, 2, 'no new request: the matching guess is the reply'); assert.equal(r.aborted, 1, 'the other candidate is cancelled');
  assert.match(reqs[0].roster, /friend, not a tool/, 'the guess carried the SAME style note the final turn has');
  assert.ok(c.history.some((m) => m.role === 'assistant'), 'the reply was recorded once');
});

test('2 CARDS on: smart-app-state is a second fact, so the guess is NEVER reused (normal path, a fresh request)', async () => {
  process.env.MAYA_SMART_STATE_CARDS = 'on';
  try { const c = mk(); const r = await turn(c); assert.equal(r.source, 'written-now'); assert.ok(r.labels.includes('smart-app-state')); assert.equal(r.total, 3, '2 guesses + the normal request'); assert.equal(r.aborted, 2); }
  finally { delete process.env.MAYA_SMART_STATE_CARDS; }
});

test('3 mismatches take the normal path: extra final words, a different label, a corrected word, an interruption', async () => {
  let r = await turn(mk(), { final: 'How is the weather today in Ohio?' }); assert.equal(r.source, 'written-now', 'extra words'); assert.equal(r.aborted, 2);
  r = await turn(mk(), { label: 'B' }); assert.equal(r.source, 'written-now', 'a different speaker label');
  r = await turn(mk(), { final: 'How was the weather today?' }); assert.equal(r.source, 'written-now', 'a corrected word');
  const c = mk(); r = await turn(c, { between: async (cc) => { cc.onMeta({ type: 'speechStart', turnId: 'again' }); } }); assert.notEqual(r.source, 'guess-hit', 'speaking again drops the guess');
  assert.ok(r.aborted >= 2, 'both guesses cancelled by the interruption');
});

test('4 stale guess, changed history, changed turn: never reused', async () => {
  const c = mk(); let r = await turn(c, { between: async (cc) => { cc.spec.startedAt -= 60000; } }); assert.equal(r.source, 'written-now', 'a stale guess');
  const c2 = mk(); r = await turn(c2, { between: async (cc) => { cc.history.push({ role: 'assistant', content: 'Something else was said.' }); } }); assert.equal(r.source, 'written-now', 'history changed since the guess');
  const c3 = mk(); r = await turn(c3, { between: async (cc) => { cc.turnSeq = (cc.turnSeq || 0) + 1; } }); assert.equal(r.source, 'written-now', 'another turn was answered meanwhile');
});

test('5 other facts always reject reuse: scheduling offer pending, a pain mention, a family-consent question, safety words, a call/phone word', async () => {
  for (const [partial, final] of [['can you call me every morning', 'Can you call me every morning?'], ['my knee hurts a little today', 'My knee hurts a little today.'], ['could you ring my daughter now', 'Could you ring my daughter now?']]) {
    const r = await turn(mk(), { partial, final }); assert.notEqual(r.source, 'guess-hit', partial); if (r.labels) assert.ok(!(r.labels.length === 1 && r.labels[0] === 'smart-style' && r.source === 'guess-hit'), partial);
  }
  const c = mk(); c.pendingConcern = { left: 2 }; let r = await turn(c); assert.equal(r.source, 'written-now', 'a pending family-consent question'); assert.ok(r.labels.some((l) => /^concern-/.test(l)));
  const s = mk(); s.safety = true; r = await turn(s); assert.equal(r.source, 'written-now', 'safety in play');
  const h = mk(); h.health = true; r = await turn(h); assert.equal(r.source, 'written-now', 'health in play');
  const social = require('../social'); const d = mk(); social.step({ profile: d.profile, channel: 'call', factLabels: [], _exec: {}, lastHeard: () => '' }, 'could you call me every morning at six', { intent: 'smalltalk', callsOk: true, safe: true }, Date.now());
  r = await turn(d, { partial: 'yes please do that', final: 'Yes, please do that.' }); assert.notEqual(r.source, 'guess-hit', 'a pending scheduling proposal stays on the existing path');
});

test('6 late danger: a routine partial whose final words turn out to be a fall is NOT answered by the guess, and the alert is made exactly once', async () => {
  const alerts = []; const orig = care.concernAlert; care.concernAlert = (...a) => { alerts.push(a); return orig.apply(care, a); };
  try {
    const c = mk(); replyText = `${TAG} Sounds nice.`;
    const r = await turn(c, { partial: 'I was just in the kitchen', final: 'I was just in the kitchen and I fell and hit my head.' });
    assert.equal(r.source, 'written-now'); assert.ok(r.aborted >= 2); assert.equal(alerts.length, 0, 'no alert from a guess');
  } finally { care.concernAlert = orig; replyText = `${TAG} Sounds nice.`; }
});

test('7 a reused reply carrying an urgent tag is processed once, like any reply (no duplicate alert)', async () => {
  const alerts = []; const orig = care.concernAlert; care.concernAlert = (...a) => { alerts.push(a); return orig.apply(care, a); };
  try { const c = mk(); replyText = '[[feel: emotion=anxious intensity=3 intent=share concern=urgent pain=1 topic=same personal=0]] I am here, are you hurt?'; const r = await turn(c); assert.equal(r.source, 'guess-hit'); assert.ok(alerts.length <= 1, `alerts: ${alerts.length}`); }
  finally { care.concernAlert = orig; replyText = `${TAG} Sounds nice.`; }
});

// ---- gap tests (before any push) ----
const sent = (c) => { const out = []; c.ws.send = (m) => { try { out.push(typeof m === 'string' ? JSON.parse(m) : m); } catch { out.push({ raw: String(m) }); } }; return out; };
const assistantCount = (c) => c.history.filter((m) => m.role === 'assistant').length;

test('8 meaning-changing wording: a normalized word change (not just punctuation or case) rejects reuse', async () => {
  const cases = [
    ['I do not like the soup', 'I do like the soup.'], ["I can't sleep at night", 'I can sleep at night.'], ["I don't feel well", 'I dont feel well.'],
    ['I take two pills in the morning', 'I take three pills in the morning.'], ['I am not hurt at all', 'I am hurt at all.'], ['my daughter is coming at five', 'My daughter is coming at six.'],
  ];
  for (const [partial, final] of cases) { const r = await turn(mk(), { partial, final }); assert.equal(r.source, 'written-now', `${partial} -> ${final}`); assert.equal(r.aborted, r.guesses, `${partial}: every guess that was made is cancelled`); }
  // control: only punctuation / case differ -> that IS the same words (normalization is letters and digits only)
  const ok = await turn(mk(), { partial: 'i do not like the soup', final: 'I do not like the soup.' }); assert.equal(ok.source, 'guess-hit', 'punctuation and case only');
});

test('9 interruption AFTER acceptance: the reused reply is cut, no stale speech, no duplicate reply, no alert; the next turn answers once', async () => {
  const alerts = []; const orig = care.concernAlert; care.concernAlert = (...a) => { alerts.push(a); return orig.apply(care, a); };
  const slow = replyText;
  try {
    const c = mk(); const out = sent(c);
    reqs = []; facts.length = 0; const id = 'ia';
    // a slower reply: the first piece arrives, then the rest after 600 ms (so the reply is still being spoken when they interrupt)
    replyText = `${TAG} Sounds nice, tell me more about it. And what else did you do today?`;
    c.onMeta({ type: 'speechStart', turnId: id }); c.onMeta({ type: 'transcript', turnId: id, transcript: 'how is the weather today' });
    await sleep(450); c.onMeta({ type: 'speaker', turnId: id, label: 'A' }); c.onMeta({ type: 'speechEnd', turnId: id }); c.onMeta({ type: 'speechComplete', turnId: id, transcript: 'How is the weather today?' });
    await sleep(5);
    assert.equal(facts[facts.length - 1] && facts[facts.length - 1].source, 'guess-hit', 'accepted');
    c.interrupt();   // they talk over her right after acceptance
    const before = assistantCount(c); const mark = out.length;
    await sleep(500);
    assert.ok(assistantCount(c) <= before + 0 || assistantCount(c) <= 1, 'at most the one reply');
    assert.ok(out.slice(mark).every((m) => m.type !== 'speak' && m.type !== 'audio' && m.type !== 'reply'), `no speech after the interruption: ${JSON.stringify(out.slice(mark).map((m) => m.type))}`);
    // the next turn is answered normally, once
    replyText = `${TAG} Glad to hear it.`;
    const r = await turn(c, { partial: 'the garden looks lovely today', final: 'The garden looks lovely today.' });
    assert.ok(['guess-hit', 'written-now'].includes(r.source)); assert.equal(alerts.length, 0);
    assert.equal(c.history.filter((m) => m.role === 'assistant' && /Glad to hear it/.test(m.content)).length, 1, 'the next reply exactly once');
  } finally { care.concernAlert = orig; replyText = slow; }
});

test('10 a guess that ALREADY errored (or came back empty) is never reused: normal path, one fresh request, one reply', async () => {
  const c = mk(); reqs = []; facts.length = 0; const id = 'er';
  c.onMeta({ type: 'speechStart', turnId: id }); c.onMeta({ type: 'transcript', turnId: id, transcript: 'how is the weather today' });
  await sleep(450);
  assert.ok(c.spec && c.spec.byLabel.size >= 1, 'guesses in flight');
  for (const g of c.spec.byLabel.values()) g.rs.fail(new Error('Meta Spark failed (HTTP 503)'));   // both guesses die before the turn is accepted
  c.onMeta({ type: 'speaker', turnId: id, label: 'A' }); c.onMeta({ type: 'speechEnd', turnId: id }); c.onMeta({ type: 'speechComplete', turnId: id, transcript: 'How is the weather today?' });
  await sleep(300);
  const f = facts[facts.length - 1];
  assert.equal(f.source, 'written-now', 'an errored guess takes the normal path'); assert.equal(c.closed, false, 'the call did not end on a guess that failed earlier');
  assert.equal(c.history.filter((m) => m.role === 'assistant').length, 1, 'one reply');
  // an empty finished guess is the same
  const c2 = mk(); facts.length = 0; const id2 = 'em';
  c2.onMeta({ type: 'speechStart', turnId: id2 }); c2.onMeta({ type: 'transcript', turnId: id2, transcript: 'how is the weather today' }); await sleep(450);
  for (const g of c2.spec.byLabel.values()) { g.abort.abort(); g.rs.done = true; g.rs.text = ''; }
  c2.onMeta({ type: 'speaker', turnId: id2, label: 'A' }); c2.onMeta({ type: 'speechEnd', turnId: id2 }); c2.onMeta({ type: 'speechComplete', turnId: id2, transcript: 'How is the weather today?' }); await sleep(300);
  assert.equal(facts[facts.length - 1].source, 'written-now'); assert.equal(c2.history.filter((m) => m.role === 'assistant').length, 1);
});

test('11 a reused stream that errors AFTER acceptance: the call ends with the error once (as any reply does), no reply, no second request, no alert', async () => {
  const alerts = []; const orig = care.concernAlert; care.concernAlert = (...a) => { alerts.push(a); return orig.apply(care, a); };
  try {
    const c = mk(); const out = sent(c); reqs = []; facts.length = 0; const id = 'ea'; failAfter = 300;   // guesses start ~250 ms in and fail ~300 ms later: after the turn is accepted (~450 ms)
    c.onMeta({ type: 'speechStart', turnId: id }); c.onMeta({ type: 'transcript', turnId: id, transcript: 'how is the weather today' }); await sleep(450);
    c.onMeta({ type: 'speaker', turnId: id, label: 'A' }); c.onMeta({ type: 'speechEnd', turnId: id }); c.onMeta({ type: 'speechComplete', turnId: id, transcript: 'How is the weather today?' });
    await sleep(5); assert.equal(facts[facts.length - 1].source, 'guess-hit'); const mine = () => reqs.filter((r) => r.roster.includes(c.profile.name)).length, n0 = mine();   // only THIS call's requests (earlier tests' calls are still alive)
    await sleep(500);
    assert.equal(out.filter((m) => m.type === 'error').length, 1, 'the error is reported once'); assert.equal(c.closed, true);
    assert.equal(assistantCount(c), 0, 'no reply, no fake reply'); assert.equal(mine(), n0, 'no duplicate request'); assert.equal(alerts.length, 0);
  } finally { failAfter = 0; care.concernAlert = orig; }
});
